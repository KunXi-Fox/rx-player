#!/usr/bin/env node
/**
 * # run_bundler.mjs
 *
 * This file allows to create JavaScript bundles for the RxPlayer through our
 * bundlers with the right configuration.
 *
 * You can either run it directly as a script (run `node run_bundler.mjs -h`
 * to see the different options) or by requiring it as a node module.
 * If doing the latter you will obtain a function you will have to run with the
 * right options.
 */

import * as fs from "fs";
import * as path from "path";
import { pathToFileURL } from "url";
import esbuild from "esbuild";
import swc from "@swc/core";
import getHumanReadableHours from "./utils/get_human_readable_hours.mjs";
import PROJECT_ROOT_DIRECTORY from "./utils/project_root_directory.mjs";

// If true, this script is called directly
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args.includes("-h") || args.includes("--help")) {
    displayHelp();
    process.exit(0);
  }

  const inputFile = args[0];
  if (inputFile === undefined) {
    console.error("ERROR: no input file provided\n");
    displayHelp();
    process.exit(1);
  }

  const normalizedPath = path.normalize(inputFile);
  if (!fs.existsSync(normalizedPath)) {
    console.error(`ERROR: input file not found: ${normalizedPath}\n`);
    displayHelp();
    process.exit(1);
  }

  const shouldWatch = args.includes("-w") || args.includes("--watch");
  const shouldMinify = args.includes("-m") || args.includes("--minify");
  const production = args.includes("-p") || args.includes("--production-mode");
  const globalScope = args.includes("-g") || args.includes("--globals");
  const silent = args.includes("-s") || args.includes("--silent");

  let outfile;
  {
    let outputIndex = args.indexOf("-o");
    if (outputIndex < 0) {
      outputIndex = args.indexOf("--output");
    }
    if (outputIndex >= 0) {
      const wantedOutputFile = args[outputIndex + 1];
      if (wantedOutputFile === undefined) {
        console.error("ERROR: no output file provided\n");
        displayHelp();
        process.exit(1);
      }
      outfile = path.normalize(wantedOutputFile);
    }
  }

  let es5Outfile;
  {
    let outputIndex = args.indexOf("-5");
    if (outputIndex < 0) {
      outputIndex = args.indexOf("--es5");
    }
    if (outputIndex >= 0) {
      const wantedEs5OutputFile = args[outputIndex + 1];
      if (wantedEs5OutputFile === undefined) {
        console.error("ERROR: no output file provided for -5/--es5 option\n");
        displayHelp();
        process.exit(1);
      }
      es5Outfile = path.normalize(wantedEs5OutputFile);
    }
  }

    runBundler(normalizedPath, {
      watch: shouldWatch,
      minify: shouldMinify,
      production,
      globalScope,
      silent,
      outfile,
      es5Outfile,
    }).catch((err) => {
      console.error(`ERROR: ${err}\n`);
      process.exit(1);
    });
}
/**
 * Run bundler with the given options.
 * @param {string} inputFile
 * @param {Object} options
 * @param {boolean} [options.name] - The "name" associated to your bundle, will
 * be used in logs if `options.silent` is set to `false`.
 * @param {boolean} [options.minify] - If `true`, the output will be minified.
 * @param {boolean} [options.globalScope] - If `true`, enable global scope mode
 * (the `__GLOBAL_SCOPE__` global symbol will be set to `true` in the bundle).
 * @param {boolean} [options.production] - If `false`, the code will be compiled
 * in "development" mode, which has supplementary assertions.
 * @param {boolean} [options.watch] - If `true`, the RxPlayer's files involve
 * will be watched and the code re-built each time one of them changes.
 * @param {boolean} [options.silent] - If `true`, we won't output logs.
 * @param {string} [options.es5Outfile] - If set, an ES5 bundle will also be
 * produced at that path.
 * @param {string} [options.outfile] - Destination of the produced es2017
 * bundle. To ignore to skip ES2017 bundle generation.
 * @param {Object} [options.globals] - Optional globally-defined identifiers, as
 * a key-value objects, where the object is a string (trick: if you want to
 * replace an identifier with a string, call `JSON.stringify` on it).
 * @returns {Promise}
 */
export default async function runBundler(inputFile, options) {
  const name = options.name;
  const minify = !!options.minify;
  const watch = !!options.watch;
  const isDevMode = !options.production;
  const isSilent = options.silent;
  const outfile = options.outfile;
  const es5Outfile = options.es5Outfile;
  const globals = options.globals;
  const relativeInFile = path.relative(PROJECT_ROOT_DIRECTORY, inputFile);
  const relativeOutfile =
    outfile === undefined
      ? undefined
      : path.relative(PROJECT_ROOT_DIRECTORY, options.outfile);
  const globalScope = !!options.globalScope;

  if (outfile === undefined && es5Outfile === undefined) {
    throw new Error("Neither an output file nor an es5 output file has been provided");
  }

  const esbuildStepsPlugin = {
    name: "bundler-steps",
    setup(build) {
      build.onStart(() => {
        if (name != null) {
          logWarning(`Bundling for "${name}" started. (${relativeInFile}).`);
        } else {
          logWarning(`Bundling of "${relativeInFile}" started.`);
        }
      });
      build.onEnd((result) => {
        if (watch && outfile !== undefined && es5Outfile !== undefined) {
          const contents = fs.readFileSync(outfile);
          const inputSourceMap = new TextDecoder().decode(fs.readFileSync(outfile+'.map'));

          buildAndAnnounceEs5Bundle(contents, inputSourceMap, es5Outfile);
        }
        if (result.errors.length > 0 || result.warnings.length > 0) {
          const { errors, warnings } = result;
          logWarning(
            `Re-bundling for "${name ?? inputFile}" failed with ${errors.length} error(s) and ` +
              ` ${warnings.length} warning(s) `,
          );
          return;
        }
        if (relativeOutfile !== undefined) {
          if (name != null) {
            logSuccess(`Bundling for "${name}" succeeded. (${relativeOutfile}).`);
          } else {
            logSuccess(`Bundling of "${relativeOutfile}" succeeded.`);
          }
        }
      });
    },
  };

  const meth = watch ? "context" : "build";

  // Create a context for incremental builds
  try {
    const context = await esbuild[meth]({
      entryPoints: [inputFile],
      bundle: true,
      target: "es2017",
      banner: {
        // polyfill for getOwnPropertyDescriptors (SamSung 2017 not support it)
        // for references https://github.com/evanw/esbuild/issues/1892
        js: 'Object.hasOwnProperty("getOwnPropertyDescriptors")||Object.defineProperty(Object,"getOwnPropertyDescriptors",{configurable:!0,writable:!0,value:function(r){if(null==r)throw TypeError("Cannot convert undefined or null to object");var e=Object.getOwnPropertyDescriptor(r,"__proto__"),t=e?((a="__proto__")in(l={})?Object.defineProperty(l,a,{value:e,enumerable:!0,configurable:!0,writable:!0}):l[a]=e,l):{},o=!0,n=!1,i=void 0;try{for(var l,a,c,p=Object.getOwnPropertyNames(r)[Symbol.iterator]();!(o=(c=p.next()).done);o=!0){var b=c.value;t[b]=Object.getOwnPropertyDescriptor(r,b)}}catch(r){n=!0,i=r}finally{try{o||null==p.return||p.return()}finally{if(n)throw i}}return t}});'
        // polyfill for Array.prototype.includes (PS4 not support it)
        + 'Uint8Array.prototype.hasOwnProperty("every")||Object.defineProperty(Uint8Array.prototype,"every",{configurable:!0,writable:!0,value:function(r,e){if(null==this)throw TypeError("Uint8Array.prototype.every called on null or undefined");if("function"!=typeof r)throw TypeError(r+" is not a function");var t=Object(this),o=t.length>>>0;if(0===o)return!1;for(var n=0;n<o;n++)if(n in t&&!1===r.call(e,t[n],n,t))return!1;return!0;}});'
        // polyfill for fetch (PS4 not support it)
        + '!function(t,e){"object"==typeof exports&&"undefined"!=typeof module?e(exports):"function"==typeof define&&define.amd?define(["exports"],e):e(t.WHATWGFetch={})}(this,function(t){"use strict";var e="undefined"!=typeof globalThis&&globalThis||"undefined"!=typeof self&&self||"undefined"!=typeof global&&global||{},r={searchParams:"URLSearchParams"in e,iterable:"Symbol"in e&&"iterator"in Symbol,blob:"FileReader"in e&&"Blob"in e&&function(){try{return new Blob,!0}catch(t){return!1}}(),formData:"FormData"in e,arrayBuffer:"ArrayBuffer"in e};if(r.arrayBuffer)var o=["[object Int8Array]","[object Uint8Array]","[object Uint8ClampedArray]","[object Int16Array]","[object Uint16Array]","[object Int32Array]","[object Uint32Array]","[object Float32Array]","[object Float64Array]"],n=ArrayBuffer.isView||function(t){return t&&o.indexOf(Object.prototype.toString.call(t))>-1};function s(t){if("string"!=typeof t&&(t=String(t)),/[^a-z0-9\\-#$%&\'*+.^_`|~!]/i.test(t)||""===t)throw TypeError(\'Invalid character in header field name: "\'+t+\'"\');return t.toLowerCase()}function i(t){return"string"!=typeof t&&(t=String(t)),t}function a(t){var e={next:function(){var e=t.shift();return{done:void 0===e,value:e}}};return r.iterable&&(e[Symbol.iterator]=function(){return e}),e}function h(t){this.map={},t instanceof h?t.forEach(function(t,e){this.append(e,t)},this):Array.isArray(t)?t.forEach(function(t){if(2!=t.length)throw TypeError("Headers constructor: expected name/value pair to be length 2, found"+t.length);this.append(t[0],t[1])},this):t&&Object.getOwnPropertyNames(t).forEach(function(e){this.append(e,t[e])},this)}function f(t){if(!t._noBody){if(t.bodyUsed)return Promise.reject(TypeError("Already read"));t.bodyUsed=!0}}function u(t){return new Promise(function(e,r){t.onload=function(){e(t.result)},t.onerror=function(){r(t.error)}})}function d(t){var e=new FileReader,r=u(e);return e.readAsArrayBuffer(t),r}function c(t){if(t.slice)return t.slice(0);var e=new Uint8Array(t.byteLength);return e.set(new Uint8Array(t)),e.buffer}function y(){return this.bodyUsed=!1,this._initBody=function(t){if(this.bodyUsed=this.bodyUsed,this._bodyInit=t,t){if("string"==typeof t)this._bodyText=t;else if(r.blob&&Blob.prototype.isPrototypeOf(t))this._bodyBlob=t;else if(r.formData&&FormData.prototype.isPrototypeOf(t))this._bodyFormData=t;else if(r.searchParams&&URLSearchParams.prototype.isPrototypeOf(t))this._bodyText=t.toString();else{var e;r.arrayBuffer&&r.blob&&(e=t)&&DataView.prototype.isPrototypeOf(e)?(this._bodyArrayBuffer=c(t.buffer),this._bodyInit=new Blob([this._bodyArrayBuffer])):r.arrayBuffer&&(ArrayBuffer.prototype.isPrototypeOf(t)||n(t))?this._bodyArrayBuffer=c(t):this._bodyText=t=Object.prototype.toString.call(t)}}else this._noBody=!0,this._bodyText="";!this.headers.get("content-type")&&("string"==typeof t?this.headers.set("content-type","text/plain;charset=UTF-8"):this._bodyBlob&&this._bodyBlob.type?this.headers.set("content-type",this._bodyBlob.type):r.searchParams&&URLSearchParams.prototype.isPrototypeOf(t)&&this.headers.set("content-type","application/x-www-form-urlencoded;charset=UTF-8"))},r.blob&&(this.blob=function(){var t=f(this);if(t)return t;if(this._bodyBlob)return Promise.resolve(this._bodyBlob);if(this._bodyArrayBuffer)return Promise.resolve(new Blob([this._bodyArrayBuffer]));if(!this._bodyFormData)return Promise.resolve(new Blob([this._bodyText]));throw Error("could not read FormData body as blob")}),this.arrayBuffer=function(){if(this._bodyArrayBuffer){var t=f(this);return t||(ArrayBuffer.isView(this._bodyArrayBuffer)?Promise.resolve(this._bodyArrayBuffer.buffer.slice(this._bodyArrayBuffer.byteOffset,this._bodyArrayBuffer.byteOffset+this._bodyArrayBuffer.byteLength)):Promise.resolve(this._bodyArrayBuffer))}if(r.blob)return this.blob().then(d);throw Error("could not read as ArrayBuffer")},this.text=function(){var t,e,r,o,n,s=f(this);if(s)return s;if(this._bodyBlob)return t=this._bodyBlob,e=new FileReader,r=u(e),n=(o=/charset=([A-Za-z0-9_-]+)/.exec(t.type))?o[1]:"utf-8",e.readAsText(t,n),r;if(this._bodyArrayBuffer)return Promise.resolve(function t(e){for(var r=new Uint8Array(e),o=Array(r.length),n=0;n<r.length;n++)o[n]=String.fromCharCode(r[n]);return o.join("")}(this._bodyArrayBuffer));if(!this._bodyFormData)return Promise.resolve(this._bodyText);throw Error("could not read FormData body as text")},r.formData&&(this.formData=function(){return this.text().then(b)}),this.json=function(){return this.text().then(JSON.parse)},this}h.prototype.append=function(t,e){t=s(t),e=i(e);var r=this.map[t];this.map[t]=r?r+", "+e:e},h.prototype.delete=function(t){delete this.map[s(t)]},h.prototype.get=function(t){return t=s(t),this.has(t)?this.map[t]:null},h.prototype.has=function(t){return this.map.hasOwnProperty(s(t))},h.prototype.set=function(t,e){this.map[s(t)]=i(e)},h.prototype.forEach=function(t,e){for(var r in this.map)this.map.hasOwnProperty(r)&&t.call(e,this.map[r],r,this)},h.prototype.keys=function(){var t=[];return this.forEach(function(e,r){t.push(r)}),a(t)},h.prototype.values=function(){var t=[];return this.forEach(function(e){t.push(e)}),a(t)},h.prototype.entries=function(){var t=[];return this.forEach(function(e,r){t.push([r,e])}),a(t)},r.iterable&&(h.prototype[Symbol.iterator]=h.prototype.entries);var l=["CONNECT","DELETE","GET","HEAD","OPTIONS","PATCH","POST","PUT","TRACE"];function p(t,r){if(!(this instanceof p))throw TypeError(\'Please use the "new" operator, this DOM object constructor cannot be called as a function.\');var o,n,s=(r=r||{}).body;if(t instanceof p){if(t.bodyUsed)throw TypeError("Already read");this.url=t.url,this.credentials=t.credentials,r.headers||(this.headers=new h(t.headers)),this.method=t.method,this.mode=t.mode,this.signal=t.signal,s||null==t._bodyInit||(s=t._bodyInit,t.bodyUsed=!0)}else this.url=String(t);if(this.credentials=r.credentials||this.credentials||"same-origin",(r.headers||!this.headers)&&(this.headers=new h(r.headers)),this.method=(n=(o=r.method||this.method||"GET").toUpperCase(),l.indexOf(n)>-1?n:o),this.mode=r.mode||this.mode||null,this.signal=r.signal||this.signal||function(){if("AbortController"in e)return new AbortController().signal}(),this.referrer=null,("GET"===this.method||"HEAD"===this.method)&&s)throw TypeError("Body not allowed for GET or HEAD requests");if(this._initBody(s),("GET"===this.method||"HEAD"===this.method)&&("no-store"===r.cache||"no-cache"===r.cache)){var i=/([?&])_=[^&]*/;i.test(this.url)?this.url=this.url.replace(i,"$1_="+new Date().getTime()):this.url+=(/\\?/.test(this.url)?"&":"?")+"_="+new Date().getTime()}}function b(t){var e=new FormData;return t.trim().split("&").forEach(function(t){if(t){var r=t.split("="),o=r.shift().replace(/\\+/g," "),n=r.join("=").replace(/\\+/g," ");e.append(decodeURIComponent(o),decodeURIComponent(n))}}),e}function m(t,e){if(!(this instanceof m))throw TypeError(\'Please use the "new" operator, this DOM object constructor cannot be called as a function.\');if(e||(e={}),this.type="default",this.status=void 0===e.status?200:e.status,this.status<200||this.status>599)throw RangeError("Failed to construct \'Response\': The status provided (0) is outside the range [200, 599].");this.ok=this.status>=200&&this.status<300,this.statusText=void 0===e.statusText?"":""+e.statusText,this.headers=new h(e.headers),this.url=e.url||"",this._initBody(t)}p.prototype.clone=function(){return new p(this,{body:this._bodyInit})},y.call(p.prototype),y.call(m.prototype),m.prototype.clone=function(){return new m(this._bodyInit,{status:this.status,statusText:this.statusText,headers:new h(this.headers),url:this.url})},m.error=function(){var t=new m(null,{status:200,statusText:""});return t.ok=!1,t.status=0,t.type="error",t};var w=[301,302,303,307,308];m.redirect=function(t,e){if(-1===w.indexOf(e))throw RangeError("Invalid status code");return new m(null,{status:e,headers:{location:t}})},t.DOMException=e.DOMException;try{new t.DOMException}catch(v){t.DOMException=function(t,e){this.message=t,this.name=e;var r=Error(t);this.stack=r.stack},t.DOMException.prototype=Object.create(Error.prototype),t.DOMException.prototype.constructor=t.DOMException}function $(o,n){return new Promise(function(a,f){var u=new p(o,n);if(u.signal&&u.signal.aborted)return f(new t.DOMException("Aborted","AbortError"));var d=new XMLHttpRequest;function c(){d.abort()}if(d.onload=function(){var t,e,r={statusText:d.statusText,headers:(t=d.getAllResponseHeaders()||"",e=new h,t.replace(/\\r?\\n[\\t ]+/g," ").split("\\r").map(function(t){return 0===t.indexOf("\\n")?t.substr(1,t.length):t}).forEach(function(t){var r=t.split(":"),o=r.shift().trim();if(o){var n=r.join(":").trim();try{e.append(o,n)}catch(s){console.warn("Response "+s.message)}}}),e)};0===u.url.indexOf("file://")&&(d.status<200||d.status>599)?r.status=200:r.status=d.status,r.url="responseURL"in d?d.responseURL:r.headers.get("X-Request-URL");var o="response"in d?d.response:d.responseText;setTimeout(function(){a(new m(o,r))},0)},d.onerror=function(){setTimeout(function(){f(TypeError("Network request failed"))},0)},d.ontimeout=function(){setTimeout(function(){f(TypeError("Network request timed out"))},0)},d.onabort=function(){setTimeout(function(){f(new t.DOMException("Aborted","AbortError"))},0)},d.open(u.method,function t(r){try{return""===r&&e.location.href?e.location.href:r}catch(o){return r}}(u.url),!0),"include"===u.credentials?d.withCredentials=!0:"omit"===u.credentials&&(d.withCredentials=!1),"responseType"in d&&(r.blob?d.responseType="blob":r.arrayBuffer&&(d.responseType="arraybuffer")),n&&"object"==typeof n.headers&&!(n.headers instanceof h||e.Headers&&n.headers instanceof e.Headers)){var y=[];Object.getOwnPropertyNames(n.headers).forEach(function(t){y.push(s(t)),d.setRequestHeader(t,i(n.headers[t]))}),u.headers.forEach(function(t,e){-1===y.indexOf(e)&&d.setRequestHeader(e,t)})}else u.headers.forEach(function(t,e){d.setRequestHeader(e,t)});u.signal&&(u.signal.addEventListener("abort",c),d.onreadystatechange=function(){4===d.readyState&&u.signal.removeEventListener("abort",c)}),d.send(void 0===u._bodyInit?null:u._bodyInit)})}$.polyfill=!0,e.fetch||(e.fetch=$,e.Headers=h,e.Request=p,e.Response=m),t.Headers=h,t.Request=p,t.Response=m,t.fetch=$,Object.defineProperty(t,"__esModule",{value:!0})})',
      },
      minify,
      outfile: outfile || es5Outfile,
      sourcemap: 'linked',
      plugins: [esbuildStepsPlugin],
      define: {
        "process.env.NODE_ENV": JSON.stringify(isDevMode ? "development" : "production"),
        __ENVIRONMENT__: JSON.stringify({
          PRODUCTION: 0,
          DEV: 1,
          CURRENT_ENV: isDevMode ? 1 : 0,
        }),
        __LOGGER_LEVEL__: JSON.stringify({ CURRENT_LEVEL: isDevMode ? "INFO" : "NONE" }),
        __GLOBAL_SCOPE__: JSON.stringify(globalScope),
        ...globals,
      },
    });
    if (watch) {
      return context.watch();
    } else if (outfile !== undefined && es5Outfile !== undefined) {
      const contents = fs.readFileSync(outfile);
      const inputSourceMap = new TextDecoder().decode(fs.readFileSync(outfile+'.map'));

      await buildAndAnnounceEs5Bundle(contents, inputSourceMap, es5Outfile);
    }
  } catch (err) {
    logError(`Bundling failed for "${name ?? inputFile}":`, err);
    throw err;
  }

  async function buildAndAnnounceEs5Bundle(inputData, inputSourceMap, output) {
    let input;
    if (inputData !== undefined) {
      input = new TextDecoder().decode(inputData);
    } else if (outfile !== undefined) {
      input = await readFile(outfile, "utf-8");
    } else {
      throw new Error("Impossible to generate ES5 bundle: ES2017 bundling not performed");
    }
    try {
      await transpileToEs5({
        input,
        outfile: output,
        minify,
        inputSourceMap
      });
      if (!isSilent) {
        logSuccess(`ES5 file updated at ${output}!`);
      }
    } catch (err) {
      logError(`ES5 file build failed at ${output}: ${err}`);
      throw err;
    }
  }

  function logSuccess(msg) {
    if (!isSilent) {
      console.log(`\x1b[32m[${getHumanReadableHours()}]\x1b[0m`, msg);
    }
  }

  function logWarning(msg) {
    if (!isSilent) {
      console.log(`\x1b[33m[${getHumanReadableHours()}]\x1b[0m`, msg);
    }
  }

  function logError(msg) {
    if (!isSilent) {
      console.log(`\x1b[31m[${getHumanReadableHours()}]\x1b[0m`, msg);
    }
  }
}

// If true, this script is called directly
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  let shouldWatch = false;
  let shouldMinify = false;
  let production = false;
  let globalScope = false;
  let outputFile = "";
  let silent = false;
  let name;

  if (args[0] === "-h" || args[0] === "--help") {
    displayHelp();
    process.exit(0);
  }
  for (let argOffset = 1; argOffset < args.length; argOffset++) {
    const currentArg = args[argOffset];
    switch (currentArg) {
      case "-h":
      case "--help":
        displayHelp();
        process.exit(0);
        break;

      case "-w":
      case "--watch":
        shouldWatch = true;
        break;

      case "-m":
      case "--minify":
        shouldMinify = true;
        break;

      case "-p":
      case "--production-mode":
        production = true;
        break;

      case "-g":
      case "--globals":
        globalScope = true;
        break;

      case "-s":
      case "--silent":
        silent = true;
        break;

      case "-n":
      case "--name":
        {
          argOffset++;
          name = args[argOffset];
          if (name === undefined) {
            console.error("ERROR: no name provided\n");
            displayHelp();
            process.exit(1);
          }
        }
        break;

      case "-o":
      case "--output":
        {
          argOffset++;
          const wantedOutput = args[argOffset];
          if (wantedOutput === undefined) {
            console.error("ERROR: no output file provided\n");
            displayHelp();
            process.exit(1);
          }
          outputFile = path.normalize(wantedOutput);
        }
        break;

      case "-5":
      case "--es5":
        {
          argOffset++;
          const wantedOutput = args[argOffset];
          if (wantedOutput === undefined) {
            console.error("ERROR: no output file provided for -5/--es5 option\n");
            displayHelp();
            process.exit(1);
          }
          outputFile = path.normalize(wantedOutput);
        }
        break;
      case "--":
        argOffset = args.length;
        break;
      default: {
        console.error('ERROR: unknown option: "' + currentArg + '"\n');
        displayHelp();
        process.exit(1);
      }
    }
  }

  const inputFile = args[0];
  if (inputFile === undefined) {
    console.error("ERROR: no input file provided\n");
    displayHelp();
    process.exit(1);
  }

  const normalizedPath = path.normalize(inputFile);
  if (!fs.existsSync(normalizedPath)) {
    console.error(`ERROR: input file not found: ${inputFile}\n`);
    displayHelp();
    process.exit(1);
  }

  try {
    runBundler(normalizedPath, {
      watch: shouldWatch,
      minify: shouldMinify,
      production,
      globalScope,
      silent,
      outfile: outputFile,
      name,
    }).catch((err) => {
      console.error(`ERROR: ${err}\n`);
      process.exit(1);
    });
  } catch (err) {
    console.error(`ERROR: ${err}\n`);
    process.exit(1);
  }
}

/**
 * Simple promisified `fs.readFile` API.
 * @param {string} filePath
 * @param {string|null} encoding
 * @returns {*} - Read data, the type depends on the `encoding` parameters (see
 * `fs.readFile` documentation).
 */
function readFile(filePath, encoding) {
  return new Promise((res, rej) => {
    fs.readFile(filePath, { encoding }, function (err, data) {
      if (err) {
        rej(err);
      }
      res(data);
    });
  });
}

/**
 * Simple promisified `fs.writeFile` API.
 * @param {string} filePath
 * @param {string} content
 * @returns {Promise}
 */
function writeFile(filePath, content) {
  return new Promise((res, rej) => {
    fs.writeFile(filePath, content, (err) => {
      if (err) {
        rej(err);
      }
      res();
    });
  });
}

async function transpileToEs5(options) {
  const input = options.input;
  const outfile = options.outfile;
  const minify = options.minify;
  const inputSourceMap = options.inputSourceMap || true;
  const output = await swc.transform(input, {
    jsc: {
      parser: {
        syntax: "ecmascript",
        jsx: false,
        dynamicImport: false,
        privateMethod: false,
        functionBind: false,
        exportDefaultFrom: false,
        exportNamespaceFrom: false,
        decorators: false,
        decoratorsBeforeExport: false,
        topLevelAwait: false,
        importMeta: false,
      },
      minify: {
        compress: {
          unused: true,
        },
        mangle: true,
      },
      transform: null,
      target: "es5",
      loose: false,
      externalHelpers: false,
      // Requires v1.2.50 or upper and requires target to be es2016 or upper.
      keepClassNames: false,
    },
    minify,
    inputSourceMap,
    sourceMaps: true,
  });
  await writeFile(outfile, `(function(){${output.code}})();`);
  await writeFile(outfile + '.map', output.map);
}

/**
 * Display through `console.log` an helping message relative to how to run this
 * script.
 */
function displayHelp() {
  console.log(
    `run_bundler.mjs: Produce a RxPlayer bundle (a single JS file containing the RxPlayer).

Usage: node run_bundler.mjs <INPUT FILE> [OPTIONS]

Available options:
  -h, --help                  Display this help message
  -m, --minify                Minify the built bundle
  -o <path>, --output <path>  Specify an output file for the ES2017 bundle. To ignore to skip ES2017
                              bundle generation.
  -5 <path>, --es5 <path>     Perform an ES5-compatible build, should be followed by the corresponding
                              output filename (e.g. '-5 "dist/rx-player.es5.js"')
  -p, --production-mode       Build all files in production mode (less runtime checks, mostly).
  -g, --globals               Add the RxPlayer to the global scope.
  -n, --name                  Optional "name" to refer to your bundle. Will be used for in log output outputs.
  -s, --silent                Don't log to stdout/stderr when bundling.
  -w, --watch                 Re-build each time any of the files depended on changed.`,
  );
}

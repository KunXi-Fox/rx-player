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

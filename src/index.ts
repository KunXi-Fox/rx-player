/**
 * Copyright 2015 CANAL+ Group
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * This file exports a Player class with a default feature set.
 * This is the class used from a regular build.
 */

import isDebugModeEnabled from "./compat/is_debug_mode_enabled";
import patchWebkitSourceBuffer from "./compat/patch_webkit_source_buffer";
import { MULTI_THREAD } from "./experimental/features";
import {
  DASH,
  DIRECTFILE,
  EME,
  HTML_SAMI_PARSER,
  HTML_SRT_PARSER,
  HTML_TTML_PARSER,
  HTML_VTT_PARSER,
  NATIVE_SAMI_PARSER,
  NATIVE_SRT_PARSER,
  NATIVE_TTML_PARSER,
  NATIVE_VTT_PARSER,
  SMOOTH,
} from "./features/list";

import logger from "./log";
import Player from "./main_thread/api";
import globalScope from "./utils/global_scope";

patchWebkitSourceBuffer();

Player.Features = [MULTI_THREAD, DIRECTFILE, SMOOTH];

Player.addFeatures([
  DASH,
  EME,
  NATIVE_TTML_PARSER,
  NATIVE_SAMI_PARSER,
  NATIVE_VTT_PARSER,
  NATIVE_SRT_PARSER,
  HTML_TTML_PARSER,
  HTML_SAMI_PARSER,
  HTML_VTT_PARSER,
  HTML_SRT_PARSER,
]);
if (isDebugModeEnabled()) {
  logger.setLevel("DEBUG", "standard");
} else if ((__ENVIRONMENT__.CURRENT_ENV as number) === (__ENVIRONMENT__.DEV as number)) {
  logger.setLevel(__LOGGER_LEVEL__.CURRENT_LEVEL, "standard");
}
export default Player;

if (typeof __GLOBAL_SCOPE__ === "boolean" && __GLOBAL_SCOPE__) {
  (globalScope as typeof globalScope & { RxPlayer?: typeof Player }).RxPlayer = Player;
}

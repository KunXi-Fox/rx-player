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

import type { IMediaElement } from "../../compat/browser_compatibility_types";
import MediaKeysAttacher from "./utils/media_keys_attacher";

/**
 * Free up all ressources taken by the content decryption logic.
 * @param {HTMLMediaElement} mediaElement
 * @returns {Promise}
 */
export default async function disposeDecryptionResources(
  mediaElement: IMediaElement,
): Promise<unknown> {
  return MediaKeysAttacher.clearMediaKeys(mediaElement);
}

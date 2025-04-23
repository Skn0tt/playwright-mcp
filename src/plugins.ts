/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import module from 'node:module';
import path from 'node:path';
import type { Plugin } from '..';

type PluginFactory = () => Promise<Plugin>;

const cwd = process.cwd().endsWith(path.sep) ? process.cwd() : process.cwd() + path.sep;

export async function loadPlugin(pathOrNPMModule: string): Promise<PluginFactory> {
  const plugin = module.createRequire(cwd)(pathOrNPMModule);
  console.error(`Loaded plugin from ${pathOrNPMModule}`);
  return async () => {
    if (typeof plugin === 'function')
      return await plugin();
    return await plugin.default();
  };
}

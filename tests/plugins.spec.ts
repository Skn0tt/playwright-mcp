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

import fs from 'node:fs/promises';
import { expect, test } from './fixtures';
import type { Plugin } from '..';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';

function createPlugin(): Plugin {
  return {
    async onCreateBrowserContext(browserContext) {
      await browserContext.addInitScript(() => {
        Math.random = () => 42;
      });
    },
  };
}

async function checkPlugin(client: Client) {
  expect(await client.callTool({
    name: 'browser_navigate',
    arguments: {
      url: 'data:text/html,<p id="result">random value</p><script>document.getElementById("result").innerText = Math.random()</script>',
    },
  })).toContainTextContent('42');
}

test.describe('plugin file', () => {
  test('with absolute path', async ({ startClient }, testInfo) => {
    const pluginPath = testInfo.outputPath('plugin.js');
    await fs.writeFile(pluginPath, `module.exports = ${createPlugin.toString()}`);
    const client = await startClient({ args: ['--plugin', pluginPath] });
    await checkPlugin(client);
  });
  test('with relative path', async ({ startClient }, testInfo) => {
    const pluginPath = testInfo.outputPath('plugin.js');
    await fs.writeFile(pluginPath, `module.exports = ${createPlugin.toString()}`);
    const client = await startClient({ args: ['--plugin', './plugin.js'], cwd: testInfo.outputDir });
    await checkPlugin(client);
  });
});

test('installed npm module', async ({ startClient }, testInfo) => {
  await fs.mkdir(testInfo.outputPath('node_modules', '@acme', 'pw-plugin'), { recursive: true });
  await fs.writeFile(testInfo.outputPath('node_modules', '@acme', 'pw-plugin', 'index.js'), `module.exports = ${createPlugin.toString()}`);
  const client = await startClient({ args: ['--plugin', '@acme/pw-plugin'], cwd: testInfo.outputDir });
  await checkPlugin(client);
});

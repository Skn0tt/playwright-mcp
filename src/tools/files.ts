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

import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import fs from 'fs/promises';
import path from 'path';

import type { ToolFactory } from './tool';

const uploadFileSchema = z.object({
  paths: z.array(z.string()).optional().describe('The absolute paths to the files to upload. Can be a single file or multiple files.'),
  files: z.array(z.object({
    name: z.string().describe('The name of the file'),
    mimeType: z.string().describe('The mime type of the file'),
    content: z.string().describe('The base64 encoded content of the file'),
  })).optional().describe('The files to upload. Can be a single file or multiple files.'),
}).refine(data => {
  return data.paths?.length || data.files?.length;
}, {
  message: 'Either paths or files must be provided',
  path: ['paths', 'files'],
});

const uploadFile: ToolFactory = captureSnapshot => ({
  capability: 'files',

  schema: {
    name: 'browser_file_upload',
    description: 'Upload one or multiple files',
    inputSchema: zodToJsonSchema(uploadFileSchema),
  },

  handle: async (context, params) => {
    const validatedParams = uploadFileSchema.parse(params);
    const modalState = context.modalStates().find(state => state.type === 'fileChooser');
    if (!modalState)
      throw new Error('No file chooser visible');

    const code = [
      `// <internal code to chose files>`,
    ];

    const action = async () => {
      if (validatedParams.files) {
        const files: { name: string, mimeType: string, buffer: Buffer }[] = [];

        for (const file of validatedParams.files) {
          files.push({
            name: file.name,
            mimeType: file.mimeType,
            buffer: Buffer.from(file.content, 'base64'),
          });
        }

        for (const pathParam of validatedParams.paths ?? []) {
          files.push({
            name: path.basename(pathParam),
            mimeType: 'application/octet-stream',
            buffer: await fs.readFile(pathParam),
          });
        }

        await modalState.fileChooser.setFiles(files);
      } else {
        await modalState.fileChooser.setFiles(validatedParams.paths!);
      }
      context.clearModalState(modalState);
    };

    return {
      code,
      action,
      captureSnapshot,
      waitForNetwork: true,
    };
  },
  clearsModalState: 'fileChooser',
});

export default (captureSnapshot: boolean) => [
  uploadFile(captureSnapshot),
];

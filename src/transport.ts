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

import http from 'node:http';
import assert from 'node:assert';
import crypto from 'node:crypto';
import z from 'zod';
import path from 'node:path';
import fs from 'node:fs';
import jwt from 'jsonwebtoken';

import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import playwright from 'playwright';

import { createConnection } from './connection.js';

import type { Connection } from './connection.js';
import type { FullConfig } from './config.js';
import { getCacheDir } from './context.js';

export async function startStdioTransport(config: FullConfig, connectionList: Connection[]) {
  const connection = await createConnection(config);
  await connection.connect(new StdioServerTransport());
  connectionList.push(connection);
}

async function handleSSE(config: FullConfig, req: http.IncomingMessage, res: http.ServerResponse, url: URL, sessions: Map<string, SSEServerTransport>, connectionList: Connection[]) {
  if (req.method === 'POST') {
    const sessionId = url.searchParams.get('sessionId');
    if (!sessionId) {
      res.statusCode = 400;
      return res.end('Missing sessionId');
    }

    const transport = sessions.get(sessionId);
    if (!transport) {
      res.statusCode = 404;
      return res.end('Session not found');
    }

    return await transport.handlePostMessage(req, res);
  } else if (req.method === 'GET') {
    const transport = new SSEServerTransport('/sse', res);
    sessions.set(transport.sessionId, transport);
    const connection = await createConnection(config);
    await connection.connect(transport);
    connectionList.push(connection);
    res.on('close', () => {
      sessions.delete(transport.sessionId);
      connection.close().catch(e => {
        // eslint-disable-next-line no-console
        console.error(e);
      });
    });
    return;
  }

  res.statusCode = 405;
  res.end('Method not allowed');
}

async function handleStreamable(config: FullConfig, req: http.IncomingMessage, res: http.ServerResponse, sessions: Map<string, StreamableHTTPServerTransport>, connectionList: Connection[]) {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  if (sessionId) {
    const transport = sessions.get(sessionId);
    if (!transport) {
      res.statusCode = 404;
      res.end('Session not found');
      return;
    }
    return await transport.handleRequest(req, res);
  }

  if (req.method === 'POST') {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: sessionId => {
        sessions.set(sessionId, transport);
      }
    });
    transport.onclose = () => {
      if (transport.sessionId)
        sessions.delete(transport.sessionId);
    };
    const connection = await createConnection(config);
    connectionList.push(connection);
    await Promise.all([
      connection.connect(transport),
      transport.handleRequest(req, res),
    ]);
    return;
  }

  res.statusCode = 400;
  res.end('Invalid request');
}

async function isAuthenticated(req: http.IncomingMessage) {
  try {
    const header = req.headers['authorization'];
    if (!header || !header.startsWith('Bearer '))
      return false;

    const token = header.split(' ')[1];
    if (!token)
      return false;

    const { client_id } = jwt.decode(token) as AccessTokenData;
    const clientData = await loadClientData(client_id);
    jwt.verify(token, clientData.client_secret);
    return true;
  } catch {
    return false;
  }
}

function readBody(req: http.IncomingMessage){
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readBodyJSON(req: http.IncomingMessage){
  const body = await readBody(req);
  return JSON.parse(body.toString());
}

async function readBodyForm(req: http.IncomingMessage){
  const body = await readBody(req);
  return Object.fromEntries(new URLSearchParams(body.toString()).entries());
}

const dynamicRegisterBody = z.object({
  client_name: z.string(),
  client_uri: z.string().optional(),
  redirect_uris: z.array(z.string()).optional(),
});

interface ClientData {
  client_name: string;
  client_id: string;
  client_secret: string;
}

async function registerClient(data: z.infer<typeof dynamicRegisterBody>) {
  const client_id = crypto.randomUUID();
  const client_secret = crypto.randomUUID();

  const clientDir = path.join(getCacheDir(), 'oauth', 'clients');
  await fs.promises.mkdir(clientDir, { recursive: true });

  const clientFile = path.join(clientDir, `${client_id}.json`);
  const clientData: ClientData = {
    client_name: data.client_name,
    client_id,
    client_secret,
  };
  await fs.promises.writeFile(clientFile, JSON.stringify(clientData));

  return {
    ...clientData,
    client_secret_expires_at: 0, // never expires
  };
}

async function loadClientData(clientId: string) {
  const clientFile = path.join(getCacheDir(), 'oauth', 'clients', `${clientId}.json`);
  const contents = await fs.promises.readFile(clientFile, 'utf-8');
  return JSON.parse(contents) as ClientData;
}

const authorizeSearchParams = z.object({
  client_id: z.string(),
  redirect_uri: z.string(),
  response_type: z.enum(['code']),
  state: z.string(),
});

const tokenForm = z.object({
  client_id: z.string(),
  grant_type: z.enum(['authorization_code']),
  code: z.string(), // JWT containing `AuthorisationCodeData`,
  redirect_uri: z.string(),
});

interface AuthorisationCodeData {
  redirect_uri: string;
}

interface AccessTokenData {
  client_id: string;
}

async function handleAuthorisation(req: http.IncomingMessage, res: http.ServerResponse, url: URL, next: () => void) {
  if (await isAuthenticated(req))
    return next();

  if (url.pathname.startsWith('/.well-known/oauth-authorization-server')) {
    res.setHeader('Content-Type', 'application/json');
    const issuer = new URL(`http://${req.headers.host}`);
    return res.end(JSON.stringify({
      issuer: issuer.toString(),
      authorization_endpoint: new URL('/authorize', issuer).toString(),
      token_endpoint: new URL('/token', issuer).toString(),
      registration_endpoint: new URL('/register', issuer).toString(),
      service_documentation: 'https://github.com/microsoft/playwright-mcp',
    }));
  }

  if (url.pathname === '/register') {
    const registerBody = dynamicRegisterBody.parse(await readBodyJSON(req));
    const result = await registerClient(registerBody);
    res.statusCode = 201;
    res.end(JSON.stringify(result));
  } else if (url.pathname === '/authorize') {
    const searchParams = authorizeSearchParams.parse(Object.fromEntries(url.searchParams.entries()));
    const clientData = await loadClientData(searchParams.client_id);

    const browser = await playwright.chromium.launch({ headless: false });
    const page = await browser.newPage();
    await page.setContent(`
      <h1>Model Context Protocol Authorisation</h1>
      <p>To use this server, you need to authorise it with your client.</p>
      <p>Click the button below to authorise.</p>
      <button onclick="__onAuthorise()">Authorise</button>
      <button onclick="__onDeny()">Deny</button>
    `);
    const authorised = await new Promise<boolean>(async resolve => {
      await page.exposeFunction('__onAuthorise', () => resolve(true));
      await page.exposeFunction('__onDeny', () => resolve(false));
    });
    await browser.close();
    if (!authorised) {
      res.statusCode = 403;
      return res.end('Access denied');
    }

    const authorizationCodeData: AuthorisationCodeData = {
      redirect_uri: searchParams.redirect_uri,
    };
    const authorizationCode = jwt.sign(
        authorizationCodeData,
        clientData.client_secret,
        {
          expiresIn: '60s'
        }
    );
    const redirectURL = new URL(searchParams.redirect_uri);
    redirectURL.searchParams.set('code', authorizationCode);
    redirectURL.searchParams.set('state', searchParams.state);
    res.statusCode = 302;
    res.setHeader('Location', redirectURL.toString());
    res.end();
  } else if (url.pathname === '/token') {
    const form = tokenForm.parse(await readBodyForm(req));
    const clientData = await loadClientData(form.client_id);
    let payload: AuthorisationCodeData;
    try {
      payload = jwt.verify(form.code, clientData.client_secret) as AuthorisationCodeData;
    } catch {
      res.statusCode = 401;
      return res.end('Invalid token');
    }

    if (payload.redirect_uri !== form.redirect_uri) {
      res.statusCode = 401;
      return res.end('Invalid redirect URI');
    }

    const accessTokenData: AccessTokenData = {
      client_id: clientData.client_id,
    };
    const accessToken = jwt.sign(accessTokenData, clientData.client_secret);

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify({
      access_token: accessToken,
      token_type: 'Bearer',
    }));
  } else {
    res.statusCode = 401;
    res.end('Unauthenticated');
  }
}

export function startHttpTransport(config: FullConfig, port: number, hostname: string | undefined, connectionList: Connection[]) {
  const sseSessions = new Map<string, SSEServerTransport>();
  const streamableSessions = new Map<string, StreamableHTTPServerTransport>();
  const httpServer = http.createServer(async (req, res) => {
    const url = new URL(`http://localhost${req.url}`);
    res.setHeader('MCP-Protocol-Version', '2025-03-26');
    await handleAuthorisation(req, res, url, async () => {
      if (url.pathname.startsWith('/mcp'))
        await handleStreamable(config, req, res, streamableSessions, connectionList);
      else
        await handleSSE(config, req, res, url, sseSessions, connectionList);
    });
  });
  httpServer.listen(port, hostname, () => {
    const address = httpServer.address();
    assert(address, 'Could not bind server socket');
    let url: string;
    if (typeof address === 'string') {
      url = address;
    } else {
      const resolvedPort = address.port;
      let resolvedHost = address.family === 'IPv4' ? address.address : `[${address.address}]`;
      if (resolvedHost === '0.0.0.0' || resolvedHost === '[::]')
        resolvedHost = 'localhost';
      url = `http://${resolvedHost}:${resolvedPort}`;
    }
    const message = [
      `Listening on ${url}`,
      'Put this in your client config:',
      JSON.stringify({
        'mcpServers': {
          'playwright': {
            'url': `${url}/sse`
          }
        }
      }, undefined, 2),
      'If your client supports streamable HTTP, you can use the /mcp endpoint instead.',
    ].join('\n');
    // eslint-disable-next-line no-console
    console.error(message);
  });
}

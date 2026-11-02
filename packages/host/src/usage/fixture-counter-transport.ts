// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { request } from 'node:http';
import { lstatSync, realpathSync } from 'node:fs';
import type { Stats } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const SOCKET_ENV = 'SPIDER_HERDR_E2E_COUNTER_SOCKET';
const ENDPOINT = 'https://api.github.com/copilot_internal/user';
const LIMIT = 1024 * 1024;
function configuration(message: string): never { throw new Error(`fixture-counter-config: ${message}`); }
function below(root: string, target: string): boolean {
  const suffix = relative(root, target);
  return Boolean(suffix) && !isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith(`..${sep}`);
}
function noSymlinks(root: string, path: string): void {
  let cursor = path;
  while (cursor !== root) {
    if (lstatSync(cursor).isSymbolicLink()) configuration('symlink path refused');
    const parent = dirname(cursor);
    if (parent === cursor) configuration('path leaves fixture root');
    cursor = parent;
  }
  if (lstatSync(root).isSymbolicLink()) configuration('symlink fixture root refused');
}
function privatePath(path: string, kind: 'auth' | 'socket' | 'domain'): Stats {
  const stat = lstatSync(path);
  if (stat.mode & 0o077 || process.getuid && stat.uid !== process.getuid()) configuration(`private ${kind} required`);
  if (kind === 'auth' && !stat.isFile() || kind === 'socket' && !stat.isSocket() || kind === 'domain' && !stat.isDirectory()) configuration(`invalid ${kind} path`);
  return stat;
}
/** The ordinary transport is unchanged unless an explicit fixture socket is requested. */
export function selectFixtureCounterTransport(authPath: string, ordinary: typeof globalThis.fetch, env: Readonly<NodeJS.ProcessEnv> = process.env): typeof globalThis.fetch {
  if (!Object.hasOwn(env, SOCKET_ENV)) return ordinary;
  let scratch: string, socket: string, domain: string, socketIdentity: Stats;
  try {
    const checkout = env.SPIDER_TEST_FIXTURE_CHECKOUT;
    const configured = env[SOCKET_ENV];
    if (!checkout || !configured || !isAbsolute(checkout) || !isAbsolute(configured)) configuration('fixture checkout and absolute socket required');
    scratch = resolve(checkout, '.spider/scratch'); socket = resolve(configured); domain = dirname(socket);
    if (realpathSync(scratch) !== scratch || !below(scratch, domain)) configuration('socket must be under the fixture checkout scratch');
    if (Buffer.byteLength(socket) > 103) configuration('socket exceeds 103 bytes');
    if (!isAbsolute(authPath) || !below(domain, resolve(authPath))) configuration('auth must be in the same fixture domain');
    noSymlinks(scratch, domain); noSymlinks(domain, socket); noSymlinks(domain, resolve(authPath));
    privatePath(domain, 'domain'); privatePath(resolve(authPath), 'auth'); socketIdentity = privatePath(socket, 'socket');
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('fixture-counter-config:')) throw error;
    configuration('cannot validate private fixture paths');
  }
  const transport: typeof globalThis.fetch = async (input, init) => {
    const req = input instanceof Request ? input : undefined;
    const url = req ? req.url : String(input);
    const method = init?.method ?? req?.method ?? 'GET';
    if (url !== ENDPOINT || method !== 'GET' || init?.body != null || req?.body != null) throw new Error('fixture transport accepts only the known counter request');
    const signal = init?.signal ?? req?.signal;
    if (signal?.aborted) throw signal.reason ?? new Error('counter request aborted');
    // Recheck external paths before each request, including atomic endpoint replacement.
    noSymlinks(domain, socket); noSymlinks(domain, resolve(authPath)); privatePath(resolve(authPath), 'auth');
    const current = privatePath(socket, 'socket');
    if (current.ino !== socketIdentity.ino || current.dev !== socketIdentity.dev) configuration('fixture socket identity changed');
    const headers = Object.fromEntries(new Headers(init?.headers ?? req?.headers).entries());
    return new Promise<Response>((resolve, reject) => {
      const call = request({ socketPath: socket, path: '/copilot_internal/user', method: 'GET', headers, signal: signal ?? undefined }, response => {
        const chunks: Buffer[] = []; let bytes = 0;
        response.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > LIMIT) { call.destroy(new Error('fixture counter response exceeds limit')); return; }
          chunks.push(chunk);
        });
        response.on('error', reject);
        response.on('aborted', () => reject(new Error('fixture counter response incomplete')));
        response.on('end', () => {
          try {
            const status = response.statusCode ?? 0;
            if (status < 200 || status > 599) throw new Error('fixture counter response has invalid status');
            const headers: Record<string, string> = {};
            for (const [key, value] of Object.entries(response.headers)) if (value !== undefined) headers[key] = Array.isArray(value) ? value.join(', ') : value;
            const body = [204, 205, 304].includes(status) ? null : new Uint8Array(Buffer.concat(chunks));
            resolve(new Response(body, { status, headers }));
          } catch (error) { reject(error); }
        });
      });
      call.on('error', reject); call.end();
    });
  };
  return transport;
}

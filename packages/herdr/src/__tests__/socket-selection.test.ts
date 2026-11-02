// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { afterEach, expect, test } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { selectedSocket, parseCore } from '../client/parse.js';
import { createHcClient, invokeCli } from '../client/hc.js';
import { createClientFixture, type ClientFixture } from './testutil.js';

const fixtures: ClientFixture[] = [];
const clients: ReturnType<typeof createHcClient>[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) await client.dispose();
  for (const fixture of fixtures.splice(0)) await fixture.close();
});
async function fixture() { const h = await createClientFixture(); fixtures.push(h); return h; }
async function config(h: ClientFixture, text: string) {
  await mkdir(join(h.localEnv.XDG_CONFIG_HOME!, 'herdr-core'), { recursive: true });
  await writeFile(join(h.localEnv.XDG_CONFIG_HOME!, 'herdr-core/config.toml'), text);
}

test('HC_SOCKET wins over config and terminal provenance', async () => {
  const h = await fixture(); await config(h, `socket = '${h.foreignSocket}'\n`);
  const env = { ...h.localEnv, HC_SOCKET: h.localSocket, HC_TERMINAL_SOCKET: h.foreignSocket };
  expect(selectedSocket(env)).toBe(h.localSocket);
  expect(parseCore({ version: '0.1.16', core: { id: 'core' } }, env).socket).toBe(h.localSocket);
});

test.each([
  (socket: string) => `notes = false\nsocket = "${socket}" # selected endpoint\n`,
  (socket: string) => `'socket' = '${socket}'\n`,
  (socket: string) => `"socket" = """\n${socket}"""\n`,
  (socket: string) => `socket = '''\n${socket}'''\n`,
  (socket: string) => `shell = [\n  'sh',\n  'socket = "/wrong.sock"'\n]\nsocket = '${socket}'\n`,
  (socket: string) => `unknown = """\nsocket = '/wrong.sock'\n"""\nsocket = '${socket}'\n`,
])('the root config socket wins over terminal provenance %#', async value => {
  const h = await fixture(); await config(h, value(h.foreignSocket));
  expect(selectedSocket({ ...h.localEnv, HC_SOCKET: undefined })).toBe(h.foreignSocket);
});

test('basic TOML socket strings decode Unicode escapes and keep hashes inside the string', async () => {
  const h = await fixture();
  await config(h, `socket = "${h.root}/\\u0061#b.sock" # comment\n`);
  expect(selectedSocket({ ...h.localEnv, HC_SOCKET: undefined })).toBe(join(h.root, 'a#b.sock'));
});

test.each([`socket = '/one.sock'\nsocket = '/two.sock'\n`, `socket = \"unterminated\n`, `socket = []\n`, String.raw`socket = "\uD800"`])('an invalid socket config fails closed %#', async value => {
  const h = await fixture(); await config(h, value);
  await expect(Promise.resolve().then(() => invokeCli(h.hcBinary, ['server', 'status', '--json'], { ...h.localEnv, HC_SOCKET: undefined }))).rejects.toMatchObject({ code: 'invalid-config' });
  expect(await h.calls()).toEqual([]);
});

test('a nested or commented socket is not a root config override', async () => {
  const h = await fixture(); await config(h, `# socket = '/wrong.sock'\n[other]\nsocket = '/wrong.sock'\n`);
  expect(selectedSocket({ ...h.localEnv, HC_SOCKET: undefined, HC_TERMINAL_SOCKET: undefined, XDG_RUNTIME_DIR: join(h.root, 'run') })).toBe(join(h.root, 'run/herdr-core/fl.sock'));
});

test('the runtime directory has no per-session subdirectory and trims the hc namespace', async () => {
  const h = await fixture();
  expect(selectedSocket({ ...h.localEnv, HC_SOCKET: undefined, HC_TERMINAL_SOCKET: h.foreignSocket, HC_SESSION: ' fl ', XDG_RUNTIME_DIR: join(h.root, 'run') })).toBe(join(h.root, 'run/herdr-core/fl.sock'));
});

test('the Linux user runtime fallback uses an injected directory existence check', async () => {
  const h = await fixture(); const checked: string[] = [];
  const env = { ...h.localEnv, HC_SOCKET: undefined, HC_TERMINAL_SOCKET: undefined, XDG_RUNTIME_DIR: undefined };
  expect(selectedSocket(env, { uid: 42, isDirectory: path => { checked.push(path); return path === '/run/user/42'; } })).toBe('/run/user/42/herdr-core/fl.sock');
  expect(checked).toEqual(['/run/user/42']);
  expect(selectedSocket(env, { uid: 42, isDirectory: () => false })).toBe(h.localSocket);
});

test('Unix defaults with HOME unset match hc rather than the operating-system home lookup', async () => {
  const h = await fixture();
  expect(selectedSocket({ XDG_CONFIG_HOME: join(h.root, 'empty-config'), HC_SESSION: 'plain' }, { isDirectory: () => false })).toBe('/.local/state/herdr-core/plain/plain.sock');
});

test('a shell outside Herdr can probe an explicit live HC_SOCKET', async () => {
  const h = await fixture();
  const env = { ...h.localEnv, HC_SOCKET: h.localSocket, HC_TERMINAL_SOCKET: undefined, XDG_STATE_HOME: join(h.root, 'unused') };
  const client = createHcClient({ binary: h.hcBinary, env }); clients.push(client);
  expect(await client.identity()).toMatchObject({ socket: h.localSocket, coreId: 'local-core' });
});

test('a live terminal socket cannot authorize hc against a different selected socket', async () => {
  const h = await fixture();
  const env = { ...h.localEnv, HC_SOCKET: h.foreignSocket };
  await expect(invokeCli(h.hcBinary, ['server', 'status', '--json'], env)).rejects.toMatchObject({ code: 'core-mismatch' });
  expect(await h.calls()).toEqual([]);
  const client = createHcClient({ binary: h.hcBinary, env }); clients.push(client);
  await expect(client.events().ready).rejects.toMatchObject({ code: 'core-mismatch' });
  expect(await h.calls()).toEqual([]);
});

test('a plain shell uses the live config-selected socket for both the probe and hc', async () => {
  const h = await fixture(); await config(h, `socket = '${h.localSocket}'\n`);
  const env = { ...h.localEnv, HC_SOCKET: undefined, HC_TERMINAL_SOCKET: undefined, XDG_STATE_HOME: join(h.root, 'unused') };
  const client = createHcClient({ binary: h.hcBinary, env }); clients.push(client);
  expect(await client.identity()).toMatchObject({ socket: h.localSocket });
});

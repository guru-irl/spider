#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { createServer, createConnection } from 'node:net';
import { readFileSync, realpathSync, lstatSync, chmodSync, appendFileSync, writeFileSync, renameSync } from 'node:fs';
import { resolve, relative, isAbsolute, sep, join, dirname } from 'node:path';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createFakeAppBoundary } from '../harness/fake-app.ts';
import { validateAppCommand, parseAppEnvelope } from '../harness/app.ts';

const LIMIT = 1024 * 1024;
export function ownedPath(root, target, missing = false) {
  const base = realpathSync(root), path = resolve(target);
  const suffix = relative(base, path);
  if (!suffix || isAbsolute(suffix) || suffix === '..' || suffix.startsWith(`..${sep}`)) throw new Error('unowned app path');
  let current = path;
  while (current !== base) {
    try { if (lstatSync(current).isSymbolicLink()) throw new Error('symlink app path'); }
    catch (error) { if (error.code !== 'ENOENT' || !missing) throw error; }
    current = dirname(current);
  }
  return path;
}
function socketPath(root, path, missing = false) {
  const target = ownedPath(root, path, missing);
  if (Buffer.byteLength(target) > 103) throw new Error('app socket exceeds 103 bytes');
  return target;
}
export function serveBoundary(socket, boundary) {
  const sockets = new Set();
  const server = createServer(connection => {
    sockets.add(connection); connection.on('close', () => sockets.delete(connection));
    let buffer = '', seen = false;
    const decoder = new TextDecoder('utf-8', { fatal: true });
    connection.setTimeout(15000, () => connection.destroy());
    connection.on('error', () => {});
    connection.on('data', data => {
      try { buffer += decoder.decode(data, { stream: true }); }
      catch { connection.end(JSON.stringify({ error: 'invalid UTF-8 app request' }) + '\n'); return; }
      if (Buffer.byteLength(buffer) > LIMIT) { connection.end(JSON.stringify({ error: 'oversized app request' }) + '\n'); return; }
      if (!buffer.includes('\n')) return;
      const line = buffer.slice(0, buffer.indexOf('\n'));
      if (seen || buffer.slice(buffer.indexOf('\n') + 1).trim()) { connection.end(JSON.stringify({ error: 'one app request per connection' }) + '\n'); return; }
      seen = true;
      void (async () => {
        let request;
        try {
          request = JSON.parse(line);
          if (!request || typeof request !== 'object' || typeof request.requestId !== 'string' || !request.requestId || typeof request.name !== 'string' || Object.keys(request).some(k => !['requestId', 'name', 'args'].includes(k))) throw new Error('malformed app request');
          validateAppCommand(request.name, request.args);
          const result = await boundary.command(request.name, request.args);
          connection.end(JSON.stringify({ requestId: request.requestId, result }) + '\n');
        } catch (error) {
          connection.end(JSON.stringify({ requestId: request?.requestId ?? null, result: { error: error instanceof Error ? error.message : String(error) } }) + '\n');
        }
      })();
    });
  });
  return {
    listen: () => new Promise((resolve, reject) => { server.once('error', reject); server.listen(socket, () => { chmodSync(socket, 0o600); resolve(); }); }),
    close: async () => { for (const s of sockets) s.destroy(); await boundary.drain(); await new Promise(resolve => server.close(resolve)); },
  };
}
export async function appRequest(socket, name, args) {
  validateAppCommand(name, args);
  const requestId = randomUUID();
  return new Promise((resolve, reject) => {
    const connection = createConnection(socket);
    let buffer = '', settled = false;
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const fail = error => { if (!settled) { settled = true; connection.destroy(); reject(error); } };
    connection.setTimeout(15000, () => fail(new Error('app request deadline')));
    connection.on('error', fail);
    connection.on('connect', () => connection.write(JSON.stringify({ requestId, name, args }) + '\n'));
    connection.on('data', data => {
      try { buffer += decoder.decode(data, { stream: true }); }
      catch { fail(new Error('invalid UTF-8 app reply')); return; }
      if (Buffer.byteLength(buffer) > LIMIT) { fail(new Error('oversized app reply')); return; }
      if (!buffer.includes('\n')) return;
      try {
        const value = JSON.parse(buffer.slice(0, buffer.indexOf('\n')));
        const reply = parseAppEnvelope(requestId, name, args, value);
        settled = true; connection.destroy(); resolve(reply);
      } catch (error) { fail(error); }
    });
    connection.on('close', () => { if (!settled) fail(new Error('incomplete app reply')); });
  });
}
export function cliArgs(argv) {
  const [verb, name, ...flags] = argv;
  if (verb === 'do' && name && flags.length === 1 && flags[0].startsWith('{')) {
    const args = JSON.parse(flags[0]); validateAppCommand(name, args); return { name, args };
  }
  if (['ls', 'status'].includes(verb) && argv.length === 1) return { name: verb, args: {} };
  if (verb !== 'do' || !name || flags.length % 2) throw new Error('expected ls, status, or do command --key value');
  const args = {};
  for (let i = 0; i < flags.length; i += 2) {
    if (!/^--[a-z][a-z-]*$/.test(flags[i]) || Object.hasOwn(args, flags[i].slice(2))) throw new Error('invalid or repeated app argument');
    const key = flags[i].slice(2), value = flags[i + 1];
    args[key] = ['argv', 'props', 'confirmed', 'index'].includes(key) ? JSON.parse(value) : value;
  }
  validateAppCommand(name, args); return { name, args };
}
async function main() {
  if (['-V', '--version', 'version'].includes(process.argv[2])) { console.log('herdr-app 0.1.11'); return; }
  const root = process.env.SPIDER_HERDR_E2E_APP_ROOT;
  if (!root) throw new Error('owned fake app root required');
  const socket = socketPath(root, process.env.SPIDER_HERDR_E2E_APP_SOCKET, process.argv[2] === 'serve');
  if (process.argv[2] !== 'serve') {
    const argv = process.argv.slice(2), startedAt = Date.now();
    const { name, args } = cliArgs(argv);
    const trace = ownedPath(root, join(root, 'app-cli-timing.jsonl'), true);
    let ended = false;
    const record = (phase, extra = {}) => {
      const finishedAt = Date.now();
      appendFileSync(trace, JSON.stringify({ pid: process.pid, phase, argv, name, startedAt,
        ...(phase === 'started' ? {} : { finishedAt, durationMs: finishedAt - startedAt }), ...extra }) + '\n', { mode: 0o600 });
    };
    record('started');
    const signals = new Map(['SIGTERM', 'SIGINT', 'SIGHUP'].map(signal => [signal, () => {
      if (!ended) { ended = true; record('signalled', { signal }); }
      process.removeAllListeners(signal); process.kill(process.pid, signal);
    }]));
    for (const [signal, handler] of signals) process.once(signal, handler);
    try { console.log(JSON.stringify(await appRequest(socket, name, args))); ended = true; record('finished'); }
    catch (error) { ended = true; record('failed', { error: error instanceof Error ? error.message : String(error) }); throw error; }
    finally { for (const [signal, handler] of signals) process.removeListener(signal, handler); }
    return;
  }
  const configPath = ownedPath(root, process.argv[3]);
  const info = lstatSync(configPath);
  if (!info.isFile() || (info.mode & 0o077) || (process.getuid && info.uid !== process.getuid())) throw new Error('fake app config must be private');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  const env = config.env;
  if (!env || !env.HC_SESSION || env.HC_SESSION === 'default' || !isAbsolute(config.hcBinary)) throw new Error('isolated core required');
  for (const key of ['HC_SOCKET', 'XDG_STATE_HOME', 'XDG_CONFIG_HOME', 'HERDR_APP_HOME', 'TMPDIR', 'HOME']) ownedPath(root, env[key], key !== 'HC_SOCKET');
  if (!lstatSync(env.HC_SOCKET).isSocket()) throw new Error('owned core socket is not live');
  const hc = argv => new Promise((resolve, reject) => {
    // Do not let hc autostart after the isolated core disappears.
    try { if (!lstatSync(env.HC_SOCKET).isSocket()) throw new Error('owned core is down'); } catch (error) { reject(error); return; }
    execFile(config.hcBinary, argv, { env, timeout: 15000, maxBuffer: LIMIT }, (error, stdout, stderr) => {
      if (error) { reject(new Error(stderr || error.message)); return; }
      try { resolve(JSON.parse(stdout)); } catch { reject(new Error('malformed core JSON')); }
    });
  });
  const core = await hc(['server', 'status', '--json']);
  if (!core?.core?.id || (config.coreId && core.core.id !== config.coreId)) throw new Error('wrong isolated core identity');
  const boundary = createFakeAppBoundary({ hc,
    readLayout: async name => {
      if (!/^[a-z0-9_-]+$/.test(name)) throw new Error('unsafe layout name');
      return JSON.parse(readFileSync(ownedPath(root, join(env.HERDR_APP_HOME, 'layouts', `${name}.json`)), 'utf8'));
    },
    selectLayout: async name => {
      const path = ownedPath(root, join(env.HERDR_APP_HOME, 'settings.json'), true);
      let settings = {}; try { settings = JSON.parse(readFileSync(path, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('malformed owned app settings');
      if (settings.layout === name) return;
      const staging = ownedPath(root, `${path}.new`, true);
      writeFileSync(staging, JSON.stringify({ ...settings, layout: name }), { mode: 0o600 }); renameSync(staging, path);
    },
    selectTheme: async name => {
      if (!/^[a-z0-9_-]+$/.test(name)) throw new Error('unsafe theme name');
      JSON.parse(readFileSync(ownedPath(root, join(env.HERDR_APP_HOME, 'themes', `${name}.json`)), 'utf8'));
      const path = ownedPath(root, join(env.HERDR_APP_HOME, 'settings.json'), true);
      let settings = {}; try { settings = JSON.parse(readFileSync(path, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      const staging = `${path}.new`; writeFileSync(staging, JSON.stringify({ ...settings, theme: name }), { mode: 0o600 }); renameSync(staging, path);
    },
    record: (name, args, result) => appendFileSync(ownedPath(root, join(root, 'app-calls.jsonl'), true), JSON.stringify({ at: Date.now(), pid: process.pid, name, args, result }) + '\n', { mode: 0o600 }),
  });
  const server = serveBoundary(socket, boundary); await server.listen();
  console.log(JSON.stringify({ ready: true, socket, coreId: core.core.id, pid: process.pid }));
  let closing = false;
  const close = async () => { if (closing) return; closing = true; await server.close(); process.exit(0); };
  process.on('SIGTERM', close); process.on('SIGINT', close);
  process.stdin.on('end', close); process.stdin.resume();
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.log(JSON.stringify({ error: error.message })); process.exitCode = 1; });
}

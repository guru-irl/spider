#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { createServer } from 'node:http';
import { appendFileSync, chmodSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

function within(root, path, missing = false) {
  const suffix = relative(root, path);
  if (!suffix || isAbsolute(suffix) || suffix === '..' || suffix.startsWith(`..${sep}`)) throw new Error('counter fixture path leaves owned root');
  let cursor = path;
  while (cursor !== root) {
    try { if (lstatSync(cursor).isSymbolicLink()) throw new Error('counter fixture symlink refused'); }
    catch (error) { if (!missing || error.code !== 'ENOENT') throw error; }
    cursor = dirname(cursor);
  }
}
export function createCounterServer(options) {
  const root = resolve(options.root), scratch = resolve(process.env.SPIDER_TEST_FIXTURE_CHECKOUT ?? process.cwd(), '.spider/scratch');
  if (realpathSync(root) !== root || realpathSync(scratch) !== scratch) throw new Error('counter fixture root must not be a symlink');
  within(scratch, root);
  const stat = lstatSync(root);
  if (stat.mode & 0o077 || process.getuid && stat.uid !== process.getuid()) throw new Error('counter fixture root must be private');
  const socket = resolve(options.socket); within(root, socket, true);
  if (Buffer.byteLength(socket) > 103) throw new Error('counter fixture socket exceeds 103 bytes');
  if (options.logPath) within(root, resolve(options.logPath), true);
  const quota = options.body?.quota_snapshots?.premium_interactions;
  if (!quota || quota.token_based_billing !== true || !['credits_used', 'entitlement', 'remaining'].every(k => typeof quota[k] === 'number' && Number.isFinite(quota[k]) && quota[k] >= 0)) throw new Error('malformed synthetic counter fixture');
  const body = JSON.stringify(options.body);
  if (Buffer.byteLength(body) > 1024 * 1024) throw new Error('oversized synthetic counter fixture');
  let seq = 0, released = false, closing = false, held, ready;
  const firstRequest = new Promise(resolve => { ready = resolve; });
  const sockets = new Set();
  const server = createServer((request, response) => {
    if (request.method !== 'GET' || request.url !== '/copilot_internal/user' || Number(request.headers['content-length'] ?? 0) !== 0 || request.headers['transfer-encoding']) {
      response.writeHead(400, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: 'only the known counter request is supported' })); return;
    }
    const record = { seq: ++seq, method: request.method, path: request.url };
    if (options.logPath) appendFileSync(options.logPath, JSON.stringify(record) + '\n', { mode: 0o600 });
    const respond = () => { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(body); };
    if (seq === 1) { if (options.holdFirst) held = respond; ready(record); }
    options.onRequest?.(record);
    if (seq !== 1 || !options.holdFirst) respond();
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  return {
    firstRequest,
    listen: () => new Promise((resolve, reject) => { server.once('error', reject); server.listen(socket, () => { chmodSync(socket, 0o600); resolve(); }); }),
    release(expectedSeq) {
      if (released) throw new Error('duplicate release');
      if (expectedSeq !== 1 || !held || closing) throw new Error('counter first response is not held');
      released = true; const send = held; held = undefined; send();
    },
    async close() {
      if (closing) return; closing = true; held = undefined;
      for (const socket of sockets) socket.destroy();
      await new Promise(resolve => server.close(resolve));
    },
  };
}
async function main() {
  const configPath = process.argv[2];
  if (!configPath || !isAbsolute(configPath)) throw new Error('private counter fixture config required');
  const stat = lstatSync(configPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.mode & 0o077 || process.getuid && stat.uid !== process.getuid()) throw new Error('private counter fixture config required');
  const options = JSON.parse(readFileSync(configPath, 'utf8'));
  within(resolve(options.root), resolve(configPath));
  const server = createCounterServer({ ...options, onRequest: record => console.log(JSON.stringify({ type: 'counter-request', ...record })) });
  await server.listen(); console.log(JSON.stringify({ type: 'counter-ready', socket: options.socket, pid: process.pid }));
  let buffer = '';
  process.stdin.on('data', data => {
    buffer += data.toString('utf8');
    if (Buffer.byteLength(buffer) > 4096) { console.error('oversized counter control'); process.exitCode = 1; void server.close(); return; }
    while (buffer.includes('\n')) {
      const at = buffer.indexOf('\n'), line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
      try { const command = JSON.parse(line); if (command.op !== 'release' || command.seq !== 1 || Object.keys(command).some(k => !['op', 'seq'].includes(k))) throw new Error('unknown counter control'); server.release(command.seq); console.log(JSON.stringify({ type: 'counter-released', seq: command.seq })); }
      catch (error) { console.error(error.message); process.exitCode = 1; void server.close(); }
    }
  });
  const close = () => { void server.close(); };
  process.stdin.on('end', close); process.stdin.resume(); process.on('SIGTERM', close); process.on('SIGINT', close);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1; });

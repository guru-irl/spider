// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { chmod, lstat, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { connect, createServer, type Socket } from 'node:net';
import { randomUUID } from 'node:crypto';
import { isCoreAvailable } from '../client/liveness.js';
import { HerdrError } from '../client/parse.js';
import { privateDirectory, readPrivateJson, withProcessLock, writePrivateJson } from '../sessions/registry.js';
import { encodePaneServiceReply, encodePaneServiceRequest, paneAddress, paneId, paneRecord, paneText, parsePaneServiceReply, parsePaneServiceRequest, PANE_REPLY_LIMIT } from './codec.js';
import type { PaneService } from './service.js';
import type { PaneServiceConnectOptions, PaneServiceReply, PaneServiceRequest } from './types.js';
import type { TerminalAddress } from '../contracts.js';
const code = (error: unknown) => (error as NodeJS.ErrnoException)?.code;
async function safeRoot(root: string, create: boolean): Promise<void> {
  if (!isAbsolute(root)) throw new HerdrError('unsafe-state-path', 'Service root must be absolute');
  for (let path = root;; path = dirname(path)) {
    try {
      const info = await lstat(path);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new HerdrError('unsafe-state-path', 'Service cannot traverse symlink parents');
      if (path === root && ((info.mode & 0o077) || process.getuid && info.uid !== process.getuid())) throw new HerdrError('unsafe-state-path', 'Service root must be private and owned by this user');
    } catch (error) { if (code(error) !== 'ENOENT') throw error; }
    if (dirname(path) === path) break;
  }
  if (create) await privateDirectory(root);
}
async function safeSocket(path: string): Promise<boolean> {
  try {
    const info = await lstat(path);
    if (!info.isSocket() || info.isSymbolicLink() || (info.mode & 0o077) || process.getuid && info.uid !== process.getuid()) throw new HerdrError('unsafe-socket', 'Service socket must be private and owned by this user');
    return true;
  } catch (error) { if (code(error) === 'ENOENT') return false; throw error; }
}
function rpc(root: string, request: PaneServiceRequest): Promise<PaneServiceReply> {
  return new Promise((resolve, reject) => {
    const socket = connect(join(root, 'service.sock')); let bytes = Buffer.alloc(0); let settled = false;
    const finish = (error?: unknown, reply?: PaneServiceReply) => {
      if (settled) return; settled = true; socket.destroy();
      if (error) reject(error); else resolve(reply!);
    };
    socket.setTimeout(5000, () => finish(new HerdrError('service-timeout', 'Presentation service deadline exceeded')));
    socket.on('connect', () => socket.write(`${encodePaneServiceRequest(request)}\n`));
    socket.on('error', finish);
    socket.on('end', () => { if (!settled) finish(new HerdrError('service-unavailable', 'Presentation service closed its reply')); });
    socket.on('data', chunk => {
      if (bytes.length + chunk.length > PANE_REPLY_LIMIT) { finish(new HerdrError('service-too-large', 'Service reply exceeds 1 MiB')); return; }
      bytes = Buffer.concat([bytes, chunk]); const end = bytes.indexOf(10); if (end < 0) return;
      try { finish(undefined, parsePaneServiceReply(JSON.parse(bytes.subarray(0, end).toString('utf8')))); } catch (error) { finish(error); }
    });
  });
}
export async function servePaneRequests(root: string, service: PaneService): Promise<{ close(): Promise<void> }> {
  await safeRoot(root, true); const path = join(root, 'service.sock');
  if (Buffer.byteLength(path) > 103) throw new HerdrError('unsafe-socket', 'Service socket path is too long');
  // A stale endpoint is not permission to unlink a possibly active owner.
  if (await safeSocket(path)) throw new HerdrError('service-occupied', 'Presentation service socket already exists');
  const clients = new Set<Socket>();
  const server = createServer(socket => {
    clients.add(socket); socket.once('close', () => clients.delete(socket)); socket.on('error', () => {});
    socket.setTimeout(5000, () => socket.destroy()); let bytes = Buffer.alloc(0); let submitted = false;
    socket.on('data', chunk => {
      if (submitted || bytes.length + chunk.length > PANE_REPLY_LIMIT) { socket.destroy(); return; }
      bytes = Buffer.concat([bytes, chunk]); const end = bytes.indexOf(10); if (end < 0) return;
      submitted = true;
      if (end !== bytes.length - 1) { socket.destroy(); return; }
      let request: PaneServiceRequest;
      try { request = parsePaneServiceRequest(JSON.parse(bytes.subarray(0, end).toString('utf8'))); } catch { socket.destroy(); return; }
      void service.request(request).then(reply => socket.end(`${encodePaneServiceReply(reply)}\n`), () => socket.destroy());
    });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(path, resolve); });
  await chmod(path, 0o600); const owned = await lstat(path);
  return { async close() {
    for (const socket of clients) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
    try { const now = await lstat(path); if (now.ino === owned.ino && now.dev === owned.dev) await unlink(path); } catch (error) { if (code(error) !== 'ENOENT') throw error; }
  } };
}
interface Claim { version: 1; coreId: string; socket: string; sessionNamespace: string; operationId: string; state: 'claimed' | 'uncertain' | 'acknowledged'; address: TerminalAddress | null }
function claim(value: unknown): Claim {
  const row = paneRecord(value, ['version', 'coreId', 'socket', 'sessionNamespace', 'operationId', 'state', 'address']);
  if (row.version !== 1 || !['claimed', 'uncertain', 'acknowledged'].includes(String(row.state))) throw new HerdrError('invalid-service-claim', 'Invalid service claim');
  return { version: 1, coreId: paneId(row.coreId), socket: paneText(row.socket), sessionNamespace: paneText(row.sessionNamespace), operationId: paneId(row.operationId), state: row.state as Claim['state'], address: row.address === null ? null : paneAddress(row.address) };
}
export async function connectPaneService(options: PaneServiceConnectOptions): Promise<PaneService> {
  const { root, identity } = options;
  await safeRoot(root, false);
  if (!await isCoreAvailable({ HC_SOCKET: identity.socket })) throw new HerdrError('core-unavailable', 'Selected local core is unavailable');
  const file = join(root, 'service.json');
  const load = async () => {
    try { const info = await lstat(file); if (!info.isFile() || info.isSymbolicLink() || process.getuid && info.uid !== process.getuid()) throw new HerdrError('unsafe-state-file', 'Service claim must be owned by this user'); }
    catch (error) { if (code(error) !== 'ENOENT') throw error; }
    const value = await readPrivateJson(file); const row = value === null ? null : claim(value);
    if (row && (row.coreId !== identity.coreId || row.socket !== identity.socket || row.sessionNamespace !== identity.sessionNamespace)) throw new HerdrError('core-mismatch', 'Service core identity changed'); return row; };
  const client = (): PaneService => {
    let stopped = false;
    return { request(request) { if (stopped) return Promise.reject(new HerdrError('service-stopped', 'Service connection stopped')); return rpc(root, request); }, reconcile: async () => {}, stop: async () => { stopped = true; } };
  };
  async function existing(row: Claim | null): Promise<boolean> {
    if (!row || !await safeSocket(join(root, 'service.sock'))) return false;
    if (row.address) {
      const helper = await options.probeHelper(row.address);
      if (helper.address !== row.address || !helper.address.startsWith(`${identity.coreId}/`) || helper.labels['spider.kind'] !== 'pane-service' || helper.parent !== null) throw new HerdrError('service-identity', 'Service helper identity does not match');
      if (helper.state === 'finished') return false;
    }
    // Only an existing private owner can claim a reply after a lost launch response.
    await rpc(root, { version: 1, op: 'snapshot', operationId: randomUUID() }); return true;
  }
  const before = await load();
  if (!options.startIfMissing) { if (await existing(before)) return client(); throw new HerdrError('service-unavailable', 'Presentation service unavailable'); }
  await safeRoot(root, true);
  return withProcessLock(root, 'pane-service', async () => {
    const row = await load(); if (await existing(row)) return client();
    if (row) {
      if (!row.address || row.state !== 'acknowledged') throw new HerdrError('service-uncertain', 'Previous service launch is uncertain; refusing duplicate');
      if (!await isCoreAvailable({ HC_SOCKET: identity.socket })) throw new HerdrError('core-unavailable', 'Selected local core is unavailable');
      const helper = await options.probeHelper(row.address);
      if (helper.address !== row.address || !helper.address.startsWith(`${identity.coreId}/`) || helper.labels['spider.kind'] !== 'pane-service' || helper.parent !== null || helper.state !== 'finished') throw new HerdrError('service-uncertain', 'Previous helper completion is unproved; refusing duplicate');
      const socketPath = join(root, 'service.sock');
      if (await safeSocket(socketPath)) {
        const before = await lstat(socketPath);
        if (await isCoreAvailable({ HC_SOCKET: socketPath })) throw new HerdrError('service-occupied', 'A presentation service is still listening');
        const after = await lstat(socketPath);
        if (before.ino !== after.ino || before.dev !== after.dev) throw new HerdrError('service-occupied', 'Service socket identity changed');
        await unlink(socketPath);
      }
    }
    const next: Claim = { version: 1, ...identity, operationId: randomUUID(), state: 'claimed', address: null };
    await writePrivateJson(file, next);
    try {
      const address = await options.launchHelper(next.operationId);
      await writePrivateJson(file, { ...next, state: 'acknowledged', address });
      if (!await existing({ ...next, state: 'acknowledged', address })) throw new HerdrError('service-unavailable', 'Service launch has not published a socket');
      return client();
    } catch (error) { await writePrivateJson(file, { ...next, state: 'uncertain', address: null }); throw error; }
  });
}

// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { chmod, mkdir, mkdtemp, rm, stat, symlink, lstat } from 'node:fs/promises';
import { createServer, connect } from 'node:net';
import { join } from 'node:path';
import { paths } from '@spider/db-core';
import { afterEach, expect, test, vi } from 'vitest';
import { connectPaneService, servePaneRequests } from '../panes/socket.js';
import type { PaneService } from '../panes/service.js';
import type { PaneServiceConnectOptions } from '../panes/types.js';
import type { TerminalAddress } from '../contracts.js';
vi.mock('node:fs/promises', async original => { const actual = await original<typeof import('node:fs/promises')>(); return { ...actual, lstat: vi.fn(actual.lstat) }; });
const actualLstat = vi.mocked(lstat).getMockImplementation()!;
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { vi.mocked(lstat).mockImplementation(actualLstat); for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture() {
  const base = join(paths.scratch('worktree', process.cwd()), 'b3', 'socket'); await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, 's-')); cleanup.push(() => rm(root, { recursive: true, force: true }));
  const core = createServer(s => s.end()); const socket = join(root, 'c.sock');
  await new Promise<void>(r => core.listen(socket, r)); cleanup.push(() => new Promise<void>(r => core.close(() => r())));
  const request = vi.fn(async () => ({ version: 1 as const, kind: 'snapshot' as const, complete: true, omittedRows: 0, revision: 0, machines: [], presentations: [], rows: [], targetFacts: {} }));
  const service: PaneService = { request, reconcile: async () => {}, stop: vi.fn(async () => {}) };
  const stateRoot = join(root, 'panes');
  let running: { close(): Promise<void> } | null = null; let currentAddress: TerminalAddress | null = null; const ended = new Set<TerminalAddress>(); let next = 0;
  const starts: Promise<void>[] = [];
  cleanup.push(async () => { await Promise.all(starts); await running?.close(); });
  const launchHelper = vi.fn(async () => {
    currentAddress = `core-local/t${++next}` as TerminalAddress;
    starts.push(new Promise<void>((resolve, reject) => setTimeout(() => {
      void servePaneRequests(stateRoot, service).then(server => { running = server; resolve(); }, reject);
    }, 100)));
    return currentAddress;
  });
  const probeHelper = vi.fn(async (address: TerminalAddress) => ({ address, parent: null, labels: { 'spider.kind': 'pane-service' }, state: ended.has(address) ? 'finished' as const : 'live' as const, status: null, exitCode: null, reason: null, signal: null, finishedAt: null }));
  const options: PaneServiceConnectOptions = { root: stateRoot, identity: { coreId: 'core-local' as never, socket, sessionNamespace: 'test' }, startIfMissing: true, launchHelper, probeHelper };
  return { root, options, service, launchHelper, probeHelper, stopHelper: async () => { if (currentAddress) ended.add(currentAddress); await running?.close(); } };
}
test('two clients share one service claim', async () => {
  const f = await fixture(); const [a, b] = await Promise.all([connectPaneService(f.options), connectPaneService(f.options)]);
  expect(f.launchHelper).toHaveBeenCalledTimes(1);
  expect(await a.request({ version: 1, op: 'snapshot', operationId: 's1' })).toEqual(await b.request({ version: 1, op: 'snapshot', operationId: 's2' }));
  expect((await stat(join(f.options.root, 'service.sock'))).mode & 0o777).toBe(0o600);
  await a.stop(); expect(f.service.stop).not.toHaveBeenCalled();
});
test('lost service launch reply does not relaunch', async () => {
  const f = await fixture(); f.launchHelper.mockImplementation(async () => { throw Error('lost'); });
  await expect(connectPaneService(f.options)).rejects.toThrow(); await expect(connectPaneService(f.options)).rejects.toThrow(/uncertain/);
  expect(f.launchHelper).toHaveBeenCalledTimes(1);
});
test('proved ended helper can restart once on the still-live selected core', async () => {
  const f = await fixture(); await connectPaneService(f.options); await f.stopHelper();
  const [a, b] = await Promise.all([connectPaneService(f.options), connectPaneService(f.options)]);
  expect(f.launchHelper).toHaveBeenCalledTimes(2); expect(await a.request({ version: 1, op: 'snapshot', operationId: 's1' })).toEqual(await b.request({ version: 1, op: 'snapshot', operationId: 's2' }));
});
test('acknowledged helper exiting before readiness can restart', async () => {
  const f = await fixture();
  f.launchHelper.mockImplementationOnce(async () => 'core-local/early' as TerminalAddress);
  f.probeHelper.mockImplementation(async address => ({ address, parent: null, labels: { 'spider.kind': 'pane-service' }, state: address === 'core-local/early' ? 'finished' as const : 'live' as const, status: null, exitCode: null, reason: null, signal: null, finishedAt: null }));
  await expect(connectPaneService(f.options)).rejects.toThrow(/exited/);
  const client = await connectPaneService(f.options);
  expect((await client.request({ version: 1, op: 'snapshot', operationId: 'after-exit' })).kind).toBe('snapshot');
  expect(f.launchHelper).toHaveBeenCalledTimes(2);
});
test('foreign-owned helper claim refuses before probe or launch', async () => {
  const f = await fixture(); await connectPaneService(f.options); f.probeHelper.mockClear();
  vi.mocked(lstat).mockImplementation(async (...args) => { const info = await actualLstat(...args); return String(args[0]).endsWith('/service.json') ? Object.assign(info, { uid: Number(process.getuid?.()) + 1 }) : info; });
  await expect(connectPaneService(f.options)).rejects.toThrow(/owned/); expect(f.probeHelper).not.toHaveBeenCalled(); expect(f.launchHelper).toHaveBeenCalledTimes(1);
});
test('doctor connect never starts helper', async () => {
  const f = await fixture(); await expect(connectPaneService({ ...f.options, startIfMissing: false })).rejects.toThrow(/unavailable/);
  expect(f.launchHelper).not.toHaveBeenCalled(); await expect(stat(f.options.root)).rejects.toMatchObject({ code: 'ENOENT' });
});
test('changed core identity and bad ownership refuse before launch', async () => {
  const f = await fixture(); await connectPaneService(f.options);
  await expect(connectPaneService({ ...f.options, identity: { ...f.options.identity, coreId: 'core-new' as never } })).rejects.toThrow(/identity/);
  expect(f.launchHelper).toHaveBeenCalledTimes(1);
  await chmod(f.options.root, 0o777); await expect(connectPaneService(f.options)).rejects.toThrow(/private/);
});
test('symlink socket parents refuse', async () => {
  const f = await fixture(); const linked = join(f.root, 'link'); await symlink(f.root, linked);
  await expect(connectPaneService({ ...f.options, root: join(linked, 'panes') })).rejects.toThrow(/symlink/); expect(f.launchHelper).not.toHaveBeenCalled();
});
test('oversized socket frames never reach service policy', async () => {
  const f = await fixture(); await connectPaneService(f.options); vi.mocked(f.service.request).mockClear();
  await new Promise<void>((resolve, reject) => { const s = connect(join(f.options.root, 'service.sock')); s.on('error', () => {}); s.on('close', () => resolve()); s.on('connect', () => s.write('x'.repeat(1024 * 1024 + 1))); s.setTimeout(2000, () => { s.destroy(); reject(Error('frame not refused')); }); });
  expect(f.service.request).not.toHaveBeenCalled();
});

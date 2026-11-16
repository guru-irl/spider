// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { afterEach, expect, test, vi } from 'vitest';
import { chmod, mkdtemp, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { PANE_ENDPOINT_BOOTSTRAP } from '../../../host/src/herdr/pane-installation.js';
import { tmpdir } from 'node:os';
import type { CoreId } from '../contracts.js';
import type { MachineChoice, PaneInventoryPage } from '../panes/types.js';
import { createPaneInventoryCache, createRemotePaneInventoryReader, readRemotePaneInventory, type PaneInventoryPorts, type RemoteInventorySnapshot } from '../panes/inventory.js';

const machine: MachineChoice = { key: 'box-1.invalid', alias: 'box-1.invalid', label: 'box-1.invalid', coreId: 'core-1' as CoreId, machineId: 'machine-1', state: 'connected' };
const row = { sessionId: 'session-1', generation: 'gen-1', name: 'Builder', owner: null, target: null, status: 'working', updatedAt: 17, machineKey: 'core-1', unavailableReason: 'not-in-hc', children: [], consoles: [] } as const;
const page = { version: 1, rows: [row], next: null, complete: true } as unknown as PaneInventoryPage;
const cachedPage = { machineKey: machine.key, coreId: machine.coreId, updatedAt: 10, complete: true, stale: false, rows: page.rows } as RemoteInventorySnapshot;
function ports(): PaneInventoryPorts {
  return { readPage: vi.fn(async () => page), readCache: vi.fn(async () => null), writeCache: vi.fn(async () => {}), clock: () => Date.now() };
}
afterEach(() => vi.useRealTimers());

test('hand started box agent is discovered by actual session name', async () => {
  const p = ports(); const result = await readRemotePaneInventory(machine, null, p);
  expect(result.rows[0].name).toBe('Builder');
  expect(result.rows[0]).toMatchObject({ machineKey: 'box-1.invalid', target: null, unavailableReason: 'not-in-hc' });
});
test('inventory rejects another core and invalid source pages', async () => {
  const p = ports();
  const bad = { ...row, owner: { sessionId: 'session-1', generation: 'gen-1', terminal: { coreId: 'core-other', terminalId: 't7', address: 'core-other/t7', socket: '/home/example/core.sock', sessionNamespace: 'fixture' }, cwd: '/home/example', sessionFile: null, name: 'Builder' }, target: { coreId: 'core-other', terminalId: 't7', address: 'core-other/t7', createdMs: 1, identityLabels: {}, alias: 'box-1.invalid', machineId: 'machine-1', kind: 'session', sessionId: 'session-1', generation: 'gen-1', homeEpoch: null, runId: null, consoleId: null, name: 'Builder', cwd: null }, unavailableReason: null };
  vi.mocked(p.readPage).mockResolvedValue({ ...page, rows: [bad] });
  const result = await readRemotePaneInventory(machine, null, p);
  expect(result.complete).toBe(false); expect(result.rows).toEqual([]);
  expect(p.writeCache).not.toHaveBeenCalled();
});
test('mixed source cores reject the whole page and retain the last verified cache', async () => {
  const p = ports(); vi.mocked(p.readCache).mockResolvedValue({ updatedAt: 10, page: cachedPage });
  vi.mocked(p.readPage).mockResolvedValue({ ...page, rows: [row, { ...row, sessionId: 'session-2', machineKey: 'core-other' }] });
  const result = await readRemotePaneInventory(machine, null, p);
  expect(result.complete).toBe(false); expect(result.rows).toHaveLength(1);
  expect(result.rows[0]).toMatchObject({ sessionId: 'session-1', machineKey: 'box-1.invalid', status: 'unreachable' });
  expect(p.writeCache).not.toHaveBeenCalled();
});
test('a reused alias cannot attribute cached display-only rows to another core', async () => {
  const p = ports(); let stored: { updatedAt: number; page: RemoteInventorySnapshot } | null = null;
  vi.mocked(p.writeCache).mockImplementation(async (_key, saved, updatedAt) => { stored = { page: saved, updatedAt }; });
  vi.mocked(p.readCache).mockImplementation(async () => stored);
  expect((await readRemotePaneInventory(machine, null, p)).rows).toHaveLength(1);
  const result = await readRemotePaneInventory({ ...machine, coreId: 'core-new' as CoreId, state: 'disconnected' }, null, p);
  expect(result.complete).toBe(false); expect(result.rows).toEqual([]);
});
test('a null core choice reads no source page or cache', async () => {
  const p = ports(); vi.mocked(p.readCache).mockResolvedValue({ updatedAt: 10, page: cachedPage });
  const result = await readRemotePaneInventory({ ...machine, coreId: null, state: 'disconnected' }, null, p);
  expect(result.rows).toEqual([]); expect(result.complete).toBe(false);
  expect(p.readPage).not.toHaveBeenCalled(); expect(p.readCache).not.toHaveBeenCalled();
});
test('timeout retains cached unreachable row', async () => {
  vi.useFakeTimers(); const p = ports(); vi.mocked(p.readPage).mockImplementation(() => new Promise(() => {}));
  vi.mocked(p.readCache).mockResolvedValue({ updatedAt: 10, page: cachedPage });
  const pending = readRemotePaneInventory(machine, null, p); await vi.advanceTimersByTimeAsync(5000);
  const result = await pending;
  expect(result.complete).toBe(false); expect(result.rows[0].status).toBe('unreachable');
  expect(result.rows[0].sessionId).toBe('session-1'); expect(p.writeCache).not.toHaveBeenCalled();
});
test('refresh is single flight and unreachable machines back off', async () => {
  vi.useFakeTimers(); const p = ports(); vi.mocked(p.readPage).mockImplementation(() => new Promise(() => {}));
  const first = readRemotePaneInventory(machine, null, p), second = readRemotePaneInventory(machine, null, p);
  await vi.advanceTimersByTimeAsync(5000); await Promise.all([first, second]);
  await readRemotePaneInventory(machine, null, p);
  expect(p.readPage).toHaveBeenCalledTimes(1);
});
test('a timed-out read can recover after it settles and backoff expires', async () => {
  vi.useFakeTimers(); const p = ports(); let finish!: (value: unknown) => void;
  vi.mocked(p.readPage).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValue(page);
  const first = readRemotePaneInventory(machine, null, p); await vi.advanceTimersByTimeAsync(5000); await first;
  finish(page); await vi.advanceTimersByTimeAsync(5000);
  const recovered = await readRemotePaneInventory(machine, null, p);
  expect(recovered.complete).toBe(true); expect(recovered.rows[0].name).toBe('Builder');
  expect(p.readPage).toHaveBeenCalledTimes(2);
});
test('a late page after the deadline never starts another page or writes cache', async () => {
  vi.useFakeTimers(); const p = ports(); let finish!: (value: unknown) => void;
  vi.mocked(p.readPage).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValue(page);
  const pending = readRemotePaneInventory(machine, null, p); await vi.advanceTimersByTimeAsync(5000); await pending;
  finish({ ...page, next: 'cursor-1' }); await vi.advanceTimersByTimeAsync(1);
  expect(p.readPage).toHaveBeenCalledTimes(1); expect(p.writeCache).not.toHaveBeenCalled();
});
test('inventory is paged and body free', async () => {
  const p = ports(); vi.mocked(p.readPage).mockResolvedValue({ ...page, rows: Array(257).fill(row) });
  const result = await readRemotePaneInventory(machine, null, p);
  expect(result.complete).toBe(false); expect(result.rows).toEqual([]);
  expect(p.writeCache).not.toHaveBeenCalled();
});
test('cache publishes private derived rows atomically', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pane-inventory-'));
  try {
    const cache = createPaneInventoryCache(root);
    const saved = { ...cachedPage, updatedAt: 123 };
    await cache.writeCache(machine.key, saved, 123);
    expect(await cache.readCache(machine.key)).toEqual({ updatedAt: 123, page: saved });
    expect((await stat(join(root, 'remote-agents.json'))).mode & 0o777).toBe(0o600);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('an insecure cache root refuses before publication', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pane-inventory-'));
  try {
    await chmod(root, 0o755); const cache = createPaneInventoryCache(root);
    await expect(cache.writeCache(machine.key, cachedPage, 10)).rejects.toThrow();
    await expect(stat(join(root, 'remote-agents.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await stat(root)).mode & 0o777).toBe(0o755);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('a complete refresh walks every page and stores one assembled snapshot', async () => {
  const p = ports(); const first = { ...page, next: 'cursor-1' }, second = { ...page, rows: [{ ...row, sessionId: 'session-2' }], next: null };
  vi.mocked(p.readPage).mockImplementation(async (_machine, cursor) => cursor === null ? first : second);
  const result = await readRemotePaneInventory(machine, null, p);
  expect(result.complete).toBe(true); expect(result.rows.map(r => r.sessionId)).toEqual(['session-1', 'session-2']);
  expect(p.readPage).toHaveBeenCalledTimes(2); expect(p.writeCache).toHaveBeenCalledTimes(1);
});
test('a mid-walk failure keeps the last complete snapshot stale', async () => {
  const p = ports(); vi.mocked(p.readCache).mockResolvedValue({ updatedAt: 10, page: cachedPage });
  vi.mocked(p.readPage).mockImplementation(async (_machine, cursor) => { if (cursor === null) return { ...page, rows: [{ ...row, sessionId: 'new-session' }], next: 'cursor-1' }; throw new Error('disconnected'); });
  const result = await readRemotePaneInventory(machine, null, p);
  expect(result.complete).toBe(false); expect(result.rows.map(r => r.sessionId)).toEqual(['session-1']);
  expect(result.rows[0].status).toBe('unreachable'); expect(p.writeCache).not.toHaveBeenCalled();
});
test('successive refreshes never mix rows from separate snapshots', async () => {
  const p = ports(); let generation = 1;
  vi.mocked(p.readPage).mockImplementation(async (_machine, cursor) => ({ version: 1, rows: [{ ...row, sessionId: `g${generation}-${cursor === null ? 'a' : 'b'}` }], next: cursor === null ? 'cursor-next' : null, complete: true }));
  const first = await readRemotePaneInventory(machine, null, p); generation = 2;
  const second = await readRemotePaneInventory(machine, null, p);
  expect(first.rows.map(r => r.sessionId)).toEqual(['g1-a', 'g1-b']);
  expect(second.rows.map(r => r.sessionId)).toEqual(['g2-a', 'g2-b']);
  expect(p.writeCache).toHaveBeenCalledTimes(2);
});
test('an over-bound inventory stays incomplete and never replaces the cache', async () => {
  const p = ports();
  vi.mocked(p.readPage).mockImplementation(async (_machine, cursor) => {
    const index = cursor === null ? 0 : Number(cursor.slice(1));
    return { version: 1, rows: Array.from({ length: 256 }, (_, i) => ({ ...row, sessionId: `session-${index}-${i}` })), next: index < 17 ? `c${index + 1}` : null, complete: true };
  });
  const result = await readRemotePaneInventory(machine, null, p);
  expect(result.complete).toBe(false); expect(result.rows.length).toBeGreaterThan(0); expect(result.rows.length).toBeLessThanOrEqual(4096);
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(1024 * 1024); expect(p.writeCache).not.toHaveBeenCalled();
});
test('aggregate byte limit includes the machine key and stale-row expansion', async () => {
  const longKey = 'a'.repeat(16000) + '.invalid';
  const longMachine = { ...machine, key: longKey, alias: longKey, label: longKey };
  const p = ports(); vi.mocked(p.readPage).mockResolvedValue({ ...page, rows: Array.from({ length: 100 }, (_, i) => ({ ...row, sessionId: `session-${i}` })) });
  const result = await readRemotePaneInventory(longMachine, null, p);
  expect(result.complete).toBe(false); expect(result.rows.length).toBeGreaterThan(0);
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(1024 * 1024);
  expect(p.writeCache).not.toHaveBeenCalled();
});
test('inventory uses configured Node and endpoint with a build handshake and bounded argv', async () => {
  const digest = 'a'.repeat(64), exec = vi.fn(async (_on: string, argv: readonly string[]) => {
    const request = JSON.parse(argv.at(-1)!);
    return Buffer.from(JSON.stringify(request.op === 'handshake' ? { version: 1, op: 'handshake', protocol: 1, buildDigest: digest } : { version: 1, op: 'list', page }));
  });
  const resolveMachine = vi.fn(async () => ({ on: 'box-1.invalid', coreId: machine.coreId!, nodePath: '/home/example/bin/node', endpointPath: '/home/example/runtime/pane-endpoint.mjs' }));
  const read = createRemotePaneInventoryReader({ exec, resolveMachine, buildDigest: digest });
  expect(await read(machine, null)).toEqual(page);
  expect(exec).toHaveBeenCalledTimes(2);
  expect(exec.mock.calls[0][0]).toBe('box-1.invalid');
  expect(exec.mock.calls[0][1].slice(0, 3)).toEqual(['/home/example/bin/node', '-e', PANE_ENDPOINT_BOOTSTRAP]);
  expect(JSON.parse(exec.mock.calls[0][1].at(-1)!)).toEqual({ version: 1, op: 'handshake', protocol: 1, buildDigest: digest });
  expect(JSON.parse(exec.mock.calls[1][1].at(-1)!)).toEqual({ version: 1, op: 'list', cursor: null });
  expect(resolveMachine).toHaveBeenCalledTimes(2);
});
test('changed machine identity or incompatible handshake refuses without local fallback', async () => {
  const digest = 'a'.repeat(64), exec = vi.fn(async () => Buffer.from(JSON.stringify({ version: 1, op: 'handshake', protocol: 1, buildDigest: 'b'.repeat(64) })));
  const read = createRemotePaneInventoryReader({ exec, resolveMachine: async () => ({ on: 'box-1.invalid', coreId: machine.coreId!, nodePath: '/home/example/bin/node', endpointPath: '/home/example/pane.mjs' }), buildDigest: digest });
  await expect(read(machine, null)).rejects.toThrow(); expect(exec).toHaveBeenCalledTimes(1);
  const mismatch = createRemotePaneInventoryReader({ exec, resolveMachine: async () => ({ on: 'box-1.invalid', coreId: 'core-other' as CoreId, nodePath: '/home/example/bin/node', endpointPath: '/home/example/pane.mjs' }), buildDigest: digest });
  await expect(mismatch(machine, null)).rejects.toThrow(); expect(exec).toHaveBeenCalledTimes(1);
});
test('a disconnected machine never starts a remote read', async () => {
  const p = ports(); vi.mocked(p.readCache).mockResolvedValue({ updatedAt: 10, page: cachedPage });
  const result = await readRemotePaneInventory({ ...machine, state: 'disconnected' }, null, p);
  expect(result.rows[0].status).toBe('unreachable'); expect(result.complete).toBe(false);
  expect(p.readPage).not.toHaveBeenCalled();
});

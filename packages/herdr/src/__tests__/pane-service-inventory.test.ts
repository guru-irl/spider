// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { afterEach, expect, test, vi } from 'vitest';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createPaneServiceInventory } from '../panes/inventory.js';
import type { MachineChoice, PaneAgentRow, PaneInventoryPage } from '../panes/types.js';
const machine: MachineChoice = { key: 'box-1.invalid', alias: 'box-1.invalid', label: 'box-1.invalid', coreId: 'core-1' as never, machineId: null, state: 'connected' };
const row: PaneAgentRow = { sessionId: 'session-1' as never, generation: null, name: 'Builder', owner: null, target: null, status: 'working', updatedAt: 17, machineKey: machine.key, unavailableReason: 'not-in-hc', children: [], consoles: [] };
const page: PaneInventoryPage = { version: 1, rows: [row], next: null, complete: true };
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function root() { const path = await mkdtemp(join(tmpdir(), 'pane-service-inventory-')); roots.push(path); return path; }
test('service inventory survives restart and marks a disconnected machine unreachable without a read', async () => {
  const path = await root(), readPage = vi.fn(async () => page), signal = new AbortController().signal;
  const read = createPaneServiceInventory({ root: path, readPage, clock: () => 100 });
  expect(await read(machine, signal)).toMatchObject({ complete: true, stale: false, rows: [{ machineKey: machine.key, status: 'working' }] });
  expect((await stat(join(path, 'remote-agents.json'))).mode & 0o777).toBe(0o600);
  const restarted = createPaneServiceInventory({ root: path, readPage, clock: () => 200 });
  expect(await restarted({ ...machine, state: 'disconnected' }, signal)).toMatchObject({ complete: false, stale: true, rows: [{ sessionId: 'session-1', status: 'unreachable', machineKey: machine.key }] });
  expect(readPage).toHaveBeenCalledTimes(1);
  expect(await restarted({ ...machine, coreId: 'replacement-core' as never, state: 'disconnected' }, signal)).toMatchObject({ complete: false, stale: true, rows: [] });
});
test('service inventory walks 257 projected rows and forwards the selected cancellation signal', async () => {
  const path = await root(), signal = new AbortController().signal;
  const readPage = vi.fn(async (_machine: MachineChoice, selected: AbortSignal, cursor?: string | null): Promise<PaneInventoryPage> => {
    expect(selected).toBe(signal);
    return { ...page, rows: cursor === null ? Array.from({ length: 256 }, (_, i) => ({ ...row, sessionId: `session-${i}` as never })) : [{ ...row, sessionId: 'session-256' as never }], next: cursor === null ? 'next-page' : null };
  });
  const read = createPaneServiceInventory({ root: path, readPage, clock: () => 100 });
  const result = await read(machine, signal);
  expect(result.complete).toBe(true); expect(result.rows).toHaveLength(257);
  const restarted = createPaneServiceInventory({ root: path, readPage, clock: () => 200 });
  const stale = await restarted({ ...machine, state: 'disconnected' }, signal);
  expect(stale.rows).toHaveLength(257); expect(stale.rows.every(row => row.status === 'unreachable')).toBe(true);
  expect(readPage).toHaveBeenCalledTimes(2);
});
test('service inventory never caches a page projected from another machine', async () => {
  const read = createPaneServiceInventory({ root: await root(), readPage: async () => ({ ...page, rows: [{ ...row, machineKey: 'box-2.invalid' }] }), clock: () => 100 });
  expect(await read(machine, new AbortController().signal)).toMatchObject({ complete: false, stale: true, rows: [] });
});

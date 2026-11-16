// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { paths } from '@spider/db-core';
import { afterEach, expect, test, vi } from 'vitest';
import { HerdrError } from '../client/parse.js';
import { openPane, awaitPanePresented, type PaneOpenPorts } from '../panes/open.js';
import { createPanePlacementStore } from '../panes/store.js';
import { parseMachineChoice, parsePaneOpenIntent, parsePaneTarget } from '../panes/codec.js';
import type { AppClient, AppPaneInspection, OwnerPlacement, TerminalAddress, HcClient } from '../contracts.js';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function paneOpenFixture(local = false, split: 'right' | 'down' | null = null, proxyOperation = 'pane-op1') {
  const base = join(paths.scratch('worktree', process.cwd()), 'b3', 'open'); await mkdir(base, { recursive: true }); const root = await mkdtemp(join(base, 's-')); roots.push(root);
  const store = createPanePlacementStore(join(root, 'roam', 'placement'));
  const anchor = { space: 'space-1', tab: 'tab-1', pane: 'anchor-1' } as OwnerPlacement;
  const placements = new Map<TerminalAddress, OwnerPlacement>([['core-local/t1' as TerminalAddress, anchor]]); const placeholders = new Map<string, OwnerPlacement>();
  let focus: OwnerPlacement | null = anchor; const calls: { name: string; args: Record<string, unknown> }[] = [];
  const machine = parseMachineChoice({ key: local ? 'this-computer' : 'box-1.invalid', alias: local ? null : 'box-1.invalid', label: local ? 'This computer' : 'box-1.invalid', coreId: local ? 'core-local' : 'core-remote', machineId: null, state: 'connected' });
  const intent = parsePaneOpenIntent({ operationId: 'op1', space: 'space-1', place: split ?? 'tab', anchor: split ? anchor : null, program: { kind: 'shell' } });
  const target = parsePaneTarget({ coreId: machine.coreId, terminalId: 't7', address: `${machine.coreId}/t7`, createdMs: 17, identityLabels: { 'spider.pane-operation': 'op1' }, alias: machine.alias, machineId: null, kind: 'terminal', sessionId: null, generation: null, homeEpoch: null, runId: null, consoleId: null, name: null, cwd: '/home/example/work' });
  const app = {
    listSpaces: async () => [{ id: anchor.space, name: 'Example', machine: null, tabs: [{ id: anchor.tab, name: 'One' }] }],
    tabPanes: async (slot: OwnerPlacement) => [...placements].filter(([, p]) => p.space === slot.space && p.tab === slot.tab).map(([terminal, p]) => ({ terminal, pane: p.pane })),
    tabTerminals: async (slot: OwnerPlacement) => [...placements].filter(([, p]) => p.space === slot.space && p.tab === slot.tab).map(([t]) => t),
    tabSpace: async () => anchor.space, tabIndex: async () => 1, focusedPane: async () => focus,
    ownerPlacement: async (terminal: TerminalAddress) => { const p = placements.get(terminal); if (!p) throw Error('unplaced'); return p; }, awaitPane: async () => 'presented-pane' as never,
    command: vi.fn(async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      if (name === 'pane.focus') { const found = [...placements.values(), ...placeholders.values()].find(p => p.pane === args.pane); if (!found) throw Error('missing pane'); focus = found; }
      if ((name === 'tab.new' || name === 'pane.split') && args.mod) {
        const p = { space: anchor.space, tab: name === 'tab.new' ? 'new-tab' as never : anchor.tab, pane: 'placeholder' as never }; placeholders.set(String((args.props as Record<string, unknown>).operationId), p); focus = p; return p;
      }
      if (name === 'tab.new' || name === 'terminal.open') { const p = { space: anchor.space, tab: split ? anchor.tab : 'new-tab' as never, pane: 'native-pane' as never }; const terminal = (local ? target.terminalId : target.address) as TerminalAddress; placements.set(terminal, p); focus = p; return { ...p, terminal }; }
      if (name === 'terminal.keep') { const p = { space: focus!.space, tab: focus!.tab, pane: 'proxy-pane' as never }; placements.set(args.terminal as TerminalAddress, p); return p; }
      if (name === 'pane.close') { for (const [op, p] of placeholders) if (p.pane === args.pane) placeholders.delete(op); }
      if (name === 'terminal.park') placements.delete(args.terminal as TerminalAddress);
      return {};
    }),
  } as AppClient & AppPaneInspection;
  const hc = { identity: async () => ({ coreId: 'core-local', socket: '/unused', sessionNamespace: 'test' }), setLabels: vi.fn(async () => {}), get: vi.fn(async address => ({ address, parent: null, labels: address === 'core-local/t8' ? { 'spider.kind': 'pane-proxy', 'spider.pane-id': 'pane-op1', 'spider.pane-operation': proxyOperation, 'spider.target-core': target.coreId, 'spider.target-terminal': target.terminalId } : target.identityLabels, state: 'live', status: null, exitCode: null, reason: null, signal: null, finishedAt: null })), kill: vi.fn() } as unknown as HcClient;
  const ports: PaneOpenPorts = {
    store, hc, app, placeholderMod: 'synthetic-waiting',
    launchTarget: vi.fn(async () => { expect((await store.read()).launches[0].state).toBe('claimed'); return target; }),
    launchProxy: vi.fn(async p => { expect((await store.read()).presentations[0].launch).toBe('claimed'); expect(p.slot?.space).toBe(anchor.space); return 'core-local/t8' as TerminalAddress; }),
    findTargetLaunch: vi.fn(async () => null), findProxy: vi.fn(async () => null),
    readNativeTarget: vi.fn(async () => target), validateTarget: vi.fn(async t => t),
    agentArgv: vi.fn(async () => ['synthetic-agent', '--session', '/home/example/session.jsonl']),
    verifyPlaceholder: vi.fn(async (p, op) => placeholders.get(op)?.pane === p.pane),
    findPlaceholder: vi.fn(async op => placeholders.get(op) ?? null),
    deferSourceView: vi.fn(async () => false),
    awaitPresented: vi.fn(async (proxy, _target, slot) => { const p = await app.ownerPlacement(proxy); if (p.space !== slot.space || p.tab !== slot.tab) throw Error('wrong slot'); return p; }),
    appCapabilities: vi.fn(async () => ({ backgroundTabCreation: false, explicitTargetSwap: false, noFocusConversion: false, commandDigest: 'a'.repeat(64) })),
  };
  return { ports, target, intent, machine, calls, placements, placeholders, anchor, focus: () => focus, setFocus: (p: OwnerPlacement | null) => { focus = p; } };
}
test('remote shell launches once and adopts a Mac proxy', async () => {
  const f = await paneOpenFixture(); const reply = await openPane({ intent: f.intent, machine: f.machine, folder: { cwd: '/home/example/work', reason: 'mapped' } }, f.ports);
  expect(reply).toMatchObject({ status: 'complete', presentation: { mode: 'proxy', proxy: 'core-local/t8', slot: { space: 'space-1', tab: 'new-tab' } } });
  expect(f.ports.launchTarget).toHaveBeenCalledTimes(1); expect(f.ports.launchProxy).toHaveBeenCalledTimes(1); expect(f.placeholders.size).toBe(0); expect(f.ports.hc.kill).not.toHaveBeenCalled();
});
test('local agent uses an ordinary native pane with zero attach proxies', async () => {
  const f = await paneOpenFixture(true); f.intent.program = { kind: 'agent', key: 'example' };
  expect((await openPane({ intent: f.intent, machine: f.machine, folder: { cwd: '/home/example/work', reason: 'focused' } }, f.ports)).presentation?.mode).toBe('native');
  expect(f.calls[0]).toEqual({ name: 'tab.new', args: { space: 'space-1', folder: '/home/example/work', argv: ['synthetic-agent', '--session', '/home/example/session.jsonl'] } });
  expect(f.ports.launchProxy).not.toHaveBeenCalled(); expect(f.ports.launchTarget).not.toHaveBeenCalled();
});
test.each(['right', 'down'] as const)('local %s split uses chosen folder on 0.1.13 and captured anchor', async split => {
  const f = await paneOpenFixture(true, split); f.setFocus({ ...f.anchor, pane: 'unrelated' as never });
  expect((await openPane({ intent: f.intent, machine: f.machine, folder: { cwd: '/home/example/chosen', reason: 'focused' } }, f.ports)).status).toBe('complete');
  expect(f.calls.slice(0, 2)).toEqual([{ name: 'pane.focus', args: { pane: 'anchor-1' } }, { name: 'terminal.open', args: { folder: '/home/example/chosen', place: split } }]);
  expect(f.calls.some(c => c.name === 'pane.split')).toBe(false); expect(f.ports.launchProxy).not.toHaveBeenCalled();
});
test('missing captured anchor refuses before any target launch', async () => {
  const f = await paneOpenFixture(false, 'right'); f.placements.clear();
  expect((await openPane({ intent: f.intent, machine: f.machine, folder: { cwd: null, reason: 'home' } }, f.ports)).status).toBe('refused'); expect(f.ports.launchTarget).not.toHaveBeenCalled(); expect(f.calls).toEqual([]);
});
test('failed placement retains an unplaced target and reuses it on retry', async () => {
  const f = await paneOpenFixture(); vi.mocked(f.ports.awaitPresented).mockRejectedValueOnce(Error('no agreement'));
  const input = { intent: f.intent, machine: f.machine, folder: { cwd: null, reason: 'home' as const } };
  expect((await openPane(input, f.ports)).status).toBe('pending'); expect((await f.ports.store.read()).presentations[0].target).toEqual(f.target);
  expect((await openPane(input, f.ports)).status).toBe('complete'); expect(f.ports.launchTarget).toHaveBeenCalledTimes(1); expect(f.ports.launchProxy).toHaveBeenCalledTimes(1);
});
test('lost launch reply remains uncertain until verified operation-label discovery', async () => {
  const f = await paneOpenFixture(); vi.mocked(f.ports.launchTarget).mockRejectedValueOnce(Error('lost reply'));
  const input = { intent: f.intent, machine: f.machine, folder: { cwd: null, reason: 'home' as const } };
  expect((await openPane(input, f.ports)).status).toBe('pending'); expect((await openPane(input, f.ports)).status).toBe('pending'); expect(f.ports.launchTarget).toHaveBeenCalledTimes(1);
  vi.mocked(f.ports.findTargetLaunch).mockResolvedValue(f.target);
  expect((await openPane(input, f.ports)).status).toBe('complete'); expect(f.ports.launchTarget).toHaveBeenCalledTimes(1);
});
test('duplicate open requests coalesce through the durable claim', async () => {
  const f = await paneOpenFixture(); const input = { intent: f.intent, machine: f.machine, folder: { cwd: null, reason: 'home' as const } };
  await Promise.all([openPane(input, f.ports), openPane(input, f.ports)]);
  expect(f.ports.launchTarget).toHaveBeenCalledTimes(1); expect(f.ports.launchProxy).toHaveBeenCalledTimes(1);
  expect((await f.ports.store.read()).presentations).toHaveLength(1);
});
test('lost proxy reply is reconciled without a second proxy launch', async () => {
  const f = await paneOpenFixture(); vi.mocked(f.ports.launchProxy).mockRejectedValueOnce(Error('lost proxy reply'));
  const input = { intent: f.intent, machine: f.machine, folder: { cwd: null, reason: 'home' as const } };
  expect((await openPane(input, f.ports)).status).toBe('pending'); expect((await openPane(input, f.ports)).status).toBe('pending');
  vi.mocked(f.ports.findProxy).mockResolvedValue('core-local/t8' as TerminalAddress);
  expect((await openPane(input, f.ports)).status).toBe('complete'); expect(f.ports.launchProxy).toHaveBeenCalledTimes(1);
});
test('a new proxy launch with a different operation is not acknowledged', async () => {
  const f = await paneOpenFixture(false, null, 'other-operation');
  const input = { intent: f.intent, machine: f.machine, folder: { cwd: null, reason: 'home' as const } };
  expect((await openPane(input, f.ports)).status).toBe('pending');
  expect((await f.ports.store.read()).presentations[0]).toMatchObject({ proxy: null, launch: 'uncertain' });
  expect(f.calls.filter(call => call.name === 'terminal.keep')).toEqual([]);
});
test('an uncertain proxy launch never adopts a different operation', async () => {
  const f = await paneOpenFixture(false, null, 'other-operation');
  vi.mocked(f.ports.launchProxy).mockRejectedValueOnce(Error('lost proxy reply'));
  const input = { intent: f.intent, machine: f.machine, folder: { cwd: null, reason: 'home' as const } };
  expect((await openPane(input, f.ports)).status).toBe('pending');
  vi.mocked(f.ports.findProxy).mockResolvedValue('core-local/t8' as TerminalAddress);
  expect((await openPane(input, f.ports)).status).toBe('pending');
  expect((await f.ports.store.read()).presentations[0].proxy).toBeNull();
  expect(f.calls.filter(call => call.name === 'terminal.keep')).toEqual([]);
  expect(f.ports.launchProxy).toHaveBeenCalledTimes(1);
});
test('reused creation operation with changed input refuses rather than launching', async () => {
  const f = await paneOpenFixture(); const input = { intent: f.intent, machine: f.machine, folder: { cwd: null, reason: 'home' as const } }; await openPane(input, f.ports);
  expect((await openPane({ ...input, folder: { cwd: '/home/example/changed', reason: 'mapped' } }, f.ports)).status).toBe('refused'); expect(f.ports.launchTarget).toHaveBeenCalledTimes(1);
});
test.each(['incomplete', 'different-size', 'changing'] as const)('same text with %s screen refuses acknowledgment', async bad => {
  const f = await paneOpenFixture(); let time = 0; let reads = 0;
  await expect(awaitPanePresented('core-local/t8' as never, f.target, f.anchor, { app: { ownerPlacement: async () => f.anchor } as unknown as AppClient, readScreen: async () => { reads++; return { text: bad === 'changing' && reads % 3 === 0 ? 'CHANGED' : 'CANARY', complete: bad !== 'incomplete', cols: bad === 'different-size' && reads % 3 === 2 ? 61 : 60, rows: 8 }; }, clock: () => time, delay: async () => { time++; }, timeoutMs: 1 })).rejects.toThrow(/acknowledgment/);
});
test('complete screen agreement is required without retaining screen text', async () => {
  const slot = { space: 'space-1', tab: 'tab-1', pane: null } as const; let calls = 0; let waits = 0;
  const p = { ...slot, pane: 'pane-1' } as OwnerPlacement;
  const screen = vi.fn(async (_address: TerminalAddress, _options: { lines: 0 }) => { calls++; return { cols: 60, rows: 8, complete: waits > 0, text: waits ? 'CANARY' : '' }; });
  const app = { ownerPlacement: async () => p } as unknown as AppClient;
  expect(await awaitPanePresented('core-local/t8' as never, parsePaneTarget({ coreId: 'core-remote', terminalId: 't7', address: 'core-remote/t7', createdMs: 17, identityLabels: { op: 'op1' }, alias: 'box-1.invalid', machineId: null, kind: 'terminal', sessionId: null, generation: null, homeEpoch: null, runId: null, consoleId: null, name: null, cwd: null }), slot as never, { app, readScreen: screen, clock: () => waits, delay: async () => { waits++; }, timeoutMs: 3 })).toEqual(p);
  expect(waits).toBe(1); expect(calls).toBe(6);
  expect(screen.mock.calls.every(c => c.length === 2 && (c[1] as { lines: number }).lines === 0)).toBe(true);
});

test.each([true, false])('identity guard runs at the actual native=%s launch boundary', async native => {
  const f = await paneOpenFixture(native);
  const beforeLaunch = vi.fn(async () => { throw new HerdrError('machine-changed', 'Selected machine changed'); });
  const result = await openPane({ intent: f.intent, machine: f.machine, folder: { cwd: null, reason: 'home' }, beforeLaunch }, f.ports);
  expect(result).toMatchObject({ status: 'refused', reason: 'machine-changed' });
  expect(beforeLaunch).toHaveBeenCalledOnce();
  expect(f.ports.launchTarget).not.toHaveBeenCalled();
  expect(f.ports.readNativeTarget).not.toHaveBeenCalled();
});

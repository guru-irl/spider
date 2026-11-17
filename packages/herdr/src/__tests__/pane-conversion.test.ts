// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { paths } from '@spider/db-core';
import { HerdrError } from '../client/parse.js';
import { afterEach, expect, test, vi } from 'vitest';
import { convertNativePresentation, type PaneOpenPorts } from '../panes/open.js';
import { createPanePlacementStore } from '../panes/store.js';
import { parsePanePresentation, parsePaneTarget } from '../panes/codec.js';
import type { AppClient, AppPaneInspection, HcClient, OwnerPlacement, TerminalAddress } from '../contracts.js';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture(toLocal = false, focused = true, proxyOperation = 'p1') {
  const base = join(paths.scratch('worktree', process.cwd()), 'b3', 'conversion'); await mkdir(base, { recursive: true }); const root = await mkdtemp(join(base, 's-')); roots.push(root);
  const store = createPanePlacementStore(join(root, 'roam', 'placement'));
  const target = (coreId: string, terminalId: string, epoch: number) => parsePaneTarget({ coreId, terminalId, address: `${coreId}/${terminalId}`, createdMs: epoch + 10, identityLabels: { 'spider.session': 'session-1', 'spider.generation': 'gen-1' }, alias: coreId === 'core-local' ? null : 'box-1.invalid', machineId: null, kind: 'session', sessionId: 'session-1', generation: 'gen-1', homeEpoch: epoch, runId: null, consoleId: null, name: 'Example', cwd: '/home/example/work' });
  const source = { space: 'space-1', tab: 'tab-1', pane: 'source-pane' } as OwnerPlacement;
  const p = parsePanePresentation({ id: 'p1', revision: 1, mode: toLocal ? 'proxy' : 'native', role: 'agent', target: target(toLocal ? 'core-remote' : 'core-local', 't7', 2), proxy: toLocal ? 't8' : null, slot: source, visibility: 'visible', launch: 'acknowledged', closeOperationId: null, conversion: null });
  const destination = target(toLocal ? 'core-local' : 'core-remote', 't9', 3);
  await store.update(s => ({ ...s, presentations: [p] }));
  const oldDisplay = (toLocal ? 't8' : 't7') as TerminalAddress;
  const placements = new Map<TerminalAddress, OwnerPlacement>([[oldDisplay, source]]);
  let focus: OwnerPlacement | null = focused ? source : { ...source, pane: 'unrelated' as never };
  const calls: string[] = [];
  const app = {
    ownerPlacement: async (address: TerminalAddress) => { const p = placements.get(address); if (!p) throw Error('unplaced'); return p; },
    tabTerminals: async () => [...placements.keys()], tabPanes: async () => [...placements].map(([terminal, p]) => ({ terminal, pane: p.pane })),
    focusedPane: async () => focus, tabIndex: async () => 1,
    command: vi.fn(async (name: string, args: Record<string, unknown>) => { calls.push(name);
      if (name === 'pane.focus') { const p = [...placements.values()].find(p => p.pane === args.pane); if (!p) throw Error('missing source'); focus = p; }
      if (name === 'terminal.keep') { const p = { ...source, pane: 'replacement-pane' as never }; placements.set(args.terminal as TerminalAddress, p); focus = p; }
      if (name === 'terminal.park') placements.delete(args.terminal as TerminalAddress);
      return {};
    }),
  } as unknown as AppClient & AppPaneInspection;
  const hc = { identity: async () => ({ coreId: 'core-local', socket: '/unused', sessionNamespace: 'test' }), get: vi.fn(async address => ({ address, parent: null, labels: { 'spider.kind': 'pane-proxy', 'spider.pane-id': 'p1', 'spider.pane-operation': proxyOperation, 'spider.target-core': address === 't8' ? p.target.coreId : destination.coreId, 'spider.target-terminal': address === 't8' ? p.target.terminalId : destination.terminalId }, state: 'live', status: null, exitCode: null, reason: null, signal: null, finishedAt: null })), kill: vi.fn(async () => {}), setLabels: vi.fn(async () => {}) } as unknown as HcClient;
  const ports: PaneOpenPorts = {
    store, hc, app, placeholderMod: 'synthetic-waiting',
    launchTarget: vi.fn(async () => { throw Error('conversion cannot launch a target'); }),
    launchProxy: vi.fn(async desired => { const state = await store.read(); expect(state.presentations[0].mode).toBe('native'); expect(state.presentations[0].conversion?.state).toBe('waiting-focus'); expect(desired.target).toEqual(destination); return 't10' as TerminalAddress; }),
    findTargetLaunch: vi.fn(async () => null), findProxy: vi.fn(async () => null), agentArgv: vi.fn(async () => []),
    readNativeTarget: vi.fn(async () => p.target), validateTarget: vi.fn(async target => target),
    verifyPlaceholder: vi.fn(async () => false), findPlaceholder: vi.fn(async () => null),
    deferSourceView: vi.fn(async () => false),
    awaitPresented: vi.fn(async (address, _target, slot) => { calls.push('acknowledged'); const place = await app.ownerPlacement(address); if (place.space !== slot.space || place.tab !== slot.tab) throw Error('wrong tab'); return place; }),
    appCapabilities: vi.fn(async () => ({ backgroundTabCreation: false, explicitTargetSwap: false, noFocusConversion: false, commandDigest: 'a'.repeat(64) })),
  };
  const input = { presentation: p, destination, source, sourceFocused: focused };
  return { p, destination, source, ports, input, placements, calls, focus: () => focus, focusSource: () => { focus = source; } };
}
test('conversion acknowledges remote proxy beside native view before removal', async () => {
  const f = await fixture(); const result = await convertNativePresentation(f.input, f.ports);
  expect(result).toMatchObject({ status: 'complete', presentation: { mode: 'proxy', target: f.destination, proxy: 't10', slot: { space: 'space-1', tab: 'tab-1' }, conversion: null } });
  expect(f.calls.indexOf('acknowledged')).toBeLessThan(f.calls.indexOf('terminal.park')); expect(f.placements.has('t7' as TerminalAddress)).toBe(false); expect(f.ports.hc.kill).not.toHaveBeenCalled(); expect(f.ports.launchTarget).not.toHaveBeenCalled();
});
test('conversion does not acknowledge a proxy with a different launch identity', async () => {
  const f = await fixture(false, true, 'other-operation');
  expect(await convertNativePresentation(f.input, f.ports)).toMatchObject({ status: 'pending', reason: 'conversion-proxy-uncertain' });
  expect((await f.ports.store.read()).presentations[0]).toMatchObject({ proxy: null, launch: 'uncertain' });
  expect(f.placements.has('t7' as TerminalAddress)).toBe(true);
  expect(f.calls).not.toContain('terminal.keep');
});
test('return to Mac creates native pane not local proxy', async () => {
  const f = await fixture(true); const result = await convertNativePresentation(f.input, f.ports);
  expect(result).toMatchObject({ status: 'complete', presentation: { mode: 'native', proxy: null, target: f.destination } });
  expect(f.ports.launchProxy).not.toHaveBeenCalled(); expect(f.ports.hc.kill).toHaveBeenCalledWith('t8'); expect(f.placements.has('t9' as TerminalAddress)).toBe(true); expect(f.calls.indexOf('acknowledged')).toBeLessThan(f.calls.indexOf('terminal.park'));
});
test('conversion failure retains source view and execution binding', async () => {
  const f = await fixture(); vi.mocked(f.ports.awaitPresented).mockRejectedValue(Error('screen differs'));
  expect((await convertNativePresentation(f.input, f.ports)).status).toBe('pending');
  expect(f.placements.has('t7' as TerminalAddress)).toBe(true); expect((await f.ports.store.read()).presentations[0].target).toEqual(f.p.target); expect(f.ports.hc.kill).not.toHaveBeenCalled();
});
test('unattended unsupported conversion never focuses or claims a placeholder proof', async () => {
  const f = await fixture(false, false); const before = f.focus(); const result = await convertNativePresentation(f.input, f.ports);
  expect(result).toMatchObject({ status: 'pending', reason: 'waiting-focus-placeholder-unproved', presentation: { mode: 'native', conversion: { state: 'waiting-focus', destination: f.destination } } });
  expect(f.focus()).toEqual(before); expect(f.calls).toEqual([]); expect(f.ports.launchProxy).not.toHaveBeenCalled(); expect(f.placements.has('t7' as TerminalAddress)).toBe(true);
});
test('focusing the deferred source resumes conversion once', async () => {
  const f = await fixture(false, false); await convertNativePresentation(f.input, f.ports); f.focusSource();
  const current = (await f.ports.store.read()).presentations[0];
  expect((await convertNativePresentation({ ...f.input, presentation: current }, f.ports)).status).toBe('complete');
  const completed = (await f.ports.store.read()).presentations[0]; await convertNativePresentation({ ...f.input, presentation: completed }, f.ports);
  expect(f.ports.launchProxy).toHaveBeenCalledTimes(1); expect(f.ports.launchTarget).not.toHaveBeenCalled();
});
test('proved no-focus replacement preserves unrelated focus', async () => {
  const f = await fixture(false, false); const before = f.focus();
  vi.mocked(f.ports.appCapabilities).mockResolvedValue({ backgroundTabCreation: true, explicitTargetSwap: true, noFocusConversion: true, commandDigest: 'a'.repeat(64) });
  f.ports.placeWithoutFocus = vi.fn(async (address, slot) => { const placement = { ...slot, pane: 'replacement-pane' as never }; f.placements.set(address, placement); return placement; });
  expect((await convertNativePresentation(f.input, f.ports)).status).toBe('complete'); expect(f.focus()).toEqual(before); expect(f.calls).not.toContain('pane.focus');
});
test('app absence keeps conversion pending and launches no hidden presentation', async () => {
  const f = await fixture(); f.ports.app = null;
  expect((await convertNativePresentation(f.input, f.ports)).status).toBe('pending'); expect(f.ports.launchProxy).not.toHaveBeenCalled(); expect(f.ports.hc.kill).not.toHaveBeenCalled();
});
test('closing presentation refuses new readiness and cannot stop a successor', async () => {
  const f = await fixture(); const p = { ...f.p, visibility: 'closing' as const, closeOperationId: 'close1' }; await f.ports.store.update(s => ({ ...s, presentations: [p] }));
  expect((await convertNativePresentation({ ...f.input, presentation: p }, f.ports)).reason).toBe('Session changed. Close again.'); expect(f.ports.launchProxy).not.toHaveBeenCalled(); expect(f.ports.hc.kill).not.toHaveBeenCalled();
});
test('remote to remote retarget keeps proxy and parked intent without launch', async () => {
  const f = await fixture(true); const p = { ...f.p, visibility: 'parked' as const }; const destination = { ...f.destination, coreId: 'core-other' as never, address: 'core-other/t9' as never, alias: 'box-2.invalid' }; await f.ports.store.update(s => ({ ...s, presentations: [p] }));
  expect(await convertNativePresentation({ ...f.input, presentation: p, destination }, f.ports)).toMatchObject({ status: 'complete', presentation: { proxy: 't8', mode: 'proxy', visibility: 'parked', target: destination, slot: f.p.slot } });
  expect(f.ports.launchProxy).not.toHaveBeenCalled(); expect(f.ports.hc.kill).not.toHaveBeenCalled();
});


test('a proxy launched before focus changes follows the successor conversion destination', async () => {
  const f = await fixture(false, false);
  const next = { ...f.destination, terminalId: 't11' as never, address: 'core-remote/t11' as never, homeEpoch: 4 };
  let labels = { 'spider.kind': 'pane-proxy', 'spider.pane-id': f.p.id, 'spider.target-core': f.destination.coreId, 'spider.target-terminal': f.destination.terminalId };
  vi.mocked(f.ports.hc.get).mockImplementation(async address => ({ address, parent: null, labels, state: 'live', status: null, exitCode: null, reason: null, signal: null, finishedAt: null }));
  vi.mocked(f.ports.hc.setLabels).mockImplementation(async (_address, values) => { labels = { ...labels, ...values }; });
  vi.mocked(f.ports.awaitPresented).mockImplementation(async (address, target) => {
    if (labels['spider.target-core'] !== target.coreId || labels['spider.target-terminal'] !== target.terminalId) throw Error('Proxy is still showing its previous target');
    return f.ports.app!.ownerPlacement(address);
  });
  const waiting = { ...f.p, revision: 2, proxy: 't10' as TerminalAddress, conversion: { state: 'waiting-focus' as const, source: f.source, sourceFocused: false, destination: f.destination } };
  await f.ports.store.update(state => ({ ...state, presentations: [waiting] }));
  expect(await convertNativePresentation({ ...f.input, presentation: waiting, destination: next }, f.ports)).toMatchObject({ status: 'pending', presentation: { conversion: { destination: next } } });
  expect(f.focus()?.pane).toBe('unrelated');
  f.focusSource();
  const current = (await f.ports.store.read()).presentations[0];
  expect(await convertNativePresentation({ ...f.input, presentation: current, destination: next }, f.ports)).toMatchObject({ status: 'complete', presentation: { target: next, proxy: 't10', conversion: null } });
  expect((await f.ports.store.read()).presentations).toHaveLength(1);
  expect(f.ports.launchProxy).not.toHaveBeenCalled();
  expect(f.ports.launchTarget).not.toHaveBeenCalled();
  expect(f.ports.hc.kill).not.toHaveBeenCalled();
});

test.each([false, true])('parked reconcile preserves an unproved proxy and reports no screen failure, foreign=%s', async foreign => {
  const f = await fixture(true), p = { ...f.p, visibility: 'parked' as const, proxy: `${foreign ? 'core-other' : 'core-local'}/t8` as TerminalAddress };
  const destination = { ...f.destination, coreId: 'core-destination' as never, address: 'core-destination/t9' as TerminalAddress, alias: 'box-2.invalid' };
  await f.ports.store.update(state => ({ ...state, presentations: [p] }));
  vi.mocked(f.ports.hc.get).mockRejectedValue(new HerdrError(foreign ? 'not_found' : 'unavailable', 'fixture unavailable'));
  expect(await convertNativePresentation({ ...f.input, presentation: p, destination }, f.ports)).toMatchObject({ status: 'pending', reason: 'proxy-reconcile-pending' });
  expect((await f.ports.store.read()).presentations[0]).toEqual(p);
  expect(f.ports.hc.setLabels).not.toHaveBeenCalled();
  if (foreign) expect(f.ports.hc.get).not.toHaveBeenCalled();
});

// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { paths } from '@spider/db-core';
import { afterEach, expect, test, vi } from 'vitest';
import { HerdrError } from '../client/parse.js';
import { confirmPresentationClose, parkPresentation, reconcilePendingClose, reconcilePresentationExit, type PaneLifecyclePorts } from '../panes/lifecycle.js';
import { createPanePlacementStore } from '../panes/store.js';
import { parsePanePresentation } from '../panes/codec.js';
import type { AppClient, HcClient, TerminalSummary } from '../contracts.js';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(r => rm(r, { recursive: true, force: true }))); });
async function fixture(session = false) {
  const base = join(paths.scratch('worktree', process.cwd()), 'b3', 'lifecycle'); await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, 's-')); roots.push(root); const store = createPanePlacementStore(join(root, 'roam', 'placement'));
  const p = parsePanePresentation({ id: 'p1', revision: 1, mode: 'proxy', role: session ? 'agent' : 'shell', target: { coreId: 'core-remote', terminalId: 't7', address: 'core-remote/t7', createdMs: 17, identityLabels: { 'spider.pane-operation': 'op1' }, alias: 'box-1.invalid', machineId: null, kind: session ? 'session' : 'terminal', sessionId: session ? 'session-1' : null, generation: session ? 'gen-1' : null, homeEpoch: session ? 2 : null, runId: null, consoleId: null, name: null, cwd: null }, proxy: 'core-local/t8', slot: { space: 'space-1', tab: 'tab-1', pane: 'pane-1' }, visibility: 'visible', launch: 'acknowledged', closeOperationId: null, conversion: null });
  await store.update(s => ({ ...s, presentations: [p] }));
  let targetState: 'live' | 'finished' = 'live', proxyState: 'live' | 'finished' = 'live'; const removed = new Set<string>(); let shown = true; let hosting: 'running' | 'stopped' = 'running'; let children = 'live'; const order: string[] = [];
  const terminal = (address: string): TerminalSummary => ({ address: address as never, parent: null, labels: address === p.proxy ? { 'spider.kind': 'pane-proxy', 'spider.pane-id': p.id } : p.target.identityLabels, state: address === p.proxy ? proxyState : targetState, status: null, exitCode: null, reason: null, signal: null, finishedAt: null });
  const hc = { identity: async () => ({ coreId: 'core-local', socket: '/unused', sessionNamespace: 'test' }), get: vi.fn(async address => { if (removed.has(address)) throw new HerdrError('not_found', 'No terminal'); return terminal(address); }), rm: vi.fn(async address => { if (terminal(address).state !== 'finished') throw new Error('Cannot remove a live terminal'); removed.add(address); }), kill: vi.fn(async address => { const state = await store.read(); order.push(state.presentations[0].visibility + ':' + address); if (address === p.target.address) targetState = 'finished'; if (address === p.proxy) proxyState = 'finished'; }) } as unknown as HcClient;
  const app = { command: vi.fn(async (name: string) => { if (name === 'terminal.park') { expect((await store.read()).presentations[0].visibility).toBe('parked'); shown = false; } return {}; }), tabTerminals: vi.fn(async () => shown ? [p.proxy!] : []) } as unknown as AppClient;
  const ports: PaneLifecyclePorts = { store, hc, app, validateTarget: vi.fn(async target => target), closeSession: vi.fn(async () => { hosting = 'stopped'; order.push(hosting); targetState = 'finished'; children = 'ended-by-session-policy'; return 'ended' as const; }) };
  return { p, ports, hc, app, order, state: () => ({ targetState, hosting, children }), terminal, disappear: () => { removed.add(p.proxy!); shown = false; } };
}
test('spider confirmed close ends exact target after durable intent', async () => {
  const f = await fixture(); const reply = await confirmPresentationClose({ id: f.p.id, expectedRevision: 1, operationId: 'close1', target: f.p.target }, f.ports);
  expect(reply).toMatchObject({ status: 'complete', presentation: { visibility: 'ended', closeOperationId: 'close1' } });
  expect(f.order[0]).toBe('closing:core-remote/t7'); expect(f.state().targetState).toBe('finished');
});
test('completed shell close removes its finished terminal record', async () => {
  const f = await fixture();
  expect(await confirmPresentationClose({ id: f.p.id, expectedRevision: 1, operationId: 'close1', target: f.p.target }, f.ports)).toMatchObject({ status: 'complete' });
  await expect(f.hc.get(f.p.target.address)).rejects.toMatchObject({ code: 'not_found' });
});
test('completed park removes only the finished display terminal record', async () => {
  const f = await fixture();
  expect(await parkPresentation(f.p.id, 1, f.ports)).toMatchObject({ status: 'complete' });
  await expect(f.hc.get(f.p.proxy!)).rejects.toMatchObject({ code: 'not_found' });
  expect(await f.hc.get(f.p.target.address)).toMatchObject({ state: 'live' });
});
test('park completes when another display owner removes the verified proxy after unplacement', async () => {
  const f = await fixture(), command = vi.mocked(f.app.command).getMockImplementation()!;
  vi.mocked(f.app.command).mockImplementation(async (...args) => { const reply = await command(...args); await f.hc.kill(f.p.proxy!); await f.hc.rm(f.p.proxy!); return reply; });
  expect(await parkPresentation(f.p.id, 1, f.ports)).toMatchObject({ status: 'complete', reason: 'parked' });
  expect(f.hc.kill).toHaveBeenCalledExactlyOnceWith(f.p.proxy);
  expect(f.state().targetState).toBe('live');
});
test.each(['before park', 'after parked intent'] as const)('park settles when the display disappears %s before its first ownership read', async when => {
  const f = await fixture(), get = vi.mocked(f.hc.get).getMockImplementation()!;
  if (when === 'before park') f.disappear();
  else vi.mocked(f.hc.get).mockImplementationOnce(async (...args) => {
    expect((await f.ports.store.read()).presentations[0].visibility).toBe('parked');
    f.disappear(); return get(...args);
  });
  expect(await parkPresentation(f.p.id, 1, f.ports)).toMatchObject({ status: 'complete', reason: 'parked', presentation: { visibility: 'parked' } });
  expect(f.state().targetState).toBe('live');
  expect(f.hc.kill).not.toHaveBeenCalled(); expect(f.hc.rm).not.toHaveBeenCalled();
  expect(f.app.command).not.toHaveBeenCalled();
});
test('a missing core identity is not proof that the display disappeared', async () => {
  const f = await fixture();
  f.hc.identity = async () => { throw new HerdrError('not_found', 'No core identity'); };
  expect(await parkPresentation(f.p.id, 1, f.ports)).toMatchObject({ status: 'pending', reason: 'park-removal-pending' });
  expect(f.hc.kill).not.toHaveBeenCalled(); expect(f.hc.rm).not.toHaveBeenCalled();
});
test('park records intent before proxy removal and retains target', async () => {
  const f = await fixture(); const result = await parkPresentation(f.p.id, 1, f.ports);
  expect(result).toMatchObject({ status: 'complete', presentation: { visibility: 'parked' } }); expect(f.order).toEqual(['parked:core-local/t8']); expect(f.state().targetState).toBe('live');
});
test.each(['server_stop', 'host_shutdown', 'holder_lost'])('core-loss reason %s never authorizes close', async reason => {
  const f = await fixture(); const result = await reconcilePresentationExit(f.p, { ...f.terminal(f.p.proxy!), state: 'finished', reason }, f.ports);
  expect(result.presentation?.visibility).toBe('visible'); expect(f.hc.kill).not.toHaveBeenCalled(); expect(f.state().targetState).toBe('live');
});
test('missing snapshots never authorize close or park', async () => {
  const f = await fixture(); expect((await reconcilePresentationExit(f.p, null, f.ports)).presentation?.visibility).toBe('visible'); expect(f.hc.kill).not.toHaveBeenCalled();
});
test.each(['tab close', 'space close', 'shell crash', 'unproved park'])('unconfirmed %s parks without killing a target', async () => {
  const f = await fixture(); const reply = await reconcilePresentationExit(f.p, { ...f.terminal(f.p.proxy!), state: 'finished', reason: 'killed' }, f.ports);
  expect(reply.presentation?.visibility).toBe('parked'); expect(f.state().targetState).toBe('live'); expect(f.hc.kill).not.toHaveBeenCalled();
});
test('supervised pane close persists stopped intent and follows session shutdown policy', async () => {
  const f = await fixture(true); await confirmPresentationClose({ id: f.p.id, expectedRevision: 1, operationId: 'close1', target: f.p.target }, f.ports);
  expect(f.state()).toEqual({ targetState: 'finished', hosting: 'stopped', children: 'ended-by-session-policy' }); expect(f.hc.kill).not.toHaveBeenCalled(); expect(f.ports.closeSession).toHaveBeenCalledWith(f.p.target, 'close1');
});
test.each(['core', 'epoch', 'generation', 'incarnation'])('changed %s never stops successor target', async change => {
  const f = await fixture(true); const successor = { ...f.p.target, ...(change === 'core' ? { coreId: 'core-new' as never, address: 'core-new/t7' as never } : change === 'epoch' ? { homeEpoch: 3 } : change === 'generation' ? { generation: 'gen-2' as never } : { createdMs: 18 }) };
  vi.mocked(f.ports.validateTarget).mockResolvedValue(successor);
  expect(await confirmPresentationClose({ id: f.p.id, expectedRevision: 1, operationId: 'close1', target: f.p.target }, f.ports)).toMatchObject({ status: 'refused', reason: 'Session changed. Close again.' });
  expect(f.ports.closeSession).not.toHaveBeenCalled(); expect(f.hc.kill).not.toHaveBeenCalled(); expect(f.state().targetState).toBe('live');
});
test('lost kill reply stays closing until exact completion is observed', async () => {
  const f = await fixture(); const kill = vi.mocked(f.hc.kill).getMockImplementation()!; vi.mocked(f.hc.kill).mockImplementationOnce(async (...args) => { await kill(...args); throw Error('lost reply'); });
  expect(await confirmPresentationClose({ id: f.p.id, expectedRevision: 1, operationId: 'close1', target: f.p.target }, f.ports)).toMatchObject({ status: 'pending', presentation: { visibility: 'closing' } });
  expect(await reconcilePendingClose(f.p.id, f.ports)).toMatchObject({ status: 'complete', presentation: { visibility: 'ended' } }); expect(f.hc.kill).toHaveBeenCalledTimes(1);
});
test('pending session close cannot stop a newer epoch', async () => {
  const f = await fixture(true); vi.mocked(f.ports.closeSession).mockResolvedValueOnce('pending');
  expect((await confirmPresentationClose({ id: f.p.id, expectedRevision: 1, operationId: 'close1', target: f.p.target }, f.ports)).status).toBe('pending');
  vi.mocked(f.ports.validateTarget).mockResolvedValue({ ...f.p.target, homeEpoch: 3 });
  expect((await reconcilePendingClose(f.p.id, f.ports)).reason).toBe('Session changed. Close again.'); expect(f.ports.closeSession).toHaveBeenCalledTimes(1);
});
test('cancelled confirmation and replayed finished events have no target effect', async () => {
  const f = await fixture(); await reconcilePresentationExit(f.p, f.terminal(f.p.proxy!), f.ports);
  expect(f.hc.kill).not.toHaveBeenCalled(); const ended = { ...f.terminal(f.p.proxy!), state: 'finished' as const, reason: 'exited' };
  await reconcilePresentationExit(f.p, ended, f.ports); await reconcilePresentationExit(f.p, ended, f.ports);
  expect((await f.ports.store.read()).presentations[0].revision).toBe(2); expect(f.hc.kill).not.toHaveBeenCalled();
});
test('verified target finish ends the presentation without a new stop', async () => {
  const f = await fixture(); vi.mocked(f.hc.get).mockImplementation(async address => ({ ...f.terminal(address), state: 'finished', reason: 'exited' }));
  expect((await reconcilePresentationExit(f.p, { ...f.terminal(f.p.proxy!), state: 'finished', reason: 'exited' }, f.ports)).presentation?.visibility).toBe('ended');
  expect(f.hc.kill).not.toHaveBeenCalled();
});
test('unverified legacy target cannot authorize close', async () => {
  const f = await fixture(true); const legacy = { ...f.p, target: { ...f.p.target, createdMs: 0, generation: null } }; await f.ports.store.update(s => ({ ...s, presentations: [legacy] }));
  expect((await confirmPresentationClose({ id: legacy.id, expectedRevision: 1, operationId: 'close1', target: legacy.target }, f.ports)).status).toBe('refused'); expect(f.ports.closeSession).not.toHaveBeenCalled();
});

test('lost session shutdown acknowledgement completes from the exact finished incarnation', async () => {
  const f = await fixture(true);
  vi.mocked(f.ports.closeSession).mockResolvedValue('pending');
  await confirmPresentationClose({ id: f.p.id, expectedRevision: 1, operationId: 'close1', target: f.p.target }, f.ports);
  vi.mocked(f.hc.get).mockResolvedValue({ ...f.terminal(f.p.target.address), state: 'finished' });
  vi.mocked(f.ports.closeSession).mockRejectedValue(new Error('Source session endpoint has shut down'));
  expect(await reconcilePendingClose(f.p.id, f.ports)).toMatchObject({ status: 'complete', presentation: { visibility: 'ended' } });
  expect(f.hc.kill).not.toHaveBeenCalled();
});

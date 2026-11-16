// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { expect, test, vi } from 'vitest';
import { confirmPresentationClose } from '../../../herdr/src/panes/lifecycle.js';
import { projectPanePresentations } from '../../../herdr/assets/shared/presentations.js';
import { reconcilePaneRegistrations } from '../herdr/pane-registration.js';
import type { PaneAgentRow, PanePresentation, PaneTarget, PlacementState } from '../../../herdr/src/panes/types.js';
const target = { coreId: 'core-mac', terminalId: 't1', address: 'core-mac/t1', createdMs: 10, identityLabels: { 'spider.session': 'session-1', 'spider.pane-operation': 'open-1' }, alias: null, machineId: null, kind: 'session', sessionId: 'session-1', generation: 'gen-1', homeEpoch: 0, runId: null, consoleId: null, name: 'Example', cwd: '/home/example' } as const;
const row = { sessionId: 'session-1', generation: 'gen-1', target, unavailableReason: null, owner: { sessionId: 'session-1', generation: 'gen-1', terminal: { coreId: 'core-mac', terminalId: 't1', address: 'core-mac/t1', socket: '/owned/core.sock', sessionNamespace: 'fixture' }, cwd: '/home/example', sessionFile: null, name: 'Example' } } as unknown as Extract<PaneAgentRow, { unavailableReason: null }>;
const empty = (): PlacementState => ({ version: 2, revision: 0, presentations: [], slots: [], attempts: [], choices: [], launches: [] });
function fixture(state = empty()) { const store = { read: async () => state, update: async (change: (s: PlacementState) => PlacementState) => state = { ...change(state), revision: state.revision + 1 } }; const nativePlacement = vi.fn(async () => ({ space: 's1', tab: 'tb1', pane: 'p1' } as never)); return { store, nativePlacement }; }
test('native Mac sessions register native with no proxy launch claim', async () => {
  const f = fixture(); await reconcilePaneRegistrations({ ...f, localCoreId: 'core-mac', rows: [row] });
  expect((await f.store.read()).presentations).toMatchObject([{ mode: 'native', role: 'agent', proxy: null, launch: 'acknowledged', target }]);
  await reconcilePaneRegistrations({ ...f, localCoreId: 'core-mac', rows: [row] }); expect((await f.store.read()).presentations).toHaveLength(1);
});
test('tracked shell adopts exact source session incarnation, not a reused terminal', async () => {
  const state = empty(); const shell = { id: 'shell-1', revision: 1, mode: 'native', role: 'shell', target: { ...target, kind: 'terminal', sessionId: null, generation: null, homeEpoch: null }, proxy: null, slot: null, visibility: 'visible', launch: 'acknowledged', closeOperationId: null, conversion: null } as unknown as PanePresentation;
  state.presentations = [shell]; const f = fixture(state);
  await reconcilePaneRegistrations({ ...f, localCoreId: 'core-mac', rows: [row] });
  expect((await f.store.read()).presentations).toMatchObject([{ id: 'shell-1', revision: 2, role: 'agent', mode: 'native', target }]);
  const other = fixture({ ...empty(), presentations: [shell] }); await reconcilePaneRegistrations({ ...other, localCoreId: 'core-mac', rows: [{ ...row, target: { ...row.target!, createdMs: 11 } }] });
  expect((await other.store.read()).presentations[0]).toEqual(shell);
});
test('reload carries the same remote execution into its new generation without a second view', async () => {
  const p = { id: 'existing', revision: 4, mode: 'proxy', role: 'agent', target, proxy: 'proxy-1', slot: { space: 's1', tab: 'tb1', pane: 'p1' }, visibility: 'visible', launch: 'acknowledged', closeOperationId: null, conversion: null } as unknown as PanePresentation;
  const f = fixture({ ...empty(), presentations: [p] });
  const reloaded = { ...row, generation: 'gen-2', owner: { ...row.owner, generation: 'gen-2' }, target: { ...target, generation: 'gen-2', identityLabels: { ...target.identityLabels, 'spider.generation': 'gen-2' } }, children: [], consoles: [], updatedAt: 2, status: 'working', name: 'Example', machineKey: 'box-1.invalid' } as unknown as typeof row;
  await reconcilePaneRegistrations({ ...f, localCoreId: 'core-local', rows: [reloaded] });
  const state = await f.store.read(), current = state.presentations[0];
  expect(state.presentations).toHaveLength(1);
  expect(current).toMatchObject({ id: 'existing', revision: 5, proxy: 'proxy-1', slot: p.slot, target: { generation: 'gen-2' } });
  expect(projectPanePresentations({ agents: [reloaded], presentations: state.presentations, native: [], localCoreId: 'core-local' })[0])
    .toMatchObject({ presentationId: 'existing', generation: 'gen-2', displayTerminal: 'proxy-1', tab: 'tb1' });
  const closeSession = vi.fn(async () => 'ended' as const);
  const ports = { store: f.store, app: null, hc: { get: async () => ({ address: current.target.address, state: 'live', labels: current.target.identityLabels }) } as never,
    validateTarget: async (candidate: PaneTarget) => { if (candidate.generation !== 'gen-2') throw new Error('stale owner'); return candidate; }, closeSession };
  expect(await confirmPresentationClose({ id: current.id, expectedRevision: p.revision, target: p.target, operationId: 'old-close' }, ports))
    .toMatchObject({ status: 'refused' });
  expect(await confirmPresentationClose({ id: current.id, expectedRevision: current.revision, target: current.target, operationId: 'new-close' }, ports))
    .toMatchObject({ status: 'complete', reason: 'target-ended' });
  expect(closeSession).toHaveBeenCalledWith(expect.objectContaining({ generation: 'gen-2' }), 'new-close');
});
test('reload cannot rebind a closing pane or a different terminal incarnation', async () => {
  for (const changed of [{ visibility: 'closing' as const, createdMs: 10 }, { visibility: 'visible' as const, createdMs: 11 }]) {
    const p = { id: 'existing', revision: 4, mode: 'proxy', role: 'agent', target, proxy: 'proxy-1', slot: null, visibility: changed.visibility, launch: 'acknowledged', closeOperationId: changed.visibility === 'closing' ? 'close-1' : null, conversion: null } as unknown as PanePresentation;
    const f = fixture({ ...empty(), presentations: [p] });
    await reconcilePaneRegistrations({ ...f, localCoreId: 'core-local', rows: [{ ...row, generation: 'gen-2' as never, target: { ...target, generation: 'gen-2' as never, createdMs: changed.createdMs } }] });
    expect((await f.store.read()).presentations).toEqual([p]);
  }
});
test('remote discovery records unplaced identity without creating a program or local proxy', async () => {
  const f = fixture(); await reconcilePaneRegistrations({ ...f, localCoreId: 'another-core', rows: [row] });
  expect((await f.store.read()).presentations).toMatchObject([{ mode: 'proxy', target, proxy: null, slot: null, launch: 'none' }]); expect(f.nativePlacement).not.toHaveBeenCalled();
});

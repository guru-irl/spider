// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { expect, test, vi } from 'vitest';
import { reconcilePaneRegistrations } from '../herdr/pane-registration.js';
import type { PaneAgentRow, PanePresentation, PlacementState } from '../../../herdr/src/panes/types.js';
const target = { coreId: 'core-mac', terminalId: 't1', address: 'core-mac/t1', createdMs: 10, identityLabels: { 'spider.session': 'session-1', 'spider.pane-operation': 'open-1' }, alias: null, machineId: null, kind: 'session', sessionId: 'session-1', generation: 'gen-1', homeEpoch: 0, runId: null, consoleId: null, name: 'Example', cwd: '/home/example' } as const;
const row = { sessionId: 'session-1', generation: 'gen-1', target, unavailableReason: null, owner: { sessionId: 'session-1' } } as unknown as Extract<PaneAgentRow, { unavailableReason: null }>;
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
test('remote discovery records unplaced identity without creating a program or local proxy', async () => {
  const f = fixture(); await reconcilePaneRegistrations({ ...f, localCoreId: 'another-core', rows: [row] });
  expect((await f.store.read()).presentations).toMatchObject([{ mode: 'proxy', target, proxy: null, slot: null, launch: 'none' }]); expect(f.nativePlacement).not.toHaveBeenCalled();
});

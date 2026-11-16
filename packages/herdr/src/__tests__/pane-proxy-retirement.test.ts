// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { paths } from '@spider/db-core';
import { afterEach, expect, test, vi } from 'vitest';
import type { AppClient, AppPaneInspection, HcClient, OwnerPlacement, TerminalAddress } from '../contracts.js';
import { parsePanePresentation, parsePaneTarget } from '../panes/codec.js';
import { convertNativePresentation, type PaneOpenPorts } from '../panes/open.js';
import { createPanePlacementStore } from '../panes/store.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture(state: 'live' | 'finished', changed: Record<string, string> = {}) {
  const scratch = paths.scratch('worktree', process.cwd()); await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, 'retire-')); roots.push(root);
  const store = createPanePlacementStore(root);
  const target = parsePaneTarget({ coreId: 'core-remote', terminalId: 't2', address: 'core-remote/t2', createdMs: 12, identityLabels: { 'spider.session': 'session-1', 'spider.generation': 'gen-1' }, alias: 'box-1.invalid', machineId: null, kind: 'session', sessionId: 'session-1', generation: 'gen-1', homeEpoch: 1, runId: null, consoleId: null, name: null, cwd: null });
  const destination = parsePaneTarget({ ...target, coreId: 'core-local', terminalId: 't5', address: 'core-local/t5', createdMs: 15, generation: 'gen-2', homeEpoch: 2, alias: null, identityLabels: { 'spider.session': 'session-1', 'spider.generation': 'gen-2' } });
  const slot = { space: 'space-1', tab: 'tab-1', pane: 'pane-1' } as OwnerPlacement;
  const presentation = parsePanePresentation({ id: 'pane-1', revision: 1, mode: 'proxy', role: 'agent', target, proxy: 'core-local/t3', slot, visibility: 'visible', launch: 'acknowledged', closeOperationId: null, conversion: null });
  await store.update(current => ({ ...current, presentations: [presentation] }));
  const placements = new Map<TerminalAddress, OwnerPlacement>([[presentation.proxy!, slot]]);
  const app = {
    ownerPlacement: async (address: TerminalAddress) => { const found = placements.get(address); if (!found) throw Error('unplaced'); return found; },
    focusedPane: async () => slot,
    tabTerminals: async () => [...placements.keys()],
    command: vi.fn(async (name: string, args: Record<string, unknown>) => {
      if (name === 'terminal.keep') placements.set(args.terminal as TerminalAddress, { ...slot, pane: 'replacement' as never });
      if (name === 'terminal.park') placements.delete(args.terminal as TerminalAddress);
      return {};
    }),
  } as unknown as AppClient & AppPaneInspection;
  const hc = {
    identity: async () => ({ coreId: 'core-local', socket: '/fixture/core.sock', sessionNamespace: 'fixture' }),
    get: vi.fn(async (address: TerminalAddress) => ({ address, state, labels: { 'spider.kind': 'pane-proxy', 'spider.pane-id': presentation.id, 'spider.pane-operation': presentation.id, 'spider.owner-generation': 'gen-1', 'spider.target-core': target.coreId, 'spider.target-terminal': target.terminalId, ...changed } })),
    kill: vi.fn(async () => {}), rm: vi.fn(async () => {}),
  };
  const launchTarget = vi.fn(async () => { throw Error('must not launch execution'); });
  const ports = { store, hc: hc as unknown as HcClient, app, launchTarget, validateTarget: async value => value,
    appCapabilities: async () => ({ backgroundTabCreation: false, explicitTargetSwap: false, noFocusConversion: false, commandDigest: 'a'.repeat(64) }),
    awaitPresented: async address => app.ownerPlacement(address),
  } as PaneOpenPorts;
  const run = () => convertNativePresentation({ presentation, destination, source: slot, sourceFocused: true }, ports);
  return { run, hc, app, presentation, launchTarget };
}
test.each(['finished', 'live'] as const)('a matching %s display retires without touching execution', async state => {
  const f = await fixture(state);
  expect(await f.run()).toMatchObject({ status: 'complete', reason: 'native-view-converted' });
  if (state === 'finished') expect(f.hc.kill).not.toHaveBeenCalled();
  else expect(f.hc.kill).toHaveBeenCalledExactlyOnceWith(f.presentation.proxy);
  expect(f.hc.rm).not.toHaveBeenCalled(); expect(f.launchTarget).not.toHaveBeenCalled();
});
test.each([
  { 'spider.owner-generation': 'another-generation' },
  { 'spider.target-terminal': 't99' },
  { 'spider.target-core': 'core-foreign' },
  { 'spider.pane-id': 'another-pane' },
])('a finished display with mismatched ownership is refused: %j', async changed => {
  const f = await fixture('finished', changed);
  expect(await f.run()).toMatchObject({ status: 'refused', reason: 'source-retirement-unverified' });
  expect(f.hc.kill).not.toHaveBeenCalled(); expect(f.hc.rm).not.toHaveBeenCalled(); expect(f.launchTarget).not.toHaveBeenCalled();
  expect(f.app.command).not.toHaveBeenCalledWith('terminal.park', { terminal: f.presentation.proxy });
});

// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { expect, test } from 'vitest';
import { createHerdrHarness } from './testutil.js';
import type { AppClient, JobId, OwnerPlacement, PaneId, RunId, TerminalAddress } from '../contracts.js';
import { HERDR_KINDS, HERDR_LABELS } from '../contracts.js';
import { createAuxiliaryPanes } from '../jobs/placement.js';

async function priorityScenario(mode: 'fake' | 'hc') {
  const h = await createHerdrHarness(mode);
  let panes: ReturnType<typeof createAuxiliaryPanes> | undefined;
  try {
    await h.start();
    const owner = h.owner!, hc = h.hc;
    const placement = { space: 'space', tab: 'tab', pane: 'agent-pane' } as OwnerPlacement;
    const placements = new Map<TerminalAddress, OwnerPlacement>([[owner.terminal.address, placement]]);
    const parked: TerminalAddress[] = [], commands: { name: string; args: Readonly<Record<string, unknown>> }[] = [];
    const app: AppClient = {
      ownerPlacement: async address => { const p = placements.get(address); if (!p) throw Object.assign(new Error('unplaced'), { code: 'owner-unplaced' }); return p; },
      awaitPane: async (address, p) => {
        const terminal = await hc.get(address);
        expect(terminal.labels['herdr.space']).toBe('space'); expect(terminal.labels['herdr.tab']).toBe('tab');
        const pane = `pane-${address}` as PaneId;
        placements.set(address, { ...p, pane }); return pane;
      },
      command: async (name, args) => {
        commands.push({ name, args });
        if (name === 'terminal.keep') { if (args.place !== 'tab') throw new Error('Expected tab placement'); placements.set(args.terminal as TerminalAddress, { ...placement, tab: 'extra-tab' as never, pane: `pane-${args.terminal}` as never }); return {}; }
        if (name === 'pane.focus') { if (!placements.has(args.terminal as TerminalAddress)) throw new Error('No such pane'); return {}; }
        expect(name).toBe('terminal.park');
        const address = args.terminal as TerminalAddress;
        expect(address).not.toBe(owner.terminal.address);
        parked.push(address); placements.delete(address); return {};
      },
    };
    const launch = async (kind: string, key: string) => (await hc.run({ argv: [h.nodeBinary, '-e', 'setInterval(() => {}, 1000)'], cwd: h.root,
      parent: kind === HERDR_KINDS.subagentViewer ? owner.terminal.address : null,
      labels: { [HERDR_LABELS.kind]: kind, [HERDR_LABELS.session]: owner.sessionId, [HERDR_LABELS.ownerCore]: owner.terminal.coreId,
        [HERDR_LABELS.ownerTerminal]: owner.terminal.terminalId, ...(kind === HERDR_KINDS.remoteConsole ? { [HERDR_LABELS.machine]: 'remote.invalid' }
          : { [kind === HERDR_KINDS.subagentViewer ? HERDR_LABELS.run : HERDR_LABELS.job]: key }) },
      background: true, outliveParent: kind !== HERDR_KINDS.subagentViewer, noNotify: true })).address;
    panes = createAuxiliaryPanes({ hc, discardSubagentViewer: async (_id, _owner, viewer) => { await hc.kill(viewer); await hc.rm(viewer); }, app, limit: 2, clock: Date.now, subagentViewer: id => launch(HERDR_KINDS.subagentViewer, id) });
    const first = await panes.acquire('subagent', 'first' as RunId, owner, { timeoutMs: 10000, automatic: true });
    const second = await panes.acquire('subagent', 'second' as RunId, owner, { timeoutMs: 10000, automatic: true });
    expect(first).not.toBeNull(); expect(second).not.toBeNull();
    expect(await panes.acquire('subagent', 'third' as RunId, owner, { timeoutMs: 10000, automatic: true })).toBeNull();
    expect(placements.size).toBe(3);
    // A job reservation neither consumes capacity nor evicts a viewer.
    const slot = await panes.reserveRemote('job' as JobId, owner, { timeoutMs: 1 });
    expect(placements.size).toBe(3); expect(parked).toHaveLength(1);
    const observer = await launch(HERDR_KINDS.remoteObserver, 'job');
    await panes.display(slot, observer, { timeoutMs: 10000 });
    expect(parked[1]).toBe(first!.viewer);
    const consoleSlot = await panes.reserveRemote('console:remote.invalid/console' as JobId, owner, { timeoutMs: 1 });
    const consoleViewer = await launch(HERDR_KINDS.remoteConsole, 'console:remote.invalid/console');
    await panes.display(consoleSlot, consoleViewer, { timeoutMs: 10000 });
    expect(parked[2]).toBe(observer);
    const fourth = await panes.acquire('subagent', 'fourth' as RunId, owner, { timeoutMs: 10000 });
    expect(parked).not.toContain(consoleViewer);
    expect(commands.filter(command => command.name === 'terminal.keep')).toEqual([{ name: 'terminal.keep', args: { terminal: fourth!.viewer, place: 'tab' } }]);
    expect(commands.at(-1)).toEqual({ name: 'pane.focus', args: { terminal: fourth!.viewer } });
    expect(placements.has(second!.viewer)).toBe(true);
    expect(placements.get(owner.terminal.address)).toEqual({ space: 'space', tab: 'tab', pane: 'agent-pane' });
    const calls = await h.calls();
    const runs = calls.filter(call => call.argv[0] === 'run');
    expect(runs.every(call => call.argv.includes('--no-notify'))).toBe(true);
    expect(calls.some(call => call.argv[0] === 'resize')).toBe(false);
    if (mode === 'hc') {
      const original = await h.cli(['get', owner.terminal.address, '--json']) as { cols: number; rows: number };
      expect([original.cols, original.rows]).toEqual([200, 120]);
    }
  } finally { await panes?.dispose(); await h.close(); }
  expect(await h.remainingOwnedResources()).toEqual([]);
  expect(h.cleanupProof).toMatchObject({ remaining: [], defaultCoreUnchanged: true });
}

test('fake hc preserves agent panes while applying auxiliary priority', () => priorityScenario('fake'), 30000);
test.skipIf(process.env.SPIDER_HERDR_E2E !== '1')('real isolated hc preserves agent panes, no app window; requires SPIDER_HERDR_E2E=1', () => priorityScenario('hc'), 30000);

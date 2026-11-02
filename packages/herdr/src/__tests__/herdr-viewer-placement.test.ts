// SPDX-License-Identifier: MIT
import { expect, test } from 'vitest';
import { createAuxiliaryPanes } from '../jobs/placement.js';
import { HerdrError } from '../client/parse.js';
import type { AppClient, HcClient, Owner, OwnerPlacement, RunId, TerminalAddress, TerminalSummary } from '../contracts.js';

function fixture() {
  const owner = { sessionId: 'owner-session', generation: 'activation', terminal: { coreId: 'core', terminalId: 'owner', address: 'owner', socket: '/fixture/core.sock', sessionNamespace: 'fixture' }, cwd: '/fixture', sessionFile: null, name: null } as Owner;
  const ownerPlacement = { space: 'space', tab: 'owner-tab', pane: 'owner-pane' } as OwnerPlacement;
  const layout = new Map<TerminalAddress, OwnerPlacement>([[owner.terminal.address, ownerPlacement]]);
  const terminals = new Map<TerminalAddress, TerminalSummary>();
  const commands: { name: string; args: Readonly<Record<string, unknown>> }[] = [], reports: unknown[] = [];
  let failure: 'pane' | 'tab' | 'park' | null = null, launches = 0, failCleanup = false;
  const failed = new HerdrError('pane-timeout', 'Placement acknowledgement timed out');
  const unplaced = () => new HerdrError('owner-unplaced', 'Terminal is parked');
  const app: AppClient = {
    tabTerminals: async target => [...layout].filter(([, p]) => p.space === target.space && p.tab === target.tab).map(([address]) => address), ownerPlacement: async address => { const placement = layout.get(address); if (!placement) throw unplaced(); return placement; },
    awaitPane: async (viewer, placement) => {
      // A partial placement must also be parked when its acknowledgement fails.
      const placed = { ...placement, pane: `pane-${viewer}` as OwnerPlacement['pane'] }; layout.set(viewer, placed);
      if (failure === 'pane') throw failed;
      return placed.pane;
    },
    command: async (name, args) => {
      commands.push({ name, args });
      const viewer = args.terminal as TerminalAddress;
      if (name === 'terminal.park') { if (failCleanup) throw new HerdrError('app-disconnected', 'Slow app during cleanup'); if (failure === 'park') throw failed; layout.delete(viewer); }
      if (name === 'terminal.keep') {
        if (failure === 'tab') return { error: { code: failed.code, message: failed.message } };
        layout.set(viewer, { ...ownerPlacement, tab: `tab-${viewer}` as OwnerPlacement['tab'], pane: `pane-${viewer}` as OwnerPlacement['pane'] });
      }
      return {};
    },
  };
  const hc = {
    events: () => ({ ready: Promise.resolve(), subscribe: () => () => {}, dispose() {} }),
    get: async (address: TerminalAddress) => { const terminal = terminals.get(address); if (!terminal) throw new HerdrError('not_found', 'No terminal'); return terminal; },
    setLabels: async () => {},
    kill: async (address: TerminalAddress) => { terminals.get(address)!.state = 'finished'; },
    rm: async (address: TerminalAddress) => { terminals.delete(address); },
  } as unknown as HcClient;
  const panes = createAuxiliaryPanes({ automaticSubagentPanes: true, hc, discardSubagentViewer: async (_id, _owner, viewer) => { await hc.kill(viewer); await hc.rm(viewer); }, app, limit: 1, clock: Date.now, reportError: error => reports.push(error), subagentViewer: async id => {
    const address = `viewer-${id}` as TerminalAddress;
    if (!terminals.has(address)) {
      launches++;
      terminals.set(address, { address, parent: owner.terminal.address, labels: { 'spider.kind': 'subagent-viewer', 'spider.run': id, 'spider.session': owner.sessionId, 'spider.owner-core': owner.terminal.coreId, 'spider.owner-terminal': owner.terminal.terminalId }, state: 'live', status: null, exitCode: null, reason: null, signal: null, finishedAt: null });
    }
    return address;
  } });
  return { owner, panes, layout, terminals, commands, reports, failed, launches: () => launches, fail: (value: typeof failure) => { failure = value; }, failCleanup: () => { failCleanup = true; } };
}
const first = '10000000-0000-4000-8000-000000000001' as RunId;
const second = '10000000-0000-4000-8000-000000000002' as RunId;
const address = (id: RunId) => `viewer-${id}` as TerminalAddress;

test.each([true, false])('a viewer survives parked when placement fails after launch (automatic: %s)', async automatic => {
  const f = fixture(); f.fail('pane');
  try {
    await expect(f.panes.acquire('subagent', first, f.owner, { automatic, timeoutMs: 100 })).rejects.toBe(f.failed);
    expect(f.terminals.get(address(first))).toMatchObject({ state: 'live', labels: { 'spider.kind': 'subagent-viewer', 'spider.run': first, 'spider.session': f.owner.sessionId } });
    expect(f.layout.has(address(first))).toBe(false);
    expect(f.commands).toContainEqual({ name: 'terminal.park', args: { terminal: address(first) } });
    f.fail(null);
    expect(await f.panes.acquire('subagent', first, f.owner, { automatic: false, timeoutMs: 100 })).toMatchObject({ viewer: address(first) });
    expect(f.launches()).toBe(1);
    expect(f.commands).toContainEqual({ name: 'pane.focus', args: { terminal: address(first) } });
  } finally { await f.panes.dispose(); }
});

test('automatic pane cleanup failures do not produce user warnings', async () => {
  const f = fixture(); f.fail('pane'); f.failCleanup();
  try {
    await expect(f.panes.acquire('subagent', first, f.owner, { automatic: true, timeoutMs: 100 })).rejects.toBe(f.failed);
    expect(f.terminals.get(address(first))?.state).toBe('live');
    expect(f.reports).toEqual([]);
  } finally { await f.panes.dispose(); }
});

test('an explicit full-slot tab failure preserves both viewers and can be retried without relaunching', async () => {
  const f = fixture();
  try {
    await f.panes.acquire('subagent', first, f.owner, { automatic: true, timeoutMs: 100 });
    f.fail('tab');
    await expect(f.panes.acquire('subagent', second, f.owner, { automatic: false, timeoutMs: 100 })).rejects.toBeInstanceOf(HerdrError);
    expect(f.terminals.get(address(first))?.state).toBe('live'); expect(f.layout.has(address(first))).toBe(true);
    expect(f.terminals.get(address(second))?.state).toBe('live'); expect(f.layout.has(address(second))).toBe(false);
    expect(f.commands).toContainEqual({ name: 'terminal.keep', args: { terminal: address(second), place: 'tab' } });
    f.fail(null);
    expect(await f.panes.acquire('subagent', second, f.owner, { automatic: false, timeoutMs: 100 })).toMatchObject({ viewer: address(second) });
    expect(f.layout.get(address(second))?.tab).not.toBe(f.layout.get(address(first))?.tab);
    expect(f.commands).toContainEqual({ name: 'pane.focus', args: { terminal: address(second) } });
    expect(f.launches()).toBe(2);
    const kept = f.commands.filter(call => call.name === 'terminal.keep').length;
    await f.panes.acquire('subagent', first, f.owner, { automatic: false, timeoutMs: 100 });
    expect(f.commands.at(-1)).toEqual({ name: 'pane.focus', args: { terminal: address(first) } });
    expect(f.commands.filter(call => call.name === 'terminal.keep')).toHaveLength(kept);
  } finally { await f.panes.dispose(); }
});

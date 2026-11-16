// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { createClientFixture } from './testutil.js';
import { HerdrError } from '../client/parse.js';
import { createPresentedAuxiliaryPanes } from '../panes/auxiliary.js';
import { connectPaneService, servePaneRequests } from '../panes/socket.js';
import { registerHerdrViewers } from '../viewers/register.js';
import * as hostPorts from '../../../host/src/herdr/ports.js';
import type { PanePresentation, PaneServiceRequest, PaneTarget } from '../panes/types.js';
import type { AppClient, AppPaneInspection, ConsoleId, CoreId, HcClient, HcEvent, HcRunRequest, Owner, OwnerPlacement, RunId, TerminalAddress, TerminalSummary } from '../contracts.js';

const run1 = 'run-1' as RunId, run2 = 'run-2' as RunId, consoleId = ('console-' + 'a'.repeat(64)) as ConsoleId;
async function fixture(cols = 120, rows = 40) {
  const files = await createClientFixture();
  const owners = [1, 2].map(n => ({ sessionId: `session-${n}`, generation: `generation-${n}`, name: `Owner ${n}`, cwd: '/home/example', sessionFile: null,
    terminal: { coreId: `source-core-${n}`, terminalId: `source-${n}`, address: `source-core-${n}/source-${n}`, socket: '/home/example/core.sock', sessionNamespace: 'fixture' } }) as Owner);
  const displays = ['owner-display-1', 'owner-display-2'] as TerminalAddress[];
  const placement = { space: 'mac-space', tab: 'mac-tab', pane: 'owner-pane-1' } as OwnerPlacement;
  const layout = new Map<TerminalAddress, OwnerPlacement>(displays.map((address, n) => [address, { ...placement, pane: `owner-pane-${n + 1}` as OwnerPlacement['pane'] }]));
  const order = new Map<string, TerminalAddress[]>([['mac-tab', [...displays]]]);
  const tabs = ['mac-tab'];
  const terminal = (address: TerminalAddress, labels: Record<string, string> = {}): TerminalSummary => ({ address, parent: null, labels, state: 'live', status: null, exitCode: null, reason: null, signal: null, finishedAt: null, cols, rows });
  const terminals = new Map<TerminalAddress, TerminalSummary>(displays.map(address => [address, terminal(address, { 'spider.kind': 'pane-proxy' })]));
  const lookups: TerminalAddress[] = [], killed: TerminalAddress[] = [], timeline: string[] = [];
  const launches: { owner: Owner; id: RunId | ConsoleId; lease: string }[] = [], stopped: string[] = [];
  const listeners = new Set<(event: HcEvent) => void>(), actors: ReturnType<typeof createPresentedAuxiliaryPanes>[] = [];
  let focused = placement, sequence = 0, hold: (() => Promise<void>) | undefined;
  const insert = (address: TerminalAddress, target: OwnerPlacement, after?: TerminalAddress) => {
    layout.set(address, target);
    const entries = order.get(target.tab) ?? [];
    const previous = entries.indexOf(address); if (previous >= 0) entries.splice(previous, 1);
    const index = after ? entries.indexOf(after) + 1 : entries.length;
    entries.splice(index < 0 ? entries.length : index, 0, address); order.set(target.tab, entries);
  };
  const app: AppClient & AppPaneInspection = {
    async ownerPlacement(address) {
      lookups.push(address);
      if (owners.some(owner => owner.terminal.address === address)) throw new Error('Remote app lookup is forbidden');
      const found = layout.get(address); if (!found) throw new HerdrError('owner-unplaced', 'No displayed pane'); return found;
    },
    async tabTerminals(target) { return [...(order.get(target.tab) ?? [])]; },
    async tabPanes(target) { return (order.get(target.tab) ?? []).map(address => ({ terminal: address, pane: layout.get(address)!.pane })); },
    async tabIndex(target) { return tabs.indexOf(target.tab); },
    async focusedPane() { return focused; },
    async awaitPane(address, target) {
      timeline.push(`placement:${address}`); await hold?.();
      const value = { ...target, pane: `pane-${address}` as OwnerPlacement['pane'] }; insert(address, value);
      timeline.push(`acknowledged:${address}`); return value.pane;
    },
    async command(name, args) {
      const address = args.terminal as TerminalAddress;
      if (name === 'pane.focus') {
        focused = args.pane ? [...layout.values()].find(p => p.pane === args.pane)! : layout.get(address)!;
      } else if (name === 'pane.go') {
        const entries = order.get(focused.tab) ?? [], current = entries.findIndex(item => layout.get(item)?.pane === focused.pane);
        if (entries[current + 1]) focused = layout.get(entries[current + 1])!;
      } else if (name === 'terminal.park') {
        const old = layout.get(address); layout.delete(address);
        if (old) order.set(old.tab, (order.get(old.tab) ?? []).filter(item => item !== address));
      } else if (name === 'terminal.keep') {
        const anchor = [...layout].find(([, p]) => p.pane === focused.pane)?.[0];
        focused = { ...focused, pane: `pane-${address}` as OwnerPlacement['pane'] }; insert(address, focused, anchor);
        return { pane: focused.pane, tab: focused.tab };
      } else if (name === 'tab.new') {
        const tab = `adjacent-${tabs.length}`; tabs.push(tab);
        return { space: placement.space, tab: tab as OwnerPlacement['tab'], pane: 'placeholder' as OwnerPlacement['pane'] };
      } else if (name === 'tab.move') {
        const current = tabs.indexOf(String(args.id)); if (current >= 0) tabs.splice(current, 1);
        tabs.splice(Number(args.index), 0, String(args.id));
      }
      return {};
    },
  };
  const hc = {
    identity: async () => ({ coreId: 'mac-core' as CoreId, socket: '/fixture/mac.sock', sessionNamespace: 'fixture' }),
    run: vi.fn(async (request: HcRunRequest) => {
      const address = `waiting-${++sequence}` as TerminalAddress;
      terminals.set(address, terminal(address, { ...request.labels }));
      timeline.push(`waiting:${address}:${request.labels['spider.session']}`);
      return { address, coreId: 'mac-core' as CoreId };
    }),
    get: async (address: TerminalAddress) => { const found = terminals.get(address); if (!found) throw new HerdrError('not_found', 'No terminal'); return found; },
    setLabels: async (address: TerminalAddress, labels: Readonly<Record<string, string | null>>) => {
      const found = terminals.get(address)!; const next = { ...found.labels };
      for (const [key, value] of Object.entries(labels)) { if (value === null) delete next[key]; else next[key] = value; }
      terminals.set(address, { ...found, labels: next });
    },
    kill: async (address: TerminalAddress) => { killed.push(address); terminals.delete(address); },
    rm: async (address: TerminalAddress) => { terminals.delete(address); },
    events: () => ({ ready: Promise.resolve(), lookup: async (address: TerminalAddress) => terminals.get(address) ?? null,
      subscribe: (listener: (event: HcEvent) => void) => { listeners.add(listener); return () => listeners.delete(listener); }, dispose: async () => {} }),
  } as unknown as HcClient;
  const makeActor = (automaticSubagentPanes = true) => {
    const actor = createPresentedAuxiliaryPanes({ hc, app, placementRoot: files.root, appIdentity: 'mac-app', limit: 1, automaticSubagentPanes, clock: Date.now,
      subagentViewer: async () => { throw new Error('Legacy source launch is forbidden'); }, discardSubagentViewer: async () => {},
      ownerPresentation: async owner => displays[owners.findIndex(actual => actual.sessionId === owner.sessionId)] ?? null,
      waitingPresentation: async (_kind, _id, owner) => hc.run({ argv: ['waiting-display'], cwd: null, parent: null, background: true, noNotify: true, outliveParent: true,
        labels: { 'spider.kind': 'pane-proxy', 'spider.session': owner.sessionId } }),
      observed: async reservation => layout.get(reservation.viewer)?.pane === reservation.pane,
      targetIsLive: async () => true,
      async launchTarget(kind, id, owner, leaseId) {
        launches.push({ owner, id, lease: leaseId }); timeline.push(`launch:${id}`);
        return { coreId: owner.terminal.coreId, terminalId: `view-${id}`, address: `${owner.terminal.coreId}/view-${id}`, createdMs: 1,
          identityLabels: {}, alias: `box-${owners.indexOf(owner) + 1}.invalid`, machineId: null, kind, sessionId: owner.sessionId,
          generation: owner.generation, homeEpoch: null, runId: kind === 'subagent' ? id : null, consoleId: kind === 'console' ? id : null, name: null, cwd: null } as PaneTarget;
      },
      bindTarget: async reservation => { timeline.push(`bound:${reservation.viewer}`); },
      renew: async () => {}, stop: async (_machine, lease) => { stopped.push(lease); },
    });
    actors.push(actor); return actor;
  };
  return { files, owners, displays, layout, terminals, tabs, lookups, killed, timeline, launches, stopped, hc, makeActor,
    holdAcknowledgement(wait: (() => Promise<void>) | undefined) { hold = wait; },
    async close() { for (const actor of actors) await actor.dispose(); await files.close(); },
  };
}

test('two box owners sharing a Mac tab reserve capacity once', async () => {
  const f = await fixture(), panes = f.makeActor();
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), requested = new Promise<void>(resolve => { entered = resolve; });
  f.holdAcknowledgement(async () => { entered(); await gate; });
  const first = panes.openPresented('subagent', run1, f.owners[0], { timeoutMs: 2000, automatic: true });
  try {
    await requested;
    const second = panes.openPresented('subagent', run2, f.owners[1], { timeoutMs: 2000, automatic: true });
    await vi.waitFor(() => expect(f.timeline.filter(event => event.startsWith('waiting:'))).toHaveLength(2));
    expect(f.timeline.filter(event => event.startsWith('placement:'))).toHaveLength(1);
    expect(f.launches).toEqual([]);
    release();
    const results = await Promise.all([first, second]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(f.launches).toHaveLength(1);
    expect(f.launches[0].owner).toBe(f.owners[0]);
    const shown = results.find(Boolean)!;
    expect(f.terminals.get(shown.viewer)?.labels).toMatchObject({ 'spider.pane-role': 'subagent', 'spider.session': shown.owner.sessionId,
      'spider.owner-generation': shown.owner.generation, 'spider.owner-core': shown.owner.terminal.coreId, 'spider.owner-terminal': shown.owner.terminal.terminalId });
    expect(f.layout.size).toBe(3);
    expect(f.lookups).not.toContain(f.owners[0].terminal.address);
    expect(f.lookups).not.toContain(f.owners[1].terminal.address);
    expect(f.displays.every(address => f.layout.has(address))).toBe(true);
  } finally { release(); await first.catch(() => {}); await f.close(); }
});

test('view launch follows acknowledged presentation', async () => {
  const f = await fixture(), panes = f.makeActor();
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), requested = new Promise<void>(resolve => { entered = resolve; });
  f.holdAcknowledgement(async () => { entered(); await gate; });
  const opening = panes.openPresented('subagent', run1, f.owners[0], { timeoutMs: 2000, userInitiated: false });
  try {
    await requested; expect(f.launches).toEqual([]);
    release(); const result = await opening;
    expect(result?.owner).toBe(f.owners[0]);
    expect(f.launches.map(launch => launch.owner)).toEqual([f.owners[0]]);
    expect(f.timeline.indexOf(`acknowledged:${result!.viewer}`)).toBeLessThan(f.timeline.indexOf(`launch:${run1}`));
    expect(f.timeline.indexOf(`launch:${run1}`)).toBeLessThan(f.timeline.indexOf(`bound:${result!.viewer}`));
  } finally { release(); await opening.catch(() => {}); await f.close(); }
});

test('separate Mac actors count each other\'s presented auxiliary panes', async () => {
  const f = await fixture(), first = f.makeActor(), second = f.makeActor();
  try {
    expect(await first.openPresented('subagent', run1, f.owners[0], { timeoutMs: 2000, automatic: true })).not.toBeNull();
    expect(await second.openPresented('subagent', run2, f.owners[1], { timeoutMs: 2000, automatic: true })).toBeNull();
    expect(f.launches.map(launch => launch.id)).toEqual([run1]);
    expect(f.layout.size).toBe(3);
    expect(f.displays.every(address => f.layout.has(address))).toBe(true);
  } finally { await f.close(); }
});

test('an automatic open in a full tab starts no placeholder process', async () => {
  const f = await fixture(), panes = f.makeActor();
  try {
    expect(await panes.openPresented('subagent', run1, f.owners[0], { timeoutMs: 2000, automatic: true })).not.toBeNull();
    vi.mocked(f.hc.run).mockClear();
    expect(await panes.openPresented('subagent', run2, f.owners[1], { timeoutMs: 2000, automatic: true })).toBeNull();
    expect(f.hc.run).not.toHaveBeenCalled();
    expect(f.launches.map(launch => launch.id)).toEqual([run1]);
    expect(f.layout.size).toBe(3);
  } finally { await f.close(); }
});

test('explicit open uses the adjacent tab when the owner tab is full', async () => {
  const f = await fixture(), panes = f.makeActor();
  try {
    const first = await panes.openPresented('subagent', run1, f.owners[0], { timeoutMs: 2000, automatic: true });
    const second = await panes.openPresented('subagent', run2, f.owners[1], { timeoutMs: 2000, ownerRelative: true });
    expect(f.layout.get(first!.viewer)).toMatchObject({ space: 'mac-space', tab: 'mac-tab' });
    expect(f.layout.get(second!.viewer)).toMatchObject({ space: 'mac-space', tab: 'adjacent-1' });
    expect(f.tabs).toEqual(['mac-tab', 'adjacent-1']);
    expect(f.launches.map(launch => launch.owner)).toEqual(f.owners);
  } finally { await f.close(); }
});

test('automatic opens are opt-in and undersized owners never start source views', async () => {
  const disabled = await fixture(), panes = disabled.makeActor(false), small = await fixture(59, 8), smallPanes = small.makeActor();
  try {
    expect(await panes.openPresented('subagent', run1, disabled.owners[0], { timeoutMs: 2000, automatic: true })).toBeNull();
    expect(await smallPanes.openPresented('subagent', run1, small.owners[0], { timeoutMs: 2000, automatic: true })).toBeNull();
    expect(disabled.timeline).toEqual([]); expect(disabled.launches).toEqual([]); expect(small.launches).toEqual([]);
  } finally { await disabled.close(); await small.close(); }
});

test('viewer registration sends automatic and explicit opens to the presentation service', async () => {
  const f = await fixture(), calls: PaneServiceRequest[] = [];
  let closed = 0; const server: { running?: { close(): Promise<void> } } = {};
  const service = { request: async (request: PaneServiceRequest) => { calls.push(request); return { version: 1 as const, kind: 'outcome' as const, outcome: { status: 'pending' as const, reason: 'view-unplaced', presentation: null } }; }, reconcile: async () => {}, stop: async () => {} };
  const root = join(f.files.root, 'panes');
  const connection = { root, identity: { coreId: 'mac-core' as CoreId, socket: f.files.localEnv.HC_SOCKET!, sessionNamespace: 'fl' }, startIfMissing: true,
    launchHelper: async () => { server.running = await servePaneRequests(root, service); return 'mac-core/service' as TerminalAddress; },
    probeHelper: async (address: TerminalAddress) => ({ address, parent: null, labels: { 'spider.kind': 'pane-service' }, state: 'live' as const, status: null, exitCode: null, reason: null, signal: null, finishedAt: null }),
  };
  const hooks = new Map<string, () => Promise<void>>();
  const panes = { reconcile: async () => {}, acquire: async () => { throw new Error('Legacy viewer placement is forbidden'); }, release: async () => {}, park: async () => {}, dispose: async () => {} };
  const invoke = (id: RunId, owner: Owner, request: { automatic: boolean; signal: AbortSignal }) => hostPorts.openPresentedRun({
    owner, id, ...request, automaticEnabled: true, localCore: 'mac-core' as CoreId, isCurrent: () => true,
    connect: async () => { const client = await connectPaneService(connection); return { request: client.request, stop: async () => { closed++; await client.stop(); } }; },
  });
  const registration = registerHerdrViewers({ on: (name: string, handler: () => Promise<void>) => { hooks.set(name, handler); } } as never, {
    owner: () => f.owners[0], hc: {} as HcClient, panes, presentedView: invoke, viewerLauncher: async () => { throw new Error('Source view cannot launch here'); },
    viewerExecutable: '/fixture/viewer', feedRoot: '/fixture', ipcDescriptor: () => null,
    ownedRunEvents: { list: async () => [run1], subscribe: () => () => {} },
  });
  try {
    expect(typeof hostPorts.openPresentedRun).toBe('function');
    await hooks.get('session_start')!();
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({ op: 'open-auxiliary', mode: 'automatic', sessionId: f.owners[0].sessionId, generation: f.owners[0].generation, view: { kind: 'subagent', runId: run1 } });
    expect(await registration.peek(run1)).toBeNull();
    expect(calls[1]).toMatchObject({ op: 'open-auxiliary', mode: 'explicit', sessionId: f.owners[0].sessionId, view: { kind: 'subagent', runId: run1 } });
    expect(closed).toBe(2);
  } finally { await registration.dispose(); await server.running?.close(); await f.close(); }
});

test('presented viewer requests refuse disabled automatic opens and invalid replies', async () => {
  const f = await fixture(), owner = f.owners[0], signal = new AbortController().signal;
  const target: PaneTarget = { coreId: owner.terminal.coreId, terminalId: 'view-1' as never, address: `${owner.terminal.coreId}/view-1` as never,
    createdMs: 1, identityLabels: {}, alias: 'box-1.invalid', machineId: null, kind: 'subagent', sessionId: owner.sessionId, generation: owner.generation,
    homeEpoch: null, runId: run1, consoleId: null, name: null, cwd: null };
  const presentation: PanePresentation = { id: 'view', revision: 1, mode: 'proxy', role: 'subagent', target, proxy: 'mac-core/display-1' as never,
    slot: { space: 'mac-space' as never, tab: 'mac-tab' as never, pane: 'pane-1' as never }, visibility: 'visible', launch: 'acknowledged', closeOperationId: null, conversion: null };
  let current = presentation, closed = 0;
  const connect = vi.fn(async () => ({ request: async () => ({ version: 1 as const, kind: 'outcome' as const, outcome: { status: 'complete' as const, reason: 'view-presented', presentation: current } }), stop: async () => { closed++; } }));
  const request = { owner, id: run1, automatic: true, automaticEnabled: false, signal, localCore: 'mac-core' as CoreId, isCurrent: () => true, connect };
  try {
    expect(typeof hostPorts.openPresentedRun).toBe('function');
    expect(await hostPorts.openPresentedRun(request)).toBeNull(); expect(connect).not.toHaveBeenCalled();
    expect(await hostPorts.openPresentedRun({ ...request, automatic: false })).toEqual({ address: 'mac-core/display-1', coreId: 'mac-core' });
    current = { ...presentation, target: { ...target, generation: 'successor' as never } };
    expect(await hostPorts.openPresentedRun({ ...request, automatic: false })).toBeNull();
    current = { ...presentation, proxy: 'source-core-1/display-1' as never };
    expect(await hostPorts.openPresentedRun({ ...request, automatic: false })).toBeNull();
    expect(closed).toBe(3);
    current = presentation;
    const abort = new AbortController(); let entered!: () => void, release!: () => void, cancelledClosed = 0;
    const started = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    const inFlight = hostPorts.openPresentedRun({ ...request, automatic: false, signal: abort.signal, connect: async () => ({
      request: async () => { entered(); await gate; return { version: 1 as const, kind: 'outcome' as const, outcome: { status: 'complete' as const, reason: 'view-presented', presentation: current } }; },
      stop: async () => { cancelledClosed++; },
    }) });
    await started; abort.abort(); release();
    expect(await inFlight).toBeNull(); expect(cancelledClosed).toBe(1);
  } finally { await f.close(); }
});

test('viewer priority replaces a console without touching either source owner', async () => {
  const f = await fixture(), panes = f.makeActor();
  try {
    const console = await panes.openPresented('console', consoleId, f.owners[0], { timeoutMs: 2000, userInitiated: false });
    const viewer = await panes.openPresented('subagent', run2, f.owners[1], { timeoutMs: 2000, userInitiated: false });
    expect(f.layout.has(console!.viewer)).toBe(false); expect(f.layout.has(viewer!.viewer)).toBe(true);
    expect(f.killed).toContain(console!.viewer);
    expect(f.owners.every(owner => !f.killed.includes(owner.terminal.address))).toBe(true);
    expect(f.displays.every(address => f.layout.has(address))).toBe(true);
  } finally { await f.close(); }
});

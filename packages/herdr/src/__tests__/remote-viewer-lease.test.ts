// SPDX-License-Identifier: MIT
import { afterEach, expect, test, vi } from 'vitest';
import { mkdir, mkdtemp, writeFile, rm, symlink } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { readViewerDisplayLease, runViewer } from '../viewers/program.js';
import { createViewerPorts } from '../viewers/ports.js';
import type { RunId, SessionId, Generation, SessionFeed } from '../contracts.js';
const runId = 'run-one' as RunId, sessionId = 'session-one' as SessionId, generation = 'generation-one' as Generation;
afterEach(() => vi.useRealTimers());
async function fixture() {
  const base = resolve('.spider/scratch/lease-tests'); await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, 'f-')); const file = join(root, 'display.json');
  const publish = (expiresAt: number) => writeFile(file, JSON.stringify({ version: 1, leaseId: 'lease-one', sessionId, generation, runId, consoleId: null, expiresAt }), { mode: 0o600 });
  return { root, file, publish, close: () => rm(root, { recursive: true, force: true }) };
}
test.each(['automatic', 'explicit'] as const)('expired display lease stops viewer not child (%s)', async intent => {
  const f = await fixture(); vi.useFakeTimers(); vi.setSystemTime(100000);
  await f.publish(Date.now() + 20000);
  const abort = new AbortController(), child = { state: 'live' }; let state = 'live', released = 0;
  const running = runViewer({ runId, sessionId, generation, displayLeaseFile: f.file, intent, feedRoot: f.root, stdin: new PassThrough(), stdout: new PassThrough(), signal: abort.signal,
    createClient: () => { throw new Error('No source IPC until feed exists'); }, feedSource: { read: async () => null, subscribe: () => () => {} }, release: async () => { released++; },
  }).then(() => { state = 'finished'; });
  try {
    await vi.advanceTimersByTimeAsync(19999); expect(state).toBe('live');
    await vi.advanceTimersByTimeAsync(1); await running;
    expect(state).toBe('finished'); expect(child.state).toBe('live'); expect(released).toBe(1);
  } finally { abort.abort(); await running; await f.close(); }
});
test('expired lease reaps a viewer even while its source feed read is stalled', async () => {
  const f = await fixture(); vi.useFakeTimers(); vi.setSystemTime(100000); await f.publish(Date.now() + 20000);
  const abort = new AbortController(); let finished = false, releaseRead!: () => void;
  const waiting = new Promise<void>(resolve => { releaseRead = resolve; });
  const running = runViewer({ runId, sessionId, generation, displayLeaseFile: f.file, feedRoot: f.root, stdin: new PassThrough(), stdout: new PassThrough(), signal: abort.signal,
    createClient: () => { throw new Error('No IPC'); }, feedSource: { read: async () => { await waiting; return null; }, subscribe: () => () => {} },
  }).then(() => { finished = true; });
  try { await vi.advanceTimersByTimeAsync(20000); await vi.waitFor(() => expect(finished).toBe(true), { timeout: 100 }); }
  finally { abort.abort(); releaseRead(); await running; await f.close(); }
});
test('expired lease reaps a stalled IPC subscription and disposes its late connection', async () => {
  const f = await fixture(); vi.useFakeTimers(); vi.setSystemTime(100000); await f.publish(Date.now() + 20000);
  const abort = new AbortController(); let finished = false, disposed = 0;
  let releaseSubscribe!: (value: { closed: Promise<void>; dispose(): void }) => void;
  const subscribing = new Promise<{ closed: Promise<void>; dispose(): void }>(resolve => { releaseSubscribe = resolve; });
  const feed = { sessionId, generation, revision: 1, updatedAt: Date.now(), lifecycle: 'live', owner: { sessionId, generation, name: 'Writer' }, runs: { rows: [] }, ipc: { address: '/fixture/ipc', capabilityFile: '/fixture/cap' } } as unknown as SessionFeed;
  const running = runViewer({ runId, sessionId, generation, displayLeaseFile: f.file, feedRoot: f.root, stdin: new PassThrough(), stdout: new PassThrough(), signal: abort.signal,
    createClient: () => ({ subscribeRun: async () => subscribing }), feedSource: { read: async () => feed, subscribe: () => () => {} },
  }).then(() => { finished = true; });
  try { await vi.advanceTimersByTimeAsync(20000); await vi.waitFor(() => expect(finished).toBe(true), { timeout: 100 }); }
  finally { abort.abort(); releaseSubscribe({ closed: new Promise(() => {}), dispose: () => { disposed++; } }); await running; await f.close(); }
  await vi.waitFor(() => expect(disposed).toBe(1), { timeout: 100 });
});
test('lease boundary rejects foreign generation, expired, public and symlink files', async () => {
  const f = await fixture();
  try {
    await f.publish(40000);
    expect(await readViewerDisplayLease(f.file, { sessionId, generation, runId }, 20000)).toBe(true);
    expect(await readViewerDisplayLease(f.file, { sessionId, generation: 'old', runId }, 20000)).toBe(false);
    expect(await readViewerDisplayLease(f.file, { sessionId, generation, runId }, 40000)).toBe(false);
    const link = join(f.root, 'link'); await symlink(f.file, link);
    expect(await readViewerDisplayLease(link, { sessionId, generation, runId }, 20000)).toBe(false);
    const publicFile = join(f.root, 'public'); await writeFile(publicFile, await import('node:fs/promises').then(fs => fs.readFile(f.file)), { mode: 0o644 });
    expect(await readViewerDisplayLease(publicFile, { sessionId, generation, runId }, 20000)).toBe(false);
  } finally { await f.close(); }
});
test('leased viewer refuses a successor generation before source IPC', async () => {
  const f = await fixture(); await f.publish(Date.now() + 20000); let clients = 0;
  const feed = { sessionId, generation: 'successor', owner: { sessionId, generation: 'successor', name: 'Writer' } } as SessionFeed;
  const abort = new AbortController(); let finished = false;
  const running = runViewer({ runId, sessionId, generation, displayLeaseFile: f.file, feedRoot: f.root, stdin: new PassThrough(), stdout: new PassThrough(), signal: abort.signal,
    createClient: () => { clients++; throw new Error('Successor IPC must not be used'); }, feedSource: { read: async () => feed, subscribe: () => () => {} } }).then(() => { finished = true; });
  try {
    await expect.poll(() => finished, { timeout: 100 }).toBe(true); expect(clients).toBe(0);
  } finally { abort.abort(); await running; await f.close(); }
});
test('leased viewer arguments require an absolute lease and generation together', () => {
  const args = ['--session', sessionId, '--run', runId, '--feed-root', '/fixture'];
  const io = { stdin: new PassThrough(), stdout: new PassThrough() };
  expect(createViewerPorts([...args, '--display-lease', '/fixture/lease', '--generation', generation], io)).toMatchObject({ generation, displayLeaseFile: '/fixture/lease' });
  expect(() => createViewerPorts([...args, '--display-lease', '/fixture/lease'], io)).toThrow();
  expect(() => createViewerPorts([...args, '--generation', generation], io)).toThrow();
  expect(() => createViewerPorts([...args, '--display-lease', '../lease', '--generation', generation], io)).toThrow();
});


import { createPresentedAuxiliaryPanes } from '../panes/auxiliary.js';
import { createAuxiliaryPanes, type AuxiliaryPaneOptions } from '../jobs/placement.js';
import { HerdrError } from '../client/parse.js';
import type { PaneTarget } from '../panes/types.js';
import type { AppClient, AppPaneInspection, ConsoleId, CoreId, HcClient, HcEvent, HcRunRequest, Owner, OwnerPlacement, TerminalAddress, TerminalSummary } from '../contracts.js';
const run = '10000000-0000-4000-8000-000000000001' as RunId;
const consoleId = '10000000-0000-4000-8000-000000000002' as ConsoleId;
const otherRun = '10000000-0000-4000-8000-000000000003' as RunId;
const display = 't1' as TerminalAddress;
const macCore = 'mac-core' as CoreId;
function macFixture(cols = 200, rows = 60, limit = 2) {
  const owner = { sessionId: 'session', generation: 'generation', name: 'Writer', cwd: '/home/example/work', sessionFile: null,
    terminal: { coreId: 'box-core', terminalId: 't7', address: 'box-1.invalid/t7', socket: '/home/example/core.sock', sessionNamespace: 'default' } } as Owner;
  const placement = { space: 'mac-space', tab: 'mac-tab', pane: 'owner-pane' } as OwnerPlacement;
  const layout = new Map<TerminalAddress, OwnerPlacement>([[display, placement]]);
  const terminal = (address: TerminalAddress, labels: Record<string, string> = {}): TerminalSummary => ({ address, parent: null, labels, state: 'live', status: null,
    exitCode: null, reason: null, signal: null, finishedAt: null, cols, rows });
  const terminals = new Map<TerminalAddress, TerminalSummary>([[display, terminal(display, { 'spider.kind': 'pane-proxy' })]]);
  const created: HcRunRequest[] = [], killed: TerminalAddress[] = [], lookups: TerminalAddress[] = [], sourceLaunches: RunId[] = [];
  const events = new Set<(event: HcEvent) => void>();
  let sequence = 1, focused = placement, ownerDisplay: TerminalAddress | null = display;
  const app: AppClient & AppPaneInspection = {
    ownerPlacement: async address => { lookups.push(address); if (address === owner.terminal.address) throw new Error('Box app placement must not be queried');
      const p = layout.get(address); if (!p) throw new HerdrError('owner-unplaced', 'No local pane'); return p; },
    tabTerminals: async target => [...layout].filter(([, p]) => p.space === target.space && p.tab === target.tab).map(([address]) => address),
    tabPanes: async target => [...layout].filter(([, p]) => p.tab === target.tab).map(([terminal, p]) => ({ terminal, pane: p.pane })),
    tabIndex: async target => target.tab === placement.tab ? 0 : 1,
    focusedPane: async () => focused,
    awaitPane: async (address, target) => { const p = { ...target, pane: `pane-${address}` as OwnerPlacement['pane'] }; layout.set(address, p); return p.pane; },
    command: async (name, args) => {
      const address = args.terminal as TerminalAddress;
      if (name === 'pane.focus') focused = args.pane ? [...layout.values()].find(p => p.pane === args.pane)! : layout.get(address)!;
      if (name === 'pane.go') { const panes = [...layout.values()].filter(p => p.tab === focused.tab); const next = panes[panes.indexOf(focused) + 1]; if (next) focused = next; }
      if (name === 'terminal.park') layout.delete(address);
      if (name === 'terminal.keep') { focused = { ...placement, pane: `pane-${address}` as OwnerPlacement['pane'] }; layout.set(address, focused); return { pane: focused.pane }; }
      if (name === 'tab.new') return { space: placement.space, tab: 'adjacent-tab' as OwnerPlacement['tab'], pane: 'empty-pane' as OwnerPlacement['pane'] };
      return {};
    },
  };
  const hc: HcClient = {
    identity: async () => ({ coreId: macCore, socket: '/fixture/mac.sock', sessionNamespace: 'fixture' }),
    caller: async () => { throw new Error('No caller lookup'); }, machines: async () => [],
    run: async request => { created.push(request); const address = `t${++sequence}` as TerminalAddress; terminals.set(address, terminal(address, { ...request.labels })); return { address, coreId: macCore }; },
    get: async address => { const t = terminals.get(address); if (!t) throw new HerdrError('not_found', 'No terminal'); return t; },
    read: async () => 'Waiting for view',
    kill: async address => { killed.push(address); terminals.delete(address); }, rm: async address => { terminals.delete(address); },
    setLabels: async (address, labels) => { const t = terminals.get(address)!; terminals.set(address, { ...t, labels: { ...t.labels, ...Object.fromEntries(Object.entries(labels).filter((entry): entry is [string, string] => entry[1] !== null)) } }); },
    fileRead: async () => { throw new Error('No source file reads'); }, fileWrite: async () => { throw new Error('No source file writes'); },
    events: () => ({ ready: Promise.resolve(), lookup: async address => terminals.get(address) ?? null,
      subscribe: listener => { events.add(listener); return () => { events.delete(listener); }; }, dispose: async () => {} }),
  };
  const options: AuxiliaryPaneOptions = {
    hc, app, limit, clock: Date.now,
    subagentViewer: async id => { sourceLaunches.push(id); throw new Error('Source launch before reservation'); }, discardSubagentViewer: async () => {},
    ownerPresentation: async actualOwner => { expect(actualOwner).toBe(owner); return ownerDisplay; },
    waitingPresentation: async (kind, id, actualOwner) => hc.run({ argv: ['waiting-display'], cwd: null, parent: null, background: true, noNotify: true, outliveParent: true,
      labels: { 'spider.kind': 'pane-proxy', 'spider.session': actualOwner.sessionId, 'spider.owner-core': actualOwner.terminal.coreId,
        'spider.owner-terminal': actualOwner.terminal.terminalId, 'spider.pane-role': kind, 'spider.reservation': id } }),
  };
  const panes = createAuxiliaryPanes(options);
  return { owner, placement, layout, terminals, created, killed, lookups, sourceLaunches, options, panes, hc,
    setOwnerDisplay: (value: TerminalAddress | null) => { ownerDisplay = value; },
    finish: (address: TerminalAddress) => {
      const ended = { ...terminals.get(address)!, state: 'finished' as const, finishedAt: Date.now(), exitCode: 0 };
      terminals.set(address, ended); layout.delete(address);
      for (const listener of events) listener({ type: 'finished', seq: 1, terminal: address,
        data: { exitCode: 0, signal: null, reason: 'exited', finishedAt: ended.finishedAt } });
    },
  };
}


afterEach(() => vi.useRealTimers());
function presented(cols = 200, rows = 60) {
  const f = macFixture(cols, rows); let live = true, uncertain = false;
  const sourceStarts: string[] = [], stops: string[] = [], batches: unknown[][] = [];
  let target: PaneTarget;
  const panes = createPresentedAuxiliaryPanes({ ...f.options, ownerPresentation: f.options.ownerPresentation!,
    observed: async reservation => f.layout.has(reservation.viewer), targetIsLive: async () => live,
    launchTarget: async (kind, id, owner, leaseId) => {
      if (!f.layout.size || f.layout.size < 2) throw new Error('No acknowledged pane');
      sourceStarts.push(leaseId);
      target = { kind: kind === 'console' ? 'console' : 'subagent', coreId: owner.terminal.coreId, terminalId: 't-view' as PaneTarget['terminalId'], address: 'box-1.invalid/t-view' as TerminalAddress,
        createdMs: Date.now(), identityLabels: {}, alias: 'box-1.invalid', machineId: null, sessionId: owner.sessionId, generation: owner.generation,
        runId: kind === 'subagent' ? id as RunId : null, consoleId: kind === 'console' ? consoleId : null, homeEpoch: null, name: 'Child', cwd: owner.cwd };
      live = true; if (uncertain) { uncertain = false; throw new Error('lost source reply'); } return target;
    },
    bindTarget: async (reservation, actual, options) => { expect(f.layout.has(reservation.viewer)).toBe(true); expect(options.observe).toBe(actual.kind === 'console'); },
    renew: async (_machine, leases) => { batches.push(leases); }, stop: async (_machine, lease) => { stops.push(lease); live = false; },
  });
  return { ...f, panes, sourceStarts, stops, batches, expire: () => { live = false; }, loseReply: () => { uncertain = true; } };
}
test('no remote viewer starts before Mac pane acknowledgement', async () => {
  const f = presented();
  try {
    const opened = await f.panes.openPresented('subagent', run, f.owner, { timeoutMs: 1000 });
    expect(opened?.viewer).toBe('t2'); expect(f.sourceStarts).toHaveLength(1); expect(f.sourceLaunches).toEqual([]);
  } finally { await f.panes.dispose(); await f.options.hc.events().dispose(); }
});
test('viewer below remote owner measures the Mac proxy', async () => {
  const f = presented();
  try { const opened = await f.panes.openPresented('subagent', run, f.owner, { timeoutMs: 1000, ownerRelative: true });
    expect(f.layout.get(opened!.viewer)?.space).toBe(f.placement.space); expect(f.lookups).not.toContain(f.owner.terminal.address);
  } finally { await f.panes.dispose(); }
});
test.each([[59,8,false],[60,7,false],[200,60,true]])('automatic disabled or undersized slot starts no viewer (%i by %i)', async (cols, rows, automatic) => {
  const f = presented(cols, rows);
  try { expect(await f.panes.openPresented('subagent', run, f.owner, { timeoutMs: 1000, automatic })).toBeNull(); expect(f.sourceStarts).toEqual([]); }
  finally { await f.panes.dispose(); }
});
test('lease renewals batch once per machine', async () => {
  const f = presented();
  try { await f.panes.openPresented('subagent', run, f.owner, { timeoutMs: 1000 }); await f.panes.openPresented('subagent', otherRun, f.owner, { timeoutMs: 1000 });
    await f.panes.tick(); expect(f.batches).toHaveLength(1); expect(f.batches[0]).toHaveLength(2);
  } finally { await f.panes.dispose(); }
});
test('viewer pane after 30 s sleep relaunches view child untouched', async () => {
  const f = presented(), child = { state: 'live' };
  try { const first = await f.panes.openPresented('subagent', run, f.owner, { timeoutMs: 1000 }); f.expire();
    await f.panes.tick(); expect(f.sourceStarts).toHaveLength(2); expect(new Set(f.sourceStarts).size).toBe(2);
    expect(f.layout.has(first!.viewer)).toBe(true); expect(child.state).toBe('live');
  } finally { await f.panes.dispose(); }
});
test('hidden pane stops only its disposable source viewer', async () => {
  const f = presented();
  try { const opened = await f.panes.openPresented('subagent', run, f.owner, { timeoutMs: 1000 }); f.layout.delete(opened!.viewer);
    await f.panes.tick(); expect(f.stops).toEqual(f.sourceStarts); expect(f.batches).toEqual([]); expect(f.killed).not.toContain(f.owner.terminal.address);
  } finally { await f.panes.dispose(); }
});

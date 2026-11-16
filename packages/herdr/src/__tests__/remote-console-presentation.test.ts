// SPDX-License-Identifier: MIT
import { expect, test, vi } from 'vitest';
import { mkdir, mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { readRetainedAgentConsole, ensureAgentConsole, openAgentConsoleView, openSourceAgentConsoleView, createPaneConsoleDiscovery, startWithAgentConsole } from '../remote/console.js';
import { encodeRuntimePublication, runRemoteConsole } from '../remote/runtime.js';
import { openPaneConsole, stopPaneViewer, type PaneViewPorts } from '../../../host/src/herdr/pane-views.js';
import { parsePaneTarget } from '../panes/codec.js';
import type { AgentConsoleLaunch } from '../remote/console.js';
import type { HcClient, HcRunRequest, TerminalAddress, TerminalSummary, MachineName, Owner, JobPort, RunId } from '../contracts.js';
import type { PaneTarget, PaneTerminalFacts } from '../panes/types.js';
async function fixture() {
  const base = resolve('.spider/scratch/console-presentation'); await mkdir(base, { recursive: true }); const root = await mkdtemp(join(base, 'f-'));
  const owner = { sessionId: 'session-one', generation: 'generation-one', name: 'Writer', cwd: root, sessionFile: null,
    terminal: { coreId: 'owner-core', terminalId: 't7', address: 'box-1.invalid/t7', socket: '/fixture/core.sock', sessionNamespace: 'fixture' } } as Owner;
  const on = 'box-2.invalid' as MachineName, core = 'console-core' as Owner['terminal']['coreId'];
  const launches: HcRunRequest[] = [], killed: TerminalAddress[] = [], files = new Map<string, Buffer>(), terminals = new Map<TerminalAddress, TerminalSummary>();
  const hc: HcClient = {
    identity: async () => ({ coreId: core, socket: '/fixture/console.sock', sessionNamespace: 'fixture' }), caller: async () => { throw new Error('No caller lookup'); },
    machines: async () => [{ id: core, name: on, aliases: [], state: 'connected', sessionNamespace: 'fixture', runtime: null }],
    run: async request => { launches.push(request); const address = `${on}/t${launches.length}` as TerminalAddress;
      terminals.set(address, { address, parent: null, state: 'live', labels: request.labels ?? {}, status: null, exitCode: null, reason: null, signal: null, finishedAt: null, cols: 60, rows: 8 });
      const argv = request.argv; const directory = argv[argv.indexOf('--console')+1], instance = argv[argv.indexOf('--console')+2];
      files.set(join(directory, 'heartbeat.json'), Buffer.from(JSON.stringify({ version: 1, instance }))); return { coreId: core, address }; },
    get: async address => { const terminal = terminals.get(address) ?? [...terminals.values()].find(t => `${core}/${t.address.split('/').at(-1)}` === address); if (!terminal) throw Object.assign(new Error('missing'), { code: 'not_found' }); return terminal; },
    kill: async address => { killed.push(address); terminals.delete(address); }, rm: async address => { terminals.delete(address); }, read: async () => '',
    setLabels: async (address, labels) => { const terminal = await hc.get(address); terminal.labels = { ...terminal.labels, ...Object.fromEntries(Object.entries(labels).filter((e): e is [string,string] => e[1] !== null)) }; },
    fileRead: async (_on, file) => { const value = files.get(file); if (!value) throw Object.assign(new Error('missing'), { code: 'ENOENT' }); return value; }, fileWrite: async (_on, file, bytes) => { files.set(file, bytes); },
    events: () => ({ ready: Promise.resolve(), lookup: async address => terminals.get(address) ?? null, subscribe(listener) { listener({ type: 'snapshot', seq: 1, terminals: [...terminals.values()] }); return () => {}; }, dispose() {} }),
  };
  const request: AgentConsoleLaunch = { owner, on, target: { on, cwd: null, directory: root, commands: {}, environment: {}, nodePath: '/fixture/node', runtimePath: '/fixture/runtime.mjs', runtimeSha256: 'a'.repeat(64) }, source: { kind: 'code', language: 'shell', code: 'echo output' } };
  const env = { HC_TERMINAL_ID: 't7' };
  const facts = async (address: TerminalAddress): Promise<PaneTerminalFacts> => { const terminal = await hc.get(address); return { terminal: { ...terminal, address }, createdMs: 100, title: 'Writer', app: null, status: null, currentCwd: null, identityLabels: terminal.labels }; };
  const discovery = createPaneConsoleDiscovery({ hc, ownsRun: async () => true, validateOwner: async actual => actual.sessionId === owner.sessionId && actual.generation === owner.generation, readFacts: facts });
  return { root, owner, request, env, hc, launches, killed, files, terminals, facts, discovery, close: () => rm(root, { recursive: true, force: true }) };
}
test('retention-only console support starts no hidden viewer', async () => {
  const f = await fixture();
  try {
    const store = await ensureAgentConsole(f.request, f.hc, f.env);
    expect(store?.consoleId).toMatch(/^console-[a-f0-9]{64}$/); expect(store).not.toHaveProperty('address'); expect(f.launches).toEqual([]);
    expect(f.files.has(join(store!.directory, 'console.json'))).toBe(true);
  } finally { await f.close(); }
});
test('console key remains one per agent and machine', async () => {
  const f = await fixture();
  try {
    const [first, second] = await Promise.all([1,2].map(() => ensureAgentConsole(f.request, f.hc, f.env)));
    expect(first?.consoleId).toBe(second?.consoleId); expect(first?.directory).toBe(second?.directory);
    const child = await ensureAgentConsole(f.request, f.hc, { ...f.env, PI_SUBAGENT_CHILD: '1', PI_SUBAGENT_RUN_ID: 'run-one' });
    const other = await ensureAgentConsole({ ...f.request, on: 'box-3.invalid' as MachineName }, f.hc, f.env);
    expect(new Set([first!.consoleId, child!.consoleId, other!.consoleId]).size).toBe(3); expect(f.launches).toEqual([]);
  } finally { await f.close(); }
});
test('source console identity rejects a persisted key collision', async () => {
  const f = await fixture();
  try { const store = await ensureAgentConsole(f.request, f.hc, f.env);
    f.files.set(join(store!.directory, 'console.json'), encodeRuntimePublication({ version: 1, consoleKey: 'foreign-key', title: 'Other' }));
    await expect(ensureAgentConsole(f.request, f.hc, f.env)).rejects.toMatchObject({ code: 'console-identity-collision' });
    expect(f.launches).toEqual([]);
  } finally { await f.close(); }
});
test('console discovery adapter exposes source-validated identifier shaped ids', async () => {
  const f = await fixture();
  try { const view = await openAgentConsoleView({ ...f.request, displayLeaseFile: join(f.root, 'lease.json') }, f.hc, f.env);
    const targets = await f.discovery(f.owner); expect(targets).toHaveLength(1); expect(targets![0].consoleId).toBe(view!.consoleId);
    expect(targets![0]).toMatchObject({ coreId: 'console-core', terminalId: 't1', generation: f.owner.generation, alias: null });
    expect(() => parsePaneTarget(targets![0])).not.toThrow();
  } finally { await f.close(); }
});
test('source-only console opens without a self alias or remote file transport', async () => {
  const f = await fixture(); f.hc.machines = async () => [];
  f.hc.fileRead = async () => { throw new Error('Remote transport forbidden'); }; f.hc.fileWrite = async () => { throw new Error('Remote transport forbidden'); };
  try { const view = await openSourceAgentConsoleView({ ...f.request, displayLeaseFile: join(f.root, 'lease.json') }, f.hc, 'console-core' as CoreId, f.env);
    expect(view!.coreId).toBe('console-core'); expect(f.launches).toHaveLength(1); expect(f.launches[0].on).toBeUndefined();
    expect(await readFile(join(view!.directory, 'console.json'), 'utf8')).toContain(view!.consoleId);
    await expect(openSourceAgentConsoleView({ ...f.request, displayLeaseFile: join(f.root, 'lease.json') }, f.hc, 'wrong-core' as CoreId, f.env)).rejects.toMatchObject({ code: 'console-core-mismatch' });
    expect(f.launches).toHaveLength(1);
  } finally { await f.close(); }
});
test('source-local console discovery does not require a self machine registration', async () => {
  const f = await fixture();
  try { await openAgentConsoleView({ ...f.request, displayLeaseFile: join(f.root, 'lease.json') }, f.hc, f.env);
    const terminal = [...f.terminals.values()][0]; f.terminals.clear(); f.terminals.set('t1' as TerminalAddress, { ...terminal, address: 't1' as TerminalAddress });
    f.hc.machines = async () => [];
    const targets = await f.discovery(f.owner); expect(targets).toHaveLength(1); expect(targets![0]).toMatchObject({ coreId: 'console-core', terminalId: 't1', address: 'console-core/t1' });
  } finally { await f.close(); }
});
test('child-owned console discovery retains the run identity', async () => {
  const f = await fixture();
  try { const env = { ...f.env, PI_SUBAGENT_CHILD: '1', PI_SUBAGENT_RUN_ID: 'child-run' };
    const view = await openAgentConsoleView({ ...f.request, displayLeaseFile: join(f.root, 'lease.json') }, f.hc, env);
    const targets = await f.discovery(f.owner); expect(targets![0]).toMatchObject({ consoleId: view!.consoleId, runId: 'child-run' });
  } finally { await f.close(); }
});
test('console discovery returns null on unavailable or mismatched source facts, not empty', async () => {
  const f = await fixture();
  try { expect(await f.discovery(f.owner)).toEqual([]);
    await openAgentConsoleView({ ...f.request, displayLeaseFile: join(f.root, 'lease.json') }, f.hc, f.env);
    [...f.terminals.values()][0].labels = { ...[...f.terminals.values()][0].labels, 'spider.console-id': 'console-forged' };
    expect(await f.discovery(f.owner)).toBeNull();
    expect(await f.discovery({ ...f.owner, generation: 'stale' as Owner['generation'] })).toBeNull();
  } finally { await f.close(); }
});
test('reopen leased console uses the same store without restarting payloads', async () => {
  const f = await fixture();
  try { const first = await openAgentConsoleView({ ...f.request, displayLeaseFile: join(f.root, 'lease-one.json') }, f.hc, f.env);
    await f.hc.kill(first!.address);
    const second = await openAgentConsoleView({ ...f.request, displayLeaseFile: join(f.root, 'lease-two.json') }, f.hc, f.env);
    expect(second!.consoleId).toBe(first!.consoleId); expect(second!.directory).toBe(first!.directory);
    expect(f.launches).toHaveLength(2); expect(f.launches[1].argv).toContain('--display-lease');
    expect(f.files.has(join(first!.directory, 'head.json'))).toBe(true);
  } finally { await f.close(); }
});
test('retention-only payload preparation has no console view side effects', async () => {
  const f = await fixture(); let payloadStarts = 0;
  const jobs: JobPort = { detach: async () => {}, toolReturned: async () => {}, consumeNotice: async () => {}, dispose: async () => {}, start: async prepare => { payloadStarts++; const program = await prepare(); expect(program.consoleDirectory).toBeTruthy();
    return { id: 'job-one' as import('../contracts.js').JobId, address: 'payload' as TerminalAddress, localDirectory: f.root, remoteDirectory: join(f.root, 'job-one'), finished: new Promise(() => {}), cancel: async () => { throw new Error('Payload cancellation forbidden'); } }; } };
  vi.stubEnv('HC_TERMINAL_ID', 't7');
  try { await startWithAgentConsole({ ...f.request, hc: f.hc, jobs, options: {}, program: async () => ({ directory: f.root, argv: ['payload'], files: [], cwd: null, env: {} }) });
    expect(payloadStarts).toBe(1); expect(f.launches).toEqual([]);
  } finally { vi.unstubAllEnvs(); await f.close(); }
});
test('leased remote console exits at expiry and preserves retained output', async () => {
  const f = await fixture(); const directory = join(f.root, '.consoles', 'store'); await mkdir(directory, { recursive: true });
  const lease = join(f.root, 'lease.json');
  await writeFile(join(directory, 'console.json'), encodeRuntimePublication({ version: 1, title: 'Writer' }), { mode: 0o600 });
  await writeFile(join(directory, 'head.json'), encodeRuntimePublication({ version: 1, count: 0 }), { mode: 0o600 });
  await writeFile(lease, JSON.stringify({ version: 1, sessionId: f.owner.sessionId, generation: f.owner.generation, consoleId: 'console-one', runId: null, expiresAt: 0 }), { mode: 0o600 });
  try { await runRemoteConsole(directory, { displayLeaseFile: lease, sessionId: f.owner.sessionId, generation: f.owner.generation, consoleId: 'console-one', write: () => {} });
    expect(await readFile(join(directory, 'console.json'), 'utf8')).toContain('Writer');
    expect(await readFile(join(directory, 'head.json'), 'utf8')).toContain('count');
  } finally { await f.close(); }
});

test('console display lease expires after 20 s without signalling payloads', async () => {
  const f = await fixture(), directory = join(f.root, '.consoles', 'timed'); await mkdir(directory, { recursive: true });
  const file = join(f.root, 'timed-lease'); const start = Date.now();
  await writeFile(join(directory, 'head.json'), encodeRuntimePublication({ version: 1, count: 0 }), { mode: 0o600 });
  await writeFile(file, JSON.stringify({ version: 1, sessionId: f.owner.sessionId, generation: f.owner.generation, consoleId: 'console-one', expiresAt: start + 20000 }), { mode: 0o600 });
  let reads = 0, finished = false; const clock = vi.spyOn(Date, 'now').mockImplementation(() => reads++ < 2 ? start : start + 20000);
  try { await runRemoteConsole(directory, { displayLeaseFile: file, sessionId: f.owner.sessionId, generation: f.owner.generation, consoleId: 'console-one', pollMs: 1, write: () => {} }).then(() => { finished = true; });
    expect(finished).toBe(true); expect(f.killed).toEqual([]); expect(f.launches).toEqual([]);
    expect(await readFile(join(directory, 'head.json'), 'utf8')).toContain('count');
  } finally { clock.mockRestore(); await f.close(); }
});
test('close console leaves all payloads live', async () => {
  const f = await fixture(); const payloads = [{ state: 'live' }, { state: 'live' }];
  const store = await ensureAgentConsole(f.request, f.hc, f.env);
  const ports: PaneViewPorts = {
    leaseRoot: join(f.root, 'leases'), clock: Date.now, readOwner: async () => f.owner, ownsRun: async () => true,
    viewerLauncher: () => { throw new Error('Console cannot launch a subagent'); },
    consoleSource: async () => ({ consoleId: store!.consoleId, runId: null,
      launch: async file => (await openAgentConsoleView({ ...f.request, displayLeaseFile: file }, f.hc, f.env))!.address }),
    readTarget: async () => (await f.discovery(f.owner))![0],
    stopTarget: async target => { const terminal = await f.hc.get(target.address); await f.hc.kill(terminal.address); },
  };
  try { const target = await openPaneConsole({ sessionId: f.owner.sessionId, generation: f.owner.generation, machineKey: 'console-core', consoleId: store!.consoleId, leaseId: 'console-lease' }, ports);
    expect(target).toMatchObject({ consoleId: store!.consoleId, coreId: 'console-core', kind: 'console' });
    await stopPaneViewer('console-lease', ports); expect(f.killed).toHaveLength(1);
    expect(payloads.every(payload => payload.state === 'live')).toBe(true); expect(f.files.has(join(store!.directory, 'head.json'))).toBe(true);
  } finally { await f.close(); }
});
test('unreachable console source refuses without local substitute', async () => {
  const f = await fixture(); f.hc.machines = async () => [];
  try { await expect(openAgentConsoleView({ ...f.request, displayLeaseFile: join(f.root, 'lease') }, f.hc, f.env)).rejects.toMatchObject({ code: 'machine-unavailable' }); expect(f.launches).toEqual([]); }
  finally { await f.close(); }
});
test('runtime upgrade refuses an active older view and replaces only an idle view', async () => {
  const f = await fixture();
  try { const first = await openAgentConsoleView({ ...f.request, displayLeaseFile: join(f.root, 'lease') }, f.hc, f.env);
    const request = { ...f.request, target: { ...f.request.target, runtimeSha256: 'b'.repeat(64) }, displayLeaseFile: join(f.root, 'lease-two') };
    await expect(openAgentConsoleView(request, f.hc, f.env)).rejects.toMatchObject({ code: 'console-runtime-unavailable' });
    expect(f.killed).toEqual([]);
    const second = await openAgentConsoleView({ ...request, isConsoleIdle: async () => true }, f.hc, f.env);
    expect(second!.consoleId).toBe(first!.consoleId); expect(f.killed).toEqual([first!.address]); expect(f.launches).toHaveLength(2);
  } finally { await f.close(); }
});

const run = '10000000-0000-4000-8000-000000000001' as RunId;
const consoleId = ('console-' + '2'.repeat(64)) as ConsoleId;
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



function consolePresentation(cols = 200, rows = 60) {
  const f = macFixture(cols, rows); const bound: { target: PaneTarget; observe: boolean }[] = [];
  const panes = createPresentedAuxiliaryPanes({ ...f.options, ownerPresentation: f.options.ownerPresentation!,
    observed: async reservation => f.layout.has(reservation.viewer), targetIsLive: async () => true,
    launchTarget: async (_kind, id, owner) => ({ kind: 'console', consoleId: id as import('../contracts.js').ConsoleId, runId: null,
      coreId: 'console-core' as CoreId, terminalId: 't-view' as PaneTarget['terminalId'], address: 'console-core/t-view' as TerminalAddress, createdMs: 1,
      identityLabels: {}, alias: 'box-2.invalid', machineId: null, sessionId: owner.sessionId, generation: owner.generation, homeEpoch: null, name: 'Console', cwd: null }),
    bindTarget: async (_reservation, target, options) => { bound.push({ target, observe: options.observe }); }, renew: async () => {}, stop: async () => {},
  });
  return { ...f, panes, bound };
}
test('remote owner console opens in same Mac space', async () => {
  const f = consolePresentation();
  try { const result = await f.panes.openPresented('console', consoleId, f.owner, { timeoutMs: 1000, ownerRelative: true });
    expect(f.layout.get(result!.viewer)?.space).toBe(f.placement.space); expect(f.bound[0].target.alias).toBe('box-2.invalid');
    expect(f.lookups).not.toContain(f.owner.terminal.address);
  } finally { await f.panes.dispose(); }
});
test('console proxy is observe only', async () => {
  const f = consolePresentation();
  try { await f.panes.openPresented('console', consoleId, f.owner, { timeoutMs: 1000 }); expect(f.bound).toHaveLength(1); expect(f.bound[0].observe).toBe(true); }
  finally { await f.panes.dispose(); }
});
test('console at 60 by 8 keeps the same space with explicit adjacent tab fallback', async () => {
  const f = consolePresentation(60,8);
  try { const result = await f.panes.openPresented('console', consoleId, f.owner, { timeoutMs: 1000, userInitiated: true, ownerRelative: true });
    expect(result).not.toBeNull(); expect(f.layout.get(result!.viewer)?.space).toBe(f.placement.space); expect(await f.hc.get(result!.viewer)).toMatchObject({ cols: 60, rows: 8 });
  } finally { await f.panes.dispose(); }
});

import { createPresentedAuxiliaryPanes } from '../panes/auxiliary.js';
import { createAuxiliaryPanes, type AuxiliaryPaneOptions } from '../jobs/placement.js';
import { HerdrError } from '../client/parse.js';
import type { AppClient, AppPaneInspection, ConsoleId, CoreId, HcEvent, OwnerPlacement, PaneReservation } from '../contracts.js';

test('retained console discovery reads its source identity without starting a view', async () => {
  const f = await fixture();
  try {
    const store = await ensureAgentConsole(f.request, f.hc, f.env);
    const console = await readRetainedAgentConsole(f.request, f.hc, f.env);
    expect(console).toMatchObject({ consoleId: store!.consoleId, machineKey: f.request.on, name: expect.any(String), directory: store!.directory, runId: null });
    expect(f.launches).toEqual([]);
    f.files.set(join(store!.directory, 'console.json'), encodeRuntimePublication({ version: 1, title: 'Forged', consoleKey: 'foreign-key', consoleId: store!.consoleId }));
    await expect(readRetainedAgentConsole(f.request, f.hc, f.env)).rejects.toMatchObject({ code: 'console-identity-collision' });
    expect(f.launches).toEqual([]);
  } finally { await f.close(); }
});

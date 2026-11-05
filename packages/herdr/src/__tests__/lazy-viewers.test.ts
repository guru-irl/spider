// SPDX-License-Identifier: MIT
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { createHerdrHarness } from './testutil.js';
import { createViewerLauncher, registerHerdrViewers } from '../viewers/register.js';
import { createAuxiliaryPanes } from '../jobs/placement.js';
import { startSessionEndpoint } from '../feed/ipc-server.js';
import { createSessionIpcClient } from '../feed/ipc-client.js';
import { projectAgentChildren } from '../../assets/agents/children.js';
import { moveTarget, killTarget } from '../../assets/agents/move.js';
import { HerdrLabelContract, type AppClient, type AppPaneInspection, type Owner, type OwnerPlacement, type RunId, type SessionFeed, type TerminalAddress } from '../contracts.js';
import { HerdrError } from '../client/parse.js';

const ids = ['10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000002'] as RunId[];
async function fixture(automaticSubagentPanes = false) {
  const h = await createHerdrHarness('fake'); await h.start();
  const owner = h.owner!;
  const executable = join(h.root, 'viewer.mjs'); await writeFile(executable, 'setInterval(() => {}, 1000);');
  const placement = { space: 'space', tab: 'tab', pane: 'owner-pane' } as OwnerPlacement;
  const layout = new Map<TerminalAddress, OwnerPlacement>([[owner.terminal.address, placement]]);
  const commands: { name: string; args: Readonly<Record<string, unknown>> }[] = [];
  let focused = placement;
  const app: AppClient & AppPaneInspection = {
    ownerPlacement: async address => { const p = layout.get(address); if (!p) throw new HerdrError('owner-unplaced', 'No pane'); return p; },
    tabTerminals: async target => [...layout].filter(([, p]) => p.tab === target.tab).map(([address]) => address),
    tabPanes: async target => [...layout].filter(([, p]) => p.tab === target.tab).map(([terminal, p]) => ({ terminal, pane: p.pane })),
    tabIndex: async () => 1, focusedPane: async () => focused,
    tabSpace: async () => placement.space,
    awaitPane: async (address, target) => { const p = { ...target, pane: `pane-${address}` as OwnerPlacement['pane'] }; layout.set(address, p); return p.pane; },
    command: async (name, args) => {
      commands.push({ name, args });
      const address = args.terminal as TerminalAddress;
      if (name === 'pane.focus') focused = args.pane ? [...layout.values()].find(p => p.pane === args.pane)! : layout.get(address)!;
      if (name === 'pane.go') { const rows = [...layout.values()]; const next = rows[rows.indexOf(focused) + 1]; if (next) focused = next; }
      if (name === 'terminal.park') layout.delete(address);
      if (name === 'terminal.keep') { focused = { ...placement, pane: `pane-${address}` as OwnerPlacement['pane'] }; layout.set(address, focused); }
      if (name === 'tab.new') return { ...placement, tab: 'new-tab' as OwnerPlacement['tab'], pane: 'new-pane' as OwnerPlacement['pane'] };
      return {};
    },
  };
  const nativeGet = h.hc.get;
  h.hc.get = async address => ({ ...await nativeGet(address), cols: 200, rows: 60 });
  const launchRequests: RunId[] = [];
  const nativeLauncher = createViewerLauncher({ hc: h.hc, owner: () => owner, viewerExecutable: executable, feedRoot: h.root,
    ipcDescriptor: () => ({ version: 1, sessionId: owner.sessionId, generation: owner.generation, address: join(h.root, 'ipc'), capabilityFile: join(h.root, 'cap') }) });
  const launcher = Object.assign((...args: Parameters<typeof nativeLauncher>) => { launchRequests.push(args[0]); return nativeLauncher(...args); }, { discard: nativeLauncher.discard });
  const panes = createAuxiliaryPanes({ hc: h.hc, app, subagentViewer: launcher, discardSubagentViewer: launcher.discard, automaticSubagentPanes, clock: Date.now });
  const attempted: RunId[] = [], acquire = panes.acquire;
  panes.acquire = async (kind, id, owner, options) => { try { return await acquire(kind, id, owner, options); } finally { attempted.push(id as RunId); } };
  const hooks = new Map<string, () => Promise<void>>();
  const registration = registerHerdrViewers({ on: (name: string, handler: () => Promise<void>) => hooks.set(name, handler) } as never, {
    owner: () => owner, hc: h.hc, viewerLauncher: launcher, viewerExecutable: executable, feedRoot: h.root, ipcDescriptor: () => null,
    ownedRunEvents: { list: async () => ids, subscribe: () => () => {} }, panes,
  });
  const launches = async () => (await h.calls()).filter(c => c.argv[0] === 'run' && c.argv.includes('spider.kind=subagent-viewer'));
  const seed = async (patch: Record<string, string> = {}, parent = owner.terminal.address) => h.hc.run({ argv: [process.execPath, executable], cwd: h.root, parent,
    labels: { 'spider.kind': 'subagent-viewer', 'spider.session': owner.sessionId, 'spider.owner-core': owner.terminal.coreId, 'spider.owner-terminal': owner.terminal.terminalId, 'spider.run': ids[0], ...patch },
    background: true, noNotify: true, outliveParent: true });
  return { h, owner, app, panes, registration, hooks, layout, commands, launches, seed, attempted, launchRequests,
    async close() { await registration.dispose(); await panes.dispose(); await h.close(); expect(await h.remainingOwnedResources()).toEqual([]); } };
}

test('default activation never launches a viewer without a pane', async () => {
  const f = await fixture();
  try {
    await f.hooks.get('session_start')!();
    await expect.poll(() => f.attempted.length).toBe(2);
    expect(f.launchRequests).toEqual([]);
    expect(await f.launches()).toEqual([]);
    expect(f.layout.size).toBe(1);
  } finally { await f.close(); }
});

test('a running row without a viewer opens below its owner through the session endpoint and focuses on repeat', async () => {
  const f = await fixture(); let endpoint: Awaited<ReturnType<typeof startSessionEndpoint>> | undefined;
  try {
    const source = { openRun: async (id: RunId) => (await f.panes.acquire('subagent', id, f.owner, { timeoutMs: 3000, ownerRelative: true }))?.viewer ?? null };
    endpoint = await startSessionEndpoint(f.owner, {
      currentOwner: () => f.owner, liveCapabilities: () => null, ownsRun: id => ids.includes(id),
      subscribeRun: () => ({ dispose() {} }), steerRun: () => { throw new Error('No steering'); }, openView() {},
      ownsJob: () => false, openJob: () => null, ...source,
    }, join(f.h.root, 'feeds'));
    const feed = { sessionId: f.owner.sessionId, generation: f.owner.generation, owner: f.owner, lifecycle: 'live', updatedAt: Date.now(), ipc: endpoint.descriptor,
      runs: { rows: [{ id: ids[0], ownerSessionId: f.owner.sessionId, name: 'Worker', status: 'running', viewer: null, finishedAt: null }] } } as unknown as SessionFeed;
    const [row] = projectAgentChildren([], [feed], f.owner.terminal.address, HerdrLabelContract);
    expect(row.action?.kind).toBe('ipc'); expect(row.status).toBe('working'); expect(row.address).toBeNull();
    if (row.action?.kind !== 'ipc') throw new Error('No session action');
    const client = createSessionIpcClient(row.action.descriptor);
    const first = await client.openRun(ids[0]); expect(first.ok).toBe(true);
    if (!first.ok || first.op !== 'openRun') throw new Error('Open failed');
    expect(f.commands.find(c => c.name === 'terminal.keep')).toEqual({ name: 'terminal.keep', args: { terminal: first.viewer, place: 'down' } });
    const second = await client.openRun(ids[0]); expect(second).toEqual(first);
    expect(await f.launches()).toHaveLength(1);
    expect(f.commands.filter(c => c.name === 'terminal.keep')).toHaveLength(1);
    expect(f.commands.at(-1)).toEqual({ name: 'pane.focus', args: { terminal: first.viewer } });
  } finally { await endpoint?.dispose(); await f.close(); }
});

test.each(['menu', 'release', 'park'] as const)('hiding through %s removes the viewer and reopening starts a fresh terminal', async path => {
  const f = await fixture();
  try {
    const first = (await f.panes.acquire('subagent', ids[0], f.owner, { timeoutMs: 3000, ownerRelative: true }))!;
    if (path === 'menu') await f.panes.moveRun(ids[0], f.owner, { kind: 'hide' }, { timeoutMs: 3000 });
    if (path === 'release') await f.panes.release(first);
    if (path === 'park') await f.panes.park(ids[0]);
    expect(f.layout.has(first.viewer)).toBe(false);
    await expect(f.h.hc.get(first.viewer)).rejects.toMatchObject({ code: 'not_found' });
    const next = (await f.panes.acquire('subagent', ids[0], f.owner, { timeoutMs: 3000, ownerRelative: true }))!;
    expect(next.viewer).not.toBe(first.viewer);
    expect(f.layout.has(next.viewer)).toBe(true);
    expect(await f.launches()).toHaveLength(2);
  } finally { await f.close(); }
});

test('hiding an already hidden run does not launch another viewer', async () => {
  const f = await fixture();
  try {
    await f.panes.acquire('subagent', ids[0], f.owner, { timeoutMs: 3000 });
    await f.panes.moveRun(ids[0], f.owner, { kind: 'hide' }, { timeoutMs: 3000 });
    expect(await f.panes.moveRun(ids[0], f.owner, { kind: 'hide' }, { timeoutMs: 3000 })).toBeNull();
    expect(await f.launches()).toHaveLength(1);
  } finally { await f.close(); }
});

test('hide discovers an existing visible viewer without launching another', async () => {
  const f = await fixture();
  try {
    const visible = await f.seed();
    f.layout.set(visible.address, { ...f.layout.get(f.owner.terminal.address)!, pane: 'existing-viewer' as OwnerPlacement['pane'] });
    await f.panes.moveRun(ids[0], f.owner, { kind: 'hide' }, { timeoutMs: 3000 });
    expect(f.layout.has(visible.address)).toBe(false);
    await expect(f.h.hc.get(visible.address)).rejects.toMatchObject({ code: 'not_found' });
    expect(f.launchRequests).toEqual([]);
  } finally { await f.close(); }
});

test('activation only sweeps viewers present when it starts', async () => {
  const f = await fixture(); let release!: () => void;
  try {
    const parked = await f.seed();
    const lookup = f.app.ownerPlacement; let entered!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { entered = resolve; });
    f.app.ownerPlacement = async address => {
      if (address === parked.address) { entered(); await waiting; }
      return lookup(address);
    };
    const sweep = f.panes.reconcile(f.owner); void sweep.catch(() => {});
    await ready;
    const opening = await f.seed({ 'spider.run': ids[1] });
    release(); await sweep;
    await expect(f.h.hc.get(opening.address)).resolves.toMatchObject({ state: 'live' });
    await expect(f.h.hc.get(parked.address)).rejects.toMatchObject({ code: 'not_found' });
  } finally { release?.(); await f.close(); }
});

test('a cancelled activation cannot remove a viewer after its final lookup completes', async () => {
  const f = await fixture(); let release!: () => void;
  try {
    const parked = await f.seed();
    const lookup = f.app.ownerPlacement; let lookups = 0, entered!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { entered = resolve; });
    f.app.ownerPlacement = async address => {
      if (address === parked.address && ++lookups === 2) { entered(); await waiting; }
      return lookup(address);
    };
    const abort = new AbortController();
    const sweep = f.panes.reconcile(f.owner, abort.signal); void sweep.catch(() => {});
    await ready; abort.abort(); release();
    await expect(sweep).rejects.toMatchObject({ code: 'aborted' });
    await expect(f.h.hc.get(parked.address)).resolves.toMatchObject({ state: 'live' });
  } finally { release?.(); await f.close(); }
});

test('activation removes only its own parked live viewers and keeps visible viewers across reload', async () => {
  const f = await fixture();
  try {
    const parked = await f.seed();
    const visible = await f.seed({ 'spider.run': ids[1] }); f.layout.set(visible.address, { space: 'other-space', tab: 'other-tab', pane: 'visible-pane' } as OwnerPlacement);
    const foreign = await f.seed({ 'spider.owner-terminal': 'another-owner' });
    const otherSession = await f.seed({ 'spider.session': 'another-session' });
    const payload = await f.seed({ 'spider.kind': 'exec' });
    const unlabelled = await f.seed({ 'spider.kind': '' });
    const remote = await f.seed({ 'spider.owner-core': 'another-core' });
    await f.hooks.get('session_start')!();
    await expect(f.h.hc.get(parked.address)).rejects.toMatchObject({ code: 'not_found' });
    for (const handle of [visible, foreign, otherSession, payload, unlabelled, remote]) await expect(f.h.hc.get(handle.address)).resolves.toMatchObject({ state: 'live' });
    const before = (await f.launches()).length;
    await f.hooks.get('session_shutdown')!(); await f.hooks.get('session_start')!();
    expect((await f.h.hc.get(visible.address)).state).toBe('live');
    expect((await f.launches()).length).toBe(before);
  } finally { await f.close(); }
});

test('activation adopts visible viewers after the same session resumes in a new terminal', async () => {
  const f = await fixture();
  try {
    const visible = await f.seed();
    f.layout.set(visible.address, { space: 'space', tab: 'tab', pane: 'visible-pane' } as OwnerPlacement);
    const old = f.owner.terminal.address;
    const replacement = await f.h.hc.run({ argv: ['/bin/sh'], cwd: f.h.root, labels: { 'spider.kind': 'session' }, background: true, noNotify: true, outliveParent: false });
    await f.h.hc.kill(old);
    f.owner.terminal = { ...f.owner.terminal, address: replacement.address, terminalId: replacement.address as unknown as Owner['terminal']['terminalId'] };
    f.layout.delete(old); f.layout.set(replacement.address, { space: 'space', tab: 'tab', pane: 'owner-pane' } as OwnerPlacement);
    await f.hooks.get('session_start')!();
    await expect.poll(async () => (await f.h.hc.get(visible.address)).labels['spider.owner-terminal']).toBe(replacement.address);
    expect((await f.h.hc.get(visible.address)).state).toBe('live');
    expect(await f.launches()).toHaveLength(1);
  } finally { await f.close(); }
});

test('automatic panes still launch and place one viewer for each run', async () => {
  const f = await fixture(true);
  try {
    await f.hooks.get('session_start')!();
    await f.registration.peek(ids[0]); await f.registration.peek(ids[1]);
    expect(await f.launches()).toHaveLength(2);
    expect(f.layout.size).toBe(3);
    expect(await f.panes.acquire('subagent', ids[0], f.owner, { timeoutMs: 3000, automatic: true })).not.toBeNull();
    expect(await f.launches()).toHaveLength(2);
  } finally { await f.close(); }
});

test('an automatic run with no remaining pane capacity launches nothing', async () => {
  const f = await fixture(true);
  try {
    await f.panes.acquire('subagent', ids[0], f.owner, { timeoutMs: 3000, automatic: true });
    await f.panes.acquire('subagent', ids[1], f.owner, { timeoutMs: 3000, automatic: true });
    const before = (await f.launches()).length;
    expect(await f.panes.acquire('subagent', 'third' as RunId, f.owner, { timeoutMs: 3000, automatic: true })).toBeNull();
    expect((await f.launches()).length).toBe(before);
  } finally { await f.close(); }
});

test('a failed explicit placement leaves no parked viewer process', async () => {
  const f = await fixture();
  try {
    const command = f.app.command;
    f.app.command = async (name, args) => name === 'terminal.keep' ? { error: { code: 'app-error', message: 'Placement refused' } } : command(name, args);
    await expect(f.panes.acquire('subagent', ids[0], f.owner, { timeoutMs: 3000, ownerRelative: true })).rejects.toMatchObject({ code: 'app-error' });
    const calls = await f.launches(); expect(calls).toHaveLength(1);
    const stream = f.h.hc.events(); const live: string[] = [];
    const unsubscribe = stream.subscribe(event => { if (event.type === 'snapshot') for (const terminal of event.terminals) if (terminal.state === 'live' && terminal.labels['spider.kind'] === 'subagent-viewer') live.push(terminal.address); });
    try { await stream.ready; expect(live).toEqual([]); }
    finally { unsubscribe(); await stream.dispose(); }
  } finally { await f.close(); }
});

test('a viewerless row can open in a tab and kill its subagent through the existing requests', async () => {
  const descriptor = { sessionId: 'owner', generation: 'generation' };
  const target = { kind: 'subagent', key: ids[0], terminal: null, pane: false, descriptor, active: true };
  const requests: unknown[] = [];
  const ports = { ipc: async (_descriptor: unknown, request: unknown) => { requests.push(request); } };
  await moveTarget(target as never, { kind: 'new' }, ports as never);
  await moveTarget(target as never, { kind: 'tab', tab: 'chosen-tab' }, ports as never);
  await killTarget(target as never, ports as never);
  expect(requests).toEqual([
    { op: 'moveRun', runId: ids[0], destination: { kind: 'new' }, generation: 'generation' },
    { op: 'moveRun', runId: ids[0], destination: { kind: 'tab', tab: 'chosen-tab' }, generation: 'generation' },
    { op: 'killRun', runId: ids[0], generation: 'generation' },
  ]);
});

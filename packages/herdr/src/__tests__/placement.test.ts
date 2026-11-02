// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile, readFile, chmod } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { AppClient, HcClient, HcEvent, HcRunRequest, JobId, JobRecord, Owner, OwnerPlacement, PaneId, RunId, TerminalAddress } from '../contracts.js';
import { createJobMonitor } from '../jobs/monitor.js';
import { createAuxiliaryPanes } from '../jobs/placement.js';
import { runAcceptance, createClientFixture } from './testutil.js';
import { acceptanceD } from './acceptance/d.js';
import { openRemoteObserver, observerMarker, runRemoteObserver, releaseRemoteJob } from '../jobs/observer.js';
import { registerHerdrViewers } from '../viewers/register.js';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { vi.useRealTimers(); for (const close of cleanups.splice(0).reverse()) await close(); });
async function fixture(limit = 2) {
  const base = resolve('.spider/scratch/h'); await mkdir(base, { recursive: true }); const root = await mkdtemp(join(base, 'p-')); cleanups.push(() => rm(root, { recursive: true, force: true }));
  const owner = { sessionId: 'session-one', generation: 'gen-one', terminal: { coreId: 'core-one', terminalId: 'owner', address: 'owner', socket: join(root, 'sock'), sessionNamespace: 'l' }, cwd: root, name: null, sessionFile: null } as Owner;
  const ownerPlacement = { space: 's1', tab: 'tb1', pane: 'p1' } as OwnerPlacement;
  const placements = new Map<TerminalAddress, OwnerPlacement>([[owner.terminal.address, ownerPlacement]]);
  const labelWrites: { address: TerminalAddress; labels: Readonly<Record<string, string | null>> }[] = [];
  const setLabels = async (address: TerminalAddress, labels: Readonly<Record<string, string | null>>) => { labelWrites.push({ address, labels }); };
  const calls: HcRunRequest[] = []; const kills: TerminalAddress[] = []; const reads: { address: TerminalAddress; lines: number }[] = []; const launcherCalls: RunId[] = []; const parked: string[] = [];
  const appCalls: { name: string; args: Readonly<Record<string, unknown>> }[] = []; let keptTab = 0;
  let screen = ''; let adopted = false; let available = true; let next = 0;
  const app: AppClient = {
    ownerPlacement: async address => { if (!available) throw Object.assign(new Error('app unavailable'), { code: 'app-disconnected' }); const value = placements.get(address); if (!value) throw Object.assign(new Error('unplaced'), { code: 'owner-unplaced' }); return value; },
    awaitPane: async (viewer, placement, { signal, timeoutMs }) => {
      const until = Date.now() + timeoutMs;
      while (!adopted && Date.now() < until) { if (signal?.aborted) throw Object.assign(new Error('aborted'), { code: 'aborted' }); await new Promise(r => setTimeout(r, 5)); }
      if (!adopted) throw Object.assign(new Error('no pane'), { code: 'pane-timeout' });
      placements.set(viewer, { ...placement, pane: `pane-${viewer}` as PaneId }); return `pane-${viewer}` as PaneId;
    },
    command: async (name, args) => { appCalls.push({ name, args }); if (name === 'terminal.park') { parked.push(String(args.terminal)); placements.delete(args.terminal as TerminalAddress); } else if (name === 'terminal.keep') { if (args.place !== 'tab') throw new Error('Expected tab placement'); placements.set(args.terminal as TerminalAddress, { ...ownerPlacement, tab: `kept-${++keptTab}` as never, pane: `pane-${args.terminal}` as never }); } else if (name === 'pane.focus' && !placements.has(args.terminal as TerminalAddress)) throw new Error('No such pane'); return {}; },
  };
  let onEvent: ((event: HcEvent) => void) | undefined;
  const hc: HcClient = { identity: async () => owner.terminal, caller: async () => owner.terminal, machines: async () => [], setLabels, events: () => ({ ready: Promise.resolve(), subscribe: listener => { onEvent = listener; return () => { onEvent = undefined; }; }, lookup: async () => null, dispose: async () => {} }), run: async request => { calls.push(request); return { address: `viewer-${++next}` as TerminalAddress, coreId: owner.terminal.coreId }; }, read: async (address, opts) => { reads.push({ address, ...opts }); return screen; }, get: async address => ({ address, labels: address === 'viewer-1' ? calls[0]?.labels ?? {} : address === 'other-agent' ? { 'spider.kind': 'session' } : address === 'remote.invalid/t2' ? { 'spider.kind': 'exec', 'spider.job': 'job-one' } : {}, parent: null, state: 'finished', status: null, exitCode: 0, reason: 'exited', signal: null, finishedAt: 1000 }), kill: async address => { kills.push(address); }, rm: async () => {}, fileRead: async () => Buffer.alloc(0), fileWrite: async () => {} };
  const panes = createAuxiliaryPanes({ hc, discardSubagentViewer: async (_id, _owner, viewer) => { await hc.kill(viewer); await hc.rm(viewer); }, app, subagentViewer: async (runId: RunId) => { launcherCalls.push(runId); return `sub-${runId}` as TerminalAddress; }, limit, clock: Date.now }); cleanups.push(async () => { await panes.dispose(); });
  const job: JobRecord = { version: 1, id: 'job-one' as JobId, owner, machine: 'remote.invalid' as JobRecord['machine'], kind: 'exec', phase: { kind: 'waiting-for-pane', address: 'remote.invalid/t2' as TerminalAddress }, viewer: null, remoteDirectory: join(root, 'remote.invalid'), localDirectory: root, detached: false, noticeMode: 'tool', notice: 'pending' };
  return { root, owner, ownerPlacement, placements, labelWrites, calls, kills, reads, launcherCalls, parked, appCalls, hc, app, panes, job, emit: (event: HcEvent, updateLayout = true) => { if (updateLayout && event.type === 'removed') placements.delete(event.terminal); onEvent?.(event); }, adopt: () => { adopted = true; }, marker: () => { screen = observerMarker('nonce-one'); }, unavailable: () => { available = false; }, setScreen: (value: string) => { screen = value; } };
}

describe('auxiliary panes and observers', () => {
  it('acceptance D releases a parked short job after confirmed labels without an observer', async () => {
    await runAcceptance('jobs', acceptanceD);
  }, 30000);
  it('an explicit observer opens independently of the already released payload', async () => {
    const h = await fixture(); const releaseWrites: unknown[] = []; let settled = false;
    const get = h.hc.get;
    h.hc.get = async address => address !== 'remote.invalid/t2' ? get(address) : ({ address, labels: { 'spider.machine': 'remote.invalid', 'spider.job': h.job.id, 'spider.session': h.owner.sessionId, 'spider.owner-core': h.owner.terminal.coreId, 'spider.owner-terminal': h.owner.terminal.terminalId, 'spider.kind': 'exec' }, parent: null, state: 'live', status: null, exitCode: null, reason: null, signal: null, finishedAt: null });
    await releaseRemoteJob(h.job, { hc: h.hc, nonce: 'payload-nonce', releaseDeadlineAt: Date.now() + 10000, releaseFileWriter: async (_job, bytes) => { releaseWrites.push(JSON.parse(bytes.toString())); }, clock: Date.now });
    const pending = openRemoteObserver(h.job, { hc: h.hc, app: h.app, panes: h.panes, viewerExecutable: ['node', 'viewer.mjs'], hcBinary: 'hc', nonce: 'nonce-one', deadlineAt: Date.now() + 10000, clock: Date.now }).then(value => { settled = true; return value; });
    await new Promise(r => setImmediate(r)); expect(settled).toBe(false); expect(releaseWrites).toHaveLength(1);
    h.adopt(); await new Promise(r => setTimeout(r, 20)); expect(releaseWrites).toHaveLength(1);
    h.marker(); const observer = await pending;
    expect(releaseWrites).toHaveLength(1); expect(releaseWrites[0]).toMatchObject({ jobId: 'job-one', nonce: 'payload-nonce' });
    expect(JSON.parse(await readFile(h.calls[0].argv.at(-1) + '.ready', 'utf8'))).toMatchObject({ jobId: 'job-one', nonce: 'nonce-one' });
    expect(h.calls[0]).toMatchObject({ parent: null, noNotify: true, labels: { 'spider.kind': 'remote-observer' } });
    expect(h.reads.every(r => r.address === observer.viewer && r.lines === 100)).toBe(true);
    await observer.release(); expect(h.parked).toEqual([observer.viewer]);
  });

  it('the observer program attaches read-only with 100-line history and waits for its own removal gate', async () => {
    const h = await fixture(), core = await createClientFixture(); cleanups.push(core.close); const binary = join(h.root, 'fake-attach'), argsFile = join(h.root, 'attach-args'), exitFile = join(h.root, 'exit.json');
    await writeFile(binary, '#!/bin/sh\nprintf "%s\\n" "$@" > "$ARGS_FILE"\nexit 7\n'); await chmod(binary, 0o700);
    await writeFile(exitFile, JSON.stringify({ version: 1, nonce: 'nonce-one' }));
    const rc = await runRemoteObserver({ hcBinary: binary, address: 'remote.invalid/t2' as TerminalAddress, nonce: 'nonce-one', exitFile, env: { ...core.localEnv, ARGS_FILE: argsFile, TMPDIR: h.root } });
    expect(rc).toBe(7); expect((await readFile(argsFile, 'utf8')).trim().split('\n')).toEqual(['attach', '--observe', '--history', '100', 'remote.invalid/t2']);
  });

  it('a failed observer open cleans up only its local viewer, never the original job', async () => {
    const h = await fixture(); h.adopt();
    await expect(openRemoteObserver(h.job, { hc: h.hc, app: h.app, panes: h.panes, viewerExecutable: ['node', 'viewer.mjs'], hcBinary: 'hc', nonce: 'nonce-one', deadlineAt: Date.now() + 30, clock: Date.now })).rejects.toMatchObject({ code: 'observer-timeout' });
    expect(h.kills).toEqual(['viewer-1']);
    expect(h.kills).not.toContain('remote.invalid/t2');
  });

  it.each(['owner', 'remote.invalid/t2'])('rejects an observer launcher returning protected address %s without killing it', async address => {
    const h = await fixture();
    h.hc.run = async () => ({ address: address as TerminalAddress, coreId: h.owner.terminal.coreId });
    await expect(openRemoteObserver(h.job, { hc: h.hc, app: h.app, panes: h.panes, viewerExecutable: ['node', 'viewer.mjs'], hcBinary: 'hc', nonce: 'nonce-one', deadlineAt: Date.now() + 100, clock: Date.now })).rejects.toMatchObject({ code: 'observer-address-invalid' });
    expect(h.kills).toEqual([]);
  });

  it.each([['other-agent', 'agent-pane-protected'], ['remote.invalid/t2', 'job-terminal-protected']])('does not place or kill protected auxiliary-launch address %s', async (address, expectedCode) => {
    const h = await fixture();
    const panes = createAuxiliaryPanes({ hc: h.hc, discardSubagentViewer: async (_id, _owner, viewer) => { await h.hc.kill(viewer); await h.hc.rm(viewer); }, app: h.app, subagentViewer: async () => address as TerminalAddress, clock: Date.now });
    cleanups.push(async () => { await panes.dispose(); });
    await expect(panes.acquire('subagent', 'bad-view' as RunId, h.owner, { timeoutMs: 30 })).rejects.toMatchObject({ code: expectedCode });
    expect(h.kills).toEqual([]); expect(h.labelWrites).toEqual([]); expect(h.parked).toEqual([]);
  });

  it('reserves every remote job immediately without using strip capacity', async () => {
    const h = await fixture(); const first = await h.panes.reserveRemote('first' as JobId, h.owner, { timeoutMs: 1000 });
    const second = await h.panes.reserveRemote('second' as JobId, h.owner, { timeoutMs: 1000 });
    const order: string[] = [];
    const third = h.panes.reserveRemote('third' as JobId, h.owner, { timeoutMs: 1000 }).then(slot => { order.push('third'); return slot; });
    const fourth = h.panes.reserveRemote('fourth' as JobId, h.owner, { timeoutMs: 1000 }).then(slot => { order.push('fourth'); return slot; });
    await Promise.all([third, fourth]); expect(order).toEqual(['third', 'fourth']);
    await h.panes.abandon(first); await h.panes.abandon(second);
    expect(h.placements.size).toBe(1); expect(h.parked).toEqual([]);
  });

  it('native observer removal leaves remote reservations independent of display capacity', async () => {
    const h = await fixture(1); h.adopt(); const slot = await h.panes.reserveRemote('first' as JobId, h.owner, { timeoutMs: 1000 });
    const reservation = await h.panes.display(slot, 'remote-viewer' as TerminalAddress, { timeoutMs: 1000 });
    let entered = false; const waiting = h.panes.reserveRemote('remote.invalid' as JobId, h.owner, { timeoutMs: 1000 }).then(() => { entered = true; }, () => {});
    h.emit({ type: 'removed', terminal: reservation!.viewer, seq: 2 }); await new Promise(r => setTimeout(r, 20));
    expect(entered).toBe(true); await waiting;
  });

  it('a native removal does not free display capacity until the app acknowledges pane absence', async () => {
    const h = await fixture(1); h.adopt(); const slot = await h.panes.reserveRemote('first' as JobId, h.owner, { timeoutMs: 1000 });
    const reservation = await h.panes.display(slot, 'remote-viewer' as TerminalAddress, { timeoutMs: 1000 });
    let entered = false; const waiting = h.panes.acquire('subagent', 'next-run' as RunId, h.owner, { timeoutMs: 1000 }).then(() => { entered = true; }, () => {});
    h.emit({ type: 'removed', terminal: reservation.viewer, seq: 2 }, false); await new Promise(r => setTimeout(r, 20)); expect(entered).toBe(false);
    h.placements.delete(reservation.viewer); await new Promise(r => setTimeout(r, 70)); expect(entered).toBe(true); await waiting;
  });

  it('concurrent release parks its owned viewer only once', async () => {
    const h = await fixture(); h.adopt(); const reservation = await h.panes.acquire('subagent', 'run-one' as RunId, h.owner, { timeoutMs: 1000 });
    await Promise.all([h.panes.release(reservation!), h.panes.release(reservation!)]); expect(h.parked).toEqual(['sub-run-one']);
  });

  it('three jobs launch without observers or waiting for detached tool returns', async () => {
    const h = await fixture(); h.adopt();
    const program = { directory: h.root, argv: ['node', 'runtime.mjs'], files: [], cwd: null, env: {} };
    let finished: JobId | null = null, reserved = 0, arrived!: () => void;
    const thirdReserved = new Promise<void>(r => { arrived = r; });
    const jobs = createJobMonitor({ hc: h.hc, app: h.app, journalRoot: h.root, panes: {
      reserve: (id, owner, options) => { if (++reserved === 3) arrived(); return h.panes.reserveRemote(id, owner, options); },
      observe: async (job, slot) => { const reservation = await h.panes.display(slot, `view-${job.id}` as TerminalAddress, { timeoutMs: 1000 }); return { viewer: reservation.viewer, release: () => h.panes.release(reservation) }; }, abandon: slot => h.panes.abandon(slot),
    }, outputCollector: {
      prepare: async (_program, job) => ({ program: { ...program, directory: join(h.root, job.id) }, nonce: 'nonce-one', releaseDeadlineAt: Date.now() + 10000 }),
      collect: async job => ({ complete: job.id === finished, summary: '', receipt: job.id === finished ? { jobId: job.id, nonce: 'nonce-one', finish: { exitCode: 23, reason: 'exited', signal: null, finishedAt: 1000 } } : null }),
    }, observedJobMessages: async () => [], notifier: async () => {}, clock: Date.now });
    cleanups.push(async () => { await jobs.dispose(); });
    h.hc.get = async address => ({ address, parent: h.owner.terminal.address, labels: h.calls.at(-1)!.labels, state: 'live', status: null, exitCode: null, reason: null, signal: null, finishedAt: null });
    const first = await jobs.start(program, h.owner, h.job.machine, { background: true }), second = await jobs.start(program, h.owner, h.job.machine, { background: true });
    await jobs.detach(first.id); await jobs.detach(second.id); expect(h.parked).toEqual([]);
    const waiting = new AbortController(), thirdStarting = jobs.start(program, h.owner, h.job.machine, { signal: waiting.signal }); void thirdStarting.catch(() => {});
    await thirdStarting; expect(h.calls.filter(c => c.on === h.job.machine)).toHaveLength(3);
    await jobs.toolReturned(first.id); await jobs.toolReturned(second.id); expect(h.parked).toEqual([]);
    expect(reserved).toBe(0); void thirdReserved; void waiting;
    const third = await thirdStarting; finished = third.id;
    h.hc.get = async address => ({ address, parent: h.owner.terminal.address, labels: h.calls.at(-1)!.labels, state: 'finished', status: null, exitCode: 23, reason: 'exited', signal: null, finishedAt: 1000 }); await jobs.reconcile();
    expect((await third.finished).exitCode).toBe(23); expect(h.calls.filter(c => c.on === h.job.machine)).toHaveLength(3);
  });

  it('remote reservations have no pane-slot-timeout even when the strip is full', async () => {
    const h = await fixture(1); h.adopt();
    await h.panes.acquire('subagent', 'first' as RunId, h.owner, { timeoutMs: 1000 });
    const slot = await h.panes.reserveRemote('second' as JobId, h.owner, { timeoutMs: 1 });
    expect(slot.id).toBeTruthy(); expect(h.parked).toEqual([]); expect(h.calls).toEqual([]);
  });

  it('explicit display opens a new tab without evicting job observers, viewers or the agent', async () => {
    const h = await fixture(); h.adopt();
    await h.panes.acquire('subagent', 'first' as RunId, h.owner, { timeoutMs: 1000 });
    const remote = await h.panes.reserveRemote('job' as JobId, h.owner, { timeoutMs: 1000 });
    await h.panes.display(remote, 'job-view' as TerminalAddress, { timeoutMs: 1000 });
    await h.panes.acquire('subagent', 'next' as RunId, h.owner, { timeoutMs: 1000 });
    expect(h.parked).toEqual([]);
    expect([...h.placements.keys()]).toEqual(['owner', 'sub-first', 'job-view', 'sub-next']);
    expect(h.appCalls.filter(call => call.name === 'terminal.keep')).toEqual([{ name: 'terminal.keep', args: { terminal: 'sub-next', place: 'tab' } }]);
    expect(h.appCalls.at(-1)).toEqual({ name: 'pane.focus', args: { terminal: 'sub-next' } });
    expect(h.placements.get(h.owner.terminal.address)).toEqual(h.ownerPlacement);
  });

  it('concurrent automatic viewers fill both free slots and park only the excess viewer', async () => {
    const h = await fixture(); h.adopt();
    const opened = await Promise.all(['first', 'second', 'third'].map(id => h.panes.acquire('subagent', id as RunId, h.owner, { timeoutMs: 1000, automatic: true })));
    expect(opened.map(r => r?.viewer ?? null)).toEqual(['sub-first', 'sub-second', null]);
    expect([...h.placements.keys()]).toEqual(['owner', 'sub-first', 'sub-second']);
    expect(h.parked).toEqual(['sub-third']);
  });

  it('an invalid auxiliary launcher never parks, kills or relabels the agent terminal', async () => {
    const h = await fixture(); h.adopt();
    const panes = createAuxiliaryPanes({ hc: h.hc, discardSubagentViewer: async (_id, _owner, viewer) => { await h.hc.kill(viewer); await h.hc.rm(viewer); }, app: h.app, subagentViewer: async () => h.owner.terminal.address, clock: Date.now });
    cleanups.push(() => Promise.resolve(panes.dispose()));
    await expect(panes.acquire('subagent', 'invalid' as RunId, h.owner, { timeoutMs: 1000 })).rejects.toMatchObject({ code: 'agent-pane-protected' });
    expect(h.parked).toEqual([]); expect(h.kills).toEqual([]); expect(h.labelWrites).toEqual([]);
    expect(h.placements.get(h.owner.terminal.address)).toEqual(h.ownerPlacement);
  });

  it('explicit display keeps a third viewer in a new tab without eviction', async () => {
    const h = await fixture(); h.adopt();
    await h.panes.acquire('subagent', 'first' as RunId, h.owner, { timeoutMs: 1000 });
    await h.panes.acquire('subagent', 'second' as RunId, h.owner, { timeoutMs: 1000 });
    await h.panes.acquire('subagent', 'third' as RunId, h.owner, { timeoutMs: 1000 });
    expect(h.parked).toEqual([]);
    expect([...h.placements.keys()]).toEqual(['owner', 'sub-first', 'sub-second', 'sub-third']);
    expect(h.appCalls.filter(call => call.name === 'terminal.keep')).toEqual([{ name: 'terminal.keep', args: { terminal: 'sub-third', place: 'tab' } }]);
    expect(h.appCalls.at(-1)).toEqual({ name: 'pane.focus', args: { terminal: 'sub-third' } });
  });

  it('explicit display opens a new tab without evicting either job observer', async () => {
    const h = await fixture(); h.adopt();
    for (const id of ['first', 'second']) {
      const slot = await h.panes.reserveRemote(id as JobId, h.owner, { timeoutMs: 1000 });
      await h.panes.display(slot, `${id}-view` as TerminalAddress, { timeoutMs: 1000 });
    }
    await h.panes.acquire('subagent', 'third' as RunId, h.owner, { timeoutMs: 1000 });
    expect(h.parked).toEqual([]);
    expect(h.appCalls.filter(call => call.name === 'terminal.keep')).toEqual([{ name: 'terminal.keep', args: { terminal: 'sub-third', place: 'tab' } }]);
    expect(h.appCalls.at(-1)).toEqual({ name: 'pane.focus', args: { terminal: 'sub-third' } });
  });

  it.each(['disposed', 'aborted'] as const)('%s acquisition never calls the injected viewer launcher', async state => {
    const h = await fixture(), abort = new AbortController(); if (state === 'disposed') await h.panes.dispose(); else abort.abort();
    await expect(h.panes.acquire('subagent', 'run-one' as RunId, h.owner, { timeoutMs: 1000, signal: abort.signal })).rejects.toMatchObject({ code: state });
    expect(h.launcherCalls).toEqual([]); expect(h.calls).toEqual([]);
  });

  it.each(['launcher', 'placement'] as const)('a viewer pending %s during disposal is removed rather than adopted', async stage => {
    const h = await fixture(); let finish!: (address: TerminalAddress) => void, entered!: () => void, unblock!: () => void;
    const launched = new Promise<TerminalAddress>(r => { finish = r; }), started = new Promise<void>(r => { entered = r; }), blocked = new Promise<void>(r => { unblock = r; }), remove = vi.spyOn(h.hc, 'rm');
    const app: AppClient = { ...h.app, ownerPlacement: async address => { if (stage === 'placement') { entered(); await blocked; } return h.app.ownerPlacement(address); } };
    const panes = createAuxiliaryPanes({ hc: h.hc, discardSubagentViewer: async (_id, _owner, viewer) => { await h.hc.kill(viewer); await h.hc.rm(viewer); }, app, subagentViewer: async () => { if (stage === 'launcher') { entered(); return launched; } return 'late-viewer' as TerminalAddress; }, clock: Date.now }); cleanups.push(async () => { await panes.dispose(); });
    const acquiring = panes.acquire('subagent', 'run-one' as RunId, h.owner, { timeoutMs: 1000 }); void acquiring.catch(() => {}); await started; await panes.dispose(); finish('late-viewer' as TerminalAddress); unblock();
    await expect(acquiring).rejects.toMatchObject({ code: 'disposed' }); expect(h.kills).toEqual(['late-viewer']); expect(remove).toHaveBeenCalledWith('late-viewer'); expect(h.labelWrites).toEqual([]);
  });

  it('app unavailability fails before any remote observer is launched', async () => {
    const h = await fixture(); h.unavailable();
    await expect(h.panes.reserveRemote(h.job.id, h.owner, { timeoutMs: 1000 })).rejects.toMatchObject({ code: 'app-disconnected' }); expect(h.calls).toEqual([]);
  });

  it('acquire revalidates identity through the launcher and returns its actual viewer address', async () => {
    const h = await fixture(); h.adopt(); const id = 'run-one' as RunId;
    const first = await h.panes.acquire('subagent', id, h.owner, { timeoutMs: 1000 });
    const again = await h.panes.acquire('subagent', id, h.owner, { timeoutMs: 1000 });
    expect(h.launcherCalls).toEqual([id, id]); expect(first).toMatchObject({ id, viewer: 'sub-run-one', pane: 'pane-sub-run-one' }); expect(again).toBe(first);
  });

  it('restores local owner labels and reuses a parked viewer without a focused keep command', async () => {
    const h = await fixture(); h.adopt(); const id = 'run-one' as RunId;
    const first = await h.panes.acquire('subagent', id, h.owner, { timeoutMs: 1000 }); await h.panes.park(id);
    const second = await h.panes.acquire('subagent', id, h.owner, { timeoutMs: 1000 });
    expect(first?.viewer).toBe('sub-run-one'); expect(second?.viewer).toBe('sub-run-one'); expect(h.launcherCalls).toEqual([id, id]);
    expect(h.labelWrites).toEqual([
      { address: 'sub-run-one', labels: { 'herdr.space': 's1', 'herdr.tab': 'tb1' } },
      { address: 'sub-run-one', labels: { 'herdr.space': 's1', 'herdr.tab': 'tb1' } },
    ]);
  });

  it('automatic run events park excess viewers, while user peek opens them', async () => {
    const h = await fixture(1); h.adopt();
    const handlers = new Map<string, () => Promise<void>>();
    const pi = { on: (event: string, handler: () => Promise<void>) => { handlers.set(event, handler); } } as unknown as ExtensionAPI;
    const registration = registerHerdrViewers(pi, { owner: () => h.owner, hc: h.hc, panes: h.panes,
      ipcDescriptor: () => ({ version: 1, sessionId: h.owner.sessionId, generation: h.owner.generation, address: h.owner.terminal.socket, capabilityFile: join(h.root, 'cap') }),
      viewerExecutable: 'viewer.mjs', feedRoot: h.root,
      viewerLauncher: async id => `sub-${id}` as TerminalAddress,
      ownedRunEvents: { list: async () => ['first' as RunId, 'second' as RunId], subscribe: () => () => {} },
    });
    cleanups.push(() => Promise.resolve(registration.dispose()));
    await handlers.get('session_start')!();
    await vi.waitFor(() => expect([...h.placements.keys()]).toEqual(['owner', 'sub-first']));
    expect((await registration.peek('second' as RunId))?.address).toBe('sub-second');
    expect([...h.placements.keys()]).toEqual(['owner', 'sub-first', 'sub-second']);
    expect(h.parked).toEqual(['sub-second']);
    expect(h.appCalls.filter(call => call.name === 'terminal.keep')).toEqual([{ name: 'terminal.keep', args: { terminal: 'sub-second', place: 'tab' } }]);
    expect(h.appCalls.at(-1)).toEqual({ name: 'pane.focus', args: { terminal: 'sub-second' } });
  });

  it('a full strip parks subagent viewers without delaying their runs', async () => {
    const h = await fixture(1); h.adopt(); await h.panes.acquire('subagent', 'first-run' as RunId, h.owner, { timeoutMs: 1000 });
    const id = 'parked-run' as RunId; expect(await h.panes.acquire('subagent', id, h.owner, { timeoutMs: 1000, automatic: true })).toBeNull();
    expect(h.launcherCalls).toEqual(['first-run', id]);
    expect(await h.panes.acquire('subagent', id, h.owner, { timeoutMs: 1000, automatic: true })).toBeNull(); expect(h.launcherCalls).toEqual(['first-run', id, id]);
    expect(h.placements.has('sub-first-run' as TerminalAddress)).toBe(true);
  });
});

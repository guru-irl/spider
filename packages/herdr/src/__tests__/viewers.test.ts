// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { PassThrough } from 'node:stream';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { describe, it, expect, vi } from 'vitest';
import { projectTranscript } from '../viewers/transcript.js';
import { HerdrError } from '../client/parse.js';
import { runViewer, createViewerFeedSource, type ViewerStreamClient } from '../viewers/program.js';
import { registerHerdrViewers, createViewerLauncher } from '../viewers/register.js';
import { createHerdrHarness, type HerdrHarness } from './testutil.js';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { RunViewFrame, RunCursor } from '../contracts.js';
import type { RunId, IpcDescriptor, RunSummary, SessionFeed, TerminalSummary, TerminalAddress, PaneReservation, PaneId } from '../contracts.js';

const runId = '10000000-0000-4000-8000-000000000001' as RunId;
const descriptor = { sessionId: 'owner', generation: 'generation' } as IpcDescriptor;
function summary(status: RunSummary['status'] = 'running'): RunSummary {
  return { id: runId, ownerSessionId: descriptor.sessionId, name: null, status, childMode: 'rpc', canSteer: true,
    startedAt: 1, finishedAt: null, viewer: null, result: null };
}
function feed(generation = descriptor.generation as string, updatedAt = Date.now()): SessionFeed {
  const owner = { sessionId: descriptor.sessionId, generation: generation as IpcDescriptor['generation'], terminal: { coreId: 'core', terminalId: 'owner-terminal', address: 'owner-terminal', socket: '/fixture/core.sock', sessionNamespace: 'fixture' }, cwd: '/fixture', sessionFile: null, name: null } as SessionFeed['owner'];
  return { version: 1, sessionId: owner.sessionId, generation: owner.generation, revision: 1, updatedAt, owner, placement: null, lifecycle: 'live',
    status: { native: 'working', effective: 'working', message: null }, runs: { rows: [], total: 0, truncated: false }, todos: { rows: [], total: 0, truncated: false }, triggers: [],
    pace: { scope: 'shared', used: null, budget: null, projected: null, remaining: null, periodStart: null, periodEnd: null, updatedAt: null, unavailableReason: 'fixture' }, approvals: [], notifications: [],
    ipc: { address: '/fixture/ipc.sock', capabilityFile: '/fixture/capability' }, errors: [] };
}
function transport() {
  let emit: ((frame: RunViewFrame) => void) | undefined;
  let disconnect: (() => void) | undefined;
  const cursors: (RunCursor | null)[] = [];
  const client: ViewerStreamClient = {
    async subscribeRun(_id, cursor, listener) {
      cursors.push(cursor); emit = listener;
      const closed = new Promise<void>(resolve => { disconnect = resolve; });
      return { closed, dispose: () => { emit = undefined; disconnect?.(); } };
    },
  };
  return { client, cursors, push(frame: RunViewFrame) { emit?.(frame); }, drop() { disconnect?.(); } };
}
function viewerOptions(t: ReturnType<typeof transport>) { return { runId, sessionId: descriptor.sessionId, feedRoot: '/fixture', createClient: () => t.client, feedSource: { read: async () => feed(), subscribe: () => () => {} } }; }
function launcherFor(h: HerdrHarness, executable: string) {
  return createViewerLauncher({ owner: () => h.owner, hc: h.hc, viewerExecutable: executable, feedRoot: join(h.directories.global, 'herdr'),
    ipcDescriptor: () => ({ version: 1, sessionId: h.owner!.sessionId, generation: h.owner!.generation, address: join(h.root, 'v.sock'), capabilityFile: join(h.root, 'v.cap') }) });
}
async function flush() { await new Promise<void>(resolve => setImmediate(resolve)); }
function textFrame(cursor: string, text: string): RunViewFrame {
  return { kind: 'event', runId, cursor: cursor as RunCursor, data: { text, events: [] } };
}

describe('external run viewer', () => {
  it('rejects invalid UTF-8 feed bytes instead of silently replacing their text', async () => {
    const root = resolve('.spider/scratch/h', randomUUID()); const directory = join(root, 'sessions', descriptor.sessionId); mkdirSync(directory, { recursive: true });
    const value = feed(); value.owner.name = '漢'; const bytes = Buffer.from(JSON.stringify(value)); const at = bytes.indexOf(Buffer.from('漢'));
    writeFileSync(join(directory, 'session.json'), Buffer.concat([bytes.subarray(0, at + 1), bytes.subarray(at + 3)]), { mode: 0o600 });
    try { expect(await createViewerFeedSource(root, descriptor.sessionId).read()).toBeNull(); }
    finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('projects split controls without preserving unsafe tool or escalation labels', () => {
    const page = projectTranscript([
      { runId, id: 1, type: 'escalation', summary: 'ESCALATION[blocked]: \u001b[2JStop', text: 'first\u001b]750' },
      { runId, id: 2, type: 'tool_intent', tool: '\u001b[31mtool', text: '1;state=done\u0007second' },
    ]);
    expect(page.text).toBe('firstsecond'); expect(JSON.stringify(page.events)).not.toContain('\\u001b');
    expect(page.events[0].summary).toBe('ESCALATION[blocked]: Stop'); expect(page.events[1].tool).toBe('tool');
  });
  it('creates one parented parked viewer for a queued run and reuses it on peek', async () => {
    const h = await createHerdrHarness('fake'); await h.start();
    const executable = join(h.root, 'viewer-fixture.mjs'); writeFileSync(executable, 'setInterval(() => {}, 1000);');
    try {
      const handlers = new Map<string, () => Promise<void>>();
      let emit: ((id: RunId) => void) | undefined;
      const pi = { on: (event: string, handler: () => Promise<void>) => { handlers.set(event, handler); } } as unknown as ExtensionAPI;
      const parks: RunId[] = [];
      const registration = registerHerdrViewers(pi, {
        owner: () => h.owner, hc: h.hc, viewerExecutable: executable,
        feedRoot: join(h.directories.global, 'herdr'), ipcDescriptor: () => ({ ...descriptor, sessionId: h.owner!.sessionId, generation: h.owner!.generation }),
        ownedRunEvents: { list: async () => [runId], subscribe: (_owner, listener) => { emit = listener; return () => { emit = undefined; }; } },
        panes: { acquire: async (_kind, id, owner) => { await registration.launcher(id as RunId, owner); return null; }, release: async () => {}, park: async id => { parks.push(id); }, dispose: () => {} },
      });
      await handlers.get('session_start')!();
      emit!(runId); emit!(runId);
      await registration.peek(runId);
      const calls = (await h.calls()).filter(call => call.argv[0] === 'run' && call.argv.includes('spider.kind=subagent-viewer'));
      expect(calls).toHaveLength(1);
      expect(calls[0].argv).toContain('--no-notify');
      expect(calls[0].argv.slice(calls[0].argv.indexOf('--parent') + 1, calls[0].argv.indexOf('--parent') + 2)).toEqual([h.owner!.terminal.address]);
      expect(parks).toContain(runId);
      expect((await h.hc.get((await registration.peek(runId))!.address)).state).toBe('live');
      await registration.dispose();
    } finally { await h.close(); expect(await h.remainingOwnedResources()).toEqual([]); }
  });
  it('retries a failed launch and replaces a cached viewer after explicit terminal closure', async () => {
    const h = await createHerdrHarness('fake'); await h.start(); const executable = join(h.root, 'viewer-fixture.mjs'); writeFileSync(executable, 'setInterval(() => {}, 1000);');
    try {
      const launcher = launcherFor(h, executable);
      await h.scenario({ steps: [{ argvPrefix: ['run'], argvIncludes: ['spider.kind=subagent-viewer'], once: true, stderr: { error: { kind: 'invalid_params', message: 'temporary viewer error' } }, exitCode: 7 }] });
      await expect(launcher(runId, h.owner!)).rejects.toThrow('temporary viewer error'); const first = await launcher(runId, h.owner!);
      expect(await launcher(runId, h.owner!)).toBe(first); await h.hc.kill(first);
      const replacement = await launcher(runId, h.owner!); expect(replacement).not.toBe(first); expect((await h.hc.get(replacement)).state).toBe('live');
    } finally { await h.close(); expect(await h.remainingOwnedResources()).toEqual([]); }
  });
  it('does not claim a live labelled viewer whose owner terminal differs', async () => {
    const h = await createHerdrHarness('fake'); await h.start(); const executable = join(h.root, 'viewer-fixture.mjs'); writeFileSync(executable, 'setInterval(() => {}, 1000);');
    try {
      const foreign = await h.hc.run({ argv: [process.execPath, executable], cwd: h.root, parent: h.owner!.terminal.address,
        labels: { 'spider.session': h.owner!.sessionId, 'spider.owner-core': h.owner!.terminal.coreId, 'spider.owner-terminal': 'another-owner', 'spider.run': runId, 'spider.kind': 'subagent-viewer' }, background: true, noNotify: true, outliveParent: false });
      const address = await launcherFor(h, executable)(runId, h.owner!); expect(address).not.toBe(foreign.address); expect((await h.hc.get(foreign.address)).state).toBe('live');
    } finally { await h.close(); expect(await h.remainingOwnedResources()).toEqual([]); }
  });
  it('freezes the launch owner and rolls back its new terminal if that owner object changes during launch', async () => {
    const h = await createHerdrHarness('fake'); await h.start(); const executable = join(h.root, 'viewer-fixture.mjs'); writeFileSync(executable, 'setInterval(() => {}, 1000);');
    const nativeRun = h.hc.run; let created: TerminalAddress | null = null; let release!: () => void; let entered!: () => void; const gate = new Promise<void>(r => { release = r; }); const began = new Promise<void>(r => { entered = r; });
    h.hc.run = async request => { entered(); await gate; const handle = await nativeRun(request); created = handle.address; return handle; };
    try {
      const launcher = launcherFor(h, executable); const launch = launcher(runId, h.owner!); await began;
      h.owner!.generation = randomUUID() as IpcDescriptor['generation']; release(); await expect(launch).rejects.toThrow('Viewer owner changed during launch');
      expect(created).not.toBeNull(); await expect(h.hc.get(created!)).rejects.toMatchObject({ code: 'not_found' });
    } finally { release(); h.hc.run = nativeRun; await h.close(); expect(await h.remainingOwnedResources()).toEqual([]); }
  });
  it('reconciles an acknowledged reservation on reload and ignores stale, foreign and prefix events', async () => {
    const h = await createHerdrHarness('fake'); await h.start(); const executable = join(h.root, 'viewer-fixture.mjs'); writeFileSync(executable, 'setInterval(() => {}, 1000);');
    const handlers = new Map<string, () => Promise<void>>(); const pi = { on: (event: string, handler: () => Promise<void>) => { handlers.set(event, handler); } } as unknown as ExtensionAPI;
    const releases: PaneReservation[] = []; let acquireCount = 0; const listeners: ((id: RunId) => void)[] = [];
    const makeRegistration = () => {
      const registration = registerHerdrViewers(pi, { owner: () => h.owner, hc: h.hc, feedRoot: join(h.directories.global, 'herdr'), viewerExecutable: executable,
        ipcDescriptor: () => ({ ...descriptor, sessionId: h.owner!.sessionId, generation: h.owner!.generation }),
        ownedRunEvents: { list: async () => [runId], subscribe: (_owner, listener) => { listeners.push(listener); return () => {}; } },
        panes: { acquire: async (_kind, id, owner, options) => { acquireCount++; return { id, owner, kind: 'subagent', viewer: await registration.launcher(id as RunId, owner, options.signal), pane: 'fixture-pane' as PaneId }; }, release: async reservation => { releases.push(reservation); }, park: async () => {}, dispose: () => {} } });
      return registration;
    };
    try {
      const first = makeRegistration(); await handlers.get('session_start')!(); const address = (await first.peek(runId))!.address;
      const before = acquireCount; expect(await first.peek(runId.slice(0, 8) as RunId)).toBeNull(); expect(await first.peek('20000000-0000-4000-8000-000000000002' as RunId)).toBeNull(); expect(acquireCount).toBe(before);
      await handlers.get('session_shutdown')!(); expect(releases).toHaveLength(0); h.owner!.generation = randomUUID() as IpcDescriptor['generation'];
      const beforeReload = await h.hc.get(address);
      const next = makeRegistration(); await handlers.get('session_start')!(); const reloaded = (await next.peek(runId))!.address;
      expect(beforeReload.state).toBe('live');
      expect(reloaded).toBe(address); const beforeStale = acquireCount; listeners[0](runId); await flush(); expect(acquireCount).toBe(beforeStale);
      expect((await h.calls()).filter(call => call.argv[0] === 'run' && call.argv.includes('spider.kind=subagent-viewer'))).toHaveLength(1);
      await h.hc.kill(address); const replacement = (await next.peek(runId))!.address; expect(replacement).not.toBe(address); expect((await h.hc.get(replacement)).state).toBe('live');
      await next.dispose(); expect(releases).toHaveLength(0); await first.dispose(); expect(releases).toHaveLength(0);
    } finally { await h.close(); expect(await h.remainingOwnedResources()).toEqual([]); }
  });
  it('refuses a reservation acknowledging a different terminal', async () => {
    const h = await createHerdrHarness('fake'); await h.start(); const executable = join(h.root, 'viewer-fixture.mjs'); writeFileSync(executable, 'setInterval(() => {}, 1000);');
    const handlers = new Map<string, () => Promise<void>>(); const pi = { on: (event: string, handler: () => Promise<void>) => { handlers.set(event, handler); } } as unknown as ExtensionAPI; const releases: PaneReservation[] = [];
    const registration = registerHerdrViewers(pi, { owner: () => h.owner, hc: h.hc, feedRoot: join(h.directories.global, 'herdr'), viewerExecutable: executable,
      ipcDescriptor: () => ({ ...descriptor, sessionId: h.owner!.sessionId, generation: h.owner!.generation }), ownedRunEvents: { list: async () => [runId], subscribe: () => () => {} },
      panes: { acquire: async (_kind, id, owner) => ({ id, owner, kind: 'subagent', viewer: h.owner!.terminal.address, pane: 'fixture-pane' as PaneId }), release: async r => { releases.push(r); }, park: async () => {}, dispose: () => {} } });
    try { await handlers.get('session_start')!(); await expect(registration.peek(runId)).rejects.toThrow('Viewer reservation acknowledged a different terminal'); expect(releases).toHaveLength(1); }
    finally { await registration.dispose(); await h.close(); expect(await h.remainingOwnedResources()).toEqual([]); }
  });
  it('cancels an in-flight parked viewer launch when its session shuts down', async () => {
    const h = await createHerdrHarness('fake'); await h.start(); const executable = join(h.root, 'viewer-fixture.mjs'); writeFileSync(executable, 'setInterval(() => {}, 1000);');
    const handlers = new Map<string, () => Promise<void>>(); const pi = { on: (event: string, handler: () => Promise<void>) => { handlers.set(event, handler); } } as unknown as ExtensionAPI;
    const nativeRun = h.hc.run; let created: TerminalAddress | null = null; let release!: () => void; let entered!: () => void; const gate = new Promise<void>(r => { release = r; }); const began = new Promise<void>(r => { entered = r; });
    h.hc.run = async request => { entered(); await gate; const handle = await nativeRun(request); created = handle.address; return handle; };
    const registration = registerHerdrViewers(pi, { owner: () => h.owner, hc: h.hc, feedRoot: join(h.directories.global, 'herdr'), viewerExecutable: executable,
      ipcDescriptor: () => ({ ...descriptor, sessionId: h.owner!.sessionId, generation: h.owner!.generation }), ownedRunEvents: { list: async () => [runId], subscribe: () => () => {} },
      panes: { acquire: async () => null, release: async () => {}, park: async () => {}, dispose: () => {} } });
    try {
      const start = handlers.get('session_start')!(); await began; await handlers.get('session_shutdown')!(); release(); await start;
      await expect.poll(() => created).not.toBeNull(); await expect.poll(async () => h.hc.get(created!).then(() => 'live', error => error.code)).toBe('not_found');
    } finally { release(); h.hc.run = nativeRun; await registration.dispose(); await h.close(); expect(await h.remainingOwnedResources()).toEqual([]); }
  });
  it('reloads a newer feed generation in the same terminal and ignores old generations', async () => {
    const root = resolve('.spider/scratch/h', randomUUID()); const file = join(root, 'sessions', descriptor.sessionId, 'session.json'); mkdirSync(join(root, 'sessions', descriptor.sessionId), { recursive: true });
    const first = transport(), next = transport();
    let releaseSubscription!: () => void;
    const subscriptionGate = new Promise<void>(resolve => { releaseSubscription = resolve; });
    const firstClient: ViewerStreamClient = { subscribeRun: async (...args) => { await subscriptionGate; return first.client.subscribeRun(...args); } };
    const factoryGenerations: string[] = []; const submitted: string[] = []; const status = new PassThrough(); let notices = ''; status.on('data', b => { notices += b.toString(); });
    const stdout = new PassThrough(); let raw = ''; stdout.on('data', b => { raw += b.toString(); }); const stdin = new PassThrough(); const abort = new AbortController();
    const initial = feed('generation-a', Date.now()); const replacement = feed('generation-b', initial.updatedAt + 1);
    writeFileSync(file, JSON.stringify(initial), { mode: 0o600 });
    const running = runViewer({ runId, sessionId: descriptor.sessionId, feedRoot: root, stdout, stdin, statusOutput: status, signal: abort.signal,
      createClient: (value: IpcDescriptor) => { factoryGenerations.push(value.generation); return value.generation === 'generation-a' ? firstClient : next.client; },
      submitSteer: async (_client, text) => { submitted.push(text); return { accepted: true, delivered: true, queued: false, delivery: 'delivered' }; } });
    try {
      await expect.poll(() => factoryGenerations).toEqual(['generation-a']); releaseSubscription();
      await expect.poll(() => first.cursors).toEqual([null]);
      first.push({ kind: 'snapshot', runId, cursor: '0' as RunCursor, data: { run: summary() } });
      first.push(textFrame('1', 'first\n'));
      await expect.poll(() => raw).toBe('first\n');
      stdin.write('half-written draft'); writeFileSync(file, JSON.stringify(replacement));
      await expect.poll(() => factoryGenerations).toEqual(['generation-a', 'generation-b']);
      await expect.poll(() => next.cursors).toEqual(['1']); next.push(textFrame('1', 'first\n')); next.push(textFrame('2', 'second\n'));
      next.push({ kind: 'snapshot', runId, cursor: '2' as RunCursor, data: { run: summary() } }); stdin.write(' continued\n'); await flush();
      expect(submitted).toEqual(['half-written draft continued']);
      writeFileSync(file, JSON.stringify(initial)); await new Promise(resolve => setTimeout(resolve, 25));
      expect(factoryGenerations).toEqual(['generation-a', 'generation-b']); expect(raw).toBe('first\nsecond\n');
      writeFileSync(file, JSON.stringify({ ...replacement, revision: 2, lifecycle: 'closed' }));
      await expect.poll(() => notices).toContain('Owning session closed');
    } finally { releaseSubscription(); abort.abort(); await running; rmSync(root, { recursive: true, force: true }); }
  }, 10000);
  it('keeps a closed session read-only and reconnects the same viewer with its cursor and draft', async () => {
    const first = transport(), next = transport(); const stdin = new PassThrough(); const abort = new AbortController();
    let value = feed('generation-a'); let changed = () => {}; let exited = false; const generations: string[] = []; const sends: string[] = [];
    const running = runViewer({ runId, sessionId: descriptor.sessionId, feedRoot: '/fixture', stdout: new PassThrough(), stdin,
      statusOutput: new PassThrough(), signal: abort.signal,
      feedSource: { read: async () => value, subscribe: listener => { changed = listener; return () => {}; } },
      createClient: d => { generations.push(d.generation); return d.generation === 'generation-a' ? first.client : next.client; },
      submitSteer: async (_client, text) => { sends.push(text); return { accepted: true, delivered: true, queued: false, delivery: 'delivered' }; },
    }).then(() => { exited = true; });
    try {
      await flush(); first.push({ kind: 'snapshot', runId, cursor: '0' as RunCursor, data: { run: summary() } }); first.push(textFrame('1', 'saved log\n'));
      value = { ...value, revision: 2, lifecycle: 'closed', ipc: null }; changed(); await flush();
      stdin.write('not sent\n'); await flush(); expect(sends).toEqual([]); expect(exited).toBe(false);
      stdin.write('draft'); value = feed('generation-b', value.updatedAt + 1); changed();
      await expect.poll(() => next.cursors).toEqual(['1']);
      next.push({ kind: 'snapshot', runId, cursor: '1' as RunCursor, data: { run: summary() } }); stdin.write(' continued\n'); await flush();
      expect(generations).toEqual(['generation-a', 'generation-b']); expect(sends).toEqual(['draft continued']);
      value = { ...value, revision: 2, lifecycle: 'closed', ipc: null }; changed(); await flush();
      first.drop(); next.drop(); await flush(); expect(exited).toBe(false);
    } finally { abort.abort(); await running; }
  });
  it.each(['missing', 'no-endpoint', 'closed'] as const)('processes a lifecycle notification promptly while the owner is %s', async state => {
    vi.useFakeTimers(); const t = transport(); const abort = new AbortController(); let changed = () => {};
    let value: SessionFeed | null = state === 'missing' ? null : { ...feed(), lifecycle: state === 'closed' ? 'closed' : 'live', ipc: null };
    const running = runViewer({ ...viewerOptions(t), stdout: new PassThrough(), stdin: new PassThrough(), signal: abort.signal,
      feedSource: { read: async () => value, subscribe: listener => { changed = listener; return () => {}; } } });
    try {
      await vi.advanceTimersByTimeAsync(1); expect(t.cursors).toEqual([]);
      value = feed('resumed', Date.now() + 1); changed();
      await vi.advanceTimersByTimeAsync(100); expect(t.cursors).toEqual([null]);
    } finally { abort.abort(); await running; vi.useRealTimers(); }
  });
  it('bounds lifecycle notification coalescing so a continuous burst cannot starve recovery', async () => {
    vi.useFakeTimers(); const t = transport(); const abort = new AbortController(); let changed = () => {}; let reads = 0;
    let value: SessionFeed | null = null;
    const running = runViewer({ ...viewerOptions(t), stdout: new PassThrough(), stdin: new PassThrough(), signal: abort.signal,
      feedSource: { read: async () => { reads++; return value; }, subscribe: listener => { changed = listener; return () => {}; } } });
    try {
      await vi.advanceTimersByTimeAsync(1); expect(reads).toBe(1);
      value = feed('resumed');
      for (let i = 0; i < 5; i++) { changed(); await vi.advanceTimersByTimeAsync(50); }
      expect(t.cursors).toEqual([null]); expect(reads).toBe(2);
    } finally { abort.abort(); await running; vi.useRealTimers(); }
  });
  it('processes a lifecycle notification received during an in-flight feed read before the next timer tick', async () => {
    vi.useFakeTimers(); const first = transport(), next = transport(); const abort = new AbortController();
    let value = feed('generation-a'); let changed = () => {}; let holdRead = false; let releaseRead: (() => void) | undefined;
    const status = new PassThrough(); let notices = ''; status.on('data', bytes => { notices += bytes.toString(); });
    const running = runViewer({ ...viewerOptions(first), stdout: new PassThrough(), stdin: new PassThrough(), statusOutput: status, signal: abort.signal,
      createClient: d => d.generation === 'generation-a' ? first.client : next.client,
      feedSource: { read: async () => {
        const snapshot = value;
        if (holdRead) { holdRead = false; await new Promise<void>(resolve => { releaseRead = resolve; }); }
        return snapshot;
      }, subscribe: listener => { changed = listener; return () => {}; } } });
    try {
      await vi.advanceTimersByTimeAsync(1); expect(first.cursors).toEqual([null]);
      first.push({ kind: 'snapshot', runId, cursor: '1' as RunCursor, data: { run: summary() } });
      holdRead = true; value = { ...value, revision: 2, lifecycle: 'closed', ipc: null }; changed();
      await vi.advanceTimersByTimeAsync(1); expect(releaseRead).toBeTypeOf('function');
      value = feed('generation-b', value.updatedAt + 1); changed(); releaseRead!();
      await vi.advanceTimersByTimeAsync(10);
      expect(notices).toContain('Owning session closed'); expect(next.cursors).toEqual(['1']);
    } finally { releaseRead?.(); abort.abort(); await running; vi.useRealTimers(); }
  });
  it('wakes reconnect backoff promptly when a lifecycle notification supplies a new endpoint', async () => {
    vi.useFakeTimers(); const next = transport(); const abort = new AbortController(); let changed = () => {};
    let value = feed('generation-a'); const waits: number[] = [];
    const running = runViewer({ ...viewerOptions(next), stdout: new PassThrough(), stdin: new PassThrough(), signal: abort.signal,
      createClient: d => d.generation === 'generation-a' ? { subscribeRun: async () => { throw new Error('Endpoint disposed'); } } : next.client,
      feedSource: { read: async () => value, subscribe: listener => { changed = listener; return () => {}; } },
      wait: ms => { waits.push(ms); return new Promise(resolve => setTimeout(resolve, ms)); } });
    try {
      await vi.advanceTimersByTimeAsync(1); expect(waits).toEqual([250]);
      value = feed('generation-b', value.updatedAt + 1); changed();
      await vi.advanceTimersByTimeAsync(100); expect(next.cursors).toEqual([null]);
    } finally { abort.abort(); await running; vi.useRealTimers(); }
  });
  it.each(['reply', 'end'] as const)('does not hammer an unowned run after a terminal %s refusal', async boundary => {
    vi.useFakeTimers(); const abort = new AbortController(); let attempts = 0; let changed = () => {}; let value = feed('generation-a');
    const client: ViewerStreamClient = { subscribeRun: async (_id, _cursor, emit) => {
      attempts++;
      if (boundary === 'reply') throw new HerdrError('not-found', 'Run is not owned');
      emit({ kind: 'end', runId, cursor: '0' as RunCursor, data: { reason: 'run-not-owned' } });
      return { closed: Promise.resolve(), dispose() {} };
    } };
    const running = runViewer({ runId, sessionId: descriptor.sessionId, feedRoot: '/fixture', stdout: new PassThrough(), stdin: new PassThrough(),
      signal: abort.signal, createClient: () => client,
      feedSource: { read: async () => value, subscribe: listener => { changed = listener; return () => {}; } },
      wait: ms => new Promise(resolve => setTimeout(resolve, ms)),
    });
    try {
      await vi.advanceTimersByTimeAsync(2500); expect(attempts).toBe(1);
      value = feed('generation-b', value.updatedAt + 1); changed(); await vi.advanceTimersByTimeAsync(1000); expect(attempts).toBe(2);
      await vi.advanceTimersByTimeAsync(2500); expect(attempts).toBe(2);
    } finally { abort.abort(); await running; vi.useRealTimers(); }
  });
  it('keeps reconnect status quiet across repeated transport failures', async () => {
    const t = transport(); const status = new PassThrough(); let notices = ''; let attempts = 0; const abort = new AbortController(); status.on('data', b => { notices += b.toString(); });
    const client: ViewerStreamClient = { subscribeRun: async () => { if (++attempts === 3) abort.abort(); throw new Error('closed'); } };
    await runViewer({ ...viewerOptions(t), createClient: () => client, stdout: new PassThrough(), stdin: new PassThrough(), statusOutput: status, signal: abort.signal, wait: async () => {} });
    expect(notices.match(/reconnecting/g)).toHaveLength(1);
  });
  it('refuses a composer submission while the owning feed is missing even if a stale stream sends running', async () => {
    const t = transport(); const stdin = new PassThrough(); let available = true; let changed = () => {}; const sends: string[] = []; const abort = new AbortController();
    const running = runViewer({ ...viewerOptions(t), stdout: new PassThrough(), stdin, statusOutput: new PassThrough(), signal: abort.signal,
      feedSource: { read: async () => available ? feed() : null, subscribe: listener => { changed = listener; return () => {}; } },
      submitSteer: async (_client, text) => { sends.push(text); return { accepted: true, delivered: true, queued: false, delivery: 'delivered' }; }, wait: async () => {} });
    try {
      await flush(); t.push({ kind: 'snapshot', runId, cursor: '0' as RunCursor, data: { run: summary() } }); available = false; changed(); await flush();
      t.push({ kind: 'snapshot', runId, cursor: '0' as RunCursor, data: { run: summary() } }); stdin.write('Retain this draft\n'); await flush(); expect(sends).toEqual([]);
      available = true; changed(); await expect.poll(() => t.cursors.length, { timeout: 3000 }).toBe(2); await flush();
      t.push({ kind: 'snapshot', runId, cursor: '0' as RunCursor, data: { run: summary() } });
      stdin.write('Retain this draft\n'); await flush(); expect(sends).toEqual(['Retain this draft']);
    } finally { abort.abort(); await running; }
  });
  it('drains unread transcript pages after a finish snapshot before beginning the exit hold', async () => {
    const t = transport(); const stdout = new PassThrough(); let raw = ''; stdout.on('data', b => { raw += b.toString(); });
    const abort = new AbortController(); const waits: number[] = [];
    const running = runViewer({ ...viewerOptions(t), stdout, stdin: new PassThrough(), statusOutput: new PassThrough(), signal: abort.signal, wait: async ms => { waits.push(ms); } });
    try {
      await flush(); t.push({ kind: 'snapshot', runId, cursor: '0' as RunCursor, data: { run: summary() } });
      t.push({ kind: 'snapshot', runId, cursor: '0' as RunCursor, data: { run: summary('done') } }); await flush();
      expect(waits).not.toContain(2000);
      t.push(textFrame('1', 'last unread page\n')); t.push({ kind: 'end', runId, cursor: '1' as RunCursor, data: { reason: 'finished' } });
      await running; expect(raw).toBe('last unread page\n'); expect(waits).toContain(2000);
    } finally { abort.abort(); await running; }
  });
  it('keeps a read-only viewer alive after noninteractive stdin reaches EOF', async () => {
    const t = transport(); const stdin = new PassThrough(); const stdout = new PassThrough(); const abort = new AbortController();
    let output = ''; let exited = false; stdout.on('data', bytes => { output += bytes.toString(); });
    const running = runViewer({ ...viewerOptions(t), stdin, stdout, statusOutput: new PassThrough(), signal: abort.signal }).then(() => { exited = true; });
    try {
      stdin.end(); await flush(); await flush();
      t.push({ kind: 'snapshot', runId, cursor: '0' as RunCursor, data: { run: summary() } });
      t.push(textFrame('1', 'visible transcript\n')); await flush();
      expect(exited).toBe(false); expect(output).toBe('visible transcript\n');
    } finally { abort.abort(); await running; }
  });
  it('keeps an already-finished saved run open past the hold until the user closes it', async () => {
    vi.useFakeTimers(); const t = transport(); const stdin = new PassThrough(); Reflect.set(stdin, 'isTTY', true); const abort = new AbortController(); let exited = false;
    const running = runViewer({ ...viewerOptions(t), stdout: new PassThrough(), stdin, statusOutput: new PassThrough(), signal: abort.signal }).then(() => { exited = true; });
    try {
      await vi.advanceTimersByTimeAsync(1); t.push({ kind: 'snapshot', runId, cursor: '0' as RunCursor, data: { run: summary('done') } });
      t.push({ kind: 'end', runId, cursor: '0' as RunCursor, data: { reason: 'finished' } });
      await vi.advanceTimersByTimeAsync(2500); expect(exited).toBe(false);
      stdin.end(); await running; expect(exited).toBe(true);
    } finally { abort.abort(); await running; vi.useRealTimers(); }
  });
  it.each([false, true])('keeps a missing-feed viewer read-only and reattaches with its transcript intact, previously attached: %s', async previouslyAttached => {
    vi.useFakeTimers(); const t = transport(); const abort = new AbortController(); let exited = false, reads = 0, changed = () => {};
    const stdout = new PassThrough(), status = new PassThrough(); let raw = '', notices = '';
    stdout.on('data', bytes => { raw += bytes.toString(); }); status.on('data', bytes => { notices += bytes.toString(); });
    let value: SessionFeed | null = previouslyAttached ? feed() : null;
    const running = runViewer({ ...viewerOptions(t), stdout, statusOutput: status, stdin: new PassThrough(), signal: abort.signal,
      feedSource: { read: async () => { reads++; return value; }, subscribe: listener => { changed = listener; return () => {}; } } }).then(() => { exited = true; });
    try {
      await vi.advanceTimersByTimeAsync(1);
      if (previouslyAttached) {
        t.push({ kind: 'snapshot', runId, cursor: '0' as RunCursor, data: { run: summary() } });
        t.push(textFrame('saved', 'saved transcript\n')); value = null; changed();
      }
      await vi.advanceTimersByTimeAsync(29000); expect(exited).toBe(false);
      await vi.advanceTimersByTimeAsync(2000); expect(exited).toBe(false); expect(notices).toContain('Saved log is read-only');
      expect(raw).toBe(previouslyAttached ? 'saved transcript\n' : '');
      const before = reads;
      for (let i = 0; i < 20; i++) changed();
      await vi.advanceTimersByTimeAsync(5000); expect(reads - before).toBeLessThanOrEqual(6);
      value = feed('resumed', Date.now()); changed(); await vi.advanceTimersByTimeAsync(2000);
      expect(t.cursors).toEqual(previouslyAttached ? [null, 'saved'] : [null]);
      t.push({ kind: 'snapshot', runId, cursor: previouslyAttached ? 'saved' as RunCursor : '0' as RunCursor, data: { run: summary() } });
      if (!previouslyAttached) t.push(textFrame('saved', 'saved transcript\n'));
      t.push(textFrame('next', 'after resume\n'));
      expect(raw).toBe('saved transcript\nafter resume\n'); expect(exited).toBe(false);
    } finally { abort.abort(); await running; vi.useRealTimers(); }
  });
  it.each(['queued', 'paused'] as const)('explains why a %s child cannot steer', async childStatus => {
    const t = transport(); const status = new PassThrough(); const stdin = new PassThrough(); let notices = ''; const sends: string[] = [];
    status.on('data', b => { notices += b.toString(); }); const abort = new AbortController();
    const running = runViewer({ ...viewerOptions(t), stdout: new PassThrough(), stdin, statusOutput: status, signal: abort.signal,
      submitSteer: async (_client, text) => { sends.push(text); return { accepted: true, delivered: true, queued: false, delivery: 'delivered' }; }, wait: async () => {} });
    await flush(); t.push({ kind: 'snapshot', runId, cursor: '0' as RunCursor, data: { run: summary(childStatus) } });
    try { expect(notices).toContain(`This run is ${childStatus}`); stdin.write('Change the brief\n'); await flush(); expect(sends).toEqual([]); }
    finally { abort.abort(); await running; }
  });
  it('retains final results and holds output for two seconds before releasing its pane', async () => {
    const t = transport(); const stdout = new PassThrough(); let raw = ''; stdout.on('data', b => { raw += b.toString(); });
    const abort = new AbortController(); let finishHold!: () => void; const waits: number[] = []; let releases = 0;
    const running = runViewer({ ...viewerOptions(t), stdout, stdin: new PassThrough(), statusOutput: new PassThrough(), signal: abort.signal,
      wait: ms => { waits.push(ms); return ms === 2000 ? new Promise<void>(resolve => { finishHold = resolve; }) : Promise.resolve(); }, release: async () => { releases++; } });
    try {
      await flush(); t.push({ kind: 'snapshot', runId, cursor: '0' as RunCursor, data: { run: summary() } }); t.push(textFrame('1', 'last text\n'));
      t.push({ kind: 'snapshot', runId, cursor: '1' as RunCursor, data: { run: { ...summary('done'), result: 'retained result' } } });
      t.push({ kind: 'end', runId, cursor: '1' as RunCursor, data: { reason: 'finished' } }); await flush();
      expect(raw).toContain('retained result');
      expect(waits).toContain(2000); expect(releases).toBe(0);
      finishHold(); await running; expect(releases).toBe(1);
    } finally { abort.abort(); finishHold?.(); await running; }
  });
  it('submits only the separate composer and displays uncertain acknowledgement once', async () => {
    const t = transport(); const stdout = new PassThrough(); const stdin = new PassThrough(); const status = new PassThrough();
    let raw = ''; let notices = ''; stdout.on('data', b => { raw += b.toString(); }); status.on('data', b => { notices += b.toString(); });
    const sends: string[] = []; const abort = new AbortController();
    const client = { ...t.client, steerRun: async (_runId: RunId, text: string) => { sends.push(text); return { ok: true as const, op: 'steerRun' as const,
      acknowledgement: { accepted: true as const, delivered: false as const, queued: true, delivery: 'accepted but not confirmed' as const } }; } };
    const running = runViewer({ ...viewerOptions(t), createClient: () => client, stdout, stdin, statusOutput: status, signal: abort.signal,
      submitSteer: async (client, text: string) => (await client.steerRun(runId, text)).acknowledgement, wait: async () => {} });
    await flush(); t.push({ kind: 'snapshot', runId, cursor: '0' as RunCursor, data: { run: summary() } });
    t.push(textFrame('1', 'read-only transcript\n'));
    stdin.write('Use case B\n'); await flush();
    abort.abort(); await running;
    expect(sends).toEqual(['Use case B']);
    expect(raw).toBe('read-only transcript\n');
    expect(notices).toContain('accepted but not confirmed');
  });
  it('reconnects by cursor without replaying transcript terminal controls', async () => {
    const t = transport(); const stdout = new PassThrough(); const stdin = new PassThrough();
    let raw = ''; stdout.on('data', bytes => { raw += bytes.toString(); });
    const abort = new AbortController();
    const running = runViewer({ ...viewerOptions(t), stdout, stdin, signal: abort.signal,
      statusOutput: new PassThrough(), wait: async () => {} });
    await flush();
    t.push({ runId, kind: 'snapshot', cursor: '0' as RunCursor, data: { run: summary() } });
    t.push(textFrame('1', 'first\n\u001b]7501;state=done\u0007second\n'));
    t.drop(); await flush();
    t.push(textFrame('1', 'first\n\u001b]7501;state=done\u0007second\n'));
    abort.abort(); await running;
    expect(raw).toBe('first\nsecond\n');
    expect(raw).not.toContain('\u001b]7501');
    expect(t.cursors).toEqual([null, '1']);
  });
});

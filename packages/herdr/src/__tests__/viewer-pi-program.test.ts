// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { afterEach, expect, it, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { runViewer, type ViewerPresenter, type ViewerStreamClient } from '../viewers/program.js';
import type { RunCursor, RunId, RunSummary, RunViewFrame, SessionFeed, SteerReply } from '../contracts.js';

const runId = '10000000-0000-4000-8000-000000000001' as RunId;
const sessionId = 'viewer-owner' as SessionFeed['sessionId'];
const run = (status: RunSummary['status'] = 'running', canSteer = true): RunSummary => ({ id: runId, ownerSessionId: sessionId, name: 'fixture', status, childMode: 'rpc', canSteer, startedAt: 1, finishedAt: null, result: null, viewer: null });
function feedOf(row: RunSummary, updatedAt = Date.now()): SessionFeed {
  return { version: 1, sessionId, generation: 'activation' as SessionFeed['generation'], revision: updatedAt, updatedAt,
    owner: { sessionId, generation: 'activation', terminal: { coreId: 'core', terminalId: 'owner', address: 'owner', socket: '/fixture/core.sock', sessionNamespace: 'fixture' }, cwd: '/fixture', sessionFile: null, name: 'planner' } as SessionFeed['owner'],
    lifecycle: 'live', placement: null, status: { native: 'working', effective: 'working', message: null }, runs: { rows: [row], total: 1, truncated: false }, todos: { rows: [], total: 0, truncated: false }, triggers: [],
    pace: { scope: 'shared', used: null, budget: null, projected: null, remaining: null, periodStart: null, periodEnd: null, updatedAt: null, unavailableReason: 'fixture' },
    approvals: [], notifications: [], errors: [], ipc: { address: '/fixture/ipc.sock', capabilityFile: '/fixture/capability' } };
}
type Call = [string, unknown];
function presenter() {
  const calls: Call[] = []; let steer: ((text: string) => Promise<SteerReply | null>) | null = null; let quit = () => {};
  const value: ViewerPresenter = {
    snapshot: (r, view) => calls.push(['snapshot', view]), page: text => calls.push(['page', text]), live: event => calls.push(['live', event]),
    state: state => calls.push(['state', state]), notice: text => calls.push(['notice', text]), owner: name => calls.push(['owner', name]),
    bindSteer: handler => { steer = handler; }, onQuit: handler => { quit = handler; },
  };
  return { value, calls, steer: (text: string) => steer!(text), quit: () => quit(), last: (kind: string) => calls.filter(call => call[0] === kind).at(-1)?.[1] };
}
afterEach(() => { vi.useRealTimers(); });
function start(options: { presenter?: ReturnType<typeof presenter>; snapshotView?: { protocol: number } | null; pingDelayMs?: number } = {}) {
  let feed = feedOf(run()); let changed = () => {}; let emit: ((frame: RunViewFrame) => void) | undefined; const requested: unknown[] = []; let subscriptions = 0;
  const steers: string[] = []; let reachable = true; let disconnect = () => {}; const pingDelay = options.pingDelayMs;
  const client: ViewerStreamClient = { ping: async probe => {
    if (!reachable) throw new Error('owner stopped');
    if (probe?.timeoutMs !== undefined && probe.timeoutMs < (pingDelay ?? 0)) {
      await new Promise(resolve => setTimeout(resolve, probe.timeoutMs)); throw new Error('ping timed out');
    }
    if (pingDelay) await new Promise(resolve => setTimeout(resolve, pingDelay));
    return { ok: true, op: 'ping', status: { native: null, effective: null } };
  }, subscribeRun: async (_id, _cursor, listener, request) => {
    if (!reachable) throw new Error('owner stopped');
    subscriptions++; requested.push(request?.view); emit = listener;
    const view = options.snapshotView === undefined ? { protocol: 2 } : options.snapshotView;
    listener({ runId, cursor: `c${subscriptions}` as RunCursor, kind: 'snapshot', data: view ? { run: run(), view } : { run: run() } });
    return { closed: new Promise<void>(resolve => { disconnect = resolve; }), dispose() {} };
  } };
  const stdout = new PassThrough(), stdin = new PassThrough(), abort = new AbortController(); let text = '';
  stdout.on('data', bytes => { text += bytes.toString(); });
  const running = runViewer({ runId, sessionId, feedRoot: '/fixture', stdin, stdout, signal: abort.signal, createClient: () => client, presenter: options.presenter?.value,
    wait: ms => new Promise(resolve => setTimeout(resolve, ms)),
    feedSource: { read: async () => feed, subscribe: listener => { changed = listener; return () => {}; } },
    submitSteer: async (_client, draft) => { steers.push(draft); return { delivery: 'delivered', accepted: true, delivered: true, queued: false }; } });
  return { running, abort, text: () => text, steers, requested, subscriptions: () => subscriptions, stdin,
    emit: (frame: RunViewFrame) => emit!(frame),
    drop: () => disconnect(), reachable: (value: boolean) => { reachable = value; },
    heartbeat: () => { feed = feedOf(run()); changed(); },
    stale: (updatedAt: number) => { feed = feedOf(run(), updatedAt); changed(); },
    closeOwner: () => { feed = { ...feed, lifecycle: 'closed', ipc: null, revision: feed.revision + 1 }; changed(); },
    finishFeed: () => { feed = feedOf(run('failed', false)); changed(); },
    async stop() { abort.abort(); await running; } };
}

it('requests the pi view protocol, and hands snapshots, live events and state to the presenter', async () => {
  const p = presenter(); const viewer = start({ presenter: p });
  try {
    await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve));
    expect(viewer.requested).toEqual([2]);
    expect(p.last('snapshot')).toEqual({ protocol: 2 });
    expect(p.last('owner')).toBe('planner');
    viewer.emit({ runId, cursor: 'c1' as RunCursor, kind: 'live', data: { event: { type: 'message_start', message: { role: 'assistant' } } } });
    expect(p.last('live')).toMatchObject({ type: 'message_start' });
    await vi.waitFor(() => expect(p.last('state')).toMatchObject({ status: 'running', steerable: true, reachable: true, readOnlyReason: null }));
    expect(viewer.text()).toBe('');
  } finally { await viewer.stop(); }
});

it('recorded tool events reach the pi presenter when a saved file is unavailable', async () => {
  const p = presenter(); const viewer = start({ presenter: p });
  try {
    await vi.waitFor(() => expect(p.last('snapshot')).toBeTruthy());
    const frame: RunViewFrame = { runId, cursor: 'fallback' as RunCursor, kind: 'event', data: { text: '', events: [{ runId, id: 2, type: 'tool_result', tool: 'spider', summary: 'FALLBACK_TOOL_COMPLETE\u001b]52;c;forbidden\u0007' }] } };
    viewer.emit(frame); viewer.emit(frame);
    expect(p.last('page')).toContain('FALLBACK_TOOL_COMPLETE'); expect(p.last('page')).not.toContain('forbidden');
    expect(p.calls.filter(call => call[0] === 'page')).toHaveLength(1); expect(viewer.text()).toBe('');
  } finally { await viewer.stop(); }
});

it('sends a steer from the presenter through the IPC steer op and returns its delivery', async () => {
  const p = presenter(); const viewer = start({ presenter: p });
  try {
    await vi.waitFor(() => expect(p.last('state')).toMatchObject({ steerable: true }));
    await expect(p.steer('use the helper')).resolves.toMatchObject({ delivery: 'delivered' });
    expect(viewer.steers).toEqual(['use the helper']);
  } finally { await viewer.stop(); }
});

it('refuses a steer locally, with the reason, when the run cannot be steered', async () => {
  const p = presenter(); const viewer = start({ presenter: p });
  try {
    await vi.waitFor(() => expect(p.last('state')).toMatchObject({ steerable: true }));
    viewer.emit({ runId, cursor: 'c2' as RunCursor, kind: 'snapshot', data: { run: run('done', false), view: { protocol: 2 } } });
    await vi.waitFor(() => expect(p.last('state')).toMatchObject({ steerable: false, status: 'done' }));
    await expect(p.steer('too late')).resolves.toMatchObject({ delivery: 'refused', error: 'This run is done.' });
    expect(viewer.steers).toEqual([]);
  } finally { await viewer.stop(); }
});

it('owner closure qualifies an unfinished footer status as last known', async () => {
  const p = presenter(); const viewer = start({ presenter: p });
  try {
    await vi.waitFor(() => expect(p.last('state')).toMatchObject({ steerable: true }));
    viewer.closeOwner();
    await vi.waitFor(() => expect(p.last('state')).toMatchObject({ status: 'running', statusIsStale: true, steerable: false }));
  } finally { await viewer.stop(); }
});

it('a terminal feed status supersedes an older running snapshot in the footer', async () => {
  const p = presenter(); const viewer = start({ presenter: p });
  try {
    await vi.waitFor(() => expect(p.last('state')).toMatchObject({ steerable: true }));
    viewer.finishFeed();
    await vi.waitFor(() => expect(p.last('state')).toMatchObject({ status: 'failed', statusIsStale: false, steerable: false }));
  } finally { await viewer.stop(); }
});

it('an owner without the pi view protocol produces one clear line, not garbage', async () => {
  const p = presenter(); const viewer = start({ presenter: p, snapshotView: null });
  try {
    await vi.waitFor(() => expect(p.last('snapshot')).toBeNull());
    viewer.emit({ runId, cursor: 'c3' as RunCursor, kind: 'snapshot', data: { run: run() } });
    const notices = p.calls.filter(call => call[0] === 'notice').map(call => call[1]);
    expect(notices).toEqual(['The owning session runs an older spider build. Live updates are off until it reloads.']);
  } finally { await viewer.stop(); }
});

it('an owner with a newer protocol also produces one clear line', async () => {
  const p = presenter(); const viewer = start({ presenter: p, snapshotView: { protocol: 3 } });
  try {
    await vi.waitFor(() => expect(p.calls.some(call => call[0] === 'notice')).toBe(true));
    expect(p.calls.filter(call => call[0] === 'notice').map(call => call[1])).toEqual(['The owning session runs a newer spider build. Reopen this viewer to see live updates.']);
    viewer.emit({ runId, cursor: 'next' as RunCursor, kind: 'live', data: { event: { type: 'future-message' } } });
    expect(p.calls.filter(call => call[0] === 'live')).toEqual([]);
  } finally { await viewer.stop(); }
});

it('quitting from the presenter ends the viewer', async () => {
  const p = presenter(); const viewer = start({ presenter: p });
  await vi.waitFor(() => expect(p.last('snapshot')).toBeTruthy());
  p.quit(); await viewer.running;
});

it('reconnects are silent: no transcript lines, and the presenter hears reachable false then true', async () => {
  vi.useFakeTimers(); const p = presenter(); const viewer = start({ presenter: p });
  try {
    await vi.advanceTimersByTimeAsync(10);
    viewer.reachable(false); viewer.drop();
    await vi.advanceTimersByTimeAsync(4000);
    expect(p.last('state')).toMatchObject({ reachable: false });
    viewer.reachable(true); viewer.heartbeat(); await vi.advanceTimersByTimeAsync(3000);
    expect(p.last('state')).toMatchObject({ reachable: true, steerable: true });
    expect(viewer.subscriptions()).toBe(2);
    expect(p.calls.filter(call => call[0] === 'notice')).toEqual([]);
    expect(viewer.text()).toBe('');
  } finally { await viewer.stop(); }
});

it('an old feed never disconnects a responsive IPC owner', async () => {
  vi.useFakeTimers(); const p = presenter(); const viewer = start({ presenter: p });
  try {
    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(15000);
    expect(p.last('state')).toMatchObject({ reachable: true, steerable: true });
    expect(viewer.subscriptions()).toBe(1);
    expect(p.calls.filter(call => call[0] === 'notice')).toEqual([]);
  } finally { await viewer.stop(); }
});

it('a slow owner keeps the composer open, refuses a stale submit, then recovers', async () => {
  vi.useFakeTimers(); const p = presenter(); const viewer = start({ presenter: p, pingDelayMs: 2500 });
  try {
    await vi.advanceTimersByTimeAsync(3100);
    expect(p.last('state')).toMatchObject({ reachable: false, steerable: false, canCompose: true });
    await expect(p.steer('keep the draft')).resolves.toMatchObject({ accepted: false, delivery: 'refused' });
    expect(viewer.steers).toEqual([]);
    await vi.advanceTimersByTimeAsync(500);
    expect(p.last('state')).toMatchObject({ reachable: true, steerable: true, canCompose: true });
    expect(viewer.subscriptions()).toBe(1);
  } finally { await viewer.stop(); }
});

it('a silent connected owner is unreachable until its own ping replies recover', async () => {
  vi.useFakeTimers(); const p = presenter(); const viewer = start({ presenter: p });
  try {
    await vi.advanceTimersByTimeAsync(10); viewer.reachable(false);
    await vi.advanceTimersByTimeAsync(4000);
    expect(p.last('state')).toMatchObject({ reachable: false, steerable: false });
    viewer.reachable(true); await vi.advanceTimersByTimeAsync(1500);
    expect(p.last('state')).toMatchObject({ reachable: true, steerable: true });
    expect(viewer.subscriptions()).toBe(1);
    expect(p.calls.filter(call => call[0] === 'notice')).toEqual([]);
  } finally { await viewer.stop(); }
});

it('the text viewer is quiet across a reconnect too: no reconnect lines and no repeated status line', async () => {
  vi.useFakeTimers(); const viewer = start();
  try {
    await vi.advanceTimersByTimeAsync(10);
    viewer.reachable(false); viewer.drop(); await vi.advanceTimersByTimeAsync(4000);
    viewer.reachable(true); viewer.heartbeat(); await vi.advanceTimersByTimeAsync(3000);
    expect(viewer.subscriptions()).toBe(2);
    expect(viewer.text()).not.toMatch(/reconnect/);
    expect(viewer.text().match(/\[running · rpc\]/g)).toHaveLength(1);
  } finally { await viewer.stop(); }
});

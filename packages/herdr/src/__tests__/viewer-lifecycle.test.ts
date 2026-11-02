// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { afterEach, expect, test, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { runViewer, type ViewerStreamClient } from '../viewers/program.js';
import type { RunId, RunCursor, RunSummary, SessionFeed } from '../contracts.js';

const runId = '10000000-0000-4000-8000-000000000001' as RunId;
const sessionId = 'viewer-owner' as SessionFeed['sessionId'];
const run: RunSummary = { id: runId, ownerSessionId: sessionId, name: null, status: 'running', childMode: 'rpc', canSteer: true, startedAt: 1, finishedAt: null, result: null, viewer: null };
function feed(generation = 'activation'): SessionFeed {
  return { version: 1, sessionId, generation: generation as SessionFeed['generation'], revision: 1, updatedAt: Date.now(),
    owner: { sessionId, generation, terminal: { coreId: 'core', terminalId: 'owner', address: 'owner', socket: '/fixture/core.sock', sessionNamespace: 'fixture' }, cwd: '/fixture', sessionFile: null, name: null } as SessionFeed['owner'],
    lifecycle: 'live', placement: null, status: { native: 'working', effective: 'working', message: null }, runs: { rows: [run], total: 1, truncated: false }, todos: { rows: [], total: 0, truncated: false }, triggers: [],
    pace: { scope: 'shared', used: null, budget: null, projected: null, remaining: null, periodStart: null, periodEnd: null, updatedAt: null, unavailableReason: 'fixture' },
    approvals: [], notifications: [], errors: [], ipc: { address: '/fixture/ipc.sock', capabilityFile: '/fixture/capability' } };
}
afterEach(() => vi.useRealTimers());

test('a closed viewer stays read-only after its feed is swept, until the user closes it', async () => {
  vi.useFakeTimers(); let value: SessionFeed | null = { ...feed(), lifecycle: 'closed', ipc: null }; let changed = () => {};
  const abort = new AbortController(); const output = new PassThrough(); const input = new PassThrough(); let text = ''; let exited = false;
  output.on('data', bytes => { text += bytes.toString(); });
  const running = runViewer({ runId, sessionId, feedRoot: '/fixture', stdin: input, stdout: output, signal: abort.signal,
    feedSource: { read: async () => value, subscribe: listener => { changed = listener; return () => {}; } },
    createClient: () => { throw new Error('Closed viewers must not connect'); } }).then(() => { exited = true; });
  try {
    await vi.advanceTimersByTimeAsync(1); expect(text).toContain('Saved log is read-only');
    value = null; changed(); await vi.advanceTimersByTimeAsync(90000);
    expect(exited).toBe(false); expect(text).not.toContain('reconnecting');
    input.write('not sent\n'); await vi.advanceTimersByTimeAsync(1); expect(text).toContain('[refused]'); expect(text).toContain('read-only');
  } finally { abort.abort(); await running; }
});

test('a stale-live owner becomes final read-only after thirty seconds of unavailability and never reconnects again', async () => {
  vi.useFakeTimers(); let value = feed(); let changed = () => {}; let attempts = 0; let exited = false;
  const abort = new AbortController(); const output = new PassThrough(); let text = ''; output.on('data', bytes => { text += bytes.toString(); });
  const client: ViewerStreamClient = { subscribeRun: async () => { attempts++; throw new Error('Owner session replaced'); } };
  const running = runViewer({ runId, sessionId, feedRoot: '/fixture', stdin: new PassThrough(), stdout: output, signal: abort.signal,
    feedSource: { read: async () => value, subscribe: listener => { changed = listener; return () => {}; } }, createClient: () => client,
    wait: ms => new Promise(resolve => setTimeout(resolve, ms)) }).then(() => { exited = true; });
  try {
    await vi.advanceTimersByTimeAsync(29000); expect(text).not.toContain('Saved log is read-only');
    await vi.advanceTimersByTimeAsync(2000); expect(text).toContain('Saved log is read-only'); expect(exited).toBe(false);
    const settled = attempts; const replacement = feed('another-owner');
    const otherSession = 'another-session' as SessionFeed['sessionId'];
    value = { ...replacement, sessionId: otherSession, owner: { ...replacement.owner, sessionId: otherSession }, runs: { rows: [], total: 0, truncated: false } };
    changed(); await vi.advanceTimersByTimeAsync(90000);
    expect(attempts).toBe(settled); expect(text.match(/Saved log is read-only/g)).toHaveLength(1); expect(exited).toBe(false);
  } finally { abort.abort(); await running; }
});

test('a healthy reload reattaches by cursor without reconnect or final-state notices', async () => {
  vi.useFakeTimers(); let value = feed(); let changed = () => {}; const seen: (RunCursor | null)[] = [];
  const abort = new AbortController(); const output = new PassThrough(); let text = ''; output.on('data', bytes => { text += bytes.toString(); });
  const client: ViewerStreamClient = { subscribeRun: async (_id, cursor, emit) => {
    seen.push(cursor); emit({ runId, cursor: 'saved-cursor' as RunCursor, kind: 'snapshot', data: { run } });
    return { closed: new Promise(() => {}), dispose() {} };
  } };
  const running = runViewer({ runId, sessionId, feedRoot: '/fixture', stdin: new PassThrough(), stdout: output, signal: abort.signal,
    feedSource: { read: async () => value, subscribe: listener => { changed = listener; return () => {}; } }, createClient: () => client,
    wait: ms => new Promise(resolve => setTimeout(resolve, ms)) });
  try {
    await vi.advanceTimersByTimeAsync(1); value = feed('reloaded'); changed(); await vi.advanceTimersByTimeAsync(1000);
    expect(seen).toEqual([null, 'saved-cursor']); expect(text).not.toContain('reconnecting'); expect(text).not.toContain('read-only');
    for (let i = 0; i < 40; i++) { value = { ...value, revision: value.revision + 1, updatedAt: Date.now() }; changed(); await vi.advanceTimersByTimeAsync(1000); }
    expect(text).not.toContain('read-only'); expect(seen).toHaveLength(2);
  } finally { abort.abort(); await running; }
});

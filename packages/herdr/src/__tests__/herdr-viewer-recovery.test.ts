// SPDX-License-Identifier: MIT
import { expect, it, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { runViewer, type ViewerStreamClient } from '../viewers/program.js';
import type { RunId, RunSummary, SessionFeed } from '../contracts.js';

it('keeps a healthy viewer interactive through two short feed stalls separated by recovery', async () => {
  // Leaving unavailableSince set on recovery makes the second stall final.
  vi.useFakeTimers();
  const runId = '10000000-0000-4000-8000-000000000001' as RunId;
  const sessionId = 'viewer-owner' as SessionFeed['sessionId'];
  const run: RunSummary = { id: runId, ownerSessionId: sessionId, name: null, status: 'running', childMode: 'rpc', canSteer: true, startedAt: 1, finishedAt: null, result: null, viewer: null };
  let feed: SessionFeed = { version: 1, sessionId, generation: 'activation' as SessionFeed['generation'], revision: 1, updatedAt: Date.now(),
    owner: { sessionId, generation: 'activation', terminal: { coreId: 'core', terminalId: 'owner', address: 'owner', socket: '/fixture/core.sock', sessionNamespace: 'fixture' }, cwd: '/fixture', sessionFile: null, name: null } as SessionFeed['owner'],
    lifecycle: 'live', placement: null, status: { native: 'working', effective: 'working', message: null }, runs: { rows: [run], total: 1, truncated: false }, todos: { rows: [], total: 0, truncated: false }, triggers: [],
    pace: { scope: 'shared', used: null, budget: null, projected: null, remaining: null, periodStart: null, periodEnd: null, updatedAt: null, unavailableReason: 'fixture' },
    approvals: [], notifications: [], errors: [], ipc: { address: '/fixture/ipc.sock', capabilityFile: '/fixture/capability' } };
  const input = new PassThrough(), output = new PassThrough(), abort = new AbortController();
  let text = '', changed = () => {}, subscriptions = 0;
  const steers: string[] = [];
  output.on('data', bytes => { text += bytes.toString(); });
  const client: ViewerStreamClient = { subscribeRun: async (_id, _cursor, emit) => {
    subscriptions++; emit({ runId, cursor: 'cursor' as never, kind: 'snapshot', data: { run } });
    return { closed: new Promise(() => {}), dispose() {} };
  } };
  const running = runViewer({ runId, sessionId, feedRoot: '/fixture', stdin: input, stdout: output, signal: abort.signal,
    feedSource: { read: async () => feed, subscribe: listener => { changed = listener; return () => {}; } }, createClient: () => client,
    submitSteer: async (_client, draft) => { steers.push(draft); return { delivery: 'delivered' } as never; } });
  const heartbeat = async () => { feed = { ...feed, updatedAt: Date.now(), revision: feed.revision + 1 }; changed(); await vi.advanceTimersByTimeAsync(1000); };
  try {
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(12000); await heartbeat();
    for (let i = 0; i < 36; i++) { await vi.advanceTimersByTimeAsync(2000); await heartbeat(); }
    await vi.advanceTimersByTimeAsync(12000); await heartbeat();
    input.write('continue the run\n'); await vi.advanceTimersByTimeAsync(1);
    expect(text).not.toContain('Saved log is read-only');
    expect(text.match(/\[reconnected\]/g)).toHaveLength(2);
    expect(steers).toEqual(['continue the run']);
    expect(subscriptions).toBe(3);
  } finally { abort.abort(); await running; vi.useRealTimers(); }
});

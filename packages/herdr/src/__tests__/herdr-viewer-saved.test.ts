// SPDX-License-Identifier: MIT
import { expect, test, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { runViewer } from '../viewers/program.js';
import type { RunId, RunSummary, SessionFeed } from '../contracts.js';

test('a completed saved viewer stops discovery but receives an immediate closed-feed notice', async () => {
  vi.useFakeTimers();
  const sessionId = 'saved-owner' as SessionFeed['sessionId'], runId = '10000000-0000-4000-8000-000000000001' as RunId;
  const run: RunSummary = { id: runId, ownerSessionId: sessionId, name: null, status: 'done', childMode: 'rpc', canSteer: false, startedAt: 1, finishedAt: 2, result: 'saved result', viewer: null };
  let value: SessionFeed = { version: 1, sessionId, generation: 'activation' as SessionFeed['generation'], revision: 1, updatedAt: Date.now(),
    owner: { sessionId, generation: 'activation', terminal: { coreId: 'core', terminalId: 'owner', address: 'owner', socket: '/fixture/core.sock', sessionNamespace: 'fixture' }, cwd: '/fixture', sessionFile: null, name: null } as SessionFeed['owner'],
    lifecycle: 'live', placement: null, status: { native: 'done', effective: 'done', message: null }, runs: { rows: [run], total: 1, truncated: false }, todos: { rows: [], total: 0, truncated: false }, triggers: [],
    pace: { scope: 'shared', used: null, budget: null, projected: null, remaining: null, periodStart: null, periodEnd: null, updatedAt: null, unavailableReason: 'fixture' },
    approvals: [], notifications: [], errors: [], ipc: { address: '/fixture/ipc.sock', capabilityFile: '/fixture/capability' } };
  const abort = new AbortController(), output = new PassThrough(); let text = '', reads = 0, clients = 0, changed = () => {};
  output.on('data', bytes => { text += bytes.toString(); });
  const running = runViewer({ sessionId, runId, feedRoot: '/fixture', stdin: new PassThrough(), stdout: output, signal: abort.signal,
    feedSource: { read: async () => { reads++; return value; }, subscribe: listener => { changed = listener; return () => {}; } },
    createClient: () => { clients++; return { subscribeRun: async (_runId, _cursor, emit) => {
      emit({ runId, cursor: 'saved' as never, kind: 'snapshot', data: { run } });
      emit({ runId, cursor: 'saved' as never, kind: 'end', data: { reason: 'finished' } });
      return { closed: Promise.resolve(), dispose() {} };
    } }; } });
  try {
    await vi.advanceTimersByTimeAsync(1);
    value = { ...value, revision: 2, lifecycle: 'closed', ipc: null }; changed(); await vi.advanceTimersByTimeAsync(1);
    expect(text).toContain('Owning session closed. Saved log is read-only.');
    const afterNotice = reads; await vi.advanceTimersByTimeAsync(60000);
    expect(reads).toBe(afterNotice); expect(clients).toBe(1); expect(text.match(/saved result/g)).toHaveLength(1);
  } finally { abort.abort(); await running; vi.useRealTimers(); }
});

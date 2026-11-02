// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { describe, expect, it } from 'vitest';
import { PassThrough } from 'node:stream';
import { runViewer, type ViewerStreamClient } from '../viewers/program.js';
import type { RunId, RunCursor, RunSummary, RunViewFrame, SessionFeed } from '../contracts.js';

const runId = '10000000-0000-4000-8000-000000000001' as RunId;
const sessionId = 'viewer-owner' as SessionFeed['sessionId'];
function summary(status: RunSummary['status'] = 'running'): RunSummary {
  return { id: runId, ownerSessionId: sessionId, name: null, status, childMode: 'rpc', canSteer: false,
    startedAt: 1, finishedAt: status === 'running' ? null : 2, result: null, viewer: null };
}
function startViewer(feedRun = summary()) {
  let value: SessionFeed = { version: 1, sessionId, generation: 'activation' as SessionFeed['generation'], revision: 1, updatedAt: Date.now(),
    owner: { sessionId, generation: 'activation', terminal: { coreId: 'core', terminalId: 'owner', address: 'owner', socket: '/fixture/core.sock', sessionNamespace: 'fixture' }, cwd: '/fixture', sessionFile: null, name: null } as SessionFeed['owner'],
    lifecycle: 'live', placement: null, status: { native: 'working', effective: 'working', message: null },
    runs: { rows: [feedRun], total: 1, truncated: false }, todos: { rows: [], total: 0, truncated: false }, triggers: [],
    pace: { scope: 'shared', used: null, budget: null, projected: null, remaining: null, periodStart: null, periodEnd: null, updatedAt: null, unavailableReason: 'fixture' },
    approvals: [], notifications: [], errors: [], ipc: { address: '/fixture/ipc.sock', capabilityFile: '/fixture/capability' } };
  const abort = new AbortController(), stdin = new PassThrough(), output = new PassThrough();
  let text = '', changed = () => {}, emit: ((frame: RunViewFrame) => void) | undefined;
  output.on('data', bytes => { text += bytes.toString(); });
  const client: ViewerStreamClient = { subscribeRun: async (_runId, _cursor, listener) => {
    emit = listener; return { closed: new Promise<void>(() => {}), dispose() { emit = undefined; } };
  } };
  const running = runViewer({ sessionId, runId, feedRoot: '/fixture', stdin, stdout: output, signal: abort.signal,
    createClient: () => client, wait: async () => {},
    feedSource: { read: async () => value, subscribe: listener => { changed = listener; return () => {}; } } });
  function push(frame: RunViewFrame) {
    if (!emit) throw new Error('Viewer has not subscribed');
    emit(frame);
  }
  return {
    stdin, text: () => text, running,
    snapshot(run: RunSummary) { push({ runId, cursor: 'snapshot' as RunCursor, kind: 'snapshot', data: { run } }); },
    end() { push({ runId, cursor: 'end' as RunCursor, kind: 'end', data: { reason: 'finished' } }); },
    updateFeed(run: RunSummary) { value = { ...value, revision: value.revision + 1, runs: { rows: [run], total: 1, truncated: false } }; changed(); },
    async stop() { abort.abort(); await running; },
  };
}
async function flush() { await new Promise<void>(resolve => setImmediate(resolve)); }

// Feed-file preference, missing end-frame updates, or duplicate notices break these user-visible assertions.
describe('finished run viewer reasons', () => {
  it.each(['done', 'failed', 'cancelled'] as const)('corrects a stale no-pipe reason once when the stream reports %s', async status => {
    const viewer = startViewer();
    try {
      await flush(); viewer.snapshot(summary());
      expect(viewer.text()).toContain('[steering unavailable] The owning session has no live RPC pipe.');
      viewer.snapshot(summary(status));
      expect(viewer.text()).toContain(`[steering unavailable] This run is ${status}.`);
      viewer.snapshot(summary(status)); viewer.end(); await viewer.running;
      expect(viewer.text().split(`[steering unavailable] This run is ${status}.`)).toHaveLength(2);
    } finally { await viewer.stop(); }
  });

  it('uses the first snapshot when a finished run is reopened before the feed catches up', async () => {
    const viewer = startViewer();
    try {
      await flush(); viewer.snapshot(summary('done'));
      expect(viewer.text()).toContain('[done · rpc]\n[steering unavailable] This run is done.\n');
      expect(viewer.text()).not.toContain('no live RPC pipe');
      viewer.end(); await flush();
      viewer.stdin.write('Change the brief\n'); await flush();
      expect(viewer.text()).toContain('[refused] This run is done.');
      expect(viewer.text().split('[steering unavailable] This run is done.')).toHaveLength(2);
    } finally { await viewer.stop(); }
  });

  it('corrects a stale reason on the finished end frame when the feed learned the terminal status', async () => {
    const viewer = startViewer();
    try {
      await flush(); viewer.snapshot(summary());
      expect(viewer.text()).toContain('The owning session has no live RPC pipe.');
      viewer.updateFeed(summary('failed')); await flush();
      viewer.end(); await viewer.running;
      expect(viewer.text()).toContain('[steering unavailable] This run is failed.');
      expect(viewer.text().split('[steering unavailable] This run is failed.')).toHaveLength(2);
    } finally { await viewer.stop(); }
  });

  it('does not let a running stream snapshot override a non-running feed status', async () => {
    const viewer = startViewer(summary('cancelled'));
    try {
      await flush(); viewer.snapshot({ ...summary(), canSteer: true });
      expect(viewer.text()).toContain('[steering unavailable] This run is cancelled.');
      viewer.snapshot({ ...summary(), canSteer: true });
      expect(viewer.text().split('[steering unavailable] This run is cancelled.')).toHaveLength(2);
    } finally { await viewer.stop(); }
  });
});

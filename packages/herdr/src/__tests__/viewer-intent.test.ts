// SPDX-License-Identifier: MIT
import { afterEach, expect, test, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { runViewer } from '../viewers/program.js';
import { createViewerPorts } from '../../../host/src/herdr/ports.js';
import type { RunCursor, RunId, RunSummary, RunViewFrame, SessionFeed } from '../contracts.js';

const runId = '10000000-0000-4000-8000-000000000001' as RunId;
const sessionId = 'viewer-owner' as SessionFeed['sessionId'];
function summary(status: RunSummary['status']): RunSummary {
  return { id: runId, ownerSessionId: sessionId, name: null, status, childMode: 'rpc', canSteer: false,
    startedAt: 1, finishedAt: ['done', 'failed', 'cancelled'].includes(status) ? 2 : null, result: null, viewer: null };
}
function start(intent: 'automatic' | 'explicit', initialStatus?: RunSummary['status']) {
  const value: SessionFeed = { version: 1, sessionId, generation: 'activation' as SessionFeed['generation'], revision: 1, updatedAt: Date.now(),
    owner: { sessionId, generation: 'activation', terminal: { coreId: 'core', terminalId: 'owner', address: 'owner', socket: '/fixture/core.sock', sessionNamespace: 'fixture' }, cwd: '/fixture', sessionFile: null, name: null } as SessionFeed['owner'],
    lifecycle: 'live', placement: null, status: { native: 'working', effective: 'working', message: null },
    runs: { rows: [], total: 0, truncated: false }, todos: { rows: [], total: 0, truncated: false }, triggers: [],
    pace: { scope: 'shared', used: null, budget: null, projected: null, remaining: null, periodStart: null, periodEnd: null, updatedAt: null, unavailableReason: 'fixture' },
    approvals: [], notifications: [], errors: [], ipc: { address: '/fixture/ipc.sock', capabilityFile: '/fixture/capability' } };
  const abort = new AbortController(), stdin = new PassThrough(), output = new PassThrough();
  let emit!: (frame: RunViewFrame) => void, text = '', exited = false, releases = 0;
  output.on('data', bytes => { text += bytes.toString(); });
  const running = runViewer({ intent, initialStatus, sessionId, runId, feedRoot: '/fixture', stdin, stdout: output, signal: abort.signal,
    wait: ms => new Promise(resolve => setTimeout(resolve, ms)),
    createClient: () => ({ subscribeRun: async (_id, _cursor, listener) => {
      emit = listener; return { closed: new Promise<void>(() => {}), dispose() {} };
    } }),
    feedSource: { read: async () => value, subscribe: () => () => {} },
    release: async () => { releases++; },
  }).then(() => { exited = true; });
  return { stdin, text: () => text, exited: () => exited, releases: () => releases,
    snapshot(status: RunSummary['status']) { emit({ runId, cursor: 'snapshot' as RunCursor, kind: 'snapshot', data: { run: summary(status) } }); },
    tail() { emit({ runId, cursor: 'tail' as RunCursor, kind: 'event', data: { text: 'last unread page\n', events: [] } }); },
    end() { emit({ runId, cursor: 'end' as RunCursor, kind: 'end', data: { reason: 'finished' } }); },
    async stop() { abort.abort(); await running; },
  };
}
afterEach(() => vi.useRealTimers());

// Ignoring launch intent leaves a late automatic viewer alive as a saved view.
test.each(['done', 'failed', 'cancelled'] as const)('a late automatic viewer drains %s output and exits after two seconds', async status => {
  vi.useFakeTimers(); const viewer = start('automatic');
  try {
    await vi.advanceTimersByTimeAsync(1); viewer.snapshot(status);
    await vi.advanceTimersByTimeAsync(2500); expect(viewer.exited()).toBe(false);
    viewer.tail(); viewer.end(); await vi.advanceTimersByTimeAsync(1999);
    expect(viewer.text()).toContain('last unread page\n');
    expect(viewer.text().split(`This run is ${status}.`)).toHaveLength(2);
    expect(viewer.exited()).toBe(false); expect(viewer.releases()).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(viewer.exited()).toBe(true); expect(viewer.releases()).toBe(1);
  } finally { await viewer.stop(); }
});

test.each(['done', 'failed', 'cancelled'] as const)('an explicit open of %s remains a saved read-only view', async status => {
  vi.useFakeTimers(); const viewer = start('explicit');
  try {
    await vi.advanceTimersByTimeAsync(1); viewer.snapshot(status); viewer.tail(); viewer.end();
    await vi.advanceTimersByTimeAsync(5000);
    expect(viewer.exited()).toBe(false); expect(viewer.releases()).toBe(0);
    viewer.stdin.write('Change the brief\n'); await vi.advanceTimersByTimeAsync(1);
    expect(viewer.text()).toContain(`[refused] This run is ${status}.`);
    expect(viewer.text()).toContain('last unread page\n');
  } finally { await viewer.stop(); }
  expect(viewer.exited()).toBe(true); expect(viewer.releases()).toBe(1);
});

for (const intent of ['automatic', 'explicit'] as const) {
  test.each(['queued', 'running', 'paused'] as const)(`${intent} viewer opened while %s exits on completion`, async initial => {
    vi.useFakeTimers(); const viewer = start(intent);
    try {
      await vi.advanceTimersByTimeAsync(1); viewer.snapshot(initial); viewer.snapshot('cancelled'); viewer.end();
      await vi.advanceTimersByTimeAsync(1999); expect(viewer.exited()).toBe(false);
      await vi.advanceTimersByTimeAsync(1); expect(viewer.exited()).toBe(true);
      expect(viewer.text().split('This run is cancelled.')).toHaveLength(2);
    } finally { await viewer.stop(); }
  });
}

test('an explicit running open that attaches late is not turned into a saved view', async () => {
  vi.useFakeTimers(); const viewer = start('explicit', 'running');
  try {
    await vi.advanceTimersByTimeAsync(1); viewer.snapshot('done'); viewer.end();
    await vi.advanceTimersByTimeAsync(2000);
    expect(viewer.exited()).toBe(true); expect(viewer.releases()).toBe(1);
    expect(viewer.text().split('This run is done.')).toHaveLength(2);
  } finally { await viewer.stop(); }
});

const argv = ['--feed-root', '/fixture', '--session', sessionId, '--run', runId];
test.each(['automatic', 'explicit'] as const)('viewer argv carries %s intent without an environment variable', intent => {
  const ports = createViewerPorts([...argv, '--intent', intent], { stdin: new PassThrough(), stdout: new PassThrough() });
  expect(ports?.intent).toBe(intent);
});
test.each(['queued', 'running', 'paused', 'done', 'failed', 'cancelled'] as const)('viewer argv preserves launch-time status %s', status => {
  expect(createViewerPorts([...argv, '--initial-status', status], { stdin: new PassThrough(), stdout: new PassThrough() })?.initialStatus).toBe(status);
});
test('viewer argv rejects an unknown launch-time status', () => {
  expect(() => createViewerPorts([...argv, '--initial-status', 'unknown'], { stdin: new PassThrough(), stdout: new PassThrough() })).toThrow('Invalid viewer arguments');
});
test('direct viewer opens default to explicit saved-view semantics', () => {
  expect(createViewerPorts(argv, { stdin: new PassThrough(), stdout: new PassThrough() })?.intent).toBe('explicit');
});
test.each(['unknown', '', 'AUTOMATIC'])('rejects invalid viewer intent %j', intent => {
  expect(() => createViewerPorts([...argv, '--intent', intent], { stdin: new PassThrough(), stdout: new PassThrough() })).toThrow('Invalid viewer arguments');
});

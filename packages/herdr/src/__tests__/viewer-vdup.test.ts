// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { PassThrough } from 'node:stream';
import { expect, test } from 'vitest';
import { runViewer, type ViewerStreamClient } from '../viewers/program.js';
import type { CoreId, TerminalId, TerminalAddress, RunCursor, RunId, RunViewEvent, RunViewFrame, SessionFeed } from '../contracts.js';

const runId = '10000000-0000-4000-8000-000000000001' as RunId;
const sessionId = 'viewer-owner' as SessionFeed['sessionId'];
const generation = 'viewer-generation' as SessionFeed['generation'];
function feed(): SessionFeed {
  return {
    version: 1, sessionId, generation, revision: 1, updatedAt: Date.now(), lifecycle: 'live', placement: null,
    owner: { sessionId, generation, terminal: { coreId: 'fixture' as CoreId, terminalId: 'owner' as TerminalId, address: 'owner' as TerminalAddress, socket: '/fixture/core.sock', sessionNamespace: 'fixture' }, cwd: '/fixture', sessionFile: null, name: null },
    status: { native: 'working', effective: 'working', message: null },
    runs: { rows: [], total: 0, truncated: false }, todos: { rows: [], total: 0, truncated: false }, triggers: [],
    pace: { scope: 'shared', used: null, budget: null, projected: null, remaining: null, periodStart: null, periodEnd: null, updatedAt: null, unavailableReason: 'fixture' },
    approvals: [], notifications: [], errors: [],
    ipc: { address: '/fixture/ipc.sock', capabilityFile: '/fixture/capability' },
  };
}
function ended(id: number, summary: string, streamed = false): RunViewEvent {
  return { runId, id, type: 'message', summary, messageId: `${runId}:${id}`, streamed };
}
async function render(pages: { text: string; events: RunViewEvent[] }[], replay?: { text: string; events: RunViewEvent[] }[]): Promise<string> {
  const stdout = new PassThrough(), stdin = new PassThrough(); let output = '';
  stdout.on('data', chunk => { output += chunk.toString(); });
  let sequence = 0, subscriptions = 0;
  const client: ViewerStreamClient = {
    async subscribeRun(_id, _cursor, emit) {
      const selected = subscriptions++ === 0 ? pages : replay ?? [];
      const cursor = () => String(++sequence) as RunCursor;
      emit({ runId, cursor: cursor(), kind: 'snapshot', data: { run: {
        id: runId, ownerSessionId: sessionId, name: null, status: 'running', childMode: 'rpc', canSteer: true,
        startedAt: 1, finishedAt: null, viewer: null, result: null,
      } } });
      for (const data of selected) emit({ runId, cursor: cursor(), kind: 'event', data } satisfies RunViewFrame);
      emit({ runId, cursor: cursor(), kind: 'end', data: { reason: replay && subscriptions === 1 ? 'disposed' : 'finished' } });
      return { closed: Promise.resolve(), dispose() {} };
    },
  };
  try {
    await runViewer({ runId, sessionId, feedRoot: '/fixture', stdout, stdin, createClient: () => client,
      feedSource: { read: async () => feed(), subscribe: () => () => {} }, wait: async () => {} });
    return output;
  } finally { stdout.destroy(); stdin.destroy(); }
}

test('a streamed message is not repeated when its completion summary arrives', async () => {
  const output = await render([
    { text: 'SEQ_1_0000_界λ café\n', events: [] },
    { text: 'SEQ_1_0001_界λ café\n', events: [] },
    { text: '', events: [ended(1, 'SEQ_1_0000_界λ café\nSEQ_1_0001_界λ café\n', true)] },
  ]);
  expect(output.match(/SEQ_1_0000_/g)).toHaveLength(1);
  expect(output.match(/SEQ_1_0001_/g)).toHaveLength(1);
});

test('an unstreamed completion is printed once even when the same event is replayed', async () => {
  const message = ended(1, 'UNSTREAMED_MESSAGE');
  const output = await render([{ text: '', events: [message] }, { text: '', events: [message] }]);
  expect(output.match(/UNSTREAMED_MESSAGE/g)).toHaveLength(1);
});

test('reconnect replay does not repeat the completion of an already-shown message', async () => {
  const message = ended(1, 'REPLAYED_MESSAGE', true);
  const output = await render([
    { text: 'REPLAYED_MESSAGE', events: [] }, { text: '', events: [message] },
  ], [{ text: '', events: [{ ...message, streamed: false }] }]);
  expect(output.match(/REPLAYED_MESSAGE/g)).toHaveLength(1);
});

test('interleaved message completions each render their streamed text once', async () => {
  const output = await render([
    { text: 'MESSAGE_ONE_', events: [] }, { text: 'MESSAGE_TWO_', events: [] },
    { text: 'TAIL_ONE', events: [] }, { text: 'TAIL_TWO', events: [] },
    { text: '', events: [ended(2, 'MESSAGE_TWO_TAIL_TWO', true)] }, { text: '', events: [ended(1, 'MESSAGE_ONE_TAIL_ONE', true)] },
  ]);
  expect(output.match(/MESSAGE_ONE/g)).toHaveLength(1);
  expect(output.match(/MESSAGE_TWO/g)).toHaveLength(1);
});

test('a completion never streamed is printed in full', async () => {
  const output = await render([{ text: '', events: [ended(1, 'FULL_MESSAGE\nlast line')] }]);
  expect(output).toContain('[message] FULL_MESSAGE\nlast line\n');
  expect(output.match(/FULL_MESSAGE/g)).toHaveLength(1);
});

test('different messages with identical text each print once', async () => {
  const output = await render([{ text: '', events: [ended(1, 'SAME_TEXT'), ended(2, 'SAME_TEXT')] }]);
  expect(output.match(/SAME_TEXT/g)).toHaveLength(2);
});

test('events without the new fields retain their original output', async () => {
  const message = { runId, id: 1, type: 'message', summary: 'LEGACY_MESSAGE' };
  const output = await render([
    { text: 'LEGACY_MESSAGE', events: [] }, { text: '', events: [message, message,
      { runId, id: 2, type: 'tool_call', tool: 'read' },
      { runId, id: 3, type: 'tool_result', summary: 'result' },
      { runId, id: 4, type: 'log', summary: 'marker' },
    ] },
  ]);
  expect(output).toContain('LEGACY_MESSAGE[message] LEGACY_MESSAGE\n[message] LEGACY_MESSAGE\n[tool_call] read\n[tool_result] result\n[log] marker\n');
});

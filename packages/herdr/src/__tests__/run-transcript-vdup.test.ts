// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { afterEach, expect, test, vi } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { appendRunEvent, openDbAt } from '@spider/db-core';
import { scratchDbPath, cleanupScratch } from '@spider/db-core/testutil';
import { RunStore } from '../../../subagents/src/run-store.js';
import { makeChildReporter } from '../../../subagents/src/child-reporter.js';
import { createRunTranscriptSource } from '../../../host/src/herdr/run-transcript.js';
import { parseRunViewFrame, type Owner, type RunCursor, type RunId, type RunViewFrame, type SessionFeed } from '../contracts.js';
import { runViewer, type ViewerStreamClient } from '../viewers/program.js';

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); vi.useRealTimers(); cleanupScratch(); });
function fixture(pageBytes = 65536) {
  const root = resolve('.spider/scratch/vdup-source', randomUUID());
  const dbPath = scratchDbPath('vdup-source'), db = openDbAt(dbPath, 'worktree'), store = new RunStore(db);
  const owner = { sessionId: 'viewer-owner', generation: 'activation', cwd: root, sessionFile: null, name: null,
    terminal: { coreId: 'fixture', terminalId: 'owner', address: 'owner', socket: '/fixture/core.sock', sessionNamespace: 'fixture' },
  } as Owner;
  const runId = store.create({ sessionId: owner.sessionId, agent: 'worker' }).id as RunId; store.start(runId);
  const file = join(root, 'subagent-sessions', runId, 'child.jsonl'); mkdirSync(join(file, '..'), { recursive: true });
  const source = createRunTranscriptSource({ owner: () => owner,
    resolveDb: () => ({ db: openDbAt(dbPath, 'worktree'), dbPath }), transcriptRoots: () => [root], pageBytes });
  cleanups.push(() => { source.dispose(); db.close(); rmSync(root, { recursive: true, force: true }); });
  const reporter = makeChildReporter(db, { sessionId: owner.sessionId, runId });
  function read(cursor: RunCursor | null = null) {
    const frames: RunViewFrame[] = []; const cancel = source.subscribe(runId, cursor, frame => frames.push(frame)); cancel();
    return { text: frames.map(frame => frame.kind === 'event' ? frame.data.text : '').join(''),
      events: frames.flatMap(frame => frame.kind === 'event' ? frame.data.events : []), cursor: frames.at(-1)!.cursor };
  }
  return { file, source, reporter, read, db, owner, runId, store };
}
function record(text: string, tool?: string, role = 'assistant') {
  return JSON.stringify({ type: 'message', id: randomUUID(), message: { role,
    content: [{ type: 'text', text }, ...(tool ? [{ type: 'toolCall', name: tool }] : [])] } }) + '\n';
}

test('a fully streamed assistant message carries stable completion identity and streamed provenance', () => {
  const f = fixture(); writeFileSync(f.file, record('  Unicode 界λ café\n', 'read'));
  f.reporter.onMessage('Unicode 界λ café');
  const first = f.read(), replay = f.read();
  expect(first.text).toBe('  Unicode 界λ café\n\n[tool] read\n');
  expect(first.events[0]).toMatchObject({ type: 'message', streamed: true, messageId: expect.any(String) });
  expect(replay.events[0].messageId).toBe(first.events[0].messageId);
});

test('an assistant completion without a transcript is marked unstreamed', () => {
  const f = fixture(); f.reporter.onMessage('complete text');
  expect(f.read().events[0]).toMatchObject({ summary: 'complete text', streamed: false, messageId: expect.any(String) });
});

test('message matching uses full prose, not the bounded displayed summary', () => {
  const f = fixture(32); const text = 'SEQ_1_0000_' + '界λ café\n'.repeat(1000);
  writeFileSync(f.file, record(text)); f.reporter.onMessage(text.trim());
  const first = f.read();
  expect(first.events[0]).toMatchObject({ streamed: true, messageId: expect.any(String) });
  let output = first.text, cursor = first.cursor;
  for (let i = 0; i < 500; i++) { const next = f.read(cursor); cursor = next.cursor; output += next.text; if (!next.text) break; }
  expect(output).toBe(text);
});

test('a cursor resumed before completion remembers text already streamed', () => {
  const f = fixture(); writeFileSync(f.file, record('before reload'));
  const before = f.read(); f.reporter.onMessage('before reload');
  const after = f.read(before.cursor);
  expect(after.text).toBe('');
  expect(after.events[0]).toMatchObject({ streamed: true, messageId: expect.any(String) });
});

test('interleaved completions correlate only their own text', () => {
  const f = fixture(); writeFileSync(f.file, record('MESSAGE_ONE') + record('MESSAGE_TWO'));
  f.reporter.onMessage('MESSAGE_TWO'); f.reporter.onMessage('MESSAGE_ONE'); f.reporter.onMessage('NOT_STREAMED');
  const events = f.read().events;
  expect(events.map(event => event.streamed)).toEqual([true, true, false]);
  expect(new Set(events.map(event => event.messageId)).size).toBe(3);
});

test('identical assistant completions have distinct identities and separate streaming provenance', () => {
  const f = fixture(); writeFileSync(f.file, record('same prose'));
  f.reporter.onMessage('same prose'); f.reporter.onMessage('same prose');
  const events = f.read().events;
  expect(events.map(event => event.streamed)).toEqual([true, false]);
  expect(events[0].messageId).not.toBe(events[1].messageId);
});

test('user prose does not mark an assistant completion as streamed', () => {
  const f = fixture(); writeFileSync(f.file, record('same prose', undefined, 'user')); f.reporter.onMessage('same prose');
  expect(f.read().events[0]).toMatchObject({ streamed: false });
});

test('a late transcript does not repeat an unstreamed completion and still prints its tool marker', () => {
  const f = fixture(4); f.reporter.onMessage('completed before file'); const first = f.read();
  writeFileSync(f.file, record('completed before file', 'read'));
  let cursor = first.cursor, text = '';
  for (let i = 0; i < 20; i++) { const next = f.read(cursor); cursor = next.cursor; text += next.text; }
  expect(text).toBe('\n[tool] read\n');
});

test('an unstreamed message larger than the displayed summary arrives in full across cursor pages', () => {
  const f = fixture(64); const full = 'FALLBACK_START_' + '界λ café\n'.repeat(700) + 'FALLBACK_END';
  f.reporter.onMessage(full);
  let text = '', cursor: RunCursor | null = null; const events = [];
  for (let i = 0; i < 250; i++) {
    const next = f.read(cursor); cursor = next.cursor; text += next.text; events.push(...next.events);
    if (events.some(event => event.type === 'message')) break;
  }
  expect(text).toBe(full);
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ type: 'message', streamed: true });
});

test('a transcript arriving during fallback does not duplicate or interrupt the full message', () => {
  const f = fixture(1024); const full = 'FALLBACK_START_' + '界λ café\n'.repeat(700) + 'FALLBACK_END';
  f.reporter.onMessage(full); const first = f.read();
  writeFileSync(f.file, record(full, 'read'));
  let cursor = first.cursor, text = first.text; const events = [...first.events];
  for (let i = 0; i < 40; i++) { const next = f.read(cursor); cursor = next.cursor; text += next.text; events.push(...next.events); }
  expect(text.replace('\n[tool] read\n', '')).toBe(full);
  expect(text.match(/\[tool\] read/g)).toHaveLength(1);
  expect(events.filter(event => event.type === 'message')).toHaveLength(1);
});

test('completed fallback prose is not streamed again when its transcript later commits', async () => {
  vi.useFakeTimers(); const f = fixture(); const first = 'FIRST_' + 'x'.repeat(512 * 1024);
  const second = 'FALLBACK_MESSAGE_' + 'y'.repeat(5000);
  f.reporter.onMessage(first); f.reporter.onMessage(second); const frames: RunViewFrame[] = [];
  const cancel = f.source.subscribe(f.runId, null, frame => frames.push(frame));
  try {
    await vi.advanceTimersByTimeAsync(30);
    writeFileSync(f.file, record(first) + record(second)); f.store.finish(f.runId, { status: 'done' });
    await vi.advanceTimersByTimeAsync(2100);
    expect(frames.at(-1)?.kind).toBe('end');
    const text = frames.map(frame => frame.kind === 'event' ? frame.data.text : '').join('');
    expect(text.split('FALLBACK_MESSAGE_').length - 1).toBe(1);
    expect(text.length).toBe(first.length + second.length);
  } finally { cancel(); }
});

test('fallback does not interleave a later message inside an earlier paged terminal control', async () => {
  vi.useFakeTimers(); const f = fixture();
  const first = 'x'.repeat(40000) + '\x1b]52;c;' + 'z'.repeat(40000) + '\x07';
  const second = 'NEXT_MESSAGE_' + 'y'.repeat(5000);
  writeFileSync(f.file, record(first) + record(second)); f.reporter.onMessage(first); f.reporter.onMessage(second);
  f.store.finish(f.runId, { status: 'done' }); const frames: RunViewFrame[] = [];
  const cancel = f.source.subscribe(f.runId, null, frame => frames.push(frame));
  try {
    await vi.advanceTimersByTimeAsync(30);
    const text = frames.map(frame => frame.kind === 'event' ? frame.data.text : '').join('');
    expect(text.indexOf('NEXT_MESSAGE_')).toBeGreaterThan(text.indexOf('\x07'));
  } finally { cancel(); }
});

test('large Unicode messages render exactly once through source, wire parser and viewer', async () => {
  const f = fixture(32768);
  const unsafe = '\x1b]7501;status=error;msg=SU5KRUNURUQ=\x1b\\\x1b]52;c;Zm9yYmlkZGVu\x07\x1b[H\x1b[2J\x1b[200~PASTE_ATTACK\x1b[201~';
  const first = Array.from({ length: 3000 }, (_, i) => `SEQ_1_${String(i).padStart(4, '0')}_界λ café\n`).join('') + unsafe;
  const second = Array.from({ length: 3000 }, (_, i) => `SEQ_2_${String(i).padStart(4, '0')}_界λ café\n`).join('');
  writeFileSync(f.file, record(first, 'read') + record(second));
  f.reporter.onMessage(first.trim()); f.reporter.onToolStart('read', 'reading');
  f.reporter.onToolEnd('read', 'result'); f.reporter.onMessage(second.trim());
  const stdout = new PassThrough(), stdin = new PassThrough(); let output = '';
  stdout.on('data', chunk => { output += chunk.toString(); });
  const frames: RunViewFrame[] = [], decoded: (RunViewFrame | null)[] = [];
  const client: ViewerStreamClient = {
    async subscribeRun(id, cursor, emit) {
      let close!: () => void; const closed = new Promise<void>(resolve => { close = resolve; });
      const cancel = f.source.subscribe(id, cursor, frame => {
        frames.push(frame); const parsed = parseRunViewFrame(JSON.stringify(frame)); decoded.push(parsed);
        emit(parsed ?? frame); if (frame.kind === 'end') close();
      });
      f.store.finish(f.runId, { status: 'done' });
      return { closed, dispose: cancel };
    },
  };
  const feed: SessionFeed = {
    version: 1, sessionId: f.owner.sessionId, generation: f.owner.generation, revision: 1, updatedAt: Date.now(),
    lifecycle: 'live', placement: null, owner: f.owner,
    status: { native: 'working', effective: 'working', message: null },
    runs: { rows: [], total: 0, truncated: false }, todos: { rows: [], total: 0, truncated: false }, triggers: [],
    pace: { scope: 'shared', used: null, budget: null, projected: null, remaining: null, periodStart: null, periodEnd: null, updatedAt: null, unavailableReason: 'fixture' },
    approvals: [], notifications: [], errors: [], ipc: { address: '/fixture/ipc.sock', capabilityFile: '/fixture/capability' },
  };
  try {
    await runViewer({ runId: f.runId, sessionId: f.owner.sessionId, feedRoot: '/fixture', stdout, stdin,
      createClient: () => client, feedSource: { read: async () => feed, subscribe: () => () => {} }, wait: async () => {} });
    expect(decoded).toEqual(frames);
    expect(frames.every(frame => frame.cursor.length <= 1024)).toBe(true);
    const counts = new Map<string, number>();
    for (const match of output.matchAll(/SEQ_([12])_(\d{4})_/g)) counts.set(match[0], (counts.get(match[0]) ?? 0) + 1);
    for (const n of [1, 2]) for (let i = 0; i < 3000; i++) {
      const marker = `SEQ_${n}_${String(i).padStart(4, '0')}_`; expect(counts.get(marker), marker).toBe(1);
    }
    for (const control of ['\x1b]7501;', '\x1b]52;', '\x1b[200~', '\x1b[201~']) expect(output).not.toContain(control);
    expect(output).toContain('[tool] read\n');
    expect(output).toContain('[tool_intent] reading\n[tool_result] result\n');
    expect(frames.filter(frame => frame.kind === 'event').every(frame => Buffer.byteLength(JSON.stringify(frame.data)) <= 65536)).toBe(true);
  } finally { stdout.destroy(); stdin.destroy(); }
});

test('tool calls, results and markers keep their existing event shape', () => {
  const f = fixture();
  for (const type of ['tool_call', 'tool_result', 'log']) appendRunEvent(f.db, {
    runId: f.runId, sessionId: f.owner.sessionId, ts: 1, type, summary: type, tool: 'read',
  });
  expect(f.read().events.map(({ id: _id, ...event }) => event)).toEqual(
    ['tool_call', 'tool_result', 'log'].map(type => ({ runId: f.runId, type, summary: type, tool: 'read' })));
});

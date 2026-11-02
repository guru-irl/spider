// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { afterEach, expect, test, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDbAt } from '@spider/db-core';
import { scratchDbPath, cleanupScratch } from '@spider/db-core/testutil';
import { RunStore } from '../../../subagents/src/run-store.js';
import { emitToolResult } from '../../../subagents/src/run-events.js';
import { publishLiveRunEvent } from '../../../subagents/src/live-events.js';
import { createRunTranscriptSource } from '../../../host/src/herdr/run-transcript.js';
import type { Owner, RunId, RunViewFrame } from '../contracts.js';

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); vi.useRealTimers(); cleanupScratch(); });
function fixture() {
  const root = resolve('.spider/scratch/hl', randomUUID()); mkdirSync(root, { recursive: true });
  const dbPath = scratchDbPath('viewer-live'); const db = openDbAt(dbPath, 'worktree'); const store = new RunStore(db);
  const owner = { sessionId: 'live-owner', generation: 'activation', cwd: root } as Owner;
  const id = store.create({ sessionId: owner.sessionId, agent: 'worker', model: 'example/model-one', thinking: 'high' }).id as RunId; store.start(id);
  const source = createRunTranscriptSource({ owner: () => owner, pollMs: 50, resolveDb: () => ({ db: openDbAt(dbPath, 'worktree'), dbPath }), transcriptRoots: () => [root], modelContextWindow: model => model === 'example/model-one' ? 200000 : undefined });
  cleanups.push(() => { source.dispose(); db.close(); rmSync(root, { recursive: true, force: true }); });
  return { source, id, store, root, db };
}
const assistant = (text: string) => ({ role: 'assistant', content: [{ type: 'text', text }], timestamp: 5 });

test('a protocol 2 viewer gets a versioned snapshot and live child events', async () => {
  vi.useFakeTimers(); const f = fixture(); const frames: RunViewFrame[] = [];
  f.source.subscribe(f.id, null, frame => frames.push(frame), { view: 2 });
  const snapshot = frames.find(frame => frame.kind === 'snapshot');
  expect(snapshot?.kind === 'snapshot' && snapshot.data.view).toMatchObject({ protocol: 2, sessionFile: null });
  publishLiveRunEvent(f.id, { type: 'message_start', message: assistant('') });
  publishLiveRunEvent(f.id, { type: 'tool_execution_start', toolCallId: 't1', toolName: 'bash', args: { command: 'ls' } });
  publishLiveRunEvent(randomUUID(), { type: 'message_start', message: assistant('another run') });
  await vi.advanceTimersByTimeAsync(200);
  const live = frames.flatMap(frame => frame.kind === 'live' ? [frame.data.event] : []);
  expect(live.map(event => event.type)).toEqual(['message_start', 'tool_execution_start']);
  expect(live[1]).toMatchObject({ toolCallId: 't1', toolName: 'bash', args: { command: 'ls' } });
});

test('the pi snapshot identifies the saved session file, even for a finished run', () => {
  const f = fixture(); const directory = resolve(f.root, 'subagent-sessions', f.id); mkdirSync(directory, { recursive: true });
  const file = resolve(directory, `${f.id}.jsonl`);
  writeFileSync(file, JSON.stringify({ type: 'session', version: 3, id: f.id, cwd: '/work/project' }) + '\n');
  f.store.finish(f.id, { status: 'done' });
  const frames: RunViewFrame[] = [];
  f.source.subscribe(f.id, null, frame => frames.push(frame), { view: 2 });
  expect(frames.find(frame => frame.kind === 'snapshot')).toMatchObject({ data: { view: { protocol: 2, sessionFile: file } } });
  expect(frames.at(-1)).toMatchObject({ kind: 'end', data: { reason: 'finished' } });
});

test('the owner supplies model, thinking and context-window metadata in pi snapshots', () => {
  const f = fixture(); const frames: RunViewFrame[] = [];
  f.source.subscribe(f.id, null, frame => frames.push(frame), { view: 2 });
  expect(frames.find(frame => frame.kind === 'snapshot')).toMatchObject({ data: { view: { model: 'example/model-one', thinking: 'high', contextWindow: 200000 } } });
});

test('a pi viewer without a saved file still receives recorded fallback events', () => {
  const f = fixture(); const frames: RunViewFrame[] = [];
  emitToolResult(f.db, { runId: f.id, sessionId: 'live-owner', tool: 'spider', summary: 'FALLBACK_TOOL_COMPLETE' });
  f.source.subscribe(f.id, null, frame => frames.push(frame), { view: 2 });
  expect(frames.flatMap(frame => frame.kind === 'event' ? frame.data.events : []).some(event => event.summary === 'FALLBACK_TOOL_COMPLETE')).toBe(true);
});

test('streamed updates are coalesced to the latest and stripped of duplicate partials', async () => {
  vi.useFakeTimers(); const f = fixture(); const frames: RunViewFrame[] = [];
  f.source.subscribe(f.id, null, frame => frames.push(frame), { view: 2 });
  for (let n = 1; n <= 50; n++) publishLiveRunEvent(f.id, { type: 'message_update', message: assistant('x'.repeat(n)), assistantMessageEvent: { partial: assistant('x'.repeat(n)) } });
  publishLiveRunEvent(f.id, { type: 'message_end', message: assistant('x'.repeat(50)) });
  await vi.advanceTimersByTimeAsync(500);
  const live = frames.flatMap(frame => frame.kind === 'live' ? [frame.data.event] : []);
  const updates = live.filter(event => event.type === 'message_update');
  expect(updates.length).toBeGreaterThanOrEqual(1); expect(updates.length).toBeLessThan(5);
  expect(updates.every(event => !('assistantMessageEvent' in event))).toBe(true);
  expect(live.at(-1)?.type).toBe('message_end');
  // The last update before the end carries the newest text, never an older one after it.
  expect(JSON.stringify(updates.at(-1))).toContain('x'.repeat(50));
});

test('an older viewer gets neither the view field nor live frames', async () => {
  vi.useFakeTimers(); const f = fixture(); const frames: RunViewFrame[] = [];
  f.source.subscribe(f.id, null, frame => frames.push(frame));
  publishLiveRunEvent(f.id, { type: 'message_start', message: assistant('hidden') });
  await vi.advanceTimersByTimeAsync(200);
  expect(frames.some(frame => frame.kind === 'live')).toBe(false);
  const snapshot = frames.find(frame => frame.kind === 'snapshot');
  expect(snapshot && 'view' in snapshot.data).toBe(false);
});

test('an oversized live event is dropped, and a throwing viewer never reaches the child pipe', async () => {
  vi.useFakeTimers(); const f = fixture(); const frames: RunViewFrame[] = [];
  f.source.subscribe(f.id, null, frame => { if (frame.kind === 'live') throw new Error('viewer bug'); frames.push(frame); }, { view: 2 });
  expect(() => publishLiveRunEvent(f.id, { type: 'message_start', message: assistant('y'.repeat(400 * 1024)) })).not.toThrow();
  expect(() => publishLiveRunEvent(f.id, { type: 'tool_execution_end', toolCallId: 't', result: { content: [] } })).not.toThrow();
  await vi.advanceTimersByTimeAsync(200);
});

test('an incompatible viewer gets the served version but no unsupported live frames', async () => {
  vi.useFakeTimers(); const f = fixture(); const frames: RunViewFrame[] = [];
  f.source.subscribe(f.id, null, frame => frames.push(frame), { view: 3 });
  publishLiveRunEvent(f.id, { type: 'message_start', message: assistant('must not cross versions') });
  await vi.advanceTimersByTimeAsync(200);
  expect(frames.find(frame => frame.kind === 'snapshot')).toMatchObject({ data: { view: { protocol: 2 } } });
  expect(frames.some(frame => frame.kind === 'live')).toBe(false);
});

test('cancelling the subscription stops live delivery', async () => {
  vi.useFakeTimers(); const f = fixture(); const frames: RunViewFrame[] = [];
  const cancel = f.source.subscribe(f.id, null, frame => frames.push(frame), { view: 2 });
  cancel(); publishLiveRunEvent(f.id, { type: 'message_start', message: assistant('late') });
  await vi.advanceTimersByTimeAsync(200);
  expect(frames.some(frame => frame.kind === 'live')).toBe(false);
});

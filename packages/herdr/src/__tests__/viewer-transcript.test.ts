// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { afterEach, expect, test, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendRunEvent, bindSession, openDbAt, openGlobal, paths, resolveProject, setGlobalDbPathForTests } from '@spider/db-core';
import { scratchDbPath, cleanupScratch } from '@spider/db-core/testutil';
import { RunStore } from '../../../subagents/src/run-store.js';
import { makeRunHandler } from '../../../subagents/src/actions/run.js';
import { RunEventTailer } from '../../../subagents/src/event-tailer.js';
import type { ChildSpawnSpec } from '../../../subagents/src/pi-args.js';
import { createRunTranscriptSource } from '../../../host/src/herdr/run-transcript.js';
import { openSessionRunDb } from '../../../host/src/session-run-db.js';
import type { Owner, RunId, RunViewFrame } from '../contracts.js';

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFileSync: vi.fn(actual.execFileSync) };
});
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); vi.useRealTimers(); vi.unstubAllEnvs(); setGlobalDbPathForTests(null); cleanupScratch(); });
function fixture() {
  const root = resolve('.spider/scratch/h', randomUUID()); mkdirSync(root, { recursive: true });
  const dbPath = scratchDbPath('viewer-source'); const db = openDbAt(dbPath, 'worktree'); const store = new RunStore(db);
  const owner = { sessionId: 'transcript-owner', generation: 'activation', cwd: root } as Owner;
  const id = store.create({ sessionId: owner.sessionId, agent: 'worker' }).id as RunId; store.start(id);
  cleanups.push(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, dbPath, db, store, owner, id };
}

test('a subscription owns one run DB handle, closes it at cancellation, and caches its transcript roots', async () => {
  vi.useFakeTimers(); const f = fixture(); const handles: ReturnType<typeof openDbAt>[] = []; let rootResolutions = 0;
  const source = createRunTranscriptSource({ owner: () => f.owner, pollMs: 20,
    resolveDb: () => { const db = openDbAt(f.dbPath, 'worktree'); handles.push(db); return { db, dbPath: f.dbPath }; },
    transcriptRoots: () => { rootResolutions++; return [f.root]; } });
  cleanups.push(() => { source.dispose(); for (const db of handles) if (db.raw.open) db.close(); });
  const frames: RunViewFrame[] = []; const cancel = source.subscribe(f.id, null, frame => frames.push(frame));
  await vi.advanceTimersByTimeAsync(300);
  appendRunEvent(f.db, { runId: f.id, sessionId: f.owner.sessionId, ts: 1, type: 'log', summary: 'still live' });
  expect(frames.flatMap(frame => frame.kind === 'event' ? frame.data.events : []).map(event => event.summary)).toContain('still live');
  expect(handles).toHaveLength(1); expect(rootResolutions).toBe(1);
  cancel(); expect(handles.every(db => !db.raw.open)).toBe(true);
});

test('rejected subscriptions also close the caller-owned run DB', () => {
  const f = fixture(); const borrowed = openDbAt(f.dbPath, 'worktree');
  cleanups.push(() => { if (borrowed.raw.open) borrowed.close(); });
  const source = createRunTranscriptSource({ owner: () => f.owner, resolveDb: () => ({ db: borrowed, dbPath: f.dbPath }), transcriptRoots: () => [f.root] });
  cleanups.push(() => source.dispose());
  expect(() => source.subscribe(randomUUID() as RunId, null, () => {})).toThrow('run-not-owned');
  expect(borrowed.raw.open).toBe(false);
});

test.each(['cwd', 'bound'] as const)('the viewer reads the actual transcript of a %s-dispatched run', async dispatch => {
  const f = fixture(); const ownerRepo = join(f.root, 'owner-repo'); const childRepo = join(f.root, 'child-repo');
  for (const repo of [ownerRepo, childRepo]) { mkdirSync(repo); execFileSync('git', ['init', '-q', repo]); }
  const globalRoot = join(f.root, 'global'); mkdirSync(globalRoot); vi.stubEnv('SPIDER_GLOBAL_ROOT', globalRoot);
  setGlobalDbPathForTests(scratchDbPath('viewer-dispatch')); const global = openGlobal(); cleanups.push(() => global.close());
  f.owner.cwd = ownerRepo;
  if (dispatch === 'bound') bindSession(global, f.owner.sessionId, childRepo);
  const ownerDb = openSessionRunDb(ownerRepo, f.owner.sessionId); cleanups.push(() => ownerDb.db.close());
  const project = resolveProject(dispatch === 'cwd' ? childRepo : ownerRepo, { sessionId: f.owner.sessionId, explicitCwd: dispatch === 'cwd' });
  const tailer = new RunEventTailer(ownerDb.db); cleanups.push(() => tailer.stop());
  let spawned: ChildSpawnSpec | undefined; let complete!: (value: { exitCode: number; result: string }) => void;
  const exited = new Promise<{ exitCode: number; result: string }>(resolve => { complete = resolve; });
  const action = makeRunHandler({ getCoordinators: () => ({ tailer, pipelines: [], children: new Map() }), spawner: spec => {
    spawned = spec; writeFileSync(spec.sessionFile!, JSON.stringify({ type: 'message', message: { content: `text from ${dispatch} child` } }) + '\n');
    return { wait: () => exited, detach() {}, kill() { complete({ exitCode: 1, result: 'cleanup' }); } };
  } });
  const result = await action({ agent: 'worker', task: 'Read the transcript', cwd: dispatch === 'cwd' ? childRepo : undefined },
    { cwd: project.realPath, db: ownerDb.db, globalDb: global, sessionId: f.owner.sessionId, runDbPath: ownerDb.dbPath, childMode: 'print' });
  const id = result.details.run.id as RunId;
  const source = createRunTranscriptSource({ owner: () => f.owner, transcriptRoots: owner => [paths.scratch('project', owner.cwd)] }); cleanups.push(() => source.dispose());
  try {
    const frames: RunViewFrame[] = []; const cancel = source.subscribe(id, null, frame => frames.push(frame)); cancel();
    expect(spawned?.cwd).toBe(childRepo);
    expect(frames.filter(frame => frame.kind === 'event').map(frame => frame.data.text).join('')).toBe(`text from ${dispatch} child`);
  } finally { complete({ exitCode: 0, result: 'cleanup' }); await new Promise<void>(resolve => setImmediate(resolve)); }
});

test('an invalid recorded transcript directory is refused instead of silently reading the fallback', () => {
  const f = fixture(); const directory = join(f.root, 'subagent-sessions', f.id); mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'child.jsonl'), JSON.stringify({ type: 'message', message: { content: 'wrong transcript' } }) + '\n');
  appendRunEvent(f.db, { runId: f.id, sessionId: f.owner.sessionId, ts: 1, type: 'child_transcript', payload: { version: 1, directory: join(f.root, 'subagent-sessions', 'another-run') } });
  const source = createRunTranscriptSource({ owner: () => f.owner, resolveDb: () => ({ db: openDbAt(f.dbPath, 'worktree'), dbPath: f.dbPath }), transcriptRoots: () => [f.root] }); cleanups.push(() => source.dispose());
  const frames: RunViewFrame[] = []; const cancel = source.subscribe(f.id, null, frame => frames.push(frame)); cancel();
  expect(frames.filter(frame => frame.kind === 'event').map(frame => frame.data.text).join('')).toBe('');
  expect(frames.some(frame => frame.kind === 'gap' && frame.data.reason === 'unsafe-transcript-path')).toBe(true);
});

test('repository resolution is cached while live binding changes still end the old subscription', () => {
  const f = fixture(); const repos = ['owner', 'bound', 'replacement'].map(name => { const root = join(f.root, name); mkdirSync(root); execFileSync('git', ['init', '-q', root]); return root; });
  const globalRoot = join(f.root, 'global'); mkdirSync(globalRoot); vi.stubEnv('SPIDER_GLOBAL_ROOT', globalRoot);
  setGlobalDbPathForTests(scratchDbPath('viewer-binding')); const global = openGlobal(); cleanups.push(() => global.close());
  bindSession(global, f.owner.sessionId, repos[1]); f.owner.cwd = repos[0];
  const opened = openSessionRunDb(f.owner.cwd, f.owner.sessionId); cleanups.push(() => opened.db.close());
  const store = new RunStore(opened.db); const id = store.create({ sessionId: f.owner.sessionId, agent: 'worker' }).id as RunId; store.start(id);
  const file = join(paths.scratch('project', repos[1]), 'subagent-sessions', id, 'child.jsonl'); mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, JSON.stringify({ type: 'message', message: { content: 'bound text' } }) + '\n');
  let roots = 0;
  const source = createRunTranscriptSource({ owner: () => f.owner, transcriptRoots: () => { roots++; return [paths.scratch('project', repos[1])]; } }); cleanups.push(() => source.dispose());
  const frames: RunViewFrame[] = []; source.subscribe(id, null, frame => frames.push(frame));
  const gitCalls = () => vi.mocked(execFileSync).mock.calls.filter(([binary]) => binary === 'git').length;
  const resolvedCalls = gitCalls();
  for (let i = 0; i < 4; i++) appendRunEvent(opened.db, { runId: id, sessionId: f.owner.sessionId, ts: i, type: 'log' });
  expect(frames.filter(frame => frame.kind === 'event').map(frame => frame.data.text).join('')).toBe('bound text');
  expect(roots).toBe(1); expect(gitCalls()).toBe(resolvedCalls);
  bindSession(global, f.owner.sessionId, repos[2]); appendRunEvent(opened.db, { runId: id, sessionId: f.owner.sessionId, ts: 9, type: 'log', summary: 'must not leak' });
  expect(frames.some(frame => frame.kind === 'end' && frame.data.reason === 'wrong-generation')).toBe(true);
  expect(frames.flatMap(frame => frame.kind === 'event' ? frame.data.events : []).map(event => event.summary)).not.toContain('must not leak');
});

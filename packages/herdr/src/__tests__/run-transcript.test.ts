// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync, appendFileSync, rmSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { openDbAt, appendRunEvent, openGlobal, bindSession, setGlobalDbPathForTests } from '@spider/db-core';
import { scratchDbPath, cleanupScratch } from '@spider/db-core/testutil';
import { RunStore } from '../../../subagents/src/run-store.js';
import { createRunTranscriptSource, type RunTranscriptSource } from '../../../host/src/herdr/run-transcript.js';
import type { RunViewFrame, RunCursor } from '../contracts.js';
import type { Owner, RunId } from '../contracts.js';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { openSessionRunDb } from '../../../host/src/session-run-db.js';

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); cleanupScratch(); setGlobalDbPathForTests(null); vi.unstubAllEnvs(); });
function fixture(pageBytes = 65536) {
  const root = resolve('.spider/scratch/h', randomUUID()); mkdirSync(root, { recursive: true });
  const dbPath = scratchDbPath('run-transcript'); const db = openDbAt(dbPath, 'worktree'); const store = new RunStore(db);
  const owner = { sessionId: 'owner', generation: 'activation', cwd: root } as Owner;
  const owned = store.create({ sessionId: owner.sessionId, agent: 'worker' }).id as RunId;
  const foreign = store.create({ sessionId: 'foreign', agent: 'worker' }).id as RunId;
  store.start(owned); store.setLaunch(owned, { childMode: 'rpc' });
  const file = join(root, 'subagent-sessions', owned, owned + '.jsonl'); mkdirSync(join(root, 'subagent-sessions', owned), { recursive: true });
  const options = { owner: () => owner, resolveDb: () => ({ db: openDbAt(dbPath, 'worktree'), dbPath }), transcriptRoots: () => [root], pageBytes };
  const source = createRunTranscriptSource(options);
  cleanups.push(() => { source.dispose(); db.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, db, dbPath, store, owner, owned, foreign, file, source, options };
}
function message(text: string) { return JSON.stringify({ type: 'message', id: 'record', message: { role: 'assistant', content: [{ type: 'text', text }] } }) + '\n'; }
function read(source: RunTranscriptSource, id: RunId, cursor: RunCursor | null = null) {
  const frames: RunViewFrame[] = []; const cancel = source.subscribe(id, cursor, frame => frames.push(frame)); cancel();
  return { text: frames.map(frame => frame.kind === 'event' ? frame.data.text : '').join(''),
    events: frames.flatMap(frame => frame.kind === 'event' ? frame.data.events : []), cursor: frames.at(-1)!.cursor, frames };
}
describe('owned host transcript source', () => {
  it('ends an old subscription when the real owning session DB binding changes', () => {
    const root = resolve('.spider/scratch/h', randomUUID()); mkdirSync(root, { recursive: true });
    const repos = ['a', 'b', 'c'].map(name => { const path = join(root, name); mkdirSync(path); execFileSync('git', ['init', '-q', path]); return path; });
    const globalRoot = join(root, 'global'); mkdirSync(globalRoot); vi.stubEnv('SPIDER_GLOBAL_ROOT', globalRoot);
    setGlobalDbPathForTests(scratchDbPath('source-binding-global')); const global = openGlobal(); bindSession(global, 'bound-owner', repos[1]);
    const opened = openSessionRunDb(repos[0], 'bound-owner'); const store = new RunStore(opened.db);
    const runId = store.create({ sessionId: 'bound-owner', agent: 'worker' }).id as RunId; store.start(runId);
    const owner = { sessionId: 'bound-owner', generation: 'activation', cwd: repos[0] } as Owner;
    const source = createRunTranscriptSource({ owner: () => owner, transcriptRoots: () => [root] }); const frames: RunViewFrame[] = [];
    const cancel = source.subscribe(runId, null, frame => frames.push(frame));
    cleanups.push(() => { cancel(); source.dispose(); opened.db.close(); global.close(); rmSync(root, { recursive: true, force: true }); });
    bindSession(global, 'bound-owner', repos[2]);
    appendRunEvent(opened.db, { runId, sessionId: 'bound-owner', ts: 1, type: 'log', summary: 'old binding record' });
    expect(frames.some(frame => frame.kind === 'end' && frame.data.reason === 'wrong-generation')).toBe(true);
    expect(frames.flatMap(frame => frame.kind === 'event' ? frame.data.events : []).map(event => event.summary)).not.toContain('old binding record');
  });
  it('pages a complete record larger than one MiB without stalling or losing its UTF-8 tail', () => {
    const h = fixture(); const text = 'x'.repeat(1024 * 1024 + 123) + ' 漢字\n'; writeFileSync(h.file, message(text));
    let cursor: RunCursor | null = null; let output = '';
    for (let i = 0; i < 30; i++) { const page = read(h.source, h.owned, cursor); cursor = page.cursor; if (!page.text) break; output += page.text; }
    expect(output).toHaveLength(text.length); expect(Buffer.from(output).equals(Buffer.from(text))).toBe(true);
  });
  it('bounds raw record scans and reports a truthful oversized-record gap', () => {
    const h = fixture(); writeFileSync(h.file, message('x'.repeat(128 * 1024))); h.store.finish(h.owned, { status: 'done' });
    const limited = createRunTranscriptSource({ ...h.options, recordBytes: 65536 }); cleanups.push(() => limited.dispose());
    const page = read(limited, h.owned); expect(page.text).toHaveLength(0); expect(page.frames).toContainEqual(expect.objectContaining({ kind: 'gap', data: { reason: 'transcript-record-too-large' } })); expect(page.frames.at(-1)?.kind).toBe('end');
  });
  it('drains a completed backlog without waiting for the next live-file poll', async () => {
    vi.useFakeTimers(); const h = fixture(); writeFileSync(h.file, message('x'.repeat(128 * 1024))); h.store.finish(h.owned, { status: 'done' });
    const frames: RunViewFrame[] = []; const cancel = h.source.subscribe(h.owned, null, frame => frames.push(frame));
    try { await vi.advanceTimersByTimeAsync(10); expect(frames.at(-1)?.kind).toBe('end'); expect(frames.filter(frame => frame.kind === 'event').map(frame => frame.data.text).join('')).toHaveLength(128 * 1024); }
    finally { cancel(); vi.useRealTimers(); }
  });
  it('advances the gap cursor past an invalid record instead of repeating the same gap on reconnect', () => {
    const h = fixture(); writeFileSync(h.file, 'invalid JSON\n'); const first = read(h.source, h.owned); expect(first.frames.some(frame => frame.kind === 'gap')).toBe(true);
    const resumed = read(h.source, h.owned, first.cursor); expect(resumed.frames.some(frame => frame.kind === 'gap')).toBe(false);
  });
  it('reports malformed UTF-8 as a gap without substituting successful text', () => {
    const h = fixture(); const raw = Buffer.from(message('漢')); const at = raw.indexOf(Buffer.from('漢'));
    writeFileSync(h.file, Buffer.concat([raw.subarray(0, at), raw.subarray(at, at + 1), raw.subarray(at + 3)]));
    const page = read(h.source, h.owned); expect(page.text).toBe(''); expect(page.frames.some(frame => frame.kind === 'gap')).toBe(true);
  });
  it('marks a terminal partial record as a gap and drains the subscription', () => {
    const h = fixture(); writeFileSync(h.file, message('partial').slice(0, -3)); h.store.finish(h.owned, { status: 'failed' });
    const page = read(h.source, h.owned); expect(page.text).toBe(''); expect(page.frames.some(frame => frame.kind === 'gap')).toBe(true); expect(page.frames.at(-1)?.kind).toBe('end');
  });
  it('preserves a partial multibyte record until its LF is appended and pages large UTF-8 text intact', () => {
    const h = fixture(4); const raw = Buffer.from(message('漢字\n')); const split = raw.indexOf(Buffer.from('漢')) + 1;
    writeFileSync(h.file, raw.subarray(0, split)); const initial = read(h.source, h.owned); expect(initial.text).toBe('');
    appendFileSync(h.file, raw.subarray(split)); let cursor = initial.cursor; let text = '';
    for (let i = 0; i < 3; i++) { const page = read(h.source, h.owned, cursor); cursor = page.cursor; text += page.text; }
    expect(text).toBe('漢字\n'); expect(text).not.toContain('\ufffd');
    appendFileSync(h.file, message('end\n')); expect(read(h.source, h.owned, cursor).text).toBe('end\n');
  });
  it('never emits cancelled callbacks or rolled-back records', () => {
    const h = fixture(); const frames: RunViewFrame[] = []; const cancel = h.source.subscribe(h.owned, null, frame => frames.push(frame)); const count = frames.length;
    expect(() => h.db.transaction(() => { appendRunEvent(h.db, { runId: h.owned, sessionId: h.owner.sessionId, ts: 1, type: 'log', summary: 'rolled back' }); throw new Error('rollback'); })()).toThrow('rollback');
    expect(frames).toHaveLength(count); cancel();
    appendRunEvent(h.db, { runId: h.owned, sessionId: h.owner.sessionId, ts: 2, type: 'log', summary: 'after cancel' }); expect(frames).toHaveLength(count);
    expect(read(h.source, h.owned).events.map(event => event.summary)).toEqual(['after cancel']);
  });
  it('rejects foreign full IDs and never follows a symlink to another child conversation', () => {
    const h = fixture(); const foreign = join(h.root, 'foreign.jsonl'); writeFileSync(foreign, message('foreign secret'));
    symlinkSync(foreign, h.file); const page = read(h.source, h.owned); expect(page.text).toBe(''); expect(page.frames.some(frame => frame.kind === 'gap')).toBe(true);
    expect(() => read(h.source, h.foreign)).toThrowError(expect.objectContaining({ code: 'run-not-owned' }));
    expect(() => read(h.source, h.owned.slice(0, 8) as RunId)).toThrowError(expect.objectContaining({ code: 'run-not-owned' }));
  });
  it('ends old owner-generation callbacks before any new committed text can leak', () => {
    const h = fixture(); writeFileSync(h.file, message('owned\n')); const frames: RunViewFrame[] = [];
    const cancel = h.source.subscribe(h.owned, null, frame => frames.push(frame)); cleanups.push(cancel);
    h.owner.generation = 'new-owner-generation' as Owner['generation'];
    appendFileSync(h.file, message('new generation data\n')); appendRunEvent(h.db, { runId: h.owned, sessionId: h.owner.sessionId, ts: 1, type: 'status' });
    expect(frames.some(frame => frame.kind === 'end')).toBe(true);
    expect(frames.filter(frame => frame.kind === 'event').map(frame => frame.data.text).join('')).toBe('owned\n');
  });
  it('resumes the same session cursor across a newer activation without losing reload-gap records', () => {
    const h = fixture(); writeFileSync(h.file, message('first\n')); const first = read(h.source, h.owned);
    h.owner.generation = 'new-activation' as Owner['generation']; appendFileSync(h.file, message('second\n'));
    appendRunEvent(h.db, { runId: h.owned, sessionId: h.owner.sessionId, ts: 3, type: 'completion' });
    const reloaded = createRunTranscriptSource(h.options); cleanups.push(() => reloaded.dispose());
    const next = read(reloaded, h.owned, first.cursor);
    expect(next.text).toBe('second\n'); expect(next.events.map(event => event.type)).toEqual(['completion']);
  });
  it.each(['missing', 'unsafe'] as const)('reports a persistent %s transcript gap only once until recovery', boundary => {
    const h = fixture();
    if (boundary === 'unsafe') { const target = join(h.root, 'outside.jsonl'); writeFileSync(target, message('must not read')); symlinkSync(target, h.file); }
    const frames: RunViewFrame[] = []; const cancel = h.source.subscribe(h.owned, null, frame => frames.push(frame)); cleanups.push(cancel);
    for (let i = 0; i < 3; i++) appendRunEvent(h.db, { runId: h.owned, sessionId: h.owner.sessionId, ts: i, type: 'status' });
    const reason = boundary === 'missing' ? 'transcript-missing' : 'unsafe-transcript-path';
    expect(frames.filter(frame => frame.kind === 'gap' && frame.data.reason === reason)).toHaveLength(1);
    if (boundary === 'unsafe') rmSync(h.file);
    writeFileSync(h.file, message('recovered transcript\n'));
    appendRunEvent(h.db, { runId: h.owned, sessionId: h.owner.sessionId, ts: 4, type: 'status' });
    expect(frames.filter(frame => frame.kind === 'event').map(frame => frame.data.text).join('')).toBe('recovered transcript\n');
  });
  it('marks missing running transcripts as a gap instead of an empty successful read', () => {
    const h = fixture();
    expect(read(h.source, h.owned).frames.some(frame => frame.kind === 'gap')).toBe(true);
  });
  it('invalidates an in-place rotated transcript even while a large record is partly paged', () => {
    const h = fixture(6); writeFileSync(h.file, message('first\nsecond 漢字\n'));
    const first = read(h.source, h.owned); writeFileSync(h.file, message('replacement record\n'));
    const next = read(h.source, h.owned, first.cursor);
    expect(next.frames.some(frame => frame.kind === 'gap')).toBe(true);
    expect(next.text).toBe('');
  });
  it('drains every committed event before the terminal end frame', () => {
    const h = fixture();
    for (let i = 0; i < 300; i++) appendRunEvent(h.db, { runId: h.owned, sessionId: h.owner.sessionId, ts: i, type: 'log', summary: `record ${i}` });
    h.store.finish(h.owned, { status: 'done' });
    let cursor: RunCursor | null = null; const events: number[] = [];
    for (let i = 0; i < 10; i++) {
      const page = read(h.source, h.owned, cursor); cursor = page.cursor; events.push(...page.events.map(event => event.id!));
      if (page.frames.some(frame => frame.kind === 'end')) break;
    }
    expect(events).toHaveLength(300); expect(new Set(events).size).toBe(300);
  });
  it('keeps encoded transcript pages within 64 KiB even for escape-heavy text', () => {
    const h = fixture(); writeFileSync(h.file, message('\u0000'.repeat(65536)));
    const page = read(h.source, h.owned);
    expect(page.frames.filter(frame => frame.kind === 'event').every(frame => Buffer.byteLength(JSON.stringify(frame.data)) <= 65536)).toBe(true);
    expect(page.frames.every(frame => Buffer.byteLength(JSON.stringify(frame)) <= 256 * 1024)).toBe(true);
  });
  it('cursor reconnect reads real owned records without replay or foreign data', () => {
    const h = fixture(6);
    writeFileSync(h.file, JSON.stringify({ type: 'session', id: h.owned, cwd: h.root }) + '\n' + message('first\nsecond 漢字\n'));
    const first = read(h.source, h.owned); h.options.pageBytes = 65536;
    appendRunEvent(h.db, { runId: h.owned, sessionId: h.owner.sessionId, ts: 2, type: 'completion' });
    const next = read(h.source, h.owned, first.cursor);
    expect(first.text + next.text).toBe('first\nsecond 漢字\n');
    expect(next.events.map(event => event.runId)).toEqual([h.owned]);
    expect(() => read(h.source, h.foreign)).toThrowError(expect.objectContaining({ code: 'run-not-owned' }));
  });
});

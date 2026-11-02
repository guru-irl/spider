// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
// The Herdr panel approves and rejects memories through spider's CLI, with no pi
// session. These tests drive the same staging functions against fixture DBs only.
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { setGlobalDbPathForTests, openGlobal, openRepo, resolveProject } from '@spider/db-core';
import { stageWrite, getMemory, addMemory } from '@spider/memory';
import { createMemoryReviewDbs, listMemoryReview, decideMemoryReview } from '../herdr/memory-review.js';

const scratch = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '.spider', 'scratch', `hmr-${process.pid}`);
let repoKey: string;
beforeEach(() => {
  rmSync(scratch, { recursive: true, force: true });
  const repo = join(scratch, 'alpha');
  mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: repo });
  setGlobalDbPathForTests(join(scratch, 'global.db'));
  repoKey = resolveProject(repo).repoKey!;
});
afterEach(() => { setGlobalDbPathForTests(null); rmSync(scratch, { recursive: true, force: true }); });

const stage = (scope: 'global' | 'repo', content: string): string => {
  const db = scope === 'global' ? openGlobal() : openRepo(repoKey);
  try { return stageWrite(db, scope, { category: 'insight', content, justification: 'fixture' }, { autoStage: true }).uuid!; }
  finally { db.close(); }
};
const status = (scope: 'global' | 'repo', uuid: string) => {
  const db = scope === 'global' ? openGlobal() : openRepo(repoKey);
  try { return getMemory(db, scope, uuid)?.status; } finally { db.close(); }
};

describe('memory review without pi', () => {
  test('lists pending global and repo memories with their full text', () => {
    const long = 'Use the fixture checkout for every review test. '.repeat(8).trim();
    const g = stage('global', long), r = stage('repo', 'Repo convention for the alpha fixture.');
    const reply = listMemoryReview(createMemoryReviewDbs(), [repoKey]);
    expect(reply.ok).toBe(true);
    expect(reply.items.map(item => [item.scope, item.repoKey, item.uuid, item.content])).toEqual([
      ['global', null, g, long], ['repo', repoKey, r, 'Repo convention for the alpha fixture.']]);
    expect(reply.items[0]!.content.length).toBeGreaterThan(180);
  });
  test('approve activates a staged memory; reject retires it', () => {
    const a = stage('global', 'Approve me.'), b = stage('repo', 'Reject me.');
    const dbs = createMemoryReviewDbs();
    expect(decideMemoryReview(dbs, 'approve', { scope: 'global', repoKey: null, uuid: a })).toEqual({ ok: true, op: 'approve', uuid: a });
    expect(decideMemoryReview(dbs, 'reject', { scope: 'repo', repoKey, uuid: b })).toEqual({ ok: true, op: 'reject', uuid: b });
    expect([status('global', a), status('repo', b)]).toEqual(['active', 'rejected']);
    expect(listMemoryReview(dbs, [repoKey]).items).toEqual([]);
  });
  test('refuses a memory that is not waiting for review, and never retires an active one', () => {
    const db = openGlobal();
    let active: string;
    try { active = addMemory(db, 'global', { category: 'insight', content: 'Already active.', status: 'active' }).uuid; } finally { db.close(); }
    const dbs = createMemoryReviewDbs();
    expect(decideMemoryReview(dbs, 'reject', { scope: 'global', repoKey: null, uuid: active })).toMatchObject({ ok: false, code: 'not-pending' });
    expect(decideMemoryReview(dbs, 'approve', { scope: 'global', repoKey: null, uuid: 'missing' })).toMatchObject({ ok: false, code: 'not-pending' });
    expect(status('global', active)).toBe('active');
  });
  test('only opens repo databases spider has registered', () => {
    const stray = join(scratch, 'stray', '.git');
    const dbs = createMemoryReviewDbs();
    expect(decideMemoryReview(dbs, 'approve', { scope: 'repo', repoKey: stray, uuid: 'x' })).toMatchObject({ ok: false, code: 'unknown-repo' });
    expect(listMemoryReview(dbs, [stray])).toMatchObject({ ok: true, items: [], unavailable: [stray] });
    expect(existsSync(join(stray, 'spider'))).toBe(false);
  });
  test('a full memory store explains the fix instead of approving', () => {
    const big = stage('global', 'x'.repeat(4000));
    const db = openGlobal();
    try { addMemory(db, 'global', { category: 'insight', content: 'y'.repeat(7000), status: 'active' }); } finally { db.close(); }
    expect(decideMemoryReview(createMemoryReviewDbs(), 'approve', { scope: 'global', repoKey: null, uuid: big })).toMatchObject({ ok: false, code: 'memory-full' });
    expect(status('global', big)).toBe('staged');
  });
});

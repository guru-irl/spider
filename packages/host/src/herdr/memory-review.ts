// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
// Memory review for the Herdr panel, with no pi session: the same staging
// functions as `spider control memory sub=approve|reject`, behind the CLI.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { openGlobal, openRepo, openRepoReadOnly, type Db } from '@spider/db-core';
import { approvePending, getMemory, listPending, rejectPending, MemoryOverflowError, type MemoryScope } from '@spider/memory';

export interface MemoryReviewDbs {
  openGlobal(): Db;
  /** A registered repo's DB for reading, or null when spider does not know the repo or it has no DB. */
  readRepo(repoKey: string): Db | null;
  /** A registered repo's DB for a decision, or null when spider does not know the repo or it has no DB. */
  writeRepo(repoKey: string): Db | null;
}
export interface MemoryReviewItem { scope: MemoryScope; repoKey: string | null; uuid: string; category: string; content: string; createdAt: number }
export type MemoryReviewTarget = { scope: 'global'; repoKey: null; uuid: string } | { scope: 'repo'; repoKey: string; uuid: string };
export type MemoryReviewFailure = { ok: false; code: 'unknown-repo' | 'not-pending' | 'memory-full' | 'unavailable'; message: string };
export type MemoryReviewDecision = { ok: true; op: 'approve' | 'reject'; uuid: string } | MemoryReviewFailure;

/** Repo keys come from the panel; only repos spider registered may be opened. */
function registeredRepo(repoKey: string): boolean {
  const global = openGlobal();
  try { return Boolean(global.withRetry(() => global.prepare('SELECT 1 FROM projects WHERE repo_key = ? LIMIT 1').get(repoKey))); }
  finally { global.close(); }
}
export function createMemoryReviewDbs(): MemoryReviewDbs {
  const known = (repoKey: string) => registeredRepo(repoKey) && existsSync(join(repoKey, 'spider', 'repo.db'));
  return {
    openGlobal,
    readRepo: repoKey => known(repoKey) ? openRepoReadOnly(repoKey) ?? null : null,
    writeRepo: repoKey => known(repoKey) ? openRepo(repoKey) : null,
  };
}

const item = (scope: MemoryScope, repoKey: string | null) => (record: ReturnType<typeof listPending>[number]): MemoryReviewItem =>
  ({ scope, repoKey, uuid: record.uuid, category: record.category, content: record.content, createdAt: record.createdAt });

/** Pending memories in the global DB and each requested repo, oldest first, with their full text. */
export function listMemoryReview(dbs: MemoryReviewDbs, repoKeys: readonly string[]): { ok: true; op: 'pending'; items: MemoryReviewItem[]; unavailable: string[] } {
  const items: MemoryReviewItem[] = [], unavailable: string[] = [];
  const global = dbs.openGlobal();
  try { items.push(...global.withRetry(() => listPending(global, 'global')).map(item('global', null)).reverse()); }
  finally { global.close(); }
  for (const repoKey of [...new Set(repoKeys)]) {
    const db = dbs.readRepo(repoKey);
    if (!db) { unavailable.push(repoKey); continue; }
    try { items.push(...db.withRetry(() => listPending(db, 'repo')).map(item('repo', repoKey)).reverse()); }
    finally { db.close(); }
  }
  return { ok: true, op: 'pending', items, unavailable };
}

/** Approve or reject one staged memory; anything not waiting for review is left alone. */
export function decideMemoryReview(dbs: MemoryReviewDbs, op: 'approve' | 'reject', target: MemoryReviewTarget): MemoryReviewDecision {
  const db = target.scope === 'global' ? dbs.openGlobal() : dbs.writeRepo(target.repoKey);
  if (!db) return { ok: false, code: 'unknown-repo', message: "Spider doesn't know this memory's repo." };
  try {
    return db.withRetry((): MemoryReviewDecision => {
      // rejectPending retires any row; check it is still staged first.
      if (getMemory(db, target.scope, target.uuid)?.status !== 'staged')
        return { ok: false, code: 'not-pending', message: 'This memory is no longer waiting for review.' };
      if (op === 'approve') {
        if (!approvePending(db, target.scope, target.uuid)) return { ok: false, code: 'not-pending', message: 'This memory is no longer waiting for review.' };
      } else rejectPending(db, target.scope, target.uuid);
      return { ok: true, op, uuid: target.uuid };
    });
  } catch (error) {
    if (error instanceof MemoryOverflowError) return { ok: false, code: 'memory-full', message: 'Memory is full. In pi, forget an entry with spider control memory, then approve again.' };
    throw error;
  } finally { db.close(); }
}

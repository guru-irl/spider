import { afterEach, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { bus, openGlobal, openRepo, resolveProject, setGlobalDbPathForTests } from '@spider/db-core';
import { createHerdrDataSource } from '../../../host/src/herdr/data-source.js';
import { openSessionRunDb } from '../../../host/src/session-run-db.js';
import type { Owner } from '../contracts.js';

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFileSync: vi.fn(actual.execFileSync) };
});
let root: string | undefined;
afterEach(async () => { setGlobalDbPathForTests(null); if (root) await rm(root, { recursive: true, force: true }); vi.clearAllMocks(); });
it('takes twenty git-backed feed snapshots without repeating discovery spawns', async () => {
  const base = resolve('.spider/scratch'); await mkdir(base, { recursive: true }); root = await mkdtemp(join(base, 'feed-resolution-'));
  execFileSync('git', ['init', '-q', root]); setGlobalDbPathForTests(join(root, 'global.db'));
  const owner: Owner = { cwd: root, sessionId: 'snapshot-session' as Owner['sessionId'], generation: 'snapshot-generation' as Owner['generation'], sessionFile: null, name: null,
    terminal: { coreId: 'fixture' as Owner['terminal']['coreId'], terminalId: 't1' as Owner['terminal']['terminalId'], address: 't1' as Owner['terminal']['address'], socket: join(root, 'core.sock'), sessionNamespace: 'fixture' } };
  let now = Date.now();
  const source = createHerdrDataSource({ resolveRunDb: o => openSessionRunDb(o.cwd, o.sessionId),
    openApprovalDbs: o => { const project = resolveProject(o.cwd); return { global: openGlobal(), repo: project.repoKey ? { db: openRepo(project.repoKey), repoKey: project.repoKey } : null }; },
    runEvents: bus, scheduler: { listTriggers: () => [], subscribe: () => () => {} },
    readUsage: async () => ({ snapshots: [], budget: undefined, correctedMonth: null, correctedWindow: null, updatedAt: null }),
    readConfig: () => ({ limits: { auxiliaryPanes: 2, completedRows: 50, completedHours: 24 } }), clock: () => now,
  });
  try {
    const first = await source.snapshot(owner); const initial = vi.mocked(execFileSync).mock.calls.length;
    for (let i = 0; i < 20; i++) {
      now += 2000;
      const feed = await source.snapshot(owner);
      expect(feed.runs).toEqual({ rows: [], total: 0, truncated: false });
      expect(feed.errors).toEqual([]);
      expect(feed.revision).toBe(first.revision + i + 1);
    }
    expect(vi.mocked(execFileSync).mock.calls.length).toBe(initial);
  } finally { source.dispose(); }
});

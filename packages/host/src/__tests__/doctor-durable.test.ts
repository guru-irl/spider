// SPDX-License-Identifier: MIT
import { afterEach, expect, test } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { appendRunEvent, openDbAt, resolveProject, setGlobalDbPathForTests } from '@spider/db-core';
import { RunStore } from '@spider/subagents';
import { controlDoctor } from '../control';

const root = join(process.cwd(), '.spider/scratch', `doctor-durable-${process.pid}`);
afterEach(() => { setGlobalDbPathForTests(null); rmSync(root, { recursive: true, force: true }); });

// Break caught: an orphaned supervised run was invisible in spider doctor.
test('doctor identifies a running row whose supervisor state is missing', () => {
  mkdirSync(root, { recursive: true }); execFileSync('git', ['init', '-q', root]);
  setGlobalDbPathForTests(join(root, 'global.db'));
  const project = resolveProject(root), db = openDbAt(project.dbPath, 'project');
  let id: string;
  try {
    const store = new RunStore(db); id = store.create({ sessionId: 'planner', agent: 'worker', task: 'keep running' }).id; store.start(id);
    appendRunEvent(db, { runId: id, sessionId: 'planner', ts: Date.now(), type: 'child_supervisor', payload: { version: 1, directory: join(root, 'missing-supervisor') } });
  } finally { db.close(); }
  const report = controlDoctor(root, 'planner');
  expect(report.ok).toBe(false);
  expect(report.lines.join('\n')).toContain(`subagent ${id!}: ORPHANED`);
  expect(report.lines.join('\n')).toContain('supervisor=unreadable child=unknown');
});

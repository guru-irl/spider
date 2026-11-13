import { afterEach, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import * as fs from 'node:fs';
import { openDbAt } from '@spider/db-core';
import { join, resolve } from 'node:path';
import * as subagents from '../index';
import { buildChildSpawnSpec } from '../pi-args';
vi.mock('node:fs', async original => ({ ...await original<typeof import('node:fs')>() }));
const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const scratch = resolve('.spider/scratch/rpc-intercom'); mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, 'case-')); roots.push(root);
  const agent = join(root, 'agent'); mkdirSync(agent); mkdirSync(join(root, '.pi'));
  vi.stubEnv('PI_CODING_AGENT_DIR', agent);
  return { root, agent };
}
it.each(['user', 'project', 'both'])('ignores %s legacy package declarations for bundled RPC children', scope => {
  const f = fixture();
  for (const [name, file] of [['user', join(f.agent, 'settings.json')], ['project', join(f.root, '.pi/settings.json')]])
    if (scope === name || scope === 'both') writeFileSync(file, '{ invalid settings must not be read');
  const reads = vi.spyOn(fs, 'readFileSync');
  const spec = buildChildSpawnSpec({ runId: 'run-unique', sessionId: 'parent', agent: 'worker', task: 'trivial', context: 'fresh', parentSessionId: 'parent', childIndex: 0,
    scratchRoot: f.root, cwd: f.root, dbPath: join(f.root, 'db'), childExtensionPath: 'spider.ts' });
  expect(spec.argv.filter(arg => arg === '--extension')).toHaveLength(1);
  expect(spec.argv).toContain('--no-extensions');
  expect(spec.env.PI_INTERCOM_STABLE_ID).toBe('spider-run-unique');
  expect(reads.mock.calls.filter(([file]) => String(file).endsWith('settings.json'))).toEqual([]);
}, 5000);
it('does not read or create settings when dispatching with a replaced Runner', async () => {
  const f = fixture(), unusedAgentDir = join(f.root, 'unused-agent-dir'); vi.stubEnv('PI_CODING_AGENT_DIR', unusedAgentDir);
  const db = openDbAt(join(f.root, 'runs.db'), 'worktree');
  try {
    const handler = subagents.makeRunHandler({ makeRunner: () => ({ runAsync: () => ({ id: 'fake', agent: 'worker', name: 'fake', status: 'running' }) }) });
    await handler({ agent: 'worker', task: 'work' }, { db, sessionId: 'owner', cwd: f.root, runDbPath: join(f.root, 'runs.db') });
    expect(existsSync(unusedAgentDir)).toBe(false);
  } finally { subagents.teardownAll(); db.close(); }
}, 5000);
it('loads bundled intercom and overrides inherited stable identity', () => {
  const f = fixture(); vi.stubEnv('PI_INTERCOM_STABLE_ID', 'parent-stable'); vi.stubEnv('PI_INTERCOM_SESSION_ID', 'parent-broker-id');
  const spec = buildChildSpawnSpec({ runId: 'run-unique', sessionId: 'parent', agent: 'worker', task: 'trivial', context: 'fresh', parentSessionId: 'parent', childIndex: 0,
    scratchRoot: f.root, dbPath: join(f.root, 'db'), childExtensionPath: 'spider.ts', orchestratorTarget: 'parent-broker-id' });
  expect(spec.argv.filter(arg => arg === '--extension')).toHaveLength(1);
  expect(spec.env.PI_INTERCOM_STABLE_ID).toBe('spider-run-unique');
  expect(spec.env.PI_SUBAGENT_ORCHESTRATOR_SESSION_ID).toBe('parent-broker-id');
  expect(spec.env.PI_SUBAGENT_SUPERVISOR_CHANNEL_DIR).toBe('');
}, 5000);

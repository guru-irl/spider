// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { afterEach, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { appendEvent, bus, openDbAt, paths } from '@spider/db-core';
import { createHerdrDataSource } from '../herdr/data-source.js';
import { setupHerdr } from '../../../herdr/src/setup/installer.js';
import { runHerdrCli } from '../../../herdr/src/setup/cli.js';
import { publishSessionFeed, publishSessionHeartbeat } from '../../../herdr/src/feed/publisher.js';
import { startSessionEndpoint } from '../../../herdr/src/feed/ipc-server.js';
import { createTerminalRegistry } from '../../../herdr/src/sessions/registry.js';
import type { SessionFeed } from '../../../herdr/src/contracts.js';
import { cleanup, fixture } from './herdr-setup-fixture.js';

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFileSync: (...args: Parameters<typeof actual.execFileSync>) => args[0] === 'ps' && args[1]?.[0] === '-U' ? '' : actual.execFileSync(...args) };
});
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); });

it('replays committed intentional notices into a later feed but ignores generic tool events', async () => {
  const scratch = join(paths.scratch('worktree', process.cwd()), 'intentional-feed'); mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, 'case-')), dbPath = join(root, 'runs.db'), approvals = join(root, 'global.db'), now = Date.now();
  let current = now;
  cleanup.push(async () => { rmSync(root, { recursive: true, force: true }); });
  const db = openDbAt(dbPath, 'worktree');
  appendEvent(db, { sessionId: 'owner', ts: now, phase: 'after', tool: 'notify', payload: { version: 1, kind: 'agent-notification', id: 'notice-1', toolCallId: 'call-1', message: 'Choose a fix', urgency: 'attention', runId: null } });
  appendEvent(db, { sessionId: 'owner', ts: now, phase: 'after', tool: 'exec', payload: { message: 'not a notice' } }); db.close();
  const source = createHerdrDataSource({
    resolveRunDb: () => ({ db: openDbAt(dbPath, 'worktree'), dbPath }), openApprovalDbs: () => ({ global: openDbAt(approvals, 'global'), repo: null }),
    runEvents: bus, scheduler: { listTriggers: () => [], subscribe: () => () => {} },
    readUsage: async () => ({ snapshots: [], budget: undefined, correctedMonth: null, correctedWindow: null, updatedAt: null }),
    readConfig: () => ({ limits: { auxiliaryPanes: 2, completedRows: 50, completedHours: 24 } }), clock: () => current,
  });
  cleanup.push(async () => { await source.dispose(); });
  const owner = { sessionId: 'owner', generation: 'generation', terminal: { coreId: 'core', terminalId: 'terminal', address: 'terminal', socket: join(root, 'socket'), sessionNamespace: 'fixture' }, cwd: root, sessionFile: null, name: 'Owner' } as any;
  const feed = await source.snapshot(owner);
  expect(feed.notifications).toHaveLength(1);
  expect(feed.notifications[0]).toMatchObject({ kind: 'intentional', id: 'notice-1', body: 'Choose a fix', runId: null, sessionId: 'owner', action: { kind: 'focus-owner', address: 'terminal' } });
  const childDb = openDbAt(dbPath, 'worktree');
  appendEvent(childDb, { sessionId: 'owner', ts: now + 1, phase: 'after', tool: 'notify', payload: { version: 1, kind: 'agent-notification', id: 'notice-2', toolCallId: 'call-2', message: 'Review the child', urgency: 'urgent', runId: 'run-1' } }); childDb.close();
  current = now + 1;
  const next = await source.snapshot(owner);
  expect(next.notifications).toHaveLength(2);
  expect(next.notifications[0]).toMatchObject({ kind: 'intentional', id: 'notice-2', body: 'Review the child', urgency: 'urgent', runId: 'run-1', action: { kind: 'open-run', sessionId: 'owner', runId: 'run-1' } });
});

it.each([true, false])('doctor judges an unchanged owner by its generation-bound heartbeat (present: %s)', async present => {
  const f = await fixture(); await setupHerdr(f.request, f.parts);
  const owner = f.h.owner!, root = join(f.request.config.globalRoot, 'herdr'), now = Date.now();
  const unused = () => { throw new Error('Unexpected session action'); };
  const endpoint = await startSessionEndpoint(owner, { currentOwner: () => owner, liveCapabilities: () => ({ native: 'working', effective: 'working' }),
    ownsRun: () => false, subscribeRun: unused, steerRun: unused, openView: unused, openRun: () => null, ownsJob: () => false, openJob: () => null }, root);
  cleanup.push(async () => { await endpoint.dispose(); });
  const feed: SessionFeed = { version: 1, sessionId: owner.sessionId, generation: owner.generation, owner, revision: 1, updatedAt: now - 60000,
    placement: null, lifecycle: 'live', status: { native: 'working', effective: 'working', message: null },
    runs: { rows: [], total: 0, truncated: false }, todos: { rows: [], total: 0, truncated: false }, triggers: [],
    pace: { scope: 'session', used: null, budget: null, projected: null, remaining: null, periodStart: null, periodEnd: null, updatedAt: null, unavailableReason: null },
    approvals: [], notifications: [], ipc: endpoint.descriptor, errors: [] };
  await publishSessionFeed(root, feed);
  const file = join(root, 'sessions', owner.sessionId, 'session.json'), before = await readFile(file, 'utf8');
  if (present) await publishSessionHeartbeat(root, owner, now);
  await createTerminalRegistry(root).record({ owner, recordedAt: now, coreStartedAt: 1, environment: { agentDirectory: f.request.config.agentDirectory, extensionArguments: [] } });
  let output = '';
  const code = await runHerdrCli(['doctor', '--config', f.request.configPath], { ...f.ports, stdout: message => { output += message; } });
  expect(code, output).toBe(present ? 0 : 1);
  expect(output.includes('feed-stale:')).toBe(!present);
  expect(output).not.toContain('feed-owner-ended:');
  expect(output).not.toContain('live-owner-unavailable:');
  expect(await readFile(file, 'utf8')).toBe(before);
}, 60000);

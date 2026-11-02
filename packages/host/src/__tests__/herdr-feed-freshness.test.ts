// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { afterEach, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
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

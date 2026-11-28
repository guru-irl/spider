// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { afterEach, expect, it, vi } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { openDbAt } from '@spider/db-core';
import { createHerdrHarness } from '../../../herdr/src/__tests__/testutil.js';
import { createAppClient } from '../../../herdr/src/client/app.js';
import { createSessionIpcClient } from '../../../herdr/src/feed/ipc-client.js';
import type { SessionFeed } from '../../../herdr/src/contracts.js';
import { mountHerdr } from '../herdr/mount.js';

afterEach(() => { vi.unstubAllEnvs(); });

it('mounted endpoint reopens the same parked owner terminal through openSession', async () => {
  const h = await createHerdrHarness('fake');
  let mount: ReturnType<typeof mountHerdr> | undefined;
  let ipc: ReturnType<typeof createSessionIpcClient> | undefined;
  try {
    await h.start();
    execFileSync('git', ['init', '-q', h.directories.local]);
    for (const [key, value] of Object.entries(h.localEnv)) if (value !== undefined) vi.stubEnv(key, value);
    vi.stubEnv('PI_SUBAGENT_CHILD', '0'); vi.stubEnv('SPIDER_GLOBAL_ROOT', h.directories.global); vi.stubEnv('PI_CODING_AGENT_DIR', h.directories.agent);
    const config = { enabled: true, app: { binary: h.appBinary, home: h.directories.app }, core: { binary: h.hcBinary, config: join(h.root, 'core.toml') }, agentDirectory: h.directories.agent, globalRoot: h.directories.global, shellRc: join(h.root, 'shellrc'), spaces: [], machines: [], limits: { auxiliaryPanes: 2, completedRows: 50, completedHours: 24 }, retention: { foregroundDays: 7 }, admin: { wrappers: [] } };
    const hooks = new Map<string, Set<Function>>(), errors: unknown[] = [];
    const pi = { on(name: string, handler: Function) { if (!hooks.has(name)) hooks.set(name, new Set()); hooks.get(name)!.add(handler); return () => hooks.get(name)!.delete(handler); }, registerTool() {}, getSessionName: () => undefined };
    const ctx = { cwd: h.directories.local, mode: 'rpc', hasUI: false, ui: { notify() {} }, sessionManager: { getSessionId: () => h.owner!.sessionId, getSessionFile: () => undefined, getEntries: () => [], getBranch: () => [] } };
    const dbPath = join(h.root, 'runs.db'), globalPath = join(h.root, 'global.db');
    mount = mountHerdr(pi as never, { packageRoot: h.root, readConfig: async () => config as never, actionContext: () => ({}), reportError: error => errors.push(error),
      views: { agents: { open: async () => {} }, todos: { handler: async () => {} }, usage: { handler: async () => {} }, memory: async () => {}, loop: { handler: async () => {} } },
      dataSource: { resolveRunDb: () => ({ db: openDbAt(dbPath, 'worktree'), dbPath }), openApprovalDbs: () => ({ global: openDbAt(globalPath, 'global'), repo: null }), readUsage: async () => ({ snapshots: [], budget: undefined, correctedMonth: null, correctedWindow: null, updatedAt: null }), scheduler: { listTriggers: () => [], subscribe: () => () => {} } },
    });
    for (const handler of hooks.get('session_start') ?? []) await handler({ reason: 'startup' }, ctx);
    const feed = JSON.parse(await readFile(join(config.globalRoot, 'herdr/sessions', h.owner!.sessionId, 'session.json'), 'utf8')) as SessionFeed;
    ipc = createSessionIpcClient({ version: 1, sessionId: feed.sessionId, generation: feed.generation, ...feed.ipc! });
    const app = createAppClient({ binary: h.appBinary, env: h.localEnv });
    const anchor = await h.hc.run({ argv: [process.execPath, '-e', 'setInterval(() => {}, 1000)'], cwd: null, labels: {}, outliveParent: false, background: false, noNotify: true });
    const appPath = join(h.directories.local, 'app.json');
    const world = JSON.parse(await readFile(appPath, 'utf8'));
    world.spaces[0].active = true; world.spaces[0].tabs[0].active = true;
    world.spaces[0].tabs[0].terminals.push({ terminal: anchor.address, pane: 'anchor-pane' }); world.focusedPane = 'anchor-pane';
    await writeFile(appPath, JSON.stringify(world));
    const ownerAddress = h.owner!.terminal.address;
    expect(await app.command('terminal.park', { terminal: ownerAddress })).toMatchObject({ pending: true });
    await expect(app.ownerPlacement(ownerAddress)).rejects.toMatchObject({ code: 'owner-unplaced' });
    expect((await h.hc.get(ownerAddress)).state).toBe('live');
    expect(await ipc.request({ op: 'openSession', generation: feed.generation, destination: null })).toEqual({ ok: true, op: 'openSession', terminal: ownerAddress });
    expect(await app.ownerPlacement(ownerAddress)).toMatchObject({ space: 's1', tab: 'tb1' });
    expect((await h.hc.get(ownerAddress)).state).toBe('live');
    const coreCalls = (await readFile(join(h.directories.local, 'calls.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as { argv: string[] });
    expect(coreCalls.filter(call => call.argv[0] === 'run')).toHaveLength(2); // fixture owner and anchor only
    expect(errors).toEqual([]);
  } finally { ipc?.dispose(); await mount?.dispose(); await h.close(); expect(await h.remainingOwnedResources()).toEqual([]); }
}, 30000);

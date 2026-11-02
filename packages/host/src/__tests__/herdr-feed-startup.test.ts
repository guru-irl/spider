// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { afterEach, expect, it, vi } from 'vitest';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { openDbAt } from '@spider/db-core';
import { createHerdrHarness } from '../../../herdr/src/__tests__/testutil.js';
import { mountHerdr } from '../herdr/mount.js';

afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

// Subscribing before awaiting the initial coalesced publication makes startup
// wait for later refreshes too. A busy app can then keep session_start pending.
it('settles startup after the first feed even when refreshes outpace app placement reads', async () => {
  const h = await createHerdrHarness('fake');
  let mount: ReturnType<typeof mountHerdr> | undefined;
  let startup: Promise<void> | undefined;
  const gates = [join(h.root, 'release-1'), join(h.root, 'release-2')];
  try {
    await h.start();
    for (const [key, value] of Object.entries(h.localEnv)) if (value !== undefined) vi.stubEnv(key, value);
    vi.stubEnv('PI_SUBAGENT_CHILD', '0');
    vi.stubEnv('SPIDER_GLOBAL_ROOT', h.directories.global);
    vi.stubEnv('PI_CODING_AGENT_DIR', h.directories.agent);
    const appScript = join(h.root, 'gated-app.mjs'), appBinary = join(h.root, 'gated-app');
    // Delay only the external app's ls response. Feed computation, publication,
    // IPC, coalescing and the production two-second refresh remain real.
    await writeFile(appScript, `import { existsSync, readFileSync, writeFileSync, watch } from 'node:fs';
import { execFileSync } from 'node:child_process';
const root = ${JSON.stringify(h.root)}, countFile = root + '/app-count';
if (process.argv[2] === 'ls') {
 const n = existsSync(countFile) ? Number(readFileSync(countFile, 'utf8')) + 1 : 1;
 writeFileSync(countFile, String(n)); writeFileSync(root + '/ready-' + n, 'ready');
 const gate = root + '/release-' + n;
 if (n <= 2 && !existsSync(gate)) await new Promise(resolve => {
  const w = watch(root, () => { if (existsSync(gate)) { w.close(); resolve(); } });
  if (existsSync(gate)) { w.close(); resolve(); }
 });
}
process.stdout.write(execFileSync(${JSON.stringify(h.appBinary)}, process.argv.slice(2), { encoding: 'utf8' }));
`);
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    await writeFile(appBinary, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(appScript)} "$@"\n`); await chmod(appBinary, 0o700);
    const config = { enabled: true, app: { binary: appBinary, home: h.directories.app }, core: { binary: h.hcBinary, config: join(h.root, 'core.toml') }, agentDirectory: h.directories.agent, globalRoot: h.directories.global, shellRc: join(h.root, 'shellrc'), spaces: [], machines: [], limits: { auxiliaryPanes: 2, completedRows: 50, completedHours: 24 }, retention: { foregroundDays: 7 }, admin: { wrappers: [] } };
    const hooks = new Map<string, Set<Function>>(), errors: unknown[] = [];
    const pi = { on(name: string, handler: Function) { if (!hooks.has(name)) hooks.set(name, new Set()); hooks.get(name)!.add(handler); return () => hooks.get(name)!.delete(handler); }, registerTool() {}, getSessionName: () => undefined };
    const ctx = { cwd: h.directories.local, mode: 'rpc', hasUI: false, ui: { notify() {} }, sessionManager: { getSessionId: () => h.owner!.sessionId, getSessionFile: () => undefined, getEntries: () => [], getBranch: () => [] } };
    const dbPath = join(h.root, 'runs.db'), globalPath = join(h.root, 'global.db');
    mount = mountHerdr(pi as never, { packageRoot: h.root, readConfig: async () => config as never, actionContext: () => ({}), reportError: error => errors.push(error),
      views: { agents: { open: async () => {} }, todos: { handler: async () => {} }, usage: { handler: async () => {} }, memory: async () => {}, loop: { handler: async () => {} } },
      dataSource: { resolveRunDb: () => ({ db: openDbAt(dbPath, 'worktree'), dbPath }), openApprovalDbs: () => ({ global: openDbAt(globalPath, 'global'), repo: null }), readUsage: async () => ({ snapshots: [], budget: undefined, correctedMonth: null, correctedWindow: null, updatedAt: null }), scheduler: { listTriggers: () => [], subscribe: () => () => {} } },
    });
    // Advance only recurring timers while the real app read is gated. No elapsed
    // sleep stands in for a refresh or a completed publication.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    let settled = false;
    startup = (async () => { for (const handler of hooks.get('session_start') ?? []) await handler({ reason: 'startup' }, ctx); settled = true; })();
    await vi.waitFor(() => expect(existsSync(join(h.root, 'ready-1'))).toBe(true), { timeout: 5000 });
    vi.advanceTimersByTime(2000);
    await writeFile(gates[0], 'release');
    const feedPath = join(config.globalRoot, 'herdr/sessions', h.owner!.sessionId, 'session.json');
    await vi.waitFor(async () => expect(JSON.parse(await readFile(feedPath, 'utf8'))).toMatchObject({ version: 1, sessionId: h.owner!.sessionId, revision: 1, lifecycle: 'live' }), { timeout: 5000 });
    await vi.waitFor(() => expect(settled, 'later refreshes must not hold session_start open').toBe(true), { timeout: 1000 });
    await startup;
    // A slow full refresh must not stop liveness or rewrite unchanged content.
    const content = await readFile(feedPath, 'utf8'), heartbeatPath = join(config.globalRoot, 'herdr/sessions', h.owner!.sessionId, 'heartbeat.json');
    const heartbeat = JSON.parse(await readFile(heartbeatPath, 'utf8')).updatedAt;
    vi.advanceTimersByTime(2000);
    await vi.waitFor(() => expect(existsSync(join(h.root, 'ready-2'))).toBe(true), { timeout: 5000 });
    await vi.waitFor(async () => expect(JSON.parse(await readFile(heartbeatPath, 'utf8')).updatedAt).toBeGreaterThan(heartbeat), { timeout: 5000 });
    expect(await readFile(feedPath, 'utf8')).toBe(content);
    await writeFile(gates[1], 'release');
    expect(JSON.parse(await readFile(feedPath, 'utf8')).revision).toBe(1);
    expect(errors).toEqual([]);
  } finally {
    for (const gate of gates) await writeFile(gate, 'release');
    await startup;
    await mount?.dispose();
    vi.useRealTimers();
    await h.close();
    expect(await h.remainingOwnedResources()).toEqual([]);
  }
}, 30000);

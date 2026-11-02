import { afterEach, expect, it, vi } from 'vitest';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { openDbAt } from '@spider/db-core';
import { createHerdrHarness } from '../../../herdr/src/__tests__/testutil.js';
import { createTerminalRegistry } from '../../../herdr/src/sessions/registry.js';
import { mountHerdr } from '../herdr/mount.js';

afterEach(() => vi.unstubAllEnvs());

it('records pi’s effective agent directory for a Herdr owner', async () => {
  const h = await createHerdrHarness('fake');
  try {
    await h.start();
    const home = join(h.root, 'home'); await mkdir(home);
    for (const [key, value] of Object.entries(h.localEnv)) {
      if (value !== undefined && (key.startsWith('HC_') || key.startsWith('XDG_') || key.startsWith('HERDR_') || key === 'PATH')) vi.stubEnv(key, value);
    }
    vi.stubEnv('HOME', home);
    vi.stubEnv('SPIDER_GLOBAL_ROOT', h.directories.global);
    const config = { enabled: true, app: { binary: h.appBinary, home: h.directories.app }, core: { binary: h.hcBinary, config: join(h.root, 'core.toml') }, agentDirectory: h.directories.agent, globalRoot: h.directories.global, shellRc: join(h.root, 'shellrc'), spaces: [], machines: [], limits: { auxiliaryPanes: 2, completedRows: 50, completedHours: 24 }, retention: { foregroundDays: 7 }, admin: { wrappers: [] } };
    for (const [configured, expected] of [
      [undefined, join(home, '.pi/agent')],
      ['~/custom-agent', join(home, 'custom-agent')],
      [h.directories.agent, h.directories.agent],
    ]) {
      vi.stubEnv('PI_CODING_AGENT_DIR', configured);
      const hooks = new Map<string, Set<Function>>(), errors: unknown[] = [];
      const pi = { on(name: string, handler: Function) { if (!hooks.has(name)) hooks.set(name, new Set()); hooks.get(name)!.add(handler); return () => hooks.get(name)!.delete(handler); }, registerTool() {}, getSessionName: () => undefined };
      const ctx = { cwd: h.directories.local, mode: 'rpc', hasUI: false, ui: { notify() {} }, sessionManager: { getSessionId: () => h.owner!.sessionId, getSessionFile: () => undefined, getEntries: () => [], getBranch: () => [] } };
      const dbPath = join(h.root, 'runs.db'), globalPath = join(h.root, 'global.db');
      const mount = mountHerdr(pi as never, { packageRoot: h.root, readConfig: async () => config as never, actionContext: () => ({}), reportError: error => errors.push(error),
        views: { agents: { open: async () => {} }, todos: { handler: async () => {} }, usage: { handler: async () => {} }, memory: async () => {}, loop: { handler: async () => {} } },
        dataSource: { resolveRunDb: () => ({ db: openDbAt(dbPath, 'worktree'), dbPath }), openApprovalDbs: () => ({ global: openDbAt(globalPath, 'global'), repo: null }), readUsage: async () => ({ snapshots: [], budget: undefined, correctedMonth: null, correctedWindow: null, updatedAt: null }), scheduler: { listTriggers: () => [], subscribe: () => () => {} } },
      });
      try {
        for (const handler of hooks.get('session_start') ?? []) await handler({ reason: 'startup' }, ctx);
        expect(mount.enabled()).toBe(true);
        const records = await createTerminalRegistry(join(h.directories.global, 'herdr')).list();
        expect(records).toHaveLength(1);
        expect(records[0].environment.agentDirectory).toBe(expected);
        expect(errors).toEqual([]);
      } finally { await mount.dispose(); }
    }
  } finally {
    vi.unstubAllEnvs();
    await h.close();
    expect(await h.remainingOwnedResources()).toEqual([]);
  }
}, 30000);

// SPDX-License-Identifier: MIT
import { afterEach, expect, test, vi } from 'vitest';
import { access, copyFile, cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { openDbAt } from '@spider/db-core';
import { createHerdrHarness } from '../../../herdr/src/__tests__/testutil.js';
import { createTerminalRegistry } from '../../../herdr/src/sessions/registry.js';
import { setupHerdr, standardHerdrConfigPath } from '../../../herdr/src/setup/installer.js';
import { createProductionHerdrCliPorts } from '../herdr/ports.js';
import { controlConfig } from '../control.js';
import { mountHerdr, type HerdrMount } from '../herdr/mount.js';
import { isCoreAvailable } from '../../../herdr/src/client/liveness.js';

const mounts: HerdrMount[] = [];
afterEach(async () => { for (const m of mounts.splice(0)) await m.dispose(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });
async function fixture(kind: 'parent' | 'child', base: 'cwd' | 'home', mode: 'fake' | 'hc') {
  const originalHome = process.env.HOME;
  const h = await createHerdrHarness(mode);
  try {
    h.localEnv.HOME = h.remoteEnv.HOME = h.directories.remote;
    await h.start();
    const callsFile = join(h.root, 'tracked-calls.jsonl'), trackedHc = join(h.root, 'tracked-hc');
    await writeFile(callsFile, '');
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    const log = `require('node:fs').appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify(process.argv.slice(1)) + '\\n')`;
    await writeFile(trackedHc, `#!/bin/sh\n${quote(process.execPath)} -e ${quote(log)} -- "$@"\nexec ${quote(h.hcBinary)} "$@"\n`, { mode: 0o700 });
    const cwd = base === 'cwd' ? join(h.directories.remote, 'work') : null;
    if (cwd) await mkdir(cwd);
    execFileSync('git', ['init', '-q', h.directories.local]);
    await mkdir(join(h.root, 'dist/herdr'), { recursive: true });
    await copyFile(resolve('dist/herdr/cli.mjs'), join(h.root, 'dist/herdr/cli.mjs'));
    await copyFile(resolve('dist/herdr/remote-runtime.mjs'), join(h.root, 'dist/herdr/remote-runtime.mjs'));
    await cp(resolve('packages/herdr/assets'), join(h.root, 'packages/herdr/assets'), { recursive: true });
    await mkdir(join(h.directories.global, 'herdr'), { recursive: true });
    await writeFile(standardHerdrConfigPath(h.directories.global), JSON.stringify({ enabled: true,
      core: { binary: trackedHc, config: join(h.localEnv.XDG_CONFIG_HOME!, 'herdr-core/config.toml') }, app: { binary: mode === 'fake' ? h.appBinary : join(h.root, 'no-app'), home: h.directories.app },
      agentDirectory: h.directories.agent, globalRoot: h.directories.global, shellRc: join(h.root, 'shellrc'), spaces: [], machines: [{ name: 'remote.invalid', aliases: [], nodePath: process.execPath,
        runtime: { cwd, directory: join(h.directories.remote, 'programs'), commands: {} } }] }));
    await writeFile(join(h.directories.app, 'settings.json'), '{}');
    const ports = createProductionHerdrCliPorts(h.root, h.localEnv);
    try {
      const cwd = vi.spyOn(process, 'cwd').mockReturnValue(h.directories.local);
      let request;
      try { request = await ports.request(); } finally { cwd.mockRestore(); }
      const parts = await ports.setupParts(request);
      await setupHerdr(request, { ...parts,
        preflight: async () => ({ fingerprint: 'session-registry-test', coreIdentity: h.owner!.terminal, mods: ['panel', 'machines'].map(name => ({ directory: join(h.directories.app, 'mods', `spider-${name}`) })), targets: [{ machine: 'remote.invalid' as never, nodePath: process.execPath, coreStartedAt: 'isolated' }], retiredTerminals: [], layoutExport: true }),
        stageLook: async () => [], generateTemplates: async () => [], cutover: async () => ({ terminals: [], identities: {} }), verify: async () => ({ checks: [], failures: [], warnings: [], probes: [] }),
      });
    } finally { await ports.dispose(); }
    const registry = createTerminalRegistry(join(h.directories.global, 'herdr'));
    const dbPath = join(h.root, 'runs.db'), globalPath = join(h.root, 'global.db');
    openDbAt(dbPath, 'worktree').close(); openDbAt(globalPath, 'global').close();
    const hooks = new Map<string, Function[]>(), notices: string[] = [], noticeLevels: string[] = [], errors: unknown[] = [];
    let session = 'owner-session';
    const ctx = { cwd: h.directories.local, mode: 'rpc', hasUI: true, isIdle: () => true,
      sessionManager: { getSessionId: () => session, getSessionFile: () => undefined, getEntries: () => [], getBranch: () => [] },
      ui: { notify: (message: string, level: string) => { notices.push(message); noticeLevels.push(level); }, setStatus() {}, setWidget() {}, setFooter() {} } };
    const pi = { on: (name: string, handler: Function) => { hooks.set(name, [...hooks.get(name) ?? [], handler]); return () => {}; }, registerTool() {}, registerCommand() {}, registerShortcut() {}, sendMessage() {} };
    const environment = (synthetic = true) => {
      for (const [key, value] of Object.entries(h.localEnv)) if (value !== undefined) vi.stubEnv(key, value);
      vi.stubEnv('PI_SUBAGENT_CHILD', kind === 'child' ? '1' : '0');
      if (kind === 'child') { vi.stubEnv('PI_SUBAGENT_RUN_ID', 'file-child'); vi.stubEnv('PI_SPIDER_TOP_SESSION_ID', 'owner-session'); }
      if (!synthetic) vi.stubEnv('HERDR_TEST_SYNTHETIC_CALLER', undefined);
    };
    environment();
    controlConfig('set', h.directories.local, 'herdr.enabled', true, 'global');
    const mounted = (otherPi = pi) => {
      const mount = mountHerdr(otherPi as never, { packageRoot: h.root, actionContext: () => ({}), reportError: error => errors.push(error),
        views: { agents: { open() {} }, todos: { handler() {} }, usage: { handler() {} }, memory() {}, loop: { handler() {} } },
        dataSource: { resolveRunDb: () => ({ db: openDbAt(dbPath, 'worktree'), dbPath }), openApprovalDbs: () => ({ global: openDbAt(globalPath, 'global'), repo: null }),
          readUsage: async () => ({ snapshots: [], budget: undefined, correctedMonth: null, correctedWindow: null, updatedAt: null }), scheduler: { listTriggers: () => [], subscribe: () => () => {} } } });
      mounts.push(mount); return mount;
    };
    const start = async () => { for (const hook of [...hooks.get('session_start') ?? []]) await hook({ reason: 'reload' }, ctx); };
    const shutdown = async () => { for (const hook of [...hooks.get('session_shutdown') ?? []]) await hook({ reason: 'reload' }, ctx); };
    return { originalHome, cwd, calls: async () => (await readFile(callsFile, 'utf8')).trim().split('\n').filter(Boolean).map(line => ({ argv: JSON.parse(line) as string[] })), h, registry, ctx, hooks, notices, noticeLevels, errors, start, shutdown, mounted, environment, nextSession: () => { session = 'next-session'; }, feed: join(h.directories.global, 'herdr/sessions/owner-session/session.json') };
  } catch (error) { vi.stubEnv('HOME', originalHome); await h.close(); throw error; }
}

test.each(['parent', 'child'] as const)('%s names an absolute remote file-read failure instead of a parser failure', async kind => {
  const f = await fixture(kind, 'cwd', 'fake');
  try {
    const m = f.mounted(); await f.start(); expect(m.enabled()).toBe(true);
    const missing = await m.guard({ toolName: 'spider', input: { action: 'exec_file', language: 'shell', on: 'remote.invalid', path: join(f.cwd!, 'absent.txt') } });
    expect(missing?.block).toBe(true); expect(missing?.reason).toContain('absent.txt');
    expect(missing?.reason).toContain("couldn't find the command file"); expect(missing?.reason).toContain('Check the path'); expect(missing?.reason).not.toContain('SSH parser failed');
  } finally { for (const m of mounts.splice(0)) await m.dispose(); vi.stubEnv('HOME', f.originalHome); await f.h.close(); }
}, 60000);

const realHc = process.env.SPIDER_HERDR_E2E === '1' && await access(process.env.SPIDER_HERDR_HC_BINARY ?? join(process.env.HOME!, '.local/bin/hc')).then(() => true, () => false);
if (!realHc) console.info('Real isolated hc remote-file checks skipped; set SPIDER_HERDR_E2E=1 with hc installed.');

for (const mode of ['fake', 'hc'] as const) for (const kind of ['parent', 'child'] as const) for (const base of ['cwd', 'home'] as const) {
  test.skipIf(mode === 'hc' && !realHc)(`${mode}: ${kind} exec_file resolves relative paths against remote ${base} and preserves missing-file errors`, async () => {
    const f = await fixture(kind, base, mode);
    try {
      const destination = join(f.cwd ?? f.h.directories.remote, 'input.txt');
      await f.h.hc.fileWrite('remote.invalid' as never, destination, Buffer.from('destination-data'));
      await writeFile(join(f.h.directories.local, 'input.txt'), 'ssh remote.invalid true');
      const m = f.mounted(); await f.start(); expect(m.enabled()).toBe(true); expect(f.errors).toEqual([]);
      const input = { action: 'exec_file', language: 'shell', path: 'input.txt', on: 'remote.invalid', code: 'printf "%s" "$FILE_CONTENT"' };
      expect(await m.guard({ toolName: 'spider', input })).toBeUndefined();
      const execution = m.execution();
      const result = await execution.remote!.execute({ owner: execution.owner!, on: 'remote.invalid' as never,
        source: { kind: 'file', language: 'shell', path: input.path, code: input.code } });
      expect(result.exitCode).toBe(0); expect(result.stdout).toBe('destination-data');
      expect(await m.guard({ toolName: 'spider', input: { ...input, path: destination } })).toBeUndefined();
      const missing = await m.guard({ toolName: 'spider', input: { ...input, path: 'absent.txt' } });
      expect(missing?.block).toBe(true); expect(missing?.reason).toContain('absent.txt');
      expect(missing?.reason).toContain("couldn't find the command file"); expect(missing?.reason).toContain('Check the path'); expect(missing?.reason).not.toContain('SSH parser failed');
      await f.shutdown(); await f.start();
      expect(await m.guard({ toolName: 'spider', input })).toBeUndefined();
      await f.h.hc.fileWrite('remote.invalid' as never, destination, Buffer.from('ssh remote.invalid true'));
      expect(await m.guard({ toolName: 'spider', input: { ...input, path: destination } })).toMatchObject({ block: true, reason: expect.stringContaining('on:remote.invalid') });
      const calls = await f.calls();
      const reads = calls.filter(call => call.argv[0] === 'file' && call.argv[1] === 'read');
      expect(reads.some(call => call.argv.at(-1) === destination)).toBe(true);
      expect(reads.some(call => call.argv.at(-1) === 'input.txt')).toBe(false);
      const probes = calls.filter(call => call.argv[0] === 'run' && call.argv.some(argument => argument.includes('homedir')));
      expect(probes).toHaveLength(base === 'home' ? 1 : 0);
      for (const probe of probes) { expect(probe.argv).toContain('--no-notify'); expect(probe.argv).toContain('--bg'); }
    } finally { for (const m of mounts.splice(0)) await m.dispose(); vi.stubEnv('HOME', f.originalHome); await f.h.close(); expect(await f.h.remainingOwnedResources()).toEqual([]); }
  }, 90000);
}

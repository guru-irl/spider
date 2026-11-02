// SPDX-License-Identifier: MIT
import { afterEach, expect, test, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { ProcessTerminal } from '@earendil-works/pi-tui';
import { openDbAt } from '@spider/db-core';
import { setupHerdr } from '../../../herdr/src/setup/installer.js';
import { createTerminalRegistry } from '../../../herdr/src/sessions/registry.js';
import { createProcessPresence } from '../../../herdr/src/sessions/presence.js';
import { createMachineCache } from '../../../herdr/src/ssh/cache.js';
import { createExecutionEnvironmentPolicy, installSshShim, sshShimDirectory } from '../../../herdr/src/ssh/shim.js';
import { PolyglotExecutor } from '../../../context/src/executor.js';
import { fixture as setupFixture, cleanup } from './herdr-setup-fixture.js';
import { controlConfig } from '../control.js';
import { processStartTime } from '../../../subagents/src/process-identity.js';
import { mountHerdr, type HerdrMount } from '../herdr/mount.js';

const mounts: HerdrMount[] = [];
afterEach(async () => {
  try { for (const mount of mounts.splice(0)) await mount.dispose(); }
  finally {
    try { for (const close of cleanup.splice(0).reverse()) await close(); }
    finally { vi.restoreAllMocks(); vi.unstubAllEnvs(); }
  }
});

async function fixture(mode: ExtensionContext['mode']) {
  const f = await setupFixture();
  await setupHerdr(f.request, { ...f.parts,
    preflight: async () => ({ fingerprint: 'mode-test', coreIdentity: f.h.owner!.terminal,
      mods: ['panel', 'machines'].map(name => ({ directory: join(f.h.directories.app, 'mods', `spider-${name}`) })),
      targets: [{ machine: 'remote.invalid' as never, nodePath: process.execPath, coreStartedAt: 'isolated' }], retiredTerminals: [], layoutExport: true }),
    stageLook: async () => [], generateTemplates: async () => [], cutover: async () => ({ terminals: [], identities: {} }),
    verify: async () => ({ checks: [], failures: [], warnings: [], probes: [] }),
  });
  for (const [key, value] of Object.entries(f.h.localEnv)) if (value !== undefined) vi.stubEnv(key, value);
  vi.stubEnv('SPIDER_GLOBAL_ROOT', f.h.directories.global); vi.stubEnv('PI_SUBAGENT_CHILD', '0');
  controlConfig('set', f.h.root, 'herdr.config', f.request.configPath, 'global');
  controlConfig('set', f.h.root, 'herdr.enabled', true, 'global');
  const hooks = new Map<string, Function[]>(), errors: unknown[] = [], captured: string[] = [], notices: string[] = [];
  const terminal = Object.create(ProcessTerminal.prototype); Reflect.set(terminal, 'programStatusSupported', false); terminal.setProgramStatus({ state: 'done' });
  const ctx = { cwd: f.h.root, mode, hasUI: mode === 'tui' || mode === 'rpc', isIdle: () => true,
    sessionManager: { getSessionId: () => 'candidate-session', getSessionFile: () => undefined, getEntries: () => [], getBranch: () => [] },
    ui: { notify(message: string) { notices.push(message); }, setStatus() {}, setWidget(name: string, factory: unknown) {
      if (typeof factory === 'function') { captured.push(name); (factory as Function)({ terminal }); }
    } } } as unknown as ExtensionContext;
  const pi = { on(name: string, handler: Function) { hooks.set(name, [...hooks.get(name) ?? [], handler]); return () => {}; }, registerTool() {}, registerCommand() {}, registerShortcut() {}, sendMessage() {} };
  const dbPath = join(f.h.root, 'runs.db'), globalPath = join(f.h.root, 'global.db');
  openDbAt(dbPath, 'worktree').close(); openDbAt(globalPath, 'global').close();
  const mount = mountHerdr(pi as never, { packageRoot: f.root, actionContext: () => ({}), reportError: error => errors.push(error),
    views: { agents: { open() {} }, todos: { handler() {} }, usage: { handler() {} }, memory() {}, loop: { handler() {} } },
    dataSource: { resolveRunDb: () => ({ db: openDbAt(dbPath, 'worktree'), dbPath }), openApprovalDbs: () => ({ global: openDbAt(globalPath, 'global'), repo: null }),
      readUsage: async () => ({ snapshots: [], budget: undefined, correctedMonth: null, correctedWindow: null, updatedAt: null }), scheduler: { listTriggers: () => [], subscribe: () => () => {} } },
  });
  mounts.push(mount);
  return { ...f, mount, ctx, errors, captured, notices, registry: createTerminalRegistry(join(f.h.directories.global, 'herdr')),
    presence: createProcessPresence(join(f.h.directories.global, 'herdr')), feed: join(f.h.directories.global, 'herdr/sessions/candidate-session/session.json'),
    fire: async (name: string) => { for (const hook of hooks.get(name) ?? []) await hook({}, ctx); } };
}

test.each(['json', 'print'] as const)('a %s top-level mount stays ownerless and writes no mapping or feed', async mode => {
  const f = await fixture(mode);
  await f.fire('session_start');
  expect(f.mount.owner()).toBeNull(); expect(f.mount.enabled()).toBe(false);
  expect(await f.registry.list()).toEqual([]); expect(existsSync(f.feed)).toBe(false); expect(f.captured).toEqual([]);
  expect(await f.presence.list()).toMatchObject([{ sessionId: 'candidate-session', mode, hcAddress: null }]);
  expect(f.errors).toEqual([]);
}, 60000);

test.each(['json', 'print'] as const)('a %s mount leaves the interactive mapping untouched through startup and session changes', async mode => {
  const f = await fixture(mode);
  await f.registry.record({ owner: f.h.owner!, recordedAt: 1, coreStartedAt: 1,
    environment: { agentDirectory: f.h.directories.agent, extensionArguments: [] } });
  const previous = await f.registry.get(f.h.owner!.terminal);
  await f.fire('session_start'); expect(await f.registry.get(f.h.owner!.terminal)).toEqual(previous);
  await f.fire('session_info_changed'); expect(await f.registry.get(f.h.owner!.terminal)).toEqual(previous);
  expect(f.mount.owner()).toBeNull(); expect(existsSync(f.feed)).toBe(false); expect(f.errors).toEqual([]);
}, 60000);

test.each(['tui', 'rpc'] as const)('a nonnested %s top-level mount activates, publishes and replaces the terminal mapping', async mode => {
  const f = await fixture(mode);
  await f.registry.record({ owner: f.h.owner!, recordedAt: 1, coreStartedAt: 1,
    environment: { agentDirectory: f.h.directories.agent, extensionArguments: [] } });
  await f.fire('session_start');
  expect(f.mount.enabled()).toBe(true);
  expect((await f.registry.get(f.h.owner!.terminal))?.owner.sessionId).toBe('candidate-session');
  expect(existsSync(f.feed)).toBe(true); expect(f.captured).toEqual(mode === 'tui' ? ['spider-herdr-status'] : []); expect(f.errors).toEqual([]);
}, 60000);

test.each(['tui', 'rpc'] as const)('a nested %s session stays inactive without publishing, opening IPC or rewriting the parent shim', async mode => {
  const f = await fixture(mode), parent = f.h.owner!;
  await f.registry.record({ owner: parent, recordedAt: 1, coreStartedAt: 1, environment: { agentDirectory: f.h.directories.agent, extensionArguments: [] } });
  const terminal = await f.h.cli(['get', parent.terminal.address, '--json']) as { pid: number };
  await f.presence.record({ pid: terminal.pid, startIdentity: processStartTime(terminal.pid)!, sessionId: parent.sessionId,
    sessionFile: null, sessionName: 'parent', kind: 'top-level', mode: 'tui', hcAddress: parent.terminal.address });
  const stale = { ...parent, terminal: { ...parent.terminal, coreId: 'retired-core' as never } };
  await f.registry.record({ owner: stale, recordedAt: 1, coreStartedAt: 1, environment: { agentDirectory: f.h.directories.agent, extensionArguments: [] } });
  const previous = await f.registry.list();
  const cache = createMachineCache({ hc: f.h.hc, identity: parent.terminal, directory: join(f.h.directories.global, 'herdr/ssh') });
  try { await cache.ready; } finally { await cache.dispose(); }
  const cacheBytes = await readFile(cache.descriptor.path);
  const shimDirectory = sshShimDirectory(cache.descriptor);
  const shimOptions = { shimDirectory, cacheDescriptor: cache.descriptor, realSshBinary: process.execPath,
    shimProgram: join(f.root, 'dist/herdr/cli.mjs'), reportDisabled: (error: unknown) => { throw error; } };
  await installSshShim(shimOptions);
  const inherited = createExecutionEnvironmentPolicy(shimOptions)(process.env);
  vi.stubEnv('PATH', inherited.PATH!); vi.stubEnv('SPIDER_HERDR_SSH_DESCRIPTOR', inherited.SPIDER_HERDR_SSH_DESCRIPTOR!);
  const shim = join(shimDirectory, 'ssh'), shimBefore = await stat(shim, { bigint: true });
  await f.fire('session_start'); await f.fire('session_info_changed'); await f.fire('session_start');
  expect(f.mount.owner()).toBeNull(); expect(f.mount.enabled()).toBe(false);
  expect(await f.registry.list()).toEqual(previous); expect(existsSync(f.feed)).toBe(false);
  expect(existsSync(join(f.h.directories.global, 'herdr/sessions/candidate-session'))).toBe(false);
  expect(await readFile(cache.descriptor.path)).toEqual(cacheBytes);
  expect((await stat(shim, { bigint: true })).mtimeNs).toBe(shimBefore.mtimeNs);
  expect(f.mount.execution().remote).toBeUndefined(); expect(f.mount.execution().environmentPolicy(process.env).SPIDER_HERDR_SSH_DESCRIPTOR).toBeUndefined();
  expect(await f.mount.guard({ toolName: 'bash', input: { command: 'printf local' } })).toBeUndefined();
  expect(await new PolyglotExecutor({ projectRoot: f.h.root, ...f.mount.execution() }).execute({ language: 'shell', code: 'printf local', timeout: 5000 })).toMatchObject({ exitCode: 0, stdout: 'local' });
  expect(await f.mount.guard({ toolName: 'spider', input: { action: 'exec', on: 'remote.invalid' } })).toMatchObject({ block: true, reason: expect.stringContaining('Herdr is off in this session') });
  expect(f.notices.length).toBeLessThanOrEqual(1); expect(f.errors).toEqual([]);
}, 60000);

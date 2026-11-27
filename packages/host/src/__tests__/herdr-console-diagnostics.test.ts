// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { afterEach, expect, it, vi } from 'vitest';
import type { AgentConsoleLifecyclePorts } from '../../../herdr/src/remote/console.js';
import type { JobRegistrationPorts } from '../../../herdr/src/jobs/register.js';
import { mountedFixture } from './herdr-wiring-fixture.js';
import { openDbAt } from '@spider/db-core';

const captured = vi.hoisted(() => ({ ports: null as AgentConsoleLifecyclePorts | null, jobs: null as JobRegistrationPorts | null }));
vi.mock('@spider/herdr/remote/console', () => ({
  registerAgentConsoleLifecycle: (_pi: unknown, ports: AgentConsoleLifecyclePorts) => { captured.ports = ports; return { dispose() {} }; },
  registerChildAgentConsoleLifecycle: () => ({ dispose() {} }),
}));
vi.mock('@spider/herdr/jobs/register', async importOriginal => {
  const original = await importOriginal<typeof import('../../../herdr/src/jobs/register.js')>();
  return { ...original, registerHerdrJobs: (pi: Parameters<typeof original.registerHerdrJobs>[0], ports: JobRegistrationPorts) => {
    captured.jobs = ports; return original.registerHerdrJobs(pi, ports);
  } };
});
import { mountHerdr } from '../herdr/mount.js';
import { HerdrError } from '../../../herdr/src/client/parse.js';

afterEach(() => { captured.ports = null; captured.jobs = null; vi.restoreAllMocks(); vi.unstubAllEnvs(); });

it('records and warns about console cleanup errors in a UI session', async () => {
  vi.stubEnv('PI_SUBAGENT_CHILD', '0');
  const hooks = new Map<string, Function[]>(), recorded: unknown[] = [], warnings: unknown[] = [];
  const pi = { on(name: string, handler: Function) { hooks.set(name, [...hooks.get(name) ?? [], handler]); return () => {}; }, registerTool() {}, registerShortcut() {}, sendMessage() {} };
  const mount = mountHerdr(pi as never, { packageRoot: process.cwd(), admitted: () => false, reportError: (error: unknown) => recorded.push(error),
    views: { agents: { open() {} }, todos: { handler() {} }, usage: { handler() {} }, memory() {}, loop: { handler() {} } } } as never);
  const context = { cwd: process.cwd(), hasUI: true, mode: 'tui', ui: { notify: (...args: unknown[]) => warnings.push(args) },
    sessionManager: { getSessionId: () => 'session' } };
  try {
    await hooks.get('session_start')![0]({ reason: 'startup' }, context);
    const error = new HerdrError('machine-unavailable', 'Machine is offline');
    captured.ports!.reportCleanupError!(error);
    expect(recorded).toEqual([error]);
    expect(warnings).toEqual([[expect.any(String), 'warning']]);
    captured.ports!.reportError!(error);
    expect(recorded).toEqual([error, error]);
    expect(warnings).toHaveLength(1);
  } finally { await mount.dispose(); }
});

it('writes cleanup diagnostics to stderr in print mode', async () => {
  vi.stubEnv('PI_SUBAGENT_CHILD', '0');
  const hooks = new Map<string, Function[]>();
  const pi = { on(name: string, handler: Function) { hooks.set(name, [...hooks.get(name) ?? [], handler]); return () => {}; }, registerTool() {}, registerShortcut() {}, sendMessage() {} };
  const mount = mountHerdr(pi as never, { packageRoot: process.cwd(), admitted: () => false,
    views: { agents: { open() {} }, todos: { handler() {} }, usage: { handler() {} }, memory() {}, loop: { handler() {} } } } as never);
  const context = { cwd: process.cwd(), hasUI: false, mode: 'print', ui: { notify: vi.fn() }, sessionManager: { getSessionId: () => 'print-session' } };
  try {
    await hooks.get('session_start')![0]({ reason: 'startup' }, context);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    captured.ports!.reportCleanupError!(new HerdrError('console-cleanup-exhausted', 'Console cleanup stopped after 24 failures'));
    expect(stderr).toHaveBeenCalledOnce();
    expect(stderr).toHaveBeenCalledWith('Console cleanup stopped after 24 failures\n');
    expect(context.ui.notify).not.toHaveBeenCalled();
    stderr.mockRestore();
  } finally { await mount.dispose(); }
});

it.each([['tui', true], ['rpc', false]] as const)('routes console diagnostics in %s mode', async (mode, hasUI) => {
  const f = await mountedFixture('fake', mode, hasUI);
  await f.emit('session_shutdown', { reason: 'reload' }); await f.mount.dispose();
  const mount = mountHerdr(f.pi as never, { packageRoot: f.h.root, readConfig: async () => f.config as never,
    actionContext: () => ({}),
    views: { agents: { open() {} }, todos: { handler() {} }, usage: { handler() {} }, memory() {}, loop: { handler() {} } },
    dataSource: { resolveRunDb: () => ({ db: openDbAt(f.db.raw.name, 'worktree'), dbPath: f.db.raw.name }),
      openApprovalDbs: () => ({ global: openDbAt(f.globalDb.raw.name, 'global'), repo: null }),
      readUsage: async () => ({ snapshots: [], budget: undefined, correctedMonth: null, correctedWindow: null, updatedAt: null }),
      scheduler: { listTriggers: () => [], subscribe: () => () => {} } } });
  try {
    await f.emit('session_start', { reason: 'reload' });
    const warning = vi.spyOn(f.ctx.ui, 'notify');
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const error = new HerdrError('unavailable', 'Destination unavailable', undefined, { key: 'machine:remote.invalid', machine: 'remote.invalid' });
    const reportConsole = captured.jobs!.monitorOptions().reportConsoleError!;
    reportConsole(error); reportConsole(error); captured.ports!.reportCleanupError!(error);
    if (hasUI) {
      expect(stderr).not.toHaveBeenCalled();
      expect(warning).toHaveBeenCalledTimes(1);
      expect(warning).toHaveBeenCalledWith(expect.stringContaining("Spider couldn't reach remote.invalid"), 'warning');
    } else {
      expect(warning).not.toHaveBeenCalled();
      expect(stderr).toHaveBeenCalledTimes(3);
      expect(stderr).toHaveBeenCalledWith(expect.stringContaining("Spider couldn't reach remote.invalid"));
      const exhausted = new HerdrError('console-cleanup-exhausted', 'Console cleanup stopped after 24 failures');
      captured.ports!.reportCleanupError!(exhausted);
      expect(stderr).toHaveBeenLastCalledWith('Console cleanup stopped after 24 failures\n');
    }
    stderr.mockRestore();
  } finally { await f.emit('session_shutdown', { reason: 'reload' }); await mount.dispose(); await f.close(); }
});

// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { afterEach, expect, it, vi } from 'vitest';
import type { AgentConsoleLifecyclePorts } from '../../../herdr/src/remote/console.js';

const captured = vi.hoisted(() => ({ ports: null as AgentConsoleLifecyclePorts | null }));
vi.mock('@spider/herdr/remote/console', () => ({
  registerAgentConsoleLifecycle: (_pi: unknown, ports: AgentConsoleLifecyclePorts) => { captured.ports = ports; return { dispose() {} }; },
  registerChildAgentConsoleLifecycle: () => ({ dispose() {} }),
}));
import { mountHerdr } from '../herdr/mount.js';
import { HerdrError } from '../../../herdr/src/client/parse.js';

afterEach(() => { captured.ports = null; vi.unstubAllEnvs(); });

it('records console cleanup errors without displaying a host warning', async () => {
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
    expect(recorded).toEqual([error]); expect(warnings).toEqual([]);
    captured.ports!.reportError!(error);
    expect(warnings).toHaveLength(1);
  } finally { await mount.dispose(); }
});

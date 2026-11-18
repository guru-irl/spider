// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { afterEach, expect, it, vi } from 'vitest';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { SessionRegistrationPorts } from '../../../herdr/src/sessions/register.js';
import { mountHerdr } from '../herdr/mount.js';

const registration = vi.hoisted(() => ({ ports: undefined as SessionRegistrationPorts | undefined }));
vi.mock('@spider/herdr/sessions/register', async original => ({
  ...await original<typeof import('@spider/herdr/sessions/register')>(),
  registerHerdrSessions: (_pi: ExtensionAPI, ports: SessionRegistrationPorts) => {
    registration.ports = ports;
    return { dispose: async () => {} };
  },
}));
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); registration.ports = undefined; });

it('production mount capture records the script, pi arguments, Node flags, cwd and environment', async () => {
  const realProcess = process;
  const cwd = realProcess.cwd(), script = cwd + '/synthetic-cli.mjs';
  const secret = 'ghp' + '_' + 'synthetic'.padEnd(39, '0');
  vi.stubGlobal('process', { ...realProcess, argv: [realProcess.execPath, script, '--tools', 'read', 'initial message'], execArgv: ['--max-old-space-size=8192'], cwd: () => cwd,
    env: { ...realProcess.env, PI_SUBAGENT_CHILD: undefined, HC_TERMINAL_ID: undefined, API_TOKEN: secret } });
  const pi = { on: () => () => {}, registerTool() {}, registerCommand() {} } as unknown as ExtensionAPI;
  const mount = mountHerdr(pi, { packageRoot: cwd, actionContext: () => ({}) as never,
    views: { agents: { open: async () => {} }, todos: { handler: async () => {} }, usage: { handler: async () => {} }, memory: async () => {}, loop: { handler: async () => {} } },
  });
  try {
    const launch = registration.ports!.captureLaunch!();
    expect(launch.program).toBe(script);
    expect(launch.argv).toEqual(['--tools', 'read', 'initial message']);
    expect(launch.cwd).toBe(cwd);
    expect(launch.variables.API_TOKEN === secret).toBe(true);
    expect(launch.node).toEqual({ execPath: realProcess.execPath, execArgv: ['--max-old-space-size=8192'] });
  } finally { await mount.dispose(); }
});

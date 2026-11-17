// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { Owner, TerminalIdentity } from '../../contracts.js';
import { createTerminalRegistry } from '../../sessions/registry.js';
import { createProcessPresence } from '../../sessions/presence.js';
import { createSessionLeases } from '../../sessions/lease.js';
import { registerHerdrSessions } from '../../sessions/register.js';
import { processStartTime } from '../../../../subagents/src/process-identity.js';
import { join } from 'node:path';

const shellLaunch = process.argv[2] === 'resume';
const root = shellLaunch ? process.env.TEST_ROOT! : process.argv[2];
const file = join(root, 's1.jsonl');
const terminal = (shellLaunch ? { coreId: 'core', terminalId: 't1', address: 't1', socket: join(root, 'socket'), sessionNamespace: 'test' } : { coreId: 'core-one', terminalId: 't1', address: 't1', socket: '/fixture/core.sock', sessionNamespace: 'fixture' }) as TerminalIdentity;
const owner = { sessionId: 's1', generation: 'g1', terminal, sessionFile: file, name: 'named session', cwd: root } as Owner;
const mode = process.argv[3] === 'rpc' ? 'rpc' : 'tui';
const context = { mode, sessionManager: { getSessionFile: () => file, getSessionId: () => 's1', getSessionName: () => 'named session' } } as unknown as ExtensionContext;
const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<unknown>>();
const pi = { on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<unknown>) => { handlers.set(name, handler); return () => handlers.delete(name); } } as unknown as ExtensionAPI;
const identity = { pid: process.pid, startIdentity: processStartTime(process.pid)! };
let active = true;
const state = shellLaunch ? join(root, 'herdr') : root;
const registry = createTerminalRegistry(state);
const startupRegistry = process.argv[4] === 'hold' ? { ...registry, record: async () => { process.send?.('starting'); await new Promise<void>(() => { setInterval(() => {}, 1000); }); } } : registry;
registerHerdrSessions(pi, {
  registry: startupRegistry, presence: createProcessPresence(state), leases: createSessionLeases(state),
  processes: async () => [], probe: async () => ({ kind: 'absent' }), processIdentity: identity,
  currentSession: () => ({ ...identity, sessionFile: file, sessionName: owner.name, kind: 'top-level', hcAddress: terminal.address }),
  owner: () => active ? owner : null, coreStartedAt: () => 1, launchEnvironment: { agentDirectory: join(root, 'agent'), extensionArguments: [] },
});
const fire = (name: string, event: unknown) => handlers.get(name)!(event, context);
await fire('session_start', { type: 'session_start', reason: 'startup' });
if (shellLaunch) { await fire('session_shutdown', { type: 'session_shutdown', reason: 'quit' }); process.exit(0); }
// Interactive pi prepends its signal handler; RPC appends it. Both dispose with reason 'quit'.
for (const signal of ['SIGTERM', 'SIGHUP'] as const) {
  const shutdown = () => { void fire('session_shutdown', { type: 'session_shutdown', reason: 'quit' }).then(() => process.exit(0)); };
  if (mode === 'tui') process.prependListener(signal, shutdown); else process.on(signal, shutdown);
}
process.on('message', message => {
  if (message === 'core-loss') active = false;
  if (typeof message === 'string') void fire('session_shutdown', { type: 'session_shutdown', reason: message === 'core-loss' ? 'quit' : message }).then(() => process.exit(0));
});
process.send?.('ready');

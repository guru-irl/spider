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

const root = process.argv[2];
const file = join(root, 's1.jsonl');
const terminal = { coreId: 'core-one', terminalId: 't1', address: 't1', socket: '/fixture/core.sock', sessionNamespace: 'fixture' } as TerminalIdentity;
const owner = { sessionId: 's1', generation: 'g1', terminal, sessionFile: file, name: 'named session', cwd: root } as Owner;
const context = { mode: 'tui', sessionManager: { getSessionFile: () => file, getSessionId: () => 's1', getSessionName: () => 'named session' } } as unknown as ExtensionContext;
const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<unknown>>();
const pi = { on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<unknown>) => { handlers.set(name, handler); return () => handlers.delete(name); } } as unknown as ExtensionAPI;
const identity = { pid: process.pid, startIdentity: processStartTime(process.pid)! };
registerHerdrSessions(pi, {
  registry: createTerminalRegistry(root), presence: createProcessPresence(root), leases: createSessionLeases(root),
  processes: async () => [], probe: async () => ({ kind: 'absent' }), processIdentity: identity,
  currentSession: () => ({ ...identity, sessionFile: file, sessionName: owner.name, kind: 'top-level', hcAddress: terminal.address }),
  owner: () => owner, coreStartedAt: () => 1, launchEnvironment: { agentDirectory: join(root, 'agent'), extensionArguments: [] },
});
const fire = (name: string, event: unknown) => handlers.get(name)!(event, context);
await fire('session_start', { type: 'session_start', reason: 'startup' });
// Pi prepends its signal handler after extensions start and disposes with reason 'quit'.
for (const signal of ['SIGTERM', 'SIGHUP'] as const) process.prependListener(signal, () => { void fire('session_shutdown', { type: 'session_shutdown', reason: 'quit' }).then(() => process.exit(0)); });
process.on('message', message => { if (message === 'quit' || message === 'reload') void fire('session_shutdown', { type: 'session_shutdown', reason: message }).then(() => process.exit(0)); });
process.send?.('ready');

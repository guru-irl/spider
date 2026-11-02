// SPDX-License-Identifier: MIT
import { afterEach, expect, test } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { Owner, ProcessPresence } from '../contracts.js';
import type { ProcessProbe } from '../sessions/lease.js';
import { registerHerdrSessions } from '../sessions/register.js';
import { createTerminalRegistry } from '../sessions/registry.js';
import { createProcessPresence } from '../sessions/presence.js';
import { createSessionLeases } from '../sessions/lease.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture(mode: ExtensionContext['mode'], kind: ProcessPresence['kind'] = 'top-level') {
  await mkdir(resolve('.spider/scratch/h'), { recursive: true });
  const root = await mkdtemp(resolve('.spider/scratch/h/mode-')); roots.push(root);
  const owner = { sessionId: 'interactive-session', generation: 'generation', cwd: root, sessionFile: null, name: 'interactive',
    terminal: { coreId: 'core', terminalId: 't1', address: 't1', socket: join(root, 'core.sock'), sessionNamespace: 'fixture' } } as Owner;
  const registry = createTerminalRegistry(root), presence = createProcessPresence(root);
  const environment = { agentDirectory: join(root, 'agent'), extensionArguments: [] };
  const handlers = new Map<string, Function>();
  const pi = { on: (name: string, handler: Function) => { handlers.set(name, handler); return () => handlers.delete(name); } } as unknown as ExtensionAPI;
  const ctx = { cwd: root, mode, hasUI: mode === 'tui' || mode === 'rpc', sessionManager: { getSessionId: () => 'candidate-session', getSessionFile: () => undefined } } as ExtensionContext;
  const candidate = { ...owner, sessionId: 'candidate-session' as Owner['sessionId'] };
  let ancestor: ProcessProbe = { kind: 'live', startIdentity: 'ancestor-start' };
  const registration = registerHerdrSessions(pi, { registry, presence, leases: createSessionLeases(root), processes: async () => [], probe: async pid => pid === process.ppid ? ancestor : { kind: 'absent' },
    processIdentity: { pid: process.pid, startIdentity: 'candidate-start' }, launchEnvironment: environment, coreStartedAt: () => 1, owner: () => candidate,
    currentSession: () => ({ pid: process.pid, startIdentity: 'candidate-start', sessionFile: null, sessionName: 'candidate', kind, hcAddress: owner.terminal.address }) });
  const seedOwner = async (recordPresence = true) => {
    await registry.record({ owner, recordedAt: 1, coreStartedAt: 1, environment });
    if (recordPresence) await presence.record({ pid: process.ppid, startIdentity: 'ancestor-start', sessionId: owner.sessionId, sessionFile: null, sessionName: 'interactive', kind: 'top-level', mode: 'tui', hcAddress: owner.terminal.address });
  };
  return { owner, registry, presence, registration, seedOwner, exitOwner: () => { ancestor = { kind: 'absent' }; }, reusePid: () => { ancestor = { kind: 'live', startIdentity: 'different-start' }; }, fire: (name: string) => handlers.get(name)!({}, ctx) };
}

test.each(['print', 'json'] as const)('%s top-level sessions never create or replace terminal mappings', async mode => {
  const f = await fixture(mode);
  try {
    await f.fire('session_start'); expect(await f.registry.list()).toEqual([]);
    await f.seedOwner(); const previous = await f.registry.get(f.owner.terminal);
    await f.fire('session_start'); await f.fire('session_info_changed');
    expect(await f.registry.get(f.owner.terminal)).toEqual(previous);
    expect((await f.presence.list()).some(record => record.sessionId === 'candidate-session' && record.mode === mode)).toBe(true);
  } finally { await f.registration.dispose(); }
});

test.each(['tui', 'rpc'] as const)('a nonnested %s top-level session records and replaces terminal mappings', async mode => {
  const f = await fixture(mode);
  try {
    await f.fire('session_start'); expect((await f.registry.get(f.owner.terminal))?.owner.sessionId).toBe('candidate-session');
    await f.seedOwner(false); await f.fire('session_info_changed');
    expect((await f.registry.get(f.owner.terminal))?.owner.sessionId).toBe('candidate-session');
  } finally { await f.registration.dispose(); }
});

test.each(['tui', 'rpc'] as const)('a %s descendant of the live mapped TUI owner cannot replace its terminal mapping', async mode => {
  const f = await fixture(mode);
  try {
    await f.seedOwner(); const previous = await f.registry.get(f.owner.terminal);
    await f.fire('session_start'); expect(await f.registry.get(f.owner.terminal)).toEqual(previous);
    await f.fire('session_info_changed'); expect(await f.registry.get(f.owner.terminal)).toEqual(previous);
  } finally { await f.registration.dispose(); }
});

test.each(['tui', 'rpc'] as const)('a nested %s session may take over after the mapped owner exits', async mode => {
  const f = await fixture(mode);
  try {
    await f.seedOwner(); f.exitOwner(); await f.fire('session_start');
    expect((await f.registry.get(f.owner.terminal))?.owner.sessionId).toBe('candidate-session');
  } finally { await f.registration.dispose(); }
});

test('a reused ancestor PID does not hold the mapped terminal', async () => {
  const f = await fixture('rpc');
  try {
    await f.seedOwner(); f.reusePid(); await f.fire('session_start');
    expect((await f.registry.get(f.owner.terminal))?.owner.sessionId).toBe('candidate-session');
  } finally { await f.registration.dispose(); }
});

test.each(['tui', 'rpc'] as const)('a %s child never records a terminal mapping', async mode => {
  const f = await fixture(mode, 'child');
  try { await f.fire('session_start'); expect(await f.registry.list()).toEqual([]); }
  finally { await f.registration.dispose(); }
});

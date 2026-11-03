// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rename, rm, symlink, writeFile, chmod, access } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { Owner, SessionId, Generation, TerminalIdentity } from '../contracts.js';
import { createTerminalRegistry, withProcessLock, hash, jsonFiles } from '../sessions/registry.js';
import { createProcessPresence } from '../sessions/presence.js';
import { createSessionLeases, assessSessionLiveness, type ProcessInventoryPorts, type ProcessProbe } from '../sessions/lease.js';
import { launchSession, type SessionLaunchPorts } from '../sessions/launcher.js';
import { registerHerdrSessions } from '../sessions/register.js';
import { build } from 'vite';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { configFixtureCwd } from '../../../host/src/__tests__/herdr-config-fixture.js';
import { processStartTime } from '../../../subagents/src/process-identity.js';
let root: string;
const terminal = { coreId: 'core-one', terminalId: 't1', address: 't1', socket: '/fixture/core.sock', sessionNamespace: 'fixture' } as TerminalIdentity;
const probes = new Map<number, ProcessProbe>();
let ports: SessionLaunchPorts;
let inv: ProcessInventoryPorts;
let opened: { file: string; env: NodeJS.ProcessEnv; argv: readonly string[] }[];
function owner(file: string | null): Owner { return { sessionId: 's1' as SessionId, generation: 'g1' as Generation, terminal, sessionFile: file, name: 'named session', cwd: root }; }
function inventory(): ProcessInventoryPorts { return { presence: createProcessPresence(root), leases: createSessionLeases(root), processes: async () => [], probe: async pid => probes.get(pid) ?? { kind: 'absent' } }; }
beforeEach(async () => {
  await mkdir(resolve('.spider/scratch/h'), { recursive: true }); root = await mkdtemp(resolve('.spider/scratch/h/g1-')); probes.clear(); opened = [];
  inv = inventory(); ports = { leases: inv.leases, processInventory: inv, processIdentity: { pid: 101, startIdentity: 'start:101' }, publishMapping: async () => {}, env: { API_TOKEN: 'secret', SPIDER_HERDR_LEASE_TOKEN: 'inherited', SPIDER_HERDR_SSH_BYPASS: '1', PATH: '/safe' },
    spawnPi: async request => { opened.push({ file: request.sessionFile, env: request.env, argv: request.argv }); probes.set(102, { kind: 'live', startIdentity: 'start:102' }); return { pid: 102, startIdentity: 'start:102' }; } };
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });
async function session(id = 's1') { const file = join(root, `${id}.jsonl`); await writeFile(file, JSON.stringify({ type: 'session', version: 3, id, cwd: root }) + '\n'); return file; }
function request(file: string) { return { sessionFile: file, sessionId: 's1' as SessionId, cwd: root, environment: { agentDirectory: join(root, 'agent'), extensionArguments: [] } }; }
describe('session ownership', () => {
  it('a reused PID leaves the dead session resumable and its presence is pruned', async () => {
    const file = await session(); await createTerminalRegistry(root).record({ owner: owner(file), recordedAt: 1, coreStartedAt: 1, environment: request(file).environment });
    await inv.presence.record({ pid: 100, startIdentity: 'old', sessionFile: file, sessionName: 'named session', kind: 'top-level', mode: 'tui', hcAddress: terminal.address });
    probes.set(100, { kind: 'live', startIdentity: 'reused' });
    expect(await assessSessionLiveness(file, inv)).toMatchObject({ kind: 'free' });
    await expect(launchSession(request(file), ports)).resolves.toMatchObject({ sessionFile: file });
    expect({ presence: await inv.presence.list(), files: opened.map(row => row.file) }).toEqual({ presence: [], files: [file] });
  });
  it('symlink aliases share one lease and a live writer blocks without an open fd', async () => {
    const file = await session(); const alias = join(root, 'alias.jsonl'); await symlink(file, alias);
    probes.set(101, { kind: 'live', startIdentity: 'start:101' });
    const lease = await inv.leases.claim(file, { pid: 101, startIdentity: 'start:101' }, inv);
    expect(await inv.leases.get(alias)).toMatchObject({ file });
    await expect(launchSession(request(alias), ports)).rejects.toMatchObject({ code: 'session-may-be-live' });
    await inv.leases.release(alias, 'foreign'); expect(await inv.leases.get(file)).not.toBeNull();
    await inv.leases.release(alias, lease.token); expect(await inv.leases.get(file)).toBeNull();
  });
  it('claims before pi opens, transfers the token and strips inherited capabilities', async () => {
    const file = await session(); const result = await launchSession(request(file), ports);
    expect(opened[0].argv).toEqual(['pi', '--session', file]);
    expect(opened[0].env).toMatchObject({ PI_CODING_AGENT_DIR: join(root, 'agent'), PATH: '/safe' });
    expect(opened[0].env.SPIDER_HERDR_SSH_BYPASS).toBeUndefined(); expect(opened[0].env.SPIDER_HERDR_LEASE_TOKEN).not.toBe('inherited');
    expect(await inv.leases.get(file)).toMatchObject({ pid: 102, startIdentity: 'start:102', token: result.token });
    await expect(launchSession(request(file), ports)).rejects.toMatchObject({ code: 'session-may-be-live' });
  });
  it('missing files and mismatched IDs never launch', async () => {
    await expect(launchSession(request(join(root, 'missing')), ports)).rejects.toMatchObject({ code: 'session-file-invalid' });
    await expect(launchSession(request(await session('other')), ports)).rejects.toMatchObject({ code: 'session-id-mismatch' }); expect(opened).toEqual([]);
  });
  it('terminal mappings replace new/resume/fork without touching another core or storing secrets', async () => {
    const registry = createTerminalRegistry(root); const file = await session();
    await registry.record({ owner: owner(file), recordedAt: 1, coreStartedAt: 1, environment: request(file).environment });
    const other = { ...terminal, coreId: 'core-two' as TerminalIdentity['coreId'], socket: '/fixture/other.sock' };
    await registry.record({ owner: { ...owner(file), terminal: other }, recordedAt: 1, coreStartedAt: 1, environment: request(file).environment });
    for (const id of ['new', 'resumed', 'forked']) await registry.record({ owner: { ...owner(file), sessionId: id as SessionId }, recordedAt: 2, coreStartedAt: 1, environment: request(file).environment });
    expect((await registry.get(terminal))?.owner.sessionId).toBe('forked'); expect((await registry.get(other))?.owner.sessionId).toBe('s1');
    expect(await registry.list()).toHaveLength(2); expect(JSON.stringify(await registry.list())).not.toMatch(/secret|API_TOKEN|--model/);
  });
  it('reclaims only a proved absent lease holder, not unknown identity', async () => {
    const file = await session(); probes.set(101, { kind: 'live', startIdentity: 'start:101' });
    await inv.leases.claim(file, { pid: 101, startIdentity: 'start:101' }, inv);
    probes.set(101, { kind: 'unknown' }); await expect(launchSession(request(file), ports)).rejects.toMatchObject({ code: 'session-may-be-live' });
    probes.set(101, { kind: 'absent' }); await launchSession(request(file), ports); expect(opened).toHaveLength(1);
  });
  it('a recorded absolute extension argument refuses launch instead of replaying it', async () => {
    const file = await session(); const foreign = join(root, 'foreign-extension.js');
    await expect(launchSession({ ...request(file), environment: { agentDirectory: join(root, 'agent'), extensionArguments: ['--extension', foreign] } }, ports)).rejects.toMatchObject({ code: 'session-explicit-extensions', message: expect.stringContaining(foreign) });
    expect(opened).toEqual([]);
  });
});
function apiFixture() {
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<unknown>>();
  const pi = { on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<unknown>) => { handlers.set(name, handler); return () => handlers.delete(name); } } as unknown as ExtensionAPI;
  return { pi, fire: (name: string, event: unknown, ctx: ExtensionContext) => handlers.get(name)!(event, ctx) };
}
function context(file: string | null, mode: string, name = 'named session', sessionId = 's1') { return { cwd: root, mode, hasUI: mode === 'tui', sessionManager: { getSessionFile: () => file ?? undefined, getSessionId: () => sessionId, getSessionName: () => name } } as unknown as ExtensionContext; }
it('every spider-loading pi process records named presence', async () => {
  const file = join(root, 'unflushed.jsonl');
  for (const [pid, child, enabled, hc, mode] of [[200, false, true, true, 'tui'], [201, false, true, false, 'tui'], [202, false, false, true, 'tui'], [203, true, true, true, 'rpc']] as const) {
    const api = apiFixture(); const registration = registerHerdrSessions(api.pi, { ...inventory(), registry: createTerminalRegistry(root), processIdentity: { pid, startIdentity: `start:${pid}` }, currentSession: () => ({ pid, startIdentity: `start:${pid}`, sessionFile: file, sessionName: 'named session', kind: child ? 'child' : 'top-level', hcAddress: hc ? terminal.address : null }), owner: () => hc && !child && enabled ? owner(file) : null, coreStartedAt: () => 1, launchEnvironment: request(file).environment });
    await api.fire('session_start', { reason: 'startup' }, context(file, mode)); await api.fire('session_start', { reason: 'reload' }, context(file, mode));
    const records = await readdir(join(root, 'processes')); expect(records.filter(n => n.startsWith(`${pid}-`))).toHaveLength(1);
    const record = JSON.parse(await readFile(join(root, 'processes', records.find(n => n.startsWith(`${pid}-`))!), 'utf8'));
    expect(record).toMatchObject({ pid, startIdentity: `start:${pid}`, sessionFile: file, sessionName: 'named session', kind: child ? 'child' : 'top-level', mode });
    await api.fire('session_shutdown', { reason: 'quit' }, context(file, mode)); expect((await inventory().presence.list()).some(r => r.pid === pid)).toBe(false); await registration.dispose();
  }
  await expect(readFile(file)).rejects.toMatchObject({ code: 'ENOENT' });
  expect((await createTerminalRegistry(root).get(terminal))?.owner.sessionFile).toBe(file);
});
it('nonpersistent presence has no lease or resume target and shutdown retains the last mapping', async () => {
  const api = apiFixture(); const registration = registerHerdrSessions(api.pi, { ...inventory(), registry: createTerminalRegistry(root), processIdentity: { pid: 300, startIdentity: 'start:300' }, currentSession: () => ({ pid: 300, startIdentity: 'start:300', sessionFile: null, sessionName: 'named session', kind: 'top-level', hcAddress: null }), owner: () => owner(null), coreStartedAt: () => 1, launchEnvironment: request('unused').environment });
  await api.fire('session_start', { reason: 'new' }, context(null, 'tui')); expect(await inventory().presence.list()).toMatchObject([{ sessionFile: null }]);
  expect(await createTerminalRegistry(root).get(terminal)).toMatchObject({ owner: { sessionFile: null } });
  await api.fire('session_shutdown', { reason: 'quit' }, context(null, 'tui')); expect(await createTerminalRegistry(root).get(terminal)).not.toBeNull(); await registration.dispose();
});

it('a supported resume switch holds the target lease across runtime shutdown', async () => {
  const file = await session(); const target = await session('target'); const api = apiFixture(); const current = { file };
  probes.set(300, { kind: 'live', startIdentity: 'start:300' });
  const registration = registerHerdrSessions(api.pi, { ...inventory(), registry: createTerminalRegistry(root), processIdentity: { pid: 300, startIdentity: 'start:300' }, currentSession: () => ({ pid: 300, startIdentity: 'start:300', sessionFile: current.file, sessionName: 'switching', kind: 'top-level', hcAddress: null }), owner: () => null, coreStartedAt: () => 1, launchEnvironment: request(file).environment });
  await api.fire('session_start', { reason: 'startup' }, context(file, 'tui'));
  await api.fire('session_before_switch', { reason: 'resume', targetSessionFile: target }, context(file, 'tui'));
  await api.fire('session_shutdown', { reason: 'resume', targetSessionFile: target }, context(file, 'tui'));
  expect(await assessSessionLiveness(target, inventory())).toMatchObject({ kind: 'live' });
  await registration.dispose(); expect(await assessSessionLiveness(target, inventory())).toMatchObject({ kind: 'live' });
  // The destination activation belongs to this same process, and claims its own reserved path.
  const next = apiFixture(); current.file = target;
  const resumed = registerHerdrSessions(next.pi, { ...inventory(), registry: createTerminalRegistry(root), processIdentity: { pid: 300, startIdentity: 'start:300' }, currentSession: () => ({ pid: 300, startIdentity: 'start:300', sessionFile: target, sessionName: 'switching', kind: 'top-level', hcAddress: null }), owner: () => null, coreStartedAt: () => 1, launchEnvironment: request(file).environment });
  await next.fire('session_start', { reason: 'resume' }, context(target, 'tui', 'named session', 's2')); await next.fire('session_shutdown', { reason: 'quit' }, context(target, 'tui', 'named session', 's2')); await resumed.dispose();
  expect(await assessSessionLiveness(target, inventory())).toEqual({ kind: 'free' });
});
it('a launcher-started session keeps its reservation through reload and releases it on quit', async () => {
  const file = await session();
  await launchSession(request(file), ports);
  const env = opened[0].env;
  const makeRegistration = () => {
    const api = apiFixture();
    const registration = registerHerdrSessions(api.pi, { ...inv, registry: createTerminalRegistry(root),
      processIdentity: { pid: 102, startIdentity: 'start:102' }, env,
      currentSession: () => ({ pid: 102, startIdentity: 'start:102', sessionFile: file, sessionName: 'planner', kind: 'top-level', hcAddress: terminal.address }),
      owner: () => owner(file), coreStartedAt: () => 1, launchEnvironment: request(file).environment });
    return { ...api, registration };
  };
  const first = makeRegistration();
  await first.fire('session_start', { reason: 'startup' }, context(file, 'tui'));
  expect(await inv.leases.get(file)).toMatchObject({ pid: 102, startIdentity: 'start:102' });
  await first.fire('session_shutdown', { reason: 'reload' }, context(file, 'tui'));
  await first.registration.dispose();
  await expect(launchSession(request(file), ports)).rejects.toMatchObject({ code: 'session-may-be-live' });
  const second = makeRegistration();
  await expect(second.fire('session_start', { reason: 'reload' }, context(file, 'tui'))).resolves.toBeUndefined();
  expect(await assessSessionLiveness(file, inv)).toMatchObject({ kind: 'live' });
  await second.fire('session_shutdown', { reason: 'quit' }, context(file, 'tui'));
  await second.registration.dispose();
  expect(await inv.leases.get(file)).toBeNull();
});
it('a launcher-started session takes a fresh lease when an earlier build removed it at reload, and keeps it through later reloads', async () => {
  const file = await session();
  await launchSession(request(file), ports);
  const env = opened[0].env;
  const makeRegistration = () => {
    const api = apiFixture();
    const registration = registerHerdrSessions(api.pi, { ...inv, registry: createTerminalRegistry(root),
      processIdentity: { pid: 102, startIdentity: 'start:102' }, env,
      currentSession: () => ({ pid: 102, startIdentity: 'start:102', sessionFile: file, sessionName: 'planner', kind: 'top-level', hcAddress: terminal.address }),
      owner: () => owner(file), coreStartedAt: () => 1, launchEnvironment: request(file).environment });
    return { ...api, registration };
  };
  const first = makeRegistration();
  await first.fire('session_start', { reason: 'startup' }, context(file, 'tui'));
  // Earlier builds released the lease when the extension shut down for a reload, as they do on quit.
  await first.fire('session_shutdown', { reason: 'quit' }, context(file, 'tui'));
  await first.registration.dispose();
  expect(await inv.leases.get(file)).toBeNull();
  for (const reload of [1, 2]) {
    const next = makeRegistration();
    await expect(next.fire('session_start', { reason: 'reload' }, context(file, 'tui')), `reload ${reload}`).resolves.toBeUndefined();
    expect(await inv.leases.get(file)).toMatchObject({ pid: 102, startIdentity: 'start:102' });
    expect(await assessSessionLiveness(file, inv)).toMatchObject({ kind: 'live' });
    expect((await createTerminalRegistry(root).get(terminal))?.owner.sessionFile).toBe(file);
    await next.fire('session_shutdown', { reason: reload === 1 ? 'reload' : 'quit' }, context(file, 'tui'));
    await next.registration.dispose();
    if (reload === 1) expect(await inv.leases.get(file), 'the lease survives the reload shutdown').toMatchObject({ pid: 102, startIdentity: 'start:102' });
  }
  expect(await inv.leases.get(file)).toBeNull();
});
it('a launcher-started session with Herdr inactive still records its lease after an earlier build removed it', async () => {
  const file = await session();
  await launchSession(request(file), ports);
  const env = opened[0].env;
  const register = (active: boolean) => {
    const api = apiFixture();
    const registration = registerHerdrSessions(api.pi, { ...inv, registry: createTerminalRegistry(root),
      processIdentity: { pid: 102, startIdentity: 'start:102' }, env,
      currentSession: () => ({ pid: 102, startIdentity: 'start:102', sessionFile: file, sessionName: 'planner', kind: 'top-level', hcAddress: active ? terminal.address : null }),
      owner: () => active ? owner(file) : null, coreStartedAt: () => 1, launchEnvironment: request(file).environment });
    return { ...api, registration };
  };
  const first = register(true);
  await first.fire('session_start', { reason: 'startup' }, context(file, 'tui'));
  await first.fire('session_shutdown', { reason: 'quit' }, context(file, 'tui'));
  await first.registration.dispose();
  expect(await inv.leases.get(file)).toBeNull();
  const inactive = register(false);
  await expect(inactive.fire('session_start', { reason: 'reload' }, context(file, 'tui'))).resolves.toBeUndefined();
  expect(await inv.leases.get(file)).toMatchObject({ pid: 102, startIdentity: 'start:102' });
  await inactive.fire('session_shutdown', { reason: 'quit' }, context(file, 'tui'));
  await inactive.registration.dispose();
  expect(await inv.leases.get(file)).toBeNull();
});
it('a launcher-started session never takes the lease of another live process', async () => {
  const file = await session();
  await launchSession(request(file), ports);
  const env = opened[0].env;
  probes.set(500, { kind: 'live', startIdentity: 'start:500' });
  await inv.leases.claim(file, { pid: 500, startIdentity: 'start:500' }, inv, { mode: 'bookkeeping' });
  const api = apiFixture();
  const registration = registerHerdrSessions(api.pi, { ...inv, registry: createTerminalRegistry(root),
    processIdentity: { pid: 102, startIdentity: 'start:102' }, env,
    currentSession: () => ({ pid: 102, startIdentity: 'start:102', sessionFile: file, sessionName: 'planner', kind: 'top-level', hcAddress: terminal.address }),
    owner: () => owner(file), coreStartedAt: () => 1, launchEnvironment: request(file).environment });
  await expect(api.fire('session_start', { reason: 'startup' }, context(file, 'tui'))).rejects.toMatchObject({ code: 'session-may-be-live' });
  expect(await inv.leases.get(file)).toMatchObject({ pid: 500, startIdentity: 'start:500' });
  await registration.dispose();
  expect(await inv.leases.get(file)).toMatchObject({ pid: 500, startIdentity: 'start:500' });
});

it('the receiving process can adopt the launcher token before its spawn reply returns', async () => {
  const file = await session(); const lease = await inv.leases.claim(file, { pid: 101, startIdentity: 'start:101' }, inv);
  const adopted = await inv.leases.adopt(file, lease.token, { pid: 102, startIdentity: 'start:102' });
  expect(adopted).toMatchObject({ pid: 102, startIdentity: 'start:102' });
  await expect(inv.leases.adopt(file, 'forged', { pid: 103, startIdentity: 'start:103' })).rejects.toMatchObject({ code: 'lease-token-invalid' });
});

it('private registry readers reject symlinked state directories', async () => {
  const registry = createTerminalRegistry(root); const file = await session();
  await registry.record({ owner: owner(file), recordedAt: 1, coreStartedAt: 1, environment: request(file).environment });
  await rename(join(root, 'terminals'), join(root, 'elsewhere.invalid')); await symlink(join(root, 'elsewhere.invalid'), join(root, 'terminals'));
  await expect(registry.get(terminal)).rejects.toMatchObject({ code: 'unsafe-state-path' });
});
it('concurrent lock actors serialize one shared writer without sharing their intent files', async () => {
  const events: string[] = []; let release!: () => void; let started!: () => void;
  const gate = new Promise<void>(resolve => release = resolve); const entered = new Promise<void>(resolve => started = resolve);
  const first = withProcessLock(root, 'shared', async () => { events.push('first-start'); started(); await gate; events.push('first-end'); });
  await entered; const second = withProcessLock(root, 'shared', async () => { events.push('second'); });
  await new Promise(resolve => setTimeout(resolve, 30));
  try { expect(events).toEqual(['first-start']); } finally { release(); await Promise.all([first, second]); }
  expect(events).toEqual(['first-start', 'first-end', 'second']);
});

it('a structurally extended owner cannot smuggle secrets or model flags into the terminal map', async () => {
  const file = await session(); const extended = { ...owner(file), terminal: { ...terminal, API_TOKEN: 'secret', argv: ['--model', 'private-model'] } };
  const registry = createTerminalRegistry(root); await registry.record({ owner: extended, recordedAt: 1, coreStartedAt: 1, environment: request(file).environment });
  expect(JSON.stringify(await registry.get(terminal))).not.toMatch(/secret|API_TOKEN|--model|private-model/);
});

it('inactive registration observes a reused PID without refusing ordinary pi startup', async () => {
  const file = await session(); probes.set(300, { kind: 'live', startIdentity: 'old-start' });
  await inv.leases.claim(file, { pid: 300, startIdentity: 'old-start' }, inv);
  probes.set(300, { kind: 'live', startIdentity: 'new-start' }); const api = apiFixture();
  const registration = registerHerdrSessions(api.pi, { ...inventory(), registry: createTerminalRegistry(root), processIdentity: { pid: 300, startIdentity: 'new-start' }, currentSession: () => ({ pid: 300, startIdentity: 'new-start', sessionFile: file, sessionName: 'new process', kind: 'top-level', hcAddress: null }), owner: () => null, coreStartedAt: () => 1, launchEnvironment: request(file).environment });
  await expect(api.fire('session_start', { reason: 'startup' }, context(file, 'tui'))).resolves.toBeUndefined();
  expect(await inv.leases.get(file)).toMatchObject({ startIdentity: 'new-start' }); await registration.dispose();
});

it('a crashed lock actor is reclaimed only after absence, never after PID reuse', async () => {
  const source = join(root, 'crash.ts');
  await writeFile(source, `import { withProcessLock } from ${JSON.stringify(fileURLToPath(new URL('../sessions/registry.ts', import.meta.url)))}; await withProcessLock(${JSON.stringify(root)},'crash',async()=>process.exit(77));`);
  await build({ configFile: false, logLevel: 'silent', resolve: { alias: { '@spider/db-core': fileURLToPath(new URL('../../../db-core/src/command-env.ts', import.meta.url)) } }, build: { ssr: source, outDir: root, emptyOutDir: false, rollupOptions: { output: { entryFileNames: 'crash.mjs' } } } });
  const child = spawn(process.execPath, [join(root, 'crash.mjs')], { env: { ...process.env, HOME: root, TMPDIR: root, SPIDER_GLOBAL_ROOT: join(root, 'global') }, stdio: 'ignore' });
  const code = await new Promise<number | null>((resolveRun, reject) => { child.once('error', reject); child.once('close', resolveRun); }); expect(code).toBe(77);
  const directory = join(root, 'locks', hash('crash')); expect(await jsonFiles(directory)).toHaveLength(1);
  await expect(withProcessLock(root, 'crash', async () => {}, { probe: async pid => pid === child.pid ? { kind: 'live', startIdentity: 'reused' } : { kind: 'live', startIdentity: processStartTime(pid)! } })).rejects.toMatchObject({ code: 'lock-owner-uncertain' });
  expect(await jsonFiles(directory)).toHaveLength(1);
  let ran = false; await withProcessLock(root, 'crash', async () => { ran = true; }); expect(ran).toBe(true);
  expect(await jsonFiles(directory)).toEqual([]);
});

it.each([['-e', 'relative-extension.js'], ['--no-extensions'], ['--extension=/absolute/extension.js']])('records explicit extension arguments for refusal, never replay: %j', async (...arguments_) => {
  const file = await session(); const environment = { agentDirectory: root, extensionArguments: arguments_ };
  const registry = createTerminalRegistry(root); await registry.record({ owner: owner(file), recordedAt: 1, coreStartedAt: 1, environment });
  expect((await registry.get(terminal))?.environment.extensionArguments).toEqual(arguments_);
  await expect(launchSession({ ...request(file), environment }, ports)).rejects.toMatchObject({ code: 'session-explicit-extensions', message: expect.stringContaining(arguments_[0]) }); expect(opened).toEqual([]);
});
it('a recorded launch environment cannot store model flags as extension diagnostics', async () => {
  const file = await session(); await expect(createTerminalRegistry(root).record({ owner: owner(file), recordedAt: 1, coreStartedAt: 1, environment: { agentDirectory: root, extensionArguments: ['--model', 'unwanted-model'] } })).rejects.toMatchObject({ code: 'launch-environment-invalid' });
});

async function switchingRegistration(pid: number, file: string, active: boolean, warnings: string[]) {
  probes.set(pid, { kind: 'live', startIdentity: `start:${pid}` }); const api = apiFixture();
  const registration = registerHerdrSessions(api.pi, { ...inv, registry: createTerminalRegistry(root), processIdentity: { pid, startIdentity: `start:${pid}` }, currentSession: () => ({ pid, startIdentity: `start:${pid}`, sessionFile: file, sessionName: 'current', kind: 'top-level', hcAddress: active ? terminal.address : null }), owner: () => active ? owner(file) : null, active: () => active, warn: message => warnings.push(message), coreStartedAt: () => 1, launchEnvironment: request(file).environment });
  return { ...api, registration };
}
it('inactive bookkeeping never cancels two processes using the same saved session', async () => {
  const file = await session(); const warnings: string[] = [], first = await switchingRegistration(301, file, false, warnings), second = await switchingRegistration(302, file, false, warnings);
  try {
    await first.fire('session_start', {}, context(file, 'tui')); await second.fire('session_start', {}, context(file, 'tui'));
    expect(await first.fire('session_before_switch', { targetSessionFile: file }, context(file, 'tui'))).not.toMatchObject({ cancel: true });
    expect(await second.fire('session_before_switch', { targetSessionFile: file }, context(file, 'tui'))).not.toMatchObject({ cancel: true });
    expect((await inv.presence.list()).map(r => r.pid).sort()).toEqual([301, 302]); expect(warnings).toEqual([]);
  } finally { await first.registration.dispose(); await second.registration.dispose(); }
});
it('active everyday switching ignores unrelated unrecorded pi', async () => {
  const current = await session(), target = await session('target'), warnings: string[] = [];
  inv.processes = async () => [{ pid: 999, startIdentity: 'unknown', classification: 'pi' }];
  const f = await switchingRegistration(301, current, true, warnings);
  try {
    await f.fire('session_start', {}, context(current, 'tui'));
    expect(await f.fire('session_before_switch', { targetSessionFile: target }, context(current, 'tui'))).not.toMatchObject({ cancel: true });
    expect(await inv.leases.get(target)).toMatchObject({ pid: 301 }); expect(warnings.length).toBeLessThanOrEqual(1);
  } finally { await f.registration.dispose(); }
});
it('active switching refuses a target held by another recorded live process with repair advice', async () => {
  const current = await session(), target = await session('target'), warnings: string[] = [];
  probes.set(302, { kind: 'live', startIdentity: 'start:302' }); await inv.presence.record({ pid: 302, startIdentity: 'start:302', sessionFile: target, sessionId: 'target' as SessionId, sessionName: 'target', kind: 'top-level', hcAddress: null });
  const f = await switchingRegistration(301, current, true, warnings);
  try {
    await f.fire('session_start', {}, context(current, 'tui'));
    expect(await f.fire('session_before_switch', { targetSessionFile: target }, context(current, 'tui'))).toMatchObject({ cancel: true });
    expect(warnings).toEqual(["Spider couldn't open that session because it may already be open elsewhere. Check for another pi session with it open, then close that session and try again."]);
  } finally { await f.registration.dispose(); }
});

it('the production CLI distinguishes everyday resume from internal cutover checks', async () => {
  const { createProductionHerdrCliPorts } = await import('../../../host/src/herdr/ports.js'); const { runHerdrCli } = await import('../setup/cli.js');
  const file = await session(), bin = join(root, 'bin'); await mkdir(bin);
  await writeFile(join(bin, 'ps'), '#!/bin/sh\nif [ "$1" = -U ]; then printf "999 pi pi\\n"; exit 0; fi\nexec /bin/ps "$@"\n'); await chmod(join(bin, 'ps'), 0o700);
  await writeFile(join(bin, 'pi'), `#!/bin/sh\nexec ${process.execPath} -e 'setTimeout(()=>process.exit(0),200)'\n`); await chmod(join(bin, 'pi'), 0o700);
  vi.stubEnv('PATH', bin + ':' + dirname(process.execPath) + ':' + process.env.PATH);
  const configPath = join(root, 'config.json'); await writeFile(configPath, JSON.stringify({ enabled: true, app: { binary: join(root, 'unused-app'), home: join(root, 'app') }, core: { binary: join(root, 'unused-hc'), config: join(root, 'core.toml') }, agentDirectory: join(root, 'agent'), globalRoot: root, shellRc: join(root, 'rc'), spaces: [], machines: [] }));
  vi.stubEnv('SPIDER_GLOBAL_ROOT', root);
  vi.stubEnv('PI_CODING_AGENT_DIR', join(root, 'agent'));
  execFileSync('git', ['init', '-q', root]);
  const cli = configFixtureCwd(createProductionHerdrCliPorts(root, process.env), root), errors: string[] = []; cli.stderr = message => errors.push(message);
  const args = ['resume', '--config', configPath, '--file', file, '--session-id', 's1', '--cwd', root];
  try {
    expect((await cli.doctorParts(await cli.request(configPath))).globalRoot).toBe(root);
    expect(await runHerdrCli(args, cli), errors.join('\n')).toBe(0); expect(errors).toEqual([]);
    expect(await runHerdrCli([...args, '--cutover'], cli)).toBe(1); expect(errors.join('\n')).toContain('session-may-be-live');
    expect(await runHerdrCli([...args, '--cutover', '--cutover'], cli)).toBe(2);
  } finally { await cli.dispose(); }
});

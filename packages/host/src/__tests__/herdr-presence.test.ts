import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createProcessPresence } from '@spider/herdr/sessions/presence';
import { createSessionLeases, inventorySnapshot, recordedSessionLiveness, type ProcessInventoryPorts, type ProcessProbe } from '@spider/herdr/sessions/lease';
import { offerResume } from '@spider/herdr/sessions/resume';
import { createTerminalRegistry } from '@spider/herdr/sessions/registry';
import { launchSession } from '@spider/herdr/sessions/launcher';
import type { Owner, SessionId } from '@spider/herdr';
import { createProcessInventory } from '../herdr/ports.js';

let processRows = '';
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFileSync: (...args: Parameters<typeof actual.execFileSync>) => args[0] === 'ps' && args[1]?.[0] === '-U' ? processRows : actual.execFileSync(...args) };
});
let root: string, file: string, inventory: ProcessInventoryPorts;
const probes = new Map<number, ProcessProbe>();
beforeEach(async () => {
  await mkdir(resolve('.spider/scratch'), { recursive: true });
  root = await mkdtemp(resolve('.spider/scratch/presence-')); file = join(root, 'session.jsonl'); probes.clear();
  await writeFile(file, JSON.stringify({ type: 'session', version: 3, id: 'saved', cwd: root }) + '\n');
  inventory = { presence: createProcessPresence(root), leases: createSessionLeases(root), processes: async () => [], probe: async pid => probes.get(pid) ?? { kind: 'absent' } };
});
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });
async function record(pid: number, startIdentity: string, sessionFile: string | null = file, sessionId: SessionId | null = 'saved' as SessionId) {
  await inventory.presence.record({ pid, startIdentity, sessionFile, sessionId, sessionName: null, kind: 'child', mode: 'rpc', hcAddress: null });
}
function owner(): Owner { return { sessionId: 'saved' as SessionId, generation: 'old-generation', sessionFile: file, cwd: root, name: 'saved session', terminal: { coreId: 'core', terminalId: 't1', address: 't1', socket: join(root, 'core.sock'), sessionNamespace: 'fixture' } } as Owner; }

test.each(['absent', 'reused'] as const)('inventory prunes %s process presence from disk', async kind => {
  await record(301, 'old'); if (kind === 'reused') probes.set(301, { kind: 'live', startIdentity: 'new' });
  expect(await inventorySnapshot(inventory)).toEqual({ records: [], uncertainPids: [], unknownPids: [] });
  expect(await readdir(join(root, 'processes'))).toEqual([]);
});

test('a core-restart resume offer survives stale presence and an unrelated unrecorded pi', async () => {
  const o = owner(); await createTerminalRegistry(root).record({ owner: o, recordedAt: 10, coreStartedAt: 1, environment: { agentDirectory: join(root, 'agent'), extensionArguments: [] } });
  await record(301, 'old'); probes.set(301, { kind: 'live', startIdentity: 'reused' });
  probes.set(302, { kind: 'live', startIdentity: 'unrelated' });
  inventory.processes = async () => [{ pid: 302, startIdentity: 'unrelated', classification: 'pi' }];
  const offer = await offerResume(o.terminal, { registry: createTerminalRegistry(root), processInventory: inventory, coreStartedAt: async () => 20 });
  expect(offer).toMatchObject({ sessionFile: file, sessionId: 'saved' });
  expect(await inventory.presence.list()).toEqual([]);
});

test('an identity-matched live pi holds its session and gets no resume offer', async () => {
  const o = owner(); await createTerminalRegistry(root).record({ owner: o, recordedAt: 10, coreStartedAt: 1, environment: { agentDirectory: join(root, 'agent'), extensionArguments: [] } });
  await record(301, 'live'); probes.set(301, { kind: 'live', startIdentity: 'live' });
  expect(await offerResume(o.terminal, { registry: createTerminalRegistry(root), processInventory: inventory, coreStartedAt: async () => 20 })).toBeNull();
  expect(await recordedSessionLiveness(file, inventory, o.sessionId)).toEqual({ kind: 'live', pids: [301] });
});

test('everyday resume prunes stale child presence while ignoring unrelated pi processes', async () => {
  await record(301, 'old'); probes.set(301, { kind: 'live', startIdentity: 'reused' });
  inventory.processes = async () => [{ pid: 302, startIdentity: 'unrelated', classification: 'pi' }];
  let spawned = false;
  await launchSession({ sessionFile: file, sessionId: 'saved' as SessionId, cwd: root, environment: { agentDirectory: join(root, 'agent'), extensionArguments: [] } }, {
    processInventory: inventory, leases: inventory.leases, processIdentity: { pid: process.pid, startIdentity: 'launcher' }, leasePolicy: { mode: 'switch' }, env: {},
    spawnPi: async () => { spawned = true; return { pid: 303, startIdentity: 'launched' }; },
  });
  expect(spawned).toBe(true); expect(await inventory.presence.list()).toEqual([]);
});

test('an unreadable recorded target stays uncertain during everyday resume', async () => {
  await record(301, 'old'); probes.set(301, { kind: 'unknown' });
  expect(await recordedSessionLiveness(file, inventory, 'saved' as SessionId)).toEqual({ kind: 'uncertain', pids: [301] });
  expect(await inventory.presence.list()).toHaveLength(1);
});

test('a pending launch lease holds only its own target before presence is recorded', async () => {
  const lease = await inventory.leases.claim(file, { pid: 301, startIdentity: 'launching' }, inventory);
  probes.set(301, { kind: 'live', startIdentity: 'launching' });
  expect(await recordedSessionLiveness(file, inventory)).toEqual({ kind: 'live', pids: [301] });
  probes.set(301, { kind: 'live', startIdentity: 'unrelated-reuse' });
  expect(await recordedSessionLiveness(file, inventory)).toEqual({ kind: 'free' });
  await inventory.leases.release(file, lease.token);
});

test('process inventory matches pi executables, not unrelated pi arguments', async () => {
  const nodePid = process.platform === 'linux' ? 99999999 : 405;
  processRows = `401 less less less pi\n402 grep grep grep pi-coding-agent\n403 pi pi pi\n404 /fixture/bin/pi pi /fixture/bin/pi\n${nodePid} node node node /fixture/pi-coding-agent/dist/cli.js\n`;
  const processes = await createProcessInventory(root).processes();
  expect(processes.map(process => process.pid)).toEqual([403, 404, nodePid]);
});

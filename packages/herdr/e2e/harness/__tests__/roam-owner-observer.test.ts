// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
// @ts-ignore The same ESM fixture is loaded directly by the owned processes.
import { instrumentOwnerBundle } from '../../fixtures/roam-owner-observer.mjs';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'roam-owner-observer-'));
  vi.stubEnv('SPIDER_HERDR_E2E_OWNER_DIR', root);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

function events(): Array<Record<string, unknown>> {
  return readFileSync(join(root, `${process.pid}.jsonl`), 'utf8').trim().split('\n')
    .map(line => JSON.parse(line) as Record<string, unknown>);
}

// The observer targets the packed owner's decision, not an independently
// reconstructed check. The sample has the same owner inputs and branches.
const sampleBundle = `
function createLocalIO(options) {
  const binary = 'hc';
  const env = { HC_SESSION: 'd', HC_SOCKET: '/owned/d.sock' };
  const invokeCli = async () => options.reply;
  return {
    async terminals(id, admittedPid) {
      async function list(args, pidFilter) {
        const reply = await invokeCli(binary, args, env, options.limits.replyBytes, void 0, { timeoutMs: options.limits.controlMs });
        if (!reply || typeof reply !== "object" || !("terminals" in reply) || !Array.isArray(reply.terminals)) throw new Error("Terminal list unavailable");
        return reply.terminals.map(row => ({ terminal: row.address, state: row.state, pid: row.pid }));
      }
      return list(['ls', '--all', '--json', '--label', 'spider.session=' + id]);
    },
    async launch({ home, placement }) { return { terminal: 'new' }; },
  };
}
function createLocalRuntime(options, io) {
  async function inspectOwner(id, placement) {
    try {
      const lock = await io.inspect(id), terminals = await io.terminals(id), live = terminals.filter(t => t.state === "live");
      if (lock) {
        const p = await io.probe(lock.identity.pid);
        if (p.kind !== "absent") {
          if (p.kind !== "live" || !p.pi || p.startIdentity !== lock.identity.startIdentity || !sameOwner(await io.inspect(id), lock)) return { owner: { kind: "unknown" } };
          const terminal = live.find(t => t.pid === lock.identity.pid);
          return { owner: { kind: "live", pid: lock.identity.pid, terminal: terminal?.terminal ?? null } };
        }
        await io.claimFree(id);
      }
      if (live.length) return { owner: { kind: "unknown" } };
      const blockers = await io.writerBlockers(id, placement);
      if (blockers.length) return { owner: { kind: "unknown" }, blockers };
      return { owner: await io.inspect(id) ? { kind: "unknown" } : { kind: "free" } };
    } catch { return { owner: { kind: "unknown" } }; }
  }
  async function owner(id, placement) {
    return (await inspectOwner(id, placement)).owner;
  }
  async function start(home, placement) {
    const { owner: current, blockers } = await inspectOwner(home.sessionId, placement);
    if (blockers) return { ok: false, code: "busy", blockers };
    if (current.kind !== "free") return { ok: false, code: "start-pending" };
    return { ok: true };
  }
  return { owner, start };
}
function sameOwner(left, right) { return left === right; }
export { createLocalIO, createLocalRuntime };
`;

it('records the lock, live terminals, home and decision seen by start', async () => {
  const file = join(root, 'sample.mjs');
  writeFileSync(file, instrumentOwnerBundle(sampleBundle));
  const mod = await import(/* @vite-ignore */ pathToFileURL(file).href) as {
    createLocalRuntime(options: unknown, io: unknown): { start(home: unknown, placement: unknown): Promise<unknown> };
  };
  const home = { sessionId: 'session', machineId: 'destination', epoch: 3, state: 'running' };
  const terminals = [{ terminal: 't9', state: 'live', pid: 818, owned: true }];
  const io = { inspect: async () => null, terminals: async () => terminals,
    probe: async () => ({ kind: 'absent' }), claimFree: async () => {}, writerBlockers: async () => [] };
  const result = await mod.createLocalRuntime({ config: { machineId: 'destination' } }, io)
    .start(home, { machineId: 'destination' });

  expect(result).toEqual({ ok: false, code: 'start-pending' });
  expect(events()).toEqual(expect.arrayContaining([
    expect.objectContaining({ event: 'owner-begin', caller: 'start', machineId: 'destination', sessionId: 'session', home }),
    expect.objectContaining({ event: 'owner-value', phase: 'lock', value: null }),
    expect.objectContaining({ event: 'owner-value', phase: 'terminals', value: terminals }),
    expect.objectContaining({ event: 'owner-value', phase: 'result', value: { owner: { kind: 'unknown' } } }),
  ]));
});

it('records the selected core and its terminal reply without recording screen text', async () => {
  const file = join(root, 'sample.mjs');
  writeFileSync(file, instrumentOwnerBundle(sampleBundle));
  const mod = await import(/* @vite-ignore */ pathToFileURL(file).href) as {
    createLocalIO(options: unknown): { terminals(id: string): Promise<unknown> };
    createLocalRuntime(options: unknown, io: unknown): { start(home: unknown, placement: unknown): Promise<unknown> };
  };
  const reply = { terminals: [{ address: 't9', state: 'live', pid: 818,
    labels: { 'spider.session': 'session' }, screen: 'private screen text' }] };
  const options = { config: { machineId: 'destination' }, limits: { replyBytes: 1000, controlMs: 2000 }, reply };
  const io = { ...mod.createLocalIO(options), inspect: async () => null,
    probe: async () => ({ kind: 'absent' }), claimFree: async () => {}, writerBlockers: async () => [] };
  expect(await mod.createLocalRuntime(options, io).start(
    { sessionId: 'session', machineId: 'destination', epoch: 3, state: 'running' },
    { machineId: 'destination' },
  )).toEqual({ ok: false, code: 'start-pending' });
  expect(events()).toContainEqual(expect.objectContaining({
    event: 'terminal-list', machineId: 'destination', sessionId: 'session', namespace: 'd', socket: '/owned/d.sock',
    terminals: [expect.objectContaining({ address: 't9', state: 'live', pid: 818, labels: { 'spider.session': 'session' } })],
  }));
  expect(JSON.stringify(events())).not.toContain('private screen text');
});

it('records an inspection error and preserves the unknown decision', async () => {
  const file = join(root, 'sample.mjs');
  writeFileSync(file, instrumentOwnerBundle(sampleBundle));
  const mod = await import(/* @vite-ignore */ pathToFileURL(file).href) as {
    createLocalRuntime(options: unknown, io: unknown): { owner(id: string): Promise<unknown> };
  };
  const error = Object.assign(new Error('fixture list unavailable'), { code: 'EIO' });
  const io = { inspect: async () => null, terminals: async () => { throw error; },
    probe: async () => ({ kind: 'absent' }), claimFree: async () => {}, writerBlockers: async () => [] };
  expect(await mod.createLocalRuntime({ config: { machineId: 'destination' } }, io).owner('session')).toEqual({ kind: 'unknown' });
  expect(events()).toEqual(expect.arrayContaining([
    expect.objectContaining({ event: 'owner-error', error: expect.objectContaining({ message: 'fixture list unavailable', code: 'EIO' }) }),
    expect.objectContaining({ event: 'owner-value', phase: 'result', value: { owner: { kind: 'unknown' } } }),
  ]));
});

it('does not change an owner decision when the evidence directory is unavailable', async () => {
  vi.stubEnv('SPIDER_HERDR_E2E_OWNER_DIR', join(root, 'missing'));
  const file = join(root, 'sample.mjs');
  writeFileSync(file, instrumentOwnerBundle(sampleBundle));
  const mod = await import(/* @vite-ignore */ pathToFileURL(file).href) as {
    createLocalRuntime(options: unknown, io: unknown): { owner(id: string): Promise<unknown> };
  };
  const io = { inspect: async () => null, terminals: async () => [],
    probe: async () => ({ kind: 'absent' }), claimFree: async () => {}, writerBlockers: async () => [] };
  expect(await mod.createLocalRuntime({ config: { machineId: 'destination' } }, io).owner('session')).toEqual({ kind: 'free' });
});

it('refuses to instrument unknown or ambiguous packed entries', () => {
  expect(() => instrumentOwnerBundle('export const unknown = 1;')).toThrow();
  expect(() => instrumentOwnerBundle(sampleBundle + sampleBundle)).toThrow();
});

it('loads only the selected entry and records its unchanged owner outcome', () => {
  const entry = join(root, 'sample.mjs'), driver = join(root, 'driver.mjs');
  writeFileSync(entry, sampleBundle);
  writeFileSync(join(root, 'other.mjs'), 'export const value = 7;\n');
  writeFileSync(driver, `import { createLocalRuntime } from './sample.mjs';
import { value } from './other.mjs';
const io = { inspect: async () => null, terminals: async () => [], writerBlockers: async () => [] };
console.log(JSON.stringify(await createLocalRuntime({ config: { machineId: 'destination' } }, io).owner('session')), value);
`);
  const register = fileURLToPath(new URL('../../fixtures/roam-owner-register.mjs', import.meta.url));
  const child = spawnSync(process.execPath, ['--import', register, driver], {
    env: { ...process.env, SPIDER_HERDR_E2E_OWNER_ENTRY: entry }, encoding: 'utf8',
  });
  expect(child.status, child.stderr).toBe(0);
  expect(child.stdout).toBe('{"kind":"free"} 7\n');
  const rows = readFileSync(join(root, `${child.pid}.jsonl`), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  expect(rows).toEqual(expect.arrayContaining([
    expect.objectContaining({ event: 'owner-begin', caller: 'owner', machineId: 'destination', sessionId: 'session' }),
    expect.objectContaining({ event: 'owner-value', phase: 'result', value: { owner: { kind: 'free' } } }),
  ]));
});

// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
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
export { createLocalRuntime };
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

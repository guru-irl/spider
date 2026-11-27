import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { openDb } from "@spider/db-core";
import { createReplica } from "@spider/db-core/testutil";
import { DEFAULT_LIMITS, disabledIntercom, type Clock, type RoamConfig, type Transport } from "../contracts";
import { openJournal } from "../journal";
import { isRevoked, revokeMachine } from "../revocation";
import { main } from "../cli";
import { createV0Runtime, startV0Hub } from "../relocate/runtime";
import type { SessionId } from "../relocate/types";

const mac = "11111111-1111-4111-8111-111111111111";
const box = "22222222-2222-4222-8222-222222222222";
const other = "33333333-3333-4333-8333-333333333333";
const sessionId = "revocation-example" as SessionId;
function fixture() {
  const replica = createReplica("global", mac);
  const journalFile = join(replica.root, "roam", "journal.db");
  openJournal(journalFile);
  const config: RoamConfig = {
    enabled: true, role: "hub", machineId: mac, hubMachineId: mac,
    peers: [box, other].map((machineId, i) => ({ machineId, alias: `box-${i}.invalid`, node: "/node", pi: "/pi", cli: "/spider", core: "/core", globalRoot: "/root" })),
    discoveryRoots: [], coreUnit: "core", syncMs: 10_000, limits: DEFAULT_LIMITS, intercom: disabledIntercom(),
  };
  const scheduled = new Map<() => void, number>();
  const clock: Clock = { now: () => 100, later(ms, fn) { scheduled.set(fn, ms); return () => { scheduled.delete(fn); }; } };
  const resolved: string[] = [], requests: string[] = [];
  let duringResolve = () => {};
  const unused = async () => { throw new Error("Transport method is unused"); };
  const transport: Transport = {
    async resolve(peer) {
      resolved.push(peer.machineId);
      if (peer.machineId === box) duringResolve();
      return peer;
    },
    async exec(peer) { requests.push(peer.machineId); throw new Error("End synthetic discovery"); },
    bootstrapProbe: unused, run: unused, read: unused, write: unused,
  };
  function forget() {
    const db = openDb(journalFile, { fileMustExist: true, checkpointOnClose: false });
    try { revokeMachine(db, box); } finally { db.close(); }
  }
  const overrides = {
    openCore: () => ({ root: replica.root, config: { ...config }, db: replica.db, close() {} }), transport, clock,
    readConfig: () => ({ ...config }),
  };
  const start = () => createV0Runtime(replica.root, overrides);
  return { forget, start, resolved, requests, scheduled, replica, config, overrides, journalFile, onResolve(fn: () => void) { duringResolve = fn; } };
}

it("schedules synchronization only for enrolled peers that were not forgotten", async () => {
  const f = fixture(); f.forget();
  const runtime = f.start();
  try {
    runtime.sync.start();
    const ticks = [...f.scheduled.keys()];
    for (const tick of ticks) { f.scheduled.delete(tick); tick(); }
    await runtime.sync.drain();
    expect(ticks).toHaveLength(1);
    expect(f.requests).toEqual([other]);
  } finally { await runtime.close(); f.replica.close(); }
});

it("scheduled replication follows configuration changes without a hub restart", async () => {
  const f = fixture();
  f.config.enabled = false;
  const hub = await startV0Hub(f.replica.root, f.overrides);
  const tick = (predicate: (delay: number) => boolean) => {
    for (const [fn, delay] of [...f.scheduled]) if (predicate(delay)) { f.scheduled.delete(fn); fn(); }
  };
  try {
    expect(f.requests).toEqual([]);
    f.config.enabled = true;
    tick(ms => ms > 0); tick(ms => ms === 0);
    await new Promise<void>(done => setImmediate(done));
    expect(f.requests).toEqual(expect.arrayContaining([box, other]));
    const previous = f.requests.length;
    f.config.enabled = false;
    tick(ms => ms > 0); tick(ms => ms === 0);
    await new Promise<void>(done => setImmediate(done));
    expect(f.requests).toHaveLength(previous);
    expect([...f.scheduled.values()]).toEqual([1_000]);
  } finally { await hub.stop(); f.replica.close(); }
});

it("does not send peer RPCs if the peer is forgotten during discovery", async () => {
  const f = fixture();
  const runtime = f.start();
  f.onResolve(f.forget);
  try {
    await runtime.sync.sync(box);
    expect(f.resolved).toContain(box);
    expect(f.requests).toEqual([other]);
  } finally { await runtime.close(); f.replica.close(); }
});

it.each([true, false])("forget records a revocation without a legacy hub (enabled=%s)", async enabled => {
  const f = fixture();
  f.config.enabled = enabled;
  writeFileSync(join(f.replica.root, "roam", "machine.json"), JSON.stringify({ machineId: mac }), { mode: 0o600 });
  writeFileSync(join(f.replica.root, "roam", "config.json"), JSON.stringify(f.config), { mode: 0o600 });
  vi.stubEnv("SPIDER_GLOBAL_ROOT", f.replica.root);
  const runtime = f.start();
  try {
    const before = await runtime.homes.initialize(sessionId, box);
    const out = vi.fn(), err = vi.fn();
    expect(await main(["roam", "forget", "box-0.invalid", "--confirm", "destroyed box-0.invalid", "--json"], { out, err })).toBe(0);
    expect(JSON.parse(out.mock.calls.flat().join(""))).toMatchObject({ code: 0, reason: "machine-forgotten" });
    const db = openDb(f.journalFile, { fileMustExist: true, checkpointOnClose: false });
    try { expect(isRevoked(db, box)).toBe(true); } finally { db.close(); }
    expect(await runtime.homes.read(sessionId)).toEqual(before);
    expect(await runtime.services.relocate({ sessionId, destinationMachine: box })).toMatchObject({ ok: false, refusal: { code: "machine-revoked" } });
    expect(f.requests).toEqual([]);
  } finally { await runtime.close(); f.replica.close(); vi.unstubAllEnvs(); }
});

it("cannot enter moving after hub disable has finished checking the homes", async () => {
  const f = fixture(), runtime = f.start();
  try {
    const before = await runtime.homes.initialize(sessionId, mac);
    f.config.enabled = false;
    await expect(runtime.homes.compareAndSwap(before, { ...before, state: "moving", destination: box,
      epoch: 2, moveId: "v0-33333333-3333-4333-8333-333333333333" })).rejects.toThrow(/disabled/);
    expect(await runtime.homes.read(sessionId)).toEqual(before);
  } finally { await runtime.close(); f.replica.close(); }
});

it("rejects relocate and forced set-home to a forgotten peer without contacting it", async () => {
  const f = fixture();
  const runtime = f.start(); f.forget();
  try {
    const destinationMachine = box;
    const before = await runtime.homes.initialize(sessionId, mac);
    const refused = { ok: false, refusal: { code: "machine-revoked", nextStep: expect.stringMatching(/choose another/i) } };
    const moved = await runtime.services.relocate({ sessionId, destinationMachine });
    const reassigned = await runtime.services.setHome({ sessionId, destinationMachine, force: true, confirmation: `reassign ${sessionId} to ${box}; source will not run` });
    expect([moved, reassigned]).toMatchObject([refused, refused]);
    expect(await runtime.homes.read(sessionId)).toEqual(before);
    expect(f.resolved).toEqual([]);
    expect(f.requests).toEqual([]);
  } finally { await runtime.close(); f.replica.close(); }
});

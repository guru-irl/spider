import { join } from "node:path";
import { expect, it } from "vitest";
import { openDb } from "@spider/db-core";
import { createReplica } from "@spider/db-core/testutil";
import { DEFAULT_LIMITS, disabledIntercom, type Clock, type RoamConfig, type Transport } from "../contracts";
import { openJournal } from "../journal";
import { revokeMachine } from "../revocation";
import { createV0Runtime } from "../relocate/runtime";
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
  const scheduled = new Set<() => void>();
  const clock: Clock = { now: () => 100, later(_ms, fn) { scheduled.add(fn); return () => { scheduled.delete(fn); }; } };
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
  const start = () => createV0Runtime(replica.root, {
    openCore: () => ({ root: replica.root, config, db: replica.db, close() {} }), transport, clock,
  });
  return { forget, start, resolved, requests, scheduled, replica, onResolve(fn: () => void) { duringResolve = fn; } };
}

it("schedules synchronization only for enrolled peers that were not forgotten", async () => {
  const f = fixture(); f.forget();
  const runtime = f.start();
  try {
    runtime.sync.start();
    const ticks = [...f.scheduled];
    for (const tick of ticks) { f.scheduled.delete(tick); tick(); }
    await runtime.sync.drain();
    expect(ticks).toHaveLength(1);
    expect(f.requests).toEqual([other]);
  } finally { await runtime.close(); f.replica.close(); }
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

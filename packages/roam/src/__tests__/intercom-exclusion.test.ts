import { afterEach, expect, it } from "vitest";
import { createReplica } from "@spider/db-core/testutil";
import { readLocal, writeLocal } from "@spider/db-core/roam/local-state";
import { intercomExclusion, recordIntercomGeneration, recordSupervisorExits } from "../intercom-exclusion";
import { stopParticipantWithExclusion } from "../participant-supervisor";

const A = "00000000-0000-4000-8000-000000000001", owner = { address: { sessionId: "own", scopeId: "scope" }, machineId: A, homeEpoch: 1, activationEpoch: "old" };
const key = JSON.stringify(["own", "old"]), replicas: Array<{ close(): void }> = [];
afterEach(() => { for (const replica of replicas.splice(0)) replica.close(); });
function fixture() { const replica = createReplica("global", A); replicas.push(replica); const db = replica.db;
  recordIntercomGeneration(db, { sessionId: "own", generation: "old", pid: 12345 }, () => ({ kind: "live", startIdentity: "linux:100" }));
  return db;
}
const live = { kind: "live" as const, identity: { bootId: "boot", pid: 12345, startTime: "linux:100" } };
const same = () => ({ kind: "live" as const, startIdentity: "linux:100" });
it("unconfirmed or failed stops never create exclusion proof", async () => {
  const db = fixture();
  await stopParticipantWithExclusion(db, "own", live, async () => ({ kind: "uncertain" }), async () => true);
  await stopParticipantWithExclusion(db, "own", live, async () => ({ kind: "absent" }), async () => false);
  await stopParticipantWithExclusion(db, "own", { kind: "absent" }, async () => ({ kind: "absent" }), async () => true);
  await expect(stopParticipantWithExclusion(db, "own", live, async () => { throw new Error("stop failed"); }, async () => true)).rejects.toThrow("stop failed");
  expect(readLocal(db, "intercom-supervisor-exit", key)).toBeUndefined();
  expect(intercomExclusion(db, owner, same)).toBeUndefined();
}, 5000);
it("confirmed supervisor exit is exact, idempotent, and authorizes exclusion", async () => {
  const db = fixture();
  await stopParticipantWithExclusion(db, "own", live, async () => ({ kind: "absent" }), async () => true);
  const stored = JSON.stringify(readLocal(db, "intercom-supervisor-exit", key));
  expect(JSON.parse(stored)).toEqual({ version: 1, sessionId: "own", generation: "old", pid: 12345, startIdentity: "linux:100", confirmed: "stop-exited" });
  await stopParticipantWithExclusion(db, "own", live, async () => ({ kind: "absent" }), async () => true);
  expect(JSON.stringify(readLocal(db, "intercom-supervisor-exit", key))).toBe(stored);
  expect(intercomExclusion(db, owner, same)).toMatchObject({ kind: "owner-exited", excludedGeneration: "old" });
}, 5000);
it("malformed and conflicting persisted proofs are refused by name", () => {
  const db = fixture();
  db.raw.transaction(() => writeLocal(db, "intercom-supervisor-exit", key, { version: 1, sessionId: "own", generation: "old", pid: 12345, startIdentity: "wrong", confirmed: "stop-exited" })).immediate();
  expect(() => recordSupervisorExits(db, "own", live.identity)).toThrow("intercom-exclusion-conflict");
  expect(() => intercomExclusion(db, owner, same)).toThrow("intercom-exclusion-conflict");
  db.raw.transaction(() => writeLocal(db, "intercom-supervisor-exit", key, { malformed: true })).immediate();
  expect(() => intercomExclusion(db, owner, same)).toThrow("intercom-exclusion-invalid");
}, 5000);

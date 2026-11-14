import { expect, it } from "vitest";
import type { HostIntent, Outcome } from "../contracts";
import type { IntentState, IntentStore, VersionedIntent } from "../intent";
import { createDurableLaunchPort } from "../supervisor";

const intent: HostIntent = { sessionId: "s1", epoch: 1, desired: "running", suspended: null,
  file: "/fixture/session.jsonl", cwd: "/fixture/work", moveId: null };
const initial: IntentState = { intent, failures: [], supervision: { kind: "idle", nextAttemptAt: null } };
const ready = { origin: "hub-operation" as const, opId: "op-1", sessionId: "s1", epoch: 1, cwd: intent.cwd, file: intent.file, core: "core-1", terminal: "terminal-1" };
function outcome(reason: string, value: typeof ready | null): Outcome<typeof ready> {
  return { code: value ? 0 : 2, reason, operationId: "op-1", home: null, epoch: 1, repairCommand: null, value };
}
function fixture(state: IntentState = initial) {
  let row: VersionedIntent = { version: 1, value: structuredClone(state) };
  const intents: IntentStore = { async list() { return ["s1"]; }, async get() { return structuredClone(row); },
    async update(_id, expected, next) {
      if (expected !== row.version) return { kind: "stale", currentVersion: row.version };
      row = { version: row.version + 1, value: structuredClone(next) }; return { kind: "updated", version: row.version };
    } };
  const calls: Array<{ mode: string; operationId: string }> = [];
  let answer = outcome("launch-pending", null), authorized = true;
  const launch = createDurableLaunchPort({ intents, operationId: () => "op-1", authorize: async () => authorized,
    async invoke(request) { calls.push({ mode: request.mode, operationId: request.reservation.operationId }); return answer; } });
  return { launch, calls, state: async () => (await intents.get("s1"))!.value,
    setAnswer(value: Outcome<typeof ready>) { answer = value; }, setAuthorized(value: boolean) { authorized = value; } };
}
const reserved: IntentState = { ...initial, supervision: { kind: "launching", operationId: "op-1", phase: "reserved" } };
const invoking: IntentState = { ...initial, supervision: { kind: "launching", operationId: "op-1", phase: "invoking" } };

it("fresh reserves once and refuses a second fresh call by name", async () => {
  const f = fixture();
  expect((await f.launch({ intent, mode: "fresh" })).reason).toBe("launch-pending");
  expect((await f.state()).supervision).toEqual(invoking.supervision);
  expect((await f.launch({ intent, mode: "fresh" })).reason).toBe("launch-reservation-exists");
  expect(f.calls).toEqual([{ mode: "initial", operationId: "op-1" }]);
}, 5000);

it("a crash after reservation but before invocation starts the reserved operation once", async () => {
  const f = fixture(reserved);
  expect((await f.launch({ intent, mode: "reconcile", reservation: { operationId: "op-1" } })).reason).toBe("launch-pending");
  expect(f.calls).toEqual([{ mode: "initial", operationId: "op-1" }]);
  expect((await f.state()).supervision).toEqual(invoking.supervision);
}, 5000);

it("a lost reply reconciles the same operation without clearing its reservation", async () => {
  const f = fixture(invoking);
  expect((await f.launch({ intent, mode: "reconcile", reservation: { operationId: "op-1" } })).reason).toBe("launch-pending");
  expect(f.calls).toEqual([{ mode: "reconcile", operationId: "op-1" }]);
  expect((await f.state()).supervision).toEqual(invoking.supervision);
}, 5000);

it("reconciles an adopted operation without creating a fresh reservation", async () => {
  const f = fixture(invoking); f.setAnswer(outcome("ready", ready));
  expect((await f.launch({ intent, mode: "reconcile", reservation: { operationId: "op-1" } })).value).toEqual(ready);
  expect(f.calls).toEqual([{ mode: "reconcile", operationId: "op-1" }]);
}, 5000);

it("keeps an uninvoked reservation if authority changes before launch", async () => {
  const f = fixture(); f.setAuthorized(false);
  expect((await f.launch({ intent, mode: "fresh" })).reason).toBe("launch-pending");
  expect(f.calls).toEqual([]);
  expect((await f.state()).supervision).toEqual(reserved.supervision);
}, 5000);

it("rejects reconciliation for a different operation", async () => {
  const f = fixture(invoking);
  expect((await f.launch({ intent, mode: "reconcile", reservation: { operationId: "other" } })).reason).toBe("launch-reservation-mismatch");
  expect(f.calls).toEqual([]);
  expect((await f.state()).supervision).toEqual(invoking.supervision);
}, 5000);

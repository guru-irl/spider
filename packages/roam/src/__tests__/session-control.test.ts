import { afterEach, expect, it } from "vitest";
import { join, resolve, sep } from "node:path";
import { buildFixture } from "../../../../scripts/test-bundle";
import { createReplica } from "@spider/db-core/testutil";
import type { Home, Readiness } from "@spider/db-core/roam/types";
import type { HostIntent, Operation } from "../contracts";
import { openJournal } from "../journal";
import * as control from "../session-control";

const BOX = "00000000-0000-4000-8000-000000000002", HUB = "00000000-0000-4000-8000-000000000001";
const fixtures: ReturnType<typeof createReplica>[] = [];
afterEach(() => { for (const f of fixtures.splice(0)) f.close(); });
function fixture() {
  const f = createReplica("global", BOX); fixtures.push(f);
  const journal = openJournal(join(f.root, "roam", "journal.db"));
  const home: Home = { sessionId: "session-1", machineId: BOX, epoch: 2, moveId: "move-1", updatedAt: 1 };
  const intent: HostIntent = { sessionId: "session-1", epoch: 2, desired: "running", suspended: null, file: join(f.root, "session.jsonl"), cwd: f.root, moveId: "move-1" };
  const operation: Operation = { id: "start-1", kind: "session-start", machineId: BOX, expectedEpoch: 2,
    args: { sourceMachine: HUB, sessionId: "session-1" } };
  const ready: Readiness = { origin: "hub-operation" as const, opId: operation.id, sessionId: "session-1", epoch: 2, cwd: f.root, file: intent.file, core: "core-1", terminal: "term-1" };
  return { ...f, journal, home, intent, operation, ready };
}

it("standalone participant control bundles without host imports", async () => {
  const bundle = await buildFixture({ entryPoints: ["packages/roam/src/session-control.ts"], write: false, external: ["better-sqlite3", "sqlite-vec"] });
  const hostRoot = resolve("packages/host") + sep;
  const hostImports = Object.keys(bundle.metafile.inputs).filter(file => file.startsWith(hostRoot));
  expect(hostImports).toEqual([]);
}, 5000);

it.each(["box-local", "hub-operation"])("rejects mismatched persisted %s readiness with a named reason", origin => {
  const f = fixture(), raw: Record<string, unknown> = { ...f.ready, origin };
  if (origin === "box-local") raw.machineId = BOX; else delete raw.opId;
  f.journal.begin(f.operation); f.journal.record(f.operation.id, "ready-durable", raw as never);
  expect(() => control.readReadiness(f.journal, f.operation.id)).toThrow("readiness-origin-mismatch");
}, 5000);

it("start before any pi process records state and intent before waking supervision", async () => {
  const f = fixture(), order: string[] = [];
  const authority = control.createRunningIntentAuthority(f.db);
  const ports: control.ParticipantPorts = { journal: f.journal, machineId: BOX, hubMachineId: HUB,
    async activate(home, intent) { expect(home).toEqual(f.home); order.push("active-durable"); await authority.set(intent, f.operation.id); order.push("intent-durable"); },
    async wake() { order.push("wake"); }, async readiness(id) { order.push("readiness"); expect(id).toBe("start-1"); return null; } };
  expect(await control.startParticipant(f.operation, f.home, f.intent, ports)).toMatchObject({ code: 3, reason: "readiness-pending" });
  expect(order).toEqual(["active-durable", "intent-durable", "wake", "readiness"]);
  expect(await control.createRunningIntentAuthority(f.db).get("session-1")).toEqual(f.intent);
}, 5000);

it("lost readiness reply returns the persisted owner without reactivation", async () => {
  const f = fixture(); let activations = 0, wakes = 0;
  const ports: control.ParticipantPorts = { journal: f.journal, machineId: BOX, hubMachineId: HUB,
    async activate() { activations++; }, async wake() { wakes++; }, async readiness() { return f.ready; } };
  const first = await control.startParticipant(f.operation, f.home, f.intent, ports);
  const replay = await control.startParticipant(f.operation, f.home, f.intent, ports);
  expect(first).toMatchObject({ code: 0, value: f.ready }); expect(replay).toEqual(first);
  expect(activations).toBe(1); expect(wakes).toBe(1);
}, 5000);

it.each(["caller", "epoch", "owner", "intent", "receipt"])("start rejects mismatched %s before accepting readiness", async kind => {
  const f = fixture(); let activations = 0;
  if (kind === "caller") f.operation.args.sourceMachine = BOX;
  if (kind === "epoch") f.operation.expectedEpoch = 1;
  if (kind === "owner") f.home.machineId = HUB;
  if (kind === "intent") f.intent.desired = "stopped";
  const result = await control.startParticipant(f.operation, f.home, f.intent, { journal: f.journal, machineId: BOX, hubMachineId: HUB,
    async activate() { activations++; }, async wake() {}, async readiness() { return { ...f.ready, epoch: 1 }; } });
  expect(result.code).not.toBe(0);
  if (kind !== "receipt") expect(activations).toBe(0);
}, 5000);

it.each([
  ["hub", "participant-wrong-hub"], ["target", "participant-wrong-target"], ["both", "participant-wrong-hub-and-target"],
  ["missing", "participant-config-unavailable"], ["changed", "participant-config-changed"],
] as const)("refuses %s identity before effects", async (kind, reason) => {
  const f = fixture(); let effects = 0;
  if (kind === "hub" || kind === "both") f.operation.args.sourceMachine = BOX;
  if (kind === "target" || kind === "both") f.operation.machineId = HUB;
  const result = await control.startParticipant(f.operation, f.home, f.intent, { journal: f.journal,
    machineId: kind === "missing" ? null : BOX, hubMachineId: kind === "missing" ? null : HUB,
    identityCurrent: async () => kind !== "changed",
    async activate() { effects++; }, async wake() { effects++; }, async readiness() { effects++; return f.ready; } });
  expect(result).toMatchObject({ code: 1, reason }); expect(effects).toBe(0); expect(f.journal.read(f.operation.id)).toEqual([]);
}, 5000);

it("stopped authority survives reopening and failed doctor cannot resume", async () => {
  const f = fixture(), authority = control.createRunningIntentAuthority(f.db);
  await authority.set(f.intent, f.operation.id);
  await authority.stop("session-1");
  expect(await control.createRunningIntentAuthority(f.db).get("session-1")).toMatchObject({ desired: "stopped" });
  await expect(authority.resume("session-1", async () => [{ reason: "missing-auth", severity: "block", repairCommand: null }])).rejects.toThrow("doctor");
  expect(await authority.get("session-1")).toMatchObject({ desired: "stopped" });
  await authority.resume("session-1", async () => []);
  expect(await authority.get("session-1")).toMatchObject({ desired: "running", suspended: null });
}, 5000);

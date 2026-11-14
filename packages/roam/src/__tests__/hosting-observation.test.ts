import { afterEach, expect, it } from "vitest";
import { join } from "node:path";
import { createReplica } from "@spider/db-core/testutil";
import { writeLocal } from "@spider/db-core/roam/local-state";
import { openJournal } from "../journal";
import { createIntentStore } from "../intent";
import { createRunningIntentAuthority, recordReadiness } from "../session-control";
import { observeHosting } from "../hosting";

const BOX = "00000000-0000-4000-8000-000000000002", HUB = "00000000-0000-4000-8000-000000000001", OTHER = "00000000-0000-4000-8000-000000000003";
const roots: ReturnType<typeof createReplica>[] = [];
afterEach(() => { for (const root of roots.splice(0)) root.close(); });
it("reconnect reports new terminal for placement and durable suspension", async () => {
  const f = createReplica("global", BOX); roots.push(f);
  const journal = openJournal(join(f.root, "roam", "journal.db")), authority = createRunningIntentAuthority(f.db), intents = createIntentStore(f.root);
  const intent = { sessionId: "s-1", epoch: 1, file: join(f.root, "s.jsonl"), cwd: f.root, desired: "running" as const, suspended: null, moveId: null };
  f.db.prepare("INSERT INTO session_homes VALUES (?,?,1,NULL,1)").run("s-1", BOX);
  await authority.set(intent, "launch-1", { machineId: BOX, hubMachineId: HUB });
  const ports = { db: f.db, journal, authority, intents, machineId: BOX, hubMachineId: HUB, async live() { return true; } };
  for (const [operationId, terminal] of [["launch-1", "terminal-1"], ["launch-2", "terminal-2"]]) {
    journal.begin({ id: operationId, kind: "exact-session-launch", machineId: BOX, expectedEpoch: 1, args: {} });
    const ready = { origin: "hub-operation" as const, opId: operationId, sessionId: "s-1", epoch: 1, cwd: f.root, file: intent.file, core: "core-1", terminal };
    recordReadiness(journal, ready); writeLocal(f.db, "participant-ready", "s-1", ready);
    expect((await observeHosting(ports)).readiness).toEqual([ready]);
  }
  await intents.update("s-1", null, { intent: { ...intent, suspended: "missing auth" }, failures: [], supervision: { kind: "idle", nextAttemptAt: null } });
  expect(await observeHosting(ports)).toEqual({ readiness: [], suspensions: [{ sessionId: "s-1", epoch: 1 }] });
}, 5000);

it("a box-local owner is observable before sync but not under a foreign home", async () => {
  const f = createReplica("global", BOX); roots.push(f);
  const authority = createRunningIntentAuthority(f.db), journal = openJournal(join(f.root, "roam", "journal.db"));
  const origin = { kind: "box-local", machineId: BOX, epoch: 1, file: join(f.root, "s.jsonl"), cwd: f.root, pid: process.pid, startIdentity: "owner", stopped: false };
  const ready = { origin: "box-local", machineId: BOX, sessionId: "s-1", epoch: 1, file: origin.file, cwd: origin.cwd, core: "core-1", terminal: "term-1" };
  writeLocal(f.db, "participant-origin", "s-1", origin); writeLocal(f.db, "participant-ready", "s-1", ready);
  const ports = { db: f.db, journal, authority, intents: createIntentStore(f.root), machineId: BOX, hubMachineId: HUB, async live() { return true; } };
  expect((await observeHosting(ports)).readiness).toEqual([ready]);
  f.db.prepare("INSERT INTO session_homes VALUES (?,?,1,NULL,1)").run("s-1", OTHER);
  expect((await observeHosting(ports)).readiness).toEqual([]);
}, 5000);

it.each(["missing-home", "wrong-machine", "new-epoch", "wrong-move", "untrusted-intent"])("does not advertise %s authority", async scenario => {
  const f = createReplica("global", BOX); roots.push(f);
  const journal = openJournal(join(f.root, "roam", "journal.db")), authority = createRunningIntentAuthority(f.db);
  const intent = { sessionId: "s-1", epoch: 1, file: join(f.root, "s.jsonl"), cwd: f.root, desired: "running" as const, suspended: null, moveId: null };
  if (scenario !== "missing-home") f.db.prepare("INSERT INTO session_homes VALUES (?,?,?,?,1)").run("s-1", scenario === "wrong-machine" ? OTHER : BOX, scenario === "new-epoch" ? 2 : 1, scenario === "wrong-move" ? "move-2" : null);
  await authority.set(intent, "launch-1", scenario === "untrusted-intent" ? undefined : { machineId: BOX, hubMachineId: HUB });
  journal.begin({ id: "launch-1", kind: "exact-session-launch", machineId: BOX, expectedEpoch: 1, args: {} });
  const ready = { origin: "hub-operation" as const, opId: "launch-1", sessionId: "s-1", epoch: 1, cwd: f.root, file: intent.file, core: "core-1", terminal: "term-1" };
  recordReadiness(journal, ready); writeLocal(f.db, "participant-ready", "s-1", ready);
  const ports = { db: f.db, journal, authority, intents: createIntentStore(f.root), machineId: BOX, hubMachineId: HUB, async live() { return true; } };
  expect(await observeHosting(ports)).toEqual({ readiness: [], suspensions: [] });
}, 5000);

it("stopped or unproved owners never advertise an old readiness receipt", async () => {
  const f = createReplica("global", BOX); roots.push(f);
  const authority = createRunningIntentAuthority(f.db), journal = openJournal(join(f.root, "roam", "journal.db"));
  const intent = { sessionId: "s-1", epoch: 1, file: join(f.root, "s.jsonl"), cwd: f.root, desired: "running" as const, suspended: null, moveId: null };
  f.db.prepare("INSERT INTO session_homes VALUES (?,?,1,NULL,1)").run("s-1", BOX);
  await authority.set(intent, "launch-1", { machineId: BOX, hubMachineId: HUB }); journal.begin({ id: "launch-1", kind: "exact-session-launch", machineId: BOX, expectedEpoch: 1, args: {} });
  const ready = { origin: "hub-operation" as const, opId: "launch-1", sessionId: "s-1", epoch: 1, cwd: f.root, file: intent.file, core: "core-1", terminal: "old-terminal" };
  recordReadiness(journal, ready); writeLocal(f.db, "participant-ready", "s-1", ready);
  const ports = { db: f.db, journal, authority, intents: createIntentStore(f.root), machineId: BOX, hubMachineId: HUB, async live() { return false; } };
  expect((await observeHosting(ports)).readiness).toEqual([]);
  await authority.stop("s-1");
  expect((await observeHosting({ ...ports, live: async () => true })).readiness).toEqual([]);
}, 5000);

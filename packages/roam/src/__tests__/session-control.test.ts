import { afterEach, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createProcessInventory } from "../../../host/src/herdr/process-inventory";
import { join, resolve, sep } from "node:path";
import { writeFile } from "node:fs/promises";
import { createProcessPresence } from "@spider/herdr/sessions/presence";
import { createSessionLeases, type ProcessInventoryPorts } from "@spider/herdr/sessions/lease";
import { inspectIdLock } from "@spider/herdr/sessions/id-lock";
import { buildFixture } from "../../../../scripts/test-bundle";
import { createReplica } from "@spider/db-core/testutil";
import type { Home, Readiness } from "@spider/db-core/roam/types";
import type { HostIntent, Operation } from "../contracts";
import { openJournal } from "../journal";
import * as control from "../session-control";
import { readLocal } from "@spider/db-core/roam/local-state";

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
    async activate(home, intent) { expect(home).toEqual(f.home); order.push("active-durable"); await authority.set(intent, f.operation.id, { kind: "box-participant", machineId: BOX, hubMachineId: HUB }); order.push("intent-durable"); },
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

it.each(["stopped", "suspended"])("does not replace a %s authority with running at the same epoch", async kind => {
  const f = fixture(), authority = control.createRunningIntentAuthority(f.db);
  await authority.set(kind === "stopped" ? { ...f.intent, desired: "stopped" } : { ...f.intent, suspended: "manual hold" }, f.operation.id, { kind: "box-participant", machineId: BOX, hubMachineId: HUB });
  await expect(authority.set(f.intent, "another-start", { kind: "box-participant", machineId: BOX, hubMachineId: HUB })).rejects.toThrow(/stopped or suspended/i);
  expect(await control.createRunningIntentAuthority(f.db).get("session-1")).toMatchObject(
    kind === "stopped" ? { desired: "stopped", epoch: f.intent.epoch } : { suspended: "manual hold", epoch: f.intent.epoch });
}, 5000);

it("keeps a stop generation across retries but changes it after resume", async () => {
  const f = fixture(), authority = control.createRunningIntentAuthority(f.db) as control.RunningIntentAuthority & { stopToken?: (id: string) => string | null };
  expect(authority.stopToken).toBeTypeOf("function");
  await authority.set(f.intent, f.operation.id, { kind: "box-participant", machineId: BOX, hubMachineId: HUB }); expect(authority.stopToken!("session-1")).toBeNull();
  await authority.stop("session-1"); const first = authority.stopToken!("session-1"); expect(first).toBeTypeOf("string");
  const reopened = control.createRunningIntentAuthority(f.db) as typeof authority;
  expect(reopened.stopToken!("session-1")).toBe(first);
  await authority.stop("session-1"); expect(authority.stopToken!("session-1")).toBe(first);
  await authority.resume("session-1", async () => []); expect(authority.stopToken!("session-1")).toBeNull();
  await authority.stop("session-1"); expect(authority.stopToken!("session-1")).not.toBe(first);
}, 5000);

it("stopped authority survives reopening and failed doctor cannot resume", async () => {
  const f = fixture(), authority = control.createRunningIntentAuthority(f.db);
  await authority.set(f.intent, f.operation.id, { kind: "box-participant", machineId: BOX, hubMachineId: HUB });
  await authority.stop("session-1");
  expect(await control.createRunningIntentAuthority(f.db).get("session-1")).toMatchObject({ desired: "stopped" });
  await expect(authority.resume("session-1", async () => [{ reason: "missing-auth", severity: "block", repairCommand: null }])).rejects.toThrow("doctor");
  expect(await authority.get("session-1")).toMatchObject({ desired: "stopped" });
  await authority.resume("session-1", async () => []);
  expect(await authority.get("session-1")).toMatchObject({ desired: "running", suspended: null });
}, 5000);

it("rejects unknown participant verbs and uncertain ownership without effects", async () => {
  const f = fixture();
  const operation: Operation = { id: "control-1", kind: "session-freeze", machineId: BOX, expectedEpoch: 2,
    args: { sessionId: "session-1", moveId: "move-1" } };
  const effects: string[] = [];
  const ports: control.SessionControlPorts = { journal: f.journal, probe: async () => ({ kind: "uncertain" }),
    withBothLocks: async (_id, fn) => { effects.push("locks"); return fn(); },
    live: async op => { effects.push("live"); return { code: 0, reason: "ok", operationId: op.id, home: null, epoch: op.expectedEpoch, repairCommand: null, value: {} }; },
    dormant: async op => { effects.push("dormant"); return { code: 0, reason: "ok", operationId: op.id, home: null, epoch: op.expectedEpoch, repairCommand: null, value: {} }; } };
  expect(await control.controlSession({ ...operation, kind: "session-exec" }, ports)).toMatchObject({ code: 2 });
  expect(await control.controlSession(operation, ports)).toMatchObject({ code: 3 });
  expect(effects).toEqual([]);
  expect(f.journal.read(operation.id)).toEqual([]);
}, 5000);

it("dormant control rechecks dormancy while holding both locks", async () => {
  const f = fixture();
  const operation: Operation = { id: "freeze-dormant", kind: "session-freeze", machineId: BOX, expectedEpoch: 2,
    args: { sessionId: "session-1", moveId: "move-1" } };
  const order: string[] = [];
  const ports: control.SessionControlPorts = { journal: f.journal, probe: async () => { order.push("probe"); return { kind: "absent" }; },
    withBothLocks: async (id, fn) => { expect(id).toBe("session-1"); order.push("locks"); try { return await fn(); } finally { order.push("unlock"); } },
    live: async () => { throw new Error("must not call live"); },
    dormant: async op => { order.push("dormant"); return { code: 0, reason: "frozen", operationId: op.id, home: null, epoch: op.expectedEpoch, repairCommand: null, value: { leaf: "physical-leaf" } }; } };
  expect(await control.controlSession(operation, ports)).toMatchObject({ code: 0, value: { leaf: "physical-leaf" } });
  expect(order).toEqual(["probe", "locks", "probe", "dormant", "unlock"]);
}, 5000);

it("live retirement waits for proved exit before a locked dormant retirement", async () => {
  const f = fixture();
  const operation: Operation = { id: "retire-1", kind: "session-retire", machineId: BOX, expectedEpoch: 2,
    args: { sessionId: "session-1", moveId: "move-1" } };
  let alive = true, retired = false, shutdowns = 0;
  const ports: control.SessionControlPorts = { journal: f.journal,
    probe: async () => alive ? { kind: "live", identity: { bootId: "boot", pid: 123, startTime: "start" } } : { kind: "absent" },
    withBothLocks: async (_id, fn) => fn(),
    live: async op => { shutdowns++; return { code: 0, reason: "shutdown-requested", operationId: op.id, home: null, epoch: op.expectedEpoch, repairCommand: null, value: {} }; },
    dormant: async op => { retired = true; return { code: 0, reason: "retired", operationId: op.id, home: null, epoch: op.expectedEpoch, repairCommand: null, value: {} }; } };
  expect(await control.controlSession(operation, ports)).toMatchObject({ code: 3, reason: "process-exit-unproven" });
  expect(retired).toBe(false); expect(shutdowns).toBe(1);
  alive = false;
  expect(await control.controlSession(operation, ports)).toMatchObject({ code: 0, reason: "retired" });
  expect(retired).toBe(true);
}, 5000);

async function lockFixture() {
  const f = fixture(), root = join(f.root, "ownership"), file = join(f.root, "session.jsonl");
  await writeFile(file, JSON.stringify({ type: "session", version: 3, id: "session-1", cwd: f.root }) + "\n");
  const identity = { pid: process.pid, startIdentity: "fixture-process" };
  const leases = createSessionLeases(root);
  const inventory: ProcessInventoryPorts = { presence: createProcessPresence(root), leases,
    processes: async () => [], probe: async pid => pid === identity.pid ? { kind: "live", startIdentity: identity.startIdentity } : { kind: "absent" } };
  return { ...f, root, file, identity, inventory, leases };
}

it("both locks claim the session ID before the file and release on throw", async () => {
  const f = await lockFixture();
  expect(control.createBothLocks).toBeTypeOf("function");
  let idHeldAtFileClaim = false;
  const inventory: ProcessInventoryPorts = { ...f.inventory, leases: { ...f.leases,
    async claim(file, process, ports, policy) {
      idHeldAtFileClaim = (await inspectIdLock(f.root, "session-1"))?.identity.pid === f.identity.pid;
      return f.leases.claim(file, process, ports, policy);
    },
  } };
  const withBothLocks = control.createBothLocks({ root: f.root, file: async () => f.file, inventory, identity: f.identity, bootId: async () => "boot-fixture" });
  await expect(withBothLocks("session-1", async () => {
    expect(await inspectIdLock(f.root, "session-1")).toMatchObject({ identity: f.identity });
    expect(await f.leases.get(f.file)).toMatchObject(f.identity);
    throw new Error("fixture failure");
  })).rejects.toThrow("fixture failure");
  expect(idHeldAtFileClaim).toBe(true);
  expect(await f.leases.get(f.file)).toBeNull();
  expect(await inspectIdLock(f.root, "session-1")).toBeNull();
}, 5000);

it("both locks refuse same-ID and same-file contenders without releasing the owner", async () => {
  const f = await lockFixture();
  expect(control.createBothLocks).toBeTypeOf("function");
  const withBothLocks = control.createBothLocks({ root: f.root, file: async () => f.file, inventory: f.inventory, identity: f.identity, bootId: async () => "boot-fixture" });
  let enter!: () => void, finish!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const wait = new Promise<void>(resolve => { finish = resolve; });
  const held = withBothLocks("session-1", async () => { enter(); await wait; return "done"; });
  try {
    await entered;
    await expect(withBothLocks("session-1", async () => "duplicate")).rejects.toThrow();
    await expect(withBothLocks("other", async () => "same-file")).rejects.toThrow();
    expect(await inspectIdLock(f.root, "session-1")).not.toBeNull();
    expect(await inspectIdLock(f.root, "other")).toBeNull();
    expect(await f.leases.get(f.file)).not.toBeNull();
  } finally { finish(); await expect(held).resolves.toBe("done"); }
  expect(await f.leases.get(f.file)).toBeNull();
  expect(await inspectIdLock(f.root, "session-1")).toBeNull();
}, 5000);

it("both locks fail closed on missing identity evidence or file claim failure", async () => {
  const f = await lockFixture();
  expect(control.createBothLocks).toBeTypeOf("function");
  let entered = false;
  const run = async () => { entered = true; };
  const noBoot = control.createBothLocks({ root: f.root, file: async () => f.file, inventory: f.inventory, identity: f.identity, bootId: async () => "" });
  await expect(noBoot("session-1", run)).rejects.toThrow();
  const badInventory: ProcessInventoryPorts = { ...f.inventory, leases: { ...f.leases, claim: async () => { throw new Error("file unavailable"); } } };
  const failedFile = control.createBothLocks({ root: f.root, file: async () => f.file, inventory: badInventory, identity: f.identity, bootId: async () => "boot-fixture" });
  await expect(failedFile("session-1", run)).rejects.toThrow("file unavailable");
  expect(await inspectIdLock(f.root, "session-1")).toBeNull();
  expect(entered).toBe(false);
}, 5000);


it.each([false, true])("shutdown polls exact child identity without depending on an exit event, ignoring signal=%s", async ignore => {
  const f = fixture(), child = spawn(process.execPath, ["-e", `${ignore ? "process.on('SIGTERM', () => {});" : ""} process.send('ready'); setInterval(() => {}, 1000);`],
    { stdio: ["ignore", "ignore", "ignore", "ipc"] });
  const exited = once(child, "exit"), inventory = createProcessInventory(join(f.root, "herdr"));
  try {
    await once(child, "message");
    const process = await inventory.probe(child.pid!);
    expect(process.kind).toBe("live");
    if (process.kind !== "live") throw new Error("child identity unavailable");
    const identity = { bootId: "boot-1", pid: child.pid!, startTime: process.startIdentity };
    const operation = { ...f.operation, id: "retire-child", kind: "session-retire", args: { ...f.operation.args, moveId: "move-1" } };
    let retired = false, waited = false;
    const ports = { journal: f.journal, probe: async () => child.exitCode !== null || child.signalCode !== null ? { kind: "absent" as const } : { kind: "live" as const, identity },
      withBothLocks: async <T>(_id: string, fn: () => Promise<T>) => fn(),
      live: async () => { child.kill("SIGTERM"); return { code: 0 as const, reason: "shutdown-requested", operationId: operation.id, epoch: 2, home: null, repairCommand: null, value: {} }; },
      dormant: async () => { retired = true; return { code: 0 as const, reason: "retired", operationId: operation.id, epoch: 2, home: null, repairCommand: null, value: {} }; },
      exit: { deadline: Date.now() + 200, now: Date.now,
        async exited(owner: typeof identity) { const state = await inventory.probe(owner.pid); return state.kind === "absent" || state.kind === "live" && state.startIdentity !== owner.startTime; },
        async wait() { waited = true; throw new Error("This process does not own the child event"); },
      },
    };
    expect(await control.controlSession(operation, ports)).toMatchObject(ignore ? { code: 3, reason: "process-exit-unproven" } : { code: 0, reason: "retired" });
    expect(retired).toBe(!ignore);
    expect(waited).toBe(false);
    if (!ignore) expect(await inventory.probe(identity.pid)).toEqual({ kind: "absent" });
    else expect(f.journal.lookupOperation(operation.id)?.state).toBe("pending");
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await exited; }
}, 5000);

it("does not retire when the session is absent but the old process has not exited", async () => {
  const f = fixture(), identity = { bootId: "boot-1", pid: 123, startTime: "old-start" };
  const operation = { ...f.operation, id: "retire-unproved", kind: "session-retire", args: { ...f.operation.args, moveId: "move-1" } };
  let requested = false, retired = false, now = 0;
  const deadline = 20;
  const ports: control.SessionControlPorts = { journal: f.journal,
    probe: async () => requested ? { kind: "absent" } : { kind: "live", identity },
    withBothLocks: async (_id, fn) => fn(),
    live: async () => { requested = true; return { code: 0, reason: "shutdown-requested", operationId: operation.id, epoch: 2, home: null, repairCommand: null, value: {} }; },
    dormant: async () => { retired = true; return { code: 0, reason: "retired", operationId: operation.id, epoch: 2, home: null, repairCommand: null, value: {} }; },
    exit: { deadline, now: () => now, async exited(old) { expect(old).toEqual(identity); now = deadline; return false; } },
  };
  expect(await control.controlSession(operation, ports)).toMatchObject({ code: 3, reason: "process-exit-unproven" });
  expect(retired).toBe(false);
}, 5000);

it.each([false, true])("a reused pid is not the old owner, replacement owns session=%s", async replacementOwns => {
  const f = fixture(), identity = { bootId: "boot-1", pid: 123, startTime: "old-start" };
  const operation = { ...f.operation, id: "retire-reused", kind: "session-retire", args: { ...f.operation.args, moveId: "move-1" } };
  let requested = false, retired = false;
  let now = 0;
  const deadline = now + 20, replacement = { ...identity, startTime: "new-start" };
  const ports = { journal: f.journal,
    probe: async () => !requested ? { kind: "live" as const, identity } : replacementOwns ? { kind: "live" as const, identity: replacement } : { kind: "absent" as const },
    withBothLocks: async <T>(_id: string, fn: () => Promise<T>) => fn(),
    live: async () => { requested = true; return { code: 0 as const, reason: "shutdown-requested", operationId: operation.id, epoch: 2, home: null, repairCommand: null, value: {} }; },
    dormant: async () => { retired = true; return { code: 0 as const, reason: "retired", operationId: operation.id, epoch: 2, home: null, repairCommand: null, value: {} }; },
    exit: { deadline, now: () => now, async exited(old: typeof identity) {
      // Advance with the simulated observation, not host scheduling.
      now = deadline;
      return old.bootId === replacement.bootId && old.pid === replacement.pid && old.startTime !== replacement.startTime;
    } },
  };
  expect(await control.controlSession(operation, ports)).toMatchObject(replacementOwns ? { code: 3, reason: "process-exit-unproven" } : { code: 0, reason: "retired" });
  expect(retired).toBe(!replacementOwns);
}, 5000);


it.each([
  { kind: "box-participant", machineId: BOX, hubMachineId: HUB },
  { kind: "hub-return", machineId: HUB, moveId: "move-1" },
  { kind: "hub-restoration", machineId: HUB, moveId: "move-1", revokedMachineId: BOX },
] as const)("persists and preserves $kind intent ownership through stop and resume", async owner => {
  const f = fixture(), authority = control.createRunningIntentAuthority(f.db);
  await authority.set(f.intent, f.operation.id, owner);
  const storedOwner = () => readLocal<{ owner: unknown }>(f.db, "participant-intent", f.intent.sessionId)?.owner;
  expect(storedOwner()).toEqual(owner);
  await authority.stop(f.intent.sessionId);
  expect(storedOwner()).toEqual(owner);
  await authority.resume(f.intent.sessionId, async () => []);
  expect(storedOwner()).toEqual(owner);
}, 5000);

it.each([undefined, { kind: "unknown", machineId: HUB }, { kind: "box-participant", machineId: BOX, hubMachineId: BOX },
  { kind: "hub-return", machineId: "invalid", moveId: "move-1" }, { kind: "hub-restoration", machineId: HUB, moveId: "move-1", revokedMachineId: HUB }])(
  "refuses missing or invalid intent ownership before persisting it: %j", async owner => {
    const f = fixture();
    await expect(control.createRunningIntentAuthority(f.db).set(f.intent, f.operation.id, owner as never)).rejects.toThrow(/owner/i);
    expect(readLocal(f.db, "participant-intent", f.intent.sessionId)).toBeUndefined();
  }, 5000);


it("refuses replacing an intent's recorded owner at the same epoch", async () => {
  const f = fixture(), authority = control.createRunningIntentAuthority(f.db);
  const owner = { kind: "box-participant" as const, machineId: BOX, hubMachineId: HUB };
  await authority.set(f.intent, f.operation.id, owner);
  await expect(authority.set(f.intent, "forged-start", { kind: "hub-return", machineId: HUB, moveId: f.intent.moveId! })).rejects.toThrow(/owner/i);
  expect(readLocal<{ owner: unknown }>(f.db, "participant-intent", f.intent.sessionId)?.owner).toEqual(owner);
}, 5000);

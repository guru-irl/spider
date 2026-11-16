import { readLocal } from "@spider/db-core/roam/local-state";
import { readMoveBindingDiagnostics } from "@spider/roam/move-diagnostics";
import { afterEach, expect, it, vi } from "vitest";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createReplica } from "@spider/db-core/testutil";
import { DEFAULT_LIMITS, disabledIntercom, type RoamConfig } from "@spider/roam/contracts";
import { openFreezeJournal } from "@spider/roam/journal";
import { unboundMoveEffects, moveEffectReason } from "@spider/roam/move-ports";
import { createHostMoveBindings, moveBindingDiagnostics } from "../move-runtime";
import * as hostConfig from "@spider/roam/host-config";
import * as runtime from "@spider/roam/runtime";
import { createMoveActivation } from "../move-activation";
const HUB = "00000000-0000-4000-8000-000000000001";
const fixtures: ReturnType<typeof createReplica>[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const fixture of fixtures.splice(0)) fixture.close(); });
it("a disabled hub does not open a move runtime or control socket", async () => {
  const global = createReplica("global", HUB); fixtures.push(global);
  const config: RoamConfig = { enabled: false, role: "hub", machineId: HUB, hubMachineId: HUB, peers: [], discoveryRoots: [], coreUnit: "fixture", syncMs: 1000, limits: DEFAULT_LIMITS, intercom: disabledIntercom() };
  mkdirSync(join(global.root, "roam"), { mode: 0o700 });
  writeFileSync(join(global.root, "roam", "config.json"), JSON.stringify(config), { mode: 0o600 });
  writeFileSync(join(global.root, "roam", "machine.json"), JSON.stringify({ machineId: HUB }), { mode: 0o600 });
  const open = vi.spyOn(runtime, "openLocalCore").mockImplementation(() => { throw new Error("unexpected runtime open"); });
  const activation = await createMoveActivation({ root: global.root, sessionId: "ordinary", file: "/fixture/session.jsonl", context: () => undefined } as never).catch(() => "opened");
  expect(open).not.toHaveBeenCalled();
  expect(activation).toBeNull();
}, 5000);

it("production composition leaves zero unbound effects", async () => {
  const global = createReplica("global", HUB); fixtures.push(global);
  const config: RoamConfig = { enabled: true, role: "hub", machineId: HUB, hubMachineId: HUB, peers: [], discoveryRoots: [], coreUnit: "fixture", syncMs: 1000, limits: DEFAULT_LIMITS, intercom: disabledIntercom() };
  mkdirSync(join(global.root, "roam"), { mode: 0o700 });
  writeFileSync(join(global.root, "roam", "config.json"), JSON.stringify(config), { mode: 0o600 });
  writeFileSync(join(global.root, "roam", "machine.json"), JSON.stringify({ machineId: HUB }), { mode: 0o600 });
  const journal = openFreezeJournal(join(global.root, "roam", "journal.db"));
  const runtime = await createHostMoveBindings({ root: global.root, globalDb: global.db, config, journal, sessionId: "session-a", transport: {} as never });
  try {
    expect(unboundMoveEffects(runtime.bindings)).toEqual([]);
    expect(moveBindingDiagnostics(runtime.bindings)).toEqual([]);
    expect(readMoveBindingDiagnostics(global.root, join(global.root, "store.db"))).toEqual([]);
    expect(runtime.bindings.participant!.config).toBe(config);
    expect(runtime.bindings.globalDb).toBe(global.db);
    expect(await runtime.bindings.recovery!.workspaceRestores!()).toEqual([]);
  } finally { await runtime.close(); }
}, 5000);
it("the real participant auth port blocks missing pi auth and warns that tools were not checked", async () => {
  const global = createReplica("global", HUB); fixtures.push(global);
  const config: RoamConfig = { enabled: true, role: "hub", machineId: HUB, hubMachineId: HUB, peers: [], discoveryRoots: [], coreUnit: "fixture", syncMs: 1000, limits: DEFAULT_LIMITS, intercom: disabledIntercom() };
  mkdirSync(join(global.root, "roam"), { mode: 0o700 });
  const agentDir = join(global.root, "agent"); mkdirSync(agentDir, { mode: 0o700 });
  vi.spyOn(hostConfig, "loadHerdrConfig").mockReturnValue({ agentDirectory: agentDir } as never);
  const journal = openFreezeJournal(join(global.root, "roam", "journal.db"));
  const runtime = await createHostMoveBindings({ root: global.root, globalDb: global.db, config, journal, sessionId: "session-a", transport: {} as never });
  try {
    expect(await runtime.bindings.participant!.auth()).toEqual([expect.objectContaining({ reason: "pi-auth-missing", severity: "block" })]);
    writeFileSync(join(agentDir, "auth.json"), '{"fixture-provider":{"type":"oauth"}}', { mode: 0o600 });
    expect(await runtime.bindings.participant!.auth()).toEqual([expect.objectContaining({ reason: "tool-auth-unverified", severity: "warning" })]);
  } finally { await runtime.close(); }
}, 5000);

it("a production box waits locally for pushed move evidence and never dials the hub", async () => {
  const BOX = "00000000-0000-4000-8000-000000000002", global = createReplica("global", BOX); fixtures.push(global);
  const config: RoamConfig = { enabled: true, role: "box", machineId: BOX, hubMachineId: HUB, peers: [], discoveryRoots: [], coreUnit: "fixture", syncMs: 1000, limits: DEFAULT_LIMITS, intercom: disabledIntercom() };
  mkdirSync(join(global.root, "roam"), { mode: 0o700 });
  const journal = openFreezeJournal(join(global.root, "roam", "journal.db")), calls: string[] = [];
  const runtime = await createHostMoveBindings({ root: global.root, globalDb: global.db, config, journal, sessionId: "session-a", transport: { async resolve() { calls.push("resolve"); throw new Error("box cannot dial"); } } as never });
  const operation = { id: "retire-a", kind: "session-retire", machineId: BOX, expectedEpoch: 1, args: { sourceMachine: HUB, sessionId: "session-a", moveId: "move-a" } };
  try {
    for (const [name, kind] of [["authorizeAbort", "session-unfreeze"], ["authorizeRetire", "session-retire"], ["rollback", "move-readmit"], ["presentation", "move-cleanup-terminal"]] as const) {
      const request = { ...operation, id: name, kind, args: { ...operation.args, presentation: { status: "complete" } } };
      expect(await runtime.bindings.evidence![name]!(request)).toBeNull();
      expect(await runtime.dispatch(request)).toMatchObject({ code: 3, reason: "waiting-for-hub-evidence" });
      expect(journal.read(request.id)).toEqual([]);
    }
    expect(calls).toEqual([]);
  } finally { await runtime.close(); }
}, 5000);

it("doctor reports every unbound effect", () => {
  const diagnostics = moveBindingDiagnostics({});
  expect(diagnostics.map(item => item.reason)).toEqual(unboundMoveEffects({}).map(effect => moveEffectReason(effect)));
  expect(diagnostics.every(item => item.severity === "block")).toBe(true);
}, 5000);

it("read-only doctor summarizes missing inventory before a production runtime mounts", () => {
  const global = createReplica("global", HUB); fixtures.push(global);
  expect(readMoveBindingDiagnostics(global.root)).toEqual([{ reason: "move-binding-inventory-unavailable", severity: "warning", repairCommand: "spider roam doctor" }]);
  expect(readLocal(global.db, "move-bindings", "inventory")).toBeUndefined();
}, 5000);

it("composition refuses a missing pi instead of launching its own CLI argv", async () => {
  const global = createReplica("global", HUB); fixtures.push(global);
  const config: RoamConfig = { enabled: true, role: "hub", machineId: HUB, hubMachineId: HUB, peers: [], discoveryRoots: [], coreUnit: "fixture", syncMs: 1000, limits: DEFAULT_LIMITS, intercom: disabledIntercom() };
  mkdirSync(join(global.root, "roam"), { mode: 0o700 });
  const journal = openFreezeJournal(join(global.root, "roam", "journal.db"));
  vi.stubEnv("SPIDER_ROAM_PI", join(global.root, "missing-pi"));
  await expect(createHostMoveBindings({ root: global.root, globalDb: global.db, config, journal, sessionId: "session-a", transport: {} as never })).rejects.toThrow("participant-pi-unavailable");
  expect(readMoveBindingDiagnostics(global.root, join(global.root, "store.db"))).toContainEqual(expect.objectContaining({ reason: "participant-pi-unavailable" }));
}, 5000);

it("disabled restore composes without pi but still advertises launch effects as unavailable", async () => {
  const global = createReplica("global", HUB); fixtures.push(global);
  const config: RoamConfig = { enabled: false, role: "hub", machineId: HUB, hubMachineId: HUB, peers: [], discoveryRoots: [], coreUnit: "fixture", syncMs: 1000, limits: DEFAULT_LIMITS, intercom: disabledIntercom() };
  mkdirSync(join(global.root, "roam"), { mode: 0o700 });
  const journal = openFreezeJournal(join(global.root, "roam", "journal.db"));
  vi.stubEnv("SPIDER_ROAM_PI", join(global.root, "missing-pi"));
  const runtime = await createHostMoveBindings({ root: global.root, globalDb: global.db, config, journal, sessionId: "session-a", transport: {} as never,
    operation: { id: "restore-a", kind: "restore-destroyed-home", machineId: HUB, expectedEpoch: 2, args: { sessionId: "session-a" } } });
  try { expect(unboundMoveEffects(runtime.bindings)).toEqual(["participant.pi", "readmitSource", "start"]); }
  finally { await runtime.close(); }
}, 5000);

it("source terminal cleanup rejects a same-pid foreign lock with another start identity", async () => {
  const { claimIdLock } = await import("@spider/herdr/sessions/id-lock");
  const global = createReplica("global", HUB); fixtures.push(global);
  const config: RoamConfig = { enabled: true, role: "hub", machineId: HUB, hubMachineId: HUB, peers: [], discoveryRoots: [], coreUnit: "fixture", syncMs: 1000, limits: DEFAULT_LIMITS, intercom: disabledIntercom() };
  mkdirSync(join(global.root, "roam"), { mode: 0o700 });
  const journal = openFreezeJournal(join(global.root, "roam", "journal.db"));
  const runtime = await createHostMoveBindings({ root: global.root, globalDb: global.db, config, journal, sessionId: "session-a", transport: {} as never });
  const lock = await claimIdLock(join(global.root, "herdr"), "session-a", { pid: 42, startIdentity: "cleanup-start" }, async () => ({ kind: "live", startIdentity: "cleanup-start" }), { bootId: async () => "boot-a" });
  try {
    expect(await lock.isHeldByClaim!()).toBe(true);
    const directory = join(global.root, "herdr", "id-locks"), file = join(directory, readdirSync(directory).find(name => name.endsWith(".json"))!);
    const record = JSON.parse(readFileSync(file, "utf8"));
    writeFileSync(file, JSON.stringify({ ...record, identity: { ...record.identity, startIdentity: "foreign-start" } }), { mode: 0o600 });
    const operation = { id: "cleanup-a", kind: "move-cleanup-terminal", machineId: HUB, expectedEpoch: 1, args: { sessionId: "session-a", moveId: "move-a", presentation: { status: "complete" } } };
    await expect(runtime.bindings.participant!.cleanupTerminal(operation, { owns: () => lock.isHeldByClaim!() })).rejects.toThrow("source-cleanup-lock-changed");
  } finally { await lock.release(); await runtime.close(); }
}, 5000);

it("the hub obtains a box presentation target from that box's guarded readiness", async () => {
  const BOX = "00000000-0000-4000-8000-000000000002", global = createReplica("global", HUB); fixtures.push(global);
  const config: RoamConfig = { enabled: true, role: "hub", machineId: HUB, hubMachineId: HUB, peers: [{ machineId: BOX, alias: "box-1.invalid", node: "/bin/node", pi: "/bin/pi", cli: "/bin/spider", core: "core-a", globalRoot: "/fixture/global" }], discoveryRoots: [], coreUnit: "fixture", syncMs: 1000, limits: DEFAULT_LIMITS, intercom: disabledIntercom() };
  mkdirSync(join(global.root, "roam"), { mode: 0o700 });
  const journal = openFreezeJournal(join(global.root, "roam", "journal.db")), home = { sessionId: "session-a", machineId: BOX, epoch: 2, moveId: "move-a", updatedAt: 1 };
  global.db.prepare("INSERT INTO session_homes VALUES(?,?,?,?,?)").run(home.sessionId, BOX, home.epoch, home.moveId, home.updatedAt);
  const target = { machineId: BOX, alias: null, sessionId: home.sessionId, homeEpoch: home.epoch, coreId: "box-core", terminalId: "box-terminal" }, calls: string[] = [];
  const unused = async (): Promise<never> => { throw new Error("unused transport method"); };
  const transport: import("@spider/roam/contracts").Transport = { resolve: async peer => peer, bootstrapProbe: unused, run: unused, read: unused, write: unused, async exec(peer, argv) {
    const op = JSON.parse(argv[2]); calls.push(op.kind);
    expect(peer.machineId).toBe(BOX); expect(op.args.sessionId).toBe(home.sessionId); expect(op.expectedEpoch).toBe(2);
    return Buffer.from(JSON.stringify({ operationId: op.id, code: 0, epoch: 2, value: target }));
  } };
  const runtime = await createHostMoveBindings({ root: global.root, globalDb: global.db, config, journal, sessionId: "session-a", transport });
  try { expect(await runtime.bindings.handoff!.readyTarget(home)).toEqual(target); expect(calls).toEqual(["move-ready-target"]); }
  finally { await runtime.close(); }
}, 5000);

it("source cleanup rejects a replacement lock token even for the same process identity", async () => {
  const { claimIdLock } = await import("@spider/herdr/sessions/id-lock"), global = createReplica("global", HUB); fixtures.push(global);
  const identity = { pid: 82, startIdentity: "source-start" }, probe = async () => ({ kind: "live" as const, startIdentity: identity.startIdentity });
  const lock = await claimIdLock(join(global.root, "herdr"), "session-a", identity, probe, { bootId: async () => "source-boot" });
  expect(await lock.isHeldByClaim!()).toBe(true); await lock.release();
  const replacement = await claimIdLock(join(global.root, "herdr"), "session-a", identity, probe, { bootId: async () => "source-boot" });
  try { expect(await lock.isHeldByClaim!()).toBe(false); expect(await replacement.isHeldByClaim!()).toBe(true); }
  finally { await replacement.release(); }
}, 5000);

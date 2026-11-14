import { afterEach, expect, it, vi } from "vitest";
import { readLocal } from "@spider/db-core/roam/local-state";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createParticipantAdmission, openAdmissionRuntime } from "../roam/readiness";
import { createRunningIntentAuthority, readReadiness } from "@spider/roam/session-control";
import { openJournal } from "@spider/roam/journal";
import { join } from "node:path";
import { createReplica } from "@spider/db-core/testutil";
import { createParticipantSupervisor } from "@spider/roam/participant-supervisor";
import { DEFAULT_LIMITS } from "@spider/roam/contracts";
import { assignInitialHome } from "@spider/roam/homes";
import { registerAdmission } from "../roam/admission";
import { SessionScheduler } from "../loop/index";
import { createTimeMath } from "../loop/time-math";
import { seedNewParticipant } from "@spider/roam/session-control";

const BOX = "00000000-0000-4000-8000-000000000002", HUB = "00000000-0000-4000-8000-000000000001";
const fixtures: ReturnType<typeof createReplica>[] = [];
afterEach(() => { for (const f of fixtures.splice(0)) f.close(); vi.useRealTimers(); vi.unstubAllEnvs(); });
function fixture() {
  const global = createReplica("global", BOX), worktree = createReplica("worktree", BOX); fixtures.push(global, worktree);
  global.db.prepare("UPDATE roam_meta SET capture_enabled=1 WHERE id=1").run();
  const config = { enabled: false, role: "box" as const, machineId: BOX, hubMachineId: HUB, peers: [], discoveryRoots: [], coreUnit: "fixture.service", syncMs: 120000, limits: DEFAULT_LIMITS };
  return { global, worktree, config, input: { globalDb: global.db, machineId: BOX, sessionId: "new-session", file: join(worktree.root, "session.jsonl"), cwd: worktree.root,
    stores: [{ db: worktree.db, key: worktree.storeKey }], limit: 1024 } };
}

it("new box admission seeds before startup work", () => {
  const { worktree, global, input } = fixture();
  worktree.db.prepare("UPDATE roam_meta SET store_key=NULL,capture_enabled=0 WHERE id=1").run();
  seedNewParticipant(input);
  expect(worktree.db.prepare("SELECT origin_machine FROM sessions WHERE id='new-session'").get()).toEqual({ origin_machine: BOX });
  expect(worktree.db.prepare("SELECT epoch,state FROM roam_sessions WHERE session_id='new-session'").get()).toEqual({ epoch: 1, state: "active" });
  expect(worktree.db.prepare("SELECT store_key,capture_enabled FROM roam_meta").get()).toEqual({ store_key: worktree.storeKey, capture_enabled: 1 });
  expect(worktree.db.prepare("SELECT count(*) AS n FROM roam_versions WHERE entity='sessions'").get()).toEqual({ n: 1 });
  seedNewParticipant(input);
  expect(worktree.db.prepare("SELECT count(*) AS n FROM roam_changes WHERE entity='sessions'").get()).toEqual({ n: 1 });
  expect(global.db.prepare("SELECT stores_json,file,cwd FROM roam_locations WHERE session_id='new-session'").get()).toEqual({ stores_json: JSON.stringify([worktree.storeKey]), file: input.file, cwd: input.cwd });
  const hub = createReplica("global", HUB); fixtures.push(hub);
  expect(assignInitialHome(hub.db, "new-session", BOX, HUB)).toMatchObject({ epoch: 1, machineId: BOX });
}, 5000);

it("box-origin admission before first sync records local provenance without hub intent", async () => {
  const { global, worktree, config, input } = fixture();
  writeFileSync(input.file, JSON.stringify({ type: "session", version: 3, id: input.sessionId, cwd: input.cwd }) + "\n", { mode: 0o600 });
  const journal = openJournal(join(global.root, "roam", "journal.db"));
  const authority = createRunningIntentAuthority(global.db);
  const ports = createParticipantAdmission({
    async open() { return { config,
      db: global.db, journal, authority, async stores() { return input.stores; }, close() {} }; },
    cwd: () => input.cwd, async terminal() { return { core: "core-1", terminal: "term-1", operationId: null, owner: { pid: process.pid, startIdentity: "fixture-owner" } }; },
  });
  await ports.prepare!(input.sessionId, input.file);
  expect(worktree.db.prepare("SELECT state,epoch FROM roam_sessions WHERE session_id=?").get(input.sessionId)).toEqual({ state: "active", epoch: 1 });
  expect(worktree.db.prepare("SELECT capture_enabled FROM roam_meta").get()).toEqual({ capture_enabled: 1 });
  await ports.ready!(input.sessionId, input.file, 1, null);
  expect(readLocal(global.db, "participant-ready", input.sessionId)).toMatchObject({ origin: "box-local", machineId: BOX, sessionId: input.sessionId, core: "core-1", terminal: "term-1", cwd: input.cwd, epoch: 1 });
  expect(readLocal(global.db, "participant-ready", input.sessionId)).not.toHaveProperty("opId");
  expect(readLocal(global.db, "participant-ready", input.sessionId)).not.toHaveProperty("operationId");
  expect(readReadiness(journal, "admission-1")).toBeNull();
  expect(await authority.get(input.sessionId)).toBeNull();
  expect(readLocal(global.db, "participant-origin", input.sessionId)).toMatchObject({ kind: "box-local", machineId: BOX, file: input.file });
  expect(global.db.prepare("SELECT count(*) AS n FROM session_homes").get()).toEqual({ n: 0 });
  let launches = 0;
  const supervisor = createParticipantSupervisor({ root: global.root, agent: { config, journal, root: join(global.root, "roam/staging"), openStore(key: string) { if (key !== "global") throw new Error("must not inspect a session"); return { db: global.db }; } } as never,
    clock: { now: () => 1, later: () => () => {} }, events: { subscribe: () => () => {} }, owner: async () => ({ kind: "absent" }),
    diagnostics: async () => [], stop: async () => ({ kind: "absent" }), notify: async () => {}, async launch() { launches++; throw new Error("must not launch"); } });
  await supervisor.reconcile(); expect(launches).toBe(0); await supervisor.stop();
  await ports.stopped!(input.sessionId);
  expect(readLocal(global.db, "participant-origin", input.sessionId)).toMatchObject({ stopped: true });
  await expect(ports.ready!(input.sessionId, input.file, 1, null)).rejects.toThrow("stopped");
}, 5000);

it("a hub intent does not change an existing box-local owner's provenance on reload", async () => {
  const { global, config, input } = fixture();
  writeFileSync(input.file, JSON.stringify({ type: "session", version: 3, id: input.sessionId, cwd: input.cwd }) + "\n", { mode: 0o600 });
  const journal = openJournal(join(global.root, "roam/journal.db")), authority = createRunningIntentAuthority(global.db);
  const adapter = createParticipantAdmission({ cwd: () => input.cwd, async terminal() { return { core: "core-1", terminal: "term-1", operationId: null, owner: { pid: process.pid, startIdentity: "fixture-owner" } }; },
    async open() { return { config, db: global.db, journal, authority, async stores() { return input.stores; }, close() {} }; } });
  await adapter.prepare(input.sessionId, input.file); await adapter.ready(input.sessionId, input.file, 1, null);
  const home = { sessionId: input.sessionId, machineId: BOX, epoch: 1, moveId: null, updatedAt: 1 };
  global.db.prepare("INSERT INTO session_homes VALUES (?,?,1,NULL,1)").run(input.sessionId, BOX);
  journal.begin({ id: "start-1", kind: "session-start", machineId: BOX, expectedEpoch: 1, args: {} });
  await authority.set({ sessionId: input.sessionId, epoch: 1, desired: "running", suspended: null, file: input.file, cwd: input.cwd, moveId: null }, "start-1", { machineId: BOX, hubMachineId: HUB });
  await adapter.ready(input.sessionId, input.file, 1, home);
  expect(readLocal(global.db, "participant-ready", input.sessionId)).toMatchObject({ origin: "box-local", machineId: BOX, terminal: "term-1" });
  expect(readLocal(global.db, "participant-ready", input.sessionId)).not.toHaveProperty("opId");
  expect(readReadiness(journal, "start-1")).toBeNull();
}, 5000);

it("hub intent without a launch operation or a matching local owner cannot create a receipt", async () => {
  const { global, config, input } = fixture(); seedNewParticipant(input);
  writeFileSync(input.file, JSON.stringify({ type: "session", version: 3, id: input.sessionId, cwd: input.cwd }) + "\n", { mode: 0o600 });
  const home = { sessionId: input.sessionId, machineId: BOX, epoch: 1, moveId: null, updatedAt: 1 };
  global.db.prepare("INSERT INTO session_homes VALUES (?,?,1,NULL,1)").run(input.sessionId, BOX);
  const journal = openJournal(join(global.root, "roam/journal.db")), authority = createRunningIntentAuthority(global.db);
  journal.begin({ id: "start-1", kind: "session-start", machineId: BOX, expectedEpoch: 1, args: {} });
  await authority.set({ sessionId: input.sessionId, epoch: 1, desired: "running", suspended: null, file: input.file, cwd: input.cwd, moveId: null }, "start-1", { machineId: BOX, hubMachineId: HUB });
  const adapter = createParticipantAdmission({ cwd: () => input.cwd, async terminal() { return { core: "core-1", terminal: "term-1", operationId: null, owner: { pid: process.pid, startIdentity: "fixture-owner" } }; },
    async open() { return { config, db: global.db, journal, authority, async stores() { return input.stores; }, close() {} }; } });
  await expect(adapter.ready(input.sessionId, input.file, 1, home)).rejects.toThrow("participant-launch-provenance-unavailable");
  expect(readReadiness(journal, "start-1")).toBeNull();
  expect(readLocal(global.db, "participant-ready", input.sessionId)).toBeUndefined();
}, 5000);

it("a hub-authorized launch records the actual launch operation receipt", async () => {
  const { global, config, input } = fixture(); seedNewParticipant(input);
  writeFileSync(input.file, JSON.stringify({ type: "session", version: 3, id: input.sessionId, cwd: input.cwd }) + "\n", { mode: 0o600 });
  const home = { sessionId: input.sessionId, machineId: BOX, epoch: 1, moveId: null, updatedAt: 1 };
  global.db.prepare("INSERT INTO session_homes VALUES (?,?,1,NULL,1)").run(input.sessionId, BOX);
  const journal = openJournal(join(global.root, "roam/journal.db")), authority = createRunningIntentAuthority(global.db);
  journal.begin({ id: "launch-1", kind: "exact-session-launch", machineId: BOX, expectedEpoch: 1, args: {} });
  await authority.set({ sessionId: input.sessionId, epoch: 1, desired: "running", suspended: null, file: input.file, cwd: input.cwd, moveId: null }, "start-1", { machineId: BOX, hubMachineId: HUB });
  const adapter = createParticipantAdmission({ cwd: () => input.cwd, async terminal() { return { core: "core-1", terminal: "term-1", operationId: "launch-1", owner: { pid: process.pid, startIdentity: "fixture-owner" } }; },
    async open() { return { config, db: global.db, journal, authority, async stores() { return input.stores; }, close() {} }; } });
  await adapter.ready(input.sessionId, input.file, 1, home);
  expect(readReadiness(journal, "launch-1")).toMatchObject({ origin: "hub-operation", opId: "launch-1", sessionId: input.sessionId, epoch: 1, file: input.file, cwd: input.cwd, core: "core-1", terminal: "term-1" });
  expect(readLocal(global.db, "participant-ready", input.sessionId)).toEqual(readReadiness(journal, "launch-1"));
}, 5000);

it("a launch-labeled process without hub intent is not a box-local owner", async () => {
  const { global, config, input } = fixture();
  writeFileSync(input.file, JSON.stringify({ type: "session", version: 3, id: input.sessionId, cwd: input.cwd }) + "\n", { mode: 0o600 });
  const journal = openJournal(join(global.root, "roam/journal.db")), authority = createRunningIntentAuthority(global.db);
  const adapter = createParticipantAdmission({ cwd: () => input.cwd, async terminal() { return { core: "core-1", terminal: "term-1", operationId: "launch-1", owner: { pid: process.pid, startIdentity: "fixture-owner" } }; },
    async open() { return { config, db: global.db, journal, authority, async stores() { return input.stores; }, close() {} }; } });
  await adapter.prepare(input.sessionId, input.file);
  await expect(adapter.ready(input.sessionId, input.file, 1, null)).rejects.toThrow("participant-hub-intent-required");
  expect(readLocal(global.db, "participant-ready", input.sessionId)).toBeUndefined();
}, 5000);

it.each(["box", "hub"] as const)("an uninitialized %s installation creates no hosting runtime", role => {
  const { global, config } = fixture(), machineId = role === "box" ? BOX : HUB;
  mkdirSync(join(global.root, "roam"), { recursive: true, mode: 0o700 });
  writeFileSync(join(global.root, "roam/machine.json"), JSON.stringify({ machineId }), { mode: 0o600 });
  writeFileSync(join(global.root, "roam/config.json"), JSON.stringify({ ...config, machineId, role }), { mode: 0o600 });
  expect(openAdmissionRuntime(global.root, async () => { throw new Error("must not inspect a store"); })).toBeNull();
  expect(existsSync(join(global.root, "spider.db"))).toBe(false);
  expect(existsSync(join(global.root, "roam/journal.db"))).toBe(false);
}, 5000);

it("a hub-assigned home cannot be adopted without hub intent", async () => {
  const { global, worktree, input, config } = fixture(); seedNewParticipant(input);
  global.db.prepare("INSERT INTO session_homes VALUES (?,?,1,NULL,1)").run(input.sessionId, BOX);
  writeFileSync(input.file, JSON.stringify({ type: "session", version: 3, id: input.sessionId, cwd: input.cwd }) + "\n", { mode: 0o600 });
  const journal = openJournal(join(global.root, "roam/journal.db")), authority = createRunningIntentAuthority(global.db);
  const adapter = createParticipantAdmission({ cwd: () => input.cwd, async terminal() { return { core: "core-1", terminal: "term-1", operationId: null, owner: { pid: process.pid, startIdentity: "fixture-owner" } }; },
    async open() { return { config, db: global.db, journal, authority, async stores() { return input.stores; }, close() {} }; } });
  await expect(adapter.ready(input.sessionId, input.file, 1, { sessionId: input.sessionId, machineId: BOX, epoch: 1, moveId: null, updatedAt: 1 })).rejects.toThrow("participant-hub-intent-required");
  expect(await authority.get(input.sessionId)).toBeNull();
  expect(readLocal(global.db, "participant-origin", input.sessionId)).toBeUndefined();
}, 5000);

it("without initialized capture new local admission remains non-roaming", async () => {
  const { global, worktree, input, config } = fixture(); global.db.prepare("UPDATE roam_meta SET capture_enabled=0 WHERE id=1").run();
  const adapter = createParticipantAdmission({ cwd: () => input.cwd, async terminal() { throw new Error("must not observe a terminal"); },
    async open() { return { config, db: global.db, journal: openJournal(join(global.root, "roam/journal.db")), authority: createRunningIntentAuthority(global.db), async stores() { throw new Error("must not initialize a store"); }, close() {} }; } });
  await expect(adapter.prepare(input.sessionId, input.file)).resolves.toBeUndefined();
  expect(worktree.db.prepare("SELECT count(*) AS n FROM sessions").get()).toEqual({ n: 0 });
  expect(readLocal(global.db, "participant-origin", input.sessionId)).toBeUndefined();
}, 5000);

it("box-local admission never overrides a foreign home", async () => {
  vi.stubEnv("PI_SUBAGENT_CHILD", "0");
  const { global, worktree, input, config } = fixture(); seedNewParticipant(input);
  global.db.prepare("INSERT INTO session_homes VALUES (?,?,1,NULL,1)").run(input.sessionId, HUB);
  const home = { sessionId: input.sessionId, machineId: HUB, epoch: 1, moveId: null, updatedAt: 1 };
  const journal = openJournal(join(global.root, "roam/journal.db")), authority = createRunningIntentAuthority(global.db), hooks = new Map<string, any>();
  const adapter = createParticipantAdmission({ cwd: () => input.cwd, async terminal() { throw new Error("must not record readiness"); },
    async open() { return { config, db: global.db, journal, authority, async stores() { return input.stores; }, close() {} }; } });
  const gate = registerAdmission({ on(name: string, handler: unknown) { hooks.set(name, handler); } } as never, { ...adapter,
    expectedEpoch: null, localMachine: async () => BOX, knownParticipant: () => true, warnOnce() {}, lock: async () => { throw new Error("must not lock"); },
    async load() { return { home, states: [{ sessionId: input.sessionId, epoch: 1, state: "active", moveId: null, freezeSeq: null }], origin: BOX,
      participating: true, captureSafe: true, unfinishedFreeze: false, initialConflict: false }; } });
  await hooks.get("session_start")({}, { cwd: input.cwd, sessionManager: { getSessionId: () => input.sessionId, getSessionFile: () => input.file } });
  expect(gate.inspect()).toMatchObject({ kind: "blocked", home, blockers: [{ detail: `This session is at ${HUB}. Run /spider roam doctor for details.` }] });
  expect(readLocal(global.db, "participant-origin", input.sessionId)).toBeUndefined();
  expect(global.db.prepare("SELECT machine_id FROM session_homes").get()).toEqual({ machine_id: HUB });
  await gate.close();
}, 5000);

it("trigger fires once with hub absent after readiness and a restored session", async () => {
  vi.useFakeTimers(); vi.stubEnv("PI_SUBAGENT_CHILD", "0");
  const { global, worktree, input } = fixture(), entries: any[] = [], hooks = new Map<string, any[]>(), deliveries: string[] = [];
  writeFileSync(input.file, JSON.stringify({ type: "session", version: 3, id: input.sessionId, cwd: input.cwd }) + "\n", { mode: 0o600 });
  const pi = { on(name: string, handler: unknown) { hooks.set(name, [...hooks.get(name) ?? [], handler]); },
    appendEntry(customType: string, data: unknown) { entries.push({ type: "custom", customType, data }); },
    sendUserMessage(text: string) { deliveries.push(text); } };
  const ctx = { cwd: input.cwd, mode: "tui", isIdle: () => true, ui: { notify() {} }, sessionManager: {
    getSessionId: () => input.sessionId, getSessionFile: () => input.file, getEntries: () => entries } };
  const first = new SessionScheduler(pi as never, createTimeMath());
  await first.schedule({ delaySeconds: 60, prompt: "local trigger" }, ctx as never); first.shutdown();
  const journal = openJournal(join(global.root, "roam", "journal.db")), authority = createRunningIntentAuthority(global.db);
  const adapter = createParticipantAdmission({ cwd: () => input.cwd, async terminal() { return { core: "core-1", terminal: "term-1", operationId: null, owner: { pid: process.pid, startIdentity: "fixture-owner" } }; },
    async open() { return { db: global.db, journal, authority, config: { machineId: BOX, hubMachineId: HUB, role: "box", enabled: false, limits: { targetBatchBytes: 1024 } } as never,
      async stores() { return input.stores; }, close() {} }; } });
  const gate = registerAdmission(pi as never, { ...adapter, expectedEpoch: null, localMachine: async () => BOX, knownParticipant: () => true, warnOnce() {}, lock: async () => async () => {},
    async load() { return { home: null, states: worktree.db.prepare("SELECT session_id AS sessionId,epoch,state,move_id AS moveId,freeze_seq AS freezeSeq FROM roam_sessions").all() as never,
      origin: BOX, participating: true, captureSafe: true, unfinishedFreeze: false, initialConflict: false }; } });
  const restored = new SessionScheduler(pi as never, createTimeMath(), () => gate.inspect().kind === "ordinary");
  for (const handler of hooks.get("session_start")!) await handler({ reason: "resume" }, ctx);
  restored.start({ reason: "resume" } as never, ctx as never);
  expect(gate.inspect().kind).toBe("ordinary"); expect(await authority.get(input.sessionId)).toBeNull();
  expect(readLocal(global.db, "participant-origin", input.sessionId)).toMatchObject({ kind: "box-local", machineId: BOX });
  vi.advanceTimersByTime(60_000); vi.advanceTimersByTime(60_000);
  expect(deliveries).toHaveLength(1); expect(deliveries[0]).toContain("local trigger");
  restored.shutdown(); await gate.close();
}, 5000);

it.each(["conflict", "foreign-origin", "retired"])("new admission does not override %s", kind => {
  const { global, worktree, input } = fixture();
  if (kind === "conflict") global.db.prepare("INSERT INTO session_homes VALUES (?,'',1,NULL,1)").run("new-session");
  if (kind === "foreign-origin") worktree.db.prepare("INSERT INTO sessions(id,started_at,origin_machine) VALUES (?,?,?)").run("new-session", 1, HUB);
  if (kind === "retired") worktree.db.prepare("INSERT INTO roam_sessions(session_id,epoch,state) VALUES (?,1,'retired')").run("new-session");
  const before = worktree.db.prepare("SELECT * FROM roam_sessions").all();
  expect(() => seedNewParticipant(input)).toThrow();
  expect(worktree.db.prepare("SELECT * FROM roam_sessions").all()).toEqual(before);
  expect(worktree.db.prepare("SELECT count(*) AS n FROM roam_changes").get()).toEqual({ n: 0 });
}, 5000);

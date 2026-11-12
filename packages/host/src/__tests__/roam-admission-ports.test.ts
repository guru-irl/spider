import { afterEach, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { bindSession, openDb, openDbAt, paths, setGlobalDbPathForTests, type Db } from "@spider/db-core";
import * as dbCore from "@spider/db-core";
import { claimIdLock } from "@spider/herdr/sessions/id-lock";
import { openJournal } from "@spider/roam/journal";
import { createAdmissionPorts, registerAdmission } from "../roam/admission";

let root = "";
const initialGlobalRoot = paths.globalRoot;
const dbs: Db[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
  paths.globalRoot = initialGlobalRoot; setGlobalDbPathForTests(null);
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  if (root) rmSync(root, { recursive: true, force: true });
  root = "";
});
function fixture() {
  const base = resolve(".spider/scratch/roam-admission-ports");
  mkdirSync(base, { recursive: true }); root = mkdtempSync(join(base, "case-"));
  const globalRoot = join(root, "global"), cwd = join(root, "current"), bound = join(root, "bound");
  mkdirSync(globalRoot, { recursive: true, mode: 0o700 });
  for (const dir of [cwd, bound]) { mkdirSync(dir, { recursive: true }); execFileSync("git", ["init", "-q", dir]); }
  vi.stubEnv("GIT_CEILING_DIRECTORIES", root); vi.stubEnv("SPIDER_GLOBAL_ROOT", globalRoot);
  paths.globalRoot = globalRoot; setGlobalDbPathForTests(join(globalRoot, "spider.db"));
  const global = openDbAt(join(globalRoot, "spider.db"), "global"); dbs.push(global);
  const machine = (global.prepare("SELECT machine_id FROM roam_meta WHERE id = 1").get() as { machine_id: string }).machine_id;
  const worktree = (dir: string, key: string) => {
    const db = openDbAt(join(dir, ".spider", "project.db"), "worktree"); dbs.push(db);
    db.prepare("UPDATE roam_meta SET store_key = ?, capture_enabled = 1 WHERE id = 1").run(key);
    db.prepare("INSERT INTO sessions(id, reason, started_at, origin_machine) VALUES (?, ?, ?, ?)").run("session-1", "fixture", 1, machine);
    db.prepare("INSERT INTO roam_sessions(session_id, epoch, state) VALUES (?, ?, ?)").run("session-1", 1, "active");
    return db;
  };
  const current = worktree(cwd, "worktree:fixture:current");
  const file = join(root, "session.jsonl");
  writeFileSync(file, JSON.stringify({ type: "session", version: 3, id: "session-1", cwd }) + "\n");
  const identity = { pid: 4242, startIdentity: "start-4242" };
  const probe = async (pid: number) => pid === identity.pid ? { kind: "live" as const, startIdentity: identity.startIdentity } : { kind: "absent" as const };
  const ports = createAdmissionPorts({ identity, probe, bootId: async () => "boot-fixture" });
  const ctx = { cwd, mode: "tui", hasUI: false, ui: { notify() {} }, sessionManager: { getSessionId: () => "session-1", getSessionFile: () => file } } as unknown as ExtensionContext;
  ports.setContext(ctx);
  return { globalRoot, cwd, bound, global, current, file, machine, identity, probe, ports, worktree, ctx };
}

it("reads active membership and origin from the real migrated worktree", async () => {
  const f = fixture();
  const state = await f.ports.load("session-1");
  expect(state).toMatchObject({ participating: true, origin: f.machine, captureSafe: true, initialConflict: false, unfinishedFreeze: false });
  expect(state.states).toEqual([{ sessionId: "session-1", epoch: 1, state: "active", moveId: null, freezeSeq: null }]);
  expect(await f.ports.localMachine()).toBe(f.machine);
}, 5000);

it("checks the separate bound worktree as well as the current worktree", async () => {
  const f = fixture();
  const bound = f.worktree(f.bound, "worktree:fixture:bound");
  bindSession(f.global, "session-1", f.bound);
  let state = await f.ports.load("session-1");
  expect(state.states).toHaveLength(2);
  expect(state.captureSafe).toBe(true);
  bound.prepare("UPDATE roam_sessions SET state = 'retired' WHERE session_id = ?").run("session-1");
  state = await f.ports.load("session-1");
  expect(state.states.map(row => row.state).sort()).toEqual(["active", "retired"]);
}, 5000);

it("an absent membership in an affected bound worktree is not treated as active", async () => {
  const f = fixture();
  const bound = f.worktree(f.bound, "worktree:fixture:bound");
  bound.prepare("DELETE FROM roam_sessions WHERE session_id = ?").run("session-1");
  bindSession(f.global, "session-1", f.bound);
  const state = await f.ports.load("session-1");
  expect(state.participating).toBe(true);
  expect(state.captureSafe).toBe(false);
}, 5000);

it("other journal tables never block admission", async () => {
  const f = fixture();
  expect((await f.ports.load("session-1")).unfinishedFreeze).toBe(false);
  const journal = openDb(join(f.globalRoot, "roam", "journal.db")); dbs.push(journal);
  journal.exec("CREATE TABLE operations(session_id TEXT, state TEXT); INSERT INTO operations VALUES ('session-1', 'pending')");
  expect((await f.ports.load("session-1")).unfinishedFreeze).toBe(false);
  const hooks = new Map<string, Function>();
  const gate = registerAdmission({ on(name: string, handler: Function) { hooks.set(name, handler); } } as unknown as ExtensionAPI, f.ports);
  await hooks.get("session_start")!({ reason: "resume" }, f.ctx);
  expect(gate.inspect().kind).toBe("ordinary");
  await gate.close();
}, 5000);

it("pending operations in the shared journal do not block admission", async () => {
  const f = fixture();
  const journal = openJournal(join(f.globalRoot, "roam", "journal.db"));
  const operation = { id: "op-1", machineId: f.machine, expectedEpoch: 1, kind: "sync", args: { sessionId: "session-1" } };
  journal.begin(operation);
  journal.record(operation.id, "started", { pending: true });
  expect((await f.ports.load("session-1")).unfinishedFreeze).toBe(false);
  const hooks = new Map<string, Function>();
  const gate = registerAdmission({ on(name: string, handler: Function) { hooks.set(name, handler); } } as unknown as ExtensionAPI, f.ports);
  await hooks.get("session_start")!({ reason: "resume" }, f.ctx);
  expect(gate.inspect().kind).toBe("ordinary");
  await gate.close();
}, 5000);

it("unfinished freeze row blocks the participant", async () => {
  const f = fixture();
  const journal = openDb(join(f.globalRoot, "roam", "journal.db")); dbs.push(journal);
  journal.exec("CREATE TABLE freeze_journal(session_id TEXT, state TEXT); INSERT INTO freeze_journal VALUES ('other-session', 'frozen')");
  expect((await f.ports.load("session-1")).unfinishedFreeze).toBe(false);
  journal.exec("INSERT INTO freeze_journal VALUES ('session-1', 'frozen')");
  expect((await f.ports.load("session-1")).unfinishedFreeze).toBe(true);
  const hooks = new Map<string, Function>(), lock = vi.spyOn(f.ports, "lock");
  const gate = registerAdmission({ on(name: string, handler: Function) { hooks.set(name, handler); } } as unknown as ExtensionAPI, f.ports);
  await hooks.get("session_start")!({ reason: "resume" }, f.ctx);
  expect(gate.inspect().kind).toBe("control-only");
  expect(lock).not.toHaveBeenCalled();
  await gate.close();
}, 5000);

it.each(["complete", "aborted"])("complete or aborted freeze rows do not block: %s", async terminal => {
  const f = fixture();
  const journal = openDb(join(f.globalRoot, "roam", "journal.db")); dbs.push(journal);
  journal.exec("CREATE TABLE freeze_journal(session_id TEXT, state TEXT); INSERT INTO freeze_journal VALUES ('other-session', 'frozen')");
  journal.prepare("INSERT INTO freeze_journal VALUES (?, ?)").run("session-1", terminal);
  expect((await f.ports.load("session-1")).unfinishedFreeze).toBe(false);
  const hooks = new Map<string, Function>();
  const gate = registerAdmission({ on(name: string, handler: Function) { hooks.set(name, handler); } } as unknown as ExtensionAPI, f.ports);
  await hooks.get("session_start")!({ reason: "resume" }, f.ctx);
  expect(gate.inspect().kind).toBe("ordinary");
  await gate.close();
}, 5000);

it("SQLite identifier casing does not hide an unfinished freeze", async () => {
  const f = fixture();
  const journal = openDb(join(f.globalRoot, "roam", "journal.db")); dbs.push(journal);
  journal.exec("CREATE TABLE FREEZE_JOURNAL(SESSION_ID TEXT, STATE TEXT); INSERT INTO FREEZE_JOURNAL VALUES ('session-1', 'freezing')");
  expect((await f.ports.load("session-1")).unfinishedFreeze).toBe(true);
}, 5000);

it("a nonterminal row remains blocking alongside a completed row", async () => {
  const f = fixture();
  const journal = openDb(join(f.globalRoot, "roam", "journal.db")); dbs.push(journal);
  journal.exec("CREATE TABLE freeze_journal(session_id TEXT, state TEXT); INSERT INTO freeze_journal VALUES ('session-1', 'complete'), ('session-1', 'freezing')");
  expect((await f.ports.load("session-1")).unfinishedFreeze).toBe(true);
}, 5000);

it.each([null, "COMPLETE", "ABORTED"])("a malformed or nonterminal state %s blocks its session", async state => {
  const f = fixture();
  const journal = openDb(join(f.globalRoot, "roam", "journal.db")); dbs.push(journal);
  journal.exec("CREATE TABLE freeze_journal(session_id TEXT, state TEXT COLLATE NOCASE)");
  journal.prepare("INSERT INTO freeze_journal VALUES (?, ?)").run("session-1", state);
  expect((await f.ports.load("session-1")).unfinishedFreeze).toBe(true);
}, 5000);

it("freeze rows use exact session identity even if the table has a different collation", async () => {
  const f = fixture();
  const journal = openDb(join(f.globalRoot, "roam", "journal.db")); dbs.push(journal);
  journal.exec("CREATE TABLE freeze_journal(session_id TEXT COLLATE NOCASE, state TEXT); INSERT INTO freeze_journal VALUES ('SESSION-1', 'frozen')");
  expect((await f.ports.load("session-1")).unfinishedFreeze).toBe(false);
}, 5000);

it.each([
  "CREATE TABLE freeze_journal(session_id TEXT)",
  "CREATE TABLE freeze_journal(session_id INTEGER, state TEXT)",
  "CREATE TABLE freeze_journal(session_id TEXT, state INTEGER)",
  "CREATE TABLE source_table(session_id TEXT, state TEXT); CREATE VIEW freeze_journal AS SELECT session_id, state FROM source_table",
])("a malformed freeze journal blocks a known participant: %s", async schema => {
  const f = fixture();
  const journal = openDb(join(f.globalRoot, "roam", "journal.db")); dbs.push(journal);
  journal.exec(schema);
  const hooks = new Map<string, Function>(), lock = vi.spyOn(f.ports, "lock");
  const gate = registerAdmission({ on(name: string, handler: Function) { hooks.set(name, handler); } } as unknown as ExtensionAPI, f.ports);
  await hooks.get("session_start")!({ reason: "resume" }, f.ctx);
  expect(f.ports.knownParticipant("session-1")).toBe(true);
  expect(gate.inspect().kind).toBe("blocked");
  expect(lock).not.toHaveBeenCalled();
  await gate.close();
}, 5000);

it("an unreadable freeze journal blocks a known participant", async () => {
  const f = fixture();
  const journalPath = join(f.globalRoot, "roam", "journal.db"), read = dbCore.openDbReadOnlyAt;
  vi.spyOn(dbCore, "openDbReadOnlyAt").mockImplementation(file => {
    if (file === journalPath) throw new Error("SQLITE_BUSY after retries");
    return read(file);
  });
  const hooks = new Map<string, Function>(), lock = vi.spyOn(f.ports, "lock");
  const gate = registerAdmission({ on(name: string, handler: Function) { hooks.set(name, handler); } } as unknown as ExtensionAPI, f.ports);
  await hooks.get("session_start")!({ reason: "resume" }, f.ctx);
  expect(f.ports.knownParticipant("session-1")).toBe(true);
  expect(gate.inspect().kind).toBe("blocked");
  expect(lock).not.toHaveBeenCalled();
  await gate.close();
}, 5000);

it("the empty home marker is an initial conflict, not an assigned home", async () => {
  const f = fixture();
  f.global.prepare("INSERT INTO session_homes(session_id, machine_id, epoch, updated_at) VALUES (?, ?, ?, ?)").run("session-1", "", 1, 1);
  const state = await f.ports.load("session-1");
  expect(state.home).toBeNull();
  expect(state.initialConflict).toBe(true);
  expect(state.participating).toBe(true);
}, 5000);

it("explicit unfreeze rechecks the real session context before reopening", async () => {
  const f = fixture();
  const hooks = new Map<string, Function>();
  const pi = { on(name: string, handler: Function) { hooks.set(name, handler); } } as unknown as ExtensionAPI;
  const gate = registerAdmission(pi, f.ports);
  await hooks.get("session_start")!({ reason: "resume" }, f.ctx);
  expect(gate.inspect().kind).toBe("ordinary");
  await gate.freeze("move-1", 1);
  expect(gate.inspect().kind).toBe("control-only");
  await gate.unfreeze("move-1", 1);
  expect(gate.inspect().kind).toBe("ordinary");
  await gate.close();
}, 5000);

it("a local home remains admitted without a hub connection", async () => {
  const f = fixture();
  f.global.prepare("INSERT INTO session_homes(session_id, machine_id, epoch, updated_at) VALUES (?, ?, ?, ?)").run("session-1", f.machine, 1, 1);
  const hooks = new Map<string, Function>();
  const pi = { on(name: string, handler: Function) { hooks.set(name, handler); } } as unknown as ExtensionAPI;
  const gate = registerAdmission(pi, f.ports);
  await hooks.get("session_start")!({ reason: "resume" }, f.ctx);
  expect(gate.inspect()).toMatchObject({ kind: "ordinary", home: { machineId: f.machine, epoch: 1 } });
  await gate.close();
}, 5000);

it("a worktree read failure cannot hide an existing global home", async () => {
  const f = fixture();
  f.global.prepare("INSERT INTO session_homes(session_id, machine_id, epoch, updated_at) VALUES (?, ?, ?, ?)").run("session-1", f.machine, 1, 1);
  const read = dbCore.openDbReadOnlyAt;
  vi.spyOn(dbCore, "openDbReadOnlyAt").mockImplementation(file => {
    if (file === join(f.cwd, ".spider", "project.db")) throw new Error("SQLITE_BUSY after retries");
    return read(file);
  });
  const hooks = new Map<string, Function>();
  const pi = { on(name: string, handler: Function) { hooks.set(name, handler); } } as unknown as ExtensionAPI;
  const gate = registerAdmission(pi, f.ports);
  await hooks.get("session_start")!({ reason: "resume" }, f.ctx);
  expect(f.ports.knownParticipant("session-1")).toBe(true);
  expect(gate.inspect().kind).toBe("blocked");
  await gate.close();
}, 5000);

it("a missing global store cannot admit a known worktree participant", async () => {
  const f = fixture();
  vi.spyOn(dbCore, "openGlobalReadOnly").mockReturnValue(undefined);
  const hooks = new Map<string, Function>(), lock = vi.spyOn(f.ports, "lock");
  const gate = registerAdmission({ on(name: string, handler: Function) { hooks.set(name, handler); } } as unknown as ExtensionAPI, f.ports);
  await hooks.get("session_start")!({ reason: "resume" }, f.ctx);
  expect(f.ports.knownParticipant("session-1")).toBe(true);
  expect(gate.inspect().kind).toBe("blocked");
  expect(lock).not.toHaveBeenCalled();
  await gate.close();
}, 5000);

it.each(["global", "roster"] as const)("%s read failure cannot hide an existing worktree membership", async failure => {
  const f = fixture();
  if (failure === "global") vi.spyOn(dbCore, "openGlobalReadOnly").mockImplementation(() => { throw new Error("SQLITE_BUSY after retries"); });
  else f.global.prepare("INSERT INTO roam_locations(session_id, stores_json) VALUES (?, ?)").run("session-1", "not-json");
  const hooks = new Map<string, Function>();
  const pi = { on(name: string, handler: Function) { hooks.set(name, handler); } } as unknown as ExtensionAPI;
  const lock = vi.spyOn(f.ports, "lock");
  const gate = registerAdmission(pi, f.ports);
  await hooks.get("session_start")!({ reason: "resume" }, f.ctx);
  expect(f.ports.knownParticipant("session-1")).toBe(true);
  expect(gate.inspect().kind).toBe("blocked");
  expect(lock).not.toHaveBeenCalled();
  await gate.close();
}, 5000);

it("a missing machine identity is an error and is not recreated", async () => {
  const f = fixture();
  await f.ports.load("session-1");
  const file = join(f.globalRoot, "roam", "machine.json");
  unlinkSync(file);
  await expect(f.ports.localMachine()).rejects.toThrow();
  expect(() => unlinkSync(file)).toThrow();
}, 5000);

it("a preclaimed ID lock is adopted by the exact process and boot identity", async () => {
  const f = fixture();
  const lockRoot = join(f.globalRoot, "herdr");
  await f.ports.load("session-1");
  const launcher = await claimIdLock(lockRoot, "session-1", f.identity, f.probe, { bootId: async () => "boot-fixture" });
  const release = await f.ports.lock("session-1", f.file);
  const other = { pid: 4243, startIdentity: "start-4243" };
  await expect(claimIdLock(lockRoot, "session-1", other, f.probe, { bootId: async () => "boot-fixture" })).rejects.toThrow(/owner/i);
  await release();
  const after = await claimIdLock(lockRoot, "session-1", other, async () => ({ kind: "absent" }), { bootId: async () => "boot-fixture" });
  await after.release();
  await launcher.release();
}, 5000);

import { afterEach, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { createReplica, scratchDbPath } from "@spider/db-core/testutil";
import { seedSession } from "@spider/db-core/roam/seed";
import { writeLocal } from "@spider/db-core/roam/local-state";
import { migrate, openDb, openDbReadOnly } from "@spider/db-core";
import { openJournal } from "../journal";
import { V13 } from "../../../db-core/src/__tests__/fixtures/historical-schemas";
import type { DiagnosticStore, LoadedConsumer } from "../diagnostics";
import type { PresenceBuild, PresenceRecord } from "@spider/herdr/sessions/presence";
import type { ProcessProbe } from "@spider/herdr/sessions/lease";
import type { Diagnostic, Peer, RoamConfig } from "../contracts";
import { DEFAULT_LIMITS } from "../contracts";
import * as diagnostics from "../diagnostics";
import { main } from "../cli";

const HUB = "00000000-0000-4000-8000-000000000001";
const BOX = "00000000-0000-4000-8000-000000000002";
const target: PresenceBuild = { sha: "abcdef1", builtAt: "2026-01-02T03:04:05.000Z", version: "1.0.0", dirty: false };
const peer: Peer = { machineId: BOX, alias: "box-1.invalid", node: "/fixture/node", pi: "/fixture/pi", cli: "/fixture/spider", core: "/fixture/hc", globalRoot: "/fixture/global" };
const config = (changes: Partial<RoamConfig> = {}): RoamConfig => ({ enabled: false, role: "hub", machineId: HUB,
  hubMachineId: HUB, peers: [peer], discoveryRoots: [], coreUnit: "core", syncMs: 120_000, limits: DEFAULT_LIMITS, ...changes });
function presence(changes: Partial<PresenceRecord> = {}): PresenceRecord {
  return { version: 1, pid: 101, startIdentity: "start-101", sessionFile: null, sessionId: "session-1" as PresenceRecord["sessionId"], sessionName: null,
    kind: "top-level", mode: "interactive", hcAddress: null, extensionArguments: [], build: target, capabilities: { roamSchema: 14 }, ...changes };
}
function ports() {
  const records = new Map<string, PresenceRecord[]>([[HUB, []], [BOX, []]]);
  const probes = new Map<number, ProcessProbe>();
  const workers = new Map<string, { pid: number; processIdentity: string | null; serverBuild: string | null } | null>();
  const usageProbes = new Map<number, ProcessProbe>();
  const sqlite = new Map<string, { bundled: string; cli: string | null }>();
  const executables: { label: string; file: string }[] = [];
  const badExecutables = new Set<string>();
  const storeFixtures: DiagnosticStore[] = [];
  return {
    records, probes, workers, usageProbes, sqlite, executables, badExecutables, storeFixtures,
    targetBuild: target,
    listPresence: async (machine: { machineId: string }) => records.get(machine.machineId) ?? [],
    probeProcess: async (_machine: { machineId: string }, pid: number): Promise<ProcessProbe> =>
      probes.get(pid) ?? { kind: "live", startIdentity: `start-${pid}` },
    usageWorker: async (machine: { machineId: string }) => workers.get(machine.machineId) ?? null,
    probeUsage: async (_machine: { machineId: string }, pid: number): Promise<ProcessProbe> =>
      usageProbes.get(pid) ?? { kind: "live", startIdentity: `usage-${pid}` },
    bundledSqlite: async (machine: { machineId: string }) => sqlite.get(machine.machineId)?.bundled ?? "3.45.0",
    sqliteCli: async (machine: { machineId: string }) => sqlite.has(machine.machineId) ? sqlite.get(machine.machineId)!.cli : "3.45.0",
    listExecutables: async () => executables,
    executable: async (_machine: { machineId: string }, file: string) => !badExecutables.has(file),
    stores: async () => storeFixtures,
  };
}

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function guard() {
  const fn = (diagnostics as unknown as { assertCompatibleConsumers?: (config: RoamConfig, diagnosticPorts: ReturnType<typeof ports>) => Promise<void> }).assertCompatibleConsumers;
  expect(fn).toBeTypeOf("function");
  return fn!;
}

it("enable refuses an older live top-level build", async () => {
  const p = ports();
  p.records.set(HUB, [presence({ build: { ...target, sha: "1234567" } })]);
  let enableServiceCalls = 0;
  const enable = async () => { await (await guard())(config(), p); enableServiceCalls++; };
  await expect(enable()).rejects.toThrow(/reload|build/i);
  expect(enableServiceCalls).toBe(0);
  p.records.set(HUB, [presence()]);
  await enable();
  expect(enableServiceCalls).toBe(1);
}, 5000);

it("reports the actual loaded build for compatible live pi and usage consumers", async () => {
  const p = ports(); p.records.set(HUB, [presence()]);
  p.workers.set(HUB, { pid: 201, processIdentity: "usage-201", serverBuild: `${target.sha}@${target.builtAt}` });
  const consumers: LoadedConsumer[] = [];
  const rows = await diagnostics.doctorLocal(config(), p, consumers);
  expect(consumers).toEqual([expect.objectContaining({ kind: "pi", pid: 101,
    build: `${target.sha}@${target.builtAt} v${target.version}`, roamSchema: 14 }),
    expect.objectContaining({ kind: "usage", pid: 201, build: `${target.sha}@${target.builtAt}`, roamSchema: null })]);
  expect(rows.some(row => row.severity === "block")).toBe(false);
  await expect((await guard())(config(), p)).resolves.toBeUndefined();
}, 5000);

it("does not expose malformed consumer build metadata", async () => {
  const p = ports(); p.records.set(HUB, [presence({ build: { ...target, sha: "fixtureSensitiveValue" } })]);
  p.workers.set(HUB, { pid: 201, processIdentity: "usage-201", serverBuild: "fixtureSensitiveValue" });
  const consumers: LoadedConsumer[] = [];
  const rows = await diagnostics.doctorLocal(config(), p, consumers);
  expect(consumers.map(consumer => consumer.build)).toEqual(["unmarked", "unmarked"]);
  expect(JSON.stringify({ consumers, rows })).not.toContain("fixtureSensitiveValue");
  await expect((await guard())(config(), p)).rejects.toThrow(/reload|build/i);
  const invalid = { ...target, sha: "fixtureSensitiveValue" }, q = ports();
  q.targetBuild = invalid;
  q.records.set(HUB, [presence({ build: invalid })]);
  await expect((await guard())(config(), q)).rejects.toThrow(/verify|build/i);
}, 5000);

it("refuses matching malformed target and consumer identities", async () => {
  const invalid = { ...target, sha: "fixtureSensitiveValue" }, p = ports();
  p.targetBuild = invalid;
  p.records.set(HUB, [presence({ build: invalid })]);
  await expect((await guard())(config(), p)).rejects.toThrow(/verify|build/i);
}, 5000);

it("legacy missing build capability refuses until reload", async () => {
  const p = ports();
  p.records.set(HUB, [presence({ build: undefined, capabilities: undefined })]);
  await expect((await guard())(config(), p)).rejects.toThrow(/reload|build/i);
  p.records.set(HUB, [presence()]);
  await expect((await guard())(config(), p)).resolves.toBeUndefined();
}, 5000);

it("non-HC top-level sessions are included", async () => {
  const p = ports();
  p.records.set(BOX, [presence({ hcAddress: null, capabilities: { roamSchema: 13 } })]);
  await expect((await guard())(config(), p)).rejects.toThrow(/box-1\.invalid|schema/i);
}, 5000);

it("dead presence does not block", async () => {
  const p = ports();
  p.records.set(HUB, [presence({ build: undefined }), presence({ pid: 102, startIdentity: "old-start", build: undefined })]);
  p.probes.set(101, { kind: "absent" });
  p.probes.set(102, { kind: "live", startIdentity: "recycled-start" });
  await expect((await guard())(config(), p)).resolves.toBeUndefined();
}, 5000);

it("uncertain owner cannot authorize enable", async () => {
  const p = ports();
  p.records.set(HUB, [presence()]);
  p.probes.set(101, { kind: "unknown" });
  await expect((await guard())(config(), p)).rejects.toThrow(/uncertain|verify/i);
}, 5000);

it("malformed live process identity cannot masquerade as a recycled PID", async () => {
  const p = ports();
  p.records.set(HUB, [presence()]);
  p.probes.set(101, { kind: "live", startIdentity: "" });
  await expect((await guard())(config(), p)).rejects.toThrow(/uncertain|verify/i);
  p.records.set(HUB, []);
  p.workers.set(HUB, { pid: 201, processIdentity: "usage-201", serverBuild: `${target.sha}@${target.builtAt}` });
  p.usageProbes.set(201, { kind: "live", startIdentity: "" });
  await expect((await guard())(config(), p)).rejects.toThrow(/uncertain|verify/i);
}, 5000);

it("old usage worker requires reload", async () => {
  const p = ports();
  p.workers.set(BOX, { pid: 201, processIdentity: "usage-201", serverBuild: "1234567@2026-01-02T03:04:05.000Z" });
  await expect((await guard())(config(), p)).rejects.toThrow(/usage|reload/i);
  p.workers.set(BOX, { pid: 201, processIdentity: "usage-201", serverBuild: `${target.sha}@${target.builtAt}` });
  await expect((await guard())(config(), p)).resolves.toBeUndefined();
}, 5000);

it("unreadable presence inventory and legacy live usage workers cannot authorize enable", async () => {
  const p = ports();
  p.listPresence = async () => { throw new Error("unreadable fixture"); };
  await expect((await guard())(config(), p)).rejects.toThrow(/presence|inventory/i);
  const q = ports();
  q.workers.set(HUB, { pid: 201, processIdentity: "usage-201", serverBuild: null });
  await expect((await guard())(config(), q)).rejects.toThrow(/usage|reload/i);
}, 5000);

it("doctor checks bundled and CLI SQLite floors", async () => {
  const p = ports();
  p.sqlite.set(HUB, { bundled: "3.41.9", cli: "3.42.0" });
  await expect((await guard())(config(), p)).rejects.toThrow(/sqlite.*3\.42/i);
  p.sqlite.set(HUB, { bundled: "3.42.0", cli: "3.41.9" });
  await expect((await guard())(config(), p)).rejects.toThrow(/sqlite.*3\.42/i);
  p.sqlite.set(HUB, { bundled: "3.42.0", cli: "3.42.0" });
  await expect((await guard())(config(), p)).resolves.toBeUndefined();
}, 5000);

it("a missing service executable blocks enable", async () => {
  const p = ports();
  p.executables.push({ label: "Node", file: "/fixture/node" });
  p.badExecutables.add("/fixture/node");
  await expect((await guard())(config(), p)).rejects.toThrow(/node|executable/i);
}, 5000);

async function doctor() {
  const fn = (diagnostics as unknown as { doctorLocal?: (config: RoamConfig, diagnosticPorts: ReturnType<typeof ports>) => Promise<readonly Diagnostic[]> }).doctorLocal;
  expect(fn).toBeTypeOf("function");
  return fn!;
}

it("reports the SQLite 3.38 disabled-store floor separately from the capture floor", async () => {
  const p = ports();
  p.sqlite.set(HUB, { bundled: "3.42.0", cli: "3.37.9" });
  const old = await (await doctor())(config(), p);
  expect(old.some(d => /sqlite3.*3\.38.*migrated/i.test(d.reason))).toBe(true);
  p.sqlite.set(HUB, { bundled: "3.42.0", cli: "3.38.0" });
  const disabled = await (await doctor())(config(), p);
  expect(disabled.some(d => /sqlite3.*3\.38.*migrated/i.test(d.reason))).toBe(false);
  const enabled = await (await doctor())(config({ enabled: true }), p);
  expect(enabled.some(d => d.severity === "block" && /sqlite3.*3\.42.*capture/i.test(d.reason))).toBe(true);
}, 5000);

it("a box with hub scheduling disabled still reports capture prerequisites as blocking", async () => {
  const p = ports(); p.sqlite.set(BOX, { bundled: "3.41.9", cli: "3.41.9" });
  const rows = await diagnostics.doctorLocal(config({ enabled: false, role: "box", machineId: BOX, hubMachineId: HUB, peers: [] }), p);
  expect(rows).toEqual(expect.arrayContaining([
    expect.objectContaining({ severity: "block", reason: expect.stringMatching(/Bundled SQLite.*3\.42/) }),
    expect.objectContaining({ severity: "block", reason: expect.stringMatching(/sqlite3 CLI.*3\.42.*capture/) }),
  ]));
}, 5000);

it("a non-roamable store is informational while roaming is disabled", async () => {
  const root = mkdtempSync(join(dirname(scratchDbPath("roam-duplicate")), "roam-duplicate-"));
  roots.push(root);
  const db = openDb(join(root, "project.db"));
  try {
    db.exec(V13.worktree);
    db.raw.pragma("user_version = 13");
    db.exec("INSERT INTO todos(id,session_id,seq,text,created_at) VALUES (17,'session-a',1,'first',1), (29,'session-a',1,'second',1)");
    migrate(db, "worktree", { machineId: HUB, globalRoot: root });
    const p = ports();
    p.storeFixtures.push({ key: "worktree:fixture:workspace", scope: "worktree", db });
    const before = db.prepare("SELECT roamable, problem, capture_enabled FROM roam_meta").get();
    const rows = await (await doctor())(config(), p);
    const issue = rows.find(row => /not roamable/i.test(row.reason));
    expect(issue?.severity).toBe("warning");
    expect(issue?.reason).toMatch(/information|disabled/i);
    expect(issue?.reason).toContain("17");
    expect(issue?.reason).toContain("29");
    expect(db.prepare("SELECT roamable, problem, capture_enabled FROM roam_meta").get()).toEqual(before);
    expect(db.prepare("SELECT id, seq, text FROM todos ORDER BY id").all()).toEqual([{ id: 17, seq: 1, text: "first" }, { id: 29, seq: 1, text: "second" }]);
    const enabled = await (await doctor())(config({ enabled: true }), p);
    expect(enabled.some(row => row.severity === "block" && /not roamable/i.test(row.reason))).toBe(true);
  } finally { db.close(); }
}, 5000);

it("reports the recorded reason when a store is not roamable", async () => {
  const worktree = createReplica("worktree", HUB);
  try {
    worktree.db.prepare("UPDATE roam_meta SET roamable=0, problem=?").run("replica identity requires review");
    const p = ports(); p.storeFixtures.push({ key: worktree.storeKey, scope: "worktree", db: worktree.db });
    const before = worktree.db.prepare("SELECT roamable,problem FROM roam_meta").get();
    const rows = await (await doctor())(config(), p);
    expect(rows.find(row => /not roamable/i.test(row.reason))).toMatchObject({ severity: "warning", reason: expect.stringContaining("replica identity requires review") });
    expect(worktree.db.prepare("SELECT roamable,problem FROM roam_meta").get()).toEqual(before);
  } finally { worktree.close(); }
}, 5000);

it("does not expose untrusted private text in a recorded store problem", async () => {
  const worktree = createReplica("worktree", HUB);
  try {
    worktree.db.prepare("UPDATE roam_meta SET roamable=0, problem=?").run("credential fixture-sensitive-value");
    const p = ports(); p.storeFixtures.push({ key: worktree.storeKey, scope: "worktree", db: worktree.db });
    const rows = await (await doctor())(config(), p);
    expect(rows.some(row => /not roamable/i.test(row.reason))).toBe(true);
    expect(rows.map(row => row.reason).join(" ")).not.toContain("fixture-sensitive-value");
    worktree.db.prepare("UPDATE roam_meta SET problem=?").run("Roaming trigger layout drift: fixtureSensitiveValue");
    const forged = await (await doctor())(config(), p);
    expect(forged.map(row => row.reason).join(" ")).not.toContain("fixtureSensitiveValue");
  } finally { worktree.close(); }
}, 5000);

it("late local writer reports epoch without memory repair", async () => {
  const worktree = createReplica("worktree", HUB), global = createReplica("global", HUB);
  try {
    global.db.prepare("INSERT INTO global_memory(uuid,category,content,created_at) VALUES (?,?,?,1)").run("memory-path", "insight", "Tool is in /home/fixture/bin");
    global.db.prepare("INSERT INTO global_memory(uuid,category,content,created_at) VALUES (?,?,?,1)").run("memory-portable", "insight", "Use the portable build command");
    const memoryBeforeDoctor = global.db.prepare("SELECT uuid,content,machine_id,status FROM global_memory ORDER BY uuid").all();
    worktree.db.prepare("INSERT INTO sessions(id,name,started_at) VALUES ('session-late','before',1)").run();
    expect(seedSession(worktree.db, "session-late", 7, worktree.storeKey, 4_194_304).complete).toBe(true);
    const barrier = (worktree.db.prepare("SELECT max(seq) AS seq FROM roam_changes").get() as { seq: number }).seq;
    worktree.db.prepare("UPDATE sessions SET name='after' WHERE id='session-late'").run();
    worktree.db.prepare("UPDATE roam_sessions SET state='frozen', freeze_seq=? WHERE session_id='session-late'").run(barrier);
    const changesBefore = worktree.db.prepare("SELECT seq,writer_epoch,change_id FROM roam_changes ORDER BY seq").all();
    const p = ports();
    p.storeFixtures.push({ key: worktree.storeKey, scope: "worktree", db: worktree.db }, { key: "global", scope: "global", db: global.db });
    const rows = await (await doctor())(config({ enabled: true }), p);
    const diagnostic = rows.find(row => /late.*writer/i.test(row.reason));
    expect(diagnostic?.writerEpoch).toBe(7);
    expect(diagnostic?.reason).toContain("session-late");
    expect(diagnostic?.reason).toMatch(/epoch 7/i);
    expect(rows.some(row => row.reason.includes("memory-path"))).toBe(true);
    expect(rows.some(row => row.reason.includes("memory-portable"))).toBe(false);
    expect(rows.map(row => row.reason).join(" ")).not.toContain("/home/fixture/bin");
    const memoryAfterDoctor = global.db.prepare("SELECT uuid,content,machine_id,status FROM global_memory ORDER BY uuid").all();
    expect(memoryAfterDoctor).toEqual(memoryBeforeDoctor);
    expect(worktree.db.prepare("SELECT seq,writer_epoch,change_id FROM roam_changes ORDER BY seq").all()).toEqual(changesBefore);
  } finally { worktree.close(); global.close(); }
}, 5000);

it("status reads homes, cursors, backlog, warnings, operations, and observation age without writes", async () => {
  const global = createReplica("global", HUB), worktree = createReplica("worktree", HUB);
  const journalFile = join(global.root, "roam", "journal.db");
  try {
    global.db.prepare("INSERT INTO session_homes(session_id,machine_id,epoch,move_id,updated_at) VALUES ('session-a',?,3,NULL,100)").run(BOX);
    writeLocal(global.db, "hub-peer", BOX, { since: 500, unreachable: { id: "notice-a", delivered: true, clearing: false },
      suspensions: [{ id: "notice-b", delivered: true, clearing: false, sessionId: "session-a", epoch: 3 }] });
    worktree.db.prepare("INSERT INTO sessions(id,name,started_at) VALUES ('session-a','before',1)").run();
    expect(seedSession(worktree.db, "session-a", 3, worktree.storeKey, 4_194_304).complete).toBe(true);
    worktree.db.prepare("UPDATE sessions SET name='after' WHERE id='session-a'").run();
    const stream = (worktree.db.prepare("SELECT stream_id FROM roam_meta").get() as { stream_id: string }).stream_id;
    worktree.db.prepare("INSERT INTO roam_cursors(peer_machine,peer_stream,last_seq) VALUES (?,?,?)")
      .run(BOX, "00000000-0000-4000-8000-000000000003", 4);
    openJournal(journalFile).begin({ id: "op-1", machineId: BOX, expectedEpoch: null, kind: "sync", args: {} });
    const globalRead = openDbReadOnly(global.db.raw.name)!, storeRead = openDbReadOnly(worktree.db.raw.name)!, journalRead = openDbReadOnly(journalFile)!;
    try {
      const before = {
        global: global.db.prepare("SELECT * FROM roam_cursors ORDER BY peer_machine,peer_stream").all(),
        changes: worktree.db.prepare("SELECT * FROM roam_changes ORDER BY seq").all(),
        journal: journalRead.prepare("SELECT * FROM roam_operations ORDER BY operation_id").all(),
      };
      const fn = (diagnostics as unknown as { readStatus?: (config: RoamConfig, ports: unknown) => unknown }).readStatus;
      expect(fn).toBeTypeOf("function");
      const result = fn!(config({ enabled: true }), { globalDb: globalRead,
        stores: [{ key: worktree.storeKey, scope: "worktree", db: storeRead }], journalDb: journalRead, now: 5_000,
        observations: [{ machineId: BOX, observedAt: 1_200, connected: false, lastSyncAt: 1_000,
          cursors: [{ storeKey: worktree.storeKey, stream, through: 1 }] }] }) as {
            homes: unknown[]; stores: Array<{ key: string; changes: number; logBytes: number; cursors: unknown[] }>;
            peers: Array<{ backlog: number | null; observationAgeMs: number | null; connected: boolean | null; lastSyncAt: number | null }>;
            warnings: unknown[]; suspensions: unknown[]; incompleteOperations: unknown[]; cached: boolean;
          };
      expect(result.cached).toBe(true);
      expect(result.homes).toEqual([{ sessionId: "session-a", machineId: BOX, epoch: 3, moveId: null, updatedAt: 100 }]);
      expect(result.stores[0].key).toBe(worktree.storeKey);
      expect(result.stores[0].changes).toBe(2);
      expect(result.stores[0].logBytes).toBeGreaterThan(0);
      expect(result.stores[0].cursors).toEqual([{ machineId: BOX, stream: "00000000-0000-4000-8000-000000000003", through: 4 }]);
      expect(result.peers[0]).toMatchObject({ backlog: 1, observationAgeMs: 3_800, connected: false, lastSyncAt: 1_000 });
      expect(result.warnings).toEqual(expect.arrayContaining([expect.objectContaining({ machineId: BOX, kind: "unreachable" })]));
      expect(result.suspensions).toEqual(expect.arrayContaining([expect.objectContaining({ machineId: BOX, sessionId: "session-a", epoch: 3 })]));
      expect(result.incompleteOperations).toEqual([expect.objectContaining({ id: "op-1", machineId: BOX, kind: "sync" })]);
      expect(global.db.prepare("SELECT * FROM roam_cursors ORDER BY peer_machine,peer_stream").all()).toEqual(before.global);
      expect(worktree.db.prepare("SELECT * FROM roam_changes ORDER BY seq").all()).toEqual(before.changes);
      expect(journalRead.prepare("SELECT * FROM roam_operations ORDER BY operation_id").all()).toEqual(before.journal);
    } finally { globalRead.close(); storeRead.close(); journalRead.close(); }
  } finally { global.close(); worktree.close(); }
}, 5000);

it("status reports unknown observations and backlog instead of inventing a healthy peer", () => {
  const global = createReplica("global", HUB), worktree = createReplica("worktree", HUB);
  try {
    const fn = (diagnostics as unknown as { readStatus?: (config: RoamConfig, ports: unknown) => unknown }).readStatus;
    expect(fn).toBeTypeOf("function");
    const result = fn!(config(), { globalDb: global.db, stores: [{ key: worktree.storeKey, scope: "worktree", db: worktree.db }],
      journalDb: null, now: 5_000, observations: [] }) as { peers: Array<{ backlog: number | null; observationAgeMs: number | null; connected: boolean | null; lastSyncAt: number | null }> };
    expect(result.peers[0]).toMatchObject({ backlog: null, observationAgeMs: null, connected: null, lastSyncAt: null });
  } finally { global.close(); worktree.close(); }
}, 5000);

it("local doctor reports a disabled registered duplicate store without touching data", async () => {
  const root = mkdtempSync(join(dirname(scratchDbPath("roam-cli-duplicate")), "roam-cli-duplicate-"));
  roots.push(root);
  vi.stubEnv("SPIDER_GLOBAL_ROOT", root);
  vi.stubEnv("HOME", root);
  const global = openDb(join(root, "spider.db")), project = openDb(join(root, "project.db"));
  try {
    migrate(global, "global", { machineId: HUB, globalRoot: root });
    project.exec(V13.worktree);
    project.raw.pragma("user_version = 13");
    project.exec("INSERT INTO todos(id,session_id,seq,text,created_at) VALUES (17,'session-a',1,'first',1), (29,'session-a',1,'second',1)");
    migrate(project, "worktree", { machineId: HUB, globalRoot: root });
    global.prepare("INSERT INTO projects(project_key,real_path,db_path,created_at,last_seen_at) VALUES (?,?,?,1,1)")
      .run("fixture-project", root, project.raw.name);
    const files = [global.raw.name, `${global.raw.name}-wal`, `${global.raw.name}-shm`, project.raw.name, `${project.raw.name}-wal`, `${project.raw.name}-shm`];
    const hashes = () => files.map(file => existsSync(file) ? createHash("sha256").update(readFileSync(file)).digest("hex") : null);
    const before = hashes();
    const out: string[] = [], err: string[] = [];
    const exit = await main(["roam", "doctor"], { out: text => out.push(text), err: text => err.push(text) });
    expect(exit).toBe(0);
    expect(out.join("")).toMatch(/information.*not roamable/i);
    expect(out.join("")).toContain("17,29");
    expect(out.join("")).not.toContain("first");
    expect(err).toEqual([]);
    expect(hashes()).toEqual(before);
  } finally { project.close(); global.close(); }
}, 5000);

it("local doctor reports the sqlite3 CLI floor even when roaming is disabled", async () => {
  const root = mkdtempSync(join(dirname(scratchDbPath("roam-cli-sqlite")), "roam-cli-sqlite-"));
  roots.push(root);
  vi.stubEnv("SPIDER_GLOBAL_ROOT", root);
  vi.stubEnv("HOME", root);
  vi.stubEnv("PATH", root);
  writeFileSync(join(root, "sqlite3"), "#!/bin/sh\nprintf '3.37.9\\n'\n", { mode: 0o700 });
  const out: string[] = [], err: string[] = [];
  const exit = await main(["roam", "doctor"], { out: text => out.push(text), err: text => err.push(text) });
  expect(exit).toBe(0);
  expect(out.join("")).toMatch(/sqlite3.*3\.38.*migrated/i);
  expect(err).toEqual([]);
  expect(existsSync(join(root, "roam"))).toBe(false);
}, 5000);

it("local doctor detects a removed service Node without running launchctl", async () => {
  const root = mkdtempSync(join(dirname(scratchDbPath("roam-node")), "roam-node-"));
  roots.push(root);
  vi.stubEnv("SPIDER_GLOBAL_ROOT", root);
  vi.stubEnv("HOME", root);
  const directory = join(root, "Library", "LaunchAgents");
  mkdirSync(directory, { recursive: true });
  const service = join(directory, "com.spider.roam.hub.plist");
  const cli = join(root, "spider");
  writeFileSync(cli, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  const definition = `<plist><dict><key>ProgramArguments</key><array><string>${root}/missing-node</string><string>${cli}</string><string>roam</string><string>hub</string></array></dict></plist>`;
  writeFileSync(service, definition, { mode: 0o600 });
  const out: string[] = [], err: string[] = [];
  const exit = await main(["roam", "doctor"], { out: text => out.push(text), err: text => err.push(text) });
  expect(exit).toBe(0);
  expect(out.join("")).toMatch(/node.*executable.*missing/i);
  expect(readFileSync(service, "utf8")).toBe(definition);
  expect(err).toEqual([]);
}, 5000);

it("doctor works on an empty local root without creating data", async () => {
  const root = mkdtempSync(join(dirname(scratchDbPath("roam-doctor")), "roam-doctor-"));
  roots.push(root);
  vi.stubEnv("SPIDER_GLOBAL_ROOT", root);
  vi.stubEnv("HOME", root);
  const out: string[] = [], err: string[] = [];
  const exit = await main(["roam", "doctor"], { out: text => out.push(text), err: text => err.push(text) });
  expect(exit).toBe(0);
  expect(out.join("")).toMatch(/roam.*disabled/i);
  expect(err).toEqual([]);
  expect(existsSync(join(root, "roam"))).toBe(false);
  expect(existsSync(join(root, "spider.db"))).toBe(false);
}, 5000);

it("reports every trigger name in a long drift diagnosis", async () => {
  const root = mkdtempSync(join(dirname(scratchDbPath("roam-drift-all")), "roam-drift-all-")); roots.push(root);
  vi.stubEnv("SPIDER_GLOBAL_ROOT", root); vi.stubEnv("HOME", root);
  const global = openDb(join(root, "spider.db")), project = openDb(join(root, "project.db"));
  try {
    migrate(global, "global", { machineId: HUB, globalRoot: root });
    migrate(project, "worktree", { machineId: HUB, globalRoot: root });
    global.prepare("INSERT INTO projects(project_key,real_path,db_path,created_at,last_seen_at) VALUES (?,?,?,1,1)").run("fixture-project", root, project.raw.name);
    const names = (project.prepare("SELECT name FROM sqlite_master WHERE type='trigger' ORDER BY name").all() as { name: string }[]).map(row => row.name);
    expect(names.join(", ").length).toBeGreaterThan(512);
    for (const name of names) project.exec(`DROP TRIGGER "${name.replaceAll('"', '""')}"`);
    const out: string[] = [], err: string[] = [];
    expect(await main(["roam", "doctor"], { out: text => out.push(text), err: text => err.push(text) })).toBe(0);
    for (const name of names) expect(out.join(""), name).toContain(name);
    expect(err).toEqual([]);
  } finally { project.close(); global.close(); }
}, 5000);

it("trigger drift reports disabled capture without repair", async () => {
  const root = mkdtempSync(join(dirname(scratchDbPath("roam-drift")), "roam-drift-"));
  roots.push(root);
  vi.stubEnv("SPIDER_GLOBAL_ROOT", root);
  vi.stubEnv("HOME", root);
  const db = openDb(join(root, "spider.db"));
  try {
    migrate(db, "global", { machineId: "00000000-0000-4000-8000-000000000001", globalRoot: root });
    const trigger = "roam_global_memory_capture_ai";
    db.exec(`DROP TRIGGER ${trigger}`);
    const before = db.prepare("SELECT capture_enabled, roamable, problem FROM roam_meta").get();
    const out: string[] = [], err: string[] = [];
    const exit = await main(["roam", "doctor"], { out: text => out.push(text), err: text => err.push(text) });
    expect(exit).toBe(0);
    expect(out.join("")).toContain(trigger);
    expect(out.join("")).toMatch(/capture.*disabled/i);
    expect(err).toEqual([]);
    expect(db.prepare("SELECT capture_enabled, roamable, problem FROM roam_meta").get()).toEqual(before);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = ?").get(trigger)).toBeUndefined();
  } finally { db.close(); }
}, 5000);

import { afterEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { migrate, openDb } from "@spider/db-core";
import { scratchDbPath } from "@spider/db-core/testutil";
import { writeLocal } from "@spider/db-core/roam/local-state";
import { enableMemoryCapture, seedSession } from "@spider/db-core/roam/seed";
import { HerdrError } from "@spider/herdr/client/parse";
import type { HcClient } from "@spider/herdr/contracts";
import { parsePaneTarget } from "@spider/herdr/panes/codec";
import { createPanePlacementStore } from "@spider/herdr/panes/store";
import { createRoamPlacement, rememberRoamSlot } from "@spider/herdr/roam-placement";
import type { TerminalRegistry } from "@spider/herdr/sessions/registry";
import { main } from "../cli";
import { openJournal } from "../journal";
import { writeEnabledConfig } from "./fixtures/enabled-config";

const HUB = "00000000-0000-4000-8000-000000000001", BOX = "00000000-0000-4000-8000-000000000002";
const key = "worktree:fixture-repo:fixture-workspace";
const roots: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(): string {
  const root = mkdtempSync(join(dirname(scratchDbPath("roam-status")), "roam-status-")); roots.push(root);
  vi.stubEnv("HOME", root); vi.stubEnv("SPIDER_GLOBAL_ROOT", root); vi.stubEnv("PATH", root);
  return root;
}
function configure(root: string, enabled = true): void {
  writeEnabledConfig(root, { enabled, peers: [{ machineId: BOX, alias: "box-1.invalid", node: "/fixture/node",
    pi: "/fixture/pi", cli: "/fixture/spider", core: "/fixture/hc", globalRoot: "/fixture/global" }] });
}
function snapshot(root: string, directory = root): Array<[string, string]> {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? snapshot(root, path) : [[relative(root, path), createHash("sha256").update(readFileSync(path)).digest("hex")] as [string, string]];
  }).sort((a, b) => a[0].localeCompare(b[0]));
}

it("reports real cached status and leaves stores, sidecars, journal and config unchanged", async () => {
  const root = fixture(); configure(root);
  const global = openDb(join(root, "spider.db")), project = openDb(join(root, "project.db"));
  try {
    migrate(global, "global", { machineId: HUB, globalRoot: root });
    migrate(project, "worktree", { machineId: HUB, globalRoot: root });
    global.prepare("INSERT INTO projects(project_key,real_path,db_path,created_at,last_seen_at) VALUES (?,?,?,1,1)").run("fixture-project", root, project.raw.name);
    global.prepare("INSERT INTO session_homes(session_id,machine_id,epoch,move_id,updated_at) VALUES ('session-a',?,3,NULL,100)").run(BOX);
    global.prepare("INSERT INTO session_homes(session_id,machine_id,epoch,move_id,updated_at) VALUES ('conflict','',1,NULL,100)").run();
    project.prepare("INSERT INTO sessions(id,name,started_at) VALUES ('session-a','before',1)").run();
    expect(seedSession(project, "session-a", 3, key, 4_194_304).complete).toBe(true);
    project.prepare("UPDATE sessions SET name='after' WHERE id='session-a'").run();
    const globalStream = (global.prepare("SELECT stream_id FROM roam_meta").get() as { stream_id: string }).stream_id;
    const projectStream = (project.prepare("SELECT stream_id FROM roam_meta").get() as { stream_id: string }).stream_id;
    const head = (project.prepare("SELECT max(seq) AS head FROM roam_changes").get() as { head: number }).head;
    writeLocal(global, "sync-peer", BOX, { failures: 0, pulled: true, targetBytes: 4_194_304, pending: {}, observation: {
      machineId: BOX, observedAt: Date.now() - 4_000, connected: true, lastSyncAt: Date.now() - 5_000,
      cursors: [{ storeKey: "global", stream: globalStream, through: 0 }, { storeKey: key, stream: projectStream, through: head - 1 }],
    } });
    writeLocal(global, "hub-peer", BOX, { since: 500, unreachable: { id: "notice-a", delivered: true, clearing: false },
      suspensions: [{ id: "notice-b", delivered: true, clearing: false, sessionId: "session-a", epoch: 3 }] });
    const journal = openJournal(join(root, "roam", "journal.db"));
    journal.begin({ id: "op-1", machineId: BOX, expectedEpoch: null, kind: "sync", args: {} });
    journal.begin({ id: "op-2", machineId: BOX, expectedEpoch: null, kind: "sync", args: {} });
    journal.record("op-2", "done", { ok: true });
    const allocated = (table: string) => {
      const names = new Set((project.prepare("SELECT name FROM sqlite_master WHERE tbl_name=?").all(table) as { name: string }[]).map(row => row.name));
      return (project.prepare("SELECT name,pgsize FROM dbstat").all() as { name: string; pgsize: number }[])
        .filter(row => names.has(row.name)).reduce((total, row) => total + row.pgsize, 0);
    };
    const expectedLogBytes = allocated("roam_changes"), expectedVersionBytes = allocated("roam_versions");
    const before = snapshot(root), out: string[] = [], err: string[] = [];
    const exit = await main(["roam", "status", "--json"], { out: text => out.push(text), err: text => err.push(text) });
    expect(exit).toBe(0); expect(err).toEqual([]);
    const status = JSON.parse(out.join(""));
    expect(status).toMatchObject({ enabled: true, cached: true, homes: [{ sessionId: "session-a", machineId: BOX, epoch: 3 }],
      homeConflicts: ["conflict"], incompleteOperations: [expect.objectContaining({ id: "op-1", machineId: BOX })] });
    expect(status.peers[0]).toMatchObject({ machineId: BOX, connected: true, backlog: 1 });
    expect(status.peers[0].lastSyncAt).toBeGreaterThan(0);
    expect(status.peers[0].observationAgeMs).toBeGreaterThanOrEqual(4_000);
    expect(status.stores).toContainEqual(expect.objectContaining({ key, changes: head,
      logBytes: expectedLogBytes, versionBytes: expectedVersionBytes }));
    expect(status.warnings).toContainEqual({ machineId: BOX, kind: "unreachable" });
    expect(status.suspensions).toContainEqual({ machineId: BOX, sessionId: "session-a", epoch: 3 });
    expect(snapshot(root)).toEqual(before);
  } finally { project.close(); global.close(); }
}, 5000);

it("shows the last local supervisor refusal without treating it as a current failure", async () => {
  const root=fixture();configure(root);
  const db=openDb(join(root,"spider.db"));
  try {
    migrate(db,"global",{machineId:HUB,globalRoot:root});
    writeLocal(db,"relocate-supervisor-refusal","session\u001b-a",{
      code:"session-busy",message:"Pause\nremaining work.",nextStep:"Close pi, then rerun relocate.",
    });
  } finally {db.close();}
  const out:string[]=[], io={out:(text:string)=>out.push(text),err:()=>{}};
  const reason="Last supervisor refusal for session?-a (session-busy): Pause?remaining work. Close pi, then rerun relocate.";
  expect(await main(["roam","status","--json"],io)).toBe(0);
  expect(JSON.parse(out.join("")).diagnostics).toContainEqual(expect.objectContaining({severity:"warning",reason}));
  out.length=0;
  expect(await main(["roam","status"],io)).toBe(0);
  expect(out.join("")).toContain(reason);
});

it("includes verified unmapped replicas in doctor and status without touching their files", async () => {
  const root = fixture(), directory = join(root, "roam", "stores"), replicaKey = "repo:fixture-repo";
  configure(root);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = join(directory, `${createHash("sha256").update(replicaKey).digest("hex")}.db`);
  const global = openDb(join(root, "spider.db")), repo = openDb(file);
  try {
    migrate(global, "global", { machineId: HUB, globalRoot: root });
    migrate(repo, "repo", { machineId: HUB, globalRoot: root });
    enableMemoryCapture(repo, replicaKey);
    repo.exec("DROP TRIGGER roam_memory_capture_ai");
    const before = snapshot(root), out: string[] = [], err: string[] = [];
    expect(await main(["roam", "doctor"], { out: text => out.push(text), err: text => err.push(text) })).toBe(1);
    expect(out.join("")).toContain("roam_memory_capture_ai");
    expect(out.join("")).toMatch(/capture.*unsafe/i);
    expect(err).toEqual([]);
    expect(snapshot(root)).toEqual(before);
    out.length = 0;
    expect(await main(["roam", "status", "--json"], { out: text => out.push(text), err: text => err.push(text) })).toBe(0);
    expect(JSON.parse(out.join("")).stores).toContainEqual(expect.objectContaining({ key: replicaKey }));
    expect(snapshot(root)).toEqual(before);
  } finally { repo.close(); global.close(); }
}, 5000);

it("includes mapped worktrees through the original catalog path", async () => {
  const root = fixture(), checkout = join(root, "checkout"), directory = join(checkout, ".spider");
  configure(root);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const global = openDb(join(root, "spider.db")), project = openDb(join(directory, "project.db"));
  try {
    migrate(global, "global", { machineId: HUB, globalRoot: root });
    migrate(project, "worktree", { machineId: HUB, globalRoot: root });
    global.prepare("INSERT INTO roam_workspace_maps(repo_key,workspace_id,path) VALUES ('fixture-repo','fixture-workspace',?)").run(checkout);
    project.prepare("INSERT INTO sessions(id,name,started_at) VALUES ('session-a','fixture',1)").run();
    expect(seedSession(project, "session-a", 1, key, 4_194_304).complete).toBe(true);
    project.exec("DROP TRIGGER roam_sessions_capture_ai");
    const before = snapshot(root), out: string[] = [], err: string[] = [];
    expect(await main(["roam", "doctor"], { out: text => out.push(text), err: text => err.push(text) })).toBe(1);
    expect(out.join("")).toContain("roam_sessions_capture_ai");
    expect(err).toEqual([]); expect(snapshot(root)).toEqual(before);
    out.length = 0;
    expect(await main(["roam", "status", "--json"], { out: text => out.push(text), err: text => err.push(text) })).toBe(0);
    expect(JSON.parse(out.join("")).stores).toContainEqual(expect.objectContaining({ key }));
    expect(snapshot(root)).toEqual(before);
  } finally { project.close(); global.close(); }
}, 5000);

it("doctor inspects a redirected mapped store and reports a cached peer failure", async () => {
  const root = fixture(); configure(root);
  const global = openDb(join(root, "spider.db")), project = openDb(join(root, "relocated.db"));
  try {
    migrate(global, "global", { machineId: HUB, globalRoot: root });
    migrate(project, "worktree", { machineId: HUB, globalRoot: root });
    global.prepare("INSERT INTO roam_workspace_maps(repo_key,workspace_id,path) VALUES ('fixture-repo','fixture-workspace',?)").run(join(root, "checkout"));
    writeLocal(global, "mapping-redirect", key, project.raw.name);
    writeLocal(global, "sync-peer", BOX, { observation: { machineId: BOX, observedAt: Date.now() - 10,
      connected: null, lastSyncAt: null, cursors: [], failure: "Peer command failed (spawn_failed)" } });
    project.prepare("INSERT INTO sessions(id,started_at) VALUES ('session-a',1)").run();
    expect(seedSession(project, "session-a", 1, key, 4_194_304).complete).toBe(true);
    project.exec("DROP TRIGGER roam_sessions_capture_ai");
    const before = snapshot(root), out: string[] = [], err: string[] = [];
    expect(await main(["roam", "doctor"], { out: text => out.push(text), err: text => err.push(text) })).toBe(1);
    expect(out.join("")).toContain("roam_sessions_capture_ai");
    expect(out.join("")).toContain("spawn_failed");
    expect(err).toEqual([]);
    expect(snapshot(root)).toEqual(before);
  } finally { project.close(); global.close(); }
}, 5000);

it("does not hide an unverifiable replica from status or doctor", async () => {
  const root = fixture(), directory = join(root, "roam", "stores"), replicaKey = "repo:fixture-repo";
  configure(root);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const target = join(directory, `${createHash("sha256").update(replicaKey).digest("hex")}.db`);
  const source = join(root, "source.db"), global = openDb(join(root, "spider.db")), repo = openDb(source);
  try {
    migrate(global, "global", { machineId: HUB, globalRoot: root });
    migrate(repo, "repo", { machineId: HUB, globalRoot: root });
    enableMemoryCapture(repo, replicaKey);
    copyFileSync(source, target); copyFileSync(`${source}-wal`, `${target}-wal`); // Deliberately omit the index.
    const before = snapshot(root), out: string[] = [], err: string[] = [];
    expect(await main(["roam", "status", "--json"], { out: text => out.push(text), err: text => err.push(text) })).toBe(0);
    expect(JSON.parse(out.join(""))).toMatchObject({ cached: true, complete: false,
      diagnostics: [expect.objectContaining({ severity: "warning", reason: expect.stringMatching(/cannot inspect.*store.*WAL index is missing.*opening or closing/i) })] });
    expect(snapshot(root)).toEqual(before);
    out.length = 0;
    expect(await main(["roam", "doctor"], { out: text => out.push(text), err: text => err.push(text) })).toBe(1);
    expect(out.join("")).toMatch(/cannot inspect.*store.*WAL index is missing.*opening or closing/i);
    expect(err).toEqual([]); expect(snapshot(root)).toEqual(before);
  } finally { repo.close(); global.close(); }
}, 5000);

it("does not report a complete inventory when a mapped store is unavailable", async () => {
  const root = fixture(), global = openDb(join(root, "spider.db"));
  configure(root);
  try {
    migrate(global, "global", { machineId: HUB, globalRoot: root });
    const path = join(root, "corrupt-checkout"); mkdirSync(join(path, ".spider"), { recursive: true });
    writeFileSync(join(path, ".spider", "project.db"), "not sqlite");
    global.prepare("INSERT INTO roam_workspace_maps(repo_key,workspace_id,path) VALUES ('fixture-repo','fixture-workspace',?)").run(path);
    const before = snapshot(root), out: string[] = [], err: string[] = [];
    expect(await main(["roam", "status", "--json"], { out: text => out.push(text), err: text => err.push(text) })).toBe(0);
    expect(JSON.parse(out.join(""))).toMatchObject({ cached: true, available: true, complete: false,
      diagnostics: [expect.objectContaining({ reason: expect.stringMatching(/cannot inspect/i) })] });
    expect(snapshot(root)).toEqual(before);
    out.length = 0;
    expect(await main(["roam", "doctor"], { out: text => out.push(text), err: text => err.push(text) })).toBe(1);
    expect(out.join("")).toMatch(/cannot inspect.*store/i);
    expect(err).toEqual([]); expect(snapshot(root)).toEqual(before);
  } finally { global.close(); }
}, 5000);

it("status reports a missing mapped store as an ungathered warning", async () => {
  const root = fixture(), global = openDb(join(root, "spider.db")); configure(root);
  try {
    migrate(global, "global", { machineId: HUB, globalRoot: root });
    global.prepare("INSERT INTO roam_workspace_maps(repo_key,workspace_id,path) VALUES ('fixture-repo','fixture-workspace',?)").run(join(root, "missing-checkout"));
    const before = snapshot(root), out: string[] = [], err: string[] = [];
    expect(await main(["roam", "status", "--json"], { out: text => out.push(text), err: text => err.push(text) })).toBe(0);
    expect(JSON.parse(out.join(""))).toMatchObject({ cached: true, available: true, complete: false, diagnostics: [
      expect.objectContaining({ severity: "warning", reason: expect.stringMatching(/^store-missing:worktree:enoent:/), repairCommand: expect.stringContaining("Restore or mount") }),
    ] });
    expect(snapshot(root)).toEqual(before); expect(err).toEqual([]);
  } finally { global.close(); }
}, 5000);

it("status and doctor show the cached broken peer without contacting it", async () => {
  const root = fixture(); configure(root); const global = openDb(join(root, "spider.db"));
  try {
    migrate(global, "global", { machineId: HUB, globalRoot: root });
    writeLocal(global, "sync-peer", BOX, { observation: { machineId: BOX, observedAt: Date.now() - 10,
      connected: null, lastSyncAt: null, cursors: [], failure: "Peer command failed (spawn_failed)" } });
    const out: string[] = [], err: string[] = [], io = { out: (text: string) => out.push(text), err: (text: string) => err.push(text) };
    expect(await main(["roam", "status", "--json"], io)).toBe(0);
    expect(JSON.parse(out.join("")).peers[0]).toMatchObject({ failure: "Peer command failed (spawn_failed)" });
    out.length = 0;
    expect(await main(["roam", "status"], io)).toBe(0);
    expect(out.join("")).toContain("spawn_failed");
    out.length = 0;
    expect(await main(["roam", "doctor"], io)).toBe(1);
    expect(out.join("")).toContain("spawn_failed");
    expect(err).toEqual([]);
  } finally { global.close(); }
}, 5000);

it("does not present malformed cached observations as a healthy connection", async () => {
  const root = fixture(); configure(root); const global = openDb(join(root, "spider.db"));
  try {
    migrate(global, "global", { machineId: HUB, globalRoot: root });
    writeLocal(global, "sync-peer", BOX, { observation: { machineId: BOX, observedAt: Date.now() + 60_000,
      connected: true, lastSyncAt: null, cursors: [] } });
    const before = snapshot(root), out: string[] = [], err: string[] = [];
    expect(await main(["roam", "status", "--json"], { out: text => out.push(text), err: text => err.push(text) })).toBe(0);
    expect(JSON.parse(out.join(""))).toMatchObject({ complete: false,
      peers: [expect.objectContaining({ machineId: BOX, connected: null, backlog: null, observationAgeMs: null })],
      diagnostics: [expect.objectContaining({ reason: expect.stringMatching(/observation.*invalid/i) })] });
    expect(err).toEqual([]); expect(snapshot(root)).toEqual(before);
  } finally { global.close(); }
}, 5000);

it("reports incomplete operations as unknown when the journal cannot be read", async () => {
  const root = fixture(); configure(root); const global = openDb(join(root, "spider.db"));
  try {
    migrate(global, "global", { machineId: HUB, globalRoot: root });
    writeFileSync(join(root, "roam", "journal.db"), "not a database", { mode: 0o600 });
    const before = snapshot(root), out: string[] = [], err: string[] = [];
    expect(await main(["roam", "status", "--json"], { out: text => out.push(text), err: text => err.push(text) })).toBe(0);
    expect(JSON.parse(out.join(""))).toMatchObject({ complete: false, incompleteOperations: null });
    expect(err).toEqual([]); expect(snapshot(root)).toEqual(before);
  } finally { global.close(); }
}, 5000);

it("doctor shows an actual failed proxy launch and clears it after a successful retry", async () => {
  const path = process.env.PATH, root = fixture(), directory = join(root, "roam", "placement");
  vi.stubEnv("PATH", path);
  configure(root);
  await rememberRoamSlot(directory, "session-a", { space: "s1", tab: "tb1" } as Parameters<typeof rememberRoamSlot>[2]);
  let calls = 0;
  const hc = {
    async identity() { return { coreId: "local-core" }; },
    async run() {
      calls++;
      if (calls === 1) throw new HerdrError("missing-hc", "fixture launch did not start", { pid: undefined });
      return { address: "proxy-1", coreId: "local-core" };
    },
    events() { return { ready: Promise.resolve(), subscribe(callback: (event: unknown) => void) {
      queueMicrotask(() => callback({ type: "snapshot", terminals: [] })); return () => {};
    } }; },
  } as unknown as HcClient;
  const registry = { async list() { return []; } } as unknown as TerminalRegistry;
  const store = createPanePlacementStore(directory);
  await store.update(state => ({ ...state, attempts: [{ session: "session-a", remote: "box-1.invalid/t1", core: "remote-core", proxy: null, closed: false, localOwners: [], failure: { attempts: 1, retryable: true } }] }));
  const delegated: unknown[] = [];
  let available = false;
  const target = parsePaneTarget({ coreId: "remote-core", terminalId: "t1", address: "remote-core/t1", createdMs: 10, identityLabels: { "spider.session": "session-a", "spider.generation": "gen-1" }, alias: "box-1.invalid", machineId: null, kind: "session", sessionId: "session-a", generation: "gen-1", homeEpoch: 1, runId: null, consoleId: null, name: null, cwd: "/fixture" });
  const placement = createRoamPlacement({ hc, app: null, registry, hcBinary: join(root, "fixture-hc"), stateRoot: directory, presentation: {
    resolveTarget: async () => target,
    async presentReadyTarget(target) { delegated.push({ target, slot: (await store.read()).slots[0] }); return { status: available ? "complete" : "pending", reason: "service", presentation: null }; },
  } });
  const row = { origin: "hub-operation" as const, opId: "op-1", sessionId: "session-a", epoch: 1, cwd: "/fixture", file: "/fixture/session.jsonl", core: "remote-core", terminal: "box-1.invalid/t1" };
  expect(await placement.reconcile([row])).toEqual({ pending: ["box-1.invalid/t1"] });
  expect(delegated).toEqual([{ target, slot: { session: "session-a", space: "s1", tab: "tb1" } }]);
  expect(calls).toBe(0);
  const before = snapshot(root), output: string[] = [];
  expect(await main(["roam", "doctor"], { out: text => output.push(text), err: text => output.push(text) })).toBe(1);
  expect(output.join("")).toMatch(/session-a.*proxy.*retry/i);
  expect(snapshot(root)).toEqual(before);
  available = true;
  expect(await placement.reconcile([row])).toEqual({ pending: [] });
  expect(delegated).toEqual([{ target, slot: { session: "session-a", space: "s1", tab: "tb1" } }, { target, slot: { session: "session-a", space: "s1", tab: "tb1" } }]);
  output.length = 0;
  expect(await main(["roam", "doctor"], { out: text => output.push(text), err: text => output.push(text) })).toBe(1);
  expect(output.join("")).not.toMatch(/session-a.*proxy/i);
}, 5000);

it("doctor reports failed and uncertain proxy placement without changing its state", async () => {
  const root = fixture(), directory = join(root, "roam", "placement");
  configure(root);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const attempt = (session: string, remote: string, failure: { attempts: number; retryable: boolean }) =>
    ({ session, remote, core: "remote-core", proxy: null, closed: false, localOwners: [], failure });
  writeFileSync(join(directory, "roam-placement.json"), JSON.stringify({ version: 1, slots: [], attempts: [
    attempt("retry-session", "box-1.invalid/t1", { attempts: 1, retryable: true }),
    attempt("exhausted-session", "box-1.invalid/t2", { attempts: 2, retryable: true }),
    attempt("unknown-session", "box-1.invalid/t3", { attempts: 1, retryable: false }),
  ] }), { mode: 0o600 });
  const before = snapshot(root), out: string[] = [], err: string[] = [];
  expect(await main(["roam", "doctor"], { out: text => out.push(text), err: text => err.push(text) })).toBe(1);
  expect(out.join("")).toMatch(/retry-session.*proxy.*retry/i);
  expect(out.join("")).toMatch(/exhausted-session.*proxy.*retries.*stopped/i);
  expect(out.join("")).toMatch(/unknown-session.*proxy.*uncertain/i);
  expect(err).toEqual([]);
  expect(snapshot(root)).toEqual(before);
}, 5000);

it("shows disabled, unavailable cached state without creating files", async () => {
  const root = fixture(), out: string[] = [], err: string[] = [];
  expect(await main(["roam", "status"], { out: text => out.push(text), err: text => err.push(text) })).toBe(0);
  expect(out.join("")).toMatch(/roam.*disabled/i);
  expect(out.join("")).toMatch(/cached/i);
  expect(out.join("")).toMatch(/unavailable|unknown/i);
  expect(err).toEqual([]);
  expect(existsSync(join(root, "roam"))).toBe(false);
  expect(existsSync(join(root, "spider.db"))).toBe(false);
}, 5000);


it("shows launch causes and terminal status in doctor and cached status", async () => {
  const root = fixture(); configure(root, false);
  const global = openDb(join(root, "spider.db"));
  try {
    migrate(global, "global", { machineId: HUB, globalRoot: root });
    writeLocal(global, "supervisor-hosting-error", "session-local", { code: "supervisor-hosting-error", check: "launch", since: 1,
      count: 3, causeCode: "launch-pending", exitCode: 23 });
    writeLocal(global, "peer-hosting-warnings", BOX, [{ sessionId: "session-remote", code: "supervisor-hosting-error", check: "launch", since: 1,
      count: 1, causeCode: "participant-exited-before-readiness", signal: 9 }]);
    for (const command of ["doctor", "status"]) {
      const out: string[] = [];
      await main(["roam", command, "--json"], { out: text => out.push(text), err() {} });
      const parsed = JSON.parse(out.join("")), diagnostics = command === "doctor" ? parsed.value.diagnostics : parsed.diagnostics;
      expect(diagnostics).toContainEqual(expect.objectContaining({ code: "supervisor-hosting-error", severity: "warning",
        reason: expect.stringMatching(/session-local.*launch-pending.*exit code 23/) }));
      if (command === "status") expect(diagnostics).toContainEqual(expect.objectContaining({ code: "supervisor-hosting-error",
        reason: expect.stringMatching(/session-remote.*participant-exited-before-readiness.*signal 9/) }));
    }
  } finally { global.close(); }
});

it.each([true, false])("shows non-stopping hosting warnings in doctor and text and JSON status without modifying state; enabled=%s", async enabled => {
  const root = fixture(); configure(root, enabled);
  const global = openDb(join(root, "spider.db"));
  try {
    migrate(global, "global", { machineId: HUB, globalRoot: root });
    const warning = { code: "supervisor-hosting-error", check: "restart", since: 1, count: 3 };
    writeLocal(global, "supervisor-hosting-error", "session-local", warning);
    writeLocal(global, "peer-hosting-warnings", BOX, [{ ...warning, sessionId: "session-remote" }]);
    const before = snapshot(root);
    for (const command of [["status", "--json"], ["status"], ["doctor", "--json"]]) {
      const out: string[] = [];
      await main(["roam", ...command], { out: text => out.push(text), err() {} });
      const text = out.join("");
      expect(text).toContain("supervisor-hosting-error");
      expect(text).toContain("restart");
      expect(text).toContain("session-local");
      if (command[0] === "status") expect(text).toContain("session-remote");
      if (command.includes("--json")) {
        const parsed = JSON.parse(text), report = command[0] === "doctor" ? parsed.value : parsed;
        expect(report.diagnostics).toContainEqual(expect.objectContaining({ code: "supervisor-hosting-error", severity: "warning", repairCommand: null,
          reason: expect.stringMatching(/session-local.*supervisor-hosting-error.*restart/) }));
        if (command[0] === "status") expect(report.suspensions).toEqual([]);
      }
      expect(snapshot(root)).toEqual(before);
    }
  } finally { global.close(); }
});


it("shows safe inspection causes and legacy guidance in doctor and cached status", async () => {
  const root = fixture(); configure(root, false);
  const global = openDb(join(root, "spider.db"));
  try {
    migrate(global, "global", { machineId: HUB, globalRoot: root });
    writeLocal(global, "supervisor-hosting-error", "session-local", { code: "supervisor-hosting-error", check: "inspection", since: 1,
      count: 3, causeCode: "EACCES" });
    writeLocal(global, "peer-hosting-warnings", BOX, [{ sessionId: "session-remote", code: "supervisor-hosting-error", check: "inspection", since: 1,
      count: 3, causeCode: "participant-capture-uninitialized" }]);
    const before = snapshot(root);
    for (const command of ["doctor", "status"]) {
      const out: string[] = [];
      await main(["roam", command, "--json"], { out: text => out.push(text), err() {} });
      const parsed = JSON.parse(out.join("")), diagnostics = command === "doctor" ? parsed.value.diagnostics : parsed.diagnostics;
      expect(diagnostics).toContainEqual(expect.objectContaining({ code: "supervisor-hosting-error", severity: "warning",
        reason: expect.stringMatching(/session-local.*inspection.*EACCES.*roaming-upgrade\.md#settle-old-work-only-after-approval/), repairCommand: "spider roam doctor" }));
      if (command === "status") expect(diagnostics).toContainEqual(expect.objectContaining({ code: "supervisor-hosting-error",
        reason: expect.stringMatching(/session-remote.*participant-capture-uninitialized.*roaming-upgrade\.md#settle-old-work-only-after-approval/), repairCommand: "spider roam doctor" }));
      expect(snapshot(root)).toEqual(before);
    }
  } finally { global.close(); }
});

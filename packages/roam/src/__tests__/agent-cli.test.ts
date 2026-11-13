import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { migrate, openDb } from "@spider/db-core";
import { buildRoamEntries } from "../../../../scripts/build-roam.mjs";
import { stageArtifact, transferArtifact } from "../artifacts";
import { DEFAULT_LIMITS, type Peer, type Transport } from "../contracts";
import { openJournal } from "../journal";

const HUB = "00000000-0000-4000-8000-000000000001";
const BOX = "00000000-0000-4000-8000-000000000002";
const roots: string[] = [];
let built: string;
beforeAll(async () => {
  built = mkdtempSync(join(resolve(".spider/scratch"), "agent-build-"));
  await buildRoamEntries(join(built, "roam"));
});
afterAll(() => rmSync(built, { recursive: true, force: true }));
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture(identity = BOX, assigned = true, role: "hub" | "box" = "box") {
  const root = mkdtempSync(join(resolve(".spider/scratch"), "agent-cli-")); roots.push(root);
  mkdirSync(join(root, "roam"), { mode: 0o700 });
  const machineId = role === "hub" ? HUB : BOX;
  const peers = role === "hub" ? [{ machineId: BOX, alias: "-box-1.invalid", node: process.execPath, pi: process.execPath,
    cli: join(built, "roam", "cli.mjs"), core: process.execPath, globalRoot: root }] : [];
  writeFileSync(join(root, "roam", "machine.json"), JSON.stringify({ machineId: identity }), { mode: 0o600 });
  writeFileSync(join(root, "roam", "config.json"), JSON.stringify({ enabled: false, role, machineId,
    hubMachineId: HUB, peers, discoveryRoots: [], coreUnit: "fixture" }), { mode: 0o600 });
  const db = openDb(join(root, "spider.db"));
  migrate(db, "global", { machineId, globalRoot: root });
  if (assigned) db.prepare("UPDATE roam_meta SET store_key='global'").run();
  db.prepare("INSERT INTO global_memory(uuid,category,content,created_at) VALUES ('memory-a','insight','portable',1)").run();
  const env = { ...process.env, HOME: root, SPIDER_GLOBAL_ROOT: root };
  const invoke = (args: string[], input?: Buffer, override: NodeJS.ProcessEnv = {}) => spawnSync(process.execPath, [join(built, "roam", "cli.mjs"), ...args], {
    cwd: root, env: { ...env, ...override }, input, encoding: "utf8", timeout: 3000,
  });
  return { root, db, invoke };
}

it.each([
  ["agent", ["roam", "agent", "{}"]],
  ["artifact receiver", ["roam", "artifact", "receive", "{}"]],
])("the private %s exits successfully after writing a refusal envelope", (_name, argv) => {
  const f = fixture();
  try {
    const result = f.invoke(argv);
    expect(JSON.parse(result.stdout)).toMatchObject({ code: 2 });
    expect(result.status, result.stderr).toBe(0);
  } finally { f.db.close(); }
}, 5000);

it("the packaged agent enables global capture and replays its durable result", () => {
  const f = fixture();
  try {
    const operation = { id: "enable-1", machineId: BOX, expectedEpoch: null, kind: "enable-capture", args: { storeKey: "global" } };
    const first = f.invoke(["roam", "agent", JSON.stringify(operation)]);
    expect(first.status, first.stderr).toBe(0);
    expect(JSON.parse(first.stdout)).toMatchObject({ code: 0, operationId: "enable-1", value: { enabled: true, storeKey: "global" } });
    expect(f.db.prepare("SELECT capture_enabled FROM roam_meta").get()).toEqual({ capture_enabled: 1 });
    expect(f.db.prepare("SELECT entity,row_key FROM roam_changes").all()).toEqual([{ entity: "global_memory", row_key: "memory-a" }]);
    const repeated = f.invoke(["roam", "agent", JSON.stringify(operation)]);
    expect(repeated.status, repeated.stderr).toBe(0);
    expect(JSON.parse(repeated.stdout)).toEqual(JSON.parse(first.stdout));
    expect(f.db.prepare("SELECT count(*) AS count FROM roam_changes").get()).toEqual({ count: 1 });
    const changed = f.invoke(["roam", "agent", JSON.stringify({ ...operation, kind: "stores", args: {} })]);
    expect(changed.status).toBe(0);
    expect(JSON.parse(changed.stdout)).toMatchObject({ code: 2, operationId: "enable-1" });
    expect(f.db.prepare("SELECT count(*) AS count FROM roam_changes").get()).toEqual({ count: 1 });
  } finally { f.db.close(); }
}, 5000);

it("the packaged agent receives verified raw artifact chunks from the hub", async () => {
  const f = fixture();
  try {
    const source = join(f.root, "source"), staging = join(f.root, "source-staging");
    const bytes = Buffer.from([0, 255, 10, 128, 1, 2, 3, 4, 5]);
    writeFileSync(source, bytes);
    const limits = { ...DEFAULT_LIMITS, chunkBytes: 4, retryDelaysMs: [] };
    const manifest = await stageArtifact(source, "session", limits, { root: staging, artifactId: "artifact-1" });
    const peer: Peer = { machineId: BOX, alias: "-box-1.invalid", node: process.execPath, pi: process.execPath,
      cli: join(built, "roam", "cli.mjs"), core: process.execPath, globalRoot: f.root };
    const transport: Transport = {
      async resolve(value) { return value; },
      async exec(_peer, argv, options) {
        const result = f.invoke(["--global-root", f.root, ...argv], options.stdin, { SPIDER_GLOBAL_ROOT: join(f.root, "wrong") });
        if (result.status !== 0) throw new Error(`agent exit ${result.status}: ${result.stderr}`);
        return Buffer.from(result.stdout);
      },
      async read() { throw new Error("unexpected read"); },
      async write() { throw new Error("unexpected write"); },
      async run() { throw new Error("unexpected run"); },
    };
    const journal = openJournal(join(f.root, "source-journal.db"));
    const result = await transferArtifact(peer, manifest, { transport, journal, limits, root: staging, operationId: "transfer-1" });
    expect(result.code, result.reason).toBe(0);
    const received = readFileSync(result.value!.file);
    expect(received).toEqual(bytes);
    expect(createHash("sha256").update(received).digest("hex")).toBe(manifest.sha256);
    const repeated = await transferArtifact(peer, manifest, { transport, journal, limits, root: staging, operationId: "transfer-1" });
    expect(repeated).toEqual(result);
  } finally { f.db.close(); }
}, 5000);

it("the packaged agent rechecks diagnosed duplicate todos before clearing roamable", () => {
  const f = fixture(), directory = join(f.root, "worktree"); mkdirSync(directory);
  const file = join(directory, "project.db"), key = "worktree:fixture:workspace";
  const worktree = openDb(file);
  try {
    migrate(worktree, "worktree", { machineId: BOX, globalRoot: f.root });
    worktree.exec("UPDATE roam_meta SET store_key='worktree:fixture:workspace'; DROP INDEX idx_todos_session_seq");
    worktree.exec("INSERT INTO todos(id,session_id,seq,text,created_at) VALUES (1,'session',1,'one',1),(2,'session',1,'two',1)");
    worktree.exec("UPDATE roam_meta SET roamable=0, problem='Duplicate todo sequence for row IDs 1,2'");
    f.db.prepare("INSERT INTO projects(project_key,real_path,db_path,created_at,last_seen_at) VALUES (?,?,?,?,?)")
      .run("fixture", directory, file, 1, 1);
    const operation = { id: "recheck-1", machineId: BOX, expectedEpoch: null, kind: "recheck-store", args: { storeKey: key } };
    const refused = f.invoke(["roam", "agent", JSON.stringify(operation)]);
    expect(refused.status).toBe(0);
    expect(JSON.parse(refused.stdout)).toMatchObject({ code: 1, operationId: "recheck-1" });
    expect(worktree.prepare("SELECT roamable FROM roam_meta").get()).toEqual({ roamable: 0 });
    worktree.exec("DELETE FROM todos WHERE id=2");
    const accepted = f.invoke(["roam", "agent", JSON.stringify({ ...operation, id: "recheck-2" })]);
    expect(accepted.status, accepted.stderr).toBe(0);
    expect(worktree.prepare("SELECT roamable,problem FROM roam_meta").get()).toEqual({ roamable: 1, problem: null });
    expect(worktree.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_todos_session_seq'").get()).toEqual({ name: "idx_todos_session_seq" });
  } finally { worktree.close(); f.db.close(); }
}, 5000);

it("the packaged agent refuses an incomplete mapped-store inventory", () => {
  const f = fixture();
  try {
    f.db.prepare("INSERT INTO roam_repo_maps(repo_key,path) VALUES (?,?)").run("missing-repo", join(f.root, "missing-checkout"));
    const operation = { id: "stores-1", machineId: BOX, expectedEpoch: null, kind: "stores", args: {} };
    const result = f.invoke(["roam", "agent", JSON.stringify(operation)]);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ code: 1, operationId: "stores-1" });
    expect(f.db.prepare("SELECT capture_enabled FROM roam_meta").get()).toEqual({ capture_enabled: 0 });
  } finally { f.db.close(); }
}, 5000);

it("the packaged diagnostic entry inspects consumers and doctor state without writes", () => {
  const f = fixture();
  try {
    const bin = join(f.root, "bin"); mkdirSync(bin);
    writeFileSync(join(bin, "sqlite3"), `#!${process.execPath}\nconsole.log('3.45.0');\n`, { mode: 0o700 });
    const before = f.db.prepare("SELECT * FROM roam_meta").get();
    const env = { PATH: bin };
    const consumers = f.invoke(["--global-root", f.root, "roam", "observe", "consumers"], undefined, env);
    expect(consumers.status, consumers.stderr).toBe(0);
    expect(JSON.parse(consumers.stdout)).toMatchObject({ version: 1, machineId: BOX, kind: "consumers",
      value: { presence: [], worker: null, cli: "3.45.0", executables: [] } });
    const doctor = f.invoke(["--global-root", f.root, "roam", "observe", "doctor"], undefined, env);
    expect(doctor.status, doctor.stderr).toBe(0);
    expect(JSON.parse(doctor.stdout)).toMatchObject({ version: 1, machineId: BOX, kind: "doctor", value: { enabled: false } });
    expect(f.db.prepare("SELECT * FROM roam_meta").get()).toEqual(before);
    expect(existsSync(join(f.root, "roam", "journal.db"))).toBe(false);
  } finally { f.db.close(); }
}, 5000);

it("the packaged CLI maps a local non-Git repository explicitly", () => {
  const f = fixture();
  try {
    const directory = join(f.root, "checkout"); mkdirSync(directory);
    const result = f.invoke(["roam", "repo", "map", "fixture-repo", directory], undefined, { GIT_CEILING_DIRECTORIES: f.root });
    expect(result.status, result.stderr).toBe(0);
    expect(f.db.prepare("SELECT repo_key,path FROM roam_repo_maps").all()).toEqual([{ repo_key: "fixture-repo", path: directory }]);
  } finally { f.db.close(); }
}, 5000);

it("the packaged CLI tags memory with enrolled identities without changing its prose", () => {
  const f = fixture(HUB, true, "hub");
  try {
    const before = f.db.prepare("SELECT content,machine_id FROM global_memory WHERE uuid='memory-a'").get();
    expect(f.invoke(["roam", "memory", "tag", "global", "memory-a", HUB]).status).toBe(0);
    expect(f.db.prepare("SELECT content,machine_id FROM global_memory WHERE uuid='memory-a'").get()).toEqual({ content: "portable", machine_id: HUB });
    expect(f.invoke(["roam", "memory", "tag", "global", "memory-a", "--", "-box-1.invalid"]).status).toBe(0);
    expect(f.db.prepare("SELECT content,machine_id FROM global_memory WHERE uuid='memory-a'").get()).toEqual({ content: "portable", machine_id: BOX });
    expect(f.invoke(["roam", "memory", "tag", "global", "memory-a", "all"]).status).toBe(0);
    expect(f.db.prepare("SELECT content,machine_id FROM global_memory WHERE uuid='memory-a'").get()).toEqual(before);
    expect(f.invoke(["roam", "memory", "tag", "global", "memory-a", "unknown"]).status).toBe(2);
    expect(f.db.prepare("SELECT content,machine_id FROM global_memory WHERE uuid='memory-a'").get()).toEqual(before);
  } finally { f.db.close(); }
}, 5000);

it("the packaged agent seeds a newly migrated unassigned global store", () => {
  const f = fixture(BOX, false);
  try {
    const operation = { id: "enable-new", machineId: BOX, expectedEpoch: null, kind: "enable-capture", args: { storeKey: "global" } };
    const result = f.invoke(["roam", "agent", JSON.stringify(operation)]);
    expect(result.status, result.stderr).toBe(0);
    expect(f.db.prepare("SELECT store_key,capture_enabled FROM roam_meta").get()).toEqual({ store_key: "global", capture_enabled: 1 });
    expect(f.db.prepare("SELECT entity,row_key FROM roam_changes").all()).toEqual([{ entity: "global_memory", row_key: "memory-a" }]);
  } finally { f.db.close(); }
}, 5000);

it("the packaged agent refuses a mismatched local machine before journal or capture", () => {
  const f = fixture(HUB);
  try {
    const operation = { id: "enable-2", machineId: BOX, expectedEpoch: null, kind: "enable-capture", args: { storeKey: "global" } };
    const result = f.invoke(["roam", "agent", JSON.stringify(operation)]);
    expect(result.status).toBe(1);
    expect(f.db.prepare("SELECT capture_enabled FROM roam_meta").get()).toEqual({ capture_enabled: 0 });
    expect(existsSync(join(f.root, "roam", "journal.db"))).toBe(false);
  } finally { f.db.close(); }
}, 5000);

it("the packaged agent rejects malformed JSON without opening its journal", () => {
  const f = fixture();
  try {
    const result = f.invoke(["roam", "agent", "{bad"]);
    expect(result.status).toBe(2);
    expect(existsSync(join(f.root, "roam", "journal.db"))).toBe(false);
    expect(f.db.prepare("SELECT capture_enabled FROM roam_meta").get()).toEqual({ capture_enabled: 0 });
  } finally { f.db.close(); }
}, 5000);

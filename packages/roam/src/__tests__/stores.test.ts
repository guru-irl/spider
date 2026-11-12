import { afterEach, expect, it, vi } from "vitest";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { openDb, WORKTREE_SCHEMA } from "@spider/db-core";
import { addTodo } from "../../../todo/src/store";
import { createReplica } from "@spider/db-core/testutil";
import { exportBatch } from "@spider/db-core/roam/export";
import { seedSession, enableMemoryCapture } from "@spider/db-core/roam/seed";
import { replicaPath } from "@spider/db-core/roam/catalog";
import * as applyApi from "@spider/db-core/roam/apply";
import { validateBatch } from "@spider/db-core/roam/codec";
import { writeLocal } from "@spider/db-core/roam/local-state";
import { DEFAULT_LIMITS } from "../contracts";
import { createStorePort, sweepBatchFiles } from "../stores";
import { sweepStoreArtifacts } from "../cleanup";
import { stageArtifact } from "../artifacts";
import * as stagingApi from "../staging";
const HUB = "00000000-0000-4000-8000-000000000001", BOX = "00000000-0000-4000-8000-000000000002";
const fixtures: Array<{ close(): void }> = [];
afterEach(() => { vi.restoreAllMocks(); for (const f of fixtures.splice(0).reverse()) f.close(); });
function fixture() {
  const global = createReplica("global", HUB), source = createReplica("worktree", BOX); fixtures.push(global, source);
  source.db.prepare("INSERT INTO sessions(id,name,started_at) VALUES ('session-a','portable',1)").run();
  source.db.prepare("INSERT INTO todos(uuid,session_id,seq,text,created_at) VALUES ('todo-a','session-a',1,'portable',1)").run();
  seedSession(source.db, "session-a", 1, source.storeKey, 4096);
  const config = { enabled: true, role: "hub" as const, machineId: HUB, hubMachineId: HUB, peers: [], discoveryRoots: [], coreUnit: "core", syncMs: 120_000, limits: { ...DEFAULT_LIMITS } };
  const stores = createStorePort(config, global.db); fixtures.push(stores);
  return { global, source, stores, config };
}
const policy = { encode: (_: unknown, body: import("@spider/db-core/roam/types").JsonObject) => body };
it("store adapter catalogs only committed sessions and ignores wire paths", async () => {
  const { global, source, stores } = fixture();
  const foreignPath = join(source.root, "foreign.db");
  const batch = await exportBatch(source.db, { after: 0, targetBytes: 4096, batchId: "batch-a" }, policy);
  const bad = { ...batch, sha256: "f".repeat(64), file: batch.file };
  await expect(stores.accept(source.storeKey, bad)).rejects.toThrow();
  expect(global.db.prepare("SELECT session_id FROM roam_locations").all()).toEqual([]);
  const incoming = { ...batch, foreignPath };
  const receipt = await stores.accept(source.storeKey, incoming);
  const catalogKeys = JSON.parse((global.db.prepare("SELECT stores_json FROM roam_locations WHERE session_id='session-a'").get() as { stores_json: string }).stores_json);
  const expectedPortableKeys = [source.storeKey];
  expect(catalogKeys).toEqual(expectedPortableKeys);
  const openedPaths = [stores.openStore(source.storeKey).db.raw.name];
  expect(openedPaths).not.toContain(foreignPath);
  expect(receipt.through).toBe(2);
  expect(stores.cursor(source.storeKey, BOX, batch.header.senderStream)).toBe(2);
  expect(stores.openStore(source.storeKey).db.prepare("SELECT text FROM todos_fts WHERE todos_fts MATCH 'portable'").all()).toHaveLength(1);
}, 5000);
it("records successful SQLite export and lexical apply durations", async () => {
  const { source, stores } = fixture();
  const started = performance.now();
  const batch = await exportBatch(source.db, { after: 0, targetBytes: 4096, batchId: "measured" }, policy);
  const exportMs = performance.now() - started;
  const beforeImport = performance.now(); const receipt = await stores.accept(source.storeKey, batch);
  const importMs = performance.now() - beforeImport;
  expect(Number.isFinite(exportMs) && exportMs >= 0).toBe(true);
  expect(Number.isFinite(importMs) && importMs >= 0).toBe(true);
  expect(receipt.applyMs).not.toBeNull();
  expect(stores.openStore(source.storeKey).db.prepare("SELECT count(*) AS n FROM todos_fts WHERE todos_fts MATCH 'portable'").get()).toEqual({ n: 1 });
  if (process.env.SPIDER_ROAM_TIMING === "1") process.stdout.write(`${JSON.stringify({ bytes: batch.byteLength, exportMs, importMs, applyMs: receipt.applyMs })}\n`);
}, 5000);
it("agent store effects catalog only after the actual apply commits", async () => {
  const { global, source, stores } = fixture();
  const batch = await exportBatch(source.db, { after: 0, targetBytes: 4096, batchId: "agent-apply" }, policy);
  const valid = await validateBatch(batch, { storeKey: source.storeKey, senderMachine: BOX, senderStream: batch.header.senderStream, now: Date.now() });
  const target = stores.openStore(source.storeKey);
  expect(global.db.prepare("SELECT session_id FROM roam_locations").all()).toEqual([]);
  applyApi.applyBatch(target.db, valid, { hubMachine: HUB, effects: target.effects, now: Date.now(), sessionHome: () => null });
  expect(global.db.prepare("SELECT session_id FROM roam_locations").all()).toEqual([{ session_id: "session-a" }]);
}, 5000);
it("startup catalog recovery finds committed unmapped sessions", async () => {
  const { global, source, stores } = fixture();
  const batch = await exportBatch(source.db, { after: 0, targetBytes: 4096, batchId: "batch-a" }, policy);
  await stores.accept(source.storeKey, batch);
  global.db.prepare("DELETE FROM roam_locations").run();
  stores.recoverCatalog(); stores.recoverCatalog();
  expect(global.db.prepare("SELECT session_id,stores_json FROM roam_locations").all()).toEqual([{ session_id: "session-a", stores_json: JSON.stringify([source.storeKey]) }]);
}, 5000);
it("mapping fences re-resolve placement before retrying the same batch", async () => {
  const { global, source, stores } = fixture();
  const old = stores.openStore(source.storeKey).db;
  const target = createReplica("worktree", HUB); fixtures.push(target);
  const actual = applyApi.applyBatch;
  vi.spyOn(applyApi, "applyBatch").mockImplementationOnce((db, batch, options) => {
    applyApi.fenceReplicaForMapping(db, source.storeKey);
    global.db.prepare("INSERT INTO roam_workspace_maps(repo_key,workspace_id,path) VALUES ('fixture-repo','fixture-workspace',?)").run(target.root);
    writeLocal(global.db, "mapping-redirect", source.storeKey, target.db.raw.name);
    return actual(db, batch, options);
  });
  const batch = await exportBatch(source.db, { after: 0, targetBytes: 4096, batchId: "batch-a" }, policy);
  expect((await stores.accept(source.storeKey, batch)).through).toBe(2);
  expect(old.prepare("SELECT id FROM sessions").all()).toEqual([]);
  expect(target.db.prepare("SELECT id FROM sessions").all()).toEqual([{ id: "session-a" }]);
  expect(stores.cursor(source.storeKey, "", "mapping-fence")).toBe(0);
}, 5000);
it("unlogged collisions consult the global home instead of retired membership", async () => {
  const { global, source, stores } = fixture();
  const target = stores.openStore(source.storeKey).db;
  addTodo(target, "session-a", "local");
  const localUuid = (target.prepare("SELECT uuid FROM todos").get() as { uuid: string }).uuid;
  target.prepare("INSERT INTO roam_sessions(session_id,epoch,state) VALUES ('session-a',1,'retired')").run();
  const batch = await exportBatch(source.db, { after: 0, targetBytes: 4096, batchId: "batch-a" }, policy);
  await expect(stores.accept(source.storeKey, batch)).rejects.toThrow(new RegExp(`${localUuid}.*todo-a|todo-a.*${localUuid}`));
  expect(stores.cursor(source.storeKey, BOX, batch.header.senderStream)).toBe(0);
  global.db.prepare("INSERT INTO session_homes VALUES ('session-a',?,1,NULL,1)").run(BOX);
  await stores.accept(source.storeKey, batch);
  expect(target.prepare("SELECT uuid,text FROM todos").all()).toEqual([{ uuid: "todo-a", text: "portable" }]);
}, 5000);
it("unrelated older registered checkouts do not block healthy replica placement", async () => {
  const { global, source, stores } = fixture();
  const old = openDb(join(global.root, "older.db"));
  try {
    old.exec(WORKTREE_SCHEMA); old.pragma("user_version=13");
    global.db.prepare("INSERT INTO projects(project_key,real_path,db_path,created_at,last_seen_at) VALUES ('older',?,?,1,1)").run(global.root, old.raw.name);
    const batch = await exportBatch(source.db, { after: 0, targetBytes: 4096, batchId: "healthy" }, policy);
    expect((await stores.accept(source.storeKey, batch)).through).toBe(2);
    expect(old.pragma("user_version")).toBe(13);
    expect(old.prepare("SELECT name FROM sqlite_master WHERE name='roam_meta'").all()).toEqual([]);
  } finally { old.close(); }
}, 5000);
it("registered repository memory resolves to its existing store", async () => {
  const { global, source, stores } = fixture(); const repo = createReplica("repo", HUB); fixtures.push(repo);
  repo.db.prepare("INSERT INTO memory(uuid,category,content,created_at) VALUES ('memory-a','convention','portable',1)").run();
  enableMemoryCapture(repo.db, repo.storeKey);
  const directory = join(repo.root, "spider"); mkdirSync(directory, { mode: 0o700 }); const file = join(directory, "repo.db");
  await repo.db.raw.backup(file); chmodSync(file, 0o600);
  global.db.prepare("INSERT INTO projects(project_key,real_path,git_common_dir,db_path,created_at,last_seen_at) VALUES ('registered',?,?,?,1,1)")
    .run(source.root, repo.root, source.db.raw.name);
  const batch = await stores.export(repo.storeKey, 0, 4096, "repository-batch");
  expect(batch.header.count).toBe(1);
  expect(stores.openStore(repo.storeKey).db.raw.name).toBe(file);
}, 5000);
it("oversized singleton exports name the row and leave it untrimmed", async () => {
  const { source, stores, config } = fixture();
  source.db.prepare("UPDATE todos SET text=? WHERE uuid='todo-a'").run("x".repeat(4096));
  const batch = await exportBatch(source.db, { after: 0, targetBytes: 16_384, batchId: "source" }, { encode: (_entity, body) => body });
  await stores.accept(source.storeKey, batch);
  config.limits.hardBatchBytes = 2048;
  await expect(stores.export(source.storeKey, 2, 1024, "singleton")).rejects.toThrow(/Roaming row todos\/todo-a exceeds the configured batch limit/);
  expect(stores.openStore(source.storeKey).db.prepare("SELECT length(text) AS n FROM todos").get()).toEqual({ n: 4096 });
}, 5000);
it("a future global schema refuses before application queries", () => {
  const { global, config } = fixture(); global.db.pragma("user_version=15");
  const prepare = vi.spyOn(global.db, "prepare");
  expect(() => createStorePort(config, global.db)).toThrow();
  expect(prepare).not.toHaveBeenCalled(); global.db.pragma("user_version=14");
}, 5000);
it("store adapters reject a mismatched global identity before mutation", () => {
  const { global, config } = fixture();
  expect(() => createStorePort({ ...config, machineId: BOX }, global.db)).toThrow(/identity/i);
  expect(global.db.prepare("SELECT count(*) AS n FROM roam_changes").get()).toEqual({ n: 0 });
}, 5000);
it("an incoming staging-open failure releases its peer lease", async () => {
  const { global, source, stores, config } = fixture();
  const root = join(global.root, "roam", "staging"); vi.spyOn(stagingApi, "defaultStagingRoot").mockReturnValue(root);
  const directory = join(root, "incoming", BOX); mkdirSync(directory, { recursive: true, mode: 0o700 });
  symlinkSync(source.db.raw.name, join(directory, "quota.db"));
  const batch = await exportBatch(source.db, { after: 0, targetBytes: 4096, batchId: "staging-failure" }, policy);
  await expect(stores.accept(source.storeKey, { ...batch, file: join(directory, "artifacts", "staging-failure", "complete", "f".repeat(64)) })).rejects.toThrow();
  const lease = stagingApi.acquireTransferLease(root, BOX, config.limits.peerConcurrency);
  expect(typeof lease).toBe("function"); lease?.();
}, 5000);
it("empty exports allocate no receipt and remove their private file", async () => {
  const { global, stores } = fixture();
  const batch = await stores.export("global", 0, 4096, "empty");
  expect(batch.header.count).toBe(0);
  expect(existsSync(batch.file)).toBe(false);
  expect(global.db.prepare("SELECT * FROM roam_receipts").all()).toEqual([]);
}, 5000);
it("new hub replicas are private and registered symlinks are refused", () => {
  const { global, source, stores } = fixture();
  const file = stores.openStore(source.storeKey).db.raw.name;
  expect(lstatSync(file).mode & 0o777).toBe(0o600);
  expect(lstatSync(dirname(file)).mode & 0o777).toBe(0o700);
  const link = join(global.root, "linked.db"); symlinkSync(source.db.raw.name, link);
  global.db.prepare("INSERT INTO projects(project_key,real_path,db_path,created_at,last_seen_at) VALUES ('symlink',?,?,1,1)").run(global.root, link);
  expect(() => stores.openStore("worktree:other:workspace")).toThrow(/unsafe/i);
}, 5000);
it("startup sweeps reclaim orphan staging but retain journal references", async () => {
  const { global, stores, config } = fixture();
  const root = join(global.root, "roam", "staging");
  vi.spyOn(stagingApi, "defaultStagingRoot").mockReturnValue(root);
  config.limits.stagingBytes = 10;
  const source = join(global.root, "bytes"); writeFileSync(source, "bytes", { mode: 0o600 });
  const orphan = await stageArtifact(source, "batch", config.limits, { artifactId: "orphan" });
  const referenced = await stageArtifact(source, "batch", config.limits, { artifactId: "referenced" });
  const incoming = stagingApi.openStaging(root, BOX, config.limits);
  incoming.declare(orphan, "orphan-transfer"); incoming.release(orphan.id, "orphan-transfer");
  incoming.declare(referenced, "referenced-transfer"); incoming.release(referenced.id, "referenced-transfer");
  const orphanDirectory = join(global.root, "roam", "stores", ".roam-batches"); mkdirSync(orphanDirectory, { recursive: true, mode: 0o700 });
  const orphanSnapshot = join(orphanDirectory, "00000000-0000-4000-8000-000000000001.ndjson"); writeFileSync(orphanSnapshot, "old export", { mode: 0o600 }); utimesSync(orphanSnapshot, 1, 1);
  const now = Date.now() + config.limits.retentionMs + 1000;
  sweepStoreArtifacts(stores, config, { now, referenced: value => value === "referenced", active: () => false });
  expect(existsSync(orphanSnapshot)).toBe(false);
  const pool = stagingApi.openOutgoingStaging(root, config.limits, false);
  expect(pool.inspect("orphan").current).toBeNull();
  expect(pool.inspect("referenced").current).not.toBeNull(); pool.close();
  expect(() => incoming.missing(orphan)).toThrow(/declared/i);
  expect(incoming.missing(referenced)).toEqual([0]); incoming.close();
  expect((await stageArtifact(source, "batch", config.limits, { artifactId: "replacement" })).byteLength).toBe(5);
  expect(() => sweepStoreArtifacts(stores, config, { now, referenced() { throw new Error("unavailable"); }, active: () => false })).toThrow(/unavailable/);
}, 5000);
it("orphan sweeps retain active and journal-referenced snapshots", () => {
  const { global } = fixture(); const directory = join(global.root, ".roam-batches"); mkdirSync(directory, { mode: 0o700 });
  const names = ["00000000-0000-4000-8000-000000000001.ndjson", "00000000-0000-4000-8000-000000000002.ndjson", "00000000-0000-4000-8000-000000000003.ndjson"];
  for (const name of names) { writeFileSync(join(directory, name), "snapshot", { mode: 0o600 }); utimesSync(join(directory, name), 1, 1); }
  const options = { now: 100_000, maxAgeMs: 1000, referenced: (file: string) => file.endsWith(names[1]), active: (file: string) => file.endsWith(names[2]) };
  sweepBatchFiles([directory], options);
  expect(readdirSync(directory).sort()).toEqual(names.slice(1));
  expect(() => sweepBatchFiles([directory], { ...options, referenced() { throw new Error("unavailable"); } })).toThrow(/unavailable/);
  expect(readdirSync(directory).sort()).toEqual(names.slice(1));
  expect(() => sweepBatchFiles([directory], { ...options, maxAgeMs: Number.NaN })).toThrow(/age|sweep/i);
  expect(readdirSync(directory).sort()).toEqual(names.slice(1));
}, 5000);

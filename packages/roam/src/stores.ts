import { closeSync, constants, existsSync, fchmodSync, fstatSync, lstatSync, openSync, readdirSync, realpathSync, unlinkSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { migrate, openDb, openDbReadOnly, type Db } from "@spider/db-core";
import { MappingFenceError, applyBatch } from "@spider/db-core/roam/apply";
import { catalogReplica, replicaPath } from "@spider/db-core/roam/catalog";
import { storeScope, validateBatch } from "@spider/db-core/roam/codec";
import { createReplicaEffects } from "@spider/db-core/roam/effects";
import { createExportPolicy } from "@spider/db-core/roam/event-policy";
import { exportBatch } from "@spider/db-core/roam/export";
import { localEntries, writeLocal } from "@spider/db-core/roam/local-state";
import { openRoamStoreReadOnly } from "@spider/db-core/roam/reads";
import type { ApplyReceipt, BatchArtifact, StoreKey } from "@spider/db-core/roam/types";
import type { AgentPorts, RoamConfig, StorePort } from "./contracts";
import { sessionHome } from "./homes";
import { listStoreKeys } from "./store-inventory";
import { acquireTransferLease, defaultStagingRoot, openStaging, openOutgoingStaging, privateDirectory, readPrivate, hash } from "./staging";

export function batchReceipt(db: Db, batch: BatchArtifact): ApplyReceipt | null {
  const h = batch.header;
  const row = db.prepare("SELECT peer_stream,after_seq,through_seq,sha256 FROM roam_receipts WHERE peer_machine=? AND batch_id=?")
    .get(h.senderMachine, h.batchId) as { peer_stream: string; after_seq: number; through_seq: number; sha256: string } | undefined;
  if (!row) return null;
  const cursor = db.prepare("SELECT last_seq FROM roam_cursors WHERE peer_machine=? AND peer_stream=?").get(h.senderMachine, h.senderStream) as { last_seq: number } | undefined;
  if (row.peer_stream !== h.senderStream || row.after_seq !== h.after || row.through_seq !== h.through || row.sha256 !== batch.sha256 || !cursor || cursor.last_seq < h.through)
    throw new Error("Conflicting or uncommitted batch receipt");
  return { batchId: h.batchId, stream: h.senderStream, through: h.through, sha256: batch.sha256, applyMs: null };
}
export interface StoreAdapter extends StorePort {
  openStore: AgentPorts["openStore"];
  recoverCatalog(): void;
  origins(): ReadonlyMap<string, ReadonlySet<string>>;
  batchDirectories(): string[];
  close(): void;
}
export function createStorePort(config: RoamConfig, globalDb: Db, options: { allowUnassignedGlobal?: boolean } = {}): StoreAdapter {
  if (Number(globalDb.pragma("user_version")) !== 14) throw new Error("Unsupported global store schema");
  const identity = globalDb.prepare("SELECT machine_id,store_key FROM roam_meta WHERE id=1").get() as { machine_id: string; store_key: string | null };
  if (identity.machine_id !== config.machineId || !(identity.store_key === "global" || options.allowUnassignedGlobal && identity.store_key === null))
    throw new Error("Global store identity does not match configuration");
  const handles = new Map<string, Db>();
  let registryFingerprint: string | undefined;
  const registeredStores = new Map<StoreKey, string>();
  function registeredStore(key: StoreKey): string | undefined {
    const registered = globalDb.prepare("SELECT db_path,git_common_dir FROM projects ORDER BY project_key").all() as { db_path: string; git_common_dir: string | null }[];
    const fingerprint = JSON.stringify(registered);
    if (fingerprint !== registryFingerprint) {
      registeredStores.clear();
      for (const row of registered) for (const file of [row.db_path, ...(row.git_common_dir ? [join(row.git_common_dir, "spider", "repo.db")] : [])]) {
        if (!existsSync(file)) continue;
        let candidate: Db | undefined;
        try {
          const stat = lstatSync(file), parent = lstatSync(dirname(file));
          if (!stat.isFile() || stat.isSymbolicLink() || !parent.isDirectory() || parent.isSymbolicLink() || realpathSync(file) !== file ||
              typeof process.getuid === "function" && (stat.uid !== process.getuid() || parent.uid !== process.getuid())) throw new Error("Unsafe registered store");
          candidate = openDbReadOnly(file);
          if (!candidate || Number(candidate.pragma("user_version")) !== 14) continue;
          const meta = candidate.prepare("SELECT store_key,machine_id FROM roam_meta WHERE id=1").get() as { store_key: StoreKey | null; machine_id: string };
          if (meta.store_key !== null && meta.machine_id === config.machineId) {
            storeScope(meta.store_key); registeredStores.set(meta.store_key, file);
          }
          writeLocal(globalDb, "store-problem", file, undefined);
        } catch (error) {
          writeLocal(globalDb, "store-problem", file, { reason: error instanceof Error ? error.message : "Unreadable registered store" });
        } finally { candidate?.close(); }
      }
      registryFingerprint = fingerprint;
    }
    return registeredStores.get(key);
  }
  const effects = createReplicaEffects(key => catalogReplica(globalDb, key, openStore(key).db));
  const policy = createExportPolicy((_file, machineId) => ({ machineId, reference: "unavailable" }));
  function openStore(key: StoreKey) {
    const scope = storeScope(key);
    if (key === "global") return { db: globalDb, effects, policy };
    let file: string | undefined;
    const mapped = openRoamStoreReadOnly(globalDb, key);
    if (mapped) { file = mapped.raw.name; mapped.close(); }
    if (!file) file = registeredStore(key);
    if (!file) {
      if (config.role !== "hub") throw new Error("Store has no local mapping");
      file = replicaPath(globalDb, key);
      privateDirectory(dirname(file));
    }
    privateDirectory(dirname(file));
    if (existsSync(file)) {
      const stat = lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || realpathSync(file) !== file || typeof process.getuid === "function" && stat.uid !== process.getuid())
        throw new Error("Unsafe store destination");
    }
    for (const suffix of ["-wal", "-shm"]) if (existsSync(file + suffix) && lstatSync(file + suffix).isSymbolicLink()) throw new Error("Unsafe store sidecar");
    const fd = openSync(file, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || typeof process.getuid === "function" && stat.uid !== process.getuid()) throw new Error("Unsafe store destination");
      fchmodSync(fd, 0o600);
    } finally { closeSync(fd); }
    let db = handles.get(file);
    if (!db) {
      db = openDb(file);
      try {
        migrate(db, scope, { machineId: config.machineId, globalRoot: dirname(globalDb.raw.name) });
        const meta = db.prepare("SELECT machine_id,store_key FROM roam_meta WHERE id=1").get() as { machine_id: string; store_key: string | null };
        if (meta.machine_id !== config.machineId || meta.store_key !== null && meta.store_key !== key) throw new Error("Store identity does not match");
        if (meta.store_key === null) db.prepare("UPDATE roam_meta SET store_key=? WHERE id=1").run(key);
        handles.set(file, db);
      } catch (error) { db.close(); throw error; }
    }
    return { db, effects, policy };
  }
  function cleanReceipt(artifact: BatchArtifact, staging: ReturnType<typeof openStaging>): void {
    const manifest = staging.manifestFor(`pull-${artifact.header.batchId}`);
    staging.release(manifest.id, `pull-${artifact.header.batchId}`);
    staging.removeAfterReceipt(manifest, { artifactId: manifest.id, sha256: manifest.sha256 },
      () => batchReceipt(openStore(artifact.header.storeKey).db, artifact) !== null);
  }
  function catalogCommitted(key: StoreKey, db: Db): void {
    try { catalogReplica(globalDb, key, db); }
    catch { /* Catalog recovery retries this committed store. */ }
  }
  function retryCleanup(artifact: BatchArtifact, root: string): void {
    let release: (() => void) | null = null;
    try {
      if (!existsSync(join(root, "incoming", artifact.header.senderMachine, "quota.db"))) return;
      release = acquireTransferLease(root, artifact.header.senderMachine, config.limits.peerConcurrency);
      if (!release) return;
      const staging = openStaging(root, artifact.header.senderMachine, config.limits);
      try { cleanReceipt(artifact, staging); } finally { staging.close(); }
    } catch { /* Cleanup cannot change a committed receipt. */ }
    finally { try { release?.(); } catch { /* Retain cleanup evidence for the next retry. */ } }
  }
  const adapter: StoreAdapter = {
    openStore,
    list() {
      registryFingerprint = undefined;
      return listStoreKeys(globalDb, { onProblem: (file, error) => writeLocal(globalDb, "store-problem", file,
        { reason: error instanceof Error ? error.message : "Unsafe or unreadable registered store" }) });
    },
    cursor(key, machine, stream) {
      if (!machine) return 0;
      const row = openStore(key).db.prepare("SELECT last_seq FROM roam_cursors WHERE peer_machine=? AND peer_stream=?").get(machine, stream) as { last_seq: number } | undefined;
      if (row && (!Number.isSafeInteger(row.last_seq) || row.last_seq < 0)) throw new Error("Invalid committed cursor");
      return row?.last_seq ?? 0;
    },
    async accept(key, artifact) {
      if (artifact.header.storeKey !== key || artifact.header.count === 0) throw new Error("Invalid nonempty import");
      const root = defaultStagingRoot();
      const already = batchReceipt(openStore(key).db, artifact);
      const staged = relative(join(root, "incoming", artifact.header.senderMachine, "artifacts"), artifact.file);
      const isStaged = !staged.startsWith(`..${sep}`) && !staged.startsWith("/") && staged.split(sep).length === 3;
      if (already) {
        catalogCommitted(key, openStore(key).db);
        if (isStaged) retryCleanup(artifact, root);
        return already;
      }
      const release = isStaged ? acquireTransferLease(root, artifact.header.senderMachine, config.limits.peerConcurrency) : null;
      if (isStaged && !release) throw Object.assign(new Error("Peer import is busy"), { retryable: true });
      let staging: ReturnType<typeof openStaging> | null = null;
      let validFile: string | undefined;
      try {
        staging = isStaged ? openStaging(root, artifact.header.senderMachine, config.limits) : null;
        const manifest = staging?.manifestFor(`pull-${artifact.header.batchId}`);
        let committed: ApplyReceipt | null = null;
        let db = openStore(key).db;
        committed = batchReceipt(db, artifact);
        if (!committed) {
          const attempt = `validate-${artifact.header.batchId}`;
          let reserved = false;
          try {
            if (staging && manifest) {
              try { staging.cancelValidationCopy(manifest, attempt, () => true); } catch (error) {
                if (!(error instanceof Error) || error.message !== "Validation reservation is missing") throw error;
              }
            }
            const input = staging && manifest ? staging.reserveValidationCopy(manifest, attempt) : artifact.file;
            reserved = !!staging;
            const valid = await validateBatch({ ...artifact, file: input }, { storeKey: key, senderMachine: artifact.header.senderMachine,
              senderStream: artifact.header.senderStream, now: Date.now() });
            validFile = staging && manifest ? staging.promoteValidationCopy(manifest, attempt, valid.file) : valid.file;
            reserved = false;
            if (config.role === "hub" && key.startsWith("worktree:")) {
              const bytes = readPrivate(validFile, valid.byteLength);
              if (bytes.length !== valid.byteLength || hash(bytes) !== valid.sha256) throw new Error("Validated batch changed");
              const records = bytes.toString("utf8").trimEnd().split("\n").slice(1).map(line => JSON.parse(line) as { entity: string; op: string; rowKey: string; body: { origin_machine: string } | null });
              globalDb.raw.transaction(() => {
                for (const record of records) if (record.entity === "sessions" && record.op === "put" && record.body)
                  writeLocal(globalDb, "observed-origin", JSON.stringify([record.rowKey, record.body.origin_machine]), { id: record.rowKey, origin: record.body.origin_machine });
              }).immediate();
            }
            for (let attempt = 0;; attempt++) {
              db = openStore(key).db;
              try { committed = applyBatch(db, { ...valid, file: validFile }, { hubMachine: config.hubMachineId, effects, now: Date.now(), sessionHome: id => sessionHome(globalDb, id) }); break; }
              catch (error) { if (!(error instanceof MappingFenceError) || attempt >= 1) throw error; }
            }
          } catch (error) { if (reserved && staging && manifest) staging.cancelValidationCopy(manifest, attempt, () => true); throw error; }
        }
        catalogCommitted(key, db);
        if (staging && manifest) {
          try { cleanReceipt(artifact, staging); }
          catch { /* The apply is committed. Retry cleanup on receipt replay. */ }
        }
        return committed;
      } finally {
        if (!staging && validFile && existsSync(validFile)) unlinkSync(validFile);
        staging?.close(); release?.();
      }
    },
    async export(key, after, targetBytes, batchId) {
      const batch = await exportBatch(openStore(key).db, { after, targetBytes, batchId }, policy);
      if (batch.byteLength > config.limits.hardBatchBytes && batch.header.count > 0) {
        const line = readPrivate(batch.file, batch.byteLength).toString("utf8").split("\n")[1];
        const row = JSON.parse(line) as { entity: string; rowKey: string };
        unlinkSync(batch.file);
        if (batch.header.count === 1) throw new Error(`Roaming row ${row.entity}/${row.rowKey} exceeds the configured batch limit`);
        throw new Error("Export exceeds the configured batch limit");
      }
      if (batch.header.count === 0) unlinkSync(batch.file);
      return batch;
    },
    recoverCatalog() {
      for (const key of listStoreKeys(globalDb)) {
        if (!key.startsWith("worktree:")) continue;
        let db: Db | undefined;
        try {
          db = openRoamStoreReadOnly(globalDb, key);
          if (!db || Number(db.pragma("user_version")) !== 14) continue;
          const meta = db.prepare("SELECT machine_id,store_key FROM roam_meta WHERE id=1").get() as { machine_id: string; store_key: string | null } | undefined;
          if (meta?.machine_id === config.machineId && meta.store_key === key) catalogReplica(globalDb, key, db);
        } catch { /* Retry unavailable stores at the next scan. */ }
        finally { db?.close(); }
      }
    },
    origins() {
      const result = new Map<string, Set<string>>();
      for (const row of localEntries<{ id: string; origin: string }>(globalDb, "observed-origin")) {
        if (!result.has(row.value.id)) result.set(row.value.id, new Set());
        result.get(row.value.id)!.add(row.value.origin);
      }
      for (const key of listStoreKeys(globalDb).filter(key => key.startsWith("worktree:"))) {
        const db = openStore(key).db;
        for (const row of db.prepare("SELECT row_key,body_json FROM roam_changes WHERE entity='sessions' AND op='put'").all() as { row_key: string; body_json: string }[]) {
          const body = JSON.parse(row.body_json) as { origin_machine: string };
          if (!result.has(row.row_key)) result.set(row.row_key, new Set());
          result.get(row.row_key)!.add(body.origin_machine);
        }
      }
      return result;
    },
    batchDirectories() {
      const directories = new Set([dirname(globalDb.raw.name), dirname(replicaPath(globalDb, "global")), ...[...handles.keys()].map(dirname)]);
      for (const key of listStoreKeys(globalDb)) {
        if (key === "global") continue;
        let mapped: Db | undefined;
        try {
          const registered = registeredStore(key);
          if (registered) directories.add(dirname(registered));
          mapped = openRoamStoreReadOnly(globalDb, key);
          if (mapped) directories.add(dirname(mapped.raw.name));
        } catch (error) { writeLocal(globalDb, "store-problem", key, { reason: error instanceof Error ? error.message : "Unreadable snapshot directory" }); }
        finally { mapped?.close(); }
      }
      return [...directories].map(dir => join(dir, ".roam-batches"));
    },
    close() { for (const db of handles.values()) db.close(); handles.clear(); },
  };
  return adapter;
}

/** A complete reference check must succeed before any file is deleted. */
export function sweepBatchFiles(directories: readonly string[], options: { now: number; maxAgeMs: number;
  referenced(file: string): boolean; active(file: string): boolean }): string[] {
  if (!Number.isSafeInteger(options.now) || options.now < 0 || !Number.isSafeInteger(options.maxAgeMs) || options.maxAgeMs < 1)
    throw new Error("Invalid snapshot sweep age");
  const remove: string[] = [];
  for (const directory of new Set(directories)) {
    if (!existsSync(directory)) continue;
    const parent = lstatSync(directory);
    if (!parent.isDirectory() || parent.isSymbolicLink() || realpathSync(directory) !== directory ||
        typeof process.getuid === "function" && parent.uid !== process.getuid()) throw new Error("Unsafe batch directory");
    for (const name of readdirSync(directory)) {
      if (!/^[a-f0-9-]{36}\.ndjson$/.test(name)) continue;
      const file = join(directory, name), stat = lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || typeof process.getuid === "function" && stat.uid !== process.getuid()) continue;
      if (stat.mtimeMs > options.now - options.maxAgeMs) continue;
      const referenced = options.referenced(file), active = options.active(file);
      if (typeof referenced !== "boolean" || typeof active !== "boolean") throw new Error("Snapshot references are unavailable");
      if (!referenced && !active) remove.push(file);
    }
  }
  for (const file of remove) unlinkSync(file);
  return remove;
}

export function removeOutgoing(root: string, id: string, config: RoamConfig, verified: () => boolean): void {
  if (!verified()) throw new Error("Durable receipt is missing");
  const outgoing = openOutgoingStaging(root, config.limits, false);
  try { outgoing.remove(id); }
  finally { outgoing.close(); }
}

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, closeSync, constants, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, realpathSync, statSync, type Dirent } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { assertTestDbPath, openDb, openDbReadOnly, type Db } from "../db";
import { migrate, SCHEMA_VERSION } from "../migrate";
import { gitCommonDir, repoRoot } from "../paths";
import { mappingRedirect, openRoamStoreReadOnly } from "./reads";
import { localEntries, readLocal, writeLocal } from "./local-state";
import { commandEnv } from "../command-env";
import { applyMappingBatch, CursorMismatchError, FENCE_MACHINE, FENCE_STREAM, FENCE_TARGET, fenceReplicaForMapping, type MappingFenceTarget } from "./apply";
import { validateRoamLayout } from "./layout";
import { compareHlc } from "./hlc";
import { catalogReplica, replicaPath } from "./catalog";
import { storeScope, validateBatch } from "./codec";
import { createReplicaEffects } from "./effects";
import { createExportPolicy } from "./event-policy";
import { exportBatch } from "./export";
import { canonicalOrigin, repoIdentity } from "./identity";
import type { Home, Scope, StoreKey } from "./types";

interface Intent { kind: string; identity: string; target_path: string; store_key: StoreKey; command_json: string | null; attempt_id?: string }
interface Version { entity: string; row_key: string; change_id: string; hlc_ms: number; hlc_count: number; origin_machine: string; origin_stream: string; deleted: number }

const intentKey = (kind: string, identity: string) => JSON.stringify([kind, identity]);

function localHome(db: Db, sessionId: string): Home | null {
  const row = db.prepare("SELECT machine_id,epoch,move_id,updated_at FROM session_homes WHERE session_id = ?")
    .get(sessionId) as { machine_id: string; epoch: number; move_id: string | null; updated_at: number } | undefined;
  return row?.machine_id ? { sessionId, machineId: row.machine_id, epoch: row.epoch, moveId: row.move_id, updatedAt: row.updated_at } : null;
}

function exists(file: string): boolean {
  try { lstatSync(file); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

function openTarget(globalDb: Db, file: string, scope: Scope, key: StoreKey, assignKey = false): Db {
  const directory = dirname(file);
  assertTestDbPath(file);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const parent = lstatSync(directory);
  if (!parent.isDirectory() || parent.isSymbolicLink() || realpathSync(directory) !== directory ||
    typeof process.getuid === "function" && parent.uid !== process.getuid()) throw new Error("Unsafe mapping destination");
  chmodSync(directory, 0o700);
  const fd = openSync(file, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  try {
    const target = fstatSync(fd);
    if (!target.isFile() || typeof process.getuid === "function" && target.uid !== process.getuid()) throw new Error("Unsafe mapping destination");
    fchmodSync(fd, 0o600);
  } finally { closeSync(fd); }
  const machine = (globalDb.prepare("SELECT machine_id FROM roam_meta WHERE id = 1").get() as { machine_id: string }).machine_id;
  const db = openDb(file);
  try {
    migrate(db, scope, { machineId: machine, globalRoot: dirname(globalDb.raw.name) });
    const meta = db.prepare("SELECT store_key FROM roam_meta WHERE id = 1").get() as { store_key: string | null };
    if (meta.store_key !== null && meta.store_key !== key) throw new Error("Mapping destination belongs to another store");
    if (assignKey && meta.store_key === null) db.prepare("UPDATE roam_meta SET store_key = ? WHERE id = 1").run(key);
    return db;
  } catch (error) { db.close(); throw error; }
}

function validateTarget(db: Db, globalDb: Db, scope: Scope, key: StoreKey): void {
  const machine = (globalDb.prepare("SELECT machine_id FROM roam_meta WHERE id=1").get() as { machine_id: string }).machine_id;
  const meta = db.prepare("SELECT machine_id,store_key,roamable,problem,importing FROM roam_meta WHERE id=1").get() as
    { machine_id: string; store_key: string | null; roamable: number; problem: string | null; importing: number } | undefined;
  if (!meta || meta.machine_id !== machine || meta.roamable !== 1 || meta.problem !== null || meta.importing !== 0)
    throw new Error("Mapping destination store is not ready for roaming");
  if (meta.store_key !== null && meta.store_key !== key) throw new Error("Mapping destination belongs to another store");
  const layout = validateRoamLayout(db, scope, "inspect");
  if (!layout.captureSafe) throw new Error(`Mapping destination is not roamable: ${layout.diagnostic ?? "invalid layout"}`);
}

function checkExistingStore(file: string): void {
  assertTestDbPath(file);
  const directory = dirname(file), parent = lstatSync(directory), target = lstatSync(file);
  if (!parent.isDirectory() || parent.isSymbolicLink() || realpathSync(directory) !== directory ||
      !target.isFile() || target.isSymbolicLink() ||
      typeof process.getuid === "function" && (parent.uid !== process.getuid() || target.uid !== process.getuid()))
    throw new Error("Unsafe mapping destination");
}

function preflightTarget(globalDb: Db, file: string, scope: Scope, key: StoreKey, create: boolean): void {
  if (exists(file)) {
    checkExistingStore(file);
    const snapshot = openDbReadOnly(file)!;
    try {
      const version = Number(snapshot.pragma("user_version"));
      if (version > SCHEMA_VERSION) throw new Error(`Cannot open future core schema ${version}`);
      if (version === SCHEMA_VERSION) { validateTarget(snapshot, globalDb, scope, key); return; }
    } finally { snapshot.close(); }
  } else if (!create) return;
  const target = openTarget(globalDb, file, scope, key);
  try { validateTarget(target, globalDb, scope, key); }
  finally { target.close(); }
}

function requirePending(globalDb: Db, expected: Intent, targetFile: string): boolean {
  const pending = readLocal<Intent>(globalDb, "mapping-intent", intentKey(expected.kind, expected.identity));
  if (!pending) {
    if (mappingRedirect(globalDb, expected.store_key) === targetFile && mappingPublished(globalDb, expected.store_key)) return false;
    throw new Error("Pending mapping disappeared or changed");
  }
  if (pending.target_path !== expected.target_path || pending.store_key !== expected.store_key || pending.command_json !== expected.command_json ||
      pending.attempt_id !== expected.attempt_id) throw new Error("Pending mapping disappeared or changed");
  return true;
}

async function merge(globalDb: Db, key: StoreKey, destination: string, scope: Scope, intent: Intent): Promise<boolean> {
  const sourceFile = replicaPath(globalDb, key);
  if (!exists(sourceFile)) {
    if (!exists(destination)) return false;
    const snapshot = openDbReadOnly(destination)!;
    let assigned: boolean;
    try { assigned = (snapshot.prepare("SELECT store_key FROM roam_meta WHERE id=1").get() as { store_key: string | null }).store_key !== null; }
    finally { snapshot.close(); }
    if (assigned) return false;
    // An empty replica carries the fence locator when a target needs an identity.
    const empty = openTarget(globalDb, sourceFile, scope, key, true);
    empty.close();
  }
  const source = openTarget(globalDb, sourceFile, scope, key, true);
  let target: Db | undefined;
  try {
    target = openTarget(globalDb, destination, scope, key);
    validateTarget(target, globalDb, scope, key);
    const pending = globalDb.raw.transaction(() => {
      if (!requirePending(globalDb, intent, destination)) return false;
      const meta = target!.prepare("SELECT store_key FROM roam_meta WHERE id=1").get() as { store_key: string | null };
      const targetStat = statSync(destination, { bigint: true });
      fenceReplicaForMapping(source, key, { file: destination, device: String(targetStat.dev), inode: String(targetStat.ino), clearOnCancel: meta.store_key === null });
      return true;
    }).immediate();
    if (!pending) return false;
    const meta = source.prepare("SELECT machine_id,stream_id FROM roam_meta WHERE id = 1").get() as { machine_id: string; stream_id: string };
    const hubMachine = (globalDb.prepare("SELECT machine_id FROM roam_meta WHERE id = 1").get() as { machine_id: string }).machine_id;
    const effects = createReplicaEffects(() => {});
    const policy = createExportPolicy((_path, origin) => ({ machineId: origin, reference: "unavailable" }));
    for (;;) {
      const cursor = target.prepare("SELECT last_seq FROM roam_cursors WHERE peer_machine = ? AND peer_stream = ?")
        .get(meta.machine_id, meta.stream_id) as { last_seq: number } | undefined;
      const artifact = await exportBatch(source, { after: cursor?.last_seq ?? 0, targetBytes: 4 * 1024 * 1024, batchId: randomUUID() }, policy);
      if (artifact.header.count === 0) break;
      const now = Date.now();
      const valid = await validateBatch(artifact, { storeKey: key, senderMachine: meta.machine_id, senderStream: meta.stream_id, now });
      try { applyMappingBatch(target, valid, { hubMachine, effects, now, sessionHome: id => localHome(globalDb, id) }); }
      catch (error) {
        const advanced = target.prepare("SELECT last_seq FROM roam_cursors WHERE peer_machine = ? AND peer_stream = ?")
          .get(meta.machine_id, meta.stream_id) as { last_seq: number } | undefined;
        if (error instanceof CursorMismatchError && advanced && advanced.last_seq > artifact.header.after) continue;
        throw error;
      }
    }
    const versions = source.prepare("SELECT entity,row_key,change_id,hlc_ms,hlc_count,origin_machine,origin_stream,deleted FROM roam_versions").iterate() as IterableIterator<Version>;
    const find = target.prepare("SELECT entity,row_key,change_id,hlc_ms,hlc_count,origin_machine,origin_stream,deleted FROM roam_versions WHERE entity = ? AND row_key = ?");
    const clock = (row: Version) => ({ ms: row.hlc_ms, count: row.hlc_count, machine: row.origin_machine, stream: row.origin_stream });
    for (const version of versions) {
      const winner = find.get(version.entity, version.row_key) as Version | undefined;
      if (!winner || winner.change_id !== version.change_id && compareHlc(clock(winner), clock(version)) <= 0) {
        throw new Error(`Replica version not contained for ${version.entity}/${version.row_key}`);
      }
    }
    return true;
  } finally { target?.close(); source.close(); }
}

class MissingRepositoryIdentityError extends Error {}
type RootReader = (path: string) => readonly string[];
interface RepositoryFacts { common: string; fingerprint: string; originKey: string | null; rootKey: string | null }

function readRoots(path: string): readonly string[] {
  const output = execFileSync("git", ["rev-list", "--max-parents=0", "--all"], { cwd: path, env: commandEnv(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  return output ? output.split(/\r?\n/) : [];
}

function repositoryFacts(path: string, roots: RootReader | null): RepositoryFacts | null {
  const common = gitCommonDir(path);
  if (!common) return null;
  let origin: string | null = null;
  try { origin = execFileSync("git", ["config", "--get", "remote.origin.url"], { cwd: path, env: commandEnv(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); }
  catch (error) { if ((error as { status?: number }).status !== 1) throw error; }
  const originKey = origin && canonicalOrigin(origin) ? repoIdentity({ origin, roots: [] }) : null;
  const stat = statSync(common);
  const fingerprint = JSON.stringify([String(stat.dev), String(stat.ino), originKey]);
  const values = roots ? roots(path) : [];
  return { common, fingerprint, originKey, rootKey: values.length ? repoIdentity({ origin: null, roots: values }) : null };
}

function cacheInitialFacts(globalDb: Db, facts: RepositoryFacts): RepositoryFacts {
  return globalDb.raw.transaction(() => {
    const existing = readLocal<RepositoryFacts>(globalDb, "repository-cache", facts.common);
    if (existing && existing.fingerprint !== facts.fingerprint) throw new Error("Repository changed and requires an explicit map");
    if (existing) return existing;
    writeLocal(globalDb, "repository-cache", facts.common, facts);
    return facts;
  }).immediate();
}

export function resolveRepositoryKey(globalDb: Db, path: string, options?: { readRoots?: RootReader }): string {
  const absolute = realpathSync(path);
  const rows = globalDb.prepare("SELECT repo_key,path,origin_fingerprint,root_fingerprint FROM roam_repo_maps").all() as Array<{ repo_key: string; path: string; origin_fingerprint: string | null; root_fingerprint: string | null }>;
  const facts = repositoryFacts(absolute, null);
  const mapped = rows.find(row => row.path === absolute || facts && gitCommonDir(row.path) === facts.common);
  if (!facts) {
    if (mapped?.path === absolute) return mapped.repo_key;
    throw new MissingRepositoryIdentityError("Non-Git repositories require an explicit map");
  }
  const cached = readLocal<RepositoryFacts>(globalDb, "repository-cache", facts.common);
  if (cached && cached.fingerprint !== facts.fingerprint || mapped?.origin_fingerprint && mapped.origin_fingerprint !== facts.fingerprint) {
    throw new Error("Repository changed and requires an explicit map");
  }
  if (mapped) return mapped.repo_key;
  if (facts.originKey) return (cached ?? cacheInitialFacts(globalDb, facts)).originKey!;
  if (cached?.rootKey) return cached.rootKey;
  const rootKey = repositoryFacts(absolute, options?.readRoots ?? readRoots)?.rootKey;
  if (!rootKey) throw new MissingRepositoryIdentityError("An unborn repository requires an explicit key");
  const saved = cacheInitialFacts(globalDb, { ...facts, rootKey });
  if (!saved.rootKey) throw new MissingRepositoryIdentityError("An unborn repository requires an explicit key");
  return saved.rootKey;
}

export function discoverRepository(globalDb: Db, repoKey: string, roots: readonly string[]): string | null {
  const matches = new Set<string>();
  let visited = 0;
  const visit = (directory: string) => {
    if (++visited > 10000) throw new Error("Repository discovery exceeded its limit");
    const entries = readdirSync(directory, { withFileTypes: true });
    if (entries.some(entry => entry.name === ".git" && (entry.isFile() || entry.isDirectory()))) {
      try { if (resolveRepositoryKey(globalDb, directory) === repoKey) matches.add(directory); }
      catch (error) { if (!(error instanceof MissingRepositoryIdentityError)) throw error; }
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === ".git" || entry.name === ".spider" || entry.name === "node_modules") continue;
      visit(join(directory, entry.name));
    }
  };
  for (const root of roots) {
    const stat = lstatSync(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Unsafe discovery root");
    visit(realpathSync(root));
  }
  if (matches.size > 1) throw new Error("Ambiguous repository discovery");
  return matches.values().next().value ?? null;
}

function stampTarget(globalDb: Db, intent: Intent, file: string, scope: Scope): void {
  // Hold the global writer lock only to serialize cancellation with this target commit.
  globalDb.raw.transaction(() => {
    if (!requirePending(globalDb, intent, file)) return;
    checkExistingStore(file);
    const source = openDbReadOnly(replicaPath(globalDb, intent.store_key));
    if (!source) throw new Error("Mapping fence replica disappeared");
    try {
      const hint = readLocal<MappingFenceTarget>(source, FENCE_TARGET, intent.store_key);
      const stat = statSync(file, { bigint: true });
      if (!hint || hint.file !== file || hint.device !== String(stat.dev) || hint.inode !== String(stat.ino))
        throw new Error("Changed mapping fence target");
    } finally { source.close(); }
    const target = openDb(file, { fileMustExist: true, maxCoreSchemaVersion: SCHEMA_VERSION });
    try {
      target.raw.transaction(() => {
        validateTarget(target, globalDb, scope, intent.store_key);
        target.prepare("UPDATE roam_meta SET store_key=? WHERE id=1 AND store_key IS NULL").run(intent.store_key);
      }).immediate();
    } finally { target.close(); }
  }).immediate();
}

function catalogMapped(globalDb: Db, key: StoreKey): void {
  if (!key.startsWith("worktree:")) return;
  const db = openRoamStoreReadOnly(globalDb, key);
  if (!db) return;
  try { catalogReplica(globalDb, key, db); } finally { db.close(); }
}

async function map(globalDb: Db, input: { kind: "repo" | "workspace"; identity: string; key: StoreKey; path: string; command: string | null; repoKey: string; workspaceId?: string; facts?: RepositoryFacts | null }): Promise<void> {
  if (lstatSync(input.path).isSymbolicLink()) throw new Error("Unsafe mapping destination");
  const path = realpathSync(input.path);
  const scope = input.kind === "workspace" ? "worktree" : "repo";
  const targetFile = input.kind === "workspace" ? join(path, ".spider", "project.db") : join(repoRoot(path) ?? join(path, ".spider"), "repo.db");
  const requested: Intent = { kind: input.kind, identity: input.identity, target_path: path, store_key: input.key, command_json: input.command, attempt_id: randomUUID() };
  cleanupOrphanForKey(globalDb, input.key);
  const current = globalDb.raw.transaction(() => {
    const pending = readLocal<Intent>(globalDb, "mapping-intent", intentKey(input.kind, input.identity));
    if (pending && (pending.target_path !== path || pending.store_key !== input.key || pending.command_json !== input.command)) {
      throw new Error("Conflicting pending mapping");
    }
    const existing = input.kind === "repo"
      ? globalDb.prepare("SELECT path FROM roam_repo_maps WHERE repo_key = ?").get(input.repoKey) as { path: string } | undefined
      : globalDb.prepare("SELECT path FROM roam_workspace_maps WHERE repo_key = ? AND workspace_id = ?").get(input.repoKey, input.workspaceId) as { path: string } | undefined;
    if (!pending && existing?.path === path) {
      if (input.kind === "repo") {
        globalDb.prepare("UPDATE roam_repo_maps SET root_fingerprint = ?, origin_fingerprint = ?, worktree_command_json = ? WHERE repo_key = ? AND (root_fingerprint IS NOT ? OR origin_fingerprint IS NOT ? OR worktree_command_json IS NOT ?)")
          .run(input.facts?.rootKey ?? null, input.facts?.fingerprint ?? null, input.command, input.repoKey, input.facts?.rootKey ?? null, input.facts?.fingerprint ?? null, input.command);
        if (input.facts) writeLocal(globalDb, "repository-cache", input.facts.common, input.facts);
      }
      return { complete: true } as const;
    }
    if (existing && existing.path !== path) throw new Error("Mapping already exists at another path");
    const occupying = input.kind === "workspace"
      ? globalDb.prepare("SELECT 1 FROM roam_workspace_maps WHERE path = ?").get(path)
      : input.facts && (globalDb.prepare("SELECT path FROM roam_repo_maps WHERE repo_key != ?").all(input.repoKey) as Array<{ path: string }>).some(row => gitCommonDir(row.path) === input.facts!.common);
    const pendingConflict = localEntries<Intent>(globalDb, "mapping-intent").some(row => row.value?.kind === input.kind && typeof row.value.target_path === "string" && row.key !== intentKey(input.kind, input.identity) &&
      (row.value.target_path === path || input.kind === "repo" && input.facts && gitCommonDir(row.value.target_path) === input.facts.common));
    if (occupying || pendingConflict) throw new Error("Checkout is already mapped");
    // Check an existing target, or prepare a new one if there is a replica to merge,
    // before recording the intent or installing the durable source fence.
    preflightTarget(globalDb, targetFile, scope, input.key, exists(replicaPath(globalDb, input.key)));
    if (pending?.attempt_id !== undefined && (typeof pending.attempt_id !== "string" || !pending.attempt_id)) throw new Error("Invalid pending mapping attempt");
    const intent = pending ? { ...pending, attempt_id: pending.attempt_id ?? randomUUID() } : requested;
    if (!pending || pending.attempt_id === undefined) writeLocal(globalDb, "mapping-intent", intentKey(input.kind, input.identity), intent);
    return { complete: false, intent } as const;
  }).immediate();
  if (current.complete) { catalogMapped(globalDb, input.key); return; }
  const intent = current.intent;
  const merged = await merge(globalDb, input.key, targetFile, scope, intent);
  if (merged) stampTarget(globalDb, intent, targetFile, scope);
  preflightTarget(globalDb, targetFile, scope, input.key, false);
  globalDb.raw.transaction(() => {
    const pending = readLocal<Intent>(globalDb, "mapping-intent", intentKey(input.kind, input.identity));
    if (!pending) {
      const existing = input.kind === "repo"
        ? globalDb.prepare("SELECT path FROM roam_repo_maps WHERE repo_key = ?").get(input.repoKey) as { path: string } | undefined
        : globalDb.prepare("SELECT path FROM roam_workspace_maps WHERE repo_key = ? AND workspace_id = ?").get(input.repoKey, input.workspaceId) as { path: string } | undefined;
      const redirect = mappingRedirect(globalDb, input.key);
      if (existing?.path === path && redirect === targetFile) return;
      throw new Error("Pending mapping disappeared before publication");
    }
    if (pending.target_path !== path || pending.store_key !== input.key || pending.command_json !== input.command || pending.attempt_id !== intent.attempt_id)
      throw new Error("Conflicting pending mapping");
    if (input.kind === "repo") {
      globalDb.prepare("INSERT INTO roam_repo_maps(repo_key,path,worktree_command_json,root_fingerprint,origin_fingerprint) VALUES (?, ?, ?, ?, ?)")
        .run(input.repoKey, path, input.command, input.facts?.rootKey ?? null, input.facts?.fingerprint ?? null);
      if (input.facts) writeLocal(globalDb, "repository-cache", input.facts.common, input.facts);
    }
    else globalDb.prepare("INSERT INTO roam_workspace_maps(repo_key,workspace_id,path) VALUES (?, ?, ?)")
      .run(input.repoKey, input.workspaceId, path);
    writeLocal(globalDb, "mapping-redirect", input.key, targetFile);
    writeLocal(globalDb, "mapping-intent", intentKey(input.kind, input.identity), undefined);
    writeLocal(globalDb, "mapping-failure", intentKey(input.kind, input.identity), undefined);
  }).immediate();
  catalogMapped(globalDb, input.key);
}

export async function mapRepository(globalDb: Db, input: { repoKey: string; path: string; worktreeCommand?: readonly string[] }): Promise<void> {
  const facts = repositoryFacts(input.path, readRoots);
  await map(globalDb, { kind: "repo", identity: input.repoKey, key: `repo:${input.repoKey}`, path: input.path,
    command: input.worktreeCommand ? JSON.stringify(input.worktreeCommand) : null, repoKey: input.repoKey, facts });
}

export function mapWorkspace(globalDb: Db, input: { repoKey: string; workspaceId: string; path: string }): Promise<void> {
  return map(globalDb, { kind: "workspace", identity: JSON.stringify([input.repoKey, input.workspaceId]), key: `worktree:${input.repoKey}:${input.workspaceId}`,
    path: input.path, command: null, repoKey: input.repoKey, workspaceId: input.workspaceId });
}

function mappingPublished(globalDb: Db, key: StoreKey): boolean {
  if (mappingRedirect(globalDb, key) !== null) return true;
  if (key.startsWith("repo:")) return Boolean(globalDb.prepare("SELECT 1 FROM roam_repo_maps WHERE repo_key=?").get(key.slice(5)));
  if (key.startsWith("worktree:")) {
    const separator = key.lastIndexOf(":");
    return Boolean(globalDb.prepare("SELECT 1 FROM roam_workspace_maps WHERE repo_key=? AND workspace_id=?")
      .get(key.slice("worktree:".length, separator), key.slice(separator + 1)));
  }
  return false;
}

/** A locator is part of the fence, not a second journal; retain it until cleanup finishes. */
function cleanupOrphanForKey(globalDb: Db, key: StoreKey): void {
  const file = replicaPath(globalDb, key);
  if (!exists(file)) return;
  globalDb.raw.transaction(() => {
    if (mappingPublished(globalDb, key) || localEntries<Intent>(globalDb, "mapping-intent").some(row => row.value?.store_key === key)) return;
    checkExistingStore(file);
    const snapshot = openDbReadOnly(file)!;
    let fenced: unknown, targetHint: unknown;
    try {
      if (!snapshot.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='roam_cursors'").get()) return;
      fenced = snapshot.prepare("SELECT 1 FROM roam_cursors WHERE peer_machine=? AND peer_stream=?").get(FENCE_MACHINE, FENCE_STREAM);
      targetHint = readLocal<unknown>(snapshot, FENCE_TARGET, key);
      if (!fenced && targetHint === undefined) return;
      const meta = snapshot.prepare("SELECT store_key FROM roam_meta WHERE id=1").get() as { store_key: string | null } | undefined;
      if (!meta || meta.store_key !== key) throw new Error("Mapping fence store does not match the replica");
    } finally { snapshot.close(); }
    if (targetHint !== undefined) {
      if (!targetHint || typeof targetHint !== "object" || Array.isArray(targetHint)) throw new Error("Invalid mapping fence target");
      const hint = targetHint as Partial<MappingFenceTarget>, scope = storeScope(key);
      if (typeof hint.file !== "string" || !isAbsolute(hint.file) || typeof hint.device !== "string" || typeof hint.inode !== "string" ||
          typeof hint.clearOnCancel !== "boolean" ||
          scope === "global" || scope === "worktree" && (basename(hint.file) !== "project.db" || basename(dirname(hint.file)) !== ".spider") ||
          scope === "repo" && (basename(hint.file) !== "repo.db" || !["spider", ".spider"].includes(basename(dirname(hint.file)))))
        throw new Error("Invalid mapping fence target");
      if (hint.clearOnCancel && exists(hint.file)) {
        checkExistingStore(hint.file);
        const targetStat = statSync(hint.file, { bigint: true });
        if (String(targetStat.dev) !== hint.device || String(targetStat.ino) !== hint.inode) throw new Error("Changed mapping fence target");
        for (const other of [file, globalDb.raw.name]) {
          const stat = statSync(other, { bigint: true });
          if (stat.dev === targetStat.dev && stat.ino === targetStat.ino) throw new Error("Invalid mapping fence target");
        }
        const target = openDb(hint.file, { fileMustExist: true, maxCoreSchemaVersion: SCHEMA_VERSION });
        try {
          target.raw.transaction(() => {
            const machine = (globalDb.prepare("SELECT machine_id FROM roam_meta WHERE id=1").get() as { machine_id: string }).machine_id;
            // A local session that has enabled capture has independently claimed its identity.
            target.prepare("UPDATE roam_meta SET store_key=NULL WHERE id=1 AND machine_id=? AND store_key=? AND capture_enabled=0").run(machine, key);
          }).immediate();
        } finally { target.close(); }
      }
    }
    const source = openDb(file, { fileMustExist: true, maxCoreSchemaVersion: SCHEMA_VERSION });
    try {
      source.raw.transaction(() => {
        const meta = source.prepare("SELECT store_key FROM roam_meta WHERE id=1").get() as { store_key: string | null } | undefined;
        if (!meta || meta.store_key !== key) throw new Error("Mapping fence store does not match the replica");
        writeLocal(source, FENCE_TARGET, key, undefined);
        source.prepare("DELETE FROM roam_cursors WHERE peer_machine=? AND peer_stream=?").run(FENCE_MACHINE, FENCE_STREAM);
      }).immediate();
    } finally { source.close(); }
  }).immediate();
}

/** Cancel only an unpublished mapping; a committed redirect must keep its fence. */
export function cancelMapping(globalDb: Db, key: StoreKey): void {
  globalDb.raw.transaction(() => {
    if (mappingPublished(globalDb, key)) throw new Error("Cannot cancel a published mapping redirect");
    const pending = localEntries<Intent>(globalDb, "mapping-intent").filter(row => row.value?.store_key === key);
    for (const row of pending) {
      writeLocal(globalDb, "mapping-intent", row.key, undefined);
      writeLocal(globalDb, "mapping-failure", row.key, undefined);
    }
  }).immediate();
  cleanupOrphanForKey(globalDb, key);
}

function recordResumeFailure(globalDb: Db, key: string, storeKey: unknown, error: unknown): void {
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 1000);
  try {
    globalDb.raw.transaction(() => writeLocal(globalDb, "mapping-failure", key, {
      storeKey: typeof storeKey === "string" ? storeKey : null, error: message, at: Date.now(),
    })).immediate();
  } catch (recordError) {
    try { console.error("Could not record pending mapping failure", recordError); } catch { /* diagnostic is best effort */ }
  }
}

function cleanupOrphanedMappings(globalDb: Db): void {
  const directory = dirname(replicaPath(globalDb, "global"));
  let entries: Dirent[];
  try { entries = readdirSync(directory, { withFileTypes: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") recordResumeFailure(globalDb, "orphan-scan", null, error);
    return;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !/^[0-9a-f]{64}\.db$/.test(entry.name)) continue;
    const file = join(directory, entry.name);
    let key: StoreKey | undefined;
    try {
      checkExistingStore(file);
      const snapshot = openDbReadOnly(file)!;
      try {
        if (!snapshot.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='roam_meta'").get()) continue;
        key = (snapshot.prepare("SELECT store_key FROM roam_meta WHERE id=1").get() as { store_key: StoreKey | null } | undefined)?.store_key ?? undefined;
      } finally { snapshot.close(); }
      if (!key || storeScope(key) === "global" || replicaPath(globalDb, key) !== file) continue;
      cleanupOrphanForKey(globalDb, key);
      const failureKey = `orphan:${key}`;
      if (readLocal(globalDb, "mapping-failure", failureKey) !== undefined)
        globalDb.raw.transaction(() => writeLocal(globalDb, "mapping-failure", failureKey, undefined)).immediate();
    } catch (error) { recordResumeFailure(globalDb, `orphan:${key ?? entry.name}`, key, error); }
  }
}

export async function resumePendingMappings(globalDb: Db): Promise<void> {
  cleanupOrphanedMappings(globalDb);
  let pending: ReturnType<typeof localEntries<Intent>>;
  try { pending = localEntries<Intent>(globalDb, "mapping-intent"); }
  catch (error) { recordResumeFailure(globalDb, "invalid-intents", null, error); return; }
  for (const row of pending) {
    const intent = row.value;
    try {
      if (intent?.kind === "repo" && intent.store_key === `repo:${intent.identity}`) {
        const command: unknown = intent.command_json === null ? undefined : JSON.parse(intent.command_json);
        if (command !== undefined && (!Array.isArray(command) || command.some(value => typeof value !== "string"))) throw new Error("Invalid pending repository mapping");
        await mapRepository(globalDb, { repoKey: intent.identity, path: intent.target_path, worktreeCommand: command as string[] | undefined });
      } else if (intent?.kind === "workspace" && intent.command_json === null) {
        const identity: unknown = JSON.parse(intent.identity);
        if (!Array.isArray(identity) || identity.length !== 2 || identity.some(value => typeof value !== "string") || intent.store_key !== `worktree:${identity[0]}:${identity[1]}`) {
          throw new Error("Invalid pending workspace mapping");
        }
        await mapWorkspace(globalDb, { repoKey: identity[0], workspaceId: identity[1], path: intent.target_path });
      } else throw new Error("Invalid pending mapping");
    } catch (error) { recordResumeFailure(globalDb, row.key, intent?.store_key, error); }
  }
}

export function resolveWorkspace(globalDb: Db, repoKey: string, workspaceId: string): string | null {
  const row = globalDb.prepare("SELECT path FROM roam_workspace_maps WHERE repo_key = ? AND workspace_id = ?")
    .get(repoKey, workspaceId) as { path: string } | undefined;
  return row?.path ?? null;
}

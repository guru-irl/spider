import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, closeSync, constants, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { assertTestDbPath, openDb, type Db } from "../db";
import { migrate } from "../migrate";
import { gitCommonDir, repoRoot } from "../paths";
import { mappingRedirect, openRoamStoreReadOnly } from "./reads";
import { localEntries, readLocal, writeLocal } from "./local-state";
import { commandEnv } from "../command-env";
import { applyBatch, CursorMismatchError, fenceReplicaForMapping } from "./apply";
import { compareHlc } from "./hlc";
import { catalogReplica, replicaPath } from "./catalog";
import { validateBatch } from "./codec";
import { createReplicaEffects } from "./effects";
import { createExportPolicy } from "./event-policy";
import { exportBatch } from "./export";
import { canonicalOrigin, repoIdentity } from "./identity";
import type { Home, Scope, StoreKey } from "./types";

interface Intent { kind: string; identity: string; target_path: string; store_key: StoreKey; command_json: string | null }
interface Version { entity: string; row_key: string; change_id: string; hlc_ms: number; hlc_count: number; origin_machine: string; origin_stream: string; deleted: number }

const intentKey = (kind: string, identity: string) => JSON.stringify([kind, identity]);

function localHome(db: Db, sessionId: string): Home | null {
  const row = db.prepare("SELECT machine_id,epoch,move_id,updated_at FROM session_homes WHERE session_id = ?")
    .get(sessionId) as { machine_id: string; epoch: number; move_id: string | null; updated_at: number } | undefined;
  return row?.machine_id ? { sessionId, machineId: row.machine_id, epoch: row.epoch, moveId: row.move_id, updatedAt: row.updated_at } : null;
}

function openTarget(globalDb: Db, file: string, scope: Scope, key: StoreKey): Db {
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
    if (meta.store_key === null) db.prepare("UPDATE roam_meta SET store_key = ? WHERE id = 1").run(key);
    return db;
  } catch (error) { db.close(); throw error; }
}

async function merge(globalDb: Db, key: StoreKey, destination: string, scope: Scope): Promise<void> {
  const sourceFile = replicaPath(globalDb, key);
  try { lstatSync(sourceFile); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const source = openTarget(globalDb, sourceFile, scope, key);
  let target: Db | undefined;
  try {
    fenceReplicaForMapping(source, key);
    target = openTarget(globalDb, destination, scope, key);
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
      try { applyBatch(target, valid, { hubMachine, effects, now, sessionHome: id => localHome(globalDb, id) }); }
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

function catalogMapped(globalDb: Db, key: StoreKey): void {
  if (!key.startsWith("worktree:")) return;
  const db = openRoamStoreReadOnly(globalDb, key);
  if (!db) return;
  try { catalogReplica(globalDb, key, db); } finally { db.close(); }
}

async function map(globalDb: Db, input: { kind: "repo" | "workspace"; identity: string; key: StoreKey; path: string; command: string | null; repoKey: string; workspaceId?: string; facts?: RepositoryFacts | null }): Promise<void> {
  if (lstatSync(input.path).isSymbolicLink()) throw new Error("Unsafe mapping destination");
  const path = realpathSync(input.path);
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
      return true;
    }
    if (existing && existing.path !== path) throw new Error("Mapping already exists at another path");
    const occupying = input.kind === "workspace"
      ? globalDb.prepare("SELECT 1 FROM roam_workspace_maps WHERE path = ?").get(path)
      : input.facts && (globalDb.prepare("SELECT path FROM roam_repo_maps WHERE repo_key != ?").all(input.repoKey) as Array<{ path: string }>).some(row => gitCommonDir(row.path) === input.facts!.common);
    const pendingConflict = localEntries<Intent>(globalDb, "mapping-intent").some(row => row.value.kind === input.kind && row.key !== intentKey(input.kind, input.identity) &&
      (row.value.target_path === path || input.kind === "repo" && input.facts && gitCommonDir(row.value.target_path) === input.facts.common));
    if (occupying || pendingConflict) throw new Error("Checkout is already mapped");
    if (!pending) writeLocal<Intent>(globalDb, "mapping-intent", intentKey(input.kind, input.identity), {
      kind: input.kind, identity: input.identity, target_path: path, store_key: input.key, command_json: input.command,
    });
    return false;
  }).immediate();
  if (current) { catalogMapped(globalDb, input.key); return; }
  const targetFile = input.kind === "workspace" ? join(path, ".spider", "project.db") : join(repoRoot(path) ?? join(path, ".spider"), "repo.db");
  await merge(globalDb, input.key, targetFile, input.kind === "workspace" ? "worktree" : "repo");
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
    if (pending.target_path !== path || pending.store_key !== input.key || pending.command_json !== input.command) throw new Error("Conflicting pending mapping");
    if (input.kind === "repo") {
      globalDb.prepare("INSERT INTO roam_repo_maps(repo_key,path,worktree_command_json,root_fingerprint,origin_fingerprint) VALUES (?, ?, ?, ?, ?)")
        .run(input.repoKey, path, input.command, input.facts?.rootKey ?? null, input.facts?.fingerprint ?? null);
      if (input.facts) writeLocal(globalDb, "repository-cache", input.facts.common, input.facts);
    }
    else globalDb.prepare("INSERT INTO roam_workspace_maps(repo_key,workspace_id,path) VALUES (?, ?, ?)")
      .run(input.repoKey, input.workspaceId, path);
    writeLocal(globalDb, "mapping-redirect", input.key, targetFile);
    writeLocal(globalDb, "mapping-intent", intentKey(input.kind, input.identity), undefined);
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

export async function resumePendingMappings(globalDb: Db): Promise<void> {
  const pending = localEntries<Intent>(globalDb, "mapping-intent").map(row => row.value);
  for (const intent of pending) {
    if (intent.kind === "repo" && intent.store_key === `repo:${intent.identity}`) {
      const command: unknown = intent.command_json === null ? undefined : JSON.parse(intent.command_json);
      if (command !== undefined && (!Array.isArray(command) || command.some(value => typeof value !== "string"))) throw new Error("Invalid pending repository mapping");
      await mapRepository(globalDb, { repoKey: intent.identity, path: intent.target_path, worktreeCommand: command as string[] | undefined });
    } else if (intent.kind === "workspace" && intent.command_json === null) {
      const identity: unknown = JSON.parse(intent.identity);
      if (!Array.isArray(identity) || identity.length !== 2 || identity.some(value => typeof value !== "string") || intent.store_key !== `worktree:${identity[0]}:${identity[1]}`) {
        throw new Error("Invalid pending workspace mapping");
      }
      await mapWorkspace(globalDb, { repoKey: identity[0], workspaceId: identity[1], path: intent.target_path });
    } else throw new Error("Invalid pending mapping");
  }
}

export function resolveWorkspace(globalDb: Db, repoKey: string, workspaceId: string): string | null {
  const row = globalDb.prepare("SELECT path FROM roam_workspace_maps WHERE repo_key = ? AND workspace_id = ?")
    .get(repoKey, workspaceId) as { path: string } | undefined;
  return row?.path ?? null;
}

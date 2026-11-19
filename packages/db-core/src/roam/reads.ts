import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { assertTestDbPath, openDbReadOnly, type Db } from "../db";
import { repoRoot } from "../paths";
import type { StoreKey } from "./types";
import { readLocal, readLocalFromStreams } from "./local-state";

/** Catalog rows captured from one global store snapshot. */
export interface RoamCatalog {
  globalPath: string;
  machine: string;
  projects: readonly { db_path: string; git_common_dir: string | null }[];
  repos: readonly { repo_key: string; path: string }[];
  worktrees: readonly { repo_key: string; workspace_id: string; path: string }[];
  /** Only local mapping-redirect streams, as read from roam_cursors. */
  redirects: readonly { peer_stream: string }[];
}
export type RoamCatalogSource = Db | RoamCatalog;

export function catalogPath(source: RoamCatalogSource): string {
  return "raw" in source ? source.raw.name : source.globalPath;
}

export interface ReadStoreOptions { globalPath?: string; open?(file: string): Db | undefined }
function replicaPath(globalPath: string, key: StoreKey): string {
  return join(dirname(globalPath), "roam", "stores", `${createHash("sha256").update(key).digest("hex")}.db`);
}
export function roamReplicaPath(globalDb: Db, key: StoreKey): string { return replicaPath(globalDb.raw.name, key); }

export function openRoamPathReadOnly(file: string, open: (file: string) => Db | undefined = openDbReadOnly): Db | undefined {
  assertTestDbPath(file);
  try {
    const directory = dirname(file), parent = lstatSync(directory), target = lstatSync(file);
    const code = parent.isSymbolicLink() || target.isSymbolicLink() ? "STORE_PATH_SYMLINK"
      : !parent.isDirectory() || !target.isFile() ? "STORE_PATH_TYPE"
      : realpathSync(directory) !== directory ? "STORE_PATH_NONCANONICAL"
      : typeof process.getuid === "function" && (parent.uid !== process.getuid() || target.uid !== process.getuid()) ? "STORE_PATH_OWNER" : null;
    if (code) throw Object.assign(new Error("Unsafe roaming database path"), { code });
    return open(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export function mappingRedirect(source: RoamCatalogSource, key: StoreKey): string | null {
  const value = "raw" in source ? readLocal<unknown>(source, "mapping-redirect", key)
    : readLocalFromStreams<unknown>("mapping-redirect", key, source.redirects);
  if (value !== undefined && typeof value !== "string") throw new Error("Invalid mapping redirect");
  return value ?? null;
}

export function roamStorePath(source: RoamCatalogSource, key: StoreKey, options: ReadStoreOptions = {}): string {
  const globalPath = options.globalPath ?? catalogPath(source);
  if (key === "global") return globalPath;
  let mapped: { path: string } | undefined;
  if (key.startsWith("worktree:")) {
    const separator = key.lastIndexOf(":");
    const repoKey = key.slice("worktree:".length, separator), workspaceId = key.slice(separator + 1);
    mapped = "raw" in source
      ? source.prepare("SELECT path FROM roam_workspace_maps WHERE repo_key = ? AND workspace_id = ?").get(repoKey, workspaceId) as { path: string } | undefined
      : source.worktrees.find(row => row.repo_key === repoKey && row.workspace_id === workspaceId);
  } else if (key.startsWith("repo:")) {
    mapped = "raw" in source
      ? source.prepare("SELECT path FROM roam_repo_maps WHERE repo_key = ?").get(key.slice(5)) as { path: string } | undefined
      : source.repos.find(row => row.repo_key === key.slice(5));
  } else throw new Error("Invalid roaming store key");
  if (!mapped) return replicaPath(globalPath, key);
  const redirect = mappingRedirect(source, key);
  return redirect ?? (key.startsWith("worktree:") ? join(mapped.path, ".spider", "project.db") : join(repoRoot(mapped.path) ?? join(mapped.path, ".spider"), "repo.db"));
}

export function openRoamStoreReadOnly(source: RoamCatalogSource, key: StoreKey, options: ReadStoreOptions = {}): Db | undefined {
  return openRoamPathReadOnly(roamStorePath(source, key, options), options.open ?? openDbReadOnly);
}

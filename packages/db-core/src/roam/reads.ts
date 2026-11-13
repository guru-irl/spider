import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { assertTestDbPath, openDbReadOnly, type Db } from "../db";
import { repoRoot } from "../paths";
import type { StoreKey } from "./types";
import { readLocal } from "./local-state";

export interface ReadStoreOptions { globalPath?: string; open?(file: string): Db | undefined }
function replicaPath(globalPath: string, key: StoreKey): string {
  return join(dirname(globalPath), "roam", "stores", `${createHash("sha256").update(key).digest("hex")}.db`);
}
export function roamReplicaPath(globalDb: Db, key: StoreKey): string { return replicaPath(globalDb.raw.name, key); }

function openRoamPathReadOnly(file: string, open: (file: string) => Db | undefined): Db | undefined {
  assertTestDbPath(file);
  try {
    const directory = dirname(file), parent = lstatSync(directory), target = lstatSync(file);
    if (!parent.isDirectory() || parent.isSymbolicLink() || realpathSync(directory) !== directory || !target.isFile() || target.isSymbolicLink() ||
      typeof process.getuid === "function" && (parent.uid !== process.getuid() || target.uid !== process.getuid())) throw new Error("Unsafe roaming database path");
    return open(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export function mappingRedirect(globalDb: Db, key: StoreKey): string | null {
  const value = readLocal<unknown>(globalDb, "mapping-redirect", key);
  if (value !== undefined && typeof value !== "string") throw new Error("Invalid mapping redirect");
  return value ?? null;
}

export function openRoamStoreReadOnly(globalDb: Db, key: StoreKey, options: ReadStoreOptions = {}): Db | undefined {
  const globalPath = options.globalPath ?? globalDb.raw.name, open = options.open ?? openDbReadOnly;
  if (key === "global") return openRoamPathReadOnly(globalPath, open);
  let mapped: { path: string } | undefined;
  if (key.startsWith("worktree:")) {
    const separator = key.lastIndexOf(":");
    const repoKey = key.slice("worktree:".length, separator), workspaceId = key.slice(separator + 1);
    mapped = globalDb.prepare("SELECT path FROM roam_workspace_maps WHERE repo_key = ? AND workspace_id = ?").get(repoKey, workspaceId) as { path: string } | undefined;
  } else if (key.startsWith("repo:")) {
    mapped = globalDb.prepare("SELECT path FROM roam_repo_maps WHERE repo_key = ?").get(key.slice(5)) as { path: string } | undefined;
  } else throw new Error("Invalid roaming store key");
  if (!mapped) return openRoamPathReadOnly(replicaPath(globalPath, key), open);
  const redirect = mappingRedirect(globalDb, key);
  const file = redirect ?? (key.startsWith("worktree:") ? join(mapped.path, ".spider", "project.db") : join(repoRoot(mapped.path) ?? join(mapped.path, ".spider"), "repo.db"));
  return openRoamPathReadOnly(file, open);
}

// packages/db-core/src/registry.ts
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { realpathSync } from "node:fs";
import { join, isAbsolute, resolve, dirname } from "node:path";
import { openDb, type Db } from "./db.js";
import { migrate } from "./migrate.js";
import { paths, type Scope } from "./paths.js";

export interface ProjectInfo {
  projectKey: string;
  realPath: string;
  gitCommonDir?: string;
  dbPath: string;
  name?: string;
}

let _globalDbPathOverride: string | null = null;
/** Test-only: inject a scratch global DB path. Pass null to reset. */
export function setGlobalDbPathForTests(path: string | null): void {
  _globalDbPathOverride = path;
}
function globalDbPath(): string {
  return _globalDbPathOverride ?? join(paths.globalRoot, "spider.db");
}

export function openGlobal(): Db {
  const db = openDb(globalDbPath());
  migrate(db, "global");
  return db;
}

function gitCommonDir(cwd: string): string | undefined {
  try {
    const out = execFileSync("git", ["rev-parse", "--git-common-dir"], {
      cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (!out) return undefined;
    const abs = isAbsolute(out) ? out : resolve(cwd, out);
    return realpathSync(abs);
  } catch {
    return undefined; // not a git dir
  }
}

export function resolveProject(cwd: string): ProjectInfo {
  const realPath = realpathSync(cwd);
  const gcd = gitCommonDir(cwd);
  const projectKey = gcd ?? realPath;
  const dbPath = join(paths.projectRoot(realPath), "project.db");
  const info: ProjectInfo = { projectKey, realPath, gitCommonDir: gcd, dbPath };
  registerProject(info);
  return info;
}

export function registerProject(info: ProjectInfo): void {
  const g = openGlobal();
  try {
    const now = Date.now();
    g.withRetry(() => {
      g.prepare(
        `INSERT INTO projects (project_key, real_path, git_common_dir, db_path, name, created_at, last_seen_at)
         VALUES (@project_key, @real_path, @git_common_dir, @db_path, @name, @now, @now)
         ON CONFLICT(project_key) DO UPDATE SET
           real_path = excluded.real_path,
           git_common_dir = excluded.git_common_dir,
           db_path = excluded.db_path,
           last_seen_at = excluded.last_seen_at`
      ).run({
        project_key: info.projectKey,
        real_path: info.realPath,
        git_common_dir: info.gitCommonDir ?? null,
        db_path: info.dbPath,
        name: info.name ?? null,
        now,
      });
    });
  } finally {
    g.close();
  }
}

export function openProject(projectKey: string): Db {
  const g = openGlobal();
  let dbPath: string;
  try {
    const row = g.prepare("SELECT db_path FROM projects WHERE project_key = ?").get(projectKey) as
      | { db_path: string } | undefined;
    if (!row) throw new Error(`openProject: unknown project_key ${projectKey}`);
    dbPath = row.db_path;
  } finally {
    g.close();
  }
  mkdirSync(join(dbPath, ".."), { recursive: true });
  const db = openDb(dbPath);
  migrate(db, "project");
  return db;
}

/** Open a WAL Db at an explicit absolute path and migrate it (A3). Scope is inferred
 *  from the path (the global spider.db) unless passed explicitly. Used by import,
 *  cross-project reads, and tests that need an explicit-path open. */
export function openDbAt(absPath: string, scope?: Scope): Db {
  mkdirSync(dirname(absPath), { recursive: true });
  const db = openDb(absPath);
  const resolved: Scope = scope ?? (absPath === join(paths.globalRoot, "spider.db") ? "global" : "project");
  migrate(db, resolved);
  return db;
}

/** Open a project's DB by its real path (explicit-path open; no registry key needed) (A3). */
export function openProjectByPath(realPath: string): Db {
  const dbPath = join(paths.projectRoot(realpathSync(realPath)), "project.db");
  return openDbAt(dbPath, "project");
}

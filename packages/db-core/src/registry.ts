// packages/db-core/src/registry.ts
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { realpathSync } from "node:fs";
import { join, isAbsolute, resolve, dirname } from "node:path";
import { openDb, type Db } from "./db";
import { migrate } from "./migrate";
import { paths, type Scope, worktreeRoot, repoRoot } from "./paths";
import { getBinding, bindSession } from "./bindings";

export interface ProjectInfo {
  projectKey: string;
  realPath: string;
  gitCommonDir?: string;
  repoKey?: string;
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

export { repoRoot } from "./paths";

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

export function resolveProject(cwd: string, opts?: { sessionId?: string; explicitCwd?: boolean }): ProjectInfo {
  // Resolution order: explicit cwd > session binding > cwd's worktree root
  let resolvedCwd = cwd;
  const isExplicit = opts?.explicitCwd ?? true; // default to explicit for backward compat
  
  // If not explicit and we have a sessionId, check for binding
  if (!isExplicit && opts?.sessionId) {
    const g = openGlobal();
    try {
      const binding = getBinding(g, opts.sessionId);
      if (binding) {
        resolvedCwd = binding;
      } else {
        // No binding exists - check if we should auto-bind (promotes, never switches)
        // Auto-bind when resolving from a non-repo cwd (container or loose directory)
        const cwdIsRepo = gitCommonDir(cwd) !== undefined;
        if (!cwdIsRepo) {
          // Resolving from non-repo container - auto-bind to the resolved worktree
          const targetRoot = worktreeRoot(cwd);
          bindSession(g, opts.sessionId, targetRoot);
        }
      }
    } finally {
      g.close();
    }
  }
  
  const realPath = realpathSync(resolvedCwd);
  const gcd = gitCommonDir(resolvedCwd);
  const projectKey = worktreeRoot(resolvedCwd);
  const repoKey = gcd;
  const dbPath = join(paths.projectRoot(realPath), "project.db");
  const info: ProjectInfo = { projectKey, realPath, gitCommonDir: gcd, repoKey, dbPath };
  registerProject(info);
  return info;
}

export function registerProject(info: ProjectInfo): void {
  const g = openGlobal();
  try {
    const now = Date.now();
    g.withRetry(() => {
      g.prepare(
        `INSERT INTO projects (project_key, real_path, git_common_dir, repo_key, db_path, name, created_at, last_seen_at)
         VALUES (@project_key, @real_path, @git_common_dir, @repo_key, @db_path, @name, @now, @now)
         ON CONFLICT(project_key) DO UPDATE SET
           real_path = excluded.real_path,
           git_common_dir = excluded.git_common_dir,
           repo_key = excluded.repo_key,
           db_path = excluded.db_path,
           last_seen_at = excluded.last_seen_at`
      ).run({
        project_key: info.projectKey,
        real_path: info.realPath,
        git_common_dir: info.gitCommonDir ?? null,
        repo_key: info.repoKey ?? null,
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
  migrate(db, "worktree");
  return db;
}

/** Open a repo-tier DB by its repo_key (git common dir). */
export function openRepo(repoKey: string): Db {
  const dbPath = join(repoKey, "spider", "repo.db");
  mkdirSync(join(dbPath, ".."), { recursive: true });
  const db = openDb(dbPath);
  migrate(db, "repo");
  return db;
}

/** Open a WAL Db at an explicit absolute path and migrate it (A3). Scope is inferred
 *  from the path (the global spider.db) unless passed explicitly. Used by import,
 *  cross-project reads, and tests that need an explicit-path open. */
export function openDbAt(absPath: string, scope?: Scope): Db {
  mkdirSync(dirname(absPath), { recursive: true });
  const db = openDb(absPath);
  const resolved: Scope = scope ?? (absPath === join(paths.globalRoot, "spider.db") ? "global" : "worktree");
  // Map "project" to "worktree" for the deprecated alias
  const actualScope = resolved === "project" ? "worktree" : resolved;
  migrate(db, actualScope);
  return db;
}

/** Open a project's DB by its real path (explicit-path open; no registry key needed) (A3). */
export function openProjectByPath(realPath: string): Db {
  const dbPath = join(paths.projectRoot(realpathSync(realPath)), "project.db");
  return openDbAt(dbPath, "worktree");
}

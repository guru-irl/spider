// packages/db-core/src/paths.ts
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, isAbsolute, resolve } from "node:path";

export type Scope = "global" | "repo" | "worktree" | "project";

const GLOBAL_ROOT = join(homedir(), ".pi", "agent", "spider");

/** Resolve to the worktree root via git, falling back to realpath'd cwd when not in a repo.
 *  Never throws. */
export function worktreeRoot(cwd: string): string {
  try {
    const out = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (!out) return realpathSync(cwd);
    const abs = isAbsolute(out) ? out : resolve(cwd, out);
    return realpathSync(abs);
  } catch {
    // Not a git repo, git not available, or cwd doesn't exist
    try {
      return realpathSync(cwd);
    } catch {
      // cwd doesn't exist or can't be resolved
      return cwd;
    }
  }
}

export function projectRoot(cwd: string): string {
  return join(worktreeRoot(cwd), ".spider");
}

/** Resolve to the repo root (git common dir + "spider"), or undefined if not in a git repo.
 *  Falls back to worktree tier for non-git directories. */
export function repoRoot(cwd: string): string | undefined {
  try {
    const out = execFileSync("git", ["rev-parse", "--git-common-dir"], {
      cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (!out) return undefined;
    const abs = isAbsolute(out) ? out : resolve(cwd, out);
    return join(realpathSync(abs), "spider");
  } catch {
    return undefined; // Not a git repo
  }
}

function rootFor(scope: Scope, cwd?: string): string {
  if (scope === "global") return GLOBAL_ROOT;
  if (!cwd) throw new Error("paths: non-global scope requires cwd");
  // "project" is a deprecated alias for "worktree"
  if (scope === "repo") {
    const rr = repoRoot(cwd);
    if (!rr) {
      // Non-git directory: fall back to worktree tier
      return projectRoot(cwd);
    }
    return rr;
  }
  // "project" and "worktree" both map to projectRoot
  return projectRoot(cwd);
}

export const paths: {
  globalRoot: string;
  models: string;
  projectRoot: (cwd: string) => string;
  scratch: (scope: Scope, cwd?: string) => string;
  logs: (scope: Scope, cwd?: string) => string;
} = {
  globalRoot: GLOBAL_ROOT,
  models: join(GLOBAL_ROOT, "models"),
  projectRoot: projectRoot,
  scratch: (scope: Scope, cwd?: string): string => {
    return join(rootFor(scope, cwd), "scratch");
  },
  logs: (scope: Scope, cwd?: string): string => {
    return join(rootFor(scope, cwd), "logs");
  },
};

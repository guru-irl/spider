// packages/db-core/src/paths.ts
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, isAbsolute, resolve } from "node:path";

export type Scope = "global" | "project";

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

function rootFor(scope: Scope, cwd?: string): string {
  if (scope === "global") return GLOBAL_ROOT;
  if (!cwd) throw new Error("paths: project scope requires cwd");
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

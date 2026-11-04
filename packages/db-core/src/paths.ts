import { commandEnv } from "./command-env";
// packages/db-core/src/paths.ts
import { execFileSync } from "node:child_process";
import { lstatSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, isAbsolute, resolve } from "node:path";

export type Scope = "global" | "repo" | "worktree" | "project";

// Tests set this before modules load so every default global-tier path — including
// future openGlobal() call sites — stays inside process-scoped project scratch.
// Outside that explicit override, production retains the normal ~/.pi location.
const configuredGlobalRoot = process.env.SPIDER_GLOBAL_ROOT;
// Keep this predicate in sync with scripts/postinstall.mjs. That pre-build
// script cannot import this TypeScript module. Empty strings remain unset.
if (configuredGlobalRoot && (
  !isAbsolute(configuredGlobalRoot)
  || (process.platform === "win32" && /^[\\/](?![\\/])/.test(configuredGlobalRoot))
)) {
  throw new Error(
    `paths: SPIDER_GLOBAL_ROOT must be absolute; received ${JSON.stringify(configuredGlobalRoot)}`,
  );
}
if (process.env.VITEST && !configuredGlobalRoot) {
  throw new Error(
    "paths: refusing to resolve the real global root under Vitest; " +
    "vitest.setup.ts must set SPIDER_GLOBAL_ROOT before test modules load",
  );
}
const GLOBAL_ROOT = configuredGlobalRoot
  ? resolve(configuredGlobalRoot)
  : join(homedir(), ".pi", "agent", "spider");

interface GitResolution { root?: string; common?: string; checkedAt: number; fingerprint: string }
const gitResolutions = new Map<string, GitResolution>();
function gitFingerprint(cwd: string, root?: string): string {
  const entry = (path: string) => {
    try {
      const s = lstatSync(join(path, '.git'));
      return (s.isDirectory() ? [s.dev, s.ino, s.mode] : [s.dev, s.ino, s.mtimeMs, s.ctimeMs, s.size]).join(':');
    }
    catch { return ''; }
  };
  let directory = '';
  try { const s = statSync(cwd); directory = `${s.dev}:${s.ino}`; } catch { /* Missing cwd is also cached. */ }
  return `${directory}|${entry(cwd)}|${root && root !== cwd ? entry(root) : ''}`;
}
function discoverGit(cwd: string): GitResolution {
  const absolute = resolve(cwd), previous = gitResolutions.get(absolute), now = Date.now();
  if (previous && now >= previous.checkedAt && now - previous.checkedAt < 60_000
    && previous.fingerprint === gitFingerprint(absolute, previous.root)) return previous;
  const query = (argument: string): string | undefined => {
    try {
      const out = execFileSync('git', ['rev-parse', argument], { env: commandEnv(),
        cwd: absolute, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      return out ? realpathSync(isAbsolute(out) ? out : resolve(absolute, out)) : undefined;
    } catch { return undefined; }
  };
  let root = query('--show-toplevel');
  if (!root) { try { root = realpathSync(absolute); } catch { /* Preserve the caller's fallback for a missing cwd. */ } }
  const value = { root, common: query('--git-common-dir'), checkedAt: now, fingerprint: gitFingerprint(absolute, root) };
  gitResolutions.set(absolute, value); return value;
}
/** Test-only. Clear discovery after changing git's environment or fixture topology. */
export function resetProjectResolutionCacheForTests(): void { gitResolutions.clear(); }
/** Resolve via git, falling back to realpath'd cwd. Never throws. */
export function worktreeRoot(cwd: string): string { return discoverGit(cwd).root ?? cwd; }
export function gitCommonDir(cwd: string): string | undefined { return discoverGit(cwd).common; }

export function projectRoot(cwd: string): string {
  return join(worktreeRoot(cwd), ".spider");
}

/** Resolve to the repo root (git common dir + "spider"), or undefined if not in a git repo.
 *  Falls back to worktree tier for non-git directories. */
export function repoRoot(cwd: string): string | undefined {
  const common = gitCommonDir(cwd); return common ? join(common, 'spider') : undefined;
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

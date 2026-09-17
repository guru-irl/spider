// packages/host/src/__tests__/fixture-safety.ts
//
// Shared fixture-isolation safety net for tests that drive the real buildActionCtx /
// dispatch surface against scratch directories nested inside this real checkout.
// Used by organism-wiring.test.ts and extension.test.ts (and unit-tested directly by
// fixture-safety.test.ts) so both files apply the SAME guard instead of two drifting
// copies.
//
// Two layers, both load-bearing:
//
//  1. PREFLIGHT (assertPreflightIsolation) — DB-free, pure path resolution only. Uses
//     the package's exported pure resolvers: projectRoot(cwd) (wraps worktreeRoot) and
//     repoRoot(cwd) (wraps gitCommonDir, joined with "spider"). Neither opens,
//     migrates, or writes a database — both are `git rev-parse` + `realpathSync` only.
//     Must be called, and must pass, BEFORE any buildActionCtx / resolveProject /
//     openProject / openRepo call that would migrate a real DB. A fixture directory
//     that is missing its own `git init` (or whose repo-common-dir diverges from its
//     worktree root, e.g. `--separate-git-dir`) is rejected HERE, before anything is
//     opened against it. worktreeRoot/repoRoot both realpath the git-resolved case
//     (paths.ts); only the non-git *fallback* branch of worktreeRoot returns the raw
//     cwd un-realpath'd. Both helpers below realpath the caller-supplied fixture root
//     themselves before comparing, so a checkout reached through a symlink can't make
//     a genuinely-contained fixture look like it escaped (the residual asymmetry only
//     ever makes the guard MORE strict on that one fallback branch, never less).
//
//  2. POST-OPEN (assertPostOpenIsolation) — after a real ActionCtx exists, assert the
//     REAL resolved keys the damage path actually reads — project.projectKey (feeds
//     openProject) and project.repoKey (feeds openRepo) — NOT project.realPath, which
//     is only a realpath'd proxy of the resolved cwd and can agree with the fixture
//     even when projectKey/repoKey have diverged (git worktree / --separate-git-dir /
//     submodule shapes). Then read the ACTUAL on-disk file each of the three SQLite
//     handles (worktree/repo/global) has open, via `raw.pragma("database_list")` — the
//     wrapped `db.pragma()` is `{simple:true}` (db.ts) and would silently coerce to a
//     single scalar, so this always goes through `.raw` directly, never a fabricated
//     `Db.path`.
import { expect } from "vitest";
import { mkdirSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { isAbsolute, relative } from "node:path";
import { projectRoot, repoRoot, type Db } from "@spider/db-core";

/** True when `target` is `root` itself or nested anywhere underneath it. Path-aware
 *  (via path.relative) so a shared string prefix (e.g. a sibling "...-evil" dir)
 *  can't spoof containment. Mirrors extension.ts's own containment check. */
export function isPathInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** git-init `dir` (creating it first) before any resolver ever runs against it or a
 *  descendant. */
export function gitInit(dir: string): void {
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q", dir]);
}

/** DB-free preflight. Must be called, and must pass, BEFORE any buildActionCtx /
 *  resolveProject / openProject / openRepo call that would migrate a real DB. */
export function assertPreflightIsolation(dir: string, fixtureRoot: string): void {
  // Canonicalize the caller-supplied root the same way the resolvers themselves do
  // (see the file-header note on symlink safety) — an un-realpath'd root reached
  // through a symlinked checkout would otherwise make every guarded test fail
  // spuriously. The failure direction stays safe either way (false alarm, never a
  // false pass); this just removes the spurious-failure case.
  const root = realpathSync(fixtureRoot);
  const pRoot = projectRoot(dir);
  expect(
    isPathInside(root, pRoot),
    `preflight: resolved project root ${pRoot} escapes fixture ${root} \u2014 refusing to open/migrate any DB for ${dir}`,
  ).toBe(true);
  const rRoot = repoRoot(dir);
  if (rRoot !== undefined) {
    expect(
      isPathInside(root, rRoot),
      `preflight: resolved repo-common-dir root ${rRoot} escapes fixture ${root} \u2014 refusing to open/migrate any DB for ${dir}`,
    ).toBe(true);
  }
}

export interface ExpectedRoots {
  /** worktree/project-tier DB file must resolve inside this root */
  worktree: string;
  /** repo-tier DB file must resolve inside this root */
  repo: string;
  /** global DB file must resolve inside this root (may legitimately differ from
   *  worktree/repo — e.g. organism-wiring's global DB lives directly under its
   *  process-scoped scratch dir, one level above the project subdirectory). */
  global: string;
}

interface PostOpenCtx {
  project: { projectKey: string; repoKey?: string };
  db: Db;
  repoDb: Db;
  globalDb: Db;
}

function dbFile(db: Db, label: string): string {
  const rows = db.raw.pragma("database_list") as Array<{ name: string; file: string }>;
  const main = rows.find(r => r.name === "main");
  expect(main?.file, `${label} db connection must be an on-disk main database`).toBeTruthy();
  return realpathSync(main!.file);
}

export interface PostOpenOpts {
  /** When the caller KNOWS the fixture is its own git repo, require repoKey to be
   *  defined instead of silently skipping the repoKey containment check if it
   *  happens to be undefined (M3: a regression to `undefined` would otherwise be
   *  caught only indirectly, via the db-file checks, at call sites where
   *  expected.repo === expected.worktree). */
  requireRepoKey?: boolean;
}

/** Post-open guard. Call AFTER registering the ctx's handles for cleanup, so a thrown
 *  assertion here still leaves nothing open. Asserts the REAL projectKey/repoKey (not
 *  realPath) and the actual on-disk file backing each of the three SQLite handles,
 *  each against its own expected root — different roots are legitimate (see
 *  ExpectedRoots), so callers must pass the correct expectation per tier. Expected
 *  roots are realpath'd here (symlink safety, matching assertPreflightIsolation). */
export function assertPostOpenIsolation(ctx: PostOpenCtx, expected: ExpectedRoots, opts?: PostOpenOpts): void {
  const expWorktree = realpathSync(expected.worktree);
  const expRepo = realpathSync(expected.repo);
  const expGlobal = realpathSync(expected.global);
  expect(
    isPathInside(expWorktree, ctx.project.projectKey),
    `resolved projectKey ${ctx.project.projectKey} must be inside ${expWorktree}, not the real checkout (or another fixture)`,
  ).toBe(true);
  if (opts?.requireRepoKey) {
    expect(
      ctx.project.repoKey,
      "caller declared this a git fixture: repoKey must be defined, not silently skipped",
    ).toBeTruthy();
  }
  if (ctx.project.repoKey !== undefined) {
    expect(
      isPathInside(expRepo, ctx.project.repoKey),
      `resolved repoKey ${ctx.project.repoKey} must be inside ${expRepo}, not the real checkout (or another fixture)`,
    ).toBe(true);
  }
  expect(
    isPathInside(expWorktree, dbFile(ctx.db, "worktree")),
    "worktree db file must live under the expected worktree root",
  ).toBe(true);
  expect(
    isPathInside(expRepo, dbFile(ctx.repoDb, "repo")),
    "repo db file must live under the expected repo root",
  ).toBe(true);
  expect(
    isPathInside(expGlobal, dbFile(ctx.globalDb, "global")),
    "global db file must live under the expected global root",
  ).toBe(true);
}

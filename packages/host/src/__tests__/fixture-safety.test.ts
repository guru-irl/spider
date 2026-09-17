// packages/host/src/__tests__/fixture-safety.test.ts
//
// Direct, isolated unit coverage for the shared fixture-safety guard
// (fixture-safety.ts) used by organism-wiring.test.ts and extension.test.ts. Proves
// the guard actually DISCRIMINATES on every axis it claims to check — a wrong
// projectKey, a wrong repoKey, and each of the three out-of-root DB handles — using
// fully synthetic ProjectInfo/Db combinations built from real (but disposable)
// SQLite files, so a bug in the guard itself can never touch real repo state. Also
// proves the DB-free preflight rejects an escaping fixture BEFORE any DB-opening
// callback runs, and rejects a repo-common-dir escape independently of the
// worktree-root escape (a `git --separate-git-dir` fixture keeps the worktree root
// contained while the repo-tier root escapes it — a divergence a realPath-only or
// worktree-only check would miss).
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openDbAt, type Db } from "@spider/db-core";
import {
  assertPostOpenIsolation, assertPreflightIsolation, gitInit, isPathInside,
  type ExpectedRoots,
} from "./fixture-safety";

const scratch = join(dirname(fileURLToPath(import.meta.url)), "..", "..", ".spider", "scratch", `fixsafe-${process.pid}`);
const roots: string[] = [];
const handles: Db[] = [];

afterEach(() => {
  for (const db of handles.splice(0)) { try { db.close(); } catch { /* best-effort */ } }
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// afterEach above only removes each mkdtemp'd CHILD; the shared per-pid parent
// (`fixsafe-<pid>`) itself survives every run, leaking one empty directory into
// packages/host/.spider/scratch/ per test run. Remove it once, after all tests in
// this file are done (org-wire-*/ext-* siblings don't have this problem because
// their own afterEach rmSync's their whole root, not just mkdtemp children).
afterAll(() => {
  try { rmSync(scratch, { recursive: true, force: true }); } catch { /* best-effort */ }
});

function scratchDir(prefix: string): string {
  mkdirSync(scratch, { recursive: true });
  const dir = mkdtempSync(join(scratch, `${prefix}-`));
  roots.push(dir);
  return dir;
}

function dbAt(dir: string, name: string, scope: "worktree" | "repo" | "global" = "worktree"): Db {
  const db = openDbAt(join(dir, `${name}.db`), scope);
  handles.push(db);
  return db;
}

/** A fully-correct synthetic ctx: projectKey/repoKey and all three DB files agree
 *  with `expected`. Used as the baseline every discriminating test perturbs exactly
 *  one axis of. */
function goodCtx(expected: ExpectedRoots): { project: { projectKey: string; repoKey: string | undefined }; db: Db; repoDb: Db; globalDb: Db } {
  return {
    project: { projectKey: expected.worktree, repoKey: expected.repo as string | undefined },
    db: dbAt(expected.worktree, "worktree"),
    repoDb: dbAt(expected.repo, "repo", "repo"),
    globalDb: dbAt(expected.global, "global", "global"),
  };
}

function makeExpectedRoots(): ExpectedRoots {
  return { worktree: scratchDir("worktree"), repo: scratchDir("repo"), global: scratchDir("global") };
}

describe("assertPostOpenIsolation — discriminates every axis", () => {
  it("(control) passes when projectKey/repoKey and all three db files are correct", () => {
    const expected = makeExpectedRoots();
    expect(() => assertPostOpenIsolation(goodCtx(expected), expected)).not.toThrow();
  });

  it("rejects a wrong projectKey even though every db file is correct", () => {
    const expected = makeExpectedRoots();
    const evil = scratchDir("evil-projectkey");
    const ctx = goodCtx(expected);
    ctx.project.projectKey = evil;
    // Specific message, not a bare toThrow(): a helper that threw for an unrelated
    // reason (e.g. realpathSync ENOENT inside dbFile()) would otherwise keep this
    // green too (M2).
    expect(() => assertPostOpenIsolation(ctx, expected)).toThrow(/resolved projectKey .* must be inside/);
  });

  it("rejects a wrong repoKey even though every db file is correct", () => {
    const expected = makeExpectedRoots();
    const evil = scratchDir("evil-repokey");
    const ctx = goodCtx(expected);
    ctx.project.repoKey = evil;
    expect(() => assertPostOpenIsolation(ctx, expected)).toThrow(/resolved repoKey .* must be inside/);
  });

  it("rejects a worktree db handle whose file lives outside the expected worktree root", () => {
    const expected = makeExpectedRoots();
    const ctx = goodCtx(expected);
    const evil = scratchDir("evil-worktreedb");
    ctx.db = dbAt(evil, "worktree");
    expect(() => assertPostOpenIsolation(ctx, expected)).toThrow(/worktree db file must live under/);
  });

  it("rejects a repo db handle whose file lives outside the expected repo root", () => {
    const expected = makeExpectedRoots();
    const ctx = goodCtx(expected);
    const evil = scratchDir("evil-repodb");
    ctx.repoDb = dbAt(evil, "repo", "repo");
    expect(() => assertPostOpenIsolation(ctx, expected)).toThrow(/repo db file must live under/);
  });

  it("rejects a global db handle whose file lives outside the expected global root", () => {
    const expected = makeExpectedRoots();
    const ctx = goodCtx(expected);
    const evil = scratchDir("evil-globaldb");
    ctx.globalDb = dbAt(evil, "global", "global");
    expect(() => assertPostOpenIsolation(ctx, expected)).toThrow(/global db file must live under/);
  });

  it("rejects repoKey === undefined when the caller declares this a git fixture (requireRepoKey)", () => {
    // M3: without requireRepoKey, a regression to `repoKey === undefined` silently
    // SKIPS the repoKey check entirely (see the `if (ctx.project.repoKey !== undefined)`
    // guard in fixture-safety.ts) instead of failing. Callers whose fixture is known to
    // be its own git repo (organism-wiring.test.ts, extension.test.ts) opt into the
    // stricter contract.
    const expected = makeExpectedRoots();
    const ctx = goodCtx(expected);
    ctx.project.repoKey = undefined;
    expect(() => assertPostOpenIsolation(ctx, expected)).not.toThrow(); // still lenient by default
    expect(() => assertPostOpenIsolation(ctx, expected, { requireRepoKey: true }))
      .toThrow(/repoKey must be defined/);
  });
});

describe("assertPreflightIsolation — DB-free, before any resolver writes", () => {
  it("(control) passes for a fixture that is itself a git repo", () => {
    const dir = scratchDir("preflight-ok");
    gitInit(dir);
    expect(() => assertPreflightIsolation(dir, dir)).not.toThrow();
  });

  it("rejects a non-git nested candidate whose worktree walk escapes to a disposable enclosing repo — and never calls the guarded action", () => {
    // Requirement: negative cases build a DISPOSABLE enclosing git repo first, then a
    // non-git nested candidate — so even a buggy guard only ever falls back into
    // disposable data, never the real checkout.
    const enclosingRepo = scratchDir("disposable-enclosing");
    execFileSync("git", ["init", "-q", enclosingRepo]);
    const candidate = join(enclosingRepo, "not-a-repo", "nested");
    mkdirSync(candidate, { recursive: true });

    let actionCalled = false;
    const openAction = () => { actionCalled = true; };
    expect(() => {
      assertPreflightIsolation(candidate, candidate); // candidate is not its own repo -> escapes to enclosingRepo
      openAction();
    }).toThrow(/project root .* escapes fixture/);
    expect(actionCalled, "the guarded action must never run once preflight rejects the fixture").toBe(false);
  });

  it("rejects a git --separate-git-dir fixture whose repo-common-dir escapes the fixture even though the worktree root itself is correctly contained", () => {
    // Constructs a real, fully-disposable divergence between the worktree root
    // (inside the fixture) and the repo/common-dir (outside it) WITHOUT needing a
    // linked `git worktree` — proving the preflight's repo-root check is load-bearing
    // independently of the worktree-root check (a worktree-only preflight would pass
    // this fixture and let a repo-tier DB open escape).
    const fixtureRoot = scratchDir("separate-gitdir-fixture");
    const outsideGitDir = scratchDir("separate-gitdir-outside");
    const worktree = join(fixtureRoot, "worktree");
    execFileSync("git", ["init", "-q", `--separate-git-dir=${join(outsideGitDir, "gitdir")}`, worktree]);
    expect(() => assertPreflightIsolation(worktree, fixtureRoot)).toThrow(/repo-common-dir root .* escapes fixture/);
  });
});

describe("isPathInside", () => {
  it("is path-aware, not a naive string-prefix test", () => {
    expect(isPathInside("/repo", "/repo-decoy")).toBe(false);
    expect(isPathInside("/repo", "/repo/sub")).toBe(true);
    expect(isPathInside("/repo", "/repo")).toBe(true);
  });
});

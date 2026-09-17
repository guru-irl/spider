// packages/host/src/__tests__/action-cwd.test.ts
//
// Focused regressions for buildActionCtx's CWD resolution: a session binding
// must move `ctx.cwd` to the bound tree only when the current cwd actually
// falls OUTSIDE that tree; a cwd nested inside the selected tree (with or
// without a binding) must be preserved, and an explicit args.cwd always wins.
// Fixture dirs are `git init`-ed before any resolution call so resolveProject's
// git-toplevel walk cannot escape into this real spider checkout.
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { bindSession, openGlobal, setGlobalDbPathForTests, type Db } from "@spider/db-core";
import { buildActionCtx } from "../extension";

const scratch = resolve(".spider/scratch/action-cwd");
const roots: string[] = [];
const handles: Db[] = [];

afterEach(() => {
  for (const db of handles.splice(0)) db.close();
  setGlobalDbPathForTests(null);
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function gitRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q", dir]);
}

function setup() {
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, "case-"));
  roots.push(root);
  setGlobalDbPathForTests(join(root, "global.db"));
  return root;
}

function ctxOf(sessionId: string, cwd: string, args: Record<string, unknown> = { action: "run" }) {
  const ctx = buildActionCtx({} as never, args as never, sessionId, cwd);
  handles.push(ctx.db, ctx.repoDb, ctx.globalDb);
  return ctx;
}

describe("buildActionCtx cwd resolution", () => {
  it("with no binding, preserves a nested cwd rather than snapping to the worktree root", () => {
    const root = setup();
    const repo = join(root, "repo"); gitRepo(repo);
    const nested = join(repo, "sub", "dir"); mkdirSync(nested, { recursive: true });
    const ctx = ctxOf("s-no-binding", nested);
    expect(ctx.cwd).toBe(nested);
  });

  it("when a binding targets the SAME tree (an ancestor), preserves the nested subdirectory cwd", () => {
    const root = setup();
    const repo = join(root, "repo"); gitRepo(repo);
    const nested = join(repo, "sub", "dir"); mkdirSync(nested, { recursive: true });
    const g = openGlobal();
    bindSession(g, "s-ancestor-binding", repo);
    g.close();
    const ctx = ctxOf("s-ancestor-binding", nested);
    // The binding confirms the SAME tree the caller is already in; the nested
    // subdirectory the caller actually runs from must not be discarded.
    expect(ctx.cwd).toBe(nested);
  });

  it("when a binding moves execution to a DIFFERENT tree, adopts the bound tree root", () => {
    const root = setup();
    const repoA = join(root, "repo-a"); gitRepo(repoA);
    const repoB = join(root, "repo-b"); gitRepo(repoB);
    const g = openGlobal();
    bindSession(g, "s-cross-binding", repoB);
    g.close();
    const ctx = ctxOf("s-cross-binding", repoA);
    expect(ctx.cwd).toBe(repoB);
  });

  it("an explicit args.cwd override always wins, even across an active binding", () => {
    const root = setup();
    const repoA = join(root, "repo-a"); gitRepo(repoA);
    const repoB = join(root, "repo-b"); gitRepo(repoB);
    const g = openGlobal();
    bindSession(g, "s-explicit-override", repoB);
    g.close();
    const ctx = ctxOf("s-explicit-override", repoA, { action: "run", cwd: repoA });
    expect(ctx.cwd).toBe(repoA);
  });

  it("when a binding targets a SUBDIRECTORY and cwd is a sibling subdirectory of the same worktree, preserves the sibling cwd", () => {
    const root = setup();
    const repo = join(root, "repo"); gitRepo(repo);
    const boundSub = join(repo, "packages", "host"); mkdirSync(boundSub, { recursive: true });
    const siblingSub = join(repo, "packages", "db-core"); mkdirSync(siblingSub, { recursive: true });
    const g = openGlobal();
    bindSession(g, "s-sibling-subdir-binding", boundSub);
    g.close();
    const ctx = ctxOf("s-sibling-subdir-binding", siblingSub);
    // The binding is to a SUBDIRECTORY of the same worktree, not a different tree.
    // Nothing crossed trees: projectKey (the worktree root) is identical either way,
    // every DB handle would already be correct, yet a realPath-anchored containment
    // check would judge `siblingSub` "outside" the bound subdir and wrongly snap the
    // caller into `boundSub`, discarding the actual subdirectory it is running from.
    expect(ctx.cwd).toBe(siblingSub);
  });

  it("a symlinked cwd whose canonical path is inside the selected tree is preserved verbatim (not re-anchored)", () => {
    const root = setup();
    const repo = join(root, "repo"); gitRepo(repo);
    const nested = join(repo, "sub", "dir"); mkdirSync(nested, { recursive: true });
    const link = join(root, "link-to-nested");
    symlinkSync(nested, link, "dir");
    const ctx = ctxOf("s-symlink-into-tree", link);
    // safeRealpath resolves `link` to `nested` (inside the tree) only to DECIDE
    // containment; the returned cwd is the caller's original symlink path, verbatim.
    expect(ctx.cwd).toBe(link);
  });

  it("path-prefix edge case: a sibling dir sharing a string prefix is NOT treated as contained", () => {
    const root = setup();
    const repo = join(root, "repo"); gitRepo(repo);
    // Shares the "repo" string prefix but is a distinct sibling directory, not a subdirectory.
    const decoy = join(root, "repo-decoy"); gitRepo(decoy);
    const g = openGlobal();
    bindSession(g, "s-prefix-edge", repo);
    g.close();
    const ctx = ctxOf("s-prefix-edge", decoy);
    // A naive `target.startsWith(root)` check would wrongly call this "contained" and
    // keep `decoy`; path-aware containment must recognize it is outside `repo` and
    // adopt the bound tree root instead.
    expect(ctx.cwd).toBe(repo);
  });

  it("when a binding targets a SUBDIRECTORY of a DIFFERENT tree, adopts that subdirectory verbatim, not the tree root", () => {
    // Coverage addition only (current production behavior already passes this):
    // crossing trees must not normalize away an explicitly bound subdirectory.
    const root = setup();
    const repoA = join(root, "repo-a"); gitRepo(repoA);
    const repoB = join(root, "repo-b"); gitRepo(repoB);
    const boundSub = join(repoB, "packages", "host"); mkdirSync(boundSub, { recursive: true });
    const g = openGlobal();
    bindSession(g, "s-cross-tree-subdir-binding", boundSub);
    g.close();
    const ctx = ctxOf("s-cross-tree-subdir-binding", repoA);
    // rawCwd (repoA) falls outside the bound tree (repoB), so the bound destination is
    // adopted — and that destination is `boundSub` itself, not `repoB`'s root.
    expect(ctx.cwd).toBe(boundSub);
  });

  it("when a binding targets a SUBDIRECTORY of the SAME tree and raw cwd is that tree's ROOT, preserves the raw root (does not force a chdir into the bound subdir)", () => {
    // Coverage addition only (current production behavior already passes this): a
    // same-tree subdirectory binding is cwd-inert when the caller is already anywhere
    // inside that tree, including at its very root.
    const root = setup();
    const repo = join(root, "repo"); gitRepo(repo);
    const boundSub = join(repo, "packages", "host"); mkdirSync(boundSub, { recursive: true });
    const g = openGlobal();
    bindSession(g, "s-same-tree-root-binding", boundSub);
    g.close();
    const ctx = ctxOf("s-same-tree-root-binding", repo);
    // projectKey (repo) contains rawCwd (repo itself, rel === ""), so rawCwd wins —
    // the caller stays at the tree root instead of being snapped into `boundSub`.
    expect(ctx.cwd).toBe(repo);
  });
});

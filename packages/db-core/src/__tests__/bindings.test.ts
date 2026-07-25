// packages/db-core/src/__tests__/bindings.test.ts
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { bindSession, unbindSession, getBinding } from "../bindings";
import { resolveProject, setGlobalDbPathForTests, openGlobal } from "../registry";
import { scratchDbPath, cleanupScratch } from "../testutil";

const scratchRoot = join(__dirname, "../../.spider/scratch", String(process.pid), "bindings");

beforeEach(() => {
  setGlobalDbPathForTests(scratchDbPath("global-bindings"));
  mkdirSync(scratchRoot, { recursive: true });
});

afterEach(() => {
  setGlobalDbPathForTests(null);
  cleanupScratch();
  try { rmSync(scratchRoot, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe("session bindings", () => {
  // Mutation: reorder resolution to check binding before explicit cwd → this test MUST fail
  it("explicit cwd WINS over an existing binding", () => {
    const wtA = join(scratchRoot, "repo-a");
    const wtB = join(scratchRoot, "repo-b");
    mkdirSync(wtA, { recursive: true });
    mkdirSync(wtB, { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: wtA });
    execFileSync("git", ["init", "-q"], { cwd: wtB });

    const g = openGlobal();
    bindSession(g, "s1", wtA);
    g.close();

    // Resolve with explicit cwd=wtB, binding points to wtA
    // Resolution must use wtB (explicit cwd wins)
    const info = resolveProject(wtB, { sessionId: "s1" });
    expect(info.projectKey).toContain("repo-b");
    expect(info.projectKey).not.toContain("repo-a");
  });

  // Mutation: ignore bindings in resolution → this test MUST fail
  it("a binding WINS over cwd-derived resolution", () => {
    const wtA = join(scratchRoot, "wt-a");
    const wtB = join(scratchRoot, "wt-b");
    mkdirSync(wtA, { recursive: true });
    mkdirSync(wtB, { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: wtA });
    execFileSync("git", ["init", "-q"], { cwd: wtB });

    const g = openGlobal();
    bindSession(g, "s1", wtA);
    g.close();

    // Resolve from wtB's cwd, but binding points to wtA
    // Resolution must use wtA (binding wins over cwd)
    const info = resolveProject(wtB, { sessionId: "s1", explicitCwd: false });
    expect(info.projectKey).toContain("wt-a");
    expect(info.projectKey).not.toContain("wt-b");
  });

  // Mutation: make auto-bind unconditional (always update binding) → this test MUST fail
  it("an existing binding is NOT overwritten by opening a different worktree", () => {
    const base = join(scratchRoot, "main");
    mkdirSync(base, { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: base });
    execFileSync("git", ["config", "user.name", "test"], { cwd: base });
    execFileSync("git", ["config", "user.email", "test@test"], { cwd: base });
    execFileSync("git", ["commit", "--allow-empty", "-m", "init"], { cwd: base });

    const wtB = join(scratchRoot, "wt-second");
    execFileSync("git", ["worktree", "add", wtB], { cwd: base });

    try {
      // Bind to main worktree
      const g = openGlobal();
      bindSession(g, "s1", base);
      const binding1 = getBinding(g, "s1");
      g.close();
      expect(binding1).toContain("main");

      // Now resolve from wtB - must NOT overwrite the binding
      resolveProject(wtB, { sessionId: "s1", explicitCwd: false });

      const g2 = openGlobal();
      const binding2 = getBinding(g2, "s1");
      g2.close();

      // Binding must still point to main, not wtB
      expect(binding2).toBe(binding1);
      expect(binding2).toContain("main");
      expect(binding2).not.toContain("wt-second");
    } finally {
      try {
        execFileSync("git", ["worktree", "remove", "--force", wtB], { cwd: base });
      } catch { /* best effort */ }
    }
  });

  // Mutation: skip binding creation → this test MUST fail
  it("binding a session that has none creates one", () => {
    const wt = join(scratchRoot, "new-binding");
    mkdirSync(wt, { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: wt });

    const g = openGlobal();
    
    // No binding initially
    const before = getBinding(g, "s1");
    expect(before).toBeUndefined();

    // Create binding
    bindSession(g, "s1", wt);
    
    const after = getBinding(g, "s1");
    g.close();
    
    expect(after).toBe(wt);
  });

  // Mutation: skip unbind cleanup → this test MUST fail
  it("unbind removes binding and resolution falls back to cwd", () => {
    const wtA = join(scratchRoot, "bound");
    const wtB = join(scratchRoot, "fallback");
    mkdirSync(wtA, { recursive: true });
    mkdirSync(wtB, { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: wtA });
    execFileSync("git", ["init", "-q"], { cwd: wtB });

    const g = openGlobal();
    bindSession(g, "s1", wtA);
    expect(getBinding(g, "s1")).toBe(wtA);
    
    // Unbind
    unbindSession(g, "s1");
    expect(getBinding(g, "s1")).toBeUndefined();
    g.close();

    // Resolution should now use cwd (wtB), not old binding
    const info = resolveProject(wtB, { sessionId: "s1", explicitCwd: false });
    expect(info.projectKey).toContain("fallback");
    expect(info.projectKey).not.toContain("bound");
  });
});

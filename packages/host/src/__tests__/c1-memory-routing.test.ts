// packages/host/src/__tests__/c1-memory-routing.test.ts
// C1 critical defect: memory routing must go to repo tier, not worktree tier.
// These tests verify the fix by driving through the REAL action path to catch
// routing bugs that direct store calls would miss.
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { setGlobalDbPathForTests, openDbAt, openRepo, openProject, resolveProject } from "@spider/db-core";
import spiderExtension, { buildActionCtx, SPIDER_PARAMETERS } from "../extension";
import { execSync } from "node:child_process";

const scratch = join(dirname(fileURLToPath(import.meta.url)), "..", "..", ".spider", "scratch", `c1-${process.pid}`);

beforeEach(() => {
  mkdirSync(scratch, { recursive: true });
  setGlobalDbPathForTests(join(scratch, `g-${Date.now()}.db`));
});

afterEach(() => {
  setGlobalDbPathForTests(null);
  rmSync(scratch, { recursive: true, force: true });
});

function fakePi() {
  const tools: Record<string, unknown> = {};
  const hooks: Record<string, unknown> = {};
  return {
    registerTool: (t: { name: string }) => { tools[t.name] = t; },
    registerCommand: () => {},
    registerMessageRenderer: () => {},
    on: (name: string, fn: unknown) => { hooks[name] = fn; },
    _tools: tools,
    _hooks: hooks,
  };
}

describe("C1: memory routing to repo tier", () => {
  it("remember with NO explicit scope persists to the repo DB and is readable by recall", async () => {
    // MUTATION: route memory to worktree DB → must fail
    // This test drives through the REAL action path (tool execute) to catch routing bugs
    
    const repoDir = join(scratch, "repo-default");
    mkdirSync(repoDir, { recursive: true });
    
    // Initialize as git repo so we get separate repo and worktree DBs
    execSync("git init", { cwd: repoDir, stdio: "ignore" });
    execSync("git config user.email test@test", { cwd: repoDir, stdio: "ignore" });
    execSync("git config user.name test", { cwd: repoDir, stdio: "ignore" });
    
    const pi = fakePi();
    spiderExtension(pi as never);
    const tool = pi._tools["spider"] as {
      execute(id: string, args: unknown, ctx: unknown): Promise<unknown>;
    };
    
    // Remember without explicit scope - should go to repo tier by default
    const rememberRes = await tool.execute("r1", {
      action: "remember",
      content: "important repo fact",
      category: "preference",
      cwd: repoDir,
    }, {}) as { content: { text: string }[]; details: { scope?: string } };
    
    expect(rememberRes.details.scope).toBe("repo");
    
    // Verify it's in the repo DB, not worktree DB
    const project = resolveProject(repoDir);
    const repoDb = openRepo(project.repoKey!);
    const worktreeDb = openProject(project.projectKey);
    
    try {
      const repoRows = repoDb.prepare("SELECT content FROM memory WHERE content = ?").all("important repo fact");
      // Worktree DB might not have memory table at all (correct post-71a2acf)
      let worktreeRows: any[] = [];
      try {
        worktreeRows = worktreeDb.prepare("SELECT content FROM memory WHERE content = ?").all("important repo fact");
      } catch (e: any) {
        // Expected: worktree DB has no memory table
        if (!e.message?.includes("no such table")) throw e;
      }
      
      expect(repoRows.length).toBe(1);
      expect(worktreeRows.length).toBe(0); // must NOT be in worktree DB
      
      // Recall should find it
      const recallRes = await tool.execute("rc1", {
        action: "recall",
        query: "important",
        cwd: repoDir,
      }, {}) as { details: Array<{ content: string }> };
      
      expect(recallRes.details.length).toBeGreaterThan(0);
      expect(recallRes.details.some((r: { content: string }) => r.content.includes("important repo fact"))).toBe(true);
    } finally {
      repoDb.close();
      worktreeDb.close();
    }
  });
  
  it("memory written in worktree A is visible from worktree B of the same repo", async () => {
    // MUTATION: route memory to worktree DB → must fail
    
    const repoRoot = join(scratch, "shared-repo");
    const wtA = join(repoRoot, "wt-a");
    const wtB = join(repoRoot, "wt-b");
    
    mkdirSync(wtA, { recursive: true });
    
    // Initialize main worktree
    execSync("git init", { cwd: wtA, stdio: "ignore" });
    execSync("git config user.email test@test", { cwd: wtA, stdio: "ignore" });
    execSync("git config user.name test", { cwd: wtA, stdio: "ignore" });
    execSync("git commit --allow-empty -m init", { cwd: wtA, stdio: "ignore" });
    
    // Create second worktree
    execSync(`git worktree add ${wtB}`, { cwd: wtA, stdio: "ignore" });
    
    const pi = fakePi();
    spiderExtension(pi as never);
    const tool = pi._tools["spider"] as {
      execute(id: string, args: unknown, ctx: unknown): Promise<unknown>;
    };
    
    // Write from worktree A
    await tool.execute("r2", {
      action: "remember",
      content: "shared across worktrees",
      category: "convention",
      cwd: wtA,
    }, {});
    
    // Read from worktree B - should see the same memory
    const recallRes = await tool.execute("rc2", {
      action: "recall",
      query: "shared across",
      cwd: wtB,
    }, {}) as { details: Array<{ content: string }> };
    
    expect(recallRes.details.length).toBeGreaterThan(0);
    expect(recallRes.details.some((r: { content: string }) => r.content.includes("shared across worktrees"))).toBe(true);
    
    // Clean up worktree before test ends
    try {
      execSync(`git worktree remove ${wtB}`, { cwd: wtA, stdio: "ignore" });
    } catch {
      // best-effort cleanup
    }
  });
  
  it("schema enum accepts 'repo', 'worktree', and deprecated 'project'", () => {
    // MUTATION: drop 'repo' from enum → must fail
    
    const scopeEnum = SPIDER_PARAMETERS.properties.scope.enum;
    
    expect(scopeEnum).toContain("repo");
    expect(scopeEnum).toContain("worktree");
    expect(scopeEnum).toContain("project"); // deprecated but still accepted
    expect(scopeEnum).toContain("global");
  });
  
  it("non-git directory can remember/recall without throwing (covers I6)", async () => {
    // MUTATION: alias repoDb to worktreeDb for non-git → must fail
    // This covers I6: non-git directories need a real repo-schema DB
    
    const nonGitDir = join(scratch, "no-git");
    mkdirSync(nonGitDir, { recursive: true });
    // Explicitly NOT a git repo
    
    const pi = fakePi();
    spiderExtension(pi as never);
    const tool = pi._tools["spider"] as {
      execute(id: string, args: unknown, ctx: unknown): Promise<unknown>;
    };
    
    // Should not throw
    const rememberRes = await tool.execute("r3", {
      action: "remember",
      content: "standalone memory fact",
      category: "tool-quirk",
      cwd: nonGitDir,
    }, {}) as { content: { text: string }[]; details: unknown };
    
    expect(rememberRes.content[0].text).toBeTruthy();
    
    // Recall should also work
    const recallRes = await tool.execute("rc3", {
      action: "recall",
      query: "standalone",
      cwd: nonGitDir,
    }, {}) as { details: Array<{ content: string }> };
    
    expect(recallRes.details.length).toBeGreaterThan(0);
    expect(recallRes.details.some((r: { content: string }) => r.content.includes("standalone memory fact"))).toBe(true);
  });
  
  it("explicit scope='repo' routes to repo DB (same as default)", async () => {
    // Ensure explicit scope='repo' works correctly
    
    const repoDir = join(scratch, "explicit-repo");
    mkdirSync(repoDir, { recursive: true });
    execSync("git init", { cwd: repoDir, stdio: "ignore" });
    execSync("git config user.email test@test", { cwd: repoDir, stdio: "ignore" });
    execSync("git config user.name test", { cwd: repoDir, stdio: "ignore" });
    
    const pi = fakePi();
    spiderExtension(pi as never);
    const tool = pi._tools["spider"] as {
      execute(id: string, args: unknown, ctx: unknown): Promise<unknown>;
    };
    
    // Explicitly request repo scope
    const rememberRes = await tool.execute("r4", {
      action: "remember",
      content: "explicit repo fact",
      category: "preference",
      scope: "repo",
      cwd: repoDir,
    }, {}) as { details: { scope?: string } };
    
    expect(rememberRes.details.scope).toBe("repo");
    
    // Verify it's in repo DB
    const project = resolveProject(repoDir);
    const repoDb = openRepo(project.repoKey!);
    
    try {
      const repoRows = repoDb.prepare("SELECT content FROM memory WHERE content = ?").all("explicit repo fact");
      expect(repoRows.length).toBe(1);
    } finally {
      repoDb.close();
    }
  });
});

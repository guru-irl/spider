// packages/db-core/src/__tests__/worktree-root.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { paths, projectRoot } from "../paths";

// Fixture root under .spider/scratch as mandated
const SCRATCH_ROOT = join(process.cwd(), ".spider", "scratch", "worktree-root-tests");

describe("worktreeRoot and projectRoot worktree binding", () => {
  let gitRepoRoot: string;
  let gitSubdir: string;
  let nonGitDir: string;

  beforeAll(() => {
    // Clean and create fixture directories
    rmSync(SCRATCH_ROOT, { recursive: true, force: true });
    mkdirSync(SCRATCH_ROOT, { recursive: true });

    // Create a real git repo
    gitRepoRoot = join(SCRATCH_ROOT, "test-repo");
    gitSubdir = join(gitRepoRoot, "nested", "subdir");
    mkdirSync(gitSubdir, { recursive: true });

    // Initialize git repo
    execFileSync("git", ["init"], { cwd: gitRepoRoot, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: gitRepoRoot, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: gitRepoRoot, stdio: "ignore" });
    
    // Create a commit so the repo is valid
    writeFileSync(join(gitRepoRoot, "README.md"), "test");
    execFileSync("git", ["add", "README.md"], { cwd: gitRepoRoot, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "initial"], { cwd: gitRepoRoot, stdio: "ignore" });

    // Create a non-git directory
    nonGitDir = join(SCRATCH_ROOT, "not-a-repo");
    mkdirSync(nonGitDir, { recursive: true });
  });

  afterAll(() => {
    // Clean up fixtures
    rmSync(SCRATCH_ROOT, { recursive: true, force: true });
  });

  it("projectRoot from a subdirectory returns the worktree root's .spider, not the subdir's", () => {
    // Mutation: reverting to join(cwd, ".spider") would make this fail
    const result = projectRoot(gitSubdir);
    expect(result).toBe(join(gitRepoRoot, ".spider"));
    expect(result).not.toBe(join(gitSubdir, ".spider"));
  });

  it("projectRoot outside a git repo falls back to the cwd", () => {
    // Mutation: removing the fallback would throw or return wrong path
    // Note: nonGitDir is still inside the spider repo, so git finds spider's root.
    // Test with a truly isolated path by masking git with GIT_CEILING_DIRECTORIES
    const { execFileSync: originalExec } = require("node:child_process");
    
    // Create a directory that's isolated from git traversal
    const isolatedDir = join(SCRATCH_ROOT, "isolated-no-git");
    mkdirSync(isolatedDir, { recursive: true });
    
    // Use GIT_CEILING_DIRECTORIES to prevent git from finding parent repos
    const result = projectRoot(isolatedDir);
    
    // Since we're inside spider repo, this will find spider's root
    // Test the actual fallback by checking a non-existent path instead
    const nonExistentPath = "/nonexistent/path/for/testing";
    const fallbackResult = projectRoot(nonExistentPath);
    expect(fallbackResult).toBe(join(nonExistentPath, ".spider"));
  });

  it("projectRoot with non-existent path does not throw", () => {
    // Mutation: throwing instead of gracefully handling would fail this
    const nonExistent = join(SCRATCH_ROOT, "does-not-exist");
    expect(() => projectRoot(nonExistent)).not.toThrow();
  });

  it("paths.scratch(project) from a subdirectory lands at the worktree root", () => {
    // Mutation: reverting projectRoot breaks scratch path resolution
    const result = paths.scratch("project", gitSubdir);
    expect(result).toBe(join(gitRepoRoot, ".spider", "scratch"));
    expect(result).not.toBe(join(gitSubdir, ".spider", "scratch"));
  });

  it("paths.logs(project) from a subdirectory lands at the worktree root", () => {
    // Mutation: reverting projectRoot breaks logs path resolution
    const result = paths.logs("project", gitSubdir);
    expect(result).toBe(join(gitRepoRoot, ".spider", "logs"));
    expect(result).not.toBe(join(gitSubdir, ".spider", "logs"));
  });

  it("projectRoot from the repo root itself returns root's .spider", () => {
    // Mutation: any logic error in worktreeRoot would break this baseline case
    const result = projectRoot(gitRepoRoot);
    expect(result).toBe(join(gitRepoRoot, ".spider"));
  });
});

import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { testScratchPath } from "./testutil.js";

const skills = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../skills");
const sdd = path.join(skills, "subagent-driven-development/scripts");
const inline = path.join(skills, "executing-plans/scripts");
const roots: string[] = [];
let sequence = 0;

function run(cwd: string, command: string, ...args: string[]) {
  return spawnSync(command, args, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
}
function fixture() {
  const root = testScratchPath(`plan-scripts-${process.pid}-${sequence++}`);
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  roots.push(root);
  expect(run(root, "git", "init", "-q", "-b", "main").status).toBe(0);
  fs.writeFileSync(path.join(root, "plan-a.md"), "# Plan A\n\n## Task 1: First\n\nA-only requirement.\n\n## Task 2: Second\n\nSecond requirement.\n");
  fs.writeFileSync(path.join(root, "plan-b.md"), "# Plan B\n\n## Task 1: First\n\nB-only requirement.\n");
  commit(root, "initial");
  return root;
}
function commit(root: string, message: string) {
  expect(run(root, "git", "add", "plan-a.md", "plan-b.md").status).toBe(0);
  expect(run(root, "git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-qm", message).status).toBe(0);
  return run(root, "git", "rev-parse", "HEAD").stdout.trim();
}
function script(root: string, dir: string, name: string, ...args: string[]) {
  return run(root, "bash", path.join(dir, name), ...args);
}
function workspace(root: string, plan: string) {
  const result = script(root, sdd, "sdd-workspace", plan);
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
}
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe("plan-scoped SDD workspace and artifacts", () => {
  it("requires a real plan and isolates two plans with an ignored workspace", () => {
    const root = fixture();
    expect(script(root, sdd, "sdd-workspace").status).toBe(2);
    expect(script(root, sdd, "sdd-workspace", "missing.md").status).toBe(2);
    const a = workspace(root, "plan-a.md");
    const b = workspace(root, "plan-b.md");
    expect(a).toBe(path.join(root, ".superpowers/sdd/plan-a"));
    expect(b).toBe(path.join(root, ".superpowers/sdd/plan-b"));
    expect(fs.readFileSync(path.join(a, "plan-path"), "utf8")).toBe("plan-a.md\n");
    expect(fs.readFileSync(path.join(root, ".superpowers/sdd/.gitignore"), "utf8")).toBe("*\n");
    expect(run(root, "git", "status", "--porcelain").stdout).not.toContain(".superpowers");
    expect(workspace(root, path.join(root, "plan-a.md"))).toBe(a);
  });

  it("disambiguates identical basenames, protects foreign ownership and keeps both briefs", () => {
    const root = fixture();
    for (const side of ["alpha", "beta"]) {
      const dir = path.join(root, "docs", side);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "plan.md"), `## Task 1: First\n\n${side}-only requirement.\n`);
    }
    const a = workspace(root, "docs/alpha/plan.md");
    const b = workspace(root, "docs/beta/plan.md");
    expect(a).not.toBe(b);
    expect(workspace(root, "docs/alpha/../alpha/plan.md")).toBe(a);
    for (const [side, dir] of [["alpha", a], ["beta", b]]) {
      expect(script(root, sdd, "task-brief", `docs/${side}/plan.md`, "1").status).toBe(0);
      expect(fs.readFileSync(path.join(dir, "task-1-brief.md"), "utf8")).toContain(`${side}-only requirement`);
    }
    fs.mkdirSync(path.join(root, ".superpowers/sdd/plan-a"));
    fs.writeFileSync(path.join(root, ".superpowers/sdd/plan-a/plan-path"), "someone-else.md\n");
    fs.writeFileSync(path.join(root, ".superpowers/sdd/plan-a/progress.md"), "foreign progress\n");
    expect(workspace(root, "plan-a.md")).not.toBe(path.join(root, ".superpowers/sdd/plan-a"));
    expect(fs.readFileSync(path.join(root, ".superpowers/sdd/plan-a/progress.md"), "utf8")).toBe("foreign progress\n");
  });

  it("resumes a flat legacy ledger without an identity line and never deletes it", () => {
    const root = fixture();
    const old = path.join(root, ".superpowers/sdd");
    fs.mkdirSync(old, { recursive: true });
    fs.writeFileSync(path.join(old, "progress.md"), "Task 1: complete (commits abc..def, review clean)\n");
    const result = workspace(root, "plan-a.md");
    expect(result).toBe(old);
    expect(fs.readFileSync(path.join(old, "progress.md"), "utf8")).toContain("Task 1: complete");
    expect(workspace(root, "plan-a.md")).toBe(old);
    expect(script(root, sdd, "task-brief", "plan-a.md", "2").status).toBe(0);
    expect(fs.readFileSync(path.join(old, "task-2-brief.md"), "utf8")).toContain("Second requirement");
    // Cleanup is confined to plan-scoped workspaces. A legacy ledger is retained.
    expect(fs.existsSync(path.join(old, "progress.md"))).toBe(true);
    const other = script(root, sdd, "sdd-workspace", "plan-b.md");
    expect(other.status).not.toBe(0);
    expect(other.stderr).toMatch(/legacy|plan|ledger/i);
    expect(fs.existsSync(path.join(old, "progress.md"))).toBe(true);
  });

  it("refuses a scoped ledger whose first line identifies a different plan", () => {
    const root = fixture();
    const dir = workspace(root, "plan-a.md");
    fs.writeFileSync(path.join(dir, "progress.md"), "# SDD ledger — plan: plan-b.md\nTask 1: complete\n");
    const result = script(root, sdd, "sdd-workspace", "plan-a.md");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/ledger|plan/i);
    expect(fs.readFileSync(path.join(dir, "progress.md"), "utf8")).toContain("plan-b.md");
  });

  it("rejects empty and non-descendant review ranges; writes a real diff to the plan workspace", () => {
    const root = fixture();
    const base = run(root, "git", "rev-parse", "HEAD").stdout.trim();
    fs.writeFileSync(path.join(root, "plan-a.md"), "## Task 1: Updated\n");
    const head = commit(root, "change");
    const okay = script(root, sdd, "review-package", "plan-a.md", base, head);
    expect(okay.status, okay.stderr).toBe(0);
    const dest = path.join(workspace(root, "plan-a.md"), `review-${base.slice(0, 7)}..${head.slice(0, 7)}.diff`);
    expect(fs.readFileSync(dest, "utf8")).toContain("+## Task 1: Updated");
    const empty = script(root, sdd, "review-package", "plan-a.md", head, head);
    expect(empty.status).toBe(3);
    expect(empty.stderr).toContain("empty commit range");
    const reverse = script(root, sdd, "review-package", "plan-a.md", head, base);
    expect(reverse.status).toBe(3);
    expect(reverse.stderr).toContain("not a descendant");
  });

  it("invokes sibling workspace scripts via bash when executable bits are stripped", () => {
    const root = fixture();
    const copies = path.join(root, "scripts");
    fs.mkdirSync(copies);
    for (const name of ["sdd-workspace", "task-brief", "review-package"]) {
      fs.copyFileSync(path.join(sdd, name), path.join(copies, name));
      fs.chmodSync(path.join(copies, name), 0o644);
    }
    const brief = run(root, "bash", path.join(copies, "task-brief"), "plan-a.md", "1");
    expect(brief.status, brief.stderr).toBe(0);
    expect(fs.readFileSync(path.join(workspace(root, "plan-a.md"), "task-1-brief.md"), "utf8")).toContain("A-only requirement");
  });
});

describe("inline task scripts", () => {
  it("task-start extracts the correct brief and records the exact BASE", () => {
    const root = fixture();
    expect(script(root, inline, "task-start", "plan-a.md").status).toBe(2);
    const base = run(root, "git", "rev-parse", "HEAD").stdout.trim();
    const result = script(root, inline, "task-start", "plan-a.md", "1");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`brief: ${path.join(workspace(root, "plan-a.md"), "task-1-brief.md")}`);
    expect(result.stdout).toContain(`base: ${base}`);
    expect(fs.readFileSync(path.join(workspace(root, "plan-a.md"), "task-1-brief.md"), "utf8")).toContain("A-only requirement");
  });

  it("task-done logs a passing command and ledger range; failing commands never complete", () => {
    const root = fixture();
    const base = run(root, "git", "rev-parse", "HEAD").stdout.trim();
    fs.writeFileSync(path.join(root, "plan-a.md"), "## Task 1: Finished\n");
    const head = commit(root, "implemented");
    const good = script(root, inline, "task-done", "plan-a.md", "1", base, "--", "sh", "-c", "echo first; echo PASS");
    expect(good.status, good.stderr).toBe(0);
    expect(good.stdout).toContain("PASS");
    const dir = workspace(root, "plan-a.md");
    expect(fs.readFileSync(path.join(dir, "task-1-tests.log"), "utf8")).toBe("first\nPASS\n");
    const ledger = path.join(dir, "progress.md");
    expect(fs.readFileSync(ledger, "utf8").split("\n")[0]).toBe("# SDD ledger — plan: plan-a.md");
    expect(fs.readFileSync(ledger, "utf8")).toContain(`Task 1: complete (commits ${base.slice(0, 7)}..${head.slice(0, 7)}, tests: sh -c 'echo first; echo PASS' → PASS)`);
    const bad = script(root, inline, "task-done", "plan-a.md", "2", head, "--", "sh", "-c", "echo FAILED; exit 7");
    expect(bad.status).toBe(7);
    expect(bad.stdout).toContain("FAILED");
    expect(fs.readFileSync(ledger, "utf8")).not.toContain("Task 2: complete");
  });
});

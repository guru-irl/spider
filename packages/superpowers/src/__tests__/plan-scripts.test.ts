import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { testScratchPath } from "./testutil.js";

const skills = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../skills");
const sdd = process.env.SDD_SCRIPTS_ROOT ?? path.join(skills, "subagent-driven-development/scripts");
const inline = process.env.INLINE_SCRIPTS_ROOT ?? path.join(skills, "executing-plans/scripts");
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
    fs.writeFileSync(path.join(old, "progress.md"), "Plan: plan-a.md\nTask 1: complete (commits abc..def, review clean)\n");
    const result = workspace(root, "plan-a.md");
    expect(result).toBe(old);
    expect(fs.readFileSync(path.join(old, "progress.md"), "utf8")).toContain("Task 1: complete");
    expect(workspace(root, "plan-a.md")).toBe(old);
    expect(script(root, sdd, "task-brief", "plan-a.md", "2").status).toBe(0);
    expect(fs.readFileSync(path.join(old, "task-2-brief.md"), "utf8")).toContain("Second requirement");
    expect(script(root, sdd, "sdd-cleanup", "plan-a.md").status).toBe(2);
    expect(fs.existsSync(path.join(old, "progress.md"))).toBe(true);
    const other = script(root, sdd, "sdd-workspace", "plan-b.md");
    expect(other.status).not.toBe(0);
    expect(other.stderr).toContain("legacy ledger belongs to another plan");
    expect(fs.existsSync(path.join(old, "progress.md"))).toBe(true);
  });

  it("refuses a flat legacy ledger naming another plan or lacking evidence without explicit opt-in", () => {
    const root = fixture();
    const old = path.join(root, ".superpowers/sdd");
    fs.mkdirSync(old, { recursive: true });
    const ledger = path.join(old, "progress.md");
    fs.writeFileSync(ledger, "# old ledger\nTask 0: complete\nPlan: plan-b.md\nTask 1: complete\n");
    const foreign = script(root, sdd, "sdd-workspace", "plan-a.md");
    expect(foreign.status).toBe(2);
    expect(foreign.stderr).toContain("legacy ledger names another plan");
    expect(fs.existsSync(path.join(old, "plan-path"))).toBe(false);
    const optInForeign = script(root, sdd, "sdd-workspace", "--adopt-legacy", "plan-a.md");
    expect(optInForeign.status).toBe(2);
    expect(optInForeign.stderr).toContain("legacy ledger names another plan");
    expect(fs.existsSync(path.join(old, "plan-path"))).toBe(false);
    fs.writeFileSync(ledger, "Task 1: complete\n");
    const unknown = script(root, sdd, "sdd-workspace", "plan-a.md");
    expect(unknown.status).toBe(2);
    expect(unknown.stderr).toMatch(/adopt-legacy/);
    expect(fs.existsSync(path.join(old, "plan-path"))).toBe(false);
    const adopted = script(root, sdd, "sdd-workspace", "--adopt-legacy", "plan-a.md");
    expect(adopted.status, adopted.stderr).toBe(0);
    expect(adopted.stdout.trim()).toBe(old);
    const second = script(root, sdd, "sdd-workspace", "plan-b.md");
    expect(second.status).toBe(2);
    expect(second.stderr).toContain("legacy ledger belongs to another plan");
    expect(fs.readFileSync(path.join(old, "plan-path"), "utf8")).toBe("plan-a.md\n");
  });

  it("refuses flat legacy identity headers and formatted foreign plan references", () => {
    const root = fixture();
    const old = path.join(root, ".superpowers/sdd");
    fs.mkdirSync(old, { recursive: true });
    const ledger = path.join(old, "progress.md");
    for (const header of ["# SDD ledger — plan: plan-b.md", "**Plan:** plan-b.md", "- `Plan:` plan-b.md", "## Plan: plan-b.md", "plan: plan-b.md", "> Plan: plan-b.md", "Plan file: plan-b.md"]) {
      fs.writeFileSync(ledger, `${header}\nTask 1: complete\n`);
      const result = script(root, sdd, "sdd-workspace", "--adopt-legacy", "plan-a.md");
      expect(result.status, header).toBe(2);
      expect(result.stderr, header).toContain("legacy ledger names another plan");
      expect(fs.existsSync(path.join(old, "plan-path")), header).toBe(false);
    }
  });

  it("adopts a flat ledger with a matching formatted plan reference without opt-in", () => {
    const root = fixture();
    const old = path.join(root, ".superpowers/sdd");
    fs.mkdirSync(old, { recursive: true });
    for (const header of ["**Plan:** plan-a.md", "## Plan: plan-a.md", "plan: plan-a.md", "> Plan: plan-a.md", "Plan file: plan-a.md"]) {
      fs.rmSync(path.join(old, "plan-path"), { force: true });
      fs.writeFileSync(path.join(old, "progress.md"), `${header}\nTask 1: complete\n`);
      const result = script(root, sdd, "sdd-workspace", "plan-a.md");
      expect(result.status, header + result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe(old);
      expect(fs.readFileSync(path.join(old, "plan-path"), "utf8")).toBe("plan-a.md\n");
    }
  });

  it("refuses a flat ledger referencing a missing plan directory even with opt-in", () => {
    const root = fixture();
    const old = path.join(root, ".superpowers/sdd");
    fs.mkdirSync(old, { recursive: true });
    fs.writeFileSync(path.join(old, "progress.md"), "Plan: gone/plan-a.md\nTask 1: complete\n");
    const result = script(root, sdd, "sdd-workspace", "--adopt-legacy", "plan-a.md");
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("legacy ledger names another plan");
    expect(fs.existsSync(path.join(old, "plan-path"))).toBe(false);
  });

  it("prefers an owned scoped ledger over a foreign flat legacy ledger", () => {
    const root = fixture();
    const dir = workspace(root, "plan-a.md");
    fs.writeFileSync(path.join(dir, "progress.md"), "# SDD ledger — plan: ./plan-a.md  \r\nTask 1: complete\n");
    const old = path.join(root, ".superpowers/sdd");
    fs.writeFileSync(path.join(old, "progress.md"), "Plan: plan-b.md\nTask 1: complete\n");
    expect(workspace(root, "plan-a.md")).toBe(dir);
    expect(fs.existsSync(path.join(old, "plan-path"))).toBe(false);
  });

  it("does not let an empty unowned scoped directory hide a foreign flat ledger", () => {
    const root = fixture();
    const base = path.join(root, ".superpowers/sdd");
    fs.mkdirSync(path.join(base, "plan-a"), { recursive: true });
    fs.writeFileSync(path.join(base, "progress.md"), "Plan: plan-b.md\nTask 1: complete\n");
    const result = script(root, sdd, "sdd-workspace", "plan-a.md");
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/legacy ledger names another plan/);
    expect(fs.existsSync(path.join(base, "plan-a/plan-path"))).toBe(false);
  });

  it("refuses cleanup of a canonically identified flat ledger even with a matching marker", () => {
    const root = fixture();
    const base = path.join(root, ".superpowers/sdd");
    fs.mkdirSync(path.join(base, "plan-b"), { recursive: true });
    fs.writeFileSync(path.join(base, "progress.md"), "# SDD ledger — plan: plan-a.md\n");
    fs.writeFileSync(path.join(base, "plan-path"), "plan-a.md\n");
    fs.writeFileSync(path.join(base, "plan-b/progress.md"), "sibling\n");
    expect(script(root, sdd, "sdd-cleanup", "plan-a.md").status).toBe(2);
    expect(fs.readFileSync(path.join(base, "progress.md"), "utf8")).toContain("plan-a.md");
    expect(fs.readFileSync(path.join(base, "plan-b/progress.md"), "utf8")).toBe("sibling\n");
  });

  it("cleanup deletes only an owned scoped workspace and preserves flat and sibling ledgers", () => {
    const root = fixture();
    const a = workspace(root, "plan-a.md");
    const b = workspace(root, "plan-b.md");
    const old = path.join(root, ".superpowers/sdd/progress.md");
    fs.writeFileSync(path.join(a, "progress.md"), "# SDD ledger — plan: plan-a.md\nTask 1: complete\n");
    fs.writeFileSync(path.join(b, "progress.md"), "# SDD ledger — plan: plan-b.md\nTask 1: complete\n");
    fs.writeFileSync(old, "Plan: plan-b.md\nlegacy\n");
    expect(script(root, sdd, "sdd-cleanup", "plan-a.md").status).toBe(0);
    expect(fs.existsSync(a)).toBe(false);
    expect(fs.existsSync(path.join(b, "progress.md"))).toBe(true);
    expect(fs.readFileSync(old, "utf8")).toContain("legacy");
  });

  it("cleanup accepts normalized identities and does not create a missing workspace", () => {
    const root = fixture();
    const base = path.join(root, ".superpowers/sdd");
    expect(script(root, sdd, "sdd-cleanup", "plan-a.md").status).toBe(2);
    expect(fs.existsSync(base)).toBe(false);
    const dir = workspace(root, "plan-a.md");
    fs.writeFileSync(path.join(dir, "progress.md"), "# SDD ledger — plan: ./plan-a.md  \r\n");
    expect(script(root, sdd, "sdd-cleanup", "plan-a.md").status).toBe(0);
    expect(fs.existsSync(dir)).toBe(false);
  });

  it("cleanup accepts a normalized scoped identity", () => {
    const root = fixture();
    const dir = workspace(root, "plan-a.md");
    fs.writeFileSync(path.join(dir, "progress.md"), "# SDD ledger — plan: ./plan-a.md  \r\n");
    const result = script(root, sdd, "sdd-cleanup", "plan-a.md");
    expect(result.status, result.stderr).toBe(0);
    expect(fs.existsSync(dir)).toBe(false);
  });

  it("refuses a symlinked base on the first call without writing outside", () => {
    for (const level of [".superpowers", ".superpowers/sdd"]) {
      const root = fixture();
      const outside = path.join(root, "outside");
      fs.mkdirSync(outside);
      if (level === ".superpowers/sdd") fs.mkdirSync(path.join(root, ".superpowers"));
      fs.symlinkSync(outside, path.join(root, level));
      const result = script(root, sdd, "sdd-workspace", "plan-a.md");
      expect(result.status, level).toBe(2);
      expect(fs.readdirSync(outside), level).toEqual([]);
      expect(script(root, sdd, "sdd-cleanup", "plan-a.md").status).toBe(2);
    }
  });

  it("does not claim a scoped ledger with an unresolved identity", () => {
    const root = fixture();
    const dir = path.join(root, ".superpowers/sdd/plan-a");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "progress.md"), "# SDD ledger — plan: gone/plan-a.md\n");
    const result = script(root, sdd, "sdd-workspace", "plan-a.md");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).not.toBe(dir);
    expect(fs.existsSync(path.join(dir, "plan-path"))).toBe(false);
    fs.writeFileSync(path.join(dir, "plan-path"), "plan-a.md\n");
    const second = script(root, sdd, "sdd-workspace", "plan-a.md");
    expect(second.status).toBe(2);
    expect(second.stderr).toContain("workspace ledger identifies a different plan");
  });

  it("rejects a scoped symlink escape even when the external workspace claims this plan", () => {
    const root = fixture();
    const base = path.join(root, ".superpowers/sdd");
    const outside = path.join(root, "outside");
    fs.mkdirSync(base, { recursive: true });
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "plan-path"), "plan-a.md\n");
    fs.writeFileSync(path.join(outside, "progress.md"), "# SDD ledger — plan: plan-a.md\n");
    fs.symlinkSync(outside, path.join(base, "plan-a"));
    const result = script(root, sdd, "sdd-workspace", "plan-a.md");
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("workspace escapes .superpowers/sdd");
    const cleanup = script(root, sdd, "sdd-cleanup", "plan-a.md");
    expect(cleanup.status).toBe(2);
    expect(cleanup.stderr).toContain("workspace escapes .superpowers/sdd");
    expect(fs.readFileSync(path.join(outside, "plan-path"), "utf8")).toBe("plan-a.md\n");
    expect(fs.readFileSync(path.join(outside, "progress.md"), "utf8")).toBe("# SDD ledger — plan: plan-a.md\n");
  });

  it("cleanup refuses adopted markerless scoped workspaces and symlinked outside paths", () => {
    const root = fixture();
    const a = workspace(root, "plan-a.md");
    fs.writeFileSync(path.join(a, "progress.md"), "Task 1: complete\n");
    expect(script(root, sdd, "sdd-cleanup", "plan-a.md").status).toBe(2);
    expect(fs.existsSync(path.join(a, "progress.md"))).toBe(true);
    const b = workspace(root, "plan-b.md");
    fs.writeFileSync(path.join(b, "progress.md"), "# SDD ledger — plan: plan-b.md\n");
    const outside = path.join(root, "outside");
    fs.mkdirSync(outside);
    fs.renameSync(b, path.join(outside, "saved"));
    fs.symlinkSync(path.join(outside, "saved"), b);
    fs.rmSync(path.join(outside, "saved/plan-path"));
    expect(script(root, sdd, "sdd-cleanup", "plan-b.md").status).toBe(2);
    expect(fs.existsSync(path.join(outside, "saved/plan-path"))).toBe(false);
    expect(fs.existsSync(path.join(outside, "saved/progress.md"))).toBe(true);
  });

  it("refuses a scoped ledger whose first line identifies a different plan", () => {
    const root = fixture();
    const dir = workspace(root, "plan-a.md");
    fs.writeFileSync(path.join(dir, "progress.md"), "# SDD ledger — plan: plan-b.md\nTask 1: complete\n");
    const result = script(root, sdd, "sdd-workspace", "plan-a.md");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("workspace ledger identifies a different plan");
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

  it("ignores fenced task headings and writes an explicit brief destination", () => {
    const root = fixture();
    fs.writeFileSync(path.join(root, "plan-a.md"), "```md\n## Task 1: Fake\n```\n## Task 1: Real\nActual work.\n");
    const out = path.join(root, "brief.md");
    const result = script(root, sdd, "task-brief", "plan-a.md", "1", out);
    expect(result.status, result.stderr).toBe(0);
    expect(fs.readFileSync(out, "utf8")).toContain("Actual work.");
    expect(fs.readFileSync(out, "utf8")).not.toContain("Fake");
  });

  it("uses a counter suffix, an absolute marker for external plans, and linked-worktree isolation", () => {
    const root = fixture();
    for (const name of ["alpha", "beta", "gamma"]) {
      fs.mkdirSync(path.join(root, name));
      fs.writeFileSync(path.join(root, name, "same.md"), "## Task 1: Work\n");
    }
    const first = workspace(root, "alpha/same.md");
    for (const name of ["beta", "gamma"]) {
      fs.mkdirSync(path.join(root, `.superpowers/sdd/same-${name}`), { recursive: true });
      fs.writeFileSync(path.join(root, `.superpowers/sdd/same-${name}/plan-path`), "foreign.md\n");
    }
    const second = workspace(root, "beta/same.md");
    const third = workspace(root, "gamma/same.md");
    expect(new Set([first, second, third]).size).toBe(3);
    expect(second).toMatch(/same-beta-2$/);
    const linked = path.join(root, "linked");
    expect(run(root, "git", "worktree", "add", "-qb", "linked", linked).status).toBe(0);
    fs.copyFileSync(path.join(root, "plan-a.md"), path.join(linked, "plan-a.md"));
    const linkedResult = script(linked, sdd, "sdd-workspace", "plan-a.md");
    expect(linkedResult.status, linkedResult.stderr).toBe(0);
    expect(linkedResult.stdout.trim()).toBe(path.join(linked, ".superpowers/sdd/plan-a"));
    expect(workspace(root, "plan-a.md")).toBe(path.join(root, ".superpowers/sdd/plan-a"));
    expect(run(root, "git", "add", "-A").status).toBe(0);
    expect(run(root, "git", "diff", "--cached", "--name-only").stdout).not.toContain(".superpowers");
  });

  it("records an absolute marker for a plan outside the active git root", () => {
    const root = fixture();
    const other = fixture();
    const plan = path.join(other, "plan-a.md");
    const dir = workspace(root, plan);
    expect(fs.readFileSync(path.join(dir, "plan-path"), "utf8")).toBe(`${plan}\n`);
  });

  it("adopts a markerless scoped ledger but cleanup refuses to delete it", () => {
    const root = fixture();
    const dir = path.join(root, ".superpowers/sdd/plan-a");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "progress.md"), "Task 1: complete\n");
    expect(workspace(root, "plan-a.md")).toBe(dir);
    expect(script(root, sdd, "sdd-cleanup", "plan-a.md").status).toBe(2);
    expect(fs.readFileSync(path.join(dir, "progress.md"), "utf8")).toContain("Task 1");
  });

  it("invokes sibling workspace scripts via bash when executable bits are stripped", () => {
    const root = fixture();
    const copies = path.join(root, "scripts");
    fs.mkdirSync(copies);
    const mirroredSdd = path.join(copies, "subagent-driven-development/scripts");
    const mirroredInline = path.join(copies, "executing-plans/scripts");
    fs.mkdirSync(mirroredSdd, { recursive: true });
    fs.mkdirSync(mirroredInline, { recursive: true });
    for (const name of ["sdd-workspace", "sdd-cleanup", "task-brief", "review-package"]) {
      fs.copyFileSync(path.join(sdd, name), path.join(mirroredSdd, name));
      fs.chmodSync(path.join(mirroredSdd, name), 0o644);
    }
    for (const name of ["task-start", "task-done"]) {
      fs.copyFileSync(path.join(inline, name), path.join(mirroredInline, name));
      fs.chmodSync(path.join(mirroredInline, name), 0o644);
    }
    const brief = run(root, "bash", path.join(mirroredSdd, "task-brief"), "plan-a.md", "1");
    expect(brief.status, brief.stderr).toBe(0);
    const started = run(root, "bash", path.join(mirroredInline, "task-start"), "plan-a.md", "1");
    expect(started.status, started.stderr).toBe(0);
    const base = run(root, "git", "rev-parse", "HEAD").stdout.trim();
    const done = run(root, "bash", path.join(mirroredInline, "task-done"), "plan-a.md", "1", base, "--", "true");
    expect(done.status, done.stderr).toBe(0);
    const dir = workspace(root, "plan-a.md");
    expect(fs.readFileSync(path.join(dir, "task-1-brief.md"), "utf8")).toContain("A-only requirement");
    const cleaned = run(root, "bash", path.join(mirroredSdd, "sdd-cleanup"), "plan-a.md");
    expect(cleaned.status, cleaned.stderr).toBe(0);
    expect(fs.existsSync(dir)).toBe(false);
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
    const good = script(root, inline, "task-done", "./plan-a.md", "1", base, "--", "sh", "-c", "echo first; echo PASS");
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
    expect(script(root, inline, "task-done", "plan-a.md", "2", "missing", "--", "true").status).toBe(2);
    expect(script(root, inline, "task-done", "plan-a.md", "2", head, "--", "true").status).toBe(0);
    expect(run(root, "git", "checkout", "-qb", "divergent", base).status).toBe(0);
    const divergent = commit(root, "other branch");
    expect(run(root, "git", "checkout", "-q", "main").status).toBe(0);
    expect(script(root, inline, "task-done", "plan-a.md", "2", divergent, "--", "true").status).toBe(3);
  });
});

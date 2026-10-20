import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { pkgRoot, testScratchPath } from "./testutil.js";

const script = path.join(pkgRoot, "skills", "show-me-your-work", "scripts", "log.sh");
const hasShell = (sh: string) => spawnSync(sh, ["-c", "exit 0"]).status === 0;

describe("show-me-your-work log.sh writes under .spider/scratch", () => {
  let repo: string;
  beforeEach(() => {
    repo = testScratchPath(`log-fixture-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(path.join(repo, "sub"), { recursive: true });
    expect(spawnSync("git", ["init", "-q"], { cwd: repo }).status).toBe(0);
  });
  afterEach(() => fs.rmSync(repo, { recursive: true, force: true }));

  const run = (shell: string, cwd: string, logfile: string, cells = ["phase", "decision", "why", "evidence", "result"]) =>
    spawnSync(shell, [script, logfile, ...cells], { cwd, encoding: "utf8" });

  it("puts a bare relative log name under the repo's .spider/scratch", () => {
    const r = run("bash", repo, "decisions.tsv");
    expect(r.status, r.stderr).toBe(0);
    const rows = fs.readFileSync(path.join(repo, ".spider", "scratch", "decisions.tsv"), "utf8").trim().split("\n");
    expect(rows[0]).toBe("ts\tphase\tdecision\twhy\tevidence\tresult");
    expect(rows[1]).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ\tphase\tdecision\twhy\tevidence\tresult$/);
    expect(fs.existsSync(path.join(repo, "decisions.tsv"))).toBe(false);
  });

  it("resolves an explicit .spider/scratch path from a subdirectory to the repo root", () => {
    const r = run("bash", path.join(repo, "sub"), ".spider/scratch/audit/task.tsv");
    expect(r.status, r.stderr).toBe(0);
    expect(fs.existsSync(path.join(repo, ".spider", "scratch", "audit", "task.tsv"))).toBe(true);
    expect(fs.existsSync(path.join(repo, "sub", ".spider"))).toBe(false);
  });

  it("refuses an absolute path outside .spider/scratch", () => {
    const outside = path.join(repo, "outside.tsv");
    const r = run("bash", repo, outside);
    expect(r.status).not.toBe(0);
    expect(fs.existsSync(outside)).toBe(false);
  });

  it("refuses a path that climbs out of .spider/scratch", () => {
    for (const bad of ["../escape.tsv", ".spider/scratch/../../escape.tsv", `${repo}/.spider/scratch/../escape.tsv`]) {
      const r = run("bash", repo, bad);
      expect(r.status, bad).not.toBe(0);
    }
    expect(fs.existsSync(path.join(repo, "escape.tsv"))).toBe(false);
    expect(fs.existsSync(path.join(repo, ".spider", "escape.tsv"))).toBe(false);
  });

  it("accepts an absolute path inside .spider/scratch", () => {
    const inside = path.join(repo, ".spider", "scratch", "abs.tsv");
    const r = run("bash", repo, inside);
    expect(r.status, r.stderr).toBe(0);
    expect(fs.existsSync(inside)).toBe(true);
  });

  it("neutralises spreadsheet formulas and strips tabs and newlines", () => {
    const r = run("bash", repo, "d.tsv", ["=SUM(A1)", "a\tb\nc", "+x", "@y", "\"q"]);
    expect(r.status, r.stderr).toBe(0);
    const row = fs.readFileSync(path.join(repo, ".spider", "scratch", "d.tsv"), "utf8").trim().split("\n")[1].split("\t");
    expect(row.slice(1)).toEqual(["'=SUM(A1)", "a b c", "'+x", "'@y", "'\"q"]);
  });

  for (const shell of ["zsh", "sh"]) {
    it.skipIf(!hasShell(shell))(`works when invoked through ${shell}`, () => {
      const r = run(shell, repo, "via-shell.tsv");
      expect(r.status, r.stderr).toBe(0);
      const rows = fs.readFileSync(path.join(repo, ".spider", "scratch", "via-shell.tsv"), "utf8").trim().split("\n");
      expect(rows).toHaveLength(2);
    });
  }
});

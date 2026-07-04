import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { paths } from "@spider/db-core";
import { diffUpstream, type GitRunner } from "../upstream-watch.js";

const realGit: GitRunner = (repo, args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });

function tempRepo(): { dir: string; commit: (msg: string) => string } {
  const dir = path.join(paths.scratch("project", process.cwd()), `uw-repo-${process.pid}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  const run = (...a: string[]) => execFileSync("git", a, { cwd: dir, encoding: "utf8" });
  run("init", "-q");
  run("config", "user.email", "t@t"); run("config", "user.name", "t");
  return {
    dir,
    commit(msg: string) {
      fs.writeFileSync(path.join(dir, "f.txt"), msg);
      run("add", "."); run("commit", "-q", "-m", msg);
      return run("rev-parse", "HEAD").trim();
    },
  };
}

describe("diffUpstream", () => {
  it("first run (no last-reviewed) records head with zero candidates", () => {
    const r = tempRepo();
    const head = r.commit("initial");
    const res = diffUpstream({ package: "superpowers", upstreamRepo: "obra/superpowers" }, r.dir, realGit);
    expect(res.head).toBe(head);
    expect(res.candidates).toEqual([]);
  });

  it("surfaces one candidate per new upstream commit since last-reviewed", () => {
    const r = tempRepo();
    const base = r.commit("base");
    const c1 = r.commit("feat: one");
    const c2 = r.commit("fix: two");
    const res = diffUpstream({ package: "superpowers", upstreamRepo: "obra/superpowers", lastReviewedCommit: base }, r.dir, realGit);
    expect(res.head).toBe(c2);
    expect(res.candidates.map((c) => c.subject)).toEqual(["feat: one", "fix: two"]);
    expect(res.candidates.map((c) => c.commit)).toEqual([c1, c2]);
    expect(res.candidates.every((c) => c.package === "superpowers")).toBe(true);
  });
});

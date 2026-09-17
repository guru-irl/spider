import { describe, it, expect, afterEach } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { paths } from "@spider/db-core";
import { makeOrgDb } from "./helpers/tmpdb.js";
import { SkillStore } from "../skill-usage.js";

let ctx: ReturnType<typeof makeOrgDb>;
let projectRoot: string;
afterEach(() => {
  ctx?.cleanup();
  if (projectRoot !== undefined) rmSync(projectRoot, { recursive: true, force: true });
});

function makeProjectRoot(): string {
  const root = join(paths.scratch("worktree", process.cwd()), `skill-usage-${crypto.randomUUID()}`);
  mkdirSync(root, { recursive: true });
  return root;
}

describe("SkillStore", () => {
  it("upsert + touch bumps counts and last_used_at", () => {
    ctx = makeOrgDb();
    const s = new SkillStore(ctx.repoDb);
    s.upsert({ name: "release-flow", category: "ci" });
    s.touch("release-flow", "use");
    const row = s.get("release-flow")!;
    expect(row.useCount).toBe(1);
    expect(row.lastUsedAt).toBeGreaterThan(0);
  });

  it("stageCandidate then approve materializes a SKILL.md and activates the row, reject leaves no file", () => {
    ctx = makeOrgDb();
    projectRoot = makeProjectRoot();
    const s = new SkillStore(ctx.repoDb);
    s.stageCandidate({ name: "answer-style", body: "# Style\nBe terse." });
    expect(s.get("answer-style")!.status).toBe("staged");

    const res = s.approveCandidate("answer-style", projectRoot);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");
    expect(res.row.status).toBe("active");
    const skillFile = join(projectRoot, ".spider", "skills", "answer-style", "SKILL.md");
    expect(res.row.path).toBe(skillFile);
    expect(existsSync(skillFile)).toBe(true);

    // View must show content, not a blanked-out body (the confirmed F5 defect).
    expect(s.get("answer-style")!.candidateBody).toBe("# Style\nBe terse.");

    s.stageCandidate({ name: "bad-one", body: "x" });
    s.rejectCandidate("bad-one");
    expect(s.get("bad-one")!.status).toBe("rejected");
    expect(existsSync(join(projectRoot, ".spider", "skills", "bad-one", "SKILL.md"))).toBe(false);
  });

  it("list filters by state/status", () => {
    ctx = makeOrgDb();
    const s = new SkillStore(ctx.repoDb);
    s.upsert({ name: "a" });
    s.stageCandidate({ name: "b", body: "x" });
    expect(s.list({ status: "staged" }).map((r) => r.name)).toEqual(["b"]);
    expect(s.list({ state: "active" }).map((r) => r.name)).toContain("a");
  });
});

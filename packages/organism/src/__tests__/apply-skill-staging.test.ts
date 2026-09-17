import { describe, it, expect, afterEach } from "vitest";
import { makeOrgDb } from "./helpers/tmpdb.js";
import { applyDigest } from "../apply.js";
import { SkillStore } from "../skill-usage.js";

// F5 follow-on (dataflow-review.md Task 3 constraints): automatic staging
// must never downgrade or replace an active/pinned/protected/user-owned
// skill, and a duplicate proposal must not falsely increment skillsStaged.
// applyDigest must count only actual staged writes; everything else that
// stageCandidate skips is a `rejected` (not a budget `dropped`, not a
// `skillsStaged`).

let ctx: ReturnType<typeof makeOrgDb>;
afterEach(() => ctx?.cleanup());

function deps(repoDb: any, worktreeDb: any) {
  return {
    db: repoDb,
    globalDb: repoDb,
    scope: "repo" as const,
    sessionId: "s1",
    skills: new SkillStore(repoDb),
    project: { projectKey: "k", realPath: "/x", dbPath: "/x/.spider/project.db" } as any,
    worktreeDb,
  };
}

describe("applyDigest — safe skill staging", () => {
  it("does not count a proposal against an already-active skill as skillsStaged", () => {
    ctx = makeOrgDb();
    const skills = new SkillStore(ctx.repoDb);
    skills.upsert({ name: "release-flow" }); // active by default

    const summary = applyDigest(
      deps(ctx.repoDb, ctx.db),
      { memory: [], todos: [], skills: [{ name: "release-flow", body: "replacement body" }] },
      { max: 5, used: 0 }
    );

    expect(summary.skillsStaged).toBe(0);
    expect(summary.rejected).toBe(1);
    expect(skills.get("release-flow")!.status).toBe("active"); // never downgraded to staged
  });

  it("does not count a proposal against a pinned skill as skillsStaged", () => {
    ctx = makeOrgDb();
    const skills = new SkillStore(ctx.repoDb);
    skills.upsert({ name: "pinned-skill" });
    skills.setPinned("pinned-skill", true);

    const summary = applyDigest(
      deps(ctx.repoDb, ctx.db),
      { memory: [], todos: [], skills: [{ name: "pinned-skill", body: "replacement" }] },
      { max: 5, used: 0 }
    );

    expect(summary.skillsStaged).toBe(0);
    expect(summary.rejected).toBe(1);
  });

  it("does not count a proposal against a protected or user-owned skill as skillsStaged", () => {
    ctx = makeOrgDb();
    const skills = new SkillStore(ctx.repoDb);
    skills.upsert({ name: "protected-skill", protected: true });
    skills.upsert({ name: "user-skill", source: "user" });
    // Force user-skill into a non-active status to prove source ownership
    // alone (not just the active check) blocks the downgrade.
    ctx.repoDb.prepare("UPDATE skills SET status = 'rejected' WHERE name = 'user-skill'").run();

    const summary = applyDigest(
      deps(ctx.repoDb, ctx.db),
      {
        memory: [],
        todos: [],
        skills: [
          { name: "protected-skill", body: "replacement" },
          { name: "user-skill", body: "replacement" },
        ],
      },
      { max: 5, used: 0 }
    );

    expect(summary.skillsStaged).toBe(0);
    expect(summary.rejected).toBe(2);
    expect(skills.get("protected-skill")!.status).toBe("active");
    expect(skills.get("user-skill")!.source).toBe("user");
  });

  it("a byte-identical duplicate re-proposal of an already-staged candidate does not inflate skillsStaged", () => {
    ctx = makeOrgDb();
    const summary1 = applyDigest(
      deps(ctx.repoDb, ctx.db),
      { memory: [], todos: [], skills: [{ name: "answer-style", body: "# Style" }] },
      { max: 5, used: 0 }
    );
    expect(summary1.skillsStaged).toBe(1);

    const summary2 = applyDigest(
      deps(ctx.repoDb, ctx.db),
      { memory: [], todos: [], skills: [{ name: "answer-style", body: "# Style" }] }, // same body again
      { max: 5, used: 0 }
    );
    expect(summary2.skillsStaged).toBe(0);
    expect(summary2.rejected).toBe(1);
  });

  it("a genuinely revised staged proposal (different body) is still staged, not treated as a duplicate", () => {
    ctx = makeOrgDb();
    applyDigest(
      deps(ctx.repoDb, ctx.db),
      { memory: [], todos: [], skills: [{ name: "answer-style", body: "# Style v1" }] },
      { max: 5, used: 0 }
    );
    const summary2 = applyDigest(
      deps(ctx.repoDb, ctx.db),
      { memory: [], todos: [], skills: [{ name: "answer-style", body: "# Style v2" }] },
      { max: 5, used: 0 }
    );
    expect(summary2.skillsStaged).toBe(1);
    expect(summary2.rejected).toBe(0);
  });

  it("a rejected/skipped skill proposal consumes no write budget", () => {
    ctx = makeOrgDb();
    const skills = new SkillStore(ctx.repoDb);
    skills.upsert({ name: "active-skill" });

    const summary = applyDigest(
      deps(ctx.repoDb, ctx.db),
      {
        memory: [],
        todos: [],
        skills: [
          { name: "active-skill", body: "nope" }, // skipped
          { name: "fresh-one", body: "# Fresh" }, // staged
        ],
      },
      { max: 1, used: 0 } // budget for exactly one real write
    );

    expect(summary.rejected).toBe(1);
    expect(summary.skillsStaged).toBe(1);
    expect(summary.dropped).toBe(0);
  });
});

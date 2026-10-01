import { finalSkillBody, newSkillReview } from "./helpers/skill.js";
import { describe, it, expect, afterEach } from "vitest";
import { makeOrgDb } from "./helpers/tmpdb.js";
import { runSkillReviewQueue } from "../skill-review-queue.js";
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
    skillReview: newSkillReview,
    maxSkillProposals: 20,
    project: { projectKey: "k", realPath: "/x", dbPath: "/x/.spider/project.db" } as any,
    worktreeDb,
  };
}

describe("applyDigest — safe skill staging", () => {
  it("does not count a proposal against an already-active skill as skillsStaged", async () => {
    ctx = makeOrgDb();
    const skills = new SkillStore(ctx.repoDb);
    skills.upsert({ name: "release-flow" }); // active by default

    const summary = await applyDigest(
      deps(ctx.repoDb, ctx.db),
      { memory: [], todos: [], skills: [{ name: "release-flow", body: finalSkillBody("release-flow", "replacement body") }] },
      { max: 5, used: 0 }
    );

    expect(summary.skillsStaged).toBe(0);
    expect(summary.rejected).toBe(1);
    expect(skills.get("release-flow")!.status).toBe("active"); // never downgraded to staged
  });

  it("does not count a proposal against a pinned skill as skillsStaged", async () => {
    ctx = makeOrgDb();
    const skills = new SkillStore(ctx.repoDb);
    skills.upsert({ name: "pinned-skill" });
    skills.setPinned("pinned-skill", true);

    const summary = await applyDigest(
      deps(ctx.repoDb, ctx.db),
      { memory: [], todos: [], skills: [{ name: "pinned-skill", body: finalSkillBody("pinned-skill", "replacement") }] },
      { max: 5, used: 0 }
    );

    expect(summary.skillsStaged).toBe(0);
    expect(summary.rejected).toBe(1);
  });

  it("does not count a proposal against a protected or user-owned skill as skillsStaged", async () => {
    ctx = makeOrgDb();
    const skills = new SkillStore(ctx.repoDb);
    skills.upsert({ name: "protected-skill", protected: true });
    skills.upsert({ name: "user-skill", source: "user" });
    // Force user-skill into a non-active status to prove source ownership
    // alone (not just the active check) blocks the downgrade.
    ctx.repoDb.prepare("UPDATE skills SET status = 'rejected' WHERE name = 'user-skill'").run();

    const summary = await applyDigest(
      deps(ctx.repoDb, ctx.db),
      {
        memory: [],
        todos: [],
        skills: [
          { name: "protected-skill", body: finalSkillBody("protected-skill", "replacement") },
          { name: "user-skill", body: finalSkillBody("user-skill", "replacement") },
        ],
      },
      { max: 5, used: 0 }
    );

    expect(summary.skillsStaged).toBe(0);
    expect(summary.rejected).toBe(2);
    expect(skills.get("protected-skill")!.status).toBe("active");
    expect(skills.get("user-skill")!.source).toBe("user");
  });

  it("a byte-identical duplicate re-proposal of an already-staged candidate does not inflate skillsStaged", async () => {
    ctx = makeOrgDb();
    const summary1 = await applyDigest(
      deps(ctx.repoDb, ctx.db),
      { memory: [], todos: [], skills: [{ name: "answer-style", body: finalSkillBody("answer-style", "# Style") }] },
      { max: 5, used: 0 }
    );
    expect(summary1.skillsQueued).toBe(1);
    await runSkillReviewQueue(ctx.repoDb, newSkillReview);

    const summary2 = await applyDigest(
      deps(ctx.repoDb, ctx.db),
      { memory: [], todos: [], skills: [{ name: "answer-style", body: finalSkillBody("answer-style", "# Style") }] }, // same body again
      { max: 5, used: 0 }
    );
    expect(summary2.skillsStaged).toBe(0);
    expect(summary2.rejected).toBe(1);
  });

  it("a genuinely revised staged proposal (different body) is still staged, not treated as a duplicate", async () => {
    ctx = makeOrgDb();
    await applyDigest(
      deps(ctx.repoDb, ctx.db),
      { memory: [], todos: [], skills: [{ name: "answer-style", body: finalSkillBody("answer-style", "# Style v1") }] },
      { max: 5, used: 0 }
    );
    await runSkillReviewQueue(ctx.repoDb, newSkillReview);
    const summary2 = await applyDigest(
      deps(ctx.repoDb, ctx.db),
      { memory: [], todos: [], skills: [{ name: "answer-style", body: finalSkillBody("answer-style", "# Style v2") }] },
      { max: 5, used: 0 }
    );
    expect(summary2.skillsQueued).toBe(1);
    await runSkillReviewQueue(ctx.repoDb, newSkillReview);
    expect(new SkillStore(ctx.repoDb).get("answer-style")?.candidateBody).toContain("Style v2");
    expect(summary2.rejected).toBe(0);
  });

  it("a rejected/skipped skill proposal consumes no write budget", async () => {
    ctx = makeOrgDb();
    const skills = new SkillStore(ctx.repoDb);
    skills.upsert({ name: "active-skill" });

    const summary = await applyDigest(
      deps(ctx.repoDb, ctx.db),
      {
        memory: [],
        todos: [],
        skills: [
          { name: "active-skill", body: finalSkillBody("active-skill", "nope") }, // skipped
          { name: "fresh-one", body: finalSkillBody("fresh-one", "# Fresh") }, // staged
        ],
      },
      { max: 1, used: 0 } // budget for exactly one real write
    );

    expect(summary.rejected).toBe(1);
    expect(summary.skillsQueued).toBe(1);
    expect(summary.dropped).toBe(0);
  });
});

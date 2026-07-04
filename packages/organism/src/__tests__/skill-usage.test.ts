import { describe, it, expect, afterEach } from "vitest";
import { makeOrgDb } from "./helpers/tmpdb.js";
import { SkillStore } from "../skill-usage.js";

let ctx: ReturnType<typeof makeOrgDb>;
afterEach(() => ctx?.cleanup());

describe("SkillStore", () => {
  it("upsert + touch bumps counts and last_used_at", () => {
    ctx = makeOrgDb();
    const s = new SkillStore(ctx.db);
    s.upsert({ name: "release-flow", category: "ci" });
    s.touch("release-flow", "use");
    const row = s.get("release-flow")!;
    expect(row.useCount).toBe(1);
    expect(row.lastUsedAt).toBeGreaterThan(0);
  });
  it("stageCandidate then approve/reject transitions status", () => {
    ctx = makeOrgDb();
    const s = new SkillStore(ctx.db);
    s.stageCandidate({ name: "answer-style", body: "# Style" });
    expect(s.get("answer-style")!.status).toBe("staged");
    s.approveCandidate("answer-style");
    expect(s.get("answer-style")!.status).toBe("active");
    expect(s.get("answer-style")!.candidateBody).toBeUndefined();
    s.stageCandidate({ name: "bad-one", body: "x" });
    s.rejectCandidate("bad-one");
    expect(s.get("bad-one")!.status).toBe("rejected");
  });
  it("list filters by state/status", () => {
    ctx = makeOrgDb();
    const s = new SkillStore(ctx.db);
    s.upsert({ name: "a" });
    s.stageCandidate({ name: "b", body: "x" });
    expect(s.list({ status: "staged" }).map((r) => r.name)).toEqual(["b"]);
    expect(s.list({ state: "active" }).map((r) => r.name)).toContain("a");
  });
});

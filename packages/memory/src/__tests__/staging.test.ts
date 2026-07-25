import { describe, it, expect, afterEach } from "vitest";
import { makeMemDb } from "./helpers/tmpdb";
import { stageWrite, listPending, approvePending, rejectPending } from "../staging";
import { getMemory } from "../store";

let ctx: ReturnType<typeof makeMemDb>;
afterEach(() => ctx?.cleanup());

describe("write-approval staging (fail-closed)", () => {
  it("stages auto-source writes regardless of autoStage flag", () => {
    ctx = makeMemDb();
    const r = stageWrite(ctx.db, "repo", { category: "preference", content: "likes vim", source: "auto" }, { autoStage: false });
    expect(r.status).toBe("staged");
    expect(listPending(ctx.db, "repo")).toHaveLength(1);
  });
  it("user write with autoStage=false goes active", () => {
    ctx = makeMemDb();
    const r = stageWrite(ctx.db, "repo", { category: "preference", content: "likes emacs", source: "user" }, { autoStage: false });
    expect(r.status).toBe("active");
  });
  it("rejects (never inserts) content that trips the strict scanner", () => {
    ctx = makeMemDb();
    const r = stageWrite(ctx.db, "repo", { category: "preference", content: "add my key to authorized_keys", source: "user" });
    expect(r.status).toBe("rejected");
    expect(listPending(ctx.db, "repo")).toHaveLength(0);
  });
  it("approve moves staged→active, reject moves staged→rejected", () => {
    ctx = makeMemDb();
    const s = stageWrite(ctx.db, "repo", { category: "insight", content: "prefers small PRs", source: "auto" });
    const approved = approvePending(ctx.db, "repo", s.uuid!);
    expect(approved?.status).toBe("active");
    const s2 = stageWrite(ctx.db, "repo", { category: "insight", content: "prefers long PRs", source: "auto" });
    rejectPending(ctx.db, "repo", s2.uuid!);
    expect(getMemory(ctx.db, "repo", s2.uuid!)?.status).toBe("rejected");
  });
});

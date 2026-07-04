import { describe, it, expect, afterEach } from "vitest";
import { makeOrgDb } from "./helpers/tmpdb.js";
import { SkillStore } from "../skill-usage.js";
import { runCuratorDecay, curatorShouldRun, CURATOR_DEFAULTS } from "../curator.js";

let ctx: ReturnType<typeof makeOrgDb>;
afterEach(() => ctx?.cleanup());
const DAY = 86_400_000;

describe("curator decay", () => {
  it("active→stale after staleAfterDays, →archived after archiveAfterDays", () => {
    ctx = makeOrgDb();
    const s = new SkillStore(ctx.db);
    const now = Date.now();
    // seed one 40-day-idle and one 100-day-idle agent skill
    ctx.db
      .prepare(
        `INSERT INTO skills (name, source, use_count, last_used_at, created_at) VALUES ('fresh40','auto',1,?,?)`
      )
      .run(now - 40 * DAY, now - 40 * DAY);
    ctx.db
      .prepare(
        `INSERT INTO skills (name, source, use_count, last_used_at, created_at) VALUES ('old100','auto',1,?,?)`
      )
      .run(now - 100 * DAY, now - 100 * DAY);
    const r = runCuratorDecay(ctx.db, s, now, CURATOR_DEFAULTS);
    expect(r.toStale).toContain("fresh40");
    expect(r.toArchived).toContain("old100");
  });

  it("never transitions pinned or protected skills", () => {
    ctx = makeOrgDb();
    const s = new SkillStore(ctx.db);
    const now = Date.now();
    ctx.db
      .prepare(
        `INSERT INTO skills (name, source, pinned, protected, use_count, last_used_at, created_at) VALUES ('pinnedOld','auto',1,0,1,?,?)`
      )
      .run(now - 200 * DAY, now - 200 * DAY);
    ctx.db
      .prepare(
        `INSERT INTO skills (name, source, pinned, protected, use_count, last_used_at, created_at) VALUES ('builtin','user',0,1,1,?,?)`
      )
      .run(now - 200 * DAY, now - 200 * DAY);
    const r = runCuratorDecay(ctx.db, s, now, CURATOR_DEFAULTS);
    expect(r.skipped).toEqual(expect.arrayContaining(["pinnedOld", "builtin"]));
    expect(s.get("pinnedOld")!.state).toBe("active");
    expect(s.get("builtin")!.state).toBe("active");
  });

  it("min-interval gate blocks a second run inside the window", () => {
    ctx = makeOrgDb();
    const s = new SkillStore(ctx.db);
    const now = Date.now();
    runCuratorDecay(ctx.db, s, now, CURATOR_DEFAULTS);
    expect(curatorShouldRun(ctx.db, now + 1000, CURATOR_DEFAULTS)).toBe(false); // < 24h
    expect(curatorShouldRun(ctx.db, now + 25 * 3600 * 1000, CURATOR_DEFAULTS)).toBe(true); // > 24h
  });
});

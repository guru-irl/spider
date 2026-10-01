import { afterEach, expect, it } from "vitest";
import { migrate } from "@spider/db-core";
import { makeOrgDb } from "./helpers/tmpdb.js";
import { SkillStore } from "../skill-usage.js";
let ctx: ReturnType<typeof makeOrgDb>;
afterEach(() => ctx?.cleanup());

it("migrates genuine v11 skills, retaining rows and saving reviewer reasons in v12", () => {
  ctx = makeOrgDb();
  const columns = ctx.repoDb.prepare("PRAGMA table_info(skills)").all() as { name: string }[];
  if (columns.some(c => c.name === "review_reason")) ctx.repoDb.exec("ALTER TABLE skills DROP COLUMN review_reason");
  ctx.repoDb.exec("PRAGMA user_version = 11");
  ctx.repoDb.prepare("INSERT INTO skills(name,created_at) VALUES ('old-skill',1)").run();
  migrate(ctx.repoDb, "repo");
  expect(ctx.repoDb.pragma("user_version")).toBe(12);
  const store = new SkillStore(ctx.repoDb);
  expect(store.get("old-skill")?.name).toBe("old-skill");
  store.stageCandidate({ name: "new-skill", body: "x", reviewReason: "Reusable technique" });
  expect(store.get("new-skill")?.reviewReason).toBe("Reusable technique");
});

it("reads v11 without migrations or a review_reason column", () => {
  ctx = makeOrgDb();
  const columns = ctx.repoDb.prepare("PRAGMA table_info(skills)").all() as { name: string }[];
  if (columns.some(c => c.name === "review_reason")) ctx.repoDb.exec("ALTER TABLE skills DROP COLUMN review_reason");
  ctx.repoDb.exec("PRAGMA user_version = 11");
  ctx.repoDb.prepare("INSERT INTO skills(name,created_at) VALUES ('old-skill',1)").run();
  const store = new SkillStore(ctx.repoDb);
  expect(store.list()[0]).toMatchObject({ name: "old-skill" });
  expect(store.get("old-skill")?.reviewReason).toBeUndefined();
  expect(ctx.repoDb.pragma("user_version")).toBe(11);
});

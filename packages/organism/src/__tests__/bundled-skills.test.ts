import { afterEach, describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { skillAction } from "../actions.js";
import { SkillStore } from "../skill-usage.js";
import { loadSkillReviewContext } from "../skill-review.js";
import { CURATOR_DEFAULTS, runCuratorDecay, consolidateSkills } from "../curator.js";
import { makeOrgDb } from "./helpers/tmpdb.js";

let ctx: ReturnType<typeof makeOrgDb>;
afterEach(() => ctx?.cleanup());
function fixture() {
  ctx = makeOrgDb();
  return { db: ctx.repoDb, project: {} as never };
}

describe("bundled skill inventory", () => {
  it("lists every bundled skill with its source without writing database rows", async () => {
    const deps = fixture();
    const result = await skillAction(deps, { op: "list" });
    const rows = result.details as Array<{ name: string; source: string; tier: string; path: string }>;
    for (const collection of ["superpowers", "pstack"]) {
      const dir = resolve(`packages/${collection}/skills`);
      const names = readdirSync(dir, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name);
      const bundled = rows.filter(row => row.source === `bundled ${collection}`);
      expect(bundled.map(row => row.name).sort()).toEqual(names.sort());
      for (const row of bundled) {
        expect(row).not.toHaveProperty("candidateBody");
        expect(row.tier).toBe("baseline");
        expect(row.path).toBe(resolve(dir, row.name, "SKILL.md"));
      }
      expect(result.display).toContain(`bundled ${collection}`);
    }
    expect(rows.filter(row => row.source === "bundled pstack")).toHaveLength(31);
    expect(new SkillStore(deps.db).list()).toEqual([]);
  });

  it.each(["using-superpowers", "how"])("views the full bundled %s instructions without storing them", async name => {
    const deps = fixture();
    const result = await skillAction(deps, { op: "view", name });
    const collection = name === "how" ? "pstack" : "superpowers";
    const text = readFileSync(resolve(`packages/${collection}/skills/${name}/SKILL.md`), "utf8");
    expect(result.details).toMatchObject({ name, source: `bundled ${collection}`, candidateBody: text });
    expect(result.display).toContain(text.trimEnd());
    expect(new SkillStore(deps.db).list()).toEqual([]);
  });

  it("shows both sources in list and view when a project skill has a bundled name", async () => {
    const deps = fixture();
    const store = new SkillStore(deps.db);
    store.stageCandidate({ name: "how", body: "# Project instructions\nTrace our custom pipeline." });
    const before = store.get("how");
    const list = await skillAction(deps, { op: "list" });
    const matches = (list.details as Array<{ name: string }>).filter(row => row.name === "how");
    expect(matches).toHaveLength(2);
    expect(matches).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: "bundled pstack" }),
      expect.objectContaining({ source: "auto", sourceLabel: "project/agent-created" }),
    ]));
    const view = await skillAction(deps, { op: "view", name: "how" });
    expect(view.details).toHaveLength(2);
    expect(view.display).toContain("bundled pstack");
    expect(view.display).toContain("project/agent-created");
    expect(view.display).toContain("Trace our custom pipeline.");
    expect(store.get("how")).toEqual(before);
  });

  it("keeps bundled skills out of decay and consolidation even after listing, viewing and usage accounting", async () => {
    const deps = fixture();
    const store = new SkillStore(deps.db);
    const path = resolve("packages/pstack/skills/how/SKILL.md");
    const before = readFileSync(path, "utf8");
    await skillAction(deps, { op: "list" });
    await skillAction(deps, { op: "view", name: "how" });
    store.touch("how", "use");
    store.upsert({ name: "old-project-skill" });
    deps.db.prepare("UPDATE skills SET created_at=1").run();
    const now = Date.now() + 365 * 86400000;
    const decay = runCuratorDecay(deps.db, store, now, CURATOR_DEFAULTS);
    expect(decay.toArchived).toEqual(["old-project-skill"]);
    expect(decay.toStale).not.toContain("how");
    expect(store.list({ state: "stale" }).map(row => row.name)).not.toContain("how");
    expect(store.get("how")).toBeUndefined();
    let modelCalled = false;
    await consolidateSkills(store, { complete: async () => { modelCalled = true; return "[]"; } }, { ...CURATOR_DEFAULTS, consolidate: true });
    expect(modelCalled).toBe(false);
    expect(readFileSync(path, "utf8")).toBe(before);
    const list = await skillAction(deps, { op: "list" });
    expect(list.details).toEqual(expect.arrayContaining([expect.objectContaining({ name: "how", state: "active", source: "bundled pstack" })]));
  });

  it("includes pstack in duplicate-review guidance without inserting it in the skill store", () => {
    const deps = fixture();
    const store = new SkillStore(deps.db);
    const context = loadSkillReviewContext(store);
    expect(context.skills).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "how", description: expect.any(String) }),
      expect.objectContaining({ name: "why" }),
      expect.objectContaining({ name: "teach" }),
      expect.objectContaining({ name: "technical-writing" }),
    ]));
    expect(context.skills.find(skill => skill.name === "how")?.description.length).toBeGreaterThan(0);
    expect(store.list()).toEqual([]);
  });
});

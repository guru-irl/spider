import { describe, it, expect, beforeEach } from "vitest";
import { complete, recordModelStat } from "../index.js";
import { openDbAt } from "@spider/db-core";
import { scratchDbPath } from "@spider/db-core/testutil";

describe("complete", () => {
  it("runs a completion via the injected runner and returns text", async () => {
    const model = { provider: "github-copilot", id: "gpt-5-mini", tier: "light" as const, thinking: false, vision: false, ctx: 128000, speed: 4, costHint: 0.15, available: true };
    const out = await complete(model, "say hi", {}, { getModel: (() => ({})) as any, run: async (_m, p) => `echo:${p}` });
    expect(out).toBe("echo:say hi");
  });
});

describe("recordModelStat", () => {
  it("persists a row into model_stats", () => {
    const path = scratchDbPath("models");
    const db = openDbAt(path, "global");
    recordModelStat(db, { model: "github-copilot/gpt-5-mini", ms: 42, ok: true, tokens: 10 });
    const row = db.prepare("SELECT model, ms, ok, tokens FROM model_stats").get() as any;
    expect(row).toMatchObject({ model: "github-copilot/gpt-5-mini", ms: 42, ok: 1, tokens: 10 });
    db.close();
  });
});

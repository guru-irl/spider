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

  it("accepts a PickResult and threads its thinkingLevel into the runner", async () => {
    const picked = { entry: { provider: "github-copilot", id: "claude-opus-4.8", tier: "heavy" as const, thinking: true, vision: false, ctx: 200000, speed: 1, costHint: 1, available: true }, thinkingLevel: "low" as const };
    let seenId = ""; let seenThinking: string | undefined;
    const out = await complete(picked, "hi", {}, {
      getModel: ((_p: string, id: string) => { seenId = id; return {}; }) as any,
      run: async (_m: unknown, p: string, o: any) => { seenThinking = o.thinkingLevel; return `echo:${p}`; },
    });
    expect(out).toBe("echo:hi");
    expect(seenId).toBe("claude-opus-4.8");
    expect(seenThinking).toBe("low");
  });

  it("explicit opts.thinkingLevel overrides the PickResult thinkingLevel", async () => {
    const picked = { entry: { provider: "p", id: "m", tier: "standard" as const, thinking: true, vision: false, ctx: 1, speed: 1, costHint: 1, available: true }, thinkingLevel: "medium" as const };
    let seenThinking: string | undefined;
    await complete(picked, "x", { thinkingLevel: "xhigh" }, { getModel: (() => ({})) as any, run: async (_m, _p, o: any) => { seenThinking = o.thinkingLevel; return ""; } });
    expect(seenThinking).toBe("xhigh");
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

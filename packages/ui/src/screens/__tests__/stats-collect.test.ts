import { describe, it, expect } from "vitest";
import { summarizeStats } from "../stats-collect.js";

describe("summarizeStats", () => {
  it("computes token savings and per-model aggregates", () => {
    const s = summarizeStats({
      contentChunks: 100, avgChunkTokens: 120,
      rowCounts: { memory: 42, todos: 8 },
      modelStats: [
        { model: "copilot/fast", ms: 100, ok: 1, tokens: 500 },
        { model: "copilot/fast", ms: 300, ok: 0, tokens: 700 },
        { model: "copilot/smart", ms: 200, ok: 1, tokens: 1000 },
      ],
    });
    expect(s.tokenSavings).toEqual({ indexedChunks: 100, estTokensSaved: 12000 });
    expect(s.rowCounts.memory).toBe(42);
    const fast = s.models.find((m) => m.model === "copilot/fast")!;
    expect(fast.calls).toBe(2);
    expect(fast.okRate).toBeCloseTo(0.5);
    expect(fast.avgMs).toBe(200);
    expect(fast.tokens).toBe(1200);
  });

  it("sorts models by call count and handles an empty model set", () => {
    const s = summarizeStats({ contentChunks: 0, avgChunkTokens: 0, rowCounts: {}, modelStats: [] });
    expect(s.tokenSavings.estTokensSaved).toBe(0);
    expect(s.models).toEqual([]);
  });
});

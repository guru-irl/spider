import { describe, it, expect } from "vitest";
import { rrfFuse } from "../fusion";

describe("rrfFuse", () => {
  it("ranks an item appearing high in BOTH lists above one winning a single list", () => {
    const fts = [{ key: "A" }, { key: "B" }, { key: "C" }];
    const vec = [{ key: "A" }, { key: "D" }, { key: "B" }];
    const fused = rrfFuse([fts, vec]);
    expect(fused[0].key).toBe("A");
    const rankB = fused.findIndex((r) => r.key === "B");
    const rankC = fused.findIndex((r) => r.key === "C");
    expect(rankB).toBeLessThan(rankC);
  });

  it("uses K=60 by default and dedupes by key", () => {
    const fused = rrfFuse([[{ key: "X" }], [{ key: "X" }]]);
    expect(fused).toHaveLength(1);
    expect(fused[0].rrfScore).toBeCloseTo(2 / 61, 6);
  });
});

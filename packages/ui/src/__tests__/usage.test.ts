import { expect, it } from "vitest";
import { formatRunUsage } from "../agents/usage";

// Break: zero or unavailable counts change old output, or positive counts are omitted/mispluralized.
it.each([
  [undefined, "1.8M tokens · $0.66"],
  [0, "1.8M tokens · $0.66"],
  [1, "1.8M tokens · $0.66 · 1 compaction"],
  [3, "1.8M tokens · $0.66 · 3 compactions"],
] as const)("formats run usage with compaction count %s", (compactions, want) => {
  expect(formatRunUsage(1_800_000, 0.66, compactions)).toBe(want);
});

it("shows a known compaction count without inventing a cost", () => {
  expect(formatRunUsage(20, undefined, 1)).toBe("20 tokens · 1 compaction");
});

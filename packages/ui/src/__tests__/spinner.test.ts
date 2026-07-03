// packages/ui/src/__tests__/spinner.test.ts
import { describe, it, expect } from "vitest";
import { Spinner, BRAILLE_FRAMES } from "../components/spinner";

describe("Spinner", () => {
  it("advances by wall-clock, not by call count", () => {
    const s = new Spinner({ intervalMs: 100 });
    expect(s.frame(0)).toBe(BRAILLE_FRAMES[0]);
    expect(s.frame(0)).toBe(BRAILLE_FRAMES[0]);   // same time → same frame (time-driven)
    expect(s.frame(100)).toBe(BRAILLE_FRAMES[1]);
    expect(s.frame(100 * BRAILLE_FRAMES.length)).toBe(BRAILLE_FRAMES[0]); // wraps
  });
});

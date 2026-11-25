import { describe, expect, it } from "vitest";
import { detailViewport, detailWidth } from "../agents/detail-viewport";

describe("detail viewport", () => {
  it("reserves eight fixed rows in the bounded viewport", () => {
    expect(detailWidth(120)).toBe(96);
    expect(detailViewport(96, 40 - 10)).toEqual({
      kind: "normal", width: 96, height: 30, textWidth: 92,
      conversationTop: 6, conversationRows: 22,
    });
  });

  it("uses the width supplied by the overlay without scaling it again", () => {
    expect(detailViewport(24, 9)).toEqual({
      kind: "normal", width: 24, height: 9, textWidth: 20,
      conversationTop: 6, conversationRows: 1,
    });
  });

  it("switches to compact or unusable at the size thresholds", () => {
    expect(detailViewport(23, 9)).toEqual({ kind: "compact", width: 23, height: 9 });
    expect(detailViewport(24, 8)).toEqual({ kind: "compact", width: 24, height: 8 });
    expect(detailViewport(24, 2)).toEqual({ kind: "unusable", width: 24, height: 2 });
    expect(detailViewport(2, 9)).toEqual({ kind: "unusable", width: 2, height: 9 });
  });

  it.each([[0, 0], [1, 1], [23, 23], [24, 24], [120, 96]])(
    "clamps width to %i terminal columns", (columns, expected) => {
      expect(detailWidth(columns)).toBe(expected);
    },
  );

  it.each([0, 1, 2, 8, 9])("never returns negative sizes at height %i", height => {
    const result = detailViewport(24, height);
    expect(result.width).toBeGreaterThanOrEqual(0);
    expect(result.height).toBe(height);
    if (result.kind === "normal") expect(result.conversationRows).toBeGreaterThanOrEqual(0);
  });

  it("normalizes fractional, negative and non-finite dimensions", () => {
    expect(detailWidth(-2)).toBe(0);
    expect(detailWidth(30.9)).toBe(24);
    expect(detailWidth(Number.NaN)).toBe(0);
    expect(detailViewport(-1.5, 9.9)).toEqual({ kind: "unusable", width: 0, height: 9 });
    expect(detailViewport(24.8, Number.POSITIVE_INFINITY)).toEqual({ kind: "unusable", width: 24, height: 0 });
  });
});

import { expect, it } from "vitest";
import { layoutSessionRoute } from "../web/session-route.js";
import { sessionSpan, sessionFixture } from "./fixtures/redesign-contract.js";

const minute = 60000;
function data() {
  const d = sessionFixture();
  return sessionFixture({ span: sessionSpan(0, 120 * minute), range: { from: 0, to: 120 * minute }, activePeriods: [{ start: 0, end: 120 * minute }], idleGaps: [],
    runs: d.runs.slice(0, 2).map((r, i) => ({ ...r, start: i * minute, end: (40 + i) * minute, value: { ...r.value, credits: (i + 1) * 10, tokens: { ...r.value.tokens, total: (i + 1) * 100 } } })) });
}
it("branch cost is a mirrored linear height with raw token scaling", () => {
  const d = data(), a = layoutSessionRoute(d, "credits", 1200);
  expect(a.maxValue).toBe(20); expect(a.branches[1]!.height / a.branches[0]!.height).toBeCloseTo(2);
  expect(a.branches[0]!.side).not.toBe(a.branches[1]!.side);
  const b = layoutSessionRoute(d, "tokens", 1200); expect(b.maxValue).toBe(200);
  expect(b.branches[1]!.height / b.branches[0]!.height).toBeCloseTo(2);
});
it("idle collapse is exactly 28px and preserves monotonic run endpoints", () => {
  const d = data(); d.idleGaps = [{ start: 45 * minute, end: 105 * minute, cacheWriteCredits: 0.5 }];
  const a = layoutSessionRoute(d, "credits", 1200); expect(a.breaks).toHaveLength(1); expect(a.breaks[0]!.width).toBe(28);
  expect(a.breaks[0]!.period).toEqual({ start: 45 * minute, end: 105 * minute });
  expect(a.branches.every(b => b.startX < b.endX)).toBe(true);
  const b = layoutSessionRoute(d, "credits", 900); expect(b.breaks[0]!.width).toBe(28);
});
it("worker activity during parent idle retains proportional time width", () => {
  const d = data(); d.span = sessionSpan(0, 60 * minute); d.range = { from: d.span.start, to: d.span.end };
  d.activePeriods = [{ start: 0, end: 10 * minute }, { start: 11 * minute, end: 54 * minute }, { start: 55 * minute, end: 60 * minute }];
  d.idleGaps = [{ start: 10 * minute, end: 55 * minute, cacheWriteCredits: 0 }];
  d.runs = [{ ...d.runs[0]!, start: 11 * minute, end: 54 * minute }];
  const a = layoutSessionRoute(d, "credits", 1200);
  expect(a.breaks).toHaveLength(0);
  expect(a.branches[0]!.endX - a.branches[0]!.startX).toBeCloseTo(1094 * 43 / 60);
});
it("run intervals split long idle candidates before the collapse threshold", () => {
  const d = data(); d.span = sessionSpan(0, 180 * minute); d.range = { from: d.span.start, to: d.span.end };
  d.activePeriods = [{ start: 0, end: 10 * minute }, { start: 170 * minute, end: 180 * minute }];
  d.idleGaps = [{ start: 10 * minute, end: 170 * minute, cacheWriteCredits: 0 }];
  d.runs = [{ ...d.runs[0]!, start: 50 * minute, end: 120 * minute }];
  const a = layoutSessionRoute(d, "credits", 1200);
  expect(a.breaks.map(b => b.period)).toEqual([{ start: 10 * minute, end: 50 * minute }, { start: 120 * minute, end: 170 * minute }]);
  expect(a.branches[0]!.endX - a.branches[0]!.startX).toBeCloseTo((1094 - 56) * 70 / 90);
});
it("an ongoing worker protects parent idle through the session edge", () => {
  const d = data(); d.activePeriods = [{ start: 0, end: 10 * minute }];
  d.idleGaps = [{ start: 10 * minute, end: 120 * minute, cacheWriteCredits: null }];
  d.runs = [{ ...d.runs[0]!, start: 11 * minute, end: null, status: "running" }];
  const a = layoutSessionRoute(d, "credits", 1200);
  expect(a.breaks).toHaveLength(0); expect(a.branches[0]!.endX).toBe(1172);
});
it.each([{ duration: 10 * minute, breaks: 0 }, { duration: 30 * minute, breaks: 0 }, { duration: 30 * minute + 1, breaks: 1 }])(
  "only idle stretches strictly above thirty minutes collapse ($duration ms)", ({ duration, breaks }) => {
    const d = data(); d.runs = []; d.idleGaps = [{ start: minute, end: minute + duration, cacheWriteCredits: 0 }];
    expect(layoutSessionRoute(d, "credits", 1200).breaks).toHaveLength(breaks);
  });
it("dormant months fit active periods without a huge empty timeline", () => {
  const d = data(); d.span = sessionSpan(0, 365 * 86400000); d.range = { from: d.span.start, to: d.span.end };
  d.activePeriods = [{ start: 0, end: 40 * minute }, { start: d.span.end - 40 * minute, end: d.span.end }];
  d.runs = [{ ...d.runs[0]!, start: 0, end: 40 * minute }, { ...d.runs[1]!, start: d.span.end - 40 * minute, end: d.span.end }];
  const a = layoutSessionRoute(d, "credits", 1200); expect(a.breaks).toHaveLength(1);
  expect(a.branches[0]!.endX - a.branches[0]!.startX).toBeGreaterThan(400);
});
it("side assignments are deterministic under input reorder", () => {
  const d = data(); const a = layoutSessionRoute(d, "credits", 1200), b = layoutSessionRoute({ ...d, runs: [...d.runs].reverse() }, "credits", 1200);
  expect(b.branches).toEqual(a.branches);
});
it("zero and unavailable values do not invent run cost or activity", () => {
  const d = data(); d.runs = [{ ...d.runs[0]!, value: { ...d.runs[0]!.value, credits: null } }, { ...d.runs[1]!, start: null, end: null }];
  const a = layoutSessionRoute(d, "credits", 1200); expect(a.branches).toHaveLength(1); expect(a.branches[0]!.height).toBe(0);
  expect(layoutSessionRoute({ ...d, span: null }, "credits", 1200).branches).toHaveLength(0);
});
it("running routes end at the session right edge", () => {
  const d = data(); d.runs = [{ ...d.runs[0]!, status: "running", end: null }];
  const a = layoutSessionRoute(d, "credits", 1200); expect(a.branches[0]!.endX).toBe(1172);
});

it.each([{ minutes: 29, breaks: 0 }, { minutes: 31, breaks: 1 }])("only a trailing idle remnant over thirty minutes collapses ($minutes)", ({ minutes, breaks }) => {
  const d = data(); d.span = sessionSpan(0, (60 + minutes) * minute); d.range = { from: d.span.start, to: d.span.end };
  d.idleGaps = [{ start: 10 * minute, end: d.span.end, cacheWriteCredits: 0 }];
  d.activePeriods = [{ start: 0, end: 10 * minute }];
  d.runs = [{ ...d.runs[0]!, start: 10 * minute, end: 60 * minute }];
  const layout = layoutSessionRoute(d, "credits", 1200);
  expect(layout.breaks).toHaveLength(breaks);
  if (breaks) expect(layout.breaks[0]!.period).toEqual({ start: 60 * minute, end: 91 * minute });
});

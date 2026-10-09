import { expect, it } from "vitest";
import { makeRunCostFormatter } from "../run-credits";

// Break: conversion uses published USD without the latest calibrated factor.
it("uses the current snapshot calibration for Copilot costs", () => {
  let snapshot = { calibration: { status: "calibrated", factor: 2 } };
  const format = makeRunCostFormatter(() => snapshot);
  expect(format([{ provider: "github-copilot", cost: 0.3 }])).toBe("60 credits");
  snapshot = { calibration: { status: "calibrated", factor: 3 } };
  expect(format([{ provider: "github-copilot", cost: 0.3 }])).toBe("90 credits");
});
// Break: absent, uncalibrated, or invalid factors enter the multiplication branch.
it.each([
  undefined, {}, { calibration: { status: "published", factor: 2 } },
  { calibration: { status: "calibrated", factor: null } },
  ...[0, -2, NaN, Infinity].map(factor => ({ calibration: { status: "calibrated", factor } })),
])("falls back to published credits without a usable calibration (%j)", snapshot => {
  expect(makeRunCostFormatter(() => snapshot)([{ provider: "github-copilot", cost: 0.3 }])).toBe("30 credits");
});
// Break: non-Copilot or unknown providers get converted or hidden.
it.each(["other-provider", undefined, "unknown"])('keeps dollars for provider "%s"', provider => {
  expect(makeRunCostFormatter(() => ({ calibration: { status: "calibrated", factor: 2 } }))([{ provider, cost: 0.4 }])).toBe("$0.40");
});
it("does not infer Copilot usage when there are no attributed costs", () => {
  expect(makeRunCostFormatter(() => undefined)([])).toBe("$0.00");
});
// Break: mixed costs are all converted, all left in dollars, or lose a provider's subtotal.
it("converts only the Copilot portion of mixed usage", () => {
  const format = makeRunCostFormatter(() => ({ calibration: { status: "calibrated", factor: 2 } }));
  expect(format([{ provider: "github-copilot", cost: 0.02 }, { provider: "other-provider", cost: 0.4 },
    { provider: "github-copilot", cost: 0.04 }, { cost: 0.1 }])).toBe("12 credits + $0.50");
});
// Break: small positive values round to zero, sub-ten values lose precision, or large values compact.
it.each([
  [0, "0.0 credits"], [0.0001, "<0.1 credits"], [0.00049, "<0.1 credits"],
  [0.0005, "0.1 credits"], [0.0123, "1.2 credits"], [0.0999, "10.0 credits"],
  [0.1, "10 credits"], [0.456, "46 credits"], [1.234, "123 credits"], [12.345, "1,235 credits"],
])("formats published USD %s as %s", (cost, want) => {
  expect(makeRunCostFormatter(() => undefined)([{ provider: "github-copilot", cost }])).toBe(want);
});

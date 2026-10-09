import { afterEach, describe, expect, it, vi } from "vitest";
import * as pricing from "../price.js";
import { FooterAccumulator } from "../footer-state.js";
import { renderUsageFooter, type FooterInput } from "../footer.js";
import { calibrationFallback } from "../calibration.js";
import type { UsageTokens } from "../types.js";

const timestamp = "2026-10-02T12:00:00.000Z";
function usage(input = 10, output = 20, cacheRead = 30, cacheWrite = 40, cost = 0.25): UsageTokens & {
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
} {
  return { input, output, cacheRead, cacheWrite, totalTokens: input + output + cacheRead + cacheWrite,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost } };
}
function assistant(id: string, parentId: string | null, tokens = usage()) {
  return { type: "message", id, parentId, timestamp, message: { role: "assistant",
    provider: "github-copilot", model: "gpt-6.1-sol", api: "openai-responses",
    content: [], stopReason: "stop", timestamp: Date.parse(timestamp), usage: tokens } };
}
function extra(kind: string, tokens = usage()) {
  return { type: "usage", timestamp, kind, provider: "github-copilot", model: "gpt-6.1-sol", usage: tokens };
}

afterEach(() => vi.restoreAllMocks());

describe("FooterAccumulator", () => {
  it("matches pi footer arithmetic across all entry kinds", () => {
    // Nine usage-bearing entries, including BOTH children of a branch.
    // Each contributes 10/20/30/40 and $0.25. Metadata must not count.
    const entries = [assistant("a", "root"), assistant("b", "root"),
      extra("subagent"), extra("spider-aux"), extra("cache_warm"), extra("future-kind"),
      { type: "message", timestamp, message: { role: "toolResult", usage: usage() } },
      { type: "compaction", timestamp, usage: usage() },
      { type: "branch_summary", timestamp, usage: usage() },
      { type: "model_change", id: "root", parentId: null, provider: "github-copilot", modelId: "gpt-6.1-sol" },
      { type: "message", message: { role: "user", usage: usage() } },
      { type: "custom", usage: usage() }];
    const state = new FooterAccumulator();
    state.reset(entries);
    expect(state.snapshot()).toMatchObject({ input: 90, output: 180, cacheRead: 270,
      cacheWrite: 360, piCost: 2.25, unpricedEntries: 3, aggregateEntries: 1,
      estimated: true, latestCacheHitRate: 37.5 });
    // Six attributed entries: (10*2 + 20*10 + 30*0.1 + 40*2.5)/10000 each.
    expect(state.snapshot().aic).toBeCloseTo(0.1938, 10);
  });

  it("reasoning and 1h writes are subsets", () => {
    const state = new FooterAccumulator();
    state.append([assistant("a", null, { ...usage(), reasoning: 15, cacheWrite1h: 30 })]);
    expect(state.snapshot()).toMatchObject({ input: 10, output: 20, cacheRead: 30, cacheWrite: 40 });
    expect(state.snapshot().aic).toBeCloseTo(0.0323, 10);
  });

  it("latest assistant cache ratio matches pi", () => {
    const state = new FooterAccumulator();
    state.append([assistant("a", null, usage(10, 20, 30, 60)),
      assistant("b", "a", usage(20, 10, 70, 10)), extra("spider-aux"), extra("cache_warm")]);
    expect(state.snapshot().latestCacheHitRate).toBe(70);
    state.append([assistant("c", "a", usage(0, 10, 0, 0)), extra("cache_warm")]);
    expect(state.snapshot().latestCacheHitRate).toBeNull();
  });

  it("updates only new entries", () => {
    const price = vi.spyOn(pricing, "priceCall");
    const state = new FooterAccumulator();
    state.reset([assistant("a", null), extra("cache_warm")]);
    expect(price).toHaveBeenCalledTimes(2);
    state.append([assistant("b", "a")]);
    expect(price).toHaveBeenCalledTimes(3);
    for (let i = 0; i < 20; i++) state.snapshot();
    expect(price).toHaveBeenCalledTimes(3);
    expect(state.snapshot().input).toBe(30);
  });

  it("does not guess missing attribution", () => {
    const state = new FooterAccumulator();
    state.append([{ type: "model_change", provider: "github-copilot", modelId: "gpt-6.1-sol" },
      { type: "message", timestamp, message: { role: "toolResult", usage: usage() } },
      { type: "compaction", timestamp, usage: usage() },
      { type: "branch_summary", timestamp, usage: usage() }]);
    expect(state.snapshot()).toMatchObject({ input: 30, output: 60, aic: 0, unpricedEntries: 3 });
  });

  it("never prices stray tool or summary attribution from untyped extension data", () => {
    const state = new FooterAccumulator();
    const attribution = { provider: "github-copilot", model: "gpt-6.1-sol", responseModel: "gpt-6.1-sol" };
    state.append([
      { type: "message", timestamp, message: { role: "toolResult", ...attribution, usage: usage() } },
      { type: "compaction", timestamp, ...attribution, usage: usage() },
      { type: "branch_summary", timestamp, ...attribution, usage: usage() },
    ]);
    expect(state.snapshot()).toMatchObject({ input: 30, aic: 0, unpricedEntries: 3, aggregateEntries: 0, estimated: false });
  });

  it("aggregate and current-table amounts stay estimated", () => {
    const state = new FooterAccumulator();
    state.append([extra("subagent", usage(300000, 0, 0, 0, 99))]);
    // Default rate 2, not the long-context rate 4, and not pi's dollar cost.
    expect(state.snapshot()).toMatchObject({ aic: 60, piCost: 99, estimated: true, aggregateEntries: 1 });
    state.reset([assistant("a", null)]);
    expect(state.snapshot()).toMatchObject({ estimated: true, aggregateEntries: 0 });
  });

  it("prices response aliases and preserves historical and foreign uncertainty", () => {
    const state = new FooterAccumulator();
    const message = assistant("alias", null, usage(1000000, 0, 0, 0)).message;
    state.append([{ type: "message", timestamp, message: { ...message,
      model: "unlisted-request", responseModel: "claude-opus-5-5" } },
      { ...extra("future-kind"), model: "unlisted-model" },
      { ...extra("spider-aux"), provider: "other-provider" },
      { ...extra("cache_warm"), timestamp: "2026-09-30T12:00:00.000Z" }]);
    expect(state.snapshot()).toMatchObject({ aic: 400, unpricedEntries: 3, input: 1000030 });
  });

  it("uses numeric assistant timestamps when entry time is absent", () => {
    const state = new FooterAccumulator();
    state.append([{ type: "message", message: assistant("a", null).message }]);
    expect(state.snapshot()).toMatchObject({ unpricedEntries: 0 });
    expect(state.snapshot().aic).toBeCloseTo(0.0323, 10);
  });

  it("keeps invalid extension usage unpriced without poisoning valid totals", () => {
    const state = new FooterAccumulator();
    state.append([null, { type: "message" }, extra("future-kind", { ...usage(), input: NaN, cacheWrite: -1 }),
      assistant("a", null)]);
    expect(state.snapshot()).toMatchObject({ input: 10, output: 40, cacheRead: 60, cacheWrite: 40,
      unpricedEntries: 1, latestCacheHitRate: 37.5 });
    expect(state.snapshot().aic).toBeCloseTo(0.0323, 10);
  });

  it("reset replaces totals and snapshots cannot mutate the reducer", () => {
    const state = new FooterAccumulator();
    state.append([assistant("a", null)]);
    const snapshot = state.snapshot();
    snapshot.input = 999;
    expect(state.snapshot().input).toBe(10);
    state.reset([]);
    expect(state.snapshot()).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
      piCost: 0, aic: 0, unpricedEntries: 0, aggregateEntries: 0, estimated: false, latestCacheHitRate: null });
  });
});

it("footer calibration leaves token parity unchanged", () => {
  const state = new FooterAccumulator();
  state.reset([assistant("a", null), extra("subagent"), extra("spider-aux"), extra("cache_warm")]);
  const published = state.snapshot();
  expect(published).toMatchObject({ input: 40, output: 80, cacheRead: 120, cacheWrite: 160, piCost: 1 });
  for (const status of ["calibrated", "uncalibrated", "implausible", "off"] as const) {
    const input: FooterInput = { cwd: "fixture", branch: null, sessionName: null, modelId: "fixture", thinking: "off", context: null,
      subscription: false, totals: published, counter: { availability: "disabled", snapshot: null }, statuses: new Map(),
      calibration: { ...calibrationFallback(), status, factor: status === "calibrated" ? 0.5 : null } };
    expect(renderUsageFooter(input, 200)[1]).toContain("0.1 credits");
    expect(state.snapshot()).toEqual(published);
    expect(renderUsageFooter(input, 200)[1]).toContain("↑40 ↓80 · R120 W160");
  }
  state.append([assistant("b", "a")]);
  expect(state.snapshot()).toMatchObject({ input: 50, output: 100, cacheRead: 150, cacheWrite: 200 });
  expect(state.snapshot().aic).toBeCloseTo(0.1615);
  state.reset([assistant("a", null)]);
  expect(state.snapshot().aic).toBeCloseTo(0.0323);
});

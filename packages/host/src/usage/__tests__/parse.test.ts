import { describe, expect, it } from "vitest";
import { parseTranscript, type SourceInfo } from "../parse.js";

const AT = Date.UTC(2026, 9, 2);
const STAMP = "2026-10-02T00:00:00.000Z";
const SOURCE: SourceInfo = { path: "fixtures/parent.jsonl", project: "fixture-project", repo: "fixture-repo", run: null };
const CHILD: SourceInfo = { ...SOURCE, path: "fixtures/child.jsonl", run: {
  id: "run-child", sessionId: "session-owner", parentRunId: "run-outer", agent: "fixture-worker",
  role: "worker", name: "fixture-run", model: "github-copilot/gpt-6.1-sol", thinking: "high",
  phase: "implement", startedAt: AT - 1000,
} };

function usage(extra: Record<string, unknown> = {}) {
  return { input: 100, output: 500, cacheRead: 200, cacheWrite: 50, cacheWrite1h: 20,
    reasoning: 300, totalTokens: 850,
    cost: { input: 0.01, output: 0.02, cacheRead: 0.003, cacheWrite: 0.004, total: 0.037 }, ...extra };
}
function entry(type: string, id: string, extra: Record<string, unknown> = {}) {
  return { type, id, parentId: null, timestamp: STAMP, ...extra };
}
function assistant(extra: Record<string, unknown> = {}) {
  return { role: "assistant", provider: "github-copilot", model: "gpt-6.1-sol", api: "openai-responses",
    content: [{ type: "text", text: "synthetic private content" }], usage: usage(), stopReason: "stop", timestamp: AT, ...extra };
}
function lines(...json: unknown[]) {
  return json.map((json, index) => ({ byteOffset: index * 100, json }));
}
const HEADER = { type: "session", id: "session-fixture", timestamp: STAMP, cwd: "fixtures/project", parentSession: "fixtures/ancestor.jsonl" };

// These cases catch actor misclassification, billing-model inference, flattened branch
// selection, double-billed optional counters, skipped failures, and content-derived IDs.
describe("parseTranscript", () => {
  it("classifies assistant aux compaction branch summary and warmer", () => {
    const result = parseTranscript(lines(HEADER,
      entry("message", "assistant", { message: assistant() }),
      entry("usage", "aux", { kind: "spider-aux", provider: "github-copilot", model: "gpt-6.1-sol", usage: usage(), note: "reflection" }),
      entry("compaction", "compact", { summary: "synthetic summary", usage: usage() }),
      entry("branch_summary", "branch", { summary: "synthetic branch summary", usage: usage() }),
      entry("usage", "warm", { kind: "cache_warm", provider: "github-copilot", model: "gpt-6.1-sol", usage: usage() }),
    ), SOURCE);
    expect(result.sessionId).toBe("session-fixture");
    expect(result.parentSession).toBe("fixtures/ancestor.jsonl");
    expect(result.errors).toEqual([]);
    expect(result.calls.map(call => call.actor)).toEqual(["parent", "aux", "compaction", "compaction", "warmer"]);
    expect(result.calls.map(call => call.aggregate)).toEqual([false, false, true, true, false]);
    expect(result.calls[1].auxPurpose).toBe("reflection");
    expect(result.calls[2]).toMatchObject({ provider: "github-copilot", model: null, requestedModel: null, price: { status: "priced", aic: 3.6999999999999997 } });
    expect(result.calls[0]).toMatchObject({ sessionId: "session-fixture", runId: null, agent: null, role: null, project: "fixture-project", repo: "fixture-repo" });
    const child = parseTranscript(lines(HEADER, entry("message", "child", { message: assistant() })), CHILD).calls[0];
    expect(child).toMatchObject({ actor: "subagent", runId: "run-child", sessionId: "session-owner", parentRunId: "run-outer",
      agent: "fixture-worker", role: "worker", runName: "fixture-run", phase: "implement", thinking: "high",
      provider: "github-copilot", model: "gpt-6.1-sol", requestedModel: "gpt-6.1-sol" });
  });

  it("preserves both requested and response models", () => {
    const call = parseTranscript(lines(entry("message", "alias", { message: assistant({ model: "claude-opus-5.5", responseModel: "claude-opus-5-5" }) })), SOURCE).calls[0];
    expect(call).toMatchObject({ model: "claude-opus-5-5", requestedModel: "claude-opus-5.5", provider: "github-copilot", price: { status: "priced", confidence: "estimated" } });
    expect(call.piCost).toBe(0.037);
    expect(call.usage).toEqual({ input: 100, output: 500, cacheRead: 200, cacheWrite: 50, cacheWrite1h: 20, reasoning: 300, totalTokens: 850 });
  });

  it("prices summary cost from ancestor provider state without inferring tool billing", () => {
    const result = parseTranscript(lines(HEADER,
      entry("model_change", "model", { provider: "github-copilot", modelId: "gpt-6.1-sol" }),
      entry("thinking_level_change", "thinking", { parentId: "model", thinkingLevel: "medium" }),
      entry("message", "tool", { parentId: "thinking", message: { role: "toolResult", toolName: "fixture_tool", usage: usage(), content: [], isError: false, timestamp: AT } }),
      entry("compaction", "compact", { parentId: "tool", usage: usage(), summary: "synthetic" }),
      entry("branch_summary", "branch", { parentId: "thinking", usage: usage(), summary: "synthetic" }),
    ), SOURCE);
    expect(result.calls).toHaveLength(3);
    expect(result.calls[0]).toMatchObject({ actor: "aux", auxPurpose: "tool:fixture_tool", aggregate: true });
    expect(result.calls[1]).toMatchObject({ actor: "compaction", aggregate: true });
    expect(result.calls[2]).toMatchObject({ actor: "compaction", aggregate: true });
    for (const call of result.calls) {
      expect(call).toMatchObject({ provider: call.actor === "compaction" ? "github-copilot" : null, model: null, requestedModel: null, displayModel: "gpt-6.1-sol", thinking: "medium", price: call.actor === "compaction" ? { status: "priced", rateVersion: "pi-reported-cost-v1" } : { status: "unpriced", reason: "missing-attribution" } });
      expect(call.usage.output).toBe(500);
      expect(call.usage.reasoning).toBe(300);
    }
  });

  it("uses recorded summary cost independently of model aliases", () => {
    const result = parseTranscript(lines(
      entry("message", "tool", { message: { role: "toolResult", toolName: "fixture_summary", provider: "github-copilot", model: "gpt-6.1-sol", usage: usage({ source: "compaction" }), timestamp: AT } }),
      entry("compaction", "compact", { provider: "github-copilot", model: "gpt-6.1-sol", responseModel: "unknown-response-model", usage: usage() }),
    ), SOURCE);
    expect(result.calls[0]).toMatchObject({ actor: "compaction", aggregate: true, provider: "github-copilot", model: "gpt-6.1-sol", price: { status: "priced", tier: "reported-cost" } });
    expect(result.calls[1]).toMatchObject({ model: "unknown-response-model", requestedModel: "gpt-6.1-sol", price: { status: "priced", rateVersion: "pi-reported-cost-v1" } });
  });

  it.each([SOURCE, CHILD])("keeps unknown usage kinds for the owning source $path", source => {
    const call = parseTranscript(lines(entry("usage", "unknown", { kind: "future_category", provider: "github-copilot", model: "gpt-6.1-sol", usage: usage(), note: "not a recognized purpose" })), source).calls[0];
    expect(call).toMatchObject({ actor: source.run ? "subagent" : "parent", auxPurpose: "future_category", aggregate: false,
      provider: "github-copilot", model: "gpt-6.1-sol", requestedModel: "gpt-6.1-sol", price: { status: "priced" } });
  });

  it("extracts subagent aggregate run id from the terminal note only", () => {
    const aggregate = entry("usage", "report", { kind: "subagent", provider: "github-copilot", model: "gpt-6.1-sol", usage: usage({ input: 400000 }), note: "fixture name (display qualifier) (run-reported)" });
    const call = parseTranscript(lines(HEADER, aggregate), CHILD).calls[0];
    expect(call).toMatchObject({ actor: "subagent", runId: "run-reported", parentRunId: "run-child", aggregate: true,
      runName: "fixture name (display qualifier)", role: null, agent: null, phase: null, thinking: null,
      provider: "github-copilot", model: "gpt-6.1-sol", requestedModel: "gpt-6.1-sol",
      price: { status: "priced", tier: "aggregate-default-lower-bound", confidence: "estimated" } });
    expect(call.price.status === "priced" && call.price.components.input).toBe(80);
    const noId = parseTranscript(lines({ ...aggregate, note: "fixture name without an id" }), CHILD).calls[0];
    expect(noId).toMatchObject({ runId: null, runName: null, agent: null, role: null, aggregate: true });
    const notTerminal = parseTranscript(lines({ ...aggregate, note: "fixture (run-not-terminal) trailing text" }), SOURCE).calls[0];
    expect(notTerminal.runId).toBeNull();
  });

  it("walks ancestor model and thinking changes rather than latest linear selections", () => {
    const result = parseTranscript(lines(HEADER,
      entry("model_change", "a", { provider: "github-copilot", modelId: "gpt-6.1-sol" }),
      entry("thinking_level_change", "ta", { parentId: "a", thinkingLevel: "high" }),
      entry("message", "first", { parentId: "ta", message: assistant() }),
      entry("model_change", "b", { parentId: "first", provider: "other-provider", modelId: "fixture-other-model" }),
      entry("thinking_level_change", "tb", { parentId: "b", thinkingLevel: "off" }),
      entry("message", "new-branch", { parentId: "tb", message: assistant({ provider: undefined, model: undefined }) }),
      entry("message", "old-branch", { parentId: "ta", message: assistant({ provider: undefined, model: undefined }) }),
      entry("message", "root", { message: assistant({ provider: undefined, model: undefined }) }),
    ), SOURCE);
    expect(result.calls[0]).toMatchObject({ provider: "github-copilot", model: "gpt-6.1-sol", requestedModel: "gpt-6.1-sol", thinking: "high" });
    expect(result.calls[1]).toMatchObject({ provider: null, model: null, requestedModel: null, displayModel: "fixture-other-model", thinking: "off", price: { status: "unpriced", reason: "missing-attribution" } });
    expect(result.calls[2]).toMatchObject({ provider: null, model: null, requestedModel: null, displayModel: "gpt-6.1-sol", thinking: "high", price: { status: "unpriced", reason: "missing-attribution" } });
    expect(result.calls[3]).toMatchObject({ provider: null, model: null, requestedModel: null, thinking: null });
  });

  it.each(["error", "aborted"])("retains %s calls with nonzero recorded usage", stopReason => {
    const call = parseTranscript(lines(entry("message", "failed", { message: assistant({ stopReason, errorMessage: "synthetic private failure" }) })), SOURCE).calls[0];
    expect(call).toMatchObject({ usage: { input: 100, output: 500 }, price: { status: "priced" } });
    expect(JSON.stringify(call)).not.toContain("synthetic private failure");
  });

  it.each(["anthropic-messages", "openai-responses", "openai-completions"])("keeps output and optional subsets unchanged for %s", api => {
    const call = parseTranscript(lines(entry("message", api, { message: assistant({ api }) })), SOURCE).calls[0];
    expect(call).toMatchObject({ api, usage: { input: 100, output: 500, cacheRead: 200, cacheWrite: 50, cacheWrite1h: 20, reasoning: 300 }, price: { status: "priced", components: { input: 0.02, output: 0.5, cacheRead: 0.002, cacheWrite: 0.0125 } } });
  });

  it("uses deterministic byte-offset identity for legacy entries without retaining content", () => {
    const legacy = { type: "message", timestamp: STAMP, message: assistant() };
    const first = parseTranscript([{ byteOffset: 123, json: legacy }], SOURCE).calls[0];
    const second = parseTranscript([{ byteOffset: 123, json: { ...legacy, message: assistant({ content: [{ type: "text", text: "different synthetic content" }] }) } }], SOURCE).calls[0];
    expect(first.entryId).toBe("offset:123");
    expect(second.id).toBe(first.id);
    expect(parseTranscript([{ byteOffset: 124, json: legacy }], SOURCE).calls[0].id).not.toBe(first.id);
    expect(parseTranscript([{ byteOffset: 123, json: legacy }], { ...SOURCE, path: "fixtures/other.jsonl" }).calls[0].id).not.toBe(first.id);
    expect(JSON.stringify(first)).not.toContain("content");
    expect(JSON.stringify(first)).not.toContain("synthetic private");
    const identified = parseTranscript([{ byteOffset: 999, json: { ...legacy, id: "stable-entry" } }], SOURCE).calls[0];
    expect(parseTranscript([{ byteOffset: 0, json: { ...legacy, id: "stable-entry" } }], SOURCE).calls[0].id).toBe(identified.id);
  });

  it("isolates bad entry shape and still yields later valid calls", () => {
    const result = parseTranscript(lines(null, ["synthetic"], entry("message", "bad", { message: "synthetic private error" }), entry("message", "valid", { message: assistant() })), SOURCE);
    expect(result.calls).toHaveLength(1);
    expect(result.calls[0].entryId).toBe("valid");
    expect(result.errors).toEqual([{ byteOffset: 0, code: "invalid-entry" }, { byteOffset: 100, code: "invalid-entry" }, { byteOffset: 200, code: "invalid-entry" }]);
    expect(JSON.stringify(result.errors)).not.toContain("synthetic");
  });

  it.each([
    { input: NaN }, { output: Infinity }, { cacheRead: -1 }, { cacheWrite: "50" },
    { reasoning: -1 }, { totalTokens: Infinity }, { cacheWrite1h: 51 }, { output: undefined },
  ])("isolates invalid token numbers %j", extra => {
    const result = parseTranscript(lines(entry("message", "invalid", { message: assistant({ usage: usage(extra) }) }), entry("message", "valid", { message: assistant() })), SOURCE);
    expect(result.calls.map(call => call.entryId)).toEqual(["valid"]);
    expect(result.errors).toEqual([{ byteOffset: 0, code: "invalid-usage" }]);
  });

  it("preserves recorded zero usage rather than inventing a missing call", () => {
    const call = parseTranscript(lines(entry("message", "zero", { message: assistant({ usage: usage({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, reasoning: 0, totalTokens: 0 }) }) })), SOURCE).calls[0];
    expect(call.price).toMatchObject({ status: "priced", aic: 0 });
  });

  it("uses entry timestamps then numeric message timestamps and isolates unusable dates", () => {
    const result = parseTranscript(lines(
      entry("message", "entry-time", { message: assistant({ timestamp: AT + 2000, latencyMs: 42 }) }),
      entry("message", "fallback", { timestamp: "bad date", message: assistant({ timestamp: AT + 1000 }) }),
      entry("message", "no-date", { timestamp: "synthetic private date", message: assistant({ timestamp: "not numeric" }) }),
      entry("usage", "no-date-usage", { timestamp: null, kind: "spider-aux", usage: usage() }),
    ), SOURCE);
    expect(result.calls.map(call => call.ts)).toEqual([AT, AT + 1000]);
    expect(result.calls[0].latencyMs).toBe(42);
    expect(result.calls[1].latencyMs).toBeNull();
    expect(result.errors).toEqual([{ byteOffset: 200, code: "invalid-timestamp" }, { byteOffset: 300, code: "invalid-timestamp" }]);
  });

  it("keeps pre-rate and foreign-provider calls unpriced with their original metadata", () => {
    const result = parseTranscript(lines(
      entry("message", "historical", { timestamp: "2026-05-31T00:00:00.000Z", message: assistant() }),
      entry("usage", "foreign", { kind: "spider-aux", provider: "fixture-provider", model: "fixture-model", usage: usage() }),
    ), SOURCE);
    expect(result.calls[0].price).toEqual({ status: "unpriced", reason: "no-rate-at-time" });
    expect(result.calls[1]).toMatchObject({ provider: "fixture-provider", model: "fixture-model", requestedModel: "fixture-model", price: { status: "unpriced", reason: "unsupported-provider" } });
  });

  it("ignores non-usage entries and absent optional tool or summary usage", () => {
    const result = parseTranscript(lines(HEADER,
      entry("message", "user", { message: { role: "user", content: "synthetic user content", timestamp: AT } }),
      entry("message", "tool", { message: { role: "toolResult", toolName: "fixture_tool", content: [] } }),
      entry("compaction", "compact", { summary: "synthetic" }),
      entry("branch_summary", "branch", { summary: "synthetic" }),
      entry("custom", "custom", { data: { usage: usage() } }),
    ), SOURCE);
    expect(result.calls).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it.each([SOURCE, CHILD])("retains billed usage without a kind for $path", source => {
    const result = parseTranscript(lines(entry("usage", "kindless", { provider: "github-copilot", model: "gpt-6.1-sol", usage: usage() })), source);
    expect(result.errors).toEqual([]);
    expect(result.calls).toHaveLength(1);
    expect(result.calls[0]).toMatchObject({ actor: source.run ? "subagent" : "parent", auxPurpose: null,
      aggregate: false, usage: { input: 100, output: 500 }, price: { status: "priced" } });
  });

  it("skips null optional usage without marking healthy entries corrupt", () => {
    const result = parseTranscript(lines(
      entry("message", "tool-null", { message: { role: "toolResult", usage: null } }),
      entry("compaction", "compact-null", { usage: null }),
      entry("branch_summary", "branch-null", { usage: null }),
      entry("message", "valid", { message: assistant() }),
    ), SOURCE);
    expect(result.errors).toEqual([]);
    expect(result.calls.map(call => call.entryId)).toEqual(["valid"]);
  });

  it("preserves run IDs and note labels across newlines", () => {
    const call = parseTranscript(lines(entry("usage", "multiline", { kind: "subagent", usage: usage(), note: "fixture\nname (qualifier) (run-reported)" })), SOURCE).calls[0];
    expect(call).toMatchObject({ runId: "run-reported", runName: "fixture\nname (qualifier)", aggregate: true });
  });

  it("reports and skips duplicate entry IDs rather than emitting colliding calls", () => {
    const result = parseTranscript(lines(
      entry("message", "duplicate", { message: assistant() }),
      entry("message", "duplicate", { message: assistant({ usage: usage({ input: 999 }) }) }),
      entry("message", "valid", { message: assistant() }),
    ), SOURCE);
    expect(result.errors).toEqual([{ byteOffset: 100, code: "duplicate-entry" }]);
    expect(result.calls.map(call => call.entryId)).toEqual(["duplicate", "valid"]);
    expect(result.calls[0].usage.input).toBe(100);
  });

  it("keeps the first ancestor when a non-usage entry ID is duplicated", () => {
    const result = parseTranscript(lines(
      entry("thinking_level_change", "effort", { thinkingLevel: "high" }),
      entry("thinking_level_change", "effort", { thinkingLevel: "off" }),
      entry("message", "valid", { parentId: "effort", message: assistant() }),
    ), SOURCE);
    expect(result.errors).toEqual([{ byteOffset: 100, code: "duplicate-entry" }]);
    expect(result.calls[0].thinking).toBe("high");
  });

  it.each(["", "   "])("falls back to the transcript session when owner ID is %j", sessionId => {
    const source = { ...CHILD, run: { ...CHILD.run!, sessionId } };
    const result = parseTranscript(lines(HEADER, entry("message", "child", { message: assistant() })), source);
    expect(result.calls[0].sessionId).toBe("session-fixture");
  });

  it("separates bare initial display model from absent recorded request model", () => {
    const call = parseTranscript(lines(entry("compaction", "initial", { usage: usage() })), CHILD).calls[0];
    expect(call).toMatchObject({ requestedModel: null, displayModel: "gpt-6.1-sol", provider: null, model: null });
  });

  it("prefers recorded thinking over inferred effort and retains tree fallback", () => {
    const result = parseTranscript(lines(
      entry("thinking_level_change", "effort", { thinkingLevel: "high" }),
      entry("message", "recorded", { parentId: "effort", message: assistant({ providerThinkingLevel: "low" }) }),
      entry("message", "fallback", { parentId: "effort", message: assistant() }),
    ), SOURCE);
    expect(result.calls.map(call => call.thinking)).toEqual(["low", "high"]);
  });

  it("warns once per cycle node without counting retained calls as skipped lines", () => {
    const result = parseTranscript(lines(
      entry("thinking_level_change", "a", { parentId: "b", thinkingLevel: "high" }),
      entry("model_change", "b", { parentId: "a", modelId: "gpt-6.1-sol" }),
      entry("message", "first", { parentId: "a", message: assistant() }),
      entry("message", "second", { parentId: "first", message: assistant() }),
      entry("message", "bad", { message: assistant({ usage: null }) }),
    ), SOURCE);
    expect(result.calls.map(call => call.entryId)).toEqual(["first", "second"]);
    expect(result.errors).toEqual([{ byteOffset: 400, code: "invalid-usage" }]);
    expect(result).toMatchObject({ warnings: [{ byteOffset: 0, code: "invalid-tree" }, { byteOffset: 100, code: "invalid-tree" }] });
  });

  // Report labels are name ?? agent, not authoritative run names. Preserve the
  // label here; Task 4 should prefer runs_meta.name when enriching the call.
  it("preserves an agent fallback label without inventing child agent metadata", () => {
    const call = parseTranscript(lines(entry("usage", "agent-label", { kind: "subagent", usage: usage(), note: "fixture-worker (run-reported)" })), SOURCE).calls[0];
    expect(call).toMatchObject({ runName: "fixture-worker", runId: "run-reported", agent: null });
  });

  it("does not loop on cyclic ancestry or infer billing from missing ancestors", () => {
    const result = parseTranscript(lines(
      entry("model_change", "cycle-a", { parentId: "cycle-b", modelId: "gpt-6.1-sol", provider: "github-copilot" }),
      entry("thinking_level_change", "cycle-b", { parentId: "cycle-a", thinkingLevel: "high" }),
      entry("message", "cycle-call", { parentId: "cycle-a", message: assistant() }),
      entry("message", "missing-call", { parentId: "missing", message: assistant({ provider: undefined, model: undefined }) }),
    ), SOURCE);
    expect(result.calls).toHaveLength(2);
    expect(result.calls[0]).toMatchObject({ thinking: null, requestedModel: "gpt-6.1-sol", provider: "github-copilot", model: "gpt-6.1-sol" });
    expect(result.calls[1]).toMatchObject({ thinking: null, requestedModel: null, provider: null, model: null, price: { status: "unpriced", reason: "missing-attribution" } });
    expect(result.errors).toEqual([]);
    expect(result).toMatchObject({ warnings: [{ byteOffset: 0, code: "invalid-tree" }, { byteOffset: 100, code: "invalid-tree" }] });
  });
});

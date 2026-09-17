import { describe, it, expect } from "vitest";
import { toToolResult, markToolCallError, consumeToolCallError } from "../result";

describe("toToolResult — pi AgentToolResult normalization", () => {
  it("always yields a content array of text blocks + details", () => {
    const r = toToolResult({ text: "hi", details: { a: 1 } });
    expect(Array.isArray(r.content)).toBe(true);
    expect(r.content[0]).toEqual({ type: "text", text: "hi" });
    expect(r.details).toEqual({ a: 1 });
  });

  it("prefers model-facing `text` over everything else", () => {
    const r = toToolResult({ text: "clean", content: "raw", display: "panel", details: { x: 1 } });
    expect(r.content[0].text).toBe("clean");
  });

  it("degrades a {display, details} handler (no text) to JSON of details", () => {
    const r = toToolResult({ display: { render: () => ["ignored"] }, details: { uuid: "u1", status: "staged" } });
    expect(r.content[0].text).toContain("u1");
    expect(r.content[0].text).toContain("staged");
    expect(r.details).toEqual({ uuid: "u1", status: "staged" });
  });

  it("maps {error} to an Error string", () => {
    expect(toToolResult({ error: "boom" }).content[0].text).toBe("Error: boom");
  });

  it("accepts a plain string and a {content:string} shape", () => {
    expect(toToolResult("plain").content[0].text).toBe("plain");
    expect(toToolResult({ content: "out" }).content[0].text).toBe("out");
  });

  it("strips ANSI escapes so nothing color-bearing reaches the model", () => {
    const r = toToolResult({ text: "\x1b[36mcyan\x1b[0m" });
    expect(r.content[0].text).toBe("cyan");
  });

  it("never throws on null/circular input", () => {
    const circ: any = {}; circ.self = circ;
    expect(() => toToolResult(circ)).not.toThrow();
    expect(toToolResult(null).content[0].text).toBe("");
  });
});

// Mechanism (B): the isError signal a downstream tool_result hook needs to flip
// ToolResultMessage.isError while preserving content/details (see
// pi-tool-error-contract-report.md §1/§3). toToolResult never read/forwarded isError
// before this; exec/kill/message already compute a real boolean, so it must be
// honored explicitly, falling back to the pre-existing {error} heuristic only when no
// explicit value was supplied.
describe("toToolResult — isError signal (mechanism B)", () => {
  it("flags isError from an explicit boolean (exec/kill/message convention)", () => {
    expect(toToolResult({ text: "boom", details: {}, isError: true }).isError).toBe(true);
    expect(toToolResult({ text: "ok", details: {}, isError: false }).isError).toBe(false);
  });

  it("falls back to {error} when no explicit isError is present", () => {
    expect(toToolResult({ error: "boom" }).isError).toBe(true);
    expect(toToolResult({ text: "ok", details: {} }).isError).toBe(false);
  });

  it("an explicit isError:false is honored even though {error} would otherwise imply failure", () => {
    // Explicit false must win over the heuristic — "honour an explicit value; fall back
    // to the heuristic only when no explicit value was supplied".
    expect(toToolResult({ error: "non-fatal note", isError: false }).isError).toBe(false);
  });

  it("recognizes normalized details.ok:false as an error for both top-level and nested producer shapes (C-M1)", () => {
    // control-bind and doctor return the details object directly.
    expect(toToolResult({ ok: false, message: "bind failed" }).isError).toBe(true);
    expect(toToolResult({ ok: false, lines: ["doctor found issues"] }).isError).toBe(true);
    // Some dispatchers wrap that object in an explicit details field.
    expect(toToolResult({ text: "memory failed", details: { ok: false, note: "no write" } }).isError).toBe(true);
  });

  it("does not let the details.ok fallback override an explicit isError:false (C-M1)", () => {
    expect(toToolResult({ text: "non-fatal", details: { ok: false }, isError: false }).isError).toBe(false);
  });

  it("defaults isError to false for primitive/null/undefined input (no object to read a flag from)", () => {
    expect(toToolResult("plain").isError).toBe(false);
    expect(toToolResult(null).isError).toBe(false);
    expect(toToolResult(undefined).isError).toBe(false);
  });
});

// The per-toolCallId one-shot correlation store markToolCallError/consumeToolCallError
// hand off from extension.ts's execute() to routing/index.ts's tool_result hook. Must
// be keyed by toolCallId (a Set/Map), never a scalar — pi documents that tool_result
// may interleave under parallel tool execution.
describe("markToolCallError / consumeToolCallError — per-toolCallId one-shot correlation", () => {
  it("consume returns true exactly once for a marked id, then false (one-shot, no leak)", () => {
    markToolCallError("call-1");
    expect(consumeToolCallError("call-1")).toBe(true);
    expect(consumeToolCallError("call-1")).toBe(false);
  });

  it("does not leak across different toolCallIds (correlation, not a scalar)", () => {
    markToolCallError("call-a");
    expect(consumeToolCallError("call-b")).toBe(false); // a different, unmarked id
    expect(consumeToolCallError("call-a")).toBe(true); // call-a's own mark is untouched
  });

  it("returns false for an unmarked id, and for undefined/empty (never throws)", () => {
    expect(consumeToolCallError("never-marked")).toBe(false);
    expect(consumeToolCallError(undefined)).toBe(false);
    expect(consumeToolCallError("")).toBe(false);
  });

  // A-M3 (branch-review A-architecture.md): if whatever is supposed to drain marks
  // never runs (e.g. `registerRouting` failed to wire the `tool_result` hook at all —
  // see extension.ts), every subsequent `markToolCallError` call just kept adding to
  // this module-level Set for the rest of the process lifetime. A hard cap is a
  // backstop against that, independent of whether the drain-failure is ALSO surfaced
  // elsewhere (it now is — see extension.test.ts's doctor test).
  it("A-M3: marking far more calls than could ever be legitimately in flight never grows the Set without bound", () => {
    for (let i = 0; i < 2000; i++) markToolCallError(`flood-${i}`);
    // The MOST RECENT mark must still be present (FIFO eviction drops the OLDEST, not
    // the newest) — checked BEFORE the bulk consume below, which would otherwise
    // delete it itself and make this assertion meaningless.
    expect(consumeToolCallError("flood-1999")).toBe(true);
    // The very FIRST mark must have been evicted long ago — proves a genuine FIFO
    // bound, not merely "still works by luck".
    expect(consumeToolCallError("flood-0")).toBe(false);
    // Count how many of the remaining (1..1998) ids survived.
    let survived = 0;
    for (let i = 1; i < 1999; i++) if (consumeToolCallError(`flood-${i}`)) survived++;
    expect(survived).toBeLessThan(1998); // some were evicted — not unbounded
    expect(survived).toBeGreaterThan(0); // but not ALL evicted either — still usable
  });
});

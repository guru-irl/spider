import { describe, it, expect } from "vitest";
import type { ContextEvent } from "@earendil-works/pi-coding-agent";
import { toToolResult, repairBlankToolResults, ensureNonEmptyToolContent, rethrowWithMessage } from "../result";

describe("blank thrown error normalization", () => {
  it.each([
    { original: new TypeError(""), kind: "TypeError" },
    { original: new Error("  \n"), kind: "Error" },
    { original: "", kind: "string" },
  ])("preserves a blank $kind throw as the cause", ({ original, kind }) => {
    try {
      rethrowWithMessage(original, "spider exec");
      expect.fail("expected rethrowWithMessage to throw");
    } catch (replacement) {
      expect(replacement).toBeInstanceOf(Error);
      expect(replacement).toMatchObject({
        message: `spider exec failed: ${kind} with no message`, cause: original,
      });
    }
  });
});

describe("edit/write delegate result normalization", () => {
  it("turns undefined into a non-error empty result rather than throwing", () => {
    expect(ensureNonEmptyToolContent(undefined)).toEqual({
      content: [{ type: "text", text: "(no message)" }], details: {},
    });
  });
});

describe("context repair for settled tool results", () => {
  it("repairs an existing blank error from another tool without mutating the session message", () => {
    const bad = { role: "toolResult", toolName: "bash", toolCallId: "old", content: [{ type: "text", text: "" }], isError: true, timestamp: 1 };
    const success = { ...bad, toolCallId: "new", isError: false, content: [] };
    const messages = [bad, success,
      { ...bad, toolCallId: "spaces", content: [{ type: "text", text: " \n" }] }] as ContextEvent["messages"];
    const repaired = repairBlankToolResults(messages);
    expect(repaired?.messages.map(m => m.role === "toolResult" ? m.content : null)).toEqual([
      [{ type: "text", text: "(tool error with no message)" }],
      [],
      [{ type: "text", text: "(tool error with no message)" }],
    ]);
    expect(repaired?.messages[0]).toMatchObject({ toolCallId: "old", toolName: "bash", isError: true });
    expect(repaired?.messages[1]).toBe(success);
    expect(messages[0]).toBe(bad);
    expect(bad.content[0].text).toBe("");
    expect(repairBlankToolResults(messages)).toEqual(repaired);
  });

  it("skips malformed tool results but still repairs a later well-formed blank error", () => {
    const bad = (content: unknown, id: string) => ({ role: "toolResult", toolName: "bash", toolCallId: id,
      content, isError: true, timestamp: 1 });
    const malformed = [
      bad("not an array", "string-content"), bad(null, "null-content"),
      bad([{ type: "text" }], "missing-text"), bad([{ type: "text", text: 42 }], "numeric-text"),
      bad([{ type: "unknown", text: "" }, { type: "text", text: "" }], "unknown-block"),
      bad([null], "null-block"),
    ];
    const valid = bad([{ type: "text", text: "" }], "valid");
    const messages = [...malformed, valid] as unknown as ContextEvent["messages"];
    const snapshots = malformed.map(entry => JSON.stringify(entry));
    const repaired = repairBlankToolResults(messages);
    expect(repaired?.messages.slice(0, malformed.length)).toEqual(malformed);
    malformed.forEach((entry, index) => {
      expect(repaired?.messages[index]).toBe(entry);
      expect(JSON.stringify(entry)).toBe(snapshots[index]);
    });
    expect(repaired?.messages[malformed.length]).toMatchObject({
      content: [{ type: "text", text: "(tool error with no message)" }],
    });
    expect(messages[malformed.length]).toBe(valid);
  });

  it("does not throw on unexpected property access and still repairs the next error", () => {
    const unexpected = { role: "toolResult", isError: true,
      get content(): never { throw new Error("unreadable content"); } };
    const valid = { role: "toolResult", toolCallId: "next", toolName: "bash", isError: true,
      content: [{ type: "text", text: "" }], timestamp: 1 };
    const repaired = repairBlankToolResults([unexpected, valid] as ContextEvent["messages"]);
    expect(repaired?.messages[0]).toBe(unexpected);
    expect(repaired?.messages[1]).toMatchObject({ content: [{ type: "text", text: "(tool error with no message)" }] });
    expect(repairBlankToolResults(null as unknown as ContextEvent["messages"])).toBeUndefined();
  });

  it.each(["", "  \n"])('drops %j error text next to an image, adding readable error text', blank => {
    const image = { type: "image" as const, data: "aGVsbG8=", mimeType: "image/png" };
    const bad = { role: "toolResult", toolName: "read", toolCallId: "mixed", isError: true,
      content: [{ type: "text" as const, text: blank }, image], timestamp: 1 };
    const result = repairBlankToolResults([bad] as ContextEvent["messages"]);
    expect(result?.messages[0]).toMatchObject({ content: [image, { type: "text", text: "(tool error with no message)" }] });
    expect(bad.content).toEqual([{ type: "text", text: blank }, image]);
  });

  it("drops blank error text next to an image and meaningful text without replacing the meaningful text", () => {
    const image = { type: "image" as const, data: "aGVsbG8=", mimeType: "image/png" };
    const bad = { role: "toolResult", toolName: "read", toolCallId: "mixed-text", isError: true,
      content: [{ type: "text" as const, text: "" }, image, { type: "text" as const, text: "details" }], timestamp: 1 };
    const result = repairBlankToolResults([bad] as ContextEvent["messages"]);
    expect(result?.messages[0]).toMatchObject({ content: [image, { type: "text", text: "details" }] });
    expect(result?.messages[0]).not.toBe(bad);
    expect(bad.content).toHaveLength(3);
  });

  it.each([
    { content: [] }, { content: [{ type: "text", text: "" }] },
    { content: [{ type: "text", text: "  \n" }] },
    { content: [{ type: "text", text: "" }, { type: "image", data: "aGVsbG8=", mimeType: "image/png" }] },
  ])("does not rewrite a non-error blank result with content $content", ({ content }) => {
      const success = { role: "toolResult", toolName: "read", toolCallId: "empty-file", isError: false, content, timestamp: 1 };
      expect(repairBlankToolResults([success] as ContextEvent["messages"])).toBeUndefined();
      expect(success.content).toBe(content);
    });

  it("returns undefined for a list with no blank tool text, preserving the cache-friendly layout", () => {
    const messages = [
      { role: "toolResult", toolName: "read", toolCallId: "ok", content: [{ type: "text", text: "ok" }], isError: false, timestamp: 1 },
      { role: "user", content: "hello", timestamp: 2 },
    ] as ContextEvent["messages"];
    expect(repairBlankToolResults(messages)).toBeUndefined();
  });

  it("leaves an image-only tool result alone, since the provider accepts an image block", () => {
    const messages = [{ role: "toolResult", toolName: "read", toolCallId: "image",
      content: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }], isError: false, timestamp: 1 }] as ContextEvent["messages"];
    expect(repairBlankToolResults(messages)).toBeUndefined();
  });
});

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

  it("replaces an empty handler message, including text emptied by ANSI stripping", () => {
    expect(toToolResult({ text: "", details: {} }).content[0].text).toBe("(no message)");
    expect(toToolResult({ text: "\x1b[0m", isError: true }).content[0].text).toBe("Error (no message)");
  });

  it("reports the exit code on a silent failed exec and preserves structured details", () => {
    const details = { stdout: "", stderr: "", exitCode: 1, outcome: "exited" };
    const result = toToolResult({ text: "", details, isError: true });
    expect(result.content[0].text).toBe("exit 1 (no output)");
    expect(result.isError).toBe(true);
    expect(result.details).toBe(details);
  });

  it("reports minimal text on a silent successful exec", () => {
    expect(toToolResult({ text: "", details: { stdout: "", stderr: "", exitCode: 0, outcome: "exited" }, isError: false }).content[0].text).toBe("(no output)");
  });

  it.each([
    [{ outcome: "timeout", exitCode: null }, /^detached at timeout \(no output yet; exit status unknown\)$/],
    [{ outcome: "aborted", exitCode: 137 }, /^aborted \(no output\)$/],
    [{ outcome: "signal", exitCode: null, signal: "SIGKILL" }, /killed.*SIGKILL.*no output/i],
    [{ outcome: "spawn-error", exitCode: null }, /spawn error.*no output/i],
  ])("describes a silent exec with outcome %o", (outcome, pattern) => {
    const result = toToolResult({ text: "", details: { stdout: "", stderr: "", ...outcome }, isError: true });
    expect(result.content[0].text).toMatch(pattern);
  });

  it("leaves an existing exec message untouched", () => {
    expect(toToolResult({ text: "actual output", details: { stdout: "actual output", stderr: "", exitCode: 1 }, isError: true }).content[0].text).toBe("actual output");
  });

  it("never throws on null/circular input", () => {
    const circ: any = {}; circ.self = circ;
    expect(() => toToolResult(circ)).not.toThrow();
    expect(toToolResult(null).content[0].text).toBe("(no message)");
  });
});

// Explicit producer flags take precedence over the action-error and details.ok heuristics.
describe("toToolResult native error classification", () => {
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

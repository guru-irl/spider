import { describe, it, expect } from "vitest";
import { toToolResult } from "../result";

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

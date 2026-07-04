import { describe, it, expect } from "vitest";
import { renderSpiderResult, renderSpiderCall, renderSubagentDone } from "../render-result";
import type { StageResult } from "@spider/memory";

// Minimal fakes for pi's renderResult call shape. We only exercise the fields the
// dispatcher reads: result.content (model text), result.details (structured payload),
// context.args ({ action, sub/command }).
const opts = {} as any;
const theme = {} as any;
const mkCtx = (args: any) => ({ args }) as any;
const mkResult = (details: unknown, text = "") =>
  ({ content: text ? [{ type: "text", text }] : [], details }) as any;

/** Every renderer must return a valid pi Component: render(width) AND invalidate(). */
function assertComponent(c: any) {
  expect(c).toBeTruthy();
  expect(typeof c.render).toBe("function");
  expect(typeof c.invalidate).toBe("function");
  const lines = c.render(80);
  expect(Array.isArray(lines)).toBe(true);
}

describe("renderSpiderResult dispatcher", () => {
  it("remember → shows saved content + status, no duplicate glyph/rule header", () => {
    const details = { status: "active", uuid: "abc-123", content: "remember to hydrate", category: "reminder" } as StageResult;
    const c = renderSpiderResult(mkResult(details), opts, theme, mkCtx({ action: "remember" }));
    assertComponent(c);
    const text = c.render(80).join("\n");
    expect(text).toContain("remember to hydrate");
    expect(text).toContain("active");
    expect(text).not.toMatch(/─{3,}/);
  });

  it("recall → list of matches with a count, no duplicate glyph header", () => {
    const recs = [
      { uuid: "u1", category: "fact", content: "the sky is blue", link: null },
      { uuid: "u2", category: "fact", content: "grass is green", link: null },
    ];
    const c = renderSpiderResult(mkResult(recs), opts, theme, mkCtx({ action: "recall" }));
    assertComponent(c);
    const text = c.render(80).join("\n");
    expect(text).not.toContain("🕸 recall"); // the tool title already carries the glyph
    expect(text).toContain("the sky is blue");
    expect(text).toContain("2 matches");
  });

  it("control sub=pending → pending panel", () => {
    const recs = [{ uuid: "p1", category: "fact", content: "pending item", link: null }];
    const c = renderSpiderResult(
      mkResult(recs),
      opts,
      theme,
      mkCtx({ action: "control", sub: "pending" }),
    );
    assertComponent(c);
    expect(c.render(80).join("\n")).toContain("pending item");
  });

  it("search → search panel with hit count", () => {
    const rows = [
      { key: "k1", kind: "memory", id: "1", title: "fact", snippet: "hello world" },
    ];
    const c = renderSpiderResult(mkResult(rows), opts, theme, mkCtx({ action: "search" }));
    assertComponent(c);
    const text = c.render(80).join("\n");
    expect(text).toContain("search");
    expect(text).toContain("hello world");
  });

  it("import → import summary panel", () => {
    const summary = { imported: 3, skipped: 1, staged: 5, committed: 2, perSession: [] };
    const c = renderSpiderResult(mkResult(summary), opts, theme, mkCtx({ action: "import" }));
    assertComponent(c);
    const text = c.render(80).join("\n");
    expect(text).toContain("import");
    expect(text).toContain("3");
  });

  it("DEFAULT (unmatched action) → text fallback from result.content", () => {
    const c = renderSpiderResult(
      mkResult({ anything: true }, "fallback output line 1\nfallback output line 2"),
      opts,
      theme,
      mkCtx({ action: "message" }),
    );
    assertComponent(c);
    const text = c.render(80).join("\n");
    expect(text).toContain("fallback output line 1");
    expect(text).toContain("fallback output line 2");
  });

  it("always returns a Component (never undefined) even with no args", () => {
    const c = renderSpiderResult(mkResult(null, "plain"), opts, theme, mkCtx({}));
    assertComponent(c);
  });
});

const marker = { fg: (t: string, s: string) => `⟨${t}|${s}⟩`, bold: (s: string) => s, italic: (s: string) => s };

describe("run block colors (#36)", () => {
  it("does not status-color the glyph, type, or status word", () => {
    const details = { runs: [{ name: "todo-hunt", agent: "worker", model: "openai/gpt-5", status: "running", task: "" }] };
    const out = renderSpiderResult({ details }, { expanded: false }, marker, { args: { action: "run" } }).render(120).join("\n");
    expect(out).not.toMatch(/⟨(success|error|warning|accent)\|/);
    expect(out).toContain("⟨toolTitle|");
  });

  it("run result body starts with a blank gap line and is indented one space further", () => {
    const details = { runs: [{ name: "a", agent: "worker", model: "x", status: "running", task: "" }] };
    const lines = renderSpiderResult({ details }, { expanded: false }, marker, { args: { action: "run" } }).render(120);
    expect(lines[0]).toBe("");                    // gap line under the title
    expect(lines[1].startsWith("   ")).toBe(true); // 3-space indent (runBlock's 2 + the global 1)
  });
});

  it("run block shows the thinking level after the model when present", () => {
    const details = { run: { name: "a", agent: "worker", model: "openai/gpt-5", thinking: "high", status: "running", task: "" } };
    const out = renderSpiderResult({ details }, { expanded: false }, marker, { args: { action: "run" } }).render(200).join("\n");
    expect(out).toContain("high");
  });

describe("renderSpiderCall verb italics (UI standard)", () => {
  const ith = { fg: (_t: string, s: string) => s, bold: (s: string) => s, italic: (s: string) => `«${s}»` };
  const call = (args: any) => renderSpiderCall(args, ith, {}).render(200).join("\n");
  it("italicises the action verb for every command", () => {
    expect(call({ action: "remember" })).toContain("«remember»");
    expect(call({ action: "recall" })).toContain("«recall»");
    expect(call({ action: "search" })).toContain("«search»");
    expect(call({ action: "run" })).toContain("«run»");           // single
    expect(call({ action: "run", tasks: [{}, {}], async: true })).toContain("«parallel»");
    expect(call({ action: "control", command: "memory" })).toContain("«control»");
  });
});

describe("run block output truncation (ctrl+o)", () => {
  it("collapses subagent output to 2 lines with an expand hint, shows all when expanded", () => {
    const details = { run: { name: "a", agent: "worker", status: "done", result: "line1\nline2\nline3\nline4" } };
    const collapsed = renderSpiderResult({ details }, { expanded: false }, marker, { args: { action: "run" } }).render(200).join("\n");
    expect(collapsed).toContain("line1");
    expect(collapsed).toContain("line2");
    expect(collapsed).not.toContain("line4");
    expect(collapsed).toContain("more lines");
    expect(collapsed).toContain("ctrl+o to expand");
    const expanded = renderSpiderResult({ details }, { expanded: true }, marker, { args: { action: "run" } }).render(200).join("\n");
    expect(expanded).toContain("line4");
  });
});

describe("renderSubagentDone transcript renderer (ctrl+o)", () => {
  const th = { fg: (_t: string, s: string) => s, bold: (s: string) => s, italic: (s: string) => `«${s}»`, bg: (tok: string, s: string) => `[${tok}]${s}` };
  const msg = { customType: "spider.subagent_done", details: { name: "bravo-worker", agent: "worker", model: "github-copilot/claude-opus-4.8", status: "done", output: "l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8" } };
  it("uses the run-result-style layout (spider header + ⤴ tool output), tool shell, collapsed + ctrl+o", () => {
    const out = renderSubagentDone(msg, { expanded: false }, th).render(200).join("\n");
    expect(out).toContain("spider");
    expect(out).toContain("bravo-worker");       // run name
    expect(out).toContain("«worker»");             // agent italicised (footer style)
    expect(out).toContain("opus-4.8");            // shortModel
    expect(out).toContain("[toolSuccessBg]");     // green tool shell painted
    expect(out).toContain("⤴");                    // output marker like a real run result
    expect(out).toContain("l1");
    expect(out).not.toContain("l8");              // collapsed (CAP=6)
    expect(out).toContain("ctrl+o to expand output");
  });
  it("paints the error shell on failure", () => {
    const out = renderSubagentDone({ ...msg, details: { ...msg.details, status: "failed" } }, { expanded: false }, th).render(200).join("\n");
    expect(out).toContain("[toolErrorBg]");
  });
  it("shows the COMPLETE output when expanded", () => {
    const out = renderSubagentDone(msg, { expanded: true }, th).render(200).join("\n");
    expect(out).toContain("l8");
    expect(out).not.toContain("ctrl+o to expand");
  });
});

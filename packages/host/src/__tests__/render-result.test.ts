import { describe, it, expect } from "vitest";
import { renderSpiderResult, renderSpiderCall, renderSubagentDone, renderCommandOutput } from "../render-result";
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

  it("search → per-row view with count, title, kind and snippet", () => {
    const rows = [
      { key: "k1", kind: "memory", id: "1", title: "fact", snippet: "hello world" },
      { key: "k2", kind: "content", id: "2", title: "files", snippet: "learning.ts\nrun-memory-todo.ts\nmore.ts", source: "pkg/x" },
    ];
    const c = renderSpiderResult(mkResult(rows), opts, theme, mkCtx({ action: "search" }));
    assertComponent(c);
    const text = c.render(80).join("\n");
    expect(text).toMatch(/2 result/);
    expect(text).toContain("fact");
    expect(text).toContain("memory");
    expect(text).toContain("hello world");
    expect(text).not.toMatch(/🕸\s*🕸/); // no double glyph
    // multi-line snippet is flattened to a single content line (no bleed)
    const bleed = c.render(80).filter((l) => l.includes("run-memory-todo.ts") && !l.includes("learning.ts"));
    expect(bleed).toHaveLength(0);
  });

  it("control doctor → status line + guttered checks (no raw JSON, heading stripped)", () => {
    const details = {
      ok: true,
      lines: [
        "## spider doctor 🕸",
        "",
        "- better-sqlite3: loaded (journal_mode=wal)",
        "- sqlite-vec: loaded (vec0 vectors table ready)",
      ],
    };
    const c = renderSpiderResult(mkResult(details), opts, theme, mkCtx({ action: "control", command: "doctor" }));
    assertComponent(c);
    const text = c.render(80).join("\n");
    expect(text).not.toMatch(/\{|"ok"|"lines"/); // NOT raw JSON
    expect(text).not.toContain("##");            // markdown heading dropped
    expect(text).toContain("✓");
    expect(text).toContain("better-sqlite3");
    expect(text).toContain("loaded");
  });

  it("control doctor → ✗ status when ok is false", () => {
    const details = { ok: false, lines: ["- sqlite-vec: NOT loaded"] };
    const c = renderSpiderResult(mkResult(details), opts, theme, mkCtx({ action: "control", command: "doctor" }));
    assertComponent(c);
    expect(c.render(80).join("\n")).toContain("✗");
  });

  it("todo list → checklist with glyphs, ids and completion footer (no raw JSON)", () => {
    const details = [{ seq: 1, text: "write test", done: true }, { seq: 2, text: "impl", done: false }];
    const c = renderSpiderResult(mkResult(details), opts, theme, mkCtx({ action: "todo", op: "list" }));
    assertComponent(c);
    const out = c.render(80).join("\n");
    expect(out).toContain("✓");
    expect(out).toContain("○");
    expect(out).toMatch(/#1|#2/);
    expect(out).toMatch(/1\/2/);
    expect(out).not.toMatch(/\{|"seq"|"done"/); // NOT raw JSON
  });

  it("todo add → single-item checklist for the affected todo", () => {
    const details = { seq: 3, text: "new task", done: false };
    const c = renderSpiderResult(mkResult(details), opts, theme, mkCtx({ action: "todo", op: "add" }));
    assertComponent(c);
    const out = c.render(80).join("\n");
    expect(out).toContain("new task");
    expect(out).toMatch(/0\/1/);
  });

  it("control stats → token-savings + rows + model table card (no raw JSON)", () => {
    const details = {
      tokenSavings: { indexedChunks: 100, estTokensSaved: 12000 },
      rowCounts: { memory: 42, todos: 8 },
      models: [{ model: "copilot/fast", calls: 2, okRate: 0.5, avgMs: 200, tokens: 1200 }],
    };
    const c = renderSpiderResult(mkResult(details), opts, theme, mkCtx({ action: "control", command: "stats" }));
    assertComponent(c);
    const out = c.render(80).join("\n");
    expect(out).toMatch(/token savings/);
    expect(out).toContain("12000");
    expect(out).toContain("memory");
    expect(out).toContain("copilot/fast");
    expect(out).not.toMatch(/\{|"tokenSavings"/); // NOT raw JSON
  });

  it("control models → tier-grouped catalog card with glyphs + defaults (no raw JSON)", () => {
    const E = (over: any) => ({ provider: "copilot", id: "m", tier: "standard", thinking: false, vision: false, ctx: 1, speed: 1, costHint: 1, available: true, ...over });
    const details = {
      catalog: [E({ id: "claude-sonnet-5", tier: "standard" }), E({ id: "gone", tier: "light", available: false })],
      defaults: { worker: "copilot/claude-sonnet-5" },
    };
    const c = renderSpiderResult(mkResult(details), opts, theme, mkCtx({ action: "control", command: "models" }));
    assertComponent(c);
    const out = c.render(80).join("\n");
    expect(out).toMatch(/light/);
    expect(out).toMatch(/standard/);
    expect(out).toContain("●");
    expect(out).toContain("○");
    expect(out).toContain("worker");
    expect(out).not.toMatch(/\{|"catalog"/); // NOT raw JSON
  });

  it("control config → group-labelled config view (no 🕸, no raw JSON)", () => {
    const details = { config: { "ui.footer": false } };
    const c = renderSpiderResult(mkResult(details), opts, theme, mkCtx({ action: "control", command: "config" }));
    assertComponent(c);
    const out = c.render(80).join("\n");
    expect(out).toMatch(/UI/);
    expect(out).toContain("false");
    expect(out).not.toContain("🕸");
    expect(out).not.toMatch(/\{|"config"/); // NOT raw JSON
  });

  it("control insights → learning-graph card with nodes/edges/stats (no raw JSON)", () => {
    const details = {
      nodes: [{ id: "skill:tdd", label: "TDD", kind: "skill", category: "process" }, { id: "mem:u1", label: "prefers tabs", kind: "memory" }],
      edges: [{ source: "mem:u1", target: "skill:tdd" }],
      stats: { nodes: 2, edges: 1, linkedPct: 50 },
    };
    const c = renderSpiderResult(mkResult(details), opts, theme, mkCtx({ action: "control", command: "insights" }));
    assertComponent(c);
    const out = c.render(80).join("\n");
    expect(out).toMatch(/2 nodes/);
    expect(out).toContain("TDD");
    expect(out).toMatch(/mem:u1|skill:tdd/);
    expect(out).not.toMatch(/\{|"linkedPct"/); // NOT raw JSON
  });

  it("control migrate → migrate result panel (no raw JSON)", () => {
    const details = { dryRun: false, applied: true, moved: { memory: 3, skills: 1 }, ambiguous: [] };
    const c = renderSpiderResult(mkResult(details), opts, theme, mkCtx({ action: "control", command: "migrate" }));
    assertComponent(c);
    const out = c.render(80).join("\n");
    expect(out).toContain("3");
    expect(out).toMatch(/memory|skills/);
    expect(out).not.toMatch(/\{\s*"moved"/);
  });

  it("control memory consolidate → active-memory list (no raw JSON)", () => {
    const details = { entries: [{ category: "preference", content: "tabs over spaces" }], usage: 1234 };
    const c = renderSpiderResult(mkResult(details), opts, theme, mkCtx({ action: "control", command: "memory", sub: "consolidate" }));
    assertComponent(c);
    const out = c.render(80).join("\n");
    expect(out).toMatch(/1 active · 1234/);
    expect(out).toContain("preference");
    expect(out).toContain("tabs over spaces");
    expect(out).not.toMatch(/"entries"/);
  });

  it("fetch → index-style card with chunk count, url/source, no glyph, no raw JSON", () => {
    const details = { count: 2, chunks: 7, embedded: 7, urls: ["http://a", "http://b"], sources: ["a", "b"] };
    const c = renderSpiderResult(mkResult(details), opts, theme, mkCtx({ action: "fetch" }));
    assertComponent(c);
    const text = c.render(80).join("\n");
    expect(text).toContain("7 chunks");
    expect(text).toMatch(/http:\/\/a|a source|2 source/);
    expect(text).not.toContain("🕸");
    expect(text).not.toMatch(/\{|"sources"/);
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
      mkCtx({ action: "wait" }),
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

describe("exec: full command shown above the output, not on the call line", () => {
  const ith = { fg: (_t: string, s: string) => s, bold: (s: string) => s, italic: (s: string) => s };
  const call = (args: any) => renderSpiderCall(args, ith, {}).render(200).join("\n");
  const body = (args: any, details: any, expanded: boolean) =>
    renderSpiderResult(mkResult(details), { expanded } as any, theme, mkCtx(args)).render(200).join("\n");

  it("keeps the command OFF the call header line (just the verb)", () => {
    expect(call({ action: "exec", language: "shell", code: "echo hi; seq 1 20" })).not.toContain("echo hi");
    expect(call({ action: "exec_file", path: "packages/x/y.ts", code: "x" })).not.toContain("packages/x/y.ts");
    expect(call({ action: "batch", commands: [{ code: "echo one" }, { code: "echo two" }] })).not.toContain("echo one");
  });

  it("exec shows the full command above the output, collapsed to the first line + a ctrl+o hint", () => {
    const out = body({ action: "exec", code: "cd /x\nnpm test\necho done" }, { stdout: "ok\n", exitCode: 0 }, false);
    expect(out).toContain("cd /x");
    expect(out).not.toContain("echo done"); // collapsed
    expect(out).toMatch(/ctrl\+o/);
  });

  it("ctrl+o expands the full command (all lines)", () => {
    const out = body({ action: "exec", code: "cd /x\nnpm test\necho done" }, { stdout: "ok\n", exitCode: 0 }, true);
    expect(out).toContain("cd /x");
    expect(out).toContain("npm test");
    expect(out).toContain("echo done");
  });

  it("exec_file shows the path and batch shows command labels in the body", () => {
    expect(body({ action: "exec_file", path: "packages/x/y.ts", code: "x" }, { stdout: "", exitCode: 0 }, false)).toContain("packages/x/y.ts");
    const b = body({ action: "batch", commands: [{ label: "one", code: "echo one" }, { label: "two", code: "echo two" }] }, [{ stdout: "", exitCode: 0 }], true);
    expect(b).toContain("one");
    expect(b).toContain("two");
  });
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

describe("renderCommandOutput (slash-command transcript message)", () => {
  const th = { fg: (_t: string, s: string) => s, bold: (s: string) => s, italic: (s: string) => `«${s}»`, bg: (tok: string, s: string) => `[${tok}]${s}` };
  it("renders themed through the tool renderers (doctor): spider header + tool shell + checks, no raw JSON", () => {
    const msg = { customType: "spider.command", content: "spider doctor", details: { args: { action: "control", command: "doctor" }, result: { ok: true, lines: ["## spider doctor", "- better-sqlite3: loaded (wal)"] } } };
    const out = (renderCommandOutput(msg, { expanded: false }, th).render(120) as string[]).join("\n");
    expect(out).toContain("spider");            // renderSpiderCall header
    expect(out).toContain("doctor");            // command in the header
    expect(out).toContain("better-sqlite3: loaded"); // themed doctor body (via renderSpiderResult)
    expect(out).toContain("[toolSuccessBg]");   // painted in the tool-success shell
    expect(out).not.toMatch(/\{\s*"/);          // no raw JSON
  });
});

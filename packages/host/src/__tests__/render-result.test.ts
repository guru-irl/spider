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

  it("control doctor does not invent success when ok evidence is absent (C-LOW)", () => {
    const c = renderSpiderResult(mkResult({ lines: [] }), opts, theme, mkCtx({ action: "control", command: "doctor" }));
    assertComponent(c);
    const out = c.render(80).join("\n");
    expect(out).toContain("○");
    expect(out).toContain("check status unknown");
    expect(out).not.toContain("all checks passed");
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

  it("control memory status → active-memory list with identifiers (no raw JSON)", () => {
    const details = { entries: [{ uuid: "memory-to-review", category: "preference", content: "tabs over spaces" }], usage: 1234 };
    const c = renderSpiderResult(mkResult(details), opts, theme, mkCtx({ action: "control", command: "memory", sub: "status" }));
    assertComponent(c);
    const out = c.render(80).join("\n");
    expect(out).toMatch(/1 active · 1234/);
    expect(out).toContain("preference");
    expect(out).toContain("tabs over spaces");
    expect(out).toContain("memory-to-review");
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

describe("exec: command shown on the call, output on the result", () => {
  const ith = { fg: (_t: string, s: string) => s, bold: (s: string) => s, italic: (s: string) => s };
  const call = (args: any) => renderSpiderCall(args, ith, {}).render(200).join("\n");
  const body = (args: any, details: any, expanded: boolean) =>
    renderSpiderResult(mkResult(details), { expanded } as any, theme, mkCtx(args)).render(200).join("\n");

  // Reversed deliberately. The call renders when the tool is INVOKED, the result only when
  // the command EXITS — so keeping the command off the call made a long-running command
  // show as a bare "spider · exec" with no indication of what was running.
  it("puts the command ON the call, so it is visible while the command runs", () => {
    expect(call({ action: "exec", language: "shell", code: "echo hi; seq 1 20" })).toContain("echo hi");
    expect(call({ action: "exec_file", path: "packages/x/y.ts", code: "x" })).toContain("packages/x/y.ts");
    expect(call({ action: "batch", commands: [{ code: "echo one" }, { code: "echo two" }] })).toContain("echo one");
  });

  it("collapsed result carries the OUTPUT only — the call header already showed the command", () => {
    const out = body({ action: "exec", code: "cd /x\nnpm test\necho done" }, { stdout: "ok\n", exitCode: 0 }, false);
    expect(out).toContain("ok");
    // Mutation this catches: re-add the collapsed command block -> duplicates the call header.
    expect(out).not.toContain("cd /x");
    expect(out).not.toContain("echo done");
  });

  it("ctrl+o expands the full command (all lines)", () => {
    const out = body({ action: "exec", code: "cd /x\nnpm test\necho done" }, { stdout: "ok\n", exitCode: 0 }, true);
    expect(out).toContain("cd /x");
    expect(out).toContain("npm test");
    expect(out).toContain("echo done");
  });

  it("exec_file path and batch labels appear when expanded", () => {
    expect(body({ action: "exec_file", path: "packages/x/y.ts", code: "x" }, { stdout: "", exitCode: 0 }, true)).toContain("packages/x/y.ts");
    const b = body({ action: "batch", commands: [{ label: "one", code: "echo one" }, { label: "two", code: "echo two" }] }, [{ stdout: "", exitCode: 0 }], true);
    expect(b).toContain("one");
    expect(b).toContain("two");
  });

  it("a genuinely null exitCode with NO backgrounded/backgroundJob (e.g. a resolved spawn-error, not a still-running detach) never renders as exit 0 / success either (M1)", () => {
    const out = body({ action: "exec", language: "shell", code: "/no/such/binary" }, { stdout: "", stderr: "spawn error", exitCode: null, timedOut: false }, false);
    expect(out).not.toMatch(/exit 0/);
    expect(out).not.toContain("✓");
  });

  it("a detached (backgrounded, exitCode:null) result never renders as exit 0 / success — it renders as detached/exit unknown", () => {
    const details = {
      stdout: "partial output so far\n", stderr: "", exitCode: null, timedOut: true, backgrounded: true,
      pid: 23161,
      backgroundJob: {
        id: "20260916T112055Z-a1b2c3d4",
        dir: "/p/.spider/scratch/bg/20260916T112055Z-a1b2c3d4",
        manifest: "/p/.spider/scratch/bg/20260916T112055Z-a1b2c3d4/job.json",
        receipt: "/p/.spider/scratch/bg/20260916T112055Z-a1b2c3d4/exit.json",
        logs: { stdout: "/p/.../stdout.log", stderr: "/p/.../stderr.log" },
      },
    };
    const out = body({ action: "exec", language: "shell", code: "npm run build" }, details, false);
    expect(out).not.toMatch(/exit 0/);
    expect(out).not.toContain("✓");
    expect(out).toMatch(/detached/i);
    expect(out).toMatch(/exit unknown|not known/i);
    expect(out).toContain("exit.json");
  });

  it("I-3: a verified-finished command with retained descendants renders the REAL exit code plus a retention disclosure, never the detached/unknown wording (`backgrounded` no longer overloaded)", () => {
    const details = {
      stdout: "PARENT_DONE\n", stderr: "", exitCode: 0, timedOut: false,
      retained: true, retainedReason: "process group may still have live members",
      backgroundJob: {
        id: "20260916T112055Z-a1b2c3d4",
        dir: "/p/.spider/scratch/bg/20260916T112055Z-a1b2c3d4",
        manifest: "/p/.spider/scratch/bg/20260916T112055Z-a1b2c3d4/job.json",
        receipt: "/p/.spider/scratch/bg/20260916T112055Z-a1b2c3d4/exit.json",
        logs: { stdout: "/p/.../stdout.log", stderr: "/p/.../stderr.log" },
      },
    };
    const out = body({ action: "exec", language: "shell", code: "(loop) & echo PARENT_DONE" }, details, false);
    expect(out).toContain("✓");
    expect(out).toMatch(/exit 0/);
    expect(out).not.toMatch(/detached/i);
    expect(out).not.toMatch(/exit unknown/i);
    expect(out).toMatch(/retained/i);
  });

  it("m-3: a retained result whose exitCode field is entirely ABSENT (not explicitly null — an executor-unreachable edge case) must never be coerced into a fabricated 'exit 0'", () => {
    const details: any = {
      stdout: "", stderr: "", timedOut: false,
      retained: true, retainedReason: "process group may still have live members",
      backgroundJob: {
        id: "20260916T112055Z-a1b2c3d4", dir: "/p/.spider/scratch/bg/20260916T112055Z-a1b2c3d4",
        manifest: "/p/.spider/scratch/bg/20260916T112055Z-a1b2c3d4/job.json",
        receipt: "/p/.spider/scratch/bg/20260916T112055Z-a1b2c3d4/exit.json",
        logs: { stdout: "/p/.../stdout.log", stderr: "/p/.../stderr.log" },
      },
    };
    // deliberately no `exitCode` key at all on `details`
    const out = body({ action: "exec", language: "shell", code: "x" }, details, false);
    expect(out).not.toMatch(/✓/);
    expect(out).not.toMatch(/exit 0\b/);
  });

  it("M-c: a genuinely unknown batch outcome (a null exitCode among the batch entries) never gets laundered into a fabricated definite failure (exit 1) — it renders as unknown", () => {
    const out = body(
      { action: "batch", commands: [{ code: "echo a" }, { code: "echo b" }] },
      [{ stdout: "a", exitCode: 0 }, { stdout: "", exitCode: null }],
      false,
    );
    expect(out).not.toMatch(/exit 1\b/);
    expect(out).toMatch(/unknown/i);
  });

  it("M-c: a batch outcome with a REAL nonzero failure still renders as a genuine failure (exit 1 preserved, not laundered into unknown)", () => {
    const out = body(
      { action: "batch", commands: [{ code: "echo a" }, { code: "false" }] },
      [{ stdout: "a", exitCode: 0 }, { stdout: "", exitCode: 1 }],
      false,
    );
    expect(out).toMatch(/exit 1\b/);
    expect(out).not.toMatch(/unknown/i);
  });

  it("F-1: a batch entry that died by signal is a KNOWN failure — never laundered into 'exit unknown', and the signal is named", () => {
    const out = body(
      { action: "batch", commands: [{ code: "echo a" }, { code: "kill -TERM $$" }] },
      [{ stdout: "a", exitCode: 0, outcome: "exited" }, { stdout: "", exitCode: null, outcome: "signal", signal: "SIGTERM" }],
      false,
    );
    expect(out).toContain("✗");
    expect(out).toMatch(/signal/i);
    expect(out).not.toMatch(/exit unknown/i);
  });

  it("F-1: a batch entry that failed to spawn is a KNOWN failure, named 'spawn error', never 'exit unknown'", () => {
    const out = body(
      { action: "batch", commands: [{ code: "echo a" }, { code: "/no/such/binary" }] },
      [{ stdout: "a", exitCode: 0, outcome: "exited" }, { stdout: "", exitCode: null, outcome: "spawn-error" }],
      false,
    );
    expect(out).toContain("✗");
    expect(out).toMatch(/spawn error/i);
    expect(out).not.toMatch(/exit unknown/i);
  });

  it("F-1 control: a genuinely unknown entry (outcome:'unknown', no signal/spawn-error anywhere in the batch) still renders neutrally, never a fabricated failure", () => {
    const out = body(
      { action: "batch", commands: [{ code: "echo a" }, { code: "b" }] },
      [{ stdout: "a", exitCode: 0, outcome: "exited" }, { stdout: "", exitCode: null, outcome: "unknown" }],
      false,
    );
    expect(out).not.toContain("✗");
    expect(out).toMatch(/unknown/i);
  });

  it("F-1 mixed: a signal death AND a genuinely-unknown entry in the same batch disclose BOTH — fail+signal named, plus the unknown fact — never collapsed to one", () => {
    const out = body(
      { action: "batch", commands: [{ code: "a" }, { code: "b" }, { code: "c" }] },
      [
        { stdout: "", exitCode: null, outcome: "signal", signal: "SIGKILL" },
        { stdout: "", exitCode: null, outcome: "unknown" },
        { stdout: "a", exitCode: 0, outcome: "exited" },
      ],
      false,
    );
    expect(out).toContain("✗");
    expect(out).toMatch(/signal/i);
    expect(out).toMatch(/unknown/i);
  });

  it("F-1: single-result signal-death path is unaffected by the batch aggregation fix", () => {
    const out = body(
      { action: "exec", language: "shell", code: "kill -TERM $$" },
      { stdout: "", stderr: "", exitCode: null, outcome: "signal", signal: "SIGTERM" },
      false,
    );
    expect(out).toContain("✗");
    expect(out).toMatch(/signal/i);
  });

  // C-truthfulness.md H2 (also branch-review C-H2): the batch status line must never
  // fabricate an exit code no command in the batch produced, and must name every distinct
  // failure kind present — not just the first. Mirrors C-probe's P1/P2/P3e exactly.
  it("H-2: a numeric failure + a signal death in the SAME batch never fabricates 'exit 1' and names BOTH real failures", () => {
    const out = body(
      { action: "batch", commands: [{ code: "exit 2" }, { code: "kill -KILL $$" }] },
      [{ stdout: "x", exitCode: 2, outcome: "exited" }, { stdout: "", exitCode: null, outcome: "signal", signal: "SIGKILL" }],
      false,
    );
    expect(out).not.toMatch(/exit 1 /); // the old bug: fabricated "exit 1" (neither entry exited 1)
    expect(out).toMatch(/exit 2/);       // the REAL numeric failure
    expect(out).toMatch(/signal SIGKILL/); // AND the signal death — not silently dropped
  });

  it("H-2: a SINGLE-command batch that exits 127 forwards its OWN real code — no aggregation excuse for fabricating 'exit 1'", () => {
    const out = body(
      { action: "batch", commands: [{ code: "exit 127" }] },
      [{ stdout: "", exitCode: 127, outcome: "exited" }],
      false,
    );
    expect(out).toMatch(/exit 127\b/);
    expect(out).not.toMatch(/exit 1 /);
  });

  it("H-2: two DIFFERENT signal deaths in the same batch are BOTH named — not just the first", () => {
    const out = body(
      { action: "batch", commands: [{ code: "a" }, { code: "b" }] },
      [{ stdout: "", exitCode: null, outcome: "signal", signal: "SIGSEGV" }, { stdout: "", exitCode: null, outcome: "signal", signal: "SIGKILL" }],
      false,
    );
    expect(out).toMatch(/SIGSEGV/);
    expect(out).toMatch(/SIGKILL/);
  });

  it("H-2: multiple entries that all exit with the SAME real numeric code still honestly report that shared code (not null, not a different fabricated one)", () => {
    const out = body(
      { action: "batch", commands: [{ code: "exit 3" }, { code: "exit 3" }] },
      [{ stdout: "", exitCode: 3, outcome: "exited" }, { stdout: "", exitCode: 3, outcome: "exited" }],
      false,
    );
    expect(out).toMatch(/exit 3\b/);
  });

  // A-H1 (branch-review A-architecture.md): render-result.ts's OWN batch classification of
  // "known failure outcome" omitted `aborted`, diverging from runExec's set (signal |
  // spawn-error | aborted). Single-sourced against `@spider/context`'s `isKnownFailureOutcome`.
  it("A-H1: an ABORTED batch entry alongside a different failure kind is named 'aborted', not reduced to a bare exit code (matches runExec's own known-outcome set)", () => {
    const out = body(
      { action: "batch", commands: [{ code: "a" }, { code: "b" }] },
      [{ stdout: "", exitCode: 137, outcome: "aborted" }, { stdout: "", exitCode: null, outcome: "signal", signal: "SIGKILL" }],
      false,
    );
    expect(out).toMatch(/aborted/i);
    expect(out).toMatch(/signal SIGKILL/);
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
  it("does not invent done/success when status evidence is absent (C-LOW)", () => {
    const { status: _status, ...withoutStatus } = msg.details;
    const out = renderSubagentDone({ ...msg, details: withoutStatus }, { expanded: false }, th).render(200).join("\n");
    expect(out).toContain("unknown");
    expect(out).toContain("[toolPendingBg]");
    expect(out).not.toContain("[toolSuccessBg]");
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

// The call header is what the user sees WHILE the command runs; the result only
// arrives after it finishes. Putting the command in the result body meant a long
// command showed as a bare "spider · exec" spinner with no indication of what was
// running. The command belongs on the call.
describe("renderSpiderCall shows the command while it runs", () => {
  it("exec → the call header carries the command text", () => {
    const c = renderSpiderCall({ action: "exec", language: "shell", code: "npm run build" }, theme, {});
    assertComponent(c);
    const text = c.render(80).join("\n");
    // Mutation this catches: revert renderCall to the bare verb -> fails.
    expect(text).toContain("npm run build");
  });

  it("exec_file → the call header carries the path", () => {
    const c = renderSpiderCall({ action: "exec_file", path: "scripts/migrate.ts" }, theme, {});
    const text = c.render(80).join("\n");
    expect(text).toContain("scripts/migrate.ts");
  });

  it("batch → the call header lists the commands", () => {
    const c = renderSpiderCall({ action: "batch", commands: [
      { language: "shell", code: "npm test" },
      { language: "shell", code: "npm run lint" },
    ] }, theme, {});
    const text = c.render(80).join("\n");
    expect(text).toContain("npm test");
    expect(text).toContain("npm run lint");
  });

  it("multi-line code → shows the first line, notes the rest, never floods the header", () => {
    const code = ["set -e", "npm ci", "npm run build", "npm test"].join("\n");
    const c = renderSpiderCall({ action: "exec", language: "shell", code }, theme, {});
    const lines = c.render(80);
    expect(lines.join("\n")).toContain("set -e");
    expect(lines.length).toBeLessThanOrEqual(4);
  });

  it("non-exec actions keep the bare verb (no regression)", () => {
    const c = renderSpiderCall({ action: "remember", content: "x" }, theme, {});
    const text = c.render(80).join("\n");
    expect(text).toContain("remember");
  });
});

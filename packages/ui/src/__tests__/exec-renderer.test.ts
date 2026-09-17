import { describe, it, expect } from "vitest";
import { renderExecCall, renderExecResult } from "../renderers/exec.js";
import type { ThemeAdapter } from "../agents/types.js";
import { visibleWidth } from "@earendil-works/pi-tui";

const id: ThemeAdapter = { fg: (_t, s) => s, bg: (_t, s) => s, bold: (s) => s, glyph: "🕸" };

describe("exec renderer", () => {
  it("call-header variant shows a command block and +N more when over the cap", () => {
    const cmds = Array.from({ length: 14 }, (_, i) => `cmd${i}`);
    const lines = renderExecCall({ kind: "batch", commands: cmds }, { theme: id, width: 40 });
    expect(lines.join("\n")).toContain("cmd0");
    expect(lines.join("\n")).toMatch(/more/);
    for (const l of lines) expect(visibleWidth(l)).toBeLessThanOrEqual(40);
  });
  it("result body carries ✓/exit/lines and the indexed note — but NOT a repeated 🕸 spider header", () => {
    const lines = renderExecResult({
      kind: "exec", commands: ["ls"], ok: true, exitCode: 0, outLines: 12, ms: 34,
      preview: ["a", "b", "c"], indexed: { source: "shell:ls", chunks: 2 },
    }, { theme: id, width: 60, expanded: true });
    const text = lines.join("\n");
    expect(text).not.toMatch(/spider exec/); // no duplicated header — call line already shows it
    expect(text).toContain("✓");
    expect(text).toMatch(/exit 0/);
    expect(text).toMatch(/12 lines/);
    expect(text).toMatch(/shell:ls|2 chunks/);
    for (const l of lines) expect(visibleWidth(l)).toBeLessThanOrEqual(60);
  });
  it("collapsed preview shows one line + more-indicator and the ✗ fail path", () => {
    const lines = renderExecResult({
      kind: "exec", commands: ["ls"], ok: false, exitCode: 1, outLines: 5, preview: ["x", "y", "z"],
    }, { theme: id, width: 40, expanded: false });
    const text = lines.join("\n");
    expect(text).toContain("✗");
    expect(text).toMatch(/more/);
  });

  it("collapsed shows output only; ctrl+o reveals the whole command", () => {
    const d = { kind: "exec" as const, commands: ["cd /x\nnpm test\necho done"], ok: true, exitCode: 0, outLines: 1, preview: ["ok"] };
    const collapsed = renderExecResult(d, { theme: id, width: 60, expanded: false }).join("\n");
    // The call header owns the command now; repeating it collapsed duplicated it line for line.
    expect(collapsed).not.toContain("cd /x");
    expect(collapsed).not.toContain("echo done");
    expect(collapsed).toContain("ok");
    const expanded = renderExecResult(d, { theme: id, width: 60, expanded: true }).join("\n");
    expect(expanded).toContain("cd /x");
    expect(expanded).toContain("npm test");
    expect(expanded).toContain("echo done");
  });

  it("a detached result never renders exit 0 / ✓ — it shows detached/exit unknown plus the log and receipt paths", () => {
    const lines = renderExecResult({
      kind: "exec", commands: ["npm run build"], ok: false, exitCode: null, outLines: 3,
      preview: ["line a", "line b", "line c"],
      detached: { pid: 23161, jobId: "20260916T112055Z-a1b2c3d4", jobDir: "/p/.spider/scratch/bg/20260916T112055Z-a1b2c3d4", receipt: "/p/.spider/scratch/bg/20260916T112055Z-a1b2c3d4/exit.json" },
    }, { theme: id, width: 80, expanded: false });
    const text = lines.join("\n");
    expect(text).not.toMatch(/exit 0/);
    expect(text).not.toContain("✓");
    expect(text).toMatch(/detached/i);
    expect(text).toMatch(/exit unknown/i);
    expect(text).toContain("23161");
    expect(text).toContain("exit.json");
    for (const l of lines) expect(visibleWidth(l)).toBeLessThanOrEqual(80);
  });

  it("the running (isPartial) branch is unaffected by the new detached branch", () => {
    const lines = renderExecResult({
      kind: "exec", commands: ["npm run build"], ok: true, exitCode: 0, outLines: 1, preview: ["still going"], running: true,
    }, { theme: id, width: 60, expanded: false });
    const text = lines.join("\n");
    expect(text).toMatch(/running/);
    expect(text).not.toMatch(/detached/i);
  });

  it("I-3: a verified-finished-but-retained result shows the REAL exit code plus a distinct retention disclosure — never the detached/exit-unknown wording", () => {
    const lines = renderExecResult({
      kind: "exec", commands: ["echo x"], ok: true, exitCode: 0, outLines: 1, preview: ["x"],
      retained: { jobDir: "/p/.spider/scratch/bg/20260916T112055Z-a1b2c3d4", reason: "process group may still have live members" },
    }, { theme: id, width: 80, expanded: false });
    const text = lines.join("\n");
    expect(text).toContain("✓");
    expect(text).toMatch(/exit 0/);
    expect(text).not.toMatch(/detached/i);
    expect(text).not.toMatch(/exit unknown/i);
    expect(text).toMatch(/retained/i);
    expect(text).toContain("/p/.spider/scratch/bg/20260916T112055Z-a1b2c3d4");
    for (const l of lines) expect(visibleWidth(l)).toBeLessThanOrEqual(80);
  });

  it("M-c: a genuinely unknown exit code (not `detached`, e.g. a resolved batch entry) renders as neutral UNKNOWN, never as a failure (✗)", () => {
    const lines = renderExecResult({
      kind: "batch", commands: ["a", "b"], ok: false, exitCode: null, outLines: 2, preview: ["out-a"],
    }, { theme: id, width: 60, expanded: false });
    const text = lines.join("\n");
    expect(text).not.toContain("✗");
    expect(text).toMatch(/unknown/i);
  });

  it("F-1: a batch aggregate carrying `outcome:'signal'` (propagated by the host's toExecDetails from a batch entry that died by signal) renders as a real failure naming the signal, never neutral 'exit unknown'", () => {
    const lines = renderExecResult({
      kind: "batch", commands: ["a", "b"], ok: false, exitCode: null, outcome: "signal", signal: "SIGKILL",
      outLines: 1, preview: ["a"],
    }, { theme: id, width: 60, expanded: false });
    const text = lines.join("\n");
    expect(text).toContain("✗");
    expect(text).toMatch(/signal SIGKILL/i);
    expect(text).not.toMatch(/exit unknown/i);
  });

  it("F-1: a batch aggregate with a known signal failure PLUS an unknownCount discloses BOTH facts, not just the named failure", () => {
    const lines = renderExecResult({
      kind: "batch", commands: ["a", "b", "c"], ok: false, exitCode: null, outcome: "signal", signal: "SIGTERM",
      unknownCount: 1, outLines: 0, preview: [],
    }, { theme: id, width: 60, expanded: false });
    const text = lines.join("\n");
    expect(text).toContain("✗");
    expect(text).toMatch(/signal SIGTERM/i);
    expect(text).toMatch(/1 unknown/i);
  });

  // C-H2 / C-truthfulness.md H2: a batch with MORE THAN ONE distinct failure kind has no
  // single exitCode/outcome/signal that honestly represents it. `failures` (new, host-
  // produced) lists every one; the renderer must name ALL of them, never just the first,
  // and must NEVER fall back to a fabricated numeric exit code for this shape.
  it("H-2: a `failures` list with more than one distinct kind names EVERY one of them, not just the first", () => {
    const lines = renderExecResult({
      kind: "batch", commands: ["a", "b"], ok: false, exitCode: null,
      failures: ["exit 2", "signal SIGKILL"], outLines: 1, preview: ["x"],
    }, { theme: id, width: 60, expanded: false });
    const text = lines.join("\n");
    expect(text).toContain("✗");
    expect(text).toMatch(/exit 2/);
    expect(text).toMatch(/signal SIGKILL/);
    expect(text).not.toMatch(/exit unknown/i);
  });

  it("H-2: two DIFFERENT signal deaths in the same `failures` list are BOTH named", () => {
    const lines = renderExecResult({
      kind: "batch", commands: ["a", "b"], ok: false, exitCode: null,
      failures: ["signal SIGSEGV", "signal SIGKILL"], outLines: 0, preview: [],
    }, { theme: id, width: 60, expanded: false });
    const text = lines.join("\n");
    expect(text).toMatch(/SIGSEGV/);
    expect(text).toMatch(/SIGKILL/);
  });

  it("H-2: a `failures` list also discloses unknownCount when both are present", () => {
    const lines = renderExecResult({
      kind: "batch", commands: ["a", "b", "c"], ok: false, exitCode: null,
      failures: ["exit 2", "signal SIGKILL"], unknownCount: 1, outLines: 0, preview: [],
    }, { theme: id, width: 60, expanded: false });
    const text = lines.join("\n");
    expect(text).toMatch(/exit 2/);
    expect(text).toMatch(/signal SIGKILL/);
    expect(text).toMatch(/1 unknown/i);
  });

  it("H-2: a SINGLE distinct failure kind in `failures` does not change the existing single-outcome rendering (backward compatible)", () => {
    const lines = renderExecResult({
      kind: "batch", commands: ["a", "b"], ok: false, exitCode: null, outcome: "signal", signal: "SIGTERM",
      failures: ["signal SIGTERM"], outLines: 0, preview: [],
    }, { theme: id, width: 60, expanded: false });
    const text = lines.join("\n");
    expect(text).toMatch(/signal SIGTERM/);
  });
});

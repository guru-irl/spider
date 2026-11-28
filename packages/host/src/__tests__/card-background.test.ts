import { describe, expect, it } from "vitest";
import { Box, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { renderCommandOutput, renderEscalationMessage, renderOrganismEntry, renderSpiderCall, renderSpiderResult, renderSubagentDone } from "../render-result";

const BG = "48;5;160";
const theme = {
  fg: (_token: string, text: string) => `\x1b[38;5;177m${text}\x1b[39m`,
  bg: (_token: string, text: string) => `\x1b[${BG}m${text}\x1b[49m`,
  bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
  italic: (text: string) => `\x1b[3m${text}\x1b[23m`,
};

// Model the background of each visible terminal cell, including wide glyphs.
function cells(line: string): Array<{ text: string; bg: string | undefined }> {
  let bg: string | undefined;
  const result: Array<{ text: string; bg: string | undefined }> = [];
  const parts = line.split(/(\x1b\[[0-9;]*m)/);
  for (const part of parts) {
    if (part.startsWith("\x1b[")) {
      const codes = part.slice(2, -1).split(";").map(Number);
      for (let i = 0; i < codes.length; i++) {
        if (codes[i] === 0 || codes[i] === 49) bg = undefined;
        else if (codes[i] === 48 && codes[i + 1] === 5) {
          bg = codes.slice(i, i + 3).join(";");
          i += 2;
        } else if (codes[i] === 48 && codes[i + 1] === 2) {
          bg = codes.slice(i, i + 5).join(";");
          i += 4;
        } else if ((codes[i] === 38 || codes[i] === 58) && codes[i + 1] === 5) i += 2;
        else if ((codes[i] === 38 || codes[i] === 58) && codes[i + 1] === 2) i += 4;
      }
    } else {
      for (const { segment } of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(part)) {
        for (let i = 0; i < visibleWidth(segment); i++) result.push({ text: segment, bg });
      }
    }
  }
  return result;
}

function checkCard(rows: string[], width: number, background = BG) {
  for (const row of rows) {
    expect(visibleWidth(row)).toBe(width);
    const halfEdge = /^[▄▀]+$/u.test(stripTerminalSequences(row));
    expect(cells(row).map((cell) => cell.bg)).toEqual(Array(width).fill(halfEdge ? undefined : background));
  }
}

function toolBox(action: string, args: Record<string, unknown>, details: unknown) {
  const box = new Box(1, 1, (text) => theme.bg("toolSuccessBg", text));
  box.addChild(renderSpiderCall({ action, ...args }, theme, {}) as any);
  box.addChild(renderSpiderResult({ details }, { expanded: false }, theme, { args: { action, ...args } }) as any);
  return box;
}

describe("card background through the right edge", () => {
  it.each([30, 47, 80])("paints clipped command, output and more rows at width %i", (width) => {
    const rows = toolBox("exec", { code: `echo ${"界".repeat(80)}\nline two\nline three` },
      { stdout: `${"界".repeat(100)}\nsecond\nthird`, stderr: "", exitCode: 0 }).render(width);
    expect(rows.some((row) => row.includes("…"))).toBe(true);
    expect(rows.some((row) => row.includes("more"))).toBe(true);
    checkCard(rows, width);
  });

  it.each([30, 47, 80])("keeps the background after ANSI resets in output at width %i", (width) => {
    for (const expanded of [false, true]) {
      for (const output of [`\x1b[31mred\x1b[0m short`, `\x1b[31mred\x1b[0;32m ${"wide ".repeat(60)}`]) {
        const box = new Box(1, 1, (text) => theme.bg("toolSuccessBg", text));
        box.addChild(renderSpiderResult({ details: { stdout: output, stderr: "", exitCode: 0 } }, { expanded }, theme, { args: { action: "exec", code: "run" } }) as any);
        const rows = box.render(width);
        expect(rows.some((row) => row.includes("red"))).toBe(true);
        checkCard(rows, width);
      }
    }
  });

  it.each([30, 47, 80])("restores a truecolor background after clipping at width %i", (width) => {
    const background = "48;2;22;22;24";
    const truecolor = { ...theme, bg: (_token: string, text: string) => `\x1b[${background}m${text}\x1b[49m` };
    const args = { action: "exec", code: `echo ${"x".repeat(200)}` };
    const box = new Box(1, 1, (text) => truecolor.bg("toolSuccessBg", text));
    box.addChild(renderSpiderCall(args, truecolor, { args, isPartial: false }) as any);
    const rows = box.render(width);
    expect(rows.some((row) => row.includes("…"))).toBe(true);
    checkCard(rows, width, background);
  });

  it("restores the card background when output closes its own background", () => {
    const output = "\x1b[0;48;5;4m\x1b[38;5;0mblue\x1b[49m normal";
    const rows = toolBox("exec", { code: "run" }, { stdout: output, stderr: "", exitCode: 0 }).render(47);
    const row = rows.find((line) => line.includes("blue"));
    expect(row).toBeDefined();
    const painted = cells(row!);
    const blue = painted.findIndex((cell) => cell.text === "b");
    expect(painted.slice(blue, blue + 4).map((cell) => cell.bg)).toEqual(Array(4).fill("48;5;4"));
    expect(painted.slice(blue + 4).map((cell) => cell.bg)).toEqual(Array(47 - blue - 4).fill(BG));
  });

  it("restores the actual pending, success, and error shell colours", () => {
    const backgrounds: Record<string, string> = { toolPendingBg: "48;5;160", toolSuccessBg: "48;5;161", toolErrorBg: "48;5;162" };
    const distinct = { ...theme, bg: (token: string, text: string) => `\x1b[${backgrounds[token]}m${text}\x1b[49m` };
    for (const [token, isPartial, isError] of [["toolPendingBg", true, false], ["toolSuccessBg", false, false], ["toolErrorBg", false, true]] as const) {
      const args = { action: "exec", code: `echo ${"x".repeat(100)}` };
      const context = { args, isPartial, isError };
      const box = new Box(1, 1, (text) => distinct.bg(token, text));
      box.addChild(renderSpiderCall(args, distinct, context) as any);
      box.addChild(renderSpiderResult({ details: { stdout: "\x1b[0m" + "x".repeat(100), exitCode: 0 } }, { expanded: false, isPartial }, distinct, context) as any);
      const rows = box.render(30);
      expect(rows.some((row) => row.includes("…"))).toBe(true);
      checkCard(rows, 30, backgrounds[token]);
    }
    const failed = renderCommandOutput({ details: { args: { action: "unknown" }, result: { isError: true, details: { error: "failure\x1b[0m " + "details ".repeat(20) } } } }, {}, distinct).render(30);
    expect(failed[0]).toBe(`\x1b[38;5;162m${"▄".repeat(30)}\x1b[39m`);
    expect(failed.at(-1)).toBe(`\x1b[38;5;162m${"▀".repeat(30)}\x1b[39m`);
    checkCard(failed, 30, backgrounds.toolErrorBg);
    for (const [severity, marker, token] of [
      ["blocked", "× blocked", "toolErrorBg"],
      ["question", "? question", "toolPendingBg"],
      ["warning", "▲ warning", "toolPendingBg"],
      ["unexpected", "▲ warning", "toolPendingBg"],
    ]) {
      const message = { details: { runId: "beb58fc6-193f-4247-bb38-c59612f6985d", severity, name: "tia-3", agent: "worker", summary: "short" } };
      const rows = renderEscalationMessage(message, {}, distinct).render(80);
      checkCard(rows, 80, backgrounds[token]);
      const plain = rows.map(row => stripTerminalSequences(row).trimEnd());
      expect(plain[1]).toBe("  ◆ escalation · tia-3 · worker");
      expect(plain[2]).toBe(`  ${marker} · short`);
      expect(plain.join("\n")).not.toContain("beb58fc6");
    }
    const pending = renderCommandOutput({ details: { args: { action: "message", to: "peer" }, result: { details: { delivered: false, queued: true, delivery: "queued" } } } }, {}, distinct).render(60);
    checkCard(pending, 60, backgrounds.toolPendingBg);
    const done = renderSubagentDone({ details: { status: "failed", name: "worker", output: "failure ".repeat(20) } }, {}, distinct).render(30);
    checkCard(done, 30, backgrounds.toolErrorBg);
  });

  it("keeps Nerd question notifications out of the error palette", () => {
    const colors: string[] = [];
    const themed = { ...theme, fg: (token: string, text: string) => { colors.push(token); return text; }, bg: (token: string, text: string) => token === "toolPendingBg" ? `\x1b[${BG}m${text}\x1b[49m` : `\x1b[48;5;1m${text}\x1b[49m` };
    const message = { details: { severity: "question", name: "tia-3", agent: "worker", summary: "short" } };
    const rows = renderEscalationMessage(message, {}, themed, "nerd").render(80);
    checkCard(rows, 80);
    expect(rows.map(stripTerminalSequences).join("\n")).toContain("\u{F02D6}  question");
    expect(colors).toContain("warning");
    expect(colors).not.toContain("error");
  });

  it.each([0, 3])("uses Pi's notification padding of %i", (outputPad) => {
    const options = { outputPad };
    const renderers = [
      renderCommandOutput({ details: { args: { action: "control", command: "doctor" }, result: { ok: true } } }, options, theme),
      renderSubagentDone({ details: { status: "done", name: "worker" } }, options, theme),
      renderOrganismEntry(undefined, options, theme),
      renderEscalationMessage({ details: { runId: "example-run", severity: "warning", summary: "Review the changes" } }, options, theme),
    ];
    for (const component of renderers) {
      const rows = component.render(60);
      checkCard(rows, 60);
      const firstText = rows.slice(1, -1).map(stripTerminalSequences).find(line => line.trim())!;
      expect(firstText.match(/^ */)?.[0].length).toBe(outputPad + 1);
    }
  });

  it.each([30, 47, 80])("wraps notice bodies fully in both modes at width %i", (width) => {
    const summary = "The deployment needs a careful decision before the next step can safely proceed.\nPlease confirm the target and record the reason for the change.";
    for (const expanded of [false, true]) {
      const rows = renderEscalationMessage({ details: { runId: "identifier-" + "x".repeat(100), severity: "warning", name: "worker-" + "n".repeat(100), summary } }, { expanded }, theme).render(width);
      checkCard(rows, width);
      const text = rows.map((row) => stripTerminalSequences(row).trim());
      expect(text[2]).toMatch(/^▲ warning · /u);
      const body = text.slice(2, -1).join(" ").replace(/^▲ warning · /u, "");
      expect(body.replace(/\s+/gu, " ").trim()).toBe(summary.replace(/\s+/gu, " "));
      expect(text.join("\n")).not.toContain("identifier-");
    }
  });

  it.each([30, 47, 80])("retains wide characters in a long notice word at width %i", (width) => {
    const summary = "界🙂".repeat(80);
    const rows = renderEscalationMessage({ details: { runId: "id", severity: "question", name: "worker", summary } }, {}, theme).render(width);
    checkCard(rows, width);
    const visible = rows.map((row) => row.replace(/\x1b\[[0-9;]*m/g, "").trim());
    const body = visible.slice(2, -1).join("").replace(/^\? question · /u, "");
    expect(body).toBe(summary);
  });

  it.each([30, 47, 80])("paints run, search, and organism cards at width %i", (width) => {
    const run = toolBox("run", {}, { run: { status: "done", name: "worker", task: "long ".repeat(80), result: "output ".repeat(80) } }).render(width);
    const search = toolBox("search", {}, [{ title: "title ".repeat(80), kind: "content", snippet: "snippet ".repeat(80) }]).render(width);
    const report = { status: "partial", memoryStaged: 0, skillsStaged: 0, todosAdded: 0, errors: [{ phase: "store", message: "error ".repeat(80) }], modelCalls: 0, reason: "done", startedAt: 0, finishedAt: 1 };
    const organism = renderOrganismEntry({ data: report }, {}, theme).render(width);
    for (const rows of [run, search, organism]) {
      expect(rows.some((row) => row.includes("…"))).toBe(true);
      checkCard(rows, width);
    }
  });

  it.each([30, 47, 80])("paints clipped message and notice cards at width %i", (width) => {
    const message = toolBox("message", { to: "peer", message: "word ".repeat(80) }, { delivered: true }).render(width);
    const done = renderSubagentDone({ details: { status: "done", name: "worker", output: "word ".repeat(80) } }, {}, theme).render(width);
    const notice = renderEscalationMessage({ details: { runId: "identifier", severity: "warning", name: "n".repeat(100), summary: "short" } }, {}, theme).render(width);
    const command = renderCommandOutput({ details: { args: { action: "message", to: "peer", message: "word ".repeat(80) }, result: { details: { delivered: true } } } }, {}, theme).render(width);
    for (const rows of [message, done, notice, command]) checkCard(rows, width);
  });
});

import { describe, expect, it } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import { icon, type IconRole } from "../icons.js";
import { formatAgentLine } from "../agents/footer.js";
import { card, fitResultLines, statusIcon } from "../renderers/types.js";
import { renderKillResult } from "../renderers/kill.js";
import { renderIndexResult } from "../renderers/index-fetch.js";
import { renderInsights } from "../screens/insights-view.js";
import { renderMessageResult } from "../renderers/message.js";
import { renderExecCall, renderExecResult } from "../renderers/exec.js";
import { renderGridCell } from "../agents/grid-cell.js";
import { AgentDetail } from "../agents/agent-detail.js";
import { applyEvent } from "../agents/store.js";
import { Spinner } from "../components/spinner.js";
import { renderModels } from "../screens/models-view.js";
import { renderConfig } from "../screens/config-view.js";
import type { AgentSnapshot, ThemeAdapter } from "../agents/types.js";

const theme = (iconStyle: "text" | "nerd"): ThemeAdapter & { iconStyle: "text" | "nerd" } => ({
  fg: (_token, text) => text, bg: (_token, text) => text, bold: text => text, glyph: "🕸", iconStyle,
});
const agent: AgentSnapshot = {
  runId: "one", name: "scribe", agent: "worker", status: "running",
  stepCount: 1, tokenCount: 0, recentActivity: [],
};

describe("icon styles in rendered rows", () => {
  it.each(["text", "nerd"] as const)("keeps copy and copied icons equally wide in %s style", style => {
    expect(() => icon(style, "copied")).not.toThrow();
    const copied = icon(style, "copied");
    expect(visibleWidth(copied)).toBe(visibleWidth(icon(style, "copy")));
    expect(copied).toBe(style === "text" ? "✓" : "\u{F012C}");
  });

  it("returns each role's specified text and Nerd Font glyph with equal cell widths", () => {
    const roles: [IconRole, string, string][] = [
      ["agent", "\u{1F916}", "\u{F167A} "], ["spider", "\u{1F578}\uFE0F", "\u{F0BCA} "], ["warning", "\u26A0\uFE0F", "\u{F002A} "], ["failure", "\u274C", "\u{F0156} "],
      ["gutter", "⎿", "\u{F060D}"], ["task", "↳", "\u{F060D}"], ["result", "⤴", "\u{F005C}"],
      ["message", "✉", "\u{F01F0}"], ["reply", "↩", "\u{F0F20}"], ["broadcast", "⇉", "\u{F0B23}"],
      ["handoff", "⇢", "\u{F19B0}"], ["pin", "📌", "\u{F0931} "], ["modelDefault", "⟵", "\u{F004D}"],
      ["copy", "⧉", "\u{F018F}"],
    ];
    for (const [role, text, nerd] of roles) {
      expect(icon(undefined, role)).toBe(text);
      expect(icon("text", role)).toBe(text);
      expect(icon("nerd", role)).toBe(nerd);
      expect(visibleWidth(nerd)).toBe(visibleWidth(text));
    }
  });
  it("preserves a custom agent glyph on an adapter with no icon style", () => {
    const custom: ThemeAdapter = { ...theme("text"), glyph: "◆", iconStyle: undefined };
    expect(formatAgentLine(custom, agent, 100, 0, "○")).toContain("○ ◆ scribe");
    const opts = { agent, width: 100, height: 2, focused: false, pinned: false, now: 0, spinner: new Spinner() };
    expect(renderGridCell(custom, opts)[0]).toContain("◆ scribe");
  });

  it("keeps the agent marker and its following spaces aligned", () => {
    const text = formatAgentLine(theme("text"), agent, 100, 0, "◆");
    const nerd = formatAgentLine(theme("nerd"), agent, 100, 0, "◆");
    expect(text).toContain("◆ \u{1F916} scribe");
    expect(nerd).toContain("◆ \u{F167A}  scribe");
    expect(visibleWidth(nerd)).toBe(visibleWidth(text));
  });

  it("renders warning and failure icons without changing their width", () => {
    expect(statusIcon(theme("text"), "warn")).toBe("\u26A0\uFE0F");
    expect(statusIcon(theme("nerd"), "warn")).toBe("\u{F002A} ");
    expect(statusIcon(theme("text"), "fail")).toBe("\u274C");
    expect(statusIcon(theme("nerd"), "fail")).toBe("\u{F0156} ");
    expect(visibleWidth(statusIcon(theme("nerd"), "warn"))).toBe(visibleWidth("\u26A0\uFE0F"));
  });

  it("uses the spider icon in cards and preserves their width", () => {
    const text = card(theme("text"), "Agents", [], 40)[0];
    const nerd = card(theme("nerd"), "Agents", [], 40)[0];
    expect(text).toContain("\u{1F578}\uFE0F Agents");
    expect(nerd).toContain("\u{F0BCA}  Agents");
    expect(nerd).not.toContain("\u{F167A}");
    expect(visibleWidth(nerd)).toBe(visibleWidth(text));
  });

  it("heads spider tool calls with the spider icon, keeping the robot for subagent rows", () => {
    const call = { kind: "exec" as const, commands: ["echo"] };
    const text = renderExecCall(call, { theme: theme("text"), width: 80 });
    const nerd = renderExecCall(call, { theme: theme("nerd"), width: 80 });
    expect(text[0]).toMatch(/^\u{1F578}\u{FE0F} spider exec/u);
    expect(nerd[0]).toMatch(/^\u{F0BCA}  spider exec/u);
    expect(nerd.map(visibleWidth)).toEqual(text.map(visibleWidth));
    expect(formatAgentLine(theme("nerd"), agent, 100, 0, "◆")).toContain("◆ \u{F167A}  scribe");
  });

  it("keeps message warning and output gutter aligned", () => {
    const details = { verb: "send" as const, to: "worker", body: "hello", delivered: false, delivery: "queued" as const };
    const text = renderMessageResult(details, { theme: theme("text"), width: 100 });
    const nerd = renderMessageResult(details, { theme: theme("nerd"), width: 100 });
    expect(text.join("\n")).toContain("\u26A0\uFE0F → worker");
    expect(nerd.join("\n")).toContain("\u{F002A}  → worker");
    expect(text.join("\n")).toContain("⎿ hello");
    expect(nerd.join("\n")).toContain("\u{F060D} hello");
    expect(nerd.map(visibleWidth)).toEqual(text.map(visibleWidth));
  });

  it("renders reply and broadcast markers with the same widths", () => {
    for (const [verb, textIcon, nerdIcon] of [["reply", "↩", "\u{F0F20}"], ["broadcast", "⇉", "\u{F0B23}"]] as const) {
      const details = { verb, to: "worker", body: "", delivered: true };
      const text = renderMessageResult(details, { theme: theme("text"), width: 100 });
      const nerd = renderMessageResult(details, { theme: theme("nerd"), width: 100 });
      expect(text.join("\n")).toContain(`${textIcon} worker`);
      expect(nerd.join("\n")).toContain(`${nerdIcon} worker`);
      expect(nerd.map(visibleWidth)).toEqual(text.map(visibleWidth));
    }
  });

  it("keeps pinned agent rows aligned and replaces task and failure markers", () => {
    const opts = { agent: { ...agent, status: "failed" as const, task: "read files" }, width: 100, height: 3,
      focused: false, pinned: true, now: 0, spinner: new Spinner() };
    const text = renderGridCell(theme("text"), opts);
    const nerd = renderGridCell(theme("nerd"), opts);
    expect(text[0]).toContain("\u274C \u{1F916} scribe 📌");
    expect(nerd[0]).toContain("\u{F0156}  \u{F167A}  scribe \u{F0931} ");
    expect(text[2]).toContain("↳ read files");
    expect(nerd[2]).toContain("\u{F060D} read files");
    expect(nerd.map(visibleWidth)).toEqual(text.map(visibleWidth));
  });

  it("styles generated failed-tool summaries but leaves log text untouched", () => {
    const event = { runId: "one", sessionId: "s", ts: 1, type: "tool_result" as const,
      summary: "✗ read — failed", payload: { isError: true } };
    const snapshot = applyEvent(agent, event);
    const text = formatAgentLine(theme("text"), snapshot, 100, 0, "◆");
    const nerd = formatAgentLine(theme("nerd"), snapshot, 100, 0, "◆");
    expect(text).toContain("\u274C read — failed");
    expect(nerd).toContain("\u{F0156}  read — failed");
    const current = applyEvent(agent, { ...event, summary: "\u274C read — failed" });
    expect(formatAgentLine(theme("nerd"), current, 100, 0, "◆")).toContain("\u{F0156}  read — failed");
    expect(visibleWidth(nerd)).toBe(visibleWidth(text));
    const opts = { agent: snapshot, width: 100, height: 3, focused: false, pinned: false, now: 0, spinner: new Spinner() };
    expect(renderGridCell(theme("nerd"), opts).join("\n")).toContain("\u{F0156}  read — failed");
    const log = applyEvent(agent, { ...event, type: "log", summary: "✗ user text" });
    expect(formatAgentLine(theme("nerd"), log, 100, 0, "◆")).toContain("✗ user text");
    const detail = new AgentDetail("one", theme("nerd"), { viewport: () => ({ safeHeight: 15 }), requestRender: () => {} });
    detail.update({ kind: "loaded", run: agent, events: [{ ...event, id: 1 }] });
    try { expect(detail.render(100).join("\n")).toContain("\u{F0156}  read — failed"); }
    finally { detail.dispose(); }
  });

  it("keeps failed-tool provenance aligned when the activity tail rolls over", () => {
    let snapshot = agent;
    for (let i = 0; i < 21; i++) {
      snapshot = applyEvent(snapshot, { runId: "one", sessionId: "s", ts: i, type: "log", summary: `line ${i}` });
    }
    snapshot = applyEvent(snapshot, { runId: "one", sessionId: "s", ts: 22, type: "tool_result", summary: "✗ read", payload: { isError: true } });
    expect(snapshot.recentActivity).toHaveLength(20);
    expect(snapshot.recentActivityErrors).toHaveLength(20);
    expect(snapshot.recentActivityErrors?.slice(0, -1).every(value => value === false)).toBe(true);
    expect(snapshot.recentActivityErrors?.at(-1)).toBe(true);
    snapshot = applyEvent(snapshot, { runId: "one", sessionId: "s", ts: 23, type: "log", summary: "✗ user text" });
    expect(formatAgentLine(theme("nerd"), snapshot, 100, 0, "◆")).toContain("✗ user text");
    expect(snapshot.recentActivityErrors?.at(-2)).toBe(true);
    expect(snapshot.recentActivityErrors?.at(-1)).toBe(false);
  });

  it("renders handoffs and kill warnings in agent detail", () => {
    const opts = { now: () => 0, viewport: () => ({ safeHeight: 15 }), requestRender: () => {} };
    const text = new AgentDetail("one", theme("text"), opts);
    const nerd = new AgentDetail("one", theme("nerd"), opts);
    try {
      for (const detail of [text, nerd]) {
        detail.update({ kind: "loaded", run: agent, events: [{ id: 1, runId: "one", sessionId: "s", ts: 1, type: "handoff", summary: "next" }] });
        detail.onKill(() => {});
        detail.render(80);
        detail.handleInput("k");
      }
      const a = text.render(80), b = nerd.render(80);
      expect(a.join("\n")).toContain("⇢ next");
      expect(b.join("\n")).toContain("\u{F19B0} next");
      expect(a.join("\n")).toContain("\u26A0\uFE0F k again to kill");
      expect(b.join("\n")).toContain("\u{F002A}  k again to kill");
      expect(a[0]).toContain("\u{1F916} scribe");
      expect(b[0]).toContain("\u{F167A}  scribe");
      expect(b.map(visibleWidth)).toEqual(a.map(visibleWidth));
    } finally { text.dispose(); nerd.dispose(); }
  });

  it("styles failed detail status and live failed activity", () => {
    const detail = new AgentDetail("one", theme("nerd"), { viewport: () => ({ safeHeight: 15 }), requestRender: () => {} });
    try {
      detail.update({ kind: "loaded", run: { ...agent, status: "failed" }, events: [] });
      expect(detail.render(80)[0]).toContain("\u{F0156}  failed");
      detail.update({ kind: "loaded", run: { ...agent, activity: "✗ read — failed", activityIsError: true }, events: [] });
      expect(detail.render(80).join("\n")).toContain("\u{F0156}  read — failed");
    } finally { detail.dispose(); }
  });

  it("keeps narrow kill confirmation actionable when the icon does not fit", () => {
    for (const style of ["text", "nerd"] as const) {
      const killed: string[] = [];
      const detail = new AgentDetail("one", theme(style), { viewport: () => ({ safeHeight: 15 }), requestRender: () => {} });
      try {
        detail.update({ kind: "loaded", run: agent, events: [] });
        detail.onKill(id => killed.push(id));
        detail.render(24);
        detail.handleInput("k");
        const controls = detail.render(24).at(-2)!;
        expect(controls).toContain("k again to kill");
        expect(controls).toContain("Esc");
        detail.handleInput("k");
        expect(killed).toEqual(["one"]);
      } finally { detail.dispose(); }
    }
  });

  it("uses the matching gutter for expanded command output", () => {
    const details = { kind: "exec" as const, commands: ["echo"], ok: true, exitCode: 0, outLines: 1,
      preview: ["hello"], expandedOutput: { rows: [{ text: "hello", stream: "stdout" as const }], hidden: 0 } };
    const text = renderExecResult(details, { theme: theme("text"), width: 80, expanded: true });
    const nerd = renderExecResult(details, { theme: theme("nerd"), width: 80, expanded: true });
    expect(text.join("\n")).toContain("⎿ hello");
    expect(nerd.join("\n")).toContain("\u{F060D} hello");
    expect(nerd.map(visibleWidth)).toEqual(text.map(visibleWidth));
  });

  it("preserves hanging indents for the Nerd Font output marker", () => {
    const text = fitResultLines(["  ⎿ first second third"], 12, true);
    const nerd = fitResultLines(["  \u{F060D} first second third"], 12, true);
    expect(text.length).toBeGreaterThan(1);
    expect(nerd.map(line => line.replace("\u{F060D}", "⎿"))).toEqual(text);
    expect(nerd.map(visibleWidth)).toEqual(text.map(visibleWidth));
  });

  it("uses matching gutters in kill, index, and insights results", () => {
    const render = (style: "text" | "nerd") => {
      const th = theme(style);
      return [
        renderKillResult({ requested: "one", killed: [{ runId: "one", name: "scribe", outcome: "failed", via: "none", lastActivity: "reading" }] }, { theme: th, width: 100 }).join("\n"),
        renderIndexResult({ kind: "fetch", source: "docs", targets: ["one"], chunks: 1, embedded: 1 }, { theme: th, width: 100 }).join("\n"),
        renderInsights({ nodes: Array.from({ length: 10 }, (_, i) => ({ id: String(i), label: `node${i}`, kind: "test" })), edges: [], stats: { nodes: 10, edges: 0, linkedPct: 0 } } as never, th, 100).join("\n"),
      ];
    };
    const text = render("text"), nerd = render("nerd");
    for (let i = 0; i < text.length; i++) {
      expect(text[i]).toContain("⎿");
      expect(nerd[i]).toContain("\u{F060D}");
      expect(nerd[i].split("\n").map(visibleWidth)).toEqual(text[i].split("\n").map(visibleWidth));
    }
  });

  it("renders model default and restart markers in the selected style", () => {
    const model = { provider: "p", id: "m", tier: "standard" as const, thinking: false, vision: false, ctx: 1, speed: 1, costHint: 1, available: true };
    const ref = [model.provider, model.id].join("/");
    const a = renderModels([model], { worker: ref }, theme("text"), 100);
    const b = renderModels([model], { worker: ref }, theme("nerd"), 100);
    expect(a.join("\n")).toContain("⟵ worker");
    expect(b.join("\n")).toContain("\u{F004D} worker");
    expect(b.map(visibleWidth)).toEqual(a.map(visibleWidth));
    const c = renderConfig({}, theme("text"), 120, true);
    const d = renderConfig({}, theme("nerd"), 120, true);
    expect(c.join("\n")).toContain("\u26A0\uFE0Frestart");
    expect(d.join("\n")).toContain("\u{F002A} restart");
    expect(d.map(visibleWidth)).toEqual(c.map(visibleWidth));
  });
});

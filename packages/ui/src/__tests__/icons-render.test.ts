import { describe, expect, it } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import { icon, type IconRole } from "../icons.js";
import { Panel, SectionRule, StatusLine } from "../index.js";
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
  it("italicizes the agent role in both grid and detail", () => {
    const styled: ThemeAdapter = { ...theme("text"), italic: text => `<i>${text}</i>` };
    const opts = { agent, width: 100, height: 2, focused: false, pinned: false, now: 0 };
    expect(renderGridCell(styled, opts).join("\n")).toContain("<i>worker</i>");
    const detail = new AgentDetail("one", styled, { viewport: () => ({ safeHeight: 15 }), requestRender: () => {} });
    try {
      detail.update({ kind: "loaded", run: agent, events: [] });
      expect(detail.render(100).join("\n")).toContain("<i>worker</i>");
    } finally { detail.dispose(); }
  });
  it.each(["text", "nerd"] as const)("keeps copy and copied icons equally wide in %s style", style => {
    expect(() => icon(style, "copied")).not.toThrow();
    const copied = icon(style, "copied");
    expect(visibleWidth(copied)).toBe(visibleWidth(icon(style, "copy")));
    expect(copied).toBe(style === "text" ? "✓" : "\u{F012C} ");
  });

  it("returns monochrome glyphs with the specified Nerd Font padding", () => {
    const roles: [IconRole, string, string][] = [
      ["agent", "◇", "\u{F167A} "], ["spider", "◆", "\u{F0BCA} "], ["warning", "▲", "\u{F002A} "], ["failure", "×", "\u{F0156} "], ["success", "✓", "\u{F012C} "], ["question", "?", "\u{F02D6} "],
      ["task", "→", "\u{F060D} "], ["result", "↑", "\u{F005C} "],
      ["message", "→", "\u{F01F0} "], ["reply", "←", "\u{F0F20} "], ["broadcast", "»", "\u{F0B23} "],
      ["handoff", "→", "\u{F19B0} "], ["pin", "†", "\u{F0931} "], ["modelDefault", "←", "\u{F004D} "],
      ["prompt", "❯", "❯"], ["copy", "□", "\u{F018F} "], ["todoDone", "✓", "\u{F05E1} "], ["todoFailed", "×", "\u{F015A} "], ["todoPending", "○", "\u{F0766} "],
    ];
    for (const [role, text, nerd] of roles) {
      expect(icon(undefined, role)).toBe(text);
      expect(icon("text", role)).toBe(text);
      expect(icon("nerd", role)).toBe(nerd);
      expect(text).not.toMatch(/\p{Extended_Pictographic}/u);
      expect(visibleWidth(nerd)).toBe(visibleWidth(text) + Number(nerd.endsWith(" ")));
    }
  });
  it("uses the text icon for an adapter without an icon style", () => {
    const custom: ThemeAdapter = { ...theme("text"), glyph: "🕸", iconStyle: undefined };
    expect(formatAgentLine(custom, agent, 100, 0)).toContain("◇ scribe");
    const opts = { agent, width: 100, height: 2, focused: false, pinned: false, now: 0 };
    expect(renderGridCell(custom, opts)[0]).toContain("◇ scribe");
  });

  it("keeps the agent marker and its following spaces aligned", () => {
    const text = formatAgentLine(theme("text"), agent, 100, 0);
    const nerd = formatAgentLine(theme("nerd"), agent, 100, 0);
    expect(text).toContain("◇ scribe");
    expect(nerd).toContain("\u{F167A}  scribe");
    expect(visibleWidth(nerd)).toBe(visibleWidth(text) + 1);
  });

  it("renders warning and failure icons with Nerd Font padding", () => {
    expect(statusIcon(theme("text"), "warn")).toBe("▲");
    expect(statusIcon(theme("nerd"), "warn")).toBe("\u{F002A} ");
    expect(statusIcon(theme("text"), "fail")).toBe("×");
    expect(statusIcon(theme("nerd"), "fail")).toBe("\u{F0156} ");
    expect(visibleWidth(statusIcon(theme("nerd"), "warn"))).toBe(2);
  });

  it("uses the spider icon in cards and preserves their width", () => {
    const text = card(theme("text"), "Agents", [], 40)[0];
    const nerd = card(theme("nerd"), "Agents", [], 40)[0];
    expect(text).toContain("◆ Agents");
    expect(nerd).toContain("\u{F0BCA}  Agents");
    expect(nerd).not.toContain("\u{F167A}");
    expect(visibleWidth(nerd)).toBe(visibleWidth(text));
  });

  it.each(["text", "nerd"] as const)("keeps section rules and legacy component rows within width in %s style", style => {
    for (const title of ["Agents", "色"]) {
      const line = SectionRule(title, style).render(40)[0];
      expect(visibleWidth(line)).toBe(40);
    }
    expect(visibleWidth(Panel({ body: ["色".repeat(12)], iconStyle: style }).render(10)[0])).toBeLessThanOrEqual(10);
    expect(visibleWidth(StatusLine({ left: "色", right: "値" }).render(10)[0])).toBeLessThanOrEqual(10);
  });

  it("heads spider tool calls with the spider icon, keeping the robot for subagent rows", () => {
    const call = { kind: "exec" as const, commands: ["echo"] };
    const text = renderExecCall(call, { theme: theme("text"), width: 80 });
    const nerd = renderExecCall(call, { theme: theme("nerd"), width: 80 });
    expect(text[0]).toMatch(/^ ◆ exec/u);
    expect(nerd[0]).toMatch(/^ \u{F0BCA}  exec/u);
    expect(visibleWidth(nerd[0])).toBe(visibleWidth(text[0]) + 1);
    expect(formatAgentLine(theme("nerd"), agent, 100, 0)).toContain("\u{F167A}  scribe");
  });

  it("aligns message details in both icon styles", () => {
    const details = { verb: "send" as const, to: "worker", body: "hello", delivered: false, delivery: "queued" as const };
    const text = renderMessageResult(details, { theme: theme("text"), width: 100 });
    const nerd = renderMessageResult(details, { theme: theme("nerd"), width: 100 });
    expect(text.join("\n")).toContain("▲ → worker");
    expect(nerd.join("\n")).toContain("\u{F002A}  \u{F01F0}  worker");
    expect(text.join("\n")).toContain("   hello");
    expect(nerd.join("\n")).toContain("    hello");
    expect(visibleWidth(nerd[0])).toBe(visibleWidth(text[0]) + 2);
    expect(visibleWidth(nerd[1])).toBe(visibleWidth(text[1]) + 1);
  });

  it("keeps the question mark attached to the ask marker", () => {
    const details = { verb: "ask" as const, to: "worker", body: "", delivered: true };
    expect(renderMessageResult(details, { theme: theme("text"), width: 100 }).join("\n")).toContain("→? worker");
    expect(renderMessageResult(details, { theme: theme("nerd"), width: 100 }).join("\n")).toContain("\u{F01F0}? worker");
  });

  it("uses a plain arrow for tool intents in agent detail", () => {
    for (const style of ["text", "nerd"] as const) {
      const detail = new AgentDetail("one", theme(style), { viewport: () => ({ safeHeight: 15 }), requestRender: () => {} });
      try {
        detail.update({ kind: "loaded", run: agent, events: [{ id: 1, runId: "one", sessionId: "s", ts: 1, type: "tool_intent", summary: "read files" }] });
        const output = detail.render(100).join("\n");
        expect(output).toContain("→ read files");
        expect(output).not.toContain("\u{F01F0}");
      } finally { detail.dispose(); }
    }
  });

  it("renders reply and broadcast markers with the same widths", () => {
    for (const [verb, textIcon, nerdIcon] of [["reply", "←", "\u{F0F20}"], ["broadcast", "»", "\u{F0B23}"]] as const) {
      const details = { verb, to: "worker", body: "", delivered: true };
      const text = renderMessageResult(details, { theme: theme("text"), width: 100 });
      const nerd = renderMessageResult(details, { theme: theme("nerd"), width: 100 });
      expect(text.join("\n")).toContain(`${textIcon} worker`);
      expect(nerd.join("\n")).toContain(`${nerdIcon}  worker`);
      expect(visibleWidth(nerd[0])).toBe(visibleWidth(text[0]) + 2);
    }
  });

  it("keeps pinned agent rows aligned and replaces task and failure markers", () => {
    const opts = { agent: { ...agent, status: "failed" as const, task: "read files" }, width: 100, height: 3,
      focused: false, pinned: true, now: 0 };
    const text = renderGridCell(theme("text"), opts);
    const nerd = renderGridCell(theme("nerd"), opts);
    expect(text[0]).toContain("× scribe †");
    expect(nerd[0]).toContain("\u{F0156}  scribe \u{F0931} ");
    expect(text[2]).toContain("→ read files");
    expect(nerd[2]).toContain("\u{F060D}  read files");
    expect(visibleWidth(nerd[0])).toBe(visibleWidth(text[0]) + 2);
    expect(visibleWidth(nerd[2])).toBe(visibleWidth(text[2]) + 1);
  });

  it("styles generated failed-tool summaries but leaves log text untouched", () => {
    const event = { runId: "one", sessionId: "s", ts: 1, type: "tool_result" as const,
      summary: "✗ read — failed", payload: { isError: true } };
    const snapshot = applyEvent(agent, event);
    const text = formatAgentLine(theme("text"), snapshot, 100, 0);
    const nerd = formatAgentLine(theme("nerd"), snapshot, 100, 0);
    expect(text).toContain("× read — failed");
    expect(nerd).toContain("\u{F0156}  read — failed");
    const current = applyEvent(agent, { ...event, summary: "\u274C read — failed" });
    expect(formatAgentLine(theme("nerd"), current, 100, 0)).toContain("\u{F0156}  read — failed");
    expect(visibleWidth(nerd)).toBe(visibleWidth(text) + 2);
    const opts = { agent: snapshot, width: 100, height: 3, focused: false, pinned: false, now: 0 };
    expect(renderGridCell(theme("nerd"), opts).join("\n")).toContain("\u{F0156}  read — failed");
    const log = applyEvent(agent, { ...event, type: "log", summary: "✗ user text" });
    expect(formatAgentLine(theme("nerd"), log, 100, 0)).toContain("✗ user text");
    const detail = new AgentDetail("one", theme("nerd"), { viewport: () => ({ safeHeight: 15 }), requestRender: () => {} });
    detail.update({ kind: "loaded", run: agent, events: [{ ...event, id: 1 }] });
    try { expect(detail.render(100).join("\n")).toContain("\u{F0156}  read — failed"); }
    finally { detail.dispose(); }
  });

  it("styles generated success markers while preserving ordinary log text", () => {
    const event = { runId: "one", sessionId: "s", ts: 1, type: "tool_result" as const,
      summary: "✓ read — done", payload: { isError: false } };
    const snapshot = applyEvent(agent, event);
    expect(formatAgentLine(theme("nerd"), snapshot, 100, 0)).toContain("\u{F012C}  read — done");
    const opts = { agent: snapshot, width: 100, height: 3, focused: false, pinned: false, now: 0 };
    expect(renderGridCell(theme("nerd"), opts).join("\n")).toContain("\u{F012C}  read — done");
    const detail = new AgentDetail("one", theme("nerd"), { viewport: () => ({ safeHeight: 15 }), requestRender: () => {} });
    detail.update({ kind: "loaded", run: agent, events: [{ ...event, id: 1 }] });
    try { expect(detail.render(100).join("\n")).toContain("\u{F012C}  read — done"); }
    finally { detail.dispose(); }
    const log = applyEvent(agent, { ...event, type: "log", summary: "✓ user text" });
    expect(formatAgentLine(theme("nerd"), log, 100, 0)).toContain("✓ user text");
  });

  it("keeps failed-tool provenance aligned when the activity tail rolls over", () => {
    let snapshot = agent;
    for (let i = 0; i < 21; i++) {
      snapshot = applyEvent(snapshot, { runId: "one", sessionId: "s", ts: i, type: "log", summary: `line ${i}` });
    }
    snapshot = applyEvent(snapshot, { runId: "one", sessionId: "s", ts: 22, type: "tool_result", summary: "✗ read", payload: { isError: true } });
    expect(snapshot.recentActivity).toHaveLength(20);
    expect(snapshot.recentActivityErrors).toHaveLength(20);
    expect(snapshot.recentActivityErrors?.slice(0, -1).every(value => value === undefined)).toBe(true);
    expect(snapshot.recentActivityErrors?.at(-1)).toBe(true);
    snapshot = applyEvent(snapshot, { runId: "one", sessionId: "s", ts: 23, type: "log", summary: "✗ user text" });
    expect(formatAgentLine(theme("nerd"), snapshot, 100, 0)).toContain("✗ user text");
    expect(snapshot.recentActivityErrors?.at(-2)).toBe(true);
    expect(snapshot.recentActivityErrors?.at(-1)).toBeUndefined();
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
      expect(a.join("\n")).toContain("→ next");
      expect(b.join("\n")).toContain("\u{F19B0}  next");
      expect(a.join("\n")).toContain("▲ k again to kill");
      expect(b.join("\n")).toContain("\u{F002A}  k again to kill");
      expect(a[0]).toContain("◇ scribe");
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

  it("aligns expanded command output in both icon styles", () => {
    const details = { kind: "exec" as const, commands: ["echo"], ok: true, exitCode: 0, outLines: 1,
      preview: ["hello"], expandedOutput: { rows: [{ text: "hello", stream: "stdout" as const }], hidden: 0 } };
    const text = renderExecResult(details, { theme: theme("text"), width: 80, expanded: true });
    const nerd = renderExecResult(details, { theme: theme("nerd"), width: 80, expanded: true });
    expect(text.join("\n")).toContain("   hello");
    expect(nerd.join("\n")).toContain("    hello");
    expect(visibleWidth(nerd[1])).toBe(visibleWidth(text[1]) + 1);
  });

  it("preserves the full Nerd Font success marker when wrapping", () => {
    const lines = fitResultLines([` ${icon("nerd", "success")} first second third`], 13, true);
    expect(lines).toEqual([` ${icon("nerd", "success")} first`, "    second", "    third"]);
  });

  it.each(["text", "nerd"] as const)("keeps wide wrapped graphemes inside a one-cell %s viewport", style => {
    const lines = fitResultLines([` ${icon(style, "success")} 計画`], 1, true);
    expect(lines.every(line => visibleWidth(line) <= 1)).toBe(true);
  });

  it("preserves a four-cell detail indent through expanded wrapping", () => {
    const rows = fitResultLines(["    first second third"], 12, true, 3);
    expect(rows).toEqual(["    first", "    second", "    third"]);
  });

  it("indents details in kill, index, and insights cards", () => {
    const render = (style: "text" | "nerd") => {
      const th = theme(style);
      return [
        renderKillResult({ requested: "one", killed: [{ runId: "one", name: "scribe", outcome: "failed", via: "none", lastActivity: "reading" }] }, { theme: th, width: 100 }).join("\n"),
        renderIndexResult({ kind: "fetch", source: "docs", targets: ["one"], chunks: 1, embedded: 1 }, { theme: th, width: 100 }).join("\n"),
        renderInsights({ nodes: Array.from({ length: 10 }, (_, i) => ({ id: String(i), label: `node${i}`, kind: "test" })), edges: [], stats: { nodes: 10, edges: 0, linkedPct: 0 } } as never, th, 100, false, true).join("\n"),
      ];
    };
    const text = render("text"), nerd = render("nerd");
    for (const [i, detail] of ["was: reading", "1 chunks", "… 2 more"].entries()) {
      expect(text[i].split("\n").find(row => row.includes(detail))).toMatch(/^ {3}\S/u);
      const nerdIndent = detail === "… 2 more" ? /^ {3}\S/u : /^ {4}\S/u;
      expect(nerd[i].split("\n").find(row => row.includes(detail))).toMatch(nerdIndent);
      expect(text[i].split("\n").every(line => visibleWidth(line) <= 100)).toBe(true);
      expect(nerd[i].split("\n").every(line => visibleWidth(line) <= 100)).toBe(true);
    }
  });

  it("renders model default and restart markers in the selected style", () => {
    const model = { provider: "p", id: "m", tier: "standard" as const, thinking: false, vision: false, ctx: 1, speed: 1, costHint: 1, available: true };
    const ref = [model.provider, model.id].join("/");
    const a = renderModels([model], { worker: ref }, theme("text"), 100);
    const b = renderModels([model], { worker: ref }, theme("nerd"), 100);
    expect(a.join("\n")).toContain("← worker");
    expect(b.join("\n")).toContain("\u{F004D}  worker");
    expect(visibleWidth(b[1])).toBe(visibleWidth(a[1]) + 1);
    const c = renderConfig({}, theme("text"), 120, true);
    const d = renderConfig({}, theme("nerd"), 120, true);
    expect(c.join("\n")).toContain("▲restart");
    expect(d.join("\n")).toContain("\u{F002A} restart");
    expect(d.every(line => visibleWidth(line) <= 120)).toBe(true);
    expect(c.every(line => visibleWidth(line) <= 120)).toBe(true);
  });
});

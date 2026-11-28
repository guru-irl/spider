import { afterEach, describe, expect, it, vi } from "vitest";
import { stripTerminalSequences, styleText, visibleWidth, type TuiMouseEvent } from "@earendil-works/pi-tui";
import * as ui from "../index.js";
import type { IntroTheme, StartupFacts } from "../components/intro-header.js";

const theme: IntroTheme = {
  fg: (_role, text) => text,
  bold: text => text,
  getBgAnsi: () => "\x1b[48;2;32;32;34m",
  style: (text, options) => styleText(text, options, "truecolor"),
};
const facts: StartupFacts = {
  cwd: "~/src/spider", branch: "main", version: "1.5.2", model: "Claude Opus 5.5", thinking: "xhigh",
  session: { compactions: 3, turns: 28, ageMs: 6_120_000, runs: { total: 4, active: 1 }, todos: 2 },
  resources: { context: 1, skills: 60, extensions: 2, prompts: 0, promptTokens: 8_890 },
};
const makeHeader = (options?: { reducedMotion?: boolean }) => {
  expect(ui.StartupHeader).toBeTypeOf("function");
  const requestRender = vi.fn(), openResources = vi.fn();
  const view = new ui.StartupHeader(theme, facts, { requestRender, openResources, reducedMotion: true, ...options });
  return { view, openResources, requestRender };
};
const plain = (lines: string[]) => lines.map(stripTerminalSequences);
const highlight = "\x1b[38;2;248;248;242m";

function click(x: number, y: number, overrides?: Partial<TuiMouseEvent>): TuiMouseEvent {
  return { type: "click", button: "left", x, y, screenX: x, screenY: y, width: 120, height: 20,
    shift: false, alt: false, ctrl: false, ...overrides };
}
afterEach(() => vi.useRealTimers());

describe("Hinge startup header", () => {
  it.each([120, 80, 60])("keeps the approved hierarchy and all counts at %i columns", width => {
    const { view } = makeHeader();
    const rendered = view.render(width), lines = plain(rendered);
    expect(rendered.every(line => visibleWidth(line) <= width)).toBe(true);
    expect(lines).toHaveLength(18);
    const identity = lines.findIndex(line => line.includes("spider") && line.includes("pi v1.5.2"));
    expect(identity).toBe(width === 120 ? 3 : 1);
    expect(lines[identity + 1]).toContain("~/src/spider · main");
    expect(lines[identity + 2]).toContain("Claude Opus 5.5 · xhigh");
    const heading = lines.findIndex(line => line.includes("Session stats"));
    const stats = lines.slice(heading + 2, heading + 7);
    expect(stats[0]).toMatch(/Compactions\s+3\s*$/);
    expect(stats[1]).toMatch(/Turns\s+28\s*$/);
    expect(stats[2]).toMatch(/Age\s+1h 42m\s*$/);
    expect(stats[3]).toMatch(/Subagent runs\s+4 · 1 active\s*$/);
    expect(stats[4]).toMatch(/Open todos\s+2\s*$/);
    expect(new Set(stats.map(line => line.trimEnd().length)).size).toBe(1);
    for (const command of ["/spider", "/agents", "/todos"]) expect(lines.join("\n")).toContain(command);
    const resourceRows = lines.filter(line => line.includes("Loaded resources"));
    expect(resourceRows).toHaveLength(1);
    expect(resourceRows[0]).toMatch(/(?:Context|Ctx) ?1.*Skills 60.*(?:Extensions|Ext) ?≥2.*(?:Prompts|Tmpl) ?0.*(?:System prompt|Sys) ~8\.9k/);
    expect(resourceRows[0]!.includes("Alt+O")).toBe(width > 60);
    expect(resourceRows[0]).toContain("→");
    expect(rendered.join("").split(highlight)).toHaveLength(3);
  });

  it("takes only left clicks inside the resources box, including its border", () => {
    const { view, openResources } = makeHeader();
    expect(view.handleMouse(click(3, 16))).toBeUndefined();
    view.render(120);
    for (const event of [click(0, 16), click(119, 16), click(2, 14), click(2, 16, { button: "right" }), click(2, 16, { type: "press" })]) {
      expect(view.handleMouse(event)).toBeUndefined();
    }
    expect(openResources).not.toHaveBeenCalled();
    expect(view.handleMouse(click(1, 15))).toEqual({ handled: true });
    expect(view.handleMouse(click(44, 16))).toEqual({ handled: true });
    expect(openResources).toHaveBeenCalledTimes(2);
    view.render(60);
    expect(view.handleMouse(click(75, 16))).toBeUndefined();
    expect(view.handleMouse(click(58, 17))).toEqual({ handled: true });
  });

  it("plays each pose at the agreed instant without moving the text, then stays still", () => {
    vi.useFakeTimers();
    const { view, requestRender } = makeHeader({ reducedMotion: false });
    const initial = view.render(120);
    const allFrames = new Set([initial.join("\n")]);
    const spritePositions = [[0, 19, 3], [200, 19, 4], [460, 19, 8], [800, 24, 6], [1150, 16, 6], [1630, 19, 7], [1780, 19, 7]];
    for (const [i, [at, center, crown]] of spritePositions.entries()) {
      vi.advanceTimersByTime(at! - (spritePositions[i - 1]?.[0] ?? 0) - (i ? 1 : 0));
      if (i) {
        expect(requestRender).toHaveBeenCalledTimes(i - 1);
        vi.advanceTimersByTime(1);
      }
      const frame = view.render(120), lines = plain(frame);
      expect(lines[crown!]![center! + 1]).toBe("▀"); // Lilac top over shell purple.
      expect(frame[crown!]).toContain("\x1b[48;2;189;147;249m");
      expect(frame.join("").split(highlight)).toHaveLength(i === 5 ? 1 : 3);
      expect(lines.map(line => line.slice(41))).toEqual(plain(initial).map(line => line.slice(41)));
      allFrames.add(frame.join("\n"));
    }
    expect(allFrames.size).toBe(7);
    const rest = view.render(120);
    expect(rest).toEqual(makeHeader().view.render(120));
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(30_000);
    expect(requestRender).toHaveBeenCalledTimes(6);
    expect(view.render(120)).toEqual(rest);
  });

  it("clears the pending animation on disposal and schedules none in reduced motion", () => {
    vi.useFakeTimers();
    const { view, requestRender } = makeHeader({ reducedMotion: false });
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    view.dispose();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(3_000);
    expect(requestRender).not.toHaveBeenCalled();
    makeHeader().view.render(60);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("Docked receipt", () => {
  it.each([120, 80, 60, 34])("shows visit numbers without duplicating Pi's resume hint at %i columns", width => {
    expect(ui.renderDocked).toBeTypeOf("function");
    const rows = ui.renderDocked(width, theme, {
      changes: { added: 42, removed: 8, partial: false }, timeMs: 920_000, compactions: 3,
      usage: { credits: 7.29, calls: 5, unpricedCalls: 1, input: 20, cacheRead: 46_900, cacheWrite: 25_100, output: 531, reasoning: 53 },
    });
    expect(rows.every(line => visibleWidth(line) <= width)).toBe(true);
    const text = plain(rows).join("\n");
    expect(text).toContain("Docked");
    expect(text).toMatch(/Changes\s+\+42 −8/);
    expect(text).toMatch(/AI credits\s+~7\.29/);
    expect(text).toMatch(/15m 20s/);
    expect(text).toMatch(/Tokens in\s+↑ 72\.0k/);
    expect(text).toMatch(/46\.9k cached, 25\.1k\s+written/);
    expect(text).toMatch(/Tokens out\s+↓ 531\s+\(53 reasoning\)/);
    expect(text).toMatch(/Compactions\s+3/);
    expect(text).not.toMatch(/pi --session|[\u2801-\u28ff]/u);
    expect(rows.join("").split(highlight)).toHaveLength(3);
  });

  it("distinguishes partial edits and unavailable usage from zero", () => {
    expect(ui.renderDocked).toBeTypeOf("function");
    const text = plain(ui.renderDocked(80, theme, {
      changes: { added: 0, removed: 0, partial: true }, timeMs: 0, compactions: 0,
    })).join("\n");
    expect(text).toMatch(/Changes\s+\+0 −0 \(partial\)/);
    expect(text).toMatch(/AI credits\s+unavailable \(0s\)/);
    expect(text).toMatch(/Tokens in\s+unavailable/);
    expect(text).toMatch(/Tokens out\s+unavailable/);
  });
});

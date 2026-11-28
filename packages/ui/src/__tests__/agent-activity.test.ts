import { describe, expect, it } from "vitest";
import { AgentList } from "../agents/agent-list.js";
import { AgentFooter } from "../agents/footer.js";
import { renderGridCell } from "../agents/grid-cell.js";
import { AgentStore } from "../agents/store.js";
import type { RunRow, ThemeAdapter } from "../agents/types.js";

const theme: ThemeAdapter & { spiderGlyphs: boolean; activityTint(text: string, strength: number): string } = {
  fg: (token, text) => `[${token}]${text}`,
  bg: (_token, text) => text,
  bold: text => text,
  glyph: "◆",
  iconStyle: "nerd",
  spiderGlyphs: true,
  activityTint: (text, strength) => `[${strength.toFixed(2)}]${text}`,
};

function surfaces(runId: string, status: RunRow["status"], now: number, style = theme): string[] {
  const row: RunRow = { id: runId, session_id: "session", status, agent: "worker", name: "scribe", step_count: 1, token_count: 0, started_at: 0 };
  const store = new AgentStore({ listActive: () => [row], getRun: () => row, subscribe: () => () => {} });
  store.start();
  try {
    const [agent] = store.snapshot();
    const width = 100;
    return [new AgentFooter(store, style, { now: () => now }).render(width)[0],
      new AgentList(store, style, { now: () => now }).render(width)[0],
      renderGridCell(style, { agent, width, height: 2, pinned: false, focused: false, now })[0]];
  } finally { store.stop(); }
}
const privateGlyphs = (row: string) => row.match(/\p{Co}/gu) ?? [];

describe("agent activity marks", () => {
  it("looks left, right, and blinks at the approved frame boundaries in each surface", () => {
    // This non-empty run ID begins at cycle phase zero.
    const id = "robot-7854";
    const beats = [[0, 699, "\u{F2120}"], [700, 1049, "\u{F2121}"], [1050, 1249, "\u{F2120}"],
      [1250, 1599, "\u{F2122}"], [1600, 2299, "\u{F2120}"], [2300, 2419, "\u{F2123}"],
      [2420, 2669, "\u{F2120}"], [2670, 2789, "\u{F2123}"], [2790, 2791, "\u{F2120}"]] as const;
    for (const [first, last, frame] of beats) for (const time of [first, last]) {
      for (const line of surfaces(id, "running", time)) {
        expect(privateGlyphs(line), `at ${time} ms: ${line}`).toEqual([frame]);
        expect(line).toMatch(new RegExp(`^(?: {2}|\\[accent\\]▸ )?\\[accent\\]${frame} {2}`));
      }
    }
  });

  it("does not sync different run IDs and does not use a spider spinner frame", () => {
    expect(privateGlyphs(surfaces("r1", "running", 0)[0])).toEqual(["\u{F2123}"]);
    expect(privateGlyphs(surfaces("r2", "running", 0)[0])).toEqual(["\u{F2120}"]);
  });

  it("uses the stock robot only, pulsing from dim to accent and back in 1.8 s", () => {
    const style = { ...theme, spiderGlyphs: false };
    for (const [ms, tint] of [[0, "0.00"], [450, "0.50"], [900, "1.00"], [1350, "0.50"], [1800, "0.00"]] as const) {
      for (const line of surfaces("stock-3023", "running", ms, style)) {
        expect(privateGlyphs(line)).toEqual(["\u{F167A}"]);
        expect(line).toMatch(new RegExp(`^(?: {2}|\\[accent\\]▸ )?\\[${tint}\\]\u{F167A} {2}`, "u"));
      }
    }
  });

  it.each([["done", "success", "\u{F012C}"], ["failed", "error", "\u{F0156}"], ["cancelled", "warning", "\u{F002A}"]] as const)
    ("replaces the robot with the %s status icon and keeps its color", (status, token, glyph) => {
      for (const line of surfaces("robot-7854", status, 700)) {
        expect(privateGlyphs(line)).toEqual([glyph]);
        expect(line).toMatch(new RegExp(`\\[${token}\\]${glyph} {2}`));
      }
    });

  it("uses one plain marker and never a private glyph in text mode, even with the patch enabled", () => {
    for (const line of surfaces("robot-7854", "running", 700, { ...theme, iconStyle: "text" })) {
      expect(line).not.toMatch(/\p{Co}|\p{Extended_Pictographic}/u);
      expect(line).toMatch(/\]◇ (?:(?:\[accent\])?worker )?(?:\[toolTitle\])?scribe/u);
    }
  });
});

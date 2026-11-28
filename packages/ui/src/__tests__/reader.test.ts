import {
  Text, TuiAltScreen, stripTerminalSequences, visibleWidth, type Terminal,
} from "@earendil-works/pi-tui";
import { afterEach, expect, it, vi } from "vitest";
import { TabbedReader } from "../components/reader.js";

const identity = (text: string) => text;
const theme = {
  fg: (role: string, text: string) => role === "scrollbarTrack" ? `\x1b[90m${text}\x1b[39m`
    : role === "scrollbarThumb" ? `\x1b[37m${text}\x1b[39m` : text,
  bold: identity,
};
const running: (() => void)[] = [];
afterEach(() => {
  for (const stop of running.splice(0)) stop();
  vi.useRealTimers();
});

function fixture(contentRows = 31, width = 78, height = 16) {
  let input: (data: string) => void = () => {};
  const terminal = {
    columns: width, rows: height, kittyProtocolActive: false,
    start: (onInput: (data: string) => void) => { input = onInput; },
    stop() {}, write() {}, hideCursor() {}, showCursor() {}, moveBy() {}, clearLine() {},
    clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {}, setProgramStatus() {}, drainInput: async () => {},
  } satisfies Terminal;
  const tui = new TuiAltScreen(terminal, false);
  const background = new Text("underlying transcript", 0, 0);
  tui.addChild(background);
  tui.setFocus(background);
  tui.start();
  const reader = new TabbedReader({
    title: "Archive", breadcrumb: "Run 5",
    tabs: [
      { label: "Overview", content: new Text("Daily overview", 0, 0) },
      { label: "Entries", count: contentRows, content: new Text(Array.from({ length: contentRows }, (_, i) => `Entry ${i + 1}`).join("\n"), 0, 0) },
    ],
  }, {
    theme, height: () => terminal.rows, requestRender: () => tui.requestRender(),
    close: () => { overlay.hide(); reader.dispose(); },
  });
  const overlay = tui.showOverlay(reader, { anchor: "top-left", width: "100%", maxHeight: "100%", margin: 0 });
  running.push(() => { reader.dispose(); tui.stop({ preserveScreen: true }); });
  function screen() {
    tui.renderNow();
    return tui.getScreenLines().map(stripTerminalSequences);
  }
  const text = () => screen().join("\n");
  const mouse = (code: number, x: number, y: number, release = false) => input(`\x1b[<${code};${x + 1};${y + 1}${release ? "m" : "M"}`);
  const click = (x: number, y: number) => { mouse(0, x, y); mouse(0, x, y, true); };
  const firstEntry = () => /Entry (\d+)/u.exec(text())?.[1];
  const track = () => screen().flatMap((line, y) => {
    const glyph = line.trimEnd().at(-1);
    return glyph && "│┃█".includes(glyph) ? [{ y, glyph }] : [];
  });
  return { tui, reader, background, terminal, text, screen, send: (data: string) => input(data), mouse, click, firstEntry, track };
}

it("covers the transcript and switches tabs by Tab, Shift-Tab and arrow keys", () => {
  const app = fixture();
  expect(app.text()).toContain("Archive / Run 5 / Overview");
  expect(app.text()).not.toContain("underlying transcript");
  expect(app.text()).toMatch(/Entries +31/u);
  app.send("\t");
  expect(app.firstEntry()).toBe("1");
  app.send("\x1b[Z");
  expect(app.text()).toContain("Daily overview");
  app.send("\x1b[D");
  expect(app.firstEntry()).toBe("1");
  app.send("\x1b[C");
  expect(app.text()).toContain("Daily overview");
});

it("scrolls by line or page and clamps Home and End within the current tab", () => {
  const app = fixture();
  app.text();
  app.send("\t");
  expect(app.firstEntry()).toBe("1");
  app.send("\x1b[B");
  expect(app.firstEntry()).toBe("2");
  app.send("\x1b[A");
  expect(app.firstEntry()).toBe("1");
  app.send("\x1b[6~");
  expect(Number(app.firstEntry())).toBeGreaterThan(2);
  app.send("\x1b[5~");
  expect(app.firstEntry()).toBe("1");
  app.send("\x1b[F");
  expect(app.text()).toContain("Entry 31");
  expect(app.text()).toContain("100% scrolled");
  app.send("\x1b[H");
  expect(app.firstEntry()).toBe("1");
  expect(app.text()).not.toContain("Entry 31");
});

it("accepts a tab click and restores focus on Escape", () => {
  const app = fixture();
  const tabs = app.screen();
  const row = tabs.findIndex(line => line.includes("Entries"));
  expect(row).toBeGreaterThan(0);
  app.click(tabs[row].indexOf("Entries"), row);
  expect(app.firstEntry()).toBe("1");
  app.send("\x1b");
  expect(app.text()).toContain("underlying transcript");
  expect(app.tui.getFocusedComponent()).toBe(app.background);
});

it("reveals the theme-colored track on wheel, uses Pi's thumb ratio and hides after one second", () => {
  vi.useFakeTimers();
  const app = fixture();
  app.text();
  app.send("\t");
  expect(app.firstEntry()).toBe("1");
  expect(app.track()).toEqual([]);
  const bodyY = app.screen().findIndex(line => line.includes("Entry 1"));
  app.mouse(65, 38, bodyY);
  expect(Number(app.firstEntry())).toBeGreaterThan(1);
  const track = app.track();
  expect(track).toHaveLength(11);
  expect(track.filter(({ glyph }) => glyph === "┃")).toHaveLength(4); // round(11² / 31)
  const raw = app.reader.render(78).join("\n");
  expect(raw).toContain("\x1b[90m│\x1b[39m");
  expect(raw).toContain("\x1b[37m┃\x1b[39m");
  vi.advanceTimersByTime(999);
  expect(app.track()).toHaveLength(11);
  vi.advanceTimersByTime(1);
  expect(app.track()).toEqual([]);
});

it("keeps the active thumb two cells tall on long sections and ends hover on pointer exit", () => {
  vi.useFakeTimers();
  const app = fixture(500);
  app.text();
  app.send("\t");
  app.text();
  app.mouse(35, 77, 5);
  expect(app.track().filter(row => row.glyph === "█")).toHaveLength(2);
  vi.advanceTimersByTime(1000);
  expect(app.track().filter(row => row.glyph === "█")).toHaveLength(2);
  app.mouse(35, 38, 5);
  expect(app.track().filter(row => row.glyph === "┃")).toHaveLength(2);
  vi.advanceTimersByTime(1000);
  expect(app.track()).toEqual([]);
});

it("jumps the thumb center to a track press and captures a thumb drag outside its column", () => {
  const app = fixture();
  app.text();
  app.send("\t");
  app.text();
  app.mouse(35, 77, 5);
  const track = app.track();
  expect(track).toHaveLength(11);
  const top = track[0].y;
  app.click(77, top + 6);
  // Six rows below the top, minus a two-row grab offset. Four of seven steps maps to 11 of 20 rows.
  expect(app.firstEntry()).toBe("12");
  const thumb = app.track().filter(row => row.glyph === "█");
  expect(thumb[0].y).toBe(top + 4);
  app.mouse(0, 77, thumb[1].y);
  app.mouse(32, 35, top + 6); // One row down, still in the drag after leaving the scrollbar column.
  expect(app.firstEntry()).toBe("15");
  app.mouse(32, 35, 15);
  expect(app.text()).toContain("100% scrolled");
  app.mouse(0, 35, 15, true);
  expect(app.track().some(row => row.glyph === "█")).toBe(false);
  app.mouse(32, 35, 4);
  expect(app.text()).toContain("100% scrolled");
});

it("keeps the active tab and content visible on a short, narrow terminal", () => {
  const app = fixture(40);
  app.text();
  app.send("\t");
  app.terminal.columns = 24;
  app.terminal.rows = 7;
  const rows = app.reader.render(24);
  expect(rows).toHaveLength(7);
  expect(rows.every(row => visibleWidth(row) === 24)).toBe(true);
  expect(rows.map(stripTerminalSequences).join("\n")).toContain("Entry 1");
  expect(rows.map(stripTerminalSequences).join("\n")).toContain("Entries");
});

import { CustomEditor, Theme, type ExtensionAPI, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, TUI_KEYBINDINGS, TuiAltScreen, type EditorTheme, type Terminal } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { registerInputBand } from "./index.js";
import { installSelectionHighlight } from "./selection.js";

// The screen is Pi's real fullscreen implementation. Only its terminal is inert.
type SelectionScreen = {
  previousScreen: string[];
  selectionAnchor: { row: number; col: number };
  selectionFocus: { row: number; col: number; boundary?: boolean };
  applySelection(rows: string[]): string[];
  copySelectionToClipboard(): Promise<boolean>;
  applySearchTextHighlight(text: string, current: boolean): string;
};
const terminal: Terminal = {
  columns: 12, rows: 4, kittyProtocolActive: false,
  start() {}, stop() {}, async drainInput() {}, write() {}, moveBy() {}, hideCursor() {}, showCursor() {},
  clearLine() {}, clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {}, setProgramStatus() {},
};
const identity = (text: string) => text;
const editorTheme: EditorTheme = { borderColor: identity, selectList: {
  selectedPrefix: identity, selectedText: identity, description: identity, scrollInfo: identity, noMatch: identity,
} };
const keys = new KeybindingsManager({ ...TUI_KEYBINDINGS, "app.interrupt": { defaultKeys: "escape" } }) as unknown as ConstructorParameters<typeof CustomEditor>[2];

// Decode the attributes that a terminal sees, independently of the hook's ANSI output.
function cells(line: string) {
  let fg = "default", bg = "default", reverse = false, concealed = false;
  const result: { char: string; fg: string; bg: string }[] = [];
  for (const token of line.match(/\x1b\[[0-9;]*m|[^\x1b]/gu) ?? []) {
    if (!token.startsWith("\x1b[")) {
      result.push({ char: concealed ? " " : token, fg: reverse ? bg : fg, bg: reverse ? fg : bg });
      continue;
    }
    const p = token.slice(2, -1).split(";").map(Number);
    for (let i = 0; i < p.length; i++) {
      const n = p[i];
      if (n === 0) { fg = "default"; bg = "default"; reverse = false; concealed = false; }
      else if (n === 7) reverse = true;
      else if (n === 27) reverse = false;
      else if (n === 8) concealed = true;
      else if (n === 28) concealed = false;
      else if (n === 39) fg = "default";
      else if (n === 49) bg = "default";
      else if (n === 38 || n === 48) {
        const color = p[i + 1] === 2 ? `rgb(${p.slice(i + 2, i + 5).join(",")})` : `index(${p[i + 2]})`;
        i += p[i + 1] === 2 ? 4 : 2;
        if (n === 38) fg = color; else bg = color;
      } else if (n >= 30 && n <= 37) fg = `ansi(${n})`;
      else if (n >= 40 && n <= 47) bg = `ansi(${n})`;
    }
  }
  return result;
}

function install(tui: TuiAltScreen) {
  let factory: Parameters<ExtensionUIContext["setEditorComponent"]>[0];
  const handlers = new Map<string, (event: unknown, ctx: unknown) => void>();
  const pi = { on: (name: string, handler: (event: unknown, ctx: unknown) => void) => handlers.set(name, handler) } as unknown as ExtensionAPI;
  const theme = {} as Theme;
  const ctx = { cwd: "/project", mode: "tui", hasUI: true, sessionManager: { buildContextEntries: () => [] },
    ui: { theme, setWidget: (_key: string, make: (tui: TuiAltScreen) => unknown) => make(tui),
      setEditorComponent: (value: typeof factory) => { factory = value; }, getEditorComponent: () => factory } };
  registerInputBand(pi, { CustomEditor }, () => ({}));
  handlers.get("session_start")?.({ reason: "startup" }, ctx);
  expect(factory).toBeDefined();
  factory!(tui, editorTheme, keys);
}

const blue = "rgb(58,71,100)";
describe("fullscreen selection", () => {
  it("draws clean selection backgrounds while copying the same bytes as Pi", async () => {
    const copied: string[] = [];
    const tui = new TuiAltScreen(terminal, false, undefined, { copySelection: async text => { copied.push(text); return true; } }) as unknown as SelectionScreen;
    const rows = [
      "plain text  ",
      "\x1b[38;2;130;170;255m▖\x1b[39m\x1b[38;2;6;6;7m▄▄▄▄▄▄▄▄▄▄▄\x1b[39m",
      "\x1b[38;2;130;170;255m▌\x1b[39m\x1b[48;2;6;6;7m \x1b[38;2;80;250;123mcolor\x1b[0m\x1b[48;2;6;6;7m     \x1b[49m",
      "footer      ",
    ];
    tui.selectionAnchor = { row: 0, col: 3 };
    tui.selectionFocus = { row: 3, col: 3, boundary: true };
    tui.previousScreen = tui.applySelection(rows);
    expect(await tui.copySelectionToClipboard()).toBe(true);
    const originalCopy = copied[0];
    expect(originalCopy).toBe("in text\n▖▄▄▄▄▄▄▄▄▄▄▄\n▌ color\nfoo");

    const searchBefore = tui.applySearchTextHighlight("search", true);
    install(tui as unknown as TuiAltScreen);
    expect(tui.applySearchTextHighlight("search", true)).toBe(searchBefore);
    tui.previousScreen = tui.applySelection(rows);
    const drawn = tui.previousScreen.map(cells);
    expect(drawn[0].slice(0, 3).map(cell => cell.bg)).toEqual(["default", "default", "default"]);
    expect(drawn[0].slice(3).every(cell => cell.bg === blue)).toBe(true);
    expect(drawn[1].map(cell => cell.char).join("")).toBe(" ".repeat(12));
    expect(drawn[1].every(cell => cell.bg === blue)).toBe(true);
    expect(drawn[2][0]).toMatchObject({ char: " ", bg: blue });
    expect(drawn[2].slice(2, 7).every(cell => cell.bg === blue && cell.fg === "rgb(80,250,123)")).toBe(true);
    expect(drawn[3].slice(0, 3).every(cell => cell.bg === blue)).toBe(true);
    expect(drawn[3].slice(3).every(cell => cell.bg === "default")).toBe(true);
    expect(await tui.copySelectionToClipboard()).toBe(true);
    expect(copied[1]).toBe(originalCopy);
  });

  it("copies the same bytes after a fullscreen mouse drag and redraw", async () => {
    async function drag(patched: boolean) {
      let feed: (input: string) => void = () => {};
      const copied: string[] = [];
      const term: Terminal = { ...terminal, start(input) { feed = input; } };
      const tui = new TuiAltScreen(term, false, undefined, { copySelection: async text => { copied.push(text); return true; } });
      const rows = ["end message ", "▖▄▄▄▄▄▄▄▄▄▄▄", "▌ prompt    ", "▘▀▀▀▀▀▀▀▀▀▀▀"];
      tui.setLayoutRoot({ render: () => rows, invalidate() {} });
      if (patched) install(tui);
      tui.start();
      try {
        tui.renderNow();
        feed("\x1b[<0;4;1M");
        feed("\x1b[<32;8;3M");
        tui.renderNow();
        feed("\x1b[<0;8;3m");
        await Promise.resolve();
        return copied[0];
      } finally { tui.stop(); }
    }
    const before = await drag(false);
    expect(before).toBe(" message\n▖▄▄▄▄▄▄▄▄▄▄▄\n▌ prompt");
    expect(await drag(true)).toBe(before);
  });

  it("keeps every block visually blank without hiding adjacent colored text", () => {
    const tui = new TuiAltScreen(terminal) as unknown as SelectionScreen;
    const release = installSelectionHighlight(tui as unknown as TuiAltScreen);
    tui.selectionAnchor = { row: 0, col: 0 };
    tui.selectionFocus = { row: 0, col: 12, boundary: true };
    const row = "\x1b[38;2;8;80;7mX▀▄▖▗▘▝▌▐█Y";
    const drawn = cells(tui.applySelection([row])[0]);
    expect(drawn.map(cell => cell.char).join("")).toBe("X         Y");
    expect(drawn.every(cell => cell.bg === blue)).toBe(true);
    expect(drawn[0].fg).toBe("rgb(8,80,7)");
    expect(drawn.at(-1)?.fg).toBe("rgb(8,80,7)");
    release();
  });

  it("restores the original background after a partial selection", () => {
    const tui = new TuiAltScreen(terminal) as unknown as SelectionScreen;
    const release = installSelectionHighlight(tui as unknown as TuiAltScreen);
    tui.selectionAnchor = { row: 0, col: 2 };
    tui.selectionFocus = { row: 0, col: 4, boundary: true };
    const drawn = cells(tui.applySelection(["\x1b[48;2;6;6;7mABCDEF\x1b[49m"])[0]);
    expect(drawn.map(cell => cell.bg)).toEqual([
      "rgb(6,6,7)", "rgb(6,6,7)", blue, blue, "rgb(6,6,7)", "rgb(6,6,7)",
    ]);
    release();
  });

  it("disables inverse inside the selection without changing the cells after it", () => {
    const tui = new TuiAltScreen(terminal) as unknown as SelectionScreen;
    const release = installSelectionHighlight(tui as unknown as TuiAltScreen);
    tui.selectionAnchor = { row: 0, col: 2 };
    tui.selectionFocus = { row: 0, col: 4, boundary: true };
    const drawn = cells(tui.applySelection(["\x1b[38;2;80;250;123m\x1b[48;2;6;6;7m\x1b[7mABCDEF\x1b[27m"])[0]);
    expect(drawn[1]).toMatchObject({ fg: "rgb(6,6,7)", bg: "rgb(80,250,123)" });
    expect(drawn[2]).toMatchObject({ fg: "rgb(80,250,123)", bg: blue });
    expect(drawn[4]).toMatchObject({ fg: "rgb(6,6,7)", bg: "rgb(80,250,123)" });
    release();
  });

  it("keeps pre-existing concealed text concealed after block glyphs", () => {
    const tui = new TuiAltScreen(terminal) as unknown as SelectionScreen;
    const release = installSelectionHighlight(tui as unknown as TuiAltScreen);
    tui.selectionAnchor = { row: 0, col: 0 };
    tui.selectionFocus = { row: 0, col: 4, boundary: true };
    const drawn = cells(tui.applySelection(["\x1b[8ma█b\x1b[28mc"])[0]);
    expect(drawn.map(cell => cell.char).join("")).toBe("   c");
    release();
  });

  it("preserves hyperlink data when it contains a block character", () => {
    const tui = new TuiAltScreen(terminal) as unknown as SelectionScreen;
    const release = installSelectionHighlight(tui as unknown as TuiAltScreen);
    tui.selectionAnchor = { row: 0, col: 0 };
    tui.selectionFocus = { row: 0, col: 3, boundary: true };
    const row = "\x1b]8;;https://example.org/▄\x07one\x1b]8;;\x07";
    expect(tui.applySelection([row])[0]).toContain("\x1b]8;;https://example.org/▄\x07");
    release();
  });

  it("leaves unknown Pi method shapes alone and does not throw on a failed probe", () => {
    class Unknown { applySelectionHighlight(_text: string): string { throw new Error("new host shape"); } }
    const unknown = new Unknown();
    expect(() => installSelectionHighlight(unknown as unknown as TuiAltScreen)).not.toThrow();
    expect(() => unknown.applySelectionHighlight("x")).toThrow("new host shape");
  });

  it.each(["disabled band", "another editor"])("highlights with %s and releases on shutdown", mode => {
    const tui = new TuiAltScreen(terminal) as unknown as SelectionScreen;
    tui.selectionAnchor = { row: 0, col: 0 };
    tui.selectionFocus = { row: 0, col: 2, boundary: true };
    const before = tui.applySelection(["ok"])[0];
    const handlers = new Map<string, (event: unknown, ctx: unknown) => void>();
    const pi = { on: (name: string, handler: (event: unknown, ctx: unknown) => void) => handlers.set(name, handler) } as unknown as ExtensionAPI;
    const ctx = { cwd: "/project", mode: "tui", hasUI: true,
      ui: { theme: {} as Theme, setWidget: (_key: string, make: (tui: TuiAltScreen) => unknown) => make(tui as unknown as TuiAltScreen),
        getEditorComponent: () => mode === "another editor" ? () => undefined : undefined, setEditorComponent() {} } };
    registerInputBand(pi, { CustomEditor }, () => ({ "ui.inputBand": mode !== "disabled band" }));
    handlers.get("session_start")?.({ reason: "startup" }, ctx);
    expect(cells(tui.applySelection(["ok"])[0])[0].bg).toBe(blue);
    handlers.get("session_shutdown")?.({}, ctx);
    expect(tui.applySelection(["ok"])[0]).toBe(before);
  });

  it("patches each screen only while its binding is active", () => {
    const first = new TuiAltScreen(terminal) as unknown as SelectionScreen;
    const second = new TuiAltScreen(terminal) as unknown as SelectionScreen;
    for (const screen of [first, second]) {
      screen.selectionAnchor = { row: 0, col: 0 };
      screen.selectionFocus = { row: 0, col: 2, boundary: true };
    }
    const before = second.applySelection(["ok"])[0];
    const release1 = installSelectionHighlight(first as unknown as TuiAltScreen);
    const release2 = installSelectionHighlight(first as unknown as TuiAltScreen);
    release1();
    expect(cells(first.applySelection(["ok"])[0])[0].bg).toBe(blue);
    expect(second.applySelection(["ok"])[0]).toBe(before);
    release2();
    expect(first.applySelection(["ok"])[0]).toBe(before);
  });
});

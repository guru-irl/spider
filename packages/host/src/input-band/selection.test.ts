import { CustomEditor, Theme, type ExtensionAPI, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, TUI_KEYBINDINGS, TuiAltScreen, type EditorTheme, type Terminal } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { registerInputBand } from "./index.js";

// The screen is Pi's real fullscreen implementation. Only its terminal is inert.
type SelectionScreen = TuiAltScreen & {
  previousScreen: string[];
  selectionAnchor: { row: number; col: number };
  selectionFocus: { row: number; col: number; boundary?: boolean };
  applySelection(rows: string[]): string[];
  copySelectionToClipboard(): Promise<boolean>;
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
    ui: { theme, setEditorComponent: (value: typeof factory) => { factory = value; }, getEditorComponent: () => factory } };
  registerInputBand(pi, { CustomEditor }, () => ({}));
  handlers.get("session_start")?.({ reason: "startup" }, ctx);
  expect(factory).toBeDefined();
  factory!(tui, editorTheme, keys);
}

const blue = "rgb(58,71,100)";
describe("fullscreen selection", () => {
  it("draws clean selection backgrounds while copying the same bytes as Pi", async () => {
    const copied: string[] = [];
    const tui = new TuiAltScreen(terminal, false, undefined, { copySelection: text => { copied.push(text); return true; } }) as unknown as SelectionScreen;
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

    install(tui);
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
});

import { CustomEditor, Theme, type ExtensionAPI, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, KeybindingsManager, TUI_KEYBINDINGS, renderFakeCursor, stripTerminalSequences, visibleWidth, type EditorTheme, type TUI, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { DEFAULTS } from "../control.js";
import { CONFIG_SCHEMA } from "@spider/ui";
import glass from "../../../herdr/assets/themes/dracula-plus-glass.json" with { type: "json" };

const adapters = import.meta.glob<typeof import("./index.js")>("./index.ts", { eager: true });
const register = adapters["./index.ts"]?.registerInputBand;
const colors = Object.fromEntries(Object.entries(glass.colors).map(([role, value]) => [role, glass.vars[value as keyof typeof glass.vars] ?? value]));
const theme = new Theme(colors as ConstructorParameters<typeof Theme>[0], colors as ConstructorParameters<typeof Theme>[1], "truecolor");
const identity = (text: string) => text;
const editorTheme: EditorTheme = { borderColor: identity, selectList: {
  selectedPrefix: identity, selectedText: identity, description: identity, scrollInfo: identity, noMatch: identity,
} };
const tui = { terminal: { rows: 15 }, requestRender() {} } as unknown as TUI;
const keys = new KeybindingsManager({ ...TUI_KEYBINDINGS, "app.interrupt": { defaultKeys: "escape" } });
const stock = () => new CustomEditor(tui, editorTheme, keys);
const plain = (rows: string[]) => rows.map(stripTerminalSequences);
const BLUE = "\x1b[38;2;130;170;255m";
const GREEN = "\x1b[38;2;80;250;123m";
const STRIP = "\x1b[48;2;6;6;7m";

function session(existing?: typeof stock) {
  type Factory = Parameters<ExtensionUIContext["setEditorComponent"]>[0];
  let factory: Factory = existing;
  let config: Record<string, unknown> = {};
  const handlers = new Map<string, (evt: unknown, ctx: unknown) => void>();
  const pi = { on: (evt: string, handler: (evt: unknown, ctx: unknown) => void) => handlers.set(evt, handler) } as unknown as ExtensionAPI;
  const ctx = { cwd: "/project", mode: "tui", hasUI: true, ui: { theme, setEditorComponent: (next: Factory) => { factory = next; }, getEditorComponent: () => factory } };
  register?.(pi, { CustomEditor }, () => config);
  return {
    start: () => handlers.get("session_start")?.({}, ctx),
    stop: () => handlers.get("session_shutdown")?.({ reason: "reload" }, ctx),
    configure: (next: Record<string, unknown>) => { config = next; },
    factory: () => factory,
    editor: () => (factory?.(tui, editorTheme, keys) ?? stock()) as CustomEditor,
  };
}
function editor(text = ""): CustomEditor {
  const s = session(); s.start();
  const e = s.editor(); e.focused = true; e.setText(text); return e;
}
const click = (x: number, y: number, width: number, height: number): TuiMouseEvent => ({
  type: "click", button: "left", x, y, width, height, screenX: x, screenY: y, shift: false, alt: false, ctrl: false,
});

describe("input band", () => {
  it("draws two half edges and one opaque text row for empty or single-line input", () => {
    const e = editor("hello");
    const rows = e.render(16);
    expect(plain(rows)).toEqual([`▗${"▄".repeat(15)}`, "▐ hello         ", `▝${"▀".repeat(15)}`]);
    expect(rows[0]).toBe(`${BLUE}▗\x1b[39m\x1b[38;2;6;6;7m${"▄".repeat(15)}\x1b[39m`);
    expect(rows[1]).toContain(`${BLUE}▐\x1b[39m${STRIP} hello`);
    expect(rows[1]).toContain(CURSOR_MARKER);
    expect(rows[1]).toContain(renderFakeCursor(" "));
    expect(rows[2].startsWith(`${BLUE}▝\x1b[39m`)).toBe(true);
    e.setText("");
    expect(e.render(16)[1]).toContain(`▐\x1b[39m${STRIP} ${CURSOR_MARKER}`);
  });

  it.each(["!ls", "  !!pwd"])("keeps bash mode green for %s and ignores thinking colors", text => {
    const e = editor(text);
    e.borderColor = theme.getThinkingBorderColor("high");
    expect(e.render(24).every(row => row.startsWith(GREEN))).toBe(true);
    e.setText("normal");
    for (const level of ["off", "medium", "high", "max"] as const) {
      e.borderColor = theme.getThinkingBorderColor(level);
      expect(e.render(24).every(row => row.startsWith(BLUE))).toBe(true);
    }
  });

  it("draws each visible text row and replaces the scrolled edge with the hidden row count", () => {
    const e = editor(Array.from({ length: 8 }, (_, i) => `row ${i}`).join("\n"));
    const bottom = plain(e.render(24));
    expect(bottom[0].trimEnd()).toBe("▐ ↑ 3 more");
    expect(bottom.slice(1, -1).map(row => row.trimEnd())).toEqual(["▐ row 3", "▐ row 4", "▐ row 5", "▐ row 6", "▐ row 7"]);
    expect(bottom.at(-1)).toMatch(/^▝▀+$/u);
    for (let i = 0; i < 7; i++) e.handleInput("\x1b[A");
    const top = plain(e.render(24));
    expect(top[0]).toMatch(/^▗▄+$/u);
    expect(top.at(-1)?.trimEnd()).toBe("▐ ↓ 3 more");
  });

  it("reopens the strip background after a reset inside the row", () => {
    const e = editor("a\x1b[0mb");
    expect(e.render(24)[1]).toContain(`a\x1b[0m${STRIP}b`);
  });

  it("fits narrow widths with wide characters and keeps mouse cursor columns aligned", () => {
    const e = editor("界x\nnext");
    for (let w = 1; w <= 12; w++) expect(e.render(w).every(row => visibleWidth(row) <= w), `${w} columns`).toBe(true);
    const rows = e.render(16);
    expect(plain(rows)[1]).toMatch(/^▐ 界x/u);
    e.handleMouse(click(4, 1, 16, rows.length));
    expect(e.getCursor()).toEqual({ line: 0, col: 1 });
  });

  it("indents the autocomplete menu below the band and still accepts a click", async () => {
    const e = editor("/te");
    e.setAutocompleteProvider({
      getSuggestions: async () => ({ prefix: "/te", items: [{ value: "/test", label: "/test" }, { value: "/temp", label: "/temp" }] }),
      applyCompletion: (_lines, _line, _col, entry) => ({ lines: [entry.value], cursorLine: 0, cursorCol: entry.value.length }),
    });
    e.handleInput("\t");
    await vi.waitFor(() => expect(e.isShowingAutocomplete()).toBe(true));
    const rows = e.render(40);
    expect(plain(rows)[2]).toMatch(/^▝▀+$/u);
    const option = plain(rows).findIndex(row => row.includes("/temp"));
    expect(option).toBeGreaterThan(2);
    expect(rows[option].startsWith("  ")).toBe(true);
    expect(rows[option]).not.toContain(STRIP);
    e.handleMouse(click(4, option, 40, rows.length));
    expect(e.getText()).toBe("/temp");
  });

  it("does not replace another editor or leave the band installed after opting out", () => {
    const other = session(stock); other.start();
    expect(other.factory()).toBe(stock);
    const s = session(); s.start();
    expect(s.factory()).toBeDefined();
    s.stop(); s.configure({ "ui.inputBand": false }); s.start();
    expect(s.factory()).toBeUndefined();
    expect(plain(s.editor().render(12))[0]).toBe("─".repeat(12));
    expect(DEFAULTS["ui.inputBand"]).toBe(true);
    expect(CONFIG_SCHEMA.flatMap(group => group.fields).find(field => field.key === "ui.inputBand")).toMatchObject({ type: "boolean", default: true });
  });

  it("keeps Escape wired to Pi's interrupt action", () => {
    const e = editor();
    let interrupted = false;
    e.onEscape = () => { interrupted = true; };
    e.handleInput("\x1b");
    expect(interrupted).toBe(true);
  });
});

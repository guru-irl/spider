import { CustomEditor, Theme, type ExtensionAPI, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, KeybindingsManager, TUI_KEYBINDINGS, renderFakeCursor, stripTerminalSequences, visibleWidth, type EditorTheme, type TUI, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULTS } from "../control.js";
import { CONFIG_SCHEMA } from "@spider/ui";
import glass from "../../../herdr/assets/themes/dracula-plus-glass.json" with { type: "json" };

import { createBandEditor } from "./editor.js";
import { registerInputBand } from "./index.js";
const colors = Object.fromEntries(Object.entries(glass.colors).map(([role, value]) => [role, glass.vars[value as keyof typeof glass.vars] ?? value]));
const theme = new Theme(colors as ConstructorParameters<typeof Theme>[0], colors as ConstructorParameters<typeof Theme>[1], "truecolor");
const identity = (text: string) => text;
const editorTheme: EditorTheme = { borderColor: identity, selectList: {
  selectedPrefix: identity, selectedText: identity, description: identity, scrollInfo: identity, noMatch: identity,
} };
const tui = { terminal: { rows: 15 }, requestRender() {} } as unknown as TUI;
const keys = new KeybindingsManager({ ...TUI_KEYBINDINGS, "app.interrupt": { defaultKeys: "escape" } }) as unknown as ConstructorParameters<typeof CustomEditor>[2];
const stock = () => new CustomEditor(tui, editorTheme, keys);
const plain = (rows: string[]) => rows.map(stripTerminalSequences);
const BLUE = "\x1b[38;2;130;170;255m";
const GREEN = "\x1b[38;2;80;250;123m";
const STRIP = "\x1b[48;2;6;6;7m";

function session(existing?: typeof stock, register = registerInputBand) {
  type Factory = Parameters<ExtensionUIContext["setEditorComponent"]>[0];
  let factory: Factory = existing;
  let config: Record<string, unknown> = {};
  const handlers = new Map<string, (evt: unknown, ctx: unknown) => void>();
  const pi = { on: (evt: string, handler: (evt: unknown, ctx: unknown) => void) => handlers.set(evt, handler) } as unknown as ExtensionAPI;
  const buildContextEntries = vi.fn<() => unknown[]>(() => []);
  const ctx = { cwd: "/project", mode: "tui", hasUI: true, sessionManager: { buildContextEntries }, ui: { theme, setEditorComponent: (next: Factory) => { factory = next; }, getEditorComponent: () => factory } };
  register(pi, { CustomEditor }, () => config);
  return {
    start: (reason = "startup") => handlers.get("session_start")?.({ reason }, ctx),
    buildContextEntries,
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
  // The prompt history is process-wide on purpose; keep each test's history its own.
  afterEach(() => { (globalThis as Record<symbol, string[] | undefined>)[Symbol.for("spider.inputBand.history")]?.splice(0); });
  it("keeps pi's startup history after reimporting on reload and opening a new session", async () => {
    const first = session(); first.start();
    const original = first.editor();
    expect(first.buildContextEntries).not.toHaveBeenCalled(); // Pi seeds the editor after binding at startup.
    original.addToHistory(" startup prompt ");
    original.addToHistory(" latest prompt ");
    original.addToHistory("latest prompt");
    original.addToHistory(" ");
    first.stop();
    vi.resetModules();
    const reloaded = session(undefined, (await import("./index.js")).registerInputBand);
    for (const reason of ["reload", "new"]) {
      reloaded.start(reason);
      const restored = reloaded.editor();
      restored.handleInput("\x1b[A");
      expect(restored.getText()).toBe("latest prompt");
      restored.handleInput("\x1b[A");
      expect(restored.getText()).toBe("startup prompt");
      reloaded.stop();
    }
  });

  it.each(["resume", "fork", "new"])("replays user prompts in context order on %s", reason => {
    const s = session(); s.start();
    s.editor().addToHistory("previous session prompt");
    s.stop();
    s.buildContextEntries.mockReturnValue([
      { type: "message", message: { role: "user", content: "first on branch" } },
      { type: "message", message: { role: "assistant", content: [] } },
      { type: "message", message: { role: "user", content: [
        { type: "text", text: "latest" }, { type: "image" }, { type: "text", text: " on branch" },
      ] } },
    ]);
    s.start(reason);
    const editor = s.editor();
    for (const text of ["latest on branch", "first on branch", "previous session prompt"]) {
      editor.handleInput("\x1b[A");
      expect(editor.getText()).toBe(text);
    }
  });
  it("draws two half edges and one opaque text row for empty or single-line input", () => {
    const e = editor("hello");
    const rows = e.render(16);
    expect(plain(rows)).toEqual([`${"▄".repeat(16)}`, "▌ hello         ", `${"▀".repeat(16)}`]);
    expect(rows[0]).toBe(`\x1b[38;2;6;6;7m${"▄".repeat(16)}\x1b[39m`);
    expect(rows[1]).toContain(`${STRIP}${BLUE}▌\x1b[39m`);
    expect(rows[1]).toMatch(/ +\x1b\[49m$/u);
    expect(rows.map(visibleWidth)).toEqual([16, 16, 16]);
    expect(rows[1]).toContain(CURSOR_MARKER);
    expect(rows[1]).toContain(renderFakeCursor(" "));
    expect(rows[2]).toBe(`\x1b[38;2;6;6;7m${"▀".repeat(16)}\x1b[39m`);
    e.setText("");
    expect(e.render(16)[1]).toContain(`▌\x1b[39m ${CURSOR_MARKER}`);
  });

  it.each(["!ls", "  !!pwd"])("keeps bash mode green for %s and ignores thinking colors", text => {
    const e = editor(text);
    e.borderColor = theme.getThinkingBorderColor("high");
    expect(e.render(24)[1]).toContain(`${STRIP}${GREEN}▌`);
    e.setText("normal");
    for (const level of ["off", "medium", "high", "max"] as const) {
      e.borderColor = theme.getThinkingBorderColor(level);
      expect(e.render(24)[1]).toContain(`${STRIP}${BLUE}▌`);
    }
  });

  it("draws each visible text row and replaces the scrolled edge with the hidden row count", () => {
    const e = editor(Array.from({ length: 8 }, (_, i) => `row ${i}`).join("\n"));
    const bottom = plain(e.render(24));
    expect(bottom[0].trimEnd()).toBe("▌ ↑ 3 more");
    expect(bottom.slice(1, -1).map(row => row.trimEnd())).toEqual(["▌ row 3", "▌ row 4", "▌ row 5", "▌ row 6", "▌ row 7"]);
    expect(bottom.at(-1)).toMatch(/^▀+$/u);
    for (let i = 0; i < 7; i++) e.handleInput("\x1b[A");
    const top = plain(e.render(24));
    expect(top[0]).toMatch(/^▄+$/u);
    expect(top.at(-1)?.trimEnd()).toBe("▌ ↓ 3 more");
  });

  it("reopens the strip background after a reset inside the row", () => {
    const e = editor("a\x1b[0mb");
    expect(e.render(24)[1]).toContain(`a\x1b[0m${STRIP}b`);
  });

  it("fits narrow widths with wide characters and keeps mouse cursor columns aligned", () => {
    const e = editor("界x\nnext");
    for (let w = 1; w <= 12; w++) expect(e.render(w).every(row => visibleWidth(row) <= w), `${w} columns`).toBe(true);
    const rows = e.render(16);
    expect(plain(rows)[1]).toMatch(/^▌ 界x/u);
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
    expect(plain(rows)[2]).toMatch(/^▀+$/u);
    const option = plain(rows).findIndex(row => row.includes("/temp"));
    expect(option).toBeGreaterThan(2);
    expect(rows[option].startsWith("  ")).toBe(true);
    expect(rows[option]).not.toContain(STRIP);
    expect(e.handleMouse(click(0, option, 40, rows.length))).toBeUndefined();
    expect(e.getText()).toBe("/te");
    expect(e.handleMouse(click(0, 1, 40, rows.length))).toMatchObject({ focus: true });
    expect(e.getCursor()).toEqual({ line: 0, col: 0 });
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

  it("uses the configured padding in the stock fallback but not in the strip", () => {
    const unpainted = { getBgAnsi: () => "\x1b[49m" } as unknown as Theme;
    let activeTheme = unpainted;
    const Band = createBandEditor(CustomEditor);
    const e = new Band(tui, editorTheme, keys, () => activeTheme);
    e.setText("hello"); e.setPaddingX(3);
    expect(plain(e.render(24))[1]).toMatch(/^ {3}hello/u);
    activeTheme = theme;
    expect(plain(e.render(24))[1]).toMatch(/^▌ hello/u);
    activeTheme = unpainted;
    e.setPaddingX(2);
    expect(plain(e.render(24))[1]).toMatch(/^ {2}hello/u);
    e.setText("界");
    for (let w = 1; w <= 5; w++) expect(e.render(w).every(row => visibleWidth(row) <= w)).toBe(true);
  });

  it("lays out only once per keystroke after encountering an unknown host border shape", () => {
    const widths: number[] = [];
    class HostEditor extends CustomEditor {
      override render(width: number) {
        widths.push(width);
        const rows = super.render(width);
        rows[0] = "unknown border";
        return rows;
      }
    }
    const Band = createBandEditor(HostEditor);
    const e = new Band(tui, editorTheme, keys, () => theme);
    e.setPaddingX(2);
    e.render(24); // Probe once; this host's output cannot be decorated.
    widths.length = 0;
    e.handleInput("x"); e.render(24);
    e.handleInput("y");
    const edited = e.render(30);
    expect(widths).toEqual([24, 30]);
    expect(plain(edited)[1]).toMatch(/^ {2}xy/u);
  });

  it("keeps Escape wired to Pi's interrupt action", () => {
    const e = editor();
    let interrupted = false;
    e.onEscape = () => { interrupted = true; };
    e.handleInput("\x1b");
    expect(interrupted).toBe(true);
  });
});

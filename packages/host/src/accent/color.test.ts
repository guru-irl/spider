import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Theme, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext, type ExtensionUIContext, type KeybindingsManager as PiKeybindingsManager, type SessionStartEvent } from "@earendil-works/pi-coding-agent";
import { colorToHex, KeybindingsManager, stripTerminalSequences, TUI_KEYBINDINGS, TuiAltScreen, truncateToWidth, visibleWidth, type Terminal } from "@earendil-works/pi-tui";
import { paths } from "@spider/db-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { registerAccentPicker } from "./index.js";

const shipped = JSON.parse(readFileSync(new URL("../../../herdr/assets/themes/dracula-plus-glass.json", import.meta.url), "utf8")) as {
  name: string; vars: Record<string, string>; colors: Record<string, string>;
};
const colors = Object.fromEntries(Object.entries(shipped.colors).map(([key, value]) => [key, shipped.vars[value] ?? value]));
const shippedTheme = () => new Theme(colors as ConstructorParameters<typeof Theme>[0], colors as ConstructorParameters<typeof Theme>[1], "truecolor", { name: shipped.name });
const file = () => join(paths.globalRoot, "config.json");
const stored = () => JSON.parse(readFileSync(file(), "utf8"));
const originalRoot = paths.globalRoot;
const sessions: Array<() => void> = [];
beforeEach(() => {
  mkdirSync(originalRoot, { recursive: true });
  paths.globalRoot = mkdtempSync(join(originalRoot, "color-"));
  vi.stubEnv("GIT_CEILING_DIRECTORIES", originalRoot);
  writeFileSync(file(), '{"ui.icons":"nerd"}');
});
afterEach(() => {
  for (const stop of sessions.splice(0)) stop();
  rmSync(paths.globalRoot, { recursive: true, force: true });
  paths.globalRoot = originalRoot;
  vi.unstubAllEnvs();
});

function session(initial = shippedTheme(), { columns = 100, rows = 10, cwd = paths.globalRoot } = {}) {
  let input: (data: string) => void = () => {};
  const noop = () => {};
  const terminal: Terminal = {
    columns, rows, kittyProtocolActive: false, start: handler => { input = handler; },
    stop: noop, drainInput: async () => {}, write: noop, moveBy: noop, hideCursor: noop, showCursor: noop,
    clearLine: noop, clearFromCursor: noop, clearScreen: noop, setTitle: noop, setProgress: noop, setProgramStatus: noop,
  };
  const tui = new TuiAltScreen(terminal, false);
  // The picker uses the inherited TUI keybindings, not Pi's settings file.
  const keys = new KeybindingsManager(TUI_KEYBINDINGS) as PiKeybindingsManager;
  let theme = initial;
  // Pi gives extensions a live proxy, not a snapshot of the Theme instance.
  const themeProxy = new Proxy({} as Theme, { get: (_target, key) => Reflect.get(theme, key, theme) });
  const notices: string[] = [];
  const ui: Pick<ExtensionUIContext, "theme" | "notify" | "getTheme" | "setTheme" | "custom"> = {
    theme: themeProxy, notify: message => notices.push(message), getTheme: name => name === initial.name ? initial : undefined,
    setTheme(next) {
      if (!(next instanceof Theme)) return { success: false, error: "Expected Pi's Theme instance" };
      theme = next;
      tui.invalidate();
      tui.requestRender();
      return { success: true };
    },
    custom: (factory, options) => new Promise((resolve, reject) => {
      expect(options?.overlay).toBe(true);
      let close: (() => void) | undefined;
      const component = factory(tui, themeProxy, keys, value => { close?.(); resolve(value); });
      void Promise.resolve(component).then(picker => {
        const overlay = options?.overlayOptions;
        const handle = tui.showOverlay(picker, typeof overlay === "function" ? overlay() : overlay);
        close = () => { handle.hide(); picker.dispose?.(); };
        options?.onHandle?.(handle);
      }).catch(reject);
    }),
  };
  const ctx = { cwd, mode: "tui", hasUI: true, ui } as ExtensionCommandContext;
  const start: Array<(event: SessionStartEvent, ctx: ExtensionContext) => unknown> = [];
  const commands = new Map<string, (args: string, ctx: ExtensionCommandContext) => unknown>();
  registerAccentPicker({
    on: (event: string, handler: never) => { if (event === "session_start") start.push(handler); },
    registerCommand: (name: string, definition: { handler: never }) => { commands.set(name, definition.handler); },
  } as Pick<ExtensionAPI, "on" | "registerCommand">);
  tui.addChild({
    invalidate() {},
    render: width => [truncateToWidth(`${" ".repeat(45)}${theme.fg("accent", "Transcript stays visible")}`, width, "")],
  });
  tui.start();
  sessions.push(() => tui.stop());
  return {
    notices,
    color: () => colorToHex(theme.colors.accent),
    theme: () => theme,
    start: async (reason: SessionStartEvent["reason"] = "startup") => {
      for (const handler of start) await handler({ type: "session_start", reason }, ctx);
    },
    command: async (args = "") => commands.get("color")!(args, ctx),
    open: async () => {
      const done = commands.get("color")!("", ctx);
      await Promise.resolve(); // Wait for the custom component to mount, not for it to close.
      return { done };
    },
    screen: () => { tui.renderNow(); return tui.getScreenLines(); },
    input: (data: string) => input(data),
  };
}

it("opens a full-height left overlay and renders a scrollbar only when needed", async () => {
  const s = session();
  const { done } = await s.open();
  const screen = s.screen().map(stripTerminalSequences);
  expect(screen).toHaveLength(10);
  expect(screen[0]).toMatch(/^\s*Accent color/i);
  expect(screen.join("\n")).toMatch(/██\s+Spider Blue\s+#82aaff/);
  expect(screen.join("\n")).toContain("Transcript stays visible");
  expect(screen.some(line => line.includes("┃"))).toBe(true);
  expect(screen.some(line => line.includes("│"))).toBe(true);
  s.input("\x1b");
  await done;
  const tall = session(undefined, { rows: 27 });
  const opened = await tall.open();
  const lines = tall.screen().map(stripTerminalSequences);
  expect(lines.join("\n")).toContain("Bright Purple");
  expect(lines.some(line => line.includes("┃"))).toBe(false);
  expect(lines.at(-1)).toContain("Esc");
  tall.input("\x1b");
  await opened.done;
});

it("previews keyboard movement and restores the accent on Esc without saving", async () => {
  const s = session();
  await s.command("pink");
  const { done } = await s.open();
  s.screen();
  s.input("\x1b[B");
  expect(s.color()).toBe("#8be9fd");
  expect(s.screen().join("\n")).toContain("\x1b[38;2;139;233;253mTranscript stays visible");
  s.input("\x1b[A");
  expect(s.color()).toBe("#ff79c6");
  s.input("\x1b[B");
  expect(stored()).toEqual({ "ui.icons": "nerd", "ui.accent": "pink" });
  s.input("\x1b");
  await done;
  expect(s.color()).toBe("#ff79c6");
  expect(stored()["ui.accent"]).toBe("pink");
});

it("uses Pi hit testing for clicks and wheel, keeps off-panel input out of the picker, and saves on Enter", async () => {
  const s = session();
  const { done } = await s.open();
  const lines = s.screen().map(stripTerminalSequences);
  const header = lines.findIndex(line => line.includes("Dracula"));
  const pink = lines.findIndex(line => line.includes("#ff79c6"));
  expect(header).toBeGreaterThan(0);
  expect(pink).toBeGreaterThan(header);
  const click = (x: number, y: number) => {
    s.input(`\x1b[<0;${x};${y + 1}M`);
    s.input(`\x1b[<0;${x};${y + 1}m`);
  };
  click(5, header);
  click(70, pink);
  s.input(`\x1b[<65;70;${pink + 1}M`);
  expect(s.color()).toBe("#82aaff");
  click(5, pink);
  expect(s.color()).toBe("#ff79c6");
  expect(stored()["ui.accent"]).toBeUndefined();
  s.screen();
  s.input(`\x1b[<65;5;${pink + 1}M`);
  expect(s.color()).toBe("#8be9fd");
  s.input("\r");
  await done;
  expect(stored()["ui.accent"]).toBe("cyan");
  expect(s.screen().map(stripTerminalSequences).join("\n")).not.toContain("Spider Blue");
});

it("reveals the current choice on a short terminal and fits a narrow overlay", async () => {
  const s = session(undefined, { columns: 32, rows: 5 });
  await s.command("bright purple");
  const { done } = await s.open();
  const screen = s.screen();
  expect(screen.map(stripTerminalSequences).join("\n")).toContain("#d6acff");
  expect(screen.every(line => visibleWidth(line) <= 32)).toBe(true);
  s.input("\x1b");
  await done;
});

it("accepts named colors regardless of case, rejects unknown colors, and resets to Spider blue", async () => {
  const s = session();
  await s.command("  Plus PURPLE  ");
  expect(s.color()).toBe("#c792ea");
  await s.command("not a color");
  expect(s.notices.at(-1)).toMatch(/unknown/i);
  expect(s.color()).toBe("#c792ea");
  expect(stored()["ui.accent"]).toBe("plus-purple");
  await s.command("reset");
  expect(s.color()).toBe("#82aaff");
  expect(stored()).toEqual({ "ui.icons": "nerd" });
  const other = session();
  await other.start();
  expect(other.color()).toBe("#82aaff");
});

it.each(["startup", "new", "resume", "reload", "fork"] as const)("reapplies the saved accent on %s after the installed theme is refreshed", async reason => {
  const original = session();
  await original.command("green");
  vi.stubEnv("PI_SUBAGENT_CHILD", "1");
  const differentProject = join(paths.globalRoot, "different-project");
  mkdirSync(join(differentProject, ".spider"), { recursive: true });
  writeFileSync(join(differentProject, ".spider/config.json"), '{"ui.accent":"red"}');
  const next = session(shippedTheme(), { cwd: differentProject });
  expect(next.color()).toBe("#82aaff");
  await next.start(reason);
  expect(next.color()).toBe("#50fa7b");
});

it("keeps the neutral row fill and derives a darker rail from the live accent", async () => {
  const s = session(undefined, { rows: 27 });
  const { done } = await s.open();
  s.screen();
  s.input("\x1b[B"); // purple
  s.input("\x1b[B"); // pink
  const pink = s.screen().find(line => line.includes("#ff79c6"))!;
  expect(pink).toContain("\x1b[48;2;41;41;42m");
  expect(pink).toContain("\x1b[38;2;139;72;111m");
  s.input("\x1b[B"); // cyan
  s.input("\x1b[B"); // green
  const green = s.screen().find(line => line.includes("#50fa7b"))!;
  expect(green).toContain("\x1b[48;2;41;41;42m");
  expect(green).toContain("\x1b[38;2;51;136;74m");
  s.input("\x1b");
  await done;
});

it("changes accent foregrounds but preserves terminal defaults, semantic colors and other roles", async () => {
  const s = session();
  const before = s.theme();
  await s.command("pink");
  const after = s.theme();
  expect(after.fg("borderAccent", "border")).toBe("\x1b[38;2;255;121;198mborder\x1b[39m");
  expect(after.fg("customMessageLabel", "label")).toBe("\x1b[38;2;255;121;198mlabel\x1b[39m");
  expect(after.getFgAnsi("text")).toBe("\x1b[39m");
  for (const token of ["thinkingMedium", "success", "error", "warning", "mdLink", "syntaxKeyword"] as const) {
    expect(after.fg(token, "x")).toBe(before.fg(token, "x"));
  }
  expect(after.bg("selectedBg", "x")).toBe(before.bg("selectedBg", "x"));
});

it("restores the preview when the config cannot be saved", async () => {
  const s = session();
  const { done } = await s.open();
  s.screen();
  s.input("\x1b[B");
  expect(s.color()).toBe("#bd93f9");
  writeFileSync(file(), "not JSON");
  s.input("\r");
  await done;
  expect(s.color()).toBe("#82aaff");
  expect(readFileSync(file(), "utf8")).toBe("not JSON");
  expect(s.notices.at(-1)).toMatch(/save/i);
});

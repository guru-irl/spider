import { AssistantMessageComponent, CustomEditor, ToolExecutionComponent, UserMessageComponent, Theme, initTheme } from "@earendil-works/pi-coding-agent";
import { Box, Markdown, Spacer, Text, TuiAltScreen, stripTerminalSequences, visibleWidth, type Component, type Terminal } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { registerInputBand } from "./index.js";
import { registerCopyButtons } from "../copy-buttons/index.js";
import glass from "../../../herdr/assets/themes/dracula-plus-glass.json" with { type: "json" };

const colors = Object.fromEntries(Object.entries(glass.colors).map(([role, value]) => [role, glass.vars[value as keyof typeof glass.vars] ?? value]));
const theme = new Theme(colors as ConstructorParameters<typeof Theme>[0], colors as ConstructorParameters<typeof Theme>[1], "truecolor");
const ms = Date.parse("2024-01-03T08:15:00Z");
const user = (text: string, timestamp = ms) => ({ role: "user" as const, content: [{ type: "text" as const, text }], timestamp });
let stop: (() => void) | undefined;

function fixture(entries: Record<string, unknown> = {}) {
  initTheme("dark");
  let input: (data: string) => void = () => {};
  const terminal = { columns: 48, rows: 24, kittyProtocolActive: false,
    start: (onInput: (data: string) => void) => { input = onInput; }, stop() {}, write() {}, hideCursor() {}, showCursor() {},
    moveBy() {}, clearLine() {}, clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {}, setProgramStatus() {}, drainInput: async () => {},
  } satisfies Terminal;
  const tui = new TuiAltScreen(terminal, false);
  const handlers = new Map<string, Array<(event: any, ctx: any) => void>>();
  const pi = { on: (name: string, handler: (event: any, ctx: any) => void) => handlers.set(name, [...(handlers.get(name) ?? []), handler]) };
  const ctx = { cwd: "/project", mode: "tui", hasUI: true, sessionManager: { getEntry: (id: string) => entries[id] },
    ui: { theme, setEditorComponent() {}, getEditorComponent: () => undefined, notify() {},
      setWidget: (_key: string, make: (tui: TuiAltScreen) => Component) => { make(tui); } } };
  const emit = (name: string, event: unknown) => handlers.get(name)?.forEach(handler => handler(event, ctx));
  registerInputBand(pi as never, { CustomEditor, UserMessageComponent, Box, Markdown, Text }, () => ({}));
  registerCopyButtons(pi as never, { AssistantMessageComponent, ToolExecutionComponent, Markdown, Spacer }, () => ({}), async () => {});
  emit("session_start", { reason: "startup" });
  tui.start();
  stop = () => { emit("session_shutdown", { reason: "reload" }); tui.stop({ preserveScreen: true }); };
  const live = (text: string, timestamp = ms) => {
    emit("message_start", { message: user(text, timestamp) });
    const component = new UserMessageComponent(text);
    emit("message_end", { message: user(text, timestamp) });
    tui.addChild(component);
    return component;
  };
  const add = (component: Component) => { tui.addChild(component); return component; };
  const screen = () => { tui.renderNow(); return tui.getScreenLines().map(stripTerminalSequences); };
  const point = (text: string) => {
    const lines = screen();
    const y = lines.findIndex(line => line.includes(text));
    if (y < 0) throw new Error(`Not on screen: ${text}`);
    return { x: lines[y].indexOf(text), y };
  };
  const move = (text: string) => { const { x, y } = point(text); input(`\x1b[<35;${x + 1};${y + 1}M`); };
  return { tui, emit, live, add, screen, move };
}

beforeEach(() => { vi.stubEnv("TZ", "America/New_York"); });
afterEach(() => { stop?.(); stop = undefined; vi.unstubAllEnvs(); });

it("shows the sent time only in the bottom hover border without moving the band", () => {
  const app = fixture();
  const message = app.live("Hello there");
  app.add(new Text("Outside message", 0, 0));
  const before = message.render(48).map(stripTerminalSequences);
  expect(before.join("\n")).not.toContain("Jan 3 03:15");
  app.move("Hello there");
  const hovered = message.render(48).map(stripTerminalSequences);
  expect(hovered[0]).toMatch(/^╭─+╮$/u);
  expect(hovered.at(-1)).toMatch(/^╰Jan 3 03:15─+╯$/u);
  expect(hovered.slice(1, -1)).toEqual(before.slice(1, -1).map(row => `│${row.slice(1, -1)}│`));
  expect(hovered[1]).toBe(`│${"▄".repeat(46)}│`);
  expect(hovered.at(-2)).toBe(`│${"▀".repeat(46)}│`);
  expect(hovered).toHaveLength(before.length);
  expect(hovered.every(row => visibleWidth(row) === 48)).toBe(true);
  expect(hovered.join("\n")).not.toContain("□ text");
  app.move("Outside message");
  expect(message.render(48).map(stripTerminalSequences)).toEqual(before);
});

it("keeps distinct live timestamps and uses the persisted message timestamp on restore", () => {
  const app = fixture({ original: { type: "message", message: user("Restored") } });
  app.live("First");
  app.live("Second", ms + 60_000);
  app.add(new UserMessageComponent("Restored", undefined, 1, [], "original", "2024-01-04T00:00:00Z"));
  app.move("First"); expect(app.screen().join("\n")).toContain("Jan 3 03:15");
  app.move("Second"); expect(app.screen().join("\n")).toContain("Jan 3 03:16");
  app.move("Restored"); expect(app.screen().join("\n")).toContain("Jan 3 03:15");
});

it("leaves clicks outside its targets to Pi", () => {
  const app = fixture();
  const message = app.live("Clickable");
  app.move("Clickable");
  const lines = message.render(48);
  expect(message.handleMouse({ type: "click", button: "left", x: 2, y: 2, screenX: 2, screenY: 2, width: 48, height: lines.length, shift: false, alt: false, ctrl: false })).toBeUndefined();
});

it("preserves text and widths at narrow sizes and does not invent an unavailable time", () => {
  const app = fixture({ bad: { type: "message", message: user("Bad time", Number.NaN) } });
  const message = app.add(new UserMessageComponent("Bad time", undefined, 1, [], "bad", "2024-01-04T00:00:00Z"));
  app.move("Bad time");
  expect(message.render(48).map(stripTerminalSequences).join("\n")).not.toMatch(/\d\d:\d\d/u);
  for (let width = 1; width <= 30; width++) expect(message.render(width).every(row => visibleWidth(row) <= width), `${width} columns`).toBe(true);
});

it("reformats a hovered timestamp after a time-zone change", () => {
  const app = fixture();
  app.live("Zone");
  app.move("Zone");
  expect(app.screen().join("\n")).toContain("Jan 3 03:15");
  vi.stubEnv("TZ", "UTC");
  expect(app.screen().join("\n")).toContain("Jan 3 08:15");
});

import { CustomEditor, UserMessageComponent, Theme, initTheme } from "@earendil-works/pi-coding-agent";
import { Box, Markdown, Text, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { registerInputBand } from "./index.js";
import glass from "../../../herdr/assets/themes/dracula-plus-glass.json" with { type: "json" };

const colors = Object.fromEntries(Object.entries(glass.colors).map(([role, value]) => [role, glass.vars[value as keyof typeof glass.vars] ?? value]));
const theme = new Theme(colors as ConstructorParameters<typeof Theme>[0], colors as ConstructorParameters<typeof Theme>[1], "truecolor");
initTheme("dark");

const host = { CustomEditor, UserMessageComponent, Box, Markdown, Text };
const ms = Date.parse("2024-01-03T08:15:00Z");
const user = (text: string, timestamp = ms) => ({ role: "user" as const, content: [{ type: "text" as const, text }], timestamp });
let stop: (() => void) | undefined;

function activate(entries: Record<string, unknown> = {}) {
  const handlers = new Map<string, (event: any, ctx: any) => void>();
  const pi = { on: (name: string, handler: (event: any, ctx: any) => void) => handlers.set(name, handler) };
  const ctx = { cwd: "/project", mode: "tui", hasUI: true, sessionManager: { getEntry: (id: string) => entries[id] },
    ui: { theme, setEditorComponent() {}, getEditorComponent: () => undefined } };
  registerInputBand(pi as never, host, () => ({}));
  handlers.get("session_start")?.({ reason: "startup" }, ctx);
  stop = () => handlers.get("session_shutdown")?.({ reason: "reload" }, ctx);
  return (name: string, event: unknown) => handlers.get(name)?.(event, ctx);
}
const rows = (component: UserMessageComponent, width: number) => component.render(width).map(stripTerminalSequences);
const restored = (text: string, id: string) => new UserMessageComponent(text, undefined, 1, [], id, "2024-01-04T00:00:00Z");

beforeEach(() => { vi.stubEnv("TZ", "America/New_York"); });
afterEach(() => { stop?.(); stop = undefined; vi.unstubAllEnvs(); });

it("uses the live message's sent time, not the render time, for identical prompts", () => {
  const emit = activate();
  emit("message_start", { message: user("Hello") });
  const first = new UserMessageComponent("Hello");
  emit("message_end", { message: user("Hello") });
  emit("message_start", { message: user("Hello", ms + 60_000) });
  const second = new UserMessageComponent("Hello");
  emit("message_end", { message: user("Hello", ms + 60_000) });
  expect(rows(first, 48)[1]).toMatch(/^ ❯ Hello\s+Jan 3 03:15 $/u);
  expect(rows(second, 48)[1]).toMatch(/^ ❯ Hello\s+Jan 3 03:16 $/u);
});

it("uses the restored message timestamp rather than the entry creation time", () => {
  activate({ original: { type: "message", message: user("Restored") } });
  expect(rows(restored("Restored", "original"), 48)[1]).toMatch(/^ ❯ Restored\s+Jan 3 03:15 $/u);
});

it("wraps long and wide text before the time without losing text or crossing the terminal width", () => {
  const text = "界界界 a long first line of text that must wrap before its timestamp remains visible";
  const emit = activate();
  emit("message_start", { message: user(text) });
  const message = new UserMessageComponent(text);
  emit("message_end", { message: user(text) });
  const rendered = rows(message, 40);
  expect(rendered[1]).toMatch(/^ ❯ .+\s+Jan 3 03:15 $/u);
  expect(rendered.every(row => visibleWidth(row) <= 40)).toBe(true);
  const textRows = rendered.slice(1, -1).map(row => row.replace("Jan 3 03:15", "").replace(/^ ❯ /u, "").trim());
  expect(textRows.join(" ").replace(/\s+/gu, " ")).toBe(text);
});

it("keeps a timestamp bound to a skill's displayed user text", () => {
  const text = '<skill name="review" location="/skill">\nInstructions\n</skill>\n\nReview this';
  const emit = activate();
  emit("message_start", { message: user(text) });
  const message = new UserMessageComponent("Review this");
  emit("message_end", { message: user(text) });
  expect(rows(message, 48)[1]).toMatch(/^ ❯ Review this\s+Jan 3 03:15 $/u);
});

it("omits an unavailable or invalid time rather than inventing one", () => {
  activate({ bad: { type: "message", message: user("Bad time", Number.NaN) } });
  expect(rows(new UserMessageComponent("No event"), 48)[1]).not.toMatch(/\d\d:\d\d/u);
  expect(rows(restored("Bad time", "bad"), 48)[1]).not.toMatch(/\d\d:\d\d/u);
});

it("keeps narrow messages readable and drops the time when there is no room", () => {
  const emit = activate();
  emit("message_start", { message: user("Long example") });
  const message = new UserMessageComponent("Long example");
  emit("message_end", { message: user("Long example") });
  for (let width = 1; width <= 30; width++) {
    expect(rows(message, width).every(row => visibleWidth(row) <= width), `${width} columns`).toBe(true);
  }
  expect(rows(message, 12).join("\n")).not.toContain("Jan 3");
});

it("keeps Pi's Markdown and OSC markers while rendering the dim time on the strip", () => {
  const emit = activate();
  const text = "**Bold** and `code`";
  emit("message_start", { message: user(text) });
  const message = new UserMessageComponent(text);
  emit("message_end", { message: user(text) });
  const output = message.render(48);
  expect(stripTerminalSequences(output[1])).toMatch(/^ ❯ Bold and code\s+Jan 3 03:15 $/u);
  expect(output[0]).toContain("\x1b]133;A\x07");
  expect(output.at(-1)).toContain("\x1b]133;B\x07\x1b]133;C\x07");
  expect(output[1]).toContain("\x1b[2mJan 3 03:15\x1b[22m");
});

it("retains live timestamps on existing components after reload", () => {
  const emit = activate();
  emit("message_start", { message: user("Before reload") });
  const message = new UserMessageComponent("Before reload");
  emit("message_end", { message: user("Before reload") });
  stop?.();
  activate();
  expect(rows(message, 48)[1]).toContain("Jan 3 03:15");
});

it("reformats the same timestamp after a time-zone change", () => {
  activate({ original: { type: "message", message: user("Hello") } });
  const message = restored("Hello", "original");
  expect(rows(message, 48)[1]).toContain("Jan 3 03:15");
  vi.stubEnv("TZ", "UTC");
  expect(rows(message, 48)[1]).toContain("Jan 3 08:15");
});

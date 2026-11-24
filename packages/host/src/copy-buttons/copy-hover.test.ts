import { afterEach, describe, expect, it, vi } from "vitest";
import { AssistantMessageComponent } from "@earendil-works/pi-coding-agent";
import { Markdown, Text, TuiAltScreen, getCapabilities, setCapabilities, stripTerminalSequences, visibleWidth, type Component, type MarkdownTheme, type Terminal, type TuiMouseEvent } from "@earendil-works/pi-tui";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { installCopyButtons, registerCopyButtons } from "./index.js";

const identity = (text: string) => text;
const theme: MarkdownTheme = {
  heading: identity, link: identity, linkUrl: identity, code: identity, codeBlock: identity,
  codeBlockBorder: identity, quote: identity, quoteBorder: identity, hr: identity,
  listBullet: identity, bold: identity, italic: identity, strikethrough: identity, underline: identity,
};
const message = (text: string, timestamp = Date.UTC(2024, 0, 3, 8, 15)): AssistantMessage => ({
  role: "assistant", content: [{ type: "text", text }], api: "openai-completions", provider: "test", model: "test",
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  stopReason: "stop", timestamp,
});
function fixture(text: string, timestamp?: number, fullscreen = true) {
  const copied: string[] = [];
  const requestRender = vi.fn();
  installCopyButtons({ AssistantMessageComponent, Markdown }, {
    isFullscreen: () => fullscreen,
    copy: async value => { copied.push(value); },
    requestRender,
    onError: error => { throw error; },
  });
  const assistant = new AssistantMessageComponent(undefined, false, theme, undefined, 0);
  assistant.updateContent(message(text, timestamp), false);
  const children = (assistant as unknown as { contentContainer: { children: Component[] } }).contentContainer.children;
  const md = children.find(child => child instanceof Markdown);
  if (!(md instanceof Markdown)) throw new Error("assistant has no Markdown");
  return { assistant, md, copied, requestRender };
}
function render(md: Markdown, width = 60): string[] {
  return md.render(width).map(stripTerminalSequences);
}
function mouse(md: Markdown, type: TuiMouseEvent["type"], x = 1, y = 0) {
  const lines = render(md);
  const event: TuiMouseEvent = { type, button: "none", x, y, screenX: x, screenY: y, width: 60, height: lines.length, shift: false, alt: false, ctrl: false };
  return (md as Component).handleMouse?.(event);
}

const running: TuiAltScreen[] = [];
function fullscreenFixture(long = false) {
  let input: (data: string) => void = () => {};
  let resize: () => void = () => {};
  const terminal = {
    columns: 60, rows: 18, kittyProtocolActive: false,
    start: (onInput: (data: string) => void, onResize: () => void) => { input = onInput; resize = onResize; },
    stop: () => {}, write: () => {}, hideCursor: () => {}, showCursor: () => {},
    moveBy: () => {}, clearLine: () => {}, clearFromCursor: () => {}, clearScreen: () => {},
    setTitle: () => {}, setProgress: () => {}, setProgramStatus: () => {}, drainInput: async () => {},
  } satisfies Terminal;
  const selected: string[] = [];
  const opened: string[] = [];
  const tui = new TuiAltScreen(terminal, false, undefined, {
    copySelection: async text => { selected.push(text); return true; },
    openUrl: url => { opened.push(url); },
  });
  running.push(tui);
  const events = new Map<string, (event: unknown, ctx: unknown) => void>();
  const pi = { on: (name: string, handler: (event: unknown, ctx: unknown) => void) => events.set(name, handler) };
  const copied: string[] = [];
  registerCopyButtons(pi as never, { AssistantMessageComponent, Markdown }, () => ({}), async text => { copied.push(text); });
  const uiTheme = { fg: (token: string, text: string) => token === "borderMuted" ? `\x1b[38;5;245m${text}\x1b[39m` : text };
  let widget: (Component & { dispose?: () => void }) | undefined;
  const context = { mode: "tui", hasUI: true, cwd: "/project", ui: {
    theme: uiTheme, setWidget: (_key: string, make: (tui: TuiAltScreen, theme: unknown) => Component & { dispose?: () => void }) => {
      widget?.dispose?.();
      widget = make(tui, uiTheme);
    }, notify: () => {},
  } };
  events.get("session_start")?.({}, context);
  const assistant = new AssistantMessageComponent(undefined, false, theme, undefined, 0);
  assistant.updateContent(message("Hello there"), false);
  if (long) tui.addChild(new Text(Array.from({ length: 40 }, (_, i) => `Line ${i}`).join("\n"), 0, 0));
  tui.addChild(assistant);
  tui.addChild(new Text("Outside message", 0, 0));
  tui.start();
  const screen = () => { tui.renderNow(); return tui.getScreenLines().map(stripTerminalSequences); };
  const send = (data: string) => input(data);
  const at = (text: string) => {
    const lines = screen();
    const y = lines.findIndex(line => line.includes(text));
    if (y < 0) throw new Error(`Not on screen: ${text}`);
    return { x: lines[y].indexOf(text), y };
  };
  const move = (text: string) => { const { x, y } = at(text); send(`\x1b[<35;${x + 1};${y + 1}M`); };
  return { tui, terminal, screen, send, move, at, copied, selected, opened, assistant, resize: () => resize(),
    shutdown: () => events.get("session_shutdown")?.({}, context), restart: () => events.get("session_start")?.({}, context),
    disposeWidget: () => widget?.dispose?.() };
}

afterEach(() => { for (const tui of running.splice(0)) tui.stop({ preserveScreen: true }); vi.useRealTimers(); vi.unstubAllEnvs(); });

describe("assistant copy hover", () => {
  it("keeps hover working when an active widget is replaced", () => {
    const app = fullscreenFixture();
    app.move("Hello there");
    expect(app.screen().join("\n")).toContain("⧉ text");
    app.restart();
    app.move("Hello there");
    expect(app.screen().join("\n")).toContain("⧉ text");
    app.move("Outside message");
    expect(app.screen().join("\n")).not.toContain("⧉ text");
  });

  it("stops observing hover when its widget is disposed", () => {
    const app = fullscreenFixture();
    app.move("Hello there");
    expect(app.screen().join("\n")).toContain("⧉ text");
    app.disposeWidget();
    expect(app.screen().join("\n")).not.toContain("⧉ text");
    app.move("Hello there");
    expect(app.screen().join("\n")).not.toContain("⧉ text");
    app.restart();
    app.move("Hello there");
    expect(app.screen().join("\n")).toContain("⧉ text");
  });

  it("removes hover on shutdown and reinstalls it in the next session", () => {
    const app = fullscreenFixture();
    app.move("Hello there");
    expect(app.screen().join("\n")).toContain("⧉ text");
    app.shutdown();
    expect(app.screen().join("\n")).not.toContain("⧉ text");
    app.move("Hello there");
    expect(app.screen().join("\n")).not.toContain("⧉ text");
    app.restart();
    app.move("Hello there");
    expect(app.screen().join("\n")).toContain("⧉ text");
    app.move("Outside message");
    expect(app.screen().join("\n")).not.toContain("⧉ text");
  });

  it("preserves OSC 8 link activation while a message is hovered", () => {
    const capabilities = getCapabilities();
    setCapabilities({ ...capabilities, hyperlinks: true });
    try {
      const app = fullscreenFixture();
      app.assistant.updateContent(message("[Link](https://example.test/)"), false);
      app.move("Link");
      const { x, y } = app.at("Link");
      app.send(`\x1b[<0;${x + 1};${y + 1}M`);
      app.send(`\x1b[<0;${x + 1};${y + 1}m`);
      expect(app.opened).toEqual(["https://example.test/"]);
      expect(app.copied).toEqual([]);
    } finally { setCapabilities(capabilities); }
  });

  it("preserves text selection while a message is hovered", async () => {
    const app = fullscreenFixture();
    app.move("Hello there");
    const { x, y } = app.at("Hello there");
    app.send(`\x1b[<0;${x + 1};${y + 1}M`);
    app.send(`\x1b[<32;${x + 5};${y + 1}M`);
    app.send(`\x1b[<0;${x + 5};${y + 1}m`);
    await Promise.resolve();
    expect(app.selected).toEqual(["Hello"]);
    expect(app.copied).toEqual([]);
  });

  it("draws the hover border in the theme's subtle border color", () => {
    const app = fullscreenFixture();
    app.move("Hello there");
    app.screen();
    expect(app.tui.getScreenLines().join("\n")).toContain("\x1b[38;5;245m┌");
  });

  it("copies both exact formats through Pi's fullscreen click dispatch", async () => {
    const app = fullscreenFixture();
    app.assistant.updateContent(message("**Hello there**"), false);
    app.move("Hello there");
    for (const label of ["⧉ text", "⧉ md"]) {
      const { x, y } = app.at(label);
      app.send(`\x1b[<0;${x + 1};${y + 1}M`);
      app.send(`\x1b[<0;${x + 1};${y + 1}m`);
      await Promise.resolve();
    }
    expect(app.copied).toEqual(["Hello there", "**Hello there**"]);
  });

  it("highlights only the message currently under the pointer", () => {
    const app = fullscreenFixture();
    const second = new AssistantMessageComponent(undefined, false, theme, undefined, 0);
    second.updateContent(message("Second reply"), false);
    app.tui.addChild(second);
    app.move("Hello there");
    expect(app.screen().join("\n").match(/⧉ text/g)).toHaveLength(1);
    app.move("Second reply");
    const screen = app.screen();
    expect(screen.join("\n").match(/⧉ text/g)).toHaveLength(1);
    expect(screen.find(line => line.includes("Second reply"))).toContain("⧉ text");
    expect(screen.find(line => line.includes("Hello there"))).not.toContain("⧉ text");
  });

  it("clears the hover when terminal columns change", () => {
    const app = fullscreenFixture();
    app.move("Hello there");
    expect(app.screen().join("\n")).toContain("⧉ text");
    app.terminal.columns += 1;
    app.resize();
    expect(app.screen().join("\n")).not.toContain("⧉ text");
  });

  it("clears the hover on terminal resize", () => {
    const app = fullscreenFixture();
    app.move("Hello there");
    expect(app.screen().join("\n")).toContain("⧉ text");
    app.terminal.rows += 1;
    app.resize();
    expect(app.screen().join("\n")).toContain("Hello there");
    expect(app.screen().join("\n")).not.toContain("⧉ text");
  });

  it("clears hover when new output moves the following viewport", () => {
    const app = fullscreenFixture(true);
    app.move("Hello there");
    expect(app.screen().join("\n")).toContain("⧉ text");
    const before = app.tui.viewportTop;
    app.tui.addChild(new Text("New output", 0, 0));
    app.tui.requestRender();
    app.screen();
    expect(app.tui.viewportTop).toBeGreaterThan(before);
    expect(app.screen().join("\n")).toContain("Hello there");
    expect(app.screen().join("\n")).not.toContain("⧉ text");
  });

  it("clears the hover when the transcript scrolls outside input dispatch", () => {
    const app = fullscreenFixture(true);
    app.move("Hello there");
    expect(app.screen().join("\n")).toContain("⧉ text");
    const before = app.tui.viewportTop;
    app.tui.scrollBy(-1);
    expect(app.tui.viewportTop).toBe(before - 1);
    app.tui.scrollToBottom();
    expect(app.screen().join("\n")).toContain("Hello there");
    expect(app.screen().join("\n")).not.toContain("⧉ text");
  });

  it("clears the hover on keyboard scrolling", () => {
    const app = fullscreenFixture(true);
    app.move("Hello there");
    expect(app.screen().join("\n")).toContain("⧉ text");
    const before = app.tui.viewportTop;
    app.send("\x1b[5~");
    expect(app.tui.viewportTop).toBeLessThan(before);
    app.send("\x1b[6~");
    expect(app.screen().join("\n")).toContain("Hello there");
    expect(app.screen().join("\n")).not.toContain("⧉ text");
  });

  it("clears the hover when the mouse wheel scrolls", () => {
    const app = fullscreenFixture();
    app.move("Hello there");
    expect(app.screen().join("\n")).toContain("⧉ text");
    const { x, y } = app.at("Outside message");
    app.send(`\x1b[<65;${x + 1};${y + 1}M`);
    expect(app.screen().join("\n")).not.toContain("⧉ text");
  });

  it("clears the hover on legacy wheel input", () => {
    const app = fullscreenFixture();
    app.move("Hello there");
    expect(app.screen().join("\n")).toContain("⧉ text");
    const { x, y } = app.at("Outside message");
    app.send(`\x1b[M${String.fromCharCode(32 + 65, x + 33, y + 33)}`);
    expect(app.screen().join("\n")).not.toContain("⧉ text");
  });

  it("clears the hover when terminal focus is lost", () => {
    const app = fullscreenFixture();
    app.move("Hello there");
    expect(app.screen().join("\n")).toContain("⧉ text");
    app.send("\x1b[O");
    expect(app.screen().join("\n")).not.toContain("⧉ text");
  });

  it("clears the hover when motion reaches another component", () => {
    const app = fullscreenFixture();
    app.move("Hello there");
    expect(app.screen().join("\n")).toContain("⧉ text");
    app.move("Outside message");
    expect(app.screen().join("\n")).not.toContain("⧉ text");
  });

  it("copies from padded button cells but not the gap between buttons", async () => {
    const { md, copied } = fixture("**Bold**");
    render(md);
    mouse(md, "move");
    const lines = render(md);
    const y = lines.findIndex(line => line.includes("⧉ text"));
    const x = lines[y].indexOf("⧉ text");
    const clickAt = (col: number) => (md as Component).handleMouse?.({ type: "click", button: "left", x: col, y, screenX: col, screenY: y, width: 60, height: lines.length, shift: false, alt: false, ctrl: false });
    expect(clickAt(x + 7)).toEqual({ handled: true });
    await Promise.resolve();
    expect(copied).toEqual(["Bold"]);
    expect(clickAt(x + 8)).toBeUndefined();
    expect(copied).toEqual(["Bold"]);
  });

  it("does not activate stale hitboxes after hover moves to another message", async () => {
    const first = fixture("**First**");
    const second = new AssistantMessageComponent(undefined, false, theme, undefined, 0);
    second.updateContent(message("Second"), false);
    const children = (second as unknown as { contentContainer: { children: Component[] } }).contentContainer.children;
    const other = children.find((child): child is Markdown => child instanceof Markdown);
    if (!other) throw new Error("assistant has no Markdown");
    render(first.md);
    mouse(first.md, "move");
    const lines = render(first.md);
    const y = lines.findIndex(line => line.includes("⧉ md"));
    const x = lines[y].indexOf("⧉ md");
    render(other);
    mouse(other, "move");
    const event: TuiMouseEvent = { type: "click", button: "left", x, y, screenX: x, screenY: y, width: 60, height: lines.length, shift: false, alt: false, ctrl: false };
    expect((first.md as Component).handleMouse?.(event)).toBeUndefined();
    await Promise.resolve();
    expect(first.copied).toEqual([]);
  });

  it("highlights all text parts of the same assistant message", () => {
    const { assistant } = fixture("First part");
    const response = message("```\nFirst part\n```");
    response.content.push({ type: "text", text: "Second part" });
    assistant.updateContent(response, false);
    const children = (assistant as unknown as { contentContainer: { children: Component[] } }).contentContainer.children;
    const parts = children.filter((child): child is Markdown => child instanceof Markdown);
    expect(parts).toHaveLength(2);
    parts.forEach(part => render(part));
    mouse(parts[0], "move");
    expect(render(parts[0]).join("\n")).toContain("⧉ text");
    expect(render(parts[1]).join("\n")).toContain("⧉ text");
  });

  it("does not schedule another render for motion within the same message", () => {
    const { md, requestRender } = fixture("Hello there");
    render(md);
    mouse(md, "move");
    expect(requestRender).toHaveBeenCalledTimes(1);
    mouse(md, "move", 2, 1);
    expect(requestRender).toHaveBeenCalledTimes(1);
  });

  it("reveals controls on pointer motion without consuming it", () => {
    const { md, requestRender } = fixture("Hello there");
    render(md);
    expect(mouse(md, "move")).toBeUndefined();
    expect(render(md).join("\n")).toContain("⧉ text");
    expect(render(md).join("\n")).toContain("⧉ md");
    expect(requestRender).toHaveBeenCalled();
  });

  it("shows the message timestamp in the system time zone to the left of the controls", () => {
    vi.useFakeTimers();
    vi.stubEnv("TZ", "America/New_York");
    vi.setSystemTime(new Date("2024-01-03T18:00:00Z"));
    const { md } = fixture("Hello", Date.UTC(2024, 0, 3, 8, 15));
    render(md);
    mouse(md, "move");
    const row = render(md).find(line => line.includes("⧉ text"));
    expect(row).toMatch(/03:15\s+⧉ text\s+⧉ md/);
    expect(row).not.toContain("Jan");
  });

  it("updates the timestamp label when the system time zone changes", () => {
    vi.useFakeTimers();
    vi.stubEnv("TZ", "UTC");
    vi.setSystemTime(new Date("2024-01-03T18:00:00Z"));
    const { md } = fixture("Time zone change", Date.UTC(2024, 0, 3, 8, 15));
    render(md);
    mouse(md, "move");
    expect(render(md).join("\n")).toMatch(/08:15\s+⧉ text/);
    vi.stubEnv("TZ", "America/New_York");
    expect(render(md).join("\n")).toMatch(/03:15\s+⧉ text/);
  });

  it("updates the timestamp label when the local day changes", () => {
    vi.useFakeTimers();
    vi.stubEnv("TZ", "UTC");
    vi.setSystemTime(new Date("2024-01-03T23:59:00Z"));
    const { md } = fixture("Before midnight", Date.UTC(2024, 0, 3, 8, 15));
    render(md);
    mouse(md, "move");
    expect(render(md).join("\n")).toMatch(/08:15\s+⧉ text/);
    expect(render(md).join("\n")).not.toContain("Jan 3");
    vi.setSystemTime(new Date("2024-01-04T00:01:00Z"));
    expect(render(md).join("\n")).toMatch(/Jan 3 08:15\s+⧉ text/);
  });

  it("compares days in the local time zone, not UTC", () => {
    vi.useFakeTimers();
    vi.stubEnv("TZ", "America/New_York");
    vi.setSystemTime(new Date("2024-01-03T02:00:00Z"));
    const { md } = fixture("Same local day", Date.UTC(2024, 0, 2, 7, 0));
    render(md);
    mouse(md, "move");
    const row = render(md).find(line => line.includes("⧉ text"));
    expect(row).toMatch(/02:00\s+⧉ text/);
    expect(row).not.toContain("Jan");
  });

  it("adds the local month and day when the message was sent on an earlier day", () => {
    vi.useFakeTimers();
    vi.stubEnv("TZ", "America/New_York");
    vi.setSystemTime(new Date("2024-01-03T02:00:00Z"));
    const { md } = fixture("Yesterday", Date.UTC(2024, 0, 1, 8, 15));
    render(md);
    mouse(md, "move");
    expect(render(md).find(line => line.includes("⧉ text"))).toMatch(/Jan 1 03:15\s+⧉ text/);
  });

  it("keeps extremely narrow layouts within the terminal width", () => {
    const { md } = fixture("Hi");
    const two = render(md, 2);
    expect(two.every(line => line.length <= 2)).toBe(true);
    expect(two.join("\n")).not.toContain("⧉ text");
    const nineteen = render(md, 19);
    const event: TuiMouseEvent = { type: "move", button: "none", x: 1, y: 1, screenX: 1, screenY: 1, width: 19, height: nineteen.length, shift: false, alt: false, ctrl: false };
    (md as Component).handleMouse?.(event);
    const hovered = render(md, 19);
    expect(hovered.every(line => line.length <= 19)).toBe(true);
    expect(hovered.join("\n")).not.toContain("⧉ text");
  });

  it("keeps the timestamp visible without reflow in a narrow layout", () => {
    vi.useFakeTimers();
    vi.stubEnv("TZ", "UTC");
    vi.setSystemTime(new Date("2024-01-03T18:00:00Z"));
    const { md } = fixture("Hello", Date.UTC(2024, 0, 3, 8, 15));
    const before = render(md, 28);
    const event: TuiMouseEvent = { type: "move", button: "none", x: 1, y: 1, screenX: 1, screenY: 1, width: 28, height: before.length, shift: false, alt: false, ctrl: false };
    (md as Component).handleMouse?.(event);
    const after = render(md, 28);
    expect(after.join("\n")).toMatch(/08:15\s+⧉ text/);
    expect(after).toHaveLength(before.length);
    expect(after.findIndex(line => line.includes("Hello"))).toBe(before.findIndex(line => line.includes("Hello")));
    expect(after.every(line => line.length <= 28)).toBe(true);
  });

  it("keeps a complete border around extra block action rows at narrow widths", () => {
    vi.useFakeTimers();
    vi.stubEnv("TZ", "UTC");
    vi.setSystemTime(new Date("2024-01-03T18:00:00Z"));
    const { md } = fixture("```js\nx()\n```", Date.UTC(2024, 0, 1, 8, 15));
    const before = render(md, 28);
    const event: TuiMouseEvent = { type: "move", button: "none", x: 1, y: 1, screenX: 1, screenY: 1, width: 28, height: before.length, shift: false, alt: false, ctrl: false };
    (md as Component).handleMouse?.(event);
    const after = render(md, 28);
    expect(after).toHaveLength(before.length);
    for (const line of after.slice(1, -1)) {
      expect(line).toMatch(/^│.*│$/);
      expect(line.length).toBe(28);
    }
    expect(after.join("\n").match(/⧉ text/g)).toHaveLength(2);
  });

  it("copies the right block after a stacked timestamp row", async () => {
    vi.useFakeTimers();
    vi.stubEnv("TZ", "UTC");
    vi.setSystemTime(new Date("2024-01-03T18:00:00Z"));
    const { md, copied } = fixture("```js\nx()\n```", Date.UTC(2024, 0, 1, 8, 15));
    const before = render(md, 28);
    const motion: TuiMouseEvent = { type: "move", button: "none", x: 1, y: 1, screenX: 1, screenY: 1, width: 28, height: before.length, shift: false, alt: false, ctrl: false };
    (md as Component).handleMouse?.(motion);
    const after = render(md, 28);
    const y = after.findIndex(line => line.includes("⧉ md"));
    const x = after[y].indexOf("⧉ md");
    expect((md as Component).handleMouse?.({ ...motion, type: "click", button: "left", x, y, screenX: x, screenY: y, height: after.length })).toEqual({ handled: true });
    await Promise.resolve();
    expect(copied).toEqual(["```js\nx()\n```"]);
  });

  it("retains the full date and time at narrow widths without hover reflow", () => {
    vi.useFakeTimers();
    vi.stubEnv("TZ", "UTC");
    vi.setSystemTime(new Date("2024-01-03T18:00:00Z"));
    const { md } = fixture("Hello", Date.UTC(2024, 0, 1, 8, 15));
    const before = render(md, 28);
    const event: TuiMouseEvent = { type: "move", button: "none", x: 1, y: 1, screenX: 1, screenY: 1, width: 28, height: before.length, shift: false, alt: false, ctrl: false };
    (md as Component).handleMouse?.(event);
    const after = render(md, 28);
    expect(after.join("\n")).toContain("Jan 1 08:15");
    expect(after.join("\n")).toContain("⧉ text");
    expect(after).toHaveLength(before.length);
    expect(after.findIndex(line => line.includes("Hello"))).toBe(before.findIndex(line => line.includes("Hello")));
    expect(after.every(line => line.length <= 28)).toBe(true);
  });

  it("preserves wide and combining text cells when the border appears", () => {
    const text = "界界 café e\u0301";
    const { md } = fixture(text);
    const before = render(md);
    mouse(md, "move");
    const after = render(md);
    const beforeRow = before.findIndex(line => line.includes(text));
    const afterRow = after.findIndex(line => line.includes(text));
    expect(beforeRow).toBeGreaterThanOrEqual(0);
    expect(afterRow).toBe(beforeRow);
    expect(visibleWidth(after[afterRow].slice(0, after[afterRow].indexOf(text)))).toBe(visibleWidth(before[beforeRow].slice(0, before[beforeRow].indexOf(text))));
    expect(after.every(line => visibleWidth(line) <= 60)).toBe(true);
  });

  it("draws a border without moving text even when the last line is full", () => {
    const text = "First line\n\n" + "x".repeat(55);
    const { md } = fixture(text);
    const before = render(md);
    mouse(md, "move");
    const after = render(md);
    expect(after[0]).toMatch(/^┌─+┐$/);
    expect(after.at(-1)).toMatch(/^└─+┘$/);
    expect(after.filter(line => line.includes("First line"))[0]).toMatch(/^│.*│$/);
    expect(after).toHaveLength(before.length);
    expect(after.every(line => line.length <= 60)).toBe(true);
    for (const fragment of ["First line", "x".repeat(55)]) {
      const oldRow = before.findIndex(line => line.includes(fragment));
      const newRow = after.findIndex(line => line.includes(fragment));
      expect(newRow).toBe(oldRow);
      expect(after[newRow].indexOf(fragment)).toBe(before[oldRow].indexOf(fragment));
    }
  });

  it("leaves regular mode's Markdown output untouched", () => {
    const source = "Hello **world**\n\n```js\nx()\n```";
    const { md } = fixture(source, undefined, false);
    const original = new Markdown(source, 0, 0, theme);
    expect(md.render(60)).toEqual(original.render(60));
    mouse(md, "move");
    expect(md.render(60)).toEqual(original.render(60));
  });

  it("hides controls, time and border without a pointer", () => {
    const { md } = fixture("Hello there");
    const lines = render(md).join("\n");
    expect(lines).toContain("Hello there");
    expect(lines).not.toContain("⧉ text");
    expect(lines).not.toContain("⧉ md");
    expect(lines).not.toContain("08:15");
    expect(lines).not.toMatch(/[┌┐└┘│]/);
  });
});

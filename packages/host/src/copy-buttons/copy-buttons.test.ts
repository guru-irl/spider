import { afterEach, describe, expect, it, vi } from "vitest";
import { AssistantMessageComponent, UserMessageComponent, initTheme } from "@earendil-works/pi-coding-agent";
import { Markdown, stripTerminalSequences, visibleWidth, type Component, type MarkdownTheme, type TuiMouseEvent } from "@earendil-works/pi-tui";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { installCopyButtons, registerCopyButtons } from "./index.js";

const identity = (text: string) => text;
const theme: MarkdownTheme = {
  heading: identity, link: identity, linkUrl: identity, code: identity, codeBlock: identity,
  codeBlockBorder: identity, quote: identity, quoteBorder: identity, hr: identity,
  listBullet: identity, bold: identity, italic: identity, strikethrough: identity, underline: identity,
};
const source = "# Title\n\n```ts\nconst x = 1;\n```\n\n> **Quote**\n> Next\n\n---\n\n## Section\n[Link](https://x.test)\n\n---\n\nTail *end*";
const message = (text: string): AssistantMessage => ({
  role: "assistant", content: [{ type: "text", text }], api: "openai-completions", provider: "test", model: "test",
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  stopReason: "stop", timestamp: 0,
});
function fixture(fullscreen = true) {
  const copied: string[] = [];
  const render = vi.fn();
  installCopyButtons({ AssistantMessageComponent, Markdown }, {
    isFullscreen: () => fullscreen,
    copy: async text => { copied.push(text); },
    requestRender: render,
    onError: error => { throw error; },
  });
  const assistant = new AssistantMessageComponent(undefined, false, theme, undefined, 0);
  return { assistant, copied, render };
}
function markdown(assistant: AssistantMessageComponent): Markdown {
  const container = (assistant as unknown as { contentContainer: { children: unknown[] } }).contentContainer;
  const result = container.children.find(child => child instanceof Markdown);
  if (!(result instanceof Markdown)) throw new Error("assistant has no Markdown");
  return result;
}
function render(md: Markdown): string[] { return md.render(90).map(stripTerminalSequences); }
function click(md: Markdown, row: number, label: "⧉ text" | "⧉ md") {
  const lines = render(md);
  const at = lines[row].indexOf(label);
  expect(at).toBeGreaterThanOrEqual(0);
  const x = visibleWidth(lines[row].slice(0, at));
  const event: TuiMouseEvent = { type: "click", button: "left", x, y: row, screenX: x, screenY: row, width: 90, height: lines.length, shift: false, alt: false, ctrl: false };
  expect((md as Component).handleMouse?.(event)).toEqual({ handled: true });
}

afterEach(() => { vi.useRealTimers(); });

describe("copy buttons", () => {
  it("renders both actions at the ends of blocks, sections, and the reply and copies each exact format", async () => {
    const { assistant, copied } = fixture();
    assistant.updateContent(message(source), false);
    const md = markdown(assistant);
    const lines = render(md);
    const pairs = lines.map((line, row) => line.includes("⧉ text") && line.includes("⧉ md") ? row : -1).filter(row => row >= 0);
    expect(pairs).toHaveLength(4);
    expect(lines[pairs[0]]).toContain("```");
    expect(lines[pairs[1]]).toContain("Next");
    expect(lines[pairs[2] - 1]).toContain("─");
    expect(lines[pairs[3]]).toContain("Tail end");
    const expected = [
      ["const x = 1;", "```ts\nconst x = 1;\n```"],
      ["Quote\nNext", "> **Quote**\n> Next"],
      ["Section\nLink (https://x.test)", "## Section\n[Link](https://x.test)"],
      ["Title\n\nconst x = 1;\n\nQuote\nNext\n\n---\n\nSection\nLink (https://x.test)\n\n---\n\nTail end", source],
    ];
    for (const [index, row] of pairs.entries()) {
      click(md, row, "⧉ text"); await Promise.resolve();
      expect(copied.at(-1)).toBe(expected[index][0]);
      click(md, row, "⧉ md"); await Promise.resolve();
      expect(copied.at(-1)).toBe(expected[index][1]);
    }
  });

  it("copies source tabs rather than pi's display-normalized spaces", async () => {
    const { assistant, copied } = fixture();
    const input = "```ts\n\treturn 1;\n```\n\n> **hello**\tworld\n\nEnd";
    assistant.updateContent(message(input), false);
    const md = markdown(assistant);
    const rows = render(md).map((line, row) => line.includes("⧉ text") ? row : -1).filter(row => row >= 0);
    expect(rows).toHaveLength(3);
    click(md, rows[0], "⧉ md"); await Promise.resolve();
    expect(copied.at(-1)).toBe("```ts\n\treturn 1;\n```");
    click(md, rows[0], "⧉ text"); await Promise.resolve();
    expect(copied.at(-1)).toBe("\treturn 1;");
    click(md, rows[1], "⧉ md"); await Promise.resolve();
    expect(copied.at(-1)).toBe("> **hello**\tworld");
  });

  it("still offers block copies after display math", async () => {
    const { assistant, copied } = fixture();
    assistant.updateContent(message("$$\nx^2\n$$\n\n```js\nhello()\n```\n\nEnd"), false);
    const md = markdown(assistant);
    const rows = render(md).map((line, row) => line.includes("⧉ md") ? row : -1).filter(row => row >= 0);
    expect(rows).toHaveLength(2);
    click(md, rows[0], "⧉ md"); await Promise.resolve();
    expect(copied.at(-1)).toBe("```js\nhello()\n```");
  });

  it("copies source code even when a Markdown transformer changes its display", async () => {
    const { copied } = fixture();
    const assistant = new AssistantMessageComponent(undefined, false, theme, undefined, 0, [input => input.replace("original()", "displayed()")]);
    assistant.updateContent(message("```js\noriginal()\n```\n\nEnd"), false);
    const md = markdown(assistant);
    const row = render(md).findIndex(line => line.includes("⧉ md"));
    click(md, row, "⧉ md"); await Promise.resolve();
    expect(copied.at(-1)).toBe("```js\noriginal()\n```");
    click(md, row, "⧉ text"); await Promise.resolve();
    expect(copied.at(-1)).toBe("original()");
  });

  it("keeps the selected format when a click has Alt or Ctrl modifiers", async () => {
    const { assistant, copied } = fixture();
    assistant.updateContent(message("**Bold**"), false);
    const md = markdown(assistant);
    const lines = render(md);
    const row = lines.findIndex(line => line.includes("⧉ md"));
    const x = visibleWidth(lines[row].slice(0, lines[row].indexOf("⧉ md")));
    const event: TuiMouseEvent = { type: "click", button: "left", x, y: row, screenX: x, screenY: row, width: 90, height: lines.length, shift: false, alt: true, ctrl: true };
    expect((md as Component).handleMouse?.(event)).toEqual({ handled: true });
    await Promise.resolve();
    expect(copied).toEqual(["**Bold**"]);
  });

  it("reports a synchronous clipboard failure without showing confirmation", () => {
    const errors: unknown[] = [];
    installCopyButtons({ AssistantMessageComponent, Markdown }, {
      isFullscreen: () => true,
      copy: () => { throw new Error("clipboard unavailable"); },
      requestRender: () => {}, onError: error => errors.push(error),
    });
    const assistant = new AssistantMessageComponent(undefined, false, theme, undefined, 0);
    assistant.updateContent(message("Hello"), false);
    const md = markdown(assistant);
    const row = render(md).findIndex(line => line.includes("⧉ text"));
    expect(() => click(md, row, "⧉ text")).not.toThrow();
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe("clipboard unavailable");
    expect(render(md)[row]).not.toContain("✓ copied");
  });

  it("leaves pi alone when a required renderer internal is missing", () => {
    class UnsupportedAssistant { updateContent() { return "original"; } }
    class UnsupportedMarkdown { render() { return []; } }
    const host = { AssistantMessageComponent: UnsupportedAssistant, Markdown: UnsupportedMarkdown } as unknown as Parameters<typeof installCopyButtons>[0];
    expect(() => installCopyButtons(host, { isFullscreen: () => true, copy: async () => {}, requestRender: () => {}, onError: () => {} })).not.toThrow();
    expect(new UnsupportedAssistant().updateContent()).toBe("original");
  });

  it("shows confirmation only on the clicked action for 1.5 seconds without moving the other column", async () => {
    vi.useFakeTimers();
    const { assistant, render: requestRender } = fixture();
    assistant.updateContent(message("Hello"), false);
    const md = markdown(assistant);
    const row = render(md).findIndex(line => line.includes("⧉ text"));
    const before = render(md)[row];
    click(md, row, "⧉ text"); await Promise.resolve();
    const after = render(md)[row];
    expect(after).toContain("✓ copied");
    expect(after.indexOf("⧉ md")).toBe(before.indexOf("⧉ md"));
    await vi.advanceTimersByTimeAsync(1500);
    expect(render(md)[row]).toBe(before);
    expect(requestRender).toHaveBeenCalled();
  });

  it("shows no labels in regular mode or while streaming", () => {
    const { assistant } = fixture(false);
    assistant.updateContent(message(source), false);
    expect(render(markdown(assistant)).join("\n")).not.toContain("⧉ text");
    const active = fixture(true).assistant;
    active.updateContent(message(source), true);
    expect(render(markdown(active)).join("\n")).not.toContain("⧉ text");
  });

  it("leaves user messages and thinking blocks without copy controls", () => {
    initTheme(undefined, false);
    const { assistant } = fixture();
    const response = message("Answer");
    response.content.unshift({ type: "thinking", thinking: "Private reasoning" });
    assistant.updateContent(response, false);
    const container = (assistant as unknown as { contentContainer: { children: Component[] } }).contentContainer;
    const thinking = container.children.find(child => child.constructor.name === "MouseRegion");
    expect(thinking).toBeDefined();
    expect(thinking!.render(90).map(stripTerminalSequences).join("\n")).not.toContain("⧉ text");
    const user = new UserMessageComponent("```\nUser code\n```", theme, 0);
    expect(user.render(90).map(stripTerminalSequences).join("\n")).not.toContain("⧉ text");
  });

  it("offers both a block action and a full-reply action when the reply ends in a block", async () => {
    const { assistant, copied } = fixture();
    const input = "Intro\n\n```js\nx()\n```";
    assistant.updateContent(message(input), false);
    const md = markdown(assistant);
    const lines = render(md);
    const rows = lines.map((line, row) => line.includes("⧉ text") ? row : -1).filter(row => row >= 0);
    expect(rows).toHaveLength(2);
    click(md, rows[0], "⧉ md"); await Promise.resolve();
    expect(copied.at(-1)).toBe("```js\nx()\n```");
    click(md, rows[1], "⧉ md"); await Promise.resolve();
    expect(copied.at(-1)).toBe(input);
  });

  it("activates in a fullscreen UI and uses the clipboard callback", async () => {
    const events = new Map<string, (event: unknown, ctx: unknown) => void>();
    const pi = { on: (name: string, handler: (event: unknown, ctx: unknown) => void) => events.set(name, handler) };
    const copied: string[] = [];
    const context = { hasUI: true, mode: "tui", cwd: "/project", ui: {
      setWidget: (_key: string, make: (tui: unknown) => unknown) => make({ mode: "fullscreen", requestRender: () => {} }),
      notify: vi.fn(),
    } };
    registerCopyButtons(pi as never, { AssistantMessageComponent, Markdown }, () => ({ "copyButtons.enabled": true }), async text => { copied.push(text); });
    events.get("session_start")?.({}, context);
    const assistant = new AssistantMessageComponent(undefined, false, theme, undefined, 0);
    assistant.updateContent(message("Hello"), false);
    const md = markdown(assistant);
    const row = render(md).findIndex(line => line.includes("⧉ md"));
    click(md, row, "⧉ md"); await Promise.resolve();
    expect(copied).toEqual(["Hello"]);
  });

  it("does nothing for headless sessions, children, and disabled configuration", () => {
    const existing = fixture();
    const events = new Map<string, (event: unknown, ctx: unknown) => void>();
    const pi = { on: (name: string, handler: (event: unknown, ctx: unknown) => void) => events.set(name, handler) };
    const setWidget = vi.fn();
    const context = { hasUI: false, mode: "tui", cwd: "/project", ui: { setWidget, notify: vi.fn() } };
    existing.assistant.updateContent(message("Previous"), false);
    const previous = markdown(existing.assistant);
    expect(render(previous).join("\n")).toContain("⧉ text");
    registerCopyButtons(pi as never, { AssistantMessageComponent, Markdown }, () => ({ "copyButtons.enabled": false }), async () => {});
    events.get("session_start")?.({}, context);
    expect(setWidget).not.toHaveBeenCalled();
    expect(render(previous).join("\n")).not.toContain("⧉ text");
    existing.assistant.updateContent(message("Hello"), false);
    expect(render(markdown(existing.assistant)).join("\n")).not.toContain("⧉ text");
    context.hasUI = true;
    events.get("session_start")?.({}, context);
    expect(setWidget).not.toHaveBeenCalled();
    vi.stubEnv("PI_SUBAGENT_CHILD", "1");
    registerCopyButtons(pi as never, { AssistantMessageComponent, Markdown }, () => ({ "copyButtons.enabled": true }), async () => {});
    events.get("session_start")?.({}, context);
    expect(setWidget).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
  });

  it("does not register a terminal widget for an RPC session with UI", () => {
    const events = new Map<string, (event: unknown, ctx: unknown) => void>();
    const pi = { on: (name: string, handler: (event: unknown, ctx: unknown) => void) => events.set(name, handler) };
    const setWidget = vi.fn();
    registerCopyButtons(pi as never, { AssistantMessageComponent, Markdown }, () => ({ "copyButtons.enabled": true }), async () => {});
    events.get("session_start")?.({}, { mode: "rpc", hasUI: true, cwd: "/project", ui: { setWidget, notify: vi.fn() } });
    expect(setWidget).not.toHaveBeenCalled();
  });

  it("uses the Nerd Font copy icon without moving its clickable columns", async () => {
    const events = new Map<string, (event: unknown, ctx: unknown) => void>();
    const pi = { on: (name: string, handler: (event: unknown, ctx: unknown) => void) => events.set(name, handler) };
    const copied: string[] = [];
    let style: "text" | "nerd" = "text";
    registerCopyButtons(pi as never, { AssistantMessageComponent, Markdown }, () => ({ "ui.icons": style }), async text => { copied.push(text); });
    const context = { hasUI: true, mode: "tui", cwd: "/project", ui: {
      setWidget: (_key: string, make: (tui: unknown) => unknown) => make({ mode: "fullscreen", requestRender: () => {} }), notify: vi.fn(),
    } };
    events.get("session_start")?.({}, context);
    const first = new AssistantMessageComponent(undefined, false, theme, undefined, 0);
    first.updateContent(message("Hello"), false);
    const before = render(markdown(first)).find(line => line.includes("⧉ text"))!;
    style = "nerd";
    events.get("session_start")?.({}, context);
    const second = new AssistantMessageComponent(undefined, false, theme, undefined, 0);
    second.updateContent(message("Hello"), false);
    const md = markdown(second);
    const lines = render(md);
    const row = lines.findIndex(line => line.includes("\u{F018F} text"));
    expect(row).toBeGreaterThanOrEqual(0);
    const after = lines[row];
    expect(visibleWidth(after)).toBe(visibleWidth(before));
    expect(visibleWidth(after.slice(0, after.indexOf("\u{F018F} text")))).toBe(visibleWidth(before.slice(0, before.indexOf("⧉ text"))));
    const x = visibleWidth(after.slice(0, after.indexOf("\u{F018F} md")));
    const event: TuiMouseEvent = { type: "click", button: "left", x, y: row, screenX: x, screenY: row, width: 90, height: lines.length, shift: false, alt: false, ctrl: false };
    expect((md as Component).handleMouse?.(event)).toEqual({ handled: true });
    await Promise.resolve();
    expect(copied).toEqual(["Hello"]);
  });

  it("does not double wrap when activated twice", async () => {
    const first = fixture();
    const second = fixture();
    first.assistant.updateContent(message("Hello"), false);
    const md = markdown(first.assistant);
    const lines = render(md);
    expect(lines.join("\n").match(/⧉ text/g)).toHaveLength(1);
    click(md, lines.findIndex(line => line.includes("⧉ text")), "⧉ text");
    await Promise.resolve();
    expect(second.copied).toEqual(["Hello"]);
    expect(first.copied).toEqual([]);
  });
});

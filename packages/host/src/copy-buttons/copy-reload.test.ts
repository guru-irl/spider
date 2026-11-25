import { afterEach, describe, expect, it, vi } from "vitest";
import { ToolExecutionComponent, AssistantMessageComponent } from "@earendil-works/pi-coding-agent";
import { Spacer, Markdown, stripTerminalSequences, visibleWidth, type Component, type MarkdownTheme, type TuiMouseEvent } from "@earendil-works/pi-tui";
import type { AssistantMessage } from "@earendil-works/pi-ai";

const identity = (text: string) => text;
const theme: MarkdownTheme = {
  heading: identity, link: identity, linkUrl: identity, code: identity, codeBlock: identity,
  codeBlockBorder: identity, quote: identity, quoteBorder: identity, hr: identity,
  listBullet: identity, bold: identity, italic: identity, strikethrough: identity, underline: identity,
};
const message: AssistantMessage = {
  role: "assistant", content: [{ type: "text", text: "**Bold**" }], api: "openai-completions", provider: "test", model: "test",
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  stopReason: "stop", timestamp: 0,
};
const host = { AssistantMessageComponent, ToolExecutionComponent, Markdown, Spacer };
const proto = AssistantMessageComponent.prototype;
const original = proto.updateContent;
const patch = Symbol.for("spider.copy-buttons.updateContent");
const patched = proto as unknown as Record<symbol, unknown>;
const options = (copied: string[]) => ({
  isFullscreen: () => true,
  copy: async (text: string) => { copied.push(text); },
  requestRender: () => {},
  onError: (error: unknown) => { throw error; },
});

async function copyText(assistant: AssistantMessageComponent): Promise<void> {
  const children = (assistant as unknown as { contentContainer: { children: Component[] } }).contentContainer.children;
  const md = children.find((child): child is Markdown => child instanceof Markdown);
  if (!md) throw new Error("assistant has no Markdown");
  const event: TuiMouseEvent = { type: "move", button: "none", x: 1, y: 1, screenX: 1, screenY: 1, width: 90, height: 10, shift: false, alt: false, ctrl: false };
  md.render(90);
  (md as Component).handleMouse?.(event);
  const lines = md.render(90).map(stripTerminalSequences);
  const y = lines.findIndex(line => line.includes("⧉ text"));
  expect(y).toBeGreaterThanOrEqual(0);
  const x = visibleWidth(lines[y].slice(0, lines[y].indexOf("⧉ text")));
  expect((md as Component).handleMouse?.({ ...event, type: "click", button: "left", x, y, screenX: x, screenY: y })).toEqual({ handled: true });
  await Promise.resolve();
}

async function freshWithPlainText(value: string) {
  vi.resetModules();
  vi.doMock("./plain.js", () => ({ blocksToPlain: () => value }));
  return import("./index.js");
}

afterEach(() => {
  proto.updateContent = original;
  delete patched[patch];
  vi.doUnmock("./plain.js");
  vi.resetModules();
  vi.restoreAllMocks();
});

describe("copy button reload", () => {
  it("runs the latest module through the original and a wrapper added on top", async () => {
    const base = vi.spyOn(proto, "updateContent");
    const first = await import("./index.js");
    const firstCopied: string[] = [];
    first.installCopyButtons(host, options(firstCopied));
    const previous = proto.updateContent;
    const other = vi.fn(function (this: AssistantMessageComponent, ...args: Parameters<typeof original>) {
      return previous.apply(this, args);
    });
    proto.updateContent = other;

    const second = await freshWithPlainText("second module");
    const secondCopied: string[] = [];
    second.installCopyButtons(host, options(secondCopied));
    const assistant = new AssistantMessageComponent(undefined, false, theme, undefined, 0);
    assistant.updateContent(message, false);
    await copyText(assistant);
    expect(secondCopied).toEqual(["second module"]);
    expect(firstCopied).toEqual([]);
    expect(base).toHaveBeenCalledTimes(1);
    expect(other).toHaveBeenCalledTimes(1);
    expect(proto.updateContent).toBe(other);

    const third = await freshWithPlainText("third module");
    const thirdCopied: string[] = [];
    third.installCopyButtons(host, options(thirdCopied));
    assistant.updateContent(message, false);
    await copyText(assistant);
    expect(thirdCopied).toEqual(["third module"]);
    expect(base).toHaveBeenCalledTimes(2);
    expect(other).toHaveBeenCalledTimes(2);
    expect(proto.updateContent).toBe(other);
  });

  it.each(["none", "legacy", "delegating"])("uses fresh code for messages rebuilt before session start with a %s patch", async shape => {
    if (shape === "legacy") {
      const legacyState = { options: options([]), enabled: false };
      const legacyOriginal = proto.updateContent;
      patched[patch] = { original: legacyOriginal, state: legacyState };
      proto.updateContent = function (...args) {
        legacyOriginal.apply(this, args);
        if (!legacyState.enabled) return;
        const children = (this as unknown as { contentContainer: { children: Component[] } }).contentContainer.children;
        for (const child of children) if (child instanceof Markdown) (child as Component).handleMouse = () => ({ handled: true });
      };
    } else if (shape === "delegating") {
      const previous = await import("./index.js");
      previous.installCopyButtons(host, options([]));
      previous.disableCopyButtons(host);
    }
    // Pi emits shutdown, loads extensions, rebuilds messages, then emits start.
    const next = await freshWithPlainText("reloaded code");
    const handlers = new Map<string, (event: unknown, ctx: unknown) => void>();
    const pi = { on: (name: string, handler: (event: unknown, ctx: unknown) => void) => handlers.set(name, handler) };
    const copied: string[] = [];
    next.registerCopyButtons(pi as never, host, () => ({}), async value => { copied.push(value); });
    const rebuilt = new AssistantMessageComponent(message, false, theme, undefined, 0);
    const anotherRebuilt = new AssistantMessageComponent(message, false, theme, undefined, 0);
    const children = (rebuilt as unknown as { contentContainer: { children: Component[] } }).contentContainer.children;
    const md = children.find((child): child is Markdown => child instanceof Markdown);
    if (!md) throw new Error("assistant has no Markdown");
    expect(md.render(90)).toEqual(new Markdown("**Bold**", 0, 0, theme).render(90));
    const context = { mode: "tui", hasUI: true, cwd: "/project", ui: {
      setWidget: (_key: string, make: (tui: unknown) => unknown) => make({ mode: "fullscreen", requestRender: () => {} }),
      notify: vi.fn(),
    } };
    handlers.get("session_start")?.({}, context);
    await copyText(rebuilt);
    await copyText(anotherRebuilt);
    const fresh = new AssistantMessageComponent(message, false, theme, undefined, 0);
    await copyText(fresh);
    expect(copied).toEqual(["reloaded code", "reloaded code", "reloaded code"]);
  });

  it.each(["disabled", "regular"])("keeps rebuilt messages untouched in %s mode", async mode => {
    const previous = await import("./index.js");
    previous.installCopyButtons(host, options([]));
    previous.disableCopyButtons(host);
    const next = await freshWithPlainText("new code");
    const handlers = new Map<string, (event: unknown, ctx: unknown) => void>();
    const pi = { on: (name: string, handler: (event: unknown, ctx: unknown) => void) => handlers.set(name, handler) };
    next.registerCopyButtons(pi as never, host, () => ({ "copyButtons.enabled": mode !== "disabled" }), async () => {});
    const rebuilt = new AssistantMessageComponent(message, false, theme, undefined, 0);
    const children = (rebuilt as unknown as { contentContainer: { children: Component[] } }).contentContainer.children;
    const md = children.find((child): child is Markdown => child instanceof Markdown);
    if (!md) throw new Error("assistant has no Markdown");
    const expected = new Markdown("**Bold**", 0, 0, theme).render(90);
    expect(md.render(90)).toEqual(expected);
    const context = { mode: "tui", hasUI: true, cwd: "/project", ui: {
      setWidget: (_key: string, make: (tui: unknown) => unknown) => make({ mode: mode === "disabled" ? "fullscreen" : "regular", requestRender: () => {} }),
      notify: vi.fn(),
    } };
    handlers.get("session_start")?.({}, context);
    expect(md.render(90)).toEqual(expected);
    const move: TuiMouseEvent = { type: "move", button: "none", x: 1, y: 1, screenX: 1, screenY: 1, width: 90, height: 10, shift: false, alt: false, ctrl: false };
    expect((md as Component).handleMouse?.(move)).toBeUndefined();
    expect(md.render(90)).toEqual(expected);
  });

  it("upgrades a legacy patch without losing a wrapper that captured it", async () => {
    const base = vi.spyOn(proto, "updateContent");
    const detach = vi.fn();
    const legacyState = { options: options([]), enabled: true, detach };
    const legacyOriginal = proto.updateContent;
    patched[patch] = { original: legacyOriginal, state: legacyState };
    proto.updateContent = function (...args) {
      legacyOriginal.apply(this, args);
      if (!legacyState.enabled) return;
      const children = (this as unknown as { contentContainer: { children: Component[] } }).contentContainer.children;
      for (const child of children) if (child instanceof Markdown) (child as Component).handleMouse = () => ({ handled: true });
    };
    const legacyWrapper = proto.updateContent;
    const other = vi.fn(function (this: AssistantMessageComponent, ...args: Parameters<typeof original>) {
      return legacyWrapper.apply(this, args);
    });
    proto.updateContent = other;

    const next = await freshWithPlainText("upgraded module");
    const copied: string[] = [];
    next.installCopyButtons(host, options(copied));
    const assistant = new AssistantMessageComponent(undefined, false, theme, undefined, 0);
    assistant.updateContent(message, false);
    await copyText(assistant);
    expect(copied).toEqual(["upgraded module"]);
    expect(base).toHaveBeenCalledTimes(1);
    expect(other).toHaveBeenCalledTimes(1);
    expect(detach).toHaveBeenCalledOnce();

    const again = await freshWithPlainText("reloaded upgrade");
    again.installCopyButtons(host, options(copied));
    assistant.updateContent(message, false);
    await copyText(assistant);
    expect(copied).toEqual(["upgraded module", "reloaded upgrade"]);
    expect(base).toHaveBeenCalledTimes(2);
    expect(other).toHaveBeenCalledTimes(2);
  });
});

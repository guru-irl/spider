import { afterEach, describe, expect, it, vi } from "vitest";
import { AssistantMessageComponent } from "@earendil-works/pi-coding-agent";
import { Markdown, stripTerminalSequences, visibleWidth, type Component, type MarkdownTheme, type TuiMouseEvent } from "@earendil-works/pi-tui";
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
const host = { AssistantMessageComponent, Markdown };
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

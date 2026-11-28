import { afterEach, expect, it, vi } from "vitest";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Spacer as NativeSpacer, stripTerminalSequences, type Component, type MarkdownTheme, type Terminal } from "@earendil-works/pi-tui";
import { ToolExecutionComponent as NativeTool } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { registerCopyButtons } from "./index.js";

const chunks = resolve("node_modules/@earendil-works/pi-coding-agent/dist/bundle/chunks");
const moduleName = readdirSync(chunks).find(name => name.startsWith("virtual-modules-") && name.endsWith(".js"));
if (!moduleName) throw new Error("Pi virtual modules not found");
const virtual = await import(/* @vite-ignore */ pathToFileURL(resolve(chunks, moduleName)).href);
const piHost = virtual.VIRTUAL_MODULES["@earendil-works/pi-coding-agent"] as typeof import("@earendil-works/pi-coding-agent");
const piTui = virtual.VIRTUAL_MODULES["@earendil-works/pi-tui"] as typeof import("@earendil-works/pi-tui");
const host = { AssistantMessageComponent: piHost.AssistantMessageComponent, ToolExecutionComponent: piHost.ToolExecutionComponent, Markdown: piTui.Markdown, Spacer: piTui.Spacer };
const identity = (text: string) => text;
const theme: MarkdownTheme = {
  heading: identity, link: identity, linkUrl: identity, code: identity, codeBlock: identity,
  codeBlockBorder: identity, quote: identity, quoteBorder: identity, hr: identity,
  listBullet: identity, bold: identity, italic: identity, strikethrough: identity, underline: identity,
};
const message: AssistantMessage = {
  role: "assistant", content: [{ type: "thinking", thinking: "Reasoning" }, { type: "text", text: "Reply" }],
  api: "openai-completions", provider: "test", model: "test",
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  stopReason: "stop", timestamp: Date.UTC(2024, 0, 3, 8, 15),
};
const running: InstanceType<typeof piTui.TuiAltScreen>[] = [];
afterEach(() => { for (const tui of running.splice(0)) tui.stop({ preserveScreen: true }); vi.unstubAllEnvs(); });

function fixture() {
  vi.stubEnv("TZ", "UTC");
  piHost.initTheme(undefined, false);
  let input: (data: string) => void = () => {};
  const terminal = {
    columns: 60, rows: 35, kittyProtocolActive: false,
    start: (onInput: (data: string) => void) => { input = onInput; },
    stop: () => {}, write: () => {}, hideCursor: () => {}, showCursor: () => {},
    moveBy: () => {}, clearLine: () => {}, clearFromCursor: () => {}, clearScreen: () => {},
    setTitle: () => {}, setProgress: () => {}, setProgramStatus: () => {}, drainInput: async () => {},
  } satisfies Terminal;
  const tui = new piTui.TuiAltScreen(terminal, false);
  running.push(tui);
  const handlers = new Map<string, (event: unknown, ctx: unknown) => void>();
  registerCopyButtons({ on: (name: string, handler: (event: unknown, ctx: unknown) => void) => handlers.set(name, handler) } as never, host, () => ({}), async () => {});
  handlers.get("session_start")?.({}, { mode: "tui", hasUI: true, cwd: "/project", ui: {
    setWidget: (_key: string, make: (tui: InstanceType<typeof piTui.TuiAltScreen>) => Component) => make(tui), notify: () => {},
  } });
  const chat = new piTui.Container();
  tui.addChild(chat);
  const assistant = new piHost.AssistantMessageComponent(message, false, theme, undefined, 1);
  const screen = () => { tui.renderNow(); return tui.getScreenLines().map(stripTerminalSequences); };
  const move = (fragment: string) => {
    const lines = screen();
    const y = lines.findIndex(line => line.includes(fragment));
    if (y < 0) throw new Error(`Not on screen: ${fragment}`);
    const x = piTui.visibleWidth(lines[y].slice(0, lines[y].indexOf(fragment)));
    input(`\x1b[<35;${x + 1};${y + 1}M`);
  };
  tui.start();
  return { tui, chat, assistant, screen, move };
}
const plain = (component: Component) => component.render(60).map(stripTerminalSequences);

it("uses Pi's bundled spacers and tool components for one line around a reply", () => {
  expect(piTui.Spacer).not.toBe(NativeSpacer);
  expect(piHost.ToolExecutionComponent).not.toBe(NativeTool);
  const app = fixture();
  const below = new piHost.ToolExecutionComponent("example", "call", {}, { outputPad: 1 }, undefined, app.tui, "/project");
  const belowBody = plain(below).slice(1);
  app.chat.addChild(app.assistant); app.chat.addChild(below);
  app.screen();
  const before = plain(app.chat);
  const reasoning = before.findIndex(line => line.includes("Reasoning"));
  expect(before[reasoning + 1]).toBe(" ".repeat(60));
  expect(before[reasoning + 2]).toContain("Reply");
  expect(before[reasoning + 3]).toBe(" ".repeat(60));
  expect(before.slice(reasoning + 4)).toEqual(belowBody);
  app.move("Reply"); app.screen();
  const after = plain(app.chat);
  expect(after).toHaveLength(before.length);
  expect(after[reasoning + 1]).toMatch(/^╭─+╮$/u);
  expect(after[reasoning + 3]).toMatch(/^╰Jan 3 08:15─+□ text───□ md╯$/u);
});

it("uses the reply seam before bundled reasoning and a truncation notice", () => {
  const app = fixture();
  const later: AssistantMessage = { ...message, content: [
    { type: "thinking", thinking: "Later reasoning" }, { type: "text", text: "Later reply" },
  ], stopReason: "length" };
  const next = new piHost.AssistantMessageComponent(later, false, theme, undefined, 1);
  app.chat.addChild(app.assistant); app.chat.addChild(next);
  const before = app.screen();
  const reply = before.findIndex(line => line.includes("Reply"));
  const reasoning = before.findIndex(line => line.includes("Later reasoning"));
  const laterReply = before.findIndex(line => line.includes("Later reply"));
  const notice = before.findIndex(line => line.includes("Response was truncated"));
  expect(reasoning - reply).toBe(2);
  expect(notice - laterReply).toBe(2);
  app.move("Later reply");
  const after = app.screen();
  expect(after).toHaveLength(before.length);
  expect(after[laterReply + 1]).toMatch(/^╰.*╯$/u);
  expect(after[laterReply + 2]).toContain("Response was truncated");
});

it("suppresses Pi's bundled user spacer after a reply", () => {
  const app = fixture();
  const user = new piHost.UserMessageComponent("User next", theme, 1);
  app.chat.addChild(app.assistant); app.chat.addChild(new piTui.Spacer(1)); app.chat.addChild(user);
  app.screen();
  const rows = plain(app.chat);
  const reply = rows.findIndex(line => line.includes("Reply"));
  expect(rows[reply + 1]).toBe(" ".repeat(60));
  expect(rows.slice(reply + 2)).toEqual(plain(user));
});

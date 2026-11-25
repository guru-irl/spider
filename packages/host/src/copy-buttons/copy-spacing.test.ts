import { afterEach, describe, expect, it, vi } from "vitest";
import { AssistantMessageComponent, ToolExecutionComponent, UserMessageComponent, initTheme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text, TuiAltScreen, stripTerminalSequences, visibleWidth, type Component, type MarkdownTheme, type Terminal } from "@earendil-works/pi-tui";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { registerCopyButtons } from "./index.js";

const identity = (text: string) => text;
const theme: MarkdownTheme = {
  heading: identity, link: identity, linkUrl: identity, code: identity, codeBlock: identity,
  codeBlockBorder: identity, quote: identity, quoteBorder: identity, hr: identity,
  listBullet: identity, bold: identity, italic: identity, strikethrough: identity, underline: identity,
};
const message = (text: string): AssistantMessage => ({
  role: "assistant", content: [{ type: "text", text }], api: "openai-completions", provider: "test", model: "test",
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  stopReason: "stop", timestamp: Date.UTC(2024, 0, 3, 8, 15),
});
const running: TuiAltScreen[] = [];
afterEach(() => { for (const tui of running.splice(0)) tui.stop({ preserveScreen: true }); vi.useRealTimers(); vi.unstubAllEnvs(); });

function fixture(width = 60) {
  vi.stubEnv("TZ", "UTC");
  initTheme(undefined, false);
  let input: (data: string) => void = () => {};
  const terminal = {
    columns: width, rows: 35, kittyProtocolActive: false,
    start: (onInput: (data: string) => void) => { input = onInput; },
    stop: () => {}, write: () => {}, hideCursor: () => {}, showCursor: () => {},
    moveBy: () => {}, clearLine: () => {}, clearFromCursor: () => {}, clearScreen: () => {},
    setTitle: () => {}, setProgress: () => {}, setProgramStatus: () => {}, drainInput: async () => {},
  } satisfies Terminal;
  const tui = new TuiAltScreen(terminal, false);
  running.push(tui);
  const handlers = new Map<string, (event: unknown, ctx: unknown) => void>();
  const copied: string[] = [];
  registerCopyButtons({ on: (name: string, handler: (event: unknown, ctx: unknown) => void) => handlers.set(name, handler) } as never,
    { AssistantMessageComponent, ToolExecutionComponent, Markdown, Spacer }, () => ({}), async value => { copied.push(value); });
  const context = { mode: "tui", hasUI: true, cwd: "/project", ui: {
    setWidget: (_key: string, make: (tui: TuiAltScreen) => Component) => make(tui), notify: () => {},
  } };
  handlers.get("session_start")?.({}, context);
  const chat = new Container();
  tui.addChild(chat);
  const assistant = new AssistantMessageComponent(undefined, false, theme, undefined, 1);
  assistant.updateContent(message("**Reply**"), false);
  const screen = () => { tui.renderNow(); return tui.getScreenLines().map(stripTerminalSequences); };
  const move = (fragment: string) => {
    const lines = screen();
    const y = lines.findIndex(line => line.includes(fragment));
    if (y < 0) throw new Error(`Not on screen: ${fragment}`);
    const x = visibleWidth(lines[y].slice(0, lines[y].indexOf(fragment)));
    input(`\x1b[<35;${x + 1};${y + 1}M`);
  };
  const click = (fragment: string, offset = 0, occurrence = 0) => {
    const lines = screen();
    const y = lines.findIndex(line => line.includes(fragment));
    if (y < 0) throw new Error(`Not on screen: ${fragment}`);
    let index = -1;
    for (let i = 0; i <= occurrence; i++) index = lines[y].indexOf(fragment, index + 1);
    if (index < 0) throw new Error(`Missing occurrence ${occurrence}: ${fragment}`);
    const x = visibleWidth(lines[y].slice(0, index)) + offset;
    input(`\x1b[<0;${x + 1};${y + 1}M`);
    input(`\x1b[<0;${x + 1};${y + 1}m`);
  };
  tui.start();
  return { tui, chat, assistant, screen, move, click, copied, shutdown: () => handlers.get("session_shutdown")?.({}, context) };
}
function plain(component: Component, width = 60) { return component.render(width).map(stripTerminalSequences); }
function tool(name: string) { return new ToolExecutionComponent(name, name, {}, { outputPad: 1 }); }

describe("fullscreen reply seams", () => {
  it("uses exactly the top and bottom outline rows between tool panels, without hover movement", () => {
    const app = fixture();
    const above = tool("tool-above");
    const below = tool("tool-below");
    const belowBody = plain(below).slice(1);
    app.chat.addChild(above); app.chat.addChild(app.assistant); app.chat.addChild(below);
    app.screen();
    const before = plain(app.chat);
    const top = plain(above).length;
    expect(before[top]).toBe(" ".repeat(60));
    expect(before[top + 1]).toBe(` Reply${" ".repeat(54)}`);
    expect(before[top + 2]).toBe(" ".repeat(60));
    expect(before.slice(top + 3)).toEqual(belowBody);
    app.move("Reply"); app.screen();
    const after = plain(app.chat);
    expect(after).toHaveLength(before.length);
    expect(after[top]).toBe(`🭽${"▔".repeat(58)}🭾`);
    expect(after[top + 1]).toBe(`▏Reply${" ".repeat(53)}▕`);
    expect(after[top + 2]).toMatch(/^🭼Jan 3 08:15▁+⧉ text▁▁▁⧉ md🭿$/u);
    expect(after.slice(top + 3)).toEqual(belowBody);
  });

  it("keeps one seam before a tool after an invisible tool-call-only assistant", () => {
    const app = fixture();
    const toolCall = message("");
    toolCall.content = [{ type: "toolCall", id: "call", name: "later-tool", arguments: {} }];
    const invisible = new AssistantMessageComponent(toolCall, false, theme, undefined, 1);
    const later = tool("later-tool");
    const laterBody = plain(later).slice(1);
    app.chat.addChild(app.assistant); app.chat.addChild(invisible); app.chat.addChild(later);
    app.screen();
    const rows = plain(app.chat);
    const reply = rows.findIndex(line => line.includes("Reply"));
    expect(rows[reply + 1]).toBe(" ".repeat(60));
    expect(rows.slice(reply + 2)).toEqual(laterBody);
  });

  it("suppresses a user spacer after an invisible tool-call-only assistant", () => {
    const app = fixture();
    const toolCall = message("");
    toolCall.content = [{ type: "toolCall", id: "call", name: "tool", arguments: {} }];
    const invisible = new AssistantMessageComponent(toolCall, false, theme, undefined, 1);
    const user = new UserMessageComponent("User next", theme, 1);
    app.chat.addChild(app.assistant); app.chat.addChild(invisible); app.chat.addChild(new Spacer(1)); app.chat.addChild(user);
    app.screen();
    const rows = plain(app.chat);
    const reply = rows.findIndex(line => line.includes("Reply"));
    expect(rows[reply + 1]).toBe(" ".repeat(60));
    expect(rows.slice(reply + 2)).toEqual(plain(user));
  });

  it("shares one seam across an invisible tool-call-only assistant", () => {
    const app = fixture();
    const toolCall = message("");
    toolCall.content = [{ type: "toolCall", id: "call", name: "tool", arguments: {} }];
    const invisible = new AssistantMessageComponent(toolCall, false, theme, undefined, 1);
    const later = new AssistantMessageComponent(message("Later reply"), false, theme, undefined, 1);
    app.chat.addChild(app.assistant); app.chat.addChild(invisible); app.chat.addChild(later);
    const before = app.screen();
    const first = before.findIndex(line => line.includes("Reply"));
    const second = before.findIndex(line => line.includes("Later reply"));
    expect(second - first).toBe(2);
    app.move("Later reply");
    const after = app.screen();
    expect(after[first + 1]).toMatch(/^🭽▔+🭾$/u);
  });

  it.each(["default", "self"])("keeps %s-rendered tool expansion clickable after suppressing its spacer", shell => {
    const app = fixture();
    const definition = shell === "self" ? {
      renderShell: "self",
      renderCall: () => new Text("Tool call", 0, 0),
      renderResult: (_result: unknown, options: { expanded: boolean }) => new Text(options.expanded ? "Expanded result" : "Collapsed result", 0, 0),
    } : undefined;
    const below = new ToolExecutionComponent("example", "example", {}, { outputPad: 1 }, definition as never);
    below.updateResult({ content: [{ type: "text", text: Array.from({ length: 12 }, (_, i) => `line-${i}`).join("\n") }], details: undefined }, false);
    app.chat.addChild(app.assistant); app.chat.addChild(below);
    const before = app.screen();
    const reply = before.findIndex(line => line.includes("Reply"));
    expect(before[reply + 1]).toBe(" ".repeat(60));
    app.click(shell === "self" ? "Collapsed result" : "line-0");
    const after = app.screen();
    expect(after.join("\n")).toContain(shell === "self" ? "Expanded result" : "line-11");
  });

  it("restores Pi's spacers and unframed reply after the integration shuts down", () => {
    const app = fixture();
    const user = new UserMessageComponent("User next", theme, 1);
    const spacer = new Spacer(1);
    app.chat.addChild(app.assistant); app.chat.addChild(spacer); app.chat.addChild(user);
    app.screen();
    app.shutdown();
    const original = new AssistantMessageComponent(message("**Reply**"), false, theme, undefined, 1);
    expect(plain(app.chat)).toEqual([...plain(original), ...plain(new Spacer(1)), ...plain(user)]);
  });

  it("uses the outline row in place of Pi's spacer after reasoning", () => {
    const app = fixture();
    const response = message("Reply");
    response.content.unshift({ type: "thinking", thinking: "Reasoning" });
    app.assistant.updateContent(response, false);
    app.chat.addChild(app.assistant); app.chat.addChild(new Text("Next", 0, 0));
    app.screen();
    const before = plain(app.chat);
    const i = before.findIndex(line => line.includes("Reasoning"));
    expect(before[i].indexOf("Reasoning")).toBe(1);
    expect(before[i + 1]).toBe(" ".repeat(60));
    expect(before[i + 2]).toBe(` Reply${" ".repeat(54)}`);
    expect(before[i + 3]).toBe(" ".repeat(60));
    expect(before[i + 4]).toContain("Next");
    app.move("Reply"); app.screen();
    const after = plain(app.chat);
    expect(after).toHaveLength(before.length);
    expect(after[i + 1]).toMatch(/^🭽▔+🭾$/u);
    expect(after[i + 3]).toMatch(/^🭼Jan 3 08:15▁+⧉ text▁▁▁⧉ md🭿$/u);
    expect(after[i + 4]).toContain("Next");
  });

  it("does not add Pi's inter-message spacer between the bottom outline and a user panel", () => {
    const app = fixture();
    const user = new UserMessageComponent("User next", theme, 1);
    app.chat.addChild(app.assistant); app.chat.addChild(new Spacer(1)); app.chat.addChild(user);
    app.screen();
    const before = plain(app.chat);
    const reply = before.findIndex(line => line.includes("Reply"));
    expect(before[reply + 1]).toBe(" ".repeat(60));
    expect(before.slice(reply + 2)).toEqual(plain(user));
    app.move("Reply"); app.screen();
    const after = plain(app.chat);
    expect(after).toHaveLength(before.length);
    expect(after[reply + 1]).toMatch(/^🭼Jan 3 08:15▁+⧉ text▁▁▁⧉ md🭿$/u);
    expect(after.slice(reply + 2)).toEqual(plain(user));
  });

  it("places the top outline directly after a user panel", () => {
    const app = fixture();
    const user = new UserMessageComponent("User above", theme, 1);
    app.chat.addChild(user); app.chat.addChild(app.assistant);
    app.screen();
    const before = plain(app.chat);
    const end = plain(user).length;
    expect(before[end]).toBe(" ".repeat(60));
    expect(before[end + 1]).toContain("Reply");
    app.move("Reply"); app.screen();
    const after = plain(app.chat);
    expect(after).toHaveLength(before.length);
    expect(after[end]).toMatch(/^🭽▔+🭾$/u);
    expect(after[end + 1]).toContain("Reply");
  });

  it("shares one seam between adjacent replies and shows the hovered reply's outline", () => {
    const app = fixture();
    const next = new AssistantMessageComponent(undefined, false, theme, undefined, 1);
    next.updateContent(message("Next reply"), false);
    app.chat.addChild(app.assistant); app.chat.addChild(next);
    app.screen();
    const before = plain(app.chat);
    const first = before.findIndex(line => line.includes("Reply"));
    const second = before.findIndex(line => line.includes("Next reply"));
    expect(second - first).toBe(2);
    expect(before[first + 1]).toBe(" ".repeat(60));
    app.move("Reply"); app.screen();
    const firstHover = plain(app.chat);
    expect(firstHover).toHaveLength(before.length);
    expect(firstHover[first + 1]).toMatch(/^🭼Jan 3 08:15▁+⧉ text▁▁▁⧉ md🭿$/u);
    app.move("Next reply"); app.screen();
    const nextHover = plain(app.chat);
    expect(nextHover).toHaveLength(before.length);
    expect(nextHover[first + 1]).toMatch(/^🭽▔+🭾$/u);
  });

  it.each([[15, 1, false], [30, 1, false], [31, 2, false], [42, 2, false], [43, 2, true]])(
    "fits %i-column code replies with %i action pairs and timestamp=%s",
    (width, pairs, time) => {
      const app = fixture(width);
      app.assistant.updateContent(message("```js\nabcdefghijklm\n```"), false);
      app.chat.addChild(app.assistant); app.chat.addChild(new Text("Next", 0, 0));
      const before = app.screen();
      app.move("abcdefgh");
      const after = app.screen();
      const fence = after.findLastIndex(line => line.includes("```"));
      const next = after.findIndex(line => line.includes("Next"));
      expect(next - fence).toBe(2);
      expect(before[next - 1]).toBe(" ".repeat(width));
      expect(after[next - 1]).toMatch(/^🭼.*🭿$/u);
      expect(after[next - 1].match(/⧉ text/g)).toHaveLength(pairs);
      expect(after[next - 1].includes("Jan 3 08:15")).toBe(time);
      expect(visibleWidth(after[next - 1])).toBe(width);
      expect(after.findIndex(line => line.includes("Next"))).toBe(before.findIndex(line => line.includes("Next")));
    },
  );

  it("copies the block and the full reply from their separate pairs on the bottom outline", async () => {
    const app = fixture(43);
    const source = "Intro\n\n```js\nabcdefghijklm\n```";
    app.assistant.updateContent(message(source), false);
    app.chat.addChild(app.assistant); app.chat.addChild(new Text("Next", 0, 0));
    app.move("abcdefgh");
    const row = app.screen().find(line => line.includes("⧉ text"))!;
    expect(row).toMatch(/^🭼.*⧉ text▁▁▁⧉ md▁▁▁⧉ text▁▁▁⧉ md🭿$/u);
    app.click("⧉ md", 4, 0); await Promise.resolve();
    expect(app.copied).toEqual([]);
    app.click("⧉ md", 0, 0); await Promise.resolve();
    expect(app.copied).toEqual(["```js\nabcdefghijklm\n```"]);
    expect(app.screen().join("\n")).toContain("✓ md");
    app.click("⧉ md", 0, 0); await Promise.resolve();
    expect(app.copied).toEqual(["```js\nabcdefghijklm\n```", source]);
    app.click("⧉ text", 0, 0); await Promise.resolve();
    expect(app.copied.at(-1)).toBe("abcdefghijklm");
    app.click("⧉ text", 0, 0); await Promise.resolve();
    expect(app.copied.at(-1)).toBe("Intro\n\nabcdefghijklm");
  });

  it("copies the full reply, not the hidden block, at the narrow threshold", async () => {
    const app = fixture(30);
    const source = "Intro\n\n```js\nabcdefghijklm\n```";
    app.assistant.updateContent(message(source), false);
    app.chat.addChild(app.assistant); app.chat.addChild(new Text("Next", 0, 0));
    app.move("abcdefgh");
    app.click("⧉ md"); await Promise.resolve();
    expect(app.copied).toEqual([source]);
  });

  it("drops time at narrow widths, keeps the outline and copies only label clicks", async () => {
    const app = fixture(26);
    app.chat.addChild(app.assistant); app.chat.addChild(new Text("Next", 0, 0));
    const before = app.screen();
    app.move("Reply");
    const after = app.screen();
    const reply = after.findIndex(line => line.includes("Reply"));
    expect(after[reply - 1]).toMatch(/^🭽▔+🭾$/u);
    expect(after[reply + 1]).toMatch(/^🭼▁+⧉ text▁▁▁⧉ md🭿$/u);
    expect(after[reply + 1]).not.toContain("08:15");
    expect(visibleWidth(after[reply + 1])).toBe(26);
    expect(after.findIndex(line => line.includes("Next"))).toBe(before.findIndex(line => line.includes("Next")));
    app.click("⧉ text", 6); await Promise.resolve();
    expect(app.copied).toEqual([]);
    app.click("⧉ text"); await Promise.resolve();
    expect(app.copied).toEqual(["Reply"]);
    expect(app.screen()[reply + 1]).toContain("✓ text");
    app.click("⧉ md"); await Promise.resolve();
    expect(app.copied).toEqual(["Reply", "**Reply**"]);
  });
});

import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AssistantMessageComponent, BranchSummaryMessageComponent, CompactionSummaryMessageComponent, SkillInvocationMessageComponent, CustomEditor, CustomMessageComponent, ToolExecutionComponent, UserMessageComponent, Theme, createEditToolDefinition, getAgentDir, initTheme, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Container, Markdown, Spacer, Text, stripTerminalSequences, visibleWidth, type Component, type TUI, type TuiMouseEvent } from "@earendil-works/pi-tui";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { registerInputBand } from "./index.js";
import { createHalfBox } from "./box.js";
import { registerEditWriteOverrides } from "../routing/overrides.js";
import glass from "../../../herdr/assets/themes/dracula-plus-glass.json" with { type: "json" };

const host = { AssistantMessageComponent, CustomEditor, CustomMessageComponent, ToolExecutionComponent, UserMessageComponent, Box, Markdown, Spacer, Text,
  BranchSummaryMessageComponent, CompactionSummaryMessageComponent, SkillInvocationMessageComponent };
const tui = { requestRender() {} } as unknown as TUI;
const colors = Object.fromEntries(Object.entries(glass.colors).map(([role, value]) => [role, glass.vars[value as keyof typeof glass.vars] ?? value]));
const theme = new Theme(colors as ConstructorParameters<typeof Theme>[0], colors as ConstructorParameters<typeof Theme>[1], "truecolor");
const BG = "\x1b[48;2;6;6;7m";
const INK = "\x1b[38;2;6;6;7m";
const START = "\x1b]133;A\x07";
const END = "\x1b]133;B\x07\x1b]133;C\x07";
const plain = (rows: string[]) => rows.map(stripTerminalSequences).map(row => row.trimEnd());
const editTool = () => {
  type RegisteredTool = Parameters<ExtensionAPI["registerTool"]>[0];
  const overrides = new Map<string, RegisteredTool>();
  registerEditWriteOverrides({ registerTool: (tool: RegisteredTool) => overrides.set(tool.name, tool) }, {
    db: null as never, getCwd: () => "/project", getSessionId: () => "test",
  });
  const native = createEditToolDefinition("/project");
  const { renderCall, renderResult } = native;
  // Pi's withBuiltInRenderers uses these native callbacks with the registered
  // edit schema. Both schemas agree on the path and edits the callbacks read.
  const definition = { ...overrides.get("edit")!, renderCall, renderResult } as typeof native;
  return new ToolExecutionComponent("edit", "call", { path: "guide.md", edits: [{ oldText: "old", newText: "new" }] },
    {}, definition, tui, "/project");
};
const custom = () => new CustomMessageComponent({ role: "custom", customType: "notice", content: "Check the manifest", display: true, timestamp: 0 }, undefined);
const card = (name: string, self = false) => new ToolExecutionComponent(name, name, {}, {}, {
  ...(self ? { renderShell: "self" as const } : {}),
  renderCall: () => {
    if (!self) return new Text(name, 0, 0);
    const box = createHalfBox(1, text => theme.bg("toolSuccessBg", text));
    box.addChild(new Text(name, 0, 0));
    return box;
  },
  renderResult: (_result, { expanded }) => {
    const text = new Text(expanded ? `${name} expanded` : `${name} collapsed`, 0, 0);
    if (!self) return text;
    const box = createHalfBox(1, value => theme.bg("toolSuccessBg", value));
    box.addChild(text);
    return box;
  },
}, tui, "/project");
const chat = (...children: Component[]) => {
  const root = new Container();
  for (const child of children) root.addChild(child);
  return root;
};

beforeAll(() => {
  const themes = join(getAgentDir(), "themes");
  mkdirSync(themes, { recursive: true });
  copyFileSync(fileURLToPath(new URL("../../../herdr/assets/themes/dracula-plus-glass.json", import.meta.url)), join(themes, "dracula-plus-glass.json"));
});
beforeEach(() => { vi.stubEnv("COLORTERM", "truecolor"); initTheme("dracula-plus-glass"); });
let stop: (() => void) | undefined;
afterEach(() => { stop?.(); stop = undefined; vi.unstubAllEnvs(); });

function activate(config: Record<string, unknown> = {}) {
  const handlers = new Map<string, (evt: unknown, ctx: unknown) => void>();
  const pi = { on: (evt: string, handler: (evt: unknown, ctx: unknown) => void) => handlers.set(evt, handler) };
  const ctx = { cwd: "/project", mode: "tui", hasUI: true, ui: { theme, setEditorComponent() {}, getEditorComponent: () => undefined } };
  registerInputBand(pi as never, host, () => config);
  handlers.get("session_start")?.({}, ctx);
  return () => handlers.get("session_shutdown")?.({ reason: "reload" }, ctx);
}
function verifyEdges(rows: string[], width: number, start = "", end = "") {
  expect(rows[0]).toBe(`${start}${INK}${"▄".repeat(width)}\x1b[39m`);
  expect(rows.at(-1)).toBe(`${end}${INK}${"▀".repeat(width)}\x1b[39m`);
  expect(rows.every(row => visibleWidth(row) <= width)).toBe(true);
}

it("reuses unchanged half-box rows, rebuilding when the width or content changes", () => {
  const box = createHalfBox(1, text => theme.bg("toolSuccessBg", text));
  const content = new Text("Old", 0, 0);
  box.addChild(content);
  const first = box.render(32);
  expect(box.render(32)).toBe(first);
  const resized = box.render(24);
  verifyEdges(resized, 24);
  expect(box.render(24)).toBe(resized);
  content.setText("New");
  expect(plain(box.render(24))).toContain(" New");
});

it("reuses sent-message rows until Pi's Markdown changes", () => {
  stop = activate();
  const message = new UserMessageComponent("Old");
  const first = message.render(32);
  expect(message.render(32)).toBe(first);
  const resized = message.render(24);
  verifyEdges(resized, 24, START, END);
  expect(message.render(24)).toBe(resized);
  (message.children[0] as Markdown).setText("New");
  expect(plain(message.render(24))).toContain(" ❯ New");
});

it("uses the strip color in a sent message and keeps its OSC zones", () => {
  stop = activate({ "ui.icons": "nerd" });
  const width = 32;
  const rows = new UserMessageComponent("Read the guide").render(width);
  verifyEdges(rows, width, START, END);
  expect(plain(rows)[1]).toBe(" ❯ Read the guide");
  expect(rows[1]).toContain(`${BG} \x1b[38;2;130;170;255m❯\x1b[39m `);
  expect(visibleWidth(rows[1])).toBe(width);
});

it.each(["A longer line that wraps into several rows", "# Heading\n\nBody", "3. item\n4. next", "```text\na line of code\n```"])("does not change Pi's Markdown for %s", source => {
  const message = new UserMessageComponent(source);
  const stock = plain(message.render(24)).slice(1, -1);
  stop = activate({ "ui.icons": "nerd" });
  const rows = plain(message.render(26)).slice(1, -1);
  expect(rows[0]).toMatch(/^ ❯ /u);
  expect(rows.slice(1).every(row => !row || row.startsWith("   "))).toBe(true);
  expect(rows.map((row, i) => (i === 0 ? row.replace(" ❯", "  ") : row).slice(2))).toEqual(stock);
});

it("keeps narrow messages within their supplied width and leaves unknown shapes alone", () => {
  const message = new UserMessageComponent("界界界 next");
  const changed = new UserMessageComponent("original");
  changed.clear(); changed.addChild(new Text("New shape", 0, 0));
  const stock = changed.render(40);
  stop = activate();
  for (let w = 1; w <= 12; w++) expect(message.render(w).every(row => visibleWidth(row) <= w), `${w} columns`).toBe(true);
  expect(changed.render(40)).toEqual(stock);
});

it("uses one caret after reload and restores stock when disabled", () => {
  const message = new UserMessageComponent("Read the guide");
  const stock = message.render(40);
  const first = activate({ "ui.icons": "nerd" });
  const second = activate({ "ui.icons": "nerd" });
  stop = second;
  first(); // A retired session cannot disable the next activation.
  const decorated = plain(message.render(40)).join("\n");
  expect(decorated.match(/❯/gu)).toHaveLength(1);
  second();
  stop = activate({ "ui.inputBand": false });
  expect(message.render(40)).toEqual(stock);
  verifyEdges(custom().render(40).slice(1), 40);
});

it("changes the registered edit override and default custom message padding into half rows", () => {
  stop = activate();
  const edit = editTool();
  edit.updateResult({ content: [{ type: "text", text: "Applied the edit" }], details: { diff: "- old\n+ new" }, isError: false });
  for (const [component, title] of [[edit, "edit"], [custom(), "[notice]"]] as const) {
    const [spacer, ...rows] = component.render(64);
    expect(spacer.trim()).toBe("");
    verifyEdges(rows, 64);
    expect(plain(rows)[1]).toMatch(new RegExp(`^ ${title.replace("[", "\\[").replace("]", "\\]")}`));
    expect(rows[1].startsWith(`${BG} `)).toBe(true);
    expect(plain(rows).at(-2)).not.toBe("");
  }
});

it.each([
  ["branch", () => new BranchSummaryMessageComponent({ role: "branchSummary", fromId: "old", summary: "Branch details", timestamp: 0 }), "Branch details"],
  ["compaction", () => new CompactionSummaryMessageComponent({ role: "compactionSummary", summary: "Compaction details", tokensBefore: 100, timestamp: 0 }), "Compaction details"],
  ["skill", () => new SkillInvocationMessageComponent({ name: "review", location: "/project", content: "Skill details", userMessage: undefined }), "Skill details"],
] as const)("draws half edges for Pi's %s box without losing expansion", (label, create, detail) => {
  stop = activate();
  const box = create();
  const width = 64;
  const rows = box.render(width);
  verifyEdges(rows, width);
  expect(plain(rows)[1]).toMatch(new RegExp(`^ \\[${label}\\]`));
  expect(plain(rows).join("\n")).not.toContain(detail);
  const clicked = box.handleMouse({ type: "click", button: "left", x: 1, y: 1, width, height: rows.length, screenX: 1, screenY: 1, shift: false, alt: false, ctrl: false });
  expect(clicked).toMatchObject({ handled: true });
  expect(plain(box.render(width)).join("\n")).toContain(detail);
  stop();
  expect(box.render(width)[0]).toBe(`${BG}${" ".repeat(width)}\x1b[49m`);
});

it("keeps just Pi's intentional separator before an edit error", () => {
  stop = activate();
  const edit = editTool();
  edit.updateResult({ content: [{ type: "text", text: "Could not edit guide.md" }], isError: true });
  const rows = plain(edit.render(64));
  expect(rows).toEqual(["", "▄".repeat(64), " edit guide.md", "▀".repeat(64), "", " Could not edit guide.md"]);
});

it("removes only outer blank content rows and keeps Pi's mouse dispatch", () => {
  stop = activate();
  const call = new Text("\nTitle\n\nDetail", 0, 0);
  const result = () => new Text("Result\n\n", 0, 0);
  let resultClicks = 0;
  const tool = new ToolExecutionComponent("probe", "call", {}, {}, {
    renderCall: () => call,
    renderResult: (_result, { expanded }) => {
      const component = result();
      if (expanded) component.setText("Expanded");
      return Object.assign(component, { handleMouse(event: TuiMouseEvent) {
        if (event.type !== "click" || event.y !== 0 || event.x !== 0) return undefined;
        resultClicks++;
        return { handled: true };
      } });
    },
  }, tui, "/project");
  tool.updateResult({ content: [], isError: false });
  const width = 24;
  const rows = tool.render(width);
  expect(plain(rows).slice(2, -1)).toEqual([" Title", "", " Detail", " Result"]);
  const click = (x: number) => tool.handleMouse({ type: "click", button: "left", x, y: 5, width, height: rows.length, screenX: x, screenY: 5, shift: false, alt: false, ctrl: false });
  expect(click(1)).toMatchObject({ handled: true });
  expect(resultClicks).toBe(1);
  expect(click(2)).toMatchObject({ handled: true });
  expect(plain(tool.render(width))).toContain(" Expanded");
});

it("trims box-colored padding without dropping outer swatches painted in other backgrounds", () => {
  const box = createHalfBox(1, text => theme.bg("toolSuccessBg", text));
  box.addChild({
    render: () => [
      "\x1b[1;48;2;6;6;7;38;5;48m  \x1b[0m", // The box color, with unrelated text attributes.
      "\x1b[48:2::6:6:7m  \x1b[49m", // The same color with colon-delimited SGR.
      "\x1b[1;48;5;4m   \x1b[49m", // An index-color swatch.
      "Label",
      "\x1b[48:2::9:8:7m   \x1b[49m", // A truecolor swatch.
      "\x1b[44m   \x1b[49m", // A palette swatch.
      "\x1b[38;2;40;48;100m  \x1b[39m", // Foreground values are not SGR background codes.
    ],
    invalidate() {},
  });
  const rows = box.render(32);
  verifyEdges(rows, 32);
  expect(plain(rows).slice(1, -1)).toEqual(["", " Label", "", ""]);
  expect(rows[1]).toContain("\x1b[1;48;5;4m");
  expect(rows[3]).toContain("\x1b[48:2::9:8:7m");
  expect(rows[4]).toContain("\x1b[44m");
});

it.each([false, true])("places consecutive default and self-shell cards together with expanded=%s", expanded => {
  stop = activate();
  const first = card("first");
  const second = card("second", true);
  for (const tool of [first, second]) {
    tool.updateResult({ content: [], isError: false });
    tool.setExpanded(expanded);
  }
  const rows = plain(chat(first, second, card("third")).render(24));
  expect(rows).toEqual([
    "", "▄".repeat(24), " first", expanded ? " first expanded" : " first collapsed", "▀".repeat(24),
    "▄".repeat(24), " second", "▀".repeat(24), "▄".repeat(24),
    expanded ? " second expanded" : " second collapsed", "▀".repeat(24),
    "▄".repeat(24), " third", "▀".repeat(24),
  ]);
});

const response = (content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"] = "toolUse"): AssistantMessage => ({
  role: "assistant", content, api: "openai-completions", provider: "test", model: "test",
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  stopReason, timestamp: 0,
});
const toolCall = { type: "toolCall" as const, id: "second", name: "second", arguments: {} };
const assistant = (message: AssistantMessage, hidden = false, label = "") =>
  new AssistantMessageComponent(message, hidden, undefined, label, 0);
// Some host renderers/extensions leave blank rows even with no visible content.
const withBlankRows = (message: AssistantMessage, hidden = false) => {
  const component = assistant(message, hidden);
  component.addChild(new Spacer(2));
  return component;
};

it.each([
  ["tool-call-only", response([toolCall]), false],
  ["hidden thinking", response([{ type: "thinking", thinking: "Private reasoning" }, toolCall]), true],
] as const)("joins separate boxed turns across a blank %s message and preserves mouse clicks", (_name, message, hidden) => {
  stop = activate();
  const first = card("first");
  const second = card("second");
  second.updateResult({ content: [], isError: false });
  const root = chat(first, withBlankRows(message, hidden), second);
  const width = 24;
  const rows = plain(root.render(width));
  expect(rows).toEqual(["", "▄".repeat(width), " first", "▀".repeat(width),
    "▄".repeat(width), " second", " second collapsed", "▀".repeat(width)]);
  const layout = (root as unknown as { mouseLayout: { children: { height: number }[] } }).mouseLayout;
  expect(layout.children.reduce((sum, entry) => sum + entry.height, 0)).toBe(rows.length);
  const y = rows.indexOf(" second collapsed");
  expect(root.handleMouse({ type: "click", button: "left", x: 2, y, width, height: rows.length, screenX: 2, screenY: y, shift: false, alt: false, ctrl: false })).toMatchObject({ handled: true });
  expect(plain(root.render(width))).toContain(" second expanded");
});

it.each([
  ["text", response([{ type: "text", text: "Visible reply" }, toolCall]), false, "Visible reply"],
  ["visible thinking", response([{ type: "thinking", thinking: "Visible reasoning" }, toolCall]), false, "Visible reasoning"],
  ["thinking label", response([{ type: "thinking", thinking: "Reasoning" }, toolCall]), true, "Thinking..."],
  ["error", response([], "error"), false, "Error:"],
] as const)("keeps spacing around assistant %s", (_name, message, hidden, text) => {
  stop = activate();
  const middle = assistant(message, hidden, text === "Thinking..." ? text : "");
  const first = card("first"), second = card("second");
  const root = chat(first, middle, second);
  const rows = plain(root.render(32));
  expect(rows).toEqual([...plain(first.render(32)), ...plain(middle.render(32)), ...plain(second.render(32))]);
  expect(rows.join("\n")).toContain(text);
});

it("does not remove blank assistant rows when the next tool is unboxed", () => {
  stop = activate();
  const middle = withBlankRows(response([toolCall]));
  const raw = new ToolExecutionComponent("raw", "raw", {}, {}, { renderShell: "self", renderCall: () => new Text("raw", 0, 0) }, tui, "/project");
  const first = card("first");
  expect(plain(chat(first, middle, raw).render(24))).toEqual([...plain(first.render(24)), ...plain(middle.render(24)), ...plain(raw.render(24))]);
});

it.each([
  ["painted background", "\x1b[44m    \x1b[49m"],
  ["terminal image", "\x1b_Gf=100;AAAA\x1b\\"],
] as const)("keeps a visually meaningful %s row in an assistant", (_name, row) => {
  stop = activate();
  const middle = assistant(response([toolCall]));
  middle.addChild({ render: () => [row], invalidate() {} });
  const first = card("first"), second = card("second");
  expect(chat(first, middle, second).render(24)).toEqual([...first.render(24), ...middle.render(24), ...second.render(24)]);
});

it("retains blank assistant rows when no boxed tool follows", () => {
  stop = activate();
  const first = card("first"), middle = withBlankRows(response([toolCall]));
  const text = new Text("Next reply", 0, 0);
  expect(chat(first, middle, text).render(24)).toEqual([...first.render(24), ...middle.render(24), ...text.render(24)]);
});

it("joins cards using the active bundled Pi Spacer class", async () => {
  const chunks = resolve("node_modules/@earendil-works/pi-coding-agent/dist/bundle/chunks");
  const name = readdirSync(chunks).find(file => file.startsWith("virtual-modules-") && file.endsWith(".js"))!;
  const virtual = await import(/* @vite-ignore */ pathToFileURL(resolve(chunks, name)).href);
  const pi = virtual.VIRTUAL_MODULES["@earendil-works/pi-coding-agent"] as typeof import("@earendil-works/pi-coding-agent");
  const pt = virtual.VIRTUAL_MODULES["@earendil-works/pi-tui"] as typeof import("@earendil-works/pi-tui");
  expect(pt.Spacer).not.toBe(Spacer);
  pi.initTheme("dark", false);
  const handlers = new Map<string, (event: unknown, ctx: unknown) => void>();
  registerInputBand({ on: (name: string, handler: (event: unknown, ctx: unknown) => void) => handlers.set(name, handler) } as never,
    { ...pi, ...pt }, () => ({}));
  const ctx = { cwd: "/project", mode: "tui", hasUI: true, ui: { theme, setEditorComponent() {}, getEditorComponent: () => undefined } };
  handlers.get("session_start")?.({}, ctx);
  stop = () => handlers.get("session_shutdown")?.({}, ctx);
  const first = new pi.ToolExecutionComponent("first", "first", {}, {}, undefined, tui, "/project");
  const middle = new pi.AssistantMessageComponent(response([toolCall]), false, undefined, "", 0);
  const second = new pi.ToolExecutionComponent("second", "second", {}, {}, undefined, tui, "/project");
  const root = new pt.Container();
  root.addChild(first); root.addChild(middle); root.addChild(second);
  const rows = plain(root.render(24));
  const end = rows.indexOf("▀".repeat(24));
  expect(end).toBeGreaterThan(0);
  expect(rows[end + 1]).toBe("▄".repeat(24));
});

it("keeps spacing around non-tool and hidden tool components", () => {
  stop = activate();
  const hidden = card("hidden");
  Object.assign(hidden, { hideComponent: true });
  const empty = new ToolExecutionComponent("empty", "empty", {}, {}, {
    renderShell: "self", renderCall: () => new Container(),
  }, tui, "/project");
  const rows = plain(chat(card("first"), hidden, empty, card("second"), custom(), card("third")).render(24));
  expect(rows.slice(0, 7)).toEqual(["", "▄".repeat(24), " first", "▀".repeat(24), "▄".repeat(24), " second", "▀".repeat(24)]);
  expect(rows.slice(7, 10)).toEqual(["", "▄".repeat(24), " [notice]"]);
  const last = rows.indexOf(" third");
  expect(rows.slice(last - 2, last)).toEqual(["", "▄".repeat(24)]);
});

it("retains one separator after non-tool text when an intervening tool is hidden", () => {
  stop = activate();
  const hidden = card("hidden");
  Object.assign(hidden, { hideComponent: true });
  const root = chat(card("first"), new Text("Assistant reply", 0, 0), hidden, card("second"));
  const rows = plain(root.render(24));
  const reply = rows.indexOf("Assistant reply");
  expect(rows.slice(reply, reply + 4)).toEqual(["Assistant reply", "", "▄".repeat(24), " second"]);
});

it.each(["first", "second"])("joins the native self-shell edit as the %s card", position => {
  stop = activate();
  const edit = editTool();
  const other = card("other");
  const root = position === "first" ? chat(edit, other) : chat(other, edit);
  const rows = plain(root.render(32));
  const boundary = rows.indexOf("▀".repeat(32));
  expect(rows[boundary + 1]).toBe("▄".repeat(32));
});

it("leaves a tool with an unknown leading component unchanged", () => {
  stop = activate();
  const second = card("second");
  second.children[0] = { render: () => [""], invalidate() {} };
  const rows = plain(chat(card("first"), second).render(24));
  expect(rows.slice(3, 6)).toEqual(["▀".repeat(24), "", "▄".repeat(24)]);
});

it("retains stock spacing if a self-shell lacks half edges", () => {
  stop = activate();
  const raw = new ToolExecutionComponent("raw", "raw", {}, {}, { renderShell: "self", renderCall: () => new Text("raw", 0, 0) }, tui, "/project");
  const rows = plain(chat(card("first"), raw, card("last")).render(24));
  expect(rows).toEqual(["", "▄".repeat(24), " first", "▀".repeat(24), "", "raw", "", "▄".repeat(24), " last", "▀".repeat(24)]);
});

it("restores stock spacing when the transcript patch is disabled", () => {
  const root = chat(card("first"), card("second"));
  const stock = root.render(24);
  stop = activate();
  expect(plain(root.render(24))[4]).toBe("▄".repeat(24));
  stop();
  stop = undefined;
  expect(root.render(24)).toEqual(stock);
});

it.each([false, true])("keeps Pi's click expansion on the second adjacent tool (self=%s)", self => {
  stop = activate();
  const first = card("first");
  const second = card("second", self);
  second.updateResult({ content: [], isError: false });
  const root = chat(first, second);
  const width = 24;
  const rows = plain(root.render(width));
  const y = rows.indexOf(" second collapsed");
  expect(root.handleMouse({ type: "click", button: "left", x: 2, y, width, height: rows.length, screenX: 2, screenY: y, shift: false, alt: false, ctrl: false })).toMatchObject({ handled: true });
  expect(plain(root.render(width))).toContain(" second expanded");
});

it("leaves Pi's self-rendered tool shell and a box without padding unchanged", () => {
  const tool = new ToolExecutionComponent("self", "call", {}, {}, { renderShell: "self", renderCall: () => new Text("Self", 0, 0) }, tui, "/project");
  const noPadding = custom();
  const box = noPadding.children.find(child => child instanceof Box)!;
  Object.assign(box, { paddingY: 0 });
  const before = [tool.render(40), noPadding.render(40)];
  stop = activate();
  expect([tool.render(40), noPadding.render(40)]).toEqual(before);
});

import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BranchSummaryMessageComponent, CompactionSummaryMessageComponent, SkillInvocationMessageComponent, CustomEditor, CustomMessageComponent, ToolExecutionComponent, UserMessageComponent, Theme, createEditToolDefinition, getAgentDir, initTheme } from "@earendil-works/pi-coding-agent";
import { Box, Markdown, Text, stripTerminalSequences, visibleWidth, type TUI, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { registerInputBand } from "./index.js";
import { createHalfBox } from "./box.js";
import { registerEditWriteOverrides } from "../routing/overrides.js";
import glass from "../../../herdr/assets/themes/dracula-plus-glass.json" with { type: "json" };

const host = { CustomEditor, CustomMessageComponent, ToolExecutionComponent, UserMessageComponent, Box, Markdown, Text,
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
  const overrides = new Map<string, NonNullable<ConstructorParameters<typeof ToolExecutionComponent>[4]>>();
  registerEditWriteOverrides({ registerTool: (tool: { name: string }) => overrides.set(tool.name, tool) }, {
    db: null as never, getCwd: () => "/project", getSessionId: () => "test",
  });
  const { renderCall, renderResult } = createEditToolDefinition("/project");
  // Match Pi's withBuiltInRenderers: inherit the renderers, not renderShell.
  return new ToolExecutionComponent("edit", "call", { path: "guide.md", edits: [{ oldText: "old", newText: "new" }] },
    {}, { ...overrides.get("edit"), renderCall, renderResult }, tui, "/project");
};
const custom = () => new CustomMessageComponent({ role: "custom", customType: "notice", content: "Check the manifest", display: true, timestamp: 0 }, undefined);

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

it("leaves Pi's self-rendered tool shell and a box without padding unchanged", () => {
  const tool = new ToolExecutionComponent("self", "call", {}, {}, { renderShell: "self", renderCall: () => new Text("Self", 0, 0) }, tui, "/project");
  const noPadding = custom();
  const box = noPadding.children.find(child => child instanceof Box)!;
  Object.assign(box, { paddingY: 0 });
  const before = [tool.render(40), noPadding.render(40)];
  stop = activate();
  expect([tool.render(40), noPadding.render(40)]).toEqual(before);
});

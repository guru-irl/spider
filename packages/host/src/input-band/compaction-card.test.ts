import {
  CompactionSummaryMessageComponent, CustomEditor, InteractiveMode, Theme, getMarkdownTheme, initTheme,
} from "@earendil-works/pi-coding-agent";
import {
  Box, Container, KeybindingsManager, Markdown, Spacer, Text, getKeybindings, setKeybindings,
  stripTerminalSequences, visibleWidth,
} from "@earendil-works/pi-tui";
import { afterEach, beforeEach, expect, it } from "vitest";
import glass from "../../../herdr/assets/themes/dracula-plus-glass.json" with { type: "json" };
import { registerInputBand } from "./index.js";

const colors = Object.fromEntries(Object.entries(glass.colors).map(([role, value]) => [role, glass.vars[value as keyof typeof glass.vars] ?? value]));
const theme = new Theme(colors as ConstructorParameters<typeof Theme>[0], colors as ConstructorParameters<typeof Theme>[1], "truecolor");
const host = { Box, CompactionSummaryMessageComponent, CustomEditor, InteractiveMode, Markdown, Spacer, Text };
const summary = "## Goal\n\nSave the release notes."; // 32 characters, eight estimated tokens.
const message = { role: "compactionSummary", summary, tokensBefore: 91400, timestamp: 0 } as const;
const usage = {
  input: 24000, output: 712, cacheRead: 800, cacheWrite: 488, totalTokens: 999999,
  cost: { input: 0.19, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.21 },
};
const billing = { type: "compaction_cost", kind: "compaction", usage } as const;
const entry = { id: "compacted", type: "compaction", summary, tokensBefore: message.tokensBefore,
  details: { summaryModel: "demo/terra" } };
const width = 90;
const plain = (rows: string[]) => rows.map(row => stripTerminalSequences(row).trimEnd());
const render = (chat: Container) => plain(chat.render(width)).join("\n");
let stop: (() => void) | undefined;
let oldKeys: KeybindingsManager;

beforeEach(() => {
  initTheme("dark", false);
  oldKeys = getKeybindings();
  setKeybindings(new KeybindingsManager({ "app.tools.expand": { defaultKeys: "ctrl+o", description: "Expand output" } }));
});
afterEach(() => { stop?.(); stop = undefined; setKeybindings(oldKeys); });

function activate(currentEntry = entry, config: Record<string, unknown> = {}) {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => void>();
  registerInputBand({ on: (event: string, handler: (event: unknown, ctx: unknown) => void) => handlers.set(event, handler) } as never,
    host, () => config);
  const ctx = {
    cwd: "/project", mode: "tui", hasUI: true,
    ui: { theme, setEditorComponent() {}, getEditorComponent: () => undefined },
    sessionManager: { getEntry: (id: string) => id === "compacted" ? currentEntry : undefined, buildContextEntries: () => [currentEntry] },
    modelRegistry: { find: (provider: string, id: string) => provider === "demo" && id === "terra" ? { name: "Terra Demo" } : undefined },
  };
  handlers.get("session_start")?.({ reason: "startup" }, ctx);
  stop = () => handlers.get("session_shutdown")?.({ reason: "reload" }, ctx);
}

// Real Pi render, billing and expansion methods; no terminal, model or session I/O.
function transcript(showNotices = true) {
  type Notice = Omit<typeof billing, "kind"> & { kind: "compaction" | "branch_summary" };
  type Mode = { addMessageToChat: (msg: typeof message, options?: { messageId: string }) => void;
    addCompactionCostNotice: (notice: Notice) => void; toggleToolOutputExpansion: () => void };
  const chat = new Container();
  const mode = Object.assign(Object.create(InteractiveMode.prototype) as Mode, {
    runtimeHost: { session: { settingsManager: { getShowCacheMissNotices: () => showNotices } } },
    chatContainer: chat, loadedResourcesContainer: new Container(), pendingMessagesContainer: new Container(),
    outputPad: 1, toolOutputExpanded: false, showStatus() {},
    getMarkdownThemeWithSettings: getMarkdownTheme,
    getMarkdownTransformers: () => [() => "## Goal\n\n**Keep** the searchable release notes."],
  });
  return { chat, mode };
}

it("draws a half-box receipt without a logo and keeps the summary out of the collapsed rows", () => {
  activate(entry, { "ui.inputBand": false });
  const { chat, mode } = transcript();
  mode.addMessageToChat(message, { messageId: "compacted" });
  const rows = plain(chat.render(width));
  expect(rows[0]).toBe("");
  expect(rows[1]).toBe("▄".repeat(width));
  expect(rows[2]).toMatch(/^ ◐ compaction · Terra Demo +ctrl\+o expand$/u);
  expect(rows[3]).toBe("   91.4k tokens before  →  ~8 in summary");
  expect(rows[4]).toBe("▀".repeat(width));
  expect(rows.join("\n")).not.toContain("release notes");
  for (const cols of [18, 30, 52, width]) {
    expect(chat.render(cols).every(row => visibleWidth(row) <= cols)).toBe(true);
  }
});

it("uses the native configured key hint and only names a matching compaction model", () => {
  activate({ ...entry, summary: "Unrelated compaction" });
  setKeybindings(new KeybindingsManager({ "app.tools.expand": { defaultKeys: "ctrl+y", description: "Expand output" } }));
  const { chat, mode } = transcript();
  mode.addMessageToChat(message);
  expect(render(chat)).toContain("ctrl+y expand");
  expect(render(chat)).not.toContain("Terra Demo");
});

it("adds the native Markdown body once on Pi's global expansion action", () => {
  activate();
  const { chat, mode } = transcript();
  mode.addMessageToChat(message);
  expect(render(chat)).toContain("Terra Demo");
  mode.toggleToolOutputExpansion();
  const expanded = render(chat);
  expect(expanded).toContain("Keep the searchable release notes.");
  expect(expanded).not.toContain("Save the release notes.");
  expect(expanded.match(/91\.4k/g)).toHaveLength(1);
  expect(expanded).not.toContain("Compacted from");
  mode.toggleToolOutputExpansion();
  expect(render(chat)).not.toContain("Keep the searchable release notes.");
});

it("folds Pi's billed tokens and estimate inside the card without leaving a spacer", () => {
  activate();
  const { chat, mode } = transcript();
  mode.addMessageToChat(message);
  mode.addCompactionCostNotice(billing);
  const rows = plain(chat.render(width));
  expect(rows.filter(row => row.includes("tokens billed"))).toEqual(["   26k tokens billed · ~$0.21"]);
  expect(rows.at(-2)).toContain("26k tokens billed");
  expect(rows.at(-1)).toBe("▀".repeat(width));
  mode.toggleToolOutputExpansion();
  expect(render(chat).match(/26k tokens billed/g)).toHaveLength(1);
});

it("honors Pi's billing setting and leaves branch billing alone", () => {
  activate();
  const hidden = transcript(false);
  hidden.mode.addMessageToChat(message);
  hidden.mode.addCompactionCostNotice(billing);
  expect(render(hidden.chat)).toContain("in summary");
  expect(render(hidden.chat)).not.toContain("tokens billed");
  const branch = transcript();
  branch.mode.addMessageToChat(message);
  branch.mode.addCompactionCostNotice({ ...billing, kind: "branch_summary" });
  expect(render(branch.chat)).toContain("Branch summary: 26k tokens billed (~$0.21)");
});

it("leaves unknown Pi card layouts and their bill byte-for-byte unchanged", () => {
  const stock = () => {
    const { chat, mode } = transcript();
    mode.addMessageToChat(message);
    const card = chat.children[1] as CompactionSummaryMessageComponent;
    card.addChild(new Text("New Pi layout", 0, 0));
    mode.addCompactionCostNotice(billing);
    return chat.render(width);
  };
  const before = stock();
  expect(plain(before).join("\n")).toContain("Compaction: 26k tokens billed (~$0.21)");
  activate();
  expect(stock()).toEqual(before);
});

it("restores Pi's card and separate bill when the session binding is released", () => {
  activate();
  const { chat, mode } = transcript();
  mode.addMessageToChat(message);
  mode.addCompactionCostNotice(billing);
  expect(render(chat)).toContain("26k tokens billed · ~$0.21");
  stop?.();
  expect(render(chat)).toContain("[compaction]");
  expect(render(chat)).toContain("Compaction: 26k tokens billed (~$0.21)");
});

it("lets Pi expand on a left click in the receipt but not on the half-row edge", () => {
  activate();
  const { chat, mode } = transcript();
  mode.addMessageToChat(message);
  const click = (y: number, button: "left" | "right" = "left") => chat.handleMouse({
    type: "click", button, x: 4, y, width, height: chat.render(width).length,
    screenX: 4, screenY: y, shift: false, alt: false, ctrl: false,
  });
  expect(click(1)).toBeUndefined();
  expect(click(2, "right")).toBeUndefined();
  // The new metric row occupies a different place in the expanded Pi box.
  expect(plain(chat.render(width))[3]).toContain("in summary");
  expect(click(3)).toMatchObject({ handled: true });
  expect(render(chat)).toContain("Keep the searchable release notes.");
  expect(click(3)).toMatchObject({ handled: true });
  expect(render(chat)).not.toContain("Keep the searchable release notes.");
});

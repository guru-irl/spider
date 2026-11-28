import {
  CompactionSummaryMessageComponent, CustomEditor, InteractiveMode, Theme, getMarkdownTheme, initTheme, type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import {
  Box, Container, KeybindingsManager, Markdown, Spacer, Text, getKeybindings, setKeybindings,
  stripTerminalSequences, visibleWidth, type Component, type TUI,
} from "@earendil-works/pi-tui";
import { afterEach, beforeEach, expect, it } from "vitest";
import glass from "../../../herdr/assets/themes/dracula-plus-glass.json" with { type: "json" };
import { registerInputBand } from "./index.js";
import { registerCompactionReader } from "./compaction-reader.js";

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
  timestamp: "2026-03-10T12:15:00Z", usage, details: { summaryModel: "demo/terra" } };
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

function activate(currentEntry = entry, config: Record<string, unknown> = {}, branch?: (typeof entry)[]) {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => void>();
  const commands = new Map<string, (args: string, ctx: unknown) => Promise<void>>();
  const pi = {
    on: (event: string, handler: (event: unknown, ctx: unknown) => void) => handlers.set(event, handler),
    registerCommand: (name: string, command: { handler: (args: string, ctx: unknown) => Promise<void> }) => commands.set(name, command.handler),
  };
  registerInputBand(pi as never, host, () => config);
  registerCompactionReader(pi as never);
  const notices: string[] = [];
  const overlays: { component: Component; options: unknown }[] = [];
  const custom: ExtensionUIContext["custom"] = async (factory, options) => {
    const component = await factory({ terminal: { rows: 29 }, requestRender() {} } as TUI, theme, getKeybindings(), () => {});
    overlays.push({ component, options });
    return undefined as never;
  };
  const ctx = {
    cwd: "/project", mode: "tui", hasUI: true,
    ui: { theme, setEditorComponent() {}, getEditorComponent: () => undefined, ...(branch ? { custom } : {}), notify: (text: string) => notices.push(text) },
    sessionManager: { getEntry: (id: string) => [currentEntry, ...(branch ?? [])].find(item => item.id === id),
      buildContextEntries: () => [currentEntry], getBranch: () => branch ?? [currentEntry] },
    modelRegistry: { find: (provider: string, id: string) => provider === "demo" && id === "terra" ? { name: "Terra Demo" } : undefined },
  };
  handlers.get("session_start")?.({ reason: "startup" }, ctx);
  stop = () => handlers.get("session_shutdown")?.({ reason: "reload" }, ctx);
  return { commands, ctx, overlays, notices };
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
  expect(rows[3]).toBe(`   before   ${"█".repeat(17)}  91.4k tokens`);
  expect(rows[4]).toBe("   summary  ▏                  ~8 tokens");
  expect(rows[5]).toBe("▀".repeat(width));
  expect(rows.join("\n")).not.toContain("release notes");
  for (const cols of [18, 30, 52, width]) {
    expect(chat.render(cols).every(row => visibleWidth(row) <= cols)).toBe(true);
  }
});

it("rounds to the nearest eighth on the shared scale, not to the next whole cell", () => {
  activate();
  const { chat, mode } = transcript();
  // 8 tokens on a scale of 17 cells to 272 tokens is half a cell.
  mode.addMessageToChat({ ...message, tokensBefore: 272 });
  expect(plain(chat.render(width))[4]).toMatch(/summary  ▌ +~8 tokens$/u);
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
  expect(render(hidden.chat)).toMatch(/summary  ▏ +~8 tokens/u);
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
  expect(plain(chat.render(width))[3]).toContain("before");
  expect(click(3)).toMatchObject({ handled: true });
  expect(render(chat)).toContain("Keep the searchable release notes.");
  expect(click(3)).toMatchObject({ handled: true });
  expect(render(chat)).not.toContain("Keep the searchable release notes.");
});

it("opens the clicked card only from its own label and leaves nearby clicks and global expansion to Pi", async () => {
  const app = activate(entry, {}, [entry, { ...entry, id: "later", summary: "Later checkpoint." }]);
  const { chat, mode } = transcript();
  mode.addMessageToChat(message, { messageId: "compacted" });
  const header = plain(chat.render(width))[2];
  expect(header).toMatch(/Terra Demo +ctrl\+o expand +open ↗$/u);
  const x = header.indexOf("open ↗");
  const click = (col: number, button: "left" | "right" = "left") => chat.handleMouse({
    type: "click", button, x: col, y: 2, width, height: chat.render(width).length,
    screenX: col, screenY: 2, shift: false, alt: false, ctrl: false,
  });
  expect(click(x, "right")).toBeUndefined();
  expect(click(x - 1)).toMatchObject({ handled: true });
  expect(render(chat)).toContain("Keep the searchable release notes.");
  expect(app.overlays).toHaveLength(0);
  mode.toggleToolOutputExpansion();
  mode.toggleToolOutputExpansion();
  expect(render(chat)).not.toContain("Keep the searchable release notes.");
  expect(app.overlays).toHaveLength(0);
  expect(click(x)).toMatchObject({ handled: true });
  await Promise.resolve();
  expect(app.overlays).toHaveLength(1);
  expect(app.overlays[0].options).toEqual({ overlay: true, overlayOptions: {
    anchor: "top-left", width: "100%", maxHeight: "100%", margin: 0,
  } });
  const reader = app.overlays[0].component;
  reader.handleInput?.("\t");
  expect(plain(reader.render(width)).join("\n")).toContain("Save the release notes.");
  expect(render(chat)).not.toContain("Keep the searchable release notes.");
});

const richSummary = [
  "Run context.", "", "## **Goal**", "", "Preserve the checklist.", "",
  "```markdown", "## A code example, not a tab", "```", "",
  "## Progress", "", "### Complete", "", "- First item", "  - Detail of the first item", "- Second item", "",
  "### Pending", "", "1. Third item", "", "## Key Decisions", "", "Use a single index.", "",
  "<read-files>", "docs/checklist.md", "src/check.ts", "</read-files>", "",
  "<modified-files>", "src/index.ts", "</modified-files>",
].join("\n");

it("opens the latest compaction on the branch with billing, section counts, and the complete summary", async () => {
  const latest = { ...entry, id: "later", summary: richSummary };
  const app = activate(entry, {}, [entry, latest]);
  expect(app.commands.has("compaction")).toBe(true);
  await app.commands.get("compaction")!("", app.ctx);
  expect(app.overlays).toHaveLength(1);
  const reader = app.overlays[0].component;
  const view = () => plain(reader.render(width)).join("\n");
  const overview = view();
  expect(overview).toContain("Compaction / Overview");
  expect(overview).toMatch(/before +█{17} +91\.4k tokens/u);
  expect(overview).toMatch(/summary +[▏▎▍▌▋▊▉] +~\d+ tokens/u);
  expect(overview).toMatch(/billed +26k tokens/u);
  expect(overview).toMatch(/cost +~\$0\.21/u);
  expect(overview).toMatch(/model +Terra Demo/u);
  expect(overview).toMatch(/time +[^\n]*2026/u);
  expect(overview).toMatch(/Progress +3/u);
  expect(overview).toMatch(/Read files +2/u);
  expect(overview).toMatch(/Modified files +1/u);
  expect(overview).not.toContain("A code example");
  reader.handleInput?.("\t");
  expect(view()).toContain("Compaction / Goal");
  expect(view()).toContain("A code example, not a tab");
  expect(view()).not.toContain("Third item");
  reader.handleInput?.("\t");
  expect(view()).toContain("Compaction / Progress");
  expect(view()).toContain("Third item");
  expect(reader.render(width).join("\n")).toContain(theme.fg("mdHeading", "Complete"));
  reader.handleInput?.("\t");
  reader.handleInput?.("\t");
  expect(view()).toContain("docs/checklist.md");
  expect(view()).not.toContain("src/index.ts");
  reader.handleInput?.("\t");
  expect(view()).toContain("src/index.ts");
  reader.handleInput?.("\t");
  expect(view()).toContain("Compaction / Full summary");
  expect(view()).toContain("Run context.");
  reader.handleInput?.("\x1b[F");
  expect(view()).toContain("src/index.ts");
});

it("uses one Summary tab when no level-two heading exists", async () => {
  const latest = { ...entry, summary: "One paragraph.\n\n### Detail\n\nKeep this too." };
  const app = activate(latest, {}, [latest]);
  expect(app.commands.has("compaction")).toBe(true);
  await app.commands.get("compaction")!("", app.ctx);
  const reader = app.overlays[0].component;
  expect(plain(reader.render(width)).join("\n")).not.toContain("Full summary");
  reader.handleInput?.("\t");
  expect(plain(reader.render(width)).join("\n")).toContain("Compaction / Summary");
  expect(plain(reader.render(width)).join("\n")).toContain("Keep this too.");
  reader.handleInput?.("\t");
  expect(plain(reader.render(width)).join("\n")).toContain("Compaction / Overview");
});

it("does not open a reader when the current branch has no compaction", async () => {
  const app = activate(entry, {}, []);
  expect(app.commands.has("compaction")).toBe(true);
  await app.commands.get("compaction")!("", app.ctx);
  expect(app.overlays).toHaveLength(0);
  expect(app.notices).toEqual(["No compaction on this branch yet."]);
});

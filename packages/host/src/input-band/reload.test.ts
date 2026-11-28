import { CustomEditor, InteractiveMode, Theme, initTheme, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { registerInputBand } from "./index.js";
import { createUsageFooter, type FooterInput } from "../usage/footer.js";
import glass from "../../../herdr/assets/themes/dracula-plus-glass.json" with { type: "json" };

const colors = Object.fromEntries(Object.entries(glass.colors).map(([role, value]) => [role, glass.vars[value as keyof typeof glass.vars] ?? value]));
const theme = new Theme(colors as ConstructorParameters<typeof Theme>[0], colors as ConstructorParameters<typeof Theme>[1], "truecolor");
const provider = { getGitBranch: () => "main", getExtensionStatuses: () => new Map(), onBranchChange: () => () => {} } as any;
const input: FooterInput = { cwd: "~/demo", branch: null, sessionName: "session", modelId: "model", thinking: "high",
  context: { percent: 30, contextWindow: 1000000 }, subscription: true,
  totals: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, piCost: 0, aic: 0, unpricedEntries: 0, aggregateEntries: 0, estimated: false, latestCacheHitRate: null },
  counter: { availability: "disabled", snapshot: null }, statuses: new Map() };
const plain = (rows: string[]) => rows.map(stripTerminalSequences);
let stop: (() => void) | undefined;
beforeEach(() => { vi.stubEnv("COLORTERM", "truecolor"); initTheme("dark"); });
afterEach(() => { stop?.(); stop = undefined; vi.unstubAllEnvs(); });

function fixture(mismatch = false) {
  const handlers = new Map<string, Function>();
  const pi = { on: (name: string, handler: Function) => handlers.set(name, handler) } as unknown as ExtensionAPI;
  const ctx = { cwd: "/project", mode: "tui", hasUI: true, ui: { theme, setEditorComponent() {}, getEditorComponent: () => undefined } };
  registerInputBand(pi, { CustomEditor, InteractiveMode }, () => ({}));
  handlers.get("session_start")?.({ reason: "startup" }, ctx);
  stop = () => handlers.get("session_shutdown")?.({ reason: "reload" }, ctx);
  const ui = { requestRender() {}, setFocus() {} };
  const footer = createUsageFooter(() => input, theme, provider, () => {});
  footer.setWorking(Date.now());
  const before = footer.render(100);
  const footerContainer = new Container(); footerContainer.addChild(footer);
  const editorContainer = new Container();
  if (mismatch) {
    const add = editorContainer.addChild.bind(editorContainer);
    editorContainer.addChild = component => { component.render = () => ["unknown reload view"]; add(component); };
  }
  let finish!: () => void;
  const session = { isStreaming: false, isCompacting: false, reload: () => new Promise<void>(resolve => { finish = resolve; }),
    settingsManager: { getHideThinkingBlock: () => false, getOutputPad: () => 0 },
    resourceLoader: { getThemes: () => ({ themes: [] }) }, modelRuntime: { getError: () => undefined } };
  const editor = { render: () => ["editor"], invalidate() {} };
  const view = Object.assign(Object.create(InteractiveMode.prototype), {
    runtimeHost: { session }, ui, editor, editorContainer, footerContainer, customFooter: footer, footer: { render: () => ["stock footer"], invalidate() {} }, footerDataProvider: provider,
    resetExtensionUI(this: any) { this.setExtensionFooter(undefined); },
    rebuildChatFromMessages() {},
    keybindings: { reload() {} }, applyRuntimeSettings() {}, themeController: { applyFromSettings() {} }, setupAutocompleteProvider() {},
    setupExtensionShortcuts() {}, showLoadedResources() {}, maybeSaveImplicitProjectTrustAfterReload: () => false, showStatus() {}, showError(e: unknown) { throw e; },
  });
  return { view, footer, before, complete: () => finish() };
}

it("shows a static reload band and keeps a dim frozen Spider footer until its replacement", async () => {
  const { view, before, complete } = fixture();
  const pending = view.handleReloadCommand();
  const rows = view.editorContainer.render(100) as string[];
  expect(plain(rows)[0]).toBe(`▖${"▄".repeat(99)}`);
  expect(plain(rows)[1]).toContain("▌ ○ Reloading keybindings, extensions, skills, prompts, themes, and context files...");
  expect(plain(rows)[2]).toBe(`▘${"▀".repeat(99)}`);
  const frozen = view.footerContainer.render(100) as string[];
  expect(plain(frozen)).toEqual(plain(before));
  expect(frozen.join("\n")).toContain(theme.fg("dim", "◐"));
  stop?.(); stop = undefined;
  expect(view.footerContainer.render(100)).toEqual(frozen);
  for (const width of [1, 8, 24, 100]) expect((view.editorContainer.render(width) as string[]).every(row => visibleWidth(row) <= width)).toBe(true);
  await new Promise(resolve => process.nextTick(resolve));
  const next = { render: () => ["new spider footer"], invalidate() {} };
  view.setExtensionFooter(() => next);
  complete(); await pending;
  expect(view.footerContainer.render(100)).toEqual(["new spider footer"]);
});

it("freezes the last rendered Spider footer while Pi replaces the runtime", async () => {
  const { view, before, complete } = fixture();
  const pending = view.handleReloadCommand();
  const frozen = view.footerContainer.render(100) as string[];
  expect(plain(frozen)).toEqual(plain(before));
  expect(frozen.join("\n")).toContain(theme.fg("dim", "◐"));
  await new Promise(resolve => process.nextTick(resolve));
  complete(); await pending;
  expect(view.footerContainer.render(100)).toEqual(["stock footer"]);
});

it("leaves an unrecognized reload box and stock footer alone", async () => {
  const { view, complete } = fixture(true);
  const pending = view.handleReloadCommand();
  expect(view.editorContainer.render(100)).toEqual(["unknown reload view"]);
  expect(view.footerContainer.render(100)).toEqual(["stock footer"]);
  await new Promise(resolve => process.nextTick(resolve));
  complete(); await pending;
});

import { vi, type Mock } from "vitest";
import { InteractiveMode } from "@earendil-works/pi-coding-agent";
import { Container, type Component, type OverlayHandle, type TUI } from "@earendil-works/pi-tui";
import { agentsTuiFixture, type AgentsTuiFixture } from "./agents-tui";

type WidgetComponent = Component & { dispose?: () => void };
type CustomFactory = (tui: unknown, theme: unknown, keys: unknown, done: (value?: void) => void) => unknown;
type CustomOptions = { overlay?: boolean; overlayOptions?: { width?: unknown }; onHandle?: (handle: OverlayHandle) => void };
type TestTheme = { fg(token: string, value: string): string; bg(token: string, value: string): string; bold(value: string): string; italic(value: string): string };

export interface AgentsHostFixture {
  view: AgentsTuiFixture;
  ui: {
    widgets: Map<string, WidgetComponent>;
    theme: TestTheme;
    notify: Mock<(message: string, level: "info" | "error") => void>;
    setWidget: Mock<(key: string, value: unknown, options?: unknown) => void>;
    custom: Mock<(factory: CustomFactory, options?: CustomOptions) => Promise<void>>;
  };
  completions: string[];
  focuses: string[];
  settle(): Promise<void>;
  send(data: string): Promise<void>;
  holdNext(kind: "handle" | "factory" | "reject" | "selector-handle"): void;
  releaseHeld(): void;
  hasHeld(): boolean;
  focused(): Component | null;
  stack(): Component[];
  close(): void;
}

/** Uses pi's actual custom-interaction completion, but never owns a real terminal. */
export function agentsHostFixture(options: { mode?: "regular" | "fullscreen"; documentRows?: number } = {}): AgentsHostFixture {
  const view = agentsTuiFixture(options.mode ?? "fullscreen", { columns: 120, rows: 40, documentRows: options.documentRows ?? 60, dockRows: 10 });
  view.geometry.dispose();
  const theme: TestTheme = { fg: (_token, value) => value, bg: (_token, value) => value, bold: value => value, italic: value => value };
  const themeKey = Symbol.for("@earendil-works/pi-coding-agent:theme");
  const previousTheme = Object.getOwnPropertyDescriptor(globalThis, themeKey);
  Object.defineProperty(globalThis, themeKey, { value: theme, writable: true, configurable: true });
  const widgets = new Map<string, WidgetComponent>();
  const above = view.children[3] as Container;
  const completions: string[] = [], focuses: string[] = [];
  let hold: "handle" | "factory" | "reject" | "selector-handle" | undefined;
  let release: (() => void) | undefined;
  const ui: AgentsHostFixture["ui"] = {
    widgets, theme,
    notify: vi.fn(),
    setWidget: vi.fn((key: string, value: unknown) => {
      const previous = widgets.get(key);
      if (previous) { above.removeChild(previous); previous.dispose?.(); widgets.delete(key); }
      if (typeof value === "function") {
        const widget = (value as (tui: TUI, theme: unknown) => WidgetComponent)(view.tui, theme);
        widgets.set(key, widget); above.addChild(widget);
      }
      view.tui.requestRender();
    }),
    custom: vi.fn(),
  };
  const showCustom = Reflect.get(InteractiveMode.prototype, "showExtensionCustom") as
    (this: unknown, factory: CustomFactory, options?: CustomOptions) => Promise<void>;
  const interactive = { ui: view.tui, editor: view.editor, editorContainer: view.children[4], keybindings: {} };
  ui.custom.mockImplementation((factory, opts = {}) => {
    const kind = opts.overlayOptions?.width === "80%" ? "detail" : "selector";
    const deferred = kind === "selector" ? (hold === "selector-handle" ? "handle" : undefined)
      : hold === "selector-handle" ? undefined : hold;
    if (deferred) hold = undefined;
    const wrapped: CustomFactory = (tui, activeTheme, keys, done) => {
      const create = () => factory(tui, activeTheme, keys, value => { completions.push(kind); done(value); });
      if (deferred === "reject") return Promise.reject(new Error("custom factory failed"));
      if (deferred === "factory") return new Promise(resolve => { release = () => resolve(create()); });
      return create();
    };
    const originalHandle = opts.onHandle;
    const wrappedOptions: CustomOptions = { ...opts, onHandle(handle) {
      const deliver = () => originalHandle?.({ ...handle, focus: () => { focuses.push(kind); handle.focus(); } });
      if (deferred === "handle") release = deliver;
      else deliver();
    } };
    return showCustom.call(interactive, wrapped, wrappedOptions);
  });
  view.tui.setFocus(view.editor);
  const settle = async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
    view.tui.renderNow();
    for (let i = 0; i < 5; i++) await Promise.resolve();
  };
  return {
    view, ui, completions, focuses, settle,
    async send(data) { view.terminal.send(data); await settle(); },
    holdNext(kind) { hold = kind; },
    releaseHeld() { const pending = release; release = undefined; pending?.(); },
    hasHeld: () => release !== undefined,
    focused: () => (view.tui as TUI & { getFocusedComponent(): Component | null }).getFocusedComponent(),
    stack: () => (view.tui as unknown as { overlayStack: { component: Component }[] }).overlayStack.map(entry => entry.component),
    close() {
      view.dispose();
      if (previousTheme) Object.defineProperty(globalThis, themeKey, previousTheme);
      else Reflect.deleteProperty(globalThis, themeKey);
    },
  };
}

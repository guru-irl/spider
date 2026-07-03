// packages/host/src/agents/agents-ui.ts
import type { Db } from "@spider/db-core";
import { AgentStore, AgentFooter, AgentList, AgentDetail, type ThemeAdapter } from "@spider/ui";
import { createRunSource } from "./run-source";
import { piTheme } from "./theme-adapter";

interface HostUi {
  setWidget(key: string, value: unknown, opts?: { placement?: "aboveEditor" | "belowEditor" }): void;
  custom<T>(factory: (tui: unknown, theme: unknown, kb: unknown, done: (v: T) => void) => unknown, opts?: unknown): Promise<T>;
  notify(text: string, level: "info" | "error"): void;
  theme?: unknown;
}
interface HostPi {
  registerShortcut(key: string, opts: { description?: string; handler: (ctx: unknown) => void }): void;
  registerCommand?(name: string, def: { description?: string; handler: (ctx?: unknown) => void }): void;
}
interface Deps { db: Db; sessionId: string; width?: () => number }

const WIDGET = "spider-agents";

// Register the ctrl+shift+g shortcut and /agents command only ONCE per process.
let registered = false;
let current: { openOverlay: () => void | Promise<void> } | undefined;

/** Wall-clock ticker that repaints via the given `tui` while any agent runs. Returns a
 *  disposer. This is the ONLY reliable animation driver: ctx.ui has no requestRender;
 *  each widget/overlay must self-tick through the `tui` handed to its factory. */
function selfTick(tui: unknown, store: AgentStore): () => void {
  const rr = () => (tui as { requestRender?: () => void }).requestRender?.();
  const off = store.onChange(rr);
  const timer = setInterval(() => { if (store.hasRunning()) rr(); }, 100);
  (timer as unknown as { unref?: () => void }).unref?.();
  return () => { clearInterval(timer); off(); };
}

export interface OverlayComponent {
  render(w: number): string[];
  invalidate(): void;
  handleInput(data: string): void;
  dispose(): void;
}

/** Build the interactive agents overlay: a frame-less AgentList; Enter drills to an AgentDetail
 *  panel rendered ABOVE the list (which sits just above the editor). Exported for testing. */
export function buildAgentsOverlay(
  store: AgentStore, th: ThemeAdapter, tui: { requestRender?: () => void }, done: () => void,
): OverlayComponent {
  const list = new AgentList(store, th);
  let detail: AgentDetail | undefined;
  const rr = () => tui.requestRender?.();
  list.onClose(() => done());
  list.onDrill((runId) => {
    const d = new AgentDetail(store, runId, th);
    d.onBack(() => { detail = undefined; rr(); });
    detail = d; rr();
  });
  const stop = selfTick(tui, store);
  return {
    render: (w) => (detail ? [...detail.render(w), "", ...list.render(w)] : list.render(w)),
    invalidate: () => list.invalidate(),
    handleInput: (data) => { (detail ?? list).handleInput(data); rr(); },
    dispose: () => stop(),
  };
}

export function installAgentsUI(pi: HostPi, ctx: { ui: HostUi }, deps: Deps): () => void {
  const { db, sessionId } = deps;
  const store = new AgentStore(createRunSource(db, sessionId));
  store.start();

  let mounted = false;
  let selectorOpen = false;

  const syncWidget = () => {
    // While the ctrl+shift+g selector is open it REUSES the footer's position (rendered as an
    // interactive overlay), so suppress the passive footer widget to avoid a double render.
    const active = store.snapshot().length > 0 && !selectorOpen;
    if (active && !mounted) {
      ctx.ui.setWidget(WIDGET, (tui: unknown, theme: unknown) => {
        const footer = new AgentFooter(store, piTheme(theme as never));
        const stop = selfTick(tui, store);
        return {
          render: (w: number) => footer.render(w),
          invalidate: () => footer.invalidate(),
          dispose: () => stop(),
        };
      }, { placement: "aboveEditor" });
      mounted = true;
    } else if (!active && mounted) {
      ctx.ui.setWidget(WIDGET, undefined);
      mounted = false;
    }
  };

  // Mount/unmount the footer as agents come and go. Repaint-while-running is handled by
  // the footer widget's own self-tick (above), not here.
  const offChange = store.onChange(syncWidget);
  syncWidget();

  const openOverlay = async () => {
    // Reuse the footer: hide the passive footer widget and render the interactive selector
    // flush at the bottom (the same spot), with the ▸ cursor to the LEFT of the one-liners.
    selectorOpen = true;
    syncWidget();
    try {
      await ctx.ui.custom<void>(
        (tui, theme, _kb, done) => buildAgentsOverlay(store, piTheme(theme as never), tui as never, () => done()),
        { overlay: true, overlayOptions: { anchor: "bottom-left", width: "100%", maxHeight: "50%" } },
      );
    } finally {
      selectorOpen = false;
      syncWidget();
    }
  };

  current = { openOverlay };

  // ctrl+g is pi's built-in external-editor binding, so we use ctrl+shift+g. Plus a
  // rebind-safe /agents slash command fallback. Register both ONCE per process.
  if (!registered) {
    registered = true;
    pi.registerShortcut("ctrl+shift+g", {
      description: "Toggle the spider agents selector",
      handler: () => { void current?.openOverlay(); },
    });
    pi.registerCommand?.("agents", {
      description: "Open the spider agents selector",
      handler: () => { void current?.openOverlay(); },
    });
  }

  const dispose = function dispose() {
    offChange();
    store.stop();
    if (mounted) { ctx.ui.setWidget(WIDGET, undefined); mounted = false; }
    if (current?.openOverlay === openOverlay) current = undefined;
  };
  // Testability hook: expose openOverlay on the disposer (non-breaking — callers still call dispose()).
  (dispose as unknown as { openOverlay: () => void | Promise<void> }).openOverlay = openOverlay;
  return dispose;
}

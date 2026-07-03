// packages/host/src/agents/agents-ui.ts
import type { Db } from "@spider/db-core";
import { AgentStore, AgentFooter, Grid, AgentDetail } from "@spider/ui";
import { createRunSource } from "./run-source";
import { createAgentActions } from "./actions";
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

export function installAgentsUI(pi: HostPi, ctx: { ui: HostUi }, deps: Deps): () => void {
  const { db, sessionId } = deps;
  const store = new AgentStore(createRunSource(db, sessionId));
  const actions = createAgentActions(pi as never, ctx as never);
  store.start();

  let mounted = false;

  const syncWidget = () => {
    const active = store.snapshot().length > 0;
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

  // Single overlay that switches between the grid and a drilled-in detail view. Using ONE
  // overlay (instead of nesting ctx.ui.custom calls) avoids the blank/detached screen that
  // nested overlays produced on drill-in.
  const openOverlay = async () => {
    await ctx.ui.custom<void>((tui, theme, _kb, done) => {
      const th = piTheme(theme as never);
      const grid = new Grid(store, actions, th);
      let detail: AgentDetail | undefined;
      const rr = () => (tui as { requestRender?: () => void }).requestRender?.();
      grid.onClose(() => done());
      grid.setDrillHandler((runId) => {
        const d = new AgentDetail(store, runId, th);
        d.onBack(() => { detail = undefined; rr(); });
        detail = d; rr();
      });
      const stop = selfTick(tui, store);
      return {
        render: (w: number) => (detail ?? grid).render(w),
        invalidate: () => grid.invalidate(),
        handleInput: (data: string) => { (detail ?? grid).handleInput(data); rr(); },
        dispose: () => stop(),
      };
    }, { overlay: true, overlayOptions: { width: "100%", maxHeight: "100%" } });
  };

  current = { openOverlay };

  // ctrl+g is pi's built-in external-editor binding, so we use ctrl+shift+g. Plus a
  // rebind-safe /agents slash command fallback. Register both ONCE per process.
  if (!registered) {
    registered = true;
    pi.registerShortcut("ctrl+shift+g", {
      description: "Toggle spider agents grid",
      handler: () => { void current?.openOverlay(); },
    });
    pi.registerCommand?.("agents", {
      description: "Open the spider agents grid",
      handler: () => { void current?.openOverlay(); },
    });
  }

  return function dispose() {
    offChange();
    store.stop();
    if (mounted) { ctx.ui.setWidget(WIDGET, undefined); mounted = false; }
    if (current?.openOverlay === openOverlay) current = undefined;
  };
}

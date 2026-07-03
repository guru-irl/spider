// packages/host/src/agents/agents-ui.ts
import type { Db } from "@spider/db-core";
import { AgentStore, AgentFooter, Grid, AgentDetail, FrameScheduler } from "@spider/ui";
import { createRunSource } from "./run-source.js";
import { createAgentActions } from "./actions.js";
import { piTheme } from "./theme-adapter.js";

interface HostUi {
  setWidget(key: string, value: unknown, opts?: { placement?: "aboveEditor" | "belowEditor" }): void;
  custom<T>(factory: (tui: unknown, theme: unknown, kb: unknown, done: (v: T) => void) => unknown, opts?: unknown): Promise<T>;
  requestRender?(): void;
  notify(text: string, level: "info" | "error"): void;
  theme?: unknown;
}
interface HostPi {
  registerShortcut(key: string, opts: { description?: string; handler: (ctx: unknown) => void }): void;
  registerCommand?(name: string, def: { description?: string; handler: (ctx?: unknown) => void }): void;
}
interface Deps { db: Db; sessionId: string; width?: () => number }

const WIDGET = "spider-agents";

// Register the ctrl+g shortcut and /agents command only ONCE per process even if
// session_start fires again (pi.on chains; installAgentsUI may be re-invoked).
let registered = false;

export function installAgentsUI(pi: HostPi, ctx: { ui: HostUi }, deps: Deps): () => void {
  const { db, sessionId } = deps;
  const width = deps.width ?? (() => process.stdout.columns || 80);
  const store = new AgentStore(createRunSource(db, sessionId));
  const actions = createAgentActions(pi as never, ctx as never);
  store.start();

  let mounted = false;
  let footer: AgentFooter | undefined;

  const syncWidget = () => {
    const active = store.snapshot().length > 0;
    if (active && !mounted) {
      ctx.ui.setWidget(WIDGET, (_tui: unknown, theme: unknown) => {
        footer = new AgentFooter(store, piTheme(theme as never));
        return footer;
      }, { placement: "aboveEditor" });
      mounted = true;
    } else if (!active && mounted) {
      ctx.ui.setWidget(WIDGET, undefined);
      mounted = false; footer = undefined;
    }
  };

  const scheduler = new FrameScheduler(() => {
    const before = mounted;
    syncWidget();
    const changed = footer?.hasVisibleChange(width()) ?? false;
    if (changed || before !== mounted) ctx.ui.requestRender?.();
    ensureTicker();
  });

  const offChange = store.onChange(() => scheduler.request());
  syncWidget(); // initial mount if agents already active

  // Wall-clock animation ticker — only runs while an agent is running.
  let ticker: ReturnType<typeof setInterval> | null = null;
  const ensureTicker = () => {
    if (store.hasRunning() && ticker === null) {
      ticker = setInterval(() => scheduler.request(), 100);
      (ticker as unknown as { unref?: () => void }).unref?.();
    } else if (!store.hasRunning() && ticker !== null) {
      clearInterval(ticker); ticker = null;
    }
  };
  ensureTicker();

  const openGrid = async () => {
    await ctx.ui.custom<void>((tui, theme, _kb, done) => {
      const grid = new Grid(store, actions, piTheme(theme as never));
      grid.onClose(() => done());
      grid.setDrillHandler((runId) => { done(); void openDetail(runId); });
      const off = store.onChange(() => (tui as { requestRender?: () => void }).requestRender?.());
      return {
        render: (w: number) => grid.render(w),
        invalidate: () => grid.invalidate(),
        handleInput: (data: string) => { grid.handleInput(data); (tui as { requestRender?: () => void }).requestRender?.(); },
        dispose: () => off(),
      };
    }, { overlay: true });
  };

  const openDetail = async (runId: string) => {
    await ctx.ui.custom<void>((tui, theme, _kb, done) => {
      const detail = new AgentDetail(store, runId, piTheme(theme as never));
      detail.onBack(() => { done(); void openGrid(); });
      const off = store.onChange(() => (tui as { requestRender?: () => void }).requestRender?.());
      return {
        render: (w: number) => detail.render(w),
        invalidate: () => {},
        handleInput: (data: string) => { detail.handleInput(data); (tui as { requestRender?: () => void }).requestRender?.(); },
        dispose: () => off(),
      };
    }, { overlay: true });
  };

  // Ctrl+G — toggle the grid overlay. (NOTE: overrides pi's built-in external-editor Ctrl+G.)
  // Plus a rebind-safe /agents slash command fallback. Register both ONCE per process.
  if (!registered) {
    registered = true;
    pi.registerShortcut("ctrl+g", {
      description: "Toggle spider agents grid",
      handler: () => { void openGrid(); },
    });
    pi.registerCommand?.("agents", {
      description: "Open the spider agents grid",
      handler: () => { void openGrid(); },
    });
  }

  return function dispose() {
    offChange();
    scheduler.dispose();
    if (ticker !== null) { clearInterval(ticker); ticker = null; }
    store.stop();
    if (mounted) { ctx.ui.setWidget(WIDGET, undefined); mounted = false; }
  };
}

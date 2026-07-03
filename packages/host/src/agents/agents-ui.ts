// packages/host/src/agents/agents-ui.ts
import type { Db } from "@spider/db-core";
import { Key, matchesKey } from "@earendil-works/pi-tui";
import { AgentStore, AgentFooter, AgentDetail, type ThemeAdapter } from "@spider/ui";
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

// Register the ctrl+up shortcut and /agents command only ONCE per process.
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

/** The selector's key routing, decoupled from pi internals for testing. The FOOTER widget
 *  renders the visible UI (▸ cursor on the selected row + the drilled detail ABOVE the rows);
 *  this overlay is a pure key sink (renders nothing) so the footer and chat/editor never move. */
export interface SelectorController {
  moveSelect(delta: number): void;
  drill(): void;                       // Enter → open the detail for the selected run
  isDrilled(): boolean;
  closeDetail(): void;                 // Esc while drilled → back to selection
  forwardToDetail(data: string): void; // scroll etc. while drilled
  close(): void;                       // Esc / Ctrl+C → release focus back to the chat
  repaint(): void;
}

export interface OverlayComponent {
  render(w: number): string[];
  invalidate(): void;
  handleInput(data: string): void;
}

/** Pure key-sink selector. Escape and Ctrl+C ALWAYS release focus back to the chat (esc from a
 *  drilled detail first steps back to selection); arrows move the footer cursor; Enter drills. */
export function buildAgentsSelector(ctrl: SelectorController): OverlayComponent {
  return {
    render: () => [],
    invalidate() {},
    handleInput: (data: string) => {
      if (ctrl.isDrilled()) {
        if (matchesKey(data, Key.escape)) ctrl.closeDetail();
        else if (matchesKey(data, Key.ctrl("c"))) ctrl.close();
        else { ctrl.forwardToDetail(data); }
        ctrl.repaint();
        return;
      }
      if (matchesKey(data, Key.down)) ctrl.moveSelect(1);
      else if (matchesKey(data, Key.up)) ctrl.moveSelect(-1);
      else if (matchesKey(data, Key.enter)) ctrl.drill();
      else if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) { ctrl.close(); return; }
      ctrl.repaint();
    },
  };
}

export function installAgentsUI(pi: HostPi, ctx: { ui: HostUi }, deps: Deps): () => void {
  const { db, sessionId } = deps;
  const store = new AgentStore(createRunSource(db, sessionId));
  store.start();

  let mounted = false;
  // Shared drilled-detail state: the footer widget renders it ABOVE the rows; the overlay owns
  // the AgentDetail instance and forwards input to it. One instance, two readers, one TUI.
  let detail: AgentDetail | undefined;
  let footerTui: { requestRender?: (force?: boolean) => void } | undefined;
  // force:true so that when the drilled detail COLLAPSES, pi clears the freed rows (clearOnShrink)
  // and the chat flows back down with the editor staying pinned at the bottom — otherwise the
  // shrunk widget leaves the chat bar stranded in the middle of the screen.
  const repaint = () => footerTui?.requestRender?.(true);

  const syncWidget = () => {
    const active = store.snapshot().length > 0;
    if (active && !mounted) {
      ctx.ui.setWidget(WIDGET, (tui: unknown, theme: unknown) => {
        footerTui = tui as { requestRender?: (force?: boolean) => void };
        const footer = new AgentFooter(store, piTheme(theme as never));
        const stop = selfTick(tui, store);
        return {
          // Detail (when drilled) floats directly ABOVE the footer rows in this SAME static
          // aboveEditor widget, so the footer stays put and the editor just reflows below it.
          render: (w: number) => {
            const rows = footer.render(w);
            return detail ? [...detail.render(w), "", ...rows] : rows;
          },
          invalidate: () => footer.invalidate(),
          dispose: () => { stop(); footerTui = undefined; },
        };
      }, { placement: "aboveEditor" });
      mounted = true;
    } else if (!active && mounted) {
      ctx.ui.setWidget(WIDGET, undefined);
      mounted = false;
    }
  };

  const offChange = store.onChange(syncWidget);
  syncWidget();

  const openOverlay = async () => {
    // Don't open an invisible key-sink when there's nothing to select — it would silently
    // capture input (the user can't type, with no visible reason) until they hit escape.
    if (store.snapshot().length === 0) { ctx.ui.notify("No active spider agents", "info"); return; }
    store.beginSelect();
    detail = undefined;
    await ctx.ui.custom<void>(
      (tui, theme, _kb, done) => {
        const th = piTheme(theme as never);
        footerTui ??= tui as { requestRender?: (force?: boolean) => void };
        // Auto-close when the last agent finishes and disappears: an invisible overlay must
        // never keep capturing input once the footer it drives is gone.
        const offEmpty = store.onChange(() => { if (store.snapshot().length === 0) done(); });
        const ctrl: SelectorController = {
          moveSelect: (d) => store.moveSelect(d),
          drill: () => {
            const id = store.selectedRunId();
            if (!id) return;
            const d = new AgentDetail(store, id, th);
            d.onBack(() => { detail = undefined; repaint(); });
            detail = d;
          },
          isDrilled: () => detail !== undefined,
          closeDetail: () => { detail = undefined; },
          forwardToDetail: (data) => { detail?.handleInput(data); },
          close: () => done(),
          repaint,
        };
        const comp = buildAgentsSelector(ctrl);
        return {
          render: (w: number) => comp.render(w),
          invalidate: () => comp.invalidate(),
          handleInput: (data: string) => comp.handleInput(data),
          dispose: () => { offEmpty(); detail = undefined; store.endSelect(); repaint(); },
        };
      },
      // Pure key sink: renders nothing, so anchor/size are irrelevant; onHandle guarantees it
      // owns input while open. Esc / Ctrl+C in the component release it back to the chat.
      {
        overlay: true,
        overlayOptions: { anchor: "bottom-left", width: 1, maxHeight: 1 },
        onHandle: (h: { focus?: () => void }) => h.focus?.(),
      },
    );
  };

  current = { openOverlay };

  // ctrl+g is pi's built-in external-editor binding; the user prefers ctrl+up for the agents
  // selector. Plus a rebind-safe /agents slash command fallback. Register both ONCE per process.
  if (!registered) {
    registered = true;
    pi.registerShortcut("ctrl+up", {
      description: "Open the spider agents selector",
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

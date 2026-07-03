// packages/host/src/agents/agents-ui.ts
import type { Db } from "@spider/db-core";
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
  /** True while an AgentDetail panel is drilled open (used to size the floating overlay). */
  isDrilled(): boolean;
}

const isDown = (d: string): boolean => d === "\x1b[B" || d === "\x1bOB" || d === "j";
const isUp = (d: string): boolean => d === "\x1b[A" || d === "\x1bOA" || d === "k";
const isEnter = (d: string): boolean => d === "\r" || d === "\n";
const isEsc = (d: string): boolean => d === "\x1b" || d === "\x1b\x1b";

/** The ctrl+shift+g selector. The FOOTER widget stays mounted and static and renders the ▸
 *  cursor on the selected row (driven by AgentStore selection state); this overlay is a key sink
 *  floating over the chat that moves the cursor and drills into an AgentDetail on Enter — so the
 *  footer and the chat/editor never move. Exported for testing. */
export function buildAgentsSelector(
  store: AgentStore, th: ThemeAdapter, tui: { requestRender?: () => void }, done: () => void,
): OverlayComponent {
  let detail: AgentDetail | undefined;
  const rr = () => tui.requestRender?.();
  store.beginSelect();
  const stop = selfTick(tui, store);
  const openDetail = () => {
    const id = store.selectedRunId();
    if (!id) return;
    const d = new AgentDetail(store, id, th);
    d.onBack(() => { detail = undefined; rr(); });
    detail = d; rr();
  };
  return {
    // While selecting, render only a faint hint (floats over the chat, not the footer); when
    // drilled, render the detail panel. The selection cursor itself lives in the footer.
    render: (w) => (detail ? detail.render(w) : [th.fg("dim", "↑↓ select agent · enter open · esc close")]),
    invalidate: () => detail?.invalidate(),
    handleInput: (data) => {
      if (detail) { detail.handleInput(data); rr(); return; }
      if (isDown(data)) store.moveSelect(1);
      else if (isUp(data)) store.moveSelect(-1);
      else if (isEnter(data)) openDetail();
      else if (isEsc(data)) done();
      rr();
    },
    dispose: () => { stop(); store.endSelect(); },
    isDrilled: () => detail !== undefined,
  };
}

export function installAgentsUI(pi: HostPi, ctx: { ui: HostUi }, deps: Deps): () => void {
  const { db, sessionId } = deps;
  const store = new AgentStore(createRunSource(db, sessionId));
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

  const openOverlay = async () => {
    // The footer widget stays mounted and static and shows the ▸ cursor itself; this overlay is
    // a key sink floating over the chat (never over the footer/editor). It renders a 1-line hint
    // while selecting and grows to a centred panel when a detail is drilled open.
    let selector: OverlayComponent | undefined;
    await ctx.ui.custom<void>(
      (tui, theme, _kb, done) => {
        selector = buildAgentsSelector(store, piTheme(theme as never), tui as never, () => done());
        return selector;
      },
      {
        overlay: true,
        overlayOptions: () =>
          selector?.isDrilled()
            ? { anchor: "center", width: "80%", maxHeight: "70%" }
            : { anchor: "top-center", width: "60%", maxHeight: 1 },
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

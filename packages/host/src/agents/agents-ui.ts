// packages/host/src/agents/agents-ui.ts
import type { Db } from "@spider/db-core";
import { Key, matchesKey, type Component as PiComponent, type OverlayHandle, type TUI, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import { AgentStore, AgentFooter, AgentDetail, type AgentActions, type IconStyle, type RunCostFormatter } from "@spider/ui";
import { createRunSource } from "./run-source";
import { startDetailRefresh } from "./detail-refresh";
import { GEOMETRY_WAITING, installPiDockGeometry, type DockGeometryAdapter } from "./pi-dock-geometry";
import { piTheme } from "./theme-adapter";
import { SHIM_RELINK } from "../shim-version";

interface HostUi {
  setWidget(key: string, value: unknown, opts?: { placement?: "aboveEditor" | "belowEditor" }): void;
  custom<T>(factory: (tui: unknown, theme: unknown, kb: unknown, done: (v: T) => void) => unknown, opts?: unknown): Promise<T>;
  notify(text: string, level: "info" | "error"): void;
  theme?: unknown;
}
interface HostPi {
  registerShortcut?(key: string, opts: { description?: string; handler: (ctx: unknown) => void }): void;
  registerCommand?(name: string, def: { description?: string; handler: (ctx?: unknown) => void }): void;
}
interface Deps {
  db: Db;
  sessionId: string;
  width?: () => number;
  actions?: AgentActions;
  showFooter?: boolean;
  registration?: AgentsUIRegistration;
  formatRunCost?: RunCostFormatter;
  iconStyle?: IconStyle;
  piVersion?: string;
}

const WIDGET = "spider-agents";
const RETIRED_CHECK_MS = 25;
const RETIRED_RELEASE_MS = 1_000;

function killError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 120) || "Unknown error";
}

function compatibilityNotice(reason: string, piVersion?: string): string {
  if (reason === "Pi host version is unavailable") {
    return `Run detail needs a relinked spider shim: ${SHIM_RELINK}`;
  }
  if (reason.startsWith("Unsupported pi version:")) {
    return `Run detail needs pi 1.2.0 (running ${killError(piVersion)}); the list still works`;
  }
  return "Run detail can't read this pi layout; update spider";
}

export interface AgentsUIRegistration {
  open(): Promise<void>;
  activate(openOverlay: () => void | Promise<void>): () => void;
}

/** Call once per extension factory, not per module or session_start. */
export function registerAgentsUI(pi: HostPi): AgentsUIRegistration {
  let current: (() => void | Promise<void>) | undefined;
  const open = async () => {
    if (!current) throw new Error("Spider agents view is unavailable in this session.");
    await current();
  };
  pi.registerCommand?.("agents", { description: "Open the spider agents selector", handler: open });
  try {
    pi.registerShortcut?.("alt+shift+up", { description: "Open the spider agents selector", handler: open });
  } catch { /* the command remains available */ }
  return {
    open,
    activate(openOverlay) {
      current = openOverlay;
      return () => { if (current === openOverlay) current = undefined; };
    },
  };
}

function previousFocus(tui: TUI): PiComponent | null {
  const receiver = tui as TUI & { getFocusedComponent?: () => PiComponent | null };
  try { return receiver.getFocusedComponent?.() ?? null; } catch { return null; }
}

/** Observe handle removals without making a retired geometry adapter publish changes. */
function watchOverlayRemoval(tui: TUI, onRemoval: () => void): () => void {
  let notify: (() => void) | undefined = onRemoval;
  try {
    const raw = tui.valueOf() as TUI;
    const descriptor = Object.getOwnPropertyDescriptor(raw, "showOverlay");
    const original = raw.showOverlay;
    if (typeof original !== "function" || (descriptor && !descriptor.configurable)) return () => {};
    const wrapper: TUI["showOverlay"] = function(this: TUI, component, options) {
      const handle = original.call(this, component, options);
      return { ...handle, hide: () => { handle.hide(); notify?.(); } };
    };
    Object.defineProperty(raw, "showOverlay", { value: wrapper, writable: true, configurable: true, enumerable: descriptor?.enumerable ?? false });
    return () => {
      notify = undefined;
      if (Reflect.get(raw, "showOverlay") !== wrapper) return;
      if (descriptor) Object.defineProperty(raw, "showOverlay", descriptor);
      else Reflect.deleteProperty(raw, "showOverlay");
    };
  } catch { notify = undefined; return () => {}; }
}

/** One footer ticker supplies elapsed-time repaints to both the list and an open detail. */
function selfTick(tui: unknown, store: AgentStore): () => void {
  const rr = () => (tui as { requestRender?: () => void }).requestRender?.();
  const off = store.onChange(rr);
  const timer = setInterval(() => { if (store.hasRunning()) rr(); }, 100);
  (timer as unknown as { unref?: () => void }).unref?.();
  return () => { clearInterval(timer); off(); };
}

export interface SelectorController {
  moveSelect(delta: number): void;
  drill(): void;
  close(reason: "escape" | "interrupt"): void;
  repaint(): void;
}

export interface OverlayComponent {
  render(w: number): string[];
  invalidate(): void;
  handleInput(data: string): void;
}

/** The selector is a key sink; a separate overlay owns all detail input. */
export function buildAgentsSelector(ctrl: SelectorController): OverlayComponent {
  return {
    render: () => [],
    invalidate() {},
    handleInput(data) {
      if (matchesKey(data, Key.down)) ctrl.moveSelect(1);
      else if (matchesKey(data, Key.up)) ctrl.moveSelect(-1);
      else if (matchesKey(data, Key.enter)) ctrl.drill();
      else if (matchesKey(data, Key.escape)) { ctrl.close("escape"); return; }
      else if (matchesKey(data, Key.ctrl("c"))) { ctrl.close("interrupt"); return; }
      ctrl.repaint();
    },
  };
}

type Phase = "opening" | "open" | "closed";
type SelectorClose = "escape" | "interrupt" | "empty" | "shutdown";
interface Interaction {
  phase: Phase;
  component?: PiComponent;
  handle?: OverlayHandle;
  preFocus?: PiComponent | null;
  done?: () => void;
  doneCalled: boolean;
  untrack?: () => void;
}
interface SelectorInteraction extends Interaction {
  tui?: TUI;
  close?: SelectorClose;
  compat?: string;
  offEmpty?: () => void;
}
interface DetailInteraction extends Interaction {
  runId: string;
  close: boolean;
  notified: boolean;
  view?: AgentDetail;
  stopRefresh?: () => void;
}

export function installAgentsUI(pi: HostPi, ctx: { ui: HostUi }, deps: Deps): () => void {
  const source = createRunSource(deps.db, deps.sessionId);
  const store = new AgentStore(source, Date.now, deps.formatRunCost);
  store.start();

  let mounted = false;
  let disposed = false;
  let footerTui: TUI | undefined;
  let selector: SelectorInteraction | undefined;
  let detail: DetailInteraction | undefined;
  let geometry: DockGeometryAdapter | undefined;
  let offGeometry: (() => void) | undefined;
  let stopOverlayWatch: (() => void) | undefined;
  let retirementPoll: ReturnType<typeof setInterval> | undefined;
  let retirementFallback: ReturnType<typeof setTimeout> | undefined;
  let checkQueued = false;
  const repaint = () => (selector?.tui ?? footerTui)?.requestRender();

  const syncWidget = () => {
    const active = !disposed && deps.showFooter !== false && store.snapshot().length > 0;
    if (active && !mounted) {
      ctx.ui.setWidget(WIDGET, (tui: unknown, theme: unknown) => {
        const widgetTui = tui as TUI;
        footerTui = widgetTui;
        const footer = new AgentFooter(store, piTheme(theme as never, deps.iconStyle));
        const stop = selfTick(tui, store);
        return {
          render: (width: number) => footer.render(width),
          invalidate: () => footer.invalidate(),
          dispose: () => { stop(); if (footerTui === widgetTui) footerTui = undefined; },
        };
      }, { placement: "aboveEditor" });
      mounted = true;
    } else if (!active && mounted) {
      ctx.ui.setWidget(WIDGET, undefined);
      mounted = false;
    }
  };

  const releaseGeometry = (force = false) => {
    if (!force && (selector || detail)) return;
    if (retirementPoll) clearInterval(retirementPoll);
    if (retirementFallback) clearTimeout(retirementFallback);
    retirementPoll = undefined; retirementFallback = undefined;
    offGeometry?.(); offGeometry = undefined;
    stopOverlayWatch?.(); stopOverlayWatch = undefined;
    geometry?.dispose();
    if (!selector && !detail) geometry = undefined;
  };
  const notifyDetail = (state: DetailInteraction, text: string) => {
    if (state.notified) return;
    state.notified = true;
    ctx.ui.notify(text, "info");
  };
  const requestCheck = () => {
    if (checkQueued) return;
    checkQueued = true;
    queueMicrotask(() => { checkQueued = false; checkInteractions(); });
  };
  const retireGeometry = () => {
    if (!geometry) return;
    offGeometry?.(); offGeometry = undefined;
    geometry.retire();
    if (!selector && !detail) { releaseGeometry(); return; }
    if (retirementFallback) return;
    retirementPoll = setInterval(requestCheck, RETIRED_CHECK_MS);
    retirementFallback = setTimeout(() => releaseGeometry(true), RETIRED_RELEASE_MS);
    (retirementPoll as unknown as { unref?: () => void }).unref?.();
    (retirementFallback as unknown as { unref?: () => void }).unref?.();
  };
  const cleanupDetail = (state: DetailInteraction) => {
    if (state.phase === "closed") return;
    state.phase = "closed";
    state.handle = undefined;
    state.untrack?.(); state.untrack = undefined;
    state.stopRefresh?.(); state.stopRefresh = undefined;
    state.view?.dispose(); state.view = undefined;
    if (detail === state) detail = undefined;
    if (selector && !disposed && store.snapshot().length === 0 && !selector.close) selector.close = "empty";
    releaseGeometry();
    requestCheck();
  };
  const cleanupSelector = (state: SelectorInteraction) => {
    if (state.phase === "closed") return;
    state.phase = "closed";
    state.handle = undefined;
    state.offEmpty?.(); state.offEmpty = undefined;
    state.untrack?.(); state.untrack = undefined;
    if (selector === state) selector = undefined;
    store.endSelect();
    releaseGeometry();
    repaint();
  };
  const hideClosing = (state: Interaction) => {
    const handle = state.handle;
    if (!handle || handle.isHidden()) return;
    try { handle.setHidden(true); }
    catch {
      // Pi can throw while consulting a foreign visibility callback during focus restoration.
      if (handle.isFocused()) {
        try { selector?.tui?.setFocus(state.preFocus ?? null); } catch { /* host focus is unavailable */ }
      }
    }
  };
  const checkInteractions = () => {
    const currentDetail = detail;
    if (currentDetail && !currentDetail.close && geometry) {
      const reading = geometry.read();
      if (reading.kind === "unavailable" && reading.reason !== GEOMETRY_WAITING) {
        notifyDetail(currentDetail, "Agent detail unavailable: terminal geometry could not be measured");
        currentDetail.close = true;
      } else if (reading.kind === "ready" && (reading.safeHeight < 3 || reading.width < 3)) {
        notifyDetail(currentDetail, "Agent detail needs a larger terminal");
        currentDetail.close = true;
      }
    }
    if (currentDetail?.close && currentDetail.phase === "open" && !currentDetail.doneCalled &&
        currentDetail.component && currentDetail.done && geometry) {
      if (geometry.isTop(currentDetail.component)) {
        currentDetail.doneCalled = true;
        currentDetail.done();
      } else hideClosing(currentDetail);
    }
    const currentSelector = selector;
    if (currentSelector?.close && currentSelector.phase === "open" && !currentSelector.doneCalled && currentSelector.done) {
      if (currentSelector.compat) {
        if (!detail) { currentSelector.doneCalled = true; currentSelector.done(); }
      } else if (currentSelector.component && geometry) {
        if (!detail && geometry.isTop(currentSelector.component)) {
          currentSelector.doneCalled = true;
          currentSelector.done();
        } else if (!geometry.isTop(currentSelector.component)) hideClosing(currentSelector);
      }
    }
  };
  const onHandle = (state: Interaction, handle: OverlayHandle) => {
    if (state.phase !== "opening") return;
    state.handle = handle;
    state.phase = "open";
    const closing = state === detail ? detail?.close ?? true : state === selector ? !!selector?.close : true;
    if (!disposed && !closing && (state === selector && selector?.compat ||
        (state.component && geometry?.isTop(state.component)))) handle.focus();
    requestCheck();
  };
  const closeSelector = (reason: "escape" | "interrupt") => {
    if (!selector) return;
    if (selector.compat && selector.done && !selector.doneCalled) {
      selector.doneCalled = true;
      selector.done();
      return;
    }
    if (detail) {
      detail.close = true;
      if (reason === "interrupt") selector.close = "interrupt";
    } else selector.close = reason;
    requestCheck();
  };

  const openDetail = () => {
    if (disposed || !selector || detail) return;
    if (selector.compat) {
      ctx.ui.notify(compatibilityNotice(selector.compat, deps.piVersion), "info");
      return;
    }
    const runId = store.selectedRunId();
    if (!runId) return;
    const reading = geometry?.read();
    if (!reading || reading.kind !== "ready") {
      ctx.ui.notify("Agent detail unavailable: terminal geometry could not be measured", "info");
      return;
    }
    if (reading.safeHeight < 3 || reading.width < 3) {
      ctx.ui.notify("Agent detail needs a larger terminal", "info");
      return;
    }
    const state: DetailInteraction = { phase: "opening", doneCalled: false, runId, close: false, notified: false };
    detail = state;
    try {
      const pending = ctx.ui.custom<void>((tui, theme, _kb, done) => {
        state.done = () => done();
        const terminal = tui as TUI;
        state.preFocus = previousFocus(terminal);
        const view = new AgentDetail(runId, piTheme(theme as never, deps.iconStyle), {
          viewport: () => {
            const current = geometry?.read();
            return { safeHeight: current?.kind === "ready" ? current.safeHeight : 0 };
          },
          requestRender: () => terminal.requestRender(),
          formatRunCost: deps.formatRunCost,
        });
        state.view = view;
        view.onBack(target => {
          if (target === "chat" && selector) selector.close = "interrupt";
          if (target === "size") notifyDetail(state, "Agent detail needs a larger terminal");
          state.close = true;
          requestCheck();
        });
        const actions = deps.actions;
        if (actions && typeof actions.kill === "function") view.onKill(capturedId => {
          if (disposed || detail !== state || state.phase === "closed") return;
          view.setKillPending();
          const fail = (error: unknown) => {
            const message = killError(error);
            if (!disposed && !state.close && detail === state && state.phase !== "closed") view.setKillError(message);
            else {
              try { ctx.ui.notify(`Failed to stop ${capturedId}: ${message}`, "error"); }
              catch { /* a late toast is best-effort */ }
            }
          };
          try {
            void Promise.resolve(actions.kill(capturedId)).then(() => {
              if (disposed || detail !== state || state.phase === "closed") return;
              state.close = true;
              requestCheck();
            }, fail);
          } catch (error) { fail(error); }
        });
        if (disposed || state.close) view.update({ kind: "failed" });
        else {
          try {
            const stop = startDetailRefresh({ source, store, runId,
              apply: read => view.update(read), applyRun: run => view.updateRun(run),
              requestRender: () => terminal.requestRender(), formatRunCost: deps.formatRunCost });
            if (disposed || state.phase === "closed") stop();
            else state.stopRefresh = stop;
          } catch { view.update({ kind: "failed" }); }
        }
        const component: PiComponent & { dispose(): void } = {
          render: width => view.render(width),
          invalidate: () => view.invalidate(),
          handleInput: data => { if (!disposed) view.handleInput(data); },
          handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
            if (event.type !== "wheel") return undefined;
            if (!disposed) view.scrollAt(event.y, event.wheelDelta ?? 0);
            return { handled: true };
          },
          dispose: () => cleanupDetail(state),
        };
        state.component = component;
        state.untrack = geometry?.track(component);
        return component;
      }, {
        overlay: true,
        overlayOptions: { anchor: "top-center", width: "80%", minWidth: 24, maxHeight: "100%" },
        onHandle: (handle: OverlayHandle) => onHandle(state, handle),
      });
      void Promise.resolve(pending).catch(() => {
        if (!disposed) ctx.ui.notify("Agent detail could not open", "error");
      }).finally(() => { if (detail === state && state.phase !== "closed") cleanupDetail(state); });
    } catch {
      if (!disposed) ctx.ui.notify("Agent detail could not open", "error");
      cleanupDetail(state);
    }
  };

  const offChange = store.onChange(syncWidget);
  syncWidget();

  const openOverlay = async () => {
    if (disposed || selector) return;
    if (deps.showFooter === false) { ctx.ui.notify("Spider agents footer is disabled (ui.footer)", "info"); return; }
    if (store.snapshot().length === 0) { ctx.ui.notify("No active spider agents", "info"); return; }
    const state: SelectorInteraction = { phase: "opening", doneCalled: false };
    selector = state;
    store.beginSelect();
    try {
      await ctx.ui.custom<void>((tui, _theme, _kb, done) => {
        state.tui = tui as TUI;
        state.done = () => done();
        geometry = installPiDockGeometry(state.tui, deps.piVersion);
        const reading = geometry.read();
        const compat = reading.kind === "unavailable" && reading.reason !== GEOMETRY_WAITING ? reading.reason : undefined;
        state.compat = compat;
        if (compat) { geometry.dispose(); geometry = undefined; }
        else {
          state.preFocus = previousFocus(state.tui);
          offGeometry = geometry.onChange(requestCheck);
          stopOverlayWatch = watchOverlayRemoval(state.tui, () => { if (disposed) requestCheck(); });
        }
        if (!disposed) {
          state.offEmpty = store.onChange(() => {
            if (store.snapshot().length === 0) {
              if (compat && !state.doneCalled) { state.doneCalled = true; done(); }
              else if (!compat) {
                if (!state.close) state.close = "empty";
                requestCheck();
              }
            } else if (state.close === "empty") state.close = undefined;
          });
          if (store.snapshot().length === 0 && !state.close) state.close = "empty";
        }
        const ctrl: SelectorController = {
          moveSelect: delta => { if (!disposed) store.moveSelect(delta); },
          drill: openDetail,
          close: closeSelector,
          repaint,
        };
        const sink = buildAgentsSelector(ctrl);
        const component: PiComponent & { dispose(): void } = {
          render: width => sink.render(width),
          invalidate: () => sink.invalidate(),
          handleInput: data => { if (!disposed) sink.handleInput(data); },
          dispose: () => cleanupSelector(state),
        };
        state.component = component;
        if (!compat) {
          if (disposed) retireGeometry();
          else state.untrack = geometry?.track(component);
        }
        return component;
      }, {
        overlay: true,
        overlayOptions: { anchor: "bottom-left", width: 1, maxHeight: 1 },
        onHandle: (handle: OverlayHandle) => onHandle(state, handle),
      });
    } catch {
      if (!disposed) ctx.ui.notify("Spider agents unavailable: terminal geometry could not be measured", "info");
    } finally {
      if (selector === state && state.phase !== "closed") cleanupSelector(state);
    }
  };

  const registration = deps.registration ?? registerAgentsUI(pi);
  const deactivate = registration.activate(openOverlay);
  const dispose = function dispose() {
    if (disposed) return;
    disposed = true;
    deactivate(); offChange(); store.stop();
    selector?.offEmpty?.();
    if (selector) selector.offEmpty = undefined;
    if (mounted) { ctx.ui.setWidget(WIDGET, undefined); mounted = false; }
    if (detail) {
      detail.stopRefresh?.(); detail.stopRefresh = undefined;
      detail.view?.dispose(); detail.view = undefined;
      detail.close = true;
    }
    if (selector) selector.close = "shutdown";
    retireGeometry();
    requestCheck();
    releaseGeometry();
  };
  (dispose as unknown as { openOverlay: () => void | Promise<void> }).openOverlay = openOverlay;
  return dispose;
}

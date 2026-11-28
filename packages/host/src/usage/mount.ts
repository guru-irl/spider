import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { paths } from "@spider/db-core";
import { watchFile, unwatchFile } from "node:fs";
import { controlConfig } from "../control.js";
import { makeConfigReloader } from "../config-reload.js";
import { readUsageConfig } from "./config.js";
import { billingPeriod, computePace } from "./billing-pace.js";
import { calibrationFallback } from "./calibration.js";
import { usageDoctorLines, dashboardAssetsStatus } from "./doctor.js";
import { readUsageServerCrashDiagnostics } from "./server-runtime.js";
import { homedir } from "node:os";
import { isAbsolute, relative, sep, join } from "node:path";
import type { UsageConfig } from "./config.js";
import { FooterAccumulator } from "./footer-state.js";
import { createUsageFooter, inHerdrPane, type FooterInput } from "./footer.js";
import { UsageRuntime } from "./runtime.js";
import type { UsageRoots } from "./discovery.js";

/** Pi and the detached dashboard must consume the same ledger and discovery roots. */
export function resolveUsageRoots(): UsageRoots {
  const agentDir = getAgentDir();
  return {
    registryDb: join(paths.globalRoot, "spider.db"), ledgerFile: join(paths.globalRoot, "usage.db"),
    sessionsDir: join(agentDir, "sessions"), authPath: join(agentDir, "auth.json"), leaseDir: join(paths.globalRoot, "usage-leases"),
  };
}

function displayCwd(cwd: string): string {
  const tail = relative(homedir(), cwd);
  return tail === "" ? "~" : !isAbsolute(tail) && tail !== ".." && !tail.startsWith(`..${sep}`) ? `~${sep}${tail}` : cwd;
}

/** Async callbacks must never crash pi, including when notification delivery fails. */
function guarded(callback: () => void, source: string, warn: (message: string) => void): () => void {
  let logged = false;
  return () => {
    try { callback(); }
    catch {
      if (logged) return;
      logged = true;
      try { warn(`[spider usage] ${source} failed; will retry`); } catch { /* best effort */ }
    }
  };
}

/** Owns only the terminal footer, never the independent spider agents widget. */
export function mountUsage(pi: ExtensionAPI, ctx: ExtensionContext, runtime: UsageRuntime, config: UsageConfig, admitted: () => boolean = () => true): { refresh(): void; configure(config: UsageConfig): void; dispose(): void } {
  let current = ctx;
  let settings = config;
  let disposed = false;
  let footerOwnership: "unclaimed" | "owned" | "replaced" = "unclaimed";
  let workingSince: number | undefined;
  let file: string | undefined, sessionId: string | undefined;
  let count = 0, cursor: string | undefined;
  let component: ReturnType<typeof createUsageFooter> | undefined;
  let tick: ReturnType<typeof setInterval> | undefined;
  const subscriptions: (() => void)[] = [];
  const totals = new FooterAccumulator();
  let input: FooterInput;
  // Appearance is read once per folder and session, not on refresh ticks.
  let appearance: { cwd: string; inPane: boolean; iconStyle: NonNullable<FooterInput["iconStyle"]> } | undefined;
  const child = process.env.PI_SUBAGENT_CHILD === "1";
  const eligible = () => admitted() && !child && current.mode === "tui";

  function disposeComponent(): void {
    const previous = component;
    component = undefined;
    previous?.dispose();
  }
  function releaseFooter(): void {
    disposeComponent();
    if (footerOwnership === "owned") {
      footerOwnership = "unclaimed";
      current.ui.setFooter(undefined);
      current.ui.setWorkingVisible?.(true);
    }
  }
  function refresh(reset = false): void {
    if (disposed || !eligible() || !settings.footer) return;
    const manager = current.sessionManager;
    const nextFile = manager.getSessionFile(), nextId = manager.getSessionId();
    const replaced = file !== nextFile || sessionId !== nextId;
    if (replaced && (file !== undefined || sessionId !== undefined)) {
      workingSince = undefined;
      releaseFooter();
      footerOwnership = "unclaimed";
    }
    if (footerOwnership === "replaced") return;
    // pi 0.87.x sums ALL getEntries(), including abandoned branches and summaries.
    // Tree navigation intentionally re-reduces that same list, not getBranch().
    const entries = manager.getEntries();
    if (reset || replaced || entries.length < count || (count > 0 && entries[count - 1]?.id !== cursor)) totals.reset(entries);
    else totals.append(entries.slice(count));
    count = entries.length; cursor = entries[count - 1]?.id;
    file = nextFile; sessionId = nextId;
    const model = current.model;
    const subscription = !!model && (model.provider === "kimi-coding" ||
      (current.modelRegistry.isUsingOAuth(model) && current.modelRegistry.getProvider(model.provider)?.auth?.oauth?.isSubscription === true));
    const runtimeSnapshot = runtime.snapshot();
    const snapshot = runtimeSnapshot.counter;
    const now = Date.now(), period = billingPeriod(now, snapshot?.latest ?? undefined);
    const sameMonth = runtimeSnapshot.monthPeriod?.start === period.start && runtimeSnapshot.monthPeriod.end === period.end;
    const pace = computePace({ now, snapshots: snapshot?.latest ? [snapshot.latest] : [], budget: settings.monthlyBudget,
      correctedMonth: sameMonth ? runtimeSnapshot.monthUsed ?? null : null, correctedWindow: null });
    if (appearance?.cwd !== current.cwd) appearance = {
      cwd: current.cwd,
      inPane: Boolean(process.env.HC_TERMINAL_ID) && inHerdrPane(process.env, controlConfig("get", current.cwd, "herdr.enabled")),
      iconStyle: controlConfig("get", current.cwd, "ui.icons") === "nerd" ? "nerd" : "text",
    };
    input = {
      iconStyle: appearance.iconStyle,
      cwd: displayCwd(current.cwd), branch: null, statuses: new Map(), sessionName: pi.getSessionName() ?? null, inPane: appearance.inPane,
      modelId: model?.id ?? null, modelName: model?.name?.trim() || null, thinking: model?.reasoning ? (pi.getThinkingLevel?.() ?? current.thinkingLevel ?? "off") : "off",
      context: current.getContextUsage() ?? { percent: 0, contextWindow: model?.contextWindow ?? 0 },
      subscription, totals: totals.snapshot(), monthlyBudget: settings.monthlyBudget, monthUsed: pace.used,
      calibration: settings.calibration === "off" ? calibrationFallback("off") : runtimeSnapshot.calibration ?? calibrationFallback(),
      counter: { availability: snapshot?.availability === "available" ? "available" : snapshot?.availability === "disabled" ? "disabled" : "unavailable", snapshot: snapshot?.latest ?? null },
    };
    if (footerOwnership === "unclaimed") {
      if (workingSince === undefined && current.isIdle?.() === false) workingSince = now;
      footerOwnership = "owned";
      current.ui.setFooter((tui, theme, footerData) => {
        disposeComponent();
        const footer = createUsageFooter(() => input, theme, footerData, () => tui.requestRender(), () => {
          if (component !== footer) return; // Spider already detached it on its own release path.
          component = undefined;
          footerOwnership = "replaced";
          current.ui.setWorkingVisible?.(true);
        });
        component = footer;
        footer.setWorking(workingSince);
        return footer;
      });
      current.ui.setWorkingVisible?.(false);
    }
    component?.refresh();
  }
  const tickRefresh = guarded(() => refresh(), "footer tick", message => current.ui?.notify?.(message, "warning"));
  function configure(next: UsageConfig): void {
    if (disposed || child) return;
    const changed = settings.footer !== next.footer;
    settings = next;
    runtime.configure(next.counterPoll, next.calibration);
    if (!eligible() || !next.footer) {
      releaseFooter(); if (tick) clearInterval(tick); tick = undefined;
    } else {
      refresh(changed);
      if (!tick) { tick = setInterval(tickRefresh, 1000); tick.unref?.(); }
    }
  }
  function dispose(): void {
    if (disposed) return;
    disposed = true;
    if (tick) clearInterval(tick); tick = undefined;
    for (const unsubscribe of subscriptions.splice(0)) unsubscribe();
    releaseFooter();
  }
  if (!child && current.mode === "tui") {
    const update = (_event: unknown, next: ExtensionContext) => { current = next; refresh(); };
    subscriptions.push(pi.on("agent_start", () => {
      workingSince ??= Date.now();
      component?.setWorking(workingSince);
    }), pi.on("agent_end", () => {
      workingSince = undefined;
      component?.setWorking();
    }), pi.on("message_end", update), pi.on("turn_end", update), pi.on("agent_settled", update),
      pi.on("session_compact", update), pi.on("session_info_changed", update), pi.on("model_select", update), pi.on("thinking_level_select", update),
      pi.on("session_tree", (_event, next) => { current = next; refresh(true); }),
      pi.on("session_start", (_event, next) => {
        // Same-instance hosts can replace contexts without a shutdown. Release the old UI first.
        workingSince = undefined; appearance = undefined;
        releaseFooter(); footerOwnership = "unclaimed"; current = next; refresh(true);
      }), pi.on("session_shutdown", dispose));
    configure(config);
  }
  return { refresh, configure, dispose };
}

/** Registration is inert. The parent session lifecycle owns the worker and config watcher. */
export function registerUsage(pi: ExtensionAPI, bundleUrl: string | URL, admitted: () => boolean = () => true): { reload(): void; pause(): Promise<void>; resume(): Promise<void>; snapshot(): ReturnType<UsageRuntime["snapshot"]> | undefined; readPanel(now: number, sessionId: string, budget?: number): ReturnType<UsageRuntime['readPanel']>; doctor(): Promise<ReturnType<typeof usageDoctorLines>> } {
  let current: ExtensionContext | undefined;
  let runtime: UsageRuntime | undefined;
  let mounted: ReturnType<typeof mountUsage> | undefined;
  let config = readUsageConfig({}, {}).value;
  let reloader: ReturnType<typeof makeConfigReloader> | undefined;
  let watchedFile: string | undefined;
  let paused = false, resumeNeeded = false;
  let pausing: Promise<void> | undefined, resuming: Promise<void> | undefined;
  const reload = guarded(() => reloader?.reload(), "config reload", message => current?.ui?.notify?.(message, "warning"));
  async function stop(strict = false): Promise<void> {
    if (watchedFile) unwatchFile(watchedFile, reload);
    watchedFile = undefined; reloader = undefined;
    mounted?.dispose(); mounted = undefined;
    const previous = runtime; runtime = undefined;
    if (strict) await previous?.quiesce(); else await previous?.stop();
  }
  function start(ctx: ExtensionContext): void {
    config = readUsageConfig(controlConfig("get", ctx.cwd) as Record<string, unknown>, {}).value;
    runtime = new UsageRuntime({ bundleUrl, child: false, admitted, sessionId: ctx.sessionManager?.getSessionId?.() ?? null, roots: resolveUsageRoots(), onSnapshot: () => { if (admitted()) mounted?.refresh(); } });
    runtime.start(config.counterPoll, config.calibration);
    mounted = mountUsage(pi, ctx, runtime, config, admitted);
    reloader = makeConfigReloader(ctx.cwd, merged => {
      if (!admitted()) return;
      config = readUsageConfig(merged as Record<string, unknown>, {}).value;
      if (ctx.mode === "tui") mounted?.configure(config);
      else runtime?.configure(config.counterPoll, config.calibration);
    });
    watchedFile = join(paths.globalRoot, "config.json");
    // Config I/O is separate from rendering. This also catches edits in another parent.
    watchFile(watchedFile, { persistent: false, interval: 1000 }, reload);
  }
  pi.on("session_start", async (_event, ctx) => {
    if (process.env.PI_SUBAGENT_CHILD === "1") return;
    await stop();
    current = ctx;
    if (!paused && admitted()) start(ctx);
  });
  pi.on("session_shutdown", async () => { current = undefined; resumeNeeded = false; await stop(); });
  const pause = (): Promise<void> => {
    if (pausing) return pausing;
    paused = true; resumeNeeded = Boolean(runtime);
    return pausing = stop(true);
  };
  const resume = (): Promise<void> => {
    if (resuming) return resuming;
    if (!paused) return Promise.resolve();
    const task = (async () => {
      await pausing;
      if (!admitted()) throw new Error("Session ownership is not available");
      try { if (resumeNeeded && current) start(current); }
      catch (error) { await stop(); throw error; }
      paused = false; resumeNeeded = false; pausing = undefined;
    })();
    resuming = task.finally(() => { resuming = undefined; });
    return resuming;
  };
  return { reload, pause, resume, snapshot: () => runtime?.snapshot(), readPanel: (now, sessionId, budget) => runtime?.readPanel(now, sessionId, budget) ?? Promise.resolve(null), doctor: async () => {
    if (process.env.PI_SUBAGENT_CHILD === "1") return { ok: true, lines: ["- usage worker: not started (child session)"] };
    const crashes = await Promise.all(["usage-server", "usage-server-failures"].map(dir => readUsageServerCrashDiagnostics(join(paths.globalRoot, dir))));
    const snapshot = runtime?.snapshot() ?? { health: null, counter: null, backfill: "pending" as const, reconciliation: null, errorCode: null };
    return usageDoctorLines(snapshot, config, { sourceErrors: snapshot.sourceErrorDiagnostics?.rows ?? [],
      truncated: snapshot.sourceErrorDiagnostics?.truncated ?? false, serverFailures: crashes.flatMap(crash => crash?.failures ?? []), now: Date.now(),
      dashboardAssets: await dashboardAssetsStatus(bundleUrl) });
  } };
}

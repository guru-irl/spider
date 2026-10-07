import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { paths } from "@spider/db-core";
import { watchFile, unwatchFile } from "node:fs";
import { controlConfig } from "../control.js";
import { makeConfigReloader } from "../config-reload.js";
import { readUsageConfig } from "./config.js";
import { calibrationFallback } from "./calibration.js";
import { usageDoctorLines } from "./doctor.js";
import { readUsageServerCrashDiagnostics } from "./server-runtime.js";
import { homedir } from "node:os";
import { isAbsolute, relative, sep, join } from "node:path";
import type { UsageConfig } from "./config.js";
import { FooterAccumulator } from "./footer-state.js";
import { createUsageFooter, type FooterInput } from "./footer.js";
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
export function mountUsage(pi: ExtensionAPI, ctx: ExtensionContext, runtime: UsageRuntime, config: UsageConfig): { refresh(): void; configure(config: UsageConfig): void; dispose(): void } {
  let current = ctx;
  let settings = config;
  let disposed = false, ownsFooter = false;
  let file: string | undefined, sessionId: string | undefined;
  let count = 0, cursor: string | undefined;
  let component: ReturnType<typeof createUsageFooter> | undefined;
  let tick: ReturnType<typeof setInterval> | undefined;
  const subscriptions: (() => void)[] = [];
  const totals = new FooterAccumulator();
  let input: FooterInput;
  const child = process.env.PI_SUBAGENT_CHILD === "1";
  const eligible = () => !child && current.mode === "tui";

  function releaseFooter(): void {
    component?.dispose(); component = undefined;
    if (ownsFooter) { ownsFooter = false; current.ui.setFooter(undefined); }
  }
  function refresh(reset = false): void {
    if (disposed || !eligible() || !settings.footer) return;
    const manager = current.sessionManager;
    const nextFile = manager.getSessionFile(), nextId = manager.getSessionId();
    const replaced = file !== nextFile || sessionId !== nextId;
    if (replaced && ownsFooter) releaseFooter();
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
    input = {
      cwd: displayCwd(current.cwd), branch: null, statuses: new Map(), sessionName: pi.getSessionName() ?? null,
      modelId: model?.id ?? null, thinking: model?.reasoning ? (pi.getThinkingLevel?.() ?? current.thinkingLevel ?? "off") : "off",
      context: current.getContextUsage() ?? { percent: 0, contextWindow: model?.contextWindow ?? 0 },
      subscription, totals: totals.snapshot(),
      calibration: settings.calibration === "off" ? calibrationFallback("off") : runtimeSnapshot.calibration ?? calibrationFallback(),
      counter: { availability: snapshot?.availability === "available" ? "available" : snapshot?.availability === "disabled" ? "disabled" : "unavailable", snapshot: snapshot?.latest ?? null },
    };
    if (!ownsFooter) {
      ownsFooter = true;
      current.ui.setFooter((tui, theme, footerData) => {
        component?.dispose();
        component = createUsageFooter(() => input, theme, footerData, () => tui.requestRender());
        return component;
      });
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
    subscriptions.push(pi.on("message_end", update), pi.on("turn_end", update), pi.on("agent_settled", update),
      pi.on("session_compact", update), pi.on("session_info_changed", update), pi.on("model_select", update), pi.on("thinking_level_select", update),
      pi.on("session_tree", (_event, next) => { current = next; refresh(true); }),
      pi.on("session_start", (_event, next) => {
        // Same-instance hosts can replace contexts without a shutdown. Release the old UI first.
        releaseFooter(); current = next; refresh(true);
      }), pi.on("session_shutdown", dispose));
    configure(config);
  }
  return { refresh, configure, dispose };
}

/** Registration is inert. The parent session lifecycle owns the worker and config watcher. */
export function registerUsage(pi: ExtensionAPI, bundleUrl: string | URL): { reload(): void; doctor(): Promise<ReturnType<typeof usageDoctorLines>> } {
  let current: ExtensionContext | undefined;
  let runtime: UsageRuntime | undefined;
  let mounted: ReturnType<typeof mountUsage> | undefined;
  let config = readUsageConfig({}, {}).value;
  let reloader: ReturnType<typeof makeConfigReloader> | undefined;
  let watchedFile: string | undefined;
  const reload = guarded(() => reloader?.reload(), "config reload", message => current?.ui?.notify?.(message, "warning"));
  async function stop(): Promise<void> {
    if (watchedFile) unwatchFile(watchedFile, reload);
    watchedFile = undefined; reloader = undefined;
    mounted?.dispose(); mounted = undefined;
    const previous = runtime; runtime = undefined;
    await previous?.stop();
  }
  pi.on("session_start", async (_event, ctx) => {
    if (process.env.PI_SUBAGENT_CHILD === "1") return;
    await stop();
    current = ctx;
    config = readUsageConfig(controlConfig("get", ctx.cwd) as Record<string, unknown>, {}).value;
    runtime = new UsageRuntime({ bundleUrl, child: false, roots: resolveUsageRoots(), onSnapshot: () => mounted?.refresh() });
    runtime.start(config.counterPoll, config.calibration);
    mounted = mountUsage(pi, ctx, runtime, config);
    reloader = makeConfigReloader(ctx.cwd, merged => {
      config = readUsageConfig(merged as Record<string, unknown>, {}).value;
      if (ctx.mode === "tui") mounted?.configure(config);
      else runtime?.configure(config.counterPoll, config.calibration);
    });
    watchedFile = join(paths.globalRoot, "config.json");
    // Config I/O is separate from rendering. This also catches edits in another parent.
    watchFile(watchedFile, { persistent: false, interval: 1000 }, reload);
  });
  pi.on("session_shutdown", stop);
  return { reload, doctor: async () => {
    if (process.env.PI_SUBAGENT_CHILD === "1") return { ok: true, lines: ["- usage worker: not started (child session)"] };
    const crashes = await Promise.all(["usage-server", "usage-server-failures"].map(dir => readUsageServerCrashDiagnostics(join(paths.globalRoot, dir))));
    const snapshot = runtime?.snapshot() ?? { health: null, counter: null, backfill: "pending" as const, reconciliation: null, errorCode: null };
    return usageDoctorLines(snapshot, config, { sourceErrors: snapshot.sourceErrorDiagnostics?.rows ?? [],
      truncated: snapshot.sourceErrorDiagnostics?.truncated ?? false, serverFailures: crashes.flatMap(crash => crash?.failures ?? []), now: Date.now() });
  } };
}

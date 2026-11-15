import { closeSync, openSync, readSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { parseBuildId, type BuildIdentity } from "../../../scripts/build-id.mjs";
import type { LoadedBundle } from "./build-id.js";

export const AUTO_RELOAD_ARG = "--spider-auto=";

function buildKey(identity: Readonly<BuildIdentity>): string {
  return `${identity.sha}${identity.dirty ? "-dirty" : ""}@${identity.builtAt} v${identity.version}`;
}

function readBuild(url: string): BuildIdentity | null {
  const fd = openSync(new URL(url), "r");
  try {
    const line = Buffer.alloc(4096);
    let used = 0;
    while (used < line.length && readSync(fd, line, used, 1, null) === 1) {
      if (line[used++] === 10) break;
    }
    if (used === line.length && line[used - 1] !== 10) return null;
    return parseBuildId(line.toString("utf8", 0, used));
  } finally {
    closeSync(fd);
  }
}

function readReadyBuild(url: string): BuildIdentity | null {
  const first = readBuild(url);
  if (!first) return null;
  const stampUrl = new URL(url);
  stampUrl.search = "";
  stampUrl.hash = "";
  stampUrl.pathname += ".ready";
  const stamp = readBuild(stampUrl.href);
  const current = readBuild(url);
  return stamp && current && buildKey(first) === buildKey(stamp) && buildKey(first) === buildKey(current) ? current : null;
}

export function registerAutoReload(
  pi: ExtensionAPI,
  bundle: LoadedBundle,
  enabled: (cwd: string) => boolean,
  admitted: () => boolean,
  wouldInterrupt: (sessionId: string) => boolean,
  busy: () => boolean = () => false,
): { isAutomaticReload: () => boolean } {
  let automaticReload = false;
  const activation = { isAutomaticReload: () => automaticReload };
  if (process.env.PI_SUBAGENT_CHILD === "1") return activation;
  // Rebuilt bundles have separate module instances, but the process survives reload.
  // Keep attempts in a versioned process-wide slot so an old build cannot loop.
  const key = Symbol.for("spider.auto-reload.v1");
  const global = globalThis as Record<symbol, unknown>;
  const shared = (global[key] ??= { attempted: new Set<string>() }) as {
    attempted: Set<string>;
    notice?: { key: string; identity: BuildIdentity };
    active?: { stop: () => void };
  };
  let timer: ReturnType<typeof setInterval> | undefined;
  let stopInput: (() => void) | undefined;
  let previous: string | undefined;
  let pending: { key: string; identity: BuildIdentity; token: string } | undefined;
  let promptDepth = 0;
  const pendingBash: Array<{ command: string; excluded: boolean; previous: Set<string> | null }> = [];
  const consumedBashResults = new Set<string>();
  let lastActivity = Date.now();
  const activity = () => { lastActivity = Date.now(); };
  const eligible = (ctx: ExtensionContext) =>
    ctx.mode === "tui" && ctx.hasUI && process.env.PI_SUBAGENT_CHILD !== "1";
  const bashRunning = (ctx: ExtensionContext): boolean => {
    if (!pendingBash.length) return false;
    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type !== "message" || entry.message.role !== "bashExecution" || consumedBashResults.has(entry.id)) continue;
      const message = entry.message;
      const index = pendingBash.findIndex(item => item.previous !== null && !item.previous.has(entry.id) &&
        item.command === message.command && item.excluded === !!message.excludeFromContext);
      if (index >= 0) { pendingBash.splice(index, 1); consumedBashResults.add(entry.id); }
    }
    return pendingBash.length > 0;
  };
  const ready = (ctx: ExtensionContext, requireQuiet = true) => {
    try {
      // Pi's isIdle() is false while streaming or compacting.
      return eligible(ctx) && ctx.isIdle() && !ctx.hasPendingMessages() && promptDepth === 0 && !bashRunning(ctx) &&
        !ctx.ui.getEditorText().trim() && (!requireQuiet || Date.now() - lastActivity >= 20_000) &&
        admitted() && enabled(ctx.cwd) && !busy() && !wouldInterrupt(ctx.sessionManager.getSessionId());
    } catch { return false; }
  };
  const stop = () => {
    clearInterval(timer); timer = undefined;
    stopInput?.(); stopInput = undefined;
    previous = undefined;
    pending = undefined;
    promptDepth = 0;
    pendingBash.length = 0;
    consumedBashResults.clear();
    if (shared.active === owner) shared.active = undefined;
  };
  const owner = { stop };
  pi.registerCommand("spider-reload", {
    description: "Reload spider when the session is idle",
    handler: async (args, ctx) => {
      const internal = args.trim().startsWith(AUTO_RELOAD_ARG);
      const target = internal ? pending : undefined;
      // A manual command must not consume a queued automatic attempt. Stale
      // internal messages are never treated as manual reloads.
      if (internal && (!target || args.trim() !== `${AUTO_RELOAD_ARG}${target.token}`)) return;
      if (internal) pending = undefined;
      if (!ready(ctx, !!target)) {
        if (!target && ctx.hasUI) ctx.ui.notify("Wait for the session to become idle before reloading.", "info");
        return;
      }
      if (target) {
        try {
          const installed = readReadyBuild(bundle.url);
          if (!installed || buildKey(installed) !== target.key) { previous = undefined; return; }
        } catch { previous = undefined; return; }
        if (shared.attempted.has(target.key)) return;
        shared.attempted.add(target.key);
        shared.notice = target;
      }
      try {
        automaticReload = !!target;
        await ctx.reload();
      } finally {
        automaticReload = false;
        // Reload invalidates ctx; only the process-wide marker is safe to touch here.
        if (target && shared.notice === target) shared.notice = undefined;
      }
    },
  });
  // Pi reports extension prompts, but not built-in selectors such as /model or /tree.
  pi.on("ui_prompt_start", () => { promptDepth++; });
  pi.on("ui_prompt_end", () => { promptDepth = Math.max(0, promptDepth - 1); });
  pi.on("user_bash", (event, ctx) => {
    let previous: Set<string> | null = null;
    try { previous = new Set(ctx.sessionManager.getEntries().map(entry => entry.id)); } catch { /* Fail closed if history is unavailable. */ }
    // Pi emits no completion event. A launch error with no result leaves reload blocked.
    pendingBash.push({ command: event.command, excluded: event.excludeFromContext, previous });
  });
  pi.on("turn_end", activity);
  pi.on("agent_start", activity);
  pi.on("agent_end", activity);
  pi.on("input", activity);
  pi.on("message_end", activity);
  pi.on("session_before_compact", activity);
  pi.on("session_compact", activity);
  pi.on("session_compact_failed", activity);
  pi.on("session_start", (event, ctx) => {
    stop();
    shared.active?.stop();
    activity();
    if (event.reason === "reload" && shared.notice) {
      const notice = shared.notice;
      shared.notice = undefined;
      if (eligible(ctx) && buildKey(bundle.identity) === notice.key) {
        ctx.ui.notify(`Spider updated to ${notice.identity.sha.slice(0, 7)}.`, "info");
      }
    }
    // A direct or old-shim import cannot replace its cached module on reload.
    if (!eligible(ctx) || !new URL(bundle.url).searchParams.get("build")) return;
    shared.active = owner;
    stopInput = ctx.ui.onTerminalInput?.(() => { activity(); return undefined; });
    timer = setInterval(() => {
      try {
        if (!admitted() || !enabled(ctx.cwd)) { previous = undefined; return; }
        const installed = readReadyBuild(bundle.url);
        if (!installed || buildKey(installed) === buildKey(bundle.identity)) { previous = undefined; return; }
        const key = buildKey(installed);
        const confirmed = key === previous;
        previous = key;
        if (confirmed && !shared.attempted.has(key) && !pending && ready(ctx)) {
          pending = { key, identity: installed, token: randomUUID() };
          try { pi.sendUserMessage(`/spider-reload ${AUTO_RELOAD_ARG}${pending.token}`, { expandPromptTemplates: true }); }
          catch { pending = undefined; }
        }
      } catch { previous = undefined; }
    }, 30_000).unref();
  });
  pi.on("session_shutdown", stop);
  return activation;
}

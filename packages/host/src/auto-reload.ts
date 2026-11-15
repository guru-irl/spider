import { closeSync, openSync, readSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { parseBuildId, type BuildIdentity } from "../../../scripts/build-id.mjs";
import type { LoadedBundle } from "./build-id.js";

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

export function registerAutoReload(
  pi: ExtensionAPI,
  bundle: LoadedBundle,
  enabled: (cwd: string) => boolean,
  admitted: () => boolean,
  wouldInterrupt: (sessionId: string) => boolean,
): void {
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
  let pending: { key: string; identity: BuildIdentity } | undefined;
  let lastActivity = Date.now();
  const activity = () => { lastActivity = Date.now(); };
  const eligible = (ctx: ExtensionContext) =>
    ctx.mode === "tui" && ctx.hasUI && process.env.PI_SUBAGENT_CHILD !== "1";
  const ready = (ctx: ExtensionContext) => {
    try {
      // Pi's isIdle() is false while streaming or compacting.
      return eligible(ctx) && ctx.isIdle() && !ctx.hasPendingMessages() &&
        !ctx.ui.getEditorText().trim() && Date.now() - lastActivity >= 20_000 &&
        admitted() && enabled(ctx.cwd) && !wouldInterrupt(ctx.sessionManager.getSessionId());
    } catch { return false; }
  };
  const stop = () => {
    clearInterval(timer); timer = undefined;
    stopInput?.(); stopInput = undefined;
    previous = undefined;
    pending = undefined;
    if (shared.active === owner) shared.active = undefined;
  };
  const owner = { stop };
  pi.registerCommand("spider-reload", {
    description: "Reload spider when the session is idle",
    handler: async (_args, ctx) => {
      const target = pending;
      pending = undefined;
      if (!ready(ctx)) {
        if (!target && ctx.hasUI) ctx.ui.notify("Wait for the session to become idle before reloading.", "info");
        return;
      }
      if (target) {
        try {
          const installed = readBuild(bundle.url);
          if (!installed || buildKey(installed) !== target.key) { previous = undefined; return; }
        } catch { previous = undefined; return; }
        if (shared.attempted.has(target.key)) return;
        shared.attempted.add(target.key);
        shared.notice = target;
      }
      try {
        await ctx.reload();
      } finally {
        // Reload invalidates ctx; only the process-wide marker is safe to touch here.
        if (target && shared.notice === target) shared.notice = undefined;
      }
    },
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
    if (!eligible(ctx)) return;
    shared.active = owner;
    stopInput = ctx.ui.onTerminalInput?.(() => { activity(); return undefined; });
    timer = setInterval(() => {
      try {
        if (!admitted() || !enabled(ctx.cwd)) { previous = undefined; return; }
        const installed = readBuild(bundle.url);
        if (!installed || buildKey(installed) === buildKey(bundle.identity)) { previous = undefined; return; }
        const key = buildKey(installed);
        const confirmed = key === previous;
        previous = key;
        if (confirmed && !shared.attempted.has(key) && !pending && ready(ctx)) {
          pending = { key, identity: installed };
          try { pi.sendUserMessage("/spider-reload", { expandPromptTemplates: true }); }
          catch { pending = undefined; }
        }
      } catch { previous = undefined; }
    }, 30_000).unref();
  });
  pi.on("session_shutdown", stop);
}

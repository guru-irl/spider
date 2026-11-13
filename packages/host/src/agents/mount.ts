// packages/host/src/agents/mount.ts
// Production mount seam — wires actions + installAgentsUI. This function exists
// so tests can verify the complete production wiring (that actions are passed).
import type { Db } from "@spider/db-core";
import { installAgentsUI, type AgentsUIRegistration } from "./agents-ui";
import { createAgentActions } from "./actions";
import { controlConfig } from "../control.js";

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

export interface MountOpts {
  db: Db;
  sessionId: string;
  cwd: string;
  registration?: AgentsUIRegistration;
  formatRunCost?: import("@spider/ui").RunCostFormatter;
  admitted?: () => boolean;
  // Injectable for tests — defaults to real dispatch that calls into spider action handler
  dispatch?: (action: string, args: Record<string, unknown>) => Promise<unknown>;
}

/**
 * Mount the live agents UI with full production wiring (actions + dispatch).
 * Extension.ts calls this on session_start; tests inject dispatch to verify wiring.
 */
export function mountAgentsUI(
  pi: HostPi,
  ctx: { ui: HostUi },
  opts: MountOpts,
): () => void {
  if (opts.admitted?.() === false) return () => {};
  const { db, sessionId } = opts;
  const dispatch = opts.dispatch && (async (action: string, args: Record<string, unknown>) => {
    if (opts.admitted?.() === false) throw new Error("Session ownership is not available; run /spider roam doctor.");
    return opts.dispatch!(action, args);
  });

  return installAgentsUI(pi, ctx, {
    db,
    sessionId,
    showFooter: controlConfig("get", opts.cwd, "ui.footer") !== false,
    registration: opts.registration,
    formatRunCost: opts.formatRunCost,
    actions: createAgentActions(pi, {
      ui: ctx.ui,
      dispatch,
    }),
  });
}

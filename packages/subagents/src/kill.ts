import type { Db } from "@spider/db-core";
import { RunStore, type RunRow } from "./run-store";
import { killProcessGroup, isProcessAlive, type KillOpts } from "./kill-process";
import { getChild, unregisterChild } from "./coordinators";

export interface KillResult {
  runId: string;
  name: string;
  outcome: "killed" | "already-finished" | "no-process" | "failed";
  via: "handle" | "pid" | "none";
  /** What the child was last doing — so a kill mid-`edit` is visible. */
  lastActivity?: string;
}

export interface KillDeps {
  store: RunStore;
  db: Db;
  getChild?: (sessionId: string, runId: string) => { kill(): void } | undefined;
  kill?: (pid: number, opts?: KillOpts) => Promise<"terminated" | "forced" | "already-dead">;
  alive?: (pid: number) => boolean;
}

const TERMINAL = new Set(["done", "failed", "cancelled"]);

/**
 * Resolve a user-supplied target to concrete runs.
 * Grammar: "all" | exact id | unique id prefix | exact name | unique name prefix.
 * Only ACTIVE runs are considered — killing a finished run is meaningless.
 */
export function resolveKillTargets(store: RunStore, sessionId: string, id: string): RunRow[] {
  const active = store.listActive(sessionId);
  const target = (id ?? "").trim();
  if (target === "all") return active;
  if (!target) throw new Error("kill: `id` is required (a run id, id prefix, name, or \"all\")");

  const exactId = active.find((r) => r.id === target);
  if (exactId) return [exactId];

  const exactName = active.find((r) => r.name === target);
  if (exactName) return [exactName];

  const byPrefix = active.filter((r) => r.id.startsWith(target) || (r.name ?? "").startsWith(target));
  if (byPrefix.length === 1) return byPrefix;
  if (byPrefix.length > 1) {
    const names = byPrefix.map((r) => `${r.name ?? r.agent} (${r.id.slice(0, 8)})`).join(", ");
    throw new Error(`kill: "${target}" is ambiguous — matches ${byPrefix.length} runs: ${names}`);
  }
  throw new Error(`kill: no active run matches "${target}"`);
}

/** The child's most recent meaningful activity, for the kill report.
 *  There is NO listRunEvents helper — `run_events` is queried inline, the same
 *  shape packages/host/src/agents/run-source.ts uses for the detail view. */
function lastActivityOf(db: Db, runId: string): string | undefined {
  try {
    const row = db
      .prepare(
        `SELECT summary FROM run_events
         WHERE run_id = ? AND type IN ('tool_intent','tool_result') AND summary IS NOT NULL
         ORDER BY ts DESC, id DESC LIMIT 1`
      )
      .get(runId) as { summary?: string } | undefined;
    return row?.summary ?? undefined;
  } catch {
    return undefined; // best-effort: a kill must never fail on its own report
  }
}

/**
 * Kill one run. Prefers the live in-process handle; falls back to the persisted
 * pid so children orphaned by a host reload are still killable. The run row is
 * marked `cancelled` on every path that actually stopped (or found already
 * stopped) a process, so the UI never leaves a dead run showing "running".
 */
export async function killRun(deps: KillDeps, sessionId: string, run: RunRow): Promise<KillResult> {
  const name = run.name ?? run.agent;
  if (TERMINAL.has(run.status)) {
    return { runId: run.id, name, outcome: "already-finished", via: "none" };
  }

  const lastActivity = lastActivityOf(deps.db, run.id);
  const child = (deps.getChild ?? getChild)(sessionId, run.id);

  if (child) {
    try { child.kill(); } catch { /* best-effort */ }
    unregisterChild(sessionId, run.id);
    deps.store.cancel(run.id, `killed (was: ${lastActivity ?? "no recorded activity"})`);
    return { runId: run.id, name, outcome: "killed", via: "handle", lastActivity };
  }

  const pid = run.pid ?? undefined;
  const aliveFn = deps.alive ?? isProcessAlive;
  if (pid === undefined || !aliveFn(pid)) {
    // No process to signal (never spawned, or already gone) — reconcile the row.
    deps.store.cancel(run.id, `cancelled — no live process (was: ${lastActivity ?? "no recorded activity"})`);
    return { runId: run.id, name, outcome: "no-process", via: "none", lastActivity };
  }

  const killFn = deps.kill ?? killProcessGroup;
  try { await killFn(pid); } catch { /* best-effort */ }
  deps.store.cancel(run.id, `killed via pid ${pid} (was: ${lastActivity ?? "no recorded activity"})`);
  return { runId: run.id, name, outcome: "killed", via: "pid", lastActivity };
}

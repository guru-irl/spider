import { isToolUsageBucket } from "./parse.js";

export type RunEvent = { dbPath: string; id: number; runId: string; sessionId: string | null; ts: number; type: string; payload: string | null };
export type RunEventSummary = {
  runId: string;
  markerCount: number; markerTs: number; markerSession: string | null;
  usageCount: number; usageSession: string | null; mixedSessions: boolean; lastUsageTs: number;
  /** Earliest observation of each report model group, before any report marker. */
  models: Map<string, number>;
};
export type RunEventFacts = {
  runs: Map<string, RunEventSummary>;
  auxiliary: RunEvent[];
  unknown: { path: string; purpose: string; count: number }[];
};
export const runEventKey = (dbPath: string, runId: string): string => JSON.stringify([dbPath, runId]);
const AUX_PURPOSES = new Set(["memory-review", "skill-review", "learner", "skill-curate"]);
const TRANSCRIPT_PURPOSES = new Set(["compaction", "branch_summary", "subagent", "spider-subagent", "cache_warm", "tools"]);
const text = (value: unknown): string | null => typeof value === "string" && value.trim() ? value : null;

/** Retain proof/model groups, not a second copy of ordinary event history. */
export function summarizeRunEvents(events: Iterable<RunEvent>): RunEventFacts {
  const runs = new Map<string, RunEventSummary>(), auxiliary: RunEvent[] = [];
  const unknown = new Map<string, { path: string; purpose: string; count: number }>();
  for (const event of events) {
    const key = runEventKey(event.dbPath, event.runId);
    let summary = runs.get(key);
    if (!summary) {
      summary = { runId: event.runId, markerCount: 0, markerTs: Infinity, markerSession: null,
        usageCount: 0, usageSession: null, mixedSessions: false, lastUsageTs: -Infinity, models: new Map() };
      runs.set(key, summary);
    }
    if (event.type === "spider_usage_reported") {
      summary.markerCount++;
      summary.markerTs = Math.min(summary.markerTs, event.ts);
      summary.markerSession = event.sessionId;
      continue;
    }
    if (event.type !== "spider_usage") continue;
    if (summary.usageCount && summary.usageSession !== event.sessionId) summary.mixedSessions = true;
    summary.usageSession = event.sessionId;
    summary.usageCount++;
    summary.lastUsageTs = Math.max(summary.lastUsageTs, event.ts);
    let payload: Record<string, unknown>;
    try {
      const value: unknown = JSON.parse(event.payload ?? "");
      payload = value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
    } catch { continue; }
    const provider = text(payload.provider), model = text(payload.model);
    if (provider && model) {
      const group = JSON.stringify(isToolUsageBucket(provider, model) ? [null, null] : [provider, model]);
      summary.models.set(group, Math.min(summary.models.get(group) ?? Infinity, event.ts));
    }
    const purpose = text(payload.purpose);
    if (!purpose || TRANSCRIPT_PURPOSES.has(purpose)) continue;
    if (AUX_PURPOSES.has(purpose)) auxiliary.push(event);
    else {
      const key = JSON.stringify([event.dbPath, purpose]);
      const diagnostic = unknown.get(key) ?? { path: event.dbPath, purpose, count: 0 };
      diagnostic.count++; unknown.set(key, diagnostic);
    }
  }
  return { runs, auxiliary, unknown: [...unknown.values()] };
}

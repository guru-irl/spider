import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { openDb, type Db } from "@spider/db-core";
import { openUsageLedger, type CallRow, type ImportBatch, type UsageLedger } from "../../ledger.js";

export const DASHBOARD_NOW: number = Date.UTC(2026, 9, 16, 12);
export const DASHBOARD_MONTH: number = Date.UTC(2026, 9, 1);
export const DASHBOARD_DAY = 86_400_000;

/** Call and batch builders let subsequent tasks seed extras in their own files. */
export function dashboardCall(id: string, overrides: Partial<CallRow> = {}): CallRow {
  return {
    id, entryId: id, sourceFile: "synthetic/parent.jsonl", sourceGeneration: 0,
    ts: DASHBOARD_MONTH + DASHBOARD_DAY, project: "fixture-project", repo: "fixture-repo",
    sessionId: "parent-session", runId: null, actor: "parent", role: null, agent: null,
    runName: null, phase: null, parentRunId: null, auxPurpose: null,
    provider: "fixture-provider", model: "fixture-model", requestedModel: null, thinking: null, api: null,
    usage: { input: 10, cacheRead: 20, cacheWrite: 30, cacheWrite1h: 5, output: 10, reasoning: 4 },
    price: { status: "priced", aic: 1, components: { input: 0.1, cacheRead: 0.2, cacheWrite: 0.3, output: 0.4 },
      rateVersion: "fixture-rate", tier: "fixture-tier", confidence: "estimated" },
    piCost: null, latencyMs: null, aggregate: false, counted: true, originKey: null,
    sourceKind: "transcript", ...overrides,
  };
}
export function dashboardBatch(calls: readonly CallRow[] = [], extras: Partial<ImportBatch> = {}): ImportBatch {
  return { calls, runs: [], states: [], detailedRunIds: [], restoreAggregateRunIds: [],
    resetSources: [], sourceErrors: [], at: DASHBOARD_NOW, ...extras };
}

export function seedDashboardFixture(ledger: UsageLedger): void {
  const native = dashboardCall("native", { responseId: "native-response" });
  ledger.apply(dashboardBatch([
    native,
    dashboardCall("fork", { responseId: "native-response", copied: true, sourceFile: "synthetic/fork.jsonl", sessionId: "fork-session" }),
    dashboardCall("child-detail", { actor: "subagent", runId: "detailed-run", role: "worker" }),
    dashboardCall("replaced-report", { actor: "subagent", runId: "detailed-run", aggregate: true, sourceKind: "report" }),
    dashboardCall("covering-report", { actor: "subagent", runId: "report-run", aggregate: true, sourceKind: "report", role: "reviewer" }),
    dashboardCall("covered-detail", { actor: "aux", runId: "covered-run" }),
    dashboardCall("overlapping-detail", { actor: "aux", runId: "hint-run", parentRunId: "report-run" }),
    dashboardCall("unpriced", { actor: "warmer", price: { status: "unpriced", reason: "unknown-model" } }),
  ], {
    coverageEdges: [{ reportRunId: "report-run", includedRunId: "covered-run", evidence: "transcript" }],
    incompleteReports: [{ path: "synthetic/parent.jsonl", runId: "report-run" }],
    states: [{ path: "synthetic/parent.jsonl", inode: "fixture-inode", size: 100, offset: 100,
      mtimeMs: DASHBOARD_NOW, parseErrors: 0, generation: 0, prefixHash: "fixture-hash" }],
  }));
  ledger.apply(dashboardBatch([], { publishedSnapshot: { type: "snapshot", health: ledger.health(),
    counter: { availability: "unavailable", role: "inactive", lastAttemptAt: null, lastSuccessAt: null,
      nextPollAt: null, snapshotAgeMs: null, errorCode: null, notice: null, latest: null },
    backfill: "complete", reconciliation: { windowStart: DASHBOARD_MONTH, windowEnd: DASHBOARD_NOW,
      computedAIC: 4, counterAIC: null, gap: null, ratio: null, unpricedCalls: 1, estimated: true } } }));
}

export type DashboardFixture = { root: string; file: string; ledger: UsageLedger; db: Db; close(): void };
export function createDashboardFixture(seed = true): DashboardFixture {
  const root = mkdtempSync(join(process.env.SPIDER_GLOBAL_ROOT!, "dashboard-"));
  const previousEnv = new Map<string, string | undefined>();
  let ledger: UsageLedger | undefined;
  let db: Db | undefined;
  const cleanup = () => {
    try { db?.close(); } finally {
      try { ledger?.close(); } finally {
        for (const [key, value] of previousEnv) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
        rmSync(root, { recursive: true, force: true });
      }
    }
  };
  try {
    for (const [key, dir] of [["HOME", "home"], ["SPIDER_GLOBAL_ROOT", "global"],
      ["PI_CODING_AGENT_DIR", "agent"], ["TMPDIR", "tmp"]]) {
      const value = join(root, dir);
      mkdirSync(value, { recursive: true });
      previousEnv.set(key!, process.env[key!]);
      process.env[key!] = value;
    }
    const file = join(root, "fixture.db");
    ledger = openUsageLedger(file);
    if (seed) seedDashboardFixture(ledger);
    db = openDb(file);
    return { root, file, ledger, db, close: cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
}

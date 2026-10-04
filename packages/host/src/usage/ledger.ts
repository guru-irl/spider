import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { openDb, openDbReadOnly, type Db } from "@spider/db-core";
import { canonicalModelId, COPILOT_RATE_VERSIONS } from "./rates.js";
import type { Actor, PriceResult, UsageTokens } from "./types.js";
import { countedUsageSql, selectionCtes, selectedPredicate } from "./schema.js";
import { assertUsageSchemaVersion, migrateUsageLedger } from "./migrate.js";

/**
 * Run reports have actor='subagent' AND aggregate=true; child summaries use their
 * own actor (compaction/aux) even when aggregate=true and are never run fallbacks.
 * A report covers the child's assistant calls, summaries, aux and nested reports.
 * sourceKind is transcript (own transcript detail), run-db-aux (child spider-aux
 * events persisted only in the runs DB), or report (a run report entry).
 * Only native transcript detail of R displaces R's report. DB-only aux never
 * displaces it and is additive only when no counting report covers its run.
 * Coverage is supplied explicitly by ingest: ONLY transcript/runs-db evidence
 * excludes ALL rows of an included run, across models and model-less summaries,
 * transitively through proven edges. A counted report's own per-model rows supply
 * its breakdown; ingestion must supply every report group atomically. Parent ancestry
 * is metadata, never coverage. Unknown/missing proof keeps both representations
 * and marks possible overlap when a native metadata/source hint relates them.
 * Copies MUST set copied; they never prove a fork's own detail or create hints.
 * Preserve original run attribution on copied detail when known, not the fork run.
 * Detail dedup uses provider-scoped responseId or preserved entryId/time/model/tokens.
 * Native provenance wins over copies, then sourceFile/entryId/id lexical order.
 * Supply message.provider and responseModel ?? model; the ledger stores canonical
 * model ids via the rates alias table and retains raw_provider/raw_model. The
 * current price lookup has no provider aliases: exact provider ids are retained.
 * Unknown ids are never guessed. requestedModel remains separate provenance.
 * Report dedup assumes the producer emits ONE entry per (run, provider, model),
 * as usage-accounting's grouped report producer does; it deliberately ignores tokens.
 * Partial native detail counts as-is. Completeness is uncertain only for a
 * mid-file cursor (unread timestamps are unknown) or selected detail of a
 * nonterminal run, scoped to periods containing that detail. Pricing confidence
 * and aggregate sources are independent of this data-completeness signal.
 * Deletion of a transcript does not erase ingested facts. counted and batch
 * detail/restore signals are legacy, ignored by
 * selection. Source-generation fences still protect atomic resumable ingestion.
 * id must be a collision-resistant deterministic function of (sourceFile, entryId),
 * not entryId alone. Replays preserve the original stored id and pricing.
 * Importers must validate rows before apply and record a source error on invalid
 * input: CHECK constraints fail closed for the whole atomic batch.
 */
export type CallRow = {
  id: string; ts: number; sourceFile: string; entryId: string; sourceGeneration: number;
  project: string | null; repo: string | null; sessionId: string | null; runId: string | null;
  actor: Actor; role: string | null; agent: string | null; runName: string | null; phase: string | null;
  parentRunId: string | null; auxPurpose: string | null; provider: string | null; model: string | null;
  requestedModel: string | null; thinking: string | null; api: string | null;
  usage: UsageTokens; price: PriceResult; piCost: number | null; latencyMs: number | null;
  aggregate: boolean; counted: boolean; originKey: string | null;
  /** Preserved assistant response identity, when the transcript supplies one. */
  responseId?: string | null;
  /** Inherited fork history, never newly billed by the receiving run. Defaults false. */
  copied?: boolean;
  /** Required provenance; report labels must agree with the run-report shape. */
  sourceKind: "transcript" | "run-db-aux" | "report";
};
export type RunMeta = {
  id: string; dbPath: string; project: string | null; repo: string | null; sessionId: string | null;
  parentRunId: string | null; agent: string | null; role: string | null; name: string | null;
  model: string | null; thinking: string | null; phase: string | null;
  startedAt: number | null; endedAt: number | null;
};
export type ImportState = {
  path: string; inode: string; size: number; mtimeMs: number; offset: number; parseErrors: number;
  generation: number; prefixHash: string;
};
export type CounterSnapshot = {
  ts: number; accountLogin?: string; creditsUsed: number; entitlement?: number; remaining?: number;
  resetDate?: string; raw: Record<string, unknown>;
};
export type LedgerHealth = {
  schemaVersion: number; calls: number; sources: number; parseErrors: number; sourceErrors: number;
  unpricedModels: readonly string[]; aggregateCalls: number; lastIngestAt: number | null;
  /** Number of selected report/run overlap pairs. Omitted when zero. */
  possibleOverlaps?: number;
};
export type CoverageEvidence = "transcript" | "runs-db" | "unknown";
export type CoverageEdge = { reportRunId: string; includedRunId: string; evidence: CoverageEvidence };
export type ImportBatch = {
  calls: readonly CallRow[]; runs: readonly RunMeta[]; states: readonly ImportState[];
  /** Compatibility only. Selection depends on raw facts, not these old signals. */
  detailedRunIds: readonly string[]; restoreAggregateRunIds: readonly string[];
  resetSources: readonly { path: string; generation: number }[];
  sourceErrors: readonly { path: string; code: string }[]; at: number;
  /** Included usage, not execution ancestry. Upserts by (reportRunId, includedRunId). */
  coverageEdges?: readonly CoverageEdge[];
  /** Withdraw stale proof atomically. Removals precede upserts in the same batch. */
  removeCoverageEdges?: readonly Pick<CoverageEdge, "reportRunId" | "includedRunId">[];
};
export type UsageSummary = {
  aic: number; pricedCalls: number; unpricedCalls: number;
  /** Data completeness only: possibleUndercount OR possibleOverlap, never pricing. */
  estimated: boolean;
  possibleUndercount: boolean;
  /** Present and true only for selected rows with possible double counting. */
  possibleOverlap?: boolean;
};
export interface UsageLedger {
  apply(batch: ImportBatch): void;
  getImportState(path: string): ImportState | undefined;
  getRuns(): readonly RunMeta[];
  insertCounter(snapshot: CounterSnapshot): void;
  latestCounter(): CounterSnapshot | undefined;
  summarize(start: number, end: number): UsageSummary;
  health(): LedgerHealth;
  close(): void;
}

const BUSY_TIMEOUT_MS = 250;
const OPEN_BUDGET_MS = 2000;
const BACKOFF_WAIT = new Int32Array(new SharedArrayBuffer(4));
const CALL_COLUMNS = [
  "id", "ts", "source_file", "entry_id", "source_generation", "project", "repo", "session_id", "run_id",
  "actor", "role", "agent", "run_name", "phase", "parent_run_id", "aux_purpose", "provider", "model",
  "raw_provider", "raw_model", "source_kind", "requested_model", "thinking", "api", "input", "output", "cache_read", "cache_write", "cache_write_1h",
  "reasoning", "total_tokens", "aic", "aic_input", "aic_cache_read", "aic_cache_write", "aic_output",
  "price_status", "unpriced_reason", "rate_version", "tier", "confidence", "pi_cost", "latency_ms",
  "aggregate", "counted", "origin_key", "response_id", "copied", "fingerprint",
];
type FingerprintCall = Pick<CallRow, "actor" | "aggregate" | "runId" | "provider" | "model" | "responseId" | "entryId" | "ts" | "usage">;
function fingerprint(call: FingerprintCall): string {
  // forkFrom preserves these identities verbatim; source/run/actor can change.
  const identity = call.actor === "subagent" && call.aggregate && call.runId !== null
    ? ["report", call.runId, call.provider, call.model]
    : call.responseId ? ["response", call.provider, call.responseId]
      : ["entry", call.entryId, call.ts, call.provider, call.model, call.usage.input,
        call.usage.output, call.usage.cacheRead, call.usage.cacheWrite, call.usage.cacheWrite1h ?? null,
        call.usage.reasoning ?? null, call.usage.totalTokens ?? null];
  return createHash("sha256").update(JSON.stringify(identity)).digest("hex");
}
function callValues(call: CallRow): Record<string, string | number | null> {
  const price = call.price;
  const canonical = { ...call, model: call.model === null ? null : canonicalModelId(call.model) };
  return {
    id: call.id, ts: call.ts, source_file: call.sourceFile, entry_id: call.entryId,
    source_generation: call.sourceGeneration, project: call.project, repo: call.repo,
    session_id: call.sessionId, run_id: call.runId, actor: call.actor, role: call.role, agent: call.agent,
    run_name: call.runName, phase: call.phase, parent_run_id: call.parentRunId, aux_purpose: call.auxPurpose,
    provider: canonical.provider, model: canonical.model, raw_provider: call.provider, raw_model: call.model,
    source_kind: call.sourceKind, requested_model: call.requestedModel, thinking: call.thinking, api: call.api,
    input: call.usage.input, output: call.usage.output, cache_read: call.usage.cacheRead, cache_write: call.usage.cacheWrite,
    cache_write_1h: call.usage.cacheWrite1h ?? null, reasoning: call.usage.reasoning ?? null, total_tokens: call.usage.totalTokens ?? null,
    aic: price.status === "priced" ? price.aic : null,
    aic_input: price.status === "priced" ? price.components.input : null,
    aic_cache_read: price.status === "priced" ? price.components.cacheRead : null,
    aic_cache_write: price.status === "priced" ? price.components.cacheWrite : null,
    aic_output: price.status === "priced" ? price.components.output : null,
    price_status: price.status, unpriced_reason: price.status === "unpriced" ? price.reason : null,
    rate_version: price.status === "priced" ? price.rateVersion : null,
    tier: price.status === "priced" ? price.tier : null, confidence: price.status === "priced" ? price.confidence : null,
    pi_cost: call.piCost, latency_ms: call.latencyMs, aggregate: Number(call.aggregate), counted: Number(call.counted),
    origin_key: call.originKey, response_id: call.responseId ?? null, copied: Number(call.copied ?? false),
    fingerprint: fingerprint(canonical),
  };
}

function refreshModelAliases(db: Db): void {
  const aliasTable = COPILOT_RATE_VERSIONS.flatMap(version => version.models.map(model => [model.id, [...model.aliases].sort()]));
  const digest = createHash("sha256").update(JSON.stringify(aliasTable)).digest("hex");
  db.raw.transaction(() => {
    const stored = db.prepare("SELECT value FROM ledger_metadata WHERE key='model-aliases'").get() as { value: string } | undefined;
    if (stored?.value === digest) return;
    const update = db.prepare("UPDATE calls SET model=@model, fingerprint=@fingerprint WHERE id=@id");
    const columns = `SELECT id, actor, aggregate, run_id AS runId, raw_provider AS provider,
      raw_model AS model, response_id AS responseId, entry_id AS entryId, ts,
      input, output, cache_read AS cacheRead, cache_write AS cacheWrite, cache_write_1h AS cacheWrite1h,
      reasoning, total_tokens AS totalTokens FROM calls`;
    const first = db.prepare(`${columns} ORDER BY id LIMIT 1000`);
    const next = db.prepare(`${columns} WHERE id > ? ORDER BY id LIMIT 1000`);
    let cursor: string | undefined;
    for (;;) {
      const page = cursor === undefined ? first.all() : next.all(cursor);
      if (page.length === 0) break;
      for (const raw of page) {
        const row = raw as Omit<FingerprintCall, "aggregate" | "usage"> & { id: string; aggregate: number } & UsageTokens;
        const canonical = { ...row, aggregate: Boolean(row.aggregate),
          model: row.model === null ? null : canonicalModelId(row.model),
          usage: { input: row.input, output: row.output, cacheRead: row.cacheRead, cacheWrite: row.cacheWrite,
            cacheWrite1h: row.cacheWrite1h, reasoning: row.reasoning, totalTokens: row.totalTokens } };
        update.run({ id: row.id, model: canonical.model, fingerprint: fingerprint(canonical) });
        cursor = row.id;
      }
    }
    db.prepare("INSERT INTO ledger_metadata(key,value) VALUES ('model-aliases',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(digest);
  }).immediate();
}

/** Worker-only synchronous store. Opening contention has a total 2 s budget. */
export function openUsageLedger(file: string): UsageLedger {
  const deadline = performance.now() + OPEN_BUDGET_MS;
  const timeout = () => Math.max(1, Math.min(BUSY_TIMEOUT_MS, Math.floor(deadline - performance.now())));
  for (let attempt = 0; ; attempt++) {
    let db: Db | undefined;
    try {
      // A read-only preflight must precede EVERY attempt's journal_mode change.
      const snapshot = openDbReadOnly(file, { busyTimeoutMs: timeout() });
      if (snapshot) {
        try { assertUsageSchemaVersion(snapshot); } finally { snapshot.close(); }
      }
      const parentExisted = existsSync(dirname(file));
      // The read-only opener has already validated fixture paths before any mkdir.
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      // All handles skip explicit TRUNCATE checkpoint waits, including on failure.
      // SQLite still checkpoints on the last connection's successful close when able.
      db = openDb(file, { busyTimeoutMs: timeout(), checkpointOnClose: false });
      if (process.platform !== "win32") {
        if (!parentExisted) chmodSync(dirname(file), 0o700);
        for (const path of [file, `${file}-wal`, `${file}-shm`]) {
          if (existsSync(path)) chmodSync(path, 0o600);
        }
      }
      db.pragma(`busy_timeout = ${timeout()}`);
      migrateUsageLedger(db);
      refreshModelAliases(db);
      // Ordinary batch operations retain their independently short busy timeout.
      db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
      return createLedger(db);
    } catch (error) {
      db?.close();
      const code = (error as { code?: unknown } | null)?.code;
      if (typeof code !== "string" || !code.startsWith("SQLITE_BUSY")) throw error;
      const remaining = deadline - performance.now();
      if (remaining <= 0) throw error;
      const delay = Math.min(remaining, (8 + Math.random() * 8) * 2 ** Math.min(attempt, 3));
      // No spin loop; capped jitter avoids fresh-install openers retrying in lockstep.
      Atomics.wait(BACKOFF_WAIT, 0, 0, delay);
      if (performance.now() >= deadline) throw error;
    }
  }
}

function createLedger(db: Db): UsageLedger {
  const getState = db.prepare(`SELECT path, inode, size, mtime_ms AS mtimeMs, offset,
    parse_errors AS parseErrors, generation, prefix_hash AS prefixHash FROM import_state WHERE path = ? AND inode IS NOT NULL`);
  const getFence = db.prepare("SELECT generation, offset FROM import_state WHERE path = ?");
  const insertCall = db.prepare(`INSERT INTO calls (${CALL_COLUMNS.join(",")})
    VALUES (${CALL_COLUMNS.map(column => `@${column}`).join(",")})
    ON CONFLICT(source_file, entry_id) DO NOTHING`);
  const reset = db.prepare("DELETE FROM calls WHERE source_file = ? AND source_generation < ?");
  const putState = db.prepare(`INSERT INTO import_state
    (path, inode, size, mtime_ms, offset, parse_errors, generation, prefix_hash, last_ingest_at)
    VALUES (@path, @inode, @size, @mtimeMs, @offset, @parseErrors, @generation, @prefixHash, @at)
    ON CONFLICT(path) DO UPDATE SET inode=excluded.inode, size=excluded.size, mtime_ms=excluded.mtime_ms,
    offset=excluded.offset, parse_errors=excluded.parse_errors, generation=excluded.generation,
    prefix_hash=excluded.prefix_hash, source_error_code=NULL,
    last_ingest_at=MAX(import_state.last_ingest_at, excluded.last_ingest_at)`);
  const putError = db.prepare(`INSERT INTO import_state (path, source_error_code, last_ingest_at)
    VALUES (@path, @code, @at) ON CONFLICT(path) DO UPDATE SET source_error_code=excluded.source_error_code,
    last_ingest_at=MAX(import_state.last_ingest_at, excluded.last_ingest_at)`);
  const putRun = db.prepare(`INSERT INTO runs_meta
    (id, db_path, project, repo, session_id, parent_run_id, agent, role, name, model, thinking, phase, started_at, ended_at)
    VALUES (@id, @dbPath, @project, @repo, @sessionId, @parentRunId, @agent, @role, @name, @model, @thinking, @phase, @startedAt, @endedAt)
    ON CONFLICT(db_path,id) DO UPDATE SET project=excluded.project, repo=excluded.repo, session_id=excluded.session_id,
    parent_run_id=excluded.parent_run_id, agent=excluded.agent, role=excluded.role, name=excluded.name, model=excluded.model,
    thinking=excluded.thinking, phase=excluded.phase, started_at=excluded.started_at, ended_at=excluded.ended_at`);
  const putCoverageEdge = db.prepare(`INSERT INTO coverage_edges (report_run_id, included_run_id, evidence)
    VALUES (@reportRunId, @includedRunId, @evidence) ON CONFLICT(report_run_id, included_run_id)
    DO UPDATE SET evidence=excluded.evidence`);
  const removeCoverageEdge = db.prepare("DELETE FROM coverage_edges WHERE report_run_id=? AND included_run_id=?");
  const getRuns = db.prepare(`SELECT id, db_path AS dbPath, project, repo, session_id AS sessionId,
    parent_run_id AS parentRunId, agent, role, name, model, thinking, phase,
    started_at AS startedAt, ended_at AS endedAt FROM runs_meta ORDER BY db_path,id`);
  const insertCounter = db.prepare(`INSERT INTO counter_snapshots (ts, account_login, credits_used, entitlement, remaining, reset_date, raw)
    VALUES (@ts, @accountLogin, @creditsUsed, @entitlement, @remaining, @resetDate, @raw)`);
  const latestCounter = db.prepare(`SELECT ts, account_login AS accountLogin, credits_used AS creditsUsed,
    entitlement, remaining, reset_date AS resetDate, raw FROM counter_snapshots ORDER BY ts DESC, rowid DESC LIMIT 1`);
  const summarize = db.prepare(`SELECT COALESCE(SUM(aic), 0) AS aic,
    COALESCE(SUM(price_status = 'priced'), 0) AS pricedCalls,
    COALESCE(SUM(price_status = 'unpriced'), 0) AS unpricedCalls,
    (COALESCE(MAX(possible_undercount), 0)
      OR EXISTS (SELECT 1 FROM import_state WHERE offset < size)) AS possibleUndercount,
    COALESCE(MAX(possible_overlap), 0) AS possibleOverlap
    FROM (${countedUsageSql("c.ts >= ? AND c.ts < ?", "c.aic, c.price_status, c.run_id, c.is_report, c.source_file, c.source_kind", "calls_period_read")})`);
  // Do not evaluate counted_calls over historical detail. Only the indexed
  // report/unpriced candidates need selection; total rows are transaction-maintained.
  const healthCalls = db.prepare(`WITH RECURSIVE ${selectionCtes}
    SELECT (SELECT calls FROM ledger_totals WHERE singleton = 1) AS calls,
    (SELECT COUNT(*) FROM calls c INDEXED BY calls_health_reports
      WHERE c.is_report = 1 AND ${selectedPredicate()}) AS aggregateCalls`);
  const healthOverlaps = db.prepare("SELECT COUNT(*) AS possibleOverlaps FROM usage_possible_overlaps");
  const healthSources = db.prepare(`SELECT COUNT(*) AS sources, COALESCE(SUM(parse_errors), 0) AS parseErrors,
    COALESCE(SUM(source_error_code IS NOT NULL), 0) AS sourceErrors, MAX(last_ingest_at) AS lastIngestAt FROM import_state`);
  const unpricedModels = db.prepare(`WITH RECURSIVE ${selectionCtes}
    SELECT DISTINCT c.model FROM calls c INDEXED BY calls_health_unpriced
    WHERE c.price_status = 'unpriced' AND c.model IS NOT NULL AND ${selectedPredicate()} ORDER BY c.model`);

  return {
    apply(batch) {
      db.raw.transaction(() => {
        // Validate every source before mutating anything, including calls without a cursor.
        // Cache only within this transaction: other connections may advance fences.
        const fences = new Map<string, { generation: number; offset: number | null } | undefined>();
        const fence = (path: string) => {
          if (!fences.has(path)) fences.set(path, getFence.get(path) as { generation: number; offset: number | null } | undefined);
          return fences.get(path);
        };
        const resets = new Map(batch.resetSources.map(source => [source.path, source.generation]));
        const states = new Map(batch.states.map(state => [state.path, state]));
        if (states.size !== batch.states.length) throw new Error("Duplicate import state path in batch");
        for (const state of batch.states) {
          const previous = fence(state.path);
          if (previous && (state.generation < previous.generation ||
            state.generation === previous.generation && state.offset < (previous.offset ?? 0))) {
            throw new Error(`Stale import generation/offset for ${state.path}`);
          }
          if (previous && state.generation > previous.generation && resets.get(state.path) !== state.generation) {
            throw new Error(`Source generation changed without reset for ${state.path}`);
          }
        }
        for (const source of batch.resetSources) {
          const previous = fence(source.path);
          if (previous && source.generation < previous.generation) throw new Error(`Stale reset generation for ${source.path}`);
          if (states.get(source.path)?.generation !== source.generation) {
            throw new Error(`Source reset requires matching import state for ${source.path}`);
          }
        }
        for (const call of batch.calls) {
          if (!["transcript", "run-db-aux", "report"].includes(call.sourceKind)) {
            throw new Error(`Invalid sourceKind for call ${call.id}: expected transcript, run-db-aux or report; received ${String(call.sourceKind)}`);
          }
          const isReport = call.actor === "subagent" && call.aggregate && call.runId !== null;
          if ((call.sourceKind === "report") !== isReport) {
            throw new Error(`Invalid sourceKind for call ${call.id}: report label must match a subagent run report`);
          }
          const previous = fence(call.sourceFile);
          const generation = states.get(call.sourceFile)?.generation ?? previous?.generation;
          if (generation !== undefined && call.sourceGeneration !== generation) {
            throw new Error(`Stale call generation for ${call.sourceFile}`);
          }
        }
        for (const source of batch.resetSources) reset.run(source.path, source.generation);
        for (const run of batch.runs) putRun.run(run);
        for (const call of batch.calls) insertCall.run(callValues(call));
        for (const edge of batch.removeCoverageEdges ?? []) removeCoverageEdge.run(edge.reportRunId, edge.includedRunId);
        for (const edge of batch.coverageEdges ?? []) putCoverageEdge.run(edge);
        for (const state of batch.states) putState.run({ ...state, at: batch.at });
        for (const error of batch.sourceErrors) putError.run({ ...error, at: batch.at });
      }).immediate();
    },
    getImportState(path) { return getState.get(path) as ImportState | undefined; },
    getRuns() {
      return getRuns.all() as RunMeta[];
    },
    insertCounter(snapshot) {
      insertCounter.run({
        ts: snapshot.ts, accountLogin: snapshot.accountLogin ?? null, creditsUsed: snapshot.creditsUsed,
        entitlement: snapshot.entitlement ?? null, remaining: snapshot.remaining ?? null,
        resetDate: snapshot.resetDate ?? null, raw: JSON.stringify(snapshot.raw),
      });
    },
    latestCounter() {
      const row = latestCounter.get() as
        { ts: number; accountLogin: string | null; creditsUsed: number; entitlement: number | null;
          remaining: number | null; resetDate: string | null; raw: string } | undefined;
      if (!row) return undefined;
      return {
        ts: row.ts, creditsUsed: row.creditsUsed, raw: JSON.parse(row.raw) as Record<string, unknown>,
        ...(row.accountLogin === null ? {} : { accountLogin: row.accountLogin }),
        ...(row.entitlement === null ? {} : { entitlement: row.entitlement }),
        ...(row.remaining === null ? {} : { remaining: row.remaining }),
        ...(row.resetDate === null ? {} : { resetDate: row.resetDate }),
      };
    },
    summarize(start, end) {
      const { possibleOverlap, possibleUndercount, ...row } = summarize.get(start, end) as
        Omit<UsageSummary, "estimated" | "possibleOverlap" | "possibleUndercount"> & { possibleUndercount: number; possibleOverlap: number };
      return { ...row, possibleUndercount: Boolean(possibleUndercount), estimated: Boolean(possibleUndercount || possibleOverlap),
        ...(possibleOverlap ? { possibleOverlap: true } : {}) };
    },
    health() {
      const calls = healthCalls.get() as
        { calls: number; aggregateCalls: number };
      const sources = healthSources.get() as
        { sources: number; parseErrors: number; sourceErrors: number; lastIngestAt: number | null };
      const models = unpricedModels.all() as { model: string }[];
      const { possibleOverlaps } = healthOverlaps.get() as { possibleOverlaps: number };
      return { schemaVersion: db.pragma("user_version") as number, ...calls, ...sources, unpricedModels: models.map(row => row.model),
        ...(possibleOverlaps ? { possibleOverlaps } : {}) };
    },
    close() { db.close(); },
  };
}

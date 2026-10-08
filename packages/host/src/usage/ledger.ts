import type { UsageWorkerEvent } from "./protocol.js";
import { readSourceErrorDiagnostics } from "./query-source-errors.js";
import type { CalibrationResult } from "./dashboard-contract.js";
import { createCalibrationService, calibrationFallback } from "./calibration.js";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { openDb, openDbReadOnly, type Db } from "@spider/db-core";
import { canonicalModelId, COPILOT_RATE_VERSIONS } from "./rates.js";
import type { Actor, PriceResult, UsageTokens } from "./types.js";
import { storedSelection, countedUsageSql, selectionCtes, selectedPredicate } from "./schema.js";
import { assertUsageSchemaVersion, migrateUsageLedger } from "./migrate.js";
import { createUsageLeaseStore, type UsageLeaseStore } from "./lease.js";

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
 * its breakdown; complete groups import atomically, while terminal/aged partial
 * groups carry a reversible incomplete flag until completion. Parent ancestry
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
  status?: "queued" | "running" | "paused" | "done" | "failed" | "cancelled" | null;
};
export function normalizeRunStatus(status: unknown): NonNullable<RunMeta["status"]> | null {
  return typeof status === "string" && ["queued", "running", "paused", "done", "failed", "cancelled"].includes(status)
    ? status as NonNullable<RunMeta["status"]> : null;
}
/** Private store inputs. Public dashboard responses must redact these fields. */
export type SessionMeta = {
  id: string; ownerSessionId: string | null; name: string; nameSource: "name" | "first-user" | "id";
  project: string | null; firstActivity: number | null; lastActivity: number | null; nameOrder: number;
};
export type MetadataCheckpoint = {
  path: string; generation: number; offset: number; size: number; complete: boolean;
};
export type SourceContext = { header: Record<string, unknown> | null; entries: { byteOffset: number; json: unknown }[]; tailHash: string };
export type PendingReport = { path: string; runId: string; generation: number; firstSeen: number; calls: CallRow[]; partial?: boolean };
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
  sessions?: readonly SessionMeta[];
  metadataCheckpoints?: readonly MetadataCheckpoint[];
  /** Replaced sources rebuild labels/spans instead of merging stale metadata. */
  resetSessionMetadata?: readonly { path: string; sessionId: string | null }[];
  /** Worker ingest-lease fence, sampled under the same IMMEDIATE write lock. */
  commitGuard?: () => boolean;
  publishedSnapshot?: Extract<UsageWorkerEvent, { type: "snapshot" }>;
  backfillState?: "pending" | "running" | "complete" | "failed";
  /** Compatibility only. Selection depends on raw facts, not these old signals. */
  detailedRunIds: readonly string[]; restoreAggregateRunIds: readonly string[];
  resetSources: readonly { path: string; generation: number }[];
  sourceErrors: readonly { path: string; code: string; checkedPaths?: readonly string[] }[]; at: number;
  sourceContexts?: readonly { path: string; context: SourceContext }[];
  pendingReports?: readonly PendingReport[];
  removePendingReports?: readonly { path: string; runId: string }[];
  incompleteReports?: readonly { path: string; runId: string }[];
  completeReports?: readonly { path: string; runId: string }[];
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
  readonly leases: UsageLeaseStore;
  /** False means the lease fence rejected the entire transaction. */
  apply(batch: ImportBatch): boolean;
  getSourceErrors(): readonly { path: string; code: string; checkedPaths?: readonly string[] }[];
  getSourceErrorDiagnostics(limit: number): ReturnType<typeof readSourceErrorDiagnostics>;
  getProgress(): { calls: number; sources: number; parseErrors: number; sourceErrors: number; lastIngestAt: number | null };
  getPublishedSnapshot(): Extract<UsageWorkerEvent, { type: "snapshot" }> | undefined;
  dataVersion(): number;
  getImportState(path: string): ImportState | undefined;
  getRuns(): readonly RunMeta[];
  getSessions(): readonly SessionMeta[];
  getMetadataCheckpoint(path: string): MetadataCheckpoint | undefined;
  /** With roots, load only their persisted ancestry plus the last linear node.
   * An empty roots array reads header/checkpoints only. Omitted roots is a diagnostic full read. */
  getSourceContext(path: string, roots?: readonly string[]): SourceContext | undefined;
  getSourceHeaders(): readonly { path: string; header: Record<string, unknown> | null }[];
  getPendingReports(): readonly PendingReport[];
  getIncompleteReports(): readonly { path: string; runId: string }[];
  getReportModels(path: string, runId: string): readonly { provider: string | null; requestedModel: string | null }[];
  getProof(): { reports: { runId: string; owner: string | null; path: string; ts: number }[]; edges: CoverageEdge[] };
  insertCounter(snapshot: CounterSnapshot): void;
  latestCounter(): CounterSnapshot | undefined;
  getCalibration(mode: "auto" | "off"): CalibrationResult;
  summarize(start: number, end: number): UsageSummary;
  health(): LedgerHealth;
  getBackfillState(): "pending" | "running" | "complete" | "failed";
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
    const update = db.prepare(`UPDATE calls SET model=@model, fingerprint=@fingerprint WHERE id=@id
      AND (model IS NOT @model OR fingerprint IS NOT @fingerprint)`);
    const columns = `SELECT id, actor, aggregate, run_id AS runId, raw_provider AS provider,
      raw_model AS model, response_id AS responseId, entry_id AS entryId, ts,
      input, output, cache_read AS cacheRead, cache_write AS cacheWrite, cache_write_1h AS cacheWrite1h,
      reasoning, total_tokens AS totalTokens FROM calls`;
    const first = db.prepare(`${columns} ORDER BY id LIMIT 1000`);
    const next = db.prepare(`${columns} WHERE id > ? ORDER BY id LIMIT 1000`);
    let cursor: string | undefined;
    for (; ;) {
      const page = cursor === undefined ? first.all() : next.all(cursor);
      if (page.length === 0) break;
      for (const raw of page) {
        const row = raw as Omit<FingerprintCall, "aggregate" | "usage"> & { id: string; aggregate: number } & UsageTokens;
        const canonical = {
          ...row, aggregate: Boolean(row.aggregate),
          model: row.model === null ? null : canonicalModelId(row.model),
          usage: {
            input: row.input, output: row.output, cacheRead: row.cacheRead, cacheWrite: row.cacheWrite,
            cacheWrite1h: row.cacheWrite1h, reasoning: row.reasoning, totalTokens: row.totalTokens
          }
        };
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

/** Never creates, migrates, canonicalizes or changes journal mode for followers. */
export function openUsageLedgerReadOnly(file: string): UsageLedger | undefined {
  const db = openDbReadOnly(file, { busyTimeoutMs: BUSY_TIMEOUT_MS });
  if (!db) return undefined;
  try {
    assertUsageSchemaVersion(db);
    // Another initial opener may have created the file but not committed its
    // first schema transaction. Let the bounded writable opener serialize it.
    if (db.pragma("user_version") === 0) { db.close(); return undefined; }
    return createLedger(db);
  }
  catch (error) { db.close(); throw error; }
}

function createLedger(db: Db): UsageLedger {
  // Followers may still read a shipped v1-v3 file before its writer upgrades it.
  const hasMetadata = Number(db.pragma("user_version")) >= 4;
  const calibration = createCalibrationService(db, { revision: () => {
    const row = db.prepare("SELECT value FROM ledger_metadata WHERE key='call-selection-revision'").get() as { value: string } | undefined;
    if (!row || !/^\d+$/.test(row.value)) throw new Error("usage-revision-unavailable");
    return row.value;
  } });
  const context = db.prepare("SELECT header, tail_hash AS tailHash FROM source_context WHERE path=?");
  const headers = db.prepare("SELECT path, header FROM source_context");
  const putContext = db.prepare(`INSERT INTO source_context(path,header,tail_hash) VALUES (?,?,?)
    ON CONFLICT(path) DO UPDATE SET header=excluded.header, tail_hash=excluded.tail_hash`);
  const allEntries = db.prepare("SELECT byte_offset AS byteOffset,json FROM source_entries WHERE path=? AND generation=? ORDER BY byte_offset");
  const lastEntry = db.prepare("SELECT linear_id AS id FROM source_entries WHERE path=? AND generation=? ORDER BY byte_offset DESC LIMIT 1");
  const entryState = db.prepare("SELECT state_id AS stateId FROM source_entries WHERE path=? AND generation=? AND entry_id=? ORDER BY byte_offset LIMIT 1");
  const putEntry = db.prepare(`INSERT INTO source_entries(path,generation,byte_offset,entry_id,parent_id,state_id,state_parent_id,linear_id,json)
    VALUES (@path,@generation,@byteOffset,@entryId,@parentId,@stateId,@stateParentId,@linearId,@json) ON CONFLICT(path,generation,byte_offset) DO NOTHING`);
  const resetEntries = db.prepare("DELETE FROM source_entries WHERE path=?");
  const ancestry = db.prepare(`WITH RECURSIVE wanted(id) AS (
    SELECT value FROM json_each(@roots)
    UNION SELECT e.state_parent_id FROM wanted w CROSS JOIN source_entries e INDEXED BY source_entries_identity
      ON e.path=@path AND e.generation=@generation AND e.entry_id=w.id WHERE e.state_parent_id IS NOT NULL
  ) SELECT e.byte_offset AS byteOffset,e.json,e.state_parent_id AS parentId
    FROM wanted w CROSS JOIN source_entries e INDEXED BY source_entries_identity
      ON e.path=@path AND e.generation=@generation AND e.entry_id=w.id ORDER BY e.byte_offset`);
  const pending = db.prepare("SELECT path,run_id AS runId,generation,first_seen AS firstSeen,calls FROM pending_reports");
  const putPending = db.prepare(`INSERT INTO pending_reports(path,run_id,generation,first_seen,calls) VALUES (@path,@runId,@generation,@firstSeen,@calls)
    ON CONFLICT(path,run_id) DO UPDATE SET generation=excluded.generation,first_seen=excluded.first_seen,calls=excluded.calls
    WHERE (pending_reports.generation, pending_reports.first_seen, pending_reports.calls) IS NOT
      (excluded.generation, excluded.first_seen, excluded.calls)`);
  const removePending = db.prepare("DELETE FROM pending_reports WHERE path=? AND run_id=?");
  const incomplete = db.prepare("SELECT path,run_id AS runId FROM incomplete_reports");
  const reportModels = db.prepare("SELECT raw_provider AS provider,requested_model AS requestedModel FROM calls WHERE source_file=? AND run_id=? AND is_report=1");
  const removeIncomplete = db.prepare("DELETE FROM incomplete_reports WHERE path=? AND run_id=?");
  const resetPending = db.prepare("DELETE FROM pending_reports WHERE path=?");
  const resetIncomplete = db.prepare("DELETE FROM incomplete_reports WHERE path=?");
  const putIncomplete = db.prepare("INSERT OR IGNORE INTO incomplete_reports(path,run_id) VALUES (?,?)");
  const getReports = db.prepare(`SELECT run_id AS runId,parent_run_id AS owner,source_file AS path,ts
    FROM calls INDEXED BY calls_reports WHERE is_report=1 AND copied=0`);
  const getEdges = db.prepare("SELECT report_run_id AS reportRunId,included_run_id AS includedRunId,evidence FROM coverage_edges");
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
    prefix_hash=excluded.prefix_hash, source_error_code=NULL, source_error_paths=NULL,
    last_ingest_at=MAX(import_state.last_ingest_at, excluded.last_ingest_at)`);
  const putError = db.prepare(`INSERT INTO import_state (path, source_error_code, source_error_paths, last_ingest_at)
    VALUES (@path, @code, @checkedPaths, @at) ON CONFLICT(path) DO UPDATE SET source_error_code=excluded.source_error_code,
    source_error_paths=excluded.source_error_paths,
    last_ingest_at=MAX(import_state.last_ingest_at, excluded.last_ingest_at)
    WHERE import_state.source_error_code IS NOT excluded.source_error_code
      OR import_state.source_error_paths IS NOT excluded.source_error_paths`);
  const putRun = db.prepare(`INSERT INTO runs_meta
    (id, db_path, project, repo, session_id, parent_run_id, agent, role, name, model, thinking, phase, started_at, ended_at${hasMetadata ? ", status" : ""})
    VALUES (@id, @dbPath, @project, @repo, @sessionId, @parentRunId, @agent, @role, @name, @model, @thinking, @phase, @startedAt, @endedAt${hasMetadata ? ", @status" : ""})
    ON CONFLICT(db_path,id) DO UPDATE SET project=excluded.project, repo=excluded.repo, session_id=excluded.session_id,
    parent_run_id=excluded.parent_run_id, agent=excluded.agent, role=excluded.role, name=excluded.name, model=excluded.model,
    thinking=excluded.thinking, phase=excluded.phase, started_at=excluded.started_at, ended_at=excluded.ended_at
    ${hasMetadata ? ", status=CASE WHEN @hasStatus THEN excluded.status ELSE runs_meta.status END" : ""}
    WHERE (runs_meta.project, runs_meta.repo, runs_meta.session_id, runs_meta.parent_run_id,
      runs_meta.agent, runs_meta.role, runs_meta.name, runs_meta.model, runs_meta.thinking,
      runs_meta.phase, runs_meta.started_at, runs_meta.ended_at) IS NOT
      (excluded.project, excluded.repo, excluded.session_id, excluded.parent_run_id,
      excluded.agent, excluded.role, excluded.name, excluded.model, excluded.thinking,
      excluded.phase, excluded.started_at, excluded.ended_at)
    ${hasMetadata ? "OR (@hasStatus AND runs_meta.status IS NOT excluded.status)" : ""}`);
  // Normalize each incoming span before merging. Missing bounds use the known
  // endpoint, reversed bounds are sorted, and empty ownership cannot erase evidence.
  const putSession = hasMetadata ? db.prepare(`INSERT INTO sessions
    (id,owner_session_id,name,name_source,project,first_activity,last_activity,name_order)
    VALUES (@id,@ownerSessionId,@name,@nameSource,@project,
      MIN(COALESCE(@firstActivity,@lastActivity),COALESCE(@lastActivity,@firstActivity)),
      MAX(COALESCE(@firstActivity,@lastActivity),COALESCE(@lastActivity,@firstActivity)),@nameOrder)
    ON CONFLICT(id) DO UPDATE SET owner_session_id=COALESCE(NULLIF(excluded.owner_session_id,''),sessions.owner_session_id),
      project=COALESCE(NULLIF(excluded.project,''),sessions.project),
      name=CASE WHEN excluded.name_order >= sessions.name_order THEN excluded.name ELSE sessions.name END,
      name_source=CASE WHEN excluded.name_order >= sessions.name_order THEN excluded.name_source ELSE sessions.name_source END,
      name_order=MAX(sessions.name_order,excluded.name_order),
      first_activity=CASE WHEN sessions.first_activity IS NULL THEN excluded.first_activity
        WHEN excluded.first_activity IS NULL THEN sessions.first_activity ELSE MIN(sessions.first_activity,excluded.first_activity) END,
      last_activity=CASE WHEN sessions.last_activity IS NULL THEN excluded.last_activity
        WHEN excluded.last_activity IS NULL THEN sessions.last_activity ELSE MAX(sessions.last_activity,excluded.last_activity) END`) : undefined;
  const getSessions = hasMetadata ? db.prepare(`SELECT id,owner_session_id AS ownerSessionId,name,name_source AS nameSource,
    project,first_activity AS firstActivity,last_activity AS lastActivity,name_order AS nameOrder FROM sessions ORDER BY id`) : undefined;
  const putMetadataCheckpoint = hasMetadata ? db.prepare(`INSERT INTO session_metadata_import(path,generation,offset,size,complete)
    VALUES (@path,@generation,@offset,@size,@complete) ON CONFLICT(path) DO UPDATE SET
      generation=excluded.generation,offset=excluded.offset,size=excluded.size,complete=excluded.complete
    WHERE (session_metadata_import.generation,session_metadata_import.offset,session_metadata_import.size,session_metadata_import.complete)
      IS NOT (excluded.generation,excluded.offset,excluded.size,excluded.complete)`) : undefined;
  const getMetadataCheckpoint = hasMetadata ? db.prepare("SELECT path,generation,offset,size,complete FROM session_metadata_import WHERE path=?") : undefined;
  const resetSession = hasMetadata ? db.prepare("DELETE FROM sessions WHERE id=?") : undefined;
  const resetMetadataCheckpoint = hasMetadata ? db.prepare("DELETE FROM session_metadata_import WHERE path=?") : undefined;
  const putCoverageEdge = db.prepare(`INSERT INTO coverage_edges (report_run_id, included_run_id, evidence)
    VALUES (@reportRunId, @includedRunId, @evidence) ON CONFLICT(report_run_id, included_run_id)
    DO UPDATE SET evidence=excluded.evidence WHERE coverage_edges.evidence IS NOT excluded.evidence`);
  const removeCoverageEdge = db.prepare("DELETE FROM coverage_edges WHERE report_run_id=? AND included_run_id=?");
  const getRuns = db.prepare(`SELECT id, db_path AS dbPath, project, repo, session_id AS sessionId,
    parent_run_id AS parentRunId, agent, role, name, model, thinking, phase,
    started_at AS startedAt, ended_at AS endedAt${hasMetadata ? ", status" : ""} FROM runs_meta ORDER BY db_path,id`);
  const insertCounter = db.prepare(`INSERT INTO counter_snapshots (ts, account_login, credits_used, entitlement, remaining, reset_date, raw)
    VALUES (@ts, @accountLogin, @creditsUsed, @entitlement, @remaining, @resetDate, @raw)`);
  const latestCounter = db.prepare(`SELECT ts, account_login AS accountLogin, credits_used AS creditsUsed,
    entitlement, remaining, reset_date AS resetDate, raw FROM counter_snapshots ORDER BY rowid DESC LIMIT 1`);
  const summarize = db.prepare(`SELECT COALESCE(SUM(aic), 0) AS aic,
    COALESCE(SUM(price_status = 'priced'), 0) AS pricedCalls,
    COALESCE(SUM(price_status = 'unpriced'), 0) AS unpricedCalls,
    (COALESCE(MAX(possible_undercount), 0)
      OR EXISTS (SELECT 1 FROM import_state WHERE offset < size)
      OR EXISTS (SELECT 1 FROM pending_reports)) AS possibleUndercount,
    COALESCE(MAX(possible_overlap), 0) AS possibleOverlap
    FROM (${countedUsageSql("c.ts >= ? AND c.ts < ?", "c.aic, c.price_status, c.run_id, c.is_report, c.source_file, c.source_kind", "calls_period_read", storedSelection(db))})`);
  // Do not evaluate counted_calls over historical detail. Only the indexed
  // report/unpriced candidates need selection; total rows are transaction-maintained.
  const healthCalls = db.prepare(`WITH RECURSIVE ${selectionCtes}
    SELECT (SELECT calls FROM ledger_totals WHERE singleton = 1) AS calls,
    (SELECT COUNT(*) FROM calls c INDEXED BY calls_health_reports
      WHERE c.is_report = 1 AND ${selectedPredicate("c", storedSelection(db))}) AS aggregateCalls`);
  const healthOverlaps = db.prepare("SELECT COUNT(*) AS possibleOverlaps FROM usage_possible_overlaps");
  const healthSources = db.prepare(`SELECT COUNT(*) AS sources, COALESCE(SUM(parse_errors), 0) AS parseErrors,
    COALESCE(SUM(source_error_code IS NOT NULL), 0) AS sourceErrors, MAX(last_ingest_at) AS lastIngestAt FROM import_state`);
  const unpricedModels = db.prepare(`WITH RECURSIVE ${selectionCtes}
    SELECT DISTINCT c.model FROM calls c INDEXED BY calls_health_unpriced
    WHERE c.price_status = 'unpriced' AND c.model IS NOT NULL AND ${selectedPredicate("c", storedSelection(db))} ORDER BY c.model`);

  const ledger: UsageLedger = {
    leases: createUsageLeaseStore(db, snapshot => ledger.insertCounter(snapshot)),
    apply(batch) {
      return db.raw.transaction(() => {
        if (batch.commitGuard && !batch.commitGuard()) return false;
        if (batch.publishedSnapshot) db.prepare("INSERT INTO ledger_metadata(key,value) VALUES ('worker-snapshot',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE ledger_metadata.value IS NOT excluded.value").run(JSON.stringify(batch.publishedSnapshot));
        if (batch.backfillState) db.prepare("INSERT INTO ledger_metadata(key,value) VALUES ('backfill-state',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(batch.backfillState);
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
        const metadataResets = [...batch.resetSessionMetadata ?? []];
        for (const source of batch.resetSources) {
          const old = context.get(source.path) as { header: string } | undefined;
          const id = old ? (JSON.parse(old.header) as { id?: unknown } | null)?.id : null;
          metadataResets.push({ path: source.path, sessionId: typeof id === "string" ? id : null });
          reset.run(source.path, source.generation);
          resetPending.run(source.path);
          resetIncomplete.run(source.path);
          resetEntries.run(source.path);
        }
        // Only batches carrying billing calls isolate optional metadata with
        // savepoints. Metadata-only batches remain strict and transactional.
        // Diagnostic keys identify the write, not a source path, and successful
        // retries (including strict batches) clear only their own fallback row.
        const clearMetadataError = db.prepare("DELETE FROM import_state WHERE path=? AND source_error_code='metadata-invalid'");
        const optionalMetadata = (write: () => void, path: string) => {
          if (!batch.calls.length) { write(); clearMetadataError.run(path); return; }
          db.exec("SAVEPOINT usage_optional_metadata");
          try { write(); clearMetadataError.run(path); db.exec("RELEASE usage_optional_metadata"); }
          catch {
            db.exec("ROLLBACK TO usage_optional_metadata"); db.exec("RELEASE usage_optional_metadata");
            try { putError.run({ path, code: "metadata-invalid", checkedPaths: null, at: batch.at }); } catch { /* malformed diagnostic cannot abort billing */ }
          }
        };
        for (const run of batch.runs) optionalMetadata(() => putRun.run({ ...run, status: batch.calls.length ? normalizeRunStatus(run.status) : run.status ?? null, hasStatus: Number(run.status !== undefined) }), `metadata:run:${JSON.stringify([run.dbPath, run.id])}`);
        for (const item of metadataResets) optionalMetadata(() => {
          if (item.sessionId !== null) resetSession?.run(item.sessionId);
          resetMetadataCheckpoint?.run(item.path);
        }, `metadata:reset:${item.path}`);
        for (const session of batch.sessions ?? []) optionalMetadata(() => {
          if (!Number.isSafeInteger(session.nameOrder) || session.nameOrder < 0 ||
            [session.firstActivity, session.lastActivity].some(v => v !== null && (!Number.isFinite(v) || Math.abs(v) > 8.64e15))) throw new Error("invalid metadata");
          putSession?.run(session);
        }, `metadata:session:${session.id}`);
        for (const checkpoint of batch.metadataCheckpoints ?? []) optionalMetadata(() => putMetadataCheckpoint?.run({ ...checkpoint, complete: Number(checkpoint.complete) }), `metadata:checkpoint:${checkpoint.path}`);
        for (const call of batch.calls) insertCall.run(callValues(call));
        for (const edge of batch.removeCoverageEdges ?? []) removeCoverageEdge.run(edge.reportRunId, edge.includedRunId);
        for (const edge of batch.coverageEdges ?? []) putCoverageEdge.run(edge);
        for (const state of batch.states) putState.run({ ...state, at: batch.at });
        for (const item of batch.sourceContexts ?? []) {
          putContext.run(item.path, JSON.stringify(item.context.header), item.context.tailHash);
          const generation = states.get(item.path)?.generation ?? fence(item.path)?.generation ?? 0;
          let previousId = (lastEntry.get(item.path, generation) as { id: string } | undefined)?.id ?? null;
          for (const entry of item.context.entries) {
            const record = entry.json as Record<string, unknown>;
            const entryId = typeof record.id === "string" && record.id.trim() ? record.id : `offset:${entry.byteOffset}`;
            const parentId = record.parentId === undefined ? previousId : typeof record.parentId === "string" && record.parentId.trim() ? record.parentId : null;
            const duplicate = entryState.get(item.path, generation, entryId) as { stateId: string | null } | undefined;
            const parent = parentId === null ? undefined : entryState.get(item.path, generation, parentId) as { stateId: string | null } | undefined;
            // Compress non-state ancestry, not branch links: a branch inherits
            // its explicit parent's nearest model/thinking change. Missing/forward
            // references remain literal so later nodes and cycles can resolve.
            const stateParentId = parent ? parent.stateId : parentId;
            const changesState = record.type === "model_change" || record.type === "thinking_level_change";
            const stateId = duplicate ? duplicate.stateId : changesState ? entryId : stateParentId;
            if (record.type !== "session" && !duplicate) previousId = entryId;
            putEntry.run({
              path: item.path, generation, byteOffset: entry.byteOffset, entryId, parentId,
              stateId, stateParentId, linearId: previousId, json: JSON.stringify(record)
            });
          }
        }
        for (const item of batch.removePendingReports ?? []) removePending.run(item.path, item.runId);
        for (const item of batch.pendingReports ?? []) putPending.run({ ...item, calls: JSON.stringify({ calls: item.calls, partial: item.partial }) });
        for (const item of batch.completeReports ?? []) removeIncomplete.run(item.path, item.runId);
        for (const item of batch.incompleteReports ?? []) putIncomplete.run(item.path, item.runId);
        for (const error of batch.sourceErrors) putError.run({ ...error, checkedPaths: error.checkedPaths ? JSON.stringify(error.checkedPaths) : null, at: batch.at });
        return true;
      }).immediate();
    },
    dataVersion() { return db.pragma("data_version") as number; },
    getPublishedSnapshot() {
      const row = db.prepare("SELECT value FROM ledger_metadata WHERE key='worker-snapshot'").get() as { value: string } | undefined;
      return row ? JSON.parse(row.value) : undefined;
    },
    getProgress() {
      const totals = db.prepare("SELECT calls FROM ledger_totals WHERE singleton=1").get() as { calls: number };
      return { ...totals, ...healthSources.get() as { sources: number; parseErrors: number; sourceErrors: number; lastIngestAt: number | null } };
    },
    getSourceErrorDiagnostics(limit) { return readSourceErrorDiagnostics(db, limit); },
    getSourceErrors() {
      return (db.prepare("SELECT path, source_error_code AS code, source_error_paths AS checkedPaths FROM import_state WHERE source_error_code IS NOT NULL").all() as { path: string; code: string; checkedPaths: string | null }[])
        .map(({ checkedPaths, ...row }) => ({ ...row, ...(checkedPaths === null ? {} : { checkedPaths: JSON.parse(checkedPaths) }) }));
    },
    getSourceContext(path, roots) {
      const row = context.get(path) as { header: string; tailHash: string } | undefined;
      if (!row) return undefined;
      const generation = (getState.get(path) as ImportState | undefined)?.generation ?? 0;
      let entries: { byteOffset: number; json: unknown }[] = [];
      if (roots === undefined) {
        entries = (allEntries.all(path, generation) as { byteOffset: number; json: string }[])
          .map(e => ({ ...e, json: JSON.parse(e.json) }));
      } else if (roots.length) {
        const last = (lastEntry.get(path, generation) as { id: string } | undefined)?.id;
        entries = (ancestry.all({ path, generation, roots: JSON.stringify([...roots, ...(last ? [last] : [])]) }) as
          { byteOffset: number; json: string; parentId: string | null }[])
          .map(e => ({ byteOffset: e.byteOffset, json: { ...JSON.parse(e.json), parentId: e.parentId } }));
      }
      return { header: JSON.parse(row.header), entries, tailHash: row.tailHash };
    },
    getSourceHeaders() {
      return (headers.all() as { path: string; header: string }[]).map(row => ({ ...row, header: JSON.parse(row.header) }));
    },
    getPendingReports() {
      return (pending.all() as (Omit<PendingReport, "calls"> & { calls: string })[]).map(row => ({ ...row, ...JSON.parse(row.calls) }));
    },
    getIncompleteReports() { return incomplete.all() as ReturnType<UsageLedger["getIncompleteReports"]>; },
    getReportModels(path, runId) { return reportModels.all(path, runId) as ReturnType<UsageLedger["getReportModels"]>; },
    getProof() { return { reports: getReports.all() as ReturnType<UsageLedger["getProof"]>["reports"], edges: getEdges.all() as CoverageEdge[] }; },
    getImportState(path) { return getState.get(path) as ImportState | undefined; },
    getRuns() {
      return getRuns.all() as RunMeta[];
    },
    getSessions() { return (getSessions?.all() ?? []) as SessionMeta[]; },
    getMetadataCheckpoint(path) {
      const row = getMetadataCheckpoint?.get(path) as (Omit<MetadataCheckpoint, "complete"> & { complete: number }) | undefined;
      return row ? { ...row, complete: Boolean(row.complete) } : undefined;
    },
    insertCounter(snapshot) {
      insertCounter.run({
        ts: snapshot.ts, accountLogin: snapshot.accountLogin ?? null, creditsUsed: snapshot.creditsUsed,
        entitlement: snapshot.entitlement ?? null, remaining: snapshot.remaining ?? null,
        resetDate: snapshot.resetDate ?? null, raw: JSON.stringify(snapshot.raw),
      });
    },
    getCalibration(mode) {
      try { return calibration.current(mode); }
      catch (error) {
        if (error instanceof Error && error.message === "usage-revision-unavailable") return calibrationFallback(mode);
        throw error;
      }
    },
    latestCounter() {
      const row = latestCounter.get() as
        {
          ts: number; accountLogin: string | null; creditsUsed: number; entitlement: number | null;
          remaining: number | null; resetDate: string | null; raw: string
        } | undefined;
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
      return {
        ...row, possibleUndercount: Boolean(possibleUndercount), estimated: Boolean(possibleUndercount || possibleOverlap),
        ...(possibleOverlap ? { possibleOverlap: true } : {})
      };
    },
    health() {
      const calls = healthCalls.get() as
        { calls: number; aggregateCalls: number };
      const sources = healthSources.get() as
        { sources: number; parseErrors: number; sourceErrors: number; lastIngestAt: number | null };
      const models = unpricedModels.all() as { model: string }[];
      const { possibleOverlaps } = healthOverlaps.get() as { possibleOverlaps: number };
      return {
        schemaVersion: db.pragma("user_version") as number, ...calls, ...sources, unpricedModels: models.map(row => row.model),
        ...(possibleOverlaps ? { possibleOverlaps } : {})
      };
    },
    getBackfillState() {
      const row = db.prepare("SELECT value FROM ledger_metadata WHERE key='backfill-state'").get() as { value: string } | undefined;
      return row && ["pending", "running", "complete", "failed"].includes(row.value) ? row.value as "pending" | "running" | "complete" | "failed" : "pending";
    },
    close() { db.close(); },
  };
  return ledger;
}

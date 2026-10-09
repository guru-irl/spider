import { openDb, type Db } from "@spider/db-core";
import { openUsageLedger } from "../../ledger.js";
import { DASHBOARD_ROUTES } from "../../api-routes.js";
import type { DashboardQueryContext, DashboardRoute, Period, Filter } from "../../dashboard-contract.js";
import { dashboardBatch, dashboardCall, DASHBOARD_NOW, DASHBOARD_MONTH, DASHBOARD_DAY } from "./dashboard-ledger.js";

export const PLAN_START: number = Date.UTC(2024, 10, 1);
export function seedPlanLedger(file: string, rows: number, options: { denseMonthCalls?: number } = {}): { now: number; periods: readonly Period[]; sessionId: string; runId: string; expected: Record<string, number> } {
  if (!Number.isSafeInteger(rows) || rows < 1) throw new RangeError("positive row count required");
  const dense = options.denseMonthCalls;
  if (dense !== undefined && (!Number.isSafeInteger(dense) || dense < 32 || dense >= rows)) throw new RangeError("dense month must be smaller than history");
  const now = dense ? Date.UTC(2026, 9, 31, 23) : DASHBOARD_NOW;
  const historyRows = dense ? rows - dense : rows;
  const span = now - PLAN_START;
  const baseTimestamp = dense ? `CASE WHEN n<${historyRows} THEN ${PLAN_START}+CAST(n*${DASHBOARD_MONTH - PLAN_START}.0/${historyRows} AS INTEGER) ELSE ${DASHBOARD_MONTH}+CAST((n-${historyRows})*${now - DASHBOARD_MONTH}.0/${dense} AS INTEGER) END` : `${PLAN_START}+CAST(n*${span}.0/${rows} AS INTEGER)`;
  // Deterministic sub-step jitter preserves the month bounds but avoids uniform cadence.
  const timestamp = dense ? `(${baseTimestamp})+CAST((n%7)*${(now - DASHBOARD_MONTH) / (dense * 14)} AS INTEGER)` : baseTimestamp;
  const report = dense ? `n>=${historyRows} AND n<${historyRows + 16}` : "0";
  const ledger = openUsageLedger(file);
  let db: Db | undefined;
  try {
    ledger.apply(dashboardBatch([dashboardCall("plan-0", { ts: PLAN_START, sessionId: "plan-session-0", runId: "plan-run-0", actor: "subagent",
      price: { status: "priced", aic: 100, components: { input: 10, cacheRead: 20, cacheWrite: 30, output: 40 }, rateVersion: "fixture-rate", tier: "fixture-tier", confidence: "estimated" } })]));
    db = openDb(file);
    const columns = (db.prepare("PRAGMA table_info(calls)").all() as { name: string }[]).map(row => row.name);
    const expressions = columns.map(name => {
      if (["id", "entry_id", "fingerprint"].includes(name)) return "'plan-'||n";
      if (name === "ts") return timestamp;
      if (name === "session_id") return dense ? "'plan-session-'||CAST(n/256 AS INTEGER)||'-'||(n%4)" : "'plan-session-'||(n%256)";
      if (name === "run_id") return dense ? `CASE WHEN ${report} THEN CASE WHEN n<${historyRows + 8} THEN 'plan-run-'||CAST((n+32)/64 AS INTEGER)||'-'||((n+32)%4) ELSE 'plan-report-'||n END WHEN n%17=0 THEN NULL ELSE 'plan-run-'||CAST(n/64 AS INTEGER)||'-'||(n%4) END` : "'plan-run-'||(n%128)";
      if (name === "provider" && dense) return "'fixture-provider-'||(n%2)";
      if (name === "model" && dense) return "'fixture-model-'||(n%4)";
      if (name === "rate_version" && dense) return "'fixture-rate-'||(n%2)";
      if (name === "tier" && dense) return "'fixture-tier-'||(n%2)";
      if (name === "source_file" && dense) return `CASE WHEN ${report} THEN 'synthetic/report-'||n||'.jsonl' ELSE 'synthetic/session-'||CAST(n/256 AS INTEGER)||'.jsonl' END`;
      if (name === "aggregate") return `CASE WHEN ${report} THEN 1 ELSE 0 END`;
      if (name === "source_kind") return `CASE WHEN ${report} THEN 'report' ELSE 'transcript' END`;
      if (name === "cache_read") return dense ? "CASE WHEN CAST(n/256 AS INTEGER)%2=0 THEN 0 ELSE 20 END" : "CASE WHEN n%256<128 THEN 0 ELSE 20 END";
      if (name === "actor") return `CASE WHEN ${report} THEN 'subagent' ELSE CASE n%5 WHEN 0 THEN 'parent' WHEN 1 THEN 'subagent' WHEN 2 THEN 'aux' WHEN 3 THEN 'compaction' ELSE 'warmer' END END`;
      if (name === "role") return "CASE WHEN n%5=1 THEN 'worker' ELSE NULL END";
      return `template.${name}`;
    });
    db.raw.transaction(() => {
      if (rows > 1) db!.exec(`WITH RECURSIVE sequence(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM sequence WHERE n<${rows - 1})
        INSERT INTO calls (${columns.join(",")}) SELECT ${expressions.join(",")} FROM sequence CROSS JOIN calls template WHERE template.id='plan-0'`);
      const counter = db!.prepare("INSERT INTO counter_snapshots(ts,account_login,credits_used,entitlement,remaining,reset_date,raw) VALUES (?,?,?,?,?,?,?)");
      const countBefore = (at: number) => dense
        ? at < DASHBOARD_MONTH ? Math.max(0, Math.ceil((at - PLAN_START) * historyRows / (DASHBOARD_MONTH - PLAN_START))) : historyRows + Math.min(dense, Math.ceil((at - DASHBOARD_MONTH) * dense / (now - DASHBOARD_MONTH)))
        : Math.max(0, Math.min(rows, Math.ceil((at - PLAN_START) * rows / span)));
      for (let ts = PLAN_START; ts <= now; ts = Math.min(ts + (dense ? 600000 : DASHBOARD_DAY), now)) {
        const date = new Date(ts), start = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
        const credits = (countBefore(ts) - countBefore(start)) * 50;
        const reset = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1)).toISOString();
        counter.run(ts, "synthetic-plan-account", credits, 100_000_000, 100_000_000 - credits, reset, '{"fixture":"private-counter-payload"}');
        if (ts === now) break;
      }
      db!.prepare("INSERT INTO leases(name,next_due_at) VALUES ('counter',?)").run(now + 600000);
      if (dense) db!.exec(`INSERT INTO runs_meta(id,db_path,session_id,role,started_at,ended_at)
        SELECT run_id,'synthetic/runs.db',MIN(session_id),'worker',MIN(ts),MAX(ts)+60000 FROM calls WHERE run_id IS NOT NULL GROUP BY run_id`);
      else {
        const meta = db!.prepare("INSERT INTO runs_meta(id,db_path,session_id,role,started_at,ended_at) VALUES (?,?,?,?,?,?)");
        for (let i = 0; i < 256; i++) meta.run(`plan-meta-${i}`, "synthetic/runs.db", `plan-session-${i}`, "worker", PLAN_START, now);
        meta.run("plan-run-0", "synthetic/runs.db", "plan-session-0", "worker", PLAN_START, now);
      }
    }).immediate();
    // Real top-level transcripts have non-run own calls. Do not make every
    // parent/compaction/background observation look like a child transcript.
    db.exec("UPDATE calls SET run_id=NULL WHERE is_report=0 AND actor IN ('parent','compaction','aux','warmer')");
    const sessionId = dense ? `plan-session-${Math.floor((rows - 128) / 256)}-${(rows - 128) % 4}` : "plan-session-0";
    const runId = dense ? `plan-run-${Math.floor((rows - 128) / 64)}-${(rows - 128) % 4}` : "plan-run-0";
    const total = (column?: string, id?: string) => (db!.prepare(`SELECT count(*) AS n FROM calls WHERE ts>=? AND ts<? ${column ? `AND ${column}=?` : ""}`).get(DASHBOARD_MONTH, now, ...(column ? [id] : [])) as { n: number }).n;
    return { now, periods: [{ start: DASHBOARD_MONTH, end: now }, { start: now - 366 * DASHBOARD_DAY, end: now }],
      sessionId, runId, expected: { rows, month: total(), session: total("session_id", sessionId), run: total("run_id", runId) } };
  } finally { db?.close(); ledger.close(); }
}

export type CapturedQuery = { sql: string; args: unknown[]; calibration?: string };
/** Capture executed SQL, not merely prepared statements. Also used by the local benchmark. */
export function captureQueries<T>(ctx: DashboardQueryContext, read: () => T): { value: T; queries: CapturedQuery[] } {
  const queries: CapturedQuery[] = [], prepare = ctx.db.prepare, calibration = ctx.calibration;
  let phase: string | undefined;
  ctx.calibration = new Proxy(calibration, { get(target, key) {
    const value = Reflect.get(target, key);
    if (typeof value !== "function") return value;
    return (...args: unknown[]) => { const prior = phase; phase = String(key); try { return value.apply(target, args); } finally { phase = prior; } };
  } });
  ctx.db.prepare = ((sql: string) => {
    const statement = prepare.call(ctx.db, sql), attribution = phase;
    for (const method of ["all", "get", "iterate"] as const) {
      const execute = statement[method].bind(statement);
      Object.assign(statement, { [method]: (...args: unknown[]) => { queries.push({ sql, args, calibration: attribution }); return execute(...args); } });
    }
    return statement;
  }) as typeof prepare;
  try { return { value: read(), queries }; } finally { ctx.db.prepare = prepare; ctx.calibration = calibration; }
}
export type PlanRow = { id: number; parent: number; detail: string; statement: number; callScans?: string[]; callReads?: string[] };
export function explainQueries(db: Db, queries: readonly CapturedQuery[]): PlanRow[] {
  const roots = new Map((db.prepare("SELECT rootpage,name FROM sqlite_schema WHERE tbl_name='calls' AND rootpage>0").all() as { rootpage: number; name: string }[]).map(r => [r.rootpage, r.name]));
  return queries.flatMap(({ sql, args }, statement) => {
    const plans = (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args) as Omit<PlanRow, "statement">[]).map(row => ({ ...row, statement }));
    const ops = db.prepare(`EXPLAIN ${sql}`).all(...args) as { opcode: string; p1: number; p2: number; p3: number }[];
    const cursors = new Map<number, string>();
    const scans: string[] = [], reads = new Set<string>();
    for (const op of ops) {
      if (op.opcode === "OpenRead" && op.p3 === 0 && roots.has(op.p2)) { cursors.set(op.p1, roots.get(op.p2)!); reads.add(roots.get(op.p2)!); }
      if (op.opcode === "Close" || op.opcode.startsWith("Open") && op.opcode !== "OpenRead") cursors.delete(op.p1);
      if (["Rewind", "Last"].includes(op.opcode) && cursors.has(op.p1)) {
        const table = cursors.get(op.p1)!;
        // Partial indexes enumerate only the sparse report set, not raw calls.
        if (!["calls_reports", "calls_native_reports_source"].includes(table)) scans.push(table);
      }
    }
    if (plans[0]) { plans[0].callScans = scans; plans[0].callReads = [...reads]; }
    return plans;
  });
}
/** One pass per executed statement that really reads calls, regardless of SQL spelling. */
export function callPassQueries(db: Db, queries: readonly CapturedQuery[]): CapturedQuery[] {
  const statements = new Set(explainQueries(db, queries).filter(row => row.callReads?.length).map(row => row.statement));
  return queries.filter((_, i) => statements.has(i));
}
/** Bytecode resolves each cursor to its real table even inside MATERIALIZE subplans. */
export function assertCallPlans(plans: readonly PlanRow[]): void {
  const scans = plans.flatMap(row => row.callScans ?? []);
  if (scans.length) throw new Error(`call-table scan: ${scans.join("; ")}`);
}
export type PlanRequest = { name: string; path: string; params: URLSearchParams; cap: number; kib: number; budgetMs: number; access: "period" | "session" | "run" | "metadata" | "none" | "source" };
export function assertRegisteredRoutes(routes: readonly DashboardRoute[], checkedPaths: readonly string[]): void {
  const paths = routes.map(r => r.path);
  if (new Set(paths).size !== paths.length) throw new Error("duplicate registered route");
  const missing = paths.filter(path => !checkedPaths.includes(path));
  const extra = checkedPaths.filter(path => !paths.includes(path));
  if (missing.length || extra.length) throw new Error(`missing route checks: ${[...missing, ...extra].join(", ")}`);
}
export function assertRoutePlans(request: PlanRequest, queries: readonly CapturedQuery[], plans: readonly PlanRow[]): void {
  // The stable model catalogue deliberately ranks an all-history indexed aggregate.
  // All billing measures and interval passes must still have bounded access paths.
  const catalogue = new Set(queries.flatMap((q, i) => q.sql.includes("FROM calls c INDEXED BY calls_provider_model_ts") && q.sql.includes("SUM(c.aic)") && q.sql.includes("GROUP BY c.model") ? [i] : []));
  assertCallPlans(plans.filter(row => !catalogue.has(row.statement)));
  for (const q of queries) if (/FROM calls prior\b/.test(q.sql) || /window AS MATERIALIZED/.test(q.sql) && !q.sql.includes("selection_shadowed = 0")) throw new Error(`${request.name}: stored selection required`);
  for (const [i, q] of queries.entries()) {
    if (!q.calibration) continue;
    const rows = plans.filter(p => p.statement === i);
    if (q.calibration === "earliest") {
      // Legacy dynamic overlap selection. Changes to this snapshot-chunk path
      // need review rather than silently broadening the per-interval exception.
      const actual = [...new Set(rows.flatMap(p => p.callReads ?? []))].sort();
      const pinned = ["calls", "calls_period_read", "calls_reports", "calls_run_detail", "calls_owners_source", "calls_native_sources", "calls_native_reports_source"].sort();
      if ((actual.length || q.sql.includes("interval_calls AS MATERIALIZED")) && JSON.stringify(actual) !== JSON.stringify(pinned)) throw new Error(`${request.name}: earliest accessed index set changed: ${actual.join(", ")}`);
      for (const row of rows) if (/USING (?:COVERING )?INDEX calls_period_read\b/.test(row.detail) && !/calls_period_read \(ts>\? AND ts<\?\)/.test(row.detail)) throw new Error(`${request.name}: calibration access path requires both interval bounds`);
      continue;
    }
    const callReads = rows.flatMap(p => p.callReads ?? []).filter(name => !["calls_reports", "calls_native_reports_source"].includes(name));
    // Inspect every ordinary calls index access, not just the period-index rows.
    // A statement with only a table/rowid read must also fail the empty guard.
    const inReportSelection = (row: PlanRow): boolean => {
      let parent = rows.find(p => p.id === row.parent);
      while (parent) {
        if (parent.detail === "MATERIALIZE report_runs") return true;
        parent = rows.find(p => p.id === parent!.parent);
      }
      return false;
    };
    // Sparse report selection includes an exact transcript-existence lookup.
    // It is not an interval pass; keep that exception confined to report_runs.
    const aliases = new Set(["calls"]);
    for (const match of q.sql.matchAll(/\b(?:FROM|JOIN)\s+(?:"calls"|calls)(?:\s+(?:AS\s+)?([a-z_]\w*))?/gi)) {
      if (match[1] && !["WHERE", "INDEXED", "NOT", "ON", "UNION"].includes(match[1].toUpperCase())) aliases.add(match[1]);
    }
    const accesses = rows.filter(p => (callReads.some(name => p.detail.includes(`INDEX ${name} (`)) ||
      callReads.includes("calls") && /^SEARCH (\S+) USING INTEGER PRIMARY KEY/.test(p.detail) && aliases.has(p.detail.split(" ")[1]!)) &&
      !(inReportSelection(p) && /^SEARCH \S+ USING (?:COVERING )?INDEX calls_run_detail \(run_id=\?(?: AND |\))/.test(p.detail)));
    if (callReads.length && (!accesses.length || accesses.some(p => !/calls_period_read \(ts>\? AND ts<\?\)/.test(p.detail)))) throw new Error(`${request.name}: calibration access path requires both interval bounds`);
  }
  const own = queries.map((q, i) => ({ q, i })).filter(({ q }) => !q.calibration);
  for (const { q, i } of own) {
    if (catalogue.has(i)) continue;
    const rows = plans.filter(p => p.statement === i);
    for (const row of rows) if (/USING (?:COVERING )?INDEX calls_period_read\b/.test(row.detail) && !/calls_period_read \(ts>\? AND ts<\?\)/.test(row.detail)) throw new Error(`${request.name}: access path requires both period bounds`);
    // Every window in this statement is checked independently. Another statement,
    // including a calibration pass, cannot satisfy an absent range bound.
    for (const row of rows) {
      const parent = rows.find(p => p.id === row.parent);
      const window = parent?.detail === "MATERIALIZE window";
      const range = /(?:FROM|JOIN) calls c INDEXED BY calls_period_read/.test(q.sql);
      if (window && /^SEARCH c\b/.test(row.detail) && range && !/calls_period_read \(ts>\? AND ts<\?\)/.test(row.detail)) throw new Error(`${request.name}: access path requires both period bounds`);
      if (window && /^SEARCH c\b/.test(row.detail) && request.access === "session" && !/calls_session_read \(session_id=\? AND ts>\? AND ts<\?\)/.test(row.detail)) throw new Error(`${request.name}: access path requires session and both bounds`);
    }
    if (request.access === "period" && /FROM calls c INDEXED BY calls_period_read/.test(q.sql) && !rows.some(p => /calls_period_read \(ts>\? AND ts<\?\)/.test(p.detail))) throw new Error(`${request.name}: access path requires period index`);
    if (q.sql.includes("interval_calls AS MATERIALIZED") && !rows.some(p => /SEARCH r USING (?:COVERING )?INDEX calls_period_read \(ts>\? AND ts<\?\)/.test(p.detail))) throw new Error(`${request.name}: access path requires interval range`);
  }
  const routeRows = plans.filter(p => !queries[p.statement]?.calibration);
  const expected = request.access === "session" ? /calls_session_read \(session_id=\?/ : request.access === "run" ? /calls_run_detail \(run_id=\?/ : request.access === "period" ? /calls_period_read \(ts>\? AND ts<\?\)/ : undefined;
  if (expected && !routeRows.some(p => expected.test(p.detail))) throw new Error(`${request.name}: access path missing`);

}
export function planRequests(period: Period, sessionId: string, _runId: string, _filters?: readonly Filter[]): PlanRequest[] {
  // Overview's public custom range is capped at 93 days. Whole-session is not.
  const params = new URLSearchParams({ range: "custom", from: String(Math.max(period.start, period.end - 93 * DASHBOARD_DAY)), to: String(period.end), tz: "UTC" });
  const entries: PlanRequest[] = [
    { name: "status", path: "/api/status", params: new URLSearchParams(), cap: 12, kib: 8, budgetMs: 100, access: "metadata" },
    { name: "overview", path: "/api/overview", params: new URLSearchParams(params), cap: 26, kib: 1024, budgetMs: 1000, access: "period" },
    { name: "sessions", path: "/api/sessions", params: new URLSearchParams(params), cap: 8, kib: 512, budgetMs: 1000, access: "period" },
    { name: "session", path: "/api/session/<id>", params: new URLSearchParams({ tz: "UTC", fixtureId: sessionId }), cap: 28, kib: 2048, budgetMs: 1500, access: "session" },
    { name: "calibration", path: "/api/calibration", params: new URLSearchParams(), cap: 22, kib: 1024, budgetMs: 1500, access: "period" },
  ];
  assertRegisteredRoutes(DASHBOARD_ROUTES, entries.map(r => r.path));
  return entries;
}
export function executePlanRequest(ctx: DashboardQueryContext, request: PlanRequest): unknown {
  const route = DASHBOARD_ROUTES.find(route => route.path === request.path)!;
  const params = new URLSearchParams(request.params), id = params.get("fixtureId") ?? undefined;
  params.delete("fixtureId");
  return route.handle(ctx, params, id);
}

/** The observing writer detects commits from any other connection, on every table. */
export function assertNoWrites(db: Db, before: number): void {
  if (Number(db.pragma("data_version")) !== before) throw new Error("database write during requests");
}

export function referenceRouteResult(db: Db, request: PlanRequest): Record<string, unknown> {
  // Independent fixture oracle: all canonical decisions are checked separately
  // against the frozen dynamic SQL in selection-v3 differential tests.
  const total = (start: number, end: number, id?: string) => db.prepare(`SELECT COUNT(*) AS calls,
    SUM(price_status='unpriced') AS unpricedCalls, SUM(input+cache_read+cache_write+output) AS tokens
    FROM selected_usage_calls WHERE ts>=? AND ts<? ${id ? "AND (session_id=? OR run_id IN (SELECT id FROM runs_meta WHERE session_id=?))" : ""}`)
    .get(start, end, ...(id ? [id, id] : [])) as { calls: number; unpricedCalls: number; tokens: number | null };
  if (request.name === "overview" || request.name === "session") {
    const id = request.params.get("fixtureId") ?? undefined;
    const value = total(request.name === "session" ? 0 : Number(request.params.get("from")), request.name === "session" ? 8640000000000000 : Number(request.params.get("to")), id);
    return { total: { calls: value.calls, unpricedCalls: value.unpricedCalls ?? 0, tokens: { total: value.tokens ?? 0 } } };
  }
  if (request.name === "status") return { latestCounterAt: (db.prepare("SELECT MAX(ts) AS ts FROM counter_snapshots").get() as { ts: number | null }).ts };
  if (request.name === "sessions") return { offset: 0, limit: 10 };
  if (request.name === "calibration") return { ingestion: { errors: 0 }, errors: [] };
  throw new Error(`missing reference: ${request.name}`);
}
/** Compare reference totals before accepting a benchmark sample. No handler SQL is reused. */
export function assertReferenceResult(name: string, value: unknown, expected: Record<string, unknown>): void {
  const compare = (actual: any, reference: any, path: string): void => {
    if (Array.isArray(reference)) {
      if (!Array.isArray(actual) || actual.length !== reference.length) throw new Error(`${name}: reference mismatch at ${path}.length`);
      for (let i = 0; i < reference.length; i++) compare(actual[i], reference[i], `${path}[${i}]`);
    } else if (reference && typeof reference === "object") {
      for (const [key, child] of Object.entries(reference)) compare(actual?.[key], child, `${path}.${key}`);
    } else if (actual !== reference) throw new Error(`${name}: reference mismatch at ${path}: ${actual} != ${reference}`);
  };
  compare(value, expected, "data");
}

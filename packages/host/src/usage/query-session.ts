import { DashboardQueryError, type DashboardQueryContext, type DashboardRoute, type Period } from "./dashboard-contract.js";
import { RESPONSE_CAPS_V4, type OwnCallBin, type SessionData, type SessionRun, type SessionRange, type Value } from "./dashboard-v4-contract.js";
import { billingPeriod } from "./billing-pace.js";
import { latestValidCounter } from "./latest-valid-counter.js";
import { dayKey, keyAt, localDayStart, ordinal } from "./web/session-day.js";
import { runRoleGroup, fourRoleGroup } from "./run-role.js";
import { shortSessionName } from "./session-name.js";
import { dashboardLabel, supportedDetailId } from "./dashboard-identities.js";
import { DAY_MS, invalidQuery, safeTimestamp, validateParams } from "./dashboard-selection.js";
import { flowFromCube, modelRows, readSessionCorrectedComponents, readCorrectionFactors, readSessionUsageCube, sessionCandidatesSql, sessionModelStyles, sessionOwnerResolver, sumValues, UNATTRIBUTED_SESSION_ID } from "./query-redesign-shared.js";

type Session = { id: string; name: string; project: string | null };
type Run = { id: string; sessionId: string | null; parentRunId: string | null; name: string | null; role: string | null; agent: string | null; model: string | null; thinking: string | null; start: number | null; end: number | null; status: string | null };
type Identity = { sessionId: string | null; runId: string | null };
type Scope = { ownerId: string | null; session: Session; runs: Run[]; bindings: { sessions: string; runs: string; from?: number; to?: number }; owns(row: Identity): boolean; sql: string };
const candidateColumns = ["id", "ts", "session_id", "run_id", "actor", "model", "role", "agent", "run_name", "thinking", "aic", "price_status", "input", "cache_read", "cache_write", "output", "cache_write_1h", "reasoning", "is_report", "selection_shadowed", "fingerprint", "copied", "source_file", "entry_id"].map(column => `c.${column}`).join(",");

/** Discover identities from the small durable dictionary and metadata, not an
 * all-history raw-call pass. The shared resolver fails closed on ambiguous evidence. */
function scopeFor(ctx: DashboardQueryContext, id: string): Scope {
  if (!supportedDetailId(id)) throw new DashboardQueryError("not-found");
  const unattributed = id === UNATTRIBUTED_SESSION_ID;
  const sessions = ctx.db.prepare("SELECT id,name,project FROM sessions").all() as Session[];
  const runs = ctx.db.prepare(`SELECT id,session_id AS sessionId,parent_run_id AS parentRunId,name,role,agent,model,thinking,
    started_at AS start,ended_at AS end,status FROM runs_meta`).all() as Run[];
  const dictionary = ctx.db.prepare("SELECT dimension,value FROM dimension_values WHERE dimension IN ('session','run') AND has_value=1").all() as { dimension: string; value: string }[];
  const resolveOwner = sessionOwnerResolver(ctx, [...new Set([...sessions.map(s => s.id), ...dictionary.filter(row => row.dimension === "session").map(row => row.value), id])]);
  if (!unattributed && resolveOwner(id, null) !== id) throw new DashboardQueryError("not-found");
  const matches = (owner: string | null) => unattributed ? owner === null : owner === id;
  const sessionIds = [...new Set([...sessions.map(s => s.id), ...dictionary.filter(row => row.dimension === "session").map(row => row.value), id])]
    .filter(candidate => matches(resolveOwner(candidate, null)));
  const runIds = [...new Set([...runs.map(r => r.id), ...dictionary.filter(row => row.dimension === "run").map(row => row.value)])]
    .filter(candidate => matches(resolveOwner(null, candidate)));
  const sql = sessionCandidatesSql(ctx, candidateColumns, unattributed);
  // Cache resolved pairs only for this request. No per-call owner walk or HMAC.
  const owners = new Map<string, boolean>();
  const owns = ({ sessionId, runId }: Identity) => {
    const key = JSON.stringify([sessionId, runId]);
    let result = owners.get(key);
    if (result === undefined) { result = matches(resolveOwner(sessionId, runId)); owners.set(key, result); }
    return result;
  };
  return { ownerId: unattributed ? null : id, session: unattributed ? { id, name: "Unattributed runs", project: null } : sessions.find(s => s.id === id) ?? { id, name: shortSessionName(id), project: null },
    runs: runs.filter(row => matches(resolveOwner(row.sessionId, row.id))), bindings: { sessions: JSON.stringify(sessionIds), runs: JSON.stringify(runIds) }, owns, sql };
}

function periodFor(ctx: DashboardQueryContext, scope: Scope): Period | null {
  const rows = ctx.db.prepare(`${scope.sql} SELECT session_id AS sessionId,run_id AS runId,MIN(ts) AS first,MAX(ts) AS last
    FROM session_candidates GROUP BY session_id,run_id`).all(scope.bindings) as (Identity & { first: number; last: number })[];
  let first = Infinity, last = -Infinity;
  for (const row of rows) if (scope.owns(row)) { first = Math.min(first, row.first); last = Math.max(last, row.last); }
  return first === Infinity ? null : { start: first, end: last + 1 };
}

/** Query-time canonical activity, never the metadata's historical activity hint. */
export function sessionPeriod(ctx: DashboardQueryContext, id: string): Period | null {
  return periodFor(ctx, scopeFor(ctx, id));
}

type Aggregate = Identity & { ts: number; endpoint: number; credits: number | null; calls: number; unpricedCalls: number;
  input: number; cacheRead: number; cacheWrite: number; output: number; cacheWrite1h: number | null; reasoning: number | null };
const measures = `SUM(c.aic) AS credits,COUNT(*) AS calls,SUM(c.price_status='unpriced') AS unpricedCalls,
  SUM(c.input) AS input,SUM(c.cache_read) AS cacheRead,SUM(c.cache_write) AS cacheWrite,SUM(c.output) AS output,
  SUM(c.cache_write_1h) AS cacheWrite1h,SUM(c.reasoning) AS reasoning`;
function correctedValues(ctx: DashboardQueryContext, span: Period, rows: readonly Aggregate[]): Value[] {
  const correction = readCorrectionFactors(ctx, rows.map(row => row.endpoint));
  return rows.map(row => {
    const prompt = row.input + row.cacheRead + row.cacheWrite;
    return { credits: row.credits === null ? null : row.credits * correction.get(row.endpoint)!, calls: row.calls, unpricedCalls: row.unpricedCalls,
      tokens: { input: row.input, cacheRead: row.cacheRead, cacheWrite: row.cacheWrite, output: row.output, cacheWrite1h: row.cacheWrite1h, reasoning: row.reasoning, prompt, total: prompt + row.output } };
  });
}

function ownBins(ctx: DashboardQueryContext, span: Period, own: readonly Aggregate[], periods: readonly Period[]): OwnCallBin[] {
  // The canonical own sequence is already in memory. A linear sweep avoids a
  // calls-by-periods SQL range join when every call begins an active period.
  const values = correctedValues(ctx, span, own), byBin: Value[][] = periods.map(() => []);
  let bin = 0;
  own.forEach((row, i) => {
    while (bin + 1 < periods.length && row.ts >= periods[bin]!.end) bin++;
    byBin[bin]!.push(values[i]!);
  });
  return periods.map((period, i) => ({ ...period, value: sumValues(byBin[i]!) }));
}

function compactions(ctx: DashboardQueryContext, scope: Scope, span: Period): SessionData["compaction"] {
  const rows = (ctx.db.prepare(`${scope.sql} SELECT c.ts,c.session_id AS sessionId,c.run_id AS runId,
    (CAST(c.ts/${DAY_MS} AS INTEGER)+1)*${DAY_MS} AS endpoint,${measures}
    FROM session_candidates c WHERE c.actor='compaction' GROUP BY c.ts,c.session_id,c.run_id`).all(scope.bindings) as Aggregate[]).filter(scope.owns);
  const values = correctedValues(ctx, span, rows), byTime = new Map<number, Value[]>();
  rows.forEach((row, i) => { const events = byTime.get(row.ts) ?? []; events.push(values[i]!); byTime.set(row.ts, events); });
  return [...byTime].sort(([a], [b]) => a - b).map(([ts, parts]) => ({ ts, value: sumValues(parts) }));
}

const unanimous = <T>(values: readonly (T | null)[]): T | null => new Set(values).size === 1 ? values[0] ?? null : null;
const timestamp = (value: number | null): number | null => value !== null && safeTimestamp(value) ? value : null;
function status(value: string | null): SessionRun["status"] {
  switch (value) {
    case "done": return "completed";
    case "cancelled": case "failed": return value;
    case "queued": case "running": case "paused": return "running";
    default: return null;
  }
}
type RunFact = Identity & { name: string | null; model: string | null; role: string | null; agent: string | null; thinking: string | null };
function sessionRuns(ctx: DashboardQueryContext, scope: Scope, rows: readonly { runId: string | null; value: Value }[], styles: ReturnType<typeof sessionModelStyles>, includeMetadata: boolean): SessionRun[] {
  const facts = (ctx.db.prepare(`${scope.sql} SELECT session_id AS sessionId,run_id AS runId,run_name AS name,model,role,agent,thinking
    FROM session_candidates WHERE run_id IS NOT NULL GROUP BY session_id,run_id,run_name,model,role,agent,thinking`).all(scope.bindings) as RunFact[]).filter(scope.owns);
  const metadata = new Map<string, Run[]>(), labels = new Map<string, RunFact[]>(), values = new Map<string, Value[]>();
  for (const run of scope.runs) { const list = metadata.get(run.id) ?? []; list.push(run); metadata.set(run.id, list); }
  for (const row of facts) { const list = labels.get(row.runId!) ?? []; list.push(row); labels.set(row.runId!, list); }
  for (const row of rows) if (row.runId !== null) { const list = values.get(row.runId) ?? []; list.push(row.value); values.set(row.runId, list); }
  return [...new Set([...(includeMetadata ? metadata.keys() : []), ...labels.keys(), ...values.keys()])].sort().map(id => {
    const meta = metadata.get(id) ?? [], actual = labels.get(id) ?? [];
    // Disagreeing metadata identities never choose an arbitrary private database.
    const label = (field: "name" | "model" | "role" | "agent" | "thinking") => meta.some(row => row[field] !== null)
      ? unanimous(meta.map(row => row[field])) : unanimous(actual.map(row => row[field]));
    const start = timestamp(unanimous(meta.map(row => row.start))), end = timestamp(unanimous(meta.map(row => row.end)));
    const model = dashboardLabel("model", label("model"));
    const role = unanimous(actual.map(row => row.role)) ?? label("role") ?? unanimous(actual.map(row => row.agent)) ?? label("agent");
    return { id: supportedDetailId(id) ? id : null, name: dashboardLabel("runName", label("name") ?? id)!, role: dashboardLabel("role", role) ?? "other",
      roleGroup: fourRoleGroup(runRoleGroup(role, null)),
      model, thinking: dashboardLabel("thinking", label("thinking")), start, end, durationMs: start !== null && end !== null && end >= start ? end - start : null,
      status: status(unanimous(meta.map(row => row.status))), value: sumValues(values.get(id) ?? []), style: model === null ? null : styles.get(model) ?? null };
  });
}

/** Pair adjacent items into bins, retaining the time envelope and exact sums. */
function pairs<T>(items: readonly T[], combine: (a: T, b: T) => T): T[] {
  const result: T[] = [];
  for (let i = 0; i < items.length; i += 2) result.push(i + 1 < items.length ? combine(items[i]!, items[i + 1]!) : items[i]!);
  return result;
}
const knownSum = (a: number | null, b: number | null) => a === null && b === null ? null : (a ?? 0) + (b ?? 0);
/** Reserve transport overhead. Omitted idle gaps retain exact counts and cache
 * write totals, and each remaining gap still describes a real idle interval.
 * Low-cost runs are merged one pair at a time, preserving expensive identities. */
function boundResponse(ctx: DashboardQueryContext, data: SessionData): SessionData {
  const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
  const envelopeBytes = () => bytes({ apiVersion: 1, revision: ctx.revision, generatedAt: ctx.now(),
    period: { start: data.range.from, end: data.range.to }, data });
  const cap = RESPONSE_CAPS_V4["/api/session/<id>"] - 1024;
  let wireBytes = envelopeBytes();
  if (wireBytes <= cap) return data;
  data.detailsBinned = true;
  wireBytes = envelopeBytes();
  const dropped = new Set<SessionData["idleGaps"][number]>();
  // Pop shortest first, retaining the longer gaps most useful for navigation.
  const gaps = [...data.idleGaps].sort((a, b) => (b.end - b.start) - (a.end - a.start) || b.start - a.start);
  let remainingGaps = data.idleGaps.length;
  let gapBytes = bytes(data.idleGaps), runBytes = bytes(data.runs);
  let ownBytes = bytes([data.ownCallBins, data.activePeriods]), compactionBytes = bytes(data.compaction), modelBytes = bytes([data.models, data.flow]);
  const runCost = (a: SessionRun, b: SessionRun) => (a.value.credits ?? 0) - (b.value.credits ?? 0)
    || a.value.tokens.total - b.value.tokens.total || (a.id ?? "").localeCompare(b.id ?? "");
  let runs: SessionRun[] | null = null;
  const syncGaps = () => { if (dropped.size) data.idleGaps = data.idleGaps.filter(gap => !dropped.has(gap)); };
  const recompute = () => {
    syncGaps(); wireBytes = envelopeBytes(); gapBytes = bytes(data.idleGaps); runBytes = bytes(data.runs);
    ownBytes = bytes([data.ownCallBins, data.activePeriods]); compactionBytes = bytes(data.compaction); modelBytes = bytes([data.models, data.flow]);
  };
  while (wireBytes > cap) {
    const choices = [
      { size: gaps.length ? gapBytes : 0, merge: () => {
        const gap = gaps.pop()!, oldStats = bytes(data.stats), remaining = remainingGaps--;
        const removedBytes = bytes(gap) + (remaining > 1 ? 1 : 0);
        dropped.add(gap); gapBytes -= removedBytes;
        const prior = data.stats.omittedIdleGaps;
        data.stats.omittedIdleGaps = { count: (prior?.count ?? 0) + 1, cacheWriteCredits: knownSum(prior?.cacheWriteCredits ?? null, gap.cacheWriteCredits) };
        wireBytes += bytes(data.stats) - oldStats - removedBytes;
      } },
      { size: data.ownCallBins.length > 1 ? ownBytes : 0, merge: () => {
        data.ownCallBins = pairs(data.ownCallBins, (a, b) => ({ start: a.start, end: b.end, value: sumValues([a.value, b.value]) }));
        data.activePeriods = data.ownCallBins.map(({ start, end }) => ({ start, end })); recompute();
      } },
      { size: data.compaction.length > 1 ? compactionBytes : 0, merge: () => {
        data.compaction = pairs(data.compaction, (a, b) => ({ ts: a.ts, value: sumValues([a.value, b.value]) })); recompute();
      } },
      { size: data.runs.length > 1 ? runBytes : 0, merge: () => {
        runs ??= [...data.runs].sort(runCost);
        const a = runs.shift()!, b = runs.shift()!;
        const combined: SessionRun = { id: null, name: "Combined runs", role: "other", roleGroup: "others", model: null, thinking: null,
          start: null, end: null, durationMs: null, status: null, value: sumValues([a.value, b.value]), style: null };
        // Sorted reinsertion lets a growing summary compete with other cheap runs.
        let lo = 0, hi = runs.length;
        while (lo < hi) { const mid = (lo + hi) >>> 1; if (runCost(runs[mid]!, combined) <= 0) lo = mid + 1; else hi = mid; }
        runs.splice(lo, 0, combined); data.runs = runs;
        const removedBytes = bytes(a) + bytes(b) + 1 - bytes(combined);
        runBytes -= removedBytes; wireBytes -= removedBytes;
      } },
      { size: data.models.length > 1 ? modelBytes : 0, merge: () => {
        const mapping = new Map<string, string>();
        const models: SessionData["models"][number][] = [];
        for (let i = 0; i < data.models.length; i += 2) {
          const parts = data.models.slice(i, i + 2), first = parts[0]!, id = `Combined models ${models.length + 1}`;
          parts.forEach(row => mapping.set(row.id, id));
          models.push({ id, value: sumValues(parts.map(row => row.value)), share: parts.reduce((n, row) => n + row.share, 0), note: "Combined models", style: first.style });
        }
        const edges = new Map<string, SessionData["flow"]["edges"][number]>();
        for (const edge of data.flow.edges) {
          const model = mapping.get(edge.model)!, key = JSON.stringify([edge.role, model]), previous = edges.get(key);
          edges.set(key, previous ? { ...previous, value: sumValues([previous.value, edge.value]), share: previous.share + edge.share } : { ...edge, model });
        }
        data.models = models; data.flow = { total: data.total, models, edges: [...edges.values()] }; recompute();
      } },
    ].sort((a, b) => b.size - a.size);
    if (!choices[0]!.size) throw new DashboardQueryError("invalid-query");
    choices[0]!.merge();
  }
  syncGaps();
  return data;
}

function scopedRange(scope: Scope, range: SessionRange): Scope {
  // Time filtering follows global canonical selection, so out-of-range reports and copies cannot reappear.
  return { ...scope, bindings: { ...scope.bindings, ...range },
    sql: `${scope.sql.replace(", session_candidates AS MATERIALIZED (", ", whole_session_candidates AS MATERIALIZED (")},
      session_candidates AS MATERIALIZED (SELECT * FROM whole_session_candidates WHERE ts>=@from AND ts<@to)` };
}
function defaultSessionRange(ctx: DashboardQueryContext, scope: Scope, span: Period | null, current: SessionRange, tz: string): SessionRange {
  if (!span) return current;
  const selected = scopedRange(scope, current);
  const activity = ctx.db.prepare(`${selected.sql} SELECT DISTINCT session_id AS sessionId,run_id AS runId FROM session_candidates`).all(selected.bindings) as Identity[];
  if (activity.some(scope.owns)) return current;
  const firstDay = `${dayKey(span.end - 1, tz).slice(0, 7)}-01`, lastMonth = new Date(ordinal(firstDay));
  const nextDay = keyAt(Date.UTC(lastMonth.getUTCFullYear(), lastMonth.getUTCMonth() + 1, 1));
  return { from: localDayStart(firstDay, tz), to: localDayStart(nextDay, tz) };
}
export function querySession(ctx: DashboardQueryContext, id: string, tz: string, requested?: SessionRange): SessionData {
  try { dayKey(ctx.now(), tz); } catch { invalidQuery(); }
  if (requested && (!safeTimestamp(requested.from) || !safeTimestamp(requested.to) || requested.from >= requested.to)) invalidQuery();
  const whole = scopeFor(ctx, id), period = periodFor(ctx, whole), month = billingPeriod(ctx.now(), latestValidCounter(ctx.db, ctx.now()));
  const billingMonth = { from: localDayStart(keyAt(month.start), tz), to: localDayStart(keyAt(month.end - 1), tz, 1) };
  const range = requested ?? defaultSessionRange(ctx, whole, period, billingMonth, tz);
  const span = period ? { ...period, first: period.start, last: period.end - 1 } : null;
  const scope = scopedRange(whole, range), selected = { start: range.from, end: range.to };
  const own = (ctx.db.prepare(`${scope.sql} SELECT id,ts,session_id AS sessionId,run_id AS runId,
    (CAST(ts/${DAY_MS} AS INTEGER)+1)*${DAY_MS} AS endpoint,aic AS credits,1 AS calls,price_status='unpriced' AS unpricedCalls,
    input,cache_read AS cacheRead,cache_write AS cacheWrite,output,cache_write_1h AS cacheWrite1h,reasoning FROM session_candidates
    WHERE actor='parent' AND run_id IS NULL ORDER BY ts,id`).all(scope.bindings) as (Aggregate & { id: string })[]).filter(scope.owns);
  const activePeriods: Period[] = [], gaps: { start: number; end: number; next: string }[] = [];
  for (let i = 0; i < own.length; i++) {
    const call = own[i]!, previous = own[i - 1], duration = previous ? call.ts - previous.ts : 0;
    if (previous && duration > 5 * 60_000) gaps.push({ start: previous.ts, end: call.ts, next: call.id });
    if (!previous || duration > 30 * 60_000) activePeriods.push({ start: call.ts, end: call.ts + 1 });
    else activePeriods.at(-1)!.end = call.ts + 1;
  }
  const empty = sumValues([]);
  const cube = span === null ? null : readSessionUsageCube(ctx, selected, scope);
  const total = cube?.total ?? empty, flow = cube ? flowFromCube(cube) : { total, edges: [], models: [] };
  // Default bounds use local days; correction endpoints and scoped grouping stay UTC.
  const components = span ? readSessionCorrectedComponents(ctx, selected, gaps.map(gap => gap.next)) : new Map();
  const includeMetadata = period !== null && range.from <= period.start && range.to >= period.end;
  const runs = sessionRuns(ctx, scope, cube?.rows ?? [], cube ? sessionModelStyles(cube) : new Map(), includeMetadata), compaction = span ? compactions(ctx, scope, selected) : [];
  return boundResponse(ctx, { id, name: dashboardLabel("runName", scope.session.name)!, project: dashboardLabel("project", scope.session.project), span, range, billingMonth, total,
    stats: { runs: runs.length, ownCalls: own.length, compaction: compaction.reduce((n, event) => n + event.value.calls, 0), idleGaps: gaps.length }, runs,
    ownCallBins: span ? ownBins(ctx, selected, own, activePeriods) : [], compaction,
    idleGaps: gaps.map(gap => ({ start: gap.start, end: gap.end, cacheWriteCredits: components.get(gap.next)?.cacheWriteCredits ?? null })),
    activePeriods, models: cube ? modelRows(cube) : [], flow, detailsBinned: false });
}

export function sessionRoute(id: string): DashboardRoute {
  if (!supportedDetailId(id)) invalidQuery();
  return { path: `/api/session/${id}`, handle: (ctx, params) => {
    validateParams(params, ["tz", "from", "to"]);
    if (params.has("from") !== params.has("to")) invalidQuery();
    let range: SessionRange | undefined;
    if (params.has("from")) {
      const from = params.get("from")!, to = params.get("to")!;
      if (!/^\d+$/.test(from) || !/^\d+$/.test(to)) invalidQuery();
      range = { from: Number(from), to: Number(to) };
    }
    return querySession(ctx, id, params.get("tz") ?? "UTC", range);
  } };
}

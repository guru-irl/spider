import { createHash } from "node:crypto";
import { DashboardQueryError, type CalibrationResult, type CompositionAvailability,
  type DashboardQueryContext, type DashboardRoute, type Page, type SeriesPoint, type Slice, type UsageMeasure } from "./dashboard-contract.js";
import { compileSlice, decodeCursor, encodeCursor, invalidQuery, measureSelectionProjection, measureColumns, resolveMeasure,
  validatePage, validateSlice, parsePage, parseSlice, validateParams, type MeasureRow } from "./dashboard-selection.js";
import { dashboardKey, dashboardLabel, initializeIds, opaqueId, supportedDetailId } from "./dashboard-identities.js";
import { countedUsageSql, selectionCtes, storedSelection } from "./schema.js";

export type DetailQuery = { kind: "session" | "run"; id: string; slice: Slice; page: { limit: number; cursor?: string } };
export type DetailPath = { key: string; label: string };
export type DetailCall = {
  id: string; ts: number; sessionId: string | null; runId: string | null;
  project: DetailPath | null; repo: DetailPath | null;
  actor: string; role: string | null; agent: string | null; runName: string | null; phase: string | null;
  parentRunId: string | null; auxPurpose: string | null; provider: string | null; model: string | null;
  requestedModel: string | null; thinking: string | null; api: string | null;
  latencyMs: number | null; aggregate: boolean; measure: UsageMeasure;
};
export type DetailRelationship = "child" | "parent" | "run" | "reporting-session" | "transcript-session";
export type DetailLink = { kind: "session" | "run"; id: string | null; relationship: DetailRelationship; label: string; ongoing: boolean };
export type DetailAccounting = {
  status: "covered" | "replaced" | "aggregate" | "selected" | "no-selected-calls";
  coveringRunId: string | null; message: string;
};
export type DetailData = {
  kind: "session" | "run"; id: string; calibration: CalibrationResult; totals: UsageMeasure;
  timeline: readonly SeriesPoint[]; calls: Page<DetailCall>; links: Page<DetailLink>; accounting: DetailAccounting;
  contextFillPercent: null; contextFillMessage: "Context fill unavailable: historical window not recorded";
  composition: CompositionAvailability; carry: CompositionAvailability; itemReuse: CompositionAvailability;
};

const publicId = (value: string | null): string | null => supportedDetailId(value) ? value : null;
const registered = new WeakSet<DashboardQueryContext["db"]["raw"]>();
type BucketRow = MeasureRow & { bucket: number };
type DetailMemo = { hashes: Map<string, string>; buckets?: BucketRow[] };
type DetailMemoState = { revision: string; selections: Map<string, DetailMemo>; active?: DetailMemo };
const detailMemos = new WeakMap<DashboardQueryContext["db"]["raw"], DetailMemoState>();
function selectionMemo(ctx: DashboardQueryContext, query: DetailQuery): DetailMemo {
  let state = detailMemos.get(ctx.db.raw);
  if (!state || state.revision !== ctx.revision) {
    state = { revision: ctx.revision, selections: new Map() };
    detailMemos.set(ctx.db.raw, state);
  }
  const key = JSON.stringify([query.kind, query.id, query.slice]);
  const memo = state.selections.get(key) ?? { hashes: new Map<string, string>() };
  state.selections.delete(key); // Refresh on every hit, not just insertion.
  state.selections.set(key, memo);
  if (state.selections.size > 8) state.selections.delete(state.selections.keys().next().value!);
  return memo;
}
function registerKeys(ctx: DashboardQueryContext): void {
  initializeIds(ctx);
  if (registered.has(ctx.db.raw)) return;
  ctx.db.raw.function("dashboard_call_key", { deterministic: true }, value => {
    if (typeof value !== "string") return null;
    const hashes = detailMemos.get(ctx.db.raw)?.active?.hashes;
    const cached = hashes?.get(value);
    if (cached) return cached;
    const key = createHash("sha256").update(JSON.stringify(["call", value])).digest("hex");
    if (hashes && value.length <= 128) {
      // Eight selections retain at most 8192 short ids + SHA-256 strings.
      // At roughly 600 bytes/entry this is about 5 MB, leaving room for buckets
      // below a roughly 10 MB per-connection memo budget. Long ids are uncached.
      if (hashes.size >= 1024) hashes.delete(hashes.keys().next().value!);
      hashes.set(value, key);
    }
    return key;
  });
  registered.add(ctx.db.raw);
}
function validateDetail(query: DetailQuery): void {
  if (!query || (query.kind !== "session" && query.kind !== "run") || !supportedDetailId(query.id)) invalidQuery();
  validatePage(query.page);
}
function validateDetailSlice(query: DetailQuery): void {
  validateSlice(query.slice);
  for (const filter of query.slice.filters) {
    if (filter && (filter.field === "project" || filter.field === "repo") && filter.kind !== "missing" &&
      (filter.kind !== "id" || !opaqueId(filter.value))) invalidQuery();
  }
}
function compileDetail(ctx: DashboardQueryContext, query: DetailQuery): ReturnType<typeof compileSlice> {
  validateDetail(query);
  validateDetailSlice(query);
  return compileSlice(query.slice, query.kind === "session" ? { sessionId: query.id } : { runId: query.id }, ctx, true);
}
function cursorKey(ctx: DashboardQueryContext, query: DetailQuery, endpoint: string): readonly (string | number | null)[] | undefined {
  return query.page.cursor === undefined ? undefined : decodeCursor(query.page.cursor, endpoint, ctx.revision,
    { kind: query.kind, id: query.id, slice: query.slice, limit: query.page.limit });
}
type Identity = { found: number; coveringRunId: string | null; hasReport: number; hasNative: number };
function requireIdentity(ctx: DashboardQueryContext, query: DetailQuery): Identity {
  const session = query.kind === "session";
  const row = ctx.db.prepare(`${session ? "" : `WITH RECURSIVE ${selectionCtes}`}
    SELECT EXISTS(SELECT 1 FROM calls INDEXED BY ${session ? "calls_session_read" : "calls_run_detail"}
      WHERE ${session ? "session_id" : "run_id"}=? LIMIT 1) OR EXISTS(SELECT 1 FROM runs_meta INDEXED BY ${session ? "runs_meta_session" : "runs_meta_id"}
      WHERE ${session ? "session_id" : "id"}=? LIMIT 1) AS found,
    ${session ? "NULL AS coveringRunId, 0 AS hasReport, 0 AS hasNative" : `
      (SELECT proof.root FROM coverage proof JOIN selected_reports selected ON selected.id=proof.root
        WHERE proof.id=? AND proof.root!=? ORDER BY proof.root LIMIT 1) AS coveringRunId,
      EXISTS(SELECT 1 FROM calls INDEXED BY calls_run_detail WHERE run_id=? AND is_report=1) AS hasReport,
      EXISTS(SELECT 1 FROM calls INDEXED BY calls_run_detail WHERE run_id=? AND is_report=0 AND copied=0 AND source_kind='transcript') AS hasNative`}`)
    .get(query.id, query.id, ...(session ? [] : [query.id, query.id, query.id, query.id])) as Identity;
  if (!row.found) throw new DashboardQueryError("not-found");
  return row;
}
function accounting(identity: Identity, totals: UsageMeasure): DetailAccounting {
  if (identity.coveringRunId !== null) return { status: "covered", coveringRunId: publicId(identity.coveringRunId),
    message: "Usage is included in the selected covering run report; this is not priced zero." };
  if (identity.hasReport && identity.hasNative) return { status: "replaced", coveringRunId: null,
    message: "Native child transcript detail replaces the reporting-session aggregate globally, including outside this period." };
  if (totals.aggregateCalls) return { status: "aggregate", coveringRunId: null,
    message: "Selected aggregate report usage is counted; per-call child transcript detail is unavailable." };
  return { status: totals.calls ? "selected" : "no-selected-calls", coveringRunId: null,
    message: totals.calls ? "Only globally selected representations are counted; unpriced calls keep unknown AIC." :
      "No selected calls match this slice. Missing or suppressed usage is not priced zero." };
}
type CallResult = MeasureRow & {
  call_key: string; ts: number; session_id: string | null; run_id: string | null; project: string | null; repo: string | null;
  actor: string; role: string | null; agent: string | null; run_name: string | null; phase: string | null;
  parent_run_id: string | null; aux_purpose: string | null; provider: string | null; model: string | null;
  requested_model: string | null; thinking: string | null; api: string | null; latency_ms: number | null; aggregate: number;
};
const detailSelectionProjection = `${measureSelectionProjection},${["id", "ts", "session_id", "project", "repo", "actor", "role",
  "agent", "run_name", "phase", "parent_run_id", "aux_purpose", "provider", "model", "requested_model", "thinking", "api", "latency_ms"]
  .map(column => `c.${column}`).join(",")}`;
export function queryDetail(ctx: DashboardQueryContext, query: DetailQuery): DetailData {
  validateDetail(query);
  const key = cursorKey(ctx, query, "detail-calls");
  if (key && (key.length !== 2 || typeof key[0] !== "number" || !Number.isSafeInteger(key[0]) ||
    key[0] < query.slice.start || key[0] >= query.slice.end || typeof key[1] !== "string" || !/^[a-f0-9]{64}$/.test(key[1]))) invalidQuery();
  const compiled = compileDetail(ctx, query);
  registerKeys(ctx);
  const identity = requireIdentity(ctx, query);
  const { calibration, measure } = resolveMeasure(ctx, query.slice);
  const counted = countedUsageSql(compiled.sql, detailSelectionProjection,
    query.kind === "session" ? "calls_session_read" : undefined, storedSelection(ctx.db));
  const width = Math.max(1, Math.ceil((query.slice.end - query.slice.start) / 200));
  const callColumns = ["call_key", "ts", "session_id", "run_id", "project", "repo", "actor", "role", "agent", "run_name", "phase",
    "parent_run_id", "aux_purpose", "provider", "model", "requested_model", "thinking", "api", "latency_ms", "aggregate"];
  const memo = selectionMemo(ctx, query);
  const state = detailMemos.get(ctx.db.raw)!;
  const coldTimeline = memo.buckets === undefined;
  // One counted pass per page. Later pages reuse hashes and omit bucket work.
  state.active = memo;
  let results: (CallResult & { branch: "totals" | "bucket" | "call"; bucket: number | null })[];
  try { results = ctx.db.prepare(`WITH counted AS MATERIALIZED (
    SELECT ${detailSelectionProjection}, c.possible_overlap, c.possible_undercount, dashboard_call_key(c.id) AS call_key
    FROM (${counted}) c),
    paged AS MATERIALIZED (SELECT * FROM counted ${key ? "WHERE (ts,call_key) > (?,?)" : ""} ORDER BY ts,call_key LIMIT ?)
    SELECT 'totals' AS branch, NULL AS bucket, ${measureColumns}, ${callColumns.map(c => `NULL AS ${c}`).join(",")} FROM counted
    ${coldTimeline ? `UNION ALL SELECT 'bucket', CAST((ts - ?) / ? AS INTEGER) AS bucket, ${measureColumns}, ${callColumns.map(() => "NULL").join(",")}
      FROM counted GROUP BY bucket` : ""}
    UNION ALL SELECT 'call', NULL, ${measureColumns}, ${callColumns.join(",")}
      FROM paged GROUP BY call_key
    ORDER BY branch,bucket,ts,call_key`).all(...compiled.params, ...(key ?? []), query.page.limit + 1,
      ...(coldTimeline ? [query.slice.start, width] : [])) as typeof results;
  } finally { state.active = undefined; }
  if (coldTimeline) memo.buckets = results.filter(row => row.branch === "bucket") as BucketRow[];
  const rows = results.filter(row => row.branch === "call");
  const selected = rows.slice(0, query.page.limit);
  const last = selected.at(-1);
  const calls: Page<DetailCall> = {
    rows: selected.map(row => ({ id: row.call_key, ts: row.ts, sessionId: publicId(row.session_id), runId: publicId(row.run_id),
      project: row.project === null ? null : { key: dashboardKey(ctx, "project", row.project)!, label: dashboardLabel("project", row.project)! },
      repo: row.repo === null ? null : { key: dashboardKey(ctx, "repo", row.repo)!, label: dashboardLabel("repo", row.repo)! },
      actor: row.actor, role: dashboardLabel("role", row.role), agent: dashboardLabel("agent", row.agent), runName: dashboardLabel("runName", row.run_name), phase: dashboardLabel("phase", row.phase),
      parentRunId: publicId(row.parent_run_id), auxPurpose: dashboardLabel("auxPurpose", row.aux_purpose), provider: dashboardLabel("provider", row.provider), model: dashboardLabel("model", row.model),
      requestedModel: dashboardLabel("requestedModel", row.requested_model), thinking: dashboardLabel("thinking", row.thinking), api: dashboardLabel("api", row.api),
      latencyMs: row.latency_ms, aggregate: Boolean(row.aggregate), measure: measure(row) })),
    nextCursor: rows.length > query.page.limit && last ? encodeCursor("detail-calls", ctx.revision,
      { kind: query.kind, id: query.id, slice: query.slice, limit: query.page.limit }, [last.ts, last.call_key]) : null,
  };
  const availability = ctx.composition.availability({ ...query.slice, ...(query.kind === "session" ? { sessionId: query.id } : { runId: query.id }) });
  const totals = measure(results.find(row => row.branch === "totals")!);
  return { kind: query.kind, id: query.id, calibration, totals, accounting: accounting(identity, totals),
    timeline: memo.buckets!.map(row => {
      const start = query.slice.start + row.bucket! * width;
      return { start, end: Math.min(query.slice.end, start + width), label: new Date(start).toISOString(), measure: measure(row) };
    }), calls, links: readLinks(ctx, { ...query, page: { limit: query.page.limit } }), contextFillPercent: null,
    contextFillMessage: "Context fill unavailable: historical window not recorded", composition: availability, carry: availability, itemReuse: availability };
}

function linkCursorKey(ctx: DashboardQueryContext, query: DetailQuery): readonly (string | number | null)[] | undefined {
  const key = cursorKey(ctx, query, "detail-links");
  const relationships = ["child", "parent", "run", "reporting-session", "transcript-session"];
  if (key && (key.length !== 3 || !relationships.includes(key[0] as string) ||
    (key[1] !== "session" && key[1] !== "run") || typeof key[2] !== "number" || !Number.isSafeInteger(key[2]) || key[2] < 1)) invalidQuery();
  return key;
}
function readLinks(ctx: DashboardQueryContext, query: DetailQuery): Page<DetailLink> {
  const key = linkCursorKey(ctx, query);
  const session = query.kind === "session";
  const rows = ctx.db.prepare(`WITH RECURSIVE
    linked(id) AS (
      SELECT id FROM runs_meta INDEXED BY ${session ? "runs_meta_session" : "runs_meta_parent"} WHERE ${session ? "session_id" : "parent_run_id"}=?
      UNION SELECT r.id FROM linked parent JOIN runs_meta r INDEXED BY runs_meta_parent ON r.parent_run_id=parent.id
    ),
    ${session ? "" : "own AS MATERIALIZED (SELECT * FROM runs_meta INDEXED BY runs_meta_id WHERE id=? ORDER BY db_path LIMIT 1),"}
    candidates(kind,id,relationship) AS (
      SELECT 'run',id,'child' FROM linked ${session ? "" : "WHERE id!=?"}
      ${session ? `UNION SELECT 'run',run_id,'run' FROM calls INDEXED BY calls_session_read
        WHERE session_id=? AND run_id IS NOT NULL AND is_report=0 AND copied=0 AND source_kind='transcript'` : `
        UNION SELECT 'run',parent_run_id,'parent' FROM own WHERE parent_run_id IS NOT NULL AND parent_run_id!=?
        UNION SELECT 'session',session_id,'reporting-session' FROM own WHERE session_id IS NOT NULL
        UNION SELECT 'session',session_id,'reporting-session' FROM calls INDEXED BY calls_run_detail
          WHERE run_id=? AND is_report=1 AND copied=0 AND session_id IS NOT NULL AND (SELECT session_id FROM own) IS NULL
        UNION SELECT 'session',session_id,'transcript-session' FROM calls INDEXED BY calls_native_sources
          WHERE run_id=? AND is_report=0 AND copied=0 AND source_kind='transcript' AND session_id IS NOT NULL`}
    ),
    ranked AS MATERIALIZED (SELECT *, ROW_NUMBER() OVER (ORDER BY relationship,kind,id) AS link_order FROM candidates)
    SELECT kind, explorer_id(kind,id) AS id, relationship, link_order,
      CASE WHEN explorer_id(kind,id) IS NULL THEN 'unsupported id'
        WHEN kind='run' THEN COALESCE((SELECT name FROM runs_meta INDEXED BY runs_meta_id WHERE id=c.id ORDER BY db_path LIMIT 1),id) ELSE id END AS label,
      CASE WHEN kind='run' THEN EXISTS(SELECT 1 FROM runs_meta INDEXED BY runs_meta_id
        WHERE id=c.id AND ended_at IS NULL AND db_path=(SELECT MIN(db_path) FROM runs_meta INDEXED BY runs_meta_id WHERE id=c.id)) ELSE 0 END AS ongoing
    FROM ranked c ${key ? "WHERE (relationship,kind,link_order) > (?,?,?)" : ""}
    ORDER BY relationship,kind,link_order LIMIT ?`)
    .all(query.id, query.id, ...(session ? [] : [query.id, query.id, query.id, query.id]), ...(key ?? []), query.page.limit + 1) as
    { kind: DetailLink["kind"]; id: string | null; relationship: DetailRelationship; label: string; ongoing: number; link_order: number }[];
  const selected = rows.slice(0, query.page.limit), last = selected.at(-1);
  return { rows: selected.map(row => ({ kind: row.kind, id: row.id, relationship: row.relationship,
      label: row.id === null ? "unsupported id" : dashboardLabel(row.kind === "run" ? "runName" : "session", row.label)!, ongoing: Boolean(row.ongoing) })),
    nextCursor: rows.length > query.page.limit && last ? encodeCursor("detail-links", ctx.revision,
      { kind: query.kind, id: query.id, slice: query.slice, limit: query.page.limit }, [last.relationship, last.kind, last.link_order]) : null };
}
export function queryDetailLinks(ctx: DashboardQueryContext, query: DetailQuery): DetailData["links"] {
  validateDetail(query);
  // Reject the cursor before any SELECT, including id resolution and existence probes.
  linkCursorKey(ctx, query);
  validateDetailSlice(query);
  registerKeys(ctx);
  requireIdentity(ctx, query);
  return readLinks(ctx, query);
}

function parseDetailQuery(ctx: DashboardQueryContext, params: URLSearchParams): DetailQuery {
  validateParams(params, ["kind", "id", "start", "end", "filters", "limit", "cursor"]);
  const kind = params.get("kind"), id = params.get("id");
  if ((kind !== "session" && kind !== "run") || !supportedDetailId(id)) invalidQuery();
  const base = new URLSearchParams(params);
  for (const name of ["kind", "id", "limit", "cursor"]) base.delete(name);
  return { kind, id, slice: parseSlice(base, ctx.now()), page: parsePage(params) };
}
export const DETAIL_ROUTES: readonly DashboardRoute[] = [
  { path: "/api/detail", handle: (ctx, params) => queryDetail(ctx, parseDetailQuery(ctx, params)) },
  { path: "/api/detail-links", handle: (ctx, params) => queryDetailLinks(ctx, parseDetailQuery(ctx, params)) },
];

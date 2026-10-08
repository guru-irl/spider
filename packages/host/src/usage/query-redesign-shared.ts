import type { CalibrationResult, DashboardQueryContext, Period } from "./dashboard-contract.js";
import type { Bucket, FlowData, FlowRole, ModelRow, ModelStyle, RangeQuery, Role, SessionRow, Value } from "./dashboard-v4-contract.js";
import { shortSessionName } from "./session-name.js";
import { dashboardLabel, supportedDetailId } from "./dashboard-identities.js";
import { DAY_MS, invalidQuery, safeTimestamp } from "./dashboard-selection.js";
import { countedUsageSql, selectedPredicate, selectionCtes, storedSelection } from "./schema.js";
import { timeBuckets, normalizeTimeZone } from "./time-buckets.js";

export const UNATTRIBUTED_SESSION_ID = "unattributed-runs";
export type UsageCube = { total: Value; selectedTotal: Value; buckets: readonly Bucket[];
  rows: readonly { bucketKey: number; sessionId: string | null; runId: string | null; role: FlowRole; model: string; value: Value }[] };
type Session = { id: string; owner: string | null; name: string; project: string | null; lastActive: number | null };
type Run = { id: string; session: string | null; parent: string | null; role: string | null };
type Ownership = { sessions: Map<string, Session>; runs: Map<string, Run[]>; humans: Set<string>; childRuns: Map<string, Set<string>>; loaded: Set<string> };
const ownershipCache = new WeakMap<DashboardQueryContext["db"], { revision: string; value: Ownership }>();
function ownership(ctx: DashboardQueryContext, candidates: readonly string[] = []): Ownership {
  let cached = ownershipCache.get(ctx.db);
  if (cached?.revision !== ctx.revision) {
    const sessions = new Map((ctx.db.prepare("SELECT id,owner_session_id AS owner,name,project,last_activity AS lastActive FROM sessions").all() as Session[]).map(s => [s.id, s]));
    const runs = new Map<string, Run[]>();
    for (const row of ctx.db.prepare("SELECT id,session_id AS session,parent_run_id AS parent,role FROM runs_meta").all() as Run[]) {
      const list = runs.get(row.id) ?? []; list.push(row); runs.set(row.id, list);
    }
    cached = { revision: ctx.revision, value: { sessions, runs, humans: new Set(), childRuns: new Map(), loaded: new Set() } };
    ownershipCache.set(ctx.db, cached);
  }
  const data = cached.value;
  // Private metadata can point beyond the visible range. Batch identity-indexed
  // evidence, never walk all historical calls or issue one query per owner.
  const ids = [...new Set([...candidates, ...data.sessions.keys(), ...[...data.sessions.values()].flatMap(s => s.owner === null ? [] : [s.owner]), ...[...data.runs.values()].flatMap(rows => rows.flatMap(r => r.session === null ? [] : [r.session]))])]
    .filter(id => !data.loaded.has(id));
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200), json = JSON.stringify(chunk);
    const own = ctx.db.prepare(`WITH RECURSIVE ${selectionCtes} SELECT DISTINCT c.session_id AS id FROM calls c INDEXED BY calls_session_read
      WHERE c.session_id IN (SELECT value FROM json_each(?)) AND c.run_id IS NULL AND c.copied=0 AND c.source_kind='transcript'
        AND c.actor IN ('parent','compaction','aux','warmer') AND ${selectedPredicate("c", storedSelection(ctx.db))}`).all(json) as { id: string }[];
    const nativeHumans = new Set(own.map(row => row.id));
    for (const id of chunk) {
      if (data.sessions.get(id)?.owner === null || (!data.sessions.has(id) && nativeHumans.has(id))) data.humans.add(id);
      data.loaded.add(id);
    }
    const children = ctx.db.prepare(`SELECT DISTINCT session_id AS session,run_id AS run FROM calls INDEXED BY calls_session_read
      WHERE session_id IN (SELECT value FROM json_each(?)) AND run_id IS NOT NULL AND copied=0 AND source_kind='transcript'`).all(json) as {session: string; run: string}[];
    for (const row of children) {
      const runs = data.childRuns.get(row.session) ?? new Set<string>(); runs.add(row.run); data.childRuns.set(row.session, runs);
      if (!nativeHumans.has(row.session)) data.humans.delete(row.session);
    }
  }
  return data;
}
function ownerFrom(data: Ownership, sessionId: string | null, runId: string | null): string | null {
  const walk = (kind: "s" | "r", id: string, seen: Set<string>): string | null => {
    const key = `${kind}:${id}`; if (seen.has(key)) return null;
    const next = new Set(seen); next.add(key);
    if (kind === "s") {
      const row = data.sessions.get(id);
      if (row?.owner !== undefined && row.owner !== null) return walk("s", row.owner, next);
      if (data.humans.has(id)) return id;
      const child = data.childRuns.get(id);
      return child?.size === 1 ? walk("r", [...child][0]!, next) : null;
    }
    const rows = data.runs.get(id); if (!rows?.length) return null;
    // Duplicate ids are only usable when all private databases agree on attribution.
    if (new Set(rows.map(r => JSON.stringify([r.session, r.parent]))).size !== 1) return null;
    const row = rows[0]!, candidates: (string | null)[] = [];
    if (row.parent) candidates.push(walk("r", row.parent, next));
    if (row.session) candidates.push(walk("s", row.session, next));
    // A child header can refer to its own run. Ignore that self-evidence if a
    // proven parent resolves; conflicting resolved evidence still fails closed.
    const resolved = new Set(candidates.filter((v): v is string => v !== null));
    return resolved.size === 1 ? [...resolved][0]! : null;
  };
  if (runId !== null) {
    const checked = new Set<string>();
    let ancestor: string | null = runId;
    while (ancestor !== null) {
      if (checked.has(ancestor)) return null;
      checked.add(ancestor);
      const evidence = data.runs.get(ancestor);
      if (!evidence?.length) break;
      if (new Set(evidence.map(r=>JSON.stringify([r.session,r.parent]))).size !== 1) return null;
      ancestor = evidence[0]!.parent;
    }
    const owner = walk("r", runId, new Set());
    if (owner !== null) return owner;
    // Known cyclic/ambiguous run evidence must not be repaired by an arbitrary call id.
    if (data.runs.has(runId)) return null;
  }
  return sessionId === null ? null : walk("s", sessionId, new Set());
}
/** Request-local Session ownership. Prime all missing transcript identities in
 * bounded batches before any per-row resolver walk. Native-human evidence uses
 * EXISTS so an unrelated long human transcript costs one indexed hit, not a scan.
 * Keep the legacy revision cache and its callers unchanged. */
export function sessionOwnerResolver(ctx: DashboardQueryContext, candidates: readonly string[]): (sessionId: string | null, runId: string | null) => string | null {
  const sessions = new Map((ctx.db.prepare("SELECT id,owner_session_id AS owner,name,project,last_activity AS lastActive FROM sessions").all() as Session[]).map(row => [row.id, row]));
  const runs = new Map<string, Run[]>();
  for (const row of ctx.db.prepare("SELECT id,session_id AS session,parent_run_id AS parent,role FROM runs_meta").all() as Run[]) {
    const list = runs.get(row.id) ?? []; list.push(row); runs.set(row.id, list);
  }
  const data: Ownership = { sessions, runs, humans: new Set(), childRuns: new Map(), loaded: new Set() };
  const ids = [...new Set([...candidates, ...sessions.keys(), ...[...sessions.values()].flatMap(s => s.owner === null ? [] : [s.owner]), ...[...runs.values()].flatMap(rows => rows.flatMap(r => r.session === null ? [] : [r.session]))])]
    .filter(id => !sessions.has(id) || sessions.get(id)!.owner === null);
  const canonical = storedSelection(ctx.db) ? "c.selection_shadowed = 0" : `NOT EXISTS (SELECT 1 FROM calls prior WHERE prior.fingerprint=c.fingerprint
    AND (prior.copied,prior.source_file,prior.entry_id,prior.id)<(c.copied,c.source_file,c.entry_id,c.id))`;
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    const evidence = ctx.db.prepare(`SELECT value AS id,EXISTS(SELECT 1 FROM calls c INDEXED BY calls_session_read
      WHERE c.session_id=value AND c.run_id IS NULL AND c.copied=0 AND c.source_kind='transcript'
        AND c.actor IN ('parent','compaction','aux','warmer') AND ${canonical}) AS own FROM json_each(?)`).all(JSON.stringify(chunk)) as { id: string; own: number }[];
    for (const row of evidence) if (row.own || sessions.get(row.id)?.owner === null) data.humans.add(row.id);
    const missing = evidence.filter(row => !row.own).map(row => row.id);
    if (!missing.length) continue;
    const children = ctx.db.prepare(`SELECT DISTINCT session_id AS session,run_id AS run FROM calls INDEXED BY calls_session_read
      WHERE session_id IN (SELECT value FROM json_each(?)) AND run_id IS NOT NULL AND copied=0 AND source_kind='transcript'`).all(JSON.stringify(missing)) as { session: string; run: string }[];
    for (const row of children) {
      const children = data.childRuns.get(row.session) ?? new Set<string>(); children.add(row.run); data.childRuns.set(row.session, children);
      data.humans.delete(row.session);
    }
  }
  return (sessionId, runId) => ownerFrom(data, sessionId, runId);
}

export type SessionUsageScope = { ownerId: string | null; sql: string; bindings: { sessions: string; runs: string }; owns(row: { sessionId: string | null; runId: string | null }): boolean };
/** Canonical selection stays global in meaning, but only the connected coverage
 * component of the candidate runs is read. Ancestors outside this Session still
 * suppress covered detail; unrelated reports and calls are never materialized. */
export function sessionCandidatesSql(ctx: DashboardQueryContext, columns: string, unattributed: boolean, byId = false): string {
  const raw = byId ? `SELECT ${columns} FROM calls c WHERE c.id IN (SELECT value FROM json_each(@ids))`
    : `SELECT ${columns} FROM calls c INDEXED BY calls_session_read WHERE c.session_id IN (SELECT value FROM json_each(@sessions))
      UNION ALL SELECT ${columns} FROM calls c INDEXED BY calls_run_detail WHERE c.run_id IN (SELECT value FROM json_each(@runs))
        AND (c.session_id IS NULL OR c.session_id NOT IN (SELECT value FROM json_each(@sessions)))
      ${unattributed ? `UNION ALL SELECT ${columns} FROM calls c INDEXED BY calls_session_read WHERE c.session_id IS NULL AND c.run_id IS NULL` : ""}`;
  const selection = selectionCtes.replace("WHERE r.is_report = 1", "WHERE r.run_id IN (SELECT id FROM relevant_runs) AND r.is_report = 1")
    .replace("SELECT parent, child FROM usage_run_edges", "SELECT parent, child FROM usage_run_edges WHERE parent IN (SELECT id FROM relevant_runs)");
  return `WITH RECURSIVE raw_session_candidates AS MATERIALIZED (${raw}),
    relevant_runs(id) AS (SELECT DISTINCT run_id FROM raw_session_candidates WHERE run_id IS NOT NULL
      UNION SELECT e.report_run_id FROM relevant_runs r JOIN coverage_edges e ON e.included_run_id=r.id WHERE e.evidence IN ('transcript','runs-db')
      UNION SELECT e.included_run_id FROM relevant_runs r JOIN coverage_edges e ON e.report_run_id=r.id WHERE e.evidence IN ('transcript','runs-db')),
    ${selection}, session_candidates AS MATERIALIZED (
      SELECT c.* FROM raw_session_candidates c WHERE ${selectedPredicate("c", storedSelection(ctx.db))})`;
}

const nullableSum = (values: readonly (number | null)[]): number | null => {
  const known = values.filter((v): v is number => v !== null); return known.length ? known.reduce((a,b) => a+b, 0) : null;
};
export function sumValues(values: readonly Value[]): Value {
  const sum = (key: "input" | "cacheRead" | "cacheWrite" | "output") => values.reduce((n,v) => n+v.tokens[key],0);
  const input=sum("input"), cacheRead=sum("cacheRead"), cacheWrite=sum("cacheWrite"), output=sum("output"), prompt=input+cacheRead+cacheWrite;
  return { credits: nullableSum(values.map(v=>v.credits)), calls: values.reduce((n,v)=>n+v.calls,0), unpricedCalls: values.reduce((n,v)=>n+v.unpricedCalls,0),
    tokens: { input,cacheRead,cacheWrite,output,prompt,total:prompt+output,
      cacheWrite1h: nullableSum(values.map(v=>v.tokens.cacheWrite1h)), reasoning: nullableSum(values.map(v=>v.tokens.reasoning)) } };
}

/** Fit each UTC piece independently. No batch crosses the engine's endpoint/span caps. */
export function readCorrectionDays(ctx: DashboardQueryContext, ends: readonly number[]): Map<number, { factor: number; basis: "published-only" | "back-applied" | "calibrated" }> {
  const points = [...new Set(ends.map(end=>Math.max(0,Math.min(end,ctx.now())-1)))].sort((a,b)=>a-b);
  const fits = new Map<number,CalibrationResult>();
  const batch = (keys: readonly number[]) => {
    for(let i=0;i<keys.length;) {
      let j=i+1; while(j<keys.length && j-i<200 && keys[j]!-keys[i]!<=366*DAY_MS) j++;
      const group=keys.slice(i,j), result=ctx.calibration.atMany(group,ctx.calibrationMode);
      group.forEach((point,k)=>fits.set(point,result[k]!)); i=j;
    }
  };
  batch(points);
  const earliest = ctx.calibrationMode === "off" ? null : ctx.calibration.earliest(ctx.calibrationMode);
  const unavailable = ctx.status().counter.availability === "unavailable";
  // Retain the latest accepted fit during a counter outage. The acceptance
  // algorithm is unchanged; evaluate its own historical observation endpoints.
  if(unavailable && points.length && ctx.calibrationMode !== "off") {
    const endpoints=(ctx.db.prepare("SELECT DISTINCT ts FROM counter_snapshots INDEXED BY counter_snapshots_ts WHERE ts>=0 AND ts<=? ORDER BY ts").all(points.at(-1)!) as {ts:number}[]).map(r=>r.ts);
    batch(endpoints.filter(p=>!fits.has(p)));
  }
  const accepted=[...fits.entries()].filter(([,f])=>f.status==="calibrated" && f.factor!==null).sort(([a],[b])=>a-b);
  if(earliest?.status==="calibrated" && earliest.windowEnd!==null) accepted.push([earliest.windowEnd,earliest]);
  accepted.sort(([a],[b])=>a-b);
  let cursor=0, last: CalibrationResult | null=null;
  const result = new Map<number,{ factor: number; basis: "published-only" | "back-applied" | "calibrated" }>();
  for(const point of points) {
    while(cursor<accepted.length && accepted[cursor]![0]<=point) last=accepted[cursor++]![1];
    const fit=fits.get(point)!;
    let factor=fit.status==="calibrated" ? fit.factor : null;
    let basis: "published-only" | "back-applied" | "calibrated" = factor === null ? "published-only" : "calibrated";
    if(factor===null && earliest?.status==="calibrated" && earliest.windowEnd!==null && point<earliest.windowEnd) { factor=earliest.factor; basis="back-applied"; }
    if(factor===null && unavailable) factor=last?.factor ?? null;
    result.set(point,{ factor: factor ?? 1, basis });
  }
  return new Map(ends.map(end=>[end,result.get(Math.max(0,Math.min(end,ctx.now())-1))! ]));
}
function factors(ctx: DashboardQueryContext, ends: readonly number[]): Map<number, number> {
  return new Map([...readCorrectionDays(ctx, ends)].map(([end, day]) => [end, day.factor]));
}
/** Total-only UTC-day projection for the footer. No session, role or model
 * resolution is needed; the correction rule is the same as the full cube. */
export function readCorrectedTotal(ctx: DashboardQueryContext, period: Period): number | null {
  if (!safeTimestamp(period.start) || !safeTimestamp(period.end) || period.end < period.start) invalidQuery();
  const rows = ctx.db.prepare(`WITH RECURSIVE ${selectionCtes}
    SELECT CAST(c.ts / ? AS INTEGER) AS day, SUM(c.aic) AS credits
    FROM calls c INDEXED BY calls_period_read
    WHERE c.ts>=? AND c.ts<? AND ${selectedPredicate("c", storedSelection(ctx.db))} GROUP BY day`)
    .all(DAY_MS, period.start, period.end) as { day: number; credits: number | null }[];
  const endpoints = rows.map(row => (row.day + 1) * DAY_MS);
  const correction = factors(ctx, endpoints);
  return nullableSum(rows.map((row, i) => row.credits === null ? null : row.credits * correction.get(endpoints[i]!)!));
}
export { factors as readCorrectionFactors };
type Aggregate = { bucketKey:number; endpoint:number; sessionId:string|null; runId:string|null; actor:string; role:string|null; model:string|null; lastActive:number;
  credits:number|null; calls:number; unpricedCalls:number; input:number; cacheRead:number; cacheWrite:number; output:number; cacheWrite1h:number|null; reasoning:number|null };
const projection = ["ts","session_id","run_id","actor","role","model","aic","input","cache_read","cache_write","output","cache_write_1h","reasoning","price_status"].map(c=>`c.${c}`).join(",");
function valueFrom(row:Aggregate, factor:number):Value {
  const prompt=row.input+row.cacheRead+row.cacheWrite;
  return {credits:row.credits===null ? null : row.credits*factor,calls:row.calls,unpricedCalls:row.unpricedCalls,
    tokens:{input:row.input,cacheRead:row.cacheRead,cacheWrite:row.cacheWrite,output:row.output,cacheWrite1h:row.cacheWrite1h,reasoning:row.reasoning,prompt,total:prompt+row.output}};
}
function flowRole(actor:string, role:string|null):FlowRole {
  if(actor==="compaction") return "compaction";
  if(actor==="aux" || actor==="warmer") return "background";
  if(actor!=="subagent") return "own";
  return role==="worker" ? "workers" : role==="reviewer" ? "reviewers" : role==="scout" ? "scouts" : "other-runs";
}
type CubeContext = { ctx:DashboardQueryContext; selected:Set<number>; activity:Map<string|null,Map<number,number>>; ownership:Ownership; unit:RangeQuery["unit"] };
const cubeContexts = new WeakMap<UsageCube,CubeContext>();
// Optional scope is retained as the differential reference for indexed Session queries.
export function readUsageCube(ctx:DashboardQueryContext, query:RangeQuery, scope?:{sessionId:string}):UsageCube {
  if(!safeTimestamp(query.from) || !safeTimestamp(query.to) || query.to<query.from || (!scope && query.to-query.from>93*DAY_MS)) invalidQuery();
  const tz=normalizeTimeZone(query.tz), size=query.to-query.from<=2*DAY_MS ? "hour":"day";
  const boundaries=timeBuckets({start:query.from,end:query.to},tz,size), data=ownership(ctx);
  const rows:UsageCube["rows"][number][]=[], activity=new Map<string|null,Map<number,number>>();
  // Whole sessions can span years. Keep SQL JSON sets and fitting windows bounded.
  for(let start=query.from;start<query.to;) {
    const end=Math.min(query.to,start+93*DAY_MS);
    const pieces:{key:number;start:number;end:number;endpoint:number}[]=[];
    for(const bucket of boundaries) {
      let at=Math.max(start,bucket.start), stop=Math.min(end,bucket.end);
      while(at<stop) {const next=Math.min(stop,(Math.floor(at/DAY_MS)+1)*DAY_MS);pieces.push({key:bucket.key,start:at,end:next,endpoint:(Math.floor(at/DAY_MS)+1)*DAY_MS});at=next;}
    }
    const grouped=ctx.db.prepare(`WITH counted AS MATERIALIZED (${countedUsageSql("c.ts>=? AND c.ts<?",projection,"calls_period_read",storedSelection(ctx.db))}),
      pieces AS MATERIALIZED (SELECT json_extract(value,'$.key') AS bucketKey,json_extract(value,'$.start') AS start,
        json_extract(value,'$.end') AS end,json_extract(value,'$.endpoint') AS endpoint FROM json_each(?))
      SELECT p.bucketKey,p.endpoint,c.session_id AS sessionId,c.run_id AS runId,c.actor,c.role,c.model,MAX(c.ts) AS lastActive,
        SUM(c.aic) AS credits,COUNT(*) AS calls,SUM(c.price_status='unpriced') AS unpricedCalls,
        SUM(c.input) AS input,SUM(c.cache_read) AS cacheRead,SUM(c.cache_write) AS cacheWrite,SUM(c.output) AS output,
        SUM(c.cache_write_1h) AS cacheWrite1h,SUM(c.reasoning) AS reasoning
      FROM counted c JOIN pieces p ON c.ts>=p.start AND c.ts<p.end
      GROUP BY p.bucketKey,p.endpoint,c.session_id,c.run_id,c.actor,c.role,c.model`).all(start,end,JSON.stringify(pieces)) as Aggregate[];
    ownership(ctx, grouped.flatMap(r=>r.sessionId===null ? [] : [r.sessionId]));
    const correction=factors(ctx,grouped.map(r=>r.endpoint));
    for(const row of grouped) {
      const owner=ownerFrom(data,row.sessionId,row.runId);
      if(scope && (scope.sessionId===UNATTRIBUTED_SESSION_ID ? owner!==null : owner!==scope.sessionId)) continue;
      const metadata=row.runId===null ? undefined : data.runs.get(row.runId);
      const role=row.role ?? (metadata && new Set(metadata.map(r=>r.role)).size===1 ? metadata[0]!.role : null);
      rows.push({bucketKey:row.bucketKey,sessionId:owner,runId:row.runId,role:flowRole(row.actor,role),model:dashboardLabel("model",row.model) ?? "Unknown model",value:valueFrom(row,correction.get(row.endpoint)!)});
      const times=activity.get(owner) ?? new Map<number,number>();
      times.set(row.bucketKey,Math.max(times.get(row.bucketKey)??0,row.lastActive));activity.set(owner,times);
    }
    start=end;
  }
  const keys=new Set(boundaries.map(b=>b.key)), selected=new Set(query.buckets.filter(k=>keys.has(k)));
  const formatter=new Intl.DateTimeFormat("en-GB",{timeZone:tz,day:"numeric",month:"short",...(size==="hour"?{hour:"2-digit",minute:"2-digit",hourCycle:"h23" as const}:{})});
  const buckets=boundaries.map(b=>{
    const bucketRows=rows.filter(r=>r.bucketKey===b.key), models=[...new Set(bucketRows.map(r=>r.model))].sort().map(model=>({model,value:sumValues(bucketRows.filter(r=>r.model===model).map(r=>r.value))}));
    return {...b,label:formatter.format(b.key),total:sumValues(bucketRows.map(r=>r.value)),models};
  });
  const total=sumValues(rows.map(r=>r.value)), selectedTotal=sumValues(rows.filter(r=>!selected.size || selected.has(r.bucketKey)).map(r=>r.value));
  const cube={total,selectedTotal,buckets,rows};cubeContexts.set(cube,{ctx,selected,activity,ownership:data,unit:query.unit});return cube;
}
const sessionCubeStyles = new WeakMap<UsageCube, ReadonlyMap<string, ModelStyle>>();
/** UTC-day aggregates over identity-indexed candidates, without lifetime local
 * buckets or an all-ledger model-style ranking. Only Session uses this entry. */
export function readSessionUsageCube(ctx: DashboardQueryContext, span: Period, scope: SessionUsageScope): UsageCube {
  const rows = (ctx.db.prepare(`${scope.sql} SELECT (CAST(c.ts/${DAY_MS} AS INTEGER)+1)*${DAY_MS} AS endpoint,
    c.session_id AS sessionId,c.run_id AS runId,c.actor,c.role,c.model,MAX(c.ts) AS lastActive,
    SUM(c.aic) AS credits,COUNT(*) AS calls,SUM(c.price_status='unpriced') AS unpricedCalls,
    SUM(c.input) AS input,SUM(c.cache_read) AS cacheRead,SUM(c.cache_write) AS cacheWrite,SUM(c.output) AS output,
    SUM(c.cache_write_1h) AS cacheWrite1h,SUM(c.reasoning) AS reasoning
    FROM session_candidates c GROUP BY endpoint,c.session_id,c.run_id,c.actor,c.role,c.model`).all(scope.bindings) as Aggregate[]).filter(scope.owns);
  const correction = factors(ctx, rows.map(row => row.endpoint));
  const metadata = new Map<string, (string | null)[]>();
  for (const row of ctx.db.prepare("SELECT id,role FROM runs_meta WHERE id IN (SELECT value FROM json_each(?))").all(JSON.stringify([...new Set(rows.flatMap(row => row.runId === null ? [] : [row.runId]))])) as { id: string; role: string | null }[]) {
    const roles = metadata.get(row.id) ?? []; roles.push(row.role); metadata.set(row.id, roles);
  }
  const projected = rows.map(row => {
    const roles = row.runId === null ? [] : metadata.get(row.runId) ?? [];
    return { bucketKey: row.endpoint - DAY_MS, sessionId: scope.ownerId, runId: row.runId,
      role: flowRole(row.actor, row.role ?? (new Set(roles).size === 1 ? roles[0]! : null)),
      model: dashboardLabel("model", row.model) ?? "Unknown model", value: valueFrom(row, correction.get(row.endpoint)!) };
  });
  const total = sumValues(projected.map(row => row.value));
  const cube: UsageCube = { total, selectedTotal: total, buckets: [], rows: projected };
  // Reuse an already-published daily style map when present. A cold Session uses
  // the shared stable-id fallback rather than scanning all historical calls.
  const cached = styleCache.get(ctx.db), styles = new Map<string, ModelStyle>();
  for (const row of projected) {
    let hash = 0; for (const c of row.model) hash = (hash * 31 + c.charCodeAt(0)) >>> 0;
    styles.set(row.model, (cached?.day === Math.floor(ctx.now() / DAY_MS) ? cached.styles.get(row.model) : undefined) ?? style(4 + hash % 100));
  }
  sessionCubeStyles.set(cube, styles);
  return cube;
}
export function sessionModelStyles(cube: UsageCube): ReadonlyMap<string, ModelStyle> { return sessionCubeStyles.get(cube) ?? new Map(); }
/** Scoped component reads keep canonical report selection indexed too. */
export function readSessionCorrectedComponents(ctx: DashboardQueryContext, span: Period, callIds: readonly string[]): ReadonlyMap<string, { cacheWriteCredits: number | null }> {
  const result = new Map<string, { cacheWriteCredits: number | null }>(), unique = [...new Set(callIds)];
  const columns = "c.id,c.ts,c.session_id,c.run_id,c.is_report,c.selection_shadowed,c.fingerprint,c.copied,c.source_file,c.entry_id,c.aic_cache_write";
  for (let i = 0; i < unique.length; i += 200) {
    const sql = sessionCandidatesSql(ctx, columns, false, true);
    const rows = ctx.db.prepare(`${sql} SELECT id,ts,aic_cache_write FROM session_candidates`).all({ ids: JSON.stringify(unique.slice(i, i + 200)) }) as { id: string; ts: number; aic_cache_write: number | null }[];
    const ends = rows.map(row => (Math.floor(row.ts / DAY_MS) + 1) * DAY_MS), correction = factors(ctx, ends);
    rows.forEach((row, j) => result.set(row.id, { cacheWriteCredits: row.aic_cache_write === null ? null : row.aic_cache_write * correction.get(ends[j]!)! }));
  }
  return result;
}
// Global component projection is retained as the differential reference for indexed Session reads.
export function readCorrectedComponents(ctx:DashboardQueryContext, callIds:readonly string[]):ReadonlyMap<string,{cacheWriteCredits:number|null}> {
  const result=new Map<string,{cacheWriteCredits:number|null}>(), unique=[...new Set(callIds)];
  for(let i=0;i<unique.length;i+=200) {
    const ids=JSON.stringify(unique.slice(i,i+200));
    const rows=ctx.db.prepare(countedUsageSql("c.id IN (SELECT value FROM json_each(?))","c.id,c.ts,c.run_id,c.is_report,c.source_file,c.aic_cache_write",undefined,storedSelection(ctx.db))).all(ids) as {id:string;ts:number;aic_cache_write:number|null}[];
    const ends=rows.map(r=>(Math.floor(r.ts/DAY_MS)+1)*DAY_MS), correction=factors(ctx,ends);
    rows.forEach((r,k)=>result.set(r.id,{cacheWriteCredits:r.aic_cache_write===null?null:r.aic_cache_write*correction.get(ends[k]!)!}));
  }
  return result;
}
const palette=["#f8785c","#91c7e5","#8fbf8a","#e5b840","#dca17e","#cbb88e","#c58a73","#a8b7a0"];
const shapes:ModelStyle["shape"][]=["circle","square","triangle","diamond"];
const style=(i:number):ModelStyle=>({color:palette[i] ?? `hsl(${Math.round((i*137.5)%65)} 45% ${60+i%3*5}%)`,shape:shapes[i%4]!});
const styleCache=new WeakMap<DashboardQueryContext["db"],{day:number;styles:Map<string,ModelStyle>}>();
export function modelStyles(ctx:DashboardQueryContext):ReadonlyMap<string,ModelStyle> {
  const day=Math.floor(ctx.now()/DAY_MS), cached=styleCache.get(ctx.db);if(cached?.day===day)return cached.styles;
  const rows=ctx.db.prepare(`WITH RECURSIVE ${selectionCtes} SELECT c.model,SUM(c.aic) AS credits
    FROM calls c INDEXED BY calls_provider_model_ts WHERE ${selectedPredicate("c",storedSelection(ctx.db))}
    GROUP BY c.model ORDER BY credits DESC,c.model`).all() as {model:string|null;credits:number|null}[];
  const styles=new Map(rows.map((r,i)=>[dashboardLabel("model",r.model)??"Unknown model",style(i)]));styleCache.set(ctx.db,{day,styles});return styles;
}
function selectedRows(cube:UsageCube):UsageCube["rows"] {const selected=cubeContexts.get(cube)?.selected;return !selected?.size ? cube.rows:cube.rows.filter(r=>selected.has(r.bucketKey));}
const weight=(value:Value,unit:"credits"|"tokens")=>unit==="tokens" ? value.tokens.total:value.credits??0;
const share=(v:number,total:number)=>total>0 ? v/total:0;
const flowOrder:FlowRole[]=["own","workers","reviewers","scouts","other-runs","compaction","background"];
export function modelRows(cube:UsageCube):readonly ModelRow[] {
  const context=cubeContexts.get(cube), rows=selectedRows(cube), unit=context?.unit??"credits", total=weight(cube.selectedTotal,unit);
  const styles=sessionCubeStyles.get(cube) ?? (context ? modelStyles(context.ctx):new Map<string,ModelStyle>());
  return [...new Set(rows.map(r=>r.model))].map(id=>{
    const parts=rows.filter(r=>r.model===id),value=sumValues(parts.map(r=>r.value));
    const main=flowOrder.map(role=>({role,value:sumValues(parts.filter(r=>r.role===role).map(r=>r.value))})).sort((a,b)=>weight(b.value,unit)-weight(a.value,unit))[0]!;
    const labels:Record<FlowRole,string>={own:"own calls",workers:"worker runs",reviewers:"reviewer runs",scouts:"scout runs","other-runs":"other runs",compaction:"compaction calls",background:"background calls"};
    let hash=0;for(const c of id)hash=(hash*31+c.charCodeAt(0))>>>0;
    return {id,value,share:share(weight(value,unit),total),note:`Mostly ${labels[main.role]}`,style:styles.get(id)??style(4+hash%100)};
  }).sort((a,b)=>weight(b.value,unit)-weight(a.value,unit)||a.id.localeCompare(b.id));
}
export function flowFromCube(cube:UsageCube):FlowData {
  const rows=selectedRows(cube), unit=cubeContexts.get(cube)?.unit??"credits", total=weight(cube.selectedTotal,unit), edges:FlowData["edges"][number][]=[];
  for(const role of flowOrder)for(const model of [...new Set(rows.filter(r=>r.role===role).map(r=>r.model))].sort()) {
    const value=sumValues(rows.filter(r=>r.role===role&&r.model===model).map(r=>r.value));edges.push({role,model,value,share:share(weight(value,unit),total)});
  }
  return {total:cube.selectedTotal,edges,models:modelRows(cube)};
}
const sessionRole=(role:FlowRole):Role=>["own","workers","reviewers"].includes(role)?role as Role:"others";
export function sessionRows(cube:UsageCube):readonly SessionRow[] {
  const rows=selectedRows(cube), context=cubeContexts.get(cube), unit=context?.unit??"credits";
  return [...new Set(rows.map(r=>r.sessionId))].map(id=>{
    const parts=rows.filter(r=>r.sessionId===id),value=sumValues(parts.map(r=>r.value)), metadata=id===null?undefined:context?.ownership.sessions.get(id);
    const runs=new Set(parts.flatMap(r=>r.runId===null?[]:[r.runId])).size;
    const roles=(["own","workers","reviewers","others"] as const).map(role=>{
      const subset=parts.filter(r=>sessionRole(r.role)===role),v=sumValues(subset.map(r=>r.value));
      return {role,value:v,share:share(weight(v,unit),weight(value,unit)),runs:new Set(subset.flatMap(r=>r.runId===null?[]:[r.runId])).size};
    });
    return {id:id===null?UNATTRIBUTED_SESSION_ID:id===UNATTRIBUTED_SESSION_ID||!supportedDetailId(id)?null:id,
      name:id===null?"Unattributed runs":dashboardLabel("runName",metadata?.name??shortSessionName(id))!,project:dashboardLabel("project",metadata?.project??null),
      lastActive:Math.max(0,...[...context?.activity.get(id)??[]].filter(([key])=>!context?.selected.size || context.selected.has(key)).map(([,at])=>at)),value,roles,runs};
  }).sort((a,b)=>weight(b.value,unit)-weight(a.value,unit)||a.name.localeCompare(b.name));
}

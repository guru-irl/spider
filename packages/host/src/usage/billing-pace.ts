import type { Period } from "./dashboard-contract.js";
import type { Pace } from "./dashboard-v4-contract.js";
import type { CounterSnapshot } from "./ledger.js";
import { DAY_MS, safeTimestamp, invalidQuery } from "./dashboard-selection.js";

const nonnegative = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const finite = (value: number): number | null => Number.isFinite(value) ? value : null;
/** The counter reports a NEXT reset calendar date; its time is midnight UTC. */
function resetInstant(value: string | undefined): number | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(value)) return null;
  const date=value.slice(0,10), at=Date.parse(`${date}T00:00:00Z`);
  return safeTimestamp(at) && new Date(at).toISOString().slice(0,10)===date ? at:null;
}
function resetPeriod(snapshot: CounterSnapshot): Period | null {
  const end=resetInstant(snapshot.resetDate);if(end===null)return null;
  const date=new Date(end), year=date.getUTCFullYear(), month=date.getUTCMonth();
  const last=new Date(Date.UTC(year,month,0)).getUTCDate();
  const start=Date.UTC(year,month-1,Math.min(date.getUTCDate(),last));
  return safeTimestamp(start) && start<end ? {start,end}:null;
}
export function billingPeriod(now:number,snapshot:CounterSnapshot|undefined):Period {
  if (!safeTimestamp(now)) invalidQuery();
  const period=snapshot ? resetPeriod(snapshot):null;
  if(period && now>=period.start && now<period.end && safeTimestamp(snapshot!.ts) && snapshot!.ts>=period.start && snapshot!.ts<=now) return period;
  const date=new Date(now), fallback={start:Date.UTC(date.getUTCFullYear(),date.getUTCMonth(),1),end:Date.UTC(date.getUTCFullYear(),date.getUTCMonth()+1,1)};
  if (!safeTimestamp(fallback.start) || !safeTimestamp(fallback.end)) invalidQuery();
  return fallback;
}
const valid = (s:CounterSnapshot) => safeTimestamp(s.ts) && nonnegative(s.creditsUsed) &&
  (s.entitlement===undefined || nonnegative(s.entitlement)) && (s.remaining===undefined || nonnegative(s.remaining));
function canonical(snapshots:readonly CounterSnapshot[]):CounterSnapshot[] {
  const byTime=new Map<number,CounterSnapshot>();
  for(const s of snapshots) {
    const prior=byTime.get(s.ts); if(!prior || valid(s) || !valid(prior))byTime.set(s.ts,s);
  }
  return [...byTime.values()].sort((a,b)=>a.ts-b.ts);
}
/** Pace uses the first and last actual readings in the window. Hour-wide
 * edge tolerances cover polling latency without inventing render-time readings.
 * Account switches, invalid observations and long gaps break the chain. */
export function counterRate(snapshots: readonly CounterSnapshot[], window: Period): number | null {
  if (!safeTimestamp(window.start) || !safeTimestamp(window.end) || window.end <= window.start) return null;
  let rows = canonical(snapshots).filter(s => s.ts >= window.start && s.ts <= window.end);
  if (rows.length < 2) return null;
  const latest = rows.at(-1)!, period = resetPeriod(latest);
  if (!valid(latest) || !latest.accountLogin || !period || latest.ts < period.start || latest.ts >= period.end) return null;
  if (rows.some(s => s.accountLogin !== latest.accountLogin)) return null;
  const reset = resetInstant(latest.resetDate);
  let coverageStart = Math.max(window.start, period.start);
  const previousReset = rows.findLastIndex(s => resetInstant(s.resetDate) !== reset);
  if (previousReset >= 0) {
    // Calendar clamping can make the two periods overlap on short months.
    // The old counter's next-reset date is the actual observed boundary.
    const resetAt = resetInstant(rows[previousReset]!.resetDate);
    const firstNew = rows[previousReset + 1];
    if (resetAt === null || resetAt < window.start || !firstNew || firstNew.ts < resetAt) return null;
    coverageStart = resetAt;
    rows = rows.slice(previousReset + 1);
  }
  const first = rows[0];
  if (!first || rows.length < 2 || first.ts > coverageStart + 3600000 || latest.ts < window.end - 3600000) return null;
  const span = latest.ts - first.ts;
  if (span < DAY_MS) return null;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!, previous = rows[i - 1];
    if (!valid(row) || resetInstant(row.resetDate) !== reset || row.ts < period.start || row.ts >= period.end ||
      previous && (row.ts - previous.ts > 7 * DAY_MS || row.creditsUsed < previous.creditsUsed)) return null;
  }
  return finite((latest.creditsUsed - first.creditsUsed) / (span / DAY_MS));
}
export function computePace(input:{now:number;snapshots:readonly CounterSnapshot[];budget:number|undefined;correctedMonth:number|null;correctedWindow:number|null}):Pace {
  const rows=canonical(input.snapshots).filter(s=>s.ts<=input.now), latest=[...rows].reverse().find(valid);
  const period=billingPeriod(input.now,latest);
  const observed=[...rows].reverse().find(s=>valid(s) && s.ts>=period.start && s.ts<period.end &&
    (resetPeriod(s)?.start===period.start && resetPeriod(s)?.end===period.end) &&
    (latest?.accountLogin===s.accountLogin) && (resetInstant(s.resetDate)===resetInstant(latest?.resetDate)));
  const used=observed?.creditsUsed ?? (nonnegative(input.correctedMonth)?input.correctedMonth:null);
  const usedSource=observed ? "counter":used===null ? "unavailable":"pi";
  const allowance=[...rows].reverse().find(s=>valid(s) && nonnegative(s.entitlement) && s.accountLogin===latest?.accountLogin)?.entitlement ?? null;
  const budget=nonnegative(input.budget) && input.budget>0 ? input.budget:null;
  const scale=budget ?? (allowance!==null && allowance>0 ? allowance:null);
  const elapsed=Math.max(0,Math.min(input.now,period.end)-period.start), daysLeft=Math.max(0,(period.end-input.now)/DAY_MS);
  const window={start:Math.max(period.start,input.now-7*DAY_MS),end:input.now};
  const counter=counterRate(rows,window), days=(window.end-window.start)/DAY_MS;
  const pi=days>0 && nonnegative(input.correctedWindow) ? finite(input.correctedWindow/days):null;
  const ratePerDay=counter ?? pi, rateSource=counter!==null?"counter":pi!==null?"pi":"unavailable";
  const projected=used!==null && ratePerDay!==null ? finite(used+ratePerDay*daysLeft):null;
  const evenPace=budget===null ? null:budget*(elapsed/(period.end-period.start));
  return {period,used,budget,allowance,scale,remaining:used===null || scale===null ? null:Math.max(0,scale-used),evenPace,projected,daysLeft,ratePerDay,
    usedSource,rateSource,counterAvailable:!!observed,overPace:used!==null && evenPace!==null && used>evenPace,
    overBudget:used!==null && scale!==null && used>scale,overAtPace:projected===null || scale===null ? null:Math.max(0,projected-scale)};
}

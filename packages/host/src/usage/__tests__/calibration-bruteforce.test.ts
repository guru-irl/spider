import { afterAll, beforeAll, expect, it } from "vitest";
import { createCalibrationService } from "../calibration.js";
import type { CalibrationResult } from "../dashboard-contract.js";
import { createDashboardFixture, dashboardBatch, dashboardCall, DASHBOARD_DAY as DAY, DASHBOARD_MONTH as START, type DashboardFixture } from "./fixtures/dashboard-ledger.js";

// Reviewer brute force. Independent of calibration.ts: reads raw rows and recomputes every window directly.
// Fixed seeds preserve coverage of exact boundaries, negative deltas and invalid duplicates.
const SEEDS = 50;
let f: DashboardFixture;
beforeAll(() => { f = createDashboardFixture(false); });
afterAll(() => { f.close(); });

function rng(seed: number) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
type Snap = { id: number; ts: number; credits: number; account: string | null; reset: string | null; entitlement: number | null; remaining: number | null };
type Call = { ts: number; aic: number | null };
const nonneg = (v: number) => Number.isFinite(v) && v >= 0;
const valid = (s: Snap) => Number.isSafeInteger(s.ts) && s.ts >= 0 && nonneg(s.credits) && (s.entitlement === null || nonneg(s.entitlement)) && (s.remaining === null || nonneg(s.remaining));

function brute(snapsRaw: Snap[], calls: Call[]) {
  // Dedup per ts: highest-rowid valid row, else highest-rowid row (kept as a gap).
  const byTs = new Map<number, Snap[]>();
  for (const s of snapsRaw) { const l = byTs.get(s.ts) ?? []; l.push(s); byTs.set(s.ts, l); }
  const dedup: Snap[] = [];
  for (const [, l] of [...byTs].sort((a, b) => a[0] - b[0])) {
    l.sort((a, b) => a.id - b.id);
    const v = l.filter(valid);
    dedup.push(v.length ? v[v.length - 1]! : l[l.length - 1]!);
  }
  const fallback = (): CalibrationResult => ({ status: "uncalibrated", factor: null, windowStart: null, windowEnd: null, coveredHours: 0, computedAic: 0, counterDelta: 0, unpricedCalls: 0, method: "trailing-7d-ratio" });
  const windowFor = (anchor: Snap): CalibrationResult => {
    const lo = anchor.ts - 7 * DAY;
    const w = dedup.filter(s => s.ts >= lo && s.ts <= anchor.ts);
    const r = { ...fallback(), windowStart: Math.max(0, lo), windowEnd: anchor.ts };
    if (w.length <= 1) return r;
    let span = 0, delta = 0, aic = 0, unpriced = 0;
    for (let i = 1; i < w.length; i++) {
      const a = w[i - 1]!, b = w[i]!;
      if (!(valid(a) && valid(b) && a.account === b.account && a.reset === b.reset && b.credits >= a.credits && b.ts > a.ts && b.id > a.id)) continue;
      span += b.ts - a.ts; delta += b.credits - a.credits;
      for (const c of calls) if (c.ts >= a.ts && c.ts < b.ts) { if (c.aic === null) unpriced++; else aic += c.aic; }
    }
    Object.assign(r, { coveredHours: span / 3600000, computedAic: aic, counterDelta: delta, unpricedCalls: unpriced });
    if (r.coveredHours >= 24 && aic >= 500) {
      const ratio = delta / aic;
      r.status = ratio < 0.05 || ratio > 2 ? "implausible" : "calibrated";
      r.factor = Math.max(0.05, Math.min(2, ratio));
    }
    return r;
  };
  const at = (end: number): CalibrationResult => {
    const cands = dedup.filter(s => valid(s) && s.ts <= end);
    return cands.length ? windowFor(cands[cands.length - 1]!) : fallback();
  };
  let earliest: CalibrationResult = fallback();
  for (const s of dedup) { if (!valid(s)) continue; const r = windowFor(s); if (r.status === "calibrated") { earliest = r; break; } }
  return { at, earliest };
}

const stats = { seeds: 0, atChecks: 0, earliestCalibrated: 0, earliestNone: 0, atStatus: {} as Record<string, number>, aicExactMismatch: 0, maxRelAic: 0, maxRelFactor: 0,
  unpricedInEarliest: 0 };
function same(label: string, got: CalibrationResult, exp: CalibrationResult) {
  const rel = (a: number, b: number) => Math.abs(a - b) / Math.max(1, Math.abs(b));
  if (got.computedAic !== exp.computedAic || got.counterDelta !== exp.counterDelta) stats.aicExactMismatch++;
  stats.maxRelAic = Math.max(stats.maxRelAic, rel(got.counterDelta, exp.counterDelta));
  stats.maxRelAic = Math.max(stats.maxRelAic, rel(got.computedAic, exp.computedAic));
  if (got.factor !== null && exp.factor !== null) stats.maxRelFactor = Math.max(stats.maxRelFactor, rel(got.factor, exp.factor));
  expect({ ...got, computedAic: 0, counterDelta: 0, factor: got.factor === null ? null : 0, label }).toEqual({ ...exp, computedAic: 0, counterDelta: 0, factor: exp.factor === null ? null : 0, label });
  expect(rel(got.counterDelta, exp.counterDelta), label).toBeLessThan(1e-9);
  expect(rel(got.computedAic, exp.computedAic), label).toBeLessThan(1e-9);
  if (exp.factor !== null) expect(rel(got.factor!, exp.factor), label).toBeLessThan(1e-9);
}

it(`sliding earliest() and atMany match brute force over ${SEEDS} seeds`, () => {
  for (let seed = 1; seed <= SEEDS; seed++) {
    const r = rng(seed * 7919);
    f.db.exec("DELETE FROM calls; DELETE FROM counter_snapshots");
    const span = Math.floor(2 + r() * 30) * DAY;
    const grid = [3600000, 6 * 3600000, 12 * 3600000, DAY][Math.floor(r() * 4)]!;
    const scale = [0.02, 0.3, 0.6, 1, 2.5][Math.floor(r() * 5)]!; // some seeds implausible
    const sparsity = r() * 0.6;
    const aicPerHour = [2, 25, 60][Math.floor(r() * 3)]!; // some seeds never reach 500
    const floatAic = r() < 0.5;
    // Snapshots
    const snaps: Omit<Snap, "id">[] = [];
    let credits = r() * 100, reset = "R0", account: string | null = "acct";
    for (let t = START; t <= START + span; t += grid) {
      if (r() < sparsity) continue;
      const jitter = r() < 0.3 ? Math.floor(r() * grid) : 0;
      credits += scale * aicPerHour * (grid / 3600000) * (0.5 + r());
      if (r() < 0.04) credits = Math.max(0, credits - 200 * r()); // negative delta
      if (r() < 0.04) { reset = `R${Math.floor(r() * 1000)}`; if (r() < 0.5) credits = r() * 50; } // reset, sometimes credits still rising
      if (r() < 0.02) account = account === null ? "acct" : r() < 0.5 ? null : "other";
      const s = { ts: t + jitter, credits, account, reset, entitlement: null as number | null, remaining: null as number | null };
      const k = r();
      if (k < 0.03) s.entitlement = -1; else if (k < 0.05) s.remaining = -1; else if (k < 0.06) s.credits = -1;
      snaps.push(s);
      if (r() < 0.06) snaps.push({ ...s, credits: s.credits + r() * 40, entitlement: r() < 0.5 ? -1 : null }); // duplicate ts, maybe invalid
      if (r() < 0.04) { const t7 = t + jitter + 7 * DAY; snaps.push({ ...s, ts: t7 }); } // exact 7d boundary probes
    }
    // Insert order: mostly chronological with some backwards appends.
    const order = snaps.map((s, i) => ({ s, k: i + (r() < 0.08 ? 3 + r() * 10 : 0) })).sort((a, b) => a.k - b.k).map(x => x.s);
    const ins = f.db.prepare("INSERT INTO counter_snapshots(ts,account_login,credits_used,entitlement,remaining,reset_date,raw) VALUES (?,?,?,?,?,?,'{}')");
    f.db.raw.transaction(() => { for (const s of order) ins.run(s.ts, s.account, s.credits, s.entitlement, s.remaining, s.reset); })();
    const rows = f.db.prepare("SELECT rowid AS id,ts,credits_used AS credits,account_login AS account,reset_date AS reset,entitlement,remaining FROM counter_snapshots").all() as Snap[];
    // Calls
    const calls: Call[] = [];
    const batch = [];
    const nCalls = Math.floor((span / 3600000) * (0.3 + r()) * 0.6);
    for (let i = 0; i < nCalls; i++) {
      const onSnap = r() < 0.1 && rows.length ? rows[Math.floor(r() * rows.length)]!.ts : START - DAY + Math.floor(r() * (span + 2 * DAY));
      const unpriced = r() < 0.08;
      const aic = unpriced ? null : floatAic ? r() * aicPerHour * 2 + 0.013 : Math.floor(r() * aicPerHour * 2) + 1;
      calls.push({ ts: onSnap, aic });
      const id = `s${seed}-${i}`;
      batch.push(unpriced ? dashboardCall(id, { ts: onSnap, price: { status: "unpriced", reason: "unknown-model" } })
        : dashboardCall(id, { ts: onSnap, price: { status: "priced", aic: aic!, components: { input: aic!, cacheRead: 0, cacheWrite: 0, output: 0 }, rateVersion: "bf", tier: "bf", confidence: "estimated" } }));
    }
    if (batch.length) f.ledger.apply(dashboardBatch(batch));
    const dbCalls = f.db.prepare("SELECT ts, CASE WHEN price_status='unpriced' THEN NULL ELSE aic END AS aic FROM calls").all() as Call[];
    expect(dbCalls.length).toBe(calls.length);
    const b = brute(rows, dbCalls);
    const service = createCalibrationService(f.db, { revision: () => `seed-${seed}` });
    // Sample endpoints rather than exhaustively querying every timestamp; the
    // independent oracle still evaluates all candidates to discover the first fit.
    const ends = [START - 1, START + span + DAY];
    if (b.earliest.windowEnd !== null) ends.push(b.earliest.windowEnd - 1, b.earliest.windowEnd, b.earliest.windowEnd + 1);
    for (let i = 0; i < 8 && rows.length; i++) {
      const ts = rows[Math.floor(r() * rows.length)]!.ts;
      ends.push(ts - 1, ts, ts + 7 * DAY);
    }
    const earliestFirst = r() < 0.5;
    let e: CalibrationResult | undefined;
    if (earliestFirst) e = service.earliest("auto");
    // atMany in chunks of <= 40, shuffled with duplicates
    const shuffled = ends.map(v => ({ v, k: r() })).sort((a, c) => a.k - c.k).map(x => x.v).filter(v => v >= 0);
    for (let i = 0; i < shuffled.length; i += 40) {
      const chunk = shuffled.slice(i, i + 40);
      // Reuse one service across chunks to exercise the bounded endpoint cache too.
      const got = service.atMany(chunk, "auto");
      chunk.forEach((end, j) => { const exp = b.at(end); stats.atStatus[exp.status] = (stats.atStatus[exp.status] ?? 0) + 1; stats.atChecks++; same(`seed ${seed} at ${end - START}`, got[j]!, exp); });
    }
    e ??= service.earliest("auto");
    same(`seed ${seed} earliest`, e, b.earliest);
    // Fresh service, earliest only (no batch cache interplay)
    same(`seed ${seed} earliest fresh`, createCalibrationService(f.db, { revision: () => `fresh-${seed}` }).earliest("auto"), b.earliest);
    if (b.earliest.status === "calibrated") { stats.earliestCalibrated++; if (b.earliest.unpricedCalls) stats.unpricedInEarliest++; } else stats.earliestNone++;
    stats.seeds++;
  }
  expect(stats.seeds).toBe(SEEDS);
  expect(stats.earliestCalibrated).toBeGreaterThan(0);
  expect(stats.earliestNone).toBeGreaterThan(0);
  for (const status of ["calibrated", "implausible", "uncalibrated"]) expect(stats.atStatus[status]).toBeGreaterThan(0);
  expect(stats.unpricedInEarliest).toBeGreaterThan(0);
}, 10000);

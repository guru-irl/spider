import { randomUUID } from "node:crypto";
import { openDbReadOnly, type Db } from "@spider/db-core";
import { assertUsageSchemaVersion } from "./migrate.js";
import { counterSnapshotIsFresh } from "./counter.js";
import { createCalibrationService } from "./calibration.js";
import { safeTimestamp } from "./dashboard-selection.js";
import { COPILOT_RATE_VERSIONS } from "./rates.js";
import { DashboardQueryError, type DashboardReader, type ReaderOptions, type DashboardQueryContext, type DashboardCounter, type DashboardStatus, type DashboardIngestState } from "./dashboard-contract.js";

export function readDashboardCounter(db: Db, now: number): DashboardCounter {
  const row = db.prepare(`SELECT ts, credits_used AS creditsUsed, entitlement, remaining, reset_date AS resetDate,
    (SELECT next_due_at FROM leases WHERE name='counter') AS nextPollAt
    FROM counter_snapshots ORDER BY ts DESC, rowid DESC LIMIT 1`).get() as
    { ts: number; creditsUsed: number; entitlement: number | null; remaining: number | null; resetDate: string | null; nextPollAt: number | null } | undefined;
  const nonnegative = (value: number | null) => value !== null && Number.isFinite(value) && value >= 0 ? value : null;
  if (!row || !safeTimestamp(row.ts) || nonnegative(row.creditsUsed) === null) {
    return { ts: null, creditsUsed: null, entitlement: null, remaining: null, resetDate: null, ageMs: null, availability: "unavailable", nextPollAt: null };
  }
  return { ts: row.ts, creditsUsed: row.creditsUsed, entitlement: nonnegative(row.entitlement), remaining: nonnegative(row.remaining),
    resetDate: row.resetDate?.slice(0, 160) ?? null, ageMs: Math.max(0, now - row.ts), nextPollAt: row.nextPollAt,
    availability: counterSnapshotIsFresh({ ts: row.ts, creditsUsed: row.creditsUsed, raw: {} }, now, row.nextPollAt) ? "available" : "stale" };
}

function sqliteQueryError(error: unknown): DashboardQueryError | undefined {
  if (error instanceof DashboardQueryError) return error;
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code !== "string") return undefined;
  if (/^SQLITE_(NOTADB|CORRUPT)(_|$)/.test(code)) return new DashboardQueryError("unsupported-schema");
  if (/^SQLITE_(BUSY|LOCKED)(_|$)/.test(code)) return new DashboardQueryError("busy");
  if (/^SQLITE_(CANTOPEN|IOERR)(_|$)/.test(code)) return new DashboardQueryError("ledger-unavailable");
  return undefined;
}

export function openDashboardReader(file: string, options: ReaderOptions): DashboardReader | undefined {
  if (typeof options.calibrationMode !== "function") throw new TypeError("calibrationMode must be a function");
  let opened: Db | undefined;
  try {
    const db = opened = openDbReadOnly(file, { busyTimeoutMs: 250 });
    if (!db) return undefined;
    if (db.pragma("user_version") === 0) throw new DashboardQueryError("unsupported-schema");
    try { assertUsageSchemaVersion(db); } catch (error) { throw sqliteQueryError(error) ?? new DashboardQueryError("unsupported-schema"); }
    db.pragma("query_only=ON");
    const schemaVersion = db.pragma("user_version") as number;
    let replacement: DashboardReader | undefined;
    const upgradedReader = (): DashboardReader | undefined => {
      if (replacement) return replacement;
      // Check outside a snapshot transaction. A v1-v3 reader must not retain
      // schema-dependent statements or selection caches after a writer upgrades.
      if (db.pragma("user_version") === schemaVersion) return undefined;
      const next = openDashboardReader(file, options);
      if (!next) throw new DashboardQueryError("ledger-unavailable");
      db.close();
      return replacement = next;
    };
    // Keep the launcher's owner prefix; a fresh reader generation invalidates old cursors.
    const instanceId = `${options.instanceId}:${randomUUID()}`;
    const revisionStatement = db.prepare("SELECT value FROM ledger_metadata WHERE key='call-selection-revision'");
    const revision = () => {
      const row = revisionStatement.get() as { value: string } | undefined;
      if (!row || !/^\d+$/.test(row.value)) throw new DashboardQueryError("ledger-unavailable");
      return `${instanceId}:${row.value}`;
    };
    const calibration = createCalibrationService(db, { revision });
    const rates = options.rates ?? COPILOT_RATE_VERSIONS;
    const readStatus = (now: number): DashboardStatus => {
      const metadata = db.prepare("SELECT key,value FROM ledger_metadata WHERE key IN ('worker-snapshot','backfill-state')").all() as { key: string; value: string }[];
      let published: { health?: { sources?: number; parseErrors?: number; sourceErrors?: number; lastIngestAt?: number }; backfill?: DashboardIngestState["backfill"]; ingestRole?: DashboardIngestState["role"] } = {};
      try { published = JSON.parse(metadata.find(row => row.key === "worker-snapshot")?.value ?? "{}"); } catch { /* unavailable publication */ }
      if (!published || typeof published !== "object") published = {};
      const count = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
      const supplied = options.ingestStatus?.();
      const last = supplied ? supplied.lastIngestAt : published.health?.lastIngestAt ?? null;
      const lastIngestAt = last !== null && safeTimestamp(last) ? last : null;
      const backfill = supplied?.backfill ?? metadata.find(row => row.key === "backfill-state")?.value ?? published.backfill;
      const role = supplied?.role ?? published.ingestRole ?? "inactive";
      const codes = ["usage-ingest-failed", "usage-ingest-lease-lost", "usage-ingest-lease-busy", "usage-ledger-unavailable"];
      const ingest: DashboardIngestState = {
        role: ["owner", "follower", "standby", "inactive"].includes(role) ? role : "inactive",
        lastIngestAt, backfill: backfill === "running" || backfill === "complete" || backfill === "failed" ? backfill : "pending",
        errorCode: supplied?.errorCode ? codes.includes(supplied.errorCode) ? supplied.errorCode : "usage-ingest-failed" : null,
        ...(supplied?.progress ? { progress: { sourcesCompleted: count(supplied.progress.sourcesCompleted), sourcesTotal: count(supplied.progress.sourcesTotal) } } : {}),
      };
      const totals = db.prepare("SELECT calls FROM ledger_totals WHERE singleton=1").get() as { calls: number };
      return { serverBuild: options.serverBuild, schemaVersion: db.pragma("user_version") as number, rateVersions: rates.map(rate => rate.id), calls: totals.calls,
        sources: count(published.health?.sources), parseErrors: count(published.health?.parseErrors), sourceErrors: count(published.health?.sourceErrors),
        ingest: { ...ingest, ageMs: lastIngestAt === null ? null : Math.max(0, now - lastIngestAt),
          stale: lastIngestAt === null || now < lastIngestAt || now - lastIngestAt > 120000 },
        counter: readDashboardCounter(db, now) };
    };
    const mapped = <T>(read: () => T): T => {
      try { return read(); } catch (error) { throw sqliteQueryError(error) ?? new DashboardQueryError("internal"); }
    };
    const reader: DashboardReader = {
      revision: () => mapped(() => upgradedReader()?.revision() ?? revision()),
      status() { return mapped(() => upgradedReader()?.status() ?? (db.raw.inTransaction ? readStatus(options.now()) : db.raw.transaction(() => readStatus(options.now())).deferred())); },
      snapshot<T>(read: (ctx: DashboardQueryContext) => T): T {
        return mapped(() => {
          const upgraded = upgradedReader();
          if (upgraded) return upgraded.snapshot(read);
          const now = options.now();
          const calibrationMode = options.calibrationMode();
          if (calibrationMode !== "auto" && calibrationMode !== "off") throw new TypeError("calibrationMode must return auto or off");
          return db.raw.transaction(() => read({ db, instanceId, revision: revision(), now: () => now, rates,
          calibration,
          calibrationMode, monthlyBudget: options.monthlyBudget, status: () => readStatus(now) })).deferred();
        });
      },
      close() { if (replacement) replacement.close(); else db.close(); },
    };
    return reader;
  } catch (error) { opened?.close(); throw sqliteQueryError(error) ?? error; }
}

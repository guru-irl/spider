import { randomUUID } from "node:crypto";
import type { Db } from "@spider/db-core";
import type { CounterSnapshot, UsageLedger } from "./ledger.js";

// Runtime callers pass a clock, sampled after BEGIN IMMEDIATE. Numeric times
// remain supported for deterministic fixtures and historical fence probes.
export type LeaseClock = number | (() => number);
const sample = (clock: LeaseClock): number => typeof clock === "function" ? clock() : clock;
const JUMP_SLACK_MS = 30000;
const LEASE_BUSY_MS = 25;
const transient = (code: string | null) => code === "lease-busy" || code === "lease-lost";

export type Lease = {
  owner: string;
  readonly expiresAt: number;
  isCurrent(at?: LeaseClock): boolean;
  renew(at: LeaseClock): boolean;
  /** False means a successor owns the row; storage failures throw a fixed code. */
  release(): boolean;
  nextPollAt(): number | null;
  claimPoll(at: LeaseClock, intervalMs: number): boolean;
  recordError(at: LeaseClock, code: string): boolean;
  /** Fence and snapshot insert commit together, synchronously. No async adapter. */
  saveIfCurrent(at: LeaseClock, snapshot: CounterSnapshot): boolean;
};
export type UsageNotice = { code: string; at: number };
export type UsageLeaseInspection = {
  owner: string | null;
  expiresAt: number | null;
  role: "free" | "owner" | "follower" | "expired";
  nextDueAt: number | null;
  lastErrorCode: string | null;
  notice: UsageNotice | null;
};
export type UsageLeaseStore = {
  acquire(name: string, owner: string, at: LeaseClock, ttlMs: number): Lease | undefined;
  inspect(name: string, at: number, owner?: string): UsageLeaseInspection;
  /** Persist/clear snapshot skew only when the shared condition changes. */
  reconcileNotice(name: string, clock: LeaseClock): void;
};
type Row = {
  owner: string | null; token: string | null; acquired_at: number | null;
  expires_at: number | null; next_due_at: number | null; last_error_code: string | null;
  notice_code: string | null; notice_at: number | null;
};
const time = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0;

export class UsageLeaseError extends Error {
  constructor(readonly code: "lease-busy" | "lease-storage") { super(code); }
}

/** Writes hold one short IMMEDIATE transaction with a 25 ms busy timeout.
 * Read-only paths are plain SELECTs and never contend with WAL writers. */
export function createUsageLeaseStore(db: Db, insertCounter: (snapshot: CounterSnapshot) => void): UsageLeaseStore {
  const get = db.prepare("SELECT owner, token, acquired_at, expires_at, next_due_at, last_error_code, notice_code, notice_at FROM leases WHERE name=?");
  const put = db.prepare(`INSERT INTO leases(name, owner, token, acquired_at, expires_at, next_due_at, last_error_code, notice_code, notice_at)
    VALUES (@name, @owner, @token, @acquired_at, @expires_at, @next_due_at, @last_error_code, @notice_code, @notice_at)
    ON CONFLICT(name) DO UPDATE SET owner=excluded.owner, token=excluded.token,
    acquired_at=excluded.acquired_at, expires_at=excluded.expires_at,
    next_due_at=excluded.next_due_at, last_error_code=excluded.last_error_code,
    notice_code=excluded.notice_code, notice_at=excluded.notice_at`);
  const read = (name: string) => get.get(name) as Row | undefined;
  const write = (name: string, row: Row) => { put.run({ name, ...row }); };
  const transaction = <T>(action: () => T, write = true): T => {
    const previousTimeout = write ? db.pragma("busy_timeout") as number : null;
    try {
      if (write) db.pragma(`busy_timeout = ${LEASE_BUSY_MS}`);
      return write ? db.raw.transaction(action).immediate() : action();
    }
    catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      if (typeof code === "string" && code.startsWith("SQLITE_BUSY")) throw new UsageLeaseError("lease-busy");
      if (typeof code === "string" && code.startsWith("SQLITE_")) throw new UsageLeaseError("lease-storage");
      throw error;
    } finally { if (previousTimeout !== null) db.pragma(`busy_timeout = ${previousTimeout}`); }
  };
  const empty = (): Row => ({ owner: null, token: null, acquired_at: null, expires_at: null, next_due_at: null, last_error_code: null, notice_code: null, notice_at: null });
  const notice = (row: Row, code: string, at: number) => { row.notice_code = code; row.notice_at = at; };
  const clearNotice = (row: Row) => { row.notice_code = null; row.notice_at = null; };
  const latestTime = db.prepare("SELECT ts FROM counter_snapshots ORDER BY rowid DESC LIMIT 1");
  const skew = (at: number) => {
    const latest = latestTime.get() as { ts: number } | undefined;
    return latest !== undefined && latest.ts > at;
  };
  return {
    reconcileNotice(name, clock) {
      const needsUpdate = (row: Row | undefined, at: number) => row !== undefined &&
        (skew(at) ? row.notice_code !== "clock-skew" : row.notice_code === "clock-skew");
      // Reads stay lock-free. Only a condition transition needs a write.
      if (!needsUpdate(read(name), sample(clock))) return;
      transaction(() => {
        const at = sample(clock), row = read(name);
        if (!needsUpdate(row, at)) return;
        if (skew(at)) notice(row!, "clock-skew", at); else clearNotice(row!);
        write(name, row!);
      });
    },
    inspect(name, at, owner) {
      return transaction(() => {
        const row = read(name);
        return {
          owner: text(row?.owner) ? row.owner : null,
          expiresAt: time(row?.expires_at) ? row.expires_at : null,
          role: !row?.owner ? "free" : !time(row.expires_at) || row.expires_at <= at ? "expired" : row.owner === owner ? "owner" : "follower",
          nextDueAt: time(row?.next_due_at) ? row.next_due_at : null,
          lastErrorCode: row?.last_error_code ?? null,
          notice: text(row?.notice_code) && time(row?.notice_at) ? { code: row.notice_code, at: row.notice_at } : null,
        };
      }, false);
    },
    acquire(name, owner, clock, ttlMs) {
      if (!text(name) || !text(owner) || !time(ttlMs) || ttlMs === 0) return undefined;
      return transaction(() => {
        const at = sample(clock);
        if (!time(at) || !time(at + ttlMs)) return undefined;
        const previous = read(name) ?? empty();
        if (time(previous.expires_at) && previous.expires_at > at + ttlMs + JUMP_SLACK_MS) {
          // A backward clock jump cannot strand ephemeral ownership indefinitely.
          previous.owner = null; previous.token = null;
          previous.acquired_at = null; previous.expires_at = null;
          notice(previous, "clock-jump", at);
        }
        const free = previous.owner === null && previous.token === null && previous.expires_at === null && previous.acquired_at === null;
        const valid = text(previous.owner) && text(previous.token) && time(previous.acquired_at) && time(previous.expires_at);
        if (!free && !valid) {
          // Unknown expiry is reset once to one TTL, never an immediate steal.
          // Preserve a valid live expiry even if other identity fields are corrupt.
          previous.owner = text(previous.owner) ? previous.owner : "corrupt-owner";
          previous.token = randomUUID();
          previous.acquired_at = at;
          previous.expires_at = time(previous.expires_at) ? previous.expires_at : at + ttlMs;
          notice(previous, "lease-row-corrupt", at);
          write(name, previous);
        }
        if (previous.expires_at !== null && previous.expires_at > at) return undefined;
        const token = randomUUID();
        const record: Row = { ...previous, owner, token, acquired_at: at, expires_at: at + ttlMs,
          last_error_code: transient(previous.last_error_code) ? null : previous.last_error_code };
        if (record.notice_code === "lease-row-corrupt") clearNotice(record);
        write(name, record);
        let released = false;
        const matches = (row: Row | undefined, now: number) => !released && time(now) && row?.token === token && row.owner === owner && time(row.expires_at) && now < row.expires_at;
        return {
          owner,
          get expiresAt() { return record.expires_at!; },
          isCurrent: (clock = Date.now) => transaction(() => matches(read(name), sample(clock)), false),
          renew: clock => transaction(() => {
            const now = sample(clock);
            const row = read(name);
            if (!matches(row, now) || !time(now + ttlMs)) return false;
            row!.expires_at = now + ttlMs; write(name, row!); record.expires_at = row!.expires_at;
            return true;
          }),
          release: () => transaction(() => {
            if (released) return true;
            const row = read(name);
            if (row?.token !== token || row.owner !== owner) { released = true; return false; }
            write(name, { ...row, owner: null, token: null, acquired_at: null, expires_at: null });
            released = true; return true;
          }),
          nextPollAt: () => transaction(() => {
            const due = read(name)?.next_due_at;
            return time(due) ? due : null;
          }, false),
          claimPoll: (clock, intervalMs) => transaction(() => {
            const now = sample(clock);
            const row = read(name);
            if (!matches(row, now) || !time(intervalMs) || intervalMs === 0 || !time(now + 2 * intervalMs)) return false;
            let due = row!.next_due_at;
            if (due !== null && !time(due)) {
              due = now + intervalMs; notice(row!, "schedule-corrupt", now);
            } else if (due !== null && due > now + 2 * intervalMs) {
              due = now + 2 * intervalMs; notice(row!, "clock-jump", now);
            }
            row!.next_due_at = due;
            if (due !== null && due > now) { write(name, row!); return false; }
            row!.next_due_at = now + intervalMs;
            if (["clock-jump", "schedule-corrupt"].includes(row!.notice_code ?? "")) clearNotice(row!);
            write(name, row!); return true;
          }),
          recordError: (clock, code) => transaction(() => {
            const now = sample(clock);
            const row = read(name);
            if (!matches(row, now)) return false;
            if (row!.last_error_code !== "save-failed") row!.last_error_code = /^[a-z0-9-]{1,64}$/.test(code) ? code : "internal";
            write(name, row!); return true;
          }),
          saveIfCurrent: (clock, snapshot) => transaction(() => {
            const now = sample(clock);
            if (!matches(read(name), now)) return false;
            const result: unknown = insertCounter(snapshot);
            if (result && typeof (result as { then?: unknown }).then === "function") {
              // A mistaken async adapter must not extend the lock or shutdown.
              void Promise.resolve(result).catch(() => {});
              throw new Error("async-save");
            }
            const row = read(name)!;
            row.last_error_code = null;
            if (snapshot.ts > now) notice(row, "clock-skew", now);
            else if (row.notice_code === "clock-skew") clearNotice(row);
            write(name, row);
            return true;
          }),
        };
      });
    },
  };
}

export function acquireUsageLease(ledger: UsageLedger, name: string, owner: string, at: LeaseClock, ttlMs: number): Lease | undefined {
  return ledger.leases.acquire(name, owner, at, ttlMs);
}
/** /doctor can inspect ownership, expiry, cadence and recovery errors, not tokens. */
export function inspectUsageLease(ledger: UsageLedger, name: string, at: number = Date.now(), owner?: string): UsageLeaseInspection {
  return ledger.leases.inspect(name, at, owner);
}

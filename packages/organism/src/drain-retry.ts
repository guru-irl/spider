import type { Db } from "@spider/db-core";
import { emitLog } from "@spider/subagents";
import type { DigestBundle, PassName } from "./types.js";

export interface DrainOutage {
  retryAt: number;
  failures: number;
  occurrences: number;
  phase: string;
  message: string;
}
export interface DeferredDrain { bundle: DigestBundle; passes: PassName[]; connectivityRetries?: number; createdAt?: number }

type DropCause = "age" | "session-cap" | "global-cap" | "retry-cap";
const MAX_CONNECTIVITY_RETRIES = 8;
const MAX_PER_SESSION = 2;
const MAX_DEFERRED = 64;
const MAX_AGE_MS = 7 * 24 * 60 * 60_000;

export function deferredDrainKey(bundle: DigestBundle): string {
  const { reason, ...content } = bundle;
  void reason;
  return JSON.stringify(content);
}

/** Worktree-owned retry state is separate from append-only drain receipts. */
export class DrainRetryStore {
  constructor(private readonly db: Db) {
    db.exec(`CREATE TABLE IF NOT EXISTS organism_provider_outage (
      id INTEGER PRIMARY KEY CHECK (id=1), retry_at INTEGER NOT NULL,
      failures INTEGER NOT NULL, occurrences INTEGER NOT NULL,
      phase TEXT NOT NULL, message TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS organism_deferred_drain (
      session_id TEXT PRIMARY KEY, snapshots TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS organism_drain_retry_lock (
      id INTEGER PRIMARY KEY CHECK (id=1), owner TEXT NOT NULL, lease_until INTEGER NOT NULL
    )`);
  }

  outage(): DrainOutage | undefined {
    return this.db.prepare("SELECT retry_at AS retryAt,failures,occurrences,phase,message FROM organism_provider_outage WHERE id=1").get() as DrainOutage | undefined;
  }

  private hasSession(sessionId: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM organism_deferred_drain WHERE session_id=?").get(sessionId);
  }

  private parseSnapshots(json: string, createdAt: number): DeferredDrain[] {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) throw new Error("Invalid deferred drain state");
    return (parsed as DeferredDrain[]).map(item => ({
      ...item, createdAt: typeof item.createdAt === "number" && Number.isFinite(item.createdAt) ? item.createdAt : createdAt,
    }));
  }

  private snapshots(sessionId: string): DeferredDrain[] {
    const row = this.db.prepare("SELECT snapshots,created_at FROM organism_deferred_drain WHERE session_id=?").get(sessionId) as { snapshots: string; created_at: number } | undefined;
    return row ? this.parseSnapshots(row.snapshots, row.created_at) : [];
  }

  private writeSnapshots(sessionId: string, snapshots: DeferredDrain[]): void {
    if (snapshots.length) {
      const createdAt = Math.min(...snapshots.map(item => item.createdAt ?? Date.now()));
      this.db.prepare(`INSERT INTO organism_deferred_drain(session_id,snapshots,created_at) VALUES (?,?,?)
        ON CONFLICT(session_id) DO UPDATE SET snapshots=excluded.snapshots,created_at=excluded.created_at`)
        .run(sessionId, JSON.stringify(snapshots), createdAt);
    } else this.db.prepare("DELETE FROM organism_deferred_drain WHERE session_id=?").run(sessionId);
  }

  private recordDrop(item: DeferredDrain, cause: DropCause): void {
    emitLog(this.db, {
      sessionId: item.bundle.sessionId,
      summary: `organism deferred drain dropped: ${cause}`,
      payload: { kind: "organism-deferred-drop", sessionId: item.bundle.sessionId, reason: item.bundle.reason, cause, dropped: 1 },
    });
  }

  /** Called inside the same transaction as the queue change or read. */
  private prune(): number {
    const rows = this.db.prepare("SELECT session_id,snapshots,created_at FROM organism_deferred_drain ORDER BY created_at,session_id").all() as Array<{ session_id: string; snapshots: string; created_at: number }>;
    const sessions = rows.map(row => ({ id: row.session_id, snapshots: this.parseSnapshots(row.snapshots, row.created_at) }));
    const dropped = new Map<DeferredDrain, DropCause>();
    const now = Date.now();
    for (const session of sessions) {
      const live = session.snapshots.filter(item => {
        if (now - item.createdAt! >= MAX_AGE_MS) { dropped.set(item, "age"); return false; }
        return true;
      }).sort((a, b) => a.createdAt! - b.createdAt!);
      for (const item of live.slice(0, Math.max(0, live.length - MAX_PER_SESSION))) dropped.set(item, "session-cap");
    }
    const remaining = sessions.flatMap(session => session.snapshots.filter(item => !dropped.has(item)))
      .sort((a, b) => a.createdAt! - b.createdAt!);
    for (const item of remaining.slice(0, Math.max(0, remaining.length - MAX_DEFERRED))) dropped.set(item, "global-cap");
    if (!dropped.size) return 0;
    for (const session of sessions) {
      const retained = session.snapshots.filter(item => !dropped.has(item));
      if (retained.length !== session.snapshots.length) this.writeSnapshots(session.id, retained);
    }
    for (const [item, cause] of dropped) this.recordDrop(item, cause);
    return dropped.size;
  }

  private save(bundle: DigestBundle, passes: PassName[], replace: boolean, retrying = false): number {
    let dropped = this.prune();
    const snapshots = this.snapshots(bundle.sessionId);
    const key = deferredDrainKey(bundle);
    const index = snapshots.findIndex(item => deferredDrainKey(item.bundle) === key);
    if (retrying && index < 0) return dropped;
    const retries = (index < 0 ? 0 : snapshots[index].connectivityRetries ?? 0) + (retrying ? 1 : 0);
    if (retrying && retries >= MAX_CONNECTIVITY_RETRIES) {
      const [item] = snapshots.splice(index, 1);
      this.writeSnapshots(bundle.sessionId, snapshots);
      this.recordDrop(item, "retry-cap");
      return dropped + 1;
    }
    if (index < 0) snapshots.push({ bundle, passes, connectivityRetries: retries, createdAt: Date.now() });
    else if (replace) snapshots[index] = { bundle, passes, connectivityRetries: retries, createdAt: snapshots[index].createdAt };
    this.writeSnapshots(bundle.sessionId, snapshots);
    dropped += this.prune();
    return dropped;
  }

  failure(bundle: DigestBundle, passes: PassName[], phase: string, message: string, retrying = false): { outage: DrainOutage; first: boolean; dropped: number } {
    return this.db.raw.transaction(() => {
      const previous = this.outage();
      const first = !this.hasSession(bundle.sessionId);
      const failures = Math.min(8, (previous?.failures ?? 0) + 1);
      const outage = {
        retryAt: Date.now() + Math.min(6 * 60 * 60_000, 5 * 60_000 * 2 ** (failures - 1)),
        failures, occurrences: Math.min(100, (previous?.occurrences ?? 0) + 1), phase, message,
      };
      const dropped = this.save(bundle, passes, true, retrying);
      this.db.prepare(`INSERT INTO organism_provider_outage(id,retry_at,failures,occurrences,phase,message) VALUES (1,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET retry_at=excluded.retry_at,failures=excluded.failures,
        occurrences=excluded.occurrences,phase=excluded.phase,message=excluded.message`)
        .run(outage.retryAt, outage.failures, outage.occurrences, outage.phase, outage.message);
      return { outage, first, dropped };
    }).immediate();
  }

  defer(bundle: DigestBundle, passes: PassName[]): { outage: DrainOutage; first: boolean; dropped: number } | undefined {
    return this.db.raw.transaction(() => {
      const outage = this.outage();
      if (!outage) return undefined;
      const first = !this.hasSession(bundle.sessionId);
      const dropped = this.save(bundle, passes, false);
      outage.occurrences = Math.min(100, outage.occurrences + 1);
      this.db.prepare("UPDATE organism_provider_outage SET occurrences=? WHERE id=1").run(outage.occurrences);
      return { outage, first, dropped };
    }).immediate();
  }

  clearOutage(): void { this.db.prepare("DELETE FROM organism_provider_outage WHERE id=1").run(); }

  acquire(owner: string, duration: number): { acquired: boolean; retryAt: number } {
    return this.db.raw.transaction(() => {
      this.db.prepare("INSERT OR IGNORE INTO organism_drain_retry_lock(id,owner,lease_until) VALUES (1,'',0)").run();
      const retryAt = Date.now() + duration;
      const acquired = this.db.prepare("UPDATE organism_drain_retry_lock SET owner=?,lease_until=? WHERE id=1 AND lease_until<=?")
        .run(owner, retryAt, Date.now()).changes > 0;
      const row = this.db.prepare("SELECT lease_until FROM organism_drain_retry_lock WHERE id=1").get() as { lease_until: number };
      return { acquired, retryAt: row.lease_until };
    }).immediate();
  }

  renew(owner: string, duration: number): boolean {
    return this.db.prepare("UPDATE organism_drain_retry_lock SET lease_until=? WHERE id=1 AND owner=?").run(Date.now() + duration, owner).changes > 0;
  }

  owns(owner: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM organism_drain_retry_lock WHERE id=1 AND owner=?").get(owner);
  }

  release(owner: string): void {
    this.db.prepare("UPDATE organism_drain_retry_lock SET owner='',lease_until=0 WHERE id=1 AND owner=?").run(owner);
  }

  contains(bundle: DigestBundle): boolean {
    const key = deferredDrainKey(bundle);
    return this.snapshots(bundle.sessionId).some(item => deferredDrainKey(item.bundle) === key);
  }

  next(excluded: ReadonlySet<string> = new Set()): DeferredDrain | undefined {
    return this.db.raw.transaction(() => {
      this.prune();
      const rows = this.db.prepare("SELECT session_id FROM organism_deferred_drain ORDER BY created_at,session_id").all() as Array<{ session_id: string }>;
      for (const row of rows) {
        const next = this.snapshots(row.session_id).find(item => !excluded.has(deferredDrainKey(item.bundle)));
        if (next) return next;
      }
      return undefined;
    }).immediate();
  }

  finish(bundle: DigestBundle): void {
    this.db.raw.transaction(() => {
      const snapshots = this.snapshots(bundle.sessionId);
      const key = deferredDrainKey(bundle);
      this.writeSnapshots(bundle.sessionId, snapshots.filter(item => deferredDrainKey(item.bundle) !== key));
    }).immediate();
  }
}

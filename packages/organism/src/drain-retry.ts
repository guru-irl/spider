import type { Db } from "@spider/db-core";
import type { DigestBundle, PassName } from "./types.js";

export interface DrainOutage {
  retryAt: number;
  failures: number;
  occurrences: number;
  phase: string;
  message: string;
}
export interface DeferredDrain { bundle: DigestBundle; passes: PassName[] }

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

  private snapshots(sessionId: string): DeferredDrain[] {
    const row = this.db.prepare("SELECT snapshots FROM organism_deferred_drain WHERE session_id=?").get(sessionId) as { snapshots: string } | undefined;
    if (!row) return [];
    const parsed: unknown = JSON.parse(row.snapshots);
    if (!Array.isArray(parsed)) throw new Error("Invalid deferred drain state");
    return parsed as DeferredDrain[];
  }

  private save(bundle: DigestBundle, passes: PassName[], replace: boolean): void {
    const snapshots = this.snapshots(bundle.sessionId);
    const key = JSON.stringify(bundle);
    const index = snapshots.findIndex(item => JSON.stringify(item.bundle) === key);
    if (index < 0) snapshots.push({ bundle, passes });
    else if (replace) snapshots[index] = { bundle, passes };
    this.db.prepare(`INSERT INTO organism_deferred_drain(session_id,snapshots,created_at) VALUES (?,?,?)
      ON CONFLICT(session_id) DO UPDATE SET snapshots=excluded.snapshots`).run(bundle.sessionId, JSON.stringify(snapshots), Date.now());
  }

  failure(bundle: DigestBundle, passes: PassName[], phase: string, message: string): { outage: DrainOutage; first: boolean } {
    return this.db.raw.transaction(() => {
      const previous = this.outage();
      const first = !this.hasSession(bundle.sessionId);
      const failures = Math.min(8, (previous?.failures ?? 0) + 1);
      const outage = {
        retryAt: Date.now() + Math.min(6 * 60 * 60_000, 5 * 60_000 * 2 ** (failures - 1)),
        failures, occurrences: Math.min(100, (previous?.occurrences ?? 0) + 1), phase, message,
      };
      this.save(bundle, passes, true);
      this.db.prepare(`INSERT INTO organism_provider_outage(id,retry_at,failures,occurrences,phase,message) VALUES (1,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET retry_at=excluded.retry_at,failures=excluded.failures,
        occurrences=excluded.occurrences,phase=excluded.phase,message=excluded.message`)
        .run(outage.retryAt, outage.failures, outage.occurrences, outage.phase, outage.message);
      return { outage, first };
    }).immediate();
  }

  defer(bundle: DigestBundle, passes: PassName[]): { outage: DrainOutage; first: boolean } | undefined {
    return this.db.raw.transaction(() => {
      const outage = this.outage();
      if (!outage) return undefined;
      const first = !this.hasSession(bundle.sessionId);
      this.save(bundle, passes, false);
      outage.occurrences = Math.min(100, outage.occurrences + 1);
      this.db.prepare("UPDATE organism_provider_outage SET occurrences=? WHERE id=1").run(outage.occurrences);
      return { outage, first };
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

  next(): DeferredDrain | undefined {
    const row = this.db.prepare("SELECT session_id FROM organism_deferred_drain ORDER BY created_at,session_id LIMIT 1").get() as { session_id: string } | undefined;
    return row ? this.snapshots(row.session_id)[0] : undefined;
  }

  finish(bundle: DigestBundle): void {
    this.db.raw.transaction(() => {
      const snapshots = this.snapshots(bundle.sessionId);
      const key = JSON.stringify(bundle);
      const remaining = snapshots.filter(item => JSON.stringify(item.bundle) !== key);
      if (remaining.length) this.db.prepare("UPDATE organism_deferred_drain SET snapshots=? WHERE session_id=?").run(JSON.stringify(remaining), bundle.sessionId);
      else this.db.prepare("DELETE FROM organism_deferred_drain WHERE session_id=?").run(bundle.sessionId);
    }).immediate();
  }
}

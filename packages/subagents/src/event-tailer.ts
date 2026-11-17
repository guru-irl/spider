import { bus } from "@spider/db-core";
import type { Db } from "@spider/db-core";
import { isLocalRun } from "./roam-origin";

// A paused parent may have an arbitrarily large tracked backlog. Bound each
// tick before reading payloads and seek only the runs this tailer owns.
const POLL_ROW_LIMIT = 200;
interface EventDbRow {
  session_id: string;
  ts: number;
  type: string;
  tool: string | null;
  summary: string | null;
  payload: string | null;
}

export class RunEventTailer {
  private tracked = new Set<string>();
  private terminalPending = new Set<string>();
  private holds = new Map<string, number>();
  private lastId = 0;
  private timer: NodeJS.Timeout | null = null;

  /** `sinceId` resumes a stopped tailer's position (reload), so events written in the gap replay. */
  constructor(private db: Db, private opts: { intervalMs?: number; sinceId?: number } = {}) {
    const row = db.prepare(`SELECT COALESCE(MAX(id),0) AS m FROM run_events`).get() as any;
    this.lastId = opts.sinceId !== undefined ? Math.min(opts.sinceId, row.m ?? 0) : row.m ?? 0;
  }

  /** Id of the last event this tailer has read. */
  get cursor(): number { return this.lastId; }

  track(runId: string): void {
    this.tracked.add(runId);
  }

  untrack(runId: string): void {
    this.tracked.delete(runId);
    this.terminalPending.delete(runId);
  }

  /** A live child can still write rows after a provisional or final status. */
  hold(runId: string): () => void {
    this.holds.set(runId, (this.holds.get(runId) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const count = this.holds.get(runId) ?? 0;
      if (count <= 1) this.holds.delete(runId);
      else this.holds.set(runId, count - 1);
    };
  }

  poll(): void {
    if (this.tracked.size === 0) return;
    // json_each avoids SQLite's bound-variable limit when many runs are tracked.
    const rows = this.db.prepare(`SELECT id, run_id FROM run_events
      WHERE run_id IN (SELECT value FROM json_each(?)) AND id > ? ORDER BY id LIMIT ?`)
      .all(JSON.stringify([...this.tracked]), this.lastId, POLL_ROW_LIMIT) as { id: number; run_id: string }[];
    const detail = this.db.prepare(`SELECT session_id, ts, type, tool, summary, payload FROM run_events WHERE id = ?`);
    for (const row of rows) {
      this.lastId = row.id;
      if (!this.tracked.has(row.run_id) || !isLocalRun(this.db, row.run_id)) continue;
      const r = detail.get(row.id) as EventDbRow | undefined;
      if (!r) continue; // Another process may have pruned the event since the page read.
      const payload = r.payload ? JSON.parse(r.payload) : undefined;
      bus.emit({ runId: row.run_id, sessionId: r.session_id, ts: r.ts, type: r.type, tool: r.tool ?? undefined, summary: r.summary ?? undefined, payload });
      if (r.type === "status" && ["done", "failed", "cancelled"].includes(payload?.status)) this.terminalPending.add(row.run_id);
    }
    if (this.terminalPending.size === 0) return;
    const status = this.db.prepare(`SELECT status FROM runs WHERE id = ?`);
    const remaining = this.db.prepare(`SELECT 1 FROM run_events WHERE run_id = ? AND id > ? LIMIT 1`);
    for (const runId of this.terminalPending) {
      if (this.holds.has(runId)) continue;
      const current = status.get(runId) as { status: string } | undefined;
      if (!current || !["done", "failed", "cancelled"].includes(current.status)) {
        this.terminalPending.delete(runId);
      } else if (!remaining.get(runId, this.lastId)) {
        this.untrack(runId);
      }
    }
  }

  start(): void {
    if (!this.timer) {
      this.timer = setInterval(() => this.poll(), this.opts.intervalMs ?? 250);
      this.timer.unref?.();
    }
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

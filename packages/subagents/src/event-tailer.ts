import { bus } from "@spider/db-core";
import type { Db } from "@spider/db-core";
import { isLocalRun } from "./roam-origin";

// A paused parent may have an arbitrarily large cross-process backlog. Bound
// each tick before reading payloads, including rows belonging to other runs.
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
  }

  poll(): void {
    if (this.tracked.size === 0) return;
    const rows = this.db.prepare(`SELECT id, run_id FROM run_events WHERE id > ? ORDER BY id LIMIT ?`)
      .all(this.lastId, POLL_ROW_LIMIT) as { id: number; run_id: string | null }[];
    const detail = this.db.prepare(`SELECT session_id, ts, type, tool, summary, payload FROM run_events WHERE id = ?`);
    for (const row of rows) {
      this.lastId = row.id;
      if (!row.run_id || !this.tracked.has(row.run_id) || !isLocalRun(this.db, row.run_id)) continue;
      const r = detail.get(row.id) as EventDbRow | undefined;
      if (!r) continue; // Another process may have pruned the event since the page read.
      const payload = r.payload ? JSON.parse(r.payload) : undefined;
      bus.emit({ runId: row.run_id, sessionId: r.session_id, ts: r.ts, type: r.type, tool: r.tool ?? undefined, summary: r.summary ?? undefined, payload });
      if (r.type === "status" && ["done", "failed", "cancelled"].includes(payload?.status)) this.untrack(row.run_id);
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

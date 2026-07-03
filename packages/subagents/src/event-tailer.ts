import { bus } from "@spider/db-core";
import type { Db } from "@spider/db-core";

export class RunEventTailer {
  private tracked = new Set<string>();
  private lastId = 0;
  private timer: NodeJS.Timeout | null = null;

  constructor(private db: Db, private opts: { intervalMs?: number } = {}) {
    const row = db.prepare(`SELECT COALESCE(MAX(id),0) AS m FROM run_events`).get() as any;
    this.lastId = row.m ?? 0;
  }

  track(runId: string): void {
    this.tracked.add(runId);
  }

  untrack(runId: string): void {
    this.tracked.delete(runId);
  }

  poll(): void {
    if (this.tracked.size === 0) return;
    const rows = this.db.prepare(`SELECT * FROM run_events WHERE id > ? ORDER BY id`).all(this.lastId) as any[];
    for (const r of rows) {
      this.lastId = Math.max(this.lastId, r.id);
      if (!r.run_id || !this.tracked.has(r.run_id)) continue;
      bus.emit({ runId: r.run_id, sessionId: r.session_id, ts: r.ts, type: r.type, tool: r.tool ?? undefined, summary: r.summary ?? undefined, payload: r.payload ? JSON.parse(r.payload) : undefined });
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

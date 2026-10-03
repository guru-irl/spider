import type { UsageSinkFactory } from "@spider/models";
import { openDb, type Db } from "@spider/db-core";
import { recordRunUsage, reportRunUsage, RunStore, sumUsage, getShared, type UsageLike as Usage, type ModelUsage, type RunRow } from "@spider/subagents";

interface SessionManager {
  getSessionId(): string;
  getEntries?: () => Array<{ type: string; kind?: string; provider?: string; model?: string; note?: string }>;
  appendUsage?: (kind: string, provider: string, model: string, usage: Usage, note?: string) => unknown;
}
// Pending aux calls survive an extension reload. Runs stay pending in run_events, not here.
const pendingKey = Symbol.for("spider.pending-aux-usage");
const shared = globalThis as typeof globalThis & { [pendingKey]?: Map<string, Usage[]> };
const pending = shared[pendingKey] ??= new Map<string, Usage[]>();

export class UsageAccounting {
  private manager?: SessionManager;
  private sessionId = "";
  private generation = 0;
  activate(ctx: unknown): void {
    const manager = (ctx as { sessionManager?: SessionManager } | undefined)?.sessionManager;
    const id = manager?.getSessionId() ?? "";
    if (id !== this.sessionId || manager !== this.manager) this.generation++;
    this.manager = manager; this.sessionId = id;
  }
  shutdown(): void { this.generation++; this.manager = undefined; this.sessionId = ""; }
  private owns(sessionId: string): boolean { return !!sessionId && this.manager?.getSessionId() === sessionId; }

  factory(sessionId: string): UsageSinkFactory {
    return purpose => {
      // Bind identity at invocation, never at resolution of an async model response.
      if (!this.owns(sessionId)) return undefined;
      const generation = this.generation;
      const child = process.env.PI_SUBAGENT_CHILD === "1"
        ? { runId: process.env.PI_SUBAGENT_RUN_ID, dbPath: process.env.PI_SPIDER_DB_PATH, owner: process.env.PI_SPIDER_SESSION_ID } : undefined;
      return record => {
        if (generation !== this.generation || !this.owns(sessionId)) return;
        if (child) {
          if (!child.runId || !child.dbPath) return;
          const db = openDb(child.dbPath, { fileMustExist: true });
          try {
            const run = new RunStore(db).get(child.runId);
            if (run?.pid === process.pid && (!child.owner || run.session_id === child.owner)) recordRunUsage(db, child.runId, record, purpose);
          } finally { db.close(); }
          return;
        }
        if (this.append(sessionId, "spider-aux", [record], purpose)) return;
        const items = pending.get(sessionId) ?? []; items.push(record.usage); pending.set(sessionId, items);
      };
    };
  }

  private append(sessionId: string, kind: string, records: ModelUsage[], note: string): boolean {
    const sm = this.manager;
    if (!this.owns(sessionId) || typeof sm?.appendUsage !== "function") return false;
    for (const record of records) {
      // Session JSONL and the run DB cannot share a transaction. Recover a partial append
      // by its durable run note before writing the run-level marker on retry.
      const written = kind === "subagent" && sm.getEntries?.().some(entry => entry.type === "usage" && entry.kind === kind && entry.note === note && entry.provider === record.provider && entry.model === record.model);
      if (!written) sm.appendUsage(kind, record.provider, record.model, record.usage, note);
    }
    return true;
  }

  reportRun(db: Db, run: RunRow): void {
    if (!this.owns(run.session_id)) return;
    reportRunUsage(db, run, (row, records) => this.append(row.session_id, "subagent", records, `${row.name ?? row.agent} (${row.id})`));
  }

  private unreportedRuns(db: Db, sessionId: string): RunRow[] {
    const candidates = (db.prepare(`SELECT id, session_id, status, name, agent, COALESCE(events.has_usage, 0) AS has_usage FROM runs r
      LEFT JOIN (SELECT run_id, MAX(type='spider_usage') AS has_usage, MAX(type='spider_usage_reported') AS reported
        FROM run_events WHERE type IN ('spider_usage','spider_usage_reported') AND run_id IS NOT NULL GROUP BY run_id) events ON events.run_id=r.id
      WHERE session_id=? AND status IN ('done','failed','cancelled') AND COALESCE(events.reported, 0)=0`)
      .all(sessionId) as Array<RunRow & { has_usage: number }>).filter(row => !getShared(row.id));
    const legacy = candidates.filter(row => !row.has_usage);
    if (legacy.length) db.transaction(() => {
      // Recheck under the write lock: another host may have added usage or markers
      // since classification. Newly priced runs stay unmarked for the next pass.
      const insert = db.prepare(`INSERT INTO run_events (run_id, session_id, ts, type)
        SELECT r.id, r.session_id, ?, 'spider_usage_reported' FROM runs r
        WHERE r.id IN (SELECT value FROM json_each(?))
          AND r.id NOT IN (SELECT run_id FROM run_events
            WHERE type IN ('spider_usage','spider_usage_reported') AND run_id IS NOT NULL)`);
      const ts = Date.now(), ids = JSON.stringify(legacy.map(row => row.id));
      db.withRetry(() => insert.run(ts, ids));
    })();
    return candidates.filter(row => row.has_usage);
  }

  restore(db: Db, sessionId: string): void {
    if (!this.owns(sessionId) || typeof this.manager?.appendUsage !== "function") return;
    for (const row of this.unreportedRuns(db, sessionId)) this.reportRun(db, row);
  }

  /** Only the next spider result in this session drains fallback usage. */
  takeFallback(db: Db, sessionId: string): Usage | undefined {
    if (!this.owns(sessionId)) return undefined;
    const items = pending.get(sessionId) ?? [];
    const rows = this.unreportedRuns(db, sessionId);
    if (!rows.length && !items.length) return undefined;
    // Earlier rows may commit before a later DB error. Retain their usage for retry.
    pending.set(sessionId, items);
    for (const row of rows) {
      reportRunUsage(db, row, (run, records) => {
        if (!this.owns(run.session_id)) return false;
        if (typeof this.manager?.appendUsage === "function") return this.append(run.session_id, "subagent", records, `${run.name ?? run.agent} (${run.id})`);
        items.push(...records.map(r => r.usage)); return true;
      });
    }
    pending.delete(sessionId);
    return items.length ? sumUsage(items) : undefined;
  }
}

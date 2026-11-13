import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { openDbAt, type Db } from "@spider/db-core";
import { runUsageSummary } from "../../../subagents/src/usage";
import { genuineCompletion, summarizeCompletionEvents } from "../../../subagents/src/completion-output";
import { lastActivityOf } from "../../../subagents/src/kill";
import { listSessionBlockers } from "../../../subagents/src/blockers";
import { discoverDurableChildren, diagnoseDurableChildren } from "../../../subagents/src/durable-adoption";
import { createRunSource } from "../agents/run-source";
import { WARNINGS_QUERY, SUPERVISED_QUERY, CLAIM_COMPLETION_QUERY } from "../../../subagents/src/actions/run";
import { CHAIN_STEPS_QUERY, CHAIN_WARNINGS_QUERY } from "../../../subagents/src/child-registry";
import { UNDELIVERED_RUN_QUERY } from "../../../subagents/src/runner";
import { CLAIM_USAGE_QUERY } from "../../../subagents/src/usage";
import { RECORDED_TRANSCRIPT_QUERY } from "../herdr/mount";
import { TRANSCRIPT_QUERY, EVENT_MAX_ID_QUERY, PREVIOUS_MESSAGES_QUERY, PENDING_MESSAGE_QUERY, FOLLOW_EVENTS_QUERY, UNREAD_EVENTS_QUERY } from "../herdr/run-transcript";

const OTHER_QUERIES = [WARNINGS_QUERY, SUPERVISED_QUERY, CLAIM_COMPLETION_QUERY, CHAIN_STEPS_QUERY,
  CHAIN_WARNINGS_QUERY, UNDELIVERED_RUN_QUERY, CLAIM_USAGE_QUERY, RECORDED_TRANSCRIPT_QUERY,
  TRANSCRIPT_QUERY, EVENT_MAX_ID_QUERY, PREVIOUS_MESSAGES_QUERY, PENDING_MESSAGE_QUERY, FOLLOW_EVENTS_QUERY, UNREAD_EVENTS_QUERY];
// An exact event ID can use the primary key; run-range queries must use the run index.
const EXACT_EVENT_QUERIES = [PENDING_MESSAGE_QUERY];

function usesRunIndex(details: string, count = 1): boolean {
  const lookups = details.match(/SEARCH run_events(?: EXISTS)? USING (?:COVERING )?INDEX idx_run_events_run_id \(run_id=\?/g) ?? [];
  return lookups.length === count && !/SCAN run_events\b/.test(details);
}

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function observedQueries(db: Db): string[] {
  const queries: string[] = [];
  const observed = new Proxy(db, { get(target, key) {
    if (key === "prepare") return (sql: string) => {
      if (/FROM\s+run_events\s+WHERE\s+run_id\s*=\s*\?/i.test(sql)) queries.push(sql);
      return target.prepare(sql);
    };
    return Reflect.get(target, key);
  } });
  const listEvents = createRunSource(observed, "session").listEvents;
  expect(listEvents).toBeDefined();
  listEvents!("run");
  runUsageSummary(observed, "run");
  genuineCompletion(observed, "run");
  summarizeCompletionEvents(observed, "run");
  lastActivityOf(observed, "run");
  return queries;
}

function observedCorrelatedQueries(db: Db): string[] {
  const queries: string[] = [];
  const observed = new Proxy(db, { get(target, key) {
    if (key === "prepare") return (sql: string) => {
      if (/\b(?:FROM|JOIN)\s+run_events\b/i.test(sql)) queries.push(sql);
      return target.prepare(sql);
    };
    return Reflect.get(target, key);
  } });
  listSessionBlockers(observed, "session");
  discoverDurableChildren({ db: observed, sessionId: "session" });
  diagnoseDurableChildren({ db: observed, sessionId: "session" });
  return queries;
}

describe("per-run event query plans", () => {
  it.each([false, true])("search real prepared queries on open (existing=%s)", existing => {
    const scratch = join(process.cwd(), ".spider", "scratch");
    mkdirSync(scratch, { recursive: true });
    const root = mkdtempSync(join(scratch, "run-event-plan-")); roots.push(root);
    const file = join(root, "project.db");
    if (existing) {
      const previous = openDbAt(file, "worktree");
      previous.exec("DROP INDEX IF EXISTS idx_run_events_run_id");
      previous.close();
    }
    const db = openDbAt(file, "worktree");
    try {
      const queries = observedQueries(db);
      expect(queries).toHaveLength(5);
      const plans = queries.map(sql => ({ sql, details: (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all("run") as { detail: string }[]).map(row => row.detail).join(" ") }));
      const otherPlans = OTHER_QUERIES.map(sql => {
        const bindings = Array.from({ length: (sql.match(/\?/g) ?? []).length }, () => "run");
        const details = (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...bindings) as { detail: string }[]).map(row => row.detail).join(" | ");
        return { sql, details };
      });
      const unindexed = [
        ...plans.filter(({ details }) => !usesRunIndex(details)),
        ...otherPlans.filter(({ sql, details }) => {
          if (EXACT_EVENT_QUERIES.includes(sql)) {
            return !/\bid\s*=\s*\?/.test(sql) ||
              (!usesRunIndex(details) && !/SEARCH run_events USING INTEGER PRIMARY KEY/.test(details)) || /SCAN run_events\b/.test(details);
          }
          return !usesRunIndex(details, sql === UNDELIVERED_RUN_QUERY ? 2 : 1);
        }),
      ];
      const correlated = observedCorrelatedQueries(db);
      expect(correlated).toHaveLength(3);
      const correlatedPlans = correlated.map(sql => {
        const bindings = Array.from({ length: (sql.match(/\?/g) ?? []).length }, () => "session");
        const details = (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...bindings) as { detail: string }[]).map(row => row.detail).join(" | ");
        return { sql, details };
      });
      const indexedLookups = correlatedPlans.map(({ details }) => (details.match(/SEARCH (?:e|delivered) USING INDEX idx_run_events_run_id \(run_id=\?\)/g) ?? []).length);
      expect({ unindexed, indexedLookups }).toEqual({ unindexed: [], indexedLookups: [2, 2, 1] });
      expect(correlatedPlans.filter(({ details }) => /SCAN (?:run_events|e|delivered)\b/.test(details))).toEqual([]);
      db.exec("DROP INDEX idx_run_events_run_id");
      const withoutIndex = [...queries, ...OTHER_QUERIES.filter(sql => !EXACT_EVENT_QUERIES.includes(sql))];
      for (const sql of withoutIndex) {
        const bindings = Array.from({ length: (sql.match(/\?/g) ?? []).length }, () => "run");
        const details = (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...bindings) as { detail: string }[]).map(row => row.detail).join(" | ");
        expect(usesRunIndex(details, sql === UNDELIVERED_RUN_QUERY ? 2 : 1)).toBe(false);
      }
      for (const sql of correlated) {
        const bindings = Array.from({ length: (sql.match(/\?/g) ?? []).length }, () => "session");
        const details = (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...bindings) as { detail: string }[]).map(row => row.detail).join(" | ");
        expect(details).not.toContain("idx_run_events_run_id");
      }
    } finally { db.close(); }
  });
});

import type { Db } from "@spider/db-core";
import { randomUUID } from "node:crypto";
import { safeReviewError } from "@spider/memory";
import { SkillStore } from "./skill-usage.js";
import { reviewSkillCandidate, stageReviewedSkill, type SkillReviewOptions, type SkillReviewCandidate, type ReviewedSkillResult } from "./skill-review.js";
import type { SkillCandidate } from "./types.js";
interface QueuedSkill { name: string; category: string | null; body: string; origin: SkillReviewCandidate["origin"]; related: string | null; created_at: number; attempts: number; last_error: string | null }
interface QueueOptions extends SkillReviewOptions { onDeferred?: (retryAt: number) => void }
export function enqueueSkillReview(db: Db, candidate: SkillCandidate): boolean {
  return db.prepare(`INSERT OR IGNORE INTO skill_review_queue(name,category,body,origin,related,created_at) VALUES (?,?,?,'learner',?,?)`)
    .run(candidate.name, candidate.category ?? null, candidate.body, JSON.stringify(candidate.related ?? []), Date.now()).changes > 0;
}
export function skillReviewQueueStatus(db: Db): { pending: number; recent: Array<{ name: string; verdict: string; reason: string }> } {
  // Read-only diagnostics tolerate pre-v12 stores.
  if (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='skill_review_queue'").get()) return { pending: 0, recent: [] };
  return {
    pending: (db.prepare("SELECT count(*) n FROM skill_review_queue").get() as { n: number }).n,
    recent: db.prepare("SELECT name,verdict,reason FROM skill_review_results ORDER BY id DESC LIMIT 5").all() as Array<{ name: string; verdict: string; reason: string }>,
  };
}
/** Caller owns the live-session signal. A DB lease serializes independent handles
 * and processes; a crashed owner expires after the maximum in-flight review budget. */
export async function runSkillReviewQueue(db: Db, opts: QueueOptions): Promise<void> {
  if (process.env.PI_SUBAGENT_CHILD === "1" || !opts.reviewer || opts.signal?.aborted) return;
  // Organism-owned state is created lazily so older sessions can still open the repo DB.
  db.exec(`CREATE TABLE IF NOT EXISTS skill_review_outage (
    id INTEGER PRIMARY KEY CHECK (id=1), retry_at INTEGER NOT NULL, failures INTEGER NOT NULL
  )`);
  const store = new SkillStore(db);
  const owner = randomUUID();
  const ms = typeof opts.timeoutMs === "number" && Number.isInteger(opts.timeoutMs) && opts.timeoutMs >= 1000 && opts.timeoutMs <= 600000 ? opts.timeoutMs : 180000;
  const leaseUntil = () => Date.now() + ms + 5000;
  const renew = () => db.prepare("UPDATE skill_review_lock SET lease_until=? WHERE id=1 AND token=?").run(leaseUntil(), owner).changes > 0;
  const ownsLease = () => db.prepare("UPDATE skill_review_lock SET lease_until=lease_until WHERE id=1 AND token=?").run(owner).changes > 0;
  const acquired = db.raw.transaction(() => {
    db.prepare("INSERT OR IGNORE INTO skill_review_lock(id,token,lease_until) VALUES (1,'',0)").run();
    return db.prepare("UPDATE skill_review_lock SET token=?,lease_until=? WHERE id=1 AND lease_until<=?").run(owner, leaseUntil(), Date.now()).changes > 0;
  }).immediate();
  if (!acquired) {
    const lease = db.prepare("SELECT lease_until FROM skill_review_lock WHERE id=1").get() as { lease_until: number } | undefined;
    try { opts.onDeferred?.(Math.max(Date.now() + 1, lease?.lease_until ?? 0)); } catch { /* Scheduling is secondary. */ }
    return;
  }
  // Must be called in the same immediate transaction as staging and the fence.
  const record = (item: QueuedSkill, result: ReviewedSkillResult) => {
    if (result.reviewSkipped) {
      const attempts = item.attempts + 1;
      if (attempts < 3) {
        db.prepare("UPDATE skill_review_queue SET attempts=?,last_error=? WHERE name=?").run(attempts, result.reviewSkipped.slice(0, 500), item.name);
        return;
      }
      db.prepare("INSERT INTO skill_review_results(name,verdict,reason,created_at) VALUES (?,?,?,?)").run(item.name, "review_skipped", `dropped after 3 attempts: ${result.reviewSkipped}`.slice(0, 500), Date.now());
    } else {
      const verdict = result.verdict === "new" && result.outcome !== "staged" ? "new_not_staged" : result.verdict ?? "store_skipped";
      db.prepare("INSERT INTO skill_review_results(name,verdict,reason,created_at) VALUES (?,?,?,?)").run(item.name, verdict, (result.reason ?? "not newly staged").slice(0, 500), Date.now());
    }
    db.prepare("DELETE FROM skill_review_queue WHERE name=?").run(item.name);
    db.prepare("DELETE FROM skill_review_results WHERE id NOT IN (SELECT id FROM skill_review_results ORDER BY id DESC LIMIT 30)").run();
  };
  try {
    const outage = db.prepare("SELECT retry_at FROM skill_review_outage WHERE id=1").get() as { retry_at: number } | undefined;
    if (outage && outage.retry_at > Date.now()) {
      try { opts.onDeferred?.(outage.retry_at); } catch { /* Scheduling is secondary. */ }
      return;
    }
    const items = db.prepare("SELECT * FROM skill_review_queue ORDER BY created_at,name").all() as QueuedSkill[];
    for (const item of items) {
      if (opts.signal?.aborted || process.env.PI_SUBAGENT_CHILD === "1") break;
      if (!renew()) break;
      try {
        const candidate: SkillReviewCandidate = { name: item.name, category: item.category ?? undefined, body: item.body, origin: item.origin, related: JSON.parse(item.related ?? "[]") };
        let attempted = false;
        const diagnostics: Array<{ error: string; raw: unknown }> = [];
        const decision = await reviewSkillCandidate(store, candidate, {
          ...opts,
          reviewer: (...args) => { attempted = true; return opts.reviewer!(...args); },
          onReviewError: (error, raw) => { diagnostics.push({ error, raw }); },
        });
        if (opts.signal?.aborted) break;
        let deferredUntil: number | undefined;
        let firstOutage = false;
        const committed = db.raw.transaction(() => {
          if (!ownsLease()) return false;
          if (!db.prepare("SELECT name FROM skill_review_queue WHERE name=?").get(item.name)) return true;
          if ("reviewSkipped" in decision && decision.connectivity) {
            const previous = db.prepare("SELECT failures FROM skill_review_outage WHERE id=1").get() as { failures: number } | undefined;
            const failures = Math.min(8, (previous?.failures ?? 0) + 1);
            deferredUntil = Date.now() + Math.min(6 * 60 * 60_000, 5 * 60_000 * 2 ** (failures - 1));
            firstOutage = !previous;
            db.prepare("INSERT INTO skill_review_outage(id,retry_at,failures) VALUES (1,?,?) ON CONFLICT(id) DO UPDATE SET retry_at=excluded.retry_at,failures=excluded.failures").run(deferredUntil, failures);
            db.prepare("UPDATE skill_review_queue SET last_error=? WHERE name=?").run(decision.reviewSkipped.slice(0, 500), item.name);
          } else {
            if (attempted) db.prepare("DELETE FROM skill_review_outage WHERE id=1").run();
            record(item, stageReviewedSkill(store, candidate, decision));
          }
          return true;
        }).immediate();
        if (!committed) break;
        const diagnostic = diagnostics[0];
        if (diagnostic && (deferredUntil === undefined || firstOutage)) {
          try { opts.onReviewError?.(diagnostic.error, diagnostic.raw); } catch { /* Diagnostics are secondary. */ }
        }
        if (deferredUntil !== undefined) {
          try { opts.onDeferred?.(deferredUntil); } catch { /* Scheduling is secondary. */ }
          return;
        }
      } catch (error) {
        if (opts.signal?.aborted) break;
        const reason = safeReviewError(error);
        const committed = db.raw.transaction(() => {
          if (!ownsLease()) return false;
          record(item, { outcome: "rejected", reviewSkipped: reason });
          return true;
        }).immediate();
        if (!committed) break;
        try { opts.onReviewError?.(`skill review queue ${item.name}: ${reason}`, undefined); } catch { /* Diagnostics are secondary. */ }
      }
    }
  } finally {
    db.prepare("UPDATE skill_review_lock SET token='',lease_until=0 WHERE id=1 AND token=?").run(owner);
  }
}

import type { Db } from "@spider/db-core";
import { randomUUID } from "node:crypto";
import { safeReviewError } from "@spider/memory";
import { SkillStore } from "./skill-usage.js";
import { reviewSkillCandidate, stageReviewedSkill, type SkillReviewOptions, type SkillReviewCandidate, type ReviewedSkillResult } from "./skill-review.js";
import type { SkillCandidate } from "./types.js";
interface QueuedSkill { name: string; category: string | null; body: string; origin: SkillReviewCandidate["origin"]; related: string | null; created_at: number; attempts: number; last_error: string | null }
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
export async function runSkillReviewQueue(db: Db, opts: SkillReviewOptions): Promise<void> {
  if (process.env.PI_SUBAGENT_CHILD === "1" || !opts.reviewer || opts.signal?.aborted) return;
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
  if (!acquired) return;
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
    const items = db.prepare("SELECT * FROM skill_review_queue ORDER BY created_at,name").all() as QueuedSkill[];
    for (const item of items) {
      if (opts.signal?.aborted || process.env.PI_SUBAGENT_CHILD === "1") break;
      if (!renew()) break;
      try {
        const candidate: SkillReviewCandidate = { name: item.name, category: item.category ?? undefined, body: item.body, origin: item.origin, related: JSON.parse(item.related ?? "[]") };
        const decision = await reviewSkillCandidate(store, candidate, opts);
        if (opts.signal?.aborted) break;
        const committed = db.raw.transaction(() => {
          if (!ownsLease()) return false;
          if (!db.prepare("SELECT name FROM skill_review_queue WHERE name=?").get(item.name)) return true;
          record(item, stageReviewedSkill(store, candidate, decision));
          return true;
        }).immediate();
        if (!committed) break;
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

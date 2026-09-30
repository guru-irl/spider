import type { Db, ProjectInfo } from "@spider/db-core";
import { stageWrite } from "@spider/memory";
import type { MemoryScope } from "@spider/memory";
import { addTodo } from "@spider/todo";
import { SkillStore } from "./skill-usage.js";
import { checkSkillCandidate, countSkillRejection, type SkillReviewOptions } from "./skill-review.js";
import type { AppliedSummary, DigestResult, WriteBudget } from "./types.js";
import { enqueueSkillReview } from "./skill-review-queue.js";
import { isSupportedMemoryCandidate } from "./memory-candidate.js";

export interface ApplyDeps {
  db: Db;           // repo DB: memory, skills
  globalDb: Db;
  worktreeDb: Db;   // worktree DB: todos, sessions
  scope: MemoryScope;
  sessionId: string;
  skills: SkillStore;
  project: ProjectInfo;
  skillReview?: SkillReviewOptions;
  maxSkillProposals?: number;
}

/**
 * Fail-closed staged writer. Routes every digest candidate through the
 * write-approval pipeline under a shared per-session {@link WriteBudget}:
 *
 *   - Memory stages & skill queue inserts each cost 1 budget unit. When
 *     `budget.used >= budget.max`, remaining stageable candidates are DROPPED
 *     (counted, never silently discarded).
 *   - Memory goes through `stageWrite(source:"auto", autoStage:true)`. A
 *     `status:"rejected"` result increments `rejected` and consumes NO budget.
 *   - Skills go through deterministic checks, a proposal cap, and durable queuing.
 *     Live-session reviews stage only new; unavailable reviews fail closed. The store is also fail-closed against
 *     downgrading an active/pinned/protected/user-owned skill or re-counting
 *     a byte-identical duplicate proposal; a skip consumes no budget and is
 *     counted under `rejected`, not `skillsStaged`.
 *   - Todos are cheap: not budget-limited, but still counted.
 *
 * Iteration order (memory THEN skills) is significant for budget exhaustion.
 * `summary`/`selfName` are persisted by the worker (Task 14), not here.
 */
export async function applyDigest(deps: ApplyDeps, result: DigestResult, budget: WriteBudget): Promise<AppliedSummary> {
  const summary: AppliedSummary = { memoryStaged: 0, todosAdded: 0, skillsStaged: 0, dropped: 0, rejected: 0 };

  for (const cand of result.memory) {
    if (!isSupportedMemoryCandidate(cand)) {
      summary.rejected++;
      continue;
    }
    if (budget.used >= budget.max) {
      summary.dropped++;
      continue;
    }
    const res = stageWrite(
      cand.scope === "global" ? deps.globalDb : deps.db,
      cand.scope,
      {
        category: cand.category,
        content: cand.content,
        justification: cand.justification,
        evidence: cand.evidence,
        link: cand.link ?? null,
        confidence: cand.confidence ?? null,
        source: "auto",
        sessionId: deps.sessionId,
      },
      { autoStage: true, verifiedUserQuote: cand.verifiedUserQuote === true }
    );
    if (res.status === "rejected") {
      summary.rejected++;
      continue;
    }
    summary.memoryStaged++;
    budget.used++;
  }

  let validSkillProposals = 0;
  for (const cand of result.skills) {
    const check = checkSkillCandidate(cand);
    if (!check.ok) {
      summary.rejected++;
      countSkillRejection(summary, { outcome: "rejected", verdict: "deterministic_failure", reason: check.reason });
      continue;
    }
    if (validSkillProposals++ >= (deps.maxSkillProposals ?? 1)) {
      summary.dropped++;
      summary.skillCapDropped = (summary.skillCapDropped ?? 0) + 1;
      continue;
    }
    const existing = deps.skills.get(cand.name);
    const storeSkip = existing && (existing.protected ? "protected" : existing.pinned ? "pinned" : existing.status === "active" ? "active" : existing.source !== "auto" ? "user-owned" : existing.status === "staged" && existing.candidateBody === cand.body ? "duplicate" : undefined);
    if (storeSkip) {
      summary.rejected++;
      countSkillRejection(summary, { outcome: "skipped", reason: storeSkip });
      continue;
    }
    if (budget.used >= budget.max) {
      summary.dropped++;
      continue;
    }
    if (!deps.skillReview?.reviewer) {
      summary.rejected++;
      countSkillRejection(summary, { outcome: "rejected", reviewSkipped: deps.skillReview?.skipReason ?? "reviewer unavailable" });
      continue;
    }
    if (enqueueSkillReview(deps.db, cand)) {
      summary.skillsQueued = (summary.skillsQueued ?? 0) + 1;
      budget.used++;
    } else {
      summary.rejected++;
      countSkillRejection(summary, { outcome: "skipped", reason: "candidate already queued" });
    }

  }

  for (const t of result.todos) {
    addTodo(deps.worktreeDb, deps.sessionId, t.text);
    summary.todosAdded++;
  }

  return summary;
}

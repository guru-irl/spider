import type { Db, ProjectInfo } from "@spider/db-core";
import { stageWrite } from "@spider/memory";
import type { MemoryScope } from "@spider/memory";
import { addTodo } from "@spider/todo";
import { SkillStore } from "./skill-usage.js";
import type { AppliedSummary, DigestResult, WriteBudget } from "./types.js";

export interface ApplyDeps {
  db: Db;           // repo DB: memory, skills
  globalDb: Db;
  worktreeDb: Db;   // worktree DB: todos, sessions
  scope: MemoryScope;
  sessionId: string;
  skills: SkillStore;
  project: ProjectInfo;
}

/**
 * Fail-closed staged writer. Routes every digest candidate through the
 * write-approval pipeline under a shared per-session {@link WriteBudget}:
 *
 *   - Memory & skill *stages* each cost 1 budget unit. When
 *     `budget.used >= budget.max`, remaining stageable candidates are DROPPED
 *     (counted, never silently discarded).
 *   - Memory goes through `stageWrite(source:"auto", autoStage:true)`. A
 *     `status:"rejected"` result increments `rejected` and consumes NO budget.
 *   - Skills go through `skills.stageCandidate`, which is fail-closed against
 *     downgrading an active/pinned/protected/user-owned skill or re-counting
 *     a byte-identical duplicate proposal; a skip consumes no budget and is
 *     counted under `rejected`, not `skillsStaged`.
 *   - Todos are cheap: not budget-limited, but still counted.
 *
 * Iteration order (memory THEN skills) is significant for budget exhaustion.
 * `summary`/`selfName` are persisted by the worker (Task 14), not here.
 */
export function applyDigest(deps: ApplyDeps, result: DigestResult, budget: WriteBudget): AppliedSummary {
  const summary: AppliedSummary = { memoryStaged: 0, todosAdded: 0, skillsStaged: 0, dropped: 0, rejected: 0 };

  for (const cand of result.memory) {
    if (budget.used >= budget.max) {
      summary.dropped++;
      continue;
    }
    const res = stageWrite(
      deps.db,
      deps.scope,
      {
        category: cand.category,
        content: cand.content,
        link: cand.link ?? null,
        confidence: cand.confidence ?? null,
        source: "auto",
        sessionId: deps.sessionId,
      },
      { autoStage: true }
    );
    if (res.status === "rejected") {
      summary.rejected++;
      continue;
    }
    summary.memoryStaged++;
    budget.used++;
  }

  for (const cand of result.skills) {
    if (budget.used >= budget.max) {
      summary.dropped++;
      continue;
    }
    const res = deps.skills.stageCandidate({
      name: cand.name,
      category: cand.category,
      body: cand.body,
      related: cand.related,
    });
    if (res.outcome === "staged") {
      summary.skillsStaged++;
      budget.used++;
    } else {
      // protected/pinned/active/user-owned/duplicate: no write happened,
      // so this is neither a new stage nor a budget-exhaustion drop.
      summary.rejected++;
    }
  }

  for (const t of result.todos) {
    addTodo(deps.worktreeDb, deps.sessionId, t.text);
    summary.todosAdded++;
  }

  return summary;
}

import type { Db, ProjectInfo } from "@spider/db-core";
import type { Embedder } from "@spider/memory";
import { emitLog } from "@spider/subagents";
import { drainSession } from "./drain.js";
import { applyDigest } from "./apply.js";
import { SkillStore } from "./skill-usage.js";
import {
  runCuratorDecay,
  curatorShouldRun,
  consolidateSkills,
  type CuratorConfig,
  type DecayResult,
} from "./curator.js";
import { buildLearningGraph } from "./learning-graph.js";
import { runMemoryTodoPass } from "./passes/run-memory-todo.js";
import { todoMemoryPass } from "./passes/todo-memory.js";
import { learningPass } from "./passes/learning.js";
import { consolidationPass } from "./passes/consolidation.js";
import { reflectionPass } from "./passes/reflection.js";
import { emptyResult } from "./types.js";
import type { AppliedSummary, DigestModel, DigestResult, DrainReason } from "./types.js";
import type { OrganismConfig } from "./config.js";

/** Everything the worker needs to drain a session and curate the skill store. */
export interface WorkerDeps {
  db: Db;  // repo DB: memory, skills, curator_state
  worktreeDb: Db;  // worktree DB: sessions, runs, run_events, events, todos, content
  globalDb: Db;
  project: ProjectInfo;
  getEmbedder: () => Promise<Embedder | null>;
  makeModel: () => DigestModel | null;
  org: OrganismConfig;
  curator: CuratorConfig;
}

function zeroSummary(): AppliedSummary {
  return { memoryStaged: 0, todosAdded: 0, skillsStaged: 0, dropped: 0, rejected: 0 };
}

/**
 * The single in-process autonomic worker. Owns the drain→passes→apply→persist
 * pipeline and the curator decay pass. All public entry points funnel through a
 * single serialized in-flight chain: a second call while one is running is
 * QUEUED (awaits the prior), never run concurrently — so two drains (or a drain
 * and a curate) never race on the same DB.
 */
export class OrganismWorker {
  readonly #deps: WorkerDeps;
  #inflight: Promise<unknown> = Promise.resolve();

  constructor(deps: WorkerDeps) {
    this.#deps = deps;
  }

  /** Chain `fn` after any in-flight work; a rejection never poisons the chain. */
  #serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#inflight.then(fn, fn);
    this.#inflight = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  /**
   * Drain a session into staged memory/todos/skills and persist the
   * consolidation summary/self-name. No-op (zeroed summary) when the master
   * `org.enabled` toggle is off. Never throws on the drain path.
   */
  runDrain(sessionId: string, reason: DrainReason, opts?: { transcriptPath?: string }): Promise<AppliedSummary> {
    return this.#serialize(() => this.#doRunDrain(sessionId, reason, opts));
  }

  /**
   * Run the deterministic curator decay pass. Min-interval gated unless
   * `opts.force`. Optionally runs the aux-model consolidation when
   * `curator.consolidate` and a model is available.
   */
  runCurate(now?: number, opts?: { force?: boolean }): Promise<DecayResult> {
    return this.#serialize(() => this.#doRunCurate(now, opts));
  }

  async #doRunDrain(
    sessionId: string,
    reason: DrainReason,
    opts?: { transcriptPath?: string }
  ): Promise<AppliedSummary> {
    const { db, globalDb, org, project } = this.#deps;
    if (!org.enabled) return zeroSummary();

    const bundle = drainSession(this.#deps.worktreeDb, sessionId, reason, opts);
    const model = this.#deps.makeModel();

    const results: DigestResult[] = [];
    let consolidationResult: DigestResult | undefined;

    // Model-dependent passes are skipped (treated as empty) when no aux model
    // is available. Each is additionally gated by its per-pass toggle. Each pass
    // is isolated in its own try/catch: one throwing aux-model pass is treated
    // as an empty result and the drain CONTINUES with the remaining passes (and,
    // on shutdown, curator decay still runs).
    const runPass = async (fn: () => Promise<DigestResult>): Promise<DigestResult> => {
      try {
        return await fn();
      } catch {
        return emptyResult();
      }
    };
    if (model !== null) {
      if (org.passes.runMemoryTodo) results.push(await runPass(() => runMemoryTodoPass(bundle, model)));
      if (org.passes.todoMemory) results.push(await runPass(() => todoMemoryPass(bundle, model)));
      if (org.passes.learning) results.push(await runPass(() => learningPass(bundle, model)));
      if (org.passes.consolidation) {
        consolidationResult = await runPass(() => consolidationPass(bundle, model));
        results.push(consolidationResult);
      }
      if (org.passes.reflection) {
        const embedder = await this.#deps.getEmbedder();
        results.push(await runPass(() => reflectionPass(db, embedder, model)));
      }
    }

    // Merge: concat candidate lists; summary/selfName come from consolidation.
    const merged: DigestResult = emptyResult();
    for (const r of results) {
      merged.memory.push(...r.memory);
      merged.todos.push(...r.todos);
      merged.skills.push(...r.skills);
    }
    if (consolidationResult !== undefined) {
      merged.summary = consolidationResult.summary;
      merged.selfName = consolidationResult.selfName;
    }

    const summary = applyDigest(
      { db, globalDb, worktreeDb: this.#deps.worktreeDb, scope: "repo", sessionId, skills: new SkillStore(db), project },
      merged,
      { max: org.autoWriteBudget, used: 0 }
    );

    this.#persistConsolidation(sessionId, merged);

    // Refresh the "learning made visible" graph. Side-effecting; never throws
    // on the drain path.
    if (org.passes.insights) {
      try {
        buildLearningGraph(db, globalDb, { persist: true });
      } catch {
        /* best-effort */
      }
    }

    // Best-effort observability breadcrumb for the footer.
    try {
      emitLog(this.#deps.worktreeDb, {
        sessionId,
        summary:
          `organism drain (${reason}): mem=${summary.memoryStaged} todos=${summary.todosAdded} ` +
          `skills=${summary.skillsStaged} dropped=${summary.dropped} rejected=${summary.rejected}`,
        payload: { reason, ...summary },
      });
    } catch {
      /* best-effort */
    }

    return summary;
  }

  /**
   * Persist the consolidation summary/self-name. Every write is guarded — a
   * missing table/column or a bad bind must never throw on the drain path.
   * Treats an empty-slug self-name as NO name (Task 7 carry-forward).
   */
  #persistConsolidation(sessionId: string, merged: DigestResult): void {
    const { worktreeDb, globalDb, org, project } = this.#deps;
    const selfName =
      typeof merged.selfName === "string" && merged.selfName.length > 0 ? merged.selfName : undefined;

    if (selfName !== undefined) {
      try {
        worktreeDb.prepare("UPDATE sessions SET name = ? WHERE id = ?").run(selfName, sessionId);
      } catch {
        /* best-effort */
      }
    }
    if (typeof merged.summary === "string" && merged.summary.length > 0) {
      try {
        worktreeDb.prepare("UPDATE sessions SET summary = ? WHERE id = ?").run(merged.summary, sessionId);
      } catch {
        /* best-effort */
      }
    }

    // Keep sessions_fts in sync only when the FTS table exists (guarded).
    try {
      const row = worktreeDb.prepare("SELECT name, summary FROM sessions WHERE id = ?").get(sessionId) as
        | { name: string | null; summary: string | null }
        | undefined;
      if (row !== undefined) {
        worktreeDb.prepare("DELETE FROM sessions_fts WHERE id = ?").run(sessionId);
        worktreeDb.prepare("INSERT INTO sessions_fts (id, name, summary) VALUES (?, ?, ?)").run(
          sessionId,
          row.name ?? "",
          row.summary ?? ""
        );
      }
    } catch {
      /* best-effort; sessions_fts may not exist */
    }

    // Name the project ONLY when self-naming is on and we would not clobber a
    // user-set (non-empty) projects.name. No-op if the row/table is absent.
    if (org.selfNaming && selfName !== undefined) {
      try {
        globalDb
          .prepare("UPDATE projects SET name = ? WHERE project_key = ? AND (name IS NULL OR name = '')")
          .run(selfName, project.projectKey);
      } catch {
        /* best-effort */
      }
    }
  }

  async #doRunCurate(now?: number, opts?: { force?: boolean }): Promise<DecayResult> {
    const { db, curator } = this.#deps;
    const ts = now ?? Date.now();
    if (opts?.force !== true && !curatorShouldRun(db, ts, curator)) {
      return { toStale: [], toArchived: [], skipped: [] };
    }
    const skills = new SkillStore(db);
    const result = runCuratorDecay(db, skills, ts, curator);
    if (curator.consolidate) {
      const model = this.#deps.makeModel();
      if (model !== null) {
        try {
          await consolidateSkills(skills, model, curator);
        } catch {
          /* best-effort */
        }
      }
    }
    return result;
  }
}

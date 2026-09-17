import type { Db, ProjectInfo } from "@spider/db-core";
import type { Embedder } from "@spider/memory";
import { emitLog } from "@spider/subagents";
import { drainSession, type DrainOpts } from "./drain.js";
import { applyDigest } from "./apply.js";
import { SkillStore } from "./skill-usage.js";
import {
  runCuratorDecay, curatorShouldRun, consolidateSkills,
  type CuratorConfig, type DecayResult,
} from "./curator.js";
import { buildLearningGraph } from "./learning-graph.js";
import { runMemoryTodoPass } from "./passes/run-memory-todo.js";
import { todoMemoryPass } from "./passes/todo-memory.js";
import { learningPass } from "./passes/learning.js";
import { consolidationPass } from "./passes/consolidation.js";
import { reflectionPass } from "./passes/reflection.js";
import { emptyResult } from "./types.js";
import type { AppliedSummary, DigestModel, DigestResult, DrainReason, DrainReport, PassName } from "./types.js";
import type { OrganismConfig } from "./config.js";

export const ORGANISM_DRAIN_TIMEOUT_MS = 30_000;

/** Each worker owns one serialized session/project pipeline. The host owns DB lifetime. */
export interface WorkerDeps {
  db: Db; // repo: memory, skills, curator state
  worktreeDb: Db; // sessions, runs, tracked events, todos
  globalDb: Db;
  project: ProjectInfo;
  getEmbedder: () => Promise<Embedder | null>;
  makeModel: (signal?: AbortSignal) => DigestModel | null;
  org: OrganismConfig;
  curator: CuratorConfig;
  /** Total drain deadline, not a fresh budget for each pass. */
  drainTimeoutMs?: number;
  /** Optional UI observation; no proposal content or credentials are included. */
  onDrainReport?: (report: DrainReport) => void;
}

function zeroSummary(): AppliedSummary {
  return { memoryStaged: 0, todosAdded: 0, skillsStaged: 0, dropped: 0, rejected: 0 };
}
export function safeError(error: unknown): string {
  return String(error instanceof Error ? error.message : error)
    .replace(/\b(?:npm_|gh[opsu]_|sk-)[A-Za-z0-9_-]{12,}/g, "[redacted credential]")
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\b(api[_-]?key|authorization|password|token)(\s*[:=]\s*)("[^"]*"|'[^']*'|\S+)/gi, "$1$2[redacted]")
    .slice(0, 500);
}

/** Bound the wait even if an external implementation ignores the abort signal. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error("organism drain cancelled"));
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    promise.then(
      value => { signal.removeEventListener("abort", abort); resolve(value); },
      error => { signal.removeEventListener("abort", abort); reject(error); },
    );
  });
}

export class OrganismWorker {
  readonly #deps: WorkerDeps;
  #inflight: Promise<unknown> = Promise.resolve();
  #lastDrain: DrainReport | undefined;

  constructor(deps: WorkerDeps) { this.#deps = deps; }

  #serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#inflight.then(fn, fn);
    this.#inflight = run.then(() => undefined, () => undefined);
    return run;
  }

  /** Latest in-process outcome; persisted receipts survive reload in run_events. */
  getLastDrain(): DrainReport | undefined {
    return this.#lastDrain ? structuredClone(this.#lastDrain) : undefined;
  }

  runDrain(sessionId: string, reason: DrainReason, opts?: DrainOpts): Promise<AppliedSummary> {
    return this.#serialize(() => this.#doRunDrain(sessionId, reason, opts));
  }
  runCurate(now?: number, opts?: { force?: boolean; consolidate?: boolean }): Promise<DecayResult & { consolidated: boolean }> {
    return this.#serialize(() => this.#doRunCurate(now, opts));
  }

  async #doRunDrain(sessionId: string, reason: DrainReason, opts?: DrainOpts): Promise<AppliedSummary> {
    const { db, globalDb, org, project, worktreeDb } = this.#deps;
    const summary = zeroSummary();
    const report: DrainReport = {
      ...summary, kind: "organism-drain", sessionId, reason, status: "completed",
      startedAt: Date.now(), finishedAt: 0, modelCalls: 0,
      inputs: { messages: 0, runs: 0, runEvents: 0, events: 0, completedTodos: 0 }, errors: [],
    };
    if (!org.enabled) {
      this.#lastDrain = { ...report, status: "skipped", skipReason: "disabled", finishedAt: Date.now() };
      return summary; // Master-off means no automatic model calls or DB writes.
    }

    const fail = (phase: string, error: unknown) => { report.errors.push({ phase, message: safeError(error) }); };
    const controller = new AbortController();
    const timeout = this.#deps.drainTimeoutMs ?? ORGANISM_DRAIN_TIMEOUT_MS;
    const timer = setTimeout(() => controller.abort(new Error("organism drain timed out")), Math.max(1, timeout));
    timer.unref();
    let successfulPasses = 0;
    try {
      const bundle = drainSession(worktreeDb, sessionId, reason, opts);
      report.inputs = {
        messages: bundle.transcript.length, runs: bundle.runs.length, runEvents: bundle.runEvents.length,
        events: bundle.events.length, completedTodos: bundle.todos.filter(t => t.done).length,
      };
      if (Object.values(report.inputs).every(n => n === 0)) {
        report.status = "skipped"; report.skipReason = "no-input";
        return summary;
      }

      let rawModel: DigestModel | null;
      try { rawModel = this.#deps.makeModel(controller.signal); }
      catch (e) { fail("model", e); return summary; }
      if (!rawModel) { report.status = "skipped"; report.skipReason = "no-model"; return summary; }
      const model: DigestModel = {
        complete: async (system, messages) => {
          controller.signal.throwIfAborted();
          report.modelCalls++;
          return abortable(Promise.resolve().then(() => rawModel!.complete(system, messages)), controller.signal);
        },
      };
      const runPass = async (name: PassName, fn: () => Promise<DigestResult>): Promise<DigestResult> => {
        if (controller.signal.aborted) return emptyResult();
        const before = report.modelCalls;
        try {
          const result = await fn();
          if (report.modelCalls > before) successfulPasses++;
          return result;
        } catch (e) { fail(name, e); return emptyResult(); }
      };
      const results: DigestResult[] = [];
      let consolidated: DigestResult | undefined;
      if (org.passes.runMemoryTodo) results.push(await runPass("runMemoryTodo", () => runMemoryTodoPass(bundle, model)));
      if (org.passes.todoMemory) results.push(await runPass("todoMemory", () => todoMemoryPass(bundle, model)));
      if (org.passes.learning) results.push(await runPass("learning", () => learningPass(bundle, model)));
      if (org.passes.consolidation) {
        consolidated = await runPass("consolidation", () => consolidationPass(bundle, model));
      }
      if (org.passes.reflection) {
        if (controller.signal.aborted) {
          results.push(emptyResult());
        } else {
          const beforeCalls = report.modelCalls;
          let reflectionAllFailed = false;
          try {
            const embedder = await abortable(this.#deps.getEmbedder(), controller.signal);
            const result = await reflectionPass(db, embedder, model, {
              onClusterError: (e, info) => {
                fail("reflection", e);
                reflectionAllFailed = info.total > 0 && info.failed === info.total;
              },
            });
            results.push(result);
            // A modelCalls-diff alone cannot tell success from failure here (every
            // cluster calls model.complete regardless of whether its reply
            // parses); only credit a genuine success when at least one cluster
            // actually synthesized.
            if (report.modelCalls > beforeCalls && !reflectionAllFailed) successfulPasses++;
          } catch (e) {
            fail("reflection", e);
            results.push(emptyResult());
          }
        }
      }

      const merged = emptyResult();
      for (const r of results) {
        merged.memory.push(...r.memory); merged.todos.push(...r.todos); merged.skills.push(...r.skills);
      }
      merged.summary = consolidated?.summary;
      merged.selfName = consolidated?.selfName;
      try {
        Object.assign(summary, applyDigest(
          { db, globalDb, worktreeDb, scope: "repo", sessionId, skills: new SkillStore(db), project },
          merged, { max: org.autoWriteBudget, used: 0 },
        ));
      } catch (e) { fail("apply", e); }
      this.#persistConsolidation(sessionId, merged, fail);
      if (org.passes.insights) {
        try { buildLearningGraph(db, globalDb, { persist: true }); }
        catch (e) { fail("insights", e); }
      }
      return summary;
    } catch (e) {
      fail("drain", e);
      return summary;
    } finally {
      clearTimeout(timer);
      Object.assign(report, summary, { finishedAt: Date.now() });
      if (report.errors.length) {
        report.status = successfulPasses > 0 || summary.memoryStaged + summary.skillsStaged + summary.todosAdded > 0
          ? "partial" : "failed";
      }
      try {
        emitLog(worktreeDb, {
          sessionId,
          summary: `organism drain (${reason}): ${report.status}${report.skipReason ? ` (${report.skipReason})` : ""}; ` +
            `mem=${summary.memoryStaged} todos=${summary.todosAdded} skills=${summary.skillsStaged} ` +
            `dropped=${summary.dropped} rejected=${summary.rejected} errors=${report.errors.length}`,
          payload: report,
        });
      } catch (e) {
        fail("receipt", e);
        report.status = "failed";
      }
      this.#lastDrain = structuredClone(report);
      try { this.#deps.onDrainReport?.(structuredClone(report)); } catch { /* UI is secondary to the durable receipt. */ }
    }
  }

  #persistConsolidation(sessionId: string, merged: DigestResult, fail: (phase: string, error: unknown) => void): void {
    const { worktreeDb, globalDb, org, project } = this.#deps;
    const selfName = merged.selfName?.trim() || undefined;
    if (selfName !== undefined) {
      try {
        // Preserve an existing user/session name; summaries can keep evolving.
        worktreeDb.prepare("UPDATE sessions SET name=? WHERE id=? AND (name IS NULL OR name='')").run(selfName, sessionId);
      } catch (e) { fail("session-name", e); }
    }
    if (merged.summary) {
      try { worktreeDb.prepare("UPDATE sessions SET summary=? WHERE id=?").run(merged.summary, sessionId); }
      catch (e) { fail("session-summary", e); }
    }
    if (merged.summary || selfName) {
      try {
        const row = worktreeDb.prepare("SELECT name,summary FROM sessions WHERE id=?").get(sessionId) as
          { name: string | null; summary: string | null } | undefined;
        if (!row) throw new Error("Session row missing; lifecycle session_start was not recorded.");
        const prior = worktreeDb.prepare("SELECT content FROM sessions_fts WHERE id=? LIMIT 1").get(sessionId) as { content: string | null } | undefined;
        worktreeDb.prepare("DELETE FROM sessions_fts WHERE id=?").run(sessionId);
        worktreeDb.prepare("INSERT INTO sessions_fts(id,name,summary,content) VALUES (?,?,?,?)")
          .run(sessionId, row.name ?? "", row.summary ?? "", prior?.content ?? "");
      } catch (e) { fail("session-search", e); }
    }
    if (org.selfNaming && selfName) {
      try {
        globalDb.prepare("UPDATE projects SET name=? WHERE project_key=? AND (name IS NULL OR name='')")
          .run(selfName, project.projectKey);
      } catch (e) { fail("project-name", e); }
    }
  }

  async #doRunCurate(now?: number, opts?: { force?: boolean; consolidate?: boolean }): Promise<DecayResult & { consolidated: boolean }> {
    const { db, curator, org } = this.#deps;
    const ts = now ?? Date.now();
    if ((!org.enabled && opts?.force !== true) || (opts?.force !== true && !curatorShouldRun(db, ts, curator))) {
      return { toStale: [], toArchived: [], skipped: [], consolidated: false };
    }
    const skills = new SkillStore(db);
    const result = runCuratorDecay(db, skills, ts, curator);
    const shouldConsolidate = opts?.consolidate ?? curator.consolidate;
    let consolidated = false;
    if (shouldConsolidate) {
      const signal = AbortSignal.timeout(this.#deps.drainTimeoutMs ?? ORGANISM_DRAIN_TIMEOUT_MS);
      try {
        const model = this.#deps.makeModel(signal);
        if (model) { await abortable(consolidateSkills(skills, model, curator), signal); consolidated = true; }
      } catch (e) {
        const sessionId = this.#lastDrain?.sessionId;
        if (sessionId) {
          try { emitLog(this.#deps.worktreeDb, {
            sessionId, summary: `organism curate: failed (${safeError(e)})`,
            payload: { status: "failed", error: safeError(e) },
          }); } catch { /* DB failure must not hold shutdown open. */ }
        }
        throw new Error(`Organism curation failed: ${safeError(e)}`);
      }
    }
    return { ...result, consolidated };
  }
}

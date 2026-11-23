import type { Db, ProjectInfo } from "@spider/db-core";
import { randomUUID } from "node:crypto";
import { listActive, waitForEmbedder, type Embedder } from "@spider/memory";
import { emitLog } from "@spider/subagents";
import { drainSession, type DrainOpts } from "./drain.js";
import { applyDigest } from "./apply.js";
import { loadSkillReviewContext, type SkillReviewOptions } from "./skill-review.js";
import { runSkillReviewQueue } from "./skill-review-queue.js";
import { deferredDrainKey, DrainRetryStore, type DeferredDrain } from "./drain-retry.js";
import { isConnectivityFailure } from "./connectivity.js";
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
import type { AppliedSummary, DigestBundle, DigestModel, DigestResult, DrainReason, DrainReport, PassName } from "./types.js";
import type { OrganismConfig } from "./config.js";

export interface CurateResult extends DecayResult { consolidated: boolean; skipReason?: "disabled" | "paused" | "interval" }

export const ORGANISM_DRAIN_TIMEOUT_MS = 30_000;

class OrganismDeadline extends Error {
  override name = "OrganismDeadline";
  constructor() { super("organism drain timed out"); }
}

/** Each worker owns one serialized session/project pipeline. The host owns DB lifetime. */
export interface WorkerDeps {
  db: Db; // repo: memory, skills, curator state
  worktreeDb: Db; // sessions, runs, tracked events, todos
  globalDb: Db;
  project: ProjectInfo;
  getEmbedder: () => Promise<Embedder | null>;
  makeModel: (signal?: AbortSignal, purpose?: "learner" | "skill-curate") => DigestModel | null;
  org: OrganismConfig;
  skillReview?: SkillReviewOptions;
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
  #queuedWork = 0;
  #pendingDrains = new Map<string, Promise<AppliedSummary>>();
  #lastDrain: DrainReport | undefined;
  #reviewTask: Promise<void> | undefined;
  #reviewController: AbortController | undefined;
  #reviewTimer: ReturnType<typeof setTimeout> | undefined;
  #drainRetryTimer: ReturnType<typeof setTimeout> | undefined;
  #drainRetryAt: number | undefined;
  #shuttingDown = false;
  #paused = false;
  #resumeReviews = false;

  /** Fire-and-forget only from live-session lifecycle hooks, never a drain. */
  startSkillReviews(): void {
    if (process.env.PI_SUBAGENT_CHILD === "1" || this.#shuttingDown || this.#reviewTask || !this.#deps.org.enabled) return;
    if (this.#reviewTimer) { clearTimeout(this.#reviewTimer); this.#reviewTimer = undefined; }
    this.#reviewController = new AbortController();
    const deferred: number[] = [];
    this.#reviewTask = runSkillReviewQueue(this.#deps.db, { ...this.#deps.skillReview, signal: this.#reviewController.signal, onDeferred: retryAt => deferred.push(retryAt) })
      .then(() => {
        const retryAt = deferred[0];
        if (retryAt === undefined || this.#shuttingDown) return;
        this.#reviewTimer = setTimeout(() => { this.#reviewTimer = undefined; this.startSkillReviews(); }, Math.max(1, retryAt - Date.now()));
        this.#reviewTimer.unref();
      })
      .catch(error => {
        try { this.#deps.skillReview?.onReviewError?.(safeError(error), undefined); } catch { /* Diagnostics are secondary. */ }
      }).finally(() => { this.#reviewTask = undefined; this.#reviewController = undefined; });
  }
  async stopSkillReviews(): Promise<void> {
    this.#shuttingDown = true;
    if (this.#reviewTimer) { clearTimeout(this.#reviewTimer); this.#reviewTimer = undefined; }
    if (this.#drainRetryTimer) { clearTimeout(this.#drainRetryTimer); this.#drainRetryTimer = undefined; this.#drainRetryAt = undefined; }
    this.#reviewController?.abort();
    await this.#reviewTask; // Abort is bounded by the shared gate even for an uncooperative provider.
  }

  /** Restore pending work when a live session starts, including after a restart. */
  startDeferredDrains(): void {
    if (process.env.PI_SUBAGENT_CHILD === "1" || this.#shuttingDown || this.#paused || !this.#deps.org.enabled) return;
    const store = new DrainRetryStore(this.#deps.worktreeDb);
    if (store.next()) this.#scheduleDrainRetry(store.outage()?.retryAt ?? Date.now());
  }

  #scheduleDrainRetry(retryAt: number): void {
    if (this.#shuttingDown || this.#paused) return;
    if (this.#drainRetryTimer && this.#drainRetryAt !== undefined && this.#drainRetryAt <= retryAt) return;
    if (this.#drainRetryTimer) clearTimeout(this.#drainRetryTimer);
    this.#drainRetryAt = retryAt;
    this.#drainRetryTimer = setTimeout(() => {
      this.#drainRetryTimer = undefined; this.#drainRetryAt = undefined;
      if (this.#shuttingDown || this.#paused) return;
      void this.#retryDeferredDrains().catch(() => undefined);
    }, Math.max(1, retryAt - Date.now()));
    this.#drainRetryTimer.unref();
  }

  async #retryDeferredDrains(): Promise<void> {
    const store = new DrainRetryStore(this.#deps.worktreeDb);
    if (!store.next()) return;
    const owner = randomUUID();
    const duration = Math.max(1, this.#deps.drainTimeoutMs ?? ORGANISM_DRAIN_TIMEOUT_MS) + 5000;
    const lease = store.acquire(owner, duration);
    if (!lease.acquired) { this.#scheduleDrainRetry(lease.retryAt); return; }
    try {
      const attempted = new Set<string>();
      while (!this.#shuttingDown && !this.#paused && store.renew(owner, duration)) {
        const outage = store.outage();
        if (outage && outage.retryAt > Date.now()) { this.#scheduleDrainRetry(outage.retryAt); return; }
        const pending = store.next(attempted);
        if (!pending) {
          if (store.next()) this.#scheduleDrainRetry(Date.now() + 5 * 60_000);
          return;
        }
        attempted.add(deferredDrainKey(pending.bundle));
        await this.#serialize(() => this.#doRunDrain(pending.bundle.sessionId, pending.bundle.reason, undefined, pending, owner));
      }
    } finally { store.release(owner); }
  }

  constructor(deps: WorkerDeps) { this.#deps = deps; }

  /** Close the queue before waiting for all writers already admitted to it. */
  async pause(): Promise<void> {
    if (!this.#paused) { this.#resumeReviews = !this.#shuttingDown; this.#paused = true; }
    await Promise.all([this.stopSkillReviews(), this.#inflight]);
  }
  resume(): void {
    if (!this.#paused) return;
    this.#paused = false;
    if (this.#resumeReviews) { this.#shuttingDown = false; this.startSkillReviews(); this.startDeferredDrains(); }
    this.#resumeReviews = false;
  }

  #serialize<T>(fn: () => Promise<T>): Promise<T> {
    if (this.#paused) return Promise.reject(new Error("organism is paused"));
    this.#queuedWork++;
    const run = this.#inflight.then(fn, fn).finally(() => { this.#queuedWork--; });
    this.#inflight = run.then(() => undefined, () => undefined);
    return run;
  }

  /** Drains and curation use in-memory inputs; do not interrupt them with an automatic reload. */
  blocksReload(): boolean { return this.#queuedWork > 0; }

  /** Latest in-process outcome; persisted receipts survive reload in run_events. */
  getLastDrain(): DrainReport | undefined {
    return this.#lastDrain ? structuredClone(this.#lastDrain) : undefined;
  }

  runDrain(sessionId: string, reason: DrainReason, opts?: DrainOpts): Promise<AppliedSummary> {
    if (this.#paused || process.env.PI_SUBAGENT_CHILD === "1") return this.#serialize(() => this.#doRunDrain(sessionId, reason, opts));
    let key: string;
    try {
      const db = this.#deps.worktreeDb;
      const version = db.raw.pragma("data_version", { simple: true });
      const changes = db.prepare("SELECT total_changes() AS n").get();
      key = JSON.stringify([sessionId, reason, opts, version, changes]);
    } catch { return this.#serialize(() => this.#doRunDrain(sessionId, reason, opts)); }
    const existing = this.#pendingDrains.get(key);
    if (existing) return existing;
    const run = this.#serialize(() => this.#doRunDrain(sessionId, reason, opts));
    this.#pendingDrains.set(key, run);
    const release = () => { if (this.#pendingDrains.get(key) === run) this.#pendingDrains.delete(key); };
    void run.then(release, release);
    return run;
  }
  runCurate(now?: number, opts?: { force?: boolean; consolidate?: boolean }): Promise<CurateResult> {
    return this.#serialize(() => this.#doRunCurate(now, opts));
  }

  async #doRunDrain(sessionId: string, reason: DrainReason, opts?: DrainOpts, deferred?: DeferredDrain, retryOwner?: string): Promise<AppliedSummary> {
    if (process.env.PI_SUBAGENT_CHILD === "1") throw new Error("organism is disabled in subagent sessions");
    const { db, globalDb, org, project, worktreeDb } = this.#deps;
    const summary = zeroSummary();
    const report: DrainReport = {
      ...summary, kind: "organism-drain", sessionId, reason, status: "completed",
      startedAt: Date.now(), finishedAt: 0, modelCalls: 0,
      inputs: { messages: 0, runs: 0, runEvents: 0, events: 0, completedTodos: 0 }, errors: [], capDroppedByPass: {},
    };
    if (!org.enabled) {
      this.#lastDrain = { ...report, status: "skipped", skipReason: "disabled", finishedAt: Date.now() };
      return summary; // Master-off means no automatic model calls or DB writes.
    }

    let connectivity: { error: unknown; phase: string } | undefined;
    let calledProvider = false;
    let held = false;
    let suppressReceipt = false;
    let bundle: DigestBundle | undefined;
    let retryStore: DrainRetryStore | undefined;
    const providerPasses: PassName[] = ["runMemoryTodo", "todoMemory", "learning", "consolidation", "reflection"];
    const required = (deferred?.passes ?? providerPasses).filter(name => org.passes[name]);
    const completed = new Set<PassName>();
    const fail = (phase: string, error: unknown) => {
      report.errors.push({ phase, message: safeError(error) });
      if (connectivity && connectivity.error === error) connectivity.phase = phase;
    };
    const controller = new AbortController();
    const timeout = this.#deps.drainTimeoutMs ?? ORGANISM_DRAIN_TIMEOUT_MS;
    const timer = setTimeout(() => controller.abort(new OrganismDeadline()), Math.max(1, timeout));
    timer.unref();
    let successfulPasses = 0;
    try {
      retryStore = new DrainRetryStore(worktreeDb);
      const input = deferred?.bundle ?? drainSession(worktreeDb, sessionId, reason, opts);
      bundle = input;
      report.inputs = {
        messages: input.transcript.length, runs: input.runs.length, runEvents: input.runEvents.length,
        events: input.events.length, completedTodos: input.todos.filter(t => t.done).length,
      };
      if (Object.values(report.inputs).every(n => n === 0)) {
        report.status = "skipped"; report.skipReason = "no-input";
        return summary;
      }
      const outage = retryStore.outage();
      if (outage && outage.retryAt > Date.now()) {
        const pending = retryStore.defer(input, required);
        if (pending) {
          held = true; suppressReceipt = !pending.first && !pending.dropped;
          if (pending.dropped) report.deferredDropped = pending.dropped;
          report.errors.push({ phase: pending.outage.phase, message: pending.outage.message });
          report.outage = { retryAt: pending.outage.retryAt, occurrences: pending.outage.occurrences };
          this.#scheduleDrainRetry(pending.outage.retryAt);
          if (org.passes.insights) {
            try { buildLearningGraph(db, globalDb, { persist: true }); }
            catch (e) { fail("insights", e); suppressReceipt = false; }
          }
          return summary;
        }
      }

      let rawModel: DigestModel | null;
      try { rawModel = this.#deps.makeModel(controller.signal); }
      catch (e) { if (isConnectivityFailure(e)) connectivity = { error: e, phase: "model" }; fail("model", e); return summary; }
      if (!rawModel) { report.status = "skipped"; report.skipReason = "no-model"; return summary; }
      const model: DigestModel = {
        complete: async (system, messages) => {
          controller.signal.throwIfAborted();
          if (retryOwner && !retryStore!.owns(retryOwner)) throw new Error("Deferred drain ownership expired");
          report.modelCalls++; calledProvider = true;
          try { return await abortable(Promise.resolve().then(() => rawModel!.complete(system, messages)), controller.signal); }
          catch (error) { if (isConnectivityFailure(error)) connectivity = { error, phase: "model" }; throw error; }
        },
      };
      const runPass = async (name: PassName, fn: () => Promise<DigestResult>): Promise<DigestResult> => {
        if (controller.signal.aborted || connectivity || !required.includes(name) || (retryOwner && !retryStore!.owns(retryOwner))) return emptyResult();
        const before = report.modelCalls;
        try {
          const result = await fn();
          completed.add(name);
          if (result.capDropped) report.capDroppedByPass![name] = result.capDropped;
          if (report.modelCalls > before) successfulPasses++;
          return result;
        } catch (e) {
          fail(name, e);
          if (!connectivity) completed.add(name);
          return emptyResult();
        }
      };
      const results: DigestResult[] = [];
      let consolidated: DigestResult | undefined;
      if (org.passes.runMemoryTodo) results.push(await runPass("runMemoryTodo", () => runMemoryTodoPass(input, model, org.maxMemoryProposals)));
      if (org.passes.todoMemory) results.push(await runPass("todoMemory", () => todoMemoryPass(input, model, org.maxMemoryProposals)));
      if (org.passes.learning && input.transcript.length > 0 && !connectivity && required.includes("learning")) {
        let context = null;
        if (this.#deps.skillReview?.reviewer) {
          try { context = (this.#deps.skillReview.loadContext ?? loadSkillReviewContext)(new SkillStore(db)); }
          catch (error) { try { this.#deps.skillReview.onReviewError?.(safeError(error), undefined); } catch { /* Diagnostics only. */ } }
        }
        results.push(await runPass("learning", () => learningPass(input, model, org.maxMemoryProposals, [
          ...listActive(globalDb, "global", { limit: 60 }).map(({ content }) => ({ scope: "global" as const, content })),
          ...listActive(db, "repo", { limit: 60 }).map(({ content }) => ({ scope: "repo" as const, content })),
        ], context)));
      } else if (org.passes.learning && required.includes("learning") && input.transcript.length === 0) {
        completed.add("learning");
      }
      if (org.passes.consolidation) {
        consolidated = await runPass("consolidation", () => consolidationPass(input, model));
      }
      if (org.passes.reflection && required.includes("reflection")) {
        if (controller.signal.aborted || connectivity) {
          results.push(emptyResult());
        } else {
          const beforeCalls = report.modelCalls;
          let reflectionAllFailed = false;
          try {
            const embedder = await abortable(waitForEmbedder(this.#deps.getEmbedder), controller.signal);
            const result = await reflectionPass(db, embedder, model, {
              maxMemoryProposals: org.maxMemoryProposals,
              onClusterError: (e, info) => {
                fail("reflection", e);
                reflectionAllFailed = info.total > 0 && info.failed === info.total;
              },
            });
            results.push(result);
            completed.add("reflection");
            if (result.capDropped) report.capDroppedByPass!.reflection = result.capDropped;
            // A modelCalls-diff alone cannot tell success from failure here (every
            // cluster calls model.complete regardless of whether its reply
            // parses); only credit a genuine success when at least one cluster
            // actually synthesized.
            if (report.modelCalls > beforeCalls && !reflectionAllFailed) successfulPasses++;
          } catch (e) {
            fail("reflection", e);
            if (!connectivity) completed.add("reflection");
            results.push(emptyResult());
          }
        }
      }

      if (retryOwner && (!retryStore.owns(retryOwner) || (deferred && !retryStore.contains(deferred.bundle)))) {
        held = true; suppressReceipt = true; return summary;
      }
      const merged = emptyResult();
      for (const r of results) {
        merged.memory.push(...r.memory); merged.todos.push(...r.todos); merged.skills.push(...r.skills);
      }
      merged.summary = consolidated?.summary;
      merged.selfName = consolidated?.selfName;
      const capDropped = Object.values(report.capDroppedByPass ?? {}).reduce((sum, n) => sum + n, 0);
      try {
        Object.assign(summary, await applyDigest(
          { db, globalDb, worktreeDb, scope: "repo", sessionId, skills: new SkillStore(db), project,
            maxSkillProposals: org.maxSkillProposals,
            skillReview: { ...this.#deps.skillReview, signal: controller.signal },
          },
          merged, { max: org.autoWriteBudget, used: 0 },
        ));
        summary.dropped += capDropped;
      } catch (e) { completed.clear(); summary.dropped += capDropped; fail("apply", e); }
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
      if (retryStore && bundle) {
        try {
          if (retryOwner && !retryStore.owns(retryOwner)) { held = true; suppressReceipt = true; }
          if (connectivity && !held) {
            const pending = retryStore.failure(bundle, required.filter(name => !completed.has(name)), connectivity.phase, safeError(connectivity.error), !!deferred);
            report.outage = { retryAt: pending.outage.retryAt, occurrences: pending.outage.occurrences };
            if (pending.dropped) report.deferredDropped = pending.dropped;
            suppressReceipt = !pending.first && !pending.dropped;
            this.#scheduleDrainRetry(pending.outage.retryAt);
          } else if (!held) {
            if (deferred && (report.skipReason === "no-input" || required.every(name => completed.has(name)))) retryStore.finish(deferred.bundle);
            if (deferred || calledProvider) {
              retryStore.clearOutage();
              if (!deferred && retryStore.next()) this.#scheduleDrainRetry(Date.now());
            }
          }
        } catch (error) { fail("retry", error); suppressReceipt = false; }
      }
      Object.assign(report, summary, { finishedAt: Date.now() });
      if (report.errors.length) {
        report.status = successfulPasses > 0 || summary.memoryStaged + summary.skillsStaged + (summary.skillsQueued ?? 0) + summary.todosAdded > 0
          ? "partial" : "failed";
      }
      if (!suppressReceipt) try {
        emitLog(worktreeDb, {
          sessionId,
          summary: `organism drain (${reason}): ${report.status}${report.skipReason ? ` (${report.skipReason})` : ""}; ` +
            `mem=${summary.memoryStaged} todos=${summary.todosAdded} skillsQueued=${summary.skillsQueued ?? 0} ` +
            `dropped=${summary.dropped}${report.deferredDropped ? ` deferredDropped=${report.deferredDropped}` : ""} rejected=${summary.rejected} errors=${report.errors.length}`,
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

  async #doRunCurate(now?: number, opts?: { force?: boolean; consolidate?: boolean }): Promise<CurateResult> {
    if (process.env.PI_SUBAGENT_CHILD === "1") throw new Error("organism is disabled in subagent sessions");
    const { db, curator, org } = this.#deps;
    const ts = now ?? Date.now();
    if (!org.enabled && opts?.force !== true) {
      return { toStale: [], toArchived: [], skipped: [], consolidated: false, skipReason: "disabled" };
    }
    if (opts?.force !== true && !curatorShouldRun(db, ts, curator)) {
      const state = db.prepare("SELECT paused FROM curator_state WHERE scope = 'project'").get() as { paused: number };
      return { toStale: [], toArchived: [], skipped: [], consolidated: false, skipReason: state.paused ? "paused" : "interval" };
    }
    const skills = new SkillStore(db);
    const result = runCuratorDecay(db, skills, ts, curator);
    const shouldConsolidate = opts?.consolidate ?? curator.consolidate;
    let consolidated = false;
    if (shouldConsolidate) {
      const signal = AbortSignal.timeout(this.#deps.drainTimeoutMs ?? ORGANISM_DRAIN_TIMEOUT_MS);
      try {
        const model = this.#deps.makeModel(signal, "skill-curate");
        if (model) {
          const observedModel: DigestModel = {
            complete: async (system, messages) => {
              const reply = await model.complete(system, messages);
              consolidated = true;
              return reply;
            },
          };
          await abortable(consolidateSkills(skills, observedModel, { ...curator, consolidate: shouldConsolidate }), signal);
        }
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

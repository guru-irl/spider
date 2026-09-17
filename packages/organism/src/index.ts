export { drainSession, type DrainOpts } from "./drain.js";
export { readLastDrainReport, readLastDrainReportForWorktree } from "./diagnostics.js";
export { SkillStore, type SkillRow, type SkillState, type SkillStatus } from "./skill-usage.js";
export {
  runCuratorDecay,
  curatorShouldRun,
  consolidateSkills,
  archiveSkillFiles,
  CURATOR_DEFAULTS,
  type CuratorConfig,
  type DecayResult,
} from "./curator.js";

export { buildLearnPrompt, AUTHORING_STANDARDS } from "./learn.js";

export {
  buildLearningGraph,
  tokenize,
  type GraphNode,
  type GraphEdge,
  type LearningGraph,
} from "./learning-graph.js";

export { createDigestModel, parseCandidates, type AuxCall } from "./aux-model.js";
export type {
  AppliedSummary,
  DigestBundle,
  DigestModel,
  DigestResult,
  DrainReason,
  DrainReport,
  DrainError,
  PassName,
  WriteBudget,
} from "./types.js";
export { emptyResult } from "./types.js";

export {
  ORGANISM_DEFAULTS,
  readOrganismConfig,
  readCuratorConfig,
  type OrganismConfig,
} from "./config.js";

export { OrganismWorker, safeError, type WorkerDeps } from "./worker.js";

export {
  skillAction,
  curateAction,
  insightsAction,
  type OrganismActionDeps,
  type OrganismActionResult,
  type SkillActionArgs,
  type CurateActionArgs,
} from "./actions.js";

export {
  renderSkillList,
  renderSkillView,
  renderDistill,
  renderCurateResult,
  renderInsights,
} from "./renderers.js";

import { OrganismWorker, type WorkerDeps } from "./worker.js";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { normalizeTranscriptEntries } from "@spider/context";
import type { DrainOpts } from "./drain.js";
import type { DigestMsg } from "@spider/memory";

/** The host may lazily resolve/cache dependencies by the actual bound session/project. */
export type OrganismDepsResolver = WorkerDeps | ((ctx: ExtensionContext) => WorkerDeps | OrganismWorker);

/**
 * Wire the autonomic organism onto a live pi host. Builds a single
 * {@link OrganismWorker} and registers two lifecycle hooks:
 *
 *   - `session_before_compact` → best-effort `runDrain(reason:"before_compact")`.
 *     It MUST NOT cancel or alter compaction: it never returns `false`, never
 *     calls a cancel API, and swallows every error.
 *   - `session_shutdown` → `runDrain("shutdown")` then a min-interval-gated
 *     `runCurate()`. Errors are swallowed so shutdown never breaks.
 *
 * `pi.on` chains, so these handlers coexist with any others already registered.
 */
/**
 * Wire the autonomic organism onto a live pi host. Builds a single
 * {@link OrganismWorker} and registers two lifecycle hooks:
 *
 *   - `session_before_compact` → best-effort `runDrain(reason:"before_compact")`.
 *     It MUST NOT cancel or alter compaction: it never returns `false`, never
 *     calls a cancel API, and swallows every error.
 *   - `session_shutdown` → `runDrain("shutdown")` then a min-interval-gated
 *     `runCurate()`. Errors are swallowed so shutdown never breaks.
 *
 * `pi.on` chains, so these handlers coexist with any others already registered.
 *
 * @param onSetupError Optional observer for failures that happen BEFORE a
 *   drain can even start: `pi.on` itself throwing (`phase:"register"`), a
 *   lifecycle event firing with no resolvable context/session id
 *   (`phase:"context"`), or the deps resolver / transcript capture throwing
 *   before a worker exists (`phase:"resolve"`). These are otherwise
 *   completely invisible — a dead organism looks identical to a healthy one
 *   that simply hasn't drained yet. The callback itself is always called
 *   defensively (never allowed to break the lifecycle it is observing).
 */
export function registerOrganism(
  _host: unknown,
  pi: any,
  deps: OrganismDepsResolver,
  onSetupError?: (phase: string, error: unknown, ctx?: ExtensionContext) => void,
): void {
  const workers = new WeakMap<WorkerDeps, OrganismWorker>();
  const workerFor = (ctx: ExtensionContext) => {
    const resolved = typeof deps === "function" ? deps(ctx) : deps;
    if (resolved instanceof OrganismWorker) return resolved;
    let worker = workers.get(resolved);
    if (!worker) {
      worker = new OrganismWorker(resolved);
      workers.set(resolved, worker);
    }
    return worker;
  };
  const capture = (ctx: ExtensionContext, branchEntries?: readonly unknown[]): DrainOpts => {
    const entries = branchEntries ?? ctx.sessionManager.getBranch?.();
    if (entries !== undefined) {
      return { transcript: normalizeTranscriptEntries(entries).flatMap((m): DigestMsg[] =>
        m.role === "user" || m.role === "assistant" ? [{ role: m.role, content: m.text }] : [],
      ) };
    }
    return { transcriptPath: ctx.sessionManager.getSessionFile?.() };
  };
  const reportSetupError = (phase: string, error: unknown, ctx?: ExtensionContext) => {
    try { onSetupError?.(phase, error, ctx); } catch { /* the observer itself must never break the lifecycle */ }
  };

  try {
    pi?.on?.("session_before_compact", (event: any, ctx?: ExtensionContext) => {
      const sessionId = ctx?.sessionManager?.getSessionId?.();
      if (!ctx || !sessionId) {
        reportSetupError("context", new Error("session_before_compact fired without a resolvable context/session id"), ctx);
        return undefined;
      }
      try {
        // Capture before awaiting anything: /tree or a later compaction must not
        // change what this particular drain learns from. Never mutate the event.
        const opts = capture(ctx, Array.isArray(event?.branchEntries) ? event.branchEntries : undefined);
        void workerFor(ctx).runDrain(sessionId, "before_compact", opts).catch(() => undefined);
      } catch (e) {
        reportSetupError("resolve", e, ctx);
        /* never block or alter pi's compaction */
      }
      return undefined;
    });
  } catch (e) {
    reportSetupError("register", e);
    /* best-effort registration */
  }

  try {
    pi?.on?.("session_shutdown", async (_event: any, ctx?: ExtensionContext) => {
      const sessionId = ctx?.sessionManager?.getSessionId?.();
      if (!ctx || !sessionId) {
        reportSetupError("context", new Error("session_shutdown fired without a resolvable context/session id"), ctx);
        return undefined;
      }
      try {
        const opts = capture(ctx);
        const worker = workerFor(ctx);
        await worker.runDrain(sessionId, "shutdown", opts);
        await worker.runCurate();
      } catch (e) {
        reportSetupError("resolve", e, ctx);
        /* never break shutdown */
      }
      return undefined;
    });
  } catch (e) {
    reportSetupError("register", e);
    /* best-effort registration */
  }
}

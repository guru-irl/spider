export { drainSession, type DrainOpts } from "./drain.js";
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

export { OrganismWorker, type WorkerDeps } from "./worker.js";

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
export function registerOrganism(_host: unknown, pi: any, deps: WorkerDeps): void {
  const worker = new OrganismWorker(deps);

  try {
    pi?.on?.("session_before_compact", (event: any) => {
      const sessionId = String(event?.sessionId ?? "");
      if (sessionId.length === 0) return undefined;
      // Fire-and-forget: compaction proceeds regardless. Never return false.
      void worker.runDrain(sessionId, "before_compact").catch(() => undefined);
      return undefined;
    });
  } catch {
    /* best-effort */
  }

  try {
    pi?.on?.("session_shutdown", async (event: any) => {
      const sessionId = String(event?.sessionId ?? "");
      if (sessionId.length === 0) return undefined;
      try {
        await worker.runDrain(sessionId, "shutdown");
        await worker.runCurate();
      } catch {
        /* best-effort; never break shutdown */
      }
      return undefined;
    });
  } catch {
    /* best-effort */
  }
}

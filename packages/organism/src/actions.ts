import type { Db, ProjectInfo } from "@spider/db-core";
import { SkillStore } from "./skill-usage.js";
import { buildLearnPrompt } from "./learn.js";
import { buildLearningGraph } from "./learning-graph.js";
import type { OrganismWorker } from "./worker.js";
import { renderCurateResult, renderDistill, renderInsights, renderSkillList, renderSkillView } from "./renderers.js";

/** Deps shared by the organism action handlers. */
export interface OrganismActionDeps {
  db: Db;
  globalDb: Db;
  project: ProjectInfo;
  worker: OrganismWorker;
}

/** Normalized handler result: a rendered panel plus the structured payload. */
export interface OrganismActionResult {
  display: string;
  details: unknown;
}

/** Args accepted by the `skill` action. */
export interface SkillActionArgs {
  op?: "distill" | "view" | "list";
  name?: string;
  text?: string;
}

/**
 * `skill` action — `distill` builds a `/learn` prompt handoff, `view` renders a
 * single skill, `list` (default) renders the whole skill store. Thin over
 * {@link SkillStore} + {@link buildLearnPrompt}.
 */
export function skillAction(deps: OrganismActionDeps, args: SkillActionArgs): OrganismActionResult {
  const skills = new SkillStore(deps.db);
  switch (args.op ?? "list") {
    case "distill": {
      const prompt = buildLearnPrompt(args.text ?? "");
      return { display: renderDistill(prompt), details: { prompt } };
    }
    case "view": {
      const row = args.name !== undefined ? skills.get(args.name) : undefined;
      return { display: renderSkillView(row), details: row ?? null };
    }
    case "list":
    default: {
      const rows = skills.list();
      return { display: renderSkillList(rows), details: rows };
    }
  }
}

/** Args accepted by `control skill curate`. */
export interface CurateActionArgs {
  consolidate?: boolean;
  force?: boolean;
}

/**
 * `control skill curate` — run the curator decay pass through the worker.
 * `--force` bypasses the min-interval gate; `--consolidate` requests the
 * aux-model consolidation (honored by the worker when a model is available).
 */
export async function curateAction(deps: OrganismActionDeps, args: CurateActionArgs): Promise<OrganismActionResult> {
  const result = await deps.worker.runCurate(Date.now(), { force: args.force === true });
  return { display: renderCurateResult(result), details: { ...result, consolidate: args.consolidate === true } };
}

/** `control insights` — assemble (without persisting) the learning graph. */
export function insightsAction(deps: OrganismActionDeps): OrganismActionResult {
  const graph = buildLearningGraph(deps.db, deps.globalDb, { persist: false });
  return { display: renderInsights(graph), details: graph };
}

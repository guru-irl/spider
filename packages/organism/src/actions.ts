import type { Db, ProjectInfo } from "@spider/db-core";
import { SkillStore, skillNameErrors } from "./skill-usage.js";
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
  op?: "distill" | "view" | "list" | "add" | "approve" | "reject";
  name?: string;
  text?: string;
  category?: string;
}

/**
 * `skill` action — `distill` builds a `/learn` prompt handoff, `view` renders a
 * single skill, `list` (default) renders the whole skill store, `add` stages a
 * new auto-proposed candidate (via {@link SkillStore.stageCandidate} — this
 * NEVER activates anything), `approve`/`reject` review a staged candidate.
 * Thin over {@link SkillStore} + {@link buildLearnPrompt}.
 *
 * `approve` is the only path that ever activates a staged candidate or
 * writes a `SKILL.md` to disk — it is always an explicit, human-triggered
 * call through this action; no automatic organism code path may call
 * {@link SkillStore.approveCandidate} directly.
 *
 * An unrecognized `op` (including a hallucinated `"create"`) is a
 * host-visible error, never a silent fallthrough to `list` — a caller must
 * never mistake a successful listing for a save that never happened.
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
    case "add": {
      const name = (args.name ?? "").trim();
      const nameErrors = skillNameErrors(name);
      if (nameErrors.length > 0) {
        return { display: `Cannot stage skill: ${nameErrors.join("; ")}`, details: { ok: false, error: nameErrors.join("; ") } };
      }
      const body = args.text ?? "";
      if (body.trim().length === 0) {
        return { display: "Missing skill body text to stage (op=add requires `text`).", details: { ok: false, error: "missing text" } };
      }
      const result = skills.stageCandidate({ name, body, category: args.category });
      const display = result.outcome === "staged"
        ? `Staged skill candidate "${name}" for review — run \`spider skill op=approve name=${name}\` to activate it.`
        : `Skill "${name}" not newly staged (${result.reason}).`;
      return { display, details: { ok: true, ...result } };
    }
    case "approve": {
      if (args.name === undefined || args.name.length === 0) {
        return { display: "Missing skill name to approve.", details: { ok: false, error: "missing name" } };
      }
      const res = skills.approveCandidate(args.name, deps.project.realPath);
      if (!res.ok) {
        return { display: `Could not approve "${args.name}": ${res.error}`, details: res };
      }
      return { display: renderSkillView(res.row), details: res };
    }
    case "reject": {
      if (args.name === undefined || args.name.length === 0) {
        return { display: "Missing skill name to reject.", details: { ok: false, error: "missing name" } };
      }
      const row = skills.rejectCandidate(args.name);
      if (row === undefined) {
        return { display: `Skill "${args.name}" not found.`, details: null };
      }
      return { display: renderSkillView(row), details: row };
    }
    case "list":
      return { display: renderSkillList(skills.list()), details: skills.list() };
    default: {
      const op = String((args as { op?: unknown }).op);
      return {
        display: `Unknown skill op "${op}" (valid: list|view|distill|add|approve|reject)`,
        details: { ok: false, error: `unknown skill op "${op}"` },
      };
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
 * `details.consolidateRequested` reflects what was ASKED; `details.consolidated`
 * (from the worker) reflects what ACTUALLY ran — they are never conflated.
 */
export async function curateAction(deps: OrganismActionDeps, args: CurateActionArgs): Promise<OrganismActionResult> {
  const result = await deps.worker.runCurate(Date.now(), { force: args.force === true, consolidate: args.consolidate });
  const consolidateRequested = args.consolidate === true;
  return { display: renderCurateResult({ ...result, consolidateRequested }), details: { ...result, consolidateRequested } };
}

/** `control insights` — assemble (without persisting) the learning graph. */
export function insightsAction(deps: OrganismActionDeps): OrganismActionResult {
  const graph = buildLearningGraph(deps.db, deps.globalDb, { persist: false });
  return { display: renderInsights(graph), details: graph };
}

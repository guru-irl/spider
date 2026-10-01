import type { ThinkingLevel, ThinkingResolution } from "@spider/db-core";
import type { ExtensionAPI, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { complete, type ModelEntry } from "@spider/models";
import { persistReviewError } from "@spider/memory";
import { skillReviewerSystem, loadSkillReviewContext, type ExistingSkill, type SkillReviewOptions, type SkillReviewer } from "@spider/organism";
import { reviewerThinkingDiagnostic } from "./reviewer-thinking";
import { controlConfig } from "./control";

export function modelSkillReviewer(modelRef: string, registry: unknown, thinking: ThinkingLevel = "xhigh", onThinking?: (info: ThinkingResolution) => void): SkillReviewer {
  return (candidate, skills, signal, rubric) => {
    const slash = modelRef.indexOf("/");
    if (slash <= 0 || slash === modelRef.length - 1) throw Error(`invalid skill reviewer model: ${modelRef}`);
    const entry = { provider: modelRef.slice(0, slash), id: modelRef.slice(slash + 1) } as ModelEntry;
    const data = { candidate: { name: candidate.name, category: candidate.category ?? null, body: candidate.body, origin: candidate.origin }, existing_skills: skills };
    return complete(entry, JSON.stringify(data), {
      system: skillReviewerSystem(rubric),
      registry: registry as Pick<ModelRegistry, "find" | "streamSimple"> | undefined,
      thinkingLevel: thinking, signal, onThinking,
    });
  };
}

export function skillReviewOptions(cwd: string, registry: unknown, signal?: AbortSignal, loadedSkills: ExistingSkill[] = []): SkillReviewOptions {
  const enabled = controlConfig("get", cwd, "skills.reviewer.enabled") !== false;
  const model = controlConfig("get", cwd, "skills.reviewer.model");
  const thinking = controlConfig("get", cwd, "skills.reviewer.thinking") as ThinkingLevel;
  const timeoutMs = controlConfig("get", cwd, "skills.reviewer.timeoutMs");
  return {
    reviewer: enabled ? modelSkillReviewer(typeof model === "string" ? model : "github-copilot/gpt-6-luna", registry, thinking, reviewerThinkingDiagnostic(cwd, "skill", typeof model === "string" ? model : "github-copilot/gpt-6-luna")) : undefined,
    skipReason: "reviewer disabled", timeoutMs: timeoutMs as number, signal,
    loadContext: store => loadSkillReviewContext(store, loadedSkills),
    onReviewError: (error, raw) => persistReviewError(cwd, "skill", error, raw),
  };
}

/** getCommands is already backed by pi's in-memory resource catalog. No reads
 * of personal configs, DBs or files, and no file paths enter model input. */
export function piLoadedSkills(api: unknown): ExistingSkill[] {
  const pi = api as Partial<Pick<ExtensionAPI, "getCommands">> | undefined;
  try {
    return (pi?.getCommands?.() ?? []).filter(command => command.source === "skill")
      .map(command => ({ name: command.name.replace(/^skill:/, ""), description: command.description ?? "" }));
  } catch { return []; } // Small/older hosts may not expose a bound command catalog.
}

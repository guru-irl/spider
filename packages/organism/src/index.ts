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

export function registerOrganism(_host: unknown, _pi: unknown, _deps: unknown): void {
  // filled by later tasks
}

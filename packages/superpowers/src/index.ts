export {
  diffUpstream,
  runUpstreamWatch,
  seedUpstreamRefs,
  markReviewed,
  DEFAULT_UPSTREAM_REFS,
  type GitRunner,
  type UpstreamCheck,
  type CherryCandidate,
  type PackageResult,
  type UpstreamWatchReport,
} from "./upstream-watch.js";

export function registerSuperpowers(_host: unknown, _pi: unknown, _opts?: unknown): void {
  // filled by later tasks (Task 16)
}

export function contributeSkillPaths(_cwd: string): string[] {
  return []; // reconciled to re-export from ./skills-dir.js in Task 16
}

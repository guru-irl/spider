export type GitRunner = (repoPath: string, args: string[]) => string;

export interface UpstreamCheck { package: string; upstreamRepo: string; upstreamRef?: string; lastReviewedCommit?: string; }
export interface CherryCandidate { package: string; commit: string; subject: string; }
export interface PackageResult { package: string; head: string; candidates: CherryCandidate[]; }

const UNIT = "\x1f";

export function diffUpstream(check: UpstreamCheck, repoPath: string, git: GitRunner): PackageResult {
  const ref = check.upstreamRef ?? "HEAD";
  const head = git(repoPath, ["rev-parse", ref]).trim();
  if (!check.lastReviewedCommit) return { package: check.package, head, candidates: [] };
  const range = `${check.lastReviewedCommit}..${head}`;
  const out = git(repoPath, ["log", "--reverse", `--format=%H${UNIT}%s`, range]).trim();
  const candidates: CherryCandidate[] = out
    ? out.split("\n").map((line) => {
        const [commit, subject] = line.split(UNIT);
        return { package: check.package, commit, subject: subject ?? "" };
      })
    : [];
  return { package: check.package, head, candidates };
}

// Seed rows for the six vendored subsystems. upstream_ref/repo values are the
// review targets; confirm exact repo URLs before relying on them in production.
export const DEFAULT_UPSTREAM_REFS: UpstreamCheck[] = [
  { package: "superpowers", upstreamRepo: "https://github.com/obra/superpowers", upstreamRef: "main" },
  { package: "memory",      upstreamRepo: "https://github.com/guru-irl/pi-hermes-memory", upstreamRef: "main" },
  { package: "context",     upstreamRepo: "https://github.com/guru-irl/context-mode", upstreamRef: "main" },
  { package: "todo",        upstreamRepo: "https://github.com/guru-irl/pi-todo-sqlite", upstreamRef: "main" },
  { package: "subagents",   upstreamRepo: "https://github.com/guru-irl/pi-subagents", upstreamRef: "main" },
  { package: "db-core",     upstreamRepo: "https://github.com/guru-irl/spider", upstreamRef: "main" },
];

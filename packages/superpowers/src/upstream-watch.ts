import type { Db } from "@spider/db-core";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export interface GitRunOptions {
  timeoutMs: number;
  env: Readonly<Record<string, string>>;
}

export type GitRunner = (repoPath: string, args: string[], options: GitRunOptions) => Promise<string>;

export interface UpstreamCheck {
  package: string;
  upstreamRepo: string;
  upstreamRef?: string;
  lastReviewedCommit?: string;
}
export interface CherryCandidate { package: string; commit: string; subject: string; }
export type PackageState = "no-baseline" | "fetch-failed" | "unreachable" | "up-to-date" | "candidates";
export interface PackageResult {
  package: string;
  state: PackageState;
  head: string;
  candidates: CherryCandidate[];
  reason?: string;
}

export interface UpstreamWatchDeps {
  git: GitRunner;
  mirrorRoot: string;
  /** Test-only source overrides. Production reads upstream_repo from the DB. */
  upstreamRepos?: Record<string, string>;
  /** Test-only package filter, used to keep fixture tests local and deterministic. */
  packages?: string[];
  /** Legacy regression input. It is intentionally never used for ref resolution. */
  localRepos?: Record<string, string>;
}

const UNIT = "\x1f";
const LOCAL_GIT_TIMEOUT_MS = 10_000;
const NETWORK_GIT_TIMEOUT_MS = 60_000;
const UPSTREAM_CONCURRENCY = 4;
const NON_INTERACTIVE_GIT_ENV = Object.freeze({
  GIT_TERMINAL_PROMPT: "0",
  GIT_ASKPASS: "true",
  SSH_ASKPASS: "true",
  GIT_SSH_COMMAND: "ssh -oBatchMode=yes",
});

class GitTimeoutError extends Error {}

function isTimeoutError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const timed = error as { code?: unknown; killed?: unknown; signal?: unknown };
  return timed.code === "ETIMEDOUT" || (timed.killed === true && timed.signal === "SIGTERM");
}

async function runGit(repoPath: string, args: string[], git: GitRunner): Promise<string> {
  const timeoutMs = args[0] === "fetch" ? NETWORK_GIT_TIMEOUT_MS : LOCAL_GIT_TIMEOUT_MS;
  try {
    return await git(repoPath, args, { timeoutMs, env: NON_INTERACTIVE_GIT_ENV });
  } catch (error) {
    if (isTimeoutError(error)) {
      throw new GitTimeoutError(`git ${args.slice(0, 2).join(" ")} timed out after ${timeoutMs}ms`);
    }
    throw error;
  }
}

function errorMessage(error: unknown): string {
  const stderr = error && typeof error === "object" && "stderr" in error
    ? String((error as { stderr?: unknown }).stderr ?? "").trim()
    : "";
  if (stderr) return stderr;
  return error instanceof Error ? error.message : String(error);
}

export function mirrorPath(mirrorRoot: string, pkg: string): string {
  return join(mirrorRoot, encodeURIComponent(pkg));
}

/** Resolve a branch, tag, full ref, or commit SHA inside a fetched mirror. */
export async function resolveMirrorRef(pkg: string, ref: string, repoPath: string, git: GitRunner): Promise<string> {
  const refs = new Set(
    (await runGit(repoPath, ["for-each-ref", "--format=%(refname)"], git))
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean),
  );
  const candidates = ref.startsWith("refs/")
    ? [ref]
    : ref.startsWith("origin/")
      ? [`refs/remotes/${ref}`, `refs/tags/${ref.slice("origin/".length)}`]
      : [`refs/remotes/origin/${ref}`, `refs/tags/${ref}`, `refs/heads/${ref}`];
  const knownRef = candidates.find((candidate) => refs.has(candidate));
  const revision = `${knownRef ?? ref}^{commit}`;
  try {
    return (await runGit(repoPath, ["rev-parse", "--verify", "--quiet", revision], git)).trim();
  } catch (error) {
    if (error instanceof GitTimeoutError) throw error;
    throw new Error(`upstream-watch: ref '${ref}' does not exist in the ${pkg} upstream mirror`);
  }
}

/** Initialize/update a bare mirror and fetch all upstream branches and tags. */
export async function fetchUpstreamMirror(check: UpstreamCheck, mirrorRoot: string, git: GitRunner): Promise<string> {
  const repoPath = mirrorPath(mirrorRoot, check.package);
  mkdirSync(repoPath, { recursive: true });
  if (!existsSync(join(repoPath, "HEAD"))) await runGit(repoPath, ["init", "--bare", "--quiet"], git);

  let currentOrigin: string | undefined;
  const remotes = (await runGit(repoPath, ["remote"], git)).split("\n").map((line) => line.trim());
  if (remotes.includes("origin")) currentOrigin = (await runGit(repoPath, ["remote", "get-url", "origin"], git)).trim();
  if (!currentOrigin) await runGit(repoPath, ["remote", "add", "origin", check.upstreamRepo], git);
  else if (currentOrigin !== check.upstreamRepo) await runGit(repoPath, ["remote", "set-url", "origin", check.upstreamRepo], git);

  await runGit(repoPath, [
    "fetch",
    "--quiet",
    "--prune",
    "--force",
    "origin",
    "+refs/heads/*:refs/remotes/origin/*",
    "+refs/tags/*:refs/tags/*",
  ], git);
  return repoPath;
}

export async function diffUpstream(check: UpstreamCheck, repoPath: string, git: GitRunner): Promise<PackageResult> {
  const ref = check.upstreamRef ?? "HEAD";
  const head = await resolveMirrorRef(check.package, ref, repoPath, git);
  if (!check.lastReviewedCommit) {
    return {
      package: check.package,
      state: "no-baseline",
      head,
      candidates: [],
      reason: `No baseline is recorded. After choosing one, run: spider control upstream-watch --mark ${check.package} <ref>`,
    };
  }
  const baseline = await resolveMirrorRef(check.package, check.lastReviewedCommit, repoPath, git);
  const range = `${baseline}..${head}`;
  const out = (await runGit(repoPath, ["log", "--reverse", `--format=%H${UNIT}%s`, range], git)).trim();
  const candidates: CherryCandidate[] = out
    ? out.split("\n").map((line) => {
        const [commit, subject] = line.split(UNIT);
        return { package: check.package, commit, subject: subject ?? "" };
      })
    : [];
  return {
    package: check.package,
    state: candidates.length === 0 ? "up-to-date" : "candidates",
    head,
    candidates,
  };
}

// Seed rows for the six vendored subsystems. These are review targets, not local
// package paths. Reachability is reported by each run; one bad URL never aborts it.
export const DEFAULT_UPSTREAM_REFS: UpstreamCheck[] = [
  { package: "superpowers", upstreamRepo: "https://github.com/obra/superpowers", upstreamRef: "main" },
  { package: "memory",      upstreamRepo: "https://github.com/guru-irl/pi-hermes-memory", upstreamRef: "main" },
  { package: "context",     upstreamRepo: "https://github.com/guru-irl/context-mode", upstreamRef: "main" },
  { package: "todo",        upstreamRepo: "https://github.com/guru-irl/pi-todo-sqlite", upstreamRef: "master" },
  { package: "subagents",   upstreamRepo: "https://github.com/guru-irl/pi-subagents", upstreamRef: "main" },
  { package: "db-core",     upstreamRepo: "https://github.com/guru-irl/spider", upstreamRef: "main" },
];

export interface UpstreamWatchReport { checkedAt: number; packages: PackageResult[]; todosAdded: number; }

export function seedUpstreamRefs(globalDb: Db): void {
  const stmt = globalDb.prepare(
    `INSERT OR IGNORE INTO upstream_refs (package, upstream_repo, upstream_ref, last_checked_at)
     VALUES (@package, @repo, @ref, 0)`,
  );
  for (const c of DEFAULT_UPSTREAM_REFS) {
    stmt.run({ package: c.package, repo: c.upstreamRepo, ref: c.upstreamRef ?? "main" });
  }
  // Only repair the old seeded default; do not overwrite a user-selected ref.
  globalDb.prepare("UPDATE upstream_refs SET upstream_ref='master' WHERE package='todo' AND upstream_ref='main'").run();
}

/** Validate a baseline ref in the package mirror and persist its full commit SHA. */
export async function markReviewed(
  globalDb: Db,
  pkg: string,
  ref: string,
  deps: Pick<UpstreamWatchDeps, "git" | "mirrorRoot">,
): Promise<string> {
  const row = globalDb
    .prepare(`SELECT package FROM upstream_refs WHERE package=?`)
    .get(pkg) as { package: string } | undefined;
  if (!row) throw new Error(`upstream-watch: unknown package '${pkg}'`);

  const repoPath = mirrorPath(deps.mirrorRoot, pkg);
  if (!existsSync(join(repoPath, "HEAD"))) {
    throw new Error(`upstream-watch: no mirror for '${pkg}'; run spider control upstream-watch before marking a baseline`);
  }
  const sha = await resolveMirrorRef(pkg, ref, repoPath, deps.git);
  globalDb.prepare(`UPDATE upstream_refs SET last_reviewed_commit=@sha WHERE package=@pkg`).run({ sha, pkg });
  return sha;
}

function nextSeq(projectDb: Db, sessionId: string): number {
  const row = projectDb.prepare(`SELECT COALESCE(MAX(seq),0) AS m FROM todos WHERE session_id=?`).get(sessionId) as { m: number };
  return (row.m ?? 0) + 1;
}

export async function runUpstreamWatch(
  globalDb: Db,
  projectDb: Db,
  sessionId: string,
  deps: UpstreamWatchDeps,
): Promise<UpstreamWatchReport> {
  seedUpstreamRefs(globalDb);
  const now = Date.now();
  const rows = globalDb
    .prepare(`SELECT package, upstream_repo, upstream_ref, last_reviewed_commit FROM upstream_refs ORDER BY rowid`)
    .all() as Array<{ package: string; upstream_repo: string; upstream_ref: string | null; last_reviewed_commit: string | null }>;
  const selected = deps.packages ? new Set(deps.packages) : undefined;
  const packages: PackageResult[] = [];
  let todosAdded = 0;

  const findTodo = projectDb.prepare(`SELECT 1 FROM todos WHERE session_id=@sid AND text=@text`);
  // Raw insert + manual todos_fts sync (mirrors @spider/todo addTodo: there is no
  // AFTER INSERT trigger, so the FTS row must be written explicitly or these todos
  // would be invisible to `spider search`).
  const insTodo = projectDb.prepare(
    `INSERT INTO todos (session_id, seq, text, done, created_at, updated_at) VALUES (@sid, @seq, @text, 0, @now, @now)`,
  );
  const insFts = projectDb.prepare(`INSERT INTO todos_fts(rowid, text) VALUES (?, ?)`);
  const touch = globalDb.prepare(`UPDATE upstream_refs SET last_checked_at=@now, notes=@notes WHERE package=@pkg`);

  const checks = rows.filter((row) => !selected || selected.has(row.package));
  async function checkPackage(row: typeof rows[number]): Promise<PackageResult> {
    const check: UpstreamCheck = {
      package: row.package,
      upstreamRepo: deps.upstreamRepos?.[row.package] ?? row.upstream_repo,
      upstreamRef: row.upstream_ref ?? undefined,
      lastReviewedCommit: row.last_reviewed_commit ?? undefined,
    };

    let repoPath: string;
    try {
      repoPath = await fetchUpstreamMirror(check, deps.mirrorRoot, deps.git);
    } catch (error) {
      return {
        package: row.package,
        state: "fetch-failed",
        head: "",
        candidates: [],
        reason: errorMessage(error),
      };

    }

    let result: PackageResult;
    try {
      result = await diffUpstream(check, repoPath, deps.git);
    } catch (error) {
      result = {
        package: row.package,
        state: error instanceof GitTimeoutError ? "fetch-failed" : "unreachable",
        head: "",
        candidates: [],
        reason: errorMessage(error),
      };
    }
    return result;
  }

  // Workers claim input indices synchronously before awaiting. Slow or failed
  // fetches cannot block other workers, and completion order never changes output.
  let nextIndex = 0;
  await Promise.all(Array.from({ length: Math.min(UPSTREAM_CONCURRENCY, checks.length) }, async () => {
    while (nextIndex < checks.length) {
      const index = nextIndex++;
      packages[index] = await checkPackage(checks[index]);
    }
  }));

  // Keep DB updates and todo sequence numbers deterministic too.
  for (const result of packages) {
    touch.run({
      now,
      notes: result.head || `${result.state}: ${result.reason ?? "unknown error"}`,
      pkg: result.package,
    });

    for (const candidate of result.candidates) {
      const text = `upstream-watch(${candidate.package}): ${candidate.commit.slice(0, 7)} ${candidate.subject}`;
      if (findTodo.get({ sid: sessionId, text })) continue;
      const info = insTodo.run({ sid: sessionId, seq: nextSeq(projectDb, sessionId), text, now });
      insFts.run(Number(info.lastInsertRowid), text);
      todosAdded++;
    }
  }
  return { checkedAt: now, packages, todosAdded };
}

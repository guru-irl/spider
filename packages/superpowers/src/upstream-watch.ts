import type { Db } from "@spider/db-core";

export type GitRunner = (repoPath: string, args: string[]) => string;

export interface UpstreamCheck { package: string; upstreamRepo: string; upstreamRef?: string; lastReviewedCommit?: string; }
export interface CherryCandidate { package: string; commit: string; subject: string; }
export interface PackageResult { package: string; head: string; candidates: CherryCandidate[]; error?: string; }

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

export interface UpstreamWatchReport { checkedAt: number; packages: PackageResult[]; todosAdded: number; }

export function seedUpstreamRefs(globalDb: Db): void {
  const stmt = globalDb.prepare(
    `INSERT OR IGNORE INTO upstream_refs (package, upstream_repo, upstream_ref, last_checked_at)
     VALUES (@package, @repo, @ref, 0)`
  );
  for (const c of DEFAULT_UPSTREAM_REFS) {
    stmt.run({ package: c.package, repo: c.upstreamRepo, ref: c.upstreamRef ?? "main" });
  }
}

export function markReviewed(globalDb: Db, pkg: string, sha: string): void {
  globalDb.prepare(`UPDATE upstream_refs SET last_reviewed_commit=@sha WHERE package=@pkg`).run({ sha, pkg });
}

function nextSeq(projectDb: Db, sessionId: string): number {
  const row = projectDb.prepare(`SELECT COALESCE(MAX(seq),0) AS m FROM todos WHERE session_id=?`).get(sessionId) as { m: number };
  return (row.m ?? 0) + 1;
}

export function runUpstreamWatch(
  globalDb: Db,
  projectDb: Db,
  sessionId: string,
  deps: { git: GitRunner; localRepos: Record<string, string> },
): UpstreamWatchReport {
  seedUpstreamRefs(globalDb);
  const now = Date.now();
  const rows = globalDb
    .prepare(`SELECT package, upstream_repo, upstream_ref, last_reviewed_commit FROM upstream_refs`)
    .all() as Array<{ package: string; upstream_repo: string; upstream_ref: string | null; last_reviewed_commit: string | null }>;
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
  const touch = globalDb.prepare(`UPDATE upstream_refs SET last_checked_at=@now, notes=@head WHERE package=@pkg`);

  for (const row of rows) {
    const repoPath = deps.localRepos[row.package];
    if (!repoPath) continue;
    try {
      const res = diffUpstream(
        {
          package: row.package,
          upstreamRepo: row.upstream_repo,
          upstreamRef: row.upstream_ref ?? undefined,
          lastReviewedCommit: row.last_reviewed_commit ?? undefined,
        },
        repoPath,
        deps.git,
      );
      packages.push(res);
      touch.run({ now, head: res.head, pkg: row.package });
      for (const c of res.candidates) {
        const text = `upstream-watch(${c.package}): ${c.commit.slice(0, 7)} ${c.subject}`;
        if (findTodo.get({ sid: sessionId, text })) continue;
        const info = insTodo.run({ sid: sessionId, seq: nextSeq(projectDb, sessionId), text, now });
        insFts.run(Number(info.lastInsertRowid), text);
        todosAdded++;
      }
    } catch (e) {
      // A package that is not a local checkout (or whose ref cannot be resolved)
      // is recorded and skipped — one bad repo never aborts the whole watch.
      packages.push({ package: row.package, head: "", candidates: [], error: e instanceof Error ? e.message : String(e) });
    }
  }
  return { checkedAt: now, packages, todosAdded };
}

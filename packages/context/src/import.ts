import type { Db } from "@spider/db-core";
import { stageWrite, approvePending, enqueueEmbed, type MemoryCategory } from "@spider/memory";
import { readTranscript, selectSessionFiles } from "./transcript.js";
import { defaultDigest, type SessionDigest } from "./digest.js";
import { ContentStore } from "./content-store.js";

export interface ImportCtx {
  db: Db;
  cwd: string;
  sessionId: string;
  project?: unknown;
  auxModel?: string;
}

export interface ImportOpts {
  session?: string;
  sessions?: string[];
  select?: { project?: string; all?: boolean; since?: number; glob?: string };
  commit?: boolean;
  sourceMode?: "pi" | "hermes-db" | "todos-db" | "context-db";
}

export interface ImportSummary {
  imported: number;
  skipped: number;
  staged: number;
  committed: number;
  perSession: Array<{
    sessionId: string;
    status: "imported" | "skipped-duplicate";
    candidates: number;
    chunks: number;
  }>;
}

export async function importSessions(
  ctx: ImportCtx,
  opts: ImportOpts,
  digest: SessionDigest = defaultDigest,
): Promise<ImportSummary> {
  if (opts.sourceMode && opts.sourceMode !== "pi") {
    throw new Error(`source mode '${opts.sourceMode}' not yet implemented`);
  }

  const files: string[] = opts.session
    ? [opts.session]
    : opts.sessions
      ? opts.sessions
      : opts.select
        ? selectSessionFiles({ ...opts.select, cwd: ctx.cwd })
        : [];

  const summary: ImportSummary = { imported: 0, skipped: 0, staged: 0, committed: 0, perSession: [] };

  for (const fp of files) {
    const dup = ctx.db.prepare("SELECT id FROM sessions WHERE imported_from = ?").get(fp) as
      | { id: string }
      | undefined;
    if (dup) {
      summary.skipped++;
      summary.perSession.push({
        sessionId: dup.id,
        status: "skipped-duplicate",
        candidates: 0,
        chunks: 0,
      });
      continue;
    }

    const t = readTranscript(fp);
    const d = await digest(t, { auxModel: ctx.auxModel });

    for (const c of d.candidates) {
      if (c.kind === "memory" || c.kind === "skill") {
        const cat = (c.kind === "skill" ? "convention" : (c.category ?? "insight")) as MemoryCategory;
        const r = stageWrite(ctx.db, "project", {
          category: cat,
          content: c.content,
          link: c.link ?? null,
          source: "import",
        });
        if (r.status === "staged") {
          summary.staged++;
          if (opts.commit && r.uuid) {
            approvePending(ctx.db, "project", r.uuid);
            summary.committed++;
          }
        }
      } else if (c.kind === "todo") {
        const row = ctx.db
          .prepare("SELECT MAX(seq) AS m FROM todos WHERE session_id = ?")
          .get(t.sessionId) as { m: number | null } | undefined;
        const seq = (row?.m ?? 0) + 1;
        const now = Date.now();
        const info = ctx.db
          .prepare("INSERT INTO todos (session_id, seq, text, done, created_at) VALUES (?,?,?,0,?)")
          .run(t.sessionId, seq, c.content, now);
        ctx.db
          .prepare("INSERT INTO todos_fts(rowid, text) VALUES (?,?)")
          .run(info.lastInsertRowid, c.content);
      }
    }

    const joined = t.messages.map((m) => `${m.role}: ${m.text}`).join("\n");
    const res = new ContentStore(ctx.db).indexContent({ content: joined, source: "session:" + t.sessionId });
    for (const id of res.ids) {
      const row = ctx.db.prepare("SELECT chunk FROM content WHERE id=?").get(id) as { chunk: string } | undefined;
      if (row) enqueueEmbed(ctx.db, "content", String(id), row.chunk);
    }

    const sid = "import:" + t.sessionId;
    ctx.db
      .prepare("INSERT OR IGNORE INTO sessions (id, imported_from, summary, started_at) VALUES (?,?,?,?)")
      .run(sid, fp, d.summary ?? null, Date.now());
    ctx.db
      .prepare("INSERT INTO sessions_fts (id, name, summary, content) VALUES (?,?,?,?)")
      .run(sid, d.suggestedName ?? null, d.summary ?? "", joined.slice(0, 2000));

    summary.imported++;
    summary.perSession.push({
      sessionId: t.sessionId,
      status: "imported",
      candidates: d.candidates.length,
      chunks: res.chunkCount,
    });
  }

  return summary;
}

import type { Db } from "@spider/db-core";

export interface AutoIndexOpts {
  threshold: number;
  indexLargeOutput?: (text: string, source: string) => void;
}

export function autoIndexOutput(db: Db, text: string, source: string, opts: AutoIndexOpts): boolean {
  if (!text || text.length < opts.threshold) return false;
  try {
    if (opts.indexLargeOutput) {
      opts.indexLargeOutput(text, source);
      return true;
    }
    db.withRetry(() => {
      const run = db.transaction(() => {
        const info = db
          .prepare(
            "INSERT INTO content (source, path, hash, heading, chunk, is_code, created_at) VALUES (?,?,?,?,?,0,?)",
          )
          .run(source, null, null, null, text, Date.now());
        db.prepare("INSERT INTO content_fts (rowid, source, heading, chunk) VALUES (?,?,?,?)").run(
          info.lastInsertRowid,
          source,
          "",
          text,
        );
      });
      run();
    });
    return true;
  } catch {
    return false; // auto-index is best-effort; never break a tool result
  }
}

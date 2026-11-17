import { vi } from "vitest";
import type { Db } from "../db";

/** An always-true, non-deterministic predicate counts candidates after index selection. */
export function measureDerivedRows(db: Db) {
  let rows = 0;
  db.raw.function("count_derived_row", () => { rows++; return 1; });
  const prepare = db.prepare.bind(db);
  const spy = vi.spyOn(db, "prepare").mockImplementation(sql => {
    if (!/\b(?:FROM|UPDATE|INTO)\s+(?:memory_fts|sessions_fts|vector_map|embed_queue)\b/i.test(sql) ||
        !/\b(?:SELECT|DELETE|UPDATE)\b/i.test(sql)) return prepare(sql);
    // Ignore predicates in scalar subqueries, such as a session summary update.
    let depth = 0;
    for (const token of sql.matchAll(/'(?:''|[^'])*'|"(?:""|[^"])*"|\(|\)|\b(?:WHERE|ORDER|GROUP|LIMIT|RETURNING)\b/gi)) {
      if (token[0] === "(") depth++;
      else if (token[0] === ")") depth--;
      else if (depth === 0 && /^(WHERE|ORDER|GROUP|LIMIT|RETURNING)$/i.test(token[0])) {
        const at = token.index;
        return prepare(/^WHERE$/i.test(token[0])
          ? `${sql.slice(0, at)}WHERE count_derived_row() AND ${sql.slice(at + 5)}`
          : `${sql.slice(0, at)}WHERE count_derived_row() ${sql.slice(at)}`);
      }
    }
    return prepare(`${sql} WHERE count_derived_row()`);
  });
  return { get rows(): number { return rows; }, stop(): void { spy.mockRestore(); } };
}

import type { Db } from "@spider/db-core";
import { USAGE_MIGRATIONS } from "../../migrate.js";
import { USAGE_LEASE_SCHEMA } from "../../schema.js";

/** Frozen pre-v3 dynamic probes. Only the stored read predicates are replaced;
 * the production Overview statement and all its aggregation/DTO work still run. */
export function dynamicSelectionSql(sql: string): string {
  if (!/selection_shadowed|selection_undercount/.test(sql)) return sql;
  const replace = (input: string, pattern: string | RegExp, value: string) => {
    const output = typeof pattern === "string" ? input.replaceAll(pattern, value) : input.replace(pattern, value);
    if ((typeof pattern === "string" && output === input) || (pattern instanceof RegExp && !pattern.test(input))) throw new Error(`dynamic selection replacement did not match: ${pattern}`);
    return output;
  };
  sql = replace(sql, /window AS MATERIALIZED \(SELECT [\s\S]*? FROM calls c /, "window AS MATERIALIZED (SELECT c.* FROM calls c ");
  sql = replace(sql, "c.selection_shadowed = 0", `NOT EXISTS (SELECT 1 FROM calls prior WHERE prior.fingerprint = c.fingerprint
    AND (prior.copied, prior.source_file, prior.entry_id, prior.id) < (c.copied, c.source_file, c.entry_id, c.id))`);
  sql = replace(sql, "active.selection_shadowed = 0", `NOT EXISTS (SELECT 1 FROM calls prior WHERE prior.fingerprint = active.fingerprint
        AND (prior.copied, prior.source_file, prior.entry_id, prior.id) < (active.copied, active.source_file, active.entry_id, active.id))`);
  sql = replace(sql, "w.selection_undercount AS possible_undercount", `CASE WHEN EXISTS (SELECT 1 FROM import_state s WHERE s.path = w.source_file AND s.offset < s.size)
    OR EXISTS (SELECT 1 FROM incomplete_reports i WHERE i.path=w.source_file AND i.run_id=w.run_id)
    OR (w.is_report = 0 AND EXISTS (SELECT 1 FROM runs_meta r WHERE r.id = w.run_id AND r.ended_at IS NULL))
    THEN 1 ELSE 0 END AS possible_undercount`);
  return sql;
}
export function dynamicSelectionDb(db: Db): Db {
  return new Proxy(db, { get(target, key) {
    if (key === "prepare") return (sql: string) => target.prepare(dynamicSelectionSql(sql));
    const value = Reflect.get(target, key);
    return typeof value === "function" ? value.bind(target) : value;
  } });
}

/** Seed the immutable v2 layout first, so large tests measure migration and
 * queries, not a synthetic bulk-importer's application overhead. */
export function seedSelectionBenchmark(db: Db, rows: number, start: number, end: number): void {
  for (const m of USAGE_MIGRATIONS.filter(m => m.version <= 2)) db.exec(m.sql);
  db.exec(USAGE_LEASE_SCHEMA);
  db.pragma("user_version=2");
  const insert = db.prepare(`INSERT INTO calls(id,ts,source_file,entry_id,source_generation,project,repo,session_id,run_id,
    actor,role,provider,model,source_kind,input,output,cache_read,cache_write,price_status,aic,aic_input,aic_output,
    aic_cache_read,aic_cache_write,rate_version,tier,confidence,aggregate,counted,copied,fingerprint)
    VALUES (@id,@ts,@source,@id,0,@project,'synthetic-repo',@session,@run,@actor,@role,'synthetic-provider',@model,'transcript',
      10,20,30,40,'priced',1,0.1,0.2,0.3,0.4,'synthetic-rate','default','estimated',0,1,@copied,@fingerprint)`);
  const run = db.prepare("INSERT INTO runs_meta(id,db_path,ended_at) VALUES (?,'synthetic',?)");
  const state = db.prepare("INSERT INTO import_state(path,size,offset,last_ingest_at) VALUES (?,1000,?,?)");
  db.raw.transaction(() => {
    for (let r = 0; r < 300; r++) {
      run.run(`run-${r}`, r % 10 === 0 ? null : end);
      state.run(`source-${r}`, r % 19 === 0 ? 900 : 1000, end);
    }
    for (let n = 0; n < rows; n++) {
      const id = `call-${String(n).padStart(8, "0")}`;
      insert.run({ id, ts: start + Math.floor((end - start - 1) * n / rows), source: `source-${n % 300}`,
        project: `project-${n % 20}`, session: `session-${n % 300}`, run: n % 3 === 0 ? null : `run-${n % 300}`,
        actor: n % 3 === 0 ? "parent" : "subagent", role: `role-${n % 12}`, model: `model-${n % 5}`,
        copied: n % 20 === 1 ? 1 : 0, fingerprint: `fp-${n % 20 === 1 ? n - 1 : n}` });
    }
  }).immediate();
}

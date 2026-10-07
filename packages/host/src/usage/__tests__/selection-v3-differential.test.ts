import { expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openDb, type Db } from "@spider/db-core";
import { migrateUsageLedger, USAGE_MIGRATIONS } from "../migrate.js";
import { countedUsageSql, USAGE_LEASE_SCHEMA } from "../schema.js";
import { DIMENSION_COLUMNS } from "../dimension-values.js";
import { countedUsageSql as baseCounted, USAGE_SCHEMA as BASE_V1, USAGE_SCHEMA_V2 as BASE_V2 } from "./fixtures/selection-v2-frozen.js";

const SEQUENCES = Number(process.env.REVIEW_SEQ ?? 50);
const STEPS = Number(process.env.REVIEW_STEPS ?? 24);

// Independent reference expressions (copied from the ce0c8f4 dynamic rules).
const SHADOW_DYN = `EXISTS (SELECT 1 FROM calls p WHERE p.fingerprint = c.fingerprint
  AND (p.copied, p.source_file, p.entry_id, p.id) < (c.copied, c.source_file, c.entry_id, c.id))`;
const UNDER_DYN = `(EXISTS (SELECT 1 FROM import_state s WHERE s.path = c.source_file AND s.offset < s.size)
  OR EXISTS (SELECT 1 FROM incomplete_reports i WHERE i.path=c.source_file AND i.run_id=c.run_id)
  OR (c.is_report = 0 AND EXISTS (SELECT 1 FROM runs_meta r WHERE r.id = c.run_id AND r.ended_at IS NULL)))`;
const NARROW = "c.ts,c.actor,c.role,c.price_status,c.aggregate,c.aic,c.run_id,c.is_report,c.source_file,c.source_kind";
const INSERT_COLS = `id,ts,source_file,entry_id,source_generation,project,role,model,run_id,parent_run_id,actor,source_kind,
  input,output,cache_read,cache_write,price_status,aic,aic_input,aic_cache_read,aic_cache_write,aic_output,rate_version,tier,confidence,
  aggregate,counted,copied,fingerprint`;
const INSERT_SQL = `INSERT INTO calls(${INSERT_COLS}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1,1,1,1,'priced',?,0,0,0,0,'r','t','estimated',?,?,?,?)
  ON CONFLICT(source_file, entry_id) DO NOTHING`;

it("v2/v3 shipped SQL is unchanged and dynamic mode equals ce0c8f4", () => {
  expect(USAGE_MIGRATIONS[0]!.sql).toBe(BASE_V1);
  expect(USAGE_MIGRATIONS[1]!.sql).toBe(BASE_V2);
  for (const args of [["1", "c.*", undefined], ["c.ts>=? AND c.ts<?", NARROW, "calls_period_read"], ["c.session_id=?", "c.*", "calls_session_read"]] as const) {
    expect(countedUsageSql(args[0], args[1], args[2], false)).toBe(baseCounted(args[0], args[1], args[2]));
  }
});

it("randomized differential: stored decisions, selection, revision and registry", () => {
  const root = mkdtempSync(join(process.env.SPIDER_GLOBAL_ROOT!, "review-diff-"));
  let seed = Number(process.env.REVIEW_SEED ?? 0x5eed1234);
  const rnd = (n: number) => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return (seed >>> 8) % n; };
  const pick = <T,>(xs: readonly T[]) => xs[rnd(xs.length)]!;
  const FP = ["f0", "f1", "f2", "f3"], SRC = ["s0", "s1", "s2", "s3"], RUN = [null, "r0", "r1", "r2", "r3"], ID = Array.from({ length: 10 }, (_, i) => `c${i}`);
  const ENT = ["e0", "e1", "e2", "e3", "e4"], ROLE = [null, "", "a", "b"], PROJ = [null, "p0", "p1"];
  let steps = 0, checks = 0, failures: string[] = [];
  const stats: Record<string, number> = {};
  try {
    for (let s = 0; s < SEQUENCES && failures.length === 0; s++) {
      const file = join(root, `l${s}.db`);
      const old = openDb(file, { busyTimeoutMs: 0 });
      for (const m of USAGE_MIGRATIONS.filter(m => m.version <= 2)) old.exec(m.sql);
      old.exec(USAGE_LEASE_SCHEMA); old.pragma("user_version = 2");
      // Old (v2) writer statements prepared before the migration.
      const oldInsert = old.prepare(INSERT_SQL);
      const neu = openDb(file, { busyTimeoutMs: 0 });
      const conns = [old, neu];
      let migrated = false;
      let lastRev = -1, lastSig = "";
      const model = new Map<string, [number, number]>();
      const insertRow = (db: Db) => {
        const actor = pick(["parent", "subagent", "aux"]); const run = pick(RUN); const aggregate = rnd(3) === 0 ? 1 : 0;
        const isReport = actor === "subagent" && aggregate === 1 && run !== null;
        const kind = rnd(20) === 0 ? "report" : isReport ? "report" : "transcript";
        const args = [pick(ID), 1000 + rnd(5) * 86_400_000 + rnd(1000), pick(SRC), pick(ENT), rnd(2), pick(PROJ), pick(ROLE), pick(["m0", "m1"]), run, pick(RUN),
          actor, kind, rnd(4), aggregate, rnd(2), rnd(3) === 0 ? 1 : 0, pick(FP)];
        (db === old ? oldInsert : db.prepare(INSERT_SQL)).run(...args);
      };
      const ops: [string, (db: Db) => void][] = [
        ["insert", insertRow], ["insert2", insertRow], ["insert3", insertRow],
        ["delete", db => db.prepare("DELETE FROM calls WHERE id=?").run(pick(ID))],
        ["reset", db => db.prepare("DELETE FROM calls WHERE source_file=? AND source_generation<?").run(pick(SRC), 1)],
        ["copied", db => db.prepare("UPDATE calls SET copied=1-copied WHERE id=?").run(pick(ID))],
        ["copiedMulti", db => db.prepare("UPDATE calls SET copied=1-copied WHERE fingerprint=?").run(pick(FP))],
        ["fingerprint", db => db.prepare("UPDATE calls SET fingerprint=? WHERE id=?").run(pick(FP), pick(ID))],
        ["fingerprintMulti", db => db.prepare("UPDATE calls SET fingerprint=? WHERE source_file=?").run(pick(FP), pick(SRC))],
        ["alias", db => db.prepare("UPDATE calls SET model=?, fingerprint=? WHERE id=?").run(pick(["m0", "m1", "m2"]), pick(FP), pick(ID))],
        ["source", db => db.prepare("UPDATE calls SET source_file=? WHERE id=?").run(pick(SRC), pick(ID))],
        ["entry", db => db.prepare("UPDATE calls SET entry_id=? WHERE id=?").run(pick(ENT), pick(ID))],
        ["id", db => db.prepare("UPDATE calls SET id=? WHERE id=?").run(pick(ID), pick(ID))],
        ["counted", db => db.prepare("UPDATE calls SET counted=1-counted WHERE id=?").run(pick(ID))],
        ["generation", db => db.prepare("UPDATE calls SET source_generation=source_generation+1 WHERE source_file=?").run(pick(SRC))],
        ["runId", db => db.prepare("UPDATE calls SET run_id=? WHERE id=? AND is_report=0 AND source_kind<>'report'").run(pick(RUN), pick(ID))],
        ["report", db => db.prepare("UPDATE calls SET actor='subagent',aggregate=1,source_kind='report',run_id=COALESCE(run_id,'r1') WHERE id=?").run(pick(ID))],
        ["unreport", db => db.prepare("UPDATE calls SET actor=?,aggregate=0,source_kind='transcript' WHERE id=?").run(pick(["parent", "subagent"]), pick(ID))],
        ["unreportAgg", db => db.prepare("UPDATE calls SET actor='parent',source_kind='transcript' WHERE id=?").run(pick(ID))],
        ["dims", db => db.prepare("UPDATE calls SET ts=?,role=?,project=? WHERE id=?").run(1000 + rnd(7) * 86_400_000, pick(ROLE), pick(PROJ), pick(ID))],
        ["stateUpsert", db => db.prepare(`INSERT INTO import_state(path,size,offset,generation,last_ingest_at) VALUES (?,?,?,?,1)
          ON CONFLICT(path) DO UPDATE SET size=excluded.size,offset=excluded.offset,generation=excluded.generation`).run(pick(SRC), pick([10, 20]), pick([5, 10, null]), rnd(2))],
        ["stateSize", db => db.prepare("UPDATE import_state SET size=? WHERE path=?").run(pick([5, 10, 20]), pick(SRC))],
        ["aggOnly", db => db.prepare(`UPDATE calls SET aggregate=1-aggregate, source_kind=CASE WHEN aggregate=0 THEN 'report' ELSE 'transcript' END
          WHERE id=? AND actor='subagent' AND run_id IS NOT NULL`).run(pick(ID))],
        ["runOnly", db => db.prepare("UPDATE calls SET run_id=? WHERE id=? AND is_report=0 AND source_kind<>'report'").run(pick(RUN), pick(ID))],
        ["runOpen", db => db.prepare(`INSERT INTO runs_meta(id,db_path,ended_at) VALUES (?,?,NULL) ON CONFLICT(db_path,id) DO UPDATE SET ended_at=NULL`).run(pick(RUN.slice(1)), "d0")],
        ["entryOnly", db => db.prepare("UPDATE calls SET entry_id=? WHERE id=?").run(pick(ENT), pick(ID))],
        ["stateError", db => db.prepare(`INSERT INTO import_state(path,source_error_code,last_ingest_at) VALUES (?,'x',1)
          ON CONFLICT(path) DO UPDATE SET source_error_code=excluded.source_error_code`).run(pick(SRC))],
        ["stateDelete", db => db.prepare("DELETE FROM import_state WHERE path=?").run(pick(SRC))],
        ["statePath", db => db.prepare("UPDATE import_state SET path=? WHERE path=?").run(pick(SRC), pick(SRC))],
        ["stateComplete", db => db.prepare("UPDATE import_state SET offset=size").run()],
        ["incompletePut", db => db.prepare("INSERT OR IGNORE INTO incomplete_reports(path,run_id) VALUES (?,?)").run(pick(SRC), pick(RUN.slice(1)))],
        ["incompleteDel", db => db.prepare("DELETE FROM incomplete_reports WHERE path=?").run(pick(SRC))],
        ["incompleteUpd", db => db.prepare("UPDATE incomplete_reports SET run_id=? WHERE path=?").run(pick(RUN.slice(1)), pick(SRC))],
        ["runPut", db => db.prepare(`INSERT INTO runs_meta(id,db_path,ended_at) VALUES (?,?,?) ON CONFLICT(db_path,id) DO UPDATE SET ended_at=excluded.ended_at`)
          .run(pick(RUN.slice(1)), pick(["d0", "d1"]), pick([null, 5]))],
        ["runDel", db => db.prepare("DELETE FROM runs_meta WHERE id=? AND db_path=?").run(pick(RUN.slice(1)), pick(["d0", "d1"]))],
        ["runId2", db => db.prepare("UPDATE runs_meta SET id=? WHERE id=?").run(pick(RUN.slice(1)), pick(RUN.slice(1)))],
        ["edgePut", db => db.prepare("INSERT OR IGNORE INTO coverage_edges VALUES (?,?,?)").run(pick(RUN.slice(1)), pick(RUN.slice(1)), pick(["transcript", "runs-db", "unknown"]))],
        ["edgeDel", db => db.prepare("DELETE FROM coverage_edges WHERE report_run_id=?").run(pick(RUN.slice(1)))],
        ["setShadow", db => { if (migrated) db.prepare("UPDATE calls SET selection_shadowed=selection_shadowed").run(); }],
      ];
      const snapshot = (db: Db) => {
        const rev = Number((db.prepare("SELECT value FROM ledger_metadata WHERE key='call-selection-revision'").get() as { value: string }).value);
        const decisions = migrated ? JSON.stringify(db.prepare("SELECT id,selection_shadowed,selection_undercount FROM calls ORDER BY id").all()) : "";
        const counted = JSON.stringify(db.prepare(`SELECT * FROM (${baseCounted("1", "c.id,c.ts,c.run_id,c.is_report,c.source_file,c.source_kind")}) ORDER BY id`).all());
        return { rev, sig: decisions + counted };
      };
      const observe = (db: Db, target: Map<string, [number, number]>) => {
        for (const row of db.prepare(`SELECT ts,${[...new Set(Object.values(DIMENSION_COLUMNS))].join(",")} FROM calls`).all() as Record<string, unknown>[]) {
          for (const [dim, col] of Object.entries(DIMENSION_COLUMNS)) {
            const v = dim === "day" ? new Date(row.ts as number).toISOString().slice(0, 10) : row[col];
            if (v === null) continue;
            const key = `${dim}\u0000${v === null ? "N" : `V${String(v)}`}`;
            const ts = row.ts as number; const cur = target.get(key);
            target.set(key, cur ? [Math.min(cur[0], ts), Math.max(cur[1], ts)] : [ts, ts]);
          }
        }
      };
      const check = (label: string) => {
        checks++;
        const bad = neu.prepare(`SELECT id FROM calls c WHERE selection_shadowed IS NOT ${SHADOW_DYN} OR selection_undercount IS NOT ${UNDER_DYN}`).all();
        if (bad.length) failures.push(`seq ${s} ${label}: drift ${JSON.stringify(bad)} ${JSON.stringify(neu.prepare("SELECT id,fingerprint,copied,source_file,entry_id,run_id,is_report,selection_shadowed,selection_undercount FROM calls").all())}`);
        for (const [pred, proj, idx, params] of [["1", "c.*", undefined, []], ["c.ts>=? AND c.ts<?", NARROW, "calls_period_read", [1000, 1000 + 3 * 86_400_000]],
          ["c.session_id IS NULL AND c.ts>=?", "c.*", undefined, [0]]] as const) {
          const stored = (neu.prepare(`SELECT * FROM (${countedUsageSql(pred, proj, idx, true)})`).all(...params) as Record<string, unknown>[])
            .map(r => { if (proj !== "c.*") delete r.selection_undercount; return JSON.stringify(r); }).sort();
          const dynamic = (neu.prepare(`SELECT * FROM (${baseCounted(pred, proj, idx)})`).all(...params) as unknown[]).map(r => JSON.stringify(r)).sort();
          if (JSON.stringify(stored) !== JSON.stringify(dynamic)) failures.push(`seq ${s} ${label}: selection differs for ${pred}`);
        }
        const reg = new Map((neu.prepare("SELECT dimension,has_value,value,first_seen,last_seen FROM dimension_values").all() as
          { dimension: string; has_value: number; value: string; first_seen: number; last_seen: number }[])
          .map(r => [`${r.dimension}\u0000${r.has_value ? `V${r.value}` : "N"}`, [r.first_seen, r.last_seen] as [number, number]]));
        const want = JSON.stringify([...model].sort());
        const got = JSON.stringify([...reg].sort());
        if (want !== got) failures.push(`seq ${s} ${label}: registry ${got.length} vs ${want.length} ${[...model].filter(([k, v]) => JSON.stringify(reg.get(k)) !== JSON.stringify(v)).slice(0, 3).map(x => JSON.stringify(x))}`);
      };
      const step = (label: string, body: () => void, db: Db) => {
        const before = snapshot(neu);
        let committed = true;
        const pending = new Map(model);
        try { body(); } catch (e) {
          const msg = String((e as Error).message);
          if (!/constraint|UNIQUE|CHECK|NOT NULL|locked|busy/i.test(msg)) failures.push(`seq ${s} ${label}: unexpected error ${msg}`);
          stats[`err:${label}`] = (stats[`err:${label}`] ?? 0) + 1;
          if (db.raw.inTransaction) db.exec("ROLLBACK");
          committed = false;
        }
        if (committed && migrated) observe(neu, pending);
        const after = snapshot(neu);
        if (committed) { for (const [k, v] of pending) model.set(k, v); }
        if (after.rev < before.rev) failures.push(`seq ${s} ${label}: revision decreased`);
        if (after.sig !== before.sig && !(after.rev > before.rev)) failures.push(`seq ${s} ${label}: selection changed without revision bump`);
        if (!committed && (after.sig !== before.sig || after.rev !== before.rev)) failures.push(`seq ${s} ${label}: failed statement leaked state`);
        lastRev = after.rev; lastSig = after.sig; steps++;
        if (migrated) check(label);
      };
      try {
        // Phase 1: pre-migration v2 history written by the old writer only.
        for (let i = rnd(12); i > 0; i--) { const [label, op] = pick(ops); step(`pre:${label}`, () => op(old), old); }
        migrateUsageLedger(neu);
        migrated = true;
        observe(neu, model);
        // Backfill must equal what historic rows imply. Registry: only current rows are known pre-migration.
        check("backfill");
        for (let i = 0; i < STEPS; i++) {
          const db = pick(conns);
          const kind = rnd(10);
          if (kind === 0) {
            // Multi-op transaction, sometimes rolled back.
            const n = 2 + rnd(4); const rollback = rnd(2) === 0; const pending = new Map(model);
            const before = snapshot(neu);
            db.exec("BEGIN IMMEDIATE");
            let ok = true;
            for (let j = 0; j < n; j++) {
              const [label, op] = pick(ops);
              db.exec("SAVEPOINT sp");
              try { op(db); db.exec("RELEASE sp"); observe(db, pending); } catch { db.exec("ROLLBACK TO sp"); db.exec("RELEASE sp"); }
              stats[`tx:${label}`] = (stats[`tx:${label}`] ?? 0) + 1;
            }
            // The other connection is blocked while the write transaction is open.
            const other = conns.find(c => c !== db)!;
            try { other.prepare("DELETE FROM calls WHERE id='nope'").run(); failures.push(`seq ${s}: second writer not blocked`); } catch (e) { if (!/locked|busy/i.test(String(e))) { failures.push(`seq ${s}: unexpected ${String(e)}`); ok = false; } }
            db.exec(rollback ? "ROLLBACK" : "COMMIT");
            if (!rollback) for (const [k, v] of pending) model.set(k, v);
            const after = snapshot(neu);
            if (rollback && (after.sig !== before.sig || after.rev !== before.rev)) failures.push(`seq ${s}: rollback leaked`);
            if (!rollback && after.sig !== before.sig && !(after.rev > before.rev)) failures.push(`seq ${s}: tx changed selection without bump`);
            if (ok) check(rollback ? "tx-rollback" : "tx-commit");
            steps++;
          } else if (kind === 1) {
            // Stale deferred reader on one connection, writer commits on the other, reader then tries to write.
            const other = conns.find(c => c !== db)!;
            db.exec("BEGIN"); db.prepare("SELECT count(*) FROM calls").get();
            const [label, op] = pick(ops);
            try { op(other); } catch { /* constraint */ }
            try { insertRow(db); } catch (e) { if (!/busy|locked|constraint|UNIQUE|CHECK/i.test(String(e))) failures.push(`seq ${s}: stale ${String(e)}`); }
            if (db.raw.inTransaction) db.exec("ROLLBACK");
            observe(neu, model);
            check(`stale:${label}`); steps++;
          } else {
            const [label, op] = pick(ops);
            stats[label] = (stats[label] ?? 0) + 1;
            step(label, () => op(db), db);
          }
        }
      } finally { old.close(); neu.close(); rmSync(file, { force: true }); rmSync(`${file}-wal`, { force: true }); rmSync(`${file}-shm`, { force: true }); }
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
  const summary = JSON.stringify({ sequences: SEQUENCES, seed: process.env.REVIEW_SEED, steps, checks, failures: failures.length, firstFailures: failures.slice(0, 5), stats });
  console.log(summary);
  if (process.env.REVIEW_OUT) writeFileSync(process.env.REVIEW_OUT, summary);
  expect(failures.slice(0, 5)).toEqual([]);
}, 3_600_000);

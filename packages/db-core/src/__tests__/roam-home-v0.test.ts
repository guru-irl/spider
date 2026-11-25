import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { openDb } from "../db";
import { migrate } from "../migrate";
import { migrateHomeV0 } from "../roam/home-v0-migration";
import { GENERATED_TRIGGERS } from "../roam/generated";
import { exportBatch } from "../roam/export";
import type { JsonObject } from "../roam/types";
import { replica, home, clock, batch, apply, validate, A, B, C, SESSION, rows } from "./roam-apply-fixture";

// Frozen public schema-14 capture SQL from the pre-v0 layout.
const LEGACY = {
  "roam_session_homes_capture_ai": "CREATE TRIGGER roam_session_homes_capture_ai AFTER INSERT ON session_homes\nWHEN (SELECT capture_enabled = 1 AND importing = 0 FROM roam_meta WHERE id = 1)\nBEGIN\n\tUPDATE roam_meta SET (hlc_ms, hlc_count) = (\n\t\tWITH sample(ms) AS (\n\t\t\tSELECT CAST(unixepoch('subsec') * 1000 AS INTEGER)\n\t\t)\n\t\tSELECT max(roam_meta.hlc_ms, sample.ms),\n\t\t\tCASE WHEN sample.ms > roam_meta.hlc_ms THEN 0 ELSE roam_meta.hlc_count + 1 END\n\t\tFROM sample\n\t) WHERE id = 1;\n\tINSERT INTO roam_changes (\n\t\tchange_id, entity, row_key, op, hlc_ms, hlc_count,\n\t\torigin_machine, origin_stream, writer_session, writer_epoch,\n\t\tschema_version, body_json\n\t)\n\tSELECT lower(hex(randomblob(16))), 'session_homes', NEW.session_id, 'put', hlc_ms, hlc_count,\n\t\tmachine_id, stream_id, NULL,\n\t\tNULL, 14,\n\t\tjson_object('session_id', NEW.session_id, 'machine_id', NEW.machine_id, 'epoch', NEW.epoch,\n\t\t\t'move_id', NEW.move_id, 'updated_at', NEW.updated_at)\n\tFROM roam_meta WHERE id = 1;\n\tINSERT INTO roam_versions\n\tSELECT entity, row_key, change_id, hlc_ms, hlc_count,\n\t\torigin_machine, origin_stream, 0\n\tFROM roam_changes WHERE seq = last_insert_rowid()\n\tON CONFLICT(entity, row_key) DO UPDATE SET\n\t\tchange_id = excluded.change_id, hlc_ms = excluded.hlc_ms,\n\t\thlc_count = excluded.hlc_count, origin_machine = excluded.origin_machine,\n\t\torigin_stream = excluded.origin_stream, deleted = excluded.deleted;\nEND;",
  "roam_session_homes_capture_au": "CREATE TRIGGER roam_session_homes_capture_au AFTER UPDATE ON session_homes\nWHEN (SELECT capture_enabled = 1 AND importing = 0 FROM roam_meta WHERE id = 1)\n\tAND json_object('session_id', OLD.session_id, 'machine_id', OLD.machine_id, 'epoch', OLD.epoch,\n\t\t\t'move_id', OLD.move_id, 'updated_at', OLD.updated_at) IS NOT json_object('session_id', NEW.session_id, 'machine_id', NEW.machine_id, 'epoch', NEW.epoch,\n\t\t\t'move_id', NEW.move_id, 'updated_at', NEW.updated_at)\nBEGIN\n\tUPDATE roam_meta SET (hlc_ms, hlc_count) = (\n\t\tWITH sample(ms) AS (\n\t\t\tSELECT CAST(unixepoch('subsec') * 1000 AS INTEGER)\n\t\t)\n\t\tSELECT max(roam_meta.hlc_ms, sample.ms),\n\t\t\tCASE WHEN sample.ms > roam_meta.hlc_ms THEN 0 ELSE roam_meta.hlc_count + 1 END\n\t\tFROM sample\n\t) WHERE id = 1;\n\tINSERT INTO roam_changes (\n\t\tchange_id, entity, row_key, op, hlc_ms, hlc_count,\n\t\torigin_machine, origin_stream, writer_session, writer_epoch,\n\t\tschema_version, body_json\n\t)\n\tSELECT lower(hex(randomblob(16))), 'session_homes', NEW.session_id, 'put', hlc_ms, hlc_count,\n\t\tmachine_id, stream_id, NULL,\n\t\tNULL, 14,\n\t\tjson_object('session_id', NEW.session_id, 'machine_id', NEW.machine_id, 'epoch', NEW.epoch,\n\t\t\t'move_id', NEW.move_id, 'updated_at', NEW.updated_at)\n\tFROM roam_meta WHERE id = 1;\n\tINSERT INTO roam_versions\n\tSELECT entity, row_key, change_id, hlc_ms, hlc_count,\n\t\torigin_machine, origin_stream, 0\n\tFROM roam_changes WHERE seq = last_insert_rowid()\n\tON CONFLICT(entity, row_key) DO UPDATE SET\n\t\tchange_id = excluded.change_id, hlc_ms = excluded.hlc_ms,\n\t\thlc_count = excluded.hlc_count, origin_machine = excluded.origin_machine,\n\t\torigin_stream = excluded.origin_stream, deleted = excluded.deleted;\nEND;"
};

function oldStore() {
  const store = replica("global", A);
  for (const trigger of GENERATED_TRIGGERS.global.filter(t => t.name.startsWith("roam_session_homes_")))
    store.db.exec(`DROP TRIGGER ${trigger.name}`);
  store.db.exec(`DROP TABLE session_homes;
    CREATE TABLE session_homes (session_id TEXT PRIMARY KEY, machine_id TEXT NOT NULL,
      epoch INTEGER NOT NULL CHECK(epoch > 0), move_id TEXT, updated_at INTEGER NOT NULL)`);
  for (const sql of Object.values(LEGACY)) store.db.exec(sql);
  const identity = GENERATED_TRIGGERS.global.find(t => t.name === "roam_session_homes_identity_bu")!;
  const deleted = GENERATED_TRIGGERS.global.find(t => t.name === "roam_session_homes_capture_ad")!;
  store.db.exec(identity.sql); store.db.exec(deleted.sql);
  return store;
}

function moving(destination = B) {
  return { ...home(A, 2, clock(), "v0-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
    body: { session_id: SESSION, machine_id: A, epoch: 2,
      move_id: "v0-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", updated_at: 123,
      state: "moving", destination } };
}

describe("v0 home layout and replication", () => {
  it("fresh and migrated homes have the same projection", () => {
    const fresh = replica("global", A), old = oldStore();
    old.db.prepare("INSERT INTO session_homes VALUES (?, ?, ?, ?, ?)").run(SESSION, A, 7, "legacy-move", 91);
    migrate(old.db, "global", { machineId: A, globalRoot: old.root });
    expect(old.db.prepare("PRAGMA table_info(session_homes)").all()).toEqual(fresh.db.prepare("PRAGMA table_info(session_homes)").all());
    expect(rows(old, "session_homes")).toEqual([{session_id: SESSION, machine_id: A, epoch: 7, move_id: "legacy-move", updated_at: 91, state: null, destination: null}]);
    const before = rows(old, "session_homes");
    migrateHomeV0(old.db); migrate(old.db, "global", {machineId: A, globalRoot: old.root});
    expect(rows(old, "session_homes")).toEqual(before);
    const columns = old.db.prepare("PRAGMA table_info(session_homes)").all() as {name:string;notnull:number}[];
    expect(columns.filter(c => ["state", "destination"].includes(c.name)).map(c => c.notnull)).toEqual([0, 0]);
    expect(old.db.pragma("user_version")).toBe(14);
  });

  it("moving home survives export apply and reopen", async () => {
    const source = replica("global", A), target = replica("global", B);
    source.db.exec("UPDATE roam_meta SET capture_enabled = 1");
    source.db.prepare("INSERT INTO session_homes(session_id,machine_id,epoch,move_id,updated_at,state,destination) VALUES (?, ?, 1, NULL, 100, 'running', NULL)").run(SESSION, A);
    expect(source.db.prepare("UPDATE session_homes SET epoch=2, move_id=?, updated_at=123, state='moving', destination=? WHERE session_id=? AND epoch=1 AND state='running' AND destination IS NULL AND move_id IS NULL").run(moving().body.move_id, B, SESSION).changes).toBe(1);
    const exported = await exportBatch(source.db, {after:0,targetBytes:100000,batchId:"moving"}, {encode:(_e,b)=>b});
    apply(target, await validate(exported, Date.now()+1000), undefined, undefined, Date.now()+1000);
    const reopened = openDb(join(target.root, "store.db"));
    try { expect(reopened.prepare("SELECT * FROM session_homes").all()).toEqual([{session_id: SESSION, machine_id:A,epoch:2,move_id:moving().body.move_id,updated_at:123,state:"moving",destination:B}]); }
    finally { reopened.close(); }
  });

  it("exact legacy projection normalizes only the new fields", async () => {
    const target = replica("global");
    apply(target, await batch(target, [home(A, 1)]));
    expect(rows(target, "session_homes")).toEqual([{session_id:SESSION,machine_id:A,epoch:1,move_id:null,updated_at:1,state:null,destination:null}]);
    const invalidBodies: JsonObject[] = [
      {session_id:SESSION,epoch:1,move_id:null,updated_at:1},
      {...home(A,1).body, extra:"x"},
      {...moving().body,state:"bogus"}, {...moving().body,destination:null},
      {...moving().body,state:"running"},
    ];
    for (const invalid of invalidBodies) await expect(batch(target, [{...home(A,1),body:invalid}])).rejects.toThrow();
    // Old queued rows remain exportable after the additive migration.
    const old = oldStore(); old.db.exec("UPDATE roam_meta SET capture_enabled=1");
    old.db.prepare("INSERT INTO session_homes VALUES (?, ?, 1, NULL, 1)").run(SESSION,A);
    migrate(old.db,"global",{machineId:A,globalRoot:old.root});
    const exported = await exportBatch(old.db,{after:0,targetBytes:100000,batchId:"legacy-export"},{encode:(_e,b)=>b});
    const receiver = replica("global", B);
    apply(receiver,await validate(exported, Date.now()+1000), undefined, undefined, Date.now()+1000);
    expect(rows(receiver,"session_homes")).toEqual(rows(target,"session_homes"));
  });

  it("same epoch with a different state or destination conflicts", async () => {
    const target = replica("global");
    apply(target, await batch(target,[moving()]));
    const before = rows(target,"session_homes");
    for (const body of [{...moving(C).body}, {...moving().body,state:"running",destination:null}]) {
      const conflict = await batch(target,[{...moving(),changeId:"conflict",clock:clock(2000),body}],{after:1,id:"conflict"});
      expect(()=>apply(target,conflict)).toThrow(/conflict/);
      expect(rows(target,"session_homes")).toEqual(before);
    }
    apply(target, await batch(target,[{...moving(),changeId:"identical",clock:clock(2000)}],{after:1,id:"identical"}));
    expect(rows(target,"session_homes")).toEqual(before);
    const foreign = await batch(target,[{...moving(),changeId:"foreign",clock:clock(3000,0,B)}],{after:2,id:"foreign"});
    expect(()=>apply(target,foreign)).toThrow(/hub/);
    expect(rows(target,"session_homes")).toEqual(before);
  });

  it("legacy running adoption replicates at the preserved epoch", async () => {
    const target = replica("global");
    apply(target,await batch(target,[home(A,7,clock(),null,"legacy")]));
    const adopted = {...home(A,7,clock(2000),null,"adopted"),body:{...home(A,7).body,state:"running",destination:null,updated_at:100}};
    apply(target,await batch(target,[adopted],{after:1,id:"adopted"}));
    expect(rows(target,"session_homes")).toEqual([{session_id:SESSION,machine_id:A,epoch:7,move_id:null,updated_at:100,state:"running",destination:null}]);
  });

  it("malformed v0 identities refuse before apply", async () => {
    const target = replica("global");
    for (const body of [
      {...moving().body,session_id:"\n"}, {...moving().body,session_id:" "},
      {...moving().body,move_id:"old-move"}, {...moving().body,move_id:null},
      {...moving().body,epoch:0}, {...moving().body,epoch:Number.MAX_SAFE_INTEGER+1},
      {...moving().body,machine_id:"invalid"}, {...moving().body,updated_at:-1},
    ]) {
      await expect(batch(target,[{...moving(),rowKey:body.session_id,body}])).rejects.toThrow();
      expect(rows(target,"session_homes")).toEqual([]);
    }
  });

  it("known legacy triggers upgrade but unknown drift refuses", () => {
    const old = oldStore(); old.db.exec("UPDATE roam_meta SET capture_enabled=1");
    migrate(old.db,"global",{machineId:A,globalRoot:old.root});
    expect(old.db.prepare("SELECT capture_enabled,problem FROM roam_meta").get()).toEqual({capture_enabled:1,problem:null});
    old.db.prepare("INSERT INTO session_homes(session_id,machine_id,epoch,updated_at,state) VALUES (?, ?, 1, 1, 'running')").run(SESSION,A);
    expect(JSON.parse((old.db.prepare("SELECT body_json FROM roam_changes").get() as {body_json:string}).body_json)).toEqual({session_id:SESSION,machine_id:A,epoch:1,move_id:null,updated_at:1,state:"running",destination:null});
    const drift = oldStore();
    drift.db.exec("DROP TRIGGER roam_session_homes_capture_ai");
    const unknown = LEGACY.roam_session_homes_capture_ai.replace("capture_enabled = 1", "capture_enabled = 1 AND 1 = 1");
    drift.db.exec(unknown); drift.db.exec("UPDATE roam_meta SET capture_enabled=1");
    migrate(drift.db,"global",{machineId:A,globalRoot:drift.root});
    expect((drift.db.prepare("SELECT sql FROM sqlite_master WHERE name='roam_session_homes_capture_ai'").get() as {sql:string}).sql).toBe(unknown.trim().replace(/;$/, ""));
    expect(drift.db.prepare("SELECT capture_enabled FROM roam_meta").get()).toEqual({capture_enabled:0});
    expect(()=>drift.db.prepare("INSERT INTO session_homes(session_id,machine_id,epoch,updated_at) VALUES (?, ?, 1, 1)").run(SESSION,A)).not.toThrow();
    expect(rows(drift,"roam_changes")).toEqual([]);
  });
});

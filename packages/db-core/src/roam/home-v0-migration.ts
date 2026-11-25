import type { Db } from "../db";
import { GENERATED_TRIGGERS } from "./generated";

// Exact public schema-14 trigger definitions. Unknown drift must not be repaired.
const LEGACY_CAPTURE: Readonly<Record<string, string>> = {
  "roam_session_homes_capture_ai": "CREATE TRIGGER roam_session_homes_capture_ai AFTER INSERT ON session_homes\nWHEN (SELECT capture_enabled = 1 AND importing = 0 FROM roam_meta WHERE id = 1)\nBEGIN\n\tUPDATE roam_meta SET (hlc_ms, hlc_count) = (\n\t\tWITH sample(ms) AS (\n\t\t\tSELECT CAST(unixepoch('subsec') * 1000 AS INTEGER)\n\t\t)\n\t\tSELECT max(roam_meta.hlc_ms, sample.ms),\n\t\t\tCASE WHEN sample.ms > roam_meta.hlc_ms THEN 0 ELSE roam_meta.hlc_count + 1 END\n\t\tFROM sample\n\t) WHERE id = 1;\n\tINSERT INTO roam_changes (\n\t\tchange_id, entity, row_key, op, hlc_ms, hlc_count,\n\t\torigin_machine, origin_stream, writer_session, writer_epoch,\n\t\tschema_version, body_json\n\t)\n\tSELECT lower(hex(randomblob(16))), 'session_homes', NEW.session_id, 'put', hlc_ms, hlc_count,\n\t\tmachine_id, stream_id, NULL,\n\t\tNULL, 14,\n\t\tjson_object('session_id', NEW.session_id, 'machine_id', NEW.machine_id, 'epoch', NEW.epoch,\n\t\t\t'move_id', NEW.move_id, 'updated_at', NEW.updated_at)\n\tFROM roam_meta WHERE id = 1;\n\tINSERT INTO roam_versions\n\tSELECT entity, row_key, change_id, hlc_ms, hlc_count,\n\t\torigin_machine, origin_stream, 0\n\tFROM roam_changes WHERE seq = last_insert_rowid()\n\tON CONFLICT(entity, row_key) DO UPDATE SET\n\t\tchange_id = excluded.change_id, hlc_ms = excluded.hlc_ms,\n\t\thlc_count = excluded.hlc_count, origin_machine = excluded.origin_machine,\n\t\torigin_stream = excluded.origin_stream, deleted = excluded.deleted;\nEND;",
  "roam_session_homes_capture_au": "CREATE TRIGGER roam_session_homes_capture_au AFTER UPDATE ON session_homes\nWHEN (SELECT capture_enabled = 1 AND importing = 0 FROM roam_meta WHERE id = 1)\n\tAND json_object('session_id', OLD.session_id, 'machine_id', OLD.machine_id, 'epoch', OLD.epoch,\n\t\t\t'move_id', OLD.move_id, 'updated_at', OLD.updated_at) IS NOT json_object('session_id', NEW.session_id, 'machine_id', NEW.machine_id, 'epoch', NEW.epoch,\n\t\t\t'move_id', NEW.move_id, 'updated_at', NEW.updated_at)\nBEGIN\n\tUPDATE roam_meta SET (hlc_ms, hlc_count) = (\n\t\tWITH sample(ms) AS (\n\t\t\tSELECT CAST(unixepoch('subsec') * 1000 AS INTEGER)\n\t\t)\n\t\tSELECT max(roam_meta.hlc_ms, sample.ms),\n\t\t\tCASE WHEN sample.ms > roam_meta.hlc_ms THEN 0 ELSE roam_meta.hlc_count + 1 END\n\t\tFROM sample\n\t) WHERE id = 1;\n\tINSERT INTO roam_changes (\n\t\tchange_id, entity, row_key, op, hlc_ms, hlc_count,\n\t\torigin_machine, origin_stream, writer_session, writer_epoch,\n\t\tschema_version, body_json\n\t)\n\tSELECT lower(hex(randomblob(16))), 'session_homes', NEW.session_id, 'put', hlc_ms, hlc_count,\n\t\tmachine_id, stream_id, NULL,\n\t\tNULL, 14,\n\t\tjson_object('session_id', NEW.session_id, 'machine_id', NEW.machine_id, 'epoch', NEW.epoch,\n\t\t\t'move_id', NEW.move_id, 'updated_at', NEW.updated_at)\n\tFROM roam_meta WHERE id = 1;\n\tINSERT INTO roam_versions\n\tSELECT entity, row_key, change_id, hlc_ms, hlc_count,\n\t\torigin_machine, origin_stream, 0\n\tFROM roam_changes WHERE seq = last_insert_rowid()\n\tON CONFLICT(entity, row_key) DO UPDATE SET\n\t\tchange_id = excluded.change_id, hlc_ms = excluded.hlc_ms,\n\t\thlc_count = excluded.hlc_count, origin_machine = excluded.origin_machine,\n\t\torigin_stream = excluded.origin_stream, deleted = excluded.deleted;\nEND;"
};

/** Add v0 fields without making legacy homes runnable or changing schema 14. */
export function migrateHomeV0(db: Db): void {
  db.raw.transaction(() => {
    const columns = db.prepare("PRAGMA table_info(session_homes)").all() as { name: string }[];
    const state = columns.some(column => column.name === "state");
    const destination = columns.some(column => column.name === "destination");
    if (state && destination) return;
    if (state !== destination || columns.length !== 5 ||
        !["session_id", "machine_id", "epoch", "move_id", "updated_at"].every(name => columns.some(column => column.name === name))) {
      throw new Error("Unknown roaming home layout");
    }
    db.exec("ALTER TABLE session_homes ADD COLUMN state TEXT");
    db.exec("ALTER TABLE session_homes ADD COLUMN destination TEXT");
    for (const trigger of GENERATED_TRIGGERS.global) {
      const legacy = LEGACY_CAPTURE[trigger.name];
      if (legacy === undefined) continue;
      const found = db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?").get(trigger.name) as {sql: string} | undefined;
      if (found?.sql !== legacy.trim().replace(/;$/, "")) continue;
      db.exec(`DROP TRIGGER ${trigger.name}`);
      db.exec(trigger.sql);
    }
  })();
}

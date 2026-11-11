import { DESCRIPTORS } from "./descriptors";
import type { Descriptor, Entity, Scope } from "./types";

const MAX_SAFE_INTEGER = 9007199254740991;
const UUID_FILL_TABLES = new Set(["todos", "run_events"]);

function projection(descriptor: Descriptor, row: "NEW" | "OLD"): string {
  const pairs = descriptor.columns.map(column => `'${column}', ${row}.${column}`);
  const lines: string[] = [];
  for (let i = 0; i < pairs.length; i += 3) lines.push(pairs.slice(i, i + 3).join(", "));
  return `json_object(${lines.join(",\n\t\t\t")})`;
}

function clockGuards(): string[] {
  const invalid = `(typeof(NEW.hlc_ms) != 'integer' OR NEW.hlc_ms < 0 OR NEW.hlc_ms > ${MAX_SAFE_INTEGER}
	OR typeof(NEW.hlc_count) != 'integer' OR NEW.hlc_count < 0 OR NEW.hlc_count > ${MAX_SAFE_INTEGER})`;
  return [
    `CREATE TRIGGER roam_meta_clock_bi BEFORE INSERT ON roam_meta
WHEN ${invalid}
BEGIN
	SELECT RAISE(ABORT, 'roaming clock out of range');
END;`,
    `CREATE TRIGGER roam_meta_clock_bu BEFORE UPDATE OF hlc_ms, hlc_count ON roam_meta
WHEN ${invalid}
BEGIN
	SELECT RAISE(ABORT, 'roaming clock out of range');
END;`,
  ];
}

function uuidFill(table: string): string {
  return `CREATE TRIGGER roam_${table}_uuid_fill AFTER INSERT ON ${table}
WHEN NEW.uuid IS NULL OR NEW.uuid = ''
BEGIN
	UPDATE ${table} SET uuid = lower(hex(randomblob(16))) WHERE id = NEW.id;
END;`;
}

function uuidFixed(table: string): string {
  return `CREATE TRIGGER roam_${table}_uuid_fixed BEFORE UPDATE ON ${table}
WHEN OLD.uuid IS NOT NULL AND OLD.uuid != '' AND NEW.uuid IS NOT OLD.uuid
BEGIN
	SELECT RAISE(ABORT, 'roaming UUID cannot change');
END;`;
}

function originFill(descriptor: Descriptor): string {
  return `CREATE TRIGGER roam_${descriptor.table}_origin_fill AFTER INSERT ON ${descriptor.table}
WHEN NEW.origin_machine IS NULL OR NEW.origin_machine = ''
BEGIN
	UPDATE ${descriptor.table} SET origin_machine = (SELECT machine_id FROM roam_meta WHERE id = 1) WHERE ${descriptor.key} = NEW.${descriptor.key};
END;`;
}

function frozenInsert(descriptor: Descriptor): string {
  return `CREATE TRIGGER roam_${descriptor.table}_frozen_bi BEFORE INSERT ON ${descriptor.table}
WHEN (SELECT importing FROM roam_meta WHERE id = 1) = 0
BEGIN
	SELECT RAISE(ABORT, 'session is frozen')
	WHERE (SELECT state FROM roam_sessions WHERE session_id = NEW.${descriptor.sessionColumn})
		IN ('frozen', 'retired');
END;`;
}

function identityChecks(descriptor: Descriptor): string[] {
  return descriptor.immutable.filter(column => column !== "uuid").map(column => {
    const test = column === "origin_machine"
      ? `OLD.${column} IS NOT NULL AND OLD.${column} != '' AND NEW.${column} IS NOT OLD.${column}`
      : `NEW.${column} IS NOT OLD.${column}`;
    const kind = column === "origin_machine" ? "origin" : "identity";
    return `\tSELECT RAISE(ABORT, 'roaming ${kind} cannot change') WHERE ${test};`;
  });
}

function beforeUpdate(descriptor: Descriptor): string | null {
  const identity = identityChecks(descriptor);
  if (descriptor.sessionColumn === null && identity.length === 0) return null;
  const freeze = descriptor.sessionColumn === null ? [] : [
    `\tSELECT RAISE(ABORT, 'session is frozen')
\tWHERE (SELECT importing FROM roam_meta WHERE id = 1) = 0
\t\tAND ((SELECT state FROM roam_sessions WHERE session_id = OLD.${descriptor.sessionColumn}) IN ('frozen', 'retired')
\t\t\tOR (SELECT state FROM roam_sessions WHERE session_id = NEW.${descriptor.sessionColumn}) IN ('frozen', 'retired'));`,
  ];
  const suffix = descriptor.sessionColumn === null ? "identity_bu" : "frozen_bu";
  return `CREATE TRIGGER roam_${descriptor.table}_${suffix} BEFORE UPDATE ON ${descriptor.table}
BEGIN
${[...freeze, ...identity].join("\n")}
END;`;
}

function frozenDelete(descriptor: Descriptor): string {
  return `CREATE TRIGGER roam_${descriptor.table}_frozen_bd BEFORE DELETE ON ${descriptor.table}
WHEN (SELECT importing FROM roam_meta WHERE id = 1) = 0
BEGIN
	SELECT RAISE(ABORT, 'session is frozen')
	WHERE (SELECT state FROM roam_sessions WHERE session_id = OLD.${descriptor.sessionColumn})
		IN ('frozen', 'retired');
END;`;
}

function ready(descriptor: Descriptor, row: "NEW" | "OLD"): string[] {
  const checks: string[] = [];
  if (UUID_FILL_TABLES.has(descriptor.table)) checks.push(`${row}.uuid IS NOT NULL AND ${row}.uuid != ''`);
  if (row === "NEW" && descriptor.immutable.includes("origin_machine")) {
    checks.push("NEW.origin_machine IS NOT NULL AND NEW.origin_machine != ''");
  }
  return checks;
}

function captureBody(entity: Entity, descriptor: Descriptor, row: "NEW" | "OLD", op: "put" | "delete"): string {
  const session = descriptor.sessionColumn === null ? "NULL" : `${row}.${descriptor.sessionColumn}`;
  const epoch = descriptor.sessionColumn === null ? "NULL"
    : `(SELECT epoch FROM roam_sessions WHERE session_id = ${session})`;
  const body = op === "delete" ? "NULL" : projection(descriptor, row);
  return `\tUPDATE roam_meta SET (hlc_ms, hlc_count) = (
\t\tWITH sample(ms) AS (
\t\t\tSELECT CAST(unixepoch('subsec') * 1000 AS INTEGER)
\t\t)
\t\tSELECT max(roam_meta.hlc_ms, sample.ms),
\t\t\tCASE WHEN sample.ms > roam_meta.hlc_ms THEN 0 ELSE roam_meta.hlc_count + 1 END
\t\tFROM sample
\t) WHERE id = 1;
\tINSERT INTO roam_changes (
\t\tchange_id, entity, row_key, op, hlc_ms, hlc_count,
\t\torigin_machine, origin_stream, writer_session, writer_epoch,
\t\tschema_version, body_json
\t)
\tSELECT lower(hex(randomblob(16))), '${entity}', ${row}.${descriptor.key}, '${op}', hlc_ms, hlc_count,
\t\tmachine_id, stream_id, ${session},
\t\t${epoch}, 14,
\t\t${body}
\tFROM roam_meta WHERE id = 1;
\tINSERT INTO roam_versions
\tSELECT entity, row_key, change_id, hlc_ms, hlc_count,
\t\torigin_machine, origin_stream, ${op === "delete" ? 1 : 0}
\tFROM roam_changes WHERE seq = last_insert_rowid()
\tON CONFLICT(entity, row_key) DO UPDATE SET
\t\tchange_id = excluded.change_id, hlc_ms = excluded.hlc_ms,
\t\thlc_count = excluded.hlc_count, origin_machine = excluded.origin_machine,
\t\torigin_stream = excluded.origin_stream, deleted = excluded.deleted;`;
}

function capture(entity: Entity, descriptor: Descriptor, event: "INSERT" | "UPDATE" | "DELETE"): string {
  const row = event === "DELETE" ? "OLD" : "NEW";
  const op = event === "DELETE" ? "delete" : "put";
  const conditions = [
    ...ready(descriptor, row),
    "(SELECT capture_enabled = 1 AND importing = 0 FROM roam_meta WHERE id = 1)",
  ];
  if (descriptor.sessionColumn !== null) {
    conditions.push(`EXISTS (SELECT 1 FROM roam_sessions WHERE session_id = ${row}.${descriptor.sessionColumn})`);
  }
  if (event === "UPDATE") conditions.push(`${projection(descriptor, "OLD")} IS NOT ${projection(descriptor, "NEW")}`);
  const suffix = event === "INSERT" ? "ai" : event === "UPDATE" ? "au" : "ad";
  return `CREATE TRIGGER roam_${descriptor.table}_capture_${suffix} AFTER ${event} ON ${descriptor.table}
WHEN ${conditions.join("\n\tAND ")}
BEGIN
${captureBody(entity, descriptor, row, op)}
END;`;
}

function entityTriggers(entity: Entity, descriptor: Descriptor): string[] {
  const triggers: string[] = [];
  if (UUID_FILL_TABLES.has(descriptor.table)) triggers.push(uuidFill(descriptor.table));
  if (descriptor.immutable.includes("uuid")) triggers.push(uuidFixed(descriptor.table));
  if (descriptor.immutable.includes("origin_machine")) triggers.push(originFill(descriptor));
  if (descriptor.sessionColumn !== null) triggers.push(frozenInsert(descriptor));
  triggers.push(capture(entity, descriptor, "INSERT"));
  const update = beforeUpdate(descriptor);
  if (update !== null) triggers.push(update);
  if (descriptor.sessionColumn !== null) triggers.push(frozenDelete(descriptor));
  triggers.push(capture(entity, descriptor, "UPDATE"), capture(entity, descriptor, "DELETE"));
  return triggers;
}

/** Generate the schema 14 SQL for a canonical store. */
export function captureSql(scope: Scope): string {
  const triggers = clockGuards();
  for (const [entity, descriptor] of Object.entries(DESCRIPTORS) as Array<[Entity, Descriptor]>) {
    if (descriptor.scope === scope) triggers.push(...entityTriggers(entity, descriptor));
  }
  return triggers.join("\n");
}

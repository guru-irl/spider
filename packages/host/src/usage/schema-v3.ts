// Immutable v3 inputs. Future dimensions must use a new migration, never edit this literal.
export const USAGE_V3_DIMENSION_COLUMNS: Readonly<Record<"project" | "repo" | "session" | "actor" | "role" | "agent" | "provider" | "model" | "requestedModel" | "thinking" | "run" | "runName" | "phase" | "parentRun" | "auxPurpose" | "api" | "day", string>> = Object.freeze({
  project: "project", repo: "repo", session: "session_id", actor: "actor", role: "role", agent: "agent",
  provider: "provider", model: "model", requestedModel: "requested_model", thinking: "thinking",
  run: "run_id", runName: "run_name", phase: "phase", parentRun: "parent_run_id",
  auxPurpose: "aux_purpose", api: "api", day: "ts",
} as const);

// v1/v2 selection ignores the legacy counted flag. Persist exactly the same
// global provenance order, before coverage and any period/session filters.
const shadowed = (row: string) => `EXISTS (SELECT 1 FROM calls prior WHERE prior.fingerprint = ${row}.fingerprint
  AND (prior.copied,prior.source_file,prior.entry_id,prior.id) < (${row}.copied,${row}.source_file,${row}.entry_id,${row}.id))`;
const undercount = (row: string) => `(EXISTS (SELECT 1 FROM import_state s WHERE s.path=${row}.source_file AND s.offset<s.size)
  OR EXISTS (SELECT 1 FROM incomplete_reports i WHERE i.path=${row}.source_file AND i.run_id=${row}.run_id)
  OR (${row}.is_report=0 AND EXISTS (SELECT 1 FROM runs_meta r WHERE r.id=${row}.run_id AND r.ended_at IS NULL)))`;

const refreshShadow = (scope: string) => `UPDATE calls SET selection_shadowed=${shadowed("calls")}
  WHERE (${scope}) AND selection_shadowed IS NOT ${shadowed("calls")};`;
const refreshUndercount = (scope: string) => `UPDATE calls SET selection_undercount=${undercount("calls")}
  WHERE (${scope}) AND selection_undercount IS NOT ${undercount("calls")};`;
// UNIQUE(source_file,entry_id) makes id irrelevant as an ordering tie-breaker.
const shadowColumns = ["fingerprint", "copied", "source_file", "entry_id"];
const uncertaintyColumns = ["source_file", "run_id", "actor", "aggregate"];
const changed = (columns: readonly string[]) => columns.map(c => `OLD.${c} IS NOT NEW.${c}`).join(" OR ");
const uncertaintyTriggers = [
  { table: "import_state", columns: ["path", "offset", "size"], scope: (r: string) => `source_file=${r}.path`,
    when: "OLD.path IS NOT NEW.path OR (OLD.offset<OLD.size) IS NOT (NEW.offset<NEW.size)" },
  { table: "incomplete_reports", columns: ["path", "run_id"], scope: (r: string) => `source_file=${r}.path AND run_id=${r}.run_id` },
  { table: "runs_meta", columns: ["id", "ended_at"], scope: (r: string) => `run_id=${r}.id`,
    when: "OLD.id IS NOT NEW.id OR (OLD.ended_at IS NULL) IS NOT (NEW.ended_at IS NULL)" },
].flatMap(({ table, columns, scope, when }) => ["INSERT", "DELETE", "UPDATE"].map(operation => `
CREATE TRIGGER selection_inputs_${table}_${operation.toLowerCase()}
AFTER ${operation}${operation === "UPDATE" ? ` OF ${columns.join(",")}` : ""} ON ${table}
${operation === "UPDATE" ? `WHEN ${when ?? changed(columns)}` : ""}
BEGIN
  ${refreshUndercount(operation === "UPDATE" ? `(${scope("OLD")}) OR (${scope("NEW")})` : scope(operation === "INSERT" ? "NEW" : "OLD"))}
END;`)).join("\n");

const valueExpression = (dimension: string, column: string, row: string) => dimension === "day"
  ? `strftime('%Y-%m-%d',${row}.ts/1000,'unixepoch')` : `${row}.${column}`;
const registryUpsert = `ON CONFLICT(dimension,has_value,value) DO UPDATE SET
  first_seen=MIN(dimension_values.first_seen,excluded.first_seen),last_seen=MAX(dimension_values.last_seen,excluded.last_seen)
  WHERE excluded.first_seen<dimension_values.first_seen OR excluded.last_seen>dimension_values.last_seen;`;
const registryInsert = Object.entries(USAGE_V3_DIMENSION_COLUMNS).map(([dimension, column]) => {
  const value = valueExpression(dimension, column, "NEW");
  return `INSERT INTO dimension_values(dimension,has_value,value,first_seen,last_seen)
    SELECT '${dimension}',${value} IS NOT NULL,COALESCE(${value},''),NEW.ts,NEW.ts WHERE ${value} IS NOT NULL ${registryUpsert}`;
}).join("\n");
const registryBackfill = Object.entries(USAGE_V3_DIMENSION_COLUMNS).map(([dimension, column]) => {
  const value = valueExpression(dimension, column, "c");
  return `INSERT INTO dimension_values(dimension,has_value,value,first_seen,last_seen)
    SELECT '${dimension}',${value} IS NOT NULL,COALESCE(${value},''),MIN(c.ts),MAX(c.ts) FROM calls c WHERE ${value} IS NOT NULL
    GROUP BY ${value} ${registryUpsert}`;
}).join("\n");
const registryColumns = [...new Set(Object.values(USAGE_V3_DIMENSION_COLUMNS))];

export const USAGE_SCHEMA_V3: string = `
ALTER TABLE calls ADD COLUMN selection_shadowed INTEGER NOT NULL DEFAULT 0 CHECK (selection_shadowed IN (0,1));
ALTER TABLE calls ADD COLUMN selection_undercount INTEGER NOT NULL DEFAULT 0 CHECK (selection_undercount IN (0,1));
UPDATE calls SET selection_shadowed=${shadowed("calls")},selection_undercount=${undercount("calls")}
  WHERE (${shadowed("calls")}) OR (${undercount("calls")});
CREATE TABLE dimension_values (
  dimension TEXT NOT NULL,has_value INTEGER NOT NULL CHECK (has_value IN (0,1)),value TEXT NOT NULL,
  first_seen INTEGER NOT NULL,last_seen INTEGER NOT NULL CHECK (last_seen>=first_seen),
  PRIMARY KEY(dimension,has_value,value), CHECK (has_value=1 OR value='')
) WITHOUT ROWID;
${registryBackfill}
CREATE TRIGGER dimension_values_insert AFTER INSERT ON calls BEGIN
  ${registryInsert}
END;
CREATE TRIGGER dimension_values_update AFTER UPDATE OF ${registryColumns.join(",")} ON calls
WHEN ${changed(registryColumns)} BEGIN
  ${registryInsert}
END;
CREATE TRIGGER selection_shadow_insert AFTER INSERT ON calls BEGIN
  ${refreshShadow("fingerprint=NEW.fingerprint")}
  ${refreshUndercount("id=NEW.id")}
END;
CREATE TRIGGER selection_shadow_delete AFTER DELETE ON calls BEGIN
  ${refreshShadow("fingerprint=OLD.fingerprint")}
END;
CREATE TRIGGER selection_shadow_update AFTER UPDATE OF ${shadowColumns.join(",")} ON calls
WHEN ${changed(shadowColumns)} BEGIN
  ${refreshShadow("fingerprint=OLD.fingerprint OR fingerprint=NEW.fingerprint")}
END;
CREATE TRIGGER selection_call_inputs_update AFTER UPDATE OF ${uncertaintyColumns.join(",")} ON calls
WHEN ${changed(uncertaintyColumns)} BEGIN
  ${refreshUndercount("id=NEW.id")}
END;
${uncertaintyTriggers}
CREATE TRIGGER selection_revision_stored_update AFTER UPDATE OF selection_shadowed,selection_undercount ON calls
WHEN OLD.selection_shadowed IS NOT NEW.selection_shadowed OR OLD.selection_undercount IS NOT NEW.selection_undercount BEGIN
  INSERT INTO ledger_metadata(key,value) VALUES ('call-selection-revision','1')
    ON CONFLICT(key) DO UPDATE SET value=CAST(ledger_metadata.value AS INTEGER)+1;
END;
`;

// Immutable v4 DDL. Deployed ledgers cannot downgrade; back up before upgrading.
// Keep storage statuses aligned with subagents/run-store, not dashboard labels.
export const USAGE_SCHEMA_V4: string = `
ALTER TABLE runs_meta ADD COLUMN status TEXT
  CHECK (status IN ('queued','running','paused','done','failed','cancelled'));

CREATE TABLE sessions (
  id TEXT PRIMARY KEY NOT NULL,
  owner_session_id TEXT,
  name TEXT NOT NULL,
  name_source TEXT NOT NULL CHECK (name_source IN ('name','first-user','id')),
  project TEXT,
  first_activity INTEGER,
  last_activity INTEGER,
  name_order INTEGER NOT NULL CHECK (name_order >= 0)
);
CREATE INDEX sessions_owner ON sessions(owner_session_id,id);

-- Metadata progress is independent of the billing import cursor.
CREATE TABLE session_metadata_import (
  path TEXT PRIMARY KEY NOT NULL,
  generation INTEGER NOT NULL CHECK (generation >= 0),
  offset INTEGER NOT NULL CHECK (offset >= 0 AND offset <= size),
  size INTEGER NOT NULL CHECK (size >= 0),
  complete INTEGER NOT NULL CHECK (complete IN (0,1))
);

-- v2 already covers run inserts, deletes and the original attribution columns.
CREATE TRIGGER selection_revision_runs_status_update AFTER UPDATE OF status ON runs_meta
WHEN OLD.status IS NOT NEW.status BEGIN
  INSERT INTO ledger_metadata(key,value) VALUES ('call-selection-revision','1')
    ON CONFLICT(key) DO UPDATE SET value=CAST(ledger_metadata.value AS INTEGER)+1;
END;
CREATE TRIGGER selection_revision_sessions_insert AFTER INSERT ON sessions BEGIN
  INSERT INTO ledger_metadata(key,value) VALUES ('call-selection-revision','1')
    ON CONFLICT(key) DO UPDATE SET value=CAST(ledger_metadata.value AS INTEGER)+1;
END;
CREATE TRIGGER selection_revision_sessions_delete AFTER DELETE ON sessions BEGIN
  INSERT INTO ledger_metadata(key,value) VALUES ('call-selection-revision','1')
    ON CONFLICT(key) DO UPDATE SET value=CAST(ledger_metadata.value AS INTEGER)+1;
END;
CREATE TRIGGER selection_revision_sessions_update
AFTER UPDATE OF id,owner_session_id,name,name_source,project,first_activity,last_activity,name_order ON sessions
WHEN OLD.id IS NOT NEW.id OR OLD.owner_session_id IS NOT NEW.owner_session_id
  OR OLD.name IS NOT NEW.name OR OLD.name_source IS NOT NEW.name_source OR OLD.project IS NOT NEW.project
  OR OLD.first_activity IS NOT NEW.first_activity OR OLD.last_activity IS NOT NEW.last_activity
  OR OLD.name_order IS NOT NEW.name_order BEGIN
  INSERT INTO ledger_metadata(key,value) VALUES ('call-selection-revision','1')
    ON CONFLICT(key) DO UPDATE SET value=CAST(ledger_metadata.value AS INTEGER)+1;
END;
`;

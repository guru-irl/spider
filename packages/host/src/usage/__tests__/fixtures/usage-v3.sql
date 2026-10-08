-- Frozen pre-redesign v3 ledger. All facts are synthetic.
-- Frozen shipped v1 DDL, including its separate Phase 1 lease table.

CREATE TABLE calls (
  id TEXT PRIMARY KEY NOT NULL,
  ts INTEGER NOT NULL,
  source_file TEXT NOT NULL,
  entry_id TEXT NOT NULL,
  source_generation INTEGER NOT NULL CHECK (source_generation >= 0),
  project TEXT, repo TEXT, session_id TEXT, run_id TEXT,
  actor TEXT NOT NULL CHECK (actor IN ('parent', 'subagent', 'aux', 'compaction', 'warmer')),
  role TEXT, agent TEXT, run_name TEXT, phase TEXT, parent_run_id TEXT, aux_purpose TEXT,
  provider TEXT, model TEXT, raw_provider TEXT, raw_model TEXT, requested_model TEXT, thinking TEXT, api TEXT,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('transcript', 'run-db-aux', 'report')),
  input INTEGER NOT NULL CHECK (input >= 0),
  output INTEGER NOT NULL CHECK (output >= 0),
  cache_read INTEGER NOT NULL CHECK (cache_read >= 0),
  cache_write INTEGER NOT NULL CHECK (cache_write >= 0),
  cache_write_1h INTEGER, reasoning INTEGER, total_tokens INTEGER,
  aic REAL, aic_input REAL, aic_cache_read REAL, aic_cache_write REAL, aic_output REAL,
  price_status TEXT NOT NULL CHECK (price_status IN ('priced', 'unpriced')),
  unpriced_reason TEXT, rate_version TEXT, tier TEXT,
  confidence TEXT CHECK (confidence IN ('estimated', 'verified')),
  pi_cost REAL, latency_ms REAL,
  aggregate INTEGER NOT NULL CHECK (aggregate IN (0, 1)),
  counted INTEGER NOT NULL CHECK (counted IN (0, 1)),
  origin_key TEXT,
  response_id TEXT,
  copied INTEGER NOT NULL DEFAULT 0 CHECK (copied IN (0, 1)),
  fingerprint TEXT NOT NULL,
  is_report INTEGER GENERATED ALWAYS AS (actor = 'subagent' AND aggregate = 1 AND run_id IS NOT NULL) VIRTUAL,
  UNIQUE (source_file, entry_id),
  CHECK ((source_kind = 'report') = is_report),
  CHECK ((price_status = 'priced' AND aic IS NOT NULL AND unpriced_reason IS NULL
    AND aic_input IS NOT NULL AND aic_cache_read IS NOT NULL AND aic_cache_write IS NOT NULL
    AND aic_output IS NOT NULL AND rate_version IS NOT NULL AND tier IS NOT NULL AND confidence IS NOT NULL)
    OR (price_status = 'unpriced' AND aic IS NULL AND unpriced_reason IS NOT NULL
    AND aic_input IS NULL AND aic_cache_read IS NULL AND aic_cache_write IS NULL AND aic_output IS NULL
    AND rate_version IS NULL AND tier IS NULL AND confidence IS NULL))
);
CREATE INDEX calls_ts_actor ON calls (ts, actor);
CREATE INDEX calls_session_ts ON calls (session_id, ts);
CREATE INDEX calls_run_detail ON calls (run_id, is_report, copied, source_kind);
CREATE INDEX calls_reports ON calls (run_id, provider, model) WHERE is_report = 1;
CREATE INDEX calls_health_reports ON calls (fingerprint, copied, source_file, entry_id, id, run_id) WHERE is_report = 1;
CREATE INDEX calls_health_unpriced ON calls (model, fingerprint, copied, source_file, entry_id, id, run_id, is_report) WHERE price_status = 'unpriced';
CREATE INDEX calls_native_reports_source ON calls (source_file, run_id) WHERE is_report = 1 AND copied = 0;
CREATE INDEX calls_owners_source ON calls (source_file, run_id) WHERE is_report = 0 AND copied = 0 AND source_kind = 'transcript' AND run_id IS NOT NULL;
CREATE INDEX calls_period_read ON calls (ts, aic, price_status, confidence, aggregate, run_id,
  source_file, source_kind, is_report, fingerprint, copied, entry_id, id);
CREATE INDEX calls_session_read ON calls (session_id, ts, aic, run_id,
  source_file, source_kind, is_report, fingerprint, copied, entry_id, id);
CREATE INDEX calls_run_parent ON calls (run_id, parent_run_id) WHERE copied = 0 AND parent_run_id IS NOT NULL;
CREATE INDEX calls_parent_run ON calls (parent_run_id, run_id) WHERE copied = 0 AND parent_run_id IS NOT NULL;
CREATE INDEX calls_source_run ON calls (source_file, is_report, copied, source_kind, run_id);
CREATE INDEX calls_native_sources ON calls (run_id, source_file) WHERE is_report = 0 AND copied = 0 AND source_kind = 'transcript';
CREATE INDEX calls_fingerprint ON calls (fingerprint, copied, source_file, entry_id, id);
CREATE INDEX calls_provider_model_ts ON calls (provider, model, ts);

-- Raw call count is maintained in the same write transaction, including resets.
CREATE TABLE ledger_totals (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), calls INTEGER NOT NULL);
INSERT INTO ledger_totals VALUES (1, 0);
-- Ancestry is only an overlap hint, never coverage. Reference counts retain an
-- edge across source resets until its last native call is removed.
CREATE TABLE call_ancestry_edges (
  parent TEXT NOT NULL, child TEXT NOT NULL, refs INTEGER NOT NULL CHECK (refs > 0),
  PRIMARY KEY (parent, child)
);
CREATE INDEX call_ancestry_child ON call_ancestry_edges (child, parent);
CREATE TRIGGER calls_insert_total AFTER INSERT ON calls BEGIN
  UPDATE ledger_totals SET calls = calls + 1 WHERE singleton = 1;
  INSERT INTO call_ancestry_edges(parent, child, refs)
    SELECT NEW.parent_run_id, NEW.run_id, 1
    WHERE NEW.copied = 0 AND NEW.parent_run_id IS NOT NULL AND NEW.run_id IS NOT NULL
    ON CONFLICT(parent, child) DO UPDATE SET refs = refs + 1;
END;
CREATE TRIGGER calls_delete_total AFTER DELETE ON calls BEGIN
  UPDATE ledger_totals SET calls = calls - 1 WHERE singleton = 1;
  DELETE FROM call_ancestry_edges WHERE OLD.copied = 0
    AND parent = OLD.parent_run_id AND child = OLD.run_id AND refs = 1;
  UPDATE call_ancestry_edges SET refs = refs - 1 WHERE OLD.copied = 0
    AND parent = OLD.parent_run_id AND child = OLD.run_id;
END;
CREATE TABLE ledger_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT INTO ledger_metadata VALUES ('schema-layout', 'v1-ingest-append-1');

-- Incremental parser state and report fences share the source-cursor transaction.
CREATE TABLE source_context (
  path TEXT PRIMARY KEY NOT NULL, header TEXT NOT NULL, tail_hash TEXT NOT NULL
);
CREATE TABLE source_entries (
  path TEXT NOT NULL, generation INTEGER NOT NULL, byte_offset INTEGER NOT NULL,
  entry_id TEXT NOT NULL, parent_id TEXT, state_id TEXT, state_parent_id TEXT, linear_id TEXT, json TEXT NOT NULL,
  PRIMARY KEY(path,generation,byte_offset)
);
CREATE INDEX source_entries_identity ON source_entries(path,generation,entry_id,byte_offset);
CREATE TABLE pending_reports (
  path TEXT NOT NULL, run_id TEXT NOT NULL, generation INTEGER NOT NULL,
  first_seen INTEGER NOT NULL, calls TEXT NOT NULL, PRIMARY KEY(path,run_id)
);
CREATE TABLE incomplete_reports (
  path TEXT NOT NULL, run_id TEXT NOT NULL, PRIMARY KEY(path,run_id)
);

CREATE TABLE counter_snapshots (
  ts INTEGER NOT NULL, account_login TEXT, credits_used REAL NOT NULL,
  entitlement REAL, remaining REAL, reset_date TEXT, raw TEXT NOT NULL
);
CREATE INDEX counter_snapshots_ts ON counter_snapshots (ts);

CREATE TABLE import_state (
  path TEXT PRIMARY KEY NOT NULL,
  inode TEXT, size INTEGER, mtime_ms REAL, offset INTEGER,
  parse_errors INTEGER NOT NULL DEFAULT 0 CHECK (parse_errors >= 0),
  generation INTEGER NOT NULL DEFAULT 0 CHECK (generation >= 0),
  prefix_hash TEXT,
  source_error_code TEXT,
  source_error_paths TEXT,
  last_ingest_at INTEGER NOT NULL,
  CHECK (offset IS NULL OR (offset >= 0 AND offset <= size))
);

CREATE INDEX import_state_incomplete ON import_state (path) WHERE offset < size;

CREATE TABLE runs_meta (
  id TEXT NOT NULL, db_path TEXT NOT NULL,
  project TEXT, repo TEXT, session_id TEXT, parent_run_id TEXT,
  agent TEXT, role TEXT, name TEXT, model TEXT, thinking TEXT, phase TEXT,
  started_at INTEGER, ended_at INTEGER,
  PRIMARY KEY (db_path, id)
);
CREATE INDEX runs_meta_nonterminal ON runs_meta (id) WHERE ended_at IS NULL;
CREATE INDEX runs_meta_parent ON runs_meta (parent_run_id, id);
CREATE INDEX runs_meta_id ON runs_meta (id, parent_run_id);

CREATE TABLE coverage_edges (
  report_run_id TEXT NOT NULL,
  included_run_id TEXT NOT NULL,
  evidence TEXT NOT NULL CHECK (evidence IN ('transcript', 'runs-db', 'unknown')),
  PRIMARY KEY (report_run_id, included_run_id)
);
CREATE INDEX coverage_edges_included ON coverage_edges (included_run_id, report_run_id, evidence);

-- Ingest supplies proof that R's report actually includes N. Execution ancestry
-- and fork source ownership are NEVER used to suppress rows. Unknown is a hint.
CREATE VIEW usage_run_edges AS
SELECT report_run_id AS parent, included_run_id AS child FROM coverage_edges
WHERE evidence IN ('transcript', 'runs-db');

-- Selection is global, before time/session filtering. Canonical provenance is
-- chosen before coverage, so an excluded native call cannot escape via a copy.
-- Legacy counted/restore signals never participate in this declarative rule.
CREATE VIEW selected_usage_calls AS
WITH RECURSIVE 
report_runs(id) AS MATERIALIZED (
  SELECT DISTINCT r.run_id FROM calls r INDEXED BY calls_reports WHERE r.is_report = 1
    AND NOT EXISTS (SELECT 1 FROM calls d
      WHERE d.run_id = r.run_id AND d.is_report = 0 AND d.copied = 0 AND d.source_kind = 'transcript')
),
edges AS MATERIALIZED (SELECT parent, child FROM usage_run_edges),
coverage(root, id) AS (
  SELECT id, id FROM report_runs
  UNION SELECT r.root, e.child FROM coverage r JOIN edges e ON e.parent = r.id
),
selected_reports(id) AS MATERIALIZED (
  SELECT r.id FROM report_runs r WHERE NOT EXISTS (
    SELECT 1 FROM coverage ancestor WHERE ancestor.id = r.id AND ancestor.root != r.id
      AND (ancestor.root < r.id OR NOT EXISTS (
        SELECT 1 FROM coverage back WHERE back.root = r.id AND back.id = ancestor.root))
  )
),
covered(id) AS MATERIALIZED (
  SELECT DISTINCT c.id FROM coverage c JOIN selected_reports s ON s.id = c.root
)

SELECT c.* FROM calls c WHERE NOT EXISTS (SELECT 1 FROM calls prior WHERE prior.fingerprint = c.fingerprint
    AND (prior.copied, prior.source_file, prior.entry_id, prior.id) < (c.copied, c.source_file, c.entry_id, c.id))
  AND ((c.is_report = 1 AND c.run_id IN (SELECT id FROM selected_reports))
    OR (c.is_report = 0 AND (c.run_id IS NULL OR c.run_id NOT IN (SELECT id FROM covered))));

-- Diagnostic all-time pairs. Dashboard period/session reads use countedUsageSql
-- with a bounded predicate, not this intentionally unbounded diagnostic view.
CREATE VIEW usage_possible_overlaps AS
WITH RECURSIVE 
report_runs(id) AS MATERIALIZED (
  SELECT DISTINCT r.run_id FROM calls r INDEXED BY calls_reports WHERE r.is_report = 1
    AND NOT EXISTS (SELECT 1 FROM calls d
      WHERE d.run_id = r.run_id AND d.is_report = 0 AND d.copied = 0 AND d.source_kind = 'transcript')
),
edges AS MATERIALIZED (SELECT parent, child FROM usage_run_edges),
coverage(root, id) AS (
  SELECT id, id FROM report_runs
  UNION SELECT r.root, e.child FROM coverage r JOIN edges e ON e.parent = r.id
),
selected_reports(id) AS MATERIALIZED (
  SELECT r.id FROM report_runs r WHERE NOT EXISTS (
    SELECT 1 FROM coverage ancestor WHERE ancestor.id = r.id AND ancestor.root != r.id
      AND (ancestor.root < r.id OR NOT EXISTS (
        SELECT 1 FROM coverage back WHERE back.root = r.id AND back.id = ancestor.root))
  )
),
covered(id) AS MATERIALIZED (
  SELECT DISTINCT c.id FROM coverage c JOIN selected_reports s ON s.id = c.root
)
, ancestors(id) AS (
  SELECT id FROM selected_reports
  
),
hinted(root, id) AS (
  SELECT a.id, a.id FROM ancestors a JOIN selected_reports c ON c.id = a.id
  UNION SELECT h.root, e.included_run_id FROM hinted h JOIN coverage_edges e ON e.report_run_id = h.id
  UNION SELECT h.root, r.id FROM hinted h JOIN runs_meta r ON r.parent_run_id = h.id
  UNION SELECT h.root, e.child FROM hinted h JOIN call_ancestry_edges e ON e.parent = h.id
  UNION SELECT h.root, r.run_id FROM hinted h JOIN calls r INDEXED BY calls_native_reports_source
    ON r.source_file IN (SELECT DISTINCT o.source_file FROM calls o INDEXED BY calls_native_sources
      WHERE o.run_id = h.id AND o.is_report = 0 AND o.copied = 0 AND o.source_kind = 'transcript')
    WHERE r.is_report = 1 AND r.copied = 0 AND r.run_id != h.id
      AND h.id = (SELECT MIN(o.run_id) FROM calls o INDEXED BY calls_owners_source
        WHERE o.source_file = r.source_file AND o.is_report = 0 AND o.copied = 0
          AND o.source_kind = 'transcript' AND o.run_id IS NOT NULL
        HAVING COUNT(DISTINCT o.run_id) = 1)
)
SELECT DISTINCT h.root AS report_run_id, h.id AS included_run_id,
  COALESCE(e.evidence, 'none') AS evidence
FROM hinted h LEFT JOIN coverage_edges e ON e.report_run_id = h.root AND e.included_run_id = h.id
WHERE h.root != h.id AND (h.id IN (SELECT id FROM selected_reports) OR (h.id NOT IN (SELECT id FROM covered)
    AND EXISTS (SELECT 1 FROM calls active WHERE active.run_id = h.id AND active.is_report = 0
      AND NOT EXISTS (SELECT 1 FROM calls prior WHERE prior.fingerprint = active.fingerprint
        AND (prior.copied, prior.source_file, prior.entry_id, prior.id) < (active.copied, active.source_file, active.entry_id, active.id)))));

CREATE VIEW counted_calls AS WITH RECURSIVE

report_runs(id) AS MATERIALIZED (
  SELECT DISTINCT r.run_id FROM calls r INDEXED BY calls_reports WHERE r.is_report = 1
    AND NOT EXISTS (SELECT 1 FROM calls d
      WHERE d.run_id = r.run_id AND d.is_report = 0 AND d.copied = 0 AND d.source_kind = 'transcript')
),
edges AS MATERIALIZED (SELECT parent, child FROM usage_run_edges),
coverage(root, id) AS (
  SELECT id, id FROM report_runs
  UNION SELECT r.root, e.child FROM coverage r JOIN edges e ON e.parent = r.id
),
selected_reports(id) AS MATERIALIZED (
  SELECT r.id FROM report_runs r WHERE NOT EXISTS (
    SELECT 1 FROM coverage ancestor WHERE ancestor.id = r.id AND ancestor.root != r.id
      AND (ancestor.root < r.id OR NOT EXISTS (
        SELECT 1 FROM coverage back WHERE back.root = r.id AND back.id = ancestor.root))
  )
),
covered(id) AS MATERIALIZED (
  SELECT DISTINCT c.id FROM coverage c JOIN selected_reports s ON s.id = c.root
)
,
window AS MATERIALIZED (SELECT c.* FROM calls c  WHERE 1 AND NOT EXISTS (SELECT 1 FROM calls prior WHERE prior.fingerprint = c.fingerprint
    AND (prior.copied, prior.source_file, prior.entry_id, prior.id) < (c.copied, c.source_file, c.entry_id, c.id))
  AND ((c.is_report = 1 AND c.run_id IN (SELECT id FROM selected_reports))
    OR (c.is_report = 0 AND (c.run_id IS NULL OR c.run_id NOT IN (SELECT id FROM covered))))),
window_runs(id) AS MATERIALIZED (SELECT DISTINCT run_id FROM window WHERE run_id IS NOT NULL),
ancestors(id) AS (
  SELECT id FROM window_runs
  UNION SELECT e.report_run_id FROM ancestors a JOIN coverage_edges e ON e.included_run_id = a.id
  UNION SELECT r.parent_run_id FROM ancestors a JOIN runs_meta r ON r.id = a.id WHERE r.parent_run_id IS NOT NULL
  UNION SELECT e.parent FROM ancestors a JOIN call_ancestry_edges e ON e.child = a.id
  UNION SELECT (SELECT MIN(o.run_id) FROM calls o INDEXED BY calls_owners_source
      WHERE o.source_file = r.source_file AND o.is_report = 0 AND o.copied = 0
        AND o.source_kind = 'transcript' AND o.run_id IS NOT NULL
      HAVING COUNT(DISTINCT o.run_id) = 1)
    FROM ancestors a JOIN calls r INDEXED BY calls_run_detail ON r.run_id = a.id
      AND r.is_report = 1 AND r.copied = 0
),
hinted(root, id) AS (
  SELECT a.id, a.id FROM ancestors a JOIN selected_reports c ON c.id = a.id
  UNION SELECT h.root, e.included_run_id FROM hinted h JOIN coverage_edges e ON e.report_run_id = h.id
  UNION SELECT h.root, r.id FROM hinted h JOIN runs_meta r ON r.parent_run_id = h.id
  UNION SELECT h.root, e.child FROM hinted h JOIN call_ancestry_edges e ON e.parent = h.id
  UNION SELECT h.root, r.run_id FROM hinted h JOIN calls r INDEXED BY calls_native_reports_source
    ON r.source_file IN (SELECT DISTINCT o.source_file FROM calls o INDEXED BY calls_native_sources
      WHERE o.run_id = h.id AND o.is_report = 0 AND o.copied = 0 AND o.source_kind = 'transcript')
    WHERE r.is_report = 1 AND r.copied = 0 AND r.run_id != h.id
      AND h.id = (SELECT MIN(o.run_id) FROM calls o INDEXED BY calls_owners_source
        WHERE o.source_file = r.source_file AND o.is_report = 0 AND o.copied = 0
          AND o.source_kind = 'transcript' AND o.run_id IS NOT NULL
        HAVING COUNT(DISTINCT o.run_id) = 1)
),
pairs AS MATERIALIZED (SELECT root, id FROM hinted h WHERE root != id
  AND (root IN (SELECT id FROM window_runs) OR id IN (SELECT id FROM window_runs))
  AND (h.id IN (SELECT id FROM selected_reports) OR (h.id NOT IN (SELECT id FROM covered)
    AND EXISTS (SELECT 1 FROM calls active WHERE active.run_id = h.id AND active.is_report = 0
      AND NOT EXISTS (SELECT 1 FROM calls prior WHERE prior.fingerprint = active.fingerprint
        AND (prior.copied, prior.source_file, prior.entry_id, prior.id) < (active.copied, active.source_file, active.entry_id, active.id)))))),
overlap_runs(id) AS MATERIALIZED (SELECT root FROM pairs UNION SELECT id FROM pairs)
SELECT w.*, CASE WHEN w.run_id IN (SELECT id FROM overlap_runs) THEN 1 ELSE 0 END AS possible_overlap,
  CASE WHEN EXISTS (SELECT 1 FROM import_state s WHERE s.path = w.source_file AND s.offset < s.size)
    OR EXISTS (SELECT 1 FROM incomplete_reports i WHERE i.path=w.source_file AND i.run_id=w.run_id)
    OR (w.is_report = 0 AND EXISTS (SELECT 1 FROM runs_meta r
      WHERE r.id = w.run_id AND r.ended_at IS NULL))
    THEN 1 ELSE 0 END AS possible_undercount
FROM window w;

CREATE TABLE IF NOT EXISTS leases (
  name TEXT PRIMARY KEY NOT NULL,
  owner TEXT, token TEXT, acquired_at INTEGER, expires_at INTEGER,
  next_due_at INTEGER, last_error_code TEXT, notice_code TEXT, notice_at INTEGER,
  owner_pid INTEGER, owner_host TEXT
);
PRAGMA user_version = 1;

-- Synthetic facts and live coordination rows, not copied from a user ledger.
INSERT INTO calls(id,ts,source_file,entry_id,source_generation,session_id,run_id,actor,
  provider,model,raw_provider,raw_model,source_kind,input,output,cache_read,cache_write,
  aic,aic_input,aic_cache_read,aic_cache_write,aic_output,price_status,rate_version,tier,
  confidence,aggregate,counted,fingerprint)
VALUES ('v1-call',100,'fixture.jsonl','v1-entry',0,'fixture-session','fixture-run','parent',
  'github-copilot','fixture-model','github-copilot','fixture-model','transcript',10,20,30,40,
  10,1,2,3,4,'priced','fixture-rate','default','estimated',0,1,'bf43c5fc0fb48f25ada3f1cf3306e54cbf9b0e927124a96104d800a597b769e2');
INSERT INTO runs_meta(id,db_path,session_id,started_at)
  VALUES ('fixture-run','fixture-project.db','fixture-session',10);
INSERT INTO import_state(path,inode,size,mtime_ms,offset,generation,prefix_hash,last_ingest_at)
  VALUES ('fixture.jsonl','fixture-inode',200,1000,100,0,'fixture-prefix',1000);
INSERT INTO counter_snapshots(ts,account_login,credits_used,entitlement,remaining,reset_date,raw)
  VALUES (1000,'fixture-account',7,100,93,'2026-11-01','{}');
INSERT INTO coverage_edges VALUES ('fixture-report','fixture-run','unknown');
INSERT INTO pending_reports VALUES ('fixture.jsonl','pending-run',0,1000,'{"calls":[],"partial":true}');
INSERT INTO incomplete_reports VALUES ('fixture.jsonl','incomplete-run');
INSERT INTO source_context VALUES ('fixture.jsonl','{"type":"session"}','fixture-tail');
INSERT INTO source_entries(path,generation,byte_offset,entry_id,json)
  VALUES ('fixture.jsonl',0,0,'fixture-entry','{"type":"metadata","id":"fixture-entry"}');
INSERT INTO leases(name,owner,token,acquired_at,expires_at,next_due_at,owner_pid,owner_host)
  VALUES ('ingest','fixture-owner','fixture-ingest-token',1000,121000,NULL,NULL,NULL),
    ('counter','fixture-owner','fixture-counter-token',1000,121000,11000,NULL,NULL);
INSERT INTO ledger_metadata VALUES ('worker-snapshot','{"type":"snapshot","fixture":true}'),
  ('backfill-state','running');

CREATE INDEX IF NOT EXISTS runs_meta_session ON runs_meta(session_id,db_path,id);
INSERT INTO ledger_metadata(key,value) VALUES ('call-selection-revision','0') ON CONFLICT(key) DO NOTHING;
CREATE TRIGGER selection_revision_calls_insert
AFTER INSERT ON calls

BEGIN
  INSERT INTO ledger_metadata(key,value) VALUES ('call-selection-revision','1')
    ON CONFLICT(key) DO UPDATE SET value=CAST(ledger_metadata.value AS INTEGER)+1;
END;
CREATE TRIGGER selection_revision_calls_delete
AFTER DELETE ON calls

BEGIN
  INSERT INTO ledger_metadata(key,value) VALUES ('call-selection-revision','1')
    ON CONFLICT(key) DO UPDATE SET value=CAST(ledger_metadata.value AS INTEGER)+1;
END;
CREATE TRIGGER selection_revision_calls_update
AFTER UPDATE OF id,ts,source_file,entry_id,source_generation,project,repo,session_id,run_id,actor,role,agent,run_name,phase,parent_run_id,aux_purpose,provider,model,raw_provider,raw_model,requested_model,thinking,api,source_kind,input,output,cache_read,cache_write,cache_write_1h,reasoning,total_tokens,aic,aic_input,aic_cache_read,aic_cache_write,aic_output,price_status,unpriced_reason,rate_version,tier,confidence,pi_cost,latency_ms,aggregate,response_id,copied,fingerprint ON calls
WHEN (OLD.id IS NOT NEW.id OR OLD.ts IS NOT NEW.ts OR OLD.source_file IS NOT NEW.source_file OR OLD.entry_id IS NOT NEW.entry_id OR OLD.source_generation IS NOT NEW.source_generation OR OLD.project IS NOT NEW.project OR OLD.repo IS NOT NEW.repo OR OLD.session_id IS NOT NEW.session_id OR OLD.run_id IS NOT NEW.run_id OR OLD.actor IS NOT NEW.actor OR OLD.role IS NOT NEW.role OR OLD.agent IS NOT NEW.agent OR OLD.run_name IS NOT NEW.run_name OR OLD.phase IS NOT NEW.phase OR OLD.parent_run_id IS NOT NEW.parent_run_id OR OLD.aux_purpose IS NOT NEW.aux_purpose OR OLD.provider IS NOT NEW.provider OR OLD.model IS NOT NEW.model OR OLD.raw_provider IS NOT NEW.raw_provider OR OLD.raw_model IS NOT NEW.raw_model OR OLD.requested_model IS NOT NEW.requested_model OR OLD.thinking IS NOT NEW.thinking OR OLD.api IS NOT NEW.api OR OLD.source_kind IS NOT NEW.source_kind OR OLD.input IS NOT NEW.input OR OLD.output IS NOT NEW.output OR OLD.cache_read IS NOT NEW.cache_read OR OLD.cache_write IS NOT NEW.cache_write OR OLD.cache_write_1h IS NOT NEW.cache_write_1h OR OLD.reasoning IS NOT NEW.reasoning OR OLD.total_tokens IS NOT NEW.total_tokens OR OLD.aic IS NOT NEW.aic OR OLD.aic_input IS NOT NEW.aic_input OR OLD.aic_cache_read IS NOT NEW.aic_cache_read OR OLD.aic_cache_write IS NOT NEW.aic_cache_write OR OLD.aic_output IS NOT NEW.aic_output OR OLD.price_status IS NOT NEW.price_status OR OLD.unpriced_reason IS NOT NEW.unpriced_reason OR OLD.rate_version IS NOT NEW.rate_version OR OLD.tier IS NOT NEW.tier OR OLD.confidence IS NOT NEW.confidence OR OLD.pi_cost IS NOT NEW.pi_cost OR OLD.latency_ms IS NOT NEW.latency_ms OR OLD.aggregate IS NOT NEW.aggregate OR OLD.response_id IS NOT NEW.response_id OR OLD.copied IS NOT NEW.copied OR OLD.fingerprint IS NOT NEW.fingerprint)
BEGIN
  INSERT INTO ledger_metadata(key,value) VALUES ('call-selection-revision','1')
    ON CONFLICT(key) DO UPDATE SET value=CAST(ledger_metadata.value AS INTEGER)+1;
END;
CREATE TRIGGER selection_revision_runs_meta_insert
AFTER INSERT ON runs_meta

BEGIN
  INSERT INTO ledger_metadata(key,value) VALUES ('call-selection-revision','1')
    ON CONFLICT(key) DO UPDATE SET value=CAST(ledger_metadata.value AS INTEGER)+1;
END;
CREATE TRIGGER selection_revision_runs_meta_delete
AFTER DELETE ON runs_meta

BEGIN
  INSERT INTO ledger_metadata(key,value) VALUES ('call-selection-revision','1')
    ON CONFLICT(key) DO UPDATE SET value=CAST(ledger_metadata.value AS INTEGER)+1;
END;
CREATE TRIGGER selection_revision_runs_meta_update
AFTER UPDATE OF id,db_path,project,repo,session_id,parent_run_id,agent,role,name,model,thinking,phase,started_at,ended_at ON runs_meta
WHEN (OLD.id IS NOT NEW.id OR OLD.db_path IS NOT NEW.db_path OR OLD.project IS NOT NEW.project OR OLD.repo IS NOT NEW.repo OR OLD.session_id IS NOT NEW.session_id OR OLD.parent_run_id IS NOT NEW.parent_run_id OR OLD.agent IS NOT NEW.agent OR OLD.role IS NOT NEW.role OR OLD.name IS NOT NEW.name OR OLD.model IS NOT NEW.model OR OLD.thinking IS NOT NEW.thinking OR OLD.phase IS NOT NEW.phase OR OLD.started_at IS NOT NEW.started_at OR OLD.ended_at IS NOT NEW.ended_at)
BEGIN
  INSERT INTO ledger_metadata(key,value) VALUES ('call-selection-revision','1')
    ON CONFLICT(key) DO UPDATE SET value=CAST(ledger_metadata.value AS INTEGER)+1;
END;
CREATE TRIGGER selection_revision_coverage_edges_insert
AFTER INSERT ON coverage_edges

BEGIN
  INSERT INTO ledger_metadata(key,value) VALUES ('call-selection-revision','1')
    ON CONFLICT(key) DO UPDATE SET value=CAST(ledger_metadata.value AS INTEGER)+1;
END;
CREATE TRIGGER selection_revision_coverage_edges_delete
AFTER DELETE ON coverage_edges

BEGIN
  INSERT INTO ledger_metadata(key,value) VALUES ('call-selection-revision','1')
    ON CONFLICT(key) DO UPDATE SET value=CAST(ledger_metadata.value AS INTEGER)+1;
END;
CREATE TRIGGER selection_revision_coverage_edges_update
AFTER UPDATE OF report_run_id,included_run_id,evidence ON coverage_edges
WHEN (OLD.report_run_id IS NOT NEW.report_run_id OR OLD.included_run_id IS NOT NEW.included_run_id OR OLD.evidence IS NOT NEW.evidence)
BEGIN
  INSERT INTO ledger_metadata(key,value) VALUES ('call-selection-revision','1')
    ON CONFLICT(key) DO UPDATE SET value=CAST(ledger_metadata.value AS INTEGER)+1;
END;
CREATE TRIGGER selection_revision_pending_reports_insert
AFTER INSERT ON pending_reports

BEGIN
  INSERT INTO ledger_metadata(key,value) VALUES ('call-selection-revision','1')
    ON CONFLICT(key) DO UPDATE SET value=CAST(ledger_metadata.value AS INTEGER)+1;
END;
CREATE TRIGGER selection_revision_pending_reports_delete
AFTER DELETE ON pending_reports

BEGIN
  INSERT INTO ledger_metadata(key,value) VALUES ('call-selection-revision','1')
    ON CONFLICT(key) DO UPDATE SET value=CAST(ledger_metadata.value AS INTEGER)+1;
END;
CREATE TRIGGER selection_revision_pending_reports_update
AFTER UPDATE OF path,run_id,generation,first_seen,calls ON pending_reports
WHEN (OLD.path IS NOT NEW.path OR OLD.run_id IS NOT NEW.run_id OR OLD.generation IS NOT NEW.generation OR OLD.first_seen IS NOT NEW.first_seen OR OLD.calls IS NOT NEW.calls)
BEGIN
  INSERT INTO ledger_metadata(key,value) VALUES ('call-selection-revision','1')
    ON CONFLICT(key) DO UPDATE SET value=CAST(ledger_metadata.value AS INTEGER)+1;
END;
CREATE TRIGGER selection_revision_incomplete_reports_insert
AFTER INSERT ON incomplete_reports

BEGIN
  INSERT INTO ledger_metadata(key,value) VALUES ('call-selection-revision','1')
    ON CONFLICT(key) DO UPDATE SET value=CAST(ledger_metadata.value AS INTEGER)+1;
END;
CREATE TRIGGER selection_revision_incomplete_reports_delete
AFTER DELETE ON incomplete_reports

BEGIN
  INSERT INTO ledger_metadata(key,value) VALUES ('call-selection-revision','1')
    ON CONFLICT(key) DO UPDATE SET value=CAST(ledger_metadata.value AS INTEGER)+1;
END;
CREATE TRIGGER selection_revision_incomplete_reports_update
AFTER UPDATE OF path,run_id ON incomplete_reports
WHEN (OLD.path IS NOT NEW.path OR OLD.run_id IS NOT NEW.run_id)
BEGIN
  INSERT INTO ledger_metadata(key,value) VALUES ('call-selection-revision','1')
    ON CONFLICT(key) DO UPDATE SET value=CAST(ledger_metadata.value AS INTEGER)+1;
END;
CREATE TRIGGER selection_revision_import_state_insert
AFTER INSERT ON import_state
WHEN (NEW.size IS NOT NULL OR NEW.offset IS NOT NULL OR NEW.generation != 0)
BEGIN
  INSERT INTO ledger_metadata(key,value) VALUES ('call-selection-revision','1')
    ON CONFLICT(key) DO UPDATE SET value=CAST(ledger_metadata.value AS INTEGER)+1;
END;
CREATE TRIGGER selection_revision_import_state_delete
AFTER DELETE ON import_state
WHEN (OLD.size IS NOT NULL OR OLD.offset IS NOT NULL OR OLD.generation != 0)
BEGIN
  INSERT INTO ledger_metadata(key,value) VALUES ('call-selection-revision','1')
    ON CONFLICT(key) DO UPDATE SET value=CAST(ledger_metadata.value AS INTEGER)+1;
END;
CREATE TRIGGER selection_revision_import_state_update
AFTER UPDATE OF path,generation,offset,size ON import_state
WHEN (OLD.path IS NOT NEW.path OR OLD.generation IS NOT NEW.generation OR OLD.offset IS NOT NEW.offset OR OLD.size IS NOT NEW.size) AND ((OLD.size IS NOT NULL OR OLD.offset IS NOT NULL OR OLD.generation != 0) OR (NEW.size IS NOT NULL OR NEW.offset IS NOT NULL OR NEW.generation != 0))
BEGIN
  INSERT INTO ledger_metadata(key,value) VALUES ('call-selection-revision','1')
    ON CONFLICT(key) DO UPDATE SET value=CAST(ledger_metadata.value AS INTEGER)+1;
END;
CREATE TRIGGER selection_revision_call_ancestry_edges_insert
AFTER INSERT ON call_ancestry_edges

BEGIN
  INSERT INTO ledger_metadata(key,value) VALUES ('call-selection-revision','1')
    ON CONFLICT(key) DO UPDATE SET value=CAST(ledger_metadata.value AS INTEGER)+1;
END;
CREATE TRIGGER selection_revision_call_ancestry_edges_delete
AFTER DELETE ON call_ancestry_edges

BEGIN
  INSERT INTO ledger_metadata(key,value) VALUES ('call-selection-revision','1')
    ON CONFLICT(key) DO UPDATE SET value=CAST(ledger_metadata.value AS INTEGER)+1;
END;
CREATE TRIGGER selection_revision_call_ancestry_edges_update
AFTER UPDATE OF parent,child ON call_ancestry_edges
WHEN (OLD.parent IS NOT NEW.parent OR OLD.child IS NOT NEW.child)
BEGIN
  INSERT INTO ledger_metadata(key,value) VALUES ('call-selection-revision','1')
    ON CONFLICT(key) DO UPDATE SET value=CAST(ledger_metadata.value AS INTEGER)+1;
END;


ALTER TABLE calls ADD COLUMN selection_shadowed INTEGER NOT NULL DEFAULT 0 CHECK (selection_shadowed IN (0,1));
ALTER TABLE calls ADD COLUMN selection_undercount INTEGER NOT NULL DEFAULT 0 CHECK (selection_undercount IN (0,1));
UPDATE calls SET selection_shadowed=EXISTS (SELECT 1 FROM calls prior WHERE prior.fingerprint = calls.fingerprint
  AND (prior.copied,prior.source_file,prior.entry_id,prior.id) < (calls.copied,calls.source_file,calls.entry_id,calls.id)),selection_undercount=(EXISTS (SELECT 1 FROM import_state s WHERE s.path=calls.source_file AND s.offset<s.size)
  OR EXISTS (SELECT 1 FROM incomplete_reports i WHERE i.path=calls.source_file AND i.run_id=calls.run_id)
  OR (calls.is_report=0 AND EXISTS (SELECT 1 FROM runs_meta r WHERE r.id=calls.run_id AND r.ended_at IS NULL)))
  WHERE (EXISTS (SELECT 1 FROM calls prior WHERE prior.fingerprint = calls.fingerprint
  AND (prior.copied,prior.source_file,prior.entry_id,prior.id) < (calls.copied,calls.source_file,calls.entry_id,calls.id))) OR ((EXISTS (SELECT 1 FROM import_state s WHERE s.path=calls.source_file AND s.offset<s.size)
  OR EXISTS (SELECT 1 FROM incomplete_reports i WHERE i.path=calls.source_file AND i.run_id=calls.run_id)
  OR (calls.is_report=0 AND EXISTS (SELECT 1 FROM runs_meta r WHERE r.id=calls.run_id AND r.ended_at IS NULL))));
CREATE TABLE dimension_values (
  dimension TEXT NOT NULL,has_value INTEGER NOT NULL CHECK (has_value IN (0,1)),value TEXT NOT NULL,
  first_seen INTEGER NOT NULL,last_seen INTEGER NOT NULL CHECK (last_seen>=first_seen),
  PRIMARY KEY(dimension,has_value,value), CHECK (has_value=1 OR value='')
) WITHOUT ROWID;
INSERT INTO dimension_values(dimension,has_value,value,first_seen,last_seen)
    SELECT 'project',c.project IS NOT NULL,COALESCE(c.project,''),MIN(c.ts),MAX(c.ts) FROM calls c WHERE c.project IS NOT NULL
    GROUP BY c.project ON CONFLICT(dimension,has_value,value) DO UPDATE SET
  first_seen=MIN(dimension_values.first_seen,excluded.first_seen),last_seen=MAX(dimension_values.last_seen,excluded.last_seen)
  WHERE excluded.first_seen<dimension_values.first_seen OR excluded.last_seen>dimension_values.last_seen;
INSERT INTO dimension_values(dimension,has_value,value,first_seen,last_seen)
    SELECT 'repo',c.repo IS NOT NULL,COALESCE(c.repo,''),MIN(c.ts),MAX(c.ts) FROM calls c WHERE c.repo IS NOT NULL
    GROUP BY c.repo ON CONFLICT(dimension,has_value,value) DO UPDATE SET
  first_seen=MIN(dimension_values.first_seen,excluded.first_seen),last_seen=MAX(dimension_values.last_seen,excluded.last_seen)
  WHERE excluded.first_seen<dimension_values.first_seen OR excluded.last_seen>dimension_values.last_seen;
INSERT INTO dimension_values(dimension,has_value,value,first_seen,last_seen)
    SELECT 'session',c.session_id IS NOT NULL,COALESCE(c.session_id,''),MIN(c.ts),MAX(c.ts) FROM calls c WHERE c.session_id IS NOT NULL
    GROUP BY c.session_id ON CONFLICT(dimension,has_value,value) DO UPDATE SET
  first_seen=MIN(dimension_values.first_seen,excluded.first_seen),last_seen=MAX(dimension_values.last_seen,excluded.last_seen)
  WHERE excluded.first_seen<dimension_values.first_seen OR excluded.last_seen>dimension_values.last_seen;
INSERT INTO dimension_values(dimension,has_value,value,first_seen,last_seen)
    SELECT 'actor',c.actor IS NOT NULL,COALESCE(c.actor,''),MIN(c.ts),MAX(c.ts) FROM calls c WHERE c.actor IS NOT NULL
    GROUP BY c.actor ON CONFLICT(dimension,has_value,value) DO UPDATE SET
  first_seen=MIN(dimension_values.first_seen,excluded.first_seen),last_seen=MAX(dimension_values.last_seen,excluded.last_seen)
  WHERE excluded.first_seen<dimension_values.first_seen OR excluded.last_seen>dimension_values.last_seen;
INSERT INTO dimension_values(dimension,has_value,value,first_seen,last_seen)
    SELECT 'role',c.role IS NOT NULL,COALESCE(c.role,''),MIN(c.ts),MAX(c.ts) FROM calls c WHERE c.role IS NOT NULL
    GROUP BY c.role ON CONFLICT(dimension,has_value,value) DO UPDATE SET
  first_seen=MIN(dimension_values.first_seen,excluded.first_seen),last_seen=MAX(dimension_values.last_seen,excluded.last_seen)
  WHERE excluded.first_seen<dimension_values.first_seen OR excluded.last_seen>dimension_values.last_seen;
INSERT INTO dimension_values(dimension,has_value,value,first_seen,last_seen)
    SELECT 'agent',c.agent IS NOT NULL,COALESCE(c.agent,''),MIN(c.ts),MAX(c.ts) FROM calls c WHERE c.agent IS NOT NULL
    GROUP BY c.agent ON CONFLICT(dimension,has_value,value) DO UPDATE SET
  first_seen=MIN(dimension_values.first_seen,excluded.first_seen),last_seen=MAX(dimension_values.last_seen,excluded.last_seen)
  WHERE excluded.first_seen<dimension_values.first_seen OR excluded.last_seen>dimension_values.last_seen;
INSERT INTO dimension_values(dimension,has_value,value,first_seen,last_seen)
    SELECT 'provider',c.provider IS NOT NULL,COALESCE(c.provider,''),MIN(c.ts),MAX(c.ts) FROM calls c WHERE c.provider IS NOT NULL
    GROUP BY c.provider ON CONFLICT(dimension,has_value,value) DO UPDATE SET
  first_seen=MIN(dimension_values.first_seen,excluded.first_seen),last_seen=MAX(dimension_values.last_seen,excluded.last_seen)
  WHERE excluded.first_seen<dimension_values.first_seen OR excluded.last_seen>dimension_values.last_seen;
INSERT INTO dimension_values(dimension,has_value,value,first_seen,last_seen)
    SELECT 'model',c.model IS NOT NULL,COALESCE(c.model,''),MIN(c.ts),MAX(c.ts) FROM calls c WHERE c.model IS NOT NULL
    GROUP BY c.model ON CONFLICT(dimension,has_value,value) DO UPDATE SET
  first_seen=MIN(dimension_values.first_seen,excluded.first_seen),last_seen=MAX(dimension_values.last_seen,excluded.last_seen)
  WHERE excluded.first_seen<dimension_values.first_seen OR excluded.last_seen>dimension_values.last_seen;
INSERT INTO dimension_values(dimension,has_value,value,first_seen,last_seen)
    SELECT 'requestedModel',c.requested_model IS NOT NULL,COALESCE(c.requested_model,''),MIN(c.ts),MAX(c.ts) FROM calls c WHERE c.requested_model IS NOT NULL
    GROUP BY c.requested_model ON CONFLICT(dimension,has_value,value) DO UPDATE SET
  first_seen=MIN(dimension_values.first_seen,excluded.first_seen),last_seen=MAX(dimension_values.last_seen,excluded.last_seen)
  WHERE excluded.first_seen<dimension_values.first_seen OR excluded.last_seen>dimension_values.last_seen;
INSERT INTO dimension_values(dimension,has_value,value,first_seen,last_seen)
    SELECT 'thinking',c.thinking IS NOT NULL,COALESCE(c.thinking,''),MIN(c.ts),MAX(c.ts) FROM calls c WHERE c.thinking IS NOT NULL
    GROUP BY c.thinking ON CONFLICT(dimension,has_value,value) DO UPDATE SET
  first_seen=MIN(dimension_values.first_seen,excluded.first_seen),last_seen=MAX(dimension_values.last_seen,excluded.last_seen)
  WHERE excluded.first_seen<dimension_values.first_seen OR excluded.last_seen>dimension_values.last_seen;
INSERT INTO dimension_values(dimension,has_value,value,first_seen,last_seen)
    SELECT 'run',c.run_id IS NOT NULL,COALESCE(c.run_id,''),MIN(c.ts),MAX(c.ts) FROM calls c WHERE c.run_id IS NOT NULL
    GROUP BY c.run_id ON CONFLICT(dimension,has_value,value) DO UPDATE SET
  first_seen=MIN(dimension_values.first_seen,excluded.first_seen),last_seen=MAX(dimension_values.last_seen,excluded.last_seen)
  WHERE excluded.first_seen<dimension_values.first_seen OR excluded.last_seen>dimension_values.last_seen;
INSERT INTO dimension_values(dimension,has_value,value,first_seen,last_seen)
    SELECT 'runName',c.run_name IS NOT NULL,COALESCE(c.run_name,''),MIN(c.ts),MAX(c.ts) FROM calls c WHERE c.run_name IS NOT NULL
    GROUP BY c.run_name ON CONFLICT(dimension,has_value,value) DO UPDATE SET
  first_seen=MIN(dimension_values.first_seen,excluded.first_seen),last_seen=MAX(dimension_values.last_seen,excluded.last_seen)
  WHERE excluded.first_seen<dimension_values.first_seen OR excluded.last_seen>dimension_values.last_seen;
INSERT INTO dimension_values(dimension,has_value,value,first_seen,last_seen)
    SELECT 'phase',c.phase IS NOT NULL,COALESCE(c.phase,''),MIN(c.ts),MAX(c.ts) FROM calls c WHERE c.phase IS NOT NULL
    GROUP BY c.phase ON CONFLICT(dimension,has_value,value) DO UPDATE SET
  first_seen=MIN(dimension_values.first_seen,excluded.first_seen),last_seen=MAX(dimension_values.last_seen,excluded.last_seen)
  WHERE excluded.first_seen<dimension_values.first_seen OR excluded.last_seen>dimension_values.last_seen;
INSERT INTO dimension_values(dimension,has_value,value,first_seen,last_seen)
    SELECT 'parentRun',c.parent_run_id IS NOT NULL,COALESCE(c.parent_run_id,''),MIN(c.ts),MAX(c.ts) FROM calls c WHERE c.parent_run_id IS NOT NULL
    GROUP BY c.parent_run_id ON CONFLICT(dimension,has_value,value) DO UPDATE SET
  first_seen=MIN(dimension_values.first_seen,excluded.first_seen),last_seen=MAX(dimension_values.last_seen,excluded.last_seen)
  WHERE excluded.first_seen<dimension_values.first_seen OR excluded.last_seen>dimension_values.last_seen;
INSERT INTO dimension_values(dimension,has_value,value,first_seen,last_seen)
    SELECT 'auxPurpose',c.aux_purpose IS NOT NULL,COALESCE(c.aux_purpose,''),MIN(c.ts),MAX(c.ts) FROM calls c WHERE c.aux_purpose IS NOT NULL
    GROUP BY c.aux_purpose ON CONFLICT(dimension,has_value,value) DO UPDATE SET
  first_seen=MIN(dimension_values.first_seen,excluded.first_seen),last_seen=MAX(dimension_values.last_seen,excluded.last_seen)
  WHERE excluded.first_seen<dimension_values.first_seen OR excluded.last_seen>dimension_values.last_seen;
INSERT INTO dimension_values(dimension,has_value,value,first_seen,last_seen)
    SELECT 'api',c.api IS NOT NULL,COALESCE(c.api,''),MIN(c.ts),MAX(c.ts) FROM calls c WHERE c.api IS NOT NULL
    GROUP BY c.api ON CONFLICT(dimension,has_value,value) DO UPDATE SET
  first_seen=MIN(dimension_values.first_seen,excluded.first_seen),last_seen=MAX(dimension_values.last_seen,excluded.last_seen)
  WHERE excluded.first_seen<dimension_values.first_seen OR excluded.last_seen>dimension_values.last_seen;
INSERT INTO dimension_values(dimension,has_value,value,first_seen,last_seen)
    SELECT 'day',strftime('%Y-%m-%d',c.ts/1000,'unixepoch') IS NOT NULL,COALESCE(strftime('%Y-%m-%d',c.ts/1000,'unixepoch'),''),MIN(c.ts),MAX(c.ts) FROM calls c WHERE strftime('%Y-%m-%d',c.ts/1000,'unixepoch') IS NOT NULL
    GROUP BY strftime('%Y-%m-%d',c.ts/1000,'unixepoch') ON CONFLICT(dimension,has_value,value) DO UPDATE SET
  first_seen=MIN(dimension_values.first_seen,excluded.first_seen),last_seen=MAX(dimension_values.last_seen,excluded.last_seen)
  WHERE excluded.first_seen<dimension_values.first_seen OR excluded.last_seen>dimension_values.last_seen;
CREATE TRIGGER dimension_values_insert AFTER INSERT ON calls BEGIN
  INSERT INTO dimension_values(dimension,has_value,value,first_seen,last_seen)
    SELECT 'project',NEW.project IS NOT NULL,COALESCE(NEW.project,''),NEW.ts,NEW.ts WHERE NEW.project IS NOT NULL ON CONFLICT(dimension,has_value,value) DO UPDATE SET
  first_seen=MIN(dimension_values.first_seen,excluded.first_seen),last_seen=MAX(dimension_values.last_seen,excluded.last_seen)
  WHERE excluded.first_seen<dimension_values.first_seen OR excluded.last_seen>dimension_values.last_seen;
INSERT INTO dimension_values(dimension,has_value,value,first_seen,last_seen)
    SELECT 'repo',NEW.repo IS NOT NULL,COALESCE(NEW.repo,''),NEW.ts,NEW.ts WHERE NEW.repo IS NOT NULL ON CONFLICT(dimension,has_value,value) DO UPDATE SET
  first_seen=MIN(dimension_values.first_seen,excluded.first_seen),last_seen=MAX(dimension_values.last_seen,excluded.last_seen)
  WHERE excluded.first_seen<dimension_values.first_seen OR excluded.last_seen>dimension_values.last_seen;
INSERT INTO dimension_values(dimension,has_value,value,first_seen,last_seen)
    SELECT 'session',NEW.session_id IS NOT NULL,COALESCE(NEW.session_id,''),NEW.ts,NEW.ts WHERE NEW.session_id IS NOT NULL ON CONFLICT(dimension,has_value,value) DO UPDATE SET
  first_seen=MIN(dimension_values.first_seen,excluded.first_seen),last_seen=MAX(dimension_values.last_seen,excluded.last_seen)
  WHERE excluded.first_seen<dimension_values.first_seen OR excluded.last_seen>dimension_values.last_seen;
INSERT INTO dimension_values(dimension,has_value,value,first_seen,last_seen)
    SELECT 'actor',NEW.actor IS NOT NULL,COALESCE(NEW.actor,''),NEW.ts,NEW.ts WHERE NEW.actor IS NOT NULL ON CONFLICT(dimension,has_value,value) DO UPDATE SET
  first_seen=MIN(dimension_values.first_seen,excluded.first_seen),last_seen=MAX(dimension_values.last_seen,excluded.last_seen)
  WHERE excluded.first_seen<dimension_values.first_seen OR excluded.last_seen>dimension_values.last_seen;
INSERT INTO dimension_values(dimension,has_value,value,first_seen,last_seen)
    SELECT 'role',NEW.role IS NOT NULL,COALESCE(NEW.role,''),NEW.ts,NEW.ts WHERE NEW.role IS NOT NULL ON CONFLICT(dimension,has_value,value) DO UPDATE SET
  first_seen=MIN(dimension_values.first_seen,excluded.first_seen),last_seen=MAX(dimension_values.last_seen,excluded.last_seen)
  WHERE excluded.first_seen<dimension_values.first_seen OR excluded.last_seen>dimension_values.last_seen;
INSERT INTO dimension_values(dimension,has_value,value,first_seen,last_seen)
    SELECT 'agent',NEW.agent IS NOT NULL,COALESCE(NEW.agent,''),NEW.ts,NEW.ts WHERE NEW.agent IS NOT NULL ON CONFLICT(dimension,has_value,value) DO UPDATE SET
  first_seen=MIN(dimension_values.first_seen,excluded.first_seen),last_seen=MAX(dimension_values.last_seen,excluded.last_seen)
  WHERE excluded.first_seen<dimension_values.first_seen OR excluded.last_seen>dimension_values.last_seen;
INSERT INTO dimension_values(dimension,has_value,value,first_seen,last_seen)
    SELECT 'provider',NEW.provider IS NOT NULL,COALESCE(NEW.provider,''),NEW.ts,NEW.ts WHERE NEW.provider IS NOT NULL ON CONFLICT(dimension,has_value,value) DO UPDATE SET
  first_seen=MIN(dimension_values.first_seen,excluded.first_seen),last_seen=MAX(dimension_values.last_seen,excluded.last_seen)
  WHERE excluded.first_seen<dimension_values.first_seen OR excluded.last_seen>dimension_values.last_seen;
INSERT INTO dimension_values(dimension,has_value,value,first_seen,last_seen)
    SELECT 'model',NEW.model IS NOT NULL,COALESCE(NEW.model,''),NEW.ts,NEW.ts WHERE NEW.model IS NOT NULL ON CONFLICT(dimension,has_value,value) DO UPDATE SET
  first_seen=MIN(dimension_values.first_seen,excluded.first_seen),last_seen=MAX(dimension_values.last_seen,excluded.last_seen)
  WHERE excluded.first_seen<dimension_values.first_seen OR excluded.last_seen>dimension_values.last_seen;
INSERT INTO dimension_values(dimension,has_value,value,first_seen,last_seen)
    SELECT 'requestedModel',NEW.requested_model IS NOT NULL,COALESCE(NEW.requested_model,''),NEW.ts,NEW.ts WHERE NEW.requested_model IS NOT NULL ON CONFLICT(dimension,has_value,value) DO UPDATE SET
  first_seen=MIN(dimension_values.first_seen,excluded.first_seen),last_seen=MAX(dimension_values.last_seen,excluded.last_seen)
  WHERE excluded.first_seen<dimension_values.first_seen OR excluded.last_seen>dimension_values.last_seen;
INSERT INTO dimension_values(dimension,has_value,value,first_seen,last_seen)
    SELECT 'thinking',NEW.thinking IS NOT NULL,COALESCE(NEW.thinking,''),NEW.ts,NEW.ts WHERE NEW.thinking IS NOT NULL ON CONFLICT(dimension,has_value,value) DO UPDATE SET
  first_seen=MIN(dimension_values.first_seen,excluded.first_seen),last_seen=MAX(dimension_values.last_seen,excluded.last_seen)
  WHERE excluded.first_seen<dimension_values.first_seen OR excluded.last_seen>dimension_values.last_seen;
INSERT INTO dimension_values(dimension,has_value,value,first_seen,last_seen)
    SELECT 'run',NEW.run_id IS NOT NULL,COALESCE(NEW.run_id,''),NEW.ts,NEW.ts WHERE NEW.run_id IS NOT NULL ON CONFLICT(dimension,has_value,value) DO UPDATE SET
  first_seen=MIN(dimension_values.first_seen,excluded.first_seen),last_seen=MAX(dimension_values.last_seen,excluded.last_seen)
  WHERE excluded.first_seen<dimension_values.first_seen OR excluded.last_seen>dimension_values.last_seen;
INSERT INTO dimension_values(dimension,has_value,value,first_seen,last_seen)
    SELECT 'runName',NEW.run_name IS NOT NULL,COALESCE(NEW.run_name,''),NEW.ts,NEW.ts WHERE NEW.run_name IS NOT NULL ON CONFLICT(dimension,has_value,value) DO UPDATE SET
  first_seen=MIN(dimension_values.first_seen,excluded.first_seen),last_seen=MAX(dimension_values.last_seen,excluded.last_seen)
  WHERE excluded.first_seen<dimension_values.first_seen OR excluded.last_seen>dimension_values.last_seen;
INSERT INTO dimension_values(dimension,has_value,value,first_seen,last_seen)
    SELECT 'phase',NEW.phase IS NOT NULL,COALESCE(NEW.phase,''),NEW.ts,NEW.ts WHERE NEW.phase IS NOT NULL ON CONFLICT(dimension,has_value,value) DO UPDATE SET
  first_seen=MIN(dimension_values.first_seen,excluded.first_seen),last_seen=MAX(dimension_values.last_seen,excluded.last_seen)
  WHERE excluded.first_seen<dimension_values.first_seen OR excluded.last_seen>dimension_values.last_seen;
INSERT INTO dimension_values(dimension,has_value,value,first_seen,last_seen)
    SELECT 'parentRun',NEW.parent_run_id IS NOT NULL,COALESCE(NEW.parent_run_id,''),NEW.ts,NEW.ts WHERE NEW.parent_run_id IS NOT NULL ON CONFLICT(dimension,has_value,value) DO UPDATE SET
  first_seen=MIN(dimension_values.first_seen,excluded.first_seen),last_seen=MAX(dimension_values.last_seen,excluded.last_seen)
  WHERE excluded.first_seen<dimension_values.first_seen OR excluded.last_seen>dimension_values.last_seen;
INSERT INTO dimension_values(dimension,has_value,value,first_seen,last_seen)
    SELECT 'auxPurpose',NEW.aux_purpose IS NOT NULL,COALESCE(NEW.aux_purpose,''),NEW.ts,NEW.ts WHERE NEW.aux_purpose IS NOT NULL ON CONFLICT(dimension,has_value,value) DO UPDATE SET
  first_seen=MIN(dimension_values.first_seen,excluded.first_seen),last_seen=MAX(dimension_values.last_seen,excluded.last_seen)
  WHERE excluded.first_seen<dimension_values.first_seen OR excluded.last_seen>dimension_values.last_seen;
INSERT INTO dimension_values(dimension,has_value,value,first_seen,last_seen)
    SELECT 'api',NEW.api IS NOT NULL,COALESCE(NEW.api,''),NEW.ts,NEW.ts WHERE NEW.api IS NOT NULL ON CONFLICT(dimension,has_value,value) DO UPDATE SET
  first_seen=MIN(dimension_values.first_seen,excluded.first_seen),last_seen=MAX(dimension_values.last_seen,excluded.last_seen)
  WHERE excluded.first_seen<dimension_values.first_seen OR excluded.last_seen>dimension_values.last_seen;
INSERT INTO dimension_values(dimension,has_value,value,first_seen,last_seen)
    SELECT 'day',strftime('%Y-%m-%d',NEW.ts/1000,'unixepoch') IS NOT NULL,COALESCE(strftime('%Y-%m-%d',NEW.ts/1000,'unixepoch'),''),NEW.ts,NEW.ts WHERE strftime('%Y-%m-%d',NEW.ts/1000,'unixepoch') IS NOT NULL ON CONFLICT(dimension,has_value,value) DO UPDATE SET
  first_seen=MIN(dimension_values.first_seen,excluded.first_seen),last_seen=MAX(dimension_values.last_seen,excluded.last_seen)
  WHERE excluded.first_seen<dimension_values.first_seen OR excluded.last_seen>dimension_values.last_seen;
END;
CREATE TRIGGER dimension_values_update AFTER UPDATE OF project,repo,session_id,actor,role,agent,provider,model,requested_model,thinking,run_id,run_name,phase,parent_run_id,aux_purpose,api,ts ON calls
WHEN OLD.project IS NOT NEW.project OR OLD.repo IS NOT NEW.repo OR OLD.session_id IS NOT NEW.session_id OR OLD.actor IS NOT NEW.actor OR OLD.role IS NOT NEW.role OR OLD.agent IS NOT NEW.agent OR OLD.provider IS NOT NEW.provider OR OLD.model IS NOT NEW.model OR OLD.requested_model IS NOT NEW.requested_model OR OLD.thinking IS NOT NEW.thinking OR OLD.run_id IS NOT NEW.run_id OR OLD.run_name IS NOT NEW.run_name OR OLD.phase IS NOT NEW.phase OR OLD.parent_run_id IS NOT NEW.parent_run_id OR OLD.aux_purpose IS NOT NEW.aux_purpose OR OLD.api IS NOT NEW.api OR OLD.ts IS NOT NEW.ts BEGIN
  INSERT INTO dimension_values(dimension,has_value,value,first_seen,last_seen)
    SELECT 'project',NEW.project IS NOT NULL,COALESCE(NEW.project,''),NEW.ts,NEW.ts WHERE NEW.project IS NOT NULL ON CONFLICT(dimension,has_value,value) DO UPDATE SET
  first_seen=MIN(dimension_values.first_seen,excluded.first_seen),last_seen=MAX(dimension_values.last_seen,excluded.last_seen)
  WHERE excluded.first_seen<dimension_values.first_seen OR excluded.last_seen>dimension_values.last_seen;
INSERT INTO dimension_values(dimension,has_value,value,first_seen,last_seen)
    SELECT 'repo',NEW.repo IS NOT NULL,COALESCE(NEW.repo,''),NEW.ts,NEW.ts WHERE NEW.repo IS NOT NULL ON CONFLICT(dimension,has_value,value) DO UPDATE SET
  first_seen=MIN(dimension_values.first_seen,excluded.first_seen),last_seen=MAX(dimension_values.last_seen,excluded.last_seen)
  WHERE excluded.first_seen<dimension_values.first_seen OR excluded.last_seen>dimension_values.last_seen;
INSERT INTO dimension_values(dimension,has_value,value,first_seen,last_seen)
    SELECT 'session',NEW.session_id IS NOT NULL,COALESCE(NEW.session_id,''),NEW.ts,NEW.ts WHERE NEW.session_id IS NOT NULL ON CONFLICT(dimension,has_value,value) DO UPDATE SET
  first_seen=MIN(dimension_values.first_seen,excluded.first_seen),last_seen=MAX(dimension_values.last_seen,excluded.last_seen)
  WHERE excluded.first_seen<dimension_values.first_seen OR excluded.last_seen>dimension_values.last_seen;
INSERT INTO dimension_values(dimension,has_value,value,first_seen,last_seen)
    SELECT 'actor',NEW.actor IS NOT NULL,COALESCE(NEW.actor,''),NEW.ts,NEW.ts WHERE NEW.actor IS NOT NULL ON CONFLICT(dimension,has_value,value) DO UPDATE SET
  first_seen=MIN(dimension_values.first_seen,excluded.first_seen),last_seen=MAX(dimension_values.last_seen,excluded.last_seen)
  WHERE excluded.first_seen<dimension_values.first_seen OR excluded.last_seen>dimension_values.last_seen;
INSERT INTO dimension_values(dimension,has_value,value,first_seen,last_seen)
    SELECT 'role',NEW.role IS NOT NULL,COALESCE(NEW.role,''),NEW.ts,NEW.ts WHERE NEW.role IS NOT NULL ON CONFLICT(dimension,has_value,value) DO UPDATE SET
  first_seen=MIN(dimension_values.first_seen,excluded.first_seen),last_seen=MAX(dimension_values.last_seen,excluded.last_seen)
  WHERE excluded.first_seen<dimension_values.first_seen OR excluded.last_seen>dimension_values.last_seen;
INSERT INTO dimension_values(dimension,has_value,value,first_seen,last_seen)
    SELECT 'agent',NEW.agent IS NOT NULL,COALESCE(NEW.agent,''),NEW.ts,NEW.ts WHERE NEW.agent IS NOT NULL ON CONFLICT(dimension,has_value,value) DO UPDATE SET
  first_seen=MIN(dimension_values.first_seen,excluded.first_seen),last_seen=MAX(dimension_values.last_seen,excluded.last_seen)
  WHERE excluded.first_seen<dimension_values.first_seen OR excluded.last_seen>dimension_values.last_seen;
INSERT INTO dimension_values(dimension,has_value,value,first_seen,last_seen)
    SELECT 'provider',NEW.provider IS NOT NULL,COALESCE(NEW.provider,''),NEW.ts,NEW.ts WHERE NEW.provider IS NOT NULL ON CONFLICT(dimension,has_value,value) DO UPDATE SET
  first_seen=MIN(dimension_values.first_seen,excluded.first_seen),last_seen=MAX(dimension_values.last_seen,excluded.last_seen)
  WHERE excluded.first_seen<dimension_values.first_seen OR excluded.last_seen>dimension_values.last_seen;
INSERT INTO dimension_values(dimension,has_value,value,first_seen,last_seen)
    SELECT 'model',NEW.model IS NOT NULL,COALESCE(NEW.model,''),NEW.ts,NEW.ts WHERE NEW.model IS NOT NULL ON CONFLICT(dimension,has_value,value) DO UPDATE SET
  first_seen=MIN(dimension_values.first_seen,excluded.first_seen),last_seen=MAX(dimension_values.last_seen,excluded.last_seen)
  WHERE excluded.first_seen<dimension_values.first_seen OR excluded.last_seen>dimension_values.last_seen;
INSERT INTO dimension_values(dimension,has_value,value,first_seen,last_seen)
    SELECT 'requestedModel',NEW.requested_model IS NOT NULL,COALESCE(NEW.requested_model,''),NEW.ts,NEW.ts WHERE NEW.requested_model IS NOT NULL ON CONFLICT(dimension,has_value,value) DO UPDATE SET
  first_seen=MIN(dimension_values.first_seen,excluded.first_seen),last_seen=MAX(dimension_values.last_seen,excluded.last_seen)
  WHERE excluded.first_seen<dimension_values.first_seen OR excluded.last_seen>dimension_values.last_seen;
INSERT INTO dimension_values(dimension,has_value,value,first_seen,last_seen)
    SELECT 'thinking',NEW.thinking IS NOT NULL,COALESCE(NEW.thinking,''),NEW.ts,NEW.ts WHERE NEW.thinking IS NOT NULL ON CONFLICT(dimension,has_value,value) DO UPDATE SET
  first_seen=MIN(dimension_values.first_seen,excluded.first_seen),last_seen=MAX(dimension_values.last_seen,excluded.last_seen)
  WHERE excluded.first_seen<dimension_values.first_seen OR excluded.last_seen>dimension_values.last_seen;
INSERT INTO dimension_values(dimension,has_value,value,first_seen,last_seen)
    SELECT 'run',NEW.run_id IS NOT NULL,COALESCE(NEW.run_id,''),NEW.ts,NEW.ts WHERE NEW.run_id IS NOT NULL ON CONFLICT(dimension,has_value,value) DO UPDATE SET
  first_seen=MIN(dimension_values.first_seen,excluded.first_seen),last_seen=MAX(dimension_values.last_seen,excluded.last_seen)
  WHERE excluded.first_seen<dimension_values.first_seen OR excluded.last_seen>dimension_values.last_seen;
INSERT INTO dimension_values(dimension,has_value,value,first_seen,last_seen)
    SELECT 'runName',NEW.run_name IS NOT NULL,COALESCE(NEW.run_name,''),NEW.ts,NEW.ts WHERE NEW.run_name IS NOT NULL ON CONFLICT(dimension,has_value,value) DO UPDATE SET
  first_seen=MIN(dimension_values.first_seen,excluded.first_seen),last_seen=MAX(dimension_values.last_seen,excluded.last_seen)
  WHERE excluded.first_seen<dimension_values.first_seen OR excluded.last_seen>dimension_values.last_seen;
INSERT INTO dimension_values(dimension,has_value,value,first_seen,last_seen)
    SELECT 'phase',NEW.phase IS NOT NULL,COALESCE(NEW.phase,''),NEW.ts,NEW.ts WHERE NEW.phase IS NOT NULL ON CONFLICT(dimension,has_value,value) DO UPDATE SET
  first_seen=MIN(dimension_values.first_seen,excluded.first_seen),last_seen=MAX(dimension_values.last_seen,excluded.last_seen)
  WHERE excluded.first_seen<dimension_values.first_seen OR excluded.last_seen>dimension_values.last_seen;
INSERT INTO dimension_values(dimension,has_value,value,first_seen,last_seen)
    SELECT 'parentRun',NEW.parent_run_id IS NOT NULL,COALESCE(NEW.parent_run_id,''),NEW.ts,NEW.ts WHERE NEW.parent_run_id IS NOT NULL ON CONFLICT(dimension,has_value,value) DO UPDATE SET
  first_seen=MIN(dimension_values.first_seen,excluded.first_seen),last_seen=MAX(dimension_values.last_seen,excluded.last_seen)
  WHERE excluded.first_seen<dimension_values.first_seen OR excluded.last_seen>dimension_values.last_seen;
INSERT INTO dimension_values(dimension,has_value,value,first_seen,last_seen)
    SELECT 'auxPurpose',NEW.aux_purpose IS NOT NULL,COALESCE(NEW.aux_purpose,''),NEW.ts,NEW.ts WHERE NEW.aux_purpose IS NOT NULL ON CONFLICT(dimension,has_value,value) DO UPDATE SET
  first_seen=MIN(dimension_values.first_seen,excluded.first_seen),last_seen=MAX(dimension_values.last_seen,excluded.last_seen)
  WHERE excluded.first_seen<dimension_values.first_seen OR excluded.last_seen>dimension_values.last_seen;
INSERT INTO dimension_values(dimension,has_value,value,first_seen,last_seen)
    SELECT 'api',NEW.api IS NOT NULL,COALESCE(NEW.api,''),NEW.ts,NEW.ts WHERE NEW.api IS NOT NULL ON CONFLICT(dimension,has_value,value) DO UPDATE SET
  first_seen=MIN(dimension_values.first_seen,excluded.first_seen),last_seen=MAX(dimension_values.last_seen,excluded.last_seen)
  WHERE excluded.first_seen<dimension_values.first_seen OR excluded.last_seen>dimension_values.last_seen;
INSERT INTO dimension_values(dimension,has_value,value,first_seen,last_seen)
    SELECT 'day',strftime('%Y-%m-%d',NEW.ts/1000,'unixepoch') IS NOT NULL,COALESCE(strftime('%Y-%m-%d',NEW.ts/1000,'unixepoch'),''),NEW.ts,NEW.ts WHERE strftime('%Y-%m-%d',NEW.ts/1000,'unixepoch') IS NOT NULL ON CONFLICT(dimension,has_value,value) DO UPDATE SET
  first_seen=MIN(dimension_values.first_seen,excluded.first_seen),last_seen=MAX(dimension_values.last_seen,excluded.last_seen)
  WHERE excluded.first_seen<dimension_values.first_seen OR excluded.last_seen>dimension_values.last_seen;
END;
CREATE TRIGGER selection_shadow_insert AFTER INSERT ON calls BEGIN
  UPDATE calls SET selection_shadowed=EXISTS (SELECT 1 FROM calls prior WHERE prior.fingerprint = calls.fingerprint
  AND (prior.copied,prior.source_file,prior.entry_id,prior.id) < (calls.copied,calls.source_file,calls.entry_id,calls.id))
  WHERE (fingerprint=NEW.fingerprint) AND selection_shadowed IS NOT EXISTS (SELECT 1 FROM calls prior WHERE prior.fingerprint = calls.fingerprint
  AND (prior.copied,prior.source_file,prior.entry_id,prior.id) < (calls.copied,calls.source_file,calls.entry_id,calls.id));
  UPDATE calls SET selection_undercount=(EXISTS (SELECT 1 FROM import_state s WHERE s.path=calls.source_file AND s.offset<s.size)
  OR EXISTS (SELECT 1 FROM incomplete_reports i WHERE i.path=calls.source_file AND i.run_id=calls.run_id)
  OR (calls.is_report=0 AND EXISTS (SELECT 1 FROM runs_meta r WHERE r.id=calls.run_id AND r.ended_at IS NULL)))
  WHERE (id=NEW.id) AND selection_undercount IS NOT (EXISTS (SELECT 1 FROM import_state s WHERE s.path=calls.source_file AND s.offset<s.size)
  OR EXISTS (SELECT 1 FROM incomplete_reports i WHERE i.path=calls.source_file AND i.run_id=calls.run_id)
  OR (calls.is_report=0 AND EXISTS (SELECT 1 FROM runs_meta r WHERE r.id=calls.run_id AND r.ended_at IS NULL)));
END;
CREATE TRIGGER selection_shadow_delete AFTER DELETE ON calls BEGIN
  UPDATE calls SET selection_shadowed=EXISTS (SELECT 1 FROM calls prior WHERE prior.fingerprint = calls.fingerprint
  AND (prior.copied,prior.source_file,prior.entry_id,prior.id) < (calls.copied,calls.source_file,calls.entry_id,calls.id))
  WHERE (fingerprint=OLD.fingerprint) AND selection_shadowed IS NOT EXISTS (SELECT 1 FROM calls prior WHERE prior.fingerprint = calls.fingerprint
  AND (prior.copied,prior.source_file,prior.entry_id,prior.id) < (calls.copied,calls.source_file,calls.entry_id,calls.id));
END;
CREATE TRIGGER selection_shadow_update AFTER UPDATE OF fingerprint,copied,source_file,entry_id ON calls
WHEN OLD.fingerprint IS NOT NEW.fingerprint OR OLD.copied IS NOT NEW.copied OR OLD.source_file IS NOT NEW.source_file OR OLD.entry_id IS NOT NEW.entry_id BEGIN
  UPDATE calls SET selection_shadowed=EXISTS (SELECT 1 FROM calls prior WHERE prior.fingerprint = calls.fingerprint
  AND (prior.copied,prior.source_file,prior.entry_id,prior.id) < (calls.copied,calls.source_file,calls.entry_id,calls.id))
  WHERE (fingerprint=OLD.fingerprint OR fingerprint=NEW.fingerprint) AND selection_shadowed IS NOT EXISTS (SELECT 1 FROM calls prior WHERE prior.fingerprint = calls.fingerprint
  AND (prior.copied,prior.source_file,prior.entry_id,prior.id) < (calls.copied,calls.source_file,calls.entry_id,calls.id));
END;
CREATE TRIGGER selection_call_inputs_update AFTER UPDATE OF source_file,run_id,actor,aggregate ON calls
WHEN OLD.source_file IS NOT NEW.source_file OR OLD.run_id IS NOT NEW.run_id OR OLD.actor IS NOT NEW.actor OR OLD.aggregate IS NOT NEW.aggregate BEGIN
  UPDATE calls SET selection_undercount=(EXISTS (SELECT 1 FROM import_state s WHERE s.path=calls.source_file AND s.offset<s.size)
  OR EXISTS (SELECT 1 FROM incomplete_reports i WHERE i.path=calls.source_file AND i.run_id=calls.run_id)
  OR (calls.is_report=0 AND EXISTS (SELECT 1 FROM runs_meta r WHERE r.id=calls.run_id AND r.ended_at IS NULL)))
  WHERE (id=NEW.id) AND selection_undercount IS NOT (EXISTS (SELECT 1 FROM import_state s WHERE s.path=calls.source_file AND s.offset<s.size)
  OR EXISTS (SELECT 1 FROM incomplete_reports i WHERE i.path=calls.source_file AND i.run_id=calls.run_id)
  OR (calls.is_report=0 AND EXISTS (SELECT 1 FROM runs_meta r WHERE r.id=calls.run_id AND r.ended_at IS NULL)));
END;

CREATE TRIGGER selection_inputs_import_state_insert
AFTER INSERT ON import_state

BEGIN
  UPDATE calls SET selection_undercount=(EXISTS (SELECT 1 FROM import_state s WHERE s.path=calls.source_file AND s.offset<s.size)
  OR EXISTS (SELECT 1 FROM incomplete_reports i WHERE i.path=calls.source_file AND i.run_id=calls.run_id)
  OR (calls.is_report=0 AND EXISTS (SELECT 1 FROM runs_meta r WHERE r.id=calls.run_id AND r.ended_at IS NULL)))
  WHERE (source_file=NEW.path) AND selection_undercount IS NOT (EXISTS (SELECT 1 FROM import_state s WHERE s.path=calls.source_file AND s.offset<s.size)
  OR EXISTS (SELECT 1 FROM incomplete_reports i WHERE i.path=calls.source_file AND i.run_id=calls.run_id)
  OR (calls.is_report=0 AND EXISTS (SELECT 1 FROM runs_meta r WHERE r.id=calls.run_id AND r.ended_at IS NULL)));
END;

CREATE TRIGGER selection_inputs_import_state_delete
AFTER DELETE ON import_state

BEGIN
  UPDATE calls SET selection_undercount=(EXISTS (SELECT 1 FROM import_state s WHERE s.path=calls.source_file AND s.offset<s.size)
  OR EXISTS (SELECT 1 FROM incomplete_reports i WHERE i.path=calls.source_file AND i.run_id=calls.run_id)
  OR (calls.is_report=0 AND EXISTS (SELECT 1 FROM runs_meta r WHERE r.id=calls.run_id AND r.ended_at IS NULL)))
  WHERE (source_file=OLD.path) AND selection_undercount IS NOT (EXISTS (SELECT 1 FROM import_state s WHERE s.path=calls.source_file AND s.offset<s.size)
  OR EXISTS (SELECT 1 FROM incomplete_reports i WHERE i.path=calls.source_file AND i.run_id=calls.run_id)
  OR (calls.is_report=0 AND EXISTS (SELECT 1 FROM runs_meta r WHERE r.id=calls.run_id AND r.ended_at IS NULL)));
END;

CREATE TRIGGER selection_inputs_import_state_update
AFTER UPDATE OF path,offset,size ON import_state
WHEN OLD.path IS NOT NEW.path OR (OLD.offset<OLD.size) IS NOT (NEW.offset<NEW.size)
BEGIN
  UPDATE calls SET selection_undercount=(EXISTS (SELECT 1 FROM import_state s WHERE s.path=calls.source_file AND s.offset<s.size)
  OR EXISTS (SELECT 1 FROM incomplete_reports i WHERE i.path=calls.source_file AND i.run_id=calls.run_id)
  OR (calls.is_report=0 AND EXISTS (SELECT 1 FROM runs_meta r WHERE r.id=calls.run_id AND r.ended_at IS NULL)))
  WHERE ((source_file=OLD.path) OR (source_file=NEW.path)) AND selection_undercount IS NOT (EXISTS (SELECT 1 FROM import_state s WHERE s.path=calls.source_file AND s.offset<s.size)
  OR EXISTS (SELECT 1 FROM incomplete_reports i WHERE i.path=calls.source_file AND i.run_id=calls.run_id)
  OR (calls.is_report=0 AND EXISTS (SELECT 1 FROM runs_meta r WHERE r.id=calls.run_id AND r.ended_at IS NULL)));
END;

CREATE TRIGGER selection_inputs_incomplete_reports_insert
AFTER INSERT ON incomplete_reports

BEGIN
  UPDATE calls SET selection_undercount=(EXISTS (SELECT 1 FROM import_state s WHERE s.path=calls.source_file AND s.offset<s.size)
  OR EXISTS (SELECT 1 FROM incomplete_reports i WHERE i.path=calls.source_file AND i.run_id=calls.run_id)
  OR (calls.is_report=0 AND EXISTS (SELECT 1 FROM runs_meta r WHERE r.id=calls.run_id AND r.ended_at IS NULL)))
  WHERE (source_file=NEW.path AND run_id=NEW.run_id) AND selection_undercount IS NOT (EXISTS (SELECT 1 FROM import_state s WHERE s.path=calls.source_file AND s.offset<s.size)
  OR EXISTS (SELECT 1 FROM incomplete_reports i WHERE i.path=calls.source_file AND i.run_id=calls.run_id)
  OR (calls.is_report=0 AND EXISTS (SELECT 1 FROM runs_meta r WHERE r.id=calls.run_id AND r.ended_at IS NULL)));
END;

CREATE TRIGGER selection_inputs_incomplete_reports_delete
AFTER DELETE ON incomplete_reports

BEGIN
  UPDATE calls SET selection_undercount=(EXISTS (SELECT 1 FROM import_state s WHERE s.path=calls.source_file AND s.offset<s.size)
  OR EXISTS (SELECT 1 FROM incomplete_reports i WHERE i.path=calls.source_file AND i.run_id=calls.run_id)
  OR (calls.is_report=0 AND EXISTS (SELECT 1 FROM runs_meta r WHERE r.id=calls.run_id AND r.ended_at IS NULL)))
  WHERE (source_file=OLD.path AND run_id=OLD.run_id) AND selection_undercount IS NOT (EXISTS (SELECT 1 FROM import_state s WHERE s.path=calls.source_file AND s.offset<s.size)
  OR EXISTS (SELECT 1 FROM incomplete_reports i WHERE i.path=calls.source_file AND i.run_id=calls.run_id)
  OR (calls.is_report=0 AND EXISTS (SELECT 1 FROM runs_meta r WHERE r.id=calls.run_id AND r.ended_at IS NULL)));
END;

CREATE TRIGGER selection_inputs_incomplete_reports_update
AFTER UPDATE OF path,run_id ON incomplete_reports
WHEN OLD.path IS NOT NEW.path OR OLD.run_id IS NOT NEW.run_id
BEGIN
  UPDATE calls SET selection_undercount=(EXISTS (SELECT 1 FROM import_state s WHERE s.path=calls.source_file AND s.offset<s.size)
  OR EXISTS (SELECT 1 FROM incomplete_reports i WHERE i.path=calls.source_file AND i.run_id=calls.run_id)
  OR (calls.is_report=0 AND EXISTS (SELECT 1 FROM runs_meta r WHERE r.id=calls.run_id AND r.ended_at IS NULL)))
  WHERE ((source_file=OLD.path AND run_id=OLD.run_id) OR (source_file=NEW.path AND run_id=NEW.run_id)) AND selection_undercount IS NOT (EXISTS (SELECT 1 FROM import_state s WHERE s.path=calls.source_file AND s.offset<s.size)
  OR EXISTS (SELECT 1 FROM incomplete_reports i WHERE i.path=calls.source_file AND i.run_id=calls.run_id)
  OR (calls.is_report=0 AND EXISTS (SELECT 1 FROM runs_meta r WHERE r.id=calls.run_id AND r.ended_at IS NULL)));
END;

CREATE TRIGGER selection_inputs_runs_meta_insert
AFTER INSERT ON runs_meta

BEGIN
  UPDATE calls SET selection_undercount=(EXISTS (SELECT 1 FROM import_state s WHERE s.path=calls.source_file AND s.offset<s.size)
  OR EXISTS (SELECT 1 FROM incomplete_reports i WHERE i.path=calls.source_file AND i.run_id=calls.run_id)
  OR (calls.is_report=0 AND EXISTS (SELECT 1 FROM runs_meta r WHERE r.id=calls.run_id AND r.ended_at IS NULL)))
  WHERE (run_id=NEW.id) AND selection_undercount IS NOT (EXISTS (SELECT 1 FROM import_state s WHERE s.path=calls.source_file AND s.offset<s.size)
  OR EXISTS (SELECT 1 FROM incomplete_reports i WHERE i.path=calls.source_file AND i.run_id=calls.run_id)
  OR (calls.is_report=0 AND EXISTS (SELECT 1 FROM runs_meta r WHERE r.id=calls.run_id AND r.ended_at IS NULL)));
END;

CREATE TRIGGER selection_inputs_runs_meta_delete
AFTER DELETE ON runs_meta

BEGIN
  UPDATE calls SET selection_undercount=(EXISTS (SELECT 1 FROM import_state s WHERE s.path=calls.source_file AND s.offset<s.size)
  OR EXISTS (SELECT 1 FROM incomplete_reports i WHERE i.path=calls.source_file AND i.run_id=calls.run_id)
  OR (calls.is_report=0 AND EXISTS (SELECT 1 FROM runs_meta r WHERE r.id=calls.run_id AND r.ended_at IS NULL)))
  WHERE (run_id=OLD.id) AND selection_undercount IS NOT (EXISTS (SELECT 1 FROM import_state s WHERE s.path=calls.source_file AND s.offset<s.size)
  OR EXISTS (SELECT 1 FROM incomplete_reports i WHERE i.path=calls.source_file AND i.run_id=calls.run_id)
  OR (calls.is_report=0 AND EXISTS (SELECT 1 FROM runs_meta r WHERE r.id=calls.run_id AND r.ended_at IS NULL)));
END;

CREATE TRIGGER selection_inputs_runs_meta_update
AFTER UPDATE OF id,ended_at ON runs_meta
WHEN OLD.id IS NOT NEW.id OR (OLD.ended_at IS NULL) IS NOT (NEW.ended_at IS NULL)
BEGIN
  UPDATE calls SET selection_undercount=(EXISTS (SELECT 1 FROM import_state s WHERE s.path=calls.source_file AND s.offset<s.size)
  OR EXISTS (SELECT 1 FROM incomplete_reports i WHERE i.path=calls.source_file AND i.run_id=calls.run_id)
  OR (calls.is_report=0 AND EXISTS (SELECT 1 FROM runs_meta r WHERE r.id=calls.run_id AND r.ended_at IS NULL)))
  WHERE ((run_id=OLD.id) OR (run_id=NEW.id)) AND selection_undercount IS NOT (EXISTS (SELECT 1 FROM import_state s WHERE s.path=calls.source_file AND s.offset<s.size)
  OR EXISTS (SELECT 1 FROM incomplete_reports i WHERE i.path=calls.source_file AND i.run_id=calls.run_id)
  OR (calls.is_report=0 AND EXISTS (SELECT 1 FROM runs_meta r WHERE r.id=calls.run_id AND r.ended_at IS NULL)));
END;
CREATE TRIGGER selection_revision_stored_update AFTER UPDATE OF selection_shadowed,selection_undercount ON calls
WHEN OLD.selection_shadowed IS NOT NEW.selection_shadowed OR OLD.selection_undercount IS NOT NEW.selection_undercount BEGIN
  INSERT INTO ledger_metadata(key,value) VALUES ('call-selection-revision','1')
    ON CONFLICT(key) DO UPDATE SET value=CAST(ledger_metadata.value AS INTEGER)+1;
END;

PRAGMA user_version = 3;

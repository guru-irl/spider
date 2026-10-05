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

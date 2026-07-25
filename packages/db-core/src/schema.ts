// Canonical two-tier schema — column/table names are canonical (plans/README.md).
// Do not rename. `vectors` (vec0) is created at runtime by Db.loadVec(), not here.

export const GLOBAL_SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  project_key     TEXT PRIMARY KEY,
  real_path       TEXT NOT NULL,
  git_common_dir  TEXT,
  db_path         TEXT NOT NULL,
  name            TEXT,
  created_at      INTEGER NOT NULL,
  last_seen_at    INTEGER NOT NULL,
  session_count   INTEGER NOT NULL DEFAULT 0,
  memory_count    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS global_memory (
  id INTEGER PRIMARY KEY, uuid TEXT UNIQUE NOT NULL,
  category TEXT NOT NULL, content TEXT NOT NULL, link TEXT,
  scope TEXT NOT NULL DEFAULT 'global',
  status TEXT NOT NULL DEFAULT 'active',
  source TEXT NOT NULL DEFAULT 'user',
  confidence REAL, created_at INTEGER NOT NULL, updated_at INTEGER
);

CREATE TABLE IF NOT EXISTS upstream_refs (
  package TEXT PRIMARY KEY,
  upstream_repo TEXT NOT NULL, upstream_ref TEXT,
  last_reviewed_commit TEXT, last_checked_at INTEGER, notes TEXT
);

CREATE TABLE IF NOT EXISTS message_mirror (
  id INTEGER PRIMARY KEY, from_session TEXT, to_session TEXT,
  kind TEXT, body TEXT, created_at INTEGER NOT NULL,
  delivered_at INTEGER, read_at INTEGER
);

CREATE TABLE IF NOT EXISTS insights (
  id INTEGER PRIMARY KEY, kind TEXT NOT NULL,
  a TEXT, b TEXT, weight REAL, payload TEXT, created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS model_stats (
  id INTEGER PRIMARY KEY, model TEXT NOT NULL, ms INTEGER, ok INTEGER, tokens INTEGER, ts INTEGER NOT NULL
);
`;

export const PROJECT_SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  parent_session_id TEXT,
  name TEXT,
  reason TEXT,
  started_at INTEGER NOT NULL, ended_at INTEGER,
  summary TEXT, imported_from TEXT
);
CREATE VIRTUAL TABLE IF NOT EXISTS sessions_fts USING fts5(id UNINDEXED, name, summary, content);

CREATE TABLE IF NOT EXISTS memory (
  id INTEGER PRIMARY KEY, uuid TEXT UNIQUE NOT NULL,
  category TEXT NOT NULL,
  content TEXT NOT NULL, link TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  source TEXT NOT NULL DEFAULT 'user',
  confidence REAL, session_id TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER
);
CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(uuid UNINDEXED, category, content, link);

CREATE TABLE IF NOT EXISTS content (
  id INTEGER PRIMARY KEY, source TEXT NOT NULL, path TEXT, hash TEXT,
  heading TEXT, chunk TEXT NOT NULL, is_code INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS content_fts USING fts5(source, heading, chunk);

CREATE TABLE IF NOT EXISTS todos (
  id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, seq INTEGER NOT NULL,
  text TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER
);
CREATE VIRTUAL TABLE IF NOT EXISTS todos_fts USING fts5(text, content=todos, content_rowid=id);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, parent_run_id TEXT,
  agent TEXT NOT NULL, role TEXT, name TEXT,
  status TEXT NOT NULL,
  phase TEXT, model TEXT, task TEXT, thinking TEXT,
  started_at INTEGER, ended_at INTEGER,
  step_count INTEGER DEFAULT 0, token_count INTEGER DEFAULT 0,
  result TEXT,
  pid INTEGER, host_pid INTEGER
);
CREATE TABLE IF NOT EXISTS run_events (
  id INTEGER PRIMARY KEY, run_id TEXT, session_id TEXT NOT NULL,
  ts INTEGER NOT NULL, type TEXT NOT NULL,
  tool TEXT, summary TEXT, payload TEXT
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, ts INTEGER NOT NULL,
  phase TEXT NOT NULL,
  tool TEXT NOT NULL, description TEXT, added INTEGER, removed INTEGER,
  flagged TEXT, payload TEXT
);

CREATE TABLE IF NOT EXISTS vector_map (
  rowid INTEGER PRIMARY KEY, owner_kind TEXT NOT NULL,
  owner_id TEXT NOT NULL, model TEXT NOT NULL, dim INTEGER NOT NULL,
  embedding BLOB   -- raw little-endian float32[dim]; brute-force cosine + reembed source
);
CREATE TABLE IF NOT EXISTS embed_queue (
  id INTEGER PRIMARY KEY, owner_kind TEXT NOT NULL, owner_id TEXT NOT NULL,
  text TEXT NOT NULL, enqueued_at INTEGER NOT NULL, tries INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS skills (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE,
  tier TEXT NOT NULL DEFAULT 'project',
  category TEXT, path TEXT,
  state TEXT NOT NULL DEFAULT 'active',
  status TEXT NOT NULL DEFAULT 'active',
  source TEXT NOT NULL DEFAULT 'user',
  pinned INTEGER NOT NULL DEFAULT 0, protected INTEGER NOT NULL DEFAULT 0,
  use_count INTEGER NOT NULL DEFAULT 0, view_count INTEGER NOT NULL DEFAULT 0, patch_count INTEGER NOT NULL DEFAULT 0,
  last_used_at INTEGER, last_viewed_at INTEGER, last_patched_at INTEGER,
  candidate_body TEXT,
  related TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_skills_state ON skills(state, status);
CREATE TABLE IF NOT EXISTS curator_state (
  scope TEXT PRIMARY KEY,
  last_run_at INTEGER, paused INTEGER NOT NULL DEFAULT 0
);
`;

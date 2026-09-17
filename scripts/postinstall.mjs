#!/usr/bin/env node
// spider postinstall — native self-check + best-effort global DB file bootstrap.
// Best-effort: never block a contributor/CI install; print diagnostics to stderr.
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

const require = createRequire(import.meta.url);
const warn = (m) => process.stderr.write(`spider postinstall: ${m}\n`);

// ── Node floor (cosmetic engines field is not enforced by default) ──
{
  const [maj, min] = (process.versions.node ?? "0.0.0").split(".").map(Number);
  const ok = maj > 22 || (maj === 22 && min >= 19);
  if (!ok) warn(`Node ${process.versions.node} < 22.19.0 — spider requires >= 22.19.0 (target 24).`);
}

// ── 1. better-sqlite3 loads + opens ──
let Database = null;
try {
  const mod = require("better-sqlite3");
  Database = mod.default ?? mod;
  const probe = new Database(":memory:");
  probe.exec("CREATE TABLE t (x)"); probe.close();
  warn("better-sqlite3 OK");
} catch (e) {
  warn(`better-sqlite3 FAILED: ${e.message} (native prebuild missing — run 'npm rebuild better-sqlite3')`);
}

// ── 2. sqlite-vec loads a vec0 table ──
try {
  if (Database) {
    const vec = require("sqlite-vec");
    const db = new Database(":memory:");
    db.loadExtension(vec.getLoadablePath());
    db.exec("CREATE VIRTUAL TABLE v USING vec0(embedding float[384])");
    db.close();
    warn("sqlite-vec OK (vec0 float[384])");
  }
} catch (e) {
  warn(`sqlite-vec FAILED: ${e.message} (vector search will degrade to FTS-only)`);
}

// ── 3. Best-effort global DB file bootstrap (no schema) ──
try {
  const root = join(homedir(), ".pi", "agent", "spider");
  mkdirSync(root, { recursive: true });
  if (Database) {
    const db = new Database(join(root, "spider.db"), { timeout: 30000 });
    db.pragma("journal_mode = WAL");
    // DDL must never live in postinstall. db-core.migrate() is the single schema
    // owner; even an idempotent-looking CREATE TABLE can preserve a partial table
    // and then cause db-core to stamp that malformed schema as current.
    db.close();
    warn("global DB file ready (schema deferred to db-core)");
  } else {
    warn("global DB directory ready (database unavailable)");
  }
} catch (e) {
  warn(`global DB file bootstrap skipped: ${e.message}`);
}

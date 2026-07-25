// packages/host/src/control/migrate-cmd.ts
import { existsSync, mkdirSync, copyFileSync, readdirSync, statSync, readFileSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import { openDbAt, paths, repoRoot, projectRoot } from "@spider/db-core";
import type { Db } from "@spider/db-core";
import DatabaseConstructor from "better-sqlite3";

export interface MigrateOptions {
  dryRun?: boolean;
  apply?: boolean;
  cwd: string;
}

export interface MigrateResult {
  dryRun: boolean;
  applied: boolean;
  backupDir?: string;
  moved?: Record<string, number>;
  wouldMove?: Record<string, number>;
  ambiguous?: Array<{ table: string; uuid: string; reason: string }>;
  message?: string;
}

/** Repo-tier tables that should be in repo.db (C3: removed vector_map, embed_queue - those are worktree-tier) */
const REPO_TABLES = ["memory", "memory_fts", "skills", "curator_state"];

/** Worktree-tier tables that should be in project.db */
const WORKTREE_TABLES = ["sessions", "sessions_fts", "content", "content_fts", "todos", "todos_fts", 
                         "runs", "run_events", "events", "vector_map", "embed_queue"];

interface DbFile {
  path: string;
  worktreeRoot: string;
  repoRoot?: string;
}

/** Find all old-style project.db files that need migration */
function findOldDbs(cwd: string): DbFile[] {
  const dbs: DbFile[] = [];
  const wtRoot = dirname(projectRoot(cwd)); // projectRoot returns path/.spider, we need path
  const rRoot = repoRoot(cwd);
  
  // Check the current worktree
  const currentDb = join(wtRoot, ".spider", "project.db");
  if (existsSync(currentDb)) {
    dbs.push({ path: currentDb, worktreeRoot: wtRoot, repoRoot: rRoot });
  }
  
  // I2: For git repos, enumerate sibling worktrees
  if (rRoot) {
    const gitCommonDir = rRoot.replace(/\/spider$/, "");
    const worktreesPath = join(gitCommonDir, "worktrees");
    
    if (existsSync(worktreesPath)) {
      const entries = readdirSync(worktreesPath);
      for (const entry of entries) {
        const gitdirPath = join(worktreesPath, entry, "gitdir");
        if (existsSync(gitdirPath)) {
          try {
            // Read the gitdir file to find the worktree root
            // It contains something like "/path/to/worktree/.git"
            const gitdirContent = readFileSync(gitdirPath, "utf-8").trim();
            // Remove trailing /.git to get the worktree root
            const siblingWtRoot = gitdirContent.replace(/\/\.git$/, "");
            
            if (siblingWtRoot !== wtRoot) {
              const siblingDb = join(siblingWtRoot, ".spider", "project.db");
              if (existsSync(siblingDb)) {
                dbs.push({ path: siblingDb, worktreeRoot: siblingWtRoot, repoRoot: rRoot });
              }
            }
          } catch (err) {
            // Skip worktrees we can't read
          }
        }
      }
    }
  }
  
  return dbs;
}

/** Check if a DB has already been migrated (has new schema) - I4: read-only check */
function isAlreadyMigrated(dbPath: string): boolean {
  if (!existsSync(dbPath)) return true; // doesn't exist = nothing to migrate
  
  // I4: Open read-only to avoid modifying the DB
  const db = new DatabaseConstructor(dbPath, { readonly: true, fileMustExist: true });
  try {
    // Check if it has BOTH repo and worktree tables (old schema) or only one type (new schema)
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
    const tableNames = new Set(tables.map(t => t.name));
    
    const hasRepoTables = REPO_TABLES.some(t => tableNames.has(t) && t !== "memory_fts"); // memory_fts is virtual, may not exist yet
    const hasWorktreeTables = WORKTREE_TABLES.some(t => tableNames.has(t));
    
    // If it has both types, it's not migrated yet
    // If it has only one type or neither, it's either already migrated or empty
    const result = !(hasRepoTables && hasWorktreeTables);
    return result;
  } finally {
    db.close();
  }
}

/** Create a backup of all DBs before migration */
function createBackup(dbFiles: DbFile[]): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").split("T").join("_").split("Z")[0];
  const backupDir = join(paths.globalRoot, "backups", timestamp);
  mkdirSync(backupDir, { recursive: true });
  
  for (const dbFile of dbFiles) {
    // Use the dbFile.path to create a safe filename
    const backupName = dbFile.path.replace(/\//g, "_").replace(/^_+/, "");
    copyFileSync(dbFile.path, join(backupDir, backupName));
  }
  
  return backupDir;
}

/** Count rows in a table */
function countRows(db: Db | DatabaseConstructor.Database, table: string): number {
  try {
    const result = db.prepare(`SELECT COUNT(*) as n FROM ${table}`).get() as { n: number } | undefined;
    return result?.n ?? 0;
  } catch {
    return 0;
  }
}

/** Analyze what would be moved (I4: read-only analysis) */
function analyzeMove(dbFile: DbFile): Record<string, number> {
  const counts: Record<string, number> = {};
  
  // I4: Open read-only
  const db = new DatabaseConstructor(dbFile.path, { readonly: true, fileMustExist: true });
  
  try {
    for (const table of REPO_TABLES) {
      if (table === "memory_fts") continue; // Virtual table, will be rebuilt
      const count = countRows(db, table);
      if (count > 0) {
        counts[table] = count;
      }
    }
  } finally {
    db.close();
  }
  
  return counts;
}

/** Perform the actual migration */
function migrateDb(dbFile: DbFile, dryRun: boolean): { moved: Record<string, number>; ambiguous: Array<{ table: string; uuid: string; reason: string }> } {
  const moved: Record<string, number> = {};
  const ambiguous: Array<{ table: string; uuid: string; reason: string }> = [];
  
  if (dryRun) {
    // Just analyze, don't actually move (C3: ensure dry-run and apply agree)
    return { moved: analyzeMove(dbFile), ambiguous };
  }
  
  // Skip if already migrated
  if (isAlreadyMigrated(dbFile.path)) {
    return { moved, ambiguous };
  }
  
  const srcDb = openDbAt(dbFile.path, "worktree");
  
  try {
    // Create repo DB if needed
    if (dbFile.repoRoot) {
      mkdirSync(dbFile.repoRoot, { recursive: true });
      const repoDbPath = join(dbFile.repoRoot, "repo.db");
      
      // C2: Open with "repo" scope so it gets REPO_SCHEMA (includes memory_fts)
      const repoDb = openDbAt(repoDbPath, "repo");
      
      try {
        // I5: Use transaction for atomicity
        repoDb.exec("BEGIN TRANSACTION");
        
        try {
          // Move repo-tier tables
          for (const table of ["memory", "skills", "curator_state"]) {
            const count = countRows(srcDb, table);
            if (count > 0) {
              // Copy rows to repo DB
              const rows = srcDb.prepare(`SELECT * FROM ${table}`).all();
              
              for (const row of rows) {
                const rowData = row as Record<string, unknown>;
                // Check for conflicts before inserting
                let conflict = false;
                let conflictUuid = "";
                
                if (table === "memory" && "uuid" in rowData) {
                  const existing = repoDb.prepare("SELECT uuid FROM memory WHERE uuid = ?").get(String(rowData.uuid));
                  if (existing) {
                    conflict = true;
                    conflictUuid = String(rowData.uuid);
                  }
                } else if (table === "skills" && "name" in rowData) {
                  const existing = repoDb.prepare("SELECT name FROM skills WHERE name = ?").get(String(rowData.name));
                  if (existing) {
                    conflict = true;
                    conflictUuid = String(rowData.name);
                  }
                } else if (table === "curator_state" && "scope" in rowData) {
                  const existing = repoDb.prepare("SELECT scope FROM curator_state WHERE scope = ?").get(String(rowData.scope));
                  if (existing) {
                    conflict = true;
                    conflictUuid = String(rowData.scope);
                  }
                }
                
                // I5: Report ALL conflicts, not just memory
                if (conflict) {
                  ambiguous.push({
                    table,
                    uuid: conflictUuid,
                    reason: "Duplicate key found across worktrees",
                  });
                } else {
                  // Build INSERT - exclude 'id' column to let SQLite auto-generate it
                  const cols = Object.keys(rowData).filter(k => k !== "id");
                  const values = cols.map(k => rowData[k]);
                  const placeholders = cols.map(() => "?").join(", ");
                  const sql = `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${placeholders})`;
                  repoDb.prepare(sql).run(...values);
                }
              }
              
              moved[table] = count;
            }
          }
          
          // C3: Rebuild memory_fts from memory table
          const memoryRows = repoDb.prepare("SELECT uuid, category, content, link FROM memory").all();
          for (const row of memoryRows) {
            const r = row as { uuid: string; category: string; content: string; link: string | null };
            repoDb.prepare("INSERT INTO memory_fts (uuid, category, content, link) VALUES (?, ?, ?, ?)").run(
              r.uuid, r.category, r.content, r.link
            );
          }
          
          repoDb.exec("COMMIT");
        } catch (err) {
          repoDb.exec("ROLLBACK");
          throw err;
        }
      } finally {
        repoDb.close();
      }
      
      // I5: Now drop from source DB in a transaction (after successful copy)
      srcDb.exec("BEGIN TRANSACTION");
      try {
        for (const table of ["memory", "skills", "curator_state"]) {
          const count = countRows(srcDb, table);
          if (count > 0) {
            srcDb.exec(`DROP TABLE IF EXISTS ${table}`);
            // Also drop memory_fts if memory was dropped
            if (table === "memory") {
              srcDb.exec(`DROP TABLE IF EXISTS memory_fts`);
            }
          }
        }
        srcDb.exec("COMMIT");
      } catch (err) {
        srcDb.exec("ROLLBACK");
        throw err;
      }
    }
  } finally {
    srcDb.close();
  }
  
  return { moved, ambiguous };
}

export function controlMigrate(opts: MigrateOptions): MigrateResult {
  const dryRun = opts.dryRun ?? !opts.apply;
  
  // Find DBs to migrate
  const dbFiles = findOldDbs(opts.cwd);
  
  if (dbFiles.length === 0) {
    return {
      dryRun,
      applied: false,
      message: "No databases found to migrate",
    };
  }
  
  // Check if already migrated
  const needsMigration = dbFiles.filter(db => {
    const needs = !isAlreadyMigrated(db.path);
    return needs;
  });
  
  if (needsMigration.length === 0) {
    return {
      dryRun,
      applied: false,
      message: "All databases are already migrated (no changes needed)",
    };
  }
  
  // Create backup before making changes (only if applying)
  let backupDir: string | undefined;
  if (!dryRun) {
    backupDir = createBackup(needsMigration);
  }
  
  // Perform migration
  const allMoved: Record<string, number> = {};
  const allAmbiguous: Array<{ table: string; uuid: string; reason: string }> = [];
  
  for (const dbFile of needsMigration) {
    const result = migrateDb(dbFile, dryRun);
    
    // Aggregate counts
    for (const [table, count] of Object.entries(result.moved)) {
      allMoved[table] = (allMoved[table] ?? 0) + count;
    }
    
    allAmbiguous.push(...result.ambiguous);
  }
  
  return {
    dryRun,
    applied: !dryRun,
    backupDir,
    moved: dryRun ? undefined : allMoved,
    wouldMove: dryRun ? allMoved : undefined,
    ambiguous: allAmbiguous.length > 0 ? allAmbiguous : undefined,
  };
}

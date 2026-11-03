import Database from "better-sqlite3";
import { join } from "node:path";
import type { UsageRoots } from "../../discovery.js";

/** Many registered roots share one run database; no transcript files are needed. */
export function createCandidateHistory(root: string, runCount = 2000, rootCount = 100): UsageRoots {
  const registryDb = join(root, "registry.db"), projectDb = join(root, "runs.db");
  const registry = new Database(registryDb);
  try {
    registry.exec("CREATE TABLE projects(project_key TEXT,db_path TEXT)");
    const insert = registry.prepare("INSERT INTO projects VALUES (?,?)");
    registry.transaction(() => {
      for (let i = 0; i < rootCount; i++) insert.run(join(root, `registered-project-${"x".repeat(32)}-${String(i).padStart(4, "0")}`), projectDb);
    })();
  } finally { registry.close(); }
  const db = new Database(projectDb);
  try {
    db.exec("CREATE TABLE runs(id TEXT)");
    const insert = db.prepare("INSERT INTO runs VALUES (?)");
    db.transaction(() => {
      for (let i = 0; i < runCount; i++) insert.run(`run-${String(i).padStart(7, "0")}-abcdef`);
    })();
  } finally { db.close(); }
  return { registryDb, sessionsDir: join(root, "sessions"), ledgerFile: join(root, "usage.db"),
    authPath: join(root, "absent-auth.json"), leaseDir: join(root, "leases") };
}

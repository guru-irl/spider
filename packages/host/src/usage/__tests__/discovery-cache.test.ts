import * as fs from "node:fs/promises";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, expect, it, vi } from "vitest";
import { discoverUsageSources } from "../discovery.js";
vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof fs>(); return { ...actual, open: vi.fn(actual.open) };
});
let root: string;
afterEach(() => { vi.restoreAllMocks(); if (root) rmSync(root, { recursive: true, force: true }); });
it("discovery stat-checks cached attribution heads before any open and refreshes changed headers", async () => {
  root = mkdtempSync(join(process.env.SPIDER_GLOBAL_ROOT!, "discovery-cache-"));
  const roots = { sessionsDir: join(root, "sessions"), registryDb: join(root, "registry.db"), ledgerFile: join(root, "usage.db"), authPath: join(root, "missing-auth"), leaseDir: join(root, "leases") };
  mkdirSync(join(roots.sessionsDir, "fixture"), { recursive: true });
  const source = join(roots.sessionsDir, "fixture", "session.jsonl");
  const header = (cwd: string) => JSON.stringify({ type: "session", id: "session", cwd }) + "\n";
  writeFileSync(source, header(join(root, "project")));
  const db = new Database(roots.registryDb);
  try { db.exec("CREATE TABLE projects(project_key TEXT, db_path TEXT, repo_key TEXT, scratch_root TEXT)"); db.prepare("INSERT INTO projects VALUES (?,?,?,?)").run(join(root, "project"), join(root, "missing.db"), null, join(root, "scratch")); } finally { db.close(); }
  await discoverUsageSources(roots);
  vi.mocked(fs.open).mockClear();
  const again = await discoverUsageSources(roots);
  expect(fs.open).not.toHaveBeenCalled(); expect(again.sources[0].project).toBe(join(root, "project"));
  writeFileSync(source, header(join(root, "elsewhere")));
  const changed = await discoverUsageSources(roots);
  expect(fs.open).toHaveBeenCalledTimes(1); expect(changed.sources[0].project).toBeNull();
});

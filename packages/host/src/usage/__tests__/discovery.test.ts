import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { openDbReadOnly } from "@spider/db-core";

let root: string;
let discover: typeof import("../discovery.js").discoverUsageSources;
function db(file: string, sql: string) {
  mkdirSync(dirname(file), { recursive: true });
  const d = new Database(file); d.exec(sql); d.close();
}
function touch(file: string) { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, ""); }
function roots() { return { registryDb: join(root, "registry.db"), sessionsDir: join(root, "sessions"), ledgerFile: join(root, "usage.db"), authPath: join(root, "unused-auth.json"), leaseDir: join(root, "lease") }; }
function registry(rows: string) { db(roots().registryDb, `CREATE TABLE projects(project_key TEXT,real_path TEXT,repo_key TEXT,db_path TEXT); INSERT INTO projects VALUES ${rows};`); }
function runs(file: string, id: string) { db(file, `CREATE TABLE runs(id TEXT,session_id TEXT,agent TEXT,status TEXT,ended_at INTEGER); INSERT INTO runs VALUES ('${id}','owner',NULL,'done',42);`); }
beforeEach(async () => { root = mkdtempSync(join(process.env.SPIDER_GLOBAL_ROOT!, "usage-discovery-")); ({ discoverUsageSources: discover } = await import("../discovery.js")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

it("lists only session directories and registry-derived runs", async () => {
  const project = join(root, "project"), repo = join(root, "common"), projectDb = join(project, ".spider/project.db"), repoDb = join(repo, "spider/repo.db");
  registry(`('${project}','${project}','${repo}','${projectDb}')`); runs(projectDb, "work"); runs(repoDb, "repo");
  const parent = join(roots().sessionsDir, "encoded", "parent.jsonl"); touch(parent); touch(join(roots().sessionsDir, "ignored.jsonl"));
  const work = join(project, ".spider/scratch/subagent-sessions/work/work.jsonl"), child = join(project, ".spider/scratch/subagent-sessions/repo/repo.jsonl"); touch(work); touch(child);
  const result = await discover(roots());
  expect(result.sources.map(s => s.path).sort()).toEqual([parent, work, child].sort());
  expect(result.sources.find(s => s.path === child)).toMatchObject({ project, repo, run: { id: "repo", sessionId: "owner", agent: null } });
  expect(result.runs).toHaveLength(2);
});
it("does not scan repositories or migrate source DBs", async () => {
  const project = join(root, "project"), file = join(project, ".spider/project.db"); registry(`('${project}','${project}',NULL,'${file}')`); runs(file, "child");
  touch(join(roots().sessionsDir, "encoded", "p.jsonl"));
  const opened: string[] = [], listed: string[] = [];
  const result = await discover(roots(), { openDb: p => { opened.push(p); const d = openDbReadOnly(p); if (d) expect(d.raw.readonly).toBe(true); return d; }, readdir: async p => { listed.push(p); return fs.readdir(p, { withFileTypes: true }); } });
  expect(opened.sort()).toEqual([roots().registryDb, file].sort());
  expect(listed.sort()).toEqual([roots().sessionsDir, join(roots().sessionsDir, "encoded"), join(project, ".spider/scratch/subagent-sessions")].sort());
  const d = new Database(file, { readonly: true }); expect(d.pragma("user_version", { simple: true })).toBe(0); expect(d.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()).toEqual([{ name: "runs" }]); d.close();
  expect(result.errors.some(e => e.code === "missing-source")).toBe(true);
});
it("deduplicates shared repo registrations and canonical source paths", async () => {
  const p = join(root, "project"), alias = join(root, "alias"), repo = join(root, "common"), file = join(p, ".spider/project.db"); runs(file, "work"); runs(join(repo, "spider/repo.db"), "repo"); symlinkSync(p, alias);
  registry(`('${p}','${p}','${repo}','${file}'),('${alias}','${alias}','${repo}','${join(alias, ".spider/project.db")}')`);
  touch(join(p, ".spider/scratch/subagent-sessions/repo/repo.jsonl")); touch(join(p, ".spider/scratch/subagent-sessions/work/work.jsonl"));
  mkdirSync(join(roots().sessionsDir, "encoded"), { recursive: true }); touch(join(roots().sessionsDir, "encoded/p.jsonl")); symlinkSync(join(roots().sessionsDir, "encoded"), join(roots().sessionsDir, "alias"));
  const opened: string[] = [];
  const result = await discover(roots(), { openDb: p => { opened.push(p); return openDbReadOnly(p); } });
  expect(result.sources).toHaveLength(3); expect(result.runs).toHaveLength(2); expect(new Set(opened).size).toBe(opened.length);
});
it("handles legacy columns and missing registered roots", async () => {
  const old = join(root, "old.db"); db(old, "CREATE TABLE runs(id TEXT); INSERT INTO runs VALUES ('legacy');");
  db(roots().registryDb, `CREATE TABLE projects(project_key TEXT,db_path TEXT); INSERT INTO projects VALUES ('${join(root, "gone")}','${join(root, "gone/project.db")}'),('${root}','${old}');`);
  const result = await discover(roots()); expect(result.runs[0]).toMatchObject({ id: "legacy", sessionId: null, agent: null, endedAt: null });
  expect(result.errors.map(e => e.code)).toContain("missing-db"); expect(result.errors.map(e => e.code)).toContain("missing-source");
});
it("does not discover child files by arbitrary recursion", async () => {
  const project = join(root, "project"), file = join(project, ".spider/project.db"); registry(`('${project}','${project}',NULL,'${file}')`); runs(file, "safe");
  const arbitrary = join(project, "unrelated/deep/private.jsonl"); touch(arbitrary); touch(join(project, ".spider/scratch/subagent-sessions/unregistered/unregistered.jsonl"));
  const result = await discover(roots()); expect(result.sources).toHaveLength(0); expect(result.errors.some(e => e.path === arbitrary)).toBe(false);
});

it("attributes parent sessions to the longest registered project root", async () => {
  const project = join(root, "project"), nested = join(project, "nested"), file = join(project, ".spider/project.db"), nestedFile = join(nested, ".spider/project.db"), repo = join(root, "common");
  registry(`('${project}','${project}','${repo}','${file}'),('${nested}','${nested}',NULL,'${nestedFile}')`);
  const parent = join(roots().sessionsDir, "encoded", "p.jsonl"); touch(parent); writeFileSync(parent, JSON.stringify({ type: "session", id: "p", cwd: join(nested, "package") }) + "\n");
  const result = await discover(roots()); expect(result.sources[0]).toMatchObject({ project: nested, repo: null, run: null });
});
it("snapshots run usage and report markers without loading unrelated events", async () => {
  const project = join(root, "project"), file = join(project, ".spider/project.db"); registry(`('${project}','${project}',NULL,'${file}')`);
  db(file, "CREATE TABLE runs(id TEXT,session_id TEXT,agent TEXT,status TEXT,child_mode TEXT); INSERT INTO runs VALUES ('child','owner','worker','done','rpc'); CREATE TABLE run_events(id INTEGER,run_id TEXT,session_id TEXT,ts INTEGER,type TEXT,payload TEXT); INSERT INTO run_events VALUES (1,'child','owner',10,'spider_usage','{}'),(2,'child','owner',11,'spider_usage_reported',NULL),(3,'child','owner',12,'tool_result','not imported');");
  const result = await discover(roots()); expect(result.runEvents?.map(e => e.type)).toEqual(["spider_usage", "spider_usage_reported"]); expect(result.runStates).toEqual([{ dbPath: file, id: "child", status: "done", childMode: "rpc" }]);
});

it("reports no missing child when another registered worktree contains its transcript", async () => {
  const a = join(root, "a"), b = join(root, "b"), repo = join(root, "common"), da = join(a, ".spider/project.db"), dbb = join(b, ".spider/project.db");
  registry(`('${a}','${a}','${repo}','${da}'),('${b}','${b}','${repo}','${dbb}')`); db(da, "CREATE TABLE runs(id TEXT)"); db(dbb, "CREATE TABLE runs(id TEXT)"); runs(join(repo, "spider/repo.db"), "shared");
  const child = join(b, ".spider/scratch/subagent-sessions/shared/shared.jsonl"); touch(child); const result = await discover(roots()); expect(result.sources.map(s => s.path)).toEqual([child]); expect(result.errors.filter(e => e.code === "missing-source")).toEqual([]);
});

it("finds cross-repo child transcripts across all registered scratch roots", async () => {
  const a = join(root, "a"), b = join(root, "b"), da = join(a, ".spider/project.db"), dbb = join(b, ".spider/project.db");
  registry(`('${a}','${a}',NULL,'${da}'),('${b}','${b}',NULL,'${dbb}')`); runs(da, "cross"); db(dbb, "CREATE TABLE runs(id TEXT)");
  const child = join(b, ".spider/scratch/subagent-sessions/cross/cross.jsonl"); touch(child);
  const result = await discover(roots()); expect(result.sources.map(s => s.path)).toEqual([child]); expect(result.errors.filter(e => e.code === "missing-source")).toEqual([]);
});
it("reports only registry-derived candidates even with an unsupported cwd column", async () => {
  const a = join(root, "a"), cwd = join(root, "launch"), file = join(a, ".spider/project.db"); registry(`('${a}','${a}',NULL,'${file}')`);
  db(file, `CREATE TABLE runs(id TEXT,cwd TEXT,task TEXT,result TEXT);INSERT INTO runs VALUES('child','${cwd}','large','large');`);
  const result = await discover(roots()); const missing = result.errors.find(e => e.code === "missing-source") as any;
  expect(missing.path).toBe(join(a, ".spider/scratch/subagent-sessions/child/child.jsonl")); expect(missing.checkedPaths).toContain(missing.path);
});
it("never selects task/result blobs from runs", async () => {
  const a = join(root, "a"), file = join(a, ".spider/project.db"); registry(`('${a}','${a}',NULL,'${file}')`); runs(file, "child");
  const result = await discover(roots(), { openDb: p => { const d = openDbReadOnly(p); if (d) { const prepare = d.prepare.bind(d); d.prepare = ((sql: string) => { expect(sql).not.toMatch(/SELECT \* FROM runs/); return prepare(sql); }) as typeof d.prepare; } return d; } });
  expect(result.errors.some(e => e.code === "source-read-error")).toBe(false);
});

it("does not treat hypothetical run cwd as a registered launch root", async () => {
  const project = join(root, "project"), file = join(project, ".spider/project.db"), other = join(root, "unregistered");
  registry(`('${project}','${project}',NULL,'${file}')`);
  runs(file, "child");
  const d = new Database(file); d.exec(`ALTER TABLE runs ADD COLUMN cwd TEXT; UPDATE runs SET cwd='${other}'`); d.close();
  const result = await discover(roots());
  const diagnostic = result.errors.find(e => e.code === "missing-source")!;
  expect(diagnostic.checkedPaths).not.toContain(join(other, ".spider/scratch/subagent-sessions/child/child.jsonl"));
  expect(diagnostic.path).toBe(join(project, ".spider/scratch/subagent-sessions/child/child.jsonl"));
});
it("probes registered symlinked scratch roots and persists the canonical checked path", async () => {
  const project = join(root, "project"), file = join(project, ".spider/project.db"), target = join(root, "launch-scratch");
  registry(`('${project}','${project}',NULL,'${file}')`); runs(file, "child");
  const child = join(target, "subagent-sessions/child/child.jsonl"); touch(child);
  symlinkSync(target, join(project, ".spider/scratch"));
  const listed: string[] = [];
  const result = await discover(roots(), { readdir: async path => { listed.push(path); return fs.readdir(path, { withFileTypes: true }); } });
  expect(listed).toContain(join(target, "subagent-sessions"));
  expect(result.sources.map(s => s.path)).toContain(child);
  rmSync(child);
  const missing = await discover(roots());
  expect(missing.errors.find(e => e.code === "missing-source")?.checkedPaths).toEqual([child]);
});

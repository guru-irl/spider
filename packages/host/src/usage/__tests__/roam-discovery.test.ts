import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { openDb, openDbReadOnly, type Db } from "@spider/db-core";
import { createReplica, type ReplicaFixture } from "@spider/db-core/testutil";
import { discoverUsageSources, type UsageRoots } from "../discovery.js";
import { ingestOnce } from "../ingest.js";
import { openUsageLedger, type UsageLedger } from "../ledger.js";

const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";
let root: string, replica: ReplicaFixture, registry: Db, ledger: UsageLedger | undefined;
let project: string, scratch: string, roots: UsageRoots;
beforeEach(() => {
  root = mkdtempSync(join(process.env.SPIDER_GLOBAL_ROOT!, "roam-discovery-"));
  replica = createReplica("worktree", B);
  project = join(replica.root, "project"); scratch = join(project, ".spider", "scratch");
  mkdirSync(join(root, "sessions", "group"), { recursive: true });
  mkdirSync(join(scratch, "subagent-sessions"), { recursive: true });
  roots = { registryDb: join(root, "registry.db"), sessionsDir: join(root, "sessions"), ledgerFile: join(root, "ledger.db"), authPath: join(root, "auth.json"), leaseDir: join(root, "leases") };
  registry = openDb(roots.registryDb);
  registry.exec("CREATE TABLE projects(project_key TEXT,real_path TEXT,repo_key TEXT,db_path TEXT,scratch_root TEXT)");
  registry.prepare("INSERT INTO projects VALUES (?,?,?,?,?)").run(project, project, null, replica.db.raw.name, scratch);
});
afterEach(() => { ledger?.close(); ledger = undefined; registry.close(); replica.close(); rmSync(root, { recursive: true, force: true }); });
function write(path: string, entries: unknown[]) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, entries.map(item => JSON.stringify(item)).join("\n") + "\n");
}
function addRun(id: string, origin: string) {
  replica.db.prepare("INSERT INTO runs(id,session_id,agent,status,ended_at,origin_machine,pid) VALUES (?, 'owner', 'worker', 'done', 9, ?, 42)").run(id, origin);
  const payload = JSON.stringify({ provider: "fixture", model: id, purpose: "learner", usage: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 } });
  replica.db.prepare("INSERT INTO run_events(run_id,session_id,ts,type,payload) VALUES (?, 'owner', 8, 'spider_usage', ?)").run(id, payload);
  replica.db.prepare("INSERT INTO run_events(run_id,session_id,ts,type) VALUES (?, 'owner', 9, 'spider_usage_reported')").run(id);
  const file = join(scratch, "subagent-sessions", id, `${id}.jsonl`);
  write(file, [{ type: "session", id, cwd: project }]); return file;
}
function addParticipant(origin: string) {
  replica.db.prepare("INSERT INTO sessions(id,started_at,origin_machine) VALUES ('owner',1,?)").run(origin);
  replica.db.prepare("INSERT INTO roam_sessions(session_id,epoch,state) VALUES ('owner',2,'active')").run();
}

// A foreign run can reuse a local-looking PID and path without becoming local work.
it("native discovery ignores foreign run files usage and reported sentinels", async () => {
  addParticipant(A);
  const localFile = addRun("local-run", B), legacyFile = addRun("legacy-run", ""), foreignFile = addRun("foreign-run", A);
  const invalidFile = addRun("whitespace-run", " ");
  const found = await discoverUsageSources(roots);
  expect(found.runs.map(run => run.id)).toEqual(["legacy-run", "local-run"]);
  expect(found.sources.map(source => source.path)).toEqual([legacyFile, localFile]);
  expect(found.sources.some(source => source.path === foreignFile)).toBe(false);
  expect(found.sources.some(source => source.path === invalidFile)).toBe(false);
  expect([...found.runEvents!.runs.values()].map(item => item.runId).sort()).toEqual(["legacy-run", "local-run"]);
  expect(found.runEvents!.auxiliary.map(item => item.runId).sort()).toEqual(["legacy-run", "local-run"]);
  expect(found.errors).toEqual([]);
}, 5000);

it("native discovery excludes foreign runs without session participation", async () => {
  const legacyFile = addRun("legacy-run", ""), localFile = addRun("local-run", B), foreignFile = addRun("foreign-run", A);
  const found = await discoverUsageSources(roots);
  expect(found.runs.map(run => run.id)).toEqual(["legacy-run", "local-run"]);
  expect(found.sources.map(source => source.path)).toEqual([legacyFile, localFile]);
  expect(found.sources.some(source => source.path === foreignFile)).toBe(false);
  expect([...found.runEvents!.runs.values()].map(item => item.runId).sort()).toEqual(["legacy-run", "local-run"]);
  expect(found.runEvents!.auxiliary.map(item => item.runId).sort()).toEqual(["legacy-run", "local-run"]);
}, 5000);

// The ordinary discovery-to-ingest path must carry participation without a new worker API.
it("discovered participants bill only their local physical segment", async () => {
  addParticipant(A);
  const file = join(roots.sessionsDir, "group", "session.jsonl");
  const usage = { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 };
  const msg = (id: string) => ({ type: "message", id, timestamp: "2026-01-02T03:04:05.000Z", message: { role: "assistant", provider: "fixture", model: "fixture", usage } });
  write(file, [{ type: "session", version: 3, id: "owner", cwd: project }, msg("foreign"), {
    type: "custom", customType: "spider-roam-segment", id: "move", data: {
      version: 1, moveId: "move", epoch: 2, previousMachine: A, nextMachine: B, historyMachine: A, parentRef: null,
    },
  }, msg("local")]);
  const found = await discoverUsageSources(roots);
  expect(found.sources).toHaveLength(1);
  expect(found.sources[0]?.roaming).toEqual({ localMachine: B, originMachine: A });
  ledger = openUsageLedger(roots.ledgerFile);
  await ingestOnce(ledger, found, Date.now(), new AbortController().signal);
  const db = openDbReadOnly(roots.ledgerFile)!;
  try { expect(db.prepare("SELECT entry_id,execution_machine FROM calls ORDER BY entry_id").all()).toEqual([{ entry_id: "local", execution_machine: B }]); }
  finally { db.close(); }
}, 5000);

it("participant discovery uses session identity when the recorded cwd is unregistered", async () => {
  addParticipant(A);
  const file = join(roots.sessionsDir, "group", "session.jsonl");
  const usage = { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 };
  const msg = (id: string) => ({ type: "message", id, timestamp: "2026-01-02T03:04:05.000Z",
    message: { role: "assistant", provider: "fixture", model: "fixture", usage } });
  write(file, [{ type: "session", version: 3, id: "owner", cwd: join(root, "unregistered") }, msg("foreign"), {
    type: "custom", customType: "spider-roam-segment", id: "move", data: {
      version: 1, moveId: "move", epoch: 2, previousMachine: A, nextMachine: B, historyMachine: A, parentRef: null,
    },
  }, msg("local")]);
  const found = await discoverUsageSources(roots);
  expect(found.sources[0]?.roaming).toEqual({ localMachine: B, originMachine: A });
  ledger = openUsageLedger(roots.ledgerFile);
  await ingestOnce(ledger, found, Date.now(), new AbortController().signal);
  const db = openDbReadOnly(roots.ledgerFile)!;
  try { expect(db.prepare("SELECT entry_id FROM calls ORDER BY entry_id").all()).toEqual([{ entry_id: "local" }]); }
  finally { db.close(); }
}, 5000);

it("a large session header still identifies a participating transcript", async () => {
  addParticipant(A);
  const file = join(roots.sessionsDir, "group", "session.jsonl");
  const usage = { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 };
  const msg = (id: string) => ({ type: "message", id, timestamp: "2026-01-02T03:04:05.000Z",
    message: { role: "assistant", provider: "fixture", model: "fixture", usage } });
  write(file, [{ type: "session", version: 3, id: "owner", cwd: project, ignored: "x".repeat(70_000) }, msg("foreign"), {
    type: "custom", customType: "spider-roam-segment", id: "move", data: {
      version: 1, moveId: "move", epoch: 2, previousMachine: A, nextMachine: B, historyMachine: A, parentRef: null,
    },
  }, msg("local")]);
  const found = await discoverUsageSources(roots);
  expect(found.sources[0]?.roaming).toEqual({ localMachine: B, originMachine: A });
  ledger = openUsageLedger(roots.ledgerFile);
  await ingestOnce(ledger, found, Date.now(), new AbortController().signal);
  const db = openDbReadOnly(roots.ledgerFile)!;
  try { expect(db.prepare("SELECT entry_id FROM calls ORDER BY entry_id").all()).toEqual([{ entry_id: "local" }]); }
  finally { db.close(); }
}, 5000);

// A participant with neither an origin nor a marker has no safe initial owner.
it("unmarked participants without an origin do not charge", async () => {
  addParticipant("");
  const file = join(roots.sessionsDir, "group", "session.jsonl");
  write(file, [{ type: "session", id: "owner", cwd: project }, { type: "message", id: "unknown", timestamp: "2026-01-02T03:04:05Z",
    message: { role: "assistant", provider: "fixture", model: "fixture", usage: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 } } }]);
  const found = await discoverUsageSources(roots);
  ledger = openUsageLedger(roots.ledgerFile);
  await ingestOnce(ledger, found, Date.now(), new AbortController().signal);
  expect(ledger.health().calls).toBe(0);
  expect(ledger.getSourceErrors().map(error => error.code)).toContain("missing-roam-history");
}, 5000);

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { openDb, setGlobalDbPathForTests } from "@spider/db-core";
import { V13 } from "../../../db-core/src/__tests__/fixtures/historical-schemas";
import { createReplica } from "@spider/db-core/testutil";
import { catalogReplica, recordLocation, replicaPath } from "@spider/db-core/roam/catalog";
import { applyBatch } from "@spider/db-core/roam/apply";
import { validateBatch } from "@spider/db-core/roam/codec";
import { createReplicaEffects } from "@spider/db-core/roam/effects";
import { createExportPolicy } from "@spider/db-core/roam/event-policy";
import { exportBatch } from "@spider/db-core/roam/export";
import { openDbAt } from "@spider/db-core";
import { addTodo } from "@spider/todo";
import { addMemory } from "@spider/memory";
import { RunStore } from "../../../subagents/src/run-store";
import { emitLog } from "../../../subagents/src/run-events";
import { runSearch } from "../actions/search";

const machine = "11111111-1111-4111-8111-111111111111";
const key = "worktree:fixture-repo:fixture-workspace" as const;
const fixtures: ReturnType<typeof createReplica>[] = [];
afterEach(() => { setGlobalDbPathForTests(null); for (const f of fixtures.splice(0)) f.close(); });

function setup() {
  const global = createReplica("global", machine), local = createReplica("worktree", machine), repo = createReplica("repo", machine);
  fixtures.push(global, local, repo);
  setGlobalDbPathForTests(global.db.raw.name);
  mkdirSync(join(global.root, "roam", "stores"), { recursive: true, mode: 0o700 });
  const remote = openDbAt(replicaPath(global.db, key), "worktree");
  remote.prepare("UPDATE roam_meta SET store_key = ? WHERE id = 1").run(key);
  for (const id of ["selected", "other"]) {
    remote.prepare("INSERT INTO sessions(id,name,summary,started_at) VALUES (?, ?, ?, 1)").run(id, `needle ${id}`, `summary ${id}`);
    remote.prepare("INSERT INTO sessions_fts(id,name,summary,content) VALUES (?, ?, ?, ?)").run(id, `needle ${id}`, `summary ${id}`, `needle text ${id}`);
    addTodo(remote, id, `needle todo ${id}`);
    const run = new RunStore(remote).create({ sessionId: id, agent: "worker", task: `needle run ${id}` });
    emitLog(remote, { runId: run.id, sessionId: id, summary: `needle history ${id}` });
  }
  remote.prepare("INSERT INTO content(source,chunk,created_at) VALUES ('source', 'needle indexed content', 1)").run();
  addMemory(repo.db, "repo", { category: "insight", content: "needle memory" });
  catalogReplica(global.db, key, remote);
  local.db.prepare("INSERT INTO sessions(id,name,started_at) VALUES ('local','needle local',1)").run();
  local.db.prepare("INSERT INTO sessions_fts(id,name,content) VALUES ('local','needle local','local text')").run();
  return { global, local, repo, remote, ctx: { db: local.db, repoDb: repo.db, globalDb: global.db, cwd: global.root } };
}

it("replica session search matches metadata and notes text stays on origin", async () => {
  const f = setup();
  const origin = "22222222-2222-4222-8222-222222222222";
  const source = createReplica("worktree", origin);
  fixtures.push(source);
  try {
    source.db.exec("UPDATE roam_meta SET capture_enabled = 1; INSERT INTO roam_sessions(session_id,epoch,state) VALUES ('remote-text',1,'active')");
    source.db.prepare("INSERT INTO sessions(id,name,summary,reason,started_at,origin_machine) VALUES ('remote-text','portable name',?,'reasonneedle',1,?)").run(`portable summary ${"x".repeat(400)}`, origin);
    source.db.prepare("INSERT INTO sessions_fts(id,name,summary,content) VALUES ('remote-text','portable name','portable summary','secrettranscript')").run();
    const artifact = await exportBatch(source.db, { after: 0, targetBytes: 1024 * 1024, batchId: "metadata-transfer" }, createExportPolicy((_path, originMachine) => ({ machineId: originMachine, reference: "unavailable" })));
    const now = Date.now();
    const batch = await validateBatch(artifact, { storeKey: key, senderMachine: origin, senderStream: artifact.header.senderStream, now });
    applyBatch(f.remote, batch, { hubMachine: machine, effects: createReplicaEffects(() => {}), now, sessionHome: () => null });
    catalogReplica(f.global.db, key, f.remote);
    const result = await runSearch({ query: "reasonneedle", session: "remote-text", kinds: ["session"] }, f.ctx);
    expect(result.details).toHaveLength(1);
    expect(result.text).toContain("portable name");
    expect(result.text).toContain("portable summary");
    expect(result.text).toMatch(/transcript text.*origin/i);
    expect(result.text).not.toContain("secrettranscript");
    const transcript = await runSearch({ query: "secrettranscript", session: "remote-text", kinds: ["session"] }, f.ctx);
    expect(transcript.details).toEqual([]);
  } finally { f.remote.close(); }
}, 5000);

it("session search returns only that session's rows", async () => {
  const f = setup();
  try {
    const result = await runSearch({ query: "needle", session: "selected" }, f.ctx);
    const text = JSON.stringify(result.details);
    expect(text).toContain("needle selected");
    expect(text).toContain("needle text selected");
    expect(text).toContain("needle todo selected");
    expect(text).toContain("needle run selected");
    expect(text).toContain("needle history selected");
    expect(text).not.toContain("other");
    expect(text).not.toContain("local");
  } finally { f.remote.close(); }
}, 5000);

it("session search excludes memory and content", async () => {
  const f = setup();
  try {
    const result = await runSearch({ query: "needle", session: "selected", kinds: ["memory", "content"] }, f.ctx);
    expect(result.details).toEqual([]);
    expect(result.text).not.toMatch(/error|not found/i);
  } finally { f.remote.close(); }
}, 5000);

it("searches an uncataloged local session without crossing its boundary", async () => {
  const f = setup();
  try {
    addTodo(f.local.db, "local", "needle local todo");
    const run = new RunStore(f.local.db).create({ sessionId: "local", agent: "worker", task: "needle local run" });
    emitLog(f.local.db, { runId: run.id, sessionId: "local", summary: "needle local history" });
    f.local.db.prepare("INSERT INTO sessions(id,name,started_at) VALUES ('local-other','needle unrelated',1)").run();
    f.local.db.prepare("INSERT INTO sessions_fts(id,name,content) VALUES ('local-other','needle unrelated','needle private')").run();
    addTodo(f.local.db, "local-other", "needle unrelated todo");
    const other = new RunStore(f.local.db).create({ sessionId: "local-other", agent: "worker", task: "needle unrelated run" });
    emitLog(f.local.db, { runId: other.id, sessionId: "local-other", summary: "needle unrelated history" });
    const result = await runSearch({ query: "needle", session: "local" }, f.ctx);
    const text = JSON.stringify(result.details);
    expect(text).toContain("needle local");
    expect(text).toContain("needle local todo");
    expect(text).toContain("needle local run");
    expect(text).toContain("needle local history");
    expect(text).not.toContain("unrelated");
    expect(text).not.toContain("selected");
  } finally { f.remote.close(); }
}, 5000);

it("finds an uncataloged session represented only by a todo", async () => {
  const f = setup();
  try {
    addTodo(f.local.db, "todo-only", "needle orphan todo");
    const result = await runSearch({ query: "needle", session: "todo-only" }, f.ctx);
    expect(result.details).toHaveLength(1);
    expect(result.text).toContain("needle orphan todo");
  } finally { f.remote.close(); }
}, 5000);

it("reports a cataloged but unavailable replica without mislabeling it as unknown", async () => {
  const f = setup();
  try {
    f.local.db.prepare("INSERT INTO sessions(id,name,started_at) VALUES ('missing-replica','needle stale',1)").run();
    recordLocation(f.global.db, { sessionId: "missing-replica", stores: ["worktree:fixture-repo:missing"], home: null });
    const result = await runSearch({ query: "needle", session: "missing-replica" }, f.ctx);
    expect(result.details).toEqual([]);
    expect(result.text).toMatch(/unavailable/i);
    expect(result.text).not.toMatch(/not found/i);
  } finally { f.remote.close(); }
}, 5000);

it("searches real schema-13 local history without migration or a roaming catalog", async () => {
  const f = setup();
  const legacy = openDb(join(f.local.root, "worktree-v13.db")), global = openDb(join(f.local.root, "global-v13.db"));
  try {
    legacy.exec(V13.worktree); legacy.raw.pragma("user_version = 13");
    global.exec(V13.global); global.raw.pragma("user_version = 13");
    legacy.prepare("INSERT INTO sessions(id,name,started_at) VALUES ('legacy','needle session',1)").run();
    legacy.prepare("INSERT INTO sessions_fts(id,name,content) VALUES ('legacy','needle session','needle transcript')").run();
    legacy.prepare("INSERT INTO todos(session_id,seq,text,created_at) VALUES ('legacy',1,'needle todo',1)").run();
    legacy.prepare("INSERT INTO todos_fts(rowid,text) SELECT id,text FROM todos WHERE session_id='legacy'").run();
    legacy.prepare("INSERT INTO runs(id,session_id,agent,status,task) VALUES ('legacy-run','legacy','worker','done','needle run')").run();
    legacy.prepare("INSERT INTO run_events(run_id,session_id,ts,type,summary) VALUES ('legacy-run','legacy',1,'log','needle history')").run();
    const result = await runSearch({ query: "needle", session: "legacy" }, { ...f.ctx, db: legacy, globalDb: global });
    const text = JSON.stringify(result.details);
    expect(text).toContain("needle transcript"); expect(text).toContain("needle todo");
    expect(text).toContain("needle run"); expect(text).toContain("needle history");
    expect(legacy.pragma("user_version")).toBe(13); expect(global.pragma("user_version")).toBe(13);
  } finally { legacy.close(); global.close(); f.remote.close(); }
}, 5000);

it("unknown session search does not fall back", async () => {
  const f = setup();
  try {
    const result = await runSearch({ query: "needle", session: "unknown" }, f.ctx);
    expect(result.details).toEqual([]);
    expect(result.text).toMatch(/session not found/i);
  } finally { f.remote.close(); }
}, 5000);

it("default search retains current worktree scope", async () => {
  const f = setup();
  try {
    const result = await runSearch({ query: "needle", kinds: ["session"] }, f.ctx);
    expect(result.details.map(row => row.id)).toEqual(["local"]);
  } finally { f.remote.close(); }
}, 5000);

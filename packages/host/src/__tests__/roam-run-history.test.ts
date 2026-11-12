import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { appendRunEvent, bus, openDbAt, openGlobalReadOnly, setGlobalDbPathForTests } from "@spider/db-core";
import { createReplica } from "@spider/db-core/testutil";
import { catalogReplica, replicaPath } from "@spider/db-core/roam/catalog";
import { applyBatch } from "@spider/db-core/roam/apply";
import { validateBatch } from "@spider/db-core/roam/codec";
import { createReplicaEffects } from "@spider/db-core/roam/effects";
import { createExportPolicy } from "@spider/db-core/roam/event-policy";
import { exportBatch } from "@spider/db-core/roam/export";
import { RunStore } from "../../../subagents/src/run-store";
import { openSessionHistoryDb } from "../session-run-db";
import { createHerdrDataSource } from "../herdr/data-source";
import { createRunTranscriptSource } from "../herdr/run-transcript";
import type { RunViewFrame } from "../../../herdr/src/contracts";

const probes = vi.hoisted(() => [] as import("@spider/db-core").Db[]);
vi.mock("@spider/db-core", async importOriginal => {
  const actual = await importOriginal<typeof import("@spider/db-core")>();
  return { ...actual, openRoamingCatalogReadOnly: () => {
    const db = actual.openRoamingCatalogReadOnly();
    if (db) probes.push(db);
    return db;
  } };
});

const machine = "11111111-1111-4111-8111-111111111111";
const fixtures: ReturnType<typeof createReplica>[] = [];
afterEach(() => { setGlobalDbPathForTests(null); for (const probe of probes.splice(0)) if (probe.raw.open) probe.close(); for (const f of fixtures.splice(0)) f.close(); });

it("unavailable historical locators display their origin instead of a matching local file", async () => {
  const global = createReplica("global", machine);
  const origin = "22222222-2222-4222-8222-222222222222";
  const source = createReplica("worktree", origin);
  fixtures.push(global, source);
  setGlobalDbPathForTests(global.db.raw.name);
  const key = "worktree:fixture-repo:fixture-workspace" as const;
  mkdirSync(join(global.root, "roam", "stores"), { recursive: true, mode: 0o700 });
  const target = openDbAt(replicaPath(global.db, key), "worktree");
  try {
    target.prepare("UPDATE roam_meta SET machine_id = ?, store_key = ? WHERE id = 1").run(machine, key);
    source.db.exec("UPDATE roam_meta SET capture_enabled = 1; INSERT INTO roam_sessions(session_id,epoch,state) VALUES ('remote-session',1,'active')");
    source.db.prepare("INSERT INTO sessions(id,started_at,origin_machine) VALUES ('remote-session',1,?)").run(origin);
    const run = new RunStore(source.db).create({ sessionId: "remote-session", agent: "worker" });
    const directory = join(source.root, "subagent-sessions", run.id);
    appendRunEvent(source.db, { runId: run.id, sessionId: "remote-session", ts: Date.now(), type: "child_transcript", payload: { version: 1, directory } });
    const artifact = await exportBatch(source.db, { after: 0, targetBytes: 1024 * 1024, batchId: "history-transfer" }, createExportPolicy((_path, originMachine) => ({ machineId: originMachine, reference: "opaque-history" })));
    const now = Date.now();
    const batch = await validateBatch(artifact, { storeKey: key, senderMachine: origin, senderStream: artifact.header.senderStream, now });
    applyBatch(target, batch, { hubMachine: machine, effects: createReplicaEffects(() => {}), now, sessionHome: () => null });
    catalogReplica(global.db, key, target);
    const localRoot = join(global.root, "coincidental");
    mkdirSync(join(localRoot, "subagent-sessions", run.id), { recursive: true });
    writeFileSync(join(localRoot, "subagent-sessions", run.id, "local.jsonl"), JSON.stringify({ type: "message", message: { role: "assistant", content: "unrelated local text" } }) + "\n");
    const owner = { sessionId: "remote-session", generation: "generation", terminal: { coreId: "core", terminalId: "terminal", address: "terminal", socket: "unused", sessionNamespace: "fixture" }, cwd: localRoot, sessionFile: null, name: null };
    const reader = createRunTranscriptSource({ owner: () => owner as never, resolveDb: o => openSessionHistoryDb(o.cwd, o.sessionId), transcriptRoots: () => [localRoot] });
    const frames: RunViewFrame[] = [];
    try {
      const cancel = reader.subscribe(run.id as never, null, frame => frames.push(frame));
      cancel();
      expect(JSON.stringify(frames)).toContain(origin);
      expect(JSON.stringify(frames)).not.toContain("unrelated local text");
    } finally { reader.dispose(); }
  } finally { target.close(); }
}, 5000);

it("run history uses a read-only replica without registering a checkout", async () => {
  const global = createReplica("global", machine);
  fixtures.push(global);
  setGlobalDbPathForTests(global.db.raw.name);
  const key = "worktree:fixture-repo:fixture-workspace" as const;
  mkdirSync(join(global.root, "roam", "stores"), { recursive: true, mode: 0o700 });
  const remote = openDbAt(replicaPath(global.db, key), "worktree");
  try {
    remote.prepare("UPDATE roam_meta SET store_key = ? WHERE id = 1").run(key);
    remote.exec("INSERT INTO sessions(id,started_at) VALUES ('remote-session',1)");
    const run = new RunStore(remote).create({ sessionId: "remote-session", agent: "worker", task: "remote history" });
    catalogReplica(global.db, key, remote);
    const projects = global.db.prepare("SELECT * FROM projects").all();
    const opened = openSessionHistoryDb(join(global.root, "no-checkout"), "remote-session");
    expect(opened.db.raw.readonly).toBe(true);
    expect(probes.length).toBeGreaterThan(0);
    expect(probes.every(db => !db.raw.open)).toBe(true);
    expect(new RunStore(opened.db).get(run.id)?.task).toBe("remote history");
    opened.db.close();
    const owner = { sessionId: "remote-session", generation: "generation", terminal: { coreId: "core", terminalId: "terminal", address: "terminal", socket: "unused", sessionNamespace: "fixture" }, cwd: join(global.root, "no-checkout"), sessionFile: null, name: null };
    const data = createHerdrDataSource({
      resolveRunDb: o => openSessionHistoryDb(o.cwd, o.sessionId),
      openApprovalDbs: () => ({ global: openGlobalReadOnly()!, repo: null }),
      runEvents: bus, scheduler: { listTriggers: () => [], subscribe: () => () => {} },
      readUsage: async () => { throw new Error("unavailable"); },
      readConfig: () => ({ limits: { auxiliaryPanes: 2, completedRows: 50, completedHours: 24 } }),
      clock: () => Date.now(),
    });
    try {
      const feed = await data.snapshot(owner as never);
      expect(feed.runs.rows.map(row => row.id)).toEqual([run.id]);
    } finally { data.dispose(); }
    expect(global.db.prepare("SELECT * FROM projects").all()).toEqual(projects);
  } finally { remote.close(); }
}, 5000);

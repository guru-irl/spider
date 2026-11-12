import { afterEach, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildFixture } from "../../../../scripts/test-bundle";
import { createReplica } from "@spider/db-core/testutil";
import * as applyApi from "@spider/db-core/roam/apply";
import * as codecApi from "@spider/db-core/roam/codec";
import { createReplicaEffects } from "@spider/db-core/roam/effects";
import * as exportApi from "@spider/db-core/roam/export";
import { exportBatch } from "@spider/db-core/roam/export";
import { seedSession } from "@spider/db-core/roam/seed";
import type { JsonObject, Scope, StoreKey } from "@spider/db-core/roam/types";
import { createAgentPorts, dispatchArtifactCommand, handleAgentArtifactRequest, handleAgentOperation } from "../agent";
import { DEFAULT_LIMITS } from "../contracts";
import type { AgentPorts, ArtifactManifest, Operation, Peer, Transport } from "../contracts";
import { openJournal } from "../journal";
import { createManifestPages, pullArtifact, readManifestPages, stageArtifact, transferArtifact } from "../artifacts";
import { acquireTransferLease, defaultStagingRoot, hash, manifestDigest, openOutgoingStaging, openStaging, readPrivate, sourceChunk } from "../staging";

const HUB = "00000000-0000-4000-8000-000000000001";
const BOX = "00000000-0000-4000-8000-000000000002";
const fixtures: Array<{ close(): void }> = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const fixture of fixtures.splice(0)) fixture.close();
});

function fixture(scope: Scope = "repo") {
  const replica = createReplica(scope, BOX);
  fixtures.push(replica);
  const opened: StoreKey[] = [];
  const notices: StoreKey[] = [];
  const journal = openJournal(join(replica.root, "operations", "journal.db"));
  const ports: AgentPorts = {
    root: join(replica.root, "roam", "staging"), journal,
    config: { enabled: true, role: "box", machineId: BOX, hubMachineId: HUB, peers: [], discoveryRoots: [],
      coreUnit: "core", syncMs: 120_000, limits: { ...DEFAULT_LIMITS } },
    openStore(key) {
      opened.push(key);
      if (key !== replica.storeKey) throw new Error("unknown fixture store");
      return { db: replica.db, effects: createReplicaEffects(key => notices.push(key)), policy: { encode: (_entity, body) => body } };
    },
  };
  return { ...replica, ports, opened, notices };
}
function operation(id: string, kind: string, args: JsonObject): Operation {
  return { id, kind, args, machineId: BOX, expectedEpoch: null };
}

async function stagedImport() {
  const destination = fixture("worktree");
  const source = createReplica("worktree", HUB);
  fixtures.push(source);
  source.db.prepare("INSERT INTO sessions(id, name, started_at) VALUES ('session-a', 'portable', 1)").run();
  source.db.prepare("INSERT INTO runs(id, session_id, agent, status) VALUES ('run-a', 'session-a', 'worker', 'running')").run();
  source.db.prepare("INSERT INTO run_events(uuid, run_id, session_id, ts, type) VALUES ('event-a', 'run-a', 'session-a', 1, 'progress')").run();
  source.db.prepare("INSERT INTO todos(uuid, session_id, seq, text, created_at) VALUES ('todo-a', 'session-a', 1, 'portable', 1)").run();
  seedSession(source.db, "session-a", 1, source.storeKey, 64 * 1024);
  const batch = await exportBatch(source.db, { after: 0, targetBytes: 64 * 1024, batchId: "batch-a" }, { encode: (_entity, body) => body });
  const sourceRoot = join(source.root, "staging");
  const manifest = await stageArtifact(batch.file, "batch", destination.ports.config.limits, { root: sourceRoot, artifactId: "artifact-a" });
  const staging = openStaging(destination.ports.root, HUB, destination.ports.config.limits);
  let installedFile: string;
  try {
    staging.declare(manifest, "transfer-a");
    for (const chunk of manifest.chunks) {
      const bytes = readPrivate(sourceChunk(sourceRoot, manifest.id, chunk.index, chunk.sha256), chunk.rawLength);
      staging.receive(manifest, chunk.index, bytes);
    }
    installedFile = staging.assemble(manifest);
  } finally { staging.close(); }
  const request = operation("import-a", "import", { storeKey: destination.storeKey, sourceMachine: HUB,
    transferId: "transfer-a", artifactId: manifest.id, sha256: manifest.sha256, header: JSON.parse(JSON.stringify(batch.header)) as JsonObject });
  return { destination, source, batch, manifest, installedFile, request };
}

it("bundles the agent and db-core subpaths as a loadable fixture", async () => {
  const { root } = fixture();
  const checkout = process.env.SPIDER_TEST_FIXTURE_CHECKOUT!;
  const output = join(root, "agent-bundle.mjs");
  const bundle = await buildFixture({ entryPoints: [resolve(checkout, "packages/roam/src/agent.ts")], outfile: output,
    external: ["better-sqlite3"] });
  expect(Object.keys(bundle.metafile.inputs).some(path => path.endsWith("packages/db-core/src/roam/codec.ts"))).toBe(true);
  const loaded = await import(pathToFileURL(output).href);
  expect(typeof loaded.handleAgentOperation).toBe("function");
  expect(typeof loaded.dispatchArtifactCommand).toBe("function");
}, 5000);

it("reports a store inventory without exposing its local path", async () => {
  const { db, ports, storeKey, root } = fixture();
  const stream = (db.prepare("SELECT stream_id FROM roam_meta").get() as { stream_id: string }).stream_id;
  const result = await handleAgentOperation(operation("inventory-1", "inventory", { storeKey }), ports);
  expect(result).toMatchObject({ code: 0, operationId: "inventory-1", value: {
    protocol: 1, schema: 14, machineId: BOX, storeKey, stream, through: 0, captureEnabled: false,
  } });
  expect(JSON.stringify(result)).not.toContain(root);
}, 5000);

it("bounds refusal replies even when the operation ID consumes the budget", async () => {
  const { ports, storeKey } = fixture();
  ports.config.limits.replyBytes = 140;
  const result = await handleAgentOperation(operation("x".repeat(128), "inventory", { storeKey }), ports);
  expect(result.code).not.toBe(0);
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(140);
}, 5000);

it("refuses an unrepresentable reply budget before opening or journaling a store", async () => {
  const { ports, storeKey, opened } = fixture();
  ports.config.limits.replyBytes = 10;
  const request = operation("tiny-reply", "inventory", { storeKey });
  await expect(handleAgentOperation(request, ports)).rejects.toThrow(/reply limit/i);
  expect(opened).toEqual([]);
  expect(ports.journal.read(request.id)).toEqual([]);
}, 5000);

it("a cached result never exceeds a lowered reply limit", async () => {
  const { ports, storeKey } = fixture();
  const request = operation("bounded-replay", "inventory", { storeKey });
  const first = await handleAgentOperation(request, ports);
  expect(first.code).toBe(0);
  expect(Buffer.byteLength(JSON.stringify(first))).toBeGreaterThan(180);
  ports.config.limits.replyBytes = 180;
  const limited = await handleAgentOperation(request, ports);
  expect(limited.code).not.toBe(0);
  expect(Buffer.byteLength(JSON.stringify(limited))).toBeLessThanOrEqual(180);
  ports.config.limits.replyBytes = DEFAULT_LIMITS.replyBytes;
  expect(await handleAgentOperation(request, ports)).toEqual(first);
}, 5000);

it("same operation returns committed evidence", async () => {
  const { db, ports, storeKey } = fixture();
  const request = operation("inventory-replay", "inventory", { storeKey });
  const first = await handleAgentOperation(request, ports);
  expect(first.code).toBe(0);
  db.prepare("UPDATE roam_meta SET capture_enabled = 1").run();
  const replay = await handleAgentOperation(request, ports);
  expect(replay).toEqual(first);
  expect(ports.journal.read(request.id).filter(row => row.action === "done")).toHaveLength(1);
}, 5000);

it("changed arguments refuse before effects", async () => {
  const { ports, opened, storeKey } = fixture();
  const request = operation("changed-args", "inventory", { storeKey });
  expect((await handleAgentOperation(request, ports)).code).toBe(0);
  const before = [...opened];
  const changed = await handleAgentOperation({ ...request, args: { storeKey: "repo:other" } }, ports);
  expect(changed.code).toBe(2);
  expect(opened).toEqual(before);
  expect(ports.journal.read(request.id).filter(row => row.action === "done")).toHaveLength(1);
}, 5000);

it("rejects the wrong machine or epoch before opening a store or reserving an operation", async () => {
  const { ports, opened, storeKey } = fixture();
  const request = operation("invalid-target", "inventory", { storeKey });
  expect((await handleAgentOperation({ ...request, machineId: HUB }, ports)).code).toBe(2);
  expect((await handleAgentOperation({ ...request, expectedEpoch: 1 }, ports)).code).toBe(2);
  expect(opened).toEqual([]);
  expect(ports.journal.begin(request)).toEqual({ kind: "new", result: null });
}, 5000);

it("imports an assembled batch once and returns the committed digest receipt", async () => {
  const { destination, batch, manifest, installedFile, request } = await stagedImport();
  const result = await handleAgentOperation(request, destination.ports);
  expect(result).toMatchObject({ code: 0, value: { batchId: "batch-a", stream: batch.header.senderStream,
    through: batch.header.through, sha256: manifest.sha256 } });
  expect(typeof result.value?.applyMs).toBe("number");
  expect(destination.db.prepare("SELECT uuid, text FROM todos").all()).toEqual([{ uuid: "todo-a", text: "portable" }]);
  expect(destination.db.prepare("SELECT uuid FROM run_events").all()).toEqual([{ uuid: "event-a" }]);
  expect(destination.db.prepare("SELECT last_seq FROM roam_cursors WHERE peer_machine = ? AND peer_stream = ?")
    .get(HUB, batch.header.senderStream)).toEqual({ last_seq: batch.header.through });
  expect(destination.notices).toEqual([destination.storeKey]);
  expect(existsSync(installedFile)).toBe(false);
}, 5000);

it("lost import result reconciles exact receipt", async () => {
  const { destination, batch, installedFile, request } = await stagedImport();
  const applyCalls = vi.spyOn(applyApi, "applyBatch");
  const original = destination.ports.journal;
  let committed: JsonObject | null = null;
  destination.ports.journal = {
    ...original,
    record(id, action, result) {
      original.record(id, action, result);
      if (action === "done") { committed = result.value as JsonObject; throw new Error("lost journal reply"); }
    },
  };
  expect((await handleAgentOperation(request, destination.ports)).code).toBe(3);
  expect(existsSync(installedFile)).toBe(true);
  destination.ports.journal = openJournal(join(destination.root, "operations", "journal.db"));
  const replay = await handleAgentOperation(request, destination.ports);
  expect(replay.code).toBe(0);
  expect(replay.value).toEqual(committed);
  expect(destination.db.prepare("SELECT last_seq FROM roam_cursors WHERE peer_machine = ? AND peer_stream = ?")
    .get(HUB, batch.header.senderStream)).toEqual({ last_seq: batch.header.through });
  expect(applyCalls).toHaveBeenCalledTimes(1);
  expect(destination.notices).toEqual([destination.storeKey]);
  expect(existsSync(installedFile)).toBe(false);
}, 5000);

it("replayed receipt after crash has null apply time and identical digest fields", async () => {
  const { destination, batch, installedFile, request } = await stagedImport();
  const applyCalls = vi.spyOn(applyApi, "applyBatch");
  const original = destination.ports.journal;
  let firstReceipt: JsonObject | null = null;
  destination.ports.journal = {
    ...original,
    record(id, action, result) {
      if (action === "done") { firstReceipt = result.value as JsonObject; throw new Error("crash before journal commit"); }
      original.record(id, action, result);
    },
  };
  expect((await handleAgentOperation(request, destination.ports)).code).toBe(3);
  expect(firstReceipt).toMatchObject({ batchId: "batch-a", stream: batch.header.senderStream,
    through: batch.header.through, sha256: batch.sha256, applyMs: expect.any(Number) });
  expect(existsSync(installedFile)).toBe(true);
  const before = {
    todos: destination.db.prepare("SELECT id, uuid, text FROM todos").all(),
    events: destination.db.prepare("SELECT id, uuid FROM run_events").all(),
    changes: destination.db.prepare("SELECT seq, change_id FROM roam_changes ORDER BY seq").all(),
    cursor: destination.db.prepare("SELECT peer_machine, peer_stream, last_seq FROM roam_cursors").all(),
  };
  destination.ports.journal = openJournal(join(destination.root, "operations", "journal.db"));
  const replay = await handleAgentOperation(request, destination.ports);
  expect(replay).toMatchObject({ code: 0, value: { batchId: "batch-a", stream: batch.header.senderStream,
    through: batch.header.through, sha256: batch.sha256, applyMs: null } });
  expect(replay.value).toEqual({ ...firstReceipt!, applyMs: null });
  expect(destination.db.prepare("SELECT id, uuid, text FROM todos").all()).toEqual(before.todos);
  expect(destination.db.prepare("SELECT id, uuid FROM run_events").all()).toEqual(before.events);
  expect(destination.db.prepare("SELECT seq, change_id FROM roam_changes ORDER BY seq").all()).toEqual(before.changes);
  expect(destination.db.prepare("SELECT peer_machine, peer_stream, last_seq FROM roam_cursors").all()).toEqual(before.cursor);
  expect(destination.db.prepare("SELECT count(*) AS n FROM roam_receipts").get()).toEqual({ n: 1 });
  expect(applyCalls).toHaveBeenCalledTimes(1);
  expect(destination.notices).toEqual([destination.storeKey]);
  expect(existsSync(installedFile)).toBe(false);
}, 5000);

it("reconciles a committed store receipt even when staging is unavailable", async () => {
  const { destination, request, batch } = await stagedImport();
  const journal = destination.ports.journal;
  destination.ports.journal = { ...journal, record(id, action, result) {
    if (action === "done") throw new Error("interrupted before journal result");
    journal.record(id, action, result);
  } };
  expect((await handleAgentOperation(request, destination.ports)).code).toBe(3);
  const peerRoot = join(destination.ports.root, "incoming", HUB);
  renameSync(peerRoot, `${peerRoot}-saved`);
  writeFileSync(peerRoot, "unavailable");
  const lockRoot = join(destination.ports.root, "transfer-locks");
  renameSync(lockRoot, `${lockRoot}-saved`);
  writeFileSync(lockRoot, "unavailable");
  destination.ports.journal = openJournal(join(destination.root, "operations", "journal.db"));
  const replay = await handleAgentOperation(request, destination.ports);
  expect(replay).toMatchObject({ code: 0, value: { batchId: "batch-a", stream: batch.header.senderStream,
    through: batch.header.through, sha256: batch.sha256, applyMs: null } });
  expect(readFileSync(peerRoot, "utf8")).toBe("unavailable");
  expect(readFileSync(lockRoot, "utf8")).toBe("unavailable");
  expect(existsSync(`${peerRoot}-saved`)).toBe(true);
}, 5000);

it("returns a journaled receipt when a cleanup lease is unavailable", async () => {
  const { destination, request } = await stagedImport();
  const first = await handleAgentOperation(request, destination.ports);
  expect(first.code).toBe(0);
  const lockRoot = join(destination.ports.root, "transfer-locks");
  renameSync(lockRoot, `${lockRoot}-saved`);
  writeFileSync(lockRoot, "unavailable");
  expect(await handleAgentOperation(request, destination.ports)).toEqual(first);
  expect(readFileSync(lockRoot, "utf8")).toBe("unavailable");
}, 5000);

it("rejects a journaled import result whose digest conflicts with the request", async () => {
  const { destination, request, batch } = await stagedImport();
  destination.ports.journal.begin(request);
  destination.ports.journal.record(request.id, "done", { value: { batchId: batch.header.batchId,
    stream: batch.header.senderStream, through: batch.header.through, sha256: "f".repeat(64), applyMs: 1 } });
  expect((await handleAgentOperation(request, destination.ports)).code).toBe(1);
  expect(destination.db.prepare("SELECT * FROM roam_receipts").all()).toEqual([]);
  expect(destination.db.prepare("SELECT * FROM roam_cursors").all()).toEqual([]);
}, 5000);

it("a killed agent reconciles a committed import in a fresh process", async () => {
  const { destination, batch, request, installedFile } = await stagedImport();
  const script = `
    import { registerHooks } from "node:module";
    import { readFileSync, writeSync } from "node:fs";
    import { pathToFileURL } from "node:url";
    registerHooks({ resolve(specifier, context, next) {
      if (context.parentURL?.endsWith(".ts") && (specifier.startsWith("./") || specifier.startsWith("../")) && !specifier.endsWith(".ts") && !specifier.endsWith(".js")) {
        return next(specifier + ".ts", context);
      }
      return next(specifier, context);
    } });
    const input = JSON.parse(readFileSync(0, "utf8"));
    const { openDb } = await import(pathToFileURL(input.dbModule).href);
    const { openJournal } = await import(pathToFileURL(input.journalModule).href);
    const { handleAgentOperation } = await import(pathToFileURL(input.agentModule).href);
    const { createReplicaEffects } = await import(pathToFileURL(input.effectsModule).href);
    const db = openDb(input.store);
    const journal = openJournal(input.journal);
    let notices = 0;
    const ports = { root: input.root, config: input.config,
      journal: { ...journal, record(id, action, result) {
        if (action === "done") {
          writeSync(1, JSON.stringify({ receipt: result.value, notices }));
          process.kill(process.pid, "SIGKILL");
        }
        journal.record(id, action, result);
      } },
      openStore(key) {
        if (key !== input.storeKey) throw new Error("unknown fixture store");
        return { db, effects: createReplicaEffects(() => notices++), policy: { encode: (_entity, body) => body } };
      },
    };
    await handleAgentOperation(input.operation, ports);
  `;
  const child = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], {
    input: JSON.stringify({ dbModule: fileURLToPath(new URL("../../../db-core/src/db.ts", import.meta.url)),
      journalModule: fileURLToPath(new URL("../journal.ts", import.meta.url)),
      agentModule: fileURLToPath(new URL("../agent.ts", import.meta.url)),
      effectsModule: fileURLToPath(new URL("../../../db-core/src/roam/effects.ts", import.meta.url)),
      store: destination.db.raw.name, storeKey: destination.storeKey, root: destination.ports.root,
      journal: join(destination.root, "operations", "journal.db"), config: destination.ports.config, operation: request }),
    encoding: "utf8", timeout: 4000, env: { ...process.env, NODE_NO_WARNINGS: "1" },
  });
  expect(child.stderr).toBe("");
  expect(child.signal).toBe("SIGKILL");
  const committed = JSON.parse(child.stdout) as { receipt: JsonObject; notices: number };
  expect(committed.receipt).toMatchObject({ batchId: "batch-a", stream: batch.header.senderStream,
    through: batch.header.through, sha256: batch.sha256, applyMs: expect.any(Number) });
  expect(committed.notices).toBe(1);
  expect(destination.ports.journal.begin(request).kind).toBe("pending");
  expect(existsSync(installedFile)).toBe(true);
  const applyCalls = vi.spyOn(applyApi, "applyBatch");
  const replay = await handleAgentOperation(request, destination.ports);
  expect(replay.value).toEqual({ ...committed.receipt, applyMs: null });
  expect(applyCalls).not.toHaveBeenCalled();
  expect(destination.db.prepare("SELECT uuid FROM run_events").all()).toEqual([{ uuid: "event-a" }]);
  expect(destination.db.prepare("SELECT count(*) AS n FROM roam_changes").get()).toEqual({ n: batch.header.count });
  expect(destination.db.prepare("SELECT last_seq FROM roam_cursors WHERE peer_machine = ? AND peer_stream = ?")
    .get(HUB, batch.header.senderStream)).toEqual({ last_seq: batch.header.through });
  expect(destination.notices).toEqual([]);
  expect(existsSync(installedFile)).toBe(false);
}, 5000);

it("refuses an import before applying when its receipt cannot fit the reply limit", async () => {
  const { destination, request, installedFile } = await stagedImport();
  destination.ports.config.limits.replyBytes = 200;
  const result = await handleAgentOperation(request, destination.ports);
  expect(result.code).toBe(2);
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(200);
  expect(destination.db.prepare("SELECT * FROM roam_cursors").all()).toEqual([]);
  expect(destination.db.prepare("SELECT * FROM roam_receipts").all()).toEqual([]);
  expect(existsSync(installedFile)).toBe(true);
}, 5000);

it("does not echo an oversized invalid operation ID", async () => {
  const { ports, opened, storeKey } = fixture();
  ports.config.limits.replyBytes = 512;
  const result = await handleAgentOperation(operation("x".repeat(2000), "inventory", { storeKey }), ports);
  expect(result.code).toBe(2);
  expect(result.operationId).toBe("");
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(512);
  expect(opened).toEqual([]);
}, 5000);

it("conflicting digest for a committed batch never changes its cursor", async () => {
  const { destination, request, batch } = await stagedImport();
  expect((await handleAgentOperation(request, destination.ports)).code).toBe(0);
  const changed = { ...request, id: "conflicting-import", args: { ...request.args, sha256: "0".repeat(64) } };
  expect((await handleAgentOperation(changed, destination.ports)).code).toBe(1);
  expect(destination.db.prepare("SELECT last_seq FROM roam_cursors WHERE peer_machine = ? AND peer_stream = ?")
    .get(HUB, batch.header.senderStream)).toEqual({ last_seq: batch.header.through });
  expect(destination.db.prepare("SELECT count(*) AS n FROM roam_receipts").get()).toEqual({ n: 1 });
  expect(destination.ports.journal.read(changed.id).filter(row => row.action === "done")).toEqual([]);
}, 5000);

it("a mapping fence returns a retryable refusal naming the store", async () => {
  const { destination, request, batch, installedFile } = await stagedImport();
  applyApi.fenceReplicaForMapping(destination.db, destination.storeKey);
  const result = await handleAgentOperation(request, destination.ports);
  expect(result.code).toBe(3);
  expect(result.reason).toContain(destination.storeKey);
  expect(destination.db.prepare("SELECT last_seq FROM roam_cursors WHERE peer_machine = ? AND peer_stream = ?")
    .get(HUB, batch.header.senderStream)).toBeUndefined();
  expect(destination.db.prepare("SELECT * FROM roam_receipts").all()).toEqual([]);
  expect(existsSync(installedFile)).toBe(true);
}, 5000);

it("header mismatch leaves all rows and receipts unchanged", async () => {
  const { destination, request, installedFile } = await stagedImport();
  const header = request.args.header as JsonObject;
  const invalid = { ...request, args: { ...request.args, header: { ...header, batchId: "wrong-batch" } } };
  expect((await handleAgentOperation(invalid, destination.ports)).code).toBe(1);
  expect(destination.db.prepare("SELECT * FROM roam_cursors").all()).toEqual([]);
  expect(destination.db.prepare("SELECT * FROM roam_receipts").all()).toEqual([]);
  expect(destination.db.prepare("SELECT * FROM todos").all()).toEqual([]);
  expect(existsSync(installedFile)).toBe(true);
}, 5000);

it("concurrent imports of one operation commit one receipt", async () => {
  const { destination, request } = await stagedImport();
  const replies = await Promise.all([handleAgentOperation(request, destination.ports), handleAgentOperation(request, destination.ports)]);
  expect(replies.some(reply => reply.code === 0)).toBe(true);
  expect(replies.every(reply => reply.code === 0 || reply.code === 3)).toBe(true);
  const durable = await handleAgentOperation(request, destination.ports);
  expect(durable.code).toBe(0);
  expect(destination.db.prepare("SELECT count(*) AS n FROM roam_receipts").get()).toEqual({ n: 1 });
  expect(destination.db.prepare("SELECT uuid FROM todos").all()).toEqual([{ uuid: "todo-a" }]);
}, 5000);

it("a peer lease keeps an in-flight import pending without mutation", async () => {
  const { destination, request } = await stagedImport();
  const lease = acquireTransferLease(destination.ports.root, HUB, destination.ports.config.limits.peerConcurrency);
  expect(lease).not.toBeNull();
  try {
    expect((await handleAgentOperation(request, destination.ports)).code).toBe(3);
    expect(destination.db.prepare("SELECT * FROM roam_cursors").all()).toEqual([]);
  } finally { lease!(); }
  expect((await handleAgentOperation(request, destination.ports)).code).toBe(0);
}, 5000);

it("reclaims an interrupted validation copy only while holding its peer lease", async () => {
  const { destination, request, manifest, installedFile } = await stagedImport();
  destination.ports.config.limits.stagingBytes = manifest.byteLength * 3;
  const journal = destination.ports.journal;
  journal.begin(request);
  journal.record(request.id, "validation-attempt", { attemptId: "interrupted" });
  const staging = openStaging(destination.ports.root, HUB, destination.ports.config.limits);
  let output: string;
  try {
    const input = staging.reserveValidationCopy(manifest, "interrupted");
    output = join(dirname(input), "00000000-0000-4000-8000-000000000003.ndjson");
    writeFileSync(output, readFileSync(installedFile), { mode: 0o600 });
  } finally { staging.close(); }
  expect(existsSync(output)).toBe(true);
  expect((await handleAgentOperation(request, destination.ports)).code).toBe(0);
  expect(existsSync(output)).toBe(false);
  expect(destination.db.prepare("SELECT count(*) AS n FROM roam_receipts").get()).toEqual({ n: 1 });
}, 5000);

it("a missing durable receipt keeps the staging claim protected from sweep", async () => {
  const { destination, request, batch, manifest, installedFile } = await stagedImport();
  destination.ports.journal.begin(request);
  destination.ports.journal.record(request.id, "done", { value: { batchId: batch.header.batchId,
    stream: batch.header.senderStream, through: batch.header.through, sha256: batch.sha256, applyMs: 1 } });
  expect((await handleAgentOperation(request, destination.ports)).code).toBe(0);
  const staging = openStaging(destination.ports.root, HUB, destination.ports.config.limits);
  try {
    expect(() => staging.removeAfterReceipt(manifest, { artifactId: manifest.id, sha256: manifest.sha256 }, () => true)).toThrow(/still referenced/);
    expect(staging.sweep(Date.now() + destination.ports.config.limits.retentionMs + 1)).not.toContain(manifest.id);
  } finally { staging.close(); }
  expect(existsSync(installedFile)).toBe(true);
  expect(destination.db.prepare("SELECT * FROM roam_receipts").all()).toEqual([]);
}, 5000);

it("a receipt never removes another operation's referenced artifact", async () => {
  const { destination, request, manifest, installedFile } = await stagedImport();
  const staging = openStaging(destination.ports.root, HUB, destination.ports.config.limits);
  try { staging.declare(manifest, "other-claim"); } finally { staging.close(); }
  const result = await handleAgentOperation(request, destination.ports);
  expect(result.code).toBe(0);
  expect(existsSync(installedFile)).toBe(true);
  const resumed = openStaging(destination.ports.root, HUB, destination.ports.config.limits);
  try { resumed.release(manifest.id, "other-claim"); } finally { resumed.close(); }
  expect(await handleAgentOperation(request, destination.ports)).toEqual(result);
  expect(existsSync(installedFile)).toBe(false);
}, 5000);

it("uses the replicated global home to resolve an unlogged todo collision", async () => {
  const { destination, request } = await stagedImport();
  const global = createReplica("global", BOX);
  fixtures.push(global);
  global.db.prepare("INSERT INTO session_homes(session_id, machine_id, epoch, move_id, updated_at) VALUES ('session-a', ?, 1, NULL, 1)").run(HUB);
  const open = destination.ports.openStore;
  destination.ports.openStore = key => key === "global"
    ? { db: global.db, effects: createReplicaEffects(() => undefined), policy: { encode: (_entity, body) => body } } : open(key);
  const row = destination.db.prepare("INSERT INTO todos(uuid, session_id, seq, text, created_at) VALUES ('local-todo', 'session-a', 1, 'local', 1)").run();
  destination.db.prepare("INSERT INTO todos_fts(rowid, text) VALUES (?, 'local')").run(row.lastInsertRowid);
  expect((await handleAgentOperation(request, destination.ports)).code).toBe(0);
  expect(destination.db.prepare("SELECT uuid, text FROM todos").all()).toEqual([{ uuid: "todo-a", text: "portable" }]);
}, 5000);

it("an unavailable global home quarantines an unlogged todo collision", async () => {
  const { destination, request } = await stagedImport();
  const row = destination.db.prepare("INSERT INTO todos(uuid, session_id, seq, text, created_at) VALUES ('local-todo', 'session-a', 1, 'local', 1)").run();
  destination.db.prepare("INSERT INTO todos_fts(rowid, text) VALUES (?, 'local')").run(row.lastInsertRowid);
  const result = await handleAgentOperation(request, destination.ports);
  expect(result.code).toBe(1);
  expect(result.reason).toContain("local-todo");
  expect(result.reason).toContain("todo-a");
  expect(destination.db.prepare("SELECT uuid, text FROM todos").all()).toEqual([{ uuid: "local-todo", text: "local" }]);
  expect(destination.db.prepare("SELECT * FROM roam_cursors").all()).toEqual([]);
  expect(destination.db.prepare("SELECT * FROM roam_receipts").all()).toEqual([]);
}, 5000);

it("a batch near the peer quota is refused before validation", async () => {
  const { destination, manifest, installedFile, request } = await stagedImport();
  destination.ports.config.limits.stagingBytes = manifest.byteLength * 2;
  const validateCalls = vi.spyOn(codecApi, "validateBatch");
  const result = await handleAgentOperation(request, destination.ports);
  expect(result.code).toBe(3);
  expect(result.reason).toMatch(/staging full|quota/i);
  expect(validateCalls).not.toHaveBeenCalled();
  expect(destination.db.prepare("SELECT * FROM roam_cursors").all()).toEqual([]);
  expect(destination.db.prepare("SELECT * FROM roam_receipts").all()).toEqual([]);
  expect(existsSync(installedFile)).toBe(true);
}, 5000);

it("agent accepts private artifact IDs not wire paths", async () => {
  const { destination, request } = await stagedImport();
  const wirePath = join(destination.root, "untrusted-input");
  writeFileSync(wirePath, "unchanged");
  const invalid = { ...request, args: { ...request.args, file: wirePath } };
  expect((await handleAgentOperation(invalid, destination.ports)).code).toBe(2);
  expect(destination.opened).toEqual([]);
  expect(readFileSync(wirePath, "utf8")).toBe("unchanged");
  expect(destination.db.prepare("SELECT * FROM roam_cursors").all()).toEqual([]);
  expect((await handleAgentOperation(request, destination.ports)).code).toBe(0);
}, 5000);

it("corrupt staged bytes leave the cursor and receipt untouched", async () => {
  const { destination, installedFile, request } = await stagedImport();
  const bytes = readFileSync(installedFile);
  bytes[bytes.length - 2] ^= 1;
  writeFileSync(installedFile, bytes);
  expect((await handleAgentOperation(request, destination.ports)).code).not.toBe(0);
  expect(destination.db.prepare("SELECT * FROM roam_cursors").all()).toEqual([]);
  expect(destination.db.prepare("SELECT * FROM roam_receipts").all()).toEqual([]);
  expect(destination.db.prepare("SELECT * FROM roam_changes").all()).toEqual([]);
  expect(existsSync(installedFile)).toBe(true);
}, 5000);

it("cursor inspection reports only committed progress", async () => {
  const { destination, batch, request } = await stagedImport();
  const args = { storeKey: destination.storeKey, sourceMachine: HUB, stream: batch.header.senderStream };
  expect((await handleAgentOperation(operation("cursor-before", "cursor", args), destination.ports)).value).toEqual({ lastSeq: 0 });
  expect((await handleAgentOperation(request, destination.ports)).code).toBe(0);
  expect((await handleAgentOperation(operation("cursor-after", "cursor", args), destination.ports)).value)
    .toEqual({ lastSeq: batch.header.through });
}, 5000);

it("receipt inspection stays pending until the store commits", async () => {
  const { destination, batch, request } = await stagedImport();
  const inspect = operation("receipt-a", "receipt", { storeKey: destination.storeKey, sourceMachine: HUB, batchId: "batch-a" });
  expect((await handleAgentOperation(inspect, destination.ports)).code).toBe(3);
  expect(destination.ports.journal.read(inspect.id).filter(row => row.action === "done")).toEqual([]);
  expect((await handleAgentOperation(request, destination.ports)).code).toBe(0);
  expect(await handleAgentOperation(inspect, destination.ports)).toMatchObject({ code: 0, value: {
    batchId: "batch-a", stream: batch.header.senderStream, through: batch.header.through, sha256: batch.sha256, applyMs: null,
  } });
}, 5000);

it("enable-capture seeds memory once and captures later writes", async () => {
  const { db, ports, storeKey } = fixture();
  db.prepare("UPDATE roam_meta SET store_key = NULL").run();
  db.prepare("INSERT INTO memory(uuid, category, content, status, source, created_at) VALUES ('memory-a', 'insight', 'first', 'active', 'user', 1)").run();
  const request = operation("enable-a", "enable-capture", { storeKey });
  const first = await handleAgentOperation(request, ports);
  expect(first).toMatchObject({ code: 0, value: { storeKey, enabled: true } });
  expect(db.prepare("SELECT store_key, capture_enabled FROM roam_meta").get()).toEqual({ store_key: storeKey, capture_enabled: 1 });
  expect(db.prepare("SELECT entity, row_key FROM roam_changes").all()).toEqual([{ entity: "memory", row_key: "memory-a" }]);
  expect(await handleAgentOperation(request, ports)).toEqual(first);
  db.prepare("INSERT INTO memory(uuid, category, content, status, source, created_at) VALUES ('memory-b', 'insight', 'later', 'active', 'user', 2)").run();
  expect(db.prepare("SELECT row_key FROM roam_changes ORDER BY seq").all()).toEqual([{ row_key: "memory-a" }, { row_key: "memory-b" }]);
}, 5000);

it("enable-capture refuses an unsafe layout and invalid worktree key", async () => {
  const { db, ports, storeKey, opened } = fixture();
  const invalid = operation("bad-enable", "enable-capture", { storeKey: "worktree:repo:checkout" });
  expect((await handleAgentOperation(invalid, ports)).code).toBe(2);
  expect(opened).toEqual([]);
  db.exec("DROP TRIGGER roam_memory_capture_ai");
  const request = operation("unsafe-enable", "enable-capture", { storeKey });
  const refused = await handleAgentOperation(request, ports);
  expect(refused.code).toBe(1);
  expect(refused.reason).toMatch(/capture.*unsafe|layout/i);
  expect(db.prepare("SELECT capture_enabled FROM roam_meta").get()).toEqual({ capture_enabled: 0 });
  expect(db.prepare("SELECT * FROM roam_changes").all()).toEqual([]);
  expect(ports.journal.read(request.id).filter(row => row.action === "done")).toEqual([]);
}, 5000);

it("capture is not enabled when its result cannot fit the reply budget", async () => {
  const { db, ports, storeKey } = fixture();
  db.prepare("INSERT INTO memory(uuid, category, content, status, source, created_at) VALUES ('memory-a', 'insight', 'first', 'active', 'user', 1)").run();
  ports.config.limits.replyBytes = 140;
  const request = operation("x".repeat(100), "enable-capture", { storeKey });
  const result = await handleAgentOperation(request, ports);
  expect(result.code).not.toBe(0);
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(140);
  expect(db.prepare("SELECT capture_enabled FROM roam_meta").get()).toEqual({ capture_enabled: 0 });
  expect(db.prepare("SELECT * FROM roam_changes").all()).toEqual([]);
}, 5000);

it("capture enablement resumes after its journal result is lost", async () => {
  const { db, ports, storeKey, root } = fixture();
  db.prepare("INSERT INTO memory(uuid, category, content, status, source, created_at) VALUES ('memory-a', 'insight', 'first', 'active', 'user', 1)").run();
  const request = operation("enable-retry", "enable-capture", { storeKey });
  const journal = ports.journal;
  ports.journal = { ...journal, record(id, action, result) {
    if (action === "done") throw new Error("lost before journal result");
    journal.record(id, action, result);
  } };
  expect((await handleAgentOperation(request, ports)).code).toBe(3);
  ports.journal = openJournal(join(root, "operations", "journal.db"));
  expect((await handleAgentOperation(request, ports)).code).toBe(0);
  expect(db.prepare("SELECT entity, row_key FROM roam_changes").all()).toEqual([{ entity: "memory", row_key: "memory-a" }]);
}, 5000);

it("exports immutable batches and serves bounded linked manifest pages", async () => {
  const { db, ports, storeKey, root } = fixture();
  ports.config.limits.chunkBytes = 32;
  ports.config.limits.manifestBytes = 420;
  ports.config.limits.replyBytes = 2048;
  expect((await handleAgentOperation(operation("enable-export", "enable-capture", { storeKey }), ports)).code).toBe(0);
  db.prepare("INSERT INTO memory(uuid, category, content, status, source, created_at) VALUES ('memory-a', 'insight', ?, 'active', 'user', 1)").run("portable ".repeat(100));
  const result = await handleAgentOperation(operation("export-a", "export", { storeKey, after: 0, targetBytes: 4096, batchId: "batch-a" }), ports);
  expect(result.code).toBe(0);
  expect(JSON.stringify(result)).not.toContain(root);
  const header = result.value!.header as JsonObject;
  const artifact = result.value!.artifact as JsonObject;
  expect(header).toMatchObject({ batchId: "batch-a", storeKey, after: 0, through: 1, count: 1, senderMachine: BOX });
  expect(artifact).toMatchObject({ id: "export-a", kind: "batch", sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
  expect(artifact.pageCount).toBeGreaterThan(1);
  expect(artifact.pageBytes).toBe(420);
  ports.config.limits.manifestBytes = 600;
  const pages: Buffer[] = [];
  for (let index = 0; index < (artifact.pageCount as number); index++) {
    const page = await handleAgentOperation(operation(`split-${index}`, "split", {
      artifactId: artifact.id, manifestDigest: artifact.manifestDigest, head: artifact.head, pageBytes: artifact.pageBytes, index,
    }), ports);
    expect(page.code).toBe(0);
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(ports.config.limits.replyBytes);
    pages.push(Buffer.from(JSON.stringify(page.value!.page)));
  }
  const manifest = readManifestPages(artifact.head as string, pages, ports.config.limits);
  expect(manifestDigest(manifest)).toBe(artifact.manifestDigest);
  expect(manifest.sha256).toBe(artifact.sha256);
  const bytes = Buffer.concat(manifest.chunks.map(chunk => readPrivate(sourceChunk(ports.root, manifest.id, chunk.index, chunk.sha256), chunk.rawLength)));
  expect(JSON.parse(bytes.toString("utf8").split("\n")[0])).toEqual(header);
}, 5000);

it("an oversized export names the row without staging a partial batch", async () => {
  const { db, ports, storeKey } = fixture();
  expect((await handleAgentOperation(operation("enable-large", "enable-capture", { storeKey }), ports)).code).toBe(0);
  db.prepare("INSERT INTO memory(uuid, category, content, status, source, created_at) VALUES ('large-row', 'insight', ?, 'active', 'user', 1)").run("x".repeat(2048));
  ports.config.limits.hardBatchBytes = 512;
  const request = operation("export-large", "export", { storeKey, after: 0, targetBytes: 256, batchId: "batch-large" });
  const result = await handleAgentOperation(request, ports);
  expect(result.code).toBe(1);
  expect(result.reason).toContain("memory/large-row");
  expect(ports.journal.read(request.id).filter(row => row.action === "done")).toEqual([]);
  expect(existsSync(join(ports.root, "outgoing", request.id))).toBe(false);
}, 5000);

it("export does not create a snapshot if its descriptor cannot fit the reply budget", async () => {
  const { db, ports, storeKey } = fixture();
  expect((await handleAgentOperation(operation("enable-small-reply", "enable-capture", { storeKey }), ports)).code).toBe(0);
  db.prepare("INSERT INTO memory(uuid, category, content, status, source, created_at) VALUES ('memory-a', 'insight', 'first', 'active', 'user', 1)").run();
  ports.config.limits.replyBytes = 140;
  const request = operation("x".repeat(100), "export", { storeKey, after: 0, targetBytes: 4096, batchId: "batch-small-reply" });
  const result = await handleAgentOperation(request, ports);
  expect(result.code).not.toBe(0);
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(140);
  expect(ports.journal.read(request.id)).toEqual([]);
  expect(existsSync(join(ports.root, "outgoing"))).toBe(false);
}, 5000);

it("a completed export does not report unavailable staged chunks as usable", async () => {
  const { db, ports, storeKey } = fixture();
  expect((await handleAgentOperation(operation("enable-missing", "enable-capture", { storeKey }), ports)).code).toBe(0);
  db.prepare("INSERT INTO memory(uuid, category, content, status, source, created_at) VALUES ('memory-a', 'insight', 'first', 'active', 'user', 1)").run();
  const request = operation("export-missing", "export", { storeKey, after: 0, targetBytes: 4096, batchId: "batch-missing" });
  const first = await handleAgentOperation(request, ports);
  expect(first.code).toBe(0);
  const artifact = first.value!.artifact as JsonObject;
  const outgoing = openOutgoingStaging(ports.root, ports.config.limits, false);
  let chunk: string;
  try {
    const manifest = outgoing.get(artifact.id as string, artifact.manifestDigest as string)!;
    chunk = sourceChunk(ports.root, manifest.id, 0, manifest.chunks[0].sha256);
  } finally { outgoing.close(); }
  renameSync(chunk, `${chunk}-saved`);
  const exports = vi.spyOn(exportApi, "exportBatch");
  expect((await handleAgentOperation(request, ports)).code).toBe(3);
  expect(exports).not.toHaveBeenCalled();
  expect(ports.journal.read(request.id).filter(row => row.action === "done")).toHaveLength(1);
}, 5000);

it.skipIf(process.platform === "win32")("export cleanup refuses a replaced snapshot directory", async () => {
  const { db, ports, storeKey, root } = fixture();
  expect((await handleAgentOperation(operation("enable-cleanup", "enable-capture", { storeKey }), ports)).code).toBe(0);
  db.prepare("INSERT INTO memory(uuid, category, content, status, source, created_at) VALUES ('memory-a', 'insight', 'first', 'active', 'user', 1)").run();
  const request = operation("export-cleanup", "export", { storeKey, after: 0, targetBytes: 4096, batchId: "batch-cleanup" });
  const journal = ports.journal;
  const outside = join(root, "outside");
  mkdirSync(outside, { mode: 0o700 });
  let sentinel = "";
  ports.journal = { ...journal, record(id, action, result) {
    journal.record(id, action, result);
    if (action === "done" && id === request.id) {
      const saved = journal.read(id).find(row => row.action === "export-snapshot")!.result.file as string;
      const directory = dirname(saved);
      sentinel = join(outside, basename(saved));
      writeFileSync(sentinel, "untouched", { mode: 0o600 });
      renameSync(directory, `${directory}-saved`);
      symlinkSync(outside, directory);
    }
  } };
  expect((await handleAgentOperation(request, ports)).code).toBe(0);
  expect(readFileSync(sentinel, "utf8")).toBe("untouched");
}, 5000);

it("snapshots operation identity and arguments before asynchronous work", async () => {
  const { db, ports, storeKey } = fixture();
  expect((await handleAgentOperation(operation("enable-snapshot-input", "enable-capture", { storeKey }), ports)).code).toBe(0);
  db.prepare("INSERT INTO memory(uuid, category, content, status, source, created_at) VALUES ('memory-a', 'insight', 'first', 'active', 'user', 1)").run();
  const request = operation("stable-export", "export", { storeKey, after: 0, targetBytes: 4096, batchId: "stable-batch" });
  const pending = handleAgentOperation(request, ports);
  request.id = "changed-after-dispatch";
  request.args.batchId = "changed-batch";
  const result = await pending;
  expect(result).toMatchObject({ code: 0, operationId: "stable-export", value: { header: { batchId: "stable-batch", through: 1 } } });
  expect(ports.journal.read("stable-export").filter(row => row.action === "done")).toHaveLength(1);
  expect(ports.journal.read("changed-after-dispatch")).toEqual([]);
}, 5000);

it("concurrent exports reuse one committed result and clean every recorded snapshot", async () => {
  const { db, ports, storeKey } = fixture();
  expect((await handleAgentOperation(operation("enable-concurrent", "enable-capture", { storeKey }), ports)).code).toBe(0);
  db.prepare("INSERT INTO memory(uuid, category, content, status, source, created_at) VALUES ('memory-a', 'insight', 'first', 'active', 'user', 1)").run();
  const request = operation("concurrent-export", "export", { storeKey, after: 0, targetBytes: 4096, batchId: "batch-concurrent" });
  const replies = await Promise.all([handleAgentOperation(request, ports), handleAgentOperation(request, ports)]);
  expect(replies[0].code).toBe(0);
  expect(replies[1]).toEqual(replies[0]);
  const snapshots = ports.journal.read(request.id).filter(row => row.action === "export-snapshot");
  expect(snapshots.length).toBeGreaterThan(0);
  for (const saved of snapshots) expect(existsSync(saved.result.file as string)).toBe(false);
}, 5000);

it("an export snapshot survives a lost journal acknowledgement before staging", async () => {
  const { db, ports, storeKey, root } = fixture();
  expect((await handleAgentOperation(operation("enable-snapshot", "enable-capture", { storeKey }), ports)).code).toBe(0);
  db.prepare("INSERT INTO memory(uuid, category, content, status, source, created_at) VALUES ('memory-a', 'insight', 'first', 'active', 'user', 1)").run();
  const journal = ports.journal;
  const exports = vi.spyOn(exportApi, "exportBatch");
  ports.journal = { ...journal, record(id, action, result) {
    journal.record(id, action, result);
    if (action === "export-snapshot") throw new Error("lost snapshot acknowledgement");
  } };
  const request = operation("export-snapshot", "export", { storeKey, after: 0, targetBytes: 4096, batchId: "batch-snapshot" });
  expect((await handleAgentOperation(request, ports)).code).toBe(3);
  db.prepare("INSERT INTO memory(uuid, category, content, status, source, created_at) VALUES ('memory-b', 'insight', 'later', 'active', 'user', 2)").run();
  ports.journal = openJournal(join(root, "operations", "journal.db"));
  const replay = await handleAgentOperation(request, ports);
  expect(replay.code).toBe(0);
  expect((replay.value!.header as JsonObject).through).toBe(1);
  expect(exports).toHaveBeenCalledTimes(1);
}, 5000);

it("pending export reuses its snapshot after later store writes", async () => {
  const { db, ports, storeKey, root } = fixture();
  expect((await handleAgentOperation(operation("enable-export-retry", "enable-capture", { storeKey }), ports)).code).toBe(0);
  db.prepare("INSERT INTO memory(uuid, category, content, status, source, created_at) VALUES ('memory-a', 'insight', 'first', 'active', 'user', 1)").run();
  const exports = vi.spyOn(exportApi, "exportBatch");
  const original = ports.journal;
  let first: JsonObject | null = null;
  ports.journal = { ...original, record(id, action, result) {
    if (action === "done") { first = result.value as JsonObject; throw new Error("lost before journal result"); }
    original.record(id, action, result);
  } };
  const request = operation("export-retry", "export", { storeKey, after: 0, targetBytes: 4096, batchId: "batch-retry" });
  expect((await handleAgentOperation(request, ports)).code).toBe(3);
  db.prepare("INSERT INTO memory(uuid, category, content, status, source, created_at) VALUES ('memory-b', 'insight', 'later', 'active', 'user', 2)").run();
  ports.journal = openJournal(join(root, "operations", "journal.db"));
  const replay = await handleAgentOperation(request, ports);
  expect(replay.code).toBe(0);
  expect(replay.value).toEqual(first);
  expect((replay.value!.header as JsonObject).through).toBe(1);
  expect(exports).toHaveBeenCalledTimes(1);
}, 5000);

it("empty exports have no artifact or import receipt", async () => {
  const { db, ports, storeKey } = fixture();
  const result = await handleAgentOperation(operation("empty-export", "export", { storeKey, after: 0, targetBytes: 4096, batchId: "empty" }), ports);
  expect(result).toMatchObject({ code: 0, value: { header: { after: 0, through: 0, count: 0 }, artifact: null } });
  expect(db.prepare("SELECT * FROM roam_receipts").all()).toEqual([]);
  expect(existsSync(join(ports.root, "outgoing", "empty-export"))).toBe(false);
}, 5000);

it("assembles a claimed incoming artifact without exposing a path", async () => {
  const { destination, manifest } = await stagedImport();
  const request = operation("assemble-a", "assemble", { sourceMachine: HUB, transferId: "transfer-a",
    artifactId: manifest.id, sha256: manifest.sha256 });
  const result = await handleAgentOperation(request, destination.ports);
  expect(result).toMatchObject({ code: 0, value: { artifactId: manifest.id, sha256: manifest.sha256, byteLength: manifest.byteLength } });
  expect(JSON.stringify(result)).not.toContain(destination.root);
  expect(await handleAgentOperation(request, destination.ports)).toEqual(result);
  expect(destination.db.prepare("SELECT * FROM roam_cursors").all()).toEqual([]);
}, 5000);

it("an assembly replay reconstructs missing output and refuses missing chunks", async () => {
  const { destination, manifest, installedFile } = await stagedImport();
  const request = operation("assemble-replay", "assemble", { sourceMachine: HUB, transferId: "transfer-a",
    artifactId: manifest.id, sha256: manifest.sha256 });
  const first = await handleAgentOperation(request, destination.ports);
  expect(first.code).toBe(0);
  renameSync(installedFile, `${installedFile}-saved`);
  expect(await handleAgentOperation(request, destination.ports)).toEqual(first);
  expect(existsSync(installedFile)).toBe(true);
  const staging = openStaging(destination.ports.root, HUB, destination.ports.config.limits);
  let chunk: string;
  try { chunk = staging.chunkFile(manifest, 0); } finally { staging.close(); }
  renameSync(installedFile, `${installedFile}-missing`);
  renameSync(chunk, `${chunk}-missing`);
  expect((await handleAgentOperation(request, destination.ports)).code).toBe(3);
  expect(existsSync(installedFile)).toBe(false);
}, 5000);

it("assembly does not reconstruct an artifact when its reply cannot fit", async () => {
  const { destination, manifest, installedFile } = await stagedImport();
  renameSync(installedFile, `${installedFile}-saved`);
  destination.ports.config.limits.replyBytes = 140;
  const request = operation("x".repeat(100), "assemble", { sourceMachine: HUB, transferId: "transfer-a",
    artifactId: manifest.id, sha256: manifest.sha256 });
  const result = await handleAgentOperation(request, destination.ports);
  expect(result.code).not.toBe(0);
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(140);
  expect(existsSync(installedFile)).toBe(false);
  expect(destination.ports.journal.read(request.id)).toEqual([]);
}, 5000);

it("dispatches artifact receive with raw bytes under the authenticated source", async () => {
  const destination = fixture();
  const sourceRoot = join(destination.root, "source-staging");
  const file = join(destination.root, "binary-source");
  const bytes = Buffer.from([0, 255, 10, 128, 27, 0, 42]);
  writeFileSync(file, bytes);
  const manifest = await stageArtifact(file, "agent", { ...DEFAULT_LIMITS, chunkBytes: 3 }, { root: sourceRoot, artifactId: "binary-a" });
  destination.ports.config.limits.chunkBytes = 3;
  const peer: Peer = { machineId: BOX, alias: "box-1.invalid", node: "/node", pi: "/pi", cli: "/cli", core: "/core", globalRoot: destination.root };
  const commands: string[][] = [];
  const transport: Transport = {
    async resolve(value) { return value; },
    async exec(_peer, argv, options) {
      commands.push([...argv.slice(0, 3)]);
      return dispatchArtifactCommand(argv, options.stdin, HUB, destination.ports);
    },
    async run() { throw new Error("unexpected run"); },
    async read() { throw new Error("unexpected read"); },
    async write() { throw new Error("unexpected write"); },
  };
  const result = await transferArtifact(peer, manifest, { transport, journal: openJournal(join(destination.root, "source", "journal.db")),
    root: sourceRoot, limits: destination.ports.config.limits, operationId: "send-a" });
  expect(result.code).toBe(0);
  expect(commands.length).toBeGreaterThan(0);
  expect(commands.every(argv => JSON.stringify(argv) === JSON.stringify(["roam", "artifact", "receive"]))).toBe(true);
  const staging = openStaging(destination.ports.root, HUB, destination.ports.config.limits);
  try {
    expect(staging.manifestFor("send-a")).toEqual(manifest);
    expect(readFileSync(staging.assemble(manifest))).toEqual(bytes);
  } finally { staging.close(); }
  expect(existsSync(join(destination.ports.root, "incoming", BOX))).toBe(false);
}, 5000);

it("two agents export transfer and import one committed batch", async () => {
  const destination = fixture("repo");
  const source = createReplica("repo", HUB);
  fixtures.push(source);
  const peer: Peer = { machineId: BOX, alias: "box-1.invalid", node: "/node", pi: "/pi", cli: "/cli", core: "/core", globalRoot: destination.root };
  const sourcePorts: AgentPorts = { root: join(source.root, "roam", "staging"), journal: openJournal(join(source.root, "operations", "journal.db")),
    config: { ...destination.ports.config, role: "hub", machineId: HUB, hubMachineId: HUB, peers: [peer] },
    openStore(key) {
      if (key !== source.storeKey) throw new Error("unknown fixture store");
      return { db: source.db, effects: createReplicaEffects(() => undefined), policy: { encode: (_entity, body) => body } };
    } };
  const sourceOperation = (id: string, kind: string, args: JsonObject): Operation => ({ ...operation(id, kind, args), machineId: HUB });
  expect((await handleAgentOperation(sourceOperation("enable-source", "enable-capture", { storeKey: source.storeKey }), sourcePorts)).code).toBe(0);
  source.db.prepare("INSERT INTO memory(uuid, category, content, status, source, created_at) VALUES ('memory-a', 'insight', 'portable', 'active', 'user', 1)").run();
  const exported = await handleAgentOperation(sourceOperation("export-flow", "export", { storeKey: source.storeKey,
    after: 0, targetBytes: 4096, batchId: "batch-flow" }), sourcePorts);
  expect(exported.code).toBe(0);
  const artifact = exported.value!.artifact as JsonObject;
  const pages: Buffer[] = [];
  for (let index = 0; index < (artifact.pageCount as number); index++) {
    const page = await handleAgentOperation(sourceOperation(`flow-page-${index}`, "split", { artifactId: artifact.id,
      manifestDigest: artifact.manifestDigest, head: artifact.head, pageBytes: artifact.pageBytes, index }), sourcePorts);
    expect(page.code).toBe(0);
    pages.push(Buffer.from(JSON.stringify(page.value!.page)));
  }
  const manifest = readManifestPages(artifact.head as string, pages, sourcePorts.config.limits);
  const transport: Transport = {
    async resolve(value) { return value; },
    async exec(_peer, argv, options) { return dispatchArtifactCommand(argv, options.stdin, HUB, destination.ports); },
    async run() { throw new Error("unexpected run"); },
    async read() { throw new Error("unexpected read"); },
    async write() { throw new Error("unexpected write"); },
  };
  const transfer = await transferArtifact(peer, manifest, { root: sourcePorts.root, journal: sourcePorts.journal,
    transport, limits: sourcePorts.config.limits, operationId: "transfer-flow" });
  expect(transfer.code).toBe(0);
  const imported = await handleAgentOperation(operation("import-flow", "import", { storeKey: destination.storeKey, sourceMachine: HUB,
    transferId: "transfer-flow", artifactId: manifest.id, sha256: manifest.sha256, header: exported.value!.header }), destination.ports);
  expect(imported).toMatchObject({ code: 0, value: { batchId: "batch-flow", sha256: manifest.sha256, through: 1 } });
  expect(destination.db.prepare("SELECT uuid, content FROM memory").all()).toEqual([{ uuid: "memory-a", content: "portable" }]);
  expect(destination.db.prepare("SELECT last_seq FROM roam_cursors WHERE peer_machine = ?").get(HUB)).toEqual({ last_seq: 1 });
  expect(destination.db.prepare("SELECT count(*) AS n FROM roam_receipts").get()).toEqual({ n: 1 });
}, 5000);

it("a hub pulls an agent export using the served manifest pages", async () => {
  const box = fixture("repo");
  const hub = createReplica("repo", HUB);
  fixtures.push(hub);
  const peer: Peer = { machineId: BOX, alias: "box-1.invalid", node: "/node", pi: "/pi", cli: "/cli", core: "/core", globalRoot: box.root };
  const hubPorts: AgentPorts = { root: join(hub.root, "roam", "staging"), journal: openJournal(join(hub.root, "operations", "journal.db")),
    config: { ...box.ports.config, role: "hub", machineId: HUB, hubMachineId: HUB, peers: [peer] },
    openStore(key) {
      if (key !== hub.storeKey) throw new Error("unknown fixture store");
      return { db: hub.db, effects: createReplicaEffects(() => undefined), policy: { encode: (_entity, body) => body } };
    } };
  expect((await handleAgentOperation(operation("enable-box", "enable-capture", { storeKey: box.storeKey }), box.ports)).code).toBe(0);
  box.db.prepare("INSERT INTO memory(uuid, category, content, status, source, created_at) VALUES ('memory-a', 'insight', 'portable', 'active', 'user', 1)").run();
  const exported = await handleAgentOperation(operation("box-export", "export", { storeKey: box.storeKey,
    after: 0, targetBytes: 4096, batchId: "box-batch" }), box.ports);
  expect(exported.code).toBe(0);
  const artifact = exported.value!.artifact as JsonObject;
  const pages: Buffer[] = [];
  for (let index = 0; index < (artifact.pageCount as number); index++) {
    const page = await handleAgentOperation(operation(`box-page-${index}`, "split", { artifactId: artifact.id,
      manifestDigest: artifact.manifestDigest, head: artifact.head, pageBytes: artifact.pageBytes, index }), box.ports);
    expect(page.code).toBe(0);
    pages.push(Buffer.from(JSON.stringify(page.value!.page)));
  }
  const manifest = readManifestPages(artifact.head as string, pages, hubPorts.config.limits);
  const transport: Transport = {
    async resolve(value) { return value; },
    async read(_peer, file, options) { return readPrivate(file, options.maxBytes); },
    async exec() { throw new Error("unexpected exec"); },
    async run() { throw new Error("unexpected run"); },
    async write() { throw new Error("unexpected write"); },
  };
  const pulled = await pullArtifact(peer, manifest, { root: hubPorts.root, journal: hubPorts.journal,
    transport, limits: hubPorts.config.limits, operationId: "pull-flow" });
  expect(pulled.code).toBe(0);
  const request = { ...operation("hub-import", "import", { storeKey: hub.storeKey, sourceMachine: BOX, transferId: "pull-flow",
    artifactId: manifest.id, sha256: manifest.sha256, header: exported.value!.header }), machineId: HUB };
  expect((await handleAgentOperation(request, hubPorts)).code).toBe(0);
  expect(hub.db.prepare("SELECT uuid, content FROM memory").all()).toEqual([{ uuid: "memory-a", content: "portable" }]);
  expect(hub.db.prepare("SELECT last_seq FROM roam_cursors WHERE peer_machine = ?").get(BOX)).toEqual({ last_seq: 1 });
}, 5000);

it("artifact receive reports staging exhaustion as retryable and resumes the same operation", async () => {
  const destination = fixture();
  destination.ports.config.limits.stagingBytes = 4;
  const bytes = Buffer.from("12345");
  const digest = hash(bytes);
  const manifest: ArtifactManifest = { id: "quota-artifact", kind: "batch", byteLength: bytes.length,
    sha256: digest, chunks: [{ index: 0, rawLength: bytes.length, sha256: digest }] };
  const pages = createManifestPages(manifest, destination.ports.config.limits);
  const request = { operation: { id: "quota-transfer", machineId: BOX, expectedEpoch: null, kind: "artifact-transfer",
    args: { artifactId: manifest.id, kind: manifest.kind, byteLength: manifest.byteLength, sha256: manifest.sha256,
      manifestDigest: manifestDigest(manifest), head: pages.head, pageCount: pages.pages.length } }, action: "begin" };
  const begin = JSON.parse((await handleAgentArtifactRequest(request, undefined, HUB, destination.ports)).toString("utf8"));
  expect(begin.code).toBe(0);
  const put = { ...request, action: "page", index: 0 };
  const full = JSON.parse((await handleAgentArtifactRequest(put, pages.pages[0], HUB, destination.ports)).toString("utf8"));
  expect(full.code).toBe(3);
  expect(full.reason).toContain("Staging full");
  expect(full.reason).toContain(join(destination.ports.root, "incoming", HUB));
  destination.ports.config.limits.stagingBytes = 1000;
  const resumed = JSON.parse((await handleAgentArtifactRequest(put, pages.pages[0], HUB, destination.ports)).toString("utf8"));
  expect(resumed.code).toBe(0);
}, 5000);

it("rejects an artifact operation from an unenrolled but self-consistent source", async () => {
  const destination = fixture();
  const stranger = "00000000-0000-4000-8000-000000000003";
  const bytes = Buffer.from("abc");
  const digest = hash(bytes);
  const manifest: ArtifactManifest = { id: "stranger-artifact", kind: "batch", byteLength: bytes.length,
    sha256: digest, chunks: [{ index: 0, rawLength: bytes.length, sha256: digest }] };
  const pages = createManifestPages(manifest, destination.ports.config.limits);
  const request = { operation: { id: "stranger-transfer", machineId: BOX, expectedEpoch: null, kind: "artifact-transfer",
    args: { artifactId: manifest.id, kind: manifest.kind, byteLength: manifest.byteLength, sha256: manifest.sha256,
      manifestDigest: manifestDigest(manifest), head: pages.head, pageCount: pages.pages.length } }, action: "begin" };
  const reply = JSON.parse((await handleAgentArtifactRequest(request, undefined, stranger, destination.ports)).toString("utf8"));
  expect(reply.code).toBe(2);
  expect(existsSync(destination.ports.root)).toBe(false);
}, 5000);

it("rejects malformed or duplicate-key artifact command arguments before staging", async () => {
  const destination = fixture();
  for (const argv of [
    ["roam", "artifact", "receive", "{bad"],
    ["roam", "artifact", "receive", '{"operation":{},"operation":{}}'],
    ["roam", "artifact", "other", "{}"],
  ]) {
    const reply = await dispatchArtifactCommand(argv, Buffer.from([0, 255]), HUB, destination.ports);
    expect(JSON.parse(reply.toString("utf8")).code).toBe(2);
  }
  expect(existsSync(destination.ports.root)).toBe(false);
}, 5000);

it("production agent ports share the default peer lease", async () => {
  const destination = fixture();
  const { root: _isolatedRoot, ...dependencies } = destination.ports;
  const ports = createAgentPorts(dependencies);
  expect(ports.root).toBe(defaultStagingRoot());
  const lease = acquireTransferLease(defaultStagingRoot(), HUB, ports.config.limits.peerConcurrency);
  expect(lease).not.toBeNull();
  try {
    const request = { operation: { id: "leased", machineId: BOX, expectedEpoch: null, kind: "artifact-transfer", args: {} }, action: "begin" };
    const result = await handleAgentArtifactRequest(request, undefined, HUB, ports);
    expect(JSON.parse(result.toString("utf8")).code).toBe(3);
    expect(ports.journal.read("leased")).toEqual([]);
  } finally { lease!(); }
}, 5000);

it("artifact receive rejects an untrusted source before opening staging", async () => {
  const destination = fixture();
  const input = { operation: { id: "send-b", machineId: BOX, expectedEpoch: null, kind: "artifact-transfer", args: {} }, action: "begin" };
  const reply = await handleAgentArtifactRequest(input, undefined, "00000000-0000-4000-8000-000000000003", destination.ports);
  expect(JSON.parse(reply.toString("utf8")).code).toBe(2);
  expect(existsSync(join(destination.ports.root, "incoming"))).toBe(false);
  expect(destination.ports.journal.read("send-b")).toEqual([]);
}, 5000);

it("artifact receive reports a full staging quota as retryable", async () => {
  const destination = fixture();
  const file = join(destination.root, "small-source");
  writeFileSync(file, "data");
  const limits = { ...DEFAULT_LIMITS, stagingBytes: 8 };
  destination.ports.config.limits = limits;
  const manifest = await stageArtifact(file, "agent", limits, { root: join(destination.root, "outgoing-source"), artifactId: "quota-a" });
  const pages = createManifestPages(manifest, limits);
  const transfer: Operation = { id: "quota-transfer", machineId: BOX, expectedEpoch: null, kind: "artifact-transfer",
    args: { artifactId: manifest.id, kind: manifest.kind, byteLength: manifest.byteLength, sha256: manifest.sha256,
      manifestDigest: manifestDigest(manifest), head: pages.head, pageCount: pages.pages.length } };
  const begin = await handleAgentArtifactRequest({ operation: transfer, action: "begin" }, undefined, HUB, destination.ports);
  expect(JSON.parse(begin.toString("utf8")).code).toBe(0);
  const page = await handleAgentArtifactRequest({ operation: transfer, action: "page", index: 0 }, pages.pages[0], HUB, destination.ports);
  expect(JSON.parse(page.toString("utf8"))).toMatchObject({ code: 3, reason: expect.stringMatching(/staging full/i) });
  expect(destination.ports.journal.read(transfer.id).filter(row => row.action === "done")).toEqual([]);
  destination.ports.config.limits.stagingBytes = pages.pages[0].length + 8;
  const retry = await handleAgentArtifactRequest({ operation: transfer, action: "page", index: 0 }, pages.pages[0], HUB, destination.ports);
  expect(JSON.parse(retry.toString("utf8"))).toMatchObject({ code: 0, state: "pending" });
}, 5000);

it("malformed manifest errors never expose raw incoming content", async () => {
  const destination = fixture();
  const sensitive = "pw42";
  const bytes = Buffer.from(`${sensitive}{`);
  const transfer: Operation = { id: "invalid-page", machineId: BOX, expectedEpoch: null, kind: "artifact-transfer",
    args: { artifactId: "invalid-artifact", kind: "agent", byteLength: 100, sha256: "1".repeat(64),
      manifestDigest: "2".repeat(64), head: hash(bytes), pageCount: 1 } };
  const begin = await handleAgentArtifactRequest({ operation: transfer, action: "begin" }, undefined, HUB, destination.ports);
  expect(JSON.parse(begin.toString("utf8")).code).toBe(0);
  const page = await handleAgentArtifactRequest({ operation: transfer, action: "page", index: 0 }, bytes, HUB, destination.ports);
  expect(JSON.parse(page.toString("utf8")).code).toBe(1);
  expect(page.toString("utf8")).not.toContain(sensitive);
  expect(destination.ports.journal.read(transfer.id).filter(row => row.action === "done")).toEqual([]);
}, 5000);

import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, watch, writeFileSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { openDb, type Db } from "../db";
import { createReplica, scratchDbPath } from "@spider/db-core/testutil";
import { enableMemoryCapture, seedSession } from "../roam/seed";
import { exportBatch } from "@spider/db-core/roam/export";
import { validateBatch } from "@spider/db-core/roam/codec";
import type { BatchArtifact, BatchHeader, ExportPolicy, RecordChange, StoreKey } from "@spider/db-core/roam/types";

const MACHINE = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const STREAM = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const STORE = "worktree:fixture-repo:fixture-workspace";
const HARD = 16 * 1024 * 1024;
const identityPolicy: ExportPolicy = { encode: (_entity, body) => body };
const roots: string[] = [];

function root(): string {
  const scratch = dirname(scratchDbPath("roam-codec"));
  const result = mkdtempSync(join(scratch, "roam-codec-"));
  roots.push(result);
  return result;
}

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const HEADER: BatchHeader = {
  protocol: 1, schema: 14, batchId: "batch-1", senderMachine: MACHINE, senderStream: STREAM,
  storeKey: STORE, after: 0, through: 2, count: 2,
};
const RECORDS: RecordChange[] = [
  {
    seq: 1, changeId: "change-1", entity: "sessions", rowKey: "session-1", op: "put",
    clock: { ms: 1000, count: 0, machine: MACHINE, stream: STREAM }, writerSession: "session-1", writerEpoch: 1, schema: 14,
    body: { id: "session-1", parent_session_id: null, name: null, reason: null, started_at: 1, ended_at: null, summary: null, origin_machine: MACHINE },
  },
  {
    seq: 2, changeId: "change-2", entity: "todos", rowKey: "todo-1", op: "put",
    clock: { ms: 1000, count: 1, machine: MACHINE, stream: STREAM }, writerSession: "session-1", writerEpoch: 1, schema: 14,
    body: { uuid: "todo-1", session_id: "session-1", seq: 1, text: "hello", done: 0, created_at: 1, updated_at: null },
  },
];
const expected = { storeKey: STORE, senderMachine: MACHINE, senderStream: STREAM, now: 1000 } as const;

function writeArtifact(directory: string, header: BatchHeader, records: unknown[], raw?: Buffer): BatchArtifact {
  const parent = mkdtempSync(join(directory, "wire-"));
  const file = join(parent, "batch.ndjson");
  const bytes = raw ?? Buffer.from([JSON.stringify(header), ...records.map(record => JSON.stringify(record))].join("\n") + "\n");
  writeFileSync(file, bytes, { mode: 0o600 });
  return { file, byteLength: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), header };
}

function lines(artifact: BatchArtifact): { header: BatchHeader; records: RecordChange[] } {
  const text = readFileSync(artifact.file, "utf8");
  if (!text.endsWith("\n")) throw new Error("fixture expected a complete NDJSON artifact");
  const [header, ...records] = text.slice(0, -1).split("\n").map(line => JSON.parse(line));
  return { header: header as BatchHeader, records: records as RecordChange[] };
}

function expectation(db: Db, now = Date.now()) {
  const meta = db.prepare("SELECT store_key, machine_id, stream_id FROM roam_meta").get() as { store_key: StoreKey; machine_id: string; stream_id: string };
  return { storeKey: meta.store_key, senderMachine: meta.machine_id, senderStream: meta.stream_id, now };
}

function destinationDigest(db: Db): string {
  const tables = ["roam_meta", "roam_changes", "roam_versions", "roam_cursors", "roam_receipts", "sessions", "todos"];
  const contents = tables.map(table => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
  return createHash("sha256").update(JSON.stringify(contents)).digest("hex");
}

function createSession(db: Db, storeKey: StoreKey): void {
  db.prepare("INSERT INTO sessions (id, name, started_at) VALUES ('session-1', 'before', 1)").run();
  seedSession(db, "session-1", 1, storeKey, 4096);
}

function addTodo(db: Db, key: string, seq: number, text: string): void {
  db.prepare("INSERT INTO todos (uuid, session_id, seq, text, created_at) VALUES (?, 'session-1', ?, ?, 1)").run(key, seq, text);
}

type Draft = { header: Record<string, unknown>; records: Array<Record<string, unknown>> };
function draft(): Draft {
  return { header: structuredClone(HEADER) as unknown as Record<string, unknown>, records: structuredClone(RECORDS) as unknown as Array<Record<string, unknown>> };
}
function recordBody(value: Record<string, unknown>): Record<string, unknown> { return value.body as Record<string, unknown>; }
function recordClock(value: Record<string, unknown>): Record<string, unknown> { return value.clock as Record<string, unknown>; }

const malformed: Array<[string, (wire: Draft) => void]> = [
  ["wrong protocol", wire => { wire.header.protocol = 2; }],
  ["wrong header schema", wire => { wire.header.schema = 13; }],
  ["wrong record schema", wire => { wire.records[1].schema = 13; }],
  ["missing header field", wire => { delete wire.header.batchId; }],
  ["extra envelope field", wire => { wire.records[1].extra = "unexpected"; }],
  ["missing envelope field", wire => { delete wire.records[1].writerEpoch; }],
  ["empty change ID", wire => { wire.records[1].changeId = ""; }],
  ["duplicate change ID", wire => { wire.records[1].changeId = wire.records[0].changeId; }],
  ["unknown entity", wire => { wire.records[1].entity = "content"; }],
  ["entity from another store", wire => {
    wire.records[1].entity = "global_memory"; wire.records[1].rowKey = "memory-1";
    wire.records[1].writerSession = null; wire.records[1].writerEpoch = null;
    wire.records[1].body = { uuid: "memory-1", category: "note", content: "text", link: null, scope: "global", status: "active", source: "user", confidence: null, created_at: 1, updated_at: null, justification: null, evidence: null, machine_id: null };
  }],
  ["empty row key", wire => { wire.records[1].rowKey = ""; recordBody(wire.records[1]).uuid = ""; }],
  ["key different from body", wire => { wire.records[1].rowKey = "another"; }],
  ["missing body column", wire => { delete recordBody(wire.records[1]).text; }],
  ["local-only body column", wire => { recordBody(wire.records[1]).id = 42; }],
  ["required body column null", wire => { recordBody(wire.records[1]).text = null; }],
  ["unsafe body integer", wire => { recordBody(wire.records[1]).seq = Number.MAX_SAFE_INTEGER + 1; }],
  ["mismatched writer session", wire => { wire.records[1].writerSession = "other-session"; }],
  ["unsafe writer epoch", wire => { wire.records[1].writerEpoch = Number.MAX_SAFE_INTEGER + 1; }],
  ["negative writer epoch", wire => { wire.records[1].writerEpoch = -1; }],
  ["delete with body", wire => { wire.records[1].op = "delete"; }],
  ["put with null body", wire => { wire.records[1].body = null; }],
  ["invalid operation", wire => { wire.records[1].op = "replace"; }],
  ["missing sequence", wire => { wire.records[1].seq = 3; }],
  ["unsafe sequence", wire => { wire.records[1].seq = Number.MAX_SAFE_INTEGER + 1; }],
  ["unsafe clock counter", wire => { recordClock(wire.records[1]).count = Number.MAX_SAFE_INTEGER + 1; }],
  ["negative clock", wire => { recordClock(wire.records[1]).ms = -1; }],
  ["future clock", wire => { recordClock(wire.records[1]).ms = 301001; }],
  ["empty clock stream", wire => { recordClock(wire.records[1]).stream = ""; }],
  ["non-UUID clock machine", wire => { recordClock(wire.records[1]).machine = "box-1.invalid"; }],
  ["non-UUID clock stream", wire => { recordClock(wire.records[1]).stream = "stream"; }],
  ["non-UUID session origin", wire => { recordBody(wire.records[0]).origin_machine = "box-1.invalid"; }],
  ["malformed Unicode clock identity", wire => { recordClock(wire.records[1]).machine = "\ud800"; }],
  ["malformed Unicode row text", wire => { recordBody(wire.records[1]).text = "\ud800"; }],
  ["extra clock field", wire => { recordClock(wire.records[1]).extra = 1; }],
  ["incorrect through", wire => { wire.header.through = 3; }],
  ["incorrect count", wire => { wire.header.count = 1; }],
  ["unsafe after", wire => { wire.header.after = Number.MAX_SAFE_INTEGER + 1; }],
];

describe("roaming batch export and validation", () => {
  it("snapshot export releases writer before transport", async () => {
    const fixture = createReplica("worktree", MACHINE);
    const { db, storeKey } = fixture;
    let writer: Db | undefined;
    try {
      createSession(db, storeKey);
      addTodo(db, "todo-1", 1, "before");
      const artifact = await exportBatch(db, { after: 0, targetBytes: 4096, batchId: "batch-1" }, identityPolicy);
      const bytesBefore = readFileSync(artifact.file);
      const snapshot = lines(artifact);
      writer = openDb(db.raw.name, { fileMustExist: true, busyTimeoutMs: 100 });
      writer.prepare("UPDATE todos SET text = 'after' WHERE uuid = 'todo-1'").run();
      expect(readFileSync(artifact.file)).toEqual(bytesBefore);
      expect(snapshot.records.map(record => record.body?.text).filter(Boolean)).toEqual(["before"]);
      const next = await exportBatch(db, { after: artifact.header.through, targetBytes: 4096, batchId: "batch-2" }, identityPolicy);
      expect(lines(next).records.map(record => record.body?.text)).toEqual(["after"]);
      expect(lstatSync(artifact.file).mode & 0o777).toBe(0o600);
      expect(lstatSync(dirname(artifact.file)).mode & 0o777).toBe(0o700);
      expect(createHash("sha256").update(bytesBefore).digest("hex")).toBe(artifact.sha256);
    } finally { writer?.close(); fixture.close(); }
  }, 5000);

  it("rejects unsafe export arguments without changing the store", async () => {
    const fixture = createReplica("worktree", MACHINE);
    try {
      createSession(fixture.db, fixture.storeKey);
      const before = destinationDigest(fixture.db);
      const request = { after: 0, targetBytes: 4096, batchId: "batch-1" };
      for (const invalid of [
        { ...request, after: -1 }, { ...request, after: Number.MAX_SAFE_INTEGER + 1 },
        { ...request, targetBytes: 0 }, { ...request, targetBytes: 1.5 }, { ...request, batchId: "" },
      ]) await expect(exportBatch(fixture.db, invalid, identityPolicy)).rejects.toThrow();
      expect(destinationDigest(fixture.db)).toBe(before);
    } finally { fixture.close(); }
  }, 5000);

  it("refuses export inside a caller-owned transaction", async () => {
    const fixture = createReplica("worktree", MACHINE);
    try {
      createSession(fixture.db, fixture.storeKey);
      let attempt!: Promise<BatchArtifact>;
      fixture.db.raw.transaction(() => {
        attempt = exportBatch(fixture.db, { after: 0, targetBytes: 4096, batchId: "nested" }, identityPolicy);
        void attempt.catch(() => undefined);
      }).immediate();
      await expect(attempt).rejects.toThrow(/transaction/i);
      expect(fixture.db.raw.inTransaction).toBe(false);
    } finally { fixture.close(); }
  }, 5000);

  it("locator wire content is cached once", async () => {
    const fixture = createReplica("worktree", MACHINE);
    const { db, storeKey } = fixture;
    let conversions = 0;
    const policy: ExportPolicy = { encode(entity, body, origin) {
      if (entity !== "todos") return body;
      expect(origin).toBe(MACHINE);
      conversions++;
      return { ...body, text: "portable value" };
    } };
    try {
      createSession(db, storeKey);
      addTodo(db, "todo-1", 1, "local value");
      const first = await exportBatch(db, { after: 0, targetBytes: 4096, batchId: "batch-1" }, policy);
      const second = await exportBatch(db, { after: 0, targetBytes: 4096, batchId: "batch-1" }, policy);
      expect(conversions).toBe(1);
      expect(readFileSync(second.file)).toEqual(readFileSync(first.file));
      expect(lines(first).records[1].body?.text).toBe("portable value");
      expect(db.prepare("SELECT text FROM todos WHERE uuid = 'todo-1'").get()).toEqual({ text: "local value" });
      expect(db.prepare("SELECT wire_json FROM roam_changes WHERE entity = 'sessions'").get()).toEqual({ wire_json: null });
      expect(db.prepare("SELECT json_extract(wire_json, '$.text') AS text FROM roam_changes WHERE entity = 'todos'").get()).toEqual({ text: "portable value" });
    } finally { fixture.close(); }
  }, 5000);

  it("caches an origin-qualified reference inside an event payload", async () => {
    const fixture = createReplica("worktree", MACHINE);
    let conversions = 0;
    try {
      createSession(fixture.db, fixture.storeKey);
      fixture.db.prepare("INSERT INTO runs (id, session_id, agent, status, origin_machine) VALUES ('run-1', 'session-1', 'worker', 'running', ?)").run(OTHER);
      fixture.db.prepare("INSERT INTO run_events (uuid, run_id, session_id, ts, type, payload) VALUES ('event-1', 'run-1', 'session-1', 1, 'child_transcript', ?)")
        .run(JSON.stringify({ version: 1, directory: "local-dir" }));
      const policy: ExportPolicy = { encode(entity, body, origin) {
        if (entity !== "run_events") return body;
        conversions++;
        return { ...body, payload: JSON.stringify({ version: 1, history: { machineId: origin, reference: "history-1" } }) };
      } };
      const request = { after: 0, targetBytes: 4096, batchId: "event" };
      const first = await exportBatch(fixture.db, request, policy);
      fixture.db.prepare("DELETE FROM runs WHERE id = 'run-1'").run();
      const second = await exportBatch(fixture.db, request, policy);
      const event = lines(first).records.find(record => record.rowKey === "event-1")!;
      const forwarded = lines(second).records.find(record => record.rowKey === "event-1")!;
      expect(JSON.parse(String(event.body!.payload))).toEqual({ version: 1, history: { machineId: OTHER, reference: "history-1" } });
      expect(forwarded.body).toEqual(event.body);
      expect(conversions).toBe(1);
      expect(fixture.db.prepare("SELECT json_extract(payload, '$.directory') AS directory FROM run_events WHERE uuid = 'event-1'").get())
        .toEqual({ directory: "local-dir" });
    } finally { fixture.close(); }
  }, 5000);

  it("uses creation and execution origins for row locators", async () => {
    const fixture = createReplica("worktree", MACHINE);
    const observed: Array<{ entity: string; origin: string }> = [];
    try {
      fixture.db.prepare("INSERT INTO sessions (id, started_at, origin_machine) VALUES ('session-1', 1, ?)").run(OTHER);
      seedSession(fixture.db, "session-1", 1, fixture.storeKey, 4096);
      fixture.db.prepare("INSERT INTO runs (id, session_id, agent, status, origin_machine) VALUES ('run-1', 'session-1', 'worker', 'running', ?)").run(OTHER);
      const policy: ExportPolicy = { encode(entity, body, origin) {
        observed.push({ entity, origin });
        return body;
      } };
      await exportBatch(fixture.db, { after: 0, targetBytes: 4096, batchId: "row-origins" }, policy);
      expect(observed).toEqual([{ entity: "sessions", origin: OTHER }, { entity: "runs", origin: OTHER }]);
    } finally { fixture.close(); }
  }, 5000);

  it("uses the run origin for event locators and the envelope origin without a run", async () => {
    const fixture = createReplica("worktree", MACHINE);
    const observed: Array<{ key: string; origin: string }> = [];
    try {
      createSession(fixture.db, fixture.storeKey);
      fixture.db.prepare("INSERT INTO runs (id, session_id, agent, status, origin_machine) VALUES ('run-1', 'session-1', 'worker', 'running', ?)").run(OTHER);
      fixture.db.prepare("INSERT INTO run_events (uuid, run_id, session_id, ts, type) VALUES ('linked', 'run-1', 'session-1', 1, 'progress')").run();
      fixture.db.prepare("INSERT INTO run_events (uuid, run_id, session_id, ts, type) VALUES ('unlinked', NULL, 'session-1', 1, 'progress')").run();
      fixture.db.prepare("INSERT INTO run_events (uuid, run_id, session_id, ts, type) VALUES ('missing', 'missing-run', 'session-1', 1, 'progress')").run();
      const policy: ExportPolicy = { encode(entity, body, origin) {
        if (entity === "run_events") observed.push({ key: String(body.uuid), origin });
        return body;
      } };
      await exportBatch(fixture.db, { after: 0, targetBytes: 4096, batchId: "origins" }, policy);
      expect(observed).toEqual([{ key: "linked", origin: OTHER }, { key: "unlinked", origin: MACHINE }, { key: "missing", origin: MACHINE }]);
    } finally { fixture.close(); }
  }, 5000);

  it("refuses an invalid run origin when exporting a later event", async () => {
    const fixture = createReplica("worktree", MACHINE);
    try {
      createSession(fixture.db, fixture.storeKey);
      fixture.db.prepare("INSERT INTO runs (id, session_id, agent, status, origin_machine) VALUES ('run-1', 'session-1', 'worker', 'running', 'box-1.invalid')").run();
      fixture.db.prepare("INSERT INTO run_events (uuid, run_id, session_id, ts, type) VALUES ('linked', 'run-1', 'session-1', 1, 'progress')").run();
      await expect(exportBatch(fixture.db, { after: 2, targetBytes: 4096, batchId: "invalid-origin" }, identityPolicy)).rejects.toThrow(/origin/i);
      expect(fixture.db.prepare("SELECT wire_json FROM roam_changes WHERE row_key = 'linked'").get()).toEqual({ wire_json: null });
    } finally { fixture.close(); }
  }, 5000);

  it.each(["a foreign machine", "an earlier local stream"])("forwards a portable body from %s without converting it again", async name => {
    const fixture = createReplica("worktree", MACHINE);
    let conversions = 0;
    try {
      const origin = name === "a foreign machine" ? OTHER : MACHINE;
      const portable = { uuid: "todo-1", session_id: "session-1", seq: 1, text: "portable value", done: 0, created_at: 1, updated_at: null };
      fixture.db.prepare(`INSERT INTO roam_changes (seq, change_id, entity, row_key, op, hlc_ms, hlc_count, origin_machine,
        origin_stream, writer_session, writer_epoch, schema_version, body_json) VALUES (1, 'forwarded', 'todos', 'todo-1', 'put', 1000, 0, ?, ?, 'session-1', 1, 14, ?)`)
        .run(origin, STREAM, JSON.stringify(portable));
      const policy: ExportPolicy = { encode(_entity, body) { conversions++; return { ...body, text: "converted twice" }; } };
      const artifact = await exportBatch(fixture.db, { after: 0, targetBytes: 4096, batchId: "forwarded" }, policy);
      expect(lines(artifact).records[0]).toMatchObject({ changeId: "forwarded", clock: { machine: origin, stream: STREAM }, body: portable });
      expect(conversions).toBe(0);
      expect(fixture.db.prepare("SELECT wire_json FROM roam_changes").get()).toEqual({ wire_json: null });
    } finally { fixture.close(); }
  }, 5000);

  it("caches a converted candidate even when it belongs to the next batch", async () => {
    const fixture = createReplica("worktree", MACHINE);
    let conversions = 0;
    try {
      createSession(fixture.db, fixture.storeKey);
      addTodo(fixture.db, "todo-1", 1, "local value");
      const full = await exportBatch(fixture.db, { after: 0, targetBytes: 4096, batchId: "sized" }, identityPolicy);
      const policy: ExportPolicy = { encode(entity, body) {
        if (entity !== "todos") return body;
        conversions++;
        return { ...body, text: "portable value" };
      } };
      const first = await exportBatch(fixture.db, { after: 0, targetBytes: full.byteLength - 1, batchId: "sized" }, policy);
      expect(first.header.count).toBe(1);
      expect(fixture.db.prepare("SELECT json_extract(wire_json, '$.text') AS text FROM roam_changes WHERE entity = 'todos'").get())
        .toEqual({ text: "portable value" });
      const next = await exportBatch(fixture.db, { after: first.header.through, targetBytes: 4096, batchId: "next" }, policy);
      expect(lines(next).records[0].body?.text).toBe("portable value");
      expect(conversions).toBe(1);
    } finally { fixture.close(); }
  }, 5000);

  it("forwards cached wire content rather than the captured local body", async () => {
    const fixture = createReplica("worktree", MACHINE);
    try {
      const captured = { uuid: "todo-1", session_id: "session-1", seq: 1, text: "local value", done: 0, created_at: 1, updated_at: null };
      const portable = { ...captured, text: "portable value" };
      fixture.db.prepare(`INSERT INTO roam_changes (seq, change_id, entity, row_key, op, hlc_ms, hlc_count, origin_machine,
        origin_stream, writer_session, writer_epoch, schema_version, body_json, wire_json)
        VALUES (1, 'forwarded', 'todos', 'todo-1', 'put', 1000, 0, ?, ?, 'session-1', 1, 14, ?, ?)`)
        .run(OTHER, STREAM, JSON.stringify(captured), JSON.stringify(portable));
      const policy: ExportPolicy = { encode() { throw new Error("must not convert cached wire content"); } };
      const artifact = await exportBatch(fixture.db, { after: 0, targetBytes: 4096, batchId: "forwarded" }, policy);
      expect(lines(artifact).records[0].body).toEqual(portable);
      expect(fixture.db.prepare("SELECT json_extract(body_json, '$.text') AS text FROM roam_changes").get()).toEqual({ text: "local value" });
    } finally { fixture.close(); }
  }, 5000);

  it("leaves identical reordered bodies uncached", async () => {
    const fixture = createReplica("worktree", MACHINE);
    try {
      createSession(fixture.db, fixture.storeKey);
      const policy: ExportPolicy = { encode(_entity, body) { return Object.fromEntries(Object.entries(body).reverse()); } };
      await exportBatch(fixture.db, { after: 0, targetBytes: 4096, batchId: "batch-1" }, policy);
      expect(fixture.db.prepare("SELECT wire_json FROM roam_changes").get()).toEqual({ wire_json: null });
    } finally { fixture.close(); }
  }, 5000);

  it("zero count has no import or receipt", async () => {
    const source = createReplica("worktree", MACHINE);
    const destination = createReplica("worktree", OTHER);
    try {
      const artifact = await exportBatch(source.db, { after: 0, targetBytes: 1024, batchId: "empty" }, identityPolicy);
      const before = destinationDigest(destination.db);
      const validated = await validateBatch(artifact, expectation(source.db));
      expect(validated.header.count).toBe(0);
      expect(validated.header.through).toBe(validated.header.after);
      expect(lines(validated).records).toEqual([]);
      expect(destinationDigest(destination.db)).toBe(before);
      expect(destination.db.prepare("SELECT count(*) AS n FROM roam_receipts").get()).toEqual({ n: 0 });
      expect(destination.db.prepare("SELECT count(*) AS n FROM roam_cursors").get()).toEqual({ n: 0 });
    } finally { source.close(); destination.close(); }
  }, 5000);

  it("zero count preserves a nonzero after sequence", async () => {
    const fixture = createReplica("worktree", MACHINE);
    try {
      createSession(fixture.db, fixture.storeKey);
      const first = await exportBatch(fixture.db, { after: 0, targetBytes: 4096, batchId: "first" }, identityPolicy);
      const tail = await exportBatch(fixture.db, { after: first.header.through, targetBytes: 4096, batchId: "tail" }, identityPolicy);
      const validated = await validateBatch(tail, expectation(fixture.db));
      expect(validated.header).toMatchObject({ after: 1, through: 1, count: 0 });
      expect(lines(validated).records).toEqual([]);
    } finally { fixture.close(); }
  }, 5000);

  it("complete validation refuses malformed last record", async () => {
    const destination = createReplica("worktree", OTHER);
    try {
      const wire = draft();
      wire.records[1].rowKey = "wrong-key";
      const artifact = writeArtifact(root(), wire.header as unknown as BatchHeader, wire.records);
      const destinationDigestBefore = destinationDigest(destination.db);
      await expect(validateBatch(artifact, expected)).rejects.toThrow();
      const destinationDigestAfter = destinationDigest(destination.db);
      expect(destinationDigestAfter).toBe(destinationDigestBefore);
    } finally { destination.close(); }
  }, 5000);

  it.each(malformed)("rejects %s before branding the batch", async (_name, mutate) => {
    const wire = draft();
    mutate(wire);
    const artifact = writeArtifact(root(), wire.header as unknown as BatchHeader, wire.records);
    await expect(validateBatch(artifact, expected)).rejects.toThrow();
  }, 5000);

  it("rejects a sender identity that is not a machine UUID", async () => {
    const header = { ...HEADER, senderMachine: "box-1.invalid" };
    await expect(validateBatch(writeArtifact(root(), header, RECORDS), { ...expected, senderMachine: "box-1.invalid" })).rejects.toThrow();
  }, 5000);

  it("accepts only the initial unassigned home conflict marker", async () => {
    const header: BatchHeader = { ...HEADER, storeKey: "global", through: 1, count: 1 };
    const record: RecordChange = { seq: 1, changeId: "home-1", entity: "session_homes", rowKey: "session-1", op: "put",
      clock: { ms: 1000, count: 0, machine: MACHINE, stream: STREAM }, writerSession: null, writerEpoch: null, schema: 14,
      body: { session_id: "session-1", machine_id: "", epoch: 1, move_id: null, updated_at: 1 } };
    const global = { ...expected, storeKey: "global" as const };
    const valid = await validateBatch(writeArtifact(root(), header, [record]), global);
    expect(lines(valid).records[0].body?.machine_id).toBe("");
    for (const body of [{ ...record.body!, epoch: 2 }, { ...record.body!, move_id: "move-1" }]) {
      await expect(validateBatch(writeArtifact(root(), header, [{ ...record, body }]), global)).rejects.toThrow();
    }
  }, 5000);

  it("checks sender identity, store, digest, length, and manifest header", async () => {
    const artifact = writeArtifact(root(), HEADER, RECORDS);
    await expect(validateBatch(artifact, { ...expected, senderMachine: OTHER })).rejects.toThrow();
    await expect(validateBatch(artifact, { ...expected, senderStream: "wrong" })).rejects.toThrow();
    await expect(validateBatch(artifact, { ...expected, storeKey: "global" })).rejects.toThrow();
    await expect(validateBatch({ ...artifact, byteLength: artifact.byteLength - 1 }, expected)).rejects.toThrow();
    await expect(validateBatch({ ...artifact, sha256: "0".repeat(64) }, expected)).rejects.toThrow();
    await expect(validateBatch({ ...artifact, header: { ...HEADER, batchId: "other" } }, expected)).rejects.toThrow();
  }, 5000);

  it("accepts maximum safe wire integers without rounding", async () => {
    const maximum = Number.MAX_SAFE_INTEGER;
    const header: BatchHeader = { ...HEADER, after: maximum - 1, through: maximum, count: 1 };
    const record = structuredClone(RECORDS[1]);
    record.seq = maximum;
    record.writerEpoch = maximum;
    record.clock.count = maximum;
    const validated = await validateBatch(writeArtifact(root(), header, [record]), expected);
    expect(validated.header.through).toBe(maximum);
    expect(lines(validated).records[0]).toMatchObject({ seq: maximum, writerEpoch: maximum, clock: { count: maximum } });
  }, 5000);

  it("accepts a remote clock exactly five minutes ahead", async () => {
    const records = structuredClone(RECORDS);
    records[1].clock.ms = 301000;
    const validated = await validateBatch(writeArtifact(root(), HEADER, records), expected);
    expect(lines(validated).records[1].clock.ms).toBe(301000);
  }, 5000);

  it("rejects missing and extra records even when the header range is consistent", async () => {
    const one = { ...HEADER, through: 1, count: 1 };
    await expect(validateBatch(writeArtifact(root(), one, RECORDS), expected)).rejects.toThrow();
    await expect(validateBatch(writeArtifact(root(), HEADER, RECORDS.slice(0, 1)), expected)).rejects.toThrow();
  }, 5000);

  it("rejects invalid UTF-8, incomplete NDJSON, and trailing blank records", async () => {
    const valid = Buffer.from([JSON.stringify(HEADER), ...RECORDS.map(record => JSON.stringify(record))].join("\n") + "\n");
    const position = valid.indexOf(Buffer.from("hello"));
    const corrupt = Buffer.concat([valid.subarray(0, position), Buffer.from([0xc3, 0x28]), valid.subarray(position + 2)]);
    for (const raw of [corrupt, valid.subarray(0, valid.length - 1), Buffer.concat([valid, Buffer.from("\n")])]) {
      await expect(validateBatch(writeArtifact(root(), HEADER, RECORDS, raw), expected)).rejects.toThrow();
    }
  }, 5000);

  it("rejects fractional and unsafe JSON numbers that round to safe integers", async () => {
    const valid = [JSON.stringify(HEADER), ...RECORDS.map(record => JSON.stringify(record))].join("\n") + "\n";
    const inputs = [
      valid.replace('"seq":2', '"seq":2.0000000000000001'),
      valid.replace('"writerEpoch":1', '"writerEpoch":1.0000000000000001'),
      valid.replace('"seq":1,"text"', '"seq":9007199254740991.1,"text"'),
    ];
    for (const raw of inputs) {
      await expect(validateBatch(writeArtifact(root(), HEADER, RECORDS, Buffer.from(raw)), expected)).rejects.toThrow();
    }
  }, 5000);

  it("accepts exact integer JSON numbers written with decimals or exponents", async () => {
    const valid = [JSON.stringify(HEADER), ...RECORDS.map(record => JSON.stringify(record))].join("\n") + "\n";
    const raw = valid.replace('"seq":2', '"seq":2e0').replace('"writerEpoch":1', '"writerEpoch":1.0');
    const artifact = writeArtifact(root(), HEADER, RECORDS, Buffer.from(raw));
    expect((await validateBatch(artifact, expected)).header.through).toBe(2);
  }, 5000);

  it("rejects duplicate JSON keys even when the last value is valid", async () => {
    const valid = [JSON.stringify(HEADER), ...RECORDS.map(record => JSON.stringify(record))].join("\n") + "\n";
    const duplicateHeader = valid.replace('"schema":14', '"schema":13,"schema":14');
    const duplicateBody = valid.replace('"uuid":"todo-1"', '"uuid":"other","\\u0075uid":"todo-1"');
    for (const raw of [duplicateHeader, duplicateBody]) {
      await expect(validateBatch(writeArtifact(root(), HEADER, RECORDS, Buffer.from(raw)), expected)).rejects.toThrow();
    }
  }, 5000);

  it("accepts escaped quotes and brackets inside row text", async () => {
    const records = structuredClone(RECORDS);
    records[1].body!.text = 'quote " and slash \\ with {"uuid": "text"} and é🙂';
    const validated = await validateBatch(writeArtifact(root(), HEADER, records), expected);
    expect(lines(validated).records[1].body?.text).toBe(records[1].body!.text);
  }, 5000);

  it("returns a private snapshot independent of the source file", async () => {
    const artifact = writeArtifact(root(), HEADER, RECORDS);
    const original = readFileSync(artifact.file);
    const validated = await validateBatch(artifact, expected);
    writeFileSync(artifact.file, "changed");
    expect(readFileSync(validated.file)).toEqual(original);
    expect(lstatSync(validated.file).mode & 0o777).toBe(0o600);
    expect(lstatSync(dirname(validated.file)).mode & 0o777).toBe(0o700);
    expect(lines(validated).records).toEqual(RECORDS);
  }, 5000);

  it("refuses symlink and nonprivate batch inputs", async () => {
    const artifact = writeArtifact(root(), HEADER, RECORDS);
    const link = join(dirname(artifact.file), "link.ndjson");
    symlinkSync(artifact.file, link);
    await expect(validateBatch({ ...artifact, file: link }, expected)).rejects.toThrow();
    const parentLink = join(dirname(dirname(artifact.file)), "parent-link");
    symlinkSync(dirname(artifact.file), parentLink);
    await expect(validateBatch({ ...artifact, file: join(parentLink, "batch.ndjson") }, expected)).rejects.toThrow();
    chmodSync(artifact.file, 0o644);
    await expect(validateBatch(artifact, expected)).rejects.toThrow();
  }, 5000);

  it("refuses a FIFO without waiting for a writer", async () => {
    const artifact = writeArtifact(root(), HEADER, RECORDS);
    const fifo = join(dirname(artifact.file), "batch.fifo");
    const marker = join(dirname(artifact.file), "writer-started");
    execFileSync("mkfifo", [fifo], { timeout: 1000 });
    chmodSync(fifo, 0o600);
    const script = `setTimeout(() => { const fs = require('node:fs'); fs.writeFileSync(process.argv[2], 'started', { mode: 0o600 });
      const fd = fs.openSync(process.argv[1], 'w'); fs.closeSync(fd); }, 1500);`;
    const writer = spawn(process.execPath, ["-e", script, fifo, marker], { stdio: "ignore" });
    const closed = new Promise<void>(resolve => writer.once("close", () => resolve()));
    try {
      await expect(validateBatch({ ...artifact, file: fifo }, expected)).rejects.toThrow();
      expect(existsSync(marker)).toBe(false);
    } finally { writer.kill(); await closed; }
  }, 5000);

  it("refuses a symlinked export directory without writing through it", async () => {
    const fixture = createReplica("worktree", MACHINE);
    let watcher: ReturnType<typeof watch> | undefined;
    try {
      createSession(fixture.db, fixture.storeKey);
      const target = join(fixture.root, "other");
      mkdirSync(target, { mode: 0o700 });
      const events: Array<{ event: string; name: string | null }> = [];
      watcher = watch(target, (event, name) => events.push({ event, name: name?.toString() ?? null }));
      symlinkSync(target, join(fixture.root, ".roam-batches"));
      await expect(exportBatch(fixture.db, { after: 0, targetBytes: 4096, batchId: "unsafe" }, identityPolicy)).rejects.toThrow();
      await new Promise(resolve => setTimeout(resolve, 200));
      expect(events.filter(({ name }) => name !== "other")).toEqual([]);
      expect(readdirSync(target)).toEqual([]);
    } finally { watcher?.close(); fixture.close(); }
  }, 5000);

  it("selects by actual UTF-8 bytes at and just below the target", async () => {
    const fixture = createReplica("worktree", MACHINE);
    try {
      createSession(fixture.db, fixture.storeKey);
      addTodo(fixture.db, "todo-1", 1, "é🙂\nquoted \"text\"");
      const request = { after: 0, targetBytes: HARD, batchId: "sized" };
      const full = await exportBatch(fixture.db, request, identityPolicy);
      const exact = await exportBatch(fixture.db, { ...request, targetBytes: full.byteLength }, identityPolicy);
      const below = await exportBatch(fixture.db, { ...request, targetBytes: full.byteLength - 1 }, identityPolicy);
      expect(full.header.count).toBe(2);
      expect(exact.header.count).toBe(2);
      expect(exact.byteLength).toBe(full.byteLength);
      expect(below.header.count).toBe(1);
      expect(below.byteLength).toBeLessThanOrEqual(full.byteLength - 1);
    } finally { fixture.close(); }
  }, 5000);

  it.each(["global", "repo", "worktree"] as const)("exports real %s store puts and deletes", async scope => {
    const fixture = createReplica(scope, MACHINE);
    try {
      if (scope === "worktree") {
        createSession(fixture.db, fixture.storeKey);
        addTodo(fixture.db, "todo-1", 1, "first");
        fixture.db.prepare("INSERT INTO runs (id, session_id, agent, status) VALUES ('run-1', 'session-1', 'worker', 'running')").run();
        fixture.db.prepare("INSERT INTO run_events (uuid, run_id, session_id, ts, type, payload) VALUES ('event-1', 'run-1', 'session-1', 1, 'progress', ?)")
          .run(JSON.stringify({ value: "history" }));
        fixture.db.prepare("DELETE FROM todos WHERE uuid = 'todo-1'").run();
      } else {
        enableMemoryCapture(fixture.db, fixture.storeKey);
        const table = scope === "global" ? "global_memory" : "memory";
        fixture.db.prepare(`INSERT INTO ${table} (uuid, category, content, confidence, created_at) VALUES ('memory-1', 'note', 'first', 0.75, 1)`).run();
        fixture.db.prepare(`UPDATE ${table} SET content = 'second' WHERE uuid = 'memory-1'`).run();
        fixture.db.prepare(`DELETE FROM ${table} WHERE uuid = 'memory-1'`).run();
        if (scope === "global") fixture.db.prepare("INSERT INTO session_homes (session_id, machine_id, epoch, move_id, updated_at) VALUES ('session-1', ?, 1, NULL, 1)").run(MACHINE);
      }
      const artifact = await exportBatch(fixture.db, { after: 0, targetBytes: HARD, batchId: "all" }, identityPolicy);
      const validated = await validateBatch(artifact, expectation(fixture.db));
      const changes = lines(validated).records.map(record => `${record.entity}:${record.op}`);
      expect(changes).toEqual(scope === "worktree" ? ["sessions:put", "todos:put", "runs:put", "run_events:put", "todos:delete"]
        : scope === "repo" ? ["memory:put", "memory:put", "memory:delete"]
        : ["global_memory:put", "global_memory:put", "global_memory:delete", "session_homes:put"]);
      expect(lines(validated).records.filter(record => record.op === "delete").every(record => record.body === null)).toBe(true);
    } finally { fixture.close(); }
  }, 5000);

  it("does not impose a record-count limit on small changes", async () => {
    const fixture = createReplica("worktree", MACHINE);
    try {
      createSession(fixture.db, fixture.storeKey);
      const add = fixture.db.prepare("INSERT INTO todos (uuid, session_id, seq, text, created_at) VALUES (?, 'session-1', ?, 'small', 1)");
      fixture.db.raw.transaction(() => {
        for (let index = 1; index <= 1000; index++) add.run(`todo-${index}`, index);
      })();
      const artifact = await exportBatch(fixture.db, { after: 0, targetBytes: HARD, batchId: "many" }, identityPolicy);
      const validated = await validateBatch(artifact, expectation(fixture.db));
      expect(validated.header.count).toBe(1001);
      expect(validated.header.through).toBe(1001);
      expect(lines(validated).records.at(-1)?.rowKey).toBe("todo-1000");
    } finally { fixture.close(); }
  }, 5000);

  it("exports a contiguous log across multiple byte-sized batches", async () => {
    const fixture = createReplica("worktree", MACHINE);
    try {
      createSession(fixture.db, fixture.storeKey);
      for (let index = 1; index <= 5; index++) addTodo(fixture.db, `todo-${index}`, index, "é🙂".repeat(60));
      let after = 0;
      const observed: string[] = [];
      for (let batch = 0; batch < 10; batch++) {
        const artifact = await exportBatch(fixture.db, { after, targetBytes: 700, batchId: `batch-${batch}` }, identityPolicy);
        const validated = await validateBatch(artifact, expectation(fixture.db));
        expect(validated.header.after).toBe(after);
        const records = lines(validated).records;
        observed.push(...records.map(record => record.rowKey));
        if (validated.header.count === 0) break;
        expect(records[0].seq).toBe(after + 1);
        after = validated.header.through;
      }
      expect(observed).toEqual(["session-1", "todo-1", "todo-2", "todo-3", "todo-4", "todo-5"]);
      expect(after).toBe(6);
    } finally { fixture.close(); }
  }, 5000);

  it("rolls back pending wire caches when a later row is invalid", async () => {
    const fixture = createReplica("worktree", MACHINE);
    try {
      createSession(fixture.db, fixture.storeKey);
      addTodo(fixture.db, "todo-1", 1, "first");
      fixture.db.prepare("UPDATE roam_changes SET schema_version = 13 WHERE seq = 2").run();
      const policy: ExportPolicy = { encode(entity, body) { return entity === "sessions" ? { ...body, name: "portable" } : body; } };
      await expect(exportBatch(fixture.db, { after: 0, targetBytes: 4096, batchId: "invalid" }, policy)).rejects.toThrow();
      expect(fixture.db.prepare("SELECT wire_json FROM roam_changes ORDER BY seq").all()).toEqual([{ wire_json: null }, { wire_json: null }]);
      expect(fixture.db.prepare("SELECT count(*) AS n FROM roam_changes").get()).toEqual({ n: 2 });
    } finally { fixture.close(); }
  }, 5000);

  it("rejects gaps and an export cursor ahead of the log", async () => {
    const fixture = createReplica("worktree", MACHINE);
    try {
      createSession(fixture.db, fixture.storeKey);
      addTodo(fixture.db, "todo-1", 1, "first");
      addTodo(fixture.db, "todo-2", 2, "second");
      fixture.db.prepare("DELETE FROM roam_changes WHERE seq = 2").run();
      await expect(exportBatch(fixture.db, { after: 0, targetBytes: 4096, batchId: "gap" }, identityPolicy)).rejects.toThrow(/gap|sequence/i);
      await expect(exportBatch(fixture.db, { after: 4, targetBytes: 4096, batchId: "ahead" }, identityPolicy)).rejects.toThrow(/cursor|sequence|ahead/i);
    } finally { fixture.close(); }
  }, 5000);
});

function insertSingleton(db: Db, delta: number): { bodyBytes: number; textLength: number } {
  const meta = db.prepare("SELECT machine_id, stream_id, store_key FROM roam_meta").get() as { machine_id: string; stream_id: string; store_key: StoreKey };
  const header: BatchHeader = { protocol: 1, schema: 14, batchId: "limit", senderMachine: meta.machine_id, senderStream: meta.stream_id,
    storeKey: meta.store_key, after: 0, through: 1, count: 1 };
  const record: RecordChange = { seq: 1, changeId: "change-large", entity: "todos", rowKey: "todo-large", op: "put",
    clock: { ms: 1000, count: 0, machine: meta.machine_id, stream: meta.stream_id }, writerSession: "session-1", writerEpoch: 1, schema: 14,
    body: { uuid: "todo-large", session_id: "session-1", seq: 1, text: "", done: 0, created_at: 1, updated_at: null } };
  const overhead = Buffer.byteLength(`${JSON.stringify(header)}\n${JSON.stringify(record)}\n`);
  const textLength = HARD - overhead + delta;
  record.body!.text = "x".repeat(textLength);
  const bodyJson = JSON.stringify(record.body);
  db.prepare(`INSERT INTO roam_changes (seq, change_id, entity, row_key, op, hlc_ms, hlc_count, origin_machine,
    origin_stream, writer_session, writer_epoch, schema_version, body_json) VALUES (1, ?, 'todos', ?, 'put', 1000, 0, ?, ?, 'session-1', 1, 14, ?)`)
    .run(record.changeId, record.rowKey, meta.machine_id, meta.stream_id, bodyJson);
  return { bodyBytes: Buffer.byteLength(bodyJson), textLength };
}

describe("roaming singleton wire limit", () => {
  it("wire bytes obey exact and just-over limits", async () => {
    const fixture = createReplica("worktree", MACHINE);
    try {
      insertSingleton(fixture.db, 0);
      const artifact = await exportBatch(fixture.db, { after: 0, targetBytes: 4 * 1024 * 1024, batchId: "limit" }, identityPolicy);
      expect(artifact.header.count).toBe(1);
      expect(artifact.byteLength).toBe(HARD);
      expect(readFileSync(artifact.file).byteLength).toBe(HARD);
      const validated = await validateBatch(artifact, expectation(fixture.db, 1000));
      expect(validated.byteLength).toBe(HARD);
      const over = { ...artifact, byteLength: HARD + 1 };
      await expect(validateBatch(over, expectation(fixture.db, 1000))).rejects.toThrow(/limit|large|length|size/i);
    } finally { fixture.close(); }
  }, 5000);

  it("rejects an actual artifact one byte over the hard limit", async () => {
    const header = { ...HEADER, through: 1, count: 1 };
    const record = structuredClone(RECORDS[1]);
    record.seq = 1;
    record.body!.text = "";
    const overhead = Buffer.byteLength(`${JSON.stringify(header)}\n${JSON.stringify(record)}\n`);
    record.body!.text = "x".repeat(HARD - overhead + 1);
    const artifact = writeArtifact(root(), header, [record]);
    expect(artifact.byteLength).toBe(HARD + 1);
    await expect(validateBatch(artifact, expected)).rejects.toThrow(/limit|large|length|size/i);
  }, 5000);

  it("stops at an oversized row even after a valid prefix", async () => {
    const fixture = createReplica("worktree", MACHINE);
    try {
      createSession(fixture.db, fixture.storeKey);
      addTodo(fixture.db, "todo-large", 1, "x".repeat(HARD - 150));
      const before = fixture.db.prepare("SELECT length(CAST(body_json AS BLOB)) AS bytes FROM roam_changes WHERE row_key = 'todo-large'").get();
      await expect(exportBatch(fixture.db, { after: 0, targetBytes: HARD, batchId: "prefix" }, identityPolicy)).rejects.toThrow(/todo-large/);
      expect(fixture.db.prepare("SELECT length(CAST(body_json AS BLOB)) AS bytes FROM roam_changes WHERE row_key = 'todo-large'").get()).toEqual(before);
      expect(fixture.db.prepare("SELECT count(*) AS n FROM roam_changes").get()).toEqual({ n: 2 });
    } finally { fixture.close(); }
  }, 5000);

  it("refuses an oversized wire batch for a real bulk-seeded row", async () => {
    const fixture = createReplica("worktree", MACHINE);
    try {
      fixture.db.prepare("INSERT INTO sessions (id, started_at) VALUES ('session-1', 1)").run();
      const body = { id: "run-large", session_id: "session-1", parent_run_id: null, agent: "worker", role: null, name: null,
        status: "done", phase: null, model: null, task: null, thinking: null, started_at: null, ended_at: null,
        step_count: 0, token_count: 0, result: "", child_mode: "print", origin_machine: MACHINE };
      const resultLength = HARD - Buffer.byteLength(JSON.stringify(body)) - 1;
      fixture.db.prepare("INSERT INTO runs (id, session_id, agent, status, result) VALUES ('run-large', 'session-1', 'worker', 'done', ?)")
        .run("x".repeat(resultLength));
      expect(seedSession(fixture.db, "session-1", 1, fixture.storeKey, 4 * 1024 * 1024).complete).toBe(false);
      expect(seedSession(fixture.db, "session-1", 1, fixture.storeKey, 4 * 1024 * 1024).complete).toBe(true);
      const before = fixture.db.prepare("SELECT length(CAST(body_json AS BLOB)) AS bytes FROM roam_changes WHERE row_key = 'run-large'").get();
      expect(before).toEqual({ bytes: HARD - 1 });
      await expect(exportBatch(fixture.db, { after: 1, targetBytes: HARD, batchId: "seeded" }, identityPolicy)).rejects.toThrow(/run-large/);
      expect(fixture.db.prepare("SELECT length(CAST(body_json AS BLOB)) AS bytes FROM roam_changes WHERE row_key = 'run-large'").get()).toEqual(before);
      expect(fixture.db.prepare("SELECT length(result) AS size FROM runs WHERE id = 'run-large'").get()).toEqual({ size: resultLength });
    } finally { fixture.close(); }
  }, 5000);

  it("oversized singleton stops the store with its key and leaves the row untrimmed", async () => {
    const fixture = createReplica("worktree", MACHINE);
    try {
      const { bodyBytes, textLength } = insertSingleton(fixture.db, 1);
      expect(bodyBytes).toBeLessThan(HARD);
      await expect(exportBatch(fixture.db, { after: 0, targetBytes: HARD, batchId: "limit" }, identityPolicy)).rejects.toThrow(/todo-large/);
      const row = fixture.db.prepare("SELECT row_key, length(CAST(body_json AS BLOB)) AS bytes, length(json_extract(body_json, '$.text')) AS text_length, wire_json FROM roam_changes").get();
      expect(row).toEqual({ row_key: "todo-large", bytes: bodyBytes, text_length: textLength, wire_json: null });
    } finally { fixture.close(); }
  }, 5000);
});

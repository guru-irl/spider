import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { openDb } from "../db";
import { applyBatch } from "@spider/db-core/roam/apply";
import { exportBatch } from "@spider/db-core/roam/export";
import { seedSession } from "@spider/db-core/roam/seed";
import type { ApplyReceipt, BatchArtifact, Change } from "@spider/db-core/roam/types";
import {
  A, B, NOW, SESSION, apply, artifact, assigned, batch, clock, deleted, effects, replica, rows, session, todo, validate,
} from "./roam-apply-fixture";

const HARD_LIMIT = 16 * 1024 * 1024;

function state(root: ReturnType<typeof replica>) {
  return JSON.stringify(["roam_meta", "roam_changes", "roam_versions", "roam_cursors", "roam_receipts", "roam_sessions", "sessions", "todos"].map(table => rows(root, table)));
}

function unloggedTodo(root: ReturnType<typeof replica>, uuid = "local-uuid", seq = 1) {
  const result = root.db.prepare("INSERT INTO todos(uuid, session_id, seq, text, done, created_at) VALUES (?, ?, ?, 'localtext', 0, 1)").run(uuid, SESSION, seq);
  root.db.prepare("INSERT INTO todos_fts(rowid, text) VALUES (?, 'localtext')").run(result.lastInsertRowid);
}

function replaceWireRecord(input: BatchArtifact, index: number, mutate: (record: Record<string, unknown>) => void) {
  const lines = readFileSync(input.file, "utf8").trimEnd().split("\n");
  const record = JSON.parse(lines[index + 1]) as Record<string, unknown>;
  mutate(record);
  lines[index + 1] = JSON.stringify(record);
  const bytes = Buffer.from(lines.join("\n") + "\n");
  writeFileSync(input.file, bytes);
  input.byteLength = bytes.length;
  input.sha256 = createHash("sha256").update(bytes).digest("hex");
}

describe("roaming replay and conflicts", () => {
  it("lost acknowledgement replays the digest receipt", async () => {
    const root = replica();
    const handlers = effects();
    const value = await batch(root, [todo("todo-1", 1, "first")]);
    const first = apply(root, value, handlers);
    const before = state(root);
    const replay = apply(root, value, handlers);
    expect(replay).toMatchObject({ batchId: first.batchId, stream: first.stream, through: first.through, sha256: first.sha256 });
    expect(replay.applyMs).toBeNull();
    expect(first.applyMs).toBeGreaterThanOrEqual(0);
    expect(state(root)).toBe(before);
    expect(handlers.notices).toEqual([root.storeKey]);
    expect(rows(root, "roam_changes")).toHaveLength(1);
    expect(rows(root, "roam_receipts")).toHaveLength(1);
  }, 5000);

  it("replayed receipt after crash has null apply time and identical digest fields", async () => {
    expectTypeOf<ApplyReceipt["applyMs"]>().toEqualTypeOf<number | null>();
    const root = replica();
    const value = await batch(root, [todo("todo-1", 1, "first")]);
    const script = `
      import { registerHooks } from "node:module";
      import { readFileSync, writeFileSync } from "node:fs";
      import { pathToFileURL } from "node:url";
      registerHooks({ resolve(specifier, context, next) {
        if (context.parentURL?.endsWith(".ts") && (specifier.startsWith("./") || specifier.startsWith("../")) && !specifier.endsWith(".ts") && !specifier.endsWith(".js")) {
          return next(specifier + ".ts", context);
        }
        return next(specifier, context);
      } });
      const input = JSON.parse(readFileSync(0, "utf8"));
      const { openDb } = await import(pathToFileURL(input.dbModule).href);
      const { applyBatch } = await import(pathToFileURL(input.applyModule).href);
      const db = openDb(input.store);
      const receipt = applyBatch(db, input.batch, { hubMachine: input.hub, now: input.now,
        effects: { winning() {}, committed() {} }, sessionHome() { return null; } });
      writeFileSync(1, JSON.stringify(receipt));
      process.kill(process.pid, "SIGKILL");
    `;
    const child = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], {
      input: JSON.stringify({
        dbModule: fileURLToPath(new URL("../db.ts", import.meta.url)),
        applyModule: fileURLToPath(new URL("../roam/apply.ts", import.meta.url)),
        store: join(root.root, "store.db"), batch: value, hub: A, now: NOW,
      }), encoding: "utf8", timeout: 4000, env: { ...process.env, NODE_NO_WARNINGS: "1" },
    });
    expect(child.stderr).toBe("");
    expect(child.signal).toBe("SIGKILL");
    const first = JSON.parse(child.stdout) as ApplyReceipt;
    expect(typeof first.applyMs).toBe("number");
    expect(first.applyMs).toBeGreaterThanOrEqual(0);
    expect(root.db.prepare("SELECT batch_id, peer_stream, through_seq, sha256 FROM roam_receipts").get()).toEqual({
      batch_id: value.header.batchId, peer_stream: value.header.senderStream, through_seq: value.header.through, sha256: value.sha256,
    });
    const before = state(root);
    const resumedEffects = effects();
    const db = openDb(join(root.root, "store.db"));
    try {
      const replay = applyBatch(db, value, { hubMachine: A, effects: resumedEffects.effects, now: NOW, sessionHome: () => null });
      expect(replay).toEqual({ batchId: first.batchId, stream: first.stream, through: first.through, sha256: first.sha256, applyMs: null });
      expect(replay).toMatchObject({ batchId: value.header.batchId, stream: value.header.senderStream, through: value.header.through, sha256: value.sha256 });
      expect(state(root)).toBe(before);
      expect(resumedEffects.notices).toEqual([]);
      expect(resumedEffects.calls).toEqual([]);
    } finally { db.close(); }
  }, 5000);

  it("a reused batch ID with a different digest is refused", async () => {
    const root = replica();
    const first = await batch(root, [todo("todo-1", 1, "first")]);
    apply(root, first);
    const before = state(root);
    const different = await batch(root, [todo("todo-1", 1, "changed")]);
    expect(() => apply(root, different)).toThrow(/receipt|digest/i);
    expect(state(root)).toBe(before);
  }, 5000);

  it("a receipted replay survives disabled capture", async () => {
    const root = replica();
    const value = await batch(root, [todo("todo-1", 1, "first")]);
    const first = apply(root, value);
    root.db.prepare("UPDATE roam_meta SET roamable = 0, problem = 'capture disabled'").run();
    const before = state(root);
    const replay = apply(root, value);
    expect(replay).toMatchObject({ batchId: first.batchId, stream: first.stream, through: first.through, sha256: first.sha256 });
    expect(state(root)).toBe(before);
  }, 5000);

  it("a receipted replay survives a backward wall clock", async () => {
    const root = replica();
    const handlers = effects();
    const value = await batch(root, [todo("todo-1", 1, "first", clock(400_000))]);
    const first = apply(root, value, handlers, () => null, 400_000);
    const before = state(root);
    const replay = apply(root, value, handlers, () => null, 0);
    expect(replay).toMatchObject({ batchId: first.batchId, stream: first.stream, through: first.through, sha256: first.sha256 });
    expect(state(root)).toBe(before);
    expect(handlers.notices).toEqual([root.storeKey]);
  }, 5000);

  it("duplicate change ID requires identical canonical envelope", async () => {
    const root = replica();
    const handlers = effects();
    const original = todo("todo-1", 1, "first");
    apply(root, await batch(root, [original]), handlers);
    const reordered = { ...original, body: Object.fromEntries(Object.entries(original.body!).reverse()) } as Change;
    apply(root, await batch(root, [reordered], { after: 1, id: "forwarded" }), handlers);
    expect(rows(root, "roam_changes")).toHaveLength(1);
    expect(handlers.notices).toEqual([root.storeKey]);
    const before = state(root);
    for (const bad of [
      { ...original, body: { ...original.body!, text: "changed" } },
      { ...original, clock: clock(1001) },
      { ...original, changeId: "different-id" },
    ]) {
      const value = await batch(root, [bad], { after: 2, id: `invalid-${bad.changeId}` });
      expect(() => apply(root, value, handlers)).toThrow(/change|clock|corrupt|envelope/i);
      expect(state(root)).toBe(before);
    }
  }, 5000);

  it("a newly accepted batch of duplicate changes still has an apply time", async () => {
    const root = replica();
    const handlers = effects();
    const change = todo("todo-1", 1, "first");
    apply(root, await batch(root, [change]), handlers);
    const forwarded = apply(root, await batch(root, [change], { after: 1, id: "forwarded" }), handlers);
    expect(typeof forwarded.applyMs).toBe("number");
    expect(forwarded.applyMs).toBeGreaterThanOrEqual(0);
    expect(root.db.prepare("SELECT last_seq FROM roam_cursors").get()).toEqual({ last_seq: 2 });
    expect(rows(root, "roam_changes")).toHaveLength(1);
    expect(handlers.notices).toEqual([root.storeKey]);
  }, 5000);

  it("a forwarded duplicate matches the cached portable body", async () => {
    const source = replica("worktree", A);
    const destination = replica("worktree", B);
    const handlers = effects();
    seedSession(source.db, SESSION, 1, source.storeKey, 4096);
    source.db.prepare("INSERT INTO sessions(id, name, started_at, origin_machine) VALUES (?, 'local name', 1, ?)").run(SESSION, A);
    const outward = await exportBatch(source.db, { after: 0, targetBytes: 4096, batchId: "outward" }, {
      encode: (entity, body) => entity === "sessions" ? { ...body, name: "portable name" } : body,
    });
    const now = Date.now() + 1000;
    apply(destination, await validate(outward, now), effects(), () => null, now);
    const forwarded = await exportBatch(destination.db, { after: 0, targetBytes: 4096, batchId: "forwarded" }, { encode: (_entity, body) => body });
    apply(source, await validate(forwarded, now), handlers, () => null, now);
    expect(source.db.prepare("SELECT name FROM sessions WHERE id = ?").get(SESSION)).toEqual({ name: "local name" });
    expect(destination.db.prepare("SELECT name FROM sessions WHERE id = ?").get(SESSION)).toEqual({ name: "portable name" });
    expect(rows(source, "roam_changes")).toHaveLength(1);
    expect(handlers.notices).toEqual([]);
  }, 5000);

  it("canonical duplicate numbers survive forwarding as negative zero", async () => {
    const root = replica();
    const original = todo("todo-1", 1, "first");
    original.body!.created_at = 0;
    const wire = (after: number, id: string) => {
      const value = artifact(root, [original], { after, id });
      const text = readFileSync(value.file, "utf8").replace('"created_at":0', '"created_at":-0');
      const bytes = Buffer.from(text);
      writeFileSync(value.file, bytes);
      value.byteLength = bytes.length;
      value.sha256 = createHash("sha256").update(bytes).digest("hex");
      return value;
    };
    apply(root, await validate(wire(0, "first")));
    const id = root.db.prepare("SELECT id FROM todos WHERE uuid = 'todo-1'").get();
    apply(root, await validate(wire(1, "forwarded")));
    expect(rows(root, "roam_changes")).toHaveLength(1);
    expect(root.db.prepare("SELECT id FROM todos WHERE uuid = 'todo-1'").get()).toEqual(id);
    expect(root.db.prepare("SELECT last_seq FROM roam_cursors").get()).toEqual({ last_seq: 2 });
  }, 5000);

  it("losing versions still append once", async () => {
    const root = replica();
    const handlers = effects();
    const newer = todo("todo-1", 1, "new", clock(200), "new");
    const older = todo("todo-1", 1, "old", clock(100), "old");
    apply(root, await batch(root, [newer]), handlers);
    apply(root, await batch(root, [older], { after: 1, id: "older" }), handlers);
    apply(root, await batch(root, [older], { after: 2, id: "forward-older" }), handlers);
    expect(root.db.prepare("SELECT uuid, text FROM todos").all()).toEqual([{ uuid: "todo-1", text: "new" }]);
    expect(root.db.prepare("SELECT change_id FROM roam_changes ORDER BY seq").all()).toEqual([{ change_id: "new" }, { change_id: "old" }]);
    expect(handlers.notices).toEqual([root.storeKey]);
  }, 5000);

  it("a losing change cannot rewrite an immutable origin", async () => {
    const root = replica();
    const first = session(clock(200), "session-first");
    apply(root, await batch(root, [first]));
    const bad: Change = { ...first, changeId: "wrong-origin", clock: clock(100), body: { ...first.body!, origin_machine: B } };
    const value = await batch(root, [bad], { after: 1, id: "wrong-origin" });
    const before = state(root);
    expect(() => apply(root, value)).toThrow(/origin|immutable|identity/i);
    expect(state(root)).toBe(before);
  }, 5000);

  it("a tombstoned session cannot be recreated with a different origin", async () => {
    const root = replica();
    const first = session(clock(100), "session-first");
    apply(root, await batch(root, [first]));
    apply(root, await batch(root, [deleted(first, clock(101), "session-delete")], { after: 1, id: "delete" }));
    const bad: Change = { ...first, changeId: "session-wrong-origin", clock: clock(102), body: { ...first.body!, origin_machine: B } };
    const value = await batch(root, [bad], { after: 2, id: "wrong-origin" });
    const before = state(root);
    expect(() => apply(root, value)).toThrow(/origin|immutable|identity/i);
    expect(state(root)).toBe(before);
    expect(root.db.prepare("SELECT deleted FROM roam_versions WHERE entity = 'sessions' AND row_key = ?").get(SESSION)).toEqual({ deleted: 1 });
    const restored: Change = { ...first, changeId: "session-restored", clock: clock(103) };
    apply(root, await batch(root, [restored], { after: 2, id: "restored" }));
    expect(root.db.prepare("SELECT origin_machine FROM sessions WHERE id = ?").get(SESSION)).toEqual({ origin_machine: A });
  }, 5000);

  it("a tombstoned todo cannot be recreated under a different session", async () => {
    const root = replica();
    const first = todo("todo-1", 1, "first", clock(100));
    apply(root, await batch(root, [first]));
    apply(root, await batch(root, [deleted(first, clock(101), "todo-delete")], { after: 1, id: "delete" }));
    const bad: Change = { ...first, changeId: "todo-wrong-session", clock: clock(102), writerSession: "session-2", body: { ...first.body!, session_id: "session-2" } };
    const value = await batch(root, [bad], { after: 2, id: "wrong-session" });
    const before = state(root);
    expect(() => apply(root, value)).toThrow(/session|immutable|identity/i);
    expect(state(root)).toBe(before);
    expect(root.db.prepare("SELECT deleted FROM roam_versions WHERE entity = 'todos' AND row_key = 'todo-1'").get()).toEqual({ deleted: 1 });
  }, 5000);

  it("cursor skip overlap and log gap refuse", async () => {
    const root = replica();
    const first = todo("todo-1", 1, "first");
    const skip = await batch(root, [first], { after: 1, id: "skip" });
    const untouched = state(root);
    expect(() => apply(root, skip)).toThrow(/cursor|sequence/i);
    expect(state(root)).toBe(untouched);
    apply(root, await batch(root, [first]));
    const accepted = state(root);
    const overlap = await batch(root, [todo("todo-2", 2, "second")], { id: "overlap" });
    expect(() => apply(root, overlap)).toThrow(/cursor|sequence/i);
    expect(state(root)).toBe(accepted);
    const gap = artifact(root, [first, todo("todo-2", 2, "second")], { id: "gap" });
    replaceWireRecord(gap, 1, record => { record.seq = 3; });
    await expect(validate(gap)).rejects.toThrow(/sequence/i);
    expect(state(root)).toBe(accepted);
  }, 5000);

  it("a validated batch cannot be applied to a different store", async () => {
    const root = replica();
    const value = await batch(root, [todo("todo-1", 1, "first")]);
    root.db.prepare("UPDATE roam_meta SET store_key = 'worktree:other:workspace'").run();
    const before = state(root);
    expect(() => apply(root, value)).toThrow(/store/i);
    expect(state(root)).toBe(before);
  }, 5000);

  it("an unsafe validated snapshot leaves the destination unchanged", async () => {
    const root = replica();
    const value = await batch(root, [todo("todo-1", 1, "first")]);
    chmodSync(value.file, 0o644);
    const before = state(root);
    expect(() => apply(root, value)).toThrow(/unsafe/i);
    expect(state(root)).toBe(before);
  }, 5000);

  it("apply refuses a caller-owned transaction", async () => {
    const root = replica();
    const value = await batch(root, [todo("todo-1", 1, "first")]);
    const before = state(root);
    root.db.exec("BEGIN");
    try { expect(() => apply(root, value)).toThrow(/transaction/i); }
    finally { root.db.exec("ROLLBACK"); }
    expect(state(root)).toBe(before);
  }, 5000);

  it("invalid last record leaves all state unchanged", async () => {
    const root = replica();
    const invalid = artifact(root, [todo("todo-1", 1, "first"), todo("todo-2", 2, "last")]);
    replaceWireRecord(invalid, 1, record => { record.schema = 13; });
    const before = state(root);
    await expect(validate(invalid)).rejects.toThrow();
    expect(state(root)).toBe(before);
    const snapshot = await batch(root, [todo("todo-1", 1, "first")]);
    const altered = readFileSync(snapshot.file, "utf8").replace('"text":"first"', '"text":"fIrst"');
    writeFileSync(snapshot.file, altered);
    expect(() => apply(root, snapshot)).toThrow(/digest/i);
    expect(state(root)).toBe(before);
  }, 5000);

  it("a later todo collision rolls back earlier rows and lexical effects", async () => {
    const root = replica();
    unloggedTodo(root, "local-uuid", 2);
    const handlers = effects();
    const value = await batch(root, [todo("first-uuid", 1, "firsttext", clock(100)), todo("incoming-uuid", 2, "remote", clock(101))]);
    const before = state(root);
    expect(() => apply(root, value, handlers)).toThrow(/local-uuid.*incoming-uuid|incoming-uuid.*local-uuid/i);
    expect(state(root)).toBe(before);
    expect(root.db.prepare("SELECT rowid FROM todos_fts WHERE todos_fts MATCH 'firsttext'").all()).toEqual([]);
    expect(root.db.prepare("SELECT rowid FROM todos_fts WHERE todos_fts MATCH 'localtext'").all()).toHaveLength(1);
    expect(handlers.notices).toEqual([]);
  }, 5000);

  it("unlogged collision replaces only for a known foreign home", async () => {
    const root = replica();
    unloggedTodo(root);
    root.db.prepare("INSERT INTO roam_sessions(session_id, epoch, state) VALUES (?, 1, 'frozen')").run(SESSION);
    const handlers = effects();
    const value = await batch(root, [todo("incoming-uuid", 1, "remotetext")]);
    apply(root, value, handlers, id => id === SESSION ? assigned(A) : null);
    expect(root.db.prepare("SELECT uuid, text FROM todos").all()).toEqual([{ uuid: "incoming-uuid", text: "remotetext" }]);
    expect(root.db.prepare("SELECT rowid FROM todos_fts WHERE todos_fts MATCH 'localtext'").all()).toEqual([]);
    expect(root.db.prepare("SELECT rowid FROM todos_fts WHERE todos_fts MATCH 'remotetext'").all()).toHaveLength(1);
    expect(root.db.prepare("SELECT state FROM roam_sessions WHERE session_id = ?").get(SESSION)).toEqual({ state: "frozen" });
    expect(handlers.notices).toEqual([root.storeKey]);
    expect(handlers.calls[0]).toMatchObject({ before: { body: { uuid: "local-uuid" } }, after: null, change: { rowKey: "local-uuid", op: "delete", body: null } });
  }, 5000);

  it("a winning todo update removes an unlogged collision and both old search entries", async () => {
    const root = replica();
    unloggedTodo(root, "local-uuid", 2);
    const handlers = effects();
    const first = todo("incoming-uuid", 1, "oldremote", clock(100));
    apply(root, await batch(root, [first]), handlers);
    const original = root.db.prepare("SELECT id FROM todos WHERE uuid = 'incoming-uuid'").get();
    const update: Change = { ...first, changeId: "update", clock: clock(101), body: { ...first.body!, seq: 2, text: "newremote" } };
    apply(root, await batch(root, [update], { after: 1, id: "update" }), handlers, () => assigned(A));
    expect(root.db.prepare("SELECT uuid, seq, text FROM todos").all()).toEqual([{ uuid: "incoming-uuid", seq: 2, text: "newremote" }]);
    expect(root.db.prepare("SELECT id FROM todos WHERE uuid = 'incoming-uuid'").get()).toEqual(original);
    expect(root.db.prepare("SELECT rowid FROM todos_fts WHERE todos_fts MATCH 'localtext OR oldremote'").all()).toEqual([]);
    expect(root.db.prepare("SELECT rowid FROM todos_fts WHERE todos_fts MATCH 'newremote'").all()).toHaveLength(1);
    expect(handlers.notices).toEqual([root.storeKey, root.storeKey]);
  }, 5000);

  it("unknown home quarantines instead of replacing", async () => {
    const root = replica();
    unloggedTodo(root);
    root.db.prepare("INSERT INTO roam_sessions(session_id, epoch, state) VALUES (?, 1, 'retired')").run(SESSION);
    const value = await batch(root, [todo("incoming-uuid", 1, "remote")]);
    const before = state(root);
    expect(() => apply(root, value, effects(), id => id === SESSION ? "unknown" : assigned(A))).toThrow(/local-uuid.*incoming-uuid|incoming-uuid.*local-uuid/i);
    expect(state(root)).toBe(before);
    expect(root.db.prepare("SELECT rowid FROM todos_fts WHERE todos_fts MATCH 'localtext'").all()).toHaveLength(1);
  }, 5000);

  it("local home quarantines instead of replacing", async () => {
    const root = replica();
    unloggedTodo(root);
    root.db.prepare("INSERT INTO roam_sessions(session_id, epoch, state) VALUES (?, 1, 'retired')").run(SESSION);
    const value = await batch(root, [todo("incoming-uuid", 1, "remote")]);
    const before = state(root);
    expect(() => apply(root, value, effects(), () => assigned(B))).toThrow(/local-uuid.*incoming-uuid|incoming-uuid.*local-uuid/i);
    expect(state(root)).toBe(before);
  }, 5000);

  it("unassigned home quarantines instead of replacing", async () => {
    const root = replica();
    unloggedTodo(root);
    const value = await batch(root, [todo("incoming-uuid", 1, "remote")]);
    const before = state(root);
    expect(() => apply(root, value, effects(), () => null)).toThrow(/local-uuid.*incoming-uuid|incoming-uuid.*local-uuid/i);
    expect(state(root)).toBe(before);
  }, 5000);

  it("tracked collisions report both UUIDs without consulting a failed home lookup", async () => {
    const root = replica();
    seedSession(root.db, SESSION, 1, root.storeKey, 4096);
    unloggedTodo(root);
    const value = await batch(root, [todo("incoming-uuid", 1, "remote")]);
    const before = state(root);
    expect(() => apply(root, value, effects(), () => { throw new Error("lookup failed"); }))
      .toThrow(/local-uuid.*incoming-uuid|incoming-uuid.*local-uuid/i);
    expect(state(root)).toBe(before);
  }, 5000);

  it("todo conflict replaces only unlogged non-home rows and retains tracked tombstones", async () => {
    const root = replica();
    seedSession(root.db, SESSION, 1, root.storeKey, 4096);
    unloggedTodo(root);
    const old = root.db.prepare("SELECT id, text FROM todos WHERE uuid = 'local-uuid'").get() as { id: number; text: string };
    root.db.prepare("INSERT INTO todos_fts(todos_fts, rowid, text) VALUES ('delete', ?, ?)").run(old.id, old.text);
    root.db.prepare("DELETE FROM todos WHERE uuid = 'local-uuid'").run();
    root.db.prepare("UPDATE roam_meta SET capture_enabled = 0").run();
    unloggedTodo(root);
    root.db.prepare("UPDATE roam_meta SET capture_enabled = 1").run();
    const value = await batch(root, [todo("incoming-uuid", 1, "remote")]);
    const before = state(root);
    expect(() => apply(root, value, effects(), () => assigned(A))).toThrow(/local-uuid.*incoming-uuid|incoming-uuid.*local-uuid/i);
    expect(state(root)).toBe(before);
    expect(root.db.prepare("SELECT deleted FROM roam_versions WHERE entity = 'todos' AND row_key = 'local-uuid'").get()).toEqual({ deleted: 1 });
    expect(root.db.prepare("SELECT uuid, text FROM todos").all()).toEqual([{ uuid: "local-uuid", text: "localtext" }]);
  }, 5000);

  it("empty batches create no receipt or cursor", async () => {
    const root = replica();
    const value = await batch(root, []);
    const before = state(root);
    expect(() => apply(root, value)).toThrow(/empty/i);
    expect(state(root)).toBe(before);
  }, 5000);

  it("observes the remote clock and rolls back an overflow", async () => {
    const root = replica();
    root.db.prepare("UPDATE roam_meta SET hlc_ms = 1000, hlc_count = 4").run();
    const value = await batch(root, [todo("todo-1", 1, "first", clock(1000, 8))]);
    apply(root, value, effects(), () => null, 1000);
    expect(root.db.prepare("SELECT hlc_ms, hlc_count FROM roam_meta").get()).toEqual({ hlc_ms: 1000, hlc_count: 9 });
    root.db.prepare("UPDATE roam_meta SET hlc_count = ?").run(Number.MAX_SAFE_INTEGER);
    const bad = await batch(root, [todo("todo-2", 2, "second", clock(1000, 3))], { after: 1, id: "overflow" });
    const before = state(root);
    expect(() => apply(root, bad, effects(), () => null, 1000)).toThrow(/overflow/i);
    expect(state(root)).toBe(before);
  }, 5000);

  it("rejects non-safe integers and future skew before import", async () => {
    const root = replica();
    const before = state(root);
    const unsafe = todo("unsafe", Number.MAX_SAFE_INTEGER + 1, "bad");
    const future = todo("future", 1, "bad", clock(1_300_001));
    for (const record of [unsafe, future]) {
      await expect(validate(artifact(root, [record]))).rejects.toThrow();
      expect(state(root)).toBe(before);
    }
    const atLimit = await batch(root, [todo("limit", 1, "ok", clock(1_300_000))]);
    apply(root, atLimit);
    expect(root.db.prepare("SELECT uuid FROM todos").all()).toEqual([{ uuid: "limit" }]);
  }, 5000);

  it("rechecks clock skew at apply time before writing", async () => {
    const root = replica();
    const value = await batch(root, [todo("todo-1", 1, "first", clock(500_001))]);
    const before = state(root);
    expect(() => apply(root, value, effects(), () => null, 200_000)).toThrow(/skew|future/i);
    expect(state(root)).toBe(before);
  }, 5000);

  it("rechecks clock skew for a duplicate forwarded after wall-clock reversal", async () => {
    const root = replica();
    const change = todo("todo-1", 1, "first", clock(500_001));
    apply(root, await batch(root, [change]), effects(), () => null, 500_001);
    const forwarded = await batch(root, [change], { after: 1, id: "forwarded" });
    const before = state(root);
    expect(() => apply(root, forwarded, effects(), () => null, 200_000)).toThrow(/skew|future/i);
    expect(state(root)).toBe(before);
  }, 5000);

  it("validates the exact hard wire limit", async () => {
    const root = replica();
    const empty = artifact(root, [todo("limit", 1, "")]);
    const exact = artifact(root, [todo("limit", 1, "x".repeat(HARD_LIMIT - empty.byteLength))]);
    expect(exact.byteLength).toBe(HARD_LIMIT);
    expect((await validate(exact)).byteLength).toBe(HARD_LIMIT);
    expect(rows(root, "roam_receipts")).toEqual([]);
  }, 5000);

  it("rejects a wire batch one byte over the hard limit", async () => {
    const root = replica();
    const empty = artifact(root, [todo("limit", 1, "")]);
    const oversized = artifact(root, [todo("limit", 1, "x".repeat(HARD_LIMIT - empty.byteLength + 1))]);
    const before = state(root);
    expect(oversized.byteLength).toBe(HARD_LIMIT + 1);
    await expect(validate(oversized)).rejects.toThrow(/size|limit/i);
    expect(state(root)).toBe(before);
  }, 5000);

  it("post-commit invalidation failure does not turn a committed receipt into failure", async () => {
    const root = replica();
    const handlers = effects();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const value = await batch(root, [todo("todo-1", 1, "first")]);
      const receipt = apply(root, value, { ...handlers, effects: { ...handlers.effects, committed() { throw new Error("notification failed"); } } });
      expect(receipt.sha256).toBe(value.sha256);
      expect(rows(root, "roam_receipts")).toHaveLength(1);
      expect(rows(root, "todos")).toHaveLength(1);
    } finally { log.mockRestore(); }
  }, 5000);
});

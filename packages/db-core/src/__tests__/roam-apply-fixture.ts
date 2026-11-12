import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach } from "vitest";
import { createReplica } from "@spider/db-core/testutil";
import type { ReplicaFixture } from "./roam-fixture";
import { validateBatch, writePrivateBatch } from "@spider/db-core/roam/codec";
import { exportBatch } from "@spider/db-core/roam/export";
import { applyBatch } from "@spider/db-core/roam/apply";
import type { ApplyReceipt, BatchArtifact, BatchHeader, Change, Home, Hlc, JsonObject, ReplicaEffects, Scope, StoreKey, ValidatedBatch } from "@spider/db-core/roam/types";

export const A = "11111111-1111-4111-8111-111111111111";
export const B = "22222222-2222-4222-8222-222222222222";
export const C = "33333333-3333-4333-8333-333333333333";
export const SA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const SB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
export const NOW = 1_000_000;
export const SESSION = "session-1";

const roots: ReplicaFixture[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) root.close();
});

export function replica(scope: Scope = "worktree", machine: string = B): ReplicaFixture {
  const root = createReplica(scope, machine);
  roots.push(root);
  return root;
}

export function clock(ms: number = 1000, count: number = 0, machine: string = A, stream: string = SA): Hlc {
  return { ms, count, machine, stream };
}

export function todo(uuid: string, seq: number, text: string, at: Hlc = clock(), changeId: string = `put-${uuid}`): Change {
  return {
    changeId, entity: "todos", rowKey: uuid, op: "put", clock: at,
    writerSession: SESSION, writerEpoch: 1, schema: 14,
    body: { uuid, session_id: SESSION, seq, text, done: 0, created_at: 1, updated_at: null },
  };
}

export function session(at: Hlc = clock(), changeId: string = "put-session"): Change {
  return {
    changeId, entity: "sessions", rowKey: SESSION, op: "put", clock: at,
    writerSession: SESSION, writerEpoch: 1, schema: 14,
    body: { id: SESSION, parent_session_id: null, name: "portable", reason: null, started_at: 1, ended_at: null, summary: null, origin_machine: A },
  };
}

export function memory(uuid: string, content: string, at: Hlc = clock(), changeId: string = `put-${uuid}`): Change {
  return {
    changeId, entity: "memory", rowKey: uuid, op: "put", clock: at,
    writerSession: null, writerEpoch: null, schema: 14,
    body: { uuid, category: "insight", content, link: null, status: "active", source: "user", confidence: null, session_id: null, created_at: 1, updated_at: null, justification: null, evidence: null, machine_id: null },
  };
}

export function home(machine: string, epoch: number, at: Hlc = clock(), move: string | null = null, changeId: string = `home-${epoch}`): Change {
  return {
    changeId, entity: "session_homes", rowKey: SESSION, op: "put", clock: at,
    writerSession: null, writerEpoch: null, schema: 14,
    body: { session_id: SESSION, machine_id: machine, epoch, move_id: move, updated_at: epoch },
  };
}

export function deleted(change: Change, at: Hlc, changeId: string): Change {
  return { ...change, changeId, op: "delete", clock: at, body: null };
}

interface BatchOptions { sender?: string; stream?: string; after?: number; id?: string; now?: number }

export function artifact(root: ReplicaFixture, changes: readonly Change[], options: BatchOptions = {}): BatchArtifact {
  const after = options.after ?? 0;
  const header: BatchHeader = {
    protocol: 1, schema: 14, batchId: options.id ?? "batch-1", senderMachine: options.sender ?? A,
    senderStream: options.stream ?? SA, storeKey: root.storeKey, after, through: after + changes.length, count: changes.length,
  };
  const records = changes.map((change, index) => ({ seq: after + index + 1, ...change }));
  const bytes = Buffer.from([JSON.stringify(header), ...records.map(record => JSON.stringify(record))].join("\n") + "\n");
  const dir = join(root.root, "incoming");
  mkdirSync(dir, { mode: 0o700, recursive: true });
  return { file: writePrivateBatch(dir, bytes), byteLength: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), header };
}

export async function validate(input: BatchArtifact, now: number = NOW): Promise<ValidatedBatch> {
  return validateBatch(input, { storeKey: input.header.storeKey, senderMachine: input.header.senderMachine, senderStream: input.header.senderStream, now });
}

export async function batch(root: ReplicaFixture, changes: readonly Change[], options: BatchOptions = {}): Promise<ValidatedBatch> {
  return validate(artifact(root, changes, options), options.now ?? NOW);
}

export interface EffectHarness {
  effects: ReplicaEffects; notices: StoreKey[];
  calls: Array<{ before: { rowid: number; body: JsonObject } | null; after: { rowid: number } | null; change: Change }>;
}

export function effects(): EffectHarness {
  const notices: StoreKey[] = [];
  const calls: Array<{ before: { rowid: number; body: JsonObject } | null; after: { rowid: number } | null; change: Change }> = [];
  return {
    notices, calls,
    effects: {
      winning(db, before, after, change) {
        calls.push({ before: structuredClone(before), after: structuredClone(after), change: structuredClone(change) });
        if (change.entity !== "todos") return;
        if (before) db.prepare("INSERT INTO todos_fts(todos_fts, rowid, text) VALUES ('delete', ?, ?)").run(before.rowid, before.body.text);
        if (after) {
          const row = db.prepare("SELECT text FROM todos WHERE rowid = ?").get(after.rowid) as { text: string };
          db.prepare("INSERT INTO todos_fts(rowid, text) VALUES (?, ?)").run(after.rowid, row.text);
        }
      },
      committed(key) { notices.push(key); },
    },
  };
}

export type HomeLookup = (sessionId: string) => Home | null | "unknown";
export function apply(root: ReplicaFixture, value: ValidatedBatch, handlers: EffectHarness = effects(), sessionHome: HomeLookup = () => null, now: number = NOW): ApplyReceipt {
  return applyBatch(root.db, value, { hubMachine: A, effects: handlers.effects, now, sessionHome });
}

export function assigned(machineId: string, epoch: number = 1): Home {
  return { sessionId: SESSION, machineId, epoch, moveId: null, updatedAt: 1 };
}

export async function transfer(source: ReplicaFixture, destination: ReplicaFixture, handlers: EffectHarness = effects()): Promise<ApplyReceipt | null> {
  const meta = source.db.prepare("SELECT machine_id, stream_id FROM roam_meta").get() as { machine_id: string; stream_id: string };
  const cursor = destination.db.prepare("SELECT last_seq FROM roam_cursors WHERE peer_machine = ? AND peer_stream = ?")
    .get(meta.machine_id, meta.stream_id) as { last_seq: number } | undefined;
  const after = cursor?.last_seq ?? 0;
  const value = await exportBatch(source.db, { after, targetBytes: 4 * 1024 * 1024, batchId: `batch-${source.machineId}-${after}` }, { encode: (_entity, body) => body });
  if (value.header.count === 0) return null;
  const now = Date.now() + 1_000;
  const validated = await validate(value, now);
  return apply(destination, validated, handlers, () => null, now);
}

export function rows(root: ReplicaFixture, table: string): unknown[] {
  return root.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
}

import { expect, it, vi } from "vitest";
import { applyBatch } from "@spider/db-core/roam/apply";
import { createReplicaEffects } from "@spider/db-core/roam/effects";
import { A, NOW, batch, memory, replica } from "../../../db-core/src/__tests__/roam-apply-fixture";
import { drainEmbedQueue, enqueueEmbed } from "../embeddings/queue";

it("replica replacement survives stale embedding completion", async () => {
  const root = replica("repo");
  root.db.prepare("INSERT INTO memory(uuid,category,content,status,created_at) VALUES ('mem-1','insight','old text','active',1)").run();
  enqueueEmbed(root.db, "memory", "mem-1", "old text");
  let finish!: (vectors: Float32Array[]) => void;
  const draining = drainEmbedQueue(root.db, { model: "fixture", dim: 384, embed: () => new Promise(resolve => { finish = resolve; }) });
  const incoming = await batch(root, [memory("mem-1", "new text")]);
  try {
    applyBatch(root.db, incoming, { hubMachine: A, effects: createReplicaEffects(() => {}), now: NOW, sessionHome: () => null });
    expect(root.db.prepare("SELECT text FROM embed_queue WHERE owner_id='mem-1'").all()).toEqual([{ text: "new text" }]);
  } finally {
    finish([new Float32Array(384)]);
  }
  expect(await draining).toBe(0);
  expect(root.db.prepare("SELECT text FROM embed_queue WHERE owner_id='mem-1'").all()).toEqual([{ text: "new text" }]);
  expect(root.db.prepare("SELECT * FROM vector_map WHERE owner_id='mem-1'").all()).toEqual([]);
}, 5000);

it("same-text replacement is distinct from an in-flight queue entry", async () => {
  const now = vi.spyOn(Date, "now").mockReturnValue(12345);
  try {
    const root = replica("repo");
    root.db.prepare("INSERT INTO memory(uuid,category,content,status,created_at) VALUES ('mem-1','insight','same text','active',1)").run();
    enqueueEmbed(root.db, "memory", "mem-1", "same text");
    let finish!: (vectors: Float32Array[]) => void;
    const draining = drainEmbedQueue(root.db, { model: "fixture", dim: 384, embed: () => new Promise(resolve => { finish = resolve; }) });
    try {
      const incoming = await batch(root, [memory("mem-1", "same text")]);
      applyBatch(root.db, incoming, { hubMachine: A, effects: createReplicaEffects(() => {}), now: NOW, sessionHome: () => null });
    } finally { finish([new Float32Array(384)]); }
    expect(await draining).toBe(0);
    expect(root.db.prepare("SELECT text FROM embed_queue WHERE owner_id='mem-1'").all()).toEqual([{ text: "same text" }]);
    expect(root.db.prepare("SELECT * FROM vector_map WHERE owner_id='mem-1'").all()).toEqual([]);
  } finally { now.mockRestore(); }
}, 5000);

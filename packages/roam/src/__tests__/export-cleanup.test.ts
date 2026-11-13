import { afterEach, expect, it } from "vitest";
import { handleAgentOperation } from "../agent";
import { hash, openOutgoingStaging } from "../staging";
import { removeOutgoing } from "../stores";
import { network, BOX } from "./sync-fixture";
const fixtures: ReturnType<typeof network>[] = [];
afterEach(() => { for (const f of fixtures.splice(0)) f.close(); });
it("targeted release removes its artifact beyond the sweep page without deleting others", () => {
  const f = network(); fixtures.push(f);
  const pool = openOutgoingStaging(f.root, f.config.limits);
  try {
    for (let i = 0; i < 260; i++) { const manifest = { id: `keep-${i}`, kind: "batch" as const, byteLength: 0, sha256: hash(Buffer.alloc(0)), chunks: [] }; pool.prepare(manifest, null); pool.commit(manifest); }
    const target = { id: "zz-target", kind: "batch" as const, byteLength: 0, sha256: hash(Buffer.alloc(0)), chunks: [] };
    pool.prepare(target, null); pool.commit(target);
    removeOutgoing(f.root, target.id, f.config, () => true);
    expect(pool.inspect(target.id).current).toBeNull();
    expect(pool.inspect("keep-0").current).not.toBeNull();
    expect(pool.inspect("keep-259").current).not.toBeNull();
  } finally { pool.close(); }
}, 5000);
it("an acknowledged agent export releases files and quota exactly once", async () => {
  const f = network(); fixtures.push(f); f.seed(); const remote = f.remotes.get(BOX)!;
  const result = await handleAgentOperation({ id: "export-a", machineId: BOX, expectedEpoch: null, kind: "export",
    args: { storeKey: remote.worktree.storeKey, after: 0, targetBytes: 4096, batchId: "batch-a" } }, remote.ports);
  expect(result.code).toBe(0);
  const descriptor = result.value!.artifact as { sha256: string };
  const op = { id: "release-a", machineId: BOX, expectedEpoch: null, kind: "release-export", args: { exportId: "export-a", sha256: descriptor.sha256 } };
  expect((await handleAgentOperation({ ...op, id: "wrong", args: { ...op.args, sha256: "f".repeat(64) } }, remote.ports)).code).not.toBe(0);
  let staging = openOutgoingStaging(remote.ports.root, f.config.limits, false);
  expect(staging.inspect("export-a").current).not.toBeNull(); staging.close();
  expect((await handleAgentOperation(op, remote.ports)).code).toBe(0);
  staging = openOutgoingStaging(remote.ports.root, f.config.limits, false);
  expect(staging.inspect("export-a").current).toBeNull(); staging.close();
  expect((await handleAgentOperation(op, remote.ports)).code).toBe(0);
}, 5000);

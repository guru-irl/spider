import { expect, it, vi } from "vitest";
import { createReplica } from "@spider/db-core/testutil";
import { join } from "node:path";
import { openFreezeJournal } from "@spider/roam/journal";
import { createRunningIntentAuthority } from "@spider/roam/session-control";
import { publishOwnedMoveReadiness, type OwnedMoveReadinessInput } from "../move-readiness";
const HUB = "00000000-0000-4000-8000-000000000001";
it("proved live readmit publishes readiness for an originally untracked held lock without launching or releasing it", async () => {
  const f = createReplica("global", HUB), journal = openFreezeJournal(join(f.root, "journal.db"));
  try {
    const file = join(f.root, "session.jsonl"), home = { sessionId: "session-a", machineId: HUB, epoch: 4, moveId: "rollback-a", updatedAt: 1 };
    await createRunningIntentAuthority(f.db).set({ sessionId: "session-a", file, cwd: f.root, epoch: 4, desired: "running", suspended: null, moveId: "rollback-a" }, "readmit-a", { kind: "hub-return", machineId: HUB, moveId: "move-a" });
    journal.begin({ id: "readmit-a", machineId: HUB, kind: "move-readmit", expectedEpoch: 4, args: {} });
    const lock = { identity: { pid: 42, startIdentity: "owned-start" }, bootId: "boot-a", operationId: null, pendingOperationId: null, pendingCoreId: null, pendingFile: null };
    const caller = vi.fn(async () => ({ coreId: "core-a", address: "terminal-a" }));
    const input: OwnedMoveReadinessInput = { db: f.db, journal, sessionId: "session-a", machineId: HUB, file, cwd: f.root, epoch: 4, home,
      owner: async () => ({ pid: 42, startTime: "owned-start" }), lock: async () => lock, caller };
    await expect(publishOwnedMoveReadiness(input)).rejects.toThrow("participant-launch-provenance-unavailable");
    expect(caller).not.toHaveBeenCalled();
    const ready = await publishOwnedMoveReadiness({ ...input, readmitOperationId: "readmit-a" });
    expect(ready).toMatchObject({ opId: "readmit-a", epoch: 4, file, cwd: f.root, terminal: "terminal-a" });
    expect(lock.operationId).toBeNull(); expect(caller).toHaveBeenCalledOnce();
    await expect(publishOwnedMoveReadiness({ ...input, readmitOperationId: "readmit-a", lock: async () => ({ ...lock, identity: { pid: 43, startIdentity: "foreign" } }) })).rejects.toThrow("participant-launch-provenance-unavailable");
    expect(caller).toHaveBeenCalledOnce();
  } finally { f.close(); }
});

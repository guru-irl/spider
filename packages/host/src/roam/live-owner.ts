import type { ProcessIdentity } from "@spider/db-core/roam/types";
import { inspectIdLock, localBootId } from "@spider/herdr/sessions/id-lock";
import { createSessionLeases } from "@spider/herdr/sessions/lease";
import { processStartTime } from "../../../subagents/src/process-identity.js";

/** An acknowledgement may name the owner only while both ownership records match this process. */
export async function inspectLiveOwner(root: string, sessionId: string, file: string, readBootId: () => Promise<string> = localBootId): Promise<ProcessIdentity> {
  const [id, lease, bootId] = await Promise.all([
    inspectIdLock(root, sessionId), createSessionLeases(root).get(file), readBootId(),
  ]);
  const start = processStartTime(process.pid);
  if (!start || !bootId || !id || !lease || id.pendingOperationId !== null || id.bootId !== bootId ||
      id.identity.pid !== process.pid || id.identity.startIdentity !== start || lease.pid !== process.pid || lease.startIdentity !== start ||
      lease.bootId !== undefined && lease.bootId !== bootId) throw new Error("Participant ownership unavailable");
  return { bootId, pid: process.pid, startTime: start };
}

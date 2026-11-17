import { createHash } from "node:crypto";

/** Launch ids belong to the participant, not the hub operation namespace. */
export function participantLaunchId(machineId: string, sessionId: string, epoch: number, operationId: string): string {
  return `launch-${createHash("sha256").update(JSON.stringify([machineId, sessionId, epoch, operationId])).digest("hex").slice(0, 40)}`;
}


/** A newer launch satisfies an intent only through its durable restart history. */
export function participantLaunchSuccessor(journal: import("./contracts").Journal, machineId: string,
  intent: import("./contracts").HostIntent, operationId: string, requested: string, candidate: string): boolean {
  if (candidate === requested) return true;
  const base = requested.replace(/-restart-[1-9][0-9]*$/, ""), id = `${base}-restarts`;
  const sequence = (value: string): number => value === base ? 0 : value.startsWith(`${base}-restart-`) && /^[1-9][0-9]*$/.test(value.slice(base.length + 9)) ? Number(value.slice(base.length + 9)) : -1;
  const from = sequence(requested), to = sequence(candidate);
  if (from < 0 || !Number.isSafeInteger(to) || to <= from || journal.lookupOperation?.(id)?.machineId !== machineId) return false;
  try {
    journal.begin({ id, kind: "participant-restarts", machineId, expectedEpoch: intent.epoch,
      args: { sessionId: intent.sessionId, operationId, file: intent.file, cwd: intent.cwd, moveId: intent.moveId } });
    const entries = journal.read(id).filter(row => row.action === "restart");
    return entries.every((row, index) => row.result.sequence === index + 1) && to <= entries.length;
  } catch { return false; }
}

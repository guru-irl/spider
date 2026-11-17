import { createHash } from "node:crypto";

/** Launch ids belong to the participant, not the hub operation namespace. */
export function participantLaunchId(machineId: string, sessionId: string, epoch: number, operationId: string): string {
  return `launch-${createHash("sha256").update(JSON.stringify([machineId, sessionId, epoch, operationId])).digest("hex").slice(0, 40)}`;
}

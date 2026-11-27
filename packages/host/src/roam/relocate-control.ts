import type { MachineId, JsonObject } from "@spider/db-core/roam/types";
import type { Outcome } from "@spider/roam/contracts";
import type { RelocateHome, SessionId } from "@spider/roam/relocate/types";
import { startSessionControlSocket } from "@spider/roam/session-socket";

export async function serveRelocateShutdown(input: {
  sessionId: SessionId; runtimeRoot: string; machineId: MachineId;
  home(): Promise<RelocateHome | null>; shutdown(): Promise<void>;
}): Promise<{ close(): Promise<void> }> {
  let shutdown: Promise<void> | null = null;
  return startSessionControlSocket(input.runtimeRoot, input.sessionId, async ({ op, operation }) => {
    const reply = (code: 0 | 1 | 2 | 3, reason: string, home: RelocateHome | null = null): Outcome<JsonObject> => ({
      code, reason, operationId: operation.id, home, epoch: operation.expectedEpoch,
      repairCommand: code === 0 ? null : "Retry relocation from the Mac after checking the session home.",
      value: code === 0 ? { version: 1, sessionId: input.sessionId } : null,
    });
    if (op !== "shutdown" || operation.kind !== "session-shutdown" || operation.args.v0 !== true ||
        operation.args.sessionId !== input.sessionId || operation.machineId !== input.machineId) return reply(2, "invalid-v0-shutdown");
    let home: RelocateHome | null;
    try { home = await input.home(); } catch { return reply(3, "home-unavailable"); }
    if (!home || home.sessionId !== input.sessionId || home.machineId !== input.machineId || home.state !== "moving" ||
        home.moveId !== operation.args.moveId || home.epoch !== operation.expectedEpoch) return reply(3, "home-conflict", home);
    try {
      shutdown ??= input.shutdown();
      await shutdown;
      return reply(0, "session-shutdown", home);
    } catch { return reply(1, "session-shutdown-failed", home); }
  });
}

import type { MachineId, JsonObject } from "@spider/db-core/roam/types";
import type { Outcome } from "@spider/roam/contracts";
import type { RelocateHome, SessionId } from "@spider/roam/relocate/types";
import type { OwnerGeneration } from "@spider/roam/relocate/session-stop-types";
import { parseV0OwnerControl, startSessionControlSocket } from "@spider/roam/session-socket";

export async function serveRelocateShutdown(input: {
  sessionId: SessionId; runtimeRoot: string; machineId: MachineId;
  home(): Promise<RelocateHome | null>; shutdown(): Promise<void>;
  admittedOwner?: () => Promise<OwnerGeneration | null>;
  admittedEpoch?: number;
}): Promise<{ close(): Promise<void> }> {
  let shutdown: Promise<void> | null = null;
  const stoppedShutdowns = new Set<number>();
  return startSessionControlSocket(input.runtimeRoot, input.sessionId, async ({ op, operation }) => {
    const control = parseV0OwnerControl(operation);
    const reply = (code: 0 | 1 | 2 | 3, reason: string, home: RelocateHome | null = null, owner?: OwnerGeneration): Outcome<JsonObject> => ({
      code, reason, operationId: operation.id, home, epoch: operation.expectedEpoch,
      repairCommand: code === 0 || control ? null : "Retry relocation from the Mac after checking the session home.",
      value: code === 0 ? { version: 1, sessionId: input.sessionId, ...(owner ? { owner } : {}) } : null,
    });
    if (control) {
      if (control.sessionId !== input.sessionId || control.machineId !== input.machineId) return reply(2, "invalid-v0-owner-target");
      const inspecting = control.kind === "running-inspect";
      const matchesHome = (home: RelocateHome | null) => home?.sessionId === control.sessionId &&
        home.epoch === control.epoch && home.machineId === control.homeMachineId && (inspecting
          ? home.state === "running" && home.machineId === input.machineId && home.epoch === input.admittedEpoch
          : home.state === "stopped");
      const matchesOwner = async () => {
        const owner = await input.admittedOwner?.();
        return owner?.pid === control.owner.pid && owner.startIdentity === control.owner.startIdentity && owner.bootId === control.owner.bootId;
      };
      let home: RelocateHome | null;
      try {
        home = await input.home();
        if (!matchesHome(home)) return reply(3, "home-conflict", home);
        if (!(await matchesOwner())) return reply(3, "owner-conflict", home);
        // Reading the ownership records can yield while a new home is applied.
        home = await input.home();
        if (!matchesHome(home)) return reply(3, "home-conflict", home);
      } catch { return reply(3, "ownership-unavailable"); }
      if (inspecting) return reply(0, "session-inspect", home, control.owner);

      if (!stoppedShutdowns.has(control.epoch)) {
        stoppedShutdowns.add(control.epoch);
        // Let the socket send the intake acknowledgment before pi starts closing.
        setImmediate(async () => {
          try {
            if (await matchesOwner() && matchesHome(await input.home())) {
              await input.shutdown();
              return;
            }
          } catch { /* No effect on uncertain ownership; a later request can retry. */ }
          stoppedShutdowns.delete(control.epoch);
        });
      }
      return reply(0, "session-shutdown", home);
    }
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
  }, { v0OwnerControl: true });
}

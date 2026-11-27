import type { RoamConfig } from "../contracts";
import { AwayHomeRecoveryRequired } from "./home-refusals";
import { MacSessionOccupied, MacSourceNotStopped } from "./home";
import type { RunningHome, SetHomePorts, SetHomeRequest, V0Refusal, V0RefusalCode, V0Result } from "./types";

type ReplicationAvailability = Pick<RoamConfig, "enabled" | "machineId">;

export function setHomeReplicationRefusal(destination: string, replication: ReplicationAvailability): V0Refusal | null {
  return replication.enabled || destination === replication.machineId ? null : {
    code: "replication-disabled",
    message: "The reassigned home cannot reach the box while replication is disabled.",
    nextStep: "Run spider roam enable on the Mac, then retry set-home --force.",
  };
}

export const forceWarning: string = "The old source must not run again. Unsynced conversation can be lost. " +
  "If the old source is a box that may return, close its Pi session and run " +
  "systemctl --user disable --now spider-roam-supervisor-v0.service on that box before it reconnects. " +
  "If the legacy unit is still installed, also run systemctl --user disable --now spider-roam-supervisor.service.";

function refuse(code: V0RefusalCode, message: string, nextStep: string): V0Result<RunningHome> {
  return {ok:false,refusal:{code,message,nextStep}};
}

export async function setHome(request: SetHomeRequest, ports: SetHomePorts, replication?: ReplicationAvailability): Promise<V0Result<RunningHome>> {
  const {sessionId,destinationMachine} = request;
  const phrase = `reassign ${sessionId} to ${destinationMachine}; source will not run`;
  if (!request.force || request.confirmation !== phrase) {
    return refuse("confirmation-required", forceWarning, `Type exactly: ${phrase}`);
  }
  const cannotReplicate = replication && setHomeReplicationRefusal(destinationMachine, replication);
  if (cannotReplicate) return { ok: false, refusal: cannotReplicate };
  const retry = `Run spider roam relocate ${sessionId} ${destinationMachine} to resume the destination copy.`;
  try {
    return await ports.withSession(sessionId, async () => {
      let failure: V0RefusalCode = "home-unavailable";
      try {
        const current = await ports.homes.read(sessionId);
        if (current === null) return refuse("home-unavailable", "No managed home is available to reassign.",
          "Restore spider.db or re-sync it from a peer if the session was moved. Then retry set-home --force on the Mac.");
        failure = "destination-copy-missing";
        const located = await ports.locate(destinationMachine,sessionId);
        if (!located.ok) return located;
        const next: RunningHome = {sessionId,machineId:destinationMachine,epoch:current.epoch+1,
          state:"running",destination:null,moveId:ports.newMoveId(),updatedAt:Date.now()};
        failure = "home-unavailable";
        const changed = await ports.homes.compareAndSwap(current,next);
        if (changed.kind === "conflict") return refuse("home-conflict", "The home changed before reassignment.", "Read the current home and confirm its reassignment again.");
        failure = "install-failed";
        const activated = await ports.activate(next,located.value);
        if (!activated.ok) return activated;
        failure = "sync-failed";
        const published = await ports.publishHome(next,destinationMachine);
        if (!published.ok) return published;
        return {ok:true,value:next};
      } catch (error) {
        if (error instanceof MacSourceNotStopped) return {ok:false,refusal:error.refusal};
        if (error instanceof MacSessionOccupied) return refuse("stop-timeout", error.message + ".",
          "Close the session on the Mac, then retry set-home --force. If it is already closed, run spider roam doctor on the Mac.");
        if (error instanceof AwayHomeRecoveryRequired) return {ok:false,refusal:error.refusal(sessionId)};
        const messages: Partial<Record<V0RefusalCode,string>> = {
          "home-unavailable":"The hub could not read or update the home.",
          "destination-copy-missing":"The destination copy could not be verified.",
          "install-failed":"The reassigned destination copy could not be activated.",
          "sync-failed":"The reassigned home could not be published to the destination.",
        };
        return refuse(failure,messages[failure]!,failure === "home-unavailable"
          ? "Run spider roam doctor on the Mac and repair the home store before retrying set-home --force."
          : retry);
      }
    });
  } catch {
    return refuse("home-unavailable","The hub could not lock this session for reassignment.","Run the reassignment command on the Mac after its home store is available.");
  }
}

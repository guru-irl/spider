import type { RunningHome, SetHomePorts, SetHomeRequest, V0RefusalCode, V0Result } from "./types";

function refuse(code: V0RefusalCode, message: string, nextStep: string): V0Result<RunningHome> {
  return {ok:false,refusal:{code,message,nextStep}};
}

export async function setHome(request: SetHomeRequest, ports: SetHomePorts): Promise<V0Result<RunningHome>> {
  const {sessionId,destinationMachine} = request;
  const phrase = `reassign ${sessionId} to ${destinationMachine}; source will not run`;
  if (!request.force || request.confirmation !== phrase) {
    return refuse("confirmation-required", "The old source must never run again; unsynced conversation can be lost.", `Type exactly: ${phrase}`);
  }
  const retry = `Run spider roam relocate ${sessionId} ${destinationMachine} to resume the destination copy.`;
  try {
    return await ports.withSession(sessionId, async () => {
      let failure: V0RefusalCode = "home-unavailable";
      try {
        const current = await ports.homes.read(sessionId);
        if (current === null) return refuse("home-unavailable", "No managed home is available to reassign.", "Choose a session with an existing managed home on the Mac.");
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
      } catch {
        const messages: Partial<Record<V0RefusalCode,string>> = {
          "home-unavailable":"The hub could not read or update the home.",
          "destination-copy-missing":"The destination copy could not be verified.",
          "install-failed":"The reassigned destination copy could not be activated.",
          "sync-failed":"The reassigned home could not be published to the destination.",
        };
        return refuse(failure,messages[failure]!,retry);
      }
    });
  } catch {
    return refuse("home-unavailable","The hub could not lock this session for reassignment.","Run the reassignment command on the Mac after its home store is available.");
  }
}

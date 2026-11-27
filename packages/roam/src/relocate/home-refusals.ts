import type { AwayHomeFence } from "./away-home";
import type { SessionId, V0Refusal } from "./types";

export class MacSourceNotStopped extends Error {
  constructor(readonly refusal: V0Refusal) { super(refusal.message); }
}

export class MacSessionOccupied extends Error {
  constructor(cause: unknown) { super("The Mac session ID is not known to be free", { cause }); }

  refusal(retry: string): V0Refusal {
    return {
      code: "stop-timeout",
      message: `${this.message}.`,
      nextStep: `Close the session on the Mac, then retry ${retry}. If it is already closed, run spider roam doctor on the Mac.`,
    };
  }
}

export class AwayHomeRecoveryRequired extends Error {
  constructor(readonly fence: AwayHomeFence, readonly pendingRelocation: boolean) {
    super("The home database predates or conflicts with the away-home fence");
  }

  refusal(sessionId: SessionId): V0Refusal {
    const { machineId } = this.fence;
    return this.pendingRelocation ? {
      code: "home-unavailable",
      message: `The fence records a move to ${machineId}. You can only finish that move.`,
      nextStep: `Run spider roam relocate ${sessionId} ${machineId} to finish the move.`,
    } : {
      code: "home-unavailable",
      message: `The database cannot verify the away home on ${machineId}.`,
      nextStep: "Restore spider.db or re-sync it from a peer. Then retry set-home --force on the Mac.",
    };
  }
}

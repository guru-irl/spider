import type { StopObservation } from "./session-stop-types";
import type { HomeSupervisor, HomeSupervisorPorts, SessionId, StoppedHome, V0Refusal } from "./types";

export type StopSupervisorPorts = HomeSupervisorPorts & {
  stopStopped(home: StoppedHome): Promise<StopObservation>;
};

const TICK_MS = 10_000;

export function createHomeSupervisor(ports: StopSupervisorPorts, warn: (line: string) => void = line => { process.stderr.write(`${line}\n`); }): HomeSupervisor {
  const managed = new Set<SessionId>();
  const reported = new Map<SessionId | null, string>();
  let inFlight: Promise<void> | null = null;
  let cancel: (() => void) | null = null;
  let started = false;
  let stopping = false;
  const unavailable = (): V0Refusal => ({
    code: "home-unavailable", message: "The local session home could not be read.",
    nextStep: "Restore the local home database before starting this session.",
  });

  function report(sessionId: SessionId | null, detail: V0Refusal): void {
    const line = `Roaming supervisor ${sessionId ?? "service"} (${detail.code}): ${detail.message} ${detail.nextStep}`.replace(/[\u0000-\u001f\u007f]/g," ");
    if (reported.get(sessionId) === line) return;
    reported.set(sessionId,line);
    warn(line);
    try { ports.report(sessionId,detail); } catch { /* Keep enforcing after a failed diagnostic write. */ }
  }

  async function stopSession(sessionId: SessionId): Promise<void> {
    try {
      const result = await ports.stop(sessionId);
      if (!result.ok) report(sessionId, result.refusal);
      else reported.delete(sessionId);
    } catch {
      report(sessionId, { code: "stop-timeout", message: "The managed session could not be stopped.", nextStep: "Stop the local session before trying again." });
    }
  }

  async function enforce(): Promise<void> {
    let entries;
    try { entries = await ports.entries(); }
    catch {
      report(null, unavailable());
      for (const sessionId of managed) await stopSession(sessionId);
      return;
    }
    reported.delete(null);
    const seen = new Set<SessionId>();
    for (const entry of entries) {
      managed.add(entry.sessionId);
      seen.add(entry.sessionId);
      const { home, placement, sessionId, placementRefusal } = entry;
      if (home?.state === "stopped") {
        try {
          const { evidence } = await ports.stopStopped(home);
          if (evidence.kind === "pending") report(sessionId, { code: "stop-timeout", message: evidence.reason,
            nextStep: "Check the Stop status on the Mac before starting this session." });
          else reported.delete(sessionId);
        } catch { report(sessionId, unavailable()); }
        continue;
      }
      if (!home || home.machineId !== ports.machineId || home.state !== "running") {
        await stopSession(sessionId);
        continue;
      }
      if (placementRefusal) { report(sessionId,placementRefusal); continue; }
      try {
        if (!placement) { report(sessionId, { code: "destination-copy-missing", message: "The local session copy is missing.", nextStep: "Restore a local copy before starting this session." }); continue; }
        const owner = await ports.owner(sessionId);
        if (owner.kind === "unknown") {
          report(sessionId, { code: "start-pending", message: "The local session owner is unknown.", nextStep: "Check the local session owner before trying again." });
          continue;
        }
        // Refresh membership even for a live owner: a restored source home may
        // have a newer epoch after an uncertain moving-home publication.
        const activated = await ports.activate(home, placement);
        if (!activated.ok) { report(sessionId, activated.refusal); continue; }
        if (owner.kind === "live") { reported.delete(sessionId); continue; }
        const result = await ports.start(home, placement);
        if (!result.ok) report(sessionId, result.refusal);
        else reported.delete(sessionId);
      } catch { report(sessionId, unavailable()); }
    }
    for (const sessionId of managed) if (!seen.has(sessionId)) await stopSession(sessionId);
  }

  function tick(): Promise<void> {
    if (stopping) return inFlight ?? Promise.resolve();
    if (!inFlight) inFlight = enforce().finally(() => { inFlight = null; });
    return inFlight;
  }
  function arm(): void {
    cancel = ports.clock.later(TICK_MS, () => {
      if (stopping) return;
      arm();
      void tick();
    });
  }
  return {
    tick,
    start() {
      if (started || stopping) return;
      started = true;
      arm();
      void tick();
    },
    async stop() {
      stopping = true;
      cancel?.();
      cancel = null;
      await inFlight;
    },
  };
}

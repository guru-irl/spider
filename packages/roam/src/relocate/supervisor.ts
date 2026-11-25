import type { HomeSupervisor, HomeSupervisorPorts, SessionId, V0Refusal } from "./types";

const TICK_MS = 10_000;

export function createHomeSupervisor(ports: HomeSupervisorPorts): HomeSupervisor {
  const managed = new Set<SessionId>();
  let inFlight: Promise<void> | null = null;
  let cancel: (() => void) | null = null;
  let started = false;
  let stopping = false;
  const unavailable = (): V0Refusal => ({
    code: "home-unavailable", message: "The local session home could not be read.",
    nextStep: "Restore the local home database before starting this session.",
  });

  async function stopSession(sessionId: SessionId): Promise<void> {
    try {
      const result = await ports.stop(sessionId);
      if (!result.ok) ports.report(sessionId, result.refusal);
    } catch {
      ports.report(sessionId, { code: "stop-timeout", message: "The managed session could not be stopped.", nextStep: "Stop the local session before trying again." });
    }
  }

  async function enforce(): Promise<void> {
    let entries;
    try { entries = await ports.entries(); }
    catch {
      ports.report(null, unavailable());
      for (const sessionId of managed) await stopSession(sessionId);
      return;
    }
    const seen = new Set<SessionId>();
    for (const entry of entries) {
      managed.add(entry.sessionId);
      seen.add(entry.sessionId);
      const { home, placement, sessionId } = entry;
      if (!home || home.machineId !== ports.machineId || home.state !== "running") {
        await stopSession(sessionId);
        continue;
      }
      try {
        if (!placement) { ports.report(sessionId, { code: "destination-copy-missing", message: "The local session copy is missing.", nextStep: "Restore a local copy before starting this session." }); continue; }
        const owner = await ports.owner(sessionId);
        if (owner.kind === "unknown") {
          ports.report(sessionId, { code: "start-pending", message: "The local session owner is unknown.", nextStep: "Check the local session owner before trying again." });
          continue;
        }
        // Refresh membership even for a live owner: a restored source home may
        // have a newer epoch after an uncertain moving-home publication.
        const activated = await ports.activate(home, placement);
        if (!activated.ok) { ports.report(sessionId, activated.refusal); continue; }
        if (owner.kind === "live") continue;
        const result = await ports.start(home, placement);
        if (!result.ok) ports.report(sessionId, result.refusal);
      } catch { ports.report(sessionId, unavailable()); }
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

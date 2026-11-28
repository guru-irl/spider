import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { invokeCli } from "@spider/herdr/client/hc";
import { object, parseCore } from "@spider/herdr/client/parse";
import { withProcessLock } from "@spider/herdr/sessions/registry";
import { writeRelayObservation } from "@spider/intercom/broker/relay-observations";
import { RELAY_POLL_CALL_MS, type RelayPeer } from "@spider/intercom/relay-protocol";
import { DEFAULT_LIMITS, type Clock } from "../contracts";
import { readLocalIdentity } from "../runtime";
import { createTransport } from "../transport";
import { createV0RelayForwarder } from "./intercom";
import { isV0Alias, readV0Routes } from "./intercom-routes";
import { localHerdrConnection } from "./local";
import { observeV0HerdrRoutes, runRelayPollLoop } from "./relay-poll";

const clock: Clock = { now: Date.now, later(ms, fn) { const timer = setTimeout(fn, ms); return () => clearTimeout(timer); } };
const REACH_REFRESH_MS = 5000;

export async function startV0Relay(root: string): Promise<{ stop(): Promise<void> }> {
  const config = readLocalIdentity(root), routes = readV0Routes(root, config);
  if (routes.version !== 2 || !routes.relays.includes(config.machineId)) throw new Error("This machine is not a configured relay");
  const connection = localHerdrConnection(root);
  const controller = new AbortController(), { signal } = controller;
  let ready!: (service: { stop(): Promise<void> }) => void, rejectReady!: (error: unknown) => void;
  const started = new Promise<{ stop(): Promise<void> }>((resolve, reject) => { ready = resolve; rejectReady = reject; });
  const lifetime = withProcessLock(join(root, "roam"), "roam-relay-v0", async () => {
    let alias = config.intercom.machineAlias;
    if (!isV0Alias(alias)) {
      const status = await invokeCli(connection.binary, ["server", "status", "--json"], connection.env, DEFAULT_LIMITS.replyBytes,
        undefined, { timeoutMs: DEFAULT_LIMITS.controlMs, signal });
      parseCore(status, connection.env);
      const name = object(object(status).core).name;
      if (!isV0Alias(name)) throw new Error("The selected Herdr core has no usable display name");
      alias = name;
    }
    const relay: RelayPeer = { machineId: config.machineId, alias };
    const transport = createTransport({ ...connection, enrolled: routes.sendTo });
    const forward = createV0RelayForwarder(root, { transport: peers => createTransport({ ...connection, enrolled: peers }) });
    async function readReach(): Promise<readonly RelayPeer[]> {
      try {
        const states = await observeV0HerdrRoutes(connection, routes.sendTo, signal);
        return [relay, ...routes.sendTo.filter(peer => states.get(peer.machineId) === "connected")
          .map(({ machineId, alias }) => ({ machineId, alias }))];
      } catch { return [relay]; }
    }
    let reach = await readReach();
    async function refreshUntilStopped(): Promise<void> {
      while (!signal.aborted) {
        try { await delay(REACH_REFRESH_MS, undefined, { signal }); }
        catch { break; }
        // Refresh independently of held polls. The next call advertises the new snapshot.
        reach = await readReach();
      }
    }

    const loops = routes.linkTo.map(id => {
      const peer = routes.sendTo.find(candidate => candidate.machineId === id)!;
      return runRelayPollLoop({ relay, peer, transport, clock, signal, reach: () => reach, forward,
        observe(view) {
          const now = clock.now();
          writeRelayObservation(root, "out", peer, view, view.state === "down" ? null : now + RELAY_POLL_CALL_MS, now);
        } });
    });
    const running = [...loops, refreshUntilStopped()];
    ready({ stop() { controller.abort(); return lifetime; } });
    try { await Promise.all(running); }
    finally { controller.abort(); await Promise.allSettled(running); }
  }, { timeoutMs: 100, reclaimReusedOwner: true });
  void lifetime.catch(rejectReady);
  return started;
}

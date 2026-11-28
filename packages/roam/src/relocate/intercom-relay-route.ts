import { listV0RelayLinks, submitV0Relay } from "@spider/intercom/broker/roam-relay-client";
import type { RelayLinkView, RelaySubmit } from "@spider/intercom/relay-protocol";
import { V0_INTERCOM_MS, type V0RouteResult } from "@spider/intercom/roam-v0";
import type { V0Routes } from "./intercom-routes";

export async function configuredRelayLinks(routes: V0Routes, signal?: AbortSignal): Promise<readonly RelayLinkView[]> {
  if (routes.version !== 2 || !routes.relays.length) return [];
  return (await listV0RelayLinks(routes.agentDir, signal)).filter(link => routes.relays.includes(link.relay.machineId));
}

export async function routeV0Relay(routes: V0Routes, localMachineId: string, targetLabel: string, submit: RelaySubmit, signal?: AbortSignal): Promise<V0RouteResult> {
  const deadline = performance.now() + V0_INTERCOM_MS;
  const budget = AbortSignal.timeout(V0_INTERCOM_MS);
  const routeSignal = signal ? AbortSignal.any([signal, budget]) : budget;
  const links = await configuredRelayLinks(routes, routeSignal);
  type Skip = NonNullable<V0RouteResult["relaySkips"]>[number];
  const relaySkips: Skip[] = [];
  const details = { targetMachine: targetLabel, relaySkips };
  for (const id of routes.relays) {
    if (id === localMachineId) continue;
    const link = links.find(view => view.relay.machineId === id);
    const alias = routes.sendTo.find(peer => peer.machineId === id)?.alias ??
      routes.acceptFrom.find(peer => peer.machineId === id)?.alias ?? link?.relay.alias ?? id;
    if (link?.state !== "up") {
      relaySkips.push({ relay: alias, reason: "down" });
      continue;
    }
    if (!link.reach.some(peer => peer.machineId === submit.target.machineId)) {
      relaySkips.push({ relay: alias, reason: "cannot reach the target" });
      continue;
    }
    if (routeSignal.aborted || performance.now() >= deadline) return { kind: "refused", code: "unreachable", ...details };
    const { attempted, outcome } = await submitV0Relay(routes.agentDir, id, submit, routeSignal);
    const routed = { ...details, path: `relay ${alias}` as const };
    // A reply lost after hand-off is unknown. Neither it nor a target refusal can be retried.
    if (attempted !== false) return { ...outcome, ...routed };
    let reason: Skip["reason"];
    switch (outcome.code) {
      case "relay-busy": reason = "busy"; break;
      case "relay-stopping": reason = "down"; break;
      case "unreachable": reason = "cannot reach the target"; break;
      default: return { ...outcome, ...routed };
    }
    relaySkips.push({ relay: alias, reason });
  }
  const code = relaySkips.some(skip => skip.reason === "busy") ? "relay-busy"
    : relaySkips.some(skip => skip.reason === "cannot reach the target") ? "relay-unreachable" : "no-relay";
  return { kind: "refused", code, ...details };
}

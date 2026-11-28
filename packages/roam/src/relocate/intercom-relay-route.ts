import { listV0RelayLinks, submitV0Relay } from "@spider/intercom/broker/roam-relay-client";
import type { RelayLinkView, RelaySubmit } from "@spider/intercom/relay-protocol";
import type { V0RouteResult } from "@spider/intercom/roam-v0";
import type { V0Routes } from "./intercom-routes";

export async function configuredRelayLinks(routes: V0Routes, signal?: AbortSignal): Promise<readonly RelayLinkView[]> {
  if (routes.version !== 2 || !routes.relays.length) return [];
  return (await listV0RelayLinks(routes.agentDir, signal)).filter(link => routes.relays.includes(link.relay.machineId));
}

export async function routeV0Relay(routes: V0Routes, targetLabel: string, submit: RelaySubmit, signal?: AbortSignal): Promise<V0RouteResult> {
  const links = await configuredRelayLinks(routes, signal);
  const relaySkips: NonNullable<V0RouteResult["relaySkips"]>[number][] = [];
  const details = { targetMachine: targetLabel, relaySkips };
  let anyUp = false;
  for (const id of routes.relays) {
    const link = links.find(view => view.relay.machineId === id);
    const alias = routes.sendTo.find(peer => peer.machineId === id)?.alias ??
      routes.acceptFrom.find(peer => peer.machineId === id)?.alias ?? link?.relay.alias ?? id;
    if (link?.state !== "up") {
      relaySkips.push({ relay: alias, reason: "down" });
      continue;
    }
    anyUp = true;
    if (!link.reach.some(peer => peer.machineId === submit.target.machineId)) {
      relaySkips.push({ relay: alias, reason: "cannot reach the target" });
      continue;
    }
    const { outcome } = await submitV0Relay(routes.agentDir, id, submit, signal);
    if (outcome.kind === "refused" && outcome.code === "relay-busy") {
      relaySkips.push({ relay: alias, reason: "busy" });
      return { ...outcome, ...details };
    }
    // Do not retry a submission here. In particular, unknown is final.
    return { ...(outcome.kind === "refused" && outcome.code === "relay-stopping"
      ? { kind: "refused", code: "unreachable" } as const : outcome), ...details, path: `relay ${alias}` };
  }
  return { kind: "refused", code: anyUp ? "relay-unreachable" : "no-relay", ...details };
}

import { randomUUID } from "node:crypto";
import type { Db } from "@spider/db-core";
import { INTERCOM_RESOLVE_EVENT, isFederationDispatchResult, type AcceptanceEvidence, type DeliveryState, type IntercomResolveRequest, type IntercomRouteResolution, type MessageReceipt } from "@spider/intercom/protocol";
import { MessageStore } from "./message-store";

export const SUBAGENT_RESULT_INTERCOM_EVENT = "subagent:result-intercom";
export const SUBAGENT_RESULT_INTERCOM_DELIVERY_EVENT = "subagent:result-intercom-delivery";
export function mirrorMessage(globalDb: Db, m: { fromSession?: string; toSession?: string; kind?: string; body?: string }): void {
  new MessageStore(globalDb).enqueue({ ...m, toSession: m.toSession ?? "", body: m.body ?? "" });
}
export interface IntercomResult {
  delivered: boolean;
  queued: boolean;
  messageId: string;
  mirrorId?: number;
  /** Local legacy callers retain their result vocabulary. Remote results retain wire truth. */
  delivery: DeliveryState | "broker-accepted";
  deliveryState: DeliveryState;
  acceptance: AcceptanceEvidence;
  outcomeKnown: boolean;
  consumption?: MessageReceipt;
  recipientAcknowledged: false;
  timedOut?: boolean;
  brokerRefused?: boolean;
  error?: string;
}
const pendingCalls = new Set<{ sessionId?: string; cancel: () => void }>();
export function cancelPendingIntercom(sessionId?: string): void {
  for (const call of [...pendingCalls]) if (!sessionId || call.sessionId === sessionId) call.cancel();
}
export function sendIntercom(pi: any, globalDb: Db,
  m: { to: string; message: string; fromSession?: string; kind?: string; timeoutMs?: number; ephemeral?: boolean; messageId?: string }
): Promise<IntercomResult> {
  const requestId = m.messageId ?? randomUUID(), store = new MessageStore(globalDb);
  let mirrorId: number | undefined, route: IntercomRouteResolution | undefined;
  const unconfirmed = (error: string): IntercomResult => {
    if (m.ephemeral && mirrorId !== undefined) {
      try { globalDb.prepare("DELETE FROM message_mirror WHERE id=? AND delivered_at IS NULL").run(mirrorId); }
      catch { error += " The undelivered mailbox row could not be removed."; }
    }
    const queued = mirrorId !== undefined && !m.ephemeral;
    return { delivered: false, queued, messageId: requestId, ...(mirrorId !== undefined ? { mirrorId } : {}), delivery: queued ? "queued" : "unknown", deliveryState: "unknown",
      acceptance: queued ? { accepted: true, durable: true, location: "local-mailbox" } : { accepted: false, durable: false }, outcomeKnown: false, recipientAcknowledged: false, error };
  };
  return new Promise(resolve => {
    let settled = false, off: (() => unknown) | undefined, timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: IntercomResult) => {
      if (settled) return;
      settled = true; if (timer) clearTimeout(timer); pendingCalls.delete(call);
      try { off?.(); } catch { /* Cleanup cannot alter delivery truth. */ }
      resolve(result);
    };
    const call = { sessionId: m.fromSession, cancel: () => finish(unconfirmed("Session shutdown cancelled the pending intercom call; delivery is unconfirmed.")) };
    pendingCalls.add(call);
    const dispatch = (resolved: IntercomRouteResolution) => {
      if (settled || route) return;
      route = resolved;
      if (!("to" in resolved)) {
        finish({ ...unconfirmed(resolved.reason ?? `${resolved.kind}-target`), delivery: resolved.kind === "ambiguous" ? "failed" : "unknown", deliveryState: resolved.kind === "ambiguous" ? "failed" : "unknown", outcomeKnown: resolved.kind === "ambiguous" }); return;
      }
      try {
        const home = globalDb.prepare("SELECT machine_id FROM session_homes WHERE session_id=?").get(resolved.address.sessionId) as { machine_id: string } | undefined;
        const bridge = resolved.kind === "bridge" || !!home;
        if (!bridge) mirrorId = store.enqueue({ fromSession: m.fromSession, toSession: resolved.to, kind: m.kind ?? "message", body: m.message, route: { kind: "local", messageId: requestId } });
        else route = { ...resolved, kind: "bridge" };
        if (typeof pi?.events?.on !== "function" || typeof pi.events.emit !== "function") { finish(unconfirmed("No intercom broker available; delivery unconfirmed.")); return; }
        pi.events.emit(SUBAGENT_RESULT_INTERCOM_EVENT, { to: resolved.to, message: m.message, requestId, messageId: requestId });
      } catch (error) { finish(unconfirmed(`Broker unavailable; delivery unconfirmed: ${String((error as Error)?.message ?? error)}`)); }
    };
    try {
      if (typeof pi?.events?.on === "function" && typeof pi.events.emit === "function") {
        off = pi.events.on(SUBAGENT_RESULT_INTERCOM_DELIVERY_EVENT, (p: any) => {
          if (p?.requestId !== requestId || settled) return;
          if (route?.kind === "bridge") {
            if (p.messageId !== requestId || !isFederationDispatchResult(p)) { finish(unconfirmed("Broker response supplied no valid remote acceptance evidence.")); return; }
            finish({ delivered: p.delivery === "queued" || p.delivery === "socket_delivered", queued: p.acceptance.accepted && p.acceptance.durable, messageId: requestId, delivery: p.delivery, deliveryState: p.delivery,
              acceptance: p.acceptance, outcomeKnown: p.outcomeKnown, ...(p.consumption ? { consumption: p.consumption } : {}), recipientAcknowledged: false, ...(p.reason ? { error: p.reason } : {}), ...(p.delivery === "failed" ? { brokerRefused: true } : {}) }); return;
          }
          if (p.delivered !== true) { finish({ ...unconfirmed(typeof p.error === "string" ? p.error : "Broker did not confirm delivery; message remains queued."), brokerRefused: true }); return; }
          let error: string | undefined;
          try { if (mirrorId !== undefined) store.markDelivered(mirrorId); }
          catch { error = "Broker accepted the message, but its durable delivery marker could not be updated."; }
          finish({ delivered: true, queued: true, messageId: requestId, mirrorId, delivery: "broker-accepted", deliveryState: "socket_delivered", acceptance: { accepted: true, durable: true, location: "local-mailbox" }, outcomeKnown: true, ...(p.consumption ? { consumption: p.consumption } : {}), recipientAcknowledged: false, ...(error ? { error } : {}) });
        });
        timer = setTimeout(() => finish({ ...unconfirmed("No broker response; delivery unconfirmed."), timedOut: true }), m.timeoutMs ?? 10_000); timer.unref();
        const request: IntercomResolveRequest = { to: m.to, handled: false, respond: dispatch };
        pi.events.emit(INTERCOM_RESOLVE_EVENT, request);
        if (!request.handled) dispatch({ kind: "local", to: m.to, address: { sessionId: m.to, scopeId: null } });
      } else dispatch({ kind: "local", to: m.to, address: { sessionId: m.to, scopeId: null } });
    } catch (error) { finish(unconfirmed(`Broker unavailable; delivery unconfirmed: ${String((error as Error)?.message ?? error)}`)); }
  });
}

/** Only proved local offline mail is replayed, regardless of the recipient's current address or home. */
export async function pollPendingMessages(globalDb: Db, sessionId: string, pi: any): Promise<void> {
  const store = new MessageStore(globalDb);
  for (const msg of store.pending(sessionId)) {
    if (msg.route?.kind !== "local" || typeof pi.sendMessage !== "function") continue;
    try {
      pi.sendMessage({ customType: "spider.message_delivered", content: `Message from ${msg.fromSession ?? "unknown"} · ${msg.kind ?? "message"}\n\n${msg.body}`, display: true,
        details: { id: msg.id, messageId: msg.route.messageId, from: msg.fromSession, to: msg.toSession, kind: msg.kind, body: msg.body, createdAt: msg.createdAt } }, { triggerTurn: true });
      store.markDelivered(msg.id);
    } catch { /* Keep proved local mail pending when dispatch fails. */ }
  }
}

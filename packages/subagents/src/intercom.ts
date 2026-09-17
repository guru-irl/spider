import { randomUUID } from "node:crypto";
import type { Db } from "@spider/db-core";
import { MessageStore } from "./message-store";

export const SUBAGENT_RESULT_INTERCOM_EVENT = "subagent:result-intercom";
export const SUBAGENT_RESULT_INTERCOM_DELIVERY_EVENT = "subagent:result-intercom-delivery";

export function mirrorMessage(globalDb: Db, m: { fromSession?: string; toSession?: string; kind?: string; body?: string }): void {
  globalDb.prepare(`INSERT INTO message_mirror (from_session, to_session, kind, body, created_at) VALUES (@f,@t,@k,@b,@c)`)
    .run({ f: m.fromSession ?? null, t: m.toSession ?? null, k: m.kind ?? null, b: m.body ?? null, c: Date.now() });
}

export interface IntercomResult {
  /** Legacy transport flag: true only when the broker explicitly reports delivery. */
  delivered: boolean;
  /** The message was durably stored; this does not assert that it was consumed. */
  queued: boolean;
  messageId: number;
  delivery: "broker-accepted" | "queued";
  /** No recipient/agent acknowledgement protocol is implied by a broker response. */
  recipientAcknowledged: false;
  error?: string;
}

export async function sendIntercom(
  pi: any,
  globalDb: Db,
  m: { to: string; message: string; fromSession?: string; kind?: string; timeoutMs?: number }
): Promise<IntercomResult> {
  const requestId = randomUUID();
  const store = new MessageStore(globalDb);

  // QUEUE FIRST — always enqueue before attempting broker delivery
  // Durability does not depend on the broker
  const messageId = store.enqueue({
    fromSession: m.fromSession,
    toSession: m.to,
    kind: m.kind ?? "message",
    body: m.message,
  });

  const queued = (error: string): IntercomResult => ({
    delivered: false, queued: true, messageId, delivery: "queued", recipientAcknowledged: false, error,
  });
  if (typeof pi?.events?.on !== "function" || typeof pi.events.emit !== "function") {
    return queued("No intercom broker available; message stored, delivery unconfirmed.");
  }

  return new Promise((resolve) => {
    let settled = false;
    let off: (() => unknown) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: IntercomResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (typeof off === "function") off();
      resolve(result);
    };
    try {
      off = pi.events.on(SUBAGENT_RESULT_INTERCOM_DELIVERY_EVENT, (p: any) => {
        if (p?.requestId !== requestId || settled) return;
        // The REAL broker also replies with delivered:false and an error. A matching
        // request ID alone is not a successful acknowledgement.
        if (p.delivered !== true) {
          finish(queued(typeof p.error === "string" ? p.error : "Broker did not confirm delivery; message remains queued."));
          return;
        }
        let error: string | undefined;
        try { store.markDelivered(messageId); }
        catch { error = "Broker accepted the message, but its durable delivery marker could not be updated."; }
        finish({ delivered: true, queued: true, messageId, delivery: "broker-accepted", recipientAcknowledged: false, ...(error ? { error } : {}) });
      });
      timer = setTimeout(() => finish(queued("Recipient offline or no broker response; queued, not delivered.")), m.timeoutMs ?? 10_000);
      timer.unref();
      pi.events.emit(SUBAGENT_RESULT_INTERCOM_EVENT, { to: m.to, message: m.message, requestId });
    } catch (error) {
      finish(queued(`Broker unavailable; message remains queued: ${String((error as Error)?.message ?? error)}`));
    }
  });
}

/**
 * Poll and deliver pending messages for a session.
 * Called on session_start to drain messages queued while the session was offline.
 */
export async function pollPendingMessages(
  globalDb: Db,
  sessionId: string,
  pi: any
): Promise<void> {
  const store = new MessageStore(globalDb);
  const pending = store.pending(sessionId);

  for (const msg of pending) {
    // IMPORTANT 4: Skip if sendMessage is not available (leave pending for retry)
    if (typeof pi.sendMessage !== "function") continue;
    
    try {
      // Deliver the message to the orchestrator (user-visible path)
      // Use the same mechanism as the escalation notifier: sendMessage with a themed card
      pi.sendMessage(
        {
          customType: "spider.message_delivered",
          content: `📨 *message* from ${msg.fromSession ?? "unknown"} · ${msg.kind ?? "message"}\n\n${msg.body}`,
          display: true,
          details: {
            id: msg.id,
            from: msg.fromSession,
            to: msg.toSession,
            kind: msg.kind,
            body: msg.body,
            createdAt: msg.createdAt,
          },
        },
        { triggerTurn: true },
      );

      // Only mark as delivered AFTER successful delivery
      store.markDelivered(msg.id);
    } catch {
      // Best-effort: if delivery fails, the message remains pending and will be
      // retried on the next session_start (delivered_at stays NULL)
    }
  }
}

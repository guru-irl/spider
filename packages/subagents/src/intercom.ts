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
  delivered: boolean;
  queued: boolean;
  messageId: number;
  error?: string;
}

export function sendIntercom(
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

  // Then attempt broker delivery (fast path for live sessions)
  return new Promise((resolve) => {
    let settled = false;
    const off = pi.events.on(SUBAGENT_RESULT_INTERCOM_DELIVERY_EVENT, (p: any) => {
      if (p?.requestId !== requestId || settled) return;
      settled = true;
      off?.();

      // On broker ack, mark the message as delivered
      store.markDelivered(messageId);

      resolve({
        delivered: true,
        queued: true,
        messageId,
      });
    });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      off?.();

      // On timeout/no broker: the message is queued but not yet delivered
      // This is NOT an error — the recipient's poller will drain it
      resolve({
        delivered: false,
        queued: true,
        messageId,
        error: "recipient offline or no broker (message queued for delivery)",
      });
    }, m.timeoutMs ?? 10_000);

    if (typeof (timer as any).unref === "function") (timer as any).unref();

    pi.events.emit(SUBAGENT_RESULT_INTERCOM_EVENT, {
      to: m.to,
      message: m.message,
      requestId,
    });
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

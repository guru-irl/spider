import { randomUUID } from "node:crypto";
import type { Db } from "@spider/db-core";

export const SUBAGENT_RESULT_INTERCOM_EVENT = "subagent:result-intercom";
export const SUBAGENT_RESULT_INTERCOM_DELIVERY_EVENT = "subagent:result-intercom-delivery";

export function mirrorMessage(globalDb: Db, m: { fromSession?: string; toSession?: string; kind?: string; body?: string }): void {
  globalDb.prepare(`INSERT INTO message_mirror (from_session, to_session, kind, body, created_at) VALUES (@f,@t,@k,@b,@c)`)
    .run({ f: m.fromSession ?? null, t: m.toSession ?? null, k: m.kind ?? null, b: m.body ?? null, c: Date.now() });
}

export function sendIntercom(pi: any, globalDb: Db, m: { to: string; message: string; fromSession?: string; kind?: string; timeoutMs?: number }): Promise<{ delivered: boolean; error?: string }> {
  const requestId = randomUUID();
  return new Promise((resolve) => {
    let settled = false;
    const off = pi.events.on(SUBAGENT_RESULT_INTERCOM_DELIVERY_EVENT, (p: any) => {
      if (p?.requestId !== requestId || settled) return;
      settled = true; off?.();
      mirrorMessage(globalDb, { fromSession: m.fromSession, toSession: m.to, kind: m.kind ?? "message", body: m.message });
      resolve({ delivered: !!p.delivered, error: p.error });
    });
    const timer = setTimeout(() => {
      if (settled) return; settled = true; off?.();
      mirrorMessage(globalDb, { fromSession: m.fromSession, toSession: m.to, kind: m.kind ?? "message", body: m.message });
      resolve({ delivered: false, error: "intercom delivery timeout" });
    }, m.timeoutMs ?? 10_000);
    if (typeof (timer as any).unref === "function") (timer as any).unref();
    pi.events.emit(SUBAGENT_RESULT_INTERCOM_EVENT, { to: m.to, message: m.message, requestId });
  });
}

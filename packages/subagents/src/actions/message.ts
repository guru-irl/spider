import type { Db } from "@spider/db-core";
import { sendIntercom } from "../intercom";

interface TargetRun { id: string; name: string | null; status: string; }
function childTarget(db: Db | undefined, target: string, sessionId: string): TargetRun[] {
  if (!db) return [];
  const prefix = /^[a-f0-9][a-f0-9-]{3,35}$/i.test(target) ? `${target}%` : null;
  const rows = db.prepare(
    "SELECT id,name,status FROM runs WHERE id=? OR (? IS NOT NULL AND id LIKE ?) " +
    "OR (session_id=? AND lower(name)=lower(?))",
  ).all(target, prefix, prefix, sessionId, target) as TargetRun[];
  const exact = rows.find(r => r.id === target);
  return exact ? [exact] : rows;
}

/** Queue-first transport for peer sessions. One-shot spider runs are not intercom peers. */
export function makeMessageHandler(): (args: any, ctx: any) => Promise<{ content: string; isError: boolean; details: any }> {
  return async function messageHandler(args: any, ctx: any) {
    try {
      const to = typeof args.to === "string" ? args.to.trim() : "";
      if (!to || typeof args.message !== "string" || !args.message.trim()) throw new Error("message requires a non-empty peer session target and message");
      const matches = childTarget(ctx.db, to, ctx.sessionId ?? "");
      if (matches.length > 0) {
        const run = matches[0];
        const terminal = ["done", "failed", "cancelled"].includes(run.status);
        const error = matches.length > 1
          ? `Target '${to}' matches multiple subagent runs. Use the session ID of a live intercom peer; a child run is not a peer session.`
          : terminal
            ? `Subagent ${run.id} is ${run.status}. Messaging cannot resume it. Confirm its process has exited, then start a fresh run with the corrected brief.`
            : `Subagent ${run.id} is a one-shot headless child, not a live intercom session. Messages cannot steer it. Cancel and confirm termination before starting a new run with the corrected brief.`;
        return {
          content: error, isError: true,
          details: { error, delivered: false, queued: false, delivery: "unavailable", recipientAcknowledged: false, runId: run.id },
        };
      }
      const res = await sendIntercom(ctx.pi, ctx.globalDb, {
        to, message: args.message, fromSession: ctx.sessionId,
        kind: args.kind, timeoutMs: args.timeoutMs,
      });
      if (res.delivered) {
        return {
          content: `Broker accepted the message for ${to}; recipient acknowledgement is unconfirmed.${res.error ? ` ${res.error}` : ""}`,
          isError: false, details: res,
        };
      }
      return {
        content: `message queued for ${to}, not delivered. ${res.error ?? "No delivery confirmation."} Use a peer session ID for deferred delivery.`,
        isError: false, details: res,
      };
    } catch (err: unknown) {
      const error = String((err as Error)?.message ?? err);
      return {
        content: `message failed: ${error}`, isError: true,
        details: { error, delivered: false, queued: false, delivery: "unavailable", recipientAcknowledged: false },
      };
    }
  };
}

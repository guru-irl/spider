import { appendRunEvent, openDbAt, type Db } from "@spider/db-core";
import { existsSync } from "node:fs";
import { sendIntercom } from "../intercom";
import { getChild } from "../coordinators";

interface TargetRun { id: string; name: string | null; status: string; session_id: string; child_mode: string; intercom_session: string | null; }
function childTarget(db: Db | undefined, target: string, sessionId: string): TargetRun[] {
  if (!db) return [];
  const prefix = /^[a-f0-9][a-f0-9-]{3,35}$/i.test(target) ? `${target}%` : null;
  const rows = db.prepare(
    "SELECT id,name,status,session_id,child_mode,intercom_session FROM runs WHERE id=? OR (? IS NOT NULL AND id LIKE ?) " +
    "OR (session_id=? AND lower(name)=lower(?))",
  ).all(target, prefix, prefix, sessionId, target) as TargetRun[];
  const exact = rows.find(r => r.id === target);
  return exact ? [exact] : rows;
}

/** Peer transport is queue-first. Live RPC children use their owner's stdin directly. */
export function makeMessageHandler(): (args: any, ctx: any) => Promise<{ content: string; isError: boolean; details: any }> {
  return async function messageHandler(args: any, ctx: any) {
    const refuse = (error: string, runId?: string, childAccepted = false) => ({ content: `Message refused: ${error}`, isError: true,
      details: { error, accepted: false, delivered: false, queued: false, delivery: "refused", recipientAcknowledged: false, ...(runId ? { runId } : {}), ...(childAccepted ? { childAccepted: true } : {}) } });
    let remoteDb: Db | undefined;
    try {
      const to = typeof args.to === "string" ? args.to.trim() : "";
      if (!to || typeof args.message !== "string" || !args.message.trim()) throw new Error("message requires a non-empty session or run target and message");
      let eventDb: Db = ctx.db;
      let matches = childTarget(ctx.db, to, ctx.sessionId ?? "");
      if (matches.length === 0 && ctx.globalDb) {
        const prefix = /^[a-f0-9][a-f0-9-]{3,35}$/i.test(to) ? `${to}%` : null;
        const routes = ctx.globalDb.prepare("SELECT run_id, db_path FROM run_routes WHERE run_id=? OR (? IS NOT NULL AND run_id LIKE ?)")
          .all(to, prefix, prefix) as Array<{ run_id: string; db_path: string }>;
        const exact = routes.find(r => r.run_id === to);
        const selected = exact ? [exact] : routes;
        if (selected.length > 1) return refuse(`Target '${to}' matches multiple subagent runs. Use a full run ID.`);
        if (selected.length === 1) {
          const route = selected[0];
          if (!existsSync(route.db_path)) return refuse(`Subagent ${route.run_id}'s owning database is unavailable; steering was not attempted.`, route.run_id);
          remoteDb = openDbAt(route.db_path, "worktree"); eventDb = remoteDb;
          matches = childTarget(remoteDb, route.run_id, ctx.sessionId ?? "");
          if (matches.length === 0) return refuse(`Subagent ${route.run_id}'s launch record is unavailable; steering was not attempted.`, route.run_id);
        }
      }
      let warning: string | undefined;
      const recordSteer = (run: TargetRun, payload: any) => {
        try { appendRunEvent(eventDb, { runId: run.id, sessionId: run.session_id, ts: Date.now(), type: "steer", summary: `Steer ${payload.delivery}: ${args.message}`, payload }); }
        catch { warning = "The steer transport result is unchanged, but its run event could not be recorded."; }
      };
      let destination = to;
      let run: TargetRun | undefined;
      if (matches.length > 0) {
        run = matches[0];
        if (matches.length > 1) return refuse(`Target '${to}' matches multiple subagent runs. Use a full run ID.`, run.id);
        if (["done", "failed", "cancelled"].includes(run.status)) return refuse(`Subagent ${run.id} is ${run.status}. Messaging cannot resume it. Start a fresh run with the corrected brief.`, run.id);
        if (run.status !== "running") return refuse(`Subagent ${run.id} is ${run.status}, not running. It cannot accept a steer.`, run.id);
        if (run.child_mode !== "rpc") return refuse(`Subagent ${run.id} is a one-shot headless print-mode child. Messages cannot steer it. Cancel and confirm termination before starting a new run.`, run.id);
        if (args.message.trimStart().startsWith("/")) {
          const error = "Steer text starting with '/' can be expanded by the child as a skill or prompt template, or rejected as an extension command; RPC steer has no literal-text option. Rephrase so it does not start with '/'.";
          recordSteer(run, { accepted: false, delivered: false, delivery: "refused", error });
          return refuse(error, run.id);
        }
        if (run.session_id === ctx.sessionId) {
          const child = getChild(ctx.sessionId, run.id);
          if (!child?.steer) return refuse(`Subagent ${run.id} has no live RPC pipe in its owning session. It may have completed or been stopped; start a fresh run.`, run.id);
          const ack = await child.steer(args.message);
          const delivery = ack.delivered ? "delivered" : ack.delivery === "no reply yet, delivery unknown" ? ack.delivery : ack.accepted || ack.childAccepted ? "accepted but not confirmed" : "refused";
          recordSteer(run, { transport: "rpc", ...ack, delivery });
          if (delivery === "refused") {
            return refuse(ack.error?.startsWith("Not sent:")
              ? `Steer to Subagent ${run.id} was not sent: ${ack.error.slice("Not sent:".length).trim()}`
              : `Subagent ${run.id} did not confirm steering acceptance: ${ack.error ?? "unconfirmed"}`, run.id);
          }
          const queuedGuidance = delivery === "accepted but not confirmed" && ack.queued && !ack.error
            ? " It is queued in the child. pi delivers it at the child's next turn boundary unless the run ends first. The final state appears in the run's events and completion summary; do not resend."
            : "";
          return { content: `Message to child ${run.id}: ${delivery}.${queuedGuidance}${delivery === "no reply yet, delivery unknown" ? ack.error ? " The steer was not delivered and the run has ended. Start a fresh run if the instruction still matters." : " The steer was written and may still be delivered; do not resend." : ""}${ack.transformed ? " Child input transformed the text." : ""}${ack.error ? ` ${ack.error}` : ""}`, isError: false,
            details: { ...ack, runId: run.id, accepted: delivery !== "no reply yet, delivery unknown", delivered: ack.delivered === true, queued: ack.queued === true && !ack.error, delivery, recipientAcknowledged: false, ...(warning ? { warning } : {}) } };
        }
        if (!run.intercom_session) return refuse(`This run is owned by session ${run.session_id}; steer it from there, or install pi-intercom before launching a new run.`, run.id);
        destination = run.intercom_session;
      }
      const res = await sendIntercom(ctx.pi, ctx.globalDb, {
        to: destination, message: args.message, fromSession: ctx.sessionId,
        kind: args.kind, timeoutMs: args.timeoutMs, ephemeral: !!run,
      });
      if (run) recordSteer(run, { transport: "intercom", ...res, accepted: res.delivered, delivered: false, delivery: res.delivered ? "accepted but not confirmed" : res.timedOut ? "no reply yet, delivery unknown" : "refused" });
      if (run && res.timedOut) return { content: `Message to child ${run.id}: no reply yet, delivery unknown. The steer may still be delivered; do not resend. ${res.error ?? ""}`, isError: false,
        details: { ...res, accepted: false, delivered: false, delivery: "no reply yet, delivery unknown", runId: run.id, ...(warning ? { warning } : {}) } };
      if (run && res.delivered) return { content: `Message to child ${run.id}: accepted but not confirmed. Broker acceptance is not evidence of conversation entry.`, isError: false,
        details: { ...res, accepted: true, delivered: false, delivery: "broker-accepted", runId: run.id, ...(warning ? { warning } : {}) } };
      if (res.delivered) {
        return { content: `Broker accepted the message for ${destination}; recipient acknowledgement is unconfirmed.${res.error ? ` ${res.error}` : ""}`, isError: false, details: { ...res, ...(run ? { runId: run.id } : {}), ...(warning ? { warning } : {}) } };
      }
      if (run) return refuse(`${res.brokerRefused ? "The broker did not accept" : "The broker has not confirmed acceptance of"} the steer for child ${run.id}. ${res.error ?? "No broker delivery confirmation."} Steer from its owning session or start a fresh run.`, run.id);
      return { content: `message queued for ${destination}; ${res.brokerRefused ? "delivery was not accepted by the broker" : "delivery is unconfirmed"}. ${res.error ?? "No broker delivery confirmation."}`, isError: false, details: res };
    } catch (err: unknown) {
      const error = String((err as Error)?.message ?? err);
      return refuse(`message failed: ${error}`);
    } finally {
      remoteDb?.close();
    }
  };
}

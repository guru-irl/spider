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
    const refuse = (error: string, runId?: string, childAccepted = false) => ({ content: error, isError: true,
      details: { error, delivered: false, queued: false, delivery: "unavailable", recipientAcknowledged: false, ...(runId ? { runId } : {}), ...(childAccepted ? { childAccepted: true } : {}) } });
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
        try { appendRunEvent(eventDb, { runId: run.id, sessionId: run.session_id, ts: Date.now(), type: "steer", summary: args.message, payload }); }
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
        if (run.session_id === ctx.sessionId) {
          const child = getChild(ctx.sessionId, run.id);
          if (!child?.steer) return refuse(`Subagent ${run.id} has no live RPC pipe in its owning session. It may have completed or been stopped; start a fresh run.`, run.id);
          const ack = await child.steer(args.message);
          recordSteer(run, { transport: "rpc", ...ack });
          if (!ack.accepted) {
            const content = ack.childAccepted
              ? `Subagent ${run.id} acknowledged queue insertion, but no live steering window remains. ${ack.error}`
              : `Subagent ${run.id} did not confirm steering acceptance: ${ack.error ?? "unconfirmed"}`;
            return refuse(content, run.id, ack.childAccepted === true);
          }
          return { content: `Message accepted by child ${run.id} (accepted, delivered at the next turn boundary); model consumption is unconfirmed.`, isError: false,
            details: { runId: run.id, accepted: true, delivered: false, queued: true, delivery: "child-accepted", recipientAcknowledged: false, ...(warning ? { warning } : {}) } };
        }
        if (!run.intercom_session) return refuse(`This run is owned by session ${run.session_id}; steer it from there, or install pi-intercom before launching a new run.`, run.id);
        destination = run.intercom_session;
      }
      const res = await sendIntercom(ctx.pi, ctx.globalDb, {
        to: destination, message: args.message, fromSession: ctx.sessionId,
        kind: args.kind, timeoutMs: args.timeoutMs, ephemeral: !!run,
      });
      if (run) recordSteer(run, { transport: "intercom", ...res });
      if (res.delivered) {
        return { content: `Broker accepted the message for ${destination}; recipient acknowledgement is unconfirmed.${res.error ? ` ${res.error}` : ""}`, isError: false, details: { ...res, ...(run ? { runId: run.id } : {}), ...(warning ? { warning } : {}) } };
      }
      if (run) return refuse(`Steer to child ${run.id} is unconfirmed. ${res.error ?? "No broker delivery confirmation."} Steer from its owning session or start a fresh run.`, run.id);
      return { content: `message queued for ${destination}; delivery is unconfirmed. ${res.error ?? "No broker delivery confirmation."}`, isError: false, details: res };
    } catch (err: unknown) {
      const error = String((err as Error)?.message ?? err);
      return refuse(`message failed: ${error}`);
    } finally {
      remoteDb?.close();
    }
  };
}

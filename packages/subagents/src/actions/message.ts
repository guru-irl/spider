import { sendIntercom } from "../intercom";

/** The `message` action handler — thin intercom wrapper + message_mirror. */
export function makeMessageHandler(): (args: any, ctx: any) => Promise<{ content: string; isError: boolean; details: any }> {
  return async function messageHandler(args: any, ctx: any) {
    const res = await sendIntercom(ctx.pi, ctx.globalDb, { to: args.to, message: args.message, fromSession: ctx.sessionId, kind: args.kind, timeoutMs: args.timeoutMs });
    return { content: res.delivered ? `message delivered to ${args.to}` : `message NOT delivered: ${res.error}`, isError: !res.delivered, details: res };
  };
}

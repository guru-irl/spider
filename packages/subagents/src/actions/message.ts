import { sendIntercom } from "../intercom";

/** The `message` action handler — queue-first intercom wrapper. */
export function makeMessageHandler(): (args: any, ctx: any) => Promise<{ content: string; isError: boolean; details: any }> {
  return async function messageHandler(args: any, ctx: any) {
    try {
      const res = await sendIntercom(ctx.pi, ctx.globalDb, {
        to: args.to,
        message: args.message,
        fromSession: ctx.sessionId,
        kind: args.kind,
        timeoutMs: args.timeoutMs,
      });

      // Three outcomes: delivered, queued, failed
      // - delivered: broker acked, message is live
      // - queued: no broker or timeout, but message is durably queued (NOT an error)
      // - failed: enqueue itself threw (genuine failure)

      if (res.delivered) {
        return {
          content: `message delivered to ${args.to}`,
          isError: false,
          details: res,
        };
      } else if (res.queued) {
        // Queued but not delivered — recipient is offline or no broker present
        // This is NOT an error: the message is durable and will be delivered when the recipient starts
        return {
          content: `message queued for ${args.to} (recipient offline)`,
          isError: false,
          details: res,
        };
      } else {
        // Should not reach here with the current implementation, but handle it
        return {
          content: `message failed: ${res.error ?? "unknown error"}`,
          isError: true,
          details: res,
        };
      }
    } catch (err: any) {
      // Genuine failure (e.g., enqueue threw)
      return {
        content: `message failed: ${err?.message ?? String(err)}`,
        isError: true,
        details: { error: err?.message ?? String(err) },
      };
    }
  };
}

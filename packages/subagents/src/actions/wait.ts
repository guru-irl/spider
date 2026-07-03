import { RunStore } from "../run-store";
import { waitForRuns } from "../wait";

/** The `wait` action handler — event-driven over runs+bus. */
export function makeWaitHandler(): (args: any, ctx: any) => Promise<{ content: string; details: any }> {
  return async function waitHandler(args: any, ctx: any) {
    const store = new RunStore(ctx.db);
    const res = await waitForRuns({ db: ctx.db, store, sessionId: ctx.sessionId }, { id: args.id, all: args.all, timeoutMs: args.timeoutMs });
    return { content: `${res.finished.length} finished, ${res.stillActive.length} active${res.timedOut ? " (timed out)" : ""}`, details: res };
  };
}

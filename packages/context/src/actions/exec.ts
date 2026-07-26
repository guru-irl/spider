import { PolyglotExecutor } from "../executor";
import { capBytes } from "../truncate";

export interface ExecCtx {
  cwd: string;
  /**
   * Called with a cumulative, capped snapshot of output while the command is
   * still running. The host forwards this to pi's `onUpdate`, which makes the
   * result section exist as a partial from the first chunk — so the user sees
   * output arrive instead of a frozen spinner, and ctrl+o works mid-run.
   */
  onPartial?: (text: string) => void;
}

/** Model-facing output budget. Exec output enters the context window VERBATIM — nothing
 *  summarises it — so this is a direct charge against the session's token budget.
 *  ~10 KB is roughly 2.5–3k tokens. Past this, redirecting to a file and analysing it
 *  (grep/head/wc, or an indexed search) is strictly cheaper than pasting the whole dump. */
const MAX_EXEC_OUTPUT_BYTES = 10_000;

const TRUNCATION_NOTE =
  "\n\n… [output truncated at 10KB — the rest never reached the model. " +
  "Re-running the same command will truncate identically. Instead: redirect to a file " +
  "under .spider/scratch/ and analyse it there (grep/head/wc/awk), or narrow the command " +
  "itself. For session/run history, query the DB rather than dumping logs.]";

const mk = (ctx: ExecCtx) => new PolyglotExecutor({ projectRoot: () => ctx.cwd });

/** Throttle interval for partial updates. pi's bash tool throttles for the same reason:
 *  a chatty command emits hundreds of chunks a second and repainting on each one costs
 *  more than the output is worth. */
const PARTIAL_THROTTLE_MS = 100;

/** Build the executor `onData` hook that feeds ctx.onPartial with cumulative, capped,
 *  throttled snapshots. Returns undefined when the caller wants no streaming, so the
 *  non-streaming path stays exactly as it was. */
function makeStreamer(ctx: ExecCtx): ((chunk: string) => void) | undefined {
  if (typeof ctx.onPartial !== "function") return undefined;
  let acc = "";
  let lastAt = 0;
  return (chunk: string) => {
    acc += chunk;
    const now = Date.now();
    if (now - lastAt < PARTIAL_THROTTLE_MS) return;
    lastAt = now;
    // Cap partials too: an unbounded partial would blow the same budget the final
    // result is capped to defend.
    ctx.onPartial!(capExecOutput(acc));
  };
}

/** Cap to the budget. When it truncates, say what to do instead — a bare "..." tells the
 *  agent nothing and it re-runs the same command, paying the same cost twice. */
function capExecOutput(text: string): string {
  if (Buffer.byteLength(text) <= MAX_EXEC_OUTPUT_BYTES) return text;
  const budget = MAX_EXEC_OUTPUT_BYTES - Buffer.byteLength(TRUNCATION_NOTE);
  return capBytes(text, budget) + TRUNCATION_NOTE;
}

const shape = (r: any) =>
  capExecOutput(r.stdout + (r.stderr ? "\n[stderr]\n" + r.stderr : ""));

export async function runExec(args: any, ctx: ExecCtx): Promise<{ text: string; details: any; isError: boolean }> {
  const res = await mk(ctx).execute({
    language: args.language,
    code: args.code,
    timeout: args.timeout,
    background: args.background,
    onData: makeStreamer(ctx),
  });
  return { text: shape(res), details: res, isError: res.exitCode !== 0 && !res.backgrounded };
}

export async function runExecFile(args: any, ctx: ExecCtx): Promise<{ text: string; details: any; isError: boolean }> {
  const res = await mk(ctx).executeFile({
    path: args.path,
    language: args.language,
    code: args.code,
    timeout: args.timeout,
  });
  return { text: shape(res), details: res, isError: res.exitCode !== 0 };
}

export async function runBatch(args: any, ctx: ExecCtx): Promise<{ text: string; details: any[]; isError: boolean }> {
  const ex = mk(ctx);
  const parts: string[] = [];
  let anyErr = false;
  const all: any[] = [];
  for (const [i, cmd] of (args.commands ?? []).entries()) {
    const res = await ex.execute({ language: cmd.language, code: cmd.code, timeout: cmd.timeout });
    if (res.exitCode !== 0) anyErr = true;
    all.push(res);
    parts.push(`── [${i + 1}] ${cmd.language} ──\n${res.stdout}${res.stderr ? "\n[stderr]\n" + res.stderr : ""}`);
  }
  return { text: capExecOutput(parts.join("\n\n")), details: all, isError: anyErr };
}

export function registerExecActions(register: (name: string, handler: (a: any, c: any) => any) => void): void {
  register("exec", runExec);
  register("exec_file", runExecFile);
  register("batch", runBatch);
}

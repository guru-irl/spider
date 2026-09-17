import { PolyglotExecutor, type ExecResult } from "../executor";
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
  /**
   * Threaded from pi's `ToolDefinition.execute(..., signal, ...)` through ActionCtx.
   * When Escape (or any other abort source) fires this mid-run, the spawned process
   * TREE is killed (see Executor#spawn / killTree) instead of running to completion.
   * Optional — undefined for callers without one (subagents, most tests): the exec
   * behaves exactly as before.
   */
  signal?: AbortSignal;
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

/** I2 (background-fix-review): the emitted partial preview was already capped
 *  (capExecOutput), but the RETAINED accumulator behind it must be bounded too —
 *  otherwise a long chatty stream (`yes`, a verbose build) grows this array/string
 *  without limit for the whole run even though only a capped tail is ever shown.
 *  A generous multiple of the emit cap so mid-run scrollback still feels useful,
 *  but never unbounded. */
const STREAM_ACC_BUDGET_BYTES = MAX_EXEC_OUTPUT_BYTES * 4;

/** Drop the OLDEST WHOLE chunks (never splitting one — so a multi-byte UTF-8
 *  sequence can never be cut mid-character) until the total retained bytes are
 *  <= maxBytes. Always keeps at least the single most recent chunk, even if that
 *  one chunk alone exceeds the budget — a live "still running" preview needs
 *  something to show, and a single write bigger than the budget is rare enough
 *  that truncating IT specifically is not this helper's job (capExecOutput
 *  handles the emitted text's own byte cap separately). Exported for its own
 *  unit tests — pure, no I/O. */
export function trimChunksToBudget(chunks: string[], maxBytes: number): string[] {
  if (chunks.length === 0) return chunks;
  let total = 0;
  for (const c of chunks) total += Buffer.byteLength(c);
  const out = chunks.slice();
  while (total > maxBytes && out.length > 1) {
    total -= Buffer.byteLength(out.shift()!);
  }
  return out;
}

/**
 * M-d: the SAME bound/eviction contract as `trimChunksToBudget` above (drop
 * oldest whole chunks, always keep at least the most recent one, never split a
 * chunk), but O(1) AMORTIZED per push instead of O(window size). The naive
 * `chunks = trimChunksToBudget([...chunks, chunk], budget)` pattern previously
 * called on every single incoming stdout/stderr chunk did a full array-copy
 * (`[...chunks, chunk]`) PLUS a from-scratch byte resum over every retained
 * chunk PLUS an array `shift()` (which reindexes the whole remaining array) —
 * on EVERY push, regardless of how much actually changed. Measured
 * (`md-bench.mjs`, pure CPU, this exact budget): 50,000 pushes of 16-byte
 * chunks took ~5.6s: with a firehose stream (a verbose build, `yes`, etc.)
 * emitting many small writes, this is a real, easily-triggered cost — not a
 * theoretical one — for a helper whose entire job is bookkeeping, not I/O.
 *
 * This keeps a RUNNING byte total (never resummed from scratch) and evicts by
 * advancing a logical head INDEX instead of `Array#shift()` (no reindex per
 * eviction); the backing array is compacted only occasionally — amortized O(1)
 * per push, same retained-byte bound.
 */
class BoundedChunkAccumulator {
  #buf: string[] = [];
  #head = 0;
  #totalBytes = 0;
  readonly #maxBytes: number;

  constructor(maxBytes: number) {
    this.#maxBytes = maxBytes;
  }

  push(chunk: string): void {
    this.#buf.push(chunk);
    this.#totalBytes += Buffer.byteLength(chunk);
    while (this.#totalBytes > this.#maxBytes && this.#buf.length - this.#head > 1) {
      this.#totalBytes -= Buffer.byteLength(this.#buf[this.#head]);
      this.#head++;
    }
    // Reclaim the discarded prefix only OCCASIONALLY (amortized O(1) per push) —
    // compacting on every eviction would just reintroduce an O(window) copy per push.
    if (this.#head > 256 && this.#head * 2 > this.#buf.length) {
      this.#buf = this.#buf.slice(this.#head);
      this.#head = 0;
    }
  }

  text(): string {
    return this.#head === 0 ? this.#buf.join("") : this.#buf.slice(this.#head).join("");
  }
}

/** A callable executor hook with an explicit completion flush. */
type ExecStreamer = ((chunk: string) => void) & { flush: () => void };

/** Build the executor `onData` hook that feeds ctx.onPartial with cumulative, capped,
 *  throttled snapshots. Returns undefined when the caller wants no streaming, so the
 *  non-streaming path stays exactly as it was. Exported for direct testing (I-5): the
 *  wiring itself — not only the pure `trimChunksToBudget` helper above — is what the
 *  brief asked to pin (throttled cumulative emission, bounded window, split-UTF-8
 *  safety, no wiring created when there's no `onPartial`). */
export function makeStreamer(ctx: ExecCtx): ExecStreamer | undefined {
  if (typeof ctx.onPartial !== "function") return undefined;
  const acc = new BoundedChunkAccumulator(STREAM_ACC_BUDGET_BYTES);
  let lastAt = 0;
  let lastEmitted: string | undefined;
  const emit = (dedupe: boolean) => {
    // Cap completion flushes exactly like timer-permitted partials. Suppress an empty
    // snapshot, and suppress an identical snapshot specifically on final flush so the
    // completion hook does not repeat what the throttle already published.
    const snapshot = capExecOutput(acc.text());
    if (snapshot.length === 0 || (dedupe && snapshot === lastEmitted)) return;
    lastEmitted = snapshot;
    ctx.onPartial!(snapshot);
  };
  const streamer = ((chunk: string) => {
    acc.push(chunk);
    const now = Date.now();
    if (now - lastAt < PARTIAL_THROTTLE_MS) return;
    lastAt = now;
    emit(false);
  }) as ExecStreamer;
  streamer.flush = () => emit(true);
  return streamer;
}

/** Cap to the budget. When it truncates, say what to do instead — a bare "..." tells the
 *  agent nothing and it re-runs the same command, paying the same cost twice. */
function capExecOutput(text: string): string {
  if (Buffer.byteLength(text) <= MAX_EXEC_OUTPUT_BYTES) return text;
  const budget = MAX_EXEC_OUTPUT_BYTES - Buffer.byteLength(TRUNCATION_NOTE);
  return capBytes(text, budget) + TRUNCATION_NOTE;
}

const shape = (r: any) => {
  let text = r.stdout + (r.stderr ? "\n[stderr]\n" + r.stderr : "");

  // Structured discriminator (see executor.ts's ExecOutcome). Fall back to a
  // conservative derivation for any hypothetical caller/result that predates
  // this field — never re-derive "known vs unknown" from `exitCode === null`
  // alone, since that is null for multiple different situations.
  const outcome: string =
    r.outcome ??
    (r.exitCode === null
      ? (r.retained === true ? "exited" : r.backgroundJob ? "timeout" : "unknown")
      : "exited");

  const receiptPath = r.backgroundJob?.receipt;
  // Time-independent wording: never claims the receipt is "absent until it
  // exits" (that becomes false the instant the job exits after this call
  // returns) — the receipt may already exist, or may never appear at all.
  const receiptLine = receiptPath ? `  receipt: ${receiptPath}  (recorded outcome when available)\n` : "";
  const logsLines = r.backgroundLogs
    ? `  stdout:  ${r.backgroundLogs.stdout}\n  stderr:  ${r.backgroundLogs.stderr}\n`
    : "";

  if (outcome === "timeout") {
    // R3 (background-brief): deliberately detached at a timeout handoff —
    // genuinely still running, outcome not known YET. This is the ONE case
    // where "returned before the command finished" is actually true.
    text += `\n\n[detached — this call returned before the command finished; exit status is not known yet, and is never assumed to be 0.\n${receiptLine}${logsLines}Its output no longer depends on this session; tail the logs, or re-check with another exec call${receiptPath ? ` (e.g. \`cat ${receiptPath}\`).]` : ".]"}`;
  } else if (outcome === "unknown") {
    // Genuinely indeterminate (e.g. the supervisor died before writing a
    // receipt): never claim it "returned before finishing" (that may already
    // be false) and never infer the receipt's absence/presence from a
    // nullable exit code.
    text += `\n\n[outcome unknown — the supervisor process is gone and no exit receipt was ever written; whether the real command succeeded, failed, or is still running cannot be determined from here.\n${receiptLine}${logsLines}]`;
  } else if (r.retained) {
    // C-1/I-3: a KNOWN terminal outcome (exited/signal/spawn-error/aborted)
    // whose job directory was retained because its process group could not
    // be proven empty. NEVER uses "not known yet" language here — the
    // outcome IS known, even when `exitCode` itself is `null` (signal death,
    // spawn error).
    const what =
      outcome === "signal" ? `was terminated by signal ${r.signal ?? "?"}` :
      outcome === "spawn-error" ? "never started (spawn error)" :
      outcome === "aborted" ? `aborted (exit ${r.exitCode})` :
      `finished (exit ${r.exitCode})`;
    text += `\n\n[the command ${what}, but its job directory was retained — ${r.retainedReason ?? "possible live descendants"}.\n${logsLines}${receiptLine}Further output, if any, keeps landing in the logs above.]`;
  }
  return capExecOutput(text);
};

/** A-H1 (branch-review A-architecture.md): the classification of a raw exec outcome as a
 *  KNOWN failure that legitimately never had a numeric exit code — exported so every
 *  caller (below, and `render-result.ts`'s batch aggregate across the package boundary;
 *  `@spider/host` is allowed to import `@spider/context` per the DAG) agrees on exactly
 *  which outcomes qualify. Previously `render-result.ts` kept its OWN, narrower copy that
 *  silently omitted `"aborted"`. */
export function isKnownFailureOutcome(outcome: string | undefined): boolean {
  return outcome === "signal" || outcome === "spawn-error" || outcome === "aborted";
}

/** A-H1: THE single source of truth for "is this one exec result an error", shared by
 *  `runExec`/`runExecFile`/`runBatch` below. `exitCode` is `number | null` branch-wide
 *  (executor.ts's `ExecResult`): `null` ALONE means the outcome is genuinely NOT KNOWABLE
 *  yet (a still-running `"timeout"` handoff, or an indeterminate `"unknown"` supervisor
 *  loss) — neutral, never a hard failure — UNLESS `outcome` is one of the three KNOWN
 *  failure kinds above, which ARE real failures even though they legitimately carry a
 *  null exitCode. Before this, `runExecFile`/`runBatch` used the naive `exitCode !== 0`,
 *  which reported an unknowable `null` as a hard failure and, for `runExecFile`,
 *  self-contradicted the very text (`shape()`) returned alongside it ("outcome
 *  unknown… cannot be determined from here" with `isError: true` on the SAME result). */
export function isExecError(res: { outcome?: string; exitCode: number | null }): boolean {
  return isKnownFailureOutcome(res.outcome) || (res.exitCode !== null && res.exitCode !== 0);
}

export async function runExec(args: any, ctx: ExecCtx): Promise<{ text: string; details: any; isError: boolean }> {
  const onData = makeStreamer(ctx);
  let res: ExecResult;
  try {
    res = await mk(ctx).execute({
      language: args.language,
      code: args.code,
      // Milliseconds, and NOT a runtime budget for the command — see the
      // ExecuteOptions.timeout/.background JSDoc in executor.ts for exactly what
      // happens at the deadline (killed, or detached + backgrounded to a file).
      timeout: args.timeout,
      background: args.background,
      onData,
      signal: ctx.signal,
    });
  } finally {
    onData?.flush();
  }
  // R3 (background-brief): `exitCode: null` means NOT KNOWN YET — a launch is
  // neither success nor failure, so it must never be reported as an error just
  // because it isn't a clean 0. Actual failures (a real nonzero exit code) still
  // are — and so are the three KNOWN-but-null outcomes (signal death, spawn
  // error, and an aborted run): "generic unknown is neutral" (timeout/unknown),
  // but "known signal/spawn-error/abort remains visibly failure", never laundered
  // into a neutral non-error just because `exitCode` happens to be `null`.
  return { text: shape(res), details: res, isError: isExecError(res) };
}

export async function runExecFile(args: any, ctx: ExecCtx): Promise<{ text: string; details: any; isError: boolean }> {
  const onData = makeStreamer(ctx);
  let res: ExecResult;
  try {
    res = await mk(ctx).executeFile({
      path: args.path,
      language: args.language,
      code: args.code,
      timeout: args.timeout,
      // A-H2 (branch-review A-architecture.md): the host declares exec_file streaming +
      // abortable (extension.ts's `streams` predicate, and `ActionCtx.signal`) but this
      // passed NEITHER through — Escape was a silent no-op and the result section never
      // received a partial chunk. Same wiring as runExec.
      onData,
      signal: ctx.signal,
    });
  } finally {
    onData?.flush();
  }
  // A-H1: was `res.exitCode !== 0` — reported a not-knowable `null` as a hard failure and
  // contradicted `shape()`'s own "outcome unknown" text on the same result. `executeFile`
  // never passes `background` to `execute()` (so `"timeout"`/`"unknown"` are not reachable
  // through this path today), but the SAME rule as `runExec` applies regardless — this must
  // not silently regress the moment that changes.
  return { text: shape(res), details: res, isError: isExecError(res) };
}

function batchStatus(res: ExecResult): string {
  if (res.outcome === "signal") return `signal ${res.signal ?? "unknown"}`;
  if (res.outcome === "spawn-error") return "spawn error";
  if (res.outcome === "aborted") {
    return typeof res.exitCode === "number" ? `aborted · exit ${res.exitCode}` : "aborted";
  }
  if (typeof res.exitCode === "number") return `exit ${res.exitCode}`;
  return res.outcome === "timeout" ? "detached · exit status unknown" : "exit status unknown";
}

export async function runBatch(args: any, ctx: ExecCtx): Promise<{ text: string; details: any[]; isError: boolean }> {
  const ex = mk(ctx);
  const parts: string[] = [];
  let anyErr = false;
  const all: any[] = [];
  // A-H2: ONE streamer for the WHOLE batch (not one per command) — the result section is
  // a single cumulative transcript as commands run one after another, matching how
  // render-result.ts's partial handling treats batch output as one blob regardless of
  // which command produced it.
  const onData = makeStreamer(ctx);
  try {
    for (const [i, cmd] of (args.commands ?? []).entries()) {
      const res = await ex.execute({ language: cmd.language, code: cmd.code, timeout: cmd.timeout, onData, signal: ctx.signal });
      // A-H1: same shared rule as runExec/runExecFile — was `res.exitCode !== 0` per entry.
      if (isExecError(res)) anyErr = true;
      all.push(res);
      // C-M2: details/isError are not model-facing. Name THIS entry's real outcome in
      // its header so the model can attribute a failure to the command that produced
      // it. Never synthesize a numeric code for signal/spawn/unknown outcomes.
      parts.push(`── [${i + 1}] ${cmd.language} · ${batchStatus(res)} ──\n${res.stdout}${res.stderr ? "\n[stderr]\n" + res.stderr : ""}`);
      // A-H2: an abort mid-batch must stop the WHOLE batch, not just the currently running
      // command — without this check the loop would launch every remaining command right
      // after Escape killed the current one, so the abort silently did almost nothing.
      if (ctx.signal?.aborted) break;
    }
  } finally {
    onData?.flush();
  }
  return { text: capExecOutput(parts.join("\n\n")), details: all, isError: anyErr };
}

export function registerExecActions(register: (name: string, handler: (a: any, c: any) => any) => void): void {
  register("exec", runExec);
  register("exec_file", runExecFile);
  register("batch", runBatch);
}

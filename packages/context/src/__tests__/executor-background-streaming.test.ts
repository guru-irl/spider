import { describe, it, expect } from "vitest";
import { rmSync, existsSync } from "node:fs";
import { PolyglotExecutor } from "../executor";

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

/** Poll for the job's receipt (real completion), then remove its directory. Bounded
 *  and load-tolerant — a fixed sleep guess is flaky when many test files run their
 *  own real subprocesses concurrently (pool:"forks", maxWorkers:3) and the OS is
 *  under contention. Never removes a directory whose supervisor might still be
 *  writing to it — that race is what left residue in the real project scratch
 *  during development of this suite. */
async function waitForReceiptThenRemove(dir: string, receipt: string, deadlineMs = 8000): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline && !existsSync(receipt)) {
    await sleep(50);
  }
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

describe("background streaming — pre-handoff onData restored (I1), O5 corrected", () => {
  it("background:true still streams output through onData BEFORE the timeout handoff", async () => {
    const chunks: string[] = [];
    const exec = new PolyglotExecutor({ projectRoot: () => process.cwd() });
    const r = await exec.execute({
      language: "shell",
      code: `i=1; while [ $i -le 15 ]; do echo "TICK $i"; sleep 0.08; i=$((i+1)); done`,
      background: true,
      timeout: 700,
      onData: (c) => chunks.push(c),
    });
    try {
      expect(r.backgrounded).toBe(true);
      // Genuinely streamed, not a single flush.
      expect(chunks.length).toBeGreaterThan(1);
      expect(chunks.join("")).toMatch(/TICK 1\b/);
    } finally {
      if (r.backgroundJob) await waitForReceiptThenRemove(r.backgroundJob.dir, r.backgroundJob.receipt);
    }
  }, 15_000);

  it("no chunk arrives after the handoff resolves — the tail is stopped, not merely idle", async () => {
    const chunks: string[] = [];
    const exec = new PolyglotExecutor({ projectRoot: () => process.cwd() });
    const r = await exec.execute({
      language: "shell",
      code: `i=1; while [ $i -le 30 ]; do echo "TICK $i"; sleep 0.08; i=$((i+1)); done`,
      background: true,
      timeout: 200,
      onData: (c) => chunks.push(c),
    });
    try {
      expect(r.backgrounded).toBe(true);
      const countAtHandoff = chunks.length;
      // The grandchild keeps writing for ~2 more seconds after handoff — if the
      // tail were merely idle (not actually stopped) rather than genuinely torn
      // down, a leaked interval could still be polling and would pick this up.
      await sleep(2400);
      expect(chunks.length).toBe(countAtHandoff);
    } finally {
      if (r.backgroundJob) await waitForReceiptThenRemove(r.backgroundJob.dir, r.backgroundJob.receipt);
    }
  }, 15_000);

  it("background:true with NO timeout still streams to actual exit and returns the TRUE exit code (no silent immediate detach)", async () => {
    const chunks: string[] = [];
    const exec = new PolyglotExecutor({ projectRoot: () => process.cwd() });
    const r = await exec.execute({
      language: "shell",
      code: `i=1; while [ $i -le 8 ]; do echo "TICK $i"; sleep 0.15; i=$((i+1)); done; exit 7`,
      background: true,
      onData: (c) => chunks.push(c),
    });
    expect(r.backgrounded).toBeFalsy();
    expect(r.exitCode).toBe(7);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("")).toContain("TICK 1");
    expect(chunks.join("")).toContain("TICK 8");
  }, 10_000);

  it("stderr streams too, before handoff", async () => {
    const chunks: string[] = [];
    const exec = new PolyglotExecutor({ projectRoot: () => process.cwd() });
    const r = await exec.execute({
      language: "shell",
      code: `i=1; while [ $i -le 10 ]; do echo "ERR $i" 1>&2; sleep 0.08; i=$((i+1)); done`,
      background: true,
      timeout: 500,
      onData: (c) => chunks.push(c),
    });
    try {
      expect(chunks.join("")).toMatch(/ERR 1\b/);
    } finally {
      if (r.backgroundJob) await waitForReceiptThenRemove(r.backgroundJob.dir, r.backgroundJob.receipt);
    }
  }, 10_000);

  it("no onData supplied → background exec still works exactly as before (callback stays optional)", async () => {
    const exec = new PolyglotExecutor({ projectRoot: () => process.cwd() });
    const r = await exec.execute({
      language: "shell", code: "sleep 2; echo end", background: true, timeout: 150,
    });
    try {
      expect(r.backgrounded).toBe(true);
      expect(r.exitCode).toBeNull();
    } finally {
      if (r.backgroundJob) await waitForReceiptThenRemove(r.backgroundJob.dir, r.backgroundJob.receipt);
    }
  }, 10_000);

  // I1 regression: the streaming test above tolerates a trailing `sleep 0.15` after
  // the last TICK, so a poll tick has somewhere to land even without a real final
  // flush — it cannot discriminate stop()-flushes-once-more from stop()-never-flushes.
  // This one ends on the FINAL line with NOTHING after it, background:true with NO
  // timeout (so the call awaits the real, fast exit rather than a timed handoff).
  it("the terminal line reaches onData with no trailing sleep after it — stop() genuinely flushes once more, not merely idle (I1)", async () => {
    const chunks: string[] = [];
    const exec = new PolyglotExecutor({ projectRoot: () => process.cwd() });
    const r = await exec.execute({
      language: "shell",
      code: `i=1; while [ $i -le 6 ]; do echo "TICK $i"; sleep 0.12; i=$((i+1)); done; echo FINAL_LINE_NO_SLEEP; exit 6`,
      background: true,
      onData: (c) => chunks.push(c),
    });
    expect(r.backgrounded).toBeFalsy();
    expect(r.exitCode).toBe(6);
    expect(chunks.join("")).toContain("FINAL_LINE_NO_SLEEP");
  }, 10_000);

  // I2 regression: the streaming cap used to be `{ maxBytes: this.#hardCapBytes }`
  // passed straight to tailLogs — a PER-TICK, per-file bound, not the single
  // CUMULATIVE budget the foreground pipe path enforces. A small hardCapBytes here
  // makes a firehose blow well past the budget in-memory if the cap is only per-tick.
  it("enforces ONE cumulative byte budget across both streams (not per-tick/per-file), notes the cap once, and never kills the detached job for it (I2)", async () => {
    const chunks: string[] = [];
    const CAP = 500; // bytes — deliberately tiny so a firehose blows past it fast
    const exec = new PolyglotExecutor({ projectRoot: () => process.cwd(), hardCapBytes: CAP });
    const r = await exec.execute({
      language: "shell",
      // Far more than CAP bytes of output, arriving over many ticks — a per-tick-only
      // bound would let cumulative onData bytes grow without limit; the fix must not.
      code: `i=1; while [ $i -le 40 ]; do echo "PADLINE-0123456789-$i"; sleep 0.02; i=$((i+1)); done; echo REAL_TAIL_END`,
      background: true,
      onData: (c) => chunks.push(c),
    });
    // The command itself must still run to real completion — the cap bounds
    // STREAMING only, never the detached job or its durable log file.
    expect(r.exitCode).toBe(0);
    const totalStreamed = chunks.reduce((n, c) => n + Buffer.byteLength(c, "utf-8"), 0);
    // Generous slack over CAP for the single cap-notice line itself, but nowhere
    // near the ~40 lines * ~20 bytes actually produced — proves a real cumulative
    // stop, not merely a smaller per-tick number that still sums unbounded.
    expect(totalStreamed).toBeLessThan(CAP + 300);
    const noteCount = chunks.filter((c) => /capped/i.test(c)).length;
    expect(noteCount).toBe(1); // exactly one cap notice, not one per tick
  }, 10_000);
});

import { describe, it, expect, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { paths } from "@spider/db-core";
import { PolyglotExecutor, createSettleGuard } from "../executor";
import { runExec } from "../actions/exec";
import { detectRuntimes } from "../runtime";

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

describe("createSettleGuard (m-2): the primitive that keeps close/error/background-timeout from ever driving onData/res more than once between them", () => {
  it("the first call returns true (settle now); every subsequent call returns false", () => {
    const trySettle = createSettleGuard();
    expect(trySettle()).toBe(true);
    expect(trySettle()).toBe(false);
    expect(trySettle()).toBe(false);
  });

  it("two independent guards never share state", () => {
    const a = createSettleGuard();
    const b = createSettleGuard();
    expect(a()).toBe(true);
    expect(b()).toBe(true); // b's first call is unaffected by a already having settled
    expect(a()).toBe(false);
    expect(b()).toBe(false);
  });
});

/** Same isolated-fixture pattern as executor-background-jobdir.test.ts's makeFixture. */
function makeFixture(): { root: string; scratch: string } {
  const scratchRoot = paths.scratch("project", process.cwd());
  mkdirSync(scratchRoot, { recursive: true });
  const root = mkdtempSync(join(scratchRoot, ".bgstream-integrity-fixture-"));
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
  execFileSync("git", ["config", "user.name", "test"], { cwd: root });
  const scratch = paths.scratch("project", root);
  return { root, scratch };
}

describe("I-1: real per-stream UTF-8 decoding through the actual executor (not a pre-decoded glyph)", () => {
  // "€" (U+20AC) is 3 bytes in UTF-8. A 900,000-byte firehose of it, read
  // through a real OS pipe (default ~64KB read chunking), is virtually
  // guaranteed to split at least one 3-byte sequence across two `data` events
  // (65536 is not a multiple of 3) — a whole already-decoded glyph passed as a
  // single chunk (the property the round-3-reviewed test actually asserted)
  // is NOT this scenario.
  it("a real multi-byte-character firehose on stdout is never corrupted in onData previews OR the final stdout, even though raw pipe chunks split code points mid-sequence", async () => {
    const chunks: string[] = [];
    const exec = new PolyglotExecutor({ projectRoot: () => process.cwd() });
    const r = await exec.execute({
      language: "javascript",
      code: `process.stdout.write("\\u20AC".repeat(300000));`,
      onData: (c) => chunks.push(c),
    });
    expect(r.exitCode).toBe(0);
    // Proves it really arrived across multiple raw pipe chunks — the scenario
    // the round-3 review's PROBE_K1 demonstrated corrupts 18/19 chunks without
    // a per-stream StringDecoder.
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c).not.toContain("\uFFFD");
    expect(r.stdout).not.toContain("\uFFFD");
    expect(r.stdout.length).toBe(300000); // every glyph survived, none dropped/duplicated
    expect(chunks.join("")).toBe(r.stdout); // onData reassembles EXACTLY to the final stdout
  }, 20_000);

  it("the same firehose on stderr is equally protected", async () => {
    const chunks: string[] = [];
    const exec = new PolyglotExecutor({ projectRoot: () => process.cwd() });
    const r = await exec.execute({
      language: "javascript",
      code: `process.stderr.write("\\u20AC".repeat(300000));`,
      onData: (c) => chunks.push(c),
    });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c).not.toContain("\uFFFD");
    expect(r.stderr).not.toContain("\uFFFD");
    expect(chunks.join("")).toBe(r.stderr);
  }, 20_000);

  it("a stream ending EXACTLY on a split multi-byte character (no trailing ASCII) is flushed exactly once via onData — never dropped, never duplicated (I-1 stop/flush contract)", async () => {
    const chunks: string[] = [];
    const exec = new PolyglotExecutor({ projectRoot: () => process.cwd() });
    const r = await exec.execute({
      language: "javascript",
      code: `process.stdout.write("\\u20AC".repeat(200000));`, // ends exactly on €, nothing after
      onData: (c) => chunks.push(c),
    });
    expect(r.stdout.endsWith("\u20AC")).toBe(true);
    expect(chunks.join("")).toBe(r.stdout);
  }, 20_000);
});

describe("onPartial/onData lifecycle: never called after the call has resolved", () => {
  it("completion: no onPartial call arrives after runExec's promise has resolved", async () => {
    let resolved = false;
    const seenAfterResolve: string[] = [];
    const res = await runExec(
      { action: "exec", language: "shell", code: "echo done" },
      { cwd: process.cwd(), onPartial: (t: string) => { if (resolved) seenAfterResolve.push(t); } } as any,
    );
    resolved = true;
    await sleep(300);
    expect(seenAfterResolve).toEqual([]);
    expect((res.details as any).exitCode).toBe(0);
  });

  it("timeout handoff: no onPartial call for THIS call arrives after it resolves, even though the job keeps streaming in the background", async () => {
    let resolved = false;
    const seenAfterResolve: string[] = [];
    const { root } = makeFixture();
    try {
      const res = await runExec(
        {
          action: "exec", language: "shell",
          code: "i=1; while [ $i -le 20 ]; do echo tick; sleep 0.1; i=$((i+1)); done",
          background: true, timeout: 150,
        },
        { cwd: root, onPartial: (t: string) => { if (resolved) seenAfterResolve.push(t); } } as any,
      );
      resolved = true;
      await sleep(500);
      expect(seenAfterResolve).toEqual([]);
      const d = res.details as any;
      if (d.backgroundJob) {
        await sleep(2200);
        rmSync(d.backgroundJob.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 10_000);

  it("abort: no onPartial call arrives after the abort settles the call", async () => {
    let resolved = false;
    const seenAfterResolve: string[] = [];
    const ac = new AbortController();
    const p = runExec(
      { action: "exec", language: "shell", code: "i=1; while [ $i -le 50 ]; do echo tick; sleep 0.05; i=$((i+1)); done" },
      { cwd: process.cwd(), signal: ac.signal, onPartial: (t: string) => { if (resolved) seenAfterResolve.push(t); } } as any,
    );
    await sleep(150);
    ac.abort();
    const res = await p;
    resolved = true;
    await sleep(300);
    expect(seenAfterResolve).toEqual([]);
    expect((res.details as any).aborted).toBe(true);
    expect((res.details as any).outcome).toBe("aborted");
  }, 10_000);

  it("spawn error: no onData call arrives after the call resolves", async () => {
    let resolved = false;
    const seenAfterResolve: string[] = [];
    // A real ENOENT: no mock/stub of the executor itself, just an intentionally
    // bogus runtime binary path so Node's OWN spawn() genuinely fails to start
    // the process (the same technique executor-background-jobdir.test.ts's I-4
    // test uses to force a real, deterministic code path without a real toolchain).
    const exec = new PolyglotExecutor({
      projectRoot: () => process.cwd(),
      runtimes: { ...detectRuntimes(), javascript: "/definitely/does/not/exist/node-xyz" },
    });
    const r = await exec.execute({
      language: "javascript", code: "console.log('never runs')",
      onData: (c) => { if (resolved) seenAfterResolve.push(c); },
    });
    resolved = true;
    await sleep(200);
    expect(seenAfterResolve).toEqual([]);
    expect(r.outcome).toBe("spawn-error");
    // I-1: a foreground spawn-error must not carry exitCode:1 against its own
    // ExecOutcome JSDoc ("spawn-error": exitCode is null) — that numeric value
    // was the exact foreground/background conflation this stage exists to
    // delete, just moved rather than removed.
    expect(r.exitCode).toBeNull();
  });
});

describe("I-1: foreground rows get the SAME truthful discriminator as background — a signal death, a timeout-kill, or a cap-kill is never reported as outcome:\"exited\"", () => {
  it("a real external signal (no background, no timeout/cap) reports outcome:'signal', exitCode:null, the real signal name, and names it in stderr the way the background path does", async () => {
    const exec = new PolyglotExecutor({ projectRoot: () => process.cwd() });
    const r = await exec.execute({
      language: "shell",
      code: "echo BEFORE_SIGNAL; kill -TERM $$; sleep 5",
    });
    expect(r.stdout).toContain("BEFORE_SIGNAL");
    expect(r.outcome).toBe("signal");
    expect(r.exitCode).toBeNull();
    expect(r.signal).toBe("SIGTERM");
    expect(r.stderr).toMatch(/terminated by signal SIGTERM/i);
  }, 10_000);

  it("the executor's own foreground `timeout` kill is a real signal death (killTree → SIGKILL), never a fabricated outcome:'exited'", async () => {
    const exec = new PolyglotExecutor({ projectRoot: () => process.cwd() });
    const r = await exec.execute({
      language: "shell",
      code: "echo BEFORE_TIMEOUT; sleep 10",
      timeout: 300,
    });
    expect(r.stdout).toContain("BEFORE_TIMEOUT");
    expect(r.timedOut).toBe(true);
    expect(r.outcome).not.toBe("exited");
    expect(r.outcome).toBe("signal");
    expect(r.exitCode).toBeNull();
    expect(typeof r.signal).toBe("string");
  }, 10_000);

  it("the executor's own foreground hardCapBytes kill is a real signal death, never a fabricated outcome:'exited'", async () => {
    const exec = new PolyglotExecutor({ projectRoot: () => process.cwd(), hardCapBytes: 1024 });
    const r = await exec.execute({
      language: "shell",
      code: "yes AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA | head -c 5000000",
    });
    expect(r.outcome).not.toBe("exited");
    expect(r.outcome).toBe("signal");
    expect(r.exitCode).toBeNull();
    expect(typeof r.signal).toBe("string");
  }, 10_000);
});

describe("C-1: signal death with a live descendant — real subprocess, through the real runExec path (PROBE_C2 reproduction)", () => {
  it("reports a KNOWN 'signal' outcome with structured signal name, never the neutral/detached wording, and the model-facing text never claims the call 'returned before the command finished'", async () => {
    const { root } = makeFixture();
    try {
      const res = await runExec(
        {
          action: "exec", language: "shell",
          // Backgrounds a descendant loop, then signals ITSELF — the exact
          // repro background-round3-review.md's PROBE_C2 used.
          code: `(i=1; while [ $i -le 20 ]; do sleep 0.1; i=$((i+1)); done) & echo BEFORE_SIGNAL; kill -TERM $$`,
          background: true,
        },
        { cwd: root } as any,
      );
      const d = res.details as any;
      expect(d.stdout).toContain("BEFORE_SIGNAL");
      // q-1: assert the wording/behavioral properties BEFORE the `outcome`
      // field-presence check below — vitest stops at the first failure, so if
      // these came after `expect(d.outcome).toBe("signal")`, a REAL wording
      // regression would be masked by that earlier assertion whenever `outcome`
      // itself is present (the RED this stage's own report relied on never
      // actually observed these properties failing — only the field's absence).
      expect(res.text).not.toMatch(/returned before the command finished/i);
      expect(res.text).not.toMatch(/NOT known yet/i);
      expect(res.text).not.toMatch(/absent until it exits/i);
      expect(d.exitCode).toBeNull();
      expect(d.outcome).toBe("signal");
      expect(d.signal).toBe("SIGTERM");
      // KNOWN outcome — must never be reported as "still running" via `backgrounded`.
      expect(d.backgrounded).toBeFalsy();
      expect(res.isError).toBe(true); // known signal death remains visibly a failure
      if (d.retained) {
        // If the descendant was still alive at close time (timing-dependent —
        // documented residual limit, not independently forceable to 100%): the
        // job dir/logs must be disclosed, not silently dropped (I-3). See the
        // deterministic double-based test below for an UNCONDITIONAL version
        // of this same disclosure (q-3).
        expect(typeof d.retainedReason).toBe("string");
        expect(d.backgroundJob).toBeTruthy();
        expect(existsSync(d.backgroundJob.dir)).toBe(true);
        expect(res.text).toMatch(/signal|retained/i);
        expect(res.text).toContain(d.backgroundJob.dir);
      }
      await sleep(2500);
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 15_000);
});

describe("C-1/q-3: signal death + process group not provably empty — narrow OS-boundary double, retention assertions made UNCONDITIONAL (not gated behind `if (d.retained)`)", () => {
  it("a signal death whose group cannot be proven empty is retained deterministically, discloses the job dir, and never reuses the exited-case 'finished' wording (m-5/m-6)", async () => {
    const { root } = makeFixture();
    try {
      vi.resetModules();
      const bgJob = await import("../background-job");
      let spyCalls = 0;
      const spy = vi.spyOn(bgJob, "groupHasLiveMembers").mockImplementation(() => { spyCalls++; return true; });
      try {
        const { runExec: freshRunExec } = await import("../actions/exec");
        const res = await freshRunExec(
          {
            action: "exec", language: "shell",
            code: `echo BEFORE_SIGNAL; kill -TERM $$`,
            background: true,
          },
          { cwd: root } as any,
        );
        const d = res.details as any;
        // q-2-style: prove the double was actually consulted on this run's code
        // path, not merely present but unreached.
        expect(spyCalls).toBeGreaterThan(0);
        expect(d.outcome).toBe("signal");
        expect(d.exitCode).toBeNull();
        expect(d.signal).toBe("SIGTERM");
        // q-3: unconditional — no `if (d.retained)` gate.
        expect(d.retained).toBe(true);
        expect(typeof d.retainedReason).toBe("string");
        expect(d.backgroundJob).toBeTruthy();
        expect(existsSync(d.backgroundJob.dir)).toBe(true);
        // m-5: grammar in the model-facing retained-disclosure sentence (built by
        // actions/exec.ts's `shape()`) — "was terminated by", not "terminated by"
        // dangling after "the command". Asserted against the SPECIFIC "...but its
        // job directory was retained" sentence (not just any occurrence of
        // "terminated by signal SIGTERM" anywhere in the text) — executor.ts's OWN
        // stderr note a few lines above already says this correctly, so a looser
        // match would pass even if `shape()`'s own sentence stayed ungrammatical.
        expect(res.text).toMatch(/the command was terminated by signal SIGTERM, but its job directory was retained/i);
        expect(res.text).not.toMatch(/the command terminated by signal SIGTERM, but its job directory was retained/i);
        // m-6: the retained-disclosure note must not reuse the exited-case
        // "the command finished" wording for a signal death — its fate was
        // already stated as a signal termination just above.
        expect(res.text).not.toMatch(/the command finished/i);
        expect(res.text).toMatch(/retained/i);
        expect(res.text).toContain(d.backgroundJob.dir);
        if (d.backgroundJob) rmSync(d.backgroundJob.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      } finally {
        spy.mockRestore();
      }
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 10_000);
});

describe("abort + process group not provably empty — narrow OS-boundary double (real host cannot deterministically produce this liveness answer)", () => {
  it("discloses the job dir/log paths and a real 137 exit even when the group cannot be proven empty", async () => {
    // killTree (SIGKILL -pgid) reaps the whole real process group in practice
    // (confirmed by background-round3-review.md's own PROBE_C4), so forcing
    // "cannot prove empty" for a REAL abort is not independently reproducible
    // from outside — this narrowly doubles ONLY the OS liveness-probe boundary
    // (`groupHasLiveMembers`), via the real module's own export, keeping the
    // real executor/shape/abort-signal contract intact end to end.
    const { root } = makeFixture();
    try {
      vi.resetModules();
      const bgJob = await import("../background-job");
      // q-2: a plain `mockReturnValue` proves nothing about whether the double
      // was ever actually reached by this run's code path — a future refactor
      // that stops calling `groupHasLiveMembers` at all (or routes around this
      // import) would leave every assertion below vacuously green. Count calls
      // instead, and assert the count UNCONDITIONALLY.
      let spyCalls = 0;
      const spy = vi.spyOn(bgJob, "groupHasLiveMembers").mockImplementation(() => { spyCalls++; return true; });
      try {
        const { PolyglotExecutor: FreshExecutor } = await import("../executor");
        const exec = new FreshExecutor({ projectRoot: () => root });
        const ac = new AbortController();
        const p = exec.execute({
          language: "shell", code: "sleep 5; echo never", background: true, signal: ac.signal,
        });
        await sleep(250);
        ac.abort();
        const r = await p;
        expect(r.exitCode).toBe(137);
        expect(r.aborted).toBe(true);
        expect(r.outcome).toBe("aborted");
        // q-2: the double was actually consulted on this run's code path.
        expect(spyCalls).toBeGreaterThan(0);
        // q-3: unconditional — no `if (r.backgroundJob)` gate. A background abort
        // always has a job (it was spawned with `background: true`), so with the
        // double actually consulted (proven above), this must always hold.
        expect(r.backgroundJob).toBeTruthy();
        expect(r.retained).toBe(true);
        expect(typeof r.retainedReason).toBe("string");
        expect(existsSync(r.backgroundJob!.dir)).toBe(true);
        rmSync(r.backgroundJob!.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      } finally {
        spy.mockRestore();
      }
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 10_000);
});

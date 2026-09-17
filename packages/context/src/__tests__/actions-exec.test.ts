import { describe, it, expect, vi } from "vitest";
import { runExec, runExecFile, runBatch, trimChunksToBudget, makeStreamer, isExecError } from "../actions/exec";

const ctx = { cwd: process.cwd() };

describe("exec actions", () => {
  it("exec runs code and returns model-facing stdout text", async () => {
    const r = await runExec({ action: "exec", language: "javascript", code: "console.log('hi')" } as any, ctx);
    expect(r.text).toContain("hi");
    expect((r.details as any).exitCode).toBe(0);
  });

  it("batch runs multiple commands and concatenates labeled output", async () => {
    const r = await runBatch({ action: "batch", commands: [
      { language: "javascript", code: "console.log(1)" },
      { language: "shell", code: "echo two" },
    ] } as any, ctx);
    expect(r.text).toContain("1");
    expect(r.text).toContain("two");
  });

  it("batch model-facing headers identify each command's real exit status or signal (C-M2)", async () => {
    const r = await runBatch({ action: "batch", commands: [
      { language: "shell", code: "echo good" },
      { language: "shell", code: "echo bad; exit 7" },
      { language: "shell", code: "kill -TERM $$" },
    ] } as any, ctx);

    expect(r.text).toContain("── [1] shell · exit 0 ──");
    expect(r.text).toContain("── [2] shell · exit 7 ──");
    expect(r.text).toContain("── [3] shell · signal SIGTERM ──");
    expect(r.isError).toBe(true);
  });

  // The cap is the whole point of routing shell through spider: output lands in the
  // context window VERBATIM, so an unbounded dump costs the session its budget.
  // Mutation this catches: raise MAX_EXEC_OUTPUT_BYTES back toward 200_000 -> fails.
  it("caps model-facing output at 10k bytes", async () => {
    const r = await runExec({
      action: "exec",
      language: "shell",
      // ~50k of output, well past the cap
      code: "for i in $(seq 1 1000); do echo 'the quick brown fox jumps over the lazy dog'; done",
    } as any, ctx);
    expect(Buffer.byteLength(r.text)).toBeLessThanOrEqual(10_000);
  });

  // A bare "..." tells the agent nothing. Truncation must say what to do instead,
  // otherwise the model just re-runs the same command and burns the budget twice.
  it("explains what to do instead when it truncates", async () => {
    const r = await runExec({
      action: "exec",
      language: "shell",
      code: "for i in $(seq 1 1000); do echo 'the quick brown fox jumps over the lazy dog'; done",
    } as any, ctx);
    expect(r.text).toMatch(/truncated/i);
    expect(r.text).toMatch(/file|scratch/i);
  });

  it("leaves output under the cap completely untouched", async () => {
    const r = await runExec({ action: "exec", language: "shell", code: "echo small" } as any, ctx);
    expect(r.text).toContain("small");
    expect(r.text).not.toMatch(/truncated/i);
  });

  it("caps batch output too, not just exec", async () => {
    const r = await runBatch({ action: "batch", commands: [
      { language: "shell", code: "for i in $(seq 1 1000); do echo 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'; done" },
    ] } as any, ctx);
    expect(Buffer.byteLength(r.text)).toBeLessThanOrEqual(10_000);
  });

  // A-H1 (branch-review A-architecture.md): runExec/runExecFile/runBatch each had their
  // OWN "is this an error" rule in the same file — runExecFile/runBatch used the naive
  // pre-fix `exitCode !== 0`, which reports `null` (genuinely NOT KNOWABLE yet — a timeout
  // handoff or an indeterminate supervisor loss) as a hard failure, contradicting the
  // model-facing text (`shape()`) that literally says "outcome unknown… cannot be
  // determined from here" on the SAME result. `isExecError` is now the ONE exported rule
  // every caller here (and render-result.ts's batch aggregate, across the package
  // boundary — host is allowed to import context) uses.
  describe("isExecError — the ONE shared isError rule, single-sourced (A-H1)", () => {
    it("a not-knowable exitCode (unknown/timeout outcome) is NOT an error — exitCode:null alone must never mean failure", () => {
      expect(isExecError({ outcome: "unknown", exitCode: null })).toBe(false);
      expect(isExecError({ outcome: "timeout", exitCode: null })).toBe(false);
    });

    it("a KNOWN failure outcome (signal/spawn-error/aborted) IS an error even though exitCode is null", () => {
      expect(isExecError({ outcome: "signal", exitCode: null })).toBe(true);
      expect(isExecError({ outcome: "spawn-error", exitCode: null })).toBe(true);
      expect(isExecError({ outcome: "aborted", exitCode: null })).toBe(true);
    });

    it("a real nonzero numeric exit code IS an error; a clean exit (0) is not", () => {
      expect(isExecError({ outcome: "exited", exitCode: 1 })).toBe(true);
      expect(isExecError({ outcome: "exited", exitCode: 0 })).toBe(false);
    });

    it("an absent outcome field falls back to the numeric rule alone (conservative default for a hypothetical caller predating the field)", () => {
      expect(isExecError({ exitCode: 0 })).toBe(false);
      expect(isExecError({ exitCode: 2 })).toBe(true);
      expect(isExecError({ exitCode: null })).toBe(false);
    });
  });

  // Reachability note (matches A-probe's own finding): `executeFile` never forwards
  // `background` to `execute()` (see executor.ts), so `runExecFile`/`runBatch` cannot
  // reach `outcome: "timeout"`/`"unknown"` through a REAL invocation today — only
  // `runExec` can. The tests below therefore prove two REAL, reachable things instead:
  // (1) all three functions genuinely agree on the SAME real signal-death command (not
  // just a coincidental match), and (2) the already-working numeric-exit/clean-exit cases
  // are unaffected by routing through the shared predicate.
  describe("runExec / runExecFile / runBatch now AGREE on the same real command (A-H1)", () => {
    it("a real signal-death command reports isError:true identically across all three, and never contradicts its own model-facing text", async () => {
      const code = "echo HI; kill -TERM $$; sleep 5";
      const a = await runExec({ language: "shell", code } as any, ctx);
      const b = await runExecFile({ language: "shell", code, path: "package.json" } as any, ctx);
      const c = await runBatch({ commands: [{ language: "shell", code }] } as any, ctx);
      expect(a.isError).toBe(true);
      expect(b.isError).toBe(true);
      expect(c.isError).toBe(true);
      // The self-contradiction A-H1 called out: text says "outcome unknown" while
      // isError is true. A signal death must say it WAS terminated, never "unknown".
      expect(b.text).not.toMatch(/outcome unknown/i);
      expect(b.text).toMatch(/terminated by signal/i);
      // runExecFile/runBatch must now agree with the SAME shared predicate runExec uses,
      // not a divergent local rule — verified against the actual returned details.
      expect(b.isError).toBe(isExecError(b.details));
      expect((c.details as any[]).some((d) => isExecError(d))).toBe(true);
    }, 20_000);

    it("a real clean exit (0) is NOT an error for any of the three", async () => {
      const a = await runExec({ language: "shell", code: "exit 0" } as any, ctx);
      const b = await runExecFile({ language: "shell", code: "exit 0", path: "package.json" } as any, ctx);
      const c = await runBatch({ commands: [{ language: "shell", code: "exit 0" }] } as any, ctx);
      expect(a.isError).toBe(false);
      expect(b.isError).toBe(false);
      expect(c.isError).toBe(false);
    });

    it("a real nonzero numeric exit is STILL an error for any of the three (unaffected by the fix)", async () => {
      const a = await runExec({ language: "shell", code: "exit 3" } as any, ctx);
      const b = await runExecFile({ language: "shell", code: "exit 3", path: "package.json" } as any, ctx);
      const c = await runBatch({ commands: [{ language: "shell", code: "exit 3" }] } as any, ctx);
      expect(a.isError).toBe(true);
      expect(b.isError).toBe(true);
      expect(c.isError).toBe(true);
    });
  });

  // I2 (background-fix-review): the emitted partial preview was already capped
  // (capExecOutput), but the RETAINED accumulator behind it (`acc += chunk`) grew
  // without bound for a long-running chatty stream (e.g. `yes`) — only the text
  // handed to onPartial was capped, not the memory held onto between calls.
  // `trimChunksToBudget` is the pure helper the real streamer uses to bound that
  // retained memory: it drops the OLDEST WHOLE chunks (never splitting one — no
  // UTF-8-boundary risk) once the total exceeds the budget.
  describe("trimChunksToBudget — bounds the RETAINED streaming accumulator, not just the emitted text (I2)", () => {
    it("drops oldest whole chunks once the total exceeds the budget", () => {
      const chunks = ["aaaa", "bbbb", "cccc", "dddd"]; // 4 bytes each
      const out = trimChunksToBudget(chunks, 9); // room for ~2 chunks
      const total = out.reduce((n, c) => n + Buffer.byteLength(c), 0);
      expect(total).toBeLessThanOrEqual(9);
      // Kept the MOST RECENT chunks (a live "still running" preview cares about
      // what's happening now, not what happened first).
      expect(out.join("")).toBe("cccc" + "dddd");
    });

    it("never drops every chunk — always keeps at least the most recent one, even if it alone exceeds the budget", () => {
      const out = trimChunksToBudget(["short", "a-much-longer-chunk-than-the-budget"], 5);
      expect(out).toEqual(["a-much-longer-chunk-than-the-budget"]);
    });

    it("a stream of 10,000 tiny chunks never retains more than a small bounded multiple of the budget", () => {
      let chunks: string[] = [];
      const BUDGET = 1000;
      for (let i = 0; i < 10_000; i++) {
        chunks = trimChunksToBudget([...chunks, `chunk-${i}-`], BUDGET);
      }
      const total = chunks.reduce((n, c) => n + Buffer.byteLength(c), 0);
      expect(total).toBeLessThanOrEqual(BUDGET);
    });
  });

  // I-5: the brief's own finding was that `trimChunksToBudget`'s unit tests above
  // cover the pure helper only — `makeStreamer`, the thing actually wired to
  // `ctx.onPartial` via the executor's `onData`, had no test of its own. These
  // exercise `makeStreamer` directly (real function, no mocks) and pin the
  // intended sliding-window semantics: throttled cumulative snapshots, a bounded
  // retained window, split-UTF-8 safety across throttle windows, and no wiring
  // created at all when the caller wants no streaming.
  describe("makeStreamer — the actual onPartial wiring (I-5), not just the pure helper behind it", () => {
    it("returns undefined when ctx has no onPartial — no callback, nothing to clean up", () => {
      expect(makeStreamer({ cwd: "." })).toBeUndefined();
    });

    it("throttles bursts to one cumulative emission per ~100ms window, never re-emitting the exact same snapshot back-to-back", () => {
      vi.useFakeTimers();
      try {
        // Start past the throttle window: a real `Date.now()` at construction is a
        // huge epoch value, never 0, so the streamer's very first call always finds
        // `now - lastAt(0)` far past the throttle — starting the fake clock AT 0 would
        // spuriously coincide with that internal `lastAt` initial value instead.
        vi.setSystemTime(10_000);
        const partials: string[] = [];
        const streamer = makeStreamer({ cwd: ".", onPartial: (t) => partials.push(t) })!;
        streamer("a");
        streamer("b"); // same instant — throttled, must not emit again
        expect(partials).toEqual(["a"]);
        vi.setSystemTime(10_150); // past the throttle window
        streamer("c");
        // Cumulative (not a delta) and no duplicate of the first snapshot.
        expect(partials).toEqual(["a", "abc"]);
        // A THIRD throttle window (I-2: "more than one throttle window", not just
        // two) — still cumulative, still no repeat of any earlier snapshot.
        vi.setSystemTime(10_260);
        streamer("d"); // past the throttle window since the last emit — emits
        streamer("e"); // same instant as "d" — throttled, pushed but not emitted yet
        expect(partials).toEqual(["a", "abc", "abcd"]);
        expect(new Set(partials).size).toBe(partials.length); // no duplicate snapshots
      } finally {
        vi.useRealTimers();
      }
    });

    // I-2 (background-round3-review): the ORIGINAL version of this test only
    // asserted `Buffer.byteLength(last) <= 10_000` — true of ANY streamer, since
    // `capExecOutput` caps every single emission to that budget regardless of how
    // much is retained behind it. An UNBOUNDED accumulator passed it identically
    // (verified against a deliberately unbounded mutant — see
    // background-outcome-probes/streamer-mutants.probe.mjs). This version instead
    // checks the RETAINED WINDOW ITSELF: `capExecOutput` emits a HEAD prefix of the
    // accumulator's retained text (see truncate.ts's `byteSafePrefix`), so the
    // FIRST marker still visible in the emission is the first item the accumulator
    // has NOT yet evicted. Pushing far beyond the ~40,000-byte retained budget
    // (`STREAM_ACC_BUDGET_BYTES`) and reading that first marker discriminates a
    // real sliding window from an unbounded one, which would show marker 0000
    // forever no matter how much has been pushed since.
    it("keeps the RETAINED window itself bounded — the first marker still visible in the emitted preview advances as older chunks are evicted (mutation-proof: an unbounded accumulator always shows marker 0000)", () => {
      vi.useFakeTimers();
      try {
        let t = 0;
        vi.setSystemTime(t);
        const partials: string[] = [];
        const streamer = makeStreamer({ cwd: ".", onPartial: (s) => partials.push(s) })!;
        // 600 pushes * ~180 bytes = ~108,000 bytes total — comfortably more than
        // 2.5x the ~40,000-byte retained budget, so real eviction MUST occur.
        for (let i = 0; i < 600; i++) {
          t += 110; // clears the throttle every call — every push actually emits
          vi.setSystemTime(t);
          const marker = `MARK${String(i).padStart(4, "0")}-`;
          streamer(marker.repeat(20));
        }
        expect(partials.length).toBe(600);
        const last = partials[partials.length - 1];
        expect(Buffer.byteLength(last)).toBeLessThanOrEqual(10_000); // the model-facing cap still holds
        const firstMarker = last.match(/MARK(\d{4})-/);
        expect(firstMarker).toBeTruthy(); // the window must contain SOME marker
        // The window genuinely slid forward — the very first thing ever pushed
        // (MARK0000) has been evicted, and the head of the retained window has
        // advanced well past it.
        expect(last).not.toContain("MARK0000-");
        expect(Number(firstMarker![1])).toBeGreaterThan(100);
      } finally {
        vi.useRealTimers();
      }
    });

    // I-2/I-1 (background-round3-review): the ORIGINAL version of this test pushed
    // a single already-decoded 4-byte glyph (18 bytes of input total across all 3
    // pushes) — far too little to ever trigger eviction (the 40,000-byte budget was
    // never approached), so it could not have distinguished real whole-chunk
    // eviction from a mutant that slices the joined string at a raw BYTE offset
    // (which could land mid-code-point). This version drives real eviction
    // pressure with exclusively multi-byte content, so a mid-character-eviction
    // mutant has ample opportunity to corrupt the emitted text (verified against
    // such a mutant — see background-outcome-probes/streamer-mutants.probe.mjs).
    it("drives REAL eviction pressure with multi-byte content and never corrupts a code point at an eviction boundary", () => {
      vi.useFakeTimers();
      try {
        let t = 0;
        vi.setSystemTime(t);
        const partials: string[] = [];
        const streamer = makeStreamer({ cwd: ".", onPartial: (s) => partials.push(s) })!;
        const glyph = "🕸"; // 4 bytes in UTF-8, a surrogate pair in UTF-16
        // 3,000 pushes * 20 bytes (5 glyphs) = 60,000 bytes — 1.5x the retained
        // budget, guaranteeing real eviction of whole multi-byte-only chunks.
        for (let i = 0; i < 3000; i++) {
          t += 110;
          vi.setSystemTime(t);
          streamer(glyph.repeat(5));
        }
        expect(partials.length).toBe(3000);
        const last = partials[partials.length - 1];
        expect(last.length).toBeGreaterThan(0);
        expect(last).not.toContain("\uFFFD"); // no replacement-character corruption
        // Every retained code point is a whole glyph — nothing was cut in half.
        // (The model-facing cap may append a truncation note in plain ASCII once
        // the retained window itself exceeds MAX_EXEC_OUTPUT_BYTES; strip that
        // known suffix before asserting the BODY is glyphs-only.)
        const noteIdx = last.indexOf("[output truncated");
        let body = noteIdx === -1 ? last : last.slice(0, last.lastIndexOf("\n\n", noteIdx));
        if (body.endsWith("...")) body = body.slice(0, -3); // capBytes' own truncation ellipsis
        expect(body.replace(new RegExp(glyph, "gu"), "")).toBe("");
      } finally {
        vi.useRealTimers();
      }
    });
  });
});

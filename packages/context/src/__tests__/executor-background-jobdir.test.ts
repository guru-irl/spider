import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { paths } from "@spider/db-core";
import { PolyglotExecutor } from "../executor";

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

/** Isolated fixture: its own git repo (so `paths.scratch` resolves scratch UNDER the
 *  fixture, never the real project's `.spider/scratch`, even though the fixture
 *  itself is created under the real project's scratch for tidy placement) plus its
 *  own scratch root. Removed wholesale in the caller's `finally` — this is test
 *  teardown, not a use of any executor "cleanup" API (there is none). */
function makeFixture(): { root: string; scratch: string } {
  const scratchRoot = paths.scratch("project", process.cwd());
  mkdirSync(scratchRoot, { recursive: true }); // M-f: paths.scratch is pure string joining — never creates anything
  const root = mkdtempSync(join(scratchRoot, ".bgjobdir-fixture-"));
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
  execFileSync("git", ["config", "user.name", "test"], { cwd: root });
  const scratch = paths.scratch("project", root);
  return { root, scratch };
}

function ctxDirsWithLogs(scratch: string): string[] {
  if (!existsSync(scratch)) return [];
  return readdirSync(scratch)
    .filter((n) => n.startsWith(".ctx-"))
    .filter((n) => existsSync(join(scratch, n, "stdout.log")));
}

/** M-i: distinguishes an ABSENT `bg/` parent from a present-but-EMPTY one —
 *  the prior version returned `[]` for both, so `expect(bgDirs(...)).toEqual(before)`
 *  could never actually see "bg/ came into existence but stayed empty" as
 *  different from "bg/ never existed at all". `undefined` now means absent. */
function bgDirs(scratch: string): string[] | undefined {
  const bgRoot = join(scratch, "bg");
  if (!existsSync(bgRoot)) return undefined;
  return readdirSync(bgRoot);
}

describe("background job directory — stable, caller-owned home (never a throwaway .ctx-* sandbox)", () => {
  it("a handed-off background job's logs live under <scratch>/bg/<id>, not .ctx-*", async () => {
    const { root, scratch } = makeFixture();
    try {
      const before = ctxDirsWithLogs(scratch);
      const exec = new PolyglotExecutor({ projectRoot: () => root });
      const r = await exec.execute({
        language: "shell",
        code: "sleep 2; echo end",
        background: true,
        timeout: 150,
      });

      expect(r.backgrounded).toBe(true);
      expect(r.backgroundJob).toBeTruthy();
      expect(r.backgroundJob!.dir).toContain(`${sep}bg${sep}`);
      expect(r.backgroundJob!.dir.startsWith(scratch)).toBe(true);
      expect(r.backgroundLogs!.stdout.startsWith(r.backgroundJob!.dir)).toBe(true);
      expect(r.backgroundLogs!.stderr.startsWith(r.backgroundJob!.dir)).toBe(true);
      // No new unowned .ctx-* sandbox gained a log file because of this run.
      expect(ctxDirsWithLogs(scratch)).toEqual(before);

      await sleep(2200); // let the detached grandchild actually finish before rmSync
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 15_000);

  it("the job id is sortable/greppable: <UTC-compact>-<8hex>, matching backgroundJob.id", async () => {
    const { root, scratch } = makeFixture();
    try {
      const exec = new PolyglotExecutor({ projectRoot: () => root });
      const r = await exec.execute({
        language: "shell", code: "sleep 1; echo end", background: true, timeout: 100,
      });
      expect(r.backgroundJob!.id).toMatch(/^\d{8}T\d{6}Z-[0-9a-f]{8}$/);
      expect(r.backgroundJob!.dir.endsWith(r.backgroundJob!.id)).toBe(true);
      await sleep(1200);
      void scratch;
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 15_000);

  it("a background job that finishes before the timeout leaves NO retained bg/ directory behind", async () => {
    const { root, scratch } = makeFixture();
    try {
      const exec = new PolyglotExecutor({ projectRoot: () => root });
      const r = await exec.execute({
        language: "shell", code: "echo quick", background: true, timeout: 5000,
      });
      expect(r.stdout).toContain("quick");
      expect(r.exitCode).toBe(0);
      expect(r.backgrounded).toBeFalsy();
      expect(r.backgroundJob).toBeUndefined();
      expect(r.backgroundLogs).toBeUndefined();
      // M-i: bg/ may harmlessly still exist as an empty parent (README), but must
      // never contain a retained job-id entry — `?? []` treats absent/empty alike,
      // which is exactly the guarantee this test is making (and now can actually see
      // the difference between "never existed" and "came into being but stayed empty").
      expect(bgDirs(scratch) ?? []).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 15_000);

  it("a background job with NO timeout at all also leaves no retained directory once it finishes", async () => {
    // Contract requirement: background:true with no timeout still waits/streams to
    // actual exit — it must NOT silently detach immediately, and since it was never
    // handed off, its job dir is cleaned exactly like the quick-finish case above.
    const { root, scratch } = makeFixture();
    try {
      const exec = new PolyglotExecutor({ projectRoot: () => root });
      const r = await exec.execute({
        language: "shell", code: "sleep 0.3; echo real-exit-code; exit 5", background: true,
      });
      expect(r.backgrounded).toBeFalsy();
      expect(r.exitCode).toBe(5);
      expect(r.stdout).toContain("real-exit-code");
      expect(bgDirs(scratch) ?? []).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 15_000);

  it("C1 regression: a quick-finishing shell command that leaves a LIVE DESCENDANT does not have its job directory deleted — the handle is retained, and the descendant's later output stays readable", async () => {
    const { root, scratch } = makeFixture();
    try {
      const exec = new PolyglotExecutor({ projectRoot: () => root });
      // The visible shell (the thing `#spawn` waits on) exits almost instantly, but
      // it leaves a `&`-backgrounded subshell alive, writing to the SAME stdout fd
      // (no redirection) for ~3s afterward — a live descendant the supervisor's own
      // exit says nothing about. No `timeout` at all: this exercises the CLOSE path
      // (supervisor already exited), not the timed-handoff path (which already
      // retains unconditionally).
      const r = await exec.execute({
        language: "shell",
        code: `(i=1; while [ $i -le 30 ]; do echo "DESC $i"; sleep 0.1; i=$((i+1)); done) & echo PARENT_DONE`,
        background: true,
      });

      // The visible command really did finish (echoed PARENT_DONE, exit 0) — this
      // is NOT the timeout/handoff path.
      expect(r.stdout).toContain("PARENT_DONE");

      // The bug (C1): the job directory got rm -rf'd right here because the
      // supervisor itself had exited, discarding the still-writing descendant's
      // log along with it and returning backgroundJob:null — "leaking it
      // invisibly". The fix must retain both the directory and the handle.
      expect(r.backgroundJob).toBeTruthy();
      expect(existsSync(r.backgroundJob!.dir)).toBe(true);
      expect(existsSync(join(r.backgroundJob!.dir, "stdout.log"))).toBe(true);

      // Give the descendant time to keep writing well past this call's return,
      // then prove its output is STILL there — not lost to an unlinked inode.
      // Polled (not a fixed sleep): a bare `sh -c` copy of this exact 30x`sleep 0.1`
      // loop measured close to its nominal ~3s wall-clock time in isolation, but this
      // suite runs many real-subprocess test files concurrently (pool:"forks",
      // maxWorkers:3) — under that CPU contention the loop can take noticeably
      // longer here. A bounded poll keeps the assertion exactly as strict (the
      // same terminal string) while tolerating that observed variance, instead of
      // asserting a specific causal machine property this environment does not
      // reliably exhibit.
      const deadline = Date.now() + 9000;
      let finalLog = "";
      while (Date.now() < deadline) {
        finalLog = readFileSync(join(r.backgroundJob!.dir, "stdout.log"), "utf-8");
        if (finalLog.includes("DESC 30")) break;
        await sleep(200);
      }
      expect(finalLog).toContain("DESC 30");
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 20_000);

  it("retention: a handed-off job directory and an unrelated sibling directory both survive untouched (no automatic GC)", async () => {
    const { root, scratch } = makeFixture();
    try {
      const bgRoot = join(scratch, "bg");
      const sibling = join(bgRoot, "user-baseline-not-ours");
      execFileSync("mkdir", ["-p", sibling]);
      const exec = new PolyglotExecutor({ projectRoot: () => root });
      const r = await exec.execute({
        language: "shell", code: "sleep 3; echo end", background: true, timeout: 150,
      });
      expect(r.backgrounded).toBe(true);
      expect(existsSync(r.backgroundJob!.dir)).toBe(true);
      expect(existsSync(sibling)).toBe(true);

      // Give the detached job time to actually finish, then confirm NOTHING removed
      // either directory automatically — there is no GC, no age reaper, no teardown.
      await sleep(3300);
      expect(existsSync(r.backgroundJob!.dir)).toBe(true);
      expect(existsSync(join(r.backgroundJob!.dir, "stdout.log"))).toBe(true);
      expect(existsSync(sibling)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 15_000);

  it("I-3: a verified-finished command with retained descendants reports the REAL exit code plus a distinct `retained` flag — `backgrounded` is no longer overloaded as the retention signal", async () => {
    const { root, scratch } = makeFixture();
    try {
      const exec = new PolyglotExecutor({ projectRoot: () => root });
      const r = await exec.execute({
        language: "shell",
        code: `(i=1; while [ $i -le 15 ]; do sleep 0.1; i=$((i+1)); done) & echo PARENT_DONE; exit 0`,
        background: true,
      });

      // The visible command really did finish (echoed PARENT_DONE, real exit 0) —
      // this is a VERIFIED completion, not a still-running/detached launch.
      expect(r.stdout).toContain("PARENT_DONE");
      expect(r.exitCode).toBe(0);
      // `backgrounded` used to be set true here too, conflating "directory
      // retained" with "still running, outcome unknown" — a genuinely finished
      // command must not claim to still be running.
      expect(r.backgrounded).toBeFalsy();
      // The explicit retention concept instead:
      expect(r.retained).toBe(true);
      expect(typeof r.retainedReason).toBe("string");
      expect(r.retainedReason!.length).toBeGreaterThan(0);
      // The handle is still returned so nothing about the retained directory is lost.
      expect(r.backgroundJob).toBeTruthy();
      expect(existsSync(r.backgroundJob!.dir)).toBe(true);

      await sleep(1800);
      void scratch;
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 15_000);

  it("C-1: a signal death with a LIVE DESCENDANT reports a KNOWN 'signal' outcome (not the neutral/detached shape), and discloses the retained job directory when the group cannot be proven empty", async () => {
    const { root, scratch } = makeFixture();
    try {
      const exec = new PolyglotExecutor({ projectRoot: () => root });
      const r = await exec.execute({
        language: "shell",
        // Backgrounds a descendant loop, then signals ITSELF — the exact repro
        // background-round3-review.md's PROBE_C2 used.
        code: `(i=1; while [ $i -le 20 ]; do sleep 0.1; i=$((i+1)); done) & echo BEFORE_SIGNAL; kill -TERM $$`,
        background: true,
      });

      expect(r.stdout).toContain("BEFORE_SIGNAL");
      expect(r.exitCode).toBeNull();
      expect(r.outcome).toBe("signal");
      expect(r.signal).toBe("SIGTERM");
      // A KNOWN outcome must never claim to still be "running"/unknown.
      expect(r.backgrounded).toBeFalsy();
      if (r.retained) {
        // Timing-dependent whether the descendant is still alive at close time
        // (documented residual limit — not independently forceable to 100%):
        // when it IS retained, the disclosure must be complete, never dropped.
        expect(typeof r.retainedReason).toBe("string");
        expect(r.backgroundJob).toBeTruthy();
        expect(existsSync(r.backgroundJob!.dir)).toBe(true);
      }
      await sleep(2500);
      void scratch;
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 15_000);

  it("I-4: language:'rust' + background:true never allocates a durable bg/<id> job directory, even when #compileAndRun runs (and fails to compile) in the foreground regardless of the flag", async () => {
    const { root, scratch } = makeFixture();
    try {
      const before = bgDirs(scratch);
      // Force the __rust_compile_run__ branch without needing a real rustc install
      // (unavailable on this machine — see background-final-review.md's own
      // verification-limit note): inject a truthy `runtimes.rust` so buildCommand()
      // routes to #compileAndRun exactly as it would with a real toolchain. The
      // ACTUAL `rustc` binary still doesn't exist, so compilation itself fails —
      // but that failure is irrelevant to what's under test here: whether a
      // durable bg/<id> directory was ever allocated for this request.
      const { detectRuntimes } = await import("../runtime");
      const exec = new PolyglotExecutor({
        projectRoot: () => root,
        runtimes: { ...detectRuntimes(), rust: "rustc" },
      });
      const r = await exec.execute({
        language: "rust", code: 'fn main() { println!("hi"); }', background: true,
      });
      // #compileAndRun never forwards `background` — unaffected by this fix.
      expect(r.backgrounded).toBeFalsy();
      expect(r.backgroundJob).toBeUndefined();
      // The actual point: no NEW entry under bg/ — the durable job directory was
      // never allocated for a language that cannot support background at all.
      expect(bgDirs(scratch)).toEqual(before);
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 15_000);
});

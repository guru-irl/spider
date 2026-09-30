import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { paths } from "@spider/db-core";
import { PolyglotExecutor, type ExecResult } from "../executor";
import { groupHasLiveMembers, readReceiptSafe } from "../background-job";

const __dirname = dirname(fileURLToPath(import.meta.url));

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function waitFor<T>(condition: () => T | false | undefined, what: string, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = condition();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

// The shell's exit does not finish the job: the independent supervisor still
// writes exit.json.<pid>.<random>.tmp, renames it to exit.json, then exits.
// Both the receipt and supervisor death are needed before removing its directory.
async function waitForJob(r: ExecResult): Promise<NonNullable<ReturnType<typeof readReceiptSafe>>> {
  expect(r.backgroundJob).toBeTruthy();
  expect(r.pid).toBeGreaterThan(0);
  const receipt = await waitFor(
    () => !isAlive(r.pid!) && readReceiptSafe(r.backgroundJob!.receipt),
    "background receipt and supervisor exit",
  );
  return receipt;
}

/**
 * M6 (background-fix-brief, user-approved fixture-only change): every test below
 * used to pass `process.cwd()` (the REAL spider repo) as `projectRoot`, so every
 * `background: true` run in this file landed its durable job directory under the
 * real project's `.spider/scratch/bg/<id>` — with no cleanup in two of the three
 * describe blocks. This is a git-initialized, throwaway fixture root (same pattern
 * as executor-background-jobdir.test.ts's `makeFixture`): `paths.scratch("project", root)`
 * then resolves entirely UNDER `root`, so every job directory this file creates is
 * isolated there and is removed in each test's own `finally`. NOT ONE assertion
 * below changed — only where the job directories live and that they get cleaned up.
 */
function makeFixture(): string {
  const scratchRoot = paths.scratch("project", process.cwd());
  mkdirSync(scratchRoot, { recursive: true }); // M-g: paths.scratch is pure string joining — never creates anything
  const root = mkdtempSync(join(scratchRoot, ".bgsurvival-fixture-"));
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
  execFileSync("git", ["config", "user.name", "test"], { cwd: root });
  return root;
}

/**
 * Bundles the standalone-process harness (which imports the REAL executor.ts)
 * into a single dependency-free .mjs via esbuild, so it can be run with plain
 * `node` as a genuinely separate OS process — no pipe/fd shared with vitest.
 *
 * `@spider/db-core` is aliased straight to its `paths.ts` file (not the
 * package barrel) so the bundle never pulls in better-sqlite3/sqlite-vec —
 * executor.ts only needs `paths.scratch(...)` from that package.
 */
async function buildHarness(outDir: string): Promise<string> {
  const esbuild = await import("esbuild");
  const outfile = join(outDir, "harness.mjs");
  await esbuild.build({
    entryPoints: [join(__dirname, "helpers/background-harness-entry.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    outfile,
    alias: {
      "@spider/db-core": join(__dirname, "../../../db-core/src/paths.ts"),
    },
  });
  return outfile;
}

describe("backgrounded process survives the LAUNCHING PROCESS exiting", () => {
  // Root cause under test: the old code kept the child's stdout/stderr as pipes
  // whose read end lives in the launching process. That's fine while the
  // launcher is alive (the no-op drain kept the pipe open), but the moment the
  // launcher actually exits (a subagent finishing counts), the kernel closes
  // its fds — including the pipe read end — and the child's next write raises
  // SIGPIPE (default disposition: terminate, no handler, no trace).
  //
  // This test proves the fix by making an ACTUAL separate process (not the
  // vitest worker) launch the background command and then really exit, while
  // the grandchild is still mid-loop with real work left to do. A test that
  // only checks the call "returns early" would pass even on the old, broken
  // code — this one cannot, because a SIGPIPE-killed process can never later
  // reach its own completion sentinel.
  it("grandchild keeps writing output and reaches completion AFTER its launching process has fully exited", async () => {
    const fixtureRoot = makeFixture();
    const scratchRoot = paths.scratch("project", fixtureRoot);
    mkdirSync(scratchRoot, { recursive: true });
    const workDir = mkdtempSync(join(scratchRoot, ".bgtest-"));
    const handoffPath = join(workDir, "handoff.json");
    let job: ExecResult | undefined;
    let releasePath: string | undefined;
    let testError: unknown;

    try {
      const harnessPath = await buildHarness(workDir);

      const TOTAL_TICKS = 20;
      const TICK_MS = 150; // ~3s of total grandchild runtime
      releasePath = join(workDir, "release");
      const shellCode = [
        `echo "PID:$$"`,
        // Keep the work unfinished until AFTER the launcher is confirmed dead.
        // A delayed test worker cannot accidentally miss this observation.
        `while [ ! -f ${JSON.stringify(releasePath)} ]; do sleep 0.05; done`,
        `i=1`,
        `while [ $i -le ${TOTAL_TICKS} ]; do`,
        `  echo "TICK $i"`,
        `  sleep ${TICK_MS / 1000}`,
        `  i=$((i+1))`,
        `done`,
        `echo DONE`,
      ].join("\n");

      // The harness hands off after 200ms and exits; the shell cannot start
      // its tick loop until this test releases it after observing that exit.
      const BACKGROUND_AFTER_MS = 200;

      execFileSync(
        process.execPath,
        [harnessPath, fixtureRoot, shellCode, String(BACKGROUND_AFTER_MS), handoffPath],
        { encoding: "utf-8", timeout: 25_000 },
      );
      const handoff: ExecResult = JSON.parse(readFileSync(handoffPath, "utf-8"));
      job = handoff;
      expect(handoff.backgrounded).toBe(true);
      expect(handoff.timedOut).toBe(true);
      expect(handoff.backgroundLogs?.stdout).toBeTruthy();

      const logPath = handoff.backgroundLogs!.stdout;

      // The launching process (the harness) is now COMPLETELY gone — execFileSync
      // only returns once it has exited. Everything from here on is observing
      // what the grandchild does with no launcher alive at all.
      const soonAfterLauncherDeath = await waitFor(
        () => { const log = readFileSync(logPath, "utf-8"); return log.includes("PID:") ? log : undefined; },
        "shell PID marker after launcher exit",
      );
      const pidMatch = soonAfterLauncherDeath.match(/PID:(\d+)/);
      expect(pidMatch).toBeTruthy();
      const grandchildPid = Number(pidMatch![1]);

      const ticksSeenSoFar = (soonAfterLauncherDeath.match(/TICK \d+/g) ?? []).length;
      // There must be real, unfinished work left when the launcher died —
      // otherwise this test would prove nothing about survival.
      expect(ticksSeenSoFar).toBeLessThan(TOTAL_TICKS);

      // The actual proof: poll until either the log reaches its completion
      // sentinel or we give up. A process SIGPIPE-killed right after the
      // launcher exited can NEVER reach this — there is no way to "catch up"
      // once it's dead. This is why this assertion (not an instantaneous
      // liveness snapshot) is the real test of the fix.
      writeFileSync(releasePath, "go");
      const finalContent = await waitFor(
        () => { const log = readFileSync(logPath, "utf-8"); return log.includes("DONE") ? log : undefined; },
        "shell completion marker after launcher exit",
      );
      expect(finalContent).toContain(`TICK ${TOTAL_TICKS}`);
      expect(finalContent).toContain("DONE");

      await waitFor(() => groupHasLiveMembers(handoff.pid!) === false, "background process group to empty");
      const receipt = readReceiptSafe(handoff.backgroundJob!.receipt);
      expect(receipt, "background receipt missing after process group exit").toBeTruthy();
      expect(receipt!.state).toBe("exited");
      expect(receipt!.exitCode).toBe(0);
      expect(isAlive(grandchildPid)).toBe(false);
    } catch (error) {
      testError = error;
      throw error;
    } finally {
      // A missing receipt must fail in the test body. Cleanup only needs proof
      // that no process in the job's group can write into the fixture anymore.
      try {
        if (releasePath) writeFileSync(releasePath, "go");
        if (!job && existsSync(handoffPath)) job = JSON.parse(readFileSync(handoffPath, "utf-8")) as ExecResult;
        if (job?.backgroundJob && job.pid) {
          const pgid = job.pid;
          await waitFor(() => groupHasLiveMembers(pgid) === false, "background process group to empty");
        } else {
          const bgRoot = join(scratchRoot, "bg");
          if (existsSync(bgRoot) && readdirSync(bgRoot).length > 0) {
            throw new Error("Background job has no handoff handle; fixture retained to avoid deleting an unknown writer");
          }
        }
        rmSync(workDir, { recursive: true, force: true });
        rmSync(fixtureRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      } catch (cleanupError) {
        console.error("Background survival fixture retained: cleanup could not prove it is safe to remove", cleanupError);
        if (testError === undefined) throw cleanupError;
      }
    }
  }, 35_000);
});

describe("background result reports where the output went", () => {
  // Same-process, fast complement to the cross-process test above: exercises
  // the shape of the result without paying for a second OS process.
  it("backgroundLogs points at real files under the project's .spider scratch area, never /tmp", async () => {
    const fixtureRoot = makeFixture();
    let job: ExecResult | undefined;
    const releasePath = join(fixtureRoot, "release-logs-test");
    try {
      const exec = new PolyglotExecutor({ projectRoot: () => fixtureRoot });
      const r = await exec.execute({
        language: "shell",
        code: `echo start; while [ ! -f ${JSON.stringify(releasePath)} ]; do sleep 0.05; done; echo end`,
        background: true,
        timeout: 120,
      });

      job = r;
      expect(r.backgrounded).toBe(true);
      expect(r.backgroundLogs).toBeTruthy();
      const scratchRoot = paths.scratch("project", fixtureRoot);
      expect(r.backgroundLogs!.stdout.startsWith(scratchRoot)).toBe(true);
      expect(r.backgroundLogs!.stdout.includes("/tmp/")).toBe(false);
      await waitFor(
        () => readFileSync(r.backgroundLogs!.stdout, "utf-8").includes("start"),
        "first redirected log write",
      );
    } finally {
      writeFileSync(releasePath, "go");
      if (job?.backgroundJob) await waitForJob(job);
      rmSync(fixtureRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 25_000);

  it("also reports the pid of the detached process, so a caller who wants to manage it explicitly can", async () => {
    const fixtureRoot = makeFixture();
    let job: ExecResult | undefined;
    const releasePath = join(fixtureRoot, "release-pid-test");
    try {
      const exec = new PolyglotExecutor({ projectRoot: () => fixtureRoot });
      const r = await exec.execute({
        language: "shell",
        code: `echo READY; while [ ! -f ${JSON.stringify(releasePath)} ]; do sleep 0.05; done; echo done`,
        background: true,
        timeout: 80,
      });
      job = r;
      expect(r.backgrounded).toBe(true);
      expect(typeof r.pid).toBe("number");
      expect(isAlive(r.pid!)).toBe(true);
    } finally {
      writeFileSync(releasePath, "go");
      if (job?.backgroundJob) await waitForJob(job);
      rmSync(fixtureRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 25_000);
});

describe("background:true does not change behaviour when the process finishes before the timeout", () => {
  it("returns a normal, non-backgrounded result with no backgroundLogs when the command finishes quickly", async () => {
    const fixtureRoot = makeFixture();
    try {
      const exec = new PolyglotExecutor({ projectRoot: () => fixtureRoot });
      const r = await exec.execute({
        language: "shell",
        code: "echo quick",
        background: true,
        timeout: 5000,
      });
      expect(r.stdout).toContain("quick");
      expect(r.exitCode).toBe(0);
      expect(r.backgrounded).toBeFalsy();
      expect(r.backgroundLogs).toBeUndefined();
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
});

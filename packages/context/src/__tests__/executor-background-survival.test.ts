import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { paths } from "@spider/db-core";
import { PolyglotExecutor } from "../executor";

const __dirname = dirname(fileURLToPath(import.meta.url));

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
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
    const scratchRoot = paths.scratch("project", process.cwd());
    const workDir = mkdtempSync(join(scratchRoot, ".bgtest-"));
    let nestedTmpDir: string | undefined;

    try {
      const harnessPath = await buildHarness(workDir);
      const handoffPath = join(workDir, "handoff.json");

      const TOTAL_TICKS = 20;
      const TICK_MS = 150; // ~3s of total grandchild runtime
      const shellCode = [
        `echo "PID:$$"`,
        `i=1`,
        `while [ $i -le ${TOTAL_TICKS} ]; do`,
        `  echo "TICK $i"`,
        `  sleep ${TICK_MS / 1000}`,
        `  i=$((i+1))`,
        `done`,
        `echo DONE`,
      ].join("\n");

      // The harness backgrounds after 200ms then exits immediately — the
      // grandchild has ~2.8s of scripted work left at that point.
      const BACKGROUND_AFTER_MS = 200;

      const launcherStart = Date.now();
      execFileSync(
        process.execPath,
        [harnessPath, process.cwd(), shellCode, String(BACKGROUND_AFTER_MS), handoffPath],
        { encoding: "utf-8", timeout: 10_000 },
      );
      const launcherElapsed = Date.now() - launcherStart;
      // Sanity check this test actually exercises the early-return path, not a
      // launcher that happened to wait out the whole 3s command.
      expect(launcherElapsed).toBeLessThan(2000);

      const handoff = JSON.parse(readFileSync(handoffPath, "utf-8"));
      expect(handoff.backgrounded).toBe(true);
      expect(handoff.timedOut).toBe(true);
      expect(handoff.backgroundLogs?.stdout).toBeTruthy();

      const logPath = handoff.backgroundLogs.stdout as string;
      nestedTmpDir = dirname(logPath);

      // The launching process (the harness) is now COMPLETELY gone — execFileSync
      // only returns once it has exited. Everything from here on is observing
      // what the grandchild does with no launcher alive at all.
      const soonAfterLauncherDeath = readFileSync(logPath, "utf-8");
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
      const deadline = Date.now() + 8000;
      let finalContent = "";
      while (Date.now() < deadline) {
        finalContent = readFileSync(logPath, "utf-8");
        if (finalContent.includes("DONE")) break;
        await sleep(150);
      }

      expect(finalContent).toContain(`TICK ${TOTAL_TICKS}`);
      expect(finalContent).toContain("DONE");

      // The grandchild finishes its script and exits on its own — confirm it's
      // not left running forever (good hygiene, not the point of the test).
      const diedOnItsOwn = await (async () => {
        const d = Date.now() + 2000;
        while (Date.now() < d) {
          if (!isAlive(grandchildPid)) return true;
          await sleep(50);
        }
        return !isAlive(grandchildPid);
      })();
      expect(diedOnItsOwn).toBe(true);
    } finally {
      if (nestedTmpDir) rmSync(nestedTmpDir, { recursive: true, force: true });
      rmSync(workDir, { recursive: true, force: true });
    }
  }, 20_000);
});

describe("background result reports where the output went", () => {
  // Same-process, fast complement to the cross-process test above: exercises
  // the shape of the result without paying for a second OS process.
  it("backgroundLogs points at real files under the project's .spider scratch area, never /tmp", async () => {
    const exec = new PolyglotExecutor({ projectRoot: () => process.cwd() });
    const r = await exec.execute({
      language: "shell",
      code: `echo start; i=0; while [ $i -lt 6 ]; do echo "n$i"; sleep 0.1; i=$((i+1)); done; echo end`,
      background: true,
      timeout: 120,
    });

    expect(r.backgrounded).toBe(true);
    expect(r.backgroundLogs).toBeTruthy();
    const scratchRoot = paths.scratch("project", process.cwd());
    expect(r.backgroundLogs!.stdout.startsWith(scratchRoot)).toBe(true);
    expect(r.backgroundLogs!.stdout.includes("/tmp/")).toBe(false);
    expect(readFileSync(r.backgroundLogs!.stdout, "utf-8")).toContain("start");

    // let the short-lived grandchild finish on its own before the test exits
    await sleep(900);
  }, 10_000);

  it("also reports the pid of the detached process, so a caller who wants to manage it explicitly can", async () => {
    const exec = new PolyglotExecutor({ projectRoot: () => process.cwd() });
    const r = await exec.execute({
      language: "shell",
      code: `sleep 0.6; echo done`,
      background: true,
      timeout: 80,
    });
    expect(r.backgrounded).toBe(true);
    expect(typeof r.pid).toBe("number");
    expect(isAlive(r.pid!)).toBe(true);
    await sleep(900);
  }, 10_000);
});

describe("background:true does not change behaviour when the process finishes before the timeout", () => {
  it("returns a normal, non-backgrounded result with no backgroundLogs when the command finishes quickly", async () => {
    const exec = new PolyglotExecutor({ projectRoot: () => process.cwd() });
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
  });
});

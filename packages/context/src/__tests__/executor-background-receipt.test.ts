import { describe, it, expect } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync, readdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { paths } from "@spider/db-core";
import { PolyglotExecutor } from "../executor";
import { readManifestSafe } from "../background-job";
import type { BackgroundReceipt } from "../background-job";

const __dirname = dirname(fileURLToPath(import.meta.url));

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

async function waitForFile(path: string, deadlineMs: number): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${path}`);
}

/** Reuses the existing cross-process harness (background-harness-entry.ts, bundled
 *  with esbuild) READ-ONLY — the same one executor-background-survival.test.ts
 *  already uses. It runs a SEPARATE `node` process that backgrounds a command and
 *  then exits completely, writing the exec result to `handoffPath`. */
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
    alias: { "@spider/db-core": join(__dirname, "../../../db-core/src/paths.ts") },
  });
  return outfile;
}

describe("background receipt — the eventual, honest exit truth (I3)", () => {
  it("exposes exitCode:null at handoff, then the TRUE nonzero exit code via the receipt — after the launching process has completely exited", async () => {
    const scratchRoot = paths.scratch("project", process.cwd());
    mkdirSync(scratchRoot, { recursive: true }); // M-f: paths.scratch never creates anything
    const workDir = mkdtempSync(join(scratchRoot, ".bgreceipt-"));
    try {
      const harnessPath = await buildHarness(workDir);
      const handoffPath = join(workDir, "handoff.json");

      // The command finishes ~1.3s AFTER the harness has backgrounded it and exited
      // (harness detaches at 150ms). A default-zero implementation cannot produce a
      // real "3" here — this specifically is not producible by any "assume success"
      // shortcut.
      execFileSync(
        process.execPath,
        [harnessPath, process.cwd(), "sleep 1.2; echo BYE; exit 3", "150", handoffPath],
        { encoding: "utf-8", timeout: 15_000 },
      );

      const r = JSON.parse(readFileSync(handoffPath, "utf-8"));
      // Launch is not success: a timed handoff must never fabricate exit 0.
      expect(r.backgrounded).toBe(true);
      expect(r.exitCode).toBeNull();
      expect(r.backgroundJob).toBeTruthy();
      expect(typeof r.backgroundJob.receipt).toBe("string");
      expect(typeof r.backgroundJob.dir).toBe("string");
      expect(typeof r.backgroundJob.id).toBe("string");

      // The launching harness process is now COMPLETELY gone (execFileSync only
      // returns once it exited). Everything below observes what an independent
      // supervisor did with no launcher alive at all.
      await waitForFile(r.backgroundJob.receipt, 8000);
      const receipt = JSON.parse(readFileSync(r.backgroundJob.receipt, "utf-8")) as BackgroundReceipt;
      expect(receipt.state).toBe("exited");
      expect(receipt.exitCode).toBe(3); // not 0, not 1 — the actual code
      expect(receipt.signal).toBeNull();
      expect(readFileSync(r.backgroundLogs.stdout, "utf-8")).toContain("BYE");
    } finally {
      // The harness ran with process.cwd() as its projectRoot, so the job directory
      // itself landed under the REAL project's `.spider/scratch/bg/<id>` (not under
      // `workDir`) — both must be removed, or this test leaves residue behind.
      const handoffPath2 = join(workDir, "handoff.json");
      if (existsSync(handoffPath2)) {
        try {
          const handoff = JSON.parse(readFileSync(handoffPath2, "utf-8"));
          if (handoff?.backgroundJob?.dir) rmSync(handoff.backgroundJob.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        } catch { /* best-effort test cleanup */ }
      }
      rmSync(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 20_000);

  it("SIGTERM to the real command (not the supervisor) is preserved as an honest signal, never mapped to a fake exit code", async () => {
    const exec = new PolyglotExecutor({ projectRoot: () => process.cwd() });
    const r = await exec.execute({
      language: "shell", code: "sleep 30", background: true, timeout: 150,
    });
    expect(r.backgrounded).toBe(true);
    try {
      let childPid: number | undefined;
      const deadline = Date.now() + 4000;
      while (Date.now() < deadline && !childPid) {
        childPid = readManifestSafe(r.backgroundJob!.manifest)?.childPid;
        if (!childPid) await sleep(50);
      }
      expect(typeof childPid).toBe("number");
      process.kill(childPid!, "SIGTERM");

      await waitForFile(r.backgroundJob!.receipt, 8000);
      const receipt = JSON.parse(readFileSync(r.backgroundJob!.receipt, "utf-8")) as BackgroundReceipt;
      expect(receipt.state).toBe("exited");
      expect(receipt.exitCode).toBeNull();
      expect(receipt.signal).toBe("SIGTERM");
      // `r` itself resolved at the earlier TIMEOUT HANDOFF (before this signal was
      // even sent), so it correctly reports "timeout", not "signal" — the
      // structured discriminator for THIS eventual signal death lives only in the
      // receipt file read above; see executor-streaming-integrity.test.ts and
      // exec-terminal-integrity.test.ts for the `outcome === "signal"` case
      // observed directly on a settled ExecResult (no timeout handoff involved).
    } finally {
      rmSync(r.backgroundJob!.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 15_000);

  it("a whole-group SIGKILL leaves NO receipt — absence is reported as unknown, never fabricated success", async () => {
    const exec = new PolyglotExecutor({ projectRoot: () => process.cwd() });
    const r = await exec.execute({
      language: "shell", code: "sleep 30", background: true, timeout: 150,
    });
    expect(r.backgrounded).toBe(true);
    try {
      // r.pid is the SUPERVISOR — the group leader on POSIX. Killing the whole
      // group with SIGKILL (uncatchable) takes the supervisor down before it can
      // write anything.
      expect(typeof r.pid).toBe("number");
      process.kill(-r.pid!, "SIGKILL");
      await sleep(600);
      expect(existsSync(r.backgroundJob!.receipt)).toBe(false);
    } finally {
      rmSync(r.backgroundJob!.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 15_000);

  it("a plain successful background job (no signal) also gets a truthful non-null receipt exit code of 0", async () => {
    const exec = new PolyglotExecutor({ projectRoot: () => process.cwd() });
    const r = await exec.execute({
      language: "shell", code: "sleep 1; echo ok", background: true, timeout: 100,
    });
    expect(r.backgrounded).toBe(true);
    try {
      await waitForFile(r.backgroundJob!.receipt, 6000);
      const receipt = JSON.parse(readFileSync(r.backgroundJob!.receipt, "utf-8")) as BackgroundReceipt;
      expect(receipt.state).toBe("exited");
      expect(receipt.exitCode).toBe(0);
      expect(receipt.signal).toBeNull();
    } finally {
      rmSync(r.backgroundJob!.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 15_000);
});

describe("I3 regression — supervisor dies alone (not the whole group) before it can write a receipt", () => {
  /** Find the pid of the `node <fixtureRoot>/.../supervisor.cjs <jobDir>` process
   *  this test itself just launched, by grepping `ps` for a path unique to this
   *  run's own scratch root. Never touches any process this test did not spawn. */
  async function findOwnSupervisorPid(scratchRoot: string, deadlineMs: number): Promise<number> {
    const deadline = Date.now() + deadlineMs;
    while (Date.now() < deadline) {
      try {
        const out = execFileSync("ps", ["-eo", "pid,command"], { encoding: "utf-8" });
        const line = out
          .split("\n")
          .find((l) => l.includes("supervisor.cjs") && l.includes(scratchRoot) && !l.includes("grep"));
        if (line) {
          const pid = Number(line.trim().split(/\s+/)[0]);
          if (Number.isFinite(pid)) return pid;
        }
      } catch { /* ps transiently unavailable — retry */ }
      await sleep(30);
    }
    throw new Error("this test's own supervisor.cjs process was not found in time");
  }

  it("a SIGKILL of the supervisor ALONE (real command untouched, no timeout set) reports exitCode:null — never a fabricated success/failure, and retains the job directory", async () => {
    const scratchRoot = paths.scratch("project", process.cwd());
    mkdirSync(scratchRoot, { recursive: true }); // M-f: paths.scratch never creates anything
    // Isolated so `ps ... | grep scratchRoot` can only ever match THIS test's own
    // supervisor, never a concurrently-running test file's.
    const root = mkdtempSync(join(scratchRoot, ".bgi3-fixture-"));
    execFileSync("git", ["init", "--quiet"], { cwd: root });
    const fixtureScratch = paths.scratch("project", root);
    try {
      const exec = new PolyglotExecutor({ projectRoot: () => root });
      // No `timeout` at all — the call awaits the real close/error event, exactly
      // the code path (`proc.on("close", ...)`) that used to trust the SUPERVISOR's
      // own raw exit code instead of the receipt.
      const p = exec.execute({
        language: "shell", code: "sleep 4; echo real-command-finished-on-its-own", background: true,
      });
      const supervisorPid = await findOwnSupervisorPid(fixtureScratch, 4000);
      // Kill ONLY the supervisor pid (no leading `-`) — the real `sleep 4` child
      // is left running as an orphan, exactly like a supervisor crash/OOM-kill
      // that does not take its whole group down.
      process.kill(supervisorPid, "SIGKILL");

      const r = await p;
      // The supervisor's own exit here is a SIGKILL (code null) — the old bug
      // mapped that through `exitCode ?? 1` straight to a fabricated `1`
      // ("command failed"), when the real command was never even asked to stop.
      expect(r.exitCode).toBeNull();
      expect(r.aborted).toBeFalsy();
      // C-1: genuinely INDETERMINATE, distinct from a KNOWN signal/spawn-error
      // — never labelled "detached" (that word implies a deliberate, known-still-
      // running handoff, which this is not).
      expect(r.outcome).toBe("unknown");
      // No valid receipt exists — the directory must be retained, not deleted
      // out from under whatever the real command is still doing.
      expect(r.backgroundJob).toBeTruthy();
      expect(existsSync(r.backgroundJob!.dir)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 15_000);

  it("a malformed-but-parseable receipt written to disk (well-formed JSON, wrong shape — not torn) is treated as UNKNOWN by the executor's REAL close path, not merely by a unit-level call to readReceiptSafe", async () => {
    const scratchRoot = paths.scratch("project", process.cwd());
    mkdirSync(scratchRoot, { recursive: true });
    const root = mkdtempSync(join(scratchRoot, ".bgi3-malformed-fixture-"));
    execFileSync("git", ["init", "--quiet"], { cwd: root });
    const fixtureScratch = paths.scratch("project", root);
    try {
      const exec = new PolyglotExecutor({ projectRoot: () => root });
      const p = exec.execute({
        language: "shell", code: "sleep 4; echo real-command-finished-on-its-own", background: true,
      });
      const supervisorPid = await findOwnSupervisorPid(fixtureScratch, 4000);
      // Locate the new `bg/<id>` job dir the supervisor is writing into, then
      // overwrite its (not-yet-existent) receipt with well-formed-JSON-but-
      // wrong-shape content BEFORE killing the supervisor — this reaches
      // `readReceiptSafe`'s rejection path from the REAL close handler, not
      // just a direct unit call.
      const bgRoot = join(fixtureScratch, "bg");
      let jobDir: string | undefined;
      const findDeadline = Date.now() + 4000;
      while (Date.now() < findDeadline && !jobDir) {
        if (existsSync(bgRoot)) {
          const entries = readdirSync(bgRoot);
          if (entries.length > 0) jobDir = join(bgRoot, entries[0]!);
        }
        if (!jobDir) await sleep(30);
      }
      expect(jobDir).toBeTruthy();
      writeFileSync(join(jobDir!, "exit.json"), JSON.stringify({ not: "a receipt", exitCode: "nope" }), "utf-8");
      process.kill(supervisorPid, "SIGKILL");

      const r = await p;
      expect(r.exitCode).toBeNull();
      expect(r.outcome).toBe("unknown");
      expect(r.backgroundJob).toBeTruthy();
      expect(existsSync(r.backgroundJob!.dir)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 15_000);
});

describe("actions/exec.ts — isError distinguishes pending from actual failure", () => {
  it("a handed-off (detached) exec is never reported as an error, even though exitCode is null", async () => {
    const { runExec } = await import("../actions/exec");
    const res = await runExec(
      { action: "exec", language: "shell", code: "sleep 1; echo end", background: true, timeout: 100 },
      { cwd: process.cwd() } as any,
    );
    expect((res.details as any).exitCode).toBeNull();
    expect(res.isError).toBe(false);
    expect(res.text).toMatch(/detached|background|not known yet/i);
    // Wait for the still-running detached job's receipt (real completion) before
    // removing its directory — deleting a live job's dir out from under its
    // supervisor is a test-hygiene race (the supervisor can still be writing new
    // files into it), not something production code ever does. A fixed sleep guess
    // is flaky when other test files' real subprocesses are contending for CPU.
    const jobDir = (res.details as any).backgroundJob.dir;
    const receiptPath = (res.details as any).backgroundJob.receipt;
    await waitForFile(receiptPath, 8000).catch(() => {}); // best-effort; remove either way
    rmSync(jobDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }, 10_000);

  it("I-3: a verified-finished command with retained descendants never claims the call 'returned before the command finished' or that the exit status is 'NOT known yet' — it discloses retention instead, honestly, alongside the REAL exit code", async () => {
    const scratchRoot = paths.scratch("project", process.cwd());
    mkdirSync(scratchRoot, { recursive: true });
    const root = mkdtempSync(join(scratchRoot, ".bgi3-text-fixture-"));
    execFileSync("git", ["init", "--quiet"], { cwd: root });
    try {
      const { runExec } = await import("../actions/exec");
      const res = await runExec(
        {
          action: "exec", language: "shell",
          code: `(i=1; while [ $i -le 15 ]; do sleep 0.1; i=$((i+1)); done) & echo PARENT_DONE; exit 0`,
          background: true,
        },
        { cwd: root } as any,
      );
      const d = res.details as any;
      expect(d.exitCode).toBe(0); // verified, real completion — not unknown
      expect(res.isError).toBe(false);
      // The exact false statements the review reproduced against the pre-fix
      // text must be gone for a case that actually finished with a known exit code:
      expect(res.text).not.toMatch(/returned before the command finished/i);
      expect(res.text).not.toMatch(/NOT known yet/i);
      expect(res.text).not.toMatch(/absent until it exits/i);
      // But retention is still disclosed, not silently dropped:
      expect(res.text).toMatch(/retained/i);
      expect(res.text).toContain(d.backgroundJob.dir);
      await sleep(1800);
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 15_000);
});

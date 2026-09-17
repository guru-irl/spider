import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { paths } from "@spider/db-core";
import { PolyglotExecutor, runExec, runBatch, detectRuntimes } from "@spider/context";
import { renderSpiderResult } from "../render-result";

const theme = { fg: (_t: string, s: string) => s, bold: (s: string) => s, italic: (s: string) => s, bg: (_t: string, s: string) => s };
const mkCtx = (args: any) => ({ args }) as any;
const opts = { expanded: false } as any;

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

function render(details: any, args: any, text = ""): string {
  const result = { content: text ? [{ type: "text", text }] : [], details };
  const c = renderSpiderResult(result, opts, theme, mkCtx(args));
  return c.render(500).join("\n");
}

/** Same isolated-fixture pattern as packages/context's executor-background-*.test.ts. */
function makeFixture(): string {
  const scratchRoot = paths.scratch("project", process.cwd());
  mkdirSync(scratchRoot, { recursive: true });
  const root = mkdtempSync(join(scratchRoot, ".exec-terminal-integrity-fixture-"));
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
  execFileSync("git", ["config", "user.name", "test"], { cwd: root });
  return root;
}

describe("exec terminal-state outcome matrix — through the REAL host mapping + renderer (background-outcome-brief.md)", () => {
  it("real numeric exit 0: ✓, exit 0, no retention/detached wording", async () => {
    const args = { action: "exec", language: "shell", code: "echo hi" };
    const res = await runExec(args, { cwd: process.cwd() } as any);
    const text = render(res.details, args, res.text);
    expect(text).toContain("✓");
    expect(text).toMatch(/exit 0/);
    expect(text).not.toMatch(/detached|retained|unknown/i);
  });

  it("real numeric nonzero exit: ✗, exit 1, a genuine failure never laundered into unknown", async () => {
    const args = { action: "exec", language: "shell", code: "exit 1" };
    const res = await runExec(args, { cwd: process.cwd() } as any);
    const text = render(res.details, args, res.text);
    expect(text).toContain("✗");
    expect(text).toMatch(/exit 1\b/);
    expect(text).not.toMatch(/unknown/i);
  });

  it("C-1: real signal death with a live descendant (PROBE_C2 reproduction) renders as a KNOWN signal outcome, never 'detached'/'exit unknown', and discloses the real job dir path", async () => {
    const root = makeFixture();
    try {
      const args = {
        action: "exec", language: "shell",
        code: `(i=1; while [ $i -le 20 ]; do sleep 0.1; i=$((i+1)); done) & echo BEFORE_SIGNAL; kill -TERM $$`,
        background: true,
      };
      const res = await runExec(args, { cwd: root } as any);
      const d = res.details as any;
      const text = render(d, args, res.text);
      // q-1: assert wording/card properties BEFORE the `outcome` field-presence
      // check below — vitest stops at the first failure, so putting the
      // field-presence check first would mask a real wording regression
      // whenever `outcome` itself is present (this is exactly what happened in
      // this stage's own RED evidence — see background-outcome-review.md q-1).
      expect(text).not.toMatch(/detached/i);
      expect(text).not.toMatch(/exit unknown/i);
      expect(text).toContain("✗"); // a KNOWN signal death remains visibly a failure
      expect(text).toMatch(/signal/i);
      expect(d.outcome).toBe("signal");
      if (d.retained) {
        expect(text).toMatch(/retained/i);
        expect(text).toContain(d.backgroundJob.dir); // real path disclosed, never blank
      }
      await sleep(2500);
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 15_000);

  it("q-3: a signal death + retained (hand-built to match the real shape — see executor-streaming-integrity.test.ts's double-based test for the behavioral proof) discloses the job dir UNCONDITIONALLY, never gated behind `if (d.retained)`", () => {
    const details = {
      stdout: "BEFORE_SIGNAL\n", stderr: "", exitCode: null, timedOut: false,
      outcome: "signal", signal: "SIGTERM",
      retained: true, retainedReason: "process group may still have live members",
      pid: 4242, backgroundJob: {
        id: "20260101T000000Z-bbbbbbbb", dir: "/p/.spider/scratch/bg/20260101T000000Z-bbbbbbbb",
        manifest: "/p/.spider/scratch/bg/20260101T000000Z-bbbbbbbb/job.json",
        receipt: "/p/.spider/scratch/bg/20260101T000000Z-bbbbbbbb/exit.json",
        logs: { stdout: "/p/.../stdout.log", stderr: "/p/.../stderr.log" },
      },
      backgroundLogs: { stdout: "/p/.../stdout.log", stderr: "/p/.../stderr.log" },
    };
    const args = { action: "exec", language: "shell", code: "kill -TERM $$", background: true };
    const text = render(details, args, "");
    expect(text).toContain("✗");
    expect(text).toMatch(/signal/i);
    expect(text).toMatch(/retained/i);
    expect(text).toContain(details.backgroundJob.dir);
    expect(text).not.toMatch(/exit 0/);
    expect(text).not.toMatch(/detached/i);
  });

  it("real timeout handoff: neutral 'detached', exit unknown, real pid/job/receipt paths disclosed (never blank)", async () => {
    const root = makeFixture();
    try {
      const args = {
        action: "exec", language: "shell",
        code: "i=1; while [ $i -le 20 ]; do echo tick; sleep 0.1; i=$((i+1)); done",
        background: true, timeout: 150,
      };
      const res = await runExec(args, { cwd: root } as any);
      const d = res.details as any;
      expect(d.outcome).toBe("timeout");
      const text = render(d, args, res.text);
      expect(text).not.toContain("✓");
      expect(text).not.toContain("✗");
      expect(text).toMatch(/detached/i);
      expect(text).toMatch(/exit unknown/i);
      // m-1: BOTH sinks must word the timeout row's receipt disclosure the SAME
      // way — the model-facing text (actions/exec.ts's `shape()`) already says
      // "receipt: <path>  (recorded outcome when available)" for this row; the
      // UI card previously said "status: <path> (appears when it exits)" instead.
      expect(text).toMatch(/receipt:.*recorded outcome when available/i);
      expect(text).not.toMatch(/appears when it exits/i);
      expect(text).toContain(d.backgroundJob.dir);
      expect(text).toContain(d.backgroundJob.receipt);
      await sleep(2200);
      rmSync(d.backgroundJob.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 15_000);

  it("real supervisor death without a receipt: neutral 'outcome unknown' — NEVER 'detached', NEVER claims the receipt appears when it exits (it may already have, or never will)", async () => {
    const root = makeFixture();
    try {
      const exec = new PolyglotExecutor({ projectRoot: () => root });
      const r = await exec.execute({ language: "shell", code: "sleep 30", background: true, timeout: 150 });
      expect(r.backgrounded).toBe(true);
      process.kill(-r.pid!, "SIGKILL"); // whole-group SIGKILL — supervisor dies before any receipt
      await sleep(600);
      // Re-derive what runExec would have produced for THIS already-resolved
      // result's close-path shape by directly awaiting the close outcome is not
      // possible here (the timeout branch already resolved) — instead exercise
      // the real close-path shape via a fresh, separate real job and kill the
      // SUPERVISOR ALONE with no timeout, mirroring
      // executor-background-receipt.test.ts's "I3 regression" pattern exactly.
      const exec2 = new PolyglotExecutor({ projectRoot: () => root });
      const p = exec2.execute({ language: "shell", code: "sleep 4; echo real-command-finished-on-its-own", background: true });
      const scratch = paths.scratch("project", root);
      let supervisorPid: number | undefined;
      const deadline = Date.now() + 4000;
      while (Date.now() < deadline && !supervisorPid) {
        try {
          const out = execFileSync("ps", ["-eo", "pid,command"], { encoding: "utf-8" });
          const line = out.split("\n").find((l) => l.includes("supervisor.cjs") && l.includes(scratch) && !l.includes("grep"));
          if (line) { const pid = Number(line.trim().split(/\s+/)[0]); if (Number.isFinite(pid)) supervisorPid = pid; }
        } catch { /* ps transiently unavailable — retry */ }
        if (!supervisorPid) await sleep(30);
      }
      expect(typeof supervisorPid).toBe("number");
      process.kill(supervisorPid!, "SIGKILL");
      const r2 = await p;
      expect(r2.exitCode).toBeNull();
      expect(r2.outcome).toBe("unknown");
      const args2 = { action: "exec", language: "shell", code: "sleep 4; echo real-command-finished-on-its-own", background: true };
      const text2 = render(r2, args2, "");
      expect(text2).not.toMatch(/detached/i);
      expect(text2).not.toMatch(/appears when it exits/i);
      expect(text2).toMatch(/unknown/i);
      if (r2.backgroundJob) {
        expect(text2).toContain(r2.backgroundJob.dir);
        rmSync(r2.backgroundJob.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 15_000);

  it("real spawn error (genuine ENOENT, process group provably empty): a visible, real failure — never neutral, never coerced to exit 0", async () => {
    const root = makeFixture();
    try {
      const exec = new PolyglotExecutor({
        projectRoot: () => root,
        runtimes: { ...detectRuntimes(), javascript: "/definitely/does/not/exist/node-xyz" },
      });
      const r = await exec.execute({ language: "javascript", code: "console.log(1)", background: true });
      expect(r.outcome).toBe("spawn-error");
      expect(r.exitCode).toBeNull();
      const args = { action: "exec", language: "javascript", code: "console.log(1)", background: true };
      const text = render(r, args, "");
      expect(text).toContain("✗");
      expect(text).not.toMatch(/exit 0/);
      expect(text).toMatch(/spawn error/i);
      if (r.backgroundJob) rmSync(r.backgroundJob.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 10_000);

  it("abort + process group not provably empty (constructed to match the real executor's ExecResult shape — see executor-streaming-integrity.test.ts's narrow OS-boundary-double test for the behavioral proof that the real code produces exactly this shape): discloses the job dir, never silently drops it", () => {
    const details = {
      stdout: "", stderr: "[aborted]", exitCode: 137, timedOut: false, aborted: true,
      outcome: "aborted", retained: true, retainedReason: "process group may still have live members",
      pid: 4242, backgroundJob: {
        id: "20260101T000000Z-aaaaaaaa", dir: "/p/.spider/scratch/bg/20260101T000000Z-aaaaaaaa",
        manifest: "/p/.spider/scratch/bg/20260101T000000Z-aaaaaaaa/job.json",
        receipt: "/p/.spider/scratch/bg/20260101T000000Z-aaaaaaaa/exit.json",
        logs: { stdout: "/p/.../stdout.log", stderr: "/p/.../stderr.log" },
      },
      backgroundLogs: { stdout: "/p/.../stdout.log", stderr: "/p/.../stderr.log" },
    };
    const args = { action: "exec", language: "shell", code: "sleep 5", background: true };
    const text = render(details, args, "");
    expect(text).toContain("✗");
    expect(text).toMatch(/aborted/i);
    expect(text).toContain(details.backgroundJob.dir);
    expect(text).not.toMatch(/exit 0/);
  });

  it("M-a: a genuinely handle-less unknown single result renders neutrally with NO blank path lines", () => {
    const details = { stdout: "", stderr: "", exitCode: null, timedOut: false };
    const args = { action: "exec", language: "shell", code: "/no/such/binary" };
    const text = render(details, args, "");
    expect(text).not.toContain("✓");
    expect(text).not.toMatch(/exit 0/);
    // No blank placeholder path lines ("logs: " or "status: " with nothing
    // meaningful after them) when there is no handle to disclose at all.
    expect(text).not.toMatch(/logs:\s*$/m);
    expect(text).not.toMatch(/status:\s*\(/);
  });

  describe("batch matrix", () => {
    const batchArgs = { action: "batch", commands: [{ code: "a" }, { code: "b" }] };
    it("all success", () => {
      const text = render([{ stdout: "a", exitCode: 0 }, { stdout: "b", exitCode: 0 }], batchArgs, "");
      expect(text).toContain("✓");
      expect(text).toMatch(/exit 0/);
    });
    it("known failure", () => {
      const text = render([{ stdout: "a", exitCode: 0 }, { stdout: "", exitCode: 1 }], batchArgs, "");
      expect(text).toContain("✗");
      expect(text).toMatch(/exit 1\b/);
      expect(text).not.toMatch(/unknown/i);
    });
    it("unknown only — neutral, never a fabricated ✗ or exit 0", () => {
      const text = render([{ stdout: "a", exitCode: 0 }, { stdout: "", exitCode: null }], batchArgs, "");
      expect(text).not.toContain("✗");
      expect(text).toMatch(/unknown/i);
    });
    it("mixed failure + unknown — discloses BOTH facts, never silently laundered into aggregate exit 1 alone", () => {
      const text = render(
        [{ stdout: "a", exitCode: 0 }, { stdout: "", exitCode: 1 }, { stdout: "", exitCode: null }],
        batchArgs, "",
      );
      expect(text).toMatch(/exit 1\b/);
      expect(text).toMatch(/unknown/i);
    });
    it("empty batch — neutral/no-results, never the self-contradictory '✗ exit 0'", () => {
      const text = render([], { action: "batch", commands: [] }, "");
      expect(text).not.toMatch(/✗.*exit 0/);
      const hasFalseFailZero = /✗/.test(text) && /exit 0/.test(text);
      expect(hasFalseFailZero).toBe(false);
      // m-4: an empty batch is "no commands", not the generic "exit unknown"
      // wording used for a genuinely indeterminate single result.
      expect(text).toMatch(/no commands/i);
      expect(text).not.toMatch(/exit unknown/i);
    });

    // F-1: through the REAL runBatch and the REAL renderer (background-closure-review.md's
    // T7 is the working repro this is adapted from). `toExecDetails`'s batch branch used to
    // aggregate on `exitCode` alone: a foreground signal death (I-1 gave it `exitCode: null`,
    // never a fabricated number) fell into `anyUnknown` and the card rendered a neutral
    // "● exit unknown" with no ✗ and no signal named — laundering a KNOWN failure into an
    // unknown one. This must render as a real, visible failure that names the signal.
    it("F-1: a real batch entry that dies by signal is a KNOWN failure — never laundered into 'exit unknown', the signal is named", async () => {
      const root = makeFixture();
      try {
        const args = {
          action: "batch",
          commands: [
            { language: "shell", code: "echo one" },
            { language: "shell", code: "sleep 5", timeout: 300 },
          ],
        };
        const res = await runBatch(args as any, { cwd: root } as any);
        // The model-facing sink is already correct and must not change.
        expect(res.isError).toBe(true);
        const entries = res.details as any[];
        expect(entries[1]!.outcome).toBe("signal");
        expect(entries[1]!.exitCode).toBeNull();
        const text = render(res.details, args, res.text);
        expect(text).toContain("✗");
        expect(text).toMatch(/signal/i);
        expect(text).not.toMatch(/exit unknown/i);
      } finally {
        rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    }, 15_000);

    it("F-1 control: a genuinely unknown batch entry (outcome:'unknown', no signal/spawn-error) stays unknown, never becomes a fabricated failure", () => {
      const text = render(
        [{ stdout: "a", exitCode: 0, outcome: "exited" }, { stdout: "", exitCode: null, outcome: "unknown" }],
        batchArgs, "",
      );
      expect(text).not.toContain("✗");
      expect(text).toMatch(/unknown/i);
    });

    it("F-1 mixed: a real signal-death entry PLUS a genuinely-unknown entry in the same batch disclose BOTH facts — never collapsed to one", async () => {
      const root = makeFixture();
      try {
        const args = {
          action: "batch",
          commands: [
            { language: "shell", code: "echo one" },
            { language: "shell", code: "sleep 5", timeout: 300 },
          ],
        };
        const res = await runBatch(args as any, { cwd: root } as any);
        const mixed = [...res.details, { stdout: "", stderr: "", exitCode: null, outcome: "unknown" }];
        const text = render(mixed, args, "");
        expect(text).toContain("✗");
        expect(text).toMatch(/signal/i);
        expect(text).toMatch(/unknown/i);
      } finally {
        rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    }, 15_000);
  });
});

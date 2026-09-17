import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  newJobId,
  backgroundJobPaths,
  jobRef,
  writeManifest,
  readManifestSafe,
  readReceiptSafe,
  deriveTrueExit,
  BACKGROUND_SUPERVISOR_SOURCE,
  type BackgroundReceipt,
} from "../background-job";

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

async function waitForFile(path: string, deadlineMs: number): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    await sleep(20);
  }
  throw new Error(`timed out waiting for ${path}`);
}

describe("newJobId — pure id generation", () => {
  it("is UTC-compact-timestamp + '-' + 8 lowercase hex chars", () => {
    const id = newJobId(new Date("2026-09-16T11:20:55.102Z"));
    expect(id).toMatch(/^20260916T112055Z-[0-9a-f]{8}$/);
  });

  it("two calls never collide", () => {
    const ids = new Set(Array.from({ length: 200 }, () => newJobId()));
    expect(ids.size).toBe(200);
  });
});

describe("backgroundJobPaths — pure path derivation", () => {
  it("derives every path under <scratchBase>/bg/<id>, never touching the filesystem", () => {
    const p = backgroundJobPaths("/p/.spider/scratch", "JOBID");
    expect(p.dir).toBe("/p/.spider/scratch/bg/JOBID");
    expect(p.tmpDir).toBe("/p/.spider/scratch/bg/JOBID/tmp");
    expect(p.manifest).toBe("/p/.spider/scratch/bg/JOBID/job.json");
    expect(p.receipt).toBe("/p/.spider/scratch/bg/JOBID/exit.json");
    expect(p.stdout).toBe("/p/.spider/scratch/bg/JOBID/stdout.log");
    expect(p.stderr).toBe("/p/.spider/scratch/bg/JOBID/stderr.log");
    expect(p.supervisorScript).toBe("/p/.spider/scratch/bg/JOBID/supervisor.cjs");
  });

  it("jobRef() exposes only the public handle fields (no supervisorScript/tmpDir)", () => {
    const p = backgroundJobPaths("/p/.spider/scratch", "JOBID");
    const ref = jobRef(p);
    expect(ref).toEqual({
      id: "JOBID", dir: p.dir, manifest: p.manifest, receipt: p.receipt,
      logs: { stdout: p.stdout, stderr: p.stderr },
    });
    expect((ref as any).supervisorScript).toBeUndefined();
  });
});

describe("readManifestSafe — best-effort manifest read", () => {
  it("returns undefined (never throws) when the file does not exist", () => {
    expect(readManifestSafe("/does/not/exist/job.json")).toBeUndefined();
  });

  it("returns the parsed manifest when it does exist", () => {
    const dir = mkdtempSync(join(tmpdir(), "bgjob-manifest-"));
    try {
      const p = join(dir, "job.json");
      writeManifest(p, { schema: 1, id: "x", cwd: dir, argv: ["echo", "hi"], windowsHide: false, startedAt: "t" });
      const m = readManifestSafe(p);
      expect(m?.id).toBe("x");
      expect(m?.argv).toEqual(["echo", "hi"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Manifest IO, tested directly on disk (real fs, no mock) so this test
  // discriminates `writeManifest` itself — independent of whatever
  // `readManifestSafe` happens to do (C-1: the benign-stub redo needs at least
  // one manifest-IO assertion that does not route through the paired read helper).
  it("writeManifest's atomic write leaves the exact JSON on disk and no leftover .tmp file (M2)", () => {
    const dir = mkdtempSync(join(tmpdir(), "bgjob-manifest-atomic-"));
    try {
      const p = join(dir, "job.json");
      const manifest = { schema: 1, id: "atomic-x", cwd: dir, argv: ["echo", "hi"], windowsHide: false, startedAt: "t" };
      writeManifest(p, manifest);
      const raw = JSON.parse(readFileSync(p, "utf-8"));
      expect(raw).toEqual(manifest);
      const leftovers = require("node:fs").readdirSync(dir).filter((n: string) => n.includes(".tmp"));
      expect(leftovers).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("readReceiptSafe — validated read (I-2): malformed-but-parseable JSON must never look like a receipt", () => {
  function fixture(): string {
    return mkdtempSync(join(tmpdir(), "bgjob-receipt-validate-"));
  }

  it("returns the receipt verbatim when it is well-formed", () => {
    const dir = fixture();
    try {
      const p = join(dir, "exit.json");
      const good: BackgroundReceipt = { schema: 1, state: "exited", exitCode: 3, signal: null };
      writeFileSync(p, JSON.stringify(good), "utf-8");
      expect(readReceiptSafe(p)).toEqual(good);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns undefined when the file is genuinely absent", () => {
    expect(readReceiptSafe("/does/not/exist/exit.json")).toBeUndefined();
  });

  it("returns undefined for a torn/unparseable write, same as absence", () => {
    const dir = fixture();
    try {
      const p = join(dir, "exit.json");
      writeFileSync(p, '{"schema":1,"state":"exi', "utf-8"); // torn mid-write
      expect(readReceiptSafe(p)).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  const malformed: Array<[string, string]> = [
    ["an empty object", "{}"],
    ["an empty array", "[]"],
    ["a bare string", '"ok"'],
    ["a bare number", "3"],
    ["a JSON null", "null"],
    ["an invalid state", JSON.stringify({ schema: 1, state: "done", exitCode: 0, signal: null })],
    ["exitCode as a string", JSON.stringify({ schema: 1, state: "exited", exitCode: "0", signal: null })],
    ["signal as a number", JSON.stringify({ schema: 1, state: "exited", exitCode: null, signal: 9 })],
    ["missing state entirely", JSON.stringify({ schema: 1, exitCode: 0, signal: null })],
    // I-4: schema validation — a receipt from a future/unknown schema version
    // must never be trusted as if it were schema 1 (a later version could add
    // fields, or change what exitCode/signal mean, in ways this reader has
    // never seen).
    ["missing schema entirely", JSON.stringify({ state: "exited", exitCode: 0, signal: null })],
    ["schema 0", JSON.stringify({ schema: 0, state: "exited", exitCode: 0, signal: null })],
    ["schema 2 (a hypothetical future version)", JSON.stringify({ schema: 2, state: "exited", exitCode: 0, signal: null })],
    ["schema as a string", JSON.stringify({ schema: "1", state: "exited", exitCode: 0, signal: null })],
    // I-4: state-specific exit/signal consistency — a spawn-error NEVER carries
    // a real numeric exitCode (PROBE_H1: the command never started, so there is
    // nothing for a number to describe) or a named signal (nothing ran to be
    // signalled).
    ["spawn-error with a numeric exitCode (PROBE_H1)", JSON.stringify({ schema: 1, state: "spawn-error", exitCode: 0, signal: null, error: "ENOENT" })],
    ["spawn-error with a non-null signal", JSON.stringify({ schema: 1, state: "spawn-error", exitCode: null, signal: "SIGTERM", error: "ENOENT" })],
    // I-4: an "exited" receipt can never carry BOTH a real numeric exitCode AND
    // a signal name at once — a settled command either exited with a code, or
    // died by a signal, never both.
    ["exited with both a numeric exitCode and a signal", JSON.stringify({ schema: 1, state: "exited", exitCode: 0, signal: "SIGTERM" })],
  ];
  for (const [label, raw] of malformed) {
    it(`rejects ${label} as UNKNOWN, never as a numeric-looking success (returns undefined, not the raw parsed value)`, () => {
      const dir = fixture();
      try {
        const p = join(dir, "exit.json");
        writeFileSync(p, raw, "utf-8");
        expect(readReceiptSafe(p)).toBeUndefined();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});

describe("deriveTrueExit — the executor's close path can never resolve exitCode:undefined (I-2)", () => {
  it("a numeric exit with no signal returns that number", () => {
    expect(deriveTrueExit({ schema: 1, state: "exited", exitCode: 3, signal: null })).toBe(3);
  });
  it("a signal death returns null, never the numeric field even if one happens to be present", () => {
    expect(deriveTrueExit({ schema: 1, state: "exited", exitCode: 0, signal: "SIGTERM" })).toBeNull();
  });
  it("returns null, never undefined, when exitCode is not a clean number", () => {
    expect(deriveTrueExit({ schema: 1, state: "exited", exitCode: undefined as unknown as null, signal: null })).toBeNull();
  });
});

/**
 * The supervisor source is a plain CJS string emitted to disk at launch (never a
 * shipped package file — the distributed artifact is a single bundled
 * dist/extension.js). These tests run it as a REAL separate `node` process against
 * a real manifest, independent of executor.ts, to prove the receipt/signal/pid
 * mechanism itself is correct before executor.ts is wired to use it.
 */
describe("BACKGROUND_SUPERVISOR_SOURCE — the emitted supervisor process", () => {
  function fixture(): string {
    return mkdtempSync(join(tmpdir(), "bgjob-supervisor-"));
  }

  it("runs the real command via argv, mirrors its exit code, and writes an honest receipt", async () => {
    const dir = fixture();
    try {
      const supervisorPath = join(dir, "supervisor.cjs");
      writeFileSync(supervisorPath, BACKGROUND_SUPERVISOR_SOURCE, "utf-8");
      writeManifest(join(dir, "job.json"), {
        schema: 1, id: "x", cwd: dir,
        argv: ["/bin/sh", "-c", "echo OUT_TEXT; echo ERR_TEXT 1>&2; exit 3"],
        windowsHide: false, startedAt: new Date().toISOString(),
      });

      const outChunks: Buffer[] = [];
      const errChunks: Buffer[] = [];
      const supervisor = spawn(process.execPath, [supervisorPath, dir], { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
      supervisor.stdout!.on("data", (c) => outChunks.push(c));
      supervisor.stderr!.on("data", (c) => errChunks.push(c));

      const supervisorExitCode: number | null = await new Promise((resolve) => {
        supervisor.on("close", (code) => resolve(code));
      });

      // The supervisor mirrors the real command's exit code as ITS OWN — not a
      // default-zero. This is what lets killTree (which kills the supervisor's
      // whole process group) look, from the executor's `close` handler, exactly
      // like killing the real command would have.
      expect(supervisorExitCode).toBe(3);
      expect(Buffer.concat(outChunks).toString("utf-8")).toContain("OUT_TEXT");
      expect(Buffer.concat(errChunks).toString("utf-8")).toContain("ERR_TEXT");

      const receipt = JSON.parse(readFileSync(join(dir, "exit.json"), "utf-8")) as BackgroundReceipt;
      expect(receipt.state).toBe("exited");
      expect(receipt.exitCode).toBe(3);
      expect(receipt.signal).toBeNull();
      expect(typeof receipt.childPid).toBe("number");
      expect(typeof receipt.supervisorPid).toBe("number");
      expect(receipt.supervisorPid).toBe(supervisor.pid);

      const manifest = readManifestSafe(join(dir, "job.json"));
      expect(manifest?.childPid).toBe(receipt.childPid);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 10_000);

  it("mirrors a SIGTERM'd real command honestly — signal preserved, exitCode null, never a fabricated success", async () => {
    const dir = fixture();
    try {
      const supervisorPath = join(dir, "supervisor.cjs");
      writeFileSync(supervisorPath, BACKGROUND_SUPERVISOR_SOURCE, "utf-8");
      writeManifest(join(dir, "job.json"), {
        schema: 1, id: "x", cwd: dir, argv: ["sleep", "30"], windowsHide: false,
        startedAt: new Date().toISOString(),
      });
      const supervisor = spawn(process.execPath, [supervisorPath, dir], { cwd: dir, stdio: "ignore" });

      // Poll the manifest for the childPid the supervisor records, then signal
      // ONLY the real command (not the supervisor) — proves signal deaths are
      // observed and reported, not conflated with the supervisor's own fate.
      let childPid: number | undefined;
      const deadline = Date.now() + 4000;
      while (Date.now() < deadline && !childPid) {
        childPid = readManifestSafe(join(dir, "job.json"))?.childPid;
        if (!childPid) await sleep(20);
      }
      expect(typeof childPid).toBe("number");
      process.kill(childPid!, "SIGTERM");

      const supervisorExitCode: number | null = await new Promise((resolve) => {
        supervisor.on("close", (code) => resolve(code));
      });
      // 128 + SIGTERM(15) = 143 — the actual signal, not a hardcoded 128+9 (SIGKILL).
      expect(supervisorExitCode).toBe(143);

      const receipt = JSON.parse(readFileSync(join(dir, "exit.json"), "utf-8")) as BackgroundReceipt;
      expect(receipt.state).toBe("exited");
      expect(receipt.exitCode).toBeNull();
      expect(receipt.signal).toBe("SIGTERM");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 10_000);

  it("a whole-group SIGKILL of the supervisor itself leaves no receipt at all — never a fabricated success", async () => {
    const dir = fixture();
    try {
      const supervisorPath = join(dir, "supervisor.cjs");
      writeFileSync(supervisorPath, BACKGROUND_SUPERVISOR_SOURCE, "utf-8");
      writeManifest(join(dir, "job.json"), {
        schema: 1, id: "x", cwd: dir, argv: ["sleep", "30"], windowsHide: false,
        startedAt: new Date().toISOString(),
      });
      const supervisor = spawn(process.execPath, [supervisorPath, dir], {
        cwd: dir, stdio: "ignore", detached: true,
      });
      await sleep(150); // let it actually spawn the child before killing the group
      process.kill(-supervisor.pid!, "SIGKILL"); // whole group — SIGKILL is uncatchable
      await new Promise((resolve) => supervisor.on("close", resolve));
      await sleep(200); // give a (buggy) implementation every chance to still write something
      expect(existsSync(join(dir, "exit.json"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 10_000);

  it("a command that never starts (bad binary) yields state:spawn-error, never a successful receipt", async () => {
    const dir = fixture();
    try {
      const supervisorPath = join(dir, "supervisor.cjs");
      writeFileSync(supervisorPath, BACKGROUND_SUPERVISOR_SOURCE, "utf-8");
      writeManifest(join(dir, "job.json"), {
        schema: 1, id: "x", cwd: dir, argv: ["/no/such/binary-xyz-123"], windowsHide: false,
        startedAt: new Date().toISOString(),
      });
      const supervisor = spawn(process.execPath, [supervisorPath, dir], { cwd: dir, stdio: "ignore" });
      await new Promise((resolve) => supervisor.on("close", resolve));
      await waitForFile(join(dir, "exit.json"), 4000);
      const receipt = JSON.parse(readFileSync(join(dir, "exit.json"), "utf-8")) as BackgroundReceipt;
      expect(receipt.state).toBe("spawn-error");
      expect(receipt.exitCode).toBeNull();
      expect(typeof receipt.error).toBe("string");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 10_000);
});

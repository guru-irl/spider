/**
 * background-job.ts — job ids, path derivation, manifest/receipt IO, and the
 * durable supervisor process for `exec { background: true }`.
 *
 * Rebuilt tests-first (see background-fix-brief.md / background-report.md for the
 * chronology): the pure helpers below and the emitted supervisor script are both
 * covered by background-job.test.ts running the REAL supervisor as a separate
 * `node` process (no mocks) before executor.ts is wired to any of it.
 *
 * Why a supervisor process at all: a backgrounded child's stdout/stderr are
 * plain file descriptors (see executor.ts), never a pipe to the launching
 * process, so the child survives the launcher exiting. But something still has
 * to observe the child's REAL exit (code vs signal vs "never started") and
 * record it durably — that is this module's supervisor. It is emitted to disk
 * as a plain string (`BACKGROUND_SUPERVISOR_SOURCE`) at launch time, never
 * imported as a shipped sidecar file, because the distributed artifact is a
 * single bundled `dist/extension.js`.
 */

import {
  writeFileSync,
  readFileSync,
  renameSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

export interface BackgroundJobPaths {
  id: string;
  /** `<scratchBase>/bg/<id>` — the stable, caller-owned job directory. */
  dir: string;
  /** The child's own TMPDIR, one level below the job root so it can never
   *  collide with the script file, job.json, or exit.json at the job root. */
  tmpDir: string;
  /** The launch manifest — argv/cwd, written once before the supervisor spawns. */
  manifest: string;
  /** The exit receipt — ABSENT until the real command actually exits. Its
   *  absence is never evidence of success (see readReceiptSafe). */
  receipt: string;
  stdout: string;
  stderr: string;
  /** The supervisor script, emitted fresh to this path at launch time. */
  supervisorScript: string;
}

/** The durable, caller-owned handle returned on `ExecResult.backgroundJob` — a
 *  deliberately narrow view of `BackgroundJobPaths` (no `tmpDir`/`supervisorScript`,
 *  which are launch-time implementation details, not part of the reachable
 *  inspection surface documented in README.md). */
export interface BackgroundJobRef {
  id: string;
  dir: string;
  manifest: string;
  receipt: string;
  logs: { stdout: string; stderr: string };
}

export interface BackgroundManifest {
  schema: number;
  id: string;
  cwd: string;
  /** Present unless `shellCommand` is (Windows .cmd/.bat shim path). */
  argv?: string[];
  /** Present only for the Windows .cmd/.bat shell:true path — see executor.ts's
   *  `needsShell` / `buildFullShellCommand`. */
  shellCommand?: string;
  windowsHide: boolean;
  startedAt: string;
  /** Recorded by the supervisor, once, as soon as it spawns the real command.
   *  Best-effort: may not have landed yet at the exact instant of a timeout
   *  handoff — advisory, never guaranteed. */
  childPid?: number;
}

export interface BackgroundReceipt {
  schema: number;
  /** "exited": the real command ran and settled (successfully, with a nonzero
   *  code, or killed by a signal) — `exitCode`/`signal` distinguish which.
   *  "spawn-error": the real command never even started. */
  state: "exited" | "spawn-error";
  /** The real command's exit code, or `null` when it died by signal or never
   *  started. Never fabricated as `0`. */
  exitCode: number | null;
  /** The signal name (e.g. "SIGTERM") if the command died by signal, else `null`. */
  signal: string | null;
  childPid?: number;
  supervisorPid?: number;
  startedAt?: string;
  endedAt?: string;
  /** Present only when `state === "spawn-error"`. */
  error?: string;
}

/**
 * Sortable, greppable job id: `<UTC-compact-timestamp>Z-<8 lowercase hex>`, e.g.
 * `20260916T112055Z-a1b2c3d4`. Pure — never touches the filesystem. The random
 * suffix (not a counter) is what keeps two calls in the same millisecond from
 * colliding without any shared state between them.
 */
export function newJobId(now: Date = new Date()): string {
  const iso = now.toISOString(); // 2026-09-16T11:20:55.102Z
  const compact = iso.slice(0, 19).replace(/[-:]/g, "") + "Z"; // 20260916T112055Z
  const hex = randomBytes(4).toString("hex"); // 8 lowercase hex chars
  return `${compact}-${hex}`;
}

/**
 * Pure path derivation — every path a backgrounded job needs, all under
 * `<scratchBase>/bg/<id>`. Never touches the filesystem (callers `mkdirSync`
 * as needed); this just computes strings so it can be unit-tested without fs.
 */
export function backgroundJobPaths(scratchBase: string, id: string): BackgroundJobPaths {
  const dir = join(scratchBase, "bg", id);
  return {
    id,
    dir,
    tmpDir: join(dir, "tmp"),
    manifest: join(dir, "job.json"),
    receipt: join(dir, "exit.json"),
    stdout: join(dir, "stdout.log"),
    stderr: join(dir, "stderr.log"),
    supervisorScript: join(dir, "supervisor.cjs"),
  };
}

/** Narrow a `BackgroundJobPaths` down to the public, caller-facing handle —
 *  deliberately excludes `tmpDir`/`supervisorScript` (launch-time internals). */
export function jobRef(paths: BackgroundJobPaths): BackgroundJobRef {
  return {
    id: paths.id,
    dir: paths.dir,
    manifest: paths.manifest,
    receipt: paths.receipt,
    logs: { stdout: paths.stdout, stderr: paths.stderr },
  };
}

/** Atomic write shared by the manifest and (from the emitted supervisor's own
 *  copy of this logic — see BACKGROUND_SUPERVISOR_SOURCE below) the receipt:
 *  write to a pid-scoped tmp file in the same directory, then rename. A rename
 *  within the same directory is atomic on both POSIX and Windows — a reader
 *  either sees the old complete file or the new complete file, never a torn
 *  write (M2: symmetry with the receipt, which was already atomic). */
function atomicWriteJSON(path: string, value: unknown): void {
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, JSON.stringify(value), "utf-8");
  renameSync(tmp, path);
}

/** Write the launch manifest atomically. Called once by executor.ts before the
 *  supervisor is spawned; the supervisor itself may rewrite it exactly once
 *  more (to record `childPid`) using the same atomic-rename pattern embedded in
 *  its own source — there is no writer race because the parent never writes it
 *  again after this call. */
export function writeManifest(path: string, manifest: BackgroundManifest): void {
  atomicWriteJSON(path, manifest);
}

/** Best-effort manifest read — never throws. Returns `undefined` when the file
 *  doesn't exist yet, or can't be parsed (e.g. read mid-write on a platform
 *  without atomic rename support) — absence/corruption is just "not known yet",
 *  never an error a caller has to handle. */
export function readManifestSafe(path: string): BackgroundManifest | undefined {
  try {
    if (!existsSync(path)) return undefined;
    return JSON.parse(readFileSync(path, "utf-8")) as BackgroundManifest;
  } catch {
    return undefined;
  }
}

/**
 * I-2/I-4: a receipt is trusted ONLY when it is well-formed — `JSON.parse` succeeding
 * is not enough. A torn write (caught by the outer try/catch below) is one way a
 * bad receipt can appear; a `{}`/`[]`/wrong-typed-field JSON value that parses
 * cleanly is another, and without this check it would flow straight through as
 * `receipt.exitCode === undefined`, which executor.ts's close handler could then
 * turn into a fabricated numeric-looking result. Never throws, never guesses.
 *
 * I-4: also validates `schema === 1` (the only version this reader has ever
 * understood — a missing/mismatched schema is treated as unknown rather than
 * assumed compatible, since a future schema could repurpose these same field
 * names) and state-specific exit/signal consistency: `spawn-error` never
 * carries a real numeric `exitCode` or a named `signal` (the command never
 * started, so neither has anything to describe — PROBE_H1), and `exited`
 * never carries BOTH a numeric `exitCode` AND a signal name at once (a
 * settled command either exited with a code or died by a signal, never both).
 */
function isWellFormedReceipt(value: unknown): value is BackgroundReceipt {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const r = value as Record<string, unknown>;
  if (r.schema !== 1) return false;
  if (r.state !== "exited" && r.state !== "spawn-error") return false;
  if (r.exitCode !== null && typeof r.exitCode !== "number") return false;
  if (r.signal !== null && typeof r.signal !== "string") return false;
  if (r.state === "spawn-error" && (r.exitCode !== null || r.signal !== null)) return false;
  if (r.state === "exited" && r.exitCode !== null && r.signal !== null) return false;
  return true;
}

/** Best-effort receipt read — never throws. Returns `undefined` when the file
 *  doesn't exist (still running, OR the supervisor died before it could write
 *  one — those two cases are indistinguishable from the receipt's absence
 *  alone; see README.md "The receipt is the only source of truth"), when the
 *  JSON is torn/unparseable, OR (I-2/I-4) when it parses cleanly but is not a
 *  well-formed receipt (`schema === 1`, `state` valid, `exitCode` number|null,
 *  `signal` string|null, and state-specific consistency — see
 *  `isWellFormedReceipt`) — a malformed-but-parseable value must never be
 *  accepted as a real receipt just because `JSON.parse` didn't throw. */
export function readReceiptSafe(path: string): BackgroundReceipt | undefined {
  try {
    if (!existsSync(path)) return undefined;
    const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
    return isWellFormedReceipt(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * I-2: the ONE honest exit-code value executor.ts's close handler ever reports
 * for a settled background command, given an already-validated receipt (see
 * readReceiptSafe) — the real numeric exit code, or `null` for a signal death.
 * Deliberately never returns `undefined`: "unknown" is representable only as
 * `null` here, never as a value that would coerce into a fabricated `0`
 * downstream (see render-result.ts#toExecDetails, which treats an explicit
 * `null` exitCode as genuinely unknown but a merely-ABSENT field as an
 * implicit `0` — those are different contracts, and `undefined` must never be
 * used to accidentally select the wrong one). Pure — no I/O, no throwing.
 */
export function deriveTrueExit(receipt: BackgroundReceipt): number | null {
  if (receipt.signal) return null;
  return typeof receipt.exitCode === "number" ? receipt.exitCode : null;
}

/**
 * Conservative POSIX process-GROUP liveness probe (C1): `kill(pgid, 0)` sends
 * no signal, it only asks the kernel "does this pid/pgid still identify at
 * least one process?". A process group persists as long as ANY member is
 * still alive, even after its original leader has exited — which is exactly
 * what lets this catch a live descendant left behind by something like
 * `(loop) & echo done` after the shell and the supervisor have both exited.
 *
 * Returns (M-a: corrected to match the code below — `null`, not `true`, is what
 * an inconclusive OS answer like EPERM actually returns):
 *  - `true`  — the group definitely still has at least one live member.
 *  - `false` — the group is provably gone (`ESRCH`).
 *  - `null`  — cannot be determined: either this platform has no process-group
 *              liveness probe at all (Windows), or the OS refused to say for
 *              certain (e.g. EPERM against a pid we don't own). Callers MUST
 *              treat `null` exactly like `true` — "can't prove empty" is
 *              conservative and retains, never a false "safe to delete".
 */
export function groupHasLiveMembers(pgid: number): boolean | null {
  if (process.platform === "win32") return null;
  if (!Number.isFinite(pgid) || pgid <= 1) return null;
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ESRCH") return false;
    return null; // EPERM or anything else — can't prove it's empty
  }
}

/**
 * The supervisor: a plain CJS script, emitted fresh to `supervisorScript` at
 * launch time (never a shipped package file). Invoked as
 * `node supervisor.cjs <jobDir>`. It:
 *
 *  1. Reads `<jobDir>/job.json` for `argv`/`shellCommand`/`cwd`/`windowsHide`.
 *  2. Spawns the REAL command with `stdio: "inherit"` — the bytes still land in
 *     the same file descriptions the parent (executor.ts) opened; this process
 *     never re-pipes them. The child gets NO `detached`/new-group option, so it
 *     stays in the supervisor's own process group (the parent already spawned
 *     the supervisor with `detached: true` on POSIX, making it the group leader).
 *  3. Records the real command's pid into `job.json` (one more atomic rewrite,
 *     M2) as soon as it spawns, so a caller with the manifest can signal the
 *     real command specifically (not the whole group) as early as possible.
 *  4. On settle (guarded so `error` then `exit` — or vice versa — can only fire
 *     the receipt write ONCE), writes `exit.json` atomically (tmp + rename) and
 *     then mirrors the real command's fate as ITS OWN exit code: the literal
 *     code for a normal exit, `128 + <actual signal number>` for a signal death
 *     (via `os.constants.signals`, never a hardcoded `128+9`), or a nonzero
 *     sentinel for a spawn error. This is what lets `killTree` — which kills
 *     the whole process GROUP the supervisor leads — look, from executor.ts's
 *     point of view, exactly like killing the real command directly would.
 *
 * A whole-group `SIGKILL` (uncatchable) takes the supervisor down before any of
 * this runs — by design, that leaves NO receipt at all, and README.md/executor.ts
 * both treat a long-absent receipt as unknown, never as success.
 */
export const BACKGROUND_SUPERVISOR_SOURCE: string = `"use strict";
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawn } = require("node:child_process");

const jobDir = process.argv[2];
const manifestPath = path.join(jobDir, "job.json");
const receiptPath = path.join(jobDir, "exit.json");
const startedAt = new Date().toISOString();

function atomicWriteJSON(filePath, value) {
  const tmp = filePath + "." + process.pid + "." + Math.random().toString(16).slice(2) + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(value), "utf-8");
  fs.renameSync(tmp, filePath);
}

function readManifest() {
  return JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
}

function recordChildPid(pid) {
  try {
    const m = readManifest();
    m.childPid = pid;
    atomicWriteJSON(manifestPath, m);
  } catch (e) {
    /* best-effort — a caller reading childPid before this lands treats it as
       "not known yet", never as an error (see readManifestSafe) */
  }
}

let settled = false;
function settle(partial, childForExit) {
  if (settled) return;
  settled = true;
  const receipt = Object.assign(
    { schema: 1, startedAt, endedAt: new Date().toISOString(), childPid: childForExit ? childForExit.pid : undefined, supervisorPid: process.pid },
    partial,
  );
  try {
    atomicWriteJSON(receiptPath, receipt);
  } catch (e) {
    /* best-effort — an unwritable receipt is still honestly reflected by this
       process's own exit code below (never a fabricated success) */
  }
  let code;
  if (receipt.state === "spawn-error") {
    code = 1;
  } else if (receipt.signal) {
    const signum = os.constants.signals[receipt.signal];
    code = 128 + (typeof signum === "number" ? signum : 0);
  } else {
    code = typeof receipt.exitCode === "number" ? receipt.exitCode : 1;
  }
  process.exitCode = code;
  process.exit(code);
}

let manifest;
try {
  manifest = readManifest();
} catch (err) {
  settle({ state: "spawn-error", exitCode: null, signal: null, error: String((err && err.message) || err) });
  throw err;
}

const spawnOpts = {
  cwd: manifest.cwd,
  stdio: "inherit",
  windowsHide: !!manifest.windowsHide,
};

let child;
try {
  if (manifest.shellCommand) {
    child = spawn(manifest.shellCommand, [], Object.assign({}, spawnOpts, { shell: true }));
  } else {
    const argv = manifest.argv || [];
    child = spawn(argv[0], argv.slice(1), spawnOpts);
  }
} catch (err) {
  settle({ state: "spawn-error", exitCode: null, signal: null, error: String((err && err.message) || err) });
  throw err;
}

if (child.pid) recordChildPid(child.pid);

child.on("error", (err) => {
  settle({ state: "spawn-error", exitCode: null, signal: null, error: String((err && err.message) || err) }, child);
});

child.on("exit", (code, signal) => {
  settle({ state: "exited", exitCode: signal ? null : code, signal: signal || null }, child);
});
`;

import { spawn, execSync, execFileSync } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  openSync,
  closeSync,
  readSync,
  readFileSync,
  statSync,
} from "node:fs";
import { join, resolve } from "node:path";
import {
  detectRuntimes,
  buildCommand,
  type RuntimeMap,
  type Language,
} from "./runtime";
import { paths } from "@spider/db-core";
import { tailLogs, type LogTail } from "./log-tail";
import {
  newJobId,
  backgroundJobPaths,
  jobRef,
  writeManifest,
  readManifestSafe,
  readReceiptSafe,
  deriveTrueExit,
  groupHasLiveMembers,
  BACKGROUND_SUPERVISOR_SOURCE,
  type BackgroundJobPaths,
  type BackgroundJobRef,
} from "./background-job";

/**
 * Structured terminal-state discriminator — the SINGLE thing callers (this
 * package's own `actions/exec.ts`, and the host/UI mapping in
 * `packages/host/src/render-result.ts` + `packages/ui/src/renderers/exec.ts`)
 * branch on to decide what to say/show, instead of re-deriving "known vs
 * unknown" from `exitCode === null` alone — which is `null` for THREE
 * different KNOWN situations (`signal`, `spawn-error`, and the genuinely
 * indeterminate `unknown`) plus a fourth, differently-null `timeout` case,
 * that must never be rendered identically:
 *  - "exited": a real numeric exit code was observed (foreground, or a
 *    background receipt with no signal). `exitCode` is that real value.
 *  - "signal": the command was killed by a signal — KNOWN. `exitCode` is
 *    `null`; `signal` names it (e.g. "SIGTERM").
 *  - "spawn-error": the command never started — KNOWN. `exitCode` is `null`.
 *  - "aborted": the caller's AbortSignal fired and killTree ran — KNOWN.
 *    `exitCode` is the `137` sentinel.
 *  - "timeout": deliberately detached at a `timeout` handoff — genuinely
 *    still running, outcome not known YET but WILL be (see
 *    `backgroundJob.receipt`). `exitCode` is `null`.
 *  - "unknown": genuinely indeterminate — e.g. the supervisor died/was
 *    killed before it could write a receipt. Distinct from "timeout": here
 *    it is NOT known whether the real command is even still running, so a
 *    caller must never claim the receipt "appears when it exits" (it may
 *    already have, or never will). `exitCode` is `null`.
 * `retained` (below) is orthogonal to this — see its own JSDoc.
 */
export type ExecOutcome = "exited" | "signal" | "spawn-error" | "aborted" | "timeout" | "unknown";

export interface ExecResult {
  stdout: string; stderr: string;
  /**
   * A real number when `outcome === "exited"` (the ordinary case) OR
   * `outcome === "aborted"` (the `137` sentinel — see `ExecOutcome`'s own
   * JSDoc and `aborted` below). `null` for the four remaining outcomes, and
   * NOT for one reason: `"signal"` and `"spawn-error"` are KNOWN outcomes
   * that simply never had a numeric code to report (see `signal`/`outcome`
   * below); a `"timeout"` handoff or a genuinely indeterminate `"unknown"`
   * supervisor loss have not settled at all (NOT KNOWN YET). Check `outcome`
   * — never `exitCode === null` alone — to tell these apart. A launch is
   * never reported as `0` — that would claim a success that has not happened
   * yet. For the genuinely still-running `"timeout"` case specifically, the
   * eventual truth (once it is knowable) lives in the receipt file at
   * `backgroundJob.receipt`; there is no API in this package that reads it FOR
   * you (see README.md) — read it yourself, or have the model do so with
   * another `exec` call.
   *
   * One last-resort exception to all of the above: if Node's `close` event
   * ever reports NEITHER a numeric code NOR a signal (near-unreachable on
   * POSIX), the foreground path falls back to `exitCode ?? 1` and reports
   * `outcome: "exited"` — i.e. a fabricated `1`, not an observed exit code.
   * See the `exitCode ?? 1` call site in this file for the full rationale.
   */
  exitCode: number | null;
  timedOut: boolean;
  /**
   * Process was detached and continues running in the background — i.e. `timeout`
   * elapsed while it was still running and `background: true` was set. Its
   * stdout/stderr are files on disk (see `backgroundLogs`), never a pipe to this
   * process, so it keeps running — and keeps writing — whether or not this
   * process (or the session that launched it) is still alive.
   */
  backgrounded?: boolean;
  /**
   * The SUPERVISOR's pid, when `backgrounded` is true — see `childPid` for the
   * real command's pid. On POSIX this is also the process GROUP id (the
   * supervisor is the group leader), so `process.kill(-pid, ...)` reaches both.
   * Nothing here acts on it automatically — it's reported so a caller who
   * deliberately wants to manage that process later (check on it, kill it) has
   * the means to. Advisory only: pids are reused by the OS.
   */
  pid?: number;
  /**
   * The REAL command's pid, once the independent supervisor has recorded it into
   * the job manifest — see `backgroundJob.manifest`. May be absent at the exact
   * moment of handoff if the supervisor hasn't written it yet (best-effort, not
   * guaranteed). Signal a caller wants delivered to the command alone (not the
   * whole process group) should target THIS pid, not `pid`.
   */
  childPid?: number;
  /**
   * Absolute paths to the files the detached child's stdout/stderr are writing to,
   * when `backgrounded` is true. This is where the output went: tail these files
   * for anything the process produces after this call returns — including after
   * the calling process itself has exited. Kept for backward compatibility;
   * `backgroundJob` is the durable, structured handle for everything about this
   * job (including these same two paths).
   */
  backgroundLogs?: { stdout: string; stderr: string };
  /**
   * The durable, caller-owned handle for a backgrounded job: its id, directory,
   * launch manifest, and exit receipt path. This directory is NEVER deleted
   * automatically once it has been returned here — see README.md "Background
   * execution" for the full retention contract. The receipt file is absent until
   * the real command actually exits; its absence is never evidence of success.
   */
  backgroundJob?: BackgroundJobRef;
  /**
   * True when the caller's AbortSignal fired mid-run and the process TREE was killed
   * (killTree — the whole process group, not just the top-level shell). Only ever set
   * `true`; omitted otherwise. `exitCode` is deliberately a non-zero sentinel in this
   * case — a killed command must never be reported as if it succeeded.
   */
  aborted?: boolean;
  /**
   * Set when this job's directory (and its log/receipt paths) were kept around
   * because its process group could not be proven empty (possible live
   * descendants) — this is about DISK RETENTION ONLY, orthogonal to whether
   * the OUTCOME itself is known. Check `outcome` for that: `retained` may be
   * `true` alongside a real numeric `exitCode` ("exited"), or alongside a
   * `null` `exitCode` for a KNOWN signal death ("signal") or spawn error
   * ("spawn-error"), or an aborted run ("aborted", `exitCode: 137`) — all four
   * are known outcomes that simply couldn't prove their process group empty.
   * (Previously documented as "never set together with a null exitCode" —
   * that was wrong: a signal death or spawn error is a perfectly KNOWN outcome
   * that legitimately reports `exitCode: null`. `retained` is never set for
   * the genuinely-still-unknown cases, `outcome === "timeout" | "unknown"`,
   * which use `backgrounded`/the log paths alone to explain why nothing was
   * cleaned up.)
   */
  retained?: boolean;
  /** Human-readable reason `retained` is true, e.g. "process group may still have
   *  live members" — for model-facing/UI disclosure, not for programmatic branching. */
  retainedReason?: string;
  /**
   * Structured terminal-state discriminator — see `ExecOutcome` above. Set on
   * every settled `ExecResult` (foreground and background alike).
   */
  outcome?: ExecOutcome;
  /** The signal name (e.g. "SIGTERM") that ended the command, present only
   *  when `outcome === "signal"`. Structured counterpart to the human-readable
   *  note already appended to `stderr`. */
  signal?: string;
}

const isWin = process.platform === "win32";

/**
 * Pure helper: extension map for temp script files per language.
 * On Windows, shell scripts usually get NO extension to avoid Windows
 * file-association for `.sh` (which spawns a visible Git Bash window over the
 * user's IDE). Windows PowerShell/pwsh is the exception because `-File`
 * requires `.ps1` there.
 */
const SCRIPT_EXT: Record<Language, string> = {
  // `.cjs` (not `.js`): forces CommonJS so `require`/__dirname work regardless of the
  // nearest package.json `"type"`. Under a `"type":"module"` project a `.js` script is
  // ESM, where `require` is undefined — which broke both plain `require(...)` snippets
  // and the executeFile wrapper (`require("fs").readFileSync`). Matches the documented
  // Think-in-Code `require(...)` convention.
  javascript: "cjs",
  typescript: "ts",
  python: "py",
  shell: "sh",
  ruby: "rb",
  go: "go",
  rust: "rs",
  php: "php",
  perl: "pl",
  r: "R",
  elixir: "exs",
  csharp: "csx",
};

/** Pure helper — exported for unit testing. Returns "script" or "script.<ext>". */
export function buildScriptFilename(
  language: Language,
  platform: NodeJS.Platform,
  shellPath?: string | null,
): string {
  if (platform === "win32" && language === "shell") {
    const shellName = shellPath?.toLowerCase() ?? "";
    if (shellName.includes("powershell") || shellName.includes("pwsh")) return "script.ps1";
    const shellBase = shellName.split(/[\\/]/).pop() ?? shellName;
    if (shellBase === "cmd" || shellBase === "cmd.exe") return "script.cmd";
    return "script";
  }
  return `script.${SCRIPT_EXT[language]}`;
}

/**
 * Pure helper — exported for unit testing. Adds `windowsHide: true` on Windows
 * to prevent the spawned shell from creating a visible console window that
 * intercepts stdout (issue #384).
 */
export function buildSpawnOptions(platform: NodeJS.Platform): { windowsHide: boolean } {
  return { windowsHide: platform === "win32" };
}

function quoteForPosixShell(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Pure helper — exported for unit testing. Restores parent PATH after shell startup. */
export function buildShellScriptContent(
  code: string,
  inheritedPath: string | undefined,
  platform: NodeJS.Platform,
): string {
  if (platform === "win32" || !inheritedPath) return code;
  return `export PATH=${quoteForPosixShell(inheritedPath)}\n${code}`;
}

function isPowerShell(shellPath: string | null | undefined): boolean {
  const shellName = shellPath?.toLowerCase() ?? "";
  return shellName.includes("powershell") || shellName.includes("pwsh");
}

export function buildPowerShellScriptContent(code: string): string {
  // Prefix a UTF-8 BOM so Windows PowerShell 5.1 reliably detects the script
  // file as UTF-8 (without it, 5.1 falls back to the ANSI code page and
  // mangles non-ASCII characters in the script body).
  return [
    "\uFEFF[Console]::InputEncoding = [System.Text.UTF8Encoding]::new()",
    "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()",
    "$OutputEncoding = [System.Text.UTF8Encoding]::new()",
    code,
  ].join("\n");
}

/**
 * Pure helper — exported for unit testing. Issue #782.
 *
 * On Windows, the sandbox shell runtime is Git Bash. A bare `mvn` invocation
 * runs Maven's POSIX shell script, which on the `mingw=true` branch (uname →
 * MINGW64_NT-*) fails to convert `CLASSWORLDS_JAR` from a POSIX path
 * (`/c/tools/maven/boot/plexus-classworlds-*.jar`) to a Windows path. Native
 * `java.exe` then can't resolve the bootstrap jar → ClassNotFoundException for
 * `org.codehaus.plexus.classworlds.launcher.Launcher`.
 *
 * The third-way fix (issue Option C): rewrite the bare `mvn` token to `mvn.cmd`,
 * the native Windows launcher that uses Windows-native paths and bypasses the
 * broken mingw shell branch entirely. This does NOT touch the global MSYS
 * path-conversion env (MSYS_NO_PATHCONV / MSYS2_ARG_CONV_EXCL), which #826/#791
 * deliberately leave unset so native git.exe launched from bash keeps its
 * /tmp→C:\ argument conversion. Re-enabling global suppression would re-break
 * native git; rewriting only the mvn token keeps both correct.
 *
 * Only a `mvn` that starts a command (start of string, or after a shell
 * separator `&& | ; ( newline`) is rewritten. `mvnw`, `mvnd`, `mymvn`,
 * paths like `./mvnw`, and an already-`mvn.cmd` token are left untouched
 * (the token must be exactly `mvn` followed by whitespace or end-of-string).
 */
export function rewriteWindowsBuildTools(
  code: string,
  platform: NodeJS.Platform,
): string {
  if (platform !== "win32") return code;
  // Rewrite a bare `mvn` command token to `mvn.cmd` (Maven's native Windows launcher).
  // Algorithmic (no regex): only at a command-start position (string start or right
  // after a shell separator ; & | ( newline, skipping leading spaces/tabs) and only
  // when the token is exactly `mvn` followed by whitespace or end — leaves
  // mvnw / mvnd / ./mvnw / already-mvn.cmd untouched.
  const SEP = new Set([";", "&", "|", "(", "\n"]);
  let out = "";
  let atStart = true;
  let i = 0;
  while (i < code.length) {
    const ch = code[i];
    if (atStart && (ch === " " || ch === "\t")) {
      out += ch;
      i++;
      continue;
    }
    if (atStart && code.startsWith("mvn", i)) {
      const after = code[i + 3];
      if (after === undefined || after === " " || after === "\t" || after === "\n") {
        out += "mvn.cmd";
        i += 3;
        atStart = false;
        continue;
      }
    }
    out += ch;
    atStart = SEP.has(ch);
    i++;
  }
  return out;
}

/**
 * Remove a sandbox temp dir, retrying on Windows. Issue #788.
 *
 * On Windows, a child process that opened SQLite databases inside the sandbox
 * can leave `*-wal` / `*-shm` files with handles that linger briefly after the
 * process exits. A single `rmSync` then throws EBUSY/EPERM/ENOTEMPTY and the
 * old silent `catch {}` swallowed it, leaking `.ctx-mode-*` directories under
 * `%TEMP%`. Node's `rmSync({ maxRetries, retryDelay })` is purpose-built for
 * exactly this Windows-handle race, so let it back off and retry.
 */
function cleanupTmpDir(tmpDir: string): void {
  try {
    rmSync(tmpDir, {
      recursive: true,
      force: true,
      maxRetries: isWin ? 8 : 2,
      retryDelay: 100,
    });
  } catch {
    /* best-effort — OS will reclaim %TEMP% eventually */
  }
}

/**
 * m-2: a settle-once guard. Returns a function: the FIRST call returns `true`
 * ("settle now") and every call after that returns `false` ("already settled").
 * Used to make sure `close`/`error`/the background-timeout handoff — which can
 * fire in either order, and are not mutually exclusive on every platform/Node
 * version — drive `onData` callbacks and the final `res(...)` at most once
 * between all three, never a second time after the promise has already
 * resolved. Previously this was a single ad-hoc `resolved` boolean set only by
 * the background-timeout path and checked only at the top of `close`/`error` —
 * which left a real gap: an `error` event settling the promise first, followed
 * by a `close` event, was never guarded, so the decoder-flush code in `close`
 * could still call `onData` after resolve (see m-2 in background-outcome-review.md).
 * Pure, no timers, no I/O — exported for unit testing.
 */
export function createSettleGuard(): () => boolean {
  let settled = false;
  return () => {
    if (settled) return false;
    settled = true;
    return true;
  };
}

/** Kill process tree — on Windows uses taskkill /T; on Unix kills the process group. */
function killTree(proc: ReturnType<typeof spawn>): void {
  if (isWin && proc.pid) {
    try {
      execSync(`taskkill /F /T /PID ${proc.pid}`, { stdio: "pipe" });
    } catch { /* already dead */ }
  } else if (proc.pid) {
    try {
      // Kill entire process group (negative PID) to prevent orphaned children
      process.kill(-proc.pid, "SIGKILL");
    } catch { /* already dead */ }
  }
}

/**
 * Read a backgrounded process's log file, capped at `maxBytes`. The file on disk
 * is left completely alone (the detached child may still be appending to it) —
 * this only bounds what gets copied into the in-memory ExecResult. It's the same
 * protection `hardCapBytes` gives the non-background pipe path, just applied at
 * read time instead of continuously: continuous monitoring isn't needed here the
 * way it is for a pipe, because a file on disk can't make THIS process's heap
 * grow unbounded the way an unread pipe buffer can — there is no pipe.
 *
 * Exported for unit testing (pure given a path — no process/timing dependency).
 */
export function readCappedFile(path: string, maxBytes: number): { text: string; truncated: boolean } {
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return { text: "", truncated: false };
  }
  if (size <= maxBytes) {
    try {
      return { text: readFileSync(path, "utf-8"), truncated: false };
    } catch {
      return { text: "", truncated: false };
    }
  }
  try {
    const fd = openSync(path, "r");
    try {
      const buf = Buffer.alloc(maxBytes);
      readSync(fd, buf, 0, maxBytes, 0);
      return { text: buf.toString("utf-8"), truncated: true };
    } finally {
      closeSync(fd);
    }
  } catch {
    return { text: "", truncated: false };
  }
}

export interface ExecuteOptions {
  language: Language;
  code: string;
  /**
   * Milliseconds to wait — e.g. `timeout: 1000` means 1 second, NOT "1000 of
   * some other unit" and NOT a runtime budget for the command. It is when THIS
   * CALL gives up waiting synchronously: without `background`, a process still
   * running at `timeout` is killed (see killTree below); WITH `background: true`,
   * it is instead detached and left running — see `background`. Omit `timeout`
   * to wait indefinitely for the process to finish on its own (issue #406 — a
   * second enforced budget here just duplicates whatever timeout the MCP
   * host/client already applies).
   */
  timeout?: number;
  /**
   * Changes HOW this command's stdout/stderr are captured, from the moment it is
   * spawned: straight to files under a stable job directory (see `ExecResult.backgroundJob`)
   * instead of a pipe to this process — regardless of whether `timeout` is set.
   * `timeout` is the separate decision of whether we ever DETACH: with no `timeout`,
   * this call still waits for the real exit and streams `onData` the whole time,
   * returning the actual exit code, exactly like a normal exec (just routed via
   * files instead of a pipe) — it does NOT silently detach immediately. With a
   * `timeout` that elapses while the process is still running, the process is
   * detached instead of killed and this call returns immediately
   * (`timedOut: true, backgrounded: true, exitCode: null` — a launch is not a
   * success, so `exitCode` is never fabricated as `0`). See `ExecResult.backgroundJob`
   * for where the eventual true exit code can be read once it is known, and
   * README.md "Background execution" for the full contract (job directory layout,
   * the independent supervisor process, retention).
   */
  background?: boolean;
  /**
   * Called with each stdout/stderr chunk AS IT ARRIVES, before the process
   * exits. Lets a caller stream partial output to the UI instead of showing
   * nothing until close. Mirrors the pattern pi's built-in bash tool uses with
   * its `onUpdate` callback. Optional — omitting it changes nothing.
   */
  onData?: (chunk: string) => void;
  /**
   * Issue #45 — per-call cwd override for the shell language. When set,
   * the shell script runs in this directory instead of `#projectRoot`.
   * Non-shell languages keep their tmpDir sandbox cwd regardless (the
   * script file lives there). Used by Codex MCP handlers to pin shell
   * commands to a resolved project root when the spawning host inherited
   * a non-project cwd (e.g. $HOME).
   */
  cwd?: string;
  /**
   * Aborts the spawned process (killTree — the whole process group, not just the
   * shell) the moment it fires. Threaded from pi's `ToolDefinition.execute(...,
   * signal, ...)` through ActionCtx → runExec → here → #spawn, so Escape mid-run
   * actually kills the command instead of merely dropping the model-facing stream.
   * Already-aborted signals never spawn at all. Optional — omitting it changes
   * nothing (no regression for callers without one, e.g. subagents/tests).
   */
  signal?: AbortSignal;
}

export interface ExecuteFileOptions extends ExecuteOptions {
  path: string;
}

export class PolyglotExecutor {
  #hardCapBytes: number;
  /**
   * Resolves the project root on every access. Stored as a thunk so the
   * executor stays in sync with server-side env-cascade resolvers (e.g.
   * `getProjectDir` in server.ts) instead of capturing a snapshot of
   * `CLAUDE_PROJECT_DIR` at construction time. String inputs are wrapped
   * to preserve constructor backward compatibility.
   */
  #projectRootResolver: () => string;
  #runtimes: RuntimeMap;

  constructor(opts?: {
    hardCapBytes?: number;
    projectRoot?: string | (() => string);
    runtimes?: RuntimeMap;
  }) {
    this.#hardCapBytes = opts?.hardCapBytes ?? 100 * 1024 * 1024; // 100MB
    const pr = opts?.projectRoot;
    if (typeof pr === "function") {
      this.#projectRootResolver = pr;
    } else if (typeof pr === "string") {
      this.#projectRootResolver = () => pr;
    } else {
      this.#projectRootResolver = () => process.cwd();
    }
    this.#runtimes = opts?.runtimes ?? detectRuntimes();
  }

  get #projectRoot(): string {
    return this.#projectRootResolver();
  }

  get runtimes(): RuntimeMap {
    return { ...this.#runtimes };
  }

  async execute(opts: ExecuteOptions): Promise<ExecResult> {
    const { language, code, timeout, background = false, cwd: cwdOverride } = opts;
    const scratchBase = paths.scratch("project", this.#projectRoot);
    mkdirSync(scratchBase, { recursive: true });

    // R1 (background-brief): a background run gets a STABLE, caller-owned job
    // directory under `<scratch>/bg/<id>` — never the throwaway `mkdtemp(".ctx-")`
    // sandbox. The script file, launch manifest, supervisor, and both log files all
    // live there (see background-job.ts). Non-background execs are completely
    // unaffected: they keep using the plain `.ctx-*` sandbox exactly as before.
    //
    // I-4: `language === "rust"` is EXCLUDED from durable job-dir allocation even
    // when `background: true` is requested. `#compileAndRun` (below) never forwards
    // `background` to the compiled binary's own run step — Rust always runs to
    // completion in the foreground under the hood — and its early `return` bypasses
    // this function's own `cleanupTmpDir(tmpDir)` call entirely (a PRE-EXISTING,
    // separate gap affecting every Rust run, background or not — out of scope here).
    // Without this exclusion, a `background: true` Rust request would allocate a
    // real `bg/<id>/` directory (mkdirSync below) that then leaks PERMANENTLY
    // through that same early return, for a language that was never going to honor
    // `background` in the first place. Using the plain `.ctx-*` sandbox instead
    // keeps Rust's observable behavior byte-for-byte identical (still leaked by the
    // pre-existing gap, just as a throwaway sandbox dir instead of a durable,
    // caller-facing one) while never allocating the durable namespace entry.
    let tmpDir: string;
    let job: BackgroundJobPaths | undefined;
    if (background && language !== "rust") {
      job = backgroundJobPaths(scratchBase, newJobId());
      // The child's own TMPDIR lives one level below the job root (see
      // BackgroundJobPaths.tmpDir jsdoc) so it can never collide with the script
      // file, job.json, or exit.json sitting at the job root.
      mkdirSync(job.tmpDir, { recursive: true });
      tmpDir = job.dir;
    } else {
      tmpDir = mkdtempSync(join(scratchBase, ".ctx-"));
    }

    try {
      const filePath = this.#writeScript(tmpDir, code, language);
      const cmd = buildCommand(this.#runtimes, language, filePath);

      // Rust: compile then run
      if (cmd[0] === "__rust_compile_run__") {
        return await this.#compileAndRun(filePath, tmpDir, timeout);
      }

      // Every language runs in the project directory so git, relative paths,
      // and other project-aware tools resolve naturally. The script FILE lives
      // in the sandbox tmpDir and is passed to the runtime by absolute path
      // (see buildCommand), so cwd is free to be the project root.
      //
      // Issue #788 — previously only `shell` used the project root; non-shell
      // runtimes (python/js/ts/…) used tmpDir, so repo-relative checks like
      // `pathlib.Path("package.json").exists()` silently failed depending on
      // the chosen language. Unifying cwd removes that surprise.
      // Issue #45 — `cwdOverride` lets per-call sites (Codex MCP handlers) pin
      // cwd without mutating process-wide state.
      const cwd = cwdOverride ?? this.#projectRoot;
      const result = await this.#spawn(
        cmd, cwd, job ? job.tmpDir : tmpDir, timeout, background, opts.onData, opts.signal, job,
      );

      // Skip cleanup if the process was actually handed off (backgrounded) OR its
      // directory was retained for a verified-finished command with possible live
      // descendants (I-3: `retained` is a separate concept from `backgrounded` —
      // see the close handler below) — the job directory is now caller-owned and
      // returned in the result; nothing here deletes it again, ever (see README.md
      // "Background execution"). A background run that finished before any timeout
      // with a provably-empty process group is NEITHER backgrounded NOR retained,
      // so it is cleaned up exactly like a plain `.ctx-*` sandbox — nothing external
      // could reference a path that was never returned.
      if (!result.backgrounded && !result.retained) {
        cleanupTmpDir(tmpDir);
      }

      return result;
    } catch (err) {
      cleanupTmpDir(tmpDir);
      throw err;
    }
  }

  async executeFile(opts: ExecuteFileOptions): Promise<ExecResult> {
    const { path: filePath, language, code, timeout, onData, signal } = opts;
    const absolutePath = resolve(this.#projectRoot, filePath);
    const wrappedCode = this.#wrapWithFileContent(
      absolutePath,
      language,
      code,
    );
    // A-H2 (branch-review A-architecture.md): this used to destructure only
    // {path, language, code, timeout} and silently drop `onData`/`signal` even though
    // `ExecuteFileOptions extends ExecuteOptions` declares both — so ANY caller passing
    // them (streaming output, or an abort signal) got neither, one level below
    // actions/exec.ts's runExecFile.
    return this.execute({ language, code: wrappedCode, timeout, onData, signal });
  }

  #writeScript(tmpDir: string, code: string, language: Language): string {
    // Go needs a main package wrapper if not present
    if (language === "go" && !code.includes("package ")) {
      code = `package main\n\nimport "fmt"\n\nfunc main() {\n${code}\n}\n`;
    }

    // PHP needs opening tag if not present
    if (language === "php" && !code.trimStart().startsWith("<?")) {
      code = `<?php\n${code}`;
    }

    // Elixir: prepend compiled BEAM paths when inside a Mix project
    if (language === "elixir" && existsSync(join(this.#projectRoot, "mix.exs"))) {
      const escaped = JSON.stringify(join(this.#projectRoot, "_build/dev/lib"));
      code = `Path.wildcard(Path.join(${escaped}, "*/ebin"))\n|> Enum.each(&Code.prepend_path/1)\n\n${code}`;
    }

    const fp = join(
      tmpDir,
      buildScriptFilename(
        language,
        process.platform,
        language === "shell" ? this.#runtimes.shell : null,
      ),
    );
    if (language === "shell") {
      const shellPath = this.#runtimes.shell;
      // #782 — on Windows Git Bash, rewrite bare `mvn` → `mvn.cmd` so Maven
      // uses its native Windows launcher (correct path handling) instead of
      // the broken mingw shell branch. No-op on non-Windows.
      const rewritten = rewriteWindowsBuildTools(code, process.platform);
      const shellCode = isWin && isPowerShell(shellPath)
        ? buildPowerShellScriptContent(rewritten)
        : rewritten;
      writeFileSync(
        fp,
        buildShellScriptContent(shellCode, process.env.PATH, process.platform),
        { encoding: "utf-8", mode: 0o700 },
      );
    } else {
      writeFileSync(fp, code, "utf-8");
    }
    return fp;
  }

  async #compileAndRun(
    srcPath: string,
    cwd: string,
    timeout: number | undefined,
  ): Promise<ExecResult> {
    const binSuffix = isWin ? ".exe" : "";
    const binPath = srcPath.replace(/\.rs$/, "") + binSuffix;

    // Compile — cap rustc invocation at 60s when caller didn't bound the
    // overall timeout (a hung compile shouldn't run forever even if the
    // caller is fine with a long-running binary afterwards).
    try {
      execFileSync("rustc", [srcPath, "-o", binPath], {
        cwd,
        timeout: timeout === undefined ? 60_000 : Math.min(timeout, 60_000),
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? (err as any).stderr || err.message : String(err);
      return {
        stdout: "",
        stderr: `Compilation failed:\n${message}`,
        exitCode: 1,
        timedOut: false,
      };
    }

    // Run
    return this.#spawn([binPath], cwd, cwd, timeout);
  }

  async #spawn(
    cmd: string[],
    cwd: string,
    sandboxTmpDir: string,
    timeout: number | undefined,
    background = false,
    onData?: (chunk: string) => void,
    signal?: AbortSignal,
    job?: BackgroundJobPaths,
  ): Promise<ExecResult> {
    // Escape (or any other abort source) may already have fired before we get here —
    // e.g. the user hit it while the tool call was still being dispatched. Never spawn
    // in that case: there is nothing yet to kill, and spawning anyway would start a
    // process the caller already asked to cancel.
    if (signal?.aborted) {
      return {
        stdout: "",
        stderr: "[aborted — signal was already aborted before the command started]",
        exitCode: 137,
        timedOut: false,
        aborted: true,
        outcome: "aborted",
      };
    }

    // `onAbort` / `tail` are declared here (outer scope) so the `finally` below can
    // always clean them up on every settle path (abort, normal close, spawn error,
    // background-timeout early-resolve, or a synchronous throw before any of those
    // listeners even attach) — not just one path. Without this, a long-lived
    // AbortSignal reused across a session/turn accumulates listeners, and a tail
    // poller could keep running (and calling onData) after the tool call resolved.
    let onAbort: (() => void) | undefined;
    let tail: LogTail | undefined;
    try {
      return await new Promise<ExecResult>((res) => {
      // Only .cmd/.bat shims need shell on Windows; real executables don't.
      // Using shell: true globally causes process-tree kill issues with MSYS2/Git Bash.
      // "bun" is included as defense-in-depth: bunCommand() prefers absolute
      // .exe paths now (#506), but if it falls back to the bare "bun" string
      // on Windows that resolution typically goes through a `bun.cmd` shim
      // (npm i -g bun) which CreateProcess can't execute without cmd.exe.
      const needsShell = isWin && ["tsx", "ts-node", "elixir", "bun", "dotnet-script"].includes(cmd[0]);

      // On Windows with Git Bash, pass the script as `bash -c "source /posix/path"`
      // rather than `bash /path/to/script.sh`. This avoids MSYS2 path mangling
      // while still allowing MSYS_NO_PATHCONV to protect non-ASCII paths in commands.
      let spawnCmd = cmd[0];
      let spawnArgs: string[];
      if (isWin && cmd.length === 2 && cmd[1]) {
        const posixPath = cmd[1].replace(/\\/g, "/");
        spawnArgs = [posixPath];
      } else {
        spawnArgs = isWin
          ? cmd.slice(1).map(a => a.replace(/\\/g, "/"))
          : cmd.slice(1);
      }

      // DEP0190: when shell is true (Windows .cmd/.bat shims), pass a single command
      // string instead of cmd + args array — Node warns that args are unsafely
      // concatenated when shell:true is combined with the args-array form of spawn().
      // Shared by the direct (non-background) shell branch below AND the background
      // manifest's `shellCommand` field, so background inherits the identical
      // Windows .cmd/.bat handling foreground already has.
      const buildFullShellCommand = () => [spawnCmd, ...spawnArgs]
        .map(a => /\s/.test(a) ? JSON.stringify(a) : a)
        .join(" ");

      // Background mode: redirect the child's stdout/stderr straight to files
      // under the job directory, decided HERE at spawn time — never as a pipe
      // to this process. This is the actual fix for the defect where a
      // backgrounded process died the moment its launching process exited: a
      // pipe's read end lives in the process that called spawn(), so when that
      // process exits (a subagent finishing counts), the kernel closes it and
      // the child's next write raises SIGPIPE (default disposition: dead, no
      // handler, no trace, status files left stale). A plain file has no such
      // dependency — the child keeps writing successfully long after this
      // process — and the very idea of "the pipe" — are both gone. This mirrors
      // Node's own child_process docs example for `options.detached` (open a
      // log fd, pass it as stdio, close the parent's copy, spawn detached +
      // unref). We decide this unconditionally whenever `background` is
      // requested — not only once the timeout actually fires — because by the
      // time we know the timeout fired, the child's stdio is already fixed for
      // its whole life; there is no way to swap a live pipe for a file after
      // the fact.
      let stdoutLogPath: string | undefined;
      let stderrLogPath: string | undefined;
      let outFd: number | undefined;
      let errFd: number | undefined;
      if (background) {
        stdoutLogPath = job!.stdout;
        stderrLogPath = job!.stderr;
        // O3 (background-brief): guard the fd ACQUISITION itself — a second-open
        // failure after the first fd is already open must not leak it.
        try {
          outFd = openSync(stdoutLogPath, "w");
          errFd = openSync(stderrLogPath, "w");
        } catch (err) {
          if (outFd !== undefined) closeSync(outFd);
          throw err;
        }
      }

      // Common options shared by every spawn variant below (direct, shell, and the
      // background supervisor all use this).
      const commonOpts = {
        cwd,
        stdio: (background
          ? ["ignore", outFd!, errFd!]
          : ["ignore", "pipe", "pipe"]) as ["ignore", "pipe" | number, "pipe" | number],
        env: this.#buildSafeEnv(sandboxTmpDir),
        // On Unix, create a new process group so killTree can kill all children
        detached: !isWin,
        // Hide the spawned-process console window on Windows. Without this,
        // child_process.spawn creates a visible window that intercepts stdout,
        // leaving the MCP response empty and popping a Git Bash terminal over
        // the user's IDE. Issue #384.
        ...buildSpawnOptions(process.platform),
      };

      // O3: guard the spawn CALL itself — a synchronous throw (bad options, EMFILE,
      // an unreadable cwd) must not leak the two log fds we just opened above. This
      // guard is unconditional (not just for background) but only background ever
      // has fds to close; a non-background throw here rethrows with nothing to
      // clean up, exactly as before.
      let proc: ReturnType<typeof spawn>;
      try {
        if (background) {
          // R1/R2 (background-brief): background never spawns the real command
          // directly. It spawns a tiny independent Node supervisor — emitted to
          // disk fresh for this job, never shipped as a package file (the
          // distributed artifact is a single bundled dist/extension.js) — which
          // spawns the REAL command itself with stdio:"inherit" (the bytes still
          // go straight to the same file descriptions opened above; this process
          // never re-pipes them) and writes an atomic exit receipt once the real
          // command's fate is known. The manifest is written ONCE, here, before
          // the supervisor exists — the supervisor may update it exactly once
          // more (recording childPid); this process never writes it again, so
          // there is no writer race between parent and child.
          writeFileSync(job!.supervisorScript, BACKGROUND_SUPERVISOR_SOURCE, "utf-8");
          writeManifest(job!.manifest, {
            schema: 1,
            id: job!.id,
            cwd,
            windowsHide: buildSpawnOptions(process.platform).windowsHide,
            startedAt: new Date().toISOString(),
            ...(needsShell ? { shellCommand: buildFullShellCommand() } : { argv: [spawnCmd, ...spawnArgs] }),
          });
          proc = spawn(process.execPath, [job!.supervisorScript, job!.dir], commonOpts);
        } else if (needsShell) {
          proc = spawn(buildFullShellCommand(), [], { ...commonOpts, shell: true });
        } else {
          proc = spawn(spawnCmd, spawnArgs, { ...commonOpts, shell: false });
        }
      } catch (err) {
        if (background) {
          if (outFd !== undefined) closeSync(outFd);
          if (errFd !== undefined) closeSync(errFd);
        }
        throw err;
      }

      // The child now holds its own reference to outFd/errFd (duplicated across
      // fork/exec, same as any inherited fd) independent of this process — close
      // our copies immediately so we don't leak fds across the many execs in a
      // session. This does NOT close the underlying file: the child's copy keeps
      // it alive for as long as the child needs it, exactly like `nohup cmd >
      // log 2>&1 &` at a shell.
      if (background) {
        if (outFd !== undefined) closeSync(outFd);
        if (errFd !== undefined) closeSync(errFd);
      }

      // R4 (background-brief) / I2 (background-fix-review): restore pre-handoff
      // streaming for background execs by tailing the log files a caller can't
      // otherwise see into until the call returns (there is no pipe — see above).
      // This is a SEPARATE budget from the foreground pipe path's hardCapBytes kill:
      // that path accumulates bytes and KILLS the process past the cap; a detached
      // background job must never be killed just because a UI's streaming budget
      // filled up (the full log file on disk stays unbounded by policy — see
      // README.md). So this enforces ONE CUMULATIVE budget across BOTH streams
      // combined (not tailLogs's own per-tick/per-file read bound, which stays at
      // its own small default — a separate, smaller concern: bounding a single
      // read call, not total streamed bytes) — at exhaustion it stops tailing
      // entirely and emits exactly one bounded cap notice, never a kill.
      if (background && onData) {
        let streamedBytes = 0;
        let capped = false;
        const boundedOnData = (chunk: string) => {
          if (capped) return;
          streamedBytes += Buffer.byteLength(chunk, "utf-8");
          if (streamedBytes > this.#hardCapBytes) {
            capped = true;
            onData(
              `\n[streaming capped at ${(this.#hardCapBytes / 1024 / 1024).toFixed(2)}MB — ` +
                `the job keeps running and its full output keeps growing on disk; see backgroundLogs]`,
            );
            tail?.stop();
            return;
          }
          onData(chunk);
        };
        tail = tailLogs({ stdout: stdoutLogPath!, stderr: stderrLogPath! }, boundedOnData);
      }

      let timedOut = false;
      let aborted = false;
      // m-2: replaces the old ad-hoc `resolved` boolean (which only guarded the
      // background-timeout-vs-close race) with a guard that ALSO covers an
      // `error` event settling first, followed by a `close` event — so the
      // decoder-flush code below can never call `onData` a second time after
      // the promise has already resolved via `error`.
      const trySettle = createSettleGuard();
      // Issue #406 — if the caller didn't pass a timeout we don't fire one.
      // Timeout policy belongs to the MCP host/client (Claude Code, VSCode,
      // JetBrains all enforce their own RPC timeouts); imposing a second
      // policy here turned 30-minute Gradle/Maven/SBT builds into spurious
      // false negatives whenever the caller forgot the explicit value.
      //
      // Background + no timeout at all is deliberately NOT a special case here:
      // with no timer, this call simply waits for the real `close`/`error` event
      // below exactly like a foreground exec would — it streams via `tail` the
      // whole time and returns the TRUE exit code once the command actually exits.
      // Nothing "detaches" until a timeout genuinely elapses while still running.
      const timer: NodeJS.Timeout | undefined = timeout === undefined ? undefined : setTimeout(() => {
        timedOut = true;
        if (background) {
          // R3 (background-brief): a launch is not a success. `exitCode: null` —
          // never a fabricated `0` — because the real command's fate genuinely
          // is not known yet; the eventual truth lives in the receipt file
          // (backgroundJob.receipt), written by the supervisor once it settles.
          if (!trySettle()) return;
          tail?.stop();
          proc.unref();
          const stdoutRead = readCappedFile(stdoutLogPath!, this.#hardCapBytes);
          const stderrRead = readCappedFile(stderrLogPath!, this.#hardCapBytes);
          let rawStderr = stderrRead.text;
          if (stdoutRead.truncated || stderrRead.truncated) {
            rawStderr += `\n[output capped at ${(this.#hardCapBytes / 1024 / 1024).toFixed(0)}MB while reading the log — the process keeps writing past the cap on disk; see backgroundLogs]`;
          }
          // Best-effort: the supervisor records the real command's pid into the
          // manifest as soon as it spawns it, but that write may not have landed
          // yet at the exact instant of handoff — childPid is advisory either way.
          const manifest = readManifestSafe(job!.manifest);
          res({
            stdout: stdoutRead.text,
            stderr: rawStderr,
            exitCode: null,
            timedOut: true,
            backgrounded: true,
            outcome: "timeout",
            pid: proc.pid,
            ...(manifest?.childPid !== undefined ? { childPid: manifest.childPid } : {}),
            backgroundLogs: { stdout: stdoutLogPath!, stderr: stderrLogPath! },
            backgroundJob: jobRef(job!),
          });
        } else {
          killTree(proc);
        }
      }, timeout);

      // Kill the whole process tree the instant the caller's signal fires (Escape
      // mid-run). Reuses killTree — the SAME primitive the timeout/hard-cap paths
      // above and below already use — so a grandchild the script spawned itself
      // (e.g. `sleep 30 &`) dies too, not just the top-level shell. On POSIX the
      // background supervisor is the process GROUP leader, so this reaches the
      // real command too, exactly as it did before the supervisor existed.
      if (signal) {
        onAbort = () => {
          aborted = true;
          killTree(proc);
        };
        signal.addEventListener("abort", onAbort, { once: true });
      }

      // Stream-level byte cap: kill the process once combined stdout+stderr
      // exceeds hardCapBytes. Without this, a command like `yes` or
      // `cat /dev/urandom | base64` can accumulate gigabytes in memory
      // before the timeout fires. Background execs have no pipe (see above) so
      // there is nothing to attach these listeners to — and no equivalent risk
      // to guard against: a file on disk can't grow this process's heap the
      // way an unread pipe buffer can (see readCappedFile).
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let totalBytes = 0;
      let capExceeded = false;
      // I-1: a raw pipe `Buffer` chunk boundary has no relationship to UTF-8
      // code-point boundaries — a multi-byte character split across two `data`
      // events used to be decoded independently (`chunk.toString("utf-8")` per
      // chunk), turning the split half on each side into a U+FFFD replacement
      // character in the `onData` PREVIEW stream (the final `stdout`/`stderr`
      // below were already safe: they decode ONCE from the fully-concatenated
      // Buffer). A `StringDecoder` per stream holds back an incomplete trailing
      // sequence and prepends it to the next chunk automatically — the same
      // fix `log-tail.ts` already uses for the background tail path.
      const stdoutDecoder = new StringDecoder("utf-8");
      const stderrDecoder = new StringDecoder("utf-8");

      if (!background) {
        proc.stdout!.on("data", (chunk: Buffer) => {
          totalBytes += chunk.length;
          if (totalBytes <= this.#hardCapBytes) {
            stdoutChunks.push(chunk);
            onData?.(stdoutDecoder.write(chunk));
          } else if (!capExceeded) {
            capExceeded = true;
            killTree(proc);
          }
        });

        proc.stderr!.on("data", (chunk: Buffer) => {
          totalBytes += chunk.length;
          if (totalBytes <= this.#hardCapBytes) {
            stderrChunks.push(chunk);
            onData?.(stderrDecoder.write(chunk));
          } else if (!capExceeded) {
            capExceeded = true;
            killTree(proc);
          }
        });
      }

      proc.on("close", (exitCode, signal) => {
        clearTimeout(timer);
        if (!trySettle()) return; // Already settled by background timeout, or by a prior `error` event
        tail?.stop();

        if (background) {
          // C1/I3: the SUPERVISOR just closed — its own raw exit code proves
          // NOTHING reliable about the real command (a supervisor killed alone
          // exits null/nonzero regardless of whether the real command is still
          // happily running — see background-job.ts's BACKGROUND_SUPERVISOR_SOURCE,
          // which mirrors the command's fate as its own code only when it gets the
          // chance to). The receipt file is the ONLY source of truth for what the
          // real command actually did; its absence is UNKNOWN, never inherited as
          // success or failure (I3). Separately, a supervisor closing does not
          // prove every process in its group is gone — a `(loop) & echo done`
          // -style live descendant can outlive both the shell and the supervisor
          // while sharing the same process group (C1) — so retention is decided
          // by an actual liveness probe, never inferred from "the supervisor
          // exited".
          const receipt = readReceiptSafe(job!.receipt);
          const manifest = readManifestSafe(job!.manifest);
          const stdoutRead = readCappedFile(stdoutLogPath!, this.#hardCapBytes);
          const stderrRead = readCappedFile(stderrLogPath!, this.#hardCapBytes);
          let rawStderr = stderrRead.text;
          if (stdoutRead.truncated || stderrRead.truncated) {
            rawStderr += `\n[output capped at ${(this.#hardCapBytes / 1024 / 1024).toFixed(0)}MB while reading the log]`;
          }

          // POSIX process-GROUP liveness (see background-job.ts#groupHasLiveMembers):
          // `null` (can't determine — Windows, or a pid we don't own) and `true`
          // (still has members) are BOTH "cannot prove empty" — only a definite
          // `false` (ESRCH) permits treating the job as fully finished.
          const groupAlive = proc.pid !== undefined ? groupHasLiveMembers(proc.pid) : null;
          const provablyEmpty = groupAlive === false;
          // The genuinely-unknown case (no valid receipt at all): retention is
          // conservative and UNCONDITIONAL here regardless of `provablyEmpty` —
          // with no receipt we cannot even trust that the real command settled,
          // so `backgrounded: true` (still-running-shaped) is kept, matching the
          // existing conservative-cleanup contract (see execute()'s cleanup gate).
          const retainedFields = () => ({
            backgrounded: true,
            pid: proc.pid,
            ...(manifest?.childPid !== undefined ? { childPid: manifest.childPid } : {}),
            backgroundJob: jobRef(job!),
            backgroundLogs: { stdout: stdoutLogPath!, stderr: stderrLogPath! },
          });
          // C-1/I-3: the field set for "the command's outcome IS known (exited,
          // signal death, spawn error, or aborted), but its directory was
          // retained because the process group could not be proven empty" —
          // `backgrounded` must NOT be set here, since that field's contract
          // elsewhere (the timeout-handoff path, and the genuinely-unknown
          // branch above) means "still running/outcome unknown", which is false
          // for any of these four KNOWN outcomes even when `exitCode` happens to
          // be `null` (signal/spawn-error). `retained`/`retainedReason` carry the
          // disclosure instead — callers key off `outcome` (never `exitCode ===
          // null` alone) to decide whether the result is known.
          const verifiedRetainedFields = (reason: string) => ({
            pid: proc.pid,
            ...(manifest?.childPid !== undefined ? { childPid: manifest.childPid } : {}),
            backgroundJob: jobRef(job!),
            backgroundLogs: { stdout: stdoutLogPath!, stderr: stderrLogPath! },
            retained: true,
            retainedReason: reason,
          });
          const GROUP_MAY_HAVE_LIVE_MEMBERS = "process group may still have live members";

          if (aborted) {
            rawStderr += "\n[aborted — the process was killed before it finished]";
            if (!provablyEmpty) {
              // C-1/I-3: previously used `retainedFields()` (`backgrounded: true`),
              // which both mislabeled a KNOWN, verified-aborted outcome as
              // "still running" AND — because `backgroundJob`/`backgroundLogs`
              // were the only paths carried — left the disclosure to be found via
              // the wrong branch downstream. `verifiedRetainedFields` carries the
              // exact same paths under the correct, known-outcome contract.
              rawStderr += "\n[could not confirm every process in its group has exited — job directory retained, not deleted]";
              res({ stdout: stdoutRead.text, stderr: rawStderr, exitCode: 137, timedOut: false, aborted: true, outcome: "aborted", ...verifiedRetainedFields(GROUP_MAY_HAVE_LIVE_MEMBERS) });
              return;
            }
            res({ stdout: stdoutRead.text, stderr: rawStderr, exitCode: 137, timedOut: false, aborted: true, outcome: "aborted" });
            return;
          }

          if (!receipt) {
            // The supervisor exited/died without ever writing a valid receipt:
            // killed alone before it could write one, crashed before spawning the
            // real command, or (far rarer) a write that lost a race with process
            // death. None of those tell us the real command failed OR succeeded —
            // this is `outcome: "unknown"`, distinct from `"timeout"`: a caller must
            // never claim the receipt "appears when it exits" here, since the real
            // command may already have exited (or never will produce one at all).
            rawStderr += "\n[the supervisor exited without a valid receipt — the real command's outcome is UNKNOWN, not assumed to have failed or succeeded]";
            if (!provablyEmpty) rawStderr += "\n[a process in its group may still be running — job directory retained]";
            res({ stdout: stdoutRead.text, stderr: rawStderr, exitCode: null, timedOut: false, outcome: "unknown", ...retainedFields() });
            return;
          }

          if (receipt.state === "spawn-error") {
            rawStderr += `\n[the command never started: ${receipt.error ?? "spawn error"}]`;
            if (!provablyEmpty) {
              // C-1: a spawn error is a KNOWN outcome (we have a valid receipt
              // saying so) — use `verifiedRetainedFields`, not the "still
              // running"-shaped `retainedFields()`, on the rare chance the
              // group could not be proven empty (residual verification limit:
              // see the report — not independently reproducible, since nothing
              // ever spawned into the group besides the supervisor itself).
              rawStderr += "\n[could not confirm every process in its group has exited — job directory retained, not deleted]";
              res({ stdout: stdoutRead.text, stderr: rawStderr, exitCode: null, timedOut: false, outcome: "spawn-error", ...verifiedRetainedFields(GROUP_MAY_HAVE_LIVE_MEMBERS) });
              return;
            }
            res({ stdout: stdoutRead.text, stderr: rawStderr, exitCode: null, timedOut: false, outcome: "spawn-error" });
            return;
          }

          // receipt.state === "exited" — the supervisor genuinely observed the real
          // command's own fate; this (never the supervisor's raw close code) is the
          // truth. A signal death is exitCode:null with the signal named in
          // stderr AND in the new structured `signal` field, never conflated with a
          // numeric exit code. deriveTrueExit (I-2) guarantees this is a real
          // number or `null` — never `undefined`.
          const trueExit = deriveTrueExit(receipt);
          const outcome: ExecOutcome = receipt.signal ? "signal" : "exited";
          if (receipt.signal) rawStderr += `\n[the command was terminated by signal ${receipt.signal}]`;
          if (!provablyEmpty) {
            // m-6: a signal death already stated its own fate in the line just
            // above ("...was terminated by signal X") — reusing the exited-case
            // "the command finished" wording right after that read as if the
            // command BOTH finished normally AND was killed. State only the
            // retention fact for a signal death; keep the fuller "finished
            // (exit N)"-shaped wording for the genuinely exited case.
            const retentionNote = outcome === "signal"
              ? `\n[its ${GROUP_MAY_HAVE_LIVE_MEMBERS} — job directory retained; further output, if any, keeps landing in backgroundLogs]`
              : `\n[the command finished, but its ${GROUP_MAY_HAVE_LIVE_MEMBERS} — job directory retained; further output, if any, keeps landing in backgroundLogs]`;
            rawStderr += retentionNote;
            res({
              stdout: stdoutRead.text, stderr: rawStderr, exitCode: trueExit, timedOut: false, outcome,
              ...(receipt.signal ? { signal: receipt.signal } : {}),
              ...verifiedRetainedFields(GROUP_MAY_HAVE_LIVE_MEMBERS),
            });
            return;
          }
          res({
            stdout: stdoutRead.text, stderr: rawStderr, exitCode: trueExit, timedOut: false, outcome,
            ...(receipt.signal ? { signal: receipt.signal } : {}),
          });
          return;
        }

        // I-1: flush each stream's decoder EXACTLY ONCE, before building the final
        // stdout/stderr below — a trailing incomplete multi-byte sequence held
        // back by the LAST `data` event's `.write()` call would otherwise never
        // reach `onData` (the final `stdout`/`stderr` themselves are unaffected:
        // they decode once from the fully-concatenated raw Buffer, never through
        // the per-chunk decoder). m-2: never called again after this — guarded by
        // `trySettle()` above, which (unlike the old `resolved`-only check) also
        // covers an `error` event settling the promise first, so a subsequent
        // `close` can never reach here at all, let alone flush a second time.
        const stdoutTail = stdoutDecoder.end();
        if (stdoutTail) onData?.(stdoutTail);
        const stderrTail = stderrDecoder.end();
        if (stderrTail) onData?.(stderrTail);

        const rawStdout = Buffer.concat(stdoutChunks).toString("utf-8");
        let rawStderr = Buffer.concat(stderrChunks).toString("utf-8");

        if (capExceeded) {
          rawStderr += `\n[output capped at ${(this.#hardCapBytes / 1024 / 1024).toFixed(0)}MB — process killed]`;
        }
        if (aborted) {
          rawStderr += "\n[aborted — the process was killed before it finished]";
        } else if (signal) {
          // I-1: a real signal death — whether an external kill, or OUR OWN
          // `timeout`/`hardCapBytes` kill via killTree (which sends SIGKILL) —
          // is a KNOWN outcome, never conflated with `outcome: "exited"`. Name
          // the signal in stderr the same way the background path already does
          // (see the `receipt.signal` branch in the background close handling
          // below), instead of silently reporting a numeric-looking sentinel
          // against this exact field's own JSDoc.
          rawStderr += `\n[the command was terminated by signal ${signal}]`;
        }

        const stdout = rawStdout;
        const stderr = rawStderr;

        // I-1: `outcome` — never a bare numeric `exitCode` — is what every
        // caller branches on. A signal death (external, or our own timeout/cap
        // kill) is `"signal"`, with the real signal name and `exitCode: null`;
        // it is NOT `"exited"` just because `timedOut`/capExceeded happened to
        // be involved. `aborted` still wins (its own `137` sentinel is an
        // intentional, pre-existing, documented convention — see
        // `ExecResult.aborted`'s JSDoc — and unrelated to this fix).
        const outcome: ExecOutcome = aborted ? "aborted" : (signal ? "signal" : "exited");
        res({
          stdout,
          stderr,
          // A killed command must never be reported as if it succeeded: force a
          // non-zero, recognizable sentinel (137 = 128+SIGKILL, the same convention
          // a shell itself uses for a killed child) instead of whatever raw exitCode
          // the OS happened to report for the process we just killed — for the
          // ABORT case only. A real signal death legitimately has NO numeric exit
          // code (`exitCode: null`, matching `ExecOutcome`'s own JSDoc and the
          // background path's identical contract) — `exitCode ?? 1` is kept ONLY
          // as a last-resort fallback for the near-impossible case where Node's
          // `close` reports neither a code nor a signal.
          exitCode: aborted ? 137 : (signal ? null : (exitCode ?? 1)),
          timedOut,
          outcome,
          ...(signal ? { signal } : {}),
          ...(aborted ? { aborted: true } : {}),
        });
      });

      proc.on("error", (err) => {
        clearTimeout(timer);
        if (!trySettle()) return; // Already settled by background timeout, close, or a prior error
        tail?.stop();
        res({
          stdout: "",
          stderr: err.message,
          // I-1: a real spawn error (the command never started) is a KNOWN
          // outcome with NO numeric exit code to report — `ExecOutcome`'s own
          // JSDoc says so ("spawn-error": exitCode is null), and the background
          // path already honors this. The foreground path previously reported
          // `exitCode: 1` here, contradicting its own type's contract — an
          // aborted spawn keeps its `137` sentinel (that one is intentional and
          // unrelated to this fix; see `ExecResult.aborted`'s own JSDoc).
          exitCode: aborted ? 137 : null,
          timedOut: false,
          outcome: aborted ? "aborted" : "spawn-error",
          ...(aborted ? { aborted: true } : {}),
        });
      });
      });
    } finally {
      // Always remove the listener/stop the tail once this spawn settles — whether it
      // settled via abort, normal exit, spawn error, the background-timeout
      // early-resolve, or a synchronous throw before those handlers even attached —
      // so neither ever outlives the tool call. Both are idempotent, so this is a
      // safety net even on paths that already stopped them explicitly above.
      if (signal && onAbort) signal.removeEventListener("abort", onAbort);
      tail?.stop();
    }
  }

  #buildSafeEnv(tmpDir: string): Record<string, string> {
    const realHome = process.env.HOME ?? process.env.USERPROFILE ?? tmpDir;

    // Denylist: env vars that corrupt sandbox stdout, inject code, or break
    // language runtimes. Each entry is backed by CVE, MITRE, or live testing.
    // See: https://www.elttam.com/blog/env/, MITRE T1574.006
    const DENIED = new Set([
      // Shell — auto-execute scripts, override builtins
      "BASH_ENV",             // sourced by non-interactive bash
      "ENV",                  // sourced by sh/dash
      "PROMPT_COMMAND",       // runs before each prompt
      "PS4",                  // $(cmd) expansion in xtrace
      "SHELLOPTS",            // enables xtrace/verbose, dumps to stdout
      "BASHOPTS",             // bash-specific shell options
      "CDPATH",               // makes cd print to stdout
      "INPUTRC",              // readline key rebinding
      "BASH_XTRACEFD",        // redirects debug output to stdout
      // Node.js — require injection, inspector
      "NODE_OPTIONS",         // --require, --loader, --inspect
      "NODE_PATH",            // module search path injection
      // Python — stdlib override, startup injection
      "PYTHONSTARTUP",        // auto-executes in interactive mode
      "PYTHONHOME",           // overrides stdlib location (breaks Python)
      "PYTHONWARNINGS",       // triggers module import chain → RCE
      "PYTHONBREAKPOINT",     // arbitrary callable
      "PYTHONINSPECT",        // enters interactive mode after script
      // Ruby — option/module injection
      "RUBYOPT",              // injects CLI options (-r loads files)
      "RUBYLIB",              // module search path injection
      // Perl — option/module injection
      "PERL5OPT",             // injects CLI options (-M runs code)
      "PERL5LIB",             // module search path injection
      "PERLLIB",              // legacy module search path
      "PERL5DB",              // debugger command injection
      // Elixir/Erlang — eval injection
      "ERL_AFLAGS",           // prepends erl flags (-eval runs code)
      "ERL_FLAGS",            // appends erl flags
      "ELIXIR_ERL_OPTIONS",   // Elixir-specific erl flags
      "ERL_LIBS",             // beam file loading
      // Go — compiler/linker injection
      "GOFLAGS",              // injects go command flags
      "CGO_CFLAGS",           // C compiler flag injection
      "CGO_LDFLAGS",          // linker flag injection
      // Rust — compiler substitution
      "RUSTC",                // arbitrary compiler binary
      "RUSTC_WRAPPER",        // compiler wrapper injection
      "RUSTC_WORKSPACE_WRAPPER",
      "CARGO_BUILD_RUSTC",
      "CARGO_BUILD_RUSTC_WRAPPER",
      "RUSTFLAGS",            // compiler flag injection
      // PHP — config injection
      "PHPRC",                // auto_prepend_file → RCE
      "PHP_INI_SCAN_DIR",     // additional .ini loading
      // R — startup script injection
      "R_PROFILE",            // site-wide R profile
      "R_PROFILE_USER",       // user R profile
      "R_HOME",               // R installation override
      // .NET / C# — runtime/startup hooks, additional deps
      "DOTNET_STARTUP_HOOKS",       // injects managed assemblies on startup
      "DOTNET_ADDITIONAL_DEPS",     // additional .deps.json injection
      "DOTNET_SHARED_STORE",        // shared assembly probe path injection
      "DOTNET_ROOT",                // arbitrary .NET runtime override
      "DOTNET_ROOT(x86)",           // 32-bit override
      "DOTNET_HOST_PATH",           // host binary substitution
      // .NET / C# — profiler attach (loads arbitrary DLL into dotnet host)
      // and IPC-based debugger/IL injection. PR #546 follow-up.
      // learn.microsoft.com/en-us/dotnet/core/runtime-config/debugging-profiling
      "CORECLR_PROFILER",                 // CLSID of profiler to attach
      "CORECLR_PROFILER_PATH",            // path to profiler DLL
      "CORECLR_PROFILER_PATH_32",         // 32-bit specific profiler DLL
      "CORECLR_PROFILER_PATH_64",         // 64-bit specific profiler DLL
      "CORECLR_PROFILER_PATH_ARM32",      // ARM32 specific profiler DLL
      "CORECLR_PROFILER_PATH_ARM64",      // ARM64 specific profiler DLL
      "CORECLR_ENABLE_PROFILING",         // gates profiler load
      "DOTNET_PROFILER_PATH",             // cross-platform alias
      "DOTNET_PROFILER_PATH_32",
      "DOTNET_PROFILER_PATH_64",
      "DOTNET_PROFILER_PATH_ARM32",
      "DOTNET_PROFILER_PATH_ARM64",
      "DOTNET_DiagnosticPorts",           // peer attach via diagnostic IPC
      "DOTNET_BUNDLE_EXTRACT_BASE_DIR",   // single-file extraction hijack
      // Dynamic linker — shared library injection
      "LD_PRELOAD",           // loads .so before all others (Linux)
      "DYLD_INSERT_LIBRARIES", // macOS equivalent of LD_PRELOAD
      // OpenSSL — engine loading
      "OPENSSL_CONF",         // loads engine modules → .so exec
      "OPENSSL_ENGINES",      // engine directory override
      // Compiler — binary substitution
      "CC",                   // C compiler override
      "CXX",                  // C++ compiler override
      "AR",                   // archiver override
      // Git — command injection via hooks/config
      "GIT_TEMPLATE_DIR",     // hook injection on git init
      "GIT_CONFIG_GLOBAL",    // core.pager/editor runs commands
      "GIT_CONFIG_SYSTEM",    // system-level config injection
      "GIT_EXEC_PATH",        // substitute git subcommands
      "GIT_SSH",              // arbitrary command instead of ssh
      "GIT_SSH_COMMAND",      // arbitrary ssh command
      "GIT_ASKPASS",          // arbitrary credential command
    ]);

    // Start with parent env, then strip dangerous vars and apply overrides.
    // The `COMPlus_` prefix sweep covers every COMPlus_* synonym of the
    // DOTNET_* runtime knobs (.NET back-compat alias — case-insensitive).
    // PR #546 follow-up: closes the alias bypass for the explicit denylist
    // entries above.
    const env: Record<string, string> = {};
    for (const [key, val] of Object.entries(process.env)) {
      if (
        val !== undefined &&
        !DENIED.has(key) &&
        !key.startsWith("BASH_FUNC_") &&
        !/^COMPlus_/i.test(key)
      ) {
        env[key] = val;
      }
    }

    // Sandbox overrides — forced values for correct sandbox behavior
    env["TMPDIR"] = tmpDir;
    env["HOME"] = realHome;
    env["LANG"] = "en_US.UTF-8";
    env["PYTHONDONTWRITEBYTECODE"] = "1";
    env["PYTHONUNBUFFERED"] = "1";
    env["PYTHONUTF8"] = "1";
    env["NO_COLOR"] = "1";
    // Windows uses "Path" (not "PATH") — normalize to "PATH" for consistency
    if (isWin && !env["PATH"] && env["Path"]) {
      env["PATH"] = env["Path"];
      delete env["Path"];
    }
    if (!env["PATH"]) {
      env["PATH"] = isWin ? "" : "/usr/local/bin:/usr/bin:/bin";
    }

    // Windows-critical PATH fixes.
    if (isWin) {
      // Do not carry global MSYS path-conversion blockers into Git Bash.
      // Native Windows tools launched from bash (notably git.exe) need MSYS
      // to convert /tmp-style arguments to Windows paths so sibling tools see
      // the same filesystem location (#791).
      for (const key of Object.keys(env)) {
        const upper = key.toUpperCase();
        if (upper === "MSYS_NO_PATHCONV" || upper === "MSYS2_ARG_CONV_EXCL") {
          delete env[key];
        }
      }

      const gitUsrBin = "C:\\Program Files\\Git\\usr\\bin";
      const gitBin = "C:\\Program Files\\Git\\bin";
      if (!env["PATH"].includes(gitUsrBin)) {
        env["PATH"] = `${gitUsrBin};${gitBin};${env["PATH"]}`;
      }
    }

    // Ensure SSL_CERT_FILE is set so Python/Ruby HTTPS works in sandbox.
    if (!env["SSL_CERT_FILE"]) {
      const certPaths = isWin ? [] : [
        "/etc/ssl/cert.pem",                         // macOS, some Linux
        "/etc/ssl/certs/ca-certificates.crt",         // Debian/Ubuntu/Alpine
        "/etc/pki/tls/certs/ca-bundle.crt",           // RHEL/CentOS/Fedora
        "/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem", // Fedora alt
      ];
      for (const p of certPaths) {
        if (existsSync(p)) {
          env["SSL_CERT_FILE"] = p;
          break;
        }
      }
    }

    return env;
  }

  #wrapWithFileContent(
    absolutePath: string,
    language: Language,
    code: string,
  ): string {
    const escaped = JSON.stringify(absolutePath);
    switch (language) {
      case "javascript":
      case "typescript":
        return `const FILE_CONTENT_PATH = ${escaped};\nconst file_path = FILE_CONTENT_PATH;\nconst FILE_CONTENT = require("fs").readFileSync(FILE_CONTENT_PATH, "utf-8");\n${code}`;
      case "python":
        return `FILE_CONTENT_PATH = ${escaped}\nfile_path = FILE_CONTENT_PATH\nwith open(FILE_CONTENT_PATH, "r", encoding="utf-8") as _f:\n    FILE_CONTENT = _f.read()\n${code}`;
      case "shell": {
        // Single-quote the path to prevent $, backtick, and ! expansion
        const sq = "'" + absolutePath.replace(/'/g, "'\\''") + "'";
        return `FILE_CONTENT_PATH=${sq}\nfile_path=${sq}\nFILE_CONTENT=$(cat ${sq})\n${code}`;
      }
      case "ruby":
        return `FILE_CONTENT_PATH = ${escaped}\nfile_path = FILE_CONTENT_PATH\nFILE_CONTENT = File.read(FILE_CONTENT_PATH, encoding: "utf-8")\n${code}`;
      case "go":
        return `package main\n\nimport (\n\t"fmt"\n\t"os"\n)\n\nvar FILE_CONTENT_PATH = ${escaped}\nvar file_path = FILE_CONTENT_PATH\n\nfunc main() {\n\tb, _ := os.ReadFile(FILE_CONTENT_PATH)\n\tFILE_CONTENT := string(b)\n\t_ = FILE_CONTENT\n\t_ = fmt.Sprint()\n${code}\n}\n`;
      case "rust":
        return `#![allow(unused_variables)]\nuse std::fs;\n\nfn main() {\n    let file_content_path = ${escaped};\n    let file_path = file_content_path;\n    let file_content = fs::read_to_string(file_content_path).unwrap();\n${code}\n}\n`;
      case "php":
        return `<?php\n$FILE_CONTENT_PATH = ${escaped};\n$file_path = $FILE_CONTENT_PATH;\n$FILE_CONTENT = file_get_contents($FILE_CONTENT_PATH);\n${code}`;
      case "perl":
        return `my $FILE_CONTENT_PATH = ${escaped};\nmy $file_path = $FILE_CONTENT_PATH;\nopen(my $fh, '<:encoding(UTF-8)', $FILE_CONTENT_PATH) or die "Cannot open: $!";\nmy $FILE_CONTENT = do { local $/; <$fh> };\nclose($fh);\n${code}`;
      case "r":
        return `FILE_CONTENT_PATH <- ${escaped}\nfile_path <- FILE_CONTENT_PATH\nFILE_CONTENT <- readLines(FILE_CONTENT_PATH, warn=FALSE, encoding="UTF-8")\nFILE_CONTENT <- paste(FILE_CONTENT, collapse="\\n")\n${code}`;
      case "elixir":
        return `file_content_path = ${escaped}\nfile_path = file_content_path\nfile_content = File.read!(file_content_path)\n${code}`;
      case "csharp":
        // .csx forbids `using` directives after any other top-level statement
        // (CS1529). User code inside executeFile must use fully-qualified type
        // names (e.g. `System.Text.Json.JsonDocument`) instead of `using`.
        return `var FILE_CONTENT_PATH = ${escaped};\nvar file_path = FILE_CONTENT_PATH;\nvar FILE_CONTENT = System.IO.File.ReadAllText(FILE_CONTENT_PATH);\n${code}`;
    }
  }
}

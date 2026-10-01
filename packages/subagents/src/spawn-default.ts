import { spawn } from "node:child_process";
import { constants } from "node:os";
import type { Spawner, ChildHandle } from "./runner";
import { killProcessGroup, isProcessAlive, isProcessGroupAlive } from "./kill-process";
import { ownRpcChild } from "./rpc-child";
import { processStartTime, checkProcessIdentity } from "./process-identity";

const isWin = process.platform === "win32";

/** Real child-process spawner (production). NOT exercised in unit tests, which inject a fake. */
export const defaultSpawner: Spawner = (spec) => {
  const child = spawn(spec.argv[0], spec.argv.slice(1), {
    cwd: spec.cwd,
    env: { ...process.env, ...spec.env },
    stdio: spec.childMode === "rpc" ? ["pipe", "pipe", "pipe"] : "ignore",
    // On Unix give the child its OWN process group, so killing it also kills every
    // tool subprocess IT spawned. Without this, kill() signals only `pi` and orphans
    // the rest. Mirrors packages/context/src/executor.ts.
    detached: !isWin,
  });
  const startTime = child.pid === undefined ? null : processStartTime(child.pid);
  if (child.pid !== undefined && startTime === null) {
    try { spec.onRpcEvent?.({ type: "warning", message: "Process start identity unavailable: spawn-time capture returned no start time (unsupported platform or OS probe failure). Owned handle kill and shutdown remain available; pid-only signalling requires identity confirmation." }); } catch { /* diagnostics must not leak a spawned child */ }
  }
  // Attach 'exit'/'error' listeners EAGERLY (not lazily in wait()): runner.runAsync
  // detaches without ever calling wait(), so a lazy 'error' listener would leave an
  // async ENOENT unhandled → uncaught exception that crashes the host. Eager attachment
  // guarantees a handler on every path; the memoized promise settles once (idempotent).
  let settle!: (v: { exitCode: number; result?: string }) => void;
  const exit = new Promise<{ exitCode: number; result?: string }>((res) => { settle = res; });
  child.on("close", (code, signal) => {
    const failure = rpc?.failureReason();
    settle({ exitCode: failure ? code || 1 : code ?? (signal ? 128 + (constants.signals[signal] ?? 1) : 1), ...(failure ? { result: failure } : {}) });
  });
  child.on("error", (error) => settle({ exitCode: 1, ...(spec.childMode === "rpc" ? { result: `Child launch failed: ${error.message}` } : {}) }));
  const rpc = spec.childMode === "rpc" ? ownRpcChild(child, spec.prompt ?? "", spec.onRpcEvent) : undefined;
  const killAsync = async (graceMs?: number) => {
    if (child.pid === undefined) return;
    if (rpc) {
      const pipeGraceMs = graceMs ?? 250;
      await rpc.abort(pipeGraceMs);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([exit, new Promise(resolve => { timer = setTimeout(resolve, pipeGraceMs); })]); }
      finally { if (timer) clearTimeout(timer); }
    }
    await killProcessGroup(child.pid, { graceMs, canSignal: () => {
      if (child.exitCode === null && child.signalCode === null) return true;
      // A surviving group retains its pgid even after the leader has exited.
      // Do not authorize a new/reused live leader through this exception.
      if (!isWin && !isProcessAlive(child.pid!) && isProcessGroupAlive(child.pid!)) return true;
      return checkProcessIdentity(child.pid!, startTime).matches;
    } });
  };
  return {
    ...(rpc ? { steer: rpc.steer } : {}),
    pid: child.pid,
    startTime,
    wait() { return exit; },
    kill() {
      if (child.pid === undefined) return;
      // Fire-and-forget: kill() is sync by contract (session_shutdown calls it), but
      // the SIGTERM→SIGKILL escalation is inherently async.
      void killAsync().catch(error => { try { spec.onRpcEvent?.({ type: "warning", message: `Child termination unconfirmed: ${String(error)}` }); } catch {} });
    },
    killAsync(graceMs?: number) {
      if (child.pid === undefined) return Promise.resolve();
      // Awaitable kill: returns the killProcessGroup promise so the caller can wait
      // for SIGTERM → SIGKILL escalation to complete.
      return killAsync(graceMs);
    },
    detach() { child.unref(); },
  } as ChildHandle;
};

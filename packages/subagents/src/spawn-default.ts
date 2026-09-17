import { spawn } from "node:child_process";
import { constants } from "node:os";
import type { Spawner, ChildHandle } from "./runner";
import { killProcessGroup } from "./kill-process";

const isWin = process.platform === "win32";

/** Real child-process spawner (production). NOT exercised in unit tests, which inject a fake. */
export const defaultSpawner: Spawner = (spec) => {
  const child = spawn(spec.argv[0], spec.argv.slice(1), {
    cwd: spec.cwd,
    env: { ...process.env, ...spec.env },
    stdio: "ignore",
    // On Unix give the child its OWN process group, so killing it also kills every
    // tool subprocess IT spawned. Without this, kill() signals only `pi` and orphans
    // the rest. Mirrors packages/context/src/executor.ts.
    detached: !isWin,
  });
  // Attach 'exit'/'error' listeners EAGERLY (not lazily in wait()): runner.runAsync
  // detaches without ever calling wait(), so a lazy 'error' listener would leave an
  // async ENOENT unhandled → uncaught exception that crashes the host. Eager attachment
  // guarantees a handler on every path; the memoized promise settles once (idempotent).
  let settle!: (v: { exitCode: number; result?: string }) => void;
  const exit = new Promise<{ exitCode: number; result?: string }>((res) => { settle = res; });
  child.on("exit", (code, signal) => settle({
    exitCode: code ?? (signal ? 128 + (constants.signals[signal] ?? 1) : 1),
  }));
  child.on("error", () => settle({ exitCode: 1 }));
  return {
    pid: child.pid,
    wait() { return exit; },
    kill() {
      if (child.pid === undefined) return;
      // Fire-and-forget: kill() is sync by contract (session_shutdown calls it), but
      // the SIGTERM→SIGKILL escalation is inherently async.
      void killProcessGroup(child.pid).catch(() => { /* best-effort */ });
    },
    killAsync(graceMs?: number) {
      if (child.pid === undefined) return Promise.resolve();
      // Awaitable kill: returns the killProcessGroup promise so the caller can wait
      // for SIGTERM → SIGKILL escalation to complete.
      return killProcessGroup(child.pid, { graceMs }).catch(() => { /* best-effort */ });
    },
    detach() { child.unref(); },
  } as ChildHandle;
};

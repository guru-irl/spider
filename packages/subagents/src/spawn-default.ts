import { spawn } from "node:child_process";
import type { Spawner, ChildHandle } from "./runner";

/** Real child-process spawner (production). NOT exercised in unit tests, which inject a fake. */
export const defaultSpawner: Spawner = (spec): ChildHandle => {
  const child = spawn(spec.argv[0], spec.argv.slice(1), { cwd: spec.cwd, env: { ...process.env, ...spec.env }, stdio: "ignore" });
  // Attach 'exit'/'error' listeners EAGERLY (not lazily in wait()): runner.runAsync
  // detaches without ever calling wait(), so a lazy 'error' listener would leave an
  // async ENOENT unhandled → uncaught exception that crashes the host. Eager attachment
  // guarantees a handler on every path; the memoized promise settles once (idempotent).
  let settle!: (v: { exitCode: number; result?: string }) => void;
  const exit = new Promise<{ exitCode: number; result?: string }>((res) => { settle = res; });
  child.on("exit", (code) => settle({ exitCode: code ?? 0 }));
  child.on("error", () => settle({ exitCode: 1 }));
  return {
    pid: child.pid,
    wait() { return exit; },
    kill() { child.kill(); },
    detach() { child.unref(); },
  };
};

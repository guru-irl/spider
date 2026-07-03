import { spawn } from "node:child_process";
import type { Spawner, ChildHandle } from "./runner.js";

/** Real child-process spawner (production). NOT exercised in unit tests, which inject a fake. */
export const defaultSpawner: Spawner = (spec): ChildHandle => {
  const child = spawn(spec.argv[0], spec.argv.slice(1), { cwd: spec.cwd, env: { ...process.env, ...spec.env }, stdio: "ignore" });
  let exit: Promise<{ exitCode: number; result?: string }> | null = null;
  return {
    pid: child.pid,
    wait() {
      return (exit ??= new Promise((res) => child.on("exit", (code) => res({ exitCode: code ?? 0 }))));
    },
    kill() { child.kill(); },
    detach() { child.unref(); },
  };
};

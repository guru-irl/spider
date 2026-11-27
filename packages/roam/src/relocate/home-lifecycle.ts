import { join } from "node:path";
import { withProcessLock } from "@spider/herdr/sessions/registry";

export function withV0HomeLifecycle<T>(root: string, timeoutMs: number, run: () => Promise<T>): Promise<T> {
  return withProcessLock(join(root, "roam"), "v0-home-lifecycle", run, { timeoutMs });
}

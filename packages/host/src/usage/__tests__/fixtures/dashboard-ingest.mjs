import { isMainThread, parentPort, workerData } from "node:worker_threads";
import { resolve, sep } from "node:path";
import { UsageRuntime } from "../../runtime.ts";
import { bootUsageWorker } from "../../worker-entry.ts";

// Only the explicitly marked fixture process or its marked worker may boot.
if (!isMainThread && workerData?.spiderUsageWorker === 1 && parentPort) {
  await bootUsageWorker(parentPort, workerData.command, workerData.fixtureStuck
    ? { discover: () => new Promise(() => {}) } : {});
} else if (isMainThread && process.argv[2] === "fixture-pi") {
  const root = resolve(process.argv[3]);
  const allowed = resolve(process.env.SPIDER_GLOBAL_ROOT) + sep;
  if (!root.startsWith(allowed)) throw new Error("fixture-root-required");
  globalThis.fetch = async () => { throw new Error("fixture-network-forbidden"); };
  const runtime = new UsageRuntime({ bundleUrl: import.meta.url, child: false,
    roots: { registryDb: resolve(root, "registry.db"), sessionsDir: resolve(root, "sessions"),
      ledgerFile: resolve(root, "usage.db"), authPath: resolve(root, "auth.json"), leaseDir: resolve(root, "leases") },
    onSnapshot: snapshot => process.send?.(snapshot),
  });
  process.on("message", async message => {
    if (message === "stop") { await runtime.stop(); process.exit(0); }
  });
  runtime.start(false);
}

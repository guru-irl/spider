import "./no-network.mjs";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { parentPort, workerData } from "node:worker_threads";
const roots = workerData?.command?.roots;
if (parentPort && roots) {
  const original = fs.open;
  fs.open = function(path, ...args) {
    if (String(path).startsWith(roots.sessionsDir + "/")) parentPort.postMessage({ type: "fixture-source-read" });
    return original.call(this, path, ...args);
  };
  syncBuiltinESMExports();
}

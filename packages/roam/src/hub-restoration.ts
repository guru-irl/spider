import { randomUUID } from "node:crypto";
import { constants, openSync, writeSync, fsyncSync, closeSync, renameSync, watchFile, unwatchFile, type Stats } from "node:fs";
import { join } from "node:path";
import { privateDirectory } from "./staging";
import { assertTestConfigPath } from "@spider/db-core";
import type { RoamConfig } from "./contracts";
function marker(root: string): string { const path = join(root, "roam", "hub-restored"); assertTestConfigPath(path); return path; }
export function signalHubRestoration(root: string, config: Pick<RoamConfig, "enabled" | "hubMachineId">, senderMachine: string): void {
  if (!config.enabled || senderMachine !== config.hubMachineId) return;
  const path = marker(root); privateDirectory(join(root, "roam"));
  const scratch = `${path}.${randomUUID()}`;
  const fd = openSync(scratch, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { writeSync(fd, randomUUID()); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(scratch, path);
}
export function observeHubRestoration(root: string, listener: () => void, enabled: () => boolean, interval = 1000): () => void {
  const path = marker(root);
  const onChange = (current: Stats, prior: Stats) => {
    if (current.ino && (current.ino !== prior.ino || current.mtimeMs !== prior.mtimeMs) && enabled()) listener();
  };
  watchFile(path, { persistent: false, interval }, onChange);
  return () => unwatchFile(path, onChange);
}

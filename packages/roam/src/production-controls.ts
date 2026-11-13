import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { assertTestConfigPath } from "@spider/db-core";
import { storeScope } from "@spider/db-core/roam/codec";
import { enableMemoryCapture } from "@spider/db-core/roam/seed";
import type { JsonObject, StoreKey } from "@spider/db-core/roam/types";
import { withProcessLock, writePrivateJson } from "@spider/herdr/sessions/registry";
import type { Operation, Peer, RoamConfig, Transport } from "./contracts";
import { requestHubControl } from "./control-socket";
import { assertCompatibleConsumers } from "./diagnostics";
import { installHubService, removeHubService, type LaunchdPorts } from "./launchd";
import { createLocalDiagnosticPorts } from "./local-diagnostics";
import { homeChangeInProgress, loadHerdrConfig } from "./production-hub";
import { compatibleConsumerPorts } from "./remote-observations";
import { recheckWorktree } from "./recheck";
import { openLocalCore, readLocalIdentity } from "./runtime";
import { listStoreKeys } from "./store-inventory";
import { createStorePort } from "./stores";
import { createTransport } from "./transport";

export interface ControlResult { code: 0 | 1 | 2 | 3; reason: string }
const clean = (text: string) => text.replace(/[\u0000-\u001f\u007f]/g, "?").slice(0, 1000);
function launchctlBinary(): string {
  if (!process.env.SPIDER_TEST_FIXTURE_CHECKOUT) {
    if (process.platform !== "darwin") throw new Error("The hub service requires macOS");
    return "/bin/launchctl";
  }
  const file = process.env.SPIDER_TEST_ROAM_LAUNCHCTL;
  if (!file || !isAbsolute(file)) throw new Error("No isolated launchctl fixture");
  assertTestConfigPath(file);
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Unsafe launchctl fixture");
  return file;
}
function servicePorts(): LaunchdPorts {
  const binary = launchctlBinary();
  return { plistDir: join(homedir(), "Library", "LaunchAgents"), launchctl(argv) {
    return new Promise<void>((done, reject) => execFile(binary, [...argv], { timeout: 15_000, maxBuffer: 64 * 1024 }, (error, _stdout, stderr) => {
      if (!error) { done(); return; }
      if (argv[0] === "bootout" && /could not find|not loaded|no such process/i.test(stderr)) {
        reject(Object.assign(new Error("Service is not loaded"), { code: "service-not-loaded" })); return;
      }
      reject(new Error("Service manager request failed"));
    }));
  } };
}
async function writeEnabled(root: string, previous: RoamConfig, enabled: boolean): Promise<void> {
  const current = readLocalIdentity(root);
  if (JSON.stringify(current) !== JSON.stringify(previous)) throw new Error("Roaming configuration changed during the operation");
  const file = join(root, "roam", "config.json"), raw: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid roaming configuration");
  await writePrivateJson(file, { ...raw, enabled });
  if (readLocalIdentity(root).enabled !== enabled) throw new Error("Cannot verify roaming configuration");
}
async function locked<T>(root: string, config: RoamConfig, work: () => Promise<T>, key = "roam-configuration", timeoutMs = 5000): Promise<T> {
  const ports = createLocalDiagnosticPorts(root, []), local = { machineId: config.machineId, label: "local machine", peer: null };
  const probe = (pid: number) => ports.probeProcess(local, pid), self = await probe(process.pid);
  if (self.kind !== "live") throw new Error("Cannot verify the control process identity");
  return withProcessLock(join(root, "roam"), key, work,
    { identity: { pid: process.pid, startIdentity: self.startIdentity }, probe, timeoutMs });
}
async function agent(transport: Transport, peer: Peer, config: RoamConfig, kind: string, args: JsonObject): Promise<JsonObject> {
  const operation: Operation = { id: randomUUID(), machineId: peer.machineId, expectedEpoch: null, kind, args };
  const handle = await transport.resolve(peer);
  const bytes = await transport.exec(handle, ["roam", "agent", JSON.stringify(operation)],
    { timeoutMs: config.limits.controlMs, maxBytes: config.limits.replyBytes });
  const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid peer response");
  const result = value as { code?: unknown; operationId?: unknown; value?: unknown };
  if (result.operationId !== operation.id || result.code !== 0 || !result.value || typeof result.value !== "object" || Array.isArray(result.value))
    throw new Error("Peer refused or did not confirm the capture request");
  return result.value as JsonObject;
}
async function waitReady(file: string): Promise<boolean> {
  const end = Date.now() + 4000;
  while (Date.now() < end) {
    try { const result = await requestHubControl(file, { op: "status" }, { timeoutMs: 500 }); if (result.code === 0 && result.value?.enabled === true) return true; }
    catch { /* The service may still be starting. */ }
    await delay(50);
  }
  return false;
}

export async function enableRoaming(root: string, cli: string, bundleUrl?: URL): Promise<ControlResult> {
  let changed = false;
  try {
    const initial = readLocalIdentity(root);
    if (initial.role !== "hub") return { code: 1, reason: "Run this command on the Mac hub." };
    return await locked(root, initial, async () => {
      const config = readLocalIdentity(root), herdr = loadHerdrConfig(root);
      if (config.machineId !== initial.machineId || config.role !== "hub") throw new Error("Roaming configuration changed during the operation");
      const transport = createTransport({ binary: herdr.core.binary, env: process.env, enrolled: config.peers });
      await assertCompatibleConsumers(config, compatibleConsumerPorts(root, config, transport, bundleUrl));
      const ports = servicePorts();
      for (const peer of config.peers) {
        const discovery = await agent(transport, peer, config, "stores", {});
        if (discovery.protocol !== 1 || discovery.schema !== 14 || discovery.machineId !== peer.machineId || !Array.isArray(discovery.stores))
          throw new Error("Peer store inventory is unavailable");
        const keys = [...new Set(discovery.stores.map(key => { storeScope(key); return key as StoreKey; }))];
        if (!keys.includes("global")) throw new Error("Peer global store is unavailable");
        for (const key of keys.filter(key => storeScope(key) === "worktree")) {
          changed = true; await agent(transport, peer, config, "recheck-store", { storeKey: key });
        }
        for (const key of keys.filter(key => storeScope(key) !== "worktree")) {
          changed = true; await agent(transport, peer, config, "enable-capture", { storeKey: key });
        }
      }
      const local = openLocalCore(root);
      try {
        let incomplete = false;
        const keys = listStoreKeys(local.db, { onIncomplete: () => { incomplete = true; } });
        if (incomplete) throw new Error("Local store inventory is incomplete");
        const stores = createStorePort(config, local.db, { allowUnassignedGlobal: true });
        try {
          for (const key of keys.filter(key => storeScope(key) === "worktree")) {
            changed = true; recheckWorktree(stores.openStore(key).db);
          }
          for (const key of keys.filter(key => storeScope(key) !== "worktree")) {
            changed = true; enableMemoryCapture(stores.openStore(key).db, key);
          }
        } finally { stores.close(); }
      } finally { local.close(); }
      if (!config.enabled) { changed = true; await writeEnabled(root, config, true); }
      await installHubService({ node: process.execPath, cli, globalRoot: root }, ports);
      if (!await waitReady(join(root, "roam", "hub.sock"))) return { code: 3, reason: "Hub service startup is pending. Run spider roam doctor." };
      return { code: 0, reason: "Roaming hub enabled." };
    });
  } catch (error) {
    return { code: changed ? 3 : 1, reason: changed ? "Roaming enable needs reconciliation. Run spider roam doctor." : clean(error instanceof Error ? error.message : "Cannot enable roaming.") };
  }
}

export async function disableRoaming(root: string): Promise<ControlResult> {
  let changed = false;
  try {
    const initial = readLocalIdentity(root);
    if (initial.role !== "hub") return { code: 1, reason: "Run this command on the Mac hub." };
    return await locked(root, initial, async () => {
      const config = readLocalIdentity(root), socket = join(root, "roam", "hub.sock");
      const plist = join(homedir(), "Library", "LaunchAgents", "com.spider.roam.hub.plist");
      assertTestConfigPath(plist);
      let reply;
      try { reply = await requestHubControl(socket, { op: "disable" }); }
      catch (error) {
        if (config.enabled) throw error;
        // A prior disable may have persisted the flag before its service removal completed.
        // The hub lock and journal together prove that no scheduler or home change remains.
        return locked(root, config, async () => {
          if (homeChangeInProgress(join(root, "roam", "journal.db")) !== false)
            return { code: 3 as const, reason: "Cannot verify the hub is safe to disable. Run spider roam doctor." };
          if (existsSync(plist)) { changed = true; await removeHubService({ globalRoot: root }, servicePorts()); }
          return { code: 0 as const, reason: "Roaming hub disabled. Captures and homes were retained." };
        }, "roam-hub", 1000);
      }
      if (reply.code !== 0) return { code: reply.code, reason: clean(reply.reason) };
      changed = true;
      if (config.enabled) await writeEnabled(root, config, false);
      if (existsSync(plist)) await removeHubService({ globalRoot: root }, servicePorts());
      return { code: 0, reason: "Roaming hub disabled. Captures and homes were retained." };
    });
  } catch { return { code: 3, reason: changed ? "Hub disable needs reconciliation. Run spider roam doctor." : "Cannot verify the hub is safe to disable. Run spider roam doctor." }; }
}

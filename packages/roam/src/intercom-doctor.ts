import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { FEDERATION_NOTICE_ACK_FEATURE, HELPER_EXCHANGE_FEATURE } from "@spider/intercom/protocol";
import { migrateIntercomSettings } from "../../../scripts/intercom-switchover.mjs";
import type { Diagnostic, RoamConfig } from "./contracts";
import type { IntercomEnrollmentPair } from "./provision-contracts";
import { parseConnectorRecipe } from "./config";
import { createIntercomRegistry } from "./intercom-registry";
import { inspectPairUnit, type PairResourcePorts } from "./intercom-pair-resources";
import { pairPaths } from "./intercom-pair-files";
import { compareSshHostKey, inspectServedSshIdentity } from "./intercom-ssh-observation";
import { runForeground } from "./intercom-local-ops";
import { observeHelperFeatures, requestHelperInspect } from "./intercom-helper";
import { openDiagnosticSnapshot } from './diagnostic-snapshot';

interface DoctorOptions {
  root: string; config: RoamConfig; agentDir: string;
  run?: typeof runForeground;
  resourcePorts?: PairResourcePorts;
  inspectSsh?(pair: IntercomEnrollmentPair): ReturnType<typeof inspectServedSshIdentity>;
  features?(): Promise<readonly string[]>;
  link?(pair: IntercomEnrollmentPair, peer: string): Promise<{ status: string; reason: string | null }>;
}
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
function readOwned(file: string, maximum: number): string {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try { const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > maximum || typeof process.getuid === "function" && stat.uid !== process.getuid() ||
        process.platform !== "win32" && (stat.mode & 0o022) !== 0) throw new Error("unsafe-intercom-file");
    return readFileSync(fd, "utf8");
  } finally { closeSync(fd); }
}
/** Only categories and counts leave this read-only migration audit. */
export function inspectIntercomMigrationDiscards(file: string): Diagnostic[] {
  try {
    const db = openDiagnosticSnapshot(file);
    if (!db) return [];
    try {
      const columns = db.prepare("SELECT name FROM pragma_table_info('intercom_meta')").all() as { name: string }[];
      if (!columns.some(column => column.name === 'discard_counts')) return [];
      const row = db.prepare('SELECT discard_counts FROM intercom_meta WHERE id=1').get() as { discard_counts: string } | undefined;
      const value: unknown = row ? JSON.parse(row.discard_counts) : null;
      if (!record(value) || Object.entries(value).some(([category, count]) => !['origin-less-receipts', 'origin-less-revocation-notices'].includes(category) ||
          typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0)) throw new Error('invalid migration audit');
      return Object.entries(value).filter(([, count]) => (count as number) > 0).map(([category, count]) => ({
        severity: 'warning', reason: `intercom-migration-discard: ${category}=${count}`, repairCommand: null,
      }));
    } finally { db.close(); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    return [{ severity: 'warning', reason: 'intercom-migration-discard-inspection-unavailable', repairCommand: null }];
  }
}

/** An explicit doctor action may run only the operator's read-only connector check. */
export async function inspectLocalIntercomDoctor(input: DoctorOptions): Promise<Diagnostic[]> {
  const diagnostics = inspectIntercomMigrationDiscards(join(input.root, 'roam', 'intercom', 'queue.db'));
  if (!input.config.intercom.enabled) return diagnostics;
  const add = (reason: string, detail: string) => diagnostics.push({ severity: "warning", reason: `${reason}: ${detail}`, repairCommand: null });
  const run = input.run ?? runForeground, recipe = input.config.intercom.connector;
  if (!recipe) add("intercom-connector-recipe-missing", "Configure the machine-local connector recipe.");
  if (recipe) try {
    const parsed = parseConnectorRecipe(recipe), result = await run(parsed.check, { timeoutMs: 10_000, maxBytes: 16 * 1024 });
    const value: unknown = result.code === 0 ? JSON.parse(result.stdout) : null;
    if (!record(value) || !["ready", "missing", "unknown"].includes(String(value.connector)) || !["ready", "required", "unknown"].includes(String(value.login)) ||
        !["hosted", "unhosted", "unknown"].includes(String(value.tunnel)) || !["reachable", "unreachable", "unknown"].includes(String(value.peerPort))) {
      add("intercom-connector-check-invalid", "The connector check did not return valid status.");
    } else {
      if (value.connector === "missing") add("intercom-connector-missing", "Install the connector yourself.");
      if (value.login === "required") add("intercom-connector-sign-in-required", "Sign in to the connector yourself.");
      if (value.tunnel === "unhosted") add("intercom-tunnel-unhosted", "Host the tunnel before enrolling.");
      if (value.peerPort === "unreachable") add("intercom-peer-port-unreachable", "Make the peer SSH port reachable.");
    }
  } catch (error) { add((error as NodeJS.ErrnoException).code === "ENOENT" ? "intercom-connector-missing" : "intercom-connector-check-invalid", "The connector check is unavailable."); }
  try {
    const file = join(input.agentDir, "settings.json"), before = readOwned(file, 1024 * 1024);
    const roots = [join(input.agentDir, "npm", "node_modules", "pi-intercom"), join(input.agentDir, "node_modules", "pi-intercom")];
    if (JSON.stringify(JSON.parse(before)) !== JSON.stringify(JSON.parse(migrateIntercomSettings(before, roots, input.agentDir)))) {
      add("intercom-extension-duplicate", "A legacy intercom extension is still configured.");
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") add("intercom-extension-unknown", "Extension settings could not be inspected."); }
  try {
    const features = await (input.features ? input.features() : observeHelperFeatures(input.root));
    if (!features.includes(HELPER_EXCHANGE_FEATURE)) add("intercom-legacy-broker", "The broker does not offer the current helper protocol.");
    if (!features.includes(FEDERATION_NOTICE_ACK_FEATURE)) add("intercom-feature-missing", "The broker cannot confirm revocation notices.");
  } catch { add("intercom-broker-unavailable", "The local intercom broker could not be inspected."); }
  for (const item of await createIntercomRegistry(input.root).list()) {
    if (item.state !== "active" || !("sshUser" in item.pair)) continue;
    const pair = item.pair, localSource = pair.source.machineId === input.config.machineId, localTarget = pair.target.machineId === input.config.machineId;
    if (!localSource && !localTarget) continue;
    const unitPorts = input.resourcePorts ?? { root: input.root, machineId: input.config.machineId, home: homedir(), recipe, run };
    try {
      if (!item.resources || !await inspectPairUnit(pair, localSource ? "connect" : "host", unitPorts)) diagnostics.push({ severity: "block", reason: `intercom-pair-unit-unavailable: Verify the pair unit for ${pair.pairId}.`, repairCommand: null });
    } catch { diagnostics.push({ severity: "block", reason: `intercom-pair-unit-unavailable: The pair unit for ${pair.pairId} could not be verified.`, repairCommand: null }); }
    if (localSource && item.resources) try {
      const result = await run([pair.source.core, "machine", "ls", "--json"], { timeoutMs: 10_000, maxBytes: 64 * 1024 }), value: unknown = result.code === 0 ? JSON.parse(result.stdout) : null;
      if (!record(value) || !Array.isArray(value.machines)) throw new Error("intercom-route-unavailable");
      const route = item.resources.route, matches = value.machines.filter(row => record(row) && typeof row.name === "string" && row.name.toLowerCase().replace(/\.$/, "") === route.name);
      if (matches.length !== 1 || !record(matches[0]) || matches[0].name !== route.name || matches[0].id !== route.targetCoreId || matches[0].target !== route.via ||
          matches[0].via !== true || matches[0].session !== route.session || matches[0].temporary !== false) add("intercom-route-mismatch", `Verify the reserved route for ${pair.pairId}.`);
    } catch { add("intercom-route-unavailable", `The reserved route for ${pair.pairId} could not be inspected.`); }
    if (localTarget) try {
      const observed = input.inspectSsh ? await input.inspectSsh(pair) : await inspectServedSshIdentity({ machineId: input.config.machineId,
        sshUser: userInfo().username, keyscan: "/usr/bin/ssh-keyscan", sshPort: pair.connector.remotePort, run });
      if (observed.targetMachineId !== input.config.machineId || observed.sshUser !== pair.sshUser) add("intercom-ssh-user-changed", `Verify the account for ${pair.pairId}.`);
      if (compareSshHostKey(pair.hostKey, observed.hostKey) === "host-key-changed") add("host-key-changed", `Verify and re-enroll ${pair.pairId}.`);
    } catch { add("intercom-ssh-host-unavailable", `The SSH host identity for ${pair.pairId} could not be inspected.`); }
    if (localSource) try {
      const files = pairPaths(pair), key = lstatSync(files.privateKey), via = lstatSync(files.via);
      if (!key.isFile() || key.isSymbolicLink() || key.nlink !== 1 || typeof process.getuid === "function" && key.uid !== process.getuid() ||
          process.platform !== "win32" && (key.mode & 0o7777) !== 0o600) add("intercom-key-unsafe", `The pair key for ${pair.pairId} is unsafe.`);
      if (!via.isFile() || via.isSymbolicLink()) add("intercom-route-missing", `The pair route for ${pair.pairId} is unsafe.`);
      const known = readOwned(files.knownHosts, 16 * 1024).trim();
      if (known !== `${pair.hostKeyAlias} ${pair.hostKey.type} ${pair.hostKey.base64}`) add("host-key-changed", `Verify and re-enroll ${pair.pairId}.`);
    } catch { add("intercom-key-missing", `The pair files for ${pair.pairId} could not be inspected.`); }
    const peer = localSource ? pair.target.machineId : pair.source.machineId;
    try {
      const link = input.link ? await input.link(pair, peer) : await requestHelperInspect(input.root,
        { version: 1, action: "inspect-pair", machineId: input.config.machineId, peer, edgeEpoch: pair.edgeEpoch }, 2000);
      if (link.status !== "live") add("intercom-link-down", `The link for ${pair.pairId} is ${link.status}.`);
    } catch { add("intercom-link-down", `The link for ${pair.pairId} could not be inspected.`); }
  }
  return diagnostics;
}

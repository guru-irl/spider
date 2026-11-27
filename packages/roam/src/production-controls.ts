import { launchctlBinary } from "./service-manager";
import { resolveParticipantPi } from "./launcher";
import { causeCode, safeCauseCode, type CauseStep } from "./cause-codes";
import { agentFailureCode, AgentResponseError, peerPreflightIssue } from "./peer-errors";
import { setEnrolledPeerEnabled } from "./peer-enabled";
import { openJournal } from "./journal";
import { isRevoked, revokeMachine } from "./revocation";
import { readPendingMoves } from "./pending-moves";
import { parseDoctorReport, remoteDoctor } from "./remote-observations";
import { INTERCOM_UNIQUENESS_DESCRIPTION } from "./intercom-readiness";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { accessSync, constants, existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { waitReady } from "./hub-readiness";
import { assertTestConfigPath, openDb, openDbReadOnly } from "@spider/db-core";
import { storeScope } from "@spider/db-core/roam/codec";
import { enableMemoryCapture } from "@spider/db-core/roam/seed";
import type { JsonObject, StoreKey } from "@spider/db-core/roam/types";
import { withProcessLock, writePrivateJson } from "@spider/herdr/sessions/registry";
import { shellQuote } from "@spider/herdr/sessions/launch-environment";
import type { Diagnostic, Operation, Peer, RoamConfig, Transport } from "./contracts";
import { requestHubControl } from "./control-socket";
import { assertCompatibleConsumers } from "./diagnostics";
import { hubCoreSelection, hubServiceExists, hubServiceFile, installHubService, removeHubService, type LaunchdPorts } from "./launchd";
import { createLocalDiagnosticPorts, isPendingLaunchDiagnostic, localPendingLaunchDiagnostics } from "./local-diagnostics";
import { homeChangeInProgress, loadHerdrConfig } from "./production-hub";
import { compatibleConsumerPorts } from "./remote-observations";
import { recheckWorktree } from "./recheck";
import { openLocalCore, readLocalIdentity } from "./runtime";
import { listStoreKeys, parseUngathered } from "./store-inventory";
import { createStorePort } from "./stores";
import { createTransport, createProvisionTransport } from "./transport";
import { renderSupervisorUnit } from "./systemd";
import { installLocalV0Supervisor, localSupervisorInstallPorts, removeLocalSupervisor, type SupervisorInstallPorts } from "./relocate/service-install";
import { createHomeStore } from "./relocate/home";
import { withV0HomeLifecycle } from "./relocate/home-lifecycle";
import { localHerdrConnection } from "./relocate/local";

export interface ControlResult { code: 0 | 1 | 2 | 3; reason: string; message: string; causeCode?: string; operationId?: string; repairCommand?: string; nextStep?: string; issues?: readonly { reason: string; repairCommand: string; detail?: string; causeCode?: string; severity?: "warning" }[];
  information?: readonly { machine: string; reason: string }[] }
const clean = (text: string) => text.replace(/[\u0000-\u001f\u007f]/g, "?").slice(0, 1000);
function preflightCheck(reason: string): string {
  const detail = reason.replace(/^local machine:\s*/i, "");
  const named = /^([a-z][a-z0-9-]{0,79})(?::|$)/.exec(detail)?.[1];
  if (named) return named;
  if (/^PID [0-9]+ loaded build /.test(detail)) return "consumer-incompatible";
  if (detail === "Cannot read the process presence inventory. Run spider roam doctor.") return "consumer-inventory-unavailable";
  if (/^Bundled SQLite\b/i.test(detail)) return "sqlite-bundled";
  if (/^sqlite3 CLI\b/i.test(detail)) return "sqlite-cli";
  return detail.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || "doctor-check-unidentified";
}
function preflightDetail(reason: string): string | undefined {
  const detail = reason.replace(/^local machine:\s*/i, "");
  const pair = /^(intercom-fence-mismatch|intercom-revocation-unconfirmed): Pair ([A-Za-z0-9][A-Za-z0-9._-]{0,127})(?=[:\s])/.exec(detail);
  if (pair) return pair[1] === "intercom-fence-mismatch" ? `Pair ${pair[2]} does not match the current fence.` : `Pair ${pair[2]} has an unconfirmed revocation.`;
  const process = /^PID ([0-9]+) loaded build .+ without the required release or roaming schema [0-9]+\. Reload it\.$/.exec(detail);
  if (process) return `PID ${process[1]} loaded build incompatible with this release. Reload it.`;
  if (detail === "Cannot read the process presence inventory. Run spider roam doctor.") return detail;
  return undefined;
}
function servicePorts(): LaunchdPorts {
  const binary = launchctlBinary();
  type ServiceFailure = Error & { code: string; notLoaded: boolean };
  const invoke = (argv: readonly string[]) => new Promise<void>((done, reject) => execFile(binary, [...argv], { timeout: 15_000, maxBuffer: 64 * 1024 }, (error, stdout, stderr) => {
    if (!error) { done(); return; }
    const output = `${stdout}\n${stderr}`;
    const notLoaded = argv[0] === "print" && argv.length === 2 && !error.killed && !error.signal && error.code === 113 &&
      (!output.trim() || /could not find (?:the |specified )?service\b|\bnot loaded\b|\bno such process\b/i.test(output));
    const code = error.killed ? "service-timeout" : safeCauseCode(error.code) ?? "service-failed";
    reject(Object.assign(new Error("Service manager request failed"), { code, notLoaded } satisfies Pick<ServiceFailure, "code" | "notLoaded">));
  }));
  return { plistDir: join(homedir(), "Library", "LaunchAgents"), async launchctl(argv) {
    try { await invoke(argv); }
    catch (error) {
      if (argv[0] === "bootout" && argv.length === 3 && argv[2].endsWith(".plist")) {
        try { await invoke(["print", `${argv[1]}/${basename(argv[2], ".plist")}`]); }
        catch (probe) {
          if ((probe as ServiceFailure).notLoaded) throw Object.assign(new Error("Service is not loaded"), { code: "service-not-loaded" });
        }
      }
      throw error;
    }
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
export interface V0ServiceOptions {
  resolveCli(): string;
  launchd?: LaunchdPorts;
  systemd?: SupervisorInstallPorts;
}

async function pendingLegacyLaunchWarnings(root: string, config: RoamConfig): Promise<NonNullable<ControlResult["issues"]>> {
  const warning = (reason: string, detail: string, repairCommand: string) => ({ severity: "warning" as const, reason, detail: clean(detail), repairCommand });
  const pending = (machine: string, label: string, doctor: string, rows: readonly Diagnostic[]) => rows.filter(isPendingLaunchDiagnostic)
    .map(row => {
      const session = /^Session ([A-Za-z0-9._-]{1,96}): exact launch /.exec(row.reason)?.[1];
      const reason = `exact-launch:${machine}${session ? `:${session}` : ""}`;
      const repair = row.repairCommand && /^spider roam stop [A-Za-z0-9._-]+$/.test(row.repairCommand) ? row.repairCommand : doctor;
      return warning(reason, `${label}: ${row.reason}`, repair);
    });
  const issues = pending(config.machineId, "Local machine", "spider roam doctor", await localPendingLaunchDiagnostics({ root, machineId: config.machineId }));
  try {
    if (config.role !== "hub" || !config.peers.length) return issues;
    const file = join(root, "roam", "journal.db"), db = existsSync(file) ? openDbReadOnly(file) : null;
    let peers: readonly Peer[];
    try {
      if (!db && existsSync(file)) throw new Error("Cannot read peer revocations");
      peers = config.peers.filter(peer => !db || !isRevoked(db, peer.machineId));
    }
    finally { db?.close(); }
    if (!peers.length) return issues;
    const selection = hubCoreSelection(process.env);
    const env = { ...process.env, HC_SESSION: selection.session, HC_SOCKET: selection.socket };
    const transport = createTransport({ binary: loadHerdrConfig(root).core.binary, env, enrolled: peers });
    for (let offset = 0; offset < peers.length; offset += config.limits.peerConcurrency) {
      const batch = await Promise.all(peers.slice(offset, offset + config.limits.peerConcurrency).map(async peer => {
        const doctor = `spider roam doctor ${peer.machineId}`;
        try { return pending(peer.machineId, peer.alias, doctor, (await remoteDoctor(transport, peer, config)).diagnostics); }
        catch { return [warning(`legacy-launch-check-unavailable:${peer.machineId}`, `Could not check ${peer.alias} for pending legacy launches.`, doctor)]; }
      }));
      issues.push(...batch.flat());
    }
    return issues;
  } catch {
    return [...issues, warning("legacy-launch-check-unavailable", "Could not check peers for pending legacy launches.", "spider roam doctor")];
  }
}

async function v0DisableBlocker(root: string, config: RoamConfig): Promise<ControlResult | null> {
  const file = join(root, "spider.db");
  try { statSync(file); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT" && !config.enabled) return null; throw error; }
  const db = openDbReadOnly(file);
  if (!db) throw new Error("Could not read local session homes. Run spider roam doctor.");
  try {
    const meta = db.prepare("SELECT machine_id FROM roam_meta WHERE id=1").get() as { machine_id?: unknown } | undefined;
    if (meta?.machine_id !== config.machineId) throw new Error("Could not verify the local home database. Run spider roam doctor.");
    const homes = await createHomeStore({ db, localMachineId: config.machineId, hubMachineId: config.hubMachineId }).list();
    const moving = homes.find(home => home.state === "moving" &&
      (home.machineId === config.machineId || home.destination === config.machineId));
    if (!moving || moving.state !== "moving") return null;
    const id = /^[A-Za-z0-9._-]+$/.test(moving.sessionId) && !moving.sessionId.startsWith("-") ? moving.sessionId : shellQuote(moving.sessionId);
    const nextStep = `On the Mac, run spider roam relocate ${id} ${moving.destination} to finish, or spider roam relocate ${id} ${moving.machineId} to undo. If neither works and you have a verified backup, run spider roam set-home ${id} ${moving.machineId} --force.`;
    return { code: 1, reason: "v0-move-in-progress", operationId: moving.moveId, message: `Session ${moving.sessionId} is still moving. Roaming was not disabled.\n${nextStep}`, nextStep };
  } finally { db.close(); }
}

/** Public lifecycle: v0 is selected by role, never by the previous service or a stored mode. */
export async function configureV0Service(root: string, enabled: boolean, options: V0ServiceOptions): Promise<ControlResult> {
  const action = enabled ? "enable" : "disable", repairCommand = `spider roam ${action}`;
  const removed: string[] = [];
  let issues: ControlResult["issues"], changed = false;
  const warnings = () => (issues ?? []).map(issue => `Warning: ${issue.detail ?? issue.reason} (${issue.repairCommand})`);
  const information = () => removed.map(reason => ({ machine: "local", reason }));
  try {
    const initial = readLocalIdentity(root);
    return await locked(root, initial, async () => {
      let config = readLocalIdentity(root);
      if (config.machineId !== initial.machineId || config.role !== initial.role) throw new Error("Roaming configuration changed during the operation.");
      const setEnabled = async (next: boolean) => {
        if (config.enabled === next) return;
        changed = true;
        await writeEnabled(root, config, next);
        config = readLocalIdentity(root);
      };
      // Check every install input before removing a legacy service.
      const cli = enabled ? realpathSync(options.resolveCli()) : null;
      const pi = enabled ? resolveParticipantPi() : null;
      if (enabled && (!pi || !cli || !statSync(cli).isFile())) throw new Error("Install pi and the Spider CLI first.");
      const connection = enabled ? localHerdrConnection(root) : undefined;
      const hc = connection && isAbsolute(connection.binary) ? connection.binary : undefined;
      if (hc) {
        if (!statSync(hc).isFile()) throw new Error("The configured Herdr executable is not a file.");
        accessSync(hc, constants.X_OK);
      }
      if (enabled) issues = await pendingLegacyLaunchWarnings(root, config);
      else if (config.role === "hub") {
        const pending = readPendingMoves(join(root, "roam", "journal.db"));
        issues = pending?.map(({ operationId }) => ({ severity: "warning", reason: `legacy-move-pending:${operationId}`,
          detail: `Legacy move ${operationId} is still recorded as pending.`, repairCommand: `spider roam cancel ${operationId}` })) ?? [
          { severity: "warning", reason: "legacy-move-check-unavailable", detail: "Could not check for pending legacy moves.", repairCommand: "spider roam doctor" },
        ];
      }
      if (!enabled) {
        const blocker = await withV0HomeLifecycle(root, config.limits.controlMs, async () => {
          const refusal = await v0DisableBlocker(root, config);
          if (refusal) return refusal;
          await setEnabled(false);
          return null;
        });
        if (blocker) return blocker;
      }
      if (config.role === "hub") {
        if (enabled) hubCoreSelection(process.env);
        const ports = options.launchd ?? servicePorts();
        if (enabled && cli && pi) {
          prepareV0MemoryCapture(root);
          if (hubServiceExists(root, ports.plistDir)) {
            changed = true;
            await removeHubService({ globalRoot: root }, ports);
            removed.push("Removed the legacy roaming hub launchd service.");
          }
          changed = true;
          await installHubService({ node: process.execPath, cli, globalRoot: root, pi, hc, mode: "v0" }, ports);
          await setEnabled(true);
        } else {
          changed = true;
          await removeHubService({ globalRoot: root, mode: "v0" }, ports);
        }
      } else {
        const ports = options.systemd ?? localSupervisorInstallPorts();
        const supervisor = cli === null ? "/supervisor.mjs" : realpathSync(join(dirname(cli), "supervisor.mjs"));
        if (enabled && !statSync(supervisor).isFile()) throw new Error("Install the Spider supervisor first.");
        const herdr = connection && hc ? { binary: hc, ...hubCoreSelection(connection.env) } : undefined;
        const unit = renderSupervisorUnit({ node: process.execPath, supervisor, coreUnit: config.coreUnit, globalRoot: root,
          agentDir: connection?.env.PI_CODING_AGENT_DIR, pi: pi ?? undefined, mode: "v0", herdr,
          loginPath: enabled ? process.env.PATH : undefined });
        const rootLine = unit.split("\n").find(line => line.startsWith('Environment="SPIDER_GLOBAL_ROOT='))!;
        if (enabled) {
          prepareV0MemoryCapture(root);
          changed = true;
          const legacy = await removeLocalSupervisor(ports, rootLine, false);
          if (legacy) removed.push(`Removed the legacy roaming supervisor ${legacy}.`);
          await installLocalV0Supervisor(ports, rootLine, unit);
          await setEnabled(true);
        } else {
          changed = true;
          if (await removeLocalSupervisor(ports, rootLine, true)) await ports.run(["--user", "daemon-reload"]);
        }
      }
      const service = config.role === "hub" ? "hub" : "supervisor";
      return { code: 0, reason: enabled ? "roaming-enabled" : "roaming-disabled", information: information(), issues,
        message: [...removed, `Roaming v0 ${service} ${enabled ? "enabled" : "disabled"}.`, ...warnings()].join("\n") };
    });
  } catch (error) {
    return { code: changed ? 3 : 1, reason: `${action}-${changed ? "pending" : "unavailable"}`, repairCommand,
      information: information(), issues, message: [...removed, ...warnings(), clean(error instanceof Error ? error.message : "Cannot change the roaming service."), `Resolve the error, then retry ${repairCommand}.`].join("\n") };
  }
}

export async function forgetV0Peer(root: string, machineId: string): Promise<ControlResult> {
  try {
    const initial = readLocalIdentity(root);
    if (initial.role !== "hub") return { code: 1, reason: "mac-hub-required", message: "Run spider roam forget on the Mac." };
    return await locked(root, initial, async () => {
      const config = readLocalIdentity(root);
      if (config.role !== "hub" || config.machineId !== initial.machineId) throw new Error("Roaming configuration changed.");
      const peer = config.peers.find(peer => peer.machineId === machineId);
      if (!peer) return { code: 1, reason: "machine-not-enrolled", message: "Choose an enrolled box and retry spider roam forget." };
      const file = join(root, "roam", "journal.db");
      openJournal(file);
      const db = openDb(file, { fileMustExist: true, checkpointOnClose: false });
      try { revokeMachine(db, machineId); } finally { db.close(); }
      return { code: 0, reason: "machine-forgotten", message: `Forgot ${clean(peer.alias)}. Its session homes were not changed. If you have a Mac copy, use spider roam set-home <session> mac --force to recover it.` };
    });
  } catch {
    return { code: 3, reason: "forget-pending", message: "Could not confirm the box was forgotten. Check spider roam doctor and retry forget." };
  }
}

function prepareV0MemoryCapture(root: string): void {
  const core = openLocalCore(root);
  try {
    const stores = createStorePort(core.config, core.db, { allowUnassignedGlobal: true });
    try {
      for (const key of listStoreKeys(core.db)) if (storeScope(key) !== "worktree") enableMemoryCapture(stores.openStore(key).db, key);
    } finally { stores.close(); }
  } finally { core.close(); }
}

async function agent(transport: Transport, peer: Peer, config: RoamConfig, kind: Extract<CauseStep, "stores" | "recheck-store" | "enable-capture">, args: JsonObject): Promise<JsonObject> {
  const operation: Operation = { id: randomUUID(), machineId: peer.machineId, expectedEpoch: null, kind, args };
  const handle = await transport.resolve(peer);
  const bytes = await transport.exec(handle, ["roam", "agent", JSON.stringify(operation)],
    { timeoutMs: config.limits.controlMs, maxBytes: config.limits.replyBytes });
  const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid peer response");
  const result = value as { code?: unknown; reason?: unknown; operationId?: unknown; value?: unknown; causeCode?: unknown };
  if (result.operationId !== operation.id || ![0, 1, 2, 3].includes(result.code as number)) throw new AgentResponseError("peer-response-invalid");
  if (result.code !== 0) {
    const check = agentFailureCode(result.reason) ?? "agent-operation-failed";
    throw new AgentResponseError(check, check === "agent-operation-failed" ? safeCauseCode(result.causeCode) ?? causeCode(null, kind) : undefined);
  }
  if (!result.value || typeof result.value !== "object" || Array.isArray(result.value)) throw new AgentResponseError("peer-response-invalid");
  return result.value as JsonObject;
}
async function startPeerBroker(transport: Transport, peer: Peer, config: RoamConfig): Promise<Awaited<ReturnType<typeof remoteDoctor>>> {
  const handle = await transport.resolve(peer);
  const bytes = await transport.exec(handle, ["roam", "intercom", "start-broker"], { timeoutMs: config.limits.controlMs, maxBytes: config.limits.replyBytes });
  const invalid = () => Object.assign(new Error("Invalid broker startup response"), { code: "invalid-reply" });
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { throw invalid(); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  const result = value as Record<string, unknown>;
  if (result.version !== 1 || result.kind !== "intercom-broker-start") throw invalid();
  if (result.ok === false && Object.keys(result).length === 4) {
    const cause = safeCauseCode(result.causeCode);
    if (!cause) throw invalid();
    throw Object.assign(new Error("Broker startup failed"), { causeCode: cause });
  }
  if (Object.keys(result).length !== 5 || result.ok !== true || result.machineId !== peer.machineId) throw invalid();
  try { return parseDoctorReport(result.doctor); } catch { throw invalid(); }
}
export async function enableRoaming(root: string, resolveCli: () => string, bundleUrl?: URL): Promise<ControlResult> {
  let changed = false, step: CauseStep = "enable";
  try {
    const initial = readLocalIdentity(root);
    if (initial.role !== "hub") return { code: 1, reason: "mac-hub-required", message: "Run this command on the Mac hub." };
    const cli = resolveCli();
    const sourceEnv = { ...process.env }, selection = hubCoreSelection(sourceEnv);
    const env = Object.freeze({ ...sourceEnv, HC_SESSION: selection.session, HC_SOCKET: selection.socket });
    return await locked(root, initial, async () => {
      const config = readLocalIdentity(root), herdr = loadHerdrConfig(root);
      if (config.machineId !== initial.machineId || config.role !== "hub") throw new Error("Roaming configuration changed during the operation");
      const transport = createTransport({ binary: herdr.core.binary, env, enrolled: config.peers });
      const inventories: Array<{ peer: Peer; keys: StoreKey[] }> = [], failures: Array<{ reason: string; repairCommand: string; detail?: string; causeCode?: string }> = [];
      const information: Array<{ machine: string; reason: string }> = [];
      for (const peer of config.peers) {
        const name = clean(peer.alias), argument = /^[A-Za-z0-9_]/.test(peer.alias) ? name : peer.machineId;
        let discovery: JsonObject;
        try { discovery = await agent(transport, peer, config, "stores", {}); }
        catch (error) { failures.push(peerPreflightIssue(error, name, argument)); continue; }
        try {
          if (discovery.protocol !== 1 || discovery.schema !== 14 || discovery.machineId !== peer.machineId || !Array.isArray(discovery.stores)) throw new Error();
          const keys = [...new Set(discovery.stores.map(key => { storeScope(key); return key as StoreKey; }))];
          if (!keys.includes("global")) throw new Error();
          for (const store of parseUngathered(discovery.ungathered)) information.push({ machine: name, reason: `${store.code}:${store.key ?? store.scope}: ${clean(store.path).slice(0, 512)}` });
          inventories.push({ peer, keys });
        } catch { failures.push({ reason: `preflight-failed:${name}:store-inventory`, repairCommand: `spider roam provision ${argument}` }); }
        const brokerFailure = () => {
          const reason = `preflight-failed:${name}:intercom-broker`;
          if (!failures.some(item => item.reason === reason)) failures.push({ reason, repairCommand: `spider roam doctor ${argument}` });
        };
        try {
          const report = await remoteDoctor(transport, peer, config);
          for (const row of report.diagnostics.filter(item => item.severity === "warning")) {
            if (row.reason.startsWith("store-") || row.reason === INTERCOM_UNIQUENESS_DESCRIPTION || /^intercom-other-extension: [A-Za-z0-9@._/-]{1,128} \(not classified for intercom\)\.$/.test(row.reason))
              information.push({ machine: name, reason: row.reason });
          }
          for (const row of report.diagnostics.filter(item => item.severity === "block")) {
            if (row.reason === "intercom-federation: intercom-broker-unavailable." || row.reason.startsWith("intercom-legacy-drained: legacy-drained-offline ")) continue;
            if (/^(?:intercom-legacy-drained|intercom-federation): (?:intercom-broker-unavailable|intercom-broker-not-spider|intercom-agent-unsafe|intercom-directory-unsafe|intercom-socket-unsafe|federation-feature-missing)/.test(row.reason) ||
                row.reason.startsWith("intercom-readiness-unavailable:")) brokerFailure();
            const check = preflightCheck(row.reason), detail = preflightDetail(row.reason);
            failures.push({ reason: `preflight-failed:${name}:${check}`, repairCommand: isPendingLaunchDiagnostic(row) ? row.repairCommand ?? `spider roam doctor ${argument}` : row.reason.startsWith("store-") ? `spider roam doctor ${argument}` : `spider roam provision ${argument}`, ...(detail ? { detail } : {}) });
          }
        } catch (error) { failures.push(peerPreflightIssue(error, name, argument)); }
      }
      const infoText = () => information.map(item => `${item.machine}: ${item.reason}`).join("\n");
      if (failures.length) return { code: 1 as const, reason: failures[0].reason, issues: failures, information,
        message: [failures.map(item => `${item.reason}${item.detail ? `: ${item.detail}` : ""} (${item.repairCommand})`).join("; "), infoText()].filter(Boolean).join("\n") };
      const inventory = openLocalCore(root);
      try {
        listStoreKeys(inventory.db, { onUngathered: store => information.push({ machine: "local", reason: `${store.code}:${store.key ?? store.scope}: ${clean(store.path).slice(0, 512)}` }) });
      } finally { inventory.close(); }
      await assertCompatibleConsumers(config, compatibleConsumerPorts(root, config, transport, bundleUrl));
      const pi = resolveParticipantPi();
      if (!pi) return { code: 1 as const, reason: "participant-pi-unavailable", message: "participant-pi-unavailable: Install pi or set SPIDER_ROAM_PI, then rerun spider roam enable." };
      const ports = servicePorts();
      // All boxes and the hub have passed read-only preflight. Persistent services
      // start only after this proceed decision; failures from here are pending.
      for (const { peer } of inventories) {
        changed = true;
        const name = clean(peer.alias), repairCommand = `spider roam doctor ${/^[A-Za-z0-9_]/.test(peer.alias) ? name : peer.machineId}`;
        try {
          // Startup resolves settings before starting the broker and returns its
          // final health observation. Another doctor pass could outlive idle shutdown.
          const report = await startPeerBroker(transport, peer, config);
          const issues = report.diagnostics.filter(row => row.severity === "block").map(row => {
            const evidence = /^(?:intercom-legacy-drained|intercom-federation|intercom-settings-unique): ([a-z][a-z0-9-]+)/.exec(row.reason)?.[1];
            return { reason: `preflight-failed:${name}:${preflightCheck(row.reason)}`, repairCommand,
              causeCode: safeCauseCode(evidence) ?? "broker-readiness-unconfirmed" };
          });
          if (issues.length) return { code: 3 as const, reason: issues[0].reason, causeCode: issues[0].causeCode, issues, information,
            message: issues.map(issue => `${issue.reason}: Broker startup readiness failed (${issue.causeCode}); enable needs reconciliation (${repairCommand}).`).join("; ") };
        } catch (error) {
          const reason = `preflight-failed:${name}:intercom-broker`, cause = causeCode(error, "enable-broker");
          return { code: 3 as const, reason, causeCode: cause, issues: [{ reason, repairCommand, causeCode: cause }], information,
            message: `${reason}: Broker startup failed (${cause}); enable needs reconciliation (${repairCommand}).` };
        }
      }
      for (const { peer, keys } of inventories) {
        for (const key of keys.filter(key => storeScope(key) === "worktree")) {
          step = "enable-peer-capture"; changed = true; await agent(transport, peer, config, "recheck-store", { storeKey: key });
        }
        for (const key of keys.filter(key => storeScope(key) !== "worktree")) {
          step = "enable-peer-capture"; changed = true; await agent(transport, peer, config, "enable-capture", { storeKey: key });
        }
      }
      step = "enable-local-capture";
      const local = openLocalCore(root);
      try {
        const keys = listStoreKeys(local.db);
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
      if (config.peers.length) {
        const journal = openJournal(join(root, "roam", "journal.db"));
        const provisioning = createProvisionTransport({ binary: herdr.core.binary, env, enrolled: config.peers }, journal);
        step = "enable-peer-flag";
        for (const peer of config.peers) { changed = true; await setEnrolledPeerEnabled({ config, peer, enabled: true, restoreAutostart: true, journal, transport: provisioning }); }
      }
      step = "enable-config";
      if (!config.enabled) { changed = true; await writeEnabled(root, config, true); }
      step = "enable-service";
      await installHubService({ node: process.execPath, cli, globalRoot: root, pi, env }, ports);
      if (!await waitReady(join(root, "roam", "hub.sock"))) return { code: 3, reason: "hub-startup-pending", information, message: ["Hub service startup is pending. Run spider roam doctor.", infoText()].filter(Boolean).join("\n") };
      return { code: 0, reason: "roaming-enabled", information, message: ["Roaming hub enabled. Reload open pi sessions (/reload) to pick up /move.", infoText()].filter(Boolean).join("\n") };
    });
  } catch (error) {
    const cause = causeCode(error, step);
    return { code: changed ? 3 : 1, reason: changed ? "enable-pending" : "enable-unavailable",
      ...(changed ? { causeCode: cause } : {}),
      message: changed ? `Roaming enable needs reconciliation (${cause}). Resolve the cause, then retry spider roam enable.` : clean(error instanceof Error ? error.message : "Cannot enable roaming.") };
  }
}

function pendingPeerDisable(file: string, peer: Peer): string | undefined {
  const db = openDbReadOnly(file);
  if (!db) throw new Error("peer-enabled-unconfirmed");
  try {
    const row = db.prepare(`SELECT o.operation_id, o.result_json, a.result_json AS consent
      FROM roam_operations o JOIN roam_operation_actions a ON a.operation_id=o.operation_id
      WHERE o.kind='explicit-participant-control' AND o.machine_id=? AND a.action='provision-consent'
      ORDER BY a.seq DESC LIMIT 1`).get(peer.machineId) as { operation_id: string; result_json: string | null; consent: string } | undefined;
    if (!row || row.result_json !== null) return undefined;
    const consent = JSON.parse(row.consent) as JsonObject;
    return consent.approved === true && consent.scope === "roaming-enabled" && consent.target === peer.alias &&
      consent.machineId === peer.machineId && consent.enabled === false && consent.restoreAutostart !== true ? row.operation_id : undefined;
  } finally { db.close(); }
}

export async function disableRoaming(root: string): Promise<ControlResult> {
  let changed = false, step: CauseStep = "disable";
  try {
    const initial = readLocalIdentity(root);
    if (initial.role !== "hub") return { code: 1, reason: "mac-hub-required", message: "Run this command on the Mac hub." };
    return await locked(root, initial, async () => {
      const config = readLocalIdentity(root), socket = join(root, "roam", "hub.sock"), journalFile = join(root, "roam", "journal.db");
      const pendingMove = readPendingMoves(journalFile)?.[0];
      if (pendingMove) return { code: 1, reason: `move-in-progress:${pendingMove.operationId}`, operationId: pendingMove.operationId,
        repairCommand: `spider roam cancel ${pendingMove.operationId}`, message: `Move ${pendingMove.operationId} is pending at ${pendingMove.step}. Run spider roam cancel ${pendingMove.operationId} before disabling roaming.` };
      const plistDir = join(homedir(), "Library", "LaunchAgents"), plist = hubServiceFile(root, plistDir);
      assertTestConfigPath(plist);
      const servicePresent = () => hubServiceExists(root, plistDir);
      const finish = async (): Promise<ControlResult> => {
        // Unload KeepAlive before publishing the disabled flag, so a failed unload can be retried.
        if (servicePresent()) { step = "disable-service"; changed = true; await removeHubService({ globalRoot: root }, servicePorts()); }
        if (config.enabled) { step = "disable-config"; changed = true; await writeEnabled(root, config, false); }
        const unconfirmed: string[] = [];
        if (config.peers.length) {
          try {
            const herdr = loadHerdrConfig(root), journal = openJournal(journalFile);
            const provisioning = createProvisionTransport({ binary: herdr.core.binary, env: process.env, enrolled: config.peers }, journal);
            for (const peer of config.peers) {
              try { await setEnrolledPeerEnabled({ config, peer, enabled: false, operationId: pendingPeerDisable(journalFile, peer), journal, transport: provisioning }); }
              catch { unconfirmed.push(peer.alias); }
            }
          } catch { unconfirmed.push(...config.peers.map(peer => peer.alias)); }
        }
        if (unconfirmed.length) return { code: 3, reason: "roaming-disabled-partial",
          message: `Mac roaming is disabled. Box flags unconfirmed: ${unconfirmed.map(clean).join(", ")}. Captures and homes were retained. Retry spider roam disable. Reload open pi sessions (/reload) to pick up /move.`,
          issues: unconfirmed.map(name => ({ reason: `peer-enabled-unconfirmed:${clean(name)}`, repairCommand: "spider roam disable" })) };
        return { code: 0, reason: "roaming-disabled", message: "Roaming hub disabled. Captures and homes were retained. Reload open pi sessions (/reload) to pick up /move.", issues: [] };
      };
      let reply;
      try { reply = await requestHubControl(socket, { op: "disable" }); }
      catch {
        // A missing journal proves a no-op only for a disabled hub with no service.
        return locked(root, config, async () => {
          const hasJournal = existsSync(journalFile), moving = hasJournal ? homeChangeInProgress(journalFile) : null;
          if (moving === true) return { code: 1 as const, reason: 'home-change-in-progress', repairCommand: 'spider roam doctor', message: 'A home change is pending. Finish its session action before disabling roaming. Run spider roam doctor.' };
          if (hasJournal ? moving !== false : config.enabled || servicePresent())
            return { code: 3 as const, reason: "disable-safety-unverified", repairCommand: "spider roam doctor", message: "Cannot verify the hub is safe to disable. Run spider roam doctor." };
          return finish();
        }, "roam-hub", 1000);
      }
      if (reply.code !== 0) return { code: reply.code, reason: /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/.test(reply.reason) ? reply.reason : "disable-refused",
        operationId: reply.operationId, repairCommand: reply.repairCommand ?? "spider roam doctor",
        message: clean(reply.reason) || "The hub refused disable. Run spider roam doctor." };
      return finish();
    });
  } catch (error) {
    const cause = causeCode(error, step);
    return { code: 3, reason: changed ? "disable-pending" : "disable-safety-unverified", repairCommand: changed ? "spider roam disable" : "spider roam doctor", ...(changed ? { causeCode: cause } : {}),
      message: changed ? `Hub disable needs reconciliation (${cause}). Resolve the cause, then retry spider roam disable.` : "Cannot verify the hub is safe to disable. Run spider roam doctor." };
  }
}

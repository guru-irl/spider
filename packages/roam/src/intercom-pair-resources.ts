import { constants, closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { isAbsolute, join, posix, resolve } from "node:path";
import type { IntercomConnectorRecipe } from "./contracts";
import type { IntercomEnrollmentPair, IntercomHostStopEvidence } from "./provision-contracts";
import { parseConnectorRecipe } from "./config";
import { pairPaths } from "./intercom-pair-files";
import { createIntercomRegistry, withIntercomPeerLock } from "./intercom-registry";
import { probeIntercomProcess, type NativeProcess } from "./intercom-exclusion";
import { withProcessLock } from "@spider/herdr/sessions/registry";

export interface IntercomPairResources {
  hostUnit: string; connectUnit: string;
  route: { name: string; targetCoreId: string; via: string; session: string; temporary: false };
  publicKey?: string;
}
export interface IntercomUnitRecord {
  name: string; file: string; contents: string; localPort: number;
  main: { pid: number; startIdentity: string; controlGroup: string } | null;
  closedFenceId: string | null;
}
export interface PairResourcePorts {
  machineId: string; root: string; home: string; recipe?: IntercomConnectorRecipe; systemctl?: string;
  run(argv: readonly string[], options: { timeoutMs: number; maxBytes: number }): Promise<{ code: number; stdout: string }>;
  process?(pid: number): NativeProcess;
  cgroup?(path: string): readonly number[];
}
const options = { timeoutMs: 10_000, maxBytes: 1024 * 1024 };
const unitName = (pairId: string, side: "host" | "connect") => `spider-pair-${pairId}-${side}.service`;
export function pairResources(pair: IntercomEnrollmentPair, targetCoreId: string): IntercomPairResources {
  return { hostUnit: unitName(pair.pairId, "host"), connectUnit: unitName(pair.pairId, "connect"),
    route: { name: `spider-pair-${pair.pairId}`, targetCoreId, via: pairPaths(pair).via, session: pair.connector.session, temporary: false } };
}
export function pairScopedRecipe(recipe: IntercomConnectorRecipe | undefined): boolean {
  if (!recipe) return false;
  const parsed = parseConnectorRecipe(recipe);
  return parsed.host.slice(1).includes("{pairId}") && parsed.connect.slice(1).includes("{pairId}");
}
export function pairLocalPort(recipe: IntercomConnectorRecipe, pairId: string): number { return recipe.pairPorts?.[pairId] ?? recipe.localPort; }
function quote(value: string): string { return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%").replace(/\$/g, () => "$$")}"`; }
function unitContents(pair: IntercomEnrollmentPair, side: "host" | "connect", recipe: IntercomConnectorRecipe): string {
  const substitutions: Record<string, string> = { pairId: pair.pairId, tunnelId: pair.connector.tunnelId, remotePort: String(pair.connector.remotePort), localPort: String(pairLocalPort(recipe, pair.pairId)) };
  const argv = recipe[side].map(arg => arg.replace(/\{([^{}]+)\}/g, (_match, key: string) => {
    if (!Object.hasOwn(substitutions, key)) throw new Error("intercom-connector-recipe-invalid"); return substitutions[key];
  }));
  return `[Unit]\nDescription=Spider pair connector\n\n[Service]\nType=simple\nExecStart=${argv.map(quote).join(" ")}\nKillMode=control-group\nRestart=no\nTimeoutStopSec=5\nSendSIGKILL=yes\n\n[Install]\nWantedBy=default.target\n`;
}
function safe(info: { uid: number; mode: number }): boolean {
  return (process.getuid === undefined || info.uid === process.getuid()) && (process.platform === "win32" || (info.mode & 0o022) === 0);
}
function readUnit(file: string): string {
  const info = lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || !safe(info) || info.size > 64 * 1024 || (info.mode & 0o7777) !== 0o600) throw new Error("intercom-unit-mismatch");
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try { return readFileSync(fd, "utf8"); } finally { closeSync(fd); }
}
function unitFile(home: string, name: string, create: boolean): string {
  if (!isAbsolute(home) || resolve(home) !== home || realpathSync(home) !== home) throw new Error("intercom-unit-mismatch");
  let directory = home;
  for (const component of [".config", "systemd", "user"]) {
    directory = join(directory, component);
    if (create) try { mkdirSync(directory, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    const info = lstatSync(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || !safe(info)) throw new Error("intercom-unit-mismatch");
  }
  return join(directory, name);
}
function publishUnit(file: string, contents: string): void {
  try { if (readUnit(file) !== contents) throw new Error("intercom-unit-mismatch"); return; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const temporary = `${file}.${randomUUID()}`;
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, contents); fsyncSync(fd); } finally { closeSync(fd); }
  try { renameSync(temporary, file); } finally { try { unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } }
  const directory = openSync(join(file, ".."), constants.O_RDONLY | constants.O_DIRECTORY); try { fsyncSync(directory); } finally { closeSync(directory); }
}
interface UnitObservation { state: "active" | "inactive" | "failed"; pid: number; controlGroup: string }
async function showUnit(unit: IntercomUnitRecord, ports: PairResourcePorts): Promise<UnitObservation> {
  if (unit.file !== unitFile(ports.home, unit.name, false) || readUnit(unit.file) !== unit.contents) throw new Error("intercom-unit-mismatch");
  const result = await ports.run([ports.systemctl ?? "/usr/bin/systemctl", "--user", "show", unit.name,
    "--property=Id,ActiveState,MainPID,ControlGroup,KillMode,FragmentPath,DropInPaths,NeedDaemonReload", "--all"], options);
  if (result.code !== 0 || Buffer.byteLength(result.stdout) > options.maxBytes) throw new Error("intercom-unit-unavailable");
  const values: Record<string, string> = Object.create(null);
  for (const line of result.stdout.trimEnd().split("\n")) {
    const at = line.indexOf("="); if (at < 1 || Object.hasOwn(values, line.slice(0, at))) throw new Error("intercom-unit-mismatch");
    values[line.slice(0, at)] = line.slice(at + 1);
  }
  if (values.Id !== unit.name || values.KillMode !== "control-group" || values.FragmentPath !== unit.file || values.DropInPaths !== "" || values.NeedDaemonReload !== "no") throw new Error("intercom-unit-mismatch");
  if (!["active", "inactive", "failed"].includes(values.ActiveState) || !/^(0|[1-9][0-9]*)$/.test(values.MainPID) || !Number.isSafeInteger(Number(values.MainPID))) throw new Error("intercom-unit-unavailable");
  const group = values.ControlGroup;
  if (group !== "" && (!posix.isAbsolute(group) || posix.normalize(group) !== group || group === "/" || /[\u0000-\u001f\u007f]/.test(group))) throw new Error("intercom-unit-mismatch");
  return { state: values.ActiveState as UnitObservation["state"], pid: Number(values.MainPID), controlGroup: group };
}
function nativeProcess(pid: number): NativeProcess {
  const observed = probeIntercomProcess(pid);
  if (observed.kind !== "live" || process.platform !== "linux") return observed;
  try { return { kind: "live", startIdentity: `${readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()}:${observed.startIdentity}` }; } catch { return { kind: "unknown" }; }
}
/** Read every descendant, not just the unit's top-level cgroup.procs. Failure supplies no proof. */
export interface PairCgroupReader { present(group: string): boolean; processes(group: string): string; directories(group: string): readonly string[] }
export function pairCgroupProcesses(group: string, reader?: PairCgroupReader): readonly number[] {
  if (!reader && process.platform !== "linux" || !posix.isAbsolute(group) || posix.normalize(group) !== group || group === "/" || /[\u0000-\u001f\u007f]/.test(group)) throw new Error("intercom-cgroup-unavailable");
  const files: PairCgroupReader = reader ?? {
    present(path) { try { const stat = lstatSync(`/sys/fs/cgroup${path}`); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("intercom-cgroup-unavailable"); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; } },
    processes: path => readFileSync(`/sys/fs/cgroup${path}/cgroup.procs`, "utf8"),
    directories: path => readdirSync(`/sys/fs/cgroup${path}`, { withFileTypes: true }).filter(item => item.isDirectory()).map(item => item.name),
  };
  const pids = new Set<number>(); let count = 0, totalBytes = 0;
  const walk = (directory: string) => {
    if (++count > 1024) throw new Error("intercom-cgroup-unavailable");
    const contents = files.processes(directory);
    totalBytes += Buffer.byteLength(contents); if (totalBytes > options.maxBytes) throw new Error("intercom-cgroup-unavailable");
    for (const pid of contents.split(/\s+/).filter(Boolean)) {
      if (!/^[1-9][0-9]*$/.test(pid) || !Number.isSafeInteger(Number(pid))) throw new Error("intercom-cgroup-unavailable"); pids.add(Number(pid));
    }
    for (const name of files.directories(directory)) {
      if (!name || name === "." || name === ".." || name.includes("/") || /[\u0000-\u001f\u007f]/.test(name)) throw new Error("intercom-cgroup-unavailable");
      walk(posix.join(directory, name));
    }
  };
  if (!files.present(group)) return [];
  walk(group); return [...pids];
}
function members(group: string, ports: PairResourcePorts): readonly number[] {
  const pids = (ports.cgroup ?? pairCgroupProcesses)(group);
  if (!Array.isArray(pids) || pids.some(pid => !Number.isSafeInteger(pid) || pid < 1)) throw new Error("intercom-cgroup-unavailable"); return pids;
}
export async function ensurePairUnit(pair: IntercomEnrollmentPair, side: "host" | "connect", ports: PairResourcePorts): Promise<{ status: "ready" | "connector-not-pair-scoped" }> {
  if (!pairScopedRecipe(ports.recipe)) return { status: "connector-not-pair-scoped" };
  const local = side === "host" ? pair.target : pair.source;
  if (local.machineId !== ports.machineId || local.globalRoot !== ports.root) throw new Error("machine-mismatch");
  return withProcessLock(join(ports.root, "roam", "intercom"), `unit-${pair.pairId}`, async () => {
    const registry = createIntercomRegistry(ports.root), record = await registry.get(pair.pairId), name = unitName(pair.pairId, side);
    if (!record?.resources || !["pending", "active"].includes(record.state) || record.pair.edgeEpoch !== pair.edgeEpoch || record.resources[side === "host" ? "hostUnit" : "connectUnit"] !== name) throw new Error("connector-not-pair-scoped");
    const parsed = parseConnectorRecipe(ports.recipe), localPort = pairLocalPort(parsed, pair.pairId);
    const file = unitFile(ports.home, name, true), contents = unitContents(pair, side, parsed);
    const unit = record.unit ?? { name, file, contents, localPort, main: null, closedFenceId: null };
    if (unit.name !== name || unit.file !== file || unit.contents !== contents || unit.localPort !== localPort || unit.closedFenceId !== null) throw new Error("intercom-unit-mismatch");
    await registry.recordUnit(pair.pairId, unit); publishUnit(file, contents);
    if ((await ports.run([ports.systemctl ?? "/usr/bin/systemctl", "--user", "daemon-reload"], options)).code !== 0) throw new Error("intercom-unit-unavailable");
    await showUnit(unit, ports);
    if ((await ports.run([ports.systemctl ?? "/usr/bin/systemctl", "--user", "enable", name], options)).code !== 0) throw new Error("intercom-unit-unavailable");
    let current = await showUnit(unit, ports);
    if (current.state !== "active") {
      if ((await ports.run([ports.systemctl ?? "/usr/bin/systemctl", "--user", "start", name], options)).code !== 0) throw new Error("intercom-unit-unavailable");
      current = await showUnit(unit, ports);
    }
    const process = (ports.process ?? nativeProcess)(current.pid);
    if (current.state !== "active" || current.pid < 1 || !current.controlGroup || process.kind !== "live" || !members(current.controlGroup, ports).includes(current.pid)) throw new Error("intercom-unit-unavailable");
    await registry.recordUnit(pair.pairId, { ...unit, main: { pid: current.pid, startIdentity: process.startIdentity, controlGroup: current.controlGroup } });
    return { status: "ready" };
  });
}
export async function inspectPairUnit(pair: IntercomEnrollmentPair, side: "host" | "connect", ports: PairResourcePorts): Promise<boolean> {
  const record = await createIntercomRegistry(ports.root).get(pair.pairId), unit = record?.unit;
  if (!record?.resources || !unit || unit.name !== unitName(pair.pairId, side)) return false;
  if (ports.recipe && (unit.localPort !== pairLocalPort(parseConnectorRecipe(ports.recipe), pair.pairId) || unit.contents !== unitContents(pair, side, parseConnectorRecipe(ports.recipe)))) return false;
  const current = await showUnit(unit, ports), process = (ports.process ?? nativeProcess)(current.pid);
  return current.state === "active" && current.pid > 0 && process.kind === "live" && !!current.controlGroup && members(current.controlGroup, ports).includes(current.pid);
}
/** Reconcile active pair records without creating, replacing, or reviving foreign or fenced units. */
export async function reconcilePairUnits(ports: PairResourcePorts): Promise<void> {
  const registry = createIntercomRegistry(ports.root);
  for (const observed of await registry.list()) {
    if (observed.state !== "active" || !("sshUser" in observed.pair)) continue;
    const pair = observed.pair;
    const side = pair.source.machineId === ports.machineId ? "connect" : pair.target.machineId === ports.machineId ? "host" : null;
    if (!side || (side === "connect" ? pair.source.globalRoot : pair.target.globalRoot) !== ports.root) continue;
    await withIntercomPeerLock(ports.root, pair.source.machineId, pair.target.machineId, async () => {
      const current = await registry.get(pair.pairId);
      if (!current || current.state !== "active") return;
      if (!("sshUser" in current.pair) || current.pair.edgeEpoch !== pair.edgeEpoch ||
          current.pair.source.machineId !== pair.source.machineId || current.pair.target.machineId !== pair.target.machineId) throw new Error("intercom-pair-conflict");
      const peer = side === "connect" ? pair.target.machineId : pair.source.machineId;
      if (current.fenceId !== null || await registry.revocationPending(pair.pairId, peer)) throw new Error("revocation-pending");
      if (!current.resources || !current.unit || current.unit.closedFenceId !== null) throw new Error("intercom-unit-unavailable");
      if (await inspectPairUnit(current.pair, side, ports)) return;
      if ((await ensurePairUnit(current.pair, side, ports)).status !== "ready") throw new Error("connector-not-pair-scoped");
    });
  }
}

export async function stopPairUnit(pair: IntercomEnrollmentPair, side: "host" | "connect", fenceId: string, ports: PairResourcePorts): Promise<IntercomHostStopEvidence> {
  const local = side === "host" ? pair.target : pair.source;
  if (local.machineId !== ports.machineId || local.globalRoot !== ports.root) throw new Error("machine-mismatch");
  return withProcessLock(join(ports.root, "roam", "intercom"), `unit-${pair.pairId}`, async () => {
    const registry = createIntercomRegistry(ports.root), record = await registry.get(pair.pairId); let unit = record?.unit;
    if (!record?.resources || record.fenceId !== fenceId || !["revoking", "revoked"].includes(record.state) || !unit || unit.name !== unitName(pair.pairId, side)) throw new Error("intercom-revocation-unconfirmed");
    const before = await showUnit(unit, ports);
    if (before.pid > 0) {
      const process = (ports.process ?? nativeProcess)(before.pid);
      if (process.kind !== "live" || !before.controlGroup || !members(before.controlGroup, ports).includes(before.pid)) throw new Error("intercom-revocation-unconfirmed");
      unit = { ...unit, main: { pid: before.pid, startIdentity: process.startIdentity, controlGroup: before.controlGroup }, closedFenceId: null };
      await registry.recordUnit(pair.pairId, unit);
    }
    if (!unit.main) throw new Error("intercom-revocation-unconfirmed");
    if ((await ports.run([ports.systemctl ?? "/usr/bin/systemctl", "--user", "disable", unit.name], options)).code !== 0) throw new Error("intercom-revocation-unconfirmed");
    if ((await ports.run([ports.systemctl ?? "/usr/bin/systemctl", "--user", "stop", unit.name], options)).code !== 0) throw new Error("intercom-revocation-unconfirmed");
    const after = await showUnit(unit, ports), original = (ports.process ?? nativeProcess)(unit.main.pid);
    if (after.controlGroup && after.controlGroup !== unit.main.controlGroup) throw new Error("intercom-unit-mismatch");
    const exited = original.kind === "absent" || original.kind === "live" && original.startIdentity !== unit.main.startIdentity;
    const empty = members(unit.main.controlGroup, ports).length === 0;
    const proof: IntercomHostStopEvidence = { machineId: local.machineId, unit: unit.name, activeState: after.state,
      mainPid: unit.main.pid, mainStartIdentity: unit.main.startIdentity, mainProcess: exited ? "exited" : original.kind === "unknown" ? "unknown" : "live", controlGroup: empty ? "empty" : "nonempty", killMode: "control-group" };
    if (["inactive", "failed"].includes(after.state) && after.pid === 0 && exited && empty) await registry.recordUnit(pair.pairId, { ...unit, closedFenceId: fenceId });
    return proof;
  });
}

export async function pairRouteAbsent(pair: IntercomEnrollmentPair, resources: IntercomPairResources, run: PairResourcePorts["run"]): Promise<boolean> {
  const reply = await run([pair.source.core, "machine", "ls", "--json"], options), value: unknown = reply.code === 0 ? JSON.parse(reply.stdout) : null;
  if (!value || typeof value !== "object" || Array.isArray(value) || !Array.isArray((value as { machines?: unknown }).machines)) return false;
  const rows = (value as { machines: unknown[] }).machines;
  if (rows.some(row => !row || typeof row !== "object" || Array.isArray(row) || typeof (row as { name?: unknown }).name !== "string")) return false;
  return !rows.some(row => String((row as { name: string }).name).toLowerCase().replace(/\.$/, "") === resources.route.name);
}
export type PairRouteRemoval = "removed" | "shared-jobs" | "route-mismatch" | "unknown";
export interface PairTerminalInventory { machineId: string; targetCoreId: string; status: "empty" | "occupied" | "unknown" }
function terminalState(row: Record<string, unknown>): "live" | "finished" | null {
  if (row.state === "live") return "live";
  if (row.state === "finished" && (row.exit_code === undefined || row.exit_code === null || Number.isSafeInteger(row.exit_code)) &&
      (row.signal === undefined || row.signal === null || Number.isSafeInteger(row.signal)) && typeof row.reason === "string" && row.reason.length > 0) return "finished";
  return null;
}
export async function inspectPairTerminals(core: string, run: PairResourcePorts["run"]): Promise<"empty" | "occupied" | "unknown"> {
  try {
    const reply = await run([core, "ls", "--all", "--json"], options), value: unknown = reply.code === 0 ? JSON.parse(reply.stdout) : null;
    if (!value || typeof value !== "object" || Array.isArray(value)) return "unknown";
    const list = value as { terminals?: unknown; hidden_finished?: unknown; machines?: unknown };
    if (!Array.isArray(list.terminals) || list.machines !== undefined && !Array.isArray(list.machines) || list.hidden_finished !== 0) return "unknown";
    const addresses = new Set<string>(); let occupied = false;
    for (const terminal of list.terminals) {
      if (!terminal || typeof terminal !== "object" || Array.isArray(terminal) || typeof (terminal as { address?: unknown }).address !== "string") return "unknown";
      const address = (terminal as { address: string }).address;
      if (!/^(?:[A-Za-z0-9._-]+\/)?t[0-9a-z]+$/.test(address) || addresses.has(address.toLowerCase())) return "unknown";
      addresses.add(address.toLowerCase());
      if (address.includes("/")) continue;
      const state = terminalState(terminal as Record<string, unknown>); if (state === null) return "unknown";
      if (state === "live") occupied = true;
    }
    return occupied ? "occupied" : "empty";
  } catch { return "unknown"; }
}
/** B's empty cgroup ends in-flight execs. Live terminals still block route removal. */
export async function removePairMachineRoute(pair: IntercomEnrollmentPair, resources: IntercomPairResources, ports: Pick<PairResourcePorts, "run"> & { hostClosed: boolean; keyRemoved: boolean; terminalInventory?: PairTerminalInventory }): Promise<PairRouteRemoval> {
  if (!ports.hostClosed || !ports.keyRemoved) return "unknown";
  const route = resources.route;
  if (route.name !== `spider-pair-${pair.pairId}` || route.via !== pairPaths(pair).via || route.session !== pair.connector.session || route.temporary !== false) return "route-mismatch";
  const core = pair.source.core, machines = async () => {
    const reply = await ports.run([core, "machine", "ls", "--json"], options), value: unknown = reply.code === 0 ? JSON.parse(reply.stdout) : null;
    if (!value || typeof value !== "object" || Array.isArray(value) || !Array.isArray((value as { machines?: unknown }).machines)) throw new Error("intercom-route-unavailable");
    const rows = (value as { machines: unknown[] }).machines;
    if (rows.some(row => !row || typeof row !== "object" || Array.isArray(row) || typeof (row as { name?: unknown }).name !== "string")) throw new Error("intercom-route-unavailable");
    return (rows as Record<string, unknown>[]).filter(row => String(row.name).toLowerCase().replace(/\.$/, "") === route.name);
  };
  const matches = (row: Record<string, unknown>) => row.name === route.name && row.id === route.targetCoreId && row.via === true && row.target === route.via && row.session === route.session && row.temporary === false;
  try {
    const found = await machines(); if (!found.length) return "removed";
    if (found.length !== 1 || !matches(found[0])) return "route-mismatch";
    const independent = ports.terminalInventory;
    if (independent) {
      if (independent.machineId !== pair.target.machineId || independent.targetCoreId !== route.targetCoreId || independent.status === "unknown") return "unknown";
      if (independent.status === "occupied") return "shared-jobs";
      if (independent.status !== "empty") return "unknown";
    } else {
    const reply = await ports.run([core, "ls", "--all", "--json"], options), value: unknown = reply.code === 0 ? JSON.parse(reply.stdout) : null;
    if (!value || typeof value !== "object" || Array.isArray(value)) return "unknown";
    const list = value as { terminals?: unknown; machines?: unknown; hidden_finished?: unknown };
    if (!Array.isArray(list.terminals) || !Array.isArray(list.machines) || list.hidden_finished !== 0) return "unknown";
    const listed = list.machines.filter(row => row && typeof row === "object" && !Array.isArray(row) && String((row as { name?: unknown }).name).toLowerCase().replace(/\.$/, "") === route.name);
    if (listed.length !== 1 || !matches(listed[0]) || listed[0].state !== "connected") return "unknown";
    const addresses = new Set<string>();
    for (const terminal of list.terminals) {
      if (!terminal || typeof terminal !== "object" || Array.isArray(terminal) || typeof (terminal as { address?: unknown }).address !== "string") return "unknown";
      const address = (terminal as { address: string }).address;
      if (!/^(?:[A-Za-z0-9._-]+\/)?t[0-9a-z]+$/.test(address) || addresses.has(address.toLowerCase())) return "unknown";
      addresses.add(address.toLowerCase());
      if (!address.toLowerCase().startsWith(`${route.name}/`)) continue;
      const state = terminalState(terminal as Record<string, unknown>); if (state === null) return "unknown";
      if (state === "live") return "shared-jobs";
    }
    }
    const checked = await machines(); if (checked.length !== 1 || !matches(checked[0])) return "route-mismatch";
    const removed = await ports.run([core, "machine", "rm", route.name, "--json"], options);
    return removed.code === 0 && (await machines()).length === 0 ? "removed" : "unknown";
  } catch { return "unknown"; }
}

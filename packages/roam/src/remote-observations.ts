import { parseReadiness } from "@spider/db-core/roam/readiness";
import { validReadiness } from "./session-control";
import type { HostingObservation } from "./hosting";
import type { Peer, RoamConfig, Transport } from "./contracts";
import { createLocalDiagnosticPorts, type inspectLocalConsumers, type runLocalDoctor } from "./local-diagnostics";
import type { DiagnosticPorts } from "./diagnostics";

type DoctorReport = Awaited<ReturnType<typeof runLocalDoctor>>;
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export async function remoteObservation(transport: Transport, peer: Peer, kind: "consumers" | "doctor" | "hosting", config: RoamConfig): Promise<unknown> {
  const handle = await transport.resolve(peer);
  const bytes = await transport.exec(handle, ["roam", "observe", kind], { timeoutMs: config.limits.controlMs, maxBytes: config.limits.replyBytes });
  const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (!record(value) || value.version !== 1 || value.machineId !== peer.machineId || value.kind !== kind || !record(value.value))
    throw new Error("Invalid remote observation");
  return value.value;
}

export async function remoteHosting(transport: Transport, peer: Peer, config: RoamConfig): Promise<HostingObservation> {
  const value = await remoteObservation(transport, peer, "hosting", config);
  if (!record(value) || !Array.isArray(value.readiness) || !value.readiness.every(validReadiness) || !Array.isArray(value.suspensions) ||
      value.suspensions.some(item => !record(item) || typeof item.sessionId !== "string" || !item.sessionId || !Number.isSafeInteger(item.epoch) || Number(item.epoch) < 1))
    throw new Error("Invalid hosting observation");
  if (value.readiness.some(row => row.terminal.includes("/"))) throw new Error("Invalid local terminal identity");
  return { readiness: value.readiness.map(raw => { const row = parseReadiness(raw); if (row.origin === "box-local" && row.machineId !== peer.machineId) throw new Error("readiness-origin-mismatch"); return { ...row, terminal: `${peer.alias}/${row.terminal}` }; }),
    suspensions: value.suspensions as HostingObservation["suspensions"] };
}

type ConsumerSnapshot = Awaited<ReturnType<typeof inspectLocalConsumers>>;
function validProbe(value: unknown): boolean {
  return record(value) && (value.kind === "absent" || value.kind === "unknown" || value.kind === "live" && typeof value.startIdentity === "string" && !!value.startIdentity);
}
function consumerSnapshot(value: unknown): ConsumerSnapshot {
  if (!record(value) || !Array.isArray(value.presence) || typeof value.bundled !== "string" ||
      !(value.cli === null || typeof value.cli === "string") || !Array.isArray(value.executables)) throw new Error("Invalid consumer observations");
  for (const row of value.presence) if (!record(row) || !record(row.record) || !Number.isSafeInteger(row.record.pid) || !validProbe(row.probe))
    throw new Error("Invalid process observation");
  if (value.worker !== null && (!record(value.worker) || !record(value.worker.record) || !Number.isSafeInteger(value.worker.record.pid) || !validProbe(value.worker.probe)))
    throw new Error("Invalid usage observation");
  for (const item of value.executables) if (!record(item) || typeof item.label !== "string" || typeof item.file !== "string" || typeof item.available !== "boolean")
    throw new Error("Invalid executable observation");
  return value as unknown as ConsumerSnapshot;
}

/** Each enable attempt observes every peer afresh, once per machine. */
export function compatibleConsumerPorts(root: string, config: RoamConfig, transport: Transport, bundleUrl?: URL): DiagnosticPorts {
  const local = createLocalDiagnosticPorts(root, [], bundleUrl);
  const cache = new Map<string, Promise<ConsumerSnapshot>>();
  function snapshot(peer: Peer): Promise<ConsumerSnapshot> {
    let pending = cache.get(peer.machineId);
    if (!pending) { pending = remoteObservation(transport, peer, "consumers", config).then(consumerSnapshot); cache.set(peer.machineId, pending); }
    return pending;
  }
  return {
    targetBuild: local.targetBuild,
    async listPresence(machine) { return machine.peer ? (await snapshot(machine.peer)).presence.map(row => row.record) : local.listPresence(machine); },
    async probeProcess(machine, pid) { return machine.peer ? (await snapshot(machine.peer)).presence.find(row => row.record.pid === pid)?.probe ?? { kind: "unknown" } : local.probeProcess(machine, pid); },
    async usageWorker(machine) { return machine.peer ? (await snapshot(machine.peer)).worker?.record ?? null : local.usageWorker(machine); },
    async probeUsage(machine, pid) {
      if (!machine.peer) return local.probeUsage(machine, pid);
      const worker = (await snapshot(machine.peer)).worker;
      return worker?.record.pid === pid ? worker.probe : { kind: "unknown" };
    },
    async bundledSqlite(machine) { return machine.peer ? (await snapshot(machine.peer)).bundled : local.bundledSqlite(machine); },
    async sqliteCli(machine) { return machine.peer ? (await snapshot(machine.peer)).cli : local.sqliteCli(machine); },
    async listExecutables(machine) { return machine.peer ? (await snapshot(machine.peer)).executables.map(({ label, file }) => ({ label, file })) : local.listExecutables(machine); },
    async executable(machine, file) {
      if (!machine.peer) return local.executable(machine, file);
      const entry = (await snapshot(machine.peer)).executables.find(item => item.file === file);
      if (!entry) throw new Error("Unknown executable");
      return entry.available;
    },
    stores: () => local.stores(),
  };
}

export async function remoteDoctor(transport: Transport, peer: Peer, config: RoamConfig): Promise<DoctorReport> {
  const value = await remoteObservation(transport, peer, "doctor", config);
  if (!record(value) || typeof value.enabled !== "boolean" || !Array.isArray(value.diagnostics) || !Array.isArray(value.consumers))
    throw new Error("Invalid remote doctor report");
  for (const diagnostic of value.diagnostics) {
    if (!record(diagnostic) || !["block", "warning"].includes(String(diagnostic.severity)) || typeof diagnostic.reason !== "string" ||
        !(diagnostic.repairCommand === null || typeof diagnostic.repairCommand === "string")) throw new Error("Invalid remote diagnostic");
  }
  for (const consumer of value.consumers) {
    if (!record(consumer) || typeof consumer.machine !== "string" || !["pi", "usage"].includes(String(consumer.kind)) ||
        !Number.isSafeInteger(consumer.pid) || typeof consumer.build !== "string" ||
        !(consumer.roamSchema === null || Number.isSafeInteger(consumer.roamSchema))) throw new Error("Invalid remote consumer");
  }
  return value as unknown as DoctorReport;
}

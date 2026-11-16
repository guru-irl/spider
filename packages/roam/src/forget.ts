// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { createHash } from "node:crypto";
import type { Home, HubOperationReadiness, JsonObject, MachineId } from "@spider/db-core/roam/types";
import { parseHubReadiness } from "@spider/db-core/roam/readiness";
import { writeLocal } from "@spider/db-core/roam/local-state";
import type { Journal, MovePorts, MoveResult, Operation, Outcome, SessionManifest } from "./contracts";
import { casHome, sessionHome } from "./homes";
import { isMachineId } from "./machine-id";
import { withMoveLock } from "./move";
import { isRevoked, revokeMachine } from "./revocation";
import { inspectRestoredSession, verifyFrozenSession } from "./session-file";

export function destroyedMachineWarning(machineId: MachineId): string {
  return `Confirm that UUID ${machineId} is destroyed by typing destroyed ${machineId}. If it is still alive, two copies can run until reconnection. Conversation after the last mirror and unsent workspace edits will be lost.`;
}
const json = (value: unknown): JsonObject => JSON.parse(JSON.stringify(value)) as JsonObject;
const same = (a: Home | null | "unknown", b: Home): boolean => !!a && a !== "unknown" && a.sessionId === b.sessionId && a.machineId === b.machineId && a.epoch === b.epoch && a.moveId === b.moveId;
const operationId = (machine: MachineId) => `forget-machine-${machine}`;
export function forgetHomeId(source: Home): string {
  return `forget-${createHash("sha256").update(JSON.stringify([source.sessionId, source.machineId, source.epoch, source.moveId])).digest("hex").slice(0,40)}`;
}
const presentationId = (id: string) => `${id}-presentation`;
export function forgottenPresentationComplete(id: string, journal: Journal): boolean {
  return journal.read(id).some(row => row.action === "forget-presented") || journal.read(presentationId(id)).some(row => row.action === "done");
}
class RecoveryRefusal extends Error { constructor(readonly reason: string, readonly code: 1 | 2 | 3 = 1, readonly repairCommand: string | null = null) { super(reason); } }
function sourceValid(home: Home, machineId: MachineId): boolean {
  return !!home && typeof home.sessionId === "string" && !!home.sessionId && home.machineId === machineId && isMachineId(machineId) &&
    Number.isSafeInteger(home.epoch) && home.epoch >= 1 && home.epoch < Number.MAX_SAFE_INTEGER &&
    (home.moveId === null || typeof home.moveId === "string");
}

export interface ForgottenHomeResult {
  sessionId: string; code: 0 | 1 | 2 | 3; reason: string; home: Home | null;
  presentation: "complete" | "pending" | null; repairCommand: string | null;
}
export type ForgetOutcome = Outcome<readonly Home[]> & { results: readonly ForgottenHomeResult[] };
export async function forgetMachine(input: { machineId: MachineId; confirmation: string }, ports: MovePorts): Promise<ForgetOutcome> {
  const result = (code: 0 | 1 | 2 | 3, reason: string, value: readonly Home[] | null = null, results: readonly ForgottenHomeResult[] = []): ForgetOutcome =>
    ({ code, reason, operationId: operationId(input.machineId), home: null, epoch: null, repairCommand: null, value, results });
  if (ports.config.role !== "hub" || ports.config.machineId !== ports.config.hubMachineId) return result(1, "forget-requires-hub");
  if (!isMachineId(input.machineId) || input.machineId === ports.config.hubMachineId || input.confirmation !== `destroyed ${input.machineId}`)
    return result(2, "destroyed-machine-confirmation-required");
  try {
    if (!ports.config.peers.some(peer => peer.machineId === input.machineId) && !isRevoked(ports.recovery.revocationDb, input.machineId)) return result(2, "machine-not-enrolled");
  } catch { return result(3, "revocation-evidence-unavailable"); }
  const blockers = ports.recovery.blockers?.() ?? ["adapter-unbound:recovery.infrastructure"];
  if (blockers.length) return result(1, blockers[0]);
  // The permanent local assertion must commit before mirror access, CAS, restore or presentation.
  try { revokeMachine(ports.recovery.revocationDb, input.machineId); }
  catch { return result(1, "revocation-persistence-failed"); }
  try {
    const operation: Operation = { id: operationId(input.machineId), kind: "forget-machine", machineId: ports.config.hubMachineId, expectedEpoch: null, args: { destroyedMachine: input.machineId } };
    const saved = ports.journal.begin(operation);
    if (saved.kind === "done") {
      await replayForgottenPresentations(ports);
      const completed = saved.result as unknown as ForgetOutcome;
      return { ...completed, results: (completed.results ?? []).map(row => ({ ...row,
        presentation: row.home?.moveId && forgottenPresentationComplete(row.home.moveId, ports.journal) ? "complete" as const : row.presentation })) };
    }
    let homes = ports.journal.read(operation.id).find(row => row.action === "forget-homes")?.result.homes as unknown as readonly Home[] | undefined;
    if (!homes) {
      homes = ports.recovery.homes(input.machineId);
      if (!Array.isArray(homes) || homes.some(home => !sourceValid(home, input.machineId)) || new Set(homes.map(home => home.sessionId)).size !== homes.length)
        throw new RecoveryRefusal("recovery-homes-invalid");
      ports.journal.record(operation.id, "forget-homes", json({ homes }));
    }
    if (homes.some(home => !sourceValid(home, input.machineId))) throw new RecoveryRefusal("recovery-homes-invalid");
    const results: ForgottenHomeResult[] = [];
    for (const source of homes) {
      try {
        const home = await withMoveLock(source.sessionId, ports, () => restoreHome(source, ports));
        results.push({ sessionId: source.sessionId, code: 0, reason: "destroyed-home-recovered", home,
          presentation: forgottenPresentationComplete(forgetHomeId(source), ports.journal) ? "complete" : "pending", repairCommand: null });
      } catch (error) {
        const code = error instanceof RecoveryRefusal ? error.code : 3, reason = error instanceof RecoveryRefusal ? error.reason : "recovery-pending";
        results.push({ sessionId: source.sessionId, code, reason, home: null, presentation: null,
          repairCommand: error instanceof RecoveryRefusal && error.repairCommand ? error.repairCommand : reason === "recovery-mirror-missing" ? "Conversation unavailable. Restore the session from a backup; no mirrored copy exists." : "spider roam doctor" });
      }
    }
    ports.journal.record(operation.id, "forget-results", json({ results }));
    const failed = results.filter(row => row.code !== 0), restored = results.flatMap(row => row.home ? [row.home] : []);
    const outcome = result(failed.some(row => row.code === 3) ? 3 : failed.length ? 1 : 0, failed[0]?.reason ?? "destroyed-machine-recovered", restored, results);
    if (!failed.length) ports.journal.record(operation.id, "done", json(outcome));
    return outcome;
  } catch (error) { return result(error instanceof RecoveryRefusal ? error.code : 3, error instanceof RecoveryRefusal ? error.reason : "recovery-pending"); }
}

async function restoreHome(source: Home, ports: MovePorts): Promise<Home> {
  if (!isRevoked(ports.recovery.revocationDb, source.machineId)) throw new RecoveryRefusal("machine-not-revoked");
  const id = forgetHomeId(source), operation: Operation = { id, kind: "restore-destroyed-home", machineId: ports.config.hubMachineId, expectedEpoch: source.epoch + 1, args: { sessionId: source.sessionId, destroyedMachine: source.machineId } };
  const prior = ports.journal.begin(operation);
  if (prior.kind === "done") return prior.result!.home as unknown as Home;
  const mirror = await ports.recovery.mirror(source.sessionId, source.epoch);
  if (!mirror) throw new RecoveryRefusal("recovery-mirror-missing");
  try { if (mirror.sessionId !== source.sessionId) throw new Error("wrong session"); await verifyFrozenSession(mirror, ports.config.limits); }
  catch { throw new RecoveryRefusal("recovery-mirror-invalid"); }
  const home = casHome(ports.globalDb, source, ports.config.hubMachineId, id, ports.config.hubMachineId);
  if (!same(sessionHome(ports.globalDb, source.sessionId), home)) throw new RecoveryRefusal("recovery-home-changed", 3);
  ports.journal.record(id, "forget-home", json({ source, home }));
  await ports.replicateHome(home);
  if (!same(sessionHome(ports.globalDb, source.sessionId), home)) throw new RecoveryRefusal("recovery-home-changed", 3);
  let ready = ports.journal.read(id).find(row => row.action === "forget-ready")?.result.ready as unknown as HubOperationReadiness | undefined;
  const cached = !!ready;
  if (!ready) {
    const outcome = await ports.recovery.restore(home, mirror, operation);
    if (outcome.code !== 0) throw new RecoveryRefusal(outcome.reason, outcome.code === 3 ? 3 : 1, outcome.repairCommand);
    try {
      if (outcome.operationId !== id || outcome.epoch !== home.epoch || !same(outcome.home, home)) throw new Error("wrong readiness");
      ready = parseHubReadiness(outcome.value);
    } catch { throw new RecoveryRefusal("recovery-readiness-invalid", 3); }
  }
  try {
    ready = parseHubReadiness(ready);
    if (ready.opId !== id || ready.sessionId !== home.sessionId || ready.epoch !== home.epoch || ready.terminal.includes("/")) throw new Error("wrong readiness");
    const installed = await inspectRestoredSession(ready.file, mirror, source, home, ports.config.limits);
    if (installed.cwd !== ready.cwd || installed.historySha256 !== mirror.historySha256) throw new Error("wrong installed history");
  } catch { throw new RecoveryRefusal("recovery-readiness-invalid", 3); }
  if (!cached) ports.journal.record(id, "forget-ready", json({ ready }));
  if (!same(sessionHome(ports.globalDb, source.sessionId), home)) throw new RecoveryRefusal("recovery-home-changed", 3);
  if (!ports.journal.read(id).some(row => row.action === "forget-presented")) {
    const presented = await ports.recovery.presentReadyTarget({ machineId: home.machineId, alias: null, sessionId: home.sessionId, homeEpoch: home.epoch, coreId: ready.core, terminalId: ready.terminal });
    if (presented?.status === "complete") ports.journal.record(id, "forget-presented", {});
    else ports.journal.record(id, "forget-presentation-pending", json({ home, ready, mirror, source }));
  }
  if (ports.journal.lookupOperation?.(id)?.state !== "done") ports.journal.record(id, "done", json({ home, ready }));
  return home;
}
/** Presentation is retried independently of ownership, and cannot strand another home. */
export async function replayForgottenPresentations(ports: MovePorts): Promise<void> {
  const operations = ports.recovery.revocationDb.prepare("SELECT operation_id FROM roam_operations WHERE kind='restore-destroyed-home'").all() as { operation_id: string }[];
  for (const { operation_id: id } of operations) {
    const rows = ports.journal.read(id), pending = rows.find(row => row.action === "forget-presentation-pending")?.result;
    if (!pending || forgottenPresentationComplete(id, ports.journal)) continue;
    let validated = false;
    try {
      const home = pending.home as unknown as Home, source = pending.source as unknown as Home, mirror = pending.mirror as unknown as SessionManifest;
      if (!same(sessionHome(ports.globalDb, home.sessionId), home)) continue;
      const ready = parseHubReadiness(rows.find(row => row.action === "forget-ready")?.result.ready);
      if (ready.opId !== id || ready.sessionId !== home.sessionId || ready.epoch !== home.epoch || ready.terminal.includes("/")) throw new Error("recovery-readiness-invalid");
      const installed = await inspectRestoredSession(ready.file, mirror, source, home, ports.config.limits);
      if (installed.cwd !== ready.cwd) throw new Error("recovery-readiness-invalid");
      validated = true;
      const operation: Operation = { id: presentationId(id), kind: "forget-presentation", machineId: ports.config.hubMachineId, expectedEpoch: home.epoch, args: { restoreOperationId: id, sessionId: home.sessionId } };
      if (ports.journal.begin(operation).kind === "done") continue;
      const presented = await ports.recovery.presentReadyTarget({ machineId: home.machineId, alias: null, sessionId: home.sessionId, homeEpoch: home.epoch, coreId: ready.core, terminalId: ready.terminal });
      if (presented?.status === "complete") ports.journal.record(operation.id, "done", { restoreOperationId: id });
    } catch {
      const reason = validated ? "recovery-presentation-unavailable" : "recovery-readiness-invalid";
      writeLocal(ports.globalDb, "recovery-diagnostic", id, { reason });
    }
  }
}
/** Startup retries the same durable operations. It never supplies a new home epoch for a lost reply. */
export async function recoverForgottenMachines(machines: readonly MachineId[], ports: MovePorts): Promise<readonly Outcome<readonly Home[]>[]> {
  const results: Outcome<readonly Home[]>[] = [];
  for (const machineId of new Set(machines)) {
    if (!isRevoked(ports.recovery.revocationDb, machineId)) continue;
    results.push(await forgetMachine({ machineId, confirmation: `destroyed ${machineId}` }, ports));
  }
  return results;
}
/** Only a current committed forget receipt and restored readiness can supersede an old move. */
export function recoveredForgottenHome(sessionId: string, ports: MovePorts): MoveResult | null {
  const home = sessionHome(ports.globalDb, sessionId);
  if (!home || home === "unknown" || home.machineId !== ports.config.hubMachineId || !home.moveId?.startsWith("forget-")) return null;
  const rows = ports.journal.read(home.moveId), record = rows.find(row => row.action === "forget-home")?.result;
  const source = record?.source as unknown as Home | undefined, savedHome = record?.home as unknown as Home | undefined;
  const ready = rows.find(row => row.action === "forget-ready")?.result.ready as unknown as HubOperationReadiness | undefined;
  if (!source || !savedHome || !ready || !sourceValid(source, source.machineId) || !isRevoked(ports.recovery.revocationDb, source.machineId) ||
      home.moveId !== forgetHomeId(source) || home.epoch !== source.epoch + 1 || !same(savedHome, home)) return null;
  const committed = ports.globalDb.prepare("SELECT committed_home_json FROM roam_home_actions WHERE move_id=?").get(home.moveId) as { committed_home_json: string | null } | undefined;
  if (!committed?.committed_home_json || !same(JSON.parse(committed.committed_home_json) as Home, home)) return null;
  const parsed = parseHubReadiness(ready);
  if (parsed.opId !== home.moveId || parsed.sessionId !== sessionId || parsed.epoch !== home.epoch) return null;
  return { home, terminal: parsed.terminal, intercomAddress: sessionId, warnings: [] };
}

import { randomUUID } from "node:crypto";
import type { Db } from "@spider/db-core";
import { openRoamStoreReadOnly } from "@spider/db-core/roam/reads";
import type { Home, JsonObject } from "@spider/db-core/roam/types";
import type { Journal, MoveResult, MovePorts, Operation, Outcome, RoamConfig, Transport } from "./contracts";
import { resolveControlMachine, resolveControlSession } from "./commands";
import { guardMoveControl, type MoveControlHandler } from "./move-control";
import { moveSession } from "./move";
import { recoverMove, cancelMove } from "./move-recovery";
import { claimInitialHome } from "./claim";
import { forgetMachineWithAdapters } from "./move-ports";
import { sessionHome } from "./homes";
import { listStoreKeys } from "./store-inventory";

function publicMoveValue(value: MoveResult): JsonObject {
  const sourceCleanup = value.sourceCleanup.status === 'done' ? value.sourceCleanup
    : { status: value.sourceCleanup.status, blockers: [...value.sourceCleanup.blockers] };
  return { ...value, home: { ...value.home }, warnings: [...value.warnings], sourceCleanup };
}

export function controlSessionCatalog(db: Db): { id: string; name: string | null }[] {
  const catalog = new Map<string, { id: string; name: string | null }>();
  for (const row of db.prepare("SELECT session_id FROM roam_locations").all() as { session_id: string }[]) catalog.set(row.session_id, { id: row.session_id, name: null });
  for (const key of listStoreKeys(db).filter(key => key.startsWith("worktree:"))) {
    const store = openRoamStoreReadOnly(db, key);
    if (!store) throw new Error("session-catalog-unavailable");
    try { for (const row of store.prepare("SELECT id,name FROM sessions").all() as { id: string; name: string | null }[]) catalog.set(row.id, row); }
    finally { store.close(); }
  }
  return [...catalog.values()];
}
export function createMoveControlHandler(input: { config: RoamConfig; globalDb: Db; journal: Journal; transport: Transport; ports: MovePorts }): MoveControlHandler {
  const { config, globalDb, journal, transport, ports } = input;
  const refused = (code: 1 | 2 | 3, reason: string, value: JsonObject | null = null): Outcome<JsonObject> => ({ code, reason, operationId: "", home: null, epoch: null, repairCommand: null, value });
  return guardMoveControl(() => config.enabled && config.role === "hub", async (request): Promise<import("./control-socket").HubControlReply> => {
    if (config.role !== "hub") return refused(1, "forget-requires-hub");
    if (request.op === "recover" || request.op === "cancel") {
      const result = await (request.op === "recover" ? recoverMove : cancelMove)(request.operationId, ports);
      const presentations = journal.read(request.operationId).filter(row => row.action === "handoff-presentation");
      const presentation = presentations.at(-1)?.result.status === "pending" ? "pending" : "complete";
      return { ...result, value: result.value ? { ...publicMoveValue(result.value), ...(request.op === "recover" ? { presentation } : {}) } : null };
    }
    if (request.op === "forget") {
      const machineId = resolveControlMachine(request.machine, config);
      if (!machineId) return refused(2, "machine-not-enrolled");
      const result = await forgetMachineWithAdapters({ machineId, confirmation: request.confirmation }, ports);
      return { code: result.code, reason: result.reason, operationId: result.operationId, home: null, epoch: null, repairCommand: result.code === 3 ? "spider roam doctor" : null,
        value: { results: result.results.map(row => ({ ...row, home: row.home ? { ...row.home } : null })), ...(result.ok ? { presentation: result.presentation, homes: result.value.map(home => ({ ...home })) } : { recovered: result.recovered.map(row => ({ ...row, home: { ...row.home } })) }) } };
    }
    if (!("session" in request)) return refused(2, "invalid-move-control");
    const resolved = resolveControlSession(request.session, controlSessionCatalog(globalDb));
    if (!("sessionId" in resolved)) return refused(2, resolved.reason, { candidates: resolved.candidates });
    const sessionId = resolved.sessionId;
    if (request.op === "move" || request.op === "claim") {
      const machineId = resolveControlMachine(request.machine, config);
      if (!machineId) return refused(2, "machine-not-enrolled");
      if (request.op === "claim") {
        const result = await claimInitialHome({ sessionId, machineId }, ports);
        return { ...result, value: result.value ? { ...result.value } : null };
      }
      const operation: Operation = { id: randomUUID(), kind: "move", machineId: config.machineId, expectedEpoch: null, args: { sessionId, destinationMachine: machineId } };
      const result = await moveSession({ operation, sessionId, destinationMachine: machineId }, ports);
      return { ...result, value: result.value ? publicMoveValue(result.value) : null };
    }
    const home = sessionHome(globalDb, sessionId);
    if (!home || home === "unknown") return refused(1, "participant-home-unavailable");
    const peer = config.peers.find(peer => peer.machineId === home.machineId);
    if (!peer) return refused(1, "participant-home-not-enrolled");
    const operation: Operation = { id: randomUUID(), kind: `session-${request.op}`, machineId: home.machineId, expectedEpoch: home.epoch, args: { sourceMachine: config.machineId, sessionId } };
    const bytes = await transport.exec(await transport.resolve(peer), ["roam", "agent", JSON.stringify(operation)], { timeoutMs: config.limits.controlMs, maxBytes: config.limits.replyBytes });
    const result = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as Outcome<JsonObject>;
    if (!result || result.operationId !== operation.id || ![0, 1, 2, 3].includes(result.code) || typeof result.reason !== "string") return refused(1, "participant-control-unavailable");
    return { ...result, home: { ...(home as Home) }, epoch: home.epoch, value: null };
  });
}

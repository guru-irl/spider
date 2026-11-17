import { forgetMachineForRuntime } from "./machine-forget";

import { join } from "node:path";
import { openDb } from "@spider/db-core";
import { writeLocal } from "@spider/db-core/roam/local-state";
import type { MoveRuntimeFactory, MoveRuntimeInput } from "./move-runtime-contracts";
import { guardMoveControl, type MoveControlHandler } from "./move-control";
import { controlSessionCatalog } from "./adapter-controls";
import { resolveControlSession } from "./commands";

import { recoverMove, cancelMove, pendingWorkspaceTransitions, recoverWorkspaceRestores, retryAbortedWorkspace } from "./move-recovery";
import { MoveError, readMoveReservation } from "./move";
import { recoverMovePresentation } from "./move-ports";

export function createMoveRuntimeService(input: Omit<MoveRuntimeInput, "sessionId">, factory: MoveRuntimeFactory): { control: MoveControlHandler; recover(): Promise<void>; recoverCleanup(machineId?: string): Promise<void> } {
  const { config, journal } = input;
  const runtime = (sessionId: string) => factory({ ...input, sessionId });
  const requestSession = (moveId: string): string | null => {
    const request = journal.read(moveId).find(row => row.action === "move-request")?.result;
    return request && typeof request.sessionId === "string" ? request.sessionId : null;
  };
  const diagnostic = (id: string, reason: string) => writeLocal(input.globalDb, "recovery-diagnostic", id, { reason });
  const forget: MoveControlHandler = async request => {
    if (request.op !== "forget") return { code: 2, reason: "invalid-move-control", value: null };
    const result = await forgetMachineForRuntime(input, factory, request);
    return { code: result.code, reason: result.reason, operationId: result.operationId,
      value: { results: result.results.map(row => ({ ...row, home: row.home ? { ...row.home } : null })), ...(result.ok ? { presentation: result.presentation, homes: result.value.map(home => ({ ...home })) } : {}) } };
  };
  let cleanupFlight: Promise<void> | null = null;
  const recoverCleanupOnce = async (machineId?: string): Promise<void> => {
    const db = openDb(join(input.root, "roam", "journal.db"), { fileMustExist: true, checkpointOnClose: false });
    try {
      const source = db.prepare(`SELECT o.operation_id FROM roam_operations o WHERE o.kind='move' AND o.result_json IS NULL
        AND EXISTS (SELECT 1 FROM roam_operation_actions a WHERE a.operation_id=o.operation_id AND a.action='move-source-cleanup-pending')`).all() as { operation_id: string }[];
      for (const { operation_id } of source) {
        const pending = journal.read(operation_id).filter(row => row.action === 'move-source-cleanup-pending').at(-1)?.result;
        if (machineId && pending?.sourceMachine !== machineId) continue;
        const sessionId = requestSession(operation_id);
        if (!sessionId) { diagnostic(operation_id, 'cleanup-evidence-missing'); continue; }
        try {
          const mounted = await runtime(sessionId);
          try {
            const result = await recoverMove(operation_id, mounted.ports);
            if (result.code !== 0 || result.reason !== "moved") diagnostic(operation_id, result.reason);
            else writeLocal(input.globalDb, "recovery-diagnostic", operation_id, undefined);
          } finally { await mounted.close(); }
        } catch (error) {
          const detail = error && typeof error === "object" ? error as { reason?: unknown; code?: unknown } : {};
          const reason = detail.reason ?? detail.code ?? (error instanceof MoveError ? error.refusal.code : null);
          diagnostic(operation_id, typeof reason === "string" && /^[a-z][a-z0-9:-]{0,80}$/.test(reason) ? reason : "source-cleanup-pending");
        }
      }
      const rows = db.prepare("SELECT operation_id FROM roam_operations WHERE kind='move-abort-cleanup' AND result_json IS NULL").all() as { operation_id: string }[];
      for (const { operation_id } of rows) {
        const request = journal.read(operation_id).find(row => row.action === "abort-cleanup-request")?.result;
        if (!request || typeof request.sessionId !== "string" || typeof request.moveId !== "string") { diagnostic(operation_id, "cleanup-evidence-missing"); continue; }
        const check = request.check as unknown as import("./contracts").MoveCheck;
        if (machineId && machineId !== check?.source?.machineId && machineId !== check?.destinationMachine) continue;
        try {
          const mounted = await runtime(request.sessionId);
          try { await retryAbortedWorkspace(request.moveId, mounted.ports); } finally { await mounted.close(); }
        } catch { diagnostic(operation_id, "workspace-cleanup-pending"); }
      }
    } finally { db.close(); }
  };
  const requested = new Set<string | undefined>();
  const recoverCleanup = (machineId?: string): Promise<void> => {
    requested.add(machineId);
    if (cleanupFlight) return cleanupFlight;
    return cleanupFlight = Promise.resolve().then(async () => {
      try {
        while (requested.size) {
          const machines = [...requested]; requested.clear();
          if (machines.includes(undefined)) await recoverCleanupOnce();
          else for (const machine of machines) await recoverCleanupOnce(machine);
        }
      } finally { cleanupFlight = null; }
    });
  };
  return {
    recoverCleanup,
    control: guardMoveControl(() => config.enabled && config.role === "hub", async request => {
      if (config.role !== "hub") return { code: 1, reason: "forget-requires-hub", value: null };
      if (request.op === "forget") return forget(request);
      let sessionId: string | null = null;
      if ("session" in request) {
        const resolved = resolveControlSession(request.session, controlSessionCatalog(input.globalDb));
        if (!("sessionId" in resolved)) return { code: 2, reason: resolved.reason, value: { candidates: resolved.candidates } };
        sessionId = resolved.sessionId;
      } else if ("operationId" in request) sessionId = requestSession(request.operationId);
      if (!sessionId) return { code: 1, reason: "move-evidence-missing", value: null };
      const mounted = await runtime(sessionId);
      try { return await mounted.control(request); } finally { await mounted.close(); }
    }),
    async recover() {
      if (!config.enabled) return;
      await recoverCleanup();
      const db = openDb(join(input.root, "roam", "journal.db"), { fileMustExist: true, checkpointOnClose: false });
      try {
        if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='roam_machine_revocations'").get()) {
          for (const { machine_id } of db.prepare("SELECT machine_id FROM roam_machine_revocations").all() as { machine_id: string }[]) {
            try {
              const result = await forget({ op: "forget", machine: machine_id, confirmation: `destroyed ${machine_id}` });
              if (result.code !== 0) diagnostic(machine_id, result.reason);
            } catch { diagnostic(machine_id, "recovery-pending"); }
          }
        }
        const pending = new Set((db.prepare("SELECT operation_id FROM roam_operations WHERE kind='move' AND result_json IS NULL").all() as { operation_id: string }[]).map(row => row.operation_id));
        for (const { operation_id } of db.prepare("SELECT operation_id FROM roam_operations WHERE kind='move-session'").all() as { operation_id: string }[]) {
          const reserved = journal.read(operation_id).find(row => row.action === "reserved");
          const request = reserved && requestSession(String(reserved.result.moveId));
          if (request) { const active = readMoveReservation(request, journal); if (active) pending.add(active.moveId); }
        }
        const restoreSessions = new Set<string>();
        for (const row of pendingWorkspaceTransitions(db, journal)) {
          if (row.sessionId) restoreSessions.add(row.sessionId); else diagnostic(row.operationId, "workspace-session-unavailable");
        }
        for (const sessionId of restoreSessions) {
          try {
            const mounted = await runtime(sessionId);
            try {
              for (const failure of await recoverWorkspaceRestores(await mounted.ports.recovery.workspaceRestores?.() ?? [])) diagnostic(sessionId, failure.reason);
            } finally { await mounted.close(); }
          } catch { diagnostic(sessionId, "workspace-recovery-pending"); }
        }
        const presentations = db.prepare("SELECT operation_id FROM roam_operations WHERE kind='move-presentation' AND result_json IS NULL").all() as { operation_id: string }[];
        for (const { operation_id } of presentations) {
          const request = journal.read(operation_id).find(row => row.action === "source-view-request")?.result;
          const operation = request?.operation as unknown as { id?: unknown; args?: { sessionId?: unknown } } | undefined;
          const check = request?.check as unknown as { source?: { sessionId?: unknown } } | undefined;
          const sessionId = operation?.args?.sessionId;
          if (typeof operation?.id !== "string" || typeof sessionId !== "string" || !sessionId || check?.source?.sessionId !== sessionId) {
            diagnostic(operation_id, "presentation-evidence-missing"); continue;
          }
          try {
            const mounted = await runtime(sessionId);
            try { await recoverMovePresentation(mounted.ports, operation.id); } finally { await mounted.close(); }
          } catch { diagnostic(operation_id, "presentation-recovery-pending"); }
        }
        for (const moveId of pending) {
          const id = requestSession(moveId);
          if (!id) { diagnostic(moveId, "move-evidence-missing"); continue; }
          try {
            const mounted = await runtime(id);
            try {
              const result = await (journal.read(moveId).some(row => row.action === "move-abort-start") ? cancelMove : recoverMove)(moveId, mounted.ports);
              if (result.code !== 0) diagnostic(moveId, result.reason);
            } finally { await mounted.close(); }
          } catch { diagnostic(moveId, "move-recovery-pending"); }
        }
      } finally { db.close(); }
    },
  };
}

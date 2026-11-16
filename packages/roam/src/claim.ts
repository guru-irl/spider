// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import type { Home, MachineId } from "@spider/db-core/roam/types";
import type { MovePorts, Outcome } from "./contracts";
import { assignInitialHome, resolveInitialConflict } from "./homes";
import { isMachineId } from "./machine-id";
import { readMoveReservation, withMoveLock } from "./move";
import { isRevoked } from "./revocation";

export async function claimInitialHome(input: { sessionId: string; machineId: MachineId }, ports: MovePorts): Promise<Outcome<Home>> {
  const result = (code: 0 | 1 | 2 | 3, reason: string, home: Home | null = null): Outcome<Home> =>
    ({ code, reason, home, epoch: home?.epoch ?? null, operationId: "", repairCommand: null, value: code === 0 ? home : null });
  if (!ports.config.enabled || ports.config.role !== "hub" || ports.config.machineId !== ports.config.hubMachineId) return result(1, "claim-requires-enabled-hub");
  if (!input.sessionId || input.sessionId.length > 1024 || /[\x00-\x1f]/.test(input.sessionId) || !isMachineId(input.machineId)) return result(2, "claim-invalid");
  try {
    return await withMoveLock(input.sessionId, ports, async () => {
      if (readMoveReservation(input.sessionId, ports.journal)) return result(1, "move-session-conflict");
      if (isRevoked(ports.recovery.revocationDb, input.machineId)) return result(1, "machine-revoked");
      const read = () => ports.globalDb.prepare("SELECT session_id AS sessionId,machine_id AS machineId,epoch,move_id AS moveId,updated_at AS updatedAt FROM session_homes WHERE session_id=?").get(input.sessionId) as Home | undefined;
      if (read()?.machineId) return result(1, "claim-home-assigned");
      const copies = await ports.recovery.conflicts(input.sessionId);
      if (!Array.isArray(copies) || !copies.length || !copies.some(copy => copy.machineId === input.machineId)) return result(1, "claim-origin-missing");
      if (new Set(copies.map(copy => copy.machineId)).size !== copies.length || copies.some(copy => !isMachineId(copy.machineId) || copy.owner?.kind !== "absent"))
        return result(1, "claim-copies-not-stopped");
      // No await between fresh home/revocation proof and the initial assignment transaction.
      return ports.globalDb.raw.transaction(() => {
        if (isRevoked(ports.recovery.revocationDb, input.machineId)) return result(1, "machine-revoked");
        const current = read();
        if (current?.machineId) return result(1, "claim-home-assigned");
        const home = current ? resolveInitialConflict(ports.globalDb, current, input.machineId, ports.config.hubMachineId)
          : assignInitialHome(ports.globalDb, input.sessionId, input.machineId, ports.config.hubMachineId);
        return home === "conflict" ? result(1, "claim-home-conflict") : result(0, "claimed", home);
      }).immediate();
    });
  } catch { return result(1, "claim-evidence-unavailable"); }
}

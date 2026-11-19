import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, renameSync, unlinkSync } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { writeLocal } from "@spider/db-core/roam/local-state";
import { recoverMirror, type MirrorSource } from "./mirrors";
import { privateDirectory } from "./staging";
import { join } from "node:path";
import { openDbReadOnly, type Db } from "@spider/db-core";
import type { ArtifactManifest, Journal, Operation, Outcome, RoamConfig, SessionManifest, Transport } from "./contracts";
import type { Peer } from "./contracts";
import { pullArtifact } from "./artifacts";
import { verifyFrozenSession } from "./session-file";
import { sessionHome } from "./homes";
import { syncHandshake, type SyncHandshake } from "./revocation";
import { agentFailureCode, RecoveryResponseError, recoveryRefusalCode } from "./peer-errors";
import { causeCode, safeCauseCode } from "./cause-codes";
export interface ProductionRecoveryPorts {
  mirrors: NonNullable<import("./sync").SyncPorts["mirrors"]>;
  retireOnly: NonNullable<import("./sync").SyncPorts["retireOnly"]>;
  supervisorHandshake(machineId: string): SyncHandshake;
}
export function createProductionRecoveryPorts(input: { root: string; config: RoamConfig; globalDb: Db; journal: Journal; transport: Transport }): ProductionRecoveryPorts {
  const { root, config, globalDb, journal, transport } = input;
  const request = async <T>(peer: Peer, kind: "mirror-export" | "supervisor-retire", args: import("@spider/db-core/roam/types").JsonObject, epoch: number | null): Promise<T> => {
    const operation: Operation = { id: randomUUID(), machineId: peer.machineId, expectedEpoch: epoch, kind, args };
    const bytes = await transport.exec(await transport.resolve(peer), ["roam", "agent", JSON.stringify(operation)], { timeoutMs: config.limits.controlMs, maxBytes: config.limits.replyBytes });
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new RecoveryResponseError("recovery-peer-invalid", 1, operation.id, kind);
    const reply = value as Partial<Outcome<T>>;
    if (reply.operationId !== operation.id || ![0, 1, 2, 3].includes(reply.code as number)) throw new RecoveryResponseError("recovery-peer-invalid", 1, operation.id, kind);
    if (reply.code !== 0) {
      const reason = agentFailureCode(reply.reason) === "agent-operation-failed" ? "agent-operation-failed" : recoveryRefusalCode(reply.reason) ?? "recovery-peer-refused";
      const cause = safeCauseCode(reply.causeCode) ?? (reason === "agent-operation-failed" ? causeCode(null, kind) : undefined);
      throw new RecoveryResponseError(reason, reply.code as 1 | 2 | 3, operation.id, kind, cause);
    }
    if (!reply.value) throw new RecoveryResponseError("recovery-peer-invalid", 1, operation.id, kind);
    return reply.value;
  };
  return {
    mirrors: { root: join(root, "roam", "mirrors"),
      homes(machine: string) { return (globalDb.prepare("SELECT session_id FROM session_homes WHERE machine_id=?").all(machine) as { session_id: string }[]).map(row => {
        const home = sessionHome(globalDb, row.session_id); if (!home || home === "unknown") throw new Error("mirror-home-unavailable"); return home;
      }); },
      async source(home: import("@spider/db-core/roam/types").Home, peer: Peer): Promise<MirrorSource> {
        let prefix: SessionManifest | null = null;
        try { prefix = await recoverMirror({ root: join(root, "roam", "mirrors"), sessionId: home.sessionId, epoch: home.epoch, machineId: peer.machineId, limits: config.limits }); }
        catch (error) { if (!["mirror-checkpoint-missing", "mirror-no-committed-prefix"].includes((error as { code?: string }).code ?? "")) throw error; }
        const value = await request<{ source: SessionManifest; artifact: ArtifactManifest | null; mode: "full" | "append" | "unchanged"; offset: number; reason: string }>(peer, "mirror-export", {
          sessionId: home.sessionId, sourceMachine: config.hubMachineId, moveId: home.moveId, prefix: prefix ? { size: prefix.size, sha256: prefix.sha256 } : null,
        }, home.epoch);
        if (value.source.sessionId !== home.sessionId || !Number.isSafeInteger(value.source.size) || value.source.size < 0 || !Number.isSafeInteger(value.offset) || value.offset < 0 || value.offset > value.source.size) throw new Error("mirror-session-mismatch");
        const transfer = { mode: value.mode, reason: value.reason, bytes: value.source.size - value.offset };
        const diagnostic = () => writeLocal(globalDb, "mirror-transfer", home.sessionId, transfer);
        if (value.mode === "unchanged") {
          if (!prefix || value.artifact !== null || value.offset !== prefix.size || value.source.size !== prefix.size || value.source.sha256 !== prefix.sha256) throw new Error("mirror-session-mismatch");
          await verifyFrozenSession({ ...value.source, file: prefix.file }, config.limits); diagnostic(); return { ...value.source, file: prefix.file, transfer };
        }
        if (value.mode !== "full" && value.mode !== "append" || value.mode === "full" && value.offset !== 0 || value.mode === "append" && (!prefix || value.offset !== prefix.size) ||
            !value.artifact || value.artifact.kind !== "session" || value.artifact.byteLength !== value.source.size - value.offset || value.mode === "full" && value.artifact.sha256 !== value.source.sha256) throw new Error("mirror-session-mismatch");
        const pulled = await pullArtifact(peer, value.artifact, { transport, journal, limits: config.limits, root: join(root, "roam", "staging") });
        if (pulled.code !== 0 || !pulled.value) throw new Error(pulled.reason);
        let file = pulled.value.file;
        if (value.mode === "append") {
          const directory = join(root, "roam", "mirror-snapshots"); privateDirectory(directory);
          const target = join(directory, `${createHash("sha256").update(JSON.stringify([home.sessionId, home.epoch])).digest("hex")}.jsonl`), temporary = `${target}.${randomUUID()}`;
          const tail = file, previous = prefix!.file;
          try {
            await pipeline(Readable.from((async function* () { for await (const bytes of createReadStream(previous)) yield bytes; for await (const bytes of createReadStream(tail)) yield bytes; })()), createWriteStream(temporary, { flags: "wx", mode: 0o600 }));
            await verifyFrozenSession({ ...value.source, file: temporary }, config.limits);
            renameSync(temporary, target); file = target;
          } catch (error) { try { unlinkSync(temporary); } catch { /* No incomplete snapshot is exposed. */ } throw error; }
        }
        const source = { ...value.source, file };
        await verifyFrozenSession(source, config.limits); diagnostic(); return { ...source, transfer };
      },
    },
    async retireOnly(peer: Peer, reply: Extract<SyncHandshake, { kind: "retire-only" }>): Promise<void> {
      if (reply.machineId !== peer.machineId || reply.reason !== "machine-revoked") throw new Error("retire-only-mismatch");
      await request(peer, "supervisor-retire", { sourceMachine: config.hubMachineId, reply: { ...reply } }, null);
    },
    supervisorHandshake(machineId: string): SyncHandshake {
      const db = openDbReadOnly(join(root, "roam", "journal.db"));
      if (!db) throw new Error("revocation-evidence-unavailable");
      try { return syncHandshake(db, machineId); } finally { db.close(); }
    },
  };
}

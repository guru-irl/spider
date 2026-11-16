// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { openDb } from "@spider/db-core";
import { createReplica, scratchDbPath } from "@spider/db-core/testutil";
import type { Home, HubOperationReadiness, Probe } from "@spider/db-core/roam/types";
import { DEFAULT_LIMITS, disabledIntercom } from "../contracts";
import type { MovePorts, Outcome, PaneTarget, SessionManifest } from "../contracts";
import { assignInitialHome } from "../homes";
import { openJournal } from "../journal";
import { appendMirror, recoverMirror } from "../mirrors";
import { inspectSession, stageSession } from "../session-file";

export const HUB = "00000000-0000-4000-8000-000000000001";
export const BOX = "00000000-0000-4000-8000-000000000002";
export const OTHER = "00000000-0000-4000-8000-000000000003";
export const unreachable = async (): Promise<never> => { throw new Error("unused recovery fixture port"); };
export interface RecoveryFixture {
  root: string; file: string; source: SessionManifest; oldHome: Home | null; mirror: SessionManifest; mirrorRoot: string;
  global: ReturnType<typeof createReplica>; journal: ReturnType<typeof openJournal>; revocationDb: ReturnType<typeof openDb>;
  ports: MovePorts; events: string[]; targets: PaneTarget[];
  copies(value: readonly { machineId: string; owner: Probe }[]): void;
  restored(): SessionManifest | null; bytes(): string; close(): void;
}
export async function recoveryFixture(assigned = true): Promise<RecoveryFixture> {
  const global = createReplica("global", HUB);
  const root = mkdtempSync(join(dirname(scratchDbPath("recovery")), "recovery-"));
  const journalFile = join(root, "journal.db"), journal = openJournal(journalFile), revocationDb = openDb(journalFile);
  const file = join(root, "source.jsonl"), mirrorRoot = join(root, "mirrors"), cwd = join(root, "workspace");
  mkdirSync(cwd);
  writeFileSync(file, JSON.stringify({ type: "session", version: 3, id: "session-a", timestamp: "2026-01-01T00:00:00Z", cwd }) + "\n" +
    JSON.stringify({ type: "message", id: "leaf-a", parentId: null, timestamp: "2026-01-01T00:00:00Z", message: { role: "user", content: "synthetic history", timestamp: 1 } }) + "\n", { mode: 0o600 });
  const source = await inspectSession(file, "session-a");
  journal.begin({ id: "mirror-a", kind: "sync", machineId: BOX, expectedEpoch: 1, args: {} });
  const mirror = await appendMirror({ sessionId: "session-a", epoch: 1, source, root: mirrorRoot, operationId: "mirror-a" }, journal);
  journal.record("mirror-a", "done", {});
  const oldHome = assigned ? assignInitialHome(global.db, "session-a", BOX, HUB) as Home : null;
  const events: string[] = [], targets: PaneTarget[] = [];
  let copies: readonly { machineId: string; owner: Probe }[] = [{ machineId: BOX, owner: { kind: "absent" } }, { machineId: OTHER, owner: { kind: "absent" } }];
  let restored: SessionManifest | null = null;
  const ports: MovePorts = {
    config: { enabled: true, role: "hub", machineId: HUB, hubMachineId: HUB, peers: [BOX, OTHER].map((machineId, i) => ({ machineId, alias: `box-${i + 1}.invalid`, node: "node", pi: "pi", cli: "spider", core: "core", globalRoot: root })), discoveryRoots: [], coreUnit: "fixture", syncMs: 120000, limits: DEFAULT_LIMITS, intercom: disabledIntercom() },
    globalDb: global.db, journal, clock: { now: () => 1, later: () => () => {} },
    intercom: { address: { scopeId: "fixture", sessionId: "session-a" }, ports: { close: unreachable, drain: unreachable, inspect: unreachable, checkGeneration: unreachable, abort: unreachable, ready: unreachable }, destinationEndpoint: unreachable },
    check: unreachable, power: async () => async () => {}, seed: unreachable, prepare: unreachable, freeze: unreachable, transfer: unreachable,
    verifySource: unreachable, barriers: unreachable, replicateHome: async () => { events.push("replicate-home"); }, start: unreachable, inspect: unreachable,
    retire: unreachable, unfreeze: unreachable, readmitSource: unreachable, cleanup: unreachable,
    recovery: {
      blockers: () => [], revocationDb,
      homes(machine) { return (global.db.prepare("SELECT session_id AS sessionId,machine_id AS machineId,epoch,move_id AS moveId,updated_at AS updatedAt FROM session_homes WHERE machine_id=?").all(machine)) as Home[]; },
      mirror: async (sessionId, epoch) => { events.push("mirror"); return recoverMirror({ sessionId, epoch, machineId: BOX, root: mirrorRoot }); },
      async restore(home, prefix, operation): Promise<Outcome<HubOperationReadiness>> {
        events.push("restore");
        restored = await stageSession({ source: prefix, destinationCwd: cwd, destinationParent: null, segment: { version: 1, moveId: operation.id, epoch: home.epoch, previousMachine: BOX, nextMachine: HUB, historyMachine: BOX, parentRef: null } }, join(root, "staging"));
        const value: HubOperationReadiness = { origin: "hub-operation", opId: operation.id, sessionId: home.sessionId, epoch: home.epoch, core: "fixture-core", terminal: "fixture-terminal", file: restored.file, cwd };
        return { code: 0, reason: "ready", operationId: operation.id, home, epoch: home.epoch, repairCommand: null, value };
      },
      conflicts: async () => copies,
      async presentReadyTarget(target) { events.push("present"); targets.push(target); return { status: "complete", reason: "presented", presentation: null }; },
    },
  };
  return { root, file, source, oldHome, mirror, mirrorRoot, global, journal, revocationDb, ports, events, targets,
    copies(value: typeof copies) { copies = value; }, restored: () => restored,
    bytes: () => readFileSync(restored!.file, "utf8"),
    close() { revocationDb.close(); global.close(); rmSync(root, { recursive: true, force: true }); } };
}

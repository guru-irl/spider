import { MoveSetupError, type MoveSetupStage } from "@spider/roam/setup-failure";
import { publishOwnedMoveReadiness } from "./move-readiness";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { dirname, join, resolve } from "node:path";
import { mkdirSync } from "node:fs";
import { paths } from "@spider/db-core";
import { recordLocation } from "@spider/db-core/roam/catalog";
import { readLocal } from "@spider/db-core/roam/local-state";
import { readSessionState } from "@spider/db-core/roam/state";
import type { Home, HubOperationReadiness } from "@spider/db-core/roam/types";
import { openFreezeJournal } from "@spider/roam/journal";
import { openLocalCore, readLocalIdentity } from "@spider/roam/runtime";
import { participantCaptureReady } from "@spider/roam/production-supervisor";
import { loadHerdrConfig } from "@spider/roam/production-hub";
import { sessionHome } from "@spider/roam/homes";
import { createTransport } from "@spider/roam/transport";
import { createHcClient } from "@spider/herdr/client/hc";
import { inspectIdLock } from "@spider/herdr/sessions/id-lock";
import type { AdmissionGate } from "./admission";
import { createLiveFreezePorts, inspectLiveOwner, type LiveFreezeInput } from "./live";
import { serveSessionControl } from "./control";
import { createHostMoveBindings } from "./move-runtime";
import { completeMoveRoster } from "./move-roster";
import { readmitLiveSession } from "./readmit";

export interface MoveActivationInput extends Pick<LiveFreezeInput, "usage" | "embeddings" | "organism" | "others" | "activity" | "bootId"> {
  root: string; sessionId: string; file: string; context(): ExtensionContext | undefined; gate: AdmissionGate;
}
export async function createMoveActivation(input: MoveActivationInput): Promise<{ close(): Promise<void>; ready(file: string, epoch: number, home: Home | null): Promise<void> } | null> {
  let config;
  try { config = readLocalIdentity(input.root); } catch { return null; }
  if (!(config.role === "hub" && config.enabled || config.role === "box" && participantCaptureReady(input.root, config.machineId))) return null;
  let mounted: Awaited<ReturnType<typeof createHostMoveBindings>> | undefined;
  let closeCore: (() => void) | undefined;
  let stage: MoveSetupStage = "move-bindings";
  try {
    const core = openLocalCore(input.root);
    closeCore = () => core.close();
    const journal = openFreezeJournal(join(input.root, "roam", "journal.db"));
    const herdr = loadHerdrConfig(input.root), transport = createTransport({ binary: herdr.core.binary, env: process.env, enrolled: config.peers });
    stage = "live-freeze";
    const context = input.context();
    if (!context || context.sessionManager.getSessionId() !== input.sessionId || context.sessionManager.getSessionFile() !== input.file) throw new Error("participant-context-unavailable");
    const old = core.db.prepare("SELECT stores_json FROM roam_locations WHERE session_id=?").get(input.sessionId) as { stores_json: string } | undefined;
    const maps = core.db.prepare("SELECT repo_key,workspace_id,path FROM roam_workspace_maps").all() as { repo_key: string; workspace_id: string; path: string }[];
    const current = maps.filter(row => resolve(row.path) === resolve(dirname(paths.projectRoot(context.cwd))));
    const expectedStores = completeMoveRoster(old ? JSON.parse(old.stores_json) : ["global"], current.length === 1 ? current[0] : undefined);
    stage = "move-bindings";
    mounted = await createHostMoveBindings({ root: input.root, globalDb: core.db, config, journal, sessionId: input.sessionId, transport, storeKeys: expectedStores });
    stage = "live-freeze";
    const bindings = mounted.bindings, participant = bindings.participant!, stores = participant.stores;
    const home = sessionHome(core.db, input.sessionId); if (home === "unknown") throw new Error("participant-home-unavailable");
    if (current.length === 1 || old) recordLocation(core.db, { sessionId: input.sessionId, stores: expectedStores, home, file: input.file, cwd: context.cwd });
    const address = bindings.intercom!.address;
    const scratchRoots = [paths.scratch("project", context.cwd), paths.scratch("global")];
    for (const root of scratchRoots) mkdirSync(root, { recursive: true });
    const live = createLiveFreezePorts({ ...input, globalRoot: input.root, machineId: config.machineId, stores: stores.map(row => row.db), expectedStores,
      routeStores: [core.db], address, jobRoots: [join(input.root, "herdr", "jobs")], scratchRoots,
      broker: bindings.evidence!.broker, bridge: bindings.evidence!.bridge, settlement: bindings.evidence!.settlement,
      authorizeAbort: bindings.evidence!.authorizeAbort, onHubRestored: bindings.evidence!.onHubRestored,
      intercom: { address, ports: bindings.intercom!.ports }, shutdown: async () => { input.context()?.shutdown(); } });
    const ready = (file: string, epoch: number, home: Home | null, readmitOperationId?: string): Promise<HubOperationReadiness | null> => publishOwnedMoveReadiness({
      db: core.db, journal, sessionId: input.sessionId, machineId: config.machineId, file, cwd: input.context()!.cwd, epoch, home, readmitOperationId,
      owner: () => inspectLiveOwner(join(input.root, "herdr"), input.sessionId, file, input.bootId),
      lock: () => inspectIdLock(join(input.root, "herdr"), input.sessionId),
      async caller() {
        const hc = createHcClient({ binary: herdr.core.binary, env: process.env });
        try { const terminal = await hc.caller(process.env); return { coreId: terminal.coreId, address: terminal.address }; }
        finally { await hc.dispose(); }
      },
    });
    live.initialInspect = async operation => {
      const ctx = input.context(), row = core.db.prepare("SELECT 1 FROM session_homes WHERE session_id=?").get(input.sessionId);
      if (config.role !== "hub" || !config.enabled || operation.machineId !== config.machineId || operation.expectedEpoch !== 1 || row || !ctx || ctx.mode !== "tui" || !ctx.hasUI ||
          ctx.sessionManager.getSessionId() !== input.sessionId || ctx.sessionManager.getHeader()?.parentSession || !stores.some(row => row.key.startsWith("worktree:"))) throw new Error("initial-source-unavailable");
      for (const { db, key } of stores.filter(row => row.key.startsWith("worktree:"))) {
        const origin = db.prepare("SELECT origin_machine FROM sessions WHERE id=?").get(input.sessionId) as { origin_machine: string } | undefined;
        const state = readSessionState(db, input.sessionId);
        if (origin?.origin_machine !== config.machineId || state && (state.epoch !== 1 || state.state !== "active")) throw new Error("initial-source-unavailable");
      }
      return live.inspect();
    };
    live.readmit = operation => readmitLiveSession(operation, { globalDb: core.db, machineId: config.machineId, stores, journal, limits: config.limits,
      proof: op => bindings.evidence!.rollback!(op), owner: async () => ({ kind: "live", identity: await inspectLiveOwner(join(input.root, "herdr"), input.sessionId, input.file, input.bootId) }),
      async readmit(home, op) { if (!input.gate.readmit) throw new Error("move-rollback-proof-missing"); await input.gate.readmit(String(op.args.moveId), op.args.source as unknown as Home, home); const result = await ready(input.file, home.epoch, home, op.id); if (!result) throw new Error("move-rollback-proof-missing"); return result; },
      reopen: bindings.intercom!.rollback.reopen, resume: live.resume });
    stage = "socket-publication";
    const socket = await serveSessionControl({ sessionId: input.sessionId, runtimeRoot: participant.runtimeRoot, ports: live });
    return { async close() { try { await socket.close(); } finally { await mounted!.close(); core.close(); } }, async ready(file, epoch, home) { if (config.role === "hub") await ready(file, epoch, home); } };
  } catch (error) {
    const failure = new MoveSetupError(stage, error);
    if (failure.code === "participant-stores-unavailable") failure.message = failure.code;
    try { try { await mounted?.close(); } finally { closeCore?.(); } }
    catch { /* Retain the setup cause, not a secondary cleanup exception. */ }
    throw failure;
  }
}

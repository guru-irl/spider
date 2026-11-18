import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { getBinding, openDb, openDbAt, paths, type Db } from "@spider/db-core";
import { mapWorkspace, resolveRepositoryKey } from "@spider/db-core/roam/repo-map";
import { createHcClient } from "@spider/herdr/client/hc";
import { inspectIdLock } from "@spider/herdr/sessions/id-lock";
import { loadHerdrConfig } from "@spider/roam/production-hub";
import type { Home, HubOperationReadiness, Readiness, StoreKey } from "@spider/db-core/roam/types";
import { readLocal, writeLocal } from "@spider/db-core/roam/local-state";
import { readSessionHeader } from "@spider/herdr/sessions/launcher";
import type { Journal, RoamConfig, PlacementPort } from "@spider/roam/contracts";
import { assertBoxEnrollment, participantCaptureInitialized, createRunningIntentAuthority, recordReadiness, seedNewParticipant, type BoxLocalOrigin, type RunningIntentAuthority } from "@spider/roam/session-control";
import { unfinishedFreeze } from "@spider/roam/participant-supervisor";
import { openLocalCore, readLocalIdentity } from "@spider/roam/runtime";
import { participantCaptureReady } from "@spider/roam/production-supervisor";
import { openJournal } from "@spider/roam/journal";
import { sessionHome } from "@spider/roam/homes";
import { isRevoked } from "@spider/roam/revocation";
import type { PaneTarget } from "@spider/roam/contracts";
import type { PaneTarget as HerdrPaneTarget, PaneActionOutcome } from "@spider/herdr/panes/types";
import { createProductionRoamPresentationPorts } from "../herdr/roam-presentations";
import { createAppClient } from "@spider/herdr/client/app";
import { createRoamPlacement } from "@spider/herdr/roam-placement";
import { createTerminalRegistry } from "@spider/herdr/sessions/registry";
import { removedPlacementSessions } from "@spider/roam/placement-inventory";

export function createHostRoamPlacement(input: { root: string; globalDb: Db; config: RoamConfig }): PlacementPort & { dispose(): Promise<void> } {
  const herdr = loadHerdrConfig(input.root), env = { ...process.env, SPIDER_GLOBAL_ROOT: input.root };
  if (herdr.mode === "core-only") return { reconcile: async rows => ({ pending: rows.map(row => row.terminal) }), dispose: async () => {} };
  const hc = createHcClient({ binary: herdr.core.binary, env });
  const revocationDb = openDb(join(input.root, "roam", "journal.db"), { fileMustExist: true, checkpointOnClose: false });
  const presentations = createHostRoamPresentationPorts({ ...input, revocationDb });
  const placement = createRoamPlacement({ stateRoot: join(input.root, "roam", "placement"), hc, hcBinary: herdr.core.binary,
    app: createAppClient({ binary: herdr.app.binary, env: { ...env, HERDR_APP_HOME: herdr.app.home } }), registry: createTerminalRegistry(join(input.root, "herdr")),
    removedSessions: async sessions => removedPlacementSessions(input.globalDb, sessions),
    presentation: { async resolveTarget(ready) {
      const home = sessionHome(input.globalDb, ready.sessionId);
      if (!home || home === "unknown" || home.epoch !== ready.epoch) return null;
      const peer = input.config.peers.find(peer => peer.machineId === home.machineId), parts = ready.terminal.split("/");
      if (parts.length > 2 || !parts.at(-1) || peer && (peer.core !== ready.core || parts.length === 2 && ![peer.alias, peer.core].includes(parts[0]))) return null;
      return presentations.resolveTarget({ machineId: home.machineId, alias: null, sessionId: ready.sessionId, homeEpoch: ready.epoch, coreId: ready.core, terminalId: parts.at(-1)! });
    }, presentReadyTarget: target => presentations.presentVerifiedTarget(target) },
  });
  return { reconcile: placement.reconcile, async dispose() { try { await presentations.dispose(); await hc.dispose(); } finally { revocationDb.close(); } } };
}

export interface HostRoamPresentationPorts {
  resolveTarget(locator: PaneTarget): Promise<HerdrPaneTarget | null>;
  presentVerifiedTarget(target: HerdrPaneTarget): Promise<PaneActionOutcome>;
  prepareHandoff(source: Home): Promise<PaneActionOutcome>;
  presentReadyTarget(locator: PaneTarget): Promise<PaneActionOutcome>;
  dispose(): Promise<void>;
}
export function createHostRoamPresentationPorts(input: { root: string; globalDb: Db; revocationDb: Db; config: RoamConfig }): HostRoamPresentationPorts {
  const ports = createProductionRoamPresentationPorts(input.root);
  const current = (session: string, machine: string, epoch: number) => {
    const home = sessionHome(input.globalDb, session);
    return !!home && home !== "unknown" && home.machineId === machine && home.epoch === epoch && !isRevoked(input.revocationDb, machine);
  };
  const unavailable = (reason: string): PaneActionOutcome => ({ status: "pending", reason, presentation: null });
  const resolveTarget = async (locator: PaneTarget): Promise<HerdrPaneTarget | null> => {
    if (!current(locator.sessionId, locator.machineId, locator.homeEpoch)) return null;
    const peer = input.config.peers.find(peer => peer.machineId === locator.machineId);
    if (peer && peer.core !== locator.coreId || !peer && locator.machineId !== input.config.machineId) return null;
    const target = await ports.resolveTarget({ ...locator, local: locator.machineId === input.config.machineId });
    return target && target.sessionId === locator.sessionId && target.coreId === locator.coreId && target.terminalId === locator.terminalId && target.homeEpoch === locator.homeEpoch && current(locator.sessionId, locator.machineId, locator.homeEpoch) ? target : null;
  };
  return {
    resolveTarget,
    async presentVerifiedTarget(target: HerdrPaneTarget): Promise<PaneActionOutcome> {
      if (!target.sessionId) return unavailable("presentation-readiness-unavailable");
      const home = sessionHome(input.globalDb, target.sessionId);
      if (!home || home === "unknown" || home.epoch !== target.homeEpoch || !current(home.sessionId, home.machineId, home.epoch)) return { status: "refused", reason: "presentation-home-changed", presentation: null };
      return ports.presentReadyTarget(target);
    },
    async prepareHandoff(source: Home): Promise<PaneActionOutcome> {
      if (!current(source.sessionId, source.machineId, source.epoch)) return { status: "refused", reason: "presentation-home-changed", presentation: null };
      const peer = input.config.peers.find(peer => peer.machineId === source.machineId);
      if (!peer && source.machineId !== input.config.machineId) return { status: "refused", reason: "presentation-machine-unavailable", presentation: null };
      try {
        const target = await ports.resolveTarget({ sessionId: source.sessionId, machineId: source.machineId, homeEpoch: source.epoch,
          coreId: peer?.core, local: source.machineId === input.config.machineId });
        if (!target || target.sessionId !== source.sessionId || target.homeEpoch !== source.epoch || !current(source.sessionId, source.machineId, source.epoch)) return unavailable("presentation-source-unavailable");
        return await ports.prepareHandoff(target.sessionId!, target);
      } catch { return unavailable("presentation-unavailable"); }
    },
    async presentReadyTarget(locator: PaneTarget): Promise<PaneActionOutcome> {
      if (!current(locator.sessionId, locator.machineId, locator.homeEpoch)) return { status: "refused", reason: "presentation-home-changed", presentation: null };
      try {
        const target = await resolveTarget(locator);
        if (!target || target.sessionId !== locator.sessionId || target.coreId !== locator.coreId || target.terminalId !== locator.terminalId || target.homeEpoch !== locator.homeEpoch || !current(locator.sessionId, locator.machineId, locator.homeEpoch)) return unavailable("presentation-readiness-unavailable");
        return await ports.presentReadyTarget(target);
      } catch { return unavailable("presentation-unavailable"); }
    },
    dispose: () => ports.dispose(),
  };
}
export { createNativeHostingOutcomeReader } from "@spider/roam/hosting";
export interface ParticipantAdmissionHooks {
  prepare(sessionId: string, file: string): Promise<void>;
  ready(sessionId: string, file: string, epoch: number, home: Home | null): Promise<void>;
  stopped(sessionId: string): Promise<void>;
}

export function persistReadiness(journal: Journal, ready: HubOperationReadiness): void { recordReadiness(journal, ready); }
export interface AdmissionRuntime {
  config: RoamConfig; db: Db; journal: Journal; authority: RunningIntentAuthority;
  stores(sessionId: string): Promise<readonly { db: Db; key: StoreKey }[]>;
  close(): void;
}
export function createParticipantAdmission(input: {
  open(): Promise<AdmissionRuntime | null>;
  cwd(): string | undefined;
  terminal(sessionId: string): Promise<{ core: string; terminal: string; operationId: string | null; owner: { pid: number; startIdentity: string } }>;
}): ParticipantAdmissionHooks {
  return {
    async prepare(sessionId, file) {
      const runtime = await input.open(); if (!runtime) return;
      try {
        if (runtime.config.role !== "box" || !participantCaptureInitialized(runtime.db, runtime.config.machineId, "global")) return;
        assertBoxEnrollment(runtime.config);
        if (runtime.db.prepare("SELECT 1 FROM session_homes WHERE session_id=?").get(sessionId)) return;
        if (unfinishedFreeze(dirname(runtime.db.raw.name), sessionId)) throw new Error("Participant has an unfinished freeze");
        const cwd = input.cwd(); if (!cwd) throw new Error("Participant cwd unavailable");
        const header = await readSessionHeader(file);
        if (header.id !== sessionId || header.cwd !== cwd) throw new Error("Participant exact file mismatch");
        seedNewParticipant({ globalDb: runtime.db, machineId: runtime.config.machineId, sessionId, file, cwd,
          stores: await runtime.stores(sessionId), limit: runtime.config.limits.targetBatchBytes });
      } finally { runtime.close(); }
    },
    async ready(sessionId, file, epoch, home) {
      const runtime = await input.open(); if (!runtime) return;
      try {
        const cwd = input.cwd(); if (!cwd) throw new Error("Participant cwd unavailable");
        const header = await readSessionHeader(file);
        if (header.id !== sessionId || header.cwd !== cwd) throw new Error("Participant exact file mismatch");
        assertBoxEnrollment(runtime.config);
        if (!participantCaptureInitialized(runtime.db, runtime.config.machineId, "global")) throw new Error("Participant capture is not initialized");
        if (unfinishedFreeze(dirname(runtime.db.raw.name), sessionId)) throw new Error("Participant has an unfinished freeze");
        const previous = await runtime.authority.get(sessionId);
        if (previous && !runtime.authority.authorized(sessionId, runtime.config.hubMachineId, runtime.config.machineId)) throw new Error("participant-intent-untrusted");
        if (previous && (previous.desired === "stopped" || previous.suspended)) throw new Error("Participant is stopped or suspended");
        if (previous && (previous.epoch !== epoch || previous.cwd !== cwd || previous.file !== file)) throw new Error("Participant authority mismatch");
        const terminal = await input.terminal(sessionId);
        const origin = readLocal<BoxLocalOrigin>(runtime.db, "participant-origin", sessionId);
        const localOwner = origin?.kind === "box-local" && origin.machineId === runtime.config.machineId && origin.epoch === epoch &&
          origin.file === file && origin.cwd === cwd && !origin.stopped && origin.pid === terminal.owner.pid && origin.startIdentity === terminal.owner.startIdentity;
        if (!previous) {
          if (terminal.operationId) throw new Error("participant-hub-intent-required");
          if (origin?.stopped) throw new Error("participant-stopped");
          if (home && (home.machineId !== runtime.config.machineId || home.epoch !== epoch || !localOwner)) throw new Error("participant-hub-intent-required");
          const local: BoxLocalOrigin = { kind: "box-local", machineId: runtime.config.machineId, epoch, file, cwd, ...terminal.owner, stopped: false };
          runtime.db.raw.transaction(() => writeLocal(runtime.db, "participant-origin", sessionId, local)).immediate();
        } else if (!terminal.operationId && !localOwner) throw new Error("participant-launch-provenance-unavailable");
        const common = { sessionId, epoch, cwd, file, core: terminal.core, terminal: terminal.terminal };
        let ready: Readiness;
        if (previous && terminal.operationId) {
          ready = { origin: "hub-operation", opId: terminal.operationId, ...common };
          persistReadiness(runtime.journal, ready);
        } else ready = { origin: "box-local", machineId: runtime.config.machineId, ...common };
        runtime.db.raw.transaction(() => writeLocal(runtime.db, "participant-ready", sessionId, ready)).immediate();
      } finally { runtime.close(); }
    },
    async stopped(sessionId) {
      const runtime = await input.open(); if (!runtime) return;
      try {
        if (await runtime.authority.get(sessionId)) await runtime.authority.stop(sessionId);
        else {
          const origin = readLocal<BoxLocalOrigin>(runtime.db, "participant-origin", sessionId);
          if (origin) runtime.db.raw.transaction(() => writeLocal(runtime.db, "participant-origin", sessionId, { ...origin, stopped: true })).immediate();
        }
      }
      finally { runtime.close(); }
    },
  };
}

/** Resolve only configured participation. Ordinary installations never create roaming state. */
export function openAdmissionRuntime(root: string, stores: (db: Db, sessionId: string) => Promise<readonly { db: Db; key: StoreKey }[]>): AdmissionRuntime | null {
  if (!existsSync(join(root, "roam", "config.json")) || !participantCaptureReady(root)) return null;
  let config: RoamConfig;
  try { config = readLocalIdentity(root); } catch { throw new Error("participant-config-unavailable"); }
  if (config.role !== "box" || !participantCaptureReady(root, config.machineId)) return null;
  const core = openLocalCore(root);
  if (core.config.role !== "box") { core.close(); return null; }
  try { return { ...core, journal: openJournal(join(root, "roam", "journal.db")), authority: createRunningIntentAuthority(core.db), stores: id => stores(core.db, id) }; }
  catch (error) { core.close(); throw error; }
}

export function productionParticipantAdmission(cwd: () => string | undefined): ParticipantAdmissionHooks {
  return createParticipantAdmission({ cwd,
    async open() {
      const opened: Db[] = [];
      const runtime = openAdmissionRuntime(paths.globalRoot, async (global, sessionId) => {
        const current = cwd(); if (!current) throw new Error("Participant cwd unavailable");
        const binding = getBinding(global, sessionId);
        const roots = [...new Set([current, ...(binding ? [binding] : [])].map(path => dirname(paths.projectRoot(path))))];
        const stores: Array<{ db: Db; key: StoreKey }> = [];
        for (const root of roots) {
          const db = openDbAt(join(root, ".spider", "project.db"), "worktree"); opened.push(db);
          const meta = db.prepare("SELECT store_key FROM roam_meta WHERE id=1").get() as { store_key: StoreKey | null };
          let key = meta.store_key;
          if (!key) {
            const repoKey = resolveRepositoryKey(global, root);
            let workspaceId = readLocal<string>(db, "workspace", "id");
            if (!workspaceId) { workspaceId = randomUUID(); db.raw.transaction(() => writeLocal(db, "workspace", "id", workspaceId)).immediate(); }
            key = `worktree:${repoKey}:${workspaceId}`;
            await mapWorkspace(global, { repoKey, workspaceId, path: root });
          }
          stores.push({ db, key });
        }
        return stores;
      });
      if (!runtime) return null;
      return { ...runtime, close() { try { for (const db of opened) db.close(); } finally { runtime.close(); } } };
    },
    async terminal(sessionId) {
      const root = resolve(paths.globalRoot), config = loadHerdrConfig(root), env = Object.freeze({ ...process.env });
      const client = createHcClient({ binary: config.core.binary, env });
      try {
        const terminal = await client.caller(env), lock = await inspectIdLock(join(root, "herdr"), sessionId);
        if (!lock?.identity.startIdentity) throw new Error("Participant owner identity unavailable");
        return { core: terminal.coreId, terminal: terminal.address, operationId: lock.operationId ?? null, owner: { pid: lock.identity.pid, startIdentity: lock.identity.startIdentity } };
      } finally { await client.dispose(); }
    },
  });
}

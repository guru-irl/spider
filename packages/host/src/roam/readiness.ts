import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { getBinding, openDbAt, paths, type Db } from "@spider/db-core";
import { mapWorkspace, resolveRepositoryKey } from "@spider/db-core/roam/repo-map";
import { createHcClient } from "@spider/herdr/client/hc";
import { inspectIdLock } from "@spider/herdr/sessions/id-lock";
import { loadHerdrConfig } from "@spider/roam/production-hub";
import type { Home, HubOperationReadiness, Readiness, StoreKey } from "@spider/db-core/roam/types";
import { readLocal, writeLocal } from "@spider/db-core/roam/local-state";
import { readSessionHeader } from "@spider/herdr/sessions/launcher";
import type { Journal, RoamConfig } from "@spider/roam/contracts";
import { assertBoxEnrollment, participantCaptureInitialized, createRunningIntentAuthority, recordReadiness, seedNewParticipant, type BoxLocalOrigin, type RunningIntentAuthority } from "@spider/roam/session-control";
import { unfinishedFreeze } from "@spider/roam/participant-supervisor";
import { openLocalCore, readLocalIdentity } from "@spider/roam/runtime";
import { participantCaptureReady } from "@spider/roam/production-supervisor";
import { openJournal } from "@spider/roam/journal";
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
          if (origin?.stopped && origin.pid === terminal.owner.pid && origin.startIdentity === terminal.owner.startIdentity) throw new Error("Participant is stopped");
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

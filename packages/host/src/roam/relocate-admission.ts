import type { Db } from "@spider/db-core";
import type { HomeAdmission, HomeStore, RunningHome, SessionId, SessionMachinePorts } from "@spider/roam/relocate/types";
import { resolve, join } from "node:path";
import { openDbReadOnlyAt, openGlobalReadOnly, paths } from "@spider/db-core";
import { clearAwayHomeFence, readAwayHomeFence, type AwayHomeFence } from "@spider/roam/relocate/away-home";
import { createHomeStore } from "@spider/roam/relocate/home";
import { readLocalIdentity } from "@spider/roam/runtime";
import type { RoamConfig } from "@spider/roam/contracts";

function isAuthoritativeHub(db: Db, config: RoamConfig): boolean {
  const meta = db.prepare("SELECT machine_id,store_key FROM roam_meta WHERE id=1").get() as { machine_id: string; store_key: string | null } | undefined;
  return config.role === "hub" && config.machineId === config.hubMachineId && meta?.machine_id === config.machineId &&
    (meta.store_key === "global" || meta.store_key === null);
}

function hasManagedMarker(db: Db, sessionId: SessionId): boolean {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='roam_cursors'").get()) return false;
  // writeLocal encodes [key, value]. Presence alone fences a missing home, even
  // with a damaged value. Never parse other sessions' local state here.
  const key = `spider-local:relocate-managed:[${JSON.stringify(sessionId)},`;
  return !!db.prepare("SELECT 1 FROM roam_cursors WHERE peer_machine='' AND instr(peer_stream, ?)=1 LIMIT 1").get(key);
}

export type LocalHomeAdmission = HomeAdmission | { kind: "virgin-local" };

export async function loadRelocateAdmission(sessionId: SessionId, root: string): Promise<LocalHomeAdmission> {
  let db: Db | undefined, fence: AwayHomeFence | null = null;
  const unavailable = (): HomeAdmission => fence ? { kind: "unavailable", awayMachine: fence.machineId } : { kind: "unavailable" };
  try {
    fence = await readAwayHomeFence(root, sessionId);
    db=root===paths.globalRoot ? openGlobalReadOnly() : openDbReadOnlyAt(join(root,"spider.db"));
    if (fence) {
      if (!db) return unavailable();
      const config = readLocalIdentity(root);
      if (!isAuthoritativeHub(db, config)) return unavailable();
      const home = await createHomeStore({ db, hubMachineId: config.hubMachineId, localMachineId: config.machineId }).read(sessionId);
      if (home?.state !== "running" || home.machineId !== config.machineId || home.epoch <= fence.epoch ||
          !await clearAwayHomeFence(root, sessionId, fence)) return unavailable();
      return { kind: "managed", home };
    }
    if (!db) return { kind: "unmanaged" };
    const store = db;
    const knownManaged = (id: SessionId) => hasManagedMarker(store, id);
    if (!store.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='session_homes'").get())
      return knownManaged(sessionId) ? unavailable() : { kind: "unmanaged" };
    const result = await readRelocateAdmission(sessionId, store, () => {
      const config = readLocalIdentity(root);
      return createHomeStore({ db: store, hubMachineId: config.hubMachineId, localMachineId: config.machineId });
    }, knownManaged);
    // A crash before the first moving CAS may strand an ordinary Mac session
    // with an initial home but no managed checkout. Keep the startup ID lock.
    if (result.kind === "managed" && result.home?.state === "running" && result.home.moveId === null && !knownManaged(sessionId)) {
      const config = readLocalIdentity(root);
      if (result.home.machineId === config.machineId && isAuthoritativeHub(store, config)) return { kind: "virgin-local" };
    }
    return result;
  }catch{return unavailable();}
  finally{db?.close();}
}

export async function prepareRelocateAdmission(home: RunningHome, file: string, machine: SessionMachinePorts): Promise<void> {
  const located = await machine.locate(home.machineId, home.sessionId);
  if (!located.ok) throw new Error(located.refusal.code);
  const placement = located.value;
  if (placement.sessionId !== home.sessionId || placement.machineId !== home.machineId || resolve(placement.file) !== resolve(file)) throw new Error("home-conflict");
  const activated = await machine.activate(home, placement);
  if (!activated.ok) throw new Error(activated.refusal.code);
}

/** A failed lookup is never evidence that a session is ordinary legacy work. */
export async function readRelocateAdmission(sessionId: SessionId, db: Db, homes: HomeStore | (() => HomeStore),
  knownManaged: (sessionId: SessionId) => boolean): Promise<HomeAdmission> {
  try {
    // A pre-v0 store has no state column. Its rows remain legacy.
    const row = db.prepare("SELECT * FROM session_homes WHERE session_id=?").get(sessionId) as { state?: unknown } | undefined;
    if (!row) return knownManaged(sessionId) ? { kind: "managed", home: null } : { kind: "unmanaged" };
    if (row.state == null) return knownManaged(sessionId) ? { kind: "managed", home: null } : { kind: "unmanaged" };
    const store = typeof homes === "function" ? homes() : homes;
    return { kind: "managed", home: await store.read(sessionId) };
  } catch { return { kind: "unavailable" }; }
}

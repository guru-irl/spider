import type { Db } from "@spider/db-core";
import type { HomeAdmission, HomeStore, RunningHome, SessionId, SessionMachinePorts } from "@spider/roam/relocate/types";
import { resolve, join } from "node:path";
import { openDbReadOnlyAt, openGlobalReadOnly, paths } from "@spider/db-core";
import { readLocal } from "@spider/db-core/roam/local-state";
import { clearAwayHomeFence, readAwayHomeFence, type AwayHomeFence } from "@spider/roam/relocate/away-home";
import { createHomeStore } from "@spider/roam/relocate/home";
import { readLocalIdentity } from "@spider/roam/runtime";

export async function loadRelocateAdmission(sessionId: SessionId, root: string): Promise<HomeAdmission> {
  let db: Db | undefined, fence: AwayHomeFence | null = null;
  const unavailable = (): HomeAdmission => fence ? { kind: "unavailable", awayMachine: fence.machineId } : { kind: "unavailable" };
  try {
    fence = await readAwayHomeFence(root, sessionId);
    db=root===paths.globalRoot ? openGlobalReadOnly() : openDbReadOnlyAt(join(root,"spider.db"));
    if (fence) {
      if (!db) return unavailable();
      const config = readLocalIdentity(root);
      const meta = db.prepare("SELECT machine_id,store_key FROM roam_meta WHERE id=1").get() as { machine_id: string; store_key: string | null } | undefined;
      if (config.role !== "hub" || config.machineId !== config.hubMachineId || meta?.machine_id !== config.machineId ||
          (meta.store_key !== "global" && meta.store_key !== null)) return unavailable();
      const home = await createHomeStore({ db, hubMachineId: config.hubMachineId, localMachineId: config.machineId }).read(sessionId);
      if (home?.state !== "running" || home.machineId !== config.machineId || home.epoch <= fence.epoch ||
          !await clearAwayHomeFence(root, sessionId, fence)) return unavailable();
      return { kind: "managed", home };
    }
    if(!db)return {kind:"unmanaged"};
    const cursors=db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='roam_cursors'").get();
    const managed=!!cursors && readLocal(db,"relocate-managed",sessionId)!==undefined;
    const table=db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='session_homes'").get();
    if(!table)return managed ? {kind:"unavailable"} : {kind:"unmanaged"};
    const columns=db.prepare("PRAGMA table_info(session_homes)").all() as {name:string}[];
    const row=db.prepare(columns.some(c=>c.name==="state") ? "SELECT state FROM session_homes WHERE session_id=?" : "SELECT NULL AS state FROM session_homes WHERE session_id=?").get(sessionId) as {state:unknown}|undefined;
    if(row?.state===null || !row && !managed)return {kind:"unmanaged"};
    const config=readLocalIdentity(root);
    const homes=createHomeStore({db,hubMachineId:config.hubMachineId,localMachineId:config.machineId});
    return await readRelocateAdmission(sessionId,db,homes,()=>managed);
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
export async function readRelocateAdmission(sessionId: SessionId, db: Db, homes: HomeStore,
  knownManaged: (sessionId: SessionId) => boolean): Promise<HomeAdmission> {
  try {
    const columns = db.prepare("PRAGMA table_info(session_homes)").all() as { name: string }[];
    const hasState = columns.some(column => column.name === "state");
    const row = db.prepare(hasState ? "SELECT state FROM session_homes WHERE session_id=?"
      : "SELECT NULL AS state FROM session_homes WHERE session_id=?").get(sessionId) as { state: unknown } | undefined;
    if (row?.state === null) return { kind: "unmanaged" };
    if (!row) return knownManaged(sessionId) ? { kind: "managed", home: null } : { kind: "unmanaged" };
    return { kind: "managed", home: await homes.read(sessionId) };
  } catch { return { kind: "unavailable" }; }
}

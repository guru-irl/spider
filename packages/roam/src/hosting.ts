import type { Db } from "@spider/db-core";
import { localEntries, readLocal } from "@spider/db-core/roam/local-state";
import { parseReadiness } from "@spider/db-core/roam/readiness";
import type { Readiness } from "@spider/db-core/roam/types";
import type { BoxLocalOrigin, RunningIntentAuthority } from "./session-control";
import type { Journal } from "./contracts";
import type { IntentStore } from "./intent";
import { readReadiness } from "./session-control";

export interface HostingObservation { readiness: readonly Readiness[]; suspensions: readonly { sessionId: string; epoch: number }[] }
export async function observeHosting(ports: { db: Db; journal: Journal; authority: RunningIntentAuthority; intents: IntentStore;
  machineId: string; hubMachineId: string; live(ready: Readiness): Promise<boolean> }): Promise<HostingObservation> {
  const readiness: Readiness[] = [], suspensions: Array<{ sessionId: string; epoch: number }> = [];
  const meta = ports.db.prepare("SELECT machine_id FROM roam_meta WHERE id=1").get() as { machine_id: string } | undefined;
  if (meta?.machine_id !== ports.machineId) return { readiness, suspensions };
  const ids = new Set([...(await ports.authority.list()), ...localEntries<BoxLocalOrigin>(ports.db, "participant-origin").map(row => row.key)]);
  for (const id of ids) {
    let intent = await ports.authority.get(id);
    const home = ports.db.prepare("SELECT machine_id,epoch,move_id FROM session_homes WHERE session_id=?").get(id) as { machine_id: string; epoch: number; move_id: string | null } | undefined;
    if (intent) {
      if (!ports.authority.authorized(id, ports.hubMachineId, ports.machineId) || !home || home.machine_id !== ports.machineId ||
          home.epoch !== intent.epoch || home.move_id !== intent.moveId) continue;
    } else {
      const origin = readLocal<BoxLocalOrigin>(ports.db, "participant-origin", id);
      if (!origin || origin.kind !== "box-local" || origin.stopped) continue;
      if (origin.machineId !== ports.machineId || home && (home.machine_id !== origin.machineId || home.epoch !== origin.epoch || home.move_id !== null)) continue;
      intent = { sessionId: id, epoch: origin.epoch, file: origin.file, cwd: origin.cwd, desired: "running", suspended: null, moveId: null };
    }
    const view = await ports.intents.get(id);
    if (intent.suspended || view?.value.intent.epoch === intent.epoch && view.value.intent.suspended) {
      suspensions.push({ sessionId: id, epoch: intent.epoch }); continue;
    }
    if (intent.desired !== "running") continue;
    const stored = readLocal<unknown>(ports.db, "participant-ready", id);
    if (!stored) continue;
    const ready = parseReadiness(stored);
    if (ready.sessionId !== id || ready.epoch !== intent.epoch || ready.file !== intent.file || ready.cwd !== intent.cwd) continue;
    if (ready.origin === "hub-operation") {
      const receipt = readReadiness(ports.journal, ready.opId);
      if (!receipt || JSON.stringify(receipt) !== JSON.stringify(ready)) throw new Error("Readiness receipt mismatch");
    } else {
      const origin = readLocal<BoxLocalOrigin>(ports.db, "participant-origin", id);
      if (!origin || origin.stopped || origin.machineId !== ready.machineId || origin.epoch !== ready.epoch || origin.file !== ready.file || origin.cwd !== ready.cwd) continue;
    }
    if (await ports.live(ready)) readiness.push(ready);
  }
  return { readiness, suspensions };
}

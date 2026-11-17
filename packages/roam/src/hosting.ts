import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import type { Db } from "@spider/db-core";
import { localEntries, readLocal, writeLocal } from "@spider/db-core/roam/local-state";
import { parseReadiness } from "@spider/db-core/roam/readiness";
import type { Readiness } from "@spider/db-core/roam/types";
import type { HcClient, TerminalAddress } from "@spider/herdr";
import { withProcessLock } from "@spider/herdr/sessions/registry";
import type { BoxLocalOrigin, RunningIntentAuthority } from "./session-control";
import type { HostIntent, Journal, NativeHostingOutcome } from "./contracts";
import type { IntentStore } from "./intent";
import { readHostingWarnings, type SessionHostingWarning } from "./hosting-warning";
import { readReadiness } from "./session-control";

/** A stop requires the exact source launch, not an event from its presentation. */
export function createNativeHostingOutcomeReader(hc: HcClient): (ready: Readiness) => Promise<NativeHostingOutcome> {
  return async ready => {
    if (ready.origin !== "hub-operation") return "unknown";
    const address = ready.terminal.split("/");
    if (address.length > 2 || address.some(part => !part) || address.length === 2 && address[0] !== ready.core) return "unknown";
    try {
      const before = await hc.identity();
      if (before.coreId !== ready.core) return "unknown";
      const terminal = await hc.get(ready.terminal as TerminalAddress);
      const after = await hc.identity();
      if (after.coreId !== ready.core || terminal.address !== ready.terminal ||
          terminal.labels["spider.kind"] !== "session" || terminal.labels["spider.session"] !== ready.sessionId ||
          terminal.labels["spider.roam.epoch"] !== String(ready.epoch) || terminal.labels["spider.roam.operation"] !== ready.opId) return "unknown";
      if (terminal.state === "live") return "live";
      if (terminal.reason === "killed") return "killed";
      if (["server_stop", "host_shutdown", "holder_lost"].includes(terminal.reason ?? "")) return "core-loss";
      return terminal.reason ? "unexpected-exit" : "unknown";
    } catch { return "unknown"; }
  };
}

export interface HostingObservation { readiness: readonly Readiness[]; suspensions: readonly { sessionId: string; epoch: number }[]; warnings?: readonly SessionHostingWarning[] }
export async function observeHosting(ports: { db: Db; journal: Journal; authority: RunningIntentAuthority; intents: IntentStore;
  machineId: string; hubMachineId: string; sessionId?: string; live(ready: Readiness): Promise<boolean>;
  terminalOutcome(ready: Readiness): Promise<NativeHostingOutcome> }): Promise<HostingObservation> {
  const readiness: Readiness[] = [], suspensions: Array<{ sessionId: string; epoch: number }> = [];
  const meta = ports.db.prepare("SELECT machine_id FROM roam_meta WHERE id=1").get() as { machine_id: string } | undefined;
  if (meta?.machine_id !== ports.machineId) return { readiness, suspensions };
  const warnings = readHostingWarnings(ports.db).filter(row => ports.sessionId === undefined || row.sessionId === ports.sessionId);
  const ids = ports.sessionId === undefined
    ? new Set([...(await ports.authority.list()), ...localEntries<BoxLocalOrigin>(ports.db, "participant-origin").map(row => row.key)])
    : new Set([ports.sessionId]);
  for (const id of ids) {
    const operationId = ports.authority.operationId(id);
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
    const view = await ports.intents.get(id).catch(error => {
      if (!warnings.some(row => row.sessionId === id)) throw error;
      return undefined;
    });
    if (view === undefined) continue;
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
    if (await ports.live(ready)) { readiness.push(ready); continue; }
    const outcome = await ports.terminalOutcome(ready);
    if (ready.origin !== "hub-operation" || !operationId || outcome !== "killed") continue;
    // The intent lock excludes a successor launch reservation while the database compare-and-stop runs.
    const intentRoot = join(dirname(ports.db.raw.name), "roam", "intents");
    await withProcessLock(intentRoot, `intent:${id}`, async () => {
      const currentView = await ports.intents.get(id);
      if (currentView && (currentView.value.intent.epoch !== intent.epoch ||
          currentView.value.supervision.kind === "launching" && currentView.value.supervision.operationId !== ready.opId)) return;
      ports.db.raw.transaction(() => {
        const currentHome = ports.db.prepare("SELECT machine_id,epoch,move_id FROM session_homes WHERE session_id=?").get(id) as { machine_id: string; epoch: number; move_id: string | null } | undefined;
        const current = readLocal<{ intent: HostIntent; operationId: string; stopToken?: string }>(ports.db, "participant-intent", id);
        const currentReady = readLocal<unknown>(ports.db, "participant-ready", id);
        if (!currentHome || currentHome.machine_id !== ports.machineId || currentHome.epoch !== intent.epoch || currentHome.move_id !== intent.moveId ||
            !current || current.operationId !== operationId || JSON.stringify(current.intent) !== JSON.stringify(intent) ||
            !ports.authority.authorized(id, ports.hubMachineId, ports.machineId) || !currentReady ||
            JSON.stringify(parseReadiness(currentReady)) !== JSON.stringify(ready)) return;
        writeLocal(ports.db, "participant-intent", id, { ...current, intent: { ...current.intent, desired: "stopped" }, stopToken: randomUUID() });
      }).immediate();
    });
  }
  return { readiness, suspensions, ...(warnings.length ? { warnings } : {}) };
}

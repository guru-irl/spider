import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { storeScope } from "@spider/db-core/roam/codec";
import { localEntries } from "@spider/db-core/roam/local-state";
import { processStartIdentity } from "@spider/herdr/jobs/handoff";
import { listPendingIdLocks, localBootId } from "@spider/herdr/sessions/id-lock";
import { createSessionLeases, type ProcessProbe } from "@spider/herdr/sessions/lease";
import type { Diagnostic } from "./contracts";
import { openDiagnosticSnapshot } from "./diagnostic-snapshot";
import { inspectIntentReservations } from "./intent";
import { inspectAdoptedOwner } from "./launcher";
import { isMachineId } from "./machine-id";
import { readLocalIdentity } from "./runtime";

export type LegacyUpgradeInventory =
  | { status: "legacy-upgrade-ready"; findings: readonly [] }
  | { status: "legacy-upgrade-blocked"; findings: readonly string[] }
  | { status: "legacy-upgrade-unverified"; findings: readonly string[] };

function safeId(id: string): string { return id.replace(/[^A-Za-z0-9._:-]/g, "?").slice(0, 128); }
function present(file: string): boolean {
  try { lstatSync(file); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
async function pendingHandoffs(root: string) {
  if (present(join(root, "id-locks"))) return listPendingIdLocks(root);
  if (present(root)) {
    const stat = lstatSync(root);
    if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(root) !== root ||
        typeof process.getuid === "function" && stat.uid !== process.getuid() ||
        process.platform !== "win32" && (stat.mode & 0o022) !== 0) throw new Error("Unsafe Herdr directory");
  }
  return [];
}
async function probeProcess(pid: number): Promise<ProcessProbe> {
  try {
    const identity = processStartIdentity(pid);
    return identity === null ? { kind: "absent" } : { kind: "live", startIdentity: identity };
  } catch { return { kind: "unknown" }; }
}

/** Inspect local evidence without opening the source journal for writing. */
export async function inspectLegacyUpgrade(root: string): Promise<LegacyUpgradeInventory> {
  try {
    const findings: string[] = [], unknown: string[] = [];
    const journalKinds = new Map<string, string>();
    const configFile = join(root, "roam", "config.json"), identityFile = join(root, "roam", "machine.json");
    const configured = present(configFile), config = configured ? readLocalIdentity(root) : null;
    if (!configured && present(identityFile)) throw new Error("Missing roaming configuration");
    const db = openDiagnosticSnapshot(join(root, "roam", "journal.db"));
    if (db) try {
      const operations = db.prepare("SELECT operation_id,machine_id,kind,result_json FROM roam_operations WHERE kind IN ('move','move-session','move-abort-cleanup','exact-session-launch') ORDER BY operation_id")
        .all() as Array<{ operation_id: unknown; machine_id: unknown; kind: string; result_json: unknown }>;
      for (const operation of operations) {
        const id = operation.operation_id;
        if (typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id) || !isMachineId(operation.machine_id) ||
            !(operation.result_json === null || typeof operation.result_json === "string")) throw new Error("Invalid operation record");
        journalKinds.set(id, operation.kind);
        let result: Record<string, unknown> | null = null;
        if (typeof operation.result_json === "string") {
          const parsed: unknown = JSON.parse(operation.result_json);
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid operation result");
          result = parsed as Record<string, unknown>;
        }
        if (operation.kind === "move-session") {
          if (result !== null) throw new Error("Invalid move reservation result");
          let reserved: string | null = null;
          const actions = db.prepare("SELECT action,result_json FROM roam_operation_actions WHERE operation_id=? ORDER BY seq").all(id) as Array<{ action: string; result_json: string }>;
          for (const action of actions) {
            const value: unknown = JSON.parse(action.result_json);
            if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid move reservation");
            const record = value as Record<string, unknown>;
            if (action.action === "reserved" && reserved === null && typeof record.moveId === "string" &&
                /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(record.moveId) && isMachineId(record.destinationMachine)) reserved = record.moveId;
            else if (action.action === "released" && reserved !== null && record.moveId === reserved) reserved = null;
            else throw new Error("Invalid move reservation history");
          }
          if (reserved !== null) findings.push(`move reservation ${id} operation ${reserved}`);
        } else if (result === null) findings.push(`${operation.kind} operation ${id}`);
        else if (operation.kind === "move" && result.value && typeof result.value === "object" && !Array.isArray(result.value)) {
          const cleanup = (result.value as Record<string, unknown>).sourceCleanup;
          if (cleanup && typeof cleanup === "object" && !Array.isArray(cleanup) && (cleanup as Record<string, unknown>).status === "pending") findings.push(`source cleanup operation ${id}`);
        }
      }
      const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('freeze_journal','freeze_store_rosters')").all() as { name: string }[]).map(row => row.name));
      if (tables.has("freeze_journal") !== tables.has("freeze_store_rosters")) throw new Error("Incomplete freeze journal");
      if (tables.has("freeze_journal")) {
        const freezes = db.prepare("SELECT session_id,move_id,epoch,state FROM freeze_journal").all() as Array<{ session_id: unknown; move_id: unknown; epoch: unknown; state: unknown }>;
        const rosters = db.prepare("SELECT session_id,move_id,stores_json FROM freeze_store_rosters").all() as Array<{ session_id: unknown; move_id: unknown; stores_json: unknown }>;
        for (const roster of rosters) {
          if (!freezes.some(row => row.session_id === roster.session_id && row.move_id === roster.move_id) || typeof roster.stores_json !== "string") throw new Error("Orphan freeze roster");
          const stores: unknown = JSON.parse(roster.stores_json);
          if (!Array.isArray(stores) || !stores.length || new Set(stores).size !== stores.length) throw new Error("Invalid freeze roster");
          stores.forEach(storeScope);
        }
        for (const row of freezes) {
          if (typeof row.session_id !== "string" || !row.session_id || /[\u0000-\u001f\u007f]/.test(row.session_id) ||
              typeof row.move_id !== "string" || !row.move_id || /[\u0000-\u001f\u007f]/.test(row.move_id) ||
              !Number.isSafeInteger(row.epoch) || Number(row.epoch) < 1 || !["freezing", "frozen", "aborting", "aborted", "complete"].includes(String(row.state))) throw new Error("Invalid freeze record");
          if (row.state === "complete" || row.state === "aborted") continue;
          if (row.state !== "freezing" && !rosters.some(roster => roster.session_id === row.session_id && roster.move_id === row.move_id)) throw new Error("Missing freeze roster");
          findings.push(`freeze session ${row.session_id.replace(/[^A-Za-z0-9._:-]/g, "?").slice(0, 128)} operation ${row.move_id.replace(/[^A-Za-z0-9._:-]/g, "?").slice(0, 128)}`);
        }
      }
    } finally { db.close(); }
    const global = openDiagnosticSnapshot(join(root, "spider.db"));
    if (!global && config) throw new Error("Missing global store");
    if (global) try {
      const meta = global.prepare("SELECT machine_id,store_key FROM roam_meta WHERE id=1").get() as { machine_id?: unknown; store_key?: unknown } | undefined;
      if (!meta || config && meta.machine_id !== config.machineId || !(meta.store_key === null || meta.store_key === "global")) throw new Error("Global store identity mismatch");
      const homeActions = global.prepare("SELECT move_id,session_id,expected_epoch,args_digest FROM roam_home_actions WHERE committed_home_json IS NULL AND cancelled=0 ORDER BY move_id").all() as
        Array<{ move_id: unknown; session_id: unknown; expected_epoch: unknown; args_digest: unknown }>;
      for (const action of homeActions) {
        if (typeof action.move_id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(action.move_id) ||
            typeof action.session_id !== "string" || !action.session_id || !Number.isSafeInteger(action.expected_epoch) ||
            typeof action.args_digest !== "string" || !/^[0-9a-f]{64}$/.test(action.args_digest)) throw new Error("Invalid legacy home action");
        const label = `home action session ${safeId(action.session_id)} operation ${action.move_id}`;
        if (journalKinds.get(action.move_id) !== "move") unknown.push(`${label} journal missing`);
        else findings.push(label);
      }
      for (const row of localEntries<unknown>(global, "mapping-intent")) {
        if (!row.value || typeof row.value !== "object" || Array.isArray(row.value)) throw new Error("Invalid mapping intent");
        const map = row.value as Record<string, unknown>;
        if (typeof map.identity !== "string" || !map.identity || typeof map.store_key !== "string" ||
            typeof map.target_path !== "string" || !isAbsolute(map.target_path) || resolve(map.target_path) !== map.target_path ||
            row.key !== JSON.stringify([map.kind, map.identity]) || !(map.command_json === null || typeof map.command_json === "string")) throw new Error("Invalid mapping intent");
        if (map.kind === "repo") {
          if (map.store_key !== `repo:${map.identity}`) throw new Error("Invalid repository mapping");
        } else if (map.kind === "workspace") {
          const identity: unknown = JSON.parse(map.identity);
          if (!Array.isArray(identity) || identity.length !== 2 || identity.some(item => typeof item !== "string" || !item) ||
              map.store_key !== `worktree:${identity[0]}:${identity[1]}` || map.command_json !== null) throw new Error("Invalid workspace mapping");
        } else throw new Error("Invalid mapping kind");
        storeScope(map.store_key);
        findings.push(`map store ${safeId(map.store_key)}`);
      }
    } finally { global.close(); }
    const stateRoot = join(root, "herdr"), pending = await pendingHandoffs(stateRoot);
    for (const handoff of pending) findings.push(`handoff session ${safeId(handoff.sessionId)} operation ${safeId(handoff.operationId)}`);
    for (const reservation of await inspectIntentReservations(root)) {
      const label = `launch session ${safeId(reservation.sessionId)} operation ${safeId(reservation.operationId)}`;
      if (reservation.phase === "invoking") {
        const owner = await inspectAdoptedOwner({ root: stateRoot, sessionId: reservation.sessionId, operationId: reservation.operationId,
          file: reservation.file, leases: createSessionLeases(stateRoot), bootId: localBootId, probe: probeProcess });
        if ((owner.kind === "missing" || owner.kind === "unavailable") && !pending.some(row => row.sessionId === reservation.sessionId && row.operationId === reservation.operationId)) {
          unknown.push(`${label} owner unavailable`);
          continue;
        }
      }
      findings.push(label);
    }
    return unknown.length ? { status: "legacy-upgrade-unverified", findings: [...unknown, ...findings] }
      : findings.length ? { status: "legacy-upgrade-blocked", findings } : { status: "legacy-upgrade-ready", findings: [] };
  } catch {
    return { status: "legacy-upgrade-unverified", findings: ["local evidence unavailable"] };
  }
}

export function legacyUpgradeDiagnostic(inventory: LegacyUpgradeInventory): Diagnostic {
  const detail = inventory.findings.length ? ` ${inventory.findings.join(", ")}.` : " No unfinished legacy work was found.";
  return { severity: inventory.status === "legacy-upgrade-ready" ? "info" : "block",
    reason: `${inventory.status}:${detail} See docs/guide/roaming-upgrade.md.`, repairCommand: null };
}

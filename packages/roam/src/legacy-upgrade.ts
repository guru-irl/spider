import { createHash } from "node:crypto";
import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Db } from "@spider/db-core";
import { storeScope } from "@spider/db-core/roam/codec";
import { FENCE_MACHINE, FENCE_STREAM, FENCE_TARGET } from "@spider/db-core/roam/apply";
import { localEntries, readLocal } from "@spider/db-core/roam/local-state";
import { mappingRedirect, openRoamPathReadOnly, openRoamStoreReadOnly, roamStorePath, type RoamCatalog } from "@spider/db-core/roam/reads";
import { processStartIdentity } from "@spider/herdr/jobs/handoff";
import { inspectIdLock, listPendingIdLocks, localBootId } from "@spider/herdr/sessions/id-lock";
import { createSessionLeases, type ProcessProbe } from "@spider/herdr/sessions/lease";
import type { Diagnostic, WorkspaceSnapshot } from "./contracts";
import { openDiagnosticSnapshot } from "./diagnostic-snapshot";
import { snapshotPrivateRefs } from "./git-bundle";
import { inspectIntentViews } from "./intent";
import { inspectAdoptedOwner } from "./launcher";
import { isMachineId } from "./machine-id";
import { parseSourceCleanup } from "./move";
import { readLocalIdentity } from "./runtime";
import { parseCheckpoint, parseHome, parsePlacement, parsePlan } from "./relocate/journal";
import { listStoreKeys, type UngatheredStore } from "./store-inventory";
import { artifactId } from "./staging";
import type { RelocatePlan, SessionPlacement } from "./relocate/types";

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
function v0Home(value: unknown) {
  const parsed = parseHome(value);
  if (parsed.moveId !== null && (!parsed.moveId.startsWith("v0-") || !isMachineId(parsed.moveId.slice(3)))) throw new Error("Invalid v0 home move");
  return parsed;
}
function placementContainsCheckout(checkout: string, cwd: string): boolean {
  const child = relative(checkout, cwd);
  if (isAbsolute(child) || child === ".." || child.startsWith(`..${sep}`)) return false;
  if (!child) return true;
  for (let current = cwd; current !== checkout; current = dirname(current)) {
    if (present(join(current, ".git"))) return false;
  }
  return present(join(checkout, ".git"));
}
function workspacePreparation(data: Record<string, unknown>, id: string): { root: string; digest: string; stage: string; key: string } {
  if (typeof data.root !== "string" || !isAbsolute(data.root) || resolve(data.root) !== data.root ||
      typeof data.snapshotJson !== "string" || typeof data.digest !== "string" || !/^[a-f0-9]{64}$/.test(data.digest) ||
      !(data.previousJson === null || typeof data.previousJson === "string")) throw new Error("Invalid workspace preparation");
  const snapshot = JSON.parse(data.snapshotJson) as WorkspaceSnapshot;
  if (data.previousJson !== null) JSON.parse(data.previousJson);
  if (!snapshot || snapshot.moveId !== id || !snapshot.repoKey || !snapshot.workspaceId || snapshot.stage !== data.stage ||
      !snapshot.normalization || !(snapshot.normalization.autocrlf === null || typeof snapshot.normalization.autocrlf === "string") ||
      !(snapshot.normalization.eol === null || typeof snapshot.normalization.eol === "string") ||
      !(snapshot.sparsePatterns === null || typeof snapshot.sparsePatterns === "string") ||
      !(snapshot.worktreeConfig === null || typeof snapshot.worktreeConfig === "string") ||
      typeof snapshot.relativeCwd !== "string" || isAbsolute(snapshot.relativeCwd) || snapshot.relativeCwd.split(/[\\/]/).includes("..") ||
      !Array.isArray(snapshot.prerequisites) || snapshot.bundle?.kind !== "ready" || !Number.isSafeInteger(snapshot.bundle.byteLength) || snapshot.bundle.byteLength < 1)
    throw new Error("Invalid workspace snapshot");
  artifactId(snapshot.bundle.artifactId); snapshotPrivateRefs(snapshot);
  const oid = snapshot.objectFormat === "sha1" ? /^[a-f0-9]{40}$/ : snapshot.objectFormat === "sha256" ? /^[a-f0-9]{64}$/ : null;
  if (!oid || ![snapshot.head, snapshot.indexTree, snapshot.workingTree, ...snapshot.prerequisites].every(value => oid.test(value))) throw new Error("Invalid workspace object");
  const digest = createHash("sha256").update(JSON.stringify([snapshot.repoKey, snapshot.workspaceId, snapshot.moveId, snapshot.stage,
    snapshot.head, snapshot.branch, snapshot.objectFormat, snapshot.indexTree, snapshot.workingTree, snapshot.relativeCwd, snapshot.sparsePatterns,
    snapshot.worktreeConfig, { autocrlf: snapshot.normalization.autocrlf, eol: snapshot.normalization.eol },
    { enabled: snapshot.sparse.enabled, cone: snapshot.sparse.cone }, snapshot.refs, snapshot.prerequisites,
    { kind: "ready", artifactId: snapshot.bundle.artifactId, byteLength: snapshot.bundle.byteLength }])).digest("hex");
  if (digest !== data.digest) throw new Error("Workspace snapshot digest mismatch");
  const key = `worktree:${snapshot.repoKey}:${snapshot.workspaceId}`; storeScope(key);
  return { root: data.root, digest, stage: snapshot.stage, key };
}
async function probeProcess(pid: number): Promise<ProcessProbe> {
  try {
    const identity = processStartIdentity(pid);
    return identity === null ? { kind: "absent" } : { kind: "live", startIdentity: identity };
  } catch { return { kind: "unknown" }; }
}

async function readLegacyEvidence(root: string): Promise<{ inventory: LegacyUpgradeInventory; digest: string }> {
  const digest = createHash("sha256"), findings: string[] = [], unknown: string[] = [];
  // Record only the ordered projections used by this inventory, not file or WAL metadata.
  const record = <T>(value: T): T => {
    digest.update(JSON.stringify(value) ?? "undefined").update("\n");
    return value;
  };
  const readRows = <T>(db: Db, sql: string, ...args: unknown[]) => record(db.prepare(sql).all(...args) as T[]);
  const readRow = <T>(db: Db, sql: string, ...args: unknown[]) => record(db.prepare(sql).get(...args) as T | undefined);
  try {
    const snapshot = openDiagnosticSnapshot;
    const journalKinds = new Map<string, string>(), revokedMachines: string[] = [];
    const activeFreezes = new Set<string>(), completedFreezes = new Set<string>(), requiredStores = new Set<string>();
    const v0Maps = new Set<string>();
    const v0Owners = new Map<string, { placement: SessionPlacement; epoch: number }>();
    const v0: Array<{ origin: "checkpoint" | "incoming"; plan: RelocatePlan; expectedKey?: string }> = [];
    const configFile = join(root, "roam", "config.json"), identityFile = join(root, "roam", "machine.json");
    const configured = present(configFile), config = configured ? readLocalIdentity(root) : null;
    record(config?.machineId);
    if (!configured && present(identityFile)) unknown.push("roaming configuration unavailable");
    const db = snapshot(join(root, "roam", "journal.db"));
    record(!!db);
    if (db) try {
      const operations = readRows<{ operation_id: unknown; machine_id: unknown; kind: string; result_json: unknown }>(db,
        "SELECT operation_id,machine_id,kind,result_json FROM roam_operations WHERE kind IN ('move','move-session','move-abort-cleanup','exact-session-launch','forget-machine','restore-destroyed-home') ORDER BY operation_id");
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
          const actions = readRows<{ action: string; result_json: string }>(db, "SELECT action,result_json FROM roam_operation_actions WHERE operation_id=? ORDER BY seq", id);
          for (const action of actions) {
            const value: unknown = JSON.parse(action.result_json);
            if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid move reservation");
            const record = value as Record<string, unknown>;
            if (action.action === "reserved" && reserved === null && typeof record.moveId === "string" &&
                /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(record.moveId) && isMachineId(record.destinationMachine)) reserved = record.moveId;
            else if (action.action === "released" && reserved !== null && record.moveId === reserved) reserved = null;
            else throw new Error("Invalid move reservation history");
          }
          if (reserved !== null) {
            const label = `move reservation ${id} operation ${reserved}`;
            const linked = readRow<{ kind: unknown }>(db, "SELECT kind FROM roam_operations WHERE operation_id=?", reserved);
            if (linked?.kind !== "move") unknown.push(`${label} journal missing`);
            else findings.push(label);
          }
        } else if (result === null) {
          findings.push(`${operation.kind} operation ${id}`);
          if (operation.kind === "move-abort-cleanup") {
            try {
              const action = readRow<{ result_json: string }>(db, "SELECT result_json FROM roam_operation_actions WHERE operation_id=? AND action='abort-cleanup-request' ORDER BY seq LIMIT 1", id);
              if (!action) throw new Error("Missing abort cleanup request");
              const request: unknown = JSON.parse(action.result_json);
              if (!request || typeof request !== "object" || Array.isArray(request)) throw new Error("Invalid abort cleanup request");
              const record = request as Record<string, unknown>, check = record.check;
              if (typeof record.moveId !== "string" || !record.moveId || typeof record.sessionId !== "string" || !record.sessionId ||
                  !check || typeof check !== "object" || Array.isArray(check) || !Array.isArray((check as Record<string, unknown>).storeKeys)) throw new Error("Invalid abort cleanup request");
              const keys = (check as { storeKeys: unknown[] }).storeKeys;
              if (!keys.includes("global") || new Set(keys).size !== keys.length) throw new Error("Invalid abort cleanup stores");
              for (const key of keys) { storeScope(key); requiredStores.add(key as string); }
            } catch { unknown.push(`abort cleanup operation ${id} request unavailable`); }
          }
          if (operation.kind === "move") {
            const checks = readRows<{ action: string; result_json: string }>(db, "SELECT action,result_json FROM roam_operation_actions WHERE operation_id=? AND action IN ('move-action-complete','move-state') ORDER BY seq", id);
            for (const check of checks) {
              const data: unknown = JSON.parse(check.result_json);
              if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Invalid move evidence");
              const entry = data as Record<string, unknown>, value = check.action === "move-state" && entry.state === "checked" ? entry.check
                : check.action === "move-action-complete" && entry.action === "check" ? entry.value : null;
              if (value === null) continue;
              if (!value || typeof value !== "object" || Array.isArray(value) || !Array.isArray((value as Record<string, unknown>).storeKeys)) throw new Error("Invalid move store evidence");
              for (const key of (value as { storeKeys: unknown[] }).storeKeys) { storeScope(key); requiredStores.add(key as string); }
            }
            const pending = readRow<{ seq: number; result_json: string }>(db, "SELECT seq,result_json FROM roam_operation_actions WHERE operation_id=? AND action='move-source-cleanup-pending' ORDER BY seq DESC LIMIT 1", id);
            if (pending) try {
              const data: unknown = JSON.parse(pending.result_json);
              if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Invalid source cleanup");
              const record = data as Record<string, unknown>, cleanup = parseSourceCleanup(record.sourceCleanup);
              if (typeof record.sessionId !== "string" || !record.sessionId || !isMachineId(record.sourceMachine) || cleanup.status !== "pending") throw new Error("Invalid source cleanup");
              const later = readRows<{ result_json: string }>(db, "SELECT result_json FROM roam_operation_actions WHERE operation_id=? AND action='move-action-complete' AND seq>? ORDER BY seq", id, pending.seq);
              if (!later.some(row => (JSON.parse(row.result_json) as { action?: unknown }).action === "cleanup"))
                findings.push(`source cleanup session ${safeId(record.sessionId)} operation ${id}`);
            } catch { unknown.push(`source cleanup operation ${id} unavailable`); }
          }
        } else if (operation.kind === "move") {
          if (result.code === 0) {
            let label = `source cleanup operation ${id}`;
            try {
              if (!result.value || typeof result.value !== "object" || Array.isArray(result.value)) throw new Error("Missing move result");
              const value = result.value as Record<string, unknown>, home = value.home;
              if (home && typeof home === "object" && !Array.isArray(home) && typeof (home as Record<string, unknown>).sessionId === "string")
                label = `source cleanup session ${safeId((home as Record<string, unknown>).sessionId as string)} operation ${id}`;
              if (parseSourceCleanup(value.sourceCleanup).status === "pending") findings.push(label);
            } catch { unknown.push(`${label} unavailable`); }
          } else if (result.code !== 1 && result.code !== 2) unknown.push(`move operation ${id} terminal result invalid`);
        }
      }
      if (readRow(db, "SELECT 1 FROM sqlite_master WHERE type='table' AND name='roam_machine_revocations'")) {
        for (const { machine_id } of readRows<{ machine_id: unknown }>(db, "SELECT machine_id FROM roam_machine_revocations ORDER BY machine_id")) {
          if (!isMachineId(machine_id)) throw new Error("Invalid machine revocation");
          revokedMachines.push(machine_id);
        }
      }
      const preparations = new Map<string, { id: string; root: string; digest: string; key: string }>();
      const transitions = new Map<string, { id: string; root: string; digest: string; key: string }>();
      const workspaceActions = readRows<{ operation_id: string; action: string; result_json: string }>(db,
        "SELECT o.operation_id,a.action,a.result_json FROM roam_operations o JOIN roam_operation_actions a ON a.operation_id=o.operation_id WHERE o.kind<>'relocate-v0' AND a.action IN ('workspace-prepare-start','workspace-prepared','workspace-settings-transition','workspace-settings-transition-complete','workspace-settings-recovery-complete') ORDER BY a.seq");
      for (const action of workspaceActions) {
        const result: unknown = JSON.parse(action.result_json);
        if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("Invalid workspace action");
        const data = result as Record<string, unknown>, id = action.operation_id;
        if (action.action === "workspace-prepare-start" || action.action === "workspace-prepared") {
          const parsed = workspacePreparation(data, id), key = JSON.stringify([id, parsed.root, parsed.digest, parsed.stage]);
          if (action.action === "workspace-prepare-start") preparations.set(key, { id, ...parsed });
          else preparations.delete(key);
        } else {
          if (typeof data.root !== "string" || !isAbsolute(data.root) || resolve(data.root) !== data.root ||
              typeof data.transitionId !== "string" || !data.transitionId) throw new Error("Invalid workspace transition");
          const transitionKey = JSON.stringify([id, data.root, data.transitionId]);
          if (action.action === "workspace-settings-transition") {
            if (typeof data.digest !== "string") throw new Error("Invalid workspace transition digest");
            const start = [...preparations.values()].find(preparation => preparation.id === id && preparation.root === data.root && preparation.digest === data.digest);
            if (!start || transitions.has(transitionKey)) throw new Error("Missing workspace preparation");
            transitions.set(transitionKey, start);
          } else {
            const transition = transitions.get(transitionKey);
            if (!transition) throw new Error("Missing workspace transition");
            transitions.delete(transitionKey);
            if (action.action === "workspace-settings-recovery-complete") {
              if (data.digest !== transition.digest) throw new Error("Workspace recovery mismatch");
              for (const [key, preparation] of preparations) if (preparation === transition) preparations.delete(key);
            }
          }
        }
      }
      for (const preparation of new Set([...preparations.values(), ...transitions.values()]))
        findings.push(`workspace operation ${safeId(preparation.id)} store ${safeId(preparation.key)}`);
      const v0Actions = db.prepare("SELECT o.operation_id,a.action,a.result_json FROM roam_operations o JOIN roam_operation_actions a ON a.operation_id=o.operation_id WHERE o.kind='relocate-v0' AND o.result_json IS NULL AND a.action IN ('relocate-checkpoint','relocate-incoming') ORDER BY a.seq").all() as
        Array<{ operation_id: string; action: "relocate-checkpoint" | "relocate-incoming"; result_json: string }>;
      for (const action of v0Actions) {
        const result: unknown = JSON.parse(action.result_json);
        if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("Invalid v0 evidence");
        const data = result as Record<string, unknown>;
        const plan = action.action === "relocate-checkpoint" ? parseCheckpoint(data.checkpoint).plan : parsePlan(data.plan);
        if (plan.moveId !== action.operation_id || !isMachineId(plan.moveId.slice(3))) throw new Error("Mismatched v0 evidence");
        if (action.action === "relocate-incoming") {
          if (data.expectedKey !== `worktree:${plan.destinationPlacement.repoKey}:${plan.destinationPlacement.workspaceId}`) throw new Error("Mismatched incoming key");
          v0.push({ origin: "incoming", plan, expectedKey: data.expectedKey });
        } else v0.push({ origin: "checkpoint", plan });
      }
      const tables = new Set(readRows<{ name: string }>(db, "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('freeze_journal','freeze_store_rosters') ORDER BY name").map(row => row.name));
      const hasRosters = tables.has("freeze_store_rosters");
      if (tables.has("freeze_journal")) {
        const freezes = readRows<{ session_id: unknown; move_id: unknown; epoch: unknown; state: unknown }>(db, "SELECT session_id,move_id,epoch,state FROM freeze_journal ORDER BY session_id,move_id");
        const rosters = hasRosters ? readRows<{ session_id: unknown; move_id: unknown; stores_json: unknown }>(db,
          "SELECT session_id,move_id,stores_json FROM freeze_store_rosters ORDER BY session_id,move_id") : [];
        if (!hasRosters && !freezes.length) unknown.push("freeze roster table unavailable");
        for (const roster of rosters) {
          if (!freezes.some(row => row.session_id === roster.session_id && row.move_id === roster.move_id) || typeof roster.stores_json !== "string") throw new Error("Orphan freeze roster");
          const stores: unknown = JSON.parse(roster.stores_json);
          if (!Array.isArray(stores) || !stores.length || new Set(stores).size !== stores.length) throw new Error("Invalid freeze roster");
          const freeze = freezes.find(row => row.session_id === roster.session_id && row.move_id === roster.move_id)!;
          for (const key of stores) {
            storeScope(key);
            if (freeze.state !== "complete" && freeze.state !== "aborted") requiredStores.add(key as string);
          }
        }
        for (const row of freezes) {
          if (typeof row.session_id !== "string" || !row.session_id || /[\u0000-\u001f\u007f]/.test(row.session_id) ||
              typeof row.move_id !== "string" || !row.move_id || /[\u0000-\u001f\u007f]/.test(row.move_id) ||
              !Number.isSafeInteger(row.epoch) || Number(row.epoch) < 1 || !["freezing", "frozen", "aborting", "aborted", "complete"].includes(String(row.state))) throw new Error("Invalid freeze record");
          const label = `freeze session ${safeId(row.session_id)} operation ${safeId(row.move_id)}`;
          if (!hasRosters) unknown.push(`${label} roster table unavailable`);
          if (row.state === "complete") { completedFreezes.add(JSON.stringify([row.session_id, row.move_id])); continue; }
          if (row.state === "aborted") continue;
          activeFreezes.add(JSON.stringify([row.session_id, row.move_id]));
          if (hasRosters) {
            if (row.state !== "freezing" && !rosters.some(roster => roster.session_id === row.session_id && roster.move_id === row.move_id))
              unknown.push(`${label} roster unavailable`);
            else findings.push(label);
          }
        }
      } else if (hasRosters) unknown.push("freeze journal table unavailable");
    } finally { db.close(); }
    const global = snapshot(join(root, "spider.db"));
    record(!!global);
    if (!global && config) throw new Error("Missing global store");
    if (global) try {
      type StoreIdentity = { machine_id: unknown; store_key: unknown };
      type HomeRow = { session_id: string; machine_id: string; epoch: number; move_id: string | null; updated_at: number; state: string | null; destination: string | null };
      const homeFor = (sessionId: string) => global.prepare("SELECT session_id,machine_id,epoch,move_id,updated_at,state,destination FROM session_homes WHERE session_id=?").get(sessionId) as HomeRow | undefined;
      const meta = readRow<StoreIdentity>(global, "SELECT machine_id,store_key FROM roam_meta WHERE id=1");
      if (!meta || !isMachineId(meta.machine_id) || config && meta.machine_id !== config.machineId || !(meta.store_key === null || meta.store_key === "global")) throw new Error("Global store identity mismatch");
      if (!configured && global.prepare("SELECT 1 FROM session_homes UNION ALL SELECT 1 FROM roam_locations UNION ALL SELECT 1 FROM roam_repo_maps UNION ALL SELECT 1 FROM roam_workspace_maps LIMIT 1").get())
        unknown.push("roaming identity unavailable");
      if (revokedMachines.length) {
        // The legacy hub commits revocation before opening the recovery operation.
        // v0 shares the revocation table but does not restore v0-owned homes.
        const hasState = readRow(global, "SELECT 1 FROM pragma_table_info('session_homes') WHERE name='state'");
        for (const machineId of revokedMachines) {
          const homes = readRows<{ session_id: unknown }>(global,
            `SELECT session_id FROM session_homes WHERE machine_id=?${hasState ? " AND state IS NULL" : ""} ORDER BY session_id`, machineId);
          for (const { session_id } of homes) {
            if (typeof session_id !== "string" || !session_id) throw new Error("Invalid revoked machine home");
            findings.push(`revoked machine ${machineId} has unrestored legacy session ${safeId(session_id)}`);
          }
        }
      }
      for (const row of localEntries<unknown>(global, "relocate-managed")) {
        const placement = parsePlacement(row.value);
        if (row.key !== placement.sessionId) throw new Error("Invalid v0 managed placement");
        if (!config || placement.machineId !== config.machineId) continue;
        const home = homeFor(row.key);
        if (!home || home.state === null) continue;
        const parsed = v0Home({ sessionId: home.session_id, machineId: home.machine_id, epoch: home.epoch, moveId: home.move_id,
          updatedAt: home.updated_at, state: home.state, destination: home.destination });
        if (parsed.state === "running" && parsed.machineId === config.machineId) v0Owners.set(row.key, { placement, epoch: parsed.epoch });
      }
      const homeActions = readRows<{ move_id: unknown; session_id: unknown; expected_epoch: unknown; args_digest: unknown; cancelled: unknown; committed_home_json: unknown }>(global,
        "SELECT move_id,session_id,expected_epoch,args_digest,cancelled,committed_home_json FROM roam_home_actions ORDER BY move_id");
      for (const action of homeActions) {
        if (typeof action.move_id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(action.move_id) ||
            typeof action.session_id !== "string" || !action.session_id) throw new Error("Invalid legacy home action");
        const label = `home action session ${safeId(action.session_id)} operation ${action.move_id}`;
        if (action.cancelled !== 0 && action.cancelled !== 1) { unknown.push(`${label} state invalid`); continue; }
        if (!Number.isSafeInteger(action.expected_epoch) || Number(action.expected_epoch) < 1 || typeof action.args_digest !== "string" || !/^[0-9a-f]{64}$/.test(action.args_digest)) {
          unknown.push(`${label} record invalid`); continue;
        }
        if (action.committed_home_json !== null) {
          try {
            if (typeof action.committed_home_json !== "string") throw new Error("Invalid committed home");
            const committed: unknown = JSON.parse(action.committed_home_json);
            if (!committed || typeof committed !== "object" || Array.isArray(committed) || action.cancelled !== 0) throw new Error("Invalid committed home");
            const home = committed as Record<string, unknown>;
            if (home.sessionId !== action.session_id || home.moveId !== action.move_id || !isMachineId(home.machineId) ||
                !Number.isSafeInteger(home.epoch) || home.epoch !== Number(action.expected_epoch) + 1 || !Number.isSafeInteger(home.updatedAt) || Number(home.updatedAt) < 0)
              throw new Error("Invalid committed home");
          } catch { unknown.push(`${label} receipt invalid`); }
          continue;
        }
        if (action.cancelled === 1) continue;
        if (journalKinds.get(action.move_id) !== "move") unknown.push(`${label} journal missing`);
        else findings.push(label);
      }
      for (const row of record(localEntries<unknown>(global, "mapping-intent"))) {
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
        const ownedByV0 = map.kind === "workspace" && config && v0.some(evidence => {
          const { plan } = evidence, placement = evidence.origin === "checkpoint" ? plan.sourcePlacement : plan.destinationPlacement;
          if (placement.machineId !== config.machineId || map.store_key !== `worktree:${placement.repoKey}:${placement.workspaceId}` ||
              !placementContainsCheckout(map.target_path as string, placement.cwd)) return false;
          if (evidence.origin === "incoming") {
            const pointer = record(readLocal<unknown>(global, "relocate-incoming", evidence.expectedKey!));
            if (!pointer || typeof pointer !== "object" || Array.isArray(pointer) || (pointer as Record<string, unknown>).moveId !== plan.moveId) return false;
            const home = record(homeFor(plan.source.sessionId));
            if (!home || home.state === null && home.destination === null) return true;
            const parsed = v0Home({ sessionId: home.session_id, machineId: home.machine_id, epoch: home.epoch, moveId: home.move_id,
              updatedAt: home.updated_at, state: home.state, destination: home.destination });
            return parsed.epoch < plan.source.epoch || parsed.state === "moving" && parsed.moveId === plan.moveId &&
              parsed.machineId === plan.source.machineId && parsed.destination === config.machineId && parsed.epoch === plan.source.epoch + 1 ||
              parsed.state !== "moving" && parsed.machineId === plan.source.machineId && parsed.epoch <= plan.source.epoch;
          }
          const home = record(homeFor(plan.source.sessionId));
          return !!home && home.state === "moving" && home.machine_id === plan.source.machineId && home.destination === plan.destinationPlacement.machineId &&
            home.epoch === plan.source.epoch + 1 && home.move_id === plan.moveId;
        });
        if (record(!!ownedByV0)) v0Maps.add(map.store_key);
        else findings.push(`map store ${safeId(map.store_key)}`);
      }
      type FrozenRow = { session_id: string; epoch: number; move_id: string | null; freeze_seq: number | null };
      const frozenRows: Array<{ key: string; row: FrozenRow }> = [];
      const inspectFrozen = (store: Db, key: string): void => {
        const identity = store.prepare("SELECT machine_id,store_key FROM roam_meta WHERE id=1").get() as { machine_id?: unknown; store_key?: unknown } | undefined;
        if (!identity || identity.machine_id !== meta.machine_id || !(identity.store_key === key || identity.store_key === null)) throw new Error("Store identity mismatch");
        const rows = store.prepare("SELECT session_id,epoch,move_id,freeze_seq FROM roam_sessions WHERE state='frozen' ORDER BY session_id").all() as
          Array<{ session_id: unknown; epoch: unknown; move_id: unknown; freeze_seq: unknown }>;
        for (const row of rows) {
          if (typeof row.session_id !== "string" || !row.session_id || !Number.isSafeInteger(row.epoch) ||
              !(row.move_id === null || typeof row.move_id === "string") || !(row.freeze_seq === null || Number.isSafeInteger(row.freeze_seq))) throw new Error("Invalid frozen membership");
          frozenRows.push({ key, row: row as FrozenRow });
        }
      };
      const inspectedWorktrees = new Set<string>(), ungathered: UngatheredStore[] = [];
      const storeOptions = { globalPath: join(root, "spider.db"), open: snapshot,
        onUngathered: (entry: UngatheredStore) => { ungathered.push(entry); } };
      for (const redirect of localEntries<unknown>(global, "mapping-redirect")) {
        const scope = storeScope(redirect.key);
        if (scope === "global" || typeof redirect.value !== "string" || !isAbsolute(redirect.value) || resolve(redirect.value) !== redirect.value)
          throw new Error("Invalid mapping redirect");
        const at = redirect.key.lastIndexOf(":"), mapped = scope === "worktree"
          ? global.prepare("SELECT 1 FROM roam_workspace_maps WHERE repo_key=? AND workspace_id=?").get(redirect.key.slice(9, at), redirect.key.slice(at + 1))
          : global.prepare("SELECT 1 FROM roam_repo_maps WHERE repo_key=?").get(redirect.key.slice(5));
        if (!mapped || requiredStores.has(redirect.key) && !present(redirect.value)) unknown.push(`map redirect store ${safeId(redirect.key)} unavailable`);
      }
      const projects = readRows<{ project_key: string; db_path: string; git_common_dir: string | null }>(global,
        "SELECT project_key,db_path,git_common_dir FROM projects ORDER BY project_key");
      for (const project of projects) if (typeof project.project_key !== "string" || typeof project.db_path !== "string" ||
          !isAbsolute(project.db_path) || resolve(project.db_path) !== project.db_path ||
          !(project.git_common_dir === null || typeof project.git_common_dir === "string" && isAbsolute(project.git_common_dir) && resolve(project.git_common_dir) === project.git_common_dir))
        throw new Error("Invalid project registration");
      const prefix = "spider-local:mapping-redirect:";
      const catalog: RoamCatalog = {
        globalPath: join(root, "spider.db"), machine: meta.machine_id, projects,
        repos: readRows<RoamCatalog["repos"][number]>(global, "SELECT repo_key,path FROM roam_repo_maps ORDER BY repo_key"),
        worktrees: readRows<RoamCatalog["worktrees"][number]>(global, "SELECT repo_key,workspace_id,path FROM roam_workspace_maps ORDER BY repo_key,workspace_id"),
        redirects: readRows<RoamCatalog["redirects"][number]>(global, "SELECT peer_stream FROM roam_cursors WHERE peer_machine='' AND substr(peer_stream,1,?)=? ORDER BY peer_stream", prefix.length, prefix),
      };
      const replicaDir = join(root, "roam", "stores");
      let replicaNames: string[] = [];
      if (present(replicaDir)) {
        const stat = lstatSync(replicaDir);
        if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(replicaDir) !== replicaDir) throw new Error("Unsafe replica directory");
        replicaNames = readdirSync(replicaDir).filter(name => /^[a-f0-9]{64}\.db$/.test(name)).sort();
      }
      for (const name of record(replicaNames)) {
        const replica = openRoamPathReadOnly(join(replicaDir, name), snapshot);
        if (!replica) { unknown.push("replica unavailable"); continue; }
        try {
          const identity = readRow<StoreIdentity>(replica, "SELECT machine_id,store_key FROM roam_meta WHERE id=1");
          const key = typeof identity?.store_key === "string" ? identity.store_key : "unknown";
          let valid = false;
          try { storeScope(key); valid = true; } catch { /* The recorded identifier is not trustworthy. */ }
          if (!valid || Number(replica.pragma("user_version")) !== 14 || identity?.machine_id !== meta.machine_id ||
              name !== `${createHash("sha256").update(key).digest("hex")}.db`) unknown.push(`replica store ${safeId(key)} identity mismatch`);
        } finally { replica.close(); }
      }
      const keys = listStoreKeys(catalog, storeOptions);
      for (const key of requiredStores) if (!keys.includes(key as (typeof keys)[number])) unknown.push(`required store ${safeId(key)} unavailable`);
      for (const entry of ungathered) {
        if (entry.scope === "replica") unknown.push("replica unavailable");
        else if (entry.key && requiredStores.has(entry.key)) unknown.push(`required store ${safeId(entry.key)} unavailable`);
      }
      for (const key of keys) {
        if (key !== "global") {
          const file = join(root, "roam", "stores", `${createHash("sha256").update(key).digest("hex")}.db`);
          if (present(file)) {
            const replica = openRoamPathReadOnly(file, snapshot);
            if (!replica) throw new Error("Missing replica");
            try {
              const identity = readRow<StoreIdentity>(replica, "SELECT machine_id,store_key FROM roam_meta WHERE id=1");
              if (!identity || identity.machine_id !== meta.machine_id || identity.store_key !== key) throw new Error("Replica identity mismatch");
              const fence = readRow(replica, "SELECT 1 FROM roam_cursors WHERE peer_machine=? AND peer_stream=?", FENCE_MACHINE, FENCE_STREAM);
              const hint = record(readLocal<unknown>(replica, FENCE_TARGET, key));
              if (hint !== undefined) {
                if (!hint || typeof hint !== "object" || Array.isArray(hint)) throw new Error("Invalid replica fence target");
                const target = hint as Record<string, unknown>;
                if (typeof target.file !== "string" || !isAbsolute(target.file) || typeof target.device !== "string" ||
                    typeof target.inode !== "string" || typeof target.clearOnCancel !== "boolean") throw new Error("Invalid replica fence target");
              }
              if (fence || hint !== undefined) {
                const at = key.lastIndexOf(":"), published = mappingRedirect(catalog, key) !== null || (key.startsWith("worktree:")
                  ? catalog.worktrees.some(row => row.repo_key === key.slice(9, at) && row.workspace_id === key.slice(at + 1))
                  : catalog.repos.some(row => row.repo_key === key.slice(5)));
                if (!published && !v0Maps.has(key)) findings.push(`map fence store ${safeId(key)}`);
              }
              if (key.startsWith("worktree:")) { inspectFrozen(replica, key); inspectedWorktrees.add(file); }
            } finally { replica.close(); }
          }
        }
        if (!key.startsWith("worktree:")) continue;
        const file = roamStorePath(catalog, key, storeOptions);
        if (inspectedWorktrees.has(file) || !present(file)) continue;
        let store: Db | undefined, inspectingFrozen = false;
        try {
          store = openRoamStoreReadOnly(catalog, key, storeOptions);
          if (!store) { if (requiredStores.has(key)) unknown.push(`required store ${safeId(key)} unavailable`); continue; }
          inspectingFrozen = true; inspectFrozen(store, key); inspectedWorktrees.add(file);
        } catch { if (inspectingFrozen || requiredStores.has(key)) unknown.push(`store ${safeId(key)} evidence unavailable`); }
        finally { store?.close(); }
      }
      for (const project of projects) {
        if (inspectedWorktrees.has(project.db_path)) continue;
        let store: Db | undefined, inspectingFrozen = false;
        try {
          store = openRoamPathReadOnly(project.db_path, snapshot);
          if (!store) continue;
          const identity = store.prepare("SELECT machine_id,store_key FROM roam_meta WHERE id=1").get() as { machine_id?: unknown; store_key?: unknown } | undefined;
          if (!identity || identity.machine_id !== meta.machine_id || Number(store.pragma("user_version")) !== 14) continue;
          if (typeof identity.store_key === "string" && storeScope(identity.store_key) === "worktree") {
            inspectingFrozen = true; inspectFrozen(store, identity.store_key);
          } else if (identity.store_key === null) {
            inspectingFrozen = true;
            const frozen = store.prepare("SELECT session_id FROM roam_sessions WHERE state='frozen' ORDER BY session_id").all() as Array<{ session_id: unknown }>;
            for (const row of frozen) unknown.push(`frozen session ${typeof row.session_id === "string" ? safeId(row.session_id) : "unknown"} project ${safeId(project.project_key)} store identity unavailable`);
          }
          inspectedWorktrees.add(project.db_path);
        } catch { if (inspectingFrozen) unknown.push(`project ${safeId(project.project_key)} frozen evidence unavailable`); }
        finally { store?.close(); }
      }
      for (const { key, row } of record(frozenRows)) {
        const label = `frozen session ${safeId(row.session_id)} store ${safeId(key)}`;
        if (row.move_id && activeFreezes.has(JSON.stringify([row.session_id, row.move_id]))) { findings.push(label); continue; }
        if (row.move_id !== null || row.freeze_seq !== null) {
          if (row.move_id === null || row.freeze_seq === null || !completedFreezes.has(JSON.stringify([row.session_id, row.move_id]))) {
            unknown.push(`${label} freeze record unavailable`); continue;
          }
        }
        const home = record(homeFor(row.session_id));
        if ((!home || home.state === null) && config && v0.some(evidence => {
          const plan = evidence.plan;
          if (evidence.origin !== "incoming" || evidence.expectedKey !== key || plan.source.sessionId !== row.session_id ||
              plan.destinationPlacement.machineId !== config.machineId || ![plan.source.epoch, plan.source.epoch + 1].includes(row.epoch)) return false;
          const pointer = record(readLocal<unknown>(global, "relocate-incoming", key));
          return !!pointer && typeof pointer === "object" && !Array.isArray(pointer) && (pointer as Record<string, unknown>).moveId === plan.moveId;
        })) continue;
        if (home && home.state !== null) {
          const parsed = v0Home({ sessionId: home.session_id, machineId: home.machine_id, epoch: home.epoch, moveId: home.move_id,
            updatedAt: home.updated_at, state: home.state, destination: home.destination });
          if (parsed.state !== "moving" || v0.some(evidence => evidence.plan.moveId === parsed.moveId && evidence.plan.source.sessionId === row.session_id)) continue;
        }
        unknown.push(`${label} freeze record unavailable`);
      }
    } finally { global.close(); }
    const stateRoot = join(root, "herdr"), pending = record(await pendingHandoffs(stateRoot));
    for (const handoff of pending) {
      const label = `handoff session ${safeId(handoff.sessionId)} operation ${safeId(handoff.operationId)}`;
      const lock = record(await inspectIdLock(stateRoot, handoff.sessionId)), boot = await localBootId();
      if (!lock || lock.pendingOperationId !== handoff.operationId || !boot) { unknown.push(`${label} owner unavailable`); continue; }
      if (lock.bootId === boot && record(await probeProcess(lock.identity.pid)).kind === "unknown") { unknown.push(`${label} owner unavailable`); continue; }
      findings.push(label);
    }
    const intentViews = record(await inspectIntentViews(root));
    for (const state of intentViews) {
      if (state.supervision.kind === "launching") continue;
      const label = `live hosting session ${safeId(state.intent.sessionId)}`;
      const lock = record(await inspectIdLock(stateRoot, state.intent.sessionId));
      if (state.supervision.kind === "idle" && !lock) continue;
      const identity = state.supervision.kind === "live" ? state.supervision.identity
        : { bootId: lock!.bootId, pid: lock!.identity.pid, startTime: lock!.identity.startIdentity };
      const boot = await localBootId();
      if (!boot) { unknown.push(`${label} boot identity unavailable`); continue; }
      if (boot !== identity.bootId) continue;
      const observed = record(await probeProcess(identity.pid));
      if (observed.kind === "unknown") { unknown.push(`${label} owner unavailable`); continue; }
      if (observed.kind === "absent" || observed.startIdentity !== identity.startTime) continue;
      const lease = await createSessionLeases(stateRoot).get(state.intent.file);
      record(lease && [lease.bootId, lease.pid, lease.startIdentity]);
      if (!lock || lock.bootId !== boot || lock.identity.pid !== identity.pid || lock.identity.startIdentity !== identity.startTime ||
          !lease || lease.bootId !== boot || lease.pid !== identity.pid || lease.startIdentity !== identity.startTime) {
        unknown.push(`${label} lock or lease unavailable`); continue;
      }
      const managed = record(v0Owners.get(state.intent.sessionId));
      if (state.supervision.kind === "idle" && managed && managed.epoch >= state.intent.epoch &&
          managed.placement.file === state.intent.file && managed.placement.cwd === state.intent.cwd &&
          (!lock.operationId || journalKinds.get(lock.operationId) !== "exact-session-launch")) continue;
      findings.push(label);
    }
    for (const { intent, supervision } of intentViews) {
      if (supervision.kind !== "launching") continue;
      const label = `launch session ${safeId(intent.sessionId)} operation ${safeId(supervision.operationId)}`;
      if (supervision.phase === "invoking") {
        const owner = record(await inspectAdoptedOwner({ root: stateRoot, sessionId: intent.sessionId, operationId: supervision.operationId,
          file: intent.file, leases: createSessionLeases(stateRoot), bootId: localBootId, probe: probeProcess }));
        if (owner.kind === "unavailable" || owner.kind === "missing" && !pending.some(row => row.sessionId === intent.sessionId && row.operationId === supervision.operationId)) {
          unknown.push(`${label} owner unavailable`);
          continue;
        }
      }
      findings.push(label);
    }
    if (!configured && (db || present(join(root, "roam", "intents")) || present(join(root, "roam", "stores")) || findings.length || unknown.length))
      unknown.unshift("roaming identity unavailable");
  } catch { unknown.unshift("local evidence unavailable"); }
  const inventory: LegacyUpgradeInventory = unknown.length ? { status: "legacy-upgrade-unverified", findings: [...unknown, ...findings] }
    : findings.length ? { status: "legacy-upgrade-blocked", findings } : { status: "legacy-upgrade-ready", findings: [] };
  record(inventory);
  return { inventory, digest: digest.digest("hex") };
}

/** Inspect local evidence using private snapshots, without opening source databases with SQLite. */
export async function inspectLegacyUpgrade(root: string): Promise<LegacyUpgradeInventory> {
  const first = await readLegacyEvidence(root), second = await readLegacyEvidence(root);
  if (first.digest === second.digest) return second.inventory;
  const findings = [...new Set([...first.inventory.findings, ...second.inventory.findings])];
  return { status: "legacy-upgrade-unverified", findings: ["local evidence changed during inspection", ...findings] };
}

export function legacyUpgradeDiagnostic(inventory: LegacyUpgradeInventory): Diagnostic {
  const detail = inventory.findings.length ? ` ${inventory.findings.join(", ")}.` : " No unfinished legacy work was found.";
  return { severity: inventory.status === "legacy-upgrade-ready" ? "info" : "block",
    reason: `${inventory.status}:${detail} See the roaming upgrade guide in the spider repository at docs/guide/roaming-upgrade.md.`, repairCommand: null };
}

import { pendingWorkspaceTransitions } from "@spider/roam/move-recovery";
import { recordMoveBindings } from "@spider/roam/move-diagnostics";
import { cancelPendingHandoff, readMoveLaunchAbsenceReceipt, type MoveLaunchAbsenceReceipt } from "@spider/roam/pending-handoff";
import { createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { openDb, type Db } from "@spider/db-core";
import { readLocal, writeLocal } from "@spider/db-core/roam/local-state";
import { parseHubReadiness } from "@spider/db-core/roam/readiness";
import type { Blocker, Home, HubOperationReadiness, JsonObject, Probe, StoreKey } from "@spider/db-core/roam/types";
import type { Clock, Diagnostic, GitPorts, Operation, RoamConfig, Transport, WorkspaceSnapshot } from "@spider/roam/contracts";
import { createMovePorts, createHubMoveEvidencePorts, createPushedMoveEvidencePorts, createMoveWorkspacePorts, handleMoveParticipantOperation, recoverMoveAdapters, unboundMoveEffects, moveEffectReason, readMovePresentation, type MoveAdapterBindings } from "@spider/roam/move-ports";
import { openFreezeJournal, type FreezeJournal } from "@spider/roam/journal";
import { machineMoveProxy } from "@spider/roam/machine-move-socket";
import { createBothLocks, createRunningIntentAuthority, readReadiness, recordReadiness, type HeldSessionLocks } from "@spider/roam/session-control";
import { requestSessionControl } from "@spider/roam/session-socket";
import { createStorePort } from "@spider/roam/stores";
import { listStoreKeys } from "@spider/roam/store-inventory";
import { createSync } from "@spider/roam/sync";
import { sessionHome } from "@spider/roam/homes";
import { loadHerdrConfig } from "@spider/roam/host-config";
import { createProductionRecoveryPorts } from "@spider/roam/recovery-transport";
import { readLocalIdentity } from "@spider/roam/runtime";
import { createBoxParticipantWake } from "@spider/roam/participant-runtime";
import { participantLaunchId } from "@spider/roam/participant-launch";
import { createProcessInventory } from "../herdr/process-inventory";
import { inspectIdLock, inspectReleasedIdLock, localBootId } from "@spider/herdr/sessions/id-lock";
import { processStartTime } from "../../../subagents/src/process-identity";
import { createTerminalRegistry } from "@spider/herdr/sessions/registry";
import { createHcClient } from "@spider/herdr/client/hc";
import { createHostRoamPresentationPorts } from "./readiness";
import { createDormantControl } from "./control";
import { createBlockerPorts } from "./evidence";
import { createUsageIngestThrough } from "./usage-ingest";

import { createExactLaunchAdapter, createProductionLocalExactHc, createLaunchReconciler, resolveParticipantPi } from "@spider/roam/launcher";
import { inspectSession } from "@spider/roam/session-file";
import { verifyWorkspace } from "@spider/roam/workspace-import";
import { createMoveControlHandler } from "@spider/roam/adapter-controls";
import { recordMoveLaunchAbsence } from "./launch-observation";
import { readOwnedLaunchReadiness } from "./move-readiness";
import { observeHubRestoration } from "@spider/roam/hub-restoration";

function moveLaunchFailureReason(receipt: MoveLaunchAbsenceReceipt): string {
  switch (receipt.kind) {
    case "never-started": return `proved-no-start:${receipt.launchId}`;
    case "exited-without-adoption": return `proved-unadopted-exit:${receipt.launchId}:${receipt.terminalId}`;
    default: { const unsupported: never = receipt; throw new Error(`Unknown launch absence receipt: ${unsupported}`); }
  }
}

export function moveBindingDiagnostics(bindings: MoveAdapterBindings): Diagnostic[] {
  return unboundMoveEffects(bindings).map(effect => ({ reason: moveEffectReason(effect), severity: "block", repairCommand: "spider roam doctor" }));
}
export interface HostMoveInput {
  root: string; globalDb: Db; config: RoamConfig; journal: FreezeJournal; sessionId: string; transport: Transport;
  sync?: NonNullable<MoveAdapterBindings["sync"]>; operation?: Operation;
}
function gitRun(cwd: string, argv: readonly string[], options?: { env?: Readonly<NodeJS.ProcessEnv>; stdin?: Buffer }): Promise<Buffer> {
  return new Promise((done, reject) => {
    const child = execFile(argv[0], [...argv.slice(1)], { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...options?.env }, encoding: "buffer", timeout: 60_000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(Object.assign(new Error("git-command-failed"), { status: typeof error.code === "number" ? error.code : -1, stdout, stderr }));
      else done(stdout);
    });
    child.stdin?.end(options?.stdin);
  });
}
export interface HostMoveRuntime {
  bindings: MoveAdapterBindings;
  ports: import("@spider/roam/contracts").MovePorts;
  control: import("@spider/roam/move-control").MoveControlHandler;
  recover(): Promise<readonly import("@spider/roam/contracts").MoveSessionOutcome[]>;
  dispatch(operation: Operation): Promise<import("@spider/roam/contracts").Outcome<JsonObject>>;
  close(): Promise<void>;
}
export async function createHostMoveBindings(input: HostMoveInput): Promise<HostMoveRuntime> {
  const { root, globalDb, config, journal, sessionId, transport } = input;
  const pi = resolveParticipantPi();
  const privateDb = openDb(join(root, "roam", "journal.db"), { fileMustExist: true, checkpointOnClose: false });
  const presentations = createHostRoamPresentationPorts({ root, globalDb, revocationDb: privateDb, config });
  const stores = createStorePort(config, globalDb, { allowUnassignedGlobal: true });
  const keys = listStoreKeys(globalDb);
  const known = globalDb.prepare("SELECT stores_json FROM roam_locations WHERE session_id=?").get(sessionId) as { stores_json: string } | undefined;
  const checkKeys = (input.operation?.args.check as { storeKeys?: unknown } | undefined)?.storeKeys;
  const requiredKeys: unknown = Array.isArray(checkKeys) ? checkKeys : Array.isArray(input.operation?.args.keys) ? input.operation!.args.keys : known ? JSON.parse(known.stores_json) : keys;
  if (!Array.isArray(requiredKeys) || requiredKeys.some(key => typeof key !== "string" || !keys.includes(key as StoreKey))) throw new Error("participant-stores-unavailable");
  const roster = keys.filter(key => requiredKeys.includes(key)).map(key => ({ key, db: stores.openStore(key).db }));
  const clock: Clock = { now: () => Date.now(), later(ms, fn) { const timer = setTimeout(fn, ms); timer.unref(); return () => clearTimeout(timer); } };
  const sync = input.sync ?? createSync({ config, globalDb, journal, transport, clock, stores });
  const inventory = createProcessInventory(join(root, "herdr"));
  const machine = machineMoveProxy(root), broker = { inspectFreezeBlockers: machine.broker };
  const runtimeRoot = join(root, "roam", "s");
  const location = (id: string) => globalDb.prepare("SELECT file,cwd,stores_json FROM roam_locations WHERE session_id=?").get(id) as { file: string; cwd: string; stores_json: string } | undefined;
  const target = async (id: string): Promise<string> => {
    const existing = location(id);
    if (existing?.file && existing.cwd) return existing.file;
    const workspace = (globalDb.prepare("SELECT path FROM roam_workspace_maps ORDER BY repo_key,workspace_id").all() as { path: string }[]);
    if (workspace.length !== 1) throw new Error("participant-location-unavailable");
    const herdr = loadHerdrConfig(root), directory = join(herdr.agentDirectory, "sessions", `--${workspace[0].path.replace(/^\//, "").replace(/\//g, "-")}--`);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    return join(directory, `${id}.jsonl`);
  };
  const claimBothLocks = createBothLocks({ root: join(root, "herdr"), inventory, file: target,
    identity: { pid: process.pid, startIdentity: processStartTime(process.pid) ?? "unavailable" }, bootId: localBootId });
  const heldClaims = new AsyncLocalStorage<{ sessionId: string; locks: HeldSessionLocks }>();
  const withBothLocks: typeof claimBothLocks = (id, effect) => claimBothLocks(id, async locks => {
    if (!locks) throw new Error("session-lock-evidence-unavailable");
    return heldClaims.run({ sessionId: id, locks }, () => effect(locks));
  });
  const probe = async (id: string): Promise<Probe> => {
    const lock = await inspectIdLock(join(root, "herdr"), id), held = heldClaims.getStore();
    const ownClaim = held?.sessionId === id;
    if (ownClaim && !await held.locks.owns()) return { kind: "uncertain" };
    if (!lock || ownClaim) {
      const records = await inventory.presence.list();
      for (const record of records.filter(record => record.sessionId === id)) if ((await inventory.probe(record.pid)).kind !== "absent") return { kind: "uncertain" };
      const unknown = await inventory.processes();
      if (unknown.some(row => !records.some(record => record.pid === row.pid))) return { kind: "uncertain" };
      return { kind: "absent" };
    }
    if (lock.pendingOperationId) return { kind: "uncertain" };
    const observed = await inventory.probe(lock.identity.pid), bootId = await localBootId();
    if (lock.bootId !== bootId || observed.kind === "absent") return { kind: "absent" };
    if (observed.kind !== "live" || observed.startIdentity !== lock.identity.startIdentity) return { kind: "uncertain" };
    return { kind: "live", identity: { bootId, pid: lock.identity.pid, startTime: observed.startIdentity } };
  };
  const scratch = join(root, "roam", "git");
  const git: Omit<GitPorts, "journal" | "limits"> = { run: (cwd, argv, options) => gitRun(cwd, argv[0] === "git" ? argv : ["git", ...argv], options), scratch, worktreeCommand: null };
  const authority = createRunningIntentAuthority(globalDb);
  const localHome = (id: string): Home | null => { const home = sessionHome(globalDb, id); return home === "unknown" ? null : home; };
  const readiness = (query: import("@spider/roam/move-ports").ParticipantReadinessQuery): Promise<HubOperationReadiness | null> =>
    readOwnedLaunchReadiness({ db: globalDb, journal, machineId: config.machineId,
      lock: id => inspectIdLock(join(root, "herdr"), id), probe }, query);
  const operationReadiness = async (id: string, operationId: string): Promise<HubOperationReadiness | null> => {
    const launch = journal.read(operationId).filter(row => row.action === "participant-launch").at(-1)?.result as unknown as import("@spider/roam/move-ports").ParticipantReadinessQuery | undefined;
    if (!launch || launch.sessionId !== id) return null;
    const ready = await readiness(launch); return ready ? { ...ready, opId: operationId } : null;
  };

  const auth = async (): Promise<readonly Diagnostic[]> => {
    try {
      const herdr = loadHerdrConfig(root), bytes = readFileSync(join(herdr.agentDirectory, "auth.json"));
      try { const value: unknown = JSON.parse(bytes.toString("utf8")); if (!value || typeof value !== "object" || !Object.keys(value).length) throw new Error("pi-auth-missing"); }
      finally { bytes.fill(0); }
      return [{ reason: "tool-auth-unverified", severity: "warning", repairCommand: null }];
    } catch { return [{ reason: "pi-auth-missing", severity: "block", repairCommand: null }]; }
  };
  const identityCurrent = async () => JSON.stringify(readLocalIdentity(root)) === JSON.stringify(config);
  const boxWake = config.role === "box" ? createBoxParticipantWake({ root, db: globalDb, config }) : null;
  const wake = async (request: import("@spider/roam/move-ports").ParticipantLaunchRequest): Promise<import("@spider/roam/move-ports").ParticipantLaunchResult> => {
    if (!pi) return { ok: false, reason: "participant-pi-unavailable" };
    if (boxWake) return boxWake(request);
    const { sessionId, operationId: participantOperationId } = request;
    const intent = await authority.get(sessionId), home = localHome(sessionId);
    if (!intent || authority.operationId(sessionId) !== participantOperationId || intent.desired !== "running" || intent.suspended || !home || home.machineId !== config.machineId || home.epoch !== intent.epoch)
      return { ok: false, reason: "participant-intent-unavailable" };
    const base = participantLaunchId(config.machineId, sessionId, intent.epoch, participantOperationId);
    const operationId = request.launchId ?? base;
    if (operationId !== base) {
      const history = journal.lookupOperation?.(`${base}-restarts`), entries = journal.read(`${base}-restarts`).filter(row => row.action === "restart");
      if (!history || history.machineId !== config.machineId ||
          entries.some((row, index) => row.result.sequence !== index + 1) || !entries.some(row => operationId === `${base}-restart-${row.result.sequence}`))
        return { ok: false, reason: "participant-launch-unavailable" };
      try { journal.begin({ id: `${base}-restarts`, kind: "participant-restarts", machineId: config.machineId, expectedEpoch: intent.epoch,
        args: { sessionId, operationId: participantOperationId, file: intent.file, cwd: intent.cwd, moveId: intent.moveId } }); }
      catch { return { ok: false, reason: "participant-launch-unavailable" }; }
    }
    if (journal.lookupOperation?.(operationId)) return { ok: true, launchId: operationId };
    const herdr = loadHerdrConfig(root), hc = createProductionLocalExactHc({ binary: herdr.core.binary, env: process.env, probe: inventory.probe });
    try {
      const coreClient = createHcClient({ binary: herdr.core.binary, env: process.env });
      const core = await coreClient.identity(); await coreClient.dispose();
      const bytes = readFileSync(intent.file);
      const adapter = createExactLaunchAdapter({ journal, hc, clock: { now: clock.now, wait: (ms, signal) => new Promise((done, reject) => { const timer = setTimeout(done, ms); signal.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("aborted")); }, { once: true }); }) },
        base: { leases: inventory.leases, processInventory: inventory, processIdentity: { pid: process.pid, startIdentity: processStartTime(process.pid) ?? "unavailable" },
          env: { ...process.env, SPIDER_GLOBAL_ROOT: root, PI_CODING_AGENT_DIR: herdr.agentDirectory, HC_SESSION: core.sessionNamespace, HC_SOCKET: core.socket }, machineId: config.machineId,
          core: { coreId: core.coreId, session: core.sessionNamespace, socket: core.socket }, bootId: localBootId, shell: "/bin/sh", sessionBytes: config.limits.sessionBytes,
          async limits() { const value = (await gitRun(root, ["/bin/sh", "-c", "ulimit -Sn; ulimit -Hn"])).toString().trim().split("\n"); return { soft: Number(value[0]), hard: value[1] === "unlimited" ? Infinity : Number(value[1]) }; } } });
      await adapter.launch({ sessionId, file: intent.file, cwd: intent.cwd, epoch: intent.epoch, moveId: intent.moveId, pi,
        sha256: createHash("sha256").update(bytes).digest("hex"), operationId }, { mode: journal.lookupOperation?.(operationId) ? "reconcile" : "fresh" });
      return { ok: true, launchId: operationId };
    } catch {
      return journal.lookupOperation?.(operationId) ? { ok: true, launchId: operationId } : { ok: false, reason: "participant-launch-unavailable" };
    } finally { await hc.dispose(); }
  };
  const address = { sessionId, scopeId: null };
  const evidenceCall = async <T>(kind: string, operation: Operation): Promise<T | null> => {
    const observed = kind === "move-workspace-map" || kind === "move-owner-observation" || kind === "move-ready-target";
    const targetMachine = observed ? String(operation.args.destinationMachine) : config.hubMachineId;
    const hub = config.peers.find(peer => peer.machineId === targetMachine);
    if (!hub) throw new Error("hub-authority-unavailable");
    const request = { ...operation, machineId: targetMachine, kind, args: { ...operation.args, sourceMachine: config.hubMachineId, requesterMachine: config.machineId, ...(observed ? {} : { authorityOperation: operation as unknown as JsonObject }) } };
    const bytes = await transport.exec(await transport.resolve(hub), ["roam", "agent", JSON.stringify(request)], { timeoutMs: config.limits.controlMs, maxBytes: config.limits.replyBytes });
    const reply = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (reply.operationId !== request.id || reply.code !== 0) throw new Error("hub-authority-unavailable");
    return reply.value as T | null;
  };
  const bindings: MoveAdapterBindings = {
    root, globalDb, privateDb, clock,
    power: { pid: process.pid, onExit: listener => { process.once("exit", listener); return () => process.off("exit", listener); }, notice: text => process.stderr.write(`${text}\n`),
      spawn: async argv => {
        const child = spawn(argv[0], [...argv.slice(1)], { stdio: "ignore" });
        await new Promise<void>((done, reject) => { child.once("spawn", done); child.once("error", () => reject(new Error("move-power-unavailable"))); });
        const exited = new Promise<void>(done => child.once("exit", () => done()));
        return { exited, async stop() { if (child.exitCode === null) child.kill("SIGTERM"); await exited; } };
      } },
    stores: { open: key => stores.openStore(key).db, head: key => {
      const db = stores.openStore(key).db, meta = db.prepare("SELECT stream_id FROM roam_meta WHERE id=1").get() as { stream_id: string };
      return { storeKey: key, stream: meta.stream_id, through: (db.prepare("SELECT coalesce(max(seq),0) AS seq FROM roam_changes").get() as { seq: number }).seq };
    } }, sync,
    async mapping(request, loc) {
      const sourceMachine = localHome(sessionId)?.machineId ?? config.machineId;
      const mapped = globalDb.prepare("SELECT repo_key,workspace_id,path FROM roam_workspace_maps").all() as { repo_key: string; workspace_id: string; path: string }[];
      const source = mapped.filter(row => loc.stores.includes(`worktree:${row.repo_key}:${row.workspace_id}` as StoreKey) && (sourceMachine !== config.machineId || !relative(row.path, loc.cwd).startsWith("..")));
      if (source.length !== 1) return null;
      const row = source[0];
      const rootFor = (machineId: string) => machineId === config.machineId ? Promise.resolve(row.path) : evidenceCall<string>("move-workspace-map", { ...request.operation, args: { sessionId, moveId: request.operation.id, repoKey: row.repo_key, workspaceId: row.workspace_id, destinationMachine: machineId } });
      const sourceRoot = await rootFor(sourceMachine);
      if (!sourceRoot || !isAbsolute(sourceRoot) || relative(sourceRoot, loc.cwd).startsWith("..")) return null;
      const destination = await rootFor(request.destinationMachine);
      if (!destination || !isAbsolute(destination)) return null;
      return { repoKey: row.repo_key, workspaceId: row.workspace_id, sourceRoot, destinationRoot: destination, destinationCwd: join(destination, relative(sourceRoot, loc.cwd)) };
    },
    participant: { pi, config, root, globalDb, runtimeRoot, stores: roster, withBothLocks, probe, git,
      exit: { async exited(identity) {
        const bootId = await localBootId();
        if (!bootId || !identity.bootId) return false;
        if (bootId !== identity.bootId) return true;
        const current = await inventory.probe(identity.pid);
        return current.kind === "absent" || current.kind === "live" && current.startIdentity !== identity.startTime;
      } },
      async writers(workspace) {
        const records = await inventory.presence.list(), result: Blocker[] = [];
        const terminals = await createTerminalRegistry(join(root, "herdr")).list();
        for (const record of records) {
          const owner = terminals.find(terminal => terminal.owner.sessionId === record.sessionId)?.owner;
          if (record.sessionId !== sessionId && (!owner || !relative(workspace, owner.cwd).startsWith("..")) && (await inventory.probe(record.pid)).kind !== "absent") result.push({ kind: "workspace-writer", id: String(record.pid), detail: "Another workspace writer is active." });
        }
        return result;
      }, sessionTarget: target, auth, identityCurrent, wake, readiness,
      async observation(home, operation) {
        const participantId = `${home.moveId}-session-start-${config.machineId}`;
        const ready = await operationReadiness(home.sessionId, operation.id) ?? (home.moveId ? await operationReadiness(home.sessionId, participantId) : null);
        const state = readLocal<{ epoch: number; moveId: string; retired: boolean; activationCancelled: boolean; launchFailure: string | null }>(globalDb, "move-retirement", home.sessionId);
        let owner = await probe(home.sessionId), launchFailure: string | null = null;
        const lock = await inspectIdLock(join(root, "herdr"), home.sessionId), intent = await authority.get(home.sessionId);
        const exactId = lock?.pendingOperationId;
        if (!ready && exactId && lock.pendingCoreId && home.moveId && intent?.epoch === home.epoch && intent.moveId === home.moveId) {
          const herdr = loadHerdrConfig(root), hc = createProductionLocalExactHc({ binary: herdr.core.binary, env: process.env, probe: inventory.probe });
          try {
            const signal = AbortSignal.timeout(config.limits.controlMs), coreId = await hc.coreId(signal), bootId = await localBootId();
            const reconcile = createLaunchReconciler({ journal, inspectLock: () => inspectIdLock(join(root, "herdr"), home.sessionId), coreId: hc.coreId, bootId: () => localBootId(), terminals: hc.terminals,
              clock: { now: clock.now, wait: (ms, signal) => new Promise((done, reject) => { const timer = setTimeout(done, ms); signal.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("aborted")); }, { once: true }); }) } });
            const receipt = await recordMoveLaunchAbsence({ journal, operationId: home.moveId, launchId: exactId, sessionId: home.sessionId, epoch: home.epoch, coreId, bootId,
              intent, ownership: async () => {
                const owner = await inspectIdLock(join(root, "herdr"), home.sessionId);
                return owner?.operationId === exactId ? owner : inspectReleasedIdLock(join(root, "herdr"), home.sessionId, exactId);
              },
              readiness: () => readiness({ sessionId: home.sessionId, launchId: exactId, epoch: home.epoch }), evidence: () => reconcile(exactId, { signal }) });
            if (receipt) { owner = { kind: "absent" }; launchFailure = moveLaunchFailureReason(receipt); }
          } catch { /* Missing exact proof leaves ownership and launch outcome unknown. */ }
        }
        if (launchFailure && exactId && home.moveId) {
          const receipt = readMoveLaunchAbsenceReceipt(journal, home.moveId, exactId);
          if (!receipt || await cancelPendingHandoff(root, { sessionId: home.sessionId, moveId: home.moveId, launchId: exactId, absenceReceipt: receipt }) === "refused") {
            owner = { kind: "uncertain" }; launchFailure = null;
          }
        }
        const held = heldClaims.getStore();
        const ownClaim = held?.sessionId === home.sessionId && await held.locks.owns();
        if (!launchFailure && (!lock || ownClaim) && home.moveId) {
          const receipt = readMoveLaunchAbsenceReceipt(journal, home.moveId);
          if (receipt && receipt.sessionId === home.sessionId && receipt.epoch === home.epoch && receipt.moveId === home.moveId &&
              await cancelPendingHandoff(root, { sessionId: home.sessionId, moveId: home.moveId, launchId: receipt.launchId, absenceReceipt: receipt }) === "already-released" && (await probe(home.sessionId)).kind === "absent") {
            owner = { kind: "absent" }; launchFailure = moveLaunchFailureReason(receipt);
          }
        }
        const retired = !!state?.retired && state.epoch === home.epoch && state.moveId === home.moveId && !!launchFailure;
        return { home: localHome(home.sessionId) ?? home, owner, readiness: ready, launchFailure, retired, activationCancelled: retired && state!.activationCancelled };
      },
      dormant(context) {
        return createDormantControl({ ...context, blockerPorts: createBlockerPorts({ sessionId: context.sessionId, address: context.intercom.address,
          activity: { busy: () => false, bashRunning: () => false, promptOpen: () => false },
          routeStores: [globalDb], jobRoots: [join(root, "jobs")], scratchRoots: [join(root, "scratch")], broker: context.evidence.broker.inspectFreezeBlockers.bind(context.evidence.broker),
          bridge: context.evidence.bridge, settlement: context.evidence.settlement }), ingestThrough: createUsageIngestThrough({ registryDb: globalDb.raw.name, ledgerFile: join(root, "usage.db"), sessionsDir: join(loadHerdrConfig(root).agentDirectory, "sessions"), authPath: join(loadHerdrConfig(root).agentDirectory, "auth.json"), leaseDir: join(root, "usage-leases") }, context.sessionId, config.machineId) });
      },
      async retireFailed(home, operation) {
        const observed = await bindings.participant!.observation(home, operation);
        if (!observed.launchFailure || observed.owner.kind !== "absent" || observed.readiness || !home.moveId) throw new Error("move-rollback-proof-missing");
        await authority.stop(home.sessionId);
        for (const { key, db } of roster.filter(row => row.key.startsWith("worktree:"))) db.raw.transaction(() => {
          const state = db.prepare("SELECT epoch,state FROM roam_sessions WHERE session_id=?").get(home.sessionId) as { epoch: number; state: string } | undefined;
          if (!state || state.epoch !== home.epoch) throw new Error("move-rollback-proof-missing");
          db.prepare("UPDATE roam_sessions SET state='retired',move_id=? WHERE session_id=? AND epoch=?").run(home.moveId, home.sessionId, home.epoch);
        }).immediate();
        writeLocal(globalDb, "move-retirement", home.sessionId, { retired: true, activationCancelled: true, launchFailure: observed.launchFailure, operationId: operation.id, epoch: home.epoch, moveId: home.moveId });
        return { kind: "absent" };
      },
      async readmitLive(home, operation, file) {
        const reply = await requestSessionControl(runtimeRoot, { ...operation, kind: "session-readmit", args: { ...operation.args, file } });
        return reply.code === 0 ? parseHubReadiness(reply.value) : null;
      },
      async cleanupTerminal(operation, locks) {
        if (!await locks?.owns()) throw new Error("source-cleanup-lock-changed");
        if ((operation.args.presentation as JsonObject | undefined)?.status !== "complete") throw new Error("destination-presentation-pending");
        const registry = createTerminalRegistry(join(root, "herdr")), herdr = loadHerdrConfig(root), hc = createHcClient({ binary: herdr.core.binary, env: process.env });
        try {
          for (const record of (await registry.list()).filter(row => row.owner.sessionId === sessionId)) {
            if (record.owner.terminal.coreId !== (await hc.identity()).coreId || record.owner.terminal.address.includes("/")) continue;
            if (!await locks?.owns()) throw new Error("source-cleanup-lock-changed");
            await hc.rm(record.owner.terminal.address);
            try { await hc.get(record.owner.terminal.address); throw new Error("terminal-removal-pending"); }
            catch (error) { if (!error || typeof error !== "object" || !("code" in error) || error.code !== "not_found") throw error; }
            await registry.remove(record.owner.terminal, true);
          }
        } finally { await hc.dispose(); }
      },
    },
    evidence: { bridge: machine.bridge, settlement: machine.settlement, broker,
      onHubRestored: listener => observeHubRestoration(root, listener, () => { try { return readLocalIdentity(root).enabled; } catch { return false; } }),
      ...createPushedMoveEvidencePorts(globalDb, config) },
    intercom: { address, ports: machine.intake, destinationEndpoint: home => machine.endpoint({ ...address, sessionId: home.sessionId }),
      rollback: { currentFence: async (id, moveId) => journal.readIntercomFence(id, moveId), reopen: machine.releaseRollbackFence } },
    handoff: {
      async prepareHandoff({ source, operation, placementRoot }) {
        if (placementRoot !== join(root, "roam", "placement")) return { capture: "refused", reason: "presentation-root-changed" };
        const presentation = await presentations.prepareHandoff(source);
        if (presentation.status === "refused") return { capture: "refused", reason: presentation.reason };
        const kind = presentation.status === "complete" ? "service" : !presentation.presentation && presentation.reason === "source-view-unavailable" ? "nothing-to-capture" : "app-absent";
        journal.record(operation.id, "host-handoff-captured", { kind, presentationStatus: presentation.status });
        return { capture: "durable", presentation };
      },
      async readyTarget(home) {
        if (home.machineId !== config.machineId) return evidenceCall<import("@spider/roam/contracts").PaneTarget>("move-ready-target", {
          id: `target-${createHash("sha256").update(JSON.stringify(home)).digest("hex").slice(0, 40)}`, machineId: home.machineId, expectedEpoch: home.epoch, kind: "move-ready-target",
          args: { sessionId: home.sessionId, moveId: home.moveId, destinationMachine: home.machineId } });
        const ready = await operationReadiness(home.sessionId, `${home.moveId}-session-start-${home.machineId}`) ?? await operationReadiness(home.sessionId, String(home.moveId));
        return ready ? { machineId: home.machineId, alias: null, sessionId: home.sessionId, homeEpoch: home.epoch, coreId: ready.core, terminalId: ready.terminal } : null;
      },
      presentReadyTarget: target => presentations.presentReadyTarget(target),
    },
    recovery: { ...createProductionRecoveryPorts({ root, config, globalDb, journal, transport }), mirrorRoot: join(root, "roam", "mirrors"),
      async restoreWorkspace(home, mirror) {
        const loc = location(home.sessionId); if (!loc?.cwd || !isAbsolute(loc.cwd)) return null;
        const maps = globalDb.prepare("SELECT repo_key,workspace_id,path,snapshot_json FROM roam_workspace_maps").all() as { repo_key: string; workspace_id: string; path: string; snapshot_json: string | null }[];
        const candidates = maps.filter(row => loc.cwd === row.path || loc.cwd.startsWith(`${row.path}/`));
        if (candidates.length !== 1 || !candidates[0].snapshot_json) return null;
        const row = candidates[0], snapshot = JSON.parse(row.snapshot_json!) as WorkspaceSnapshot;
        if (snapshot.repoKey !== row.repo_key || snapshot.workspaceId !== row.workspace_id || snapshot.root !== row.path) return null;
        try {
          await verifyWorkspace({ root: row.path, moveId: snapshot.moveId, previous: null, adjustments: [], snapshot },
            createMoveWorkspacePorts(globalDb, { ...git, journal, limits: config.limits }, join(root, "roam", "staging"), []));
          await inspectSession(mirror.file, home.sessionId, mirror.leaf, config.limits);
          return { cwd: loc.cwd, parent: null };
        } catch { return null; }
      },
      async conflicts(id) {
        const origins = new Set<string>();
        for (const { key, db } of roster) if (key.startsWith("worktree:")) for (const row of db.prepare("SELECT origin_machine FROM sessions WHERE id=?").all(id) as { origin_machine: string }[]) if (row.origin_machine) origins.add(row.origin_machine);
        return Promise.all([...origins].map(async machineId => ({ machineId, owner: machineId === config.machineId ? await probe(id) : await evidenceCall<Probe>("move-owner-observation", { id: `observe-${id}`, kind: "move-owner-observation", machineId, expectedEpoch: null, args: { sessionId: id, moveId: `observe-${id}`, destinationMachine: machineId } }) ?? { kind: "uncertain" } as Probe })));
      },
      async workspaceRestores() {
        return pendingWorkspaceTransitions(privateDb, journal, sessionId).map(row => {
          const value = row.value, snapshot = JSON.parse(String(value.snapshotJson)) as WorkspaceSnapshot;
          return { snapshot, destination: value.root as string, repository: value.common as string,
            ports: createMoveWorkspacePorts(globalDb, { ...git, journal, limits: config.limits }, join(root, "roam", "staging"), []),
            withBothLocks: <T>(effect: () => Promise<T>) => withBothLocks(sessionId, effect) };
        });
      },
    },
  };
  const ports = createMovePorts(config, transport, journal, bindings);
  if (config.role === "hub") bindings.evidence = createHubMoveEvidencePorts(ports, bindings.evidence!);
  const installOnly = !config.enabled && input.operation?.kind === "restore-destroyed-home";
  const diagnostics = moveBindingDiagnostics(bindings).filter(row => !installOnly || !["participant-pi-unavailable", "adapter-unbound:start", "adapter-unbound:readmitSource"].includes(row.reason));
  recordMoveBindings(globalDb, bindings);
  if (diagnostics.length) { privateDb.close(); stores.close(); throw new Error(diagnostics[0].reason); }
  return { bindings, ports, async recover() { return recoverMoveAdapters(ports, bindings); },
    async dispatch(operation) {
      const result = (value: unknown): import("@spider/roam/contracts").Outcome<JsonObject> => ({ code: value === null ? 3 : 0, reason: value === null ? "move-evidence-missing" : "complete", operationId: operation.id, home: localHome(sessionId), epoch: operation.expectedEpoch, repairCommand: value === null ? `spider roam recover ${operation.args.moveId}` : null, value: value as JsonObject | null });
      if (operation.kind === "move-owner-observation") return result(await probe(sessionId));
      if (operation.kind === "move-ready-target") {
        const home = localHome(sessionId);
        if (!home || home.machineId !== config.machineId || home.epoch !== operation.expectedEpoch || home.moveId !== operation.args.moveId) return result(null);
        return result(await bindings.handoff!.readyTarget(home));
      }
      if (operation.kind === "move-workspace-map") {
        const rows = globalDb.prepare("SELECT path FROM roam_workspace_maps WHERE repo_key=? AND workspace_id=?").all(operation.args.repoKey, operation.args.workspaceId) as { path: string }[];
        return result(rows.length === 1 && isAbsolute(rows[0].path) ? rows[0].path : null);
      }
      if (["move-abort-authority", "move-retire-authority", "move-rollback-authority", "move-presentation-authority"].includes(operation.kind)) {
        if (config.role !== "hub") return result(null);
        const original = operation.args.authorityOperation as unknown as Operation;
        if (!original || original.id !== operation.id || original.args.sessionId !== sessionId || original.args.moveId !== operation.args.moveId || original.machineId !== operation.args.requesterMachine || original.expectedEpoch !== operation.expectedEpoch) return result(null);
        const value = operation.kind === "move-presentation-authority" ? readMovePresentation(journal, original) : operation.kind === "move-abort-authority" ? await bindings.evidence!.authorizeAbort!(original) : operation.kind === "move-retire-authority" ? await bindings.evidence!.authorizeRetire!(original) : await bindings.evidence!.rollback!(original);
        return result(value);
      }
      return handleMoveParticipantOperation(operation, journal, bindings);
    },
    control: createMoveControlHandler({ config, globalDb, journal, transport, ports }),
    async close() { await presentations.dispose(); if (!input.sync) { const adapter = sync as ReturnType<typeof createSync>; adapter.stop(); await adapter.drain(); } stores.close(); privateDb.close(); } };
}

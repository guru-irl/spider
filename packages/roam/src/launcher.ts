import { randomUUID } from "node:crypto";
import { accessSync, constants, statSync } from "node:fs";
import { lstat } from "node:fs/promises";
import { delimiter, isAbsolute, resolve } from "node:path";
import { HerdrError, object, text as replyText } from "@spider/herdr/client/parse";
import { createHcClient, invokeCli as invokeHcCli, observeCoreIdentity } from "@spider/herdr/client/hc";
import { invokeCli as invokeTransport } from "@spider/herdr/client/cli-transport";
import { requireCoreAvailable } from "@spider/herdr/client/liveness";
import type { ProcessProbe } from "@spider/herdr/sessions/lease";
import { bootIdChanged, cancelExitedIdLockHandoff, inspectIdLock, inspectReleasedIdLock } from "@spider/herdr/sessions/id-lock";
import { canonicalSessionFile, withProcessLock } from "@spider/herdr/sessions/registry";
import { launchHandoffPath, removeLaunchHandoff } from "@spider/herdr/sessions/launch-handoff";
import type { SessionId } from "@spider/herdr";
import { launchExactSession, provedNoStart } from "@spider/herdr/sessions/launcher";
import { launchNotStarted } from "@spider/herdr/roam-placement";
import type { IdLockObservation } from "@spider/herdr/sessions/id-lock";
import type { ExactSessionLaunchPorts, ExactSessionLaunchRequest, LaunchEvidence, PiSpawnRequest, SessionLaunchResult } from "@spider/herdr/sessions/launcher";
import type { Journal } from "./contracts";

export interface LaunchReconcilePorts {
  journal: Journal;
  inspectLock(): Promise<IdLockObservation | null>;
  coreId(signal: AbortSignal): Promise<string>;
  bootId(signal: AbortSignal): Promise<string>;
  /** Only stop opts into ended-started evidence; ordinary launch reconciliation still refuses it. */
  settlement?: { sessionId: string; probe(pid: number): Promise<ProcessProbe>; leases: Pick<ExactSessionLaunchPorts["leases"], "get"> };
  terminals(operationId: string, options: { signal: AbortSignal; includeFinished: true; attemptId?: string; terminalId?: string; anyLaunchLabel?: { sessionId: string; attemptId: string } }): Promise<{
    complete: boolean; terminals: readonly { id: string; state: "live" | "finished" }[];
  }>;
  clock: { now(): number; wait(ms: number, signal: AbortSignal): Promise<void> };
}
const CONFIRMATION_BOUND_MS = 250;
const unknown = (): LaunchEvidence => ({ receipt: "unknown", terminal: "unknown" });
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f/]/.test(value);
const time = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** Retain only evidence supplied by the actual local hc invocation. */
export function createLaunchTracker(input: { journal: Journal; machineId: string; coreId: string; bootId: string; sessionId?: string }) {
  const { journal, machineId, coreId, bootId, sessionId } = input;
  if (!text(coreId) || !text(bootId)) throw new Error("Launch identity is unavailable");
  return {
    begin(operationId: string, epoch: number, attempt?: { attemptId: string; resume: boolean }): boolean {
      const begun = journal.begin({ id: operationId, machineId, expectedEpoch: epoch, kind: "exact-session-launch", args: sessionId === undefined ? {} : { sessionId } });
      if (begun.kind !== "new" && !(attempt?.resume && begun.kind === "pending")) return false;
      if (attempt) {
        if (!text(attempt.attemptId)) throw new Error("Launch attempt identity is unavailable");
        journal.record(operationId, "exact-attempt", { attemptId: attempt.attemptId });
      }
      journal.record(operationId, "exact-core", { coreId }); return true;
    },
    failed(operationId: string, error: unknown): boolean {
      if (!(error instanceof HerdrError) || !launchNotStarted(error)) return false;
      if (error.code === "core-unavailable" || error.code === "core-mismatch") {
        journal.record(operationId, "exact-prelaunch-error", { errorCode: error.code }); return true;
      }
      if (error.code === "missing-hc" || error.code === "spawn-error") {
        journal.record(operationId, "exact-prelaunch-error", { errorCode: error.code, hcPid: null }); return true;
      }
      return false;
    },
    started(operationId: string, pid: number, startTime: string): void {
      if (!Number.isSafeInteger(pid) || pid <= 0 || !text(startTime)) throw new Error("Launch process identity is unavailable");
      journal.record(operationId, "exact-hc-started", { pid, startTime, bootId });
    },
    exited(operationId: string, pid: number, exitedAt: number): void {
      if (!Number.isSafeInteger(pid) || pid <= 0 || !time(exitedAt)) throw new Error("Launch process exit is unavailable");
      journal.record(operationId, "exact-hc-exited", { pid, exitedAt });
    },
    replied(operationId: string, terminalId: string): void {
      if (!text(terminalId)) throw new Error("Launch terminal identity is unavailable");
      journal.record(operationId, "exact-terminal", { terminalId });
    },
  };
}

export interface LocalExactHc {
  coreId(signal: AbortSignal): Promise<string>;
  terminals: LaunchReconcilePorts["terminals"];
  run(request: PiSpawnRequest, observer: { started(pid: number, startTime: string): void; exited(pid: number): void }): Promise<{ terminal: string }>;
}

function parseCompactLaunchTerminal(value: unknown, terminalId: string | undefined): { id: string; state: "live" | "finished" } {
  const row = object(value);
  if (!text(terminalId) || row.address !== terminalId) {
    throw new HerdrError("invalid-reply", "Terminal list does not match the recorded launch address");
  }
  if (row.state === "live") return { id: terminalId, state: "live" };
  if (row.state !== "finished" || row.reason !== "exited" || !Number.isSafeInteger(row.exit_code)) {
    throw new HerdrError("invalid-reply", "Terminal exit is uncertain");
  }
  return { id: terminalId, state: "finished" };
}

/** This adapter never supplies a remote target or forwards secrets in argv. */
export function createLocalExactHc(input: {
  coreId(signal: AbortSignal): Promise<string>;
  invoke(argv: readonly string[], signal: AbortSignal): Promise<unknown>;
  invokeTracked(argv: readonly string[], env: Readonly<NodeJS.ProcessEnv>, observer: { started(pid: number, startTime: string): void; exited(pid: number): void }): Promise<unknown>;
}): LocalExactHc {
  return {
    coreId: signal => input.coreId(signal),
    async terminals(operationId, options) {
      if (!text(operationId)) throw new HerdrError("invalid-operation", "A valid launch operation is required");
      if (options.attemptId !== undefined && !text(options.attemptId)) throw new HerdrError("invalid-operation", "A valid launch attempt is required");
      if (options.anyLaunchLabel) {
        const { sessionId, attemptId } = options.anyLaunchLabel;
        if (!text(sessionId) || !text(attemptId)) throw new HerdrError("invalid-operation", "Valid launch labels are required");
        // Native compact rows omit labels. Three complete filtered lists implement
        // operation OR attempt OR session, not the CLI's AND label selection.
        const terminals = new Map<string, { id: string; state: "live" | "finished" }>();
        for (const label of [`spider.roam.operation=${operationId}`, `spider.roam.attempt=${attemptId}`, `spider.session=${sessionId}`]) {
          const reply = object(await input.invoke(["ls", "--all", "--json", "--label", label], options.signal));
          if (!Array.isArray(reply.terminals)) throw new HerdrError("invalid-reply", "A complete terminal list is required");
          for (const value of reply.terminals) {
            const row = object(value);
            if (!text(row.address)) throw new HerdrError("invalid-reply", "Terminal address is unavailable");
            const parsed = parseCompactLaunchTerminal(row, row.address), previous = terminals.get(parsed.id);
            if (previous && previous.state !== parsed.state) throw new HerdrError("invalid-reply", "Terminal state changed during listing");
            terminals.set(parsed.id, parsed);
          }
        }
        return { complete: true, terminals: [...terminals.values()] };
      }
      const argv = ["ls", "--all", "--json", "--label", `spider.roam.operation=${operationId}`];
      if (options.attemptId) argv.push("--label", `spider.roam.attempt=${options.attemptId}`);
      const reply = object(await input.invoke(argv, options.signal));
      if (!Array.isArray(reply.terminals)) throw new HerdrError("invalid-reply", "A complete terminal list is required");
      if (reply.terminals.length && !options.attemptId) throw new HerdrError("invalid-reply", "A launch attempt is required to identify terminals");
      const terminals = reply.terminals.map(value => parseCompactLaunchTerminal(value, options.terminalId));
      return { complete: true, terminals };
    },
    async run(request, observer) {
      const terminal = request.terminal;
      if (!terminal || !terminal.background || !terminal.noNotify || !terminal.outliveParent || terminal.parent !== null) {
        throw new HerdrError("launch-environment-invalid", "A detached local terminal is required");
      }
      const argv = ["run", "--json", "--bg", "--no-notify", "--outlive-parent", "--no-parent", "--cwd", request.cwd];
      for (const [key, value] of Object.entries(terminal.labels)) argv.push("--label", `${key}=${value}`);
      argv.push("--", ...request.argv);
      const result = object(await input.invokeTracked(argv, request.env, observer));
      const address = replyText(result.address);
      if (!text(address)) throw new HerdrError("invalid-reply", "The local terminal address is invalid");
      return { terminal: address };
    },
  };
}
/** Production local transport: the start and exit observations belong to the spawned hc process. */
export function createProductionLocalExactHc(input: {
  binary: string; env: Readonly<NodeJS.ProcessEnv>; probe(pid: number): Promise<ProcessProbe>;
}): LocalExactHc & { dispose(): Promise<void> } {
  const client = createHcClient({ binary: input.binary, env: input.env });
  const local = createLocalExactHc({
    coreId: async signal => (await observeCoreIdentity(input.binary, input.env, { signal })).coreId,
    invoke: (argv, signal) => invokeHcCli(input.binary, argv, input.env, undefined, undefined, { signal }),
    async invokeTracked(argv, env, observer) {
      if (!input.env.HC_SESSION || !input.env.HC_SOCKET || env.HC_SESSION !== input.env.HC_SESSION || env.HC_SOCKET !== input.env.HC_SOCKET) {
        throw new HerdrError("core-mismatch", "The selected local core changed before launch");
      }
      await requireCoreAvailable(env);
      let observedStart = false;
      let observations = Promise.resolve();
      const processObserver = {
        started(pid: number) {
          observedStart = true;
          observations = observations.then(async () => {
            try {
              const result = await input.probe(pid);
              if (result.kind === "live") observer.started(pid, result.startIdentity);
            } catch { /* Missing process identity is not no-start proof. */ }
          });
        },
        exited(pid: number) {
          observations = observations.then(() => { try { observer.exited(pid); } catch { /* Missing evidence stays pending. */ } });
        },
      };
      try {
        const result = await invokeTransport(input.binary, argv, env, undefined, undefined, { timeoutMs: 60_000, processObserver });
        await observations;
        return result;
      } catch (error) {
        await observations;
        if (observedStart && launchNotStarted(error)) throw new HerdrError("launch-pending", "The local hc process started but its result is uncertain");
        throw error;
      }
    },
  });
  return { ...local, async dispose() { await client.dispose(); } };
}

export async function adoptedOwnerExited(input: {
  root: string; sessionId: string; operationId: string; file: string;
  bootId(): Promise<string>; probe(pid: number): Promise<ProcessProbe>;
  leases: Pick<ExactSessionLaunchPorts["leases"], "get">;
}): Promise<boolean> {
  const first = await inspectIdLock(input.root, input.sessionId);
  const adopted = first?.operationId === input.operationId && first.pendingOperationId === null ? first
    : first ? null : await inspectReleasedIdLock(input.root, input.sessionId, input.operationId);
  if (!adopted) return false;
  const boot = await input.bootId();
  if (!boot || !adopted.bootId) return false;
  const gone = async (identity: { pid: number; startIdentity: string }, priorBoot: string) => {
    if (bootIdChanged(priorBoot, boot)) return true;
    const process = await input.probe(identity.pid);
    return process.kind === "absent" || process.kind === "live" && process.startIdentity !== identity.startIdentity;
  };
  if (!await gone(adopted.identity, adopted.bootId)) return false;
  const lease = await input.leases.get(input.file);
  if (lease && !await gone(lease, lease.bootId ?? "")) return false;
  const last = await inspectIdLock(input.root, input.sessionId);
  if (!first) return last === null;
  return last?.operationId === first.operationId && last.pendingOperationId === null && last.bootId === first.bootId &&
    last.identity.pid === first.identity.pid && last.identity.startIdentity === first.identity.startIdentity;
}

type AdoptedOwnerInput = Parameters<typeof adoptedOwnerExited>[0];
export type AdoptedOwnerObservation =
  | { kind: "exited"; released: boolean; owner: IdLockObservation["identity"]; bootId: string }
  | { kind: "live" | "lease-live" | "unavailable" | "missing" };

/** Stop requires absence on the recorded boot; PID reuse and a changed boot are not this exit proof. */
export async function inspectAdoptedOwner(input: AdoptedOwnerInput): Promise<AdoptedOwnerObservation> {
  try {
    const first = await inspectIdLock(input.root, input.sessionId);
    const adopted = first?.operationId === input.operationId && first.pendingOperationId === null ? first
      : first ? null : await inspectReleasedIdLock(input.root, input.sessionId, input.operationId);
    if (!adopted) return { kind: first ? "unavailable" : "missing" };
    const boot = await input.bootId();
    if (!boot || boot !== adopted.bootId) return { kind: "unavailable" };
    const owner = await input.probe(adopted.identity.pid);
    if (owner.kind === "live" && owner.startIdentity === adopted.identity.startIdentity) return { kind: "live" };
    if (owner.kind !== "absent") return { kind: "unavailable" };
    const lease = await input.leases.get(input.file);
    if (lease) {
      if (lease.bootId !== boot) return { kind: "unavailable" };
      const holder = await input.probe(lease.pid);
      if (holder.kind === "live" && holder.startIdentity === lease.startIdentity) return { kind: "lease-live" };
      if (holder.kind !== "absent") return { kind: "unavailable" };
    }
    const last = await inspectIdLock(input.root, input.sessionId);
    const sameOwner = (value: { identity: IdLockObservation["identity"]; bootId: string; operationId: string | null } | null) =>
      value?.operationId === input.operationId && value.bootId === adopted.bootId &&
      value.identity.pid === adopted.identity.pid && value.identity.startIdentity === adopted.identity.startIdentity;
    if (first ? !sameOwner(last) || last?.pendingOperationId !== null
      : last !== null || !sameOwner(await inspectReleasedIdLock(input.root, input.sessionId, input.operationId))) return { kind: "unavailable" };
    if (await input.bootId() !== boot || JSON.stringify(await input.leases.get(input.file)) !== JSON.stringify(lease)) return { kind: "unavailable" };
    return { kind: "exited", released: first === null, owner: { ...adopted.identity }, bootId: boot };
  } catch { return { kind: "unavailable" }; }
}

/** Adoption claims the session ID before the file lease, so serialize this proof with ID-lock writers. */
export async function settleReleasedAdoptedOwner(input: AdoptedOwnerInput & { journal: Journal }): Promise<boolean> {
  return withProcessLock(input.root, `session-id:${input.sessionId}`, async () => {
    const history = input.journal.read(input.operationId);
    if (history.some(row => row.action === "ready-durable") || await canonicalSessionFile(input.file) !== input.file) return false;
    const observed = await inspectAdoptedOwner(input);
    if (observed.kind !== "exited" || !observed.released || input.journal.read(input.operationId).length !== history.length) return false;
    if (!history.some(row => row.action === "exact-adopted-owner-ended")) input.journal.record(input.operationId, "exact-adopted-owner-ended", {
      sessionId: input.sessionId, file: input.file, owner: { ...observed.owner }, bootId: observed.bootId,
    });
    if (!history.some(row => row.action === "exact-launch-settled")) input.journal.record(input.operationId, "exact-launch-settled", { sessionId: input.sessionId, file: input.file });
    if (!history.some(row => row.action === "done")) input.journal.record(input.operationId, "done", { code: 1, reason: "launch-ended", operationId: input.operationId,
      home: null, epoch: null, repairCommand: null, value: null });
    return true;
  });
}

export interface PendingLaunchRecovery {
  bootId(): Promise<string>;
  probe(pid: number): Promise<ProcessProbe>;
  hc?: LocalExactHc;
  clock?: LaunchReconcilePorts["clock"];
}

/** Stop is a repair, not a retry: prove the terminal cannot adopt before releasing any ownership. */
export async function settlePendingLaunch(input: {
  root: string; sessionId: string; operationId: string; file: string;
  journal: Journal; leases: ExactSessionLaunchPorts["leases"];
  recovery: PendingLaunchRecovery & { hc: LocalExactHc; clock: LaunchReconcilePorts["clock"] };
}): Promise<boolean> {
  const { recovery } = input;
  return cancelExitedIdLockHandoff(input.root, input.sessionId, input.operationId, {
    bootId: recovery.bootId, probe: recovery.probe,
    async reconcileAndRelease(lock) {
      if (lock.pendingFile !== input.file || await canonicalSessionFile(input.file) !== input.file || !lock.pendingCoreId || input.journal.read(input.operationId).some(row => row.action === "ready-durable")) return false;
      const lease = await input.leases.get(input.file);
      if (lease && (lease.pid !== lock.identity.pid || lease.startIdentity !== lock.identity.startIdentity || lease.bootId !== lock.bootId)) return false;
      const reconcile = createLaunchReconciler({ journal: input.journal, inspectLock: () => inspectIdLock(input.root, input.sessionId),
        coreId: recovery.hc.coreId, bootId: recovery.bootId, terminals: recovery.hc.terminals, clock: recovery.clock,
        settlement: { sessionId: input.sessionId, probe: recovery.probe, leases: input.leases } });
      const signal = AbortSignal.timeout(60_000), evidence = await reconcile(input.operationId, { signal });
      const proof = evidence.proof;
      const ended = evidence.receipt === "started" && evidence.terminal === "absent" && proof?.kind === "started-launch-ended" &&
        proof.operationId === input.operationId && proof.coreId === lock.pendingCoreId && proof.bootId === lock.bootId &&
        proof.launcher.pid === lock.identity.pid && proof.launcher.startIdentity === lock.identity.startIdentity;
      if (!ended && !provedNoStart(evidence, input.operationId, lock.pendingCoreId, lock.bootId)) return false;
      if (ended && proof?.kind === "started-launch-ended" && !input.journal.read(input.operationId).some(row => row.action === "exact-started-launch-ended"))
        input.journal.record(input.operationId, "exact-started-launch-ended", { ...proof, launcher: { ...proof.launcher }, first: { ...proof.first }, second: { ...proof.second } });
      if (lease) await input.leases.release(input.file, lease.token, { mode: "cutover" });
      await removeLaunchHandoff(input.root, input.operationId);
      if (!input.journal.read(input.operationId).some(row => row.action === "exact-launch-settled"))
        input.journal.record(input.operationId, "exact-launch-settled", { sessionId: input.sessionId, file: input.file });
      input.journal.record(input.operationId, "done", { code: 1, reason: ended ? "launch-ended" : "launch-not-started", operationId: input.operationId,
        home: null, epoch: null, repairCommand: null, value: null });
      return true;
    },
  });
}

export type ExactLaunchResult = SessionLaunchResult | { kind: "adopted-exited"; operationId: string };
export function createExactLaunchAdapter(input: {
  base: Omit<ExactSessionLaunchPorts, "spawnPi" | "reconcileLaunch">;
  journal: Journal;
  hc: LocalExactHc;
  clock: LaunchReconcilePorts["clock"];
}): { launch(request: ExactSessionLaunchRequest, options?: { mode: "fresh" | "reconcile" }): Promise<ExactLaunchResult> } {
  const { base, journal, hc, clock } = input;
  return {
    async launch(request, options = { mode: "fresh" }) {
      const globalRoot = base.env.SPIDER_GLOBAL_ROOT;
      if (!globalRoot) throw new HerdrError("launch-environment-invalid", "A destination root is required");
      const root = resolve(globalRoot, "herdr"), operationId = request.operationId ?? randomUUID();
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(operationId) || options.mode === "reconcile" && !request.operationId) {
        throw new HerdrError("launch-environment-invalid", "A valid reserved operation is required");
      }
      const previous = await inspectIdLock(root, request.sessionId), bootId = await base.bootId();
      if (options.mode === "reconcile") {
        if (await adoptedOwnerExited({ root, sessionId: request.sessionId, operationId, file: request.file, bootId: base.bootId,
          probe: base.processInventory.probe, leases: base.leases })) return { kind: "adopted-exited", operationId };
        if (previous?.operationId === operationId && previous.pendingOperationId === null) {
          const lease = await base.leases.get(request.file);
          const probe = await base.processInventory.probe(previous.identity.pid);
          let removed = false;
          try { await lstat(launchHandoffPath(root, operationId)); }
          catch (error) { removed = (error as NodeJS.ErrnoException).code === "ENOENT"; }
          const still = await inspectIdLock(root, request.sessionId);
          if (previous.bootId === bootId && lease && lease.pid === previous.identity.pid && lease.startIdentity === previous.identity.startIdentity &&
              lease.bootId === bootId && probe.kind === "live" && probe.startIdentity === previous.identity.startIdentity && removed &&
              still?.operationId === operationId && still.pendingOperationId === null && still.bootId === previous.bootId &&
              still.identity.pid === previous.identity.pid && still.identity.startIdentity === previous.identity.startIdentity) {
            return { ...previous.identity, sessionFile: lease.file, sessionId: request.sessionId as SessionId, cwd: request.cwd, token: lease.token, operationId };
          }
          throw new HerdrError("launch-pending", "The adopted launch cannot be verified");
        }
        if (!previous || previous.pendingOperationId !== operationId) throw new HerdrError("launch-pending", "The reserved launch has no authoritative handoff");
      } else {
        if (previous?.pendingOperationId) throw new HerdrError(request.operationId ? "launch-reservation-exists" : "launch-pending", "An exact launch is already pending");
        const begun = journal.begin({ id: operationId, machineId: base.machineId, expectedEpoch: request.epoch, kind: "exact-session-launch", args: { sessionId: request.sessionId } });
        if (begun.kind !== "new") throw new HerdrError("launch-reservation-exists", "A launch reservation already exists");
      }
      const tracker = createLaunchTracker({ journal, machineId: base.machineId, coreId: base.core.coreId, bootId, sessionId: request.sessionId });
      const reconcileLaunch = createLaunchReconciler({ journal,
        inspectLock: () => inspectIdLock(root, request.sessionId),
        coreId: signal => hc.coreId(signal), bootId: () => base.bootId(), terminals: (id, opts) => hc.terminals(id, opts), clock });
      return launchExactSession({ ...request, operationId }, { ...base, reconcileLaunch, retainProvedHandoff: request.operationId !== undefined,
        async spawnPi(spawn) {
          const attemptId = randomUUID();
          if (spawn.terminal?.labels["spider.roam.operation"] !== operationId || !tracker.begin(operationId, request.epoch, { attemptId, resume: true })) {
            throw new HerdrError("launch-pending", "Launch operation already exists");
          }
          let observedStart = false;
          try {
            const current = await hc.coreId(new AbortController().signal);
            if (current !== base.core.coreId) throw new HerdrError("core-mismatch", "The selected core identity changed");
            const terminal = { ...spawn.terminal, labels: { ...spawn.terminal.labels, "spider.roam.attempt": attemptId } };
            const result = await hc.run({ ...spawn, terminal }, {
              started(pid, startTime) { observedStart = true; try { tracker.started(operationId, pid, startTime); } catch { /* Missing evidence stays pending. */ } },
              exited(pid) { observedStart = true; try { tracker.exited(operationId, pid, clock.now()); } catch { /* Missing evidence stays pending. */ } },
            });
            tracker.replied(operationId, result.terminal);
          } catch (error) {
            if (!observedStart) { try { tracker.failed(operationId, error); } catch { /* Missing evidence stays pending. */ } }
            throw error;
          }
        },
      });
    },
  };
}

async function abortable<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
  if (signal.aborted) throw new Error("Launch reconciliation aborted");
  return new Promise<T>((resolve, reject) => {
    const aborted = () => { cleanup(); reject(new Error("Launch reconciliation aborted")); };
    const cleanup = () => signal.removeEventListener("abort", aborted);
    signal.addEventListener("abort", aborted, { once: true });
    void Promise.resolve().then(operation).then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
    if (signal.aborted) aborted();
  });
}

/** A missing receipt or timeout alone never proves no start. */
export function createLaunchReconciler(ports: LaunchReconcilePorts): (operationId: string, options: { signal: AbortSignal }) => Promise<LaunchEvidence> {
  return async (operationId, { signal }) => {
    try {
      if (!text(operationId)) return unknown();
      const lock = await abortable(signal, () => ports.inspectLock());
      if (!lock || lock.pendingOperationId !== operationId || !text(lock.pendingCoreId)) return unknown();
      const allActions = [...ports.journal.read(operationId)];
      let marker = -1;
      for (let i = 0; i < allActions.length; i++) if (allActions[i].action === "exact-attempt") marker = i;
      const attemptId = marker < 0 ? undefined : allActions[marker].result.attemptId;
      if (marker >= 0 && !text(attemptId)) return unknown();
      const actions = marker < 0 ? allActions : allActions.slice(marker + 1);
      const one = (action: string) => {
        const found = actions.filter(item => item.action === action);
        return found.length === 1 ? found[0].result : undefined;
      };
      const has = (action: string) => actions.some(item => item.action === action);
      const core = one("exact-core"), started = one("exact-hc-started"), exited = one("exact-hc-exited");
      const pinnedCore = lock.pendingCoreId;
      if (allActions.some(item => item.action === "exact-core" && item.result.coreId !== pinnedCore) || !core && has("exact-core")) return unknown();
      const failure = one("exact-prelaunch-error");
      if (core && failure && !has("exact-hc-started") && !has("exact-hc-exited") && !has("exact-terminal")) {
        if ((failure.errorCode === "core-unavailable" || failure.errorCode === "core-mismatch") && failure.hcPid === undefined) {
          return { receipt: "unknown", terminal: "unknown", proof: { kind: "prelaunch-error", operationId, beforeLaunch: true, errorCode: failure.errorCode } };
        }
        if ((failure.errorCode === "missing-hc" || failure.errorCode === "spawn-error") && failure.hcPid === null) {
          return { receipt: "unknown", terminal: "unknown", proof: { kind: "prelaunch-error", operationId, beforeLaunch: true, errorCode: failure.errorCode, hcPid: null } };
        }
      }
      const terminal = one("exact-terminal");
      const terminalId = terminal && text(terminal.terminalId) ? terminal.terminalId : undefined;
      const receipt = has("exact-terminal") ? "started" as const : "unknown" as const;
      const sample = async (allAttempts = false, anyLaunchLabel = false) => {
        if (await abortable(signal, () => ports.coreId(signal)) !== pinnedCore) return null;
        const issuedAt = ports.clock.now();
        const result = await abortable(signal, () => ports.terminals(operationId, { signal, includeFinished: true, ...(!allAttempts && typeof attemptId === "string" ? { attemptId } : {}), ...(terminalId ? { terminalId } : {}),
          ...(anyLaunchLabel && ports.settlement && typeof attemptId === "string" ? { anyLaunchLabel: { sessionId: ports.settlement.sessionId, attemptId } } : {}) }));
        if (await abortable(signal, () => ports.coreId(signal)) !== pinnedCore || !result.complete ||
            !Array.isArray(result.terminals) || result.terminals.some(item => !item || !text(item.id) || !["live", "finished"].includes(item.state))) return null;
        return { issuedAt, terminals: result.terminals };
      };
      const present = async (terminals: readonly { id: string; state: "live" | "finished" }[]): Promise<LaunchEvidence> => {
        if (terminals.length !== 1 || terminals[0].state !== "finished" || !lock.pendingFile) return { receipt, terminal: "present" };
        const current = await abortable(signal, () => ports.inspectLock());
        if (!current || current.pendingOperationId !== operationId || current.pendingCoreId !== lock.pendingCoreId ||
            current.pendingFile !== lock.pendingFile || current.bootId !== lock.bootId || current.identity.pid !== lock.identity.pid ||
            current.identity.startIdentity !== lock.identity.startIdentity) return { receipt, terminal: "present" };
        return { receipt, terminal: "present", proof: { kind: "terminal-exited-without-adoption", operationId,
          coreId: lock.pendingCoreId!, terminalId: terminals[0].id, terminalExited: true, lockNeverAdopted: true } };
      };
      const currentBoot = await abortable(signal, () => ports.bootId(signal));
      if (bootIdChanged(lock.bootId, currentBoot)) {
        const first = await sample(true);
        if (!first) return unknown();
        if (first.terminals.length) return { receipt, terminal: "present" };
        const current = await abortable(signal, () => ports.inspectLock());
        if (!current || current.pendingOperationId !== operationId || current.pendingCoreId !== lock.pendingCoreId ||
            current.pendingFile !== lock.pendingFile || current.bootId !== lock.bootId || current.identity.pid !== lock.identity.pid ||
            current.identity.startIdentity !== lock.identity.startIdentity || await abortable(signal, () => ports.bootId(signal)) !== currentBoot ||
            ports.journal.read(operationId).length !== allActions.length) return unknown();
        return { receipt, terminal: "absent", proof: { kind: "boot-changed-no-terminal", operationId,
          coreId: lock.pendingCoreId!, previousBootId: lock.bootId, currentBootId: currentBoot, terminal: "absent" } };
      }
      if (!core) return unknown();
      const startedIndex = actions.findIndex(item => item.action === "exact-hc-started");
      const exitedIndex = actions.findIndex(item => item.action === "exact-hc-exited");
      const coreIndex = actions.findIndex(item => item.action === "exact-core");
      const validExit = started && exited && coreIndex < startedIndex && startedIndex < exitedIndex && Number.isSafeInteger(started.pid) && (started.pid as number) > 0 &&
        text(started.startTime) && text(started.bootId) && started.bootId === lock.bootId && exited.pid === started.pid && time(exited.exitedAt);
      if (validExit && await abortable(signal, () => ports.bootId(signal)) !== started.bootId) return unknown();
      if (validExit && ports.clock.now() < (exited.exitedAt as number)) return unknown();
      if (validExit && ports.clock.now() === exited.exitedAt) await abortable(signal, () => ports.clock.wait(1, signal));
      const first = await sample();
      if (!first) return unknown();
      if (first.terminals.length) return present(first.terminals);
      if (receipt === "started") {
        const settlement = ports.settlement;
        if (!settlement || !text(attemptId) || !terminalId || !text(currentBoot) || currentBoot !== lock.bootId || !lock.pendingFile) return { receipt, terminal: "absent" };
        const unadoptedExited = async () => {
          const current = await abortable(signal, () => ports.inspectLock());
          if (!current || current.pendingOperationId !== operationId || current.pendingCoreId !== lock.pendingCoreId ||
              current.pendingFile !== lock.pendingFile || current.bootId !== lock.bootId || current.identity.pid !== lock.identity.pid ||
              current.identity.startIdentity !== lock.identity.startIdentity || await abortable(signal, () => ports.bootId(signal)) !== lock.bootId ||
              ports.journal.read(operationId).length !== allActions.length || allActions.some(row => row.action === "ready-durable")) return false;
          const owner = await abortable(signal, () => settlement.probe(lock.identity.pid));
          if (!(owner.kind === "absent" || owner.kind === "live" && owner.startIdentity !== lock.identity.startIdentity)) return false;
          const lease = await abortable(signal, () => settlement.leases.get(lock.pendingFile!));
          return !lease || lease.pid === lock.identity.pid && lease.startIdentity === lock.identity.startIdentity && lease.bootId === lock.bootId;
        };
        if (!await unadoptedExited()) return { receipt, terminal: "absent" };
        const endedFirst = await sample(false, true);
        if (!endedFirst) return unknown();
        if (endedFirst.terminals.some(row => row.state === "live")) return { receipt, terminal: "present" };
        const firstFinished = endedFirst.terminals.find(row => row.id === terminalId && row.state === "finished");
        if (firstFinished) return await unadoptedExited() ? present([firstFinished]) : unknown();
        await abortable(signal, () => ports.clock.wait(CONFIRMATION_BOUND_MS, signal));
        const endedSecond = await sample(false, true);
        if (!endedSecond || endedSecond.issuedAt - endedFirst.issuedAt < CONFIRMATION_BOUND_MS) return unknown();
        if (endedSecond.terminals.some(row => row.state === "live")) return { receipt, terminal: "present" };
        const secondFinished = endedSecond.terminals.find(row => row.id === terminalId && row.state === "finished");
        if (secondFinished) return await unadoptedExited() ? present([secondFinished]) : unknown();
        if (!await unadoptedExited()) return unknown();
        return { receipt, terminal: "absent", proof: { kind: "started-launch-ended", operationId, attemptId, terminalId,
          coreId: pinnedCore, bootId: lock.bootId, launcher: { ...lock.identity },
          first: { coreId: pinnedCore, issuedAt: endedFirst.issuedAt, terminal: "absent" },
          second: { coreId: pinnedCore, issuedAt: endedSecond.issuedAt, terminal: "absent" }, confirmationBoundMs: CONFIRMATION_BOUND_MS } };
      }
      if (!validExit || first.issuedAt <= (exited!.exitedAt as number)) return { receipt, terminal: "absent" };
      await abortable(signal, () => ports.clock.wait(CONFIRMATION_BOUND_MS, signal));
      const second = await sample();
      if (!second || second.issuedAt - first.issuedAt < CONFIRMATION_BOUND_MS) return unknown();
      if (second.terminals.length) return present(second.terminals);
      if (ports.journal.read(operationId).length !== allActions.length) return unknown();
      return { receipt, terminal: "absent", proof: { kind: "no-terminal-after-hc-exit", operationId,
        coreIdBefore: core.coreId as string, hcExitedAt: exited!.exitedAt as number,
        first: { coreId: core.coreId as string, issuedAt: first.issuedAt, terminal: "absent" },
        second: { coreId: core.coreId as string, issuedAt: second.issuedAt, terminal: "absent" }, confirmationBoundMs: CONFIRMATION_BOUND_MS } };
    } catch { return unknown(); }
  };
}

/** Match the ordinary session launcher's PATH lookup, then pin the executable for service launches. */
export function resolveParticipantPi(env: Readonly<NodeJS.ProcessEnv> = process.env): string | null {
  const explicit = env.SPIDER_ROAM_PI;
  const candidates = explicit !== undefined ? [explicit] : (env.PATH ?? "").split(delimiter).filter(Boolean).map(directory => resolve(directory, "pi"));
  for (const candidate of candidates) {
    if (!isAbsolute(candidate) || /[\x00-\x1f\x7f]/.test(candidate)) continue;
    try { if (statSync(candidate).isFile()) { accessSync(candidate, constants.X_OK); return candidate; } } catch { /* Try the next PATH entry. */ }
  }
  return null;
}

import { randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import { resolve } from "node:path";
import { HerdrError, object, parseTerminal, text as replyText } from "@spider/herdr/client/parse";
import { createHcClient, invokeCli as invokeHcCli, observeCoreIdentity } from "@spider/herdr/client/hc";
import { invokeCli as invokeTransport } from "@spider/herdr/client/cli-transport";
import { requireCoreAvailable } from "@spider/herdr/client/liveness";
import type { ProcessProbe } from "@spider/herdr/sessions/lease";
import { inspectIdLock } from "@spider/herdr/sessions/id-lock";
import { launchHandoffPath } from "@spider/herdr/sessions/launch-handoff";
import type { SessionId } from "@spider/herdr";
import { launchExactSession } from "@spider/herdr/sessions/launcher";
import { launchNotStarted } from "@spider/herdr/roam-placement";
import type { IdLockObservation } from "@spider/herdr/sessions/id-lock";
import type { ExactSessionLaunchPorts, ExactSessionLaunchRequest, LaunchEvidence, PiSpawnRequest, SessionLaunchResult } from "@spider/herdr/sessions/launcher";
import type { Journal } from "./contracts";

export interface LaunchReconcilePorts {
  journal: Journal;
  inspectLock(): Promise<IdLockObservation | null>;
  coreId(signal: AbortSignal): Promise<string>;
  bootId(signal: AbortSignal): Promise<string>;
  terminals(operationId: string, options: { signal: AbortSignal; includeFinished: true; attemptId?: string }): Promise<{
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
      const argv = ["ls", "--all", "--json", "--label", `spider.roam.operation=${operationId}`];
      if (options.attemptId) argv.push("--label", `spider.roam.attempt=${options.attemptId}`);
      const reply = object(await input.invoke(argv, options.signal));
      if (!Array.isArray(reply.terminals)) throw new HerdrError("invalid-reply", "A complete terminal list is required");
      const terminals = reply.terminals.map(parseTerminal).map(terminal => {
        if (terminal.labels["spider.roam.operation"] !== operationId || options.attemptId && terminal.labels["spider.roam.attempt"] !== options.attemptId || !text(terminal.address)) {
          throw new HerdrError("invalid-reply", "Terminal list does not match the launch operation");
        }
        return { id: terminal.address as string, state: terminal.state };
      });
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

export function createExactLaunchAdapter(input: {
  base: Omit<ExactSessionLaunchPorts, "spawnPi" | "reconcileLaunch">;
  journal: Journal;
  hc: LocalExactHc;
  clock: LaunchReconcilePorts["clock"];
}): { launch(request: ExactSessionLaunchRequest, options?: { mode: "fresh" | "reconcile" }): Promise<SessionLaunchResult> } {
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

/** A missing receipt, a timed-out call, or one absent snapshot never proves no start. */
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
      if (!core || core.coreId !== lock.pendingCoreId) return unknown();
      const failure = one("exact-prelaunch-error");
      if (failure && !has("exact-hc-started") && !has("exact-hc-exited") && !has("exact-terminal")) {
        if ((failure.errorCode === "core-unavailable" || failure.errorCode === "core-mismatch") && failure.hcPid === undefined) {
          return { receipt: "unknown", terminal: "unknown", proof: { kind: "prelaunch-error", operationId, beforeLaunch: true, errorCode: failure.errorCode } };
        }
        if ((failure.errorCode === "missing-hc" || failure.errorCode === "spawn-error") && failure.hcPid === null) {
          return { receipt: "unknown", terminal: "unknown", proof: { kind: "prelaunch-error", operationId, beforeLaunch: true, errorCode: failure.errorCode, hcPid: null } };
        }
      }
      const receipt = has("exact-terminal") ? "started" as const : "unknown" as const;
      const sample = async () => {
        if (await abortable(signal, () => ports.coreId(signal)) !== core.coreId) return null;
        const issuedAt = ports.clock.now();
        const result = await abortable(signal, () => ports.terminals(operationId, { signal, includeFinished: true, ...(typeof attemptId === "string" ? { attemptId } : {}) }));
        if (await abortable(signal, () => ports.coreId(signal)) !== core.coreId || !result.complete ||
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
      if (!validExit || receipt === "started" || first.issuedAt <= (exited!.exitedAt as number)) return { receipt, terminal: "absent" };
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

import { validUnicode } from "@spider/db-core/roam/hlc";
import type { MachineId } from "@spider/db-core/roam/types";
import type { Clock } from "../contracts";
import { isMachineId } from "../machine-id";
import { sameManagedHome, type HubHomeStore } from "./home";
import { AwayHomeRecoveryRequired, MacSessionOccupied } from "./home-refusals";
import type { SessionOperations } from "./session-operations";
import { hasStopProof, projectSessionStatus } from "./session-stop-store";
import type { OperationBinding, SessionOutcome, SessionStopStore, SessionTransition, StartRequest, StopObservation } from "./session-stop-types";
import type { RelocateHome, RunningHome, SessionId, SessionMachinePorts, SessionPlacement, SettledHome, StoppedHome, V0Result } from "./types";

export interface StartMachinePorts extends Pick<SessionMachinePorts, "locate" | "publishHome" | "activate" | "start"> {
  checkStart(home: SettledHome): Promise<V0Result<SessionPlacement>>;
  observe(machine: MachineId, home: StoppedHome): Promise<V0Result<StopObservation>>;
  ownerFree(home: RunningHome, placement: SessionPlacement): Promise<boolean>;
  confirm(home: RunningHome, placement: SessionPlacement, exact: true): Promise<V0Result<{ terminal: string }>>;
}

export interface StartCommandPorts extends StartMachinePorts {
  operations: SessionOperations;
  store: SessionStopStore;
  homes: HubHomeStore;
  withSession<T>(id: SessionId, run: () => Promise<T>): Promise<T>;
  enabled(): boolean;
  localMachineId: MachineId;
  clock: Clock;
  readyMs: number;
}

interface StartCommand {
  (request: StartRequest): Promise<SessionOutcome>;
  reconcile(home: RunningHome, continueLocally: boolean): Promise<void>;
  close(): Promise<void>;
}

type StartRecord = Extract<SessionTransition, { action: "start" }>;
type Admission = { reply: SessionOutcome } | { home: RunningHome; placement?: SessionPlacement; continue: boolean };
const awaitingOwner = "The home machine has not confirmed an admitted pi owner.";

function sameRequest(a: StartRequest, b: StartRequest): boolean {
  return a.operationId === b.operationId && a.sessionId === b.sessionId && a.machineId === b.machineId && a.homeEpoch === b.homeEpoch;
}
function validText(value: string): boolean {
  return validUnicode(value) && value.length <= 4096 && !!value.trim() && !/[\u0000-\u001f\u007f]/.test(value);
}

export function createStartCommand(ports: StartCommandPorts): StartCommand {
  const { operations, store, homes, clock } = ports;
  const requests = new Map<string, { request: StartRequest; done: Promise<SessionOutcome> }>();
  const attempts = new Map<string, Promise<void>>();
  const localChecks = new Map<string, () => void>();
  let closing: Promise<void> | undefined;
  const underLock = <T>(id: SessionId, run: () => Promise<T>) => operations.enqueue(id, () => ports.withSession(id, run));

  function record(home: RunningHome): StartRecord | null {
    const saved = store.current(home.sessionId);
    return saved?.action === "start" && sameManagedHome(saved.committed, home) ? saved : null;
  }
  function status(request: StartRequest, home: RelocateHome | null, outcome: SessionOutcome["outcome"], reason?: string): SessionOutcome {
    const projected = projectSessionStatus(home, home ? store.current(home.sessionId) : null, request.sessionId, clock.now());
    return { ...projected, operationId: request.operationId, outcome, reason: reason ?? projected.reason };
  }
  function unavailable(request: StartRequest, writeAttempted: boolean): SessionOutcome {
    return { sessionId: request.sessionId, operationId: request.operationId,
      outcome: writeAttempted ? "pending" : "refused", reason: writeAttempted ? "session-commit-unknown" : "session-commit-failed",
      machineId: null, homeEpoch: null, homeState: null, status: null, observedAt: null };
  }
  function replay(request: StartRequest, home: RelocateHome | null, binding: OperationBinding): Admission {
    if (binding.action !== "start" || !sameRequest(binding.request, request))
      return { reply: status(request, home, "refused", "operation-reused") };
    if (!sameManagedHome(home, binding.committed))
      return { reply: status(request, home, "refused", "home-superseded") };
    // A replay of an older ID at this same epoch cannot relaunch a newer request.
    return { home: binding.committed, continue: record(binding.committed)?.operationId === request.operationId };
  }
  async function snapshot(request: StartRequest, committed?: RunningHome): Promise<SessionOutcome> {
    const home = await homes.read(request.sessionId);
    if (!committed) {
      const binding = store.operation(request.operationId);
      if (!binding) return status(request, home, "pending", "waiting-for-session-operation");
      const saved = replay(request, home, binding);
      if ("reply" in saved) return saved.reply;
      committed = saved.home;
    }
    if (!sameManagedHome(home, committed)) return status(request, home, "refused", "home-superseded");
    const saved = record(committed);
    return status(request, home, saved && saved.observedAt !== null ? "complete" : "pending");
  }

  async function admit(request: StartRequest, bindingChecked: (bound: boolean) => void, willWrite: () => void): Promise<Admission> {
    const home = await homes.read(request.sessionId);
    const bound = store.operation(request.operationId);
    bindingChecked(bound !== null);
    if (bound) return replay(request, home, bound);
    const refuse = (reason: string): Admission => ({ reply: status(request, home, "refused", reason) });
    if (closing || !ports.enabled()) return refuse("Roaming is disabled or the hub is closing.");
    if (!home || home.machineId !== request.machineId || home.epoch !== request.homeEpoch) return refuse("home-changed");
    if (home.state === "moving") return refuse("Finish or undo the move with `spider roam relocate`, then retry Start.");
    if (home.state === "stopped") {
      if (projectSessionStatus(home, store.current(home.sessionId), home.sessionId, clock.now()).status !== "stopped")
        return refuse("Wait for Stop to be confirmed on the home machine and any displaced machines, then retry Start.");
      if (home.machineId !== ports.localMachineId && home.moveId === null)
        return refuse("This stopped box home has no move ID. Use `spider roam relocate` to bring the confirmed stopped copy to the Mac, then use Start.");
    }
    const checked = await ports.checkStart(home);
    if (!checked.ok) return refuse(`${checked.refusal.message} ${checked.refusal.nextStep}`);
    if (home.state === "stopped") {
      const observed = await ports.observe(home.machineId, home);
      if (!observed.ok || !hasStopProof(home, home.machineId, { observations: [observed.value] }))
        return refuse("The home machine cannot verify that the exact stopped session is still clear. Confirm Stop before retrying Start.");
    }
    if (closing || !ports.enabled()) return refuse("Roaming is disabled or the hub is closing.");
    // Checks can yield while another session binds this ID. The CAS hook also
    // rejects a conflicting binding on the same connection as the home write.
    const earlier = store.operation(request.operationId);
    bindingChecked(earlier !== null);
    if (earlier) return replay(request, await homes.read(request.sessionId), earlier);
    const committed: RunningHome = home.state === "running" ? home : { ...home, state: "running", epoch: home.epoch + 1, updatedAt: clock.now() };
    const binding = { action: "start", request, committed } as const;
    const pending: StartRecord = { action: "start", operationId: request.operationId, expected: home, committed, observedAt: null, contactReason: null };
    if (home.state === "stopped") {
      willWrite();
      const swapped = await homes.compareAndSwap(home, committed, undefined, () => store.write(pending, binding));
      if (swapped.kind !== "applied") return { reply: status(request, swapped.home, "refused", "home-changed") };
    } else {
      const current = await homes.read(home.sessionId);
      if (!sameManagedHome(current, home)) return { reply: status(request, current, "refused", "home-changed") };
      const existing = record(home);
      willWrite();
      store.write(existing?.observedAt === null ? existing : pending, binding);
    }
    return { home: committed, placement: checked.value, continue: true };
  }

  // Contact and effects do not hold the hub operation lock. Only the exact
  // pending row can authorize the next effect or accept its result.
  async function stillPending(home: RunningHome): Promise<boolean> {
    return !closing && ports.enabled() && sameManagedHome(await homes.read(home.sessionId), home) &&
      !closing && ports.enabled() && record(home)?.observedAt === null;
  }
  async function save(home: RunningHome, observedAt: number | null, contactReason: string | null): Promise<void> {
    await underLock(home.sessionId, async () => {
      if (!await stillPending(home)) return;
      const pending = record(home);
      if (pending && (observedAt !== null || pending.contactReason !== contactReason))
        store.write({ ...pending, observedAt, contactReason });
    });
  }
  async function complete(home: RunningHome, canLaunch: boolean, placement?: SessionPlacement): Promise<void> {
    if (!await stillPending(home)) return;
    if (canLaunch && !(await ports.publishHome(home, home.machineId)).ok) {
      await save(home, null, "The exact running home has not reached its machine.");
      return;
    }
    if (!await stillPending(home)) return;
    if (!placement) {
      const located = await ports.locate(home.machineId, home.sessionId);
      if (!located.ok) { await save(home, null, "The session transcript or checkout cannot be verified."); return; }
      placement = located.value;
    }
    if (canLaunch && await stillPending(home) && await ports.ownerFree(home, placement)) {
      if (!await stillPending(home)) return;
      if (!(await ports.activate(home, placement)).ok) { await save(home, null, "The session membership has not been activated."); return; }
      if (!await stillPending(home)) return;
      // A lost launch reply says nothing about whether pi actually started.
      await ports.start(home, placement);
    }
    if (!await stillPending(home)) return;
    const verified = await ports.confirm(home, placement, true);
    await save(home, verified.ok ? clock.now() : null, verified.ok ? null : awaitingOwner);
  }
  function checkLocalAdmission(home: RunningHome, key: string, until: number) {
    const left = until - clock.now();
    if (closing || !ports.enabled() || left <= 0 || localChecks.has(key) || record(home)?.observedAt !== null) return;
    // The Mac has no restart loop. For this explicit operation, observe late
    // admission during its remaining budget without ever launching here.
    localChecks.set(key, clock.later(Math.min(1_000, left), () => {
      if (closing || clock.now() >= until) { localChecks.delete(key); return; }
      void reconcile(home, false).finally(() => {
        localChecks.delete(key);
        checkLocalAdmission(home, key, until);
      }).catch(() => {});
    }));
  }
  function reconcile(home: RunningHome, canLaunch: boolean, placement?: SessionPlacement): Promise<void> {
    if (closing) return Promise.resolve();
    const key = JSON.stringify([home.sessionId, home.epoch, canLaunch]);
    const active = attempts.get(key) ?? attempts.get(JSON.stringify([home.sessionId, home.epoch, true]));
    if (active) return active;
    const until = clock.now() + ports.readyMs;
    const done = complete(home, canLaunch, placement).catch(() => {
      // Contact errors leave the committed Start pending. No new grant on retry.
    }).finally(() => {
      attempts.delete(key);
      if (canLaunch && home.machineId === ports.localMachineId) checkLocalAdmission(home, key, until);
    });
    attempts.set(key, done);
    return done;
  }

  async function perform(request: StartRequest): Promise<SessionOutcome> {
    // Before the binding lookup this may be a replay of a committed request.
    let admitted: Admission, commitPossible = true;
    try { admitted = await underLock(request.sessionId, () => admit(request,
      bound => { commitPossible = bound; }, () => { commitPossible = true; })); }
    catch (error) {
      try {
        const bound = store.operation(request.operationId);
        commitPossible = bound !== null;
        if (bound) return await snapshot(request); // The CAS reply may have been lost after the atomic write.
        const home = await homes.read(request.sessionId);
        const reason = error instanceof AwayHomeRecoveryRequired ? error.refusal(request.sessionId).nextStep :
          error instanceof MacSessionOccupied ? error.refusal("Start").message : "The session could not be authorized to start.";
        return status(request, home, "refused", reason);
      } catch {
        // An unreadable binding cannot rule out a replay or a committed write.
        // A later replay will reconcile it.
        return unavailable(request, commitPossible);
      }
    }
    if ("reply" in admitted) return admitted.reply;
    try {
      if (admitted.continue) await reconcile(admitted.home, true, admitted.placement);
      return await snapshot(request, admitted.home);
    } catch { return unavailable(request, true); }
  }
  async function start(input: StartRequest): Promise<SessionOutcome> {
    const request = { ...input };
    if (!validText(request.operationId) || !validText(request.sessionId) || !isMachineId(request.machineId) ||
        !Number.isSafeInteger(request.homeEpoch) || request.homeEpoch < 1)
      return status(request, null, "refused", "invalid-arguments");
    if (closing) return status(request, null, "refused", "hub-closing");
    let active = requests.get(request.operationId);
    if (active && !sameRequest(active.request, request)) return status(request, null, "refused", "operation-reused");
    if (!active) {
      const done = perform(request).finally(() => requests.delete(request.operationId));
      requests.set(request.operationId, active = { request, done });
    }
    let cancel!: () => void;
    const deadline = new Promise<SessionOutcome>(resolve => {
      cancel = clock.later(ports.readyMs, () => resolve(snapshot(request)));
    });
    try { return await Promise.race([active.done, deadline]); }
    catch { return unavailable(request, true); }
    finally { cancel(); }
  }
  return Object.assign(start, { reconcile, close() {
    if (!closing) {
      closing = Promise.allSettled([...attempts.values(), ...[...requests.values()].map(item => item.done)]).then(() => {});
      for (const cancel of localChecks.values()) cancel();
      localChecks.clear();
    }
    return closing;
  } });
}

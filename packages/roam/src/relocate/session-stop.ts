import type { Clock } from "../contracts";
import { sameManagedHome, type HubHomeStore } from "./home";
import type { MoveTurn, SessionOperations } from "./session-operations";
import { projectSessionStatus } from "./session-stop-store";
import type { OperationBinding, SessionOutcome, SessionStopStore, SessionTransition, StopRequest } from "./session-stop-types";
import type { RelocateHome, SessionId, StoppedHome } from "./types";

export interface StopCommandPorts {
  operations: SessionOperations;
  store: SessionStopStore;
  homes: HubHomeStore;
  withSession<T>(id: SessionId, run: () => Promise<T>): Promise<T>;
  enabled(): boolean;
  clock: Clock;
  readyMs: number;
  reconcile(home: StoppedHome): Promise<void>;
  // When reconciliation continues in the background, observe subsequent records.
  subscribe?(id: SessionId, changed: () => void): () => void;
}

type StopBinding = Extract<OperationBinding, { action: "stop" }>;
type Admission = { kind: "committed"; home: StoppedHome } | { kind: "refused"; reply: SessionOutcome };
interface Flight {
  request: StopRequest;
  move: MoveTurn | null;
  snapshot(): SessionOutcome | Promise<SessionOutcome>;
  done: Promise<SessionOutcome>;
}

function sameRequest(a: StopRequest, b: StopRequest): boolean {
  return a.operationId === b.operationId && a.sessionId === b.sessionId &&
    a.machineId === b.machineId && a.homeEpoch === b.homeEpoch && a.mode === b.mode;
}

function matchesRequest(home: RelocateHome | null, request: StopRequest): boolean {
  return home !== null && home.sessionId === request.sessionId &&
    home.machineId === request.machineId && home.epoch === request.homeEpoch;
}

interface StopCommand {
  (request: StopRequest): Promise<SessionOutcome>;
  close(): Promise<void>;
}

export function createStopCommand(ports: StopCommandPorts): StopCommand {
  const { operations, store, homes, clock } = ports;
  // Until commit there is no durable binding. Reserve IDs across all sessions here.
  const flights = new Map<string, Flight>();
  // Only Stops pinned to this exact turn can share the successor a follower commits.
  const stoppedByFollower = new WeakMap<MoveTurn, StoppedHome>();
  const wakeOnClose = new Set<() => void>();
  let closing: Promise<void> | undefined;

  function statusFor(request: StopRequest, home: RelocateHome | null) {
    return projectSessionStatus(home, home ? store.current(home.sessionId) : null, request.sessionId, clock.now());
  }

  function reply(request: StopRequest, outcome: SessionOutcome["outcome"], reason: string, home: RelocateHome | null = null): SessionOutcome {
    return { ...statusFor(request, home), operationId: request.operationId, outcome, reason };
  }

  function saved(request: StopRequest, binding: OperationBinding): Admission {
    return binding.action === "stop" && sameRequest(binding.request, request)
      ? { kind: "committed", home: binding.committed }
      : { kind: "refused", reply: reply(request, "refused", "operation-reused") };
  }

  function committedStatus(request: StopRequest, home: StoppedHome): SessionOutcome {
    const status = statusFor(request, home);
    return { ...status, operationId: request.operationId, outcome: status.status === "stopped" ? "complete" : "pending" };
  }

  async function commit(request: StopRequest, move: MoveTurn | null): Promise<Admission> {
    // The pinned turn is already over once this queued callback runs.
    const result = await move?.result;
    const home = await homes.read(request.sessionId);
    const binding = store.operation(request.operationId);
    if (binding) return saved(request, binding);
    const refuse = (reason: string): Admission => ({ kind: "refused", reply: reply(request, "refused", reason, home) });
    if (!ports.enabled()) return refuse("roaming-disabled");
    if (!home) return refuse("home-changed");
    if (home.state === "moving") return refuse("Finish or undo the move with `spider roam relocate`, then stop.");
    const pinned = move && (matchesRequest(move.source, request) || matchesRequest(move.moving, request)) ? move : null;
    const followsResult = pinned && result && sameManagedHome(home, result);
    const successor = pinned && stoppedByFollower.get(pinned);
    if (!matchesRequest(home, request) && !followsResult && !(successor && sameManagedHome(home, successor)))
      return refuse("home-changed");

    const committed: StoppedHome = home.state === "stopped" ? home :
      { ...home, state: "stopped", epoch: home.epoch + 1, updatedAt: clock.now() };
    const nextBinding: StopBinding = { action: "stop", request, committed };
    const record: SessionTransition = { action: "stop", operationId: request.operationId, expected: home,
      committed, mode: request.mode, displaced: [], observations: [], contactReason: null };

    if (home.state === "stopped") {
      const previous = store.current(home.sessionId);
      if (previous && previous.action !== "start" && sameManagedHome(home, previous.committed)) {
        const status = projectSessionStatus(home, previous, home.sessionId, clock.now());
        const upgrade = request.mode === "hard" && previous.mode === "graceful" && status.status !== "stopped";
        store.write(upgrade ? { ...previous, mode: "hard" } : previous, nextBinding);
      } else {
        store.write(record, nextBinding);
      }
    } else {
      const swap = await homes.compareAndSwap(home, committed, undefined, () => store.write(record, nextBinding));
      // An already-applied row without this binding was not committed by this operation.
      if (swap.kind !== "applied") return { kind: "refused", reply: reply(request, "refused", "home-changed", swap.home) };
      if (pinned && followsResult) stoppedByFollower.set(pinned, committed);
    }
    return { kind: "committed", home: committed };
  }

  function hasBlocker(home: StoppedHome): boolean {
    const record = store.current(home.sessionId);
    if (!record || record.action === "start" || !sameManagedHome(record.committed, home)) return false;
    return record.contactReason !== null || record.observations.some(observation =>
      observation.evidence.kind === "pending" &&
      (!sameManagedHome(observation.home, home) || observation.evidence.blockers.length > 0));
  }

  async function settle(admission: Admission, flight: Flight): Promise<SessionOutcome> {
    const { request } = flight;
    if (admission.kind === "refused") return admission.reply;
    const { home } = admission;
    const read = async () => {
      const current = await homes.read(request.sessionId);
      return sameManagedHome(current, home) ? committedStatus(request, home) : reply(request, "refused", "home-superseded", current);
    };
    const beforeRead = flight.snapshot;
    let last: SessionOutcome | undefined;
    flight.snapshot = async () => {
      // The home can change without a Stop record write, for example after a move.
      if (last?.outcome === "refused") return last;
      try { return await read(); }
      catch { return last ?? beforeRead(); }
    };
    last = await read();
    if (last.outcome !== "pending" || !ports.enabled() || closing) return last;
    // Admission released both the FIFO turn and process lock. Contact must fence its own effects.
    const contact = async () => {
      try { await ports.reconcile(home); }
      catch { /* Contact failure cannot undo the saved Stop. */ }
    };
    let expired = false, roundEnded = false;
    let wake!: () => void;
    const nextChange = () => new Promise<void>(resolve => { wake = resolve; });
    let change = nextChange();
    const changed = () => wake();
    const unsubscribe = ports.subscribe?.(home.sessionId, changed);
    const cancel = clock.later(ports.readyMs, () => { expired = true; changed(); });
    wakeOnClose.add(changed);
    void contact().then(() => { roundEnded = true; changed(); });
    try {
      while (!expired && !closing) {
        await change;
        change = nextChange();
        last = await read();
        if (last.outcome !== "pending" || hasBlocker(home) || !ports.enabled() || !unsubscribe && roundEnded) return last;
      }
      return last;
    } finally {
      cancel();
      unsubscribe?.();
      wakeOnClose.delete(changed);
    }
  }

  async function wait(flight: Flight): Promise<SessionOutcome> {
    const { request, move } = flight;
    if (move && operations.activeMove(request.sessionId) === move)
      return reply(request, "pending", "waiting-for-move", move.moving ?? move.source);
    let cancel!: () => void;
    const deadline = new Promise<SessionOutcome>(resolve => {
      cancel = clock.later(ports.readyMs, () => resolve(flight.snapshot()));
    });
    try { return await Promise.race([flight.done, deadline]); }
    finally { cancel(); }
  }

  async function stop(input: StopRequest): Promise<SessionOutcome> {
    if (closing) return reply(input, "refused", "hub-closing");
    const existing = flights.get(input.operationId);
    if (existing) return sameRequest(existing.request, input) ? wait(existing) : reply(input, "refused", "operation-reused");

    // Snapshot the input and take our position before any asynchronous lookup.
    const request = { ...input };
    const binding = store.operation(request.operationId);
    const move = binding ? null : operations.activeMove(request.sessionId);
    const admission = binding ? Promise.resolve(saved(request, binding)) :
      operations.enqueue(request.sessionId, () => ports.withSession(request.sessionId, () => commit(request, move)));
    const flight: Flight = { request, move,
      snapshot() {
        // The atomic binding can be visible before the CAS and lock release settle.
        try {
          const saved = store.operation(request.operationId);
          if (saved?.action === "stop" && sameRequest(saved.request, request)) return committedStatus(request, saved.committed);
        } catch { /* A failed cache read must not escape the deadline callback. */ }
        return reply(request, "pending", "waiting-for-session-operation");
      },
      done: admission.then(result => settle(result, flight)).finally(() => flights.delete(request.operationId)) };
    flights.set(request.operationId, flight);
    // The caller can receive a waiting reply before the accepted work settles.
    void flight.done.catch(() => {});
    return wait(flight);
  }

  return Object.assign(stop, { close() {
    if (!closing) {
      closing = Promise.allSettled([...flights.values()].map(flight => flight.done)).then(() => {});
      for (const wake of wakeOnClose) wake();
    }
    return closing;
  } });
}

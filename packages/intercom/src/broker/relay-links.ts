import { V0_INTERCOM_MS } from "../roam-v0.js";
import {
  RELAY_HOLD_MS, RELAY_MAX_LINKS, RELAY_MAX_SLOTS, RELAY_POLL_CALL_MS, RELAY_PROTOCOL_VERSION,
  relayReady, relayRefused, relayUnknown, type RelayLinkView, type RelayPoll, type RelayPollReply, type RelayReady,
  type RelayResult, type RelaySubmit,
} from "../relay-protocol.js";

const HAND_OFF_MS = 2000;
const LIVENESS_GRACE_MS = 10_000;
type Hold = RelayPoll["holdMs"];
type ReadyCode = Extract<RelayReady, { ok: false }>["code"];
type WaitFailure = "unreachable" | "relay-stopping";

export interface RelayClock { now(): number; later(ms: number, fn: () => void): () => void }
export interface RelayLinks {
  /** The broker supplies a writer so a call stays active until its socket reply finishes. */
  poll(poll: RelayPoll, signal?: AbortSignal, writeReply?: (reply: RelayPollReply) => Promise<void>): Promise<RelayPollReply>;
  /** The private client passes the budget remaining after its health check. */
  submit(relayId: string, submit: RelaySubmit, signal?: AbortSignal, remainingMs?: number): Promise<RelayResult>;
  list(): readonly RelayLinkView[];
  close(): void;
}

interface Pending {
  stage: { kind: "waiting"; submit: RelaySubmit; untilMs: number } | { kind: "handed" };
  deadlineMs: number;
  finish(result: RelayResult): void;
  fail(code: WaitFailure): void;
  arm(untilMs: number): void;
}
interface ActiveCall {
  pollId: string;
  wake: (() => void) | null;
  cancel(): void;
}
interface Link {
  view: RelayLinkView;
  toMachineId: string;
  calls: Map<Hold, ActiveCall>;
  // A null entry still owns a handed-off slot, but no text or local waiter.
  pending: Map<string, Pending | null>;
  grace: { untilMs: number; cancel(): void } | null;
}
interface KnownRelay {
  current: Link;
  retired: Map<string, number>;
}

export function createRelayLinks(clock: RelayClock, observe?: (view: RelayLinkView) => void): RelayLinks {
  const relays = new Map<string, KnownRelay>();
  let closed = false;

  function clearGrace(link: Link): void {
    link.grace?.cancel();
    link.grace = null;
  }
  function down(link: Link, error: string, sinceMs = clock.now(), failure: WaitFailure = "unreachable"): void {
    if (link.view.state === "down") return;
    link.view = { ...link.view, state: "down", sinceMs, lastError: error };
    clearGrace(link);
    for (const call of link.calls.values()) call.cancel();
    for (const pending of link.pending.values()) pending?.fail(failure);
    link.pending.clear();
    observe?.(link.view);
  }
  function refresh(link: Link): void {
    if (link.grace && clock.now() >= link.grace.untilMs) down(link, "poll-expired", link.grace.untilMs);
  }
  function startGrace(link: Link): void {
    const untilMs = clock.now() + LIVENESS_GRACE_MS;
    link.grace = { untilMs, cancel: clock.later(LIVENESS_GRACE_MS, () => down(link, "poll-expired", untilMs)) };
  }
  function expire(pending: Pending, now: number): boolean {
    const until = pending.stage.kind === "waiting" ? pending.stage.untilMs : pending.deadlineMs;
    if (now < until) return false;
    pending.fail("unreachable");
    return true;
  }
  function claim(link: Link): RelaySubmit[] {
    const now = clock.now();
    const submissions: RelaySubmit[] = [];
    for (const pending of link.pending.values()) {
      if (pending?.stage.kind !== "waiting" || expire(pending, now)) continue;
      submissions.push(pending.stage.submit);
      pending.stage = { kind: "handed" };
      pending.arm(pending.deadlineMs);
    }
    return submissions;
  }

  function poll(poll: RelayPoll, signal?: AbortSignal, writeReply?: (reply: RelayPollReply) => Promise<void>): Promise<RelayPollReply> {
    const { hello, reach, holdMs, results } = poll;
    const refused = (code: ReadyCode): RelayPollReply => ({ ready: relayReady(hello, code), submissions: [] });
    async function refuse(code: ReadyCode): Promise<RelayPollReply> {
      const reply = refused(code);
      if (!signal?.aborted) await writeReply?.(reply);
      return reply;
    }
    if (closed || signal?.aborted) return refuse("unreachable");
    if (hello.version !== RELAY_PROTOCOL_VERSION) return refuse("version-mismatch");

    const relayId = hello.relay.machineId;
    let known = relays.get(relayId);
    if (known) refresh(known.current);
    const now = clock.now();
    if (!known || known.current.view.linkId !== hello.linkId) {
      // A new generation cannot have a result to send yet. Also fence IDs of
      // old calls that could still arrive within their transport budget.
      if (results.length) return refuse("unreachable");
      if (known) {
        for (const [id, untilMs] of known.retired) if (now >= untilMs) known.retired.delete(id);
        if (known.retired.has(hello.linkId)) return refuse("unreachable");
        known.retired.set(known.current.view.linkId, now + RELAY_POLL_CALL_MS);
        down(known.current, "link-replaced");
      } else if (relays.size >= RELAY_MAX_LINKS) return refuse("relay-busy");
      const link: Link = {
        view: { relay: hello.relay, reach: reach.peers, linkId: hello.linkId, state: "up", sinceMs: now,
          lastCallMs: null, lastError: null, messagesCarried: known?.current.view.messagesCarried ?? 0 },
        toMachineId: hello.toMachineId, calls: new Map(), pending: new Map(), grace: null,
      };
      known = { current: link, retired: known?.retired ?? new Map() };
      relays.set(relayId, known);
    }

    const link = known.current;
    if (link.view.state === "down" || link.toMachineId !== hello.toMachineId) return refuse("unreachable");
    if (link.calls.has(holdMs) || [...link.calls.values()].some(call => call.pollId === hello.pollId)) return refuse("relay-busy");
    clearGrace(link);

    return new Promise(resolve => {
      let cancelHold = () => {};
      const finish = (reply: RelayPollReply, normal: boolean) => {
        cancelHold();
        signal?.removeEventListener("abort", abort);
        link.calls.delete(holdMs);
        if (normal && link.calls.size === 0) startGrace(link);
        resolve(reply);
      };
      const abort = () => down(link, "poll-closed");
      const call: ActiveCall = { pollId: hello.pollId, wake: null, cancel: () => finish(refused("unreachable"), false) };
      const reply = (submissions: readonly RelaySubmit[]) => {
        call.wake = null;
        cancelHold();
        const value = { ready: relayReady(hello), submissions };
        const completed = () => {
          if (link.calls.get(holdMs) === call) finish(value, true);
        };
        if (!writeReply) { completed(); return; }
        try { void writeReply(value).then(completed, () => { if (link.calls.get(holdMs) === call) abort(); }); }
        catch { abort(); }
      };
      link.calls.set(holdMs, call);
      signal?.addEventListener("abort", abort, { once: true });

      let carried = 0;
      for (const result of results) {
        const pending = link.pending.get(result.messageId);
        if (pending === undefined || pending?.stage.kind === "waiting") continue;
        if (pending && !expire(pending, now)) {
          pending.finish(result);
          if (result.outcome.kind === "socket_delivered") carried++;
        }
        link.pending.delete(result.messageId);
      }
      link.view = { ...link.view, relay: hello.relay, reach: reach.peers, lastCallMs: now,
        messagesCarried: link.view.messagesCarried + carried };
      observe?.(link.view);
      if (link.calls.get(holdMs) !== call) return;

      const submissions = claim(link);
      if (holdMs === 0 || submissions.length > 0) { reply(submissions); return; }
      const holdUntilMs = now + holdMs;
      call.wake = () => {
        if (clock.now() >= holdUntilMs) { reply([]); return; }
        const submissions = claim(link);
        if (submissions.length > 0) reply(submissions);
      };
      cancelHold = clock.later(Math.max(0, holdUntilMs - clock.now()), () => reply([]));
    });
  }

  function submit(relayId: string, submit: RelaySubmit, signal?: AbortSignal, remainingMs = V0_INTERCOM_MS): Promise<RelayResult> {
    const { id } = submit.message;
    if (closed) return Promise.resolve(relayRefused(id, "relay-stopping"));
    const link = relays.get(relayId)?.current;
    if (link) refresh(link);
    if (!link || link.view.state !== "up" || signal?.aborted || remainingMs <= 0)
      return Promise.resolve(relayRefused(id, "unreachable"));
    const now = clock.now();
    for (const pending of link.pending.values()) if (pending) expire(pending, now);
    if (link.pending.has(id)) return Promise.resolve(relayRefused(id, "invalid"));
    if (link.pending.size >= RELAY_MAX_SLOTS) return Promise.resolve(relayRefused(id, "relay-busy"));

    return new Promise(resolve => {
      let cancelTimer = () => {};
      const deadlineMs = now + Math.min(remainingMs, V0_INTERCOM_MS);
      const untilMs = Math.min(now + HAND_OFF_MS, deadlineMs);
      const abort = () => pending.fail("unreachable");
      const pending: Pending = {
        stage: { kind: "waiting", submit, untilMs }, deadlineMs,
        finish(result) {
          cancelTimer();
          signal?.removeEventListener("abort", abort);
          resolve(result);
        },
        fail(code) {
          if (pending.stage.kind === "waiting") {
            link.pending.delete(id);
            pending.finish(relayRefused(id, code));
          } else {
            link.pending.set(id, null);
            pending.finish(relayUnknown(id));
          }
        },
        arm(until) {
          cancelTimer();
          cancelTimer = clock.later(Math.max(0, until - clock.now()), () => pending.fail("unreachable"));
        },
      };
      link.pending.set(id, pending);
      signal?.addEventListener("abort", abort, { once: true });
      pending.arm(untilMs);
      link.calls.get(RELAY_HOLD_MS)?.wake?.();
    });
  }

  return {
    poll, submit,
    list() {
      for (const { current } of relays.values()) refresh(current);
      return [...relays.values()].map(({ current }) => current.view);
    },
    close() {
      closed = true;
      for (const { current } of relays.values()) down(current, "relay-stopping", clock.now(), "relay-stopping");
    },
  };
}

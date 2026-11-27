import { randomUUID } from "node:crypto";
import { pollV0RelayBroker } from "@spider/intercom/broker/roam-relay-client";
import {
  RELAY_HOLD_MS, RELAY_MAX_SLOTS, RELAY_POLL_CALL_MS, RELAY_POLL_MAX_BYTES, RELAY_POLL_REMOTE_MS, RELAY_PROTOCOL_VERSION,
  correlatesRelayReady, decodeRelayPoll, decodeRelayPollReply, encodeRelayPoll, encodeRelayPollReply, isRelayResult,
  relayReady, relayRefused, relayUnknown, type RelayLinkView, type RelayPeer, type RelayPoll, type RelayReady, type RelayResult, type RelaySubmit,
} from "@spider/intercom/relay-protocol";
import type { Clock, Peer, Transport } from "../contracts";
import { readLocalIdentity } from "../runtime";
import { readV0Routes } from "./intercom-routes";

export async function runV0LinkOnce(root: string, input: Buffer, holdMs: RelayPoll["holdMs"], signal?: AbortSignal): Promise<Buffer> {
  const poll = decodeRelayPoll(input, holdMs);
  const { hello } = poll;
  const refuse = (code: Extract<RelayReady, { ok: false }>["code"]) =>
    encodeRelayPollReply({ ready: relayReady(hello, code), submissions: [] });
  let routes: ReturnType<typeof readV0Routes>;
  try {
    const config = readLocalIdentity(root);
    if (hello.toMachineId !== config.machineId) return refuse("unauthorized");
    routes = readV0Routes(root, config);
  } catch { return refuse("invalid-config"); }
  if (!routes.relays.includes(hello.relay.machineId)) return refuse("unauthorized");
  if (hello.version !== RELAY_PROTOCOL_VERSION) return refuse("version-mismatch");
  return encodeRelayPollReply(await pollV0RelayBroker(routes.agentDir, poll, signal));
}

export interface RelayPollLoopOptions {
  relay: RelayPeer;
  peer: Peer;
  transport: Pick<Transport, "resolve" | "exec">;
  clock: Clock;
  signal: AbortSignal;
  reach(): readonly RelayPeer[];
  forward(submit: RelaySubmit, signal: AbortSignal): Promise<RelayResult>;
  observe(view: RelayLinkView): void;
}

class PollFailure extends Error {}

function wait(clock: Clock, ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise(resolve => {
    const finish = () => { cancel(); signal.removeEventListener("abort", finish); resolve(); };
    const cancel = clock.later(ms, finish);
    signal.addEventListener("abort", finish, { once: true });
  });
}

/** A generation owns both exec lanes and all the deliveries they take. */
export async function runRelayPollLoop(options: RelayPollLoopOptions): Promise<void> {
  const { relay, peer, transport, clock, signal, reach, forward, observe } = options;
  const linkedPeer: RelayPeer = { machineId: peer.machineId, alias: peer.alias };
  let view: RelayLinkView = { relay: linkedPeer, reach: [], linkId: "", state: "connecting", sinceMs: clock.now(),
    lastCallMs: null, lastError: null, messagesCarried: 0 };
  let backoffMs = 1000;
  const update = (patch: Partial<RelayLinkView>) => {
    view = { ...view, ...patch };
    observe(view);
  };

  while (!signal.aborted) {
    const linkId = randomUUID(), generation = new AbortController();
    const active = generation.signal;
    // null means delivery is running; a result waits here only until a
    // hold-0 call owns it. The call itself can carry at most 16 results.
    const slots = new Map<string, RelayResult | null>();
    const deliveries = new Set<Promise<void>>();
    let wakeResults: (() => void) | undefined;
    let workers: Promise<void>[] = [];
    update({ linkId, state: "connecting", sinceMs: clock.now() });

    function fail(code: string): void {
      if (active.aborted) return;
      generation.abort();
      wakeResults?.();
      update({ state: "down", sinceMs: clock.now(), lastError: code });
    }
    const stop = () => fail("relay-stopping");
    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) stop();

    async function deliver(submission: RelaySubmit): Promise<void> {
      const { id } = submission.message;
      let result: RelayResult;
      if (submission.from.machineId !== peer.machineId) result = relayRefused(id, "unauthorized");
      else {
        try {
          const forwarded = await forward(submission, active);
          result = isRelayResult(forwarded) && forwarded.messageId === id ? forwarded : relayUnknown(id);
        } catch { result = relayUnknown(id); }
      }
      if (active.aborted) return;
      slots.set(id, result);
      wakeResults?.();
    }

    async function call(resolved: Peer, holdMs: RelayPoll["holdMs"], results: readonly RelayResult[]): Promise<void> {
      try {
        const poll: RelayPoll = { holdMs, hello: { type: "hello", version: RELAY_PROTOCOL_VERSION, relay,
          toMachineId: peer.machineId, linkId, pollId: randomUUID() }, reach: { type: "reach", peers: reach() }, results };
        const stdin = encodeRelayPoll(poll);
        update({ lastCallMs: clock.now(), reach: poll.reach.peers });
        if (active.aborted) return;
        const bytes = await transport.exec(resolved, ["roam", "agent", "--v0", "link", "--hold-ms", String(holdMs)], {
          stdin, signal: active, timeoutMs: RELAY_POLL_CALL_MS, postReserveMs: 2000,
          remoteTimeoutMs: RELAY_POLL_REMOTE_MS, maxBytes: RELAY_POLL_MAX_BYTES,
        });
        if (active.aborted) return;
        let reply: ReturnType<typeof decodeRelayPollReply>;
        try { reply = decodeRelayPollReply(bytes); } catch { throw new PollFailure("protocol-error"); }
        const { ready, submissions } = reply;
        if (!correlatesRelayReady(ready, poll.hello)) throw new PollFailure("protocol-error");
        if (ready.version !== RELAY_PROTOCOL_VERSION || !ready.ok && ready.code === "version-mismatch") {
          throw new PollFailure(`version-mismatch (local ${RELAY_PROTOCOL_VERSION}, peer ${ready.version})`);
        }
        if (!ready.ok) throw new PollFailure(ready.code);
        if (slots.size + submissions.length > RELAY_MAX_SLOTS || submissions.some(s => slots.has(s.message.id)))
          throw new PollFailure("protocol-error");
        backoffMs = 1000;
        update({ state: "up", sinceMs: view.state === "up" ? view.sinceMs : clock.now(), lastError: null,
          messagesCarried: view.messagesCarried + results.filter(result => result.outcome.kind === "socket_delivered").length });
        for (const submission of submissions) {
          if (active.aborted) break;
          slots.set(submission.message.id, null);
          const delivery = deliver(submission);
          deliveries.add(delivery);
          void delivery.then(() => deliveries.delete(delivery));
        }
      } catch (error) {
        fail(error instanceof PollFailure ? error.message : "unreachable");
      }
    }

    async function heldCalls(resolved: Peer): Promise<void> {
      while (!active.aborted) await call(resolved, RELAY_HOLD_MS, []);
    }
    async function resultCalls(resolved: Peer): Promise<void> {
      while (!active.aborted) {
        const results: RelayResult[] = [];
        for (const [id, result] of slots) {
          if (!result) continue;
          results.push(result);
          // The broker can free these slots before this call's reply arrives.
          slots.delete(id);
        }
        if (results.length) await call(resolved, 0, results);
        else {
          await new Promise<void>(resolve => { wakeResults = resolve; });
          wakeResults = undefined;
        }
      }
    }

    try {
      if (!active.aborted) {
        const resolved = await transport.resolve(peer, { signal: active, timeoutMs: RELAY_POLL_CALL_MS });
        if (resolved.machineId !== peer.machineId) throw new PollFailure("unauthorized");
        if (!active.aborted) {
          workers = [heldCalls(resolved), resultCalls(resolved)];
          await Promise.all(workers);
        }
      }
    } catch (error) { fail(error instanceof PollFailure ? error.message : "unreachable"); }
    finally {
      generation.abort();
      wakeResults?.();
      await Promise.allSettled([...workers, ...deliveries]);
      signal.removeEventListener("abort", stop);
    }
    if (signal.aborted) break;
    await wait(clock, backoffMs, signal);
    backoffMs = Math.min(backoffMs * 2, 30_000);
  }
}

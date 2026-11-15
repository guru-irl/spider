import { withHopRequest } from "./intercom-hop-fixture";
import { withHopExchange } from "./intercom-hop-fixture";
import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { paths } from "@spider/db-core";
import type { RemoteSessionInfo } from "@spider/intercom/protocol";
import { createIntercomBridge } from "../intercom-bridge";
import type { IntercomExchange } from "../intercom-contracts";
import { makeMessageFrame } from "../intercom-codec";
import { openIntercomStore } from "../intercom-store";

const A = "00000000-0000-4000-8000-000000000001", B = "00000000-0000-4000-8000-000000000002";
const from = { sessionId: "sender", scopeId: "scope" }, to = { sessionId: "recipient", scopeId: "scope" };
const destination: RemoteSessionInfo = { remote: true, id: from.sessionId, address: from, machineId: A, machineAlias: "source.invalid", homeEpoch: 1,
  activationEpoch: "source-process", endpointEpoch: "source-process", cwd: "/fixture", model: "fixture", startedAt: 1, lastActivity: 1 };
const endpoint = { address: from, machineId: A, homeEpoch: 1, activationEpoch: "source-process" };
const roots: string[] = [], cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
async function fixture() {
  const root = mkdtempSync(join(paths.scratch("worktree", process.cwd()), "responder-")); roots.push(root);
  let now = 1_000_000, serial = 0, calls = 0;
  const timers = new Map<number, { at: number; fn(): void }>();
  const clock = { now: () => now, later: (ms: number, fn: () => void) => { const id = ++serial; timers.set(id, { at: now + ms, fn }); return () => { timers.delete(id); }; } };
  const store = openIntercomStore({ file: join(root, "queue.db"), machineId: B, clock });
  const failures: unknown[] = [], expiries: unknown[] = [], arrivals: unknown[] = [], down: unknown[] = [];
  const bridge = createIntercomBridge({ machineId: B, machineAlias: "target.invalid", store, clock, localPresence: () => [], authoritativeHome: address => ({ sessionId: address.sessionId, machineId: address.sessionId === from.sessionId ? A : B, epoch: 1, moveId: null, updatedAt: 1 }),
    edges: [{ edgeEpoch: "edge-1", initiator: false, peer: { machineId: A, alias: "source.invalid", node: "/fixture/node", pi: "/fixture/pi", cli: "/fixture/cli", core: "/fixture/hc", globalRoot: "/fixture/global" } }],
    transport: { resolve: async () => { calls++; throw new Error("no reverse route by design"); }, exec: async () => { calls++; throw new Error("unexpected reverse call"); } } as never,
    onAskFailed: value => failures.push(value), onExpiry: value => expiries.push(value), onInbound: value => arrivals.push(value), onLinkDown: (...value) => down.push(value) });
  await bridge.start(); cleanup.push(async () => { await bridge.stop(); store.close(); });
  const flush = async () => { for (let i = 0; i < 50; i++) await Promise.resolve(); };
  const advance = async (ms: number) => {
    const until = now + ms;
    for (;;) {
      const next = [...timers.entries()].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      now = next[1].at; timers.delete(next[0]); next[1].fn(); await flush();
    }
    now = until; await flush();
  };
  const exchange = (generation: number, holdMs = 0, frames: IntercomExchange["frames"] = []) => bridge.exchange(withHopRequest({ version: 1, holdMs, deadlineMs: 30_000,
    exchange: withHopExchange({ protocol: 5, senderMachine: A, recipientMachine: B, generation: { edgeEpoch: "edge-1", channel: "poll", generation },
      frames, acknowledgements: [], receipts: [], controls: [], presence: [destination] }) }));
  const ask = (id = "reverse-ask", remainingMs = 180_000) => bridge.dispatch({ from: to, to: destination,
    message: { id, timestamp: 1, expectsReply: true, remainingMs, content: { text: "synthetic reverse question" } } });
  return { bridge, store, clock, timers, exchange, ask, flush, advance, failures, expiries, arrivals, down, calls: () => calls };
}
it.each([true, false])("delivers a reverse ask and reply promptly with a held poll=%s, live health, and zero reverse calls", async held => {
  const f = await fixture();
  let waiting = held ? f.exchange(1, 25_000) : undefined;
  if (!held) await f.exchange(1);
  if (held) expect([...f.timers.values()].some(timer => timer.at === f.clock.now() + 25_000)).toBe(true);
  const begun = f.clock.now();
  expect(await f.ask()).toMatchObject({ delivery: "queued", acceptance: { accepted: true, durable: true } });
  await f.flush();
  expect(f.calls()).toBe(0);
  expect(f.store.edgeState(A, "edge-1").status).toBe("live");
  waiting ??= f.exchange(2, 25_000);
  const response = await waiting;
  expect(response.exchange.frames.map(frame => frame.identity.id)).toEqual(["reverse-ask"]);
  expect(f.clock.now() - begun).toBeLessThan(25);
  const replyEndpoint = { address: to, machineId: B, homeEpoch: 1, activationEpoch: "target-process" };
  const reply = makeMessageFrame({ from, endpoint: replyEndpoint, originMachineId: A, sequence: 1,
    message: { id: "reverse-answer", timestamp: 2, replyTo: "reverse-ask", content: { text: "synthetic answer" } } });
  await f.exchange(3, 0, [reply]); await f.flush();
  expect(f.arrivals).toEqual([{ id: "reverse-answer", to }]);
  expect(f.clock.now() - begun).toBeLessThan(25);
  expect(f.store.edgeState(A, "edge-1").status).toBe("live");
  expect(f.calls()).toBe(0);
}, 5000);
it("keeps a quiet responder queue with one diagnostic when polls stop, and fails its ask link-down at the deadline", async () => {
  const f = await fixture(); await f.exchange(1);
  expect(await f.ask("lost-poll-ask", 40_000)).toMatchObject({ delivery: "queued" });
  expect(await f.bridge.dispatch({ from: to, to: destination, message: { id: "quiet-mail", timestamp: 1, content: { text: "synthetic" } } })).toMatchObject({ delivery: "queued" });
  await f.advance(35_000);
  expect(f.store.edgeState(A, "edge-1").status).toBe("down");
  expect(f.bridge.diagnostics()).toHaveLength(1);
  expect(f.failures).toEqual([]);
  await f.advance(5000);
  expect(f.failures).toEqual([{ peer: A, id: "lost-poll-ask", from: to, to: from, reason: "link-down", outcomeKnown: false }]);
  expect(f.expiries).toEqual([]);
  expect(f.store.retained("outbound", "lost-poll-ask")).toMatchObject({ state: "expired", payloadRetained: false });
  await f.advance(300_000);
  expect(f.store.retained("outbound", "quiet-mail")).toMatchObject({ state: "queued", payloadRetained: true, endpoint });
  expect(f.bridge.diagnostics()).toHaveLength(1);
  expect(f.down).toHaveLength(1);
  expect(f.failures).toHaveLength(1);
  expect(f.calls()).toBe(0);
  await f.exchange(2);
  expect(f.store.edgeState(A, "edge-1").status).toBe("live");
  expect(f.bridge.diagnostics()).toEqual([]);
}, 5000);

import { paths } from "@spider/db-core";
import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { openIntercomStore } from "../intercom-store";
import type { RemoteSessionInfo } from "@spider/intercom/protocol";

const A = "00000000-0000-4000-8000-000000000001", B = "00000000-0000-4000-8000-000000000002";
const from = { sessionId: "sender", scopeId: "scope" }, to = { sessionId: "recipient", scopeId: "scope" };
const endpoint = { address: to, machineId: B, homeEpoch: 1, activationEpoch: "activation-1" };
const peer = { machineId: B, alias: "box-1.invalid", node: "/fixture/node", pi: "/fixture/pi", cli: "/fixture/cli", core: "/fixture/hc", globalRoot: "/fixture/global" };
const remote: RemoteSessionInfo = { remote: true, id: to.sessionId, address: to, machineId: B, machineAlias: "box-1.invalid", homeEpoch: 1,
  activationEpoch: "activation-1", endpointEpoch: "activation-1", name: "helper", cwd: "/fixture", model: "fixture", startedAt: 1, lastActivity: 1 };
const roots: string[] = [], stores: Array<{ close(): void }> = [], bridges: Array<{ stop(): Promise<void> }> = [];
afterEach(async () => { for (const bridge of bridges.splice(0)) await bridge.stop(); for (const store of stores.splice(0)) store.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
class FixtureClock {
  time = 1_000_000; private next = 0; tasks = new Map<number, { at: number; fn(): void }>();
  now = () => this.time;
  later = (ms: number, fn: () => void) => { const id = ++this.next; this.tasks.set(id, { at: this.time + ms, fn }); return () => { this.tasks.delete(id); }; };
  async advance(ms: number) {
    this.time += ms;
    for (const [id, task] of [...this.tasks].sort((a, b) => a[1].at - b[1].at)) if (task.at <= this.time && this.tasks.delete(id)) task.fn();
    await flush();
  }
}
async function flush() { for (let i = 0; i < 30; i++) await Promise.resolve(); }
async function fixture(options: { mode: "blocked" | "failure"; initiator?: boolean }) {
  const api = await vi.importActual("../intercom-bridge").catch(() => ({})) as { createIntercomBridge?: (ports: any) => any };
  expect(api.createIntercomBridge).toBeTypeOf("function");
  const root = mkdtempSync(join(paths.scratch("worktree", process.cwd()), "is-")); roots.push(root);
  const clock = new FixtureClock(), store = openIntercomStore({ file: join(root, "queue", "queue.db"), machineId: A, clock }); stores.push(store);
  let mode = options.mode, live = false, failureReason = "needs_login";
  const calls: any[] = [], downs: string[] = [], failedAsks: any[] = [], expirations: any[] = [], rosters: RemoteSessionInfo[][] = [];
  const transport = {
    resolve: async (target: unknown, resolveOptions: unknown) => { calls.push({ kind: "resolve", options: resolveOptions }); return target; },
    exec: async (_target: unknown, _argv: unknown, call: any) => {
      const input = JSON.parse(call.stdinForTimeout(call.remoteTimeoutMs).toString());
      calls.push({ kind: "exec", input, call }); call.onConnected?.(true);
      if (mode === "failure") throw Object.assign(new Error("synthetic confidential stderr"), { code: failureReason });
      if (live && input.exchange.generation.channel === "push") return Buffer.from(JSON.stringify({ version: 1, kind: "intercom-exchange", ok: true,
        value: { version: 1, exchange: { ...input.exchange, senderMachine: B, recipientMachine: A, frames: [], acknowledgements: [], receipts: [], controls: [], presence: [remote] } } }));
      return new Promise<Buffer>((_resolve, reject) => {
        if (call.signal.aborted) { reject(Object.assign(new Error("aborted"), { code: "cli-aborted" })); return; }
        call.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { code: "cli-aborted" })), { once: true });
      });
    },
  };
  const bridge = api.createIntercomBridge!({ machineId: A, machineAlias: "source.invalid", edges: [{ peer, edgeEpoch: "edge-1", initiator: options.initiator ?? true }],
    store, transport, clock, localPresence: () => [], authoritativeHome: () => null, onLinkDown: (_peer: string, reason: string) => downs.push(reason),
    onAskFailed: (value: any) => failedAsks.push(value), onExpiry: (value: any) => expirations.push(value), publishPresence: (entries: RemoteSessionInfo[]) => rosters.push(entries) });
  bridges.push(bridge);
  return { bridge, clock, store, transport, calls, downs, failedAsks, expirations, rosters, setMode(value: typeof mode) { mode = value; }, setLive(value: boolean) { live = value; }, setFailureReason(value: string) { failureReason = value; } };
}
const execs = (calls: any[]) => calls.filter(call => call.kind === "exec");

it("runs one poll and one push independently, with separately persisted generations", async () => {
  const f = await fixture({ mode: "blocked" }); await f.bridge.start(); await flush();
  expect(execs(f.calls).map(call => call.input.exchange.generation.channel)).toEqual(["poll"]);
  const result = await f.bridge.dispatch({ from, to: remote, message: { id: "queued", timestamp: 1, content: { text: "synthetic" } } });
  expect(result).toMatchObject({ delivery: "queued", acceptance: { durable: true } });
  await flush();
  expect(execs(f.calls).map(call => call.input.exchange.generation)).toEqual([
    { edgeEpoch: "edge-1", channel: "poll", generation: 1 }, { edgeEpoch: "edge-1", channel: "push", generation: 1 },
  ]);
  expect(execs(f.calls)[1].input.exchange.frames.map((frame: any) => frame.identity.id)).toEqual(["queued"]);
  await f.bridge.stop(); await flush();
  expect(f.clock.tasks.size).toBe(0);
}, 5000);

it("retries once after one second, preserves one outage, fails in-flight asks, and recovers", async () => {
  const f = await fixture({ mode: "failure" });
  f.store.updateEdgeState(B, "edge-1", state => ({ ...state, status: "live", lastSuccess: f.clock.now(), roster: [remote] }));
  f.store.acceptOutbound({ from, endpoint, nextHop: B, message: { id: "ask-1", timestamp: 1, expectsReply: true, remainingMs: 300_000, content: { text: "synthetic" } } });
  await f.bridge.start(); await flush();
  expect(f.store.edgeState(B, "edge-1").status).toBe("recovering");
  const outage = f.bridge.diagnostics(); expect(outage).toHaveLength(1); expect(outage[0].reason).toBe("needs_login");
  expect(f.rosters.at(-1)?.[0]).toMatchObject({ stale: true, reachability: "recovering" });
  const before = execs(f.calls).length;
  expect(await f.bridge.dispatch({ from, to: remote, message: { id: "ask-2", timestamp: 1, expectsReply: true, remainingMs: 10_000, content: { text: "synthetic" } } })).toMatchObject({ delivery: "failed", reason: "link-down" });
  expect(execs(f.calls)).toHaveLength(before);
  await f.clock.advance(999); expect(execs(f.calls)).toHaveLength(before);
  await f.clock.advance(1);
  expect(execs(f.calls)).toHaveLength(before + 1);
  expect(f.store.edgeState(B, "edge-1").status).toBe("down");
  expect(f.downs).toEqual(["needs_login"]);
  expect(f.failedAsks).toEqual([{ peer: B, id: "ask-1", from, to, reason: "link-down", outcomeKnown: false }]);
  expect(f.store.retained("outbound", "ask-1")).toMatchObject({ state: "queued", payloadRetained: true });
  expect(f.bridge.diagnostics()).toEqual([{ ...outage[0], status: "down" }]);
  await f.clock.advance(2000); expect(f.bridge.diagnostics()).toHaveLength(1); expect(f.downs).toHaveLength(1);
  f.setMode("blocked"); f.setLive(true);
  await f.clock.advance(4000);
  expect(f.store.edgeState(B, "edge-1").status).toBe("live");
  expect(f.bridge.diagnostics()).toEqual([]);
  expect(f.rosters.at(-1)?.[0]).toMatchObject({ stale: false, reachability: "live" });
}, 5000);


it("probes an unknown route, retries once, and deducts the original ask budget", async () => {
  const f = await fixture({ mode: "failure", initiator: false }); await f.bridge.start();
  const pending = f.bridge.dispatch({ from, to: remote, message: { id: "unknown-ask", timestamp: 1, expectsReply: true, remainingMs: 30_000, content: { text: "synthetic" } } });
  await flush();
  expect(execs(f.calls)).toHaveLength(1);
  expect(execs(f.calls)[0].call.timeoutMs).toBeLessThanOrEqual(10_000);
  f.setMode("blocked"); f.setLive(true); await f.clock.advance(1000);
  expect(await pending).toMatchObject({ delivery: "queued", acceptance: { durable: true } });
  expect(execs(f.calls).filter(call => call.input.exchange.frames.some((frame: any) => frame.identity.id === "unknown-ask"))[0]
    .input.exchange.frames[0].message.remainingMs).toBe(4000);
}, 5000);

it("does not start a second ask probe after the original deadline expires", async () => {
  const f = await fixture({ mode: "failure", initiator: false }); await f.bridge.start();
  const pending = f.bridge.dispatch({ from, to: remote, message: { id: "short-ask", timestamp: 1, expectsReply: true, remainingMs: 500, content: { text: "synthetic" } } });
  await flush(); await f.clock.advance(500);
  expect(await pending).toMatchObject({ delivery: "failed" });
  expect(f.store.retained("outbound", "short-ask")).toBeNull();
  const count = execs(f.calls).length;
  expect(count).toBeLessThanOrEqual(1);
}, 5000);


it("expires an ask when the full 20-second push bracket plus allowance exceeds its remaining duration", async () => {
  const f = await fixture({ mode: "blocked" });
  f.store.acceptOutbound({ from, endpoint, nextHop: B, message: { id: "short-push", timestamp: 1, expectsReply: true, remainingMs: 24_000, content: { text: "synthetic" } } });
  await f.bridge.start(); await flush();
  const push = execs(f.calls).find(call => call.input.exchange.generation.channel === "push");
  expect(push.input.exchange.frames[0]).toMatchObject({ kind: "tombstone", reason: "expired", identity: { id: "short-push" } });
  expect(f.store.retained("outbound", "short-push")).toMatchObject({ state: "expired", payloadRetained: false });
}, 5000);


it("does not charge or send one queued ask in both concurrent channels", async () => {
  const f = await fixture({ mode: "blocked" });
  f.store.acceptOutbound({ from, endpoint, nextHop: B, message: { id: "one-handoff", timestamp: 1, expectsReply: true, remainingMs: 300_000, content: { text: "synthetic" } } });
  await f.bridge.start(); await flush();
  const copies = execs(f.calls).flatMap(call => call.input.exchange.frames.filter((frame: any) => frame.identity.id === "one-handoff"));
  expect(copies).toHaveLength(1);
  expect(copies[0].message.remainingMs).toBe(275_000);
}, 5000);


it("does not charge a poll handoff again while starting a concurrent push", async () => {
  const f = await fixture({ mode: "blocked", initiator: false }); await f.bridge.start();
  f.store.acceptOutbound({ from, endpoint, nextHop: B, message: { id: "poll-handoff", timestamp: 1, expectsReply: true, remainingMs: 300_000, content: { text: "synthetic" } } });
  const pull = { protocol: 1, senderMachine: B, recipientMachine: A, generation: { edgeEpoch: "edge-1", channel: "poll", generation: 1 },
    frames: [], acknowledgements: [], receipts: [], controls: [], presence: [] };
  const reply = await f.bridge.exchange({ version: 1, exchange: pull, holdMs: 0, deadlineMs: 5000 });
  expect(reply.exchange.frames.map((frame: any) => frame.identity.id)).toEqual(["poll-handoff"]);
  f.bridge.wake(B); await flush();
  expect(execs(f.calls)[0].input.exchange.frames).toEqual([]);
}, 5000);


it("coalesces concurrent failures into the 1, 2, 4, 8, 15, 30 second retry sequence", async () => {
  const f = await fixture({ mode: "failure" });
  f.store.acceptOutbound({ from, endpoint, nextHop: B, message: { id: "queued", timestamp: 1, content: { text: "synthetic" } } });
  await f.bridge.start(); await flush();
  const delay = () => Math.min(...[...f.clock.tasks.values()].map(task => task.at)) - f.clock.now();
  for (const expected of [1000, 2000, 4000, 8000, 15_000, 30_000, 30_000]) {
    expect(f.clock.tasks.size).toBe(2); expect(delay()).toBe(expected); await f.clock.advance(expected);
  }
  expect(f.bridge.diagnostics()).toHaveLength(1);
  expect(f.store.retained("outbound", "queued")).toMatchObject({ payloadRetained: true });
}, 5000);


it("retains peer names, queued mail, and one diagnostic over ten minutes and service restart", async () => {
  const f = await fixture({ mode: "failure" });
  f.store.updateEdgeState(B, "edge-1", state => ({ ...state, status: "live", lastSuccess: f.clock.now(), roster: [remote] }));
  f.store.acceptOutbound({ from, endpoint, nextHop: B, message: { id: "long-outage", timestamp: 1, content: { text: "synthetic" } } });
  await f.bridge.start(); await flush();
  const since = f.clock.now(), first = f.bridge.diagnostics()[0];
  while (f.clock.now() - since < 600_000) {
    const next = Math.min(...[...f.clock.tasks.values()].map(task => task.at));
    expect(Number.isFinite(next)).toBe(true); await f.clock.advance(next - f.clock.now());
  }
  expect(f.bridge.diagnostics()).toEqual([{ ...first, status: "down" }]);
  expect(f.rosters.at(-1)?.[0]).toMatchObject({ name: "helper", machineAlias: "box-1.invalid", stale: true, reachability: "down" });
  expect(f.store.retained("outbound", "long-outage")).toMatchObject({ payloadRetained: true });
  await f.bridge.stop();
  const api = await vi.importActual("../intercom-bridge") as { createIntercomBridge: (ports: any) => any };
  const restarted = api.createIntercomBridge({ machineId: A, machineAlias: "source.invalid", edges: [{ peer, edgeEpoch: "edge-1", initiator: true }],
    store: f.store, transport: f.transport, clock: f.clock, localPresence: () => [], authoritativeHome: () => null });
  bridges.push(restarted); await restarted.start();
  expect(restarted.diagnostics()).toEqual([{ ...first, status: "down" }]);
  expect(f.store.retained("outbound", "long-outage")).toMatchObject({ payloadRetained: true });
}, 5000);


it("keeps same-pair order while unrelated work uses the push channel", async () => {
  const f = await fixture({ mode: "blocked", initiator: false }); await f.bridge.start();
  f.store.acceptOutbound({ from, endpoint, nextHop: B, message: { id: "pair-1", timestamp: 1, content: { text: "synthetic" } } });
  const pull = { protocol: 1, senderMachine: B, recipientMachine: A, generation: { edgeEpoch: "edge-1", channel: "poll", generation: 1 },
    frames: [], acknowledgements: [], receipts: [], controls: [], presence: [] };
  const reply = await f.bridge.exchange({ version: 1, exchange: pull, holdMs: 0, deadlineMs: 5000 });
  expect(reply.exchange.frames.map((frame: any) => frame.identity.id)).toEqual(["pair-1"]);
  f.store.acceptOutbound({ from, endpoint, nextHop: B, message: { id: "pair-2", timestamp: 1, content: { text: "synthetic" } } });
  const other = { ...endpoint, address: { sessionId: "other", scopeId: "scope" } };
  f.store.acceptOutbound({ from, endpoint: other, nextHop: B, message: { id: "other-pair", timestamp: 1, content: { text: "synthetic" } } });
  f.bridge.wake(B); await flush();
  expect(execs(f.calls)[0].input.exchange.frames.map((frame: any) => frame.identity.id)).toEqual(["other-pair"]);
}, 5000);

it("expires stale payload during background probes without evicting its metadata", async () => {
  const f = await fixture({ mode: "failure" });
  f.store.acceptOutbound({ from, endpoint, nextHop: B, message: { id: "expires-down", timestamp: 1, content: { text: "synthetic" } } });
  await f.bridge.start(); await flush();
  await f.clock.advance(24 * 60 * 60 * 1000 + 1);
  expect(f.store.retained("outbound", "expires-down")).toMatchObject({ state: "expired", payloadRetained: false });
  expect(f.bridge.diagnostics()).toHaveLength(1);
}, 5000);


it("uses a 35-second successful-exchange lease, then probes rather than trusting stale presence", async () => {
  const recent = await fixture({ mode: "blocked", initiator: false });
  recent.store.updateEdgeState(B, "edge-1", state => ({ ...state, status: "live", lastSuccess: recent.clock.now() }));
  await recent.bridge.start(); await recent.clock.advance(34_999);
  expect(await recent.bridge.dispatch({ from, to: remote, message: { id: "live-lease", timestamp: 1, expectsReply: true, remainingMs: 300_000, content: { text: "synthetic" } } })).toMatchObject({ delivery: "queued" });
  await flush(); expect(execs(recent.calls)[0].call.remoteTimeoutMs).toBe(10_000);
  const stale = await fixture({ mode: "failure", initiator: false });
  stale.store.updateEdgeState(B, "edge-1", state => ({ ...state, status: "live", lastSuccess: stale.clock.now() - 35_000 }));
  await stale.bridge.start();
  const ask = stale.bridge.dispatch({ from, to: remote, message: { id: "stale-lease", timestamp: 1, expectsReply: true, remainingMs: 300_000, content: { text: "synthetic" } } });
  await flush(); expect(execs(stale.calls)[0].call.remoteTimeoutMs).toBe(5000);
  await stale.clock.advance(1000); expect(await ask).toMatchObject({ delivery: "failed", reason: "link-down" });
}, 5000);

it("reuses connected-poll evidence only until that poll's bounded local deadline", async () => {
  const live = await fixture({ mode: "blocked" }); await live.bridge.start(); await flush();
  await live.clock.advance(44_999);
  expect(await live.bridge.dispatch({ from, to: remote, message: { id: "poll-live", timestamp: 1, expectsReply: true, remainingMs: 300_000, content: { text: "synthetic" } } })).toMatchObject({ delivery: "queued" });
  await flush(); expect(execs(live.calls).map(call => call.call.remoteTimeoutMs)).toEqual([30_000, 10_000]);
  const expired = await fixture({ mode: "blocked" }); await expired.bridge.start(); await flush(); await expired.clock.advance(45_000);
  const ask = expired.bridge.dispatch({ from, to: remote, message: { id: "poll-expired", timestamp: 1, expectsReply: true, remainingMs: 300_000, content: { text: "synthetic" } } });
  await flush(); expect(execs(expired.calls).map(call => call.call.remoteTimeoutMs)).toEqual([30_000, 5000]);
  await expired.bridge.stop(); expect(await ask).toMatchObject({ delivery: "failed" });
}, 5000);


it("marks cached roster entries stale when the last-success lease expires", async () => {
  const f = await fixture({ mode: "blocked", initiator: false });
  f.store.updateEdgeState(B, "edge-1", state => ({ ...state, status: "live", lastSuccess: f.clock.now(), roster: [remote] }));
  await f.bridge.start(); expect(f.rosters.at(-1)?.[0]).toMatchObject({ stale: false, reachability: "live" });
  await f.clock.advance(35_000);
  expect(f.rosters.at(-1)?.[0]).toMatchObject({ stale: true, reachability: "unknown" });
}, 5000);


it.each(["machine-mismatch", "endpoint-exited"])("proved %s fails active waits immediately without the one-second retry", async reason => {
  const f = await fixture({ mode: "failure" }); f.setFailureReason(reason);
  f.store.acceptOutbound({ from, endpoint, nextHop: B, message: { id: "live-ask", timestamp: 1, expectsReply: true, remainingMs: 300_000, content: { text: "synthetic" } } });
  await f.bridge.start(); await flush();
  expect(f.store.edgeState(B, "edge-1").status).toBe("down");
  expect(f.failedAsks).toHaveLength(1); expect(f.downs).toEqual([reason]);
  expect(f.clock.tasks.size).toBe(1);
  expect([...f.clock.tasks.values()][0].at - f.clock.now()).toBeGreaterThan(60_000);
  const attempts = execs(f.calls).length;
  await f.clock.advance(60_000); expect(execs(f.calls)).toHaveLength(attempts); expect(f.downs).toHaveLength(1);
  await f.bridge.stop();
  const api = await vi.importActual("../intercom-bridge") as { createIntercomBridge: (ports: any) => any };
  const restarted = api.createIntercomBridge({ machineId: A, machineAlias: "source.invalid", edges: [{ peer, edgeEpoch: "edge-1", initiator: true }],
    store: f.store, transport: f.transport, clock: f.clock, localPresence: () => [], authoritativeHome: () => null });
  bridges.push(restarted); await restarted.start(); await flush();
  expect(f.clock.tasks.size).toBe(1); expect(execs(f.calls)).toHaveLength(attempts);
  expect([...f.clock.tasks.values()][0].at - f.clock.now()).toBeGreaterThan(60_000);
  expect(restarted.diagnostics()).toMatchObject([{ reason, status: "down" }]);
}, 5000);


it("isolates a failed Mac edge while another box edge stays live", async () => {
  const api = await vi.importActual("../intercom-bridge") as { createIntercomBridge: (ports: any) => any };
  const root = mkdtempSync(join(paths.scratch("worktree", process.cwd()), "ie-")); roots.push(root);
  const c = "00000000-0000-4000-8000-000000000003", targetC = { ...peer, machineId: c, alias: "box-2.invalid" };
  const remoteC = { ...remote, id: "other-box", address: { sessionId: "other-box", scopeId: "scope" }, machineId: c, machineAlias: "box-2.invalid" };
  const clock = new FixtureClock(), store = openIntercomStore({ file: join(root, "queue", "queue.db"), machineId: A, clock }); stores.push(store);
  store.updateEdgeState(c, "edge-c", state => ({ ...state, status: "live", lastSuccess: clock.now(), roster: [remoteC] }));
  const downs: string[] = [];
  const transport = { resolve: async (target: unknown) => target, exec: async (target: any, _argv: unknown, call: any) => {
    call.onConnected?.(true);
    if (target.machineId === B) throw Object.assign(new Error("unavailable"), { code: "needs_login" });
    return new Promise<Buffer>((_resolve, reject) => call.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
  } };
  const bridge = api.createIntercomBridge({ machineId: A, machineAlias: "source.invalid", edges: [
    { peer, edgeEpoch: "edge-1", initiator: true }, { peer: targetC, edgeEpoch: "edge-c", initiator: true }],
    store, transport, clock, localPresence: () => [], authoritativeHome: () => null, onLinkDown: (machine: string) => downs.push(machine) });
  bridges.push(bridge); await bridge.start(); await flush(); await clock.advance(1000);
  expect(store.edgeState(B, "edge-1").status).toBe("down");
  expect(store.edgeState(c, "edge-c").status).toBe("live"); expect(downs).toEqual([B]);
  const result = await bridge.dispatch({ from, to: remoteC, message: { id: "unaffected", timestamp: 1, expectsReply: true, remainingMs: 300_000, content: { text: "synthetic" } } });
  expect(result).toMatchObject({ delivery: "queued", acceptance: { durable: true } });
  expect(store.retained("outbound", "unaffected")).toMatchObject({ peer: c, payloadRetained: true });
}, 5000);


it("reports source expiration during an extended outage without claiming remote non-delivery", async () => {
  const f = await fixture({ mode: "failure" });
  f.store.acceptOutbound({ from, endpoint, nextHop: B, message: { id: "expires-offline", timestamp: 1, content: { text: "synthetic private body" } } });
  await f.bridge.start(); await flush();
  await f.clock.advance(1000); await f.clock.advance(24 * 60 * 60 * 1000);
  expect(f.expirations).toEqual([{ peer: B, id: "expires-offline", from, to, outcomeKnown: false }]);
  expect(JSON.stringify(f.expirations)).not.toContain("synthetic private body");
  expect(f.store.retained("outbound", "expires-offline")).toMatchObject({ state: "expired", payloadRetained: false });
}, 5000);


it("wakes a held poll before its fake-clock deadline", async () => {
  const f = await fixture({ mode: "blocked", initiator: false }); await f.bridge.start();
  const input = { protocol: 1, senderMachine: B, recipientMachine: A, generation: { edgeEpoch: "edge-1", channel: "poll", generation: 1 },
    frames: [], acknowledgements: [], receipts: [], controls: [], presence: [] };
  let settled = false;
  const pending = f.bridge.exchange({ version: 1, exchange: input, holdMs: 200, deadlineMs: 5200 }).then((reply: any) => { settled = true; return reply; });
  try {
    f.store.acceptOutbound({ from, endpoint, nextHop: B, message: { id: "fake-wake", timestamp: 1, content: { text: "synthetic" } } });
    f.bridge.wake(B); await flush(); expect(settled).toBe(true);
    expect((await pending).exchange.frames.map((frame: any) => frame.identity.id)).toEqual(["fake-wake"]);
  } finally { await f.bridge.stop(); await pending.catch(() => {}); }
}, 5000);


it("uses two ten-second admission attempts with one retry and a 21-second cap", async () => {
  const f = await fixture({ mode: "blocked", initiator: false }), attempts: number[] = [];
  f.transport.exec = async (_target: unknown, _argv: unknown, call: any) => new Promise<Buffer>((_resolve, reject) => {
    attempts.push(call.timeoutMs);
    const cancel = f.clock.later(call.timeoutMs, () => reject(Object.assign(new Error("fixture timeout"), { code: "cli-timeout" })));
    call.signal.addEventListener("abort", () => { cancel(); reject(Object.assign(new Error("aborted"), { code: "cli-aborted" })); }, { once: true });
  });
  await f.bridge.start(); let settled = false;
  const pending = f.bridge.dispatch({ from, to: remote, message: { id: "long-probe", timestamp: 1, expectsReply: true, remainingMs: 60_000, content: { text: "synthetic" } } })
    .then((result: unknown) => { settled = true; return result; });
  try {
    await flush(); expect(attempts).toEqual([10_000]);
    await f.clock.advance(10_000); expect(settled).toBe(false);
    expect(await f.bridge.dispatch({ from, to: remote, message: { id: "another-ask", timestamp: 1, expectsReply: true, remainingMs: 60_000, content: { text: "synthetic" } } }))
      .toMatchObject({ delivery: "failed", reason: "link-down" });
    expect(attempts).toEqual([10_000]);
    await f.clock.advance(1000); expect(attempts).toEqual([10_000, 10_000]);
    await f.clock.advance(9999); expect(settled).toBe(false);
    await f.clock.advance(1); expect(await pending).toMatchObject({ delivery: "failed", reason: "link-down" });
    expect(f.store.retained("outbound", "long-probe")).toBeNull();
  } finally { await f.bridge.stop(); await pending.catch(() => {}); }
}, 5000);


it("shortens the retry to the original ask deadline instead of extending it", async () => {
  const f = await fixture({ mode: "blocked", initiator: false }), attempts: number[] = [];
  f.transport.exec = async (_target: unknown, _argv: unknown, call: any) => new Promise<Buffer>((_resolve, reject) => {
    attempts.push(call.timeoutMs);
    const cancel = f.clock.later(call.timeoutMs, () => reject(Object.assign(new Error("fixture timeout"), { code: "cli-timeout" })));
    call.signal.addEventListener("abort", () => { cancel(); reject(Object.assign(new Error("aborted"), { code: "cli-aborted" })); }, { once: true });
  });
  await f.bridge.start(); let settled = false;
  const pending = f.bridge.dispatch({ from, to: remote, message: { id: "bounded-probe", timestamp: 1, expectsReply: true, remainingMs: 16_000, content: { text: "synthetic" } } })
    .then((result: unknown) => { settled = true; return result; });
  try {
    await flush(); expect(attempts).toEqual([10_000]);
    await f.clock.advance(10_000); await f.clock.advance(1000);
    expect(attempts).toEqual([10_000, 5000]);
    await f.clock.advance(4999); expect(settled).toBe(false);
    await f.clock.advance(1); expect(await pending).toMatchObject({ delivery: "failed" });
    expect(f.store.retained("outbound", "bounded-probe")).toBeNull();
  } finally { await f.bridge.stop(); await pending.catch(() => {}); }
}, 5000);


it("a proved identity failure fences a concurrent late success", async () => {
  const f = await fixture({ mode: "blocked" });
  let failPoll!: (error: Error) => void, finishPush!: () => void;
  f.transport.exec = async (_target: unknown, _argv: unknown, call: any) => {
    const input = JSON.parse(call.stdinForTimeout(call.remoteTimeoutMs).toString());
    if (input.exchange.generation.channel === "poll") return new Promise<Buffer>((_resolve, reject) => { failPoll = reject; });
    return new Promise<Buffer>(resolve => { finishPush = () => resolve(Buffer.from(JSON.stringify({ version: 1, kind: "intercom-exchange", ok: true,
      value: { version: 1, exchange: { ...input.exchange, senderMachine: B, recipientMachine: A, frames: [],
        acknowledgements: input.exchange.frames.map((frame: any) => ({ identity: frame.identity, kind: frame.kind })), receipts: [], controls: [], presence: [remote] } } }))); });
  };
  try {
    await f.bridge.start(); await flush();
    expect(await f.bridge.dispatch({ from, to: remote, message: { id: "late-success", timestamp: 1, content: { text: "synthetic" } } })).toMatchObject({ delivery: "queued" });
    await flush(); expect(failPoll).toBeTypeOf("function"); expect(finishPush).toBeTypeOf("function");
    failPoll(Object.assign(new Error("wrong identity"), { code: "machine-mismatch" })); await flush();
    expect(f.store.edgeState(B, "edge-1").status).toBe("down");
    finishPush(); await flush();
    expect(f.store.edgeState(B, "edge-1").status).toBe("down");
    expect(f.store.retained("outbound", "late-success")).toMatchObject({ linkAcknowledged: false, payloadRetained: true });
    const incoming = { protocol: 1, senderMachine: B, recipientMachine: A, generation: { edgeEpoch: "edge-1", channel: "push", generation: 1 },
      frames: [], acknowledgements: [], receipts: [], controls: [], presence: [remote] };
    await expect(f.bridge.exchange({ version: 1, exchange: incoming, holdMs: 0, deadlineMs: 5000 })).rejects.toMatchObject({ code: "machine-mismatch" });
    expect(f.store.edgeState(B, "edge-1").status).toBe("down");
  } finally { finishPush?.(); await f.bridge.stop(); }
}, 5000);


it("a later proved mismatch replaces a transient reason and cancels its pending retry", async () => {
  const f = await fixture({ mode: "blocked" });
  let rejectPoll!: (error: Error) => void, rejectPush!: (error: Error) => void;
  f.transport.exec = async (_target: unknown, _argv: unknown, call: any) => {
    const input = JSON.parse(call.stdinForTimeout(call.remoteTimeoutMs).toString());
    return new Promise<Buffer>((_resolve, reject) => { if (input.exchange.generation.channel === "poll") rejectPoll = reject; else rejectPush = reject; });
  };
  try {
    await f.bridge.start(); await flush();
    await f.bridge.dispatch({ from, to: remote, message: { id: "mixed-failure", timestamp: 1, content: { text: "synthetic" } } }); await flush();
    rejectPoll(Object.assign(new Error("offline"), { code: "unavailable" })); await flush();
    expect(f.store.edgeState(B, "edge-1")).toMatchObject({ status: "recovering", reason: "unavailable" });
    rejectPush(Object.assign(new Error("wrong identity"), { code: "machine-mismatch" })); await flush();
    expect(f.store.edgeState(B, "edge-1")).toMatchObject({ status: "down", reason: "machine-mismatch" });
    expect(f.clock.tasks.size).toBe(1);
    expect([...f.clock.tasks.values()][0].at - f.clock.now()).toBeGreaterThan(60_000);
  } finally { rejectPoll?.(new Error("closed")); rejectPush?.(new Error("closed")); await f.bridge.stop(); }
}, 5000);


it("expires queued mail and reports it even when a fatal edge never retries", async () => {
  const f = await fixture({ mode: "failure", initiator: false }); f.setFailureReason("machine-mismatch"); await f.bridge.start();
  expect(await f.bridge.dispatch({ from, to: remote, message: { id: "fatal-expiry", timestamp: 1, content: { text: "synthetic" } } })).toMatchObject({ delivery: "queued" });
  await flush(); expect(f.store.edgeState(B, "edge-1").status).toBe("down");
  const attempts = execs(f.calls).length; await f.bridge.stop();
  const api = await vi.importActual("../intercom-bridge") as { createIntercomBridge: (ports: any) => any };
  const restarted = api.createIntercomBridge({ machineId: A, machineAlias: "source.invalid", edges: [{ peer, edgeEpoch: "edge-1", initiator: false }],
    store: f.store, transport: f.transport, clock: f.clock, localPresence: () => [], authoritativeHome: () => null,
    onExpiry: (event: unknown) => f.expirations.push(event) });
  bridges.push(restarted); await restarted.start();
  await f.clock.advance(24 * 60 * 60 * 1000);
  expect(execs(f.calls)).toHaveLength(attempts);
  expect(f.expirations).toEqual([{ peer: B, id: "fatal-expiry", from, to, outcomeKnown: false }]);
  expect(f.store.retained("outbound", "fatal-expiry")).toMatchObject({ state: "expired", payloadRetained: false });
}, 5000);


it("cleans expiry work after a failed start and can start again", async () => {
  const f = await fixture({ mode: "blocked", initiator: false }), api = await vi.importActual("../intercom-bridge") as { createIntercomBridge: (ports: any) => any };
  f.store.acceptOutbound({ from, endpoint, nextHop: B, message: { id: "startup-mail", timestamp: 1, content: { text: "synthetic" } } });
  let fail = true;
  const bridge = api.createIntercomBridge({ machineId: A, machineAlias: "source.invalid", edges: [{ peer, edgeEpoch: "edge-1", initiator: false }],
    store: f.store, transport: f.transport, clock: f.clock, localPresence: () => [], authoritativeHome: () => null,
    publishPresence: () => { if (fail) throw new Error("fixture start failure"); } });
  bridges.push(bridge);
  await expect(bridge.start()).rejects.toThrow("fixture start failure");
  expect(f.clock.tasks.size).toBe(0);
  fail = false; await bridge.start(); await flush();
  expect(f.store.retained("outbound", "startup-mail")).toMatchObject({ payloadRetained: true });
  await bridge.stop(); expect(f.clock.tasks.size).toBe(0);
}, 5000);


it("retries a failed local expiry notification without retrying a fatal edge", async () => {
  const f = await fixture({ mode: "failure", initiator: false }), api = await vi.importActual("../intercom-bridge") as { createIntercomBridge: (ports: any) => any };
  f.setFailureReason("machine-mismatch"); let calls = 0; const notices: unknown[] = [];
  const bridge = api.createIntercomBridge({ machineId: A, machineAlias: "source.invalid", edges: [{ peer, edgeEpoch: "edge-1", initiator: false }],
    store: f.store, transport: f.transport, clock: f.clock, localPresence: () => [], authoritativeHome: () => null,
    onExpiry: (event: unknown) => { calls++; if (calls === 1) throw new Error("fixture notification failed"); notices.push(event); } });
  bridges.push(bridge); await bridge.start();
  await bridge.dispatch({ from, to: remote, message: { id: "notice-retry", timestamp: 1, content: { text: "synthetic" } } }); await flush();
  const attempts = execs(f.calls).length;
  await f.clock.advance(24 * 60 * 60 * 1000); expect(calls).toBe(1); expect(notices).toEqual([]);
  await f.clock.advance(30_000); expect(calls).toBe(2); expect(notices).toEqual([expect.objectContaining({ id: "notice-retry", outcomeKnown: false })]);
  expect(execs(f.calls)).toHaveLength(attempts);
}, 5000);

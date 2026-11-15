import { withHopExchange } from "./intercom-hop-fixture";
import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { openIntercomStore } from "../intercom-store";
import { createIntercomBridge } from "../intercom-bridge";
import { ExchangeError } from "../intercom-exchange";
import type { Transport } from "../contracts";
const A = "00000000-0000-4000-8000-000000000001", B = "00000000-0000-4000-8000-000000000002";
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const f of cleanups.splice(0).reverse()) await f(); });
const peer = { machineId: B, alias: "peer.invalid", node: "/fixture/node", pi: "/fixture/pi", cli: "/fixture/cli", core: "/fixture/hc", globalRoot: "/fixture/global" };
it.each(["helper-unauthorized", "unsupported-broker", "invalid-reply", "invalid-presence", "invalid-receipt", "endpoint-exited", "peer-version-mismatch", "machine-not-enrolled"])("retries %s with backoff and recovers after a restart", async reason => {
  const root = mkdtempSync(join(resolve(".spider/scratch"), "transient-")); cleanups.push(() => rmSync(root, { force: true, recursive: true }));
  const timers: Array<{ ms: number; fn(): void; cancelled: boolean }> = [];
  const clock = { now: () => 1000, later(ms: number, fn: () => void) { const t = { ms, fn, cancelled: false }; timers.push(t); return () => { t.cancelled = true; }; } };
  const file = join(root, "q.db"); let store = openIntercomStore({ file, machineId: A, clock }), calls = 0, healthy = false;
  const transport: Transport = { resolve: async p => p, exec: async (_p, _args, opts) => {
    calls++;
    if (!healthy) return Buffer.from(JSON.stringify({ version: 1, kind: "intercom-exchange", ok: false, reason }));
    const request = JSON.parse(opts!.stdinForTimeout!(opts!.remoteTimeoutMs!).toString());
    return Buffer.from(JSON.stringify({ version: 1, kind: "intercom-exchange", ok: true, value: { version: 1, exchange: withHopExchange({ protocol: 5,
      senderMachine: B, recipientMachine: A, generation: request.exchange.generation, frames: [], acknowledgements: [], receipts: [], controls: [], presence: [] }) } }));
  } } as Transport;
  const make = () => createIntercomBridge({ machineId: A, machineAlias: "source.invalid", store, clock, transport,
    edges: [{ peer, edgeEpoch: "edge", initiator: true }], localPresence: () => [], authoritativeHome: () => null });
  let bridge = make(); cleanups.push(async () => { await bridge.stop(); store.close(); });
  await bridge.start(); for (let i = 0; i < 40; i++) await Promise.resolve();
  expect(calls).toBe(1);
  expect(store.edgeState(B, "edge")).toMatchObject({ status: "recovering", reason });
  expect(timers.some(t => !t.cancelled && t.ms === 1000)).toBe(true);
  await bridge.stop(); store.close(); store = openIntercomStore({ file, machineId: A, clock });
  healthy = true; bridge = make(); await bridge.start();
  const retry = timers.findLast(t => !t.cancelled && t.ms === 1000)!; expect(retry).toBeDefined(); retry.fn();
  for (let i = 0; i < 60; i++) await Promise.resolve();
  expect(calls).toBe(2);
  expect(store.edgeState(B, "edge")).toMatchObject({ status: "live", reason: null });
}, 5000);
it("keeps proved revocation and identity failures terminal but retries missing peer enrollment", () => {
  for (const reason of ["peer-revoked", "machine-mismatch"]) expect(new ExchangeError(reason).retryable).toBe(false);
  for (const reason of ["endpoint-exited", "helper-unauthorized", "invalid-reply", "machine-not-enrolled"]) expect(new ExchangeError(reason).retryable).toBe(true);
}, 5000);

async function enrollmentFixture() {
  const root = mkdtempSync(join(resolve(".spider/scratch"), "enrollment-retry-"));
  cleanups.push(() => rmSync(root, { force: true, recursive: true }));
  const timers: Array<{ ms: number; fn(): void; cancelled: boolean }> = [];
  let time = 1000, healthy = false, calls = 0;
  const clock = { now: () => time, later(ms: number, fn: () => void) {
    const timer = { ms, fn, cancelled: false }; timers.push(timer); return () => { timer.cancelled = true; };
  } };
  const file = join(root, "q.db"); let store = openIntercomStore({ file, machineId: A, clock });
  const flush = async () => { for (let i = 0; i < 60; i++) await Promise.resolve(); };
  const transport = { resolve: async (value: typeof peer) => value, exec: async (_peer: unknown, _argv: unknown, opts: Parameters<Transport["exec"]>[2]) => {
    calls++;
    if (!healthy) return Buffer.from(JSON.stringify({ version: 1, kind: "intercom-exchange", ok: false, reason: "machine-not-enrolled" }));
    const request = JSON.parse(opts!.stdinForTimeout!(opts!.remoteTimeoutMs!).toString());
    return Buffer.from(JSON.stringify({ version: 1, kind: "intercom-exchange", ok: true, value: { version: 1, exchange: withHopExchange({ protocol: 5,
      senderMachine: B, recipientMachine: A, generation: request.exchange.generation, frames: [], acknowledgements: [], receipts: [], controls: [], presence: [] }) } }));
  } } as Transport;
  const make = () => createIntercomBridge({ machineId: A, machineAlias: "source.invalid", store, clock, transport,
    edges: [{ peer, edgeEpoch: "edge", initiator: true }], localPresence: () => [], authoritativeHome: () => null });
  let bridge = make(); cleanups.push(async () => { await bridge.stop(); store.close(); });
  await bridge.start(); await flush();
  return { timers, flush, get calls() { return calls; }, get store() { return store; },
    healthy() { healthy = true; },
    async retry(ms: number) {
      const timer = timers.findLast(t => !t.cancelled && t.ms === ms);
      expect(timer).toBeDefined(); timer!.cancelled = true; time += ms; timer!.fn(); await flush();
    },
    async restart() { await bridge.stop(); store.close(); store = openIntercomStore({ file, machineId: A, clock }); bridge = make(); await bridge.start(); await flush(); },
    async enroll(operationId: string) {
      await bridge.enrollPair({ peer, edgeEpoch: "edge", initiator: true },
        { operationId, graphDigest: "a".repeat(64), expectedFenceId: null, edgeEpoch: "edge" });
      await flush();
    } };
}

it("backs off missing peer enrollment across restart without continuous attempts", async () => {
  const f = await enrollmentFixture();
  expect(f.calls).toBe(1);
  expect(f.store.edgeState(B, "edge")).toMatchObject({ status: "recovering", reason: "machine-not-enrolled" });
  for (const delay of [1000, 2000, 4000, 8000, 15000, 30000]) await f.retry(delay);
  expect(f.calls).toBe(7);
  expect(f.store.edgeState(B, "edge")).toMatchObject({ status: "down", failures: 7 });
  await f.restart();
  expect(f.calls).toBe(7);
  await f.flush(); expect(f.calls).toBe(7);
  await f.retry(30000); expect(f.calls).toBe(8);
  f.healthy(); await f.retry(30000);
  expect(f.store.edgeState(B, "edge")).toMatchObject({ status: "live", reason: null });
}, 5000);

it("clears enrollment backoff on fresh local approval but not on replay", async () => {
  const f = await enrollmentFixture();
  await f.enroll("approval-1");
  expect(f.calls).toBe(2);
  await f.enroll("approval-1"); expect(f.calls).toBe(2);
  await f.retry(1000); await f.retry(2000);
  const before = f.calls;
  f.healthy(); await f.enroll("approval-2");
  expect(f.calls).toBe(before + 1);
  expect(f.store.edgeState(B, "edge")).toMatchObject({ status: "live", reason: null, failures: 0 });
  expect(f.timers.filter(timer => !timer.cancelled && [1000, 2000, 4000, 8000, 15000, 30000].includes(timer.ms))).toEqual([]);
}, 5000);

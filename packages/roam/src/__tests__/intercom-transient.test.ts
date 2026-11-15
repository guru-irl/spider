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
it.each(["helper-unauthorized", "unsupported-broker", "invalid-reply", "invalid-presence", "invalid-receipt", "endpoint-exited", "peer-version-mismatch"])("retries %s with backoff and recovers after a restart", async reason => {
  const root = mkdtempSync(join(resolve(".spider/scratch"), "transient-")); cleanups.push(() => rmSync(root, { force: true, recursive: true }));
  const timers: Array<{ ms: number; fn(): void; cancelled: boolean }> = [];
  const clock = { now: () => 1000, later(ms: number, fn: () => void) { const t = { ms, fn, cancelled: false }; timers.push(t); return () => { t.cancelled = true; }; } };
  const file = join(root, "q.db"); let store = openIntercomStore({ file, machineId: A, clock }), calls = 0, healthy = false;
  const transport: Transport = { resolve: async p => p, exec: async (_p, _args, opts) => {
    calls++;
    if (!healthy) return Buffer.from(JSON.stringify({ version: 1, kind: "intercom-exchange", ok: false, reason }));
    const request = JSON.parse(opts!.stdinForTimeout!(opts!.remoteTimeoutMs!).toString());
    return Buffer.from(JSON.stringify({ version: 1, kind: "intercom-exchange", ok: true, value: { version: 1, exchange: { protocol: 3,
      senderMachine: B, recipientMachine: A, generation: request.exchange.generation, frames: [], acknowledgements: [], receipts: [], controls: [], presence: [] } } }));
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
it("keeps proved identity and enrollment failures terminal for the current edge epoch", () => {
  for (const reason of ["peer-revoked", "machine-mismatch", "machine-not-enrolled"]) expect(new ExchangeError(reason).retryable).toBe(false);
  for (const reason of ["endpoint-exited", "helper-unauthorized", "invalid-reply"]) expect(new ExchangeError(reason).retryable).toBe(true);
}, 5000);

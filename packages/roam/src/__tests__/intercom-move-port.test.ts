import { expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createReplica } from "@spider/db-core/testutil";
import type { MachineIntercomOptions } from "../intercom-runtime";
import { parseConfig } from "../config";
import { createMachineIntercom } from "../intercom-runtime";
import { DEFAULT_LIMITS, type RoamConfig } from "../contracts";
import { IntercomClient, IntercomFederationClient } from "@spider/intercom/broker/client";
import { createIntercomBridge } from "../intercom-bridge";
import { openIntercomStore } from "../intercom-store";
import { withHopExchange } from "./intercom-hop-fixture";
import type { RemoteSessionInfo } from "@spider/intercom/protocol";
import { machineMoveProxy } from "../machine-move-socket";
import { startTestBroker, stopTestBroker, testTmpDir } from "../../../intercom/src/test-support";

const HUB = "00000000-0000-4000-8000-000000000001";
const config: RoamConfig = { enabled: false, role: "hub", machineId: HUB, hubMachineId: HUB, peers: [], discoveryRoots: [], coreUnit: "fixture", syncMs: 1000, limits: DEFAULT_LIMITS,
  intercom: { enabled: false, mode: "hub-only", machineAlias: "hub.invalid", protocolFeature: "federation-v1", routes: [], limits: { queueMessages: 500, queueBytes: 5242880 } } };
it("machine move port exposes only named guarded operations without raw objects", async () => {
  const machine = createMachineIntercom({ config, root: "/fixture/root", agentDir: "/fixture/agent", globalDb: {} as never, clock: { now: () => 0, later: () => () => {} }, transport: {} as never });
  expect(Object.keys(machine.move).sort()).toEqual(["bridge", "broker", "endpoint", "intake", "releaseRollbackFence", "settlement"]);
  expect(typeof machine.move.broker).toBe("function");
  expect(machine.move).not.toHaveProperty("store");
  expect(typeof machine.move.bridge).toBe("function");
  const address = { sessionId: "session-a", scopeId: "scope-a" };
  await expect(machine.move.bridge(address)).rejects.toThrow("intercom-move-unavailable");
  await expect(machine.move.broker(address)).rejects.toThrow("intercom-move-unavailable");
  await expect(machine.move.broker(address)).rejects.toThrow("intercom-move-unavailable: roaming-disabled");
  await expect(machine.move.endpoint(address)).rejects.toThrow("intercom-move-unavailable");
  await expect(machine.move.settlement({ messageId: "message-a", fromSessionId: "sender-a", toSessionId: "session-a", scopeId: "scope-a" })).rejects.toThrow("intercom-move-unavailable");
  const home = { sessionId: "session-a", machineId: HUB, epoch: 3, moveId: "rollback-a", updatedAt: 0 };
  await expect(machine.move.releaseRollbackFence({ address, moveId: "move-a", expectedEpoch: 1, generation: "generation-a" }, home, home)).rejects.toThrow("intercom-move-unavailable");
  expect(Object.keys(machine.move.intake).sort()).toEqual(["abort", "checkGeneration", "close", "drain", "inspect", "ready"]);
  const fence = { address, moveId: "move-a", expectedEpoch: 1, generation: "generation-a" };
  await expect(machine.move.intake.close(address, "move-a", 1)).rejects.toThrow("intercom-move-unavailable");
  for (const verb of ["drain", "inspect", "checkGeneration", "abort"] as const) await expect(machine.move.intake[verb](fence)).rejects.toThrow("intercom-move-unavailable");
  await expect(machine.move.intake.ready(fence, { address, machineId: HUB, homeEpoch: 2, activationEpoch: "activation-a" })).rejects.toThrow("intercom-move-unavailable");
  await machine.stop();
}, 5000);

it("broker evidence is an owned-address snapshot with no reachable broker capability", async () => {
  const global = createReplica("global", HUB), agentDir = mkdtempSync(join(resolve(".spider/scratch"), "mp-"));
  const address = { sessionId: "owned-session", scopeId: "owned-scope" }, from = { sessionId: "sender", scopeId: "owned-scope" };
  const mutate = vi.fn(), raw = { asks: [{ id: "ask-a", from: { ...from, register: mutate }, to: address, deliver: mutate }],
    pendingDispatch: ["message-a"], unknownOutcomes: [], unobservedReceipts: [], send: mutate };
  const read = vi.fn(async () => raw);
  class Broker extends EventEmitter {
    async connect() { this.emit("presence", []); }
    async enableHelpers() {}
    publishPresence() {}
    async deliver() { throw new Error("unexpected delivery"); }
    deliverReceipt() {}
    async deliverRevocationNotice() { return true; }
    deliverControl() {}
    async inspectFreezeBlockers() { return read(); }
    async inspectBlockers() { return { asks: [], pendingDispatch: [], unknownOutcomes: [], unobservedReceipts: [] }; }
    async close() {}
  }
  const broker = new Broker(); let owns = true;
  const machine = createMachineIntercom({ config: parseConfig({ enabled: true, role: "hub", machineId: HUB, hubMachineId: HUB, coreUnit: "fixture.service", intercom: { enabled: true, mode: "peers", machineAlias: "hub.invalid" } }), root: global.root,
    agentDir, globalDb: global.db, clock: { now: () => 1000, later: () => () => {} }, transport: {} as never,
    broker: broker as unknown as MachineIntercomOptions["broker"], env: { ...process.env, PI_SUBAGENT_CHILD: "0" }, generationKnown: () => true,
    moveOwns: async endpoint => owns && endpoint.address.sessionId === address.sessionId && endpoint.activationEpoch === "owned-generation",
    async ensureBroker() {} });
  try {
    await expect(machine.move.broker(address)).rejects.toThrow("intercom-move-unavailable");
    await machine.start();
    expect(machine.readiness()).toEqual({ state: "ready", reason: null });
    broker.emit("presence", [{ address, activationEpoch: "owned-generation", homeEpoch: null, cwd: "/fixture", model: "fixture", startedAt: 1, lastActivity: 1 }]);
    await expect(machine.move.broker({ ...address, scopeId: "unowned-scope" })).rejects.toThrow("intercom-owner-unproved");
    expect(read).not.toHaveBeenCalled();
    const result = await machine.move.broker(address);
    expect(result).toEqual({ asks: [{ id: "ask-a", from, to: address }], pendingDispatch: ["message-a"], unknownOutcomes: [], unobservedReceipts: [] });
    expect(result).not.toBe(raw);
    raw.pendingDispatch.push("later-message");
    expect(result.pendingDispatch).toEqual(["message-a"]);
    for (const key of ["send", "deliver", "register", "close", "intake", "broker", "store"]) expect(result).not.toHaveProperty(key);
    const pending: unknown[] = [machine.move, result];
    while (pending.length) {
      const value = pending.pop(); expect(value).not.toBe(broker);
      if (value && typeof value === "object") pending.push(...Object.values(value));
    }
    owns = false;
    await expect(machine.move.broker(address)).rejects.toThrow("intercom-owner-unproved");
    expect(read).toHaveBeenCalledTimes(1);
    owns = true; read.mockImplementationOnce(async () => { owns = false; return raw; });
    await expect(machine.move.broker(address)).rejects.toThrow("intercom-owner-unproved");
    expect(read).toHaveBeenCalledTimes(2);
    expect(mutate).not.toHaveBeenCalled();
  } finally { await machine.stop(); global.close(); rmSync(agentDir, { recursive: true, force: true }); }
}, 5000);


it("the live broker restores move socket readiness after a failed reconnect", async () => {
  const global = createReplica("global", HUB), agentDir = mkdtempSync(join(testTmpDir(), "mp-"));
  const child = startTestBroker(process.execPath, ["dist/intercom/broker.mjs"], {
    env: { ...process.env, HOME: agentDir, PI_CODING_AGENT_DIR: agentDir }, stdio: ["ignore", "pipe", "pipe"],
  });
  const broker = new IntercomFederationClient(), timers: Array<{ run(): void; cancelled: boolean }> = [];
  let failure: Error | undefined;
  const machine = createMachineIntercom({ config: parseConfig({ enabled: true, role: "hub", machineId: HUB, hubMachineId: HUB,
    coreUnit: "fixture.service", intercom: { enabled: true, mode: "peers", machineAlias: "hub.invalid" } }),
    root: global.root, globalDb: global.db, agentDir, broker, env: { ...process.env, PI_SUBAGENT_CHILD: "0" }, transport: {} as never,
    clock: { now: () => 1000, later(_delay, run) { const timer = { run, cancelled: false }; timers.push(timer); return () => { timer.cancelled = true; }; } },
    async ensureBroker() { if (failure) throw failure; },
  });
  mkdirSync(join(global.root, "roam"), { recursive: true, mode: 0o700 });
  writeFileSync(join(global.root, "roam", "config.json"), JSON.stringify({ machineId: HUB, intercom: { enabled: true } }), { mode: 0o600 });
  const proxy = machineMoveProxy(global.root), address = { sessionId: "owned-session", scopeId: "owned-scope" };
  const empty = { asks: [], pendingDispatch: [], unknownOutcomes: [], unobservedReceipts: [] };
  try {
    await new Promise<void>((done, reject) => {
      child.once("exit", code => reject(new Error(`broker exited: ${code}`)));
      child.stdout!.on("data", chunk => { if (String(chunk).includes("Intercom broker started")) done(); });
    });
    await machine.start();
    expect(machine.readiness()).toEqual({ state: "ready", reason: null });
    await expect(proxy.bridge(address)).resolves.toEqual(empty);
    await broker.close();
    expect(machine.readiness()).toEqual({ state: "pending", reason: "broker-unavailable" });
    await expect(proxy.bridge(address)).rejects.toMatchObject({ diagnostic: { message: "intercom-move-unavailable: broker-unavailable" } });
    failure = Object.assign(new Error("reconnect refused token=secret-value Bearer private-value"), { code: "ECONNREFUSED", private: "never expose" });
    const reconnect = timers.find(timer => !timer.cancelled)!; reconnect.cancelled = true; reconnect.run();
    await vi.waitFor(() => expect(timers.filter(timer => !timer.cancelled)).toHaveLength(1));
    const refused = await proxy.bridge(address).catch(error => error);
    expect(refused.diagnostic.message).toContain("reconnect refused token=[redacted] Bearer [redacted]");
    expect(refused.diagnostic.message).not.toContain("secret-value");
    expect(refused.diagnostic.message).not.toContain("private-value");
    expect(refused.diagnostic.message).not.toContain("never expose");
    failure = undefined;
    const retry = timers.find(timer => !timer.cancelled)!; retry.cancelled = true; retry.run();
    await vi.waitFor(() => expect(machine.readiness()).toEqual({ state: "ready", reason: null }));
    await expect(proxy.bridge(address)).resolves.toEqual(empty);
  } finally { await machine.stop(); await stopTestBroker(child); global.close(); rmSync(agentDir, { recursive: true, force: true }); }
}, 5000);


it("a moved home does not disconnect its broker while the frozen source is still attached", async () => {
  const global = createReplica("global", HUB), agentDir = mkdtempSync(join(testTmpDir(), "mh-"));
  const BOX = "00000000-0000-4000-8000-000000000002", address = { sessionId: "moving-session", scopeId: null };
  const child = startTestBroker(process.execPath, ["dist/intercom/broker.mjs"], {
    env: { ...process.env, HOME: agentDir, PI_CODING_AGENT_DIR: agentDir }, stdio: ["ignore", "pipe", "pipe"],
  });
  mkdirSync(join(global.root, "roam"), { recursive: true, mode: 0o700 });
  writeFileSync(join(global.root, "roam", "config.json"), JSON.stringify({ machineId: HUB, intercom: { enabled: true } }), { mode: 0o600 });
  const clock = { now: () => 1000, later: () => () => {} }, broker = new IntercomFederationClient(), client = new IntercomClient();
  const store = openIntercomStore({ file: join(global.root, "queue.db"), machineId: HUB, clock });
  let ready = false, logical: readonly RemoteSessionInfo[] = [];
  const remote: RemoteSessionInfo = { remote: true, id: address.sessionId, address, machineId: BOX, machineAlias: "box.invalid", homeEpoch: 2,
    activationEpoch: "destination-activation", endpointEpoch: "destination-activation", cwd: "/workspace", model: "fixture", startedAt: 1, lastActivity: 1 };
  const bridge = createIntercomBridge({ machineId: HUB, machineAlias: "hub.invalid", broker, globalRoot: global.root, agentDir, store, clock,
    edges: [{ peer: { machineId: BOX, alias: "box.invalid", node: "/fixture/node", pi: "/fixture/pi", cli: "/fixture/cli", core: "/fixture/hc", globalRoot: "/fixture/global" }, edgeEpoch: "edge-1", initiator: false }],
    transport: {} as never, localPresence: () => [], moveFences: true,
    authoritativeHome: () => ({ sessionId: address.sessionId, machineId: BOX, epoch: 2, moveId: "move-1", updatedAt: 1 }),
    publishPresence: entries => { logical = entries; }, onBrokerState: value => { ready = value; },
  });
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    await new Promise<void>((done, reject) => {
      child.once("exit", code => reject(new Error(`broker exited: ${code}`)));
      child.stdout!.on("data", chunk => { if (String(chunk).includes("Intercom broker started")) done(); });
    });
    await bridge.start();
    await client.connect({ address, cwd: "/workspace", model: "fixture", pid: process.pid, startedAt: 1, lastActivity: 1,
      activationEpoch: "source-activation", homeEpoch: 1 }, address.sessionId);
    await broker.inspectBlockers(address);
    expect(ready).toBe(true);
    await bridge.exchange({ version: 1, holdMs: 0, deadlineMs: 5000, exchange: withHopExchange({ protocol: 5,
      senderMachine: BOX, recipientMachine: HUB, generation: { edgeEpoch: "edge-1", channel: "push", generation: 1 },
      frames: [], acknowledgements: [], receipts: [], controls: [], presence: [remote] }) });
    expect(logical).toMatchObject([{ address, machineId: BOX, homeEpoch: 2 }]);
    await expect(broker.inspectBlockers(address)).resolves.toEqual({ asks: [], pendingDispatch: [], unknownOutcomes: [], unobservedReceipts: [] });
    expect(ready).toBe(true);
    await client.disconnect();
    await broker.inspectBlockers(address);
    expect(ready).toBe(true);
  } finally {
    await client.disconnect(); await bridge.stop(); await stopTestBroker(child); store.close(); global.close();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(agentDir, { recursive: true, force: true });
  }
}, 5000);

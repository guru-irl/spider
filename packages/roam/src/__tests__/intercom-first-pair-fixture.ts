import { EventEmitter, once } from "node:events";
import { createServer, type Socket } from "node:net";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createReplica } from "@spider/db-core/testutil";
import { HELPER_EXCHANGE_FEATURE, type FederationBridge } from "@spider/intercom/protocol";
import { createMessageReader, writeMessage } from "../../../intercom/src/broker/framing";
import { parseConfig } from "../config";
import { createMachineIntercom, type MachineIntercom } from "../intercom-runtime";
import { openIntercomStore } from "../intercom-store";
import { openJournal } from "../journal";
import type { Clock, Peer, RoamConfig, Transport } from "../contracts";
import type { IntercomBroker } from "../intercom-bridge";
import { scenario, cleanupPairScenarios } from "./intercom-pair-fixture";

export const HUB = "00000000-0000-4000-8000-000000000001";
export const A = "00000000-0000-4000-8000-000000000002";
export const B = "00000000-0000-4000-8000-000000000003";

class FixtureBroker extends EventEmitter implements IntercomBroker {
  bridge!: FederationBridge;
  helper!: (input: unknown, signal: AbortSignal) => Promise<unknown>;
  async connect(_registration: unknown, bridge: FederationBridge) { this.bridge = bridge; this.emit("presence", []); }
  async enableHelpers(_token: string, handler: FixtureBroker["helper"]) { this.helper = handler; }
  publishPresence() {}
  async deliver(..._args: Parameters<IntercomBroker["deliver"]>) {
    return { delivery: "socket_delivered" as const, retryable: false, outcomeKnown: true,
      acceptance: { accepted: true as const, durable: false as const } };
  }
  deliverReceipt() {}
  deliverControl() {}
  async deliverRevocationNotice() { return true; }
  async inspectBlockers() { return { asks: [], pendingDispatch: [], unknownOutcomes: [], unobservedReceipts: [] }; }
  async close() { this.emit("closed"); }
}

/** Only broker transport, remote execution and OS process effects are simulated. */
export async function firstPairFixture() {
  const pair = await scenario(), hub: Peer = { ...pair.source, machineId: HUB, alias: "hub.invalid", globalRoot: pair.root };
  const journal = openJournal(join(pair.root, "roam", "journal.db"));
  const brokers = new Map<string, FixtureBroker>(), services = new Map<string, MachineIntercom>();
  const replicas: ReturnType<typeof createReplica>[] = [], sockets = new Set<Socket>();
  let now = 1000, pauseHubToOrigin = false;
  const timers: Array<{ at: number; fn(): void; cancelled: boolean }> = [];
  const clock: Clock = { now: () => now, later(ms, fn) {
    const timer = { at: now + ms, fn, cancelled: false }; timers.push(timer); return () => { timer.cancelled = true; };
  } };
  const readConfig = (peer: Peer): RoamConfig => JSON.parse(readFileSync(join(peer.globalRoot, "roam", "config.json"), "utf8"));
  const saveConfig = (peer: Peer, config: unknown) => writeFileSync(join(peer.globalRoot, "roam", "config.json"), JSON.stringify(config), { mode: 0o600 });
  mkdirSync(join(hub.globalRoot, "roam"), { recursive: true, mode: 0o700 });
  writeFileSync(join(hub.globalRoot, "roam", "machine.json"), JSON.stringify({ machineId: HUB }), { mode: 0o600 });
  saveConfig(hub, { enabled: true, role: "hub", machineId: HUB, hubMachineId: HUB, coreUnit: "fixture.service", peers: [pair.source, pair.target],
    intercom: { enabled: true, mode: "hub-only", machineAlias: hub.alias,
      routes: [pair.source, pair.target].map(peer => ({ kind: "direct", peer, edgeEpoch: `hub-${peer.machineId}` })) } });
  for (const peer of [pair.source, pair.target]) saveConfig(peer, { ...readConfig(peer),
    intercom: { ...readConfig(peer).intercom, mode: "hub-only", routes: [{ kind: "direct", peer: hub, edgeEpoch: `hub-${peer.machineId}` }] } });
  const server = createServer(socket => {
    sockets.add(socket); socket.on("error", () => {}); socket.once("close", () => sockets.delete(socket));
    socket.on("data", createMessageReader(raw => {
      const message = raw as Record<string, unknown>;
      if (message.type === "health") writeMessage(socket, { type: "health_ok", requestId: message.requestId,
        protocol: "pi-intercom", version: 1, features: [HELPER_EXCHANGE_FEATURE] });
      else if (message.type === "helper_register") {
        const route = JSON.parse(readFileSync(join(pair.root, "roam", "intercom", "helper.json"), "utf8"));
        if (message.token !== route.token) { socket.destroy(); return; }
        writeMessage(socket, { type: "helper_registered", requestId: message.requestId });
      } else if (message.type === "helper_exchange") {
        void brokers.get(HUB)!.helper(message.input, new AbortController().signal).then(output => {
          writeMessage(socket, { type: "helper_result", requestId: message.requestId, output });
        }, () => socket.destroy());
      } else socket.destroy();
    }, () => socket.destroy()));
  });
  const agentDir = join(pair.root, "agent"); mkdirSync(join(agentDir, "intercom"), { recursive: true, mode: 0o700 });
  server.listen(join(agentDir, "intercom", "broker.sock")); await once(server, "listening");
  chmodSync(join(agentDir, "intercom", "broker.sock"), 0o600);
  const hubQueue = openIntercomStore({ file: join(pair.root, "roam", "intercom", "queue.db"), machineId: HUB, clock, mode: "hub-only" });
  const pump = async (advance = 0) => {
    now += advance;
    for (let turn = 0; turn < 40; turn++) {
      for (const timer of timers.filter(timer => !timer.cancelled && timer.at <= now)) { timer.cancelled = true; timer.fn(); }
      await new Promise<void>(resolve => setImmediate(resolve));
    }
  };
  try {
    for (const peer of [hub, pair.target, pair.source]) {
      const replica = createReplica("global", peer.machineId); replicas.push(replica);
      const broker = new FixtureBroker(); brokers.set(peer.machineId, broker);
      const transport: Transport = {
        async resolve(remote) { return remote; },
        async exec(remote, _argv, options) {
          if (pauseHubToOrigin && peer.machineId === HUB && remote.machineId === A) throw Object.assign(new Error("fixture link unavailable"), { code: "unreachable" });
          const destination = brokers.get(remote.machineId);
          if (!destination?.helper) throw Object.assign(new Error("fixture helper unavailable"), { code: "unreachable" });
          const input = JSON.parse(options.stdinForTimeout!(options.remoteTimeoutMs!).toString());
          const value = await destination.helper({ ...input, holdMs: 0 }, options.signal ?? new AbortController().signal);
          return Buffer.from(JSON.stringify({ version: 1, kind: "intercom-exchange", ok: true, value }));
        },
        async bootstrapProbe() { throw new Error("unexpected fixture probe"); }, async run() { throw new Error("unexpected fixture run"); },
        async read() { throw new Error("unexpected fixture read"); }, async write() { throw new Error("unexpected fixture write"); },
      };
      const localAgentDir = peer.machineId === HUB ? agentDir : join(pair.root, peer.machineId === A ? "a" : "b");
      mkdirSync(localAgentDir, { recursive: true, mode: 0o700 });
      const service = createMachineIntercom({ root: peer.globalRoot, globalDb: replica.db, config: parseConfig(readConfig(peer)),
        agentDir: localAgentDir,
        broker, clock, transport, env: { ...process.env, PI_SUBAGENT_CHILD: "0" }, generationKnown: () => true,
        async ensureBroker({ agentDir }) { mkdirSync(agentDir, { recursive: true, mode: 0o700 }); },
        async pairScopedHostReady(pairId) {
          const side = peer.machineId === A ? "connect" : "host";
          return pair.units.get(`${peer.machineId}/spider-pair-${pairId}-${side}.service`)?.state === "active";
        } });
      services.set(peer.machineId, service); await service.start();
      if (service.readiness().state !== "ready") throw new Error(`fixture bridge not ready: ${service.readiness().reason}`);
      const local = pair.locals.get(peer.machineId);
      if (local) {
        local.enrollBridge = input => broker.helper(input, new AbortController().signal);
        local.inspectBridge = input => broker.helper(input, new AbortController().signal) as ReturnType<NonNullable<typeof local.inspectBridge>>;
        local.inspectFence = input => broker.helper(input, new AbortController().signal) as ReturnType<NonNullable<typeof local.inspectFence>>;
      }
    }
    await pump(1000);
    const exec = pair.transport.transport.exec.bind(pair.transport.transport), publications = new Map<string, Buffer>();
    const transport = { ...pair.transport, transport: { ...pair.transport.transport, async exec(...args: Parameters<typeof exec>) {
      const input = JSON.parse(args[2].stdin!.toString());
      if (input.action === "publish-config") publications.set(args[0].machineId, Buffer.from(args[2].stdin!));
      if (input.action === "verify-federation") await pump();
      return exec(...args);
    } } };
    const graph = join(pair.root, "graph.json");
    writeFileSync(graph, JSON.stringify({ pairs: [{ pairId: "pair-1", source: pair.source.alias, target: pair.target.alias, edgeEpoch: "edge-1",
      connector: pair.request.pairs[0].connector }] }), { mode: 0o600 });
    return { ...pair, hub, hubQueue, journal, brokers, services, graph, transport, publications, readConfig, saveConfig, pump,
      pauseOrigin(value: boolean) { pauseHubToOrigin = value; },
      async close() { await close(); } };
  } catch (error) { await close(); throw error; }
  async function close() {
    for (const service of [...services.values()].reverse()) await service.stop();
    hubQueue.close(); for (const replica of replicas) replica.close();
    for (const socket of sockets) socket.destroy();
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    cleanupPairScenarios();
  }
}

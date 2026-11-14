import { paths } from "@spider/db-core";
import { afterAll, beforeAll, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { buildRoamEntries } from "../../../../scripts/build-roam.mjs";
import { buildIntercom } from "../../../../scripts/build-intercom.mjs";
import { startTestBroker, stopTestBroker } from "../../../intercom/src/test-support";
import { getAgentDirPath } from "../../../intercom/src/broker/paths";
import { IntercomFederationClient } from "../../../intercom/src/broker/client";
import { createClientFixture } from "../../../herdr/src/__tests__/testutil";
import { openIntercomStore } from "../intercom-store";
import { createIntercomBridge } from "../intercom-bridge";
import { createTransport } from "../transport";
import { exchange as executeExchange } from "../intercom-exchange";

const A = "00000000-0000-4000-8000-000000000001", B = "00000000-0000-4000-8000-000000000002";
const from = { sessionId: "sender", scopeId: "scope" }, to = { sessionId: "recipient", scopeId: "scope" };
const endpoint = { address: to, machineId: B, homeEpoch: 1, activationEpoch: "activation-1" };
const peer = { machineId: A, alias: "source.invalid", node: "/fixture/node", pi: "/fixture/pi", cli: "/fixture/cli", core: "/fixture/hc", globalRoot: "/fixture/global" };
const clock = { now: () => Date.now(), later: (ms: number, fn: () => void) => { const timer = setTimeout(fn, ms); return () => clearTimeout(timer); } };
let root: string, agentDir: string, broker: ChildProcess;
beforeAll(async () => {
  root = mkdtempSync(join(paths.scratch("worktree", process.cwd()), "ibb-")); agentDir = getAgentDirPath();
  await buildIntercom(join(root, "broker")); await buildRoamEntries(join(root, "roam-build"));
  broker = startTestBroker(process.execPath, [join(root, "broker", "broker.mjs")], { env: process.env, stdio: ["ignore", "pipe", "pipe"] }, "suite");
  await new Promise<void>((done, reject) => {
    const timer = setTimeout(() => reject(new Error("fixture broker startup timed out")), 4000);
    broker.once("exit", code => { clearTimeout(timer); reject(new Error(`fixture broker exit ${code}`)); });
    broker.stdout!.on("data", chunk => { if (String(chunk).includes("Intercom broker started")) { clearTimeout(timer); done(); } });
  });
}, 5000);
afterAll(async () => { if (broker) await stopTestBroker(broker); if (root) rmSync(root, { recursive: true, force: true }); }, 5000);

it("publishes a private capability for the configured agent directory and serves the packaged helper", async () => {
  const globalRoot = mkdtempSync(join(root, "global-")), sourceRoot = mkdtempSync(join(root, "source-"));
  const source = openIntercomStore({ file: join(sourceRoot, "queue.db"), machineId: A, clock });
  const inbox = openIntercomStore({ file: join(globalRoot, "queue", "queue.db"), machineId: B, clock });
  const client = new IntercomFederationClient();
  const bridge = createIntercomBridge({ machineId: B, machineAlias: "fixture-b.invalid", edges: [{ peer, edgeEpoch: "edge-1", initiator: false }],
    store: inbox, clock, transport: {} as any, localPresence: () => [], authoritativeHome: () => null,
    broker: client, globalRoot, agentDir } as any);
  const prior = process.env.PI_CODING_AGENT_DIR;
  try {
    process.env.PI_CODING_AGENT_DIR = join(globalRoot, "not-the-agent");
    await bridge.start();
    const file = join(globalRoot, "roam", "intercom", "helper.json");
    expect(existsSync(file)).toBe(true);
    expect(lstatSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ version: 1, agentDir, token: expect.stringMatching(/^[0-9a-f]{64}$/) });
    source.acceptOutbound({ from, endpoint, nextHop: B, message: { id: "through-helper", timestamp: 1, content: { text: "synthetic" } } });
    const frame = source.pending({ kind: "outbound", peer: B, hopBudgetMs: 100 })[0];
    const exchange = { protocol: 1, senderMachine: A, recipientMachine: B, generation: { edgeEpoch: "edge-1", channel: "push", generation: 1 },
      frames: [frame], acknowledgements: [], receipts: [], controls: [], presence: [] };
    const child = spawn(process.execPath, [join(root, "roam-build", "cli.mjs"), "--global-root", globalRoot, "roam", "intercom", "exchange"],
      { env: { ...process.env, HOME: globalRoot, SPIDER_GLOBAL_ROOT: globalRoot }, stdio: ["pipe", "pipe", "pipe"] });
    let output = "", errors = "";
    child.stdout.on("data", value => { output += value.toString(); }); child.stderr.on("data", value => { errors += value.toString(); });
    child.stdin.end(JSON.stringify({ version: 1, exchange, holdMs: 0, deadlineMs: 4000 }));
    const [code] = await once(child, "close");
    expect(code).toBe(0); expect(errors).toBe("");
    expect(JSON.parse(output)).toMatchObject({ version: 1, kind: "intercom-exchange", ok: true,
      value: { exchange: { acknowledgements: [{ identity: frame.identity, kind: "message" }] } } });
    expect(inbox.retained("inbound", "through-helper")).toMatchObject({ state: "queued", payloadRetained: true });
    await bridge.stop(); expect(existsSync(file)).toBe(false);
  } finally {
    if (prior === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = prior;
    await bridge.stop(); await client.close(); source.close(); inbox.close();
  }
}, 5000);


it("exchanges durable frames through fake hc, the packaged helper, and a fixture broker", async () => {
  const fixture = await createClientFixture();
  const globalRoot = join(fixture.root, "remote"), built = join(fixture.root, "roam-build");
  mkdirSync(globalRoot, { mode: 0o700 }); cpSync(join(root, "roam-build"), built, { recursive: true });
  const target = { machineId: B, alias: "remote.invalid", node: process.execPath, pi: "/fixture/pi", cli: join(built, "cli.mjs"), core: fixture.hcBinary, globalRoot };
  const machine = { id: "fixture-remote-core", name: target.alias, host: target.alias, target: target.alias, session: "remote", via: false, state: "connected" };
  const source = openIntercomStore({ file: join(fixture.root, "source", "queue.db"), machineId: A, clock });
  const inbox = openIntercomStore({ file: join(globalRoot, "queue", "queue.db"), machineId: B, clock });
  const client = new IntercomFederationClient();
  const bridge = createIntercomBridge({ machineId: B, machineAlias: "fixture-b.invalid", edges: [{ peer, edgeEpoch: "edge-1", initiator: false }],
    store: inbox, clock, transport: {} as any, localPresence: () => [], authoritativeHome: () => null,
    broker: client, globalRoot, agentDir } as any);
  try {
    await fixture.configure({ machines: [machine], roamFixture: { executeIntercomFixture: true } });
    await fixture.writeRoamFile(target.alias, join(globalRoot, "roam", "machine.json"), Buffer.from(JSON.stringify({ machineId: B })));
    await bridge.start();
    const transport = createTransport({ binary: fixture.hcBinary, env: fixture.localEnv, enrolled: [target] });
    const handle = await transport.resolve(target);
    source.acceptOutbound({ from, endpoint, nextHop: B, message: { id: "full-trip", timestamp: 1, content: { text: "synthetic private body" } } });
    const frame = source.pending({ kind: "outbound", peer: B, hopBudgetMs: 100 })[0];
    const input = { protocol: 1 as const, senderMachine: A, recipientMachine: B, generation: { edgeEpoch: "edge-1", channel: "push" as const, generation: 1 },
      frames: [frame], acknowledgements: [], receipts: [], controls: [], presence: [] };
    source.updateEdgeState(B, "edge-1", state => ({ ...state, outbound: { ...state.outbound, push: 1 } }));
    const result = await executeExchange(handle, { exchange: input, holdMs: 0 }, { machineId: A, enrollment: { peer: target, edgeEpoch: "edge-1" }, transport, store: source, clock });
    expect(result.exchange.acknowledgements).toEqual([{ identity: frame.identity, kind: "message" }]);
    expect(inbox.retained("inbound", "full-trip")).toMatchObject({ state: "queued", payloadRetained: true });
    const calls = await fixture.calls(), invocation = calls.find(call => call.argv.includes("exchange"));
    expect(invocation?.argv).toContain("--stdin"); expect(invocation?.argv).toContain(globalRoot);
    expect(JSON.stringify(invocation?.argv)).not.toContain("synthetic private body");
    const stale = { ...input, generation: { ...input.generation, edgeEpoch: "old-edge" }, frames: [] };
    source.updateEdgeState(B, "old-edge", state => ({ ...state, outbound: { ...state.outbound, push: 1 } }));
    await expect(executeExchange(handle, { exchange: stale, holdMs: 0 }, { machineId: A,
      enrollment: { peer: target, edgeEpoch: "old-edge" }, transport, store: source, clock }))
      .rejects.toMatchObject({ code: "machine-not-enrolled", retryable: false });
  } finally { await bridge.stop(); await client.close(); source.close(); inbox.close(); await fixture.close(); }
}, 5000);


it("reconnects after a local broker restart and rotates the helper capability", async () => {
  const globalRoot = mkdtempSync(join(root, "restart-")), store = openIntercomStore({ file: join(globalRoot, "queue", "queue.db"), machineId: B, clock });
  const client = new IntercomFederationClient(), states: boolean[] = [], timers = new Set<() => void>();
  let readyAgain!: () => void;
  const reconnected = new Promise<void>(resolveReady => { readyAgain = resolveReady; });
  const manualClock = { now: () => Date.now(), later: (_ms: number, fn: () => void) => { timers.add(fn); return () => { timers.delete(fn); }; } };
  const bridge = createIntercomBridge({ machineId: B, machineAlias: "fixture-b.invalid", edges: [{ peer, edgeEpoch: "edge-1", initiator: false }],
    store, clock: manualClock, transport: {} as any, localPresence: () => [], authoritativeHome: () => null,
    broker: client, globalRoot, agentDir, onBrokerState: (ready: boolean) => { states.push(ready); if (ready && states.filter(Boolean).length === 2) readyAgain(); } } as any);
  try {
    await bridge.start(); expect(states).toEqual([true]);
    const file = join(globalRoot, "roam", "intercom", "helper.json"), before = JSON.parse(readFileSync(file, "utf8")).token;
    const disconnected = once(client, "disconnected"); await stopTestBroker(broker); await disconnected;
    expect(states.at(-1)).toBe(false); expect(timers.size).toBe(1);
    broker = startTestBroker(process.execPath, [join(root, "broker", "broker.mjs")], { env: process.env, stdio: ["ignore", "pipe", "pipe"] }, "suite");
    await new Promise<void>((done, reject) => {
      const timer = setTimeout(() => reject(new Error("fixture broker restart timed out")), 4000);
      broker.once("exit", code => { clearTimeout(timer); reject(new Error(`fixture broker exit ${code}`)); });
      broker.stdout!.on("data", chunk => { if (String(chunk).includes("Intercom broker started")) { clearTimeout(timer); done(); } });
    });
    for (const fn of [...timers]) { timers.delete(fn); fn(); }
    await reconnected;
    expect(JSON.parse(readFileSync(file, "utf8")).token).not.toBe(before);
    expect(states).toEqual([true, false, true]);
  } finally { await bridge.stop(); await client.close(); store.close(); }
}, 5000);


it("stops a real fixture hc and its held helper within three seconds", async () => {
  const fixture = await createClientFixture(), globalRoot = join(fixture.root, "remote-stop"), built = join(fixture.root, "stop-build");
  mkdirSync(globalRoot, { mode: 0o700 }); cpSync(join(root, "roam-build"), built, { recursive: true });
  const target = { machineId: B, alias: "remote-stop.invalid", node: process.execPath, pi: "/fixture/pi", cli: join(built, "cli.mjs"), core: fixture.hcBinary, globalRoot };
  const machine = { id: "fixture-stop-core", name: target.alias, host: target.alias, target: target.alias, session: "remote", via: false, state: "connected" };
  const source = openIntercomStore({ file: join(fixture.root, "source-stop", "queue.db"), machineId: A, clock });
  const inbox = openIntercomStore({ file: join(globalRoot, "queue", "queue.db"), machineId: B, clock });
  const client = new IntercomFederationClient();
  const receiver = createIntercomBridge({ machineId: B, machineAlias: "fixture-b.invalid", edges: [{ peer, edgeEpoch: "edge-1", initiator: false }],
    store: inbox, clock, transport: {} as any, localPresence: () => [], authoritativeHome: () => null, broker: client, globalRoot, agentDir });
  let entered!: () => void, finished!: () => void;
  const waiting = new Promise<void>(resolveReady => { entered = resolveReady; }), remoteDone = new Promise<void>(resolveDone => { finished = resolveDone; });
  const receive = receiver.exchange.bind(receiver);
  receiver.exchange = async (input, signal) => { entered(); try { return await receive(input, signal); } finally { finished(); } };
  const transport = createTransport({ binary: fixture.hcBinary, env: fixture.localEnv, enrolled: [target] });
  const sender = createIntercomBridge({ machineId: A, machineAlias: "fixture-a.invalid", edges: [{ peer: target, edgeEpoch: "edge-1", initiator: true }],
    store: source, clock, transport, localPresence: () => [], authoritativeHome: () => null });
  const within = async (promise: Promise<void>) => { let timer!: ReturnType<typeof setTimeout>; try {
    await Promise.race([promise, new Promise<void>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("fixture did not enter exchange")), 3500); })]);
  } finally { clearTimeout(timer); } };
  try {
    await fixture.configure({ machines: [machine], roamFixture: { executeIntercomFixture: true } });
    await fixture.writeRoamFile(target.alias, join(globalRoot, "roam", "machine.json"), Buffer.from(JSON.stringify({ machineId: B })));
    await receiver.start(); await sender.start(); await within(waiting);
    const pids = JSON.parse(readFileSync(join(fixture.root, "helper-pids.jsonl"), "utf8").trim());
    expect(pids.pid).toBeGreaterThan(0); expect(pids.parentPid).toBeGreaterThan(0);
    const start = performance.now(); await sender.stop(); await within(remoteDone);
    expect(performance.now() - start).toBeLessThan(3000);
    for (const pid of [pids.pid, pids.parentPid]) {
      let gone = false; try { process.kill(pid, 0); } catch (error) { gone = (error as NodeJS.ErrnoException).code === "ESRCH"; }
      expect(gone).toBe(true);
    }
  } finally { await sender.stop(); await receiver.stop(); await client.close(); source.close(); inbox.close(); await fixture.close(); }
}, 5000);

import { EventEmitter, once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { openDbAt } from "@spider/db-core";
import * as hc from "@spider/herdr/client/hc";
import { HerdrError } from "@spider/herdr/client/parse";
import { IntercomClient } from "@spider/intercom/broker/client";
import * as relayBroker from "@spider/intercom/broker/roam-relay-client";
import { beginV0RelayAsk, listV0RelayLinks, pollV0RelayBroker, submitV0Relay } from "@spider/intercom/broker/roam-relay-client";
import { requestV0Broker } from "@spider/intercom/broker/roam-v0-client";
import { decodeRelayPoll, relayRefused, type RelayPeer, type RelayPoll, type RelayPollReply, type RelayResult, type RelaySubmit } from "@spider/intercom/relay-protocol";
import type { V0Endpoint, V0RouteResult } from "@spider/intercom/roam-v0";
import { registerIntercomOnce } from "@spider/intercom/single-instance";
import { startTestBroker, stopTestBroker, testBrokerEnv, testTmpDir } from "@spider/intercom/test-support";
import type { LocalSessionInfo } from "@spider/intercom/types";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { buildIntercom } from "../../../../scripts/build-intercom.mjs";
import type { Peer, Transport } from "../contracts";
import { createV0Intercom, createV0RelayForwarder } from "../relocate/intercom";
import { routeV0Relay } from "../relocate/intercom-relay-route";
import { runRelayPollLoop, runV0LinkOnce } from "../relocate/relay-poll";

const RELAY = "11111111-1111-4111-8111-111111111111";
const BACKUP = "55555555-5555-4555-8555-555555555555";
const ORIGIN = "22222222-2222-4222-8222-222222222222";
const TARGET = "33333333-3333-4333-8333-333333333333";
const SCOPE = "fixture-scope";
const relay: RelayPeer = { machineId: RELAY, alias: "relay-1.invalid" };
const backupRelay: RelayPeer = { machineId: BACKUP, alias: "relay-2.invalid" };
const origin: RelayPeer = { machineId: ORIGIN, alias: "sender.invalid" };
const target: RelayPeer = { machineId: TARGET, alias: "target.invalid" };
const roots: string[] = [];
const cleanups: (() => Promise<unknown>)[] = [];
const brokerBuild = mkdtempSync(join(testTmpDir(), "rr-build-"));

beforeAll(() => buildIntercom(brokerBuild));
afterAll(() => rmSync(brokerBuild, { recursive: true, force: true }));
afterEach(async () => {
  try { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); }
  finally {
    vi.restoreAllMocks();
    vi.useRealTimers();
    vi.unstubAllEnvs();
    for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
  }
});

function machine(identity: RelayPeer) {
  const root = mkdtempSync(join(testTmpDir(), "rr-"));
  roots.push(root);
  const agentDir = join(root, "agent");
  for (const dir of ["agent", "roam", "herdr"]) mkdirSync(join(root, dir), { mode: 0o700 });
  const write = (file: string, value: unknown) => writeFileSync(join(root, file), JSON.stringify(value), { mode: 0o600 });
  const { machineId, alias } = identity;
  write("roam/config.json", { enabled: true, role: machineId === RELAY ? "hub" : "box", machineId, hubMachineId: RELAY,
    peers: [], discoveryRoots: [], coreUnit: "fixture.service", intercom: { enabled: false, machineAlias: alias } });
  write("roam/machine.json", { machineId });
  write("herdr/config.json", { mode: "core-only", core: { binary: "/usr/bin/env", config: join(root, "core.toml") },
    globalRoot: root, agentDirectory: agentDir, shellRc: join(root, "shell.rc"), machines: [] });
  const db = openDbAt(join(root, "spider.db"), "global");
  try {
    db.prepare("UPDATE roam_meta SET machine_id=?,store_key='global' WHERE id=1").run(machineId);
    const home = db.prepare("INSERT INTO session_homes (session_id,machine_id,epoch,updated_at,state) VALUES (?,?,?,1,'running')");
    home.run("source", ORIGIN, 1);
    home.run("local-recipient", ORIGIN, 2);
    home.run("remote-recipient", TARGET, 3);
  } finally { db.close(); }
  const peer: Peer = { ...identity, node: "/node", pi: "/pi", cli: "/spider", core: "/core", globalRoot: root, agentDir };
  return { root, agentDir, peer, configure: (routes: object) => write("roam/intercom-v0.json", {
    version: 2, sendTo: [], acceptFrom: [], relays: [RELAY], ...routes,
  }) };
}
type Machine = ReturnType<typeof machine>;

async function startBroker(m: Machine, fakeTime = false) {
  const file = join(brokerBuild, "broker.mjs");
  const clock = `import { mock } from "node:test";
    mock.timers.enable({ apis: ["setTimeout"] });
    let now = 0;
    Object.defineProperty(globalThis.performance, "now", { value: () => now });
    process.on("message", ms => { now += ms; mock.timers.tick(ms); process.send(now); });
    await import(${JSON.stringify(pathToFileURL(file).href)});`;
  const broker = startTestBroker(process.execPath, fakeTime ? ["--input-type=module", "-e", clock] : [file], {
    env: { ...testBrokerEnv(), SPIDER_GLOBAL_ROOT: m.root, PI_CODING_AGENT_DIR: m.agentDir },
    stdio: ["ignore", "pipe", "pipe", ...(fakeTime ? ["ipc" as const] : [])],
  });
  cleanups.push(() => stopTestBroker(broker));
  const [output] = await once(broker.stdout!, "data");
  expect(String(output)).toContain("Intercom broker started");
  return async (ms: number) => { const advanced = once(broker, "message"); broker.send(ms); await advanced; };
}

function openLink(m: Machine, relay: RelayPeer, defaultReach: readonly RelayPeer[]) {
  const abort = new AbortController();
  let pollId = 0;
  const calls: Promise<RelayPollReply>[] = [];
  cleanups.push(async () => { abort.abort(); await Promise.all(calls); });
  return { abort, poll(holdMs: RelayPoll["holdMs"], results: readonly RelayResult[] = [], peers = defaultReach) {
    const call = pollV0RelayBroker(m.agentDir, { holdMs,
      hello: { type: "hello", version: 1, relay, toMachineId: m.peer.machineId, linkId: "fixture-link", pollId: `poll-${++pollId}` },
      reach: { type: "reach", peers }, results,
    }, abort.signal);
    calls.push(call);
    return call;
  } };
}

async function liveEndpoint(m: Machine, id: string): Promise<V0Endpoint> {
  const result = await requestV0Broker(m.agentDir, { kind: "lookup", scopeId: SCOPE, selector: { by: "id", value: id } });
  if (result.kind !== "matches" || result.targets.length !== 1) throw new Error(`Missing live endpoint ${id}`);
  return result.targets[0];
}

async function register(m: Machine, sessionId: string, name: string, epoch: number) {
  vi.stubEnv("PI_CODING_AGENT_DIR", m.agentDir);
  const client = new IntercomClient();
  cleanups.push(() => client.disconnect());
  const inbox: string[] = [];
  client.on("message", (_from, message) => inbox.push(message.id));
  await client.connect({ address: { sessionId, scopeId: SCOPE }, name, v0HomeEpoch: epoch, cwd: m.root,
    model: "fixture", pid: process.pid, startedAt: 1, lastActivity: 1 }, `live-${sessionId}`);
  vi.stubEnv("PI_CODING_AGENT_DIR", undefined);
  return { client, async received() { await client.listSessions(); return inbox; } };
}

async function startTool(m: Machine, intercom: ReturnType<typeof createV0Intercom>, session = { id: "source", epoch: 1, idle: true }) {
  const hooks = new Map<string, ((event: unknown, ctx: unknown) => unknown)[]>();
  const tools: ToolDefinition[] = [];
  const bus = new EventEmitter();
  const pi = {
    events: { on(name: string, handler: (value: unknown) => void) { bus.on(name, handler); return () => bus.off(name, handler); },
      emit(name: string, value: unknown) { bus.emit(name, value); } },
    on(name: string, handler: (event: unknown, ctx: unknown) => unknown) { hooks.set(name, [...(hooks.get(name) ?? []), handler]); },
    getSessionName: () => session.id, setSessionName() {}, registerMessageRenderer() {}, registerShortcut() {}, registerCommand() {},
    appendEntry() {}, sendMessage() {}, registerTool(tool: ToolDefinition) { tools.push(tool); }, getAllTools: () => tools,
    getActiveTools: () => tools.map(tool => tool.name), setActiveTools() {},
  };
  const ctx = { cwd: m.root, mode: "rpc", model: { id: "fixture" }, hasUI: false,
    sessionManager: { getSessionId: () => session.id, getEntries: () => [] }, isIdle: () => session.idle,
    hasPendingMessages: () => false, ui: { notify() {}, getEditorText: () => "" } };
  const emit = async (name: string) => { for (const hook of hooks.get(name) ?? []) await hook({ reason: "startup" }, ctx); };
  vi.stubEnv("PI_CODING_AGENT_DIR", m.agentDir);
  registerIntercomOnce(pi as never, undefined, { prepare: intercom.prepare, prepareReply: intercom.prepareReply,
    homeEpoch: id => id === session.id ? session.epoch : undefined });
  cleanups.push(() => emit("session_shutdown"));
  await emit("session_start");
  const tool = tools.find(item => item.name === "intercom")!;
  return async (to: string, action: "send" | "ask" | "reply" = "send", message = "fixture message") => {
    const { content, details } = await tool.execute("route-fixture", { action, ...(action === "reply" ? { replyTo: to } : { to }), message },
      undefined, undefined, ctx as unknown as ExtensionToolContext);
    if (content[0]?.type !== "text" || !details || typeof details !== "object") throw new Error("Missing intercom tool result");
    return { content: [content[0]], details: details as Record<string, unknown> };
  };
}

async function fixture(options: { direct?: boolean; reached?: readonly RelayPeer[]; link?: boolean; targetGrant?: boolean;
  secondRelay?: boolean; fakeTime?: boolean } = {}) {
  vi.stubEnv("PI_SUBAGENT_CHILD", "0");
  vi.stubEnv("PI_INTERCOM_SCOPE_ID", SCOPE);
  const sender = machine(origin), receiver = machine(target), carrier = machine(relay);
  const relays = options.secondRelay ? [RELAY, BACKUP] : [RELAY];
  sender.configure({ sendTo: options.direct ? [receiver.peer] : [], acceptFrom: [target], relays });
  receiver.configure({ acceptFrom: options.targetGrant === false ? [] : [origin], relays });
  const configureCarrier = (machine: Machine) => machine.configure({ sendTo: [sender.peer, receiver.peer], linkTo: [ORIGIN], relays });
  configureCarrier(carrier);
  const advance = await startBroker(sender, options.fakeTime);
  await startBroker(receiver);
  const local = await register(sender, "local-recipient", "local", 2);
  const remote = await register(receiver, "remote-recipient", "recipient", 3);

  const faults = { lost: false, lostRoute: false, routeMissing: false, disconnected: false, badPin: false, resolveFailed: false,
    targetRefusesDelivery: false, lookupFailureMachineId: "" };
  const targetIntercom = createV0Intercom(receiver.root, { transport: () => transport(), broker: async (agentDir, op, signal) => {
    if (faults.targetRefusesDelivery && op.kind === "deliver") return { kind: "refused", code: "unreachable" };
    return requestV0Broker(agentDir, op, signal);
  } });
  const lookupPeers: string[] = [];
  const transport = (): Pick<Transport, "resolve" | "exec"> => ({
    async resolve(p) {
      if (faults.routeMissing) throw new HerdrError("machine-not-found", "fixture has no direct route");
      if (faults.badPin) throw new HerdrError("machine-mismatch", "fixture pin mismatch");
      if (faults.resolveFailed) throw new HerdrError("cli-exit", "The remote host is unreachable");
      return p;
    },
    async exec(p, argv, request) {
      if (request.stdin) {
        lookupPeers.push(p.machineId);
        if (p.machineId === faults.lookupFailureMachineId) throw new Error("Fixture lookup failed");
      }
      const destination = p.machineId === ORIGIN ? intercom : targetIntercom;
      expect(p).toEqual(p.machineId === ORIGIN ? sender.peer : receiver.peer);
      expect(argv).toEqual(["roam", "agent", "--v0", "intercom"]);
      request.onConnected?.(!faults.disconnected);
      const bytes = request.stdin ?? request.stdinForTimeout?.(request.timeoutMs - 2000);
      if (!bytes) throw new Error("Missing request");
      const reply = await destination.handle(JSON.parse(bytes.toString("utf8")));
      if (faults.lost && request.stdinForTimeout) throw new Error("Fixture lost the delivery acknowledgement");
      if (faults.lostRoute && request.stdinForTimeout) throw new HerdrError("machine-not-found", "fixture lost the route after delivery");
      return Buffer.from(JSON.stringify(reply));
    },
  });
  const intercom = createV0Intercom(sender.root, { transport });
  const tool = await startTool(sender, intercom);
  async function roster() {
    const locals = (await local.client.listSessions()).filter((session): session is LocalSessionInfo => !session.remote);
    const from = locals.find(session => session.address?.sessionId === "source")!;
    expect(from).toMatchObject({ v0HomeEpoch: 1, endpointEpoch: expect.any(String) });
    return { from, locals };
  }
  try { await vi.waitFor(roster); } finally { vi.stubEnv("PI_CODING_AGENT_DIR", undefined); }
  function link(peer: RelayPeer, defaultReach: readonly RelayPeer[] = [peer, target]) { return openLink(sender, peer, defaultReach); }
  const primary = link(relay, options.reached);
  const held = options.link === false ? null : primary.poll(20_000);
  if (held) await vi.waitFor(async () => expect(await listV0RelayLinks(sender.agentDir)).toMatchObject([{ state: "up" }]));
  const backup = options.secondRelay ? (() => {
    const secondary = machine(backupRelay);
    configureCarrier(secondary);
    return { ...link(backupRelay), forward: createV0RelayForwarder(secondary.root, { transport }) };
  })() : undefined;
  return { sender, receiver, carrier, local, remote, intercom, targetIntercom, tool, roster, faults, lookupPeers, link, advance, ...primary, held, backup,
    forward: createV0RelayForwarder(carrier.root, { transport }) };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
async function carry(f: Fixture, send: ReturnType<Fixture["tool"]>) {
  const response = await Promise.race([f.held!, send]);
  expect(response).toHaveProperty("submissions");
  if (!("submissions" in response)) throw new Error("Relay did not receive an offer");
  expect(response.submissions).toHaveLength(1);
  const [submission] = response.submissions;
  await f.poll(0, [await f.forward(submission)]);
  return { sent: await send, submission };
}

it("reports a pinned live local send without taking its available relay", async () => {
  const f = await fixture({ direct: true });
  const local = await f.tool("local-recipient");
  expect(local.details).toMatchObject({ delivered: true, path: "local" });
  expect(await f.local.received()).toEqual([local.details.messageId]);
  f.abort.abort();
  expect((await f.held!).submissions).toEqual([]);
});

it("prefers a live direct route even when a relay advertises the same home", async () => {
  const f = await fixture({ direct: true });
  const pending = f.tool("remote-recipient");
  const first = await Promise.race([f.held!, pending]);
  // Settle an unexpected relay offer so a regression reports its actual path.
  if ("submissions" in first && first.submissions.length)
    await f.poll(0, await Promise.all(first.submissions.map(offer => f.forward(offer))));
  const direct = await pending;
  expect(direct.details).toMatchObject({ delivered: true, path: "direct" });
  expect(direct.content[0]).toMatchObject({ text: expect.stringContaining("direct") });
  expect(await f.remote.received()).toEqual([direct.details.messageId]);
  f.abort.abort();
  const pollSubmissionsForDirectSend = (await f.held!).submissions;
  expect(pollSubmissionsForDirectSend).toEqual([]);
});

it("does not offer a send to the relay after losing the direct result", async () => {
  const f = await fixture({ direct: true });
  const plan = await f.intercom.prepare({ to: "remote-recipient", ...await f.roster() });
  if (plan.kind !== "remote") throw new Error("Missing direct delivery plan");
  f.faults.lost = true;
  const directLostResult = await plan.send({ id: "direct-lost", text: "one direct receipt", timestamp: 1 });
  expect(directLostResult).toMatchObject({ kind: "unknown", id: "direct-lost", path: "direct" });
  expect(await f.remote.received()).toEqual(["direct-lost"]);
  f.abort.abort();
  const pollSubmissionsAfterDirectLoss = (await f.held!).submissions;
  expect(pollSubmissionsAfterDirectLoss).toEqual([]);
});

it("does not relay after a direct hand-off whose route then disappears", async () => {
  const f = await fixture({ direct: true });
  const plan = await f.intercom.prepare({ to: "remote-recipient", ...await f.roster() });
  if (plan.kind !== "remote") throw new Error("Missing direct delivery plan");
  f.faults.lostRoute = true;
  const pending = plan.send({ id: "route-lost", text: "one receipt", timestamp: 1 });
  const first = await Promise.race([f.held!, pending]);
  f.faults.lostRoute = false;
  if ("submissions" in first && first.submissions.length)
    await f.poll(0, await Promise.all(first.submissions.map(offer => f.forward(offer))));
  const result = await pending;
  expect(await f.remote.received()).toEqual(["route-lost"]);
  expect(result).toMatchObject({ kind: "unknown", id: "route-lost", path: "direct" });
  f.abort.abort();
  expect((await f.held!).submissions).toEqual([]);
});

it.each(["no-enrollment", "missing-route", "disconnected"] as const)("relays an exact home with %s", async cause => {
  const f = await fixture({ direct: cause !== "no-enrollment" });
  if (cause === "missing-route") f.faults.routeMissing = true;
  if (cause === "disconnected") f.faults.disconnected = true;
  const pending = f.tool("remote-recipient");
  const taken = await Promise.race([f.held!, pending]);
  // The direct route is absent on the sender, not on the carrying relay.
  f.faults.routeMissing = f.faults.disconnected = false;
  expect(taken).toHaveProperty("submissions");
  const { sent, submission } = await carry(f, pending);
  expect(submission.target).toEqual({ machineId: TARGET, selector: { by: "id", value: "remote-recipient" }, homeEpoch: 3 });
  expect(sent.details).toMatchObject({ delivered: true, path: "relay relay-1.invalid" });
  expect(sent.content[0]).toMatchObject({ text: expect.stringContaining("relay-1.invalid") });
  expect(await f.remote.received()).toEqual([sent.details.messageId]);
});

it.each(["disconnected", "connected"] as const)("only relays a resolve connection error when Herdr observes the route %s", async state => {
  const f = await fixture({ direct: true });
  vi.stubEnv("HC_SOCKET", join(f.sender.root, "hc.sock"));
  vi.stubEnv("HC_SESSION", "relay-fixture");
  const observe = vi.spyOn(hc, "invokeCli").mockImplementation(async (_binary, argv, env) => {
    expect(argv).toEqual(["machine", "ls", "--json"]);
    expect(env.HC_SOCKET).toBe(join(f.sender.root, "hc.sock"));
    return { machines: [{ id: "target-core", name: target.alias, host: target.alias, target: target.alias, state }] };
  });
  f.faults.resolveFailed = true;
  const pending = f.tool("remote-recipient");
  if (state === "disconnected") {
    const taken = await Promise.race([f.held!, pending]);
    f.faults.resolveFailed = false;
    expect(taken).toHaveProperty("submissions");
    expect((await carry(f, pending)).sent.details).toMatchObject({ delivered: true, path: "relay relay-1.invalid" });
  } else {
    expect((await pending).details).toMatchObject({ code: "unreachable" });
    f.abort.abort();
    expect((await f.held!).submissions).toEqual([]);
  }
  expect(observe).toHaveBeenCalledTimes(1);
});

it("reports a version 1 direct send as direct without changing its confirmation text", async () => {
  const f = await fixture({ direct: true });
  f.sender.configure({ version: 1, sendTo: [f.receiver.peer], relays: undefined });
  const result = await f.tool("remote-recipient");
  expect(result.content[0]).toMatchObject({ text: "Sent to target.invalid/recipient (broker accepted the message)." });
  expect(result.details).toMatchObject({ delivered: true, path: "direct" });
});

it("uses advertised reach to resolve a qualified name without local enrollment", async () => {
  const f = await fixture();
  f.sender.configure({});
  const { sent, submission } = await carry(f, f.tool("target.invalid/recipient"));
  expect(submission.target).toEqual({ machineId: TARGET, selector: { by: "name", value: "recipient" } });
  expect(sent.details).toMatchObject({ delivered: true, path: "relay relay-1.invalid" });
});

it("refuses an alias conflict instead of choosing the configured or advertised machine", async () => {
  const f = await fixture({ reached: [relay, { ...target, alias: "sender.invalid" }, { ...origin, alias: "target.invalid" }] });
  expect((await f.tool("target.invalid/remote-recipient")).details).toMatchObject({ code: "ambiguous" });
});

it("refuses a bare name without complete live lookups", async () => {
  const f = await fixture();
  expect((await f.tool("recipient")).details).toMatchObject({ code: "incomplete" });
});

it("refuses a bare name when one live peer matches and another lookup fails", async () => {
  const f = await fixture({ direct: true });
  const otherId = "44444444-4444-4444-8444-444444444444";
  const other = machine({ machineId: otherId, alias: "other.invalid" });
  const db = openDbAt(join(f.sender.root, "spider.db"), "global");
  try {
    db.prepare("INSERT INTO session_homes (session_id,machine_id,epoch,updated_at,state) VALUES (?,?,?,1,'running')")
      .run("other-recipient", otherId, 4);
  } finally { db.close(); }
  f.sender.configure({ sendTo: [f.receiver.peer, other.peer] });
  f.faults.lookupFailureMachineId = otherId;
  const result = await f.intercom.prepare({ to: "recipient", ...await f.roster() });
  expect(f.lookupPeers.sort()).toEqual([TARGET, otherId].sort());
  expect(result).toEqual({ kind: "refused", code: "incomplete" });
  f.abort.abort();
  expect((await f.held!).submissions).toEqual([]);
});

it.each(["peer-pin", "trust"] as const)("does not relay on a failed %s check", async cause => {
  const f = await fixture({ direct: true, targetGrant: cause !== "trust" });
  f.faults.badPin = cause === "peer-pin";
  const result = await f.tool("remote-recipient");
  expect(result.details).toMatchObject({ error: true });
  expect(result.details.path).not.toBe("relay relay-1.invalid");
  f.abort.abort();
  expect((await f.held!).submissions).toEqual([]);
  expect(await f.remote.received()).toEqual([]);
});

it("refuses an ask without queuing it when no relay is reachable", async () => {
  const f = await fixture({ link: false });
  expect((await f.tool("remote-recipient", "ask")).details).toMatchObject({ code: "no-relay" });
  expect(await f.remote.received()).toEqual([]);
});

it("reports when no relay is reachable without queuing a send", async () => {
  const f = await fixture({ link: false });
  const refused = await f.tool("remote-recipient");
  expect(refused.content[0].text.split("\n")[0]).toBe("No relay is reachable. Nothing was queued.");
  expect(refused.details).toMatchObject({ code: "no-relay", relaySkips: [{ relay: RELAY, reason: "down" }] });
  expect(await f.remote.received()).toEqual([]);
});

it("omits the local relay from the skipped-relay list", async () => {
  const f = await fixture({ link: false });
  f.sender.configure({ relays: [ORIGIN, RELAY], acceptFrom: [relay] });
  const refused = await f.tool("remote-recipient");
  expect(refused.details).toMatchObject({ code: "no-relay", relaySkips: [{ relay: "relay-1.invalid", reason: "down" }] });
  expect(await f.remote.received()).toEqual([]);
});

it("names the unreachable home and why the live relay was skipped", async () => {
  const f = await fixture({ reached: [relay] });
  const refused = await f.tool("remote-recipient");
  expect(refused.content[0].text.split("\n")[0]).toBe("target.invalid is not reachable through any relay right now. Nothing was queued.");
  expect(refused.details).toMatchObject({ code: "relay-unreachable", targetMachine: "target.invalid",
    relaySkips: [{ relay: "relay-1.invalid", reason: "cannot reach the target" }] });
  f.sender.configure({});
  expect((await f.tool("remote-recipient")).content[0].text.split("\n")[0]).toBe(`${TARGET} is not reachable through any relay right now. Nothing was queued.`);
});

async function fillPrimary(f: Fixture) {
  expect((await f.poll(0)).ready.ok).toBe(true);
  const { from } = await f.roster();
  const submissions = Array.from({ length: 16 }, (_, i): RelaySubmit => ({ type: "submit", kind: "send",
    from: { machineId: ORIGIN, address: from.address!, name: from.name!, homeEpoch: 1, endpointEpoch: from.endpointEpoch! },
    target: { machineId: TARGET, selector: { by: "id", value: "remote-recipient" } },
    message: { id: `busy-${i}`, timestamp: 1, text: "occupy slot" } }));
  const inflight = submissions.map(submission => submitV0Relay(f.sender.agentDir, RELAY, submission, f.abort.signal));
  cleanups.push(async () => { f.abort.abort(); await Promise.all(inflight); });
  const taken: RelaySubmit[] = [];
  await vi.waitFor(async () => { taken.push(...(await f.poll(0)).submissions); expect(taken).toHaveLength(16); });
}

it("reports relay busy without taking a seventeenth submission", async () => {
  const f = await fixture({ link: false });
  await fillPrimary(f);
  const refused = await f.tool("remote-recipient");
  expect(refused.content[0].text.split("\n")[0]).toBe("Relay busy. Nothing was queued.");
  expect(refused.details).toMatchObject({ code: "relay-busy", relaySkips: [{ relay: "relay-1.invalid", reason: "busy" }] });
  expect((await f.poll(0)).submissions).toEqual([]);
});

async function twoRelays() {
  const f = await fixture({ link: false, secondRelay: true });
  if (!f.backup) throw new Error("Missing backup relay fixture");
  return { ...f, backup: f.backup };
}

async function sendPlan(f: Fixture) {
  const plan = await f.intercom.prepare({ to: "remote-recipient", ...await f.roster() });
  if (plan.kind !== "remote") throw new Error("Missing relay delivery plan");
  return plan.send;
}

function marker(id: string) { return { id, text: id, timestamp: 1 }; }

async function settleOffers(held: Promise<RelayPollReply>, send: Promise<V0RouteResult>,
  complete: (submit: RelaySubmit) => Promise<unknown>): Promise<string[]> {
  const reply = await Promise.race([held, send]);
  if (!("submissions" in reply)) return [];
  for (const submit of reply.submissions) await complete(submit);
  return reply.submissions.map(submit => submit.message.id);
}

type TestLink = Pick<Fixture, "poll" | "forward">;
const deliverOffer = (link: TestLink) => async (submit: RelaySubmit) => link.poll(0, [await link.forward(submit)]);

it("uses configured order when links arrive in reverse order and their reach changes", async () => {
  const f = await twoRelays();
  expect((await f.backup.poll(0)).ready.ok).toBe(true);
  expect((await f.poll(0)).ready.ok).toBe(true);
  expect((await listV0RelayLinks(f.sender.agentDir)).map(link => link.relay.alias)).toEqual(["relay-2.invalid", "relay-1.invalid"]);
  const send = await sendPlan(f);
  let primaryHeld = f.poll(20_000), backupHeld = f.backup.poll(20_000);
  async function deliver(id: string) {
    const pending = send(marker(id));
    const offers = await Promise.all([
      settleOffers(primaryHeld, pending, deliverOffer(f)),
      settleOffers(backupHeld, pending, deliverOffer(f.backup)),
    ]);
    expect(offers.flat()).toEqual([id]);
    const result = await pending;
    expect(result).toMatchObject({ kind: "socket_delivered", id });
    return result;
  }
  const firstSelected = await deliver("preferred");
  expect(firstSelected.path).toBe("relay relay-1.invalid");

  primaryHeld = f.poll(20_000, [], [relay]);
  await vi.waitFor(async () => expect(await listV0RelayLinks(f.sender.agentDir)).toMatchObject([
    { relay: backupRelay, state: "up", reach: [backupRelay, target] },
    { relay, state: "up", reach: [relay] },
  ]));
  const withoutReach = await deliver("reach-withdrawn");
  expect(withoutReach).toMatchObject({ path: "relay relay-2.invalid",
    relaySkips: [{ relay: "relay-1.invalid", reason: "cannot reach the target" }] });

  expect((await f.poll(0)).ready.ok).toBe(true);
  backupHeld = f.backup.poll(20_000);
  const nextAfterPrimaryRecovers = await deliver("preferred-again");
  expect(nextAfterPrimaryRecovers.path).toBe("relay relay-1.invalid");
  expect(await f.remote.received()).toEqual(["preferred", "reach-withdrawn", "preferred-again"]);
});

it.each(["unreachable", "relay-stopping"] as const)("switches after an explicit pre-delivery %s refusal", async code => {
  const f = await twoRelays();
  // With no held call, the primary is still up but the broker must expire its offer before hand-off.
  expect((await f.poll(0)).ready.ok).toBe(true);
  expect((await f.backup.poll(0)).ready.ok).toBe(true);
  const primaryHeld = code === "relay-stopping" ? f.poll(20_000) : undefined;
  const backupHeld = f.backup.poll(20_000);
  const send = await sendPlan(f);
  const pending = send(marker("safe-refusal"));
  const [backupOffers, stoppedOffers] = await Promise.all([
    settleOffers(backupHeld, pending, deliverOffer(f.backup)),
    primaryHeld ? settleOffers(primaryHeld, pending, submit => f.poll(0, [relayRefused(submit.message.id, code)])) : [],
  ]);
  const secondAfterSafeRefusal = await pending;
  expect(secondAfterSafeRefusal).toMatchObject({ kind: "socket_delivered", id: "safe-refusal", path: "relay relay-2.invalid" });
  expect(backupOffers).toEqual(["safe-refusal"]);
  expect(stoppedOffers).toEqual(code === "relay-stopping" ? ["safe-refusal"] : []);
  expect((await f.poll(0)).submissions).toEqual([]);
  expect(await f.remote.received()).toEqual(["safe-refusal"]);
});

it("skips down, unreachable, and busy relays in configured order", async () => {
  const f = await twoRelays();
  const down = { machineId: "66666666-6666-4666-8666-666666666666", alias: "relay-down.invalid" };
  const noTarget = { machineId: "77777777-7777-4777-8777-777777777777", alias: "relay-no-target.invalid" };
  f.sender.configure({ relays: [down.machineId, noTarget.machineId, RELAY, BACKUP], acceptFrom: [target, down] });
  expect((await f.link(noTarget, [noTarget]).poll(0)).ready.ok).toBe(true);
  await fillPrimary(f);
  expect((await f.backup.poll(0)).ready.ok).toBe(true);
  const backupHeld = f.backup.poll(20_000);
  const send = await sendPlan(f);
  const pending = send(marker("after-busy"));
  const backupOffers = await settleOffers(backupHeld, pending, deliverOffer(f.backup));
  const result = await pending;
  expect(result).toMatchObject({ kind: "socket_delivered", id: "after-busy", path: "relay relay-2.invalid" });
  const skipReasons = result.relaySkips?.map(skip => skip.reason);
  expect(skipReasons).toEqual(["down", "cannot reach the target", "busy"]);
  expect(backupOffers).toEqual(["after-busy"]);
  expect(await f.remote.received()).toEqual(["after-busy"]);
});

it.each(["unreachable", "unauthorized", "changed"] as const)("does not switch after a final %s refusal", async code => {
  const f = await twoRelays();
  expect((await f.poll(0)).ready.ok).toBe(true);
  expect((await f.backup.poll(0)).ready.ok).toBe(true);
  const primaryHeld = f.poll(20_000), backupHeld = f.backup.poll(20_000);
  if (code === "changed") {
    const db = openDbAt(join(f.carrier.root, "spider.db"), "global");
    try { db.prepare("UPDATE session_homes SET epoch=4 WHERE session_id='remote-recipient'").run(); }
    finally { db.close(); }
  }
  if (code === "unauthorized") f.receiver.configure({ acceptFrom: [], relays: [RELAY, BACKUP] });
  f.faults.targetRefusesDelivery = code === "unreachable";
  const send = await sendPlan(f);
  const pending = send(marker("refused"));
  const [firstOffers, backupOffers] = await Promise.all([
    settleOffers(primaryHeld, pending, async submit => {
      const result = await f.forward(submit);
      f.faults.targetRefusesDelivery = false;
      expect(result).toEqual({ type: "result", messageId: "refused", attempted: code === "unreachable", outcome: { kind: "refused", code } });
      await f.poll(0, [result]);
    }),
    settleOffers(backupHeld, pending, deliverOffer(f.backup)),
  ]);
  expect(firstOffers).toEqual(["refused"]);
  expect(backupOffers).toEqual([]);
  expect(await pending).toMatchObject({ kind: "refused", code, path: "relay relay-1.invalid" });
  expect(await f.remote.received()).toEqual([]);
});

it("does not switch after a lost result", async () => {
  const f = await twoRelays();
  const stop = new AbortController();
  let firstCallMs = 0, lostResult: RelayResult | undefined, overlappingHold = false;
  const running = runRelayPollLoop({ relay, peer: f.sender.peer, signal: stop.signal, reach: () => [relay, target],
    clock: { now: Date.now, later(ms, fn) { const timer = setTimeout(fn, ms); return () => clearTimeout(timer); } },
    forward: f.forward, observe() {}, transport: {
      async resolve(peer) { return peer; },
      async exec(_peer, argv, options) {
        const holdMs = argv.at(-1) === "0" ? 0 : 20_000;
        if (holdMs === 0) {
          lostResult = decodeRelayPoll(options.stdin!, 0).results[0];
          await vi.waitFor(async () => {
            const first = (await listV0RelayLinks(f.sender.agentDir)).find(link => link.relay.machineId === RELAY);
            expect(first).toMatchObject({ state: "up" });
            expect(first?.lastCallMs).toBeGreaterThan(firstCallMs);
          });
          overlappingHold = true;
          throw new Error("Fixture lost the hold-0 call before returning its result");
        }
        return runV0LinkOnce(f.sender.root, options.stdin!, holdMs, options.signal);
      },
    } });
  cleanups.push(async () => { stop.abort(); await running; });
  await vi.waitFor(async () => {
    const [first] = await listV0RelayLinks(f.sender.agentDir);
    expect(first).toMatchObject({ relay, state: "up", lastCallMs: expect.any(Number) });
    firstCallMs = first.lastCallMs!;
  });
  expect((await f.backup.poll(0)).ready.ok).toBe(true);
  const backupHeld = f.backup.poll(20_000);
  const send = await sendPlan(f);
  const pending = send(marker("lost"));
  const backupOffers = await settleOffers(backupHeld, pending, deliverOffer(f.backup));
  const lost = await pending;
  expect(lostResult).toEqual({ type: "result", messageId: "lost", attempted: true, outcome: { kind: "socket_delivered", id: "lost" } });
  expect(overlappingHold).toBe(true);
  expect(backupOffers).toEqual([]);
  expect(lost).toMatchObject({ kind: "unknown", id: "lost", path: "relay relay-1.invalid" });
  expect(await f.remote.received()).toEqual(["lost"]);
});

it("an unclaimed second offer that meets the route deadline", async () => {
  const f = await twoRelays();
  expect((await f.poll(0)).ready.ok).toBe(true);
  expect((await f.backup.poll(0)).ready.ok).toBe(true);
  const { from } = await f.roster();
  const submit: RelaySubmit = { type: "submit", kind: "send", message: marker("late-offer"),
    from: { machineId: ORIGIN, address: from.address!, name: from.name!, homeEpoch: 1, endpointEpoch: from.endpointEpoch! },
    target: { machineId: TARGET, selector: { by: "id", value: "remote-recipient" }, homeEpoch: 3 } };
  const result = await routeV0Relay({ version: 2, agentDir: f.sender.agentDir, sendTo: [], acceptFrom: [target], relays: [RELAY, BACKUP], linkTo: [] },
    ORIGIN, "target.invalid", submit, AbortSignal.timeout(3_000), performance.now() + 3_000);
  expect(result).toMatchObject({ kind: "refused", relaySkips: [{ relay: relay.alias }, { relay: backupRelay.alias }] });
  expect((await f.poll(0)).submissions).toEqual([]);
  expect((await f.backup.poll(0)).submissions).toEqual([]);
  expect(await f.remote.received()).toEqual([]);
});

it.each([
  { elapsed: 19_500, withinBudget: true },
  { elapsed: 19_999, withinBudget: false },
  { elapsed: 20_001, withinBudget: false },
])("shares the v0 deadline across relay choices after $elapsed ms", async ({ elapsed, withinBudget }) => {
  vi.useFakeTimers({ toFake: ["performance"] });
  vi.spyOn(relayBroker, "listV0RelayLinks").mockResolvedValue([relay, backupRelay].map(carrier => ({
    relay: carrier, reach: [carrier, target], state: "up", linkId: carrier.alias, sinceMs: 1, lastCallMs: 1,
    lastError: null, messagesCarried: 0,
  })));
  const offers: string[] = [];
  vi.spyOn(relayBroker, "submitV0Relay").mockImplementation(async (_agent, id, submit) => {
    offers.push(id);
    if (id === RELAY) {
      vi.advanceTimersByTime(elapsed);
      return relayRefused(submit.message.id, "unreachable");
    }
    return { type: "result", messageId: submit.message.id, attempted: true, outcome: { kind: "socket_delivered", id: submit.message.id } };
  });
  const result = await routeV0Relay({ version: 2, agentDir: "/fixture", sendTo: [], acceptFrom: [], relays: [RELAY, BACKUP], linkTo: [] },
    ORIGIN, target.alias, { type: "submit", kind: "send", message: marker("budget"),
      from: { machineId: ORIGIN, address: { sessionId: "source", scopeId: SCOPE }, name: "source", homeEpoch: 1, endpointEpoch: "live-source" },
      target: { machineId: TARGET, selector: { by: "id", value: "remote-recipient" } },
    });
  if (withinBudget) {
    expect(result).toMatchObject({ kind: "socket_delivered", id: "budget", path: "relay relay-2.invalid" });
    expect(offers).toEqual([RELAY, BACKUP]);
  } else {
    expect(result).toMatchObject({ kind: "refused", code: "unreachable" });
    expect(offers).toEqual([RELAY]);
  }
});

async function takeOffer(held: Promise<RelayPollReply>, pending: Promise<unknown>, id: string, kind: RelaySubmit["kind"]) {
  const next = await Promise.race([held, pending]);
  expect(next).toHaveProperty("submissions");
  const { submissions } = next as RelayPollReply;
  expect(submissions).toMatchObject([{ kind, message: { id } }]);
  return submissions[0];
}

async function askPlan(f: Fixture, to = "remote-recipient") {
  const plan = await f.intercom.prepare({ to, ...await f.roster() });
  if (plan.kind !== "remote") throw new Error("Missing remote ask plan");
  return plan.ask;
}

async function replier(f: Fixture) {
  const session = (await f.remote.client.listSessions()).find((entry): entry is LocalSessionInfo =>
    !entry.remote && entry.address?.sessionId === "remote-recipient");
  if (!session) throw new Error("Missing live replier");
  return session;
}

async function stopPrimary(f: Fixture) {
  const current = async () => (await listV0RelayLinks(f.sender.agentDir)).find(link => link.relay.machineId === RELAY);
  const previous = (await current())?.lastCallMs ?? 0;
  const held = f.poll(20_000);
  await vi.waitFor(async () => expect((await current())?.lastCallMs).toBeGreaterThan(previous));
  f.abort.abort();
  await held;
  await vi.waitFor(async () => expect(await current()).toMatchObject({ state: "down", lastError: "poll-closed" }));
}

it("settles a delivered ask once through the backup after the original relay stops", async () => {
  const f = await twoRelays();
  const reverse = openLink(f.receiver, backupRelay, [backupRelay, origin]);
  expect((await f.poll(0)).ready.ok).toBe(true);
  expect((await reverse.poll(0)).ready.ok).toBe(true);
  const firstHeld = f.poll(20_000), replyHeld = reverse.poll(20_000);
  const ask = await askPlan(f, "target.invalid/recipient");
  const outcomes: V0RouteResult[] = [];
  const pending = ask(marker("ask-1"), 60_000).then(result => { outcomes.push(result); return result; });
  const offer = await takeOffer(firstHeld, pending, "ask-1", "ask");
  const delivered = await f.forward(offer);
  expect(delivered).toEqual({ type: "result", messageId: "ask-1", attempted: true, outcome: { kind: "socket_delivered", id: "ask-1" } });
  await f.poll(0, [delivered]);
  expect((await listV0RelayLinks(f.sender.agentDir))[0]).toMatchObject({ messagesCarried: 1 });
  expect(await f.remote.received()).toEqual(["ask-1"]);
  await stopPrimary(f);
  expect(outcomes).toEqual([]);

  const from = await replier(f);
  const reply = f.targetIntercom.prepareReply({ from, askId: "ask-1", message: { ...marker("answer-1"), text: "answer" } });
  const replyOffer = await takeOffer(replyHeld, reply, "answer-1", "reply");
  await reverse.poll(0, [await f.backup.forward(replyOffer)]);
  expect(await reply).toMatchObject({ kind: "socket_delivered", path: "relay relay-2.invalid" });
  expect(await pending).toMatchObject({ kind: "replied", id: "ask-1", text: "answer", path: "relay relay-1.invalid" });
  expect(outcomes).toHaveLength(1);
  // The receiving broker rejects a second reply and does not inject it as a new message.
  const duplicateHeld = reverse.poll(20_000);
  const duplicate = f.targetIntercom.prepareReply({ from, askId: "ask-1", message: marker("answer-2") });
  const next = await Promise.race([duplicateHeld, duplicate]);
  if ("submissions" in next) await reverse.poll(0, await Promise.all(next.submissions.map(value => f.backup.forward(value))));
  expect(await duplicate).toMatchObject({ kind: "refused" });
  expect(await f.remote.received()).toEqual(["ask-1"]);
});

it.each([false, true])("never resends an ask after a lost acknowledgement (reply: %s)", async replyArrives => {
  const f = await fixture({ link: false, secondRelay: true, fakeTime: true });
  const backup = f.backup!;
  expect((await f.poll(0)).ready.ok).toBe(true);
  expect((await backup.poll(0)).ready.ok).toBe(true);
  const primaryHeld = f.poll(20_000), backupHeld = backup.poll(20_000);
  const submit = relayBroker.submitV0Relay;
  let observePrimaryResult!: (result: RelayResult) => void;
  const primaryResult = new Promise<RelayResult>(resolve => { observePrimaryResult = resolve; });
  const offers: string[] = [];
  vi.spyOn(relayBroker, "submitV0Relay").mockImplementation(async (...args) => {
    offers.push(args[1]);
    const result = await submit(...args);
    if (args[1] === RELAY) observePrimaryResult(result);
    return result;
  });
  const ask = await askPlan(f);
  const pending = ask(marker("ask-lost"), 540_000);
  const taken = await takeOffer(primaryHeld, pending, "ask-lost", "ask");
  expect(await f.forward(taken)).toMatchObject({ attempted: true, outcome: { kind: "socket_delivered", id: "ask-lost" } });
  // The real recipient has the question, but the hold-0 result never reaches the origin.
  await stopPrimary(f);
  expect(await primaryResult).toMatchObject({ attempted: true, outcome: { kind: "unknown", id: "ask-lost" } });
  const links = await listV0RelayLinks(f.sender.agentDir);
  expect(links.find(link => link.relay.machineId === RELAY)).toMatchObject({ messagesCarried: 0 });
  expect(offers).toEqual([RELAY]);
  if (replyArrives) {
    f.receiver.configure({ sendTo: [f.sender.peer], acceptFrom: [origin], relays: [RELAY, BACKUP] });
    const reply = await f.targetIntercom.prepareReply({ from: await replier(f), askId: "ask-lost", message: marker("late-ack-answer") });
    expect(reply).toMatchObject({ kind: "socket_delivered", path: "direct" });
    expect(await pending).toMatchObject({ kind: "replied", id: "ask-lost", text: "late-ack-answer" });
  } else {
    await f.advance(540_000);
    expect(await pending).toMatchObject({ kind: "unknown", id: "ask-lost" });
  }
  backup.abort.abort();
  const offersAfterLostAskAck = [...(await backupHeld).submissions];
  expect(offersAfterLostAskAck).toHaveLength(0);
  expect(await f.remote.received()).toEqual(["ask-lost"]);
});

it("confirmed delivery without a reply returns no_reply at the deadline", async () => {
  const f = await fixture({ fakeTime: true });
  const ask = await askPlan(f);
  const pending = ask(marker("ask-quiet"), 540_000);
  const taken = await takeOffer(f.held!, pending, "ask-quiet", "ask");
  const result = await f.forward(taken);
  expect(result).toMatchObject({ attempted: true, outcome: { kind: "socket_delivered", id: "ask-quiet" } });
  await f.poll(0, [result]);
  await f.advance(540_000);
  expect(await pending).toMatchObject({ kind: "no_reply", id: "ask-quiet", path: "relay relay-1.invalid" });
  expect(await f.remote.received()).toEqual(["ask-quiet"]);
});

it("the broker refuses an ask submission without its own waiter", async () => {
  const f = await fixture();
  const { from } = await f.roster();
  const source = { machineId: ORIGIN, address: from.address!, name: from.name!, homeEpoch: 1, endpointEpoch: from.endpointEpoch! };
  const ask = (id: string, value: string): RelaySubmit => ({ type: "submit", kind: "ask", timeoutMs: 60_000, from: source, message: marker(id),
    target: { machineId: TARGET, selector: { by: "id", value }, homeEpoch: 3 } });
  expect(await submitV0Relay(f.sender.agentDir, RELAY, ask("no-waiter", "remote-recipient")))
    .toEqual({ type: "result", messageId: "no-waiter", attempted: false, outcome: { kind: "refused", code: "unauthorized" } });
  const waiter = await beginV0RelayAsk(f.sender.agentDir, { from: source, askId: "other-target", timeoutMs: 60_000,
    target: { machineId: TARGET, selector: { by: "id", value: "remote-recipient" }, homeEpoch: 3 } });
  cleanups.push(async () => { waiter.close(); await waiter.result; });
  expect(await submitV0Relay(f.sender.agentDir, RELAY, ask("other-target", "someone-else")))
    .toMatchObject({ attempted: false, outcome: { kind: "refused", code: "unauthorized" } });
  f.abort.abort();
  expect((await f.held!).submissions).toEqual([]);
});

it("uses the routed reply for a busy non-interactive recipient", async () => {
  const f = await fixture();
  await f.remote.client.disconnect();
  f.receiver.configure({ sendTo: [f.sender.peer], acceptFrom: [origin] });
  await startTool(f.receiver, f.targetIntercom, { id: "remote-recipient", epoch: 3, idle: false });
  await vi.waitFor(() => liveEndpoint(f.receiver, "remote-recipient"));
  vi.stubEnv("PI_CODING_AGENT_DIR", undefined);
  const ask = await askPlan(f);
  const pending = ask(marker("ask-busy"), 60_000);
  const question = await takeOffer(f.held!, pending, "ask-busy", "ask");
  const result = await f.forward(question);
  await f.poll(0, [result]);
  expect(result).toMatchObject({ outcome: { kind: "socket_delivered" } });
  expect(await pending).toMatchObject({ kind: "replied", id: "ask-busy", text: expect.stringContaining("non-interactive mode") });
});

it("accepts a reply locally on an undialable hub but no unsolicited message or remote reply", async () => {
  vi.stubEnv("PI_INTERCOM_SCOPE_ID", SCOPE);
  vi.stubEnv("PI_CODING_AGENT_DIR", undefined);
  const hub = machine(relay), box = machine(target);
  for (const m of [hub, box]) {
    const db = openDbAt(join(m.root, "spider.db"), "global");
    try { db.prepare("INSERT INTO session_homes (session_id,machine_id,epoch,updated_at,state) VALUES ('hub-asker',?,2,1,'running')").run(RELAY); }
    finally { db.close(); }
  }
  hub.configure({ sendTo: [box.peer], acceptFrom: [target], linkTo: [TARGET] });
  box.configure({ acceptFrom: [relay] });
  await startBroker(hub);
  await startBroker(box);
  const asker = await register(hub, "hub-asker", "hub", 2);
  const receiver = await register(box, "remote-recipient", "recipient", 3);
  const to = await liveEndpoint(hub, "hub-asker"), from = await liveEndpoint(box, "remote-recipient");
  const hubWire = { ...to, machineId: RELAY }, boxWire = { ...from, machineId: TARGET };
  const boxIntercom = createV0Intercom(box.root), hubIntercom = createV0Intercom(hub.root);
  const waiter = await beginV0RelayAsk(hub.agentDir, { from: hubWire, askId: "hub-ask", timeoutMs: 60_000,
    target: { machineId: TARGET, selector: { by: "id", value: "remote-recipient" }, homeEpoch: 3 } });
  cleanups.push(async () => { waiter.close(); await waiter.result; });
  const outbound = { version: 1, requestId: "hub-ask", toMachineId: TARGET, from: hubWire, kind: "deliver", target: from, message: marker("hub-ask") };
  expect(await boxIntercom.handle({ version: 2, relayId: RELAY, request: outbound, thread: { kind: "ask", timeoutMs: 60_000 } }))
    .toMatchObject({ kind: "socket_delivered" });
  expect(await receiver.received()).toEqual(["hub-ask"]);
  const unsolicited = { version: 1, requestId: "unsolicited", toMachineId: RELAY, from: boxWire, kind: "deliver", target: to, message: marker("unsolicited") };
  expect(await hubIntercom.handle({ version: 2, relayId: RELAY, request: unsolicited })).toMatchObject({ kind: "refused", code: "reply-only" });
  for (const relayId of [null, RELAY])
    expect(await hubIntercom.handle({ version: 2, relayId, request: unsolicited, thread: { kind: "reply", replyTo: "hub-ask" } }))
      .toMatchObject({ kind: "refused", code: "reply-only" });
  const locals = (await receiver.client.listSessions()).filter((value): value is LocalSessionInfo => !value.remote);
  const localFrom = locals.find(value => value.address?.sessionId === "remote-recipient")!;
  expect(await boxIntercom.prepare({ to: "hub-asker", from: localFrom, locals })).toEqual({ kind: "refused", code: "reply-only" });
  const link = openLink(box, relay, [relay]);
  expect((await link.poll(0)).ready.ok).toBe(true);
  const held = link.poll(20_000);
  const reply = boxIntercom.prepareReply({ from: localFrom, askId: "hub-ask", message: marker("hub-answer") });
  const offer = await takeOffer(held, reply, "hub-answer", "reply");
  const forward = createV0RelayForwarder(hub.root, { transport: () => { throw new Error("Hub reply must not dial the hub"); } });
  expect(await forward({ ...offer, kind: "send" })).toMatchObject({ attempted: false, outcome: { kind: "refused", code: "reply-only" } });
  await link.poll(0, [await forward(offer)]);
  expect(await reply).toMatchObject({ kind: "socket_delivered", path: "relay relay-1.invalid" });
  expect(await waiter.result).toMatchObject({ kind: "replied", id: "hub-ask", text: "hub-answer" });
  expect(await asker.received()).toEqual([]);
});

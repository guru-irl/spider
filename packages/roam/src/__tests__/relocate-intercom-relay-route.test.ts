import { EventEmitter, once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { openDbAt } from "@spider/db-core";
import { HerdrError } from "@spider/herdr/client/parse";
import { IntercomClient } from "@spider/intercom/broker/client";
import { listV0RelayLinks, pollV0RelayBroker, submitV0Relay } from "@spider/intercom/broker/roam-relay-client";
import { type RelayPeer, type RelayPoll, type RelayResult, type RelaySubmit } from "@spider/intercom/relay-protocol";
import { registerIntercomOnce } from "@spider/intercom/single-instance";
import { startTestBroker, stopTestBroker, testBrokerEnv, testTmpDir } from "@spider/intercom/test-support";
import type { LocalSessionInfo } from "@spider/intercom/types";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { buildIntercom } from "../../../../scripts/build-intercom.mjs";
import type { Peer, Transport } from "../contracts";
import { createV0Intercom, createV0RelayForwarder } from "../relocate/intercom";

const RELAY = "11111111-1111-4111-8111-111111111111";
const ORIGIN = "22222222-2222-4222-8222-222222222222";
const TARGET = "33333333-3333-4333-8333-333333333333";
const SCOPE = "fixture-scope";
const relay: RelayPeer = { machineId: RELAY, alias: "relay-1.invalid" };
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

async function startBroker(m: Machine) {
  const broker = startTestBroker(process.execPath, [join(brokerBuild, "broker.mjs")], {
    env: { ...testBrokerEnv(), SPIDER_GLOBAL_ROOT: m.root, PI_CODING_AGENT_DIR: m.agentDir }, stdio: ["pipe", "pipe", "pipe"],
  });
  cleanups.push(() => stopTestBroker(broker));
  const [output] = await once(broker.stdout!, "data");
  expect(String(output)).toContain("Intercom broker started");
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

async function startTool(m: Machine, intercom: ReturnType<typeof createV0Intercom>) {
  const hooks = new Map<string, ((event: unknown, ctx: unknown) => unknown)[]>();
  const tools: ToolDefinition[] = [];
  const bus = new EventEmitter();
  const pi = {
    events: { on(name: string, handler: (value: unknown) => void) { bus.on(name, handler); return () => bus.off(name, handler); },
      emit(name: string, value: unknown) { bus.emit(name, value); } },
    on(name: string, handler: (event: unknown, ctx: unknown) => unknown) { hooks.set(name, [...(hooks.get(name) ?? []), handler]); },
    getSessionName: () => "source", setSessionName() {}, registerMessageRenderer() {}, registerShortcut() {}, registerCommand() {},
    appendEntry() {}, registerTool(tool: ToolDefinition) { tools.push(tool); }, getAllTools: () => tools,
    getActiveTools: () => tools.map(tool => tool.name), setActiveTools() {},
  };
  const ctx = { cwd: m.root, mode: "rpc", model: { id: "fixture" }, hasUI: false,
    sessionManager: { getSessionId: () => "source", getEntries: () => [] }, isIdle: () => true,
    hasPendingMessages: () => false, ui: { notify() {}, getEditorText: () => "" } };
  const emit = async (name: string) => { for (const hook of hooks.get(name) ?? []) await hook({ reason: "startup" }, ctx); };
  vi.stubEnv("PI_CODING_AGENT_DIR", m.agentDir);
  registerIntercomOnce(pi as never, undefined, undefined, { prepare: intercom.prepare, homeEpoch: id => id === "source" ? 1 : undefined });
  cleanups.push(() => emit("session_shutdown"));
  await emit("session_start");
  const tool = tools.find(item => item.name === "intercom")!;
  return (to: string, action: "send" | "ask" = "send") => tool.execute("route-fixture", { action, to, message: "fixture message" },
    undefined, undefined, ctx as unknown as ExtensionContext);
}

async function fixture(options: { direct?: boolean; reached?: readonly RelayPeer[]; link?: boolean; targetGrant?: boolean } = {}) {
  vi.stubEnv("PI_SUBAGENT_CHILD", "0");
  vi.stubEnv("PI_INTERCOM_SCOPE_ID", SCOPE);
  const sender = machine(origin), receiver = machine(target), carrier = machine(relay);
  sender.configure({ sendTo: options.direct ? [receiver.peer] : [], acceptFrom: [target] });
  receiver.configure({ acceptFrom: options.targetGrant === false ? [] : [origin] });
  carrier.configure({ sendTo: [sender.peer, receiver.peer], linkTo: [ORIGIN] });
  await startBroker(sender);
  await startBroker(receiver);
  const local = await register(sender, "local-recipient", "local", 2);
  const remote = await register(receiver, "remote-recipient", "recipient", 3);

  const faults = { lost: false, routeMissing: false, disconnected: false, badPin: false };
  const transport = (): Pick<Transport, "resolve" | "exec"> => ({
    async resolve(p) {
      if (faults.routeMissing) throw new HerdrError("machine-not-found", "fixture has no direct route");
      if (faults.badPin) throw new HerdrError("machine-mismatch", "fixture pin mismatch");
      return p;
    },
    async exec(p, argv, request) {
      expect(p).toEqual(receiver.peer);
      expect(argv).toEqual(["roam", "agent", "--v0", "intercom"]);
      request.onConnected?.(!faults.disconnected);
      const bytes = request.stdin ?? request.stdinForTimeout?.(request.timeoutMs - 2000);
      if (!bytes) throw new Error("Missing request");
      const reply = await createV0Intercom(receiver.root).handle(JSON.parse(bytes.toString("utf8")));
      if (faults.lost && request.stdinForTimeout) throw new Error("Fixture lost the delivery acknowledgement");
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
  const reach = { type: "reach", peers: options.reached ?? [relay, target] } as const;
  const abort = new AbortController();
  let pollId = 0;
  const poll = (holdMs: RelayPoll["holdMs"], results: readonly RelayResult[] = []) => pollV0RelayBroker(sender.agentDir, {
    holdMs, hello: { type: "hello", version: 1, relay, toMachineId: ORIGIN, linkId: "fixture-link", pollId: `poll-${++pollId}` }, reach, results,
  }, abort.signal);
  const held = options.link === false ? null : poll(20_000);
  cleanups.push(async () => { abort.abort(); await held; });
  if (held) await vi.waitFor(async () => expect(await listV0RelayLinks(sender.agentDir)).toMatchObject([{ state: "up" }]));
  return { sender, receiver, local, remote, intercom, tool, roster, faults, poll, held, abort,
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
  const direct = await f.tool("remote-recipient");
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

it("refuses an ask without offering any text to a relay", async () => {
  const f = await fixture();
  expect((await f.tool("remote-recipient", "ask")).details).toMatchObject({ code: "unsupported" });
  f.abort.abort();
  expect((await f.held!).submissions).toEqual([]);
});

it("reports when no relay is reachable without queuing a send", async () => {
  const f = await fixture({ link: false });
  const refused = await f.tool("remote-recipient");
  expect(refused.content[0].text.split("\n")[0]).toBe("No relay is reachable. Nothing was queued.");
  expect(refused.details).toMatchObject({ code: "no-relay", relaySkips: [{ relay: RELAY, reason: "down" }] });
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

it("reports relay busy without taking a seventeenth submission", async () => {
  const f = await fixture({ link: false });
  await f.poll(0);
  const { from } = await f.roster();
  const submissions = Array.from({ length: 16 }, (_, i): RelaySubmit => ({ type: "submit", kind: "send",
    from: { machineId: ORIGIN, address: from.address!, name: from.name!, homeEpoch: 1, endpointEpoch: from.endpointEpoch! },
    target: { machineId: TARGET, selector: { by: "id", value: "remote-recipient" } },
    message: { id: `busy-${i}`, timestamp: 1, text: "occupy slot" } }));
  const inflight = submissions.map(submission => submitV0Relay(f.sender.agentDir, RELAY, submission, f.abort.signal));
  cleanups.push(async () => { f.abort.abort(); await Promise.all(inflight); });
  const taken: RelaySubmit[] = [];
  await vi.waitFor(async () => { taken.push(...(await f.poll(0)).submissions); expect(taken).toHaveLength(16); });
  const refused = await f.tool("remote-recipient");
  expect(refused.content[0].text.split("\n")[0]).toBe("Relay busy. Nothing was queued.");
  expect(refused.details).toMatchObject({ code: "relay-busy", relaySkips: [{ relay: "relay-1.invalid", reason: "busy" }] });
  expect((await f.poll(0)).submissions).toEqual([]);
});

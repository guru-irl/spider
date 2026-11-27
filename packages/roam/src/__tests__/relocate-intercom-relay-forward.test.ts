import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openDbAt } from "@spider/db-core";
import { IntercomClient } from "@spider/intercom/broker/client";
import { requestV0Broker } from "@spider/intercom/broker/roam-v0-client";
import type { RelaySubmit } from "@spider/intercom/relay-protocol";
import type { V0RelayAgentRequest } from "@spider/intercom/roam-v0";
import { startTestBroker, stopTestBroker, testBrokerEnv, testTmpDir } from "@spider/intercom/test-support";
import type { Message, SessionInfo } from "@spider/intercom/types";
import { buildIntercom } from "../../../../scripts/build-intercom.mjs";
import { main } from "../cli";
import type { Peer, Transport } from "../contracts";
import * as intercom from "../relocate/intercom";

const HUB = "11111111-1111-4111-8111-111111111111";
const ORIGIN = "22222222-2222-4222-8222-222222222222";
const RELAY = "33333333-3333-4333-8333-333333333333";
const TARGET = "44444444-4444-4444-8444-444444444444";
const SCOPE = "scope-1";
const aliases = { [HUB]: "hub.invalid", [ORIGIN]: "origin.invalid", [RELAY]: "relay.invalid", [TARGET]: "target.invalid" };
const roots: string[] = [];
const clients: IntercomClient[] = [];
const brokers: ReturnType<typeof startTestBroker>[] = [];
const brokerBuild = mkdtempSync(join(testTmpDir(), "rf-build-"));

function machine(id: keyof typeof aliases) {
  const root = mkdtempSync(join(testTmpDir(), "rf-"));
  roots.push(root);
  const agentDir = join(root, "agent");
  for (const dir of ["agent", "roam", "herdr"]) mkdirSync(join(root, dir), { mode: 0o700 });
  writeFileSync(join(root, "roam", "config.json"), JSON.stringify({
    enabled: true, role: id === HUB ? "hub" : "box", machineId: id, hubMachineId: HUB,
    peers: [], discoveryRoots: [], coreUnit: "core.service",
  }), { mode: 0o600 });
  writeFileSync(join(root, "roam", "machine.json"), JSON.stringify({ machineId: id }), { mode: 0o600 });
  writeFileSync(join(root, "herdr", "config.json"), JSON.stringify({
    mode: "core-only", core: { binary: "/usr/bin/env", config: join(root, "core.toml") },
    globalRoot: root, agentDirectory: agentDir, shellRc: join(root, "shell.rc"), machines: [],
  }), { mode: 0o600 });
  return { id, alias: aliases[id], root, agentDir };
}
type Machine = ReturnType<typeof machine>;

function peer(m: Machine): Peer {
  return { machineId: m.id, alias: m.alias, node: "/node", pi: "/pi", cli: "/spider", core: "/core",
    globalRoot: m.root, agentDir: m.agentDir };
}
function configure(m: Machine, routes: object) {
  writeFileSync(join(m.root, "roam", "intercom-v0.json"), JSON.stringify({ version: 2, sendTo: [], acceptFrom: [], ...routes }), { mode: 0o600 });
}
function writeHome(m: Machine, sessionId: string, owner: Machine, epoch: number, state = "running") {
  const db = openDbAt(join(m.root, "spider.db"), "global");
  try {
    db.prepare("UPDATE roam_meta SET machine_id=?,store_key='global' WHERE id=1").run(m.id);
    db.prepare(`INSERT INTO session_homes (session_id,machine_id,epoch,updated_at,state,destination,move_id) VALUES (?,?,?,1,?,?,?)
      ON CONFLICT(session_id) DO UPDATE SET machine_id=excluded.machine_id, epoch=excluded.epoch,
        state=excluded.state, destination=excluded.destination, move_id=excluded.move_id`)
      .run(sessionId, owner.id, epoch, state, state === "moving" ? ORIGIN : null, state === "moving" ? `v0-${TARGET}` : null);
  } finally { db.close(); }
}

async function startBroker(m: Machine) {
  const broker = startTestBroker(process.execPath, [join(brokerBuild, "broker.mjs")], {
    env: { ...testBrokerEnv(), PI_CODING_AGENT_DIR: m.agentDir }, stdio: ["pipe", "pipe", "pipe"],
  });
  brokers.push(broker);
  await new Promise<void>((ready, reject) => {
    broker.once("exit", code => reject(new Error(`Private broker exited with ${code}`)));
    broker.stdout!.on("data", chunk => { if (String(chunk).includes("Intercom broker started")) ready(); });
  });
}

async function register(m: Machine, sessionId: string, name: string, v0HomeEpoch: number, scopeId = SCOPE,
  onMessage?: (from: SessionInfo, message: Message) => void) {
  const client = new IntercomClient();
  clients.push(client);
  if (onMessage) client.on("message", onMessage);
  vi.stubEnv("PI_CODING_AGENT_DIR", m.agentDir);
  vi.stubEnv("PI_INTERCOM_SCOPE_ID", scopeId);
  try {
    await client.connect({ address: { sessionId, scopeId }, name, v0HomeEpoch,
      cwd: m.root, model: "fixture", pid: process.pid, startedAt: 1, lastActivity: 1 }, `live-${sessionId}`);
  } finally { vi.stubEnv("PI_CODING_AGENT_DIR", undefined); }
  return client;
}

const agentArgs = ["roam", "agent", "--v0", "intercom"];
async function agent(m: Machine, stdin: Buffer, argv: readonly string[] = agentArgs) {
  let out = "", err = "";
  const exit = await main(["--global-root", m.root, ...argv], { out: chunk => { out += chunk; }, err: chunk => { err += chunk; } }, { stdin });
  expect(exit, err).toBe(0);
  return Buffer.from(out);
}

type Faults = {
  afterLookup?(): void | Promise<void>;
  beforeWrite?(): void;
  afterWrite?(reply: Buffer): Buffer;
};

async function forwardingFixture(mode: "remote" | "local" | "hub" = "remote") {
  const origin = machine(ORIGIN), relay = machine(mode === "hub" ? HUB : RELAY);
  const receiver = mode === "remote" ? machine(TARGET) : relay;
  const relays = [relay.id];
  const grant = { machineId: origin.id, alias: origin.alias };
  const receiverPolicy = { relays, acceptFrom: mode === "hub" ? [] : [grant] };
  const relayRoutes = { relays, linkTo: [origin.id], sendTo: [peer(origin), ...(receiver !== relay ? [peer(receiver)] : [])] };
  configure(origin, { relays });
  configure(relay, receiver === relay ? { ...relayRoutes, ...receiverPolicy } : relayRoutes);
  if (receiver !== relay) configure(receiver, receiverPolicy);
  for (const m of new Set([origin, relay, receiver])) {
    writeHome(m, "sender", origin, 1);
    writeHome(m, "recipient", receiver, 2);
  }
  const faults: Faults = {};
  const calls: string[] = [];
  const transport = (): Pick<Transport, "resolve" | "exec"> => ({
    async resolve(p) { expect(p).toEqual(peer(receiver)); return p; },
    async exec(p, argv, options) {
      if (options.stdinForTimeout) faults.beforeWrite?.();
      const bytes = options.stdin ?? options.stdinForTimeout?.(options.timeoutMs - 2000);
      if (!bytes) throw new Error("Missing intercom request");
      calls.push(options.stdinForTimeout ? "deliver" : "lookup");
      const reply = await agent(receiver, bytes, argv);
      if (options.stdinForTimeout) return faults.afterWrite ? faults.afterWrite(reply) : reply;
      await faults.afterLookup?.();
      return reply;
    },
  });
  const receipts: { id: string; origin: string | null; alias: string | null }[] = [];
  function record(from: SessionInfo, message: Message) {
    receipts.push({ id: message.id, origin: from.remote ? from.machineId : null, alias: from.remote ? from.machineAlias : null });
  }
  await startBroker(receiver);
  const recipient = await register(receiver, "recipient", "recipient", 2, SCOPE, record);
  async function received() {
    // A reply on each recipient connection follows any message already written there.
    for (const client of clients) if (client.isConnected()) await client.listSessions();
    return receipts;
  }
  function submit(id: string): RelaySubmit {
    return { type: "submit", kind: "send", from: { machineId: origin.id, address: { sessionId: "sender", scopeId: SCOPE },
      name: "sender", homeEpoch: 1, endpointEpoch: "sender-connection" },
    target: { machineId: receiver.id, selector: { by: "id", value: "recipient" }, homeEpoch: 2 },
    message: { id, text: "hello", timestamp: 123 } };
  }
  const forward = (input: RelaySubmit, signal?: AbortSignal) => intercom.createV0RelayForwarder(relay.root, { transport })(input, signal);
  return { origin, relay, receiver, grant, recipient, transport, calls, faults, submit, forward, record, received };
}

beforeAll(() => buildIntercom(brokerBuild));
afterAll(() => rmSync(brokerBuild, { recursive: true, force: true }));
beforeEach(() => vi.stubEnv("PI_CODING_AGENT_DIR", undefined));
afterEach(async () => {
  for (const client of clients.splice(0)) await client.disconnect();
  for (const broker of brokers.splice(0)) await stopTestBroker(broker);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

const receipt = (id: string) => [{ id, origin: ORIGIN, alias: "origin.invalid" }];
const refusal = (messageId: string, code: string, attempted = false) =>
  ({ type: "result", messageId, attempted, outcome: { kind: "refused", code } });

describe("roaming v0 relay forwarding", () => {
  it("delivers a direct control to the same live target with v1 routes", async () => {
    const f = await forwardingFixture();
    configure(f.origin, { version: 1, sendTo: [peer(f.receiver)] });
    configure(f.receiver, { version: 1, acceptFrom: [f.grant] });
    await startBroker(f.origin);
    const sender = await register(f.origin, "sender", "sender", 1);
    const locals = (await sender.listSessions()).filter(session => !session.remote);
    const from = locals.find(session => session.id === "live-sender");
    if (!from) throw new Error("Missing direct-control sender");
    const plan = await intercom.createV0Intercom(f.origin.root, { transport: f.transport }).prepare({ to: "recipient", from, locals });
    expect(plan.kind).toBe("remote");
    if (plan.kind !== "remote") throw new Error("Missing direct-control plan");
    expect(await plan.send(f.submit("direct").message)).toEqual({ kind: "socket_delivered", id: "direct" });
    expect(await f.received()).toEqual(receipt("direct"));
  });

  it("forwards a scoped name by direct call and retains the origin", async () => {
    const f = await forwardingFixture();
    writeHome(f.receiver, "shadow", f.receiver, 3);
    await register(f.receiver, "shadow", "recipient", 3, "scope-2", f.record);
    const submit = f.submit("forwarded");
    submit.target = { machineId: f.receiver.id, selector: { by: "name", value: "RECIPIENT" } };
    expect(await f.forward(submit)).toEqual({ type: "result", messageId: "forwarded", attempted: true,
      outcome: { kind: "socket_delivered", id: "forwarded" } });
    expect(await f.received()).toEqual(receipt("forwarded"));
    expect(f.calls).toEqual(["lookup", "deliver"]);
  });

  it("delivers on a box relay that owns the target without a remote call", async () => {
    const f = await forwardingFixture("local");
    expect(await f.forward(f.submit("local-relay"))).toEqual({ type: "result", messageId: "local-relay", attempted: true,
      outcome: { kind: "socket_delivered", id: "local-relay" } });
    expect(await f.received()).toEqual(receipt("local-relay"));
    expect(f.calls).toEqual([]);
  });

  it("requires the origin grant for relay-local delivery", async () => {
    const f = await forwardingFixture("local");
    configure(f.relay, { relays: [RELAY] });
    expect(await f.forward(f.submit("local-denied"))).toEqual(refusal("local-denied", "unauthorized"));
    expect(await f.received()).toEqual([]);
    expect(f.calls).toEqual([]);
  });

  it.each(["relay", "origin"] as const)("refuses an unlisted %s without marking the lookup attempted", async missing => {
    const f = await forwardingFixture();
    configure(f.receiver, { relays: missing === "relay" ? [] : [RELAY], acceptFrom: missing === "origin" ? [] : [f.grant] });
    expect(await f.forward(f.submit("denied"))).toEqual(refusal("denied", "unauthorized"));
    expect(f.calls).toEqual(["lookup"]);
    expect(await f.received()).toEqual([]);
  });

  it.each(["relay", "origin"] as const)("makes a target refusal final when the %s grant disappears after lookup", async missing => {
    const f = await forwardingFixture();
    f.faults.afterLookup = () => configure(f.receiver, { relays: missing === "relay" ? [] : [RELAY], acceptFrom: missing === "origin" ? [] : [f.grant] });
    expect(await f.forward(f.submit("revoked"))).toEqual(refusal("revoked", "unauthorized", true));
    expect(f.calls).toEqual(["lookup", "deliver"]);
    expect(await f.received()).toEqual([]);
  });

  it("refuses an unsolicited send to a live local hub target as reply-only", async () => {
    const f = await forwardingFixture("hub");
    const submit = f.submit("hub-send");
    expect(await f.forward(submit)).toEqual(refusal("hub-send", "reply-only"));
    const lookup = { version: 1, kind: "lookup", requestId: "hub-lookup", toMachineId: HUB,
      from: submit.from, selector: submit.target.selector };
    const reply = await agent(f.relay, Buffer.from(JSON.stringify({ version: 2, relayId: HUB, request: lookup })));
    expect(JSON.parse(reply.toString("utf8"))).toMatchObject({ kind: "refused", code: "reply-only" });
    expect(f.calls).toEqual([]);
    expect(await f.received()).toEqual([]);
  });

  it("rejects a relayed delivery for the wrong machine or scope before writing to the broker", async () => {
    const f = await forwardingFixture();
    const lookup = await requestV0Broker(f.receiver.agentDir, { kind: "lookup", scopeId: SCOPE, selector: { by: "id", value: "recipient" } });
    if (lookup.kind !== "matches" || lookup.targets.length !== 1) throw new Error("Missing receiving pin");
    const submit = f.submit("blocked");
    const request = { version: 1, kind: "deliver", requestId: "blocked-request", toMachineId: f.receiver.id,
      target: lookup.targets[0], from: submit.from, message: submit.message } as const;
    const testRequests: V0RelayAgentRequest["request"][] = [
      { ...request, toMachineId: RELAY },
      { ...request, target: { ...request.target, address: { ...request.target.address, scopeId: "scope-2" } } },
    ];
    for (const wrong of testRequests) {
      const reply = await agent(f.receiver, Buffer.from(JSON.stringify({ version: 2, relayId: RELAY, request: wrong })));
      expect(JSON.parse(reply.toString("utf8"))).toEqual({ version: 1, machineId: TARGET, requestId: "blocked-request",
        kind: "refused", code: "unauthorized" });
    }
    expect(await f.received()).toEqual([]);
  });

  it("refuses a stale pinned target", async () => {
    const f = await forwardingFixture();
    // The target's newer home is not yet visible to the relay or the old live endpoint.
    f.faults.afterLookup = () => writeHome(f.receiver, "recipient", f.receiver, 3);
    expect(await f.forward(f.submit("stale"))).toEqual(refusal("stale", "changed", true));
    expect(await f.received()).toEqual([]);
  });

  it("does not switch to a newly registered endpoint at the same home epoch", async () => {
    const f = await forwardingFixture();
    f.faults.afterLookup = async () => {
      await f.recipient.disconnect();
      await register(f.receiver, "recipient", "recipient", 2, SCOPE, f.record);
    };
    expect(await f.forward(f.submit("replaced"))).toEqual(refusal("replaced", "changed", true));
    expect(await f.received()).toEqual([]);
  });

  it("does not hand off if the relay sees a changed home during lookup", async () => {
    const f = await forwardingFixture();
    f.faults.afterLookup = () => writeHome(f.relay, "recipient", f.receiver, 3);
    expect(await f.forward(f.submit("changed"))).toEqual(refusal("changed", "changed"));
    expect(f.calls).toEqual(["lookup"]);
    expect(await f.received()).toEqual([]);
  });

  it("does not write to a route removed after lookup", async () => {
    const f = await forwardingFixture();
    f.faults.afterLookup = () => configure(f.relay, { relays: [RELAY] });
    expect(await f.forward(f.submit("route-removed"))).toEqual(refusal("route-removed", "changed"));
    expect(f.calls).toEqual(["lookup"]);
    expect(await f.received()).toEqual([]);
  });

  it.each([["moving", "moving"], ["stopped", "offline"]])("refuses a %s home before dispatch", async (state, code) => {
    const f = await forwardingFixture();
    writeHome(f.relay, "recipient", f.receiver, 3, state);
    expect(await f.forward(f.submit("not-running"))).toEqual(refusal("not-running", code));
    expect(f.calls).toEqual([]);
    expect(await f.received()).toEqual([]);
  });

  it("does not dispatch if the origin pin or the requested home epoch is stale", async () => {
    const f = await forwardingFixture();
    const submit = f.submit("stale-epoch");
    expect(await f.forward({ ...submit, target: { ...submit.target, homeEpoch: 1 } })).toEqual(refusal("stale-epoch", "changed"));
    writeHome(f.relay, "sender", f.origin, 2);
    expect(await f.forward(submit)).toEqual(refusal("stale-epoch", "changed"));
    expect(f.calls).toEqual([]);
    expect(await f.received()).toEqual([]);
  });

  it("refuses two live matches in the target scope", async () => {
    const f = await forwardingFixture();
    writeHome(f.relay, "other", f.receiver, 3);
    writeHome(f.receiver, "other", f.receiver, 3);
    await register(f.receiver, "other", "recipient", 3, SCOPE, f.record);
    const submit = f.submit("ambiguous");
    submit.target = { machineId: f.receiver.id, selector: { by: "name", value: "recipient" } };
    expect(await f.forward(submit)).toEqual(refusal("ambiguous", "ambiguous"));
    expect(f.calls).toEqual(["lookup"]);
    expect(await f.received()).toEqual([]);
  });

  it("refuses an ask or a reply without dispatching it as a new send", async () => {
    const f = await forwardingFixture();
    const submit = f.submit("unsupported");
    expect(await f.forward({ ...submit, kind: "ask", timeoutMs: 2000 })).toEqual(refusal("unsupported", "unsupported"));
    expect(await f.forward({ ...submit, kind: "reply", replyTo: "previous" })).toEqual(refusal("unsupported", "unsupported"));
    expect(f.calls).toEqual([]);
    expect(await f.received()).toEqual([]);
  });

  it.each(["failure", "abort"])("does not mark a %s before the delivery write as attempted", async fault => {
    const f = await forwardingFixture(), controller = new AbortController();
    f.faults.beforeWrite = () => {
      if (fault === "failure") throw new Error("Transport failed before handing off stdin");
      controller.abort();
    };
    expect(await f.forward(f.submit("before-write"), controller.signal)).toEqual(refusal("before-write", "unreachable"));
    expect(f.calls).toEqual(["lookup"]);
    expect(await f.received()).toEqual([]);
  });

  it.each(["lost", "wrong request"])("preserves unknown for a %s acknowledgement after a direct write", async fault => {
    const f = await forwardingFixture();
    f.faults.afterWrite = reply => {
      if (fault === "lost") throw new Error("Lost delivery acknowledgement");
      return Buffer.from(JSON.stringify({ ...JSON.parse(reply.toString("utf8")), requestId: "wrong" }));
    };
    expect(await f.forward(f.submit("lost"))).toEqual({ type: "result", messageId: "lost", attempted: true,
      outcome: { kind: "unknown", id: "lost" } });
    expect(f.calls).toEqual(["lookup", "deliver"]);
    expect(await f.received()).toEqual(receipt("lost"));
  });
});

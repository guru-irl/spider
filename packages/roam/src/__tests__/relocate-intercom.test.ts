import { afterEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { openDbAt } from "@spider/db-core";
import { parseV0AgentReply, parseV0BrokerReply, V0_ASK_MAX_MS, V0_INTERCOM_BYTES, V0_INTERCOM_MS, type V0AgentRequest, type V0BrokerOp, type V0Endpoint, type V0Reply, type V0Text } from "@spider/intercom/roam-v0";
import type { LocalSessionInfo, RemoteSessionInfo } from "@spider/intercom/types";
import { DEFAULT_LIMITS, type CallOptions, type Peer, type Transport } from "../contracts";
import { main } from "../cli";
import { createV0Intercom, hasV0IntercomConfig } from "../relocate/intercom";
import * as homesApi from "../relocate/home";

const MAC = "11111111-1111-4111-8111-111111111111";
const BOX = "22222222-2222-4222-8222-222222222222";
const OTHER = "33333333-3333-4333-8333-333333333333";
const roots: string[] = [];

function machineFixture(machineId: string): { root: string; agentDir: string } {
  const root = mkdtempSync(join(resolve(".spider/scratch"), "ic2-"));
  roots.push(root);
  const agentDir = join(root, "agent");
  mkdirSync(join(root, "roam"), { mode: 0o700 });
  mkdirSync(join(root, "herdr"), { mode: 0o700 });
  mkdirSync(agentDir, { mode: 0o700 });
  writeFileSync(join(root, "roam", "config.json"), JSON.stringify({
    enabled: true, role: machineId === MAC ? "hub" : "box", machineId, hubMachineId: MAC,
    peers: [], discoveryRoots: [], coreUnit: "core.service",
  }), { mode: 0o600 });
  writeFileSync(join(root, "roam", "machine.json"), JSON.stringify({ machineId }), { mode: 0o600 });
  writeFileSync(join(root, "roam", "intercom-v0.json"), JSON.stringify({
    version: 1, sendTo: [], acceptFrom: machineId === MAC ? [] : [{ machineId: MAC, alias: "mac" }],
  }), { mode: 0o600 });
  writeFileSync(join(root, "herdr", "config.json"), JSON.stringify({
    mode: "core-only", core: { binary: "/usr/bin/env", config: join(root, "core.toml") },
    globalRoot: root, agentDirectory: agentDir, shellRc: join(root, "shell.rc"), machines: [],
  }), { mode: 0o600 });
  const db = openDbAt(join(root, "spider.db"), "global");
  try {
    db.prepare("UPDATE roam_meta SET machine_id=?,store_key='global' WHERE id=1").run(machineId);
    const insert = db.prepare("INSERT INTO session_homes(session_id,machine_id,epoch,updated_at,state) VALUES (?,?,?,1,'running')");
    insert.run("alice", MAC, 1);
    insert.run("ben", BOX, 2);
  } finally { db.close(); }
  return { root, agentDir };
}
function boxFixture() { return machineFixture(BOX); }
function peer(machineId: string, name: string, fixture: { root: string; agentDir: string }): Peer {
  return { machineId, alias: name, node: "/node", pi: "/pi", cli: "/spider", core: "/core",
    globalRoot: fixture.root, agentDir: fixture.agentDir };
}
function configure(root: string, sendTo: readonly Peer[], acceptFrom: readonly { machineId: string; alias: string }[]) {
  writeFileSync(join(root, "roam", "intercom-v0.json"), JSON.stringify({ version: 1, sendTo, acceptFrom }), { mode: 0o600 });
}
function addHome(root: string, sessionId: string, machineId: string, epoch = 1) {
  const db = openDbAt(join(root, "spider.db"), "global");
  try { db.prepare("INSERT INTO session_homes(session_id,machine_id,epoch,updated_at,state) VALUES (?,?,?,1,'running')").run(sessionId, machineId, epoch); }
  finally { db.close(); }
}

const alice: LocalSessionInfo = {
  id: "stable-alice", address: { sessionId: "alice", scopeId: "scope-1" }, name: "alice",
  endpointEpoch: "alice-connection", v0HomeEpoch: 1, cwd: "", model: "", pid: 1, startedAt: 1, lastActivity: 1,
};
const aliceEndpoint: V0Endpoint = { address: { sessionId: "alice", scopeId: "scope-1" }, name: "alice", homeEpoch: 1, endpointEpoch: "alice-connection" };
const message: V0Text = { id: "message-1", timestamp: 123, text: "hello" };

const ben: V0Endpoint = {
  address: { sessionId: "ben", scopeId: "scope-1" }, name: "ben", homeEpoch: 2, endpointEpoch: "ben-connection",
};
const findBen: V0AgentRequest = {
  version: 1, requestId: "request-1", toMachineId: BOX, kind: "lookup",
  from: { machineId: MAC, address: { sessionId: "alice", scopeId: "scope-1" }, name: "alice", homeEpoch: 1, endpointEpoch: "alice-connection" },
  selector: { by: "name", value: "ben" },
};

function paired() {
  const sender = machineFixture(MAC), receiver = boxFixture();
  vi.stubEnv("PI_CODING_AGENT_DIR", undefined);
  configure(sender.root, [peer(BOX, "box", receiver)], []);
  const inbox: { from: RemoteSessionInfo; message: V0Text }[] = [];
  const asks: V0Text[] = [];
  const calls: { machineId: string; request: V0AgentRequest; options: CallOptions }[] = [];
  const state: { fault: "none" | "drop" | "truncated" | "wrong-id" | "wrong-machine"; live: V0Endpoint[]; source: V0Endpoint } = {
    fault: "none", live: [ben], source: aliceEndpoint,
  };
  const remoteBroker = async (_dir: string, op: V0BrokerOp): Promise<V0Reply> => {
    if (op.kind === "lookup") return { kind: "matches", targets: state.live.filter(endpoint =>
      endpoint.address.scopeId === op.scopeId && (op.selector.by === "id" ? endpoint.address.sessionId === op.selector.value
        : endpoint.name?.toLowerCase() === op.selector.value.toLowerCase())) };
    if (!state.live.some(endpoint => endpoint.endpointEpoch === op.target.endpointEpoch)) return { kind: "refused", code: "changed" };
    if (op.kind === "ask") { asks.push(op.message); return { kind: "no_reply", id: op.message.id }; }
    inbox.push({ from: op.from, message: op.message });
    return { kind: "socket_delivered", id: op.message.id };
  };
  const localBroker = async (_dir: string, op: V0BrokerOp): Promise<V0Reply> => {
    if (op.kind !== "lookup") throw new Error("unexpected local operation");
    return { kind: "matches", targets: state.source.address.sessionId === op.selector.value ? [state.source] : [] };
  };
  const remote = createV0Intercom(receiver.root, { broker: remoteBroker });
  const transport = (): Pick<Transport, "resolve" | "exec"> => ({
    resolve: async target => target,
    async exec(target, argv, options) {
      expect(argv).toEqual(["roam", "agent", "--v0", "intercom"]);
      const bytes = options.stdin ?? options.stdinForTimeout?.(options.timeoutMs - 2000);
      if (!bytes) throw new Error("missing request");
      const request = JSON.parse(bytes.toString("utf8")) as V0AgentRequest;
      calls.push({ machineId: target.machineId, request, options });
      const reply = await remote.handle(request);
      if (request.kind !== "lookup") {
        if (state.fault === "drop") throw new Error("lost reply");
        if (state.fault === "truncated") return Buffer.from('{"version":1');
        if (state.fault === "wrong-id") return Buffer.from(JSON.stringify({ ...reply, requestId: "wrong" }));
        if (state.fault === "wrong-machine") return Buffer.from(JSON.stringify({ ...reply, machineId: OTHER }));
      }
      return Buffer.from(JSON.stringify(reply));
    },
  });
  const intercom = createV0Intercom(sender.root, { broker: localBroker, transport });
  return { sender, receiver, inbox, asks, calls, state, intercom };
}

async function remotePlan(intercom: ReturnType<typeof createV0Intercom>, to = "box/ben", locals = [alice]) {
  const plan = await intercom.prepare({ to, from: alice, locals });
  expect(plan.kind).toBe("remote");
  if (plan.kind !== "remote") throw new Error("expected a remote plan");
  return plan;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("roaming v0 intercom", () => {
  it("parses a correlated reply-only refusal", () => {
    const reply = { version: 1, requestId: "request-1", machineId: BOX, kind: "refused", code: "reply-only" };
    expect(parseV0AgentReply(reply)).toEqual(reply);
  });

  it("dispatches via the private v0 agent mode", async () => {
    const { root, agentDir } = boxFixture();
    vi.stubEnv("PI_CODING_AGENT_DIR", undefined);
    const broker = vi.fn(async (_dir: string, _op: unknown): Promise<V0Reply> => ({ kind: "matches", targets: [ben] }));
    let out = "", err = "";
    const io = { out: (text: string) => { out += text; }, err: (text: string) => { err += text; } };
    const intercom = async (input: unknown, targetRoot: string) => createV0Intercom(targetRoot, { broker }).handle(input);
    const code = await main(["--global-root", root, "roam", "agent", "--v0", "intercom"], io,
      { stdin: Buffer.from(JSON.stringify(findBen)), v0: { intercom } });
    expect(code).toBe(0);
    expect(JSON.parse(out)).toEqual({ version: 1, requestId: "request-1", machineId: BOX, kind: "matches", targets: [ben] });
    expect(err).toBe("");
    expect(broker).toHaveBeenCalledWith(agentDir, { kind: "lookup", scopeId: "scope-1", selector: { by: "name", value: "ben" } }, expect.anything());
  });

  it("accepts correlated private refusals but rejects invalid input before the handler", async () => {
    const { root } = boxFixture();
    vi.stubEnv("PI_CODING_AGENT_DIR", undefined);
    let out = "", err = "";
    const io = { out: (text: string) => { out += text; }, err: (text: string) => { err += text; } };
    const intercom = vi.fn(async () => ({ version: 1 as const, requestId: "request-1", machineId: BOX,
      kind: "refused" as const, code: "offline" as const }));
    const argv = ["--global-root", root, "roam", "agent", "--v0", "intercom"];
    expect(await main(argv, io, { stdin: Buffer.from(JSON.stringify(findBen)), v0: { intercom } })).toBe(0);
    expect(JSON.parse(out)).toEqual({ version: 1, requestId: "request-1", machineId: BOX, kind: "refused", code: "offline" });
    expect(err).toBe("");
    for (const stdin of [Buffer.from("{"), Buffer.from([0xff]), Buffer.alloc(V0_INTERCOM_BYTES + 1), Buffer.from(JSON.stringify({ ...findBen, extra: true }))]) {
      out = ""; err = "";
      expect(await main(argv, io, { stdin, v0: { intercom } })).toBe(2);
      expect(out).toBe("");
    }
    expect(intercom).toHaveBeenCalledOnce();
    out = ""; err = "";
    expect(await main([...argv, "extra"], io, { stdin: Buffer.from(JSON.stringify(findBen)), v0: { intercom } })).toBe(2);
    expect(intercom).toHaveBeenCalledOnce();
  });

  it("uses the production private handler when no test seam is supplied", async () => {
    const { root } = boxFixture();
    vi.stubEnv("PI_CODING_AGENT_DIR", undefined);
    let out = "";
    const code = await main(["--global-root", root, "roam", "agent", "--v0", "intercom"],
      { out: text => { out += text; }, err: () => {} }, { stdin: Buffer.from(JSON.stringify(findBen)) });
    expect(code).toBe(0);
    expect(JSON.parse(out)).toEqual({ version: 1, requestId: "request-1", machineId: BOX, kind: "refused", code: "unreachable" });
  });

  it("resolves a qualified name without a replication peer or worktree catalog", async () => {
    const sender = machineFixture(MAC), receiver = boxFixture();
    vi.stubEnv("PI_CODING_AGENT_DIR", undefined);
    configure(sender.root, [peer(BOX, "box", receiver)], []);
    const inbox: V0Text[] = [], contacted: string[] = [];
    const remoteBroker = async (_dir: string, op: V0BrokerOp): Promise<V0Reply> => {
      if (op.kind === "lookup") return { kind: "matches", targets: [ben] };
      if (op.kind === "deliver") { inbox.push(op.message); return { kind: "socket_delivered", id: op.message.id }; }
      throw new Error("unexpected ask");
    };
    const localBroker = async (_dir: string, op: V0BrokerOp): Promise<V0Reply> => {
      if (op.kind !== "lookup") throw new Error("unexpected local operation");
      return { kind: "matches", targets: [aliceEndpoint] };
    };
    const remote = createV0Intercom(receiver.root, { broker: remoteBroker });
    const transport = (_peers: readonly Peer[]): Pick<Transport, "resolve" | "exec"> => ({
      resolve: async target => target,
      async exec(target, argv, options: CallOptions) {
        expect(argv).toEqual(["roam", "agent", "--v0", "intercom"]);
        contacted.push(target.machineId);
        const bytes = options.stdin ?? options.stdinForTimeout?.(options.timeoutMs - 2000);
        if (!bytes) throw new Error("missing request");
        return Buffer.from(JSON.stringify(await remote.handle(JSON.parse(bytes.toString("utf8")))));
      },
    });
    const plan = await createV0Intercom(sender.root, { broker: localBroker, transport }).prepare({ to: "box/ben", from: alice, locals: [alice] });
    expect(plan.kind).toBe("remote");
    if (plan.kind !== "remote") throw new Error("expected a remote plan");
    expect(plan.label).toBe("box/ben");
    expect(await plan.send(message)).toEqual({ kind: "socket_delivered", id: "message-1" });
    expect(contacted).toEqual([BOX, BOX]);
    expect(inbox).toEqual([message]);
  });

  it("keeps a remote ask open until the asked session replies", async () => {
    const sender = machineFixture(MAC), receiver = boxFixture();
    vi.stubEnv("PI_CODING_AGENT_DIR", undefined);
    configure(sender.root, [peer(BOX, "box", receiver)], []);
    let entered!: () => void, answer!: (result: V0Reply) => void;
    const received = new Promise<void>(resolve => { entered = resolve; });
    const remoteBroker = async (_dir: string, op: V0BrokerOp): Promise<V0Reply> => {
      if (op.kind === "lookup") return { kind: "matches", targets: [ben] };
      if (op.kind !== "ask") throw new Error("unexpected delivery");
      entered();
      return new Promise<V0Reply>(resolve => { answer = resolve; });
    };
    const localBroker = async (): Promise<V0Reply> => ({ kind: "matches", targets: [aliceEndpoint] });
    const remote = createV0Intercom(receiver.root, { broker: remoteBroker });
    const transport = (): Pick<Transport, "resolve" | "exec"> => ({
      resolve: async target => target,
      async exec(_target, _argv, options) {
        const bytes = options.stdin ?? options.stdinForTimeout?.(options.timeoutMs - 2000);
        if (!bytes) throw new Error("missing request");
        return Buffer.from(JSON.stringify(await remote.handle(JSON.parse(bytes.toString("utf8")))));
      },
    });
    const plan = await createV0Intercom(sender.root, { broker: localBroker, transport }).prepare({ to: "box/ben", from: alice, locals: [alice] });
    expect(plan.kind).toBe("remote");
    if (plan.kind !== "remote") throw new Error("expected a remote plan");
    let finished = false;
    const pending = plan.ask(message, 5000).then(result => { finished = true; return result; });
    await received;
    expect(finished).toBe(false);
    answer({ kind: "replied", id: message.id, replyId: "reply-1", text: "ack" });
    expect(await pending).toEqual({ kind: "replied", id: "message-1", replyId: "reply-1", text: "ack" });
  });

  it("refuses a box-to-Mac target as reply-only without calling transport", async () => {
    const { root } = boxFixture();
    vi.stubEnv("PI_CODING_AGENT_DIR", undefined);
    const db = openDbAt(join(root, "spider.db"), "global");
    try {
      db.prepare("INSERT INTO session_homes(session_id,machine_id,epoch,updated_at,state) VALUES (?,?,1,1,'running')").run("carl", OTHER);
    } finally { db.close(); }
    const from: LocalSessionInfo = { ...alice, id: "stable-ben", name: "ben", address: ben.address,
      endpointEpoch: ben.endpointEpoch, v0HomeEpoch: ben.homeEpoch };
    const transport = vi.fn((): Pick<Transport, "resolve" | "exec"> => { throw new Error("must not create a route"); });
    const { prepare } = createV0Intercom(root, { transport });
    expect(await prepare({ to: "alice", from, locals: [from] })).toEqual({ kind: "refused", code: "reply-only" });
    expect(await prepare({ to: "mac/alice", from, locals: [from] })).toEqual({ kind: "refused", code: "reply-only" });
    expect(await prepare({ to: "carl", from, locals: [from] })).toEqual({ kind: "refused", code: "not-configured" });
    expect(transport).not.toHaveBeenCalled();
  });

  it("uses a global store with an unassigned store key when its machine identity matches", async () => {
    const f = paired();
    for (const root of [f.sender.root, f.receiver.root]) {
      const db = openDbAt(join(root, "spider.db"), "global");
      try { db.prepare("UPDATE roam_meta SET store_key=NULL WHERE id=1").run(); } finally { db.close(); }
    }
    const plan = await remotePlan(f.intercom);
    expect(await plan.send(message)).toEqual({ kind: "socket_delivered", id: message.id });
    expect(f.inbox.map(item => item.message)).toEqual([message]);
  });

  it("resolves a qualified persistent ID when the remote endpoint has no name", async () => {
    const f = paired();
    f.state.live = [{ ...ben, name: null }];
    const plan = await remotePlan(f.intercom, "box/ben");
    expect(f.calls[0].request).toMatchObject({ kind: "lookup", selector: { by: "id", value: "ben" } });
    expect(await plan.send(message)).toEqual({ kind: "socket_delivered", id: message.id });
    expect(f.inbox.map(item => item.message)).toEqual([message]);
  });

  it("refuses a prepared send when the receiving home has started moving", async () => {
    const f = paired(), plan = await remotePlan(f.intercom);
    const db = openDbAt(join(f.receiver.root, "spider.db"), "global");
    try {
      db.prepare("UPDATE session_homes SET state='moving',destination=?,move_id=?,epoch=3 WHERE session_id='ben'")
        .run(MAC, "v0-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    } finally { db.close(); }
    expect(await plan.send(message)).toEqual({ kind: "refused", code: "moving" });
    expect(f.inbox).toEqual([]);
    expect(f.calls.map(call => call.request.kind)).toEqual(["lookup", "deliver"]);
  });

  it.each(["drop", "truncated", "wrong-id", "wrong-machine"] as const)(
    "returns unknown without resending after %s of a delivery reply", async fault => {
      const f = paired(), plan = await remotePlan(f.intercom);
      f.state.fault = fault;
      expect(await plan.send(message)).toEqual({ kind: "unknown", id: message.id });
      expect(f.inbox.map(item => item.message)).toEqual([message]);
      expect(f.calls.filter(call => call.request.kind === "deliver")).toHaveLength(1);
    },
  );

  it("returns unknown without asking twice when the reply is lost", async () => {
    const f = paired(), plan = await remotePlan(f.intercom);
    f.state.fault = "drop";
    expect(await plan.ask(message, 5000)).toEqual({ kind: "unknown", id: message.id });
    expect(f.asks).toEqual([message]);
    expect(f.calls.filter(call => call.request.kind === "ask")).toHaveLength(1);
  });

  it("honors a cancelled send before making a remote call", async () => {
    const f = paired(), plan = await remotePlan(f.intercom);
    const controller = new AbortController(); controller.abort();
    expect(await plan.send(message, controller.signal)).toEqual({ kind: "refused", code: "unreachable" });
    expect(f.calls.map(call => call.request.kind)).toEqual(["lookup"]);
    expect(f.inbox).toEqual([]);
  });

  it("includes home-store preparation in the lookup budget", async () => {
    const f = paired(), original = homesApi.createHomeStore;
    vi.spyOn(homesApi, "createHomeStore").mockImplementation(options => {
      const homes = original(options);
      return { ...homes, async list() {
        await new Promise(resolve => setTimeout(resolve, V0_INTERCOM_MS + 1));
        return homes.list();
      } };
    });
    vi.useFakeTimers();
    try {
      const pending = f.intercom.prepare({ to: "box/ben", from: alice, locals: [alice] });
      await vi.advanceTimersByTimeAsync(V0_INTERCOM_MS + 2);
      expect(await pending).toEqual({ kind: "refused", code: "unreachable" });
      expect(f.calls).toEqual([]);
    } finally { vi.useRealTimers(); }
  });

  it("rejects an oversized encoded message before remote dispatch", async () => {
    const f = paired(), plan = await remotePlan(f.intercom);
    expect(await plan.send({ ...message, text: "x".repeat(256 * 1024) })).toEqual({ kind: "refused", code: "invalid" });
    expect(f.inbox).toEqual([]);
    expect(f.calls.map(call => call.request.kind)).toEqual(["lookup"]);
  });

  it("checks the destination UUID, source grant, and scope before broker dispatch", async () => {
    const { root } = boxFixture();
    vi.stubEnv("PI_CODING_AGENT_DIR", undefined);
    const broker = vi.fn(async (): Promise<V0Reply> => ({ kind: "matches", targets: [ben] }));
    const { handle } = createV0Intercom(root, { broker });
    expect(await handle({ ...findBen, toMachineId: OTHER })).toMatchObject({ kind: "refused", code: "unauthorized" });
    expect(await handle({ ...findBen, from: { ...findBen.from, machineId: OTHER } })).toMatchObject({ kind: "refused", code: "unauthorized" });
    const delivery = { version: 1, requestId: "request-1", toMachineId: BOX, from: findBen.from, kind: "deliver",
      target: { ...ben, address: { ...ben.address, scopeId: "scope-2" } }, message };
    expect(await handle(delivery)).toMatchObject({ kind: "refused", code: "unauthorized" });
    configure(root, [], []);
    expect(await handle(findBen)).toMatchObject({ kind: "refused", code: "unauthorized" });
    expect(broker).not.toHaveBeenCalled();
  });

  it("prefers a local alias, but gives an exact persistent ID precedence over that alias", async () => {
    const f = paired();
    const local: LocalSessionInfo = { ...alice, id: "local-endpoint", name: "helper",
      address: { sessionId: "local-session", scopeId: "scope-1" }, endpointEpoch: "local-connection", v0HomeEpoch: undefined };
    expect(await f.intercom.prepare({ to: "helper", from: alice, locals: [alice, local] })).toEqual({
      kind: "local", target: { id: "local-endpoint", endpointEpoch: "local-connection" },
    });
    expect(f.calls).toEqual([]);
    const collision = { ...local, name: "ben" };
    const plan = await remotePlan(f.intercom, "ben", [alice, collision]);
    expect(await plan.send(message)).toEqual({ kind: "socket_delivered", id: message.id });
    expect(f.inbox).toHaveLength(1);
  });

  it("revalidates the source, target, route, and endpoint after confirmation", async () => {
    for (const change of ["source-home", "target-home", "source-endpoint", "route", "target-endpoint"] as const) {
      const f = paired(), plan = await remotePlan(f.intercom);
      if (change === "source-home" || change === "target-home") {
        const db = openDbAt(join(f.sender.root, "spider.db"), "global");
        try {
          db.prepare("UPDATE session_homes SET state='moving',destination=?,move_id=?,epoch=epoch+1 WHERE session_id=?")
            .run(change === "source-home" ? BOX : MAC, "v0-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", change === "source-home" ? "alice" : "ben");
        } finally { db.close(); }
      } else if (change === "source-endpoint") f.state.source = { ...aliceEndpoint, endpointEpoch: "replacement" };
      else if (change === "target-endpoint") f.state.live = [{ ...ben, endpointEpoch: "replacement" }];
      else configure(f.sender.root, [peer(BOX, "renamed", f.receiver)], []);
      expect(await plan.send(message)).toEqual({ kind: "refused", code: change.endsWith("home") ? "moving" : "changed" });
      expect(f.inbox).toEqual([]);
      expect(f.calls.filter(call => call.request.kind === "deliver")).toHaveLength(change === "target-endpoint" ? 1 : 0);
    }
  });

  it("lets the broker report an ask timeout instead of aborting it first", async () => {
    const { root } = boxFixture();
    vi.stubEnv("PI_CODING_AGENT_DIR", undefined);
    const broker = async (_dir: string, op: V0BrokerOp, signal?: AbortSignal): Promise<V0Reply> => {
      if (op.kind !== "ask") throw new Error("expected ask");
      return new Promise(resolve => {
        const timer = setTimeout(() => resolve({ kind: "no_reply", id: op.message.id }), op.timeoutMs);
        signal?.addEventListener("abort", () => { clearTimeout(timer); resolve({ kind: "unknown", id: op.message.id }); }, { once: true });
      });
    };
    const ask = { version: 1, requestId: "ask-timeout", toMachineId: BOX, from: findBen.from,
      kind: "ask", target: ben, message, timeoutMs: 40 };
    expect(await createV0Intercom(root, { broker }).handle(ask)).toEqual({
      version: 1, requestId: "ask-timeout", machineId: BOX, kind: "no_reply", id: message.id,
    });
  });

  it("fits the capped ask, setup, and post-check inside Herdr's direct call limit", async () => {
    const f = paired(), plan = await remotePlan(f.intercom);
    expect(await plan.ask(message, V0_ASK_MAX_MS)).toEqual({ kind: "no_reply", id: message.id });
    const call = f.calls.find(item => item.request.kind === "ask");
    expect(call?.options.postReserveMs).toBe(2000);
    // Herdr's DIRECT_MAX_MS in packages/herdr/src/client/argv-client.ts is 600,000 ms.
    expect(V0_ASK_MAX_MS + V0_INTERCOM_MS + call!.options.postReserveMs!).toBeLessThan(DEFAULT_LIMITS.directMs);
    expect(call!.options.timeoutMs).toBeGreaterThan(V0_ASK_MAX_MS + call!.options.postReserveMs!);
  });

  it("returns a confirmed no_reply when a capped ask reaches its deadline", async () => {
    const sender = machineFixture(MAC), receiver = boxFixture();
    vi.stubEnv("PI_CODING_AGENT_DIR", undefined);
    configure(sender.root, [peer(BOX, "box", receiver)], []);
    let entered!: () => void;
    const received = new Promise<void>(resolve => { entered = resolve; });
    const remoteBroker = async (_dir: string, op: V0BrokerOp): Promise<V0Reply> => {
      if (op.kind === "lookup") return { kind: "matches", targets: [ben] };
      if (op.kind !== "ask") throw new Error("unexpected delivery");
      entered();
      return new Promise(resolve => setTimeout(() => resolve({ kind: "no_reply", id: op.message.id }), op.timeoutMs));
    };
    const localBroker = async (): Promise<V0Reply> => ({ kind: "matches", targets: [aliceEndpoint] });
    const remote = createV0Intercom(receiver.root, { broker: remoteBroker });
    const transport = (): Pick<Transport, "resolve" | "exec"> => ({
      resolve: async target => target,
      async exec(_target, _argv, options) {
        const bytes = options.stdin ?? options.stdinForTimeout?.(options.timeoutMs - 2000);
        if (!bytes) throw new Error("missing request");
        const request = JSON.parse(bytes.toString("utf8"));
        if (request.kind === "lookup") return Buffer.from(JSON.stringify(await remote.handle(request)));
        return new Promise<Buffer>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("direct call expired")), options.timeoutMs - options.postReserveMs!);
          remote.handle(request).then(result => { clearTimeout(timer); resolve(Buffer.from(JSON.stringify(result))); }, reject);
        });
      },
    });
    const plan = await remotePlan(createV0Intercom(sender.root, { broker: localBroker, transport }));
    vi.useFakeTimers();
    try {
      const pending = plan.ask(message, V0_ASK_MAX_MS);
      await received;
      await vi.advanceTimersByTimeAsync(V0_ASK_MAX_MS);
      expect(await pending).toEqual({ kind: "no_reply", id: message.id });
    } finally { vi.useRealTimers(); }
  });

  it("stops ask setup when the ask timeout expires before delivery", async () => {
    const sender = machineFixture(MAC), receiver = boxFixture();
    vi.stubEnv("PI_CODING_AGENT_DIR", undefined);
    configure(sender.root, [peer(BOX, "box", receiver)], []);
    const remote = createV0Intercom(receiver.root, { broker: async () => ({ kind: "matches", targets: [ben] }) });
    const resolve = vi.fn(async (target: Peer) => target);
    const exec = vi.fn(async (_target: Peer, _argv: readonly string[], options: CallOptions) => {
      const bytes = options.stdin ?? options.stdinForTimeout?.(options.timeoutMs - 2000);
      if (!bytes) throw new Error("missing request");
      return Buffer.from(JSON.stringify(await remote.handle(JSON.parse(bytes.toString("utf8")))));
    });
    const localBroker = async (): Promise<V0Reply> => new Promise(resolve => setTimeout(() => resolve({ kind: "matches", targets: [aliceEndpoint] }), 100));
    const plan = await remotePlan(createV0Intercom(sender.root, { broker: localBroker, transport: () => ({ resolve, exec }) }));
    vi.useFakeTimers();
    try {
      const pending = plan.ask(message, 50);
      await vi.advanceTimersByTimeAsync(150);
      expect(await pending).toEqual({ kind: "refused", code: "unreachable" });
      expect(resolve).toHaveBeenCalledTimes(1); // The earlier name lookup only.
      expect(exec).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });

  it("does not wait beyond the ask timeout for a stuck resolver", async () => {
    const sender = machineFixture(MAC), receiver = boxFixture();
    vi.stubEnv("PI_CODING_AGENT_DIR", undefined);
    configure(sender.root, [peer(BOX, "box", receiver)], []);
    const remote = createV0Intercom(receiver.root, { broker: async () => ({ kind: "matches", targets: [ben] }) });
    let resolutions = 0;
    const resolve = vi.fn(async (target: Peer) => {
      if (++resolutions === 1) return target;
      return new Promise<Peer>(() => {});
    });
    const exec = vi.fn(async (_target: Peer, _argv: readonly string[], options: CallOptions) =>
      Buffer.from(JSON.stringify(await remote.handle(JSON.parse(options.stdin!.toString("utf8"))))));
    const localBroker = async (): Promise<V0Reply> => ({ kind: "matches", targets: [aliceEndpoint] });
    const plan = await remotePlan(createV0Intercom(sender.root, { broker: localBroker, transport: () => ({ resolve, exec }) }));
    vi.useFakeTimers();
    try {
      const pending = plan.ask(message, 50);
      await vi.advanceTimersByTimeAsync(60);
      expect(await pending).toEqual({ kind: "refused", code: "unreachable" });
      expect(resolve).toHaveBeenCalledTimes(2);
      expect(exec).toHaveBeenCalledTimes(1); // The earlier name lookup only.
    } finally { vi.useRealTimers(); }
  });

  it("keeps a long ask budget and respects the configured cap", async () => {
    const f = paired(), plan = await remotePlan(f.intercom);
    expect(await plan.ask(message, 60_000)).toEqual({ kind: "no_reply", id: message.id });
    const ask = f.calls.find(call => call.request.kind === "ask");
    expect(ask?.options.timeoutMs).toBeGreaterThan(60_000);
    expect(ask?.options.postReserveMs).toBe(2000);
    expect(ask?.request.kind === "ask" && ask.request.timeoutMs).toBeLessThanOrEqual(60_000);
    expect(await plan.ask({ ...message, id: "long-ask" }, 2_000_000)).toEqual({ kind: "no_reply", id: "long-ask" });
    const long = f.calls.find(call => call.request.kind === "ask" && call.request.message.id === "long-ask");
    expect(long?.options.timeoutMs).toBeLessThanOrEqual(DEFAULT_LIMITS.directMs);
    expect(long?.request.kind === "ask" && long.request.timeoutMs).toBeLessThanOrEqual(V0_ASK_MAX_MS);
  });

  it("does not deliver after incoming home validation exhausts its budget", async () => {
    const { root } = boxFixture(), original = homesApi.createHomeStore;
    vi.stubEnv("PI_CODING_AGENT_DIR", undefined);
    vi.spyOn(homesApi, "createHomeStore").mockImplementation(options => {
      const homes = original(options); let first = true;
      return { ...homes, async read(id: Parameters<typeof homes.read>[0]) {
        if (first) { first = false; await new Promise(resolve => setTimeout(resolve, V0_INTERCOM_MS + 1)); }
        return homes.read(id);
      } };
    });
    const broker = vi.fn(async () => ({ kind: "socket_delivered" as const, id: message.id }));
    vi.useFakeTimers();
    try {
      const pending = createV0Intercom(root, { broker }).handle({ version: 1, requestId: "request-1", toMachineId: BOX,
        from: findBen.from, kind: "deliver", target: ben, message });
      await vi.advanceTimersByTimeAsync(V0_INTERCOM_MS + 2);
      expect(await pending).toMatchObject({ kind: "refused", code: "unreachable" });
      expect(broker).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it("reports unknown when an incoming delivery loses its broker acknowledgement", async () => {
    const { root } = boxFixture();
    vi.stubEnv("PI_CODING_AGENT_DIR", undefined);
    let brokerSignal: AbortSignal | undefined;
    const broker = vi.fn(async (_dir: string, _op: V0BrokerOp, signal?: AbortSignal): Promise<V0Reply> => {
      brokerSignal = signal;
      return new Promise(resolve => setTimeout(() => resolve({ kind: "socket_delivered", id: message.id }), V0_INTERCOM_MS + 1));
    });
    vi.useFakeTimers();
    try {
      const pending = createV0Intercom(root, { broker }).handle({ version: 1, requestId: "request-1", toMachineId: BOX,
        from: findBen.from, kind: "deliver", target: ben, message });
      await vi.advanceTimersByTimeAsync(V0_INTERCOM_MS + 2);
      expect(await pending).toMatchObject({ kind: "unknown", id: message.id });
      expect(broker).toHaveBeenCalledOnce();
      expect(brokerSignal?.aborted).toBe(true);
    } finally { vi.useRealTimers(); }
  });

  it("subtracts incoming validation time from the ask's remaining timeout", async () => {
    const { root } = boxFixture(), original = homesApi.createHomeStore;
    vi.stubEnv("PI_CODING_AGENT_DIR", undefined);
    vi.spyOn(homesApi, "createHomeStore").mockImplementation(options => {
      const homes = original(options); let first = true;
      return { ...homes, async read(id: Parameters<typeof homes.read>[0]) {
        if (first) { first = false; await new Promise(resolve => setTimeout(resolve, 30)); }
        return homes.read(id);
      } };
    });
    const broker = vi.fn(async (_dir: string, _op: V0BrokerOp): Promise<V0Reply> => ({ kind: "no_reply", id: message.id }));
    vi.useFakeTimers();
    try {
      const pending = createV0Intercom(root, { broker }).handle({ version: 1, requestId: "request-1", toMachineId: BOX,
        from: findBen.from, kind: "ask", target: ben, message, timeoutMs: 100 });
      await vi.advanceTimersByTimeAsync(30);
      expect(await pending).toMatchObject({ kind: "no_reply", id: message.id });
      expect(broker.mock.calls[0][1]).toMatchObject({ kind: "ask", timeoutMs: 70 });
    } finally { vi.useRealTimers(); }
  });

  it("rejects unsafe v0 configuration without falling back to legacy routing", async () => {
    const box = boxFixture(), mac = machineFixture(MAC);
    vi.stubEnv("PI_CODING_AGENT_DIR", undefined);
    const from: LocalSessionInfo = { ...alice, id: "stable-ben", name: "ben", address: ben.address,
      endpointEpoch: ben.endpointEpoch, v0HomeEpoch: ben.homeEpoch };
    const transport = vi.fn((): Pick<Transport, "resolve" | "exec"> => { throw new Error("must not create a route"); });
    const intercom = createV0Intercom(box.root, { transport });
    configure(box.root, [peer(MAC, "mac", mac)], [{ machineId: MAC, alias: "mac" }]);
    expect(hasV0IntercomConfig(box.root)).toBe(true);
    expect(await intercom.prepare({ to: "alice", from, locals: [from] })).toEqual({ kind: "refused", code: "not-configured" });
    configure(box.root, [], [{ machineId: MAC, alias: "mac" }]);
    chmodSync(join(box.root, "roam", "intercom-v0.json"), 0o644);
    expect(hasV0IntercomConfig(box.root)).toBe(true);
    expect(await intercom.prepare({ to: "alice", from, locals: [from] })).toEqual({ kind: "refused", code: "not-configured" });
    expect(transport).not.toHaveBeenCalled();
  });

  it("allows the configured box-to-box direction and refuses the reverse without contacting the Mac", async () => {
    const a = boxFixture(), b = machineFixture(OTHER);
    vi.stubEnv("PI_CODING_AGENT_DIR", undefined);
    for (const root of [a.root, b.root]) addHome(root, "carl", OTHER);
    configure(a.root, [peer(OTHER, "b", b)], [{ machineId: MAC, alias: "mac" }]);
    configure(b.root, [], [{ machineId: BOX, alias: "a" }]);
    const carl: V0Endpoint = { address: { sessionId: "carl", scopeId: "scope-1" }, name: "carl", homeEpoch: 1, endpointEpoch: "carl-connection" };
    const from: LocalSessionInfo = { ...alice, id: "stable-ben", name: "ben", address: ben.address,
      endpointEpoch: ben.endpointEpoch, v0HomeEpoch: ben.homeEpoch };
    const inbox: { from: RemoteSessionInfo; message: V0Text }[] = [], contacted: string[] = [];
    const bBroker = async (_dir: string, op: V0BrokerOp): Promise<V0Reply> => {
      if (op.kind === "lookup") return { kind: "matches", targets: [carl] };
      if (op.kind !== "deliver") throw new Error("unexpected ask");
      inbox.push({ from: op.from, message: op.message });
      return { kind: "socket_delivered", id: op.message.id };
    };
    const receiver = createV0Intercom(b.root, { broker: bBroker });
    const transport = (): Pick<Transport, "resolve" | "exec"> => ({
      resolve: async target => target,
      async exec(target, _argv, options) {
        contacted.push(target.machineId);
        if (target.machineId === MAC) throw new Error("Mac transport is forbidden");
        return Buffer.from(JSON.stringify(await receiver.handle(JSON.parse(options.stdin!.toString("utf8")))));
      },
    });
    const localBroker = async (): Promise<V0Reply> => ({ kind: "matches", targets: [ben] });
    const plan = await createV0Intercom(a.root, { broker: localBroker, transport }).prepare({ to: "b/carl", from, locals: [from] });
    expect(plan.kind).toBe("remote");
    if (plan.kind !== "remote") throw new Error("expected a remote plan");
    expect(await plan.send(message)).toEqual({ kind: "socket_delivered", id: message.id });
    expect(contacted).toEqual([OTHER, OTHER]);
    expect(inbox).toEqual([{ from: { remote: true, id: "ben", address: ben.address, machineId: BOX, machineAlias: "a",
      homeEpoch: 2, activationEpoch: "ben-connection", endpointEpoch: "ben-connection", name: "ben", cwd: "", model: "", startedAt: 0, lastActivity: 0 }, message }]);
    const fromB: LocalSessionInfo = { ...from, id: "stable-carl", name: "carl", address: carl.address,
      endpointEpoch: carl.endpointEpoch, v0HomeEpoch: carl.homeEpoch };
    const forbidden = vi.fn((): Pick<Transport, "resolve" | "exec"> => { throw new Error("no reverse route"); });
    expect(await createV0Intercom(b.root, { transport: forbidden }).prepare({ to: "ben", from: fromB, locals: [fromB] }))
      .toEqual({ kind: "refused", code: "not-configured" });
    expect(forbidden).not.toHaveBeenCalled();
  });

  it("requires a complete bare-name lookup and refuses duplicate names", async () => {
    const sender = machineFixture(MAC), a = boxFixture(), b = machineFixture(OTHER);
    vi.stubEnv("PI_CODING_AGENT_DIR", undefined);
    for (const root of [sender.root, a.root, b.root]) addHome(root, "carl", OTHER);
    configure(sender.root, [peer(BOX, "a", a), peer(OTHER, "b", b)], []);
    const endpoints: Record<string, V0Endpoint> = {
      [BOX]: { ...ben, name: "shared" },
      [OTHER]: { address: { sessionId: "carl", scopeId: "scope-1" }, name: "shared", homeEpoch: 1, endpointEpoch: "carl-connection" },
    };
    const handlers = new Map([a, b].map((fixture, index) => {
      const machine = index === 0 ? BOX : OTHER;
      return [machine, createV0Intercom(fixture.root, { broker: async (_dir, op) => {
        if (op.kind !== "lookup") throw new Error("no delivery expected");
        return { kind: "matches", targets: [endpoints[machine]] };
      } })] as const;
    }));
    let disconnected = false;
    const contacted: string[] = [];
    const transport = (): Pick<Transport, "resolve" | "exec"> => ({
      resolve: async target => { contacted.push(target.machineId); if (disconnected && target.machineId === OTHER) throw new Error("offline"); return target; },
      async exec(target, _argv, options) {
        return Buffer.from(JSON.stringify(await handlers.get(target.machineId)!.handle(JSON.parse(options.stdin!.toString("utf8")))));
      },
    });
    const localBroker = async (): Promise<V0Reply> => ({ kind: "matches", targets: [aliceEndpoint] });
    const intercom = createV0Intercom(sender.root, { broker: localBroker, transport });
    expect(await intercom.prepare({ to: "shared", from: alice, locals: [alice] })).toEqual({ kind: "refused", code: "ambiguous" });
    expect(contacted.sort()).toEqual([BOX, OTHER].sort());
    contacted.length = 0;
    disconnected = true;
    expect(await intercom.prepare({ to: "shared", from: alice, locals: [alice] })).toEqual({ kind: "refused", code: "incomplete" });
    expect(contacted.sort()).toEqual([BOX, OTHER].sort());
    contacted.length = 0;
    expect((await intercom.prepare({ to: "a/shared", from: alice, locals: [alice] })).kind).toBe("remote");
    expect(contacted).toEqual([BOX]);
  });

  it("keeps unhomed callers on the local path and refuses explicit remotes", async () => {
    const f = paired();
    const unhomed = { ...alice, v0HomeEpoch: undefined };
    const target: LocalSessionInfo = { ...alice, id: "local-target", name: "ben",
      address: { sessionId: "local-target", scopeId: "scope-1" }, v0HomeEpoch: undefined };
    for (const from of [unhomed, { ...unhomed, id: "no-home", address: { sessionId: "no-home", scopeId: "scope-1" } }]) {
      const locals = [from, target];
      expect(await f.intercom.prepare({ to: "local-target", from, locals })).toEqual({ kind: "legacy" });
      expect(await f.intercom.prepare({ to: "box/ben", from, locals })).toEqual({ kind: "refused", code: "not-configured" });
      expect(await f.intercom.prepare({ to: "ben", from, locals })).toEqual({ kind: "refused", code: "not-configured" });
    }
    const stale = { ...alice, id: "no-home", address: { sessionId: "no-home", scopeId: "scope-1" } };
    expect(await f.intercom.prepare({ to: "local-target", from: stale, locals: [stale, target] }))
      .toEqual({ kind: "refused", code: "changed" });
    expect(await f.intercom.prepare({ to: "box/ben", from: stale, locals: [stale, target] }))
      .toEqual({ kind: "refused", code: "changed" });
    expect(f.calls).toEqual([]);
  });

  it("refuses stopped homes and remote callers without the admission epoch", async () => {
    const f = paired();
    const db = openDbAt(join(f.sender.root, "spider.db"), "global");
    try { db.prepare("UPDATE session_homes SET state='stopped' WHERE session_id='ben'").run(); } finally { db.close(); }
    expect(await f.intercom.prepare({ to: "ben", from: alice, locals: [alice] })).toEqual({ kind: "refused", code: "offline" });
    const stale = { ...alice, v0HomeEpoch: undefined };
    expect(await f.intercom.prepare({ to: "box/ben", from: stale, locals: [stale] })).toEqual({ kind: "refused", code: "not-configured" });
    expect(f.calls).toEqual([]);
  });

  it("turns a non-error transport rejection into a typed refusal", async () => {
    const sender = machineFixture(MAC), receiver = boxFixture();
    vi.stubEnv("PI_CODING_AGENT_DIR", undefined);
    configure(sender.root, [peer(BOX, "box", receiver)], []);
    const transport = (): Pick<Transport, "resolve" | "exec"> => ({
      resolve: async () => { throw null; },
      exec: async () => { throw new Error("must not dispatch"); },
    });
    expect(await createV0Intercom(sender.root, { transport }).prepare({ to: "box/ben", from: alice, locals: [alice] }))
      .toEqual({ kind: "refused", code: "unreachable" });
  });

  it("does not propagate reply-only from a broker on a box-bound request", async () => {
    const { root } = boxFixture();
    vi.stubEnv("PI_CODING_AGENT_DIR", undefined);
    const broker = async (): Promise<V0Reply> => ({ kind: "refused", code: "reply-only" });
    expect(await createV0Intercom(root, { broker }).handle(findBen)).toMatchObject({ kind: "refused", code: "unreachable" });
  });

  it("returns unknown if an accepted ask reply cannot fit in the agent envelope", async () => {
    const { root } = boxFixture();
    vi.stubEnv("PI_CODING_AGENT_DIR", undefined);
    const prefix = { type: "roam_v0_result", requestId: "ask-size", kind: "replied", id: message.id, replyId: "reply-1", text: "" };
    const text = "x".repeat(V0_INTERCOM_BYTES - Buffer.byteLength(JSON.stringify(prefix)));
    expect(parseV0BrokerReply({ ...prefix, text })).not.toBeNull();
    let questions = 0;
    const broker = async (_dir: string, op: V0BrokerOp): Promise<V0Reply> => {
      if (op.kind !== "ask") throw new Error("expected ask");
      questions++;
      return { kind: "replied", id: op.message.id, replyId: "reply-1", text };
    };
    const request = { version: 1, requestId: "ask-size", toMachineId: BOX, from: findBen.from,
      kind: "ask", target: ben, message, timeoutMs: 1000 };
    expect(await createV0Intercom(root, { broker }).handle(request)).toEqual({
      version: 1, requestId: "ask-size", machineId: BOX, kind: "unknown", id: message.id,
    });
    expect(questions).toBe(1);
  });

  it("returns unknown for an invalid broker code after delivery started", async () => {
    const { root } = boxFixture();
    vi.stubEnv("PI_CODING_AGENT_DIR", undefined);
    const broker = async (): Promise<V0Reply> => ({ kind: "refused", code: "reply-only" });
    const request = { version: 1, requestId: "delivery-1", toMachineId: BOX, from: findBen.from, kind: "deliver", target: ben, message };
    expect(await createV0Intercom(root, { broker }).handle(request)).toEqual({
      version: 1, requestId: "delivery-1", machineId: BOX, kind: "unknown", id: message.id,
    });
  });

  it("permits a peer in both lists but rejects duplicates, self, and missing agent directories", async () => {
    const f = paired(), destination = peer(BOX, "box", f.receiver);
    configure(f.sender.root, [destination], [{ machineId: BOX, alias: "box" }]);
    const plan = await remotePlan(f.intercom);
    expect(await plan.send(message)).toEqual({ kind: "socket_delivered", id: message.id });
    const badConfigs = [
      { sendTo: [destination, destination], acceptFrom: [] },
      { sendTo: [destination, { ...destination, machineId: OTHER, alias: "BOX" }], acceptFrom: [] },
      { sendTo: [{ ...destination, machineId: MAC }], acceptFrom: [] },
      { sendTo: [{ ...destination, agentDir: undefined }], acceptFrom: [] },
      { sendTo: [{ ...destination, agentDir: "relative" }], acceptFrom: [] },
      { sendTo: [], acceptFrom: [{ machineId: BOX, alias: "box" }, { machineId: OTHER, alias: "BOX" }] },
      { sendTo: [], acceptFrom: [{ machineId: MAC, alias: "self" }] },
      { sendTo: [], acceptFrom: Array.from({ length: 9 }, (_, i) => ({ machineId: BOX, alias: `box-${i}` })) },
    ];
    for (const bad of badConfigs) {
      configure(f.sender.root, bad.sendTo, bad.acceptFrom);
      expect(await f.intercom.prepare({ to: "box/ben", from: alice, locals: [alice] })).toEqual({ kind: "refused", code: "not-configured" });
    }
    expect(f.calls.filter(call => call.request.kind === "deliver")).toHaveLength(1);
  });

  it("rejects a mismatched configured agent directory and global database identity", async () => {
    const f = paired();
    vi.stubEnv("PI_CODING_AGENT_DIR", f.receiver.agentDir);
    expect(await f.intercom.prepare({ to: "box/ben", from: alice, locals: [alice] })).toEqual({ kind: "refused", code: "not-configured" });
    vi.stubEnv("PI_CODING_AGENT_DIR", undefined);
    const db = openDbAt(join(f.sender.root, "spider.db"), "global");
    try { db.prepare("UPDATE roam_meta SET machine_id=? WHERE id=1").run(OTHER); } finally { db.close(); }
    expect(await f.intercom.prepare({ to: "box/ben", from: alice, locals: [alice] })).toEqual({ kind: "refused", code: "unreachable" });
    expect(f.calls).toEqual([]);
  });

  it("does not make a malformed intercom file a relocate prerequisite", async () => {
    const sender = machineFixture(MAC);
    vi.stubEnv("SPIDER_GLOBAL_ROOT", sender.root);
    writeFileSync(join(sender.root, "roam", "intercom-v0.json"), "{invalid", { mode: 0o600 });
    const relocate = vi.fn(async () => ({ ok: false as const, step: "check" as const, home: null, moveId: null,
      refusal: { code: "session-not-found" as const, message: "No session.", nextStep: "Choose a session." } }));
    const services = { relocate, setHome: vi.fn(async () => ({ ok: false as const, refusal: {
      code: "destination-copy-missing" as const, message: "No copy.", nextStep: "Choose a copy." } })) };
    let output = "";
    const code = await main(["roam", "relocate", "alice", "mac", "--json"],
      { out: text => { output += text; }, err: () => {} },
      { v0: { services, catalog: [{ id: "alice", name: "alice" }] } });
    expect(code).toBe(1);
    expect(relocate).toHaveBeenCalledOnce();
    expect(JSON.parse(output)).toMatchObject({ refusal: { code: "session-not-found" } });
  });

  it("keeps an unhomed caller local and refuses an explicit remote target", async () => {
    const { root } = boxFixture();
    vi.stubEnv("PI_CODING_AGENT_DIR", undefined);
    const from = { id: "transient", address: { sessionId: "transient", scopeId: "scope-1" },
      endpointEpoch: "transient-connection", cwd: "", model: "", pid: 1, startedAt: 1, lastActivity: 1 };
    const { prepare } = createV0Intercom(root);
    expect(await prepare({ to: "local", from, locals: [from] })).toEqual({ kind: "legacy" });
    expect(await prepare({ to: "box/ben", from, locals: [from] })).toEqual({ kind: "refused", code: "not-configured" });
  });
});

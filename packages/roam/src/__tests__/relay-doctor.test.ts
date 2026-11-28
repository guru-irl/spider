import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as hc from "@spider/herdr/client/hc";
import { HerdrError } from "@spider/herdr/client/parse";
import { createRelayLinks } from "@spider/intercom/broker/relay-links";
import { listV0RelayLinks } from "@spider/intercom/broker/roam-relay-client";
import { decodeRelayPoll, decodeRelayPollReply, encodeRelayPoll, encodeRelayPollReply,
  relayReady, type RelayPeer, type RelayPoll, type RelayResult, type RelaySubmit } from "@spider/intercom/relay-protocol";
import { startTestBroker, stopTestBroker, testBrokerEnv, testTmpDir } from "@spider/intercom/test-support";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { buildIntercom } from "../../../../scripts/build-intercom.mjs";
import { main } from "../cli";
import type { Peer } from "../contracts";
import * as doctor from "../local-diagnostics";
import { runV0LinkOnce } from "../relocate/relay-poll";
import { readLocalIdentity } from "../runtime";
import * as transport from "../transport";

const relay = { machineId: "11111111-1111-4111-8111-111111111111", alias: "relay-1.invalid" };
const linked = { machineId: "22222222-2222-4222-8222-222222222222", alias: "linked.invalid" };
const target = { machineId: "33333333-3333-4333-8333-333333333333", alias: "target.invalid" };
const START = 1_800_000_000_000;
const roots: string[] = [];
const brokerBuild = mkdtempSync(join(testTmpDir(), "rd-build-"));
const brokers: ReturnType<typeof startTestBroker>[] = [];

beforeAll(() => buildIntercom(brokerBuild));
afterAll(() => rmSync(brokerBuild, { force: true, recursive: true }));
afterEach(async () => {
  vi.useRealTimers();
  for (const broker of brokers.splice(0)) await stopTestBroker(broker);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

function machine(identity: RelayPeer, alias: string | null = identity.alias) {
  const root = mkdtempSync(join(testTmpDir(), "rd-")), agentDir = join(root, "agent");
  roots.push(root);
  for (const dir of ["agent", "roam", "herdr"]) mkdirSync(join(root, dir), { mode: 0o700 });
  const write = (file: string, value: unknown) => writeFileSync(join(root, file), JSON.stringify(value), { mode: 0o600 });
  write("roam/config.json", { enabled: true, role: identity === relay ? "hub" : "box", machineId: identity.machineId,
    hubMachineId: relay.machineId, peers: [], discoveryRoots: [], coreUnit: "fixture.service", intercom: { enabled: false, machineAlias: alias } });
  write("roam/machine.json", { machineId: identity.machineId });
  write("herdr/config.json", { mode: "core-only", core: { binary: "/usr/bin/env", config: join(root, "core.toml") },
    globalRoot: root, agentDirectory: agentDir, shellRc: join(root, "shell.rc"), machines: [] });
  const peer: Peer = { ...identity, node: "/node", pi: "/pi", cli: "/spider", core: "/core", globalRoot: root, agentDir };
  return { root, agentDir, peer, configure: (routes: object = {}) => write("roam/intercom-v0.json", {
    version: 2, sendTo: [], acceptFrom: [], relays: [relay.machineId], ...routes,
  }) };
}
type Machine = ReturnType<typeof machine>;

function select(m: Machine) {
  vi.stubEnv("SPIDER_GLOBAL_ROOT", m.root);
  vi.stubEnv("PI_CODING_AGENT_DIR", undefined);
  vi.stubEnv("HC_SOCKET", join(m.root, "hc.sock"));
  vi.stubEnv("HC_SESSION", "relay-fixture");
}
function linkRows(m: Machine, now?: number) {
  return doctor.localRelayDiagnostics(m.root, readLocalIdentity(m.root), now).filter(row => row.reason.startsWith("intercom-link: "));
}
function poll(pollId: string, holdMs: RelayPoll["holdMs"] = 20_000, results: readonly RelayResult[] = [], version = 1): RelayPoll {
  return { holdMs, hello: { type: "hello", version, relay, toMachineId: linked.machineId, linkId: "fixture-link", pollId },
    reach: { type: "reach", peers: [relay] }, results };
}
function inbound() {
  const m = machine(linked);
  m.configure();
  select(m);
  vi.useFakeTimers({ now: START, toFake: ["Date", "setTimeout", "clearTimeout"] });
  const links = createRelayLinks({ now: () => Date.now() - START, wallNow: Date.now, later(ms, fn) {
    const timer = setTimeout(fn, ms);
    return () => clearTimeout(timer);
  } });
  return { m, links };
}

it("reports a held call up after 10 seconds and down by the call deadline without a close observation", async () => {
  const { m, links } = inbound(), abort = new AbortController();
  const held = links.poll(poll("held"), abort.signal);
  try {
    await vi.advanceTimersByTimeAsync(10_001);
    expect(linkRows(m)).toEqual([{ severity: "info", repairCommand: null, reason:
      "intercom-link: relay-1.invalid up; state age 10001ms; last call age 10001ms; last error none; messages carried 0" }]);
    // Doctor may run after a crash, with no broker callback to mark the link down.
    const expired = linkRows(m, START + 30_000);
    expect(expired).toHaveLength(1);
    expect(expired[0].reason).toMatch(/relay-1\.invalid down; state age .*; last call age .*; last error poll-expired; messages carried 0/);
    expect(linkRows(m)[0].reason).toContain("relay-1.invalid up;");
  } finally { abort.abort(); await held; links.close(); }
});

it("starts the 10-second grace at the last normal end, not at either call's start", async () => {
  const { m, links } = inbound();
  try {
    const held = links.poll(poll("held"));
    await vi.advanceTimersByTimeAsync(12_000);
    await links.poll(poll("quick", 0));
    await vi.advanceTimersByTimeAsync(8_000);
    await held;
    expect(linkRows(m, START + 29_999)[0]?.reason).toContain("relay-1.invalid up;");
    const expired = linkRows(m, START + 30_000);
    expect(expired).toHaveLength(1);
    expect(expired[0].reason).toBe("intercom-link: relay-1.invalid down; state age 0ms; last call age 18000ms; last error poll-expired; messages carried 0");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(linkRows(m)[0].reason).toBe(expired[0].reason);
  } finally { links.close(); }
});

it("counts a carried result once, rotates its log, and never writes a submission body", async () => {
  const { m, links } = inbound();
  const directory = join(m.root, "roam", "relay", "in");
  const log = join(directory, `${relay.machineId}.log`), previous = `${log}.1`;
  const sentinelText = "BODY-ONLY-LINK-DOCTOR-SENTINEL", retained = "old log rotation sentinel\n";
  const submit: RelaySubmit = { type: "submit", kind: "send", from: { machineId: linked.machineId,
    address: { sessionId: "sender", scopeId: null }, name: null, endpointEpoch: "source-epoch", homeEpoch: 1 },
    target: { machineId: target.machineId, selector: { by: "name", value: "recipient" } },
    message: { id: "carried", timestamp: 1, text: sentinelText } };
  const carried: RelayResult = { type: "result", messageId: "carried", attempted: true, outcome: { kind: "socket_delivered", id: "carried" } };
  const abort = new AbortController();
  try {
    const held = links.poll(poll("take"));
    expect(existsSync(log)).toBe(true);
    writeFileSync(log, retained.padEnd(64 * 1024, " "));
    const sent = links.submit(relay.machineId, submit);
    expect((await held).submissions).toEqual([submit]);
    await links.poll(poll("result", 0, [carried]));
    await links.poll(poll("duplicate-result", 0, [carried]));
    expect(await sent).toEqual(carried);
    const after = links.poll(poll("disconnect"), abort.signal);
    abort.abort(); await after;
    expect(linkRows(m)[0]?.reason).toMatch(/down;.*last error poll-closed; messages carried 1$/);
    const activeAndRotatedLogs = readFileSync(log, "utf8") + readFileSync(previous, "utf8");
    expect(readFileSync(previous, "utf8")).toContain(retained);
    expect(activeAndRotatedLogs).not.toContain(sentinelText);
    expect(readFileSync(join(directory, `${relay.machineId}.json`), "utf8")).not.toContain(sentinelText);
    for (const file of [log, previous]) {
      expect(statSync(file).size).toBeLessThanOrEqual(64 * 1024);
      expect(statSync(file).mode & 0o777).toBe(0o600);
    }
  } finally { abort.abort(); links.close(); }
});

it("keeps mismatch metadata without a broker and does not let the endpoint overwrite the broker row", async () => {
  const m = machine(linked);
  m.configure(); select(m);
  const inboundDirectory = join(m.root, "roam", "relay", "in");
  const mismatch = () => runV0LinkOnce(m.root, encodeRelayPoll(poll("mismatch", 20_000, [], 2)), 20_000);
  expect(decodeRelayPollReply(await mismatch())).toMatchObject({ ready: { ok: false, code: "version-mismatch", version: 1 }, submissions: [] });
  expect(linkRows(m)).toHaveLength(1);
  expect(linkRows(m)[0].reason).toMatch(/down;.*version-mismatch \(local 1, peer 2\)/);
  expect(existsSync(join(inboundDirectory, `${relay.machineId}.json`))).toBe(false);
  expect(existsSync(join(m.agentDir, "intercom"))).toBe(false);

  const broker = startTestBroker(process.execPath, [join(brokerBuild, "broker.mjs")], {
    env: { ...testBrokerEnv(), SPIDER_GLOBAL_ROOT: m.root, PI_CODING_AGENT_DIR: m.agentDir }, stdio: ["pipe", "pipe", "pipe"],
  });
  brokers.push(broker);
  expect(String((await once(broker.stdout!, "data"))[0])).toContain("Intercom broker started");
  const reply = async (input: RelayPoll) => decodeRelayPollReply(await runV0LinkOnce(m.root, encodeRelayPoll(input), input.holdMs));
  expect((await reply(poll("normal", 0))).ready.ok).toBe(true);
  expect(linkRows(m)).toHaveLength(1);
  expect(linkRows(m)[0].reason).toContain("relay-1.invalid up;");
  const brokerFile = join(inboundDirectory, `${relay.machineId}.json`);
  expect(statSync(brokerFile).mode & 0o777).toBe(0o600);
  expect(decodeRelayPollReply(await mismatch()).ready).toMatchObject({ ok: false, code: "version-mismatch" });
  expect(linkRows(m)).toHaveLength(1);
  expect(linkRows(m)[0].reason).toMatch(/local 1, peer 2/);
  expect(readFileSync(brokerFile, "utf8")).toContain("version-mismatch (local 1, peer 2)");
  expect(await listV0RelayLinks(m.agentDir)).toMatchObject([{ lastCallMs: expect.any(Number) }]);
});

it("names missing config, service, and broker without starting or creating them", () => {
  const sender = machine(linked), carrier = machine(relay);
  select(carrier);
  expect(doctor.localRelayDiagnostics(carrier.root, readLocalIdentity(carrier.root))[0]?.reason).toContain("config-missing");
  carrier.configure({ sendTo: [sender.peer], linkTo: [linked.machineId] });
  expect(linkRows(carrier)[0]?.reason).toMatch(/linked\.invalid down;.*service-missing/);
  sender.configure({ acceptFrom: [relay] });
  expect(linkRows(sender)[0]?.reason).toMatch(/relay-1\.invalid down;.*broker-missing/);
  for (const m of [sender, carrier]) {
    expect(existsSync(join(m.root, "roam", "relay"))).toBe(false);
    expect(existsSync(join(m.agentDir, "intercom"))).toBe(false);
  }
});

function stubMachineList(machines: readonly { name: string; state: string }[]) {
  vi.spyOn(hc, "invokeCli").mockImplementation(async (_binary, argv, env) => {
    expect(env.HC_SOCKET).toBe(process.env.HC_SOCKET);
    expect(env.HC_SESSION).toBe("relay-fixture");
    if (argv[0] === "server") return { version: "0.1.16", core: { id: "relay-core", name: "core-relay.invalid" } };
    expect(argv).toEqual(["machine", "ls", "--json"]);
    return { machines: machines.map(row => ({ ...row, host: row.name, target: row.name, id: `core-${row.name}` })) };
  });
}

it("adopts the selected core display name and advertises only connected routes while showing a version refusal", async () => {
  const carrier = machine(relay, null), sender = machine(linked), receiver = machine(target);
  carrier.configure({ sendTo: [sender.peer, receiver.peer], linkTo: [linked.machineId] });
  select(carrier);
  stubMachineList([{ name: linked.alias, state: "disconnected" }, { name: target.alias, state: "connected" }]);
  const reachWithoutInboundRoute: RelayPeer[] = [];
  vi.spyOn(transport, "createTransport").mockReturnValue({
    resolve: async (peer: Peer) => peer,
    async exec(_peer: Peer, _args: readonly string[], options: { stdin?: Buffer }) {
      const taken = decodeRelayPoll(options.stdin!, 20_000);
      reachWithoutInboundRoute.push(...taken.reach.peers);
      expect(taken.hello.relay).toEqual({ machineId: relay.machineId, alias: "core-relay.invalid" });
      return encodeRelayPollReply({ ready: { ...relayReady(taken.hello, "version-mismatch"), version: 2 }, submissions: [] });
    },
  } as unknown as ReturnType<typeof transport.createTransport>);
  const { startV0Relay } = await import("../relocate/relay-service");
  const service = await startV0Relay(carrier.root);
  try {
    await vi.waitFor(() => expect(linkRows(carrier)[0]?.reason).toMatch(/linked\.invalid down;.*version-mismatch \(local 1, peer 2\)/));
    expect(reachWithoutInboundRoute.map(peer => peer.alias)).toEqual(["core-relay.invalid", "target.invalid"]);
  } finally { await service.stop(); }
});

it("reports an absent Herdr route on the relay and a missing broker on the linked machine", async () => {
  const carrier = machine(relay), sender = machine(linked);
  carrier.configure({ sendTo: [sender.peer], linkTo: [linked.machineId] });
  sender.configure({ acceptFrom: [relay] });
  select(carrier); stubMachineList([]);
  vi.spyOn(transport, "createTransport").mockReturnValue({ async resolve() {
    throw new HerdrError("machine-not-found", "fixture route absent");
  } } as unknown as ReturnType<typeof transport.createTransport>);
  const { startV0Relay } = await import("../relocate/relay-service");
  const service = await startV0Relay(carrier.root);
  try {
    await vi.waitFor(() => expect(linkRows(carrier)[0]?.reason).toContain("route-missing"));
    await expect(startV0Relay(carrier.root)).rejects.toThrow();
    const out: string[] = [];
    // Doctor may already have unrelated diagnostics; the JSON is the contract.
    await main(["roam", "doctor", "--json"], { out: chunk => out.push(chunk), err() {} });
    expect(JSON.parse(out.join("")).value.diagnostics).toContainEqual(expect.objectContaining({ reason: expect.stringContaining("route-missing") }));
    expect(linkRows(sender)[0]?.reason).toContain("broker-missing");
  } finally { await service.stop(); }
});

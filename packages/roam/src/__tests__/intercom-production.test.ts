import { afterEach, expect, it } from "vitest";
import { copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openDb, paths } from "@spider/db-core";
import { HerdrError } from "@spider/herdr/client/parse";
import { openJournal } from "../journal";
import { provisionIntercomEnrollment } from "../intercom-enrollment";
import type { Peer } from "../contracts";
import { firstPairFixture } from "./intercom-first-pair-fixture";
import { runIntercomEnrollCli } from "../intercom-cli";
import { createIntercomRegistry } from "../intercom-registry";

const HUB = "00000000-0000-4000-8000-000000000001", A = "00000000-0000-4000-8000-000000000002", B = "00000000-0000-4000-8000-000000000003";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true }); });
const peer = (machineId: string, alias: string, root: string): Peer => ({ machineId, alias, node: "/fixture/node", pi: "/fixture/pi", cli: "/fixture/cli", core: "/fixture/hc", globalRoot: join(root, alias) });
function fixture(approved: boolean) {
  const root = mkdtempSync(join(paths.scratch("worktree", process.cwd()), "icprod-")); roots.push(root); mkdirSync(join(root, "roam"), { mode: 0o700 });
  const journal = openJournal(join(root, "roam", "journal.db"));
  const source = peer(A, "box-a.invalid", root), target = peer(B, "box-b.invalid", root);
  const request = { operation: { id: "production-1", machineId: HUB, kind: "intercom-enrollment", expectedEpoch: null, args: {} },
    pairs: [{ pairId: "pair-1", source, target, edgeEpoch: "edge-1", connector: { tunnelId: "tunnel", remotePort: 22, session: "default" } }] };
  const keyBytes = Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from("ssh-ed25519"), Buffer.from([0, 0, 0, 32]), Buffer.alloc(32, 8)]);
  const hostKey = { type: "ssh-ed25519", base64: keyBytes.toString("base64") }, publicKey = `ssh-ed25519 ${keyBytes.toString("base64")}`;
  const calls: Array<{ machine: string; command: string; input: any }> = [], previews: unknown[] = [];
  const transport = {
    async pinIntercomPeer(machine: Peer) { return { handle: machine, machineId: machine.machineId, coreId: `core-${machine.machineId}` }; },
    transport: { async exec(machine: Peer, argv: readonly string[], options: { stdin: Buffer; timeoutMs?: number }) {
      const input = JSON.parse(options.stdin.toString()), command = argv[2]; calls.push({ machine: machine.machineId, command, input });
      if (command === "observe-fence") return Buffer.from(JSON.stringify({ version: 1, kind: "intercom-fence", ok: true, value: { machineId: machine.machineId, peer: input.peer, fence: null, revocationPending: false } }));
      if (!journal.read(request.operation.id).some(row => row.action === "intercom-peer-consent" && row.result.approved === true)) throw new Error("setup before consent");
      let value: unknown = { ok: true };
      if (input.action === "check-connector" || input.action === "host-connector" || input.action === "connect-connector") value = { status: "ready" };
      if (input.action === "inspect-ssh") value = { targetMachineId: B, sshUser: "fixture", hostKeys: [hostKey] };
      if (input.action === "ensure-key") value = { publicKey, privateMode: 0o600, privateOwned: true };
      if (input.action === "verify-transport") value = { sourceMachineId: A, targetMachineId: B, connector: true, key: true, route: true };
      if (input.action === "verify-federation") value = { sourceMachineId: A, targetMachineId: B, federation: true };
      return Buffer.from(JSON.stringify({ version: 1, kind: "intercom-setup", ok: true, machineId: machine.machineId, value }));
    } },
  };
  return { root, journal, request, calls, previews, transport, approved };
}
function retryClock() {
  let time = 0;
  const waits: number[] = [];
  return { now: () => time, async sleep(ms: number) { waits.push(ms); time += ms; }, advance(ms: number) { time += ms; }, waits };
}
async function ports(f: ReturnType<typeof fixture>, retry?: ReturnType<typeof retryClock>) {
  const mod = await import("../intercom-production");
  return mod.createProductionIntercomEnrollmentPorts({ root: f.root, journal: f.journal, transport: f.transport as never, request: f.request, retry,
    actor: "fixture", now: () => 1000, async present(value) { f.previews.push(value); }, async approve() { return f.approved; },
    async notify() {}, async warn() {} });
}

it("does not run connector or key commands without separate human approval", async () => {
  const f = fixture(false); const result = await provisionIntercomEnrollment(f.request, await ports(f));
  expect(result).toMatchObject({ code: 1, reason: "peer-consent-required" });
  expect(f.calls.every(call => call.command === "observe-fence")).toBe(true);
  expect(f.previews).toHaveLength(1);
}, 5000);

function cliGraph(f: ReturnType<typeof fixture>): string {
  const config = { enabled: true, role: "hub", machineId: HUB, hubMachineId: HUB, coreUnit: "fixture.service", peers: [f.request.pairs[0].source, f.request.pairs[0].target] };
  writeFileSync(join(f.root, "roam", "config.json"), JSON.stringify(config), { mode: 0o600 });
  writeFileSync(join(f.root, "roam", "machine.json"), JSON.stringify({ machineId: HUB }), { mode: 0o600 });
  const graph = join(f.root, "graph.json"); writeFileSync(graph, JSON.stringify({ pairs: [{ pairId: "pair-1", source: "box-a.invalid", target: "box-b.invalid", edgeEpoch: "edge-1",
    connector: { tunnelId: "tunnel", remotePort: 22, session: "default" } }] }), { mode: 0o600 });
  return graph;
}

it("the operator CLI refuses noninteractive approval and displays the exact graph before asking", async () => {
  const f = fixture(true), graph = cliGraph(f);
  const { runIntercomEnrollCli } = await import("../intercom-cli"); let out = "", err = "", asked = 0;
  const io = { out: (text: string) => { out += text; }, err: (text: string) => { err += text; } };
  const options = { transport: f.transport as never, journal: f.journal, tty: false, ask: async () => { asked++; return "approve"; } };
  expect(await runIntercomEnrollCli({ root: f.root, graphFile: graph, operationId: "production-1" }, io, options)).toBe(1);
  expect(err).toContain("peer-consent-required"); expect(asked).toBe(0); expect(f.calls).toEqual([]);
  err = ""; expect(await runIntercomEnrollCli({ root: f.root, graphFile: graph, operationId: "production-1" }, io, { ...options, tty: true, ask: async () => { asked++; return "no"; } })).toBe(1);
  expect(asked).toBe(1); expect(out).toContain("execute commands"); expect(out).toContain(A); expect(out).toContain(B); expect(out).toContain("edge-1");
  expect(f.calls.every(call => call.command === "observe-fence")).toBe(true);
  const { main } = await import("../cli"); err = "";
  expect(await main(["--global-root", f.root, "roam", "intercom", "enroll", "--graph", graph, "--operation", "production-1"], io,
    { intercomOptions: { ...options, tty: false } } as any)).toBe(1);
  expect(err).toContain("peer-consent-required");
}, 5000);

it("retries a transient unreachable route within one approved enrollment", async () => {
  const f = fixture(true), original = f.transport.transport.exec, timeouts: number[] = [], clock = retryClock();
  let approvals = 0;
  f.transport.transport.exec = async (machine, argv, options) => {
    if (JSON.parse(options.stdin.toString()).action === "add-machine") {
      timeouts.push(options.timeoutMs!);
      if (timeouts.length <= 2) return Buffer.from(JSON.stringify({ version: 1, kind: "intercom-setup", ok: false,
        machineId: machine.machineId, reason: "intercom-setup-pending", cause: { code: "unreachable", message: "private route details" } }));
    }
    return original(machine, argv, options);
  };
  const input = await ports(f, clock), approve = input.approve;
  input.approve = async () => { approvals++; return approve(); };
  const result = await provisionIntercomEnrollment(f.request, input);
  expect(result).toMatchObject({ code: 0, reason: "intercom-enrolled", value: { pairs: ["pair-1"] } });
  expect(timeouts).toHaveLength(3);
  expect(timeouts[0]).toBeLessThanOrEqual(40_000);
  expect(timeouts[1]).toBeLessThan(timeouts[0]); expect(timeouts[2]).toBeLessThan(timeouts[1]);
  expect(clock.waits).toEqual([100, 200]);
  expect(approvals).toBe(1);
  expect(f.calls.filter(call => call.input.action === "verify-transport")).toHaveLength(1);
  expect(JSON.stringify(result)).not.toContain("private route details");
}, 5000);

it.each([["invalid_params", 1], ["unreachable", 8]] as const)("reports %s after at most %i route attempts", async (kind, expectedAttempts) => {
  const f = fixture(true), original = f.transport.transport.exec, clock = retryClock(); let attempts = 0;
  f.transport.transport.exec = async (machine, argv, options) => {
    if (JSON.parse(options.stdin.toString()).action === "add-machine") {
      attempts++;
      return Buffer.from(JSON.stringify({ version: 1, kind: "intercom-setup", ok: false, machineId: machine.machineId,
        reason: "intercom-setup-pending", cause: { code: kind, message: "private route details" } }));
    }
    return original(machine, argv, options);
  };
  const result = await provisionIntercomEnrollment(f.request, await ports(f, clock));
  expect(result).toMatchObject({ code: 3, reason: "intercom-enrollment-pending", value: { pending: [{ pairId: "pair-1", causeCode: kind }] } });
  expect(attempts).toBe(expectedAttempts);
  expect(clock.waits).toHaveLength(expectedAttempts - 1);
  expect(clock.waits.every(wait => wait > 0 && wait <= 2000)).toBe(true);
  expect(f.calls.some(call => call.input.action === "verify-transport")).toBe(false);
  expect(JSON.stringify(result)).not.toContain("private route details");
}, 5000);

it("does not start another route attempt after its deadline is nearly exhausted", async () => {
  const f = fixture(true), original = f.transport.transport.exec, clock = retryClock(); let attempts = 0;
  f.transport.transport.exec = async (machine, argv, options) => {
    if (JSON.parse(options.stdin.toString()).action === "add-machine") {
      attempts++; clock.advance(39_500);
      return Buffer.from(JSON.stringify({ version: 1, kind: "intercom-setup", ok: false, machineId: machine.machineId,
        reason: "intercom-setup-pending", cause: { code: "unreachable" } }));
    }
    return original(machine, argv, options);
  };
  const result = await provisionIntercomEnrollment(f.request, await ports(f, clock));
  expect(result).toMatchObject({ code: 3, value: { pending: [{ pairId: "pair-1", causeCode: "unreachable" }] } });
  expect(attempts).toBe(1); expect(clock.waits).toEqual([]);
}, 5000);

it.each([[34_901, 1, "unreachable"], [34_900, 2, null]] as const)(
  "requires a five-second route budget after backoff (elapsed %i)", async (elapsed, expectedAttempts, expectedCause) => {
    const f = fixture(true), original = f.transport.transport.exec, clock = retryClock(), timeouts: number[] = []; let attempts = 0;
    f.transport.transport.exec = async (machine, argv, options) => {
      if (JSON.parse(options.stdin.toString()).action === "add-machine") {
        attempts++; timeouts.push(options.timeoutMs!);
        if (attempts === 1) {
          clock.advance(elapsed);
          return Buffer.from(JSON.stringify({ version: 1, kind: "intercom-setup", ok: false, machineId: machine.machineId,
            reason: "intercom-setup-pending", cause: { code: "unreachable" } }));
        }
      }
      return original(machine, argv, options);
    };
    const result = await provisionIntercomEnrollment(f.request, await ports(f, clock));
    if (expectedCause) expect(result).toMatchObject({ code: 3, value: { pending: [{ pairId: "pair-1", causeCode: expectedCause }] } });
    else expect(result).toMatchObject({ code: 0, reason: "intercom-enrolled" });
    expect(attempts).toBe(expectedAttempts);
    if (expectedAttempts === 2) expect(timeouts[1]).toBe(5_000);
  }, 5000);

it("does not start a short route attempt when backoff oversleeps", async () => {
  const f = fixture(true), original = f.transport.transport.exec, clock = retryClock(); let attempts = 0;
  clock.sleep = async ms => { clock.waits.push(ms); clock.advance(ms + 6_000); };
  f.transport.transport.exec = async (machine, argv, options) => {
    if (JSON.parse(options.stdin.toString()).action === "add-machine") {
      attempts++; clock.advance(30_000);
      return Buffer.from(JSON.stringify({ version: 1, kind: "intercom-setup", ok: false, machineId: machine.machineId,
        reason: "intercom-setup-pending", cause: { code: "unreachable" } }));
    }
    return original(machine, argv, options);
  };
  const result = await provisionIntercomEnrollment(f.request, await ports(f, clock));
  expect(result).toMatchObject({ code: 3, value: { pending: [{ pairId: "pair-1", causeCode: "unreachable" }] } });
  expect(attempts).toBe(1); expect(clock.waits).toEqual([100]);
});

it("prints a bounded cause when the final enrollment receipt fails", async () => {
  const f = fixture(true), graph = cliGraph(f), record = f.journal.record.bind(f.journal);
  const journal = { ...f.journal, record(id: string, action: string, result: Parameters<typeof record>[2]) {
    if (action === "done") throw new HerdrError("EACCES", "private receipt details");
    record(id, action, result);
  } };
  const { runIntercomEnrollCli } = await import("../intercom-cli"); let err = "";
  const code = await runIntercomEnrollCli({ root: f.root, graphFile: graph, operationId: "production-1" }, { out() {}, err(text) { err += text; } },
    { transport: f.transport as never, journal, tty: true, ask: async () => "approve" });
  expect(code).toBe(3);
  expect(err).toContain("intercom-enrollment-pending [EACCES]");
  expect(err).not.toContain("private receipt details");
}, 5000);

it("names unpublished local WAL frames after successful retry fence observations", async () => {
  const f = fixture(true), graph = cliGraph(f), original = f.transport.transport.exec;
  let retrying = false;
  f.transport.transport.exec = async (machine, argv, options) => {
    const input = JSON.parse(options.stdin.toString());
    if (input.action === "verify-federation") return Buffer.from(JSON.stringify({ version: 1, kind: "intercom-setup", ok: true,
      machineId: machine.machineId, value: { sourceMachineId: A, targetMachineId: B, federation: false } }));
    const reply = await original(machine, argv, options);
    if (retrying && argv[2] === "observe-fence" && machine.machineId === B) {
      const file = join(f.root, "publishing.db"), writer = openDb(file);
      try {
        writer.exec("CREATE TABLE fixture(value TEXT); INSERT INTO fixture VALUES ('visible')");
        const earlierIndex = readFileSync(`${file}-shm`);
        writer.exec("INSERT INTO fixture VALUES ('unpublished')");
        const queue = join(f.root, "roam", "intercom", "queue.db");
        copyFileSync(file, queue); copyFileSync(`${file}-wal`, `${queue}-wal`); writeFileSync(`${queue}-shm`, earlierIndex);
      } finally { writer.close(); }
    }
    return reply;
  };
  const { runIntercomEnrollCli } = await import("../intercom-cli"); let err = "";
  const io = { out() {}, err: (text: string) => { err += text; } };
  const options = { transport: f.transport as never, journal: f.journal, tty: true, ask: async () => "approve" };
  const input = { root: f.root, graphFile: graph, operationId: "production-1" };
  expect(await runIntercomEnrollCli(input, io, options)).toBe(3);
  expect(err).toContain("intercom-verification-pending");
  const beforeRetry = f.calls.length; retrying = true; err = "";
  expect(await runIntercomEnrollCli(input, io, options)).toBe(3);
  expect(f.calls.slice(beforeRetry).map(call => call.command)).toEqual(["observe-fence", "observe-fence"]);
  expect(err).toContain("pair-1: intercom-enrollment-pending [diagnostic-snapshot-wal-unpublished]");
  expect(err).not.toContain("WAL frames");
  expect(err).not.toContain(f.root);
}, 5000);

it.each([
  ["EACCES", "EACCES"],
  ["unreachable", "unreachable"],
  ["diagnostic-snapshot-changing", "diagnostic-snapshot-changing"],
  ["/private/fixture.key", "unknown"],
  ["ghp" + "_" + "synthetic".padEnd(39, "0"), "unknown"],
  ["ERR_STREAM_DESTROYED", "ERR_STREAM_DESTROYED"],
  ["SQLITE_BUSY", "SQLITE_BUSY"],
])("reports only a safe helper error code on retry: %s", async (code, expected) => {
  const f = fixture(true), graph = cliGraph(f), original = f.transport.transport.exec;
  let retrying = false;
  f.transport.transport.exec = async (machine, argv, options) => {
    const input = JSON.parse(options.stdin.toString());
    if (input.action === "verify-federation") return Buffer.from(JSON.stringify({ version: 1, kind: "intercom-setup", ok: true,
      machineId: machine.machineId, value: { sourceMachineId: A, targetMachineId: B, federation: false } }));
    if (retrying && input.action === "ensure-key") return Buffer.from(JSON.stringify({ version: 1, kind: "intercom-setup", ok: false,
      machineId: machine.machineId, reason: "intercom-setup-pending", cause: { code, message: "cannot open /private/fixture.key" } }));
    return original(machine, argv, options);
  };
  const { runIntercomEnrollCli } = await import("../intercom-cli"); let err = "";
  const io = { out() {}, err: (text: string) => { err += text; } };
  const options = { transport: f.transport as never, journal: f.journal, tty: true, ask: async () => "approve" };
  const input = { root: f.root, graphFile: graph, operationId: "production-1" };
  expect(await runIntercomEnrollCli(input, io, options)).toBe(3);
  expect(err).toContain("intercom-verification-pending");
  retrying = true; err = "";
  expect(await runIntercomEnrollCli(input, io, options)).toBe(3);
  const expectedCause = expected === "unknown" ? "unexpected-ensure-key" : expected;
  expect(err).toContain(`pair-1: intercom-enrollment-pending [${expectedCause}]`);
  expect(err).not.toContain("cannot open");
  expect(err).not.toContain("/private/fixture.key");
}, 5000);

it("explains an unverified listener key to the operator", async () => {
  const f = fixture(true), config = { enabled: true, role: "hub", machineId: HUB, hubMachineId: HUB, coreUnit: "fixture.service", peers: [f.request.pairs[0].source, f.request.pairs[0].target] };
  writeFileSync(join(f.root, "roam", "config.json"), JSON.stringify(config), { mode: 0o600 });
  writeFileSync(join(f.root, "roam", "machine.json"), JSON.stringify({ machineId: HUB }), { mode: 0o600 });
  const graph = join(f.root, "graph.json"); writeFileSync(graph, JSON.stringify({ pairs: [{ pairId: "pair-1", source: "box-a.invalid", target: "box-b.invalid", edgeEpoch: "edge-1",
    connector: { tunnelId: "tunnel", remotePort: 22, session: "default" } }] }), { mode: 0o600 });
  const original = f.transport.transport.exec;
  f.transport.transport.exec = async (machine, argv, options) => {
    if (JSON.parse(options.stdin.toString()).action === "inspect-ssh") return Buffer.from(JSON.stringify({ version: 1, kind: "intercom-setup", ok: false, machineId: machine.machineId, reason: "intercom-ssh-host-unverified" }));
    return original(machine, argv, options);
  };
  const { runIntercomEnrollCli } = await import("../intercom-cli"); let err = "";
  const code = await runIntercomEnrollCli({ root: f.root, graphFile: graph, operationId: "production-1" }, { out: () => {}, err: text => { err += text; } },
    { transport: f.transport as never, journal: f.journal, tty: true, ask: async () => "approve" });
  expect(code).toBe(3);
  expect(err).toContain("intercom-ssh-host-unverified");
  expect(err).toContain("The key presented on the pair's port is not one of this machine's system host keys");
  expect(err).toContain("Check the SSH listener and its system host keys");
}, 5000);

it.each(["host-key-changed", "revocation-pending", "fresh-peer-consent-required"])("does not append a cause code to the precise operator reason %s", async reason => {
  const f = fixture(true), graph = cliGraph(f), original = f.transport.transport.exec;
  f.transport.transport.exec = async (machine, argv, options) => {
    const input = JSON.parse(options.stdin.toString());
    if (input.action === "ensure-key") return Buffer.from(JSON.stringify({ version: 1, kind: "intercom-setup", ok: false,
      machineId: machine.machineId, reason, cause: { code: "EACCES", message: "private details" } }));
    return original(machine, argv, options);
  };
  const { runIntercomEnrollCli } = await import("../intercom-cli"); let err = "";
  expect(await runIntercomEnrollCli({ root: f.root, graphFile: graph, operationId: "production-1" }, { out() {}, err: text => { err += text; } },
    { transport: f.transport as never, journal: f.journal, tty: true, ask: async () => "approve" })).toBe(3);
  expect(err).toContain(`pair-1: ${reason}\n`);
  expect(err).not.toContain("[");
}, 5000);

it("reports connector-not-pair-scoped before creating any credentials or routes", async () => {
  const f = fixture(true), original = f.transport.transport.exec;
  f.transport.transport.exec = async (machine, argv, options) => {
    const request = JSON.parse(options.stdin.toString());
    if (request.action === "host-connector") { f.calls.push({ machine: machine.machineId, command: argv[2], input: request });
      return Buffer.from(JSON.stringify({ version: 1, kind: "intercom-setup", ok: true, machineId: machine.machineId, value: { status: "connector-not-pair-scoped" } })); }
    return original(machine, argv, options);
  };
  expect(await provisionIntercomEnrollment(f.request, await ports(f))).toMatchObject({ code: 3, value: { pending: [{ pairId: "pair-1", reason: "connector-not-pair-scoped" }] } });
  expect(f.calls.some(call => ["ensure-key", "write-route", "authorize", "add-machine", "publish-config"].includes(call.input.action))).toBe(false);
}, 5000);

it("enrolls a first hub-only pair and switches only after hub custody drains", async () => {
  const f = await firstPairFixture();
  try {
    const boxes = [f.source, f.target], initial = boxes.map(peer => f.readConfig(peer));
    for (const peer of [f.hub, ...boxes]) expect(await createIntercomRegistry(peer.globalRoot).list()).toEqual([]);
    for (const config of initial) {
      expect(config.intercom.mode).toBe("hub-only");
      expect(config.intercom.routes).toHaveLength(1);
      expect(config.intercom.routes[0]).toMatchObject({ kind: "direct", peer: { machineId: HUB } });
    }
    const unrelated = { kind: "relay", peer: f.otherSource, via: HUB };
    const retainedRoutes = initial.map(config => [...config.intercom.routes, unrelated]);
    for (const [index, peer] of boxes.entries()) f.saveConfig(peer, { ...initial[index],
      intercom: { ...initial[index].intercom, routes: retainedRoutes[index] } });
    let approvals = 0, out = "", err = "";
    const io = { out(text: string) { out += text; }, err(text: string) { err += text; } };
    const options = { transport: f.transport, journal: f.journal, tty: true, async ask() { approvals++; return "approve"; } };
    // Seed relay custody whose consumption receipt still belongs to the hub.
    // Only its external return path is paused; direct pair enrollment stays live.
    f.pauseOrigin(true);
    const sourceQueue = f.queues.get(A)!, from = { sessionId: "sender", scopeId: "scope" };
    const endpoint = { address: { sessionId: "recipient", scopeId: "scope" }, machineId: B, homeEpoch: null, activationEpoch: "recipient-generation" };
    const accepted = sourceQueue.acceptOutbound({ from, endpoint, nextHop: HUB,
      message: { id: "retained-relay", timestamp: 1000, content: { text: "synthetic" } } });
    expect(accepted.kind).toBe("accepted");
    const [frame] = sourceQueue.pending({ kind: "outbound", peer: HUB, hopBudgetMs: 1000 });
    expect(f.hubQueue.acceptInbound({ peer: A, frame }).kind).toBe("accepted");
    f.hubQueue.acceptOutbound({ frame, nextHop: B });
    sourceQueue.acknowledge({ peer: HUB, identity: frame.identity, kind: frame.kind });
    const receipt = { from: endpoint, to: from, digest: frame.identity.digest, attempt: 1, originMachineId: A, sequence: frame.identity.sequence,
      receipt: { messageId: "retained-relay", status: "injected" as const, timestamp: 1000,
        evidence: { kind: "entry" as const, entryId: "fixture-entry", sessionId: endpoint.address.sessionId, activationEpoch: endpoint.activationEpoch } } };
    f.hubQueue.settleReceipt({ queue: "outbound", peer: B, frame: receipt });
    f.hubQueue.settleReceipt({ queue: "inbound", peer: A, frame: receipt });
    expect(f.hubQueue.pending({ kind: "receipts", peer: A })).toHaveLength(1);
    expect(await runIntercomEnrollCli({ root: f.root, graphFile: f.graph, operationId: "enroll-1" }, io, options), err).toBe(0);
    expect(approvals).toBe(1);
    expect(out).toContain("intercom-enrolled");
    for (const [index, peer] of boxes.entries()) {
      const saved = f.readConfig(peer), remote = index === 0 ? f.target : f.source;
      expect(saved.intercom.mode).toBe("hub-only");
      expect(saved.intercom.routes).toEqual([...retainedRoutes[index], { kind: "relay", peer: remote, via: HUB }]);
      expect(saved.peers).toEqual(initial[index].peers);
      expect(saved.intercom.connector).toEqual(initial[index].intercom.connector);
      expect(f.queues.get(peer.machineId)!.topology().mode).toBe("hub-only");
      const record = (await createIntercomRegistry(peer.globalRoot).get("pair-1"))!;
      expect(record).toMatchObject({ state: "active", pair: { source: f.source, target: f.target, edgeEpoch: "edge-1" } });
      const retry = await f.transport.transport.exec(peer, ["roam", "intercom", "setup-local"], { timeoutMs: 40_000, maxBytes: 1024 * 1024,
        stdin: f.publications.get(peer.machineId)! });
      expect(JSON.parse(retry.toString()), retry.toString()).toMatchObject({ ok: true, value: { published: true } });
      expect(f.readConfig(peer)).toEqual(saved);
      if (process.platform !== "win32") expect(lstatSync(join(peer.globalRoot, "roam", "config.json")).mode & 0o777).toBe(0o600);
      expect(await f.brokers.get(peer.machineId)!.helper({ version: 1, action: "inspect-pair", machineId: peer.machineId,
        peer: remote.machineId, edgeEpoch: "edge-1" }, new AbortController().signal)).toMatchObject({ status: "live" });
    }
    expect(f.hubQueue.topology()).toMatchObject({ mode: "hub-only", transition: { state: "draining" } });
    expect(sourceQueue.retained("outbound", "retained-relay")).toMatchObject({ state: "queued", payloadRetained: true });
    f.pauseOrigin(false);
    await f.pump(1000);
    for (let attempt = 0; attempt < 5 && f.hubQueue.topology().mode !== "peers"; attempt++) await f.pump(1000);
    expect(f.hubQueue.topology()).toMatchObject({ mode: "peers", transition: { state: "complete" } });
    expect(f.hubQueue.pending({ kind: "receipts", peer: A })).toEqual([]);
    expect(sourceQueue.retained("outbound", "retained-relay")).toMatchObject({ state: "injected", payloadRetained: false });
    for (const peer of boxes) expect(f.queues.get(peer.machineId)!.topology().mode).toBe("peers");
    const beforeRetry = boxes.map(peer => f.readConfig(peer));
    err = "";
    expect(await runIntercomEnrollCli({ root: f.root, graphFile: f.graph, operationId: "enroll-1" }, io, options), err).toBe(0);
    expect(approvals).toBe(1);
    expect(f.journal.read("enroll-1").filter(row => row.action === "intercom-peer-consent")).toHaveLength(1);
    for (const [index, peer] of boxes.entries()) {
      expect(f.readConfig(peer)).toEqual(beforeRetry[index]);
      expect(f.readConfig(peer).intercom.routes.filter((route: { peer: Peer }) => route.peer.machineId === boxes[1 - index].machineId)).toHaveLength(1);
      expect((await createIntercomRegistry(peer.globalRoot).list())).toHaveLength(1);
    }
  } finally { await f.close(); }
}, 5000);

it("refuses a wrong-hub relay rather than replacing it during approved publication", async () => {
  const f = await firstPairFixture();
  try {
    const exec = f.transport.transport.exec.bind(f.transport.transport);
    let refusedConfig: unknown, approvals = 0, enrollments = 0;
    f.transport.transport.exec = async (peer, argv, options) => {
      const input = JSON.parse(options.stdin!.toString());
      if (input.action === "enroll-live") enrollments++;
      if (input.action === "publish-config" && peer.machineId === A) {
        const config = f.readConfig(f.source);
        refusedConfig = { ...config, intercom: { ...config.intercom,
          routes: [...config.intercom.routes, { kind: "relay", peer: f.target, via: "00000000-0000-4000-8000-000000000004" }] } };
        f.saveConfig(f.source, refusedConfig);
      }
      return exec(peer, argv, options);
    };
    let err = "";
    expect(await runIntercomEnrollCli({ root: f.root, graphFile: f.graph, operationId: "enroll-1" },
      { out() {}, err(text) { err += text; } }, { transport: f.transport, journal: f.journal, tty: true,
        async ask() { approvals++; return "approve"; } })).toBe(3);
    expect(err).toContain("publication publish-config on source");
    expect(approvals).toBe(1);
    expect(enrollments).toBe(0);
    expect(f.readConfig(f.source)).toEqual(refusedConfig);
    for (const peer of [f.source, f.target]) expect(f.queues.get(peer.machineId)!.topology().mode).toBe("hub-only");
    expect(f.hubQueue.topology().transition).toBeNull();
  } finally { await f.close(); }
}, 5000);

it("keeps a first pair pending when its box has no direct hub edge", async () => {
  const f = await firstPairFixture();
  try {
    const config = f.readConfig(f.source), before = { ...config, intercom: { ...config.intercom, routes: [] } };
    f.saveConfig(f.source, before);
    let err = "";
    expect(await runIntercomEnrollCli({ root: f.root, graphFile: f.graph, operationId: "enroll-1" },
      { out() {}, err(text) { err += text; } }, { transport: f.transport, journal: f.journal, tty: true,
        async ask() { return "approve"; } })).toBe(3);
    expect(err).toContain("publication publish-config on source [intercom-route-missing]");
    expect(f.readConfig(f.source)).toEqual(before);
    expect(f.hubQueue.topology().transition).toBeNull();
  } finally { await f.close(); }
}, 5000);

it("composes both endpoint operations only after journaled exact-graph approval", async () => {
  const f = fixture(true); const result = await provisionIntercomEnrollment(f.request, await ports(f));
  expect(result).toMatchObject({ code: 0, reason: "intercom-enrolled", value: { pairs: ["pair-1"] } });
  const setup = f.calls.filter(call => call.command === "setup-local");
  expect(setup.map(call => call.input.action)).toEqual(expect.arrayContaining(["check-connector", "inspect-ssh", "register-pair", "host-connector", "connect-connector", "ensure-key", "write-route", "authorize", "add-machine", "verify-transport", "publish-config", "enroll-live", "verify-federation", "activate-pair"]));
  expect(setup.every(call => call.input.approval?.approved === true && call.input.approval.operationId === "production-1")).toBe(true);
  expect(setup.filter(call => call.input.action === "enroll-live").map(call => call.machine)).toEqual([B, A]);
  expect(setup.filter(call => call.input.action === "enroll-live").every(call => call.input.expectedFenceId === null)).toBe(true);
}, 5000);

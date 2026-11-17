import { afterEach, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { paths } from "@spider/db-core";
import { openJournal } from "../journal";
import { provisionIntercomEnrollment } from "../intercom-enrollment";
import type { Peer } from "../contracts";

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
    transport: { async exec(machine: Peer, argv: readonly string[], options: { stdin: Buffer }) {
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
async function ports(f: ReturnType<typeof fixture>) {
  const mod = await import("../intercom-production");
  return mod.createProductionIntercomEnrollmentPorts({ root: f.root, journal: f.journal, transport: f.transport as never, request: f.request,
    actor: "fixture", now: () => 1000, async present(value) { f.previews.push(value); }, async approve() { return f.approved; },
    async notify() {}, async warn() {} });
}

it("does not run connector or key commands without separate human approval", async () => {
  const f = fixture(false); const result = await provisionIntercomEnrollment(f.request, await ports(f));
  expect(result).toMatchObject({ code: 1, reason: "peer-consent-required" });
  expect(f.calls.every(call => call.command === "observe-fence")).toBe(true);
  expect(f.previews).toHaveLength(1);
}, 5000);

it("the operator CLI refuses noninteractive approval and displays the exact graph before asking", async () => {
  const f = fixture(true), config = { enabled: true, role: "hub", machineId: HUB, hubMachineId: HUB, coreUnit: "fixture.service", peers: [f.request.pairs[0].source, f.request.pairs[0].target] };
  writeFileSync(join(f.root, "roam", "config.json"), JSON.stringify(config), { mode: 0o600 });
  writeFileSync(join(f.root, "roam", "machine.json"), JSON.stringify({ machineId: HUB }), { mode: 0o600 });
  const graph = join(f.root, "graph.json"); writeFileSync(graph, JSON.stringify({ pairs: [{ pairId: "pair-1", source: "box-a.invalid", target: "box-b.invalid", edgeEpoch: "edge-1",
    connector: { tunnelId: "tunnel", remotePort: 22, session: "default" } }] }), { mode: 0o600 });
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
  expect(err.toLowerCase()).toContain("the key presented on the pair's port is not one of this machine's system host keys");
  expect(err).toContain("Check the SSH listener and its system host keys");
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

it("composes both endpoint operations only after journaled exact-graph approval", async () => {
  const f = fixture(true); const result = await provisionIntercomEnrollment(f.request, await ports(f));
  expect(result).toMatchObject({ code: 0, reason: "intercom-enrolled", value: { pairs: ["pair-1"] } });
  const setup = f.calls.filter(call => call.command === "setup-local");
  expect(setup.map(call => call.input.action)).toEqual(expect.arrayContaining(["check-connector", "inspect-ssh", "register-pair", "host-connector", "connect-connector", "ensure-key", "write-route", "authorize", "add-machine", "verify-transport", "publish-config", "enroll-live", "verify-federation", "activate-pair"]));
  expect(setup.every(call => call.input.approval?.approved === true && call.input.approval.operationId === "production-1")).toBe(true);
  expect(setup.filter(call => call.input.action === "enroll-live").map(call => call.machine)).toEqual([B, A]);
  expect(setup.filter(call => call.input.action === "enroll-live").every(call => call.input.expectedFenceId === null)).toBe(true);
}, 5000);

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { paths } from "@spider/db-core";
import { main } from "../cli";
import { parseHelperFence } from "../intercom-helper";
import { openJournal } from "../journal";
import { openIntercomStore } from "../intercom-store";
import { createIntercomRegistry, withIntercomPeerLock } from "../intercom-registry";
import { randomUUID } from "node:crypto";
import { provisionIntercomEnrollment, revokeIntercomPair } from "../intercom-enrollment";
import { createProductionIntercomEnrollmentPorts, createProductionIntercomRevocationPorts } from "../intercom-production";
import { runLocalPairCleanup, runLocalPairOperation, type LocalPairPorts } from "../intercom-local-ops";
import type { Peer, Journal } from "../contracts";
import type { IntercomEnrollmentPorts, IntercomEnrollmentRequest, IntercomRevocationPorts } from "../provision-contracts";
import type { IntercomStore } from "../intercom-contracts";
import type { ProvisionTransport } from "../transport";
import { systemSshFixture } from "./intercom-ssh-system-fixture";
export interface FakePairUnit { name: string; file: string; pid: number; state: string; members: number[] }
export interface PairTerminalRow { address: string; state: string; exit_code?: unknown; signal?: unknown; reason?: unknown }
export interface PairScenario {
  root: string; source: Peer; target: Peer; otherSource: Peer; journal: Journal; calls: string[]; locals: Map<string, LocalPairPorts>; queues: Map<string, IntercomStore>;
  units: Map<string, FakePairUnit>; enrollment: IntercomEnrollmentPorts; request: IntercomEnrollmentRequest; revokePorts: IntercomRevocationPorts; publicKey: string; transport: ProvisionTransport;
  connected(): boolean; connect(): void; straggler(value: boolean): void; offline(value: boolean): void; listingError(value: boolean): void; mismatch(): void;
  terminals(value: PairTerminalRow[]): void; machines(): Array<Record<string, unknown>>; otherMachines(): Array<Record<string, unknown>>;
}

const HUB = "00000000-0000-4000-8000-000000000001", A = "00000000-0000-4000-8000-000000000002", B = "00000000-0000-4000-8000-000000000003";
const roots: string[] = [], closes: Array<() => void> = [];
export function cleanupPairScenarios(): void { for (const close of closes.splice(0)) close(); for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true }); }
export async function scenario(): Promise<PairScenario> {
  const root = mkdtempSync(join(paths.scratch("worktree", process.cwd()), "pair-scenario-")); roots.push(root);
  const makePeer = (machineId: string, alias: string): Peer => ({ machineId, alias, node: "/fixture/node", pi: "/fixture/pi", cli: "/fixture/cli", core: "/fixture/hc", globalRoot: join(root, alias) });
  const source = makePeer(A, "box-a.invalid"), target = makePeer(B, "box-b.invalid"), otherSource = makePeer("00000000-0000-4000-8000-000000000000", "box-c.invalid");
  const recipe = { check: ["/fixture/connector", "check"], host: ["/fixture/connector", "host", "{pairId}"], connect: ["/fixture/connector", "connect", "{pairId}"], localPort: 23222 };
  const calls: string[] = [], units = new Map<string, { name: string; file: string; pid: number; state: string; members: number[] }>();
  let nextPid = 100, nextKey = 8, connection = false, straggler = false, offline = false, listError = false, mismatch = false;
  let terminals: PairTerminalRow[] = [];
  const routes = new Map<string, Array<Record<string, unknown>>>();
  const blob = Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from("ssh-ed25519"), Buffer.from([0, 0, 0, 32]), Buffer.alloc(32, 7)]), hostPublicKey = `ssh-ed25519 ${blob.toString("base64")}`, publicKey = `ssh-ed25519 ${Buffer.concat([blob.subarray(0, 19), Buffer.alloc(32, 8)]).toString("base64")}`;
  const locals = new Map<string, LocalPairPorts>(), queues = new Map<string, ReturnType<typeof openIntercomStore>>();
  const clock = { now: () => 1000, later: () => () => {} };
  for (const peer of [source, target, otherSource]) {
    routes.set(peer.machineId, []);
    const home = join(peer.globalRoot, "home"), roam = join(peer.globalRoot, "roam"); mkdirSync(home, { recursive: true, mode: 0o700 }); mkdirSync(roam, { mode: 0o700 });
    writeFileSync(join(roam, "machine.json"), JSON.stringify({ machineId: peer.machineId }), { mode: 0o600 });
    writeFileSync(join(roam, "config.json"), JSON.stringify({ enabled: false, role: "box", machineId: peer.machineId, hubMachineId: HUB, coreUnit: "fixture.service", peers: [],
      intercom: { enabled: true, mode: "peers", machineAlias: peer.alias, routes: [], connector: recipe } }), { mode: 0o600 });
    const queue = openIntercomStore({ file: join(roam, "intercom", "queue.db"), machineId: peer.machineId, clock }); queues.set(peer.machineId, queue); closes.push(() => queues.get(peer.machineId)!.close());
    const run = async (argv: readonly string[]) => {
      calls.push(`${peer.machineId}:${argv.slice(1).join(" ")}`);
      if (argv[0] === "/fixture/connector") return { code: 0, stdout: JSON.stringify({ connector: "ready", login: "ready", tunnel: "hosted", peerPort: "reachable" }) };
      if (argv[0] === "/fixture/ssh-keyscan") {
        if (JSON.stringify(argv) !== JSON.stringify(["/fixture/ssh-keyscan", "-T", "5", "-t", "ed25519,ecdsa,rsa", "-p", "22", "127.0.0.1"])) throw new Error("unexpected fixture command");
        return { code: 0, stdout: `127.0.0.1 ${hostPublicKey}\n` };
      }
      if (argv[0] === "/fixture/keygen") { const file = argv[argv.indexOf("-f") + 1]; writeFileSync(file, "fixture-private", { mode: 0o600 }); const key = Buffer.concat([blob.subarray(0, 19), Buffer.alloc(32, nextKey++)]); writeFileSync(`${file}.pub`, `ssh-ed25519 ${key.toString("base64")}`, { mode: 0o644 }); return { code: 0, stdout: "" }; }
      if (argv[0] === "/fixture/systemctl") {
        const name = argv[3], key = `${peer.machineId}/${name}`;
        if (argv[2] === "daemon-reload") return { code: 0, stdout: "" };
        if (!units.has(key) && !existsSync(join(home, ".config", "systemd", "user", name))) return { code: argv[2] === "show" ? 0 : 1,
          stdout: argv[2] === "show" ? `Id=${name}\nLoadState=not-found\nActiveState=inactive\nMainPID=0\nControlGroup=\nKillMode=control-group\nFragmentPath=\nDropInPaths=\nNeedDaemonReload=no\n` : "" };
        if (!units.has(key)) units.set(key, { name, file: join(home, ".config", "systemd", "user", name), pid: 0, state: "inactive", members: [] });
        const unit = units.get(key)!;
        if (argv[2] === "start") { unit.pid = ++nextPid; unit.state = "active"; unit.members = [unit.pid, ++nextPid]; }
        if (argv[2] === "stop") { unit.state = "inactive"; unit.pid = 0; unit.members = straggler && name.endsWith("-host.service") ? unit.members.slice(-1) : []; if (name.endsWith("-host.service")) connection = unit.members.length > 0; }
        return { code: 0, stdout: argv[2] === "show" ? `Id=${unit.name}\nLoadState=loaded\nActiveState=${unit.state}\nMainPID=${unit.pid}\nControlGroup=/user.slice/${unit.name}\nKillMode=control-group\nFragmentPath=${unit.file}\nDropInPaths=\nNeedDaemonReload=no\n` : "" };
      }
      if (argv[1] === "machine" && argv[2] === "ls") return { code: 0, stdout: JSON.stringify({ machines: routes.get(peer.machineId)!.map(row => mismatch && row.name === "spider-pair-pair-1" ? { ...row, session: "changed" } : row) }) };
      if (argv[1] === "machine" && argv[2] === "add") { routes.get(peer.machineId)!.push({ name: argv[argv.indexOf("--name") + 1], id: "core-b", via: true, target: argv[argv.indexOf("--via") + 1], session: "default", temporary: false, state: "connected", host: "box-b.invalid", version: "0.1.16" }); return { code: 0, stdout: "{}" }; }
      if (argv[1] === "machine" && argv[2] === "rm") { routes.set(peer.machineId, routes.get(peer.machineId)!.filter(row => row.name !== argv[3])); return { code: 0, stdout: "{}" }; }
      if (argv[1] === "ls") { if (listError) throw new Error("listing unavailable"); return { code: 0, stdout: JSON.stringify({ terminals: terminals.map(row => ({ agent: "", cwd: "/home/fixture", turn: 0,
        ...(row.state === "finished" ? { exit_code: 0, reason: "exited" } : {}), ...row,
        address: peer.machineId === B ? row.address.replace(/^spider-pair-pair-1\//, "") : row.address })), machines: routes.get(peer.machineId), hidden_finished: 0 }) }; }
      if (argv[1] === "exec") return { code: 0, stdout: JSON.stringify({ version: 1, kind: "doctor", machineId: B, value: {} }) };
      throw new Error("unexpected fixture command");
    };
    const systemSshFiles = systemSshFixture(peer.globalRoot, [{ type: "ssh-ed25519", base64: blob.toString("base64") }]).filesystem;
    locals.set(peer.machineId, { machineId: peer.machineId, root: peer.globalRoot, home, node: process.execPath, ssh: "/fixture/ssh", keygen: "/fixture/keygen", keyscan: "/fixture/ssh-keyscan", sshUser: "fixture", systemctl: "/fixture/systemctl", recipe, run, systemSshFiles,
      process: pid => [...units.entries()].some(([key, unit]) => key.startsWith(`${peer.machineId}/`) && unit.members.includes(pid)) ? { kind: "live", startIdentity: `linux:${pid}` } : { kind: "absent" },
      cgroup: group => units.get(`${peer.machineId}/${group.split("/").at(-1)}`)?.members ?? [],
      inspectFence: async input => { const peerId = (input as { peer: string }).peer; return { machineId: peer.machineId, peer: peerId, fence: queues.get(peer.machineId)!.pairFence(peerId) }; },
      inspectBridge: async input => ({ ...(input as { machineId: string; peer: string; edgeEpoch: string }), status: "live", reason: null }),
      enrollBridge: async input => { const value = input as { peer: string; edgeEpoch: string; operationId: string; graphDigest: string; expectedFenceId: string | null };
        queues.get(peer.machineId)!.approvePair(value.peer, value); return { ...value, applied: true }; } });
  }
  const request = { operation: { id: "enroll-1", machineId: HUB, kind: "intercom-enrollment", expectedEpoch: null, args: {} }, pairs: [{ pairId: "pair-1", source, target, edgeEpoch: "edge-1", connector: { tunnelId: "tunnel-1", remotePort: 22, session: "default" } }] };
  const journal = openJournal(join(root, "journal.db"));
  const fencePeer = (machine: Peer, peer: string, epoch: string, requested?: string) => withIntercomPeerLock(machine.globalRoot, machine.machineId, peer, async () => {
    const registry = createIntercomRegistry(machine.globalRoot), records = (await registry.list()).filter(record => record.pair.edgeEpoch === epoch &&
      (record.pair.source.machineId === machine.machineId && record.pair.target.machineId === peer || record.pair.target.machineId === machine.machineId && record.pair.source.machineId === peer));
    const id = requested ?? records.find(record => record.state === "revoking" || record.state === "revoked")?.fenceId ?? randomUUID();
    for (const record of records) await registry.beginRevocation(record.pair.pairId, id);
    const { fence } = queues.get(machine.machineId)!.fencePair(peer, epoch, id);
    if (fence.edgeEpoch !== epoch || fence.fenceId !== id) throw new Error("intercom-fence-mismatch");
    return { machineId: machine.machineId, peer, edgeEpoch: fence.edgeEpoch, fenceId: fence.fenceId, exchanges: "closed" as const, inFlight: 0 as const };
  });
  const pairPathLive = (peer: Peer): boolean => !peer.alias.startsWith("spider-pair-") || units.get(`${peer.machineId}/${peer.alias}-host.service`)?.state === "active";
  const transport = { async pinIntercomPeer(peer: Peer) { if (!pairPathLive(peer)) throw new Error("Pair path closed"); if (offline && peer.machineId === B) throw new Error("offline"); return { handle: peer, machineId: peer.machineId, coreId: peer.machineId === A ? "core-a" : peer.machineId === B ? "core-b" : "core-c" }; }, transport: {
    async exec(peer: Peer, argv: readonly string[], options: { stdin: Buffer }) {
      if (offline && peer.machineId === B) throw new Error("offline"); if (!pairPathLive(peer)) throw new Error("Pair path closed");
      const input = JSON.parse(options.stdin.toString()), ports = locals.get(peer.machineId)!;
      let kind = "intercom-setup", value: unknown;
      if (["observe-fence", "setup-local", "cleanup-local"].includes(argv[2])) {
        let output = "";
        const code = await main(["--global-root", peer.globalRoot, "roam", "intercom", argv[2]], { out: text => { output += text; }, err: () => {} }, { stdin: options.stdin, pairPorts: ports,
          fencePort: async (_root, value) => { const query = parseHelperFence(value), fence = queues.get(peer.machineId)!.pairFence(query.peer);
            return { machineId: peer.machineId, peer: query.peer, fence: fence ? { edgeEpoch: fence.edgeEpoch, fenceId: fence.fenceId } : null }; } });
        if (code !== 0) throw new Error("private fixture call failed"); if (!pairPathLive(peer)) throw new Error("Foreground exec lost its pair path");
        return Buffer.from(output);
      }
      else if (argv[2] === "revoke-local") { kind = "intercom-revoke"; value = await fencePeer(peer, input.peer, input.edgeEpoch, input.fenceId); }
      else throw new Error("Unexpected fake transport command");
      return Buffer.from(JSON.stringify({ version: 1, kind, ok: true, machineId: peer.machineId, value }));
    } } };
  const enrollment = createProductionIntercomEnrollmentPorts({ root, journal, request, transport: transport as never, actor: "fixture", now: () => 1000, present: async () => {}, approve: async () => true, notify: async () => {}, warn: async () => {} });
  const revokePorts = createProductionIntercomRevocationPorts({ root: source.globalRoot, localMachineId: A, transport: transport as never, localCore: async () => "core-a", fenceLocal: async input => {
    calls.push("fence-local"); return fencePeer(source, B, input.edgeEpoch, input.fenceId);
  }, cleanupLocal: input => runLocalPairCleanup(input, locals.get(A)!), notify: async () => {} });
  return { root, source, target, otherSource, journal, calls, locals, queues, units, enrollment, request, revokePorts, publicKey, transport: transport as unknown as ProvisionTransport, connected: () => connection, connect: () => { connection = true; }, straggler: (value: boolean) => { straggler = value; }, offline: (value: boolean) => { offline = value; }, listingError: (value: boolean) => { listError = value; }, mismatch: () => { mismatch = true; }, terminals: (value: PairTerminalRow[]) => { terminals = value; }, machines: () => routes.get(A)!, otherMachines: () => routes.get(otherSource.machineId)! };
}

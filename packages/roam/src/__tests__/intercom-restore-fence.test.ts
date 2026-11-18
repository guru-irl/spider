import { paths } from "@spider/db-core";
import { afterEach, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Peer, Transport } from "../contracts";
import type { IntercomEnrollmentPair, IntercomRevocationPorts } from "../provision-contracts";
import { createIntercomBridge, type IntercomBridge } from "../intercom-bridge";
import { provisionIntercomEnrollment, revokeIntercomPair } from "../intercom-enrollment";
import { runLocalPairOperation, type LocalPairOperation } from "../intercom-local-ops";
import { encodePairCommand, pairKeyAbsent, removePairKey } from "../intercom-pair-files";
import { createProductionIntercomEnrollmentPorts } from "../intercom-production";
import { createIntercomRegistry } from "../intercom-registry";
import { openIntercomStore } from "../intercom-store";
import { openJournal } from "../journal";
import { withHopExchange } from "./intercom-hop-fixture";
import { legacyPairCommand } from "./intercom-command-fixture";

const HUB = "00000000-0000-4000-8000-000000000001";
const A = "00000000-0000-4000-8000-000000000002", B = "00000000-0000-4000-8000-000000000003";
const roots: string[] = [], bridges: IntercomBridge[] = [], stores: ReturnType<typeof openIntercomStore>[] = [];
afterEach(async () => {
  for (const bridge of bridges.splice(0)) await bridge.stop();
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});
const clock = { now: () => Date.now(), later(ms: number, fn: () => void) { const timer = setTimeout(fn, ms); return () => clearTimeout(timer); } };
const unavailable = async (): Promise<never> => { throw new Error("unexpected transport call"); };
const noTransport: Transport = { resolve: unavailable, bootstrapProbe: unavailable, exec: unavailable, run: unavailable, read: unavailable, write: unavailable };

async function fixture() {
  const root = mkdtempSync(join(paths.scratch("worktree", process.cwd()), "restore-fence-")); roots.push(root);
  const peer = (machineId: string, alias: string): Peer => ({ machineId, alias, node: process.execPath, pi: "/fixture/pi", cli: "/fixture/cli", core: "/fixture/hc", globalRoot: join(root, alias) });
  const source = peer(A, "box-1.invalid"), target = peer(B, "box-2.invalid");
  const request = { operation: { id: "approval-1", machineId: HUB, kind: "intercom-enrollment", expectedEpoch: null, args: {} },
    pairs: [{ pairId: "pair-1", source, target, edgeEpoch: "edge-1", connector: { tunnelId: "tunnel-1", remotePort: 2222, session: "default" } }] };
  const keyBytes = Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from("ssh-ed25519"), Buffer.from([0, 0, 0, 32]), Buffer.alloc(32, 7)]);
  const hostKey = { type: "ssh-ed25519", base64: keyBytes.toString("base64") }, publicKey = `ssh-ed25519 ${hostKey.base64}`;
  const registry = createIntercomRegistry(root), journal = openJournal(join(root, "journal.db"));
  const endpoints = new Map<string, { machine: Peer; home: string; registry: ReturnType<typeof createIntercomRegistry>; store: ReturnType<typeof openIntercomStore>; bridge: IntercomBridge }>();
  for (const [machine, remote] of [[source, target], [target, source]]) {
    const home = join(machine.globalRoot, "home"); mkdirSync(home, { recursive: true, mode: 0o700 });
    const store = openIntercomStore({ file: join(machine.globalRoot, "roam", "intercom", "queue.db"), machineId: machine.machineId, clock }); stores.push(store);
    const bridge = createIntercomBridge({ machineId: machine.machineId, machineAlias: machine.alias,
      edges: [{ peer: remote, edgeEpoch: "edge-1", initiator: false }], store, clock, transport: noTransport,
      localPresence: () => [], authoritativeHome: () => null });
    bridges.push(bridge); await bridge.start();
    endpoints.set(machine.machineId, { machine, home, registry: createIntercomRegistry(machine.globalRoot), store, bridge });
  }
  let generation = 0;
  const exchange = (machine: Peer, epoch: string) => {
    const remote = machine.machineId === A ? target : source;
    return endpoints.get(machine.machineId)!.bridge.exchange({ version: 1, holdMs: 0, deadlineMs: 5000,
      exchange: withHopExchange({ protocol: 5, senderMachine: remote.machineId, recipientMachine: machine.machineId,
        generation: { edgeEpoch: epoch, channel: "push", generation: ++generation }, frames: [], acknowledgements: [], receipts: [], controls: [], presence: [] }) });
  };
  const command = (pair: IntercomEnrollmentPair, text = "printf transport-ok", scriptEpoch = pair.edgeEpoch) => spawnSync(process.execPath,
    [join(pair.target.globalRoot, "roam", "intercom", "pairs", pair.pairId, scriptEpoch, "command.mjs")],
    { env: { ...process.env, SSH_ORIGINAL_COMMAND: encodePairCommand(pair, text) }, encoding: "utf8", timeout: 2000 });
  const fencedFederation: string[] = [], probeStatuses: Array<number | null> = [], unapprovedStatuses: Array<number | null> = [];
  let transportFailure = false, loseApprovalReply = false, legacyCommand = false;
  const transport = {
    async pinIntercomPeer(machine: Peer) { return { handle: machine, machineId: machine.machineId, coreId: `core-${machine.machineId}` }; },
    transport: { async exec(machine: Peer, argv: readonly string[], options: { stdin: Buffer }) {
      const input = JSON.parse(options.stdin.toString()), endpoint = endpoints.get(machine.machineId)!;
      if (argv[2] === "observe-fence") return Buffer.from(JSON.stringify({ version: 1, kind: "intercom-fence", ok: true,
        value: { machineId: machine.machineId, peer: input.peer, fence: endpoint.store.pairFence(input.peer), revocationPending: await endpoint.registry.revocationPending(input.pairId) } }));
      let value: unknown;
      if (["check-connector", "host-connector", "connect-connector"].includes(input.action)) value = { status: "ready" };
      else if (input.action === "inspect-ssh") value = { targetMachineId: B, sshUser: "fixture", hostKeys: [hostKey] };
      else if (input.action === "ensure-key") value = { publicKey, privateMode: 0o600, privateOwned: true };
      else if (["write-route", "add-machine", "publish-config"].includes(input.action)) value = {};
      else if (input.action === "verify-transport") {
        const result = command(input.pair); probeStatuses.push(result.status);
        if (result.status !== 0 || result.stdout !== "transport-ok") throw new Error("intercom-verification-pending");
        if (endpoint.store.pairFence(B)) {
          try { await exchange(target, input.pair.edgeEpoch); fencedFederation.push("accepted"); }
          catch (error) { fencedFederation.push((error as Error).message); }
        }
        value = { sourceMachineId: A, targetMachineId: B, connector: true, key: true, route: !transportFailure };
      } else if (input.action === "enroll-live") {
        const remote = machine.machineId === A ? input.pair.target : input.pair.source;
        await endpoint.bridge.enrollPair({ peer: remote, edgeEpoch: input.pair.edgeEpoch, initiator: false },
          { operationId: input.approval.operationId, graphDigest: input.approval.graphDigest, expectedFenceId: input.expectedFenceId, edgeEpoch: input.pair.edgeEpoch });
        value = {};
      } else if (input.action === "verify-federation") {
        const result = command(input.pair, "printf federation-ok");
        if (result.status !== 0 || result.stdout !== "federation-ok") throw new Error("intercom-verification-pending");
        await exchange(machine, input.pair.edgeEpoch); value = { federation: true };
      } else {
        if (legacyCommand && input.action === "authorize") {
          const directory = join(input.pair.target.globalRoot, "roam", "intercom", "pairs", input.pair.pairId, input.pair.edgeEpoch);
          mkdirSync(directory, { recursive: true, mode: 0o700 });
          writeFileSync(join(directory, "command.mjs"), legacyPairCommand(input.pair), { mode: 0o600 }); legacyCommand = false;
        }
        value = await runLocalPairOperation(input as LocalPairOperation, { machineId: machine.machineId, root: machine.globalRoot, home: endpoint.home,
          node: process.execPath, ssh: "/fixture/ssh", keygen: "/fixture/keygen", run: unavailable,
          inspectBridge: async () => ({ machineId: machine.machineId, peer: machine.machineId === A ? B : A,
            edgeEpoch: input.pair.edgeEpoch, status: endpoint.store.edgeState(machine.machineId === A ? B : A, input.pair.edgeEpoch).status, reason: null }) });
        if (input.action === "authorize" && endpoint.store.pairFence(A)) unapprovedStatuses.push(command(input.pair).status);
        if (loseApprovalReply && machine.machineId === B && input.action === "approve-commands") {
          loseApprovalReply = false; throw new Error("lost approval reply");
        }
      }
      return Buffer.from(JSON.stringify({ version: 1, kind: "intercom-setup", ok: true, machineId: machine.machineId, value }));
    } },
  };
  const enroll = () => provisionIntercomEnrollment(request, createProductionIntercomEnrollmentPorts({ root, journal, transport: transport as never, request,
    actor: "fixture", now: () => 1000, async present() {}, async approve() { return true; }, async notify() {}, async warn() {} }));
  const revokePorts: IntercomRevocationPorts = {
    async withLock(work) { return work(); },
    async getPair(pairId) {
      const record = await registry.get(pairId);
      return record && "sshUser" in record.pair && record.state !== "cancelled" ? { ...record, pair: record.pair, state: record.state } : null;
    },
    async fenceAndClose(pair) {
      const proof = await endpoints.get(A)!.bridge.revokePair(B, pair.edgeEpoch);
      return { ...proof, sourceMachineId: A, targetMachineId: B, localMachineId: A, fenceDurable: true };
    },
    async beginRevocation(pair, fenceId) {
      await registry.beginRevocation(pair.pairId, fenceId);
      await endpoints.get(A)!.registry.beginRevocation(pair.pairId, fenceId);
    },
    async fenceRemote(pair, _pins, fenceId) {
      const proof = await endpoints.get(B)!.bridge.revokePair(A, pair.edgeEpoch, fenceId);
      await endpoints.get(B)!.registry.beginRevocation(pair.pairId, fenceId);
      return { ...proof, sourceMachineId: A, targetMachineId: B, localMachineId: B, fenceDurable: true };
    },
    async stopPairHost(pair) { return { machineId: B, unit: `spider-pair-${pair.pairId}-host.service`, activeState: "inactive", mainPid: 123,
      mainStartIdentity: "fixture-start", mainProcess: "exited", controlGroup: "empty", killMode: "control-group" }; },
    async notify() {}, async pinMachine(machine) { return { machineId: machine.machineId, coreId: `core-${machine.machineId}` }; },
    async removeAuthorizedKey(pair) { await removePairKey(endpoints.get(B)!.home, pair, publicKey); },
    async removeMachineIfIdle() { return "removed"; },
    async verifyRevocation(pair) { return { sourceMachineId: A, targetMachineId: B, edgeEpoch: pair.edgeEpoch,
      keyAbsent: pairKeyAbsent(endpoints.get(B)!.home, pair, publicKey), routeAbsent: true, exchanges: "closed", authenticatedConnections: "closed" }; },
    async finishRevocation(pair, reason) {
      for (const state of [registry, endpoints.get(A)!.registry, endpoints.get(B)!.registry]) await state.finishRevocation(pair.pairId, reason);
    },
  };
  return { request, registry, endpoints, enroll, command, exchange, fencedFederation, probeStatuses, unapprovedStatuses, revoke: () => revokeIntercomPair("pair-1", revokePorts),
    failTransport(value: boolean) { transportFailure = value; }, loseApprovalReply() { loseApprovalReply = true; },
    useLegacyCommand() { legacyCommand = true; } };
}

it("restores a revoked pair with a fresh epoch without admitting fenced federation or predecessor commands", async () => {
  const f = await fixture();
  expect(await f.enroll()).toMatchObject({ code: 0, reason: "intercom-enrolled" });
  const predecessor = (await f.registry.get("pair-1"))!.pair as IntercomEnrollmentPair;
  expect(await f.revoke()).toMatchObject({ code: 0, reason: "intercom-revoked", value: { cleanupReason: null } });
  expect(f.command(predecessor).status).toBe(126);
  await expect(f.exchange(predecessor.target, "edge-1")).rejects.toThrow("peer-revoked");
  f.request.operation.id = "approval-2"; f.request.pairs[0].edgeEpoch = "edge-2";
  const outcome = await f.enroll();
  expect({ outcome, probeStatus: f.probeStatuses.at(-1) }).toMatchObject({ outcome: { code: 0, reason: "intercom-enrolled" }, probeStatus: 0 });
  const restored = (await f.registry.get("pair-1"))!.pair as IntercomEnrollmentPair;
  expect(f.fencedFederation).toEqual(["peer-revoked"]);
  expect(f.unapprovedStatuses).toEqual([126]);
  expect(f.command(restored).stdout).toBe("transport-ok");
  expect(f.command(predecessor).status).toBe(126);
  expect(f.command(predecessor, "printf stale", "edge-2").status).toBe(126);
  await expect(f.exchange(restored.target, "edge-1")).rejects.toThrow("machine-not-enrolled");
  expect(await f.enroll()).toMatchObject({ code: 0, reason: "intercom-enrolled" });
  expect(await f.revoke()).toMatchObject({ code: 0, reason: "intercom-revoked", value: { cleanupReason: null } });
  expect(f.command(restored).status).toBe(126);
  await expect(f.exchange(restored.target, "edge-2")).rejects.toThrow("peer-revoked");
}, 10_000);

it("retains the federation fence across a lost fresh command-approval reply and a failed transport probe", async () => {
  const f = await fixture();
  expect(await f.enroll()).toMatchObject({ code: 0 });
  expect(await f.revoke()).toMatchObject({ code: 0, value: { cleanupReason: null } });
  f.request.operation.id = "approval-2"; f.request.pairs[0].edgeEpoch = "edge-2";
  f.useLegacyCommand(); f.loseApprovalReply();
  expect(await f.enroll()).toMatchObject({ code: 3 });
  f.failTransport(true);
  expect(await f.enroll()).toMatchObject({ code: 3, reason: "intercom-verification-pending" });
  const pending = (await f.registry.get("pair-1"))!.pair as IntercomEnrollmentPair;
  await expect(f.exchange(pending.target, "edge-2")).rejects.toThrow("peer-revoked");
  f.failTransport(false);
  expect(await f.enroll()).toMatchObject({ code: 0, reason: "intercom-enrolled" });
  expect(f.fencedFederation).toEqual(["peer-revoked", "peer-revoked"]);
}, 10_000);

import { createHash } from "node:crypto";
import { join, posix } from "node:path";
import { withProcessLock } from "@spider/herdr/sessions/registry";
import type { Journal, Peer } from "./contracts";
import type { IntercomEnrollmentPair, IntercomEnrollmentPlan, IntercomEnrollmentPorts, IntercomEnrollmentRequest, IntercomMachinePin, IntercomPairPins } from "./provision-contracts";
import type { ProvisionTransport } from "./transport";
import type { PairConsentProof } from "./intercom-local-ops";
import { createIntercomRegistry } from "./intercom-registry";
import { validPublicKey } from "./intercom-enrollment";
import { isMachineId } from "./machine-id";
import type { LocalPairCleanup } from "./intercom-local-ops";
import type { IntercomRevocationPorts } from "./provision-contracts";

interface EnrollmentOptions {
  root: string; journal: Journal; transport: ProvisionTransport; request: IntercomEnrollmentRequest; actor: string; now(): number;
  present: IntercomEnrollmentPorts["present"]; approve: IntercomEnrollmentPorts["approve"];
  notify: IntercomEnrollmentPorts["notify"]; warn: IntercomEnrollmentPorts["warn"];
}
type Handle = { handle: Peer; machineId: string; coreId: string };
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/** The CLI calls this only from its TTY-owned approval path. Machine operations require its journaled graph proof. */
export function createProductionIntercomEnrollmentPorts(input: EnrollmentOptions): IntercomEnrollmentPorts {
  const request = structuredClone(input.request), registry = createIntercomRegistry(input.root), handles = new Map<string, Handle>();
  const digest = createHash("sha256").update(JSON.stringify(request.pairs)).digest("hex");
  const approvals = new Map<string, { operationId: string; graphDigest: string; expectedFenceId: string | null }>();
  const pin = async (machine: Peer): Promise<IntercomMachinePin> => {
    const value = await input.transport.pinIntercomPeer(machine);
    if (value.machineId !== machine.machineId) throw new Error("machine-mismatch");
    handles.set(machine.machineId, value); return { machineId: value.machineId, coreId: value.coreId };
  };
  const send = async (machine: Peer, expected: IntercomMachinePin, command: "observe-fence" | "setup-local", body: unknown): Promise<unknown> => {
    const handle = handles.get(machine.machineId);
    if (!handle || handle.machineId !== expected.machineId || handle.coreId !== expected.coreId) throw new Error("core-changed");
    const bytes = await input.transport.transport.exec(handle.handle, ["roam", "intercom", command],
      { timeoutMs: 40_000, maxBytes: 1024 * 1024, stdin: Buffer.from(JSON.stringify(body)) });
    let reply: unknown; try { reply = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { throw new Error("intercom-verification-pending"); }
    const kind = command === "observe-fence" ? "intercom-fence" : "intercom-setup";
    if (!object(reply) || reply.version !== 1 || reply.kind !== kind || reply.ok !== true || !Object.hasOwn(reply, "value") ||
        command === "setup-local" && reply.machineId !== machine.machineId) {
      const reason = object(reply) && typeof reply.reason === "string" && /^[a-z-]{1,80}$/.test(reply.reason) ? reply.reason : "intercom-verification-pending";
      throw new Error(reason);
    }
    return reply.value;
  };
  const consent = (): PairConsentProof => {
    const row = input.journal.read(request.operation.id).find(item => item.action === "intercom-peer-consent" && item.result.approved === true && item.result.graphDigest === digest);
    if (!row || typeof row.result.actor !== "string" || !Number.isSafeInteger(row.result.at)) throw new Error("peer-consent-required");
    return { approved: true, actor: row.result.actor, at: row.result.at as number, operationId: request.operation.id, graphDigest: digest, pairs: request.pairs };
  };
  const call = async <T>(machine: Peer, expected: IntercomMachinePin, action: string, pair: IntercomEnrollmentPlan | IntercomEnrollmentPair,
    extra: Record<string, unknown> = {}): Promise<T> => await send(machine, expected, "setup-local", { action, pair, approval: consent(), ...extra }) as T;
  const machinePlan = (machine: Peer) => {
    const pair = request.pairs.find(item => item.source.machineId === machine.machineId || item.target.machineId === machine.machineId);
    if (!pair) throw new Error("machine-mismatch"); return pair;
  };
  const readFence = async (machine: Peer, other: Peer): Promise<string | null> => {
    const observed = await pin(machine), value = await send(machine, observed, "observe-fence", { version: 1, action: "inspect-fence", machineId: machine.machineId, peer: other.machineId });
    if (!object(value) || value.machineId !== machine.machineId || value.peer !== other.machineId) throw new Error("intercom-fence-unavailable");
    if (value.fence === null) return null;
    if (!object(value.fence) || !isMachineId(value.fence.fenceId)) throw new Error("intercom-fence-unavailable");
    return value.fence.fenceId;
  };
  return {
    journal: input.journal, actor: input.actor, now: input.now, present: input.present, approve: input.approve, notify: input.notify, warn: input.warn,
    withLock: work => withProcessLock(join(input.root, "roam"), "intercom-graph", work),
    async readPairFences(pairs) {
      const result: Record<string, string | null> = Object.create(null);
      for (const pair of pairs) {
        try {
          const [a, b] = await Promise.all([readFence(pair.source, pair.target), readFence(pair.target, pair.source)]), central = await registry.get(pair.pairId);
          const approvedBefore = input.journal.read(request.operation.id).some(row => row.action === "intercom-setup" && row.result.pairId === pair.pairId && row.result.stage === "fence-approved");
          if (a !== b) result[pair.pairId] = "unavailable";
          else if (a === null && central?.fenceId) result[pair.pairId] = central.state === "pending" && central.operationId === request.operation.id && approvedBefore ? central.fenceId : "unavailable";
          else if (central?.fenceId && central.fenceId !== a) result[pair.pairId] = "unavailable";
          else result[pair.pairId] = a;
        } catch { result[pair.pairId] = "unavailable"; }
      }
      return result;
    },
    async registerPair(pair) { consent(); await registry.register(pair, request.operation.id, digest); },
    pinMachine: pin,
    async checkConnector(machine, expected) {
      const result = await call<{ status: string }>(machine, expected, "check-connector", machinePlan(machine));
      if (result.status === "intercom-connector-missing" || result.status === "intercom-connector-recipe-missing") return "missing";
      if (result.status === "intercom-connector-sign-in-required") return "not-signed-in";
      if (["ready", "intercom-tunnel-unhosted", "intercom-peer-port-unreachable"].includes(result.status)) return "ready";
      return "invalid";
    },
    inspectSshHost: (pair, pins) => call(pair.target, pins.target, "inspect-ssh", pair),
    async bindPair(pair, pins) {
      await registry.bind(pair, request.operation.id);
      await call(pair.source, pins.source, "register-pair", pair); await call(pair.target, pins.target, "register-pair", pair);
    },
    async hostConnector(pair, pins) {
      const value = await call<{ status: string }>(pair.target, pins.target, "host-connector", pair);
      return value.status === "ready" ? "ready" : value.status === "connector-not-pair-scoped" ? "not-pair-scoped" : "unhosted";
    },
    async connect(pair, pins) {
      const value = await call<{ status: string }>(pair.source, pins.source, "connect-connector", pair);
      if (value.status !== "ready") return "peer-port-unreachable";
      const check = await call<{ status: string }>(pair.source, pins.source, "check-connector", pair);
      return check.status === "ready" ? "ready" : "peer-port-unreachable";
    },
    ensureKey: (pair, pins) => call(pair.source, pins.source, "ensure-key", pair),
    async writeKnownHost(pair, pins) { await call(pair.source, pins.source, "write-route", pair); },
    async authorize(pair, line, pins) {
      const prefix = 'from="127.0.0.1",restrict ', suffix = ` spider-intercom:${pair.pairId}`;
      if (!line.startsWith(prefix) || !line.endsWith(suffix)) throw new Error("unsafe-pair-key");
      const publicKey = line.slice(prefix.length, -suffix.length); if (!validPublicKey(publicKey)) throw new Error("unsafe-pair-key");
      await call(pair.target, pins.target, "authorize", pair, { publicKey });
    },
    async addMachine(pair, argv, pins) {
      const via = posix.join(pair.source.globalRoot, "roam", "intercom", "pairs", pair.pairId, pair.edgeEpoch, "via");
      const expected = ["machine", "add", "--via", via, "--name", pair.target.alias, "--session", pair.connector.session, "--json"];
      if (JSON.stringify(argv) !== JSON.stringify(expected)) throw new Error("invalid-intercom-operation");
      await call(pair.source, pins.source, "add-machine", pair, { targetCoreId: pins.target.coreId });
    },
    verifyTransport: (pair, pins) => call(pair.source, pins.source, "verify-transport", pair, { targetCoreId: pins.target.coreId }),
    async approvePair(pair, approval) {
      const proof = consent(), row = input.journal.read(request.operation.id).find(item => item.action === "intercom-peer-consent" && item.result.graphDigest === proof.graphDigest);
      if (approval.operationId !== proof.operationId || approval.graphDigest !== proof.graphDigest || !object(row?.result.fences) || row.result.fences[pair.pairId] !== approval.expectedFenceId) throw new Error("fresh-peer-consent-required");
      approvals.set(pair.pairId, approval);
    },
    async publishPair(pair, pins) {
      const approval = approvals.get(pair.pairId); if (!approval) throw new Error("peer-consent-required");
      await call(pair.source, pins.source, "publish-config", pair); await call(pair.target, pins.target, "publish-config", pair);
      await call(pair.target, pins.target, "enroll-live", pair, { expectedFenceId: approval.expectedFenceId });
      await call(pair.source, pins.source, "enroll-live", pair, { expectedFenceId: approval.expectedFenceId });
    },
    async verifyPair(pair, pins) {
      const first = await call<{ federation: boolean }>(pair.source, pins.source, "verify-federation", pair);
      const second = await call<{ federation: boolean }>(pair.target, pins.target, "verify-federation", pair);
      const federation = first.federation === true && second.federation === true;
      if (federation) {
        await call(pair.source, pins.source, "activate-pair", pair); await call(pair.target, pins.target, "activate-pair", pair);
        await registry.activate(pair.pairId, request.operation.id);
      }
      return { sourceMachineId: pair.source.machineId, targetMachineId: pair.target.machineId, connector: true, key: true, route: true, federation };
    },
  };
}

interface RevocationOptions {
  root: string; localMachineId: string; transport: ProvisionTransport;
  localCore(): Promise<string>;
  fenceLocal(value: { version: 1; action: "revoke-pair"; machineId: string; peer: string; edgeEpoch: string; fenceId?: string }):
    Promise<{ machineId: string; peer: string; edgeEpoch: string; fenceId: string; exchanges: "closed"; inFlight: 0 }>;
  cleanupLocal(value: LocalPairCleanup): Promise<unknown>;
  notify(peers: readonly Peer[]): Promise<void>;
}
/** Never delete an hc route unless shared users can be atomically proved idle. */
export function createProductionIntercomRevocationPorts(input: RevocationOptions): IntercomRevocationPorts {
  const registry = createIntercomRegistry(input.root), handles = new Map<string, Handle>();
  const remoteCall = async (machine: Peer, pin: IntercomMachinePin, command: "revoke-local" | "cleanup-local", value: unknown): Promise<unknown> => {
    const handle = handles.get(machine.machineId);
    if (!handle || handle.machineId !== pin.machineId || handle.coreId !== pin.coreId) throw new Error("core-changed");
    const bytes = await input.transport.transport.exec(handle.handle, ["roam", "intercom", command],
      { timeoutMs: 40_000, maxBytes: 64 * 1024, stdin: Buffer.from(JSON.stringify(value)) });
    const reply: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!object(reply) || reply.version !== 1 || reply.kind !== (command === "revoke-local" ? "intercom-revoke" : "intercom-cleanup") || reply.ok !== true ||
        command === "cleanup-local" && reply.machineId !== machine.machineId) throw new Error("intercom-revocation-cleanup-pending");
    return reply.value;
  };
  const cleanup = async (machine: Peer, pin: IntercomMachinePin, value: LocalPairCleanup): Promise<unknown> =>
    machine.machineId === input.localMachineId ? input.cleanupLocal(value) : remoteCall(machine, pin, "cleanup-local", value);
  return {
    withLock: work => withProcessLock(join(input.root, "roam"), "intercom-graph", work),
    async getPair(pairId) {
      const record = await registry.get(pairId);
      if (!record || !("sshUser" in record.pair)) return null;
      return { pair: record.pair, state: record.state, cleanupReason: record.cleanupReason };
    },
    async fenceAndClose(pair) {
      const source = input.localMachineId === pair.source.machineId, local = source ? pair.source : pair.target, remote = source ? pair.target : pair.source;
      if (local.machineId !== input.localMachineId || local.globalRoot !== input.root) throw new Error("machine-mismatch");
      const proof = await input.fenceLocal({ version: 1, action: "revoke-pair", machineId: local.machineId, peer: remote.machineId, edgeEpoch: pair.edgeEpoch });
      return { sourceMachineId: pair.source.machineId, targetMachineId: pair.target.machineId, localMachineId: proof.machineId,
        edgeEpoch: proof.edgeEpoch, fenceId: proof.fenceId, fenceDurable: true, exchanges: proof.exchanges, inFlight: proof.inFlight };
    },
    async beginRevocation(pair, fenceId) { await registry.beginRevocation(pair.pairId, fenceId); },
    notify: input.notify,
    async pinMachine(machine) {
      if (machine.machineId === input.localMachineId) return { machineId: machine.machineId, coreId: await input.localCore() };
      const handle = await input.transport.pinIntercomPeer(machine); handles.set(machine.machineId, handle);
      return { machineId: handle.machineId, coreId: handle.coreId };
    },
    async fenceRemote(pair, pins, fenceId) {
      const localSource = input.localMachineId === pair.source.machineId, remote = localSource ? pair.target : pair.source, pin = localSource ? pins.target : pins.source;
      const proof = await remoteCall(remote, pin, "revoke-local", { version: 1, action: "revoke-pair", machineId: remote.machineId,
        peer: input.localMachineId, edgeEpoch: pair.edgeEpoch, fenceId });
      if (!object(proof) || proof.machineId !== remote.machineId || proof.peer !== input.localMachineId || proof.edgeEpoch !== pair.edgeEpoch ||
          proof.fenceId !== fenceId || proof.exchanges !== "closed" || proof.inFlight !== 0) throw new Error("intercom-revocation-remote-fence-pending");
      await cleanup(remote, pin, { action: "mark-revoked", pairId: pair.pairId, fenceId });
      return { sourceMachineId: pair.source.machineId, targetMachineId: pair.target.machineId, localMachineId: remote.machineId,
        edgeEpoch: pair.edgeEpoch, fenceId, fenceDurable: true, exchanges: "closed", inFlight: 0 };
    },
    async removeAuthorizedKey(pair, pins) {
      const record = await registry.get(pair.pairId); if (!record?.fenceId) throw new Error("intercom-fence-mismatch");
      const key = await cleanup(pair.source, pins.source, { action: "read-public", pairId: pair.pairId, fenceId: record.fenceId });
      if (!object(key) || !validPublicKey(key.publicKey)) throw new Error("unsafe-pair-key");
      const removed = await cleanup(pair.target, pins.target, { action: "remove-authorized", pairId: pair.pairId, fenceId: record.fenceId, publicKey: key.publicKey });
      if (!object(removed) || removed.removed !== true) throw new Error("intercom-revocation-cleanup-pending");
    },
    async removeMachineIfIdle() { return "unknown"; },
    async verifyRevocation(pair) { return { sourceMachineId: pair.source.machineId, targetMachineId: pair.target.machineId, edgeEpoch: pair.edgeEpoch,
      keyAbsent: false, routeAbsent: false, exchanges: "unknown", authenticatedConnections: "unknown" }; },
    async finishRevocation(pair, reason) { await registry.finishRevocation(pair.pairId, reason); },
  };
}

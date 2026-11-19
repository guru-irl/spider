import { authorizedPairLine } from "./intercom-pair-files";
import { createHash, randomUUID } from "node:crypto";
import { join, posix } from "node:path";
import { withProcessLock } from "@spider/herdr/sessions/registry";
import type { Journal, Peer, RoamConfig } from "./contracts";
import { homedir } from "node:os";
import { createProvisionTransport } from "./transport";
import { openJournal } from "./journal";
import { runForeground, runLocalPairCleanup, type LocalPairPorts } from "./intercom-local-ops";
import { DEFAULT_SSH, DEFAULT_SSH_KEYGEN } from "./intercom-ssh-defaults";
import { requestHelperRevoke } from "./intercom-helper";
import { invokeCli } from "@spider/herdr/client/hc";
import { parseCore, selectedSocket } from "@spider/herdr/client/parse";
import type { IntercomEnrollmentPair, IntercomEnrollmentPlan, IntercomEnrollmentPorts, IntercomEnrollmentRequest, IntercomMachinePin, IntercomPairPins } from "./provision-contracts";
import type { ProvisionTransport } from "./transport";
import type { PairConsentProof } from "./intercom-local-ops";
import { createIntercomRegistry } from "./intercom-registry";
import { enrollmentCauseCode, validPublicKey, revokeIntercomPair } from "./intercom-enrollment";
import type { IntercomStore } from "./intercom-contracts";
import { pairResources, inspectPairUnit } from "./intercom-pair-resources";
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
      const error = new Error(reason);
      if (object(reply) && object(reply.cause)) Object.assign(error, { code: enrollmentCauseCode(reply.cause) });
      throw error;
    }
    return reply.value;
  };
  const consent = (): PairConsentProof => {
    const row = input.journal.read(request.operation.id).findLast(item => item.action === "intercom-peer-consent" && item.result.approved === true && item.result.graphDigest === digest);
    if (!row || typeof row.result.actor !== "string" || !Number.isSafeInteger(row.result.at)) throw new Error("peer-consent-required");
    return { approved: true, actor: row.result.actor, at: row.result.at as number, operationId: request.operation.id, graphDigest: digest, pairs: request.pairs };
  };
  const call = async <T>(machine: Peer, expected: IntercomMachinePin, action: string, pair: IntercomEnrollmentPlan | IntercomEnrollmentPair,
    extra: Record<string, unknown> = {}): Promise<T> => await send(machine, expected, "setup-local", { action, pair, approval: consent(), ...extra }) as T;
  const machinePlan = (machine: Peer) => {
    const pair = request.pairs.find(item => item.source.machineId === machine.machineId || item.target.machineId === machine.machineId);
    if (!pair) throw new Error("machine-mismatch"); return pair;
  };
  const readFence = async (machine: Peer, other: Peer, pairId: string): Promise<{ fenceId: string | null; pending: boolean }> => {
    const observed = await pin(machine), value = await send(machine, observed, "observe-fence", { version: 1, action: "inspect-fence", machineId: machine.machineId, peer: other.machineId, pairId });
    if (!object(value) || value.machineId !== machine.machineId || value.peer !== other.machineId || typeof value.revocationPending !== "boolean") throw new Error("intercom-fence-unavailable");
    if (value.fence === null) return { fenceId: null, pending: value.revocationPending };
    if (!object(value.fence) || !isMachineId(value.fence.fenceId)) throw new Error("intercom-fence-unavailable");
    return { fenceId: value.fence.fenceId, pending: value.revocationPending };
  };
  return {
    journal: input.journal, actor: input.actor, now: input.now, present: input.present, approve: input.approve, notify: input.notify, warn: input.warn,
    withLock: work => withProcessLock(join(input.root, "roam"), "intercom-graph", work),
    async readPairFences(pairs) {
      const result: Record<string, string | null> = Object.create(null);
      for (const pair of pairs) {
        if (await registry.revocationPending(pair.pairId)) throw new Error("revocation-pending");
        const observations = await Promise.allSettled([readFence(pair.source, pair.target, pair.pairId), readFence(pair.target, pair.source, pair.pairId)]);
        if (observations.some(value => value.status === "fulfilled" && value.value.pending)) throw new Error("revocation-pending");
        try {
          const first = observations[0], second = observations[1]; if (first.status !== "fulfilled" || second.status !== "fulfilled") throw new Error("intercom-fence-unavailable");
          const a = first.value.fenceId, b = second.value.fenceId, central = await registry.get(pair.pairId);
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
      await registry.bindResources(pair.pairId, request.operation.id, pairResources(pair, pins.target.coreId));
      await call(pair.source, pins.source, "register-pair", pair, { targetCoreId: pins.target.coreId }); await call(pair.target, pins.target, "register-pair", pair, { targetCoreId: pins.target.coreId });
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
    async ensureKey(pair, pins) {
      const key = await call<{ publicKey: string; privateMode: number; privateOwned: boolean }>(pair.source, pins.source, "ensure-key", pair);
      await registry.recordPublicKey(pair.pairId, key.publicKey); return key;
    },
    async writeKnownHost(pair, pins) { await call(pair.source, pins.source, "write-route", pair); },
    async authorize(pair, line, pins) {
      const publicKey = (await registry.get(pair.pairId))?.resources?.publicKey;
      if (!publicKey || !validPublicKey(publicKey) || line !== authorizedPairLine(pair, publicKey)) throw new Error("unsafe-pair-key");
      await call(pair.target, pins.target, "authorize", pair, { publicKey });
    },
    async addMachine(pair, argv, pins) {
      const via = posix.join(pair.source.globalRoot, "roam", "intercom", "pairs", pair.pairId, pair.edgeEpoch, "via");
      const expected = ["machine", "add", "--via", via, "--name", `spider-pair-${pair.pairId}`, "--session", pair.connector.session, "--json"];
      if (JSON.stringify(argv) !== JSON.stringify(expected)) throw new Error("invalid-intercom-operation");
      await call(pair.source, pins.source, "add-machine", pair, { targetCoreId: pins.target.coreId });
    },
    verifyTransport: (pair, pins) => call(pair.source, pins.source, "verify-transport", pair, { targetCoreId: pins.target.coreId }),
    async approvePair(pair, approval, pins) {
      const proof = consent(), row = input.journal.read(request.operation.id).findLast(item => item.action === "intercom-peer-consent" && item.result.graphDigest === proof.graphDigest);
      if (approval.operationId !== proof.operationId || approval.graphDigest !== proof.graphDigest || !object(row?.result.fences) || row.result.fences[pair.pairId] !== approval.expectedFenceId) throw new Error("fresh-peer-consent-required");
      await call(pair.target, pins.target, "approve-commands", pair, { expectedFenceId: approval.expectedFenceId });
      await call(pair.source, pins.source, "approve-commands", pair, { expectedFenceId: approval.expectedFenceId });
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

export async function reconcileIntercomRevocations(input: { root: string; machineId: string; store: Pick<IntercomStore, "pairFence">;
  ports(pair: IntercomEnrollmentPair): IntercomRevocationPorts; remoteFence?(pair: IntercomEnrollmentPair): Promise<Pick<import("./intercom-contracts").IntercomPairFence, "edgeEpoch" | "fenceId"> | null> }): Promise<Array<Awaited<ReturnType<typeof revokeIntercomPair>>>> {
  const registry = createIntercomRegistry(input.root), results: Array<Awaited<ReturnType<typeof revokeIntercomPair>>> = [];
  for (const record of await registry.list()) {
    const pair = record.pair;
    if (!("sshUser" in pair) || !input.remoteFence && ![pair.source.machineId, pair.target.machineId].includes(input.machineId)) continue;
    if (record.state === "revoked" && record.cleanupReason === null) continue;
    const peer = pair.source.machineId === input.machineId ? pair.target.machineId : pair.source.machineId;
    try {
      const fence = [pair.source.machineId, pair.target.machineId].includes(input.machineId) ? input.store.pairFence(peer) : await input.remoteFence?.(pair);
      if (!fence) {
        if (["revoking", "revoked"].includes(record.state) && record.fenceId && record.cleanupReason) results.push(await revokeIntercomPair(pair.pairId, input.ports(pair)));
        continue;
      }
      if (fence.edgeEpoch !== (record.revocationEpoch ?? pair.edgeEpoch) || record.fenceId && record.fenceId !== fence.fenceId) continue;
      await registry.beginRevocation(pair.pairId, fence.fenceId);
      await registry.finishRevocation(pair.pairId, "intercom-revocation-unconfirmed");
      results.push(await revokeIntercomPair(pair.pairId, input.ports(pair)));
    } catch { results.push({ code: 3, reason: "revocation-incomplete", operationId: pair.pairId, home: null, epoch: null, repairCommand: `spider roam intercom revoke ${pair.pairId}`, value: null }); }
  }
  return results;
}

export interface IntercomMaintenance {
  pairScopedHostReady(pairId: string): Promise<boolean>;
  recoverRevocations(store: Pick<IntercomStore, "pairFence">): ReturnType<typeof reconcileIntercomRevocations>;
}
export function createProductionIntercomMaintenance(input: { root: string; config: RoamConfig; binary: string; env: NodeJS.ProcessEnv;
  localPorts?: LocalPairPorts; transport?: ProvisionTransport; fenceLocal?: RevocationOptions["fenceLocal"]; localCore?: RevocationOptions["localCore"] }): IntercomMaintenance {
  const local = input.config.machineId, registry = createIntercomRegistry(input.root);
  const localPorts: LocalPairPorts = input.localPorts ?? { machineId: local, root: input.root, home: homedir(), node: process.execPath,
    ssh: DEFAULT_SSH, keygen: DEFAULT_SSH_KEYGEN, recipe: input.config.intercom.connector, run: runForeground };
  let journal: Journal | undefined;
  return {
    async pairScopedHostReady(pairId: string): Promise<boolean> {
      const record = await registry.get(pairId); if (!record || !("sshUser" in record.pair) || !["pending", "active"].includes(record.state)) return false;
      const pair = record.pair, side = local === pair.source.machineId ? "connect" : local === pair.target.machineId ? "host" : null;
      return side === null ? false : inspectPairUnit(pair, side, localPorts);
    },
    async recoverRevocations(store: Pick<IntercomStore, "pairFence">) {
      const records = await registry.list(), transports = new Map<string, ProvisionTransport>();
      const transportFor = (pair: IntercomEnrollmentPair): ProvisionTransport => {
        const existing = transports.get(pair.pairId); if (existing) return existing;
        const resources = records.find(record => record.pair.pairId === pair.pairId)?.resources;
        const effective = (peer: Peer) => local === pair.source.machineId && peer.machineId === pair.target.machineId && resources ? { ...peer, alias: resources.route.name } : peer;
        let delegate = input.transport;
        if (!delegate) {
          journal ??= openJournal(join(input.root, "roam", "journal.db"));
          delegate = createProvisionTransport({ binary: input.binary, env: input.env, enrolled: [pair.source, pair.target].filter(peer => peer.machineId !== local).map(effective) }, journal);
        }
        const result = { ...delegate, pinIntercomPeer: (peer: Peer) => delegate.pinIntercomPeer(effective(peer)) }; transports.set(pair.pairId, result); return result;
      };
      const remoteFence = input.config.role === "hub" ? async (pair: IntercomEnrollmentPair) => {
        let observed: Pick<import("./intercom-contracts").IntercomPairFence, "edgeEpoch" | "fenceId"> | null = null;
        for (const machine of [pair.target, pair.source]) try {
          const peer = machine.machineId === pair.source.machineId ? pair.target.machineId : pair.source.machineId;
          const transport = transportFor(pair), handle = await transport.pinIntercomPeer(machine);
          const bytes = await transport.transport.exec(handle.handle, ["roam", "intercom", "observe-fence"], { timeoutMs: 10_000, maxBytes: 16 * 1024,
            stdin: Buffer.from(JSON.stringify({ version: 1, action: "inspect-fence", machineId: machine.machineId, peer })) });
          const reply: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
          if (!object(reply) || reply.version !== 1 || reply.kind !== "intercom-fence" || reply.ok !== true || !object(reply.value) || reply.value.machineId !== machine.machineId || reply.value.peer !== peer) continue;
          const fence = reply.value.fence;
          if (fence === null) continue;
          if (!object(fence) || fence.edgeEpoch !== (records.find(record => record.pair.pairId === pair.pairId)?.revocationEpoch ?? pair.edgeEpoch) || !isMachineId(fence.fenceId)) continue;
          if (observed && observed.fenceId !== fence.fenceId) throw new Error("intercom-fence-mismatch");
          observed = { edgeEpoch: fence.edgeEpoch as string, fenceId: fence.fenceId };
        } catch (error) { if (error instanceof Error && error.message === "intercom-fence-mismatch") throw error; }
        return observed;
      } : undefined;
      return reconcileIntercomRevocations({ root: input.root, machineId: local, store, remoteFence, ports: pair => createProductionIntercomRevocationPorts({
        root: input.root, localMachineId: local, hub: input.config.role === "hub", transport: transportFor(pair),
        localCore: input.localCore ?? (async () => { const env = { ...input.env, HC_SOCKET: selectedSocket(input.env) };
          return parseCore(await invokeCli(input.binary, ["server", "status", "--json"], env, 64 * 1024), env).coreId; }),
        fenceLocal: input.fenceLocal ?? (value => requestHelperRevoke(input.root, value)), cleanupLocal: value => runLocalPairCleanup(value, localPorts), notify: async () => {},
      }) });
    },
  };
}

export type IntercomRevocationTransport = Pick<ProvisionTransport, "pinIntercomPeer"> & { transport: Pick<ProvisionTransport["transport"], "exec"> };
interface RevocationOptions {
  root: string; localMachineId: string; transport: IntercomRevocationTransport; hub?: boolean; fenceEpoch?: string;
  localCore(): Promise<string>;
  fenceLocal(value: { version: 1; action: "revoke-pair"; machineId: string; peer: string; edgeEpoch: string; fenceId?: string }):
    Promise<{ machineId: string; peer: string; edgeEpoch: string; fenceId: string; exchanges: "closed"; inFlight: 0 }>;
  cleanupLocal(value: LocalPairCleanup): Promise<unknown>;
  notify(peers: readonly Peer[]): Promise<void>;
}
/** Never delete an hc route unless shared users can be atomically proved idle. */
export function createProductionIntercomRevocationPorts(input: RevocationOptions): IntercomRevocationPorts {
  const registry = createIntercomRegistry(input.root), handles = new Map<string, Handle>();
  const hostClosed = new Set<string>(), keyRemoved = new Set<string>(), routeRemoved = new Set<string>(), fencedEndpoint = new Map<string, string>();
  const closureEpochs = new Map<string, string>();
  const remoteCall = async (machine: Peer, pin: IntercomMachinePin, command: "revoke-local" | "cleanup-local" | "observe-fence", value: unknown): Promise<unknown> => {
    const handle = handles.get(machine.machineId);
    if (!handle || handle.machineId !== pin.machineId || handle.coreId !== pin.coreId) throw new Error("core-changed");
    const bytes = await input.transport.transport.exec(handle.handle, ["roam", "intercom", command],
      { timeoutMs: 40_000, maxBytes: 64 * 1024, stdin: Buffer.from(JSON.stringify(value)) });
    const reply: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!object(reply) || reply.version !== 1 || reply.kind !== (command === "revoke-local" ? "intercom-revoke" : command === "observe-fence" ? "intercom-fence" : "intercom-cleanup") || reply.ok !== true ||
        command === "cleanup-local" && reply.machineId !== machine.machineId) throw new Error("intercom-revocation-cleanup-pending");
    return reply.value;
  };
  const epochFor = async (pair: IntercomEnrollmentPair) => input.fenceEpoch ?? closureEpochs.get(pair.pairId) ?? (await registry.get(pair.pairId))?.revocationEpoch ?? pair.edgeEpoch;
  const cleanup = async (machine: Peer, pin: IntercomMachinePin | null, value: LocalPairCleanup): Promise<unknown> => {
    const record = await registry.get(value.pairId);
    value = { ...value, fenceEpoch: input.fenceEpoch ?? closureEpochs.get(value.pairId) ?? record?.revocationEpoch ?? record?.pair.edgeEpoch };
    if (machine.machineId === input.localMachineId) return input.cleanupLocal(value);
    if (!pin) throw new Error("intercom-revocation-cleanup-pending");
    return remoteCall(machine, pin, "cleanup-local", value);
  };
  return {
    fenceEpoch: input.fenceEpoch,
    withLock: work => withProcessLock(join(input.root, "roam"), "intercom-graph", work),
    async getPair(pairId) {
      const record = await registry.get(pairId);
      if (!record || record.state === "cancelled" || !("sshUser" in record.pair)) return null;
      return { pair: record.pair, state: record.state, cleanupReason: record.cleanupReason, revocationEpoch: record.revocationEpoch, fenceId: record.fenceId };
    },
    async fenceAndClose(pair) {
      let epoch = await epochFor(pair);
      const inheritedEpoch = (proof: Record<string, unknown>, fenceId: string | null | undefined): string | null =>
        input.fenceEpoch === undefined && fenceId && proof.fenceId === fenceId && typeof proof.edgeEpoch === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(proof.edgeEpoch) ? proof.edgeEpoch : null;
      if (input.fenceEpoch !== undefined) {
        if (!input.hub || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(input.fenceEpoch)) throw new Error("intercom-fence-mismatch");
        const record = await registry.get(pair.pairId);
        if (!record?.fenceId) throw new Error("intercom-fence-mismatch");
        for (const machine of [pair.source, pair.target]) {
          const handle = await input.transport.pinIntercomPeer(machine); handles.set(machine.machineId, handle);
          const other = machine.machineId === pair.source.machineId ? pair.target.machineId : pair.source.machineId;
          const observed = await remoteCall(machine, handle, "observe-fence", { version: 1, action: "inspect-fence", machineId: machine.machineId, peer: other });
          if (!object(observed) || observed.machineId !== machine.machineId || observed.peer !== other || !object(observed.fence) ||
              observed.fence.edgeEpoch !== epoch || observed.fence.fenceId !== record.fenceId) throw new Error("intercom-fence-mismatch");
        }
      }
      if (![pair.source.machineId, pair.target.machineId].includes(input.localMachineId)) {
        if (!input.hub) throw new Error("machine-mismatch");
        const record = await registry.get(pair.pairId), fenceId = record?.fenceId ?? randomUUID();
        await registry.beginRevocation(pair.pairId, fenceId, epoch); await registry.finishRevocation(pair.pairId, "intercom-revocation-unconfirmed");
        for (const machine of [pair.source, pair.target]) try {
          const other = machine.machineId === pair.source.machineId ? pair.target : pair.source;
          const handle = await input.transport.pinIntercomPeer(machine); handles.set(machine.machineId, handle);
          const proof = await remoteCall(machine, handle, "revoke-local", { version: 1, action: "revoke-pair", machineId: machine.machineId, peer: other.machineId, edgeEpoch: epoch, fenceId });
          if (!object(proof) || proof.machineId !== machine.machineId || proof.peer !== other.machineId || proof.edgeEpoch !== epoch && !inheritedEpoch(proof, record?.fenceId) ||
              proof.fenceId !== fenceId || proof.exchanges !== "closed" || proof.inFlight !== 0) continue;
          epoch = inheritedEpoch(proof, record?.fenceId) ?? epoch;
          closureEpochs.set(pair.pairId, epoch);
          await registry.beginRevocation(pair.pairId, fenceId, epoch);
          await cleanup(machine, handle, { action: "mark-revoked", pairId: pair.pairId, fenceId });
          fencedEndpoint.set(pair.pairId, machine.machineId);
          return { sourceMachineId: pair.source.machineId, targetMachineId: pair.target.machineId, localMachineId: machine.machineId,
            edgeEpoch: epoch, fenceId, fenceDurable: true, exchanges: "closed", inFlight: 0 };
        } catch { /* An unavailable endpoint never counts as a closure proof. */ }
        throw new Error("intercom-revocation-unconfirmed");
      }
      const source = input.localMachineId === pair.source.machineId, local = source ? pair.source : pair.target, remote = source ? pair.target : pair.source;
      if (local.machineId !== input.localMachineId || local.globalRoot !== input.root) throw new Error("machine-mismatch");
      const record = await registry.get(pair.pairId);
      const proof = await input.fenceLocal({ version: 1, action: "revoke-pair", machineId: local.machineId, peer: remote.machineId, edgeEpoch: epoch,
        ...(record?.fenceId ? { fenceId: record.fenceId } : {}) });
      const inherited = inheritedEpoch(proof, record?.fenceId);
      if (inherited) closureEpochs.set(pair.pairId, inherited);
      return { sourceMachineId: pair.source.machineId, targetMachineId: pair.target.machineId, localMachineId: proof.machineId,
        edgeEpoch: proof.edgeEpoch, fenceId: proof.fenceId, fenceDurable: true, exchanges: proof.exchanges, inFlight: proof.inFlight };
    },
    async beginRevocation(pair, fenceId) { await registry.beginRevocation(pair.pairId, fenceId, await epochFor(pair)); },
    notify: input.notify,
    async pinMachine(machine) {
      if (machine.machineId === input.localMachineId) return { machineId: machine.machineId, coreId: await input.localCore() };
      const handle = await input.transport.pinIntercomPeer(machine); handles.set(machine.machineId, handle);
      return { machineId: handle.machineId, coreId: handle.coreId };
    },
    async fenceRemote(pair, pins, fenceId) {
      const epoch = await epochFor(pair);
      const localSource = (fencedEndpoint.get(pair.pairId) ?? input.localMachineId) === pair.source.machineId, remote = localSource ? pair.target : pair.source, pin = localSource ? pins.target : pins.source;
      if (!pin) throw new Error("intercom-revocation-remote-fence-pending");
      const proof = await remoteCall(remote, pin, "revoke-local", { version: 1, action: "revoke-pair", machineId: remote.machineId,
        peer: localSource ? pair.source.machineId : pair.target.machineId, edgeEpoch: epoch, fenceId });
      if (!object(proof) || proof.machineId !== remote.machineId || proof.peer !== (localSource ? pair.source.machineId : pair.target.machineId) || proof.edgeEpoch !== epoch ||
          proof.fenceId !== fenceId || proof.exchanges !== "closed" || proof.inFlight !== 0) throw new Error("intercom-revocation-remote-fence-pending");
      await cleanup(remote, pin, { action: "mark-revoked", pairId: pair.pairId, fenceId });
      return { sourceMachineId: pair.source.machineId, targetMachineId: pair.target.machineId, localMachineId: remote.machineId,
        edgeEpoch: epoch, fenceId, fenceDurable: true, exchanges: "closed", inFlight: 0 };
    },
    async stopPairHost(pair, pins, fenceId) {
      const record = await registry.get(pair.pairId);
      if (!record?.resources || record.resources.route.targetCoreId !== pins.target.coreId) throw new Error("intercom-revocation-unconfirmed");
      const proof = await cleanup(pair.target, pins.target, { action: "stop-host", pairId: pair.pairId, fenceId });
      if (!object(proof) || proof.machineId !== pair.target.machineId || proof.unit !== `spider-pair-${pair.pairId}-host.service` || proof.killMode !== "control-group") throw new Error("intercom-revocation-unconfirmed");
      if (["inactive", "failed"].includes(String(proof.activeState)) && proof.mainProcess === "exited" && proof.controlGroup === "empty") hostClosed.add(pair.pairId);
      return proof as unknown as import("./provision-contracts").IntercomHostStopEvidence;
    },
    async stopPairConnect(pair, pins, fenceId) {
      const proof = await cleanup(pair.source, pins.source, { action: "stop-connect", pairId: pair.pairId, fenceId });
      return object(proof) && proof.machineId === pair.source.machineId && proof.unit === `spider-pair-${pair.pairId}-connect.service` && proof.killMode === "control-group" &&
        ["inactive", "failed"].includes(String(proof.activeState)) && proof.mainProcess === "exited" && proof.controlGroup === "empty";
    },
    async removeAuthorizedKey(pair, pins) {
      const record = await registry.get(pair.pairId); if (!record?.fenceId) throw new Error("intercom-fence-mismatch");
      if (!hostClosed.has(pair.pairId)) throw new Error("intercom-revocation-unconfirmed");
      const key = record.resources?.publicKey ? { publicKey: record.resources.publicKey } : await cleanup(pair.target, pins.target, { action: "read-public", pairId: pair.pairId, fenceId: record.fenceId });
      if (!object(key) || !validPublicKey(key.publicKey)) throw new Error("unsafe-pair-key");
      const removed = await cleanup(pair.target, pins.target, { action: "remove-authorized", pairId: pair.pairId, fenceId: record.fenceId, publicKey: key.publicKey });
      if (!object(removed) || removed.removed !== true) throw new Error("intercom-revocation-cleanup-pending");
      keyRemoved.add(pair.pairId);
    },
    async removeMachineIfIdle(pair, pins) {
      const record = await registry.get(pair.pairId); if (!record?.fenceId || !hostClosed.has(pair.pairId) || !keyRemoved.has(pair.pairId)) return "unknown";
      const inventory = await cleanup(pair.target, pins.target, { action: "inspect-terminals", pairId: pair.pairId, fenceId: record.fenceId });
      if (!object(inventory) || inventory.machineId !== pair.target.machineId || inventory.targetCoreId !== pins.target.coreId || !["empty", "occupied", "unknown"].includes(String(inventory.status))) return "unknown";
      if (inventory.status === "occupied") return "shared-jobs";
      if (inventory.status !== "empty") return "unknown";
      const result = await cleanup(pair.source, pins.source, { action: "remove-route", pairId: pair.pairId, fenceId: record.fenceId, hostClosed: true, keyRemoved: true,
        terminalInventory: { machineId: pair.target.machineId, targetCoreId: pins.target.coreId, status: "empty" } });
      if (!object(result) || !["removed", "shared-jobs", "route-mismatch", "unknown"].includes(String(result.status))) return "unknown";
      if (result.status === "removed") routeRemoved.add(pair.pairId);
      return result.status as "removed" | "shared-jobs" | "route-mismatch" | "unknown";
    },
    async verifyRevocation(pair, pins) {
      const record = await registry.get(pair.pairId); if (!record?.fenceId) throw new Error("intercom-fence-mismatch");
      const observed = await cleanup(pair.target, pins.target, { action: "inspect-cleanup", pairId: pair.pairId, fenceId: record.fenceId });
      return { sourceMachineId: pair.source.machineId, targetMachineId: pair.target.machineId, edgeEpoch: pair.edgeEpoch,
        keyAbsent: object(observed) && observed.keyAbsent === true && keyRemoved.has(pair.pairId), routeAbsent: routeRemoved.has(pair.pairId),
        exchanges: hostClosed.has(pair.pairId) ? "closed" : "unknown", authenticatedConnections: object(observed) && observed.hostClosed === true ? "closed" : "unknown" };
    },
    async finishRevocation(pair, reason) {
      await registry.finishRevocation(pair.pairId, reason);
      if (reason !== null) return;
      const record = await registry.get(pair.pairId); if (!record?.fenceId) throw new Error("intercom-fence-mismatch");
      try {
        for (const machine of [pair.source, pair.target]) {
          const reply = await cleanup(machine, handles.get(machine.machineId) ?? null, { action: "finish-revocation", pairId: pair.pairId, fenceId: record.fenceId, cleanupReason: null });
          if (!object(reply) || reply.recorded !== true) throw new Error("intercom-revocation-cleanup-pending");
        }
      } catch (error) { await registry.finishRevocation(pair.pairId, "intercom-revocation-cleanup-pending"); throw error; }
    },
  };
}

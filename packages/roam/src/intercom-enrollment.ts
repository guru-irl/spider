import { createHash } from "node:crypto";
import { authorizedPairLine } from "./intercom-pair-files";
import { posix } from "node:path";
import type { Outcome, Peer } from "./contracts";
import { isMachineId } from "./machine-id";
import type { IntercomEnrollmentPair, IntercomEnrollmentPlan, IntercomEnrollmentPorts, IntercomEnrollmentPreview, IntercomEnrollmentRequest, IntercomMachinePin, IntercomRevocationCleanupReason, IntercomRevocationPorts, IntercomSshHostKey } from "./provision-contracts";

export const INTERCOM_CONSENT = "Enrolling this pair lets the initiating box execute commands as your user on its peer. A compromised initiating box can access every box reachable through enrolled pairs. This approval is separate from copying pi authentication. Pair keys verify their pair and epoch, but shared loopback SSH does not bind a key to one tunnel. Revoke with `spider roam intercom revoke <pair>` to stop the pair host and remove its key. Deleting the key alone does not close open connections.";

export interface EnrollmentResult { pairs: readonly string[]; pending?: readonly { pairId: string; reason: string; causeCode?: string }[] }

export function enrollmentCauseCode(error: unknown): string {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string" && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(error.code)
    ? error.code : "unknown";
}

function outcome(operationId: string, code: 0 | 1 | 2 | 3, reason: string, value: EnrollmentResult | null = null): Outcome<EnrollmentResult> {
  return { code, reason, operationId, home: null, epoch: null, repairCommand: null, value };
}
function identifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
}
function peerValid(peer: Peer): boolean {
  return !!peer && isMachineId(peer.machineId) && typeof peer.alias === "string" && peer.alias.length > 0 &&
    peer.alias.length <= 255 && peer.alias.trim() === peer.alias && !/[\u0000-\u001f\u007f]/.test(peer.alias) &&
    [peer.node, peer.pi, peer.cli, peer.core, peer.globalRoot].every(path => typeof path === "string" && path.length <= 4096 &&
      posix.isAbsolute(path) && posix.normalize(path) === path && !/[\u0000-\u001f\u007f]/.test(path));
}
function valid(request: IntercomEnrollmentRequest): boolean {
  const operation = request?.operation;
  if (!operation || !identifier(operation.id) || !isMachineId(operation.machineId) || operation.kind !== "intercom-enrollment" ||
      operation.expectedEpoch !== null || !operation.args || Object.keys(operation.args).length !== 0 || !Array.isArray(request.pairs) ||
      request.pairs.length === 0 || request.pairs.length > 64) return false;
  const pairs = new Set<string>(), ids = new Set<string>();
  for (const pair of request.pairs) {
    if (!pair || !identifier(pair.pairId) || !identifier(pair.edgeEpoch) || !peerValid(pair.source) || !peerValid(pair.target) ||
        pair.source.machineId >= pair.target.machineId || pair.source.machineId === operation.machineId || pair.target.machineId === operation.machineId ||
        !pair.connector || !identifier(pair.connector.tunnelId) || !identifier(pair.connector.session) || !Number.isSafeInteger(pair.connector.remotePort) ||
        pair.connector.remotePort < 1 || pair.connector.remotePort > 65535) return false;
    const edge = `${pair.source.machineId}/${pair.target.machineId}`;
    if (pairs.has(edge) || ids.has(pair.pairId)) return false;
    pairs.add(edge); ids.add(pair.pairId);
  }
  return true;
}
function preview(pairs: readonly IntercomEnrollmentPlan[]): IntercomEnrollmentPreview {
  return { consent: INTERCOM_CONSENT, pairs: pairs.map(pair => ({ pairId: pair.pairId,
    source: { machineId: pair.source.machineId, alias: pair.source.alias }, target: { machineId: pair.target.machineId, alias: pair.target.alias },
    edgeEpoch: pair.edgeEpoch, connector: { ...pair.connector } })) };
}
export function validPublicKey(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = /^ssh-ed25519 ([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match) return false;
  const bytes = Buffer.from(match[1], "base64");
  return bytes.toString("base64") === match[1] && bytes.length === 51 && bytes.readUInt32BE(0) === 11 &&
    bytes.subarray(4, 15).toString("ascii") === "ssh-ed25519" && bytes.readUInt32BE(15) === 32;
}
export function validHostKey(value: unknown): value is IntercomSshHostKey {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const key = value as Record<string, unknown>;
  if (Object.keys(key).length !== 2 || typeof key.type !== "string" || typeof key.base64 !== "string" ||
      !["ssh-ed25519", "ssh-rsa", "ecdsa-sha2-nistp256", "ecdsa-sha2-nistp384", "ecdsa-sha2-nistp521"].includes(key.type) ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(key.base64)) return false;
  const bytes = Buffer.from(key.base64, "base64");
  if (bytes.toString("base64") !== key.base64 || bytes.length < 20 || bytes.length > 8192 || bytes.length < 4) return false;
  const nameLength = bytes.readUInt32BE(0);
  if (nameLength !== Buffer.byteLength(key.type) || bytes.length < 4 + nameLength + 4 || bytes.subarray(4, 4 + nameLength).toString("ascii") !== key.type) return false;
  return key.type !== "ssh-ed25519" || bytes.length === 51 && bytes.readUInt32BE(15) === 32;
}
function sshAlias(pair: IntercomEnrollmentPlan): string {
  return `spider-${createHash("sha256").update(JSON.stringify([pair.pairId, pair.source.machineId, pair.target.machineId, pair.edgeEpoch])).digest("hex").slice(0, 32)}`;
}
function machineArgs(pair: IntercomEnrollmentPair): string[] {
  const via = posix.join(pair.source.globalRoot, "roam", "intercom", "pairs", pair.pairId, pair.edgeEpoch, "via");
  return ["machine", "add", "--via", via, "--name", `spider-pair-${pair.pairId}`, "--session", pair.connector.session, "--json"];
}

/** Authentication copying never grants execution access between machines. */
export async function provisionIntercomEnrollment(request: IntercomEnrollmentRequest, ports: IntercomEnrollmentPorts): Promise<Outcome<EnrollmentResult>> {
  const operationId = typeof request?.operation?.id === "string" ? request.operation.id : "";
  if (!valid(request)) return outcome(operationId, 1, "invalid-intercom-enrollment");
  const snapshot = structuredClone(request);
  let approved = false;
  try {
    return await ports.withLock(async () => {
      const graph = preview(snapshot.pairs);
      const digest = createHash("sha256").update(JSON.stringify(snapshot.pairs)).digest("hex");
      const previous = ports.journal.begin({ ...snapshot.operation, args: { graphDigest: digest } });
      if (previous.kind === "done") {
        const saved = previous.result;
        if (saved?.code === 0 && saved.reason === "intercom-enrolled" && saved.value && typeof saved.value === "object" && !Array.isArray(saved.value) &&
            Array.isArray(saved.value.pairs) && saved.value.pairs.every(id => typeof id === "string")) {
          return outcome(operationId, 0, "intercom-enrolled", { pairs: saved.value.pairs as string[] });
        }
        return outcome(operationId, 3, "invalid-intercom-receipt");
      }
      const consent = ports.journal.read(operationId).find(({ action, result }) => action === "intercom-peer-consent" &&
        result.approved === true && result.graphDigest === digest);
      const fences = consent ? consent.result.fences : await ports.readPairFences(snapshot.pairs);
      if (!fences || typeof fences !== "object" || Array.isArray(fences) || Object.keys(fences).length !== snapshot.pairs.length ||
          snapshot.pairs.some(pair => !Object.hasOwn(fences, pair.pairId) || !((fences as Record<string, unknown>)[pair.pairId] === null || identifier((fences as Record<string, unknown>)[pair.pairId])))) {
        return outcome(operationId, 3, "intercom-fence-unavailable");
      }
      await ports.present(graph);
      if (!consent) {
        if (!await ports.approve()) return outcome(operationId, 1, "peer-consent-required");
        const at = ports.now();
        if (!Number.isSafeInteger(at) || at < 0 || typeof ports.actor !== "string" || !ports.actor || /[\u0000-\u001f\u007f]/.test(ports.actor)) {
          return outcome(operationId, 1, "invalid-peer-consent");
        }
        ports.journal.record(operationId, "intercom-peer-consent", { approved: true, graphDigest: digest, actor: ports.actor, at,
          fences: fences as Record<string, string | null>,
          pairs: graph.pairs.map(pair => ({ ...pair, source: { ...pair.source }, target: { ...pair.target }, connector: { ...pair.connector } })) });
      }
      approved = true;
      const record = (pairId: string, stage: string) => {
        if (!ports.journal.read(operationId).some(row => row.action === "intercom-setup" && row.result.pairId === pairId && row.result.stage === stage)) {
          ports.journal.record(operationId, "intercom-setup", { pairId, stage });
        }
      };
      const machines = new Map<string, Peer>();
      for (const pair of snapshot.pairs) { machines.set(pair.source.machineId, pair.source); machines.set(pair.target.machineId, pair.target); }
      await ports.notify([...machines.values()]);
      const outage = async (machineId: string): Promise<string> => {
        const prior = ports.journal.read(operationId).filter(row => row.action === "intercom-outage" && row.result.machineId === machineId).at(-1);
        if (prior?.result.down !== true) {
          ports.journal.record(operationId, "intercom-outage", { machineId, down: true });
          await ports.warn(machineId, "link-down");
        }
        return "link-down";
      };
      const keys = new Set<string>(), completed: string[] = [], pending: Array<NonNullable<EnrollmentResult["pending"]>[number]> = [];
      const enroll = async (plan: IntercomEnrollmentPlan): Promise<string | { reason: string; causeCode: string } | null> => {
        try {
          const expectedFenceId = (fences as Record<string, string | null>)[plan.pairId];
          if (expectedFenceId === "unavailable") return "intercom-fence-unavailable";
          const currentFences = await ports.readPairFences([plan]), currentFence = currentFences[plan.pairId];
          const approvedBefore = ports.journal.read(operationId).some(row => row.action === "intercom-setup" && row.result.pairId === plan.pairId && row.result.stage === "fence-approved");
          if (currentFence !== expectedFenceId && !(currentFence === null && approvedBefore)) return "fresh-peer-consent-required";
          await ports.registerPair(plan); record(plan.pairId, "registered");
          const pins = new Map<string, IntercomMachinePin>();
          for (const machine of [plan.source, plan.target]) {
            let observed: IntercomMachinePin;
            try { observed = await ports.pinMachine(machine); } catch { return outage(machine.machineId); }
            if (!observed) return outage(machine.machineId);
            if (observed.machineId !== machine.machineId) return "machine-mismatch";
            if (typeof observed.coreId !== "string" || !observed.coreId || observed.coreId.length > 4096 || /[\u0000-\u001f\u007f]/.test(observed.coreId)) return "core-unavailable";
            const prior = ports.journal.read(operationId).find(row => row.action === "intercom-core" && row.result.machineId === machine.machineId);
            if (prior && prior.result.coreId !== observed.coreId) return "core-changed";
            if (!prior) ports.journal.record(operationId, "intercom-core", { machineId: machine.machineId, coreId: observed.coreId });
            pins.set(machine.machineId, { ...observed });
          }
          for (const machine of [plan.source, plan.target]) {
            const status = await ports.checkConnector(machine, pins.get(machine.machineId)!);
            if (status === "offline") return outage(machine.machineId);
            if (status === "missing") return "intercom-connector-missing";
            if (status === "not-signed-in") return "intercom-connector-sign-in-required";
            if (status !== "ready") return "intercom-connector-check-invalid";
          }
          const pairPins = { source: pins.get(plan.source.machineId)!, target: pins.get(plan.target.machineId)! };
          const ssh = await ports.inspectSshHost(plan, pairPins);
          if (!ssh || ssh.targetMachineId !== plan.target.machineId) return "machine-mismatch";
          if (typeof ssh.sshUser !== "string" || !/^[A-Za-z_][A-Za-z0-9._-]{0,62}\$?$/.test(ssh.sshUser) || !validHostKey(ssh.hostKey)) return "intercom-ssh-host-unavailable";
          const hostKeyAlias = sshAlias(plan), priorSsh = ports.journal.read(operationId).find(row => row.action === "intercom-ssh-host" && row.result.pairId === plan.pairId);
          if (priorSsh && (!validHostKey(priorSsh.result.hostKey) || priorSsh.result.hostKey.type !== ssh.hostKey.type || priorSsh.result.hostKey.base64 !== ssh.hostKey.base64)) return "host-key-changed";
          if (priorSsh && (priorSsh.result.sshUser !== ssh.sshUser || priorSsh.result.hostKeyAlias !== hostKeyAlias)) return "intercom-ssh-user-changed";
          if (!priorSsh) ports.journal.record(operationId, "intercom-ssh-host", { pairId: plan.pairId, sshUser: ssh.sshUser,
            hostKey: { type: ssh.hostKey.type, base64: ssh.hostKey.base64 }, hostKeyAlias });
          const pair: IntercomEnrollmentPair = { ...plan, sshUser: ssh.sshUser, hostKey: { ...ssh.hostKey }, hostKeyAlias };
          await ports.bindPair(pair, pairPins);
          const host = await ports.hostConnector(pair, pairPins);
          if (host === "offline") return outage(pair.target.machineId);
          if (host === "not-pair-scoped") return "connector-not-pair-scoped";
          if (host === "unhosted") return "intercom-tunnel-unhosted";
          if (host !== "ready") return "intercom-connector-check-invalid";
          const connection = await ports.connect(pair, pairPins);
          if (connection === "offline") return outage(pair.target.machineId);
          if (connection === "peer-port-unreachable") return "intercom-peer-port-unreachable";
          if (connection !== "ready") return "intercom-connector-check-invalid";
          const priorOutage = ports.journal.read(operationId).filter(row => row.action === "intercom-outage" && row.result.machineId === pair.target.machineId).at(-1);
          if (priorOutage?.result.down === true) ports.journal.record(operationId, "intercom-outage", { machineId: pair.target.machineId, down: false });
          record(pair.pairId, "connector");
          const key = await ports.ensureKey(pair, pairPins);
          if (!validPublicKey(key.publicKey) || key.privateMode !== 0o600 || key.privateOwned !== true || keys.has(key.publicKey)) return "unsafe-pair-key";
          keys.add(key.publicKey); record(pair.pairId, "key");
          await ports.writeKnownHost(pair, pairPins); record(pair.pairId, "known-host");
          await ports.authorize(pair, authorizedPairLine(pair, key.publicKey), pairPins);
          record(pair.pairId, "authorized");
          await ports.addMachine(pair, machineArgs(pair), pairPins); record(pair.pairId, "machine");
          const transport = await ports.verifyTransport(pair, pairPins);
          if (!transport || transport.sourceMachineId !== pair.source.machineId || transport.targetMachineId !== pair.target.machineId ||
              transport.connector !== true || transport.key !== true || transport.route !== true) return "intercom-verification-pending";
          await ports.approvePair(pair, { operationId, graphDigest: digest, expectedFenceId }, pairPins);
          record(pair.pairId, "fence-approved");
          await ports.publishPair(pair, pairPins); record(pair.pairId, "published");
          const checked = await ports.verifyPair(pair, pairPins);
          if (!checked || checked.sourceMachineId !== pair.source.machineId || checked.targetMachineId !== pair.target.machineId ||
              checked.connector !== true || checked.key !== true || checked.route !== true || checked.federation !== true) return "intercom-verification-pending";
          record(pair.pairId, "verified");
          return null;
        } catch (error) {
          return { reason: error instanceof Error && ["fresh-peer-consent-required", "host-key-changed", "revocation-pending"].includes(error.message) ? error.message : "intercom-enrollment-pending",
            causeCode: enrollmentCauseCode(error) };
        }
      };
      for (const pair of snapshot.pairs) {
        const failure = await enroll(pair);
        if (failure) pending.push({ pairId: pair.pairId, ...(typeof failure === "string" ? { reason: failure } : failure) }); else completed.push(pair.pairId);
      }
      if (pending.length) return outcome(operationId, 3, pending.length === 1 && completed.length === 0 ? pending[0].reason : "intercom-enrollment-pending",
        { pairs: completed, pending });
      const result = outcome(operationId, 0, "intercom-enrolled", { pairs: completed });
      ports.journal.record(operationId, "done", result as unknown as import("@spider/db-core/roam/types").JsonObject);
      return result;
    });
  } catch (error) {
    if (error instanceof Error && error.message === "revocation-pending") return outcome(operationId, 3, "revocation-pending");
    const reason = error instanceof Error && error.message === "Operation ID already has different arguments"
      ? "operation-arguments-changed" : error instanceof Error && error.message === "fresh-peer-consent-required" ? error.message
      : approved ? "intercom-enrollment-pending" : "intercom-enrollment-unavailable";
    return outcome(operationId, approved ? 3 : 1, reason);
  }
}

export interface RevocationResult { pairId: string; cleanupReason: IntercomRevocationCleanupReason | null }
function revocationOutcome(pairId: string, code: 0 | 1 | 3, reason: string, cleanupReason: IntercomRevocationCleanupReason | null = null): Outcome<RevocationResult> {
  return { code, reason, operationId: pairId, home: null, epoch: null, repairCommand: null, value: code === 0 ? { pairId, cleanupReason } : null };
}

/** A removed key alone cannot prove that a previously authenticated connection has closed. */
export async function revokeIntercomPair(pairId: string, ports: IntercomRevocationPorts): Promise<Outcome<RevocationResult>> {
  if (!identifier(pairId)) return revocationOutcome(pairId, 1, "invalid-intercom-pair");
  try {
    return await ports.withLock(async () => {
      const record = await ports.getPair(pairId);
      if (!record) return revocationOutcome(pairId, 1, "intercom-pair-not-found");
      const pair = structuredClone(record.pair), fenceEpoch = ports.fenceEpoch ?? record.revocationEpoch ?? pair.edgeEpoch;
      if (!identifier(fenceEpoch)) return revocationOutcome(pairId, 1, "invalid-intercom-fence");
      if (!pair || pair.pairId !== pairId || !identifier(pair.edgeEpoch) || !peerValid(pair.source) || !peerValid(pair.target) ||
          pair.source.machineId >= pair.target.machineId || !["pending", "active", "revoking", "revoked"].includes(record.state)) {
        return revocationOutcome(pairId, 1, "invalid-intercom-pair");
      }
      if (record.state === "revoked" && !record.cleanupReason) return revocationOutcome(pairId, 0, "intercom-revoked", null);
      const closure = await ports.fenceAndClose(pair);
      if (!closure || closure.sourceMachineId !== pair.source.machineId || closure.targetMachineId !== pair.target.machineId ||
          ![pair.source.machineId, pair.target.machineId].includes(closure.localMachineId) || closure.edgeEpoch !== fenceEpoch ||
          !identifier(closure.fenceId) || closure.fenceDurable !== true || closure.exchanges !== "closed" || closure.inFlight !== 0) return revocationOutcome(pairId, 3, "revocation-incomplete");
      await ports.beginRevocation(pair, closure.fenceId);
      await ports.notify([pair.source, pair.target]);
      const pin = async (machine: Peer) => { try { return await ports.pinMachine(machine); } catch { return null; } };
      const source = await pin(pair.source), target = await pin(pair.target);
      let cleanupReason: IntercomRevocationCleanupReason | null = null;
      if (!target) cleanupReason = "intercom-revocation-unconfirmed";
      else if (target.machineId !== pair.target.machineId || typeof target.coreId !== "string" || !target.coreId ||
          source && (source.machineId !== pair.source.machineId || typeof source.coreId !== "string" || !source.coreId)) {
        cleanupReason = "intercom-revocation-unconfirmed";
      } else {
        const pins = { source, target };
        try {
          const remote = closure.localMachineId === pair.target.machineId && !source ? null : await ports.fenceRemote(pair, pins, closure.fenceId);
          const remoteMachine = closure.localMachineId === pair.source.machineId ? pair.target.machineId : pair.source.machineId;
          if (closure.localMachineId !== pair.target.machineId && (!remote || remote.sourceMachineId !== pair.source.machineId || remote.targetMachineId !== pair.target.machineId ||
              remote.localMachineId !== remoteMachine || remote.edgeEpoch !== fenceEpoch || remote.fenceId !== closure.fenceId ||
              remote.fenceDurable !== true || remote.exchanges !== "closed" || remote.inFlight !== 0)) cleanupReason = "intercom-revocation-unconfirmed";
        } catch { if (closure.localMachineId !== pair.target.machineId) cleanupReason = "intercom-revocation-unconfirmed"; }
        if (!cleanupReason) try {
          const stopped = await ports.stopPairHost?.(pair, pins, closure.fenceId);
          if (!stopped || stopped.machineId !== pair.target.machineId || stopped.unit !== `spider-pair-${pair.pairId}-host.service` ||
              !["inactive", "failed"].includes(stopped.activeState) || !Number.isSafeInteger(stopped.mainPid) || stopped.mainPid < 1 ||
              typeof stopped.mainStartIdentity !== "string" || !stopped.mainStartIdentity || stopped.mainProcess !== "exited" || stopped.controlGroup !== "empty" || stopped.killMode !== "control-group") {
            cleanupReason = "intercom-revocation-unconfirmed";
          }
        } catch { cleanupReason = "intercom-revocation-unconfirmed"; }
        if (!cleanupReason) try { await ports.removeAuthorizedKey(pair, pins); }
        catch { cleanupReason = "intercom-revocation-unconfirmed"; }
        if (!cleanupReason) try {
          if (ports.stopPairConnect && !await ports.stopPairConnect(pair, pins, closure.fenceId)) throw new Error("intercom-revocation-cleanup-pending");
          const route = await ports.removeMachineIfIdle(pair, pins);
          if (route === "shared-jobs") cleanupReason = "intercom-revocation-cleanup-pending";
          else if (route !== "removed") cleanupReason = "intercom-revocation-cleanup-pending";
          else {
            const evidence = await ports.verifyRevocation(pair, pins);
            if (!evidence || evidence.sourceMachineId !== pair.source.machineId || evidence.targetMachineId !== pair.target.machineId ||
                evidence.edgeEpoch !== pair.edgeEpoch) {
              cleanupReason = "intercom-revocation-verification-pending";
            } else if (evidence.keyAbsent !== true) cleanupReason = "intercom-revocation-unconfirmed";
            else if (evidence.routeAbsent !== true || evidence.exchanges !== "closed") cleanupReason = "intercom-revocation-verification-pending";
            else if (evidence.authenticatedConnections !== "closed") cleanupReason = "intercom-revocation-access-open";
          }
        } catch { cleanupReason = "intercom-revocation-cleanup-pending"; }
      }
      await ports.finishRevocation(pair, cleanupReason);
      return cleanupReason === "intercom-revocation-unconfirmed" ? revocationOutcome(pairId, 3, cleanupReason) : revocationOutcome(pairId, 0, "intercom-revoked", cleanupReason);
    });
  } catch { return revocationOutcome(pairId, 3, "revocation-incomplete"); }
}

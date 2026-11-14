import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { lstatSync } from "node:fs";
import type { IntercomConnectorRecipe } from "./contracts";
import { parseConnectorRecipe } from "./config";
import type { IntercomEnrollmentPair, IntercomEnrollmentPlan, IntercomRevocationCleanupReason } from "./provision-contracts";
import { authorizePairKey, ensurePairKey, pairPaths, readPairPublicKey, removePairKey, pairKeyAbsent, writePairRoute } from "./intercom-pair-files";
import { ensurePairUnit, pairResources, pairLocalPort, stopPairUnit, removePairMachineRoute, inspectPairTerminals, pairRouteAbsent, type PairTerminalInventory, type PairResourcePorts } from "./intercom-pair-resources";
import { isMachineId } from "./machine-id";
import { inspectServedSshIdentity } from "./intercom-ssh-observation";
import { checkConnector, runConnectorStep } from "./intercom-connector";
import { createIntercomRegistry, withIntercomPeerLock } from "./intercom-registry";
import { persistIntercomPairRoute } from "./provision-config";
import { requestHelperEnroll, requestHelperFence, requestHelperInspect } from "./intercom-helper";

export interface PairConsentProof { approved: true; actor: string; at: number; operationId: string; graphDigest: string; pairs: readonly IntercomEnrollmentPlan[] }
type Common = { pair: IntercomEnrollmentPair; approval: PairConsentProof; targetCoreId?: string };
export type LocalPairOperation = Common & ({ action: "ensure-key" } | { action: "write-route" } | { action: "authorize"; publicKey: string } |
  { action: "add-machine" | "verify-transport"; targetCoreId: string } | { action: "register-pair" | "publish-config" | "verify-federation" | "activate-pair" } |
  { action: "enroll-live"; expectedFenceId: string | null }) |
  { action: "inspect-ssh" | "check-connector" | "host-connector" | "connect-connector"; pair: IntercomEnrollmentPlan; approval: PairConsentProof };
export interface LocalPairPorts extends PairResourcePorts {
  machineId: string; root: string; home: string; node: string; ssh: string; keygen: string; sshd?: string; sshUser?: string; recipe?: IntercomConnectorRecipe;
  run(argv: readonly string[], options: { timeoutMs: number; maxBytes: number }): Promise<{ code: number; stdout: string }>;
  enrollBridge?(input: unknown): Promise<unknown>;
  inspectBridge?(input: unknown): Promise<{ machineId: string; peer: string; edgeEpoch: string; status: string; reason: string | null }>;
  inspectFence?(input: unknown): Promise<{ machineId: string; peer: string; fence: { edgeEpoch: string; fenceId: string } | null }>;
}
export async function runForeground(argv: readonly string[], options: { timeoutMs: number; maxBytes: number }): Promise<{ code: number; stdout: string }> {
  if (!Array.isArray(argv) || !argv.length || !Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 ||
      !Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1) throw new Error("invalid-intercom-operation");
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], [...argv.slice(1)], { shell: false, detached: false, stdio: ["ignore", "pipe", "ignore"] });
    const chunks: Buffer[] = []; let size = 0, failure: Error | null = null, killTimer: NodeJS.Timeout | undefined;
    const terminate = (error: Error) => {
      if (failure) return; failure = error; child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 500); killTimer.unref();
    };
    const timer = setTimeout(() => terminate(new Error("intercom-command-timeout")), options.timeoutMs); timer.unref();
    child.stdout.on("data", chunk => {
      const bytes = Buffer.from(chunk); size += bytes.length;
      if (size > options.maxBytes) terminate(new Error("intercom-command-output-too-large")); else chunks.push(bytes);
    });
    child.once("error", error => { failure ??= error; });
    child.once("close", code => {
      clearTimeout(timer); if (killTimer) clearTimeout(killTimer);
      if (failure) reject(failure); else resolve({ code: code ?? 1, stdout: Buffer.concat(chunks).toString("utf8") });
    });
  });
}
export type LocalPairCleanup = ({ action: "read-public" | "mark-revoked" | "stop-host" | "stop-connect" | "inspect-cleanup" | "inspect-terminals"; pairId: string; fenceId: string } |
  { action: "remove-authorized"; pairId: string; fenceId: string; publicKey: string } |
  { action: "remove-route"; pairId: string; fenceId: string; hostClosed: true; keyRemoved: true; terminalInventory?: PairTerminalInventory } |
  { action: "finish-revocation"; pairId: string; fenceId: string; cleanupReason: IntercomRevocationCleanupReason | null }) & { fenceEpoch?: string };
/** The local queue fence is checked again for every revocation cleanup effect. */
export async function runLocalPairCleanup(input: LocalPairCleanup, ports: LocalPairPorts): Promise<unknown> {
  const record = await createIntercomRegistry(ports.root).get(input.pairId);
  if (!record || !isMachineId(ports.machineId)) throw new Error("intercom-pair-not-found");
  const local = record.pair.source.machineId === ports.machineId ? record.pair.source : record.pair.target;
  if (local.machineId !== ports.machineId || local.globalRoot !== ports.root) throw new Error("machine-mismatch");
  return withIntercomPeerLock(ports.root, record.pair.source.machineId, record.pair.target.machineId, () => localPairCleanup(input, ports));
}
async function localPairCleanup(input: LocalPairCleanup, ports: LocalPairPorts): Promise<unknown> {
  if (!input || !isMachineId(input.fenceId)) throw new Error("invalid-intercom-fence");
  const registry = createIntercomRegistry(ports.root), record = await registry.get(input.pairId);
  if (!record || !("sshUser" in record.pair) || !isMachineId(ports.machineId)) throw new Error("intercom-pair-not-found");
  const pair = record.pair, source = ports.machineId === pair.source.machineId, local = source ? pair.source : pair.target, remote = source ? pair.target : pair.source;
  if (local.machineId !== ports.machineId || local.globalRoot !== ports.root) throw new Error("machine-mismatch");
  const request = { version: 1 as const, action: "inspect-fence" as const, machineId: ports.machineId, peer: remote.machineId };
  const observed = ports.inspectFence ? await ports.inspectFence(request) : await requestHelperFence(ports.root, request);
  if (observed.machineId !== ports.machineId || observed.peer !== remote.machineId || observed.fence?.fenceId !== input.fenceId ||
      observed.fence.edgeEpoch !== (input.fenceEpoch ?? record.revocationEpoch ?? pair.edgeEpoch)) throw new Error("intercom-fence-mismatch");
  if (input.action === "mark-revoked") {
    await registry.beginRevocation(pair.pairId, input.fenceId, input.fenceEpoch);
    await registry.finishRevocation(pair.pairId, "intercom-revocation-unconfirmed");
    return { recorded: true };
  }
  if (record.fenceId !== input.fenceId || (record.revocationEpoch ?? pair.edgeEpoch) !== (input.fenceEpoch ?? record.revocationEpoch ?? pair.edgeEpoch) || !["revoking", "revoked"].includes(record.state)) throw new Error("intercom-fence-mismatch");
  if (input.action === "finish-revocation") {
    if (input.cleanupReason === null) {
      const proof = await stopPairUnit(pair, source ? "connect" : "host", input.fenceId, ports);
      if (proof.mainProcess !== "exited" || proof.controlGroup !== "empty" || !["inactive", "failed"].includes(proof.activeState) || !record.resources ||
          (source ? !await pairRouteAbsent(pair, record.resources, ports.run) : !record.resources.publicKey || !pairKeyAbsent(ports.home, pair, record.resources.publicKey))) throw new Error("intercom-revocation-cleanup-pending");
    }
    await registry.finishRevocation(pair.pairId, input.cleanupReason); return { recorded: true };
  }
  if (input.action === "read-public") return { publicKey: record.resources?.publicKey ?? (source ? readPairPublicKey(pair) : null) };
  if (input.action === "stop-host" && !source || input.action === "stop-connect" && source) return stopPairUnit(pair, source ? "connect" : "host", input.fenceId, ports);
  if (input.action === "remove-authorized" && !source) {
    const proof = await stopPairUnit(pair, "host", input.fenceId, ports);
    if (!["inactive", "failed"].includes(proof.activeState) || proof.mainProcess !== "exited" || proof.controlGroup !== "empty" || proof.killMode !== "control-group") throw new Error("intercom-revocation-unconfirmed");
    await removePairKey(ports.home, pair, input.publicKey);
    if (!pairKeyAbsent(ports.home, pair, input.publicKey)) throw new Error("intercom-revocation-cleanup-pending");
    return { removed: true };
  }
  if (input.action === "remove-route" && source && record.resources && record.unit?.closedFenceId === input.fenceId) {
    const stopped = await stopPairUnit(pair, "connect", input.fenceId, ports);
    if (stopped.mainProcess !== "exited" || stopped.controlGroup !== "empty" || !["inactive", "failed"].includes(stopped.activeState)) throw new Error("intercom-revocation-cleanup-pending");
    return { status: await removePairMachineRoute(pair, record.resources, { run: ports.run, hostClosed: input.hostClosed === true, keyRemoved: input.keyRemoved === true, terminalInventory: input.terminalInventory }) };
  }
  if (input.action === "inspect-terminals" && !source && record.resources?.publicKey) {
    const proof = await stopPairUnit(pair, "host", input.fenceId, ports);
    if (proof.mainProcess !== "exited" || proof.controlGroup !== "empty" || !["inactive", "failed"].includes(proof.activeState) || !pairKeyAbsent(ports.home, pair, record.resources.publicKey)) throw new Error("intercom-revocation-unconfirmed");
    return { machineId: ports.machineId, targetCoreId: record.resources.route.targetCoreId, status: await inspectPairTerminals(pair.target.core, ports.run) };
  }
  if (input.action === "inspect-cleanup" && !source && record.resources?.publicKey) {
    const proof = await stopPairUnit(pair, "host", input.fenceId, ports);
    return { keyAbsent: pairKeyAbsent(ports.home, pair, record.resources.publicKey), hostClosed: proof.mainProcess === "exited" && proof.controlGroup === "empty" && ["inactive", "failed"].includes(proof.activeState) };
  }
  throw new Error("invalid-intercom-operation");
}
function samePlan(pair: IntercomEnrollmentPlan, candidate: IntercomEnrollmentPlan): boolean {
  const samePeer = (a: IntercomEnrollmentPlan["source"], b: IntercomEnrollmentPlan["source"]) => !!a && !!b && a.machineId === b.machineId &&
    a.alias === b.alias && a.node === b.node && a.pi === b.pi && a.cli === b.cli && a.core === b.core && a.globalRoot === b.globalRoot;
  return !!pair && !!candidate && pair.pairId === candidate.pairId && pair.edgeEpoch === candidate.edgeEpoch && samePeer(pair.source, candidate.source) &&
    samePeer(pair.target, candidate.target) && !!pair.connector && !!candidate.connector && pair.connector.tunnelId === candidate.connector.tunnelId &&
    pair.connector.remotePort === candidate.connector.remotePort && pair.connector.session === candidate.connector.session;
}
export function hasPairConsent(pair: IntercomEnrollmentPlan, proof: PairConsentProof): boolean {
  if (!proof || proof.approved !== true || typeof proof.actor !== "string" || !proof.actor || proof.actor.length > 128 || /[\u0000-\u001f\u007f]/.test(proof.actor) ||
      !Number.isSafeInteger(proof.at) || proof.at < 0 || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(proof.operationId) ||
      !/^[0-9a-f]{64}$/.test(proof.graphDigest) || !Array.isArray(proof.pairs) || proof.pairs.length < 1 || proof.pairs.length > 64) return false;
  const encoded = JSON.stringify(proof.pairs);
  return Buffer.byteLength(encoded) <= 1024 * 1024 && createHash("sha256").update(encoded).digest("hex") === proof.graphDigest &&
    proof.pairs.filter(candidate => samePlan(pair, candidate)).length === 1;
}
/** Caller must verify the proof against the human-consent journal before invoking this local adapter. */
export async function runLocalPairOperation(input: LocalPairOperation, ports: LocalPairPorts): Promise<unknown> {
  if (!input?.pair || !hasPairConsent(input.pair, input.approval)) throw new Error("peer-consent-required");
  const local = input.pair.source.machineId === ports.machineId ? input.pair.source : input.pair.target;
  if (local.machineId !== ports.machineId || local.globalRoot !== ports.root) throw new Error("machine-mismatch");
  const other = input.pair.source.machineId === ports.machineId ? input.pair.target.machineId : input.pair.source.machineId;
  return withIntercomPeerLock(ports.root, input.pair.source.machineId, input.pair.target.machineId, async () => {
    const registry = createIntercomRegistry(ports.root);
    if (await registry.revocationPending(input.pair.pairId, other)) throw new Error("revocation-pending");
    if (!["register-pair", "check-connector", "inspect-ssh"].includes(input.action)) {
      const record = await registry.get(input.pair.pairId);
      if (!record || !["pending", "active"].includes(record.state) || record.operationId !== input.approval.operationId || record.graphDigest !== input.approval.graphDigest || !samePlan(record.pair, input.pair)) throw new Error("fresh-peer-consent-required");
    }
    return localPairOperation(input, ports);
  });
}
async function localPairOperation(input: LocalPairOperation, ports: LocalPairPorts): Promise<unknown> {
  if (!input || !input.pair || !hasPairConsent(input.pair, input.approval)) throw new Error("peer-consent-required");
  const source = input.action === "ensure-key" || input.action === "write-route" || input.action === "add-machine" || input.action === "verify-transport" || input.action === "connect-connector" ||
    (input.action === "check-connector" || input.action === "register-pair" || input.action === "publish-config" || input.action === "enroll-live" ||
      input.action === "verify-federation" || input.action === "activate-pair") && ports.machineId === input.pair.source.machineId;
  const expected = source ? input.pair.source : input.pair.target;
  if (!expected || !isMachineId(ports.machineId) || expected.machineId !== ports.machineId || expected.globalRoot !== ports.root) throw new Error("machine-mismatch");
  if (input.action === "verify-federation" || input.action === "activate-pair") {
    const peer = source ? input.pair.target.machineId : input.pair.source.machineId;
    const request = { version: 1 as const, action: "inspect-pair" as const, machineId: ports.machineId, peer, edgeEpoch: input.pair.edgeEpoch };
    const current = ports.inspectBridge ? await ports.inspectBridge(request) : await requestHelperInspect(ports.root, request);
    if (current.machineId !== ports.machineId || current.peer !== peer || current.edgeEpoch !== input.pair.edgeEpoch) throw new Error("intercom-verification-pending");
    const federation = current.status === "live";
    if (input.action === "verify-federation") return { sourceMachineId: input.pair.source.machineId, targetMachineId: input.pair.target.machineId, federation };
    if (!federation) throw new Error("intercom-verification-pending");
    await createIntercomRegistry(ports.root).activate(input.pair.pairId, input.approval.operationId);
    return { active: true };
  }
  if (input.action === "enroll-live") {
    const peer = source ? input.pair.target.machineId : input.pair.source.machineId;
    const request = { version: 1 as const, action: "enroll-pair" as const, machineId: ports.machineId, peer, pairId: input.pair.pairId,
      edgeEpoch: input.pair.edgeEpoch, operationId: input.approval.operationId, graphDigest: input.approval.graphDigest, expectedFenceId: input.expectedFenceId };
    return ports.enrollBridge ? ports.enrollBridge(request) : requestHelperEnroll(ports.root, request);
  }
  if (input.action === "publish-config") {
    await persistIntercomPairRoute(ports.root, input.pair, input.approval.operationId, input.approval.graphDigest);
    return { published: true };
  }
  if (input.action === "register-pair") {
    const registry = createIntercomRegistry(ports.root);
    await registry.register(input.pair, input.approval.operationId, input.approval.graphDigest);
    await registry.bind(input.pair, input.approval.operationId);
    if (input.targetCoreId) await registry.bindResources(input.pair.pairId, input.approval.operationId, pairResources(input.pair, input.targetCoreId));
    return { registered: true };
  }
  if (input.action === "check-connector") return checkConnector(ports.recipe, { run: ports.run, consent: true });
  if (input.action === "host-connector" || input.action === "connect-connector") {
    const record = await createIntercomRegistry(ports.root).get(input.pair.pairId);
    if (!record || !("sshUser" in record.pair)) return runConnectorStep(ports.recipe, input.action === "host-connector" ? "host" : "connect", { run: ports.run, consent: true });
    return ensurePairUnit(record.pair, input.action === "host-connector" ? "host" : "connect", ports);
  }
  if (input.action === "inspect-ssh") {
    if (!ports.sshd || !ports.sshUser) throw new Error("intercom-ssh-host-unavailable");
    return inspectServedSshIdentity({ machineId: ports.machineId, sshUser: ports.sshUser, sshd: ports.sshd, run: ports.run });
  }
  if (input.action === "ensure-key") {
    const key = await ensurePairKey(input.pair, { binary: ports.keygen,
      run(binary, argv) { return ports.run([binary, ...argv], { timeoutMs: 30_000, maxBytes: 16 * 1024 }); } });
    await createIntercomRegistry(ports.root).recordPublicKey(input.pair.pairId, key.publicKey); return key;
  }
  if (input.action === "write-route") {
    if (!ports.recipe) throw new Error("intercom-connector-recipe-missing");
    const recipe = parseConnectorRecipe(ports.recipe);
    return writePairRoute(input.pair, { node: ports.node, ssh: ports.ssh, localPort: pairLocalPort(recipe, input.pair.pairId) });
  }
  if (input.action === "authorize") {
    await createIntercomRegistry(ports.root).recordPublicKey(input.pair.pairId, input.publicKey);
    await authorizePairKey(ports.home, input.pair, input.publicKey); return { authorized: true };
  }
  if (input.action === "add-machine" || input.action === "verify-transport") {
    if (typeof input.targetCoreId !== "string" || !input.targetCoreId || input.targetCoreId.length > 4096 || /[\u0000-\u001f\u007f]/.test(input.targetCoreId)) throw new Error("core-unavailable");
    const files = pairPaths(input.pair), uid = process.getuid?.();
    for (const [file, mode] of [[files.privateKey, 0o600], [files.knownHosts, 0o600], [files.via, 0o700]] as const) {
      const stat = lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || uid !== undefined && stat.uid !== uid ||
          process.platform !== "win32" && (stat.mode & 0o7777) !== mode) throw new Error("intercom-unsafe-file");
    }
    const registryRecord = await createIntercomRegistry(ports.root).get(input.pair.pairId);
    const routeName = registryRecord?.resources?.route.name ?? `spider-pair-${input.pair.pairId}`;
    const inspect = async () => {
      const result = await ports.run([input.pair.source.core, "machine", "ls", "--json"], { timeoutMs: 30_000, maxBytes: 64 * 1024 });
      if (result.code !== 0 || Buffer.byteLength(result.stdout) > 64 * 1024) throw new Error("intercom-route-unavailable");
      let value: unknown; try { value = JSON.parse(result.stdout); } catch { throw new Error("intercom-route-unavailable"); }
      if (!value || typeof value !== "object" || Array.isArray(value) || !Array.isArray((value as { machines?: unknown }).machines)) throw new Error("intercom-route-unavailable");
      const name = routeName.toLowerCase().replace(/\.$/, "");
      const matches = (value as { machines: unknown[] }).machines.filter(item => item && typeof item === "object" && !Array.isArray(item) &&
        typeof (item as { name?: unknown }).name === "string" && (item as { name: string }).name.toLowerCase().replace(/\.$/, "") === name) as Array<Record<string, unknown>>;
      if (matches.length > 1 || matches.length === 1 && (matches[0].name !== routeName || matches[0].id !== input.targetCoreId ||
          matches[0].via !== true || matches[0].target !== files.via || matches[0].session !== input.pair.connector.session || matches[0].temporary !== false)) throw new Error("intercom-alias-conflict");
      return matches.length === 1;
    };
    const existing = await inspect();
    if (input.action === "verify-transport") {
      if (!existing) throw new Error("intercom-route-unavailable");
      const target = input.pair.target;
      const result = await ports.run([input.pair.source.core, "exec", "--on", routeName, "--timeout", "10", "--", target.node, target.cli,
        "--global-root", target.globalRoot, "roam", "observe", "doctor"], { timeoutMs: 20_000, maxBytes: 64 * 1024 });
      let observed: unknown;
      try { observed = JSON.parse(result.stdout); } catch { throw new Error("intercom-verification-pending"); }
      if (result.code !== 0 || !observed || typeof observed !== "object" || Array.isArray(observed) ||
          (observed as { version?: unknown }).version !== 1 || (observed as { kind?: unknown }).kind !== "doctor" ||
          (observed as { machineId?: unknown }).machineId !== target.machineId || !await inspect()) throw new Error("intercom-verification-pending");
      return { sourceMachineId: input.pair.source.machineId, targetMachineId: target.machineId, connector: true, key: true, route: true };
    }
    if (existing) return { added: false };
    const result = await ports.run([input.pair.source.core, "machine", "add", "--via", files.via, "--name", routeName,
      "--session", input.pair.connector.session, "--json"], { timeoutMs: 30_000, maxBytes: 64 * 1024 });
    if (result.code !== 0 || !await inspect()) throw new Error("intercom-route-unavailable");
    return { added: true };
  }
  throw new Error("invalid-intercom-operation");
}

import { createHash } from "node:crypto";
import { basename, dirname, posix } from "node:path";
import type { JsonObject } from "@spider/db-core/roam/types";
import type { Outcome, Peer } from "./contracts";
import type { AgentDirectoryProbe, ProvisionPorts, ProvisionRequest } from "./provision-contracts";
import { AuthError, copyPiAuth, hasProvisionConsent, previewPiAuthBytes } from "./auth";
import { inventory } from "./inventory";
import { isMachineId } from "./machine-id";
import { doctorPeer } from "./resource-doctor";
import { describeSelectedFiles, prepareSelectedFiles, readPrivateBytes, SelectedFilesError } from "./selected-files";
import { renderSupervisorUnit } from "./systemd";

const unitName = "spider-roam-supervisor.service";
function result(operationId: string, code: 0 | 1 | 2 | 3, reason: string, value: { hostingReady: boolean } | null): Outcome<{ hostingReady: boolean }> {
  return { code, reason, operationId, home: null, epoch: null, repairCommand: null, value };
}
function inside(home: string, path: string): boolean {
  return typeof path === "string" && path.length <= 4096 && posix.isAbsolute(path) && posix.normalize(path) === path &&
    !/[\u0000-\u001f\u007f]/.test(path) && (path === home || path.startsWith(`${home}/`));
}
function validProviders(value: readonly string[]): boolean {
  return Array.isArray(value) && value.length <= 64 && value.every(name => typeof name === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(name)) &&
    new Set(value).size === value.length;
}
function validate(input: ProvisionRequest, ports: ProvisionPorts): void {
  const peer = input?.peer, op = input?.operation, destination = ports?.destination;
  if (!peer || !op || !destination || !isMachineId(ports.hubMachineId) || !isMachineId(peer.machineId) || op.machineId !== peer.machineId || op.kind !== "provision" ||
      typeof op.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(op.id) || op.expectedEpoch !== null ||
      typeof peer.alias !== "string" || !peer.alias || peer.alias.trim() !== peer.alias || /[\u0000-\u001f\u007f]/.test(peer.alias) ||
      typeof peer.node !== "string" || !posix.isAbsolute(peer.node) || /[\u0000-\u001f\u007f]/.test(peer.node) ||
      typeof input.includeAuth !== "boolean" || !validProviders(input.confirmedProviders) || !validProviders(ports.source?.piProviders) ||
      !input.includeAuth && input.confirmedProviders.length !== 0 || !Array.isArray(input.selected) ||
      input.expectedFiles !== undefined && !Array.isArray(input.expectedFiles) ||
      input.expectedAuthBytes !== undefined && (!input.includeAuth || !Number.isSafeInteger(input.expectedAuthBytes) || input.expectedAuthBytes < 1 || input.expectedAuthBytes > ports.limits.agentBytes)) throw new Error("invalid-provision-request");
  const home = destination.home;
  if (typeof home !== "string" || !posix.isAbsolute(home) || posix.normalize(home) !== home || home === "/" || home.split("/")[1] === "Users") {
    throw new Error("invalid-provision-destination");
  }
  if (destination.agentDir !== posix.join(home, ".pi/agent")) throw new Error("custom-agent-directory-unsupported");
  if (![destination.npmPrefix, destination.supervisor, peer.globalRoot, peer.pi, peer.cli, ports.systemd.unitDir].every(path => inside(home, path)) ||
      !inside(destination.npmPrefix, peer.pi) || !inside(destination.npmPrefix, peer.cli) || !inside(destination.npmPrefix, destination.supervisor) ||
      ports.systemd.unitDir !== posix.join(home, ".config/systemd/user")) {
    throw new Error("invalid-provision-destination");
  }
  if (!/^[a-f0-9]{64}$/.test(ports.release.spiderSha256) || ports.release.pi !== "1.2.0" || ports.release.intercom !== "spider-owned" ||
      ports.release.nodeRange !== "22.23.4 || 26.4.0") throw new Error("invalid-release");
}
function safeReason(error: unknown): string {
  if (error instanceof SelectedFilesError) {
    const files = error.files.filter(file => typeof file === "string" && file.length <= 4096 && !/[\u0000-\u001f\u007f]/.test(file));
    return files.length ? `${error.code} (${files.join(", ")})` : error.code;
  }
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  const allowed = new Set(["missing-prerequisite", "machine-mismatch", "unsafe-identity", "core-changed", "core-unavailable", "machine-not-found",
    "machine-ambiguous", "cli-timeout", "consent-required", "invalid-auth", "unsafe-auth", "provider-unavailable", "unsupported-credential-command",
    "auth-cleanup-pending", "auth-install-failed", "auth-preview-changed", "release-digest-mismatch", "invalid-release-path", "core-unit-required", "provider-consent-required",
    "enrollment-conflict", "unsafe-enrollment", "enrollment-identity-mismatch", "enrollment-publication-pending", "invalid-enrollment",
    "release-pending", "release-launch-failed", "release-arguments-changed", "operation-arguments-changed", "short-write-pending", "release-evidence-unavailable", "release-in-progress",
    "installer-interrupted", "release-install-failed", "command-failed", "release-hash-mismatch", "incomplete-release", "pi-version-mismatch"]);
  if (typeof code === "string" && allowed.has(code)) return code;
  const message = error instanceof Error ? error.message : "";
  if (message === "Operation ID already has different arguments") return "operation-arguments-changed";
  return ["invalid-provision-request", "invalid-provision-destination", "custom-agent-directory-unsupported", "invalid-release", "release-digest-mismatch", "invalid-release-path",
    "core-unit-required", "provider-consent-required", "selected-files-changed"].includes(message) ? message : "provision-failed";
}

/** Install selected files only after a target-bound consent record exists. */
export async function provision(input: ProvisionRequest, ports: ProvisionPorts): Promise<Outcome<{ hostingReady: boolean }>> {
  const operationId = typeof input?.operation?.id === "string" ? input.operation.id : "";
  if (!input?.peer || !isMachineId(input.peer.machineId)) return result(operationId, 1, "invalid-provision-request", null);
  try { validate(input, ports); } catch (error) { return result(operationId, 1, safeReason(error), null); }
  try { return await ports.withPeerLock(input.peer.machineId, () => provisionLocked(input, ports)); }
  catch { return result(operationId, 1, "provision-lock-unavailable", null); }
}

async function provisionLocked(input: ProvisionRequest, ports: ProvisionPorts): Promise<Outcome<{ hostingReady: boolean }>> {
  const operationId = typeof input?.operation?.id === "string" ? input.operation.id : "";
  let mutated = false;
  try {
    validate(input, ports);
    const peer = Object.freeze({ ...input.peer });
    let agentDirectory: AgentDirectoryProbe;
    try { agentDirectory = await ports.bootstrap.probeAgentDirectory(peer, ports.destination.home); }
    catch (error) {
      const reason = safeReason(error);
      return result(operationId, 3, ["core-changed", "core-unavailable", "machine-not-found", "machine-ambiguous", "cli-timeout"].includes(reason)
        ? reason : "agent-directory-unverified", null);
    }
    if (agentDirectory.status === "custom") return result(operationId, 1, "custom-agent-directory-unsupported", null);
    if (agentDirectory.status !== "default") return result(operationId, 3, "agent-directory-unverified", null);
    const selected = prepareSelectedFiles({ sourceRoot: ports.source.agentRoot, selected: input.selected, maxBytes: ports.limits.agentBytes });
    if (input.expectedFiles !== undefined && JSON.stringify(describeSelectedFiles(selected)) !== JSON.stringify(input.expectedFiles)) throw new Error("selected-files-changed");
    if (selected.credentialFiles.length && !input.includeAuth || input.includeAuth &&
        [...selected.providers, ...ports.source.piProviders].some(provider => !input.confirmedProviders.includes(provider))) {
      throw new Error("provider-consent-required");
    }
    let release: Buffer | null;
    try { release = readPrivateBytes(dirname(ports.source.releaseFile), basename(ports.source.releaseFile), ports.limits.agentBytes); }
    catch { throw new Error("invalid-release"); }
    if (!release || createHash("sha256").update(release).digest("hex") !== ports.release.spiderSha256) throw new Error("release-digest-mismatch");
    const observed = await inventory(peer, ports.transport, { timeoutMs: ports.limits.controlMs, maxBytes: ports.limits.replyBytes,
      expectedCore: agentDirectory.core, ...(ports.configuredClis ? { configuredClis: ports.configuredClis } : {}),
      ...(ports.coreUnit ? { coreUnit: ports.coreUnit } : {}) });
    if (observed.roaming.identityExists && observed.roaming.machineId !== peer.machineId) {
      throw Object.assign(new Error("Identity mismatch"), { code: "machine-mismatch" });
    }
    const coreUnit = ports.coreUnit ?? observed.core.unit;
    if (!coreUnit || observed.core.unit !== coreUnit || !observed.core.unitOwned || !observed.core.unitExists) throw new Error("core-unit-required");
    const files = [...selected.files, ...selected.credentialFiles].map(file => ({ path: file.path, mode: file.mode,
      sha256: createHash("sha256").update(file.bytes).digest("hex") })).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    const digest = createHash("sha256").update(JSON.stringify({ peer, core: agentDirectory.core, selected: [...input.selected].sort(), files,
      includeAuth: input.includeAuth, expectedAuthBytes: input.expectedAuthBytes, expectedFiles: input.expectedFiles, providers: [...input.confirmedProviders].sort(), piProviders: [...ports.source.piProviders].sort(), source: ports.source,
      destination: ports.destination, release: ports.release, limits: ports.limits, coreUnit })).digest("hex");
    const operation = { ...input.operation, args: { requestDigest: digest } };
    const prior = ports.journal.begin(operation);
    if (prior.kind === "done") {
      const saved = prior.result;
      if (!saved || saved.code !== 0 || !saved.value || typeof saved.value !== "object" || Array.isArray(saved.value) ||
          typeof saved.value.hostingReady !== "boolean") return result(operationId, 3, "invalid-journal-result", null);
      return result(operationId, 0, typeof saved.reason === "string" ? saved.reason : "installed", { hostingReady: saved.value.hostingReady });
    }
    await ports.present({ target: peer.alias, machineId: peer.machineId, inventory: observed,
      destinations: { ...ports.destination, globalRoot: peer.globalRoot, pi: peer.pi },
      selectedFiles: [...selected.files, ...selected.credentialFiles].map(file => file.path).sort(),
      providers: [...input.confirmedProviders], warnings: ["Hand-edited selected files may need re-editing after provisioning."] });
    const alreadyConsented = ports.journal.read(operationId).some(({ action, result: receipt }) => action === "provision-consent" &&
      receipt.approved === true && receipt.target === peer.alias && receipt.machineId === peer.machineId && receipt.requestDigest === digest &&
      Array.isArray(receipt.providers) && input.confirmedProviders.every(provider => (receipt.providers as unknown[]).includes(provider)));
    if (!alreadyConsented) {
      if (!await ports.confirm(peer.alias, [...input.confirmedProviders])) return result(operationId, 1, "consent-refused", null);
      ports.journal.record(operationId, "provision-consent", { approved: true, target: peer.alias, machineId: peer.machineId,
        providers: [...input.confirmedProviders], requestDigest: digest });
    }
    if (input.expectedAuthBytes !== undefined) {
      let auth: Buffer | null;
      try { auth = readPrivateBytes(ports.source.agentRoot, "auth.json", ports.limits.agentBytes); } catch { throw new AuthError("unsafe-auth"); }
      if (!auth) throw new AuthError("unsafe-auth");
      try { if (previewPiAuthBytes(auth, ports.source.piProviders) !== input.expectedAuthBytes) throw new AuthError("auth-preview-changed"); }
      finally { auth.fill(0); }
    }
    const identity = await ports.bootstrap.claimIdentity(peer, operationId, agentDirectory.core);
    if (identity.machineId !== peer.machineId) throw Object.assign(new Error("Identity mismatch"), { code: "machine-mismatch" });
    if (identity.coreId !== agentDirectory.core.remote) throw Object.assign(new Error("Core changed"), { code: "core-changed" });
    mutated = true;
    await ports.transfer.enroll(peer, ports.hubMachineId);
    await ports.transfer.cleanupSecrets(peer);
    const installed = await ports.transfer.installRelease(peer, { bytes: release, sha256: ports.release.spiderSha256,
      npmPrefix: ports.destination.npmPrefix, globalRoot: peer.globalRoot, pi: ports.release.pi, intercom: ports.release.intercom });
    if (installed.pi !== peer.pi || installed.cli !== peer.cli || installed.supervisor !== ports.destination.supervisor) throw new Error("invalid-release-path");
    await ports.transfer.installFiles(peer, selected.files);
    if (selected.credentialFiles.length) {
      if (!input.includeAuth || !hasProvisionConsent(ports.journal, operationId, peer, selected.providers)) throw new Error("provider-consent-required");
      await ports.transfer.installCredentialFiles(peer, selected.credentialFiles);
    }
    if (input.includeAuth && ports.source.piProviders.length) {
      await copyPiAuth({ sourceRoot: ports.source.agentRoot, peer, operationId, providers: ports.source.piProviders, journal: ports.journal,
        maxBytes: ports.limits.agentBytes, expectedBytes: input.expectedAuthBytes }, ports.transfer.auth(peer, operationId));
    }
    await ports.transfer.switchover(peer, operationId);
    await ports.persistPeer(peer);
    const unit = renderSupervisorUnit({ node: peer.node, supervisor: ports.destination.supervisor, coreUnit, globalRoot: peer.globalRoot,
      agentDir: ports.destination.agentDir, pi: peer.pi });
    await ports.systemd.writeUnit(unitName, unit);
    await ports.systemd.systemctl(["--user", "daemon-reload"]);
    await ports.systemd.systemctl(["--user", "enable", unitName]);
    const diagnostics = await doctorPeer(peer, ports);
    await ports.report(diagnostics);
    const hostingReady = diagnostics.every(item => item.severity !== "block");
    const outcome = result(operationId, 0, hostingReady ? "installed" : "installed-hosting-disabled", { hostingReady });
    ports.journal.record(operationId, "done", outcome as unknown as JsonObject);
    return outcome;
  } catch (error) {
    const reason = safeReason(error);
    return result(operationId, reason === "core-changed" || mutated && reason !== "machine-mismatch" ? 3 : 1, reason, null);
  }
}

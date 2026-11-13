import { createHash } from "node:crypto";
import { join } from "node:path";
import { HerdrError } from "@spider/herdr/client/parse";
import type { AuthPorts, AuthStage } from "./auth";
import type { Limits, Peer } from "./contracts";
import type { ProvisionDestination, ProvisionPorts, ProvisionVerification } from "./provision-contracts";
import type { SelectedFile } from "./selected-files";
import type { ProvisionTransport } from "./transport";
import type { InstalledRelease, ReleaseReason } from "./release-receipt";
import { PROVISION_REMOTE_SCRIPT } from "./provision-remote-script";

export { PROVISION_REMOTE_SCRIPT };
interface Chunk { name: string; size: number; sha256: string }
export interface AdapterOptions {
  peer: Peer; operationId: string; destination: ProvisionDestination; unitDir: string; coreUnit: string;
  limits: Limits; transport: ProvisionTransport; piProviders: readonly string[];
}
export type HcProvisionAdapter = ProvisionPorts["transfer"] & { systemd: ProvisionPorts["systemd"]; verifyPeer(): Promise<ProvisionVerification> };
const digest = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
function failure(error: unknown, action: string): HerdrError {
  const safe = new Set(["core-changed", "core-unavailable", "machine-not-found", "machine-ambiguous", "machine-mismatch", "machine-not-enrolled",
    "peer-invalidated", "unresolved-peer", "cli-timeout", "cli-aborted", "cli-exit", "stdin-error", "missing-hc", "spawn-error", "reply-too-large",
    "consent-required", "invalid-provision-request", "invalid-provision-reply", "invalid-request", "unsafe-path", "unsafe-staging", "unsafe-context",
    "invalid-chunk", "invalid-chunks", "chunk-mismatch", "too-large", "command-failed", "invalid-file", "invalid-release", "release-hash-mismatch",
    "incomplete-release", "pi-version-mismatch", "invalid-unit", "invalid-systemctl", "unsafe-release", "invalid-switchover-journal",
    "missing-switchover-backup", "selection-not-allowed", "unsafe-destination", "invalid-providers", "invalid-auth", "unsafe-auth",
    "provider-unavailable", "unsupported-credential-command", "release-arguments-changed", "invalid-release-receipt", "release-evidence-unavailable",
    "release-in-progress", "process-identity-unavailable", "release-launch-uncertain", "operation-arguments-changed", "short-write-pending"]);
  const candidate = error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : "";
  const code = safe.has(candidate) ? candidate : "provision-failed";
  return new HerdrError(code, `Provisioning ${action} failed (${code})`);
}
function samePeer(expected: Peer, actual: Peer): boolean {
  return expected.machineId === actual.machineId && expected.alias === actual.alias && expected.node === actual.node &&
    expected.pi === actual.pi && expected.cli === actual.cli && expected.core === actual.core && expected.globalRoot === actual.globalRoot;
}

/** A provisioning adapter is bound to one consented peer, operation and destination. */
export function createHcProvisionAdapter(options: AdapterOptions): HcProvisionAdapter {
  const { peer, operationId, destination, unitDir, limits, transport } = options;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(operationId) || !Number.isSafeInteger(limits.chunkBytes) ||
      limits.chunkBytes <= 0 || limits.chunkBytes > 1024 * 1024 || !Number.isSafeInteger(limits.agentBytes) ||
      limits.agentBytes <= 0 || limits.agentBytes > 256 * 1024 * 1024) throw new HerdrError("invalid-provision-options", "Invalid provisioning options");
  const stage = join(peer.globalRoot, "roam", "provision", operationId);
  let resolved: Peer | null = null;
  const installedFiles = new Map<string, 0o600 | 0o700>();
  async function handle(target: Peer): Promise<Peer> {
    if (!samePeer(peer, target)) throw new HerdrError("machine-mismatch", "Provision target changed");
    if (!resolved) resolved = await transport.transport.resolve(peer);
    return resolved;
  }
  const tag = (kind: string, key: string): string => createHash("sha256").update(JSON.stringify([operationId, kind, key])).digest("hex").slice(0, 32);
  async function action(target: Peer, action: string, value: Record<string, unknown> = {}): Promise<unknown> {
    const request = {
      action, operationId, machineId: peer.machineId, home: destination.home, globalRoot: peer.globalRoot,
      agentDir: destination.agentDir, npmPrefix: destination.npmPrefix, unitDir, core: peer.core, node: peer.node, pi: peer.pi,
      cli: peer.cli, supervisor: destination.supervisor, maximum: limits.agentBytes, chunkBytes: limits.chunkBytes,
      timeout: limits.importMs, ...value,
    };
    try {
      try { return await transport.executeProvision(await handle(target), request); }
      catch (error) {
        if (!error || typeof error !== "object" || !("code" in error) || error.code !== "cli-timeout") throw error;
        resolved = null;
        return await transport.executeProvision(await handle(target), request);
      }
    } catch (error) { throw failure(error, action); }
  }
  async function cleanup(target: Peer, names: readonly string[]): Promise<void> {
    try { await action(target, "cleanup", { names }); }
    catch { throw new HerdrError("staging-cleanup-pending", "Private provisioning staging needs cleanup"); }
  }
  function split(bytes: Buffer, prefix: string, key: string): { chunks: Chunk[]; pieces: Buffer[] } {
    if (!Buffer.isBuffer(bytes) || bytes.length > limits.agentBytes) throw new HerdrError("too-large", "Provisioning input is too large");
    const chunks: Chunk[] = [], pieces: Buffer[] = [], nonce = tag(prefix, key);
    const count = Math.max(1, Math.ceil(bytes.length / limits.chunkBytes));
    if (count > 10_000) throw new HerdrError("too-large", "Provisioning input has too many chunks");
    for (let index = 0; index < count; index++) {
      const piece = bytes.subarray(index * limits.chunkBytes, Math.min(bytes.length, (index + 1) * limits.chunkBytes));
      pieces.push(piece); chunks.push({ name: `${prefix}-${nonce}-${index}`, size: piece.length, sha256: digest(piece) });
    }
    return { chunks, pieces };
  }
  async function publicUpload(target: Peer, key: string, bytes: Buffer, use: (chunks: Chunk[]) => Promise<unknown>): Promise<unknown> {
    const { chunks, pieces } = split(bytes, "public", key), names = chunks.map(chunk => chunk.name);
    try {
      await action(target, "prepare", { names });
      const destinationPeer = await handle(target);
      for (let index = 0; index < chunks.length; index++) {
        await transport.transport.write(destinationPeer, join(stage, chunks[index].name), pieces[index], limits.fileMs);
      }
      return await use(chunks);
    } finally { await cleanup(target, names); }
  }
  async function secretUpload(target: Peer, name: string, bytes: Buffer): Promise<void> {
    if (!Buffer.isBuffer(bytes) || bytes.length > limits.agentBytes) throw new HerdrError("too-large", "Provisioning input is too large");
    const count = Math.max(1, Math.ceil(bytes.length / limits.chunkBytes));
    for (let index = 0; index < count; index++) {
      const offset = index * limits.chunkBytes, piece = bytes.subarray(offset, Math.min(bytes.length, offset + limits.chunkBytes));
      await action(target, "secret-chunk", { name, offset, data: piece.toString("base64") });
    }
  }
  async function installFiles(target: Peer, files: readonly SelectedFile[], secret = false): Promise<void> {
    for (const file of files) {
      if (secret) {
        const name = `secret-file-${tag("secret-file", file.path)}`;
        try {
          await secretUpload(target, name, file.bytes);
          await action(target, "install-files", { file: { path: file.path, mode: file.mode,
            chunks: [{ name, size: file.bytes.length, sha256: digest(file.bytes) }] } });
        } finally { await cleanup(target, [name]); }
      } else {
        await publicUpload(target, file.path, file.bytes, chunks => action(target, "install-files", { file: { path: file.path, mode: file.mode, chunks } }));
      }
      installedFiles.set(file.path, file.mode);
    }
  }
  function auth(target: Peer, requestedOperationId: string): AuthPorts {
    if (requestedOperationId !== operationId) throw new HerdrError("invalid-operation", "Provisioning operation changed");
    const name = `secret-auth-${tag("secret-auth", "auth.json")}`, stagedFile = join(stage, name);
    return {
      async stage(bytes) { await secretUpload(target, name, bytes); return { file: stagedFile }; },
      async install(value, providers) {
        if (value.file !== stagedFile) throw new HerdrError("unsafe-auth", "Invalid authentication staging file");
        await action(target, "auth-install", { name, providers });
      },
      async remove(value: AuthStage | null) {
        if (value && value.file !== stagedFile) throw new HerdrError("unsafe-auth", "Invalid authentication staging file");
        await cleanup(target, [name]);
      },
    };
  }
  const systemd: ProvisionPorts["systemd"] = {
    unitDir,
    async writeUnit(name, contents) {
      if (name !== "spider-roam-supervisor.service") throw new HerdrError("invalid-unit", "Only the roaming supervisor unit may be installed");
      await action(peer, "unit-write", { unit: name, contents });
    },
    async systemctl(argv) {
      const allowed = JSON.stringify(argv) === JSON.stringify(["--user", "daemon-reload"]) ||
        JSON.stringify(argv) === JSON.stringify(["--user", "enable", "spider-roam-supervisor.service"]);
      if (!allowed) throw new HerdrError("invalid-systemctl", "Only the roaming supervisor unit may be enabled");
      await action(peer, "systemctl", { argv });
    },
  };
  return {
    async cleanupSecrets(target: Peer) { await action(target, "clear-secrets"); },
    async installRelease(target: Peer, input: { bytes: Buffer; sha256: string; npmPrefix: string; globalRoot: string; pi: "1.2.0"; intercom: "spider-owned" }) {
      if (input.npmPrefix !== destination.npmPrefix || input.globalRoot !== peer.globalRoot || input.pi !== "1.2.0" ||
          input.intercom !== "spider-owned" || !/^[0-9a-f]{64}$/.test(input.sha256) || digest(input.bytes) !== input.sha256) {
        throw new HerdrError("release-hash-mismatch", "The pinned release does not match the provisioning request");
      }
      type Observation = { state: "absent"; prepared: boolean } | { state: "started" } |
        { state: "failed"; reason: ReleaseReason } | { state: "finished"; value: InstalledRelease };
      const params = { sha256: input.sha256, piVersion: input.pi };
      const observe = async (): Promise<Observation> => await action(target, "release-observe", params) as Observation;
      let observation = await observe();
      if (observation.state === "absent" && !observation.prepared) {
        const { chunks, pieces } = split(input.bytes, "release", "archive"), names = chunks.map(chunk => chunk.name);
        await action(target, "prepare", { names });
        const destinationPeer = await handle(target);
        for (let index = 0; index < chunks.length; index++) {
          await transport.transport.write(destinationPeer, join(stage, chunks[index].name), pieces[index], limits.fileMs);
        }
        await action(target, "release-prepare", { ...params, chunks });
        observation = await observe();
      }
      let launched = false, attempts = 0;
      const deadline = Date.now() + limits.importMs;
      for (;;) {
        if (observation.state === "finished") return observation.value;
        if (observation.state === "failed") throw new HerdrError(observation.reason, "Release installation failed");
        if (observation.state === "absent" && observation.prepared && !launched && attempts < 2) {
          attempts++;
          try { await transport.launchRelease(await handle(target), operationId, join(stage, "release-request")); launched = true; }
          catch (error) {
            const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
            if (typeof code !== "string" || !["release-launch-uncertain", "cli-timeout", "cli-aborted", "cli-exit", "reply-too-large"].includes(code)) {
              throw failure(error, "release");
            }
          }
          observation = await observe();
          continue;
        }
        if (observation.state === "absent" && !launched && attempts >= 2) throw new HerdrError("release-launch-failed", "Release launch was not observed");
        if (Date.now() >= deadline) throw new HerdrError("release-pending", "Release installation is still being reconciled");
        const delay = limits.retryDelaysMs[Math.min(attempts, limits.retryDelaysMs.length - 1)] ?? 1000;
        await new Promise<void>(resolve => setTimeout(resolve, Math.min(delay, Math.max(1, deadline - Date.now()))));
        observation = await observe();
      }
    },
    installFiles: (target: Peer, files: readonly SelectedFile[]) => installFiles(target, files),
    installCredentialFiles: (target: Peer, files: readonly SelectedFile[]) => installFiles(target, files, true),
    auth,
    async verifyPeer() {
      const files = [...installedFiles].map(([path, mode]) => ({ path, mode }));
      return await action(peer, "verify", { providers: options.piProviders, files }) as ProvisionVerification;
    },
    async switchover(target: Peer, requestedOperationId: string) {
      if (requestedOperationId !== operationId) throw new HerdrError("invalid-operation", "Provisioning operation changed");
      return await action(target, "switchover") as { status: "applied" | "already" | "migration-pending" };
    },
    systemd,
  };
}

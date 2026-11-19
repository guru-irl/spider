import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants, lstatSync, realpathSync, readFileSync } from "node:fs";
import { link, mkdtemp, open, rm, unlink } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { dirname, isAbsolute, join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import type { Journal, Outcome } from "./contracts";
import { privateDirectory } from "@spider/herdr/sessions/registry";
import { assertTestConfigPath } from "@spider/db-core";
import { openJournal } from "./journal";
import { readLocalIdentity } from "./runtime";
import { loadHerdrConfig } from "./production-hub";
import { createProvisionTransport } from "./transport";
import { createProductionProvisionPorts, setProvisionParticipation } from "./production-provision";
import { provision, provisionSelectionDigest } from "./provision";
import { RELEASE_ENTRIES } from "./release-request";
import { parseBuildId } from "../../../scripts/build-id.mjs";
import { describeSelectedFiles, prepareSelectedFiles, readPrivateBytes, SelectedFilesError } from "./selected-files";
import { AuthError, previewPiAuthBytes } from "./auth";
import type { ProvisionPreview } from "./provision-contracts";

interface ConsentRequest { operationId: string; target: string; machineId: string; hubMachineId: string;
  files: readonly { path: string; size: number; mode: number }[]; releaseHash: string; providers?: readonly string[]; selectionDigest?: string;
  settingsFingerprint?: string | null; settingsKeys?: readonly string[]; useDestinationAuth?: boolean; replaceCorePin?: boolean }
interface ConsentPorts { tty: boolean; yes: boolean; consent: string | null; consentedProviders?: readonly string[];
  actor: string; now(): number; ask(text: string): Promise<string> }
function consentOperation(request: ConsentRequest) {
  const providers = [...(request.providers ?? (request.useDestinationAuth ? [] : ["github-copilot"]))].sort();
  if ((!request.useDestinationAuth && !providers.includes("github-copilot")) || providers.length > 64 || new Set(providers).size !== providers.length ||
      providers.some(name => !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(name))) throw new Error("provision-provider-invalid");
  return { id: request.operationId, kind: "provision-cli", machineId: request.machineId, expectedEpoch: null,
    args: { target: request.target, hubMachineId: request.hubMachineId, files: request.files.map(row => ({ ...row })), releaseHash: request.releaseHash, providers, ...(request.useDestinationAuth ? { useDestinationAuth: true } : {}), ...(request.replaceCorePin ? { replaceCorePin: true } : {}),
      ...(request.selectionDigest ? { selectionDigest: request.selectionDigest } : {}) } };
}
export async function confirmProvision(journal: Journal, request: ConsentRequest, ports: ConsentPorts): Promise<boolean> {
  const operation = consentOperation(request), providers = operation.args.providers;
  const settingsFingerprint = request.settingsFingerprint ?? null, settingsKeys = [...(request.settingsKeys ?? [])];
  if (settingsFingerprint !== null && !/^[a-f0-9]{64}$/.test(settingsFingerprint) ||
      settingsKeys.some(key => typeof key !== "string" || !key || key.length > 4096 || /[\u0000-\u001f\u007f]/.test(key)) ||
      new Set(settingsKeys).size !== settingsKeys.length || settingsFingerprint === null && settingsKeys.length) throw new Error("settings-preview-changed");
  journal.begin(operation);
  const prior = journal.read(request.operationId).find(row => row.action === "human-consent");
  if (prior) {
    if ((prior.result.settingsFingerprint ?? null) !== settingsFingerprint || JSON.stringify(prior.result.settingsKeys ?? []) !== JSON.stringify(settingsKeys)) {
      throw new Error("settings-preview-changed");
    }
    return true;
  }
  const extra = providers.filter(name => name !== "github-copilot");
  const supplied = [...(ports.consentedProviders ?? [])].sort();
  const approved = ports.tty ? /^(?:y|yes)$/i.test((await ports.ask(request.useDestinationAuth ? `Use the destination sign-in on ${request.target} without copying hub authentication and install this release? This permits box roaming participation when the hub is enabled. [y/N] ` : `Copy copilot-auth${extra.length ? ` and credentials for ${extra.join(", ")}` : ""} to ${request.target} and install this release? This permits box roaming participation when the hub is enabled. [y/N] `)).trim())
    : ports.yes && (request.useDestinationAuth || ports.consent === "copilot-auth") && JSON.stringify(supplied) === JSON.stringify(extra);
  if (!approved) return false;
  journal.record(request.operationId, "human-consent", { actor: ports.actor, at: ports.now(), operationId: request.operationId,
    target: request.target, machineId: request.machineId, consent: request.useDestinationAuth ? "destination-auth" : "copilot-auth", providers, files: request.files.map(row => ({ ...row })), releaseHash: request.releaseHash,
    settingsFingerprint, settingsKeys });
  return true;
}
export async function pinProvisionRelease(file: string, maximum: number): Promise<{ file: string; sha256: string; bytes: Buffer }> {
  if (!isAbsolute(file) || realpathSync(file) !== file || !lstatSync(file).isFile()) throw new Error("release-path-unsafe");
  const fd = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await fd.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size < 1 || stat.size > maximum || typeof process.getuid === "function" && stat.uid !== process.getuid()) throw new Error("release-file-invalid");
    const bytes = await fd.readFile();
    if (bytes.length !== stat.size || bytes.length > maximum || (await fd.stat()).mtimeMs !== stat.mtimeMs) throw new Error("release-file-changed");
    return { file, sha256: createHash("sha256").update(bytes).digest("hex"), bytes };
  } finally { await fd.close(); }
}
function installedRoot(url: URL): string {
  let path = dirname(fileURLToPath(url));
  for (;;) {
    let manifest: { name?: string } | undefined;
    try { manifest = JSON.parse(readFileSync(join(path, "package.json"), "utf8")); } catch { /* Continue to the package root. */ }
    if (manifest?.name === "@guru-irl/spider") {
      try {
        for (const entry of RELEASE_ENTRIES) { const stat = lstatSync(join(path, entry)); if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("missing"); }
        if (!parseBuildId(readFileSync(join(path, "dist", "extension.js")).subarray(0, 16384).toString("utf8"))) throw new Error("missing-build-identity");
      }
      catch { throw new Error("installed-build-unavailable"); }
      return path;
    }
    const parent = dirname(path); if (parent === path) throw new Error("installed-build-unavailable"); path = parent;
  }
}
async function packInstalled(root: string, destination: string): Promise<string> {
  const npm = join(dirname(process.execPath), process.platform === "win32" ? "npm.cmd" : "npm");
  const stdout = await new Promise<string>((done, reject) => execFile(npm, ["pack", "--ignore-scripts", "--offline", "--json", "--pack-destination", destination],
    { cwd: root, timeout: 60_000, maxBuffer: 1024 * 1024 }, (error, out) => error ? reject(new Error("release-pack-failed")) : done(out)));
  const result: unknown = JSON.parse(stdout);
  if (!Array.isArray(result) || result.length !== 1 || typeof result[0]?.filename !== "string" || posix.basename(result[0].filename) !== result[0].filename) throw new Error("release-pack-failed");
  return join(destination, result[0].filename);
}
export async function stageProvisionRelease(input: { root: string; operationId: string; release?: string; maximum: number; bundleUrl?: URL }): Promise<{ file: string; sha256: string }> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(input.operationId)) throw new Error("invalid-provision-operation");
  const base = join(input.root, "roam", "provision-source"), directory = join(base, input.operationId), file = join(directory, "release.tgz");
  assertTestConfigPath(file); await privateDirectory(base); await privateDirectory(directory);
  const existing = readPrivateBytes(directory, "release.tgz", input.maximum);
  if (existing && !input.release) return { file, sha256: createHash("sha256").update(existing).digest("hex") };
  const work = await mkdtemp(join(directory, "pack-"));
  try {
    const source = input.release ?? await packInstalled(installedRoot(input.bundleUrl ?? new URL(import.meta.url)), work);
    const pinned = await pinProvisionRelease(source, input.maximum);
    if (existing) {
      if (!existing.equals(pinned.bytes)) throw new Error("release-arguments-changed");
      return { file, sha256: pinned.sha256 };
    }
    const temporary = join(work, "release.tgz"), fd = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    try { await fd.writeFile(pinned.bytes); await fd.sync(); } finally { await fd.close(); }
    try { await link(temporary, file); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST" || !readPrivateBytes(directory, "release.tgz", input.maximum)?.equals(pinned.bytes)) throw new Error("release-arguments-changed"); }
    await unlink(temporary); const parent = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY);
    try { await parent.sync(); } finally { await parent.close(); }
    return { file, sha256: pinned.sha256 };
  } finally { await rm(work, { recursive: true, force: true }); }
}
async function removeProvisionSource(root: string, operationId: string): Promise<void> {
  const base = join(root, "roam", "provision-source"), directory = join(base, operationId);
  assertTestConfigPath(directory);
  try {
    for (const path of [base, directory]) {
      const info = lstatSync(path);
      if (!info.isDirectory() || info.isSymbolicLink() || realpathSync(path) !== path ||
          typeof process.getuid === "function" && info.uid !== process.getuid() || (info.mode & 0o7777) !== 0o700) {
        throw new Error("release-source-unsafe");
      }
    }
    await rm(directory, { recursive: true, force: true });
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}
const safe = (text: string) => text.replace(/[\u0000-\u001f\u007f]/g, "?");
function presentInventory(preview: ProvisionPreview, out: (text: string) => void): void {
  const value = preview.inventory;
  out(`Inventory for ${safe(preview.target)}: ${safe(value.platform)}, Node ${safe(value.nodeVersion)}, pi ${safe(value.piVersion ?? "missing")}.\n`);
  out(`Git ${value.gitVersion ? "available" : "missing"}; systemd user ${value.systemdUser ? "available" : "missing"}; core ${value.core.unitOwned ? "owned" : "unverified"}; pi auth ${value.auth.pi.present ? "present" : "missing"}.\n`);
  out(`Agent directory: ${safe(preview.destinations.agentDir)}\nRoaming root: ${safe(preview.destinations.globalRoot)}\nPi: ${safe(preview.destinations.pi)}\n`);
  out(`Settings keys changing: ${preview.settingsKeys.map(safe).join(", ") || "none"}\n`);
  for (const warning of preview.warnings) out(`${safe(warning)}\n`);
}
export interface ProvisionCliRequest { root: string; target: string; release?: string; yes: boolean; consent: string | null; operationId?: string;
  skills?: readonly string[]; consentedProviders?: readonly string[]; noSettings?: boolean; useDestinationAuth?: boolean; replaceCorePin?: boolean }
export async function runProvisionCli(input: ProvisionCliRequest, io: { out(text: string): void; err(text: string): void }, options: {
  bundleUrl?: URL; tty?: boolean; ask?(text: string): Promise<string>;
} = {}): Promise<Outcome<{ hostingReady: boolean }>> {
  let operationId = input.operationId ?? "";
  const refused = (code: 1 | 3, reason: string): Outcome<{ hostingReady: boolean }> => ({ code, reason, operationId, home: null, epoch: null, repairCommand: null, value: null });
  try {
    const config = readLocalIdentity(input.root); if (config.role !== "hub") throw new Error("provision-requires-hub");
    io.out(`The broker starts at enable (spider roam enable), if it is not already running.${config.enabled ? "" : " Roaming is disabled; provisioning will not enable the box or start hosting."}\n`);
    const configured = config.peers.find(peer => peer.alias === input.target || peer.machineId === input.target);
    if (!configured) throw new Error("provision-target-unavailable");
    const tty = options.tty ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
    if (!tty && !(input.yes && (input.useDestinationAuth || input.consent === "copilot-auth"))) throw new Error("provision-consent-required");
    const agentRoot = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
    let size: number | undefined;
    if (!input.useDestinationAuth) {
      let auth: Buffer | null;
      try { auth = readPrivateBytes(agentRoot, "auth.json", config.limits.agentBytes); } catch { throw new Error("copilot-auth-unavailable"); }
      if (!auth) throw new Error("copilot-auth-unavailable");
      try { size = previewPiAuthBytes(auth, ["github-copilot"]); }
      catch (error) {
        if (error instanceof AuthError && error.code === "unsupported-credential-command") throw new SelectedFilesError(error.code, ["auth.json"]);
        throw new Error("copilot-auth-unavailable");
      }
      finally { auth.fill(0); }
    }
    // Destination-managed authentication also leaves all agent files on the destination.
    // Any selected file can contain credentials, so do not inspect hub selections in this mode.
    const selected = input.useDestinationAuth ? [] : ["settings.json", "models.json", "keybindings.json", "themes", "AGENTS.md"].filter(name => {
      if (name === "settings.json" && input.noSettings) return false;
      try { lstatSync(join(agentRoot, name)); return true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
    });
    if (!input.useDestinationAuth) selected.push(...(input.skills ?? []).map(name => `skills/${name}`));
    const prepared = prepareSelectedFiles({ sourceRoot: agentRoot, selected, maxBytes: config.limits.agentBytes });
    const selectedFiles = describeSelectedFiles(prepared), selectionDigest = provisionSelectionDigest(prepared);
    const providers = [...new Set([...(input.useDestinationAuth ? [] : ["github-copilot"]), ...prepared.providers])].sort();
    for (const file of prepared.credentialFiles) file.bytes.fill(0);
    const extra = providers.filter(name => name !== "github-copilot");
    if (!input.useDestinationAuth && !tty && JSON.stringify([...(input.consentedProviders ?? [])].sort()) !== JSON.stringify(extra)) {
      io.err(`Provider consent required: ${extra.map(safe).join(", ") || "none"}.\n`);
      throw new Error("provision-provider-consent-required");
    }
    operationId = input.operationId ?? randomUUID();
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(operationId)) throw new Error("invalid-provision-operation");
    const journal = openJournal(join(input.root, "roam", "journal.db"));
    const completed = journal.read(operationId).find(row => row.action === "provision-completed")?.result;
    const done = journal.read(`${operationId}-install`).find(row => row.action === "done")?.result;
    const consent = journal.read(operationId).find(row => row.action === "human-consent")?.result;
    if (completed && (typeof completed.releaseHash !== "string" || !/^[a-f0-9]{64}$/.test(completed.releaseHash) ||
        typeof completed.contextDigest !== "string" || !/^[a-f0-9]{64}$/.test(completed.contextDigest) ||
        completed.installOperationId !== `${operationId}-install` || consent?.releaseHash !== completed.releaseHash ||
        done?.code !== 0 || done.operationId !== `${operationId}-install` || !["installed", "installed-hosting-disabled"].includes(String(done.reason)) ||
        !done.value || typeof done.value !== "object" || Array.isArray(done.value) || typeof done.value.hostingReady !== "boolean")) throw new Error("invalid-journal-result");
    const pinned = completed ? { file: join(input.root, "roam", "provision-source", operationId, "release.tgz"), sha256: completed.releaseHash as string }
      : await stageProvisionRelease({ root: input.root, operationId, release: input.release, maximum: config.limits.agentBytes, bundleUrl: options.bundleUrl });
    if (completed && input.release) {
      const supplied = await pinProvisionRelease(input.release, config.limits.agentBytes);
      try { if (supplied.sha256 !== pinned.sha256) throw new Error("release-arguments-changed"); }
      finally { supplied.bytes.fill(0); }
    }
    const npmPrefix = posix.dirname(posix.dirname(configured.pi));
    if (configured.pi !== posix.join(npmPrefix, "bin", "pi")) throw new Error("provision-destination-unavailable");
    if (!configured.agentDir && posix.basename(npmPrefix) !== ".local") throw new Error("provision-agent-directory-required");
    const releaseRoot = posix.join(npmPrefix, "spider-releases", pinned.sha256, "node_modules", "@guru-irl", "spider");
    const peer = { ...configured, cli: posix.join(releaseRoot, "dist", "roam", "cli.mjs") };
    const herdr = loadHerdrConfig(input.root);
    const transport = createProvisionTransport({ binary: herdr.core.binary, env: process.env, enrolled: [peer] }, journal);
    const home = configured.agentDir ? await transport.probeHome(peer) : posix.dirname(npmPrefix);
    const agentDir = configured.agentDir ?? posix.join(home, ".pi", "agent");
    const destination = { home, agentDir, npmPrefix, supervisor: posix.join(releaseRoot, "dist", "roam", "supervisor.mjs") };
    const contextDigest = createHash("sha256").update(JSON.stringify({ peer, destination, hubMachineId: config.machineId,
      agentRoot, limits: config.limits, coreUnit: peer.coreUnit, ...(input.replaceCorePin ? { replaceCorePin: true } : {}) })).digest("hex");
    const files = [...(size === undefined ? [] : [{ path: "auth.json", size, mode: 0o600 }]), ...selectedFiles];
    io.out(`Operation: ${operationId}\nRelease SHA-256: ${pinned.sha256}\n`);
    for (const file of files) io.out(`Selected ${safe(file.path)}: ${file.size} bytes, mode ${file.mode.toString(8)}. Destination: ${safe(posix.join(agentDir, file.path))}\n`);
    const request: ConsentRequest = { operationId, target: peer.alias, machineId: peer.machineId, hubMachineId: config.machineId, files, releaseHash: pinned.sha256, providers, selectionDigest, useDestinationAuth: input.useDestinationAuth, replaceCorePin: input.replaceCorePin };
    // Reserve the byte identity before any remote observation. Consent itself is recorded after inventory.
    journal.begin(consentOperation(request));
    if (completed && completed.contextDigest !== contextDigest) throw new Error("Operation ID already has different arguments");
    if (completed) {
      try { await setProvisionParticipation({ root: input.root, hubMachineId: config.machineId, peer, ready: null, journal, transport }); }
      catch { io.err("provision-participation-unconfirmed. Retry provisioning or run spider roam disable.\n"); return refused(3, "provision-participation-unconfirmed"); }
      await removeProvisionSource(input.root, operationId);
      io.out(`${safe(done!.reason as string)}\n`);
      return { code: 0, reason: done!.reason as string, operationId: done!.operationId as string, home: null, epoch: null, repairCommand: null,
        value: { hostingReady: (done!.value as { hostingReady: boolean }).hostingReady } };
    }
    let shownSettings: { fingerprint: string | null; keys: readonly string[] } = { fingerprint: null, keys: [] };
    const ports = createProductionProvisionPorts({ root: input.root, hubMachineId: config.machineId, peer, operationId: `${operationId}-install`, transport, journal, limits: config.limits,
      source: { agentRoot, releaseFile: pinned.file, piProviders: input.useDestinationAuth ? [] : ["github-copilot"] }, destination, unitDir: posix.join(home, ".config/systemd/user"),
      release: { pi: "1.2.0", intercom: "spider-owned", spiderSha256: pinned.sha256, nodeRange: "22.23.4 || 26.4.0" },
      async present(preview) { shownSettings = { fingerprint: preview.settingsFingerprint, keys: [...preview.settingsKeys] }; presentInventory(preview, io.out); },
      async confirm() { return confirmProvision(journal, { ...request, settingsFingerprint: shownSettings.fingerprint, settingsKeys: shownSettings.keys },
        { tty, yes: input.yes, consent: input.consent, consentedProviders: input.consentedProviders, actor: userInfo().username, now: Date.now,
        async ask(text) { if (options.ask) return options.ask(text); const readline = createInterface({ input: process.stdin, output: process.stdout }); try { return await readline.question(text); } finally { readline.close(); } } }); },
      async report(rows) { for (const row of rows) io.out(`${safe(row.reason)}\n`); },
      async resources() { throw new Error("Local resource probes are not used for provisioning"); }, async bootId() { throw new Error("Local boot probes are not used for provisioning"); },
    });
    const result = await provision({ operation: { id: `${operationId}-install`, kind: "provision", machineId: peer.machineId, expectedEpoch: null, args: {} },
      peer, selected, replaceCorePin: input.replaceCorePin, includeAuth: !input.useDestinationAuth, requireDestinationAuth: input.useDestinationAuth, confirmedProviders: providers, expectedAuthBytes: size, expectedFiles: selectedFiles, expectedSelectionDigest: selectionDigest }, ports);
    const replaced = journal.read(`${operationId}-install`).find(row => row.action === "core-pin-replaced")?.result;
    if (replaced && typeof replaced.oldCoreId === "string" && typeof replaced.newCoreId === "string") {
      const hash = (id: string) => createHash("sha256").update(id).digest("hex");
      io.out(`Core pin replaced. Previous identity SHA-256: ${hash(replaced.oldCoreId)}. New identity SHA-256: ${hash(replaced.newCoreId)}.\n`);
    }
    if (result.repairCommand && ["core-pin-changed", "core-pin-conflict"].includes(result.reason)) {
      io.err(`Stop hosting and move sessions off the box, then run ${result.repairCommand} with the same authentication options.\n`);
    }
    if (result.reason === "destination-permissions-unsafe" && result.repairCommand) {
      io.err(`Unsafe permissions on ${safe(peer.alias)}. On the box, run ${result.repairCommand}.\n`);
    }
    if (result.reason === "core-pin-in-use") io.err("Move sessions off this box, run spider roam disable on the hub, and stop spider-roam-supervisor.service on the box before retrying.\n");
    if (result.code === 0 && journal.read(`${operationId}-install`).some(row => row.action === "done" && row.result.code === 0)) {
      journal.record(operationId, "provision-completed", { installOperationId: `${operationId}-install`, releaseHash: pinned.sha256, contextDigest });
      await removeProvisionSource(input.root, operationId);
    }
    if (result.reason === "release-pending") {
      const target = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,255}$/.test(peer.alias) ? peer.alias : peer.machineId;
      const repairCommand = `spider roam provision ${target} --operation-id ${operationId}`;
      io.err(`Installation is still finishing on ${safe(peer.alias)}. Rerun ${repairCommand} with the same options to confirm.\n`);
      return { ...result, repairCommand };
    }
    if (result.reason === "npm-not-found") io.err(`Cannot find npm at ${safe(posix.join(posix.dirname(peer.node), "npm"))} on ${safe(peer.alias)}. Install npm next to the configured Node executable, or update the peer's node path. Retry with a new operation ID.\n`);
    if (result.reason === "npm-install-failed") io.err(`The destination's ${safe(posix.join(peer.globalRoot, "roam", "provision", `${operationId}-install`, "release-receipt.json"))} contains structured npm failure details. Fix the installation error, then retry with a new operation ID.\n`);
    if (["peer-core-unit-required", "peer-core-unit-ambiguous"].includes(result.reason)) io.err("Set coreUnit on this destination's peer entry in the hub roaming config, then retry.\n");
    (result.code === 0 ? io.out : io.err)(`${safe(result.reason)}\n`); return result;
  } catch (error) {
    if (error instanceof SelectedFilesError) {
      const files = error.files.filter(file => file.length <= 4096 && !/[\u0000-\u001f\u007f]/.test(file));
      io.err(`${error.code}${files.length ? ` (${files.join(", ")})` : ""}.\n`);
      return refused(1, error.code);
    }
    const message = error instanceof Error ? error.message : "";
    const named = /^(?:provision-|copilot-auth-|release-|installed-build-|invalid-provision-)[a-z-]+$/.test(message) ? message
      : message === "Operation ID already has different arguments" ? "provision-operation-arguments-changed" : "provision-unavailable";
    io.err(`${named}.${named === "provision-requires-hub" ? " Run this command on the Mac hub." : ""}\n`); return refused(1, named);
  }
}

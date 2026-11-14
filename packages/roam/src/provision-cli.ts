import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants, lstatSync, realpathSync, readFileSync } from "node:fs";
import { link, mkdtemp, open, rm, unlink } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { dirname, isAbsolute, join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import type { Journal } from "./contracts";
import { privateDirectory } from "@spider/herdr/sessions/registry";
import { assertTestConfigPath } from "@spider/db-core";
import { openJournal } from "./journal";
import { readLocalIdentity } from "./runtime";
import { loadHerdrConfig } from "./production-hub";
import { createProvisionTransport } from "./transport";
import { createProductionProvisionPorts } from "./production-provision";
import { provision } from "./provision";
import { RELEASE_ENTRIES } from "./release-request";
import { parseBuildId } from "../../../scripts/build-id.mjs";
import { readPrivateBytes } from "./selected-files";
import { previewPiAuthBytes } from "./auth";
import type { ProvisionPreview } from "./provision-contracts";

interface ConsentRequest { operationId: string; target: string; machineId: string; hubMachineId: string;
  files: readonly { path: string; size: number; mode: number }[]; releaseHash: string }
interface ConsentPorts { tty: boolean; yes: boolean; consent: string | null; actor: string; now(): number; ask(text: string): Promise<string> }
export async function confirmProvision(journal: Journal, request: ConsentRequest, ports: ConsentPorts): Promise<boolean> {
  const operation = { id: request.operationId, kind: "provision-cli", machineId: request.machineId, expectedEpoch: null,
    args: { target: request.target, hubMachineId: request.hubMachineId, files: request.files.map(row => ({ ...row })), releaseHash: request.releaseHash } };
  journal.begin(operation);
  if (journal.read(request.operationId).some(row => row.action === "human-consent")) return true;
  const approved = ports.tty ? /^(?:y|yes)$/i.test((await ports.ask(`Copy copilot-auth to ${request.target} and install this release? [y/N] `)).trim())
    : ports.yes && ports.consent === "copilot-auth";
  if (!approved) return false;
  journal.record(request.operationId, "human-consent", { actor: ports.actor, at: ports.now(), operationId: request.operationId,
    target: request.target, machineId: request.machineId, consent: "copilot-auth", files: request.files.map(row => ({ ...row })), releaseHash: request.releaseHash });
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
const safe = (text: string) => text.replace(/[\u0000-\u001f\u007f]/g, "?");
function presentInventory(preview: ProvisionPreview, out: (text: string) => void): void {
  const value = preview.inventory;
  out(`Inventory for ${safe(preview.target)}: ${safe(value.platform)}, Node ${safe(value.nodeVersion)}, pi ${safe(value.piVersion ?? "missing")}.\n`);
  out(`Git ${value.gitVersion ? "available" : "missing"}; systemd user ${value.systemdUser ? "available" : "missing"}; core ${value.core.unitOwned ? "owned" : "unverified"}; pi auth ${value.auth.pi.present ? "present" : "missing"}.\n`);
  out(`Agent directory: ${safe(preview.destinations.agentDir)}\nRoaming root: ${safe(preview.destinations.globalRoot)}\nPi: ${safe(preview.destinations.pi)}\n`);
  for (const warning of preview.warnings) out(`${safe(warning)}\n`);
}
export interface ProvisionCliRequest { root: string; target: string; release?: string; yes: boolean; consent: string | null; operationId?: string }
export async function runProvisionCli(input: ProvisionCliRequest, io: { out(text: string): void; err(text: string): void }, options: {
  bundleUrl?: URL; tty?: boolean; ask?(text: string): Promise<string>;
} = {}): Promise<number> {
  try {
    const config = readLocalIdentity(input.root); if (config.role !== "hub") throw new Error("provision-requires-hub");
    const configured = config.peers.find(peer => peer.alias === input.target || peer.machineId === input.target);
    if (!configured) throw new Error("provision-target-unavailable");
    const tty = options.tty ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
    if (!tty && !(input.yes && input.consent === "copilot-auth")) throw new Error("provision-consent-required");
    const agentRoot = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
    let auth: Buffer | null;
    try { auth = readPrivateBytes(agentRoot, "auth.json", config.limits.agentBytes); } catch { throw new Error("copilot-auth-unavailable"); }
    if (!auth) throw new Error("copilot-auth-unavailable");
    let size: number;
    try { size = previewPiAuthBytes(auth, ["github-copilot"]); }
    catch { throw new Error("copilot-auth-unavailable"); }
    finally { auth.fill(0); }
    const operationId = input.operationId ?? randomUUID();
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(operationId)) throw new Error("invalid-provision-operation");
    const pinned = await stageProvisionRelease({ root: input.root, operationId, release: input.release, maximum: config.limits.agentBytes, bundleUrl: options.bundleUrl });
    const npmPrefix = posix.dirname(posix.dirname(configured.pi));
    if (posix.basename(npmPrefix) !== ".local" || configured.pi !== posix.join(npmPrefix, "bin", "pi")) throw new Error("provision-destination-unavailable");
    const home = posix.dirname(npmPrefix), agentDir = posix.join(home, ".pi", "agent");
    const releaseRoot = posix.join(npmPrefix, "spider-releases", pinned.sha256, "node_modules", "@guru-irl", "spider");
    const peer = { ...configured, cli: posix.join(releaseRoot, "dist", "roam", "cli.mjs") };
    const destination = { home, agentDir, npmPrefix, supervisor: posix.join(releaseRoot, "dist", "roam", "supervisor.mjs") };
    const journal = openJournal(join(input.root, "roam", "journal.db")), herdr = loadHerdrConfig(input.root);
    const files = [{ path: "auth.json", size, mode: 0o600 }];
    io.out(`Operation: ${operationId}\nRelease SHA-256: ${pinned.sha256}\n`);
    for (const file of files) io.out(`Selected ${file.path}: ${file.size} bytes, mode ${file.mode.toString(8)}.\n`);
    const request: ConsentRequest = { operationId, target: peer.alias, machineId: peer.machineId, hubMachineId: config.machineId, files, releaseHash: pinned.sha256 };
    // Reserve the byte identity before any remote observation. Consent itself is recorded after inventory.
    journal.begin({ id: operationId, kind: "provision-cli", machineId: peer.machineId, expectedEpoch: null,
      args: { target: peer.alias, hubMachineId: config.machineId, files, releaseHash: pinned.sha256 } });
    const transport = createProvisionTransport({ binary: herdr.core.binary, env: process.env, enrolled: [peer] }, journal);
    const ports = createProductionProvisionPorts({ root: input.root, hubMachineId: config.machineId, peer, operationId: `${operationId}-install`, transport, journal, limits: config.limits,
      source: { agentRoot, releaseFile: pinned.file, piProviders: ["github-copilot"] }, destination, coreUnit: config.coreUnit, unitDir: posix.join(home, ".config/systemd/user"),
      release: { pi: "1.2.0", intercom: "spider-owned", spiderSha256: pinned.sha256, nodeRange: "22.23.4 || 26.4.0" },
      async present(preview) { presentInventory(preview, io.out); },
      async confirm() { return confirmProvision(journal, request, { tty, yes: input.yes, consent: input.consent, actor: userInfo().username, now: Date.now,
        async ask(text) { if (options.ask) return options.ask(text); const readline = createInterface({ input: process.stdin, output: process.stdout }); try { return await readline.question(text); } finally { readline.close(); } } }); },
      async report(rows) { for (const row of rows) io.out(`${safe(row.reason)}\n`); },
      async resources() { throw new Error("Local resource probes are not used for provisioning"); }, async bootId() { throw new Error("Local boot probes are not used for provisioning"); },
    });
    const result = await provision({ operation: { id: `${operationId}-install`, kind: "provision", machineId: peer.machineId, expectedEpoch: null, args: {} },
      peer, selected: [], includeAuth: true, confirmedProviders: ["github-copilot"], expectedAuthBytes: size }, ports);
    (result.code === 0 ? io.out : io.err)(`${safe(result.reason)}\n`); return result.code;
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    const named = /^(?:provision-|copilot-auth-|release-|installed-build-|invalid-provision-)[a-z-]+$/.test(message) ? message
      : message === "Operation ID already has different arguments" ? "provision-operation-arguments-changed" : "provision-unavailable";
    io.err(`${named}.${named === "provision-requires-hub" ? " Run this command on the Mac hub." : ""}\n`); return 1;
  }
}

import selectedSource from "./selected-files.ts?raw";
import authSource from "./auth.ts?raw";
import receiptSource from "./release-receipt.ts?raw";
import releaseRequestSource from "./release-request.ts?raw";
import enrollmentSource from "./enrollment.ts?raw";
import configSource from "./config.ts?raw";
import machineIdSource from "./machine-id.ts?raw";
import { DEFAULT_LIMITS } from "./contracts";

// The destination executes the same file and auth checks as the local installer. Node's
// native TypeScript stripping needs no package install before the release exists.
const authForRemote = authSource
  .replace('import { basename, dirname } from "node:path";', 'import { basename } from "node:path";')
  .replace('import type { Journal, Peer } from "./contracts";', "")
  .replace('import { installPiAuthBytes, readPrivateBytes } from "./selected-files";', "");
const configForRemote = configSource
  .replace('import { readFileSync } from "node:fs";', "")
  .replace('import { isAbsolute } from "node:path";', "")
  .replace('import { DEFAULT_LIMITS } from "./contracts";', "")
  .replace('import { isMachineId } from "./machine-id";', "")
  .replace('import type { Limits, Peer, RoamConfig } from "./contracts";', "")
  .replace(/^export /gm, "");
const machineIdForRemote = machineIdSource.replace(/^export /gm, "");
const enrollmentForRemote = enrollmentSource.replace('import { parseConfig as parseRoamConfig } from "./config";', "");
if (authForRemote === authSource || authForRemote.includes('from "./') || configForRemote.includes("import ") ||
    enrollmentForRemote === enrollmentSource || enrollmentForRemote.includes('from "./')) throw new Error("Cannot assemble provisioning program");
const enrollmentConfigForRemote = `const parseRoamConfig = (() => {\nconst DEFAULT_LIMITS = ${JSON.stringify(DEFAULT_LIMITS)};\n${machineIdForRemote}\n${configForRemote}\nreturn parseConfig;\n})();\n`;

export const PROVISION_REMOTE_SCRIPT: string = selectedSource + "\n" + authForRemote + "\n" + receiptSource + "\n" + releaseRequestSource + "\n" + enrollmentConfigForRemote + enrollmentForRemote + String.raw`
import { createHash } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

type Request = Record<string, any>;
const requestFile = process.argv[1] ?? null;
const request: Request = JSON.parse(requestFile === null ? readFileSync(0, "utf8") : readFile(requestFile, 2 * 1024 * 1024).bytes.toString("utf8"));
function bad(code: string): never { throw Object.assign(new Error("Provision request refused"), { code }); }
function text(name: string): string {
  const value = request[name];
  if (typeof value !== "string" || !value || value.includes("\0")) bad("invalid-request");
  return value;
}
function inside(base: string, value: string): boolean {
  return isAbsolute(value) && resolve(value) === value && value.startsWith(base + sep);
}
function name(value: unknown): string {
  if (typeof value !== "string" || !/^(?:public|secret|release)-[A-Za-z0-9.-]{1,80}$/.test(value)) bad("invalid-staging-name");
  return value;
}
function ensurePrivate(base: string, target: string, privateMode = true): void {
  if (!inside(base, target)) bad("unsafe-path");
  let current = base;
  for (const part of target.slice(base.length + 1).split(sep)) {
    current = join(current, part);
    if (!exists(current)) {
      try { mkdirSync(current, { mode: 0o700 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    }
    directory(current, privateMode && current === target);
  }
  if (realpathSync(target) !== target) bad("unsafe-path");
}
function setPrivate(file: string): void {
  const fd = openSync(file, constants.O_RDWR | constants.O_NOFOLLOW);
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || !own(info) || info.nlink !== 1) bad("unsafe-staging");
    fchmodSync(fd, 0o600);
  } finally { closeSync(fd); }
}
function digest(bytes: Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }
function decode(value: unknown, maximum: number): Buffer {
  if (typeof value !== "string" || value.length > Math.ceil(maximum / 3) * 4 + 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) bad("invalid-chunk");
  const bytes = Buffer.from(value, "base64");
  if (bytes.length > maximum || bytes.toString("base64") !== value) bad("invalid-chunk");
  return bytes;
}
function assemble(stage: string, chunks: unknown, maximum: number): Buffer {
  if (!Array.isArray(chunks) || !chunks.length || chunks.length > 10_000) bad("invalid-chunks");
  const pieces: Buffer[] = []; let size = 0;
  for (const item of chunks) {
    if (!item || typeof item !== "object") bad("invalid-chunks");
    const file = name(item.name), path = join(stage, file);
    if (!Number.isSafeInteger(item.size) || item.size < 0 || !/^[0-9a-f]{64}$/.test(item.sha256)) bad("invalid-chunks");
    setPrivate(path);
    const bytes = readPrivateBytes(stage, file, maximum - size);
    if (!bytes || bytes.length !== item.size || digest(bytes) !== item.sha256) bad("chunk-mismatch");
    size += bytes.length;
    if (size > maximum) bad("too-large");
    pieces.push(bytes);
  }
  return Buffer.concat(pieces, size);
}
function command(file: string, argv: string[], env: NodeJS.ProcessEnv, timeout: number): void {
  const child = spawnSync(file, argv, { env, stdio: "ignore", timeout });
  if (child.status !== 0 || child.error || child.signal) bad("command-failed");
}
function releaseRuntimeOwner(): ReleaseOwner {
  if (process.platform !== "linux") return { pid: process.pid, bootId: "nonlinux", start: String(Date.now()) };
  try {
    const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    const stat = readFileSync("/proc/self/stat", "utf8"), start = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
    if (!/^[a-f0-9-]{36}$/.test(bootId) || !/^[0-9]+$/.test(start)) bad("process-identity-unavailable");
    return { pid: process.pid, bootId, start };
  } catch { return bad("process-identity-unavailable"); }
}
function releaseRuntimeProbe(owner: ReleaseOwner): "live" | "absent" | "unknown" {
  if (process.platform !== "linux") return "unknown";
  try {
    const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    if (!/^[a-f0-9-]{36}$/.test(bootId)) return "unknown";
    if (bootId !== owner.bootId) return "absent";
    const stat = readFileSync("/proc/" + owner.pid + "/stat", "utf8"), fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    if (!fields[0] || !/^[0-9]+$/.test(fields[19] ?? "")) return "unknown";
    return fields[0] === "Z" || fields[19] !== owner.start ? "absent" : "live";
  } catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "unknown"; }
}
function releaseCore(core: string, coreId: string): void {
  const status = spawnSync(core, ["server", "status", "--json"], { encoding: "utf8", timeout: 5000, maxBuffer: 16_384, stdio: ["ignore", "pipe", "ignore"] });
  if (status.status !== 0) bad("core-unavailable");
  try { if (JSON.parse(status.stdout).core.id !== coreId) bad("core-changed"); }
  catch (error) { if (error && typeof error === "object" && "code" in error && error.code === "core-changed") throw error; bad("core-unavailable"); }
}
function releaseTerminals(core: string, coreId: string, operationId: string, machineId: string): "none" | "live" | "finished" {
  releaseCore(core, coreId);
  const list = spawnSync(core, ["ls", "--all", "--json", "--label", "spider.operation=" + operationId, "--label", "spider.machine=" + machineId],
    { encoding: "utf8", timeout: 5000, maxBuffer: 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
  if (list.status !== 0) bad("release-evidence-unavailable");
  let rows: unknown;
  try { rows = JSON.parse(list.stdout).terminals; } catch { bad("release-evidence-unavailable"); }
  if (!Array.isArray(rows) || rows.some(row => !row || typeof row !== "object" || !row.labels ||
      row.labels["spider.operation"] !== operationId || row.labels["spider.machine"] !== machineId || !["live", "finished"].includes(row.state))) {
    bad("release-evidence-unavailable");
  }
  releaseCore(core, coreId);
  return rows.some(row => row.state === "live") ? "live" : rows.length ? "finished" : "none";
}
async function run(): Promise<unknown> {
  const home = text("home"), globalRoot = text("globalRoot"), agentDir = text("agentDir"), npmPrefix = text("npmPrefix"), unitDir = text("unitDir");
  const operationId = text("operationId"), machineId = text("machineId"), action = text("action");
  if (resolve(home) !== home || realpathSync(home) !== home || homedir() !== home ||
      !inside(home, globalRoot) || !inside(home, agentDir) || !inside(home, npmPrefix) || !inside(home, unitDir) ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(operationId)) bad("unsafe-context");
  directory(globalRoot, false);
  const roam = join(globalRoot, "roam"); directory(roam, true);
  const identity = readPrivateBytes(roam, "machine.json", 4096);
  if (!identity || (JSON.parse(identity.toString("utf8")) as { machineId?: unknown }).machineId !== machineId) bad("machine-mismatch");
  const provision = join(roam, "provision"), stage = join(provision, operationId);
  ensurePrivate(home, provision); ensurePrivate(home, stage);
  if (requestFile === null ? action === "release" : action !== "release" || requestFile !== join(stage, "release-request")) bad("invalid-request");
  const maximum = request.maximum, chunkBytes = request.chunkBytes;
  if (!Number.isSafeInteger(maximum) || maximum <= 0 || maximum > 256 * 1024 * 1024 ||
      !Number.isSafeInteger(chunkBytes) || chunkBytes <= 0 || chunkBytes > 1024 * 1024) bad("invalid-limits");
  let unlock = () => {};
  if (action !== "release" && action !== "release-observe" && action !== "verify") {
    const intents = join(roam, "provision-intents"), intentDir = join(intents, operationId);
    ensurePrivate(home, intents); ensurePrivate(home, intentDir);
    let key: unknown = action;
    if (action === "prepare") key = [action, Array.isArray(request.names) ? String(request.names[0]).replace(/-\d+$/, "") : ""];
    else if (action === "secret-chunk") key = [action, request.name, request.offset];
    else if (action === "cleanup") key = [action, request.names];
    else if (action === "install-files") key = [action, request.file?.path];
    else if (action === "systemctl") key = [action, request.argv];
    const step = createHash("sha256").update(JSON.stringify(key)).digest("hex");
    const intent = "intent-" + step, file = join(intentDir, intent);
    const hash = createHash("sha256").update(JSON.stringify(request)).digest("hex");
    const matches = () => {
      const bytes = readPrivateBytes(intentDir, intent, 1024);
      if (!bytes) return false;
      try {
        const prior = JSON.parse(bytes.toString("utf8"));
        if (!prior || Object.keys(prior).length !== 2 || prior.version !== 1 || prior.digest !== hash) bad("operation-arguments-changed");
        return true;
      } finally { bytes.fill(0); }
    };
    if (!matches()) {
      try { atomicWrite(file, Buffer.from(JSON.stringify({ version: 1, digest: hash })), 0o600, true); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST" || !matches()) throw error;
      }
    }
    const lockInput = { directory: intentDir, operationId, digest: hash, owner: releaseRuntimeOwner() };
    const claim = beginShortWrite(lockInput, releaseRuntimeProbe);
    if (claim.kind === "busy") bad("short-write-pending");
    unlock = () => endShortWrite(lockInput, claim.token);
  }
  try {
  if (action === "enrollment") {
    releaseCore(text("core"), text("coreId"));
    const result = installBoxEnrollment(globalRoot, machineId, text("hubMachineId"), text("coreUnit"));
    releaseCore(text("core"), text("coreId"));
    return result;
  }
  if (action === "clear-secrets") {
    for (const operation of readdirSync(provision)) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(operation)) continue;
      const directoryPath = join(provision, operation), info = lstatSync(directoryPath);
      if (!info.isDirectory() || info.isSymbolicLink() || !own(info) || (info.mode & 0o7777) !== 0o700) bad("unsafe-staging");
      if (operation !== operationId) {
        const prior = readPrivateBytes(directoryPath, "release-request", 2 * 1024 * 1024);
        if (prior) {
          let previous: Request; try { previous = JSON.parse(prior.toString("utf8")); } catch { bad("invalid-release-request"); }
          if (previous.operationId !== operation || previous.machineId !== machineId || previous.globalRoot !== globalRoot) bad("invalid-release-request");
          const observed = inspectRelease({ directory: directoryPath, operationId: operation, digest: releaseRequestDigest(previous as ReleaseArguments) }, releaseRuntimeProbe);
          if (observed.state === "started" || observed.state === "absent") bad("release-in-progress");
        }
      }
      let removed = false;
      for (const entry of readdirSync(directoryPath)) {
        if (!/^(?:secret-[A-Za-z0-9.-]{1,80}|doctor-[A-Za-z0-9-]{1,80}|\.secret-[a-f0-9-]{36}\.tmp)$/.test(entry)) continue;
        const target = join(directoryPath, entry), stat = lstatSync(target);
        if (!own(stat)) bad("unsafe-staging");
        if (stat.isSymbolicLink() || stat.isFile()) unlinkSync(target);
        else if (entry.startsWith("doctor-") && stat.isDirectory() && (stat.mode & 0o7777) === 0o700) rmSync(target, { recursive: true, force: true });
        else bad("unsafe-staging");
        removed = true;
      }
      if (removed) syncDirectory(directoryPath);
    }
    return true;
  }
  if (action === "prepare") {
    if (!Array.isArray(request.names) || request.names.length > 10_000) bad("invalid-chunks");
    for (const item of request.names) {
      const file = name(item);
      if (!/^(?:public|release)-[a-f0-9]{32}-[0-9]{1,5}$/.test(file)) bad("invalid-staging-name");
      const target = join(stage, file);
      if (exists(target)) readPrivateBytes(stage, file, maximum);
      else {
        try { atomicWrite(target, Buffer.alloc(0), 0o600, true); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; readPrivateBytes(stage, file, maximum); }
      }
    }
    return true;
  }
  if (action === "secret-chunk") {
    const file = name(request.name);
    if (!file.startsWith("secret-") || !Number.isSafeInteger(request.offset) || request.offset < 0) bad("invalid-chunk");
    const bytes = decode(request.data, chunkBytes);
    try {
      if (request.offset + bytes.length > maximum) bad("too-large");
      const previous = readPrivateBytes(stage, file, maximum);
      try {
        if (previous && previous.length >= request.offset + bytes.length) {
          if (!previous.subarray(request.offset, request.offset + bytes.length).equals(bytes)) bad("operation-arguments-changed");
        } else {
          if ((previous?.length ?? 0) !== request.offset) bad("invalid-chunk");
          const next = previous ? Buffer.concat([previous, bytes]) : Buffer.from(bytes);
          try { atomicWrite(join(stage, file), next, 0o600, previous === null, ".secret-"); } finally { next.fill(0); }
        }
      } finally { previous?.fill(0); }
    } finally { bytes.fill(0); }
    return true;
  }
  if (action === "cleanup") {
    if (!Array.isArray(request.names) || request.names.length > 10_001) bad("invalid-chunks");
    for (const item of request.names) {
      const file = name(item);
      if (!/^(?:(?:public|release)-[a-f0-9]{32}-[0-9]{1,5}|secret-(?:auth|file)-[a-f0-9]{32}|release-release\.tgz)$/.test(file)) bad("invalid-staging-name");
      const path = join(stage, file);
      if (!exists(path)) continue;
      const stat = lstatSync(path); if (!own(stat) || stat.isDirectory()) bad("unsafe-staging");
      unlinkSync(path);
    }
    for (const entry of readdirSync(stage)) {
      if (!/^\.secret-[a-f0-9-]{36}\.tmp$/.test(entry)) continue;
      const target = join(stage, entry), stat = lstatSync(target);
      if (!stat.isFile() || stat.isSymbolicLink() || !own(stat) || (stat.mode & 0o7777) !== 0o600) bad("unsafe-staging");
      unlinkSync(target);
    }
    syncDirectory(stage);
    return true;
  }
  if (action === "install-files") {
    ensurePrivate(home, agentDir, false);
    if (!request.file || typeof request.file !== "object" || typeof request.file.path !== "string" ||
        (request.file.mode !== 0o600 && request.file.mode !== 0o700)) bad("invalid-file");
    const bytes = assemble(stage, request.file.chunks, maximum);
    try { installSelectedFiles({ destinationRoot: agentDir, files: [{ path: request.file.path, mode: request.file.mode, bytes }] }); }
    finally { bytes.fill(0); }
    return true;
  }
  if (action === "auth-install") {
    ensurePrivate(home, agentDir, false);
    const file = name(request.name);
    if (!file.startsWith("secret-") || !Array.isArray(request.providers)) bad("invalid-request");
    installPiAuth({ destinationRoot: agentDir, stagingRoot: stage, stagedFile: join(stage, file), providers: request.providers });
    return true;
  }
  if (action === "release-prepare" || action === "release-observe" || action === "release") {
    const sha = text("sha256"), node = text("node"), cli = text("cli"), supervisor = text("supervisor"), core = text("core"), coreId = text("coreId");
    if (!/^[0-9a-f]{64}$/.test(sha) || !isAbsolute(node) || !isAbsolute(core) || request.piVersion !== "1.2.0") bad("invalid-release");
    const key: ReleaseKey = { directory: stage, operationId, digest: releaseRequestDigest(request as ReleaseArguments) };
    const saved = readPrivateBytes(stage, "release-request", 2 * 1024 * 1024);
    if (saved) {
      let previous: Request;
      try { previous = JSON.parse(saved.toString("utf8")); } catch { bad("invalid-release-request"); }
      if (releaseRequestDigest(previous as ReleaseArguments) !== key.digest) bad("release-arguments-changed");
      if (previous.coreId !== coreId) bad("core-changed");
    }
    if (action === "release-prepare") {
      if (saved) return true;
      if (!Array.isArray(request.chunks) || !request.chunks.length || request.chunks.length > 10_000 ||
          request.chunks.some((chunk: any) => !chunk || typeof chunk !== "object" || !/^release-[a-f0-9]{32}-[0-9]{1,5}$/.test(name(chunk.name)) ||
            !Number.isSafeInteger(chunk.size) || chunk.size < 0 || chunk.size > chunkBytes || !/^[a-f0-9]{64}$/.test(chunk.sha256))) bad("invalid-chunks");
      const immutable = { action: "release", operationId, machineId, home, globalRoot, agentDir, npmPrefix, unitDir, core, coreId,
        node, pi: text("pi"), cli, supervisor, maximum, chunkBytes, timeout: request.timeout, sha256: sha, piVersion: request.piVersion, chunks: request.chunks };
      atomicWrite(join(stage, "release-request"), Buffer.from(JSON.stringify(immutable)), 0o600, true);
      return true;
    }
    if (action === "release-observe") {
      const observation = inspectRelease(key, releaseRuntimeProbe);
      if (observation.state === "finished" || observation.state === "failed") return observation;
      const terminal = releaseTerminals(core, coreId, operationId, machineId);
      if (observation.state === "started") {
        return terminal === "finished" ? inspectRelease(key, owner => {
          const state = releaseRuntimeProbe(owner); return state === "unknown" ? "absent" : state;
        }) : observation;
      }
      if (terminal === "live") return { state: "started" };
      if (terminal === "finished") {
        const input = { ...key, owner: releaseRuntimeOwner() }, claim = beginRelease(input);
        if (claim.kind === "acquired") finishRelease(input, claim.token, { state: "failed", reason: "installer-interrupted" });
        return inspectRelease(key, releaseRuntimeProbe);
      }
      return { state: "absent", prepared: saved !== null };
    }
    releaseCore(core, coreId);
    const input = { ...key, owner: releaseRuntimeOwner() }, claim = beginRelease(input);
    if (claim.kind === "duplicate") return true;
    let bytes: Buffer | null = null; const archive = join(stage, "release-release.tgz");
    try {
      ensurePrivate(home, npmPrefix, false);
      bytes = assemble(stage, request.chunks, maximum);
      if (digest(bytes) !== sha) bad("release-hash-mismatch");
      atomicWrite(archive, bytes, 0o600, false);
      const installPrefix = join(npmPrefix, "spider-releases", sha);
      ensurePrivate(home, installPrefix);
      const release = join(installPrefix, "node_modules", "@guru-irl", "spider");
      const expectedCli = join(release, "dist", "roam", "cli.mjs"), expectedSupervisor = join(release, "dist", "roam", "supervisor.mjs");
      if (cli !== expectedCli || supervisor !== expectedSupervisor || text("pi") !== join(npmPrefix, "bin", "pi")) bad("invalid-release");
      const npm = join(dirname(node), "npm");
      const env = { ...process.env, PATH: dirname(node) + ":" + (process.env.PATH ?? ""), SPIDER_GLOBAL_ROOT: globalRoot, npm_config_update_notifier: "false" };
      const timeout = Number.isSafeInteger(request.timeout) && request.timeout > 0 ? request.timeout : 600_000;
      command(npm, ["install", "--global", "--prefix", npmPrefix, "--no-audit", "--no-fund", "@earendil-works/pi-coding-agent@1.2.0"], env, timeout);
      command(npm, ["install", "--prefix", installPrefix, "--no-audit", "--no-fund", archive], env, timeout);
      for (const file of RELEASE_ENTRIES.map(entry => join(release, entry))) {
        const info = lstatSync(file); if (!info.isFile() || info.isSymbolicLink() || !own(info)) bad("incomplete-release");
      }
      const version = spawnSync(text("pi"), ["--version"], { env, encoding: "utf8", timeout: 15_000, maxBuffer: 4096 });
      if (version.status !== 0 || version.stdout.trim() !== "1.2.0") bad("pi-version-mismatch");
      const value = { pi: text("pi"), cli: expectedCli, supervisor: expectedSupervisor };
      finishRelease(input, claim.token, { state: "finished", value });
      return value;
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? error.code : null;
      const reason: ReleaseReason = releaseReason(code) ? code : "release-install-failed";
      finishRelease(input, claim.token, { state: "failed", reason });
      return { state: "failed", reason };
    } finally { bytes?.fill(0); try { unlinkSync(archive); } catch { /* a retry cleans partial staging */ } }
  }
  if (action === "unit-write") {
    ensurePrivate(home, unitDir, false);
    if (request.unit !== "spider-roam-supervisor.service" || typeof request.contents !== "string" || Buffer.byteLength(request.contents) > 1024 * 1024) bad("invalid-unit");
    installFile(rootPath(unitDir), { path: request.unit, bytes: Buffer.from(request.contents), mode: 0o600 });
    return true;
  }
  if (action === "systemctl") {
    const argv = request.argv;
    if (!Array.isArray(argv) || (JSON.stringify(argv) !== JSON.stringify(["--user", "daemon-reload"]) &&
      JSON.stringify(argv) !== JSON.stringify(["--user", "enable", "spider-roam-supervisor.service"]))) bad("invalid-systemctl");
    command("systemctl", argv, process.env, 30_000);
    return true;
  }
  if (action === "verify") {
    const verification = { piSignedIn: false, nativeSqlite: false, extensionLoaded: false, exactSession: false,
      privateModes: false, bundledIntercom: false, intercomUnique: false, legacyDrained: false, federation: false };
    const release = resolve(dirname(text("cli")), "..", ".."), pi = text("pi");
    if (!inside(npmPrefix, release) || pi !== join(npmPrefix, "bin", "pi") || !Array.isArray(request.providers) ||
        !Array.isArray(request.files) || request.files.length > 10_000) bad("invalid-request");
    const probe = join(stage, "doctor-" + randomUUID()), agent = join(probe, "agent"), isolatedRoot = join(probe, "global");
    ensurePrivate(home, probe); ensurePrivate(home, agent); ensurePrivate(home, isolatedRoot);
    const env: NodeJS.ProcessEnv = { ...process.env, PI_CODING_AGENT_DIR: agent, SPIDER_GLOBAL_ROOT: isolatedRoot,
      PI_SUBAGENT_CHILD: "1", PI_OFFLINE: "1" };
    delete env.HC_SOCKET; delete env.HC_SESSION;
    try {
      try {
        rootPath(agentDir); directory(roam, true); directory(stage, true);
        for (const file of request.files) {
          if (!file || typeof file.path !== "string" || !allowed(file.path) || (file.mode !== 0o600 && file.mode !== 0o700)) throw new Error("Unsafe file");
          const parent = parentPath(agentDir, file.path, false), found = readFile(join(parent, file.path.split("/").at(-1)!), maximum);
          if (found.mode !== file.mode) throw new Error("Unsafe file");
        }
        const auth = readPrivateBytes(agentDir, "auth.json", maximum); auth?.fill(0);
        verification.privateModes = true;
      } catch { /* Missing evidence is not readiness. */ }
      try {
        const files = [join(release, "dist", "extension.js"), join(release, "dist", "intercom", "broker.mjs")];
        verification.bundledIntercom = files.every(file => { const stat = lstatSync(file); return stat.isFile() && !stat.isSymbolicLink() && own(stat); });
      } catch { /* Missing evidence is not readiness. */ }
      const nativeScript = "import {createRequire} from 'node:module'; const r=createRequire(process.argv[1]+'/package.json'); const D=r('better-sqlite3'); const db=new D(':memory:'); try { if(db.prepare('SELECT 1 AS value').get().value!==1) process.exitCode=1; const v=r('sqlite-vec'); db.loadExtension(v.getLoadablePath()); db.exec('CREATE VIRTUAL TABLE v USING vec0(embedding float[4])'); } finally { db.close(); }";
      try { verification.nativeSqlite = spawnSync(process.execPath, ["--input-type=module", "-e", nativeScript, release],
        { cwd: probe, env, stdio: "ignore", timeout: 15_000 }).status === 0; } catch { /* Missing evidence is not readiness. */ }
      const sdk = join(npmPrefix, "lib", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "index.js");
      const extensionScript = "import {pathToFileURL} from 'node:url'; const p=await import(pathToFileURL(process.argv[1]).href); const l=new p.DefaultResourceLoader({cwd:process.argv[3],agentDir:process.argv[4],additionalExtensionPaths:[process.argv[2]],noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true}); await l.reload(); const v=l.getExtensions(); if(v.errors.length||!v.extensions.some(e=>e.tools.has('spider')))process.exitCode=1;";
      try { verification.extensionLoaded = spawnSync(process.execPath, ["--input-type=module", "-e", extensionScript, sdk,
        join(release, "dist", "extension.js"), probe, agent], { cwd: probe, env, stdio: "ignore", timeout: 20_000 }).status === 0; }
      catch { /* Missing evidence is not readiness. */ }
      try {
        const sessionId = randomUUID(), sessionFile = join(probe, "exact.jsonl");
        atomicWrite(sessionFile, Buffer.from(JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: new Date().toISOString(), cwd: probe }) + "\n"), 0o600, true);
        const child = spawnSync(pi, ["--session", sessionFile, "--mode", "rpc", "--offline", "--no-extensions", "--no-mcp", "--no-approve"],
          { cwd: probe, env, input: JSON.stringify({ id: "probe", type: "get_state" }) + "\n", encoding: "utf8", maxBuffer: 1024 * 1024, timeout: 20_000 });
        if (child.status === 0) {
          for (const line of child.stdout.split("\n")) {
            try {
              const item = JSON.parse(line);
              if (item.id === "probe" && item.type === "response" && item.command === "get_state" && item.success === true &&
                  item.data?.sessionFile === sessionFile && item.data?.sessionId === sessionId) verification.exactSession = true;
            } catch { /* Ignore non-protocol output. */ }
          }
        }
      } catch { /* Missing evidence is not readiness. */ }
      try {
        const source = readPrivateBytes(agentDir, "auth.json", maximum);
        if (source) try {
          const entries = parseAuth(source);
          for (const provider of request.providers) {
            if (typeof provider !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(provider)) continue;
            const item = entries[provider] as Record<string, unknown> | undefined;
            const stored = item && typeof item === "object" && !Array.isArray(item) &&
              (item.type === "oauth" && typeof item.access === "string" && !!item.access || item.type === "api_key" && typeof item.key === "string" && !!item.key);
            if (!stored) continue;
            let filtered: Buffer;
            try { filtered = approvedAuth(source, [provider]); } catch { continue; }
            try {
              atomicWrite(join(agent, "auth.json"), filtered, 0o600, false);
              const check = spawnSync(pi, ["auth", "check", "--provider", provider, "--no-refresh"], { cwd: probe, env, stdio: "ignore", timeout: 15_000 });
              if (check.status === 0) { verification.piSignedIn = true; break; }
            } finally { filtered.fill(0); }
          }
        } finally { source.fill(0); }
      } catch { /* Missing evidence is not readiness. */ }
      return verification;
    } finally { rmSync(probe, { recursive: true, force: true }); }
  }
  if (action === "switchover") {
    ensurePrivate(home, agentDir, false);
    const cli = text("cli"), release = resolve(dirname(cli), "..", "..");
    if (!inside(npmPrefix, release)) bad("unsafe-release");
    const switchover = await import(pathToFileURL(join(release, "scripts", "intercom-switchover.mjs")).href);
    const shimModule = await import(pathToFileURL(join(release, "scripts", "extension-shim.mjs")).href);
    const activeFile = join(roam, "active-release.json"), extensionDir = join(agentDir, "extensions"), shim = join(extensionDir, "spider.ts");
    ensurePrivate(home, extensionDir, false);
    const base = switchover.filesystemSwitchoverPorts(activeFile);
    const ports = { ...base,
      async backup(file: string, value: string) {
        if (dirname(file) !== agentDir && dirname(file) !== extensionDir) bad("unsafe-path");
        const bytes = Buffer.from(value);
        const matches = () => {
          const prior = readFile(file, maximum).bytes;
          try { if (!prior.equals(bytes)) bad("missing-switchover-backup"); } finally { prior.fill(0); }
        };
        try {
          if (exists(file)) matches();
          else try { atomicWrite(file, bytes, 0o600, true); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; matches(); }
        } finally { bytes.fill(0); }
      },
      async activeRelease() {
        const active = await base.activeRelease(), prior = readPrivateBytes(extensionDir, "spider.ts", 1024 * 1024);
        const backup = shim + "." + operationId + ".bak";
        if (prior) await base.backup(backup, prior.toString("utf8"));
        return { active, hadShim: prior !== null, backup };
      },
      async activate(value: unknown) {
        if (typeof value === "string") {
          await base.writeAtomic(shim, shimModule.extensionShim(join(value, "dist", "extension.js")));
          await base.activate(value);
        } else {
          const prior = value as { active: string | null; hadShim: boolean; backup: string };
          if (!prior || prior.backup !== shim + "." + operationId + ".bak" || typeof prior.hadShim !== "boolean") bad("invalid-switchover-journal");
          if (prior.hadShim) {
            const bytes = readPrivateBytes(extensionDir, basename(prior.backup), 1024 * 1024);
            if (!bytes) bad("missing-switchover-backup");
            await base.writeAtomic(shim, bytes.toString("utf8"));
          } else if (exists(shim)) { readPrivateBytes(extensionDir, "spider.ts", 1024 * 1024); unlinkSync(shim); }
          await base.activate(prior.active);
        }
      },
    };
    const result = await switchover.applyIntercomSwitchover({ operationId, release, settingsFiles: [join(agentDir, "settings.json")],
      journalFile: join(roam, "switchover-" + operationId + ".json"),
      legacyRoots: [join(agentDir, "npm", "node_modules", "pi-intercom"), join(agentDir, "node_modules", "pi-intercom")] }, ports);
    return { status: result.status };
  }
  bad("unknown-provision-action");
  } finally { unlock(); }
}
try { const value = await run(); process.stdout.write(JSON.stringify({ kind: "provision", version: 1, value })); }
catch (error) {
  const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" && /^[a-z0-9-]{1,64}$/.test(error.code) ? error.code : "provision-failed";
  process.stdout.write(JSON.stringify({ kind: "provision", version: 1, error: code }));
}
`;

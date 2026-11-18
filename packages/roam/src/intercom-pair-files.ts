import { randomUUID } from "node:crypto";
import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";
import { assertTestConfigPath } from "@spider/db-core";
import { withProcessLock } from "@spider/herdr/sessions/registry";
import type { IntercomEnrollmentPair } from "./provision-contracts";
import { validHostKey, validPublicKey } from "./intercom-enrollment";
import { isMachineId } from "./machine-id";
import { privateDirectory, writeImmutable } from "./staging";

const identifier = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
const own = (stat: { uid: number }): boolean => process.platform === "win32" || typeof process.getuid !== "function" || stat.uid === process.getuid();
const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === "ENOENT";
function absolute(path: string): void {
  if (typeof path !== "string" || !isAbsolute(path) || resolve(path) !== path || /[\u0000-\u001f\u007f]/.test(path)) throw new Error("intercom-unsafe-path");
}
function pathDirectories(path: string): void {
  absolute(path);
  let current = parse(path).root;
  for (const component of path.slice(current.length).split(/[\\/]+/).filter(Boolean)) {
    current = join(current, component);
    const stat = lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("intercom-unsafe-path");
  }
}
function privateFile(file: string, mode: number, maxBytes: number): Buffer {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || !own(stat) || stat.nlink !== 1 || stat.size > maxBytes ||
        process.platform !== "win32" && (stat.mode & 0o7777) !== mode) throw new Error("intercom-unsafe-file");
    return readFileSync(fd);
  } finally { closeSync(fd); }
}
function pathExists(file: string): boolean {
  try { lstatSync(file); return true; } catch (error) { if (missing(error)) return false; throw error; }
}
function pairIdentity(pair: IntercomEnrollmentPair): void {
  if (!pair || !identifier(pair.pairId) || !identifier(pair.edgeEpoch) || !pair.source || !pair.target ||
      !isMachineId(pair.source.machineId) || !isMachineId(pair.target.machineId) || pair.source.machineId >= pair.target.machineId) throw new Error("invalid-intercom-pair");
  absolute(pair.source.globalRoot); absolute(pair.target.globalRoot);
}
export function pairPaths(pair: IntercomEnrollmentPair): { directory: string; privateKey: string; publicKey: string; knownHosts: string; via: string } {
  pairIdentity(pair); assertTestConfigPath(pair.source.globalRoot);
  const directory = join(pair.source.globalRoot, "roam", "intercom", "pairs", pair.pairId, pair.edgeEpoch);
  return { directory, privateKey: join(directory, "id_ed25519"), publicKey: join(directory, "id_ed25519.pub"),
    knownHosts: join(directory, "known_hosts"), via: join(directory, "via") };
}
function publicKey(text: string): string {
  const parts = text.trim().split(/\s+/), result = `${parts[0] ?? ""} ${parts[1] ?? ""}`;
  if (!validPublicKey(result)) throw new Error("unsafe-pair-key");
  return result;
}
/** Read an existing pair public key without generating credentials during revocation. */
export function readPairPublicKey(pair: IntercomEnrollmentPair): string {
  const files = pairPaths(pair); pathDirectories(files.directory);
  const fd = openSync(files.publicKey, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || !own(stat) || stat.nlink !== 1 || stat.size > 16_384 ||
        process.platform !== "win32" && (stat.mode & 0o022) !== 0) throw new Error("unsafe-pair-key");
    return publicKey(readFileSync(fd, "utf8"));
  } finally { closeSync(fd); }
}
/** The caller supplies the executable runner after consent; the private key is never read into a reply. */
export async function ensurePairKey(pair: IntercomEnrollmentPair, options: { binary: string;
  run(binary: string, argv: readonly string[]): Promise<{ code: number; stdout: string }> }): Promise<{ publicKey: string; privateMode: number; privateOwned: boolean }> {
  const files = pairPaths(pair); absolute(options.binary);
  privateDirectory(files.directory);
  const exists = pathExists(files.privateKey), pubExists = pathExists(files.publicKey);
  if (!exists && pubExists) throw new Error("unsafe-pair-key");
  if (!exists) {
    const result = await options.run(options.binary, ["-q", "-t", "ed25519", "-N", "", "-f", files.privateKey]);
    if (result.code !== 0) throw new Error("intercom-key-generation-pending");
  }
  const stat = lstatSync(files.privateKey);
  if (!stat.isFile() || stat.isSymbolicLink() || !own(stat) || stat.nlink !== 1 || process.platform !== "win32" && (stat.mode & 0o7777) !== 0o600) {
    throw new Error("unsafe-pair-key");
  }
  if (!pathExists(files.publicKey)) {
    const result = await options.run(options.binary, ["-y", "-f", files.privateKey]);
    if (result.code !== 0) throw new Error("intercom-key-generation-pending");
    writeImmutable(files.publicKey, Buffer.from(`${publicKey(result.stdout)}\n`));
  }
  const publicStat = lstatSync(files.publicKey);
  if (!publicStat.isFile() || publicStat.isSymbolicLink() || !own(publicStat) || publicStat.nlink !== 1 || publicStat.size > 16_384 ||
      process.platform !== "win32" && (publicStat.mode & 0o022) !== 0) throw new Error("unsafe-pair-key");
  const fd = openSync(files.publicKey, constants.O_RDONLY | constants.O_NOFOLLOW);
  let text: string;
  try { text = readFileSync(fd, "utf8"); } finally { closeSync(fd); }
  return { publicKey: publicKey(text), privateMode: 0o600, privateOwned: true };
}

export function encodePairCommand(pair: Pick<IntercomEnrollmentPair, "pairId" | "edgeEpoch">, command: string): string {
  const identifier = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
  if (!pair || typeof pair.pairId !== "string" || !identifier.test(pair.pairId) || typeof pair.edgeEpoch !== "string" ||
      !identifier.test(pair.edgeEpoch) || typeof command !== "string") throw new Error("invalid-intercom-pair-command");
  const bytes = Buffer.from(command, "utf8");
  if (!bytes.length || bytes.length > 1048576 || bytes.includes(0)) throw new Error("invalid-intercom-pair-command");
  return `spider-intercom:${pair.pairId}:${pair.edgeEpoch}:${bytes.toString("base64")}`;
}

/** A new host identity requires a new edge epoch and a fresh approval, never an in-place replacement. */
export function writePairRoute(pair: IntercomEnrollmentPair, options: { node: string; ssh: string; localPort: number }): ReturnType<typeof pairPaths> {
  const files = pairPaths(pair);
  absolute(options.node); absolute(options.ssh);
  if (/\s/.test(options.node) || Buffer.byteLength(options.node) > 100 || !Number.isSafeInteger(options.localPort) || options.localPort < 1 || options.localPort > 65535 ||
      !/^[A-Za-z_][A-Za-z0-9._-]{0,62}\$?$/.test(pair.sshUser) || !/^spider-[0-9a-f]{32}$/.test(pair.hostKeyAlias) || !validHostKey(pair.hostKey)) {
    throw new Error("invalid-intercom-ssh-route");
  }
  const known = Buffer.from(`${pair.hostKeyAlias} ${pair.hostKey.type} ${pair.hostKey.base64}\n`);
  try { writeImmutable(files.knownHosts, known); } catch { throw new Error("host-key-changed"); }
  privateFile(files.knownHosts, 0o600, 16_384);
  const knownOption = /[\s"\\]/.test(files.knownHosts) ? `"${files.knownHosts.replace(/["\\]/g, "\\$&")}"` : files.knownHosts;
  const args = ["-F", "/dev/null", "-i", files.privateKey, "-o", "IdentitiesOnly=yes", "-o", "StrictHostKeyChecking=yes", "-o", `HostKeyAlias=${pair.hostKeyAlias}`,
    "-o", `UserKnownHostsFile=${knownOption}`, "-o", "GlobalKnownHostsFile=/dev/null", "-o", "BatchMode=yes", "-o", "ControlMaster=no",
    "-o", "ControlPath=none", "-p", String(options.localPort), `${pair.sshUser}@127.0.0.1`];
  const script = `#!${options.node}\n(async () => {\n  if (process.argv.length !== 3 || process.argv[2].length > 1048576) { process.exitCode = 2; return; }\n  const { spawn } = await import('node:child_process');\n  const child = spawn(${JSON.stringify(options.ssh)}, [...${JSON.stringify(args)}, (${encodePairCommand.toString()})(${JSON.stringify({ pairId: pair.pairId, edgeEpoch: pair.edgeEpoch })}, process.argv[2])], { stdio: 'inherit' });\n  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => child.kill(signal));\n  child.on('error', () => { process.exitCode = 1; });\n  child.on('exit', (code, signal) => { if (signal) { process.removeAllListeners(signal); process.kill(process.pid, signal); } else process.exitCode = code ?? 1; });\n})().catch(() => { process.exitCode = 1; });\n`;
  try { writeImmutable(files.via, Buffer.from(script)); } catch { throw new Error("intercom-route-conflict"); }
  const fd = openSync(files.via, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || !own(stat) || stat.nlink !== 1 || process.platform !== "win32" && ![0o600, 0o700].includes(stat.mode & 0o7777)) throw new Error("intercom-unsafe-file");
    if (process.platform !== "win32" && (stat.mode & 0o7777) !== 0o700) fchmodSync(fd, 0o700);
  } finally { closeSync(fd); }
  return files;
}

function sshDirectory(home: string): string {
  absolute(home); assertTestConfigPath(home); pathDirectories(home);
  const homeStat = lstatSync(home); if (!own(homeStat)) throw new Error("intercom-unsafe-home");
  const directory = join(home, ".ssh");
  try { mkdirSync(directory, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || !own(stat) || process.platform !== "win32" && (stat.mode & 0o7777) !== 0o700) throw new Error("intercom-unsafe-home");
  return directory;
}
function pairCommandPath(pair: IntercomEnrollmentPair): string {
  return join(pair.target.globalRoot, "roam", "intercom", "pairs", pair.pairId, pair.edgeEpoch, "command.mjs");
}
const shellQuote = (text: string): string => `'${text.replace(/'/g, "'\\''")}'`;
export function authorizedPairLine(pair: IntercomEnrollmentPair, pub: string): string {
  pairIdentity(pair); absolute(pair.target.node); if (!validPublicKey(pub)) throw new Error("unsafe-pair-key");
  const command = `${shellQuote(pair.target.node)} ${shellQuote(pairCommandPath(pair))}`.replace(/["\\]/g, "\\$&");
  return `from="127.0.0.1",restrict,command="${command}" ${pub} spider-intercom:${pair.pairId}`;
}
function writePairCommand(pair: IntercomEnrollmentPair): void {
  const file = pairCommandPath(pair), registry = join(pair.target.globalRoot, "roam", "intercom", "enrollments", `${pair.pairId}.json`);
  assertTestConfigPath(file); privateDirectory(dirname(file));
  for (const name of readdirSync(dirname(file))) {
    if (!/^\.command\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.new(?:\.part)?$/.test(name)) continue;
    const abandoned = join(dirname(file), name);
    privateFile(abandoned, 0o600, 32 * 1024); unlinkSync(abandoned);
  }
  const script = (commandFence: string) => `import { constants, openSync, fstatSync, readFileSync, closeSync, realpathSync } from 'node:fs';
import { spawn } from 'node:child_process';
const fail = () => { process.exitCode = 126; };
try {
  const prefix = ${JSON.stringify(`spider-intercom:${pair.pairId}:${pair.edgeEpoch}:`)}, original = process.env.SSH_ORIGINAL_COMMAND ?? '';
  if (!original.startsWith(prefix) || original.length > 1500000) throw new Error();
  const encoded = original.slice(prefix.length), command = Buffer.from(encoded, 'base64');
  if (!command.length || command.length > 1048576 || command.toString('base64') !== encoded || command.includes(0)) throw new Error();
  const file = ${JSON.stringify(registry)};
  if (realpathSync(file) !== file) throw new Error();
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  let record;
  try { const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 1048576 || stat.uid !== process.getuid() || (stat.mode & 0o7777) !== 0o600) throw new Error();
    record = JSON.parse(readFileSync(fd, 'utf8'));
  } finally { closeSync(fd); }
  if (!['pending','active'].includes(record.state) || ${commandFence} || record.pair?.pairId !== ${JSON.stringify(pair.pairId)} || record.pair?.edgeEpoch !== ${JSON.stringify(pair.edgeEpoch)} ||
      record.pair?.source?.machineId !== ${JSON.stringify(pair.source.machineId)} || record.pair?.target?.machineId !== ${JSON.stringify(pair.target.machineId)}) throw new Error();
  const child = spawn('/bin/sh', ['-c', command.toString('utf8')], { stdio: 'inherit' });
  for (const signal of ['SIGINT','SIGTERM','SIGHUP']) process.on(signal, () => child.kill(signal));
  child.on('error', fail); child.on('exit', code => { process.exitCode = code ?? 1; });
} catch { fail(); }
`;
  const bytes = Buffer.from(script("record.fenceId !== null && !(record.state === 'pending' && typeof record.fenceId === 'string' && record.fenceId.length > 0 && record.commandApprovalFenceId === record.fenceId)"));
  const legacy = Buffer.from(script("record.fenceId !== null"));
  if (pathExists(file) && privateFile(file, 0o600, 32 * 1024).equals(legacy)) {
    const temp = join(dirname(file), `.command.${randomUUID()}.new`);
    try {
      writeImmutable(temp, bytes);
      if (!privateFile(file, 0o600, 32 * 1024).equals(legacy)) throw new Error("intercom-pair-command-changed");
      renameSync(temp, file);
      if (process.platform !== "win32") { const dir = openSync(dirname(file), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); try { fsyncSync(dir); } finally { closeSync(dir); } }
    } finally { try { unlinkSync(temp); } catch (error) { if (!missing(error)) throw error; } }
  }
  writeImmutable(file, bytes); privateFile(file, 0o600, 32 * 1024);
}
async function editAuthorization(home: string, pair: IntercomEnrollmentPair, pub: string, remove: boolean): Promise<void> {
  const line = authorizedPairLine(pair, pub), root = pair.target.globalRoot;
  assertTestConfigPath(root); absolute(root);
  await withProcessLock(join(root, "roam", "intercom"), "authorized-keys", async () => {
    const directory = sshDirectory(home), file = join(directory, "authorized_keys"), existed = pathExists(file);
    const old = existed ? privateFile(file, 0o600, 1024 * 1024).toString("utf8") : "";
    const rows = old.match(/[^\n]*\n|[^\n]+$/g) ?? [], marker = `spider-intercom:${pair.pairId}`;
    if (rows.some(row => row.replace(/\r?\n$/, "").endsWith(` ${marker}`) && row.replace(/\r?\n$/, "") !== line)) throw new Error("intercom-authorized-key-conflict");
    const match = rows.some(row => row.replace(/\r?\n$/, "") === line);
    if (!remove) writePairCommand(pair);
    if (remove && !match || !remove && match) return;
    const next = remove ? rows.filter(row => row.replace(/\r?\n$/, "") !== line).join("") : `${old}${old && !old.endsWith("\n") ? "\n" : ""}${line}\n`;
    const temp = join(directory, `.authorized_keys.${randomUUID()}.new`);
    const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(fd, next); fsyncSync(fd); } finally { closeSync(fd); }
    try {
      if (existed !== pathExists(file) || existed && privateFile(file, 0o600, 1024 * 1024).toString("utf8") !== old) throw new Error("intercom-authorized-keys-changed");
      renameSync(temp, file);
      if (process.platform !== "win32") { const dir = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); try { fsyncSync(dir); } finally { closeSync(dir); } }
    } finally { try { unlinkSync(temp); } catch (error) { if (!missing(error)) throw error; } }
  });
}
/** A read-only absence check preserves unrelated authorizations and rejects unsafe files. */
export function pairKeyAbsent(home: string, pair: IntercomEnrollmentPair, pub: string): boolean {
  const line = authorizedPairLine(pair, pub), directory = join(home, ".ssh");
  absolute(home); assertTestConfigPath(home); pathDirectories(home);
  try {
    pathDirectories(directory);
    const info = lstatSync(directory); if (!own(info) || (info.mode & 0o7777) !== 0o700) throw new Error("intercom-unsafe-home");
    const contents = privateFile(join(directory, "authorized_keys"), 0o600, 1024 * 1024).toString("utf8");
    const rows = contents.split(/\r?\n/), marker = ` spider-intercom:${pair.pairId}`;
    if (rows.some(row => row.endsWith(marker) && row !== line)) throw new Error("intercom-authorized-key-conflict");
    return !rows.includes(line);
  } catch (error) { if (missing(error)) return true; throw error; }
}
export async function authorizePairKey(home: string, pair: IntercomEnrollmentPair, pub: string): Promise<void> {
  pairIdentity(pair); await editAuthorization(home, pair, pub, false);
}
export async function removePairKey(home: string, pair: IntercomEnrollmentPair, pub: string): Promise<void> { await editAuthorization(home, pair, pub, true); }

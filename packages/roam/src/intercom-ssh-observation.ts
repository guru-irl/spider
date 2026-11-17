import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { validHostKey } from "./intercom-enrollment";
import { isMachineId } from "./machine-id";
import type { IntercomSshHostKey } from "./provision-contracts";

const unavailable = (): never => { throw new Error("intercom-ssh-host-unavailable"); };
const preference = ["ssh-ed25519", "ecdsa-sha2-nistp256", "ecdsa-sha2-nistp384", "ecdsa-sha2-nistp521", "ssh-rsa"] as const;
type FileStat = { uid: number; mode: number; size: number; nlink: number; isDirectory(): boolean; isSymbolicLink(): boolean; isFile(): boolean };
export interface SystemSshFileSystem {
  lstat(path: string): FileStat;
  open(path: string, flags: number): number;
  fstat(fd: number): FileStat;
  read(fd: number): string;
  close(fd: number): void;
}
const systemFiles: SystemSshFileSystem = { lstat: lstatSync, open: openSync, fstat: fstatSync,
  read: fd => readFileSync(fd, "utf8"), close: closeSync };
function verifiedSystemKeys(keys: ReadonlyMap<string, IntercomSshHostKey>, files: SystemSshFileSystem): IntercomSshHostKey[] {
  try {
    const directory = files.lstat("/etc/ssh");
    if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== 0 || (directory.mode & 0o022) !== 0) return [];
  } catch { return []; }
  return preference.flatMap(type => {
    const key = keys.get(type); if (!key) return [];
    const kind = type === "ssh-ed25519" ? "ed25519" : type === "ssh-rsa" ? "rsa" : "ecdsa";
    try {
      const fd = files.open(`/etc/ssh/ssh_host_${kind}_key.pub`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const stat = files.fstat(fd);
        if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== 0 || (stat.mode & 0o022) !== 0 || stat.size > 16_384) return [];
        const text = files.read(fd); if (Buffer.byteLength(text) > 16_384) return [];
        const match = /^(\S+) ([A-Za-z0-9+/]+={0,2})(?: [^\r\n]*)?\r?\n?$/.exec(text);
        return match && match[1] === key.type && match[2] === key.base64 ? [key] : [];
      } finally { files.close(fd); }
    } catch { return []; }
  });
}
/** The hub must call this on the already UUID- and core-fenced destination machine. */
export async function inspectServedSshIdentity(options: { machineId: string; sshUser: string; keyscan: string; sshPort: number; filesystem?: SystemSshFileSystem;
  run(argv: readonly string[], options: { timeoutMs: number; maxBytes: number }): Promise<{ code: number; stdout: string }> }):
  Promise<{ targetMachineId: string; sshUser: string; hostKey: IntercomSshHostKey }> {
  if (!isMachineId(options.machineId) || !/^[A-Za-z_][A-Za-z0-9._-]{0,62}\$?$/.test(options.sshUser) ||
      !isAbsolute(options.keyscan) || resolve(options.keyscan) !== options.keyscan || /[\u0000-\u001f\u007f]/.test(options.keyscan) ||
      !Number.isSafeInteger(options.sshPort) || options.sshPort < 1 || options.sshPort > 65535) return unavailable();
  try {
    const result = await options.run([options.keyscan, "-T", "5", "-t", "ed25519,ecdsa,rsa", "-p", String(options.sshPort), "127.0.0.1"],
      { timeoutMs: 10_000, maxBytes: 64 * 1024 });
    if (result.code !== 0 || typeof result.stdout !== "string" || Buffer.byteLength(result.stdout) > 64 * 1024 || !result.stdout) return unavailable();
    // OpenSSH put_host_port omits the default SSH port from known-hosts output.
    const host = options.sshPort === 22 ? "127.0.0.1" : `[127.0.0.1]:${options.sshPort}`;
    const keys = new Map<string, IntercomSshHostKey>();
    for (const line of result.stdout.replace(/\r?\n$/, "").split(/\r?\n/)) {
      if (/^# \S+:\d+ /.test(line)) continue;
      const match = /^(\S+) (\S+) ([A-Za-z0-9+/]+={0,2})$/.exec(line);
      if (!match || match[1] !== host) return unavailable();
      const hostKey = { type: match[2], base64: match[3] };
      if (!validHostKey(hostKey) || keys.has(hostKey.type)) return unavailable();
      keys.set(hostKey.type, hostKey);
    }
    if (!keys.size) return unavailable();
    const [hostKey] = verifiedSystemKeys(keys, options.filesystem ?? systemFiles);
    if (!hostKey) throw new Error("intercom-ssh-host-unverified");
    return { targetMachineId: options.machineId, sshUser: options.sshUser, hostKey };
  } catch (error) {
    if (error instanceof Error && error.message === "intercom-ssh-host-unverified") throw error;
    return unavailable();
  }
}
export function compareSshHostKey(pinned: IntercomSshHostKey, observed: IntercomSshHostKey): "match" | "host-key-changed" {
  if (!validHostKey(pinned) || !validHostKey(observed)) throw new Error("intercom-ssh-host-unavailable");
  return pinned.type === observed.type && pinned.base64 === observed.base64 ? "match" : "host-key-changed";
}

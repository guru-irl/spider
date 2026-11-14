import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { isAbsolute, join, parse, resolve } from "node:path";
import { assertTestConfigPath } from "@spider/db-core";
import { validHostKey } from "./intercom-enrollment";
import { isMachineId } from "./machine-id";
import type { IntercomSshHostKey } from "./provision-contracts";

const unavailable = (): never => { throw new Error("intercom-ssh-host-unavailable"); };
function publicFile(path: string): string {
  if (!isAbsolute(path) || resolve(path) !== path || /[\u0000-\u001f\u007f]/.test(path)) return unavailable();
  assertTestConfigPath(path);
  let current = parse(path).root;
  const components = path.slice(current.length).split(/[\\/]+/).filter(Boolean);
  for (const component of components.slice(0, -1)) {
    current = join(current, component);
    const stat = lstatSync(current); if (!stat.isDirectory() || stat.isSymbolicLink()) return unavailable();
  }
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd), uid = process.getuid?.();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 16_384 ||
        process.platform !== "win32" && ((uid !== undefined && stat.uid !== uid && stat.uid !== 0) || (stat.mode & 0o022) !== 0)) return unavailable();
    return readFileSync(fd, "utf8");
  } finally { closeSync(fd); }
}
/** The hub must call this on the already UUID- and core-fenced destination machine. */
export async function inspectServedSshIdentity(options: { machineId: string; sshUser: string; sshd: string;
  run(argv: readonly string[], options: { timeoutMs: number; maxBytes: number }): Promise<{ code: number; stdout: string }> }):
  Promise<{ targetMachineId: string; sshUser: string; hostKey: IntercomSshHostKey }> {
  if (!isMachineId(options.machineId) || !/^[A-Za-z_][A-Za-z0-9._-]{0,62}\$?$/.test(options.sshUser) ||
      !isAbsolute(options.sshd) || resolve(options.sshd) !== options.sshd || /[\u0000-\u001f\u007f]/.test(options.sshd)) return unavailable();
  try {
    const result = await options.run([options.sshd, "-T"], { timeoutMs: 5000, maxBytes: 64 * 1024 });
    if (result.code !== 0 || typeof result.stdout !== "string" || Buffer.byteLength(result.stdout) > 64 * 1024) return unavailable();
    const candidates = result.stdout.split(/\r?\n/).flatMap(line => {
      const match = /^hostkey\s+(\S+)$/i.exec(line.trim()); return match ? [match[1]] : [];
    });
    candidates.sort((a, b) => Number(/ed25519/i.test(b)) - Number(/ed25519/i.test(a)));
    const selected = candidates[0]; if (!selected || !isAbsolute(selected) || resolve(selected) !== selected) return unavailable();
    const parts = publicFile(`${selected}.pub`).trim().split(/\s+/), hostKey = { type: parts[0] ?? "", base64: parts[1] ?? "" };
    if (!validHostKey(hostKey)) return unavailable();
    return { targetMachineId: options.machineId, sshUser: options.sshUser, hostKey };
  } catch { return unavailable(); }
}
export function compareSshHostKey(pinned: IntercomSshHostKey, observed: IntercomSshHostKey): "match" | "host-key-changed" {
  if (!validHostKey(pinned) || !validHostKey(observed)) throw new Error("intercom-ssh-host-unavailable");
  return pinned.type === observed.type && pinned.base64 === observed.base64 ? "match" : "host-key-changed";
}

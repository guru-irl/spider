import { isAbsolute, resolve } from "node:path";
import { validHostKey } from "./intercom-enrollment";
import { isMachineId } from "./machine-id";
import type { IntercomSshHostKey } from "./provision-contracts";

const unavailable = (): never => { throw new Error("intercom-ssh-host-unavailable"); };
const preference = ["ssh-ed25519", "ecdsa-sha2-nistp256", "ecdsa-sha2-nistp384", "ecdsa-sha2-nistp521", "ssh-rsa"] as const;
/** The hub must call this on the already UUID- and core-fenced destination machine. */
export async function inspectServedSshIdentity(options: { machineId: string; sshUser: string; keyscan: string; sshPort: number;
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
    const hostKey = preference.map(type => keys.get(type)).find(key => key !== undefined);
    if (!hostKey) return unavailable();
    return { targetMachineId: options.machineId, sshUser: options.sshUser, hostKey };
  } catch { return unavailable(); }
}
export function compareSshHostKey(pinned: IntercomSshHostKey, observed: IntercomSshHostKey): "match" | "host-key-changed" {
  if (!validHostKey(pinned) || !validHostKey(observed)) throw new Error("intercom-ssh-host-unavailable");
  return pinned.type === observed.type && pinned.base64 === observed.base64 ? "match" : "host-key-changed";
}

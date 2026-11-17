import { closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { IntercomSshHostKey } from "../provision-contracts";
import type { SystemSshFileSystem } from "../intercom-ssh-observation";

/** Map the system directory to owned fixture files while simulating root ownership. */
export function systemSshFixture(root: string, keys: readonly IntercomSshHostKey[]): {
  filesystem: SystemSshFileSystem; directory: string; directoryUid(value: number): void; fileUid(value: number): void;
} {
  const directory = join(root, "system-ssh"); mkdirSync(directory, { mode: 0o755 });
  for (const key of keys) {
    const kind = key.type === "ssh-ed25519" ? "ed25519" : key.type === "ssh-rsa" ? "rsa" : "ecdsa";
    writeFileSync(join(directory, `ssh_host_${kind}_key.pub`), `${key.type} ${key.base64} fixture\n`, { mode: 0o644 });
  }
  let directoryUid = 0, fileUid = 0;
  const filesystem = {
    lstat(path: string) {
      if (path !== "/etc/ssh") throw new Error("unexpected system SSH directory");
      const stat = lstatSync(directory); stat.uid = directoryUid; return stat;
    },
    open(path: string, flags: number) {
      if (!/^\/etc\/ssh\/ssh_host_(ed25519|ecdsa|rsa)_key\.pub$/.test(path)) throw new Error("unexpected system SSH file");
      return openSync(join(directory, basename(path)), flags);
    },
    fstat(fd: number) { const stat = fstatSync(fd); stat.uid = fileUid; return stat; },
    read(fd: number) { return readFileSync(fd, "utf8"); },
    close: closeSync,
  };
  return { filesystem, directory, directoryUid(value: number) { directoryUid = value; }, fileUid(value: number) { fileUid = value; } };
}

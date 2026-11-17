import { afterEach, expect, it } from "vitest";
import { chmodSync, linkSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { paths } from "@spider/db-core";
import { inspectServedSshIdentity } from "../intercom-ssh-observation";
import { systemSshFixture } from "./intercom-ssh-system-fixture";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const key = (n: number) => ({ type: "ssh-ed25519", base64: Buffer.concat([
  Buffer.from([0, 0, 0, 11]), Buffer.from("ssh-ed25519"), Buffer.from([0, 0, 0, 32]), Buffer.alloc(32, n),
]).toString("base64") });
function fixture(system: number, served: number) {
  const root = mkdtempSync(join(paths.scratch("worktree", process.cwd()), "system-ssh-")); roots.push(root);
  const files = systemSshFixture(root, [key(system)]), presented = key(served);
  return { ...files, options: { machineId: "00000000-0000-4000-8000-000000000002", sshUser: "fixture", keyscan: "/fixture/ssh-keyscan", sshPort: 2222,
    filesystem: files.filesystem, run: async () => ({ code: 0, stdout: `[127.0.0.1]:2222 ${presented.type} ${presented.base64}\n` }) } };
}

it("pins a presented system host key but refuses another listener's key", async () => {
  const trusted = fixture(7, 7), other = fixture(7, 8);
  expect((await inspectServedSshIdentity(trusted.options)).hostKey).toEqual(key(7));
  await expect(inspectServedSshIdentity(other.options)).rejects.toThrow("intercom-ssh-host-unverified");
});

it.each(["directory owner", "directory mode", "file owner", "file mode", "symlink", "hardlink", "oversized"])(
  "does not trust an unsafe system host key: %s", async issue => {
    const f = fixture(7, 7), file = join(f.directory, "ssh_host_ed25519_key.pub");
    if (issue === "directory owner") f.directoryUid(1000);
    if (issue === "directory mode") chmodSync(f.directory, 0o777);
    if (issue === "file owner") f.fileUid(1000);
    if (issue === "file mode") chmodSync(file, 0o666);
    if (issue === "symlink") { const target = `${file}.target`; writeFileSync(target, `ssh-ed25519 ${key(7).base64}\n`); unlinkSync(file); symlinkSync(target, file); }
    if (issue === "hardlink") linkSync(file, `${file}.link`);
    if (issue === "oversized") writeFileSync(file, `ssh-ed25519 ${key(7).base64} ${"x".repeat(17000)}\n`);
    await expect(inspectServedSshIdentity(f.options)).rejects.toThrow("intercom-ssh-host-unverified");
  },
);

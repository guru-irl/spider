import { paths } from "@spider/db-core";
import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const B = "00000000-0000-4000-8000-000000000002";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true }); });
const key = (n: number) => {
  const bytes = Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from("ssh-ed25519"), Buffer.from([0, 0, 0, 32]), Buffer.alloc(32, n)]);
  return { type: "ssh-ed25519", base64: bytes.toString("base64") };
};
async function api() { return await import("../intercom-ssh-observation").catch(() => ({})) as typeof import("../intercom-ssh-observation"); }
function fixture() {
  const root = mkdtempSync(join(paths.scratch("worktree", process.cwd()), "sshd-observe-")); roots.push(root);
  const first = join(root, "ssh_host_other_key"), preferred = join(root, "ssh_host_ed25519_key");
  writeFileSync(`${first}.pub`, `ssh-ed25519 ${key(8).base64} comment\n`, { mode: 0o644 });
  writeFileSync(`${preferred}.pub`, `ssh-ed25519 ${key(7).base64} comment\n`, { mode: 0o644 });
  const calls: string[][] = [];
  const run = async (argv: readonly string[]) => { calls.push([...argv]); return { code: 0, stdout: `hostkey ${first}\nhostkey ${preferred}\n` }; };
  return { root, first, preferred, calls, run };
}

it("selects the ed25519 key from the effective sshd configuration through an argv-only probe", async () => {
  const f = fixture(), mod = await api(); expect(mod.inspectServedSshIdentity).toBeTypeOf("function");
  expect(await mod.inspectServedSshIdentity({ machineId: B, sshUser: "fixture", sshd: "/fixture/sshd", run: f.run })).toEqual({
    targetMachineId: B, sshUser: "fixture", hostKey: key(7),
  });
  expect(f.calls).toEqual([["/fixture/sshd", "-T"]]);
}, 5000);

it("refuses an unsafe or missing host public key instead of guessing", async () => {
  const f = fixture(), mod = await api(); expect(mod.inspectServedSshIdentity).toBeTypeOf("function");
  rmSync(`${f.preferred}.pub`); symlinkSync(`${f.first}.pub`, `${f.preferred}.pub`);
  await expect(mod.inspectServedSshIdentity({ machineId: B, sshUser: "fixture", sshd: "/fixture/sshd", run: f.run })).rejects.toThrow("intercom-ssh-host-unavailable");
  await expect(mod.inspectServedSshIdentity({ machineId: B, sshUser: "-bad", sshd: "/fixture/sshd", run: f.run })).rejects.toThrow("intercom-ssh-host-unavailable");
}, 5000);

it("a changed SSH host key is named and never treated as an automatic repair", async () => {
  const mod = await api(); expect(mod.compareSshHostKey).toBeTypeOf("function");
  expect(mod.compareSshHostKey(key(7), key(7))).toBe("match");
  expect(mod.compareSshHostKey(key(7), key(8))).toBe("host-key-changed");
}, 5000);

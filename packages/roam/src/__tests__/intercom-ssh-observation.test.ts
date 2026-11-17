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

it("pins the served key when the unprivileged sshd configuration probe cannot read host keys", async () => {
  const mod = await api();
  const run = async (argv: readonly string[], _options: { timeoutMs: number; maxBytes: number }) => {
    if (JSON.stringify(argv) === JSON.stringify(["/fixture/sshd", "-T"])) return { code: 1, stdout: "" };
    if (JSON.stringify(argv) === JSON.stringify(["/fixture/ssh-keyscan", "-T", "5", "-t", "ed25519,ecdsa,rsa", "-p", "2222", "127.0.0.1"])) {
      return { code: 0, stdout: `[127.0.0.1]:2222 ssh-ed25519 ${key(7).base64}\n` };
    }
    throw new Error("unexpected fixture command");
  };
  await expect(run(["/fixture/ssh-keyscan", "-p", "2223"], { timeoutMs: 5000, maxBytes: 65536 })).rejects.toThrow("unexpected fixture command");
  const options = { machineId: B, sshUser: "fixture", sshd: "/fixture/sshd", keyscan: "/fixture/ssh-keyscan", sshPort: 2222, run };
  expect(await mod.inspectServedSshIdentity(options)).toEqual({ targetMachineId: B, sshUser: "fixture", hostKey: key(7) });
}, 5000);

it("a changed SSH host key is named and never treated as an automatic repair", async () => {
  const mod = await api(); expect(mod.compareSshHostKey).toBeTypeOf("function");
  expect(mod.compareSshHostKey(key(7), key(7))).toBe("match");
  expect(mod.compareSshHostKey(key(7), key(8))).toBe("host-key-changed");
}, 5000);

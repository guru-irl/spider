import { createECDH } from "node:crypto";
import { expect, it } from "vitest";
import { compareSshHostKey, inspectServedSshIdentity } from "../intercom-ssh-observation";

const B = "00000000-0000-4000-8000-000000000002";
const sshString = (value: Buffer) => { const length = Buffer.alloc(4); length.writeUInt32BE(value.length); return Buffer.concat([length, value]); };
const key = (n: number, type = "ssh-ed25519") => {
  let fields: Buffer[];
  if (type === "ssh-ed25519") fields = [Buffer.alloc(32, n)];
  else if (type === "ssh-rsa") fields = [Buffer.from([1, 0, 1]), Buffer.concat([Buffer.from([0]), Buffer.alloc(256, n | 0x81)])];
  else {
    const curve = type.slice("ecdsa-sha2-".length), ecdh = createECDH(curve === "nistp256" ? "prime256v1" : curve === "nistp384" ? "secp384r1" : "secp521r1");
    ecdh.setPrivateKey(Buffer.from([n])); fields = [Buffer.from(curve), ecdh.getPublicKey()];
  }
  return { type, base64: Buffer.concat([sshString(Buffer.from(type)), ...fields.map(sshString)]).toString("base64") };
};
const line = (value: ReturnType<typeof key>, port = 2222) => `[127.0.0.1]:${port} ${value.type} ${value.base64}`;
const argv = ["/fixture/ssh-keyscan", "-T", "5", "-t", "ed25519,ecdsa,rsa", "-p", "2222", "127.0.0.1"];
const options = (run: (args: readonly string[], options: { timeoutMs: number; maxBytes: number }) => Promise<{ code: number; stdout: string }>) =>
  ({ machineId: B, sshUser: "fixture", keyscan: "/fixture/ssh-keyscan", sshPort: 2222, run });

it("pins the served key when the unprivileged sshd configuration probe cannot read host keys", async () => {
  const run = async (args: readonly string[], bounds: { timeoutMs: number; maxBytes: number }) => {
    if (JSON.stringify(args) === JSON.stringify(["/fixture/sshd", "-T"])) return { code: 1, stdout: "" };
    if (JSON.stringify(args) === JSON.stringify(argv) && bounds.timeoutMs <= 10000 && bounds.maxBytes <= 65536) return { code: 0, stdout: `${line(key(7))}\n` };
    throw new Error("unexpected fixture command");
  };
  await expect(run(["/fixture/ssh-keyscan", "-p", "2223"], { timeoutMs: 5000, maxBytes: 65536 })).rejects.toThrow("unexpected fixture command");
  expect(await inspectServedSshIdentity(options(run))).toEqual({ targetMachineId: B, sshUser: "fixture", hostKey: key(7) });
}, 5000);

it.each([
  ["older OpenSSH", `${line(key(7))}\n`],
  ["OpenSSH 9.8 and later", `# 127.0.0.1:2222 SSH-2.0-OpenSSH_9.8\n${line(key(7))}\n# 127.0.0.1:2222 SSH-2.0-OpenSSH_9.8\n# 127.0.0.1:2222 SSH-2.0-OpenSSH_9.8\n`],
])("accepts %s keyscan stdout", async (_version, stdout) => {
  expect((await inspectServedSshIdentity(options(async () => ({ code: 0, stdout })))).hostKey).toEqual(key(7));
});

it("selects ed25519, then ecdsa, then rsa regardless of scan order", async () => {
  const ed = key(7), ec = key(8, "ecdsa-sha2-nistp256"), rsa = key(9, "ssh-rsa");
  for (const [lines, expected] of [
    [[line(rsa), line(ec), line(ed)], ed],
    [[line(rsa), line(ec)], ec],
    [[line(rsa)], rsa],
  ] as const) {
    const run = async (args: readonly string[]) => {
      if (JSON.stringify(args) !== JSON.stringify(argv)) throw new Error("unexpected fixture command");
      return { code: 0, stdout: `${lines.join("\n")}\n` };
    };
    expect(await inspectServedSshIdentity(options(run))).toEqual({ targetMachineId: B, sshUser: "fixture", hostKey: expected });
  }
  const ec384 = key(10, "ecdsa-sha2-nistp384");
  for (const lines of [[line(ec384), line(ec)], [line(ec), line(ec384)]]) {
    expect((await inspectServedSshIdentity(options(async () => ({ code: 0, stdout: lines.join("\n") })))).hostKey).toEqual(ec);
  }
}, 5000);

it("accepts only the host fields emitted by OpenSSH for the configured port", async () => {
  const ed = key(7);
  const scan = (sshPort: number, host: string) => inspectServedSshIdentity({ ...options(async args => {
    const expected = ["/fixture/ssh-keyscan", "-T", "5", "-t", "ed25519,ecdsa,rsa", "-p", String(sshPort), "127.0.0.1"];
    if (JSON.stringify(args) !== JSON.stringify(expected)) throw new Error("unexpected fixture command");
    return { code: 0, stdout: `${host} ${ed.type} ${ed.base64}\n` };
  }), sshPort });
  expect((await scan(22, "127.0.0.1")).hostKey).toEqual(ed);
  await expect(scan(22, "[127.0.0.1]:22")).rejects.toThrow("intercom-ssh-host-unavailable");
  await expect(scan(2222, "127.0.0.1")).rejects.toThrow("intercom-ssh-host-unavailable");
  await expect(scan(2222, "[127.0.0.1]:2223")).rejects.toThrow("intercom-ssh-host-unavailable");
}, 5000);

it.each([
  ["empty", ""],
  ["wrong host", line(key(7), 2223)],
  ["unknown type", `[127.0.0.1]:2222 ssh-dss ${key(7).base64}`],
  ["invalid base64", "[127.0.0.1]:2222 ssh-ed25519 !!!"],
  ["wrong key blob type", `[127.0.0.1]:2222 ssh-rsa ${key(7).base64}`],
  ["extra fields", `${line(key(7))} comment`],
  ["malformed mixed line", `${line(key(7))}\nnot a key`],
  ["duplicate type", `${line(key(7))}\n${line(key(8))}`],
  ["duplicate identical key", `${line(key(7))}\n${line(key(7))}`],
  ["duplicate rsa type", `${line(key(7, "ssh-rsa"))}\n${line(key(8, "ssh-rsa"))}`],
  ["duplicate ecdsa type", `${line(key(7, "ecdsa-sha2-nistp256"))}\n${line(key(8, "ecdsa-sha2-nistp256"))}`],
  ["blank line", `${line(key(7))}\n\n${line(key(8, "ssh-rsa"))}`],
  ["oversized", "x".repeat(65537)],
])("rejects %s scan output", async (_label, stdout) => {
  await expect(inspectServedSshIdentity(options(async () => ({ code: 0, stdout })))).rejects.toThrow("intercom-ssh-host-unavailable");
}, 5000);

it("rejects a failed or timed out scan and invalid identity inputs", async () => {
  await expect(inspectServedSshIdentity(options(async () => ({ code: 1, stdout: line(key(7)) })))).rejects.toThrow("intercom-ssh-host-unavailable");
  await expect(inspectServedSshIdentity(options(async () => { throw new Error("intercom-command-timeout"); }))).rejects.toThrow("intercom-ssh-host-unavailable");
  const valid = options(async () => ({ code: 0, stdout: line(key(7)) }));
  await expect(inspectServedSshIdentity({ ...valid, sshUser: "-bad" })).rejects.toThrow("intercom-ssh-host-unavailable");
  await expect(inspectServedSshIdentity({ ...valid, keyscan: "relative" })).rejects.toThrow("intercom-ssh-host-unavailable");
  await expect(inspectServedSshIdentity({ ...valid, sshPort: 0 })).rejects.toThrow("intercom-ssh-host-unavailable");
}, 5000);

it("a changed SSH host key is named and never treated as an automatic repair", () => {
  expect(compareSshHostKey(key(7), key(7))).toBe("match");
  expect(compareSshHostKey(key(7), key(8))).toBe("host-key-changed");
}, 5000);

import { afterEach, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { paths } from "@spider/db-core";
import { createIntercomRegistry } from "../intercom-registry";
import { revokeIntercomPair } from "../intercom-enrollment";

const A = "00000000-0000-4000-8000-000000000001", B = "00000000-0000-4000-8000-000000000002", TOKEN = "00000000-0000-4000-8000-000000000003";
const roots: string[] = []; afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
async function fixture(offline = false) {
  const root = mkdtempSync(join(paths.scratch("worktree", process.cwd()), "icrevoke-prod-")); roots.push(root); mkdirSync(join(root, "roam"), { mode: 0o700 });
  const peer = (machineId: string, alias: string, globalRoot: string) => ({ machineId, alias, node: "/fixture/node", pi: "/fixture/pi", cli: "/fixture/cli", core: "/fixture/hc", globalRoot });
  const blob = Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from("ssh-ed25519"), Buffer.from([0, 0, 0, 32]), Buffer.alloc(32, 7)]);
  const pair = { pairId: "pair-1", source: peer(A, "box-a.invalid", root), target: peer(B, "box-b.invalid", "/fixture/remote"), edgeEpoch: "edge-1",
    connector: { tunnelId: "tunnel", remotePort: 22, session: "default" }, sshUser: "fixture", hostKey: { type: "ssh-ed25519", base64: blob.toString("base64") }, hostKeyAlias: `spider-${"a".repeat(32)}` };
  const registry = createIntercomRegistry(root); await registry.register(pair, "enroll-1", "a".repeat(64)); await registry.bind(pair, "enroll-1"); await registry.activate("pair-1", "enroll-1");
  const calls: string[] = [], publicKey = `ssh-ed25519 ${blob.toString("base64")}`;
  const transport = { async pinIntercomPeer(machine: typeof pair.target) { calls.push("pin-remote"); if (offline) throw new Error("offline"); return { handle: machine, machineId: machine.machineId, coreId: "remote-core" }; },
    transport: { async exec(machine: typeof pair.target, argv: readonly string[], options: { stdin: Buffer }) {
      const value = JSON.parse(options.stdin.toString()), command = argv[2]; calls.push(`${command}:${value.action}`);
      if (command === "revoke-local") return Buffer.from(JSON.stringify({ version: 1, kind: "intercom-revoke", ok: true,
        value: { machineId: B, peer: A, edgeEpoch: "edge-1", fenceId: TOKEN, exchanges: "closed", inFlight: 0 } }));
      return Buffer.from(JSON.stringify({ version: 1, kind: "intercom-cleanup", ok: true, machineId: B, value: { removed: true } }));
    } } };
  const { createProductionIntercomRevocationPorts } = await import("../intercom-production");
  const ports = createProductionIntercomRevocationPorts({ root, localMachineId: A, transport: transport as never,
    async localCore() { calls.push("pin-local"); return "local-core"; },
    async fenceLocal(value) { calls.push("fence-local"); return { machineId: A, peer: B, edgeEpoch: "edge-1", fenceId: TOKEN, exchanges: "closed", inFlight: 0 }; },
    async cleanupLocal(value) { calls.push(`cleanup:${value.action}`); if (value.action === "read-public") return { publicKey }; throw new Error("unexpected local cleanup"); },
    async notify() {} });
  return { root, pair, registry, calls, ports, transport, publicKey };
}

it("fences locally but does not remove a key or route without B's host closure proof", async () => {
  const f = await fixture();
  expect(await revokeIntercomPair("pair-1", f.ports)).toMatchObject({ code: 3, reason: "intercom-revocation-unconfirmed" });
  expect(f.calls[0]).toBe("fence-local");
  expect(f.calls.some(call => call.includes("remove-authorized"))).toBe(false);
  expect(await f.registry.get("pair-1")).toMatchObject({ state: "revoked", fenceId: TOKEN, cleanupReason: "intercom-revocation-unconfirmed" });
  const { runLocalDoctor } = await import("../local-diagnostics"), report = await runLocalDoctor({ root: f.root });
  expect(report.diagnostics).toContainEqual(expect.objectContaining({ severity: "block", reason: expect.stringMatching(/intercom-revocation-unconfirmed.*A may still reach box B/) }));
}, 5000);

it("the operator CLI reports unconfirmed revocation without claiming the path closed", async () => {
  const f = await fixture();
  writeFileSync(join(f.root, "roam", "config.json"), JSON.stringify({ enabled: true, role: "box", machineId: A, hubMachineId: B, coreUnit: "fixture.service" }), { mode: 0o600 });
  writeFileSync(join(f.root, "roam", "machine.json"), JSON.stringify({ machineId: A }), { mode: 0o600 });
  const { runIntercomRevokeCli } = await import("../intercom-cli"); let out = "", err = "";
  const code = await runIntercomRevokeCli({ root: f.root, pairId: "pair-1" }, { out: text => { out += text; }, err: text => { err += text; } }, { revokePorts: f.ports });
  expect(code).toBe(3); expect(err).toContain("intercom-revocation-unconfirmed"); expect(out).not.toContain("intercom-revoked");
  expect(err).toContain("On the hub, run spider roam intercom revoke pair-1");
  const { main } = await import("../cli"); out = ""; err = "";
  expect(await main(["--global-root", f.root, "roam", "intercom", "revoke", "pair-1"], { out: text => { out += text; }, err: text => { err += text; } },
    { intercomOptions: { revokePorts: f.ports } })).toBe(3);
  expect(err).toContain("intercom-revocation-unconfirmed");
}, 5000);

it("records unconfirmed revocation when B is unreachable", async () => {
  const f = await fixture(true);
  expect(await revokeIntercomPair("pair-1", f.ports)).toMatchObject({ code: 3, reason: "intercom-revocation-unconfirmed" });
  expect(f.calls[0]).toBe("fence-local"); expect(f.calls.some(call => call.includes("remove-authorized"))).toBe(false);
  expect(await f.registry.get("pair-1")).toMatchObject({ state: "revoked", fenceId: TOKEN, cleanupReason: "intercom-revocation-unconfirmed" });
}, 5000);

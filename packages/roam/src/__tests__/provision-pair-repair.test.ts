import { afterEach, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { DEFAULT_LIMITS } from "../contracts";
import type { Peer, Transport } from "../contracts";
import type { ProvisionTransport } from "../transport";
import { createHcProvisionAdapter, PROVISION_REMOTE_SCRIPT } from "../provision-adapter";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const scratch = join(process.cwd(), ".spider", "scratch"); mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, "pair-provision-")); roots.push(root);
  const home = join(root, "home"), globalRoot = join(home, "global"), agentDir = join(home, "agent");
  const npmPrefix = join(home, "prefix"), unitDir = join(home, "units"), bin = join(home, "bin");
  for (const dir of [home, globalRoot, agentDir, npmPrefix, unitDir, bin]) mkdirSync(dir, { recursive: true, mode: 0o700 });
  mkdirSync(join(globalRoot, "roam"), { mode: 0o700 });
  const peer: Peer = { machineId: "11111111-1111-4111-8111-111111111111", alias: "box-1.invalid", node: join(bin, "node"),
    pi: join(npmPrefix, "bin", "pi"), cli: join(npmPrefix, "release", "cli.mjs"), core: join(bin, "hc"), globalRoot };
  writeFileSync(join(globalRoot, "roam", "machine.json"), JSON.stringify({ version: 1, machineId: peer.machineId }), { mode: 0o600 });
  const requests: string[] = [];
  const transport = { async resolve(value: Peer) { return value; } } as Transport;
  const remote = { transport, async executeProvision(_peer: Peer, request: Record<string, unknown>) {
    requests.push(String(request.action));
    const child = spawnSync(process.execPath, ["--input-type=module-typescript", "-e", PROVISION_REMOTE_SCRIPT], {
      input: JSON.stringify({ ...request, core: peer.core, coreId: "fixture-core" }), encoding: "utf8", timeout: 4000,
      env: { ...process.env, HOME: home, PATH: bin, SPIDER_GLOBAL_ROOT: globalRoot },
    });
    if (child.status !== 0) throw new Error("fixture remote program failed");
    const reply = JSON.parse(child.stdout) as { error?: string; value?: unknown };
    if (reply.error) throw Object.assign(new Error("remote request failed"), { code: reply.error });
    return reply.value;
  } } as unknown as ProvisionTransport;
  const options = { peer, operationId: "op-1", destination: { home, agentDir, npmPrefix, supervisor: join(npmPrefix, "release", "supervisor.mjs") },
    unitDir, limits: { ...DEFAULT_LIMITS, chunkBytes: 32 }, transport: remote, piProviders: [] };
  return { root, home, globalRoot, agentDir, peer, options, requests };
}
function fakePairRepairCli(f: ReturnType<typeof fixture>, reply: string, exit = 0): string {
  const calls = join(f.root, "pair-repair-calls.json");
  symlinkSync(process.execPath, f.peer.node);
  mkdirSync(dirname(f.peer.cli), { recursive: true, mode: 0o700 });
  writeFileSync(f.peer.cli, `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(calls)}, JSON.stringify({args:process.argv.slice(2), agentDir:process.env.PI_CODING_AGENT_DIR})); process.stdout.write(${JSON.stringify(reply)}); process.exitCode=${exit};\n`, { mode: 0o600 });
  return calls;
}

it("runs pair-unit repair through the generated program on the pinned destination", async () => {
  const f = fixture(), calls = fakePairRepairCli(f, JSON.stringify({ version: 1, kind: "intercom-unit-repair", ok: true, machineId: f.peer.machineId }));
  const adapter = createHcProvisionAdapter(f.options);
  await expect(adapter.reconcilePairUnits(f.peer)).resolves.toBeUndefined();
  expect(JSON.parse(readFileSync(calls, "utf8"))).toEqual({ args: ["--global-root", f.globalRoot, "roam", "intercom", "repair-units"], agentDir: f.agentDir });
  expect(f.requests).toContain("pair-unit-repair");
  await expect(adapter.reconcilePairUnits({ ...f.peer, machineId: "00000000-0000-4000-8000-000000000009" })).rejects.toMatchObject({ code: "machine-mismatch" });
});

it.each([
  ["unit mismatch", JSON.stringify({ version: 1, kind: "intercom-unit-repair", ok: false, reason: "intercom-unit-mismatch" }), 0, "intercom-unit-mismatch"],
  ["fenced pair", JSON.stringify({ version: 1, kind: "intercom-unit-repair", ok: false, reason: "revocation-pending" }), 0, "revocation-pending"],
  ["unknown refusal", JSON.stringify({ version: 1, kind: "intercom-unit-repair", ok: false, reason: "private-detail" }), 0, "intercom-unit-repair-unavailable"],
  ["wrong machine", JSON.stringify({ version: 1, kind: "intercom-unit-repair", ok: true, machineId: "00000000-0000-4000-8000-000000000009" }), 0, "machine-mismatch"],
  ["reply with extra fields", JSON.stringify({ version: 1, kind: "intercom-unit-repair", ok: true, machineId: "11111111-1111-4111-8111-111111111111", extra: "untrusted" }), 0, "invalid-provision-reply"],
  ["malformed reply", "not-json", 0, "invalid-provision-reply"],
  ["process failure", "", 1, "intercom-unit-repair-unavailable"],
] as const)("pair-unit repair refuses a %s", async (_name, reply, exit, code) => {
  const f = fixture(); fakePairRepairCli(f, reply, exit);
  await expect(createHcProvisionAdapter(f.options).reconcilePairUnits(f.peer)).rejects.toMatchObject({ code });
});

it("does not run pair-unit repair when the destination identity changed", async () => {
  const f = fixture(), calls = fakePairRepairCli(f, JSON.stringify({ version: 1, kind: "intercom-unit-repair", ok: true, machineId: f.peer.machineId }));
  writeFileSync(join(f.globalRoot, "roam", "machine.json"), JSON.stringify({ machineId: "00000000-0000-4000-8000-000000000009" }), { mode: 0o600 });
  await expect(createHcProvisionAdapter(f.options).reconcilePairUnits(f.peer)).rejects.toMatchObject({ code: "machine-mismatch" });
  expect(existsSync(calls)).toBe(false);
});

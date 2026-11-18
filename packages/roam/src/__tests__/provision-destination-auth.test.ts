import { afterEach, expect, it, vi } from "vitest";
import fs, { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { createReplica } from "@spider/db-core/testutil";
import { main } from "../cli";
import * as transportModule from "../transport";
import * as hubModule from "../production-hub";
import * as provisionModule from "../provision";
import * as selectedModule from "../selected-files";
import { healthyInventory } from "./bootstrap-fixture";
import { PROVISION_REMOTE_SCRIPT } from "../provision-remote-script";

const originalRead = selectedModule.readPrivateBytes;
const fixtures: ReturnType<typeof createReplica>[] = [];
afterEach(() => { vi.restoreAllMocks(); syncBuiltinESMExports(); for (const f of fixtures.splice(0)) f.close(); vi.unstubAllEnvs(); });
function fixture(explicit = true) {
  const hub = "00000000-0000-4000-8000-000000000001", f = createReplica("global", hub); fixtures.push(f);
  const agent = join(f.root, "source"), release = join(f.root, "release.tgz"); mkdirSync(agent, { mode: 0o700 });
  writeFileSync(join(agent, "auth.json"), JSON.stringify({ [["github", "copilot"].join("-")]: { type: "oauth", access: ["private", "credential"].join("-") } }), { mode: 0o600 });
  writeFileSync(release, "release", { mode: 0o600 }); mkdirSync(join(f.root, "roam"), { mode: 0o700 });
  writeFileSync(join(f.root, "roam", "machine.json"), JSON.stringify({ machineId: hub }), { mode: 0o600 });
  writeFileSync(join(f.root, "roam", "config.json"), JSON.stringify({ enabled: false, role: "hub", machineId: hub, hubMachineId: hub,
    peers: [{ machineId: "00000000-0000-4000-8000-000000000002", alias: "box-1.invalid", node: "/home/fixture/node",
      pi: "/home/fixture/install/prefix/bin/pi", cli: "/home/fixture/cli", core: "/home/fixture/hc", globalRoot: "/home/fixture/state",
      ...(explicit ? { agentDir: "/home/fixture/install/agent" } : {}) }], coreUnit: "fixture.service" }), { mode: 0o600 });
  vi.stubEnv("PI_CODING_AGENT_DIR", agent); vi.stubEnv("SPIDER_GLOBAL_ROOT", f.root);
  vi.spyOn(hubModule, "loadHerdrConfig").mockReturnValue({ core: { binary: "/fixture/hc" } } as never);
  vi.spyOn(transportModule, "createProvisionTransport").mockReturnValue({ transport: {}, probeHome: async () => "/home/fixture" } as never);
  const reads = vi.spyOn(selectedModule, "readPrivateBytes");
  let output = "", errors = "";
  const io = { out(text: string) { output += text; }, err(text: string) { errors += text; } };
  return { ...f, agent, release, reads, io, output: () => output, errors: () => errors };
}
it("uses destination sign-in without opening hub auth and retains explicit paths", async () => {
  const f = fixture();
  const install = vi.spyOn(provisionModule, "provision").mockImplementation(async (request, ports) => {
    expect(request).toMatchObject({ includeAuth: false, requireDestinationAuth: true, confirmedProviders: [] });
    expect(ports.source.piProviders).toEqual([]);
    expect(ports.destination).toMatchObject({ home: "/home/fixture", agentDir: "/home/fixture/install/agent", npmPrefix: "/home/fixture/install/prefix" });
    expect(await ports.confirm(request.peer.alias, request.confirmedProviders)).toBe(true);
    return { code: 0, reason: "installed", operationId: request.operation.id, home: null, epoch: null, repairCommand: null, value: { hostingReady: true } };
  });
  expect(await main(["roam", "provision", "box-1.invalid", "--use-destination-auth", "--yes", "--release", f.release], f.io), f.errors()).toBe(0);
  expect(install).toHaveBeenCalledOnce();
  expect(f.reads.mock.calls.filter(([, name]) => name === "auth.json")).toEqual([]);
  expect(f.output()).not.toContain("Selected auth.json"); expect(f.errors()).toBe("");
}, 5000);
it("carries destination-managed auth from the CLI through the real remote metadata verifier", async () => {
  const f = fixture(), home = join(f.root, "box-home"), agent = join(home, "install", "agent"), globalRoot = join(home, "state");
  mkdirSync(agent, { recursive: true, mode: 0o700 }); mkdirSync(join(globalRoot, "roam"), { recursive: true, mode: 0o700 });
  writeFileSync(join(globalRoot, "roam", "machine.json"), JSON.stringify({ machineId: "00000000-0000-4000-8000-000000000002" }), { mode: 0o600 });
  const auth = join(agent, "auth.json"), audit = join(home, "auth-read"), hook = join(home, "guard.mjs");
  writeFileSync(auth, "metadata is sufficient", { mode: 0o600 });
  writeFileSync(hook, `import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
for(const key of ['openSync','readFileSync']){const original=fs[key];fs[key]=function(file,...args){if(file===${JSON.stringify(auth)}){fs.writeFileSync(${JSON.stringify(audit)},'read');throw new Error('auth-read-forbidden');}return original(file,...args);};}syncBuiltinESMExports();`);
  const verified: Record<string, unknown>[] = [];
  vi.mocked(transportModule.createProvisionTransport).mockImplementation(({ enrolled }) => {
    const peer = enrolled[0];
    const inventory = healthyInventory(); inventory.core.unit = "fixture.service"; inventory.pi = peer.pi;
    return { transport: { resolve: async () => peer, bootstrapProbe: async () => structuredClone(inventory) },
      probeHome: async () => "/home/fixture", probeAgentDirectory: async () => ({ status: "default", core: { local: "local-core", remote: "remote-core" } }),
      previewSettings: async () => ({ fingerprint: "a".repeat(64), changedKeys: [] }),
      claimIdentity: async () => ({ machineId: peer.machineId, coreId: "remote-core" }),
      async executeProvision(_peer: unknown, request: Record<string, unknown>) {
        if (request.action === "release-observe") return { state: "finished", value: { pi: request.pi, cli: request.cli, supervisor: request.supervisor } };
        if (request.action === "roaming-enabled") return { enabled: request.enabled };
        if (request.action === "switchover") return { status: "applied" };
        if (["enrollment", "clear-secrets", "unit-write", "systemctl"].includes(String(request.action))) return true;
        if (request.action !== "verify") throw new Error(`unexpected-effect:${request.action}`);
        const mapped = Object.fromEntries(Object.entries(request).map(([key, value]) => [key, typeof value === "string" && value.startsWith("/home/fixture") ? home + value.slice("/home/fixture".length) : value]));
        const child = spawnSync(process.execPath, ["--import", hook, "--input-type=module-typescript", "-e", PROVISION_REMOTE_SCRIPT], {
          input: JSON.stringify(mapped), cwd: home, env: { ...process.env, HOME: home, PI_CODING_AGENT_DIR: agent }, encoding: "utf8", timeout: 3000,
        });
        expect(child.status, child.stderr).toBe(0);
        const reply = JSON.parse(child.stdout); verified.push({ providers: request.providers, files: request.files, value: reply.value });
        return reply.value;
      },
    } as never;
  });
  expect(await main(["roam", "provision", "box-1.invalid", "--use-destination-auth", "--yes", "--release", f.release], f.io), f.errors()).toBe(0);
  expect(verified).toEqual([{ providers: [], files: [], value: expect.objectContaining({ piSignedIn: true, privateModes: true }) }]);
  expect(existsSync(audit)).toBe(false);
  expect(f.reads.mock.calls.filter(([root]) => root === f.agent)).toEqual([]);
}, 5000);

it.each(["hc-serve-0a1b2c3d.service", undefined])("provisions with the peer unit %s rather than the hub unit", async coreUnit => {
  const f = fixture(), unit = "hc-serve-0a1b2c3d.service";
  const file = join(f.root, "roam", "config.json"), config = JSON.parse(fs.readFileSync(file, "utf8"));
  config.coreUnit = "hub-core.service";
  if (coreUnit) config.peers[0].coreUnit = coreUnit;
  writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
  const probes: unknown[] = [], enrollments: unknown[] = [], units: unknown[] = [];
  vi.mocked(transportModule.createProvisionTransport).mockImplementation(({ enrolled }) => {
    const peer = enrolled[0], inventory = healthyInventory(); inventory.core.unit = unit; inventory.pi = peer.pi;
    return { transport: { resolve: async () => peer, bootstrapProbe: async (_peer: unknown, _kind: unknown, options: unknown) => {
      probes.push(options); return structuredClone(inventory);
    } }, probeHome: async () => "/home/fixture",
      previewSettings: async () => ({ fingerprint: "a".repeat(64), changedKeys: [] }),
      probeAgentDirectory: async () => ({ status: "default", core: { local: "local-core", remote: "remote-core" } }),
      claimIdentity: async () => ({ machineId: peer.machineId, coreId: "remote-core" }),
      async executeProvision(_peer: unknown, request: Record<string, unknown>) {
        if (request.action === "enrollment") enrollments.push(request.coreUnit);
        if (request.action === "unit-write") units.push(request.contents);
        if (request.action === "release-observe") return { state: "finished", value: { pi: request.pi, cli: request.cli, supervisor: request.supervisor } };
        if (request.action === "roaming-enabled") return { enabled: request.enabled };
        if (request.action === "switchover") return { status: "applied" };
        if (request.action === "verify") return { providers: [], piSignedIn: true, selectedFiles: true, nativeModuleReady: true, extensionReady: true, cliReady: true, privateModes: true, releasePaths: true, sessionModes: true, launcherNofile: 65_536 };
        return true;
      },
    } as never;
  });
  expect(await main(["roam", "provision", "box-1.invalid", "--use-destination-auth", "--yes", "--no-settings", "--release", f.release], f.io), f.errors()).toBe(0);
  expect(probes.length).toBeGreaterThan(0);
  for (const probe of probes) expect((probe as { coreUnit?: string }).coreUnit).toBe(coreUnit);
  expect(enrollments).toEqual([unit]);
  expect(units).toHaveLength(1);
  expect(units[0]).not.toMatch(/^(After|Requires|PartOf)=/m);
}, 5000);

it("requires an explicit agent directory for a nonstandard prefix", async () => {
  const f = fixture(false), install = vi.spyOn(provisionModule, "provision");
  expect(await main(["roam", "provision", "box-1.invalid", "--use-destination-auth", "--yes", "--release", f.release], f.io), f.errors()).toBe(1);
  expect(f.errors()).toContain("provision-agent-directory-required"); expect(install).not.toHaveBeenCalled();
  expect(f.reads.mock.calls.filter(([, name]) => name === "auth.json")).toEqual([]);
}, 5000);
it("leaves every hub credential-bearing selection to the destination without reading it", async () => {
  const f = fixture();
  for (const name of ["models.json", "settings.json", "keybindings.json", "AGENTS.md"]) {
    writeFileSync(join(f.agent, name), JSON.stringify({ apiKey: ["fixture", "credential"].join("-") }), { mode: 0o600 });
  }
  mkdirSync(join(f.agent, "skills", "fixture"), { recursive: true, mode: 0o700 });
  writeFileSync(join(f.agent, "skills", "fixture", "SKILL.md"), "destination manages this", { mode: 0o600 });
  const accesses: string[] = [];
  for (const key of ["lstatSync", "openSync", "readFileSync", "readdirSync"] as const) {
    const original = fs[key];
    vi.spyOn(fs, key).mockImplementation(((file: unknown, ...args: unknown[]) => {
      if (typeof file === "string" && file.startsWith(`${f.agent}/`)) { accesses.push(file.slice(f.agent.length + 1)); throw new Error("hub-inspection-forbidden"); }
      return Reflect.apply(original, fs, [file, ...args]);
    }) as never);
  }
  syncBuiltinESMExports();
  f.reads.mockImplementation((root, name, maximum) => {
    if (root === f.agent) throw new Error(`hub-read-forbidden:${name}`);
    return originalRead(root, name, maximum);
  });
  const install = vi.spyOn(provisionModule, "provision").mockImplementation(async (request) => {
    expect(request.selected).toEqual([]);
    expect(request.expectedFiles).toEqual([]);
    return { code: 0, reason: "installed", operationId: request.operation.id, home: null, epoch: null, repairCommand: null, value: { hostingReady: true } };
  });
  const code = await main(["roam", "provision", "box-1.invalid", "--use-destination-auth", "--yes", "--skill", "fixture", "--release", f.release], f.io);
  expect(accesses).toEqual([]);
  expect(code, f.errors()).toBe(0);
  expect(install).toHaveBeenCalledOnce();
  expect(f.reads.mock.calls.filter(([root]) => root === f.agent)).toEqual([]);
  expect(f.output()).not.toContain("Selected ");
  expect(f.errors()).not.toContain("consent");
}, 5000);

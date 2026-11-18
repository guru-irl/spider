import { afterEach, expect, it, vi } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createReplica } from "@spider/db-core/testutil";
import { main } from "../cli";
import * as transportModule from "../transport";
import * as hubModule from "../production-hub";
import * as provisionModule from "../provision";
import * as selectedModule from "../selected-files";

const fixtures: ReturnType<typeof createReplica>[] = [];
afterEach(() => { for (const f of fixtures.splice(0)) f.close(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });
function fixture(explicit = true) {
  const hub = "00000000-0000-4000-8000-000000000001", f = createReplica("global", hub); fixtures.push(f);
  const agent = join(f.root, "source"), release = join(f.root, "release.tgz"); mkdirSync(agent, { mode: 0o700 });
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
it("requires an explicit agent directory for a nonstandard prefix", async () => {
  const f = fixture(false), install = vi.spyOn(provisionModule, "provision");
  expect(await main(["roam", "provision", "box-1.invalid", "--use-destination-auth", "--yes", "--release", f.release], f.io), f.errors()).toBe(1);
  expect(f.errors()).toContain("provision-agent-directory-required"); expect(install).not.toHaveBeenCalled();
  expect(f.reads.mock.calls.filter(([, name]) => name === "auth.json")).toEqual([]);
}, 5000);
it("does not treat destination sign-in as permission to transfer credential-bearing files", async () => {
  const f = fixture();
  writeFileSync(join(f.agent, "models.json"), JSON.stringify({ providers: { demo: { apiKey: ["fixture", "credential"].join("-") } } }), { mode: 0o600 });
  const install = vi.spyOn(provisionModule, "provision");
  expect(await main(["roam", "provision", "box-1.invalid", "--use-destination-auth", "--yes", "--release", f.release], f.io), f.errors()).toBe(1);
  expect(f.errors()).toContain("provision-provider-consent-required"); expect(install).not.toHaveBeenCalled();
}, 5000);

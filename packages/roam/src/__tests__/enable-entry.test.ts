import { afterEach, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { main } from "../cli";
import { enableRoaming } from "../production-controls";

const roots: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(role: "hub" | "box") {
  const root = mkdtempSync(join(resolve(".spider/scratch"), "enab-")); roots.push(root);
  mkdirSync(join(root, "roam"), { mode: 0o700 });
  const hub = "00000000-0000-4000-8000-000000000001", box = "00000000-0000-4000-8000-000000000002";
  const machineId = role === "hub" ? hub : box;
  writeFileSync(join(root, "roam/machine.json"), JSON.stringify({ machineId }), { mode: 0o600 });
  writeFileSync(join(root, "roam/config.json"), JSON.stringify({ enabled: false, role, machineId, hubMachineId: hub, peers: [], discoveryRoots: [], coreUnit: "fixture" }), { mode: 0o600 });
  vi.stubEnv("HOME", root); vi.stubEnv("SPIDER_GLOBAL_ROOT", root);
  return root;
}

it.each([
  { role: "box" as const, reason: "enable-unavailable" },
  { role: "hub" as const, reason: "enable-unavailable" },
])("enable returns a structured $reason with an unavailable installed entry", async ({ role, reason }) => {
  const root = fixture(role), config = join(root, "roam/config.json"), before = readFileSync(config, "utf8");
  const out: string[] = [], err: string[] = [];
  await expect(main(["roam", "enable", "--json"], { out: text => out.push(text), err: text => err.push(text) },
    { bundleUrl: new URL("file:///home/fixture/missing-package/dist/roam/cli-main.mjs") })).resolves.toBe(1);
  expect(JSON.parse(out.join(""))).toMatchObject({ code: 1, reason });
  expect(err.join("")).toBe("");
  expect(readFileSync(config, "utf8")).toBe(before);
});

it("retained legacy enable checks its role before resolving an installed entry", async () => {
  const root = fixture("box");
  const resolveEntry = vi.fn(() => { throw new Error("installed-cli-entry-unavailable"); });
  expect(await enableRoaming(root, resolveEntry)).toMatchObject({ code: 1, reason: "mac-hub-required", message: "Run this command on the Mac hub." });
  expect(resolveEntry).not.toHaveBeenCalled();
});

it("text enable on a box explains how to recover from an unavailable entry", async () => {
  fixture("box"); const out: string[] = [], err: string[] = [];
  expect(await main(["roam", "enable"], { out: text => out.push(text), err: text => err.push(text) },
    { bundleUrl: new URL("file:///home/fixture/missing-package/dist/roam/cli-main.mjs") })).toBe(1);
  expect(out.join("")).toBe("");
  expect(err.join("")).toContain("installed-cli-entry-unavailable");
  expect(err.join("")).toContain("retry spider roam enable");
});

import { afterEach, expect, it, vi } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import * as enrollment from "../enrollment";
import { runLocalDoctor } from "../local-diagnostics";
import { main } from "../cli";

const roots: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(state: string) {
  const base = resolve(".spider/scratch/core-pin-doctor"); mkdirSync(base, { recursive: true, mode: 0o700 });
  const root = mkdtempSync(join(base, "f-")); roots.push(root); mkdirSync(join(root, "roam"), { mode: 0o700 });
  const pin = { binary: join(root, "hc"), coreId: "fixture-core", socket: join(root, "core.sock"), sessionNamespace: "fixture",
    stateHome: join(root, "state"), configHome: join(root, "config") };
  writeFileSync(pin.binary, `#!${process.execPath}
const e = process.env;
if (process.argv.slice(2).join(' ') !== 'server status --json' || e.HC_TERMINAL_ID || e.HC_TERMINAL_SOCKET || e.HC_SCOPE || e.HC_SOCKET !== ${JSON.stringify(pin.socket)} || e.HC_SESSION !== 'fixture' || e.XDG_STATE_HOME !== ${JSON.stringify(pin.stateHome)} || e.XDG_CONFIG_HOME !== ${JSON.stringify(pin.configHome)}) process.exit(1);
if (${JSON.stringify(state)} === 'unreachable') process.exit(1);
console.log(JSON.stringify({version:'0.1.16',core:{id:${JSON.stringify(state === "changed" ? "other-core" : "fixture-core")}},pid:4321}));
`, { mode: 0o700 });
  const file = join(root, "roam/core.json");
  if (state !== "missing") enrollment.installSupervisorCorePin(root, pin);
  if (state === "unsafe") chmodSync(file, 0o644);
  if (state === "unreadable") writeFileSync(file, "not-json", { mode: 0o600 });
  writeFileSync(join(root, "roam/config.json"), JSON.stringify({ enabled: false, role: "box", machineId: "00000000-0000-4000-8000-000000000001",
    hubMachineId: "00000000-0000-4000-8000-000000000002", peers: [], coreUnit: "fixture.service" }), { mode: 0o600 });
  writeFileSync(join(root, "roam/machine.json"), JSON.stringify({ machineId: "00000000-0000-4000-8000-000000000001" }), { mode: 0o600 });
  return { root, pin };
}

it("the public doctor retains pin blocks and unit information on a disabled box", async () => {
  const f = fixture("missing"); vi.stubEnv("SPIDER_GLOBAL_ROOT", f.root);
  let output = "";
  expect(await main(["roam", "doctor", "--json"], { out(text) { output += text; }, err() {} })).toBe(1);
  const result = JSON.parse(output);
  expect(result.value.diagnostics).toEqual(expect.arrayContaining([
    expect.objectContaining({ severity: "block", reason: expect.stringContaining("core-pin-required") }),
    expect.objectContaining({ severity: "info", reason: expect.stringContaining("core unit") }),
  ]));
});

it.each([
  ["ready", "ready"], ["missing", "core-pin-required"], ["unsafe", "core-pin-invalid"], ["unreadable", "core-pin-invalid"],
  ["changed", "core-pin-changed"], ["unreachable", "core-pin-unreachable"],
])("inspects a %s pin with status only and the exact sanitized settings", (state, expected) => {
  const f = fixture(state);
  const inspect = (enrollment as typeof enrollment & { inspectSupervisorCorePin?: (root: string, env: NodeJS.ProcessEnv) => string }).inspectSupervisorCorePin;
  expect(inspect).toBeTypeOf("function");
  expect(inspect!(f.root, { ...process.env, HC_TERMINAL_ID: "foreign-terminal", HC_TERMINAL_SOCKET: "/foreign.sock", HC_SCOPE: "foreign" })).toBe(expected);
});

it.each([
  ["missing", "core-pin-required", "block"], ["unsafe", "core-pin-invalid", "block"], ["unreadable", "core-pin-invalid", "block"],
  ["changed", "core-pin-changed", "block"], ["unreachable", "core-pin-unreachable", "warning"],
])("local box doctor reports the %s pin", async (state, code, severity) => {
  const f = fixture(state), result = await runLocalDoctor({ root: f.root });
  expect(result.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ reason: expect.stringContaining(code), severity })]));
  if (state === "missing") expect(result.diagnostics.find(item => item.reason.includes(code))?.repairCommand).toContain("spider roam provision");
});

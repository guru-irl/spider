import { afterEach, expect, it, vi } from "vitest";
import { join } from "node:path";
import { createLocalDiagnosticPorts } from "../local-diagnostics";

const fixture = vi.hoisted(() => ({ pid: 98765432, identity: "throw" as "throw" | "empty" }));
vi.mock("node:fs", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, readFileSync(path: unknown, ...args: unknown[]) {
    if (String(path) === `/proc/${fixture.pid}/stat`) {
      if (fixture.identity === "empty") return `${fixture.pid} (pi) R`;
      throw Object.assign(new Error("process disappeared"), { code: "ENOENT" });
    }
    return Reflect.apply(actual.readFileSync, undefined, [path, ...args]);
  } };
});
vi.mock("node:child_process", async importOriginal => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFileSync(command: unknown, args: unknown, ...rest: unknown[]) {
    if (command === "/bin/ps" && Array.isArray(args) && args.includes(String(fixture.pid))) {
      if (fixture.identity === "empty") return "";
      throw new Error("process disappeared");
    }
    return Reflect.apply(actual.execFileSync, undefined, [command, args, ...rest]);
  } };
});
afterEach(() => { vi.restoreAllMocks(); fixture.identity = "throw"; });
const machine = { machineId: "fixture-machine", label: "fixture", peer: null };

it.each([
  ["probeProcess", "throw"], ["probeUsage", "throw"], ["probeProcess", "empty"], ["probeUsage", "empty"],
] as const)("%s confirms absence when the process exits during identity read (%s)", async (method, identity) => {
  fixture.identity = identity;
  let calls = 0;
  vi.spyOn(process, "kill").mockImplementation(() => {
    if (++calls === 1) return true;
    throw Object.assign(new Error("not found"), { code: "ESRCH" });
  });
  const ports = createLocalDiagnosticPorts(join(process.cwd(), "unused-probe-fixture"), []);
  expect(await ports[method](machine, fixture.pid)).toEqual({ kind: "absent" });
}, 5000);

it.each(["still-present", "permission-denied"] as const)("keeps identity failure unknown when the recheck is %s", async outcome => {
  let calls = 0;
  vi.spyOn(process, "kill").mockImplementation(() => {
    if (++calls === 1 || outcome === "still-present") return true;
    throw Object.assign(new Error("cannot inspect"), { code: "EPERM" });
  });
  const ports = createLocalDiagnosticPorts(join(process.cwd(), "unused-probe-fixture"), []);
  expect(await ports.probeProcess(machine, fixture.pid)).toEqual({ kind: "unknown" });
}, 5000);

import { expect, it } from "vitest";
import type { IntercomConnectorRecipe } from "../contracts";
import { paths } from "@spider/db-core";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const recipe: IntercomConnectorRecipe = { check: ["/fixture/connector", "check"], host: ["/fixture/connector", "host"],
  connect: ["/fixture/connector", "connect"], localPort: 23222 };
async function api() { return await import("../intercom-connector").catch(() => ({})) as typeof import("../intercom-connector"); }
function fixture(status: unknown = { connector: "ready", login: "ready", tunnel: "hosted", peerPort: "reachable" }) {
  const calls: string[][] = [];
  const run = async (argv: readonly string[], _options: { timeoutMs: number; maxBytes: number }) => {
    calls.push([...argv]); return { code: 0, stdout: JSON.stringify(status) };
  };
  return { calls, run };
}

it("runs no connector command without separate human consent", async () => {
  const mod = await api(); expect(mod.checkConnector).toBeTypeOf("function"); const f = fixture();
  expect(await mod.checkConnector(recipe, { run: f.run, consent: false })).toEqual({ status: "intercom-peer-consent-required" });
  expect(f.calls).toEqual([]);
}, 5000);

it("reports a missing recipe and malformed check output by name", async () => {
  const mod = await api(); expect(mod.checkConnector).toBeTypeOf("function"); const f = fixture({ bad: "fixture-secret" });
  expect(await mod.checkConnector(undefined, { run: f.run, consent: true })).toEqual({ status: "intercom-connector-recipe-missing" });
  expect(f.calls).toEqual([]);
  expect(await mod.checkConnector(recipe, { run: f.run, consent: true })).toEqual({ status: "intercom-connector-check-invalid" });
  expect(f.calls).toEqual([["/fixture/connector", "check"]]);
}, 5000);

it("checks a connector without a separate SSH listener port", async () => {
  const mod = await api(), f = fixture();
  expect(await mod.checkConnector(recipe, { run: f.run, consent: true })).toEqual({ status: "ready" });
  expect(f.calls).toEqual([["/fixture/connector", "check"]]);
}, 5000);

it.each([
  [{ connector: "missing", login: "unknown", tunnel: "unknown", peerPort: "unknown" }, "intercom-connector-missing"],
  [{ connector: "ready", login: "required", tunnel: "unknown", peerPort: "unknown" }, "intercom-connector-sign-in-required"],
  [{ connector: "ready", login: "ready", tunnel: "unhosted", peerPort: "unknown" }, "intercom-tunnel-unhosted"],
  [{ connector: "ready", login: "ready", tunnel: "hosted", peerPort: "unreachable" }, "intercom-peer-port-unreachable"],
] as const)("reports an incomplete connector observation without repairing it %#", async (observation, expected) => {
  const mod = await api(); expect(mod.checkConnector).toBeTypeOf("function"); const f = fixture(observation);
  expect(await mod.checkConnector(recipe, { run: f.run, consent: true })).toEqual({ status: expected });
  expect(f.calls).toEqual([["/fixture/connector", "check"]]);
}, 5000);

it("the production runner passes literal argv to a foreground fixture command", async () => {
  const root = mkdtempSync(join(paths.scratch("worktree", process.cwd()), "connector-run-"));
  try {
    const script = join(root, "fixture.cjs"); writeFileSync(script, "process.stdout.write(JSON.stringify(process.argv.slice(2)))", { mode: 0o600 });
    const { runForeground } = await import("../intercom-local-ops");
    const result = await runForeground([process.execPath, script, "literal;not-a-shell", "space value"], { timeoutMs: 2000, maxBytes: 1024 });
    expect(result.code).toBe(0); expect(JSON.parse(result.stdout)).toEqual(["literal;not-a-shell", "space value"]);
  } finally { rmSync(root, { force: true, recursive: true }); }
}, 5000);

it.each([
  ["unreachable", "unreachable"], ["invalid_params", "invalid_params"], ["private-shaped-code", undefined],
])("the foreground runner retains only an allowlisted native error kind: %s", async (kind, expected) => {
  const { runForeground } = await import("../intercom-local-ops");
  const script = `process.stderr.write(JSON.stringify({error:{kind:process.argv[1],message:'private route details'}}));process.exitCode=1`;
  const result = await runForeground([process.execPath, "-e", script, kind], { timeoutMs: 2000, maxBytes: 1024 });
  expect(result).toEqual({ code: 1, stdout: "", ...(expected ? { errorKind: expected } : {}) });
  expect(JSON.stringify(result)).not.toContain("private route details");
  expect(JSON.stringify(result)).not.toContain("private-shaped-code");
}, 5000);

it("leaves unscoped host and connect recipes pending without launching either command", async () => {
  const mod = await api(); expect(mod.runConnectorStep).toBeTypeOf("function"); const f = fixture();
  expect(await mod.runConnectorStep(recipe, "host", { run: f.run, consent: false })).toEqual({ status: "intercom-peer-consent-required" });
  expect(await mod.runConnectorStep(recipe, "host", { run: f.run, consent: true })).toEqual({ status: "connector-not-pair-scoped" });
  expect(await mod.runConnectorStep(recipe, "connect", { run: f.run, consent: true })).toEqual({ status: "connector-not-pair-scoped" });
  expect(f.calls).toEqual([]);
}, 5000);

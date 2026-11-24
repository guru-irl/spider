import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import * as processIdentity from "../../../subagents/src/process-identity";
import { main as roamCli } from "../cli";
import { runIntercomEnrollCli } from "../intercom-cli";
import { openJournal } from "../journal";
import { runLocalDoctor } from "../local-diagnostics";
import * as provisionConfig from "../provision-config";
import { cleanupPairScenarios, scenario } from "./intercom-pair-fixture";

// The scenario supplies every machine operation in-process. No fixture may start
// an app, system service, broker, or external identity probe.
vi.mock("node:child_process", async importOriginal => {
  const original = await importOriginal<typeof import("node:child_process")>();
  const blocked = () => { throw new Error("Unexpected process launch"); };
  const execFileSync = (file: unknown, args: unknown) => {
    if (file === "sqlite3" && JSON.stringify(args) === JSON.stringify(["--version"])) return "3.42.0";
    return blocked();
  };
  const safe = { exec: blocked, execFile: blocked, execFileSync, execSync: blocked, fork: blocked, spawn: blocked, spawnSync: blocked };
  return { ...original, ...safe, default: { ...original, ...safe } };
});
vi.mock("child_process", async () => await import("node:child_process"));

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); cleanupPairScenarios(); });

async function fixture() {
  vi.spyOn(processIdentity, "processStartTime").mockReturnValue("fixture-start");
  const f = await scenario(), directory = join(f.root, "roam");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(join(directory, "config.json"), JSON.stringify({ enabled: true, role: "hub", machineId: f.request.operation.machineId,
    hubMachineId: f.request.operation.machineId, coreUnit: "fixture.service", peers: [f.source, f.target],
    intercom: { enabled: true, mode: "peers", machineAlias: "hub.invalid" } }), { mode: 0o600 });
  writeFileSync(join(directory, "machine.json"), JSON.stringify({ machineId: f.request.operation.machineId }), { mode: 0o600 });
  const plan = f.request.pairs[0], graph = join(f.root, "graph.json");
  writeFileSync(graph, JSON.stringify({ pairs: [{ ...plan, source: plan.source.machineId, target: plan.target.machineId }] }), { mode: 0o600 });
  const journal = openJournal(join(directory, "journal.db"));
  const calls: Array<{ step: string; side: string }> = [], exec = f.transport.transport.exec.bind(f.transport.transport);
  f.transport.transport.exec = async (peer, argv, options) => {
    const action = JSON.parse(options.stdin!.toString()).action;
    if (action === "publish-config" || action === "enroll-live") calls.push({ step: action, side: peer.machineId === f.source.machineId ? "source" : "target" });
    return exec(peer, argv, options);
  };
  let approvals = 0;
  const options = { transport: f.transport, journal, tty: true, ask: async () => { approvals++; return "approve"; } };
  const input = { root: f.root, graphFile: graph, operationId: f.request.operation.id };
  async function enroll() {
    let out = "", err = "";
    const code = await runIntercomEnrollCli(input, { out: text => { out += text; }, err: text => { err += text; } }, options);
    return { code, out, err };
  }
  // Pair publication rows only: other doctor rows (for example the hub service) may name their own log files.
  async function doctor() { return (await runLocalDoctor({ root: f.root })).diagnostics.map(item => item.reason).filter(reason => reason.startsWith("pair-")).join("\n"); }
  return { f, journal, calls, enroll, doctor, approvals: () => approvals };
}

const publication = [
  { step: "publish-config", side: "source" },
  { step: "publish-config", side: "target" },
  { step: "enroll-live", side: "target" },
  { step: "enroll-live", side: "source" },
] as const;

it.each([
  ["publish-config", "source", "intercom-mode-not-peers"],
  ["publish-config", "target", "EACCES"],
  ["enroll-live", "target", "broker-unavailable"],
  ["enroll-live", "source", "helper-unauthorized"],
] as const)("names %s on the %s with bounded cause %s", async (step, side, cause) => {
  const t = await fixture(), machine = side === "source" ? t.f.source : t.f.target;
  let failing = true;
  if (step === "publish-config") {
    const original = provisionConfig.persistIntercomPairRoute;
    vi.spyOn(provisionConfig, "persistIntercomPairRoute").mockImplementation(async (root, ...args) => {
      if (failing && root === machine.globalRoot) {
        if (cause === "EACCES") throw Object.assign(new Error("private configuration detail"), { code: cause });
        throw new Error(cause);
      }
      await original(root, ...args);
    });
  } else {
    const local = t.f.locals.get(machine.machineId)!, original = local.enrollBridge!;
    local.enrollBridge = async input => { if (failing) throw new Error(cause); return original(input); };
  }
  const result = await t.enroll(), diagnostic = await t.doctor();
  expect(result.code).toBe(3);
  expect(result.err).toContain("intercom-enrollment-pending");
  expect(result.err).toContain(`publication ${step} on ${side} [${cause}]`);
  expect(diagnostic).toContain(`pair-1: publication ${step} on ${side} [${cause}]`);
  expect(t.calls).toEqual(publication.slice(0, publication.findIndex(item => item.step === step && item.side === side) + 1));
  for (const text of [result.err, diagnostic]) {
    expect(text).not.toContain("private configuration detail");
    expect(text).not.toContain(t.f.root);
  }
  failing = false;
  expect((await t.enroll()).code).toBe(0);
  expect(t.approvals()).toBe(1);
  expect(await t.doctor()).not.toContain("pair-1: publication");
});

it("names the real configuration refusal when intercom is disabled on the source", async () => {
  const t = await fixture(), file = join(t.f.source.globalRoot, "roam", "config.json");
  const config = JSON.parse(readFileSync(file, "utf8"));
  config.intercom.enabled = false;
  writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
  const result = await t.enroll(), diagnostic = await t.doctor();
  expect(result.code).toBe(3);
  expect(result.err).toContain("publication publish-config on source [intercom-mode-not-peers]");
  expect(diagnostic).toContain("pair-1: publication publish-config on source [intercom-mode-not-peers]");
  expect(t.calls).toEqual([{ step: "publish-config", side: "source" }]);
  expect(result.err).not.toContain(t.f.root);
});

it("names a missing real helper route without exposing its file path", async () => {
  const t = await fixture(), local = t.f.locals.get(t.f.target.machineId)!;
  delete local.enrollBridge;
  const result = await t.enroll(), diagnostic = await t.doctor();
  expect(result.code).toBe(3);
  expect(result.err).toContain("publication enroll-live on target [ENOENT]");
  expect(diagnostic).toContain("pair-1: publication enroll-live on target [ENOENT]");
  for (const text of [result.err, diagnostic]) {
    expect(text).not.toContain(t.f.root);
    expect(text).not.toContain("helper.json");
  }
});

it.each([true, false])("shows pending publication evidence in public doctor with roaming enabled=%s", async enabled => {
  const t = await fixture(), local = t.f.locals.get(t.f.target.machineId)!;
  local.enrollBridge = async () => { throw new Error("broker-unavailable"); };
  expect((await t.enroll()).code).toBe(3);
  const file = join(t.f.root, "roam", "config.json"), config = JSON.parse(readFileSync(file, "utf8"));
  config.enabled = enabled;
  writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
  vi.stubEnv("SPIDER_GLOBAL_ROOT", t.f.root);
  let out = "";
  await roamCli(["roam", "doctor", "--json"], { out: text => { out += text; }, err: () => {} }, { intercomDoctor: async () => [] });
  const report = JSON.parse(out) as { value: { diagnostics: Array<{ reason: string }> } };
  const pairRows = report.value.diagnostics.filter(row => row.reason.startsWith("pair-"));
  expect(pairRows.some(row => row.reason.includes("pair-1: publication enroll-live on target [broker-unavailable]"))).toBe(true);
  expect(JSON.stringify(pairRows)).not.toContain(t.f.root);
});

it("clears a recovered publication diagnosis even if federation remains pending", async () => {
  const t = await fixture(), local = t.f.locals.get(t.f.target.machineId)!, originalEnroll = local.enrollBridge!;
  let failing = true;
  local.enrollBridge = async input => { if (failing) throw new Error("broker-unavailable"); return originalEnroll(input); };
  expect((await t.enroll()).code).toBe(3);
  expect(await t.doctor()).toContain("pair-1: publication enroll-live on target [broker-unavailable]");
  failing = false;
  const source = t.f.locals.get(t.f.source.machineId)!;
  source.inspectBridge = async input => ({ ...(input as { machineId: string; peer: string; edgeEpoch: string }), status: "down", reason: null });
  const result = await t.enroll();
  expect(result.code).toBe(3);
  expect(result.err).toContain("intercom-verification-pending");
  expect(await t.doctor()).not.toContain("pair-1: publication");
});

it("keeps an unknown exception private and retains the existing fallback", async () => {
  const t = await fixture(), local = t.f.locals.get(t.f.target.machineId)!;
  local.enrollBridge = async () => { throw new Error("private failure /home/fixture/private"); };
  const result = await t.enroll(), diagnostic = await t.doctor();
  expect(result.code).toBe(3);
  expect(result.err).toContain("intercom-enrollment-pending [unexpected-publish-pair]");
  expect(result.err).toContain("publication enroll-live on target");
  expect(diagnostic).toContain("pair-1: publication enroll-live on target");
  for (const text of [result.err, diagnostic]) expect(text).not.toContain("private");
});

it("keeps a precise existing refusal while naming the publication side", async () => {
  const t = await fixture(), local = t.f.locals.get(t.f.target.machineId)!;
  local.enrollBridge = async () => { throw new Error("fresh-peer-consent-required"); };
  const result = await t.enroll();
  expect(result.code).toBe(3);
  expect(result.err).toContain("pair-1: fresh-peer-consent-required");
  expect(result.err).toContain("publication enroll-live on target");
  expect(await t.doctor()).toContain("pair-1: publication enroll-live on target");
});

it("clears old publication evidence when a later attempt stops earlier", async () => {
  const t = await fixture(), local = t.f.locals.get(t.f.target.machineId)!;
  local.enrollBridge = async () => { throw new Error("broker-unavailable"); };
  expect((await t.enroll()).code).toBe(3);
  expect(await t.doctor()).toContain("pair-1: publication enroll-live on target [broker-unavailable]");
  const count = t.calls.length, exec = t.f.transport.transport.exec.bind(t.f.transport.transport);
  t.f.transport.transport.exec = async (machine, argv, options) => {
    if (JSON.parse(options.stdin!.toString()).action === "check-connector") return Buffer.from(JSON.stringify({ version: 1,
      kind: "intercom-setup", ok: false, machineId: machine.machineId, reason: "intercom-setup-pending", cause: { code: "EACCES" } }));
    return exec(machine, argv, options);
  };
  const result = await t.enroll();
  expect(result.code).toBe(3);
  expect(result.err).toContain("intercom-enrollment-pending [EACCES]");
  expect(t.calls).toHaveLength(count);
  expect(await t.doctor()).not.toContain("pair-1: publication");
});

it("keeps enrollment pending and retryable when diagnostic storage fails", async () => {
  const t = await fixture(), local = t.f.locals.get(t.f.target.machineId)!, originalEnroll = local.enrollBridge!;
  const record = t.journal.record.bind(t.journal); let failing = true;
  t.journal.record = (id, action, result) => {
    if (action === "intercom-publication") throw new Error("private diagnostic failure");
    record(id, action, result);
  };
  local.enrollBridge = async input => { if (failing) throw new Error("broker-unavailable"); return originalEnroll(input); };
  const result = await t.enroll();
  expect(result.code).toBe(3);
  expect(result.err).toContain("intercom-enrollment-pending");
  expect(result.err).toContain("publication enroll-live on target [broker-unavailable]");
  expect(result.err).not.toContain("private diagnostic failure");
  expect(await t.doctor()).not.toContain("pair-1: publication");
  failing = false;
  expect((await t.enroll()).code).toBe(0);
  expect(t.approvals()).toBe(1);
});

it("does not persist repeated identical failures or expose forged diagnostic fields", async () => {
  const t = await fixture(), local = t.f.locals.get(t.f.target.machineId)!;
  local.enrollBridge = async () => { throw new Error("broker-unavailable"); };
  expect((await t.enroll()).code).toBe(3);
  expect((await t.enroll()).code).toBe(3);
  expect(t.journal.read(t.f.request.operation.id).filter(row => row.action === "intercom-publication")).toHaveLength(1);
  t.journal.record(t.f.request.operation.id, "intercom-publication", { pairId: "pair-1", publication: {
    step: "/home/fixture/private", side: "source", causeCode: "private-content" } });
  const diagnostic = await t.doctor();
  expect(diagnostic).not.toContain("private");
  expect(diagnostic).not.toContain("pair-1: publication enroll-live on target [broker-unavailable]");
});

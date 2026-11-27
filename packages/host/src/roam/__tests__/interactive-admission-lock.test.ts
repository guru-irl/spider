import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { openDbAt, paths, setGlobalDbPathForTests } from "@spider/db-core";
import { scratchDbPath } from "@spider/db-core/testutil";
import { claimIdLock, inspectIdLock } from "@spider/herdr/sessions/id-lock";
import { createSessionLeases } from "@spider/herdr/sessions/lease";
import { DEFAULT_LIMITS, disabledIntercom } from "@spider/roam/contracts";
import { createHostSessionFixture } from "../../__tests__/fixtures/pi-events";
import { createAdmissionPorts, registerAdmission } from "../admission";

const sessionId = "interactive-session";
const machine = "11111111-1111-4111-8111-111111111111";
const identity = { pid: 101, startIdentity: "interactive-start" };
const contender = { pid: 202, startIdentity: "contender-start" };
const bootId = async () => "fixture-boot";
const probe = async (pid: number) => {
  const owner = [identity, contender].find(candidate => candidate.pid === pid);
  return owner ? { kind: "live" as const, startIdentity: owner.startIdentity } : { kind: "absent" as const };
};
const originalRoot = paths.globalRoot;
const roots: string[] = [];
const gates: ReturnType<typeof registerAdmission>[] = [];
afterEach(async () => {
  try { for (const gate of gates.splice(0)) await gate.close(); }
  finally {
    paths.globalRoot = originalRoot;
    setGlobalDbPathForTests(null);
    vi.unstubAllEnvs();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  }
});

function fixture(options: { configured?: boolean; noTranscript?: boolean; mode?: "tui" | "print" | "rpc"; child?: boolean } = {}) {
  const root = mkdtempSync(join(dirname(scratchDbPath("interactive-lock")), "interactive-lock-"));
  roots.push(root);
  const lockRoot = join(root, "herdr"), dbPath = join(root, "spider.db");
  paths.globalRoot = root;
  vi.stubEnv("SPIDER_GLOBAL_ROOT", root);
  vi.stubEnv("PI_SUBAGENT_CHILD", options.child ? "1" : "0");
  vi.stubEnv("SPIDER_HERDR_HANDOFF_FILE", undefined);
  setGlobalDbPathForTests(dbPath);
  if (options.configured) {
    const db = openDbAt(dbPath, "global");
    try { db.prepare("UPDATE roam_meta SET machine_id=? WHERE id=1").run(machine); }
    finally { db.close(); }
    mkdirSync(join(root, "roam"), { recursive: true, mode: 0o700 });
    const config = { enabled: false, role: "hub", machineId: machine, hubMachineId: machine, peers: [], discoveryRoots: [], coreUnit: "core", syncMs: 10_000, limits: DEFAULT_LIMITS, intercom: disabledIntercom() };
    writeFileSync(join(root, "roam", "config.json"), JSON.stringify(config), { mode: 0o600 });
    writeFileSync(join(root, "roam", "machine.json"), JSON.stringify({ machineId: machine }), { mode: 0o600 });
  }
  const file = join(root, "session.jsonl");
  if (!options.noTranscript) writeFileSync(file, JSON.stringify({ type: "session", version: 3, id: sessionId, cwd: root }) + "\n", { mode: 0o600 });
  const ports = createAdmissionPorts({ identity, probe, bootId, env: {} });
  const host = createHostSessionFixture({ cwd: root, sessionId, sessionFile: options.noTranscript ? null : file });
  host.ctx.mode = options.mode ?? "tui";
  const gate = registerAdmission(host.pi as unknown as ExtensionAPI, ports);
  gates.push(gate);
  async function emit(name: string) {
    let result: unknown;
    for (const handler of host.hooks.get(name) ?? []) result = await handler({}, host.ctx);
    return result;
  }
  return { gate, ports, file, lockRoot, emit, lock: () => inspectIdLock(lockRoot, sessionId),
    contend: () => claimIdLock(lockRoot, sessionId, contender, probe, { bootId }) };
}

it.each(["unconfigured", "disabled", "prepare failed", "load failed", "no transcript"] as const)("interactive admission pins the session ID when %s", async kind => {
  const f = fixture({ configured: kind !== "unconfigured" && kind !== "no transcript", noTranscript: kind === "no transcript" });
  if (kind === "prepare failed") f.ports.prepare = async () => { throw new Error("fixture preparation unavailable"); };
  const load = f.ports.load.bind(f.ports);
  let ownerAtLoad: unknown;
  f.ports.load = async id => {
    ownerAtLoad = await f.lock();
    if (kind === "load failed") throw new Error("fixture lookup unavailable");
    return load(id);
  };
  await f.emit("session_start");
  expect(f.gate.inspect().kind).toBe("ordinary");
  expect(ownerAtLoad).toMatchObject({ identity });
  expect(await f.lock()).toMatchObject({ identity });
  await expect(f.contend()).rejects.toThrow(/owner/i);
  await f.gate.close();
  expect(await f.lock()).toBeNull();
});

it("a live ID holder blocks ordinary interactive input even when roaming is unconfigured", async () => {
  const f = fixture(), owner = await f.contend();
  try {
    await f.emit("session_start");
    expect(f.gate.inspect()).toMatchObject({ kind: "blocked", blockers: [{ detail: expect.stringMatching(/close.*other.*copy/i) }] });
    expect(await f.emit("input")).toEqual({ action: "handled" });
    expect(await f.lock()).toMatchObject({ identity: contender });
  } finally { await owner.release(); }
});

it("failed late roaming readiness releases the file lease but keeps the ordinary ID lock", async () => {
  const f = fixture();
  let captured = false, leaseWhenReady: unknown;
  f.ports.captureVersion = () => captured ? "captured" : "ordinary";
  f.ports.prepare = async () => {};
  f.ports.localMachine = async () => machine;
  f.ports.load = async id => ({
    home: null, origin: machine, states: captured ? [{ sessionId: id, epoch: 1, state: "active", moveId: null, freezeSeq: null }] : [],
    participating: captured, captureSafe: true, unfinishedFreeze: false, initialConflict: false,
  });
  f.ports.ready = async () => {
    leaseWhenReady = await createSessionLeases(f.lockRoot).get(f.file);
    throw new Error("fixture readiness unavailable");
  };
  await f.emit("session_start");
  captured = true;
  await f.gate.refreshInitialHome();
  expect(f.gate.inspect()).toMatchObject({ kind: "ordinary", home: null, blockers: [{ detail: expect.stringContaining("late-admission-readiness-failed") }] });
  expect(leaseWhenReady).toMatchObject(identity);
  expect(await createSessionLeases(f.lockRoot).get(f.file)).toBeNull();
  expect(await f.lock()).toMatchObject({ identity });
  await expect(f.contend()).rejects.toThrow(/owner/i);
});

it.each(["print", "rpc", "child"] as const)("does not add an ordinary ID lock for %s", async kind => {
  const f = fixture(kind === "child" ? { child: true } : { mode: kind });
  await f.emit("session_start");
  expect(f.gate.inspect().kind).toBe("ordinary");
  expect(await f.lock()).toBeNull();
});

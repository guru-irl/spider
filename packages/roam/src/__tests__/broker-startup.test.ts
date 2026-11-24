import { afterEach, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { inspectIntercomReadiness } from "../intercom-readiness";
import { main } from "../cli";
import { migrate, openDb } from "@spider/db-core";

const state = vi.hoisted(() => ({ ready: false, probe: undefined as undefined | (() => void), settings: "settings-unique", failure: undefined as unknown, onProbe: undefined as undefined | (() => void), connections: new Set<() => void>() }));
function expireBroker() {
  state.ready = false;
  for (const close of state.connections) close();
}
vi.mock("@spider/intercom/broker/spawn", () => ({ spawnBrokerIfNeeded: async () => {
  if (state.failure) throw state.failure;
  state.ready = true; setTimeout(expireBroker, 5000);
} }));
vi.mock("node:fs", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, lstatSync: (path: string) => {
    if (!path.endsWith("broker.sock")) return actual.lstatSync(path);
    if (!state.ready) throw Object.assign(new Error("absent"), { code: "ENOENT" });
    return { ...actual.lstatSync(path.slice(0, -"/broker.sock".length)), isSocket: () => true, isSymbolicLink: () => false };
  } };
});
vi.mock("node:child_process", async importOriginal => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  spawnSync: () => {
    // Settings resolution may outlive an idle, sessionless broker. No sleeps.
    vi.advanceTimersByTime(5000);
    return { status: 0, stdout: JSON.stringify({ legacy: false, shim: "fixture-shim", extensions: state.settings === "settings-unique" ? [
      { path: join(process.env.PI_CODING_AGENT_DIR!, "extensions", "spider.ts"), enabled: true, metadata: { scope: "user" } },
    ] : [] }) };
  },
}));
vi.mock("node:net", async importOriginal => {
  const actual = await importOriginal<typeof import("node:net")>();
  return { ...actual, connect: () => {
    const socket = new EventEmitter() as EventEmitter & { destroy(): void; write(frame: Buffer): void };
    socket.destroy = () => { state.connections.delete(socket.destroy); queueMicrotask(() => socket.emit("close")); };
    state.connections.add(socket.destroy);
    socket.write = frame => {
      const request = JSON.parse(frame.subarray(4).toString());
      state.probe = () => {
        const payload = Buffer.from(JSON.stringify({ type: "health_ok", requestId: request.requestId, protocol: "pi-intercom", version: 1,
          implementation: "spider", features: ["federation-v1"] }));
        const reply = Buffer.alloc(4 + payload.length); reply.writeUInt32BE(payload.length); payload.copy(reply, 4);
        socket.emit("data", reply);
      };
      state.onProbe?.();
    };
    queueMicrotask(() => state.ready ? socket.emit("connect") : socket.emit("error", Object.assign(new Error("absent"), { code: "ENOENT" })));
    return socket;
  } };
});

const roots: string[] = [];
afterEach(() => {
  vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); state.ready = false; state.probe = undefined; state.settings = "settings-unique"; state.failure = undefined; state.onProbe = undefined;
  state.connections.clear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(resolve(".spider/scratch"), "br-")); roots.push(root);
  mkdirSync(join(root, "extensions"), { mode: 0o700 }); mkdirSync(join(root, "intercom"), { mode: 0o700 });
  writeFileSync(join(root, "extensions", "spider.ts"), "fixture-shim", { mode: 0o600 });
  vi.stubEnv("PI_CODING_AGENT_DIR", root); vi.useFakeTimers();
  // Filesystem safety checks use real owned files; only socket inode/type is simulated.
  return { agentDir: root, release: root, sdk: "/home/fixture/sdk.mjs", cwd: root };
}

it("starts after settings resolution and waits for the final broker health reply", async () => {
  const input = fixture();
  state.ready = true; setTimeout(expireBroker, 5000);
  const probing = new Promise<void>(resolve => { state.onProbe = resolve; });
  const result = inspectIntercomReadiness({ ...input, ensureBroker: async () => {
    state.ready = true; setTimeout(expireBroker, 5000);
  } });
  expect(await Promise.race([probing.then(() => "probe"), result.then(() => "completed")])).toBe("probe");
  state.probe!();
  expect(await result).toMatchObject({ intercomUnique: true, legacyDrained: true, federation: true });
});

it("a broker that never answers health remains unavailable at the existing deadline", async () => {
  const input = fixture();
  const probing = new Promise<void>(resolve => { state.onProbe = resolve; });
  const result = inspectIntercomReadiness({ ...input, ensureBroker: async () => { state.ready = true; } });
  await probing;
  await vi.advanceTimersByTimeAsync(2000);
  expect(await result).toMatchObject({ legacyDrained: false, federation: false,
    intercomEvidence: { federation: "intercom-broker-unavailable" } });
});

function boxFixture() {
  const input = fixture(), root = input.agentDir;
  const machineId = "00000000-0000-4000-8000-000000000002";
  mkdirSync(join(root, "roam"), { mode: 0o700 });
  writeFileSync(join(root, "roam", "machine.json"), JSON.stringify({ machineId }), { mode: 0o600 });
  writeFileSync(join(root, "roam", "config.json"), JSON.stringify({ enabled: false, role: "box", machineId,
    hubMachineId: "00000000-0000-4000-8000-000000000001", peers: [], discoveryRoots: [], coreUnit: "fixture" }), { mode: 0o600 });
  const release = join(root, "prefix", "spider-releases", "a".repeat(64), "node_modules", "@guru-irl", "spider");
  writeFileSync(join(root, "roam", "active-release.json"), JSON.stringify(release), { mode: 0o600 });
  const db = openDb(join(root, "spider.db")); migrate(db, "global", { machineId, globalRoot: root }); db.close();
  return { root, machineId };
}

it("box startup returns the final full doctor only after health answers", async () => {
  const f = boxFixture(), out: string[] = [];
  const probing = new Promise<void>(resolve => { state.onProbe = resolve; });
  const starting = main(["--global-root", f.root, "roam", "intercom", "start-broker"], { out: text => out.push(text), err: () => {} });
  expect(await Promise.race([probing.then(() => "probe"), starting.then(() => "completed")])).toBe("probe");
  expect(out).toEqual([]);
  state.probe!();
  expect(await starting).toBe(0);
  const reply = JSON.parse(out.join(""));
  expect(reply).toMatchObject({ ok: true, machineId: f.machineId, doctor: { enabled: false, consumers: [] } });
  expect(reply.doctor.diagnostics.filter((row: { severity: string; reason: string }) => row.severity === "block" && /^intercom-/.test(row.reason))).toEqual([]);
}, 5000);

it.each([
  [new Error("Broker failed to start within timeout\nBroker stderr: private detail"), "broker-start-timeout"],
  [new Error("Failed to spawn intercom broker", { cause: Object.assign(new Error("private path"), { code: "ENOENT" }) }), "ENOENT"],
  [new Error("unsupported-broker"), "unsupported-broker"],
  [new Error("unsupported-broker\nBroker stderr: private detail"), "unsupported-broker"],
  [new Error("broker-start-aborted\nBroker stderr: private detail"), "broker-start-aborted"],
] as const)("box startup retains a bounded failure cause (%s)", async (error, expected) => {
  const f = boxFixture(), out: string[] = []; state.failure = error;
  expect(await main(["--global-root", f.root, "roam", "intercom", "start-broker"], { out: text => out.push(text), err: () => {} })).toBe(0);
  expect(JSON.parse(out.join(""))).toEqual({ version: 1, kind: "intercom-broker-start", ok: false, causeCode: expected });
  expect(out.join("")).not.toContain("private");
}, 5000);

it("box startup reports missing active-release evidence instead of hiding the doctor error", async () => {
  const f = boxFixture(), out: string[] = []; unlinkSync(join(f.root, "roam", "active-release.json"));
  expect(await main(["--global-root", f.root, "roam", "intercom", "start-broker"], { out: text => out.push(text), err: () => {} })).toBe(0);
  expect(JSON.parse(out.join(""))).toMatchObject({ ok: false, causeCode: "active-release-unavailable" });
}, 5000);

it("changed extension settings do not start a broker or become ready", async () => {
  const input = fixture(); state.settings = "settings-spider-missing";
  const result = await inspectIntercomReadiness({ ...input, ensureBroker: async () => { throw new Error("must not start"); } });
  expect(result).toMatchObject({ intercomUnique: false, federation: false,
    intercomEvidence: { settings: "settings-spider-missing" } });
});

it("a real pending ask still blocks readiness after successful broker health", async () => {
  const input = fixture(); mkdirSync(join(input.agentDir, "intercom", "pending-asks"), { mode: 0o700 });
  writeFileSync(join(input.agentDir, "intercom", "pending-asks", "ask.json"), "{}", { mode: 0o600 });
  const probing = new Promise<void>(resolve => { state.onProbe = resolve; });
  const result = inspectIntercomReadiness({ ...input, ensureBroker: async () => { state.ready = true; } });
  await probing; state.probe!();
  expect(await result).toMatchObject({ federation: true, legacyDrained: false, intercomEvidence: { legacy: "legacy-pending-asks" } });
});

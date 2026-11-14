import { expect, it, vi } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, symlinkSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { startTestBroker, stopTestBroker, assertNoTestBrokers, testTmpDir, getTestBrokerOwnership, readTestProcessStart } from "../test-support.js";

vi.mock("node:child_process", async original => {
  const actual = await original<typeof import("node:child_process")>();
  return { ...actual, spawnSync: vi.fn(actual.spawnSync) };
});
vi.mock("node:fs", async original => {
  const actual = await original<typeof import("node:fs")>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});

it("a broker fixture refuses outside and symlinked roots before spawn", () => {
  expect(() => startTestBroker(process.execPath, ["dist/intercom/broker.mjs"], { env: { ...process.env, HOME: "/outside-fixture" } })).toThrow(/fixture/);
  const root = mkdtempSync(join(testTmpDir(), "owned-"));
  try {
    const target = join(root, "target"), link = join(root, "link"); mkdirSync(target); symlinkSync(target, link);
    expect(() => startTestBroker(process.execPath, ["dist/intercom/broker.mjs"], { env: { ...process.env, HOME: link } })).toThrow(/symlink|fixture/);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 5000);

it("records a pid and process start identity before admitting a broker", async () => {
  expect(getTestBrokerOwnership).toBeTypeOf("function");
  const broker = startTestBroker(process.execPath, ["dist/intercom/broker.mjs"], { env: process.env, stdio: "ignore" });
  try {
    const ownership = getTestBrokerOwnership(broker)!;
    expect(ownership.pid).toBe(broker.pid);
    expect(ownership.startIdentity).toBe(readTestProcessStart(broker.pid!));
    expect(ownership.startIdentity).not.toBe("");
  } finally { await stopTestBroker(broker); }
}, 5000);

it("does not signal a recorded pid whose native start identity changed", async () => {
  const nativeFs = await vi.importActual<typeof import("node:fs")>("node:fs");
  const nativeChildren = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  const broker = startTestBroker(process.execPath, ["dist/intercom/broker.mjs"], { env: process.env, stdio: "ignore" });
  const signal = vi.spyOn(broker, "kill");
  try {
    if (process.platform === "linux") vi.mocked(readFileSync).mockReturnValue(`${broker.pid} (node) S ${"0 ".repeat(18)}999999999999999`);
    else vi.mocked(spawnSync).mockReturnValue({ pid: broker.pid!, output: [null, "different-native-birth", ""], stdout: "different-native-birth", stderr: "", status: 0, signal: null });
    await stopTestBroker(broker);
    expect(signal).not.toHaveBeenCalled();
    expect(broker.exitCode).toBeNull();
  } finally {
    vi.mocked(readFileSync).mockImplementation(nativeFs.readFileSync);
    vi.mocked(spawnSync).mockImplementation(nativeChildren.spawnSync);
    await stopTestBroker(broker);
  }
}, 5000);

it("leaves a live pi-intercom argv decoy unowned and unsignalled", async () => {
  const decoy = spawn(process.execPath, ["-e", "process.stdin.resume()", "pi-intercom"], { stdio: ["pipe", "ignore", "ignore"] });
  const exited = once(decoy, "exit");
  const signal = vi.spyOn(decoy, "kill");
  try {
    expect(decoy.pid).toBeTypeOf("number");
    expect(getTestBrokerOwnership(decoy)).toBeNull();
    await expect(stopTestBroker(decoy)).rejects.toThrow(/unowned/);
    expect(() => assertNoTestBrokers()).not.toThrow();
    expect(decoy.exitCode).toBeNull();
    expect(signal).not.toHaveBeenCalled();
  } finally {
    // The decoy exits on stdin EOF. The broker fixture never signals it.
    decoy.stdin!.end(); await exited;
  }
  expect(signal).not.toHaveBeenCalled();
}, 5000);

let failedTestBroker: ReturnType<typeof startTestBroker>;
let timedOutTestBroker: ReturnType<typeof startTestBroker>;
it.fails("a failing broker test still runs owned fixture cleanup", () => {
  failedTestBroker = startTestBroker(process.execPath, ["dist/intercom/broker.mjs"], { env: process.env, stdio: "ignore" });
  throw new Error("synthetic test failure");
}, 5000);
it.fails("a timed-out broker test still runs owned fixture cleanup", async () => {
  timedOutTestBroker = startTestBroker(process.execPath, ["dist/intercom/broker.mjs"], { env: process.env, stdio: "ignore" });
  await new Promise(() => {});
}, 100);
it("failed and timed-out tests cannot leave brokers behind", () => {
  expect(() => assertNoTestBrokers()).not.toThrow();
  for (const broker of [failedTestBroker, timedOutTestBroker]) {
    expect(broker.exitCode !== null || broker.signalCode !== null).toBe(true);
    expect(readTestProcessStart(broker.pid!)).not.toBe(getTestBrokerOwnership(broker)!.startIdentity);
  }
}, 5000);

it("the broker teardown guard rejects a surviving suite-owned process", async () => {
  const broker = startTestBroker(process.execPath, ["dist/intercom/broker.mjs"], { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  try {
    await new Promise<void>((resolve, reject) => {
      broker.once("error", reject);
      broker.stdout!.on("data", chunk => { if (String(chunk).includes("Intercom broker started")) resolve(); });
    });
    expect(() => assertNoTestBrokers()).toThrow(/test broker survived teardown/);
    const exited = once(broker, "exit");
    await stopTestBroker(broker); await exited;
    expect(() => assertNoTestBrokers()).not.toThrow();
    expect(readTestProcessStart(broker.pid!)).not.toBe(getTestBrokerOwnership(broker)!.startIdentity);
  } finally { await stopTestBroker(broker); }
}, 5000);

import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { authorizeTestBridge, getTestBrokerOwnership, readTestProcessStart, startTestBroker, stopTestBroker, testTmpDir } from "../test-support.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { getAgentDirPath } from "./paths.js";
import { IntercomClient, IntercomFederationClient } from "./client.js";
import { FEDERATION_FEATURE, type FederationBridge } from "../protocol.js";

let broker: ChildProcess, fixtureHome: string, bridge: IntercomFederationClient;
const clients: IntercomClient[] = [], receipts: any[] = [], receiptEvents = new EventEmitter();
const adapter: FederationBridge = {
  dispatch: async () => ({ delivery: "queued", retryable: false, outcomeKnown: true, acceptance: { accepted: true, durable: true, location: "source" } }),
  receipt: (from, receipt) => { receipts.push({ from, receipt }); receiptEvents.emit("receipt", { from, receipt }); },
  control: () => {},
};
const registration = { feature: FEDERATION_FEATURE, agentDir: getAgentDirPath(), credential: authorizeTestBridge(getAgentDirPath(), "machine-1"), machineId: "machine-1", machineAlias: "local.invalid" };
beforeAll(async () => {
  fixtureHome = mkdtempSync(join(testTmpDir(), "h-"));
  broker = startTestBroker(process.execPath, ["dist/intercom/broker.mjs"], { env: { ...process.env, HOME: fixtureHome }, stdio: ["ignore", "pipe", "pipe"] }, "suite");
  await new Promise<void>((done, reject) => {
    const timer = setTimeout(() => reject(new Error("fixture broker startup timed out")), 4000);
    broker.once("exit", code => { clearTimeout(timer); reject(new Error(`fixture broker exit ${code}`)); });
    broker.stdout!.on("data", chunk => { if (String(chunk).includes("Intercom broker started")) { clearTimeout(timer); done(); } });
  });
  bridge = new IntercomFederationClient(); await bridge.connect(registration, adapter);
}, 5000);
afterAll(async () => {
  try { for (const client of clients) await client.disconnect(); await bridge?.close(); }
  finally { if (broker) await stopTestBroker(broker); if (fixtureHome) rmSync(fixtureHome, { recursive: true, force: true }); }
}, 5000);
async function session(id: string) {
  const client = new IntercomClient(); clients.push(client);
  await client.connect({ address: { sessionId: id, scopeId: null }, cwd: "/workspace", model: "fixture", pid: process.pid, name: id, startedAt: 1, lastActivity: 1, activationEpoch: `${id}-activation` }, id);
  return client;
}
it("a restored owner forwards physical evidence without a transient broker route", async () => {
  const receiver = await session("restored-recipient"), id = "restored-physical";
  const receipt = { messageId: id, status: "injected" as const, timestamp: 2,
    evidence: { kind: "entry" as const, entryId: "fixture-entry", sessionId: "restored-recipient", activationEpoch: "old-generation" } };
  let finish!: (value: unknown) => void;
  const observed = new Promise(resolve => { finish = resolve; });
  const handler = (value: { receipt: { messageId: string } }) => { if (value.receipt.messageId === id) finish(value); };
  receiptEvents.on("receipt", handler);
  try {
    receiver.sendMessageReceipt({ ...receipt, messageId: "foreign-evidence", evidence: { ...receipt.evidence, sessionId: "other-session" } });
    await receiver.listSessions();
    await bridge.inspectBlockers({ sessionId: "restored-recipient", scopeId: null });
    expect(receipts.some(value => value.receipt.messageId === "foreign-evidence")).toBe(false);
    const owner = getTestBrokerOwnership(broker);
    expect(owner).not.toBeNull();
    expect(readTestProcessStart(owner!.pid)).toBe(owner!.startIdentity);
    expect(broker.kill("SIGSTOP")).toBe(true);
    const resume = () => { if (readTestProcessStart(owner!.pid) === owner!.startIdentity) broker.kill("SIGCONT"); };
    const resumeTimer = setTimeout(resume, 1100);
    try {
      receiver.sendMessageReceipt(receipt);
      const result = await observed;
      expect(result).toEqual({ from: { sessionId: "restored-recipient", scopeId: null }, receipt });
    } finally { clearTimeout(resumeTimer); resume(); }
  } finally { receiptEvents.off("receipt", handler); }
}, 5000);

it("retains restored evidence that arrives before the bridge reconnects", async () => {
  const receiver = await session("prebridge-recipient"), id = "prebridge-evidence";
  const receipt = { messageId: id, status: "injected" as const, timestamp: 2,
    evidence: { kind: "entry" as const, entryId: "fixture-entry", sessionId: "prebridge-recipient", activationEpoch: "old-generation" } };
  await bridge.close(); receiver.sendMessageReceipt(receipt); await receiver.listSessions();
  let finish!: (value: unknown) => void;
  const observed = new Promise(resolve => { finish = resolve; });
  const handler = (value: { receipt: { messageId: string } }) => { if (value.receipt.messageId === id) finish(value); };
  receiptEvents.on("receipt", handler);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  let delay: ReturnType<typeof setTimeout> | undefined;
  const delayedAdapter: FederationBridge = {
    ...adapter,
    receipt(from, value) { delay = setTimeout(() => adapter.receipt(from, value), 1100); },
  };
  try {
    bridge = new IntercomFederationClient(); await bridge.connect(registration, delayedAdapter);
    await bridge.inspectBlockers({ sessionId: "prebridge-recipient", scopeId: null });
    expect(delay).toBeDefined();
    const result = observed;
    await vi.advanceTimersByTimeAsync(1100);
    expect(await result).toEqual({ from: { sessionId: "prebridge-recipient", scopeId: null }, receipt });
  } finally {
    if (delay) clearTimeout(delay);
    vi.useRealTimers();
    receiptEvents.off("receipt", handler);
  }
}, 5000);

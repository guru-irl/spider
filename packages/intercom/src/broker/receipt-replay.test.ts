import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import { startTestBroker, stopTestBroker, testTmpDir, testBrokerEnv } from "../test-support.js";
import { IntercomClient } from "./client.js";

let broker: ChildProcess | undefined, root: string | undefined, client: IntercomClient | undefined;
afterEach(async () => { vi.useRealTimers(); await client?.disconnect(); if (broker) await stopTestBroker(broker); if (root) rmSync(root, { recursive: true, force: true }); });
it.each([320, 1100])("paces %s pending receipts below the broker frame limit", async count => {
  root = mkdtempSync(join(testTmpDir(), "r-"));
  const clock = join(root, "clock"), preload = join(root, "clock.mjs"), start = Date.now();
  writeFileSync(clock, String(start));
  writeFileSync(preload, `import { readFileSync } from 'node:fs'; Date.now = () => Number(readFileSync(${JSON.stringify(clock)}, 'utf8'));`);
  broker = startTestBroker(process.execPath, ["--import", preload, "dist/intercom/broker.mjs"], { env: testBrokerEnv(), stdio: ["ignore", "pipe", "pipe"] }, "suite");
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("broker startup timeout")), 3000);
    broker!.stdout!.on("data", chunk => { if (String(chunk).includes("Intercom broker started")) { clearTimeout(timer); resolve(); } });
  });
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] }); vi.setSystemTime(start);
  client = new IntercomClient(); client.on("error", () => {});
  await client.connect({ cwd: "/workspace", model: "fixture", pid: process.pid, startedAt: 1, lastActivity: 1 }, "replay-recipient");
  const acknowledged = new Set<string>();
  client.onBrokerMessage(frame => { if (frame.type === "receipt_ack") acknowledged.add(frame.messageId); });
  for (let i = 0; i < count; i++) client.sendMessageReceipt({ messageId: `pending-${i}`, status: "injected", timestamp: start });
  for (let tick = 1; tick <= Math.ceil(count / 20); tick++) {
    writeFileSync(clock, String(start + tick * 250));
    await vi.advanceTimersByTimeAsync(250);
    expect(await client.listSessions()).toHaveLength(1);
  }
  expect(client.isConnected()).toBe(true);
  expect(acknowledged.size).toBe(count);
}, 5000);

import { afterAll, beforeAll, expect, it } from "vitest";
import { type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { build } from "vite";
import { createHash } from "node:crypto";
import { builtinModules } from "node:module";
import { IntercomClient } from "./client.js";
import { startTestBroker, stopTestBroker, testTmpDir } from "../test-support.js";

let root: string, OldClient: typeof IntercomClient;
const clients: IntercomClient[] = [], brokers: ChildProcess[] = [];
beforeAll(async () => {
  root = mkdtempSync(join(testTmpDir(), "v-"));
  const source = join(root, "source"); mkdirSync(source);
  const legacy = JSON.parse(readFileSync(new URL("../__tests__/fixtures/legacy-a54638af.json", import.meta.url), "utf8"));
  expect(legacy.commit).toBe("a54638af");
  for (const [name, value] of Object.entries(legacy.files) as Array<[string, { source: string; sha256: string }]>) {
    expect(createHash("sha256").update(value.source).digest("hex")).toBe(value.sha256);
    const file = join(source, "packages/intercom/src", name); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, value.source);
  }
  for (const [entry, outfile, format] of [["broker", "old-broker.mjs", "esm"], ["client", "old-client.cjs", "cjs"]] as const) {
    await build({ configFile: false, logLevel: "silent", build: { ssr: join(source, `packages/intercom/src/broker/${entry}.ts`), outDir: root, emptyOutDir: false, minify: false, rolldownOptions: { external: id => builtinModules.includes(id) || id.startsWith("node:"), output: { format: format === "esm" ? "es" : "cjs", entryFileNames: outfile, codeSplitting: false } } } });
  }
  OldClient = createRequire(import.meta.url)(join(root, "old-client.cjs")).IntercomClient;
}, 5000);
afterAll(async () => {
  for (const client of clients) await client.disconnect();
  for (const broker of brokers) await stopTestBroker(broker);
  if (root) rmSync(root, { recursive: true, force: true });
}, 5000);

for (const version of ["old", "new"] as const) {
  for (const status of ["matched_waiter", "not_injected", "unknown", "injected"] as const) {
    it(`${version} broker keeps mixed clients connected after ${status}`, async () => {
      const agent = mkdtempSync(join(root, "a-"));
      const prior = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = agent;
      try {
        const broker = startTestBroker(process.execPath, [version === "old" ? join(root, "old-broker.mjs") : "dist/intercom/broker.mjs"], { env: { ...process.env, HOME: root }, stdio: ["ignore", "pipe", "pipe"] }, "suite");
        brokers.push(broker);
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("broker startup timeout")), 3000);
          broker.once("exit", code => { clearTimeout(timer); reject(new Error(`broker exit ${code}`)); });
          broker.stdout!.on("data", chunk => { if (String(chunk).includes("Intercom broker started")) { clearTimeout(timer); resolve(); } });
        });
        const sender = version === "new" ? new OldClient() : new IntercomClient(), receiver = new IntercomClient();
        clients.push(sender, receiver); sender.on("error", () => {}); receiver.on("error", () => {});
        const registration = { cwd: "/workspace", model: "fixture", pid: process.pid, startedAt: 1, lastActivity: 1 };
        await sender.connect(registration, "sender"); await receiver.connect(registration, "receiver");
        expect((await sender.send("receiver", { messageId: "receipt-test", text: "synthetic" })).delivered).toBe(true);
        receiver.sendMessageReceipt({ messageId: "receipt-test", status, timestamp: Date.now() });
        expect(await receiver.listSessions()).toHaveLength(2);
        // A round trip on the other socket runs after the broker forwards the receipt.
        expect(await sender.listSessions()).toHaveLength(2);
        expect(receiver.isConnected()).toBe(true); expect(sender.isConnected()).toBe(true);
        await sender.disconnect(); await receiver.disconnect(); await stopTestBroker(broker);
        brokers.splice(brokers.indexOf(broker), 1);
      } finally { process.env.PI_CODING_AGENT_DIR = prior; }
    }, 5000);
  }
}

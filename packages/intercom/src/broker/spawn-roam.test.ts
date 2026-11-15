import { vi, it } from "vitest";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import test from "../test-support.js";
import assert from "node:assert/strict";
import net from "node:net";
import path from "node:path";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { createMessageReader, writeMessage } from "./framing.js";
import { spawnBrokerIfNeeded } from "./spawn.js";

async function fakeBroker(legacy = false, first: "normal" | "slow" | "close" = "normal") {
  const agentDir = mkdtempSync(path.join(path.resolve(".spider/scratch"), "spawn-agent-"));
  const intercomDir = path.join(agentDir, "intercom"); mkdirSync(intercomDir, { mode: 0o700 });
  const socketPath = path.join(intercomDir, "broker.sock");
  let connections = 0;
  const server = net.createServer(socket => {
    const index = ++connections;
    socket.on("error", () => {});
    socket.on("data", createMessageReader(value => {
      if (index === 1 && first === "close") { socket.end(); return; }
      if (index === 1 && first === "slow") return;
      const message = value as { requestId: string };
      writeMessage(socket, legacy ? { type: "health_ok", requestId: message.requestId }
        : { type: "health_ok", requestId: message.requestId, protocol: "pi-intercom", version: 1 });
    }, () => socket.destroy()));
  });
  await new Promise<void>((resolve, reject) => server.once("error", reject).listen(socketPath, resolve));
  return { agentDir, socketPath, async close() { await new Promise<void>(resolve => server.close(() => resolve())); rmSync(agentDir, { recursive: true, force: true }); } };
}

test("spawnBrokerIfNeeded probes the explicitly configured pi agent directory", async () => {
  const broker = await fakeBroker();
  try { await spawnBrokerIfNeeded("/nonexistent-fixture-command", [], { agentDir: broker.agentDir }); }
  finally { await broker.close(); }
});

test("an occupied legacy socket is never replaced by a newly spawned broker", async () => {
  const broker = await fakeBroker(true);
  try {
    await assert.rejects(() => spawnBrokerIfNeeded("/nonexistent-fixture-command", [], { agentDir: broker.agentDir }), /unsupported-broker/);
    assert.equal(existsSync(broker.socketPath), true);
  } finally { await broker.close(); }
});

test("an aborted startup does not create runtime files", async () => {
  const agentDir = mkdtempSync(path.join(path.resolve(".spider/scratch"), "spawn-agent-"));
  const abort = new AbortController(); abort.abort();
  try {
    await assert.rejects(() => spawnBrokerIfNeeded("/nonexistent-fixture-command", [], { agentDir, signal: abort.signal }), /aborted/);
    assert.equal(existsSync(path.join(agentDir, "intercom")), false);
  } finally { rmSync(agentDir, { recursive: true, force: true }); }
});

for (const first of ["slow", "close"] as const) it(`an inconclusive ${first} health probe retries without replacing the socket`, async () => {
  const broker = await fakeBroker(false, first);
  try { await spawnBrokerIfNeeded("/nonexistent-fixture-command", [], { agentDir: broker.agentDir }); }
  finally { await broker.close(); }
}, 5000);
for (const permission of [false, true]) it(`an aged spawn lock is reclaimed even with a live or inaccessible pid (${permission})`, async () => {
  const agentDir = mkdtempSync(path.join(path.resolve(".spider/scratch"), "spawn-agent-"));
  mkdirSync(path.join(agentDir, "intercom"), { mode: 0o700 });
  writeFileSync(path.join(agentDir, "intercom", "broker.spawn.lock"), `${process.pid}\n${Date.now() - 11_000}\n`, { mode: 0o600 });
  const native = process.kill;
  const spy = permission ? vi.spyOn(process, "kill").mockImplementation(((pid: number, signal: any) => {
    if (pid === process.pid && signal === 0) throw Object.assign(new Error("permission"), { code: "EPERM" });
    return native(pid, signal);
  }) as typeof process.kill) : undefined;
  const abort = new AbortController(), timer = setTimeout(() => abort.abort(), 150);
  try { await assert.rejects(() => spawnBrokerIfNeeded("/nonexistent-fixture-command", [], { agentDir, signal: abort.signal }), /Failed to spawn|ENOENT/); }
  finally { clearTimeout(timer); spy?.mockRestore(); rmSync(agentDir, { recursive: true, force: true }); }
}, 5000);

it("an aged unreadable spawn lock uses its filesystem timestamp", async () => {
  const agentDir = mkdtempSync(path.join(path.resolve(".spider/scratch"), "spawn-agent-"));
  mkdirSync(path.join(agentDir, "intercom"), { mode: 0o700 });
  const lock = path.join(agentDir, "intercom", "broker.spawn.lock"), past = new Date(Date.now() - 11_000);
  writeFileSync(lock, `${process.pid}\n${Date.now()}\n`, { mode: 0o600 }); utimesSync(lock, past, past);
  const read = fs.readFileSync;
  const spy = vi.spyOn(fs, "readFileSync").mockImplementation((file, options) => {
    if (file === lock) throw Object.assign(new Error("unreadable fixture lock"), { code: "EACCES" });
    return read(file, options);
  });
  syncBuiltinESMExports();
  const abort = new AbortController(), timer = setTimeout(() => abort.abort(), 150);
  try { await assert.rejects(() => spawnBrokerIfNeeded("/nonexistent-fixture-command", [], { agentDir, signal: abort.signal }), /Failed to spawn|ENOENT/); }
  finally { clearTimeout(timer); spy.mockRestore(); syncBuiltinESMExports(); rmSync(agentDir, { recursive: true, force: true }); }
}, 5000);

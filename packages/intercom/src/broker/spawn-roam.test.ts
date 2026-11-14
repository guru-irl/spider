import test from "../test-support.js";
import assert from "node:assert/strict";
import net from "node:net";
import path from "node:path";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createMessageReader, writeMessage } from "./framing.js";
import { spawnBrokerIfNeeded } from "./spawn.js";

async function fakeBroker(legacy = false) {
  const agentDir = mkdtempSync(path.join(path.resolve(".spider/scratch"), "spawn-agent-"));
  const intercomDir = path.join(agentDir, "intercom"); mkdirSync(intercomDir, { mode: 0o700 });
  const socketPath = path.join(intercomDir, "broker.sock");
  const server = net.createServer(socket => {
    socket.on("data", createMessageReader(value => {
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

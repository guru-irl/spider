import { afterEach, expect, it } from "vitest";
import net from "node:net";
import { once } from "node:events";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import "../test-support.js";
import { IntercomFederationClient, FederationRequestNotSentError } from "./client.js";
import { createMessageReader, writeMessage } from "./framing.js";
import { getAgentDirPath, getBrokerSocketPath } from "./paths.js";
import { FEDERATION_FEATURE, type FederationBridge, type RemoteSessionInfo } from "../protocol.js";

const from: RemoteSessionInfo = { remote: true, id: "source", address: { sessionId: "source", scopeId: null }, machineId: "source-machine", machineAlias: "source.invalid",
  homeEpoch: null, activationEpoch: "source-activation", endpointEpoch: "source-activation", cwd: "/fixture", model: "fixture", startedAt: 1, lastActivity: 1 };
const to = { address: { sessionId: "recipient", scopeId: null }, machineId: "recipient-machine", homeEpoch: null, activationEpoch: "recipient-activation" };
const message = { id: "request", timestamp: 1, content: { text: "x" } };
const clients: IntercomFederationClient[] = [], sockets = new Set<net.Socket>(); let server: net.Server | undefined;
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  for (const socket of sockets) socket.destroy(); sockets.clear();
  if (server) { await new Promise<void>(resolve => server!.close(() => resolve())); server = undefined; }
});
function client() { const value = new IntercomFederationClient(); clients.push(value); return value; }

it("proves a disconnected federation request was rejected before a socket write", async () => {
  expect(FederationRequestNotSentError).toBeTypeOf("function");
  await expect(client().deliver(from, to, message)).rejects.toBeInstanceOf(FederationRequestNotSentError);
}, 5000);

it("does not claim not-sent when the broker saw the request then disconnected", async () => {
  expect(FederationRequestNotSentError).toBeTypeOf("function");
  let requests = 0;
  server = net.createServer(socket => {
    sockets.add(socket); socket.once("close", () => sockets.delete(socket)); socket.on("error", () => {});
    socket.on("data", createMessageReader(value => {
      if (!value || typeof value !== "object" || !("type" in value)) { socket.destroy(); return; }
      if (value.type === "federation_register") writeMessage(socket, { type: "federation_registered", features: [FEDERATION_FEATURE] });
      else if (value.type === "federation_deliver") { requests++; socket.destroy(); }
    }, () => socket.destroy()));
  });
  const path = getBrokerSocketPath(); mkdirSync(dirname(path), { recursive: true });
  server.listen(path); await once(server, "listening");
  const bridge: FederationBridge = { dispatch: async () => ({ delivery: "unknown", retryable: false, outcomeKnown: false, acceptance: { accepted: false, durable: false } }), receipt() {}, control() {} };
  const connection = client();
  await connection.connect({ feature: FEDERATION_FEATURE, agentDir: getAgentDirPath(), machineId: "recipient-machine", machineAlias: "recipient.invalid" }, bridge);
  const error = await connection.deliver(from, to, message).catch(error => error);
  expect(requests).toBe(1); expect(error).toBeInstanceOf(Error); expect(error).not.toBeInstanceOf(FederationRequestNotSentError);
}, 5000);

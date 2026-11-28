import test from "../test-support.js";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdirSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { vi } from "vitest";

import { IntercomClient } from "./client.js";
import { createMessageReader, writeMessage } from "./framing.js";
import { getBrokerSocketPath } from "./paths.js";

async function connectedClient() {
  const socketPath = getBrokerSocketPath();
  if (process.platform !== "win32") mkdirSync(path.dirname(socketPath), { recursive: true });
  let accept!: (socket: net.Socket) => void;
  const accepted = new Promise<net.Socket>(resolve => { accept = resolve; });
  const received: unknown[] = [];
  const server = net.createServer({ allowHalfOpen: true }, peer => {
    peer.on("error", () => {});
    peer.on("data", createMessageReader(message => {
      received.push(message);
      if ((message as { type: string }).type === "register") {
        writeMessage(peer, { type: "registered", sessionId: "disconnect-test", features: [] });
      }
      if ((message as { type: string }).type === "unregister") peer.end();
    }, error => { throw error; }));
    accept(peer);
  });
  server.listen(socketPath);
  await once(server, "listening");
  const client = new IntercomClient();
  await client.connect({ name: "disconnect-test", cwd: "/", model: "test", pid: process.pid, startedAt: 1, lastActivity: 1 });
  const peer = await accepted;
  const socket = (client as unknown as { socket: net.Socket }).socket;
  return {
    client, peer, socket, received,
    async cleanup() {
      peer.destroy();
      socket.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}

for (const endWritable of [false, true]) {
  test(`disconnect after broker FIN does not write or emit a client error (writable ended: ${endWritable})`, async () => {
    const fixture = await connectedClient();
    const errors: Error[] = [];
    fixture.client.on("error", error => errors.push(error));
    try {
      let writes: ReturnType<typeof vi.spyOn>;
      const disconnected = new Promise<void>((resolve, reject) => {
        fixture.socket.once("end", () => {
          if (endWritable) fixture.socket.end();
          writes = vi.spyOn(fixture.socket, "write");
          fixture.client.disconnect().then(resolve, reject);
        });
      });
      fixture.peer.end();
      await disconnected;
      assert.deepEqual(errors.map(error => (error as NodeJS.ErrnoException).code), []);
      assert.equal(writes!.mock.calls.length, 0, "no unregister write after FIN");
    } finally {
      await fixture.cleanup();
    }
  });
}

for (const code of ["EPIPE", "ECONNRESET"]) {
  test(`disconnect does not emit expected ${code} socket errors`, async () => {
    const fixture = await connectedClient();
    const errors: Error[] = [];
    fixture.client.on("error", error => errors.push(error));
    try {
      const disconnecting = fixture.client.disconnect();
      fixture.socket.emit("error", Object.assign(new Error(code), { code }));
      await disconnecting;
      assert.deepEqual(errors, []);
    } finally {
      await fixture.cleanup();
    }
  });
}

test("an EPIPE outside disconnect still emits a client error", async () => {
  const fixture = await connectedClient();
  const errors: Error[] = [];
  fixture.client.on("error", error => errors.push(error));
  try {
    const closed = new Promise<void>(resolve => fixture.socket.once("close", () => resolve()));
    const error = Object.assign(new Error("broken pipe"), { code: "EPIPE" });
    fixture.socket.emit("error", error);
    await closed;
    assert.deepEqual(errors, [error]);
  } finally {
    await fixture.cleanup();
  }
});

test("disconnect still emits unexpected socket errors", async () => {
  const fixture = await connectedClient();
  const errors: Error[] = [];
  fixture.client.on("error", error => errors.push(error));
  try {
    const disconnecting = fixture.client.disconnect();
    const error = Object.assign(new Error("unexpected"), { code: "EIO" });
    fixture.socket.emit("error", error);
    await disconnecting;
    assert.deepEqual(errors, [error]);
  } finally {
    await fixture.cleanup();
  }
});

test("disconnect sends unregister while the broker is connected", async () => {
  const fixture = await connectedClient();
  try {
    await fixture.client.disconnect();
    assert.deepEqual(fixture.received.map(message => (message as { type: string }).type), ["register", "unregister"]);
  } finally {
    await fixture.cleanup();
  }
});

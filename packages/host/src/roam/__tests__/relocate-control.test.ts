import { expect, it, vi } from "vitest";
import { createConnection } from "node:net";
import { resolve } from "node:path";
import type { Operation } from "@spider/roam/contracts";
import type { MovingHome, RelocateHome, SessionId } from "@spider/roam/relocate/types";
import { requestSessionControl, sessionControlPath } from "@spider/roam/session-socket";
import { serveRelocateShutdown } from "../relocate-control";

const machineId = "11111111-1111-4111-8111-111111111111";
const root = resolve(".spider/scratch/dsh");
function raw(path: string, operation: Operation, op = "shutdown"): Promise<any> {
  return new Promise((done, reject) => {
    const socket = createConnection(path); let reply = "";
    socket.on("error", reject); socket.on("connect", () => socket.write(JSON.stringify({ op, operation }) + "\n"));
    socket.on("data", data => { reply += data; }); socket.on("end", () => done(JSON.parse(reply)));
  });
}
it("v0 shutdown calls pi shutdown without a freeze", async () => {
  const sessionId = `session-${crypto.randomUUID()}` as SessionId;
  const moving: MovingHome = { sessionId, machineId, epoch: 2, state: "moving", moveId: "v0-move" as never, destination: "22222222-2222-4222-8222-222222222222", updatedAt: 1 };
  let home: RelocateHome | null = moving;
  const shutdown = vi.fn(async () => {});
  const deferred = { readFreeze: vi.fn(), freezeParticipant: vi.fn(), inventory: vi.fn(), intercom: vi.fn() };
  const server = await serveRelocateShutdown({ sessionId, machineId, runtimeRoot: root, home: async () => home, shutdown, ...deferred });
  const operation: Operation = { id: "v0-shutdown", machineId, kind: "session-shutdown", expectedEpoch: 2, args: { sessionId, moveId: "v0-move", v0: true } };
  try {
    expect(await requestSessionControl(root, operation)).toMatchObject({ code: 0, value: { version: 1, sessionId } });
    expect(await requestSessionControl(root, operation)).toMatchObject({ code: 0 }); expect(shutdown).toHaveBeenCalledOnce();
    for (const spy of Object.values(deferred)) expect(spy).not.toHaveBeenCalled();
    const bad = [
      { ...operation, args: { ...operation.args, sessionId: "wrong-session" } },
      { ...operation, machineId: "33333333-3333-4333-8333-333333333333" },
      { ...operation, args: { ...operation.args, moveId: "v0-other" } },
      { ...operation, expectedEpoch: 3 }, { ...operation, args: { ...operation.args, v0: false } },
      { ...operation, kind: "session-freeze" },
    ];
    for (const [index, request] of bad.entries()) expect((await raw(sessionControlPath(root, sessionId), { ...request, id: `bad-${index}` }, request.kind === "session-freeze" ? "freeze" : "shutdown")).code).not.toBe(0);
    home = { ...moving, state: "running", destination: null }; expect((await requestSessionControl(root, { ...operation, id: "running" })).code).not.toBe(0);
    home = null; expect((await requestSessionControl(root, { ...operation, id: "missing" })).code).not.toBe(0);
    expect(shutdown).toHaveBeenCalledOnce();
  } finally { await server.close(); }
});
it("an unavailable home refuses shutdown and closes cleanly", async () => {
  const sessionId = `session-${crypto.randomUUID()}` as SessionId; const shutdown = vi.fn(async () => {});
  const server = await serveRelocateShutdown({ sessionId, machineId, runtimeRoot: root, home: async () => { throw new Error("db failed"); }, shutdown });
  try {
    const result = await requestSessionControl(root, { id: "v0-no-home", machineId, kind: "session-shutdown", expectedEpoch: 2, args: { sessionId, moveId: "v0-move", v0: true } });
    expect(result.code).not.toBe(0); expect(shutdown).not.toHaveBeenCalled();
  } finally { await server.close(); await server.close(); }
});

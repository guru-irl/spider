import { afterEach, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { HomeAdmission, RunningHome, SessionId } from "@spider/roam/relocate/types";
import { createHostSessionFixture } from "../../__tests__/fixtures/pi-events";
import { protectAdmissionApi, registerAdmission, type AdmissionGate, type AdmissionPorts } from "../admission";

const id = "session-v0" as SessionId;
const local = "11111111-1111-4111-8111-111111111111";
const home: RunningHome = { sessionId: id, machineId: local, epoch: 3, state: "running", destination: null, moveId: null, updatedAt: 1 };
const gates: AdmissionGate[] = [];
afterEach(async () => { for (const gate of gates.splice(0)) await gate.close(); vi.unstubAllEnvs(); });
function fixture(initial: HomeAdmission) {
  vi.stubEnv("PI_SUBAGENT_CHILD", "0");
  let current = initial;
  const release = vi.fn(async () => {}), close = vi.fn(async () => {});
  const ports: AdmissionPorts = {
    expectedEpoch: null, localMachine: vi.fn(async () => local), knownParticipant: () => false, warnOnce: vi.fn(),
    prepare: vi.fn(async () => {}), ready: vi.fn(async () => {}), stopped: vi.fn(async () => {}),
    load: vi.fn(async () => ({ home: null, states: [], origin: null, participating: false, captureSafe: true, unfinishedFreeze: false, initialConflict: false })),
    lock: vi.fn(async () => release), v0Lookup: vi.fn(async () => current), v0Ready: vi.fn(async () => ({ close })),
  };
  const host = createHostSessionFixture({ cwd: "/fixture", sessionId: id, sessionFile: "/fixture/session.jsonl", hasUI: false });
  const gate = registerAdmission(host.pi as unknown as ExtensionAPI, ports); gates.push(gate);
  async function emit(name: string, event = {}) { let result; for (const fn of host.hooks.get(name) ?? []) result = await fn(event, host.ctx); return result; }
  return { gate, ports, release, close, emit, host, setHome(value: HomeAdmission) { current = value; } };
}
it("only local running v0 home admits", async () => {
  const good = fixture({ kind: "managed", home }); await good.emit("session_start");
  expect(good.gate.inspect()).toEqual({ kind: "ordinary", home, blockers: [] }); expect(good.ports.lock).toHaveBeenCalledWith(id, "/fixture/session.jsonl");
  expect(good.ports.v0Ready).toHaveBeenCalledWith(id, "/fixture/session.jsonl", home);
  for (const ports of [good.ports.prepare, good.ports.load, good.ports.ready]) expect(ports).not.toHaveBeenCalled();
  for (const denied of [null, { ...home, machineId: "22222222-2222-4222-8222-222222222222" }, { ...home, state: "stopped" as const }, { ...home, state: "moving" as const, moveId: "v0-move" as never, destination: local }]) {
    const f = fixture({ kind: "managed", home: denied }); await f.emit("session_start");
    expect(f.gate.inspect().kind).toBe("blocked"); expect(await f.emit("input")).toEqual({ action: "handled" });
    expect(await f.emit("tool_call")).toMatchObject({ block: true });
    const send = vi.fn(); const api = protectAdmissionApi({ sendMessage: send } as unknown as ExtensionAPI, f.gate);
    expect(() => api.sendMessage({ customType: "test", content: "x", display: true })).toThrow(); expect(send).not.toHaveBeenCalled();
    for (const port of [f.ports.prepare, f.ports.load, f.ports.ready, f.ports.lock]) expect(port).not.toHaveBeenCalled();
  }
});
it("unavailable managed home blocks admission", async () => {
  const f = fixture({ kind: "unavailable" }); await f.emit("session_start"); expect(f.gate.inspect().kind).toBe("blocked");
  for (const port of [f.ports.prepare, f.ports.load, f.ports.ready, f.ports.lock]) expect(port).not.toHaveBeenCalled();
  const thrown = fixture({ kind: "unmanaged" }); vi.mocked(thrown.ports.v0Lookup!).mockRejectedValueOnce(new Error("DB unavailable"));
  await thrown.emit("session_start"); expect(thrown.gate.inspect().kind).toBe("blocked"); expect(thrown.ports.load).not.toHaveBeenCalled();
  const legacy = fixture({ kind: "unmanaged" }); await legacy.emit("session_start"); expect(legacy.gate.inspect().kind).toBe("ordinary");
  expect(legacy.ports.prepare).toHaveBeenCalledOnce(); expect(legacy.ports.load).toHaveBeenCalledOnce(); expect(legacy.ports.v0Ready).not.toHaveBeenCalled();
});
it("home changed while claiming a lock refuses", async () => {
  const f = fixture({ kind: "managed", home });
  vi.mocked(f.ports.lock).mockImplementationOnce(async () => { f.setHome({ kind: "managed", home: { ...home, epoch: 4, state: "moving", moveId: "v0-move" as never, destination: local } }); return f.release; });
  await f.emit("session_start"); expect(f.gate.inspect().kind).toBe("blocked"); expect(f.release).toHaveBeenCalledOnce(); expect(f.ports.v0Ready).not.toHaveBeenCalled();
  expect(f.ports.ready).not.toHaveBeenCalled(); await expect(f.gate.freeze("v0-move", 3)).rejects.toThrow();
});
it("v0 readiness admits background sessions without legacy enrollment", async () => {
  const f = fixture({ kind: "managed", home }); await f.emit("session_start"); expect(f.host.ctx.hasUI).toBe(false);
  expect(f.ports.v0Ready).toHaveBeenCalledWith(id, "/fixture/session.jsonl", home);
  await f.emit("session_shutdown", { reason: "exit" }); expect(f.close).toHaveBeenCalledOnce(); expect(f.ports.stopped).not.toHaveBeenCalled();
});
it("a previously managed session cannot become ordinary when its home disappears", async () => {
  const f = fixture({ kind: "managed", home }); await f.emit("session_start");
  f.setHome({ kind: "unmanaged" }); await f.emit("session_start"); expect(f.gate.inspect().kind).toBe("blocked");
  expect(f.ports.prepare).not.toHaveBeenCalled(); expect(f.ports.load).not.toHaveBeenCalled(); expect(f.close).toHaveBeenCalledOnce(); expect(f.release).toHaveBeenCalledOnce();
});

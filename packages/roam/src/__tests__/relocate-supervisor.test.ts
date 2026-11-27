import { afterEach, describe, expect, it, vi } from "vitest";
import type { MachineId } from "@spider/db-core/roam/types";
import type { Clock } from "../contracts";
import type { HomeSupervisorPorts, RelocateHome, RunningHome, SessionId, SessionOwner, SessionPlacement, SupervisorEntry } from "../relocate/types";
import { createHomeSupervisor } from "../relocate/supervisor";

const local = "box-a" as MachineId;
const foreign = "box-b" as MachineId;
const id = "session-a" as SessionId;
const running = (epoch = 1): RunningHome => ({ sessionId: id, machineId: local, epoch, moveId: null, updatedAt: 1, state: "running", destination: null });
const placement: SessionPlacement = { sessionId: id, machineId: local, repoKey: "repo", workspaceId: "ws", repository: "/repo", cwd: "/repo", file: "/session.jsonl", stores: [], historyMachine: local };
const ok = { ok: true as const, value: undefined } as const;
function fixture() {
  let entries: readonly SupervisorEntry[] = [{ sessionId: id, home: running(), placement }];
  let owner: SessionOwner = { kind: "free" };
  const effects: string[] = [];
  const clock: Clock = { now: Date.now, later: (ms, fn) => { const timer = setTimeout(fn, ms); return () => clearTimeout(timer); } };
  const ports: HomeSupervisorPorts = {
    machineId: local, clock, entries: vi.fn(async () => entries), owner: vi.fn(async () => owner),
    stop: vi.fn(async (session) => { effects.push(`stop:${session}`); return ok; }),
    activate: vi.fn(async (home) => { effects.push(`activate:${home.epoch}`); return ok; }),
    start: vi.fn(async (home) => { effects.push(`start:${home.epoch}`); return { ok: true as const, value: { terminal: "core:term" } }; }),
    report: vi.fn(),
  };
  return { ports, effects, setEntries: (value: readonly SupervisorEntry[]) => { entries = value; }, setOwner: (value: SessionOwner) => { owner = value; } };
}
afterEach(() => vi.useRealTimers());
describe("v0 home supervisor", () => {
  it("local running home starts one missing session", async () => {
    const f = fixture(); const loop = createHomeSupervisor(f.ports);
    await loop.tick(); expect(f.effects).toEqual(["activate:1", "start:1"]);
    f.setOwner({ kind: "live", pid: 42, terminal: "core:term" });
    await loop.tick(); f.setEntries([{ sessionId: id, home: running(3), placement }]); await loop.tick();
    expect(f.effects).toEqual(["activate:1", "start:1", "activate:1", "activate:3"]);
    f.setOwner({ kind: "free" });
    const denied: (RelocateHome | null)[] = [null, { ...running(), machineId: foreign }, { ...running(), state: "stopped" }, { ...running(), state: "moving", moveId: "v0-move" as never, destination: local }];
    for (const home of denied) { f.setEntries([{ sessionId: id, home, placement }]); await loop.tick(); }
    expect(f.ports.start).toHaveBeenCalledTimes(1);
  });
  it("missing managed home stops the runner", async () => {
    const f = fixture(); const loop = createHomeSupervisor(f.ports);
    f.setOwner({ kind: "live", pid: 42, terminal: null }); await loop.tick();
    for (const home of [null, { ...running(), machineId: foreign }, { ...running(), state: "stopped" as const }, { ...running(), state: "moving" as const, moveId: "v0-move" as never, destination: foreign }]) {
      f.setEntries([{ sessionId: id, home, placement }]); await loop.tick();
    }
    f.setEntries([]); await loop.tick();
    expect(f.ports.stop).toHaveBeenCalledWith(id);
    expect(f.ports.start).not.toHaveBeenCalled();
    expect(f.effects.every(e => !e.includes("ordinary-session"))).toBe(true);
  });
  it.each([true, false])("crashed pi restarts within one minute while hub is offline (sync enabled=%s)", async (enabled) => {
    vi.useFakeTimers(); const f = fixture();
    // Replication configuration is not a permission to run; only the local home is.
    Object.assign(f.ports, { enabled, hub: vi.fn(() => { throw new Error("offline"); }), intercom: vi.fn(), preflight: vi.fn(), intent: vi.fn(), reservation: vi.fn(), power: vi.fn() });
    f.setOwner({ kind: "live", pid: 42, terminal: null }); const loop = createHomeSupervisor(f.ports); loop.start();
    await vi.advanceTimersByTimeAsync(0); f.setOwner({ kind: "free" });
    await vi.advanceTimersByTimeAsync(10_000); expect(f.ports.start).toHaveBeenCalledTimes(1);
    for (const name of ["hub", "intercom", "preflight", "intent", "reservation", "power"]) expect((f.ports as unknown as Record<string, unknown>)[name]).not.toHaveBeenCalled();
    await loop.stop();
  });
  it("unknown owner never starts", async () => {
    const f = fixture(); f.setOwner({ kind: "unknown" }); const loop = createHomeSupervisor(f.ports);
    await loop.tick(); expect(f.ports.start).not.toHaveBeenCalled(); expect(f.ports.report).toHaveBeenCalledTimes(1);
    vi.mocked(f.ports.entries).mockRejectedValueOnce(new Error("db offline")); await loop.tick();
    expect(f.ports.stop).toHaveBeenCalledWith(id); expect(f.ports.owner).toHaveBeenCalledTimes(1);
  });
  it("logs an actionable refusal once for repeated supervisor failures", async () => {
    const f = fixture(); f.setOwner({kind:"unknown"});
    const output: string[] = [];
    const loop = createHomeSupervisor(f.ports, line => output.push(line));
    await loop.tick(); await loop.tick();
    expect(output).toHaveLength(1);
    expect(output[0]).toContain("session-a");
    expect(output[0]).toContain("start-pending");
    expect(output[0]).toContain("Check the local session owner before trying again.");
  });
  it("ticks serialize and stop drains", async () => {
    vi.useFakeTimers(); const f = fixture(); let release!: () => void;
    vi.mocked(f.ports.start).mockImplementationOnce(async () => { await new Promise<void>(r => { release = r; }); return { ok: true as const, value: { terminal: "term" } }; });
    const loop = createHomeSupervisor(f.ports); const first = loop.tick();
    await vi.waitFor(() => expect(f.ports.start).toHaveBeenCalledTimes(1));
    const second = loop.tick(); let drained = false; const stopping = loop.stop().then(() => { drained = true; });
    await Promise.resolve(); expect(drained).toBe(false); expect(f.ports.start).toHaveBeenCalledTimes(1);
    release(); await Promise.all([first, second, stopping]); expect(drained).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000); expect(f.ports.start).toHaveBeenCalledTimes(1);
  });
  it("one session failure does not prevent another eligible session", async () => {
    const f = fixture(); const other = "session-b" as SessionId;
    f.setEntries([{ sessionId: id, home: running(), placement }, { sessionId: other, home: { ...running(), sessionId: other }, placement: { ...placement, sessionId: other } }]);
    vi.mocked(f.ports.activate).mockRejectedValueOnce(new Error("failed"));
    await createHomeSupervisor(f.ports).tick();
    expect(f.ports.report).toHaveBeenCalledTimes(1); expect(f.ports.start).toHaveBeenCalledWith({ ...running(), sessionId: other }, { ...placement, sessionId: other });
  });
});

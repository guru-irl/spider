import { afterEach, describe, expect, it, vi } from "vitest";
import { createConnection } from "node:net";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DEFAULT_LIMITS, disabledIntercom, type RoamConfig } from "../contracts";
import type { RunningHome, SessionId, V0ControlServices } from "../relocate/types";
import { parseV0Control, runV0Control } from "../relocate/cli";
import { serveV0Control, requestV0Services } from "../relocate/service";
import { parsePublicControl } from "../commands";
import { main } from "../cli";
import * as legacySocket from "../control-socket";
import * as productionHub from "../production-hub";
import * as productionSupervisor from "../production-supervisor";
import * as controls from "../production-controls";
import * as diagnostics from "../local-diagnostics";

const mac = "11111111-1111-4111-8111-111111111111", box = "22222222-2222-4222-8222-222222222222";
const config: RoamConfig = { enabled: true, role: "hub", machineId: mac, hubMachineId: mac, peers: [{ machineId: box, alias: "box-a", node: "/node", pi: "/pi", cli: "/spider", core: "/core", globalRoot: "/root" }], discoveryRoots: [], coreUnit: "core", syncMs: 10_000, limits: DEFAULT_LIMITS, intercom: disabledIntercom() };
const catalog = [{ id: "session-abc", name: "first" }, { id: "session-abd", name: "second" }, { id: "first", name: null }];
const home: RunningHome = { sessionId: "session-abc" as SessionId, machineId: box, epoch: 3, updatedAt: 1, state: "running", destination: null, moveId: null };
const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(confirmation: string | null = null) {
  const out: string[] = [], err: string[] = [], prompts: string[] = [];
  const services: V0ControlServices = {
    relocate: vi.fn(async () => ({ ok: true, value: { moveId: null, home, terminal: "core:term", disposition: "relocated", placement: { sessionId: home.sessionId, machineId: box, repoKey: "repo", workspaceId: "ws", repository: "/repo", cwd: "/repo", file: "/session.jsonl", stores: [], historyMachine: mac } } })),
    setHome: vi.fn(async () => ({ ok: true, value: home })),
  };
  const io = { out: (text: string) => out.push(text), err: (text: string) => err.push(text), confirmation: vi.fn(async (prompt: string) => { prompts.push(prompt); return confirmation; }) };
  return { out, err, prompts, services, io };
}
describe("v0 controls", () => {
  it("the private v0 socket dispatches only the new services", async () => {
    const f = fixture(); const root = mkdtempSync(join(resolve(".spider/scratch"), "dvs-")); roots.push(root);
    const socket = await serveV0Control(root, f.services);
    try {
      const client = requestV0Services(root);
      expect(await client.relocate({ sessionId: home.sessionId, destinationMachine: box })).toMatchObject({ ok: true, value: { terminal: "core:term" } });
      expect(f.services.relocate).toHaveBeenCalledWith({ sessionId: home.sessionId, destinationMachine: box });
      const confirmation = `reassign session-abc to ${box}; source will not run`;
      expect(await client.setHome({ sessionId: home.sessionId, destinationMachine: box, force: true, confirmation })).toMatchObject({ ok: true, value: home });
      expect(f.services.setHome).toHaveBeenCalledWith({ sessionId: home.sessionId, destinationMachine: box, force: true, confirmation });
    } finally { await socket.close(); await socket.close(); }
  });
  it("v0 control drains the current request and rejects requests arriving during stop", async () => {
    const f = fixture(); const root = mkdtempSync(join(resolve(".spider/scratch"), "dvd-")); roots.push(root);
    let release!: () => void, entered!: () => void;
    const pending = new Promise<void>(done => { entered = done; });
    const success = await f.services.relocate({ sessionId: home.sessionId, destinationMachine: box });
    vi.mocked(f.services.relocate).mockClear().mockImplementationOnce(async () => { entered(); await new Promise<void>(done => { release = done; }); return success; });
    const server = await serveV0Control(root, f.services);
    const first = requestV0Services(root).relocate({ sessionId: home.sessionId, destinationMachine: box }); await pending;
    const late = createConnection(join(root, "roam", "relocate.sock")); late.on("error", () => {}); late.resume();
    await new Promise<void>(done => late.once("connect", done));
    let stopped = false; const stopping = server.close().then(() => { stopped = true; });
    const lateClosed = new Promise<void>(done => late.once("close", () => done()));
    late.write(JSON.stringify({ version: 1, kind: "relocate", request: { sessionId: home.sessionId, destinationMachine: box } }) + "\n");
    await lateClosed;
    const calls = vi.mocked(f.services.relocate).mock.calls.length;
    expect(stopped).toBe(false); release();
    expect(await first).toMatchObject({ ok: true }); await stopping;
    expect(calls).toBe(1);
  });
  it("private v0 agent parses bounded UTF-8 stdin before forwarding", async () => {
    const f = fixture(); const agent = vi.fn(async (_input: unknown, _root: string) => ({ ok: true, value: { version: 1 } }));
    expect(await main(["--global-root", "/fixture/root", "roam", "agent", "--v0"], f.io, { stdin: Buffer.from('{"version":1,"kind":"version"}'), v0: { agent } })).toBe(0);
    expect(agent).toHaveBeenCalledWith({ version: 1, kind: "version" }, "/fixture/root");
    const chunkRequest = { version: 1, kind: "chunk", data: Buffer.alloc(DEFAULT_LIMITS.chunkBytes, 7).toString("base64") };
    expect(await main(["roam", "agent", "--v0"], f.io, { stdin: Buffer.from(JSON.stringify(chunkRequest)), v0: { agent } })).toBe(0);
    expect(agent).toHaveBeenLastCalledWith(chunkRequest, expect.any(String));
    for (const stdin of [Buffer.from("{"), Buffer.from([0xff]), Buffer.alloc(4 * 1024 * 1024 + 1)]) {
      f.out.length = 0; expect(await main(["roam", "agent", "--v0"], f.io, { stdin, v0: { agent } })).toBe(2);
      expect(JSON.parse(f.out.join("")).refusal.code).toBe("invalid-arguments");
    }
    expect(agent).toHaveBeenCalledTimes(2);
  });
  it("parse relocate and forced set-home without changing move", () => {
    expect(parseV0Control(["roam", "relocate", "session-abc", "box-a", "--json"])).toEqual({ kind: "relocate", session: "session-abc", machine: "box-a" });
    expect(parseV0Control(["roam", "set-home", "first", "mac", "--force"])).toEqual({ kind: "set-home", session: "first", machine: "mac", force: true, confirmation: null });
    for (const args of [["roam", "relocate"], ["roam", "relocate", "bad/id", "box-a"], ["roam", "relocate", "first", "-box"], ["roam", "relocate", "first", "box-a", "--yes"], ["roam", "set-home", "first", "mac"], ["roam", "set-home", "first", "mac", "--force", "--confirm", "yes"], ["move", "first", "mac"], ["roam", "move", "first", "mac"]]) expect(parseV0Control(args)).toBeNull();
    expect(parsePublicControl(["move", "first", "mac"])).toEqual({ kind: "move", session: "first", machine: "mac" });
    expect(parsePublicControl(["roam", "relocate", "first", "mac"])).toBeNull();
  });
  it("resolve session and machine with existing rules", async () => {
    for (const [target, expected] of [["first", "first"], ["session-abc", "session-abc"], ["session-abc", "session-abc"], ["second", "session-abd"]]) {
      const f = fixture(); expect(await runV0Control({ kind: "relocate", session: target, machine: "box-a" }, config, catalog, f.services, f.io)).toBe(0);
      expect(f.services.relocate).toHaveBeenCalledWith({ sessionId: expected, destinationMachine: box });
    }
    const macTarget = fixture(); await runV0Control({ kind: "relocate", session: "session-abc", machine: "mac" }, config, catalog, macTarget.services, macTarget.io);
    expect(macTarget.services.relocate).toHaveBeenCalledWith({ sessionId: "session-abc", destinationMachine: mac });
    const ambiguous = fixture(); expect(await runV0Control({ kind: "relocate", session: "session-ab", machine: "box-a" }, config, catalog, ambiguous.services, ambiguous.io)).toBe(1);
    expect(ambiguous.services.relocate).not.toHaveBeenCalled(); expect(ambiguous.err.join("")).toContain("session-abc"); expect(ambiguous.err.join("")).toContain("session-abd");
    const duplicate = fixture(); await runV0Control({ kind: "relocate", session: "first", machine: "box-a" }, { ...config, peers: [...config.peers, { ...config.peers[0], machineId: mac }] }, catalog, duplicate.services, duplicate.io);
    expect(duplicate.services.relocate).not.toHaveBeenCalled();
  });
  it("relocate from a box is one actionable refusal", async () => {
    const f = fixture(); expect(await runV0Control({ kind: "relocate", session: "first", machine: "mac" }, { ...config, role: "box", machineId: box }, catalog, f.services, f.io, { json: true })).toBe(1);
    expect(JSON.parse(f.out.join(""))).toMatchObject({ ok: false, refusal: { code: "mac-required", message: expect.any(String), nextStep: expect.stringContaining("Mac") } });
    expect(f.out).toHaveLength(1); expect(f.services.relocate).not.toHaveBeenCalled();
    const disabled = fixture(); await runV0Control({ kind: "relocate", session: "first", machine: "mac" }, { ...config, enabled: false }, catalog, disabled.services, disabled.io);
    expect(disabled.services.relocate).not.toHaveBeenCalled(); expect(disabled.err.join("")).toContain("replication");
  });
  it("force prompts for the exact phrase", async () => {
    const phrase = `reassign session-abc to ${box}; source will not run`;
    for (const value of [null, "", "yes", phrase + " ", phrase.toUpperCase()]) {
      const f = fixture(value); expect(await runV0Control({ kind: "set-home", session: "session-abc", machine: "box-a", force: true, confirmation: null }, config, catalog, f.services, f.io, { json: true })).toBe(1);
      expect(f.services.setHome).not.toHaveBeenCalled(); expect(JSON.parse(f.out.join("")).refusal.code).toBe("confirmation-required");
      expect(f.prompts[0]).toContain(phrase); expect(f.prompts[0]).toMatch(/unsynced conversation.*lost/i);
    }
    const f = fixture(phrase); expect(await runV0Control({ kind: "set-home", session: "session-abc", machine: "box-a", force: true, confirmation: null }, { ...config, enabled: false }, catalog, f.services, f.io, { json: true })).toBe(0);
    expect(f.services.setHome).toHaveBeenCalledWith({ sessionId: "session-abc", destinationMachine: box, force: true, confirmation: phrase });
  });
  it("v0 controls bypass legacy hub and deferred gates", async () => {
    const f = fixture(); const root = mkdtempSync(join(resolve(".spider/scratch"), "dv0-")); roots.push(root); mkdirSync(join(root, "roam"), { mode: 0o700 });
    writeFileSync(join(root, "roam", "config.json"), JSON.stringify(config), { mode: 0o600 }); writeFileSync(join(root, "roam", "machine.json"), JSON.stringify({ machineId: mac }), { mode: 0o600 }); vi.stubEnv("SPIDER_GLOBAL_ROOT", root);
    const forbidden = [vi.spyOn(legacySocket, "requestHubControl"), vi.spyOn(productionHub, "startProductionHub"), vi.spyOn(productionSupervisor, "startProductionSupervisor"), vi.spyOn(controls, "enableRoaming"), vi.spyOn(diagnostics, "runLocalDoctor")];
    expect(await main(["roam", "relocate", "session-abc", "box-a", "--json"], f.io, { v0: { services: f.services, catalog, confirmation: f.io.confirmation } })).toBe(0);
    expect(JSON.parse(f.out.join(""))).toMatchObject({ ok: true, value: { home: { machineId: box }, terminal: "core:term" } });
    for (const spy of forbidden) expect(spy).not.toHaveBeenCalled();
    vi.mocked(f.services.relocate).mockResolvedValueOnce({ ok: false, refusal: { code: "start-pending", message: "The session has not started.", nextStep: "Retry relocation on the Mac." }, step: "confirm", home, moveId: null });
    f.out.length = 0; expect(await main(["roam", "relocate", "session-abc", "box-a", "--json"], f.io, { v0: { services: f.services, catalog } })).toBe(1);
    expect(JSON.parse(f.out.join(""))).toMatchObject({ step: "confirm", refusal: { code: "start-pending", nextStep: "Retry relocation on the Mac." } });
    for (const spy of forbidden) expect(spy).not.toHaveBeenCalled();
  });
});

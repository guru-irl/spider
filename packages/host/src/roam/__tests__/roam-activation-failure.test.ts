import { afterEach, expect, it, vi } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { createHomeStore } from "@spider/roam/relocate/home";
import type { SessionId } from "@spider/roam/relocate/types";
import { join } from "node:path";
import { createReplica } from "@spider/db-core/testutil";
import { paths } from "@spider/db-core";
import { DEFAULT_LIMITS, disabledIntercom, type RoamConfig } from "@spider/roam/contracts";
import * as runtime from "@spider/roam/runtime";
import * as journal from "@spider/roam/journal";
import * as hostConfig from "@spider/roam/host-config";
import * as bindings from "../move-runtime";
import * as live from "../live";
import * as control from "../control";
import { createMoveActivation } from "../move-activation";
import { createClientFixture } from "../../../../herdr/src/__tests__/testutil";
import { createHostSessionFixture } from "../../__tests__/fixtures/pi-events";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
it("a v0 home bypasses legacy activation while keeping the admission lock", async () => {
  const global = createReplica("global", "00000000-0000-4000-8000-000000000001");
  try {
    mkdirSync(join(global.root, "roam"), { mode: 0o700 });
    const config: RoamConfig = { enabled: true, role: "hub", machineId: global.machineId, hubMachineId: global.machineId, peers: [], discoveryRoots: [], coreUnit: "fixture", syncMs: 1000, limits: DEFAULT_LIMITS, intercom: disabledIntercom() };
    writeFileSync(join(global.root, "roam", "config.json"), JSON.stringify(config), { mode: 0o600 });
    writeFileSync(join(global.root, "roam", "machine.json"), JSON.stringify({ machineId: global.machineId }), { mode: 0o600 });
    const homes = createHomeStore({ db: global.db, hubMachineId: global.machineId, localMachineId: global.machineId });
    await homes.initialize("session-v0" as SessionId, global.machineId);
    await global.db.raw.backup(join(global.root, "spider.db"));
    const legacy = vi.spyOn(runtime, "openLocalCore").mockImplementation(() => { throw new Error("legacy runtime forbidden"); });
    const host = createHostSessionFixture({ cwd: global.root, sessionId: "session-v0", sessionFile: join(global.root, "session.jsonl") });
    expect(await createMoveActivation({ root: global.root, sessionId: "session-v0", file: host.ctx.sessionManager.getSessionFile()!, context: () => host.ctx, gate: {} } as never)).toBeNull();
    expect(legacy).not.toHaveBeenCalled();
  } finally { global.close(); }
});
it.each(["journal", "move-bindings", "live-freeze", "socket-publication"] as const)("production activation retains %s as a safe setup stage", async stage => {
  const fixture = await createClientFixture();
  const global = createReplica("global", "00000000-0000-4000-8000-000000000001");
  vi.stubEnv("SPIDER_ROAM_PI", process.execPath);
  vi.stubEnv("HC_SOCKET", fixture.localSocket);
  vi.stubEnv("HC_TERMINAL_SOCKET", fixture.localSocket);
  vi.stubEnv("HC_SESSION", fixture.namespace);
  try {
    mkdirSync(join(global.root, "roam"), { mode: 0o700 });
    const config: RoamConfig = { enabled: true, role: "hub", machineId: global.machineId, hubMachineId: global.machineId,
      peers: [], discoveryRoots: [], coreUnit: "fixture", syncMs: 1000, limits: DEFAULT_LIMITS, intercom: disabledIntercom() };
    const closed = vi.fn();
    vi.spyOn(runtime, "readLocalIdentity").mockReturnValue(config);
    vi.spyOn(runtime, "openLocalCore").mockReturnValue({ root: global.root, db: global.db, config, close: closed });
    vi.spyOn(hostConfig, "loadHerdrConfig").mockReturnValue({ core: { binary: "/fixture/hc" }, agentDirectory: "/fixture/agent" } as never);
    vi.spyOn(paths, "scratch").mockReturnValue(join(global.root, "scratch"));
    const error = Object.assign(new Error("private prompt /private/path"), { code: "EACCES" });
    if (stage === "journal") vi.spyOn(journal, "openFreezeJournal").mockImplementation(() => { throw error; });
    if (stage === "move-bindings") vi.spyOn(bindings, "createHostMoveBindings").mockRejectedValue(error);
    vi.spyOn(live, "createLiveFreezePorts").mockImplementation(() => { if (stage === "live-freeze") throw error; return {} as never; });
    vi.spyOn(control, "serveSessionControl").mockRejectedValue(error);
    const host = createHostSessionFixture({ cwd: global.root, sessionId: "session-a", sessionFile: join(global.root, "session.jsonl") });
    await expect(createMoveActivation({ root: global.root, sessionId: "session-a", file: host.ctx.sessionManager.getSessionFile()!,
      context: () => host.ctx, gate: {} } as never)).rejects.toMatchObject({ setupStage: stage === "journal" ? "move-bindings" : stage, code: "EACCES", message: "Move setup failed" });
    expect(closed).toHaveBeenCalledOnce();
  } finally { global.close(); await fixture.close(); }
});

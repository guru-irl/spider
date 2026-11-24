import { afterEach, expect, it, vi } from "vitest";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createReplica } from "@spider/db-core/testutil";
import { DEFAULT_LIMITS, disabledIntercom, type RoamConfig } from "@spider/roam/contracts";
import { openFreezeJournal } from "@spider/roam/journal";
import { createHostMoveBindings } from "../move-runtime";

afterEach(() => vi.unstubAllEnvs());
it.each(["participant-pi-unavailable", "private-forged-cause"])("workspace preflight retains only an allowlisted remote cause: %s", async cause => {
  const global = createReplica("global", "00000000-0000-4000-8000-000000000001");
  vi.stubEnv("SPIDER_ROAM_PI", process.execPath);
  try {
    const box = "00000000-0000-4000-8000-000000000002";
    mkdirSync(join(global.root, "roam"), { mode: 0o700 });
    global.db.prepare("INSERT INTO roam_workspace_maps(repo_key,workspace_id,path) VALUES(?,?,?)").run("fixture", "workspace-a", global.root);
    const config: RoamConfig = { enabled: true, role: "hub", machineId: global.machineId, hubMachineId: global.machineId,
      peers: [{ machineId: box, alias: "box-1.invalid", pi: "/fixture/pi", node: "/fixture/node", cli: "/fixture/cli", core: "/fixture/hc", globalRoot: "/fixture/global" }],
      discoveryRoots: [], coreUnit: "fixture", syncMs: 1000, limits: DEFAULT_LIMITS, intercom: disabledIntercom() };
    const request = { sessionId: "session-a", destinationMachine: box, operation: { id: "move-a", kind: "move", machineId: global.machineId,
      expectedEpoch: null, args: { sessionId: "session-a", destinationMachine: box } } };
    const transport = { resolve: async () => config.peers[0], exec: async () => Buffer.from(JSON.stringify({ code: 1,
      operationId: "move-a", reason: "private exception text", causeCode: cause, value: null })) };
    const mounted = await createHostMoveBindings({ root: global.root, globalDb: global.db, config,
      journal: openFreezeJournal(join(global.root, "roam", "journal.db")), sessionId: "session-a", transport: transport as never });
    try {
      await expect(mounted.bindings.mapping!(request, { file: "/fixture/session.jsonl", cwd: global.root,
        stores: ["worktree:fixture:workspace-a"] })).rejects.toMatchObject({ code: cause === "participant-pi-unavailable" ? cause : "move-adapter-unavailable" });
    } finally { await mounted.close(); }
  } finally { global.close(); }
});
it("an unavailable explicit Pi is a named host adapter failure", async () => {
  const global = createReplica("global", "00000000-0000-4000-8000-000000000001");
  try {
    vi.stubEnv("SPIDER_ROAM_PI", join(global.root, "missing-pi"));
    mkdirSync(join(global.root, "roam"), { mode: 0o700 });
    const config: RoamConfig = { enabled: true, role: "hub", machineId: global.machineId, hubMachineId: global.machineId,
      peers: [], discoveryRoots: [], coreUnit: "fixture", syncMs: 1000, limits: DEFAULT_LIMITS, intercom: disabledIntercom() };
    await expect(createHostMoveBindings({ root: global.root, globalDb: global.db, config,
      journal: openFreezeJournal(join(global.root, "roam", "journal.db")), sessionId: "session-a", transport: {} as never }))
      .rejects.toMatchObject({ code: "participant-pi-unavailable", message: "participant-pi-unavailable" });
  } finally { global.close(); }
});

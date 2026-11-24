import { afterEach, expect, it, vi } from "vitest";
import { join } from "node:path";
import { recordLocation } from "@spider/db-core/roam/catalog";
import { readLocal, writeLocal } from "@spider/db-core/roam/local-state";
import type { StoreBarrier } from "@spider/db-core/roam/types";
import { controlText, safeControlOutcome } from "../commands";
import type { MoveCheck, MovePorts, MoveRequest } from "../contracts";
import { sessionHome } from "../homes";
import { moveSession } from "../move";
import { createSync } from "../sync";
import * as staging from "../staging";
import { BOX, BOX2, HUB, network } from "./sync-fixture";

const SESSION = "session-a";
const fixtures: ReturnType<typeof network>[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const f of fixtures.splice(0)) f.close(); });

async function fixture() {
  const f = network([BOX, BOX2]); fixtures.push(f);
  vi.spyOn(staging, "defaultStagingRoot").mockReturnValue(f.root);
  f.seed(BOX, SESSION);
  const sync = createSync({ config: f.config, globalDb: f.global.db, transport: f.transport, journal: f.journal, clock: f.clock, stores: f.stores });
  f.unavailable.add(BOX2);
  await sync.sync(BOX);
  expect(sessionHome(f.global.db, SESSION)).toBeNull();
  const key = f.remotes.get(BOX)!.worktree.storeKey;
  recordLocation(f.global.db, { sessionId: SESSION, stores: ["global", "repo:fixture-repo", key], home: null,
    file: "/home/fixture/source/session.jsonl", cwd: "/home/fixture/source" });
  f.unavailable.delete(BOX2);
  return { f, sync, key };
}

function missingMapping(f: ReturnType<typeof network>, workspace: string) {
  const path = join(f.remotes.get(BOX2)!.global.root, "private-missing-store");
  f.remotes.get(BOX2)!.global.db.prepare("INSERT INTO roam_workspace_maps(repo_key,workspace_id,path) VALUES ('fixture-repo',?,?)").run(workspace, path);
}

async function firstMove(input: Awaited<ReturnType<typeof fixture>>, runSync = true) {
  const { f, sync, key } = input, actions: string[] = [];
  const request: MoveRequest = { sessionId: SESSION, destinationMachine: HUB,
    operation: { id: "move-first", kind: "move", machineId: HUB, expectedEpoch: 1, args: { sessionId: SESSION, destinationMachine: HUB } } };
  const check: MoveCheck = { source: { sessionId: SESSION, machineId: BOX, epoch: 1, moveId: null, updatedAt: 0 }, destinationMachine: HUB,
    repoKey: "fixture-repo", workspaceId: "workspace-0", sourceRoot: "/home/fixture/source", sourceCwd: "/home/fixture/source",
    sourceFile: "/home/fixture/source/session.jsonl", destinationRoot: "/home/fixture/destination", destinationCwd: "/home/fixture/destination",
    storeKeys: ["global", "repo:fixture-repo", key], warnings: [] };
  const barriers: StoreBarrier[] = check.storeKeys.map(storeKey => ({ storeKey, stream: "fixture-stream", through: 0 }));
  const ports = { config: f.config, globalDb: f.global.db, journal: f.journal, clock: f.clock,
    check: async () => check, power: async () => async () => {},
    async seed() { if (runSync) await sync.sync(); return barriers; }, barriers: async () => true,
    async prepare() { actions.push("prepare"); throw new Error("unexpected preparation"); },
    async freeze() { actions.push("freeze"); throw new Error("unexpected freeze"); },
    intercom: { address: { sessionId: SESSION, scopeId: null }, destinationEndpoint: async () => null,
      ports: Object.fromEntries(["close", "drain", "inspect", "checkGeneration", "abort", "ready"].map(name => [name, async () => {}])) },
  } as unknown as MovePorts;
  return { result: await moveSession(request, ports), actions, replay: () => moveSession(request, ports) };
}

it("reports the machine and kind when a missing mapped store withholds the first home", async () => {
  const input = await fixture();
  missingMapping(input.f, "workspace-0");
  const { result, actions, replay } = await firstMove(input);
  expect(result).toMatchObject({ code: 1, reason: "move-source-home-mismatch", causeCode: "move-first-home-withheld",
    refusal: { firstHomeWithheld: { machineId: BOX2, storeKind: "worktree" } } });
  expect(actions).toEqual([]);
  expect(sessionHome(input.f.global.db, SESSION)).toBeNull();
  expect(readLocal(input.f.global.db, "first-home-withheld", SESSION)).toEqual({ machineId: BOX2, storeKind: "worktree" });
  expect(await replay()).toEqual(result);
  const safe = safeControlOutcome(result), text = controlText(safe);
  expect(safe).toMatchObject({ causeCode: "move-first-home-withheld", refusal: { firstHomeWithheld: { machineId: BOX2, storeKind: "worktree" } } });
  expect(safeControlOutcome(safe)).toEqual(safe);
  expect(text).toContain("move-first-home-withheld");
  expect(text).toContain(BOX2);
  expect(text).toContain("worktree");
  expect(JSON.stringify({ safe, text })).not.toContain("private-missing-store");

  input.f.remotes.get(BOX2)!.global.db.prepare("DELETE FROM roam_workspace_maps WHERE repo_key='fixture-repo' AND workspace_id='workspace-0'").run();
  await input.sync.sync();
  expect(sessionHome(input.f.global.db, SESSION)).toMatchObject({ machineId: BOX, epoch: 1 });
  expect(readLocal(input.f.global.db, "first-home-withheld", SESSION)).toBeUndefined();
});

it("does not withhold a home for an unrelated missing mapped worktree", async () => {
  const input = await fixture();
  missingMapping(input.f, "workspace-unrelated");
  await input.sync.sync();
  expect(sessionHome(input.f.global.db, SESSION)).toMatchObject({ machineId: BOX, epoch: 1 });
  expect(readLocal(input.f.global.db, "first-home-withheld", SESSION)).toBeUndefined();
});

it("does not expose malformed retained withholding evidence", async () => {
  const input = await fixture();
  writeLocal(input.f.global.db, "first-home-withheld", SESSION, { machineId: "/home/fixture/private", storeKind: "private-content" });
  const { result, actions } = await firstMove(input, false);
  expect(result).toMatchObject({ code: 1, reason: "move-source-home-mismatch" });
  expect(result.causeCode).toBeUndefined();
  expect(actions).toEqual([]);
  expect(JSON.stringify(safeControlOutcome(result))).not.toContain("private");
});

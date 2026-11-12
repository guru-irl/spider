import { afterEach, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { replicaPath } from "@spider/db-core/roam/catalog";
import { createReplica } from "@spider/db-core/testutil";
import { handleAgentOperation } from "../agent";
import { DEFAULT_LIMITS } from "../contracts";
import { openJournal } from "../journal";

const BOX = "00000000-0000-4000-8000-000000000002";
const HUB = "00000000-0000-4000-8000-000000000001";
const fixtures: Array<{ close(): void }> = [];
afterEach(() => { for (const fixture of fixtures.splice(0).reverse()) fixture.close(); });
function fixture() {
  const global = createReplica("global", BOX), worktree = createReplica("worktree", BOX);
  fixtures.push(global, worktree);
  global.db.prepare("INSERT INTO projects(project_key,real_path,db_path,created_at,last_seen_at) VALUES ('local',?, ?,1,1)").run(worktree.root, worktree.db.raw.name);
  const ports = { config: { enabled: true, role: "box" as const, machineId: BOX, hubMachineId: HUB,
    peers: [], discoveryRoots: [], coreUnit: "core", syncMs: 120_000, limits: DEFAULT_LIMITS },
    root: join(global.root, "roam", "staging"), journal: openJournal(join(global.root, "journal.db")),
    openStore(key: string) { if (key !== "global") throw new Error("unexpected store"); return { db: global.db,
      effects: { winning() {}, committed() {} }, policy: { encode: (_: unknown, body: import("@spider/db-core/roam/types").JsonObject) => body } }; } };
  return { global, worktree, ports };
}
it.each(["stores", "inventory"])("keyless %s discovers a registered store and an agent-created unmapped store", async kind => {
  const { global, worktree, ports } = fixture();
  const foreign = createReplica("repo", BOX); fixtures.push(foreign);
  const file = replicaPath(global.db, foreign.storeKey);
  mkdirSync(join(global.root, "roam", "stores"), { recursive: true, mode: 0o700 });
  await foreign.db.raw.backup(file);
  chmodSync(file, 0o600);
  const before = global.db.prepare("SELECT count(*) AS n FROM roam_changes").get();
  const operation = { id: "discover", machineId: BOX, expectedEpoch: null, kind, args: {} };
  const result = await handleAgentOperation(operation, ports);
  expect(result).toMatchObject({ code: 0, value: { protocol: 1, schema: 14, machineId: BOX,
    stores: ["global", foreign.storeKey, worktree.storeKey] } });
  expect(JSON.stringify(result)).not.toContain(global.root);
  expect(global.db.prepare("SELECT count(*) AS n FROM roam_changes").get()).toEqual(before);
  expect(await handleAgentOperation(operation, ports)).toEqual(result);
  expect(ports.journal.read(operation.id).filter(row => row.action === "done")).toHaveLength(1);
}, 5000);
it("inventory ignores mismatched hashes and never follows replica symlinks", async () => {
  const { global, worktree, ports } = fixture();
  const directory = join(global.root, "roam", "stores"); mkdirSync(directory, { recursive: true, mode: 0o700 });
  const foreign = createReplica("repo", BOX); fixtures.push(foreign);
  await foreign.db.raw.backup(join(directory, `${"0".repeat(64)}.db`));
  symlinkSync(foreign.db.raw.name, join(directory, `${createHash("sha256").update(foreign.storeKey).digest("hex")}.db`));
  const result = await handleAgentOperation({ id: "unsafe", machineId: BOX, expectedEpoch: null, kind: "stores", args: {} }, ports);
  expect(result).toMatchObject({ code: 0, value: { stores: ["global", worktree.storeKey] } });
  expect(JSON.stringify(result)).not.toContain(foreign.root);
}, 5000);

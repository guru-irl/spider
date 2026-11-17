import { afterEach, expect, it, vi } from "vitest";
import { createSync } from "../sync";
import { barrierWatermarks } from "../barriers";
import { assignInitialHome } from "../homes";
import * as staging from "../staging";
import { network, BOX, HUB } from "./sync-fixture";
const fixtures: ReturnType<typeof network>[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const f of fixtures.splice(0)) f.close(); });
function fixture() { const f = network(); fixtures.push(f); vi.spyOn(staging, "defaultStagingRoot").mockReturnValue(f.root); return f; }
it("move barriers wait for every store", async () => {
  const f = fixture(); f.seed();
  const sync = createSync({ config: f.config, globalDb: f.global.db, transport: f.transport, journal: f.journal, clock: f.clock, stores: f.stores });
  await sync.sync();
  const key = f.remotes.get(BOX)!.worktree.storeKey;
  const globalStream = (f.global.db.prepare("SELECT stream_id FROM roam_meta").get() as { stream_id: string }).stream_id;
  const stream = (f.stores.openStore(key).db.prepare("SELECT stream_id FROM roam_meta").get() as { stream_id: string }).stream_id;
  const required = [{ storeKey: "global" as const, stream: globalStream, through: 1 }, { storeKey: key, stream, through: 3 }];
  const peerId = BOX;
  expect(await sync.barriers(peerId, required)).toBe(false);
  expect(await sync.barriers(peerId, [{ ...required[0] }, { ...required[1], through: 2 }])).toBe(true);
  f.unavailable.add(BOX);
  expect(await sync.barriers(peerId, required.slice(0, 1))).toBe(false);
}, 5000);
it("satisfied move barriers only request live cursor proofs", async () => {
  const f = fixture(); f.seed();
  const sync = createSync({ config: f.config, globalDb: f.global.db, transport: f.transport, journal: f.journal, clock: f.clock, stores: f.stores });
  await sync.sync();
  const key = f.remotes.get(BOX)!.worktree.storeKey;
  const required = [f.stores.head("global"), f.stores.head(key)];
  f.calls.length = 0;
  expect(await sync.barriers(BOX, required)).toBe(true);
  expect(f.calls.map(call => ({ kind: call.operation.kind, storeKey: call.operation.args.storeKey }))).toEqual([
    { kind: "cursor", storeKey: "global" }, { kind: "cursor", storeKey: key },
  ]);
}, 5000);
it("move barriers synchronize a missing watermark and prove it again", async () => {
  const f = fixture(); f.seed();
  const sync = createSync({ config: f.config, globalDb: f.global.db, transport: f.transport, journal: f.journal, clock: f.clock, stores: f.stores });
  await sync.sync();
  assignInitialHome(f.global.db, "session-b", HUB, HUB);
  const required = [f.stores.head("global")];
  expect(await sync.barriers(BOX, required)).toBe(true);
  expect(f.remotes.get(BOX)!.global.db.prepare("SELECT machine_id,epoch FROM session_homes WHERE session_id=?").get("session-b")).toEqual({ machine_id: HUB, epoch: 1 });
  f.calls.length = 0;
  expect(await sync.barriers(BOX, required)).toBe(true);
  expect(f.calls.map(call => call.operation.kind)).toEqual(["cursor"]);
}, 5000);
it("barrier watermarks read the store head without writing snapshot batches", async () => {
  const f = fixture(); f.seed();
  const sync = createSync({ config: f.config, globalDb: f.global.db, transport: f.transport, journal: f.journal, clock: f.clock, stores: f.stores });
  await sync.sync(); const key = f.remotes.get(BOX)!.worktree.storeKey;
  const sourceStream = (f.remotes.get(BOX)!.worktree.db.prepare("SELECT stream_id FROM roam_meta").get() as { stream_id: string }).stream_id;
  const hubStream = (f.stores.openStore(key).db.prepare("SELECT stream_id FROM roam_meta").get() as { stream_id: string }).stream_id;
  vi.spyOn(f.stores, "export").mockImplementation(() => { throw new Error("snapshot writes are unavailable"); });
  expect(await barrierWatermarks(f.stores, f.config, [{ storeKey: key, stream: sourceStream, through: 2 }])).toEqual([
    { storeKey: key, stream: hubStream, through: 2 },
  ]);
  expect(await barrierWatermarks(f.stores, f.config, [{ storeKey: key, stream: sourceStream, through: 3 }])).toBeNull();
}, 5000);
it("relayed barriers prove the source cursor before sending a hub watermark", async () => {
  const f = fixture(); f.seed();
  const sync = createSync({ config: f.config, globalDb: f.global.db, transport: f.transport, journal: f.journal, clock: f.clock, stores: f.stores });
  await sync.sync(); const { worktree } = f.remotes.get(BOX)!;
  const stream = (worktree.db.prepare("SELECT stream_id FROM roam_meta").get() as { stream_id: string }).stream_id;
  expect(await sync.barriers(BOX, [{ storeKey: worktree.storeKey, stream, through: 2 }])).toBe(true);
  expect(await sync.barriers(BOX, [{ storeKey: worktree.storeKey, stream, through: 999 }])).toBe(false);
  expect(await sync.barriers(BOX, [{ storeKey: worktree.storeKey, stream: "mapping-fence", through: 0 }])).toBe(false);
}, 5000);

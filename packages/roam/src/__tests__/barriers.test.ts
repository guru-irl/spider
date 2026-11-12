import { afterEach, expect, it, vi } from "vitest";
import { createSync } from "../sync";
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
it("relayed barriers prove the source cursor before sending a hub watermark", async () => {
  const f = fixture(); f.seed();
  const sync = createSync({ config: f.config, globalDb: f.global.db, transport: f.transport, journal: f.journal, clock: f.clock, stores: f.stores });
  await sync.sync(); const { worktree } = f.remotes.get(BOX)!;
  const stream = (worktree.db.prepare("SELECT stream_id FROM roam_meta").get() as { stream_id: string }).stream_id;
  expect(await sync.barriers(BOX, [{ storeKey: worktree.storeKey, stream, through: 2 }])).toBe(true);
  expect(await sync.barriers(BOX, [{ storeKey: worktree.storeKey, stream, through: 999 }])).toBe(false);
  expect(await sync.barriers(BOX, [{ storeKey: worktree.storeKey, stream: "mapping-fence", through: 0 }])).toBe(false);
}, 5000);

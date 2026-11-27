import { afterEach, expect, it, vi } from "vitest";
import { assignInitialHome, sessionHome } from "../homes";
import * as staging from "../staging";
import { createSync } from "../sync";
import { BOX, HUB, network } from "./sync-fixture";

const fixtures: ReturnType<typeof network>[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const fixture of fixtures.splice(0)) fixture.close();
});
function fixture() {
  const result = network();
  fixtures.push(result);
  vi.spyOn(staging, "defaultStagingRoot").mockReturnValue(result.root);
  return result;
}
function sync(f: ReturnType<typeof network>) {
  return createSync({ config: f.config, globalDb: f.global.db, transport: f.transport,
    journal: f.journal, clock: f.clock, stores: f.stores });
}
const moveId = "v0-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

it.each(["running", "moving", "stopped"] as const)("sync preserves a v0 %s home and pushes it to the peer", async state => {
  const f = fixture();
  f.seed();
  const expected = { session_id: "session-a", machine_id: HUB, epoch: 7, move_id: moveId,
    updated_at: 1234, state, destination: state === "moving" ? BOX : null };
  f.global.db.prepare("INSERT INTO session_homes(session_id,machine_id,epoch,move_id,updated_at,state,destination) VALUES (?,?,?,?,?,?,?)")
    .run(expected.session_id, expected.machine_id, expected.epoch, expected.move_id, expected.updated_at, expected.state, expected.destination);

  // Discovery must not bypass the legacy API's refusal to interpret this row.
  expect(sessionHome(f.global.db, "session-a")).toBe("unknown");
  expect(() => assignInitialHome(f.global.db, "session-a", BOX, HUB)).toThrow("Home lookup failed");
  const results = await sync(f).sync(BOX);
  expect(results.filter(result => result.code !== 0)).toEqual([]);
  expect(results).toContainEqual(expect.objectContaining({ code: 0, reason: "pushed" }));
  expect(f.global.db.prepare("SELECT * FROM session_homes WHERE session_id=?").get("session-a")).toEqual(expected);
  expect(f.remotes.get(BOX)!.global.db.prepare("SELECT * FROM session_homes WHERE session_id=?").get("session-a")).toEqual(expected);
});

it("a v0 home appearing during initial assignment wins without aborting sync", async () => {
  const f = fixture();
  f.seed(BOX, "session-race");
  expect(f.global.db.prepare("SELECT 1 FROM session_homes WHERE session_id=?").get("session-race")).toBeUndefined();
  // Insert the competing v0 row after discovery has found no home but before
  // SQLite resolves the legacy insert's conflict, without a timing-dependent sleep.
  f.global.db.exec(`CREATE TRIGGER initial_home_race BEFORE INSERT ON session_homes
    WHEN NEW.session_id='session-race' AND NEW.state IS NULL
    BEGIN
      INSERT INTO session_homes(session_id,machine_id,epoch,move_id,updated_at,state,destination)
      VALUES ('session-race','${HUB}',4,'${moveId}',4321,'moving','${BOX}');
    END`);
  const expected = { session_id: "session-race", machine_id: HUB, epoch: 4, move_id: moveId,
    updated_at: 4321, state: "moving", destination: BOX };
  expect(() => assignInitialHome(f.global.db, "session-race", BOX, HUB)).toThrow("Home lookup failed");
  expect(f.global.db.prepare("SELECT 1 FROM session_homes WHERE session_id=?").get("session-race")).toBeUndefined();

  const results = await sync(f).sync(BOX);
  expect(results.filter(result => result.code !== 0)).toEqual([]);
  expect(f.global.db.prepare("SELECT * FROM session_homes WHERE session_id=?").get("session-race")).toEqual(expected);
  expect(f.remotes.get(BOX)!.global.db.prepare("SELECT * FROM session_homes WHERE session_id=?").get("session-race")).toEqual(expected);
});

it("assigns a homeless session even when another session already has a v0 home", async () => {
  const f = fixture();
  f.seed(BOX, "a-managed");
  f.seed(BOX, "b-homeless");
  f.seed(BOX, "c-legacy");
  const legacy = assignInitialHome(f.global.db, "c-legacy", HUB, HUB);
  f.global.db.prepare("INSERT INTO session_homes(session_id,machine_id,epoch,move_id,updated_at,state,destination) VALUES (?,?,7,?,1234,'running',NULL)")
    .run("a-managed", HUB, moveId);

  const results = await sync(f).sync(BOX);
  expect(results.filter(result => result.code !== 0)).toEqual([]);
  expect(f.global.db.prepare("SELECT machine_id,epoch,move_id,state,destination FROM session_homes WHERE session_id=?").get("b-homeless"))
    .toEqual({ machine_id: BOX, epoch: 1, move_id: null, state: null, destination: null });
  expect(sessionHome(f.global.db, "c-legacy")).toEqual(legacy);
  expect(f.remotes.get(BOX)!.global.db.prepare("SELECT machine_id,epoch,move_id,state,destination FROM session_homes WHERE session_id=?").get("b-homeless"))
    .toEqual({ machine_id: BOX, epoch: 1, move_id: null, state: null, destination: null });
});

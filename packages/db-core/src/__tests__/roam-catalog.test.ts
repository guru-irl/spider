import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createReplica } from "@spider/db-core/testutil";
import { openDbAt } from "../registry";
import { catalogReplica, parseLocationStores, recordLocation, resolveSessionReplica } from "../roam/catalog";
import type { StoreKey } from "../roam/types";

const local = "11111111-1111-4111-8111-111111111111";
const remote = "22222222-2222-4222-8222-222222222222";
const fixtures: ReturnType<typeof createReplica>[] = [];
afterEach(() => { for (const fixture of fixtures.splice(0)) fixture.close(); });

const mixedStores = ["global", "repo:fixture-repo", "worktree:fixture-repo:fixture-workspace"] as const;

it("validates mixed location stores with opaque repository and workspace IDs", () => {
  expect(parseLocationStores(mixedStores)).toEqual(mixedStores);
});

it.each([
  ["null", null], ["object", {}], ["string", "[]"], ["empty", []], ["non-string", [1]],
  ["unknown kind", ["unknown:fixture"]], ["missing repository", ["repo:"]],
  ["missing worktree repository", ["worktree::fixture"]], ["missing workspace", ["worktree:fixture:"]],
  ["missing workspace separator", ["worktree:fixture"]], ["duplicate", ["global", "global"]],
])("refuses a %s location store list", (_kind, value) => {
  expect(() => parseLocationStores(value)).toThrow();
});

it.each([
  ["unknown:fixture"], ["repo:"], ["worktree::fixture"], ["worktree:fixture:"], ["global", "global"],
])("refuses invalid stores before writing the location: %j", (...stores) => {
  const global = createReplica("global", local); fixtures.push(global);
  expect(() => recordLocation(global.db, { sessionId: "s-1", stores: stores as StoreKey[], home: null })).toThrow();
  expect(global.db.prepare("SELECT count(*) AS n FROM roam_locations").get()).toEqual({ n: 0 });
});

it("retains an empty catalog deletion marker without treating it as participant stores", () => {
  const global = createReplica("global", local); fixtures.push(global);
  recordLocation(global.db, { sessionId: "s-1", stores: [], home: null });
  expect(global.db.prepare("SELECT stores_json FROM roam_locations").get()).toEqual({ stores_json: "[]" });
  expect(resolveSessionReplica(global.db, "s-1")).toBeNull();
  expect(() => parseLocationStores([])).toThrow();
});

it("hub reads box-created session without a checkout", () => {
  const global = createReplica("global", local);
  fixtures.push(global);
  const key = "worktree:fixture-repo:fixture-workspace" as const;
  const directory = join(global.root, "roam", "stores");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `${createHash("sha256").update(key).digest("hex")}.db`);
  const source = openDbAt(path, "worktree");
  try {
    source.prepare("UPDATE roam_meta SET store_key = ? WHERE id = 1").run(key);
    source.prepare("INSERT INTO sessions(id, started_at, origin_machine) VALUES (?, ?, ?)").run("remote-session", 1, remote);
    source.prepare("INSERT INTO todos(session_id, seq, text, done, created_at) VALUES (?, 1, ?, 0, 1)").run("remote-session", "remote todo");
    global.db.prepare("INSERT INTO session_homes(session_id,machine_id,epoch,move_id,updated_at) VALUES (?, ?, 2, NULL, 3)").run("remote-session", remote);
    catalogReplica(global.db, key, source);
    const before = global.db.prepare("SELECT total_changes() AS n").get();
    const resolved = resolveSessionReplica(global.db, "remote-session");
    expect(resolved?.storeKey).toBe(key);
    expect(resolved?.home).toEqual({ sessionId: "remote-session", machineId: remote, epoch: 2, moveId: null, updatedAt: 3 });
    expect(resolved?.db.raw.readonly).toBe(true);
    expect(resolved?.db.prepare("SELECT text FROM todos WHERE session_id = ?").all("remote-session")).toEqual([{ text: "remote todo" }]);
    expect(global.db.prepare("SELECT total_changes() AS n").get()).toEqual(before);
    resolved?.db.close();
    global.db.prepare("UPDATE session_homes SET machine_id = ?, epoch = 3, updated_at = 4 WHERE session_id = 'remote-session'").run(local);
    catalogReplica(global.db, key, source);
    const cached = global.db.prepare("SELECT home_json FROM roam_locations WHERE session_id = 'remote-session'").get() as { home_json: string };
    expect(JSON.parse(cached.home_json)).toEqual({ sessionId: "remote-session", machineId: local, epoch: 3, moveId: null, updatedAt: 4 });
    const after = global.db.prepare("SELECT total_changes() AS n").get();
    catalogReplica(global.db, key, source);
    expect(global.db.prepare("SELECT total_changes() AS n").get()).toEqual(after);
  } finally { source.close(); }
}, 5000);

it("cataloguing skips and reports a malformed location without losing other sessions", async () => {
  const { readLocal } = await import("../roam/local-state");
  const global = createReplica("global", local), replica = createReplica("worktree", local); fixtures.push(global, replica);
  const key = replica.storeKey;
  for (const id of ["bad-session", "valid-session"]) replica.db.prepare("INSERT INTO sessions(id, started_at, origin_machine) VALUES (?, 1, ?)").run(id, local);
  global.db.prepare("INSERT INTO roam_locations(session_id, stores_json, home_json) VALUES (?, ?, NULL)").run("bad-session", '["unknown:fixture"]');
  expect(() => catalogReplica(global.db, key, replica.db)).not.toThrow();
  expect(global.db.prepare("SELECT stores_json FROM roam_locations WHERE session_id='valid-session'").get()).toEqual({ stores_json: JSON.stringify([key]) });
  expect(global.db.prepare("SELECT stores_json FROM roam_locations WHERE session_id='bad-session'").get()).toEqual({ stores_json: '["unknown:fixture"]' });
  expect(readLocal(global.db, "catalog-diagnostic", "bad-session")).toEqual({ reason: "location-stores-invalid" });
  recordLocation(global.db, { sessionId: "bad-session", stores: [key], home: null });
  catalogReplica(global.db, key, replica.db);
  expect(readLocal(global.db, "catalog-diagnostic", "bad-session")).toBeUndefined();
}, 5000);

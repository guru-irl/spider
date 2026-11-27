import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { openDb, migrate, type Db } from "@spider/db-core";
import { scratchDbPath } from "@spider/db-core/testutil";
import { processStartIdentity } from "@spider/herdr/jobs/handoff";
import { claimIdLock, inspectIdLock, type IdLockHandle } from "@spider/herdr/sessions/id-lock";
import { DEFAULT_LIMITS, disabledIntercom } from "@spider/roam/contracts";
import { createHomeStore } from "@spider/roam/relocate/home";
import { setHome } from "@spider/roam/relocate/set-home";
import type { RelocateId, RunningHome, SessionId, SetHomePorts, V0Result } from "@spider/roam/relocate/types";
import { afterEach, expect, it } from "vitest";
import { createHostSessionFixture } from "../../__tests__/fixtures/pi-events";
import { registerAdmission } from "../admission";
import { loadRelocateAdmission } from "../relocate-admission";

const hub = "11111111-1111-4111-8111-111111111111", box = "22222222-2222-4222-8222-222222222222";
const sid = "moved-session" as SessionId;
const move = "v0-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" as RelocateId;
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

function fixture() {
  const root = mkdtempSync(join(dirname(scratchDbPath("away-home")), "away-home-"));
  const file = join(root, "spider.db"), roam = join(root, "roam");
  const fence = join(roam, "away-homes", `${createHash("sha256").update(sid).digest("hex")}.json`);
  mkdirSync(roam, { mode: 0o700 });
  const config = { enabled: true, role: "hub", machineId: hub, hubMachineId: hub, peers: [], discoveryRoots: [], coreUnit: "core", syncMs: 10_000, limits: DEFAULT_LIMITS, intercom: disabledIntercom() };
  writeFileSync(join(roam, "config.json"), JSON.stringify(config), { mode: 0o600 });
  writeFileSync(join(roam, "machine.json"), JSON.stringify({ machineId: hub }), { mode: 0o600 });
  let db: Db | undefined;
  function createDb() {
    db = openDb(file);
    migrate(db, "global", { machineId: hub, globalRoot: root });
    return db;
  }
  function store() { return createHomeStore({ db: db!, localMachineId: hub, hubMachineId: hub }); }
  createDb();
  cleanups.push(() => { db?.close(); rmSync(root, { recursive: true, force: true }); });
  function removeDb() { db?.close(); db = undefined; unlinkSync(file); }
  function fenceContents() { return JSON.parse(readFileSync(fence, "utf8")); }
  function forcePorts(): SetHomePorts {
    const ok = <T>(value: T): V0Result<T> => ({ ok: true, value });
    return { homes: store(), newMoveId: () => move, withSession: (_id, run) => run(),
      locate: async (machineId, sessionId) => ok({ machineId, sessionId, repoKey: "repo", workspaceId: "ws", repository: root, cwd: root, file: join(root, "fixture.jsonl"), stores: [], historyMachine: hub }),
      activate: async () => ok(undefined), publishHome: async () => ok(undefined),
      start: async () => { throw new Error("must not start"); }, confirm: async () => { throw new Error("must not confirm"); } };
  }
  return { root, file, fence, fenceContents, createDb, removeDb, store, forcePorts, db: () => db! };
}

async function prepareMove(f: ReturnType<typeof fixture>) {
  const store = f.store(), source = await store.initialize(sid, hub);
  const moving = { ...source, state: "moving" as const, destination: box, moveId: move, epoch: 2 };
  await store.compareAndSwap(source, moving);
  const away: RunningHome = { ...moving, state: "running", machineId: box, destination: null, epoch: 3 };
  return { store, moving, away };
}

it.each(["deleted", "empty", "older", "equal"] as const)("a fresh admission refuses the away backup after a %s global store", async state => {
  const f = fixture(), { store, moving, away } = await prepareMove(f);
  await store.compareAndSwap(moving, away);
  f.removeDb();
  if (state !== "deleted") {
    const db = f.createDb();
    if (state === "older" || state === "equal") db.prepare("INSERT INTO session_homes(session_id,machine_id,epoch,move_id,updated_at,state) VALUES(?,?,?,NULL,1,'running')")
      .run(sid, hub, state === "older" ? 2 : 3);
  }
  const host = createHostSessionFixture({ cwd: f.root, sessionId: sid, sessionFile: join(f.root, "backup.jsonl"), hasUI: false });
  const gate = registerAdmission(host.pi as unknown as ExtensionAPI, {
    expectedEpoch: null, localMachine: async () => hub, knownParticipant: () => false, warnOnce() {},
    v0Lookup: id => loadRelocateAdmission(id, f.root), lock: async () => async () => {},
    load: async () => ({ home: null, origin: null, states: [], participating: false, captureSafe: true, unfinishedFreeze: false, initialConflict: false }),
  });
  try {
    for (const handler of host.hooks.get("session_start") ?? []) await handler({}, host.ctx);
    const result = gate.inspect();
    expect(result.kind).toBe("blocked");
    expect(result.blockers[0]?.detail).toContain(box);
    expect(result.blockers[0]?.detail).toContain("spider.db");
    expect(result.blockers[0]?.detail).toContain(`spider roam set-home ${sid} mac --force`);
    expect(f.fenceContents()).toMatchObject({ machineId: box, epoch: 3, moveId: move });
    expect(await loadRelocateAdmission("ordinary-session" as SessionId, f.root)).toEqual({ kind: "unmanaged" });
  } finally { await gate.close(); }
});

it("a durably published fence still refuses after a fault before the away CAS commits", async () => {
  const f = fixture(), { store, moving, away } = await prepareMove(f);
  expect(existsSync(f.fence)).toBe(false);
  let atCas: unknown;
  f.db().raw.function("observe_away_fence", () => { atCas = existsSync(f.fence) ? f.fenceContents() : null; return 1; });
  f.db().exec(`CREATE TRIGGER fault_before_commit BEFORE UPDATE ON session_homes WHEN NEW.machine_id='${box}'
    BEGIN SELECT observe_away_fence(); SELECT RAISE(ABORT, 'fixture fault before CAS'); END;`);
  await expect(store.compareAndSwap(moving, away)).rejects.toThrow("fixture fault before CAS");
  expect(atCas).toMatchObject({ machineId: box, epoch: 3, moveId: move });
  expect(await store.read(sid)).toEqual(moving);
  expect(await loadRelocateAdmission(sid, f.root)).toEqual({ kind: "unavailable", awayMachine: box });
  f.db().exec("DROP TRIGGER fault_before_commit");
  await expect(f.store().compareAndSwap(moving, away)).resolves.toEqual({ kind: "applied", home: away });
  expect(f.fenceContents()).toEqual(atCas);
});

it.each(["before force", "during destination lookup"])("refuses forced reassignment if the Mac takes the ID %s", async when => {
  const f = fixture(), initial = await f.store().initialize(sid, hub);
  const lockRoot = join(f.root, "herdr");
  const take = () => claimIdLock(lockRoot, sid, { pid: process.pid, startIdentity: processStartIdentity(process.pid)! }, async () => ({ kind: "unknown" }));
  const ports = f.forcePorts(), locate = ports.locate;
  let held: IdLockHandle | undefined;
  try {
    if (when === "before force") held = await take();
    else ports.locate = async (...args) => { held = await take(); return locate(...args); };
    const request = { sessionId: sid, destinationMachine: box, force: true, confirmation: `reassign ${sid} to ${box}; source will not run` };
    expect(await setHome(request, ports)).toMatchObject({ ok: false,
      refusal: { code: "stop-timeout", nextStep: expect.stringMatching(/close.*Mac.*retry/i) } });
    expect(await f.store().read(sid)).toEqual(initial);
    expect(existsSync(f.fence)).toBe(false);
    expect(await held?.isHeldByClaim?.()).toBe(true);
  } finally { await held?.release(); }
});

it("force holds the free Mac ID through the away CAS and releases it afterward", async () => {
  const f = fixture(), lockRoot = join(f.root, "herdr");
  const lock = join(lockRoot, "id-locks", `${createHash("sha256").update(sid).digest("hex")}.json`);
  await f.store().initialize(sid, hub);
  f.db().raw.function("mac_id_reserved", () => existsSync(lock) ? 1 : 0);
  f.db().exec(`CREATE TRIGGER require_mac_id BEFORE UPDATE ON session_homes WHEN NEW.machine_id='${box}' AND mac_id_reserved()=0
    BEGIN SELECT RAISE(ABORT, 'Mac ID was not reserved in fixture'); END;`);
  const request = { sessionId: sid, destinationMachine: box, force: true, confirmation: `reassign ${sid} to ${box}; source will not run` };
  expect(await setHome(request, f.forcePorts())).toMatchObject({ ok: true, value: { machineId: box, epoch: 2 } });
  expect(await inspectIdLock(lockRoot, sid)).toBeNull();
});

it("an unwritable fence refuses forced reassignment before the home changes", async () => {
  const f = fixture(), initial = await f.store().initialize(sid, hub);
  mkdirSync(f.fence, { recursive: true, mode: 0o700 });
  const request = { sessionId: sid, destinationMachine: box, force: true, confirmation: `reassign ${sid} to ${box}; source will not run` };
  expect(await setHome(request, f.forcePorts())).toMatchObject({ ok: false });
  expect(await f.store().read(sid)).toEqual(initial);
});

it.each([2, 3])("a restored local row at epoch %s cannot be forced past an existing away fence", async epoch => {
  const f = fixture(), { store, moving, away } = await prepareMove(f);
  await store.compareAndSwap(moving, away);
  f.removeDb();
  f.createDb().prepare("INSERT INTO session_homes(session_id,machine_id,epoch,move_id,updated_at,state) VALUES(?,?,?,NULL,1,'running')")
    .run(sid, hub, epoch);
  const stale = await f.store().read(sid);
  const request = { sessionId: sid, destinationMachine: hub, force: true, confirmation: `reassign ${sid} to ${hub}; source will not run` };
  expect(await setHome(request, f.forcePorts())).toMatchObject({ ok: false, refusal: { code: "home-unavailable", nextStep: expect.stringContaining("Restore spider.db") } });
  expect(await f.store().read(sid)).toEqual(stale);
  expect(f.fenceContents()).toMatchObject({ machineId: box, epoch: 3, moveId: move });
});

it("a malformed fence cannot make a fresh admission ordinary", async () => {
  const f = fixture(), { store, moving, away } = await prepareMove(f);
  await store.compareAndSwap(moving, away);
  f.removeDb();
  writeFileSync(f.fence, "null");
  expect(await loadRelocateAdmission(sid, f.root)).toEqual({ kind: "unavailable" });
});

it("forced reassignment leaves a fence until a restored home proves a newer local epoch", async () => {
  const f = fixture();
  await f.store().initialize(sid, hub);
  const request = (machine: string) => ({ sessionId: sid, destinationMachine: machine, force: true, confirmation: `reassign ${sid} to ${machine}; source will not run` });
  const assigned = await setHome(request(box), f.forcePorts());
  expect(assigned).toMatchObject({ ok: true, value: { machineId: box, epoch: 2 } });
  expect(f.fenceContents()).toMatchObject({ machineId: box, epoch: 2, moveId: move });
  f.removeDb();
  f.createDb();
  const missing = await setHome(request(hub), f.forcePorts());
  expect(missing).toMatchObject({ ok: false, refusal: { code: "home-unavailable" } });
  expect(f.fenceContents()).toMatchObject({ machineId: box, epoch: 2 });
  f.db().prepare("INSERT INTO session_homes(session_id,machine_id,epoch,move_id,updated_at,state) VALUES(?,?,?,?,1,'running')").run(sid, box, 2, move);
  expect(await setHome(request(hub), f.forcePorts())).toMatchObject({ ok: true, value: { machineId: hub, epoch: 3 } });
  expect(await loadRelocateAdmission(sid, f.root)).toMatchObject({ kind: "managed", home: { machineId: hub, state: "running", epoch: 3 } });
  expect(existsSync(f.fence)).toBe(false);
});

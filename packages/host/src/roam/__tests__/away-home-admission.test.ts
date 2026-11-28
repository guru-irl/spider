import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { openDb, migrate, paths, setGlobalDbPathForTests, type Db } from "@spider/db-core";
import { scratchDbPath } from "@spider/db-core/testutil";
import { processStartIdentity } from "@spider/herdr/jobs/handoff";
import { claimIdLock, inspectIdLock, type IdLockHandle } from "@spider/herdr/sessions/id-lock";
import { createSessionLeases } from "@spider/herdr/sessions/lease";
import { writeLocal } from "@spider/db-core/roam/local-state";
import { DEFAULT_LIMITS, disabledIntercom } from "@spider/roam/contracts";
import { openJournal } from "@spider/roam/journal";
import { createHomeStore } from "@spider/roam/relocate/home";
import * as awayHome from "@spider/roam/relocate/away-home";
import { relocate } from "@spider/roam/relocate/relocate";
import { createSessionStopStore, displacedByForce } from "@spider/roam/relocate/session-stop-store";
import { setHome, type ForceHomePorts } from "@spider/roam/relocate/set-home";
import type { RelocateId, RelocatePorts, RunningHome, SessionId, SetHomePorts, V0Result } from "@spider/roam/relocate/types";
import { afterEach, expect, it, vi } from "vitest";
import { createHostSessionFixture } from "../../__tests__/fixtures/pi-events";
import { createAdmissionPorts, protectAdmissionApi, registerAdmission } from "../admission";
import { loadRelocateAdmission } from "../relocate-admission";

const hub = "11111111-1111-4111-8111-111111111111", box = "22222222-2222-4222-8222-222222222222";
const sid = "moved-session" as SessionId;
const move = "v0-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" as RelocateId;
const cleanups: (() => void)[] = [];
const originalGlobalRoot = paths.globalRoot;
afterEach(() => {
  paths.globalRoot = originalGlobalRoot; setGlobalDbPathForTests(null); vi.unstubAllEnvs();
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

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
  function openRestoredDb() { db = openDb(file, { fileMustExist: true }); return db; }
  function fenceContents() { return JSON.parse(readFileSync(fence, "utf8")); }
  function forcePorts(): SetHomePorts {
    const ok = <T>(value: T): V0Result<T> => ({ ok: true, value });
    return { homes: store(), newMoveId: () => move, withSession: (_id, run) => run(),
      locate: async (machineId, sessionId) => ok({ machineId, sessionId, repoKey: "repo", workspaceId: "ws", repository: root, cwd: root, file: join(root, "fixture.jsonl"), stores: [], historyMachine: hub }),
      activate: async () => ok(undefined), publishHome: async () => ok(undefined),
      start: async () => { throw new Error("must not start"); }, confirm: async () => { throw new Error("must not confirm"); } };
  }
  return { root, file, fence, fenceContents, createDb, removeDb, openRestoredDb, store, forcePorts, db: () => db! };
}

function productionSession(f: ReturnType<typeof fixture>, sessionId: SessionId = sid, hasUI = false) {
  const cwd = join(f.root, "worktree"), file = join(f.root, `${sessionId}.jsonl`), lockRoot = join(f.root, "herdr");
  mkdirSync(cwd, { recursive: true });
  writeFileSync(file, JSON.stringify({ type: "session", version: 3, id: sessionId, cwd }) + "\n", { mode: 0o600 });
  paths.globalRoot = f.root; setGlobalDbPathForTests(f.file);
  vi.stubEnv("SPIDER_GLOBAL_ROOT", f.root); vi.stubEnv("PI_SUBAGENT_CHILD", "0");
  vi.stubEnv("SPIDER_HERDR_HANDOFF_FILE", undefined); vi.stubEnv("GIT_CEILING_DIRECTORIES", f.root);
  const ports = createAdmissionPorts();
  const lock = vi.spyOn(ports, "lock"), pin = vi.spyOn(ports, "lockSessionId");
  const abort = vi.fn();
  const host = createHostSessionFixture({ cwd, sessionId, sessionFile: file, hasUI, abort });
  const gate = registerAdmission(host.pi as unknown as ExtensionAPI, ports);
  async function emit(name: string, event = {}) {
    let result: unknown;
    for (const handler of host.hooks.get(name) ?? []) result = await handler(event, host.ctx);
    return result;
  }
  return { file, lockRoot, ports, lock, pin, abort, host, gate, emit };
}

function legacyWorktree(f: ReturnType<typeof fixture>, state: "active" | "frozen", epoch: number) {
  const directory = join(f.root, "worktree", ".spider");
  mkdirSync(directory, { recursive: true });
  const db = openDb(join(directory, "project.db"));
  migrate(db, "worktree", { machineId: hub, globalRoot: f.root });
  db.prepare("INSERT INTO sessions(id,reason,started_at,origin_machine) VALUES(?,?,?,?)").run(sid, "fixture", 1, hub);
  db.prepare("INSERT INTO roam_sessions(session_id,epoch,state,move_id) VALUES(?,?,?,?)")
    .run(sid, epoch, state, state === "frozen" ? "legacy-move" : null);
  db.prepare("UPDATE roam_meta SET store_key=?,capture_enabled=1 WHERE id=1").run("worktree:fixture:workspace");
  return db;
}

async function expectOrdinaryWorkRefused(session: ReturnType<typeof productionSession>, kind: "blocked" | "control-only" = "blocked") {
  expect(session.gate.inspect().kind).toBe(kind);
  expect(await session.emit("input", { text: "work" })).toEqual({ action: "handled" });
  await session.emit("before_agent_start");
  expect(session.abort).toHaveBeenCalledOnce();
  for (const toolName of ["bash", "write", "edit"]) {
    expect(await session.emit("tool_call", { toolName, input: {} })).toMatchObject({ block: true });
  }
  expect(await session.emit("user_bash", { command: "echo unsafe" })).toMatchObject({ result: { exitCode: 1 } });
  const append = vi.spyOn(session.host.pi, "appendEntry"), sendUser = vi.spyOn(session.host.pi, "sendUserMessage");
  const api = protectAdmissionApi(session.host.pi as unknown as ExtensionAPI, session.gate);
  expect(() => api.sendMessage({ customType: "test", content: "no write", display: true })).toThrow();
  api.sendUserMessage("no write"); api.appendEntry("test", { synthetic: true });
  expect(session.host.sent).toEqual([]); expect(append).not.toHaveBeenCalled(); expect(sendUser).not.toHaveBeenCalled();
  expect(session.lock).not.toHaveBeenCalled();
  if (session.host.ctx.hasUI) {
    expect(session.pin).toHaveBeenCalledOnce();
    expect(await inspectIdLock(session.lockRoot, sid)).not.toBeNull();
  } else {
    expect(session.pin).not.toHaveBeenCalled();
    expect(await inspectIdLock(session.lockRoot, sid)).toBeNull();
  }
  expect(await createSessionLeases(session.lockRoot).get(session.file)).toBeNull();
}

async function prepareMove(f: ReturnType<typeof fixture>) {
  const store = f.store(), source = await store.initialize(sid, hub);
  const moving = { ...source, state: "moving" as const, destination: box, moveId: move, epoch: 2 };
  await store.compareAndSwap(source, moving);
  const away: RunningHome = { ...moving, state: "running", machineId: box, destination: null, epoch: 3 };
  return { store, source, moving, away };
}

it.each(["no global DB", "same-Mac missing row", "same-Mac null state", "same-Mac old row", "newer peer row"] as const)(
  "production admission keeps an away fence after restoring %s", async state => {
    const f = fixture(), backup = join(f.root, "clone.db");
    if (state === "same-Mac null state") {
      f.db().prepare("INSERT INTO session_homes(session_id,machine_id,epoch,move_id,updated_at,state) VALUES(?,?,1,NULL,1,NULL)").run(sid, hub);
    } else if (state === "same-Mac old row") {
      await f.store().initialize(sid, hub);
    }
    if (state.startsWith("same-Mac")) await f.db().raw.backup(backup);
    if (state === "newer peer row") {
      const peer = openDb(join(f.root, "peer.db"));
      try {
        migrate(peer, "global", { machineId: box, globalRoot: f.root });
        peer.prepare("INSERT INTO session_homes(session_id,machine_id,epoch,move_id,updated_at,state) VALUES(?,?,4,NULL,1,'running')").run(sid, hub);
        writeLocal(peer, "relocate-managed", sid, { synthetic: true });
        await peer.raw.backup(backup);
      } finally { peer.close(); }
    }
    const { store, moving, away } = await prepareMove(f);
    await store.compareAndSwap(moving, away);
    const fence = readFileSync(f.fence);
    f.removeDb();
    let restored: Db | undefined, row: unknown;
    if (state !== "no global DB") {
      copyFileSync(backup, f.file);
      restored = f.openRestoredDb();
      row = restored.prepare("SELECT * FROM session_homes WHERE session_id=?").get(sid);
    }
    const session = productionSession(f);
    try {
      expect(session.ports.knownParticipant(sid)).toBe(false);
      await session.emit("session_start");
      await expectOrdinaryWorkRefused(session);
      expect(readFileSync(f.fence)).toEqual(fence);
      if (restored) expect(restored.prepare("SELECT * FROM session_homes WHERE session_id=?").get(sid)).toEqual(row);
      else expect(existsSync(f.file)).toBe(false);
    } finally { await session.gate.close(); }
  },
);

it.each(["away fence", "foreign legacy home", "journal-only freeze"] as const)(
  "interactive first-open refuses %s without acquiring a session lease", async state => {
    const f = fixture();
    let worktree: Db | undefined, journal: Db | undefined;
    if (state === "away fence") {
      const { store, moving, away } = await prepareMove(f);
      await store.compareAndSwap(moving, away);
      f.removeDb();
    } else if (state === "foreign legacy home") {
      f.db().prepare("INSERT INTO session_homes(session_id,machine_id,epoch,move_id,updated_at) VALUES(?,?,3,?,1)").run(sid, box, "legacy-move");
      worktree = legacyWorktree(f, "active", 3);
    } else {
      f.removeDb();
      journal = openDb(join(f.root, "roam", "journal.db"));
      journal.exec("CREATE TABLE freeze_journal(session_id TEXT, move_id TEXT, epoch INTEGER, state TEXT)");
      journal.prepare("INSERT INTO freeze_journal VALUES(?,?,?,?)").run(sid, "legacy-move", 1, "frozen");
    }
    const session = productionSession(f, sid, true);
    try {
      await session.emit("session_start");
      await expectOrdinaryWorkRefused(session, state === "journal-only freeze" ? "control-only" : "blocked");
      await session.gate.close();
      expect(await inspectIdLock(session.lockRoot, sid)).toBeNull();
    } finally { await session.gate.close(); worktree?.close(); journal?.close(); }
  },
);

it.each([
  ["corrupt bytes", false], ["corrupt bytes", true],
  ["missing state column", false], ["missing state column", true],
  ["BLOB session column", false], ["BLOB session column", true],
] as const)("an unreadable %s journal blocks ordinary work (global DB: %s)", async (damage, hasGlobalDb) => {
  const f = fixture();
  if (!hasGlobalDb) f.removeDb();
  const file = join(f.root, "roam", "journal.db");
  if (damage === "corrupt bytes") {
    writeFileSync(file, "corrupt fixture journal", { mode: 0o600 });
  } else {
    const journal = openDb(file);
    try {
      if (damage === "missing state column") {
        journal.exec("CREATE TABLE freeze_journal(session_id TEXT, move_id TEXT, epoch INTEGER)");
        journal.prepare("INSERT INTO freeze_journal VALUES(?,?,?)").run(sid, "legacy-move", 1);
      } else {
        journal.exec("CREATE TABLE freeze_journal(session_id BLOB, move_id TEXT, epoch INTEGER, state TEXT)");
        journal.prepare("INSERT INTO freeze_journal VALUES(?,?,?,?)").run(Buffer.from(sid), "legacy-move", 1, "frozen");
      }
    } finally { journal.close(); }
  }
  const before = readFileSync(file), session = productionSession(f);
  try {
    expect(session.ports.knownParticipant(sid)).toBe(false);
    await session.emit("session_start");
    await expectOrdinaryWorkRefused(session);
    expect(session.gate.inspect().blockers[0]?.detail).toContain("journal.db");
    expect(session.gate.inspect().blockers[0]?.detail).toContain("/spider roam doctor");
    expect(readFileSync(file)).toEqual(before);
    if (!hasGlobalDb) expect(existsSync(f.file)).toBe(false);
  } finally { await session.gate.close(); }
});

it.skipIf(process.platform === "win32").each([false, true])(
  "a dangling journal blocks ordinary work (global DB: %s)", async hasGlobalDb => {
    const f = fixture();
    if (!hasGlobalDb) f.removeDb();
    const file = join(f.root, "roam", "journal.db");
    symlinkSync("absent-journal.db", file);
    const session = productionSession(f);
    try {
      await session.emit("session_start");
      await expectOrdinaryWorkRefused(session);
      expect(session.gate.inspect().blockers[0]?.detail).toContain("journal.db");
      expect(session.gate.inspect().blockers[0]?.detail).toContain("/spider roam doctor");
      expect(readlinkSync(file)).toBe("absent-journal.db");
      if (!hasGlobalDb) expect(existsSync(f.file)).toBe(false);
    } finally { await session.gate.close(); }
  },
);

it("a repaired journal without freeze records admits the same unmanaged session", async () => {
  const f = fixture(); f.removeDb();
  const file = join(f.root, "roam", "journal.db");
  writeFileSync(file, "corrupt fixture journal", { mode: 0o600 });
  const session = productionSession(f);
  try {
    await session.emit("session_start");
    expect(session.gate.inspect().kind).toBe("blocked");
    unlinkSync(file);
    openJournal(file);
    await session.emit("session_start");
    expect(session.gate.inspect().kind).toBe("ordinary");
    expect(await session.emit("input", { text: "work" })).toBeUndefined();
    expect(existsSync(f.file)).toBe(false);
  } finally { await session.gate.close(); }
});

it("a genuine unmanaged local session works without creating a global DB", async () => {
  const f = fixture(); f.removeDb();
  const session = productionSession(f, "ordinary-session" as SessionId);
  try {
    await session.emit("session_start");
    expect(session.gate.inspect().kind).toBe("ordinary");
    expect(await session.emit("input", { text: "work" })).toBeUndefined();
    expect(await session.emit("tool_call", { toolName: "edit" })).toBeUndefined();
    expect(await session.emit("user_bash", { command: "echo safe" })).toBeUndefined();
    const api = protectAdmissionApi(session.host.pi as unknown as ExtensionAPI, session.gate);
    api.sendMessage({ customType: "test", content: "allowed", display: true });
    expect(session.host.sent).toHaveLength(1);
    expect(existsSync(f.file)).toBe(false);
  } finally { await session.gate.close(); }
});

it("only the authoritative Mac clears an away fence for a newer local running home", async () => {
  const f = fixture(), { store, moving, away } = await prepareMove(f);
  await store.compareAndSwap(moving, away);
  const returned: RunningHome = { ...away, machineId: hub, epoch: 4 };
  await store.compareAndSwap(away, returned);
  expect(existsSync(f.fence)).toBe(true);
  expect(await loadRelocateAdmission(sid, f.root)).toEqual({ kind: "managed", home: returned });
  expect(existsSync(f.fence)).toBe(false);
  expect(await store.read(sid)).toEqual(returned);
});

it("a newer away fence survives a compare-and-clear race", async () => {
  const f = fixture(), { store, moving, away } = await prepareMove(f);
  await store.compareAndSwap(moving, away);
  const returned: RunningHome = { ...away, machineId: hub, epoch: 4 };
  await store.compareAndSwap(away, returned);
  const replacement = { machineId: box, epoch: 5, moveId: "v0-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" as RelocateId };
  const clear = awayHome.clearAwayHomeFence;
  const race = vi.spyOn(awayHome, "clearAwayHomeFence").mockImplementation(async (root, id, expected) => {
    await awayHome.withAwayHomeFenceLock(root, id, () => awayHome.publishAwayHomeFence(root, id, replacement));
    return clear(root, id, expected);
  });
  try {
    expect(await loadRelocateAdmission(sid, f.root)).toEqual({ kind: "unavailable", awayMachine: box });
    expect(race).toHaveBeenCalledOnce();
    expect(f.fenceContents()).toMatchObject(replacement);
    expect(await store.read(sid)).toEqual(returned);
  } finally { race.mockRestore(); }
});

it.each(["pre-v0", "migrated"] as const)("a fresh admission refuses a foreign %s legacy home", async version => {
  const f = fixture();
  if (version === "pre-v0") {
    f.removeDb();
    const old = openDb(f.file);
    old.exec("CREATE TABLE roam_meta(id INTEGER PRIMARY KEY, machine_id TEXT, store_key TEXT)");
    old.prepare("INSERT INTO roam_meta VALUES(1,?,'global')").run(hub);
    old.exec("CREATE TABLE session_homes(session_id TEXT PRIMARY KEY, machine_id TEXT, epoch INTEGER, move_id TEXT, updated_at INTEGER)");
    old.close(); f.openRestoredDb();
  }
  f.db().prepare("INSERT INTO session_homes(session_id,machine_id,epoch,move_id,updated_at) VALUES(?,?,3,?,1)").run(sid, box, "legacy-move");
  const worktree = legacyWorktree(f, "active", 3);
  const beforeHome = f.db().prepare("SELECT * FROM session_homes WHERE session_id=?").get(sid);
  const beforeState = worktree.prepare("SELECT * FROM roam_sessions WHERE session_id=?").get(sid);
  const session = productionSession(f);
  try {
    expect(session.ports.knownParticipant(sid)).toBe(false);
    await session.emit("session_start");
    await expectOrdinaryWorkRefused(session);
    expect(f.db().prepare("SELECT * FROM session_homes WHERE session_id=?").get(sid)).toEqual(beforeHome);
    expect(worktree.prepare("SELECT * FROM roam_sessions WHERE session_id=?").get(sid)).toEqual(beforeState);
  } finally { await session.gate.close(); worktree.close(); }
});

it("a fresh admission keeps a frozen legacy worktree closed without a global DB", async () => {
  const f = fixture(); f.removeDb();
  const worktree = legacyWorktree(f, "frozen", 1);
  const before = worktree.prepare("SELECT * FROM roam_sessions WHERE session_id=?").get(sid);
  const session = productionSession(f);
  try {
    expect(session.ports.knownParticipant(sid)).toBe(false);
    await session.emit("session_start");
    await expectOrdinaryWorkRefused(session, "control-only");
    expect(session.ports.knownParticipant(sid)).toBe(true);
    expect(existsSync(f.file)).toBe(false);
    expect(worktree.prepare("SELECT * FROM roam_sessions WHERE session_id=?").get(sid)).toEqual(before);
  } finally { await session.gate.close(); worktree.close(); }
});

it("a fresh process refuses foreign and frozen legacy copies", async () => {
  const foreign = fixture(), frozen = fixture(), journalOnly = fixture();
  foreign.db().prepare("INSERT INTO session_homes(session_id,machine_id,epoch,move_id,updated_at) VALUES(?,?,3,?,1)").run(sid, box, "legacy-move");
  const activeStore = legacyWorktree(foreign, "active", 3);
  frozen.removeDb();
  const frozenStore = legacyWorktree(frozen, "frozen", 1);
  journalOnly.removeDb();
  mkdirSync(join(journalOnly.root, "worktree"));
  const journal = openDb(join(journalOnly.root, "roam", "journal.db"));
  journal.exec("CREATE TABLE freeze_journal(session_id TEXT, move_id TEXT, epoch INTEGER, state TEXT)");
  journal.prepare("INSERT INTO freeze_journal VALUES(?,?,?,?)").run(sid, "legacy-move", 1, "frozen");
  const before = [foreign.db().prepare("SELECT * FROM session_homes WHERE session_id=?").get(sid),
    frozenStore.prepare("SELECT * FROM roam_sessions WHERE session_id=?").get(sid),
    journal.prepare("SELECT * FROM freeze_journal").all()];
  const roots = [foreign.root, frozen.root, journalOnly.root];
  for (const root of roots) {
    const cwd = join(root, "worktree");
    writeFileSync(join(root, "session.jsonl"), JSON.stringify({ type: "session", version: 3, id: sid, cwd }) + "\n", { mode: 0o600 });
  }
  // Node's test-only loader runs the real TypeScript modules in a separate process.
  const script = String.raw`
    import { registerHooks } from 'node:module';
    import { existsSync, readFileSync } from 'node:fs';
    import { join, resolve } from 'node:path';
    import { fileURLToPath, pathToFileURL } from 'node:url';
    import ts from 'typescript';
    registerHooks({
      resolve(specifier, context, next) {
        if (context.parentURL?.startsWith('file:') && (specifier.startsWith('./') || specifier.startsWith('../'))) {
          const [base, query] = specifier.split('?');
          const url = new URL(base, context.parentURL);
          if (base.endsWith('.js') && !existsSync(fileURLToPath(url))) {
            const tsFile = new URL(base.slice(0, -3) + '.ts', context.parentURL);
            if (existsSync(fileURLToPath(tsFile))) return next(tsFile.href + (query ? '?' + query : ''), context);
          }
          if (!/\.[a-z0-9]+$/i.test(base)) {
            const tsFile = new URL(base + '.ts', context.parentURL);
            if (existsSync(fileURLToPath(tsFile))) return next(tsFile.href + (query ? '?' + query : ''), context);
          }
        }
        return next(specifier, context);
      },
      load(url, context, next) {
        if (url.endsWith('?raw')) return { format: 'module', shortCircuit: true,
          source: 'export default ' + JSON.stringify(readFileSync(fileURLToPath(url.slice(0, -4)), 'utf8')) + ';' };
        if (url.endsWith('.ts')) return { format: 'module', shortCircuit: true,
          source: ts.transpileModule(readFileSync(fileURLToPath(url), 'utf8'),
            { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText };
        return next(url, context);
      },
    });
    const { roots, sessionId } = JSON.parse(readFileSync(0, 'utf8'));
    const { paths, setGlobalDbPathForTests } = await import('@spider/db-core');
    const { createAdmissionPorts, registerAdmission, protectAdmissionApi } = await import(
      pathToFileURL(resolve('packages/host/src/roam/admission.ts')).href);
    const results = [];
    for (const root of roots) {
      paths.globalRoot = root; setGlobalDbPathForTests(join(root, 'spider.db'));
      process.env.SPIDER_GLOBAL_ROOT = root; process.env.GIT_CEILING_DIRECTORIES = root;
      const cwd = join(root, 'worktree'), file = join(root, 'session.jsonl');
      const hooks = new Map(), writes = [];
      const pi = { on(name, fn) { hooks.set(name, fn); }, sendMessage(value) { writes.push(value); } };
      const ctx = { cwd, mode: 'tui', hasUI: false, ui: { notify() {} }, abort() {},
        sessionManager: { getSessionId: () => sessionId, getSessionFile: () => file } };
      const ports = createAdmissionPorts(), initialKnown = ports.knownParticipant(sessionId);
      let locks = 0;
      const lock = ports.lock;
      ports.lock = (...args) => { locks++; return lock(...args); };
      const gate = registerAdmission(pi, ports);
      await hooks.get('session_start')({}, ctx);
      const input = await hooks.get('input')({ text: 'work' }, ctx);
      const edit = await hooks.get('tool_call')({ toolName: 'edit' }, ctx);
      const shell = await hooks.get('user_bash')({ command: 'echo unsafe' }, ctx);
      let producerBlocked = false;
      try { protectAdmissionApi(pi, gate).sendMessage({ customType: 'test', content: 'no write', display: true }); }
      catch { producerBlocked = true; }
      results.push({ initialKnown, kind: gate.inspect().kind, input: input?.action, edit: edit?.block,
        shell: shell?.result?.exitCode, producerBlocked, writes: writes.length, locks });
      await gate.close();
    }
    process.stdout.write(JSON.stringify({ pid: process.pid, results }));
  `;
  try {
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: resolve("."), input: JSON.stringify({ roots, sessionId: sid }), encoding: "utf8",
      env: { ...process.env, VITEST: "true", NODE_NO_WARNINGS: "1", PI_SUBAGENT_CHILD: "0",
        SPIDER_GLOBAL_ROOT: roots[0], SPIDER_TEST_FIXTURE_CHECKOUT: resolve(".") },
    });
    expect(child.error).toBeUndefined();
    expect(child.status, child.stderr).toBe(0);
    const observed = JSON.parse(child.stdout) as { pid: number; results: unknown[] };
    expect(observed.pid).not.toBe(process.pid);
    const refusal = { initialKnown: false, input: "handled", edit: true, shell: 1, producerBlocked: true, writes: 0, locks: 0 };
    expect(observed.results).toEqual([
      { ...refusal, kind: "blocked" }, { ...refusal, kind: "control-only" }, { ...refusal, kind: "control-only" },
    ]);
    expect(foreign.db().prepare("SELECT * FROM session_homes WHERE session_id=?").get(sid)).toEqual(before[0]);
    expect(frozenStore.prepare("SELECT * FROM roam_sessions WHERE session_id=?").get(sid)).toEqual(before[1]);
    expect(journal.prepare("SELECT * FROM freeze_journal").all()).toEqual(before[2]);
    expect(existsSync(frozen.file)).toBe(false); expect(existsSync(journalOnly.file)).toBe(false);
    for (const root of roots) {
      expect(await inspectIdLock(join(root, "herdr"), sid)).toBeNull();
      expect(await createSessionLeases(join(root, "herdr")).get(join(root, "session.jsonl"))).toBeNull();
    }
  } finally { activeStore.close(); frozenStore.close(); journal.close(); }
});

it("a verified legacy freeze keeps its ownership-only control path", async () => {
  const f = fixture(), worktree = legacyWorktree(f, "frozen", 1), session = productionSession(f);
  const release = vi.fn(async () => {});
  session.lock.mockResolvedValue(release);
  try {
    expect(session.ports.knownParticipant(sid)).toBe(false);
    await session.emit("session_start");
    expect(session.gate.inspect().kind).toBe("control-only");
    expect(session.lock).toHaveBeenCalledOnce();
    expect(session.lock).toHaveBeenCalledWith(sid, session.file);
    expect(await session.emit("input", { text: "work" })).toEqual({ action: "handled" });
    expect(await session.emit("tool_call", { toolName: "edit" })).toMatchObject({ block: true });
    await expect(session.gate.freeze("legacy-move", 1)).resolves.toBeUndefined();
  } finally { await session.gate.close(); worktree.close(); }
  expect(release).toHaveBeenCalledOnce();
});

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
  const f = fixture(), { store, source, moving, away } = await prepareMove(f);
  expect(existsSync(f.fence)).toBe(false);
  let atCas: unknown;
  f.db().raw.function("observe_away_fence", () => { atCas = existsSync(f.fence) ? f.fenceContents() : null; return 1; });
  f.db().exec(`CREATE TRIGGER fault_before_commit BEFORE UPDATE ON session_homes WHEN NEW.machine_id='${box}'
    BEGIN SELECT observe_away_fence(); SELECT RAISE(ABORT, 'fixture fault before CAS'); END;`);
  await expect(store.compareAndSwap(moving, away)).rejects.toThrow("fixture fault before CAS");
  expect(atCas).toMatchObject({ machineId: box, epoch: 3, moveId: move });
  expect(await store.read(sid)).toEqual(moving);
  expect(await loadRelocateAdmission(sid, f.root)).toEqual({ kind: "unavailable", awayMachine: box });

  const stopStore = createSessionStopStore(f.db());
  const forcePorts: ForceHomePorts = { ...f.forcePorts(), newMoveId: () => "v0-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" as RelocateId,
    commitStopped: (expected, home) => store.compareAndSwap(expected, home, async () => ({ ok: true, value: undefined }),
      () => stopStore.write({ action: "force", operationId: "fixture-force", expected, committed: home, mode: "graceful",
        displaced: displacedByForce(expected, home, stopStore.current(sid)), observations: [], contactReason: null })),
  };
  const sourcePlacement = await forcePorts.locate(hub, sid), destinationPlacement = await forcePorts.locate(box, sid);
  if (!sourcePlacement.ok || !destinationPlacement.ok) throw new Error("Fixture placement is missing");
  const unexpected = async () => { throw new Error("Undo must not prepare or transfer a new move"); };
  const undoPorts: RelocatePorts = { ...forcePorts,
    initialSource: unexpected, check: unexpected, pullSource: unexpected, pushDestination: unexpected, installDestination: unexpected,
    stopSource: async () => ({ ok: true, value: undefined }),
    journal: { save: unexpected, load: async () => ({
      plan: { moveId: move, source, sourcePlacement: sourcePlacement.value, destinationPlacement: destinationPlacement.value,
        startedAt: moving.updatedAt, destinationPrerequisites: [] },
      completed: ["check", "mark-moving"], captured: null, installed: null, terminal: null, result: null,
    }) },
  };
  const forwardOnly = { ok: false, refusal: { code: "home-unavailable", message: expect.stringMatching(/only finish/i),
    nextStep: expect.stringContaining(`spider roam relocate ${sid} ${box}`) } };
  const undo = await relocate({ sessionId: sid, destinationMachine: hub }, undoPorts);
  const force = (destinationMachine: string) => setHome({ sessionId: sid, destinationMachine, force: true,
    confirmation: `reassign ${sid} to ${destinationMachine}; source will not run` }, forcePorts);
  expect([undo, await force(hub), await force(box)]).toMatchObject([
    { ...forwardOnly, step: "commit-home", home: moving }, forwardOnly, forwardOnly,
  ]);
  expect(await store.read(sid)).toEqual(moving);
  expect(f.fenceContents()).toEqual(atCas);
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

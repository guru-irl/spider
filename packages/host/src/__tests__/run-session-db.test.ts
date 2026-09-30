import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { bindSession, openDbAt, openGlobal, paths, setGlobalDbPathForTests, type Db } from "@spider/db-core";
import { makeRunHandler, teardownCoordinators, type ChildSpawnSpec } from "@spider/subagents";
import spiderExtension, { buildActionCtx, openSessionRunDb } from "../extension";
import { dispatch, registerAction, type SpiderArgs } from "../dispatch";
import { assertPreflightIsolation } from "./fixture-safety";

const scratch = resolve(".spider/scratch/run-session-db-test");
const handles: Db[] = [];
const roots: string[] = [];
const sessions: string[] = [];

afterEach(() => {
  for (const session of sessions.splice(0)) teardownCoordinators(session);
  for (const db of handles.splice(0)) { try { db.close(); } catch {} }
  setGlobalDbPathForTests(null);
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, "case-"));
  roots.push(root);
  const repos = ["repoA", "repoB", "repoC"].map(name => {
    const repo = join(root, name);
    mkdirSync(repo);
    execFileSync("git", ["init", "-q", repo]);
    assertPreflightIsolation(repo, root);
    return repo;
  });
  setGlobalDbPathForTests(join(root, "global.db"));
  const [repoA, repoB, repoC] = repos;
  const sessionId = `session-${roots.length}-${Date.now()}`;
  sessions.push(sessionId);
  const hooks: Record<string, Array<Function>> = {};
  const pi = {
    on: (name: string, handler: Function) => { (hooks[name] ??= []).push(handler); },
    registerTool: () => {}, registerCommand: () => {},
  };
  vi.stubEnv("PI_SUBAGENT_CHILD", "0");
  spiderExtension(pi as never);
  const specs: ChildSpawnSpec[] = [];
  const kills: Array<ReturnType<typeof vi.fn>> = [];
  // Only the external process is faked; dispatch, RunStore, Runner, pipeline and DBs are real.
  registerAction("run", makeRunHandler({ spawner: spec => {
    specs.push(spec);
    const kill = vi.fn();
    kills.push(kill);
    return { wait: () => new Promise<never>(() => {}), kill, detach: () => {} };
  } }));
  const invoke = async (args: SpiderArgs, sessionCwd = repoA) => {
    const ctx = buildActionCtx(pi as never, args, sessionId, sessionCwd);
    handles.push(ctx.db, ctx.repoDb, ctx.globalDb);
    return dispatch(args, ctx);
  };
  const rows = (repo: string) => {
    const db = openDbAt(join(paths.projectRoot(repo), "project.db"), "project");
    handles.push(db);
    return db.prepare("SELECT id, status FROM runs WHERE session_id = ?").all(sessionId) as Array<{ id: string; status: string }>;
  };
  return { root, repoA, repoB, repoC, sessionId, pi, hooks, specs, kills, invoke, rows };
}

const modes: Array<[string, Omit<SpiderArgs, "action" | "cwd">]> = [
  ["single", { agent: "worker", task: "inspect" }],
  ["parallel", { tasks: [{ agent: "worker", task: "inspect" }] }],
  ["chain", { chain: [{ agent: "worker", task: "inspect" }] }],
  ["pipeline", { pipeline: [{ agent: "worker", task: "inspect" }] }],
];

describe("session-owned run records with an explicit child cwd", () => {
  for (const [mode, options] of modes) {
    it(`${mode} records in the session DB while spawning in repoB`, async () => {
      const f = fixture();
      await f.invoke({ action: "run", cwd: f.repoB, ...options });
      expect(f.rows(f.repoA)).toHaveLength(1);
      expect(f.rows(f.repoB)).toHaveLength(0);
      expect(f.specs).toHaveLength(1);
      expect(f.specs[0].cwd).toBe(f.repoB);
      expect(f.specs[0].env.PI_SPIDER_DB_PATH).toBe(join(f.repoA, ".spider", "project.db"));
      // Scratch and child transcripts continue to follow the child cwd, not the run DB.
      expect(f.specs[0].sessionFile).toContain(join(f.repoB, ".spider", "scratch"));
    });
  }

  it("kill by id and message to a run find the session-owned record without cwd", async () => {
    const f = fixture();
    await f.invoke({ action: "run", cwd: f.repoB, agent: "worker", task: "inspect" });
    const id = f.specs[0].env.PI_SUBAGENT_RUN_ID!;
    const msg = await f.invoke({ action: "message", to: id, message: "hello" }) as { details: { runId?: string; delivered?: boolean } };
    expect(msg.details).toMatchObject({ runId: id, delivered: false });
    const killed = await f.invoke({ action: "kill", id }) as { details: { killed: Array<{ runId: string; outcome: string }> } };
    expect(killed.details.killed).toMatchObject([{ runId: id, outcome: "killed" }]);
    expect(f.kills[0]).toHaveBeenCalledOnce();
    expect(f.rows(f.repoA)[0].status).toBe("cancelled");
  });

  it("message and kill with an explicit repoB cwd still find the session-owned run", async () => {
    const f = fixture();
    await f.invoke({ action: "run", cwd: f.repoB, agent: "worker", task: "inspect" });
    const id = f.specs[0].env.PI_SUBAGENT_RUN_ID!;
    const msg = await f.invoke({ action: "message", to: id, message: "hello", cwd: f.repoB }) as { details: { runId?: string; delivered?: boolean } };
    expect(msg.details).toMatchObject({ runId: id, delivered: false });
    const killed = await f.invoke({ action: "kill", id, cwd: f.repoB }) as { details: { killed: Array<{ runId: string; outcome: string }> } };
    expect(killed.details.killed).toMatchObject([{ runId: id, outcome: "killed" }]);
    expect(f.kills[0]).toHaveBeenCalledOnce();
    expect(f.rows(f.repoA)[0].status).toBe("cancelled");
    expect(f.rows(f.repoB)).toHaveLength(0);
  });

  it("a nested session cwd passes the repo root DB to its child", async () => {
    const f = fixture();
    const sub = join(f.repoA, "sub"); mkdirSync(sub);
    await f.invoke({ action: "run", cwd: f.repoB, agent: "worker", task: "inspect" }, sub);
    const mount = openSessionRunDb(sub, f.sessionId); handles.push(mount.db);
    const dbFile = (db: Db) => (db.raw.pragma("database_list") as Array<{ file: string }>)[0].file;
    expect(f.specs[0].env.PI_SPIDER_DB_PATH).toBe(join(f.repoA, ".spider", "project.db"));
    expect(dbFile(mount.db)).toBe(join(f.repoA, ".spider", "project.db"));
    expect(f.rows(f.repoA)).toHaveLength(1);
    expect(f.rows(f.repoB)).toHaveLength(0);
  });

  it("falls back to process cwd, not the child's cwd, when host cwd is absent", async () => {
    const f = fixture();
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(f.repoA);
    try {
      const args: SpiderArgs = { action: "run", cwd: f.repoB, agent: "worker", task: "inspect" };
      const ctx = buildActionCtx(f.pi as never, args, f.sessionId);
      handles.push(ctx.db, ctx.repoDb, ctx.globalDb);
      await dispatch(args, ctx);
    } finally { cwd.mockRestore(); }
    expect(f.rows(f.repoA)).toHaveLength(1);
    expect(f.rows(f.repoB)).toHaveLength(0);
    expect(f.specs[0].env.PI_SPIDER_DB_PATH).toBe(join(f.repoA, ".spider", "project.db"));
  });

  it.each(["run", "kill", "message"] as const)("%s names the session run DB path when it cannot be opened", action => {
    const f = fixture();
    const dbPath = join(f.repoA, ".spider", "project.db");
    mkdirSync(join(f.repoA, ".spider"));
    writeFileSync(dbPath, "not a sqlite database");
    const args: SpiderArgs = { action, cwd: f.repoB, agent: "worker", task: "inspect", id: "missing", to: "missing", message: "hello" };
    expect(() => buildActionCtx(f.pi as never, args, f.sessionId, f.repoA))
      .toThrow(`session run DB (${dbPath})`);
  });

  it("names the session run DB path when its session directory is missing", () => {
    const f = fixture();
    const gone = join(f.root, "gone");
    expect(() => buildActionCtx(f.pi as never, { action: "run", cwd: f.repoB }, f.sessionId, gone))
      .toThrow(`session run DB (${join(gone, ".spider", "project.db")})`);
  });

  it("binds the session run DB to repoC without changing an explicit repoB child cwd", async () => {
    const f = fixture();
    const globalDb = openGlobal(); handles.push(globalDb);
    bindSession(globalDb, f.sessionId, f.repoC);
    await f.invoke({ action: "run", cwd: f.repoB, agent: "worker", task: "inspect" });
    expect(f.rows(f.repoC)).toHaveLength(1);
    expect(f.rows(f.repoA)).toHaveLength(0);
    expect(f.rows(f.repoB)).toHaveLength(0);
    expect(f.specs[0].cwd).toBe(f.repoB);
    expect(f.specs[0].env.PI_SPIDER_DB_PATH).toBe(join(f.repoC, ".spider", "project.db"));
  });

  it("the mounted view and dispatch use the same session run DB file after a bind", async () => {
    const f = fixture();
    const globalDb = openGlobal(); handles.push(globalDb);
    bindSession(globalDb, f.sessionId, f.repoC);
    const mountDb = openSessionRunDb(f.repoA, f.sessionId); handles.push(mountDb.db);
    const args: SpiderArgs = { action: "run", cwd: f.repoB, agent: "worker", task: "inspect" };
    const actionCtx = buildActionCtx(f.pi as never, args, f.sessionId, f.repoA);
    handles.push(actionCtx.db, actionCtx.repoDb, actionCtx.globalDb);
    const dbFile = (db: Db) => (db.raw.pragma("database_list") as Array<{ file: string }>)[0].file;
    expect(dbFile(mountDb.db)).toBe(join(f.repoC, ".spider", "project.db"));
    expect(dbFile(actionCtx.db)).toBe(dbFile(mountDb.db));
    await dispatch(args, actionCtx);
    const setWidget = vi.fn();
    const ctx = { cwd: f.repoA, sessionManager: { getSessionId: () => f.sessionId }, hasUI: true,
      ui: { setWidget, custom: vi.fn(), notify: vi.fn() } };
    // The last session_start handler mounts the production agents view, which reads
    // existing runs immediately and creates a widget only when it sees one.
    f.hooks.session_start.at(-1)!({}, ctx);
    expect(setWidget).toHaveBeenCalledWith("spider-agents", expect.any(Function), { placement: "aboveEditor" });
    for (const fn of f.hooks.session_shutdown ?? []) await fn();
  });

  it("keeps explicit-cwd todo in repoB while a run from the same session lives in repoA", async () => {
    const f = fixture();
    await f.invoke({ action: "todo", op: "add", cwd: f.repoB, text: "fixture task" });
    const dbB = openDbAt(join(f.repoB, ".spider", "project.db"), "project"); handles.push(dbB);
    const dbA = openDbAt(join(f.repoA, ".spider", "project.db"), "project"); handles.push(dbA);
    expect(dbB.prepare("SELECT text FROM todos WHERE session_id = ?").all(f.sessionId)).toMatchObject([{ text: "fixture task" }]);
    expect(dbA.prepare("SELECT text FROM todos WHERE session_id = ?").all(f.sessionId)).toHaveLength(0);
    await f.invoke({ action: "run", cwd: f.repoB, agent: "worker", task: "inspect" });
    expect(f.rows(f.repoA)).toHaveLength(1);
  });
});

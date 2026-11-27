import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createReplica } from "@spider/db-core/testutil";
import { openDbAt, registerProject, setGlobalDbPathForTests } from "@spider/db-core";
import { DEFAULT_LIMITS, disabledIntercom } from "../contracts";
import { openJournal } from "../journal";
import { createHomeStore } from "../relocate/home";
import { createRelocateAdapters } from "../relocate/adapters";
import { inspectLocalSource } from "../relocate/local";
import * as hcApi from "@spider/herdr/client/hc";
import type { MovingHome, RelocateAdapterOptions, RelocateId, RelocatePlan, RunningHome, SessionId } from "../relocate/types";

const mac = "11111111-1111-4111-8111-111111111111", box = "22222222-2222-4222-8222-222222222222";
const sid = "ordinary-session" as SessionId;
const cleanups: (() => void)[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); setGlobalDbPathForTests(null); for (const close of cleanups.splice(0).reverse()) close(); });
function fixture() {
  vi.spyOn(hcApi, "invokeCli").mockResolvedValue({ terminals: [] });
  const global = createReplica("global", mac); cleanups.push(() => global.close());
  const cwd = join(global.root, "checkout"); mkdirSync(cwd);
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" };
  const git = (...argv: string[]) => execFileSync("git", argv, { cwd, env });
  git("init", "-b", "main"); writeFileSync(join(cwd, "file.txt"), "base\n"); git("add", "."); git("commit", "-m", "base");
  mkdirSync(join(cwd, ".spider")); writeFileSync(join(cwd, ".gitignore"), ".spider/\n");
  const projectPath = join(cwd, ".spider", "project.db"), project = openDbAt(projectPath, "worktree"); cleanups.push(() => project.close());
  project.prepare("UPDATE roam_meta SET machine_id=? WHERE id=1").run(mac);
  // These are the normal host's session row and project registration, not roaming capture.
  project.prepare("INSERT INTO sessions(id,name,started_at,origin_machine) VALUES (?,?,?,?)").run(sid, "ordinary", 1, mac);
  setGlobalDbPathForTests(global.db.raw.name); registerProject({ projectKey: cwd, realPath: cwd, dbPath: projectPath });
  global.db.prepare("INSERT INTO roam_repo_maps(repo_key,path,worktree_command_json) VALUES ('repo',?,NULL)").run(cwd);
  const agent = join(global.root, "agent"), sessions = join(agent, "sessions", "checkout"); mkdirSync(sessions, { recursive: true });
  const file = join(sessions, `2020-01-01_${sid}.jsonl`);
  writeFileSync(file, JSON.stringify({ type: "session", version: 3, id: sid, cwd, timestamp: "2020-01-01T00:00:00Z" }) + "\n" + JSON.stringify({ type: "message", id: "entry", parentId: null, timestamp: "2020-01-01T00:00:00Z", message: { role: "user", content: [{ type: "text", text: "ordinary" }] } }) + "\n");
  vi.stubEnv("PI_CODING_AGENT_DIR", agent);
  const config = { enabled: true, role: "hub" as const, machineId: mac, hubMachineId: mac, peers: [], discoveryRoots: [], coreUnit: "core", syncMs: 10000, limits: DEFAULT_LIMITS, intercom: disabledIntercom() };
  const journal = openJournal(join(global.root, "journal.db")), homes = createHomeStore({ db: global.db, hubMachineId: mac, localMachineId: mac });
  const gitPorts: RelocateAdapterOptions["git"] = { run: async (root, argv, options) => execFileSync(argv[0], [...argv.slice(1)], { cwd: root, env: { ...env, ...options?.env }, input: options?.stdin }), journal, limits: DEFAULT_LIMITS, scratch: join(global.root, "git"), worktreeCommand: null };
  const unused = async () => { throw new Error("No remote work in source capture"); };
  const options: RelocateAdapterOptions = { root: global.root, config, globalDb: global.db, homes, journal, sync: { start() {}, stop() {}, sync: async () => [], barriers: async () => true }, transport: { resolve: async p => p, bootstrapProbe: unused, exec: unused, run: unused, read: unused, write: unused }, clock: { now: Date.now, later: () => () => {} }, git: gitPorts, workspaceImport: { ...gitPorts, resolveCommonRepository: async () => cwd, lastExportedSnapshot: async () => null, verifiedArtifactPath: async () => null }, limits: DEFAULT_LIMITS };
  const adapters = createRelocateAdapters(options);
  return { global, project, cwd, file, options, adapters, homes, git };
}
function pristine(f: ReturnType<typeof fixture>) {
  expect(f.global.db.prepare("SELECT * FROM roam_workspace_maps").all()).toEqual([]);
  expect(f.global.db.prepare("SELECT * FROM roam_locations").all()).toEqual([]);
  expect(f.project.prepare("SELECT * FROM roam_sessions").all()).toEqual([]);
  expect(f.project.prepare("SELECT store_key,capture_enabled FROM roam_meta WHERE id=1").get()).toEqual({ store_key: null, capture_enabled: 0 });
}
async function plan(f: ReturnType<typeof fixture>): Promise<{ plan: RelocatePlan; moving: MovingHome }> {
  const ready = await inspectLocalSource(sid, f.options);
  expect(ready.ok).toBe(true); if (!ready.ok) throw new Error(ready.refusal.message);
  const source = await f.homes.initialize(sid, mac) as RunningHome;
  const plan: RelocatePlan = { source, sourcePlacement: ready.value.placement, destinationPlacement: { ...ready.value.placement, machineId: box }, moveId: "v0-33333333-3333-4333-8333-333333333333" as RelocateId, startedAt: 1, destinationPrerequisites: [] };
  return { plan, moving: { ...source, epoch: 2, state: "moving", moveId: plan.moveId, destination: box } };
}
describe("ordinary Mac source", () => {
  it("discovers an ordinary session without enabling capture during check", async () => {
    const f = fixture(); pristine(f);
    const before = readFileSync(f.file), head = f.git("rev-parse", "HEAD");
    expect(await f.adapters.ports.initialSource(sid)).toEqual({ ok: true, value: mac });
    expect(await inspectLocalSource(sid, f.options)).toMatchObject({ ok: true, value: { epoch: 1, state: "active", placement: { sessionId: sid, cwd: f.cwd, file: f.file, repoKey: "repo" } } });
    pristine(f); expect(readFileSync(f.file)).toEqual(before); expect(f.git("rev-parse", "HEAD")).toEqual(head);
  });
  it("discovers an ordinary source past stale and unreadable project registrations", async () => {
    const f = fixture();
    const removed = join(f.global.root, "removed-worktree"), unreadable = join(f.global.root, "unreadable-worktree");
    mkdirSync(unreadable);
    writeFileSync(join(unreadable, "project.db"), "not a SQLite database\n");
    for (const root of [removed, unreadable]) {
      registerProject({ projectKey: root, realPath: root, dbPath: join(root, "project.db") });
    }
    expect(await f.adapters.ports.initialSource(sid)).toEqual({ ok: true, value: mac });
    expect(await inspectLocalSource(sid, f.options)).toMatchObject({ ok: true, value: { placement: { file: f.file, cwd: f.cwd } } });
    expect(await inspectLocalSource("missing-session" as SessionId, f.options)).toMatchObject({ ok: false, refusal: {
      code: "session-not-found", message: expect.stringMatching(/skipped 2 project databases/i),
      nextStep: expect.stringContaining("Restore the session's project database"),
    } });
    pristine(f);
  });
  it("captures the ordinary session after moving and stop, and converges on retry", async () => {
    const f = fixture(), { plan: p, moving } = await plan(f);
    await f.homes.compareAndSwap(p.source, moving);
    expect(await f.adapters.ports.stopSource(p, moving)).toEqual({ ok: true, value: undefined });
    expect(f.global.db.prepare("SELECT session_id,file,cwd FROM roam_locations").all()).toEqual([{ session_id: sid, file: f.file, cwd: f.cwd }]);
    expect(f.global.db.prepare("SELECT path FROM roam_workspace_maps").all()).toEqual([{ path: f.cwd }]);
    expect(f.project.prepare("SELECT epoch,state FROM roam_sessions WHERE session_id=?").get(sid)).toEqual({ epoch: 1, state: "frozen" });
    const changes = f.project.prepare("SELECT * FROM roam_changes").all();
    expect(await f.adapters.ports.stopSource(p, moving)).toEqual({ ok: true, value: undefined });
    expect(f.project.prepare("SELECT * FROM roam_changes").all()).toEqual(changes);
    expect(await f.adapters.ports.pullSource(p)).toMatchObject({ ok: true, value: { session: { sessionId: sid } } });
  });
  it("reports retryable seed contention when capturing a stopped ordinary source", async () => {
    const f = fixture(), { plan: p, moving } = await plan(f);
    await f.homes.compareAndSwap(p.source, moving);
    f.project.prepare("INSERT INTO runs (id,session_id,agent,status,task) VALUES ('busy-run',?,'worker','cancelled',?)")
      .run(sid,"x".repeat(16*1024*1024+1));
    const busy = {ok:false,refusal:{code:"session-busy",nextStep:"Close running subagents, then rerun relocate."}};
    expect(await f.adapters.ports.stopSource(p,moving)).toMatchObject(busy);
    expect(await f.homes.read(sid)).toEqual(moving);
    expect(f.global.db.prepare("SELECT file,cwd FROM roam_locations WHERE session_id=?").get(sid)).toEqual({file:null,cwd:null});
    expect(await f.adapters.ports.stopSource(p,moving)).toMatchObject(busy);
    f.project.prepare("DELETE FROM runs WHERE id='busy-run'").run();
    expect(await f.adapters.ports.stopSource(p,moving)).toEqual({ok:true,value:undefined});
    expect(f.global.db.prepare("SELECT file,cwd FROM roam_locations WHERE session_id=?").get(sid)).toEqual({file:f.file,cwd:f.cwd});
    expect(f.project.prepare("SELECT epoch,state FROM roam_sessions WHERE session_id=?").get(sid)).toEqual({epoch:1,state:"frozen"});
  });
  it("resumes partial ordinary seeding before freezing the source", async () => {
    const f=fixture(), {plan:p,moving}=await plan(f);
    f.options.limits={...f.options.limits,hardBatchBytes:1024};
    const insert=f.project.prepare("INSERT INTO runs (id,session_id,agent,status,task) VALUES (?,?, 'worker','done',?)");
    for(let i=0;i<66;i++)insert.run(`run-${i}`,sid,"x".repeat(1024));
    await f.homes.compareAndSwap(p.source,moving);
    expect(await f.adapters.ports.stopSource(p,moving)).toMatchObject({ok:false,refusal:{code:"session-busy"}});
    expect(f.project.prepare("SELECT state FROM roam_sessions WHERE session_id=?").get(sid)).toEqual({state:"active"});
    expect(await f.adapters.ports.stopSource(p,moving)).toEqual({ok:true,value:undefined});
    expect(f.project.prepare("SELECT state FROM roam_sessions WHERE session_id=?").get(sid)).toEqual({state:"frozen"});
    expect(f.project.prepare("SELECT count(*) AS count FROM roam_changes WHERE entity='runs'").get()).toEqual({count:66});
  });
  it("does not capture while source stop cannot prove terminal exit", async () => {
    const f = fixture(), { plan: p, moving } = await plan(f);
    await f.homes.compareAndSwap(p.source, moving);
    vi.mocked(hcApi.invokeCli).mockResolvedValue({ terminals: [{ address: "pending", state: "live", pid: null }] });
    expect(await f.adapters.ports.stopSource(p, moving)).toMatchObject({ ok: false, refusal: { code: "stop-timeout" } });
    pristine(f);
  });
  it("does not capture or map when the moving home is not authoritative", async () => {
    const f = fixture(), { plan: p, moving } = await plan(f);
    expect(await f.adapters.ports.stopSource(p, moving)).toMatchObject({ ok: false, refusal: { code: "home-conflict" } });
    pristine(f);
  });
});

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createReplica } from "@spider/db-core/testutil";
import { recordLocation } from "@spider/db-core/roam/catalog";
import { writeLocal } from "@spider/db-core/roam/local-state";
import type { MachineId } from "@spider/db-core/roam/types";
import { DEFAULT_LIMITS, disabledIntercom } from "../contracts";
import { createHomeStore } from "../relocate/home";
import { createLocalRuntime, type LocalIO } from "../relocate/local";
import { queueStopMode } from "../relocate/local-stop";
import { createHomeSupervisor } from "../relocate/supervisor";
import type { RelocateAdapterOptions, SessionId, StoppedHome } from "../relocate/types";

const machine = "11111111-1111-4111-8111-111111111111" as MachineId;
const hub = "22222222-2222-4222-8222-222222222222" as MachineId;
const bad = "broken-session" as SessionId;
const healthy = "healthy-session" as SessionId;
const boot = "f22f2604-548d-421d-b5cb-9f31d7b50bd1";
const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });

function fixture() {
  const global = createReplica("global", machine), project = createReplica("worktree", machine);
  cleanup.push(global.close, project.close);
  const checkout = join(global.root, "checkout"), key = project.storeKey;
  mkdirSync(checkout);
  global.db.prepare("INSERT INTO roam_workspace_maps(repo_key,workspace_id,path) VALUES ('fixture-repo','fixture-workspace',?)").run(checkout);
  writeLocal(global.db, "mapping-redirect", key, project.db.raw.name);
  const homes = createHomeStore({ db: global.db, hubMachineId: hub, localMachineId: machine });
  const home = (sessionId: SessionId): StoppedHome => ({ sessionId, machineId: machine, epoch: 8, state: "stopped", destination: null, moveId: null, updatedAt: 8 });
  const ids = [bad, healthy];
  const files = new Map(ids.map(id => [id, join(global.root, `${id}.jsonl`)]));
  const pids = new Map([[bad, 83001], [healthy, 83002]]);
  const live = new Set(pids.values());
  for (const id of ids) {
    const file = files.get(id)!;
    writeFileSync(file, "", { mode: 0o600 });
    recordLocation(global.db, { sessionId: id, stores: ["global", key], home: null, cwd: checkout, file });
    project.db.prepare("INSERT INTO sessions(id,started_at) VALUES (?,1)").run(id);
    project.db.prepare("INSERT INTO roam_sessions(session_id,epoch,state) VALUES (?,7,'active')").run(id);
    global.db.prepare("INSERT INTO session_homes(session_id,machine_id,epoch,state,destination,move_id,updated_at) VALUES (?,?,8,'stopped',NULL,NULL,8)").run(id, machine);
  }
  let now = 0;
  const timers = new Map<() => void, number>();
  const unused = (): never => { throw new Error("Unexpected unrelated effect"); };
  const journal = {} as RelocateAdapterOptions["journal"];
  const limits = { ...DEFAULT_LIMITS, readyMs: 15_000 };
  const git: RelocateAdapterOptions["git"] = { run: unused, journal, limits, scratch: global.root, worktreeCommand: null };
  const options: RelocateAdapterOptions = {
    root: global.root, globalDb: global.db, homes, journal, git, limits,
    config: { enabled: true, role: "box", machineId: machine, hubMachineId: hub, peers: [], discoveryRoots: [], coreUnit: "core", syncMs: 120000, limits, intercom: disabledIntercom() },
    sync: { start: unused, stop: unused, sync: unused, barriers: unused },
    transport: { resolve: unused, bootstrapProbe: unused, exec: unused, run: unused, read: unused, write: unused },
    clock: { now: () => now, later(ms, fn) { timers.set(fn, now + ms); return () => { timers.delete(fn); }; } },
    workspaceImport: { ...git, resolveCommonRepository: unused, lastExportedSnapshot: unused, verifiedArtifactPath: unused },
  };
  const signals: Array<[number, string]> = [];
  const launches: string[] = [];
  let onInspect: (() => void) | undefined;
  const io: LocalIO = {
    bootId: async () => boot,
    inspect: async id => {
      const callback = onInspect; onInspect = undefined; callback?.();
      const pid = pids.get(id as SessionId);
      return pid && live.has(pid) ? { identity: { pid, startIdentity: `birth-${pid}` }, bootId: boot,
        pendingOperationId: null, pendingFile: null, pendingCoreId: null, operationId: null } : null;
    },
    fileLease: async file => {
      const id = ids.find(candidate => files.get(candidate) === file), pid = id && pids.get(id);
      return pid && live.has(pid) ? { pid, startIdentity: `birth-${pid}`, bootId: boot } : null;
    },
    claimFree: async () => {},
    probe: async pid => live.has(pid) ? { kind: "live", startIdentity: `birth-${pid}`, pi: true } : { kind: "absent" },
    tree: async () => ({ groups: [], descendants: [] }),
    groupBlockers: unused,
    writerBlockers: async () => [],
    shutdown: async () => true,
    signal: async (pid, signal) => { signals.push([pid, signal]); live.delete(pid); },
    pause: async ms => { now += ms; for (const [fn, at] of timers) if (at <= now) { timers.delete(fn); fn(); } },
    terminals: async id => {
      const pid = pids.get(id as SessionId);
      return pid && live.has(pid) ? [{ terminal: `pi-${pid}`, state: "live", pid, owned: true,
        launch: { sessionId: id, machineId: machine, epoch: 7, cwd: checkout, file: files.get(id as SessionId)! } }] : [];
    },
    launch: async ({ home }) => { launches.push(home.sessionId); return { terminal: "unexpected" }; },
  };
  const runtime = createLocalRuntime(options, io);
  const corrupt = (kind: string, suffix: string) => global.db.prepare("INSERT INTO roam_cursors(peer_machine,peer_stream,last_seq) VALUES ('',?,0)")
    .run(`spider-local:${kind}:${suffix}`);
  return { options, runtime, home, corrupt, signals, launches, onInspect: (fn: () => void) => { onInspect = fn; } };
}

it.each(["truncated", "missing home"] as const)("keeps enforcing the affected session with a %s stop-mode row without affecting another", async corruption => {
  const f = fixture();
  if (corruption === "truncated") f.corrupt("relocate-stop-mode", `[${JSON.stringify(bad)},`);
  else writeLocal(f.options.globalDb, "relocate-stop-mode", bad, { mode: "hard" });
  const result = await f.runtime.enforceStopped(f.home(bad));
  expect(f.signals).toEqual([[83001, "SIGTERM"]]);
  expect(result.evidence).toMatchObject({ kind: "pending", blockers: [{ kind: "check" }] });
  queueStopMode(f.options.globalDb, f.home(healthy), "hard");
  expect((await f.runtime.enforceStopped(f.home(healthy))).evidence.kind).toBe("confirmed");
  expect(f.signals).toEqual([[83001, "SIGTERM"], [83002, "SIGKILL"]]);
});

it("the supervisor enforces a stopped home despite a corrupt placement without affecting another", async () => {
  const f = fixture();
  f.corrupt("relocate-managed", `[${JSON.stringify(bad)},`);
  queueStopMode(f.options.globalDb, f.home(healthy), "hard");
  const results = new Map<SessionId, Awaited<ReturnType<typeof f.runtime.enforceStopped>>>();
  const supervisor = createHomeSupervisor({
    machineId: machine, clock: f.options.clock, entries: f.runtime.entries, owner: f.runtime.owner,
    stop: f.runtime.stop, activate: f.runtime.activate, start: f.runtime.start, report: () => {},
    stopStopped: async home => { const result = await f.runtime.enforceStopped(home); results.set(home.sessionId, result); return result; },
  }, () => {});
  await supervisor.tick();
  expect(f.signals).toEqual([[83001, "SIGTERM"], [83002, "SIGKILL"]]);
  expect(results.get(bad)?.evidence).toMatchObject({ kind: "pending", blockers: [{ kind: "check" }] });
  expect(results.get(healthy)?.evidence.kind).toBe("confirmed");
  expect(f.launches).toEqual([]);
});


it.each(["relocate-stop-mode", "relocate-managed"] as const)("unattributable %s corruption blocks both confirmations but not signals", async kind => {
  const f = fixture();
  f.corrupt(kind, "not-a-key");
  queueStopMode(f.options.globalDb, f.home(healthy), "hard");
  const first = await f.runtime.enforceStopped(f.home(bad));
  const second = await f.runtime.enforceStopped(f.home(healthy));
  expect(f.signals).toEqual([[83001, "SIGTERM"], [83002, "SIGKILL"]]);
  expect(first.evidence).toMatchObject({ kind: "pending", blockers: [{ kind: "check" }] });
  expect(second.evidence).toMatchObject({ kind: "pending", blockers: [{ kind: "check" }] });
});

it("Kill now repairs an attributable broken mode row", async () => {
  const f = fixture();
  f.corrupt("relocate-stop-mode", `[${JSON.stringify(bad)},`);
  queueStopMode(f.options.globalDb, f.home(bad), "hard");
  expect((await f.runtime.enforceStopped(f.home(bad))).evidence.kind).toBe("confirmed");
  expect(f.signals).toEqual([[83001, "SIGKILL"]]);
});

it.each(["relocate-stop-mode", "relocate-managed"] as const)("a newly corrupt %s invalidates a cached confirmation", async kind => {
  const f = fixture();
  queueStopMode(f.options.globalDb, f.home(bad), "hard");
  expect((await f.runtime.enforceStopped(f.home(bad))).evidence.kind).toBe("confirmed");
  f.corrupt(kind, `[${JSON.stringify(bad)},`);
  expect((await f.runtime.enforceStopped(f.home(bad))).evidence.kind).toBe("pending");
  expect((await f.runtime.observeStopped(f.home(bad))).evidence.kind).toBe("pending");
});


it.each(["enforce", "observe"] as const)("%s does not reuse a confirmation when a record corrupts during its recheck", async operation => {
  const f = fixture();
  queueStopMode(f.options.globalDb, f.home(bad), "hard");
  expect((await f.runtime.enforceStopped(f.home(bad))).evidence.kind).toBe("confirmed");
  f.onInspect(() => f.corrupt("relocate-stop-mode", `[${JSON.stringify(bad)},`));
  const result = operation === "enforce" ? await f.runtime.enforceStopped(f.home(bad)) : await f.runtime.observeStopped(f.home(bad));
  expect(result.evidence.kind).toBe("pending");
});


it.each([
  ["relocate-stop-mode", `["",`],
  ["relocate-managed", `[" ",`],
  ["relocate-stop-mode", JSON.stringify(["", { mode: "hard" }])],
  ["relocate-managed", JSON.stringify(["\ud800", {}])],
] as const)("invalid session keys in %s block all confirmations without blocking signals", async (kind, suffix) => {
  const f = fixture();
  f.corrupt(kind, suffix);
  queueStopMode(f.options.globalDb, f.home(healthy), "hard");
  const first = await f.runtime.enforceStopped(f.home(bad));
  const second = await f.runtime.enforceStopped(f.home(healthy));
  expect(f.signals).toEqual([[83001, "SIGTERM"], [83002, "SIGKILL"]]);
  expect(first.evidence).toMatchObject({ kind: "pending", blockers: [{ kind: "check" }] });
  expect(second.evidence).toMatchObject({ kind: "pending", blockers: [{ kind: "check" }] });
});

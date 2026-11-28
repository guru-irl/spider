import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { migrate, openDb } from "@spider/db-core";
import { writeLocal } from "@spider/db-core/roam/local-state";
import { claimIdLock, localBootId } from "@spider/herdr/sessions/id-lock";
import { createSessionLeases } from "@spider/herdr/sessions/lease";
import { createProcessPresence } from "@spider/herdr/sessions/presence";
import { processStartIdentity } from "@spider/herdr/jobs/handoff";
import { installHubService, hubServiceFile } from "../launchd";
import { renderSupervisorUnit } from "../systemd";
import { configureV0Service } from "../production-controls";
import { openFreezeJournal, openJournal } from "../journal";
import { installLocalV0Supervisor } from "../relocate/service-install";
import { main } from "../cli";
import { createIntentStore } from "../intent";

const roots: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(role: "hub" | "box") {
  const root = mkdtempSync(join(resolve(".spider/scratch"), "vsc-")); roots.push(root);
  mkdirSync(join(root, "roam"), { mode: 0o700 });
  const hub = "11111111-1111-4111-8111-111111111111", box = "22222222-2222-4222-8222-222222222222";
  const machineId = role === "hub" ? hub : box;
  const configFile = join(root, "roam", "config.json"), coreUnit = "herdr-core.service";
  writeFileSync(configFile, JSON.stringify({ enabled: false, role, machineId, hubMachineId: hub, coreUnit }), { mode: 0o600 });
  writeFileSync(join(root, "roam", "machine.json"), JSON.stringify({ machineId }), { mode: 0o600 });
  const db = openDb(join(root, "spider.db"));
  try { migrate(db, "global", { machineId, globalRoot: root }); } finally { db.close(); }
  const cli = join(root, "cli.mjs"), supervisor = join(root, "supervisor.mjs");
  const release = join(root, "extension.js");
  writeFileSync(release, "// SPIDER_BUILD_ID=01234567@2026-01-01T00:00:00.000Z v0.1.0\n", { mode: 0o600 });
  writeFileSync(cli, "", { mode: 0o700 }); writeFileSync(supervisor, "");
  vi.stubEnv("SPIDER_GLOBAL_ROOT", root); vi.stubEnv("SPIDER_ROAM_PI", process.execPath);
  const calls: string[][] = [];
  const launchd = { plistDir: join(root, "LaunchAgents"), serviceHome: root, async launchctl(argv: readonly string[]) { calls.push([...argv]); } };
  const systemd = { unitDir: join(root, "units"), async run(argv: readonly string[]) { calls.push([...argv]); } };
  const options = { resolveCli: () => cli, bundleUrl: pathToFileURL(release), launchd, systemd };
  return { root, options, calls, launchd, systemd, cli, supervisor, coreUnit, hub, box, machineId,
    enabled: () => JSON.parse(readFileSync(configFile, "utf8")).enabled };
}

it("an identity mismatch is unverified and refuses enable without touching the service", async () => {
  const f = fixture("hub"), identity = join(f.root, "roam", "machine.json"), config = join(f.root, "roam", "config.json"), global = join(f.root, "spider.db");
  writeFileSync(identity, JSON.stringify({ machineId: f.box }), { mode: 0o600 });
  const files = [identity, config, global], before = files.map(file => readFileSync(file)), io = { out: vi.fn(), err: vi.fn() };
  expect(await main(["roam", "doctor", "--json"], io, { v0: { lifecycle: f.options } })).toBe(1);
  expect.soft(JSON.parse(io.out.mock.calls.at(-1)![0])).toMatchObject({ reason: "legacy-upgrade-unverified", value: { enabled: null,
    diagnostics: [expect.objectContaining({ severity: "block", reason: expect.stringMatching(/^legacy-upgrade-unverified/) })] } });
  expect(await main(["roam", "enable", "--json"], io, { v0: { lifecycle: f.options } })).toBe(1);
  expect(JSON.parse(io.out.mock.calls.at(-1)![0])).toMatchObject({ code: 1, reason: "legacy-upgrade-unverified" });
  expect(files.map(file => readFileSync(file))).toEqual(before);
  expect(f.calls).toEqual([]);
});

it("status does not report disabled when the local machine identity is unknown", async () => {
  const f = fixture("hub");
  writeFileSync(join(f.root, "roam", "machine.json"), JSON.stringify({ machineId: f.box }), { mode: 0o600 });
  const io = { out: vi.fn(), err: vi.fn() };
  expect(await main(["roam", "status", "--json"], io)).toBe(1);
  expect(JSON.parse(io.out.mock.calls.at(-1)![0])).toMatchObject({ reason: "status-unavailable", code: 1 });
  expect(JSON.parse(io.out.mock.calls.at(-1)![0])).not.toHaveProperty("enabled", false);
});

it("a missing global database is unverified and refuses enable without creating a replacement", async () => {
  const f = fixture("hub"), global = join(f.root, "spider.db"), config = join(f.root, "roam", "config.json");
  rmSync(global);
  const before = readFileSync(config), io = { out: vi.fn(), err: vi.fn() };
  expect(await main(["roam", "doctor", "--json"], io, { v0: { lifecycle: f.options } })).toBe(1);
  expect(JSON.parse(io.out.mock.calls.at(-1)![0]).value.diagnostics).toEqual(expect.arrayContaining([
    expect.objectContaining({ severity: "block", reason: expect.stringMatching(/^legacy-upgrade-unverified/) }),
  ]));
  expect(await main(["roam", "enable", "--json"], io, { v0: { lifecycle: f.options } })).toBe(1);
  expect(JSON.parse(io.out.mock.calls.at(-1)![0])).toMatchObject({ code: 1, reason: "legacy-upgrade-unverified" });
  expect(existsSync(global)).toBe(false);
  expect(readFileSync(config)).toEqual(before);
  expect(f.calls).toEqual([]);
});

it.each(["missing", "corrupt"] as const)("unrelated %s project is a warning and does not prevent enable", async condition => {
  const f = fixture("hub"), checkout = join(f.root, "deleted-project"), directory = join(checkout, ".spider"), file = join(directory, "project.db");
  mkdirSync(directory, { recursive: true });
  if (condition === "corrupt") writeFileSync(file, "corrupt project fixture");
  const global = openDb(join(f.root, "spider.db"));
  try {
    global.prepare("INSERT INTO projects(project_key,real_path,db_path,created_at,last_seen_at) VALUES (?,?,?,1,1)").run("deleted-project", checkout, file);
    global.prepare("INSERT INTO roam_workspace_maps(repo_key,workspace_id,path) VALUES (?,?,?)").run("fixture-repo", "deleted", checkout);
    writeLocal(global, "mapping-redirect", "worktree:fixture-repo:deleted", file);
  } finally { global.close(); }
  const before = condition === "corrupt" ? readFileSync(file) : null, io = { out: vi.fn(), err: vi.fn() };
  expect(await main(["roam", "doctor", "--json"], io, { v0: { lifecycle: f.options } })).toBe(0);
  const diagnostics = JSON.parse(io.out.mock.calls.at(-1)![0]).value.diagnostics;
  expect(diagnostics).toEqual(expect.arrayContaining([
    expect.objectContaining({ severity: "warning", reason: expect.stringContaining(file) }),
    expect.objectContaining({ severity: "info", reason: expect.stringMatching(/^legacy-upgrade-ready/) }),
  ]));
  expect(diagnostics.some((row: { severity: string }) => row.severity === "block")).toBe(false);
  const result = await configureV0Service(f.root, true, f.options);
  expect(result.code, result.message).toBe(0);
  expect(f.enabled()).toBe(true);
  if (before) expect(readFileSync(file)).toEqual(before); else expect(existsSync(file)).toBe(false);
});

it.each(["missing", "corrupt"] as const)("a %s project named in an unfinished freeze remains unverified", async condition => {
  const f = fixture("hub"), checkout = join(f.root, "needed-project"), directory = join(checkout, ".spider"), file = join(directory, "project.db"), key = "worktree:fixture-repo:needed";
  mkdirSync(directory, { recursive: true });
  if (condition === "corrupt") writeFileSync(file, "corrupt required fixture");
  const global = openDb(join(f.root, "spider.db"));
  try { global.prepare("INSERT INTO roam_workspace_maps(repo_key,workspace_id,path) VALUES (?,?,?)").run("fixture-repo", "needed", checkout); }
  finally { global.close(); }
  const freeze = openFreezeJournal(join(f.root, "roam", "journal.db"));
  freeze.beginFreeze("session-needed", "move-needed", 1);
  freeze.bindFreezeRoster("session-needed", "move-needed", 1, ["global", key]);
  const files = [join(f.root, "spider.db"), join(f.root, "roam", "journal.db"), join(f.root, "roam", "config.json")], before = files.map(path => readFileSync(path));
  const io = { out: vi.fn(), err: vi.fn() };
  expect(await main(["roam", "doctor", "--json"], io, { v0: { lifecycle: f.options } })).toBe(1);
  expect(JSON.parse(io.out.mock.calls.at(-1)![0]).value.diagnostics).toEqual(expect.arrayContaining([
    expect.objectContaining({ severity: "block", reason: expect.stringMatching(/legacy-upgrade-unverified.*worktree:fixture-repo:needed/) }),
  ]));
  expect((await configureV0Service(f.root, true, f.options)).reason).toBe("legacy-upgrade-unverified");
  expect(files.map(path => readFileSync(path))).toEqual(before);
  expect(f.calls).toEqual([]); expect(f.enabled()).toBe(false);
  if (condition === "corrupt") expect(readFileSync(file, "utf8")).toBe("corrupt required fixture"); else expect(existsSync(file)).toBe(false);
});

it.each(["hub", "box"] as const)("enable refuses an adopted pending launch without changing %s evidence or services", async role => {
  const f = fixture(role), stateRoot = join(f.root, "herdr"), file = join(f.root, "session.jsonl"), journalFile = join(f.root, "roam", "journal.db");
  writeFileSync(file, "fixture transcript\n", { mode: 0o600 });
  await createIntentStore(f.root).update("session-adopted", null, {
    intent: { sessionId: "session-adopted", epoch: 1, desired: "running", suspended: null, file, cwd: f.root, moveId: null },
    failures: [], supervision: { kind: "launching", operationId: "launch-adopted", phase: "invoking" },
  });
  const journal = openJournal(journalFile);
  journal.begin({ id: "launch-adopted", kind: "exact-session-launch", machineId: f.machineId, expectedEpoch: 1, args: { sessionId: "session-adopted" } });
  journal.record("launch-adopted", "done", { code: 0, reason: "ready" });
  const boot = await localBootId(), startIdentity = processStartIdentity(process.pid);
  expect(boot).toBeTruthy(); expect(startIdentity).toBeTruthy();
  const launcher = { pid: 98765, startIdentity: "fixture-launcher" }, adopted = { pid: process.pid, startIdentity: startIdentity! };
  const probe = async (pid: number) => pid === launcher.pid ? { kind: "live" as const, startIdentity: launcher.startIdentity }
    : { kind: "live" as const, startIdentity: adopted.startIdentity };
  const lock = await claimIdLock(stateRoot, "session-adopted", launcher, probe, { bootId: async () => boot });
  const handoff = await lock.prepareHandoff("launch-adopted", file, "fixture-core");
  await claimIdLock(stateRoot, "session-adopted", adopted, probe, { bootId: async () => boot, handoff });
  const leases = createSessionLeases(stateRoot);
  await leases.claim(file, adopted, { leases, presence: createProcessPresence(stateRoot), processes: async () => [], probe },
    { mode: "cutover", bootId: boot });
  const legacy = role === "hub" ? hubServiceFile(f.root, f.launchd.plistDir) : join(f.systemd.unitDir, "spider-roam-supervisor.service");
  mkdirSync(role === "hub" ? f.launchd.plistDir : f.systemd.unitDir, { recursive: true });
  writeFileSync(legacy, "existing legacy unit\n", { mode: 0o600 });
  const tree = (directory: string): Array<[string, string]> => readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? tree(path) : [[path, readFileSync(path).toString("base64")] as [string, string]];
  });
  const files = [join(f.root, "spider.db"), journalFile, join(f.root, "roam", "config.json"), join(f.root, "roam", "machine.json"), legacy];
  const before = [...files.map(path => [path, readFileSync(path).toString("base64")] as [string, string]), ...tree(stateRoot), ...tree(join(f.root, "roam", "intents"))];
  const io = { out: vi.fn(), err: vi.fn() };
  expect(await main(["roam", "enable", "--json"], io, { v0: { lifecycle: f.options } })).toBe(1);
  expect(JSON.parse(io.out.mock.calls.at(-1)![0])).toMatchObject({ code: 1, reason: "legacy-upgrade-blocked" });
  expect([...files.map(path => [path, readFileSync(path).toString("base64")] as [string, string]), ...tree(stateRoot), ...tree(join(f.root, "roam", "intents"))]).toEqual(before);
  expect(f.calls).toEqual([]);
  expect(f.enabled()).toBe(false);
  expect(existsSync(role === "hub" ? hubServiceFile(f.root, f.launchd.plistDir, "v0") : join(f.systemd.unitDir, "spider-roam-supervisor-v0.service"))).toBe(false);
});

it.each(["hub", "box"] as const)("%s enable refuses each freeze-only and map-only blocker without changing evidence", async role => {
  for (const kind of ["freeze", "map"] as const) {
    const f = fixture(role), journalFile = join(f.root, "roam", "journal.db"), globalFile = join(f.root, "spider.db");
    openJournal(journalFile);
    if (kind === "freeze") {
      const freeze = openFreezeJournal(journalFile);
      freeze.beginFreeze("session-freeze-only", "freeze-only", 1);
      freeze.bindFreezeRoster("session-freeze-only", "freeze-only", 1, ["global"]);
    } else {
      const directory = join(f.root, "repository"); mkdirSync(directory);
      const global = openDb(globalFile);
      try { writeLocal(global, "mapping-intent", JSON.stringify(["repo", "fixture-repo"]), { kind: "repo", identity: "fixture-repo",
        target_path: directory, store_key: "repo:fixture-repo", command_json: null, attempt_id: "attempt-only" }); } finally { global.close(); }
    }
    const files = [globalFile, journalFile, join(f.root, "roam", "config.json")], before = files.map(file => readFileSync(file));
    const io = { out: vi.fn(), err: vi.fn() };
    expect(await main(["roam", "doctor", "--json"], io, { v0: { lifecycle: f.options } })).toBe(1);
    expect(JSON.parse(io.out.mock.calls.at(-1)![0]).value.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ severity: "block", reason: expect.stringMatching(kind === "freeze" ? /legacy-upgrade-blocked.*freeze-only/ : /legacy-upgrade-blocked.*repo:fixture-repo/) }),
    ]));
    expect(await main(["roam", "enable", "--json"], io, { v0: { lifecycle: f.options } })).toBe(1);
    expect(JSON.parse(io.out.mock.calls.at(-1)![0])).toMatchObject({ reason: "legacy-upgrade-blocked" });
    expect(files.map(file => readFileSync(file))).toEqual(before);
    expect(f.calls).toEqual([]);
    expect(f.enabled()).toBe(false);
    expect(existsSync(role === "hub" ? hubServiceFile(f.root, f.launchd.plistDir, "v0") : join(f.systemd.unitDir, "spider-roam-supervisor-v0.service"))).toBe(false);
  }
});

it("enable sees a legacy move written while waiting for the configuration lock", async () => {
  const f = fixture("hub"), roam = join(f.root, "roam"), journal = openJournal(join(roam, "journal.db"));
  const input = join(f.root, "hold-lock.ts"), runner = join(f.root, "hold-lock.mjs");
  writeFileSync(input, `
    import { once } from 'node:events';
    import { withProcessLock } from ${JSON.stringify(resolve("packages/herdr/src/sessions/registry.ts"))};
    await withProcessLock(process.argv[2], 'roam-configuration', async () => {
      const released = once(process.stdin, 'end');
      process.stdin.resume();
      process.stdout.write('locked\\n');
      await released;
    });
  `);
  const { rolldownFixture: rolldown } = await import("../../../../scripts/test-bundle.js");
  const bundle = await rolldown({ input, platform: "node", external: [/^node:/, "better-sqlite3", "sqlite-vec"] });
  try { await bundle.write({ file: runner, format: "es" }); }
  finally { await bundle.close(); }
  const child = spawn(process.execPath, [runner, roam], { stdio: "pipe" });
  let stderr = "";
  child.stderr.on("data", bytes => { stderr += String(bytes); });
  const exited = once(child, "close");
  let enabling: ReturnType<typeof configureV0Service> | undefined;
  try {
    const ready = once(child.stdout, "data").then(([bytes]) => String(bytes));
    await expect(Promise.race([ready, exited.then(([code]) => { throw new Error(`Lock holder exited (${code}): ${stderr}`); })]))
      .resolves.toBe("locked\n");
    // Observe the actual liveness probe for the holder, without faking the lock
    // or letting an arbitrary delay decide when to write the move.
    let waiting!: () => void;
    const waitingOnChild = new Promise<void>(resolve => { waiting = resolve; });
    const kill = process.kill;
    const probe = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (pid === child.pid && signal === 0) waiting();
      return kill.call(process, pid, signal);
    });
    try {
      enabling = configureV0Service(f.root, true, f.options);
      await Promise.race([waitingOnChild, enabling.then(result => { throw new Error(`Enable did not wait for the lock: ${result.reason}`); })]);
      journal.begin({ id: "move-during-enable", kind: "move", machineId: f.hub, expectedEpoch: 1, args: {} });
    } finally { probe.mockRestore(); }
    child.stdin.end();
    await expect(exited).resolves.toEqual([0, null]);
    expect(await enabling).toMatchObject({ code: 1, reason: "legacy-upgrade-blocked", message: expect.stringContaining("move-during-enable") });
    expect(f.enabled()).toBe(false);
    expect(f.calls).toEqual([]);
  } finally {
    if (!child.stdin.writableEnded) child.stdin.end();
    await exited;
    await enabling;
  }
});

it.each(["hub", "box"] as const)("enable refuses pending legacy work before changing a %s service", async role => {
  const f = fixture(role), journalFile = join(f.root, "roam", "journal.db");
  const journal = openJournal(journalFile);
  journal.begin({ id: "legacy-move-1", machineId: f.machineId, expectedEpoch: 1, kind: "move", args: { sessionId: "session-1" } });
  journal.record("legacy-move-1", "move-source-cleanup-pending", { sessionId: "session-1", sourceMachine: f.machineId,
    sourceCleanup: { status: "pending", reason: "move-cleanup-pending", blockers: ["move-cleanup-pending"] } });
  const files = [join(f.root, "spider.db"), journalFile, join(f.root, "roam", "config.json")];
  const before = files.map(file => readFileSync(file));
  const io = { out: vi.fn(), err: vi.fn() };
  expect(await main(["roam", "enable", "--json"], io, { v0: { lifecycle: f.options } })).toBe(1);
  expect(JSON.parse(io.out.mock.calls.at(-1)![0])).toMatchObject({ code: 1, reason: "legacy-upgrade-blocked" });
  expect(f.calls).toEqual([]);
  expect(f.enabled()).toBe(false);
  expect(files.map(file => readFileSync(file))).toEqual(before);
  expect(existsSync(role === "hub" ? hubServiceFile(f.root, f.launchd.plistDir, "v0")
    : join(f.systemd.unitDir, "spider-roam-supervisor-v0.service"))).toBe(false);
});

it.each(["terminal receipt", "v0 frozen source", "v0 checkpoint map", "v0 incoming map"] as const)(
  "enable accepts %s without treating it as unfinished legacy work", async kind => {
    const f = fixture("hub"), key = "worktree:fixture-repo:workspace-1", checkout = join(f.root, "checkout"), other = join(f.root, "other"), id = "v0-33333333-3333-4333-8333-333333333333";
    mkdirSync(checkout); mkdirSync(other);
    const journal = openJournal(join(f.root, "roam", "journal.db"));
    if (kind === "terminal receipt") {
      journal.begin({ id: "old-settled", kind: "move", machineId: f.hub, expectedEpoch: 1, args: {} });
      journal.record("old-settled", "done", { code: 0, reason: "moved", value: { sourceCleanup: { status: "done" } } });
    } else if (kind === "v0 frozen source") {
      const directory = join(checkout, ".spider"); mkdirSync(directory);
      const project = openDb(join(directory, "project.db"));
      try {
        migrate(project, "worktree", { machineId: f.hub, globalRoot: f.root });
        project.prepare("UPDATE roam_meta SET machine_id=?,store_key=? WHERE id=1").run(f.hub, key);
        project.prepare("INSERT INTO roam_sessions(session_id,epoch,state) VALUES (?,1,'frozen')").run("session-v0");
      } finally { project.close(); }
      const global = openDb(join(f.root, "spider.db"));
      try {
        global.prepare("INSERT INTO roam_workspace_maps(repo_key,workspace_id,path) VALUES (?,?,?)").run("fixture-repo", "workspace-1", checkout);
        global.prepare("INSERT INTO session_homes(session_id,machine_id,epoch,move_id,updated_at,state,destination) VALUES (?,?,2,?,1,'running',NULL)")
          .run("session-v0", f.box, id);
      } finally { global.close(); }
    } else {
      const sourceLocal = kind === "v0 checkpoint map", sourceMachine = sourceLocal ? f.hub : f.box, destinationMachine = sourceLocal ? f.box : f.hub;
      const placement = (machineId: string, root: string) => ({ sessionId: "session-v0", machineId, historyMachine: sourceMachine,
        repoKey: "fixture-repo", workspaceId: "workspace-1", repository: root, cwd: root, file: join(root, "session.jsonl"),
        stores: ["global", "repo:fixture-repo", key] });
      const plan = { moveId: id, source: { sessionId: "session-v0", machineId: sourceMachine, epoch: 1, updatedAt: 1,
        state: "running", destination: null, moveId: null }, sourcePlacement: placement(sourceMachine, sourceLocal ? checkout : other),
        destinationPlacement: placement(destinationMachine, sourceLocal ? other : checkout), destinationPrerequisites: [], startedAt: 1 };
      journal.begin({ id, kind: "relocate-v0", machineId: f.hub, expectedEpoch: 1, args: { plan } });
      if (sourceLocal) journal.record(id, "relocate-checkpoint", { checkpoint: { plan, completed: [], captured: null, installed: null, terminal: null, result: null } });
      else journal.record(id, "relocate-incoming", { plan, expectedKey: key });
      const global = openDb(join(f.root, "spider.db")), identity = JSON.stringify(["fixture-repo", "workspace-1"]);
      try {
        writeLocal(global, "mapping-intent", JSON.stringify(["workspace", identity]), { kind: "workspace", identity, target_path: checkout,
          store_key: key, command_json: null, attempt_id: "attempt-v0" });
        if (sourceLocal) global.prepare("INSERT INTO session_homes(session_id,machine_id,epoch,move_id,updated_at,state,destination) VALUES (?,?,2,?,1,'moving',?)")
          .run("session-v0", sourceMachine, id, destinationMachine);
        else writeLocal(global, "relocate-incoming", key, { moveId: id });
      } finally { global.close(); }
    }
    const result = await configureV0Service(f.root, true, f.options);
    expect(result.code, result.message).toBe(0);
    expect(result.reason).toBe("roaming-enabled");
    expect(f.enabled()).toBe(true);
    expect(existsSync(hubServiceFile(f.root, f.launchd.plistDir, "v0"))).toBe(true);
    expect(f.calls.some(call => call[0] === "bootstrap")).toBe(true);
  },
);

it.each(["hub", "box"] as const)("enable pins the local Herdr installation in the %s service", async role => {
  const f=fixture(role), binary=join(f.root,"bin","hc"), socket=join(f.root,"socket"), agentDirectory=join(f.root,"agent");
  mkdirSync(join(f.root,"herdr"));mkdirSync(join(f.root,"bin"));
  writeFileSync(binary,"#!/bin/sh\nexit 1\n",{mode:0o700});
  writeFileSync(join(f.root,"herdr","config.json"),JSON.stringify({mode:"core-only",core:{binary,config:join(f.root,"core.toml")},
    globalRoot:f.root,agentDirectory,shellRc:join(f.root,"shell.rc"),machines:[]}));
  vi.stubEnv("SPIDER_ROAM_HC",undefined);vi.stubEnv("PI_CODING_AGENT_DIR",undefined);
  vi.stubEnv("HC_SESSION","work");vi.stubEnv("HC_SOCKET",socket);
  vi.stubEnv("PATH",`/fixture/login/bin:${process.env.PATH}`);
  const result=await configureV0Service(f.root,true,f.options);
  expect(result.code,result.message).toBe(0);
  const file=role==="hub"?hubServiceFile(f.root,f.launchd.plistDir,"v0"):join(f.systemd.unitDir,"spider-roam-supervisor-v0.service");
  const text=readFileSync(file,"utf8");
  expect(text).toContain(binary);expect(text).toContain(socket);expect(text).toContain("/fixture/login/bin");
  if(role==="box") {
    expect(text).toContain('Environment="HC_SESSION=work"');
    expect(text).toContain(`Environment="PI_CODING_AGENT_DIR=${agentDirectory}"`);
  }
});

it("enable removes the scoped legacy hub before starting v0 and disable removes v0", async () => {
  const f = fixture("hub");
  const legacy = hubServiceFile(f.root, f.launchd.plistDir);
  const v0 = hubServiceFile(f.root, f.launchd.plistDir, "v0");
  await installHubService({ node: process.execPath, cli: f.cli, globalRoot: f.root, pi: process.execPath }, f.launchd);
  f.calls.length = 0;
  const enabled = await configureV0Service(f.root, true, f.options);
  expect(enabled).toMatchObject({ code: 0, reason: "roaming-enabled", message: expect.stringMatching(/removed.*legacy.*hub/i) });
  expect(f.enabled()).toBe(true);
  expect(existsSync(legacy)).toBe(false);
  expect(readFileSync(v0, "utf8")).toContain("<string>hub-v0</string>");
  expect(f.calls[0]).toEqual(["bootout", expect.any(String), legacy]);
  expect(f.calls.at(-1)).toEqual(["bootstrap", expect.any(String), v0]);
  expect(await configureV0Service(f.root, false, f.options)).toMatchObject({ code: 0, reason: "roaming-disabled" });
  expect(f.enabled()).toBe(false);
  expect(f.calls.at(-1)).toEqual(["bootout", expect.any(String), v0]);
  expect(existsSync(v0)).toBe(false);
  expect(await configureV0Service(f.root, false, f.options)).toMatchObject({ code: 0 });
});

it("enable refuses a non-executable CLI from the configured hub service before changing it", async () => {
  const f = fixture("hub");
  const enabled = await configureV0Service(f.root, true, f.options);
  expect(enabled.code, enabled.message).toBe(0);
  const plist = hubServiceFile(f.root, f.launchd.plistDir, "v0"), before = readFileSync(plist, "utf8");
  chmodSync(f.cli, 0o600);
  f.calls.length = 0;
  const result = await configureV0Service(f.root, true, f.options);
  expect(result).toMatchObject({ code: 1, message: expect.stringContaining("CLI executable is missing or inaccessible.") });
  expect(f.calls).toEqual([]);
  expect(readFileSync(plist, "utf8")).toBe(before);
});

it("enable preserves an existing 0755 systemd user directory", async () => {
  const f = fixture("box"), io = { out: vi.fn(), err: vi.fn() };
  vi.stubEnv("HOME", resolve("."));
  f.systemd.unitDir = join(f.root, ".config", "systemd", "user");
  mkdirSync(f.systemd.unitDir, { recursive: true, mode: 0o755 });
  chmodSync(f.systemd.unitDir, 0o755);

  expect(await main(["roam", "enable"], io, { v0: { lifecycle: f.options } }), io.err.mock.calls.flat().join("")).toBe(0);
  expect(f.enabled()).toBe(true);
  expect(lstatSync(f.systemd.unitDir).mode & 0o7777).toBe(0o755);
  expect(existsSync(join(f.systemd.unitDir, "spider-roam-supervisor-v0.service"))).toBe(true);
});

it.each([0o750, 0o711])("enable preserves other safe systemd user directory modes: %o", async mode => {
  const f = fixture("box"), io = { out: vi.fn(), err: vi.fn() };
  vi.stubEnv("HOME", resolve("."));
  mkdirSync(f.systemd.unitDir, { mode });
  chmodSync(f.systemd.unitDir, mode);

  expect(await main(["roam", "enable"], io, { v0: { lifecycle: f.options } }), io.err.mock.calls.flat().join("")).toBe(0);
  expect(f.enabled()).toBe(true);
  expect(lstatSync(f.systemd.unitDir).mode & 0o7777).toBe(mode);
});

it.each([0o775, 0o757])("enable tightens an existing unsafe systemd user directory with mode %o", async mode => {
  const f = fixture("box"), io = { out: vi.fn(), err: vi.fn() };
  vi.stubEnv("HOME", resolve("."));
  mkdirSync(f.systemd.unitDir, { mode });
  chmodSync(f.systemd.unitDir, mode);

  expect(await main(["roam", "enable"], io, { v0: { lifecycle: f.options } }), io.err.mock.calls.flat().join("")).toBe(0);
  expect(f.enabled()).toBe(true);
  expect(lstatSync(f.systemd.unitDir).mode & 0o7777).toBe(0o700);
  expect(existsSync(join(f.systemd.unitDir, "spider-roam-supervisor-v0.service"))).toBe(true);
});

it("enable creates a missing systemd user directory with mode 0700", async () => {
  const f = fixture("box"), io = { out: vi.fn(), err: vi.fn() };
  vi.stubEnv("HOME", resolve("."));
  expect(existsSync(f.systemd.unitDir)).toBe(false);

  expect(await main(["roam", "enable"], io, { v0: { lifecycle: f.options } }), io.err.mock.calls.flat().join("")).toBe(0);
  expect(lstatSync(f.systemd.unitDir).mode & 0o7777).toBe(0o700);
  expect(existsSync(join(f.systemd.unitDir, "spider-roam-supervisor-v0.service"))).toBe(true);
});

it("enable refuses a symlinked systemd user directory without changing its target", async () => {
  const f = fixture("box"), io = { out: vi.fn(), err: vi.fn() }, target = join(f.root, "target");
  vi.stubEnv("HOME", resolve("."));
  mkdirSync(target, { mode: 0o755 }); chmodSync(target, 0o755);
  symlinkSync(target, f.systemd.unitDir);

  expect(await main(["roam", "enable"], io, { v0: { lifecycle: f.options } })).not.toBe(0);
  expect(io.err.mock.calls.flat().join("")).toMatch(/symlink|canonical/i);
  expect(f.enabled()).toBe(false);
  expect(lstatSync(target).mode & 0o7777).toBe(0o755);
  expect(existsSync(join(target, "spider-roam-supervisor-v0.service"))).toBe(false);
});

it("enable refuses a symlink in a systemd directory parent", async () => {
  const f = fixture("box"), io = { out: vi.fn(), err: vi.fn() }, target = join(f.root, "target");
  vi.stubEnv("HOME", resolve("."));
  mkdirSync(join(target, "user"), { recursive: true, mode: 0o755 });
  symlinkSync(target, join(f.root, "redirect"));
  f.systemd.unitDir = join(f.root, "redirect", "user");

  expect(await main(["roam", "enable"], io, { v0: { lifecycle: f.options } })).not.toBe(0);
  expect(io.err.mock.calls.flat().join("")).toMatch(/symlink|canonical/i);
  expect(f.enabled()).toBe(false);
  expect(existsSync(join(target, "user", "spider-roam-supervisor-v0.service"))).toBe(false);
});

it("refuses a systemd user directory owned by another user", async () => {
  const f = fixture("box"), uid = process.getuid?.();
  if (uid === undefined) return;
  mkdirSync(f.systemd.unitDir, { mode: 0o755 });
  const getuid = vi.spyOn(process, "getuid").mockReturnValue(uid + 1);
  try {
    await expect(installLocalV0Supervisor(f.systemd, "root", "unit")).rejects.toThrow(/owner/i);
    expect(existsSync(join(f.systemd.unitDir, "spider-roam-supervisor-v0.service"))).toBe(false);
  } finally { getuid.mockRestore(); }
});

it("a Linux box enables and disables only its configured local v0 supervisor", async () => {
  const f = fixture("box");
  // The test runner's real home in CI is outside the permitted fixture paths.
  vi.stubEnv("HOME", resolve("."));
  // A box has no launchd service even when this fixture runs on a Mac.
  vi.stubEnv("SPIDER_TEST_ROAM_LAUNCHCTL", join(f.root, "unused-launchctl"));
  const legacyName = "spider-roam-supervisor.service", v0Name = "spider-roam-supervisor-v0.service";
  const legacy = join(f.systemd.unitDir, legacyName), v0 = join(f.systemd.unitDir, v0Name);
  mkdirSync(f.systemd.unitDir, { mode: 0o700 });
  writeFileSync(legacy, renderSupervisorUnit({ node: process.execPath, supervisor: f.supervisor, globalRoot: f.root, coreUnit: f.coreUnit }), { mode: 0o600 });
  const io = { out: vi.fn(), err: vi.fn() }, cliOptions = { v0: { lifecycle: f.options } };
  expect(await main(["roam", "enable"], io, cliOptions), io.err.mock.calls.flat().join("")).toBe(0);
  expect(io.out.mock.calls.flat().join("")).toContain(legacyName);
  expect(f.enabled()).toBe(true);
  expect(existsSync(legacy)).toBe(false);
  expect(readFileSync(v0, "utf8")).toMatch(/ExecStart=.* --v0/);
  expect(f.calls).toEqual([["--user", "disable", "--now", legacyName], ["--user", "daemon-reload"], ["--user", "enable", "--now", v0Name]]);
  expect(await main(["roam", "disable"], io, cliOptions)).toBe(0);
  expect(f.enabled()).toBe(false);
  expect(existsSync(v0)).toBe(false);
  expect(f.calls.slice(-2)).toEqual([["--user", "disable", "--now", v0Name], ["--user", "daemon-reload"]]);
});

it.each([
  ["hub", "source"], ["hub", "destination"], ["box", "source"], ["box", "destination"],
] as const)("disable leaves the %s running while it is the moving home's %s", async (role, side) => {
  const f = fixture(role), io = { out: vi.fn(), err: vi.fn() }, options = { v0: { lifecycle: f.options } };
  expect(await main(["roam", "enable"], io, options)).toBe(0);
  const other = role === "hub" ? f.box : f.hub;
  const [source, destination] = side === "source" ? [f.machineId, other] : [other, f.machineId];
  const db = openDb(join(f.root, "spider.db"));
  try {
    db.prepare("INSERT INTO session_homes(session_id,machine_id,epoch,move_id,updated_at,state,destination) VALUES (?,?,2,?,1,'moving',?)")
      .run("session-a", source, "v0-33333333-3333-4333-8333-333333333333", destination);
  } finally { db.close(); }
  f.calls.length = 0;
  expect(await main(["roam", "disable"], io, options)).toBe(1);
  const refusal = io.err.mock.calls.flat().join("");
  expect(refusal).toContain(`spider roam relocate session-a ${destination}`);
  expect(refusal).toContain(`spider roam relocate session-a ${source}`);
  expect(refusal).toContain(`spider roam set-home session-a ${source} --force`);
  expect(await main(["roam", "disable", "--json"], io, options)).toBe(1);
  expect(JSON.parse(io.out.mock.calls.at(-1)![0])).toMatchObject({ code: 1, reason: "v0-move-in-progress",
    operationId: "v0-33333333-3333-4333-8333-333333333333", nextStep: expect.stringContaining(`spider roam relocate session-a ${destination}`) });
  expect(f.enabled()).toBe(true);
  expect(f.calls).toEqual([]);
});

it("retired legacy CLI move aliases name relocate before trying to contact a hub", async () => {
  const f = fixture("hub");
  const io = { out: vi.fn(), err: vi.fn() };
  for (const args of [["move", "session-a", "mac"], ["roam", "move", "session-a", "mac"]]) {
    io.err.mockClear();
    expect(await main(args, io)).toBe(1);
    expect(io.err.mock.calls.flat().join("")).toContain("spider roam relocate");
  }
  expect(f.calls).toEqual([]);
});

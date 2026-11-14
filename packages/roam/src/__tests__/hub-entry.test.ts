import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { migrate, openDb } from "@spider/db-core";
import { enableMemoryCapture } from "@spider/db-core/roam/seed";
import { readLocal, writeLocal } from "@spider/db-core/roam/local-state";
import { createProcessPresence } from "@spider/herdr/sessions/presence";
import { writeServerRecord } from "../../../host/src/usage/server-lock";
import { usageProcessIdentity } from "../../../host/src/usage/server-runtime";
import type { SessionId } from "@spider/herdr/contracts";
import { createLocalDiagnosticPorts } from "../local-diagnostics";
import { buildRoamEntries } from "../../../../scripts/build-roam.mjs";
import { requestHubControl } from "../control-socket";
import { openJournal } from "../journal";
import { DEFAULT_LIMITS } from "../contracts";
import { utimesSync } from "node:fs";
import { acquireTransferLease } from "../staging";

const HUB = "00000000-0000-4000-8000-000000000001";
const BOX = "00000000-0000-4000-8000-000000000002";
const roots: string[] = [];
let built: string;
beforeAll(async () => {
  built = mkdtempSync(join(resolve(".spider/scratch"), "hub-build-"));
  await buildRoamEntries(join(built, "roam"));
  writeFileSync(join(built, "extension.js"), "// SPIDER_BUILD_ID=abcdef1@2026-01-01T00:00:00.000Z v1.2.3\n");
});
afterAll(() => rmSync(built, { recursive: true, force: true }));
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture(capture = true) {
  const root = mkdtempSync(join(resolve(".spider/scratch"), "hub-entry-")); roots.push(root);
  mkdirSync(join(root, "roam"), { mode: 0o700 }); mkdirSync(join(root, "herdr"), { mode: 0o700 });
  writeFileSync(join(root, "roam", "machine.json"), JSON.stringify({ machineId: HUB }), { mode: 0o600 });
  writeFileSync(join(root, "roam", "config.json"), JSON.stringify({ enabled: true, role: "hub", machineId: HUB,
    hubMachineId: HUB, peers: [], discoveryRoots: [], coreUnit: "fixture" }), { mode: 0o600 });
  const db = openDb(join(root, "spider.db"));
  migrate(db, "global", { machineId: HUB, globalRoot: root });
  if (capture) enableMemoryCapture(db, "global");
  else db.prepare("INSERT INTO global_memory(uuid,category,content,created_at) VALUES ('memory-a','insight','portable',1)").run();
  db.close();
  const marker = join(root, "hc-called"), hc = join(root, "hc");
  writeFileSync(hc, `#!${process.execPath}\nimport {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(marker)},'called'); process.exit(1);\n`, { mode: 0o700 });
  writeFileSync(join(root, "herdr", "config.json"), JSON.stringify({ app: { binary: join(root, "app"), home: root },
    core: { binary: hc, config: join(root, "core.toml") }, agentDirectory: root, globalRoot: root,
    shellRc: join(root, "shellrc"), spaces: [], machines: [] }), { mode: 0o600 });
  const env: NodeJS.ProcessEnv & { HOME: string; SPIDER_GLOBAL_ROOT: string; HC_SOCKET: string } =
    { ...process.env, HOME: root, SPIDER_GLOBAL_ROOT: root, HC_SOCKET: join(root, "absent-core.sock") };
  const cli = join(built, "roam", "cli.mjs"), socket = join(root, "roam", "hub.sock");
  return { root, marker, env, cli, socket };
}
function start(f: ReturnType<typeof fixture>): ChildProcess {
  return spawn(process.execPath, [f.cli, "roam", "hub"], { cwd: f.root, env: f.env, stdio: ["ignore", "pipe", "pipe"] });
}
async function command(f: ReturnType<typeof fixture>, args: string[]) {
  const child = spawn(process.execPath, [f.cli, ...args], { cwd: f.root, env: f.env });
  let out = "", err = "";
  child.stdout.on("data", bytes => { out += bytes; }); child.stderr.on("data", bytes => { err += bytes; });
  const code = await new Promise<number | null>((done, reject) => { child.once("error", reject); child.once("close", done); });
  return { code, out, err };
}
async function exit(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) return { code: child.exitCode, signal: child.signalCode };
  return new Promise((done, reject) => {
    const timer = setTimeout(() => reject(new Error("hub did not exit")), 3000);
    child.once("exit", (code, signal) => { clearTimeout(timer); done({ code, signal }); });
    child.once("error", error => { clearTimeout(timer); reject(error); });
  });
}
async function ready(socket: string, child: ChildProcess) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline && child.exitCode === null && child.signalCode === null) {
    try { return await requestHubControl(socket, { op: "status" }); } catch { await delay(20); }
  }
  throw new Error(`hub did not become ready; exit ${child.exitCode}`);
}

function orphanSnapshot(root: string): string {
  const directory = join(root, ".roam-batches"); mkdirSync(directory, { mode: 0o700 });
  const file = join(directory, "99999999-9999-4999-8999-999999999999.ndjson");
  writeFileSync(file, "orphan", { mode: 0o600 }); utimesSync(file, 1, 1); return file;
}
it("the packaged production hub reclaims inactive orphan snapshots at startup", async () => {
  const f = fixture(), file = orphanSnapshot(f.root), hub = start(f);
  try { await ready(f.socket, hub); expect(existsSync(file)).toBe(false); expect(existsSync(f.marker)).toBe(false); }
  finally { hub.kill("SIGTERM"); await exit(hub); }
}, 5000);
it("box agent startup sweeps crash leftovers but not snapshots held by a live peer lease", async () => {
  const f = fixture(), file = orphanSnapshot(f.root);
  writeFileSync(join(f.root, "roam", "config.json"), JSON.stringify({ enabled: true, role: "box", machineId: HUB,
    hubMachineId: BOX, peers: [], discoveryRoots: [], coreUnit: "fixture" }), { mode: 0o600 });
  const operation = { id: "box-inventory", machineId: HUB, expectedEpoch: null, kind: "stores", args: {} };
  const release = acquireTransferLease(join(f.root, "roam", "staging"), BOX, DEFAULT_LIMITS.peerConcurrency)!;
  try { expect((await command(f, ["roam", "agent", JSON.stringify(operation)])).code).toBe(0); expect(existsSync(file)).toBe(true); }
  finally { release(); }
  const db = openDb(join(f.root, "spider.db"));
  try { writeLocal(db, "artifact-sweep", "last", undefined); } finally { db.close(); }
  expect((await command(f, ["roam", "agent", JSON.stringify(operation)])).code).toBe(0);
  expect(existsSync(file)).toBe(false);
}, 5000);
it("packaged enable checks live consumers before seeding and installing the isolated service", async () => {
  const f = fixture(false), bin = join(f.root, "bin"), calls = join(f.root, "launchctl-calls"), pidFile = join(f.root, "hub-pid"), failFile = join(f.root, "fail-bootout");
  mkdirSync(bin);
  writeFileSync(join(bin, "sqlite3"), `#!${process.execPath}\nconsole.log('3.45.0');\n`, { mode: 0o700 });
  const launchctl = join(bin, "launchctl");
  writeFileSync(launchctl, `#!${process.execPath}\nimport {appendFileSync,existsSync,readFileSync,unlinkSync,writeFileSync} from 'node:fs'; import {spawn} from 'node:child_process';\nconst a=process.argv.slice(2); appendFileSync(${JSON.stringify(calls)},JSON.stringify(a)+'\\n');\nif(a[0]==='bootstrap'){const c=spawn(${JSON.stringify(process.execPath)},[${JSON.stringify(f.cli)},'roam','hub'],{env:process.env,detached:true,stdio:'ignore'});writeFileSync(${JSON.stringify(pidFile)},String(c.pid));c.unref();}\nelse if(a[0]==='bootout' && existsSync(${JSON.stringify(failFile)})){unlinkSync(${JSON.stringify(failFile)});process.exitCode=1;}\nelse if(a[0]==='bootout' && existsSync(${JSON.stringify(pidFile)})){try{process.kill(Number(readFileSync(${JSON.stringify(pidFile)},'utf8')),'SIGTERM')}catch{}}\n`, { mode: 0o700 });
  f.env.PATH = bin; f.env.SPIDER_TEST_ROAM_LAUNCHCTL = launchctl;
  try {
  writeFileSync(join(f.root, "roam", "config.json"), JSON.stringify({ enabled: false, role: "hub", machineId: HUB,
    hubMachineId: HUB, peers: [], discoveryRoots: [], coreUnit: "fixture" }), { mode: 0o600 });
  const machine = { machineId: HUB, label: "local machine", peer: null };
  const probe = await createLocalDiagnosticPorts(f.root, []).probeProcess(machine, process.pid);
  expect(probe.kind).toBe("live");
  if (probe.kind !== "live") throw new Error("fixture process identity unavailable");
  const presence = createProcessPresence(join(f.root, "herdr"));
  await presence.record({ pid: process.pid, startIdentity: probe.startIdentity, sessionId: "fixture" as SessionId, sessionFile: null,
    sessionName: null, kind: "top-level", hcAddress: null });
  const refused = await command(f, ["roam", "enable"]);
  expect(refused.code).toBe(1);
  expect(existsSync(calls)).toBe(false);
  let db = openDb(join(f.root, "spider.db"));
  expect(db.prepare("SELECT capture_enabled FROM roam_meta").get()).toEqual({ capture_enabled: 0 }); db.close();
  expect(JSON.parse(readFileSync(join(f.root, "roam", "config.json"), "utf8")).enabled).toBe(false);
  await presence.remove({ pid: process.pid, startIdentity: probe.startIdentity });
  const accepted = await command(f, ["roam", "enable"]);
  expect(accepted.code, accepted.err).toBe(0);
  db = openDb(join(f.root, "spider.db"));
  try {
    expect(db.prepare("SELECT store_key,capture_enabled FROM roam_meta").get()).toEqual({ store_key: "global", capture_enabled: 1 });
    expect(db.prepare("SELECT entity,row_key FROM roam_changes").all()).toEqual([{ entity: "global_memory", row_key: "memory-a" }]);
  } finally { db.close(); }
  expect(JSON.parse(readFileSync(join(f.root, "roam", "config.json"), "utf8")).enabled).toBe(true);
  expect(existsSync(join(f.root, "Library", "LaunchAgents", "com.spider.roam.hub.plist"))).toBe(true);
  expect(readFileSync(calls, "utf8").trim().split("\n").map(line => JSON.parse(line)[0])).toEqual(["bootout", "bootstrap"]);
  writeFileSync(failFile, "fail once");
  expect((await command(f, ["roam", "disable"])).code).toBe(3);
  expect(existsSync(join(f.root, "Library", "LaunchAgents", "com.spider.roam.hub.plist"))).toBe(true);
  expect((await command(f, ["roam", "disable"])).code).toBe(0);
  expect(JSON.parse(readFileSync(join(f.root, "roam", "config.json"), "utf8")).enabled).toBe(false);
  expect(existsSync(join(f.root, "Library", "LaunchAgents", "com.spider.roam.hub.plist"))).toBe(false);
  db = openDb(join(f.root, "spider.db"));
  try { expect(db.prepare("SELECT capture_enabled FROM roam_meta").get()).toEqual({ capture_enabled: 1 }); }
  finally { db.close(); }
  } finally {
    if (existsSync(pidFile)) { try { process.kill(Number(readFileSync(pidFile, "utf8")), "SIGTERM"); } catch { /* already stopped */ } }
    const end = Date.now() + 1000;
    while (existsSync(f.socket) && Date.now() < end) await delay(20);
  }
}, 5000);

it.each(["lock.json.guard", "startup.json", "replace-intent.json", "replace-intent.json.guard"])(
  "packaged enable refuses during usage worker startup indicated by %s", async marker => {
    const f = fixture(false), bin = join(f.root, "bin"), call = join(f.root, "launchctl-called");
    mkdirSync(bin);
    writeFileSync(join(bin, "sqlite3"), `#!${process.execPath}\nconsole.log('3.45.0');\n`, { mode: 0o700 });
    const launchctl = join(bin, "launchctl");
    writeFileSync(launchctl, `#!${process.execPath}\nimport {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(call)},'called'); process.exitCode=1;\n`, { mode: 0o700 });
    f.env.PATH = bin; f.env.SPIDER_TEST_ROAM_LAUNCHCTL = launchctl;
    writeFileSync(join(f.root, "roam", "config.json"), JSON.stringify({ enabled: false, role: "hub", machineId: HUB,
      hubMachineId: HUB, peers: [], discoveryRoots: [], coreUnit: "fixture" }), { mode: 0o600 });
    const markerFile = join(f.root, "usage-server", marker), processIdentity = await usageProcessIdentity(process.pid);
    if (marker === "lock.json.guard") await writeServerRecord(join(f.root, "usage-server", "lock.json"), {
      version: 1, instanceId: "b".repeat(32), secret: "a".repeat(43), pid: process.pid, port: 12345,
      processIdentity, serverBuild: "abcdef1@2026-01-01T00:00:00.000Z",
    }, true);
    await writeServerRecord(markerFile, { version: 1, instanceId: "a".repeat(32), pid: process.pid,
      processIdentity, createdAt: Date.now(), expiresAt: Date.now() + 10_000 }, true);
    const result = await command(f, ["roam", "enable"]);
    expect(result.code, result.err).toBe(1);
    expect(result.err).toMatch(/usage worker/i);
    expect(existsSync(call)).toBe(false);
    const db = openDb(join(f.root, "spider.db"));
    try { expect(db.prepare("SELECT capture_enabled FROM roam_meta").get()).toEqual({ capture_enabled: 0 }); }
    finally { db.close(); }
    unlinkSync(markerFile);
    const worker = await createLocalDiagnosticPorts(f.root, []).usageWorker({ machineId: HUB, label: "local", peer: null });
    if (marker === "lock.json.guard") expect(worker).toMatchObject({ pid: process.pid, processIdentity });
    else expect(worker).toBeNull();
  }, 5000);

it("disable without a socket or service still verifies the journal and hub lock", async () => {
  const f = fixture(false);
  writeFileSync(join(f.root, "roam", "config.json"), JSON.stringify({ enabled: false, role: "hub", machineId: HUB,
    hubMachineId: HUB, peers: [], discoveryRoots: [], coreUnit: "fixture" }), { mode: 0o600 });
  expect((await command(f, ["roam", "disable"])).code).toBe(3);
  expect(existsSync(join(f.root, "roam", "journal.db"))).toBe(false);
  const journal = openJournal(join(f.root, "roam", "journal.db"));
  journal.begin({ id: "pending-home", machineId: HUB, expectedEpoch: 1, kind: "move", args: {} });
  expect((await command(f, ["roam", "disable"])).code).toBe(3);
  journal.record("pending-home", "done", { complete: true });
  expect((await command(f, ["roam", "disable"])).code).toBe(0);
  // An absent socket and plist do not prove that the old hub stopped scheduling.
  const db = openDb(join(f.root, "spider.db"));
  try { enableMemoryCapture(db, "global"); } finally { db.close(); }
  writeFileSync(join(f.root, "roam", "config.json"), JSON.stringify({ enabled: true, role: "hub", machineId: HUB,
    hubMachineId: HUB, peers: [], discoveryRoots: [], coreUnit: "fixture" }), { mode: 0o600 });
  const hub = start(f);
  try {
    await ready(f.socket, hub);
    writeFileSync(join(f.root, "roam", "config.json"), JSON.stringify({ enabled: false, role: "hub", machineId: HUB,
      hubMachineId: HUB, peers: [], discoveryRoots: [], coreUnit: "fixture" }), { mode: 0o600 });
    unlinkSync(f.socket);
    expect((await command(f, ["roam", "disable"])).code).toBe(3);
  } finally { hub.kill("SIGTERM"); await exit(hub); }
  expect((await command(f, ["roam", "disable"])).code).toBe(0);
}, 5000);

it("disable resumes interrupted service removal after the hub exits, but not during a home change", async () => {
  const f = fixture(false), bin = join(f.root, "bin"), pidFile = join(f.root, "hub-pid"), failFile = join(f.root, "fail-bootout");
  mkdirSync(bin);
  writeFileSync(join(bin, "sqlite3"), `#!${process.execPath}\nconsole.log('3.45.0');\n`, { mode: 0o700 });
  const launchctl = join(bin, "launchctl");
  writeFileSync(launchctl, `#!${process.execPath}\nimport {existsSync,readFileSync,unlinkSync,writeFileSync} from 'node:fs'; import {spawn} from 'node:child_process';\nconst a=process.argv.slice(2); if(a[0]==='bootstrap'){const c=spawn(${JSON.stringify(process.execPath)},[${JSON.stringify(f.cli)},'roam','hub'],{env:process.env,detached:true,stdio:'ignore'});writeFileSync(${JSON.stringify(pidFile)},String(c.pid));c.unref();} else if(a[0]==='bootout' && existsSync(${JSON.stringify(failFile)})){unlinkSync(${JSON.stringify(failFile)});process.exitCode=1;} else if(a[0]==='bootout' && existsSync(${JSON.stringify(pidFile)})){try{process.kill(Number(readFileSync(${JSON.stringify(pidFile)},'utf8')),'SIGTERM')}catch{}}\n`, { mode: 0o700 });
  f.env.PATH = bin; f.env.SPIDER_TEST_ROAM_LAUNCHCTL = launchctl;
  writeFileSync(join(f.root, "roam", "config.json"), JSON.stringify({ enabled: false, role: "hub", machineId: HUB,
    hubMachineId: HUB, peers: [], discoveryRoots: [], coreUnit: "fixture" }), { mode: 0o600 });
  const plist = join(f.root, "Library", "LaunchAgents", "com.spider.roam.hub.plist");
  try {
    expect((await command(f, ["roam", "enable"])).code).toBe(0);
    writeFileSync(failFile, "fail once");
    expect((await command(f, ["roam", "disable"])).code).toBe(3);
    expect(existsSync(plist)).toBe(true);
    unlinkSync(f.socket);
    expect((await command(f, ["roam", "disable"])).code).toBe(3);
    expect(existsSync(plist)).toBe(true);
    const pid = Number(readFileSync(pidFile, "utf8")); process.kill(pid, "SIGTERM");
    const observer = createLocalDiagnosticPorts(f.root, []), machine = { machineId: HUB, label: "local", peer: null };
    const end = Date.now() + 2000;
    let state = await observer.probeProcess(machine, pid);
    while (state.kind !== "absent" && Date.now() < end) { await delay(20); state = await observer.probeProcess(machine, pid); }
    expect(state.kind).toBe("absent");
    expect(existsSync(f.socket)).toBe(false);
    const journal = openJournal(join(f.root, "roam", "journal.db"));
    journal.begin({ id: "pending-home", machineId: HUB, expectedEpoch: 1, kind: "move", args: {} });
    expect((await command(f, ["roam", "disable"])).code).toBe(3);
    expect(existsSync(plist)).toBe(true);
    journal.record("pending-home", "done", { complete: true });
    const resumed = await command(f, ["roam", "disable"]);
    expect(resumed.code, resumed.err).toBe(0);
    expect(existsSync(plist)).toBe(false);
    const db = openDb(join(f.root, "spider.db"));
    try { expect(db.prepare("SELECT capture_enabled FROM roam_meta").get()).toEqual({ capture_enabled: 1 }); }
    finally { db.close(); }
  } finally {
    if (existsSync(pidFile)) { try { process.kill(Number(readFileSync(pidFile, "utf8")), "SIGTERM"); } catch { /* already stopped */ } }
  }
}, 5000);

async function twoNodeFixture(capture = true) {
  const f = fixture(capture), alias = "-box-1.invalid", box = join(f.root, "box"), calls = join(f.root, "hc-calls");
  mkdirSync(box); mkdirSync(join(box, "roam"), { mode: 0o700 }); mkdirSync(join(f.root, "bin"));
  writeFileSync(join(box, "roam", "machine.json"), JSON.stringify({ machineId: BOX }), { mode: 0o600 });
  writeFileSync(join(box, "roam", "config.json"), JSON.stringify({ enabled: false, role: "box", machineId: BOX,
    hubMachineId: HUB, peers: [], discoveryRoots: [], coreUnit: "fixture" }), { mode: 0o600 });
  const db = openDb(join(box, "spider.db")); migrate(db, "global", { machineId: BOX, globalRoot: box }); db.close();
  const peer = { machineId: BOX, alias, node: process.execPath, pi: process.execPath, cli: f.cli, core: join(f.root, "hc"), globalRoot: box };
  writeFileSync(join(f.root, "roam", "config.json"), JSON.stringify({ enabled: true, role: "hub", machineId: HUB,
    hubMachineId: HUB, peers: [peer], discoveryRoots: [], coreUnit: "fixture" }), { mode: 0o600 });
  writeFileSync(join(f.root, "bin", "sqlite3"), `#!${process.execPath}\nconsole.log('3.45.0');\n`, { mode: 0o700 });
  f.env.PATH = join(f.root, "bin");
  writeFileSync(join(f.root, "hc"), `#!${process.execPath}\nimport {appendFileSync,readFileSync} from 'node:fs'; import {spawnSync} from 'node:child_process';\nconst a=process.argv.slice(2); appendFileSync(${JSON.stringify(calls)},JSON.stringify(a)+'\\n');\nif(process.env.SPIDER_TEST_HC_OFFLINE==='1') process.exit(1);\nif(a[0]==='server') console.log(JSON.stringify({core:{id:'local-core'},version:'0.1.16'}));\nelse if(a[0]==='machine') console.log(JSON.stringify({machines:[{name:${JSON.stringify(alias)},id:'remote-core',state:'connected'}]}));\nelse if(a[0]==='exec' && a.includes(${JSON.stringify(`--on=${alias}`)})) { const cmd=a.slice(a.indexOf('--')+1); if(cmd[0]==='cat' && cmd.at(-1)===${JSON.stringify(join(box, "roam", "machine.json"))}) process.stdout.write(readFileSync(cmd.at(-1))); else if(cmd[0]===${JSON.stringify(process.execPath)} && cmd[1]===${JSON.stringify(f.cli)} && cmd[2]==='--global-root' && cmd[3]===${JSON.stringify(box)}) { const result=spawnSync(cmd[0],cmd.slice(1),{env:{...process.env,HOME:${JSON.stringify(box)}},input:a.includes('--stdin')?readFileSync(0):undefined}); process.stdout.write(result.stdout); process.stderr.write(result.stderr); process.exitCode=result.status??1; } else process.exitCode=2; }\nelse process.exitCode=1;\n`, { mode: 0o700 });
  const server = createServer(socket => socket.end()); await new Promise<void>(done => server.listen(f.env.HC_SOCKET, done));
  return { f, alias, box, calls, peer, server };
}

it("box controls direct nonlocal operations to the Mac without changing memory", async () => {
  const { f, box, server } = await twoNodeFixture(false);
  try {
    const db = openDb(join(box, "spider.db"));
    try { db.prepare("INSERT INTO global_memory(uuid,category,content,created_at,machine_id) VALUES ('box-note','insight','local',1,?)").run(BOX); }
    finally { db.close(); }
    f.env.HOME = box; f.env.SPIDER_GLOBAL_ROOT = box;
    for (const args of [["roam", "memory", "tag", "global", "box-note", "all"], ["move", "session-1", "box-1.invalid"],
      ["roam", "provision", "box-1.invalid"], ["roam", "recover", "session-1"], ["roam", "cancel", "operation-1"],
      ["roam", "forget", "box-1.invalid"], ["roam", "claim", "session-1", "box-1.invalid"],
      ["roam", "stop", "session-1"], ["roam", "resume", "session-1"]]) {
      const result = await command(f, args);
      expect(result.code, args.join(" ")).toBe(1);
      expect(result.err, args.join(" ")).toMatch(/Mac hub/i);
    }
    const inspect = openDb(join(box, "spider.db"));
    try { expect(inspect.prepare("SELECT machine_id FROM global_memory WHERE uuid='box-note'").get()).toEqual({ machine_id: BOX }); }
    finally { inspect.close(); }
    expect((await command(f, ["roam", "status", "--json"])).code).toBe(0);
  } finally { await new Promise<void>(done => server.close(() => done())); }
}, 5000);

it("remote doctor uses both dash-alias forms and never falls back to local execution", async () => {
  const { f, alias, box, calls, server } = await twoNodeFixture();
  try {
    for (const selector of [["--", alias], ["--machine", alias]]) {
      const result = await command(f, ["roam", "doctor", ...selector]);
      expect(result.code, result.err).toBe(0);
      expect(result.out).toContain("Roaming is disabled");
    }
    const before = readFileSync(calls, "utf8");
    expect((await command(f, ["roam", "doctor", "unknown.invalid"])).code).toBe(2);
    expect(readFileSync(calls, "utf8")).toBe(before);
    const entries = before.trim().split("\n").map(line => JSON.parse(line) as string[]);
    expect(entries.filter(args => args[0] === "exec").every(args => args.includes(`--on=${alias}`))).toBe(true);
    expect(entries.some(args => args.includes("--global-root") && args.includes(box) && args.includes("doctor"))).toBe(true);
    expect(existsSync(join(box, "roam", "journal.db"))).toBe(false);
  } finally { await new Promise<void>(done => server.close(() => done())); }
}, 5000);

it("enable refuses old or unreadable remote consumer inventories before any capture or service effect", async () => {
  const { f, box, peer, server } = await twoNodeFixture(false);
  try {
    writeFileSync(join(f.root, "roam", "config.json"), JSON.stringify({ enabled: false, role: "hub", machineId: HUB,
      hubMachineId: HUB, peers: [peer], discoveryRoots: [], coreUnit: "fixture" }), { mode: 0o600 });
    const launchctl = join(f.root, "bin", "launchctl"), marker = join(f.root, "service-called");
    writeFileSync(launchctl, `#!${process.execPath}\nimport {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(marker)},'called'); process.exitCode=1;\n`, { mode: 0o700 });
    f.env.SPIDER_TEST_ROAM_LAUNCHCTL = launchctl;
    const machine = { machineId: BOX, label: "box", peer: null };
    const probe = await createLocalDiagnosticPorts(box, []).probeProcess(machine, process.pid);
    expect(probe.kind).toBe("live"); if (probe.kind !== "live") throw new Error("fixture process identity unavailable");
    const presence = createProcessPresence(join(box, "herdr"));
    await presence.record({ pid: process.pid, startIdentity: probe.startIdentity, sessionId: "fixture" as SessionId, sessionFile: null,
      sessionName: null, kind: "top-level", hcAddress: null });
    const old = await command(f, ["roam", "enable"]);
    expect(old.code).toBe(1);
    expect(old.err).toContain("loaded build");
    await presence.remove({ pid: process.pid, startIdentity: probe.startIdentity });
    writeFileSync(join(box, "herdr", "processes", "bad.json"), "not-json", { mode: 0o600 });
    const unknown = await command(f, ["roam", "enable"]);
    expect(unknown.code).toBe(1);
    expect(unknown.err).toContain("Cannot read the process presence inventory");
    expect(existsSync(marker)).toBe(false);
    for (const root of [f.root, box]) {
      const db = openDb(join(root, "spider.db"));
      try { expect(db.prepare("SELECT capture_enabled FROM roam_meta").get()).toEqual({ capture_enabled: 0 }); }
      finally { db.close(); }
    }
    expect(JSON.parse(readFileSync(join(f.root, "roam", "config.json"), "utf8")).enabled).toBe(false);
  } finally { await new Promise<void>(done => server.close(() => done())); }
}, 5000);

it("enable seeds both machines through the enrolled peer before the isolated hub starts", async () => {
  const { f, alias, box, calls, peer, server } = await twoNodeFixture(false);
  const pidFile = join(f.root, "hub-pid"), launchCalls = join(f.root, "launch-calls");
  try {
    writeFileSync(join(f.root, "roam", "config.json"), JSON.stringify({ enabled: false, role: "hub", machineId: HUB,
      hubMachineId: HUB, peers: [peer], discoveryRoots: [], coreUnit: "fixture" }), { mode: 0o600 });
    const db = openDb(join(box, "spider.db"));
    try { db.prepare("INSERT INTO global_memory(uuid,category,content,created_at) VALUES ('peer-memory','insight','box note',1)").run(); }
    finally { db.close(); }
    const launchctl = join(f.root, "bin", "launchctl");
    writeFileSync(launchctl, `#!${process.execPath}\nimport {appendFileSync,writeFileSync} from 'node:fs'; import {spawn} from 'node:child_process';\nconst a=process.argv.slice(2); appendFileSync(${JSON.stringify(launchCalls)},JSON.stringify(a)+'\\n'); if(a[0]==='bootstrap'){const c=spawn(${JSON.stringify(process.execPath)},[${JSON.stringify(f.cli)},'roam','hub'],{env:process.env,detached:true,stdio:'ignore'});writeFileSync(${JSON.stringify(pidFile)},String(c.pid));c.unref();}\n`, { mode: 0o700 });
    f.env.SPIDER_TEST_ROAM_LAUNCHCTL = launchctl;
    const result = await command(f, ["roam", "enable"]);
    expect(result.code, result.err).toBe(0);
    for (const [root, row] of [[f.root, "memory-a"], [box, "peer-memory"]]) {
      const inspect = openDb(join(root, "spider.db"));
      try {
        expect(inspect.prepare("SELECT store_key,capture_enabled FROM roam_meta").get()).toEqual({ store_key: "global", capture_enabled: 1 });
        expect(inspect.prepare("SELECT entity,row_key FROM roam_changes WHERE row_key=?").all(row)).toEqual([{ entity: "global_memory", row_key: row }]);
      } finally { inspect.close(); }
    }
    const entries = readFileSync(calls, "utf8").trim().split("\n").map(line => JSON.parse(line) as string[]);
    const operations = entries.filter(args => args[0] === "exec" && args.includes("agent"))
      .map(args => ({ argv: args, op: JSON.parse(args.at(-1)!) as { kind: string; args: { storeKey?: string } } }));
    expect(operations.some(({ op }) => op.kind === "stores")).toBe(true);
    expect(operations.some(({ op }) => op.kind === "enable-capture" && op.args.storeKey === "global")).toBe(true);
    expect(operations.every(({ argv }) => argv.includes(`--on=${alias}`) && argv.includes(box))).toBe(true);
    expect(readFileSync(launchCalls, "utf8").trim().split("\n").map(line => JSON.parse(line)[0])).toEqual(["bootout", "bootstrap"]);
  } finally {
    if (existsSync(pidFile)) { try { process.kill(Number(readFileSync(pidFile, "utf8")), "SIGTERM"); } catch { /* already stopped */ } }
    const end = Date.now() + 1000;
    while (existsSync(f.socket) && Date.now() < end) await delay(20);
    await new Promise<void>(done => server.close(() => done()));
  }
}, 5000);

it("the packaged hub synchronizes a captured home to the enrolled peer without a core", async () => {
  const { f, alias, box, calls, server } = await twoNodeFixture(true);
  const local = openDb(join(f.root, "spider.db")), remote = openDb(join(box, "spider.db"));
  try {
    enableMemoryCapture(remote, "global");
    local.prepare("INSERT INTO session_homes(session_id,machine_id,epoch,move_id,updated_at) VALUES ('session-sync',?,1,NULL,1)").run(HUB);
  } finally { local.close(); remote.close(); }
  let child = start(f);
  try {
    await ready(f.socket, child);
    const result = await requestHubControl(f.socket, { op: "sync", machine: BOX });
    expect(result.code, result.reason + JSON.stringify(result.value)).toBe(0);
    const hubDb = openDb(join(f.root, "spider.db")), boxDb = openDb(join(box, "spider.db"));
    let stream: string, committedThrough: number;
    try {
      const home = hubDb.prepare("SELECT machine_id,epoch FROM session_homes WHERE session_id='session-sync'").get();
      expect(boxDb.prepare("SELECT machine_id,epoch FROM session_homes WHERE session_id='session-sync'").get()).toEqual(home);
      expect(boxDb.prepare("SELECT capture_enabled FROM roam_meta").get()).toEqual({ capture_enabled: 1 });
      const receipt = boxDb.prepare("SELECT through_seq FROM roam_receipts WHERE peer_machine=?").get(HUB) as { through_seq: number };
      expect(receipt.through_seq).toBeGreaterThan(0);
      committedThrough = receipt.through_seq;
      stream = (hubDb.prepare("SELECT stream_id FROM roam_meta WHERE id=1").get() as { stream_id: string }).stream_id;
      const cursor = boxDb.prepare("SELECT last_seq FROM roam_cursors WHERE peer_machine=? AND peer_stream=?").get(HUB, stream) as { last_seq: number };
      expect(cursor.last_seq).toBe(committedThrough);
      expect(boxDb.prepare("SELECT count(*) AS n FROM roam_receipts").get()).toEqual({ n: 1 });
    } finally { hubDb.close(); boxDb.close(); }
    child.kill("SIGTERM"); expect(await exit(child)).toEqual({ code: 0, signal: null });
    f.env.SPIDER_TEST_HC_OFFLINE = "1";
    child = start(f); await ready(f.socket, child);
    const restarted = openDb(join(box, "spider.db"));
    try {
      const cursor = restarted.prepare("SELECT last_seq FROM roam_cursors WHERE peer_machine=? AND peer_stream=?").get(HUB, stream) as { last_seq: number };
      const cursorAfterRestart = cursor.last_seq;
      expect(cursorAfterRestart).toBe(committedThrough);
    } finally { restarted.close(); }
    const entries = readFileSync(calls, "utf8").trim().split("\n").map(line => JSON.parse(line) as string[]);
    expect(entries.some(args => args[0] === "exec" && args.includes("artifact") && args.includes("receive"))).toBe(true);
    expect(entries.filter(args => args[0] === "exec").every(args => args.includes(`--on=${alias}`))).toBe(true);
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill("SIGTERM"); await exit(child); }
    await new Promise<void>(done => server.close(() => done()));
  }
}, 5000);

it("the packaged hub preserves pending readiness and suspension when those observations are unavailable", async () => {
  const f = fixture(), alias = "-box-1.invalid", calls = join(f.root, "hc-calls");
  const peer = { machineId: BOX, alias, node: process.execPath, pi: process.execPath, cli: f.cli, core: join(f.root, "hc"), globalRoot: f.root };
  writeFileSync(join(f.root, "roam", "config.json"), JSON.stringify({ enabled: true, role: "hub", machineId: HUB,
    hubMachineId: HUB, peers: [peer], discoveryRoots: [], coreUnit: "fixture" }), { mode: 0o600 });
  writeFileSync(join(f.root, "hc"), `#!${process.execPath}\nimport {appendFileSync} from 'node:fs';\nconst a=process.argv.slice(2); appendFileSync(${JSON.stringify(calls)},JSON.stringify(a)+'\\n');\nif(a[0]==='server') console.log(JSON.stringify({core:{id:'local-core'},version:'0.1.16'}));\nelse if(a[0]==='machine') console.log(JSON.stringify({machines:[{name:${JSON.stringify(alias)},id:'remote-core',state:'connected'}]}));\nelse if(a[0]==='exec') { const cmd=a.slice(a.indexOf('--')+1); if(cmd[0]==='cat') console.log(JSON.stringify({machineId:${JSON.stringify(BOX)}})); else { const op=JSON.parse(cmd.at(-1)); console.log(JSON.stringify(op.kind==='stores'?{code:0,operationId:op.id,value:{protocol:1,schema:14,machineId:${JSON.stringify(BOX)},stores:['global']}}:{code:1,operationId:op.id,reason:'fixture refusal'})); if(op.kind!=='stores')process.exitCode=1; } }\nelse process.exitCode=1;\n`, { mode: 0o700 });
  const db = openDb(join(f.root, "spider.db"));
  db.prepare("INSERT INTO session_homes(session_id,machine_id,epoch,move_id,updated_at) VALUES ('session-a',?,1,NULL,1)").run(BOX);
  const alert = { id: "notice-1", delivered: true, clearing: false, sessionId: "session-a", epoch: 1 };
  const row = { origin: "hub-operation" as const, opId: "op-1", sessionId: "session-a", epoch: 1, cwd: f.root, file: join(f.root, "session"), core: "remote-core", terminal: `${alias}/t1` };
  writeLocal(db, "hub-peer", BOX, { since: null, unreachable: null, suspensions: [alert] });
  writeLocal(db, "hub-placement", BOX, [row]); db.close();
  const server = createServer(socket => socket.end());
  await new Promise<void>(done => server.listen(f.env.HC_SOCKET, done));
  const child = start(f);
  try {
    await ready(f.socket, child);
    expect(await requestHubControl(f.socket, { op: "sync", machine: BOX })).toMatchObject({ code: 1 });
    const inspect = openDb(join(f.root, "spider.db"));
    try {
      expect(readLocal(inspect, "hub-placement", BOX)).toEqual([row]);
      expect(readLocal<{ suspensions: unknown[] }>(inspect, "hub-peer", BOX)?.suspensions).toEqual([alert]);
    } finally { inspect.close(); }
    const entries = readFileSync(calls, "utf8").trim().split("\n").map(line => JSON.parse(line) as string[]);
    expect(entries.some(args => args[0] === "exec" && args.includes(`--on=${alias}`))).toBe(true);
    expect(entries.filter(args => args[0] === "exec").every(args => args.some(arg => arg === `--on=${alias}`))).toBe(true);
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill("SIGTERM"); await exit(child); }
    await new Promise<void>(done => server.close(() => done()));
  }
}, 5000);

it("the packaged hub publishes one native notice across restart and clears it on recovery", async () => {
  const f = fixture(), alias = "box-1.invalid", state = join(f.root, "machine-state"), notices = join(f.root, "notices");
  const peer = { machineId: BOX, alias, node: process.execPath, pi: process.execPath, cli: f.cli, core: join(f.root, "hc"), globalRoot: f.root };
  writeFileSync(join(f.root, "roam", "config.json"), JSON.stringify({ enabled: true, role: "hub", machineId: HUB,
    hubMachineId: HUB, peers: [peer], discoveryRoots: [], coreUnit: "fixture" }), { mode: 0o600 });
  writeFileSync(state, "disconnected");
  writeFileSync(join(f.root, "hc"), `#!${process.execPath}\nimport {readFileSync} from 'node:fs'; const a=process.argv.slice(2);\nif(a[0]==='server') console.log(JSON.stringify({core:{id:'local-core'},version:'0.1.16'}));\nelse if(a[0]==='machine') console.log(JSON.stringify({machines:[{name:${JSON.stringify(alias)},id:'remote-core',state:readFileSync(${JSON.stringify(state)},'utf8')}]}));\nelse if(a[0]==='exec') { const cmd=a.slice(a.indexOf('--')+1); if(cmd[0]==='cat') console.log(JSON.stringify({machineId:${JSON.stringify(BOX)}})); else { const op=JSON.parse(cmd.at(-1)); console.log(JSON.stringify(op.kind==='stores'?{code:0,operationId:op.id,value:{protocol:1,schema:14,machineId:${JSON.stringify(BOX)},stores:['global']}}:{code:1,operationId:op.id,reason:'fixture refusal'})); if(op.kind!=='stores')process.exitCode=1; } }\nelse process.exitCode=1;\n`, { mode: 0o700 });
  const notify = join(f.root, "notify");
  writeFileSync(notify, `#!${process.execPath}\nimport {appendFileSync} from 'node:fs'; const a=process.argv.slice(process.argv.indexOf('--')+1); appendFileSync(${JSON.stringify(notices)},JSON.stringify(a)+'\\n');\n`, { mode: 0o700 });
  f.env.SPIDER_TEST_ROAM_OSASCRIPT = notify;
  const db = openDb(join(f.root, "spider.db"));
  db.prepare("INSERT INTO session_homes(session_id,machine_id,epoch,move_id,updated_at) VALUES ('session-a',?,1,NULL,1)").run(BOX);
  writeLocal(db, "hub-peer", BOX, { since: Date.now() - 11 * 60_000, unreachable: null, suspensions: [] }); db.close();
  const server = createServer(socket => socket.end()); await new Promise<void>(done => server.listen(f.env.HC_SOCKET, done));
  let child = start(f);
  try {
    await ready(f.socket, child);
    const deadline = Date.now() + 1500;
    while (!existsSync(notices) && Date.now() < deadline) await delay(20);
    expect(existsSync(notices)).toBe(true);
    child.kill("SIGTERM"); expect(await exit(child)).toEqual({ code: 0, signal: null });
    child = start(f); await ready(f.socket, child);
    await requestHubControl(f.socket, { op: "sync", machine: BOX });
    let rows = readFileSync(notices, "utf8").trim().split("\n").map(line => JSON.parse(line) as string[]);
    expect(rows.map(row => row[0])).toEqual(["publish"]);
    expect(rows[0][2]).toContain(BOX);
    writeFileSync(state, "connected");
    await requestHubControl(f.socket, { op: "sync", machine: BOX });
    rows = readFileSync(notices, "utf8").trim().split("\n").map(line => JSON.parse(line) as string[]);
    expect(rows.map(row => row[0])).toEqual(["publish", "clear"]);
    expect(rows[1][1]).toBe(rows[0][1]);
    const inspect = openDb(join(f.root, "spider.db"));
    try { expect(readLocal<{ unreachable: unknown }>(inspect, "hub-peer", BOX)?.unreachable).toBeNull(); }
    finally { inspect.close(); }
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill("SIGTERM"); await exit(child); }
    await new Promise<void>(done => server.close(() => done()));
  }
}, 5000);

it("A9 hub survives without pi or a core, enforces its lock and refuses disabling a home change", async () => {
  const f = fixture(), child = start(f);
  try {
    expect(await ready(f.socket, child)).toMatchObject({ code: 0, value: { enabled: true } });
    expect(existsSync(f.marker)).toBe(false);
    const second = start(f);
    expect(await exit(second)).toMatchObject({ code: 1 });
    const journal = openJournal(join(f.root, "roam", "journal.db"));
    journal.begin({ id: "move-1", machineId: HUB, expectedEpoch: 1, kind: "move", args: {} });
    expect(await requestHubControl(f.socket, { op: "disable" })).toMatchObject({ code: 1 });
    journal.record("move-1", "done", { done: true });
    expect(await requestHubControl(f.socket, { op: "disable" })).toMatchObject({ code: 0 });
    child.kill("SIGTERM");
    expect(await exit(child)).toEqual({ code: 0, signal: null });
    expect(existsSync(f.marker)).toBe(false);
  } finally { if (child.exitCode === null && child.signalCode === null) { child.kill("SIGTERM"); await exit(child); } }
}, 5000);

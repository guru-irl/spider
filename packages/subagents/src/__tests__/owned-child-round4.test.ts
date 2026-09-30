import { afterEach, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { defaultSpawner } from "../spawn-default";
import { teardownAllAsync } from "../coordinators";
import { RunStore } from "../run-store";
import { killRun } from "../kill";
import { freshDb } from "./helpers/testutil";
import { Runner } from "../runner";
import { RunEventTailer } from "../event-tailer";

const state = vi.hoisted(() => ({ nullStart: false, fakeChild: undefined as any, identityMatches: false }));
vi.mock("../process-identity", async original => {
  const actual = await original<typeof import("../process-identity")>();
  return { ...actual, processStartTime: (pid: number) => state.nullStart || state.fakeChild ? null : actual.processStartTime(pid),
    checkProcessIdentity: (...args: Parameters<typeof actual.checkProcessIdentity>) => state.fakeChild ? { matches: state.identityMatches, reason: "reused pid" } : actual.checkProcessIdentity(...args) };
});
vi.mock("node:child_process", async original => {
  const actual = await original<typeof import("node:child_process")>();
  return { ...actual, spawn: (...args: any[]) => state.fakeChild ?? (actual.spawn as any)(...args) };
});
const roots: string[] = [], pids: number[] = [];
afterEach(async () => {
  await teardownAllAsync({ graceMs: 25 });
  vi.restoreAllMocks(); state.fakeChild = undefined; state.nullStart = false;
  for (const pid of pids.splice(0)) { try { process.kill(process.platform === "win32" ? pid : -pid, "SIGKILL"); } catch {} }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
async function bounded<T>(promise: Promise<T>): Promise<T | "timeout"> {
  let timer: ReturnType<typeof setTimeout>;
  try { return await Promise.race([promise, new Promise<"timeout">(r => { timer = setTimeout(() => r("timeout"), 1500); })]); }
  finally { clearTimeout(timer!); }
}
it.each(["print", "rpc", "ignore-eof"].flatMap(mode => ["kill", "shutdown"].map(cause => [mode, cause])))("owned %s child stops on %s when start capture fails", async (mode, cause) => {
  state.nullStart = true;
  const scratch = resolve(".spider/scratch/owned-round4"); mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, "case-")); roots.push(root);
  const script = join(root, "child.cjs");
  writeFileSync(script, `process.title='pi'; setInterval(()=>{},1000); require('node:fs').writeFileSync(process.env.READY_FILE,'ready');
  if(process.env.PRINT_MODE!=='1') process.stdin.on('data', chunk => { for (const line of String(chunk).trim().split('\\n')) { const c=JSON.parse(line); if(c.type==='abort') process.stdout.write(JSON.stringify({type:'response',id:c.id,success:true})+'\\n'); } });
  if(process.env.PRINT_MODE!=='1') process.stdin.on('end',()=>{ if(process.env.IGNORE_EOF!=='1') process.exit(0); });`);
  {
    const db = freshDb(); let handle: import('../runner').ChildHandle | undefined;
    const ready = join(root, `${cause}-ready`);
    try {
      const store = new RunStore(db); const events: any[] = [];
      const runner = new Runner(db, "owner", root, { store, tailer: new RunEventTailer(db), scratchRoot: root, dbPath: join(root,"fixture.db"),
        childMode: mode === "print" ? "print" : "rpc", spawn: spec => defaultSpawner({ ...spec, argv: [process.execPath, script], env: { PRINT_MODE: mode === 'print' ? '1' : '0', IGNORE_EOF: mode === "ignore-eof" ? "1" : "0", READY_FILE: ready }, onRpcEvent: e => events.push(e) }) });
      const run = runner.runAsync({ agent: "worker", task: "work", context: "fresh" });
      handle = (await import("../coordinators")).getChild("owner", run.id)!; pids.push(handle.pid!);
      await vi.waitFor(() => expect(existsSync(ready)).toBe(true));
      expect(store.get(run.id)?.pid_start_time).toBeNull();
      if(cause === "kill") expect(await killRun({ store, db }, "owner", store.get(run.id)!)).toMatchObject({ outcome: "killed", via: "handle" });
      else await teardownAllAsync({ graceMs: 25 });
      expect(await bounded(handle.wait())).not.toBe("timeout");
      expect(events).toContainEqual(expect.objectContaining({ type: "warning", message: expect.stringMatching(/start.*unavailable|cannot.*start/i) }));
    } finally {
      if (handle?.pid) { try { process.kill(process.platform === 'win32' ? handle.pid : -handle.pid, 'SIGKILL'); } catch {} await bounded(handle.wait()); await Promise.resolve(); }
      db.close();
    }
  }
});
it.skipIf(process.platform === "win32")("signals the owned process group after its leader exits", async () => {
  const scratch = resolve(".spider/scratch/owned-round4"); mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, "group-")); roots.push(root);
  const ready = join(root, "ready"), stopped = join(root, "stopped");
  const memberCode = `require('node:fs').writeFileSync(${JSON.stringify(ready)},String(process.pid)); process.on('SIGTERM',()=>{require('node:fs').writeFileSync(${JSON.stringify(stopped)},'stopped');process.exit(0)}); setInterval(()=>{},1000); process.send('ready');`;
  const leaderCode = `const c=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(memberCode)}],{stdio:['ignore','ignore','ignore','ipc']}); c.on('message',()=>process.exit(0));`;
  const h = defaultSpawner({ argv: [process.execPath, "-e", leaderCode], env: {}, cwd: root, sessionFile: "unused", childMode: "print" }); pids.push(h.pid!);
  let member: number | undefined;
  try {
    expect(await bounded(h.wait())).toEqual({ exitCode: 0 });
    member = Number(readFileSync(ready, "utf8"));
    expect(() => process.kill(-h.pid!, 0)).not.toThrow();
    await h.killAsync!(25);
    await vi.waitFor(() => expect(existsSync(stopped)).toBe(true));
  } finally { if(member) { try { process.kill(member,'SIGKILL'); } catch {} } }
});
it.skipIf(process.platform === "win32")("refuses a reused live pid even when its process group exists", async () => {
  state.fakeChild = Object.assign(new EventEmitter(), { pid: 987654, exitCode: 0, signalCode: null, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), unref() {} });
  const signals: any[] = [];
  vi.spyOn(process, "kill").mockImplementation((pid, signal) => { if (signal !== 0) signals.push([pid, signal]); return true; });
  const h = defaultSpawner({ argv: ["fake"], env: {}, cwd: process.cwd(), sessionFile: "unused", childMode: "print" });
  await expect(h.killAsync!(1)).rejects.toThrow(/identity unconfirmed/i);
  expect(signals).toEqual([]);
});
it("a launched run persists the spawner's start identity", async () => {
  const db = freshDb();
  try {
    const store = new RunStore(db); const runner = new Runner(db, "identity", process.cwd(), { store, tailer: new RunEventTailer(db), scratchRoot: resolve(".spider/scratch/owned-round4"), dbPath: "fixture.db",
      spawn: () => ({ pid: 1234, startTime: "posix:fixture-start", wait: async () => ({ exitCode: 0, result: "report" }), kill() {}, detach() {} }) });
    const row = await runner.runForeground({ agent: "worker", task: "work", context: "fresh" });
    expect(row).toMatchObject({ pid: 1234, host_pid: process.pid, pid_start_time: "posix:fixture-start" });
  } finally { db.close(); }
});
it("the spawner propagates permission failures to its awaitable kill caller", async () => {
  state.fakeChild = Object.assign(new EventEmitter(), { pid: 12345, exitCode: null, signalCode: null, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), unref() {} });
  vi.spyOn(process, "kill").mockImplementation(() => { throw Object.assign(new Error("permission denied"), {code:"EPERM"}); });
  const h = defaultSpawner({ argv: ["fake"], env: {}, cwd: process.cwd(), sessionFile: "unused", childMode: "print" });
  await expect(h.killAsync!(1)).rejects.toThrow(/permission denied/);
});
it.skipIf(process.platform === "win32")("the spawner refuses a reaped child's reused leader pid", async () => {
  state.fakeChild = Object.assign(new EventEmitter(), { pid: 987654, exitCode: 0, signalCode: null, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), unref() {} });
  const signals: any[] = [];
  vi.spyOn(process, "kill").mockImplementation((pid, signal) => { if (pid < 0 && signal === 0) throw Object.assign(new Error("gone"), {code:"ESRCH"}); if (signal !== 0) signals.push([pid,signal]); return true; });
  const h = defaultSpawner({ argv: ["fake"], env: {}, cwd: process.cwd(), sessionFile: "unused", childMode: "print" });
  await expect(h.killAsync!(1)).rejects.toThrow(/identity unconfirmed/i);
  expect(signals).toEqual([]);
});

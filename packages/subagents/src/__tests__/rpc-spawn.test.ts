import { afterEach, describe, expect, it } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import { buildSync } from "esbuild";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, watch, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { defaultSpawner } from "../spawn-default";
import type { ChildHandle } from "../runner";
import { registerChild, teardownAllAsync } from "../coordinators";

const roots: string[] = [];
const handles: ChildHandle[] = [];
afterEach(async () => {
  const errors: unknown[] = [];
  try { await teardownAllAsync(); } catch (error) { errors.push(error); }
  for (const h of handles.splice(0)) {
    try { await h.killAsync?.(25); } catch (error) { errors.push(error); }
    finally {
      // Do not reuse the implementation under test for last-resort cleanup:
      // a mutant or permission-path failure must not orphan a SIGTERM-ignoring fixture.
      if (await bounded(h.wait()) === "timeout" && h.pid) {
        try { process.kill(process.platform === "win32" ? h.pid : -h.pid, "SIGKILL"); } catch {}
        await bounded(h.wait());
      }
    }
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  if (errors.length) throw new AggregateError(errors, "RPC fixture cleanup failed");
});
const fake = `
import { appendFileSync } from 'node:fs';
const log = process.env.COMMAND_LOG;
const out = obj => process.stdout.write(JSON.stringify(obj) + '\\n');
let buffer = '', prompts = 0, waiting = false;
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  let i;
  while ((i = buffer.indexOf('\\n')) !== -1) {
    const c = JSON.parse(buffer.slice(0, i)); buffer = buffer.slice(i + 1);
    appendFileSync(log, JSON.stringify(c) + '\\n');
    if (c.type === 'prompt') {
      prompts++;
      out({ type: 'response', id: c.id, command: 'prompt', success: true });
      out({ type: 'agent_start' });
      if (process.env.SCENARIO === 'death') process.exit(7);
      else if (process.env.SCENARIO === 'ignore-eof') { setInterval(() => {}, 1000); out({ type: 'agent_end', messages: [] }); }
      else if (process.env.SCENARIO === 'complete') {
        for (let n = 0; n < 2000; n++) out({ type: 'message_update', text: 'x'.repeat(1024) + 'a\\u2028b\\u2029c' });
        process.stdout.write('{"type":"cr_record",\\r"value":"kept"}\\n');
        for (const method of ['select', 'confirm', 'input', 'editor']) out({ type: 'extension_ui_request', id: method, method });
      } else if (process.env.SCENARIO === 'hold') out({ type: 'agent_end', messages: [] });
      else if (process.env.SCENARIO === 'queued') {
        waiting = true; out({ type: 'queue_update', steering: ['pending'], followUp: [] }); out({ type: 'agent_settled' });
        setTimeout(() => { waiting = false; out({ type: 'queue_update', steering: [], followUp: [] }); }, 50);
      } else if (['race', 'late-queue', 'callback-late'].includes(process.env.SCENARIO)) { waiting = process.env.SCENARIO !== 'callback-late'; out({ type: 'agent_settled' }); }
    } else if (c.type === 'extension_ui_response' && c.id === 'editor') {
      out({ type: 'agent_end', messages: [] }); out({ type: 'queue_update', steering: [], followUp: [] }); out({ type: 'agent_settled' });
    } else if (c.type === 'clear_queue') {
      waiting = false;
      out({ type: 'queue_update', steering: [], followUp: [] });
    } else if (c.type === 'steer') {
      if (process.env.SCENARIO === 'late-queue') {
        waiting = false; out({ type: 'queue_update', steering: [c.message], followUp: [] });
        out({ type: 'response', id: c.id, command: 'steer', success: true }); continue;
      }
      if (process.env.SCENARIO === 'consumed') {
        out({ type: 'queue_update', steering: [c.message], followUp: [] });
        out({ type: 'queue_update', steering: [], followUp: [] });
        out({ type: 'message_end', message: { role: 'user', content: c.message } });
        waiting = true; out({ type: 'agent_settled' });
        setTimeout(() => { waiting = false; out({ type: 'response', id: c.id, command: 'steer', success: true }); }, 50); continue;
      }
      if (process.env.SCENARIO === 'race') {
        setTimeout(() => { waiting = false; out({ type: 'response', id: c.id, command: 'steer', success: true }); }, 50);
        continue;
      }
      out({ type: 'queue_update', steering: [c.message], followUp: [] });
      out({ type: 'response', id: c.id, command: 'steer', success: true });
      out({ type: 'queue_update', steering: [], followUp: [] });
    } else if (c.type === 'abort') out({ type: 'response', id: c.id, command: 'abort', success: true });
  }
});
process.stdin.on('end', () => { appendFileSync(log, JSON.stringify({ type: 'eof' }) + '\\n'); if (process.env.SCENARIO !== 'ignore-eof') process.exit(prompts === 1 && !waiting ? 0 : 9); });
`;
function fixture(scenario: string) {
  const scratch = resolve(".spider/scratch/rpc-spawn"); mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, "case-")); roots.push(root);
  execFileSync("git", ["init", "-q", root]);
  const script = join(root, "fake.mjs"), log = join(root, "commands.jsonl");
  writeFileSync(script, fake); writeFileSync(log, "");
  const events: any[] = [];
  let ready!: () => void;
  const agentEnded = new Promise<void>(resolveReady => { ready = resolveReady; });
  let racingAck: Promise<any> | undefined;
  const h: ChildHandle = defaultSpawner({ argv: [process.execPath, script], cwd: root, env: { COMMAND_LOG: log, SCENARIO: scenario }, sessionFile: join(root, "session.jsonl"), childMode: "rpc", prompt: "one task", onRpcEvent: (e: any) => { events.push(e); if (e.type === "agent_end") ready(); if (["race", "late-queue", "consumed"].includes(scenario) && e.type === "agent_start") racingAck = h.steer!("racing correction"); if (scenario === "callback-late" && e.type === "agent_settled") racingAck = h.steer!("too late from observer"); } } as any);
  handles.push(h);
  return { h: h as ChildHandle & { steer(message: string): Promise<any> }, events, agentEnded, racingAck: () => racingAck, commands: () => readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l)) };
}
async function bounded<T>(promise: Promise<T>): Promise<T | "timeout"> {
  let timer: ReturnType<typeof setTimeout>;
  try { return await Promise.race([promise, new Promise<"timeout">(r => { timer = setTimeout(() => r("timeout"), 2000); })]); }
  finally { clearTimeout(timer!); }
}
describe("parent-owned RPC child", () => {
  it.skipIf(process.platform === "win32")("retains the legacy default kill grace for print children", async () => {
    const scratch = resolve(".spider/scratch/rpc-spawn"); mkdirSync(scratch, { recursive: true });
    const root = mkdtempSync(join(scratch, "print-")); roots.push(root); execFileSync("git", ["init", "-q", root]);
    const ready = join(root, "ready");
    const h = defaultSpawner({ argv: [process.execPath, "-e", `process.on('SIGTERM',()=>{}); require('node:fs').writeFileSync(${JSON.stringify(ready)},'ready'); setInterval(()=>{},1000);`], env: {}, cwd: root, sessionFile: "unused", childMode: "print" }); handles.push(h);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const watcher = watch(root);
    try {
      const started = new Promise<void>((resolveReady, reject) => { watcher.on("change", () => { if (existsSync(ready)) resolveReady(); }); timer = setTimeout(() => reject(new Error("Print fixture startup timeout")), 2000); if (existsSync(ready)) resolveReady(); });
      await started; clearTimeout(timer);
      const begin = Date.now(); await h.killAsync!(); await h.wait();
      expect(Date.now() - begin).toBeGreaterThanOrEqual(2500);
    } finally { watcher.close(); if (timer) clearTimeout(timer); }
  });
  it("closes a fake RPC child's stdin when its owning parent dies abruptly", async () => {
    const scratch = resolve(".spider/scratch/rpc-spawn"); mkdirSync(scratch, { recursive: true });
    const root = mkdtempSync(join(scratch, "death-")); roots.push(root); execFileSync("git", ["init", "-q", root]);
    const script = join(root, "fake.mjs"), log = join(root, "commands.jsonl"), launcher = join(root, "launcher.mjs");
    writeFileSync(script, fake); writeFileSync(log, "");
    buildSync({ stdin: { contents: `import { defaultSpawner } from ${JSON.stringify(resolve("packages/subagents/src/spawn-default.ts"))}; const h = defaultSpawner({ ...${JSON.stringify({ argv: [process.execPath, script], cwd: root, sessionFile: join(root, "s.jsonl"), env: { COMMAND_LOG: log, SCENARIO: "hold" }, childMode: "rpc", prompt: "one task" })}, onRpcEvent: e => { if (e.type === 'agent_end') process.stdout.write(JSON.stringify({ pid: h.pid })+'\\n'); } });`, resolveDir: process.cwd(), sourcefile: "launcher.ts" }, bundle: true, platform: "node", format: "esm", outfile: launcher });
    const parent = spawn(process.execPath, [launcher], { cwd: root, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const parentExit = once(parent, "exit"); let childPid: number | undefined; let watcher: ReturnType<typeof watch> | undefined; let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const ready = await bounded(once(parent.stdout!, "data"));
      if (ready === "timeout") throw new Error("Abrupt-parent fixture did not become ready");
      childPid = JSON.parse(ready[0].toString()).pid;
      const eof = new Promise<boolean>(resolveEof => {
        watcher = watch(log, () => { if (readFileSync(log, "utf8").includes('"type":"eof"')) resolveEof(true); });
        timer = setTimeout(() => resolveEof(false), 2000);
      });
      process.kill(parent.pid!, "SIGKILL"); await parentExit;
      expect(await eof).toBe(true);
    } finally {
      watcher?.close(); if (timer) clearTimeout(timer);
      if (parent.exitCode === null && parent.signalCode === null) { parent.kill("SIGKILL"); await parentExit; }
      if (childPid) { try { process.kill(process.platform === "win32" ? childPid : -childPid, "SIGKILL"); } catch {} }
    }
  });
  it("prompts once, drains large output with Unicode separators, cancels all dialogs and exits after settling", async () => {
    const f = fixture("complete");
    const result = await bounded(f.h.wait());
    expect(result).toEqual({ exitCode: 0 });
    expect(f.commands().filter(c => c.type === "prompt")).toHaveLength(1);
    expect(f.commands().filter(c => c.type === "extension_ui_response")).toEqual(["select", "confirm", "input", "editor"].map(id => ({ type: "extension_ui_response", id, cancelled: true })));
    expect(f.events.filter(e => e.type === "message_update")).toHaveLength(2000);
    expect(f.events.filter(e => e.type === "cr_record")).toEqual([{ type: "cr_record", value: "kept" }]);
    expect(f.events.find(e => e.type === "message_update").text).toContain("a\u2028b\u2029c");
    expect(await f.h.steer("too late")).toMatchObject({ accepted: false });
    expect(f.commands().filter(c => c.type === "steer")).toHaveLength(0);
  });
  it("accepts a running steer over stdin and does not treat agent_end alone as completion", async () => {
    const f = fixture("hold");
    expect(typeof f.h.steer).toBe("function");
    expect(await bounded(f.agentEnded)).not.toBe("timeout");
    const ack = await bounded(f.h.steer("correct direction"));
    expect(ack).toMatchObject({ accepted: true });
    expect(f.commands().filter(c => c.type === "steer").map(c => c.message)).toEqual(["correct direction"]);
    await (f.h as any).killAsync(100);
    expect(f.commands().some(c => c.type === "abort")).toBe(true);
    expect(await f.h.wait()).toEqual({ exitCode: 0 });
  });
  it("discards an idle queued continuation at settlement without sending another prompt", async () => {
    const f = fixture("queued");
    expect(await bounded(f.h.wait())).toEqual({ exitCode: 0 });
  });
  it("waits for an in-flight steer response before completing a settled child", async () => {
    const f = fixture("race");
    expect(await bounded(f.h.wait())).toEqual({ exitCode: 0 });
    expect(await f.racingAck()).toMatchObject({ accepted: false, childAccepted: true });
    expect(f.events).toContainEqual(expect.objectContaining({ type: "steer_delivery", delivered: false }));
  });
  it("clears an idle steer queued after settlement rather than hanging or starting an extra prompt", async () => {
    const f = fixture("late-queue");
    expect(await bounded(f.h.wait())).toEqual({ exitCode: 0 });
    expect(await f.racingAck()).toMatchObject({ accepted: false, childAccepted: true });
    expect(f.events).toContainEqual(expect.objectContaining({ type: "steer_delivery", delivered: false }));
    expect(f.commands().filter(c => c.type === "prompt")).toHaveLength(1);
    expect(f.commands().some(c => c.type === "clear_queue")).toBe(true);
  });
  it("does not infer individual consumption from uncorrelated turn text after a late acknowledgement", async () => {
    const f = fixture("consumed");
    expect(await bounded(f.h.wait())).toEqual({ exitCode: 0 });
    expect(await f.racingAck()).toMatchObject({ accepted: false, childAccepted: true });
    expect(f.events).toContainEqual(expect.objectContaining({ type: "steer_delivery", delivered: false }));
    expect(f.events.find(e => e.type === "steer_delivery").message).toMatch(/confirm/i);
  });
  it("updates settlement state before notifying observers so they cannot write a late steer", async () => {
    const f = fixture("callback-late");
    expect(await bounded(f.h.wait())).toEqual({ exitCode: 0 });
    expect(await f.racingAck()).toMatchObject({ accepted: false });
    expect(f.commands().filter(c => c.type === "steer")).toHaveLength(0);
  });
  it("uses process-group fallback when RPC abort and EOF do not stop a child", async () => {
    const f = fixture("ignore-eof");
    expect(await bounded(f.agentEnded)).not.toBe("timeout");
    await f.h.killAsync!(25);
    expect(await bounded(f.h.wait())).toEqual({ exitCode: 143 });
  });
  it("settles wait on unexpected child death", async () => {
    const f = fixture("death");
    expect(await bounded(f.h.wait())).toEqual({ exitCode: 7 });
  });
  it.each(["reload", "quit"])("retains kill-on-%s teardown for RPC pipes", async () => {
    const f = fixture("hold");
    registerChild("parent", "rpc-run", f.h);
    await teardownAllAsync({ graceMs: 100 });
    expect(await bounded(f.h.wait())).not.toBe("timeout");
  });
});

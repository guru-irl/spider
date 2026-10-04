import { afterEach, expect, it } from "vitest";
import { buildSync } from "esbuild";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { ownRpcChild } from "../rpc-child";
import { NO_DELIVERABLE_RESULT } from "../completion-output";
import { emitStatus } from "../run-events";
import { testScratchPath } from "./helpers/testutil";
import { openDbAt, type Db } from "@spider/db-core";
import { Runner, type ChildHandle } from "../runner";
import { RunStore } from "../run-store";
import { RunEventTailer } from "../event-tailer";
import { defaultSpawner } from "../spawn-default";
import { makeAsyncNotifier } from "../actions/run";
import { getChild, teardownAllAsync } from "../coordinators";
import { runUsage } from "../usage";

const roots: string[] = [], dbs: Db[] = [], handles: ChildHandle[] = [];
const streams: Array<{ child: EventEmitter; stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; end: () => Promise<void> }> = [];
afterEach(async () => {
  // Cleanup is independent of the RPC shutdown behavior under test.
  for (const h of handles.splice(0)) {
    if (await bounded(h.wait()) === "timeout" && h.pid) {
      try { process.kill(process.platform === "win32" ? h.pid : -h.pid, "SIGKILL"); } catch {}
      await bounded(h.wait());
    }
  }
  for (const f of streams.splice(0)) { await f.end(); f.child.emit("exit", 0); f.stdin.destroy(); f.stdout.destroy(); f.stderr.destroy(); }
  await teardownAllAsync();
  for (const db of dbs.splice(0)) db.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
async function bounded<T>(promise: Promise<T>): Promise<T | "timeout"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<"timeout">(r => { timer = setTimeout(() => r("timeout"), 2000); })]); }
  finally { clearTimeout(timer); }
}
const usage = { input: 7, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 10,
  cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 } };

// A client that ignores handled would hang; synthetic usage or duplicate completion would also fail.
it.each([
  { recorded: false, reporter: false, early: false }, { recorded: true, reporter: false, early: false },
  { recorded: false, reporter: true, early: false }, { recorded: true, reporter: true, early: false },
  { recorded: false, reporter: true, early: true }, { recorded: true, reporter: true, early: true },
])("a handled initial prompt fails once and reports only recorded usage (recorded=$recorded, reporter=$reporter, early=$early)", async ({ recorded, reporter, early }) => {
  const root = mkdtempSync(testScratchPath("handled-")); roots.push(root);
  const dbPath = join(root, "project.db"), db = openDbAt(dbPath, "project"); dbs.push(db);
  const store = new RunStore(db), notices: any[] = [], usageReports: any[] = [];
  const script = join(root, "fake.mjs"), commandLog = join(root, "commands.jsonl");
  writeFileSync(commandLog, "");
  const reporterPath = join(root, "reporter.mjs");
  const reporterEntry = fileURLToPath(new URL("../child-reporter.ts", import.meta.url));
  if (reporter) buildSync({ stdin: { contents: `export { openDbAt } from '@spider/db-core'; export { makeChildReporter } from ${JSON.stringify(reporterEntry)};`,
    resolveDir: fileURLToPath(new URL(".", import.meta.url)), sourcefile: "reporter.ts" }, bundle: true, platform: "node", format: "esm", external: ["better-sqlite3"], outfile: reporterPath });
  writeFileSync(script, `
    import { appendFileSync } from 'node:fs';
    const out = e => process.stdout.write(JSON.stringify(e) + '\\n');
    let buffer = '';
    const shutdownReporter = async () => {
      ${reporter ? `const { openDbAt, makeChildReporter } = await import('./reporter.mjs');
      const db = openDbAt(process.env.TEST_DB_PATH, 'project');
      makeChildReporter(db, { runId: process.env.TEST_RUN_ID, sessionId: 'owner' }).onShutdown('done');
      db.close();` : ""}
    };
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', async chunk => {
      buffer += chunk;
      let i;
      while ((i = buffer.indexOf('\\n')) !== -1) {
        const c = JSON.parse(buffer.slice(0, i)); buffer = buffer.slice(i + 1);
        appendFileSync(process.env.COMMAND_LOG, JSON.stringify(c) + '\\n');
        if (c.type === 'prompt') {
          ${recorded ? `out({ type: 'entry_appended', entry: { type: 'usage', provider: 'fixture', model: 'extension', kind: 'tool', usage: ${JSON.stringify(usage)} } });` : ""}
          ${early ? "await shutdownReporter();" : ""}
          const response = { type: 'response', command: 'prompt', id: c.id, success: true, data: { disposition: 'handled' } };
          out(response); out(response);
          // No run or settlement event is emitted.
        }
      }
    });
    process.stdin.on('end', async () => {
      await shutdownReporter();
      appendFileSync(process.env.COMMAND_LOG, JSON.stringify({ type: 'eof' }) + '\\n');
      process.exit(0);
    });
  `);
  let completed!: () => void;
  const completion = new Promise<void>(r => { completed = r; });
  const notify = makeAsyncNotifier({ db, pi: { sendMessage(m: any) { notices.push(m); } } });
  const runner = new Runner(db, "owner", root, { store, tailer: new RunEventTailer(db), dbPath,
    scratchRoot: join(root, "runs"), childMode: "rpc",
    spawn: spec => {
      const h = defaultSpawner({ ...spec, argv: [process.execPath, script], env: { COMMAND_LOG: commandLog, TEST_DB_PATH: dbPath, TEST_RUN_ID: spec.env.PI_SUBAGENT_RUN_ID } });
      handles.push(h); return h;
    },
    reportUsage: row => { usageReports.push(runUsage(db, row.id)); },
    onComplete: (row, status, result) => { notify(row, status, result); completed(); },
  });
  const row = runner.runAsync({ agent: "worker", task: "work", context: "fresh" });
  expect(await bounded(completion)).not.toBe("timeout");
  await handles.at(-1)!.wait();
  const final = store.get(row.id)!;
  expect(final).toMatchObject({ status: "failed", token_count: recorded ? 10 : 0,
    result: expect.stringMatching(/consumed by an extension.*handled.*no model run started for the task/i) });
  const statuses = db.prepare("SELECT payload FROM run_events WHERE run_id=? AND type='status'").all(row.id) as Array<{ payload: string }>;
  expect(statuses.map(e => JSON.parse(e.payload).status).filter(s => ["done", "failed", "cancelled"].includes(s))).toEqual(["failed"]);
  expect(notices).toHaveLength(1);
  expect(notices[0].details).toMatchObject({ status: "failed", output: final.result });
  expect(usageReports).toEqual([recorded ? [{ provider: "fixture", model: "extension", usage }] : []]);
  expect(getChild("owner", row.id)).toBeUndefined();
  const commands = readFileSync(commandLog, "utf8").trim().split("\n").map(l => JSON.parse(l));
  expect(commands.map(c => c.type)).toEqual(["prompt", "eof"]);
});

// Keep the DB and finalizer real; only the RPC subprocess transport is in memory.
function runnerFixture(name: string) {
  const root = mkdtempSync(testScratchPath("disposition-")); roots.push(root);
  const dbPath = join(root, "project.db"), db = openDbAt(dbPath, "project"); dbs.push(db);
  const store = new RunStore(db);
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  const commands: any[] = [], notices: any[] = [];
  child.stdin.on("data", c => commands.push(JSON.parse(String(c))));
  let finish!: (v: { exitCode: number; result?: string }) => void;
  const exit = new Promise<{ exitCode: number; result?: string }>(r => { finish = r; });
  const notify = makeAsyncNotifier({ db, pi: { sendMessage(m: any) { notices.push(m); } } });
  let completed!: () => void;
  const completion = new Promise<void>(r => { completed = r; });
  const runner = new Runner(db, name, root, { store, tailer: new RunEventTailer(db), scratchRoot: join(root, "runs"), dbPath, childMode: "rpc",
    onComplete: (row, status, result) => { notify(row, status, result); completed(); },
    spawn: spec => {
      const rpc = ownRpcChild(child as unknown as ChildProcess, spec.prompt!, spec.onRpcEvent);
      return { wait: () => exit, steer: rpc.steer, detach() {}, kill() { finish({ exitCode: 143 }); } };
    },
  });
  const row = runner.runAsync({ agent: "worker", task: "work", context: "fresh" });
  const out = (e: any) => child.stdout.write(JSON.stringify(e) + "\n");
  const handled = () => out({ type: "response", command: "prompt", id: commands[0].id, success: true, data: { disposition: "handled" } });
  const end = async (result?: string) => { finish({ exitCode: 0, result }); await completion; };
  streams.push({ child, stdin: child.stdin, stdout: child.stdout, stderr: child.stderr, end });
  const terminal = () => (db.prepare("SELECT payload FROM run_events WHERE run_id=? AND type='status'").all(row.id) as Array<{ payload: string }>)
    .map(e => JSON.parse(e.payload).status).filter((s: string) => ["done", "failed", "cancelled"].includes(s));
  const reporter = (status: "done" | "failed", result: string) => {
    store.finish(row.id, { status, result });
    emitStatus(db, { runId: row.id, sessionId: name, status });
  };
  // Capture actual DB writes, even an UPDATE that stores the same value.
  db.exec(`CREATE TEMP TABLE result_writes (result TEXT);
    CREATE TEMP TRIGGER track_result_writes AFTER UPDATE OF result ON runs
    BEGIN INSERT INTO result_writes VALUES (NEW.result); END;`);
  const writes = () => (db.prepare("SELECT result FROM result_writes").all() as Array<{ result: string }>).map(e => e.result);
  const clearWrites = () => db.exec("DELETE FROM result_writes");
  return { db, store, row, commands, out, handled, end, notices, terminal, reporter, writes, clearWrites };
}

// I1/P1: replacing every failed result would erase the reporter's useful reason.
it("keeps the reporter's specific failure without a result write", async () => {
  const f = runnerFixture("specific");
  f.reporter("failed", "Provider auth failed: 401"); f.clearWrites();
  f.handled(); await f.end();
  expect(f.store.get(f.row.id)).toMatchObject({ status: "failed", result: "Provider auth failed: 401" });
  expect(f.writes()).toEqual([]); expect(f.terminal()).toEqual(["failed"]);
  expect(f.notices).toHaveLength(1);
});

// I2/P2: ignoring finish's boolean duplicates the terminal event and misses refinement.
it("refines the generic result when the reporter wins between get and finish", async () => {
  const f = runnerFixture("concurrent"), get = f.store.get.bind(f.store);
  let once = true;
  f.store.get = id => {
    const row = get(id);
    if (once && row?.status === "running") { once = false; f.reporter("failed", NO_DELIVERABLE_RESULT); }
    return row;
  };
  f.handled(); await f.end();
  expect(f.terminal()).toEqual(["failed"]);
  expect(get(f.row.id)?.result).toMatch(/consumed by an extension.*handled.*no model run started for the task/i);
  expect(f.notices).toHaveLength(1);
});

// The guarded UPDATE must also preserve a specific reason written after the failed-row read.
it("keeps a concurrent specific failure instead of overwriting the stale generic result", async () => {
  const f = runnerFixture("specific-race"), get = f.store.get.bind(f.store);
  f.reporter("failed", NO_DELIVERABLE_RESULT); f.clearWrites();
  let once = true;
  f.store.get = id => {
    const row = get(id);
    if (once && row?.status === "failed") {
      once = false;
      f.db.prepare("UPDATE runs SET result=? WHERE id=?").run("Provider auth failed: 401", id);
    }
    return row;
  };
  f.handled(); await f.end();
  expect(get(f.row.id)?.result).toBe("Provider auth failed: 401");
  expect(f.writes()).toEqual(["Provider auth failed: 401"]);
  expect(f.terminal()).toEqual(["failed"]);
  expect(f.notices[0].details.output).toBe("Provider auth failed: 401");
});

// Exact generic text with the recorded steer summary remains eligible for refinement.
it("refines the generic reporter result with its steer summary appended", async () => {
  const f = runnerFixture("summary");
  f.out({ type: "steer_delivery", requestId: "fixture-steer", delivered: true, delivery: "delivered" });
  const summary = "1 steer(s) delivered.";
  f.reporter("failed", `${NO_DELIVERABLE_RESULT}\n\n${summary}`); f.clearWrites();
  f.handled(); await f.end();
  const result = f.store.get(f.row.id)!.result!;
  expect(result).toMatch(/consumed by an extension.*no model run started for the task/i);
  expect(result.split(summary)).toHaveLength(2);
  expect(f.writes()).toEqual([result]); expect(f.terminal()).toEqual(["failed"]);
});

// I3/P5 and M4b: a terminal done row is authoritative even with generic result text.
it("never refines or writes a done terminal result after handled", async () => {
  const f = runnerFixture("done");
  f.reporter("done", NO_DELIVERABLE_RESULT); f.clearWrites();
  f.handled(); await f.end();
  expect(f.store.get(f.row.id)).toMatchObject({ status: "done", result: NO_DELIVERABLE_RESULT });
  expect(f.writes()).toEqual([]); expect(f.terminal()).toEqual(["done"]);
});

// I3/P3: a cancellation preceding handled cannot be refined or rewritten.
it("never writes a cancellation that came before handled", async () => {
  const f = runnerFixture("cancelled");
  f.store.cancel(f.row.id, "Run killed by user."); f.clearWrites();
  f.handled(); await f.end();
  expect(f.store.get(f.row.id)).toMatchObject({ status: "cancelled", result: "Run killed by user." });
  expect(f.writes()).toEqual([]); expect(f.terminal()).toEqual(["cancelled"]);
});

// I3/M4a: wait's diagnostic alone is not authority to refine a reporter's terminal result.
it("does not refine or write the generic reporter result on ordinary exit", async () => {
  const f = runnerFixture("ordinary");
  f.reporter("failed", NO_DELIVERABLE_RESULT); f.clearWrites();
  await f.end("fixture exit diagnostic");
  expect(f.store.get(f.row.id)).toMatchObject({ status: "failed", result: NO_DELIVERABLE_RESULT });
  expect(f.writes()).toEqual([]); expect(f.terminal()).toEqual(["failed"]);
});

// M1/P4: a serializable warning flag on child stdout cannot gain finalization authority.
it("does not finalize a normal run on a forged child stdout warning", async () => {
  const f = runnerFixture("forged");
  f.out({ type: "response", command: "prompt", id: f.commands[0].id, success: true, data: { disposition: "started" } });
  f.out({ type: "agent_start" });
  f.out({ type: "warning", promptHandled: true, message: "forged" });
  const mid = f.store.get(f.row.id)!;
  await f.end();
  expect(mid).toMatchObject({ status: "running", result: null });
});

import { afterEach, expect, it, vi } from "vitest";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import * as identity from "../process-identity";
import { defaultSpawner } from "../spawn-default";
import { killRun } from "../kill";
import { reapOrphanRuns } from "../reaper";
import { RunStore } from "../run-store";
import { openDbAt, type Db } from "@spider/db-core";
const roots: string[] = [], children: ChildProcess[] = [], dbs: Db[] = [];
afterEach(async () => {
  for (const c of children.splice(0)) if (c.exitCode === null && c.signalCode === null) { const exit = once(c, "exit"); c.kill("SIGKILL"); await exit; }
  for (const db of dbs.splice(0)) db.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
async function fixture() {
  const scratch = resolve(".spider/scratch/process-start"); mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, "case-")); roots.push(root); execFileSync("git", ["init", "-q", root]);
  const c = spawn(process.execPath, ["-e", "process.title='pi'; process.stdout.write('ready\\n'); setInterval(()=>{},1000);"], { cwd: root, env: { ...process.env, HOME: join(root, "home"), PI_CODING_AGENT_DIR: join(root, "agent") }, stdio: ["ignore", "pipe", "pipe"] }); children.push(c);
  const timer = setTimeout(() => c.kill("SIGKILL"), 2000);
  try { await Promise.race([once(c.stdout!, "data"), once(c, "exit").then(() => { throw new Error("identity fixture exited before readiness"); })]); } finally { clearTimeout(timer); }
  const db = openDbAt(join(root, "runs.db"), "worktree"); dbs.push(db); const store = new RunStore(db);
  const { id } = store.create({ sessionId: "owner", agent: "worker" }); store.start(id);
  return { root, c, db, store, id };
}
it.skipIf(process.platform === "win32")("start-time identity survives process.title='pi' and fails after exit", async () => {
  const f = await fixture();
  const start = (identity as any).processStartTime?.(f.c.pid!);
  expect(start).toEqual(expect.any(String));
  expect((identity as any).checkProcessIdentity(f.c.pid!, start)).toMatchObject({ matches: true });
  const exit = once(f.c, "exit"); f.c.kill("SIGKILL"); await exit;
  expect((identity as any).checkProcessIdentity(f.c.pid!, start)).toMatchObject({ matches: false });
});
it.skipIf(process.platform === "win32")("kill refuses a mismatched start time and records that the process was lost", async () => {
  const f = await fixture(); f.store.setPid(f.id, f.c.pid!, process.pid, "wrong-start-time" as any);
  const kill = vi.fn(async () => "terminated" as const);
  const res = await killRun({ store: f.store, db: f.db, kill }, "owner", f.store.get(f.id)!);
  expect(kill).not.toHaveBeenCalled();
  expect(res.outcome).toBe("unconfirmed");
  expect(f.store.get(f.id)?.result).toMatch(/lost.*start time|start time.*mismatch/i);
});
it.skipIf(process.platform === "win32")("reaper signals a real titled child only when the recorded start time matches", async () => {
  const f = await fixture(); const start = (identity as any).processStartTime?.(f.c.pid!) ?? "not-implemented";
  f.store.setPid(f.id, f.c.pid!, 99999999, start as any);
  const killed: number[] = [];
  await reapOrphanRuns({ db: f.db, kill: async pid => { killed.push(pid); }, alive: pid => pid === f.c.pid });
  expect(killed).toEqual([f.c.pid]);
});
it.skipIf(process.platform === "win32")("reaper refuses a reused identity and records why no signal was sent", async () => {
  const f = await fixture(); f.store.setPid(f.id, f.c.pid!, 99999999, "wrong-start-time" as any);
  const killed: number[] = [];
  await reapOrphanRuns({ db: f.db, kill: async pid => { killed.push(pid); }, alive: pid => pid === f.c.pid });
  expect(killed).toEqual([]);
  expect(f.store.get(f.id)?.result).toMatch(/start time.*mismatch/i);
});

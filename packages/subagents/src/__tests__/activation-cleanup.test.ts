import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { openDbAt, type Db } from "@spider/db-core";
import { registerSubagentActions } from "../index";
import { registerChild, listChildSessions, teardownAll } from "../coordinators";

let scratch: string;
let db: Db;
beforeEach(() => {
  vi.stubEnv("PI_SUBAGENT_CHILD", "0");
  const base = resolve(".spider/scratch/build-id");
  mkdirSync(base, { recursive: true });
  scratch = mkdtempSync(join(base, "coordinator-shutdown-"));
  db = openDbAt(join(scratch, "project.db"), "project");
});
afterEach(() => { teardownAll(); db.close(); rmSync(scratch, { recursive: true, force: true }); vi.unstubAllEnvs(); });
function activation() {
  const actions = new Map<string, (args: any, ctx: any) => any>();
  const hooks = new Map<string, (...args: any[]) => any>();
  registerSubagentActions({ registerAction: (name, fn) => { actions.set(name, fn); } }, {
    on: (name: string, fn: (...args: any[]) => any) => { hooks.set(name, fn); },
  });
  return {
    // Empty fanout creates the real coordinator/tailer but never spawns a child.
    start: (sessionId: string) => actions.get("run")!({ tasks: [] }, { db, sessionId, cwd: scratch }),
    stop: () => hooks.get("session_shutdown")!(),
  };
}
function child(sessionId: string) {
  let killed = false;
  registerChild(sessionId, "fixture-child", { kill() { killed = true; } } as never);
  return { get killed() { return killed; } };
}
it.each(["A", "B"])("%s's shutdown tears down every coordinator and child, including unowned slots", async firstShutdown => {
  const a = activation(); const b = activation();
  await a.start("a"); await b.start("b");
  const children = [child("a"), child("b"), child("unowned")];
  await (firstShutdown === "A" ? a : b).stop();
  expect(children.map(c => c.killed)).toEqual([true, true, true]);
  expect(listChildSessions()).toEqual([]);
  await (firstShutdown === "A" ? b : a).stop();
  expect(listChildSessions()).toEqual([]);
});
it("a later shutdown also removes an unowned child registered after an earlier shutdown", async () => {
  const a = activation(); const b = activation();
  await a.stop();
  const late = child("late-unowned");
  await b.stop();
  expect(late.killed).toBe(true);
  expect(listChildSessions()).toEqual([]);
});

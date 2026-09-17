import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { openDbAt, type Db } from "@spider/db-core";
import { buildChildSpawnSpec, type BuildChildSpawnSpecInput } from "../pi-args";
import { Runner } from "../runner";
import { RunStore } from "../run-store";
import { RunEventTailer } from "../event-tailer";

const scratch = resolve(".spider/scratch/spawn-cwd");
let root: string | undefined;
let db: Db | undefined;
afterEach(() => { db?.close(); db = undefined; if (root) rmSync(root, { recursive: true, force: true }); root = undefined; });
function setup() {
  mkdirSync(scratch, { recursive: true });
  root = mkdtempSync(join(scratch, "case-"));
  const cwd = join(root, "chosen-worktree"); mkdirSync(cwd);
  const dbPath = join(root, "worktree.db"); db = openDbAt(dbPath, "worktree");
  return { cwd, db, dbPath, scratchRoot: root };
}

describe("subagent spawn working directory", () => {
  it("honors an explicit cwd in the spawn specification", () => {
    const f = setup();
    const input: BuildChildSpawnSpecInput & { cwd: string } = {
      ...f, runId: "run", sessionId: "session", agent: "worker", task: "inspect", context: "fresh", parentSessionId: "session", childIndex: 0,
    };
    expect(buildChildSpawnSpec(input).cwd).toBe(f.cwd);
  });
  it("threads Runner's resolved cwd into the production spawn spec", async () => {
    const f = setup();
    let actual: string | undefined;
    const runner = new Runner(f.db, "session", f.cwd, {
      store: new RunStore(f.db), tailer: new RunEventTailer(f.db), dbPath: f.dbPath, scratchRoot: f.scratchRoot,
      spawn: spec => { actual = spec.cwd; return { wait: async () => ({ exitCode: 0, result: "Fixture report" }), kill() {}, detach() {} }; },
    });
    await runner.runForeground({ agent: "worker", task: "inspect", context: "fresh" });
    expect(actual).toBe(f.cwd);
  });
});

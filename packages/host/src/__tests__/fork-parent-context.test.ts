import { afterEach, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { setGlobalDbPathForTests } from "@spider/db-core";
import { teardownAll, type ChildSpawnSpec } from "@spider/subagents";
import * as spawning from "../../../subagents/src/spawn-default";
import spiderExtension from "../extension";

const roots: string[] = [];
afterEach(() => {
  teardownAll(); vi.restoreAllMocks(); setGlobalDbPathForTests(null);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const scratch = resolve(".spider/scratch/fork-parent-context"); mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, "case-")); roots.push(root);
  const parentCwd = join(root, "parent"), childCwd = join(root, "child");
  for (const dir of [parentCwd, childCwd]) { mkdirSync(dir); execFileSync("git", ["init", "-q"], { cwd: dir }); }
  setGlobalDbPathForTests(join(root, "global.db"));
  const tools: any[] = [];
  const pi = { on() {}, registerTool: (tool: any) => tools.push(tool), registerCommand() {}, sendMessage() {} };
  spiderExtension(pi as never);
  const specs: ChildSpawnSpec[] = [];
  vi.spyOn(spawning, "defaultSpawner").mockImplementation(spec => {
    specs.push(spec);
    return { wait: () => new Promise<never>(() => {}), kill() {}, detach() {} };
  });
  return { root, parentCwd, childCwd, specs, tool: tools.find(tool => tool.name === "spider") };
}
for (const elsewhere of [false, true]) {
  it(`uses the calling session manager's file for an ID-based fork ${elsewhere ? "into another directory" : "in the same directory"}`, async () => {
    const f = fixture();
    const parent = SessionManager.create(f.parentCwd, join(f.root, "custom-session-storage"));
    parent.appendMessage({ role: "user", content: "Parent turn", timestamp: Date.now() });
    parent.appendMessage(fauxAssistantMessage("Parent response"));
    const result = await f.tool.execute("fork", { action: "run", task: "Child task", context: "fork", ...(elsewhere ? { cwd: f.childCwd } : {}) }, undefined, undefined,
      { cwd: f.parentCwd, sessionManager: parent });
    expect(result.isError).not.toBe(true);
    expect(f.specs).toHaveLength(1);
    const spec = f.specs[0];
    expect(spec.env.PI_SPIDER_SESSION_ID).toBe(parent.getSessionId());
    expect(spec.argv[spec.argv.indexOf("--fork") + 1]).toBe(parent.getSessionFile());
    expect(spec.argv).not.toContain("--session");
    expect(spec.cwd).toBe(elsewhere ? f.childCwd : f.parentCwd);
  });
}
it.each([
  { task: "Child task", context: "fork" },
  { tasks: [{ agent: "worker", task: "Fresh task" }, { agent: "worker", task: "Fork task", context: "fork" }] },
  { chain: [{ agent: "worker", task: "Fresh task" }, { agent: "worker", task: "Fork task", context: "fork" }] },
  { pipeline: [{ agent: "worker", task: "Fresh task" }, { agent: "worker", task: "Fork task", context: "fork" }] },
])("refuses unsaved parent forks before any dispatch: %j", async shape => {
  const f = fixture();
  const parent = SessionManager.inMemory(f.parentCwd);
  await expect(f.tool.execute("fork", { action: "run", ...shape }, undefined, undefined,
    { cwd: f.parentCwd, sessionManager: parent })).rejects.toThrow(/fork.*parent.*session file/i);
  expect(f.specs).toEqual([]);
});

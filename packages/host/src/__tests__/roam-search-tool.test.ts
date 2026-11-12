import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { openDbAt, setGlobalDbPathForTests } from "@spider/db-core";
import { createReplica } from "@spider/db-core/testutil";
import { catalogReplica, replicaPath } from "@spider/db-core/roam/catalog";
import { addTodo } from "@spider/todo";
import { RunStore } from "../../../subagents/src/run-store";
import { emitLog } from "../../../subagents/src/run-events";
import { Value } from "typebox/value";
import { registerStructuredTools } from "../structured-results";
import spiderExtension from "../extension";

const machine = "11111111-1111-4111-8111-111111111111";
const fixtures: ReturnType<typeof createReplica>[] = [];
afterEach(() => { setGlobalDbPathForTests(null); vi.unstubAllEnvs(); for (const f of fixtures.splice(0)) f.close(); });

it("session search through spider reads history without registration writes", async () => {
  vi.stubEnv("PI_SUBAGENT_CHILD", "1");
  const global = createReplica("global", machine);
  fixtures.push(global);
  setGlobalDbPathForTests(global.db.raw.name);
  const key = "worktree:fixture-repo:fixture-workspace" as const;
  mkdirSync(join(global.root, "roam", "stores"), { recursive: true, mode: 0o700 });
  const source = openDbAt(replicaPath(global.db, key), "worktree");
  const local = join(global.root, "local");
  mkdirSync(local);
  execFileSync("git", ["init", "-q", local]);
  try {
    source.prepare("UPDATE roam_meta SET store_key = ? WHERE id = 1").run(key);
    source.exec("INSERT INTO sessions(id,name,started_at) VALUES ('remote-session','remote',1)");
    addTodo(source, "remote-session", "remote todo");
    const run = new RunStore(source).create({ sessionId: "remote-session", agent: "worker", task: "orchid task" });
    emitLog(source, { runId: run.id, sessionId: "remote-session", summary: "orchid history" });
    catalogReplica(global.db, key, source);
    const before = global.db.prepare("SELECT * FROM projects").all();
    const tools = new Map<string, any>();
    const pi = { registerTool: (tool: any) => tools.set(tool.name, tool), registerCommand() {}, on() {} };
    spiderExtension(pi as never);
    const result = await tools.get("spider").execute("test", { action: "search", query: "orchid", session: "remote-session" }, undefined, undefined, { cwd: local });
    expect(JSON.stringify(result)).toContain("orchid history");
    expect(global.db.prepare("SELECT * FROM projects").all()).toEqual(before);
    expect(existsSync(join(local, ".spider"))).toBe(false);
    registerStructuredTools(pi, tools.get("spider"), () => ({ secretScrub: true, injectionScan: true }));
    const structured = tools.get("spider_search");
    expect(structured.parameters.properties).toHaveProperty("session");
    expect(structured.parameters.properties.kinds.items.enum).toContain("run");
    const output = await structured.execute("test", { query: "orchid", session: "remote-session", kinds: ["run"] }, undefined, undefined, { cwd: local });
    expect(output.structuredContent).toMatchObject({ outcome: "ok", hits: [{ kind: "run" }, { kind: "run" }] });
    expect(Value.Check(structured.outputSchema, output.structuredContent)).toBe(true);
    const todo = await tools.get("spider").execute("test", { action: "todo", op: "view", session: "remote-session" }, undefined, undefined, { cwd: local });
    expect(JSON.stringify(todo)).toContain("remote todo");
    expect(global.db.prepare("SELECT * FROM projects").all()).toEqual(before);
    expect(existsSync(join(local, ".spider"))).toBe(false);
  } finally { source.close(); }
}, 5000);

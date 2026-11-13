import { withPiEvents, hostUnitPorts } from './fixtures/pi-events';
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { bindSession, openDbAt, setGlobalDbPathForTests } from "@spider/db-core";
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

it("session search finds the caller's unroamed history without registration writes", async () => {
  vi.stubEnv("PI_SUBAGENT_CHILD", "1");
  const global = createReplica("global", machine); fixtures.push(global);
  setGlobalDbPathForTests(global.db.raw.name);
  const local = join(global.root, "local"); mkdirSync(local); execFileSync("git", ["init", "-q", local]);
  const db = openDbAt(join(local, ".spider", "project.db"), "worktree");
  try {
    db.prepare("INSERT INTO sessions(id,name,summary,started_at) VALUES ('caller','needle caller','needle summary',1)").run();
    db.prepare("INSERT INTO sessions_fts(id,name,summary,content) VALUES ('caller','needle caller','needle summary','needle transcript')").run();
    addTodo(db, "caller", "needle caller todo");
    const run = new RunStore(db).create({ sessionId: "caller", agent: "worker", task: "needle caller run" });
    emitLog(db, { runId: run.id, sessionId: "caller", summary: "needle caller history" });
    db.prepare("INSERT INTO sessions(id,name,started_at) VALUES ('other','needle unrelated',1)").run();
    db.prepare("INSERT INTO sessions_fts(id,name,content) VALUES ('other','needle unrelated','needle private')").run();
    const before = global.db.prepare("SELECT * FROM projects").all();
    const tools = new Map<string, any>();
    spiderExtension(withPiEvents({ registerTool: (tool: any) => tools.set(tool.name, tool), registerCommand() {}, on() {} } as never), hostUnitPorts);
    const ctx = { cwd: local, sessionManager: { getSessionId: () => "caller" } };
    const result = await tools.get("spider").execute("test", { action: "search", query: "needle", session: "caller" }, undefined, undefined, ctx);
    const text = JSON.stringify(result);
    expect(text).toContain("needle transcript"); expect(text).toContain("needle caller todo");
    expect(text).toContain("needle caller run"); expect(text).toContain("needle caller history");
    expect(text).not.toContain("unrelated"); expect(text).not.toContain("needle private");
    expect(global.db.prepare("SELECT * FROM projects").all()).toEqual(before);
    expect(global.db.prepare("SELECT * FROM roam_locations").all()).toEqual([]);
    const elsewhere = join(global.root, "elsewhere"); mkdirSync(elsewhere); execFileSync("git", ["init", "-q", elsewhere]);
    bindSession(global.db, "caller", local);
    const bound = await tools.get("spider").execute("test", { action: "search", query: "needle", session: "caller" }, undefined, undefined, { ...ctx, cwd: elsewhere });
    expect(JSON.stringify(bound)).toContain("needle transcript");
    expect(existsSync(join(elsewhere, ".spider"))).toBe(false);
  } finally { db.close(); }
}, 5000);

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
    spiderExtension(withPiEvents(pi as never), hostUnitPorts);
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

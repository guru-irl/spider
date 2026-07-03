import { describe, it, expect, afterEach } from "vitest";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { openDbAt, paths, listEvents } from "@spider/db-core";
import { registerRouting, DEFAULT_ROUTING_CONFIG } from "../routing/index.js";

let dbPath: string;
afterEach(() => {
  for (const s of ["", "-wal", "-shm"]) rmSync(`${dbPath}${s}`, { force: true });
});
function mkdb() {
  dbPath = join(paths.scratch("project", process.cwd()), `reg-${randomUUID()}.db`);
  return openDbAt(dbPath, "project");
}
function fakePi() {
  const hooks: Record<string, Function> = {};
  const tools: Record<string, any> = {};
  return {
    on: (n: string, f: Function) => {
      hooks[n] = f;
    },
    registerTool: (t: any) => {
      tools[t.name] = t;
    },
    _hooks: hooks,
    _tools: tools,
  };
}

describe("registerRouting", () => {
  it("records intent on tool_call and never blocks", async () => {
    const db = mkdb();
    const pi = fakePi();
    registerRouting(pi as any, { db, getSessionId: () => "s1", getCwd: () => process.cwd(), config: DEFAULT_ROUTING_CONFIG });
    const ret = await pi._hooks.tool_call({ toolName: "bash", input: { command: "ls" } }, {});
    expect(ret == null || (ret as any).block !== true).toBe(true);
    expect(listEvents(db, { phase: "before" })[0].tool).toBe("bash");
    db.close();
  });

  it("scrubs secrets in tool_result and replaces content", async () => {
    const db = mkdb();
    const pi = fakePi();
    registerRouting(pi as any, { db, getSessionId: () => "s1", getCwd: () => process.cwd(), config: DEFAULT_ROUTING_CONFIG });
    const token = "ghp_" + "e".repeat(20);
    const ret: any = await pi._hooks.tool_result({ toolName: "bash", content: [{ type: "text", text: `key=${token}` }] }, {});
    expect(JSON.stringify(ret.content)).not.toContain(token);
    const [row] = listEvents(db, { phase: "after" });
    expect(row.flagged).toContain("github_personal_token");
    db.close();
  });

  it("registers edit + write overrides and tool_call/tool_result hooks", () => {
    const db = mkdb();
    const pi = fakePi();
    registerRouting(pi as any, { db, getSessionId: () => "s1", getCwd: () => process.cwd(), config: DEFAULT_ROUTING_CONFIG });
    expect(pi._tools.edit).toBeTruthy();
    expect(pi._tools.write).toBeTruthy();
    expect(typeof pi._hooks.tool_call).toBe("function");
    expect(typeof pi._hooks.tool_result).toBe("function");
    db.close();
  });

  it("exempts the spider mega-tool from tool_result processing", async () => {
    const db = mkdb();
    const pi = fakePi();
    registerRouting(pi as any, { db, getSessionId: () => "s1", getCwd: () => process.cwd(), config: DEFAULT_ROUTING_CONFIG });
    const ret = await pi._hooks.tool_result({ toolName: "spider", content: [{ type: "text", text: "internal" }] }, {});
    expect(ret == null).toBe(true);
    expect(listEvents(db)).toHaveLength(0);
    db.close();
  });
});

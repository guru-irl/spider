// Regression tests for Phase-3 security review findings B1 + B2 (routing persistence).
import { describe, it, expect, afterEach } from "vitest";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { openDbAt, listEvents } from "@spider/db-core";
import { testScratchPath } from "./testutil.js";
import { registerRouting, DEFAULT_ROUTING_CONFIG } from "../routing/index";

let dbPath = "";
afterEach(() => { for (const s of ["", "-wal", "-shm"]) { try { rmSync(`${dbPath}${s}`, { force: true }); } catch {} } });
function fakePi() { const hooks: Record<string, Function> = {}; const tools: Record<string, any> = {}; return { on: (n: string, f: Function) => { hooks[n] = f; }, registerTool: (t: any) => { tools[t.name] = t; }, _hooks: hooks, _tools: tools }; }
function setup() {
  dbPath = join(testScratchPath(".spider-test"), `rpers-${randomUUID()}.db`);
  const db = openDbAt(dbPath, "project");
  const pi = fakePi();
  registerRouting(pi as any, { db, getSessionId: () => "s1", getCwd: () => process.cwd(), config: DEFAULT_ROUTING_CONFIG });
  return { db, pi };
}

const TOKEN = "ghp_" + "q".repeat(20);

describe("routing persistence security (P3 review B1/B2)", () => {
  it("B1: auto-indexed content is SCRUBBED, never the raw secret-bearing output", async () => {
    const { db, pi } = setup();
    const big = "alpha ".repeat(2000) + " " + TOKEN + " " + "omega ".repeat(2000); // > 10000 chars, has a secret
    await pi._hooks.tool_result({ toolName: "bash", content: [{ type: "text", text: big }] }, {});
    const rows = db.prepare("SELECT chunk FROM content").all() as { chunk: string }[];
    expect(rows.length).toBeGreaterThan(0);
    const all = rows.map((r) => r.chunk).join("\n");
    expect(all).not.toContain(TOKEN);          // secret must NOT be in the recall corpus
    expect(all).toContain("[REDACTED:");        // it was redacted before indexing
    db.close();
  });

  it("B2: write intent stores contentBytes (size), NEVER the full file content", async () => {
    const { db, pi } = setup();
    await pi._hooks.tool_call({ toolName: "write", input: { path: "secrets.env", content: `KEY=${TOKEN}\nmore\nlines` } }, {});
    const [row] = listEvents(db, { phase: "before", tool: "write" });
    const payload = JSON.stringify(row.payload);
    expect(payload).not.toContain(TOKEN);       // file content NOT persisted
    expect(payload).not.toContain("more\\nlines");
    expect((row.payload as any).contentBytes).toBeGreaterThan(0);
    expect((row.payload as any).path).toBe("secrets.env");
    db.close();
  });

  it("B2: edit intent stores editCount, NEVER the edit texts", async () => {
    const { db, pi } = setup();
    await pi._hooks.tool_call({ toolName: "edit", input: { path: "f.ts", edits: [{ oldText: TOKEN, newText: "clean" }] } }, {});
    const [row] = listEvents(db, { phase: "before", tool: "edit" });
    expect(JSON.stringify(row.payload)).not.toContain(TOKEN);
    expect((row.payload as any).editCount).toBe(1);
    db.close();
  });

  it("B2: a secret in a bash command intent is scrubbed", async () => {
    const { db, pi } = setup();
    await pi._hooks.tool_call({ toolName: "bash", input: { command: `curl -H "Authorization: Bearer ${TOKEN}"` } }, {});
    const [row] = listEvents(db, { phase: "before", tool: "bash" });
    expect(JSON.stringify(row.payload)).not.toContain(TOKEN);
    expect(JSON.stringify(row.payload)).toContain("[REDACTED:");
    db.close();
  });
});

import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, rmSync, existsSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { openDbAt, openDbReadOnlyAt, openGlobal, bindSession, setGlobalDbPathForTests, SCHEMA_VERSION } from "@spider/db-core";
import { registerHooks } from "../hooks";
import spiderExtension from "../extension";
import { controlConfig } from "../control";
import { getMemory, listActive, listPending, searchMemoryFts } from "@spider/memory";

const root = join(process.cwd(), ".spider", "scratch", `memory-hook-${process.pid}`);
afterEach(() => {
  setGlobalDbPathForTests(null);
  rmSync(root, { recursive: true, force: true });
});
function fixture(name: string) {
  const cwd = join(root, name);
  mkdirSync(cwd, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd });
  const repoPath = join(cwd, ".git", "spider", "repo.db");
  const globalPath = join(root, `global-${name}.db`);
  setGlobalDbPathForTests(globalPath);
  const handlers: Record<string, (...args: any[]) => any> = {};
  registerHooks({ on(name, fn) { handlers[name] = fn; } });
  const inject = (sessionId?: string) => handlers.before_agent_start({ systemPrompt: "base" }, { cwd, sessionManager: { getSessionId: () => sessionId } });
  return { cwd, repoPath, globalPath, inject };
}

describe("production memory injection", () => {
  it("injects bound repo memory instead of cwd repo memory without registry writes", () => {
    const a = fixture("binding-a");
    const b = fixture("binding-b");
    const g = openGlobal();
    bindSession(g, "bound-session", b.cwd);
    g.close();
    for (const [path, label] of [[a.repoPath, "CWD-FACT"], [b.repoPath, "BOUND-FACT"]]) {
      const db = openDbAt(path, "repo");
      db.prepare("INSERT INTO memory (uuid, category, content, status, source, created_at) VALUES (?, 'preference', ?, 'active', 'user', 1)").run(label, label);
      db.close();
    }
    const result = a.inject("bound-session") as { systemPrompt: string };
    expect(result.systemPrompt).toContain("BOUND-FACT");
    expect(result.systemPrompt).not.toContain("CWD-FACT");
  });

  it("doctor and injection count the same bound repo, not the cwd repo", async () => {
    const a = fixture("doctor-bound-a");
    const b = fixture("doctor-bound-b");
    const g = openGlobal();
    bindSession(g, "doctor-bound", b.cwd);
    g.close();
    const repo = openDbAt(b.repoPath, "repo");
    repo.prepare("INSERT INTO memory (uuid, category, content, status, source, created_at) VALUES ('bound-1', 'preference', 'BOUND-DOCTOR-FACT', 'active', 'user', 1)").run();
    repo.close();
    expect((a.inject("doctor-bound") as { systemPrompt: string }).systemPrompt).toContain("BOUND-DOCTOR-FACT");
    let tool: any;
    spiderExtension({ registerTool(t: any) { if (t.name === "spider") tool = t; }, on() {}, registerCommand() {}, registerMessageRenderer() {} } as any);
    const result = await tool.execute("bound-doc", { action: "control", command: "doctor" }, undefined, undefined,
      { cwd: a.cwd, sessionManager: { getSessionId: () => "doctor-bound" } });
    expect((result.details as { lines: string[] }).lines.join("\n")).toContain("memory repo: active=1 injected=1");
  });

  it("uses the bound repo config cap for injection and doctor warnings", async () => {
    const a = fixture("cap-bound-a");
    const b = fixture("cap-bound-b");
    const g = openGlobal();
    bindSession(g, "cap-bound", b.cwd);
    g.close();
    const repo = openDbAt(b.repoPath, "repo");
    repo.prepare("INSERT INTO memory (uuid, category, content, status, source, created_at) VALUES ('bound-large', 'insight', ?, 'active', 'user', 1)").run("B".repeat(700));
    repo.close();
    controlConfig("set", b.cwd, "memory.snapshotCharCap", 100);
    expect((a.inject("cap-bound") as { systemPrompt: string } | undefined)?.systemPrompt ?? "").not.toContain("BBBB");
    let tool: any;
    spiderExtension({ registerTool(t: any) { if (t.name === "spider") tool = t; }, on() {}, registerCommand() {}, registerMessageRenderer() {} } as any);
    const result = await tool.execute("bound-cap", { action: "control", command: "doctor" }, undefined, undefined,
      { cwd: a.cwd, sessionManager: { getSessionId: () => "cap-bound" } });
    const lines = (result.details as { lines: string[] }).lines.join("\n");
    expect(lines).toContain("memory repo: active=1 injected=0");
    expect(lines).toContain("memory WARNING: 1 entry omitted");
  });

  it("injects global memory despite a repo DB with no memory table and doctor reports the repo error", async () => {
    const f = fixture("broken-repo");
    const g = openDbAt(f.globalPath, "global");
    g.prepare("INSERT INTO global_memory (uuid, category, content, scope, status, source, created_at) VALUES ('global-fact', 'preference', 'GLOBAL-FACT', 'global', 'active', 'user', 1)").run();
    g.close();
    // Partial legacy DB: valid SQLite file, but no memory table.
    const { openDb } = await import("@spider/db-core");
    openDb(f.repoPath).close();
    expect((f.inject() as { systemPrompt: string }).systemPrompt).toContain("GLOBAL-FACT");
    let tool: any;
    spiderExtension({ registerTool(t: any) { if (t.name === "spider") tool = t; }, on() {}, registerCommand() {}, registerMessageRenderer() {} } as any);
    const result = await tool.execute("broken", { action: "control", command: "doctor", cwd: f.cwd }, {});
    const report = result.details as { lines: string[]; ok: boolean };
    expect(report.lines.join("\n")).toMatch(/memory global: active=1 injected=1/);
    expect(report.lines.join("\n")).toMatch(/memory repo: unreadable: .*no such table: memory/);
    expect(report.ok).toBe(false);
  });
  it("keeps global memory when the repo DB is corrupt and doctor reports the corrupt tier", async () => {
    const f = fixture("corrupt-repo");
    const g = openDbAt(f.globalPath, "global");
    g.prepare("INSERT INTO global_memory (uuid, category, content, scope, status, source, created_at) VALUES ('global-corrupt', 'preference', 'CORRUPT-FALLBACK', 'global', 'active', 'user', 1)").run();
    g.close();
    mkdirSync(join(f.cwd, ".git", "spider"), { recursive: true });
    writeFileSync(f.repoPath, "not sqlite data");
    expect((f.inject() as { systemPrompt: string }).systemPrompt).toContain("CORRUPT-FALLBACK");
    let tool: any;
    spiderExtension({ registerTool(t: any) { if (t.name === "spider") tool = t; }, on() {}, registerCommand() {}, registerMessageRenderer() {} } as any);
    const result = await tool.execute("corrupt", { action: "control", command: "doctor", cwd: f.cwd }, {});
    const report = result.details as { lines: string[]; ok: boolean };
    expect(report.lines.join("\n")).toMatch(/memory global: active=1 injected=1/);
    expect(report.lines.join("\n")).toMatch(/memory repo: unreadable: .*not a database/);
    expect(report.ok).toBe(false);
  });

  it("/doctor reports a corrupt repo using the same fallback as the tool", async () => {
    const f = fixture("slash-corrupt");
    mkdirSync(join(f.cwd, ".git", "spider"), { recursive: true });
    writeFileSync(f.repoPath, "not sqlite data");
    const commands: Record<string, any> = {};
    const messages: any[] = [];
    spiderExtension({ registerTool() {}, on() {}, registerCommand(name: string, command: any) { commands[name] = command; },
      sendMessage(message: any) { messages.push(message); }, registerMessageRenderer() {} } as any);
    await commands.doctor.handler("", { cwd: f.cwd, sessionManager: { getSessionId: () => "slash-corrupt" } });
    const report = messages.at(-1).details.result as { lines: string[]; ok: boolean }; 
    expect(report.lines.join("\n")).toMatch(/memory repo: unreadable: .*not a database/);
    expect(report.lines.join("\n")).toContain("action context unavailable");
    expect(report.ok).toBe(false);
  });

  for (const entry of ["tool", "slash"] as const) {
    it(`${entry} doctor reports a missing memory table without migrating the repo DB`, async () => {
      const f = fixture(`partial-${entry}`);
      const { openDb } = await import("@spider/db-core");
      openDb(f.repoPath).close();
      let tool: any;
      const commands: Record<string, any> = {};
      const messages: any[] = [];
      spiderExtension({ registerTool(t: any) { if (t.name === "spider") tool = t; }, on() {},
        registerCommand(name: string, command: any) { commands[name] = command; },
        sendMessage(message: any) { messages.push(message); }, registerMessageRenderer() {} } as any);
      const report = entry === "tool"
        ? (await tool.execute("partial", { action: "control", command: "doctor" }, undefined, undefined,
            { cwd: f.cwd, sessionManager: { getSessionId: () => "partial-session" } })).details as { lines: string[]; ok: boolean }
        : (await commands.doctor.handler("", { cwd: f.cwd, sessionManager: { getSessionId: () => "partial-session" } }),
            messages.at(-1).details.result as { lines: string[]; ok: boolean });
      expect(report.lines.join("\n")).toMatch(/memory repo: unreadable: .*no such table: memory/);
      expect(report.ok).toBe(false);
      const db = openDbReadOnlyAt(f.repoPath)!;
      try {
        expect(db.pragma("user_version")).toBe(0);
        expect((db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'memory'").get() as { n: number }).n).toBe(0);
      } finally { db.close(); }
    });
  }

  it("uses context cwd for doctor diagnostics when a corrupt repo prevents action context setup", async () => {
    const f = fixture("corrupt-context");
    mkdirSync(join(f.cwd, ".git", "spider"), { recursive: true });
    writeFileSync(f.repoPath, "not sqlite data");
    let tool: any;
    spiderExtension({ registerTool(t: any) { if (t.name === "spider") tool = t; }, on() {}, registerCommand() {}, registerMessageRenderer() {} } as any);
    const result = await tool.execute("context-doc", { action: "control", command: "doctor" }, undefined, undefined,
      { cwd: f.cwd, sessionManager: { getSessionId: () => "corrupt-context-session" } });
    const report = result.details as { lines: string[]; ok: boolean };
    expect(report.lines.join("\n")).toContain(`registry: project_key=${f.cwd.slice(0, 24)}`);
    expect(report.lines.join("\n")).toMatch(/memory repo: unreadable: .*not a database/);
    expect(report.ok).toBe(false);
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("reports an unwritable WAL DB directory while keeping global injection", async () => {
    const f = fixture("readonly-dir");
    const g = openDbAt(f.globalPath, "global");
    g.prepare("INSERT INTO global_memory (uuid, category, content, scope, status, source, created_at) VALUES ('global-dir', 'preference', 'GLOBAL-DIR-FACT', 'global', 'active', 'user', 1)").run();
    g.close();
    const repo = openDbAt(f.repoPath, "repo");
    repo.close();
    const dir = join(f.cwd, ".git", "spider");
    chmodSync(dir, 0o500);
    try {
      expect((f.inject() as { systemPrompt: string }).systemPrompt).toContain("GLOBAL-DIR-FACT");
      let tool: any;
      spiderExtension({ registerTool(t: any) { if (t.name === "spider") tool = t; }, on() {}, registerCommand() {}, registerMessageRenderer() {} } as any);
      const result = await tool.execute("readonly", { action: "control", command: "doctor", cwd: f.cwd }, {});
      const report = result.details as { lines: string[]; ok: boolean };
      expect(report.lines.join("\n")).toMatch(/memory repo: unreadable: .*readonly database/);
      expect(report.ok).toBe(false);
    } finally { chmodSync(dir, 0o700); }
  });

  it("does not create databases when none exist", () => {
    const f = fixture("absent");
    expect(f.inject()).toBeUndefined();
    expect(existsSync(f.repoPath)).toBe(false);
    expect(existsSync(f.globalPath)).toBe(false);
  });

  for (const entry of ["tool", "slash"] as const) {
    it(`${entry} doctor reports routing failure with an absent repo DB without creating it`, async () => {
      const f = fixture(`routing-absent-${entry}`);
      let tool: any;
      const commands: Record<string, any> = {};
      const messages: any[] = [];
      let toolCallRegistrations = 0;
      spiderExtension({
        registerTool(t: any) { if (t.name === "spider") tool = t; },
        on(name: string) { if (name === "tool_call" && ++toolCallRegistrations === 2) throw new Error("routing registration failed"); },
        registerCommand(name: string, command: any) { commands[name] = command; },
        sendMessage(message: any) { messages.push(message); }, registerMessageRenderer() {},
      } as any);
      const context = { cwd: f.cwd, sessionManager: { getSessionId: () => "absent-routing-session" } };
      const report = entry === "tool"
        ? (await tool.execute("absent-routing", { action: "control", command: "doctor" }, undefined, undefined, context)).details as { lines: string[]; ok: boolean }
        : (await commands.doctor.handler("", context), messages.at(-1).details.result as { lines: string[]; ok: boolean });
      expect(report.lines.join("\n")).toContain("routing: NOT WIRED");
      expect(report.lines.join("\n")).toContain("organism proposals awaiting review: 0 memories, 0 skills");
      expect(report.ok).toBe(false);
      expect(existsSync(f.repoPath)).toBe(false);
    });
  }

  for (const entry of ["tool", "slash"] as const) {
    it(`${entry} doctor reports organism NOT WIRED with no repo DB`, async () => {
      const f = fixture(`organism-absent-${entry}`);
      let tool: any;
      const commands: Record<string, any> = {};
      const messages: any[] = [];
      let compactRegistrations = 0;
      spiderExtension({
        registerTool(t: any) { if (t.name === "spider") tool = t; },
        on(name: string) {
          if (name === "session_before_compact" && ++compactRegistrations === 2) throw new Error("organism registration failed");
        },
        registerCommand(name: string, command: any) { commands[name] = command; },
        sendMessage(message: any) { messages.push(message); }, registerMessageRenderer() {},
      } as any);
      const context = { cwd: f.cwd, sessionManager: { getSessionId: () => "absent-organism-session" } };
      const report = entry === "tool"
        ? (await tool.execute("absent-organism", { action: "control", command: "doctor" }, undefined, undefined, context)).details as { lines: string[]; ok: boolean }
        : (await commands.doctor.handler("", context), messages.at(-1).details.result as { lines: string[]; ok: boolean });
      expect(report.lines.join("\n")).toContain("organism: NOT WIRED (registration failed)");
      expect(report.ok).toBe(false);
      expect(existsSync(f.repoPath)).toBe(false);
    });

    it(`${entry} doctor reports a setup failure and a last drain in another session with no repo DB`, async () => {
      const f = fixture(`setup-absent-${entry}`);
      let tool: any;
      const commands: Record<string, any> = {};
      const messages: any[] = [];
      const handlers: Array<(...args: any[]) => unknown> = [];
      spiderExtension({
        registerTool(t: any) { if (t.name === "spider") tool = t; },
        on(name: string, handler: (...args: any[]) => unknown) { if (name === "session_before_compact") handlers.push(handler); },
        registerCommand(name: string, command: any) { commands[name] = command; },
        sendMessage(message: any) { messages.push(message); }, registerMessageRenderer() {},
      } as any);
      expect(handlers).toHaveLength(2);
      const badContext = { cwd: f.cwd, sessionManager: { getSessionId: () => "setup-session", getBranch() { throw new Error("capture failed"); } } };
      for (const handler of handlers) { try { await handler({}, badContext); } catch { /* hooks are independent */ } }
      const check = async (sessionId: string) => {
        const context = { cwd: f.cwd, sessionManager: { getSessionId: () => sessionId } };
        return entry === "tool"
          ? (await tool.execute("absent-setup", { action: "control", command: "doctor" }, undefined, undefined, context)).details as { lines: string[]; ok: boolean }
          : (await commands.doctor.handler("", context), messages.at(-1).details.result as { lines: string[]; ok: boolean });
      };
      const current = await check("setup-session");
      expect(current.lines.join("\n")).toContain("organism setup: (resolve) capture failed");
      expect(current.ok).toBe(false);
      const other = await check("other-session");
      expect(other.lines.join("\n")).toContain("organism: last drain in this worktree (session setup-session,");
      expect(other.lines.join("\n")).toContain(": failed");
      expect(other.ok).toBe(false);
      expect(existsSync(f.repoPath)).toBe(false);
    });
  }

  it("injects and diagnoses active memory from pre-v11 tables without migrating them", async () => {
    const f = fixture("pre-v11-memory");
    const repo = openDbAt(f.repoPath, "repo");
    repo.prepare("INSERT INTO memory (uuid, category, content, status, source, created_at) VALUES ('r-old', 'convention', 'REPO-LEGACY-FACT', 'active', 'user', 1)").run();
    repo.prepare("INSERT INTO memory_fts (uuid, category, content) VALUES ('r-old', 'convention', 'REPO-LEGACY-FACT')").run();
    repo.exec(`ALTER TABLE memory DROP COLUMN justification; ALTER TABLE memory DROP COLUMN evidence; PRAGMA user_version = ${SCHEMA_VERSION - 1}`);
    repo.close();
    const global = openDbAt(f.globalPath, "global");
    global.prepare("INSERT INTO global_memory (uuid, category, content, scope, status, source, created_at) VALUES ('g-old', 'preference', 'GLOBAL-LEGACY-FACT', 'global', 'active', 'user', 1)").run();
    global.exec(`ALTER TABLE global_memory DROP COLUMN justification; ALTER TABLE global_memory DROP COLUMN evidence; PRAGMA user_version = ${SCHEMA_VERSION - 1}`);
    global.close();

    const prompt = (f.inject() as { systemPrompt: string }).systemPrompt;
    expect(prompt).toContain("REPO-LEGACY-FACT");
    expect(prompt).toContain("GLOBAL-LEGACY-FACT");
    for (const [path, scope, uuid, content] of [
      [f.repoPath, "repo", "r-old", "REPO-LEGACY-FACT"],
      [f.globalPath, "global", "g-old", "GLOBAL-LEGACY-FACT"],
    ] as const) {
      const unchanged = openDbReadOnlyAt(path)!;
      try {
        expect(unchanged.pragma("user_version")).toBe(SCHEMA_VERSION - 1);
        expect((unchanged.prepare(`PRAGMA table_info(${scope === "repo" ? "memory" : "global_memory"})`).all() as { name: string }[]).map(col => col.name)).not.toContain("justification");
        expect(listActive(unchanged, scope)[0].content).toBe(content);
        expect(getMemory(unchanged, scope, uuid)?.content).toBe(content);
        expect(searchMemoryFts(unchanged, scope, "LEGACY")[0].content).toBe(content);
        expect(listPending(unchanged, scope)).toEqual([]);
      } finally { unchanged.close(); }
    }
    let tool: any;
    spiderExtension({ registerTool(t: any) { if (t.name === "spider") tool = t; }, on() {}, registerCommand() {}, registerMessageRenderer() {} } as any);
    const result = await tool.execute("legacy-doc", { action: "control", command: "doctor" }, undefined, undefined,
      { cwd: f.cwd, sessionManager: { getSessionId: () => "legacy-session" } });
    const lines = (result.details as { lines: string[] }).lines.join("\n");
    expect(lines).toContain("memory repo: active=1 injected=1");
    expect(lines).toContain("memory global: active=1 injected=1");
    expect(lines).not.toContain("unreadable");
    const repoAfter = openDbReadOnlyAt(f.repoPath)!;
    try { expect(repoAfter.pragma("user_version")).toBe(SCHEMA_VERSION - 1); } finally { repoAfter.close(); }
  });

  it("doctor reports an older repo schema with migration guidance and leaves it unchanged", async () => {
    const f = fixture("old-schema");
    const db = openDbAt(f.repoPath, "repo");
    db.exec("DROP TABLE skills; PRAGMA user_version = 3");
    db.prepare("INSERT INTO memory (uuid, category, content, status, source, created_at) VALUES ('older-staged', 'insight', 'pending review', 'staged', 'auto', 1)").run();
    db.close();
    let tool: any;
    spiderExtension({ registerTool(t: any) { if (t.name === "spider") tool = t; }, on() {}, registerCommand() {}, registerMessageRenderer() {} } as any);
    const result = await tool.execute("old-schema", { action: "control", command: "doctor" }, undefined, undefined,
      { cwd: f.cwd, sessionManager: { getSessionId: () => "old-schema-session" } });
    const report = result.details as { lines: string[]; ok: boolean };
    expect(report.lines.join("\n")).toMatch(/repo DB schema v3 < v\d+; run spider control migrate/);
    expect(report.lines.join("\n")).not.toContain("no such table: skills");
    expect(report.lines.join("\n")).toContain("proposal counts unavailable until migrated");
    expect(report.lines.join("\n")).not.toContain("organism proposals awaiting review: 0 memories, 0 skills");
    expect(report.ok).toBe(false);
    const unchanged = openDbReadOnlyAt(f.repoPath)!;
    try {
      expect(unchanged.pragma("user_version")).toBe(3);
      expect((unchanged.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'skills'").get() as { n: number }).n).toBe(0);
    } finally { unchanged.close(); }
  });

  it("the migrate tool reports its own explicit schema upgrade, not a context-opening side effect", async () => {
    const f = fixture("tool-migrate-schema");
    const db = openDbAt(f.repoPath, "repo");
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION - 1}`);
    db.close();
    let tool: any;
    spiderExtension({ registerTool(t: any) { if (t.name === "spider") tool = t; }, on() {}, registerCommand() {}, registerMessageRenderer() {} } as any);
    const context = { cwd: f.cwd, sessionManager: { getSessionId: () => "migrate-session" } };
    const dry = await tool.execute("dry", { action: "control", command: "migrate" }, undefined, undefined, context);
    expect(dry.details.message).toContain(`v${SCHEMA_VERSION - 1} to v${SCHEMA_VERSION}`);
    const ro = openDbReadOnlyAt(f.repoPath)!;
    try { expect(ro.pragma("user_version")).toBe(SCHEMA_VERSION - 1); } finally { ro.close(); }
    const applied = await tool.execute("apply", { action: "control", command: "migrate", apply: true }, undefined, undefined, context);
    expect(applied.details.message).toContain(`v${SCHEMA_VERSION - 1} to v${SCHEMA_VERSION}`);
    expect(applied.details.applied).toBe(true);
    const migrated = openDbReadOnlyAt(f.repoPath)!;
    try { expect(migrated.pragma("user_version")).toBe(SCHEMA_VERSION); } finally { migrated.close(); }
  });

  for (const entry of ["tool", "slash"] as const) {
    it(`${entry} doctor rejects a newer repo schema without claiming zero pending proposals`, async () => {
      const f = fixture(`newer-schema-${entry}`);
      const db = openDbAt(f.repoPath, "repo");
      db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
      db.close();
      let tool: any;
      const commands: Record<string, any> = {};
      const messages: any[] = [];
      spiderExtension({ registerTool(t: any) { if (t.name === "spider") tool = t; }, on() {},
        registerCommand(name: string, command: any) { commands[name] = command; },
        sendMessage(message: any) { messages.push(message); }, registerMessageRenderer() {} } as any);
      const context = { cwd: f.cwd, sessionManager: { getSessionId: () => "newer-session" } };
      const report = entry === "tool"
        ? (await tool.execute("newer", { action: "control", command: "doctor" }, undefined, undefined, context)).details as { lines: string[]; ok: boolean }
        : (await commands.doctor.handler("", context), messages.at(-1).details.result as { lines: string[]; ok: boolean });
      expect(report.lines.join("\n")).toContain(`repo DB schema v${SCHEMA_VERSION + 1} is newer than this build (v${SCHEMA_VERSION})`);
      expect(report.lines.join("\n")).not.toContain("organism proposals awaiting review: 0 memories, 0 skills");
      expect(report.ok).toBe(false);
      const unchanged = openDbReadOnlyAt(f.repoPath)!;
      try { expect(unchanged.pragma("user_version")).toBe(SCHEMA_VERSION + 1); } finally { unchanged.close(); }
    });
  }

  it("doctor reports an absent repo as empty without creating or migrating it", async () => {
    const f = fixture("doctor-absent-repo");
    let tool: any;
    spiderExtension({ registerTool(t: any) { if (t.name === "spider") tool = t; }, on() {}, registerCommand() {}, registerMessageRenderer() {} } as any);
    const result = await tool.execute("absent-doctor", { action: "control", command: "doctor" }, undefined, undefined,
      { cwd: f.cwd, sessionManager: { getSessionId: () => "absent-session" } });
    const report = result.details as { lines: string[]; ok: boolean };
    expect(report.lines.join("\n")).toContain("memory repo: active=0 injected=0");
    expect(report.lines.join("\n")).not.toContain("action context unavailable");
    expect(report.ok).toBe(true);
    expect(existsSync(f.repoPath)).toBe(false);
  });

  it("doctor reports active versus injected counts and warns about configured omissions", async () => {
    const f = fixture("doctor");
    const global = openDbAt(f.globalPath, "global");
    global.prepare("INSERT INTO global_memory (uuid, category, content, scope, status, source, created_at) VALUES ('g-doc', 'preference', 'global directive', 'global', 'active', 'user', 1)").run();
    global.close();
    const repo = openDbAt(f.repoPath, "repo");
    repo.prepare("INSERT INTO memory (uuid, category, content, status, source, created_at) VALUES ('r-doc', 'insight', ?, 'active', 'user', 2)").run("Z".repeat(500));
    repo.close();
    controlConfig("set", f.cwd, "memory.snapshotCharCap", 100);
    let tool: any;
    spiderExtension({ registerTool(t: any) { if (t.name === "spider") tool = t; }, on() {}, registerCommand() {}, registerMessageRenderer() {} } as any);
    const result = await tool.execute("doc", { action: "control", command: "doctor", cwd: f.cwd }, {});
    expect(result.details).toBeDefined();
    const report = result.details as { lines: string[]; ok: boolean };
    expect(report.lines.join("\n")).toMatch(/global.*active=1.*injected=1/);
    expect(report.lines.join("\n")).toMatch(/repo.*active=1.*injected=0/);
    expect(report.lines.join("\n")).toMatch(/memory.*WARNING.*1.*omitted/i);
    // No native session in this fixture: organism runtime diagnostics may fail independently.
    expect(report.lines.some(line => line.includes("memory WARNING"))).toBe(true);
  });

  it("doctor treats deliberate omissions as a warning for a valid session", async () => {
    const f = fixture("warning-only");
    const repo = openDbAt(f.repoPath, "repo");
    repo.prepare("INSERT INTO memory (uuid, category, content, status, source, created_at) VALUES ('large', 'insight', ?, 'active', 'user', 1)").run("L".repeat(600));
    repo.close();
    controlConfig("set", f.cwd, "memory.snapshotCharCap", 100);
    let tool: any;
    spiderExtension({ registerTool(t: any) { if (t.name === "spider") tool = t; }, on() {}, registerCommand() {}, registerMessageRenderer() {} } as any);
    const result = await tool.execute("warn", { action: "control", command: "doctor", cwd: f.cwd }, undefined, undefined,
      { cwd: f.cwd, sessionManager: { getSessionId: () => "warning-session" } });
    const report = result.details as { lines: string[]; ok: boolean };
    expect(report.lines.join("\n")).toContain("memory WARNING: 1 entry omitted");
    expect(report.ok).toBe(true);
  });

  it("coerces a numeric string cap for both hook and doctor, and diagnoses an invalid cap", async () => {
    const f = fixture("numeric-string");
    const repo = openDbAt(f.repoPath, "repo");
    repo.prepare("INSERT INTO memory (uuid, category, content, status, source, created_at) VALUES ('large', 'insight', ?, 'active', 'user', 1)").run("L".repeat(600));
    repo.close();
    let tool: any;
    spiderExtension({ registerTool(t: any) { if (t.name === "spider") tool = t; }, on() {}, registerCommand() {}, registerMessageRenderer() {} } as any);
    controlConfig("set", f.cwd, "memory.snapshotCharCap", "100");
    expect((f.inject() as { systemPrompt: string }).systemPrompt).not.toContain("LLLL");
    const capped = await tool.execute("string", { action: "control", command: "doctor", cwd: f.cwd }, {});
    expect((capped.details as { lines: string[] }).lines.join("\n")).toContain("memory repo: active=1 injected=0");
    controlConfig("set", f.cwd, "memory.snapshotCharCap", "not-a-number");
    const invalid = await tool.execute("invalid", { action: "control", command: "doctor", cwd: f.cwd }, {});
    expect((invalid.details as { lines: string[] }).lines.join("\n")).toContain("memory.snapshotCharCap invalid (not-a-number), ignored");
    expect((invalid.details as { lines: string[] }).lines.join("\n")).toContain("memory repo: active=1 injected=1");
  });

  it("uses the configured cap, labels both scopes, and leaves DB files unchanged", () => {
    const f = fixture("capped");
    const global = openDbAt(f.globalPath, "global");
    global.prepare("INSERT INTO global_memory (uuid, category, content, scope, status, source, created_at) VALUES ('global-1', 'preference', 'global directive', 'global', 'active', 'user', 1)").run();
    global.close();
    const repo = openDbAt(f.repoPath, "repo");
    repo.prepare("INSERT INTO memory (uuid, category, content, status, source, created_at) VALUES ('repo-1', 'correction', 'repo correction', 'active', 'user', 2)").run();
    repo.prepare("INSERT INTO memory (uuid, category, content, status, source, created_at) VALUES ('repo-2', 'insight', ?, 'active', 'user', 3)").run("H".repeat(500));
    repo.close();
    controlConfig("set", f.cwd, "memory.snapshotCharCap", 160);
    const before = [statSync(f.repoPath).mtimeMs, statSync(f.globalPath).mtimeMs];
    const result = f.inject() as { systemPrompt: string };
    expect(result.systemPrompt).toContain("## global");
    expect(result.systemPrompt).toContain("global directive");
    expect(result.systemPrompt).toContain("## repo");
    expect(result.systemPrompt).toContain("repo correction");
    expect(result.systemPrompt).toContain("1 entry omitted");
    expect(result.systemPrompt).not.toContain("HHHH");
    expect([statSync(f.repoPath).mtimeMs, statSync(f.globalPath).mtimeMs]).toEqual(before);
  });
});

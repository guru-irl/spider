import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdirSync, rmSync, existsSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { openDbAt, openDbReadOnlyAt, openGlobal, bindSession, setGlobalDbPathForTests, SCHEMA_VERSION } from "@spider/db-core";
import { registerHooks } from "../hooks";
import spiderExtension from "../extension";
import { controlConfig } from "../control";
import { addMemory, approvePending, getMemory, listActive, listPending, searchMemoryFts, setStatus } from "@spider/memory";
import { controlBind, controlUnbind } from "../control-bind";

const root = join(process.cwd(), ".spider", "scratch", `memory-hook-${process.pid}`);
afterEach(() => {
  vi.unstubAllEnvs();
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
  const inject = (sessionId?: string, sessionFile?: string, systemPrompt = "base") => handlers.before_agent_start(
    { systemPrompt }, { cwd, sessionManager: { getSessionId: () => sessionId, getSessionFile: () => sessionFile } },
  );
  return { cwd, repoPath, globalPath, inject };
}

describe("production memory injection", () => {
  // Catch per-turn rebuilds after active-memory changes in either injected tier.
  for (const scope of ["repo", "global"] as const) {
    for (const change of ["added", "approved", "superseded"] as const) {
      it(`freezes ${scope} memory when an entry is ${change} between turns`, () => {
        const f = fixture(`freeze-${scope}-${change}`);
        const db = openDbAt(scope === "repo" ? f.repoPath : f.globalPath, scope);
        try {
          const old = addMemory(db, scope, { category: "preference", content: "Original memory fact", source: "user", status: "active" });
          const staged = change === "approved"
            ? addMemory(db, scope, { category: "convention", content: "Later memory fact", source: "user", status: "staged" })
            : undefined;
          const first = f.inject("original-session");
          expect(first.systemPrompt).toContain("Original memory fact");
          expect(first.systemPrompt).not.toContain("Later memory fact");
          if (staged) {
            expect(approvePending(db, scope, staged.uuid)?.status).toBe("active");
          } else {
            if (change === "superseded") setStatus(db, scope, old.uuid, "archived");
            addMemory(db, scope, { category: "convention", content: "Later memory fact", source: "user", status: "active" });
          }
          expect(f.inject("original-session")).toEqual(first);
          expect(f.inject("original-session")).toEqual(first);
          const next = f.inject("next-session");
          expect(next.systemPrompt).toContain("Later memory fact");
          if (change === "superseded") expect(next.systemPrompt).not.toContain("Original memory fact");
        } finally { db.close(); }
      });
    }
  }

  // Catch freezing a partial build instead of retrying the failed tier next turn.
  for (const failedScope of ["repo", "global"] as const) {
    it(`retries a transient ${failedScope} memory read failure before freezing`, () => {
      const f = fixture(`freeze-retry-${failedScope}`);
      for (const scope of ["repo", "global"] as const) {
        const db = openDbAt(scope === "repo" ? f.repoPath : f.globalPath, scope);
        try { addMemory(db, scope, { category: "preference", content: `${scope} recovery fact`, source: "user", status: "active" }); }
        finally { db.close(); }
      }
      const failedPath = failedScope === "repo" ? f.repoPath : f.globalPath;
      chmodSync(failedPath, 0o000);
      try {
        const degraded = f.inject("recovery-session");
        expect(degraded.systemPrompt).toContain(`${failedScope === "repo" ? "global" : "repo"} recovery fact`);
        expect(degraded.systemPrompt).not.toContain(`${failedScope} recovery fact`);
        expect(f.inject("recovery-session")).toEqual(degraded);
      } finally { chmodSync(failedPath, 0o600); }
      const recovered = f.inject("recovery-session");
      expect(recovered.systemPrompt).toContain("repo recovery fact");
      expect(recovered.systemPrompt).toContain("global recovery fact");
      const db = openDbAt(f.repoPath, "repo");
      try { addMemory(db, "repo", { category: "convention", content: "After recovery fact", source: "user", status: "active" }); }
      finally { db.close(); }
      expect(f.inject("recovery-session")).toEqual(recovered);
    });
  }

  // Catch replacing a bound snapshot with cwd memory on a failed binding read.
  it("keeps the bound frozen block through a transient binding lookup failure", () => {
    const a = fixture("freeze-binding-error-a");
    const b = fixture("freeze-binding-error-b");
    for (const [path, content] of [[a.repoPath, "Wrong cwd fact"], [b.repoPath, "Bound recovery fact"]]) {
      const db = openDbAt(path, "repo");
      try { addMemory(db, "repo", { category: "preference", content, source: "user", status: "active" }); }
      finally { db.close(); }
    }
    const global = openGlobal();
    try { bindSession(global, "bound-recovery-session", b.cwd); }
    finally { global.close(); }
    const file = join(root, "bound-recovery.jsonl");
    const first = a.inject("bound-recovery-session", file);
    expect(first.systemPrompt).toContain("Bound recovery fact");
    expect(first.systemPrompt).not.toContain("Wrong cwd fact");
    const boundDb = openDbAt(b.repoPath, "repo");
    try { addMemory(boundDb, "repo", { category: "convention", content: "Later bound recovery fact", source: "user", status: "active" }); }
    finally { boundDb.close(); }
    chmodSync(b.globalPath, 0o000);
    try {
      expect(a.inject("bound-recovery-session", file)).toEqual(first);
      expect(a.inject("bound-recovery-session", file)).toEqual(first);
      // A different native session must not inherit the previous bound block.
      const other = a.inject("other-recovery-session", join(root, "other.jsonl"));
      expect(other.systemPrompt).toContain("Wrong cwd fact");
      expect(other.systemPrompt).not.toContain("Bound recovery fact");
    } finally { chmodSync(b.globalPath, 0o600); }
    expect(a.inject("bound-recovery-session", file)).toEqual(first);
  });

  it("freezes an empty snapshot until the session changes", () => {
    const f = fixture("freeze-empty");
    expect(f.inject("empty-session")).toBeUndefined();
    const db = openDbAt(f.repoPath, "repo");
    try {
      addMemory(db, "repo", { category: "preference", content: "First memory fact", source: "user", status: "active" });
    } finally { db.close(); }
    expect(f.inject("empty-session")).toBeUndefined();
    expect(f.inject("new-session").systemPrompt).toContain("First memory fact");
  });

  it("rebuilds when the session file changes even if the id stays the same", () => {
    const f = fixture("freeze-file");
    const db = openDbAt(f.repoPath, "repo");
    try {
      addMemory(db, "repo", { category: "preference", content: "Original file fact", source: "user", status: "active" });
      const first = f.inject("same-id", join(root, "first.jsonl"));
      addMemory(db, "repo", { category: "convention", content: "New file fact", source: "user", status: "active" });
      expect(f.inject("same-id", join(root, "first.jsonl"))).toEqual(first);
      expect(f.inject("same-id", join(root, "second.jsonl")).systemPrompt).toContain("New file fact");
    } finally { db.close(); }
  });

  it("rebuilds after bind and unbind change the memory source", () => {
    const a = fixture("freeze-binding-a");
    const b = fixture("freeze-binding-b");
    for (const [path, content] of [[a.repoPath, "CWD frozen fact"], [b.repoPath, "Bound frozen fact"]]) {
      const db = openDbAt(path, "repo");
      try { addMemory(db, "repo", { category: "preference", content, source: "user", status: "active" }); }
      finally { db.close(); }
    }
    const first = a.inject("binding-session");
    expect(first.systemPrompt).toContain("CWD frozen fact");
    const global = openGlobal();
    try {
      expect(controlBind(global, "binding-session", b.cwd).ok).toBe(true);
      const bound = a.inject("binding-session");
      expect(bound.systemPrompt).toContain("Bound frozen fact");
      expect(bound.systemPrompt).not.toContain("CWD frozen fact");
      const db = openDbAt(b.repoPath, "repo");
      try { addMemory(db, "repo", { category: "convention", content: "Later bound fact", source: "user", status: "active" }); }
      finally { db.close(); }
      expect(a.inject("binding-session")).toEqual(bound);
      // Rebinding the same source must not pick up new memory in this session.
      expect(controlBind(global, "binding-session", b.cwd).ok).toBe(true);
      expect(a.inject("binding-session")).toEqual(bound);
      const cwdDb = openDbAt(a.repoPath, "repo");
      try { addMemory(cwdDb, "repo", { category: "convention", content: "Later cwd fact", source: "user", status: "active" }); }
      finally { cwdDb.close(); }
      expect(controlUnbind(global, "binding-session").ok).toBe(true);
      const unbound = a.inject("binding-session");
      expect(unbound.systemPrompt).toContain("CWD frozen fact");
      expect(unbound.systemPrompt).toContain("Later cwd fact");
      expect(unbound.systemPrompt).not.toContain("Bound frozen fact");
      expect(unbound.systemPrompt).not.toContain("Later bound fact");
      expect(a.inject("binding-session")).toEqual(unbound);
    } finally { global.close(); }
  });

  it("takes a fresh snapshot in a reloaded extension instance", () => {
    const f = fixture("freeze-reload");
    const db = openDbAt(f.repoPath, "repo");
    try {
      addMemory(db, "repo", { category: "preference", content: "Before reload fact", source: "user", status: "active" });
      const first = f.inject("reload-session");
      addMemory(db, "repo", { category: "convention", content: "After reload fact", source: "user", status: "active" });
      const handlers: Record<string, (...args: any[]) => any> = {};
      registerHooks({ on(name, fn) { handlers[name] = fn; } });
      const reloaded = handlers.before_agent_start({ systemPrompt: "base" },
        { cwd: f.cwd, sessionManager: { getSessionId: () => "reload-session" } });
      expect(reloaded.systemPrompt).toContain("After reload fact");
      expect(f.inject("reload-session")).toEqual(first);
    } finally { db.close(); }
  });

  it("gives subagent sessions independent frozen snapshots", () => {
    const f = fixture("freeze-child");
    const db = openDbAt(f.repoPath, "repo");
    try {
      addMemory(db, "repo", { category: "preference", content: "Parent memory fact", source: "user", status: "active" });
      const parent = f.inject("parent-session");
      addMemory(db, "repo", { category: "convention", content: "Before child fact", source: "user", status: "active" });
      vi.stubEnv("PI_SUBAGENT_CHILD", "1");
      vi.stubEnv("PI_SPIDER_DB_PATH", join(root, "child-runs.db"));
      const handlers: Record<string, (...args: any[]) => any> = {};
      registerHooks({ on(name, fn) { handlers[name] = fn; } });
      const injectChild = () => handlers.before_agent_start({ systemPrompt: "base" },
        { cwd: f.cwd, sessionManager: { getSessionId: () => "child-session" } });
      const child = injectChild();
      expect(child.systemPrompt).toContain("Before child fact");
      addMemory(db, "repo", { category: "insight", content: "After child fact", source: "user", status: "active" });
      expect(injectChild()).toEqual(child);
      expect(f.inject("parent-session")).toEqual(parent);
    } finally { db.close(); }
  });

  it("appends the frozen block to the incoming prompt instead of freezing another extension's prefix", () => {
    const f = fixture("freeze-prefix");
    const db = openDbAt(f.repoPath, "repo");
    try {
      addMemory(db, "repo", { category: "preference", content: "Prefix memory fact", source: "user", status: "active" });
      const first = f.inject("prefix-session").systemPrompt;
      addMemory(db, "repo", { category: "convention", content: "Later prefix fact", source: "user", status: "active" });
      expect(f.inject("prefix-session", undefined, "changed prefix").systemPrompt).toBe("changed prefix" + first.slice("base".length));
    } finally { db.close(); }
  });

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
      expect(handlers).toHaveLength(3);
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

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SessionManager, type ExtensionAPI, type ExtensionContext, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { parseColor, stripTerminalSequences, visibleWidth, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { openDb, WORKTREE_SCHEMA } from "@spider/db-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TabbedReader, type IntroTheme } from "@spider/ui";
import { testScratchPath } from "./testutil.js";

import { readIntroStats, registerIntro } from "../intro/index.js";
const theme: IntroTheme = {
  fg: (_role, text) => text, bold: text => text, style: text => text,
  colors: { customMessageBg: parseColor("#202022") },
};
const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function temporaryCwd() {
  const cwd = mkdtempSync(testScratchPath("intro-"));
  dirs.push(cwd);
  return cwd;
}
function addTurn(session: SessionManager, content: string) {
  return session.appendMessage({ role: "user", content, timestamp: Date.now() });
}

it("counts the current branch and only this session's runs and open todos", () => {
  const cwd = temporaryCwd(), session = SessionManager.inMemory(cwd);
  const first = addTurn(session, "First question");
  session.appendCompaction("First summary", first, 20);
  const fork = addTurn(session, "Follow-up");
  const discarded = addTurn(session, "Discarded question");
  session.appendCompaction("Discarded summary", discarded, 10);
  session.branch(fork);
  addTurn(session, "Current question");
  const now = Date.parse(session.getHeader()!.timestamp) + 6_120_000;
  const db = openDb(join(cwd, "fixture.db"));
  try {
    db.exec(WORKTREE_SCHEMA);
    const id = session.getSessionId(), other = "another-session";
    const run = db.prepare("INSERT INTO runs (id, session_id, agent, status) VALUES (?, ?, 'worker', ?)");
    ["running", "queued", "paused", "done", "failed"].forEach((status, i) => run.run(`our-${i}`, id, status));
    run.run("other", other, "running");
    const todo = db.prepare("INSERT INTO todos (session_id, seq, text, done, created_at) VALUES (?, ?, 'task', ?, ?)");
    todo.run(id, 1, 0, now); todo.run(id, 2, 1, now); todo.run(id, 3, 0, now); todo.run(other, 1, 0, now);
    expect(readIntroStats(session, now, db)).toEqual({ compactions: 1, turns: 3, ageMs: 6_120_000,
      runs: { total: 5, active: 3 }, todos: 2 });
  } finally { db.close(); }
});

it("shows zero for a fresh session and unknown DB counts for a resumed session without history", () => {
  const session = SessionManager.inMemory(temporaryCwd());
  const now = Date.parse(session.getHeader()!.timestamp);
  expect(readIntroStats(session, now)).toEqual({ compactions: 0, turns: 0, ageMs: 0,
    runs: { total: 0, active: 0 }, todos: 0 });
  addTurn(session, "Previously started");
  expect(readIntroStats(session, now)).toMatchObject({ turns: 1, runs: undefined, todos: undefined });
});

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
function fixture(options: { cwd?: string; session?: SessionManager; mode?: ExtensionContext["mode"]; admitted?: boolean } = {}) {
  const cwd = options.cwd ?? temporaryCwd();
  const session = options.session ?? SessionManager.inMemory(cwd);
  const handlers = new Map<string, Handler>(), printed: string[] = [];
  const commands = new Map<string, Handler>(), shortcuts = new Map<string, (ctx: ExtensionContext) => unknown>();
  const tui = { terminal: { columns: 120, rows: 24, reducedMotion: true }, requestRender() {} };
  const source = (path: string) => ({ path, source: "local", scope: "project", origin: "top-level", baseDir: cwd });
  let overlay: { reader: TabbedReader; options: unknown } | undefined;
  let prompt = "Fixture prompt";
  let component: ReturnType<NonNullable<Parameters<ExtensionUIContext["setHeader"]>[0]>> | undefined;
  const pi = {
    on: (name: string, handler: Handler) => { handlers.set(name, handler); },
    getCommands: () => [
      { name: "resources", source: "extension", sourceInfo: source(join(cwd, "ext.ts")) },
      { name: "other-command", source: "extension", sourceInfo: source(join(cwd, "ext.ts")) },
      { name: "skill:example", source: "skill", sourceInfo: source(join(cwd, "skills/example/SKILL.md")) },
      { name: "template", source: "prompt", sourceInfo: source(join(cwd, "prompts/template.md")) },
    ],
    getAllTools: () => [
      { sourceInfo: source(join(cwd, "tools-only.ts")) }, { sourceInfo: source("builtin:read") },
    ],
    registerCommand: (name: string, value: { handler: Handler }) => commands.set(name, value.handler),
    registerShortcut: (key: string, value: { handler: (ctx: ExtensionContext) => unknown }) => shortcuts.set(key, value.handler),
  } as unknown as ExtensionAPI;
  const ctx = {
    mode: options.mode ?? "tui", cwd, hasUI: options.mode !== "print" && options.mode !== "json", sessionManager: session,
    thinkingLevel: "high", getSystemPrompt: () => prompt,
    ui: {
      setHeader: (factory: (tui: unknown, theme: IntroTheme) => NonNullable<typeof component>) => { component = factory(tui, theme); },
      custom: (factory: (tui: unknown, theme: IntroTheme, keys: unknown, done: () => void) => TabbedReader, options: unknown) =>
        new Promise<void>(resolve => { overlay = { reader: factory(tui, theme, {}, () => { overlay?.reader.dispose(); overlay = undefined; resolve(); }), options }; }),
    },
  } as unknown as ExtensionContext;
  const terminal = { restored: false, width: () => 120, isRestored: () => terminal.restored, write: (text: string) => printed.push(text) };
  const readVisitUsage = vi.fn(async () => ({ credits: 1.53, calls: 2, unpricedCalls: 0,
    input: 10, cacheRead: 20, cacheWrite: 30, output: 9, reasoning: null }));
  registerIntro(pi, { admitted: () => options.admitted ?? true, piVersion: "1.5.2", terminal, readVisitUsage });
  const emit = (type: string, details: object) => handlers.get(type)?.({ type, ...details }, ctx);
  const start = (reason = "startup") => emit("session_start", { reason });
  const shutdown = (reason = "quit") => emit("session_shutdown", { reason });
  async function change(toolName: string, toolCallId: string, path: string, content: string, isError = false) {
    const input = { path, content };
    await emit("tool_call", { toolName, toolCallId, input });
    if (!isError) writeFileSync(join(cwd, path), content);
    await emit("tool_result", { toolName, toolCallId, input, isError });
  }
  return { cwd, session, terminal, printed, readVisitUsage, commands, shortcuts,
    get header() { return component; }, get overlay() { return overlay; }, start, shutdown, change,
    setPrompt(value: string) { prompt = value; },
    runResources: () => commands.get("resources")?.("", ctx),
    pressResources: () => shortcuts.get("alt+o")?.(ctx),
  };
}

describe("interactive intro lifecycle", () => {
  it.each(["startup", "new", "resume", "reload", "fork"])("mounts through setHeader on %s", async reason => {
    const f = fixture();
    await f.start(reason);
    expect(f.header?.render(80).map(stripTerminalSequences).join("\n")).toContain("pi v1.5.2");
    await f.shutdown("new");
  });

  it.each(["print", "rpc", "json", "child", "unadmitted"] as const)("keeps the header and receipt quiet for %s", async kind => {
    if (kind === "child") vi.stubEnv("PI_SUBAGENT_CHILD", "1");
    const f = fixture({ mode: kind === "child" || kind === "unadmitted" ? "tui" : kind, admitted: kind !== "unadmitted" });
    await f.start(); f.terminal.restored = true; await f.shutdown();
    expect(f.header).toBeUndefined();
    await f.runResources(); await f.pressResources();
    expect(f.overlay).toBeUndefined();
    if (kind === "child") { expect(f.commands.has("resources")).toBe(false); expect(f.shortcuts.has("alt+o")).toBe(false); }
    expect(f.printed).toEqual([]);
    expect(f.readVisitUsage).not.toHaveBeenCalled();
  });

  it("opens the shared reader from the box, Alt+O and /resources without taking Ctrl+O", async () => {
    const f = fixture();
    f.setPrompt(`Original prompt\n<project_context>\nProject-specific instructions and guidelines:\n\n<project_instructions path="${join(f.cwd, "AGENTS.md")}">\nProject text\n</project_instructions>\n</project_context>\n`);
    await f.start();
    const header = f.header!, headerText = header.render(120).map(stripTerminalSequences).join("\n");
    expect(headerText).toMatch(/Context 1 · Skills 1 · Extensions ≥2 · Prompts 1 · System prompt ~\d+ tokens/);
    const click: TuiMouseEvent = { type: "click", button: "left", x: 5, y: 16, screenX: 5, screenY: 16,
      width: 120, height: 18, shift: false, alt: false, ctrl: false };
    expect(header.handleMouse?.({ ...click, y: 1 })).toBeUndefined();
    expect(f.overlay).toBeUndefined();
    expect(header.handleMouse?.(click)).toEqual({ handled: true });
    const first = f.overlay!;
    expect(first?.reader).toBeInstanceOf(TabbedReader);
    expect(first.options).toMatchObject({ overlay: true, overlayOptions: { anchor: "top-left", width: "100%", maxHeight: "100%", margin: 0 } });
    const render = (reader: TabbedReader, width = 120) => {
      const rows = reader.render(width);
      expect(rows).toHaveLength(24);
      expect(rows.every(row => visibleWidth(row) <= width)).toBe(true);
      return rows.map(stripTerminalSequences).join("\n");
    };
    expect(render(first.reader)).toContain("Original prompt");
    for (const [tab, body] of [["Context files", "AGENTS.md"], ["Skills", "skills/example/SKILL.md"],
      ["Extensions", "tools-only.ts"], ["Prompt templates", "prompts/template.md"]]) {
      first.reader.handleInput("\t");
      expect(render(first.reader)).toContain(`Loaded resources / ${tab}`);
      expect(render(first.reader)).toContain(body);
    }
    await f.runResources(); // A second entry point does not stack a reader over the first.
    expect(f.overlay).toBe(first);
    first.reader.handleInput("\x1b");
    expect(f.overlay).toBeUndefined();
    await Promise.resolve();
    f.setPrompt("**Literal** \x1b[31mred\x1b[0m\x07 text");
    const shortcut = f.pressResources();
    const second = f.overlay?.reader;
    expect(second).toBeInstanceOf(TabbedReader);
    const ansi = second!.render(60).join("\n");
    expect(ansi).toContain("**Literal** red text");
    expect(ansi).not.toContain("\x1b[31m");
    expect(ansi).not.toContain("\x07");
    second!.handleInput("\x1b"); await shortcut;
    const command = f.runResources();
    const third = f.overlay?.reader;
    expect(third).toBeInstanceOf(TabbedReader);
    expect(render(third!)).toContain("**Literal** red text");
    third!.handleInput("\x1b"); await command;
    expect(f.overlay).toBeUndefined();
    expect(f.shortcuts.has("ctrl+o")).toBe(false);
    await f.shutdown("new");
  });

  it.each(["signal", "new", "resume", "reload", "fork"])("does not print or query usage for %s shutdown", async reason => {
    const f = fixture();
    await f.start(); f.terminal.restored = reason !== "signal";
    await f.shutdown(reason === "signal" ? "quit" : reason);
    expect(f.printed).toEqual([]);
    expect(f.readVisitUsage).not.toHaveBeenCalled();
    if (reason === "reload") { await f.start("reload"); await f.shutdown("new"); }
  });

  it("prints one normal-quit receipt with net successful edit and write changes for this visit", async () => {
    const f = fixture();
    const first = addTurn(f.session, "Before this visit");
    f.session.appendCompaction("Earlier compaction", first, 200);
    // Give the historical entries an earlier timestamp even on a clock with ms precision.
    for (const entry of f.session.getBranch()) entry.timestamp = "2000-01-01T00:00:00.000Z";
    await f.start("resume");
    f.session.appendCompaction("This visit", first, 100);
    writeFileSync(join(f.cwd, "one.txt"), "one\n--- old\nthree\n");
    await f.change("edit", "a", "one.txt", "one\n+++ in a diff\nthree\nfour\n");
    await f.change("write", "b", "one.txt", "one\n+++ new\nthree\n");
    await f.change("write", "c", "new.txt", "two\nmore\n");
    await f.change("write", "d", "failed.txt", "ignored\n", true);
    await f.change("bash", "e", "shell.txt", "ignored\n");
    f.terminal.restored = true;
    await f.shutdown(); await f.shutdown();
    expect(f.printed).toHaveLength(1);
    const text = stripTerminalSequences(f.printed[0]!);
    expect(text).toMatch(/Changes\s+\+3 −1/);
    expect(text).toMatch(/AI credits\s+~1\.53/);
    expect(text).toMatch(/Tokens in\s+↑ 60 \(20 cached, 30 written\)/);
    expect(text).toMatch(/Tokens out\s+↓ 9/);
    expect(text).not.toContain("reasoning");
    expect(text).toMatch(/Compactions\s+1/);
    expect(text).not.toMatch(/pi --session/);
    expect(f.readVisitUsage).toHaveBeenCalledExactlyOnceWith(f.session.getSessionId(), expect.any(Number), expect.any(Number));
  });

  it("continues the visit across reload and excludes a file edited outside the tracked tools", async () => {
    const before = fixture();
    await before.start();
    await before.change("write", "a", "retained.txt", "one\n");
    await before.change("write", "b", "outside.txt", "before external\n");
    await before.shutdown("reload");
    const after = fixture({ cwd: before.cwd, session: before.session });
    await after.start("reload");
    writeFileSync(join(after.cwd, "outside.txt"), "external change\n");
    await after.change("write", "c", "outside.txt", "now changed\n");
    await after.change("write", "d", "retained.txt", "one\ntwo\n");
    after.terminal.restored = true;
    await after.shutdown();
    expect(before.printed).toEqual([]);
    expect(stripTerminalSequences(after.printed[0]!)).toMatch(/Changes\s+\+2 −0 \(partial\)/);
  });
});

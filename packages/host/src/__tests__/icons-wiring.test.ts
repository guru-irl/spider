import { afterEach, expect, it, vi } from "vitest";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { migrate, openDb, paths } from "@spider/db-core";
import { scratchDbPath, cleanupScratch } from "@spider/db-core/testutil";
import { mountAgentsUI } from "../agents/mount.js";
import spiderExtension from "../extension.js";
import * as inputBand from "../input-band/index.js";
import { withPiEvents, hostUnitPorts } from "./fixtures/pi-events.js";

const base = resolve(".spider/scratch/icons-wiring");
const originalGlobal = paths.globalRoot;
const originalCwd = process.cwd();
let root: string | undefined;
afterEach(() => {
  process.chdir(originalCwd);
  paths.globalRoot = originalGlobal;
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
  cleanupScratch();
});

it("mounts the configured icon style without changing any config", () => {
  mkdirSync(base, { recursive: true });
  root = mkdtempSync(join(base, "fixture-"));
  const global = join(root, "global"), cwd = join(root, "project");
  mkdirSync(global); mkdirSync(cwd);
  execFileSync("git", ["init", "-q", cwd]);
  paths.globalRoot = global;
  const file = join(global, "config.json");
  const theme = { fg: (_: string, text: string) => text, bg: (_: string, text: string) => text,
    bold: (text: string) => text, italic: (text: string) => text };
  const db = openDb(scratchDbPath("icons-mount"));
  migrate(db, "project");
  db.prepare("INSERT INTO runs (id, session_id, agent, name, status, step_count, token_count, started_at) VALUES ('r1','s','worker','scribe','running',1,0,0)").run();
  try {
    for (const [style, patched, expected] of [
      ["text", true, /◇ scribe/u], ["nerd", undefined, /\u{F167A} {2}scribe/u],
      ["nerd", true, /[\u{F2120}-\u{F2123}] {2}scribe/u],
    ] as const) {
      writeFileSync(file, JSON.stringify({ "ui.icons": style, "ui.spiderGlyphs": patched }));
      let factory: ((tui: unknown, theme: unknown) => { render(width: number): string[]; dispose(): void }) | undefined;
      const ui = { setWidget: (_key: string, value: unknown) => { if (typeof value === "function") factory = value as typeof factory; },
        custom: async () => undefined, notify: () => {} };
      const pi = { registerShortcut: () => {}, registerCommand: () => {} };
      const dispose = mountAgentsUI(pi, { ui } as never, { db, sessionId: "s", cwd });
      const widget = factory!({ requestRender() {} }, theme);
      expect(widget.render(100).join("\n")).toMatch(expected);
      widget.dispose(); dispose();
    }
  } finally { db.close(); }
});

it("uses the configured style for registered tool and notice renderers", () => {
  mkdirSync(base, { recursive: true });
  root = mkdtempSync(join(base, "registration-"));
  const global = join(root, "global"), cwd = join(root, "project");
  mkdirSync(global); mkdirSync(cwd);
  execFileSync("git", ["init", "-q", cwd]);
  paths.globalRoot = global;
  writeFileSync(join(global, "config.json"), JSON.stringify({ "ui.icons": "nerd", "ui.inputBand": false }));
  process.chdir(cwd);
  let tool: any;
  const messages = new Map<string, (...args: any[]) => any>();
  const commands = new Map<string, { description: string }>();
  let entry: ((...args: any[]) => any) | undefined;
  const pi = withPiEvents({
    on: () => () => {},
    registerTool: (value: any) => { if (value.name === "spider") tool = value; },
    registerCommand: (name: string, value: any) => commands.set(name, value),
    registerMessageRenderer: (name: string, value: (...args: any[]) => any) => messages.set(name, value),
    registerEntryRenderer: (_name: string, value: (...args: any[]) => any) => { entry = value; },
  });
  const registerBand = vi.spyOn(inputBand, "registerInputBand").mockImplementation(() => {});
  try {
    spiderExtension(pi as never, { ...hostUnitPorts, inputBand: { CustomEditor } });
    const readConfig = registerBand.mock.calls[0]![2]; // The session_start handler's config read.
    const resolveRoot = vi.spyOn(paths, "projectRoot");
    try {
      expect(readConfig(cwd)).toMatchObject({ "ui.inputBand": false, "ui.icons": "nerd" });
      expect(resolveRoot).toHaveBeenCalledExactlyOnceWith(cwd);
    } finally { resolveRoot.mockRestore(); }
  } finally { registerBand.mockRestore(); }
  const theme = { fg: (_: string, text: string) => text, bg: (_: string, text: string) => text,
    bold: (text: string) => text, italic: (text: string) => text };
  expect(commands.get("spider")?.description).toContain("\u{F0BCA}");
  expect(commands.get("todos")?.description).toContain("\u{F0BCA}");
  expect(tool.label).toBe("spider");
  expect(tool.renderCall({ action: "run" }, theme, {}).render(100).join("\n")).toContain("\u{F0BCA}  run");
  const result = { details: { run: { name: "scribe", status: "failed" } } };
  expect(tool.renderResult(result, {}, theme, { args: { action: "run" } }).render(100).join("\n")).toContain("\u{F0156}  failed · scribe");
  expect(messages.get("spider.subagent_done")!({ details: { name: "scribe", status: "cancelled" } }, {}, theme).render(100).join("\n")).toContain("\u{F002A}  cancelled");
  expect(entry!({ data: { status: "failed", errors: [], memoryStaged: 0, skillsStaged: 0, todosAdded: 0 } }, {}, theme).render(100).join("\n")).toContain("\u{F0156}  failed");
  writeFileSync(join(global, "config.json"), JSON.stringify({ "ui.icons": "text" }));
  expect(tool.renderCall({ action: "run" }, theme, {}).render(100).join("\n")).toContain("◆ run");
  expect(commands.get("spider")?.description).toContain("\u{F0BCA}");
});

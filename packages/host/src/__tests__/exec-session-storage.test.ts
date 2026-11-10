import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { runBatch, runExec, runExecFile } from "@spider/context";
import { registerRouting, DEFAULT_ROUTING_CONFIG } from "../routing/index";
import { renderSpiderResult } from "../render-result";
import { toToolResult } from "../result";
import { testScratchPath } from "./testutil";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function finish(message: any): any {
  const hooks: Record<string, Function> = {};
  const pi = { on: (name: string, hook: Function) => { hooks[name] = hook; }, registerTool: () => {} };
  registerRouting(pi as any, { db: undefined as any, getSessionId: () => "fixture", getCwd: () => process.cwd(), config: DEFAULT_ROUTING_CONFIG });
  return hooks.message_end?.({ type: "message_end", message })?.message ?? message;
}

const theme = { fg: (_: string, value: string) => value, bg: (_: string, value: string) => value, bold: (value: string) => value, italic: (value: string) => value };
function render(message: any, args: any, expanded: boolean): string[] {
  return renderSpiderResult(message, { expanded }, theme, { args }).render(100);
}

const ctx = { cwd: process.cwd() };
const cases = [
  { action: "exec", args: { action: "exec", language: "javascript", code: "process.stdout.write('abcdefghij'.repeat(1600))" }, run: runExec, saved: 8000 },
  { action: "exec with terminal escapes", args: { action: "exec", language: "javascript", code: "process.stdout.write('\\u001b[31m' + 'painted123'.repeat(800) + '\\u001b[0m')" }, run: runExec, saved: 7000 },
  { action: "exec with repeated terminal escapes", args: { action: "exec", language: "javascript", code: "process.stdout.write(('\\u001b[31m' + 'painted123'.repeat(10) + '\\u001b[0m').repeat(70))" }, run: runExec, saved: 4000 },
  { action: "exec_file", args: { action: "exec_file", path: "package.json", language: "javascript", code: "process.stdout.write('output-line'.repeat(300)); process.stderr.write('error-line'.repeat(300))" }, run: runExecFile, saved: 5000 },
  { action: "batch", args: { action: "batch", commands: [{ language: "javascript", code: "process.stdout.write('first-line'.repeat(300))" }, { language: "javascript", code: "process.stdout.write('second-line'.repeat(300)); process.stderr.write('error-line'.repeat(150))" }] }, run: runBatch, saved: 7000 },
];

describe("exec session storage", () => {
  it.each(cases)("stores shared $action output once and renders it after resume", async ({ args, run, saved }) => {
    const result = toToolResult(await run(args, ctx));
    const original = { role: "toolResult" as const, toolCallId: "call", toolName: "spider", timestamp: 1, ...result };
    const compact = finish(original);
    expect(Buffer.byteLength(JSON.stringify(original)) - Buffer.byteLength(JSON.stringify(compact))).toBeGreaterThan(saved);
    expect(compact.content).toEqual(original.content);

    const dir = mkdtempSync(testScratchPath("exec-session-"));
    dirs.push(dir);
    const session = SessionManager.create(ctx.cwd, dir);
    session.appendMessage({ role: "user", content: "synthetic", timestamp: 1 });
    session.appendMessage(compact);
    const file = session.getSessionFile()!;
    const entries = readFileSync(file, "utf8").trim().split("\n").map(line => JSON.parse(line));
    const persisted = entries.at(-1).message;
    expect(persisted.content).toEqual(original.content);
    const resumed = SessionManager.open(file).getBranch().at(-1) as any;
    expect(resumed.message.content).toEqual(original.content);
    for (const expanded of [false, true]) expect(render(resumed.message, args, expanded)).toEqual(render(original, args, expanded));
  });
});

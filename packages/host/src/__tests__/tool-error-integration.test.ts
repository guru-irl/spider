import { afterEach, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, InMemoryCredentialStore, InMemoryModelsStore, getCurrentTools, getCurrentSystemPrompt, Type, type JsonObject } from "@earendil-works/pi-ai";
import { setGlobalDbPathForTests } from "@spider/db-core";
import spiderExtension from "../extension";
import { controlConfig } from "../control";

const root = join(process.cwd(), ".spider", "scratch", `native-results-${process.pid}`);
afterEach(() => { controlConfig("unset", root, "tools.structured", undefined, "global"); setGlobalDbPathForTests(null); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

async function runCalls(calls: Array<{ id: string; args: JsonObject; tool?: string }>, options: {
  structured?: boolean; extend?: (pi: ExtensionAPI) => void; snapshots?: Array<{ prompt: string; tools: unknown }>; partials?: unknown[];
} = {}) {
  mkdirSync(root, { recursive: true });
  execFileSync("git", ["init", "-q", root]);
  setGlobalDbPathForTests(join(root, "global.db"));
  vi.stubEnv("PI_SUBAGENT_CHILD", "1"); // No learning, downloads or background services.
  if (options.structured !== undefined) controlConfig("set", root, "tools.structured", options.structured, "global");
  const faux = fauxProvider({ models: [{ id: "native-results" }], tokensPerSecond: 100000 });
  faux.setResponses([
    context => {
      options.snapshots?.push({ prompt: getCurrentSystemPrompt(context.messages), tools: getCurrentTools(context.messages) });
      return fauxAssistantMessage(calls.map(c => fauxToolCall(c.tool ?? "spider", c.args, { id: c.id })), { stopReason: "toolUse" });
    },
    fauxAssistantMessage("Done"),
  ]);
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  runtime.registerNativeProvider(faux.provider);
  const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off" });
  const loader = new DefaultResourceLoader({
    cwd: root, agentDir: process.env.PI_CODING_AGENT_DIR!, settingsManager: settings,
    noExtensions: true, noSkills: true, noContextFiles: true, noThemes: true, noPromptTemplates: true,
    extensionFactories: [pi => { spiderExtension(pi as never); options.extend?.(pi); }],
  });
  await loader.reload();
  const { session } = await createAgentSession({ cwd: root, agentDir: process.env.PI_CODING_AGENT_DIR!, resourceLoader: loader, modelRuntime: runtime, model: faux.getModel(), settingsManager: settings, sessionManager: SessionManager.inMemory(root), tools: options.structured ? undefined : ["spider", ...calls.flatMap(c => c.tool ? [c.tool] : [])], noTools: options.structured ? "builtin" : undefined });
  try {
    await session.bindExtensions({});
    session.subscribe(event => { if (event.type === "tool_execution_update") options.partials?.push(event.partialResult); });
    await session.prompt("Run the fixture calls");
    return session.messages.filter(m => m.role === "toolResult");
  } finally {
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    session.dispose();
  }
}

it("preserves native error flags for concurrent exec, action and thrown failures without poisoning success", async () => {
  const results = await runCalls([
    { id: "exit", args: { action: "exec", language: "shell", code: "printf failed; exit 7" } },
    { id: "action", args: { action: "recall", scope: "project" } },
    { id: "throw", args: { action: "exec", language: "unsupported-fixture", code: "unused" } },
    { id: "ok", args: { action: "exec", language: "shell", code: "printf success" } },
  ]);
  expect(results.map(r => [r.toolCallId, r.isError])).toEqual([["exit", true], ["action", true], ["throw", true], ["ok", false]]);
  expect(results[0].details).toMatchObject({ exitCode: 7, outcome: "exited" });
  for (const result of results) expect(result.content.some(b => b.type === "text" && b.text.trim())).toBe(true);
});

it("scrubs a native failure in every returned field, not only the model text", async () => {
  const secret = "ghp_" + "s".repeat(36);
  const partials: unknown[] = [];
  const [result] = await runCalls([{ id: "secret", args: { action: "exec", language: "shell", code: `printf '${secret}'; exit 9` } }], { partials });
  expect(partials.length).toBeGreaterThan(1);
  expect(JSON.stringify(partials)).not.toContain(secret);
  expect(result.isError).toBe(true);
  expect(result.details).toMatchObject({ outcome: "exited", exitCode: 9 });
  expect(JSON.stringify(result)).not.toContain(secret);
  expect(JSON.stringify(result.content)).toContain("REDACTED");
});

it("keeps the real host prompt and active tool declarations identical when explicitly off", async () => {
  const defaults: Array<{ prompt: string; tools: unknown }> = [];
  const off: Array<{ prompt: string; tools: unknown }> = [];
  const calls = [{ id: "ok", args: { action: "exec", language: "shell", code: "printf success" } }];
  await runCalls(calls, { snapshots: defaults });
  await runCalls(calls, { structured: false, snapshots: off });
  expect(defaults).toHaveLength(1);
  expect(off).toEqual(defaults);
  expect((off[0].tools as Array<{ name: string }>).map(t => t.name)).toEqual(["spider"]);
});

it("preserves structured native failures and redaction through real nested adapter calls", async () => {
  const secret = "ghp_" + "t".repeat(36);
  const [outer] = await runCalls([{ id: "typed", tool: "fixture_typed", args: {} }], {
    structured: true,
    extend(pi) {
      writeFileSync(join(root, "secret.txt"), secret);
      pi.registerTool({ name: "fixture_typed", label: "Typed", description: "Call typed adapters", parameters: Type.Object({}),
        async execute(_id, _args, _signal, _update, ctx) {
          const [ok, failed, search, recall] = await Promise.all([
            ctx.executeTool("spider_exec", { language: "shell", code: "printf success" }),
            ctx.executeTool("spider_exec", { language: "shell", code: "head -c 64 secret.txt; exit 7" }),
            ctx.executeTool("spider_search", { query: "nothing-in-this-fixture" }),
            ctx.executeTool("spider_recall", {}),
          ]);
          return { content: [{ type: "text", text: "Typed fixture done" }], details: { ok, failed, search, recall } };
        } });
    },
  });
  const details = outer.details as any;
  expect(details.ok).toMatchObject({ isError: false, result: { structuredContent: { outcome: "exited", exitCode: 0, output: "success" } } });
  expect(details.failed).toMatchObject({ isError: true, result: { structuredContent: { outcome: "exited", exitCode: 7, output: "[REDACTED:github_personal_token]" } } });
  expect(details.search.result.structuredContent).toEqual({ outcome: "ok", hits: [], truncated: false });
  expect(details.recall.result.structuredContent).toEqual({ outcome: "ok", hits: [], truncated: false });
  expect(outer.nestedCalls?.complete).toBe(true);
  expect(outer.nestedCalls?.calls).toHaveLength(4);
  expect(JSON.stringify(outer)).not.toContain(secret);
});

it("reads effective doctor settings from the real pi API", async () => {
  const [result] = await runCalls([{ id: "doctor", args: { action: "control", command: "doctor" } }]);
  const lines = (result.details as any).lines.join("\n");
  expect(lines).toContain("pi compaction: enabled=false");
  expect(lines).toContain("pi cache warming: off");
  expect(lines).toContain("pi codemode: mode=on inlineBudget=3000");
  expect(lines).toContain("pi TUI mode: fullscreen");
  expect(lines).toContain("pi install telemetry: true");
});

it("returns native edit/write validation errors through the real host", async () => {
  const results = await runCalls([
    { id: "edit", tool: "edit", args: { path: "not-written.txt", description: "", edits: [] } },
    { id: "write", tool: "write", args: { path: "not-written.txt", description: "", content: "not written" } },
  ]);
  expect(results).toHaveLength(2);
  for (const result of results) {
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("description");
  }
});

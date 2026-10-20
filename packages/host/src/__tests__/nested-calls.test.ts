import { afterEach, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, InMemoryCredentialStore, InMemoryModelsStore, Type } from "@earendil-works/pi-ai";
import { listEvents, openDbAt, type Db } from "@spider/db-core";
import { registerRouting, DEFAULT_ROUTING_CONFIG } from "../routing/index";
import { registerHooks } from "../hooks";

const root = join(process.cwd(), ".spider", "scratch", `nested-calls-${process.pid}`);
let db: Db | undefined;
afterEach(() => { db?.close(); db = undefined; rmSync(root, { recursive: true, force: true }); });

it("guards native nested calls, records each file action once with correlation, and preserves safe structured metadata", async () => {
  mkdirSync(root, { recursive: true }); execFileSync("git", ["init", "-q", root]);
  db = openDbAt(join(root, "activity.db"), "project");
  const secret = "ghp_" + "n".repeat(36);
  const faux = fauxProvider({ models: [{ id: "nested-calls" }], tokensPerSecond: 100000 });
  faux.setResponses([fauxAssistantMessage(fauxToolCall("fixture_outer", {}, { id: "outer" }), { stopReason: "toolUse" }), fauxAssistantMessage("Done")]);
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  runtime.registerNativeProvider(faux.provider);
  const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off" });
  const loader = new DefaultResourceLoader({
    cwd: root, agentDir: process.env.PI_CODING_AGENT_DIR!, settingsManager: settings,
    noExtensions: true, noSkills: true, noContextFiles: true, noThemes: true, noPromptTemplates: true,
    extensionFactories: [pi => {
      registerHooks(pi);
      registerRouting(pi, { db: db!, getSessionId: () => "nested-session", getCwd: () => root, config: DEFAULT_ROUTING_CONFIG });
      pi.registerTool({ name: "fixture_data", label: "Data", description: "Structured fixture", parameters: Type.Object({}), outputSchema: Type.Object({ value: Type.String() }),
        async execute() { return { content: [{ type: "text", text: secret }], details: { secret }, structuredContent: { value: secret } }; } });
      pi.registerTool({ name: "fixture_outer", label: "Outer", description: "Nested fixture", parameters: Type.Object({}),
        async execute(_id, _args, _signal, _update, ctx) {
          const write = await ctx.executeTool("write", { path: "nested.txt", description: "Create fixture", content: "nested body" });
          const [read, blocked, structured] = await Promise.all([
            ctx.executeTool("read", { path: "nested.txt" }),
            ctx.executeTool("bash", { command: "printf should-not-run" }),
            ctx.executeTool("fixture_data", {}),
          ]);
          return { content: [{ type: "text", text: "Nested fixture done" }], details: { write, read, blocked, structured } };
        } });
    }],
  });
  await loader.reload();
  const { session } = await createAgentSession({ cwd: root, agentDir: process.env.PI_CODING_AGENT_DIR!, resourceLoader: loader, modelRuntime: runtime, model: faux.getModel(), settingsManager: settings, sessionManager: SessionManager.inMemory(root), tools: ["fixture_outer", "fixture_data", "read", "write", "bash"] });
  try {
    await session.bindExtensions({}); await session.prompt("Run nested fixture");
    const messages = session.messages.filter(m => m.role === "toolResult");
    expect(messages).toHaveLength(1); // Nested hooks must not invent transcript results.
    const outer = messages[0]; const details = outer.details as any;
    expect(details.write.isError).toBe(false); expect(details.read.isError).toBe(false);
    expect(details.blocked.isError).toBe(true);
    expect(JSON.stringify(details.blocked)).toContain("bash is disabled");
    expect(JSON.stringify(details.blocked)).not.toContain('"text":"should-not-run"');
    expect(JSON.stringify(outer)).not.toContain(secret);
    expect(details.structured.result.structuredContent).toEqual({ value: "[REDACTED:github_personal_token]" });
    expect(outer.nestedCalls).toMatchObject({ complete: true, calls: expect.arrayContaining([
      expect.objectContaining({ name: "write", id: "outer/1" }),
      expect.objectContaining({ name: "read", id: "outer/2" }),
    ]) });
    for (const [tool, id] of [["write", "outer/1"], ["read", "outer/2"]]) {
      const events = listEvents(db!, { tool });
      expect(events).toHaveLength(2);
      expect(events.map(e => e.phase).sort()).toEqual(["after", "before"]);
      for (const event of events) expect(event.payload).toMatchObject({ toolCallId: id, parentToolCallId: "outer" });
    }
    expect(listEvents(db!, { tool: "fixture_outer" })).toHaveLength(2);
  } finally { session.dispose(); }
});

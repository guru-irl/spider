import { afterEach, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, getCurrentSystemPrompt, getCurrentTools, InMemoryCredentialStore, InMemoryModelsStore, Type, type FauxResponseFactory } from "@earendil-works/pi-ai";
import { openDbAt, setGlobalDbPathForTests } from "@spider/db-core";
import { addMemory } from "@spider/memory";
import { registerHooks } from "../hooks";

const root = join(process.cwd(), ".spider", "scratch", `memory-turn-drop-${process.pid}`);
afterEach(() => {
  setGlobalDbPathForTests(null);
  rmSync(root, { recursive: true, force: true });
});

function fixture(name: string) {
  const cwd = join(root, name);
  mkdirSync(cwd, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd });
  setGlobalDbPathForTests(join(root, "global.db"));
  const repo = openDbAt(join(cwd, ".git", "spider", "repo.db"), "repo");
  const add = (content: string) => addMemory(repo, "repo", { category: "preference", content, source: "user", status: "active" });
  const sessionManager = SessionManager.inMemory(cwd, { id: "fixture-session" });
  return { cwd, repo, add, sessionManager };
}

// Exercise the real public SDK path with a scripted in-memory provider, not a mock session.
// Pi 1.2 calls before_agent_start for idle custom runs and preserves the named section through continuations.
for (const continuation of ["notification only", "steer", "followUp", "tool loop"] as const) {
  it(`keeps the system prompt on pi's idle triggerTurn path with ${continuation}`, async () => {
    const f = fixture(continuation);
    let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
    try {
      f.add("SDK frozen fact");
      const prompts: string[] = [];
      const requests: Parameters<FauxResponseFactory>[0][] = [];
      let toolExecutions = 0;
      const faux = fauxProvider({ models: [{ id: "memory-test" }], tokensPerSecond: 100000 });
      const capture: FauxResponseFactory = async (context) => {
        prompts.push(getCurrentSystemPrompt(context.messages));
        requests.push(structuredClone(context));
        // Queue while the first idle request is in flight, with no timing sleeps.
        if (prompts.length === 2) {
          if (continuation === "steer") await session!.steer("Idle steer instruction");
          if (continuation === "followUp") await session!.followUp("Idle follow-up instruction");
          if (continuation === "tool loop") {
            return fauxAssistantMessage(fauxToolCall("fixture_tool", {}, { id: "idle-tool" }), { stopReason: "toolUse" });
          }
        }
        return fauxAssistantMessage("OK");
      };
      faux.setResponses(Array.from({ length: continuation === "notification only" ? 3 : 4 }, () => capture));
      const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
      runtime.registerNativeProvider(faux.provider);
      const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
      const starts: Array<{ messageType: string; prompt?: string; customType?: string }> = [];
      const loader = new DefaultResourceLoader({
        cwd: f.cwd, agentDir: process.env.PI_CODING_AGENT_DIR!, settingsManager: settings,
        noExtensions: true, noSkills: true, noContextFiles: true, noThemes: true, noPromptTemplates: true,
        systemPromptOverride: () => "base",
        extensionFactories: [pi => {
          registerHooks(pi);
          pi.on("before_agent_start", event => { starts.push(event.messageType === "custom"
            ? { messageType: event.messageType, customType: event.message.customType }
            : { messageType: event.messageType, prompt: event.prompt }); });
          if (continuation === "tool loop") pi.registerTool({
            name: "fixture_tool", label: "Fixture tool", description: "Return a fixture result",
            parameters: Type.Object({}),
            async execute() {
              toolExecutions++;
              return { content: [{ type: "text", text: "Idle tool result" }], details: {} };
            },
          });
        }],
      });
      await loader.reload();
      ({ session } = await createAgentSession({ cwd: f.cwd, agentDir: process.env.PI_CODING_AGENT_DIR!, resourceLoader: loader, modelRuntime: runtime, model: faux.getModel(), settingsManager: settings, sessionManager: f.sessionManager, tools: continuation === "tool loop" ? ["fixture_tool"] : [] }));
      await session.bindExtensions({});
      await session.prompt("first");
      f.add("SDK later fact");
      await session.sendCustomMessage({ customType: "spider.subagent_done", content: "OK", display: true, details: {} }, { triggerTurn: true });
      expect(starts).toEqual([
        { messageType: "user", prompt: "first" },
        { messageType: "custom", customType: "spider.subagent_done" },
      ]); // Continuations do not rerun preflight.
      expect(prompts).toHaveLength(continuation === "notification only" ? 2 : 3);
      if (continuation === "steer" || continuation === "followUp") {
        const instruction = continuation === "steer" ? "Idle steer instruction" : "Idle follow-up instruction";
        expect(requests[2].messages).toContainEqual(expect.objectContaining({
          role: "user", content: [{ type: "text", text: instruction }],
        }));
      }
      if (continuation === "tool loop") {
        expect(toolExecutions).toBe(1);
        expect(requests[2].messages).toContainEqual(expect.objectContaining({
          role: "toolResult", toolCallId: "idle-tool", toolName: "fixture_tool", isError: false,
          content: [{ type: "text", text: "Idle tool result" }],
        }));
      }
      await session.prompt("last");
      expect(starts).toEqual([
        { messageType: "user", prompt: "first" },
        { messageType: "custom", customType: "spider.subagent_done" },
        { messageType: "user", prompt: "last" },
      ]);
      expect(prompts).toHaveLength(continuation === "notification only" ? 3 : 4);
      expect(prompts[0]).toContain("SDK frozen fact");
      for (const prompt of prompts) {
        expect(prompt).toBe(prompts[0]);
        expect(prompt).not.toContain("SDK later fact");
      }
      for (const request of requests) {
        expect(getCurrentTools(request.messages)).toEqual(getCurrentTools(requests[0].messages));
        const rawSystem = JSON.stringify(request.messages.filter(message => message.role === "system"));
        expect(rawSystem.split("SDK frozen fact")).toHaveLength(2); // Exactly one copy, not just folded state.
      }
      const memoryPatches = f.sessionManager.getEntries().filter(entry => entry.type === "message" && entry.message.role === "system" && entry.message.sections?.spider_memory);
      expect(memoryPatches).toHaveLength(1);
      expect(JSON.stringify(memoryPatches)).toContain("SDK frozen fact");
    } finally { session?.dispose(); f.repo.close(); }
  });
}

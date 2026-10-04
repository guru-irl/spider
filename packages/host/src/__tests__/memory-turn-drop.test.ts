import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, getCurrentSystemPrompt, getCurrentTools, InMemoryCredentialStore, InMemoryModelsStore, Type, type FauxResponseFactory } from "@earendil-works/pi-ai";
import { bindSession, openDbAt, openGlobal, setGlobalDbPathForTests, unbindSession } from "@spider/db-core";
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
  const handlers: Record<string, (...args: any[]) => any> = {};
  registerHooks({ on(name, fn) { handlers[name] = fn; } });
  const sessionManager = SessionManager.inMemory(cwd, { id: "fixture-session" });
  const ctx = { cwd, sessionManager };
  const inject = () => handlers.before_agent_start({ type: "before_agent_start", prompt: "hello", images: undefined, get systemPrompt() { return "base"; } }, ctx)?.systemPrompt ?? "base";
  const project = (messages: any[]) => handlers.context_with_system?.({ type: "context_with_system", messages }, ctx)?.messages ?? messages;
  return { cwd, repo, add, handlers, sessionManager, ctx, inject, project };
}
const head = () => ({ role: "system", content: "", sections: { preamble: "base" }, toolsAdded: [], timestamp: 0 });
const notification = { role: "custom", customType: "spider.subagent_done", content: "OK", display: true, details: {}, timestamp: 1 };

describe("memory on starts that skip before_agent_start", () => {
  // Removing the request-time hook drops the frozen block on idle notifications.
  it("injects the byte-identical frozen block through pi's context_with_system event and native session manager", () => {
    const f = fixture("idle");
    try {
      f.add("Frozen notification fact");
      const first = f.inject();
      f.add("Must not appear until a new session");
      const messages = [head(), notification];
      const original = structuredClone(messages);
      const result = f.project(messages);
      expect(getCurrentSystemPrompt(result)).toContain("Frozen notification fact");
      expect(getCurrentSystemPrompt(result)).toBe(first);
      expect(getCurrentSystemPrompt(result)).not.toContain("Must not appear");
      expect(result.at(-1)).toBe(notification);
      expect(messages).toEqual(original);
      expect(f.inject()).toBe(first);
    } finally { f.repo.close(); }
  });

  it("freezes memory when the first request is a notification with no preceding user prompt", () => {
    const f = fixture("first-custom");
    try {
      f.add("First custom fact");
      const first = getCurrentSystemPrompt(f.project([head(), notification]));
      expect(first).toContain("First custom fact");
      f.add("Later fact");
      expect(f.inject()).toBe(first);
    } finally { f.repo.close(); }
  });

  it("is a no-op for an already injected block", () => {
    const f = fixture("idempotent");
    try {
      f.add("One block fact");
      const messages = [{ ...head(), sections: undefined, content: f.inject() }, notification];
      expect(f.project(messages)).toBe(messages);
      expect(getCurrentSystemPrompt(f.project(f.project(messages)))).toBe(f.inject());
    } finally { f.repo.close(); }
  });

  it("replays prompt and tool deltas without losing tools or changing the live transcript", () => {
    const f = fixture("deltas");
    try {
      f.add("Delta memory fact");
      const oldTool = { name: "old", description: "old tool", parameters: {} };
      const newTool = { name: "new", description: "new tool", parameters: {} };
      const messages = [
        { ...head(), toolsAdded: [oldTool] }, notification,
        { role: "system", content: "", sections: { rules: "<rules>changed</rules>" }, toolsAdded: [newTool], toolsRemoved: [{ name: "old" }], timestamp: 2 },
      ];
      const result = f.project(messages);
      expect(getCurrentSystemPrompt(result)).toContain("Delta memory fact");
      expect(getCurrentSystemPrompt(result)).toContain("<rules>changed</rules>");
      expect(getCurrentTools(result)).toEqual([newTool]);
      expect(messages).toHaveLength(3);
      expect(result.filter((m: any) => m.role === "system")).toHaveLength(1);
    } finally { f.repo.close(); }
  });

  it("rebuilds for a changed session on a notification-only start", () => {
    const f = fixture("session");
    try {
      f.add("Original session fact");
      f.inject();
      f.add("New session fact");
      f.sessionManager.newSession({ id: "new-session" });
      expect(getCurrentSystemPrompt(f.project([head(), notification]))).toContain("New session fact");
    } finally { f.repo.close(); }
  });

  it("rebuilds after bind and unbind even when only notifications trigger requests", () => {
    const a = fixture("bind-a");
    const b = fixture("bind-b");
    const global = openGlobal();
    try {
      a.add("Cwd source fact");
      b.add("Bound source fact");
      a.inject();
      bindSession(global, a.sessionManager.getSessionId(), b.cwd);
      const bound = getCurrentSystemPrompt(a.project([head(), notification]));
      expect(bound).toContain("Bound source fact");
      expect(bound).not.toContain("Cwd source fact");
      b.add("Unfrozen bound fact");
      expect(getCurrentSystemPrompt(a.project([head(), notification]))).toBe(bound);
      unbindSession(global, a.sessionManager.getSessionId());
      const unbound = getCurrentSystemPrompt(a.project([head(), notification]));
      expect(unbound).toContain("Cwd source fact");
      expect(unbound).not.toContain("Bound source fact");
    } finally { global.close(); a.repo.close(); b.repo.close(); }
  });

  it("applies the same frozen block when legacy system messages follow conversation entries", () => {
    const f = fixture("legacy-head");
    try {
      f.add("Legacy frozen fact");
      const first = f.inject();
      const tool = { name: "legacy", description: "legacy tool", parameters: {} };
      const messages = [notification, { ...head(), toolsAdded: [tool] }];
      const original = structuredClone(messages);
      const result = f.project(messages);
      expect(result[0].role).toBe("system");
      expect(getCurrentSystemPrompt(result)).toBe(first);
      expect(getCurrentTools(result)).toEqual([tool]);
      expect(result.filter((m: any) => m.role === "system")).toHaveLength(1);
      expect(result.at(-1)).toBe(notification);
      expect(messages).toEqual(original);
    } finally { f.repo.close(); }
  });

  it("leaves a transcript without any system message unchanged", () => {
    const f = fixture("no-head");
    try {
      f.add("Previous session fact");
      f.inject();
      const messages = [notification];
      expect(f.project(messages)).toBe(messages);
    } finally { f.repo.close(); }
  });
});

// Exercise the real public SDK path with a scripted in-memory provider, not a mock session.
// Pi clears the forced prompt after a user run and skips before_agent_start for idle custom messages.
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
      let starts = 0;
      const loader = new DefaultResourceLoader({
        cwd: f.cwd, agentDir: process.env.PI_CODING_AGENT_DIR!, settingsManager: settings,
        noExtensions: true, noSkills: true, noContextFiles: true, noThemes: true, noPromptTemplates: true,
        systemPromptOverride: () => "base",
        extensionFactories: [pi => {
          registerHooks(pi);
          pi.on("before_agent_start", () => { starts++; });
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
      expect(starts).toBe(1); // Idle run and its continuations all bypass preflight.
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
      expect(starts).toBe(2);
      expect(prompts).toHaveLength(continuation === "notification only" ? 3 : 4);
      expect(prompts[0]).toContain("SDK frozen fact");
      for (const prompt of prompts) {
        expect(prompt).toBe(prompts[0]);
        expect(prompt).not.toContain("SDK later fact");
      }
      for (const request of requests) expect(getCurrentTools(request.messages)).toEqual(getCurrentTools(requests[0].messages));
    } finally { session?.dispose(); f.repo.close(); }
  });
}

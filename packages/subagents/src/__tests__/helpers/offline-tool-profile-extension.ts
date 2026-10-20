import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { writeFileSync } from "node:fs";

/** Offline fixture: records actual model declarations and attempts excluded nested tools. */
export default function (pi: ExtensionAPI): void {
  let declared: string[] = [];
  let calls = 0;
  let directResults: Array<{ toolName: string; isError: boolean; text: string }> = [];
  pi.registerTool({
    name: "profile_probe", label: "Profile probe", description: "Inspect tool access", parameters: Type.Object({}),
    async execute(_id, _args, _signal, _update, ctx) {
      const errors: Record<string, string> = {};
      for (const name of ["edit", "write"]) {
        try {
          const outcome = await ctx.executeTool(name, name === "edit"
            ? { path: process.env.PROFILE_TARGET!, edits: [{ oldText: "original", newText: "changed" }] }
            : { path: process.env.PROFILE_TARGET!, content: "changed" });
          if (outcome.isError) errors[name] = outcome.result.content.filter(item => item.type === "text").map(item => item.text).join("\n");
        } catch (error) { errors[name] = String(error); }
      }
      writeFileSync(process.env.PROFILE_EVIDENCE!, JSON.stringify({
        sessionFile: ctx.sessionManager.getSessionFile(), declared, active: pi.getActiveTools(), registered: pi.getAllTools().map(tool => tool.name),
        callable: ctx.tools.map(tool => tool.name), errors, directResults,
      }));
      return { content: [{ type: "text", text: "profile checked" }], details: undefined };
    },
  });
  pi.registerProvider("spider-offline-profile", {
    baseUrl: "https://offline.invalid", apiKey: "fixture-only", api: "spider-offline-profile-api",
    models: [{ id: "fixture", name: "Offline profile", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 100,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    streamSimple(model, context) {
      const tools = new Set<string>();
      for (const message of context.messages) {
        if (message.role !== "system") continue;
        for (const tool of message.toolsRemoved ?? []) tools.delete(tool.name);
        for (const tool of message.toolsAdded ?? []) tools.add(tool.name);
      }
      declared = [...tools];
      directResults = context.messages.flatMap(message => message.role === "toolResult" && ["edit", "write"].includes(message.toolName)
        ? [{ toolName: message.toolName, isError: message.isError, text: message.content.filter(item => item.type === "text").map(item => item.text).join("\n") }] : []);
      const stream = createAssistantMessageEventStream();
      const direct = ++calls === 1;
      const probe = calls === 2;
      const toolUse = direct || probe;
      const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
        content: direct ? [
          { type: "toolCall", id: "direct-edit", name: "edit", arguments: { path: process.env.PROFILE_TARGET!, edits: [{ oldText: "original", newText: "changed" }] } },
          { type: "toolCall", id: "direct-write", name: "write", arguments: { path: process.env.PROFILE_TARGET!, content: "changed" } },
        ] : probe ? [{ type: "toolCall", id: "probe", name: "profile_probe", arguments: {} }] : [{ type: "text", text: "done" }],
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        timestamp: Date.now(), stopReason: toolUse ? "toolUse" : "stop" };
      queueMicrotask(() => {
        stream.push({ type: "start", partial: message });
        stream.push({ type: "done", reason: toolUse ? "toolUse" : "stop", message });
        stream.end();
      });
      return stream;
    },
  });
}

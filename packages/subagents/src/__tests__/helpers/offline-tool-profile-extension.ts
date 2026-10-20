import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { writeFileSync } from "node:fs";

/** Offline fixture: records actual model declarations and attempts excluded nested tools. */
export default function (pi: ExtensionAPI): void {
  let declared: string[] = [];
  let calls = 0;
  pi.registerTool({
    name: "profile_probe", label: "Profile probe", description: "Inspect tool access", parameters: Type.Object({}),
    async execute(_id, _args, _signal, _update, ctx) {
      const errors: Record<string, string> = {};
      for (const name of ["edit", "write"]) {
        try {
          const outcome = await ctx.executeTool(name, name === "edit"
            ? { path: process.env.PROFILE_TARGET!, oldText: "original", newText: "changed" }
            : { path: process.env.PROFILE_TARGET!, content: "changed" });
          if (outcome.isError) errors[name] = outcome.result.content.filter(item => item.type === "text").map(item => item.text).join("\n");
        } catch (error) { errors[name] = String(error); }
      }
      writeFileSync(process.env.PROFILE_EVIDENCE!, JSON.stringify({
        declared, active: pi.getActiveTools(), registered: pi.getAllTools().map(tool => tool.name),
        callable: ctx.tools.map(tool => tool.name), errors,
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
        for (const tool of message.toolsAdded ?? []) tools.add(tool.name);
        for (const tool of message.toolsRemoved ?? []) tools.delete(tool.name);
      }
      declared = [...tools];
      const stream = createAssistantMessageEventStream();
      const probe = ++calls === 1;
      const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
        content: probe ? [{ type: "toolCall", id: "probe", name: "profile_probe", arguments: {} }] : [{ type: "text", text: "done" }],
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        timestamp: Date.now(), stopReason: probe ? "toolUse" : "stop" };
      queueMicrotask(() => {
        stream.push({ type: "start", partial: message });
        stream.push({ type: "done", reason: probe ? "toolUse" : "stop", message });
        stream.end();
      });
      return stream;
    },
  });
}

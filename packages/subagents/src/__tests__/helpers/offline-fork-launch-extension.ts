import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { writeFileSync } from "node:fs";

export default function (pi: ExtensionAPI): void {
  let sessionFile: string | undefined;
  pi.on("session_start", (_event, ctx) => { sessionFile = ctx.sessionManager.getSessionFile(); });
  pi.registerProvider("spider-offline-fork", {
    baseUrl: "https://offline.invalid", apiKey: "fixture-only", api: "spider-offline-fork-api",
    models: [{ id: "fixture", name: "Offline fork", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 100,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    streamSimple(model, context) {
      writeFileSync(process.env.FORK_EVIDENCE!, JSON.stringify({ sessionFile, messages: context.messages }));
      const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
        content: [{ type: "text", text: "Fork child finished" }],
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        timestamp: Date.now(), stopReason: "stop" };
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        stream.push({ type: "start", partial: message });
        stream.push({ type: "done", reason: "stop", message });
        stream.end();
      });
      return stream;
    },
  });
}

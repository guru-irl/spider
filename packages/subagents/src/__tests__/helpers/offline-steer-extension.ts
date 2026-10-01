import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { existsSync, watch } from "node:fs";

/** Fixture only: no network or real model. Release the first response from the test. */
export default function (pi: ExtensionAPI): void {
  const watchers = new Set<ReturnType<typeof watch>>();
  let calls = 0;
  pi.on("input", async event => {
    if (event.text.includes("INJECT_THEN_PASS")) { void pi.sendUserMessage("unrelated injected", { deliverAs: "steer" }); await new Promise(r => setTimeout(r, 50)); return { action: "continue" }; }
    if (event.text.includes("HANG_STEER")) await new Promise(() => {});
    if (event.text.includes("SWALLOW_STEER")) return { action: "handled" };
    if (event.text.includes("TRANSFORM_STEER")) return { action: "transform", text: "transformed instruction" };
    return { action: "continue" };
  });
  pi.on("session_shutdown", () => { for (const watcher of watchers) watcher.close(); watchers.clear(); });
  pi.registerProvider("spider-offline", {
    baseUrl: "https://offline.invalid", apiKey: "fixture-only", api: "spider-offline-api",
    models: [{ id: "fixture", name: "Offline fixture", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 100,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    streamSimple(model) {
      const stream = createAssistantMessageEventStream();
      const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id, content: [],
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        timestamp: Date.now(), stopReason: "pending" };
      const finish = () => {
        message.content = [{ type: "text", text: "offline report" }]; message.stopReason = "stop";
        stream.push({ type: "text_start", contentIndex: 0, partial: message });
        stream.push({ type: "text_delta", contentIndex: 0, delta: "offline report", partial: message });
        stream.push({ type: "text_end", contentIndex: 0, content: "offline report", partial: message });
        stream.push({ type: "done", reason: "stop", message }); stream.end();
      };
      stream.push({ type: "start", partial: message });
      if (++calls === 1) {
        const release = process.env.STEER_RELEASE_FILE!;
        const watcher = watch(release, () => { watcher.close(); watchers.delete(watcher); finish(); });
        watchers.add(watcher);
        // Test creates the file before startup and rewrites it after sending steers.
        if (!existsSync(release)) throw new Error("Missing release fixture");
      } else queueMicrotask(finish);
      return stream;
    },
  });
}

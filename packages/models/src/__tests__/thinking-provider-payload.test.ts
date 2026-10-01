import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { InMemoryCredentialStore, InMemoryModelsStore } from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime, parseArgs } from "@earendil-works/pi-coding-agent";
import { complete, type ModelEntry } from "../index";

const servers: Server[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

async function fixture(api: "openai-completions" | "anthropic-messages", map: Record<string, string | null>, reasoning = true) {
  const payloads: any[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    payloads.push(JSON.parse(Buffer.concat(chunks).toString()));
    response.writeHead(200, { "content-type": "text/event-stream" });
    if (api === "openai-completions") {
      for (const chunk of [
        { id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture-model", choices: [{ index: 0, delta: { role: "assistant", content: "fixture text" }, finish_reason: null }] },
        { id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture-model", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      ]) response.write(`data: ${JSON.stringify(chunk)}\n\n`);
      response.end("data: [DONE]\n\n");
    } else {
      const events = [
        { type: "message_start", message: { id: "fixture", type: "message", role: "assistant", model: "fixture-model", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "fixture text" } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
        { type: "message_stop" },
      ];
      for (const event of events) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      response.end();
    }
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw Error("fixture server has no port");
  // No personal files, ambient auth, catalog refreshes, or external model requests.
  vi.stubEnv("PI_OFFLINE", "1");
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(), modelsPath: null, refreshOnCreate: false });
  const registry = new ModelRegistry(runtime);
  registry.registerProvider("fixture-provider", {
    api, apiKey: "fixture-key", baseUrl: `http://127.0.0.1:${address.port}/v1`,
    models: [{ id: "fixture-model", name: "Fixture", reasoning, thinkingLevelMap: map, input: ["text"], contextWindow: 128000, maxTokens: 8192,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, compat: api === "anthropic-messages" ? { forceAdaptiveThinking: true } : { supportsReasoningEffort: true },
    }],
  });
  const entry: ModelEntry = { provider: "fixture-provider", id: "fixture-model", tier: "standard", thinking: reasoning, vision: false, ctx: 128000, speed: 1, costHint: 0, available: true };
  return { registry, entry, payloads };
}

describe.each(["openai-completions", "anthropic-messages"] as const)("real registry %s provider payload", api => {
  it.each([
    ["supported", { xhigh: "xhigh", max: "max" }, "max", "max", "max"],
    ["capped", { xhigh: "xhigh", max: null }, "max", "xhigh", "xhigh"],
    ["hole prefers higher", { xhigh: null, max: "max" }, "xhigh", "max", "max"],
    ["explicit provider alias", { xhigh: "high", max: null }, "max", "xhigh", "high"],
  ] as const)("sends the effective effort when %s", async (_name, map, requested, effective, sent) => {
    const { registry, entry, payloads } = await fixture(api, map);
    const diagnostics: any[] = [];
    expect(await complete(entry, "fixture", { registry, thinkingLevel: requested, onThinking: info => diagnostics.push(info) })).toBe("fixture text");
    expect(payloads).toHaveLength(1);
    if (api === "openai-completions") expect(payloads[0].reasoning_effort).toBe(sent);
    else {
      expect(payloads[0].thinking).toMatchObject({ type: "adaptive" });
      expect(payloads[0].output_config.effort).toBe(sent);
    }
    expect(diagnostics[0].effective).toBe(effective);
    if (sent !== effective) expect(diagnostics[0]).toMatchObject({ providerValue: sent, notice: expect.stringContaining(`provider value: ${sent}`) });
  });
  it("sends no reasoning for a non-reasoning model and reports off", async () => {
    const { registry, entry, payloads } = await fixture(api, {}, false);
    const diagnostics: any[] = [];
    await complete(entry, "fixture", { registry, thinkingLevel: "max", onThinking: info => diagnostics.push(info) });
    expect(payloads[0].reasoning_effort).toBeUndefined();
    expect(payloads[0].thinking).toBeUndefined();
    expect(diagnostics[0]).toMatchObject({ effective: "off", notice: expect.stringMatching(/thinking is off for this model/) });
  });
});

it("pi's public CLI parser accepts the explicit --thinking max flag", () => {
  expect(parseArgs(["--thinking", "max"]).thinking).toBe("max");
});

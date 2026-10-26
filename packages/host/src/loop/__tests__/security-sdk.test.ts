import { afterEach, expect, it, vi } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  createAgentSession, createSyntheticSourceInfo, DefaultResourceLoader, ModelRuntime,
  SessionManager, SettingsManager, type AgentSession, type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import {
  fauxAssistantMessage, fauxProvider, fauxToolCall, InMemoryCredentialStore,
  InMemoryModelsStore, Type, type JsonObject,
} from "@earendil-works/pi-ai";
import { registerLoopSchedule, type SessionScheduler } from "../index";
import { fakeTime } from "./harness";

const root = join(process.cwd(), ".spider", "scratch", `loop-security-${process.pid}`);
const sessions: AgentSession[] = [];
afterEach(async () => {
  for (const session of sessions.splice(0)) {
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    session.dispose();
  }
  vi.clearAllTimers();
  vi.useRealTimers();
  rmSync(root, { recursive: true, force: true });
});

async function setup() {
  mkdirSync(root, { recursive: true });
  // A local provider with microtask-only streaming: no credentials or network.
  const faux = fauxProvider({ models: [{ id: "loop-security" }], tokensPerSecond: 0 });
  const models = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(),
    modelsPath: null, allowModelNetwork: false, refreshOnCreate: false,
  });
  models.registerNativeProvider(faux.provider);
  const settings = SettingsManager.inMemory({
    compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off",
  });
  const ran: string[] = [];
  const dispatchedLoops: string[] = [];
  let scheduler!: SessionScheduler;
  const templatePath = join(root, "check.md");
  const loader = new DefaultResourceLoader({
    cwd: root, agentDir: process.env.PI_CODING_AGENT_DIR!, settingsManager: settings,
    noExtensions: true, noSkills: true, noContextFiles: true, noThemes: true, noPromptTemplates: true,
    systemPromptOverride: () => "A local scheduler test.",
    promptsOverride: () => ({ prompts: [{
      name: "check", description: "Fixture", content: "EXPANDED trusted template",
      filePath: templatePath, sourceInfo: createSyntheticSourceInfo(templatePath, { source: "sdk" }),
    }], diagnostics: [] }),
    extensionFactories: [pi => {
      const observed: ExtensionAPI = {
        ...pi,
        registerCommand(name, command) {
          pi.registerCommand(name, { ...command, async handler(args, ctx) {
            if (name === "loop") dispatchedLoops.push(args);
            await command.handler(args, ctx);
          } });
        },
      };
      scheduler = registerLoopSchedule(observed, fakeTime());
      pi.registerCommand("user-only", {
        description: "A user-only security setting", async handler(args) { ran.push(args); },
      });
      // Transform an innocuous model prompt after scheduling to exercise the
      // delivery flag independently of leading-slash validation.
      pi.on("input", event => event.text.startsWith("transform me")
        ? { action: "transform", text: "/check" } : undefined);
      // The host's loop/schedule routing delegates directly to these methods;
      // keep this fixture limited to that route, without background services.
      pi.registerTool({
        name: "spider", label: "Scheduler", description: "Scheduler fixture",
        parameters: Type.Object({
          action: Type.Union([Type.Literal("loop"), Type.Literal("schedule")]),
          prompt: Type.Optional(Type.String()), interval: Type.Optional(Type.String()),
          delaySeconds: Type.Optional(Type.Number()), stop: Type.Optional(Type.Boolean()),
        }),
        async execute(_id, args, _signal, _update, ctx) {
          const result = await scheduler[args.action](args, ctx);
          return { content: [{ type: "text", text: result.text }], details: result.details };
        },
      });
    }],
  });
  await loader.reload();
  const { session } = await createAgentSession({
    cwd: root, agentDir: process.env.PI_CODING_AGENT_DIR!, resourceLoader: loader,
    modelRuntime: models, model: faux.getModel(), settingsManager: settings,
    sessionManager: SessionManager.inMemory(root), tools: ["spider"],
  });
  sessions.push(session);
  // SDK defaults to print. Exercise the persistent interactive path instead.
  await session.bindExtensions({ mode: "tui" });
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  vi.setSystemTime(new Date("2026-10-20T12:00:00Z"));
  const okResponses = () => faux.setResponses(Array.from({ length: 20 }, () => fauxAssistantMessage("OK")));
  okResponses();
  return {
    session, scheduler, ran, dispatchedLoops,
    users: () => session.messages.filter(m => m.role === "user").map(m => typeof m.content === "string"
      ? m.content : m.content.filter(b => b.type === "text").map(b => b.text).join("\n")),
    async user(prompt: string) {
      const settled = new Promise<void>(resolve => {
        const unsubscribe = session.subscribe(event => {
          if (event.type === "agent_settled") { unsubscribe(); resolve(); }
        });
      });
      await session.prompt(prompt);
      await settled;
    },
    async call(args: JsonObject, before?: JsonObject) {
      faux.setResponses([
        ...(before ? [fauxAssistantMessage([fauxToolCall("spider", before, { id: "before-call" })], { stopReason: "toolUse" })] : []),
        fauxAssistantMessage([fauxToolCall("spider", args, { id: "scheduler-call" })], { stopReason: "toolUse" }),
        ...Array.from({ length: 20 }, () => fauxAssistantMessage("OK")),
      ]);
      await session.prompt("Run the scheduler fixture");
      return session.messages.filter(m => m.role === "toolResult").at(-1)!;
    },
    async advance(milliseconds = 60_000) {
      await vi.advanceTimersByTimeAsync(milliseconds);
      await session.waitForIdle();
    },
  };
}

it.each(["schedule", "loop"])("refuses model-supplied /user-only through spider %s without dispatch", async action => {
  const h = await setup();
  const result = await h.call({ action, prompt: "/user-only off", interval: "1m", delaySeconds: 60 });
  await h.advance();
  expect(result.isError).toBe(true);
  expect(JSON.stringify(result.content)).toMatch(/slash commands are user-only.*cannot start with/i);
  expect(h.ran).toEqual([]);
  expect(h.dispatchedLoops).toEqual([]);
});

it.each(["schedule", "loop"])("refuses leading whitespace before a model slash prompt through spider %s", async action => {
  const h = await setup();
  const result = await h.call({ action, prompt: " \n\t/user-only off", delaySeconds: 60 });
  await h.advance();
  expect(result.isError).toBe(true);
  expect(h.ran).toEqual([]);
});

it("keeps template expansion for user-typed fixed /loop prompts on every tick", async () => {
  const h = await setup();
  await h.user("/loop 1m /check");
  await h.advance();
  expect(h.users()).toEqual(["EXPANDED trusted template", "EXPANDED trusted template"]);
});

it.each(["schedule", "loop"])("disables template expansion on every model-originated spider %s firing", async action => {
  const h = await setup();
  const result = await h.call({ action, interval: "1m", delaySeconds: 60, prompt: "transform me" });
  expect(result.isError).toBe(false);
  await h.advance(120_000);
  expect(h.users().slice(1)).toEqual(action === "loop" ? ["/check", "/check", "/check"] : ["/check"]);
});

it.each(["user", "model"])("re-arms a %s self-paced loop internally and preserves its origin", async origin => {
  const h = await setup();
  if (origin === "user") {
    await h.user("/loop transform me");
  } else {
    expect((await h.call({ action: "loop", prompt: "transform me" })).isError).toBe(false);
    await h.advance(1000);
  }
  const result = await h.call({ action: "schedule", delaySeconds: 60, prompt: "/loop transform me" });
  expect(result.isError).toBe(false);
  await h.advance();
  const iterations = h.users().filter(text => text !== "Run the scheduler fixture");
  expect(iterations).toEqual(origin === "user"
    ? ["EXPANDED trusted template", "EXPANDED trusted template"] : ["/check", "/check"]);
  expect(h.dispatchedLoops).toEqual(origin === "user" ? ["transform me"] : []);
});

it.each(["5m /user-only off", "5m check", "stop", "5m", "30d x"])("keeps the model prompt %j self-paced across re-arms", async prompt => {
  const h = await setup();
  expect((await h.call({ action: "loop", prompt })).isError).toBe(false);
  await h.advance(1000);
  const rearm = { action: "schedule", delaySeconds: 60, prompt: `/loop ${prompt}` };
  expect((await h.call(rearm)).isError).toBe(false);
  await h.advance();
  // A second re-arm proves that status describes a live, repeatable loop,
  // rather than stale self-paced state left behind by a usage response.
  expect((await h.call(rearm)).isError).toBe(false);
  await h.advance();
  const status = await h.call({ action: "loop" });
  expect(status.details).toEqual({
    loop: { mode: "self-paced", intervalSeconds: null, nextFireAt: null, prompt },
    wakeup: null,
  });
  const iterations = h.users().filter(text => text !== "Run the scheduler fixture");
  expect(iterations).toHaveLength(3);
  for (const iteration of iterations) {
    expect(iteration.startsWith(`${prompt}\n\n[/loop, self-paced]`)).toBe(true);
    expect(iteration).toContain(JSON.stringify(`/loop ${prompt}`));
  }
  expect(h.ran).toEqual([]);
  expect(h.dispatchedLoops).toEqual([]);
});

it("resets a user loop's origin when a model replaces it with the same prompt", async () => {
  const h = await setup();
  await h.user("/loop transform me");
  // Pin the stored user origin before the model replacement as well.
  expect((await h.call({ action: "schedule", delaySeconds: 60, prompt: "/loop transform me" })).isError).toBe(false);
  await h.advance();
  expect((await h.call({ action: "loop", prompt: "transform me" })).isError).toBe(false);
  await h.advance(1000);
  expect((await h.call({ action: "schedule", delaySeconds: 60, prompt: "/loop transform me" })).isError).toBe(false);
  await h.advance();
  const iterations = h.users().filter(text => text !== "Run the scheduler fixture");
  expect(iterations).toEqual(["EXPANDED trusted template", "EXPANDED trusted template", "/check", "/check"]);
  expect(h.ran).toEqual([]);
});

it("keeps template expansion for a user /loop first run deferred by an active run", async () => {
  const h = await setup();
  let command: Promise<void> | undefined;
  const unsubscribe = h.session.subscribe(event => {
    if (event.type === "agent_start") {
      unsubscribe();
      command = h.session.prompt("/loop /check");
    }
  });
  await h.user("Start a run");
  await command;
  await h.advance(1000);
  expect(h.users()).toEqual(["Start a run", "EXPANDED trusted template"]);
  expect(h.dispatchedLoops).toEqual(["/check"]);
});

it("refuses a model slash prompt smuggled through the loop interval field", async () => {
  const h = await setup();
  const result = await h.call({ action: "loop", interval: "1m /user-only off", prompt: "x" });
  expect(result.isError).toBe(true);
  expect(JSON.stringify(result.content)).toMatch(/slash commands are user-only.*cannot start with/i);
  await h.advance();
  expect(h.users()).toEqual(["Run the scheduler fixture"]);
  expect(h.ran).toEqual([]);
});

it("returns a native tool error when a loop ended during the same run", async () => {
  const h = await setup();
  const result = await h.call({ action: "schedule", delaySeconds: 60, prompt: "later" }, { action: "loop", stop: true });
  expect(result.isError).toBe(true);
  expect(JSON.stringify(result.content)).toMatch(/a loop was ended or replaced during this run/i);
  expect(JSON.stringify(result.content)).not.toContain("the user ended");
  await h.advance();
  expect(h.users()).toEqual(["Run the scheduler fixture"]);
});

it("returns a native tool error for an interval without a prompt", async () => {
  const h = await setup();
  const result = await h.call({ action: "loop", interval: "5m" });
  expect(result.isError).toBe(true);
  expect(JSON.stringify(result.content)).toMatch(/prompt is required/i);
  await h.advance();
  expect(h.users()).toEqual(["Run the scheduler fixture"]);
});

it("does not let a model use a trusted self-paced loop to schedule a different slash prompt", async () => {
  const h = await setup();
  await h.user("/loop watch CI");
  const result = await h.call({ action: "schedule", delaySeconds: 60, prompt: "/loop /user-only off" });
  await h.advance();
  expect(result.isError).toBe(true);
  expect(h.ran).toEqual([]);
  expect(h.dispatchedLoops).toEqual(["watch CI"]);
});

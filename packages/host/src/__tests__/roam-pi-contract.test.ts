import { afterEach, expect, it, vi } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
  type AgentSession, type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, InMemoryCredentialStore, InMemoryModelsStore } from "@earendil-works/pi-ai";
import { protectAdmissionApi, registerAdmission, type AdmissionGate } from "../roam/admission";

const root = resolve(`.spider/scratch/roam-pi-contract-${process.pid}`);
const sessions: AgentSession[] = [];
afterEach(async () => {
  for (const session of sessions.splice(0)) {
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    session.dispose();
  }
  rmSync(root, { recursive: true, force: true });
});

async function setup(owner: "local" | "foreign") {
  mkdirSync(root, { recursive: true });
  const faux = fauxProvider({ models: [{ id: "roam-fixture" }], tokensPerSecond: 0 });
  faux.setResponses(Array.from({ length: 5 }, () => fauxAssistantMessage("fixture answer")));
  const models = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  models.registerNativeProvider(faux.provider);
  const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off" });
  let gate!: AdmissionGate, context!: ExtensionContext, effects = 0;
  let notice!: () => void;
  const loader = new DefaultResourceLoader({
    cwd: root, agentDir: process.env.PI_CODING_AGENT_DIR!, settingsManager: settings,
    noExtensions: true, noSkills: true, noContextFiles: true, noThemes: true, noPromptTemplates: true,
    systemPromptOverride: () => "A local admission test.",
    extensionFactories: [pi => {
      gate = registerAdmission(pi, {
        expectedEpoch: null,
        localMachine: async () => "origin.invalid", knownParticipant: () => true, warnOnce() {},
        async load(sessionId) { return {
          home: { sessionId, machineId: owner === "local" ? "origin.invalid" : "destination.invalid", epoch: 1, moveId: null, updatedAt: 1 },
          states: [{ sessionId, epoch: 1, state: "active", moveId: null, freezeSeq: null }],
          origin: "origin.invalid", participating: true, captureSafe: true, unfinishedFreeze: false, initialConflict: false,
        }; },
        lock: async () => async () => {},
      });
      const protectedPi = protectAdmissionApi(pi, gate);
      protectedPi.registerCommand("ordinary-fixture", { description: "Fixture command", handler: async () => { effects++; } });
      notice = () => protectedPi.sendMessage({ customType: "fixture", content: "unwanted notice", display: false }, { triggerTurn: true });
      pi.on("session_start", (_event, ctx) => { context = ctx; });
    }],
  });
  await loader.reload();
  const { session } = await createAgentSession({
    cwd: root, agentDir: process.env.PI_CODING_AGENT_DIR!, resourceLoader: loader,
    modelRuntime: models, model: faux.getModel(), settingsManager: settings,
    sessionManager: SessionManager.create(root, join(root, "sessions")), noTools: "all",
  });
  sessions.push(session);
  await session.bindExtensions({ mode: "tui" });
  return { session, gate, context, provider: faux, notice, effects: () => effects };
}

it("nonowner input stops before any provider request and does not append a message", async () => {
  const f = await setup("foreign");
  const leaf = f.context.sessionManager.getLeafId();
  await f.session.prompt("do work");
  const providerRequests = f.provider.state.callCount;
  expect(providerRequests).toBe(0);
  expect(f.context.sessionManager.getLeafId()).toBe(leaf);
  expect(f.context.hasPendingMessages()).toBe(false);
}, 5000);

it("an admitted session stops queued input after its gate freezes", async () => {
  const f = await setup("local");
  await f.session.prompt("initial request");
  expect(f.provider.state.callCount).toBe(1);
  const leaf = f.context.sessionManager.getLeafId();
  await f.gate.freeze("move-1", 1);
  await f.session.sendUserMessage("after freeze");
  expect(f.provider.state.callCount).toBe(1);
  expect(f.context.sessionManager.getLeafId()).toBe(leaf);
  expect(f.context.hasPendingMessages()).toBe(false);
}, 5000);

it("nonowner slash commands and notices cannot start ordinary work", async () => {
  const f = await setup("foreign");
  const leaf = f.context.sessionManager.getLeafId();
  await f.session.prompt("/ordinary-fixture");
  f.notice();
  await f.session.waitForIdle();
  expect(f.effects()).toBe(0);
  expect(f.provider.state.callCount).toBe(0);
  expect(f.context.sessionManager.getLeafId()).toBe(leaf);
}, 5000);

it("the SDK runner blocks tools and user shell before their operations", async () => {
  const f = await setup("foreign");
  const tool = await f.session.extensionRunner.emitToolCall({ type: "tool_call", toolName: "write", toolCallId: "fixture", input: { path: "ignored", content: "no" } });
  expect(tool).toMatchObject({ block: true });
  const shell = await f.session.extensionRunner.emitUserBash({ type: "user_bash", command: "fixture", cwd: root, excludeFromContext: false });
  const exec = vi.fn(async () => ({ exitCode: 0 }));
  if (!shell?.result) await f.session.executeBash("fixture", undefined, { operations: { exec } });
  expect(shell).toMatchObject({ result: { exitCode: 1, cancelled: false } });
  expect(exec).not.toHaveBeenCalled();
  expect(f.provider.state.callCount).toBe(0);
}, 5000);

it("a custom message that bypasses input is aborted before the provider request", async () => {
  const f = await setup("foreign");
  await f.session.sendCustomMessage({ customType: "fixture", content: "unwanted notice", display: false }, { triggerTurn: true });
  await f.session.waitForIdle();
  expect(f.provider.state.callCount).toBe(0);
  expect(f.context.hasPendingMessages()).toBe(false);
}, 5000);

import { afterEach, expect, it, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { paths } from "@spider/db-core";
import { pathToFileURL } from "node:url";
import {
  createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
  type AgentSession, type ExtensionCommandContextActions, type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { fauxProvider, InMemoryCredentialStore, InMemoryModelsStore } from "@earendil-works/pi-ai";
import { registerAutoReload } from "../auto-reload.js";

const initial = { sha: "aaaaaaa", dirty: false, builtAt: "2026-01-01T00:00:00.000Z", version: "0.1.0" };
const updated = { sha: "bbbbbbb", dirty: false, builtAt: "2026-01-02T00:00:00.000Z", version: "0.1.0" };
const root = join(paths.scratch("worktree", process.cwd()), `auto-reload-pi-${process.pid}`);
let session: AgentSession | undefined;

afterEach(async () => {
  if (session) {
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    session.dispose(); session = undefined;
  }
  vi.useRealTimers();
  vi.unstubAllEnvs();
  delete (globalThis as Record<symbol, unknown>)[Symbol.for("spider.auto-reload.v1")];
  rmSync(root, { recursive: true, force: true });
});

it("runs the registered command through pi and reloads without input or model turns", async () => {
  mkdirSync(root, { recursive: true });
  vi.stubEnv("PI_SUBAGENT_CHILD", "0");
  delete (globalThis as Record<symbol, unknown>)[Symbol.for("spider.auto-reload.v1")];
  const file = join(root, "extension.js");
  const marker = (identity: typeof initial) => `// SPIDER_BUILD_ID=${identity.sha}@${identity.builtAt} v${identity.version}\n`;
  writeFileSync(file, marker(initial));
  writeFileSync(`${file}.ready`, marker(initial));
  const provider = fauxProvider({ models: [{ id: "fixture" }], tokensPerSecond: 0 });
  const models = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  models.registerNativeProvider(provider.provider);
  const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off" });
  let loaded = initial;
  let inputs = 0, turns = 0, reloads = 0;
  const notices: Array<[string, string | undefined]> = [];
  const errors: string[] = [];
  let updatedStart!: () => void;
  const updateStarted = new Promise<void>(resolve => { updatedStart = resolve; });
  const loader = new DefaultResourceLoader({
    cwd: root, agentDir: join(root, "agent"), settingsManager: settings,
    noExtensions: true, noSkills: true, noContextFiles: true, noThemes: true, noPromptTemplates: true,
    systemPromptOverride: () => "Local reload test.",
    extensionFactories: [pi => {
      registerAutoReload(pi, { identity: loaded, url: `${pathToFileURL(file).href}?build=fixture` }, () => true, () => true, () => false);
      pi.on("input", () => { inputs++; });
      pi.on("agent_start", () => { turns++; });
      pi.on("session_start", event => { if (event.reason === "reload") updatedStart(); });
    }],
  });
  await loader.reload();
  ({ session } = await createAgentSession({ cwd: root, agentDir: join(root, "agent"), resourceLoader: loader,
    modelRuntime: models, model: provider.getModel(), settingsManager: settings,
    sessionManager: SessionManager.inMemory(), noTools: "all" }));
  const ui = { notify: (message: string, type?: string) => notices.push([message, type]),
    getEditorText: () => "", onTerminalInput: () => () => {} } as unknown as ExtensionUIContext;
  const actions = { reload: async () => { reloads++; loaded = updated; await session!.reload(); } } as ExtensionCommandContextActions;
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-02-01T00:00:00.000Z"));
  await session.bindExtensions({ mode: "tui", uiContext: ui, commandContextActions: actions,
    onError: error => errors.push(error.error) });
  const before = session.sessionManager.getEntries().length;
  writeFileSync(file, marker(updated));
  writeFileSync(`${file}.ready`, marker(updated));

  await vi.advanceTimersByTimeAsync(30_000);
  expect(reloads).toBe(0);
  await vi.advanceTimersByTimeAsync(30_000);
  await updateStarted;
  expect(reloads).toBe(1);
  expect(notices).toEqual([["Spider updated to bbbbbbb.", "info"]]);
  expect(inputs).toBe(0);
  expect(turns).toBe(0);
  expect(provider.state.callCount).toBe(0);
  expect(session.sessionManager.getEntries()).toHaveLength(before);
  expect(errors).toEqual([]);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(reloads).toBe(1);
}, 5000);

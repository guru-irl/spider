import { afterEach, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, InMemoryCredentialStore, InMemoryModelsStore } from "@earendil-works/pi-ai";
import { openDbAt, paths, setGlobalDbPathForTests, type Db } from "@spider/db-core";
import spiderExtension from "../extension";

const root = resolve(`.spider/scratch/roam-pi-shell-fence-${process.pid}`);
const originalGlobalRoot = paths.globalRoot;
let session: AgentSession | undefined;
const dbs: Db[] = [];
afterEach(async () => {
  if (session) {
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    session.dispose(); session = undefined;
  }
  for (const db of dbs.splice(0)) db.close();
  paths.globalRoot = originalGlobalRoot; setGlobalDbPathForTests(null);
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

it("refused shell on a frozen copy writes no db rows and runs nothing", async () => {
  const cwd = join(root, "workspace"), globalRoot = join(root, "global");
  mkdirSync(cwd, { recursive: true }); mkdirSync(globalRoot, { recursive: true, mode: 0o700 });
  execFileSync("git", ["init", "-q", cwd]);
  vi.stubEnv("GIT_CEILING_DIRECTORIES", root); vi.stubEnv("PI_SUBAGENT_CHILD", "0");
  paths.globalRoot = globalRoot; vi.stubEnv("SPIDER_GLOBAL_ROOT", globalRoot);
  setGlobalDbPathForTests(join(globalRoot, "spider.db"));
  const global = openDbAt(join(globalRoot, "spider.db"), "global");
  const worktree = openDbAt(join(cwd, ".spider", "project.db"), "worktree");
  dbs.push(global, worktree);
  const manager = SessionManager.create(cwd, join(root, "sessions"));
  manager.appendMessage(fauxAssistantMessage("existing history"));
  const id = manager.getSessionId(), file = manager.getSessionFile()!;
  const machine = (global.prepare("SELECT machine_id FROM roam_meta WHERE id = 1").get() as { machine_id: string }).machine_id;
  worktree.prepare("UPDATE roam_meta SET store_key = ?, capture_enabled = 1 WHERE id = 1").run("worktree:fixture:current");
  worktree.prepare("INSERT INTO sessions(id, reason, started_at, origin_machine) VALUES (?, ?, ?, ?)").run(id, "fixture", 1, machine);
  worktree.prepare("INSERT INTO roam_sessions(session_id, epoch, state, move_id) VALUES (?, ?, ?, ?)").run(id, 1, "frozen", "move-1");
  global.prepare("INSERT INTO session_homes(session_id, machine_id, epoch, updated_at) VALUES (?, ?, ?, ?)").run(id, "destination.invalid", 1, 1);

  const provider = fauxProvider({ models: [{ id: "roam-fixture" }], tokensPerSecond: 0 });
  provider.setResponses([fauxAssistantMessage("unexpected response")]);
  const models = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  models.registerNativeProvider(provider.provider);
  const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off" });
  const loader = new DefaultResourceLoader({
    cwd, agentDir: process.env.PI_CODING_AGENT_DIR!, settingsManager: settings,
    noExtensions: true, noSkills: true, noContextFiles: true, noThemes: true, noPromptTemplates: true,
    systemPromptOverride: () => "A local admission test.",
    extensionFactories: [pi => spiderExtension(pi as unknown as Parameters<typeof spiderExtension>[0])],
  });
  await loader.reload();
  ({ session } = await createAgentSession({ cwd, agentDir: process.env.PI_CODING_AGENT_DIR!, resourceLoader: loader,
    modelRuntime: models, model: provider.getModel(), settingsManager: settings, sessionManager: manager, noTools: "all" }));
  await session.bindExtensions({ mode: "tui" });
  const before = readFileSync(file, "utf8");
  const versions = [global, worktree].map(db => db.raw.pragma("data_version", { simple: true }));
  const execute = vi.spyOn(session, "executeBash").mockResolvedValue({ output: "", exitCode: 0, cancelled: false, truncated: false });

  await session.prompt("/loop 1m check");
  const tool = await session.extensionRunner.emitToolCall({ type: "tool_call", toolName: "write", toolCallId: "fixture", input: { path: "ignored", content: "no" } });
  const shell = await session.extensionRunner.emitUserBash({ type: "user_bash", command: "fixture", cwd, excludeFromContext: false });
  if (shell?.result) session.recordBashResult("fixture", shell.result, { excludeFromContext: false });
  else await session.executeBash("fixture");

  expect(tool).toMatchObject({ block: true });
  expect(shell).toMatchObject({ result: { exitCode: 1 } });
  expect(execute).not.toHaveBeenCalled();
  expect(provider.state.callCount).toBe(0);
  expect([global, worktree].map(db => db.raw.pragma("data_version", { simple: true }))).toEqual(versions);
  // Pi's TUI records even a refused shell result. This Pi-owned append is the documented exception.
  const after = readFileSync(file, "utf8");
  expect(after.startsWith(before)).toBe(true);
  const appended = after.slice(before.length).trim().split("\n").map(line => JSON.parse(line));
  expect(appended).toHaveLength(1);
  expect(appended[0]).toMatchObject({ type: "message", message: { role: "bashExecution", command: "fixture", exitCode: 1 } });
  await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  expect([global, worktree].map(db => db.raw.pragma("data_version", { simple: true }))).toEqual(versions);
  expect(existsSync(join(globalRoot, "usage.db"))).toBe(false);
  expect(readFileSync(file, "utf8")).toBe(after);
  session.dispose(); session = undefined;
}, 5000);

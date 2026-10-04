import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { paths, openDbAt, resolveProject, setGlobalDbPathForTests } from "@spider/db-core";
import { addMemory, upsertVector, resolveEmbedder, getReadyEmbedder, isEmbedderLoaded, stopEmbedder } from "@spider/memory";
import spiderExtension from "../extension";
import { controlConfig } from "../control";

const fixture = vi.hoisted(() => ({ inits: 0, alive: 0, calls: 0 }));
vi.mock("fastembed", () => ({ EmbeddingModel: { BGESmallENV15: "fixture" }, FlagEmbedding: { async init() {
  fixture.inits++;
  return { async *embed(texts: string[]) { yield texts.map(() => new Float32Array(384)); } };
} } }));
vi.mock("node:worker_threads", async () => {
  const { providerWorker } = await import("../../../memory/src/__tests__/helpers/provider-worker");
  const Base = providerWorker(() => import("fastembed"));
  return { Worker: class extends Base {
    constructor(...args: ConstructorParameters<typeof Base>) { super(...args); fixture.alive++; }
    async terminate() { fixture.alive--; return super.terminate(); }
  } };
});
vi.mock("@spider/models", async importOriginal => {
  const actual = await importOriginal<typeof import("@spider/models")>();
  return { ...actual, async complete() { fixture.calls++; return '{"memory":[],"todos":[],"skills":[]}'; } };
});
let root: string;
let shutdown: (() => Promise<void>) | undefined;
beforeEach(() => {
  fixture.inits = fixture.alive = fixture.calls = 0;
  vi.stubEnv("PI_SUBAGENT_CHILD", "0");
  root = join(paths.globalRoot, `embedding-shutdown-${randomUUID()}`); mkdirSync(root);
  vi.stubEnv("GIT_CEILING_DIRECTORIES", paths.globalRoot);
  setGlobalDbPathForTests(join(root, "global.db"));
  controlConfig("set", root, "embeddings.drain", false);
  for (const name of ["runMemoryTodo", "todoMemory", "learning", "consolidation", "insights"]) controlConfig("set", root, `organism.passes.${name}`, false);
  controlConfig("set", root, "skills.curator.enabled", false);
});
afterEach(async () => {
  await shutdown?.(); shutdown = undefined; await stopEmbedder();
  vi.unstubAllEnvs(); setGlobalDbPathForTests(null); rmSync(root, { recursive: true, force: true });
});
it("keeps the ready embedder for shutdown reflection, then terminates it without respawning", async () => {
  const hooks = new Map<string, Array<(...args: any[]) => unknown>>();
  const pi = { registerTool() {}, registerCommand() {}, registerMessageRenderer() {}, appendEntry() {},
    on(name: string, fn: (...args: any[]) => unknown) { hooks.set(name, [...hooks.get(name) ?? [], fn]); } };
  const model = { provider: "github-copilot", id: "gpt-6-luna", name: "fixture", reasoning: true, input: ["text"], contextWindow: 100000, maxTokens: 4096,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, api: "openai-responses" };
  const entries = [{ type: "message", id: "user", timestamp: new Date().toISOString(), message: { role: "user", content: "fixture shutdown input", timestamp: Date.now() } }];
  const ctx = { cwd: root, hasUI: false, modelRegistry: { find: () => model, getAll: () => [model], getAvailable: () => [model], streamSimple() { throw new Error("real model call forbidden"); } },
    sessionManager: { getSessionId: () => "shutdown-fixture", getEntries: () => entries, getBranch: () => entries, buildContextEntries: () => entries } };
  const emit = async (name: string) => { for (const fn of hooks.get(name) ?? []) await fn({}, ctx); };
  spiderExtension(pi as never); shutdown = () => emit("session_shutdown");
  await emit("session_start");
  const ready = await resolveEmbedder(); expect(ready).not.toBeNull();
  const project = resolveProject(root);
  const repo = openDbAt(join(paths.projectRoot(project.projectKey), "repo.db"), "repo");
  try {
    const vector = new Float32Array(384); vector[0] = 1;
    for (let i = 0; i < 3; i++) {
      const memory = addMemory(repo, "repo", { category: "insight", content: `related fixture ${i}` });
      upsertVector(repo, "memory", memory.uuid, vector, "fixture");
    }
  } finally { repo.close(); }
  await shutdown(); shutdown = undefined;
  expect(fixture.calls).toBe(1); // Real reflection found a cluster using the ready adapter.
  expect(isEmbedderLoaded()).toBe(false);
  expect(fixture.alive).toBe(0);
  expect(getReadyEmbedder()).toBeNull();
  expect(await resolveEmbedder()).toBeNull();
  expect(fixture.inits).toBe(1);
});

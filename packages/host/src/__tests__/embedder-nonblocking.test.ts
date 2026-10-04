import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { paths, openDbAt, type Db } from "@spider/db-core";
import { addMemory, resolveEmbedder, upsertVector, startEmbedderSession } from "@spider/memory";
import { unifiedSearch } from "@spider/context";
import spiderExtension from "../extension";
import { getAction, clearActions } from "../dispatch";

// Only the external provider is replaced. Actions, recall/search, vector lookup,
// and the process-wide initialization cache are real and use fixture roots.
const provider = vi.hoisted(() => ({ inits: 0, pending: Promise.resolve() as Promise<void>, onInit: undefined as (() => void) | undefined }));
vi.mock("node:child_process", async importOriginal => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const { providerWorker } = await import("../../../memory/src/__tests__/helpers/provider-worker");
  const Base = providerWorker(() => import("fastembed"));
  return { ...actual, spawn: () => new Base() };
});
vi.mock("fastembed", () => ({
  EmbeddingModel: { BGESmallENV15: "fixture" },
  FlagEmbedding: { init: async () => {
    provider.inits++;
    provider.onInit?.();
    await provider.pending;
    return { async *embed(texts: string[]) {
      yield texts.map(() => Float32Array.from([1, ...new Array(383).fill(0)]));
    } };
  } },
}));
vi.mock("@huggingface/transformers", () => ({ pipeline: async () => { throw new Error("fixture unavailable"); } }));
const key = Symbol.for("spider.embedder.v3:BGE-small-en-v1.5");
const cache = globalThis as typeof globalThis & Record<symbol, unknown>;
const dbs: Db[] = [];
let repo: Db;
let global: Db;
let worktree: Db;
let shutdown: Array<() => Promise<unknown>> = [];

beforeEach(() => {
  startEmbedderSession();
  delete cache[key];
  shutdown = [];
  provider.inits = 0;
  provider.onInit = undefined;
  provider.pending = new Promise(() => {});
  repo = openDbAt(join(paths.globalRoot, `recall-repo-${randomUUID()}.db`), "repo");
  global = openDbAt(join(paths.globalRoot, `recall-global-${randomUUID()}.db`), "global");
  worktree = openDbAt(join(paths.globalRoot, `search-worktree-${randomUUID()}.db`), "worktree");
  dbs.push(repo, global, worktree);
  vi.stubEnv("PI_SUBAGENT_CHILD", "1"); // No background organism or model calls.
  spiderExtension({ registerTool() {}, registerCommand() {}, registerMessageRenderer() {},
    on(name: string, fn: () => Promise<unknown>) { if (name === "session_shutdown") shutdown.push(fn); },
  } as never);
});
afterEach(async () => {
  for (const hook of shutdown) await hook();
  clearActions();
  for (const db of dbs.splice(0)) db.close();
  delete cache[key];
  vi.unstubAllEnvs();
});

// A pending provider must not make the action reach this deadline. Clear the
// timer on both branches so a RED failure also leaves no handles behind.
async function promptly<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("action waited for initialization")), 100);
    })]);
  } finally { clearTimeout(timer!); }
}
const recallAction = (args: Record<string, unknown> = {}) => getAction("recall")!(
  { action: "recall", query: "needle", ...args }, { repoDb: repo, globalDb: global } as never,
) as Promise<{ details: Array<{ uuid: string; content: string }> }>;

it("returns FTS recall immediately while provider initialization never resolves", async () => {
  const started = new Promise<void>(resolve => { provider.onInit = resolve; });
  const memory = addMemory(repo, "repo", { category: "insight", content: "needle lexical match" });
  const first = await promptly(recallAction());
  const second = await promptly(recallAction());
  expect(first.details.map(r => r.uuid)).toEqual([memory.uuid]);
  expect(second.details.map(r => r.uuid)).toEqual([memory.uuid]);
  // Counts enforce initialization deduplication, not the provider's implementation.
  await promptly(started);
  expect(provider.inits).toBe(1);
});

it("uses vectors on a later recall after the same initialization finishes", async () => {
  let ready!: () => void;
  provider.pending = new Promise(resolve => { ready = resolve; });
  const lexical = addMemory(repo, "repo", { category: "insight", content: "needle lexical match" });
  const semantic = addMemory(repo, "repo", { category: "insight", content: "different words" });
  upsertVector(repo, "memory", semantic.uuid, Float32Array.from([1, ...new Array(383).fill(0)]), "BGE-small-en-v1.5");
  // Seed native rows using SQLite integers. Some sqlite-vec builds reject a
  // numeric JS rowid as REAL; that unrelated upsert issue is not under test.
  repo.exec("INSERT INTO vectors(rowid, embedding) SELECT rowid, embedding FROM vector_map WHERE rowid NOT IN (SELECT rowid FROM vectors)");
  expect((await promptly(recallAction())).details.map(r => r.uuid)).toEqual([lexical.uuid]);
  ready();
  await resolveEmbedder();
  expect((await promptly(recallAction())).details.map(r => r.uuid)).toEqual([semantic.uuid, lexical.uuid]);
  expect(provider.inits).toBe(1);
});

it.each([{ scope: "global" }, { query: undefined }, { query: "" }])("does not start initialization on non-vector recall %j", async args => {
  const scope = args.scope === "global" ? "global" : "repo";
  const memory = addMemory(scope === "global" ? global : repo, scope, { category: "insight", content: "needle match" });
  expect((await promptly(recallAction(args))).details.map(r => r.uuid)).toEqual([memory.uuid]);
  expect(cache[key]).toBeUndefined();
  expect(provider.inits).toBe(0);
});

it("returns FTS search with existing vectors while initialization is pending", async () => {
  const memory = addMemory(repo, "repo", { category: "insight", content: "needle search match" });
  upsertVector(repo, "memory", memory.uuid, Float32Array.from([1, ...new Array(383).fill(0)]), "BGE-small-en-v1.5");
  const rows = await promptly(unifiedSearch({ repoDb: repo, worktreeDb: worktree }, { query: "needle", kinds: ["memory"] }));
  expect(rows.map(r => r.id)).toEqual([memory.uuid]);
});

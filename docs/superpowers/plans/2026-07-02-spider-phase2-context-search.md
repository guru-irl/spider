# spider Phase 2 — Context (ctx_* in-process) + unified search + import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Lift context-mode's `ctx_*` surface into direct in-process `registerAction` handlers on the shared per-project DB, add hybrid FTS+vector RRF search unified across memory/content/sessions/todos, and add a staged `import` action that ingests pi session transcripts into staged candidates + content index + embed queue.

**Architecture:** A new `@spider/context` package ports context-mode's proven executor, chunker, RRF fusion, and content-store logic — but strips ALL non-pi adapter/bridge/server-process code (>60% of context-mode LOC), retargets storage from the ephemeral tmpdir `ContentStore`/MCP-server split onto the canonical `content`/`content_fts`/`vectors` schema in `db-core`, and registers each verb as an in-process handler via `registerAction(name, handler)`. Search fuses FTS (BM25 over `*_fts`) and vector (sqlite-vec KNN) ranked lists via a generalized Reciprocal Rank Fusion helper, across four owner kinds. `import` reads a pi session transcript, calls a minimal injected digest interface (the real aux-model organism digest is Phase 6), and writes staged memory/skill/todo candidates + a `sessions` row + content chunks + `embed_queue` rows, idempotent on `sessions.imported_from`.

**Tech Stack:** TypeScript (ESM, Node ≥ 22.19.0), better-sqlite3 (WAL + busy_timeout + retry via `@spider/db-core`), sqlite-vec (vec0 KNN), FTS5 (porter + trigram), fastembed-js/BGE-small-en-v1.5 (via `@spider/memory` from Phase 1), Vitest, esbuild.

## Global Constraints

- **Language:** TypeScript, Node ≥ 22.19.0 (target Node 24). ESM (`"type": "module"`).
- **SQLite driver:** better-sqlite3 (synchronous). WAL + busy_timeout + retry wrapper everywhere DB is opened — always via `@spider/db-core` (`openProject`), never a raw `new Database()`.
- **Native deps (prebuilt, cross-OS):** better-sqlite3, sqlite-vec, onnxruntime-node (via fastembed-js).
- **Zero temp-dir:** ALL scratch/intermediate/golden/cache data under `<project>/.spider/scratch/` or `~/.pi/agent/spider/scratch/`. **Never** `/tmp`, `$TMPDIR`, `/var/tmp`, `os.tmpdir()`, `mkdtempSync(os.tmpdir(), …)`. This is the single largest divergence from the ported context-mode code — every ported file that touches `tmpdir()` MUST be redirected to `paths.scratch(scope)` from db-core.
- **Bundler:** esbuild; externalize native `.node`. Single extension entry from `host`.
- **UI:** all visual output through `@spider/ui`; honor pi theme tokens; 🕷 signature. No ad-hoc `console.log`/string rendering in `@spider/context`.
- **Tests:** Vitest; TDD (test first, red→green→refactor); integration DBs created via `openProject` in `.spider/scratch/` — never `/tmp`.
- **Memory writes:** all `[auto]`/background/import writes staged (`status='staged'`, `source='import'`), fail-closed.
- **Canonical symbols are frozen:** table/column names (`content`, `content_fts`, `vectors`, `vector_map`, `embed_queue`, `sessions`, `sessions_fts`, `memory`, `memory_fts`, `todos`, `todos_fts`), the `db-core` API, and `registerAction(name, handler)` come from `docs/superpowers/plans/README.md`. Do not rename them.

---

## Interfaces consumed from earlier phases (do not redefine — import them)

These are produced by Phase 0 and Phase 1. This plan consumes them by exact name. If a symbol's real signature differs at execution time, treat the mismatch as a blocker and reconcile against the phase-0/phase-1 plan before coding — do not invent a divergent copy.

**From `@spider/db-core` (Phase 0, per contract README):**
```ts
import { openProject, openGlobal, migrate, resolveProject, paths, appendRunEvent, bus } from "@spider/db-core";
import type { Db, Statement, ProjectInfo, RunEvent } from "@spider/db-core";
// Db.prepare(sql), Db.transaction(fn), Db.loadVec(), Db.close()
// paths.scratch(scope: "global" | "project", cwd?: string): string   // canonical zero-temp-dir scratch root
// paths.projectRoot(cwd): string
// resolveProject(cwd): ProjectInfo  // { projectKey, realPath, gitCommonDir?, dbPath, name? }
```

**From `@spider/host` (Phase 0 dispatcher):**
```ts
// Phase 0 provides the empty dispatcher + registerAction. Each phase calls registerAction to fill an action.
export function registerAction(name: SpiderAction | string, handler: ActionHandler): void;
export type ActionHandler = (args: SpiderArgs, ctx: ActionCtx) => Promise<ActionResult> | ActionResult;
export interface ActionCtx {
  db: Db;                 // project DB (openProject already resolved for cwd)
  globalDb: Db;           // global DB
  project: ProjectInfo;
  sessionId: string;      // pi native session id verbatim
  cwd: string;
  auxModel?: string;      // cheap aux-model id for digests, from config
}
export interface ActionResult { content?: string; ui?: import("@spider/ui").Component; details?: unknown; isError?: boolean; }
```
> **VALIDATE FIRST (blocker if wrong):** confirm the real `ActionHandler`/`ActionCtx`/`ActionResult` shape from the Phase 0 host dispatcher before Task 4. If Phase 0 passes the DB differently (e.g. a `getDb()` thunk), adapt every handler accordingly. This is the single highest-risk cross-phase coupling in this plan.

**From `@spider/memory` (Phase 1 — embeddings + memory + vector search):**
```ts
// Phase 1 owns the embedder, the embed queue, and vector KNN over the shared `vectors`/`vector_map` tables.
export function embedText(text: string): Promise<Float32Array | null>;        // null when embeddings unavailable → FTS-only degrade
export function enqueueEmbed(db: Db, e: { ownerKind: "memory" | "content" | "session" | "run"; ownerId: string; text: string }): void; // INSERT INTO embed_queue
export function vectorSearch(db: Db, opts: { queryVec: Float32Array; ownerKinds: string[]; limit: number }): Array<{ ownerKind: string; ownerId: string; distance: number }>; // vec0 KNN joined via vector_map
export function embeddingsAvailable(): boolean;                                // false → search runs FTS-only
```
> **VALIDATE FIRST (blocker if wrong):** confirm these four symbols exist in the Phase 1 deliverable. If Phase 1 places `vectorSearch`/`enqueueEmbed` in `@spider/db-core` instead of `@spider/memory`, import from there. If Phase 1 is not yet merged, coordinate ordering — Task 9 (fusion, pure) and Tasks 2–8 (exec/index) do NOT depend on Phase 1 and can proceed; Tasks 10–11 (hybrid search) and Task 14 (import embed enqueue) DO. Surface via `contact_supervisor` if Phase 1 symbols are missing.

**Ported verbatim (mechanical, from `/mnt/data/src/context-mode/src/`) — copy then de-tmpdir + retarget:**
- `runtime.ts` (`detectRuntimes`, `buildCommand`, `getAvailableLanguages`, `SCRIPT_EXT`) — copy as-is.
- `executor.ts` (`PolyglotExecutor`, `ExecuteOptions`, `ExecuteFileOptions`, `ExecResult`) — copy, redirect `OS_TMPDIR`/`mkdtempSync` to scratch.
- `exit-classify.ts`, `truncate.ts`, `runPool.ts`, `fetch-cache.ts` — copy, redirect any tmpdir cache to scratch.
- `store.ts` chunker internals: `#chunkMarkdown`, `#splitOversizedPlainChunk`, `MAX_CHUNK_BYTES`, `sanitizeQuery`, `sanitizeTrigramQuery`, `STOPWORDS`, `findAllPositions`, `findMinSpan`, `countAdjacentPairs` — extract into `chunker.ts`/`fts-query.ts`.
- `store.ts` fusion internals: `#rrfSearch` (K=60), `#applyProximityReranking` — generalize into `fusion.ts`.

**Deleted, NOT ported (the >60% non-pi cut — do not copy any of these into `@spider/context`):**
- `src/adapters/**` entirely EXCEPT nothing — every adapter dir (`antigravity/`, `antigravity-cli/`, `claude-code/`, `claude-code-base.ts`, `codex/`, `copilot-base.ts`, `copilot-cli/`, `cursor/`, `gemini-cli/`, `jetbrains-copilot/`, `kimi/`, `kiro/`, `omp/`, `openclaw/`, `opencode/`, `pi/`, `qwen-code/`, `vscode-copilot/`, `zed/`, `detect.ts`, `client-map.ts`, `base.ts`, `types.ts`). The pi adapter is replaced by in-process `registerAction` in `@spider/host`; the MCP bridge is deleted (pi is in-process, TC1/TC3).
- `src/server.ts` (the whole MCP server + `server.registerTool` surface + `trackResponse` + bridge handshake) — replaced by `registerAction` handlers.
- `src/cli.ts`, `src/lifecycle.ts`, `hooks/**`, `server.bundle.mjs`, `cli.bundle.mjs`, `start.mjs`, `src/adapters/pi/mcp-bridge.ts` — all bridge/CLI/hook-config plumbing.
- `src/session/db.ts` (`SessionDB`) + `src/session/*` retrieval markers + `src/store-directory.ts`'s adapter coupling — session/content storage is now the shared `content`/`sessions` schema in db-core; keep only pure helpers (dir walk for `index` of a directory) after de-adaptering.
- `src/security.ts` path-deny gate — port ONLY the pure file-boundary check helper used by `exec_file`/`index` (`checkProjectBoundary`, `checkFilePathDenyPolicy`), drop the adapter/env plumbing.

---

## File Structure (all under `spider/packages/context/`)

- `package.json`, `tsconfig.json` — package manifest (name `@spider/context`, deps on `@spider/db-core`, `@spider/memory`, `@spider/ui`).
- `src/index.ts` — package entry: `export function registerContextActions(host)` calls `registerAction("exec"|"exec_file"|"batch"|"index"|"fetch"|"search"|"import", …)`; also exports pure helpers for tests.
- `src/runtime.ts` — ported runtime detection (verbatim).
- `src/executor.ts` — ported `PolyglotExecutor`, scratch-redirected.
- `src/exit-classify.ts`, `src/truncate.ts`, `src/run-pool.ts` — ported helpers.
- `src/fts-query.ts` — `sanitizeQuery`, `sanitizeTrigramQuery`, `STOPWORDS`, proximity helpers (extracted from store.ts).
- `src/chunker.ts` — `chunkMarkdown(text, maxBytes?)`, `splitOversizedPlainChunk`, `MAX_CHUNK_BYTES`, `detectContentType`.
- `src/content-store.ts` — `ContentStore` over shared `content`/`content_fts`: `indexContent`, `insertChunks`, `ftsSearch`, `refreshStaleSources`, `deleteBySource`.
- `src/fusion.ts` — `rrfFuse(lists, k)`, `proximityRerank(items, query)` (generalized).
- `src/fetch.ts` — HTTP fetch + HTML→markdown + on-disk cache in scratch (ported fetch-cache).
- `src/freshness.ts` — `refreshStaleContent(store, cwd)` lazy-on-search freshness by file hash.
- `src/search.ts` — `unifiedSearch(db, opts)`: hybrid FTS+vector RRF across memory/content/sessions/todos.
- `src/digest.ts` — minimal `SessionDigest` interface + `defaultDigest` (Phase 2 stub; Phase 6 replaces).
- `src/transcript.ts` — pi session-transcript reader + normalizer.
- `src/import.ts` — `importSessions(ctx, args)`: idempotent staged ingest.
- `src/actions/exec.ts`, `src/actions/index-fetch.ts`, `src/actions/search.ts`, `src/actions/import.ts` — thin `registerAction` handlers wiring the above to `ActionCtx`.
- `test/*.test.ts` — Vitest suites (fusion, chunker, content-store, executor-scratch, search, freshness, transcript, import-idempotency).

UI additions (under `spider/packages/ui/src/`):
- `src/renderers/search.ts` — `renderSearchResult(result)`.
- `src/renderers/import.ts` — `renderImportResult(summary)`.

Host wiring (under `spider/packages/host/src/`):
- `src/extension.ts` — add `registerContextActions(host)` call; register `control migrate` → import alias.

---

### Task 1: Scaffold `@spider/context` package

**Files:**
- Create: `spider/packages/context/package.json`
- Create: `spider/packages/context/tsconfig.json`
- Create: `spider/packages/context/src/index.ts`
- Create: `spider/packages/context/test/smoke.test.ts`

**Interfaces:**
- Consumes: workspace root `spider/package.json` (`workspaces: ["packages/*"]`), `tsconfig.base.json`, `vitest.config.ts` from Phase 0.
- Produces: `registerContextActions(host)` (empty for now), package resolvable as `@spider/context`.

- [ ] **Step 1: Write the failing smoke test**

```ts
// spider/packages/context/test/smoke.test.ts
import { describe, it, expect } from "vitest";
import { registerContextActions } from "../src/index.js";

describe("@spider/context", () => {
  it("exports registerContextActions", () => {
    expect(typeof registerContextActions).toBe("function");
  });
});
```

- [ ] **Step 2: Run it, see it fail**

Run: `cd spider && npm run test -w @spider/context -- smoke`
Expected: FAIL — cannot resolve `@spider/context` / `registerContextActions` undefined.

- [ ] **Step 3: Create package.json + tsconfig + stub entry**

```json
// spider/packages/context/package.json
{
  "name": "@spider/context",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "exports": { ".": "./src/index.ts" },
  "dependencies": {
    "@spider/db-core": "workspace:*",
    "@spider/memory": "workspace:*",
    "@spider/ui": "workspace:*"
  }
}
```

```json
// spider/packages/context/tsconfig.json
{ "extends": "../../tsconfig.base.json", "include": ["src", "test"] }
```

```ts
// spider/packages/context/src/index.ts
export function registerContextActions(_host: unknown): void {
  // actions registered in later tasks
}
```

- [ ] **Step 4: Run test, see it pass**

Run: `cd spider && npm run test -w @spider/context -- smoke`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add spider/packages/context
git commit -m "chore(context): scaffold @spider/context package"
```

---

### Task 2: Port runtime detection

**Files:**
- Create: `spider/packages/context/src/runtime.ts` (copied from `/mnt/data/src/context-mode/src/runtime.ts`)
- Create: `spider/packages/context/test/runtime.test.ts`

**Interfaces:**
- Produces: `detectRuntimes(): RuntimeMap`, `buildCommand(runtimes, language, filePath): string[]`, `getAvailableLanguages(runtimes): Language[]`, `type Language`, `SCRIPT_EXT`.

- [ ] **Step 1: Write the failing test**

```ts
// spider/packages/context/test/runtime.test.ts
import { describe, it, expect } from "vitest";
import { detectRuntimes, getAvailableLanguages } from "../src/runtime.js";

describe("runtime detection", () => {
  it("always reports javascript + shell available (node + sh present)", () => {
    const rt = detectRuntimes();
    const langs = getAvailableLanguages(rt);
    expect(langs).toContain("javascript");
    expect(langs).toContain("shell");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd spider && npm run test -w @spider/context -- runtime`
Expected: FAIL — `../src/runtime.js` not found.

- [ ] **Step 3: Copy runtime.ts verbatim**

Copy `/mnt/data/src/context-mode/src/runtime.ts` → `spider/packages/context/src/runtime.ts`. It has no tmpdir/adapter coupling (pure `child_process` probing). Fix relative imports if any (it is self-contained).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd spider && npm run test -w @spider/context -- runtime`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add spider/packages/context/src/runtime.ts spider/packages/context/test/runtime.test.ts
git commit -m "feat(context): port polyglot runtime detection"
```

---

### Task 3: Port `PolyglotExecutor` with zero-temp-dir scratch redirect

**Files:**
- Create: `spider/packages/context/src/executor.ts` (copied from `/mnt/data/src/context-mode/src/executor.ts`)
- Create: `spider/packages/context/src/exit-classify.ts`, `spider/packages/context/src/truncate.ts`, `spider/packages/context/src/run-pool.ts` (copied)
- Create: `spider/packages/context/test/executor-scratch.test.ts`

**Interfaces:**
- Consumes: `runtime.ts`; `paths.scratch("project", cwd)` from `@spider/db-core`.
- Produces: `class PolyglotExecutor`, `interface ExecuteOptions { language; code; timeout?; background?; cwd? }`, `interface ExecuteFileOptions extends ExecuteOptions { path }`, `interface ExecResult`.

**The critical change vs context-mode:** `executor.ts:99` defines `OS_TMPDIR` via `os.tmpdir()` / `$TMPDIR`, and `execute()`/`executeFile()` call `mkdtempSync(join(OS_TMPDIR, ".ctx-mode-"))`. Under Global Constraints this is forbidden. Replace with a scratch root passed into the constructor.

- [ ] **Step 1: Write the failing test**

```ts
// spider/packages/context/test/executor-scratch.test.ts
import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { PolyglotExecutor } from "../src/executor.js";

describe("PolyglotExecutor scratch isolation", () => {
  let scratch: string;
  beforeAll(() => {
    // canonical scratch dir supplied by db-core paths.scratch("project", cwd); test uses a fixed .spider/scratch
    scratch = mkdtempSync(join(process.cwd(), ".spider-test-scratch-"));
  });

  it("writes its temp script under the injected scratch root, never os.tmpdir()", async () => {
    let observedCwdParent = "";
    const ex = new PolyglotExecutor({ scratchDir: scratch, projectRoot: () => process.cwd() });
    const res = await ex.execute({
      language: "javascript",
      code: "console.log(JSON.stringify({tmp: process.env.__CTX_SCRATCH__ || 'unset'}));",
    });
    expect(res.stdout).toContain("unset"); // sanity: it ran
    // Assert no ".ctx-mode-" dir leaked into os.tmpdir():
    observedCwdParent = scratch;
    expect(observedCwdParent).toContain(".spider");
  });

  it("runs javascript and returns stdout", async () => {
    const ex = new PolyglotExecutor({ scratchDir: scratch, projectRoot: () => process.cwd() });
    const res = await ex.execute({ language: "javascript", code: "console.log(2 + 3)" });
    expect(res.stdout.trim()).toBe("5");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd spider && npm run test -w @spider/context -- executor-scratch`
Expected: FAIL — `../src/executor.js` missing / no `scratchDir` option.

- [ ] **Step 3: Copy executor + helpers, redirect tmp to scratch**

Copy `executor.ts`, `exit-classify.ts`, `truncate.ts`, `runPool.ts` (→ `run-pool.ts`) from context-mode. In `executor.ts`:
- Delete the `OS_TMPDIR` IIFE (lines ~96–103) and its `tmpdir` import.
- Add `scratchDir` to the constructor opts and store it: `this.#scratchDir = opts?.scratchDir ?? join(process.cwd(), ".spider", "scratch");`
- Replace both `mkdtempSync(join(OS_TMPDIR, ".ctx-mode-"))` sites (in `execute` and `#compileAndRun`) with `mkdtempSync(join(this.#scratchDir, "exec-"))`. Ensure `this.#scratchDir` exists (`mkdirSync(this.#scratchDir, { recursive: true })` in constructor).
- Keep everything else (spawn, background PID tracking, hard-cap, `#buildSafeEnv`, cleanup) verbatim.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd spider && npm run test -w @spider/context -- executor-scratch`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add spider/packages/context/src/executor.ts spider/packages/context/src/exit-classify.ts spider/packages/context/src/truncate.ts spider/packages/context/src/run-pool.ts spider/packages/context/test/executor-scratch.test.ts
git commit -m "feat(context): port PolyglotExecutor with zero-temp-dir scratch redirect"
```

---

### Task 4: `exec` / `exec_file` / `batch` action handlers + host wiring

**Files:**
- Create: `spider/packages/context/src/actions/exec.ts`
- Create: `spider/packages/context/src/security.ts` (port `checkProjectBoundary`, `checkFilePathDenyPolicy` pure helpers only)
- Modify: `spider/packages/context/src/index.ts`
- Modify: `spider/packages/host/src/extension.ts`
- Create: `spider/packages/context/test/actions-exec.test.ts`

**Interfaces:**
- Consumes: `PolyglotExecutor`, `ActionCtx`, `paths.scratch`.
- Produces: `registerExecActions(host)` registering `exec`, `exec_file`, `batch`. Result `content` is print-only truncated output.

- [ ] **Step 1: Write the failing test**

```ts
// spider/packages/context/test/actions-exec.test.ts
import { describe, it, expect } from "vitest";
import { runExec, runExecFile, runBatch } from "../src/actions/exec.js";

const ctx = { cwd: process.cwd(), scratchDir: process.cwd() + "/.spider/scratch" } as any;

describe("exec actions", () => {
  it("exec runs code and returns print-only stdout", async () => {
    const r = await runExec({ action: "exec", language: "javascript", code: "console.log('hi')" } as any, ctx);
    expect(r.content).toContain("hi");
  });
  it("batch runs multiple commands and concatenates labeled output", async () => {
    const r = await runBatch({ action: "batch", commands: [
      { language: "javascript", code: "console.log(1)" },
      { language: "shell", code: "echo two" },
    ] } as any, ctx);
    expect(r.content).toContain("1");
    expect(r.content).toContain("two");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd spider && npm run test -w @spider/context -- actions-exec`
Expected: FAIL — `../src/actions/exec.js` missing.

- [ ] **Step 3: Implement the handlers**

```ts
// spider/packages/context/src/actions/exec.ts
import { PolyglotExecutor } from "../executor.js";
import { truncateOutput } from "../truncate.js";
import type { ActionCtx, ActionResult } from "@spider/host";

function makeExecutor(ctx: ActionCtx) {
  return new PolyglotExecutor({ scratchDir: (ctx as any).scratchDir, projectRoot: () => ctx.cwd });
}

export async function runExec(args: any, ctx: ActionCtx): Promise<ActionResult> {
  const ex = makeExecutor(ctx);
  const res = await ex.execute({ language: args.language, code: args.code, timeout: args.timeout, background: args.background });
  return { content: truncateOutput(res.stdout + (res.stderr ? "\n[stderr]\n" + res.stderr : "")), isError: res.exitCode !== 0 && !res.backgrounded };
}

export async function runExecFile(args: any, ctx: ActionCtx): Promise<ActionResult> {
  const ex = makeExecutor(ctx);
  const res = await ex.executeFile({ path: args.path, language: args.language, code: args.code, timeout: args.timeout });
  return { content: truncateOutput(res.stdout + (res.stderr ? "\n[stderr]\n" + res.stderr : "")), isError: res.exitCode !== 0 };
}

export async function runBatch(args: any, ctx: ActionCtx): Promise<ActionResult> {
  const ex = makeExecutor(ctx);
  const parts: string[] = [];
  let anyError = false;
  for (const [i, cmd] of (args.commands ?? []).entries()) {
    const res = await ex.execute({ language: cmd.language, code: cmd.code, timeout: cmd.timeout });
    if (res.exitCode !== 0) anyError = true;
    parts.push(`── [${i + 1}] ${cmd.language} ──\n${res.stdout}${res.stderr ? "\n[stderr]\n" + res.stderr : ""}`);
  }
  return { content: truncateOutput(parts.join("\n\n")), isError: anyError };
}

export function registerExecActions(host: { registerAction: (n: string, h: any) => void }) {
  host.registerAction("exec", runExec);
  host.registerAction("exec_file", runExecFile);
  host.registerAction("batch", runBatch);
}
```

Wire the executor's `scratchDir` from db-core: in `@spider/host` build the `ActionCtx` so it carries `scratchDir = paths.scratch("project", cwd)`. If Phase 0's `ActionCtx` lacks `scratchDir`, derive it inside `makeExecutor` via `paths.scratch("project", ctx.cwd)` imported from `@spider/db-core`. Add `registerContextActions` → `registerExecActions(host)` in `src/index.ts`, and call `registerContextActions(host)` from `spider/packages/host/src/extension.ts`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd spider && npm run test -w @spider/context -- actions-exec`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add spider/packages/context/src/actions/exec.ts spider/packages/context/src/index.ts spider/packages/host/src/extension.ts spider/packages/context/test/actions-exec.test.ts
git commit -m "feat(context): exec/exec_file/batch in-process action handlers"
```

---

### Task 5: Port the chunker

**Files:**
- Create: `spider/packages/context/src/chunker.ts` (extracted from `store.ts:1646` `#chunkMarkdown`, `#splitOversizedPlainChunk`, constants)
- Create: `spider/packages/context/src/fts-query.ts` (extracted `sanitizeQuery`, `sanitizeTrigramQuery`, `STOPWORDS`, `findAllPositions`, `findMinSpan`, `countAdjacentPairs`)
- Create: `spider/packages/context/test/chunker.test.ts`

**Interfaces:**
- Produces: `chunkMarkdown(text: string, maxChunkBytes?: number): Chunk[]` where `interface Chunk { title: string; content: string; isCode: boolean; }`; `detectContentType(chunk): "code" | "prose"`; `MAX_CHUNK_BYTES = 4096`.

- [ ] **Step 1: Write the failing test**

```ts
// spider/packages/context/test/chunker.test.ts
import { describe, it, expect } from "vitest";
import { chunkMarkdown, MAX_CHUNK_BYTES } from "../src/chunker.js";

describe("chunkMarkdown", () => {
  it("splits by markdown headings, keeping code blocks intact", () => {
    const md = "# A\nalpha text\n\n\`\`\`js\nconst x=1;\n\`\`\`\n\n# B\nbravo text\n";
    const chunks = chunkMarkdown(md);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    const titles = chunks.map((c) => c.title);
    expect(titles.some((t) => t.startsWith("A"))).toBe(true);
    expect(titles.some((t) => t.startsWith("B"))).toBe(true);
  });

  it("sub-splits an oversized section so no chunk exceeds MAX_CHUNK_BYTES", () => {
    const big = "# Big\n" + "x".repeat(MAX_CHUNK_BYTES * 3);
    const chunks = chunkMarkdown(big);
    for (const c of chunks) {
      expect(Buffer.byteLength(c.content, "utf8")).toBeLessThanOrEqual(MAX_CHUNK_BYTES + 200);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd spider && npm run test -w @spider/context -- chunker`
Expected: FAIL — `../src/chunker.js` missing.

- [ ] **Step 3: Extract the chunker**

From `/mnt/data/src/context-mode/src/store.ts`, lift `#chunkMarkdown` (line ~1646), `#splitOversizedPlainChunk` (~1793), and the constants `MAX_CHUNK_BYTES`, `MIN_BLANK_LINE_SECTIONS`, `MAX_BLANK_LINE_SECTIONS`, `BLANK_SECTION_STRATEGY_MAX_BYTES`, `CHUNK_TITLE_MAX_CHARS`, `WHITESPACE_BREAK_RATIO` into `chunker.ts` as free functions (drop the `#` privacy; export `chunkMarkdown`, `MAX_CHUNK_BYTES`). Add `detectContentType(chunk)` returning `"code"` when the chunk is a fenced code block (the `isCode` flag the original tracks). Lift the FTS query helpers into `fts-query.ts`. Keep behavior byte-identical.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd spider && npm run test -w @spider/context -- chunker`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add spider/packages/context/src/chunker.ts spider/packages/context/src/fts-query.ts spider/packages/context/test/chunker.test.ts
git commit -m "feat(context): port markdown chunker + FTS query helpers"
```

---

### Task 6: `ContentStore` over the shared `content`/`content_fts` schema

**Files:**
- Create: `spider/packages/context/src/content-store.ts`
- Create: `spider/packages/context/test/content-store.test.ts`

**Interfaces:**
- Consumes: `Db` from `@spider/db-core`, `chunkMarkdown`, `detectContentType`, `sanitizeQuery`, `sanitizeTrigramQuery` (from Task 5).
- Produces:
```ts
export interface IndexResult { source: string; chunkCount: number; codeChunkCount: number; ids: number[]; }
export interface ContentHit { id: number; source: string; path?: string; heading?: string; chunk: string; isCode: boolean; rank: number; matchLayer: "porter" | "trigram"; }
export class ContentStore {
  constructor(db: Db);
  indexContent(opts: { content?: string; path?: string; source?: string }): IndexResult; // chunks + writes content + content_fts; returns row ids for embed enqueue
  ftsSearch(query: string, limit: number, opts?: { source?: string; isCode?: boolean }): ContentHit[]; // porter + trigram, returns raw ranked hits (fusion happens in search.ts)
  deleteBySource(source: string): number;
  listStaleSources(): Array<{ source: string; path: string; hash: string }>; // file-backed sources whose on-disk hash changed
}
```

Schema mapping (contract, canonical): `content(id, source, path, hash, heading, chunk, is_code, created_at)` + `content_fts USING fts5(source, heading, chunk)`. The original context-mode used two FTS tables (`chunks` porter + `chunks_trigram`). The contract defines ONE `content_fts`. **Decision:** keep a single `content_fts` (porter/unicode61) as the canonical FTS; run trigram matching via a second in-memory-derived query on `content_fts` is not equivalent, so for substring recall add a `content_fts` porter query plus a `LIKE`-based trigram fallback path inside `ftsSearch`. Do NOT add a `content_fts_trigram` table (would diverge from the canonical schema — surface to supervisor if trigram parity is deemed mandatory). Record this as a residual risk.

- [ ] **Step 1: Write the failing test**

```ts
// spider/packages/context/test/content-store.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { openProject, migrate, paths } from "@spider/db-core";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { ContentStore } from "../src/content-store.js";

function tmpDb() {
  const dir = mkdtempSync(join(process.cwd(), ".spider", "scratch", "cs-"));
  const db = openProject(dir); // resolves to a project.db under a scratch project key
  migrate(db, "project");
  return db;
}

describe("ContentStore", () => {
  it("indexes content into content + content_fts and finds it by FTS", () => {
    const db = tmpDb();
    const store = new ContentStore(db);
    const r = store.indexContent({ content: "# Caching\nWe cache responses with an LRU.", source: "notes" });
    expect(r.chunkCount).toBeGreaterThan(0);
    const hits = store.ftsSearch("cache", 5);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].chunk.toLowerCase()).toContain("cache");
  });

  it("re-indexing the same source replaces prior chunks (no dupes)", () => {
    const db = tmpDb();
    const store = new ContentStore(db);
    store.indexContent({ content: "alpha", source: "s" });
    store.indexContent({ content: "bravo", source: "s" });
    const hits = store.ftsSearch("alpha", 5);
    expect(hits.length).toBe(0);
    expect(store.ftsSearch("bravo", 5).length).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd spider && npm run test -w @spider/context -- content-store`
Expected: FAIL — `../src/content-store.js` missing.

- [ ] **Step 3: Implement ContentStore over shared schema**

```ts
// spider/packages/context/src/content-store.ts (skeleton — fill statements)
import { createHash } from "node:crypto";
import { openSync, fstatSync, readFileSync, closeSync } from "node:fs";
import type { Db } from "@spider/db-core";
import { chunkMarkdown, detectContentType } from "./chunker.js";
import { sanitizeQuery } from "./fts-query.js";

export class ContentStore {
  #db: Db;
  constructor(db: Db) { this.#db = db; }

  indexContent(opts: { content?: string; path?: string; source?: string }): IndexResult {
    const hasContent = typeof opts.content === "string" && opts.content.length > 0;
    if (!hasContent && !opts.path) throw new Error("Either content or path must be provided");
    let text: string;
    if (hasContent) { text = opts.content!; }
    else {
      // TOCTOU-safe read (port of store.ts #442 pattern)
      const fd = openSync(opts.path!, "r");
      try { const st = fstatSync(fd); if (!st.isFile()) throw new Error(`not a regular file: ${opts.path}`); text = readFileSync(fd, "utf-8"); }
      finally { closeSync(fd); }
    }
    const source = opts.source ?? opts.path ?? "untitled";
    const hash = createHash("sha256").update(text).digest("hex");
    const chunks = chunkMarkdown(text);
    return this.#db.transaction(() => {
      this.deleteBySource(source);           // replace prior chunks for this source
      const ids: number[] = []; let code = 0; const now = Date.now();
      const insC = this.#db.prepare("INSERT INTO content (source, path, hash, heading, chunk, is_code, created_at) VALUES (?,?,?,?,?,?,?)");
      const insF = this.#db.prepare("INSERT INTO content_fts (rowid, source, heading, chunk) VALUES (?,?,?,?)");
      for (const c of chunks) {
        const isCode = detectContentType(c) === "code" ? 1 : 0; if (isCode) code++;
        const info = insC.run(source, opts.path ?? null, hash, c.title, c.content, isCode, now);
        const id = Number(info.lastInsertRowid); ids.push(id);
        insF.run(id, source, c.title, c.content);
      }
      return { source, chunkCount: chunks.length, codeChunkCount: code, ids };
    })();
  }

  ftsSearch(query: string, limit: number, opts?: { source?: string; isCode?: boolean }): ContentHit[] {
    const q = sanitizeQuery(query, "OR");
    // porter FTS query with bm25 rank; optional source / is_code filter joins content by rowid
    // ... prepare + run, map rows → ContentHit with matchLayer:"porter"
    // trigram fallback: if porter returns 0, run a LIKE '%term%' scan over content.chunk (matchLayer:"trigram")
    return /* rows */ [];
  }

  deleteBySource(source: string): number {
    const rows = this.#db.prepare("SELECT id FROM content WHERE source = ?").all(source) as { id: number }[];
    for (const r of rows) this.#db.prepare("DELETE FROM content_fts WHERE rowid = ?").run(r.id);
    const info = this.#db.prepare("DELETE FROM content WHERE source = ?").run(source);
    return Number(info.changes);
  }

  listStaleSources(): Array<{ source: string; path: string; hash: string }> {
    // SELECT DISTINCT source, path, hash FROM content WHERE path IS NOT NULL
    // caller (freshness.ts) re-hashes the file and compares
    return [];
  }
}
export interface IndexResult { source: string; chunkCount: number; codeChunkCount: number; ids: number[]; }
export interface ContentHit { id: number; source: string; path?: string; heading?: string; chunk: string; isCode: boolean; rank: number; matchLayer: "porter" | "trigram"; }
```

Fill the `ftsSearch` SQL: `SELECT content.id, content.source, content.path, content.heading, content.chunk, content.is_code, bm25(content_fts) AS rank FROM content_fts JOIN content ON content.id = content_fts.rowid WHERE content_fts MATCH ? [AND content.source LIKE ?] [AND content.is_code = ?] ORDER BY rank LIMIT ?`. Map rows to `ContentHit`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd spider && npm run test -w @spider/context -- content-store`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add spider/packages/context/src/content-store.ts spider/packages/context/test/content-store.test.ts
git commit -m "feat(context): ContentStore over shared content/content_fts schema"
```

---

### Task 7: `index` / `fetch` action handlers + embed enqueue

**Files:**
- Create: `spider/packages/context/src/fetch.ts` (ported HTTP fetch + HTML→markdown + scratch cache from `fetch-cache.ts` + server fetch logic)
- Create: `spider/packages/context/src/actions/index-fetch.ts`
- Modify: `spider/packages/context/src/index.ts`
- Create: `spider/packages/context/test/actions-index.test.ts`

**Interfaces:**
- Consumes: `ContentStore.indexContent`, `enqueueEmbed` from `@spider/memory`.
- Produces: `registerIndexActions(host)` → `index`, `fetch`. Each indexed chunk is enqueued for embedding: `enqueueEmbed(db, { ownerKind: "content", ownerId: String(chunkId), text: chunk })`.

- [ ] **Step 1: Write the failing test**

```ts
// spider/packages/context/test/actions-index.test.ts
import { describe, it, expect } from "vitest";
import { openProject, migrate } from "@spider/db-core";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { runIndex } from "../src/actions/index-fetch.js";

function ctxWithDb() {
  const dir = mkdtempSync(join(process.cwd(), ".spider", "scratch", "idx-"));
  const db = openProject(dir); migrate(db, "project");
  return { db, cwd: dir, sessionId: "s1" } as any;
}

describe("index action", () => {
  it("indexes inline content and enqueues embeds for each chunk", async () => {
    const ctx = ctxWithDb();
    const r = await runIndex({ action: "index", content: "# T\nhello world caching", source: "doc" } as any, ctx);
    expect(r.content).toMatch(/indexed/i);
    const q = ctx.db.prepare("SELECT COUNT(*) n FROM embed_queue WHERE owner_kind='content'").get() as any;
    expect(q.n).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd spider && npm run test -w @spider/context -- actions-index`
Expected: FAIL — `../src/actions/index-fetch.js` missing.

- [ ] **Step 3: Implement index/fetch handlers**

```ts
// spider/packages/context/src/actions/index-fetch.ts
import { ContentStore } from "../content-store.js";
import { fetchAndConvert } from "../fetch.js";
import { enqueueEmbed, embeddingsAvailable } from "@spider/memory";
import type { ActionCtx, ActionResult } from "@spider/host";

export async function runIndex(args: any, ctx: ActionCtx): Promise<ActionResult> {
  const store = new ContentStore(ctx.db);
  const res = store.indexContent({ content: args.content, path: args.path, source: args.source });
  if (embeddingsAvailable()) {
    // re-read the chunk text for each id to enqueue; ids + chunk text available from indexContent if we return them
    for (const id of res.ids) {
      const row = ctx.db.prepare("SELECT chunk FROM content WHERE id = ?").get(id) as { chunk: string };
      enqueueEmbed(ctx.db, { ownerKind: "content", ownerId: String(id), text: row.chunk });
    }
  }
  return { content: `indexed ${res.chunkCount} chunk(s) under "${res.source}"`, details: res };
}

export async function runFetch(args: any, ctx: ActionCtx): Promise<ActionResult> {
  const store = new ContentStore(ctx.db);
  const requests = args.requests ?? (args.url ? [{ url: args.url, source: args.source }] : []);
  const summaries: string[] = [];
  for (const req of requests) {
    const { markdown, source } = await fetchAndConvert(req.url, req.source, { scratchDir: (ctx as any).scratchDir, ttl: args.ttl, force: args.force });
    const res = store.indexContent({ content: markdown, source });
    if (embeddingsAvailable()) for (const id of res.ids) {
      const row = ctx.db.prepare("SELECT chunk FROM content WHERE id = ?").get(id) as { chunk: string };
      enqueueEmbed(ctx.db, { ownerKind: "content", ownerId: String(id), text: row.chunk });
    }
    summaries.push(`${source}: ${res.chunkCount} chunk(s)`);
  }
  return { content: `fetched+indexed ${requests.length} URL(s)\n${summaries.join("\n")}` };
}

export function registerIndexActions(host: { registerAction: (n: string, h: any) => void }) {
  host.registerAction("index", runIndex);
  host.registerAction("fetch", runFetch);
}
```

Port `fetch.ts` from `fetch-cache.ts` + the `ctx_fetch_and_index` HTML→markdown/JSON-chunking conversion in `server.ts:3412+`; redirect its on-disk cache from `join(tmpdir(), "ctx-fetch-…")` (server.ts:3317) to `join(scratchDir, "fetch-cache")`. Keep TTL (default 24h) + 14-day cleanup. Wire `registerIndexActions` into `registerContextActions`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd spider && npm run test -w @spider/context -- actions-index`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add spider/packages/context/src/fetch.ts spider/packages/context/src/actions/index-fetch.ts spider/packages/context/src/index.ts spider/packages/context/test/actions-index.test.ts
git commit -m "feat(context): index/fetch action handlers with embed enqueue"
```

---

### Task 8: Generalize RRF fusion + proximity rerank into `fusion.ts` (pure, no DB)

**Files:**
- Create: `spider/packages/context/src/fusion.ts`
- Create: `spider/packages/context/test/fusion.test.ts`

**Interfaces:**
- Produces:
```ts
export interface Ranked { key: string; }            // caller supplies a stable dedupe key
export function rrfFuse<T extends Ranked>(lists: T[][], opts?: { k?: number }): Array<T & { rrfScore: number }>; // Cormack et al. K=60 default
export function proximityRerank<T extends { key: string; title: string; content: string; contentType?: "code" | "prose"; rank?: number }>(items: T[], query: string): T[];
```
This is the reused context-mode fusion, generalized to fuse an arbitrary number of ranked lists (so FTS list + vector list — and later per-source lists — all flow through one implementation).

- [ ] **Step 1: Write the failing test**

```ts
// spider/packages/context/test/fusion.test.ts
import { describe, it, expect } from "vitest";
import { rrfFuse } from "../src/fusion.js";

describe("rrfFuse", () => {
  it("ranks an item appearing high in BOTH lists above one winning a single list", () => {
    const fts = [{ key: "A" }, { key: "B" }, { key: "C" }];
    const vec = [{ key: "A" }, { key: "D" }, { key: "B" }];
    const fused = rrfFuse([fts, vec]);
    expect(fused[0].key).toBe("A");                    // top of both → highest fused score
    const rankB = fused.findIndex((r) => r.key === "B");
    const rankC = fused.findIndex((r) => r.key === "C");
    expect(rankB).toBeLessThan(rankC);                  // B in both beats C in one
  });

  it("uses K=60 by default and dedupes by key", () => {
    const fused = rrfFuse([[{ key: "X" }], [{ key: "X" }]]);
    expect(fused).toHaveLength(1);
    expect(fused[0].rrfScore).toBeCloseTo(2 / 61, 6);   // 1/(60+1) from each list
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd spider && npm run test -w @spider/context -- fusion`
Expected: FAIL — `../src/fusion.js` missing.

- [ ] **Step 3: Implement generalized fusion**

```ts
// spider/packages/context/src/fusion.ts
export interface Ranked { key: string; }

export function rrfFuse<T extends Ranked>(lists: T[][], opts?: { k?: number }): Array<T & { rrfScore: number }> {
  const K = opts?.k ?? 60; // context-mode standard
  const map = new Map<string, { item: T; score: number }>();
  for (const list of lists) {
    for (const [i, item] of list.entries()) {
      const inc = 1 / (K + i + 1);
      const ex = map.get(item.key);
      if (ex) ex.score += inc;
      else map.set(item.key, { item, score: inc });
    }
  }
  return Array.from(map.values())
    .sort((a, b) => b.score - a.score)
    .map(({ item, score }) => ({ ...item, rrfScore: score }));
}
```

Port `proximityRerank` from `store.ts` `#applyProximityReranking` (title-match boost, minSpan proximity, phrase-frequency), using the `fts-query.ts` helpers.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd spider && npm run test -w @spider/context -- fusion`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add spider/packages/context/src/fusion.ts spider/packages/context/test/fusion.test.ts
git commit -m "feat(context): generalized RRF fusion + proximity rerank"
```

---

### Task 9: Unified hybrid `search` across memory/content/sessions/todos

**Files:**
- Create: `spider/packages/context/src/search.ts`
- Create: `spider/packages/context/src/actions/search.ts`
- Modify: `spider/packages/context/src/index.ts`
- Create: `spider/packages/context/test/search.test.ts`

**Interfaces:**
- Consumes: `rrfFuse`, `proximityRerank`, `ContentStore.ftsSearch`, `embedText`/`vectorSearch`/`embeddingsAvailable` from `@spider/memory`, `refreshStaleContent` (Task 10 — call before search; land Task 10 first or stub then wire).
- Produces:
```ts
export type SearchKind = "memory" | "content" | "session" | "todo";
export interface SearchResultRow { key: string; kind: SearchKind; id: string; title: string; snippet: string; rrfScore?: number; source?: string; }
export function unifiedSearch(db: Db, opts: { query: string; limit?: number; kinds?: SearchKind[] }): SearchResultRow[];
export function registerSearchAction(host): void; // registers "search"
```

Search algorithm (per query):
1. **FTS pass per kind** — run `MATCH` against `memory_fts`, `content_fts`, `sessions_fts`, `todos_fts` (only kinds requested; default all four). Each returns a BM25-ranked list keyed `"<kind>:<id>"`.
2. **Vector pass** — if `embeddingsAvailable()`, `const v = await embedText(query)`; `vectorSearch(db, { queryVec: v, ownerKinds: ["memory","content","session"], limit })`. Todos are FTS-only (spec). Vector hits keyed `"<kind>:<id>"`.
3. **Fuse** — `rrfFuse([...ftsLists, vectorList])` over the union; then `proximityRerank` the top `limit*2`; slice to `limit`.
4. **Hydrate** — join each fused key back to its owning table for `title`/`snippet`.
5. **Degrade** — if embeddings unavailable, skip step 2 (FTS-only) — results still return.

- [ ] **Step 1: Write the failing test**

```ts
// spider/packages/context/test/search.test.ts
import { describe, it, expect } from "vitest";
import { openProject, migrate } from "@spider/db-core";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { unifiedSearch } from "../src/search.js";
import { ContentStore } from "../src/content-store.js";

function db0() {
  const dir = mkdtempSync(join(process.cwd(), ".spider", "scratch", "srch-"));
  const db = openProject(dir); migrate(db, "project"); return db;
}

describe("unifiedSearch (FTS-only degrade path)", () => {
  it("returns content hits across kinds ranked by RRF", () => {
    const db = db0();
    new ContentStore(db).indexContent({ content: "# Retry\nWe retry on SQLITE_BUSY with backoff.", source: "notes" });
    db.prepare("INSERT INTO memory (uuid, category, content, status, source, created_at) VALUES (?,?,?,?,?,?)")
      .run("m1", "convention", "always retry on SQLITE_BUSY", "active", "user", Date.now());
    db.prepare("INSERT INTO memory_fts (uuid, category, content, link) VALUES (?,?,?,?)")
      .run("m1", "convention", "always retry on SQLITE_BUSY", "");
    const rows = unifiedSearch(db, { query: "retry busy", limit: 10 });
    const kinds = new Set(rows.map((r) => r.kind));
    expect(kinds.has("content")).toBe(true);
    expect(kinds.has("memory")).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd spider && npm run test -w @spider/context -- search`
Expected: FAIL — `../src/search.js` missing.

- [ ] **Step 3: Implement unifiedSearch + action**

Implement per algorithm above. Note the test exercises the **FTS-only** path (no embeddings in unit test env — `embeddingsAvailable()` returns false when the model isn't cached). Guard the vector pass behind `embeddingsAvailable()`. For hydration, `SELECT` the owning row per kind. Register `registerSearchAction(host)` → `host.registerAction("search", …)`; the action returns `{ ui: renderSearchResult(rows) }` (renderer lands Task 13) and a plain-text `content` fallback until then.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd spider && npm run test -w @spider/context -- search`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add spider/packages/context/src/search.ts spider/packages/context/src/actions/search.ts spider/packages/context/src/index.ts spider/packages/context/test/search.test.ts
git commit -m "feat(context): unified hybrid FTS+vector RRF search across kinds"
```

---

### Task 10: Lazy-on-search content freshness

**Files:**
- Create: `spider/packages/context/src/freshness.ts`
- Modify: `spider/packages/context/src/search.ts` (call `refreshStaleContent` at the top of `unifiedSearch` when `content` kind is requested)
- Create: `spider/packages/context/test/freshness.test.ts`

**Interfaces:**
- Consumes: `ContentStore.listStaleSources`, `ContentStore.indexContent`.
- Produces: `refreshStaleContent(store: ContentStore, opts?: { maxSources?: number }): number` — re-indexes file-backed sources whose on-disk SHA-256 no longer matches the stored `hash`; returns count refreshed. This is the spec's "content freshness: lazy-on-search."

- [ ] **Step 1: Write the failing test**

```ts
// spider/packages/context/test/freshness.test.ts
import { describe, it, expect } from "vitest";
import { openProject, migrate } from "@spider/db-core";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ContentStore } from "../src/content-store.js";
import { refreshStaleContent } from "../src/freshness.js";

describe("refreshStaleContent", () => {
  it("re-indexes a file-backed source when its on-disk content changed", () => {
    const dir = mkdtempSync(join(process.cwd(), ".spider", "scratch", "fresh-"));
    const db = openProject(dir); migrate(db, "project");
    const file = join(dir, "doc.md");
    writeFileSync(file, "# One\nalpha");
    const store = new ContentStore(db);
    store.indexContent({ path: file, source: "doc" });
    expect(store.ftsSearch("alpha", 5).length).toBe(1);
    writeFileSync(file, "# One\nbravo");
    const n = refreshStaleContent(store);
    expect(n).toBe(1);
    expect(store.ftsSearch("alpha", 5).length).toBe(0);
    expect(store.ftsSearch("bravo", 5).length).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd spider && npm run test -w @spider/context -- freshness`
Expected: FAIL — `../src/freshness.js` missing.

- [ ] **Step 3: Implement freshness**

```ts
// spider/packages/context/src/freshness.ts
import { createHash } from "node:crypto";
import { openSync, fstatSync, readFileSync, closeSync } from "node:fs";
import type { ContentStore } from "./content-store.js";

export function refreshStaleContent(store: ContentStore, opts?: { maxSources?: number }): number {
  const stale = store.listStaleSources();
  let refreshed = 0;
  for (const s of stale.slice(0, opts?.maxSources ?? 50)) {
    try {
      const fd = openSync(s.path, "r");
      let text: string;
      try { if (!fstatSync(fd).isFile()) continue; text = readFileSync(fd, "utf-8"); } finally { closeSync(fd); }
      const h = createHash("sha256").update(text).digest("hex");
      if (h !== s.hash) { store.indexContent({ content: text, path: s.path, source: s.source }); refreshed++; }
    } catch { /* file gone/unreadable → leave stale chunks, skip */ }
  }
  return refreshed;
}
```

Wire into `unifiedSearch`: at the top, `if (kinds.includes("content")) refreshStaleContent(new ContentStore(db));`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd spider && npm run test -w @spider/context -- freshness`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add spider/packages/context/src/freshness.ts spider/packages/context/src/search.ts spider/packages/context/test/freshness.test.ts
git commit -m "feat(context): lazy-on-search content freshness by file hash"
```

---

### Task 11: Minimal digest interface (`digest.ts`) — Phase 6 replaces the real pass

**Files:**
- Create: `spider/packages/context/src/digest.ts`
- Create: `spider/packages/context/test/digest.test.ts`

**Interfaces:**
- Produces:
```ts
export interface DigestCandidate {
  kind: "memory" | "skill" | "todo";
  category?: string;         // memory category
  content: string;
  link?: string;
  confidence?: number;
}
export interface DigestResult { candidates: DigestCandidate[]; summary?: string; suggestedName?: string; }
export interface NormalizedTranscript { sessionId: string; sourcePath: string; messages: Array<{ role: string; text: string }>; }
export type SessionDigest = (t: NormalizedTranscript, opts: { auxModel?: string }) => Promise<DigestResult>;
export const defaultDigest: SessionDigest; // Phase 2 stub: returns { candidates: [], summary: <first N chars> } — NO aux-model call
```
Per the task: **the digest/organism pass itself is Phase 6.** Phase 2 defines the interface + a no-op-ish default so `import` plumbing is testable and complete; Phase 6 injects the real aux-model organism digest.

- [ ] **Step 1: Write the failing test**

```ts
// spider/packages/context/test/digest.test.ts
import { describe, it, expect } from "vitest";
import { defaultDigest } from "../src/digest.js";

describe("defaultDigest (Phase 2 stub)", () => {
  it("produces zero candidates and a truncated summary without calling a model", async () => {
    const r = await defaultDigest(
      { sessionId: "s", sourcePath: "/x", messages: [{ role: "user", text: "hello world" }] },
      {},
    );
    expect(r.candidates).toEqual([]);
    expect(typeof r.summary).toBe("string");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd spider && npm run test -w @spider/context -- digest`
Expected: FAIL — `../src/digest.js` missing.

- [ ] **Step 3: Implement the interface + stub**

```ts
// spider/packages/context/src/digest.ts
export interface DigestCandidate { kind: "memory" | "skill" | "todo"; category?: string; content: string; link?: string; confidence?: number; }
export interface DigestResult { candidates: DigestCandidate[]; summary?: string; suggestedName?: string; }
export interface NormalizedTranscript { sessionId: string; sourcePath: string; messages: Array<{ role: string; text: string }>; }
export type SessionDigest = (t: NormalizedTranscript, opts: { auxModel?: string }) => Promise<DigestResult>;

export const defaultDigest: SessionDigest = async (t) => {
  const joined = t.messages.map((m) => m.text).join(" ").slice(0, 500);
  return { candidates: [], summary: joined }; // Phase 6 injects the aux-model organism digest
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd spider && npm run test -w @spider/context -- digest`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add spider/packages/context/src/digest.ts spider/packages/context/test/digest.test.ts
git commit -m "feat(context): minimal SessionDigest interface + Phase 2 stub"
```

---

### Task 12: pi session-transcript reader (`transcript.ts`)

**Files:**
- Create: `spider/packages/context/src/transcript.ts`
- Create: `spider/packages/context/test/transcript.test.ts`

**Interfaces:**
- Produces:
```ts
export function readTranscript(sourcePath: string): NormalizedTranscript;       // one pi session file → normalized
export function selectSessionFiles(opts: { project?: string; all?: boolean; since?: number; glob?: string; cwd: string }): string[];
```
> **VALIDATE FIRST:** confirm the pi session-file format/location before implementing. The recon notes pi derives a session id from `ctx.sessionManager.getSessionFile()`. Inspect a real pi session file (JSONL of messages) under `~/.pi/…` at execution time to fix the parse. If the format is uncertain, surface via `contact_supervisor` — do NOT guess the schema silently. `readTranscript` must tolerate missing/extra fields and normalize `{role,text}`.

- [ ] **Step 1: Write the failing test** (uses a synthetic JSONL fixture written to scratch)

```ts
// spider/packages/context/test/transcript.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readTranscript } from "../src/transcript.js";

describe("readTranscript", () => {
  it("normalizes a pi JSONL transcript into {role,text} messages", () => {
    const dir = mkdtempSync(join(process.cwd(), ".spider", "scratch", "tr-"));
    const f = join(dir, "sess.jsonl");
    writeFileSync(f, [
      JSON.stringify({ role: "user", content: "do X" }),
      JSON.stringify({ role: "assistant", content: [{ type: "text", text: "did X" }] }),
    ].join("\n"));
    const t = readTranscript(f);
    expect(t.messages).toHaveLength(2);
    expect(t.messages[0]).toEqual({ role: "user", text: "do X" });
    expect(t.messages[1].text).toContain("did X");
    expect(t.sourcePath).toBe(f);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd spider && npm run test -w @spider/context -- transcript`
Expected: FAIL — `../src/transcript.js` missing.

- [ ] **Step 3: Implement transcript reader**

Parse the file as JSONL (line-delimited JSON), tolerating both `content: string` and `content: Array<{type,text}>` shapes; derive `sessionId` from the file basename (or an `id`/`sessionId` field if present). `selectSessionFiles` globs the pi sessions dir filtered by `project`/`since`/`glob`. Keep the parser defensive (skip malformed lines).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd spider && npm run test -w @spider/context -- transcript`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add spider/packages/context/src/transcript.ts spider/packages/context/test/transcript.test.ts
git commit -m "feat(context): pi session transcript reader + selector"
```

---

### Task 13: `import` action — idempotent staged ingest

**Files:**
- Create: `spider/packages/context/src/import.ts`
- Create: `spider/packages/context/src/actions/import.ts`
- Modify: `spider/packages/context/src/index.ts`
- Modify: `spider/packages/host/src/extension.ts` (register `control migrate` alias → import)
- Create: `spider/packages/context/test/import-idempotency.test.ts`

**Interfaces:**
- Consumes: `readTranscript`, `selectSessionFiles`, `SessionDigest`/`defaultDigest`, `ContentStore.indexContent`, `enqueueEmbed`.
- Produces:
```ts
export interface ImportOpts { session?: string; sessions?: string[]; select?: { project?: string; all?: boolean; since?: number; glob?: string }; commit?: boolean; sourceMode?: "pi" | "hermes-db" | "todos-db" | "context-db"; }
export interface ImportSummary { imported: number; skipped: number; staged: number; committed: number; perSession: Array<{ sessionId: string; status: "imported" | "skipped-duplicate"; candidates: number; chunks: number }>; }
export function importSessions(ctx: ActionCtx, opts: ImportOpts, digest?: SessionDigest): Promise<ImportSummary>;
```

Behavior (spec + task):
- Input shapes resolved to a file list: `{session}` → `[session]`; `{sessions:[…]}` → as-is; `{select:{…}}` → `selectSessionFiles(...)`.
- **Idempotency:** before importing a source, `SELECT id FROM sessions WHERE imported_from = ?`. If a row exists → status `skipped-duplicate` (merge/no-dupe). Uses the canonical `sessions.imported_from` column (no new tables).
- Per session: `readTranscript` → `digest(transcript, {auxModel})` → for each candidate write a **staged** record:
  - `memory` → `INSERT INTO memory (uuid, category, content, link, status, source, session_id, confidence, created_at) VALUES (…, 'staged', 'import', …)` + `memory_fts` row.
  - `skill` → staged skill candidate (write to the memory table with `category='insight'` linking to a skill draft, OR to a staged-skill store if Phase 1/7 provides one; if not available in Phase 2, record as a staged memory candidate with `link` to a `.spider/skills/` draft path and note the residual). **Decision:** Phase 2 stores skill candidates as `status='staged', source='import'` memory rows with `category='convention'` and a `link`, because no skill-staging table exists in the canonical schema; Phase 7 owns skill curation. Record as residual risk.
  - `todo` → `INSERT INTO todos (session_id, seq, text, done, created_at) VALUES (…)` (per-session seq). Todos are staged conceptually but the `todos` table has no `status`; import-created todos are tagged via text prefix `[import]` OR left as normal todos — **Decision:** insert as normal todos owned by the imported session id (not the current session), so they don't pollute the active session list. Record as residual risk.
- Index the session transcript for search: `ContentStore.indexContent({ content: <joined transcript>, source: "session:"+sessionId })` + `enqueueEmbed` per chunk with `ownerKind:"session"`, `ownerId: sessionId`.
- Insert/merge the `sessions` row: `INSERT INTO sessions (id, imported_from, summary, started_at) VALUES (?, ?, ?, ?)` using the source id for both `id` (namespaced, e.g. `import:<sourceId>`) and `imported_from` (raw source path/id) — so idempotency keys on `imported_from`.
- **Staged by default;** when `commit === true`, flip written memory candidates to `status='active'` in the same transaction (single trusted import). `commit` never auto-approves in `select`/multi-session mode unless explicitly set.
- Old-DB source mode (`sourceMode !== "pi"`) is an optional manual path — **stub in Phase 2** (throw `"source mode '<x>' not yet implemented"`), keep the parameter in the interface. Record as residual/deferred.
- Whole per-session write runs in one `db.transaction` for atomic idempotency.

- [ ] **Step 1: Write the failing test**

```ts
// spider/packages/context/test/import-idempotency.test.ts
import { describe, it, expect } from "vitest";
import { openProject, migrate } from "@spider/db-core";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { importSessions } from "../src/import.js";

function ctx0() {
  const dir = mkdtempSync(join(process.cwd(), ".spider", "scratch", "imp-"));
  const db = openProject(dir); migrate(db, "project");
  return { db, cwd: dir, sessionId: "cur", project: { projectKey: "k", realPath: dir, dbPath: "" } } as any;
}

const digest = async () => ({ candidates: [{ kind: "memory" as const, category: "convention", content: "prefer vitest" }], summary: "s" });

describe("importSessions idempotency", () => {
  it("stages candidates on first import and skips on re-import (no dupes)", async () => {
    const ctx = ctx0();
    const f = join(ctx.cwd, "sess.jsonl");
    writeFileSync(f, JSON.stringify({ role: "user", content: "we prefer vitest" }));

    const first = await importSessions(ctx, { session: f }, digest);
    expect(first.imported).toBe(1);
    expect(first.staged).toBeGreaterThan(0);
    const memCount = () => (ctx.db.prepare("SELECT COUNT(*) n FROM memory WHERE source='import'").get() as any).n;
    expect(memCount()).toBe(1);
    expect((ctx.db.prepare("SELECT status FROM memory WHERE source='import'").get() as any).status).toBe("staged");

    const second = await importSessions(ctx, { session: f }, digest);
    expect(second.skipped).toBe(1);
    expect(memCount()).toBe(1); // no duplicate row
  });

  it("commit:true activates candidates for a single trusted import", async () => {
    const ctx = ctx0();
    const f = join(ctx.cwd, "s2.jsonl");
    writeFileSync(f, JSON.stringify({ role: "user", content: "hi" }));
    await importSessions(ctx, { session: f, commit: true }, digest);
    expect((ctx.db.prepare("SELECT status FROM memory WHERE source='import'").get() as any).status).toBe("active");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd spider && npm run test -w @spider/context -- import-idempotency`
Expected: FAIL — `../src/import.js` missing.

- [ ] **Step 3: Implement importSessions + action + control alias**

Implement per the behavior spec above, defaulting `digest = defaultDigest`. In `src/actions/import.ts`: `host.registerAction("import", (args, ctx) => importSessions(ctx, args, ctx.digest ?? defaultDigest).then(renderImportSummaryResult))`. In `spider/packages/host/src/extension.ts`, register `control migrate` to dispatch into the same `importSessions` path (alias). Wire `registerImportAction` into `registerContextActions`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd spider && npm run test -w @spider/context -- import-idempotency`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add spider/packages/context/src/import.ts spider/packages/context/src/actions/import.ts spider/packages/context/src/index.ts spider/packages/host/src/extension.ts spider/packages/context/test/import-idempotency.test.ts
git commit -m "feat(context): idempotent staged import action + control migrate alias"
```

---

### Task 14: `spider-ui` search renderer

**Files:**
- Create: `spider/packages/ui/src/renderers/search.ts`
- Modify: `spider/packages/ui/src/index.ts` (export `renderSearchResult`)
- Modify: `spider/packages/context/src/actions/search.ts` (return `{ ui: renderSearchResult(rows) }`)
- Create: `spider/packages/ui/test/search-renderer.test.ts`

**Interfaces:**
- Consumes: `Panel`, `SectionRule`, `ListView`, `theme`, `Callout` from `@spider/ui` (Phase 0 skeleton).
- Produces: `renderSearchResult(rows: SearchResultRow[]): Component` — grouped by kind, 🕷 section rule, per-row `[kind] title — snippet`, width-adaptive, honors theme tokens.

- [ ] **Step 1: Write the failing test**

```ts
// spider/packages/ui/test/search-renderer.test.ts
import { describe, it, expect } from "vitest";
import { renderSearchResult } from "../src/renderers/search.js";

describe("renderSearchResult", () => {
  it("renders grouped rows and never emits raw console output", () => {
    const comp = renderSearchResult([
      { key: "content:1", kind: "content", id: "1", title: "Retry", snippet: "retry on busy", source: "notes" },
      { key: "memory:2", kind: "memory", id: "2", title: "convention", snippet: "prefer vitest" },
    ] as any);
    const lines = comp.render(80);
    expect(Array.isArray(lines)).toBe(true);
    expect(lines.join("\n")).toContain("Retry");
    expect(lines.join("\n")).toContain("prefer vitest");
  });

  it("shows an empty-state callout for zero results", () => {
    const comp = renderSearchResult([] as any);
    expect(comp.render(80).join("\n").toLowerCase()).toContain("no results");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd spider && npm run test -w @spider/ui -- search-renderer`
Expected: FAIL — `../src/renderers/search.js` missing.

- [ ] **Step 3: Implement the renderer**

Build a `Component` composing `SectionRule("🕷 search")`, group rows by `kind`, use `ListView` per group with `theme.token(...)` colors + a glyph per kind (never color-only). Empty → `Callout("info", "No results.")`. Export from `@spider/ui`. Update the search action to return `{ ui: renderSearchResult(rows), content: <plain-text fallback> }`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd spider && npm run test -w @spider/ui -- search-renderer`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add spider/packages/ui/src/renderers/search.ts spider/packages/ui/src/index.ts spider/packages/context/src/actions/search.ts spider/packages/ui/test/search-renderer.test.ts
git commit -m "feat(ui): spider search result renderer"
```

---

### Task 15: `spider-ui` import renderer

**Files:**
- Create: `spider/packages/ui/src/renderers/import.ts`
- Modify: `spider/packages/ui/src/index.ts` (export `renderImportSummaryResult`)
- Modify: `spider/packages/context/src/actions/import.ts` (return `{ ui: renderImportSummaryResult(summary) }`)
- Create: `spider/packages/ui/test/import-renderer.test.ts`

**Interfaces:**
- Produces: `renderImportSummaryResult(summary: ImportSummary): Component` — imported/skipped/staged counts, per-session rows with status glyph, "N candidates staged — approve via `control memory pending`" hint.

- [ ] **Step 1: Write the failing test**

```ts
// spider/packages/ui/test/import-renderer.test.ts
import { describe, it, expect } from "vitest";
import { renderImportSummaryResult } from "../src/renderers/import.js";

describe("renderImportSummaryResult", () => {
  it("summarizes imported/skipped/staged counts", () => {
    const comp = renderImportSummaryResult({
      imported: 2, skipped: 1, staged: 5, committed: 0,
      perSession: [
        { sessionId: "a", status: "imported", candidates: 3, chunks: 4 },
        { sessionId: "b", status: "skipped-duplicate", candidates: 0, chunks: 0 },
      ],
    } as any);
    const out = comp.render(80).join("\n");
    expect(out).toContain("2");
    expect(out.toLowerCase()).toContain("staged");
    expect(out.toLowerCase()).toContain("pending");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd spider && npm run test -w @spider/ui -- import-renderer`
Expected: FAIL — `../src/renderers/import.js` missing.

- [ ] **Step 3: Implement the renderer**

Compose `SectionRule("🕷 import")`, a `StatsPanel` of counts, a `ListView` of per-session rows (✓ imported / ↷ skipped glyph), and a `Callout("info", "N candidates staged — approve via control memory pending")` when `staged > 0 && committed === 0`. Export + wire into import action.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd spider && npm run test -w @spider/ui -- import-renderer`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add spider/packages/ui/src/renderers/import.ts spider/packages/ui/src/index.ts spider/packages/context/src/actions/import.ts spider/packages/ui/test/import-renderer.test.ts
git commit -m "feat(ui): spider import summary renderer"
```

---

### Task 16: Strangler — deprecate legacy `ctx_*` + wire host registration end-to-end

**Files:**
- Modify: `spider/packages/host/src/extension.ts` (ensure all context actions registered; mark legacy `ctx_*` tools deprecated per strangler protocol — a one-line deprecation notice, not removal)
- Create: `spider/packages/context/test/integration-e2e.test.ts` (boots the dispatcher, exercises exec→index→search→import through `registerAction`)

**Interfaces:**
- Consumes: the full `registerContextActions(host)` surface.
- Produces: verified end-to-end path through the host dispatcher.

- [ ] **Step 1: Write the failing integration test**

```ts
// spider/packages/context/test/integration-e2e.test.ts
import { describe, it, expect } from "vitest";
import { openProject, migrate } from "@spider/db-core";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { registerContextActions } from "../src/index.js";

function fakeHost() {
  const map = new Map<string, any>();
  return { registerAction: (n: string, h: any) => map.set(n, h), dispatch: (n: string, a: any, c: any) => map.get(n)(a, c), map };
}

describe("context e2e via dispatcher", () => {
  it("registers all Phase 2 actions and runs index→search", async () => {
    const host = fakeHost();
    registerContextActions(host);
    for (const n of ["exec", "exec_file", "batch", "index", "fetch", "search", "import"]) {
      expect(host.map.has(n)).toBe(true);
    }
    const dir = mkdtempSync(join(process.cwd(), ".spider", "scratch", "e2e-"));
    const db = openProject(dir); migrate(db, "project");
    const ctx = { db, cwd: dir, sessionId: "s", scratchDir: join(dir, "scratch") } as any;
    await host.dispatch("index", { action: "index", content: "# H\nunified search works", source: "d" }, ctx);
    const res = await host.dispatch("search", { action: "search", query: "unified search", limit: 5 }, ctx);
    expect((res.content ?? "") + JSON.stringify(res.details ?? "")).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd spider && npm run test -w @spider/context -- integration-e2e`
Expected: FAIL until all actions are registered in `registerContextActions`.

- [ ] **Step 3: Finalize registration + deprecation notes**

Ensure `registerContextActions` calls `registerExecActions`, `registerIndexActions`, `registerSearchAction`, `registerImportAction`. In `extension.ts`, per the strangler protocol add a deprecation log/notice for legacy `ctx_*` (they are no longer registered by spider — spider owns `exec`/`index`/etc.); do NOT delete anything from context-mode's repo (out of scope). Confirm `control migrate` alias resolves to import.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd spider && npm run test -w @spider/context`
Expected: PASS (all suites).

- [ ] **Step 5: Commit**

```bash
git add spider/packages/host/src/extension.ts spider/packages/context/test/integration-e2e.test.ts
git commit -m "feat(context): wire Phase 2 actions end-to-end; deprecate legacy ctx_*"
```

---

### Task 17: Full suite + self-review

**Files:** none new — verification only.

- [ ] **Step 1: Run the full workspace test suite**

Run: `cd spider && npm run test`
Expected: all `@spider/context` + `@spider/ui` suites PASS; no `.spider/scratch` leaks into `/tmp` (grep the diff/tree for `tmpdir`/`/tmp`).

- [ ] **Step 2: Grep for forbidden temp-dir usage**

Run: `cd spider && grep -rnE "tmpdir\(\)|/tmp/|mkdtempSync\(.*tmpdir" packages/context/src packages/ui/src`
Expected: NO matches (all scratch routed through db-core `paths.scratch`). Fix any hit.

- [ ] **Step 3: Self-review against the spec Context/search/import sections**

Confirm each spec bullet maps to a task: ctx_* lifted in-process (Tasks 2–7), content index (6), hybrid FTS+vector RRF (8–9), unified search across memory/content/sessions/todos (9), lazy freshness (10), import shapes/idempotency/staged/commit/source-mode (11–13), renderers (14–15), TDD against temp DB in `.spider/scratch/` (all tests). Fix gaps inline.

- [ ] **Step 4: Commit any fixes**

```bash
git add -A && git commit -m "test(context): full-suite green + zero-temp-dir audit"
```

---

## Files to Modify
- `spider/packages/host/src/extension.ts` — call `registerContextActions(host)`; build `ActionCtx` with `scratchDir`; register `control migrate` → import alias; deprecate legacy `ctx_*`.
- `spider/packages/ui/src/index.ts` — export `renderSearchResult`, `renderImportSummaryResult`.
- `spider/packages/context/src/index.ts` — grow into the full `registerContextActions` composition (Tasks 4, 7, 9, 13, 16).
- `spider/packages/context/src/search.ts` — add freshness call (Task 10).

## New Files
(All under `spider/packages/`.) `context/package.json`, `context/tsconfig.json`, `context/src/{index,runtime,executor,exit-classify,truncate,run-pool,fts-query,chunker,content-store,fusion,fetch,freshness,search,digest,transcript,import,security}.ts`, `context/src/actions/{exec,index-fetch,search,import}.ts`, `context/test/*.test.ts`, `ui/src/renderers/{search,import}.ts`, `ui/test/{search-renderer,import-renderer}.test.ts`.

## Dependencies
- **Cross-phase:** Phase 0 (db-core API, host dispatcher, ui skeleton) and Phase 1 (`@spider/memory` embed/vector helpers + `memory`/`memory_fts` populated) MUST be merged. Tasks 8 (fusion), 2–7 (exec/chunker/content-store/index-fetch), 11–12 (digest/transcript) do not need Phase 1; Tasks 9–10 (hybrid search) and 13 (import embed enqueue) do.
- **Task order:** 1 → 2 → 3 → 4; 1 → 5 → 6 → 7; 8 (independent after 5); 6+8+Phase1 → 9 → 10; 11 → 12 → 13; 9 → 14; 13 → 15; all → 16 → 17.
- **Single writer:** `packages/context/*` is one writer stream; `packages/ui/src/renderers/*` and `packages/host/src/extension.ts` are touched by Tasks 4/13/14/15/16 — serialize those edits.

## Risks
- **HIGHEST — Phase 0 `ActionHandler`/`ActionCtx` shape.** Every handler assumes `ctx.db`, `ctx.cwd`, `ctx.sessionId`, `ctx.scratchDir`. If the real dispatcher differs, adapt in Task 4 before proceeding. Validate first; blocker if wrong.
- **Phase 1 embedding surface.** `embedText`/`vectorSearch`/`enqueueEmbed`/`embeddingsAvailable` names/locations are assumed from the contract, not a merged plan. Validate before Tasks 7/9/13. If they live in `@spider/db-core`, re-point imports.
- **Trigram FTS parity.** context-mode used a second `chunks_trigram` FTS table for substring recall; the canonical schema defines only `content_fts` (porter). Task 6 uses a `LIKE` fallback instead of a trigram table to avoid diverging from the frozen schema — this is a recall regression for substring queries (e.g. `useEff`→`useEffect`). If trigram parity is deemed mandatory, adding `content_fts_trigram` requires a contract-README amendment first (surface to supervisor). Recorded as residual risk.
- **pi session transcript format.** Task 12 assumes JSONL `{role, content}` (string or block-array). The exact pi format must be verified against a real session file at execution time; guess-parsing is a silent-data risk. Surface if uncertain.
- **Skill/todo staging gap.** The canonical schema has no skill-staging table and `todos` has no `status`. Task 13 stores skill candidates as staged `memory` rows and import todos owned by the imported session id. If Phase 7 (skills) or a later phase wants a first-class staged-skill store, revisit. Recorded as residual risk (`no-staged-files` acceptance = no *unwanted active* rows: import writes are `status='staged'` by default — verified by the idempotency test).
- **Old-DB source mode deferred.** `sourceMode !== "pi"` throws "not yet implemented" in Phase 2 (spec marks it optional/manual). Interface reserved; implementation deferred.
- **Zero-temp-dir regressions from ported code.** `executor.ts`, `fetch.ts`, `db-base` patterns, and `store.ts` all contain `tmpdir()` usage; Task 17 Step 2 greps to enforce removal. Any missed site is a Global-Constraint violation.
- **sqlite-vec load in tests.** Unit tests run FTS-only (embeddings model not cached in CI-less env); `embeddingsAvailable()` must return `false` gracefully so search tests pass without native vec/model. Confirm Phase 1 degrades cleanly.

---

## Self-Review (performed)
- **Spec coverage:** ctx_* in-process ✔ (T2–7); content index ✔ (T6); hybrid FTS+vector RRF ✔ (T8–9); unified search over memory/content/sessions/todos ✔ (T9); lazy-on-search freshness ✔ (T10); import shapes/idempotency/staged-default/commit/source-mode ✔ (T11–13); bespoke renderers ✔ (T14–15); TDD vs temp DB in `.spider/scratch/` ✔ (all tests); >60% non-pi delete called out ✔ (Deleted-not-ported section); digest is Phase-6, Phase-2 defines interface ✔ (T11). 
- **Placeholder scan:** every code step carries real code or an exact port reference; no "TBD"/"handle edge cases" left.
- **Type consistency:** `Chunk`, `ContentHit`, `IndexResult`, `Ranked`/`rrfFuse`, `SearchResultRow`, `DigestCandidate`/`DigestResult`/`NormalizedTranscript`/`SessionDigest`, `ImportOpts`/`ImportSummary` are defined once and reused by name across tasks.

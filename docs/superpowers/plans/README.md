# spider — Phased Superplan (index + shared interfaces contract)

> **Read first:** `docs/superpowers/specs/2026-07-02-spider.md` (the design spec).
> **Every phase plan is authored against THIS contract.** Names, signatures, table/column names, and file paths defined here are canonical — do not rename them in phase plans. If a phase needs a new shared symbol, add it here first.

Each phase is its own plan file, TDD-executed with subagents + two-stage review per `superpowers:subagent-driven-development`.

| # | Plan file | Phase |
|---|-----------|-------|
| 0 | `2026-07-02-spider-phase0-foundation.md` | Foundation (monorepo, db-core, packaging, ui skeleton) |
| 1 | `2026-07-02-spider-phase1-memory-todo.md` | Memory (Hermes port) + Todo + embeddings |
| 2 | `2026-07-02-spider-phase2-context-search.md` | Context (ctx_* in-process) + unified search + import |
| 3 | `2026-07-02-spider-phase3-routing-safety.md` | Routing + safety layer |
| 4 | `2026-07-02-spider-phase4-subagents-runtime.md` | Subagents runtime + intercom auto-wake |
| 5 | `2026-07-02-spider-phase5-subagents-ui.md` | Subagents footer + live grid |
| 6 | `2026-07-02-spider-phase6-organism.md` | Autonomic organism |
| 7 | `2026-07-02-spider-phase7-superpowers-agentsmd.md` | Superpowers fork + AGENTS.md + upstream-watch |
| 8 | `2026-07-02-spider-phase8-polish.md` | Per-action renderers, slash cmds, config UI, doctor/stats/insights |

---

## Global execution protocol (applies to every task in every plan)

- **TDD, no exceptions:** write the failing test → run it (see it fail) → minimal impl → run (see it pass) → refactor → commit. Steps are 2–5 min each.
- **Frequent commits:** one commit per green task. Conventional-commit messages (`feat:`, `fix:`, `test:`, `chore:`).
- **Subagent-driven:** fresh subagent per task, two-stage review (spec-compliance + code-quality) with `context: "fresh"` reviewers who do not edit source.
- **Single writer at a time** per file/package.
- **Zero temp-dir:** integration DBs and scratch under `.spider/scratch/` or `~/.pi/agent/spider/scratch/`. Never `/tmp`.
- **Vitest** for all tests. **esbuild** for bundling. **better-sqlite3** for all DB access.
- **All spider visual output through `spider-ui`.**
- **Strangler:** when a phase's spider surface lands, deprecate (do not delete yet) the corresponding legacy tool; final removal in the phase that owns it.

---

## Monorepo layout (canonical paths)

```
spider/
├── package.json                    # workspaces: ["packages/*"]; "pi" manifest; "type":"module"
├── tsconfig.base.json
├── vitest.config.ts
├── esbuild.config.mjs              # bundles packages/host → dist/extension.js; externalizes native .node
├── scripts/postinstall.mjs        # native self-check + migration
├── packages/
│   ├── db-core/src/index.ts
│   ├── memory/src/index.ts
│   ├── context/src/index.ts
│   ├── todo/src/index.ts
│   ├── subagents/src/index.ts
│   ├── superpowers/               # skills/ + agentsmd manager + upstream-watch
│   ├── ui/src/index.ts
│   └── host/src/extension.ts      # THE single pi extension entry
└── docs/superpowers/{specs,plans}/
```

- Internal package names: `@spider/db-core`, `@spider/memory`, `@spider/context`, `@spider/todo`, `@spider/subagents`, `@spider/ui`, `@spider/host`.
- `package.json` `"pi"` manifest: `{ "extensions": ["./dist/extension.js"], "skills": ["./packages/superpowers/skills"] }`, keyword `pi-package`.

---

## Canonical DB schema (db-core owns; migrations create)

Two databases, same schema module (a `scope` discriminates where a table lives). **Global** = `~/.pi/agent/spider/spider.db`. **Project** = `<project>/.spider/project.db`. Every table has `created_at INTEGER NOT NULL` (epoch ms) and, where mutable, `updated_at INTEGER`.

### Global DB tables

```sql
-- The single canonical project resolver (kills context-mode #645).
CREATE TABLE projects (
  project_key     TEXT PRIMARY KEY,   -- from `git rev-parse --git-common-dir` (or real path if non-git)
  real_path       TEXT NOT NULL,
  git_common_dir  TEXT,
  db_path         TEXT NOT NULL,      -- absolute path to that project's project.db
  name            TEXT,               -- self-named
  created_at      INTEGER NOT NULL,
  last_seen_at    INTEGER NOT NULL,
  session_count   INTEGER NOT NULL DEFAULT 0,
  memory_count    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE global_memory (      -- cross-project truths (same shape as project memory)
  id INTEGER PRIMARY KEY, uuid TEXT UNIQUE NOT NULL,
  category TEXT NOT NULL, content TEXT NOT NULL, link TEXT,
  scope TEXT NOT NULL DEFAULT 'global',
  status TEXT NOT NULL DEFAULT 'active',   -- active | staged | rejected | archived
  source TEXT NOT NULL DEFAULT 'user',     -- user | auto | import
  confidence REAL, created_at INTEGER NOT NULL, updated_at INTEGER
);

CREATE TABLE upstream_refs (      -- upstream-watch bookkeeping
  package TEXT PRIMARY KEY,        -- db-core | memory | context | todo | subagents | superpowers
  upstream_repo TEXT NOT NULL, upstream_ref TEXT,
  last_reviewed_commit TEXT, last_checked_at INTEGER, notes TEXT
);

CREATE TABLE message_mirror (     -- observability mirror of intercom traffic (NOT the transport)
  id INTEGER PRIMARY KEY, from_session TEXT, to_session TEXT,
  kind TEXT, body TEXT, created_at INTEGER NOT NULL
);

CREATE TABLE insights (           -- learning graph nodes/edges + cross-project insights
  id INTEGER PRIMARY KEY, kind TEXT NOT NULL,   -- node | edge | insight
  a TEXT, b TEXT, weight REAL, payload TEXT, created_at INTEGER NOT NULL
);
```

### Project DB tables

```sql
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,                 -- pi native session id verbatim
  parent_session_id TEXT,              -- set for subagent children
  name TEXT,                           -- self-named
  reason TEXT,                         -- startup|new|resume|fork
  started_at INTEGER NOT NULL, ended_at INTEGER,
  summary TEXT, imported_from TEXT     -- source session id/path if via `import`
);
CREATE TABLE sessions_fts USING fts5(id UNINDEXED, name, summary, content);

CREATE TABLE memory (                  -- project-scoped truths
  id INTEGER PRIMARY KEY, uuid TEXT UNIQUE NOT NULL,
  category TEXT NOT NULL,               -- preference|convention|tool-quirk|failure|correction|insight
  content TEXT NOT NULL, link TEXT,     -- link TO a file/skill; never duplicate its content
  status TEXT NOT NULL DEFAULT 'active',-- active|staged|rejected|archived
  source TEXT NOT NULL DEFAULT 'user',  -- user|auto|import
  confidence REAL, session_id TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER
);
CREATE TABLE memory_fts USING fts5(uuid UNINDEXED, category, content, link);

CREATE TABLE content (                 -- context-mode content index chunks
  id INTEGER PRIMARY KEY, source TEXT NOT NULL, path TEXT, hash TEXT,
  heading TEXT, chunk TEXT NOT NULL, is_code INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE content_fts USING fts5(source, heading, chunk);

CREATE TABLE todos (
  id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, seq INTEGER NOT NULL,  -- per-session #id
  text TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER
);
CREATE TABLE todos_fts USING fts5(text, content=todos, content_rowid=id);

CREATE TABLE runs (                    -- subagent runs (replaces tmpdir JSON)
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, parent_run_id TEXT,
  agent TEXT NOT NULL, role TEXT, name TEXT,           -- self-named
  status TEXT NOT NULL,                 -- queued|running|paused|done|error|interrupted
  phase TEXT, model TEXT, task TEXT,
  started_at INTEGER, ended_at INTEGER,
  step_count INTEGER DEFAULT 0, token_count INTEGER DEFAULT 0,
  result TEXT
);
CREATE TABLE run_events (              -- append-only per-run activity + THE single event stream
  id INTEGER PRIMARY KEY, run_id TEXT, session_id TEXT NOT NULL,
  ts INTEGER NOT NULL, type TEXT NOT NULL,   -- tool_intent|tool_result|status|handoff|message|log
  tool TEXT, summary TEXT, payload TEXT
);

CREATE TABLE events (                  -- routing/tracking event log (agent tool activity)
  id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, ts INTEGER NOT NULL,
  phase TEXT NOT NULL,                  -- before|after
  tool TEXT NOT NULL, description TEXT, added INTEGER, removed INTEGER,
  flagged TEXT, payload TEXT
);

CREATE TABLE vectors (                 -- sqlite-vec virtual table (vec0), created at runtime after loadExtension
  -- vec0(embedding float[384]); rowid joins to owner via vector_map
);
CREATE TABLE vector_map (
  rowid INTEGER PRIMARY KEY, owner_kind TEXT NOT NULL,  -- memory|content|session|run
  owner_id TEXT NOT NULL, model TEXT NOT NULL, dim INTEGER NOT NULL
);
CREATE TABLE embed_queue (
  id INTEGER PRIMARY KEY, owner_kind TEXT NOT NULL, owner_id TEXT NOT NULL,
  text TEXT NOT NULL, enqueued_at INTEGER NOT NULL, tries INTEGER DEFAULT 0
);
```

---

## db-core public API (Phase 0 defines; all phases consume)

```ts
// @spider/db-core
export interface Db { /* thin better-sqlite3 wrapper with WAL+busy_timeout+retry */
  prepare(sql: string): Statement;
  transaction<T>(fn: () => T): () => T;
  loadVec(): void;                 // db.loadExtension(sqlite-vec) then create vec0 table
  close(): void;
}
export function openGlobal(): Db;                    // ~/.pi/agent/spider/spider.db
export function openProject(projectKey: string): Db; // resolves via registry → project.db
export function migrate(db: Db, scope: "global" | "project"): void;

// Project resolution (the canonical resolver)
export interface ProjectInfo { projectKey: string; realPath: string; gitCommonDir?: string; dbPath: string; name?: string; }
export function resolveProject(cwd: string): ProjectInfo;   // git rev-parse --git-common-dir; upserts registry
export function registerProject(info: ProjectInfo): void;

// Event stream (single stream, three consumers)
export type RunEvent = { runId?: string; sessionId: string; ts: number; type: string; tool?: string; summary?: string; payload?: unknown; };
export function appendRunEvent(db: Db, e: RunEvent): void;
export const bus: { on(fn: (e: RunEvent) => void): () => void; emit(e: RunEvent): void }; // in-process emitter for UI

// Paths (zero temp-dir)
export const paths: { globalRoot: string; projectRoot(cwd: string): string; scratch(scope): string; models: string; logs(scope): string; };
```

---

## spider tool dispatch (Phase 0 stubs the tool; each phase fills its action)

```ts
// packages/host — one registerTool("spider", ...)
type SpiderAction =
  | "search" | "remember" | "recall" | "exec" | "exec_file" | "batch"
  | "index" | "fetch" | "run" | "wait" | "todo" | "skill" | "import" | "message" | "control";
interface SpiderArgs { action: SpiderAction; /* action-specific fields */ [k: string]: unknown; }
// control: { action:"control", command: "stats"|"doctor"|"purge"|"upgrade"|"insights"|"switch-project"
//   |"registry"|"upstream-watch"|"memory"|"skill"|"config"|"grid"|"migrate"|"reembed", ...body }
```

Actions are registered by their owning subsystem via a dispatch map: `registerAction(name, handler)`. Phase 0 provides the empty dispatcher + `control doctor`/`config`; later phases call `registerAction`.

---

## spider-ui contract (Phase 0 skeleton; Phase 5/8 fill)

```ts
// @spider/ui
export interface Component { render(width: number): string[]; handleInput?(key: string): boolean; invalidate?(): void; }
export const theme: { token(name: string): string; glyph: "🕸"; };   // honor pi active theme tokens
export function Panel(opts): Component;
export function SectionRule(title?: string): Component;
export function StatusLine(opts): Component;
export function ListView<T>(items: T[], render: (t: T) => string): Component;
export function Picker<T>(items: T[], opts): Component;
export function StatsPanel(rows): Component;
export function Callout(kind, text): Component;
export function LiveWidget(source, render): Component;   // diffs; only repaints changed lines
// Phase 5: AgentFooter, Grid, GridCell, ProgressBar, DiffView, Spinner, Table
```

---

## Hook wiring (Phase 0 registers empty handlers; phases fill)

- `before_agent_start` → memory snapshot append (Phase 1), active-agents (Phase 5).
- `beforeToolCall` → intent log (Phase 3).
- `afterToolCall` → scrub/scan/auto-index (Phase 3).
- `session_before_compact` + `session_shutdown` → organism drain (Phase 6).
- `session_start` → session upsert + self-name schedule (Phase 1/6).
- `resources_discover` → contribute skills dirs + config hot-reload (Phase 0/7).

---

## Naming & versions (verbatim from spec Global Constraints)

- Node ≥ 22.19.0 (target 24), ESM. TypeScript.
- Native deps (prebuilt, cross-OS): better-sqlite3, sqlite-vec, onnxruntime-node (via fastembed-js).
- Default embed model: **BGE-small-en-v1.5**, dim **384**.
- Tool name `spider`; fork stays `superpowers`; glyph **🕸** (spider/web).
- Embedding `provider+model+dim` in config; dims index-locked (`control reembed` migrates).

---

## Amendments (v2 — post-planning reconciliation)

> These SUPERSEDE the draft phase plans wherever they conflict. Added after the parallel planners surfaced cross-phase gaps + the Q24 model-router requirement. Executors follow v2.

### A1 — `@spider/models` (ModelRouter) — NEW package, lands in Phase 0, consumed by 1/4/6/8

```ts
// @spider/models  (Q24 / TC8)
import { getModel, streamProxy } from "@earendil-works/pi-ai";
export type Tier = "nano" | "mini" | "standard" | "capable" | "reasoning";
export interface ModelEntry { provider: string; id: string; tier: Tier; reasoning: boolean; vision: boolean; ctx: number; speed: number; costHint: number; available: boolean; }
export function catalog(pi: PiCtx): ModelEntry[];   // GITHUB_COPILOT_MODELS ∩ creds.availableModelIds + models.json providers, enriched
export interface PickProfile { role?: string; complexity?: "low"|"med"|"high"; needsReasoning?: boolean; needsVision?: boolean; budget?: "cheap"|"normal"|"premium"; thinkingLevel?: "off"|"minimal"|"low"|"medium"|"high"|"xhigh"; }
export function pick(profile: PickProfile): ModelEntry;      // explicit override > config default > policy; only AVAILABLE; degrade a tier if unavailable
export function complete(model: ModelEntry, prompt: string, opts?: { system?: string; thinkingLevel?: string; maxTokens?: number }): Promise<string>;  // getModel()+streamProxy(); THE single aux-completion path (digests, self-name, upstream-watch). Exempt from routing.
export function recordModelStat(db: Db, s: { model: string; ms: number; ok: boolean; tokens: number }): void;
```
- **Resolves the Phase 6 "DigestModel" seam:** the organism/memory digests call `models.complete(models.pick({budget:"cheap"}), prompt)`. Phase 1's "aux-model digest routing" == `models.pick` + `models.complete`.
- Subagent `run` (Phase 4) auto-selects via `pick()` per task unless the caller passes `model`.

### A2 — `ActionCtx` + `ActionHandler` (canonical; matches Phase 0/1/2/4/6 handlers)

`registerAction` uses the **two-arg** form `(args, ctx)`. **Phase 0 (Task 10) defines the concrete `ActionCtx`**; later phases IMPORT it, never re-declare it. (Revised: earlier draft showed a single-object `(ctx)` form — superseded, since every phase's handlers use `(args, ctx)` with `globalDb`.)

```ts
export type ActionHandler = (args: SpiderArgs, ctx: ActionCtx) => Promise<unknown> | unknown;
export function registerAction(name: string, handler: ActionHandler): void;
export interface ActionCtx {
  db: Db;                    // project DB (openProject, resolved for cwd)
  globalDb: Db;              // global DB (registry, message_mirror, model_stats, insights)
  project: ProjectInfo;      // { projectKey, realPath, gitCommonDir?, dbPath, name? }
  sessionId: string;         // pi native session id, verbatim
  cwd: string;
  pi: ExtensionAPI;          // pi extension context (events, sendMessage, on, registerTool)
  auxModel?: string;         // cheap aux-model id hint from config (digest routing)
  models: typeof import("@spider/models");  // model router: catalog()/pick()/complete()
}
```
The host builds ONE `ActionCtx` per dispatch and calls `handler(args, ctx)`; the dispatcher may wrap a handler's returned value into pi's `{content, details?, isError?}` result shape. `@spider/ui` and the structured logger are imported directly as modules (not carried on ctx).

### A3 — db-core additions
- `export function openDbAt(absPath: string): Db;` and `export function openProjectByPath(realPath: string): Db;` (import, tests, cross-project reads need explicit-path opens).
- `vector_map` gains `embedding BLOB` (raw float32) so the brute-force cosine fallback works WITHOUT sqlite-vec.
- `appendRunEvent(db, e)` MUST also `bus.emit(e)` (single write path feeds the UI). Documented as one call.

### A4 — new tables (Phase 6/7/Q24 own their migrations; declared here to stay canonical)
```sql
-- project DB
CREATE TABLE skills (            -- AI-authored project skills registry (files live in .spider/skills/)
  id INTEGER PRIMARY KEY, slug TEXT UNIQUE NOT NULL, path TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',   -- active|stale|archived|staged
  pinned INTEGER NOT NULL DEFAULT 0, protected INTEGER NOT NULL DEFAULT 0,
  use_count INTEGER DEFAULT 0, last_used_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER
);
CREATE TABLE curator_state ( key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER );
-- global DB
CREATE TABLE model_stats (      -- Q24 lightweight learned-routing signal
  id INTEGER PRIMARY KEY, model TEXT NOT NULL, ms INTEGER, ok INTEGER, tokens INTEGER, ts INTEGER NOT NULL
);
```

### A5 — edit/write override handles (Phase 3)
There is NO executable `getTool`; override built-in `edit`/`write` by delegating to the exported `createEditToolDefinition` / `createWriteToolDefinition` (pi-agent-core), wrapping to (a) require a 1-line `description`, (b) capture `{description, +added/-removed}` from the unified patch, (c) omit `renderResult` so pi's native diff renderer is inherited. `scrubSecrets` + injection-scan live in `@spider/memory` (exported), wired into `afterToolCall` by Phase 3.

### A6 — VALIDATE-FIRST open items (resolve during execution, not blockers)
- pi session transcript on-disk format (Phase 2 `import`, Phase 6 digest) — confirm against a real `session.jsonl` before parsing.
- `resources_discover` merge semantics for contributing two skill dirs (Phase 0/7).
- **Ctrl+G may collide** with pi's built-in external-editor binding (Phase 5) — confirm; fall back to an unbound chord + `/agents` if taken.
- `content_fts` trigram/porter parity vs context-mode's dual-matcher (Phase 2) — keep single `content_fts` unless a test proves a regression.
- Real pi hook event names (`tool_call`/`tool_result` vs `beforeToolCall`/`afterToolCall`) — Phase 3 maps them; verify against `types.d.ts`.

### A7 — config: add `models` group
`models`: `{ autoSelect: bool=true, defaults: { <role|kind>: "<provider/id>" }, tierOverrides: {}, budgetCaps: {} }`.

### A8 — `@spider/models` v2: 3 tiers + preference-order + orthogonal THINKING lever (SUPERSEDES A1's tier model)

Rationale (validated against the live GitHub Copilot catalog + this account's `availableModelIds`): "reasoning" is not a tier — modern models expose a **thinking toggle**. Model selection has **two orthogonal levers**: (1) model quality = `Tier`, (2) `ThinkingLevel`. They form one cost/quality ladder: `light@any < standard(sonnet-5)@medium < heavy(opus-4.8)@low < heavy@medium < heavy@high < heavy@xhigh` (opus-low beats sonnet-high for ~equal cost).

```ts
export type Tier = "light" | "standard" | "heavy";                       // was nano|mini|standard|capable|reasoning
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
export interface ModelEntry { provider: string; id: string; tier: Tier; thinking: boolean; vision: boolean; ctx: number; speed: number; costHint: number; available: boolean; }  // reasoning -> thinking
// Ordered copilot ids; pick() returns the FIRST AVAILABLE per tier (auto-handles a model missing from this account, e.g. no *-nano):
export const TIER_PREFERENCE: Record<Tier, string[]> = {
  light:    ["mai-code-1-flash-picker", "claude-haiku-4.5", "gpt-5.4-nano", "gpt-5-mini", "gemini-3.5-flash"],
  standard: ["claude-sonnet-5", "claude-sonnet-4.6", "claude-sonnet-4.5", "gpt-5.4"],
  heavy:    ["claude-opus-4.8", "claude-opus-4.7", "claude-opus-4.6", "gpt-5.5"],
};
export function deriveTier(id: string): Tier;  // family heuristic: opus->heavy, sonnet->standard, haiku|mai|nano|mini|flash->light, gpt-5.5->heavy, else standard. NO reasoning tier.
export interface PickProfile { role?: string; tier?: Tier; complexity?: "low"|"med"|"high"; budget?: "cheap"|"normal"|"premium"; needsVision?: boolean; thinkingLevel?: ThinkingLevel; model?: string; }
export interface PickResult { entry: ModelEntry; thinkingLevel: ThinkingLevel; }  // pick returns BOTH levers
export function pick(entries: ModelEntry[], profile: PickProfile, cfg?: Partial<ModelsConfig>): PickResult;
// default thinking per tier (heavy defaults LOW): light->low, standard->medium, heavy->low; profile.thinkingLevel / cfg overrides.
export interface ModelsConfig { autoSelect: boolean; defaults: Record<string,string>; tierOverrides: Record<string,Tier>; tierPreference: Record<Tier,string[]>; thinkingDefaults: Record<string,ThinkingLevel>; }
```
- `pick` order: explicit `profile.model` (if available) > role `cfg.defaults[role]` (if available) > walk `(cfg.tierPreference||TIER_PREFERENCE)[targetTier]` first-available (vision-filtered if `needsVision`) > any available of that tier > degrade to adjacent tier (heavy<->standard<->light). `thinkingLevel = profile.thinkingLevel ?? cfg.thinkingDefaults[tier] ?? DEFAULT_THINKING[tier]`.
- `targetTier`: `profile.tier` > (`premium`|`high`)->heavy, (`cheap`|`low`)->light, else standard.
- **Copilot sync** (`scripts/sync-copilot-models.mjs`): query `api.githubcopilot.com/models` (auth.json copilot token), diff vs pi-ai `GITHUB_COPILOT_MODELS` built-in catalog + `~/.pi/agent/models.json`, and additively inject any exposed-but-missing id into models.json `providers["github-copilot"].models[]` with the correct `api` (claude->anthropic-messages, gpt/mai->openai-responses, gemini->openai-completions) + the copilot IDE `headers` (Editor-Version etc.) + baseUrl. Idempotent; preserves existing `modelOverrides`/entries. (Validated 2026-07-02: sonnet-5 + mai-code-1-flash-picker added this way both run.)

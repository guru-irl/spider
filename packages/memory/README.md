# @spider/memory

`@spider/memory` stores structured, categorized notes about a project or a user: preferences, conventions, tool quirks, failures, corrections, and insights. It screens every write, keeps an active set that is searchable and embeddable, and assembles that active set into a snapshot injected into the agent's system prompt at the start of each turn.

## Responsibility

This package owns:

- Structured memory records, at project or global scope, stored in the `memory` and `global_memory` tables. Each record has a category, content, an optional link, a status (`active`, `staged`, `rejected`, `archived`), a source (`user`, `auto`, `import`), and an optional confidence and session id.
- The write-approval pipeline: threat scanning, an anti-poisoning guardrail for background writes, duplicate detection, and the decision to stage or activate a write.
- Query-time recall: full-text search (project scope) or a `LIKE` scan (global scope), with vector KNN search layered on top when an embedder is available.
- The embedding pipeline for memory content: a queue table, a background drain worker, and the embedder resolution chain (`fastembed`, then `@xenova/transformers`, then none).
- The active-memory snapshot assembled for injection into the system prompt, and the hook handlers that inject it and record a session row.
- One-shot and streaming removal of the `<memory-context>` fence from provider output, so recalled memory does not leak back into a visible response.
- The `Panel` output rendered for the actions this package builds.

This package deliberately does not own:

- Table schema or migrations for `memory`, `global_memory`, `memory_fts`, `embed_queue`, or `vector_map`. Those belong to `@spider/db-core`.
- The `spider` tool's parameter schema, slash commands, or control-command routing table. Those belong to `@spider/host`.
- Search across content other than memory. Fusing memory with indexed content, sessions, and todos into one ranked result list is `@spider/context`'s unified search.
- Selecting or calling a model. `aux.ts` resolves a configured override and prepares a digest; the actual model pick and completion happen in the caller (`@spider/organism` together with `@spider/models`).
- Deciding when a session should be drained or when staged candidates should be curated. That is `@spider/organism`.

## Key modules

| File | What it does |
| --- | --- |
| `types.ts` | Shared types: `MemoryCategory`, `MemoryStatus`, `MemorySource`, `MemoryScope`, `MemoryRecord`, `AddMemoryInput`. |
| `store.ts` | Row-level operations against `memory` (project scope) and `global_memory` (global scope): insert, get by uuid, FTS/LIKE search, status transitions, archive-on-remove, duplicate check. |
| `internal.ts` | Private row-mapping and active-total helpers shared by `store.ts` and `staging.ts`. Not part of the public surface, except that `store.ts` re-exports two of its functions by name (see below). |
| `staging.ts` | The write-approval pipeline. `stageWrite` runs the scanner, the guardrail, and the duplicate check, then decides staged or active. Also lists, approves, and rejects pending writes. |
| `overflow.ts` | Enforces `DEFAULT_MEMORY_CHAR_CAP` (8000 characters of active content per scope). Throws `MemoryOverflowError`, carrying the current active entries, when a write would exceed the cap. |
| `guardrails.ts` | Anti-poisoning rules ported from hermes-agent's `background_review.py`. Rejects background writes describing negative tool claims, transient errors that already resolved, environment-dependent failures, or one-off task narratives, applied only to the `failure` and `tool-quirk` categories. |
| `scanner.ts` | Regex-based scanner for prompt-injection patterns, invisible unicode, and hardcoded credentials. Used by `stageWrite` on every write, and reused directly by the host's tool-output routing path. |
| `scrubber.ts` | Strips `<memory-context>` fences and the injected system note from provider output. Includes a streaming-safe state machine, `StreamingContextScrubber`, for text arriving in chunks. |
| `snapshot.ts` | Builds the char-capped, category-grouped active-memory block (`assembleSnapshot`) that gets injected into the system prompt. |
| `recall.ts` | Query-time lookup: vector KNN when an embedder is available and a query is given, FTS/LIKE fallback otherwise, or a plain listing of active records when there is no query. |
| `actions.ts` | Builders for the `remember`, `recall`, and `control` (`memory` sub-command) action handlers. |
| `hooks.ts` | Builders for the `before_agent_start` (append the snapshot to the system prompt) and `session_start` (insert a session row) hook handlers. |
| `renderers.ts` | `Panel` components for the remember, recall, and pending-list output. |
| `aux.ts` | Resolves an optional cheaper model override for the organism's background review, and compresses old conversation turns into a digest. Does not import `@spider/models`. |
| `embeddings/embedder.ts` | Resolves a text embedder: `fastembed` (native ONNX) first, `@xenova/transformers` (WASM) second, `null` if neither loads. |
| `embeddings/vectors.ts` | Float32Array/Buffer conversion, cosine similarity, `upsertVector`, and `knn` (sqlite-vec search with a brute-force cosine scan as fallback). |
| `embeddings/queue.ts` | The `embed_queue` producer (`enqueueEmbed`) and consumer (`drainEmbedQueue`), plus the unref'd interval worker (`startEmbedWorker`) that drains it in the background. |
| `index.ts` | Re-exports every module above and defines `registerMemory`, which wires the three actions and two hooks onto a pi-like API and starts the embed worker. |

## Public surface

The exports below are everything `index.ts` re-exports, grouped by concern.

### Actions and wiring

| Export | Purpose |
| --- | --- |
| `registerMemory(pi, deps)` | Registers `remember`, `recall`, `control`, and the two hooks on a pi-like API, and starts the background embed worker. |
| `makeRemember(deps)`, `makeRecall(deps)`, `makeControl(deps)` | Build the individual action handlers. |
| `makeBeforeAgentStart(deps)`, `makeSessionStart(deps)` | Build the two hook handlers. |
| `MemoryPiApi`, `MemoryDeps`, `MemoryConfig`, `HookDeps`, `ActionResult` | Types describing the host-shaped API and the dependencies each handler needs. |

### Write pipeline

| Export | Purpose |
| --- | --- |
| `stageWrite(db, scope, input, opts)` | Fail-closed write pipeline: scan, guardrail (background writes only), duplicate check, then stage or activate. |
| `listPending`, `approvePending`, `rejectPending` | List staged writes for a scope, promote one to active (re-checks the cap), or mark one rejected. |
| `addMemory`, `getMemory`, `setStatus`, `removeMemory`, `isDuplicate`, `searchMemoryFts` | Row-level operations used by `stageWrite`, and by callers that write memory once a decision is already made. |
| `activeCharTotal`, `listActive` | Current active-content character count, and the list of active records, for a scope. Re-exported from `internal.ts` through `store.ts`. |
| `DEFAULT_MEMORY_CHAR_CAP`, `MemoryOverflowError`, `assertWithinCap` | The cap constant, the error it throws, and the check function. |

### Recall and snapshot

| Export | Purpose |
| --- | --- |
| `recall(db, scope, query, embedder, opts)` | Query-time lookup: vector KNN with FTS/LIKE fallback, or a plain active-record listing with no query. |
| `assembleSnapshot(dbs, opts)` | Builds the frozen, char-capped snapshot of active memory across scopes. |

### Safety

| Export | Purpose |
| --- | --- |
| `shouldCapture(category, content)` | The anti-poisoning guardrail verdict for a background write. |
| `scanForThreats(content, scope)`, `firstThreatMessage(content, scope)` | Regex-based threat scan, and the human-readable message for the first match. |
| `scrubSecrets(text)` | Redacts credential-shaped substrings; returns the scrubbed text and the matched pattern ids. |
| `SECRET_PATTERNS`, `INVISIBLE_CHARS`, `MAX_SCAN_CHARS`, `ThreatScope`, `INJECTION_NOTE` | The pattern tables, the scan character bound, the scope type, and the note prepended to flagged tool output. |
| `sanitizeContext(text)`, `StreamingContextScrubber`, `buildMemoryContextBlock(raw)` | One-shot and streaming removal of `<memory-context>` fences, and the function that wraps a snapshot in one. |

### Embeddings

| Export | Purpose |
| --- | --- |
| `resolveEmbedder(cfg)`, `Embedder`, `EMBED_MODEL`, `EMBED_DIM` | Resolve the embedder implementation, or `null`, and its declared model name and dimension. |
| `enqueueEmbed`, `drainEmbedQueue`, `startEmbedWorker` | Queue a piece of text for embedding, drain the queue in batches, and run that drain on an interval. |
| `upsertVector`, `knn`, `cosine`, `f32ToBlob`, `blobToF32` | Vector storage and lookup: insert into `vector_map`/`vectors`, KNN search, cosine similarity, and Float32Array/Buffer conversion. |
| `OwnerKind`, `VecHit` | The record kinds a vector can belong to (`memory`, `content`, `session`, `run`), and the shape of a KNN hit. |

### Aux / digest routing

| Export | Purpose |
| --- | --- |
| `resolveAuxRuntime(cfg, parentModel)` | Resolves a configured override model for the organism's background review, and reports whether it differs from the parent model. |
| `digestHistory(messages, tail)` | Collapses older conversation turns into one synthetic digest message, keeping recent turns verbatim. |
| `AuxRuntime`, `DigestMsg` | Supporting types. |

### Rendering

| Export | Purpose |
| --- | --- |
| `renderRememberResult`, `renderRecallResult`, `renderPending` | Build the `Panel` component shown for each action's result. |

### Types

| Export | Purpose |
| --- | --- |
| `MemoryCategory`, `MemoryStatus`, `MemorySource`, `MemoryScope`, `MemoryRecord`, `AddMemoryInput` | The shared vocabulary used across the package. |

## How it fits

**Depends on:** `@spider/db-core` (the `Db` type, and `paths.models` for the embedder cache directory), `@spider/ui` (`Panel`, `Component` in `renderers.ts`), `fastembed` (the primary embedder), and optionally `@xenova/transformers` (the WASM fallback embedder). It does not depend on `@spider/models`, `@spider/subagents`, `@spider/todo`, `@spider/context`, `@spider/organism`, `@spider/host`, or `@spider/superpowers`.

**Depended on by:** `@spider/context` (`resolveEmbedder` and `knn` in its search fusion, `stageWrite`/`approvePending`/`enqueueEmbed` when importing prior sessions as memory), `@spider/organism` (`stageWrite`, `shouldCapture`, `knn`, `listActive`, `resolveAuxRuntime`, `digestHistory`, and the shared types, used by its passes and by `apply.ts` when writing digest candidates), and `@spider/host` (the action handlers, the hook logic, and the scanner/scrubber functions reused in tool-output routing).

**Where it sits in a request:**

- `spider remember` reaches the host's `remember` handler, which calls `stageWrite`. `stageWrite` scans the content, runs the guardrail for background writes, checks for a duplicate, then inserts the record as `staged` or `active` and enqueues it for embedding.
- `spider recall` reaches the host's `recall` handler, which calls `recall()`. `recall()` embeds the query and runs a vector KNN search when an embedder is available, falling back to FTS or `LIKE` otherwise, or lists active records when there is no query.
- `spider control memory` (`pending`, `approve`, `reject`, `consolidate`) reaches `listPending`, `approvePending`, or `rejectPending`.
- At the start of every agent turn, a `before_agent_start` hook calls `assembleSnapshot` and appends the result to the system prompt. At session start, a `session_start` hook inserts a row into the `sessions` table.
- Independent of the memory-write path, the host's tool-output routing (`packages/host/src/routing/safety.ts`) calls `scrubSecrets` and `scanForThreats` directly on tool output flowing through the routing loop.
- The background embed worker, started by `registerMemory` (or wired separately by the host), drains `embed_queue` on an interval and writes vectors into `vector_map` and, when `sqlite-vec` is loaded, the `vectors` virtual table.

## Notes

**Fail-closed staging.** `stageWrite` is the only path that turns an `AddMemoryInput` into a row. It runs the threat scanner (scope `strict`) on every write regardless of source; a match rejects the write before any row is inserted. It then runs the anti-poisoning guardrail (`shouldCapture`) only when `source` is `auto` or `import`; a `user`-sourced write skips the guardrail entirely. A duplicate (same category and content, same scope) is rejected without inserting a row. What remains is either staged or active: a write with `source: "auto"`, `source: "import"`, or the `autoStage` option is always staged, no matter what the caller asked for, and a staged insert bypasses the character cap by design. A `user`-sourced write without `autoStage` is inserted as `active` immediately, subject to the cap; if it would push the scope's active-content total over `DEFAULT_MEMORY_CHAR_CAP` (8000 characters, checked independently per scope), `assertWithinCap` throws `MemoryOverflowError` and no row is written. In the actual `remember` action, the caller decides `user` vs `auto` with a single `auto` boolean; the organism's `applyDigest` always calls `stageWrite` with `source: "auto", autoStage: true` for its background candidates, and `@spider/context`'s session import always uses `source: "import"`. Staged rows do not appear in `listActive`, `recall`, or the snapshot, since all three read only `status = 'active'`. A human reviews staged rows through `spider control memory pending` / `approve` / `reject`. `approvePending` re-checks the cap at approval time, so an approval can still fail with `MemoryOverflowError` if the scope has filled up since the write was staged. Nothing is ever hard-deleted: `rejectPending` moves a row to `status: 'rejected'`, and `removeMemory` moves it to `status: 'archived'`; both are retained in the table and removed only from the `memory_fts` mirror.

**Active-memory snapshot injection.** `assembleSnapshot` reads `listActive` for each requested scope (both global and project by default), combines the records into one list, sorts user-authored records first and then by recency (`updatedAt` or `createdAt`), and groups the sorted list by category in the order each category first appears. It writes category headers and content lines into a single string, stopping as soon as adding the next header or line would exceed a character cap (8000 by default), so once the cap is reached, any remaining categories are dropped entirely rather than truncated line by line. This cap is shared across both scopes combined, which differs from the write-time cap in `overflow.ts` that applies to each scope independently; a project and a global scope can each be within their own 8000-character write budget while the combined snapshot still truncates lower-priority entries. The resulting body is wrapped by `buildMemoryContextBlock` in a `<memory-context>` fence with a system note describing it as authoritative background, or returned as an empty string if there is nothing active to show. The `before_agent_start` hook appends this snapshot to `event.systemPrompt` only when the snapshot is non-empty and `event.systemPrompt` is already a string; it is a defensive no-op otherwise. The snapshot is computed fresh on each call but reflects only what is `active` at that moment: a memory approved mid-session does not change the prompt already sent for that turn, it takes effect starting with the next `before_agent_start` call, which in practice means the next turn or the next session.

**Other sharp edges:**

- The 8000-character default appears in three independent places that happen to agree today: `DEFAULT_MEMORY_CHAR_CAP` in `overflow.ts`, a module-private `DEFAULT_CHAR_CAP` in `snapshot.ts`, and an inline `?? 8000` fallback for `config.snapshotCharCap` in `hooks.ts`. None of the three imports another; changing one does not change the others.
- Project scope and global scope are stored differently. Project scope writes to `memory` and mirrors active rows into the `memory_fts` FTS5 table, so `searchMemoryFts` runs a real FTS query. Global scope writes to `global_memory`, which has no FTS table, so the same function runs a `LIKE '%query%'` scan instead.
- `recall()` only falls back to FTS/`LIKE` when an embedder is available but returns zero live matches (for example, nothing has been embedded yet), or when there is no embedder at all. It does not merge or rank FTS and vector results together.
- `knn()` tries a `sqlite-vec` `vectors MATCH` query first and falls back to a brute-force cosine scan over `vector_map` if `sqlite-vec` is not loaded or a dimension mismatch prevents the query. `upsertVector` always writes to `vector_map`; the `vectors` virtual-table insert is best-effort and silently skipped on failure.
- The embedder resolution chain tries `fastembed` (native ONNX, downloads and caches the `BGE-small-en-v1.5` model under `paths.models`) first, then `@xenova/transformers` (an optional dependency, WASM), then gives up and returns `null`. With no embedder, the package degrades to FTS/`LIKE`-only recall; nothing is embedded and `embed_queue` accumulates until an embedder becomes available.
- `isDuplicate` is an exact match on category and content text. There is no fuzzy or embedding-based deduplication.
- `guardrails.ts`, `scanner.ts`, `scrubber.ts`, and `aux.ts` are explicitly documented in their source comments as near-verbatim ports from an existing Python agent (hermes-agent) and a prior TypeScript memory store (pi-hermes-memory). The regex patterns and phrasing are intentional, not a first draft.
- `aux.ts` resolves configuration and builds a digest, but does not import or call `@spider/models`. Model selection and the actual completion call happen in `@spider/organism`.
- The host does not call `registerMemory`. It imports `stageWrite`, `recall`, `listPending`, `approvePending`, `rejectPending`, `activeCharTotal`, `listActive`, `resolveEmbedder`, and the renderers directly, and builds its own `remember`/`recall`/`control memory` handlers and `before_agent_start`/`session_start` hooks against its own per-call context and DB resolution. `registerMemory` and the `make*` builders in `actions.ts`/`hooks.ts` are exercised by this package's own test suite.

## See also

- [`../db-core/README.md`](../db-core/README.md): the schema and connection handling this package writes through.
- [`../context/README.md`](../context/README.md): unified search that fuses memory with other content, and session import into memory.
- [`../organism/README.md`](../organism/README.md): drains sessions and stages memory candidates through this package's write pipeline.
- [`../host/README.md`](../host/README.md): registers the actions and hooks this package builds, and reuses its scanner and scrubber for tool-output routing.
- [`../../docs/architecture/data-model.md`](../../docs/architecture/data-model.md): the `memory`, `global_memory`, `memory_fts`, `embed_queue`, and `vector_map` tables in context.
- [`../../docs/architecture/feedback-and-learning-loops.md`](../../docs/architecture/feedback-and-learning-loops.md): the full memory lifecycle and how it feeds the organism's learning loop.

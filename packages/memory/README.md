# @spider/memory

`@spider/memory` stores categorized notes at repo or global scope. It owns the write-approval pipeline, recall, embeddings, snapshot assembly, output scrubbing and memory result rendering. The host owns the spider actions, hooks, session binding resolution and configuration reads.

## Boundaries

- `@spider/db-core` owns SQLite connections, schema and migrations. Repo notes use `memory` and `memory_fts`; global notes use `global_memory` (no global FTS table).
- `@spider/host` registers `remember`, `recall` and `control memory`, and runs the `before_agent_start` hook. Its `readInjectionSnapshot` in `packages/host/src/injection-snapshot.ts` resolves the read-only session binding and reads global and repo files independently. A broken tier cannot hide the other tier. The host `session_start` hook records session metadata; it is not a memory hook.
- `@spider/context` combines memory with indexed content, sessions and todos for unified search. `@spider/organism` stages background memory candidates and decides when to drain sessions. The host does not start an embed worker during extension registration.

## Modules and exports

| Module | Main exports and role |
| --- | --- |
| `types.ts` | `MemoryScope` (`repo` or `global`), categories, statuses, sources and record/input types. |
| `store.ts`, `internal.ts` | `addMemory`, `getMemory`, `listActive`, `searchMemoryFts`, `setStatus`, `removeMemory`, `isDuplicate`, `activeCharTotal`; row mapping and tier validation. |
| `staging.ts`, `overflow.ts` | `stageWrite`, `listPending`, `approvePending`, `rejectPending`, `forgetMemory`; `DEFAULT_MEMORY_CHAR_CAP`, `assertWithinCap` and `MemoryOverflowError`. |
| `scanner.ts`, `guardrails.ts` | `scanForThreats`, `firstThreatMessage` and `shouldCapture` for threat and background-write checks. |
| `snapshot.ts`, `scrubber.ts` | `assembleSnapshotFromRecords`, `assembleSnapshotWithStats`, `assembleSnapshot`; `buildMemoryContextBlock`, `sanitizeContext` and `StreamingContextScrubber`. |
| `recall.ts` | `recall` uses repo vector KNN if available, then FTS fallback; global query uses `LIKE`. |
| `embeddings/embedder.ts`, `embeddings/vectors.ts`, `embeddings/queue.ts` | Embedder resolution, vector lookup/storage, enqueue/drain operations and optional background worker. |
| `renderers.ts`, `aux.ts` | Remember/recall/pending output panels; auxiliary model configuration and conversation digest. |
| `index.ts` | Re-exports the package modules above. The package does not register actions or hooks. |

## Write and approval lifecycle

The host `remember` action calls `stageWrite` with `source: "user"` for explicit writes or `source: "auto"` for auto captures. Imports use `source: "import"`. Every write first passes the strict threat scanner. Auto/import writes also pass the anti-poisoning guardrail. Duplicate checks compare exact category and content within a scope: active and staged rows block all sources, rejected rows also block auto/import re-proposals, and archived rows never block new writes.

Auto/import writes (or an explicit `autoStage` option) are staged. Foreground user writes activate immediately. Staged entries bypass the active-content cap and remain absent from active listing, recall and injection until approval. `approvePending` checks the write-time cap before activation; `rejectPending` retains a rejected row; `forgetMemory` archives an entry and removes its FTS mirror. The per-scope **write-time** active-content limit is `DEFAULT_MEMORY_CHAR_CAP` (8,000 characters). This is not a snapshot limit.

## Recall and injection

`recall(db, scope, query, embedder, opts)` lists active entries without a query. Repo queries use vector KNN when vectors and an embedder are available, falling back to `searchMemoryFts`. Repo FTS uses a shared sanitizer: punctuation and FTS operators (AND, OR, NOT, NEAR) are ignored, repeated terms are deduplicated, and common words are removed unless every term is common. Repo recall ranks all-word matches first (AND, by FTS bm25 then newest), then fills remaining slots from any-word matches (OR, by the same order) without duplicates. Global recall uses `LIKE` and matches the whole query as a substring of content, with newest matches first; it does not split or sanitize query words.

The host calls `readInjectionSnapshot` for both the hook and doctor. It resolves the session binding without writing a registry row and reads active records per tier from existing DBs, without migrating or creating them. `assembleSnapshotFromRecords` orders preferences, then corrections, then observations; within each priority band it groups by tier and category, prefers user-authored records and uses recency within each group. It reports per-tier active and injected counts. By default **there is no snapshot character cap**. If `memory.snapshotCharCap` is set, the host reads it from the resolved session target and passes it as an optional cap on the snapshot body; entries that do not fit are skipped while smaller later entries can still fit. An omission notice is appended, and doctor reports a warning. Clearing the UI field can set a project `unlimited` override when a global cap exists. `buildMemoryContextBlock` wraps included content in `<memory-context>`; the hook only appends it when the prompt is a string and the snapshot is non-empty.

The snapshot is recomputed for each `before_agent_start`; an approval appears at the next turn. `sanitizeContext` and `StreamingContextScrubber` remove the injected fence from output. The host's tool-output routing also calls the scanner and secret scrubber, independently of memory writes.

## See also

- [`../db-core/README.md`](../db-core/README.md) for schema and connections.
- [`../context/README.md`](../context/README.md) for unified search and session imports.
- [`../organism/README.md`](../organism/README.md) for background proposal staging.
- [`../host/README.md`](../host/README.md) for actions, hooks and diagnostics.
- [`../../docs/architecture/feedback-and-learning-loops.md`](../../docs/architecture/feedback-and-learning-loops.md) for the full lifecycle.

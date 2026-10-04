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
| `reviewed-write.ts` | `reviewedWrite`, `parseVerdict`, `reviewerContext`: deterministic checks, model verdict validation, scope redirects and atomic same-scope supersession. |
| `staging.ts`, `overflow.ts` | `stageWrite`, `listPending`, `approvePending`, `rejectPending`, `forgetMemory`; `DEFAULT_MEMORY_CHAR_CAP`, `assertWithinCap` and `MemoryOverflowError`. |
| `scanner.ts`, `guardrails.ts` | `scanForThreats`, `firstThreatMessage` and `shouldCapture` for threat and background-write checks. |
| `snapshot.ts`, `scrubber.ts` | `assembleSnapshotFromRecords`, `assembleSnapshotWithStats`, `assembleSnapshot`; `buildMemoryContextBlock`, `sanitizeContext` and `StreamingContextScrubber`. |
| `recall.ts` | `recall` uses repo vector KNN if available, then FTS fallback; global query uses `LIKE`. |
| `embeddings/embedder.ts`, `embeddings/vectors.ts`, `embeddings/queue.ts` | Embedder resolution, vector lookup/storage, enqueue/drain operations and optional background worker. |
| `renderers.ts`, `aux.ts` | Remember/recall/pending output panels; auxiliary model configuration and conversation digest. |
| `index.ts` | Re-exports the package modules above. The package does not register actions or hooks. |

## Write and approval lifecycle

The host `remember` action calls `reviewedWrite` with `source: "user"` for explicit writes or `source: "auto"` for auto captures. Imports use `source: "import"` in the staging pipeline. `reviewedWrite` validates the six memory categories and requires a justification before any review. It scans content and justification for threats, applies the anti-poisoning guardrail to auto/import writes, and checks for duplicates before calling the optional model reviewer. The reviewer considers active entries in both scopes for durability, overlap and scope, then returns `new`, `already_present`, `supersedes`, `wrong_scope` or `not_durable`. Invalid replies, timeouts, aborts and unavailable reviewers skip review and store as requested. Duplicate checks compare exact category and content within a scope: active and staged rows block all sources, rejected rows also block auto/import re-proposals, and archived rows never block new writes.

A reviewed foreground user write activates only when the verdict permits it. `not_durable` and `already_present` reject the candidate; `wrong_scope` can redirect it to the other scope. An active `supersedes` verdict archives only cited active entries in the requested scope, in the same immediate transaction as the insert. Foreground `remember` also accepts `supersedes: string[]`: full memory UUIDs or unique UUID prefixes in the write scope. The host passes this through `ReviewOptions.supersedes`. Unknown, ambiguous, inactive or cross-scope targets reject without writing. Explicit targets and same-scope reviewer targets are deduplicated, credited against the cap using their current active sizes, and archived atomically with insertion. Explicit replacement still runs the durability, usefulness and scope review; rejection archives nothing. Review errors, timeouts or disabled review still store as requested with explicit replacement. A scope redirect with explicit targets rejects rather than archiving across scopes. Staged auto/import writes reject explicit `supersedes`; no replacement intent is persisted. Reviewer-suggested targets on staged writes are related entries only, not promised archives. Approving a staged entry does not archive them; use a foreground `remember` with `supersedes` or `forget` explicitly. Direct `stageWrite` calls bypass model review; auto/import writes (or an explicit `autoStage` option) are staged. Staged entries bypass the active-content cap and remain absent from active listing, recall and injection until approval. `approvePending` reads staged status, checks the write-time cap and activates in one immediate transaction; `rejectPending` retains a rejected row; `forgetMemory` archives an entry and removes its FTS mirror. The per-scope **write-time** active-content limit is `DEFAULT_MEMORY_CHAR_CAP` (8,000 characters). This is not a snapshot limit. Recoverable overflow cards list all active entries with full UUIDs and sizes, mark replacement targets, and show replacement credit and projected usage. An entry larger than the cap by itself gets a shorten-it message without an eviction list.

## Recall and injection

`recall(db, scope, query, embedder, opts)` lists active entries without a query. Repo queries use vector KNN when vectors and an embedder are available, falling back to `searchMemoryFts`. Repo FTS uses a shared sanitizer: punctuation and FTS operators (AND, OR, NOT, NEAR) are ignored, repeated terms are deduplicated, and common words are removed unless every term is common. Repo recall ranks all-word matches first (AND, by FTS bm25 then newest), then fills remaining slots from any-word matches (OR, by the same order) without duplicates. Global recall uses `LIKE` and matches the whole query as a substring of content, with newest matches first; it does not split or sanitize query words.

The host calls `readInjectionSnapshot` for both the hook and doctor. It resolves the session binding without writing a registry row and reads active records per tier from existing DBs, without migrating or creating them. `assembleSnapshotFromRecords` orders preferences, then corrections, then observations; within each priority band it groups by tier and category, prefers user-authored records and uses recency within each group. It reports per-tier active and injected counts. By default **there is no snapshot character cap**. If `memory.snapshotCharCap` is set, the host reads it from the resolved session target and passes it as an optional cap on the snapshot body; entries that do not fit are skipped while smaller later entries can still fit. An omission notice is appended, and doctor reports a warning. Clearing the UI field can set a project `unlimited` override when a global cap exists. `buildMemoryContextBlock` wraps included content in `<memory-context>`; the hook only appends it when the prompt is a string and the snapshot is non-empty.

- The first `before_agent_start` freezes the snapshot, including an empty result. Later turns append the same memory text to the incoming prompt; writes, approvals, supersessions and cap changes appear next session.
- A different session ID or file, a fresh extension instance after reload, or a changed memory binding target rebuilds the block. Each subagent session freezes independently.
- Recall and doctor still read current active rows. Doctor uses current config, not the existing session's frozen snapshot.
- `sanitizeContext` and `StreamingContextScrubber` remove the injected fence from output. The host's tool-output routing also calls the scanner and secret scrubber, independently of memory writes.

## See also

- [`../db-core/README.md`](../db-core/README.md) for schema and connections.
- [`../context/README.md`](../context/README.md) for unified search and session imports.
- [`../organism/README.md`](../organism/README.md) for background proposal staging.
- [`../host/README.md`](../host/README.md) for actions, hooks and diagnostics.
- [`../../docs/architecture/feedback-and-learning-loops.md`](../../docs/architecture/feedback-and-learning-loops.md) for the full lifecycle.

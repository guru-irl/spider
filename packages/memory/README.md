# @spider/memory

`@spider/memory` stores categorized notes at repo or global scope. It owns the write-approval pipeline, recall, embeddings, snapshot assembly, output scrubbing and memory result rendering. The host owns the spider actions, hooks, session binding resolution and configuration reads.

## Boundaries

- `@spider/db-core` owns SQLite connections, schema and migrations. Repo notes use `memory` and `memory_fts`. Global notes use `global_memory`, and there is no global FTS table.
- `@spider/host` registers `remember`, `recall` and `control memory`, and runs the `before_agent_start` hook. Its `readInjectionSnapshot` in `packages/host/src/injection-snapshot.ts` resolves the read-only session binding and reads the global and repo files separately, so a broken tier cannot hide the other tier. The host `session_start` hook records session metadata. It is not a memory hook.
- `@spider/context` combines memory with indexed content, sessions and todos for unified search. `@spider/organism` stages background memory candidates and decides when to drain sessions. The host does not start an embed worker during extension registration.

## Modules and exports

| Module | Main exports and role |
| --- | --- |
| `types.ts` | `MemoryScope` (`repo` or `global`), categories, statuses, sources, and the record and input types. |
| `store.ts`, `internal.ts` | `addMemory`, `getMemory`, `listActive`, `searchMemoryFts`, `setStatus`, `removeMemory`, `isDuplicate`, `activeCharTotal`. Also row mapping and tier validation. |
| `reviewed-write.ts` | `reviewedWrite`, `parseVerdict`, `reviewerContext`. These run the deterministic checks, validate the model verdict, apply scope redirects and do atomic same-scope supersession. |
| `staging.ts`, `overflow.ts` | `stageWrite`, `listPending`, `approvePending`, `rejectPending`, `forgetMemory`. Also `DEFAULT_MEMORY_CHAR_CAP`, `assertWithinCap` and `MemoryOverflowError`. |
| `scanner.ts`, `guardrails.ts` | `scanForThreats`, `firstThreatMessage` and `shouldCapture`, which check for threats and gate background writes. |
| `snapshot.ts`, `scrubber.ts` | `assembleSnapshotFromRecords`, `assembleSnapshotWithStats`, `assembleSnapshot`. Also `buildMemoryContextBlock`, `sanitizeContext` and `StreamingContextScrubber`. |
| `recall.ts` | `recall` uses repo vector KNN when it is available and falls back to FTS. A global query uses `LIKE`. |
| `embeddings/embedder.ts`, `embeddings/vectors.ts`, `embeddings/queue.ts` | Embedder resolution, vector lookup and storage, enqueue and drain operations, and an optional background worker. |
| `renderers.ts`, `aux.ts` | Output panels for remember, recall and pending entries. Auxiliary model configuration and the conversation digest. |
| `index.ts` | Re-exports the package modules above. The package does not register actions or hooks. |

## Write and approval lifecycle

The host `remember` action calls `reviewedWrite` with `source: "user"` for explicit writes or `source: "auto"` for auto captures. Imports use `source: "import"` in the staging pipeline. `reviewedWrite` validates the six memory categories and requires a justification before any review. It scans the content and the justification for threats, applies the anti-poisoning guardrail to auto and import writes, and checks for duplicates. Then it calls the optional model reviewer. The reviewer checks the candidate against active entries in both scopes for durability, overlap and scope. It returns `new`, `already_present`, `supersedes`, `wrong_scope` or `not_durable`. If the reply is invalid, or the reviewer times out, aborts or is unavailable, the write skips review and is stored as requested. Duplicate checks compare exact category and content within a scope. Active and staged rows block all sources. Rejected rows also block auto and import re-proposals. Archived rows never block new writes.

A reviewed foreground user write becomes active only when the verdict permits it. `not_durable` and `already_present` reject the candidate. `wrong_scope` can redirect it to the other scope. An active `supersedes` verdict archives only the cited active entries in the requested scope, in the same immediate transaction as the insert.

Foreground `remember` also accepts `supersedes: string[]`, which holds full memory UUIDs or unique UUID prefixes in the write scope. The host passes this through `ReviewOptions.supersedes`. Unknown, ambiguous, inactive or cross-scope targets reject the write, and nothing is written. Explicit targets and same-scope reviewer targets are deduplicated. Their current active sizes count as credit against the cap, and they are archived atomically with the insert. Explicit replacement still runs the durability, usefulness and scope review, and a rejection archives nothing. If review errors, times out or is disabled, the write is still stored as requested, with the explicit replacement. A scope redirect with explicit targets rejects the write instead of archiving across scopes.

Staged auto and import writes reject explicit `supersedes`, and no replacement intent is saved. Targets that the reviewer suggests for a staged write are only related entries, not promised archives. Approving a staged entry does not archive them. To archive them, use a foreground `remember` with `supersedes`, or `forget` them explicitly. Direct `stageWrite` calls skip model review. Auto and import writes, or writes with an explicit `autoStage` option, are staged. Staged entries bypass the active-content cap. They stay out of active listing, recall and injection until approval.

`approvePending` reads the staged status, checks the write-time cap and activates the entry in one immediate transaction. `rejectPending` keeps a rejected row. `forgetMemory` archives an entry and removes its FTS mirror. The per-scope active-content limit at write time is `DEFAULT_MEMORY_CHAR_CAP` (8,000 characters). It is not a snapshot limit. A recoverable overflow card lists all active entries with full UUIDs and sizes, marks the replacement targets, and shows the replacement credit and projected usage. If one entry alone is larger than the cap, the card asks you to shorten it and shows no eviction list.

## Recall and injection

`recall(db, scope, query, embedder, opts)` lists active entries when there is no query. Repo queries use vector KNN when vectors and an embedder are available, and fall back to `searchMemoryFts`. Repo FTS uses a shared sanitizer. It ignores punctuation and FTS operators (AND, OR, NOT, NEAR) and keeps one copy of each repeated term. Common words are removed unless every term is common. Repo recall ranks all-word matches first (AND, by FTS bm25 and then newest). It then fills the remaining slots from any-word matches (OR, in the same order) without duplicates. Global recall uses `LIKE` and matches the whole query as a substring of the content, newest first. It does not split or sanitize the query words.

The host calls `readInjectionSnapshot` for both the hook and doctor. It resolves the session binding without writing a registry row. It reads active records per tier from existing DBs, and it does not migrate or create them. `assembleSnapshotFromRecords` orders preferences first, then corrections, then observations. Within each priority band it groups by tier and category, prefers records the user wrote, and orders each group by recency. It reports active and injected counts per tier.

By default there is no snapshot character cap. If `memory.snapshotCharCap` is set, the host reads it from the resolved session target and passes it as an optional cap on the snapshot body. Entries that do not fit are skipped, and smaller later entries can still fit. The snapshot gets an omission notice, and doctor reports a warning. Clearing the UI field can set a project `unlimited` override when a global cap exists. `buildMemoryContextBlock` wraps the included content in `<memory-context>`. The hook sets the block as `systemPromptOptions.sections.spider_memory`, or deletes only that section when the block is empty. It does not force the whole prompt. When the block is absent, it extends a prompt that an earlier extension forced.

- The first `before_agent_start` freezes the snapshot, even when it is empty. Pi 1.2.0 calls the hook for user runs and idle custom-message runs. The named section survives queued work, tool cycles, steers and follow-ups. Writes, approvals, supersessions and cap changes appear in the next session.
- The block is rebuilt when the session ID or file changes, the working directory changes, a fresh extension instance starts after reload, or the memory binding target changes. Each subagent session freezes its own block.
- Pi saves the global and repo snapshot in the local session file. An unchanged section produces one patch. A changed section appends new patches, and compaction checkpoints can copy the current section. Old values stay in the file. Session files and HTML or JSONL exports can contain this memory, so review them before you share them.
- Recall and doctor still read the current active rows. Doctor uses the current config, not the frozen snapshot of the existing session.
- `sanitizeContext` and `StreamingContextScrubber` remove the injected fence from output. The host's tool-output routing also calls the scanner and the secret scrubber, separately from memory writes.

## See also

- [`../db-core/README.md`](../db-core/README.md) for schema and connections.
- [`../context/README.md`](../context/README.md) for unified search and session imports.
- [`../organism/README.md`](../organism/README.md) for background proposal staging.
- [`../host/README.md`](../host/README.md) for actions, hooks and diagnostics.
- [`../../docs/architecture/feedback-and-learning-loops.md`](../../docs/architecture/feedback-and-learning-loops.md) for the full lifecycle.

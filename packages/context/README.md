# @spider/context

Implements the `exec`, `exec_file`, `batch`, `index`, `fetch`, `search`, and `import` actions of the `spider` tool. It is a sandboxed multi-language code executor, an indexed content store with a markdown chunker and FTS-plus-vector fusion search, a URL fetcher with a markdown cache, and a pi session importer, all built on the shared per-project SQLite database from `@spider/db-core`.

## Responsibility

This package owns:

- **Sandboxed code execution.** Running a script in one of twelve languages inside a per-project scratch directory, with a filtered environment, an optional timeout, and a hard cap on collected output (`executor.ts`, `runtime.ts`).
- **The content store.** Chunking arbitrary text (files, fetched pages, tool output, session transcripts) into heading- or paragraph-sized pieces and inserting them into the `content`/`content_fts` tables, so the text can be found again later without staying in the conversation (`content-store.ts`, `chunker.ts`).
- **Fetching.** Downloading a URL, converting HTML to markdown, and caching the result on disk (`fetch.ts`).
- **Unified search.** Combining SQLite FTS5 matches across content, memory, sessions, and todos with a vector nearest-neighbor pass, fusing both with reciprocal rank fusion, and reranking by title match and term proximity (`fusion.ts`, `fts-query.ts`, `search.ts`).
- **Session import.** Reading a pi `.jsonl` transcript, running it through a digest function, and turning the result into staged memory, todo rows, and indexed content (`transcript.ts`, `digest.ts`, `import.ts`).

This package does not own:

- Memory's staging and approval rules, or the embedding worker that drains the embed queue. It calls into `@spider/memory` (`stageWrite`, `approvePending`, `enqueueEmbed`, `resolveEmbedder`, `knn`) rather than reimplementing any of it.
- The todo package's API. `import.ts` inserts rows into the shared `todos` and `todos_fts` tables directly with raw SQL instead of going through `@spider/todo`'s store (see Notes).
- The policy of when to route large tool output into the content store automatically. That decision (a byte threshold, secret scrubbing, tracking) lives in `@spider/host`'s routing layer. This package only supplies the mechanism, `ContentStore`, that layer calls.
- Rendering for `exec`, `exec_file`, `batch`, `index`, and `fetch`. Those renderers live in `@spider/ui` and are used by the host. This package renders only the `search` and `import` results (`renderers.ts`).

### Why this package exists

A command's full output, a fetched page, or a large file does not need to sit in the model's context window to stay useful. `exec`, `exec_file`, and `batch` run code and hand back a byte-capped slice of stdout and stderr, not the full transcript. `index` and `fetch` chunk full text and store it as rows in the project database instead of returning it inline. The bytes stay in the database either way. `search` is what pulls a relevant slice back out later, on demand, so only what gets printed or matched by a query becomes part of the conversation.

## Key modules

### Actions (registered by `registerContextActions`)

| File | What it does |
| --- | --- |
| `actions/exec.ts` | `exec`, `exec_file`, and `batch`: run one script, run a script from a file with its content preloaded into a variable, or run several scripts in sequence. Caps the returned text at 200,000 bytes. |
| `actions/index-fetch.ts` | `index` and `fetch`: chunk and store text (`index`) or a fetched URL's converted markdown (`fetch`), then queue each new chunk for embedding. |
| `actions/search.ts` | `search`: runs `unifiedSearch` and formats the hits as numbered lines. |
| `actions/import.ts` | `import`: runs `importSessions` and formats the resulting counts. |

### Core modules

| File | What it does |
| --- | --- |
| `index.ts` | Re-exports every module in this package and defines `registerContextActions`, which wires all seven actions above into the host's action registry. |
| `executor.ts` | `PolyglotExecutor`: writes code to a temp file, resolves the right interpreter or compiler, spawns it with a filtered environment, and enforces the timeout and byte caps. |
| `runtime.ts` | Detects which language runtimes are actually installed (node/bun/deno, python3/python/py, ruby, go, rustc, php, perl, Rscript, elixir, dotnet-script, and the shell) and builds the argv for each, including Windows-specific handling. |
| `content-store.ts` | `ContentStore`: chunks and inserts text into `content`/`content_fts`, replacing any prior chunks for the same source, and runs the two-layer FTS lookup described in Notes. |
| `chunker.ts` | `chunkMarkdown`: splits markdown into heading-scoped chunks, keeps code fences intact, and caps each chunk at 4096 bytes by default, sub-splitting at paragraph boundaries when needed. |
| `fts-query.ts` | Builds a safe FTS5 `MATCH` string from a raw query, holds the stopword list, and provides the position and proximity math the reranker uses. |
| `fusion.ts` | `rrfFuse`: reciprocal rank fusion across ranked lists. `proximityRerank`: reorders fused hits by title match and term proximity or repetition. |
| `search.ts` | `unifiedSearch`: the FTS-plus-vector pipeline behind the `search` action. |
| `freshness.ts` | `refreshStaleContent`: re-hashes file-backed sources already in the content store and re-chunks any whose file changed on disk. |
| `fetch.ts` | `fetchAndConvert`: fetches a URL, converts HTML to markdown with `turndown`, and caches the markdown on disk keyed by a hash of the source and URL. |
| `transcript.ts` | `readTranscript` and `selectSessionFiles`: parse a pi `.jsonl` session file into a flat message list, and locate session files on disk by project, date, or glob. |
| `digest.ts` | The `SessionDigest` function type, and `defaultDigest`, a placeholder that returns no candidates and a truncated summary without calling a model. |
| `import.ts` | `importSessions`: the pipeline behind the `import` action (see How it fits). |
| `truncate.ts` | Byte-safe and character-safe string truncation, JSON truncation, and XML escaping, shared across the package. |
| `renderers.ts` | `renderSearchResult` and `renderImportResult`: turn `search` and `import` results into `@spider/ui` panels. |

## Public surface

The main names exported from `index.ts` (which re-exports every module above with `export *`):

**Registration**
- `registerContextActions(register)`: registers `exec`, `exec_file`, `batch`, `index`, `fetch`, `search`, and `import`.
- `runExec`, `runExecFile`, `runBatch`, `runIndex`, `runFetch`, `runSearch`, `runImport`: the individual action handlers.

**Execution**
- `PolyglotExecutor`: class with `execute()` and `executeFile()`.
- `detectRuntimes()`, `RuntimeMap`, `Language`: what is installed on the machine, and the language union the executor supports.
- `buildCommand(runtimes, language, filePath)`: the argv for a given language and script file.
- `getRuntimeSummary(runtimes)`, `getAvailableLanguages(runtimes)`, `hasBunRuntime()`: used by doctor-style diagnostics.
- A handful of smaller helpers exported mainly for their own unit tests: `buildScriptFilename`, `buildSpawnOptions`, `buildShellScriptContent`, `buildPowerShellScriptContent`, `rewriteWindowsBuildTools`, `isAllowlistedShell`, `resolveHookRuntime`, `resetHookRuntimeCache`.

**Content store and search**
- `ContentStore`: class with `indexContent()`, `ftsSearch()`, `deleteBySource()`, `listStaleSources()`.
- `chunkMarkdown(text)`, `chunkPlainText(text, linesPerChunk)`, `detectContentType(chunk)`: chunking strategies. Only `chunkMarkdown` is currently called by `ContentStore`; `chunkPlainText` is an alternate blank-line/fixed-window strategy that is exported but not wired into any caller yet.
- `unifiedSearch(db, opts)`: the pipeline behind the `search` action.
- `rrfFuse(lists, opts?)`, `proximityRerank(items, query)`: the fusion and rerank primitives `unifiedSearch` composes.
- `sanitizeQuery(query, mode?)`, `sanitizeTrigramQuery(query, mode?)`, `STOPWORDS`: FTS5 query construction.
- `refreshStaleContent(store, opts?)`: re-indexes file-backed sources whose hash changed.

**Fetch and import**
- `fetchAndConvert(url, source?, opts?)`: fetch, convert, cache.
- `importSessions(ctx, opts, digest?)`: the pipeline behind `import`.
- `readTranscript(path)`, `selectSessionFiles(opts)`: locate and parse session files.
- `defaultDigest`: a no-model `SessionDigest` placeholder.

**Shared helpers**
- `capBytes(str, maxBytes)`, `truncateJSON(value, maxBytes)`, `charSafePrefix(str, maxChars)`, `escapeXML(str)`: string truncation and escaping used across the package and by the host's rendering code.

**Rendering**
- `renderSearchResult(rows)`, `renderImportResult(summary)`: `@spider/ui` panels for the two actions this package renders itself.

## How it fits

**Depends on:**
- `@spider/db-core` for the `Db` handle and shared paths (`paths.scratch` resolves the sandbox temp directory and the fetch cache directory under the project's `.spider/scratch`).
- `@spider/memory` for memory staging (`stageWrite`, `approvePending`, `MemoryCategory`) during import, and for the embedding pipeline (`enqueueEmbed` to queue new chunks, `resolveEmbedder` and `knn` for the vector leg of search).
- `@spider/ui` for the `Panel`/`Component` primitives used in `renderers.ts`.
- `turndown` (npm), imported dynamically inside `fetchAndConvert` only when a fetched body looks like HTML.

**Depended on by:**
- `@spider/host`, which calls `registerContextActions` to wire the seven actions into the `spider` tool, imports `ContentStore` and `enqueueEmbed` directly to build the indexer its routing layer calls whenever a tool's output crosses a size threshold, and imports `renderImportResult` for display.
- `@spider/organism`, which calls `readTranscript` to normalize a finished session's `.jsonl` file before running its reflection and learning passes over it.

**Where it sits in a request:**
- `exec` / `exec_file` / `batch`: dispatch reaches `actions/exec.ts`, which builds a `PolyglotExecutor` scoped to the project directory. The executor writes the script under `<project>/.spider/scratch/.ctx-*`, spawns the resolved interpreter with the project root as its working directory and a filtered environment, and returns stdout/stderr capped to 200,000 bytes.
- `index` / `fetch`: dispatch reaches `actions/index-fetch.ts`. `index` chunks the given text or file directly; `fetch` first calls `fetchAndConvert`. Either way, `ContentStore.indexContent` deletes any prior chunks for that source, inserts the new ones into `content`/`content_fts`, and each new chunk is queued for embedding with `enqueueEmbed`.
- `search`: dispatch reaches `actions/search.ts`, which calls `unifiedSearch`. This runs bm25-ranked FTS queries against content, memory, sessions, and todos, adds a vector k-nearest-neighbor pass when the project has any embedded vectors at all, fuses every list with `rrfFuse`, hydrates vector-only hits from their owning table, reranks the merged list with `proximityRerank`, and returns snippets cut to 300 characters.
- `import`: dispatch reaches `actions/import.ts`, which calls `importSessions`. It resolves one or more transcript files, runs each through a digest function (`defaultDigest` unless the caller supplies one), stages memory/skill candidates through `@spider/memory`, writes todo rows, and indexes the transcript itself as content.

## Notes

- **The "porter" and "trigram" labels describe layers, not tokenizers.** `ContentStore.ftsSearch` tries an FTS5 `MATCH` query first (the code's internal name for this layer is `porter`, even though `content_fts` is created with FTS5's default tokenizer and no explicit stemmer configured). Only when that returns zero rows does it fall back to a plain substring scan over query terms of three or more characters (called the `trigram` layer, though it is a `LIKE` scan, not a real trigram-tokenizer index). A malformed `MATCH` query is caught and treated as zero porter hits rather than thrown.
- **Re-indexing a source replaces it.** `indexContent` deletes every existing chunk for a given `source` before inserting the new ones, so calling `index` again on the same source is an overwrite, not an append.
- **File reads guard against a swap between check and read.** `indexContent` and `refreshStaleContent` open the file, `fstat` the open descriptor to confirm it is a regular file, then read from that same descriptor, rather than checking the path and reopening it. A file replaced with a symlink or FIFO in between is rejected instead of silently read.
- **Stale-content refresh only covers file-backed sources, and does not re-embed.** `refreshStaleContent` runs automatically on every `search` call (best effort, capped at 50 sources per call) and only looks at content rows that were indexed with a `path`, so fetched pages and raw pasted content are never considered stale. When it re-chunks a changed file it calls `indexContent` directly rather than going through `runIndex`, so the new chunks are not queued for embedding. They are searchable by FTS immediately but need a fresh `index`/`fetch` call to pick up new vectors.
- **`import` writes directly into another package's tables.** It inserts into `todos`/`todos_fts` and `sessions`/`sessions_fts` with raw SQL rather than calling `@spider/todo`'s store, so its insert shape has to be kept in sync with that schema by hand if either one changes.
- **The sandbox filters the environment rather than passing it through.** `PolyglotExecutor` starts from the parent's environment and strips more than seventy individually named variables known to inject code or redirect execution (`NODE_OPTIONS`, `LD_PRELOAD`, `RUBYOPT`, `PYTHONSTARTUP`, several .NET profiler hooks, shell startup files, and similar), then forces `TMPDIR`, `HOME`, and a few other values to sandbox-safe settings.
- **Two independent byte caps apply to exec output.** The executor kills a process and appends a note to stderr if combined stdout and stderr exceed 100MB while streaming; separately, the `exec`/`exec_file`/`batch` action handlers cap the text they hand back to 200,000 bytes with `capBytes`. Only `exec` (not `exec_file` or `batch`) accepts a `background` flag, and a backgrounded, timed-out process is not treated as an error result.
- **Windows gets specific handling, not a shared code path.** Shell resolution prefers Git Bash over WSL bash, generated shell scripts avoid the `.sh` extension to dodge a Windows file-association popup, PowerShell scripts get a UTF-8 preamble, and a bare `mvn` command is rewritten to `mvn.cmd` to route around a Git Bash path-conversion bug in Maven's own launcher script.
- **`digest.ts`'s default is a stand-in.** `defaultDigest` makes no model call. It returns zero memory/skill/todo candidates and a truncated summary. `importSessions` accepts a real digest function as its third argument.
- **Fetch caching is keyed by source and URL, not URL alone.** `fetchAndConvert` caches converted markdown under `<project>/.spider/scratch/fetch-cache`, keyed by a hash of `source` plus `url` when a source is given, for 24 hours by default. `force` bypasses the cache; `ttl` overrides the window.

## See also

- [`../memory/README.md`](../memory/README.md): staging, approval, and the embedding queue this package writes into and reads from.
- [`../todo/README.md`](../todo/README.md): the todo store whose tables `import.ts` writes into directly.
- [`../db-core/README.md`](../db-core/README.md): the `Db` type, schema, and `paths` helper this package builds on.
- [`../organism/README.md`](../organism/README.md): the package that reads session transcripts through `readTranscript`.
- [`../host/README.md`](../host/README.md): registers these actions into the `spider` tool and owns the routing policy that decides when to auto-index tool output.
- [`../../docs/architecture/data-model.md`](../../docs/architecture/data-model.md): the `content`, `content_fts`, and `vector_map` tables this package reads and writes.
- [`../../docs/architecture/feedback-and-learning-loops.md`](../../docs/architecture/feedback-and-learning-loops.md): the routing loop that keeps large output out of the model's context window.

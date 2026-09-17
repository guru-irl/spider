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
- `exec` / `exec_file` / `batch`: dispatch reaches `actions/exec.ts`, which builds a `PolyglotExecutor` scoped to the project directory. A plain (non-`background`) call writes the script under `<project>/.spider/scratch/.ctx-*`, spawns the resolved interpreter with the project root as its working directory and a filtered environment, and returns stdout/stderr capped to 200,000 bytes. `background: true` uses a different, durable path — see "Background execution" below.
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
- **Two independent byte caps apply to exec output.** The executor kills a process and appends a note to stderr if combined stdout and stderr exceed 100MB while streaming in the FOREGROUND (piped) path; separately, the `exec`/`exec_file`/`batch` action handlers cap the text they hand back to 200,000 bytes with `capBytes`. A BACKGROUND run's pre-handoff streaming has its own, separate cumulative byte budget (same `hardCapBytes` number, different enforcement): once combined stdout+stderr streamed through `onData` crosses it, tailing stops and one bounded cap notice is emitted — the job is never killed for it, and the full log file on disk keeps growing past the cap regardless (see "Retention" above). Only `exec` (not `exec_file` or `batch`) accepts a `background` flag, and a backgrounded, timed-out process is not treated as an error result.

## Background execution (`exec { background: true }`)

`background: true` changes HOW a command's stdout/stderr are captured — straight to files
under a stable job directory, never a pipe to this process — from the moment it is spawned.
`timeout` is the separate decision of whether the process is ever **detached**:

- **No `timeout`, or the command finishes before `timeout` elapses:** this call waits for the
  real exit exactly like a normal exec (just routed via files instead of a pipe), streams
  `onData` the whole time, and returns the **true** `exitCode`. Nothing is silently detached.
  Because it was never handed off, its job directory is cleaned up immediately, same as a
  plain `.ctx-*` sandbox — nothing external could reference a path that was never returned.
- **`timeout` elapses while it is still running:** the process is detached instead of killed
  and this call returns immediately with `timedOut: true`, `backgrounded: true`, and
  **`exitCode: null`** — a launch is not a success, so it is never fabricated as `0`. The
  eventual truth lives in the receipt described below.

### Job directory layout

Each backgrounded run gets a stable, **caller-owned** directory at
`<project>/.spider/scratch/bg/<id>/` (`id` is a sortable `<UTC-compact>-<8hex>` string):

```
bg/<id>/
  script.<ext>      the generated script
  supervisor.cjs     the independent supervisor, emitted fresh at launch time
  job.json           the launch manifest (argv/cwd, written once before spawn)
  stdout.log         the child's stdout — direct file descriptor, not a pipe
  stderr.log         the child's stderr — same
  exit.json          the exit receipt — ABSENT until the real command exits
  tmp/               the child's own TMPDIR (kept separate from the job root)
```

`ExecResult.backgroundJob` returns `{ id, dir, manifest, receipt, logs }` — that is the
reachable inspection surface. There is no `list`/`status`/`cleanup` API in this package (a
deliberate phase-1 choice, see below); read the files directly, e.g.
`cat <dir>/exit.json`.

### Why a supervisor process

The parent never spawns the real command directly for a background run. It spawns a tiny
independent Node process (the source is a string constant, `BACKGROUND_SUPERVISOR_SOURCE` in
`background-job.ts`, emitted to `supervisor.cjs` at launch — **never** a shipped package file,
since the distributed artifact is a single bundled `dist/extension.js`). That supervisor spawns
the real command with `stdio: "inherit"` (the bytes still go straight to the same file
descriptions the parent opened — the proven parent-exit-survival topology is untouched), waits
for it to settle, and writes `exit.json` atomically (tmp file + rename — `job.json` is written
the same way, both by the parent and by the supervisor's own one-time `childPid` rewrite, so a
reader never observes a torn file either way). It mirrors the real command's fate as its OWN exit
code — a signal death maps to `128 + signal number` (the actual signal, e.g. 143 for SIGTERM —
never a hardcoded `128+9`), which is what lets `killTree` (which kills the whole process
**group**, supervisor included) look, from the parent's point of view, exactly like killing the
real command directly would have.

`ExecResult.pid` is the **supervisor's** pid (the process-group leader on POSIX).
`ExecResult.childPid` is the real command's pid, recorded by the supervisor into `job.json` as
soon as it spawns it — best-effort: it may not have landed yet at the exact instant of a timeout
handoff. Send a signal to `childPid` alone (not `pid`) to affect only the real command, or to
`-pid` (POSIX) to kill the whole group.

### The receipt is the only source of truth — and it can be honestly absent forever

`exit.json` looks like:

```json
{ "schema": 1, "state": "exited", "exitCode": 3, "signal": null,
  "childPid": 23169, "supervisorPid": 23161,
  "startedAt": "...", "endedAt": "..." }
```

`state: "spawn-error"` (with an `error` string, `exitCode: null`) means the real command never
even started. A signal death is `state: "exited"` with `exitCode: null` and `signal` set to the
actual signal name — never conflated with an exit code.

**Absence of `exit.json` is never evidence of success — or of failure.** A whole-process-group
`SIGKILL`, an OOM kill of the group, a supervisor killed alone (its own exit code, if any, is
meaningless — it says nothing about whether the real command is still running), or a power loss
all leave the receipt permanently absent, and no userspace design can observe its own death. The
executor's own close-path handling reads this file itself (`readReceiptSafe`) rather than ever
trusting the supervisor's raw exit code: no receipt → `exitCode: null` ("unknown", not "failed"
and not "succeeded"), with a plain-text note explaining exactly that; a receipt with `state:
"exited"` → its `exitCode`/`signal` is the honest truth, never the supervisor's own code.

### A supervisor exiting does not prove its process group is empty

A quick command can still leave live descendants behind — e.g. `(loop) & echo done` backgrounds a
subshell that keeps writing to the SAME log file for as long as it likes, with no timeout ever
elapsing and no handoff. Before treating a finished background run as safe to clean up, the
executor conservatively checks whether its process **group** still has any live member
(`groupHasLiveMembers` — POSIX `kill(-pgid, 0)`, which succeeds as long as ANY process in the
group exists, even after the original leader/supervisor has exited). Only a definite "no such
process" (`ESRCH`) counts as provably empty; "still alive" AND "cannot tell" (e.g. Windows, or a
pid this process doesn't own) are both treated as "cannot prove empty" — the job directory is
retained either way, with the retained `backgroundJob`/`backgroundLogs` handles returned so
nothing is lost invisibly, and a plain-text note explaining that its process group may still have
live members. This never kills anything to "resolve" the uncertainty — liveness is used only to
decide retention, never as license to intervene.

- **Known residual gap: this liveness check only covers the process GROUP, not every file
  user.** A descendant that escapes the group — e.g. it calls `setsid()`, or is double-forked into
  a brand-new session — while still holding the inherited `stdout.log`/`stderr.log` file
  descriptor open would make `kill(-pgid, 0)` report `ESRCH` ("provably empty") even though that
  descendant is still alive and could still write to the log. This is the one shape the current
  check cannot see: it verifies the group is gone, not that every process anywhere holding those
  specific fds is gone. It is undetected today, not merely undocumented before this note.

### `ExecOutcome` — the single discriminator every sink branches on

`ExecResult.outcome` is a structured terminal-state discriminator —
`"exited" | "signal" | "spawn-error" | "aborted" | "timeout" | "unknown"` — set
on every settled `ExecResult`, **foreground and background alike** (see
`ExecOutcome` in `executor.ts`). It exists because `exitCode === null` is
`null` for FOUR different situations that must never be treated identically:

- **`"exited"`**: a real numeric exit code was observed. `exitCode` is that value.
- **`"signal"`**: the command was killed by a signal — KNOWN, not still
  running. `exitCode` is `null`; `signal` names it (e.g. `"SIGTERM"`).
- **`"spawn-error"`**: the command never started — KNOWN. `exitCode` is `null`.
- **`"aborted"`**: the caller's `AbortSignal` fired and the process tree was
  killed — KNOWN. `exitCode` is the `137` sentinel.
- **`"timeout"`**: deliberately detached at a `timeout` handoff (background
  only) — genuinely still running, not known YET but will be (see the receipt
  below). `exitCode` is `null`.
- **`"unknown"`**: genuinely indeterminate — e.g. the supervisor died before
  it could write a receipt (background only). `exitCode` is `null`.

Every caller — `actions/exec.ts`'s model-facing text, `render-result.ts`'s host
mapping, and the `@spider/ui` renderer — branches on `outcome`, **never** on
`exitCode === null` alone, to decide what to say or show. This applies to
foreground execs too: an external signal, or the executor's own `timeout`/
`hardCapBytes` kill (both of which act via `killTree`, i.e. a real signal),
reports `outcome: "signal"` with the real signal name — never `"exited"` with
a fabricated-looking numeric code.

### `retained` vs `backgrounded`/`exitCode:null` — two different kinds of "not fully done"

`ExecResult` carries two DISTINCT signals for a backgrounded run, and they are
never conflated:

- **`exitCode: null`** on its own only tells you the field isn't a number —
  check `outcome` to know why. For `outcome === "timeout"` or `"unknown"` the
  real outcome genuinely has not settled (still running, or indeterminate),
  and the model-facing text/UI card use the neutral "detached"/"exit unknown"
  framing, correctly saying the call "returned before the command finished" —
  because, for those two cases, it did. For `outcome === "signal"` or
  `"spawn-error"`, the outcome **is** known — the command was killed by a
  signal, or never started — and both sinks render a real, visible failure
  (`✗ signal SIGTERM`, `✗ spawn error`) instead: that wording is reserved for
  the genuinely-still-running `timeout`/`unknown` cases only.
- **`retained: true`** means something orthogonal: the command's outcome **is**
  known (`outcome` is `"exited"`, `"signal"`, `"spawn-error"`, or `"aborted"` —
  `exitCode` may be a genuine number, the aborted `137` sentinel, or
  legitimately still `null` for a signal death/spawn error) — the receipt was
  read and trusted — but the job directory was kept around anyway because its
  process group could not be proven empty (the liveness check above). The
  text/card for this case keep the real, known outcome and add a distinct
  disclosure ("...but its job directory was retained — ...") instead of the
  "not known yet"/"returned before it finished" language, which would be false
  here.

An earlier version of this contract used `backgrounded: true` for BOTH cases —
"still running" AND "directory retained" — which produced a model-facing
result that simultaneously reported a real (or known) outcome and claimed the
command's status was still unknown. `retained` exists specifically so that
never happens again.

### Retention — explicit and non-destructive

- **Nothing is ever deleted automatically — and retention is conservative, not merely absent.**
  No age-based reaper, no session-start sweep, no size cap, no teardown kill of a backgrounded
  process (the old `cleanupBackgrounded()` was removed, not revived — killing a process the
  caller deliberately asked to outlive the session is the opposite of what background execution
  is for). A job that HAS genuinely finished with no live descendants (verified, not assumed —
  see "A supervisor exiting does not prove its process group is empty" above) is cleaned up
  exactly like the quick-command case below; anything less certain is retained.
- **The returned job directory is caller-owned from the moment it is returned.** This package
  never touches it again. There is intentionally no `list`/`status`/`cleanup` helper in this
  phase — exposing one that only tests could reach would be an unsupported, undocumented
  feature wearing a real one's clothes. A future `spider control background` command is a
  separate, reviewed addition, not something to bolt on quietly here.
- **A job that finishes before being handed off leaves no directory behind** — the "quick
  command under `background: true`" case above, PROVIDED its process group is verifiably empty;
  see the liveness note above. The empty `<scratch>/bg/` parent directory itself may still exist
  (creating a job always ensures its parent exists) — an empty directory with nothing inside it
  is harmless and is not treated as "a retained job".
- **Legacy `.ctx-*` directories from earlier versions of this code, or from tests/tools that
  predate this contract, are not touched, migrated, or reaped by this change.** Full log files
  on disk are unbounded by policy — only the STREAMING path (`onData` while the job runs) has a
  cumulative byte budget, and even that only stops delivering further chunks (emitting one
  bounded cap notice) rather than killing the job or trimming the file; a caller past the cap can
  still read the complete, ever-growing log directly from `backgroundLogs`. This is deliberately
  NOT the same guarantee as the foreground pipe path's cap, which kills the process once combined
  output crosses `hardCapBytes` — killing a detached job just because a UI's streaming budget
  filled up would defeat the entire point of backgrounding it. Rotating or truncating a durable
  log would break the very property that makes it trustworthy.
- **Rust never allocates the durable `bg/<id>/` namespace at all, background or not (I-4).**
  `#compileAndRun` does not forward `background` to the compiled binary's own run step (a Rust
  command always runs to completion in the foreground under the hood, pre-existing and unrelated
  to this contract) — no Rust binary is ever detached or left running past this call, and this is
  not invented daemon support. Because that early return happens BEFORE this package's normal
  cleanup step even for `background: true` requests, this package deliberately never allocates a
  durable `bg/<id>/` job directory for `language: "rust"` in the first place — it uses the same
  plain, throwaway `.ctx-*` sandbox a non-background exec would, exactly as if `background` had
  not been set. This avoids a namespace entry that could never have supported background
  semantics anyway; it does not change Rust's own (pre-existing, out of scope here) foreground
  cleanup behavior.

### Platform notes

- POSIX (verified): the supervisor is the process-group leader (`detached: true`); `killTree`
  (`process.kill(-pid, SIGKILL)`) reaches the supervisor and the real command together.
- Windows: `detached: false` (unchanged from the non-background path), so there is no process
  group; `taskkill /F /T` walks the parent-child tree instead. The `.cmd`/`.bat` shell-shim
  handling (`needsShell`) is preserved identically for the background manifest's `shellCommand`
  field. **Background survival across the launching process exiting is proven on POSIX only
  (macOS, Node 26) — it is not verified on Windows by this change.**
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

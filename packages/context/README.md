# @spider/context

Implements the `exec`, `exec_file`, `batch`, `index`, `fetch`, `search`, and `import` actions of the `spider` tool. The package has four parts, all built on the shared per-project SQLite database from `@spider/db-core`: a sandboxed multi-language code executor, an indexed content store with a markdown chunker and FTS-plus-vector fusion search, a URL fetcher with a markdown cache, and a pi session importer.

## Responsibility

This package owns:

- **Sandboxed code execution.** Running a script in one of twelve languages inside a per-project scratch directory, with a filtered environment, an optional timeout, and a hard cap on collected output (`executor.ts`, `runtime.ts`).
- **The content store.** Chunking any text (files, fetched pages, tool output, session transcripts) into pieces the size of a heading section or a paragraph, and inserting them into the `content` and `content_fts` tables. Search can then find the text later without it staying in the conversation (`content-store.ts`, `chunker.ts`).
- **Fetching.** Downloading a URL, converting HTML to markdown, and caching the result on disk (`fetch.ts`).
- **Unified search.** Combining SQLite FTS5 matches across content, memory, sessions, and todos with a vector nearest-neighbor pass, fusing both with reciprocal rank fusion, and reranking by title match and term proximity (`fusion.ts`, `fts-query.ts`, `search.ts`).
- **Session import.** Reading a pi `.jsonl` transcript, running it through a digest function, and turning the result into staged memory, todo rows, and indexed content (`transcript.ts`, `digest.ts`, `import.ts`).

This package does not own:

- Memory's staging and approval rules, or the embedding worker that drains the embed queue. It calls into `@spider/memory` (`stageWrite`, `approvePending`, `enqueueEmbed`, `resolveEmbedder`, `knn`) instead of reimplementing any of it.
- The todo package's API. `import.ts` inserts rows into the shared `todos` and `todos_fts` tables directly with raw SQL, instead of using `@spider/todo`'s store (see Notes).
- The policy for when to route large tool output into the content store automatically. `@spider/host`'s routing layer makes that decision (a string-length threshold, secret scrubbing, tracking). This package only supplies the mechanism that the layer calls, `ContentStore`.
- Rendering for `exec`, `exec_file`, `batch`, `index`, and `fetch`. Those renderers live in `@spider/ui`, and the host uses them. This package renders only the `search` and `import` results (`renderers.ts`).

### Why this package exists

A command's full output, a fetched page, or a large file does not need to sit in the model's context window to stay useful. `exec`, `exec_file`, and `batch` run code and return a byte-capped slice of stdout and stderr, not the full transcript. `index` and `fetch` chunk full text and store it as rows in the project database instead of returning it inline. Only indexed text is searchable. Spider does not index exec output automatically. To search it later, save it to a file and index that file. Only what a script prints or a query matches becomes part of the conversation.

## Key modules

### Actions (registered by `registerContextActions`)

| File | What it does |
| --- | --- |
| `actions/exec.ts` | Handles `exec`, `exec_file`, and `batch`. They run one script, run a script from a file with the file's content preloaded into a variable, or run several scripts in sequence. The handlers cap the returned text at 10,000 bytes. |
| `actions/index-fetch.ts` | Handles `index` and `fetch`. `index` chunks and stores text, and `fetch` does the same with a fetched URL's converted markdown. Both then queue each new chunk for embedding. |
| `actions/search.ts` | `search` runs `unifiedSearch` and formats the hits as numbered lines. |
| `actions/import.ts` | `import` runs `importSessions` and formats the resulting counts. |

### Core modules

| File | What it does |
| --- | --- |
| `index.ts` | Re-exports every module in this package and defines `registerContextActions`, which adds all seven actions above to the host's action registry. |
| `executor.ts` | `PolyglotExecutor` writes code to a temp file, resolves the right interpreter or compiler, spawns it with a filtered environment, and enforces the timeout and byte caps. |
| `runtime.ts` | Detects which language runtimes are actually installed (node/bun/deno, python3/python/py, ruby, go, rustc, php, perl, Rscript, elixir, dotnet-script, and the shell) and builds the argv for each, including Windows-specific handling. |
| `content-store.ts` | `ContentStore` chunks text and inserts it into `content` and `content_fts`, replacing any earlier chunks for the same source. It also runs the two-layer FTS lookup described in Notes. |
| `chunker.ts` | `chunkMarkdown` splits markdown into chunks scoped to headings and keeps code fences intact. It caps each chunk at 4096 bytes by default and splits further at paragraph boundaries when needed. |
| `fts-query.ts` | Builds a safe FTS5 `MATCH` string from a raw query, holds the stopword list, and provides the position and proximity math that the reranker uses. |
| `fusion.ts` | `rrfFuse` applies reciprocal rank fusion across ranked lists. `proximityRerank` reorders fused hits by title match and by term proximity or repetition. |
| `search.ts` | `unifiedSearch` is the FTS-plus-vector pipeline behind the `search` action. |
| `freshness.ts` | `refreshStaleContent` re-hashes the file-backed sources already in the content store and re-chunks any whose file changed on disk. |
| `fetch.ts` | `fetchAndConvert` fetches a URL, converts HTML to markdown with `turndown`, and caches the markdown on disk. The cache key is a hash of the source and URL. |
| `transcript.ts` | `readTranscript` parses a pi `.jsonl` session file into a flat message list. `selectSessionFiles` finds session files on disk by project, date, or glob. |
| `digest.ts` | The `SessionDigest` function type, and `defaultDigest`. `defaultDigest` is a placeholder that returns no candidates and a truncated summary without calling a model. |
| `import.ts` | `importSessions` is the pipeline behind the `import` action (see How it fits). |
| `truncate.ts` | Byte-safe and character-safe string truncation, JSON truncation, and XML escaping, shared across the package. |
| `renderers.ts` | `renderSearchResult` and `renderImportResult` turn `search` and `import` results into `@spider/ui` panels. |

## Public surface

These are the main names exported from `index.ts`, which re-exports every module above with `export *`.

**Registration**
- `registerContextActions(register)` registers `exec`, `exec_file`, `batch`, `index`, `fetch`, `search`, and `import`.
- `runExec`, `runExecFile`, `runBatch`, `runIndex`, `runFetch`, `runSearch`, and `runImport` are the individual action handlers.

**Execution**
- `PolyglotExecutor` is a class with `execute()` and `executeFile()`.
- `detectRuntimes()`, `RuntimeMap`, and `Language` report what is installed on the machine and define the language union that the executor supports.
- `buildCommand(runtimes, language, filePath)` returns the argv for a given language and script file.
- Doctor-style diagnostics use `getRuntimeSummary(runtimes)`, `getAvailableLanguages(runtimes)`, and `hasBunRuntime()`.
- Several smaller helpers are exported mainly for their own unit tests: `buildScriptFilename`, `buildSpawnOptions`, `buildShellScriptContent`, `buildPowerShellScriptContent`, `rewriteWindowsBuildTools`, `isAllowlistedShell`, `resolveHookRuntime`, `resetHookRuntimeCache`.

**Content store and search**
- `ContentStore` is a class with `indexContent()`, `ftsSearch()`, `deleteBySource()`, and `listStaleSources()`.
- `chunkMarkdown(text)`, `chunkPlainText(text, linesPerChunk)`, and `detectContentType(chunk)` are chunking strategies. `ContentStore` currently calls only `chunkMarkdown`. `chunkPlainText` is a different strategy that splits on blank lines or a fixed window. It is exported, but no caller uses it yet.
- `unifiedSearch(db, opts)` is the pipeline behind the `search` action.
- `rrfFuse(lists, opts?)` and `proximityRerank(items, query)` are the fusion and rerank functions that `unifiedSearch` combines.
- `sanitizeQuery(query, mode?)`, `sanitizeTrigramQuery(query, mode?)`, and `STOPWORDS` build FTS5 queries.
- `refreshStaleContent(store, opts?)` re-indexes file-backed sources whose hash changed.

**Fetch and import**
- `fetchAndConvert(url, source?, opts?)` fetches, converts, and caches.
- `importSessions(ctx, opts, digest?)` is the pipeline behind `import`.
- `readTranscript(path)` and `selectSessionFiles(opts)` find and parse session files.
- `defaultDigest` is a `SessionDigest` placeholder that calls no model.

**Shared helpers**
- `capBytes(str, maxBytes)`, `truncateJSON(value, maxBytes)`, `charSafePrefix(str, maxChars)`, and `escapeXML(str)` truncate and escape strings. This package and the host's rendering code use them.

**Rendering**
- `renderSearchResult(rows)` and `renderImportResult(summary)` build the `@spider/ui` panels for the two actions that this package renders itself.

## How it fits

This package depends on:
- `@spider/db-core` for the `Db` handle and shared paths. `paths.scratch` resolves the sandbox temp directory and the fetch cache directory under the project's `.spider/scratch`.
- `@spider/memory` for memory staging during import (`stageWrite`, `approvePending`, `MemoryCategory`) and for the embedding pipeline. `enqueueEmbed` queues new chunks, and `resolveEmbedder` and `knn` provide the vector part of search.
- `@spider/ui` for `Panel` and `Component`, which `renderers.ts` uses.
- `turndown` (npm). `fetchAndConvert` imports it dynamically, and only when a fetched body looks like HTML.

These packages depend on it:
- `@spider/host` calls `registerContextActions` to add the seven actions to the `spider` tool. It imports `ContentStore` and `enqueueEmbed` directly to build the indexer that its routing layer calls whenever a tool's output crosses a size threshold. It also imports `renderImportResult` for display.
- `@spider/organism` calls `readTranscript` to normalize a finished session's `.jsonl` file before it runs its reflection and learning passes over that file.

In a request, each action takes this path:
- For `exec`, `exec_file`, and `batch`, dispatch reaches `actions/exec.ts`, which builds a `PolyglotExecutor` scoped to the project directory. A plain call (without `background`) writes the script under `<project>/.spider/scratch/.ctx-*`. It spawns the resolved interpreter with the project root as its working directory and a filtered environment, and returns stdout and stderr capped to 10,000 bytes. `background: true` uses a different, durable path. See "Background execution" below.
- For `index` and `fetch`, dispatch reaches `actions/index-fetch.ts`. `index` chunks the given text or file directly, and `fetch` first calls `fetchAndConvert`. Either way, `ContentStore.indexContent` deletes any earlier chunks for that source and inserts the new ones into `content` and `content_fts`. Each new chunk is then queued for embedding with `enqueueEmbed`.
- For `search`, dispatch reaches `actions/search.ts`, which calls `unifiedSearch`. `unifiedSearch` runs bm25-ranked FTS queries against content, memory, sessions, and todos. If the project has any embedded vectors at all, it adds a vector k-nearest-neighbor pass. It fuses every list with `rrfFuse` and loads the full rows for vector-only hits from the tables that own them. It then reranks the merged list with `proximityRerank` and returns snippets cut to 300 characters.
- For `import`, dispatch reaches `actions/import.ts`, which calls `importSessions`. `importSessions` resolves one or more transcript files and runs each through a digest function (`defaultDigest` unless the caller supplies one). It stages memory and skill candidates through `@spider/memory`, writes todo rows, and indexes the transcript itself as content.

## Notes

- **The "porter" and "trigram" labels describe layers, not tokenizers.** `ContentStore.ftsSearch` tries an FTS5 `MATCH` query first. The code calls this layer `porter`, even though `content_fts` uses FTS5's default tokenizer with no stemmer configured. Only when that query returns zero rows does it fall back to a plain substring scan over query terms of three or more characters. The code calls that the `trigram` layer, but it is a `LIKE` scan, not a real trigram-tokenizer index. If a `MATCH` query is malformed, the method catches the error and counts it as zero porter hits instead of throwing.
- **Re-indexing a source replaces it.** `indexContent` deletes every existing chunk for a given `source` before it inserts the new ones. Calling `index` again on the same source overwrites it and does not append.
- **File reads guard against a swap between check and read.** `indexContent` and `refreshStaleContent` open the file and `fstat` the open descriptor to confirm that it is a regular file. They then read from that same descriptor, instead of checking the path and reopening it. If the file is replaced with a symlink or FIFO in between, they reject it instead of reading it.
- **Stale-content refresh only covers file-backed sources, and does not re-embed.** `refreshStaleContent` runs automatically on every `search` call, as a best effort and for at most 50 sources per call. It looks only at content rows indexed with a `path`, so fetched pages and raw pasted content never count as stale. When it re-chunks a changed file, it calls `indexContent` directly instead of going through `runIndex`, so it does not queue the new chunks for embedding. FTS can find the new chunks at once, but they need a fresh `index` or `fetch` call to get new vectors.
- **`import` writes directly into another package's tables.** It inserts into `todos`, `todos_fts`, `sessions` and `sessions_fts` with raw SQL instead of calling `@spider/todo`'s store. If those tables or this code change, the insert shape has to be updated by hand to match.
- **`digest.ts`'s default is a stand-in.** `defaultDigest` makes no model call. It returns zero memory, skill or todo candidates and a truncated summary. `importSessions` accepts a real digest function as its third argument.
- **Fetch caching is keyed by source and URL, not URL alone.** `fetchAndConvert` caches converted markdown under `<project>/.spider/scratch/fetch-cache` for 24 hours by default. When a source is given, the cache key is a hash of `source` plus `url`. `force` bypasses the cache, and `ttl` overrides the time window.
- **The sandbox filters the environment rather than passing it through.** `PolyglotExecutor` starts from the parent's environment and strips more than seventy individually named variables that can inject code or redirect execution. Examples are `NODE_OPTIONS`, `LD_PRELOAD`, `RUBYOPT`, `PYTHONSTARTUP`, several .NET profiler hooks, and shell startup files. It then sets `TMPDIR`, `HOME`, and a few other values to sandbox-safe settings.
- **Two independent byte caps apply to exec output.** In the foreground (piped) path, if combined stdout and stderr exceed 100MB while streaming, the executor kills the process and appends a note to stderr. Separately, the `exec`, `exec_file`, and `batch` action handlers use `capBytes` to cap the text they return at 10,000 bytes. A background run has its own cumulative byte budget for streaming before handoff. It uses the same `hardCapBytes` number but enforces it differently. Once the combined stdout and stderr streamed through `onData` cross it, tailing stops and one bounded cap notice is emitted. The job is never killed for it, and the full log file on disk keeps growing past the cap anyway (see [Retention](#retention-explicit-and-non-destructive) below). Only `exec` accepts a `background` flag, not `exec_file` or `batch`. A process that was sent to the background when its timeout elapsed does not count as an error result.

## Background execution (`exec { background: true }`)

`background: true` changes how a command's stdout and stderr are captured, from the moment the
command is spawned. They go straight to files under a stable job directory, never through a pipe
to this process. `timeout` separately decides whether the process is ever **detached**.

- **No `timeout`, or the command finishes before `timeout` elapses.** This call waits for the
  real exit, exactly like a normal exec, except that the output goes through files instead of a
  pipe. It streams `onData` the whole time and returns the true `exitCode`. Nothing is detached
  without notice. Because the job was never handed off, its job directory is cleaned up at once,
  the same as a plain `.ctx-*` sandbox. Nothing outside could refer to a path that was never
  returned.
- **`timeout` elapses while it is still running.** The process is detached instead of killed.
  This call returns at once with `timedOut: true`, `backgrounded: true`, and
  `exitCode: null`. A launch is not a success, so the result never reports a made-up `0`. The
  receipt described below records the eventual result.

### Job directory layout

Each backgrounded run gets a stable directory at `<project>/.spider/scratch/bg/<id>/`, and the
caller owns that directory. `id` is a sortable `<UTC-compact>-<8hex>` string:

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

`ExecResult.backgroundJob` returns `{ id, dir, manifest, receipt, logs }`, which is how a caller
inspects the job. This package has no `list`, `status` or `cleanup` API. Read the files directly, for
example `cat <dir>/exit.json`.

### Why a supervisor process

For a background run, the parent never spawns the real command directly. It spawns a small,
independent Node process. The source of that process is a string constant,
`BACKGROUND_SUPERVISOR_SOURCE` in `background-job.ts`, which the parent writes to
`supervisor.cjs` at launch. It is never a shipped package file, because the distributed artifact
is a single bundled `dist/extension.js`. The supervisor spawns the real command with
`stdio: "inherit"`. The bytes still go straight to the same file descriptions that the parent
opened, so the setup that already proved to survive the parent's exit does not change. The
supervisor waits for the command to settle, then writes `exit.json` atomically (a tmp file plus a
rename). `job.json` is written the same way, both by the parent and by the supervisor's own
one-time `childPid` rewrite, so a reader never sees a torn file. The supervisor exits with the
real command's result as its own exit code. A death by signal maps to `128 + signal number`,
using the actual signal (for example 143 for SIGTERM), never a hardcoded `128+9`. Because of
this, `killTree`, which kills the whole process group including the supervisor, looks to the
parent exactly like killing the real command directly.

`ExecResult.pid` is the supervisor's pid (the process-group leader on POSIX).
`ExecResult.childPid` is the real command's pid. The supervisor records it in `job.json` as soon
as it spawns the command, as a best effort, so it may not be there yet at the exact moment of a
timeout handoff. To affect only the real command, send a signal to `childPid` alone, not `pid`.
To kill the whole group, send it to `-pid` (POSIX).

### The receipt is the only source of truth, and it can be honestly absent forever

`exit.json` looks like this:

```json
{ "schema": 1, "state": "exited", "exitCode": 3, "signal": null,
  "childPid": 23169, "supervisorPid": 23161,
  "startedAt": "...", "endedAt": "..." }
```

`state: "spawn-error"` (with an `error` string and `exitCode: null`) means that the real command
never started. A death by signal is `state: "exited"` with `exitCode: null` and `signal` set to
the actual signal name. It is never mixed up with an exit code.

**The absence of `exit.json` is never evidence of success, and never evidence of failure.**
Several events leave the receipt permanently absent: a `SIGKILL` of the whole process group, an
OOM kill of the group, a supervisor killed on its own, or a power loss. A supervisor killed on its
own may leave an exit code, but that code says nothing about whether the real command is still
running. No userspace design can observe its own death. The executor's close path reads this
file itself (`readReceiptSafe`) and never trusts the supervisor's raw exit code. With no receipt,
the result is `exitCode: null` ("unknown", not "failed" and not "succeeded"), with a plain-text
note that says so. With a receipt that has `state:
"exited"`, its `exitCode` and `signal` are the true result, never the supervisor's own code.

### A supervisor exiting does not prove its process group is empty

A quick command can still leave live descendants behind. For example, `(loop) & echo done` puts a
subshell in the background, and that subshell can keep writing to the same log file for as long as
it likes, with no timeout elapsing and no handoff. Before the executor treats a finished
background run as safe to clean up, it checks whether the run's process group still has any live
member (`groupHasLiveMembers`). The check is POSIX `kill(-pgid, 0)`, which succeeds as long as any
process in the group exists, even after the original leader (the supervisor) has exited. Only a
definite "no such process" (`ESRCH`) counts as proof that the group is empty. "Still alive" and
"cannot tell" (for example on Windows, or for a pid this process does not own) both count as
"cannot prove empty". In either case the executor keeps the job directory and returns the
retained `backgroundJob` and `backgroundLogs` handles, so nothing is lost without notice. It also
adds a plain-text note that the process group may still have live members. The executor never
kills anything to settle the uncertainty. It uses liveness only to
decide retention, never as license to intervene.

- **Known residual gap. The liveness check covers only the process group, not every process that
  uses the log files.** A descendant can leave the group, for example by calling `setsid()` or by
  being double-forked into a new session, while it still holds the inherited `stdout.log` or
  `stderr.log` file descriptor open. Then `kill(-pgid, 0)` reports `ESRCH` ("provably empty"),
  even though that descendant is alive and can still write to the log. The current check cannot
  see this case. It verifies that the group is gone, not that every process holding those
  specific fds is gone. Nothing detects this case today, so it is a real gap, not only a gap in
  the documentation.

### `ExecOutcome`: the single discriminator every sink branches on

`ExecResult.outcome` is a structured field that names the terminal state:
`"exited" | "signal" | "spawn-error" | "aborted" | "timeout" | "unknown"`. It is set
on every settled `ExecResult`, foreground and background alike (see
`ExecOutcome` in `executor.ts`). It exists because `exitCode === null` is
`null` in four different situations that must never be treated the same way:

- `"exited"` means a real numeric exit code was observed. `exitCode` is that value.
- `"signal"` means a signal killed the command. The outcome is known, and the
  command is not still running. `exitCode` is `null`, and `signal` names the
  signal (for example `"SIGTERM"`).
- `"spawn-error"` means the command never started. The outcome is known.
  `exitCode` is `null`.
- `"aborted"` means the caller's `AbortSignal` fired and the process tree was
  killed. The outcome is known. `exitCode` is the `137` sentinel.
- `"timeout"` means the process was detached on purpose at a `timeout` handoff
  (background only). The command is still running. Its outcome is not known
  yet. Read the [receipt](#the-receipt-is-the-only-source-of-truth-and-it-can-be-honestly-absent-forever)
  above when it is available. The receipt may never appear. `exitCode` is `null`.
- `"unknown"` means the outcome cannot be determined. For example, the
  supervisor died before it could write a receipt (background only).
  `exitCode` is `null`.

Every caller decides what to say or show by branching on `outcome`, never on
`exitCode === null` alone. The callers are the model-facing text in
`actions/exec.ts`, the host mapping in `render-result.ts`, and the `@spider/ui`
renderer. This applies to foreground execs too. An external signal, or the
executor's own `timeout` or `hardCapBytes` kill, reports `outcome: "signal"`
with the real signal name. The executor's `timeout` and `hardCapBytes` kills
both act through `killTree`, which sends a real signal. The result never reports
`"exited"` with a numeric code that looks made up.

### `retained` vs `backgrounded`/`exitCode:null`: two different kinds of "not fully done"

`ExecResult` carries two distinct signals for a backgrounded run, and they
never mean the same thing:

- **`exitCode: null` on its own says only that the field is not a number.**
  Check `outcome` to learn why. For `outcome === "timeout"` or `"unknown"`, the
  real outcome has not settled (the command is still running, or the outcome
  cannot be determined). For these two cases the model-facing text and the UI
  card use neutral "detached" or "exit unknown" wording. They say that the call
  "returned before the command finished", which is true for these cases. For
  `outcome === "signal"` or `"spawn-error"`, the outcome is known. A signal
  killed the command, or the command never started. The text and the card
  then both show a real, visible failure (`✗ signal SIGTERM`, `✗ spawn error`).
  The "detached" wording is only for the `timeout` and `unknown` cases, where
  the command may still be running.
- **`retained: true` means something unrelated.** The command's outcome is
  known: `outcome` is `"exited"`, `"signal"`, `"spawn-error"`, or `"aborted"`.
  `exitCode` may be a real number, the `137` sentinel for an abort, or
  legitimately still `null` for a death by signal or a spawn error. The
  executor read the receipt and trusted it. It kept the job directory anyway,
  because it could not prove the process group empty (see the liveness check
  above). The text and the card for this case keep the real, known outcome and
  add a separate disclosure (`...but its job directory was retained — ...`).
  They do not use the "not known yet" or "returned before it finished" wording,
  which would be false here.

An earlier version of this contract used `backgrounded: true` for both cases,
"still running" and "directory retained". The model-facing result then reported
a real or known outcome and, at the same time, said the command's status was
still unknown. `retained` exists so that this does not happen again.

### Retention: explicit and non-destructive

- **Nothing is ever deleted automatically, and retention is conservative, not just the absence
  of deletion.** There is no age-based reaper, no sweep at session start, no size cap, and no
  kill of a backgrounded process at teardown. The old `cleanupBackgrounded()` was removed and has
  not come back. Killing a process that the caller asked to outlive the session would defeat the
  purpose of background execution. A job that has finished with no live descendants is
  cleaned up exactly like the quick-command case below. The executor verifies this and does not
  assume it (see "A supervisor exiting does not prove its process group is empty" above).
  Anything less certain is kept.
- **The caller owns the returned job directory from the moment it is returned.** This package
  never touches it again. There is no `list`, `status` or `cleanup` helper. A helper that only
  tests could reach would be an unsupported, undocumented feature that looks like a real one. A future `spider control background` command would be a separate,
  reviewed addition, not something added quietly here.
- **A job that finishes before handoff leaves no directory behind.** This is the "quick command
  under `background: true`" case above, provided that its process group is verifiably empty (see
  the liveness note above). The empty `<scratch>/bg/` parent directory may still exist, because
  creating a job always creates its parent. An empty directory is harmless and does not count as
  a retained job.
- **This change does not touch, migrate or reap legacy `.ctx-*` directories.** These come from
  earlier versions of this code, or from tests and tools that predate this contract. By policy,
  full log files on disk have no size limit. Only the streaming path (`onData` while the job
  runs) has a cumulative byte budget. Even that budget only stops delivering more chunks and
  emits one bounded cap notice. It does not kill the job or trim the file. A caller past the cap
  can still read the complete, growing log directly from `backgroundLogs`. This guarantee is
  deliberately different from the cap on the foreground pipe path, which kills the process once
  combined output crosses `hardCapBytes`. Killing a detached job because a UI's streaming budget
  filled up would defeat the point of running it in the background. Rotating or truncating a
  durable log would break the property that makes it trustworthy.
- **Rust never allocates the durable `bg/<id>/` namespace at all, background or not.** The
  comments in `executor.ts` label this rule I-4. `#compileAndRun` does not pass `background` to
  the run step of the compiled binary. A Rust command always runs to completion in the foreground
  internally, which predates this contract and is unrelated to it. No Rust binary is ever detached
  or left running past this call, and this package does not pretend to support Rust daemons.
  That early return happens before this package's normal cleanup step, even for
  `background: true` requests. So for `language: "rust"` this package never allocates a durable
  `bg/<id>/` job directory in the first place. It uses the same plain, throwaway `.ctx-*` sandbox
  that a non-background exec uses, exactly as if `background` had not been set. This avoids a
  namespace entry that could never have supported background behavior. It does not change Rust's
  own foreground cleanup behavior, which predates this change and is out of scope here.

### Platform notes

- On POSIX (verified), the supervisor is the process-group leader (`detached: true`). `killTree`
  (`process.kill(-pid, SIGKILL)`) reaches the supervisor and the real command together.
- On Windows, the supervisor runs with `detached: false` (unchanged from the non-background
  path), so there is no process group. `taskkill /F /T` walks the parent-child tree instead. The background manifest's
  `shellCommand` field keeps the `.cmd` and `.bat` shell-shim handling (`needsShell`) exactly as
  before. **Background survival after the launching process exits is proven on POSIX only
  (macOS, Node 26). This change does not verify it on Windows.**
- **Windows gets specific handling, not a shared code path.** Shell resolution prefers Git Bash over WSL bash. Generated shell scripts avoid the `.sh` extension to prevent a Windows file-association popup. PowerShell scripts get a UTF-8 preamble. A bare `mvn` command is rewritten to `mvn.cmd` to work around a Git Bash path-conversion bug in Maven's own launcher script.

## See also

- [`../memory/README.md`](../memory/README.md): staging, approval, and the embedding queue that this package writes into and reads from.
- [`../todo/README.md`](../todo/README.md): the todo store whose tables `import.ts` writes into directly.
- [`../db-core/README.md`](../db-core/README.md): the `Db` type, schema, and `paths` helper that this package builds on.
- [`../organism/README.md`](../organism/README.md): the package that reads session transcripts through `readTranscript`.
- [`../host/README.md`](../host/README.md): registers these actions in the `spider` tool and owns the routing policy that decides when to auto-index tool output.
- [`../../docs/architecture/data-model.md`](../../docs/architecture/data-model.md): the `content`, `content_fts`, and `vector_map` tables that this package reads and writes.
- [`../../docs/architecture/feedback-and-learning-loops.md`](../../docs/architecture/feedback-and-learning-loops.md): the routing loop that keeps large output out of the model's context window.

# Runtime lifecycle

## Build identity and doctor

- A bundle contains a `SPIDER_BUILD_ID=<sha>[-dirty]@<ISO timestamp> v<version>` header.
- Watch rebuilds record a fresh timestamp. "Dirty" means changes to tracked files only. Untracked local state does not make a build dirty.
- A build made without git, or outside its own checkout root, uses commit `unknown`. Source development without a bundle reports unknown metadata.
- `/doctor` reports the identity loaded in this session. It then reads the installed header from the same file location, without importing or running the file again.
- The package version alone does not identify a build.

| Bundle status | Meaning or remedy |
| --- | --- |
| `current` | The loaded and installed build identities match. |
| `RELOAD NEEDED` | The bundle changed, and the loaded URL has the `?build=` query that the generated shim adds. Use `/reload`. |
| `RESTART NEEDED` | A direct load, an old-shim load, or a fallback load has no query. Restart pi. |
| Unreadable or marker unavailable | Doctor cannot verify the installed identity and does not claim it is current. |

- Child diagnostics say that the next child dispatched loads the new bundle.
- If the query is missing, doctor also suggests that you regenerate a linked shim with `npm run link` and then restart once.
- Bundle freshness is for information only. It does not fail the health check by itself.
- Updating the file does not replace code that a session has already loaded.

## Linked shims

- The [README](../../README.md#install-update-and-remove) covers stable installation and updates. [Contributing](../../CONTRIBUTING.md#setup) covers linking for watch builds.
- Do not load a linked shim and the package directly at the same time. Both activate spider, and the tool is registered twice.
- `npm run link` writes the stable `spider.ts` shim, and `npm run dev:link` writes the development `spider-dev.ts` shim. Both point to the checkout where you ran the command. If you move the checkout, link again.
- The shim uses `runInThisContext` and `USE_MAIN_CONTEXT_DEFAULT_LOADER` to import the bundle natively in the main context. This bypasses the way jiti rewrites dynamic imports.
- The shim's cache key is the bundle's mtime and size. After a changed build completes, `/reload` loads it fresh. An unchanged file reuses the module already loaded.
- During the synchronous compile and import calls, the shim suppresses only the loader-specific `ExperimentalWarning`. It restores normal warning handling before it awaits anything.
- The shim falls back to a plain `import(bundle)` in three cases: the VM loader constant is not available, compilation throws, or the native import fails with a loader or resolution error code on the allowlist.
- Native errors not on the allowlist are thrown again, with no retry. If the fallback also fails, the message names both failures, and an `AggregateError` keeps both original errors.
- A fallback load needs a restart after each rebuild. A plain dynamic import with a query does not load reliably through pi's jiti loader.
- The allowlist identifies error codes, not the phase of the load. Keep the bundle's top level free of resource setup and of top-level awaits on optional modules.
- `npm run build` checks the native import without activating the extension.

## Reload and shutdown cleanup

- Node keeps earlier rebuilt module instances until the process exits. Restart after many reloads of rebuilt bundles, or when you need full cleanup at the process level.
- Each activation owns its own action closures. The global registry supplies actions that other code registered and that the activation does not own.
- On shutdown, the activation releases its action closures, tool error marks, UI target, organism and routing references, and the database handles it owns. It does not clear the state of another live activation.
- Cleanup waits for organism shutdown work to finish.
- This cleanup does not cancel every action in flight. Some action and UI handles have no explicit close path.
- Eligible background children survive a reload and the new activation adopts them again. Chains stop, pending intercom calls stop, and later pipeline stages do not resume.
- Quit, `/new`, `/resume`, and `/fork` stop the children that the session owns. See [Subagents](../guide/subagents.md#reload-survival-internals) for registry versions, buffers, adoption, and expiry.

## Process-wide embedder

- The embedder starts lazily, on first use. It occupies a versioned global-symbol slot keyed by model. Concurrent callers share one initialization.
- Recall, search and organism reflection use the embedder only if it is already ready. They never wait for first-time setup or a model download. While setup runs, recall and search use full-text results. Global recall and recall without a query do not start setup.
- All fastembed loading and inference run in an isolated Node child process. That includes the query vectors for recall and search. The parent and child exchange texts and `Float32Array` results through advanced IPC serialization. There is no fallback provider on the main thread. The process boundary keeps native ORT teardown aborts away from pi. The child has ignored stdio, a separate process group on POSIX, and does not inherit `NODE_OPTIONS` preloads or the inspector. On Windows, `detached` gives the child a separate console, which `windowsHide` hides. That is not the same as POSIX process-group isolation. The child runs from the models directory. Genuine Node runtimes are supported whatever the executable name or versioned path. Bun and Node single-executable applications, detected through `node:sea` when it is available, are not run as Node. They fall back to FTS and the cooldown.
- The idle child and the IPC channel are unreferenced, so they do not keep the process alive. Pending embeds keep a reference to IPC until the last reply arrives. Shutdown does the following:
  - It cancels pending embeds at once and leaves their queue rows retryable.
  - It sends SIGKILL only to a positive child pid, never to a process group, and waits for the child to exit. It does not drain inference in flight.
  - Concurrent callers of stop share the same wait for exit.

  Shutdown runs after organism reflection, on session shutdown and on `/reload`, even while the embedder is still initializing. Storage maintenance is fenced off first. Once teardown begins, every embedder getter returns null and cannot restart the embedder until the next `session_start`.
- If IPC disconnects or `process.connected` is false, the child exits promptly and cancels downloads and async loads. Synchronous native loading or inference can block the child's event loop. To cover that case, a JS-only watchdog thread inside the child checks every 100 ms that the parent is alive. If the parent dies, the watchdog kills only that child. The watchdog never loads ORT. If the watchdog fails to start, embeddings continue and a diagnostic is logged once per child. The disconnect check, the poll, and normal cleanup on host exit still work, but the child loses its protection against becoming an orphan while its loop is blocked. A normal host-exit hook also kills the child.
- A parent session resolves its repo and worktree DB paths once, at `session_start`. A `/bind` in the middle of a session does not move this storage consumer to the new target. To drain that queue, start a session in the bound worktree, or reload. Each active tick selects at most `8` texts in total and yields between DBs. The interval starts at `5` seconds, backs off exponentially to `5` minutes while idle, and resets on activity. An enqueue in the same process wakes the drainer. On idle ticks, read-only probes for work prevent writable opens, repair and checkpoints.
- One consumer owns each DB through an exclusive `<db>.embed-lock` lease. The lease holds the pid, the process start time, a timestamp and a random owner token. The holder refreshes the lease's mtime on every heartbeat tick, every five seconds. A lock older than two minutes is stale even if its pid is alive. A lock whose holder is dead can be reclaimed at once. Only the owner token can release a lease. `/doctor` reports the pid, age and staleness of a present lease. If another consumer holds the lease, the tick is skipped. A short immediate SQLite claim transaction serializes the reclaiming of stale files. This needs no schema change, and no SQLite lock is held during inference. Drain connections use a `250` ms busy timeout and immediate commit transactions. SQLite contention also skips the tick.
- A failed batch is retried one text at a time, to isolate bad texts. Worker exits and request timeouts stop these retries and refund infrastructure failures, so rows not yet attempted stay retryable. Rows are ordered by tries and then by enqueue time, and a row is dead after `5` failures. The output must contain one finite, `384`-dimensional vector per text. Results of inference that completed are kept even after the setup deadline passes. Results are discarded when shutdown aborts. Each inference request has a two-minute timeout. A timeout ends the unresponsive worker and marks it unavailable. Initial setup waits are capped at `10` seconds and do not cancel the shared initialization.
- Rejecting, archiving or forgetting memory, and deleting content, remove both queued and stored vectors. Bounded, idempotent maintenance repairs old missing native vectors and vectors with stale owners. Global recall is lexical only. Spider runs no inference for global queues, and removes up to `32` legacy rows once at session start.
- `embeddings.drain` defaults to `true`, independent of organism learning. Set it to `false` to turn off background maintenance. `/doctor` reports the switch, the worker state (`initializing` separately from `unavailable`), missing vectors, queued, retried and dead rows, the age of the oldest queue entry, and the current drain health. Background diagnostics go to log events instead of the console. When the drain is off, queue age is for information only. Dead letters are warnings, not permanent health failures. Indexing again or replacing the owner can retry them. Runtime history is not available in child sessions.
- If a fastembed model directory under spider's models root is broken, spider renames it to `<dir>.broken-<timestamp>` and does not delete it. If a sibling `<dir>.tar.gz` archive exists, spider renames it with the same suffix, so a retry can download a fresh copy. Recovery makes at most one rename attempt per process. It is skipped while any `<dir>.broken-*` entry exists, until the user clears it. Symlinks and paths outside that root are left alone.
- If a model directory already exists, fastembed does not download it again. Recovery can start on failures while that directory loads, or on recognized load errors after extraction. It does not start on errors with a string `code`, network errors or extraction errors. After a fresh download, spider leaves unrecognized errors alone rather than guess which stage failed. Recovery also skips a directory or entry changed within the last two minutes, because another process may be extracting it.
- Background fastembed setup turns off download progress output.
- Concurrent actions within a session share one child. A new session or a reload stops the old child. Later use loads from the existing model cache.
- If the child is unavailable, including after a synchronous or asynchronous spawn failure, spider caches the unavailable result for `10` minutes. Recall falls back to FTS, and the first call after the cooldown retries. Spider never signals a failed spawn that has no positive pid.
- A rejected initialization promise is cleared at once, so the next call can retry.
- The child adapter uses a v3 cache symbol, so after an upgrade it cannot reuse the older main-thread or worker-thread adapters.
- Bump the versioned symbol when the slot or adapter contract changes in an incompatible way. Both models can then stay in memory until the process exits. Restart for full cleanup.
- Killing the child frees its tokenizer and native model. Restart pi when you first move to the process adapter. Rebuilding or changing the cache symbol does not fix the worker-thread shutdown hook of an old bundle that is still running.

## Install-time native checks

- `postinstall` loads `better-sqlite3`, opens an in-memory database, and checks a `sqlite-vec` `vec0` table.
- Native failures print diagnostics to stderr but do not block installation. A completed install does not prove that the runtime is healthy. Run `/doctor`.
- Follow [Requirements](../../README.md#requirements) and the [native module ABI reference](data-model.md#native-module-abi) for source-build prerequisites and rebuilds.
- If SQLite fails to load, spider cannot use the database. A vector-extension failure is separate and can leave full-text search working.
- The script creates the global database file but leaves schema creation and migration to db-core.
- If `SPIDER_GLOBAL_ROOT` is unset or empty, spider uses `~/.pi/agent/spider`. An override must be absolute, which on Windows includes drive-qualified and UNC paths. Spider uses the override exactly as given.
- A relative override, including a Windows root-relative path, makes the install skip the bootstrap with a warning. At runtime, it stops spider from loading with `paths: SPIDER_GLOBAL_ROOT must be absolute; received "<value>"`.
- `CI=true` or a set `VITEST` skips the bootstrap. The native checks still run.
- Never point contributor fixtures at real user data. See [Contributing](../../CONTRIBUTING.md#validation).

## Fixture probes

- `node scripts/probe-reload.mjs` runs the real pi SDK and CLI loaders against fixture bundles.
- `node scripts/probe-build-watch.mjs` runs two Vite watch builds and checks for fresh build identities.
- Both probes use `.spider/scratch/build-id/` and a fixture agent directory, not the user's real extension directory. Both run in the test suite.
- The reload probe covers SDK aliases and the CLI `virtualModules`/`tryNative:false` loader configurations from the pi installed in the worktree.
- `node scripts/probe-child-survival.mjs` uses a fixture provider with real pi. It checks adoption, exactly one completion notice, and shutdown after reload.
- Set up the isolated environment described in [Contributing](../../CONTRIBUTING.md#validation) before you run the probes.

# Runtime lifecycle

## Build identity and doctor

- A bundle contains a `SPIDER_BUILD_ID=<sha>[-dirty]@<ISO timestamp> v<version>` header.
- Watch rebuilds capture a fresh timestamp. Dirty means tracked changes only; untracked local state does not affect it.
- Builds without git or their own checkout root use commit `unknown`. Unbundled source development reports unknown metadata.
- `/doctor` reports the identity loaded in this session, then reads the installed header at that same file location without importing or executing it again.
- Package version alone does not identify a build.

| Bundle status | Meaning or remedy |
| --- | --- |
| `current` | Loaded and installed build identities match. |
| `RELOAD NEEDED` | The bundle changed and the loaded URL has the generated shim's `?build=` query; use `/reload`. |
| `RESTART NEEDED` | Direct, old-shim, or fallback load has no query; restart pi. |
| Unreadable or marker unavailable | Doctor cannot verify the installed identity and does not claim it is current. |

- Child diagnostics say that the next dispatched child loads the new bundle.
- Without the query, doctor also suggests regenerating a linked shim with `npm run link`, followed by one restart.
- Bundle freshness is informational and does not itself fail the health check.
- Updating the file does not replace code already loaded in a session.

## Linked shims

- Stable installation and updates are in the [README](../../README.md#install-update-and-remove); watch-build linking is in [Contributing](../../CONTRIBUTING.md#setup).
- Do not load a linked shim and the package directly together: both activate spider, causing duplicate tool registration.
- Both shims point to a fixed checkout path. Moving the checkout requires relinking.
- The shim uses `runInThisContext` and `USE_MAIN_CONTEXT_DEFAULT_LOADER` for a native main-context import, bypassing jiti's dynamic-import rewrite.
- Its cache key is bundle mtime and size. A completed changed build loads fresh on `/reload`; an unchanged file reuses its module.
- The shim suppresses only the loader-specific `ExperimentalWarning` during synchronous compilation/import calls and restores warning handling before awaiting.
- If the VM loader constant is unavailable, compilation throws, or native import fails with an allowlisted loader/resolution code, the shim falls back to plain `import(bundle)`.
- Non-allowlisted native errors are rethrown without a retry. If fallback also fails, the message names both failures and an `AggregateError` retains both originals.
- Fallback loads require a restart after rebuilding. A plain dynamic import with a query is not reliable through pi's jiti loader.
- The allowlist identifies error codes, not the load phase. Keep bundle top level free of resource initialization or top-level awaits of optional modules.
- `npm run build` checks native import without activating the extension.

## Reload and shutdown cleanup

- Node retains previous rebuilt module instances until process exit. Restart after many rebuilt reloads or for complete process-level cleanup.
- Each activation owns its action closures; the global registry supplies externally registered actions it does not own.
- On shutdown, the activation releases its action closures, tool error marks, UI target, organism/routing references, and owned database handles without clearing another live activation's state.
- Organism shutdown work is awaited before cleanup.
- This is not cancellation of every in-flight action. Some action/UI handles lack explicit close paths.
- Eligible background children survive reload and are re-adopted. Chains stop; pending intercom calls stop; later pipeline stages do not resume.
- Quit, `/new`, `/resume`, and `/fork` stop session-owned children. See [Subagents](../guide/subagents.md#reload-survival-internals) for registry versions, buffers, adoption, and expiry.

## Process-wide embedder

- The embedder initializes lazily and occupies a versioned global-symbol slot keyed by model. Concurrent callers share one initialization.
- Recall, search and organism reflection use the embedder only if it is already ready. They never wait for first-time setup or a model download. Recall and search use full-text results while setup runs. Global and queryless recall do not start setup.
- All fastembed loading and inference, including recall/search query vectors, run in an inline `worker_threads` worker. The main thread exchanges texts and `Float32Array` results. There is no main-thread provider fallback. The worker is unreferenced and is terminated after organism shutdown reflection on session shutdown and `/reload`, including while initializing. Storage maintenance is fenced first. Once worker teardown begins, all embedder getters return null and cannot restart it until the next `session_start`.
- Parent sessions resolve their repo and worktree DB paths once at `session_start`. A mid-session `/bind` does not retarget this storage consumer; start a session in the bound worktree, or reload, to drain that queue. Every active tick selects at most `8` texts total, with a yield between DBs. The cadence starts at `5` seconds, backs off exponentially to `5` minutes when idle, and resets on activity. An in-process enqueue wakes the drainer. Read-only work probes prevent writable opens, repair and checkpoints on idle ticks.
- One consumer owns each DB through an exclusive `<db>.embed-lock` lease containing pid, process start time, timestamp and a random owner token. The holder refreshes its mtime every five-second heartbeat tick. Locks older than two minutes are stale even if their pid is alive; dead holders can be reclaimed immediately. Only the owner token can release a lease. `/doctor` reports a present lease's pid, age and staleness. Contention skips a tick. Stale-file reclamation is serialized by a short immediate SQLite claim transaction, with no schema change and no SQLite lock held during inference. Drain connections use a `250` ms busy timeout and immediate commit transactions; SQLite contention also skips the tick.
- Batches retry individually to isolate bad texts. Worker exits and request timeouts stop these retries and refund infrastructure failures, keeping unattempted rows retryable. Rows are ordered by tries and enqueue time and become dead after `5` failures. Outputs must contain one finite, `384`-dimensional vector per text. Completed inference is retained beyond the setup deadline; shutdown aborts discard results. Each inference request has a two-minute timeout that terminates an unresponsive worker and makes it unavailable. Initial setup waits are bounded at `10` seconds without cancelling shared initialization.
- Rejection, archival, forgetting and content deletion remove queued and stored vectors. Bounded, idempotent maintenance repairs old missing native vectors and stale owners. Global recall is lexical only: global queues are not inferred, and up to `32` legacy rows are removed once at session start.
- `embeddings.drain` defaults to `true`, independently of organism learning. Set it to `false` to disable background maintenance. `/doctor` reports the switch, worker state (`initializing` separately from `unavailable`), missing vectors, queued/retried/dead rows, oldest queue age and current drain health. Background diagnostics use log events instead of console output. Disabled drain queue age is informational. Dead letters are warnings, not permanent health failures; re-indexing or replacing the owner can retry them. Runtime history is unavailable in child sessions.
- A broken fastembed model directory under spider's models root is renamed to `<dir>.broken-<timestamp>`, not deleted. Its sibling `<dir>.tar.gz` archive, if present, is also renamed with the same suffix so retries can download afresh. Recovery is limited to one rename attempt per process and skipped if any `<dir>.broken-*` entry already exists, until the user clears it. Symlinks and paths outside that root are left alone.
- Existing model directories skip fastembed retrieval. Failures during their loading, or recognized load errors after extraction, can trigger recovery. Errors with a string `code`, network and extraction errors do not. Unrecognized errors after a fresh download are left alone rather than guessing the failure stage. Recovery also skips a directory or entry modified within the last two minutes because another process may be extracting it.
- Background fastembed setup disables download progress output.
- Concurrent actions within a session share one worker. New sessions and reloads stop the old worker; later use loads from the existing model cache.
- If the worker is unavailable, the unavailable result is cached for `10` minutes; the next call after the cooldown retries.
- Rejected initialization promises clear immediately so the next call can retry.
- The worker adapter uses a v2 cache symbol so it cannot reuse the former main-thread adapter after an upgrade.
- Bump the versioned symbol for incompatible slot/adapter contracts. This can retain both models until exit; restart for complete cleanup.
- Terminating the worker releases its tokenizer and native model. Older main-thread adapters loaded before upgrading can remain until process exit.

## Install-time native checks

- `postinstall` loads `better-sqlite3`, opens an in-memory database, and checks a `sqlite-vec` `vec0` table.
- Native failures print diagnostics to stderr but do not block installation. An install completing does not prove runtime health; run `/doctor`.
- Follow [Requirements](../../README.md#requirements) and the [native module ABI reference](data-model.md#native-module-abi) for source-build prerequisites and rebuilds.
- A SQLite load failure prevents database use; vector-extension failure is separate and can leave full-text search available.
- The script bootstraps the global database file but leaves schema creation/migration to db-core.
- An unset or empty `SPIDER_GLOBAL_ROOT` uses `~/.pi/agent/spider`. The override must be absolute, including drive-qualified or UNC paths on Windows, and is used as supplied.
- Relative overrides, including Windows root-relative paths, skip bootstrap with a warning at install time. At runtime, they stop spider from loading with `paths: SPIDER_GLOBAL_ROOT must be absolute; received "<value>"`.
- `CI=true` or a set `VITEST` skips bootstrap; native checks still run.
- Never point contributor fixtures at real user data. See [Contributing](../../CONTRIBUTING.md#validation).

## Fixture probes

- `node scripts/probe-reload.mjs`: exercise real pi SDK and CLI loaders with fixture bundles.
- `node scripts/probe-build-watch.mjs`: exercise two Vite watch builds and fresh build identities.
- Both use `.spider/scratch/build-id/` and a fixture agent directory, not the user's real extension directory, and run in the test suite.
- Reload coverage includes SDK aliases and CLI `virtualModules`/`tryNative:false` loader configurations from worktree-local pi.
- `node scripts/probe-child-survival.mjs`: check real-pi adoption, exactly one completion notice, and shutdown after reload with a fixture provider.
- Apply the isolated environment described in [Contributing](../../CONTRIBUTING.md#validation) before running probes.

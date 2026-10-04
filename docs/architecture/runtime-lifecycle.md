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

- The embedder initializes lazily and occupies a versioned global-symbol slot keyed by model.
- `/new`, `/resume`, `/fork`, and rebuilt reloads reuse the same model.
- If both providers are unavailable, the unavailable result is cached for `10` minutes; the next call after the cooldown retries.
- Rejected initialization promises clear immediately so the next call can retry.
- The slot retains the adapter from the bundle that first initialized it. Once loaded, changes to `packages/memory/src/embeddings/embedder.ts` require a pi restart even with a development shim.
- Bump the versioned symbol for incompatible slot/adapter contracts. This can retain both models until exit; restart for complete cleanup.
- Fastembed has no public model disposer; the shared model is intentionally retained until process exit.

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

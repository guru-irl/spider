# Contributing

## Setup

- Follow the [requirements](README.md#requirements) and the [clone, build, and link steps](README.md#install-update-and-remove). For a PR, clone from your fork's URL instead.
- For watch builds, use the development link:

```bash
npm run dev:link
npm run dev
```

- The development shim is `~/.pi/agent/extensions/spider-dev.ts`. It loads the same bundle as the stable shim and removes the stable shim. To remove the development shim, run `npm run dev:unlink`.
- See [Linked shims](docs/architecture/runtime-lifecycle.md#linked-shims) for loading precautions, how to move a checkout, and how reload behaves.

## Validation

- You can put temporary files, logs, and the npm cache under `.spider/scratch/`. You do not need to export `TMPDIR`, `npm_config_cache`, or `npm_config_logs_dir`. Vitest sets up its own fixture roots inside the checkout.
- Before you run tests or probes, unset the child identity and database variables that your shell may have inherited:

```bash
env -u PI_SUBAGENT_CHILD -u PI_SUBAGENT_RUN_ID \
  -u PI_SPIDER_DB_PATH -u PI_SPIDER_SESSION_ID \
  npm test -- packages/host/src/__tests__/config-reader-guard.test.ts
```

- Run targeted tests while you work, then run the full gate:

```bash
npm run check:lockfile
npm run typecheck
env -u PI_SUBAGENT_CHILD -u PI_SUBAGENT_RUN_ID \
  -u PI_SPIDER_DB_PATH -u PI_SPIDER_SESSION_ID npm test
npm run build
```

- `vitest.setup.ts` also clears all nine child identity variables before each test file, including the four that the commands above unset. Tests that need child mode set it themselves.
- Setup sets `SPIDER_GLOBAL_ROOT`, `PI_CODING_AGENT_DIR`, and `SPIDER_TEST_FIXTURE_CHECKOUT` to fixture-only values. Do not point them at real user data.
- Fixtures create databases and config in the checkout's scratch directory. Close handles and stop fixture processes in teardown.
- Vitest uses fork workers to keep native SQLite safe. `npm run test:watch` runs watch mode.
- `npm run build` builds the extension, then the dashboard, then runs `scripts/assert-bundle.mjs`. The output is `dist/extension.js`, plus `dist/dashboard/index.html` and hashed JavaScript and CSS files in `dist/dashboard/assets/`. The guard checks the layout and the dashboard size, and checks that the dashboard loads its scripts and styles only from external files. It also checks for a valid build marker, for native and pi modules left external, and for a default function that can be imported natively. Source maps and the development states page are not packaged.
- `npm run bundle` builds only the extension. `npm run dev` watches only the extension, so rebuild after dashboard edits with `npm run build:dashboard`. `npm run dev:dashboard` starts the browser development server with synthetic fixture APIs. Development and e2e dashboard builds need an explicit absolute output directory under `.spider/scratch/`. Production dashboard builds can write only to `dist/dashboard/`.
- `npm run test:e2e` runs the installed browser headless: Edge locally, Chrome in CI. `SPIDER_PLAYWRIGHT_CHANNEL` overrides the channel, and `SPIDER_PLAYWRIGHT_PORT` overrides the fixture server port. You do not need to download a browser.
- `SPIDER_PLAYWRIGHT_WORDMARK_FONT` is optional. Set it to the absolute path of a local Bebas Neue WOFF2 file. The wordmark test then serves that file to the browser without a network request and checks that its ink lines up with the web glyph. The repository stores no font binary. Without the variable, the test uses an installed face if there is one, or else the system fallback. CI runs the fallback-face check with external requests blocked. A separate platform-font check confirms, offline, that regular and bold resolve to the same usable family.
- Code at the bundle's top level must not open a database or start optional model setup.
- For changes to interactive rendering, follow [UI testing](docs/dev-ui-testing.md) and the [Output guidelines](docs/output-ui-guidelines.md).

### CI shards and timing data

Build and test jobs use Node `26.x`. PR CI is a fast, scoped signal, not the
complete merge gate. Two test runners with three fork workers each start beside
one typecheck/build runner. A short, install-free aggregate keeps the required
name `typecheck · test · build`. It rejects failed, cancelled, or unexpectedly
skipped jobs and requires both test runners to use identical manifests.

Only `ci.yml` runs automatically on PRs. PR runs never start the twelve-shard
matrix, Chrome, Herdr confidence utilities, packed acceptance, or headless
stories. Selector probes, historical replays, and measurement cohorts also stay
off the PR critical path.

Before **every merge**, dispatch the full CI workflow on the PR head branch:

```bash
gh workflow run ci.yml --ref <head-branch> -f force_full=true
```

Wait for that run's `typecheck · test · build` check to pass on the exact PR head
commit. Repeat the full run if the head changes. Merge tooling requires this
successful `ci.yml` dispatch on the exact head, not just a successful PR check.
It covers every deferred test, twelve complete test shards, all Chrome
partitions, Herdr confidence utilities, packed acceptance, and the default
headless story set.

Pushes to `main` and reusable CI calls also take the full route. Non-PR CI
dispatches remain full even when `force_full` is false. The root suite keeps
twelve shards with two workers each. `npm ci` builds each checkout through
`prepare`; new root tests join the full inventory automatically.

Full CI calls `herdr-stories.yml` as a reusable workflow and requires its result
in the aggregate. That workflow no longer has a PR trigger. Its standalone
manual trigger still supports selected stories and a shorter deadline.

`scripts/select-tests.mjs` compares the merge base with the tested checkout SHA.
Vitest resolves import dependencies, including build entries used as virtual
specifications. `scripts/test-resources.json` adds filesystem readers, bundle
consumers, source inventories, and optional-suite inputs. Unknown paths,
deletes, missing bases, and graph errors make the whole inventory a candidate
set. PRs still cut that set to the budget; they never hand off to the full
matrix. Selection never collects test modules or starts test workers.

The PR scheduling budget is 65 seconds per runner, leaving setup and aggregate
headroom inside the two-minute target. It uses recorded file durations plus a
700 ms per-file import allowance from CI observations. Tests fill that budget
in this order:

1. Changed test files and tests that directly import a changed file with a static import.
2. Tests beside changed production source, including its `__tests__` directory.
3. Other selected importers and resource consumers.

Type-only imports count as direct imports. Dynamic and transitive imports do
not. Paths break ties within each priority. A file that cannot fit waits for
the full run, and smaller later files can use the space left. Every deferred
file appears in each runner's step summary. Chrome and acceptance selection
outputs are summary notes, not PR suite triggers.

Each manifest records sorted test paths, selection reasons, base/tested SHAs,
and hashes of the selector, resource policy, inventory, and timing table.
Its `budget` records the limit, import allowance, worker loads, and candidate
mode. Its `deferred` list records each deferred file, duration estimate, deferral
rule, and original selection reasons. Deferred entries are covered by the
manifest checksum but are not passed to the scoped test runner.
`scripts/run-selected-tests.mjs` validates it and passes the exact file list to
Vitest without a second changed-file filter. Empty partitions skip explicitly.

`scripts/vitest-sequencer.ts` assigns the selected files by longest processing
time first, using `scripts/test-durations.json`. Ties use repository-relative
paths. New files get the median recorded duration. To inspect a saved selection:

```bash
node scripts/list-test-shards.mjs 1/2 --manifest selection.json
node scripts/test-shard-budget.mjs --manifest selection.json
```

The budget reports aggregate measured file time and a six-worker scheduling
estimate that includes the manifest's import allowance. Installation, selection,
and process startup are additional. Vitest's reported import and test totals
sum worker time; neither is wall time. Fork isolation stays enabled because
tests use native SQLite, module mocks, and process-global state.

The unbudgeted selector and `scripts/measure-test-selection.mjs` remain available
for separate selector investigations. They do not add work to PR CI.

To refresh durations, download the `test-results-*` artifacts from a completed
CI run:

```bash
gh run download RUN_ID --pattern 'test-results-*' --dir .spider/scratch/ci-reports
node scripts/update-test-durations.mjs .spider/scratch/ci-reports/test-results-*/shard-*.json
```

The script includes hooks through file start/end timestamps. It replaces each
observed weight with the largest supplied observation and retains unobserved
entries, so a scoped report cannot erase the history. Prefer complete runs from
one revision when refreshing the checked-in table. To list the full inventory's
main shard, use `node scripts/list-test-shards.mjs 1/12`.

For selector safety evidence, `scripts/replay-test-selection.mjs --collect`
downloads red PR logs and reports without resolving any graphs. Its replay mode
runs only on GitHub Actions, in isolated historical checkouts at the tested merge
SHAs. Missing evidence is inconclusive, not successful recall.

### Selection map

The `selection map` workflow runs on pushes to `main` and on manual dispatch.
It records the root Vitest suite in six shards and maps loaded bundle code back
to repository sources. Test failures appear in the run summary. Missing test
records or recorder errors prevent publication. The workflow does not change
PR checks or the full CI run on `main`.

Download `selection-map.json` from the run's `selection-map` artifact. GitHub
keeps the artifact for 30 days. The file names the commit and run that produced
it. Each test file has a duration, a result, and indices into the source file
list in `files`.

## Package map and dependency rules

| Package | Responsibility |
| --- | --- |
| [`@spider/db-core`](packages/db-core/README.md) | Database tiers, paths, migrations, events, thinking policy. |
| [`@spider/models`](packages/models/README.md) | Model catalog, selection, and completion. |
| [`@spider/ui`](packages/ui/README.md) | Themed renderers, screens, and TUI components. |
| [`@spider/memory`](packages/memory/README.md) | Memory review storage, snapshots, scanning, embeddings. |
| [`@spider/todo`](packages/todo/README.md) | Session todos and the todo overlay. |
| [`@spider/context`](packages/context/README.md) | Search, execution, indexing, fetch, transcript import. |
| [`@spider/subagents`](packages/subagents/README.md) | Dispatch, process lifecycle, RPC, and messaging. |
| [`@spider/organism`](packages/organism/README.md) | Background passes, skill review, curation, insights. |
| [`@spider/superpowers`](packages/superpowers/README.md) | Bundled skills, managed instructions, upstream watch. |
| [`@spider/pstack`](packages/pstack/README.md) | Bundled pstack skills. |
| [`@spider/host`](packages/host/README.md) | Tool schema, action wiring, slash commands, hooks. |

- Package dependencies form a DAG (a graph with no cycles): `host -> subagents -> db-core`, and `host -> ui`. The host also brings in the other feature packages.
- UI refers to database and model types only, and never imports db-core at runtime. Keep persistence and model calls out of UI components.
- Memory must not import models or host. The host passes in completion callbacks.
- Import pi packages from their public roots, not from internal deep paths.
- Keep native modules and the pi dependencies that the host provides out of the single bundle.
- See the [Architecture overview](docs/architecture/README.md) for how the packages interact.

## Lockfile and local state

- Registry tarballs in `package-lock.json` must use HTTPS `registry.npmjs.org` URLs with no credentials, and must have SHA-512 integrity. Workspace links are allowed.
- Run `npm run check:lockfile` before you submit. The check runs offline.
- If you installed through a mirror, run `npm run check:lockfile -- --fix`. It rewrites mirror URLs that use the `/npm/registry/` path layout. To upgrade a SHA-1 entry, it downloads and verifies the tarball before it records SHA-512.
- Mirror URLs with any other layout need a manual fix. Do not commit private registry URLs or credentials.
- The guard also checks tracked `.npmrc` files against its allowlist.
- Never commit `.spider/` databases, scratch files, logs, local config, or `.pi-subagents/` files. Read your diff and stage only the files you mean to commit.

## Pull requests

- File bugs and feature requests in [GitHub issues](https://github.com/guru-irl/spider/issues). Include steps to reproduce and the relevant versions.
- Fork the repository, clone your fork, and create a feature branch. Push the branch to your fork and open a PR against this repository.
- Write commit subjects as `type(scope): subject` or `type: subject`, for example `fix(subagents): handle cancellation` or `ci: update checks`.
- Target `main`. Keep each change focused, and explain any change in behavior and how you verified it.
- Add regression tests for code fixes, and update the documentation for changes users can see.
- The required CI check is `typecheck · test · build`, and the branch must be up to date with `main`.
- PRs from contributors need one approving review from the maintainer.
- A new push dismisses earlier approvals. Resolve all review conversations before merging.
- History is linear, so merge only by squash or rebase.
- See [Release process](docs/release-process.md) for tagged builds and publishing. Routine PRs do not need it.

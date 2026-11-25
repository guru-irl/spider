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

CI uses Node `26.x`. PRs have two test jobs with three fork workers each,
followed by one typecheck/build job. The last job keeps the required name
`typecheck · test · build` and fails if either shard fails. Conditional Chrome
and packed Herdr acceptance steps share that runner. Headless stories have
separate path-filtered jobs.

PR selection is enabled by default. Both PR jobs compute the same manifest and
execute only scoped selections. A full fallback skips their test execution and
runs the existing twelve-shard suite instead. Both selector jobs must produce
identical selection hashes. The protected aggregate accepts either successful
path and rejects failed or cancelled selected jobs.

Main still runs all root tests on twelve shards with two workers each, plus
separate Chrome and Herdr acceptance jobs. `npm ci` builds each checkout through
`prepare`. There is no separate fast-test roster: new root tests join by default.

`scripts/select-tests.mjs` compares the merge base with the tested checkout SHA.
Vitest resolves import dependencies, including build entries used as virtual
specifications. `scripts/test-resources.json` adds filesystem readers, bundle
consumers, source inventories, and optional-suite inputs. Unknown paths,
deletes, missing bases, and graph errors select the full inventory. Selection
never collects test modules or starts test workers.

Each manifest records sorted test paths, selection reasons, base/tested SHAs,
and hashes of the selector, resource policy, inventory, and timing table.
`scripts/run-selected-tests.mjs` validates it and passes the exact file list to
Vitest without a second changed-file filter. Empty partitions skip explicitly.

`scripts/vitest-sequencer.ts` assigns the selected files by longest processing
time first, using `scripts/test-durations.json`. Ties use repository-relative
paths. New files get the median recorded duration. To inspect a saved selection:

```bash
node scripts/list-test-shards.mjs 1/2 --manifest selection.json
node scripts/test-shard-budget.mjs --manifest selection.json
```

The budget reports aggregate file time and a six-worker scheduling estimate,
including a separate estimate without measured files over five seconds. It does
not include installation, selection, or process startup.

On selection-policy changes, a successful test shard also runs a measurement-only
cohort through `scripts/measure-test-selection.mjs`. It omits files with recorded
weights over five seconds and retains unmeasured files. The `test-measurement-*`
artifacts record the cohort, excluded files, status, and elapsed time. This warm
follow-up run never replaces the required test manifest. Failed measurements are
not timing samples.

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

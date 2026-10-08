# Contributing

## Setup

- Follow the [requirements](README.md#requirements) and [clone, build, and link steps](README.md#install-update-and-remove). For a PR, use your fork's clone URL.
- For watch builds, use the development link instead:

```bash
npm run dev:link
npm run dev
```

- The development shim is `~/.pi/agent/extensions/spider-dev.ts`; it targets the same bundle and removes the stable shim. Remove it with `npm run dev:unlink`.
- See [Linked shims](docs/architecture/runtime-lifecycle.md#linked-shims) for loading precautions, moving a checkout, and reload behavior.

## Validation

- Optionally put temporary files, logs, and npm cache under `.spider/scratch/`; no `TMPDIR`, `npm_config_cache`, or `npm_config_logs_dir` exports are required. Vitest sets up its own checkout-local fixture roots.
- Unset inherited child identity and database variables before tests or probes:

```bash
env -u PI_SUBAGENT_CHILD -u PI_SUBAGENT_RUN_ID \
  -u PI_SPIDER_DB_PATH -u PI_SPIDER_SESSION_ID \
  npm test -- packages/host/src/__tests__/config-reader-guard.test.ts
```

- Run targeted tests while working, then run the full gate:

```bash
npm run check:lockfile
npm run typecheck
env -u PI_SUBAGENT_CHILD -u PI_SUBAGENT_RUN_ID \
  -u PI_SPIDER_DB_PATH -u PI_SPIDER_SESSION_ID npm test
npm run build
```

- `vitest.setup.ts` also clears all nine child identity variables before each test file, including the four unset above. Tests that require child mode set it explicitly.
- Setup assigns fixture-only `SPIDER_GLOBAL_ROOT`, `PI_CODING_AGENT_DIR`, and `SPIDER_TEST_FIXTURE_CHECKOUT`. Do not override them to real user data.
- Fixtures create databases and config under checkout scratch; close handles and terminate fixture processes in teardown.
- Vitest uses fork workers for native SQLite safety. `npm run test:watch` runs watch mode.
- `npm run build` builds the extension first, builds the dashboard second, then runs `scripts/assert-bundle.mjs`. The output is `dist/extension.js` plus `dist/dashboard/index.html` and hashed JavaScript and CSS files in `dist/dashboard/assets/`. The guard checks that layout, the dashboard size and external-only scripts and styles, a valid build marker, external native and pi modules, and a natively importable default function. Source maps and the development states page are not packaged.
- `npm run bundle` builds only the extension. `npm run dev` watches only the extension, so rebuild dashboard edits with `npm run build:dashboard`. Use `npm run dev:dashboard` for the browser development server with synthetic fixture APIs. Development and e2e dashboard builds require an explicit absolute output directory under `.spider/scratch/`; production dashboard builds can write only to `dist/dashboard/`.
- No database opens or optional model initialization belongs at bundle top level.
- For interactive rendering changes, follow [UI testing](docs/dev-ui-testing.md) and [Output guidelines](docs/output-ui-guidelines.md).

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
| [`@spider/host`](packages/host/README.md) | Tool schema, action wiring, slash commands, hooks. |

- Dependencies form a DAG: `host -> subagents -> db-core`, and `host -> ui`; the host also composes the other feature packages.
- UI uses type-only database/model references, with no runtime import of db-core. Keep persistence and model calls outside UI components.
- Memory must not import models or host. Inject completion callbacks from the host.
- Import pi packages from their public roots, not internal deep paths.
- Keep native modules and host-provided pi dependencies external to the single bundle.
- See the [Architecture overview](docs/architecture/README.md) for package interactions.

## Lockfile and local state

- Registry tarballs in `package-lock.json` must use HTTPS `registry.npmjs.org` URLs without credentials and include SHA-512 integrity. Workspace links are permitted.
- Run `npm run check:lockfile` before submitting; the check is offline.
- After installing through a mirror, use `npm run check:lockfile -- --fix`. Mirror URLs that use the `/npm/registry/` path layout are rewritten; SHA-1 upgrades download and verify the tarball before recording SHA-512.
- Other mirror URL layouts need a manual correction. Do not commit private registry URLs or credentials.
- The guard also checks tracked `.npmrc` files against its allowlist.
- Never commit `.spider/` databases, scratch, logs, local config, or `.pi-subagents/` artifacts. Inspect your diff and stage only intended files.

## Pull requests

- File bugs and feature requests in [GitHub issues](https://github.com/guru-irl/spider/issues); include reproduction steps and relevant versions.
- Fork the repository, clone your fork, create a feature branch, push it to your fork, and open a PR against this repository.
- Use commit subjects such as `type(scope): subject` or `type: subject`, for example `fix(subagents): handle cancellation` or `ci: update checks`.
- Target `main`; keep changes focused and explain behavior changes and verification.
- Add regression tests for code fixes and update documentation for user-facing changes.
- The required CI check is `typecheck · test · build`; the branch must be up to date with `main`.
- Contributor PRs need one approving review from the maintainer.
- New pushes dismiss earlier approval; resolve all review conversations before merging.
- History is linear: use squash or rebase merges only.
- See [Release process](docs/release-process.md) for tagged builds and publishing, not routine PR submission.

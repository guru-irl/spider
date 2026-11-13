# Herdr user-driven acceptance

Run from the repository root. No dependency installation is needed beyond the existing checkout dependencies.

| Command | Coverage |
| --- | --- |
| `npm run test:herdr:e2e` | Packed extension, real pi, owned local hc cores, strict fake app boundary. No native window or real SSH. |
| `npm run test:herdr:e2e:ci` | Explicit no-hc, no-app, no-SSH subset. Active-core and native stories are **not exercised**. |
| `npm run typecheck:herdr:e2e` | Acceptance TypeScript, including fixtures and configuration, with repo strictness and isolated declarations. Runs in both CI workflows. |
| `SPIDER_HERDR_REAL_MACHINE=<explicit-alias> npm run test:herdr:e2e:remote` | Opted-in Linux destination with owned namespaces and independent cleanup. |
| `SPIDER_HERDR_APP_TESTS=1 SPIDER_HERDR_TEST_DISPLAY_UUID=<chosen-display> npm run test:herdr:e2e:app` | User-approved native slot; one fenced window for the serial batch. Missing native interaction capabilities are **blocked**. |

The runner builds once, packs once, and supplies `SPIDER_HERDR_E2E_PACKED_ROOT` to `createSuite`. The foundation validates containment and required entries before reusing that root. It packs independently only when no runner root is supplied. `--built` uses the existing build, for CI immediately after its build step; packed-entry digests still must match.

## Scenario contract

Every story file in `scenarios/` exports **exactly one named array**:

```typescript
import { storyId, type ScenarioDefinition } from '../harness/scenario.js';

export const scenarios: readonly ScenarioDefinition[] = [
  { id: storyId('S52'), title: 'Installed look', tiers: ['headless', 'app'],
    async run(suite) { /* assert actual owned observations */ } },
];
```

Use `StoryId` as required by the foundation's type declarations. `scenario` and default exports are rejected, even if a `scenarios` export is also present. Files reserved for runner contract tests are excluded from discovery. Helpers belong outside `scenarios/`. Story files define stories; the central test invokes them and closes their suites. The foundation's optional `registerScenarios(scenarios)` helper is suppressed only during central discovery to prevent duplicate execution. Unrelated standalone Vitest registrations in story files are not supported. The central runner passes each definition's `script` into `createSuite`.

Selection is dynamic by tier and ID. `--story S52,S54` and `--task setup|remote|subagents|lifecycle|panels|ssh|runner|roam` select stories; a missing requested ID, duplicate ID, wrong-tier selection, or malformed export fails. `--shuffle --seed fixture` changes execution order reproducibly. `--harness` also runs foundation, native utility, confidence, and `fixtures/**/*.test.ts` tests. Configuration fails with the filename if a harness test falls outside those include patterns.

R01 exercises sync through the packed CLI and two isolated cores in the headless tier. R02 exercises the placement adapter directly with synthetic readiness and a closed app in the app tier. It does not cover the packaged observer-to-placement path, which is deferred to Task 3.4. Both stories run serially and are not exercised in CI.

## Results

Each invocation has a fresh root under `.spider/scratch/e2/`. Story receipts link the actual `suite.evidenceDirectory` (`e2/_evidence/<story>/<ledger-id>/`), `suite.cleanupProofPath` (`e2/_ledgers/<ledger-id>.cleanup.json`) and ledger path. Installed pi path/version and hc/core/app resolution are retained separately from product output. Pi resolution prefers the Node sibling, then the checkout dependency. hc, core, and app resolution uses `os.userInfo().homedir`. Product subprocesses retain fenced HOME and XDG paths.

The runner registers its worker process group in its own durable ledger and starts an out-of-group watchdog before any build or test. Before starting, and after finishing, it runs the independent entry point `node packages/herdr/e2e/harness/resources.ts reconcile .spider/scratch/e2/_ledgers`. A selected failure matrix is written before tests start, so SIGKILL cannot leave an apparently green report. `cleanup <ledger.json>` also works without Vitest or the runner. A `cleanup-failed` ledger retries the same guarded cleanup before verification.

`--tier ci --story S55` kills real runner instances with TERM and KILL while they own a detached daemon and socket; the headless variant also owns two isolated cores and destination terminal processes. It kills both watchdogs in a further case and proves the next real runner reconciles their durable ledgers. It also proves independent retry collects a survivor from a failed ledger and records unchanged default-socket identity without a default-core CLI call. `--cleanup-control daemon|destination` is a fixture-only hold mode restricted to exactly S55 in ci/headless; use the ordinary S55 story to run and collect it.

Each invocation root contains `invocation.json`, entry digests, build/pack/test logs, per-story JSON, and `matrix.md`/`matrix.json`. The matrix lists S01-S56 and R01-R02 and distinguishes **passed**, **failed**, **blocked**, and **not exercised**. An R02 pass includes its adapter-only coverage limit. Missing selected results fail closed. A cleanup failure overrides any earlier story success. A blocked prerequisite never produces a complete-suite pass. Successful duration includes teardown. Failed runs are not timing samples. IDs that match `H-[a-z0-9-]+` select harness stories, which have a separate matrix section and never count toward the 56 product stories.

S56 in CI repeats the actual runtime probe, mod-helper import, and runtime exit/receipt/stream assertions against the public package. Each pristine artifact must pass before its bad copy can count as caught. The headless controls reuse the actual S29, S22, and S34 definitions. A failed baseline, unrelated assertion, missing definition, or unproved cleanup does not count as a caught control. The CI artifact subset does not certify those active-core controls.

Tier 1 UI claims cover only the strict app boundary or real installed-mod render host. They do not certify GPUI rendering, control bounds, notification display, or native Cmd-key translation. On app 0.1.11, `uiSnapshot`, `activate`, and `keyToOwnedWindow` require a missing fenced rendered-UI/input hook and must fail before any input is posted. Screenshots and headless checks cannot substitute for that hook.

Never use a default core, live app home, existing user session, system SSH transport, or inherited credentials. Every process launch and cleanup goes through the independent foundation supervisor. Known-bad controls operate only on disposable packed-artifact copies under scratch, never in a writer checkout. CI installs neither hc nor an app and uploads only its own synthetic failure artifacts.

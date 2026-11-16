# Herdr user-driven acceptance

Run headless stories on GitHub Actions, not on a developer Mac. The commands below run from the repository root and use the checkout dependencies.

| Command | Coverage |
| --- | --- |
| `npm run test:herdr:e2e` | Linux workflow: packed extension, real pi, owned local hc cores, strict fake app boundary. No native window or real SSH. |
| `npm run test:herdr:e2e:ci` | Explicit no-hc, no-app, no-SSH subset. Active-core and native stories are **not exercised**. |
| `npm run typecheck:herdr:e2e` | Acceptance TypeScript, including fixtures and configuration, with repo strictness and isolated declarations. Runs in both CI workflows. |
| `SPIDER_HERDR_REAL_MACHINE=<explicit-alias> npm run test:herdr:e2e:remote` | Opted-in Linux destination with owned namespaces and independent cleanup. |
| `SPIDER_HERDR_APP_TESTS=1 SPIDER_HERDR_TEST_DISPLAY_UUID=<chosen-display> SPIDER_HERDR_E2E_APP=<owned-clone-executable> npm run test:herdr:e2e:app` | An owned native copy for each serial story. Missing ownership or interaction capabilities are **blocked**. |

The runner builds once, packs once, and supplies `SPIDER_HERDR_E2E_PACKED_ROOT` to `createSuite`. The foundation validates containment and required entries before reusing that root. It packs independently only when no runner root is supplied. `--built` uses the existing build, for CI immediately after its build step; packed-entry digests still must match.

## Run a headless story on GitHub Actions

The `Herdr headless stories` workflow runs on pull requests and accepts a `stories` input for manual runs. Once the workflow is on the default branch, use the Actions page or run:

```sh
gh workflow run herdr-stories.yml --ref <branch> -f stories=R03
```

Separate multiple story IDs with commas. Leave `stories` empty to run the default set in `controls/ci-stories.json`. A preparation job installs dependencies and builds once, verifies the pinned Linux core, and shares the build with one job per selected story. The jobs run in parallel and report independently. The harness requires an owned `hc` executable rather than a symbolic link. On failure, download the `herdr-headless-failures-<story>` artifact and extract `e2.tar.gz`.

The preparation job has a five-minute limit. Each measured limit uses an initial successful job time plus 40 seconds, rounded up to a minute; unmeasured jobs retain the five-minute limit. R05's story step has a one-minute limit to leave time to archive failures. The job limits are in `controls/ci-stories.json`. The workflow exercises the packed extension and real, isolated local cores without a display. It does not certify the native app, native windows, SSH, or real remote machines. R02 covers app placement with a fixture owner and is outside the default set. R14local needs separately supplied local fixtures.

## Run an isolated native copy

Use only an executable prepared by `prepareNativeApp` in the current checkout. The helper records a ledger-owned APFS bundle clone, source digests, a distinct bundle identity, an owned app home, and a copied core pinned in `settings.json`. It disables native automatic sounds. The app tier refuses original application bundles, pending updates, launcher links, changed copies, and missing ownership. It never falls back to the live app.

The production release test copies release fixtures into each owned app home. It tests the setup recipe, not whether the bundle's shipped built-ins match the fixtures. The backdrop and ScreenCaptureKit experiment runs only with `SPIDER_HERDR_BLUR_CAPTURE=1` and needs Screen Recording permission.

The native isolation smoke prepares and checks both target releases without changing the source bundles. Use a pinned compatible `hc` and its sibling `herdr-core` under the checkout's owned temporary files:

```sh
SPIDER_HERDR_NATIVE_ISOLATION_SMOKE=1 \
SPIDER_HERDR_E2E_HC="$PINNED_HC" \
npx vitest run --config packages/herdr/e2e/vitest.config.ts \
  packages/herdr/e2e/harness/__tests__/native-launch.test.ts \
  -t 'isolates native launch and window observations' --maxWorkers=2
```

Each smoke root retains `native-ownership.json`, native command replies, `launch.json`, `status.json`, a check result, and `window.png`. The check result lists clipboard API names without invoking clipboard readers or writers. The ledger retains its cleanup proof. A verified copy from a closed, clean ledger can be reused as a read-only source. Set `SPIDER_HERDR_E2E_APP` to its `binary` field. The runner clones that source again into each new suite. A closed ledger cannot authorize commands or a launch against its own executable.

Launch Services receives `open -g -n` with explicit environment arguments, including the owned home, socket and core namespace, an unreachable releases URL, disabled telemetry, and the distinct app ID. The adapter requires the frontmost application's bundle identity to remain unchanged. It never restores focus after a failed isolation check. Native screenshots use only the copied app's window.

The command adapter sends the same dotted commands that the installed mod handlers receive. It allows `mod.open` for the installed picker or panel, owned-target `pane.focus`, `spider-pane.park`, the three `spider-agents.sort-*` commands, encoded console-group and session activation commands, and `spider-panel.refresh`. Register fixture-only pane, group, and session IDs through `suite.registerNativeTarget`. Mod-private arguments must be empty. Encoded targets must be canonical. Arbitrary terminal input and eval are rejected. Read the native command list with `command('commands', {})`, which invokes the `commands` subcommand, not `do commands`.

Headless checks use a copied, ad-hoc-signed command-only executable with a copied compatible core. They never execute the installed launcher or open a native window. The strict render host exposes explicit `playSound` calls for assertions, without claiming audible output.

These checks prove launch isolation and command transport. They do not certify Spaces rendering, primary-session reopening, physical keys, hover, or clicks. The native Spaces stories remain a separate acceptance gate.

## Cross-machine panes: B01–B08

Run these stories only in the Linux stories workflow, with its pinned core and packed build. They run serially against independently owned cores connected by synthetic transport. The app boundary owns placement only; targets, proxies, source pi sessions, viewers and consoles are real packed processes. They are excluded from the no-core `ci` and real-machine `remote` profiles.

```sh
npm run test:herdr:e2e -- --built --tier headless \
  --story B01,B02,B03,B04,B05,B06,B07,B08
```

`--task panes` selects the same eight stories. Each result retains its duration, packed CLI and endpoint digests, source identity, placement state, process observations and independent cleanup proof. A successful headless result explicitly excludes native input, SSH and continuous pixels. Fixture unit tests do not count as story results.

| Story | Packed headless assertions | Not certified by that result |
| --- | --- | --- |
| B01 | Captured tab, split and Go-to intents; picker event handlers, preferred and disabled machines; single-use menu ticket; agent creation. | Physical shortcuts, pointer hit targets and rendered picker geometry. |
| B02 | Remote home and focused remote cwd; UTF-8 input, multiline output, history attach, initial geometry and target-derived header. | Native clipboard, selection, interactive resize and actual paste events. |
| B03 | Cancelled and confirmed proxy close; Send back and same-program reopen; target survival after tab, space or proxy exit. | Native local pi close and confirmation interaction. |
| B04 | Stream loss, discarded input, reconnect to the same process, alternate-screen recovery, bounded probes and alias reuse with a same-ID decoy terminal. | Mouse and bracketed-paste mode bytes; native key translation. CPU is recorded, not certified as a performance result. |
| B05 | Named source discovery, unplaced and live non-terminal rows, installed move and drag handlers, saved choices and helper restart. | Physical drag delivery. |
| B06 | Remote viewer label, two-view renewal batch, idle CPU/RSS sample, 30-second helper outage, replacement view with unchanged children, view-only closure and failed-launch lease release. | Native 60 by 8 owner-relative fallback. |
| B07 | Remote console label and one retained read-only console for two jobs; reuse, discarded input and unchanged live jobs after Send back. | Native console layout and pointer interactions. |
| B08 | Native/proxy conversion both ways in the same space and tab; local and remote agent machine labels; unfocused conversion remains pending without focus theft. | Continuous pixels, native moved placeholder and roaming ownership transitions. |

### Isolated app interaction checklist

B01–B08 remain registered in `app`. Without an owned rendered-UI/input hook they report **blocked** before launching or focusing a window. An installed-mod event callback is not a native click or key. An image is not input evidence.

After compatibility checks, prepare separate 0.1.13 and 0.1.16 copies with `prepareNativeApp`, explicit binary resolution, an owned app home and an owned display. Never use a live home, launcher link or global input injection. Record the copy's ownership document and core IDs, then select only these stories:

```sh
SPIDER_HERDR_APP_TESTS=1 \
SPIDER_HERDR_TEST_DISPLAY_UUID="$OWNED_DISPLAY_UUID" \
SPIDER_HERDR_E2E_APP="$OWNED_APP_BINARY" \
npm run test:herdr:e2e -- --built --tier app \
  --story B01,B02,B03,B04,B05,B06,B07,B08
```

Until that hook exists, retain the blocked automated result and collect the following observations manually in the isolated copy. For each item record the app version, actual target/core IDs, pane/space/tab IDs, cwd, process identity, outcome, duration and cleanup proof. Leave an unavailable observation blocked.

1. **B01:** Use physical keys and the mouse for Tab +, both split actions, Go to → New terminal, the pane menu and an agent action. Check the focused machine default, filtering, unreachable rows and the captured original destination. One action creates one target and one local display.
2. **B02:** Type UTF-8 text, resize the owned pane and observe the destination dimensions. Select and copy output, paste multiline text, and reconnect with history. Check exact cwd on the destination and an unchanged unrelated terminal.
3. **B03:** Cancel remote close, then confirm it. Distinguish the live target after Send back, tab close, space close and proxy exit from the ended target after confirmation. Reopen the same program. Repeat local pi close with its existing confirmation and key binding unchanged.
4. **B04:** Interrupt only the owned connector. Type while disconnected, restore it, and prove that input was discarded. Capture alternate-screen, mouse and bracketed-paste reset behavior. Reuse an alias for a different owned core with the same terminal ID; it must not receive the old target's input. Record reconnect attempts and process accounting.
5. **B05:** Start and name an agent without a prior destination. Choose an existing tab, a new tab and a physical drop target. Restart the helper and check the remembered choice. A live pi outside an hc terminal remains visible but cannot be opened, moved or dragged.
6. **B06:** Open a remote child view beside its parent. With less than 60 by 8 available, check the owner-relative new-tab fallback without shrinking the parent. Record renewal CPU and process counts, disconnect the display for 30 seconds, and reopen it. The view may restart; the child must not. Check close, failed-launch and helper-loss lease release separately.
7. **B07:** Open the same agent's console twice while two jobs run. There is one console identity on that machine. Input is ignored, and closing the display leaves both jobs and the console history intact.
8. **B08:** Observe both-direction conversion continuously in the same space and tab, with no hidden local target proxy. Check every agent, viewer and console machine pill, including **This computer** locally. Move execution while its original tab is unfocused: ownership must not roll back and focus must not move. The native moved placeholder on 0.1.13 is not implemented; keep that observation blocked even if the pending-state assertion passes.

B08 exercises presentation readiness using source-owned session copies. It does not certify home compare-and-swap, revocation or destroyed-machine recovery; the roaming stories own those assertions.

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

Selection is dynamic by tier and ID. `--story S52,S54` and `--task setup|remote|subagents|lifecycle|panels|ssh|runner|roam|panes` select stories; a missing requested ID, duplicate ID, wrong-tier selection, or malformed export fails. `--shuffle --seed fixture` changes execution order reproducibly. `--harness` also runs foundation, native utility, confidence, and `fixtures/**/*.test.ts` tests. Configuration fails with the filename if a harness test falls outside those include patterns.

R01 exercises sync through the packed CLI and two isolated cores in the headless tier. R02 exercises admission, the packaged box observer and hub, and proxy placement with a fixture owner and a closed app. R02 does not start the native app or a pi owner. The headless workflow runs one story per job.

## Run move and recovery stories

Run R06 through R10 only in the GitHub Linux stories job. Select them with its
`stories` input. The job builds and packs the release before this command:

```sh
npm run test:herdr:e2e -- --built --tier headless --story R06,R07,R08,R09,R10
```

These IDs are explicit members of `headless`, not the no-core `ci` tier. Any
selection containing them uses one worker. Each story keeps the existing
startup, per-wait, and 300-second story deadlines. The report records its duration
and independent cleanup proof.

| Story | Coverage |
| --- | --- |
| R06 | Outward move, exact session and mapped cwd, one active owner, staged and working trees, source index bytes, local usage, and deferred same-tab presentation. |
| R07 | Return move, original checkout and file, higher epoch, retained history, and native same-tab presentation. |
| R08 | Busy-source refusal, lost readiness replies, forward recovery, and proved-failure rollback. |
| R09 | The original mirror and revoked reconnect assertions run first. Additional cases restore a mirrored prefix and preserve visible or parked intent, then refuse a reused alias and stale close. |
| R10 | A copied participating file refuses ordinary prompts and tools without creating another owner. |

CLI control and remote operations use the packed entry. The platform wrapper
compiles the real host adapter factory and injects only power, service, launch
limit, and presentation ports. Pi loads the packed extension. Presentation
checks use the real service with a synthetic app document and owned terminal
records, not a native window. Their presentation-only proxy terminals do not
certify attach rendering. Native window observations are blocked on Linux.
Roaming is enabled only in each story's isolated HOME.

## Results

Each invocation has a fresh root under `.spider/scratch/e2/`. Story receipts link the actual `suite.evidenceDirectory` (`e2/_evidence/<story>/<ledger-id>/`), `suite.cleanupProofPath` (`e2/_ledgers/<ledger-id>.cleanup.json`) and ledger path. Installed pi path/version and hc/core/app resolution are retained separately from product output. Pi resolution prefers the Node sibling, then the checkout dependency. hc, core, and app resolution uses `os.userInfo().homedir`. Product subprocesses retain fenced HOME and XDG paths.

The runner registers its worker process group in its own durable ledger and starts an out-of-group watchdog before any build or test. Before starting, and after finishing, it runs the independent entry point `node packages/herdr/e2e/harness/resources.ts reconcile .spider/scratch/e2/_ledgers`. A selected failure matrix is written before tests start, so SIGKILL cannot leave an apparently green report. `cleanup <ledger.json>` also works without Vitest or the runner. A `cleanup-failed` ledger retries the same guarded cleanup before verification.

`--tier ci --story S55` kills real runner instances with TERM and KILL while they own a detached daemon and socket; the headless variant also owns two isolated cores and destination terminal processes. It kills both watchdogs in a further case and proves the next real runner reconciles their durable ledgers. It also proves independent retry collects a survivor from a failed ledger and records unchanged default-socket identity without a default-core CLI call. `--cleanup-control daemon|destination` is a fixture-only hold mode restricted to exactly S55 in ci/headless; use the ordinary S55 story to run and collect it.

Each invocation root contains `invocation.json`, entry digests, build/pack/test logs, per-story JSON, and `matrix.md`/`matrix.json`. The matrix lists the registered S, R (including R06 to R10) and B product IDs and distinguishes **passed**, **failed**, **blocked**, and **not exercised**. An R02 pass names its fixture-owner and native-app coverage limits. Missing selected results fail closed. A cleanup failure overrides any earlier story success. A blocked prerequisite never produces a complete-suite pass. Successful duration includes teardown. Failed runs are not timing samples. IDs that match `H-[a-z0-9-]+` select harness stories, which have a separate matrix section and never count toward the 56 product stories.

S56 in CI repeats the actual runtime probe, mod-helper import, and runtime exit/receipt/stream assertions against the public package. Each pristine artifact must pass before its bad copy can count as caught. The headless controls reuse the actual S29, S22, and S34 definitions. A failed baseline, unrelated assertion, missing definition, or unproved cleanup does not count as a caught control. The CI artifact subset does not certify those active-core controls.

Tier 1 UI claims cover only the strict app boundary or real installed-mod render host. They do not certify GPUI rendering, control bounds, notification display, or native Cmd-key translation. On app 0.1.11, `uiSnapshot`, `activate`, and `keyToOwnedWindow` require a missing fenced rendered-UI/input hook and must fail before any input is posted. Screenshots and headless checks cannot substitute for that hook.

Never use a default core, live app home, existing user session, system SSH transport, or inherited credentials. Every process launch and cleanup goes through the independent foundation supervisor. Known-bad controls operate only on disposable packed-artifact copies under scratch, never in a writer checkout. The no-core CI tier installs neither hc nor an app. The separate headless workflow installs the pinned core but no app, and uploads its failure artifacts.

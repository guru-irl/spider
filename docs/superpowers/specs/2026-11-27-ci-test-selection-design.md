# Complete PR test runs from recorded selection

Date: 2026-11-27. Status: draft for the user's approval.

## Decisions this builds on

- Every PR gets a complete answer, the same one the full suite would give, on at most five runners.
- The 3-minute target comes in a second step that makes each test process cheaper. This spec ships
  selection first (user, 2026-11-27).
- Every push to main runs the full suite. That run also records the selection map and detects misses.
- `typecheck and build` gets a clear name, and no check shows a raw `${{ matrix.* }}` row.

## Today

- **PR runs:**
  - a compile job, `typecheck and build`, takes 52 s;
  - two test shards pick tests from the import graph with a 65 s budget each;
  - tests past the budget are deferred to main, which caused 3 of the 12 PRs that were green on the PR
    and red on main.
- **Main runs:**
  - 12 test shards (227-380 s);
  - Herdr acceptance (235 s);
  - four Chrome jobs (98-187 s);
  - the headless stories.
- Skipped matrix jobs show as `PR tests ${{ matrix.shard }}/2` on main and `test shard ${{ matrix.shard }}/12`
  on PRs.

## Design

### Recording on main

- A separate `selection map` workflow runs on every push to main, next to the normal full run:
  - it runs the suite in six shards under the recorder from `ci/tia-measure`;
  - the recorder is a `NODE_OPTIONS` preload that records which files each test process loads or runs,
    including child processes, worker threads and Spider bundles, which it maps back to source through
    source maps.
- The normal full run doesn't change, so recorder side effects can't make the miss detector flaky.
- The recorded build makes bundles with source maps through an environment switch. Release builds and the
  npm package don't change.
- A final job reduces the shard records to one file. For each test file, it lists every source file the
  test loaded or ran, directly or through a bundle, and the test's duration. The job uploads it as the
  `selection-map` artifact, kept for 30 days.
- PR A's try run (46074045412) recorded all 1,330 test files with zero hook errors. The map is 1.08 MB.
  The six shards' test steps took 518-897 s.
- One file fails only under the recorder: `herdr-setup-releases.test.ts`. Two of its cases reach their
  30-second limit. Recording stays a separate workflow until the process-cost work makes that file
  cheap enough. Then recording can move into main's own shards and use no extra runners.

### Selecting on PRs

Each test runner computes the same selection, as today, and the aggregate checks that every runner used the
same one. The steps:

1. **Find a map.** Take the newest `selection-map` from a main run whose commit is an ancestor of the PR's
   merge base. Every file changed between that commit and the PR head counts as changed. If no map is
   usable, run the whole suite.
2. **Apply the rules** to the changed files:

   | Changed file | Selected tests |
   |---|---|
   | Toolchain or dependencies: `package.json`, `package-lock.json`, `tsconfig*.json`, `vitest.config.ts`, Node version files | whole suite |
   | A test file, changed or added | itself |
   | A source file in the map | every test that loaded or ran it, directly or through a bundle |
   | A source file not in the map | tests that import it, from the static import graph |
   | A deleted file | every test whose record contains it |
   | Docs and READMEs | the doc guard tests, plus tests that name the file |
   | Scripts | tests that name or run them |
   | Herdr e2e files | tests that run or import them |
   | Build config | every test that ran a bundle |
   | Selection code and policy | the selector's tests, plus the guard tests |
   | Files that bundle readers read | the tests in the existing consumer rules that read, hash or pack bundles |
   | Any file in a package whose bundle a test ran without a source map | that test; the map lists such bundles per test |
   | A test whose recorded result is failed or skipped | always selected, because its record may be partial |

3. **No budget.** Nothing is deferred to main.

### Running

- Four test runners with three workers each. The selection is packed by recorded duration, longest first,
  so the runners finish close together.
- The compile job runs as today, for five runners in total.

### Miss detector on main

- Every push to main runs the full suite, Herdr acceptance, Chrome and stories, as today.
- A newer push to main cancels a full run that is still going. A burst of merges then costs one full run,
  and a failure points at a range of commits that the audit can narrow.
- A `selection audit` job compares the main run's failing tests with the selection the merged PR ran,
  taken from its `test-selection` artifact.
- A failure outside that selection, in a test that isn't a known flake, is a miss. The job fails and writes
  the changed files, the failing test and its record to the run summary.
- The audit isn't a required check. A miss means the selector needs fixing.

### Runner budget

The account runs at most 20 jobs at once (GitHub Free). On the afternoon of 2026-11-27, full runs took
23 jobs each, from main pushes and five manual pre-merge runs. PR runs waited up to 256 s for a runner,
and main runs up to 523 s (`queue-wait.py` over runs 46068589504-46074802268). Queueing alone can
break the 3-minute target, so this design limits it in three ways:

1. **No manual full runs before merge.** Once PR B ships, PRs get the complete answer, so the pre-merge
   full runs stop. They were the largest load that afternoon.
2. **Main cancels superseded full runs**, as described above.
3. **Main uses 6 test shards instead of 12.** A main push holds about 11 runners instead of 23.
   Main's run is the miss detector, so 12-15 minutes is acceptable there.

### Workflows and names

- Split by event so that no job is ever skipped:
  - `ci.yml` keeps push, `workflow_dispatch` and `workflow_call`;
  - a new `pr.yml` handles `pull_request`.
- PR checks:
  - `compile`, renamed from `typecheck and build`;
  - `tests 1/4` to `tests 4/4`;
  - the required aggregate, `typecheck · test · build`.

  The required name doesn't change, so branch protection stays as it is.
- Main checks:
  - `compile`;
  - `test shard 1/6` to `6/6`;
  - `selection audit`;
  - Herdr acceptance, the Chrome parts and stories;
  - the aggregate.
- The `selection map` workflow's checks: `record 1/6` to `record 6/6`, and `selection map`.

### Node version

- Every workflow asks for Node `26.x`, which now resolves to 26.13.1. Roam admits only the Node versions
  it was tested on, 22.23.4 and 26.4.0 (`packages/roam/src/inventory.ts`, `provision.ts`). Any story that
  inventories the runner's own Node fails on that check.
- Pin `node-version: '26.4.0'` in every workflow, so CI tests exactly the version roam admits.
- Add a guard test that reads the workflows' Node versions and roam's tested list, and fails when a
  workflow uses a version the list doesn't admit. Moving to a newer Node then becomes one deliberate
  change to both, together with a roam release.

### Flakes

PRs will now run up to the whole suite, so flaky tests will hit PRs more often. Under the standing rule,
known Vitest flakes are fixed or disabled before PRs switch:
- done in #309: the `workspace-import` timeout and `move.test`, plus four old-path cases skipped;
- `provision-adapter` and `herdr-pane-runtime-state` had no sighting after their fixes;
- `sparse-inspection` timed out once beside a heavy neighbour. #313 trims its Git work, and it stays
  tracked until the process-cost work lands.

## Expected timings

From the replay over 64 recent PR heads on four runners:

| PRs finishing within | Count |
|---|---|
| 3 minutes | 6 |
| 4 minutes | 26 |
| 5 minutes | 30 |

- The median is about 5 minutes (315 s).
- The 7 PRs that change the toolchain run everything and take about 14 minutes.
- The process-cost work comes next and shrinks all of these.

## Not in this version

Chrome, stories and Herdr acceptance stay main-only, as today. Nine of the 29 real failures in the replay
window came from them, and main catches them until a second version adds their own selection within the
five-runner limit. #307 set the default headless stories (R18, R10 and R11) on main.

## Rollout

1. **PR A** (draft #314): the `selection map` workflow and the recorder. PR behaviour and the main full
   run don't change. Merge it and wait for the first map.
2. **PR B:**
   - `pr.yml` with recorded selection, the new names and the audit;
   - flake fixes go in first, as separate PRs;
   - tell spiderman before PR B merges.

## Testing

- Selector unit tests with fixture maps, one per rule, including a missing or expired map.
- A replay check runs the shipped selector over the 64 recorded heads. It must match the `B upper` replay
  and select all 20 real failures.
- PR B's own CI runs the new PR workflow before it merges.

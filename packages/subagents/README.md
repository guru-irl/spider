# @spider/subagents

Dispatches subagents as child `pi` processes in single, chain, parallel, and
pipeline modes. Tracks every run in the shared database, reports completion
back to the parent session in the background, and provides the intercom
message primitive used for cross-session handoff.

## Responsibility

This package owns:

- The `run` and `message` action handlers registered on the host
  (`makeRunHandler`, `makeMessageHandler`).
- The four dispatch strategies (single, chain, parallel, pipeline), all built
  on one `Runner`.
- Building the argv and environment for a child `pi` process: model and
  thinking suffix, session file or fork target, tool and extension flags,
  system prompt file, and task text that overflows an argv-length limit.
- Resolving a bare model id to a provider-qualified one before a child spawns.
- The `runs` and `run_events` tables: creating run rows, and recording tool
  intents and results, status changes, handoff edges, assistant messages, and
  log lines against them.
- The child-side reporter: when the current process is itself a spawned
  subagent, it wires into that process's own tool and turn events and writes
  its progress and final status back to the shared database.
- The intercom primitive (`sendIntercom`), used by the `message` action and by
  pipeline handoff between stages.

This package does not own:

- Rendering. `@spider/ui` reads the `runs` and `run_events` tables this
  package writes and owns the agents grid, detail view, and footer.
- Per-run control. There is no interrupt, resume, or message-by-run-id
  surface. `packages/host/src/agents/actions.ts` notes this directly and
  degrades those UI actions to an "unavailable" notice.
- The structured-output capture runtime from upstream pi-subagents. Only the
  two env-var name constants were carried over
  (`STRUCTURED_OUTPUT_SCHEMA_ENV`, `STRUCTURED_OUTPUT_CAPTURE_ENV`); nothing in
  this package currently sets a `structuredOutput` value when building a
  child's args, so those env vars are not populated in the running code.
- Model catalogs, tiers, or model choice policy. `@spider/models` owns that.
  This package only adds a provider prefix to a model id it already received.

## Key modules

| File | What it does |
| --- | --- |
| `index.ts` | Barrel export for the package. Defines `registerSubagentActions(host, pi)`, the entry point the host calls to wire up `run`/`message`. |
| `actions/run.ts` | The `run` action handler. Reads the shape of the arguments and routes to pipeline, chain, parallel, or single dispatch. Builds the background completion notifier. |
| `actions/message.ts` | The `message` action handler, a thin wrapper over `sendIntercom`. |
| `single.ts` | `runSingle()`: one run, foreground or background, through a `Runner`. |
| `chain.ts` | `runChain()`: sequential steps whose task text can reference `{task}` and `{previous}`. |
| `parallel.ts` | `runParallel()`: expands a task list (repeating a task `count` times) and runs the expansion either as a concurrency-limited foreground pool or as fully backgrounded spawns. |
| `pipeline.ts` | `PipelineCoordinator`: a multi-stage pipeline that advances itself when a stage's run reaches a terminal status on the event bus. |
| `runner.ts` | `Runner`: creates a run row, spawns the child through an injected `Spawner`, and finalizes the row on exit, for both foreground and background runs. |
| `coordinators.ts` | A per-session registry of the event tailer and any active pipelines, with teardown on session shutdown. |
| `run-store.ts` | `RunStore`: reads and writes the `runs` table (create, start, progress, finish, get, list, link to a parent run). Re-exports `deriveRunName`. |
| `run-events.ts` | `emitIntent`, `emitToolResult`, `emitStatus`, `emitHandoff`, `emitMessage`, `emitLog`: typed helpers that append rows to `run_events`. |
| `event-tailer.ts` | `RunEventTailer`: polls `run_events` for the run ids it is tracking and republishes them on the in-process event bus, for the live UI feed. |
| `child-reporter.ts` | `makeChildReporter`/`attachChildReporter`: the child-side hooks (tool start/end, assistant messages, turns, shutdown) that write `run_events` and finalize the run row from inside the child process. |
| `pi-args.ts` | `buildPiArgs`/`buildChildSpawnSpec`: builds the full argv and environment for a child `pi` invocation, including the `PI_SUBAGENT_*`/`PI_SPIDER_*` environment variables. |
| `pi-spawn.ts` | `getPiSpawnCommand`: resolves which command to execute for `pi` itself (an explicit override env var, a resolved Windows CLI script, or `pi` on `PATH`). |
| `spawn-default.ts` | `defaultSpawner`: the production `Spawner`, backed by `node:child_process.spawn` with `stdio: "ignore"`. |
| `model-resolve.ts` | `qualifyModelProvider`/`listPiModels`: adds a provider prefix to a bare model id using pi's list of available models. |
| `intercom.ts` | `sendIntercom`/`mirrorMessage`: sends a message to another session through the host `pi` runtime and records it in `message_mirror`. |
| `self-name.ts` | `deriveRunName`: a short label for a run, derived from its agent, role, and task. |
| `completion-output.ts` | `latestRunOutput`: the child's most recent assistant message for a run, used to build the completion report. Used only by `actions/run.ts`, not re-exported from `index.ts`. |
| `schemas.ts` | `RunParams`/`MessageParams` (the typebox argument schemas for the `run`/`message` tool actions) and the `PipelineStage`/`RunPipelineArgs` types. |
| `modes-index.ts` | Re-exports `runSingle`, `runChain`, `runParallel` together. |
| `mcp-direct-tool-allowlist.ts` | `resolveMcpDirectToolNames`: resolves which MCP direct-tool names a child should receive, from cached MCP metadata and config files. Vendored from pi-subagents; used only by `pi-args.ts`, not re-exported from `index.ts`. |

## Public surface

`index.ts` re-exports `run-store`, `run-events`, `pi-args`, `pi-spawn`,
`child-reporter`, `event-tailer`, `runner`, `modes-index`, `intercom`,
`schemas`, `pipeline`, `coordinators`, and `spawn-default` in full, then
separately exports `makeRunHandler` and `makeMessageHandler`, and defines
`registerSubagentActions`.

| Export | Purpose |
| --- | --- |
| `registerSubagentActions(host, pi)` | Registers `run` and `message` on the host. If the current process is itself a subagent child (`PI_SUBAGENT_CHILD=1`), it attaches the child reporter instead and returns without registering any action, so a child never re-enters orchestration. |
| `makeRunHandler(overrides?)` | Builds the `run` action handler. `overrides` gives tests injection points for the store, runner, pipeline coordinator, spawner, and coordinator registry. |
| `makeMessageHandler()` | Builds the `message` action handler. |
| `Runner`, `RunOpts`, `Spawner`, `ChildHandle` | The class and types that execute one dispatch, foreground or background, around a spawned child process. |
| `RunStore`, `RunRow`, `RunStatus`, `NewRun`, `deriveRunName` | The `runs` table gateway, its row shape and status union, and the run-naming helper. |
| `emitIntent`, `emitToolResult`, `emitStatus`, `emitHandoff`, `emitMessage`, `emitLog` | Append one typed row each to `run_events`. |
| `RunEventTailer` | Polls `run_events` and republishes tracked rows on the in-process bus. |
| `PipelineCoordinator` | The pipeline coordinator described under Pipeline dispatch below. |
| `getCoordinators`, `teardownCoordinators`, `teardownAll`, `SessionCoordinators` | The per-session registry of event tailers and pipelines. |
| `runSingle`, `runChain`, `runParallel` | The single, chain, and parallel dispatch functions. Pipeline dispatch is `PipelineCoordinator`, used directly from `actions/run.ts` rather than through `modes-index.ts`. |
| `buildPiArgs`, `buildChildSpawnSpec`, `applyThinkingSuffix`, `thinkingFromModel`, `stripThinkingSuffix` | Build a child's argv/env and split or apply the `model:thinking` suffix convention. |
| `SUBAGENT_CHILD_ENV`, `SUBAGENT_RUN_ID_ENV`, `SUBAGENT_CHILD_AGENT_ENV`, `SUBAGENT_CHILD_INDEX_ENV`, `SUBAGENT_FANOUT_CHILD_ENV`, `SUBAGENT_ORCHESTRATOR_TARGET_ENV`, `SUBAGENT_INTERCOM_SESSION_NAME_ENV`, `SPIDER_DB_PATH_ENV`, `SPIDER_SESSION_ID_ENV` | The environment variable names threaded from parent to child. |
| `getPiSpawnCommand`, `resolveWindowsPiCliScript`, `resolvePiPackageRoot`, `resolveInstalledPiPackageRoot`, `findPiPackageRootFromEntry` | Resolve the command used to launch `pi` for a child process. |
| `defaultSpawner` | The real `child_process`-backed `Spawner`. |
| `qualifyModelProvider`, `listPiModels`, `ListedModel` | Add a provider prefix to a bare model id, from pi's live list of available models. |
| `makeChildReporter`, `attachChildReporter`, `isSubagentChild` | The child-side event wiring described under Key modules. |
| `sendIntercom`, `mirrorMessage`, `SUBAGENT_RESULT_INTERCOM_EVENT`, `SUBAGENT_RESULT_INTERCOM_DELIVERY_EVENT` | The intercom message primitive and its event names. |
| `RunParams`, `MessageParams`, `PipelineStage`, `RunPipelineArgs` | The typebox argument schemas and the pipeline stage types. |

Not exported from `index.ts`: `latestRunOutput` (`completion-output.ts`) and
`resolveMcpDirectToolNames`/`computeMcpServerHash`
(`mcp-direct-tool-allowlist.ts`) are used only inside this package.

## How it fits

**Depends on:** `@spider/db-core` for `Db`, `openDbAt`, `paths`, the `bus`, and
`appendRunEvent`; `typebox` for the argument schemas. `package.json` also
lists `@spider/ui` as a dependency, but nothing under `src/` currently imports
it.

**Depended on by:** `@spider/host`'s `extension.ts` calls
`registerSubagentActions({ registerAction }, pi)` to register the `run`/
`message` actions, and wires `teardownAll()` to the `session_shutdown` hook.
`@spider/organism` imports the `RunRow` type (`drain.ts`, `types.ts`) to read
finished runs while draining a session transcript, and imports `emitLog`
(`worker.ts`) to leave a note on the run feed. `@spider/ui` reads the same
`runs`/`run_events` tables through its own local type definitions, not
through this package.

**Where it sits in a request:** the host builds one `ActionCtx` per dispatch
(both databases, the resolved project, `pi`, `@spider/models`) and calls the
registered `run` handler with it. From there:

### Single dispatch

The default when the arguments name neither `pipeline`, `chain`, nor `tasks`.
`actions/run.ts` calls `runSingle()` with `async: true`, so `Runner.runAsync`
creates one row in `runs`, spawns the child, and returns immediately with
that row (queued/running). The child runs independently in the background.

### Chain dispatch

Given `chain: [...]`, each step runs through `Runner.runForeground`, in
order, inside `runChain()`. A step's `task` text can reference `{task}` (the
overall task) and `{previous}` (the prior step's result), so steps compose
sequentially. `actions/run.ts` does not await `runChain()` itself: it starts
the chain with `void runChain(...)` and returns right away, then attaches a
`.then()` that fires the completion report once using the last step's row,
after the whole chain finishes.

### Parallel dispatch

Given `tasks: [...]`, `runParallel()` first expands the list, repeating each
task entry `count` times (default 1) into independent run specs. `actions/run.ts`
always calls it with `async: true`, so every expanded task is spawned through
`Runner.runAsync` right away and all of the resulting rows are returned
together. A `concurrency`-bounded, awaited worker-pool path also exists in
`runParallel()` for a foreground caller, but the `run` action does not use it.
Because each task is its own `runAsync` call, each one reports completion on
its own, not once for the whole batch.

### Pipeline dispatch

Given `pipeline: [...]`, `actions/run.ts` builds a `PipelineCoordinator` and
calls `start()`, which spawns stage 0 through `Runner.runAsync` and
subscribes to `status` events on the run event bus for the most recently
spawned run. When that run reaches a terminal status (`done`, `failed`, or
`cancelled`), `onRunTerminal` reads its result, expands the next stage's
`task` template (`{task}`, `{previous}`, and `{handoff}` all resolve to the
prior stage's result), spawns the next stage, records a `handoff` row in
`run_events` linking the two runs, and sends an intercom message to a session
name derived from the next stage's role or agent and its run id, carrying
the prior result as the message body. This repeats until the last stage
finishes, at which point the coordinator unsubscribes. No stage is awaited
synchronously by the caller. Because each stage is also spawned through
`Runner.runAsync`, every stage additionally triggers its own completion
report, not only the pipeline's own handoff.

Only a single run per stage is implemented today. `PipelineStage.count` and
`wakeOn: "accepted"` are declared in the schema and type but not implemented:
the coordinator's own comment states that `count > 1` fan-out is deferred and
that `wakeOn: "accepted"` is currently treated the same as `"done"`. The
schema also documents an `{outputs.<as>}` template variable and a per-stage
`as` field; the coordinator's template interpolation only replaces `{task}`,
`{previous}`, and `{handoff}`, and does not read `stage.as` at all.

### Model resolution

Before spawning, `actions/run.ts` calls `listPiModels(ctx.pi)` for pi's
current list of available models, then passes any bare model id (one with no
`/`) through `qualifyModelProvider`. That function matches the id against the
list and, if a match is marked available, prefixes the id with that match's
provider (for example `claude-sonnet-5` becomes
`github-copilot/claude-sonnet-5` if that is the provider pi lists as
available for that model). An id that already contains `/` passes through
unchanged. This step exists because a bare id passed straight to a child pi
process resolves to that family's default provider, which may not be
authenticated in the child's environment; since the default spawner uses
`stdio: "ignore"`, a child that fails at startup for a missing key reports
"done" with no output, so the failure is otherwise silent. A run with no
explicit model inherits the parent's current model and thinking level
(`ctx.model.id`, split into base model and thinking suffix by
`stripThinkingSuffix`/`thinkingFromModel`), so a dispatched run is never
missing that information in the UI.

### Completion report

`Runner.runAsync` calls an injected `onComplete(run, status, result)` once the
spawned child's process exits, whether the child's own `session_shutdown`
hook finalized the run row first or the parent had to finalize it because the
child never reached that hook (a headless or killed process). `actions/run.ts`
supplies that callback as `makeAsyncNotifier`, which reads the child's most
recent assistant message from `run_events` (`latestRunOutput`, falling back
to the raw result string if there is no recorded message), sends the parent
session a message with `customType: "spider.subagent_done"` carrying a short
headline (the run's name, agent, and status) followed by that output text,
and asks pi to trigger the next turn (`{ triggerTurn: true }`) so an idle
parent session continues the conversation on its own instead of waiting for
the user. It also raises a short human-facing notification, using severity
`error` for a failed run and `info` otherwise. In production, the run's
`result` string itself is rarely populated: `defaultSpawner`'s `wait()`
resolves only an exit code, and the child's own `onShutdown` call passes no
result text either, so the output shown in the completion report almost
always comes from the child's last recorded assistant message rather than
from a value threaded through the process exit path.

### Intercom handoff

`sendIntercom(pi, globalDb, { to, message, ... })` is the underlying primitive
for both the `message` action and pipeline handoff. It emits a
`subagent:result-intercom` event carrying a request id, then waits (10
seconds by default, or `timeoutMs`) for a matching
`subagent:result-intercom-delivery` event. Whether or not a reply arrives in
time, the message is recorded in the `message_mirror` table; the returned
`{ delivered, error }` reflects only whether a delivery confirmation was
seen. The `message` action is this primitive with no other logic attached.
Pipeline handoff uses the same primitive to notify the next stage's session
name after that stage's process has already been spawned directly, so the
intercom send there is a handoff record for `message_mirror`, not the
mechanism that starts the next stage's child process.

## Notes

- Every child process is spawned by the parent, whether the mode is single,
  chain, parallel, or pipeline; there is no path in this package that dials
  back into an already-running idle session to hand it new work. "Waking" a
  session in this codebase means sending it a message or starting its
  process, not resuming a suspended one.
- The `run` action does not expose a blocking wait. A test in
  `__tests__/actions.test.ts` asserts directly that no `wait` action is
  registered. `RunParams.async` exists in the schema but `actions/run.ts`
  never reads `args.async`: single-mode calls always pass `async: true`,
  parallel-mode calls always pass `async: true`, and chain/pipeline are
  inherently backgrounded by their own coordinators.
- A spawned child never re-registers `run`/`message`. `registerSubagentActions`
  checks `PI_SUBAGENT_CHILD` first; if it is set, the function attaches the
  child reporter and returns without registering an action, so a child cannot
  dispatch further subagents through this package's action surface. A
  separate `PI_SUBAGENT_FANOUT_CHILD` flag is threaded to the child based on
  whether the parent declared the `subagent` tool for it, independent of that
  guard.
- Task text over 8000 characters is written to a file under an explicit
  scratch root and referenced from argv as `@<path>` instead of being inlined.
  `buildPiArgs` also has a separate file-spill path for a system prompt
  string that applies regardless of length, but `buildChildSpawnSpec` (the
  only caller of `buildPiArgs` inside this package) never supplies a system
  prompt today, so that path is not currently exercised in production.
  Either spill throws if no scratch root is supplied, so a caller cannot
  fall back to the system temp directory.
- `RunParams.handoff`/`RunPipelineArgs.handoff` is typed as `"intercom" |
  "wait"`, and `actions/run.ts` defaults it to `"intercom"`, but
  `PipelineCoordinator` never reads `args.handoff` at all. Every pipeline
  runs the same way (spawn the next stage directly, then send an intercom
  notification) regardless of which value is passed.
- Foreground runs are tracked by `RunEventTailer` as well as background ones.
  A child process writes its own `run_events` rows from inside itself
  (through `attachChildReporter`), so tailing is what makes those rows reach
  the parent's live event bus even while the parent is directly awaiting that
  run.
- Model resolution here is unrelated to `@spider/models`'s tier and catalog
  system. `qualifyModelProvider`/`listPiModels` read pi's own live list of
  available models and only add a provider prefix to an id already chosen
  elsewhere; they do not pick a model or apply a tier.
- The structured-output fields on `BuildPiArgsInput` and their two env vars
  are wired in `buildPiArgs`, but `buildChildSpawnSpec` (what `Runner`
  actually calls) never supplies a `structuredOutput` value, so this path is
  currently unused by any caller in this package.

## See also

- [`packages/host/README.md`](../host/README.md): registers this package's
  `run`/`message` actions and builds the `ActionCtx` they receive.
- [`packages/organism/README.md`](../organism/README.md): reads `RunRow` and
  calls `emitLog` while draining a session transcript.
- [`packages/ui/README.md`](../ui/README.md): renders the `runs`/`run_events`
  tables this package writes.
- [`packages/db-core/README.md`](../db-core/README.md): the `runs`,
  `run_events`, and `message_mirror` tables, and the `run_events` bus.
- [`docs/architecture/feedback-and-learning-loops.md`](../../docs/architecture/feedback-and-learning-loops.md):
  the subagent loop in the context of the wider system.
- [`docs/guide/using-spider.md`](../../docs/guide/using-spider.md): choosing a
  model and thinking level when dispatching a subagent.

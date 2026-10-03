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
- Building the argv and environment for a child `pi` process: separate `--model` and
  `--thinking` flags, session file or fork target, tool and extension flags,
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
  package writes and owns the agents selector, detail view, and footer.
- Per-run UI affordances. Steering is available through `spider message` for
  running RPC children, but this package does not implement the agents UI.
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
| `actions/message.ts` | Routes live RPC runs through owned pipes or their persisted intercom target; refuses terminal and print runs. Peer messages remain queue-first. |
| `single.ts` | `runSingle()`: one run, foreground or background, through a `Runner`. |
| `chain.ts` | `runChain()`: sequential steps whose task text can reference `{task}` and `{previous}`. |
| `parallel.ts` | `runParallel()`: expands a task list (repeating a task `count` times) and runs the expansion either as a concurrency-limited foreground pool or as fully backgrounded spawns. |
| `pipeline.ts` | `PipelineCoordinator`: a multi-stage pipeline that advances itself when a stage's run reaches a terminal status on the event bus. |
| `runner.ts` | `Runner`: creates a run row, spawns the child through an injected `Spawner`, and finalizes the row on exit, for both foreground and background runs. |
| `coordinators.ts` | A per-session registry of the event tailer and any active pipelines, with teardown on session shutdown and `detachForReload` for `/reload`. |
| `child-registry.ts` | The process-wide, versioned (`Symbol.for("spider.childRegistry.v1")`) registry of live child handles that lets background subagents outlive a `/reload`: detach, adopt (same session only, once), exactly-once completion claim, unadopted-child TTL, and disposal of one session's children in every registry version at quit. Every operation is scoped to a session (`disposeSession(sessionId, reason)` is the version-1 contract). |
| `run-store.ts` | `RunStore`: reads and writes the `runs` table (create, start, progress, finish, get, list, link to a parent run). Re-exports `deriveRunName`. |
| `run-events.ts` | `emitIntent`, `emitToolResult`, `emitStatus`, `emitHandoff`, `emitMessage`, `emitLog`: typed helpers that append rows to `run_events`. |
| `event-tailer.ts` | `RunEventTailer`: polls `run_events` for the run ids it is tracking and republishes them on the in-process event bus, for the live UI feed. |
| `child-reporter.ts` | `makeChildReporter`/`attachChildReporter`: the child-side hooks (tool start/end, assistant messages, turns, shutdown) that write `run_events` and finalize the run row from inside the child process. |
| `pi-args.ts` | `buildPiArgs`/`buildChildSpawnSpec`: builds the full argv and environment for a child `pi` invocation, including the `PI_SUBAGENT_*`/`PI_SPIDER_*` environment variables. |
| `pi-spawn.ts` | `getPiSpawnCommand`: resolves which command to execute for `pi` itself (an explicit override env var, a resolved Windows CLI script, or `pi` on `PATH`). |
| `spawn-default.ts` | `defaultSpawner`: detached process-group spawning with parent-owned RPC pipes, or ignored stdio in print mode. |
| `rpc-child.ts` | Strict LF-JSONL drainage, prompt and steer acknowledgements, dialog cancellation, settled completion and abort. |
| `child-intercom.ts` | Resolves enabled installed intercom resources through Pi's public package manager without installing missing packages. |
| `model-resolve.ts` | `qualifyModelProvider`/`listPiModels`: adds a provider prefix to a bare model id using pi's list of available models. |
| `intercom.ts` | `sendIntercom`/`mirrorMessage`: sends a message to another session through the host `pi` runtime and records it in `message_mirror`. |
| `self-name.ts` | `deriveRunName`: a short label for a run, derived from its agent, role, and task. |
| `completion-output.ts` | `latestRunOutput`: the child's most recent assistant message for a run, used to build the completion report. Used only by `actions/run.ts`, not re-exported from `index.ts`. |
| `schemas.ts` | `MessageParams` (the message argument schema) and the `PipelineStage`/`RunPipelineArgs` types. The registered spider tool schema is `SPIDER_PARAMETERS` in `packages/host/src/extension.ts`. |
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
| `buildPiArgs`, `buildChildSpawnSpec`, `thinkingFromModel`, `stripThinkingSuffix` | Build a child's argv/env and parse the input `model:thinking` suffix. Children receive separate model and thinking flags. |
| `applyThinkingSuffix` | Legacy exported helper, unused by production dispatch. |
| `SUBAGENT_CHILD_ENV`, `SUBAGENT_RUN_ID_ENV`, `SUBAGENT_CHILD_AGENT_ENV`, `SUBAGENT_CHILD_INDEX_ENV`, `SUBAGENT_FANOUT_CHILD_ENV`, `SUBAGENT_ORCHESTRATOR_TARGET_ENV`, `SUBAGENT_INTERCOM_SESSION_NAME_ENV`, `SPIDER_DB_PATH_ENV`, `SPIDER_SESSION_ID_ENV` | The environment variable names threaded from parent to child. |
| `getPiSpawnCommand`, `resolveWindowsPiCliScript`, `resolvePiPackageRoot`, `resolveInstalledPiPackageRoot`, `findPiPackageRootFromEntry` | Resolve the command used to launch `pi` for a child process. |
| `defaultSpawner` | The real `child_process`-backed `Spawner`. |
| `qualifyModelProvider`, `listPiModels`, `ListedModel` | Add a provider prefix to a bare model id, from pi's live list of available models. |
| `makeChildReporter`, `attachChildReporter`, `isSubagentChild` | The child-side event wiring described under Key modules. |
| `sendIntercom`, `mirrorMessage`, `SUBAGENT_RESULT_INTERCOM_EVENT`, `SUBAGENT_RESULT_INTERCOM_DELIVERY_EVENT` | The intercom message primitive and its event names. |
| `MessageParams`, `PipelineStage`, `RunPipelineArgs` | The message argument schema and pipeline stage types. The registered run fields are in `SPIDER_PARAMETERS` (`packages/host/src/extension.ts`); top-level `model`/`thinking` apply to single runs, while tasks, chain and pipeline use per-item fields. |

Not exported from `index.ts`: `latestRunOutput` (`completion-output.ts`) and
`resolveMcpDirectToolNames`/`computeMcpServerHash`
(`mcp-direct-tool-allowlist.ts`) are used only inside this package.

## How it fits

**Depends on:** `@spider/db-core` for `Db`, `openDbAt`, `paths`, the `bus`,
`appendRunEvent`, and the shared thinking capability policy; `typebox` for the argument schemas. `package.json` also
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

### Child lifecycle and steering

`subagents.childMode` defaults to `"rpc"`; `"print"` retains legacy argv for new
launches. RPC children are named before extension startup, receive exactly one
prompt over stdin. Prompt acknowledgement has no startup deadline. A child that
exits before acknowledging fails with its stderr tail. After `agent_settled`,
in-flight steering is reconciled and any stranded idle queue is discarded before
stdin closes; no extra prompt is sent to drain it. Outcomes still use
`genuineCompletion` and `run_events`. A clean exit without a deliverable is not
success.

The parent owns the pipes. Quit, `/new`, `/resume` and `/fork` kill children;
`/reload` keeps background children running and stops foreground chain steps.
RPC abort clears queued continuations, sends `abort`, closes stdin, and retains the
process-group kill fallback. Abrupt parent death produces stdin EOF. The reaper
still collects children whose owning host died. Spawn identity is recorded as pid
plus start time, which survives Pi's process-title change. Pid-only kill and
reaper paths signal only a matching identity. The owning session always uses its
in-process handle, even when capturing a start time failed. A surviving process
group can still be signalled after its leader exits. Legacy rows use the old command check and fail
closed with a truthful lost/orphan reason when it cannot confirm the process.

A returned background dispatch is never tied to the parent turn's abort signal,
in either mode. All tool dispatches are asynchronous; there is no foreground
abort-signal subscription. Quit, `/new`, `/resume` and `/fork` cancel every child of the ending session, including chain steps
and pipeline stages, and its pending intercom calls; `/reload` keeps background children running and stops chain steps. Cancellation reports retain the
actual cause. Own-session kill completion is already reported by the kill result
and sends no extra notification unless a steer is accepted but not confirmed or
has no reply yet, delivery unknown. Cancellation is persisted before termination so the child's shutdown reporter cannot replace it. A failed owned kill restores the previous row and its route only while the child has not reported exit and the row still holds that kill's cancellation. A late group-termination failure never resurrects a dead run. Shutdown notifications use `nextTurn` without
triggering a model turn, including during reload. The reason text and the notifier's check both come from `shutdown-reason.ts`, so they cannot drift apart. A cancelled chain or pipeline
does not launch another stage.

Running children can be steered by run ID in their owner session. A successful
RPC reply confirms acceptance, not conversation entry. Pi input handlers can
swallow or transform steers. A `steer_delivery` run event reports **delivered**
only after a correlated user `message_start` enters the conversation. Queue
removal alone is not delivery. Steer acceptance windows are serialized. Exact steer text is
preferred among all additions across that window's queue updates; differing text
counts as **delivered, transformed** only after a successful reply and when it
was the sole addition. Several additions without an exact match remain
**accepted but not confirmed**. Events lack request IDs:
a handler that swallows the steer and independently injects one unrelated message
can still look like a transform; another source injecting identical text is also
indistinguishable. Unrelated injections followed by an unchanged steer prefer
that exact steer text. Exit, stop or settlement before a reply never promotes a
differing injection to transformed delivery; only exact-text entry counts. This is evidence of conversation entry, not
proof of model consumption. A steer in flight across `/reload` remains tracked
and is resolved and reported by the reloaded activation after adoption.

The tool waits up to 10 seconds from the send for observed conversation entry.
At the deadline it returns the current queued state and says "do not resend" if
still queued. The transform residual described above can also appear in the
immediate tool result.

After 10 seconds without an RPC reply, the result is **no reply yet, delivery
unknown**, not a refusal. While the run is still active, do not resend; the written
steer may still be delivered.
The request and its acceptance window remain tracked until settlement, exit or
stop; late RPC success before settlement upgrades it to **accepted but not
confirmed**, and observed entry to **delivered**. Each later steer waits at most
10 seconds for an earlier reply, then is **refused** as not sent. If written, it
has its own 10-second send deadline for acceptance and observed entry. A late reply
releases the next waiter in order. Settlement finalizes unanswered writes as
unknown, refuses unwritten waiters and closes stdin, allowing the run to complete
without a reply. Exit or stop before acceptance likewise leaves written input
unknown unless an exact-text entry was observed. Already observed delivery stays delivered, including exit,
abort, settlement or timeout before the reply. Accepted but unobserved steers at settlement,
exit or abort remain **accepted but not confirmed**. Every completion with steers
includes counts for delivered, accepted but not confirmed, no reply yet, delivery
unknown, and refused in its result and notification, including pipeline handoffs.

Rejections and steers not written use **refused**. Slash-prefixed steers are
refused because Pi can expand skills/templates or reject registered extension
commands, and RPC steer has no literal-text option. Other sessions use the persisted
intercom name when that child launched with enabled intercom. A global
`run_routes` locator points to the owner's runs DB for cross-worktree lookup;
it stores no transport messages and is deleted when the run finalizes. Without
intercom, foreign steering refuses. Optional package resolution failures degrade
to a cross-session-steering warning on the dispatch result instead of failing launch.
Terminal, queued, paused and print runs also refuse. Child orchestration remains
blocked. RPC children load intercom to receive steering but are launched with
`--exclude-tools intercom,contact_supervisor`. The installed package's other
commands are a TUI-only overlay, an identity snippet and alias changes; they do
not initiate contact in RPC. Its bus relays require an explicit extension event,
not an automatic completion send. Automatic presence and inbound receipts remain;
the busy non-UI auto-reply branch is unreachable in RPC. Child escalations stay on
`run_events`, not `contact_supervisor`.

RPC dialogs are cancelled immediately and recorded as warnings. Fire-and-forget
UI requests are ignored. No project trust override is added: print and RPC use
Pi's non-interactive trust resolution. Default RPC mode requires Pi 0.85.1 or
later for `--exclude-tools`, `--name`, `agent_settled` and `clear_queue`; these
features were verified in 0.85.1 and 0.87.0. Older child binaries automatically
use print mode, without an orchestrator target. The compatibility reason appears in
run tool details, run events and completion output, never the persisted result or
chain/pipeline handoff. Metadata is read from the resolved PATH binary or
`PI_SUBAGENT_PI_BINARY`, cached by resolved path plus file mtime and size,
and never obtained by launching pi. PATH uses the first executable file, skipping
directories. CLI or package metadata upgrades invalidate the cache. Unknown
versions keep RPC with a warning in run events and tool details only, not the
completion notification.

At activation the child atomically claims its run's pid (and start time when the
column exists). Every reporter write requires ownership by this process; any
mismatch permanently disables that reporter. Spider-owned commands strip
`PI_SUBAGENT_RUN_ID`, `PI_SPIDER_DB_PATH`, `PI_SPIDER_SESSION_ID`,
`PI_SUBAGENT_CHILD_AGENT`, `PI_SUBAGENT_CHILD_INDEX` and pi-intercom identity
and orchestration variables, so a command cannot act as its parent's reporter
or intercom peer. They keep `PI_SUBAGENT_CHILD=1`, so a pi started from a child's
commands runs in child mode without the agents UI, organism, learner or
run/message/kill capabilities. Long-lived processes those commands start, such
as tmux or an editor, also inherit this flag and pass it to any pi they launch.
Run `unset PI_SUBAGENT_CHILD` in that shell before starting pi to get a top-level
session.

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
`cancelled`), cancellation ends the pipeline. For `done` and `failed`,
`onRunTerminal` reads its result and expands the next stage's
`task` template (`{task}`, `{previous}`, and `{handoff}` all resolve to the
prior stage's result), spawns the next stage, records a `handoff` row in
`run_events` linking the two runs. The expanded initial task is the handoff;
no automatic broker message duplicates it in the next child's conversation.
This repeats until the last stage
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

Before spawning, `actions/run.ts` calls `listPiModels(ctx.modelRegistry)` for pi's
current list of available models, then passes any bare model id (one with no
`/`) through `qualifyModelProvider`. That function matches the id against the
list and, if a match is marked available, prefixes the id with that match's
provider (for example `claude-sonnet-5` becomes
`github-copilot/claude-sonnet-5` if that is the provider pi lists as
available for that model). An id that already contains `/` passes through
unchanged. This step exists because a bare id passed straight to a child pi
process resolves to that family's default provider, which may not be
authenticated in the child's environment. Startup failure is finalized as failed;
exit zero alone is never treated as proof of a deliverable. A run with no
explicit model inherits the parent's current model and thinking level
(`ctx.model.id`, split into base model and thinking suffix by
`stripThinkingSuffix`/`thinkingFromModel`), so a dispatched run is never
missing that information in the UI.

Thinking accepts the shared ordered levels `off`, `minimal`, `low`, `medium`,
`high`, `xhigh`, and `max`. Explicit per-item thinking overrides the input model
suffix. Before launch, `resolveModelThinking` applies pi's capability clamp using
`reasoning` and `thinkingLevelMap`: explicit null entries and omitted extended
levels are unsupported, with higher supported levels preferred across a hole.
The run row and `--thinking` flag carry the effective level, not an unsupported
request. The run tool result, warning event, agent detail and completion note
report caps or upward adjustments. An unchanged level creates no warning; a
non-reasoning model with no request creates no off notice. Unknown model requests
are marked unverified and never recorded as a confirmed effective level.

### Completion report

`Runner.runAsync` calls an injected `onComplete(run, status, result)` once the
spawned child's process exits, whether the child's own `session_shutdown`
hook finalized the run row first or the parent had to finalize it because the
child never reached that hook (a headless or killed process). `actions/run.ts`
supplies that callback as `makeAsyncNotifier`, which prefers the finalized run
result (`latestRunOutput`, falling back to genuine recorded completion), sends the parent
session a message with `customType: "spider.subagent_done"` carrying a short
headline (the run's name, agent, and status) followed by that output text,
and normally asks pi to trigger the next turn (`{ triggerTurn: true }`).
Session-shutdown cancellations instead queue with `{ triggerTurn: false,
deliverAs: "nextTurn" }`, so they cannot start a new turn. Own-session kills
suppress redundant completion notifications unless a steer is accepted but not
confirmed or has no reply yet, delivery unknown. It also raises a short human-facing notification, using severity
`error` for a failed run and `info` otherwise. The child reporter or parent
finalizer populates the run result from genuine recorded completion, not from
an RPC command acknowledgement. Cancelled notifications use the cancellation
cause rather than an earlier assistant reply. Launch-time persistence failures
kill any spawned child and finalize failed; they do not leave a running row with
no owner identity.

### Intercom transport

`sendIntercom(pi, globalDb, { to, message, ... })` is the queue-first primitive
for peer-session messages and foreign-session RPC steering. It records the
message in `message_mirror` before emitting `subagent:result-intercom`, then
waits (10 seconds by default, or `timeoutMs`) for the matching delivery event.
A positive response proves broker acceptance, not recipient acknowledgement
or model consumption. Without confirmation, peer messages remain pending. A
foreign-run steer instead returns an error and removes its undelivered mailbox
row, since a one-shot child's name is not a resumable peer mailbox.

Owner-session RPC steering bypasses this primitive and uses the live pipe.
Pipeline continuation also does not use it: the prior result is already in
the next child's one initial prompt. `handoff: "intercom"` remains a
compatibility spelling, not an extra conversational message.

## Notes

- Every child process is spawned by the parent, whether the mode is single,
  chain, parallel, or pipeline; there is no path in this package that dials
  back into an already-running idle session to hand it new work. "Waking" a
  session in this codebase means sending it a message or starting its
  process, not resuming a suspended one.
- The `run` action does not expose a blocking wait. A test in
  `__tests__/actions.test.ts` asserts directly that no `wait` action is
  registered. The registered `SPIDER_PARAMETERS` schema (`packages/host/src/extension.ts`)
  has no `async` field; `actions/run.ts` never reads `args.async`:
  single-mode calls always pass `async: true`,
  parallel-mode calls always pass `async: true`, and chain/pipeline are
  inherently backgrounded by their own coordinators.
- A spawned child never re-registers `run`/`message`. `registerSubagentActions`
  checks `PI_SUBAGENT_CHILD` first; if it is set, the function attaches the
  child reporter and returns without registering an action, so a child cannot
  dispatch further subagents through this package's action surface. A
  separate `PI_SUBAGENT_FANOUT_CHILD` flag is threaded to the child based on
  whether the parent declared the `subagent` tool for it, independent of that
  guard.
- RPC task text is sent over stdin, including oversized tasks. Print-mode task
  text over 8000 characters is written under an explicit scratch root and
  referenced as `@<path>` in argv. Both modes retain the scratch-backed child
  system prompt. File spill never falls back to the system temp directory.
- `RunPipelineArgs.handoff` accepts `"intercom" | "wait"` for compatibility.
  The coordinator always spawns a fresh continuation child with the prior
  result in its task. Neither spelling adds a blocking wait or broker injection.
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

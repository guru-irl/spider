# @spider/subagents

Dispatches subagents as child `pi` processes in single, chain, parallel, and
pipeline modes. It tracks every run in the shared database and reports
completion back to the parent session in the background. It also provides the
intercom message function that sessions use to hand work to each other.

## Responsibility

This package owns:

- The `run` and `message` action handlers that it registers on the host
  (`makeRunHandler`, `makeMessageHandler`).
- The four dispatch strategies (single, chain, parallel, pipeline). All four
  are built on one `Runner`.
- Building the argv and environment for a child `pi` process. These include
  separate `--model` and `--thinking` flags, the session file or fork target,
  tool and extension flags, the system prompt file, and task text that is too
  long for an argv-length limit.
- Resolving a bare model id to a provider-qualified one before a child spawns.
- The `runs` and `run_events` tables. The package creates run rows and records
  tool intents and results, status changes, handoff edges, assistant messages,
  and log lines against them.
- The child-side reporter. When the current process is itself a spawned
  subagent, the reporter hooks into that process's own tool and turn events.
  It writes the child's progress and final status back to the shared database.
- The intercom function (`sendIntercom`). The `message` action uses it for peer
  messages and for steering runs that another session owns. Pipeline stages pass
  results in the next child's task instead.

This package does not own:

- Rendering. `@spider/ui` reads the `runs` and `run_events` tables that this
  package writes. It owns the agents selector, the detail view, and the footer.
- Per-run UI controls. `spider message` can steer running RPC children, but
  this package does not implement the agents UI.
- The structured-output capture runtime from upstream pi-subagents. Only the
  two env-var name constants came over
  (`STRUCTURED_OUTPUT_SCHEMA_ENV`, `STRUCTURED_OUTPUT_CAPTURE_ENV`). Nothing in
  this package currently sets a `structuredOutput` value when it builds a
  child's args, so the running code never fills in those env vars.
- Model catalogs, tiers, and model choice policy. `@spider/models` owns those.
  This package only adds a provider prefix to a model id it already received.

## Key modules

| File | What it does |
| --- | --- |
| `index.ts` | Barrel export for the package. Defines `registerSubagentActions(host, pi)`, the entry point that the host calls to register `run` and `message`. |
| `actions/run.ts` | The `run` action handler. It reads the shape of the arguments and routes to pipeline, chain, parallel, or single dispatch. It builds the background completion notifier. |
| `actions/message.ts` | Routes live RPC runs through the pipes that the parent owns, or through their persisted intercom target. It refuses terminal and print runs. Peer messages stay queue-first. |
| `single.ts` | `runSingle()` dispatches one run, foreground or background, through a `Runner`. |
| `chain.ts` | `runChain()` runs sequential steps. Each step's task text can reference `{task}` and `{previous}`. |
| `parallel.ts` | `runParallel()` expands a task list, repeating a task `count` times. It runs the expanded list either as a foreground pool with a concurrency limit or as spawns that all run in the background. |
| `pipeline.ts` | `PipelineCoordinator` runs a multi-stage pipeline. It moves to the next stage when the event bus reports that a stage's run reached a terminal status. |
| `runner.ts` | `Runner` creates a run row, spawns the child through an injected `Spawner`, and finalizes the row when the child exits. It does this for both foreground and background runs. |
| `coordinators.ts` | A per-session registry of the event tailer and any active pipelines. It tears them down on session shutdown and provides `detachForReload` for `/reload`. |
| `child-registry.ts` | The process-wide registry of live child handles. It is versioned (`Symbol.for("spider.childRegistry.v1")`) and lets background subagents outlive a `/reload`. It handles detach, adopt (same session only, once), an exactly-once completion claim, a TTL for unadopted children, and, at quit, disposal of one session's children in every registry version. Every operation is scoped to a session. `disposeSession(sessionId, reason)` is the version-1 contract. |
| `run-store.ts` | `RunStore` reads and writes the `runs` table (create, start, progress, finish, get, list, link to a parent run). It re-exports `deriveRunName`. |
| `run-events.ts` | `emitIntent`, `emitToolResult`, `emitStatus`, `emitHandoff`, `emitMessage`, and `emitLog` are typed helpers that append rows to `run_events`. |
| `event-tailer.ts` | `RunEventTailer` polls `run_events` for the run ids it tracks and republishes them on the in-process event bus, which feeds the live UI. |
| `child-reporter.ts` | `makeChildReporter` and `attachChildReporter` provide the child-side hooks (tool start and end, assistant messages, turns, shutdown). From inside the child process, these hooks write `run_events` and finalize the run row. |
| `pi-args.ts` | `buildPiArgs` and `buildChildSpawnSpec` build the full argv and environment for a child `pi` invocation, including the `PI_SUBAGENT_*` and `PI_SPIDER_*` environment variables. |
| `pi-spawn.ts` | `getPiSpawnCommand` resolves which command to run for `pi` itself. That is an explicit override env var, a resolved Windows CLI script, or `pi` on `PATH`. |
| `spawn-default.ts` | `defaultSpawner` spawns a detached process group. It gives the child RPC pipes that the parent owns, or ignores stdio in print mode. |
| `rpc-child.ts` | Implements strict LF-JSONL drainage, prompt and steer acknowledgements, dialog cancellation, settled completion, and abort. |
| `child-intercom.ts` | Resolves the enabled, installed intercom resources through Pi's public package manager. It does not install missing packages. |
| `model-resolve.ts` | `qualifyModelProvider` and `listPiModels` add a provider prefix to a bare model id, using pi's list of available models. |
| `intercom.ts` | `sendIntercom` and `mirrorMessage` send a message to another session through the host `pi` runtime and record it in `message_mirror`. |
| `self-name.ts` | `deriveRunName` makes a short label for a run from its agent, role, and task. |
| `completion-output.ts` | `latestRunOutput` returns the child's most recent assistant message for a run, for the completion report. Only `actions/run.ts` uses it, and `index.ts` does not re-export it. |
| `schemas.ts` | `MessageParams` (the message argument schema) and the `PipelineStage` and `RunPipelineArgs` types. The registered spider tool schema is `SPIDER_PARAMETERS` in `packages/host/src/extension.ts`. |
| `modes-index.ts` | Re-exports `runSingle`, `runChain`, and `runParallel` together. |
| `mcp-direct-tool-allowlist.ts` | `resolveMcpDirectToolNames` decides which MCP direct-tool names a child receives, from cached MCP metadata and config files. It is vendored from pi-subagents. Only `pi-args.ts` uses it, and `index.ts` does not re-export it. |

## Public surface

`index.ts` re-exports these modules in full: `run-store`, `run-events`,
`pi-args`, `pi-spawn`, `child-reporter`, `event-tailer`, `runner`,
`modes-index`, `intercom`, `schemas`, `pipeline`, `coordinators`, and
`spawn-default`. It also exports `makeRunHandler` and `makeMessageHandler`
separately, and defines `registerSubagentActions`.

| Export | Purpose |
| --- | --- |
| `registerSubagentActions(host, pi)` | Registers `run` and `message` on the host. If the current process is itself a subagent child (`PI_SUBAGENT_CHILD=1`), it attaches the child reporter instead and returns without registering any action. A child therefore never re-enters orchestration. |
| `makeRunHandler(overrides?)` | Builds the `run` action handler. With `overrides`, tests can inject the store, runner, pipeline coordinator, spawner, and coordinator registry. |
| `makeMessageHandler()` | Builds the `message` action handler. |
| `Runner`, `RunOpts`, `Spawner`, `ChildHandle` | The class and types that run one dispatch, foreground or background, around a spawned child process. |
| `RunStore`, `RunRow`, `RunStatus`, `NewRun`, `deriveRunName` | The class that reads and writes the `runs` table, its row shape, its status union, and the run-naming helper. |
| `emitIntent`, `emitToolResult`, `emitStatus`, `emitHandoff`, `emitMessage`, `emitLog` | Each appends one typed row to `run_events`. |
| `RunEventTailer` | Polls `run_events` and republishes tracked rows on the in-process bus. |
| `PipelineCoordinator` | The pipeline coordinator described under Pipeline dispatch below. |
| `getCoordinators`, `teardownCoordinators`, `teardownAll`, `SessionCoordinators` | The per-session registry of event tailers and pipelines. |
| `runSingle`, `runChain`, `runParallel` | The single, chain, and parallel dispatch functions. Pipeline dispatch is `PipelineCoordinator`, which `actions/run.ts` uses directly rather than through `modes-index.ts`. |
| `buildPiArgs`, `buildChildSpawnSpec`, `thinkingFromModel`, `stripThinkingSuffix` | Build a child's argv and environment, and parse the `model:thinking` suffix on the input. Children receive separate model and thinking flags. |
| `applyThinkingSuffix` | A legacy exported helper. Production dispatch does not use it. |
| `SUBAGENT_CHILD_ENV`, `SUBAGENT_RUN_ID_ENV`, `SUBAGENT_CHILD_AGENT_ENV`, `SUBAGENT_CHILD_INDEX_ENV`, `SUBAGENT_FANOUT_CHILD_ENV`, `SUBAGENT_ORCHESTRATOR_TARGET_ENV`, `SUBAGENT_INTERCOM_SESSION_NAME_ENV`, `SPIDER_DB_PATH_ENV`, `SPIDER_SESSION_ID_ENV` | The names of the environment variables that the parent passes to the child. |
| `getPiSpawnCommand`, `resolveWindowsPiCliScript`, `resolvePiPackageRoot`, `resolveInstalledPiPackageRoot`, `findPiPackageRootFromEntry` | Resolve the command that launches `pi` for a child process. |
| `defaultSpawner` | The real `Spawner`, backed by `child_process`. |
| `qualifyModelProvider`, `listPiModels`, `ListedModel` | Add a provider prefix to a bare model id, from pi's live list of available models. |
| `makeChildReporter`, `attachChildReporter`, `isSubagentChild` | The child-side event hooks described under Key modules. |
| `sendIntercom`, `mirrorMessage`, `SUBAGENT_RESULT_INTERCOM_EVENT`, `SUBAGENT_RESULT_INTERCOM_DELIVERY_EVENT` | The intercom message function and its event names. |
| `MessageParams`, `PipelineStage`, `RunPipelineArgs` | The message argument schema and the pipeline stage types. The registered run fields are in `SPIDER_PARAMETERS` (`packages/host/src/extension.ts`). Top-level `model` and `thinking` apply to single runs. Tasks, chain and pipeline use per-item fields. |

`index.ts` does not export `latestRunOutput` (`completion-output.ts`),
`resolveMcpDirectToolNames` or `computeMcpServerHash`
(`mcp-direct-tool-allowlist.ts`). Only code inside this package uses them.

## How it fits

This package depends on `@spider/db-core` for `Db`, `openDbAt`, `paths`, the
`bus`, `appendRunEvent`, and the shared thinking capability policy. It depends
on `typebox` for the argument schemas. `package.json` also lists `@spider/ui`
as a dependency, but nothing under `src/` currently imports it.

Other packages use it as follows. `@spider/host`'s `extension.ts` calls
`registerSubagentActions({ registerAction }, pi)` to register the `run` and
`message` actions, and connects `teardownAll()` to the `session_shutdown` hook.
`@spider/organism` imports the `RunRow` type (`drain.ts`, `types.ts`) to read
finished runs while it drains a session transcript. It also imports `emitLog`
(`worker.ts`) to leave a note on the run feed. `@spider/ui` reads the same
`runs` and `run_events` tables through its own local type definitions, not
through this package.

In a request, the host builds one `ActionCtx` per dispatch (both databases,
the resolved project, `pi`, `@spider/models`) and calls the registered `run`
handler with it. The sections below describe what happens next.

### Child lifecycle and steering

`subagents.childMode` defaults to `"rpc"`. With `"print"`, new launches use the
legacy argv. An RPC child gets its name before its extensions start, and it
receives exactly one prompt over stdin. The prompt acknowledgement has no
startup deadline. If a child exits before it acknowledges the prompt, the run
fails with the child's stderr tail. After `agent_settled`, spider reconciles
any steers still in flight and discards any idle queue left behind, then
closes stdin. It sends no extra prompt to drain that queue. Outcomes still use
`genuineCompletion` and `run_events`. A clean exit without a deliverable is
not success.

The parent owns the pipes. Quit, `/new`, `/resume` and `/fork` kill children.
`/reload` keeps background children running and stops foreground chain steps.
An RPC abort clears queued continuations, sends `abort`, and closes stdin. It
keeps the process-group kill as a fallback. If the parent dies abruptly, the
child sees EOF on stdin. The reaper still collects children whose owning host
died. Spider records a child's spawn identity as its pid plus its start time,
which survives Pi's process-title change. Kill and reaper paths that have only
a pid signal a process only when its identity matches. The owning session
always uses its in-process handle, even when it failed to capture a start
time. Spider can still signal a surviving process group after its leader
exits. Legacy rows use the old command check. When that check cannot confirm
the process, they fail closed with a truthful lost or orphan reason.

A background dispatch that has returned is never tied to the parent turn's
abort signal, in either mode. All tool dispatches are asynchronous, and
nothing subscribes to a foreground abort signal. Quit, `/new`, `/resume` and
`/fork` cancel every child of the ending session, including chain steps and
pipeline stages, and they cancel its pending intercom calls. `/reload` keeps
background children running and stops chain steps. Cancellation reports keep
the actual cause. When a session kills its own run, the kill result already
reports the completion. Spider sends no extra notification unless a steer is
accepted but not confirmed, or has no reply yet with delivery unknown. Spider
persists the cancellation before it terminates the child, so the child's
shutdown reporter cannot replace it. If an owned kill fails, spider restores
the previous row and its route. It does so only while the child has not
reported exit and the row still holds that kill's cancellation. A late failure
to terminate the process group never brings a dead run back. Shutdown
notifications use `nextTurn` and do not trigger a model turn, including during
reload. The reason text and the notifier's check both come from
`shutdown-reason.ts`, so they cannot drift apart. A cancelled chain or
pipeline does not launch another stage.

In its owner session, you can steer a running child by run ID. A successful
RPC reply confirms acceptance, not entry into the conversation. Pi input
handlers can swallow or transform steers. A `steer_delivery` run event reports
**delivered** only after a correlated user `message_start` enters the
conversation. Removal from the queue alone is not delivery. Steer acceptance
windows run one at a time. Within a window, spider prefers exact steer text
among all additions across that window's queue updates. Differing text counts
as **delivered, transformed** only after a successful reply, and only when it
was the sole addition. Several additions without an exact match stay
**accepted but not confirmed**. Events lack request IDs, so two cases are
ambiguous. A handler that swallows the steer and separately injects one
unrelated message can still look like a transform. Another source that injects
identical text also cannot be told apart from the steer. If unrelated
injections are followed by an unchanged steer, spider prefers that exact steer
text. Exit, stop or settlement before a reply never promotes a differing
injection to transformed delivery. Only entry of the exact text counts. This
is evidence that the steer entered the conversation, not proof that the model
consumed it. A steer in flight across `/reload` stays tracked. After adoption,
the reloaded activation resolves and reports it.

The tool waits up to 10 seconds from the send to observe conversation entry.
At the deadline it returns the current queued state. If the steer is still
queued, the result says "do not resend". The transform ambiguity described
above can also appear in the immediate tool result.

If no RPC reply arrives within 10 seconds, the result is **no reply yet, delivery
unknown**, not a refusal. While the run is still active, do not resend,
because the written steer may still be delivered. The request and its
acceptance window stay tracked until settlement, exit or stop. A late RPC
success before settlement upgrades the result to **accepted but not
confirmed**, and observed entry upgrades it to **delivered**. Each later steer
waits at most 10 seconds for an earlier reply. If no reply comes, the later
steer is **refused** as not sent. If spider writes the later steer, it has its
own 10-second send deadline for acceptance and observed entry. A late reply
releases the next waiter in order. Settlement marks unanswered writes as
unknown, refuses unwritten waiters, and closes stdin, so the run can complete
without a reply. Exit or stop before acceptance likewise leaves written input
unknown, unless spider observed entry of the exact text. A delivery that was
already observed stays delivered, even if exit, abort, settlement or timeout
comes before the reply. Steers that were accepted but not observed at
settlement, exit or abort stay **accepted but not confirmed**. Every
completion with steers includes counts for delivered, accepted but not
confirmed, no reply yet, delivery unknown, and refused. The counts appear in
its result and notification, including pipeline handoffs.

Rejections and steers that were not written use **refused**. Slash-prefixed
steers are refused, because Pi can expand skills or templates or reject
registered extension commands, and RPC steer has no option to send literal
text. For other sessions, spider uses the persisted intercom name when that
child launched with intercom enabled. A global `run_routes` locator points to
the owner's runs database for lookup across worktrees. It stores no transport
messages, and spider deletes it when the run finalizes. Without intercom,
steering from another session is refused. If optional package resolution
fails, the dispatch result carries a cross-session-steering warning instead of
the launch failing. Terminal, queued, paused and print runs also refuse
steers. Child orchestration stays blocked. RPC children load intercom so they
can receive steering, but they launch with
`--exclude-tools intercom,contact_supervisor`. The installed package's other
commands are a TUI-only overlay, an identity snippet and alias changes. None
of them starts contact in RPC. Its bus relays need an explicit extension
event and do not send automatically on completion. Automatic presence and
inbound receipts remain. The busy non-UI auto-reply branch cannot run in RPC.
Child escalations stay on `run_events`, not `contact_supervisor`.

Spider cancels RPC dialogs immediately and records them as warnings. It
ignores fire-and-forget UI requests. Spider adds no project trust override.
Print and RPC modes use Pi's non-interactive trust resolution. The default RPC
mode requires Pi 0.85.1 or later for `--exclude-tools`, `--name`,
`agent_settled` and `clear_queue`. These features were first verified in
0.85.1 and 0.87.0. Spider now requires pi 1.2.0 or later, including in
children that load its extension. The binary detector still sends older child
binaries to print mode, without an orchestrator target. That fallback does not
make older hosts supported. The compatibility reason appears in run tool
details, run events and completion output. It never appears in the persisted
result or in a chain or pipeline handoff. Spider reads the metadata from the
resolved PATH binary or from `PI_SUBAGENT_PI_BINARY`, and caches it by
resolved path plus file mtime and size. It never launches pi to get the
metadata. On PATH, spider uses the first executable file and skips
directories. Upgrades to the CLI or to package metadata invalidate the cache.
For unknown versions, spider keeps RPC and adds a warning to run events and
tool details only, not to the completion notification.

At activation, the child atomically claims its run's pid, and its start time
when the column exists. Every reporter write requires that this process owns
the run. Any mismatch disables that reporter permanently. Spider-owned
commands strip `PI_SUBAGENT_RUN_ID`, `PI_SPIDER_DB_PATH`,
`PI_SPIDER_SESSION_ID`, `PI_SUBAGENT_CHILD_AGENT`, `PI_SUBAGENT_CHILD_INDEX`
and the pi-intercom identity and orchestration variables. A command therefore
cannot act as its parent's reporter or intercom peer. The commands keep
`PI_SUBAGENT_CHILD=1`, so a pi started from a child's commands runs in child
mode. It has no agents UI, organism or learner, and no run, message or kill
capabilities. Long-lived processes that those commands start, such as tmux or
an editor, also inherit this flag and pass it to any pi they launch. To get a
top-level session, run `unset PI_SUBAGENT_CHILD` in that shell before you
start pi.

### Single dispatch

Single dispatch is the default when the arguments name none of `pipeline`,
`chain`, or `tasks`. `actions/run.ts` calls `runSingle()` with `async: true`.
`Runner.runAsync` then creates one row in `runs`, spawns the child, and
returns that row (queued or running) at once. The child runs on its own in the
background.

### Chain dispatch

Given `chain: [...]`, `runChain()` runs each step in order through
`Runner.runForeground`. A step's `task` text can reference `{task}` (the
overall task) and `{previous}` (the prior step's result), so each step can
build on the one before it. `actions/run.ts` does not await `runChain()`. It
starts the chain with `void runChain(...)` and returns at once. It attaches a
`.then()` that sends the completion report once, with the last step's row,
after the whole chain finishes.

### Parallel dispatch

Given `tasks: [...]`, `runParallel()` first expands the list. It repeats each
task entry `count` times (default 1) as independent run specs. `actions/run.ts`
always calls it with `async: true`, so it spawns every expanded task through
`Runner.runAsync` at once and returns all the resulting rows together.
`runParallel()` also has an awaited worker-pool path for a foreground caller,
with a limit set by `concurrency`, but the `run` action does not use it. Each
task is its own `runAsync` call, so each one reports completion separately,
not once for the whole batch.

### Pipeline dispatch

Given `pipeline: [...]`, `actions/run.ts` builds a `PipelineCoordinator` and
calls `start()`. That call spawns stage 0 through `Runner.runAsync`. It
subscribes to `status` events on the run event bus for the run it spawned most
recently. When that run reaches a terminal status (`done`, `failed`, or
`cancelled`), cancellation ends the pipeline. For `done` and `failed`,
`onRunTerminal` reads the run's result and expands the next stage's `task`
template. In that template, `{task}` resolves to the first stage's original
task text. Both `{previous}` and `{handoff}` resolve to the prior stage's result.
It then spawns the next stage and records a `handoff` row in `run_events` that
links the two runs. The expanded initial
task is the handoff. No automatic broker message repeats it in the next
child's conversation. This repeats until the last stage finishes, and then the
coordinator unsubscribes. The caller does not wait synchronously for any
stage. Each stage is also spawned through `Runner.runAsync`, so every stage
also sends its own completion report, in addition to the pipeline's handoff.

Each stage runs a single run today. The schema and type declare
`PipelineStage.count` and `wakeOn: "accepted"`, but the coordinator does not
implement them. Its own comment states that `count > 1` fan-out is deferred,
and that it currently treats `wakeOn: "accepted"` the same as `"done"`. The
schema also documents an `{outputs.<as>}` template variable and a per-stage
`as` field. The coordinator's template interpolation replaces only `{task}`,
`{previous}`, and `{handoff}`, and does not read `stage.as` at all.

### Model resolution

Before spawning, `actions/run.ts` calls `listPiModels(ctx.modelRegistry)` to
get pi's current list of available models. It then passes any bare model id
(one with no `/`) through `qualifyModelProvider`. That function matches the id
against the list. If a match is marked available, it prefixes the id with that
match's provider. For example, `gpt-6.1-sol` becomes
`github-copilot/gpt-6.1-sol` if pi lists that provider as available for that
model. An id that already contains `/` passes through unchanged. This step
exists because a child pi process resolves a bare id to that family's default
provider, which may not be authenticated in the child's environment. A startup
failure is finalized as failed. Exit code zero alone never counts as proof of
a deliverable. An explicit model wins over configured role defaults. The host
resolves the shipped role defaults from the available catalog. Workers,
planners, and researchers use `github-copilot/gpt-6.1-sol:high`, or
`gpt-6-sol` when 6.1 is not in the catalog. Scouts, digest, self naming, and
upstream watch use `github-copilot/gpt-6-luna:low`. Reviewers use
`github-copilot/claude-opus-5.5:high`. Oracle uses Opus at medium thinking.
Non-Copilot catalogs use the tier fallbacks. Unknown roles, or an empty
eligible catalog, keep the parent-model fallback. `stripThinkingSuffix` and
`thinkingFromModel` split off thinking suffixes.

Thinking accepts the shared ordered levels `off`, `minimal`, `low`, `medium`,
`high`, `xhigh`, and `max`. Explicit per-item thinking overrides the suffix on
the input model. Before launch, `resolveModelThinking` applies pi's capability
clamp using `reasoning` and `thinkingLevelMap`. Explicit null entries and
omitted extended levels count as unsupported. Across a gap in the supported
levels, the clamp prefers a higher supported level. The run row and the
`--thinking` flag carry the effective level, not an unsupported request. The
run tool result, the warning event, the agent detail and the completion note
report caps or upward adjustments. An unchanged level creates no warning. A
non-reasoning model with no thinking request creates no notice that thinking
is off. Requests for unknown models are marked unverified and never recorded
as a confirmed effective level.

### Completion report

`Runner.runAsync` calls an injected `onComplete(run, status, result)` once the
spawned child's process exits. It does so whether the child's own
`session_shutdown` hook finalized the run row first, or the parent had to
finalize it because the child never reached that hook (a headless or killed
process). `actions/run.ts` supplies that callback as `makeAsyncNotifier`. The
notifier prefers the finalized run result (`latestRunOutput`, falling back to
genuine recorded completion). It sends the parent session a message with
`customType: "spider.subagent_done"`. The message carries a short headline
(the run's name, agent, and status) followed by that output text. The
notifier normally asks pi to trigger the next turn (`{ triggerTurn: true }`).
Session-shutdown cancellations instead queue with `{ triggerTurn: false,
deliverAs: "nextTurn" }`, so they cannot start a new turn. When a session
kills its own run, spider suppresses the redundant completion notification
unless a steer is accepted but not confirmed, or has no reply yet with
delivery unknown. The notifier also raises a short notification for the
person at the terminal, with severity `error` for a failed run and `info`
otherwise. The child reporter or the parent finalizer fills in the run result
from genuine recorded completion, not from an RPC command acknowledgement.
Cancelled notifications use the cancellation cause, not an earlier assistant
reply. If persistence fails at launch, spider kills any spawned child and
finalizes the run as failed. It does not leave a running row with no owner
identity.

### Intercom transport

`sendIntercom(pi, globalDb, { to, message, ... })` is the queue-first function
for peer-session messages and for RPC steering of runs in other sessions. It
records the message in `message_mirror` before it emits
`subagent:result-intercom`. It then waits for the matching delivery event, for
10 seconds by default or for `timeoutMs`. A positive response proves that the
broker accepted the message. It does not prove that the recipient
acknowledged it or that the model consumed it. Without confirmation, peer
messages stay pending. A steer to another session's run instead returns an
error and removes its undelivered mailbox row, because a one-shot child's name
is not a peer mailbox that can resume.

Owner-session RPC steering bypasses this function and uses the live pipe.
Pipeline continuation does not use it either, because the prior result is
already in the next child's one initial prompt. `handoff: "intercom"` remains
as a compatibility spelling. It does not send an extra conversational message.

## Notes

- The parent spawns every child process, whether the mode is single, chain,
  parallel, or pipeline. No path in this package contacts an already-running
  idle session to give it new work. In this codebase, "waking" a session means
  sending it a message or starting its process, not resuming a suspended one.
- The `run` action has no blocking wait. A test in
  `__tests__/actions.test.ts` asserts directly that no `wait` action is
  registered. The registered `SPIDER_PARAMETERS` schema
  (`packages/host/src/extension.ts`) has no `async` field, and
  `actions/run.ts` never reads `args.async`. Single-mode calls always pass
  `async: true`, and parallel-mode calls always pass `async: true` too. The
  chain and pipeline coordinators run in the background by design.
- A spawned child never registers `run` or `message` again.
  `registerSubagentActions` checks `PI_SUBAGENT_CHILD` first. If it is set,
  the function attaches the child reporter and returns without registering an
  action. A child therefore cannot dispatch more subagents through this
  package's actions. Separately from that guard, the parent passes a
  `PI_SUBAGENT_FANOUT_CHILD` flag to the child, based on whether the parent
  declared the `subagent` tool for it.
- RPC mode sends task text over stdin, including oversized tasks. In print
  mode, task text over 8000 characters goes into a file under an explicit
  scratch root, and argv refers to it as `@<path>`. Both modes keep the
  scratch-backed child system prompt. Spilling to a file never falls back to
  the system temp directory.
- `RunPipelineArgs.handoff` accepts `"intercom" | "wait"` for compatibility.
  The coordinator always spawns a fresh continuation child with the prior
  result in its task. Neither value adds a blocking wait or a broker
  injection.
- `RunEventTailer` tracks foreground runs as well as background ones. A child
  process writes its own `run_events` rows from inside itself (through
  `attachChildReporter`). Tailing is what brings those rows to the parent's
  live event bus, even while the parent is directly awaiting that run.
- Model resolution here is unrelated to the tier and catalog system in
  `@spider/models`. `qualifyModelProvider` and `listPiModels` read pi's own
  live list of available models and only add a provider prefix to an id
  chosen elsewhere. They do not pick a model or apply a tier.
- `buildPiArgs` handles the structured-output fields on `BuildPiArgsInput` and
  their two env vars. But `buildChildSpawnSpec`, which `Runner` actually
  calls, never supplies a `structuredOutput` value. No caller in this package
  uses this path today.

## See also

- [`packages/host/README.md`](../host/README.md): registers this package's
  `run` and `message` actions and builds the `ActionCtx` they receive.
- [`packages/organism/README.md`](../organism/README.md): reads `RunRow` and
  calls `emitLog` while draining a session transcript.
- [`packages/ui/README.md`](../ui/README.md): renders the `runs` and
  `run_events` tables that this package writes.
- [`packages/db-core/README.md`](../db-core/README.md): the `runs`,
  `run_events`, and `message_mirror` tables, and the `run_events` bus.
- [`docs/architecture/feedback-and-learning-loops.md`](../../docs/architecture/feedback-and-learning-loops.md):
  the subagent loop in the context of the wider system.
- [`docs/guide/using-spider.md`](../../docs/guide/using-spider.md): choosing a
  model and thinking level when dispatching a subagent.

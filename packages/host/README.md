# @spider/host

This package is the pi coding-agent extension entry point, the code pi loads.
It registers the single `spider` tool and dispatches each `action` to a handler
that another `@spider/*` package owns. It renders results through `@spider/ui`.
It also wires the slash commands, control commands, lifecycle hooks, token
routing, and the agents UI.

## Responsibility

`@spider/host` is the composition layer. It owns the boundary between pi and
the rest of the monorepo. That boundary has these parts:

- The `spider` tool definition. This is its name, parameter schema,
  description, and the `execute`, `renderResult` and `renderCall` functions.
- The action registry, and the per-call action context (`ActionCtx`) that every
  handler runs against.
- The code that turns handler return values into pi's tool result shape, and
  the map from each action to a themed renderer.
- The `control` command router (doctor, config, memory, stats, models, insights,
  migrate, skill curate, upstream-watch).
- Slash commands, pi lifecycle hooks, the routing and safety layer over tool
  calls, and the live agents UI.

Host implements the session-local `loop` and `schedule` actions and `/loop`.
They wait on external work, not on subagent completion, and need no database.
Named definitions survive `/reload` and same-session resume through full pi
session-entry snapshots. New sessions and forks start empty. Nothing fires while
closed or asleep. Missed once and cron run once late; intervals resume from their
anchor without catch-up. See
[Loops and scheduled wakeups](../../docs/guide/loop-and-schedule.md).

Other actions live in sibling packages. Search, exec, memory, todos,
subagents, and the organism live there, and those packages register their
handlers through `registerAction`. Host resolves the databases and the model
router once per dispatch, then hands control to those packages.

## Key modules

| File | What it does |
| --- | --- |
| `extension.ts` | The default-exported `spiderExtension(pi)`. Registers the tool, all action handlers from sibling packages, slash commands, message renderers, hooks, routing, the agents UI, and the organism. |
| `dispatch.ts` | The action registry (`registerAction`, `getAction`, `dispatch`) and the `ActionCtx` type. `dispatch` checks the action name and calls the registered handler. |
| `result.ts` | `toToolResult` turns a handler return into pi's `AgentToolResult`. The result has a text block for the model and the structured `details` payload, with ANSI codes removed. |
| `render-result.ts` | pi `renderResult` and `renderCall` for the tool, plus the `spider.subagent_done` and `spider.command` message renderers. Maps each action's `details` to a `@spider/ui` renderer. |
| `loop/index.ts` | Named once, interval, cron, and self-paced trigger state, one wall-clock ticker, dispatch gate, per-name seals, listing, snapshots, and restore. Time calculations are injected. |
| `loop/parser.ts` | The grammar for `/loop [interval] <prompt>`, listing, and default, named, or all stop targets. |
| `loop/time-math.ts` | Injects the real `zoned.ts` and `cron.ts` calculations into production registration. |
| `loop/zoned.ts` | Strict offset-bearing absolute times, IANA zones, local-minute resolution, and display. |
| `loop/cron.ts` | Five-field numeric cron parsing and civil-time occurrence search, including gaps and overlaps. |
| `slash.ts` | Registers the thin slash commands. Each one forwards to `dispatch` and emits a `spider.command` transcript message. `/learn` is different. It forwards to `skill` `op:"distill"` and sends the full distilled prompt as a real queued turn through `sendUserMessage` or `sendMessage`, never as only a display card. |
| `control.ts` | Reads and writes scoped config (defaults first, then global, then local), reports where each effective value comes from, and runs the `doctor` health check. |
| `control/stats-cmd.ts` | `collectStats` builds the token-savings and row-count summary for `control stats`. |
| `control/models-cmd.ts` | `setModelDefault` and `listCatalog` implement `control models`. |
| `control/config-cmd.ts` | `applyConfigEdit` and `applyConfigUnset` check config keys and write them to the selected global or local layer for `control config set/unset`. |
| `routing/index.ts` | Registers the `tool_call` and `tool_result` handlers and the edit and write tool overrides. Records intent, removes secrets, scans for prompt injection, and indexes large output automatically. |
| `routing/safety.ts` | Removes secrets from tool content and scans it for prompt injection. |
| `routing/tracking.ts` | Records rows for tool intent and results. Skips the spider tool itself. |
| `routing/autoindex.ts` | Writes tool output at or above the size threshold to the content store. |
| `routing/overrides.ts` | The edit and write tool overrides (description checks, patch line counts). |
| `hooks.ts` | Registers the pi lifecycle hooks. These add the frozen `spider_memory` prompt section on user and custom-message `before_agent_start`, upsert the session on `session_start`, add skill paths on `resources_discover`, and pass through the compact and shutdown events. |
| `agents/agents-ui.ts` | The live agents UI. It has a footer widget above the editor, the alt+shift+up selector overlay, and the `/agents` command. |
| `agents/run-source.ts` | Reads `runs` and `run_events` for the current session from the DB and subscribes to the `run_events` bus. |
| `agents/actions.ts` | Agent interaction stubs for the UI (message, interrupt, resume, follow). Failures are ignored. |
| `legacy-removal.ts` | Tries to unregister the deprecated legacy tool names so that `spider` replaces them. Failures are ignored. |
| `config-reload.ts` | A config reloader that re-reads the merged config and applies the live toggles again. |
| `embeddings.ts` | Loads fastembed on first use, and holds the embedding config defaults. |

Pi saves the injected global and repo memory section in session files. An
unchanged section does not add another patch. Changes and compaction
checkpoints can save more memory text. HTML and JSONL exports can include it.
See [Data and privacy](../../README.md#data-and-privacy) before you share
transcripts.

## Public surface

The package entry is `src/extension.ts`. It has these exports:

- `default spiderExtension(pi)` (default export). Pi calls this function to
  load the extension. It registers everything and returns nothing.
- `registerAction(name, handler)`, re-exported from `dispatch.ts`. Sibling
  packages call it to attach a handler for an action.
- `enumerate(pi)` lists pi's available models with their capability flags. The
  catalog uses it to resolve a model.
- `sessionIdOf(ctx)` reads the pi session id from a tool-execute context.
- `cwdOf(ctx)` reads the working directory from a tool-execute context.
- `buildActionCtx(pi, args, sessionId, ctxCwd)` builds one `ActionCtx` per
  dispatch. It resolves the project, opens the project and global databases, and
  attaches the `@spider/models` router.

`dispatch.ts` defines the `ActionCtx` type. Every handler receives it, with
these fields: `db` (project DB), `globalDb`, `project`, `sessionId`, `cwd`,
`pi`, and `models`.

## How it fits

`@spider/host` sits at the top of the dependency graph. It depends on every
other `@spider/*` package (`db-core`, `models`, `memory`, `todo`, `context`,
`subagents`, `organism`, `superpowers`, `ui`) and on the pi peer packages
(`@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`). Nothing in the
monorepo depends on host. Pi loads it.

A single tool call goes through these steps:

1. pi calls the tool's `execute(toolCallId, args, signal, onUpdate, ctx)`.
2. `loop` and `schedule` go directly to the session scheduler without opening
   a project database, including usage fallback. For other actions, `execute`
   reads the session id and cwd from `ctx`. It then calls
   `buildActionCtx` to open both databases, resolve the project, and attach the
   model router.
3. `dispatch(args, ctx)` looks up the handler registered for `args.action` and
   calls it. The handler does the work against the context DBs. It is in
   `@spider/context`, `@spider/memory`, `@spider/subagents`, `@spider/todo` or
   `@spider/organism`, or it is the `control` handler inside host.
4. `toToolResult` turns the handler's return into the text for the model and
   the structured `details`.
5. Separately, `renderSpiderResult` maps `details` to a `@spider/ui` renderer
   for the transcript. `renderSpiderCall` renders the title of a call that is
   still running.

Slash commands use the same `dispatch` path. They render through the same
`renderSpiderResult`, by way of the `spider.command` message renderer. So a
`/stats` result and a `control stats` tool result look identical.

## Notes

- `execute` and every hook ignore their own failures where they can.
  Registration is wrapped, so a failure in routing, the agents UI, superpowers,
  or the organism never breaks extension load. The drain and shutdown path
  never throws.
- Routing owns the `tool_call` and `tool_result` events, which carry no session
  id. Host keeps a mutable `currentSessionId`, updates it on `session_start`,
  and gives routing a getter for it. `hooks.ts` does not register those two
  events, on purpose, so that they are not registered twice.
- The return shape of an action handler is loose. Handlers return
  `{ text?, display?, details?, error? }`. `toToolResult` picks the text for
  the model in a fixed order of precedence. It removes ANSI codes so that no
  color codes reach the model. Host never renders `@spider/ui` components into
  the text for the model.
- The `control` router lives in host because it spans several packages. It reads
  and writes config, runs memory approve, reject and consolidation, and builds
  the organism action deps to run curate and insights on demand.
- Registration does not start the background embed worker. If no vectors exist,
  `recall` falls back to full-text search.
- `legacy-removal.ts` does nothing on the current pi build, because that build
  has no `unregisterTool` API. The file stays as a tested manifest, and it
  still works if pi adds such an API.

## See also

- [`@spider/context`](../context/README.md): the search, exec, index and fetch handlers.
- [`@spider/ui`](../ui/README.md): the renderers and the agents UI components.
- [`@spider/memory`](../memory/README.md): staging and the active-memory snapshot.
- [`@spider/subagents`](../subagents/README.md): the run and message handlers.
- [`@spider/organism`](../organism/README.md): drain, curate, and insights.
- [Architecture overview](../../docs/architecture/README.md)

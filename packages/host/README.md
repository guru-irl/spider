# @spider/host

The pi coding-agent extension entry point. This package is the code pi loads.
It registers the single `spider` tool, dispatches each `action` to a handler
owned by another `@spider/*` package, renders results through `@spider/ui`,
and wires the slash commands, control commands, lifecycle hooks, token routing,
and the agents UI.

## Responsibility

`@spider/host` is the composition layer. It owns the boundary between pi and
the rest of the monorepo:

- The `spider` tool definition: its name, parameter schema, description, and
  `execute`/`renderResult`/`renderCall` functions.
- The action registry and the per-call action context (`ActionCtx`) that every
  handler runs against.
- Normalizing handler return values into pi's tool result shape and mapping each
  action to a themed renderer.
- The `control` command router (doctor, config, memory, stats, models, insights,
  migrate, skill curate, upstream-watch).
- Slash commands, pi lifecycle hooks, the routing/safety layer over tool calls,
  and the live agents UI.

It does not implement the actions themselves. Search, exec, memory, todos,
subagents, and the organism live in their own packages and register their
handlers through `registerAction`. Host resolves the databases and the model
router once per dispatch, then hands control to those packages.

## Key modules

| File | What it does |
| --- | --- |
| `extension.ts` | The default-exported `spiderExtension(pi)`. Registers the tool, all action handlers from sibling packages, slash commands, message renderers, hooks, routing, the agents UI, and the organism. |
| `dispatch.ts` | The action registry (`registerAction`, `getAction`, `dispatch`) and the `ActionCtx` type. `dispatch` validates the action name and calls the registered handler. |
| `result.ts` | `toToolResult` normalizes a handler return into pi's `AgentToolResult`: a model-facing text block plus the structured `details` payload, with ANSI stripped. |
| `render-result.ts` | pi `renderResult`/`renderCall` for the tool, plus the `spider.subagent_done` and `spider.command` message renderers. Maps each action's `details` to a `@spider/ui` renderer. |
| `slash.ts` | Registers the thin slash commands that forward to `dispatch` and emit a `spider.command` transcript message. |
| `control.ts` | Config read/write (JSON merge, precedence defaults then global then project) and the `doctor` health check. |
| `control/stats-cmd.ts` | `collectStats` builds the token-savings and row-count summary for `control stats`. |
| `control/models-cmd.ts` | `setModelDefault` and `listCatalog` back `control models`. |
| `control/config-cmd.ts` | `applyConfigEdit` validates and writes a config key for `control config set`. |
| `routing/index.ts` | Registers the `tool_call`/`tool_result` handlers and the edit/write tool overrides. Records intent, scrubs secrets, scans for injection, and auto-indexes large output. |
| `routing/safety.ts` | Secret scrubbing and prompt-injection scanning over tool content. |
| `routing/tracking.ts` | Records tool intent and result rows; exempts the spider tool from its own tracking. |
| `routing/autoindex.ts` | Sends output above the size threshold to the content store. |
| `routing/overrides.ts` | The edit/write tool overrides (description validation, patch line counts). |
| `hooks.ts` | Registers the pi lifecycle hooks: memory snapshot injection on `before_agent_start`, session upsert on `session_start`, skill-path contribution on `resources_discover`, and pass-through handlers for the compact/shutdown events. |
| `agents/agents-ui.ts` | The live agents UI: an above-editor footer widget, the alt+shift+up selector overlay, and the `/agents` command. |
| `agents/run-source.ts` | Reads `runs` and `run_events` for the current session from the DB and subscribes to the `run_events` bus. |
| `agents/actions.ts` | Best-effort agent interaction stubs (message/interrupt/resume/follow) for the UI. |
| `legacy-removal.ts` | Best-effort unregister of the deprecated legacy tool names so `spider` owns the surface. |
| `config-reload.ts` | A config reloader that re-reads the merged config and re-applies live toggles. |
| `embeddings.ts` | Lazy fastembed loader and the embedding config defaults. |

## Public surface

The package entry is `src/extension.ts`. Its exports:

- `default spiderExtension(pi)` (default export): the function pi calls to load
  the extension. It registers everything and returns nothing.
- `registerAction(name, handler)`: re-exported from `dispatch.ts`. Sibling
  packages call this to attach a handler for an action.
- `enumerate(pi)`: lists pi's available models with their capability flags, used
  when resolving a model for the catalog.
- `sessionIdOf(ctx)`: reads the pi session id from a tool-execute context.
- `cwdOf(ctx)`: reads the working directory from a tool-execute context.
- `buildActionCtx(pi, args, sessionId, ctxCwd)`: builds one `ActionCtx` per
  dispatch. It resolves the project, opens the project and global databases, and
  attaches the `@spider/models` router.

The `ActionCtx` type (defined in `dispatch.ts`) is the contract every handler
receives: `db` (project DB), `globalDb`, `project`, `sessionId`, `cwd`, `pi`,
and `models`.

## How it fits

`@spider/host` sits at the top of the dependency graph. It depends on every
other `@spider/*` package (`db-core`, `models`, `memory`, `todo`, `context`,
`subagents`, `organism`, `superpowers`, `ui`) and on the pi peer packages
(`@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`). Nothing in the
monorepo depends on host; pi loads it.

A single tool call flows like this:

1. pi calls the tool's `execute(toolCallId, args, signal, onUpdate, ctx)`.
2. `execute` reads the session id and cwd from `ctx`, then calls
   `buildActionCtx` to open both databases, resolve the project, and attach the
   model router.
3. `dispatch(args, ctx)` looks up the handler registered for `args.action` and
   calls it. The handler (in `@spider/context`, `@spider/memory`,
   `@spider/subagents`, `@spider/todo`, `@spider/organism`, or the in-host
   `control` handler) does the work against the context DBs.
4. `toToolResult` normalizes the handler's return into the model-facing text and
   the structured `details`.
5. Separately, `renderSpiderResult` maps `details` to a `@spider/ui` renderer
   for the transcript. `renderSpiderCall` renders the in-progress call title.

Slash commands run the same `dispatch` path and render through the same
`renderSpiderResult` by way of the `spider.command` message renderer, so a
`/stats` result and a `control stats` tool result look identical.

## Notes

- `execute` and every hook are best-effort. Registration is wrapped so a failure
  in routing, the agents UI, superpowers, or the organism never breaks extension
  load, and the drain/shutdown path never throws.
- Routing owns the `tool_call`/`tool_result` events, which carry no session id.
  Host keeps a mutable `currentSessionId`, updated on `session_start`, and hands
  routing a getter over it. `hooks.ts` intentionally does not register those two
  events to avoid double-registration.
- The action handler return shape is loose. Handlers return
  `{ text?, display?, details?, error? }`; `toToolResult` picks the model-facing
  text in a fixed precedence and strips ANSI so no color codes reach the model.
  `@spider/ui` components are never rendered into the model-facing text.
- The `control` router lives in host because it spans several packages. It reads
  and writes config, drives memory approve/reject and consolidation, and builds
  the organism action deps to run curate and insights on demand.
- The background embed worker is not started at registration. `recall` degrades
  to full-text search when no vectors exist.
- `legacy-removal.ts` no-ops on the current pi build, which exposes no
  `unregisterTool` API. It stays as a tested manifest and degrades gracefully if
  such an API lands.

## See also

- [`@spider/context`](../context/README.md): search, exec, index/fetch handlers.
- [`@spider/ui`](../ui/README.md): the renderers and the agents UI components.
- [`@spider/memory`](../memory/README.md): staging and the active-memory snapshot.
- [`@spider/subagents`](../subagents/README.md): the run and message handlers.
- [`@spider/organism`](../organism/README.md): drain, curate, and insights.
- [Architecture overview](../../docs/architecture/README.md)

# @spider/ui

This package holds the theme-driven rendering functions and reusable TUI components for
everything spider draws: tool-result bodies, the control screens (stats, insights, models,
config), and the subagents footer, grid, and detail overlay. The functions are pure. Each one
takes plain data plus a theme and width from the caller, and returns `string[]`. The package
renders nothing to a terminal by itself and does not depend on the pi extension API.

## Responsibility

This package owns these parts:

- The rendering logic for spider's tool-result body for each action: `exec`, `exec_file` and
  `batch`, `index` and `fetch`, `message`, and the todo checklist.
- The control screens. These are pure model builders and renderers for stats, the insights
  view (the learning graph), the model catalog, and config.
- The subagents views. These are a client-side store that turns `run_events` into agent
  snapshots, the live agents footer, the agent list and grid, and the agent detail overlay.
- Small generic components that the parts above share: a braille spinner, a progress bar, a
  diff view, and a fixed-width table.
- The `Component` interface that every stateful widget in this package implements:

  ```ts
  export interface Component {
    render(width: number): string[];
    handleInput?(key: string): boolean;
    invalidate?(): void;
  }
  ```

- The helpers for the output-UI contract (`statusIcon`, `kv`, `card`, `sectionRule`). They keep
  every renderer within its width and stop renderers from repeating the same frame and title.

This package does not do the following, by design:

- Import `@earendil-works/pi-coding-agent` or depend on the pi extension API in any other way.
  It registers no tools, commands, hooks, or shortcuts. `@spider/host` does that.
- Touch a database. Renderers and screens take plain data that the caller already fetched (a
  `StatsInput`, a `ModelEntry[]`, a config object, or `RunRow` and `RunEvent` shapes passed
  through an injected `RunSource`). Nothing here opens a `Db` or refers to `@spider/db-core`
  tables directly.
- Do file, process, or network I/O.
- Own color. Every color comes from a `ThemeAdapter` (`fg`, `bg`, `bold`, optional `italic`,
  `glyph`) that the caller supplies at render time. In `@spider/host` that adapter wraps pi's
  live theme (`piTheme()` in `packages/host/src/agents/theme-adapter.ts`). The only literal
  token in this package is the box-drawing rule character (`─`), in the legacy `theme.token()`
  helper in `index.ts`.

## Key modules

**Top level**

| File | What it does |
| --- | --- |
| `component.ts` | Defines `Component`. |
| `index.ts` | Barrel export. Also defines an earlier Component-builder API that is still in use (`theme`, `SectionRule`, `Panel`, `StatusLine`, `LiveWidget`). It is older than the per-action renderers (see Notes). |

**`renderers/` (tool-result bodies, one per action)**

| File | What it does |
| --- | --- |
| `types.ts` | `RenderCtx` (theme, width, expanded), the detail interfaces for each action (`ExecDetails`, `IndexDetails`, `MemoryCardDetails`, `TodoChecklistDetails`, `RunResultDetails`, `MessageDetails`), and the shared helpers `statusIcon`, `kv`, `card`, `sectionRule`. |
| `exec.ts` | `renderExecCall` (a standalone call header) and `renderExecResult` (the body for exec, exec_file and batch: command preview, exit status, output preview, and an optional line about indexed output). |
| `index-fetch.ts` | `renderIndexResult` shows the source, the chunk, embedded and skipped counts, and the indexed targets or URLs. |
| `message.ts` | `renderMessageResult` shows the delivery status, a direction arrow, and a flattened preview of the body for send, ask, reply and broadcast. |
| `todo-checklist.ts` | `renderTodoChecklist` shows a scope rule, one `✓/○ #id text` line per item, and an `N/total completed` footer. |

**`screens/` (renderers for the control screens)**

| File | What it does |
| --- | --- |
| `stats-collect.ts` | `summarizeStats` combines raw row counts and per-model timing samples into a token-savings estimate and per-model totals. |
| `stats-view.ts` | `renderStats` and `StatsView` show token savings, row counts, and a per-model table. |
| `insights-view.ts` | `renderInsights` and `InsightsView` show the organism's learning graph as a stats line, a node list, and an edge list. Both lists have a length cap. |
| `models-model.ts` | Exports `catalogRows`, `resolveDefault`, `MODEL_ROLES` and `ModelThinkingDisplay`. The module groups the model catalog by tier and marks which entries are configured role defaults. |
| `models-view.ts` | `renderModels` and `ModelsView` show one section per tier. Each model gets one line with an availability glyph, thinking and vision badges, and role-default markers. |
| `config-schema.ts` | Exports `CONFIG_SCHEMA`, `createConfigSchema`, `getField` and `coerce`. These define the declarative schema, with reviewer thinking enums that host injects, and convert strings to typed values with min, max and enum checks. |
| `config-model.ts` | Exports `buildConfigModel` and `readPath`. The module resolves each field's current value against a config object. It checks the flat dotted key first, then falls back to walking the nested object. |
| `config-view.ts` | `renderConfig` and `ConfigView` show one section per group and one status row per field (default or overridden), with a restart marker where it applies. |

**`agents/` (subagents footer, grid, and detail)**

| File | What it does |
| --- | --- |
| `types.ts` | Shared types: `AgentStatus`, `RunRow`, `AgentSnapshot`, `HandoffEdge`, `RunSource`, `AgentActions`, `ThemeAdapter`, `FooterModel`, `GridLayout`, `LineChange`/`LineDiff`, `STATUS_GLYPH`, `statusToken`. |
| `store.ts` | `AgentStore` subscribes to a `RunSource` and turns `RunRow`/`RunEvent` into `AgentSnapshot`s. It tracks pin state and a selection cursor for the footer, and removes finished agents after a retention window. |
| `footer-model.ts` | `buildFooterModel` sorts agents by status priority and recency, limits how many are visible, and sums up the rest as an overflow count. |
| `footer.ts` | `AgentFooter` (the live status-line component), plus `formatDuration` and the shared one-line formatter `formatAgentLine`. The footer, the list, and the grid all use that formatter. |
| `agent-list.ts` | `AgentList` is an agent selector with no frame, driven by the arrow keys. Enter opens an agent and Escape closes the list. |
| `grid-cell.ts` | `renderGridCell` and `wrapText` draw one multi-line cell of the live agents grid (header, meta line, task, and the tail of recent activity). |
| `agent-detail.ts` | `AgentDetail` is a bordered overlay with one agent's status, its instructions, and its full event conversation in time order. |
| `coalesce.ts` | `FrameScheduler` merges repeated repaint requests into at most one flush per frame interval. |
| `diff.ts` | `diffLines`/`hasChanges` diff lines by index, so a repaint can be skipped when nothing changed. |

**`components/` (generic building blocks)**

| File | What it does |
| --- | --- |
| `spinner.ts` | `Spinner`/`BRAILLE_FRAMES` is a braille spinner driven by time. `frame(now)` picks the frame from the clock, not from a call counter. |
| `progress-bar.ts` | `renderProgressBar` draws a bar of filled and empty characters sized to a value/max ratio. |
| `diff-view.ts` | `renderDiffView` draws add, remove and context hunks, each with theme-token colors and a prefix character. |
| `table.ts` | `renderTable` draws a table with aligned columns. To fit a width budget, it shrinks columns from right to left. |

## Public surface

The exports below come from `packages/ui/src/index.ts`.

**Core**

| Export | Purpose |
| --- | --- |
| `Component` (type) | The interface every widget below implements. |
| `theme` | The original token lookup (`glyph: "🕸"`, `token("rule") === "─"`, and `""` for everything else). Only `SectionRule` uses it. |
| `SectionRule(title?)` | A full-width rule Component with the glyph in its title: `🕸 title ──────`. For overlays only (see Notes). |
| `Panel(opts)` | An optional `SectionRule` header plus body lines clamped to the width. `@spider/todo`, `@spider/memory`, and `@spider/context` use it for their own result bodies. |
| `StatusLine(opts)` | A line with a left part and a right part and a padded gap between them. |
| `LiveWidget(source, render)` | Wraps a `render(width)` function so that it recomputes only when `source.subscribe` signals a change or the width changes. |

**Subagents footer and live grid**

| Export | Purpose |
| --- | --- |
| `AgentStatus`, `RunRow`, `AgentSnapshot`, `HandoffEdge`, `RunSource`, `AgentActions`, `ThemeAdapter`, `FooterModel`, `GridLayout`, `LineChange`, `LineDiff`, `RunEvent` (types), `STATUS_GLYPH`, `statusToken` | The shared agent data model. It includes the two interfaces (`RunSource`, `AgentActions`) that `@spider/host` implements to connect this package to the database and to command dispatch. |
| `AgentStore`, `projectRow`, `applyEvent` | The client-side store. `projectRow` turns a DB row into a snapshot. `applyEvent` adds one `run_events` row to a snapshot's activity tail. `AgentStore` handles subscription, pinning, selection, and removal. |
| `FrameScheduler` | Merges repaint requests within each frame. |
| `diffLines`, `hasChanges` | A line-level diff that tells whether a repaint is needed. |
| `buildFooterModel` | Sorts agents for the footer, limits how many show, and adds an overflow summary. |
| `AgentFooter`, `formatDuration`, `formatAgentLine` | The live footer widget and its formatting helpers. |
| `AgentList` | The agent selector driven by the arrow keys. |
| `renderGridCell` | One cell of the live grid of agents. |
| `AgentDetail` | The detail overlay for one agent. |
| `Spinner`, `BRAILLE_FRAMES` | The braille spinner that the footer, the list, and the grid show while an agent runs. |
| `renderProgressBar` | A progress bar of filled and empty characters. |
| `renderDiffView` | Colored diff hunks. |
| `renderTable` | A table with aligned columns that shrink to fit the width (`renderStats` uses it). |

**Per-action renderers**

| Export | Purpose |
| --- | --- |
| `RenderCtx`, `ExecKind`, `ExecDetails`, `IndexDetails`, `MemoryRecordView`, `MemoryCardDetails`, `TodoItemView`, `TodoChecklistDetails`, `RunView`, `RunResultDetails`, `MessageDetails` (types) | The render context and the detail shape for each action. Some shapes have no matching renderer in this package (see Notes). |
| `card`, `kv`, `statusIcon`, `sectionRule` | The basic building blocks of the output-UI contract. `card` draws an overlay frame with the glyph in its title. `sectionRule` draws a section rule inside a body, with no glyph. `kv` draws a label and value line. `statusIcon` draws a status glyph in its semantic color. |
| `renderExecCall`, `renderExecResult` | The call header and result body for `exec`, `exec_file` and `batch`. |
| `renderIndexResult` | The result body for `index` and `fetch`. |
| `renderMessageResult` | The result body for `message`. |
| `renderTodoChecklist` | The result body for the todo checklist. |

**Screens**

| Export | Purpose |
| --- | --- |
| `summarizeStats`, `StatsInput`, `StatsSummary`, `ModelStatRow` | Pure stats aggregation and the token-savings estimate. |
| `renderStats`, `StatsView` | The stats body, and a component wrapper that caches it by width. |
| `renderInsights`, `InsightsView`, `InsightGraphView` | The learning-graph body and its wrapper. |
| `catalogRows`, `resolveDefault`, `MODEL_ROLES`, `CatalogRow`, `TierGroup`, `ModelThinkingDisplay` | Groups the model catalog and resolves role defaults. |
| `renderModels`, `ModelsView` | The model catalog body and its wrapper. |
| `CONFIG_SCHEMA`, `createConfigSchema`, `getField`, `coerce`, `ConfigField`, `ConfigGroup`, `ConfigFieldType` | The config schema and value conversion. |
| `buildConfigModel`, `readPath`, `ConfigFieldRow`, `ConfigGroupModel` | Resolves current config values against the schema. |
| `renderConfig`, `ConfigView` | The config body and its wrapper. |

## How it fits

This package declares one workspace dependency, `@spider/models`, and uses it only for the
`ModelEntry` and `Tier` types. Its `RunEvent` reference to `@spider/db-core` is also
type-only. It has no runtime workspace dependency, so importing UI loads no database
code or native SQLite modules. The host supplies `createConfigSchema(THINKING_LEVELS)`
and passes that schema to config lookup, conversion and rendering. The host also supplies
`ModelThinkingDisplay` (the supported levels by model ref, and the normalized default refs)
to model grouping and rendering. UI does not copy the level list or resolve model
capabilities. If no thinking data is supplied, the standalone schema has empty
reviewer enums and the models view leaves out the capability lines.

The package has one peer
dependency, `@earendil-works/pi-tui` (`>=1.2.0`). It uses it for string helpers that respect
width (`truncateToWidth`, `visibleWidth`) and for key matching (`Key`, `matchesKey`). `pi-tui` is
a library of display utilities, not the pi extension host. This package does not refer to pi's
tool registration, hooks, or slash-command APIs.

Four packages import from `@spider/ui`. `@spider/host` is the main user:

- `packages/host/src/agents/theme-adapter.ts` builds a `ThemeAdapter` from pi's live theme.
- `packages/host/src/render-result.ts` calls the per-action renderers and the screens to build
  the visible body of each tool result.
- `packages/host/src/control/{stats,models,config}-cmd.ts` call `summarizeStats`,
  `MODEL_ROLES`, `getField`, and `coerce`.
- `packages/host/src/agents/{run-source,actions,agents-ui}.ts` implement `RunSource` and
  `AgentActions` against `@spider/db-core`. They also connect `AgentStore`, `AgentFooter`, and
  `AgentDetail` to pi's widget and overlay APIs.

`@spider/context`, `@spider/memory`, and `@spider/todo` each import the `Component` type and the
`Panel`/`StatusLine` builders from `index.ts` to build their own result bodies.

In a request, this package comes last. An action handler in `@spider/context`,
`@spider/memory`, `@spider/todo`, or `@spider/subagents` returns plain data. `@spider/host`
prepares that data for the model in `result.ts`, which removes any ANSI codes so that the model
never sees color codes. Separately, host turns the same data into a themed body. It calls a
renderer or screen here with a `ThemeAdapter` and the current terminal width. The subagents
footer and grid work differently. Events push updates, instead of each call pulling them.
`AgentStore` subscribes to the `run_events` bus, and the `AgentFooter`, `AgentList` and
`AgentDetail` components repaint as events arrive.

## Notes

- This package has two generations of Component builders. `@spider/todo`, `@spider/memory`, and
  `@spider/context` still build their result bodies with the original one (`theme`,
  `SectionRule`, `Panel`, `StatusLine`, `LiveWidget` in `index.ts`). `@spider/host` calls the
  newer one (`RenderCtx` plus the pure `render*` functions in `renderers/` and `screens/`)
  directly for exec, index/fetch, message, todo-checklist, stats, insights, models, and config.
  `LiveWidget` and the capitalized `SectionRule` are exported and have unit tests. At the time
  of writing, no package outside this one imports them.
- `card()` (with the glyph in its title) and `sectionRule()` (with no glyph) look alike, but
  they belong in different places. `card()` is for standalone overlays that have no outer tool
  frame (mounted through `ctx.ui.custom`). Inside a tool-result renderer it would repeat pi's
  own `🕸 spider · <action>` title line. `docs/output-ui-guidelines.md` documents the full
  contract that this README summarizes.
- `renderers/types.ts` declares `MemoryRecordView`/`MemoryCardDetails` and
  `RunView`/`RunResultDetails`, but this package has no `renderers/memory.ts` or
  `renderers/run.ts`. `@spider/memory` renders the memory-card body (`renderRememberResult`,
  `renderRecallResult`, `renderPending`, built on this package's `Panel`).
  `@spider/host/src/render-result.ts` renders the result bodies for subagent runs and unified
  search inline, with its own local types instead of these two. Only exec, index/fetch,
  message, and todo-checklist have a full renderer in this package.
- `package.json` also lists `@spider/ui` as a dependency of `@spider/organism`,
  `@spider/subagents`, and `@spider/superpowers`. No source file in those three packages
  imports it today.
- `AgentStore` keeps a finished agent for 10 seconds after it ends, unless it is pinned, so
  that it does not vanish from the footer or grid while the user is looking. Pinned agents are
  never removed, and they sort to the top of `snapshot()`.
- Width safety relies on convention, not on a type. Every renderer should pass each output line
  through `truncateToWidth`. The tests under `src/__tests__/` and `src/screens/__tests__/`
  check this with an identity `ThemeAdapter`, one whose `fg`/`bold` return their input
  unchanged, so that a color code cannot hide a line that is too wide.

## See also

- [Output UI guidelines](../../docs/output-ui-guidelines.md)
- [@spider/host](../host/README.md)
- [@spider/models](../models/README.md)
- [@spider/memory](../memory/README.md)
- [@spider/todo](../todo/README.md)
- [@spider/context](../context/README.md)
- [Architecture overview](../../docs/architecture/README.md)

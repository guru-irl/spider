# @spider/ui

Pure, theme-driven rendering functions and reusable TUI components for every spider visual
surface: tool-result bodies, the control screens (stats, insights, models, config), and the
subagents footer, grid, and detail overlay. Every function here takes plain data plus a
caller-supplied theme and width and returns `string[]`. The package renders nothing to a
terminal on its own and has no dependency on the pi extension API.

## Responsibility

This package owns:

- The rendering logic for spider's per-action tool-result bodies: `exec`/`exec_file`/`batch`,
  `index`/`fetch`, `message`, and the todo checklist.
- The control screens: pure model builders and renderers for stats, the insights (learning
  graph) view, the model catalog, and config.
- The subagents surfaces: a client-side store that projects `run_events` into agent snapshots,
  the live agents footer, the agent list/grid, and the agent detail overlay.
- Small generic components used across the above: a braille spinner, a progress bar, a diff
  view, and a fixed-width table.
- The `Component` interface that every stateful widget in this package implements:

  ```ts
  export interface Component {
    render(width: number): string[];
    handleInput?(key: string): boolean;
    invalidate?(): void;
  }
  ```

- The output-UI contract helpers (`statusIcon`, `kv`, `card`, `sectionRule`) that keep every
  renderer width-safe and free of duplicated chrome.

This package deliberately does not:

- Import `@earendil-works/pi-coding-agent` or otherwise depend on the pi extension API. It
  registers no tools, commands, hooks, or shortcuts; `@spider/host` does that.
- Touch a database. Renderers and screens take already-fetched plain data (a `StatsInput`, a
  `ModelEntry[]`, a config object, `RunRow`/`RunEvent` shapes passed through an injected
  `RunSource`). Nothing here opens a `Db` or references `@spider/db-core` tables directly.
- Perform file, process, or network I/O.
- Own color. Every color comes from a `ThemeAdapter` (`fg`, `bg`, `bold`, optional `italic`,
  `glyph`) supplied by the caller at render time. In `@spider/host` that adapter wraps pi's live
  theme (`piTheme()` in `packages/host/src/agents/theme-adapter.ts`). The one literal token kept
  in this package is the box-drawing rule character (`─`), in the legacy `theme.token()` helper
  in `index.ts`.

## Key modules

**Top level**

| File | What it does |
| --- | --- |
| `component.ts` | Defines `Component`. |
| `index.ts` | Barrel export. Also defines an earlier, still-used Component-builder API (`theme`, `SectionRule`, `Panel`, `StatusLine`, `LiveWidget`) that predates the per-action renderers (see Notes). |

**`renderers/` (per-action tool-result bodies)**

| File | What it does |
| --- | --- |
| `types.ts` | `RenderCtx` (theme, width, expanded), the per-action detail interfaces (`ExecDetails`, `IndexDetails`, `MemoryCardDetails`, `TodoChecklistDetails`, `RunResultDetails`, `MessageDetails`), and the shared helpers `statusIcon`, `kv`, `card`, `sectionRule`. |
| `exec.ts` | `renderExecCall` (a standalone call header) and `renderExecResult` (the exec/exec_file/batch body: command preview, exit status, output preview, optional indexed-output line). |
| `index-fetch.ts` | `renderIndexResult`: source, chunk/embedded/skipped counts, and the indexed targets or URLs. |
| `message.ts` | `renderMessageResult`: delivery status, direction arrow, and a flattened body preview for send/ask/reply/broadcast. |
| `todo-checklist.ts` | `renderTodoChecklist`: a scope rule, one `✓/○ #id text` line per item, and an `N/total completed` footer. |

**`screens/` (control-surface renderers)**

| File | What it does |
| --- | --- |
| `stats-collect.ts` | `summarizeStats`: folds raw row counts and per-model timing samples into a token-savings estimate and per-model aggregates. |
| `stats-view.ts` | `renderStats` and `StatsView`: token savings, row counts, and a per-model table. |
| `insights-view.ts` | `renderInsights` and `InsightsView`: the organism's learning graph as a stats line, a capped node list, and a capped edge list. |
| `models-model.ts` | `catalogRows`, `resolveDefault`, `MODEL_ROLES`: groups the model catalog by tier and marks which entries are configured role defaults. |
| `models-view.ts` | `renderModels` and `ModelsView`: one section per tier, one line per model with an availability glyph, thinking/vision badges, and role-default markers. |
| `config-schema.ts` | `CONFIG_SCHEMA`, `getField`, `coerce`: the declarative schema (organism, embeddings, memory, routing, curator, self_naming, models, ui groups) and string-to-typed-value coercion with min/max/enum checks. |
| `config-model.ts` | `buildConfigModel`, `readPath`: resolves each field's current value against a config object, checking the flat dotted key first, then falling back to nested traversal. |
| `config-view.ts` | `renderConfig` and `ConfigView`: one section per group, one default/overridden status row per field, with a restart marker where relevant. |

**`agents/` (subagents footer, grid, and detail)**

| File | What it does |
| --- | --- |
| `types.ts` | Shared types: `AgentStatus`, `RunRow`, `AgentSnapshot`, `HandoffEdge`, `RunSource`, `AgentActions`, `ThemeAdapter`, `FooterModel`, `GridLayout`, `LineChange`/`LineDiff`, `STATUS_GLYPH`, `statusToken`. |
| `store.ts` | `AgentStore`: subscribes to a `RunSource`, projects `RunRow`/`RunEvent` into `AgentSnapshot`s, tracks pin state and a footer selection cursor, and evicts finished agents after a retention window. |
| `footer-model.ts` | `buildFooterModel`: sorts agents by status priority and recency, caps the visible count, and summarizes the rest as an overflow count. |
| `footer.ts` | `AgentFooter` (the live status-line component), plus `formatDuration` and the shared `formatAgentLine` one-line formatter used by the footer, the list, and the grid. |
| `agent-list.ts` | `AgentList`: a frame-less, arrow-key-driven agent selector (Enter drills in, Escape closes). |
| `grid-cell.ts` | `renderGridCell` and `wrapText`: one multi-line cell of the live agents grid (header, meta line, task, recent activity tail). |
| `agent-detail.ts` | `AgentDetail`: a bordered overlay with one agent's status, instructions, and full chronological event conversation. |
| `coalesce.ts` | `FrameScheduler`: coalesces repeated repaint requests into at most one flush per frame interval. |
| `diff.ts` | `diffLines`/`hasChanges`: line-index diffing used to skip a repaint when nothing changed. |

**`components/` (generic building blocks)**

| File | What it does |
| --- | --- |
| `spinner.ts` | `Spinner`/`BRAILLE_FRAMES`: a time-driven braille spinner (`frame(now)` derives the frame from the clock, not from a call counter). |
| `progress-bar.ts` | `renderProgressBar`: a filled/empty character bar sized to a value/max ratio. |
| `diff-view.ts` | `renderDiffView`: add/remove/context hunks rendered with theme-token colors and a prefix character. |
| `table.ts` | `renderTable`: a column-aligned table that shrinks columns right to left to fit a width budget. |

## Public surface

Read from `packages/ui/src/index.ts`.

**Core**

| Export | Purpose |
| --- | --- |
| `Component` (type) | The interface every widget below implements. |
| `theme` | The original token lookup (`glyph: "🕸"`, `token("rule") === "─"`, everything else `""`). Backs `SectionRule` only. |
| `SectionRule(title?)` | A glyph-titled, full-width rule Component: `🕸 title ──────`. Overlay use only (see Notes). |
| `Panel(opts)` | An optional `SectionRule` header plus width-clamped body lines. Consumed by `@spider/todo`, `@spider/memory`, and `@spider/context` for their own result bodies. |
| `StatusLine(opts)` | A left/right two-part line with a padded gap between them. |
| `LiveWidget(source, render)` | Wraps a `render(width)` function so it only recomputes when `source.subscribe` signals a change or the width changes. |

**Subagents footer and live grid**

| Export | Purpose |
| --- | --- |
| `AgentStatus`, `RunRow`, `AgentSnapshot`, `HandoffEdge`, `RunSource`, `AgentActions`, `ThemeAdapter`, `FooterModel`, `GridLayout`, `LineChange`, `LineDiff`, `RunEvent` (types), `STATUS_GLYPH`, `statusToken` | The shared agent data model, plus the two interfaces (`RunSource`, `AgentActions`) that `@spider/host` implements to connect this package to the database and to command dispatch. |
| `AgentStore`, `projectRow`, `applyEvent` | The client-side store: `projectRow` turns a DB row into a snapshot, `applyEvent` folds one `run_events` row into a snapshot's activity tail, `AgentStore` owns subscription, pinning, selection, and eviction. |
| `FrameScheduler` | Coalesces per-frame repaint requests. |
| `diffLines`, `hasChanges` | Line-level diff used to detect whether a repaint is needed. |
| `buildFooterModel` | Sorts and caps agents for the footer, with an overflow summary. |
| `AgentFooter`, `formatDuration`, `formatAgentLine` | The live footer widget and its formatting helpers. |
| `AgentList` | The arrow-key agent selector. |
| `renderGridCell` | One cell of the multi-agent live grid. |
| `AgentDetail` | The single-agent detail overlay. |
| `Spinner`, `BRAILLE_FRAMES` | The braille spinner used by the footer, the list, and the grid while an agent is running. |
| `renderProgressBar` | A filled/empty progress bar. |
| `renderDiffView` | Colored diff hunks. |
| `renderTable` | A column-aligned, width-shrinking table (used by `renderStats`). |

**Per-action renderers**

| Export | Purpose |
| --- | --- |
| `RenderCtx`, `ExecKind`, `ExecDetails`, `IndexDetails`, `MemoryRecordView`, `MemoryCardDetails`, `TodoItemView`, `TodoChecklistDetails`, `RunView`, `RunResultDetails`, `MessageDetails` (types) | The render context and the per-action detail shapes. Not every shape has a matching renderer in this package (see Notes). |
| `card`, `kv`, `statusIcon`, `sectionRule` | The output-UI contract primitives: `card` for a glyph-titled overlay frame, `sectionRule` for a glyph-free in-body section rule, `kv` for a label/value line, `statusIcon` for a status glyph in its semantic color. |
| `renderExecCall`, `renderExecResult` | `exec`/`exec_file`/`batch` call header and result body. |
| `renderIndexResult` | `index`/`fetch` result body. |
| `renderMessageResult` | `message` result body. |
| `renderTodoChecklist` | Todo checklist result body. |

**Screens**

| Export | Purpose |
| --- | --- |
| `summarizeStats`, `StatsInput`, `StatsSummary`, `ModelStatRow` | Pure stats aggregation. |
| `renderStats`, `StatsView` | Stats body and its cached-by-width component wrapper. |
| `renderInsights`, `InsightsView`, `InsightGraphView` | Learning-graph body and wrapper. |
| `catalogRows`, `resolveDefault`, `MODEL_ROLES`, `CatalogRow`, `TierGroup` | Model catalog grouping and role-default resolution. |
| `renderModels`, `ModelsView` | Model catalog body and wrapper. |
| `CONFIG_SCHEMA`, `getField`, `coerce`, `ConfigField`, `ConfigGroup`, `ConfigFieldType` | The config schema and value coercion. |
| `buildConfigModel`, `readPath`, `ConfigFieldRow`, `ConfigGroupModel` | Resolves current config values against the schema. |
| `renderConfig`, `ConfigView` | Config body and wrapper. |

## How it fits

This package has one workspace dependency, `@spider/models` (only for the `ModelEntry` and
`Tier` types used to group the model catalog in `screens/models-model.ts`), and one peer
dependency, `@earendil-works/pi-tui` (`>=0.80.0`), for width-safe string helpers
(`truncateToWidth`, `visibleWidth`) and key matching (`Key`, `matchesKey`). `pi-tui` is a
display-utility library, not the pi extension host: this package has no reference to pi's tool
registration, hooks, or slash-command APIs.

Four packages import from `@spider/ui`. `@spider/host` is the main consumer:
`packages/host/src/agents/theme-adapter.ts` builds a `ThemeAdapter` from pi's live theme;
`packages/host/src/render-result.ts` calls the per-action renderers and screens to build each
tool result's visible body; `packages/host/src/control/{stats,models,config}-cmd.ts` call
`summarizeStats`, `MODEL_ROLES`, `getField`, and `coerce`; and
`packages/host/src/agents/{run-source,actions,agents-ui}.ts` implement `RunSource` and
`AgentActions` against `@spider/db-core` and wire `AgentStore`, `AgentFooter`, and `AgentDetail`
into pi's widget and overlay APIs. `@spider/context`, `@spider/memory`, and `@spider/todo` each
import the `Component` type and the `Panel`/`StatusLine` builders from `index.ts` to shape their
own result bodies.

In a request, this package sits at the end of the chain. An action handler in `@spider/context`,
`@spider/memory`, `@spider/todo`, or `@spider/subagents` returns plain data. `@spider/host`
normalizes that data for the model (`result.ts`, stripping any ANSI so the model never sees
color codes) and, separately, turns the same data into a themed body by calling a renderer or
screen here with a `ThemeAdapter` and the current terminal width. For the subagents footer and
grid, the flow is push-based instead of per-call: `AgentStore` subscribes to the `run_events`
bus and the `AgentFooter`/`AgentList`/`AgentDetail` components repaint as events arrive.

## Notes

- Two Component-builder generations coexist in this package. The original one (`theme`,
  `SectionRule`, `Panel`, `StatusLine`, `LiveWidget` in `index.ts`) is what `@spider/todo`,
  `@spider/memory`, and `@spider/context` still build their result bodies with. The newer one
  (`RenderCtx` plus the pure `render*` functions in `renderers/` and `screens/`) is what
  `@spider/host` calls directly for exec, index/fetch, message, todo-checklist, stats, insights,
  models, and config. `LiveWidget` and the capitalized `SectionRule` are exported and
  unit-tested, but as of writing no package outside this one imports them.
- `card()` (glyph-titled) and `sectionRule()` (glyph-free) look similar but serve different
  places: `card()` is for standalone overlays with no outer tool shell (mounted through
  `ctx.ui.custom`); using it inside a tool-result renderer repeats pi's own
  `🕸 spider · <action>` title line. `docs/output-ui-guidelines.md` documents the full contract
  this README summarizes.
- `renderers/types.ts` declares `MemoryRecordView`/`MemoryCardDetails` and
  `RunView`/`RunResultDetails`, but this package has no `renderers/memory.ts` or
  `renderers/run.ts`. The memory-card body is rendered in `@spider/memory`
  (`renderRememberResult`, `renderRecallResult`, `renderPending`, built on this package's
  `Panel`); the subagent-run and unified-search result bodies are rendered inline in
  `@spider/host/src/render-result.ts` with locally defined types, not these two. Only exec,
  index/fetch, message, and todo-checklist have a full renderer implementation in this package.
- `package.json` lists `@spider/ui` as a dependency of `@spider/organism`, `@spider/subagents`,
  and `@spider/superpowers` too, but no source file in any of those three currently imports it.
- `AgentStore` keeps a finished agent around for 10 seconds after it ends (unless pinned), so it
  does not disappear from the footer or grid mid-glance. Pinned agents are never evicted and
  sort to the top of `snapshot()`.
- Width safety is enforced by convention, not by a type. Every renderer is expected to pass each
  output line through `truncateToWidth`, and the tests under `src/__tests__/` and
  `src/screens/__tests__/` check this with an identity `ThemeAdapter` (one whose `fg`/`bold`
  return their input unchanged), so a color code cannot hide a width violation.

## See also

- [Output UI guidelines](../../docs/output-ui-guidelines.md)
- [@spider/host](../host/README.md)
- [@spider/models](../models/README.md)
- [@spider/memory](../memory/README.md)
- [@spider/todo](../todo/README.md)
- [@spider/context](../context/README.md)
- [Architecture overview](../../docs/architecture/README.md)

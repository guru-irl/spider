# Agents detail overlay implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan inline, task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Read a complete, live run conversation in a bounded overlay without moving the input dock or losing the chat position.

**Architecture:** Keep persistence and pi compatibility in the host. Give `AgentDetail` cached data and a viewport getter, with pure helpers for wrapping, anchors, scrolling, and message counts. Open the real detail above the existing selector and remove the footer-detail path.

**Tech Stack:** TypeScript, Vitest fake timers, the existing run source, and the public pi TUI exports. No new dependencies or database migrations.

**Spec:** `docs/superpowers/specs/2026-11-24-agents-detail-overlay-design.md`, including "Decisions on integration questions".

## Global Constraints

- "The run list, its navigation, and the footer's visual design stay unchanged."
- Do not add transcript search, an instructions editor, horizontal scrolling, a new event producer, or recovery of content that was never stored. Assistant prose still arrives through the existing completed-message reporter.
- "Both regular and fullscreen `tuiMode` use the same detail component."
- "The rectangle excludes the whole input dock."
- `H = max(0, R - D)` and `W = min(C, max(24, floor(0.8 * C)))` in fullscreen mode.
- Use `anchor: "top-center"`, `width: "80%"`, `minWidth: 24`, and `maxHeight: "100%"`. The width supplied to `render` is authoritative.
- Eight fixed rows, `V = H - 8`, and conversation text width `max(1, W - 4)`.
- "If `W < 24` or `H < 9`, show a bounded compact frame that asks for a larger terminal."
- "The first `k` arms kill for three seconds." The confirmation is `k again to kill`; the pending state is `Stopping`.
- "Coalesce data refreshes into at most one refresh per 100 milliseconds." Keep a trailing refresh.
- "Bus events are invalidation signals, so they do not need a database id. No schema change is needed."
- "Rendering, scrolling, and elapsed-time ticks use the cached projection. They do not query or rewrap unchanged history."
- "A component created by `ctx.ui.custom` closes through its completion callback, not `OverlayHandle.hide()`."
- Regular mode may use a shorter overlay. Never add blank base-document rows to make room for it.
- Unknown pi versions or incompatible layout shapes make geometry unavailable. Do not guess editor height or cover the dock.
- Use `matchesKey`, `Key`, ANSI-aware text helpers, the active theme, and normal `tui.requestRender()` calls. Do not replace terminal ownership or enable raw mouse reporting.
- Run only one unit-test file at a time through the supplied `ctl-run.sh`. Export its supplied absolute path as `SPIDER_SINGLE_TEST_RUNNER`; keep machine paths out of this document. Do not use test batches, e2e, app launches, or local full gates.
- Commit each task's explicit paths after its checks. Use the repository identity, a message file, and `git commit -F`; keep message lines within 72 characters. Do not push as part of this plan.

## Review Focus

Each condition has an explicit test below.

1. Same-size dock growth must affect the current composition, not the preceding frame's height. Task 7.
2. A two-column grapheme in a one-column text budget must not disappear, split, or make wrapping loop forever. Task 2.
3. Timestamp ties, delayed inserts, and deletion of the paused event must not corrupt anchors or message counts. Tasks 2, 3, and 4.
4. A nested completion, an empty retained list, or shutdown must never close the selector before its detail. Task 8.
5. A failed refresh or kill completion after Esc must not clear readable history, recapture focus, or recreate an overlay. Tasks 9 and 10.

---

## Files and responsibilities

- Create `packages/ui/src/agents/detail-viewport.ts`: width, fixed-row, compact, and unusable viewport math.
- Create `packages/ui/src/agents/detail-conversation.ts`: event blocks, complete wrapping, source positions, anchor lookup, and per-block wrap caching.
- Create `packages/ui/src/agents/detail-follow.ts`: pure follow-state transitions.
- Create `packages/ui/src/agents/detail-message-count.ts`: successful-snapshot identity comparisons and unread assistant-message ids.
- Modify `packages/ui/src/agents/types.ts`, `packages/ui/src/agents/store.ts`, and `packages/host/src/agents/run-source.ts`: stored-event read type and existing database ids.
- Modify `packages/ui/src/agents/agent-detail.ts`: bounded frame, cached projection, input, and kill presentation.
- Create `packages/host/src/agents/pi-dock-geometry.ts`: the version-checked pi layout and composition adapter. No private pi reads elsewhere.
- Create `packages/host/src/agents/detail-refresh.ts`: initial load, source invalidation, metadata observation, throttling, and cleanup.
- Modify `packages/host/src/agents/agents-ui.ts`: one shared source, nested custom interactions, normalized mouse forwarding, shutdown, and kill actions.
- Modify `packages/ui/src/index.ts`: export only the data and component interfaces needed by the host. Keep pure implementation helpers internal to UI.
- Add the unit tests named in each task. Put small synthetic UI fixtures in `packages/ui/src/__tests__/fixtures/agent-detail.ts` and fake-terminal helpers in `packages/host/src/__tests__/fixtures/agents-tui.ts`. Neither fixture starts a real terminal or process.
- Leave `packages/ui/src/agents/grid-cell.ts` and the footer renderer unchanged. The detail stops using the grid's capped, whitespace-folding `wrapText`.

## Pi compatibility evidence and chosen adapter

Paths prefixed `pi/` are relative to the installed `@earendil-works/pi-coding-agent` package. Paths prefixed `tui/` are relative to its bundled `@earendil-works/pi-tui` package. These are inspection references, not deep imports.

- The installed package version is `1.2.0`, at `pi/package.json:3`. The public `VERSION` export is declared at `pi/dist/index.d.ts:2`; `pi/dist/config.js:459-474` reads the package metadata and assigns `VERSION`. Gate the adapter on `VERSION === "1.2.0"`, not a broad compatible range or a package-json subpath import.
- The factory receives a forwarding TUI proxy, not necessarily the renderer itself. `pi/dist/modes/interactive/tui-renderer.js:37-64` binds method calls to the current renderer and creates a fresh forwarding function on each property read. Resolve the actual receiver through the inherited `tui.valueOf()` call, then guard its terminal, mode, children, prototype, and methods against the supplied reference. Store original descriptors and compare wrapper ownership on that receiver, not the proxy. Reject an unrecognized receiver. Pi prevents mode switches while overlays exist at `pi/dist/modes/interactive/interactive-mode.js:605-610`; after a switch, the next selector installs an adapter for the new receiver.
- The complete dock is the second entry of the fullscreen root: `pi/dist/modes/interactive/chat-viewport.js:12-24`. It contains pending messages, status, above-editor widgets, editor, below-editor widgets, and footer. The root has a zero-basis growing transcript with minimum one row, followed by an auto-basis dock with minimum one row.
- `TuiAltScreen.layoutRoot` and `currentLayout` are runtime fields at `tui/dist/tui-alt-screen.js:44-45`. The completed frame exposes the allocated dock rectangle as `currentLayout.root.children[1].rect`, including `y` and `height`. The frame and boxes are constructed at `tui/dist/layout.js:97-118` and `:280-302`.
- **Do not use `currentLayout` as the current-frame measurement.** `tui/dist/tui-alt-screen.js:1444-1453` lays out the new base frame and composites overlays, but assigns `currentLayout = nextLayout` only at `:1547`. Reading it inside detail rendering is one frame late.
- Capture the dock's current natural height from the return value of `layoutRoot.entries[1].component.render(columns)`. Pi calls it while measuring this base frame at `tui/dist/layout.js:28-29,99-100`. Under the exact root shape above, allocated dock height is `min(max(1, naturalDockHeight), R - 1)` for `R >= 2`. The allocation rule is at `tui/dist/components/stack.js:99-109`. Reject any changed root sizing, gaps, or tree shape rather than applying this formula to a different layout.
- Wrap this TUI instance's `compositeOverlays` method, not its prototype. Publish the captured current-frame geometry immediately before calling the original compositor, so the detail's ensuing `render` sees it. Request another normal frame only when the measurement changes. This also handles a taller input or another dock widget without a terminal resize.
- Regular mode mounts document, pending messages, status, above-editor widgets, editor, below-editor widgets, and footer in that order at `pi/dist/modes/interactive/interactive-mode.js:690-699`. The document has three container children at `:385-391`; editor and footer are container children at `:406-412`. `tui/dist/tui.js:138-149` concatenates their rendered rows. Wrap regular `render` to start a fresh measurement generation, and capture the six dock components' row counts during that same base render, including empty spacing rows.
- In regular mode let `B = min(R, baseLines.length)`, `D` be those six row counts, and `H = max(0, B - D)`. Use the original compositor with effective frame height `B` while the agents interactions own composition. Its ordinary unconditional padding at `tui/dist/tui.js:999-1010` would otherwise move a short document's dock even for a shorter detail. Do not append rows, modify base lines, or alter the editor. The origin is the first visible base-document row, not an invented terminal row zero; the adjusted composition frame performs that placement translation.
- Validate overlay ownership before shortening regular composition. If an unrelated visible overlay is present, leave its composition unchanged and report agents geometry unavailable. The adapter may inspect only typed, guarded stack entries for this check; visibility is defined at `tui/dist/tui.js:542-550`.
- Custom overlay options resolve once at `pi/dist/modes/interactive/interactive-mode.js:2361-2374`. Dimensions must therefore come from a live getter, not an options callback. Its completion path calls topmost `hideOverlay()` at `:2337-2348`; `tui/dist/tui.js:477-483` pops the last stack entry. This requires top-first closure, including any unrelated dialog above our interactions.

The adapter owns every private-field guard, per-instance wrapper, and restoration. It never imports private pi modules, reruns the whole layout engine, reads the database, or scans terminal text for editor markers.

## Task 1: Calculate bounded viewport dimensions

**Files:** Create `packages/ui/src/agents/detail-viewport.ts` and `packages/ui/src/__tests__/detail-viewport.test.ts`.

**Interfaces:** Produce `detailWidth(columns: number): number` and `detailViewport(width: number, safeHeight: number): DetailViewport`. `DetailViewport` is a discriminated union: `normal` has `width`, `height`, `textWidth`, `conversationTop: 6`, and `conversationRows`; `compact` and `unusable` have `width` and `height`. Width and height are nonnegative integral cells. `unusable` means width or height is below three.

- [ ] **Write the failing tests.** Pin the normal layout and the two size thresholds.

```ts
expect(detailWidth(120)).toBe(96);
expect(detailViewport(96, 40 - 10)).toEqual({
	kind: "normal", width: 96, height: 30, textWidth: 92,
	conversationTop: 6, conversationRows: 22,
});
expect(detailViewport(24, 9).kind).toBe("normal");
expect(detailViewport(23, 9).kind).toBe("compact");
expect(detailViewport(24, 8).kind).toBe("compact");
expect(detailViewport(24, 2).kind).toBe("unusable");
```

Add `clamps_width_to_terminal` with columns `0, 1, 23, 24, 120`, and `never_returns_negative_sizes` with safe heights `0, 1, 2, 8, 9`.

- [ ] **Run red.** `bash "$SPIDER_SINGLE_TEST_RUNNER" packages/ui/src/__tests__/detail-viewport.test.ts`. Expect missing exports or failing dimensions.
- [ ] **Implement** the two functions using the spec's formulas. Do not apply 80% again to the width supplied by pi.
- [ ] **Run green.** Repeat the same single-file command. Expect all tests in that file to pass.
- [ ] **Commit** the two explicit files with subject `feat(ui): calculate detail viewport bounds`.

**Done check:** The normal example has exactly eight fixed rows and 22 conversation rows; tiny sizes cannot request negative padding.

## Task 2: Wrap complete event blocks with stable source anchors

**Files:** Create `packages/ui/src/agents/detail-conversation.ts`, `packages/ui/src/__tests__/detail-conversation.test.ts`, and the UI fixture file. Modify `packages/ui/src/agents/types.ts`.

**Interfaces:** Add `StoredRunEvent = RunEvent & { id: number }`, separate from the bus type. Produce `SourceAnchor { eventId: number; textOffset: number }`, `ConversationBlock { key: string; eventId?: number; text: string; assistantMessage: boolean }`, and `WrappedRow { text: string; anchor?: SourceAnchor }`. `textOffset` is a UTF-16 position in that event block's ANSI-stripped text before tab expansion, never inside a grapheme. In the UI fixture, define `messageBlock(id: number, text: string): ConversationBlock` and `storedEvent(id: number, summary: string): StoredRunEvent` for assistant messages. Produce `projectConversation(events: readonly StoredRunEvent[], run: AgentSnapshot, theme: ThemeAdapter): ConversationBlock[]`, `wrapConversation(blocks: readonly ConversationBlock[], textWidth: number): WrappedRow[]`, and `resolveAnchor(anchor: SourceAnchor, previousRows: readonly WrappedRow[], nextRows: readonly WrappedRow[]): number`.

- [ ] **Write the failing tests.** Use synthetic events with numeric ids and explicit input text.

```ts
const blocks = [{ key: "event:7", eventId: 7, text: "ab\n  cd\nabcdefgh", assistantMessage: true }];
const rows = wrapConversation(blocks, 4);
expect(rows.map(row => row.text)).toEqual(["ab", "  cd", "abcd", "efgh"]);
expect(rows.at(-1)?.anchor).toEqual({ eventId: 7, textOffset: 12 });
expect(wrapConversation([{ ...blocks[0], text: "x".repeat(500) }], 4)).toHaveLength(125);
```

Add `preserves_ansi_and_graphemes` using colored multiline text, indentation, `界`, and `e\u0301`; every returned row fits its budget and reconstructs the source's visible content. Add `handles_wide_grapheme_in_one_cell`: retain that grapheme's anchor and emit a one-cell replacement only while width is one; widening restores the actual glyph. No loop or split combining sequence is allowed. Add `anchors_survive_rewrap_and_missing_events`: resolve the same source offset after widths `12, 6, 20`; if its event disappears, choose the nearest surviving event in the previous event order, preferring the next event on a tie, then clamp. Resolve an empty history to zero.

Add projection cases for assistant prose, a duration-only message, tool intent, tool result with timing, handoff, warnings, and activity. An unknown event or an empty message with no valid timing creates no block. Invalid optional payloads omit timing. Use the local key `activity`; it has no stored id and is never a counted message.

- [ ] **Run red.** `bash "$SPIDER_SINGLE_TEST_RUNNER" packages/ui/src/__tests__/detail-conversation.test.ts`. Expect missing helpers or failing rows and anchors.
- [ ] **Implement** the interfaces with `wrapTextWithAnsi`, `visibleWidth`, `sliceByColumn`, and grapheme-safe source mapping. Preserve newlines and spaces. Normalize CRLF to LF and expand tabs to four-column stops before wrapping. Track mapping through normalization and wrapping, including whitespace consumed by a wrap boundary. Reapply semantic styles on every row. Do not use string-length slicing for terminal columns.
- [ ] **Run green.** Repeat the same single-file command. Expect every stored text position to remain reachable, with no 60-row or 120-row cap.
- [ ] **Commit** the explicit files with subject `feat(ui): wrap detail events with source anchors`.

**Done check:** Rewrapping changes row positions but not stored event identity or source position. Warning and timing blocks no longer need extra header rows.

## Task 3: Model following and paused scrolling

**Files:** Create `packages/ui/src/agents/detail-follow.ts` and `packages/ui/src/__tests__/detail-follow.test.ts`.

**Interfaces:** Consume `WrappedRow` and `SourceAnchor`. Produce `FollowState = { mode: "following"; offset: number } | { mode: "paused"; offset: number; anchor: SourceAnchor }`, `initialFollowState(): FollowState`, and `reduceFollow(state: FollowState, action: FollowAction, rows: readonly WrappedRow[], viewportRows: number): FollowState`. Actions are `{ type: "scroll"; delta: number }`, `{ type: "end" }`, and `{ type: "layout"; previousRows: readonly WrappedRow[] }`. Call layout transitions only for normal viewports; compact mode retains the last normal state.

- [ ] **Write the failing tests.** Seed ten mapped rows and a four-row viewport.

```ts
const bottom = reduceFollow(initialFollowState(), { type: "layout", previousRows: [] }, rows, 4);
expect(bottom).toEqual({ mode: "following", offset: 6 });
const paused = reduceFollow(bottom, { type: "scroll", delta: -1 }, rows, 4);
expect(paused).toMatchObject({ mode: "paused", offset: 5, anchor: rows[5].anchor });
expect(reduceFollow(paused, { type: "end" }, rows, 4)).toEqual(bottom);
```

Add `clamps_both_ends`, `does_not_pause_when_all_content_fits`, `keeps_bottom_on_append`, and `resumes_when_down_reaches_bottom`. Add `preserves_source_anchor_on_content_and_width_change`, including the deleted-event rule from Task 2. Add `larger_viewport_resumes_following`: increasing capacity to include all remaining rows returns `following`. An activity-only row cannot create an invalid stored anchor; use the nearest stored row, or remain following if none exists.

- [ ] **Run red.** `bash "$SPIDER_SINGLE_TEST_RUNNER" packages/ui/src/__tests__/detail-follow.test.ts`. Expect missing reducer or failing transitions.
- [ ] **Implement** the pure reducer. Clamp to `max(0, rows.length - viewportRows)`. Preserve the original paused source anchor through rewrapping until explicit navigation selects another first row.
- [ ] **Run green.** Repeat the same single-file command. Expect following to resume only at the bottom, on End, or when viewport growth makes the remainder visible.
- [ ] **Commit** the two files with subject `feat(ui): model detail follow state`.

**Done check:** Row updates cannot jump a paused view to new output or leave its offset outside the viewport's legal range.

## Task 4: Count new assistant messages by stored identity

**Files:** Create `packages/ui/src/agents/detail-message-count.ts` and `packages/ui/src/__tests__/detail-message-count.test.ts`.

**Interfaces:** Produce `MessageCountState { seen: ReadonlySet<number>; pending: ReadonlySet<number> }`, `initialMessageCount(events: readonly StoredRunEvent[], blocks: readonly ConversationBlock[]): MessageCountState`, and `updateMessageCount(state: MessageCountState, events: readonly StoredRunEvent[], blocks: readonly ConversationBlock[], following: boolean): MessageCountState`. `seen` contains all successfully observed stored event ids, including events that produce no block. `pending` contains distinct newly observed assistant-message ids. Never update this state for a failed read.

- [ ] **Write the failing tests.** Initial history is a baseline; two subsequent distinct messages count twice.

```ts
const events = [1, 2, 3].map(id => storedEvent(id, "same"));
const blocks = [1, 2, 3].map(id => messageBlock(id, "same"));
const baseline = initialMessageCount(events.slice(0, 1), blocks.slice(0, 1));
expect(baseline.pending.size).toBe(0);
const paused = updateMessageCount(baseline, events, blocks, false);
expect([...paused.pending]).toEqual([2, 3]);
expect(updateMessageCount(paused, events, blocks, false).pending.size).toBe(2);
expect(updateMessageCount(paused, events, blocks, true).pending.size).toBe(0);
```

Add `ignores_tools_activity_empty_and_unknown_events`, `counts_timestamp_ties_and_delayed_insertions`, and `retains_count_during_partial_downward_scroll`. A new id with an older timestamp counts; an observed id that disappears and returns does not count again. An id observed before pause without a visible block does not become a new event merely because its content later changes. Width changes and theme changes leave counts unchanged. A valid duration-only assistant block counts as one event, not one row.

- [ ] **Run red.** `bash "$SPIDER_SINGLE_TEST_RUNNER" packages/ui/src/__tests__/detail-message-count.test.ts`. Expect missing functions or incorrect counts.
- [ ] **Implement** successful-snapshot set comparisons. Clear `pending` whenever following resumes, including End without a new data snapshot. Keep the baseline scoped to one detail interaction.
- [ ] **Run green.** Repeat the same single-file command. Expect event identity, not timestamps, text equality, row count, or notification count, to determine the marker.
- [ ] **Commit** the two files with subject `feat(ui): count paused detail messages by id`.

**Done check:** Duplicate notifications and rediscovered old events cannot inflate `↓ N new`.

## Task 5: Expose existing stored event ids

**Files:** Modify `packages/host/src/agents/run-source.ts`, `packages/ui/src/agents/types.ts`, `packages/ui/src/agents/store.ts`, and `packages/ui/src/index.ts`. Extend `packages/host/src/__tests__/run-source.test.ts` and `packages/ui/src/__tests__/store.test.ts`. Update stored-event fixtures in `packages/ui/src/__tests__/agent-detail.test.ts`.

**Interfaces:** Change `RunSource.listEvents?(runId: string): StoredRunEvent[]` and `AgentStore.events(runId: string): StoredRunEvent[]`. Keep `subscribe(fn: (event: RunEvent) => void)` unchanged. Export `StoredRunEvent` through the existing types export.

- [ ] **Write the failing source test** `returns_database_ids_in_timestamp_then_id_order`. Insert events at timestamps `20, 10, 10`, including two identical summaries. Assert three distinct numeric ids, chronological order `[10, 10, 20]`, and increasing ids within the tie. A second query returns the same ids. Include malformed optional JSON, which yields an undefined payload rather than a thrown read.

```ts
expect(events.map(event => event.ts)).toEqual([10, 10, 20]);
expect(new Set(events.map(event => event.id)).size).toBe(3);
expect(events[0].id).toBeLessThan(events[1].id);
expect(source.listEvents!("run").map(event => event.id)).toEqual(events.map(event => event.id));
```

- [ ] **Run source red.** `bash "$SPIDER_SINGLE_TEST_RUNNER" packages/host/src/__tests__/run-source.test.ts`. Expect missing ids.
- [ ] **Write and run the store red test** `events_preserve_source_identities_after_retention`: a finished run evicted from `snapshot()` remains readable through `getById()` and `events()`, with identical event ids. Run only `bash "$SPIDER_SINGLE_TEST_RUNNER" packages/ui/src/__tests__/store.test.ts`.
- [ ] **Implement** `SELECT id, run_id, ... ORDER BY ts ASC, id ASC` and a typed stored-row mapping. No schema or bus change. Change the event arrays in `packages/ui/src/__tests__/agent-detail.test.ts` from `RunEvent[]` to `StoredRunEvent[]` and supply synthetic ids; do not make ids optional to preserve old fixtures.
- [ ] **Run source green**, then **store green**, using the same two commands separately. Expect both complete files to pass. Then run `bash "$SPIDER_SINGLE_TEST_RUNNER" packages/ui/src/__tests__/agent-detail.test.ts` alone to check the fixture migration against the existing component.
- [ ] **Commit** explicit changed source and test paths with subject `feat(agents): expose stored conversation event ids`.

**Done check:** Persistence supplies stable identity without adding identity requirements to live invalidation events.

## Task 6: Bound AgentDetail and cache its projection

**Files:** Modify `packages/ui/src/agents/agent-detail.ts`, `packages/ui/src/index.ts`, `packages/ui/src/agents/detail-conversation.ts`, the UI fixture, and `packages/ui/src/__tests__/agent-detail.test.ts`.

**Interfaces:** Replace the store-reading constructor with `AgentDetail(runId: string, theme: ThemeAdapter, opts: { viewport: () => { safeHeight: number }; requestRender: () => void; now?: () => number })`. Add `update(read: DetailRead): void`, `updateRun(run: AgentSnapshot): void`, `scroll(delta: number): void`, `scrollAt(row: number, delta: number): void`, and `dispose(): void`. `updateRun` changes cached metadata and activity without loading events; an ended status disarms kill immediately. `scrollAt` disarms confirmation and scrolls only if the local row is in the last rendered conversation rectangle. The host consumes the wheel event either way. `DetailRead` is `{ kind: "loaded"; run: AgentSnapshot | undefined; events: readonly StoredRunEvent[] } | { kind: "failed" }`. Keep `onKill(fn: (runId: string) => void)` for the two-step action; use `onBack(fn: (target: "selector" | "chat" | "size") => void)` for completion intent. Export the component's host-facing types. `render(width)` remains the component entry point and recomputes viewport math with that authoritative width and the getter's current safe height.

- [ ] **Write the failing bounded-frame test.** Seed a 200-row conversation and a `96 x 30` viewport.

```ts
const lines = detail.render(96);
expect(lines).toHaveLength(30);
expect(lines[0]).toContain("running");
expect(lines[29]).toContain("╯");
expect(lines.slice(6, 28).join("\n")).toContain("line-199");
expect(lines.every(line => visibleWidth(line) <= 96)).toBe(true);
```

Add `header_is_always_four_rows`: model, role, thinking, turns, usage, existing cost text, elapsed time, run id, and one folded instructions line stay fixed. Reserve title-status width before truncating a long name. Assert whitespace-folded instructions use an ellipsis, missing instructions show `No instructions`, and a missing model displays `unknown` without adding rows.

Add `all_stored_content_is_scrollable`: a message longer than 60 rows, history longer than 120 rows, warnings, tool timings, and activity are reachable. Move the old warning-above-tail assertion to a warning-in-conversation assertion, not a deletion of warning coverage.

Add `keys_move_visual_rows`: Up and Down move one; PgUp and PgDn move `max(1, V - 1)`; End resumes following and clears the marker. Esc requests `selector`; Ctrl+C requests `chat`. Left, Right, and unowned text never reach an editor. Paused controls contain `↓ 0 new`, then `↓ 2 new`, without changing `V`.

Add `compact_resize_preserves_state_and_disables_kill`, `unusable_size_requests_close_once`, `failed_and_cancelled_runs_keep_history_and_actual_status`, and `empty_missing_and_failed_reads_stay_bounded`. Assert `Waiting for output`, `No recorded conversation`, `Run not found` plus captured id, `Conversation unavailable`, and last-good-history retention on a later failure. Compact frames fit exactly the available height; sizes below three rows or columns emit no frame and request safe closure once.

- [ ] **Run red.** `bash "$SPIDER_SINGLE_TEST_RUNNER" packages/ui/src/__tests__/agent-detail.test.ts`. Expect constructor and bounded-layout failures.
- [ ] **Implement** the new constructor and cached `update` path with Tasks 1 through 4. Render title, four metadata rows, divider, the padded conversation slice, controls, and bottom border. Cache wrapped blocks by event id, content, text width, and theme generation; use a stable local activity key. Ordinary renders and elapsed ticks reuse wrapped rows. `invalidate()` rebuilds styles from cached data, retaining ids, anchors, and counts. Keep basic two-press kill behavior; Task 10 completes its asynchronous lifecycle.
- [ ] **Add and run the cache test** `render_scroll_and_ticks_do_not_read_or_rewrap_history`: use source-read and wrap spies, repaint at the same width, scroll, and advance time. Expect no new reads or wraps. Width and theme invalidation rebuild the needed rows but preserve the paused source anchor and unread ids. Repeat the same single-file command until the whole file passes.
- [ ] **Commit** explicit paths with subject `feat(ui): render bounded scrollable agent details`.

**Done check:** No `AgentStore`, database access, grid wrapper, fixed tail, or clipping-based viewport remains inside `AgentDetail`. Do not add a temporary legacy constructor overload; Task 8 migrates the sole production caller.

## Task 7: Measure safe geometry before pi composes overlays

**Files:** Create `packages/host/src/agents/pi-dock-geometry.ts`, `packages/host/src/__tests__/pi-dock-geometry.test.ts`, and `packages/host/src/__tests__/fixtures/agents-tui.ts`.

**Interfaces:** Produce `installPiDockGeometry(tui: TUI, piVersion?: string): DockGeometryAdapter`, defaulting the version to public `VERSION`. The adapter exposes `read(): DockGeometry`, `track(component: Component): () => void`, `isTop(component: Component): boolean`, `onChange(fn: () => void): () => void`, and `dispose(): void`. `isTop` checks the actual last stack entry, matching pi's pop semantics, not focus order. Notify listeners when geometry or stack ownership changes; request another frame only for changed geometry. `DockGeometry` is `{ kind: "ready"; width: number; safeHeight: number; frameRows: number; origin: "terminal" | "base-document" } | { kind: "unavailable"; reason: string }`. `track` identifies only the agents selector and detail components for regular-mode composition ownership. Resolve the actual renderer from a raw instance or the inspected forwarding reference before installing wrappers. The UI receives only the resulting viewport, never this adapter.

- [ ] **Write the failing fake-terminal tests** with real public `TuiAltScreen`, `TuiMainScreen`, `Container`, and `VStack` instances. Define `agentsTuiFixture(mode: "regular" | "fullscreen", opts: { columns: number; rows: number; documentRows: number; dockRows: number })` in the fixture; it owns `geometry`, `detailRows()`, `markerPositions()`, `growEditorBy(rows)`, `renderBaseFrame()`, `lastDetailHeight()`, and `dispose()`. Build the exact inspected root structure, a fake terminal with mutable dimensions and captured writes, and recognizable markers for every dock section. Record text-screen positions, including cursor movement, erase, CR/LF, and scrolling emitted by these renderers. No pi process or real terminal starts.

```ts
expect(fullscreen.geometry.read()).toMatchObject({ kind: "ready", width: 120, safeHeight: 30, frameRows: 40 });
expect(fullscreen.detailRows()).toHaveLength(30);
expect(fullscreen.detailRows().every(line => visibleWidth(line) === 96)).toBe(true);
expect(fullscreen.markerPositions()).toEqual(beforeOpen);
fullscreen.growEditorBy(3);
fullscreen.renderBaseFrame();
expect(fullscreen.lastDetailHeight()).toBe(27);
expect(fullscreen.geometry.read()).toMatchObject({ safeHeight: 27 });
```

Add `publishes_same_frame_dock_growth_before_detail_render`: the detail render spy sees height 27 on that composition, and one normal repaint request follows the changed measurement. An unchanged frame schedules none. Include pending messages, status, widgets on both sides, a multiline editor, footer spacing, and terminal resize.

Add `short_regular_document_never_grows_for_overlay`: with a 40-row terminal, 16 base rows, and a ten-row dock, use six safe rows and compact presentation. Compare base row count and all dock marker positions before, during, and after. Repeat with a long regular transcript, a short document after a previously long frame, narrow widths, and a retained transcript scroll position.

Add `rejects_unknown_version_shape_and_unrelated_overlay`: versions `0.0.0` and `1.2.1`, missing roots, altered entry sizing, a changed regular child order or count, and incompatible methods return unavailable. With an unrelated visible overlay, do not shorten its compositor frame. Add `restores_only_owned_wrappers_on_dispose`: repeated disposal is harmless, and a wrapper installed later by another owner is never overwritten. Add `accepts_forwarding_reference_and_rebinds_after_mode_switch`: pass the inspected proxy behavior, assert raw receiver ownership and exact method restoration, then reopen after replacing the renderer. Do not rely on proxy method reference equality.

- [ ] **Run red.** `bash "$SPIDER_SINGLE_TEST_RUNNER" packages/host/src/__tests__/pi-dock-geometry.test.ts`. Expect missing adapter or current-frame and short-document failures.
- [ ] **Implement** the exact typed compatibility adapter described in the evidence section. Narrow unknown objects with runtime guards before private reads, including the forwarding reference's receiver. Capture base-render measurements, publish before overlay rendering, and reject stale or absent measurements for the current width and frame. Validate the seven regular children against the canonical fullscreen dock ordering when that root is available, and retain their identities; a remount requires revalidation. Bound zero-height frames without calling a percentage compositor with height zero. Wrap methods only on this TUI and restore them only if still owned. If a later wrapper retains one of ours, make the disposed wrapper an inert passthrough. Do not change global prototypes or `Terminal.start`.
- [ ] **Run green.** Repeat the same single-file command. Expect dock marker positions and base document height to remain unchanged in both modes. Keep both modes in this unit-test file, not an e2e suite.
- [ ] **Commit** the three files with subject `feat(host): adapt pi dock geometry for agent details`.

**Done check:** The adapter names the supported version, never reads a previous frame as current geometry, and handles a short regular document without adding blank rows.

## Task 8: Open one real detail and remove footer detail rendering

**Files:** Modify `packages/host/src/agents/agents-ui.ts` and `packages/host/src/__tests__/agents-ui.test.ts`. Extend the fake-terminal fixture from Task 7.

**Interfaces:** Retain one `RunSource` instance for `AgentStore` and the detail. Simplify `SelectorController` to `moveSelect`, `drill`, `close(reason: "escape" | "interrupt")`, and `repaint`; remove `isDrilled`, `closeDetail`, and `forwardToDetail`. Keep separate selector and detail completion callbacks with explicit `opening`, `open`, and `closed` states. Queue completion intent while opening; invoke `done` only after that interaction's `onHandle` confirms it mounted and `geometry.isTop(component)` is true. Otherwise pi can pop the parent or an unrelated dialog instead. Recheck queued intent outside rendering when adapter ownership notifications arrive. The host wraps the detail in a pi `Component` that exposes `handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined`, without changing the shared UI `Component` interface.

- [ ] **Replace the failing legacy footer-detail assertion** with `enter_opens_real_detail_without_changing_footer_rows`. Capture the selected id, send Enter twice, and assert exactly one second `ui.custom` call. Its component, not the footer, renders the frame; its options match the global constraints. Footer row count and editor and footer screen positions match their pre-detail values. Reordering the run list does not change the opened run.

```ts
expect(ui.custom).toHaveBeenCalledTimes(2);
expect(footer.render(120)).toHaveLength(beforeFooterRows);
expect(detailOptions).toMatchObject({
	overlay: true,
	overlayOptions: { anchor: "top-center", width: "80%", minWidth: 24, maxHeight: "100%" },
});
```

- [ ] **Add the failing lifetime tests** `esc_closes_detail_then_selector`, `ctrl_c_closes_top_first`, `empty_list_waits_for_retained_detail`, and `shutdown_closes_top_first_once`. Exercise the installed `InteractiveMode.prototype.showExtensionCustom` lifecycle against the fake terminal, not a mock that removes a handle-specific overlay. The first Esc restores selector focus, the next restores editor text and cursor. Let a finished run leave the list; keep its stored conversation readable, then close the empty selector only after detail completion. Repeated open commands cannot stack selectors either. Add `escape_during_opening_does_not_pop_parent`: hold the detail's `onHandle`, send Esc, and assert neither parent completion nor premature `done`; when the handle arrives, close only that child. Ctrl+C or shutdown during the same window queues child closure followed by parent closure. Add `foreign_top_overlay_is_not_popped_by_queued_completion`: defer our completion until that overlay's own owner closes it.
- [ ] **Add mouse and geometry failure tests.** Through pi's delivered wheel path and `detail.scrollAt(event.y, event.wheelDelta ?? 0)`, a delta of `-3` over conversation rows moves exactly three rows; a positive delta moves down once. Wheel inside the frame but outside conversation is consumed without moving either conversation or underlying chat. Do not capture drag sequences. A regular terminal delivering no wheel events still supports all keys. Unavailable geometry notifies without opening a focused detail. Geometry becoming unusable closes detail once and returns focus safely.
- [ ] **Run red.** `bash "$SPIDER_SINGLE_TEST_RUNNER" packages/host/src/__tests__/agents-ui.test.ts`. Expect the old footer composition, forwarding, and nested-lifetime assertions to fail.
- [ ] **Implement** the captured-id detail custom interaction and its initial cached snapshot. Install or reuse the adapter before selector composition, track both actual wrapper components, and retain adapter ownership beyond footer unmount while a detail is open. Focus each interaction only in its `onHandle`; data or geometry updates never focus again. Convert unavailable geometry or unusable resize into one completion and notification outside the render call. Keep initial kill unavailable until Task 10 connects actions.
- [ ] **Delete** the footer's shared detail reference, prepended detail rows, spacer, selector detail-key forwarding, and forced repaint used only to clear collapsed detail rows. The widget returns only `AgentFooter.render(width)`. Use ordinary repaints for selection; retain unrelated cleanup. On shutdown, mark the owner disposed immediately, prevent new interactions, and queue child completion before parent completion, including a custom factory still opening. Release subscriptions, timers, the footer widget, and the store without waiting for a foreign dialog to release the top position; cached views need no live store while their queued completion finishes. If the factory rejects, clear opening state without calling a parent-popping completion. Esc received by the selector during child opening cancels only the child intent; Ctrl+C requests both. No detail-input forwarding returns.
- [ ] **Run green.** Repeat the same single-file command. Expect all selector registration, disabled-footer, empty-list, focus, and new lifetime cases to pass.
- [ ] **Commit** explicit paths with subject `feat(host): open agent details in a real overlay`.

**Done check:** There is one visible detail path, one captured run id, and no detail-driven change to dock height. No completion removes an overlay beneath a still-open detail.

## Task 9: Refresh cached detail data at most every 100 milliseconds

**Files:** Create `packages/host/src/agents/detail-refresh.ts` and `packages/host/src/__tests__/detail-refresh.test.ts`. Modify `packages/host/src/agents/agents-ui.ts` and its test file. Reuse the existing `FrameScheduler` from `packages/ui/src/agents/coalesce.ts` without changing its defaults for other callers.

**Interfaces:** Produce `startDetailRefresh(opts: { source: RunSource; store: AgentStore; runId: string; apply: (read: DetailRead) => void; applyRun: (run: AgentSnapshot) => void; requestRender: () => void; formatRunCost?: RunCostFormatter }): () => void`. It loads once synchronously, then uses a private `FrameScheduler` with `frameMs: 100`. The returned disposer is idempotent. Project authoritative `source.getRun` rows with `projectRow`; merge cached activity from the selected store snapshot and use the existing cost formatter. Read authoritative stored events, not bus payloads.

- [ ] **Write the failing scheduling test** with fake time and source spies. Use a passive store fixture to count this controller's storage reads independently of the store's existing ingest reads. After the one initial read, emit selected-run events at `0, 10, 99` milliseconds. Assert no refresh before 100, then one selected-row and one event query at 100. Emit another event at 150; assert one trailing refresh at 250, and no further work. Duplicate bus notifications cannot increase the component's message count. Events for another run do not read this history.

```ts
// After the described timeline reaches 250 milliseconds:
expect(readTimes).toEqual([0, 100, 250]);
expect(source.getRun).toHaveBeenCalledTimes(3);
expect(source.listEvents).toHaveBeenCalledTimes(3);
```

- [ ] **Add** `metadata_and_retention_changes_are_observed`: store changes call `applyRun` immediately for a changed selected cached snapshot, without switching run id or querying history. Assert that completion disarms confirmation before the 100-millisecond data timer fires. A selected snapshot identity change may also request the coalesced authoritative refresh; unrelated store changes may repaint but must not requery its history. Retention eviction schedules a read without clearing the last cached run. Cost invalidation remains in the source before reads.
- [ ] **Add** `failed_reads_keep_last_good_state_and_recover`: an initial failure applies `failed`; a later failure preserves conversation, anchor, unread ids, and Esc while displaying data unavailability in the fixed controls. A subsequent successful source-driven refresh clears the error and compares against the last successful snapshot, not the failed read. A missing first run applies the bounded missing state.
- [ ] **Add** `navigation_and_elapsed_repaints_do_not_wait_for_data`: scrolling, resize, completion, and confirmation request a frame immediately, even while the refresh timer is pending. Reuse the existing 100-millisecond footer ticker for elapsed display; do not create another interval. Add `dispose_cancels_trailing_refresh_and_subscriptions`, including disposal from inside `apply` and a late queued invalidation.
- [ ] **Run red.** `bash "$SPIDER_SINGLE_TEST_RUNNER" packages/host/src/__tests__/detail-refresh.test.ts`. Expect missing controller or incorrect query timing.
- [ ] **Implement** the controller and replace Task 8's direct initial load with it. Subscribe to matching source events, observe selected store snapshot identity and availability, apply cached metadata immediately, and schedule one coalesced trailing load. Catch reads outside rendering and apply only complete successful snapshots. Tie its disposer to the detail interaction, including opening failures and session shutdown.
- [ ] **Run green.** Repeat the refresh test command. Then run `bash "$SPIDER_SINGLE_TEST_RUNNER" packages/host/src/__tests__/agents-ui.test.ts` separately to verify host disposal and shared-source ownership.
- [ ] **Commit** explicit paths with subject `feat(agents): coalesce live detail refreshes`.

**Done check:** Source-driven updates remain live without a polling loop. Render, navigation, and ticker paths do not read storage, append bus events, or rewrap unchanged history.

## Task 10: Complete the two-step asynchronous kill flow

**Files:** Modify `packages/ui/src/agents/agent-detail.ts`, `packages/host/src/agents/agents-ui.ts`, `packages/ui/src/__tests__/agent-detail.test.ts`, and `packages/host/src/__tests__/agents-ui.test.ts`.

**Interfaces:** Add `AgentDetail.setKillPending(): void` and `AgentDetail.setKillError(message: string): void`. Existing `onKill` emits one request for the captured id; the host owns the action promise and maps its result to close, inline error, or a late notification. Keep `idle`, `armed` with deadline, `pending`, and `failed` states distinct. Missing action, ended or missing run, and compact mode are unavailable states, not armed states. Also disable arming when the full confirmation, the current marker, and `Esc` cannot fit the control row after removing other hints.

- [ ] **Write the failing component tests** using a fake clock. First `k` shows `k again to kill` and submits nothing. A second at 2999 milliseconds submits once; at 3001 it only arms a new confirmation. At exactly 3000 milliseconds the first confirmation is expired. A non-`k` key, wheel scroll, completion, disposal, or the one-shot expiry disarms; a live data update does not confirm. A control-row marker and confirmation remain readable by shortening hints first, and neither changes conversation height. Add `narrow_controls_disable_unshowable_confirmation`: at width 24 while paused with `↓ 2 new`, retain the marker and Esc but do not arm an unshowable confirmation. A following view with enough control width may still arm.

```ts
detail.handleInput("k");
expect(kill).not.toHaveBeenCalled();
expect(detail.render(96).join("\n")).toContain("k again to kill");
vi.advanceTimersByTime(2999);
detail.handleInput("k");
expect(kill).toHaveBeenCalledExactlyOnceWith(capturedRunId);
```

- [ ] **Add** `pending_ignores_further_kill_presses`: show `Stopping`, ignore repeated `k`, retain Esc, and keep the original run id after list reorder. Unavailable or completed runs never arm. After a failure, display a short error and require two fresh presses for retry. A normal viewport becoming compact disarms confirmation and disables kill.
- [ ] **Run component red.** `bash "$SPIDER_SINGLE_TEST_RUNNER" packages/ui/src/__tests__/agent-detail.test.ts`. Expect pending, expiry, or availability failures.
- [ ] **Write and run host red tests** for resolving, rejecting, and synchronously throwing kill actions. Success closes only the live detail. Failure keeps it open with an error. Esc while pending closes immediately; a later rejection calls `ui.notify` once, and neither rejection nor success can recreate the overlay or refocus it. Run only `bash "$SPIDER_SINGLE_TEST_RUNNER" packages/host/src/__tests__/agents-ui.test.ts`.
- [ ] **Implement** the one-shot arm deadline in the component and the guarded async submission in the host. Transition to pending before calling the action, catch synchronous and asynchronous failure, and clear the arm timer on every disarm and disposal. Do not cancel an already submitted action when Esc closes the view. Do not wait for a data-refresh timer to repaint confirmation, pending state, or an error.
- [ ] **Run component green**, then **host green**, using the two commands separately. Expect the full files to pass with no live timers or callbacks that can reopen a disposed interaction.
- [ ] **Commit** the four explicit paths with subject `feat(agents): preserve safe kill flow in detail overlays`.

**Done check:** Two fresh presses submit exactly one action; lifecycle cleanup cannot undo that action or let its late result take back focus.

## Final document and implementation checks

- Confirm each spec section is owned by a task above. Geometry decisions belong to Task 7, lifetime and footer removal to Task 8, live data to Task 9, and destructive action handling to Task 10.
- Inspect the final diff for private pi reads outside the adapter, legacy detail rendering, forced detail-collapse repaints, and any source reads from rendering.
- Re-run changed unit-test files only through the single-file commands above, one at a time. Full typecheck, build, and the complete test suite belong to CI, not this machine.
- Keep this planning change documentation-only. The commands above are instructions for later implementation, not evidence that tests have run.

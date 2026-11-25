# Agents run detail overlay design

Date: 2026-11-24

## Purpose and scope

The run detail lets you read a live run without losing your place in the chat. The detail floats over the chat. Opening it does not add rows above the input box or change the footer's layout.

The approved behavior is:

- A framed overlay uses about 80% of the terminal width.
- Its height uses the terminal rows that remain above the input box and footer.
- The top border contains the run name and status.
- A fixed header shows the model, token usage, elapsed time, run id, and one folded instructions line.
- The conversation fills the remaining space and scrolls independently.
- New messages follow the bottom until you scroll back. A `↓ N new` marker appears while following is paused.
- End, or a scroll that reaches the bottom, resumes following.
- Esc closes the detail and returns to the run list. The existing two-step `k` action stays.
- Both regular and fullscreen `tuiMode` use the same detail component. Mouse input depends on what pi delivers.

The run list, its navigation, and the footer's visual design stay unchanged. This design does not add a transcript search, an instructions editor, horizontal scrolling, or a new event producer. It does not recover content that was never stored.

This document defines the component behavior. Exact chat-area measurement remains an integration question in the final section. No implementation or test execution is part of this document.

## Current architecture and overflow

Repository paths below are relative to the repository root. `pi/` identifies the installed `@earendil-works/pi-coding-agent` package. `tui/` identifies its bundled `@earendil-works/pi-tui` package.

### The footer renders the visible detail

`installAgentsUI` owns an `AgentStore`, a footer widget, and the current `AgentDetail`. The footer widget prepends the entire detail to its own rows. It uses `placement: "aboveEditor"`. See `packages/host/src/agents/agents-ui.ts:113-140`.

The apparent overlay is an empty, focused key sink. Its declared width and maximum height are both one cell. The selector forwards detail keys to the shared detail instance. See `packages/host/src/agents/agents-ui.ts:85-104` and `packages/host/src/agents/agents-ui.ts:151-198`.

The detail therefore enlarges the input dock rather than floating over the chat. Fullscreen pi places above-editor widgets in that dock, beside the editor and footer. See `pi/dist/modes/interactive/chat-viewport.js:3-25`.

### Width limits do not bound height

`AgentDetail.render(width)` has no height input. It renders metadata, instructions, messages, tool events, controls, and a frame. Instructions can occupy eight rows. The conversation keeps its last 120 rows, but those rows still exceed many terminal heights. There is no scroll offset. See `packages/ui/src/agents/agent-detail.ts:51-114`.

The current input handler owns Esc and the three-second, two-step kill action. It has no scroll keys. See `packages/ui/src/agents/agent-detail.ts:10` and `packages/ui/src/agents/agent-detail.ts:29-44`.

The current text wrapper also collapses whitespace and clips long words. It cannot preserve a conversation's paragraphs or wrap a long unbroken line into readable rows. See `packages/ui/src/agents/grid-cell.ts:16-28`.

### Pi does not scroll an oversized overlay

Pi components render rows for a width. Terminal rows and columns are available through `tui.terminal`. Overlay options provide width and `maxHeight`, not a fixed height. See `tui/dist/tui.d.ts:68-78`, `tui/dist/tui.d.ts:139-165`, and `tui/dist/terminal.d.ts:31-33`.

The overlay compositor calls `render(width)` directly. If the result exceeds `maxHeight`, it keeps the first rows with `slice(0, maxHeight)`. The bottom border and controls can disappear. See `tui/dist/tui.js:959-985`.

`ScrollView` supports following and scrolling, but its viewport comes from pi's layout engine. Ordinary `ScrollView.render` returns its child's rows. Placing it inside this overlay does not assign a height. See `tui/dist/components/scroll-view.d.ts:36-57` and `tui/dist/components/scroll-view.js:186-189`.

Pi's overlay example owns an offset and slices visible rows itself. That is the selected approach here. Its unconditional jump on new output is not copied. This detail follows only while its follow state allows it. See `pi/examples/extensions/overlay-qa-tests.ts:464-465`, `pi/examples/extensions/overlay-qa-tests.ts:517-518`, and `pi/examples/extensions/overlay-qa-tests.ts:540-575`.

## Component structure

### The host owns overlay lifetime

`packages/host/src/agents/agents-ui.ts` keeps the existing selector interaction. Enter captures the selected run id and opens a second `ctx.ui.custom` interaction with `overlay: true`.

That second interaction renders the actual detail. The selector's one-cell key sink remains behind it only to preserve the unchanged list interaction. It no longer forwards detail input or causes the footer to render detail rows.

The host supplies:

- The selected run id and the existing run source.
- A cached run snapshot and stored conversation events.
- The active theme and a clock.
- Current terminal dimensions and measured chat-area bounds.
- Completion, repaint, and kill callbacks.

Only one detail interaction can open at a time. Repeated Enter events cannot stack copies. The detail remains bound to its captured run id even if the run list changes order.

### The detail owns presentation and scroll state

`packages/ui/src/agents/agent-detail.ts` becomes a bounded detail view. It receives its height budget through a host-supplied viewport getter. It does not start a terminal, query the database during rendering, or inspect pi's component tree.

The detail separates four outputs:

1. The title border with the run name and status.
2. A fixed metadata header.
3. Wrapped conversation rows with stable source positions.
4. A fixed control row and bottom border.

Small pure helpers calculate the viewport, wrap event blocks, clamp the offset, and apply follow-state transitions. No general layout framework is needed.

The host adapter implements pi's `handleMouse` contract and forwards normalized wheel changes to the detail. The shared UI component interface does not need a repository-wide mouse API change.

### Focus and completion

The detail overlay captures focus when it opens. The overlay handle can explicitly focus it once through `onHandle`. Ordinary data updates never call `focus()` again. The read-only detail needs no editor cursor.

Esc calls the detail's completion callback. Pi disposes that interaction and restores focus to the selector. A second Esc closes the selector and returns to the chat. Ctrl+C closes the detail first, then the selector, without killing the run.

A component created by `ctx.ui.custom` closes through its completion callback, not `OverlayHandle.hide()`. See `pi/docs/tui.md`, section "Use custom screens and overlays".

Close nested interactions in top-first order. The installed custom-UI completion path removes the top overlay rather than a handle-specific overlay. See `pi/dist/modes/interactive/interactive-mode.js:2324-2374`.

The selector's current empty-list callback must not close its interaction while a detail is above it. A completed run remains readable after list retention expires. Once the detail closes, an empty selector closes normally. Existing `AgentStore.getById` can read an evicted run from storage. See `packages/host/src/agents/agents-ui.ts:162-164` and `packages/ui/src/agents/store.ts:96-106`.

## Terminal geometry and resize

### Required geometry input

A host-only geometry provider returns the safe chat rectangle for the current terminal frame. This is a proposed dependency, not an installed pi API.

The rectangle excludes the whole input dock. That includes the agent list, other dock widgets, pending-message and status rows, the input box, and the application footer. Measuring only the agent list is insufficient. A fixed assumption about editor height is also insufficient.

For a bottom-aligned dock, define:

- `R` as the terminal row count.
- `C` as the terminal column count.
- `D` as the measured dock height, including its spacing.
- `H = max(0, R - D)` as the detail's outer height.
- `W = min(C, max(24, floor(0.8 * C)))` as its outer width.

The normal rectangle starts at terminal row zero. Its bottom edge ends immediately above the dock. The overlay is horizontally centered.

The host uses `anchor: "top-center"`, `width: "80%"`, `minWidth: 24`, and `maxHeight: "100%"`. The component itself returns exactly `H` rows. The maximum is a safety bound, not a scrolling mechanism. The width passed to `render` is authoritative after pi clamps it to the terminal.

If a measured rectangle has another origin, the geometry integration must also supply matching overlay placement. It must not pretend that the rectangle begins at row zero.

Pi's options callback is not treated as a per-frame resize callback. The installed host resolves it when opening the overlay. See `pi/dist/modes/interactive/interactive-mode.js:2361-2372`.

### Fixed rows and conversation rows

The normal layout has eight fixed rows:

- One top border.
- Four metadata rows.
- One divider.
- One control row.
- One bottom border.

The metadata rows contain:

1. Model, role, thinking level, and turn count.
2. Token usage, existing cost information, and elapsed time.
3. Run id.
4. Instructions, with whitespace folded into spaces and an ellipsis at the right edge.

Each metadata row stays one visual row. Missing values use plain labels such as `unknown` or `no instructions`. Status text stays in the title border. Reserve its width first, then truncate the run name to fit. Neither the title nor the status wraps. The existing semantic colors and frame remain.

The conversation height is `V = H - 8`. The conversation has two border columns and one padding column on each side. Its text width is `max(1, W - 4)`.

The renderer wraps conversation blocks first. It then takes `rows.slice(offset, offset + V)` and pads any remaining conversation rows. Borders, metadata, and controls are never part of that slice. Every output row fits the overlay width.

Warnings that currently expand the header move into the conversation as event blocks. Timing rows and current activity remain visible there. They do not enlarge the fixed header.

### Resize behavior

Pi already requests a render on terminal resize. See `tui/dist/tui.js:569-579`. The extension does not replace `Terminal.start`, attach another terminal owner, or write cursor-control sequences.

Each render reads the current dimensions and the geometry provider's current measurement. A height change recalculates `V`. A width change also rebuilds wrapped conversation rows.

While following, resize keeps the last conversation row visible. While paused, resize preserves the first visible source position. The anchor contains a stored event id and a position in that event's text, not an old wrapped-row number. The new row map resolves that anchor after wrapping.

If the anchored event disappears, use the nearest surviving event and clamp the offset. If the result reaches the bottom, resume following. A change to the editor or another dock widget triggers the same geometry calculation even when terminal dimensions stay unchanged.

If `W < 24` or `H < 9`, show a bounded compact frame that asks for a larger terminal. Keep Esc available and retain scroll state. Disable kill while the confirmation cannot be shown clearly. If even a three-row frame cannot fit, close the detail safely and report the size limit. Never retain an invisible detail that owns focus.

## Conversation rows and follow state

### Stable events and complete wrapping

Keep stored events in their current chronological order, by `ts` and then database `id`. The query already uses that order but does not return the id. See `packages/host/src/agents/run-source.ts:12-13` and `packages/host/src/agents/run-source.ts:33-42`.

Expose that existing id in a stored-event read type used by `RunSource.listEvents` and `AgentStore.events`. Keep it separate from the live bus event type. Bus events are invalidation signals, so they do not need a database id. No schema change is needed.

Use the id for anchors and new-message counts. Two messages with identical text and timestamps are still separate events.

Conversation blocks preserve assistant prose, tool calls, tool results, handoffs, timing, and relevant warnings. Keep line breaks and indentation. Use pi's ANSI-aware wrapping and visible-width helpers. Split long unbroken text across rows without breaking wide glyphs or combining characters. Reapply styles on each output row.

Remove the 120-row tail and the per-message 60-row display cap. Scrolling reaches all stored content for the selected run. Tool summaries remain summaries if that is all the source recorded. A synthetic activity row has a stable local key and never counts as a new message.

### State transitions

Let `L` be the wrapped conversation row count and `maxOffset = max(0, L - V)`. The offset is always between zero and `maxOffset`.

The detail has two follow states:

- `following` sets `offset = maxOffset` after every content or viewport update.
- `paused` keeps the current source anchor and a set of new assistant-message ids.

A new detail starts in `following`. Loading its existing history does not count as new output.

An upward scroll that moves away from the bottom enters `paused`. Further updates keep the same first visible source position. Downward scrolling stays paused until it reaches `maxOffset`.

End always enters `following`, moves to `maxOffset`, and clears the new-message set. A scroll that reaches the bottom has the same result. If a larger viewport makes all remaining content visible, it also resumes following. A scroll request that cannot move away from the bottom does not pause following.

### New-message counting

`N` counts distinct stored assistant `message` events added since following paused. Count a message only if it contributes a conversation block. Count events, not wrapped rows, tokens, tool calls, or render requests.

The detail compares event identities between successful data snapshots. It does not count initial history or duplicate notifications. Timestamp ties, repeated text, and width changes cannot change `N`.

While paused, the fixed control row contains `↓ N new`, including zero. The count remains until following resumes. Partial downward scrolling does not clear it. Tool-only updates can change the conversation without increasing `N`.

The marker shares an already reserved row with the controls. Appearing, disappearing, and changing digit count do not alter `V`. At narrow widths, shorten key hints before shortening the marker or kill confirmation.

## Keyboard, mouse, and kill behavior

Use `matchesKey` and `Key` rather than raw escape-sequence comparisons.

- Up moves one visual row toward the start.
- Down moves one visual row toward the end.
- PgUp moves up by `max(1, V - 1)` rows.
- PgDn moves down by the same amount.
- End resumes following at the bottom.
- Esc closes the detail and returns to the selector.
- Ctrl+C closes both interactions and returns to the chat.
- Lowercase `k` retains the two-step kill action.

Left and Right do not scroll horizontally. Unowned text does not enter the chat editor while the detail owns focus.

`handleMouse` accepts normalized `wheel` events. Negative `wheelDelta` values scroll up. Positive values scroll down. Apply the supplied logical delta once. Do not multiply a delta that pi has already adjusted.

Only wheel events over the conversation change its offset. Consume wheel events elsewhere inside the frame without scrolling the chat underneath. Mouse input outside the overlay follows pi's routing. The detail does not capture drag sequences or enable terminal mouse reporting.

The first `k` arms kill for three seconds. The fixed control row shows `k again to kill`. A second `k` within that interval submits exactly one action for the captured run id. Any other key or wheel scroll disarms it. Time expiry, run completion, and disposal also disarm it. Live data updates do not confirm it.

While the kill request is pending, show `Stopping` and ignore further kill presses. On success, close the detail and return to the selector. On failure, keep the detail open and show a short error. A retry requires two fresh presses. If kill is unavailable or the run has already ended, show that state instead of arming.

Esc remains available during a pending request. It closes the detail but does not undo a submitted kill. A later failure uses the host notification path if the detail has already closed. No late callback can recreate the overlay.

## Live data and repaint limits

The current run source reads run rows and chronological event rows from storage. Its bus subscription filters events by session. Usage events invalidate cached costs before consumers read the row. See `packages/host/src/agents/run-source.ts:8-52`.

The current store ingests events and notifies listeners. Its event-history accessor delegates to the source. See `packages/ui/src/agents/store.ts:121-128` and `packages/ui/src/agents/store.ts:135-166`.

The host retains one run-source instance for the store and the detail interaction. While the detail is open:

1. Load its initial snapshot and event history once.
2. Subscribe to source events for the captured run id. Mark conversation data dirty when that run changes.
3. Observe store changes for metadata and availability changes.
4. Coalesce data refreshes into at most one refresh per 100 milliseconds. Keep one trailing refresh so the last update is not lost.
5. Read the selected run and its stored events, update the cached projection, and request a render.

The bus notification is not appended directly to the conversation. The stored-event query supplies authoritative identities and ordering. The existing source remains responsible for delivering changes. This design adds no database polling loop or direct provider subscription.

Assistant prose appears when the existing reporter records a completed message. Tool events and activity update as those events arrive. This design does not promise token-by-token prose.

Rendering, scrolling, and elapsed-time ticks use the cached projection. They do not query or rewrap unchanged history. Cache wrapped blocks by event identity, content, text width, and theme generation. A theme invalidation rebuilds styled rows but preserves event identities and follow state.

The existing footer ticker runs every 100 milliseconds while agents run. Reuse its TUI repaint opportunity for elapsed time rather than starting another animation loop. See `packages/host/src/agents/agents-ui.ts:58-63`.

Call normal `tui.requestRender()` after state changes. Pi coalesces requests and applies its own render interval. Do not force a full redraw for every event. See `tui/dist/tui.js:630-684`.

Keyboard navigation, resize, completion, and kill confirmation request the next available frame without waiting for the data-refresh timer. A separate one-shot deadline can clear the kill prompt. Disposal cancels that deadline, pending refresh work, and detail subscriptions. Session shutdown closes the detail before the selector and stops the store through the existing owner.

## Removed behavior

The footer widget renders only `AgentFooter`. Remove its shared detail reference, the detail rows prepended to the footer, and the spacer between those outputs.

Remove the selector's detail-input forwarding once the real detail overlay owns those keys. Keep the selector's list navigation and footer selection cursor.

Remove the forced footer repaint that exists to clear rows freed by detail collapse. Detail open and close no longer change widget height. Keep any unrelated footer cleanup behavior.

Remove the detail's fixed conversation tail and reliance on overlay clipping. The new row slice is the only viewport limit. Do not keep a second footer-based detail path.

## Empty, failed, and unavailable states

An active run with no conversation shows `Waiting for output` inside the conversation area. A finished empty run shows `No recorded conversation`. Both retain the header, frame, controls, and valid zero offset.

A missing task shows `No instructions` on the folded instructions line. Missing model or usage fields do not add rows or prevent navigation.

If a selected run disappears before the first load, show `Run not found`, its captured id, and Esc. Disable kill. List retention alone is not treated as deletion.

A failed or cancelled run keeps its stored conversation. The title displays its actual status. It never follows a different run automatically.

If a source read fails after a successful load, keep the last successful conversation and show a data-unavailable message in the fixed control area. Keep the marker and Esc available. Clear the message on the next successful source-driven refresh. If the first load fails, show `Conversation unavailable` in the empty conversation area. Do not throw from `render`.

Malformed optional payload fields do not break a block. Omit invalid timing or optional metadata. Unrecognized event types do not create blank counted messages.

If the host cannot establish safe geometry, keep the selector visible, explain that the detail cannot fit safely, and do not open a focused detail. This is an integration failure, not a reason to cover the input box.

## Regular and fullscreen behavior

Both modes use the same row slicing, follow states, keys, and detail lifetime. Neither mode replaces the editor or inserts detail rows into the dock.

Fullscreen supplies normalized mouse events. Regular mode normally leaves wheel input to terminal scrollback. Keyboard scrolling is always available. Handle mouse events in regular mode only if pi actually delivers them. Do not install a raw-input workaround.

Fullscreen has an explicit transcript viewport and input dock. Regular mode uses main-screen output and terminal scrollback. Its short-document geometry needs separate proof. The current compositor pads its working output to at least the terminal height. See `tui/dist/tui.js:999-1010` and `tui/dist/tui-main-screen.js:228-234`.

Opening the detail must not add blank rows to the base document, shift the input box, or hide footer rows. Closing restores the underlying chat and its scroll position through pi's overlay lifecycle. Terminal resize can naturally change the host layout. The detail only adapts to that layout.

## Test plan

These are planned behavioral checks, not tests run for this document.

Use fake terminals with controllable rows, columns, resize callbacks, and captured output. Use both pi renderer modes, a fake clock, a fake run source with stable event ids, and a kill-action spy. Mark the input box and footer with recognizable text. Compare their screen positions before, during, and after the detail interaction.

- Sizing. At 120 columns and 40 rows with a ten-row dock, the overlay is 96 columns wide and 30 rows tall. The conversation has 22 rows. Both borders and all dock markers remain visible.
- Dock changes. Increase input height or add another dock widget without changing terminal dimensions. The overlay shrinks to the new safe rectangle. Opening a longer conversation never changes dock height.
- Follow. Open with history longer than the viewport. The last row is visible. Append several messages and confirm that the last new row remains visible.
- Scroll back. Send Up, PgUp, and a delivered wheel-up event. Confirm visual-row movement, a stable first visible source position, and paused following. New output must not jump the view.
- Marker. Append two distinct assistant messages while paused. Show `↓ 2 new`. Duplicate notifications, clock ticks, tool events, and rewrapping leave that count unchanged. Identical message text with different ids counts twice.
- Resume. End clears the marker and shows the latest row. Down, PgDn, and wheel-down also resume when they reach the bottom. The next message follows normally.
- Scroll limits. Repeated scrolling clamps at each end. Scrolling up when the entire conversation fits does not create a false paused state.
- Resize. Narrow and widen the terminal while paused. Preserve the same event and text position. Resize while following and keep the latest row visible. Confirm that row counts and borders fit after every resize.
- Esc and focus. Esc disposes only the detail and restores the selector. The next Esc restores the editor with its text intact. Ctrl+C closes in top-first order. Input cannot remain captured after disposal.
- Retention. Let the selected run finish and leave the list while detail remains open. Its conversation stays readable. Closing it also closes an empty selector.
- Kill. One `k` sends no action. Two within three seconds send one action for the captured id. Expiry, another key, and wheel scrolling require a fresh pair. Cover pending, success, failure, unavailable action, completed run, and Esc during a pending request.
- Long text. Use multiline prose, indentation, long unbroken text, ANSI styling, wide characters, and combining characters. All text remains reachable by vertical scrolling. No rendered row exceeds the declared width.
- Empty run. Exercise active and finished runs with no events, missing optional fields, and a missing run. Offsets stay valid, and Esc stays usable.
- Data failure. Fail the first read and a later read. Keep either the bounded error state or the last good conversation. A later source event can restore fresh content without losing the paused anchor.
- Scheduling. Deliver an event burst with fake time. Confirm one data refresh per 100-millisecond interval and a final trailing refresh. Navigation does not wait for that timer. Closing cancels later callbacks.
- Mode parity. Repeat sizing, focus, and close checks in regular and fullscreen modes. Include a short regular transcript and a multiline input. Inject a wheel event only through pi's delivery path. Absent mouse events cannot disable the keys.
- Small terminal. Enter and leave compact mode through resize. No output exceeds the safe rectangle. An unusable rectangle releases detail focus instead of creating an invisible interaction.

## Decisions on integration questions

Decided 2026-11-24.

1. **Chat-area bounds come from an isolated, typed compatibility adapter.** The adapter reads the input dock's current height from pi's fullscreen layout. It checks the installed pi version and the shape it reads. When either check fails, it reports that the geometry is unavailable, and the host follows the "cannot establish safe geometry" state above. The detail component never guesses geometry. A public pi measurement API can replace the adapter later without changing the component.
2. **Regular mode may use a shorter overlay.** When pi's main-screen layout cannot give the full height without moving the input box, the overlay takes the largest height that keeps the input box and footer in place, down to the compact frame. Fullscreen behavior is unchanged.
3. **The adapter publishes dock changes before composition.** It reads the dock height from the current base frame on every render and requests a new frame when that height changes, including same-size terminal changes such as a taller input box.

The chosen interaction remains fixed.

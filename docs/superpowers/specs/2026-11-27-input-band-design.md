# Input band and sent-message caret

Date: 2026-11-27. Status: approved choices, design for review.

## Goal

The user likes how GitHub Copilot CLI draws its input: a dark, opaque strip with a thin bar on the left and no
rules above or below. Sent messages sit in the same dark strip with a `❯` caret. Pi draws a `─` rule above and
below the input, and sent messages on a lighter grey (`#262628`) without a caret.

## Decisions (user, 2026-11-27)

1. Shape A: a strip two rows tall, with half-row gaps above and below, like Copilot.
2. The left bar shows the thinking level, the signal pi's rules carry today (and bash mode's colour).
3. Sent messages use the same dark strip.
4. Sent messages start with a `❯` caret.

Not in scope: Copilot's context lines above the input (folder, branch, machine) and its status line below.

## Design

### Input strip

A spider editor, `BandEditor extends CustomEditor`, replaces pi's editor through `ctx.ui.setEditorComponent` at
`session_start`.

```
▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄   half row: strip colour in the lower half
▎ Check PR #314's CI after its re…   text rows: bar, space, text, strip background to full width
▎ and any failing test by name.█
▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀   half row: strip colour in the upper half
```

- The editor lays text out at `width - 2`, so the bar and one space fit in front of each row.
- Strip colour: the theme's `userMessageBg`, so the input and sent messages always match. The half rows draw `▄`
  and `▀` with that colour as the foreground, derived from `theme.getBgAnsi("userMessageBg")`.
- Bar: `▎` (U+258E) drawn with `this.borderColor`, which pi already updates for the thinking level and bash mode.
- Scrolling: when lines are hidden, that edge becomes a full strip row with a dim `↑ N more` or `↓ N more` after
  the bar, instead of the half row.
- The autocomplete list renders below the strip as today, indented to the text column.
- The fake cursor and `CURSOR_MARKER` stay. The strip background is re-applied after any SGR reset inside a row.
- Pi's standalone working row stays (the `CustomEditor` default).
- Spider installs its editor only when no other extension has set one (`ctx.ui.getEditorComponent()` is
  undefined). Config `ui.inputBand` (default `true`) turns the strip and the caret off.

### Sent messages

- Theme: in `packages/herdr/assets/themes/dracula-plus-glass.json` and `spider-glass.json`, `userMessageBg`
  becomes `#161618` (the user's neutral black). The installed copy in `~/.pi/agent/themes/` follows through
  Herdr setup's normal theme install.
- Caret: spider wraps pi's exported `UserMessageComponent`, the way `copy-buttons` wraps
  `AssistantMessageComponent`: a stable, reload-safe wrapper with feature detection, which does nothing when pi's
  shape changes. The message renders with two extra columns of left padding. The first text row gets the caret,
  and continuation rows hang at the text column:

```
 ❯ Check PR #314's CI after its rebase, then report the result
   and any failing test by name.
```

- The OSC 133 zone markers pi adds stay intact. Markdown is untouched, so headings, lists and code fences keep
  their meaning.
- The caret comes from `packages/ui/src/icons.ts` as a new `prompt` role: `❯` (U+276F) in the Nerd set; the text
  set uses `❯` if Menlo, DejaVu Sans Mono and Cascadia Code all have it, otherwise `›` (U+203A).

## Tests

- Strip: one line, several lines, scrolled up and down, bash mode, a thinking-level change, autocomplete open,
  narrow widths (no row wider than `width`), cursor marker kept, background kept after a reset.
- Install: not installed when another editor is set; `ui.inputBand: false` restores pi's editor.
- Caret: one line, a wrapped line, a message starting with a heading, a list and a code fence, OSC markers kept,
  reload installs the wrapper once, wrapper inert when pi's component changes shape.
- Theme assets carry the new `userMessageBg`.
- `docs/output-ui-guidelines.md` describes the strip and the caret.

## Risks

- Pi internals: `UserMessageComponent` and the editor's render shape may change in a pi upgrade. Both wrappers
  feature-detect and fall back to pi's own drawing.
- Herdr draws cells with an explicit background opaque over its glass, which is what makes the strip read as solid.

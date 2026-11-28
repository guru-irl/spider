# Input band, sent-message caret and activity icons

Date: 2026-11-27. Status: approved by the user on 2026-11-27 after the final mock (chat-mock6-final).

## Goal

The user likes how GitHub Copilot CLI draws its input: a dark, opaque strip with a thin bar on the left and no
rules above or below. Sent messages sit in the same dark strip with a `❯` caret. Pi draws a `─` rule above and
below the input, and sent messages on a lighter grey (`#262628`) without a caret.

## Decisions (user, 2026-11-27)

1. Shape A: a strip two rows tall, with half-row gaps above and below, like Copilot.
2. The left bar is always the accent colour, except in bash mode, where it keeps bash mode's green. It does not
   show the thinking level (the user doesn't need it).
3. Sent messages use the same dark strip.
4. Sent messages start with a `❯` caret.
5. The working spinner moves into the footer as a permanent icon, left of the context usage. It animates while
   the agent works and rests when idle.
6. That spinner is the moon: 28 phases, one cycle per second (the user's pick, m1d).
7. Running subagents show an animated robot instead of a spinner: it looks left, then right, then blinks.
8. The custom spider spinners (a spider walking the web, the web spun as rings or as a spiral) were rejected:
   too small to read as a spinner.
9. The accent becomes Dracula+ blue `#82aaff` (a3), replacing purple `#c792ea`, which the user dislikes.
10. The strip is `#060607` (s3). The old `#161618` is also the theme's base and Herdr's glass colour, so it
    didn't read as darker.
11. The bar is half a cell wide, sits flush against the strip, and runs the strip's full height, half rows
    included (b1).
12. When a subagent finishes, its status icon takes the robot's place; it doesn't appear beside the robot.
13. The spider logo stays white (`toolTitle`), not the accent.
14. Tool boxes (spider's and pi's built-in tools such as edit) and message boxes use the strip colour, with half
    a row of fill above and below and one cell left and right. No outline.
15. The hover frame around a reply (copy buttons) becomes a rounded light outline, like Copilot's boxes, with no
    fill.
16. Cards drop the `└` gutter glyph: detail rows line up under the title text (g7).

Not in scope: Copilot's context lines above the input (folder, branch, machine) and its status line below.

## Design

### Input strip

A spider editor, `BandEditor extends CustomEditor`, replaces pi's editor through `ctx.ui.setEditorComponent` at
`session_start`.

```
▗▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄   half row: bar's lower quarter, then strip colour in the lower half
▐ Check PR #314's CI after its re…   text rows: bar, space, text, strip background to full width
▐ and any failing test by name.█
▝▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀   half row: bar's upper quarter, then strip colour in the upper half
```

- The editor lays text out at `width - 2`, so the bar and one space fit in front of each row.
- Strip colour: the theme's `userMessageBg`, so the input and sent messages always match. The half rows draw `▄`
  and `▀` with that colour as the foreground, derived from `theme.getBgAnsi("userMessageBg")`.
- Bar: the theme's `accent` colour, or `bashMode` while the input is a shell command. Pi's `borderColor` (the
  thinking level) is not used. Column 1
  holds the bar only, with no strip background: `▗` (U+2597) on the top half row, `▐` (U+2590) on text rows and
  `▝` (U+259D) on the bottom half row. Each uses the right half of the cell, so the bar touches the strip and
  covers its full height. A thinner bar can't reach into the half rows, because one cell can't show three
  colours (bar, strip and glass).
- Scrolling: when lines are hidden, that edge becomes a full strip row with a dim `↑ N more` or `↓ N more` after
  the bar (`▐`), instead of the half row.
- The autocomplete list renders below the strip as today, indented to the text column.
- The fake cursor and `CURSOR_MARKER` stay. The strip background is re-applied after any SGR reset inside a row.
- Pi's standalone working row is replaced by the footer icon (see Activity icons).
- Spider installs its editor only when no other extension has set one (`ctx.ui.getEditorComponent()` is
  undefined). Config `ui.inputBand` (default `true`) turns the strip and the caret off.

### Theme

In `packages/herdr/assets/themes/dracula-plus-glass.json` and `spider-glass.json`:

- New var `strip` = `#060607`. `userMessageBg` uses it.
- `accent`, `borderAccent` and `customMessageLabel` move from `purple` to `blue` (`#82aaff`). `toolTitle` stays
  `fg`, so the spider logo stays white.
- `toolPendingBg`, `toolSuccessBg`, `toolErrorBg` and `customMessageBg` use `strip` too. Errors still show
  through the red status icon and pi's error text.
- The thinking colours don't change: the bar no longer shows them.
- Purple stays in the palette for anything that names it directly, but nothing uses it as the accent.
- The installed copy in `~/.pi/agent/themes/` follows through Herdr setup's normal theme install.

### Sent messages

- They use the strip colour (`userMessageBg`) with the same half-row top and bottom edges as the input, and no
  bar.
- Caret: spider wraps pi's exported `UserMessageComponent`, the way `copy-buttons` wraps
  `AssistantMessageComponent`: a stable, reload-safe wrapper with feature detection, which does nothing when pi's
  shape changes. The message renders with two extra columns of left padding. The first text row gets the caret,
  and continuation rows hang at the text column:

```
▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄
 ❯ Check PR #314's CI after its rebase, then report the result
   and any failing test by name.
▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀
```

- The caret is in the accent colour. Pi's padding rows above and below the message become the half rows.

- The OSC 133 zone markers pi adds stay intact. Markdown is untouched, so headings, lists and code fences keep
  their meaning.
- The caret comes from `packages/ui/src/icons.ts` as a new `prompt` role: `❯` (U+276F) in the Nerd set; the text
  set uses `❯` if Menlo, DejaVu Sans Mono and Cascadia Code all have it, otherwise `›` (U+203A).

## Activity icons

### Footer moon

```
   7% ctx · claude-opus-5.5 · high · peter parker      working: the moon cycles, accent colour
   7% ctx · claude-opus-5.5 · high · peter parker      idle: new moon, dim, still
```

- Spider's footer (`packages/host/src/usage/mount.ts`, `setFooter`) draws the icon first, then two spaces, then
  the context usage. The icon is always there, so the footer never shifts.
- Frames: the Weather Icons moon phases in every Nerd Font, in order: new `U+E3E3`, waxing crescent
  `U+E3C8`-`E3CD`, first quarter `U+E3CE`, waxing gibbous `U+E3CF`-`E3D4`, full `U+E3D5`, waning gibbous
  `U+E3D6`-`E3DB`, third quarter `U+E3DC`, waning crescent `U+E3DD`-`E3E2`. Working: accent colour, one cycle
  per `MOON_CYCLE_MS` (1000). Idle: the new-moon frame in the dim colour.
- Working means the agent is running: from `agent_start` to `agent_end`. While working, the footer asks for a
  render once per frame (about 36 ms) and stops its timer when idle, on shutdown and on reload.
- Spider calls `ctx.ui.setWorkingVisible(false)`, which hides only pi's default working row. Pi's compaction,
  retry and branch-summary rows are separate indicators and still show. The row's "(esc to interrupt)" hint goes
  away; Esc still interrupts.
- Text icon style: `◐ ◓ ◑ ◒` (U+25D0-25D3) if Menlo, DejaVu Sans Mono and Cascadia Code all have them,
  otherwise today's braille frames. Idle shows `○`.
- All frames come from `packages/ui/src/icons.ts` (new `activity` frames), like every other glyph.

### Subagent robot

```
 󱙺  fix-316 · worker · gpt-6.1-terra · 21m        eyes centre, then left, centre, right, centre, blink
```

- Running agents in the agents footer, the agent list and the grid cells (`packages/ui/src/agents/footer.ts`,
  `agent-list.ts`, `grid-cell.ts`) show the animated robot where they show the braille spinner and the robot
  today. A finished agent shows its status icon (success, failure, cancelled) in the robot's place, in the status
  colour.
- Sequence (seconds): centre 0.7, left 0.35, centre 0.2, right 0.35, centre 0.7, blink 0.12, centre 0.25,
  blink 0.12, then repeat (2.79 s). Each agent starts at an offset derived from its run id, so rows don't blink
  in step.
- The frames are four custom glyphs, the Material Design robot outline with its eyes moved or closed:
  `U+F2120` centre, `U+F2121` left, `U+F2122` right, `U+F2123` closed. They exist only in a font patched by
  spider. Config `ui.spiderGlyphs` (default `false`) says the terminal font has them. Without it, running agents
  show the stock robot outline `U+F167A` with a slow colour pulse (dim to accent and back, 1.8 s), which needs
  no custom glyphs.
- Font patch: the generator moves from scratch into the repo as `scripts/fonts/patch-spider-glyphs.py`
  (fontTools). It adds the robot frames and redraws `U+F0BCA` as spider's web logo in an installed CaskaydiaCove
  Nerd Font, keeping a backup of each file. Spider ships no font files.

## Boxes, hover frame and gutters

### Tool and message boxes

```
▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄   half row of fill
 󰯊  exec                                       one cell of fill, then the content
    gh workflow run ci.yml --ref ci/selection
▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀   half row of fill
```

- Pi draws tool executions and custom messages in a `Box` with one row and one cell of padding. Spider keeps the
  one-cell sides and replaces the top and bottom padding rows with half rows: `▄` and `▀` in the box colour on
  the glass. A cell is about twice as tall as it is wide, so half a row and one cell look the same size.
- Blank rows at the start and end of the box content are dropped, so content starts right after the half row.
  This fixes the extra space above pi's edit tool.
- This applies to every tool, spider's own and pi's built-ins (edit, read, write, bash), and to custom messages.
  The wrapper feature-detects pi's padding rows and leaves the box as pi drew it if they aren't there.

### Hover frame

- The copy-buttons frame (`packages/host/src/copy-buttons/index.ts`, `FRAME`) uses rounded box drawing:
  `╭ ─ ╮ │ ╰ ╯`, in `borderMuted` (`#49494b`). The lines sit at cell centres, so the reply text has half a
  cell of space inside the frame. The copy actions and time stay on the bottom edge, and the copy labels keep
  their one-space pad so the clickable columns don't move.

### Gutters

- The `gutter` role (`└`) goes. Detail rows under a card title start at the title's text column (three cells in
  from the icon), with no glyph. `docs/output-ui-guidelines.md` changes to match.

## Tests

- Strip: one line, several lines, scrolled up and down, bash mode, a thinking-level change, autocomplete open,
  narrow widths (no row wider than `width`), cursor marker kept, background kept after a reset, column 1 is
  `▗`, `▐`, `▝` in the bar colour with no strip background.
- Install: not installed when another editor is set; `ui.inputBand: false` restores pi's editor.
- Caret: one line, a wrapped line, a message starting with a heading, a list and a code fence, OSC markers kept,
  half-row edges replace pi's padding rows, reload installs the wrapper once, wrapper inert when pi's component
  changes shape.
- Theme assets: `strip` is `#060607`; `userMessageBg`, the three tool backgrounds and `customMessageBg` use it;
  `accent`, `borderAccent` and `customMessageLabel` are blue; `toolTitle` is unchanged; both theme files agree.
- Bar colour: accent at every thinking level, bash mode green.
- Boxes: half rows replace the padding rows at the box colour, one-cell sides kept, leading and trailing blank
  content rows dropped, pi's built-in edit tool included, untouched when pi's padding rows are missing.
- Hover frame: rounded glyphs and colour, copy-button hit columns unchanged.
- Gutters: no `└` in any card; detail rows start at the title text column.
- Robot: a finished agent shows only its status icon.
- Footer moon: frame at given times (start, mid-cycle, wrap), idle frame and colour, the icon column constant
  between working and idle, the timer stops on `agent_end`, shutdown and reload, `setWorkingVisible(false)` is
  called once, text style frames.
- Robot: the sequence at given times, per-agent offsets differ, `ui.spiderGlyphs` off gives the pulse with
  `U+F167A`, finished agents unchanged.
- Font patch script: patched file has the four robot glyphs and the web logo at the expected codepoints, and
  leaves every other glyph unchanged.
- `docs/output-ui-guidelines.md` describes the strip, the caret, the footer moon and the robot.

## Risks

- Pi internals: `UserMessageComponent` and the editor's render shape may change in a pi upgrade. Both wrappers
  feature-detect and fall back to pi's own drawing.
- Herdr draws cells with an explicit background opaque over its glass, which is what makes the strip read as solid.
- Custom glyphs: a terminal without the patched font draws boxes for `U+F2120`-`F2123`, which is why
  `ui.spiderGlyphs` defaults to off. Herdr loads fonts only at start, so the patch needs a Herdr restart.
- Render cost: the footer re-renders about 28 times a second while the agent works. Pi's own working row
  animates at a similar rate today, so this replaces that cost rather than adding to it.

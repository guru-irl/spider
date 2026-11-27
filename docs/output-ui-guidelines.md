# Spider tool card guidelines

These rules apply to tool results and to transcript notifications for run completion,
escalations, slash commands, and organism reports.

## Card layout

1. **One shell.** Pi inserts the transcript spacer and owns the default tool box.
   Notification renderers return their box without another spacer. Use Pi's
   `outputPad` for horizontal padding when the host supplies it. The fallback is one column.
2. **One title.** Start with `🕸 spider · <verb>`. Italicize the verb. Add subject
   details after ` · `, such as the run name and agent in an escalation.
3. **Column 1 for status and gutters.** Start status glyphs, ` ⎿ ` detail gutters,
   and plain text rows at column 1. Hang wrapped text at column 3. Use the themed
   gutter icon, not `│`.
4. **No blank line under a bare title.** Start the body on the next line. If the call
   has detail rows, put one blank line between those rows and the result. Separate
   multi-item blocks such as parallel runs with one blank line.
5. **Names, not IDs.** Use run and session names where available. Keep generated
   internal IDs in model-facing results rather than display rows. The message card
   falls back to the typed target if the result has no name.
6. **Status uses both a glyph and a color.** For example, use `✓` for success, `○`
   for open, `✗` or `❌` for failure, `⚠` for a warning, and `●` for running work.
7. **Background follows the outcome.** Use `toolErrorBg` for failures and blocked
   escalations. Use `toolPendingBg` for warnings, questions, and running work.
   Use `toolSuccessBg` for success. For default tool shells, Pi chooses the background.
8. **Section rules distinguish groups.** Use `sectionRule` only when the body has
   more than one group. A single group needs no rule.

Fit every line to the available display width. Respect Ctrl+O expansion without
repeating call details in the result. Escalations show the full summary even when
collapsed.

### Exec example

```text
🕸 spider · exec
 ⎿ sqlite3 project.db 'SELECT seq, done, text FROM todos'
 ⎿ date '+%H:%M:%S'
 ⎿ … +6 more lines

 ✓ exit 0 · 4 lines
 ⎿ 935|0|Check the packaging job with a fresh build directory.
 ⎿ … 3 more
```

### Escalation example

```text
🕸 spider · escalation · tia-3 · worker
 ⚠ warning · The rebuild found two missing manifest entries. I will check
   the packaging logs before trying another build.
```

## Overlays

The card rules do not apply to full screens and overlays such as `/todos` and
pickers. Use the active theme, a subtle heading rule, spacing between groups, a
context line, and a footer with key hints. The `card()` frame is for standalone
views only.

## Tests

`packages/host/src/__tests__/card-rules.test.ts` checks tool and notification cards
at several widths in both icon styles and expansion modes. To save the gallery,
set `SPIDER_CARD_GALLERY` to a file path and run that test.

# Consistent spider tool cards

Date: 2026-11-27. Status: draft for the user's review.

## Problem

Spider's tool cards don't follow one layout. The user found these:

- Warning and error cards (`spider.escalation`) use their own layout. They have a blank line under the
  header, a run ID footer that means nothing to the user, and a second blank line above the card.
- Todo results print a `session ───` heading on every result. Adding a todo draws a one-item list with
  `0/1 completed`.
- Exec cards draw the command lines with a `│` in column 0. The result's `✓`/`✗` and `⎿` rows start in
  column 1, so the two don't line up.
- Message cards name subagents by run ID (`→ 5f3b8190`) instead of by name.

Other cards differ in smaller ways. Some leave a blank line under the title and some don't, and body rows
start in column 1, 2 or 3.

## Rules

These rules replace the layout guidance in `docs/output-ui-guidelines.md` and apply to every spider card:
tool results, and the notification cards for subagent completion, escalations, slash-command output and
organism reports.

1. **One shell.** Pi already draws a blank line above each card and pads the box. Notification cards must
   not add another spacer, and they use pi's `outputPad` for horizontal padding, like tool cards.
2. **One title.** Every card starts with `🕸 spider · <verb>`, with the verb in italics. Details that
   identify the subject follow after ` · `, for example `🕸 spider · escalation · tia-3 · worker`.
3. **Column 1 for status and gutters.** Body rows start in column 1:
   - status rows put their glyph in column 1, for example ` ✓ exit 0 · 4 lines` or ` ○ #935 …`;
   - detail rows use the L-shaped gutter ` ⎿ ` in column 1;
   - wrapped text hangs at column 3;
   - plain text rows, such as `Removed #460 …`, also start in column 1.
   No `│` bars anywhere.
4. **Blank lines separate the call from the result only.** A blank line follows the call's own detail
   rows, such as the exec command lines. Otherwise the body starts directly under the title. Multi-item
   results, such as parallel runs, keep one blank line between items.
5. **Names, not IDs.** Cards show run and session names wherever they exist. Run IDs and other internal
   identifiers go only into the text the agent receives.
6. **Status is a glyph and a colour together**, as today: `✓` success, `○` open, `✗`/`❌` failure,
   `⚠` warning, `●` running. Run rows retain their neutral glyph, type and status colours (#36).
7. **Background follows the outcome.** Error background only for failures and blocked escalations.
   Warnings, questions and running work use the pending background. Success uses the success background.
8. **No section rules for a single group.** `sectionRule` labels groups only when a result has more than
   one.

## Target layouts

### Escalation (layout B)

```
🕸 spider · escalation · tia-3 · worker
 ⚠ warning · The original 80% gate uses all 138 policy entries as its
   denominator, but the retry audit found only 80 files that executed shipped
   or rebuilt Spider bundles. Even perfect capture would reach only 58% on that
   denominator. I'll report both counts and continue the diagnostic replay …
```

- Glyphs: `⚠` warning, `❓` question, `❌` blocked.
- The summary always shows in full, collapsed or not.
- The message sent to the agent gains the run ID: `🚨 escalation "tia-3" (run beb58fc6-…) · worker ·
  warning`, followed by the summary.

### Subagent finished (same layout)

```
🕸 spider · run · tia-2 · worker
 ❌ failed · gpt-6.2-sol · high · 13,616,326 tokens · 0.0 credits
   blocked: I stopped after the one permitted retry. The recorder repair is
   pushed as c47c4b038; the replay is in local commit 19d2f5968. No third …
```

- The output stays collapsed to two lines with `… N more lines`, and Ctrl+O expands it, as today.
- The `spider run` tool result uses the same status rows, one per run.

### Todo

```
🕸 spider · todo
 ○ #935 Fix headless e2e S55 and S56, which fail on main when run by ID …
```

- Add shows the new item with `○`. Toggle shows the item with `✓` when done and `○` when reopened.
  There is no section rule and no count.
- List shows one row per item, then ` N/M completed`.
- Remove keeps `Removed #460 …`. It names the session only when it isn't the current one.

### Exec

```
🕸 spider · exec
 ⎿ sqlite3 /Users/guru/src/spider/.spider/project.db "SELECT seq, done, sub…
 ⎿ T=$(bash /Users/guru/src/spider/.spider/scratch/bin/now.sh)
 ⎿ … +6 more lines

 ✓ exit 0 · 4 lines
 ⎿ 51|0|scripts/sync-copilot-models.mjs: when it adds a Copilot Claude mod…
 ⎿ … 3 more
```

This covers `exec`, `exec_file` and `batch`, the standalone `renderExecCall`, and the memory card's `│`
rows.

### Message

```
🕸 spider · message
 ✓ → tia-3 · delivered
 ⎿ Controller: agreed, refuse the empty-roster case and keep R12 by ID …
```

- The message action adds the run's name to its result details whenever it resolves a run. The card shows
  the name, and falls back to the target the agent typed. A refusal from a remote route lookup with no
  local run row shows `→ subagent` instead.
- Peer sessions show the session name when the broker reports it.

## Scope

- Every renderer in `packages/ui/src/renderers/` and `packages/host/src/render-result.ts`, plus the
  notification renderers (`renderSubagentDone`, `renderEscalationMessage`, `renderCommandOutput`,
  `renderOrganismEntry`).
- The data changes the layouts need: the run name in message results, and the run ID in the escalation
  text the agent receives.
- The audit lists every card checked, what changed, and anything left as is with a reason.

### Out of scope

- Pi's own click-to-expand behaviour. Spider never overrides it.
- Theme colours and the icon sets in `packages/ui/src/icons.ts`.
- Overlays and full screens (`/todos`, pickers), which keep their own rules.

## Testing

- Turn the rules into checks:
  - a shared test renders every card from fixture data at several widths;
  - it fails on a `│` gutter, a body row whose glyph isn't in column 1, a run ID in a card, a doubled
    spacer, a section rule on a single group, or any line wider than the width.
- A gallery script prints every card with sample data, so the before and after can be compared side by
  side. Its output goes into the PR description.
- Per-renderer tests change only where the layout changed.
- Following the user's machine rules, tests run locally one file at a time at most. The full gate runs on
  GitHub CI from the PR.

## Rollout

One PR from branch `ui/card-consistency`, with before and after captures for every card. It merges after
the user's go-ahead and green CI, and spiderman then deploys it from main.

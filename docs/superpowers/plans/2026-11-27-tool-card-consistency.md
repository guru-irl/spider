# Consistent Spider Tool Cards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan
> task by task in this worktree. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every spider card follow the rules in the spec, and ship the layouts the user approved.

**Architecture:** A rule-check test renders every card from fixture data and enforces the spec's rules,
so drift fails CI. The renderers change in place: `packages/ui/src/renderers/*` for shared card bodies,
`packages/host/src/render-result.ts` for the dispatcher and the notification cards. Two small data changes
live in `packages/subagents`.

**Tech Stack:** TypeScript, pi-tui components (`Box`, `Container`, `truncateToWidth`, `wrapTextWithAnsi`),
Vitest 4.

**Spec:** `docs/superpowers/specs/2026-11-27-tool-card-consistency-design.md`. Read it first. It holds the
approved target layouts. Where this plan and the spec differ, the spec wins.

## Global Constraints

- Gutter glyph: `icon(iconStyle, "gutter")` (`⎿`, or the nerd glyph). Never `│` (U+2502) in a card body.
- Body rows start in column 1. Wrapped or detail text hangs at column 3. Titles stay in column 0.
- Cards never show a run ID or another internal ID. The text the agent receives keeps them.
- Notification renderers (`renderSubagentDone`, `renderCommandOutput`, `renderOrganismEntry`,
  `renderEscalationMessage`) add no `Spacer`. Pi adds one. They build their box as
  `new Box(options.outputPad ?? 1, 1, bg)`.
- Every line goes through `truncateToWidth` or `fitResultLines`. Respect `expanded`.
- Pi owns click-to-expand. Don't add or change mouse handling.
- Escalation summaries always show in full, collapsed or expanded.
- Background: `toolErrorBg` only for failures and `blocked` escalations, `toolSuccessBg` for success,
  otherwise `toolPendingBg`.
- Local tests: one file at a time, `npx vitest run <file> --maxWorkers=1`. No local batches, no repeated
  full typechecks. CI runs the full gate from the draft PR.

## Review Focus

- Narrow widths (20 and 30 columns): hanging indents never produce a negative wrap width or a line wider
  than the card.
- Both icon styles: `text` and `nerd` gutters keep the column-1 alignment.
- Escalations with a multi-paragraph or very long summary, an empty summary, or an unknown severity.
- Messages to a peer session (no run), to a run whose `name` is null, and refused messages with error rows.
- Todo results for another session's item, and a toggle or remove whose item no longer exists.

---

### Task 1: Rule checks and gallery

**Files:**
- Create: `packages/host/src/__tests__/card-rules.test.ts`
- Create: `packages/host/src/__tests__/card-fixtures.ts`

**Interfaces:**
- Produces: `cardFixtures(): Array<{ name: string; render: (width: number, expanded: boolean, iconStyle: IconStyle) => string[]; runIds: string[]; groups: number; callDetails: boolean }>`,
  with one entry per card kind. A tool card's `render` returns the `renderSpiderCall` lines followed by
  the `renderSpiderResult` lines, the way pi stacks them in one box. The entries are:
  - every `spider` action result that `renderSpiderResult` handles, including each `control` command and
    each `todo` op;
  - the `renderSpiderCall` title for exec, exec_file, batch and run;
  - the four notification renderers.

  Use realistic details, including run IDs like `beb58fc6-193f-4247-bb38-c59612f6985d` and names like
  `tia-3`. `callDetails` is true when the call shows its own detail rows, such as exec command lines.

- [ ] **Step 1: Write the rule tests** in `card-rules.test.ts`. For every fixture, at widths 30, 80 and
  120, collapsed and expanded, and with both icon styles, strip ANSI and assert:
  - `title`: the first non-blank line is the spider title, `<spider glyph> spider · <verb>`;
  - `blank-under-title`: when `callDetails` is false, the line after the title is not blank;
  - `no-bar`: no line contains `│`;
  - `columns`: every non-blank line after the title starts with exactly one or exactly three spaces;
  - `no-ids`: no line contains any of the fixture's `runIds`, or their first 8 characters;
  - `one-spacer`: notification renderers produce exactly one blank line before the title (the box's top
    padding);
  - `no-single-rule`: a fixture with `groups === 1` shows no `──` section rule;
  - `width`: `visibleWidth(line) <= width` for every line.
- [ ] **Step 2: Add the gallery.** When `SPIDER_CARD_GALLERY=<path>` is set, the test writes every fixture
  at width 90, collapsed, `text` icons, ANSI stripped, as `### <name>` sections followed by the rendered
  lines, to that path.
- [ ] **Step 3: Record the before state.** Run
  `SPIDER_CARD_GALLERY=$PWD/.spider/scratch/gallery-before.md npx vitest run packages/host/src/__tests__/card-rules.test.ts --maxWorkers=1`.
  Expected: the gallery file exists and the rule tests fail on the known deviations, including `│`,
  doubled spacers, run IDs and the todo section rule.
- [ ] **Step 4: Commit** the two files as `test(ui): check every spider card against the card rules`.

### Task 2: Notification shell

**Files:** Modify `packages/host/src/render-result.ts` (`renderSubagentDone`, `renderCommandOutput`,
`renderOrganismEntry`, `renderEscalationMessage`), and update
`packages/host/src/__tests__/card-background.test.ts`, which slices off the old spacer line.

- [ ] **Step 1:** Drop each renderer's `Spacer`. Build the box with `options.outputPad ?? 1`. The options
  type gains `outputPad?: number`.
- [ ] **Step 2:** Make `renderOrganismEntry` use the standard title, `🕸 spider · organism`, with its state
  as a column-1 status row.
- [ ] **Step 3:** Run `card-rules.test.ts` and `card-background.test.ts`, one at a time. Expected:
  `one-spacer` passes for all four renderers, and the background tests pass.
- [ ] **Step 4: Commit:** `fix(ui): let pi own the spacing around spider notification cards`.

### Task 3: Escalation layout B

**Files:** Modify `packages/ui/src/renderers/escalation.ts`, `packages/host/src/render-result.ts`
(`renderEscalationMessage`) and `packages/subagents/src/coordinators.ts` (`setupEscalationNotifier`).
Tests: `packages/ui/src/renderers/__tests__/escalation.test.ts` and
`packages/subagents/src/__tests__/escalation-notifier.test.ts`.

- [ ] **Step 1: Failing tests.** Rendering `{ severity: "warning", name: "tia-3", agent: "worker", summary }`
  at width 80 gives:
  - line 0: `🕸 spider · escalation · tia-3 · worker`;
  - line 1: ` ⚠ warning · ` followed by the summary's first words;
  - every later line starts with three spaces.

  Also check:
  - the full summary appears, collapsed and expanded;
  - no line contains the run ID;
  - `blocked` uses `❌` and `toolErrorBg`;
  - `question` uses `❓` and `toolPendingBg`;
  - `warning` uses `toolPendingBg`;
  - an unknown severity renders as a warning.

  In the notifier test, the agent's content is
  `🚨 *escalation* "tia-3" (run <runId>) · worker · *warning*\n\n<summary>`.
- [ ] **Step 2:** Implement. The title comes from `renderSpiderCall`'s title style, with the verb
  `escalation`. The status row wraps the summary with `wrapTextWithAnsi` to `width - 3`, puts the glyph and
  severity on the first row, and hangs the rest at column 3.
- [ ] **Step 3:** Run the three test files, one at a time. Expected: they pass.
- [ ] **Step 4: Commit:** `fix(ui): render escalations like other spider cards`.

### Task 4: Run status rows

**Files:** Modify `packages/host/src/render-result.ts` (`runBlock`, `renderRun`, `renderSubagentDone`,
and `renderSpiderCall` for `run`). Tests: `render-result.test.ts` and `card-background.test.ts`.

- [ ] **Step 1: Failing tests.**
  - A finished run renders as title `🕸 spider · run · tia-2 · worker`, then
    ` ❌ failed · gpt-6.2-sol · high · <usage>`, then up to two output lines at column 3, then
    `   … N more lines` when there are more.
  - Expanded shows all output lines.
  - A `spider run` tool result with several runs gives one status row per run in that shape, with the name
    and agent on the row because the title is shared, and a blank line between runs.
  - The task line keeps its `↳` icon at column 3.
- [ ] **Step 2:** Implement. Keep the existing usage text, thinking notices and the
  `ctrl+o to expand` hint, all at column 1 or 3.
- [ ] **Step 3:** Run the two test files. Expected: they pass.
- [ ] **Step 4: Commit:** `fix(ui): show subagent runs as status rows`.

### Task 5: Todo results

**Files:** Modify `packages/ui/src/renderers/todo-checklist.ts`, and `packages/host/src/render-result.ts`
(`toTodoDetails` and the `todo` case). Test: `packages/ui/src/__tests__/todo-checklist-renderer.test.ts`.

- [ ] **Step 1: Failing tests.**
  - `add` renders exactly ` ○ #935 <text>`.
  - `toggle` to done renders ` ✓ #935 <text>`, and back to open renders ` ○ #935 <text>`.
  - Neither has a section rule or a `completed` count.
  - `list` renders rows ` ○ #id text` and ` ✓ #id text`, then ` N/M completed`, with no section rule
    when there is one session group. Several groups keep their rules.
  - `remove` in the current session renders ` Removed #460 <text>`. Another session's item renders
    ` Removed #460 <text> from <session label>`.
- [ ] **Step 2:** Implement. Done text stays dim, as in the list today.
- [ ] **Step 3:** Run the test file. Expected: it passes.
- [ ] **Step 4: Commit:** `fix(ui): show todo changes as their checklist rows`.

### Task 6: L-shaped gutters

**Files:** Modify `packages/host/src/render-result.ts` (`renderSpiderCall` command lines,
`renderControlMemory`), `packages/ui/src/renderers/exec.ts` (`renderExecCall`) and
`packages/ui/src/renderers/message.ts` (error rows). Tests: `render-result-exec-index.test.ts`,
`exec-renderer.test.ts` and `message-renderer.test.ts`.

- [ ] **Step 1: Failing tests.**
  - An exec call with eight command lines renders ` ⎿ <line>` for the first two, then
    ` ⎿ … +6 more lines`.
  - Expanded renders every line with the gutter.
  - The gutter column equals the column of the result's `✓`.
  - The memory card and message error rows use ` ⎿ ` instead of `│ `.
- [ ] **Step 2:** Implement with `icon(iconStyle, "gutter")`.
- [ ] **Step 3:** Run the three test files, one at a time. Expected: they pass.
- [ ] **Step 4: Commit:** `fix(ui): use L-shaped gutters in every card`.

### Task 7: Names in message cards

**Files:** Modify `packages/subagents/src/actions/message.ts`, `packages/ui/src/renderers/types.ts`
(`MessageDetails` gains `targetName?: string`), `packages/ui/src/renderers/message.ts` and
`packages/host/src/render-result.ts` (`toMessageDetails`). Tests:
`packages/subagents/src/__tests__/rpc-message.test.ts` and `message-renderer.test.ts`.

- [ ] **Step 1: Failing tests.**
  - Every result whose details carry `runId` also carries `runName`: the run's `name`, or `agent` when the
    name is null. This includes refusals.
  - The card renders ` ✓ → tia-3 · delivered` for `{ to: "5f3b8190", runName: "tia-3" }`.
  - A peer session target renders the session name when details carry `sessionName`, and otherwise the
    typed `to`.
- [ ] **Step 2:** Implement. `TargetRun` already selects `name`. Add `agent` to the query, and fill
  `runName` wherever `runId` is set. For peers, pass through any session name `sendIntercom` returns as
  `sessionName`. `toMessageDetails` sets `targetName` to `details.runName ?? details.sessionName`, and
  the renderer shows `targetName ?? to ?? from`.
- [ ] **Step 3:** Run both test files. Expected: they pass.
- [ ] **Step 4: Commit:** `fix(ui): name the subagent a message went to`.

### Task 8: Audit the remaining cards

**Files:** Every renderer that `card-rules.test.ts` still fails, and `docs/output-ui-guidelines.md`.

- [ ] **Step 1:** Run `card-rules.test.ts`. Fix every remaining failure in the renderer that causes it.
  The candidates are search, doctor, insights, stats, models, config, index and fetch, kill, bind,
  migrate, skill, recall, remember, notify, loop and schedule.
- [ ] **Step 2:** Where a deviation should stay, document the reason in the fixture and in the PR. For
  example, `card()` overlays are out of scope. Don't loosen a rule to make it pass.
- [ ] **Step 3:** Rewrite the layout section of `docs/output-ui-guidelines.md` as the spec's eight rules,
  with the exec and escalation examples.
- [ ] **Step 4:** Run `card-rules.test.ts` and each renderer test file you touched. Expected: they pass.
- [ ] **Step 5: Commit:** `fix(ui): align the remaining cards with the card rules`.

### Task 9: Gallery and PR

- [ ] **Step 1:** Write `.spider/scratch/gallery-after.md` with the Task 1 command and the new path.
- [ ] **Step 2:** Push the branch and open a draft PR to `main` titled
  `fix(ui): make spider tool cards consistent`. The description has bullets for what changed and a
  collapsed before-and-after section per card, taken from the two gallery files.
- [ ] **Step 3:** Report the PR number, the CI run URL and any card left as is with its reason.

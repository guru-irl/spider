---
name: subagent-driven-development
description: Use when executing implementation plans with independent tasks in the current session
---

# Subagent-Driven Development

Implement each task with a fresh `spider run` worker, review that task for both
spec compliance and code quality with a fresh read-only reviewer, then review
the whole branch. The controller owns the shared workspace and ledger; children
receive brief, report and diff **paths**, not the entire plan or conversation.

**Continuous execution:** Do not ask whether to continue between tasks. Work
sequentially on a shared branch; do not run concurrent implementers there.

**Escalation overrides upstream's "only four stops" and "rulings, not stalls":**
Ledger only local, reversible decisions that cannot change the outcome, as
`Ruling: <decision> - <reason> - <cost if wrong>`. Emit `ESCALATION[question]`
for outcome-changing ambiguity, `ESCALATION[blocked]` if blocked, and
`ESCALATION[warning]` before destructive or irreversible action or if the
premise is wrong. Do not settle a plan/spec conflict that changes the result
by yourself. Questions from a headless child are handled by dispatching a
**fresh** child with the answer and partial-tree context, not messaging it.

## Choosing an Execution Method

Choose this skill for a plan with mostly independent tasks when per-task
review is wanted. If the user chose **Inline**, follow
[executing-plans](../executing-plans/SKILL.md) instead. Both methods share
one plan-scoped `.superpowers/sdd/` workspace and ledger. Verify or create
an isolated worktree with using-git-worktrees before starting; never implement
on main without explicit consent.

## Setup and Recovery

1. Run `bash scripts/sdd-workspace PLAN_FILE` via `spider exec`. The script
   returns an absolute workspace under `<repo>/.superpowers/sdd/`, creates
   its self-ignoring `.gitignore`, and records the canonical plan path in
   `plan-path`. Same-basename plans get different workspaces. Use that
   returned path for briefs, reports, logs and review packages, not a
   guessed slug. The first line of a **new** `<workspace>/progress.md` is
   `# SDD ledger — plan: <canonical plan-path value>`. Append progress below
   it. Do not overwrite an existing ledger.
2. Read the ledger **before dispatching**. A first-line plan ID must match the
   selected plan. Tasks marked `Task N: complete` are done; do not re-run
   them. A last line naming a fix round resumes at the next round after
   verifying its commits. Check `git log` after compaction; todos are a view,
   the ledger is the recovery record.
3. **Legacy rule:** An old flat `.superpowers/sdd/progress.md` or a markerless
   ledger without a plan-ID first line is resumable, not a mismatch.
   `sdd-workspace` returns the flat directory when it finds its ledger,
   claims it using `plan-path` without changing its progress, and refuses a
   second plan claiming it. Resume recorded tasks for the claimed plan.
   An identity line naming another plan is a stop, not a reason to reset.
   Never delete the flat legacy directory or its ledger during cleanup.
   If ownership cannot be established safely, emit `ESCALATION[question]`.
4. Read plan, spec (if supplied), Global Constraints and Review Focus. Add one
   `spider todo` per task. Scan shared files and producer/consumer interfaces
   for contradictions, plus each task's internal test/code consistency.
   Record the checks and any local reversible rulings in the ledger. Escalate
   outcome-changing conflicts before Task 1. If the workspace is lost to
   `git clean -fdx`, reconstruct from `git log`, not memory.

## Model Routing and Runtime

Before **each** `spider run`, check `spider control models` for current role
defaults, resolve a model for the role, and pass an explicit
**provider-qualified** `model:`. Routing precedence is explicit model, then
worktree-local override, then global default, then parent model. The role
lookup does not itself supply the explicit argument: put its resolved value on
every worker, fixer and reviewer run, including each pipeline stage. Scale
reasoning to the task; if a default is unavailable, resolve it before dispatch,
not by omitting `model:`. No model name in this skill is a fixed policy.

`spider run` children start in the background and report via a
`spider.subagent_done` message. **There is no blocking wait or polling.**
Keep doing local ledger/report work and respond when the event arrives; never
sleep, poll a run, or claim a missing result is DONE. Headless children cannot
be messaged, redirected or resumed. `spider message` is peer delivery, **not**
a way to instruct an in-flight or finished headless child. A fix round
always runs a **fresh** child on the partial tree, supplied the brief, prior
report, findings and diff paths.

For phases fully specifiable up front, `spider run` supports
`pipeline:[worker, reviewer], handoff:"intercom"`. Each stage is a **new**
child and needs its own explicit provider-qualified model and fresh context.
Specify how the reviewer obtains BASE, HEAD, report and package path from the
worker's handoff. Do not pipeline an unexamined finding into an automatic fix:
the controller must read the report and decide scope first.

## Task Loop

### 1. Prepare and implement

Before dispatch, record exact `BASE=$(git rev-parse HEAD)` in the ledger, not
`HEAD~1`. Run `bash scripts/task-brief PLAN_FILE N` through `spider exec` and
use the plan-scoped path it prints. Name a sibling `task-N-report.md` and
supply **absolute** brief and report paths, scene-setting context, relevant
interfaces, Global Constraints, and the [implementer template](implementer-prompt.md).
Never paste the whole plan or past conversation. A genuinely small batch of
independent same-shape edits may share one brief and review, but name every
file explicitly. Implementers must not dispatch nested workers or reviewers.

Dispatch `spider run` with `agent:"worker"`, `context:"fresh"`, an explicit
provider-qualified `model:` from the worker role default, and a concrete
task. Ask for TDD RED/GREEN evidence, covering tests, self-review and report
status. No two workers edit this branch at once. After dispatch, continue
local work; process its terminal message when it arrives.

### 2. Handle the report

- **DONE:** Verify a real report and test evidence exist. Generate
  `bash scripts/review-package PLAN_FILE BASE HEAD` with `spider exec`; the
  script rejects empty and non-descendant ranges. Dispatch the task reviewer
  with its printed package path.
- **DONE_WITH_CONCERNS:** Read concerns. Correctness or scope concerns must
  be resolved before the review; observational concerns can be ledgered.
- **NEEDS_CONTEXT:** Supply context to a **fresh** worker, starting from the
  partial tree and prior report. Escalate if the ambiguity changes outcome.
- **BLOCKED**, missing report, or a clean exit with no result: not DONE.
  Diagnose context versus capability versus task size. Dispatch a fresh
  revised brief only if unblocked; otherwise `ESCALATION[blocked]`.

### 3. Review and fix

The task reviewer receives absolute brief, report and review-package paths
plus exact Global Constraints via [task-reviewer-prompt.md](task-reviewer-prompt.md).
Run with `agent:"reviewer"`, `context:"fresh"` and explicit role-default
provider-qualified `model:`. Reviews are **read-only**: no source, index or
branch edits, no nested subagents. Require **two verdicts**, spec compliance
and task quality; resolve every `⚠️ Cannot verify from diff` yourself. Do not
pre-rate findings or ask reviewers to ignore a named defect. Reviewers read
test evidence rather than automatically re-running suites. For a batched
brief, they check every file's promised change. Ledger Minor findings for
the final review; Critical/Important and real spec gaps enter the fix loop.
A plan-mandated defect that changes the result needs `ESCALATION[question]`.

One fix round is **one fresh worker** plus **one scoped re-review**, at most
five rounds per task. Send the open findings verbatim, the original brief,
report and diff paths, and the partial-tree state to the new worker. Name the
covering tests, require it to append its fix command/output to the report,
and capture `FIX_BASE` (the HEAD the previous reviewer saw) before the fix.
Rounds 4 and 5 may use a more capable available worker model after checking
current role routing. Do not assume the original worker can be resumed, even
in rounds 1 through 3. Check fix test evidence before review. Generate
`bash scripts/review-package PLAN_FILE FIX_BASE HEAD`, then run a **fresh**
read-only reviewer with [re-review-prompt.md](re-review-prompt.md). It marks
each finding ADDRESSED or NOT ADDRESSED and checks the fix diff for new
breakage only. Out-of-scope observations become deferred minors, not new loop
work. Append `Task N: fix round R/5 (X addressed, Y open; commits A..B)` to
the ledger after each round. Do not repeat a broad review for every fix.

At round five, stop dispatching and adjudicate **each** remaining finding.
Only local reversible non-load-bearing choices can be parked with a ledgered
`Ruling:` including cost if wrong. Escalate outcome-changing or load-bearing
ambiguity, blocked work and irreversible actions using the severity above;
do not mark an unresolved load-bearing task complete. For an approved task,
append `Task N: complete (commits BASE..HEAD, review clean)` (or the number
parked after the breaker) and toggle its `spider todo`. Never advance with
open unruled Critical/Important findings.

## Final Review and Finish

After all tasks, run `bash scripts/review-package PLAN_FILE MERGE_BASE HEAD`
using the recorded branch merge base (not the last task BASE). Run a **fresh**
read-only `spider run` reviewer with `context:"fresh"`, an explicit
provider-qualified reviewer model from `spider control models`, the
[whole-branch review template](../requesting-code-review/code-reviewer.md),
and absolute package/plan/spec/ledger paths. Give it deferred minors and
rulings to triage. Await the `spider.subagent_done` event, not a poll.

If findings remain, dispatch **one fresh fix worker** for the complete list,
with covering tests and report, then **one** scoped read-only re-review of
that fix wave using `FIX_BASE..HEAD`. No second final fix wave. Ledger each
residual finding and escalate unresolved load-bearing issues; do not declare
a dirty final review clean.

Before cleanup, copy **every** ledger `Ruling:` line to the final response
under "Rulings I made" with the cost if wrong, and list deferred minors.
Only after a **clean final review**, and only for a **plan-scoped workspace**,
consider deleting that exact returned workspace. Deletion is destructive:
emit `ESCALATION[warning]` before doing it and follow the user's approval
requirements. Never remove the legacy flat workspace or siblings. Then use
finishing-a-development-branch.

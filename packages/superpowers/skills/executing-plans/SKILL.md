---
name: executing-plans
description: Use when implementing a written plan inline in this session, with a fresh final review
---

# Executing Plans

Implement the plan yourself, task by task, in this session. No worker or
reviewer per task; one fresh-context whole-branch review at the end. The
plan's briefs are requirements, RED then GREEN is each task's test gate, and
the shared ledger survives compaction. Announce that you are implementing the
plan inline. Do not pause for permission between ordinary tasks.

**Escalation takes priority over upstream's "rulings, not stalls" and "only
four stops":** Ledger only local, reversible decisions that cannot change
the outcome as `Ruling: <decision> - <reason> - <cost if wrong>`. Emit
`ESCALATION[question]` for outcome-changing ambiguity,
`ESCALATION[blocked]` when blocked, and `ESCALATION[warning]` before
destructive or irreversible action or when the premise is wrong. A plan that
contradicts the spec on the shipped outcome is a question, not a silent
ruling. Continue without an unnecessary check-in only when none applies.

## When to Use

Choose Inline when the user selected it, or when per-task subagents are not
available. For per-task independent review use
[subagent-driven-development](../subagent-driven-development/SKILL.md).
Both methods use **the same plan workspace and ledger format**, so either
can recover the other's completed tasks. Verify an isolated worktree with
using-git-worktrees first. Never start implementation on main without
explicit consent. Load test-driven-development before Task 1, and use
verification-before-completion for each completion claim.

## Setup and Recovery

1. Run `bash ../subagent-driven-development/scripts/sdd-workspace PLAN_FILE`
   through `spider exec`. Use its **returned absolute** directory under
   `.superpowers/sdd/` for every artifact. It records the normalized plan
   path in `plan-path` and creates a self-ignoring `.gitignore`.
2. Read `<workspace>/progress.md`. A new ledger begins with
   `# SDD ledger — plan: <canonical plan-path value>`. If the first line
   names a different plan, stop, do not reset. `Task N: complete` means
   DONE; trust it and verify the commit range with `git log` rather than
   repeating the task after compaction. An interrupted task resumes from its
   last valid ledger entry and partial tree.
3. Check legacy task titles and commit ranges against the selected plan before
   trusting the ledger. An owned scoped ledger wins over a flat legacy one.
   For a flat `.superpowers/sdd/progress.md`, the script compares its `Plan:`
   header with the current plan and refuses a mismatch. With no plan evidence,
   emit `ESCALATION[question]`, obtain explicit confirmation, then invoke
   `sdd-workspace --adopt-legacy PLAN_FILE`. It retains the ledger's original
   first line. To release a flat ledger with user approval, create
   `.superpowers/sdd/legacy-<name>/` and move the flat `progress.md`,
   `plan-path` and related task/review artifacts into it. Do not move or delete
   the entire `.superpowers/sdd/` directory. Adopted legacy workspaces are
   never eligible for cleanup.
4. Read plan, Spec if named, Global Constraints and Review Focus. Add one
   `spider todo` for each task. Scan shared interfaces for contradictions,
   ledger the checked producer/consumer pairs, and escalate conflicts that
   change the outcome. Note a missing/unreachable spec in the ledger; rulings
   without a spec are provisional. Each task's internal consistency is checked when
   reading its brief. If a workspace is lost to `git clean -fdx`, recover
   from `git log`, not recollection.

## Per-Task Loop

### Take the task

Via `spider exec`, run `bash scripts/task-start PLAN_FILE N`. It calls the
shared `task-brief` using bash, prints the **absolute** brief path and the
exact full BASE SHA (`git rev-parse HEAD`). Read the brief, even if you
remember its task title. Keep its `spider todo` not done until completion; spider todos are binary,
not an in-progress state. A brief is one
task, not the entire plan. Redirect large outputs to files in the workspace
and inspect the relevant tail, not a pasted transcript.

### Follow and verify each step

Follow the plan's steps in order under test-driven-development. For every
code or test change, start with a test actually run and observed failing for
the expected reason; then implement the minimal fix, rerun and see it pass.
Compare each command's actual output with the plan's `Expected:` result. If
the code is wrong, use systematic-debugging before fixing. If the plan is
wrong, apply only a local reversible ruling with its cost recorded, or emit
`ESCALATION[question]` for outcome-changing choices. Do not hide deviations.

The completion contract is evidence, not an impression: all brief-named
tests exist and ran, expected outputs were checked, the last full-task test
run passed, and every local deviation has a ledger `Ruling:` line. Follow
the plan's commit steps where permitted by the user's instructions. BASE
remains the SHA captured at task start, not `HEAD~1`, even for multi-commit
tasks. Never claim a task complete if the test failed or is missing.

### Complete the task

Run through `spider exec`:

`bash scripts/task-done PLAN_FILE N BASE -- TEST_COMMAND [ARGS...]`

Use the task's full covering test command. The script preserves full output
in `<workspace>/task-N-tests.log`, prints the last lines and returns the
**real command exit code**. Only on success does it append
`Task N: complete (commits <base7>..<head7>, tests: <command> → <last result>)`
to the ledger, creating a plan-ID first line if this is a new ledger. A
failed test adds no completion line. Read its output; then toggle the todo
and take the next task. A legacy ledger keeps its original first line.

## Common Rationalizations

| Excuse | Reality |
|--------|---------|
| "I remember what Task N says" | The brief has exact values; read it. |
| "The plan's code is right, skip watching the test fail" | A test never seen failing proves nothing. |
| "I'll run the full suite at the end instead of per step" | Per-step RED/GREEN identifies which step broke; the final run is not a substitute. |
| "The plan is wrong, I'll just do the right thing" | Ledger the ruling, or escalate if the decision changes the outcome. |
| "I'll write ledger lines after a few tasks" | Compaction does not wait; record each task promptly. |
| "Let me check in before the next task" | Ordinary tasks continue without a progress prompt; escalation still takes precedence. |
| "I read my own diff; the final reviewer is redundant" | Author and reviewer have different blind spots. Never skip the fresh final review. |
| "Tests should pass, the change was trivial" | Run them and inspect the real result. |
| "Inline means I can skip the final review" | Inline removes per-task review, not the final review. |
| "The reviewer said Minor, so it's Minor" | Re-grade by impact on a reasonable user. |
| "The fix is obvious, no need for a failing test" | RED then GREEN is the evidence it was fixed. |
| "I'll fix minors too" | Ledger deferred minors instead of expanding scope without approval. |

## Final Review and Rulings

After all tasks, generate
`bash ../subagent-driven-development/scripts/review-package PLAN_FILE MERGE_BASE HEAD`
with the recorded branch merge base. The script refuses empty or
non-descendant ranges. Run a **fresh** review-only `spider run` with
`agent:"reviewer"`, `context:"fresh"`, a concrete task and explicit
**provider-qualified** `model:` resolved from reviewer role defaults via
`spider control models`. Routing precedence is explicit model, worktree-local
override, global default, shipped role default, then parent model. Check defaults before the run;
never rely on omission of `model:`. Supply the absolute review-package,
plan, spec and ledger paths, Review Focus and Global Constraints, and
[code-reviewer.md](../requesting-code-review/code-reviewer.md). Reviewers
must not edit source, index, HEAD or branch, or dispatch nested subagents.
Children run in the background and report via `spider.subagent_done`; do
not poll or block on a nonexistent wait command. A pipeline handoff starts
a fresh child, not a resumed one. `spider message` cannot redirect a
headless reviewer already running.

Never skip the fresh final review or replace it with your own read of the
branch diff. Read its findings and its "Declined to judge" list. Re-grade
by impact on a reasonable user, not by whether the spec named that input.
Ledger and report Minor findings as deferred. Fix Critical and Important
findings in **one** inline wave, each with a test you actually saw RED then
GREEN and a green full suite afterwards. Record each test name and outcome
in the ledger. Any remaining load-bearing finding or outcome-changing
"Declined to judge" item requires `ESCALATION[question]` or
`ESCALATION[blocked]`, not an unreviewed success claim. There is no second
fix wave; do not claim the final review clean while its gate is open.

Before cleanup, reproduce **every** ledger `Ruling:` with the cost if wrong
under "Rulings I made" and each deferred minor under "Deferred minors" in
your final message. Only after the final review is clean and fixes are
verified may you consider removing **only this plan's scoped** workspace by running `bash ../subagent-driven-development/scripts/sdd-cleanup PLAN_FILE`
through `spider exec`. Deletion is destructive: emit `ESCALATION[warning]`
before it and follow the user's approval requirements. The script refuses
flat and adopted legacy ledgers and sibling plan workspaces. Then use finishing-a-development-branch.

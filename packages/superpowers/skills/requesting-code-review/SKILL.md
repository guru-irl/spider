---
name: requesting-code-review
description: Use when completing tasks, implementing major features, or before merging to verify work meets requirements
---

# Requesting Code Review

Request a code reviewer via `spider run` to catch issues before they cascade. The reviewer gets precisely crafted context for evaluation — never your session's history. This keeps the reviewer focused on the work product, not your thought process.

**Core principle:** Review early, review often.

## When to Request Review

**Mandatory:**
- After each task in subagent-driven development
- After completing major feature
- Before merge to main

**Optional but valuable:**
- When stuck (fresh perspective)
- Before refactoring (baseline check)
- After fixing complex bug

## How to Request

**1. Get git SHAs:**
```bash
BASE_SHA=$(git merge-base origin/main HEAD)  # or another justified base
HEAD_SHA=$(git rev-parse HEAD)
```

**2. Run the code reviewer:**

`spider run { agent: "reviewer", context: "fresh", model: "<provider-qualified reviewer default>", task: "Review [specific range] against [requirements] using code-reviewer.md; report findings" }` — fill the template at [code-reviewer.md](code-reviewer.md) as the concrete task. Resolve `model` from `spider control models` (`models.defaults.reviewer`) and pass it explicitly. The fresh reviewer never inherits your session history.

A `pipeline` with `handoff:"intercom"` spawns a **fresh** reviewer after the worker finishes only when the next task can be specified up front. Findings require a newly dispatched fix stage; `spider message` cannot resume a finished child or redirect a running one.

**Placeholders:**
- `{DESCRIPTION}` - Brief summary of what you built
- `{PLAN_OR_REQUIREMENTS}` - What it should do
- `{BASE_SHA}` - Starting commit
- `{HEAD_SHA}` - Ending commit

**3. Act on feedback:**
- Fix Critical issues immediately
- Fix Important issues before proceeding
- Note Minor issues for later
- Push back if reviewer is wrong (with reasoning)

## Example

```
[Just completed Task 2: Add verification function]

You: Let me request code review before proceeding.

BASE_SHA=$(git log --oneline | grep "Task 1" | head -1 | awk '{print $1}')
HEAD_SHA=$(git rev-parse HEAD)

[spider run reviewer (context:"fresh", explicit role-default model) with filled code-reviewer.md]
  DESCRIPTION: Added verifyIndex() and repairIndex() with 4 issue types
  PLAN_OR_REQUIREMENTS: Task 2 from docs/superpowers/plans/deployment-plan.md
  BASE_SHA: a7981ec
  HEAD_SHA: 3df7661

[Subagent returns]:
  Strengths: Clean architecture, real tests
  Issues:
    Important: Missing progress indicators
    Minor: Magic number (100) for reporting interval
  Assessment: Ready to proceed

You: [Fix progress indicators]
[Continue to Task 3]
```

## Common Rationalizations

| Excuse | Reality |
|--------|---------|
| "I'll just review the diff myself instead of dispatching a reviewer" | The coordinator needs context to drive the work. Dispatch a fresh reviewer with the diff and requirements; only findings return. |
| "The reviewer needs my whole session history" | Give precisely crafted context, never the session history. |

## Red Flags

**Never:**
- Skip review because "it's simple"
- Ignore Critical issues
- Proceed with unfixed Important issues
- Argue with valid technical feedback

**If reviewer wrong:**
- Push back with technical reasoning
- Show code/tests that prove it works
- Request clarification

See template at: [code-reviewer.md](code-reviewer.md)

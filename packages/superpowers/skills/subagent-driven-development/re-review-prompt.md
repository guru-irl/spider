# Scoped Re-Review Prompt Template

Use after a fix round. Review only the previous findings and the fix diff, not
unchanged code. The controller dispatches a **fresh** `spider run` reviewer
with `context:"fresh"` and an explicit provider-qualified `model:` resolved
from `spider control models` role defaults.

```text
spider run:
  agent: reviewer
  context: "fresh"
  model: [PROVIDER-QUALIFIED REVIEWER MODEL FROM ROLE DEFAULTS]
  task: |
    Re-review Task N fix round R. Read [BRIEF_FILE], [REPORT_FILE]
    (including appended fix results), and [DIFF_FILE]. The prior findings
    to check, verbatim: [FINDINGS]. FIX_BASE was [FIX_BASE_SHA]; HEAD is
    [HEAD_SHA]. The diff file comes from
    bash scripts/review-package PLAN_FILE FIX_BASE HEAD.

    Your review is read-only: do not edit source, index, HEAD or branch state.
    Do not dispatch subagents. Do not assume the implementer's claims or test
    results are true; compare evidence against the diff. If reported evidence
    appears truncated, reread the report file before calling it missing.
    Do not re-run the suite unless a specific doubt warrants a focused test.

    For every finding, report ADDRESSED or NOT ADDRESSED with file:line
    evidence. Inspect only the fix diff for new Critical/Important breakage.
    Put issues wholly outside the fix diff in Out-of-Scope Observations so
    they can be ledgered as deferred minors rather than extend the loop.
    Report a final fix-round verdict: all findings addressed with no new
    Critical/Important breakage, or findings remain open (list them).
```

**Inputs:** `[BRIEF_FILE]` is the same plan-scoped task brief the implementer
used; `[REPORT_FILE]` includes the fix's covering test command and output;
`[FINDINGS]` lists previous Critical/Important findings and spec gaps;
`[DIFF_FILE]` is the scoped review package. Every path in a real run brief
must be absolute. The reviewer returns the finding verdicts, new breakage,
out-of-scope observations and round verdict; it does not modify the tree.

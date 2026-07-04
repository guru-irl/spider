---
name: upstream-watch
description: Use when checking a vendored subsystem for new upstream commits to review and cherry-pick — never a live merge
---

# Upstream Watch

Spider vendors five subsystems (memory, context, todo, subagents, superpowers)
plus its shared db-core. Upstream repos keep evolving. This skill is the
**review-and-cherry-pick** workflow — spider never does live upstream merges
(that is an explicit non-goal).

## When to Use

- Periodically, or when you suspect an upstream fix/feature matters.
- Before a spider release, to decide what to pull forward.

## The Workflow

1. Run `spider control upstream-watch`. It diffs each vendored subsystem's
   `last_reviewed_commit` (recorded in the global DB `upstream_refs` table)
   against its upstream ref, and:
   - records `last_checked_at` + the current upstream head per package,
   - surfaces each new upstream commit as a **todo** (cherry-pick candidate),
   - renders a report grouped by package.
2. Review each surfaced todo. For candidates worth taking, cherry-pick or
   port the change into the vendored copy under `packages/<subsystem>/`,
   following `test-driven-development` (a port needs a test).
3. After you have reviewed a package's candidates, record the new
   `last_reviewed_commit` (via `spider control upstream-watch --mark <package> <sha>`)
   so the next run starts from there.

## Rules

- **Never** auto-merge or blind-apply upstream. Every candidate is a human/agent
  decision.
- Keep the fork's structure aligned with upstream so diffs stay clean (the
  `superpowers` package deliberately keeps the upstream name).
- A cherry-pick that changes behavior gets a test first (TDD).
- The first upstream-watch job on record is the superpowers v6.0.3 → v6.1.0
  upgrade this phase performed.

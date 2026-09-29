---
name: upstream-watch
description: Use when checking a vendored subsystem for new upstream commits to review and cherry-pick — never a live merge
---

# Upstream Watch

Spider vendors five subsystems (memory, context, todo, subagents, superpowers)
plus its shared db-core. Upstream repos keep evolving. This skill is the
**review-and-port** workflow — spider never does live upstream merges.

## When to Use

- Periodically, or when you suspect an upstream fix or feature matters.
- Before a spider release, to decide what to pull forward.

## What the Command Actually Checks

`spider control upstream-watch` reads each package's `upstream_repo` and
`upstream_ref` from the global `upstream_refs` table. On every run it fetches
that source into a bare per-package mirror at:

```text
~/.pi/agent/spider/upstream/<package>
```

It resolves the upstream ref and computes `last_reviewed_commit..<head>` **in
that mirror**, never in spider's own checkout or `packages/<package>`.

Each package has one truthful state:

- `NO BASELINE`: the upstream was fetched, but no reviewed commit is recorded.
  This is not an all-clear.
- `FETCH FAILED / UNREACHABLE`: the source could not be fetched. The report
  includes the reason and does not call the package up to date.
- `UNREACHABLE`: the configured ref or recorded baseline cannot be resolved in
  the fetched mirror.
- `up to date`: a baseline exists and the fetched range is empty.
- `candidates`: the range contains commits to review; each becomes a todo.

One package's failure does not abort or hide the others. The configured
`db-core` source currently points at `guru-irl/spider` itself; treat the state
reported for that configured source honestly rather than assuming it is an
independent upstream.

## Workflow

1. Run:

   ```text
   spider control upstream-watch
   ```

   This fetches every configured upstream, records `last_checked_at` and the
   result in the global database, and creates de-duplicated cherry-pick todos
   for candidate commits.

2. If a package says `NO BASELINE`, inspect its upstream history and choose the
   commit, tag, or branch that represents the last version already reviewed or
   vendored. Then establish the baseline exactly as the report instructs:

   ```text
   spider control upstream-watch --mark <package> <ref>
   ```

   Example:

   ```text
   spider control upstream-watch --mark superpowers v6.1.0
   ```

   `--mark` validates the ref in that package's fetched mirror and stores its
   resolved full commit SHA. It rejects typos and unknown refs. Run the normal
   watch first so the mirror exists and is freshly fetched.

3. Run `spider control upstream-watch` again. The report now shows either a
   genuine `up to date` state or the commits after the selected baseline.

4. Review each surfaced todo. For candidates worth taking, cherry-pick when
   histories permit or port the change into `packages/<subsystem>/`, following
   `test-driven-development` for behavior changes.

5. After reviewing all candidates for a package, advance its baseline with:

   ```text
   spider control upstream-watch --mark <package> <reviewed-ref-or-sha>
   ```

   Marking means “reviewed through this commit,” not “merged everything.”

## Rules

- **Never** auto-merge or blind-apply upstream. Every candidate is a human or
  agent decision.
- Never interpret `NO BASELINE`, `FETCH FAILED`, or `UNREACHABLE` as up to date.
- Do not edit an upstream URL merely because it is surprising. Verify it with
  read-only evidence and report what the configured source actually does.
- Keep the fork's structure aligned with upstream so diffs stay clean (the
  `superpowers` package deliberately keeps the upstream name).
- A port that changes behavior gets a failing test first (TDD).

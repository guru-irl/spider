# Superplan: pstack skills and pi 1.2 features

This plan adds 31 pstack skills to spider, each one a separate skill adapted to spider and pi, and adds routing for them to the instruction block that every spider session loads. It also adds the pi 1.2 features that help spider now, and fixes the spider defects that the pre-plan reviews found. Each phase gets its own implementation plan, written with the writing-plans skill. Implementation started on 2026-10-20.

The decision record, with one row for every pstack skill, superpowers skill and pi item, is `docs/superpowers/specs/2026-10-19-pstack-integration-decisions.md`.

## Summary

pstack is Lauren Tan's skill stack for coding agents, and pstack-claude is Michael Denyer's port of it to Claude Code, Codex, pi and Copilot. Spider takes 31 of its 63 skills from the port at v0.9.93 (commit `046341e`): `how`, `teach`, `why`, `unslop`, `technical-writing`, `show-me-your-work`, `bro`, and the 24 `principle-*` skills. They live in a new package, `packages/pstack`.

Spider adapts the copies in place, the same way it handles the superpowers skills. Other hosts' terms become spider and pi terms, model ids become role names, and `/tmp` becomes `.spider/scratch/`. References to pstack skills that spider does not ship are removed, and each skill keeps its substance. A provenance file records each upstream file as kept, changed or removed. upstream-watch tracks the port from `046341e`, and a maintainer reviews and adapts upstream changes by hand.

No superpowers skill is folded into, replaced or deleted. The pstack skills stand beside them. A new section in the managed AGENTS.md block says when to use each pstack skill and how to choose principles.

The cost is prompt space. pi lists every skill's name and description in every prompt, and the 31 skills add about 6,600 characters, roughly 1,700 tokens. Spider's 15 superpowers skills use about 490 tokens today. pi ignores pstack's `user-invocable: false` flag, so the 24 principles are listed too.

Three changes run now, beside this plan. One fixes the `skill` parameter of `spider run`, which never reaches the child. Another adds `spider schedule` and `spider loop`, ported from pstack's pi extension, so an agent can wait for CI or a deploy by scheduling a wakeup instead of sleeping. The third adds pstack's sleep guard next to them.

Spider now requires pi 1.2.0 or later. The work runs in two waves of parallel lanes. The first wave is the pi 1.2.0 change with Phases 0 and 1. The second wave is Phase 2, the pi 1.2 features, branched from the pi 1.2.0 change. Phase 0 labels `packages/context` as Elastic License 2.0 code. It also fixes the npm package, which ships no skills, and `find-polluter.sh`, which reports success when it checked nothing.

## Skills master table

Every row is a new skill, copied from `plugins/pstack/skills/<name>/` in pstack-claude at `046341e` into `packages/pstack/skills/<name>/` and then adapted. The notes say what the adaptation removes or replaces beyond the changes every skill gets.

### Named skills

| Skill | What it is for | Files | Notes |
|---|---|---|---|
| `how` | Explains how code works, walks through code before a change, and answers where code should live. | `SKILL.md`, 2 references (explorer and explainer prompts) | Loses its links to `poteto-mode`, `/setup-pstack` and the `pstack-models.md` model sheet. Its Claude Code `Agent` children become `spider run` children, and its model defaults become role names. |
| `teach` | Explains a body of work so a person understands it, by running `how` and `why` and combining the results. | `SKILL.md` | Loses its link to `poteto-mode`. |
| `why` | Explains why code or a decision is the way it is, from cited evidence in each available source, such as git history, issues, past sessions and web pages. | `SKILL.md`, 6 references | Same changes as `how`. The source guides for Slack, Datadog, Notion, Linear, Sentry and Databricks are removed, because spider cannot reach those tools. |
| `unslop` | Removes AI writing patterns from any text. | `SKILL.md` | The user-level copy with the same name is removed once spider ships this one. |
| `technical-writing` | A writing standard for docs, RFCs, READMEs, PR descriptions and commit messages. | `SKILL.md` | None. |
| `show-me-your-work` | Keeps a decision log for long or unattended work, with one row per decision giving what, why, evidence and result. | `SKILL.md`, a TSV template, `scripts/log.sh` | Loses its link to `poteto-mode`. `log.sh` needs bash and perl. |
| `bro` | Restates the last message in plain words. | `SKILL.md` | None. |

### Principles

Each principle is its own skill, as in pstack. Each is a single `SKILL.md` with `user-invocable: false` in its frontmatter, which pi ignores.

| Skill | What it is for | Files | Notes |
|---|---|---|---|
| `principle-attack-the-premise` | After two failed fixes that share one premise, write the premise down and test it before another fix. | `SKILL.md` | None. |
| `principle-boundary-discipline` | Put validation and error handling at system boundaries, and keep internal logic pure. | `SKILL.md` | None. |
| `principle-build-the-lever` | Build a tool, script or codemod that does or proves the work, instead of doing it by hand. | `SKILL.md` | None. |
| `principle-encode-lessons-in-structure` | Turn a repeated correction into a lint, check or script instead of more text. | `SKILL.md` | None. |
| `principle-exhaust-the-design-space` | For a decision with no precedent, build two or three prototypes and compare them. | `SKILL.md` | None. |
| `principle-experience-first` | In scope tradeoffs, choose fewer, finished features that serve the user. | `SKILL.md` | None. |
| `principle-explain-the-number` | Before trusting or reporting a measured number, find what limits it and rule out measuring the wrong thing. | `SKILL.md` | Loses its link to `benchmark-checklist`. |
| `principle-fix-root-causes` | Trace a symptom to where things first went wrong and fix it there. | `SKILL.md` | None. |
| `principle-foundational-thinking` | Choose core types and data structures before writing logic. | `SKILL.md` | None. |
| `principle-guard-the-context-window` | Send bulk reading to subagents and keep summaries in the main session. | `SKILL.md` | None. |
| `principle-laziness-protocol` | Prefer deletion and the smallest change that solves the problem. | `SKILL.md` | None. |
| `principle-make-operations-idempotent` | Make commands and loops reach the same end state after crashes and retries. | `SKILL.md` | None. |
| `principle-migrate-callers-then-delete-legacy-apis` | Move callers to a new internal API and delete the old one in the same change. | `SKILL.md` | None. |
| `principle-minimize-reader-load` | Reduce the layers and hidden state a reader must track. | `SKILL.md` | None. |
| `principle-model-the-domain` | Use a state machine, typed model or table instead of scattered conditionals. | `SKILL.md` | None. |
| `principle-never-block-on-the-human` | Proceed on reversible work instead of asking for permission. | `SKILL.md` | Spider's escalation rule still applies. |
| `principle-outcome-oriented-execution` | In planned migrations, move to the target design without temporary compatibility code. | `SKILL.md` | None. |
| `principle-prove-it-works` | Before declaring done, check the real result, not a proxy or a self-report. | `SKILL.md` | None. |
| `principle-redesign-from-first-principles` | Fit a new requirement by redesigning as if it had been there from the start. | `SKILL.md` | None. |
| `principle-separate-before-serializing-shared-state` | Remove shared write targets before making concurrent work run in sequence. | `SKILL.md` | None. |
| `principle-sequence-verifiable-units` | Split multi-step work into small units that each end in a check. | `SKILL.md` | None. |
| `principle-subtract-before-you-add` | Remove dead code first, then build on the simpler base. | `SKILL.md` | None. |
| `principle-test-behavior-not-implementation` | Test what users of the code can observe, so refactors do not break tests. | `SKILL.md` | None. |
| `principle-type-system-discipline` | Make illegal states unrepresentable and parse external data at boundaries. | `SKILL.md` | Loses its link to `typescript-best-practices`. |

No superpowers skill is modified, replaced or deleted, and `using-superpowers` is unchanged. Phase 0 makes two bug fixes inside superpowers skill directories without changing what any skill tells the agent to do. `find-polluter.sh` in systematic-debugging gets correct exit codes. The upstream-watch skill's sentence "Spider vendors five subsystems" gains the new package.

## The routing text

Phase 1 adds this section to `packages/superpowers/src/agentsmd-content.ts`, right after "Skills first". It is about 1,000 characters. The block's size test allows 8,500, and the block uses about 5,400 today.

```markdown
## pstack skills

spider also ships 31 skills adapted from pstack. Use them alongside the
superpowers skills above; they replace none of them.

- `how`: how code works, a walkthrough before changing it, or where code should
  live. `why`: why code or a decision is the way it is, with cited evidence.
  `teach`: explain a body of work so a person understands it; it runs `how`
  and `why`.
- `unslop`: any prose a person will read, your reply included.
  `technical-writing`: docs, READMEs, RFCs, PR descriptions and commit
  messages, on top of `unslop`. `bro`: restate the last message in plain words
  when asked.
- `show-me-your-work`: keep its decision log for long, unattended or
  multi-phase work.
- `principle-*`: each description says when it applies. When a decision
  matches one, read that skill in full first. In your reply, name each
  principle you applied and the choice it changed.
```

The text follows poteto-mode's routing list: `how` for how and placement questions, `unslop` for every reply, `technical-writing` for documents, `show-me-your-work` for long or unattended runs, and principles chosen by their trigger and named in the reply. It leaves out poteto-mode's routes to skills spider does not ship.

## Features master table

"Source" names where the feature comes from. A pi feature number is its rank in the pi feature review, also used in the record's pi table.

| Feature | Source | What it does for the user | What the user sees | Phase | Depends on |
|---|---|---|---|---|---|
| ELv2 labelling of `packages/context` | spider | States the real licence of the context code, so redistributors know their obligations. | `packages/context/LICENSE`, licence field `MIT AND Elastic-2.0` | 0 | None |
| Root NOTICE and coverage test | spider | Lists each upstream's licence and copyright line, and fails a test when one is missing. | `NOTICE.md` | 0 | None |
| `packages/pstack` with the 31 skills | pstack | Makes the 31 adapted skills available in every spider session. | 31 new skills in the skill list | 0 for the package, 1 for the skills | None |
| Skills guard and provenance file | spider | Fails a test if a skill is added or removed, or if a skill names another host's tools, an unshipped pstack skill, a model id, `/tmp` or a broken link. The provenance file says which upstream files were kept, changed or removed. | CI failures, `packages/pstack` provenance file | 0 | `packages/pstack` |
| upstream-watch entry for pstack | spider | Reports new pstack-claude commits for review and hand adaptation. | A `pstack` row in `spider control upstream-watch` | 0 | `packages/pstack` |
| Skills in the npm package | spider | npm installs get both skill folders, the licences and the notices. Today they get no skills. | npm tarball contents | 0 | None |
| Working `skill` parameter | spider | A child started with `skill:` reads and follows that skill. An unknown name fails at dispatch. | The existing `skill` parameter of `spider run` | Now, as its own change | None |
| `spider schedule` | pstack | Wakes the main session with a prompt after one to 60 minutes, once it is idle, so an agent can wait for external work without sleeping. One wakeup is pending at a time, and a new call replaces it. | `spider schedule` with a delay, a prompt, and `stop` to cancel | Now, as its own change | None |
| `spider loop` and `/loop` | pstack | Runs a prompt now and then on an interval, or lets the agent pace itself through `spider schedule`. `stop` ends it. Main session only, and it ends on `/reload` or restart. | `spider loop`, `/loop 5m <prompt>`, `/loop stop` | Now, as its own change | None |
| Sleep guard | pstack | Stops a `spider exec` sleep while subagents run and points the agent to `spider schedule`. | A refused sleep with a hint | Now, beside `spider schedule` | `spider schedule` |
| `find-polluter.sh` exit codes | spider | Reports "inconclusive" with exit code 2 instead of success when it checked nothing. | Exit codes 0, 1 and 2 | 0 | None |
| Routing section | pstack | Tells every session when to use each pstack skill. | A "pstack skills" section in the managed AGENTS.md block | 1 | None |
| Named prompt sections (pi 1) | pi | Spider's memory stops removing other extensions' prompt sections, including on runs a completion notice starts. | Other extensions' prompt sections appear again | 2 | pi 1.2.0 change |
| Native tool error results (pi 2) | pi | A failed spider action is a real failed tool result, without spider's separate error store. | Failed actions show as errors | 2 | pi 1.2.0 change |
| Response and tool durations (pi 3) | pi | Usage data records real response and tool times, and the thinking level each response used. | Dashboard and `/agents` timings | 2 | pi 1.2.0 change |
| Cancellation evidence (pi 4) | pi | A cancelled subagent run never reports success. | Correct run status | Done by the pi 1.2.0 change | None |
| Structured results for search, recall and exec (pi 5) | pi | Scripts read search hits and exec outcomes as data instead of parsing text. Opt-in. | Typed results in codemode scripts | 2 | Native error results |
| Reviewer tool profile (pi 6, with pi 21) | pi | Reviewer children run without edit and write tools. It is not a sandbox, because `spider exec` can still write. | A profile for reviewer runs | 2 | pi 1.2.0 change |
| Nested tool calls (pi 7, with pi 26) | pi | Activity, guards and usage stay correct when a tool call comes from codemode or another tool, without counting usage twice. | Correct activity and usage | 2 | pi 1.2.0 change |
| Effective settings in diagnostics (pi 8) | pi | `spider control doctor` explains which pi settings apply. | Doctor output | 2 | pi 1.2.0 change |
| Configuration schema fixtures (pi 20) | pi | Tests and docs check spider's examples against pi's published settings schemas. | Docs examples | 2 | pi 1.2.0 change |

## Decisions

The user made these decisions on 2026-10-20.

1. Spider labels `packages/context` as Elastic License 2.0 (ELv2) code, because it derives from `mksglu/context-mode` and `dist/extension.js` bundles it.
2. Spider copies the 31 skills from `046341e` and adapts them in place, replacing other hosts' terms with spider and pi terms, model ids with role names, and `/tmp` with `.spider/scratch/`.
3. The adopted skills keep their substance and drop references to `poteto-mode`, `setup-pstack`, `benchmark-checklist` and `typescript-best-practices`, and `why` drops its source guides for Slack, Datadog, Notion, Linear, Sentry and Databricks.
4. The routing section gives the seven named skills one line each and covers all principles with one rule.
5. The user-level `unslop` copy is removed once spider ships its own.
6. Of pstack's other runtime features, spider keeps only the sleep guard, built now beside `spider loop` and `spider schedule`.
7. Spider adopts none of the pi features ranked "later".
8. Spider requires pi 1.2.0 or later, so no lane keeps compatibility branches for older hosts.
9. The phases run as parallel lanes in two waves, and finished work merges as it lands.
10. Saving the frozen memory section once per session file is accepted.

## Phases

| Phase | Goal | Size | Wave |
|---|---|---|---|
| 0 | Foundations: licences, the package, packaging, upstream tracking, the `find-polluter.sh` fix | M | 1, with the pi 1.2.0 change |
| 1 | The 31 adapted skills and the routing section | S | 1 |
| 2 | pi 1.2 features ranked "now" | L | 2, from the pi 1.2.0 branch |
| 3 | Later items | Per item | When chosen |

### Phase 0: foundations

The goal is a correctly licensed repository, an empty `packages/pstack` that tests already guard, and no known check that reports success while checking nothing.

What changes, in five lanes that run in parallel:

- Licence. Add `packages/context/LICENSE` with the ELv2 text and a modification notice in each derived file. Set the licence field to `MIT AND Elastic-2.0`, and state in the root `LICENSE`, the README and a header in `dist/extension.js` that the bundle contains ELv2 code. Record the context-mode commit spider ported from, because code before upstream commit `a4829808` is MIT. Add a root `NOTICE.md` and a test that fails when an upstream named in the record has no entry.
- Package. Create `packages/pstack` with `skills/`, a README, pstack-claude's `LICENSE`, a NOTICE and the provenance file. Register the folder in the root `pi.skills` list and in spider's skill discovery. Add the skills guard. It pins the 31 skill names and fails on another host's terms, an unshipped pstack skill name, a model id, `/tmp` or a broken link.
- Distribution. Add both skill folders, the licence files and the notices to the npm `files` list and the release tarball check. A test runs `npm pack --dry-run` and discovers skills from the packed list.
- Watch. Seed an upstream-watch entry for `packages/pstack` that tracks `michael-denyer/pstack-claude` from `046341e`, after checking that the commit exists. Add the package to the upstream-watch skill's subsystem sentence, and correct the superpowers README, which lists six watched subsystems while the code seeds five.
- Fix. `find-polluter.sh` exits 0 only when at least one test ran and none polluted, 1 when it finds a polluter, and 2 when the result is inconclusive.

Done when each new test fails on its known-bad case. The cases are a missing NOTICE entry, a skill that names `poteto-mode` or `/tmp`, a tarball without skills, and a polluter search that matched nothing. Today's code fails the last two. The typecheck, test and build gate must pass on pi 1.2.0.

Review: one review of the first wave on a frozen copy. Size: M.

### Phase 1: the skills and the routing section

The goal is the 31 adapted skills in every session, with routing that tells the agent when to use them.

One lane copies the 31 skill directories from the pinned commit and adapts them. It fills in the provenance file and adds the routing section to the managed block.

Done when:

- the skills guard passes with 31 skills, and fails when one skill is removed or names an unshipped pstack skill;
- every upstream file appears in the provenance file as kept, changed or removed;
- a block test checks that the "pstack skills" section is present, names the seven named skills and the principle rule, and that the block stays under its size limit;
- a session in a test project lists all 46 skills, and `spider run` with `skill: "how"` starts a child that reads `how`;
- three runs each of four requests ("how does X work", "why is X like this", "write the PR description", "restate that plainly") load the expected skill, and a miss fails the check.

Review: shared with Phase 0 in the first-wave review. Size: S.

### Phase 2: pi 1.2 features

The goal is the pi rows of the features table, apart from cancellation evidence, which the pi 1.2.0 change already delivers. The lanes branch from the pi 1.2.0 change and use pi 1.2.0 APIs directly.

What changes, in five lanes split by file ownership:

| Lane | Files it owns | Features |
|---|---|---|
| Prompt | `packages/host/src/hooks.ts` and its tests | Named prompt sections (pi 1). Moves frozen memory to a named section, saved once per session file, then removes the `context_with_system` workaround. |
| Tool results | `packages/host/src/extension.ts`, `result.ts`, `routing/`, diagnostics | Native error results (pi 2), then structured results (pi 5), nested-call routing tests (pi 7), effective settings (pi 8) |
| Usage | `packages/host/src/usage/`, `packages/subagents/src/child-reporter.ts` | Durations and thinking level (pi 3), nested usage without double counting (pi 7 and 26) |
| Child launch | `packages/subagents/src/pi-args.ts` and launch tests | Reviewer tool profile with tool selectors (pi 6 and 21) |
| Docs | `docs/` and config fixtures | Schema checks for examples (pi 20) |

Done when:

- prompt tests pass for empty and non-empty memory, on user runs and completion-notice runs, in both extension load orders;
- a failed exec, an action error and a thrown error each reach pi as a failed tool result, and a redacted failure keeps no secret in its structured data;
- usage parsing gives the same result for full and incremental ingestion, and keeps missing durations unknown;
- a reviewer child cannot call `edit` or `write`;
- a nested tool call is counted once;
- the real-host RPC tests pass.

Review: one review of the second wave. Size: L.

### Phase 3: later items

Each item gets its own plan only when the user chooses it. The items are the pi "later" features, the `/agents` link to pi's native transcript export (pi 35), and an issue to obra/superpowers about the same `find-polluter.sh` bug, which is public and needs the user's go-ahead.

## How the work runs

- One worktree and one writer per lane. A wave's lanes merge as they pass the test gate.
- One review per wave on a frozen copy at the integrated commit, run beside the gate, then one fix round. A re-review follows only a fixed Critical finding.
- A lane reports done with the command it ran, its exit code and the quoted output. Every new check ships with a known-bad case. An inconclusive result never counts as a pass.

## Risks

| Risk | How it is contained |
|---|---|
| The skill list grows by about 1,700 tokens in every prompt. | The routing section stays small. If the cost proves too high, spider can hide the principles with pi's `disable-model-invocation` flag and record the change in the provenance file. |
| An adaptation drops part of a skill's substance. | The provenance file lists every change for review, and the Phase 1 trigger runs check that the skills load and route. |
| Upstream changes no longer apply as plain diffs. | upstream-watch shows each new commit, and a maintainer adapts it by hand and updates the provenance file, as with superpowers. |
| A user-level skill with the same name hides spider's copy. | The user-level `unslop` is removed, and the package README names the 31 skill names. |
| Spider misses a licence obligation. | Phase 0 labels the ELv2 code, ships pstack-claude's MIT licence, and tests the NOTICE. |

## Out of scope

The record gives the reason for each.

- Fold-ins to superpowers skills and the change to wave review in shipped skills: see "Superpowers skills".
- The 32 other pstack skills, including the adapted skills of the earlier plan: see "Other pstack skills".
- A principles reference file: see "Adopted pstack skills".
- pstack's runtime features other than the scheduler and the sleep guard: see decision 6.
- Installing pstack beside spider: see "Other pstack skills", poteto-mode.
- pi features marked later, skip or host behaviour: see "pi 1.2 features".

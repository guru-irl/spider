# pstack integration: decision record

This record gives one decision for every pstack skill, every superpowers skill that spider vendors, and every pi 1.2 feature in the pi feature review. The superplan that orders the work is `docs/superpowers/plans/2026-10-19-pstack-integration.md`, and decision numbers below refer to its decision list.

The sources are pstack-claude v0.9.93 (commit `046341e`), which has 63 skills including 24 principle skills, spider's 15 superpowers skills, and pi 1.2.0.

The pre-plan reviews recommended adapting pstack skills and folding them into the superpowers skills. The maintainer chose a narrower scope. Spider adapts 31 pstack skills, keeps each one separate, and leaves the superpowers skills as they are. The "Pre-plan recommendation" columns record what the reviews proposed, for reference only.

## Adopted pstack skills

All 31 are copied into `packages/pstack/skills/` in Phase 1 and adapted in place, as spider does with the superpowers skills. Every skill gets spider and pi terms instead of other hosts' terms, role names instead of model ids, and `.spider/scratch/` instead of `/tmp`. The notes list what else a skill loses. A provenance file in `packages/pstack` records each upstream file as kept, changed or removed.

| Skill | Decision | Files | Notes | Pre-plan recommendation |
|---|---|---|---|---|
| how | Adopt, adapted | `SKILL.md`, 2 references | Loses its links to `poteto-mode`, `setup-pstack` and `pstack-models.md`. Its Claude Code children become `spider run` children. | Adopt, adapted |
| teach | Adopt, adapted | `SKILL.md` | Loses its link to `poteto-mode`. | Fold into `how` |
| why | Adopt, adapted | `SKILL.md`, 6 of 12 references | Same changes as `how`. Loses the Slack, Datadog, Notion, Linear, Sentry and Databricks source guides. | Adopt, adapted |
| unslop | Adopt, adapted | `SKILL.md` | The user-level copy is removed (decision 5). | Fold into `technical-writing` |
| technical-writing | Adopt, adapted | `SKILL.md` | None | Adopt, adapted |
| show-me-your-work | Adopt, adapted | `SKILL.md`, TSV template, `scripts/log.sh` | Loses its link to `poteto-mode`. | Merge into `figure-it-out` and executing-plans |
| bro | Adopt, adapted | `SKILL.md` | None | Drop |
| principle-attack-the-premise | Adopt, adapted | `SKILL.md` | None | Fold into systematic-debugging |
| principle-boundary-discipline | Adopt, adapted | `SKILL.md` | None | Principles reference file |
| principle-build-the-lever | Adopt, adapted | `SKILL.md` | None | Fold into verification-before-completion and writing-plans |
| principle-encode-lessons-in-structure | Adopt, adapted | `SKILL.md` | None | Fold into `correct` |
| principle-exhaust-the-design-space | Adopt, adapted | `SKILL.md` | None | Fold into `architect` and brainstorming |
| principle-experience-first | Adopt, adapted | `SKILL.md` | None | Fold into brainstorming |
| principle-explain-the-number | Adopt, adapted | `SKILL.md` | Loses its link to `benchmark-checklist`. | Merge into `benchmark-checklist` |
| principle-fix-root-causes | Adopt, adapted | `SKILL.md` | None | Fold into systematic-debugging |
| principle-foundational-thinking | Adopt, adapted | `SKILL.md` | None | Fold into writing-plans |
| principle-guard-the-context-window | Adopt, adapted | `SKILL.md` | None | Drop |
| principle-laziness-protocol | Adopt, adapted | `SKILL.md` | None | Drop |
| principle-make-operations-idempotent | Adopt, adapted | `SKILL.md` | None | Principles reference file |
| principle-migrate-callers-then-delete-legacy-apis | Adopt, adapted | `SKILL.md` | None | Principles reference file and writing-plans |
| principle-minimize-reader-load | Adopt, adapted | `SKILL.md` | None | Principles reference file and a review lens |
| principle-model-the-domain | Adopt, adapted | `SKILL.md` | None | Principles reference file |
| principle-never-block-on-the-human | Adopt, adapted | `SKILL.md` | Spider's escalation rule still applies | Fold one rule into the delegation skills |
| principle-outcome-oriented-execution | Adopt, adapted | `SKILL.md` | None | Drop until a migration needs it |
| principle-prove-it-works | Adopt, adapted | `SKILL.md` | None | Fold into verification-before-completion |
| principle-redesign-from-first-principles | Adopt, adapted | `SKILL.md` | None | Fold into brainstorming |
| principle-separate-before-serializing-shared-state | Adopt, adapted | `SKILL.md` | None | Fold into dispatching-parallel-agents |
| principle-sequence-verifiable-units | Adopt, adapted | `SKILL.md` | None | Fold into writing-plans |
| principle-subtract-before-you-add | Adopt, adapted | `SKILL.md` | None | Principles reference file |
| principle-test-behavior-not-implementation | Adopt, adapted | `SKILL.md` | None | Fold into test-driven-development |
| principle-type-system-discipline | Adopt, adapted | `SKILL.md` | Loses its link to `typescript-best-practices`. | Principles reference file and `typescript-best-practices` |

Spider creates no principles reference file. Each principle stays a separate skill, as in pstack.

## Other pstack skills

The decision for each is "Not adopted", for the reason "outside the chosen scope". The adopted skills no longer refer to them, and the routing section does not list them.

| Skill | Decision | Reason | Pre-plan recommendation |
|---|---|---|---|
| architect | Not adopted | Outside the chosen scope | Adopt |
| arena | Not adopted | Outside the chosen scope | Adopt |
| automate-me | Not adopted | Outside the chosen scope | Drop |
| babysit | Not adopted | Outside the chosen scope | Merge into a PR-watching skill |
| benchmark-checklist | Not adopted | Outside the chosen scope | Adopt |
| blast-radius | Not adopted | Outside the chosen scope | Adopt |
| correct | Not adopted | Outside the chosen scope | Adopt |
| create-verification-skill | Not adopted | Outside the chosen scope | Adopt later |
| deslop | Not adopted | Outside the chosen scope | Fold into requesting-code-review |
| figure-it-out | Not adopted | Outside the chosen scope | Adopt, merged with playbooks |
| fix-ci | Not adopted | Outside the chosen scope | Merge into a PR-watching skill |
| fix-merge-conflicts | Not adopted | Outside the chosen scope | Merge into a PR-watching skill |
| get-pr-comments | Not adopted | Outside the chosen scope | Fold into receiving-code-review |
| in-your-own-words | Not adopted | Outside the chosen scope | Drop |
| interrogate | Not adopted | Outside the chosen scope | Fold into a review lens |
| ketchup | Not adopted | Outside the chosen scope | Merge into a resuming-work skill |
| maintain-verification-skill | Not adopted | Outside the chosen scope | Adopt later |
| make-pr-easy-to-review | Not adopted | Outside the chosen scope | Fold into finishing-a-development-branch |
| no-comments | Not adopted | Outside the chosen scope | Drop |
| poteto-help | Not adopted | Outside the chosen scope | Drop |
| poteto-mode | Not adopted | Outside the chosen scope. Its routing list is the basis of spider's routing section. Installing pstack beside spider would add a second subagent runner and model sheet. | Fold six rules into routing |
| recall | Not adopted | Outside the chosen scope | Merge into a resuming-work skill |
| reflect | Not adopted | Outside the chosen scope | Adopt |
| setup-pstack | Not adopted | Outside the chosen scope | Drop |
| sharpen | Not adopted | Outside the chosen scope | Fold into brainstorming |
| swarm | Not adopted | Outside the chosen scope | Fold into dispatching-parallel-agents |
| tdd | Not adopted | Outside the chosen scope | Fold into test-driven-development |
| thermo-nuclear-code-quality-review | Not adopted | Outside the chosen scope | Fold into a review lens |
| thermo-nuclear-review | Not adopted | Outside the chosen scope | Fold into a review lens |
| thermos | Not adopted | Outside the chosen scope | Fold into review lenses |
| typescript-best-practices | Not adopted | Outside the chosen scope | Adopt |
| what-did-i-get-done | Not adopted | Outside the chosen scope | Merge into a resuming-work skill |

pstack's playbooks, agent files and tooling are not adopted either. Of its runtime, spider ports the scheduler as `spider schedule` and `spider loop`, and the sleep guard (decision 6).

## Superpowers skills

All 15 skills in `packages/superpowers/skills/` stay as they are: 14 vendored from obra/superpowers at commit `8ca22dba`, and spider's own upstream-watch. None is modified, replaced or deleted. The earlier plan's fold-ins and its change from per-task to per-wave review in the shipped skills are dropped.

| Skill | Decision | Note |
|---|---|---|
| brainstorming | Unchanged | None |
| dispatching-parallel-agents | Unchanged | None |
| executing-plans | Unchanged | None |
| finishing-a-development-branch | Unchanged | None |
| receiving-code-review | Unchanged | None |
| requesting-code-review | Unchanged | None |
| subagent-driven-development | Unchanged | None |
| systematic-debugging | Unchanged | Phase 0 fixes the exit codes of its `find-polluter.sh` script. The skill text does not change. |
| test-driven-development | Unchanged | None |
| upstream-watch | Unchanged | Phase 0 adds `packages/pstack` to its sentence listing the vendored subsystems. The workflow does not change. |
| using-git-worktrees | Unchanged | None |
| using-superpowers | Unchanged | The managed block's "Skills first" section condenses its main rule, and it marks the skills folder for spider's skill discovery. |
| verification-before-completion | Unchanged | None |
| writing-plans | Unchanged | None |
| writing-skills | Unchanged | None |

## pi 1.2 features

These are the 37 items of the pi feature review, numbered as there. Spider requires pi 1.2.0 or later. "Now" items land in Phase 2. "Later" items wait for a need, and spider adopts none of them now (decision 7). "Skip" means spider builds nothing. "Host" means spider accepts pi's behaviour and adds at most a test. "By 1.2" means present in 1.2.0 with no dated changelog entry.

| # | Feature | pi version | Decision | Resulting spider change | Reason |
|---|---|---|---|---|---|
| 1 | Prompt sections on runs an extension starts | 1.2.0 | Now | Frozen memory moves to a named section; the `context_with_system` workaround goes | Other extensions' sections stop disappearing. |
| 2 | Native `isError` tool results | 0.99.0 | Now | Failed actions use pi's flag; the separate error store goes | Simpler, and structured failure data survives. |
| 3 | Response and tool durations, per-response thinking | 1.1.0, by 1.2 | Now | Usage parsing and ingestion record them | Spider's latency fields are empty today. |
| 4 | `agent_settled.aborted` | 1.1.0 | Now | Done by the pi 1.2.0 upgrade change | A cancelled run could report success. |
| 5 | `outputSchema` and `structuredContent` | 0.99.0 | Now | Opt-in typed results for search, recall and exec | Scripts stop parsing display text. |
| 6 | Tool exposure and `defaultActive` | 0.99.0, by 1.2 | Now | Reviewer profile without edit and write tools | Reviewers lose tools they should not use. |
| 7 | Nested tool execution and events | 0.99.0 | Now | Tests and fixes for nested calls in routing and usage | Codemode calls arrive nested. |
| 8 | Effective settings through `pi.getSettings()` | By 1.2 | Now | Diagnostics show effective settings | Explains which settings apply. |
| 9 | Codemode in the parent | 0.99.0 | Later | None now (decision 7) | Usage accounting is incomplete. |
| 10 | Codemode in RPC children | 0.99.0 | Later | None now | Waits for the parent pilot. |
| 11 | Namespaces and aliases | 0.99.0 to 1.2.0 | Later | None now | Only useful with codemode. |
| 12 | `prepareLoadout()` and prompt guidelines | 0.99.0 | Later | None now | Only if codemode's own modes fall short. |
| 13 | `reachesTools()` | 1.2.0 | Later | None now | Only for tools that call other tools. |
| 14 | Native tool renderer resolution | 1.0.1 | Later | None now | Only when spider renders other tools. |
| 15 | MCP client integration | 0.99.0 onward | Later | None now (decision 7) | Only for servers the user picks. |
| 16 | MCP registration APIs | 0.99.0 | Later | None now | Only with a concrete MCP use. |
| 17 | Classifier models | 0.99.0 to 1.1.0 | Later | None now (decision 7) | Advisory at most; needs evaluation. |
| 18 | Virtual models | 0.99.0 | Later | None now (decision 7) | Experimental; would compete with spider's model roles. |
| 19 | `provider_stream_event` | 0.99.0 | Later | None now | Diagnostics only. |
| 20 | Configuration schemas | 1.2.0 | Now | Docs examples checked against pi's schemas | Catches stale examples. |
| 21 | CLI tool selectors and settings modifiers | 0.99.0 to 1.1.0 | Now | Part of the reviewer profile | Expresses the child tool list. |
| 22 | Built-in and inline extension control | 0.99.0 | Later | None now | Needed only with codemode or MCP in children. |
| 23 | RPC input dispositions | 0.99.0 | Skip | None | Spider already handles them. |
| 24 | Session inspection APIs | By 1.2 | Skip | None | No new need. |
| 25 | Compaction and session persistence fixes | 0.99.0, 1.2.0 | Host | Compatibility tests only | Spider inherits the fixes. |
| 26 | Nested-tool usage rollup | 0.99.0 | Now | Part of the nested-call work | Prevents double counting. |
| 27 | Tool annotations | 0.99.0 | Later | None now | Hints only, never enforcement. |
| 28 | Image model runtime | 0.99.0 to 1.0.4 | Skip | None | pi's own support is enough. |
| 29 | Sampling by thinking level, custom-provider operations | 0.99.0 to 1.2.0 | Skip | None | Model settings stay with the user. |
| 30 | Per-key model catalogs | 0.99.0, 1.2.0 | Host | None | Spider reads pi's registry. |
| 31 | Provider, model and login additions | 0.99.0 to 1.1.0 | Host | None | No spider login code needed. |
| 32 | Theme and transcript presentation APIs | 0.99.0 to 1.1.0 | Later | Use during renderer work | No redesign needed now. |
| 33 | Program status reporting | 1.1.0 | Skip | None | Host feature. |
| 34 | Clipboard, login copy, quiet startup | 1.0.0 to 1.2.0 | Skip | None | pi settings cover them. |
| 35 | HTML export improvements | 0.99.0, 1.0.1 | Later | `/agents` link to pi's export, if chosen | The transcript feature was dropped with decision 6. |
| 36 | Package dependency handling | 0.99.0, 1.0.1 | Host | Packaging checks only | Spider already declares pi as a peer. |
| 37 | Prompt-cache and output refinements | 0.99.0 to 1.2.0 | Host | Regression tests only | Spider inherits the fixes. |

## Attribution

Phase 0 adds each upstream's licence text and notice to spider's source tree and npm package. This is a factual summary, not legal advice.

| Upstream | Licence and copyright line | What spider takes |
|---|---|---|
| pstack in cursor/plugins, by Lauren Tan | MIT, "Copyright (c) 2026 Lauren Tan" | The original text of the 31 adopted skills. |
| pstack-claude, by Michael Denyer | MIT, "Copyright (c) 2026 Michael Denyer", in the same `LICENSE` file as Lauren Tan's line | The port's version of the 31 skills, which spider adapts, and the tracked upstream for `packages/pstack`. The scheduler in its pi extension (`plugins/pstack/pi/schedule.ts`), which `spider loop` and `spider schedule` port, and its sleep guard (`plugins/pstack/pi/sleep-wait.ts`), with an attribution header in each ported file. |
| obra/superpowers, by Jesse Vincent | MIT, "Copyright (c) 2025 Jesse Vincent" | The 14 vendored skills in `packages/superpowers/skills/`. upstream-watch is spider's own. |
| context-mode, by Mert Koseoglu (GitHub `mksglu`) | Elastic License 2.0, "Copyright 2026 Mert Koseoglu" | Code in `packages/context`, also bundled into `dist/extension.js`. See below. |
| pi-hermes-memory (`chandra447/pi-hermes-memory`) | MIT, "Copyright (c) 2025 Chandra Teja" | Code in `packages/memory`. |
| pi-subagents (`nicobailon/pi-subagents`) | MIT, "Copyright (c) 2026 Nico Bailon" | Code in `packages/subagents`. The watched fork has no LICENSE file, so the text comes from the original. |
| pi-todo-sqlite (`guru-irl/pi-todo-sqlite`), by the spider author | MIT, "Copyright (c) 2026 guru-irl" | Code in `packages/todo`. It is the spider author's own repository, so it carries no third-party obligation, and NOTICE keeps its line for completeness. |

None of the 31 skills comes from pstack-claude's Cursor team kit or thermos material, so their licence files are not needed.

Spider labels this code ELv2 (decision 1). ELv2 lets anyone use, copy, distribute and modify the code, but it cannot be sublicensed, so spider cannot relicense this code as MIT. It forbids offering the software as a hosted or managed service, circumventing licence-key features, and removing licensing notices. Anyone who receives a copy must also receive the ELv2 terms, and modified copies must carry a prominent notice that they were modified. context-mode was MIT until upstream commit `a4829808`, and Phase 0 records which commit spider ported from. Spider has never published to npm, so only the GitHub source is affected so far.

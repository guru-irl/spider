# Upstream provenance

- **Upstream:** https://github.com/michael-denyer/pstack-claude
- **Commit:** `046341e3aaf2405083973a37f860d0d2ea98e18a` (Release 0.9.93)
- **Path:** `plugins/pstack/skills/<skill>/...`, copied to `skills/<skill>/...`

Status: **kept** means byte-identical to upstream, **changed** means adapted in place, **removed** means not shipped. When upstream changes a file, diff it against this commit and carry the change over with the same adaptations.

| Upstream file | Status | Adaptation |
|---|---|---|
| `bro/SKILL.md` | changed | Description names pi's `/skill:bro` command. |
| `how/SKILL.md` | changed | Dispatch through `spider run` (scout, `context: "fresh"`, no edits); model roles instead of model ids; platform-mapping lines, model override sheet, and effort-agent section removed. |
| `how/references/explainer-prompt.md` | changed | `read`, `spider search`, and `rg` through `spider exec` instead of another host's file tools. |
| `how/references/explorer-prompt.md` | kept | |
| `principle-attack-the-premise/SKILL.md` | changed | `user-invocable` frontmatter key dropped. |
| `principle-boundary-discipline/SKILL.md` | changed | `user-invocable` dropped. |
| `principle-build-the-lever/SKILL.md` | changed | `user-invocable` dropped. |
| `principle-encode-lessons-in-structure/SKILL.md` | changed | `user-invocable` dropped. |
| `principle-exhaust-the-design-space/SKILL.md` | changed | `user-invocable` dropped. |
| `principle-experience-first/SKILL.md` | changed | `user-invocable` dropped. |
| `principle-explain-the-number/SKILL.md` | changed | `user-invocable` dropped; the link to the unshipped benchmark checklist skill is replaced by its key checks (tuning, hardware limits, 5 alternating runs, end-to-end effect). |
| `principle-fix-root-causes/SKILL.md` | changed | `user-invocable` dropped. |
| `principle-foundational-thinking/SKILL.md` | changed | `user-invocable` dropped. |
| `principle-guard-the-context-window/SKILL.md` | changed | `user-invocable` dropped. |
| `principle-laziness-protocol/SKILL.md` | changed | `user-invocable` dropped. |
| `principle-make-operations-idempotent/SKILL.md` | changed | `user-invocable` dropped. |
| `principle-migrate-callers-then-delete-legacy-apis/SKILL.md` | changed | `user-invocable` dropped. |
| `principle-minimize-reader-load/SKILL.md` | changed | `user-invocable` dropped. |
| `principle-model-the-domain/SKILL.md` | changed | `user-invocable` dropped. |
| `principle-never-block-on-the-human/SKILL.md` | changed | `user-invocable` dropped. |
| `principle-outcome-oriented-execution/SKILL.md` | changed | `user-invocable` dropped. |
| `principle-prove-it-works/SKILL.md` | changed | `user-invocable` dropped. |
| `principle-redesign-from-first-principles/SKILL.md` | changed | `user-invocable` dropped. |
| `principle-separate-before-serializing-shared-state/SKILL.md` | changed | `user-invocable` dropped. |
| `principle-sequence-verifiable-units/SKILL.md` | changed | `user-invocable` dropped. |
| `principle-subtract-before-you-add/SKILL.md` | changed | `user-invocable` dropped. |
| `principle-test-behavior-not-implementation/SKILL.md` | changed | `user-invocable` dropped. |
| `principle-type-system-discipline/SKILL.md` | changed | `user-invocable` dropped; pointer to the unshipped TypeScript skill removed. |
| `show-me-your-work/SKILL.md` | changed | Log lives under `.spider/scratch/`; `log.sh` runs through `spider exec`; transcript audit reads pi's session file instead of another host's transcript directory; cross-model reviewer dispatched with `spider run`; platform-mapping line removed; description names `/skill:show-me-your-work`. |
| `show-me-your-work/references/decision-log-template.tsv` | kept | |
| `show-me-your-work/scripts/log.sh` | changed | Re-executes under bash when run by zsh or sh; resolves a relative log path under `<repo root>/.spider/scratch/` and refuses absolute paths outside it and `..` components. Row writing is unchanged. |
| `teach/SKILL.md` | changed | Platform-mapping lines removed; image generation used "when one is available". |
| `technical-writing/SKILL.md` | changed | Description names pi's `/skill:technical-writing` command. |
| `unslop/SKILL.md` | kept | |
| `why/SKILL.md` | changed | Four evidence categories spider can reach (git and codebase, GitHub issues via `gh`, past sessions and memory via `spider search`, web pages via `spider fetch`) replace connector discovery; unreachable sources become named gaps; dispatch through `spider run`; model roles instead of model ids; platform-mapping lines, model override sheet, and effort-agent section removed. |
| `why/references/epistemics.md` | kept | |
| `why/references/investigator-prompt.md` | changed | Playbook comes from `source-playbook.md`; source list and citation kinds match the four categories. |
| `why/references/source-playbook.md` | changed | Rewritten as the index and playbooks for the four reachable sources; connector rows removed. |
| `why/references/sources/code-archaeology.md` | kept | |
| `why/references/sources/databricks.md` | removed | Analytics warehouse connector, not reachable from spider. |
| `why/references/sources/datadog.md` | removed | Observability connector, not reachable from spider. |
| `why/references/sources/incident-postmortem.md` | changed | Ticket and chat bullets point to GitHub issues and past sessions. |
| `why/references/sources/linear.md` | removed | Issue tracker connector, not reachable from spider; GitHub issues covered in `source-playbook.md`. |
| `why/references/sources/notion.md` | removed | Docs connector, not reachable from spider. |
| `why/references/sources/sentry.md` | removed | Error tracking connector, not reachable from spider. |
| `why/references/sources/slack.md` | removed | Team chat connector, not reachable from spider. |
| `why/references/synthesizer-prompt.md` | changed | Source list, citation kinds, spot-check tools, and Sources Consulted lines match the four categories plus an out-of-reach line. |

Files added by spider, with no upstream counterpart: `package.json`, `README.md`, `UPSTREAM.md`, `src/__tests__/*`. `LICENSE` is upstream's, verbatim.

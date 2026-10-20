# @spider/pstack

Vendors 31 skills from [pstack-claude](https://github.com/michael-denyer/pstack-claude) into spider, adapted to pi and the `spider` tool. The skills are copied from upstream commit `046341e3aaf2405083973a37f860d0d2ea98e18a` (`plugins/pstack/skills/`) and edited in place, the same way `@spider/superpowers` carries its skills.

## The skills

Seven working skills:

- `bro`: restate the last message in plain language.
- `how`: explain how a subsystem works, with parallel explorer subagents and one explainer.
- `show-me-your-work`: keep a TSV decision log under `.spider/scratch/` and audit it against the session transcript.
- `teach`: explain a body of work plainly, built on `how` and `why`.
- `technical-writing`: a layered standard for docs, PR descriptions, and commit messages.
- `unslop`: cut AI tells from writing.
- `why`: investigate why code has its shape, with one investigator per evidence source and a synthesizer.

Twenty-four engineering principles, each a short skill an agent applies when the situation in its description comes up:

`principle-attack-the-premise`, `principle-boundary-discipline`, `principle-build-the-lever`, `principle-encode-lessons-in-structure`, `principle-exhaust-the-design-space`, `principle-experience-first`, `principle-explain-the-number`, `principle-fix-root-causes`, `principle-foundational-thinking`, `principle-guard-the-context-window`, `principle-laziness-protocol`, `principle-make-operations-idempotent`, `principle-migrate-callers-then-delete-legacy-apis`, `principle-minimize-reader-load`, `principle-model-the-domain`, `principle-never-block-on-the-human`, `principle-outcome-oriented-execution`, `principle-prove-it-works`, `principle-redesign-from-first-principles`, `principle-separate-before-serializing-shared-state`, `principle-sequence-verifiable-units`, `principle-subtract-before-you-add`, `principle-test-behavior-not-implementation`, `principle-type-system-discipline`.

## How the copies differ from upstream

The copies keep upstream's wording except where a term belongs to another host or to the rest of pstack:

- Subagent dispatch goes through `spider run` (scout or reviewer role, `context: "fresh"`, told not to edit files), shell commands through `spider exec`, search through `spider search`, and web pages through `spider fetch`.
- Skills name model roles ("a capable model") instead of model ids, and resolve them from `spider control models`.
- References to pstack skills that spider does not ship, to pstack's per-platform mappings, and to its model override sheet are removed or rewritten so each instruction stands on its own.
- `why` routes only to sources spider can reach: git and the codebase, GitHub through `gh`, past sessions and memory through `spider search`, and web pages through `spider fetch`. Its connector guides for other services are removed.
- `show-me-your-work` keeps its log under `.spider/scratch/`, and `scripts/log.sh` refuses to write anywhere else.
- Frontmatter carries only `name` and `description`. pi ignores upstream's `user-invocable: false`, so it is dropped from every skill.

[UPSTREAM.md](UPSTREAM.md) lists every upstream file and whether it is kept unchanged, changed, or removed.

## Tests

`src/__tests__/skills-guard.test.ts` pins the 31 skill names, checks each frontmatter, rejects other hosts' terms, unshipped pstack skill names, model names, and system temp paths, and checks that every relative link in the package resolves. `src/__tests__/log-script.test.ts` runs `scripts/log.sh` under bash, zsh, and sh.

## Upstream changes

New upstream commits are reviewed through spider's upstream-watch (the `upstream-watch` skill and `spider control upstream-watch`): it diffs upstream against the last reviewed commit and files a todo per commit. Review each change against [UPSTREAM.md](UPSTREAM.md), apply it by hand with the same adaptations, update the provenance table, and mark the new baseline. Nothing merges automatically.

## License

MIT. See [LICENSE](LICENSE), carried verbatim from upstream.

# @spider/pstack

This package vendors 33 pstack skills into spider, adapted to pi and the `spider` tool. Thirty-one come from [pstack-claude](https://github.com/michael-denyer/pstack-claude) at commit `046341e3aaf2405083973a37f860d0d2ea98e18a` (`plugins/pstack/skills/`). `ketchup` and `ketchup-video` come from Lauren Tan's official pstack plugin in [cursor/plugins](https://github.com/cursor/plugins) at commit `ca782ed8b3c2c521cead8e1720d55c3a5dbf2347` (`pstack/skills/`). The copies are edited in place, the same way `@spider/superpowers` keeps its skills.

## The skills

Nine working skills:

- `bro`: restate the last message in plain language.
- `how`: explain how a subsystem works, with parallel explorer subagents and one explainer.
- `ketchup`: catch up on this chat and the calls waiting on you. Run `/skill:ketchup`.
- `ketchup-video`: give the same catch-up as a subtitled video. Run `/skill:ketchup-video`.
- `show-me-your-work`: keep a TSV decision log under `.spider/scratch/` and audit it against the session transcript.
- `teach`: explain a body of work plainly, built on `how` and `why`.
- `technical-writing`: a layered standard for docs, PR descriptions, and commit messages.
- `unslop`: cut AI tells from writing.
- `why`: investigate why code has its shape, with one investigator per evidence source and a synthesizer.

Twenty-four engineering principles. Each is a short skill that an agent applies when the situation in its description comes up:

`principle-attack-the-premise`, `principle-boundary-discipline`, `principle-build-the-lever`, `principle-encode-lessons-in-structure`, `principle-exhaust-the-design-space`, `principle-experience-first`, `principle-explain-the-number`, `principle-fix-root-causes`, `principle-foundational-thinking`, `principle-guard-the-context-window`, `principle-laziness-protocol`, `principle-make-operations-idempotent`, `principle-migrate-callers-then-delete-legacy-apis`, `principle-minimize-reader-load`, `principle-model-the-domain`, `principle-never-block-on-the-human`, `principle-outcome-oriented-execution`, `principle-prove-it-works`, `principle-redesign-from-first-principles`, `principle-separate-before-serializing-shared-state`, `principle-sequence-verifiable-units`, `principle-subtract-before-you-add`, `principle-test-behavior-not-implementation`, `principle-type-system-discipline`.

## How the copies differ from upstream

The copies keep upstream's wording, except where a term belongs to another host or to the rest of pstack:

- Skills dispatch subagents through `spider run` (a scout or reviewer role, `context: "fresh"`, told not to edit files). The skills run shell commands through `spider exec`, search through `spider search`, and read web pages through `spider fetch`.
- Skills name model roles ("a capable model") instead of model ids, and resolve them from `spider control models`.
- References to pstack skills that spider does not ship, to pstack's per-platform mappings, and to its model override sheet were removed or rewritten, so each instruction makes sense without them.
- `why` routes only to sources spider can reach: git and the codebase, GitHub through `gh`, past sessions and memory through `spider search`, and web pages through `spider fetch`. Its connector guides for other services were removed.
- `show-me-your-work` keeps its log under `.spider/scratch/`, and `scripts/log.sh` refuses to write anywhere else.
- Frontmatter has `name` and `description`. The two ketchup skills also keep `disable-model-invocation: true`, so pi loads them only by command. The other skills drop upstream's `user-invocable: false`, which pi ignores.

[UPSTREAM.md](UPSTREAM.md) lists every upstream file and whether it is kept unchanged, changed, or removed.

## Tests

`src/__tests__/skills-guard.test.ts` checks the list of 33 skill names and each skill's frontmatter. It rejects terms from other hosts, names of pstack skills that spider does not ship, model names, and system temp paths. It also checks that every relative link in the package resolves. `src/__tests__/log-script.test.ts` runs `scripts/log.sh` under bash, zsh, and sh.

## Upstream changes

Review new pstack-claude commits with spider's upstream-watch (the `upstream-watch` skill and `spider control upstream-watch`). It diffs the port against the last reviewed commit and files one todo per commit. Review each change against [UPSTREAM.md](UPSTREAM.md), apply it by hand with the same adaptations, update the provenance table, and mark the new baseline. Nothing merges automatically. Check the official plugin separately for changes to `ketchup` and `ketchup-video`.

## License

MIT. See [LICENSE](LICENSE), carried verbatim from upstream.

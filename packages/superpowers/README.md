# @spider/superpowers

Vendors the [superpowers](https://github.com/obra/superpowers) skill library into spider, retargeted for pi and the `spider` tool. This package also owns the code that writes spider's managed block in `~/.pi/agent/AGENTS.md` and the upstream-watch logic behind `spider control upstream-watch`.

## Responsibility

This package owns:

- The skill files under `skills/`, one directory per skill.
- Reading and writing the delimited block in `~/.pi/agent/AGENTS.md` (`agentsmd.ts`, `agentsmd-content.ts`).
- Resolving which skill directories exist for a given project and handing their paths to the host (`skills-dir.ts`).
- Diffing a vendored subsystem's git history against a recorded commit and filing the result as todos (`upstream-watch.ts`).

It does not own the `spider skill` action itself (loading or invoking a skill at runtime is dispatched from the host and organism packages; this package only supplies file paths and the AGENTS.md text that tells the agent to use them). It does not merge upstream changes; `upstream-watch` only diffs and records, it never applies anything. It does not implement memory, search, todos, or subagent dispatch; the AGENTS.md content it writes describes how to use those, but the behavior lives in the other spider packages.

The 15 skills currently on disk under `skills/`:

- `brainstorming`
- `dispatching-parallel-agents` (dispatches through `spider run`)
- `executing-plans`
- `finishing-a-development-branch`
- `receiving-code-review`
- `requesting-code-review` (dispatches through `spider run`)
- `subagent-driven-development` (dispatches through `spider run`, `handoff:"intercom"`)
- `systematic-debugging`
- `test-driven-development` (runs suites through `spider exec`, dispatches through `spider run`)
- `upstream-watch` (the one skill here not vendored from upstream; documents this package's own review workflow)
- `using-git-worktrees`
- `using-superpowers` (the entry-point skill: load a matching skill before acting)
- `verification-before-completion`
- `writing-plans`
- `writing-skills`

The upstream package name and directory layout are kept as-is so diffs against `obra/superpowers` stay easy to read.

## Key modules

| File | What it does |
| --- | --- |
| `index.ts` | Re-exports the package's public surface and defines `registerSuperpowers()`, the function the host calls to wire this package in. |
| `agentsmd.ts` | Reads `~/.pi/agent/AGENTS.md`, inserts or replaces the text between `<!-- spider:start -->` and `<!-- spider:end -->`, and detects the legacy pre-spider "Agent operating guide" document so it gets replaced instead of duplicated. |
| `agentsmd-content.ts` | Holds the literal Markdown of the managed block (skills-first instructions, the list of `spider` verbs, slash commands, memory discipline, the scratch-directory rule) and `buildSpiderBlock()`, which wraps that text with the start and end markers. |
| `skills-dir.ts` | Locates the baseline `skills/` directory on disk, from either the source tree or the built bundle, locates the per-project skills directory (`<project>/.spider/skills`), and returns whichever of the two actually exist. |
| `upstream-watch.ts` | Diffs a vendored package's git log against its recorded `last_reviewed_commit`, turns new commits into cherry-pick todos, and reads/writes the global `upstream_refs` table. Also defines `DEFAULT_UPSTREAM_REFS`, the seed list of vendored subsystems and their upstream repo URLs. |
| `skills/*/SKILL.md` | The vendored skill content: instructions, and for some skills, supporting reference or template files. |

## Public surface

Main exports from `index.ts`:

| Export | Purpose |
| --- | --- |
| `registerSuperpowers(host, pi, opts?)` | Writes the AGENTS.md block once per process (unless `opts.skipAgentsMd`) and returns `{ skillPaths(cwd) }` for the host's `resources_discover` hook. |
| `writeAgentsMd(path)` | Reads the file at `path`, merges in the current managed block, writes it back only if it changed, and returns `{ path, action: "created" \| "updated" \| "unchanged" }`. |
| `defaultAgentsMdPath()` | Returns `~/.pi/agent/AGENTS.md`. |
| `upsertManagedBlock(existing, block)` | Inserts or replaces the delimited block inside `existing` text. |
| `isLegacyFiveToolGuide(existing)` | Detects the pre-spider "Agent operating guide (global)" document by its heading and a "Task tracking" section. |
| `buildSpiderBlock()` | Wraps `SPIDER_BLOCK_BODY` with `SPIDER_BLOCK_START` / `SPIDER_BLOCK_END`. |
| `SPIDER_BLOCK_START`, `SPIDER_BLOCK_END`, `SPIDER_BLOCK_BODY` | The literal marker strings and the block's Markdown body. |
| `baselineSkillsDir()` | Absolute path to this package's `skills/` directory, resolved for both the dev source layout and the bundled `dist/extension.js` layout. |
| `projectSkillsDir(cwd)` | `<cwd>/.spider/skills`. |
| `contributeSkillPaths(cwd)` | Returns the baseline and/or project skills directories, filtered to whichever exist on disk. |
| `diffUpstream(check, repoPath, git)` | Runs `git log` over the range since `check.lastReviewedCommit` and returns the new commits as `CherryCandidate` entries. |
| `runUpstreamWatch(globalDb, projectDb, sessionId, deps)` | Seeds `upstream_refs`, diffs every configured package, writes a todo (and its FTS row) for each new commit, and returns an `UpstreamWatchReport`. |
| `seedUpstreamRefs(globalDb)` | Inserts `DEFAULT_UPSTREAM_REFS` into `upstream_refs` where a row does not already exist. |
| `markReviewed(globalDb, pkg, sha)` | Records the commit a package was last reviewed at. |
| `DEFAULT_UPSTREAM_REFS` | The six vendored subsystems (`superpowers`, `memory`, `context`, `todo`, `subagents`, `db-core`) and their upstream repo URLs. |
| `GitRunner`, `UpstreamCheck`, `CherryCandidate`, `PackageResult`, `UpstreamWatchReport` | Supporting types for the upstream-watch functions. |

## How it fits

`package.json` declares dependencies on `@spider/db-core` and `@spider/ui`, and a peer dependency on `@earendil-works/pi-coding-agent`. Only `@spider/db-core` is referenced directly in `src/`, as the `Db` type used by the upstream-watch functions.

`@spider/host` depends on this package. Its `extension.ts` calls `registerSuperpowers()` once at activation (skipped when `VITEST=true`) to write `AGENTS.md`, and imports `runUpstreamWatch`, `markReviewed`, and `DEFAULT_UPSTREAM_REFS` to implement the `spider control upstream-watch` command. Host's `hooks.ts` imports `contributeSkillPaths` directly for its `resources_discover` handler.

This package is not on the path of an ordinary `spider` tool call. It runs at two points: once when the extension activates (writing `AGENTS.md` and registering the hook that will supply skill paths on demand), and whenever `spider control upstream-watch` runs. Separately, pi loads the baseline `skills/` directory directly through the root `package.json`'s `pi.skills` manifest entry, which does not go through this package's code at all.

## Notes

- The AGENTS.md write is best-effort and happens at most once per process: `registerSuperpowers` tracks a module-level flag and swallows any write error so a broken home directory never breaks extension activation.
- `upsertManagedBlock` only touches text between the markers. Content outside them, including anything a user added above or below the block, is left alone. If the file has no markers yet but matches the old "Agent operating guide (global)" heading plus a "Task tracking" section, the whole file is replaced instead of appending the new block after stale content.
- `baselineSkillsDir()` has to resolve from two different layouts: the source tree during development and tests, and the bundled `dist/extension.js` after a build. It probes both candidate paths for `using-superpowers/SKILL.md` and falls back to the dev path if neither is found. `contributeSkillPaths` only returns a directory that exists on disk.
- `runUpstreamWatch` writes new todos with raw SQL and inserts the matching `todos_fts` row itself, because the `todos` table has no trigger to keep that FTS index in sync. A todo inserted without the matching FTS insert would not appear in `spider search`.
- A configured package whose local checkout is missing, or whose git ref cannot be resolved, is recorded with an `error` field and skipped; it does not stop the rest of the packages from being checked.
- `upstream-watch` never merges anything. It only diffs commit ranges and files todos; moving `last_reviewed_commit` forward (`markReviewed`, via `spider control upstream-watch --mark <package> <sha>`) is a separate, explicit step taken after a human or agent has reviewed the candidates.
- `using-superpowers`'s `SKILL.md` and its `references/` folder are written for pi only: no other harness names appear in `SKILL.md`, and `references/` holds a single file, `pi-tools.md`, which maps skill actions to `spider` verbs. A few supplementary files bundled with other skills (for example `brainstorming/visual-companion.md`, `writing-skills/anthropic-best-practices.md`) still mention other tools in passing, as background material rather than instructions.

## See also

- [`../host/README.md`](../host/README.md): registers this package at activation and implements the `spider control upstream-watch` command.
- [`../db-core/README.md`](../db-core/README.md): supplies the `Db` type and the global registry database this package reads and writes.
- [`skills/using-superpowers/SKILL.md`](skills/using-superpowers/SKILL.md): the entry-point skill that governs skill discovery.
- [`skills/upstream-watch/SKILL.md`](skills/upstream-watch/SKILL.md): the review-and-cherry-pick workflow this package's `upstream-watch.ts` implements.

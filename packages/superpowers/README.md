# @spider/superpowers

This package vendors the [superpowers](https://github.com/obra/superpowers) skills into spider and discovers the 31 adapted [pstack](https://github.com/michael-denyer/pstack-claude) skills next to them. Both collections ship in npm packages. This package also writes the managed `AGENTS.md` block and implements `spider control upstream-watch`.

## Responsibility

This package owns:

- The skill files under `skills/`, one directory per skill.
- Reading and writing the delimited block in `~/.pi/agent/AGENTS.md` (`agentsmd.ts`, `agentsmd-content.ts`).
- Finding which skill directories exist for a given project and passing their paths to the host (`skills-dir.ts`).
- Fetching each vendored subsystem's configured upstream into a bare mirror for that package, diffing it against a recorded commit, and filing the result as todos (`upstream-watch.ts`).

It does not own the `spider skill` action itself. The host and organism packages load and invoke skills at runtime. This package only supplies the file paths and the AGENTS.md text that tells the agent to use them. It does not merge upstream changes. `upstream-watch` only diffs and records, and it never applies anything. It does not implement memory, search, todos, or subagent dispatch. The AGENTS.md content it writes describes how to use those features, but the other spider packages implement them.

These are the 15 skills on disk under `skills/` today:

- `brainstorming`
- `dispatching-parallel-agents` (dispatches through `spider run`)
- `executing-plans`
- `finishing-a-development-branch`
- `receiving-code-review`
- `requesting-code-review` (dispatches through `spider run`)
- `subagent-driven-development` (dispatches through `spider run`, `handoff:"intercom"`)
- `systematic-debugging`
- `test-driven-development` (runs suites through `spider exec`, dispatches through `spider run`)
- `upstream-watch` (the only skill here that is not vendored from upstream. It documents this package's own review workflow.)
- `using-git-worktrees`
- `using-superpowers` (the entry-point skill, which tells the agent to load a matching skill before acting)
- `verification-before-completion`
- `writing-plans`
- `writing-skills`

The package keeps the upstream package name and directory layout unchanged, so diffs against `obra/superpowers` stay easy to read.

## Key modules

| File | What it does |
| --- | --- |
| `index.ts` | Re-exports the package's public API and defines `registerSuperpowers()`, the function the host calls to connect this package. |
| `agentsmd.ts` | Reads `~/.pi/agent/AGENTS.md` and inserts or replaces the text between `<!-- spider:start -->` and `<!-- spider:end -->`. It detects the legacy "Agent operating guide" document from before spider, so it replaces that document instead of duplicating it. |
| `agentsmd-content.ts` | Holds the literal Markdown of the managed block (skills-first instructions, the list of `spider` verbs, slash commands, memory discipline, the scratch-directory rule). Also holds `buildSpiderBlock()`, which wraps that text with the start and end markers. |
| `skills-dir.ts` | Finds the baseline `skills/` directory on disk, in either the source tree or the built bundle. Finds the per-project skills directory (`<project>/.spider/skills`). Returns whichever of the two exist. |
| `upstream-watch.ts` | Fetches configured upstreams asynchronously into `~/.pi/agent/spider/upstream/<package>` and resolves refs there, never in spider's consumer checkout. Diffs against `last_reviewed_commit`, turns new commits into cherry-pick todos, and reads and writes the global `upstream_refs` table. Every Git call is bounded and gets non-interactive credential settings. Also defines `DEFAULT_UPSTREAM_REFS`, the seed list of vendored subsystems and their upstream repo URLs. |
| `skills/*/SKILL.md` | The vendored skill content: instructions and, for some skills, supporting reference or template files. |

## Public surface

These are the main exports from `index.ts`:

| Export | Purpose |
| --- | --- |
| `registerSuperpowers(host, pi, opts?)` | Writes the AGENTS.md block once per process (unless `opts.skipAgentsMd` is set) and returns `{ skillPaths(cwd) }` for the host's `resources_discover` hook. |
| `writeAgentsMd(path)` | Reads the file at `path`, merges in the current managed block, writes the file back only if it changed, and returns `{ path, action: "created" \| "updated" \| "unchanged" }`. |
| `defaultAgentsMdPath()` | Returns `~/.pi/agent/AGENTS.md`. |
| `upsertManagedBlock(existing, block)` | Inserts or replaces the delimited block inside the `existing` text. |
| `isLegacyFiveToolGuide(existing)` | Detects the "Agent operating guide (global)" document from before spider by its heading and a "Task tracking" section. |
| `buildSpiderBlock()` | Wraps `SPIDER_BLOCK_BODY` with `SPIDER_BLOCK_START` and `SPIDER_BLOCK_END`. |
| `SPIDER_BLOCK_START`, `SPIDER_BLOCK_END`, `SPIDER_BLOCK_BODY` | The literal marker strings and the Markdown body of the block. |
| `baselineSkillsDir()` | The absolute path to this package's `skills/` directory. It resolves for both the dev source layout and the bundled `dist/extension.js` layout. |
| `projectSkillsDir(cwd)` | `<cwd>/.spider/skills`. |
| `contributeSkillPaths(cwd)` | Returns the baseline skills directory, the project skills directory, or both, keeping only those that exist on disk. |
| `diffUpstream(check, repoPath, git)` | Resolves the configured upstream ref inside a fetched mirror and runs `git log` over the range since `check.lastReviewedCommit`. Returns an accurate package state and any `CherryCandidate` entries. |
| `runUpstreamWatch(globalDb, projectDb, sessionId, deps)` | Seeds `upstream_refs` and fetches every configured package into its mirror. Records `no-baseline`, `fetch-failed`, `unreachable`, `up-to-date`, or `candidates`. Writes a todo and its FTS row for each new commit, and returns an `UpstreamWatchReport`. |
| `seedUpstreamRefs(globalDb)` | Inserts `DEFAULT_UPSTREAM_REFS` into `upstream_refs` where no row exists yet. It does not overwrite configured URLs that already exist. |
| `markReviewed(globalDb, pkg, ref, deps)` | Validates `ref` in that package's fetched mirror, resolves it to a full commit SHA, and records that SHA as the reviewed baseline. It rejects unknown refs and leaves the baseline unchanged. |
| `DEFAULT_UPSTREAM_REFS` | The six vendored subsystems (`superpowers`, `memory`, `context`, `todo`, `subagents`, `pstack`) and their upstream repo URLs. |
| `GitRunner`, `UpstreamCheck`, `CherryCandidate`, `PackageResult`, `UpstreamWatchReport` | Supporting types for the upstream-watch functions. |

## How it fits

`package.json` declares dependencies on `@spider/db-core` and `@spider/ui`, and a peer dependency on `@earendil-works/pi-coding-agent`. Only `@spider/db-core` is referenced directly in `src/`, as the `Db` type that the upstream-watch functions use.

`@spider/host` depends on this package. Its `extension.ts` calls `registerSuperpowers()` once at activation to write `AGENTS.md`, except when `VITEST=true`. It imports `runUpstreamWatch` and `markReviewed` to implement the `spider control upstream-watch` command. The host's `hooks.ts` imports `contributeSkillPaths` directly for its `resources_discover` handler.

This package is not on the path of an ordinary `spider` tool call. It runs at two points. The first is once at extension activation. It writes `AGENTS.md` and registers the hook that supplies skill paths on request. The second is whenever `spider control upstream-watch` runs. Separately, pi loads the baseline `skills/` directory directly through the `pi.skills` manifest entry in the root `package.json`, which does not use this package's code at all.

## Notes

- The AGENTS.md write is best-effort and happens at most once per process. `registerSuperpowers` tracks a module-level flag and swallows any write error, so a broken home directory never breaks extension activation.
- `upsertManagedBlock` only changes text between the markers. It leaves content outside them alone, including anything a user added above or below the block. If the file has no markers yet but matches the old "Agent operating guide (global)" heading and has a "Task tracking" section, the whole file is replaced. The new block is not appended after stale content.
- `baselineSkillsDir()` has to resolve from two different layouts. One is the source tree during development and tests. The other is the bundled `dist/extension.js` after a build. It checks both candidate paths for `using-superpowers/SKILL.md` and falls back to the dev path if it finds neither. `contributeSkillPaths` only returns a directory that exists on disk.
- `runUpstreamWatch` writes new todos with raw SQL and inserts the matching `todos_fts` row itself, because the `todos` table has no trigger to keep that FTS index in sync. A todo inserted without the matching FTS insert would not appear in `spider search`.
- Every normal run fetches the `upstream_repo` stored in the global database into `~/.pi/agent/spider/upstream/<package>`. It checks up to four packages at the same time. It publishes results and todos in configured insertion order, which for default packages is the seed list order. Git runs asynchronously, with a 60-second timeout for fetches and a 10-second timeout for local plumbing commands. Credential and SSH prompts are off. A source that is unavailable or needs authentication fails with a reason, instead of blocking pi or showing a prompt in its TUI. A fetch failure, a timeout, or an unreachable ref is reported for that package, and the remaining checks continue.
- The state is `up-to-date` only when a baseline exists and the fetched upstream range is empty. A package without a baseline is `no-baseline`, even when it has zero candidates. Inspect the upstream, then set a baseline with `spider control upstream-watch --mark <package> <ref>`.
- `upstream-watch` never merges anything. It only fetches, diffs commit ranges, and files todos. Moving `last_reviewed_commit` forward is a separate review decision. `--mark` stores the resolved full SHA, not the text of a branch or tag.
- `pstack` starts at the vendored upstream commit `046341e`. `db-core` is first-party and is not watched, even if an older installation still has its row.
- The `SKILL.md` of `using-superpowers` and its `references/` folder are written for pi only. No other harness names appear in `SKILL.md`. `references/` holds a single file, `pi-tools.md`, which maps skill actions to `spider` verbs. A few supporting files that ship with other skills still mention other tools in passing, as background material and not as instructions. Examples are `brainstorming/visual-companion.md` and `writing-skills/anthropic-best-practices.md`.

## See also

- [`../host/README.md`](../host/README.md) registers this package at activation and implements the `spider control upstream-watch` command.
- [`../db-core/README.md`](../db-core/README.md) supplies the `Db` type and the global registry database that this package reads and writes.
- [`skills/using-superpowers/SKILL.md`](skills/using-superpowers/SKILL.md) is the entry-point skill that governs skill discovery.
- [`skills/upstream-watch/SKILL.md`](skills/upstream-watch/SKILL.md) describes the review-and-cherry-pick workflow that this package's `upstream-watch.ts` implements.

# @spider/superpowers

The [superpowers](https://github.com/obra/superpowers) skill library, **vendored
into spider** and retargeted to pi + the `spider` mega-tool.

## What this is

- **15 skills** (14 upstream + `upstream-watch`) shipped as static Markdown under
  `skills/`. The upstream package name is kept deliberately so upstream diffs stay
  clean (`spider control upstream-watch` reviews them).
- **pi-only.** All non-pi harness artifacts (Claude Code / Codex / Copilot / Gemini
  / Antigravity tool refs, plugin/hook manifests) are stripped. The only surviving
  tool reference is `using-superpowers/references/pi-tools.md`, which leads with the
  `spider` verbs.
- **Auto-wake native.** `subagent-driven-development`, `test-driven-development`,
  `dispatching-parallel-agents`, and `requesting-code-review` dispatch via
  `spider run` and push-based `handoff:"intercom"` pipelines.

## AGENTS.md is spider-managed

`registerSuperpowers()` writes a single delimited block into
`~/.pi/agent/AGENTS.md`:

```
<!-- spider:start -->
… folded skills-first + spider-tooling + memory-discipline preamble …
<!-- spider:end -->
```

Edit **only outside** the markers — anything between them is overwritten on
upgrade. The manager is idempotent, preserves your content, and replaces the
legacy pre-spider "Agent operating guide" wholesale.

## Skill discovery

Two tiers are contributed via the host's `resources_discover` hook:

1. **Baseline** — this package's `skills/` (read-only, in-package).
2. **Project** — `<project>/.spider/skills/` (the AI-authored, curator-managed
   tier), contributed only when it exists.

Pi also loads the baseline directly via the package `pi.skills` manifest entry.

## Strangler cutover (Phase 7)

When this package lands, the standalone `guru-irl/superpowers` pi adapter
(`.pi/extensions/superpowers.ts`, an always-on `context`-injection bootstrap) is
**deprecated for spider users**. Spider owns skill discovery and the always-on
AGENTS.md preamble; `using-superpowers` is discoverable-only (no forced
injection). Dynamic per-session memory injection stays in the host's
`before_agent_start` hook (Phase 1/6), not in this static file.

## Upstream watch

Run `spider control upstream-watch` to diff each vendored subsystem against its
upstream ref, surface new commits as cherry-pick todos, and record review state
in the global `upstream_refs` table. It never does a live merge — every candidate
is a human/agent decision. Record progress with
`spider control upstream-watch --mark <package> <sha>`.

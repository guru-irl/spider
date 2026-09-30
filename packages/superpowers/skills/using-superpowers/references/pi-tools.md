# Pi Tool Mapping

Skills speak in actions ("dispatch a subagent", "create a todo", "run a
command", "remember a fact"). On pi with spider installed, these resolve to the
single `spider` mega-tool first; pi's lowercase built-ins are the low-level
fallback.

| Action skills request | spider verb (primary) | pi built-in (fallback) |
| --- | --- | --- |
| Search memory / code / sessions / todos | `spider search` | `grep` / `find` |
| Remember a durable fact | `spider remember` (staged if `[auto]`) | — |
| Recall stored facts | `spider recall` | — |
| Run a shell command | `spider exec` / `spider batch` | — (`bash` is blocked) |
| Analyze a large file without editing | `spider exec_file` | `read` (only if you will edit) |
| Index / fetch docs for search | `spider index` / `spider fetch` | — |
| Dispatch a subagent | `spider run` (single/chain/parallel/async, `context:"fresh"\|"fork"`) | — |
| Observe subagent completion | asynchronous `spider.subagent_done` message, no wait/poll | — |
| Hand a finished stage to the next agent | `spider run { pipeline:[...], handoff:"intercom" }` | — |
| Task tracking (create/mark a todo) | `spider todo` (`list`/`add`/`toggle`/`clear`/`sessions`/`view`) | plan file / `TODO.md` |
| Invoke / distill a skill | `spider skill` | `read` the `SKILL.md` |
| Import a past session | `spider import` | — |
| Admin (stats/doctor/upstream-watch/memory/config) | `spider control <command>` | — |

## Read vs edit

Use `read` (not `spider exec_file`) when you are about to `edit` a file — the
`edit` tool must match exact text. Use `spider exec_file` only when you want
facts about a file you will **not** modify. `spider exec` is the shell; `bash` is blocked. Use `spider batch` for
multiple commands. Large output stays sandboxed and only what you print/query
enters context.

## Skill discovery

Pi scans `~/.pi/agent/skills/`, `~/.agents/skills/`, trusted project
`.pi/skills/` in cwd only and `.agents/skills/` in cwd/ancestors up to the
git root (or filesystem root when not in a repo), package `skills/` or
`pi.skills`, the settings `skills` array, and additive CLI `--skill <path>`.
Load the matching `SKILL.md` with `read` when `spider skill` is unavailable.

## Subagents and auto-wake handoff

`spider run` starts children in the background; completion is pushed as a
`spider.subagent_done` message. There is no blocking wait and no poll. Pass
an explicit provider-qualified `model:` on **every** run, obtained for its
role from `spider control models` (explicit model, worktree-local override,
global default, then parent model). For multi-phase work use
`spider run { pipeline:[stageA, stageB], handoff:"intercom" }`: each stage is
a **fresh** child with the prior stage's output, not a resumed process. Each
stage specifies its own model, context and `thinking`. Set `thinking` on
EACH parallel, chain or pipeline item; top-level `thinking` applies only to
single runs. `spider message { to, message }`
delivers to a live peer session; a headless child cannot be messaged or
redirected, whether already running or finished. A fix means a fresh run
from the partial tree, not a message to the original worker.

## Memory discipline

Memory is DB-as-truth: `spider remember` stores structured truths that **link
to** files/skills — never duplicate a doc or commit history. Background/`[auto]`
writes are staged (fail-closed); approve with `spider control memory`.

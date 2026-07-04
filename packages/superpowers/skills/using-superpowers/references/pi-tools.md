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
| Run a command over large output | `spider exec` / `spider batch` | `bash` |
| Analyze a large file without editing | `spider exec_file` | `read` (only if you will edit) |
| Index / fetch docs for search | `spider index` / `spider fetch` | — |
| Dispatch a subagent | `spider run` (single/chain/parallel/async, `context:"fresh"\|"fork"`) | — |
| Await subagents | `spider wait` | — |
| Hand a finished stage to the next agent | `spider run { pipeline:[...], handoff:"intercom" }` / `spider message` | — |
| Task tracking (create/mark a todo) | `spider todo` (`list`/`add`/`toggle`/`clear`/`sessions`/`view`) | plan file / `TODO.md` |
| Invoke / distill a skill | `spider skill` | `read` the `SKILL.md` |
| Import a past session | `spider import` | — |
| Admin (stats/doctor/upstream-watch/memory/config) | `spider control <command>` | — |

## Read vs edit

Use `read` (not `spider exec_file`) when you are about to `edit` a file — the
`edit` tool must match exact text. Use `spider exec_file` only when you want
facts about a file you will **not** modify. Prefer `spider exec` / `spider batch`
over raw `bash` whenever output could exceed ~10 lines: the bytes stay sandboxed
and only what you print/query enters context.

## Subagents & auto-wake handoff

`spider run` spawns subagents (single, chain, parallel, async, forked context)
and persists them for the live agents footer/grid. For multi-phase work, prefer
push-based handoff: `spider run { pipeline:[stageA, stageB], handoff:"intercom" }`
wakes each next stage with the previous stage's outputs instead of the blocking
spawn→wait→process→spawn-next cycle. Use `spider message { to, message }` to wake
a specific peer/reviewer directly.

## Memory discipline

Memory is DB-as-truth: `spider remember` stores structured truths that **link
to** files/skills — never duplicate a doc or commit history. Background/`[auto]`
writes are staged (fail-closed); approve with `spider control memory`.

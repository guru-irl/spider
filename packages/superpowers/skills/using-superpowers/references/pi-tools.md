# Pi Tool Mapping

Skills speak in actions ("dispatch a subagent", "create a todo", "read a file"). On Pi these resolve to the tools below.

| Action skills request | Pi equivalent |
| --- | --- |
| Invoke a skill | Pi native skills: load the relevant `SKILL.md` with `read`, or let the human use `/skill:name` |
| Read a file | `read` |
| Create a file | `write` |
| Edit a file | `edit` |
| Run a shell command | `bash` |
| Search file contents | `grep` when active; otherwise `bash` with `rg`/`grep` |
| Find files by name | `find` or `bash` with shell globs |
| List files and subdirectories | `ls` when active; otherwise `bash` with `ls` |
| Dispatch a subagent (`Subagent (general-purpose):` template) | Use an installed subagent tool such as `subagent` from `pi-subagents` if available |
| Task tracking ("create a todo", "mark complete") | The `todo` tool from `pi-todo-sqlite` (`list`, `add`, `toggle`, `clear`, `sessions`, `view`; durable, scoped per-project + per-session, mirrored into context-mode) if installed; otherwise track tasks in the plan or `TODO.md` |
| Process large command/file output | Context-mode (`ctx_*`) tools — see [Context-mode](#context-mode-token-performance) |

## Skills

Pi discovers skills from configured skill directories and installed Pi packages. A Superpowers Pi package should expose `skills/` through its `pi.skills` manifest entry. Pi does not expose Claude Code's `Skill` tool, but the agent should still follow the Superpowers rule: when a skill applies, load and follow it before responding.

## Subagents

Pi core does not ship a standard subagent tool. The `pi-subagents` package is a strong optional companion and provides a `subagent` tool with single-agent, chain, parallel, async, forked-context, and resume/status workflows. If no subagent tool is available, do not fabricate `Task` calls; execute sequentially in the current session or explain that the optional subagent capability is not installed.

## Task lists

Pi core does not ship a standard task-list tool. The
[`pi-todo-sqlite`](https://github.com/guru-irl/pi-todo-sqlite) extension adds a
`todo` tool with actions `list`, `add` (text), `toggle` (id), `clear`,
`sessions`, and `view` (session). Todos are durable (SQLite-backed) and scoped
per-project **and per-session** — each session keeps its own list, and the
session key is auto-derived (you never pass it for add/toggle/clear/list). Use it
for the "create a todo" / "mark complete" actions (e.g. one todo per checklist
item in a skill, toggled as you complete each). To pick up work started in a
prior session, run `sessions` for an overview, then `view` (passing a session
id/prefix/name or `"all"`) to read it read-only, then re-`add` the relevant items
into your own session. Todos mirror into context-mode (all sessions grouped), so
`ctx_search` can surface them; view them anytime with `/todos` (press `a` for an
all-sessions view). If no todo extension is installed, use Superpowers plan
files, checklists in Markdown, or a repo-local `TODO.md`. Older Superpowers docs
may refer to `TodoWrite`; treat that as the task-tracking action above.

## Context-mode (token performance)

If the `context-mode` package is installed, Pi exposes `ctx_*` tools that process
large output in a sandbox and return only what you print or query — the raw bytes
never enter the conversation. Prefer them over plain `read`/`bash` whenever the
output would be large, so Superpowers workflows stay cheap on tokens. They are
optional: if context-mode is not installed, fall back to `read`/`bash` and just
be selective about what you pull in. The
[`pi-ctx-ui`](https://github.com/guru-irl/pi-ctx-ui) local extension is an
optional add-on that gives each `ctx_*` tool a nicer per-command call/result row
(queries, path, language, command labels, URLs, source) — cosmetic only; routing
below is unchanged whether or not it is installed.

Routing rules:

| Instead of | Use | When |
| --- | --- | --- |
| `read` a large file to inspect/summarize | `ctx_execute_file` | You want facts about a file (counts, matches, parsed structure) and will not edit it |
| `read` then edit | `read` (so `edit` can match exact text) | You will modify the file |
| `bash` over big output (`git diff`, test runs, logs) | `ctx_execute` | You derive an answer from the output (filter / count / aggregate) |
| Several related commands + a question | `ctx_batch_execute` | 3+ commands you would run sequentially, optionally with `queries` |
| `WebFetch` / `WebSearch` | `ctx_fetch_and_index` then `ctx_search` | Web docs / specs / changelogs |
| Re-reading the same plan/spec repeatedly | `ctx_index` once, then `ctx_search` | A plan, spec, or doc you query many times |

Concrete Superpowers usages:

- **Reviewer diffs:** have reviewer subagents inspect via
  `ctx_execute("git diff BASE..HEAD | <filter>")` or `ctx_execute_file`, not a
  raw `read` of the whole diff.
- **Test output:** run suites through `ctx_execute` and print only
  failures/summary, e.g. `npm test 2>&1 | grep -E '(FAIL|✗|Error:|Tests)'`.
- **Plan execution:** `ctx_index` the plan once at the start, then `ctx_search`
  per task instead of re-reading the whole plan each time (still paste the full
  task text into each subagent prompt).
- **Recon:** prefer `ctx_execute` / `ctx_batch_execute` for repo-wide greps and
  structure surveys over reading many files.

Subagents launched via `subagent(...)` also have context-mode available when it
is installed; when a child's command or file output is likely large, tell it in
the task prompt to use `ctx_execute` / `ctx_execute_file`.

# Using spider

This is a practical guide to working with spider day to day. Spider is one pi
coding-agent extension. It gives the agent memory, unified search, todos,
subagents, sandboxed execution, web fetch, and a skills library, all on one
shared SQLite database. Everything runs through a single tool named `spider`
with an `action` parameter, plus a handful of slash commands.

The advice below is about habits: which action to reach for, when to keep bytes
out of the model context, how to keep memory clean, and how to set spider up
once so it stays out of your way.

## Load a skill before non-trivial work

Spider ships a skills library (the superpowers package). A skill is a written
procedure for a class of task: brainstorming a feature, debugging
systematically, writing a plan, running tests first, reviewing code. The managed
`AGENTS.md` block tells the agent to load a skill before acting whenever one
might apply.

Follow that rule yourself when you direct the agent. If there is a plausible
match, load the skill first, then act. Start with a process skill (for example
`brainstorming` or `systematic-debugging`), then move to an implementation skill
(for example `test-driven-development`, `writing-plans`, or
`requesting-code-review`). Load a skill by reading its `SKILL.md`, or through the
skill action:

```
spider skill list
```

A skill is a checklist to follow, not background reading. If a skill says write
the test first, write the test first.

## Route large output through exec, exec_file, and batch

The default cost of running a command the normal way is that its whole output
lands in the model context and stays there for the rest of the conversation. A
wide `git log`, a full test run, or a repo-wide grep can spend thousands of
tokens you never look at again.

Use `spider exec` instead whenever the output could run past roughly ten lines.
The command runs in a sandbox in the project directory. The full result is
stored, and only the slice you print comes back into context (capped at 200,000
bytes):

```
spider exec language:"shell" code:"git log --oneline -20"
```

For a large file, use `spider exec_file`. It preloads the file content into a
variable so you can filter or summarize it in code and print only what matters,
instead of reading the whole file into context:

```
spider exec_file path:"build/output.log" language:"python" code:"print([l for l in DATA.splitlines() if 'ERROR' in l][:20])"
```

For several related commands, use `spider batch` so they run in sequence and you
get one combined, capped result:

```
spider batch commands:'[{"language":"shell","code":"node -v"},{"language":"shell","code":"npm test 2>&1 | tail -30"}]'
```

A plain `read` is still the right call in one case: when you are about to `edit`
the file. An `edit` has to match the exact text on disk, so read the real
content first. Use `read` to edit; use `exec` or `exec_file` to inspect.

## Index reference material once, then search

Reading the same file or doc set again on every question is wasteful. Index it
once. `spider index` chunks a file or directory into the content store and
queues each chunk for embedding. The action returns a count, not the content:

```
spider index path:"docs/"
```

`spider fetch` does the same for a URL: it downloads the page, converts it to
markdown, caches it, and indexes it.

```
spider fetch url:"https://example.com/api-reference"
```

Once material is indexed, retrieve slices with `spider search` instead of
re-reading. Search runs a full-text query and a vector query across memory,
indexed content, sessions, and todos, fuses the results, and returns short
snippets:

```
spider search query:"how does the retry backoff work"
```

Reach for search before you re-open a file you have already seen. Re-indexing
the same source overwrites its old chunks, so indexing a changed directory again
is safe.

## Keep memory clean

Memory holds structured, categorized notes about the project or your
preferences. Use it for durable truths, not for a copy of a document or a commit
log. Each note has one of six categories: `preference`, `convention`,
`tool-quirk`, `failure`, `correction`, `insight`.

Write a note that links to the file or skill it is about, rather than pasting the
content:

```
spider remember category:"convention" content:"Run the test gate with 'yarn fast'; see package.json scripts" link:"package.json"
```

Two rules keep the store useful:

- **Approve or reject staged writes.** A foreground `remember` you make yourself
  activates immediately. Background and auto-captured writes (including anything
  the organism proposes after a session) are staged and fail closed: they do not
  become active until a human approves them. Review them with the memory control
  command, which lists pending writes and lets you approve or reject each one:

  ```
  spider control memory pending
  spider control memory approve <id>
  spider control memory reject <id>
  ```

  Rejecting is not destructive. A rejected note stays in the table, out of the
  active set. Look at the pending list from time to time so staged notes do not
  pile up unreviewed.

- **Respect the active cap.** Active memory content is capped at 8,000
  characters per scope (project and global are counted separately). A write that
  would push a scope over the cap is refused rather than truncated, and an
  approval can fail for the same reason if the scope filled up while the note was
  staged. Keep notes short and prune stale ones so the budget stays for what
  matters.

Read memory back with `spider recall`, filtered by category or scope, or browse
it with the `/memory` slash command.

The active set is assembled into a snapshot and injected into the system prompt
at the start of each turn. A note approved mid-session takes effect on the next
turn, not the current one.

## Dispatch subagents for parallel or multi-phase work

`spider run` dispatches a task to a child pi process. The child runs in the
background and reports back through a `spider.subagent_done` message that wakes
your session when it finishes. There is no blocking wait, so you can keep working
while it runs.

Two things matter when you dispatch:

- **Pick a model that fits the task, and qualify it with a provider.** Use a
  cheaper model for mechanical work and a more capable one for architecture or
  review. Pass the model id with its provider prefix (for example
  `github-copilot/claude-sonnet-5`), because a bare id can resolve to a provider
  the child is not authenticated for, and a child that fails at startup reports
  "done" with no output. Set a thinking level to match the difficulty.

  ```
  spider run agent:"worker" task:"Add a --dry-run flag to the export command and a test for it" model:"github-copilot/claude-sonnet-5" thinking:"medium"
  ```

- **Use a pipeline for worker-then-reviewer.** A pipeline chains one stage to the
  next and hands the first stage's result to the second over an intercom message.
  Give a review-only stage fresh context and tell it not to edit source, so it
  reads the work with no memory of having written it:

  ```
  spider run pipeline:'[{"agent":"worker","task":"Implement the parser change"},{"agent":"reviewer","task":"Review {previous} against the spec; do not edit source","context":"fresh"}]' handoff:"intercom" model:"github-copilot/claude-opus-4.8" thinking:"high"
  ```

For several independent tasks with no shared state, dispatch them in parallel
with `tasks:[...]`. For strictly sequential steps that each build on the last,
use `chain:[...]`, where a step's task text can reference `{previous}`.

## Track work with todos

Todos are durable and scoped to the project and the session. Use one todo per
checklist item, and toggle each as you finish it, so the list reflects real
progress rather than intent.

```
spider todo op:add text:"Write the failing test for the retry path"
spider todo op:list
spider todo op:toggle id:<id>
```

`op:sessions` lists which sessions have todos, and `op:view` shows another
session's list. The `/todos` slash command opens a live overlay of the same
data.

## Slash commands

Slash commands are a thin front for the same actions and render through the same
themed cards a tool result uses. Two open live overlays; the rest forward to an
action and show its result.

| Command | What it shows |
| --- | --- |
| `/todos` | Live overlay of the current todos. |
| `/agents` | Live overlay of running and finished subagents. |
| `/spider` | The dashboard (token savings and row counts). |
| `/search <query>` | Unified search results. |
| `/memory` | Browse active memory. |
| `/insights` | The learning graph of skills and memories. |
| `/learn <note>` | Distill a skill from the current conversation. |
| `/doctor` | A health check of the install. |
| `/stats` | Token savings and row counts. |

## Recommended global setup

Set spider up once for a stable global install.

- **Install the extension into `~/.pi/agent`.** From the spider repo, build the
  bundle and run the link script. It writes a shim at
  `~/.pi/agent/extensions/spider.ts` that points at the repo's built
  `dist/extension.js`. pi discovers it globally, so every project gets spider.

  ```
  npm run build
  npm run link
  ```

  After linking, run `/reload` in an interactive pi or relaunch. Use
  `npm run unlink` to remove the shim. (For working on spider itself against a
  live tree, use `npm run dev:link` instead, which hot-reloads on rebuild.)

- **Let spider manage its `AGENTS.md` block.** Spider writes and updates a block
  in `~/.pi/agent/AGENTS.md` between `<!-- spider:start -->` and
  `<!-- spider:end -->`. That block carries the skills-first rule and the summary
  of the spider actions. Do not edit inside the markers; edits there are
  overwritten on upgrade. Put your own notes outside the markers.

- **Keep the companion pi packages installed.** Spider works with the pi packages
  under `~/.pi/agent/npm` (for example `pi-intercom`, which the subagent handoff
  uses). Leave them in place so subagent messaging and the prompt-template
  features keep working.

The global registry database lives at `~/.pi/agent/spider/spider.db`. It tracks
every project spider has seen and holds global-scope memory and skills.

## Recommended per-project setup

Each project gets a `.spider/` directory the first time spider runs there. It
holds the per-project database (`.spider/project.db`), the scratch area, and the
project's skills.

- **Put all scratch under `.spider/scratch`.** Never write scratch, golden data,
  or logs to `/tmp`, `$TMPDIR`, or `/var/tmp`. Those are volatile and can be
  cleared mid-task, which destroys baselines you are comparing against. The
  sandbox already runs `exec` scripts and caches fetched pages under
  `.spider/scratch`; keep your own intermediate files there too. Use
  `~/.pi/agent/spider/scratch/` for work that is not tied to a project.

- **Index the project's reference material once.** Point `spider index` at the
  docs directory (and any other reference you consult repeatedly) at the start of
  work, then use `spider search` from then on:

  ```
  spider index path:"docs/"
  spider search query:"deployment steps for staging"
  ```

  Indexed content lives in the per-project database and is retrievable in later
  sessions, so you index once and search many times.

## See also

- [`../architecture/README.md`](../architecture/README.md): the one-tool model,
  the layered packages, the shared database, and how one call flows.
- [`../architecture/feedback-and-learning-loops.md`](../architecture/feedback-and-learning-loops.md):
  the routing, memory, organism, and subagent loops behind the habits above.
- [`../../README.md`](../../README.md): what spider is, install and build, and
  the package map.

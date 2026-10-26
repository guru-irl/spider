# Using spider

- Start with the [README](../../README.md) for installation and the list of actions.
- Run `/doctor` after you install, rebuild, or update.
- Ask the agent to use the single `spider` tool. The examples below are written as tool calls, not terminal commands.

## Skills first

- If a skill's trigger applies, load the skill before you start non-trivial work.
- Start with a process skill such as `brainstorming` or `systematic-debugging`. Then use implementation skills such as `test-driven-development` or `writing-plans`.
- Spider bundles the superpowers workflow skills and 31 adapted pstack skills. From pstack, use `how`, `why` and `teach` to explain code, `unslop` and `technical-writing` for prose, and a `principle-*` skill when its description matches a decision.
- To list skills, run `spider skill op:"list"`. To see one, run `op:"view" name:"<name>"`, or read its `SKILL.md`.
- List and view label each skill's source as `bundled superpowers`, `bundled pstack`, or `project/agent-created`. If two sources share a name, both entries appear. Spider reads bundled skills from disk and never stores them as curation candidates.
- `/doctor` reports each bundled skills folder it resolved and how many skills it holds.
- Follow the skill's whole procedure, not only its summary.
- [Data and privacy](../../README.md#data-and-privacy) covers the global managed instructions and where to keep personal notes.

## Execution

- Use `exec` when a command might print a lot. Filter the output inside the script, so that only the text you select enters the model's context.
- Execution is not an operating-system security boundary. Scripts can run commands with your user's permissions.
- The built-in bash tool is blocked by default. The [user-only enforcement command](../../README.md#slash-commands-and-overlays) describes the local scope and how state is reported.
- By design, the message that blocks bash does not explain how to turn enforcement off. It points the agent to spider execution.

```text
spider exec language:"shell" code:"git log --oneline -20"
spider exec_file path:"build/output.log" language:"python" code:"print([line for line in FILE_CONTENT.splitlines() if 'ERROR' in line][:20])"
spider batch commands:[{language:"shell",code:"node -v"},{language:"shell",code:"git diff --stat"}]
```

- `exec_file` gives the script the file as `FILE_CONTENT`, and its path in `FILE_CONTENT_PATH`.
- `batch` runs commands one after another and combines their results, each capped.
- Use a plain `read` before an edit that must match exact text. For inspection that needs filtering, use execution or indexed search.
- Exec action output is capped at `10000` bytes, so printing a whole log does not get around context limits.

### Background execution

- `background:true` writes stdout and stderr to durable files from the moment the process starts.
- If you pass `timeout` in milliseconds, a process that is still running detaches when the timeout runs out. Without a timeout, the call waits for the process to exit.
- `exitCode:null` means the process is still running or its outcome is unknown. It does not mean success. Read the returned `backgroundJob` paths to find the logs and the receipt.
- The receipt is the source of truth for how the process ended. A failed command is not a successful sample.
- Keep durable working files in `.spider/scratch/`. Each call gets a temporary scratch directory that is deleted when the call ends, so jobs launched separately must not depend on it.
- [Context package](../../packages/context/README.md) documents the receipt schema, output limits, supported languages and how long files are kept.

## Index and search

- Index reference material once, then search it instead of reading it again and again.
- `fetch` downloads pages, converts them, caches them and indexes them. It takes one URL or a batch of requests.
- Search combines full-text and vector matches across memory, indexed content, sessions and todos. Vector search works only when the native modules and the embedder are available.
- When a source changes, index it again to replace its chunks.

```text
spider index path:"docs/"
spider fetch url:"https://example.com/api-reference"
spider search query:"retry backoff" kinds:["content","memory"]
```

## Memory

- Remember durable facts, with a justification and a link to the source. Keep task progress in todos or in the conversation.
- Use global scope only when the fact holds in every repo. Otherwise use repo scope.
- Review staged writes with `control memory sub:"pending"`, then approve or reject each one.
- [Memory and learning](memory-and-learning.md) covers storage caps, injection, reviewers and skill staging.

## Todos

- Use one todo for each open checklist item, and toggle it as soon as the item is done.
- `id` is the per-session sequence number that the list returns. It is not a run ID.

```text
spider todo op:"add" text:"Write the retry regression test"
spider todo op:"list"
spider todo op:"toggle" id:"1"
spider todo op:"remove" id:"2"
```

- `remove` deletes items that are no longer needed. `clear` removes only done items and reports how many it removed and how many open items it kept.
- `clear force:true` removes every item in the current session. Clear rejects session selectors.
- `sessions` lists the sessions that have todos. `view session:"<selector>"` shows another session's list, and `session:"all"` works too.
- `toggle` and `remove` take an `id` (the sequence number within the session) and an optional `session`. The session can be a session ID, a unique prefix, or a unique name in this project database. Without a session, they act on the current session.
- Changes are rejected for `session:"all"`, for selectors that match no session or more than one, and for missing or unknown IDs.
- `/todos` opens the live overlay.

## Subagents

- Use parallel tasks for independent work, chains for steps that must run in order, and pipelines when each step should continue in a fresh child.
- Pick models that are qualified with their provider and have working credentials. When you dispatch several items, set the thinking level on each item.
- When several writers run at once, give each its own worktree and its own dependencies.
- Use `/agents` to inspect results. Use `message` only when the run's mode and delivery state allow it. A completed run cannot resume.
- [Subagents](subagents.md) covers examples, model resolution, shutdown, survival across reloads, escalation and evidence of message delivery.

## Loops and scheduled wakeups

- Use `loop` and `schedule` to wait on external work such as CI, deploys, or timers. Do not poll subagents. Their completion notices arrive on their own.
- `/loop 5m <prompt>` runs now, then keeps one occurrence due while busy and advances to the next anchored time after delivery. `/loop <prompt>` is self-paced; its re-arm must pass `name:"loop"`. Named cron triggers, such as `cron:"0 8 * * *" tz:"Asia/Kolkata"`, start at their next occurrence, not immediately.
- Names replace only themselves. Defaults are `loop` and `wakeup`. `spider schedule` accepts a relative `delaySeconds` or offset-bearing `at`. `spider loop` without definition fields lists all triggers. Tool loop stop leaves the independent `wakeup` intact. `/loop stop` stops both defaults; `/loop stop <name>` stops one and `/loop stop all` stops every trigger. Extra stop words are never a self-paced prompt.
- These actions need a persistent top-level session. Definitions survive `/reload` and same-session resume; new sessions and forks start empty. Nothing fires while closed or asleep. Missed one-shot and cron triggers fire once, late. Intervals resume from their anchor without catch-up.
- [Loops and scheduled wakeups](loop-and-schedule.md) covers the parameters, how delays are clamped, replacement, and what happens when a loop stops during a run.

## Project setup

- Keep local databases, config, logs and scratch files out of commits. Use `.spider/scratch/` for project work, or `~/.pi/agent/spider/scratch/` for global work.
- Index the documentation you use often when you start a project.
- Worktree state and shared repository memory live in different database tiers. See [Data model](../architecture/data-model.md).
- `/bind <path>` turns a session started outside git into a worktree session. It does not automatically switch a session that already has a conflicting git context.
- `pi-intercom` is optional. It adds messaging between sessions, and owned RPC steering and pipeline handoff do not need it.
- Set the flat dotted keys as described in [Configuration](configuration.md). To diagnose a mismatch in the loaded bundle, use [Runtime lifecycle](../architecture/runtime-lifecycle.md).

## See also

- [Documentation index](../README.md).
- [Architecture overview](../architecture/README.md).
- [Feedback and learning loops](../architecture/feedback-and-learning-loops.md).
- [Contributing](../../CONTRIBUTING.md).

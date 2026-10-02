# Using spider

- Start with the [README](../../README.md) for installation and the action list.
- Run `/doctor` after installing, rebuilding, or updating.
- Ask the agent to use the single `spider` tool; the examples below are tool-call notation, not terminal commands.

## Skills first

- Load a skill before non-trivial work when its trigger applies.
- Start with a process skill such as `brainstorming` or `systematic-debugging`, then implementation skills such as `test-driven-development` or `writing-plans`.
- List skills with `spider skill op:"list"`; view one with `op:"view" name:"<name>"`, or read its `SKILL.md`.
- Follow the procedure, not only its summary.
- See [Data and privacy](../../README.md#data-and-privacy) for the global managed instructions and where to keep personal notes.

## Execution

- Use `exec` when command output could be large. Filter output inside the script so only selected text enters model context.
- Execution is not an OS security boundary: scripts can run commands with your user's permissions.
- The built-in bash tool is blocked by default. See the [user-only enforcement command](../../README.md#slash-commands-and-overlays) for local scope and state reporting.
- The bash block message intentionally does not explain how to disable enforcement; it directs the agent to spider execution.

```text
spider exec language:"shell" code:"git log --oneline -20"
spider exec_file path:"build/output.log" language:"python" code:"print([line for line in FILE_CONTENT.splitlines() if 'ERROR' in line][:20])"
spider batch commands:[{language:"shell",code:"node -v"},{language:"shell",code:"git diff --stat"}]
```

- `exec_file` exposes the file as `FILE_CONTENT` (path in `FILE_CONTENT_PATH`).
- `batch` executes commands sequentially and combines capped results.
- A plain `read` is appropriate before an exact-text edit. Use execution or indexed search for inspection that needs filtering.
- Exec action output is capped at `10000` bytes; printing the entire log does not avoid context limits.

### Background execution

- `background:true` writes stdout/stderr to durable files from launch.
- With `timeout` in milliseconds, a still-running process detaches when that timeout expires. Without a timeout, the call waits for its real exit.
- `exitCode:null` means running or unknown, not successful. Read the returned `backgroundJob` paths for logs and the receipt.
- The receipt is the source of truth for the process outcome; a failed command is not a successful sample.
- Keep durable working files in `.spider/scratch/`. A per-call temporary scratch directory is cleaned when the call ends; independently launched jobs must not depend on it.
- For the receipt schema, output limits, supported languages, and retention contract, see [Context package](../../packages/context/README.md).

## Index and search

- Index reference material once, then search instead of repeatedly reading it.
- `fetch` downloads, converts, caches, and indexes pages. It supports one URL or a batch of requests.
- Search combines full-text and vector matches from memory, indexed content, sessions, and todos. Vector availability depends on native modules and the embedder.
- Reindex a changed source to replace its chunks.

```text
spider index path:"docs/"
spider fetch url:"https://example.com/api-reference"
spider search query:"retry backoff" kinds:["content","memory"]
```

## Memory

- Remember durable truths with a justification and a source link. Keep task progress in todos or conversation.
- Use global scope only when the fact holds in every repo; otherwise use repo.
- Review staged writes with `control memory sub:"pending"`, then approve or reject explicitly.
- See [Memory and learning](memory-and-learning.md) for storage caps, injection, reviewers, and skill staging.

## Todos

- Use one todo per open checklist item and toggle it as soon as it finishes.
- `id` is the per-session sequence number returned by the list, not a run ID.

```text
spider todo op:"add" text:"Write the retry regression test"
spider todo op:"list"
spider todo op:"toggle" id:"1"
spider todo op:"remove" id:"2"
```

- `remove` deletes obsolete items. `clear` removes only done items and reports removed and kept-open counts.
- `clear force:true` removes all items in the current session; clear rejects session selectors.
- `sessions` lists sessions with todos; `view session:"<selector>"` shows another session's list, including `session:"all"`.
- `toggle` and `remove` take `id` (the per-session seq) and an optional `session`: session ID, unique prefix, or unique name in this project database. Omitted session means current session.
- Mutations reject `session:"all"`, unresolved or ambiguous selectors, and missing or unknown IDs.
- `/todos` opens the live overlay.

## Subagents

- Use parallel tasks for independent work, chains for sequential steps, and pipelines for fresh-child continuations.
- Choose provider-qualified models with working credentials, and put thinking overrides on each item in multi-item dispatch.
- Give simultaneous writers isolated worktrees and their own dependencies.
- Use `/agents` to inspect results. Use `message` only when the run's mode and delivery state allow it; a completed run cannot resume.
- See [Subagents](subagents.md) for examples, model resolution, shutdown, reload survival, escalation, and message delivery evidence.

## Project setup

- Keep local databases, config, logs, and scratch out of commits. Use `.spider/scratch/` for project work or `~/.pi/agent/spider/scratch/` for global work.
- Index frequently used documentation at the start of a project.
- Worktree state and shared repository memory live in different database tiers; see [Data model](../architecture/data-model.md).
- `/bind <path>` promotes a session started outside git to a worktree; it does not automatically switch a session that already has conflicting git context.
- `pi-intercom` is optional for cross-session messaging, not a requirement for owned RPC steering or pipeline handoff.
- Configure flat dotted keys through [Configuration](configuration.md). Use [Runtime lifecycle](../architecture/runtime-lifecycle.md) to diagnose loaded-bundle mismatches.

## See also

- [Documentation index](../README.md).
- [Architecture overview](../architecture/README.md).
- [Feedback and learning loops](../architecture/feedback-and-learning-loops.md).
- [Contributing](../../CONTRIBUTING.md).

# Plan — role defaults, abort-on-Escape, subagent command visibility

Three independent defects, each with a **verified** root cause (not a guess — every claim
below was confirmed by reading pi's dist or spider's source this session).

Execution: strict TDD (RED first, always), subagent-driven, one commit per task.

---

## Task A — `models.defaults` is inert, and its refs are malformed

### Root cause (verified)
`grep -rn "defaults" packages/subagents/src/` returns **only two unrelated comments in
kill-process.ts**. Nothing in the spawn path ever reads `models.defaults`. The model is
resolved at `packages/subagents/src/actions/run.ts:87`:

```ts
const full = m ?? parentModel;      // explicit model, else inherit the parent's
```

There is no role lookup. So `control models set worker <ref>` writes config, `control
models` reads it back, and **nothing else ever touches it** — a closed display loop that
looks alive. Separately the stored values name provider `copilot/...`, which is not a
provider id and not an alias anywhere in spider (real id: `github-copilot`); the only
`copilot` string in the tree is an unrelated *embeddings* backend in config-schema.ts.

### Required behaviour
1. Precedence when spawning: **explicit `model:` → `models.defaults[<agent role>]` →
   parent model**. Inheritance stays the last resort, so nothing regresses when no
   default is set.
2. `setModelDefault` validates the ref against the live catalog and **rejects unknown
   refs**, so a bad value fails at write time instead of silently never resolving.
3. Normalise known-stale prefixes: `copilot/X` → `github-copilot/X` when that resolves.
   A bare id (no `/`) keeps working — `qualifyModelProvider` already handles it.
4. Ship corrected defaults: `worker=github-copilot/claude-sonnet-5`,
   `reviewer=github-copilot/claude-opus-5` (user directive: reviewers are Opus 5).

### Tests (RED first)
- role default is used when `model:` is omitted — **fails today**, returns parent model.
- explicit `model:` still wins over the role default.
- parent model still used when no default configured (no regression).
- `setModelDefault` rejects a ref absent from the catalog, with the valid list in the error.
- `copilot/claude-sonnet-5` normalises to `github-copilot/claude-sonnet-5`.
- unknown *role* still rejected (existing behaviour preserved).

### Mutation checks
- Delete the role lookup → precedence test fails.
- Make validation always return ok → rejection test fails.

### Owned files
`packages/host/src/control/models-cmd.ts`, `packages/host/src/extension.ts`,
`packages/host/src/dispatch.ts`, `packages/subagents/src/actions/run.ts`,
`packages/subagents/src/model-resolve.ts`, plus `__tests__` in those packages.

### Do NOT touch
`packages/context/**`, `packages/subagents/src/child-reporter.ts`, `packages/ui/**`.

---

## Task B — Escape does not abort a running `spider exec`

### Root cause (verified)
`packages/host/src/extension.ts:621`:

```ts
async execute(_toolCallId, args, _signal, onUpdate, ctx) {
```

`_signal` is underscore-prefixed — deliberately ignored. pi *does* supply it
(`types.d.ts:361`, `signal: AbortSignal | undefined`) and Escape aborts the stream, but
the spawned process keeps running to completion.

pi's own bash tool (dist/core/tools/bash.js:69-72, 85-95) handles this by killing the
**process tree** on abort and throwing `aborted`:

```js
const onAbort = () => { if (child.pid) killProcessTree(child.pid); };
signal.addEventListener("abort", onAbort, { once: true });
```

spider already has the kill primitive — `killTree(proc)` at
`packages/context/src/executor.ts:187` — it is simply never wired to an abort path.

### Required behaviour
1. Thread `signal` from `execute` → `ActionCtx` → `runExec` → `Executor.execute` → `#spawn`.
2. On abort, `killTree` the child (process group / taskkill /T — do not leave orphans).
3. Already-aborted signal must not spawn at all.
4. Report the partial output captured so far plus an explicit "aborted" marker — do not
   claim a normal exit code, and do not throw away what the command already printed.
5. Listener must be removed in `finally` (no leak across the many execs per session).

### Tests (RED first)
- aborting mid-run terminates the child **and the whole group** (assert a grandchild pid
  is dead, not just the shell).
- abort resolves/rejects promptly (< ~1s), rather than waiting out the command.
- pre-aborted signal never spawns.
- output printed before the abort is preserved in the result.
- no `signal` supplied → behaviour identical to today (no regression).

### Mutation checks
- Remove the `addEventListener("abort", ...)` → mid-run test fails.
- Kill only `proc.pid` instead of the group → grandchild assertion fails.

### Owned files
`packages/context/src/executor.ts`, `packages/context/src/actions/exec.ts`,
`packages/host/src/extension.ts` (execute signature only), `packages/host/src/dispatch.ts`,
plus `__tests__`.

### Sequencing
**Runs AFTER Task A** — both edit `extension.ts` / `dispatch.ts`.

---

## Task C — subagent detail view shows `spider exec`, never the command

### Root cause (verified)
`packages/subagents/src/child-reporter.ts:17`:

```ts
const pick = firstString(a.path, a.file, a.filePath, a.command, a.pattern, a.query, a.url, a.name, a.action);
```

`spider exec` args are `{ action, language, code }`. There is **no `command` field** — the
script lives in **`code`**, which is absent from the pick list. So it falls through to
`a.action` and the summary is literally `spider exec`. `agent-detail.ts:69` then renders
`e.summary`, so the detail view can only ever show what was recorded.

### Required behaviour
1. Include `code` as a summarisable field.
2. For the spider tool, summarise as `spider <action>: <first meaningful line>` so both the
   verb and the command survive.
3. `batch` carries `commands: [{language, code}]` — summarise the first command and the count.
4. `exec_file` should keep showing its `path`.
5. Keep the existing 100-char clamp and whitespace collapsing; strip leading `cd ... &&`
   noise only if trivial to do safely.
6. Non-spider tools must be unaffected.

### Tests (RED first)
- `spider exec` intent summary contains the actual command — **fails today** (`spider exec`).
- `batch` shows the first command plus a count.
- `exec_file` still shows the path.
- a tool with none of these fields still degrades to the bare tool name.
- summary stays within the length clamp for a very long script.

### Mutation checks
- Drop `code` from the pick list → summary test fails.

### Owned files
`packages/subagents/src/child-reporter.ts` + its `__tests__`.

### Do NOT touch
`packages/host/**`, `packages/context/**`, `packages/ui/**`,
`packages/subagents/src/actions/run.ts`, `packages/subagents/src/model-resolve.ts`.

---

## Global constraints (apply to every task)

- `export PATH="$HOME/.nvm/versions/node/v26.4.0/bin:$PATH"` first. **Never** `npm install`.
- RED before GREEN: show the failing output before implementing. A test that never failed
  proves nothing.
- Run the mutation checks listed for your task. Grep your `/*MUT*/` marker to confirm it
  landed on the intended line, confirm it still compiles, and confirm the fixture actually
  *reaches* the mutated branch — a mutation that silently no-ops looks exactly like a pass.
- `npm run typecheck` **and** `npx vitest run` must be green before commit. Never commit red.
- Dependency DAG: `subagents` must NEVER import `@spider/host`; `@spider/ui` must NEVER
  import `@spider/subagents`. No deep imports from `@earendil-works/pi-coding-agent`.
- Scratch under `.spider/scratch/` — never `/tmp`.
- Stage explicitly by path. Never commit `.spider/` or `.pi-subagents/`.
- Escalate rather than guess if the premise here turns out wrong.

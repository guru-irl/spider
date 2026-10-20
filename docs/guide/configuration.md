# Configuration

## Files and precedence

- Store keys as literal dotted JSON properties, not as nested objects.
- Global config overrides the built-in defaults, and worktree-local config overrides both.
- `subagents.extensions`, `subagents.profiles.reviewer.excludeTools`, `usage.footer`, `usage.counter.poll`, `usage.calibration`, `usage.monthlyBudget`, `usage.alerts.sessionCredits` and `usage.alerts.runCredits` are global-only. Spider ignores hand-written local usage values and reports them in diagnostics. They are not config failures.
- The global file is `~/.pi/agent/spider/config.json`, or `config.json` under `SPIDER_GLOBAL_ROOT`.
- The local file is `<worktree>/.spider/config.json`.
- For config writes, `scope:"repo"` means the local file, not the shared repository database. If you omit the scope, the write goes to the local file. `scope:"global"` selects the global file.
- Config writes do not accept the scopes `worktree` and `project`.
- When reading, spider skips a malformed layer and reports it in diagnostics. A write refuses to replace malformed JSON.

```text
spider control command:"config" op:"get" key:"memory.reviewer.model"
spider control command:"config" op:"unset" key:"memory.reviewer.model" scope:"repo"
```

## Results and unset behavior

- A `get` with a key reports `value` and `source`. The source is `default`, `global`, `local`, or `unset`.
- A `get` without a key reports the merged `config` and its `sources`. Some consumers apply their own defaults when they read a value, so those defaults do not appear in this map.
- A write reports its `scope` (`global` or `local`) and the destination `file`.
- If a local value still overrides the key, a global write reports `shadowedBy:"local"`.
- Unset normally deletes the key from the selected layer, so the layer below supplies the value.
- Usage keys can only be set with `scope:"global"`. A local unset of a usage key removes a hand-written local key and reports that spider ignores it anyway. The global value stays unchanged.
- Only `memory.snapshotCharCap` supports the `"unlimited"` sentinel. If the global file has a cap, unsetting the snapshot cap writes `"unlimited"` in the chosen layer. This applies to both global and local unset.
- Setting the snapshot cap to `"unlimited"` or to an empty string takes the same path as unset.
- Other numeric keys and model references never get the sentinel.
- The model-facing action rejects set and unset of `exec.enforce`, `subagents.extensions` and `subagents.profiles.reviewer.excludeTools` at every scope. To change `exec.enforce`, use the [user-only slash command](../../README.md#slash-commands-and-overlays). To change child extensions, edit the global file as described below.

## Validation

- Set and unset reject unknown keys that are not in the editable schema. Booleans must be `true` or `false`, and enum values must be one of the listed options. Numbers must be finite and inside the field's range: snapshot cap `500-40000`, organism budgets `0-1000`, curator interval `1-336` hours, and the [reviewer timeout ranges](memory-and-learning.md#reviewer-settings). Reviewer timeouts must also be integers. To set `models.defaults`, pass a JSON string that holds an object mapping roles to model strings. An object-valued tool argument does not work.

```text
spider control command:"config" op:"set" key:"models.defaults" value:"{\"reviewer\":\"github-copilot/claude-opus-5.5:high\"}" scope:"global"
```

### Child extensions

`subagents.extensions` is a global-only array of extension file paths. It defaults to `[]`, and only the user can change it. Edit `~/.pi/agent/spider/config.json`, or `config.json` under `SPIDER_GLOBAL_ROOT`, and keep the other properties:

```json
{
  "subagents.extensions": ["/path/to/compaction.ts"]
}
```

Every path must be fully absolute. On Windows, start with a drive letter and a separator, or with a UNC server and share. Spider rejects paths rooted on the current drive, such as `\extra.ts` or `/extra.ts`. To clear the list, remove the global property or set it to `[]`.

Spider refuses tool calls that set or unset this key, including this example with an explicit global scope:

```text
spider control command:"config" op:"set" key:"subagents.extensions" value:"[\"/path/to/compaction.ts\"]" scope:"global"
```

Spider ignores local values and reports them, with their file, in `config get` and `doctor`. It rejects sets at any scope other than global. To clean up, remove the local property by hand. Spider reports invalid values in either layer, with their file. An invalid global list blocks new run dispatches until you repair it.

Every new RPC or print child loads these files after spider's own extensions. Spider normalizes the paths and removes duplicates by realpath when it is available, keeping the first spelling. It skips missing paths and paths that are not files, with one warning run event per path, and the run still starts.

### Reviewer tool exclusions

`subagents.profiles.reviewer.excludeTools` defaults to `["edit", "write"]`. Like child extensions, it is global-only and managed by the user. Edit the global file. Spider ignores repository overrides and reports them in diagnostics. An invalid global value blocks new run dispatches. See [Reviewer tool profile](subagents.md#reviewer-tool-profile) for examples and limits. This setting is not a sandbox: `spider exec` can still write files.

## Structured results

`tools.structured` defaults to `false`. Turn it on locally or globally, then run pi's `/reload`:

```text
spider control command:"config" op:"set" key:"tools.structured" value:true
```

The setting registers `spider_search`, `spider_recall` and `spider_exec` with output schemas. They run the same actions as `spider`, without an `action` argument. They have pi's `codemode` exposure, so nested callers can use them without declaring them as direct tools. An explicit tool allowlist must allow these names. The normal `spider` declaration and its text stay the same. With the setting off, spider registers none of these adapters.

| Adapter | Arguments | Structured result |
| --- | --- | --- |
| `spider_search` | `query`, `limit`, `kinds`, `cwd` | `outcome`, `hits`, `truncated` |
| `spider_recall` | `query`, `category`, `scope`, `limit`, `cwd` | `outcome`, `hits`, `truncated` |
| `spider_exec` | `language`, `code`, `timeout`, `background`, `cwd` | `outcome`, `exitCode`, `output`, `truncated` |

Each hit has `id`, `kind`, `source`, `title` and `snippet`. The source reference is the indexed source or the memory link when one exists. Otherwise it is `kind:id`, or `memory:scope:id` for recall. Raw database rows are not part of the contract.

Search and recall return `outcome:"ok"` or `"error"`. If the action data is missing or malformed, they return `"unavailable"` and a native error result. Exec keeps the outcomes `"exited"`, `"signal"`, `"spawn-error"`, `"aborted"`, `"timeout"` and `"unknown"`. It returns `"error"` when the action fails or throws, and `"unavailable"` when data is missing. A command succeeded only if it has `outcome:"exited"` and `exitCode:0`. A null code never means success. Pi can resolve a structured failure to a script, so callers must check these fields.

Structured JSON is limited to 10000 UTF-8 bytes. To stay under the limit, search and recall drop whole hits from the end. Exec cuts its `output` at a complete Unicode character. `truncated:true` means either this limit or the existing exec text limit cut the result. Text, rendering details and structured values all follow the same secret-scrubbing setting. If spider cannot copy some data safely, it withholds the data instead of returning it unchanged.

This setting does not turn on codemode, MCP or extra child tools. It takes effect after `/reload`, and that includes turning it off.

## Pi settings in doctor

`spider control command:"doctor"` reads pi's effective settings through `pi.getSettings()`. It reports the compaction values, cache warming, the codemode mode and inline budget, the TUI mode, and install telemetry. If the active model has a compaction override, the token values include it. The report leaves out credentials and unrelated settings. The codemode settings show the configuration, not which tools are active right now.

## Monthly usage budget

`usage.monthlyBudget` is unset by default. Set it to a positive finite number of credits per billing month. Positive fractions are valid. Zero does not mean unset. To clear the budget in the config screen, leave the field blank.

```text
/spider config set usage.monthlyBudget <credits> --global
/spider config unset usage.monthlyBudget --global
```

From the `spider control` action, the tool form is `command:"config" op:"set" key:"usage.monthlyBudget" value:<number> scope:"global"`. The dashboard is read-only and cannot change this setting.

The live footer shows corrected credits without basis markers, then the cache hit rate, then a `month` item as a whole percentage. The month item divides by the budget if one is set, and by the account allowance otherwise. A valid counter reading from the current period supplies the used credits, even if it is stale. Without one, the worker supplies the corrected pi total for the billing month. If there is no usable used value or no denominator, the footer leaves the month item out.

## Reviewer and learner models

- Sign in to the [default provider](../../README.md#requirements) with pi's `/login`, or use models from another provider you have signed in to.
- To replace both reviewers and the learner, [set all three model keys](../../README.md#configuration). These keys are separate from `models.defaults` and from the active session model.
- In the README example, replace `provider/model` with a catalog entry that `control models` shows and that pi can authenticate. If an auxiliary provider override exists, unset it or make it match the provider of the qualified model.
- Without credentials for the selected models, foreground memory saves report [review skipped](memory-and-learning.md#memory-scope-and-review). Learner skill reviews [retry and drop after three attempts](memory-and-learning.md#learner-review-queue). Background drains that have input fail model resolution, with no fallback, and after such a failure `/doctor` reports the enabled organism as unhealthy.
- [Memory and learning](memory-and-learning.md) covers reviewer defaults, inline skill-review failures and how the learner model is selected.

## Compaction

[Compaction](compaction.md) is opt-in. `compaction.summaryModel` defaults to `null`, which leaves summaries to pi. Set it to `provider/model` for managed parent summaries. `compaction.summaryThinking` defaults to `high`. `compaction.fileListCap` defaults to `500` per list, and `0` turns the cap off. `compaction.minSummaryOutputTokens` defaults to `64000`. Both numeric fields need non-negative safe integers, and the output floor must fit the reserve derived from it. These settings apply on the next compaction. Thresholds stay as `compactAtPercent` in pi's `models.json`.

## Common defaults

| Key | Default | Meaning |
| --- | --- | --- |
| `ui.footer` | `true` | Footer and run selector. Takes effect next session. |
| `usage.footer` | `true` | Global-only. Footer with corrected credits in parent TUI sessions. Changes apply live. |
| `usage.counter.poll` | `true` | Global-only. Read-only account polling every ten minutes, in parent sessions only. Changes apply live. |
| `usage.calibration` | `auto` | Global-only, `auto` or `off`. `auto` uses the trailing seven days of counter evidence when there is enough of it. `off` shows published estimates and turns off factor history. Changes apply live. |
| `usage.monthlyBudget` | unset | Global-only. Positive finite credits per billing month. A blank field in the config screen clears it. Changes apply live. |
| `usage.alerts.sessionCredits` | `0` | Global-only. Finite nonnegative session threshold. Reserved: alerts are not implemented. |
| `usage.alerts.runCredits` | `0` | Global-only. Finite nonnegative run threshold. Reserved: alerts are not implemented. |
| `subagents.childMode` | `"rpc"` | RPC children. `"print"` selects one-shot children. |
| `subagents.keepCacheWarm` | `true` | Ask pi to keep the parent cache warm while its subagents start or run, within the limits below. Applies at the next warming decision. |
| `subagents.extensions` | `[]` | Global-only, managed by the user. Absolute extension file paths that every child loads. |
| `subagents.profiles.reviewer.excludeTools` | `["edit", "write"]` | Global-only, managed by the user. Tools removed from `agent:"reviewer"` children. Not a sandbox. |
| `exec.enforce` | `true` | Block the built-in bash tool. |
| `tools.structured` | `false` | Register typed search, recall and exec adapters after `/reload`. |
| `memory.snapshotCharCap` | `"unlimited"` | Inject all active memory. This is not a storage cap. |
| `models.defaults` | `{}` | Explicit overrides per agent role. Shipped defaults come from the catalog. |
| `organism.enabled` | `true` | Background work in the parent session. |
| `organism.selfNaming` | `true` | Let consolidation name the project. |
| `organism.autoWriteBudget` | `20` | Staged writes per drain. |
| `organism.maxMemoryProposals` | `3` | Memory candidates per pass that produces memory. |
| `organism.maxSkillProposals` | `1` | Valid skill candidates per drain. |
| `curator.staleAfterDays` | `30` | Age at which a skill becomes stale. |
| `curator.archiveAfterDays` | `90` | Age at which a skill is archived. |
| `curator.minIntervalHours` | `24` | Minimum time between curator runs. |
| `curator.consolidate` | `false` | Optional consolidation by a model. |
| `routing.tracking` | `true` | Track tool intents and results. |
| `routing.secret_scrub` | `true` | Scan for and scrub secrets. |
| `routing.injection_scan` | `true` | Scan for prompt injection. |
| `routing.auto_index_threshold` | `10000` | Output size in bytes at or above which spider indexes the output. |

- Warming happens only when pi knows the model's cache lifetime and idle warming is on.
- Pi still applies its own limit on idle warming.
- A subagent that sends nothing for 60 minutes stops holding warming. Any child event resets this clock and leaves the run status unchanged.

- `organism.passes.runMemoryTodo`, `.todoMemory`, `.learning`, `.consolidation`, `.reflection`, and `.insights` all default to `true`.
- [Memory and learning](memory-and-learning.md#reviewer-settings) lists the reviewer defaults and limits.
- `auxiliary.background_review.provider` and `.model` default to empty overrides. [Background learning](memory-and-learning.md#background-learning) documents the learner default they resolve to.
- The known editable fields are in `packages/ui/src/screens/config-schema.ts`. Consumer defaults are also in `packages/host/src/control.ts` and `packages/organism/src/config.ts`.

## When changes take effect

- Config readers use the merged layers for live action and routing settings. The reloader in `packages/host/src/config-reload.ts` rereads the same flat map.
- The organism rereads configuration each time it resolves its runtime for a request or drain.
- The agents UI reads `ui.footer` when it mounts at session start, not during a running session.
- `tools.structured` changes need `/reload`. The setting does not change the interactive `spider` tool.
- `usage.footer`, `usage.counter.poll`, `usage.calibration` and `usage.monthlyBudget` apply live. The usage alert thresholds are registered but do nothing yet.
- `subagents.childMode`, `subagents.extensions` and `subagents.profiles.reviewer.excludeTools` apply to new dispatches. Existing runs keep the settings they launched with.
- Reviewer settings apply to new reviews. They do not restart a review that is already running.
- Spider captures `memory.snapshotCharCap` with the frozen memory block at the first agent start. A change applies next session, after an extension reload, or when the memory binding target changes. Doctor uses the current value.
- Rebuilding a linked bundle and reloading it is a separate step from editing config. See [Runtime lifecycle](../architecture/runtime-lifecycle.md).

## Model role defaults

```text
spider control command:"models" op:"set" key:"reviewer" value:"github-copilot/claude-opus-5.5:high"
spider control command:"models" op:"clear" key:"reviewer"
```

- `set` writes a global default for a role. `clear` removes only that role's current local override. It leaves the global value and other roles alone.
- Spider resolves a model in this order: the explicit model, the local role override, the global role default, the shipped role default from the available catalog, and finally the parent model, for unknown roles or when no eligible catalog entry exists. Pipeline stages follow the same order.
- Shipped roles: worker, planner, and researcher use `github-copilot/gpt-6.1-sol:high` (`gpt-6-sol` when 6.1 is not in the catalog). Scout, digest, self naming, and upstream watch use `github-copilot/gpt-6-luna:low`. Reviewer uses `github-copilot/claude-opus-5.5:high`, and oracle uses Opus at medium thinking. Catalogs without Copilot use fallbacks by tier.
- `control models` reports the resolved shipped defaults with source `default`. Automatic tier selection skips Sonnet 5.5, GPT-5 models, GPT-6 Terra, and moving aliases (ids prefixed with `~` or ending in `-latest`). You can still pin these with an explicit model or a configured role.
- `models.defaults` merges role by role. It is not replaced as one object. Config and models results show provenance as a source map per role.
- When a local value shadows a global set, the result reports the local value and its file.
- [Subagents](subagents.md#models-and-thinking) covers thinking suffixes and per-item overrides.

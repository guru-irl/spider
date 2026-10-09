# Configuration

## Files and precedence

- Store keys as literal dotted JSON properties, not nested objects.
- Built-in defaults are overridden by global config, then worktree-local config.
- `subagents.extensions`, `usage.footer`, `usage.counter.poll`, `usage.calibration`, `usage.monthlyBudget`, `usage.alerts.sessionCredits` and `usage.alerts.runCredits` are global-only. Hand-written local usage values are ignored and diagnosed, not treated as config failures.
- Global file: `~/.pi/agent/spider/config.json`, or `config.json` under `SPIDER_GLOBAL_ROOT`.
- Local file: `<worktree>/.spider/config.json`.
- For config writes, `scope:"repo"` means the local file, not the shared repository database. Omitted scope is local; `scope:"global"` selects global.
- `worktree` and `project` are not accepted config write scopes.
- Malformed read layers are skipped with diagnostics. Writes refuse to replace malformed JSON.

```text
spider control command:"config" op:"get" key:"memory.reviewer.model"
spider control command:"config" op:"unset" key:"memory.reviewer.model" scope:"repo"
```

## Results and unset behavior

- A keyed `get` reports `value` and `source`: `default`, `global`, `local`, or `unset`.
- An unkeyed `get` reports merged `config` and `sources`. Some consumer defaults are applied by their readers rather than appearing in this map.
- Writes report `scope` (`global` or `local`) and the destination `file`.
- A global write reports `shadowedBy:"local"` if that key remains locally overridden.
- Unset normally deletes the selected layer's key so the lower layer supplies its value.
- Usage sets require `scope:"global"`. A local usage unset removes a hand-written local key and reports that it is ignored anyway. It leaves the global value unchanged.
- Only `memory.snapshotCharCap` supports the `"unlimited"` sentinel. Unsetting the snapshot cap writes `"unlimited"` in the chosen layer when the global file has a cap; this applies to global and local unset.
- Setting the snapshot cap to `"unlimited"` or an empty string follows that unset path.
- Other numeric keys and model references do not receive the sentinel.
- The model-facing action rejects `exec.enforce` and `subagents.extensions` for both set and unset at every scope. Use the [user-only slash command](../../README.md#slash-commands-and-overlays) for `exec.enforce`, or the global file edit described below for child extensions.

## Validation

- Set and unset reject unknown keys outside the editable schema. Booleans must be `true` or `false`; enum values must be listed options. Numbers must be finite and within their field's range: snapshot cap `500-40000`, organism budgets `0-1000`, curator interval `1-336` hours, and [reviewer timeout ranges](memory-and-learning.md#reviewer-settings). Reviewer timeouts must also be integers. Setting `models.defaults` requires a JSON string containing an object of role-to-model strings, not an object-valued tool argument.

```text
spider control command:"config" op:"set" key:"models.defaults" value:"{\"reviewer\":\"github-copilot/claude-opus-5.5:high\"}" scope:"global"
```

### Child extensions

`subagents.extensions` is a global-only array of extension file paths, defaulting to `[]`. Only the user can change it. Edit `~/.pi/agent/spider/config.json`, or `config.json` under `SPIDER_GLOBAL_ROOT`, and preserve the other properties:

```json
{
  "subagents.extensions": ["/path/to/compaction.ts"]
}
```

Every path must be fully absolute. On Windows, use a drive letter followed by a separator or a UNC server and share; current-drive-rooted paths such as `\extra.ts` or `/extra.ts` are rejected. To clear the list, remove the global property or set it to `[]`.

Tool set and unset calls are refused, including this explicit global-scope example:

```text
spider control command:"config" op:"set" key:"subagents.extensions" value:"[\"/path/to/compaction.ts\"]" scope:"global"
```

Local values are ignored and reported with their file in `config get` and `doctor`. Non-global sets are rejected. To clean up, remove the local property by hand. Invalid values in either layer are diagnosed with their file. An invalid global list blocks new run dispatches until repaired.

Every new RPC or print child loads these files after spider's own extensions. Paths are normalized and deduplicated by realpath when available, keeping the first spelling. Missing paths and paths that are not files are skipped with one warning run event per path; the run still starts.

## Monthly usage budget

`usage.monthlyBudget` is unset by default. Set a positive finite number of credits per billing month. Positive fractions are valid; zero does not mean unset. The config screen accepts a blank field to clear it.

```text
/spider config set usage.monthlyBudget <credits> --global
/spider config unset usage.monthlyBudget --global
```

The tool form is `command:"config" op:"set" key:"usage.monthlyBudget" value:<number> scope:"global"` on the `spider control` action. The dashboard is read-only and cannot change this setting.

The live footer shows corrected credits without basis markers, then cache hit rate and a whole-percent `month` item. Month uses the budget first, otherwise the account allowance. A valid in-period counter observation supplies used credits even when stale; without one, the worker supplies the corrected pi billing-month total. No usable used value or denominator means the month item is omitted.

## Reviewer and learner models

- Authenticate the [default provider](../../README.md#requirements) through pi's `/login`, or use models available through another authenticated provider.
- To replace both reviewers and the learner, [set all three model keys](../../README.md#configuration). These are separate from `models.defaults` and the active session model.
- In the README example, replace `provider/model` with a catalog entry shown by `control models` that pi can authenticate. If an auxiliary provider override exists, unset it or make it agree with the qualified model's provider.
- Without credentials for the selected models, foreground memory saves report [review skipped](memory-and-learning.md#memory-scope-and-review); learner skill reviews [retry and drop after three attempts](memory-and-learning.md#learner-review-queue). Background drains with input fail model resolution without a fallback, and `/doctor` reports the enabled organism unhealthy after such a failure.
- Reviewer defaults, inline skill-review failures, and learner selection details are in [Memory and learning](memory-and-learning.md).

## Compaction

[Compaction](compaction.md) is opt-in. `compaction.summaryModel` defaults to `null`, leaving summaries to pi; set it to `provider/model` for managed parent summaries. `compaction.summaryThinking` defaults to `high`. `compaction.fileListCap` defaults to `500` per list, with `0` disabling the cap. `compaction.minSummaryOutputTokens` defaults to `64000`. Both numeric fields require non-negative safe integers, and the output floor must fit its derived reserve. These settings apply on the next compaction. Thresholds remain `compactAtPercent` in pi's `models.json`.

## Common defaults

| Key | Default | Meaning |
| --- | --- | --- |
| `ui.footer` | `true` | Footer and run selector; next session. |
| `usage.footer` | `true` | Global-only corrected credits footer in parent TUI sessions; changes apply live. |
| `usage.counter.poll` | `true` | Global-only read-only account polling every ten minutes, parents only; changes apply live. |
| `usage.calibration` | `auto` | Global-only `auto` or `off`; auto uses sufficient trailing seven-day counter evidence, off shows published estimates and disables factor history. Changes apply live. |
| `usage.monthlyBudget` | unset | Global-only positive finite credits per billing month. Blank in the config screen clears it; changes apply live. |
| `usage.alerts.sessionCredits` | `0` | Global-only finite nonnegative session threshold; reserved, alerts are not implemented. |
| `usage.alerts.runCredits` | `0` | Global-only finite nonnegative run threshold; reserved, alerts are not implemented. |
| `subagents.childMode` | `"rpc"` | RPC children; `"print"` selects one-shot children. |
| `subagents.keepCacheWarm` | `true` | Ask pi to keep the parent cache warm while its subagents start or run, within the limits below; applies at the next warming decision. |
| `subagents.extensions` | `[]` | Global-only, user-managed array of absolute extension file paths for every child. |
| `exec.enforce` | `true` | Block the built-in bash tool. |
| `memory.snapshotCharCap` | `"unlimited"` | Inject all active memory; not a storage cap. |
| `models.defaults` | `{}` | Explicit agent-role overrides; shipped defaults resolve from the catalog. |
| `organism.enabled` | `true` | Parent-session background work. |
| `organism.selfNaming` | `true` | Allow project naming by consolidation. |
| `organism.autoWriteBudget` | `20` | Staged writes per drain. |
| `organism.maxMemoryProposals` | `3` | Memory candidates per memory-producing pass. |
| `organism.maxSkillProposals` | `1` | Valid skill candidates per drain. |
| `curator.staleAfterDays` | `30` | Age for stale skills. |
| `curator.archiveAfterDays` | `90` | Age for archived skills. |
| `curator.minIntervalHours` | `24` | Minimum curator interval. |
| `curator.consolidate` | `false` | Optional model consolidation. |
| `routing.tracking` | `true` | Tool intent/result tracking. |
| `routing.secret_scrub` | `true` | Secret scanning and scrubbing. |
| `routing.injection_scan` | `true` | Prompt-injection scanning. |
| `routing.auto_index_threshold` | `10000` | Large-output indexing threshold in bytes. |

- Warming only happens when pi knows the model's cache lifetime and idle warming is enabled.
- Pi still applies its own idle warming limit.
- A subagent silent for 60 minutes stops holding warming. Any child event resets this clock without changing the run status.

- `organism.passes.runMemoryTodo`, `.todoMemory`, `.learning`, `.consolidation`, `.reflection`, and `.insights` default to `true`.
- Reviewer defaults and limits are in [Memory and learning](memory-and-learning.md#reviewer-settings).
- `auxiliary.background_review.provider` and `.model` default to empty overrides; the resolved learner default is documented in [Background learning](memory-and-learning.md#background-learning).
- Known editable fields live in `packages/ui/src/screens/config-schema.ts`; consumer defaults also live in `packages/host/src/control.ts` and `packages/organism/src/config.ts`.

## When changes take effect

- Configuration readers use merged layers for live action and routing settings. The reloader in `packages/host/src/config-reload.ts` rereads that same flat map.
- The organism refreshes configuration when resolving its runtime for a request or drain.
- `ui.footer` is read when the agents UI mounts at session start, not during an existing session.
- `usage.footer`, `usage.counter.poll`, `usage.calibration` and `usage.monthlyBudget` apply live. Usage alert thresholds are registered but inactive.
- `subagents.childMode` and `subagents.extensions` apply to new dispatches; existing runs keep their launch settings.
- Reviewer settings apply to new reviews; they do not restart a review already in flight.
- `memory.snapshotCharCap` is captured with the frozen memory block at the first agent start. Changes apply next session, after an extension reload, or when the memory binding target changes. Doctor uses the current value.
- Rebuilding a linked bundle and reloading it is separate from editing config; see [Runtime lifecycle](../architecture/runtime-lifecycle.md).

## Model role defaults

```text
spider control command:"models" op:"set" key:"reviewer" value:"github-copilot/claude-opus-5.5:high"
spider control command:"models" op:"clear" key:"reviewer"
```

- `set` writes a global role default. `clear` removes only that role's current local override, not the global value or other roles.
- Resolution: explicit model, local role override, global role default, shipped role default from the available catalog, then parent model for unknown roles or an empty eligible catalog. Pipeline stages use the same policy.
- Shipped roles: worker, planner, and researcher use `github-copilot/gpt-6.1-sol:high` (`gpt-6-sol` when 6.1 is not in the catalog); scout, digest, self naming, and upstream watch use `github-copilot/gpt-6-luna:low`; reviewer uses `github-copilot/claude-opus-5.5:high`; oracle uses Opus at medium thinking. Non-Copilot catalogs use tier fallbacks.
- `control models` reports resolved shipped defaults with source `default`. Automatic tier selection excludes Sonnet 5.5, GPT-5 models, GPT-6 Terra, and moving aliases (`~`-prefixed or `-latest` ids). Explicit model and configured role pins remain supported.
- `models.defaults` merges per role, not as one replacement object. Provenance is a per-role source map in config and models results.
- A global set reports the local value and file when shadowed.
- Thinking suffixes and per-item overrides are covered in [Subagents](subagents.md#models-and-thinking).

# Compaction

Spider adds optional per-model threshold triggers and a configurable parent-session summary model. Without thresholds or a summary model, pi compacts as usual.

## Settings

Use the flat dotted keys in [spider configuration](configuration.md):

| Key | Default | Meaning |
| --- | --- | --- |
| `compaction.summaryModel` | `null` | Parent summary model as `provider/model`. Null leaves summaries to pi. |
| `compaction.summaryThinking` | `"high"` | Thinking for managed parent summaries: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. |
| `compaction.fileListCap` | `500` | Maximum paths in each read and modified list independently. `0` disables the file-list cap. |
| `compaction.minSummaryOutputTokens` | `64000` | Parent summary output request floor, still limited by the model's maximum output. `0` disables the floor. |

The numeric settings accept non-negative safe integers. The output floor must also fit its derived reserve, `ceil(value / 0.8)`. All settings are read when an attempt starts, so edits apply to the next compaction without restarting. They do not change pi's compaction reserves, thresholds or retained boundary.

```text
spider control command:"config" op:"set" key:"compaction.summaryModel" value:"provider/model"
spider control command:"config" op:"set" key:"compaction.summaryThinking" value:"high"
spider control command:"config" op:"set" key:"compaction.fileListCap" value:500
```

Select a model that pi can authenticate and whose context window fits the summary input. Setting the summary model to null or unsetting it restores pi's normal summary generation.

## Per-model thresholds

Thresholds stay in pi's `models.json`, not spider config. Add `compactAtPercent` under a provider's `models[]` entry or `modelOverrides` entry:

```json
{
  "providers": {
    "example-provider": {
      "modelOverrides": {
        "example-model": { "compactAtPercent": 60 }
      }
    }
  }
}
```

Values must be finite numbers strictly between 0 and 100. Valid overrides take precedence over matching `models[]` values. Unlisted models, missing files, invalid percentages and parse failures leave pi's built-in behavior in charge. The file is cached by modification time. Spider resolves pi's agent directory, including `PI_CODING_AGENT_DIR`.

In parent sessions, crossing a configured threshold at `agent_end` calls `ctx.compact()`. Notices report the trigger and completion; managed completion names the actual summarizer. These early triggers apply even when pi's `compaction.enabled` is false. Pi's own automatic compaction remains the backstop.

## Managed parent summaries

A configured summary model handles manual `/compact`, threshold and overflow compaction through `session_before_compact`. It uses one summary call for history and any split-turn prefix, retaining pi's prepared boundary, previous summary and retry settings. Only the user's `/compact` text is passed as custom instructions, unchanged, or undefined when absent. Spider adds no summary instructions or section limits and never truncates model text or re-prompts based on its size.

The request reserve is the larger of pi's preparation reserve and `ceil(compaction.minSummaryOutputTokens / 0.8)`. Pi derives the output request limit from that reserve and caps it at the model maximum. Reasoning shares the request budget; the floor is not a guaranteed text length.

The file lists use current-window last touches first, including nested tool calls and split-turn messages, then the latest checkpoint's stored order. Duplicate paths collapse, and modified paths are excluded from the read-only list. The cap applies to both stored details and the appended `<read-files>` and `<modified-files>` blocks. Previous ordinary pi checkpoints and checkpoints marked `spider-compaction` or legacy `per-model-compaction` are eligible. Aggregate preparation sets are the sorted fallback when stored lists are unavailable.

Details retain usage, file lists and `source: "spider-compaction"`, plus `summaryModel`, `summaryThinking`, `summarySectionTokens` and `summaryTotalTokens`. Size estimates use characters divided by four, including headings and whitespace. Progress is a container; file-list size is measured separately. Measurements are data only, with no size warnings. The [usage ledger](usage.md) prices the configured summarizer from `summaryModel`.

If the model is missing, unavailable or fails to return a valid structured summary, spider warns and returns control to pi's default compaction. Cancellation returns `{ cancel: true }`, not a fallback request. Pi 0.87's default fallback ignores earlier hook-owned file details, so prior capped lists can be lost on fallback. That limitation requires a pi change to fix.

The organism's before-compaction drain returns no compaction result, so it does not replace the managed summary. Pi uses the last truthy result across handlers and extensions; another custom compaction extension can still override it. Avoid multiple summary-owning extensions.

## Children

With `PI_SUBAGENT_CHILD=1`, configured thresholds trigger draft compaction at completed `turn_end` boundaries with tool results. Children use their own model, thinking and pi reserves, not the parent summary settings. They never call `ctx.compact()` or compact at `agent_end`.

The child path preserves recent context, merges the previous summary and appends one compaction draft. Pending context edits, small summarizable spans and existing draft compactions are skipped. Diagnostics are emitted once per reason. Failed summaries wait for `keepRecentTokens` of token growth before retrying; unknown token counts keep the back-off active. Failures do not change the history. The mirrored cut-point logic is verified against pi 0.87; another version warns that differential fuzz must be rerun.

## Migrate from the standalone plugin

Spider remains inactive while `per-model-compaction.ts` or `.js` exists in pi's global extensions directory, or a path with that basename appears in global `subagents.extensions`, even if that configured file is missing. It warns once per session and `/doctor` reports the conflict.

1. Configure spider's summary model and thinking if you want managed parent summaries. Thresholds in `models.json` stay unchanged.
2. Remove the standalone extension and its `subagents.extensions` entry. Keep unrelated entries.
3. Restart pi, then run `/doctor`.

Migration does not rewrite sessions. Spider recognizes legacy checkpoint details for file-list recovery.

# Compaction

Spider adds two optional features: compaction triggers at a per-model threshold, and a configurable model that writes parent-session summaries. If you set neither, pi compacts as usual.

## Settings

Set these with the flat dotted keys described in [spider configuration](configuration.md):

| Key | Default | Meaning |
| --- | --- | --- |
| `compaction.summaryModel` | `null` | The model that writes parent summaries, as `provider/model`. Null leaves summaries to pi. |
| `compaction.summaryThinking` | `"high"` | The thinking level for managed parent summaries: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. |
| `compaction.fileListCap` | `500` | The maximum number of paths in the read list, and separately in the modified list. `0` disables the file-list cap. |
| `compaction.minSummaryOutputTokens` | `64000` | The minimum output to request for a parent summary. The model's maximum output still limits it. `0` disables the floor. |

The numeric settings accept non-negative safe integers. The output floor must also fit the reserve derived from it, `ceil(value / 0.8)`. Spider reads all settings when a compaction attempt starts, so an edit applies to the next compaction without a restart. These settings do not change pi's compaction reserves, thresholds or retained boundary.

```text
spider control command:"config" op:"set" key:"compaction.summaryModel" value:"provider/model"
spider control command:"config" op:"set" key:"compaction.summaryThinking" value:"high"
spider control command:"config" op:"set" key:"compaction.fileListCap" value:500
```

Pick a model that pi can authenticate and whose context window fits the summary input. To return to pi's normal summary generation, set the summary model to null or unset it.

## Per-model thresholds

Thresholds live in pi's `models.json`, not in spider config. Add `compactAtPercent` to a provider's `models[]` entry or `modelOverrides` entry:

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

A value must be a finite number strictly between 0 and 100. A valid override wins over a matching `models[]` value. Pi's built-in behavior stays in charge for unlisted models, a missing file, an invalid percentage or a parse failure. Spider caches the file by modification time. Spider resolves pi's agent directory, including `PI_CODING_AGENT_DIR`. Pi 1.2.0's models schema and runtime accept the custom `compactAtPercent` key.

In a parent session, if usage has crossed the configured threshold at `agent_end`, spider calls `ctx.compact()`. Notices report what triggered the compaction and when it finished. For a managed compaction, the completion notice names the model that wrote the summary. These early triggers work even when pi's `compaction.enabled` is false. Pi's own automatic compaction still runs as the backstop.

## Managed parent summaries

When a summary model is configured, it handles manual `/compact`, threshold compaction and overflow compaction through `session_before_compact`. It makes one summary call that covers the history and any split-turn prefix. It keeps pi's prepared boundary, previous summary and retry settings. The only custom instructions passed to the model are the user's `/compact` text, unchanged, or undefined if the user gave none. Spider adds no summary instructions or section limits. It never truncates the model's text, and it never re-prompts because of the text's size. In pi 1.2.0, the serializer leaves thinking blocks out of the summary input and limits each tool result there to 2000 characters.

The request reserve is the larger of two values: pi's preparation reserve and `ceil(compaction.minSummaryOutputTokens / 0.8)`. Pi derives the output request limit from that reserve and caps it at the model maximum. Reasoning tokens share the request budget, so the floor does not guarantee a text length.

The file lists start with the paths last touched in the current window, including nested tool calls and split-turn messages. After those come the paths in the latest checkpoint's stored order. Duplicate paths appear once, and the read-only list leaves out modified paths. The cap applies to the stored details and to the appended `<read-files>` and `<modified-files>` blocks. Spider can draw on previous ordinary pi checkpoints and on checkpoints marked `spider-compaction` or the legacy `per-model-compaction`. When no stored lists are available, spider falls back to the aggregate preparation sets, sorted.

The details keep usage, the file lists and `source: "spider-compaction"`, plus `summaryModel`, `summaryThinking`, `summarySectionTokens` and `summaryTotalTokens`. Size estimates are the character count divided by four, including headings and whitespace. The progress section counts as a container, and spider measures the file-list size separately. The measurements are data only, and spider shows no size warnings. The [usage ledger](usage.md) prices the summarizer named in `summaryModel`.

If the model is missing or unavailable, or fails to return a valid structured summary, spider warns and hands control back to pi's default compaction. Cancellation returns `{ cancel: true }`, not a request for the fallback. Pi 1.2.0's default fallback still ignores file details stored by earlier hooks, so a fallback can lose earlier capped lists. Fixing that needs a change in pi.

The organism (spider's background learning process) drains its work before compaction and returns no compaction result, so it does not replace the managed summary. Pi uses the last truthy result across all handlers and extensions, so another custom compaction extension can still override the summary. Do not install more than one extension that writes summaries.

## Children

In a child process (`PI_SUBAGENT_CHILD=1`), configured thresholds trigger draft compaction at completed `turn_end` boundaries that have tool results. Children use their own model, thinking level and pi reserves, not the parent summary settings. They never call `ctx.compact()` and never compact at `agent_end`.

In a child, compaction keeps recent context, merges the previous summary and appends one compaction draft. It skips pending context edits, spans too small to summarize and existing draft compactions. Each diagnostic reason is reported once. After a failed summary, the child waits for `keepRecentTokens` of token growth before it retries. If the token count is unknown, the back-off stays active. A failure does not change the history. Spider's copy of pi's cut-point and file-operation logic is verified against pi 1.2.0, the minimum version spider supports. On any other unverified version, spider warns that the differential fuzz tests must be rerun.

## Migrate from the standalone plugin

Spider looks for the legacy plugin in these locations only:

- Pi's global agent directory: `extensions/per-model-compaction.ts` and `extensions/per-model-compaction.js`.
- Directory plugins in that directory: `extensions/per-model-compaction/index.ts` and `extensions/per-model-compaction/index.js`.
- Any path in `subagents.extensions` whose basename is `per-model-compaction.ts` or `per-model-compaction.js`, even if the file is missing.

Spider does not detect the plugin in project-level `.pi/extensions`, settings `extensions`, packages or `-e`. If you load the standalone plugin through one of those, remove it before you enable spider compaction.

Spider warns once, and `/doctor` names the detected source and how to remove it. In a parent session, an installed plugin stays registered until you restart or run `/reload`. Removing its file does not unload it and does not turn on spider compaction right away. Children check live, at thresholds where they would act, and do not keep that registration. Below the thresholds, the turn and agent-end handlers do not read spider config or check the legacy locations. If spider fails to read its config, it warns once and skips that attempt.

1. If you want managed parent summaries, configure spider's summary model and thinking level. Leave the thresholds in `models.json` as they are.
2. Remove the installed standalone plugin or its detected `subagents.extensions` entry, as directed. If both exist, remove both. Keep unrelated entries.
3. Restart pi or run `/reload`, then run `/doctor`.

Migration does not rewrite sessions. Spider still reads legacy checkpoint details to recover file lists.

# Subagents

## Dispatch and records

- `spider run` supports four dispatch modes: single, parallel (`tasks`), sequential (`chain`), and pipeline.
- Every run needs a concrete task. Children run in the background and report back through `spider.subagent_done`.
- `subagents.keepCacheWarm` defaults to `true`. It asks pi to keep the parent prompt cache warm while the session has subagents that are starting or running. Set it to `false` to leave pi's warming decision as it is. Child sessions do not override warming.
- Warming happens only when pi knows the model's cache lifetime and idle warming is on.
- Pi still applies its own limit on idle warming.
- A subagent that sends nothing for 60 minutes stops holding warming. Any child event resets this clock and leaves the run status unchanged.
- Model calls, compactions, cache warming and spider reviewer calls inside a child count toward the dispatching session's pi footer, `/session` and RPC totals once the run finishes. Failed and killed runs count too.
- Run cards, completion messages and run details in `/agents` show tokens and cost.
- Optional [per-model compaction](compaction.md#children) uses each child's own model and thinking level at tool-turn boundaries, never at `agent_end`.
- When successful compactions are recorded, the usage line ends with `1 compaction` or `N compactions`. Aborted compactions do not count. Successful compactions still count when model usage accounting is unavailable.
- With zero compactions, or no compaction records for the run, the usage line stays the same. Reload keeps the accounting and the compaction counts.
- If a run finishes while another session is active, its usage is counted when the owning session is next active or makes its next spider call. It is never counted in the other session.
- On hosts without usage entries attributed to a model, run usage attaches to the owner's next spider tool result, under tools and in summaries. With this fallback, usage can be lost if the host crashes before it saves the result.
- Parallel dispatch defaults to a concurrency of `4`. Give tasks short names for the UI.
- A chain passes `{previous}` to the next step.
- Pipeline templates use `{task}` for the first stage's original task text. Both `{previous}` and `{handoff}` use the prior stage's result. Spider does not expand `{outputs.<as>}`, so it stays in the task as literal text.
- After a stage is done or has failed, the pipeline starts the next stage in a new child. Cancellation ends the pipeline.
- `handoff:"intercom"` and `handoff:"wait"` are kept for compatibility and do nothing. Neither one sends a mailbox message or creates a blocking wait.
- Give review-only children `context:"fresh"` and tell them explicitly not to edit source.
- Do not poll subagents with `spider loop`, `spider schedule` or sleeps. Completion notices arrive on their own. To wait on external work such as CI or deploys, use [Loops and scheduled wakeups](loop-and-schedule.md).
- Run rows and events stay in the database of the dispatching session's worktree, or in its `/bind` target. `/agents` reads that database.
- A run's `cwd` sets the child's directory and model defaults. It does not change which database holds the run record. Child scratch files and transcripts go in the target project's `.spider/scratch`.
- Other actions that take `cwd`, such as `todo`, use the project database of that directory.

```text
spider run agent:"reviewer" task:"Review the parser diff; do not edit source" model:"github-copilot/claude-opus-5.5" thinking:"high" context:"fresh"
spider kill id:"<run-id>"
```

The optional `skill` parameter picks a skill by name. Spider checks the name before dispatch and fails if the skill is unknown. The child is told to read and follow the resolved `SKILL.md` file, so the child's transcript contains that local file path.

## Reviewer tool profile

Runs with `agent:"reviewer"` start without pi's `edit` and `write` tools. This applies to single runs, parallel tasks, chain steps and pipeline stages, in RPC mode and print mode. Other agents keep their usual tools. A stage's optional `role` label does not select this profile.

The global-only key `subagents.profiles.reviewer.excludeTools` defaults to `["edit", "write"]`. Only the user can change it, by editing the [global config file](configuration.md#files-and-precedence). For example, keep the file's other properties and add:

```json
{
  "subagents.profiles.reviewer.excludeTools": ["edit", "write", "bash"]
}
```

The list replaces the profile default. It accepts nonempty tool names or `*` patterns, with no whitespace or commas. `[]` removes the profile's exclusions, and deleting the property restores the default. Spider ignores repository overrides and reports them in diagnostics. Tool config set and unset calls cannot change the profile, and neither can run arguments. Changes apply only to new dispatches. RPC children always keep their existing `intercom` and `contact_supervisor` exclusions, without duplicates.

**This is not a sandbox.** The spider actions stay available, so `spider exec` can still write files, and so can other commands or extensions you configured on purpose. Children run with `--no-extensions`. That flag turns off discovered, configured and built-in extensions, including pi's MCP and codemode support. Spider and any child extensions you supply explicitly still load. Tool exclusions do not limit what those extensions can do to the file system.

To protect the working tree from accidental edits by a reviewer, keep the review-only instructions and give the reviewer a separate frozen copy to review. Do not let a reviewer that runs mutation tests share a tree with another running job.

## Models and thinking

- Prefix each model reference with its provider, and use a model that pi has credentials for.
- For a single run, set `model` and `thinking` at the top level. For tasks, chain steps and pipeline stages, set them on each item.
- The thinking levels are `off`, `minimal`, `low`, `medium`, `high`, `xhigh` and `max`.
- A suffix such as `provider/model:max` also sets the thinking level. An explicit thinking field overrides the suffix. Children receive the resolved level through `--thinking`.
- [Configuration](configuration.md#model-role-defaults) lists the model role defaults and their precedence.
- The models card lists the levels each model supports, based on pi's `reasoning` and `thinkingLevelMap`. A level mapped to an explicit `null` is unsupported, and so is an omitted `xhigh` or `max`.
- If a level is missing, pi uses the next supported higher level, or a lower one if there is no higher one. Run details and completion notices report `thinking adjusted` or `thinking capped`.
- A thinking request on a model without reasoning reports thinking as off. For unknown models, the effective level stays unverified.
- When a provider's mapping differs from the pi level, diagnostics name the mapping. Aliases that the provider honors stay in the structured receipt metadata and raise no warning.

## Child modes and trust

- By default a child runs as `pi --mode rpc`, owned by the dispatching session, with one initial task prompt. The host version currently verified is pi `1.2.0`.
- If a child extension consumes the initial task (`handled`), the run fails with that reason and spider closes the child.
- To use the legacy `--mode json -p` launch, set `subagents.childMode` to `"print"`.
- Only the user can configure [`subagents.extensions`](configuration.md#child-extensions), by editing the global config file. These fully absolute paths load in RPC and print children, for single, parallel, chain and pipeline runs. Spider ignores local values. It skips missing files with one warning run event per path.
- Compatibility checks read the metadata of the binary that is launched, from PATH or from `PI_SUBAGENT_PI_BINARY`.
- RPC children need a pi binary that supports `--exclude-tools`, `--name`, the `agent_settled` event and the `clear_queue` RPC command.
- If the pi binary is older than `0.85.1`, the minimum verified for RPC, spider falls back to print mode and records why. If the version is unknown, spider keeps RPC and warns.
- Spider requires pi `1.2.0` or later, and that includes children that load its extension. The fallback for older binaries does not make older hosts supported.
- RPC and print children follow pi's project-trust policy for non-interactive runs. RPC does not grant extra trust.
- Spider cancels dialogs opened by child extensions and adds a warning to the run events.
- Children cannot dispatch, message or kill through spider. They also cannot use the outbound `intercom` and `contact_supervisor` tools.
- `spider loop` and `spider schedule` refuse subagent children, print runs and JSON runs. They need a persistent top-level session.

## Kill and shutdown

- Kill accepts a full ID, a unique prefix, a run name, or `"all"` for the active runs of this session.
- Spider stops the whole process group, so descendant processes stop too. Once a run is cancelled, a later `cancel()` or `finish()` cannot mark it as done.
- To kill from the run details UI, press `k` twice within the confirmation interval.
- Pressing Escape in a later parent turn does not cancel background children.
- Shutdown affects only the session that is ending. In an SDK host with several sessions, shutting down session A does not stop session B's children.

| Shutdown reason | Result |
| --- | --- |
| `reload` | Eligible single, parallel, and pipeline-stage children survive in RPC or print mode; chain steps stop. |
| `quit`, `new`, `resume`, `fork` | Session-owned children stop, including detached children from an earlier reload. |

- Loops and wakeups always end on shutdown, `/reload` included. Timers do not survive, even when eligible children do.

- On RPC shutdown, spider sends `clear_queue`, then `abort`, then closes stdin. If the child is still running after a grace period, spider sends `SIGTERM` and then `SIGKILL` to the process group.
- A cancelled run records the shutdown reason and does not start a model turn.
- On pi 1.2.0, an unexpected `agent_settled.aborted` fails the child run, even if the process exits cleanly. Kills by the parent keep their existing cancellation reason.
- A kill started from this session reports through its tool result. It sends no separate completion notice, unless steers that were accepted or have an unknown outcome still need a report.
- If spider fails to capture a child's identity at spawn, the session's own handles can still kill it. Killing by PID alone and the orphan reaper both require an identity check.
- After a hard kill of the host, the next session start reaps orphan runs, but only when the owning host is dead. The PID's start time must match. Legacy rows use a command check instead, so spider does not signal an unrelated process.

## Reload survival internals

- Live handles are parked in `globalThis[Symbol.for("spider.childRegistry.v1")]`, a versioned registry shared by the whole process.
- Each entry keeps the process, the pipes, the run and session IDs, the database path, the intercom name, the PID and the start time.
- On reload, spider detaches the old listeners and leaves processes and pipes open. RPC events are buffered up to a count limit and a byte limit.
- Streaming partial output is not buffered. Saved history events have their own buffer. If a buffer overflows, spider adds an events-lost warning to the history and to the final result. Usage is totalled separately by provider, model and purpose, and is never evicted.
- At session start, a session adopts only its own entries. It restores event handling, completion reporting, kill and steering, and it replays escalations sent during the gap.
- If a child finishes during the gap, spider finalizes it and reports it once after adoption.
- A chain cannot survive, because the code that continues it belongs to the old activation.
- A pipeline's running stage survives, but its coordinator does not. Spider does not start the later stages. The run and its completion notice warn that those stages need to be dispatched again.
- Entries that no session adopts expire after `60` seconds. A child that is still running is stopped and marked cancelled. A child that already finished keeps its real result.
- If adoption fails, spider notifies the user, adds a warning and restarts the timer.
- Registries of different versions cannot adopt each other's entries. Timers clean up old entries, and quitting asks every registry version to dispose of its children.
- A best-effort exit hook stops detached children and finalizes their rows if adoption never happens. The hook cannot run after a hard kill.
- `node scripts/probe-child-survival.mjs` uses fixtures to check, against real pi, that children survive reload, that one completion notice arrives, and that quitting after a reload cleans up.

## Escalation

- To raise an issue, a child emits `ESCALATION[blocked|question|warning]: <message>`.
- The parent shows a card while the child is still running, not only when it completes.
- Use `blocked` when work cannot go on, `question` when you need a decision that changes the outcome, and `warning` for risks or a false premise.

## Messaging and delivery evidence

- `spider message to:"<run-id>" message:"<text>"` steers a running RPC child through the pipe of the session that owns it.
- Spider refuses to steer completed, queued, paused and print-mode runs. A message cannot resume a completed run. Dispatch it again with a corrected brief.
- Spider refuses steers that start with a slash, because pi might expand them as skills or templates, or reject them as extension commands. An RPC steer has no option to send literal text.
- If a successful RPC reply has `data.disposition: "handled"`, the tool returns **consumed by an extension, not delivered** at once. A child extension took the input, and the model never got it. Spider does not wait to observe delivery of that input.
- For queued input, or a legacy reply without a disposition, the tool waits up to `10` seconds from the send for a matching user `message_start`. It returns **delivered** as soon as it sees the input enter the conversation. That confirms entry, not that the model used the input.
- If accepted input has not been seen entering the conversation by the deadline, the result is **accepted but not confirmed**. If the input is still queued in the child, the result says that pi delivers it at the child's next turn boundary unless the run ends first, and says "do not resend". The final state appears in the run events and the completion summary.
- Among the additions seen in the serialized acceptance window, spider prefers one with exactly the sent text. Different text counts as a transformed delivery only after a successful reply, and only when it is the sole addition.
- Several additions without an exact match stay unconfirmed. Pi input handlers can swallow or rewrite text, and these events carry no request IDs. So a swallowed steer plus one unrelated injected message can look like a transformation, in the immediate tool result too.
- A steer that is in flight during a reload stays tracked, and the new activation resolves it.
- After `10` seconds without a reply, the result is **no reply yet, delivery unknown**. Tracking continues until the run settles, exits or stops. Do not resend while the message might still be delivered.
- A later steer waits up to `10` seconds for the reply to an earlier one. If none comes, spider refuses it as not sent. Once a steer is written, it gets its own send deadline for acceptance and observed entry. A late reply can release the next waiting steer.
- When the run settles, spider marks unanswered writes as unknown, refuses steers that were never written, and closes stdin. If no reply came before the run settled, exited or stopped, only an entry with exactly the sent text counts as delivered.
- Spider never downgrades an observed delivery. Completion reports the counts of delivered, accepted-unconfirmed, extension-consumed, unknown and refused steers. Refused means rejected or never written.

## Peer sessions and optional intercom

- If the `pi-intercom` package is installed and enabled, RPC children register as named peers, `<run-name>-<short-id>`.
- Another session can target a run ID through its saved route and intercom target. Without intercom, steer from the dispatching session.
- If optional intercom fails to resolve, the launch still goes ahead, and the dispatch details report whether intercom is available.
- Peer messages are saved durably before the broker delivers them. Unconfirmed messages stay queued and are retried when the target session starts.
- Broker acceptance does not prove that the recipient acknowledged the message or that it entered the conversation, so spider reports it as unconfirmed.
- Unlike peer messages, run steers are not saved, and spider does not retry them.

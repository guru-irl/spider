# Subagents

## Dispatch and records

- `spider run` supports single, parallel (`tasks`), sequential (`chain`), and pipeline dispatch.
- Every run needs a concrete task. Children run in the background and report through `spider.subagent_done`.
- Child model calls, compactions, cache warming, and spider reviewer calls inside children count toward the dispatching session's pi footer, `/session`, and RPC totals after the run finishes, including failed or killed runs.
- `/agents` run details and completion messages show tokens and cost. Reload preserves accounting. A run finishing while another session is active is counted when its owner is next active or makes its next spider call, never in the other session.
- On hosts without model-attributed usage entries, run usage attaches to the owner's next spider tool result under tools and summaries. This fallback can lose usage if the host crashes before persisting the result.
- Parallel dispatch defaults to concurrency `4`. Give tasks short names for the UI.
- Chains pass `{previous}` to the next step. Pipeline templates also accept `{task}`, `{handoff}`, and `{outputs.<as>}`.
- Pipeline stages start fresh children after a done or failed stage. Cancellation ends the pipeline.
- `handoff:"intercom"` and `handoff:"wait"` are compatibility values with no effect: neither sends a mailbox message nor creates a blocking wait.
- Give review-only children `context:"fresh"` and explicitly forbid source edits.
- Run rows and events stay in the dispatching session's worktree database, or its `/bind` target. `/agents` reads that database.
- A run's `cwd` selects the child's directory and model defaults, not the run-record database. Child scratch and transcripts live in the target project's `.spider/scratch`.
- Other actions with `cwd`, including `todo`, use that directory's project database.

```text
spider run agent:"reviewer" task:"Review the parser diff; do not edit source" model:"provider/model" thinking:"high" context:"fresh"
spider kill id:"<run-id>"
```

## Models and thinking

- Qualify model references with their provider and use a model for which pi has credentials.
- For a single run, use top-level `model` and `thinking`. For tasks, chain steps, and pipeline stages, set them on each item.
- Thinking levels: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`.
- A suffix such as `provider/model:max` also selects thinking. An explicit thinking field overrides the suffix; children receive the resolved level through `--thinking`.
- Model role defaults and their precedence are in [Configuration](configuration.md#model-role-defaults).
- The models card lists supported levels from pi's `reasoning` and `thinkingLevelMap`. Explicit `null` mappings, and omitted `xhigh` or `max`, are unsupported.
- Pi fills a missing level with the next supported higher level first, then a lower one. Run details and completion notices report `thinking adjusted` or `thinking capped`.
- A request on a non-reasoning model reports thinking off. Unknown models leave the effective level unverified.
- Diagnostics name provider mappings when different from the pi level. Honored aliases remain in structured receipt metadata without a warning.

## Child modes and trust

- Default: `pi --mode rpc`, owned by the dispatching session, with one initial task prompt.
- Set `subagents.childMode` to `"print"` for legacy `--mode json -p` launches.
- Only the user can configure [`subagents.extensions`](configuration.md#child-extensions), by editing the global config file. The fully absolute paths load in RPC and print children for single, parallel, chain and pipeline runs. Local values are ignored; missing files are skipped with one warning run event per path.
- Compatibility checks read metadata for the binary launched on PATH or through `PI_SUBAGENT_PI_BINARY`.
- RPC children require a pi binary supporting `--exclude-tools`, `--name`, the `agent_settled` event, and the `clear_queue` RPC command.
- A pi binary older than the verified RPC minimum `0.85.1` falls back to print mode and records why. An unknown version keeps RPC with a warning.
- This fallback does not lower spider's own pi `>=0.87.0` peer requirement.
- RPC and print children follow pi's non-interactive project-trust policy. RPC does not grant extra trust.
- Child extension dialogs are cancelled with a run-event warning.
- Children cannot dispatch, message, or kill through spider, or use outbound `intercom` and `contact_supervisor` tools.

## Kill and shutdown

- Kill accepts a full ID, unique prefix, run name, or `"all"` for this session's active runs.
- Process-group termination also stops descendant processes. Cancellation cannot later be overwritten as done by `cancel()` or `finish()`.
- In the run details UI, press `k` twice within the confirmation interval to kill.
- Later parent-turn Escape does not cancel background children.
- Shutdown acts on the ending session only. In a multi-session SDK host, shutting down session A does not stop session B's children.

| Shutdown reason | Result |
| --- | --- |
| `reload` | Eligible single, parallel, and pipeline-stage children survive in RPC or print mode; chain steps stop. |
| `quit`, `new`, `resume`, `fork` | Session-owned children stop, including detached children from an earlier reload. |

- RPC shutdown sends `clear_queue`, then `abort`, then stdin EOF. Process-group `SIGTERM` and `SIGKILL` are fallbacks after a grace period.
- Cancelled runs record the shutdown reason without starting a model turn.
- A kill initiated here reports through its tool result, without another completion notification unless unresolved accepted/unknown steers need reporting.
- Owned handles remain killable when spawn identity capture fails. PID-only kill and orphan-reaper paths require identity checks.
- After a hard host kill, the next session start reaps orphan runs only when the owning host is dead. PID start time must match; legacy rows use a command check to avoid signalling an unrelated process.

## Reload survival internals

- Live handles are parked in `globalThis[Symbol.for("spider.childRegistry.v1")]`, a versioned process-wide registry.
- Entries retain process, pipes, run and session IDs, database path, intercom name, PID, and start time.
- Reload detaches old listeners, keeping processes and pipes open. RPC events buffer within count and byte limits.
- Streaming partials are not buffered; persisted history events have a separate buffer. Overflow adds an events-lost warning to history and the final result. Usage aggregates separately by provider, model, and purpose and cannot be evicted.
- Session start adopts only that session's entries, restoring event handling, completion reporting, kill, and steering. Escalations from the gap are replayed.
- A child that finishes during the gap is finalized and reported once after adoption.
- A chain cannot survive because its continuation belongs to the old activation.
- A pipeline's in-flight stage survives, but its coordinator does not. Later stages are not started; the run and completion notice warn that they need redispatch.
- Unadopted entries expire after `60` seconds. A running child is stopped and marked cancelled; one already finished keeps its real result.
- Failed adoption notifies the user and adds a warning, then restarts the timer.
- Different registry versions cannot adopt each other. Timers clean up old entries; quit asks all registry versions to dispose of their children.
- A best-effort exit hook stops detached children and finalizes rows if adoption never occurs. It cannot run after a hard kill.
- `node scripts/probe-child-survival.mjs` checks real-pi reload survival, one completion notice, and quit-after-reload cleanup using fixtures.

## Escalation

- A child emits `ESCALATION[blocked|question|warning]: <message>` to raise an issue.
- The parent displays a card while the child is still running, not only at completion.
- Use `blocked` when work cannot proceed, `question` when an outcome-changing decision is needed, and `warning` for risks or a false premise.

## Messaging and delivery evidence

- `spider message to:"<run-id>" message:"<text>"` steers a running RPC child through its owning session's pipe.
- Completed, queued, paused, and print-mode runs refuse steering. A message cannot resume a completed run; redispatch with a corrected brief.
- Slash-prefixed steers are refused because pi can expand skills/templates or reject extension commands; RPC steer has no literal-text option.
- After a successful RPC reply, the tool waits for a correlated user `message_start` until `10` seconds from the send. It returns **delivered** as soon as entry is observed. This confirms entry, not model consumption.
- At the deadline, accepted input without observed entry returns **accepted but not confirmed**. If still queued in the child, the result says pi delivers it at the child's next turn boundary unless the run ends first, and "do not resend". The final state appears in run events and the completion summary.
- Exact text is preferred among additions in the serialized acceptance window. Different text counts as transformed delivery only after a successful reply and a sole addition.
- Several additions without an exact match remain unconfirmed. Pi input handlers can swallow or transform text, and these events have no request IDs. A swallowed steer and one unrelated injection can resemble a transformation, including in the immediate tool result.
- An in-flight steer survives reload tracking and is resolved by the adopting activation.
- After `10` seconds without a reply, the result is **no reply yet, delivery unknown**. Tracking continues until settlement, exit, or stop. Do not resend while delivery remains possible.
- A later steer waits up to `10` seconds for an earlier reply, then is refused as not sent. A written steer gets its own send deadline for acceptance and observed entry; a late reply can release the next waiter.
- Settlement finalizes unanswered writes as unknown, refuses unwritten waiters, and closes stdin. Without a reply before settlement/exit/stop, only exact-text conversation entry counts as delivered.
- Observed delivery is never downgraded. Completion reports delivered, accepted-unconfirmed, unknown, and refused counts. Refused means rejection or no write.

## Peer sessions and optional intercom

- An installed, enabled `pi-intercom` package lets RPC children register named peers as `<run-name>-<short-id>`.
- Another session can target a run ID through its persisted route and intercom target. Without intercom, steer from the dispatching session.
- Optional intercom resolution failure does not prevent launch; dispatch details report its availability.
- Peer messages are stored durably before broker delivery. Unconfirmed messages remain queued and retry when the target session starts.
- Broker acceptance does not prove recipient acknowledgement or conversation entry and is reported as unconfirmed.
- Run steers are ephemeral, unlike peer messages; they are not durably retried.

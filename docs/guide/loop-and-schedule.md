# Loops and scheduled wakeups

Use `spider loop`, `spider schedule`, or `/loop` to wait on external work such as CI, a deploy, or a timer. Do not use them to poll subagents. Subagent completion notices arrive automatically.

While this session has a running subagent, `spider exec`, `spider batch`, and the `spider_exec` adapter check code for waits. Shell checks cover foreground sleeps of two seconds or more, `gh run watch`, `tail -f` or `tail --follow`, `read -t` of two seconds or more, and `while` or `until` loops whose bodies sleep for any duration. The guard also checks shell code supplied to `spider exec_file`. Python `time.sleep`, Ruby and Perl `sleep`, and awaited JavaScript or TypeScript `setTimeout` waits block at two seconds or more. These checks include `background:true` calls with or without a timeout. The guard is a heuristic: it can miss a wait or block a command that only mentions sleeping.

These actions work only in a persistent, top-level pi session, including a top-level RPC session. Both actions and `/loop` reject print runs, JSON runs, and subagent children because those processes exit when their work ends.

## Fixed intervals

Run a prompt now, then repeat it on a fixed cadence:

```text
/loop 5m check whether the deploy has finished
/loop 1h check the external build
```

Agents use the same scheduler through the single `spider` tool:

```text
spider loop interval:"5m" prompt:"check whether the deploy has finished"
```

An interval is a whole number followed by lowercase `s`, `m`, `h`, or `d`. Intervals below 60 seconds become 60 seconds. The maximum is 24 days; larger intervals fail without replacing the current loop. For example, `/loop 10s check CI` runs every minute, while `/loop 25d check CI` shows usage.

The prompt starts immediately if the session is idle. Otherwise, its first run waits until the session is idle, including after manual compaction. Later ticks that arrive while the session is busy are dropped, not queued. A slow iteration cannot create a backlog.

`/loop` treats text that does not start with a valid interval token as a self-paced prompt. For example, `1.5m check CI` is a prompt, not a fractional interval. An explicit `interval` field on `spider loop` must be a valid interval.

## Self-paced loops

Omit the interval to let the model choose its next delay:

```text
/loop watch the external build until it completes
spider loop prompt:"watch the external build until it completes"
```

The prompt runs once with instructions to call `spider schedule` when that iteration finishes:

```text
spider schedule delaySeconds:300 prompt:"/loop watch the external build until it completes" reason:"The build usually takes another five minutes"
```

The scheduler handles this re-arm internally, without sending `/loop` through pi's command dispatch. It accepts only `/loop <prompt>` matching the active self-paced loop and keeps that loop's original user or model origin. Each iteration chooses its next delay. Skipping the scheduling call ends further iterations. The loop's prompt remains visible in status until a stop or replacement, even when no wakeup is pending.

If a user starts a self-paced loop with a prompt template, such as `/loop /check`, the template must include `$@` to keep the appended re-arm instructions. Without `$@`, template expansion drops those instructions, so the loop may end after its first iteration.

## One-shot wakeups

`spider schedule` delivers one follow-up user message after a delay:

```text
spider schedule delaySeconds:120 prompt:"check CI" reason:"Waiting for the remote build"
spider schedule delaySeconds:300 prompt:"check the deploy" noop:true
```

| Parameter | Behavior |
| --- | --- |
| `delaySeconds` | Required unless `stop:true`. Rounded to the nearest whole second and clamped to 60 through 3600. Must be finite. |
| `prompt` | Required unless `stop:true`. Delivered as a follow-up user message without command or template expansion. A leading `/`, even after whitespace, is refused except for the matching self-paced re-arm described above. |
| `reason` | Optional short explanation of the delay. |
| `noop` | Optional routine-check label. The wakeup still runs. |
| `stop` | Cancels the pending wakeup without requiring any other field. Does not end a fixed-interval loop. |

Slash commands are user-only because they can change settings that tools cannot. Prompts supplied through `spider loop` or `spider schedule` cannot start with `/` and never enter pi's command or template dispatch. The matching self-paced re-arm is handled by the scheduler, not pi. User-typed `/loop` prompts remain trusted and keep command and prompt-template expansion. Later firings, including self-paced re-arms, keep the loop's original trust level.

A session has one pending wakeup. A new scheduling call replaces it. When its delay expires, the wakeup waits until pi is idle and then fires once. A wakeup due during manual compaction stays pending until compaction finishes. The scheduling result includes the effective delay and its due time as an ISO timestamp.

## Stop, replace, and inspect

```text
/loop stop
spider loop stop:true
spider schedule stop:true
spider loop
```

`/loop stop` and `spider loop stop:true` end the active loop and cancel any pending wakeup. A new loop replaces the old loop and pending wakeup.

If a stop or replacement happens during a run, that run cannot schedule another wakeup before it settles. This applies to every prompt, so rewording a re-arm cannot restart the old loop. A refused re-arm returns a tool error, and the user receives a warning. The old run also cannot use `spider schedule stop:true` to cancel the replacement loop's first prompt. A later run can schedule normally. Manual compaction alone does not trigger this restriction.

`spider loop` without a prompt or interval reports the active loop and any pending wakeup. Supplying an interval without a prompt is an error. Status includes the prompt, interval in seconds, next fixed tick, and wakeup due time. A self-paced loop has no fixed interval or next tick. A wakeup waiting for idle retains its original due time and prompt. `/loop` without arguments shows usage.

## Session lifetime

All loops and wakeups end on `session_shutdown`. Quitting, restarting, `/reload`, starting a new session, resuming another session, or forking ends them. They are in-memory timers, not durable jobs. Start them again after a reload or restart.

Running subagents have a separate reload handoff. Their survival across `/reload` does not preserve loops or wakeups.

## Source

The scheduler and parser are adapted from [pstack-claude](https://github.com/michael-denyer/pstack-claude), `plugins/pstack/pi/schedule.ts` and the one-shot checks in `plugins/pstack/pi/one-shot.ts`, at commit `046341e`. The source is MIT licensed, copyright 2026 Lauren Tan and Michael Denyer.

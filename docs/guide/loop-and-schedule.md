# Loops and scheduled wakeups

Use `spider loop`, `spider schedule`, or `/loop` to wait on external work such as CI, a deploy, or a timer. Do not use them to poll subagents. Subagent completion notices arrive automatically.

While this session has a running subagent, `spider exec`, `spider batch`, and the `spider_exec` adapter check code for waits. In shell code, the guard blocks foreground sleeps of two seconds or more, `gh run watch`, `tail -f` or `tail --follow`, `read -t` of two seconds or more, and `while` or `until` loops whose bodies sleep for any length of time. It also checks shell code passed to `spider exec_file`. It blocks Python `time.sleep`, Ruby and Perl `sleep`, and awaited JavaScript or TypeScript `setTimeout` waits of two seconds or more. The checks also cover `background:true` calls, with or without a timeout. The guard is a heuristic. It can miss a wait, or block a command that only mentions sleeping.

These actions work only in a persistent, top-level pi session, and a top-level RPC session counts. Both actions and `/loop` reject print runs, JSON runs, and subagent children, because those processes exit when their work ends.

## Fixed intervals

Run a prompt now, then repeat it at a fixed interval:

```text
/loop 5m check whether the deploy has finished
/loop 1h check the external build
```

Agents reach the same scheduler through the single `spider` tool:

```text
spider loop interval:"5m" prompt:"check whether the deploy has finished"
```

An interval is a whole number followed by lowercase `s`, `m`, `h`, or `d`. Intervals below 60 seconds become 60 seconds. The maximum is 24 days. A larger interval fails and leaves the current loop in place. For example, `/loop 10s check CI` runs every minute, and `/loop 25d check CI` shows the usage text.

If the session is idle, the prompt starts at once. Otherwise its first run waits until the session is idle, and that includes waiting for a manual compaction to finish. Spider drops later ticks that arrive while the session is busy instead of queueing them, so a slow iteration cannot build a backlog.

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

The scheduler handles this re-arm itself and does not send `/loop` through pi's command dispatch. It accepts only a `/loop <prompt>` that matches the active self-paced loop, and it keeps the loop's origin, user or model, unchanged. Each iteration picks its next delay. If an iteration does not call schedule, the loop runs no more iterations. The status shows the loop's prompt until the loop is stopped or replaced, even when no wakeup is pending.

If a user starts a self-paced loop with a prompt template, such as `/loop /check`, the template must include `$@`. Spider appends the re-arm instructions to the prompt. Without `$@`, template expansion drops them, so the loop may end after its first iteration.

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

Only the user can run slash commands, because they can change settings that tools cannot. A prompt passed through `spider loop` or `spider schedule` cannot start with `/` and never reaches pi's command or template dispatch. The scheduler, not pi, handles the matching self-paced re-arm. A `/loop` prompt the user types stays trusted and keeps command and prompt-template expansion. Later firings, self-paced re-arms included, keep the loop's original trust level.

A session has at most one pending wakeup, and a new scheduling call replaces it. When the delay runs out, the wakeup waits until pi is idle and then fires once. If a wakeup comes due during a manual compaction, it stays pending until the compaction finishes. The scheduling result shows the delay actually used and the due time as an ISO timestamp.

## Stop, replace, and inspect

```text
/loop stop
spider loop stop:true
spider schedule stop:true
spider loop
```

`/loop stop` and `spider loop stop:true` end the active loop and cancel any pending wakeup. A new loop replaces the old loop and pending wakeup.

If the loop is stopped or replaced during a run, that run cannot schedule another wakeup before it settles. This applies to every prompt, so a reworded re-arm cannot restart the old loop. A refused re-arm returns a tool error, and the user sees a warning. The old run also cannot use `spider schedule stop:true` to cancel the first prompt of the replacement loop. A later run can schedule as usual. A manual compaction on its own does not cause this restriction.

`spider loop` without a prompt or interval reports the active loop and any pending wakeup. An interval without a prompt is an error. The status shows the prompt, the interval in seconds, the next fixed tick, and the wakeup's due time. A self-paced loop has no fixed interval and no next tick. A wakeup that is waiting for idle keeps its original due time and prompt. `/loop` without arguments shows the usage text.

## Session lifetime

All loops and wakeups end on `session_shutdown`. That happens when you quit, restart, run `/reload`, start a new session, resume another session, or fork. Loops and wakeups are timers in memory, not durable jobs. Start them again after a reload or restart.

Running subagents are handed over across a reload by a separate mechanism. Eligible subagents survive `/reload`, but loops and wakeups do not.

## Source

The scheduler and parser are adapted from [pstack-claude](https://github.com/michael-denyer/pstack-claude), `plugins/pstack/pi/schedule.ts` and the one-shot checks in `plugins/pstack/pi/one-shot.ts`, at commit `046341e`. The source is MIT licensed, copyright 2026 Lauren Tan and Michael Denyer.

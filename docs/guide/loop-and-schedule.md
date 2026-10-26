# Loops and scheduled wakeups

Use `spider loop`, `spider schedule`, or `/loop` to wait on external work such as CI, a deploy, or a timer. Do not use them to poll subagents. Subagent completion notices arrive automatically.

While this session has a running subagent, `spider exec`, `spider batch`, and the `spider_exec` adapter check code for waits. In shell code, the guard blocks foreground sleeps of two seconds or more, `gh run watch`, `tail -f` or `tail --follow`, `read -t` of two seconds or more, and `while` or `until` loops whose bodies sleep for any length of time. It also checks shell code passed to `spider exec_file`. It blocks Python `time.sleep`, Ruby and Perl `sleep`, and awaited JavaScript or TypeScript `setTimeout` waits of two seconds or more. The checks also cover `background:true` calls, with or without a timeout. The guard is a heuristic. It can miss a wait, or block a command that only mentions sleeping.

These actions need a persistent, top-level pi session, including top-level RPC. Both actions and `/loop` reject print runs, JSON runs, and subagent children, including children with RPC transport.

## Names and replacement

Each trigger has a case-sensitive name. A name starts with a letter or digit and contains up to 40 letters, digits, dots, underscores, or hyphens. A session holds at most 20 triggers.

`spider loop` and `/loop` default to `loop`. `spider schedule` defaults to `wakeup`. A valid definition replaces only the same name, even when the kind changes. Other names remain independent. A failed definition leaves the old trigger and its due time unchanged. Replacing an existing name succeeds at the 20-name limit.

## Fixed intervals

An interval loop runs now, then keeps its original cadence:

```text
/loop 5m check whether the deploy has finished
spider loop name:"deploy" interval:"5m" prompt:"check whether the deploy has finished"
```

An interval is a whole number followed by lowercase `s`, `m`, `h`, or `d`. Intervals below 60 seconds become 60 seconds. The maximum is 24 days. An invalid interval leaves the old definition unchanged.

If the session is busy, the first prompt waits until idle, including through manual compaction. A later tick also stays due while busy. Once idle, spider delivers that occurrence once, then advances to the first anchored time after now. Missed ticks never form a backlog. For example, a one-minute loop created at 12:00 and released at 12:10:10 next runs at 12:11, not 12:11:10.

`/loop` treats text without a valid interval token as a self-paced prompt. `1.5m check CI` is a prompt, not a fractional interval. An explicit tool `interval` must be valid.

## Daily and calendar triggers

A cron loop starts at its next future occurrence, not immediately:

```text
spider loop name:"morning" cron:"0 8 * * *" tz:"Asia/Kolkata" prompt:"check the external build"
```

This runs at 08:00 Kolkata time each day. It keeps that local time after long runs, clock changes, reloads, and same-session resume. `interval` and `cron` are mutually exclusive. There is no slash syntax for cron.

`tz` applies only to cron. It accepts an IANA zone, not a numeric offset. If omitted, spider captures the machine's zone once. Existing triggers never move when the machine's zone changes. Explicit spelling such as `Asia/Kolkata` is preserved. Non-cron triggers also capture the machine's zone for display.

If `TZ` is a POSIX rule rather than an IANA name, pass `tz` explicitly.

Cron has five numeric fields, in order: minute, hour, day of month, month, and weekday. Fields accept `*`, integers, inclusive ranges, comma-separated lists, and positive integer steps. `5/10` starts at 5 and steps through the field's upper bound. Weekdays 0 and 7 both mean Sunday. Names, macros, seconds, `?`, `L`, `W`, and `#` are not supported.

Bounds are 0–59, 0–23, 1–31, 1–12, and 0–7. Ranges cannot wrap. Empty list items, reversed ranges, fractions, zero steps, and out-of-range values are errors.

Day matching follows Vixie cron. When both day fields are restricted, either may match. If either field starts with `*`, both expanded sets must match. Thus `*/2` keeps wildcard semantics, unlike `1-31`.

Creation and advancement require an occurrence within five calendar years after the search time. An impossible date such as `0 0 30 2 *` is rejected. Restore checks syntax and bounds only, retaining the saved due time. If a later search fails, the current occurrence still fires once and the trigger is removed with an error notification.

During daylight saving transitions, a missing civil minute runs at the first valid minute after the gap. New York's missing 02:30 runs at 03:00, not 03:30. A repeated minute runs only at its first occurrence. Several missing minutes that resolve to one instant fire once. These rules also apply to non-hour transitions, including Lord Howe's 30-minute change.

## Self-paced loops

Omit both `interval` and `cron` to let the model choose the next delay:

```text
/loop watch the external build until it completes
spider loop name:"build" prompt:"watch the external build until it completes"
```

Each iteration appends instructions to re-arm that same name. For the default loop, the call must explicitly name `loop`:

```text
spider schedule name:"loop" delaySeconds:300 prompt:"/loop watch the external build until it completes"
```

For the named `build` loop, use `name:"build"` instead. Both the name and the trimmed `/loop <original prompt>` must match. The scheduler updates the self-paced trigger directly. It never creates a one-shot or dispatches the internal re-arm text through pi's slash parser. A different prompt cannot borrow a user loop's trust.

A re-arm accepts either a relative delay or an absolute `at`. It keeps the loop's original prompt and origin. If an iteration skips the call, no further iteration runs. Listing shows `waiting for re-arm` until stop or replacement. A reload drops a self-paced loop that has no pending re-arm.

If a user starts a self-paced loop with a prompt template, such as `/loop /check`, that template must include `$@`. Without `$@`, expansion drops the appended instructions and the loop may end after one iteration.

## One-shot wakeups

A one-shot fires after a relative delay or at an offset-bearing absolute time:

```text
spider schedule name:"ci" delaySeconds:120 prompt:"check CI" reason:"Waiting for the remote build"
spider schedule name:"morning-once" at:"2026-10-27T08:00+05:30" prompt:"check the external build"
```

A create requires a nonblank prompt and exactly one timing field. `delaySeconds` must be finite. Spider rounds it to the nearest whole second, then clamps it to 60 through 3600 seconds.

`at` requires `YYYY-MM-DDTHH:mm[:ss[.fff]](Z|±HH:MM)`, with uppercase `T` and `Z`. Seconds are optional. Fractions require seconds and contain one through three digits. Offset hours are 00 through 14 and minutes are 00 through 59. Calendar dates must be valid and strictly future. Offsetless input and basic `+0530` offsets are rejected. There is no one-hour cap on `at`.

`reason` is an optional explanation. `noop:true` labels a routine check but does not suppress delivery. A one-shot stays due through a busy session or manual compaction and fires once after idle. Results include its effective delay, when relative, and its due ISO timestamp.

Only users can run slash commands. Model-origin loop and schedule prompts cannot start with `/`, including after whitespace, except for an exact named self-paced re-arm. User-typed `/loop` prompts keep command and prompt-template expansion on every firing. Model-origin prompts disable template expansion. Restore preserves that origin.

The unified tool ignores legacy cross-action fields: loop ignores `delaySeconds`, `reason`, and `noop`; schedule ignores `interval`. Loop rejects `at`. Schedule rejects `cron` and `tz`.

## Stop and inspect

| Request | Effect |
| --- | --- |
| `spider loop` | List all triggers, with full definitions in `details.triggers`. |
| `/loop` | List all triggers, then show usage. |
| `spider loop name:"build" stop:true` | Stop only that loop and its re-arm, not a one-shot. Defaults to `loop`. |
| `spider schedule name:"ci" stop:true` | Cancel only that one-shot. Defaults to `wakeup`. |
| `/loop stop` | Stop the default `loop` and `wakeup`, preserving legacy slash behavior. |
| `/loop stop build` | Stop that name, regardless of kind. |
| `/loop stop all` | Stop every trigger. The tool can still address a trigger named `all`. |

Tool loop stop no longer cancels the independent `wakeup`. `/loop stop <words>` is now a stop request or a usage error, never a self-paced prompt.

During an active run, stopping or replacing a loop seals only its name until `agent_settled`. The old run cannot re-arm that name, even with a reworded prompt. Other names remain usable. Schedule cancellation cannot cancel a replacement loop's first prompt because it affects only one-shots. `agent_end` does not clear seals. Manual compaction alone does not create them.

Listing uses stable name order. Each line includes the kind and timing spec, the origin, and an 80-character single-line prompt preview. Structured rows keep the full prompt and numeric `nextAt`, plus UTC and stored-zone renderings. States are `scheduled`, `due`, and `waiting-for-rearm`. An overdue row says `due, waiting for idle`. No timing fields and no prompt means listing; a timing field without a prompt is an error.

Delivery more than two minutes late appends the original scheduled time in UTC and the stored zone. The note says the session was busy, pi was closed, or the machine was asleep, without claiming which occurred. Exactly two minutes late has no note. User slash prompts never receive the note, so their command text stays intact.

## Session lifetime and storage

Triggers survive `/reload` and resuming the same saved session after restart. A new session or fork starts empty. Shutdown clears in-memory timers but does not erase saved definitions. Nothing fires while pi is closed or the machine is asleep.

Missed one-shot and cron triggers fire once, late, when the session is idle. Intervals resume at the first future anchored time without catching up. An interval's immediate first prompt still waiting at reload is dropped. A pending self-paced re-arm survives; a consumed iteration does not repeat.

Spider appends a full `spider-triggers` snapshot in pi session entries after each changed definition, re-arm, and non-interval fire. It also saves a snapshot after a fire that fails its checks or cannot advance, including an interval. Successful interval ticks do not write snapshots. Each snapshot copies every full prompt, so session files grow with non-interval activity. Restore selects the newest matching snapshot in file order, even across tree branches. Print, JSON, and child starts do not read, consume, or write this state.

A snapshot is saved before delivery. A crash between the save and the send can lose an occurrence. If a write fails, spider keeps the change in memory and warns once. A failed fire snapshot suppresses that send without retrying it. Restart may recover the older durable snapshot. Opening the same session in two pi processes makes both fire its triggers. There is no cross-process coordination.

Subagents have a separate lifetime. Eligible running children can survive `/reload` through handover, while triggers are restored from session entries. Quitting or replacing the session stops owned children; resuming that saved session can still restore its triggers.

## Source

The scheduler and parser are adapted from [pstack-claude](https://github.com/michael-denyer/pstack-claude), `plugins/pstack/pi/schedule.ts` and the one-shot checks in `plugins/pstack/pi/one-shot.ts`, at commit `046341e`. The source is MIT licensed, copyright 2026 Lauren Tan and Michael Denyer.

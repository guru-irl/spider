# Wall-clock triggers for loop and schedule

## Purpose

A user can run a prompt every day at a fixed local time, such as 08:00 in Asia/Kolkata. The trigger keeps that time after each run, across long idle periods, and after pi reloads or resumes the same session.

The acceptance case is a daily `0 8 * * *` trigger in `Asia/Kolkata`. In an open, idle session on an awake machine, it delivers within 60 seconds of 08:00 on consecutive days. Its next time is always the next day's 08:00, not a delay measured from the previous delivery.

This is a session scheduler, not an operating-system job service. Nothing fires while pi is closed or the machine is asleep. Missed one-shot and cron runs fire once when the session returns and becomes idle. Missed interval ticks do not accumulate.

## Current behavior and scope

`packages/host/src/loop/index.ts` holds one wakeup and one loop in memory. A new schedule replaces the wakeup, including a self-paced re-arm. Fixed loops use `setInterval`, drop busy ticks, and start with an immediate prompt. All timers end on shutdown, including reload.

The new design replaces those slots with named triggers and one wall-clock ticker per session. It retains the current prompt-delivery call, persistent-session guard, model-prompt guard, relative-delay clamp, interval grammar, and immediate start for interval and self-paced loops. A cron loop starts at its first future occurrence, not immediately.

No dependency is added. No database schema changes. The implementation uses TypeScript, Node timers, `Date.now()`, pi session entries, and `Intl.DateTimeFormat`.

## Named triggers

A name matches `^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$`. Names are case-sensitive and unique within a session. The session can hold at most 20 triggers. Replacing an existing name at the limit succeeds. Creating a 21st name fails without changing any trigger.

A create replaces only the trigger with that name, even if its kind changes. The default name for `spider schedule` is `wakeup`. The default name for `spider loop` and `/loop` is `loop`.

There are four kinds:

| Kind | Definition | Next time after delivery |
| --- | --- | --- |
| `once` | `schedule` with a relative delay or absolute time | Remove the trigger. |
| `interval` | `loop` with `interval` | First `anchor + k * interval` strictly later than the current time. |
| `cron` | `loop` with `cron` | First cron occurrence strictly later than the current time. |
| `self-paced` | `loop` without `interval` or `cron` | `null`, until a matching re-arm. |

Every trigger stores its name, kind, prompt, origin, explicit time zone, and `nextAt` as epoch milliseconds or `null`. An interval also stores its creation anchor and interval. A cron trigger stores its expression. A one-shot stores its requested timing form, effective relative delay when used, `reason`, and `noop` label. Compiled cron fields and timer handles are not persisted.

The machine's IANA zone is captured at creation for non-cron triggers and for cron triggers without `tz`. Resolve it in this order:

1. Use `process.env.TZ` if it is a valid IANA name, not a numeric offset.
2. Otherwise, validate `Intl.DateTimeFormat().resolvedOptions().timeZone` and read the `/etc/localtime` symlink target after `zoneinfo/`. Prefer a valid link name when Intl reports the same canonical zone, or when Intl reports no valid zone.
3. Otherwise, use the Intl zone if it validates.
4. Otherwise, derive an `Etc/GMT` zone from `-new Date().getTimezoneOffset()` when the offset is a whole number of hours and the resulting zone validates. Etc/GMT signs are inverted: three hours east of UTC uses `Etc/GMT-3`, and five hours west uses `Etc/GMT+5`. Zero uses `Etc/GMT`.
5. Otherwise, use `UTC`.

Every selected zone must be a valid string. An empty or POSIX-rule `TZ`, such as `UTC0`, `EST5`, or `UTC+3`, must not prevent a plain schedule from being created or restored.

Preserve the selected spelling. For example, a valid `Asia/Kolkata` link target takes precedence over `Intl`'s `Asia/Calcutta` alias. An absolute `at` selects an instant through its offset. The one-shot's display zone remains the captured machine zone. A machine-zone change does not change existing definitions.

## Tool arguments

### `spider schedule`

```json
{"action":"schedule","name":"morning-once","at":"2026-10-27T08:00+05:30","prompt":"Check the external build"}
```

The arguments are `{ name?, prompt, delaySeconds | at, reason?, noop?, stop? }`.

- A create requires a nonblank prompt and exactly one of `delaySeconds` and `at`.
- `delaySeconds` must be finite. Round to the nearest whole second, then clamp to 60 through 3600 seconds, as today.
- `at` has exactly the grammar `YYYY-MM-DDTHH:mm[:ss[.fff]](Z|±HH:MM)`, with uppercase `T` and `Z`. Seconds are optional. When seconds are present, fractional seconds of one through three digits are accepted as an addition to the original requirement. Offset hours are 00 through 14 and minutes are 00 through 59. The basic `±HHMM` form is not accepted. Reject missing offsets, invalid calendar dates, invalid offsets, and non-finite instants. The instant must be strictly later than now. There is no scheduling-horizon cap beyond the date representation.
- `reason` is an optional explanation. `noop:true` labels a routine check and does not suppress delivery.
- `stop:true` needs no timing or prompt fields. It cancels only the named one-shot, default `wakeup`. It does not cancel another kind under that name.
- Ignore the legacy cross-action field `interval`. Reject `cron` with `spider schedule does not accept cron; use spider loop`. Reject `tz` with `spider schedule does not accept tz; use spider loop with cron`.

Validate the entire replacement before removing the old definition. A rejected request leaves the current trigger and its next time unchanged.

### `spider loop`

```json
{"action":"loop","name":"morning","cron":"0 8 * * *","tz":"Asia/Kolkata","prompt":"Check the external build"}
```

The arguments are `{ name?, prompt, interval?, cron?, tz?, stop? }`.

- Give at most one of `interval` and `cron`. A definition requires a nonblank prompt.
- `interval` keeps the existing whole-number grammar with lowercase `s`, `m`, `h`, or `d`. The minimum effective interval is 60 seconds. The maximum is 24 days.
- `cron` uses the grammar below.
- `tz` applies only to `cron`. Validate the IANA name with `Intl` and preserve the supplied spelling in the trigger and listing. Reject numeric offset strings as zone names. If omitted, resolve the machine zone and store it explicitly.
- With neither timing field, the loop is self-paced.
- With no `prompt`, `interval`, or `cron`, return the complete trigger listing. A timing field without a prompt is an error, not a listing. A stray `tz` without `cron` is an error.
- `stop:true` stops only the named loop and its pending re-arm, default `loop`. It does not cancel a one-shot stored under that name.
- Ignore the legacy cross-action fields `delaySeconds`, `reason`, and `noop`. Reject `at` with `spider loop does not accept at; use spider schedule`.

Both actions remain available only in persistent top-level sessions, including top-level RPC. Reject print and JSON runs and `PI_SUBAGENT_CHILD=1`, including listing and stop requests. Model-origin prompts cannot start with `/`, including after whitespace. User-origin prompts can. The matching self-paced re-arm is an internal operation, not permission for arbitrary model slash commands.

Run the persistent-session guard first. For a schedule write, check the target name's seal before the model-prompt guard. Recognize an exact self-paced re-arm before that prompt guard. Then report field-combination errors, including forbidden cross-action fields on listing and stop requests. Keep the slash-prompt check on text parsed from `interval`, so that field cannot hide a slash command. Invalid requests never mutate state.

## Cron grammar and calendar rules

Cron has exactly five fields: minute, hour, day of month, month, and day of week. Fields accept `*`, integers, inclusive ranges, comma-separated lists, and positive integer steps. Month and weekday names are not supported. Neither are macros, seconds, `?`, `L`, `W`, or `#`.

The field bounds are minute 0 through 59, hour 0 through 23, day of month 1 through 31, month 1 through 12, and day of week 0 through 7. Both 0 and 7 mean Sunday. Expand steps before normalizing Sunday. A single-number step such as `5/10` means every tenth value from 5 through that field's upper bound. Ranges do not wrap. Reject empty list items, reversed ranges, out-of-range values, zero steps, fractions, and extra fields.

Use Vixie day matching. If both day fields are restricted, either matching field is enough. If either field starts with `*`, require both fields to match their expanded sets. Keep this wildcard flag separately from the expanded values. Thus `*/2` retains wildcard day semantics, while `1-31` is a restricted day-of-month field even though it covers every date.

When creating a cron trigger or advancing it after a fire, reject an expression that has no occurrence within five calendar years after the search time. For example, `0 0 30 2 *` cannot produce an occurrence. A leap-day expression remains valid when its next occurrence is within that horizon. The search bound is a UTC calendar-year addition, with February 29 clamped to February 28 when needed.

### Daylight saving time

Resolve each matching civil minute in the trigger's zone before choosing the next UTC instant.

- If the minute exists once, use that instant.
- If the minute is ambiguous during a fall-back overlap, use its first occurrence only. A search made after the first occurrence must not choose the second occurrence of the same civil minute.
- If the minute does not exist during a spring-forward gap, use the first valid minute after the gap. This is not the requested minute shifted by the size of the gap. In `America/New_York`, a missing 02:30 runs at 03:00, not 03:30.
- If several matching missing minutes resolve to the same instant, deliver once for that instant.

Do not assume transitions are one hour. Australia/Lord_Howe advances and retreats by 30 minutes. Asia/Kolkata has a fixed half-hour offset.

Use `Intl.DateTimeFormat` with explicit `timeZone`, Gregorian calendar, Latin digits, and an `h23` hour cycle for local fields and offsets. Calendar-day enumeration skips invalid dates and nonmatching months before resolving minutes. Cache formatters and each searched date's offset candidates. Do not scan every UTC minute for five years. This would also miss the required treatment of gaps.

## Wall-clock reconciliation

Each session scheduler owns a trigger map, a set of sealed names, a `running` flag, an in-memory dispatch gate, and at most one timeout. It does not allocate a timer for each trigger and does not use `setInterval`. The ticker uses the latest context supplied by `session_start`. Before any start event, it uses the context from the most recent tool or command call.

When future work exists, arm the timeout for the earlier of 30 seconds and the time until the earliest `nextAt`. Each callback compares `Date.now()` with stored due times. A due trigger that cannot run retries after one second, rather than scheduling a zero-delay busy loop. If no trigger has a due or future time, no timer is needed. A gate fallback for remaining due work uses the same timeout, not a second timer.

Also request an immediate check after `agent_settled`. That event is notification-only in pi 1.2. Its handler clears `running` and the seals, then requests the check through the same timeout. Delivery and persistence happen outside the event callback. `agent_end` does not clear the run flag or seals.

A trigger is eligible only when no run is in flight and `ctx.isIdle()` is true. Manual compaction can make the context busy without setting `running`. Keep the due time unchanged while busy.

Select due triggers by ascending `nextAt`, then name for ties. Deliver at most one per reconciliation callback. Close the dispatch gate when selecting an occurrence, before consumption, snapshot append, or `sendUserMessage`. A reentrant check cannot deliver another trigger during preparation or prompt preflight. If preparation fails and no send occurs, release the gate after consuming that failed occurrence.

After a delivery, treat the session as busy until the gate has seen `agent_start` and then `agent_settled` for that delivery. Only then consider the next due trigger, in the same order. If no `agent_start` arrives within 5 seconds and `ctx.isIdle()` is true, open the gate. This covers a user slash prompt handled by an extension command or a rejected send. If the session is not idle at that deadline, keep the gate closed and retry the idle check after one second. Once `agent_start` arrives, no timeout can bypass its required `agent_settled`. A callback that opens the gate continues to select and deliver one due trigger in the same callback.

If prompt preflight takes longer than 5 seconds, the next due trigger can start before or be merged into the delayed one. Ordering is then best effort. No occurrence is lost or repeated because of this fallback.

Keep the existing call:

```typescript
pi.sendUserMessage(prompt, {
	deliverAs: "followUp",
	expandPromptTemplates: origin === "user",
});
```

Before delivery, remove a one-shot, advance an interval from its original anchor, advance cron from the current time, or set self-paced `nextAt` to `null`. Append the required snapshot before calling `sendUserMessage`. A crash between that append and the send loses the occurrence rather than repeating it. A trigger has at most one pending firing. If several occurrences pass during a run, sleep, or closure, they do not become a backlog.

Recheck the persistent-session guard at fire time. If that check fails, consume the occurrence without delivery. Remove a once trigger, set a self-paced trigger's `nextAt` to `null`, and advance an interval or cron normally if its next time can be computed. Remove an interval or cron whose next time cannot be computed. Append a snapshot of the resulting state and notify once with the error. Never retry that occurrence.

If only the advance throws, remove the trigger, write the snapshot, deliver the current occurrence once, and notify with the error. A failed search for a later cron occurrence does not invalidate the current due occurrence. These failure snapshots include interval failures, unlike successful interval ticks.

If the snapshot append throws, keep the consumed state in memory, skip delivery, and notify once. Combine any check or advance error with the write error in that one notification. Do not retry that append or occurrence on every ticker callback. Other future occurrences remain eligible. A restart can still recover the older durable snapshot after a failed write, so storage failures do not provide an exactly-once guarantee.

Interval and self-paced definitions retain their immediate first prompt. For an interval, creation time is the anchor and the immediate occurrence is initially due. If the first prompt must wait, later times still use that anchor. A cron definition has no immediate first prompt.

A create that leaves an occurrence due runs one reconciliation pass inline before returning. That pass uses the same eligibility and dispatch gate as the ticker. If the gate is closed, the first prompt stays due and is delivered when the gate opens.

This changes busy interval behavior. A tick that arrives during a run is no longer dropped. It stays due, fires once when idle, then advances to the first anchored time after now. Tool `loop stop` no longer cancels the independent `wakeup` one-shot. Slash input beginning `/loop stop <words>` is now a stop request or usage error, not a self-paced prompt. Cron has no immediate first prompt.

Backward wall-clock changes do not move an already stored due time backward. Forward changes are discovered by the next callback or settled check. The scheduler cannot execute during sleep. The short ticker avoids a long relative timer whose clock pauses while macOS sleeps.

## Late prompts

If delivery is more than 120,000 milliseconds after `nextAt`, append one line to the delivered text. The text order is the original prompt, then any self-paced instructions, then the late note. Keep the `${prompt}\n\n[/loop, self-paced]` prefix intact. Exactly two minutes late does not qualify. Use the original due time, not the current time or the next occurrence.

The line has this form:

```text
[spider schedule] Scheduled for 2026-10-27 08:00:00 Asia/Kolkata (2026-10-27T02:30:00.000Z UTC). Running late because the session was busy, pi was closed or the machine was asleep.
```

Do not claim which of those causes occurred. Do not append the line if the delivered prompt starts with `/`, including after whitespace. User slash commands must remain intact. Check the underlying user prompt before appending self-paced instructions. Never send the internal re-arm string as a user message.

## Self-paced re-arms and seals

Each self-paced iteration appends instructions to call `spider schedule` with its own `name`, prompt `/loop <original prompt>`, and a relative delay from 60 through 3600 seconds. Skipping the call ends further iterations.

Recognize a re-arm only when both the resolved name and the trimmed prompt match the active self-paced loop. The re-arm sets that loop's `nextAt` through the requested relative delay or absolute `at`. It keeps the loop's original prompt and origin. It never creates or replaces a one-shot. A different name or different slash prompt is rejected by the model-prompt guard.

Default names still apply. In particular, a default self-paced loop tells the model to pass `name:"loop"` explicitly. An unnamed schedule targets `wakeup`, not the loop.

A user `/loop` stop or replacement during an active run seals only the affected loop name until that run settles. Preserve the current protection for equivalent tool operations. Refuse schedule writes to a sealed loop name, including a reworded re-arm, so an old run cannot overwrite the replacement. Other names remain usable. A stop seals its target even if no loop currently exists. Manual compaction alone does not create seals.

A schedule cancellation affects only a one-shot and cannot cancel the replacement loop's first prompt. There is no shared wakeup slot to protect. `stop all` seals every loop name it removes during a run.

## Persistence and session lifetime

Persist complete snapshots through this pi 1.2 API:

```typescript
pi.appendEntry("spider-triggers", { version: 1, sessionId, triggers });
```

Append after each definition change, including create, replace, stop, and cancel when state changes. Append after every fire except interval ticks. This includes once, cron, and self-paced fires. Append after each self-paced re-arm. A self-paced fire saves `nextAt:null` before a later model run can re-arm it. Do not write for listings, unchanged stop requests, successful interval ticks, or `session_shutdown`. A consumed fire-time check or advancement failure writes the failure snapshot described above, including for an interval.

If a definition-change append throws, keep the new in-memory state, return the result with a warning, and notify once. The next successful snapshot supersedes it. Do not retry the failed append on each ticker callback.

A snapshot carries all trigger definitions and their origins. Interval ticks need no writes because the anchor determines the next occurrence. A later snapshot caused by another trigger can include an interval's current derived `nextAt`, but restore still derives its next time from the anchor.

On `session_start`, reset activation-local state and use the new context. If `ctx.mode` is `print` or `json`, or `PI_SUBAGENT_CHILD=1`, restore nothing, arm no timer, and write nothing. The saved snapshot stays untouched for the next persistent start.

For `startup`, `reload`, or `resume` in a persistent top-level session, read `ctx.sessionManager.getEntries()`. Select the last `custom` entry in file order with `customType:"spider-triggers"` and `data.sessionId === ctx.sessionManager.getSessionId()`. Triggers are session state, not branch state. Tree navigation does not change them, and restore uses the newest snapshot on any branch. For `new` or `fork`, restore nothing, even if copied entries contain snapshots.

Validate the selected snapshot at this boundary. If a trigger has an invalid or missing zone, skip and report only that trigger and restore the valid triggers beside it. For any other malformed data, including other malformed fields on a trigger whose zone is invalid, reject the whole snapshot with a clear notification and restore no triggers. Unknown versions also reject the whole snapshot. Reject a snapshot containing a model-origin prompt that starts with `/`, including after whitespace. Never fall back to an older snapshot that could revive a cancelled trigger. Session-file origin is trusted like the user's other local files. Do not downgrade user origin on restore.

Snapshot validation checks cron syntax and bounds with `parseCron` only. A restored cron keeps its stored `nextAt`. Do not search for its next occurrence during validation. A later failed advance follows the fire-time failure rule, so one cron with no future occurrence does not discard the other restored triggers.

Each snapshot copies every full prompt. Session files therefore grow by one full snapshot per definition change, re-arm, or non-interval fire. This design adds no prompt-length cap or snapshot compaction.

On restore:

- An overdue once or cron trigger stays due and fires once when idle. Apply the late-note threshold. Remove or advance it and save a snapshot before sending, as above.
- An interval resumes at the first anchored time strictly after now. It does not catch up, even once. An immediate first prompt still waiting at reload is dropped.
- A self-paced loop with a pending re-arm retains that time. One with `nextAt:null` is dropped.
- Shutdown clears timers and state, including the dispatch gate and saved context. It never appends a snapshot. No timer armed before shutdown can deliver afterward. A later call on the same scheduler object behaves like a fresh activation. A new activation restores only through `session_start`.

Triggers survive `/reload` and resuming the same session. A new session or a fork starts with none. Nothing fires while pi is closed or the machine is asleep, and missed once and cron runs fire once late. Opening the same session in two pi processes makes both fire its triggers. There is no cross-process coordination. The write-before-send order can lose an occurrence during a crash, and a failed snapshot write can leave an older durable occurrence.

## Listing and slash command

`spider loop` lists every trigger, not just loops. Each line includes the name, kind and spec, next state, origin, and the first 80 characters of the prompt. Replace line breaks in the preview with spaces so each trigger stays on one line. Use stable name order.

Examples of kind and spec are `cron "0 8 * * *" Asia/Kolkata`, `every 5m`, `once`, and `self-paced`. A future next time includes UTC and the trigger's zone. An overdue time reads `due, waiting for idle`. A null self-paced time reads `waiting for re-arm`.

Return structured `details: { triggers: [...] }` alongside the text. Each row includes the full definition, untruncated prompt, origin, `nextAt`, UTC and local renderings when present, and a state of `scheduled`, `due`, or `waiting-for-rearm`. Empty status has `triggers:[]` and text `No triggers are active.`

The slash forms are:

| Command | Effect |
| --- | --- |
| `/loop` | List every trigger, then show usage. |
| `/loop stop` | Stop the default `loop` and default `wakeup`, preserving the legacy slash behavior. |
| `/loop stop <name>` | Stop that one trigger, regardless of kind. |
| `/loop stop all` | Stop every trigger. |
| `/loop 5m <prompt>` | Define or replace the default interval loop. |
| `/loop <prompt>` | Define or replace the default self-paced loop. |

`all` is reserved in the slash stop grammar. The tool can still address a trigger named `all`. Other invalid slash input shows usage without changing state. `/loop stop now` now stops a trigger named `now`, rather than creating a self-paced prompt. There is no slash grammar for cron. Users ask the agent to create a cron trigger through the tool.

## Source and documentation changes

Time-zone and cron calculations live in new pure modules under `packages/host/src/loop/`. `index.ts` owns trigger state, validation at entry points, ticker reconciliation, prompt delivery, persistence, and lifecycle hooks. `parser.ts` owns slash syntax. The host still routes loop and schedule before database resolution.

Update the tool schema and descriptions in `packages/host/src/extension.ts`, including `name`, `interval`, `delaySeconds`, `prompt`, `stop`, and new `at`, `cron`, and `tz`. Update the managed instructions in `packages/superpowers/src/agentsmd-content.ts`.

Update `README.md`, `docs/guide/loop-and-schedule.md`, `docs/guide/subagents.md`, `docs/guide/using-spider.md`, `docs/architecture/README.md`, and `packages/host/README.md`. Explain named replacement, the busy-interval change, re-arm names, stopping, and the exact lifetime rules above. State that tool loop stop no longer cancels `wakeup`, `/loop stop <words>` is a stop request or usage error, and cron has no immediate first prompt. Keep the warning against polling subagents.

## Verification

Pure time tests cover grammar, invalid dates and zones, Vixie day matching, impossible schedules, leap days, New York gaps and overlaps, Lord Howe's 30-minute transitions, and Kolkata's half-hour offset. Engine tests use injected time calculations so they can run independently.

Integration tests use real calculations for consecutive 08:00 Kolkata deliveries, long idle periods, busy due times, wall-clock jumps without intervening callbacks, names, seals, listing, persistence writes, and restore reasons. The consumed-self-paced regression is re-arm, fire, then reload: the loop is absent and no consumed iteration fires again.

Scheduler and real-SDK tests fake `Date` together with timers. A real-SDK regression makes two triggers due together and proves they start separate ordered runs, even while the first send is still in prompt preflight. Persistence tests cover tree navigation before reload and starts in print, JSON, and child processes.

A separate uncommitted live check runs a real persistent pi RPC process with `TZ=America/New_York`. Disable the organism and its learner in the isolated global configuration before launch. A low-cost model creates a Kolkata cron trigger for three specific consecutive minutes in one local hour, starting about two minutes ahead. Observe two automatic firings before restarting the same session and the third afterward. Each must arrive within 60 seconds of its scheduled minute. After the third, the listing must show tomorrow's first selected minute in `Asia/Kolkata`, with the correct UTC instant. RPC has no built-in reload command, so restart and resume is the required live persistence check. Unit tests cover the reload event directly. The live check has an eight-minute deadline.

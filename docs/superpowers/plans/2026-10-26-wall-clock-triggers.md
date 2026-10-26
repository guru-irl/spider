# Wall-clock triggers implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Execute part A and part B in separate worktrees with one writer each. Review the combined change once, not each task.

**Goal:** Add named, persistent one-shot, interval, cron, and self-paced triggers that keep their wall-clock due times.

**Architecture:** Pure time modules calculate instants and civil-time occurrences. `SessionScheduler` consumes those calculations through an injected interface and reconciles named triggers with one short timeout. Full snapshots in pi session entries restore the same session without accumulating missed occurrences.

**Tech stack:** TypeScript, Node.js, `Intl.DateTimeFormat`, Vitest, and pi 1.2 extension and RPC APIs. No new dependency.

**Spec:** [Wall-clock triggers design](../specs/2026-10-26-wall-clock-triggers-design.md). Read both documents before implementation.

## Global constraints

- A name matches `^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$`.
- The session can hold at most 20 triggers.
- The default name for `spider schedule` is `wakeup`. The default name for `spider loop` and `/loop` is `loop`.
- Round relative delays to the nearest whole second, then clamp to 60 through 3600 seconds.
- The minimum effective interval is 60 seconds. The maximum is 24 days.
- Cron has exactly five numeric fields. Month and weekday names are not supported.
- Creation and advancement reject a cron with no occurrence within five calendar years after the search time. Restore validates syntax and bounds only.
- The ticker wakes at the earlier of 30 seconds and the next future due time. A blocked due trigger retries after one second.
- After a send, hold the dispatch gate until `agent_start` then `agent_settled`. With no start, release after 5 seconds only when idle. Select and deliver in the same check that opens the gate. A preflight longer than 5 seconds can reorder or merge deliveries without losing or repeating an occurrence.
- A create with due work reconciles inline before returning, through the same delivery gate as the ticker.
- A late note requires more than 120,000 milliseconds of lateness. Do not append it to slash prompts.
- Append a snapshot after every fire except interval ticks, including self-paced fires with `nextAt:null`.
- Triggers survive `/reload` and resuming the same session. A new session or a fork starts with none.
- Restore the newest matching snapshot in `getEntries()` file order, independent of tree navigation.
- Print, JSON, and subagent-child starts restore nothing, arm no timer, and write nothing.
- Fake `Date` together with timers in every scheduler or SDK test that advances time.
- Nothing fires while pi is closed or the machine is asleep. Missed once and cron runs fire once late. Intervals resume from their anchor without catching up.
- Keep the persistent-session and model-prompt guards and origin-dependent prompt expansion.
- No new dependency. No database schema changes. Do not change unrelated test assertions.
- Use the repository's existing dependencies. Do not install packages to execute this plan.

## Review focus

Each additional case has an owning test below.

1. An invalid replacement must leave the old definition and due time intact, including when the session already has 20 names. Task B1.
2. A backward wall-clock adjustment must not repeat a consumed occurrence or advance a pending due time early. Task B1.
3. Several names due together must retain due-time order and must not produce duplicate pending firings. Task B1 and task I1.
4. A malformed or unknown-version latest snapshot must not revive an older, cancelled definition. Task B2.
5. A changed machine zone must not move an existing trigger. The default zone is resolved once and stored. Tasks A1, B1, and I1.

## File ownership and execution order

Part A and part B can start together. Neither writer edits the other's files. Integration happens after both parts are available. There are no temporary production implementations to remove.

| Part | Files owned | Responsibility |
| --- | --- | --- |
| A | New `packages/host/src/loop/zoned.ts`, `cron.ts`, `__tests__/zoned.test.ts`, `__tests__/cron.test.ts` | Pure time calculations and exhaustive calendar tests. |
| B | `packages/host/src/loop/index.ts`, `parser.ts`, existing tests in `loop/__tests__/`, new `triggers.test.ts`, `persistence.test.ts`, `time-math.ts`, `wallclock.integration.test.ts`; `packages/host/src/extension.ts`; `packages/host/src/__tests__/loop-schedule-wiring.test.ts`; `packages/superpowers/src/agentsmd-content.ts`; the six documentation files listed in task B3 | Trigger state, injection contract, persistence, command parsing, tool arguments, integration, and documentation. |

Within part A, A2 follows A1. Within part B, B1a, B1b, B1c, and B2 run in that order. B3's parser, schema, and documentation work follows B2. B3 step 3's production wiring starts only after part A is merged into part B's branch. That prerequisite covers both `time-math.ts` and `registerLoopSchedule(pi, createTimeMath())`. Do not commit imports of missing modules. Part B must remain typecheckable at each commit.

Part B's engine and security tests inject time calculations and do not import part A at runtime. Its host-wiring tests mock only the adapter after it exists. B1a's commit changes the registration signature, so B1a and every later B commit wait until part A is merged into B's branch and B3 step 3's wiring is in the same commit as B1a. Until then, B can implement and run the injected-math tests for B1a through B2 in the working tree. Commit each task in order once A is merged. B3's parser, schema, and documentation work can also be developed before the merge. Do not land an incomplete production call site. Do not add a temporary overload, fallback implementation, or missing-module import.

B3's complete host suite and typecheck run after the merge and wiring. I1 then verifies real calculations, and I2 follows a passing I1. Only the part B writer changes part B files during integration.

### Intermediate part B test results

At each B task's verification step, run `npm test -- packages/host/src/loop packages/host/src/__tests__/loop-schedule-wiring.test.ts` as well as its focused tests. Each task's new focused tests must pass before its commit. Only the legacy rows below may remain red until the named task completes. Keep their assertions within the migration contract.

| Existing file and rows allowed to remain red | Task that turns them green |
| --- | --- |
| `loop.test.ts`: `shutdown reason %s ends both timers`; `shutdown clears a self-paced iteration and its seal`; `reports loop interval, next cadence time, prompt and a separate pending wakeup`; `reports a self-paced loop even while it has no re-arm timer`; `slash grammar shares scheduler state and stop with tool actions` | B1c migrates the two-slot listing assertions. |
| `loop.test.ts`: `drops ticks while busy rather than queueing a backlog`; `a self-paced loop can re-arm and a replacement cancels the old wakeup`; `stop during a run refuses every re-arm including %s`; `stop seals even with no live loop, until agent_settled (not agent_end)`; `replacement during a run protects its first prompt from the old run's re-arm and cancel` | B1c applies the delivery, re-arm, and seal migrations. |
| `loop.test.ts`: `manual compaction does not seal a self-paced start or a stop against the next run`; `replacing fixed with dynamic and dynamic with fixed removes the old timers`; `loop stop cancels a pending wakeup even without an active loop`; `usage and invalid slash intervals leave the current loop unchanged` | B1c applies the remaining loop migrations and lifecycle setup. |
| `schedule.test.ts`: `reports an internal re-arm rejection through the UI instead of leaving it unhandled`; `explains that a sealed replacement wakeup was not cancelled and still delivers it` | B1c adds re-arm names and migrates the listing assertion. |
| `security-sdk.test.ts`: `re-arms a %s self-paced loop internally and preserves its origin`; `keeps the model prompt %j self-paced across re-arms`; `resets a user loop's origin when a model replaces it with the same prompt`; `returns a native tool error when a loop ended during the same run` | B1c adds names and migrates only the listed status assertion. |
| `parser.test.ts`: `parses %j`, only the empty, whitespace, bare-stop, and `stop now` rows | B3 updates the stop and listing grammar. |
| `loop-schedule-wiring.test.ts`: `exposes both actions and their optional parameters on the single spider tool`; `shares one scheduler between tool actions and /loop`; `threads agent events to sealing for tool-started loops`; `separate host activations never borrow each other's scheduler` | B3 updates schema, listing, re-arm names, and independent cancellation. |
| `loop-schedule-wiring.test.ts`: `routes a wakeup through the tool without opening any project database`, plus the three scheduler-backed rows in the preceding row | B2's persistence also makes these fail because the fixture lacks `appendEntry` and `sessionManager`. B3 step 1 adds both fixture APIs, and B3 step 5 verifies the rows pass. |

Thus B1a and B1b may leave pending B1c and B3 rows red. After B1c and B2, only the listed parser and host-wiring rows may be red. B3 must leave the entire command green. Every B commit must still typecheck.

## Fixed interfaces

### Part A exports

`packages/host/src/loop/zoned.ts` exports exactly these public signatures. Numeric instants are epoch milliseconds. `offsetMinutes` is positive east of UTC.

```typescript
export interface LocalMinute {
	year: number;
	month: number;
	day: number;
	hour: number;
	minute: number;
}
export interface ZonedMinute extends LocalMinute { weekday: number }
export function resolveTimeZone(tz?: string): string;
export function zonedMinute(atMs: number, tz: string): ZonedMinute;
export function offsetMinutes(atMs: number, tz: string): number;
export function resolveLocalMinute(local: LocalMinute, tz: string): number;
export function formatInZone(atMs: number, tz: string): string;
export function parseAt(value: string, nowMs: number): number;
```

`resolveTimeZone` validates an explicit IANA name or resolves the machine default. Return a valid explicit name unchanged. With no argument, try a valid IANA `process.env.TZ` first, excluding numeric offsets. Next try the `/etc/localtime` symlink suffix after `zoneinfo/`, if valid and if `Intl` resolves it to the same zone as the default. Fall back to `Intl.DateTimeFormat().resolvedOptions().timeZone`. Preserve the selected spelling, so a Kolkata machine does not display `Asia/Calcutta` merely because `Intl` uses that alias. Expose an internal seam for the environment, symlink reader, and Intl default so tests need not change the host. `zonedMinute` returns Gregorian local fields, with weekday 0 for Sunday. `resolveLocalMinute` returns the first occurrence of an ambiguous minute or the first valid minute after a gap. `formatInZone` returns `YYYY-MM-DD HH:mm:ss <zone>`, with no locale-dependent date ordering. `parseAt` requires an offset and a strictly future instant. Reject malformed input rather than relying on permissive `Date.parse` rollover.

`packages/host/src/loop/cron.ts` exports:

```typescript
export interface CronSpec {
	minutes: readonly number[];
	hours: readonly number[];
	daysOfMonth: readonly number[];
	months: readonly number[];
	daysOfWeek: readonly number[];
	dayOfMonthWildcard: boolean;
	dayOfWeekWildcard: boolean;
}
export function parseCron(expression: string): CronSpec;
export function nextCronAt(expression: string, tz: string, afterMs: number): number;
```

Expanded arrays are sorted and unique. Weekdays normalize 7 to 0 after expansion. Wildcard flags record whether the original day field starts with `*`. `parseCron` checks syntax and field bounds. `nextCronAt` also checks occurrence feasibility, returns an instant strictly after `afterMs`, and throws a descriptive error if none exists within five calendar years. It uses the gap and overlap rules even when the search starts inside a transition. It never returns the second copy of a repeated civil minute.

### Part B injection and state

Export the following structural interface from `packages/host/src/loop/index.ts`. Do not import part A into this module, including through a runtime barrel.

```typescript
export interface SchedulerTimeMath {
	resolveTimeZone(tz?: string): string;
	parseAt(value: string, nowMs: number): number;
	formatInZone(atMs: number, tz: string): string;
	parseCron(expression: string): unknown;
	nextCronAt(expression: string, tz: string, afterMs: number): number;
}
export class SessionScheduler {
	constructor(pi: ExtensionAPI, time: SchedulerTimeMath);
	loop(args: LoopArgs, ctx: ExtensionContext): Promise<Result>;
	schedule(args: ScheduleArgs, ctx: ExtensionContext): Promise<Result>;
	command(cmd: LoopCommand, ctx: ExtensionContext, origin?: PromptOrigin): Promise<Result>;
}
export function registerLoopSchedule(
	pi: ExtensionAPI, time: SchedulerTimeMath,
): SessionScheduler;
```

Keep `Result = { text: string; details: Record<string, unknown> }` and `PromptOrigin = "user" | "model"`. Extend `ScheduleArgs` with optional `name` and `at`; extend `LoopArgs` with optional `name`, `cron`, and `tz`. Keep all current fields. Both argument types must also represent the unified tool's cross-action fields so runtime validation can report them. Loop ignores `delaySeconds`, `reason`, and `noop`, but rejects `at`. Schedule ignores `interval`, but rejects `cron` and `tz`. Run the persistent-session guard first, then the target seal for schedule writes, then recognize an exact re-arm, then apply the model-prompt guard, then field-combination errors. Preserve interval-field slash-smuggling protection.

Use a discriminated `Trigger` union. Common fields are `name`, `prompt`, `origin`, and `tz`. The variants are:

```typescript
type OnceTiming =
	| { at: string; delaySeconds?: never }
	| { delaySeconds: number; at?: never };
export type Trigger = TriggerBase & (
	| ({ kind: "once"; nextAt: number; reason?: string; noop: boolean } & OnceTiming)
	| { kind: "interval"; nextAt: number; anchor: number;
		interval: string; intervalSeconds: number }
	| { kind: "cron"; nextAt: number; cron: string }
	| { kind: "self-paced"; nextAt: number | null }
);
interface TriggerBase {
	name: string;
	prompt: string;
	origin: PromptOrigin;
	tz: string;
}
export interface TriggerSnapshot { version: 1; sessionId: string; triggers: Trigger[] }
```

The `once` timing fields record the validated input form. Enforce exactly one at the input and snapshot boundaries. All non-self-paced kinds have a non-null due time. No timer handle or compiled cron structure belongs in a snapshot.

After part A is merged into part B's branch, `packages/host/src/loop/time-math.ts` exports `createTimeMath(): SchedulerTimeMath`. It imports the five corresponding functions from `zoned.ts` and `cron.ts` and returns them without changing semantics. The scheduler uses `parseCron` only to validate syntax and bounds at restore. It does not consume the returned parsed structure. Production `extension.ts` calls `registerLoopSchedule(pi, createTimeMath())` only then.

The session-manager contract is `getEntries(): SessionEntry[]` and `getSessionId(): string`. Restore chooses the last matching custom snapshot in file order, not the active branch. The harness stores an append-ordered list and a separate leaf, with `branch(id)` moving only that leaf.

Listing returns `details: { triggers: TriggerListing[] }`, with `TriggerListing = Trigger & { state: "scheduled" | "due" | "waiting-for-rearm"; nextAtUtc: string | null; nextAtLocal: string | null }`. Mutation results retain existing observable fields such as `stopped`, `cancelled`, `delaySeconds`, `fireAt`, and `noop` where applicable. Additional listing data must not break those assertions.

---

## Part A: Time calculations

### Task A1: Parse absolute times and resolve zoned civil minutes

**Files:** Create `packages/host/src/loop/zoned.ts` and `packages/host/src/loop/__tests__/zoned.test.ts`.

**Interfaces:** Produce every `zoned.ts` export in the fixed interfaces section. No dependency on the scheduler.

- [ ] **Step 1: Write failing table-driven tests.** Let `ms` in test examples mean `Date.parse`, not a production helper. Use independent ISO expectations:

```typescript
expect(parseAt("2026-10-27T08:00+05:30", ms("2026-10-26T00:00Z")))
	.toBe(ms("2026-10-27T02:30Z"));
expect(zonedMinute(ms("2026-10-27T02:30Z"), "Asia/Kolkata"))
	.toEqual({ year: 2026, month: 10, day: 27, hour: 8, minute: 0, weekday: 2 });
expect(offsetMinutes(ms("2026-10-27T02:30Z"), "Asia/Kolkata")).toBe(330);
expect(resolveTimeZone("Asia/Kolkata")).toBe("Asia/Kolkata");
expect(formatInZone(ms("2026-10-27T02:30Z"), "Asia/Kolkata"))
	.toBe("2026-10-27 08:00:00 Asia/Kolkata");
```

Name the additional tests `requires an offset and a future valid date`, `accepts optional seconds and dates beyond one hour`, `resolves and validates IANA zones`, and `uses Gregorian h23 fields at midnight`. Pin `YYYY-MM-DDTHH:mm[:ss[.fff]](Z|±HH:MM)`, with uppercase `T` and `Z`, offset hours 00 through 14, and offset minutes 00 through 59. Reject offsetless input, February 30, hour 24, offset hour 15, offset minute 60, lowercase `t` or `z`, basic `+0530`, fractions without seconds, fractions longer than three digits, an equal-to-now instant, and past dates. Accept `Z`, negative offsets, one through three fractional digits after seconds, and a date more than five years away. Reject `Not/AZone` and offset-string zone names.

Add `preserves the machine zone spelling before falling back to Intl`. With `TZ` unset, a link ending `zoneinfo/Asia/Kolkata`, and Intl default `Asia/Calcutta`, assert `resolveTimeZone()` returns `Asia/Kolkata`. A valid `TZ=Asia/Kolkata` wins over the link. Invalid or offset-valued `TZ` falls through. A missing, unreadable, invalid, or different-zone link falls back to Intl. Stub the internal environment, link reader, and Intl-default seam for deterministic tests.

Add these civil-minute assertions under `resolves gaps to their end and overlaps to their first instant`:

| Zone and local minute | Expected UTC result |
| --- | --- |
| America/New_York, 2026-03-08 02:30 | `2026-03-08T07:00:00.000Z` |
| America/New_York, 2026-11-01 01:30 | `2026-11-01T05:30:00.000Z` |
| Australia/Lord_Howe, 2026-10-04 02:15 | `2026-10-03T15:30:00.000Z` |
| Australia/Lord_Howe, 2026-04-05 01:45 | `2026-04-04T14:45:00.000Z` |
| Asia/Kolkata, 2026-10-27 08:00 | `2026-10-27T02:30:00.000Z` |

For each row, assert `expect(resolveLocalMinute(local, zone)).toBe(ms(expected))`. Also test invalid civil dates, negative UTC offsets, month and year rollover, and both sides of each transition.

- [ ] **Step 2: Run the tests and confirm failure from missing exports.** Run `npm test -- packages/host/src/loop/__tests__/zoned.test.ts`. A test-runner or import-configuration failure is not the intended red result.
- [ ] **Step 3: Implement the fixed signatures in `zoned.ts`.** Use cached `Intl.DateTimeFormat` instances and `formatToParts`. Validate calendar fields before converting. Derive plausible offsets around a local date, round-trip candidate instants, and choose the earliest exact match. If none matches, locate the forward transition and its first valid minute. Search the transition boundary at minute precision. Do not add one hour or normalize a missing 02:30 to 03:30. Keep offset discovery bounded around each civil date, including non-hour and skipped-day transitions.
- [ ] **Step 4: Run the same test command.** Expected: all zoned tests pass in an arbitrary host zone. Repeat with `TZ=UTC npm test -- packages/host/src/loop/__tests__/zoned.test.ts` and `TZ=America/Los_Angeles npm test -- packages/host/src/loop/__tests__/zoned.test.ts`.
- [ ] **Step 5: Commit explicit paths.** Run `git add packages/host/src/loop/zoned.ts packages/host/src/loop/__tests__/zoned.test.ts` and `git commit -m "feat: add zoned wall-clock calculations"`.

### Task A2: Parse cron and find the next occurrence

**Files:** Create `packages/host/src/loop/cron.ts` and `packages/host/src/loop/__tests__/cron.test.ts`.

**Interfaces:** Consume A1's zoned exports. Produce `CronSpec`, `parseCron`, and `nextCronAt` exactly as fixed above.

- [ ] **Step 1: Write failing grammar and occurrence tests.** Name grammar cases `expands stars ranges lists and steps`, `normalizes Sunday after step expansion`, `keeps Vixie wildcard flags`, and `rejects unsupported syntax`. Pin these assertions:

```typescript
expect(parseCron("*/15 8-9 * * 5-7").minutes).toEqual([0, 15, 30, 45]);
expect(parseCron("5/10 * * * *").minutes).toEqual([5, 15, 25, 35, 45, 55]);
expect(parseCron("0 8 * * 5-7").daysOfWeek).toEqual([0, 5, 6]);
expect(parseCron("0 8 */2 * 1").dayOfMonthWildcard).toBe(true);
expect(parseCron("0 8 1-31 * 1").dayOfMonthWildcard).toBe(false);
```

For each of `0 0 30 2 *`, `0 0 31 4 *`, and `0 0 31 6 *`, assert `nextCronAt(expression, "UTC", ms("2026-01-01T00:00Z"))` throws a no-occurrence error. Syntax rejects zero steps, `60`, reversed ranges, empty list items, six fields, month names, weekday names, and macros. Test restricted day OR with `0 8 15 * 1`, bare-star day matching with `0 8 * * 1`, and stepped-star day matching with `0 8 */2 * 1`.

Use `expect(nextCronAt(expression, zone, ms(after))).toBe(ms(expected))` for each row:

| Expression | Zone | After UTC | Expected next UTC |
| --- | --- | --- | --- |
| `0 8 * * *` | Asia/Kolkata | `2026-10-26T02:29:59Z` | `2026-10-26T02:30:00Z` |
| `0 8 * * *` | Asia/Kolkata | `2026-10-26T02:30:00Z` | `2026-10-27T02:30:00Z` |
| `30 2 * * *` | America/New_York | `2026-03-08T05:00:00Z` | `2026-03-08T07:00:00Z` |
| `30 1 * * *` | America/New_York | `2026-11-01T04:00:00Z` | `2026-11-01T05:30:00Z` |
| `30 1 * * *` | America/New_York | `2026-11-01T05:45:00Z` | `2026-11-02T06:30:00Z` |
| `15 2 * * *` | Australia/Lord_Howe | `2026-10-03T14:00:00Z` | `2026-10-03T15:30:00Z` |
| `45 1 * * *` | Australia/Lord_Howe | `2026-04-04T14:50:00Z` | `2026-04-05T15:15:00Z` |
| `0 0 29 2 *` | UTC | `2026-03-01T00:00:00Z` | `2028-02-29T00:00:00Z` |

Add `deduplicates matching gap minutes` using `* 2 * * *` in New York. After the gap's 07:00 UTC resolution, the next result is the next day's 02:00 local, not another missing minute mapped to 07:00. Test searches made inside the gap and inside the second occurrence of an overlap. Include year rollover and exact horizon-boundary tests.

- [ ] **Step 2: Run `npm test -- packages/host/src/loop/__tests__/cron.test.ts`.** Expected: missing cron exports fail the new tests.
- [ ] **Step 3: Implement `parseCron` and `nextCronAt` in `cron.ts`.** Enumerate valid civil dates and matching hours and minutes, resolving them through A1. Start early enough to include missing civil minutes on the current date whose gap-end instant is still ahead. Choose the first resolved instant strictly after the search time. Preserve wildcard flags for day matching and deduplicate equal resolved instants. Bound the search by five UTC calendar years with the documented leap-day clamp. Skip calendar dates before converting minutes so impossible dates do not require millions of `Intl` calls.
- [ ] **Step 4: Run both part A files.** Run `npm test -- packages/host/src/loop/__tests__/zoned.test.ts packages/host/src/loop/__tests__/cron.test.ts`. Expected: all pass, including the second-occurrence exclusions.
- [ ] **Step 5: Commit.** Run `git add packages/host/src/loop/cron.ts packages/host/src/loop/__tests__/cron.test.ts` and `git commit -m "feat: calculate zoned cron occurrences"`.

## Part B: Trigger scheduler and public behavior

### Task B1a: Add named definitions, validation, and listing

**Files:** Modify `packages/host/src/loop/index.ts`, `packages/host/src/loop/__tests__/harness.ts`, `packages/host/src/loop/__tests__/loop.test.ts`, `packages/host/src/loop/__tests__/schedule.test.ts`, and `packages/host/src/loop/__tests__/security-sdk.test.ts`. Create `packages/host/src/loop/__tests__/triggers.test.ts`. B1b and B1c continue in these files.

**Interfaces:** Produce the fixed scheduler interface and trigger union. Add `setup(time?: SchedulerTimeMath, saved?: { sessionId: string; entries: SessionEntry[]; leafId: string | null }): Harness`. The harness keeps entries in append order and tracks the leaf separately. `appendEntry` appends with the current leaf as parent and moves the leaf. Expose `getEntries()`, `getSessionId()`, and `branch(id)`. Keep `setIdle`, `emit`, `slash`, and `prompts`. No fixture imports part A.

The default fake calculations have this exact contract:

- `resolveTimeZone(tz)` returns `tz ?? "Test/Zone"` and throws for `"Bad/Zone"`.
- `formatInZone(atMs, tz)` returns `new Date(atMs).toISOString().replace("T", " ").replace("Z", "") + " " + tz`.
- `parseCron(expression)` returns an opaque parsed value for expressions configured as syntax-valid, including `0 0 30 2 *`. It throws for `"invalid"` and expressions configured as syntax-invalid. It never calls `nextCronAt` or checks occurrence feasibility.
- `nextCronAt(expression, tz, afterMs)` uses a per-test table keyed by expression. It returns the first configured instant strictly after `afterMs`. It throws for `"invalid"`, a missing table row, or an exhausted row. The fixture must configure enough occurrences for each test.
- `parseAt(value, nowMs)` returns `Date.parse(value)` only for an offset-bearing, finite instant strictly after `nowMs`. It rejects missing offsets and past or equal instants. Production grammar is A1's responsibility.

Fake `Date` together with timers and set the fixture clock to `2026-10-20T12:00:00Z`. Inject the same fake calculations in the SDK fixture when changing the registration signature. Add `"Date"` to the SDK's `toFake` list and call `vi.setSystemTime(new Date("2026-10-20T12:00:00Z"))` after `bindExtensions`, without changing existing security-test bodies. A send records the message but leaves `ctx.isIdle()` true. Do not make a send synchronously set busy. Add an explicit `settleDelivery(): Promise<void>` fixture helper that emits `agent_start` then `agent_settled` and flushes the requested check. Tests call it only after an observed delivery when they need to model a completed run. Gate tests intentionally withhold those events.

- [ ] **Step 1: Write failing tests in `describe("named trigger definitions")`.** Cover names of length 1 and 40, rejected length 41, rejected leading punctuation, allowed punctuation after the first character, and case-sensitive independence. Create 20 names, reject a 21st, then replace an existing one successfully. Assert the complete old listing is unchanged after a failed replacement.

Add `validates argument combinations without mutating old state`: both or neither schedule timing fields, a past `at`, both loop timing fields, `tz` without cron, blank prompts, and invalid cron all reject before replacement. Change the fake default zone after creation and assert the stored `tz` stays unchanged.

Add `ignores legacy cross-action fields and rejects new ones`. Loop ignores `delaySeconds`, `reason`, and `noop`; schedule ignores `interval`. Loop with `at`, schedule with `cron`, and schedule with `tz` reject with the exact clear errors in the spec. Include listing and stop requests with forbidden fields. Assert persistent-session errors win over all other errors and model-prompt errors win over field-combination errors. B1c tests seal precedence. Keep the existing cross-action security and child-guard test bodies and assertions unchanged.

Add `formats the complete listing`: every kind, full prompts, future UTC and local times, both origins, due state while busy, and waiting-for-rearm for null self-paced times. Assert name order, one text line per trigger, and an 80-character single-line preview. Empty output is `No triggers are active.`.

- [ ] **Step 2: Run `npm test -- packages/host/src/loop/__tests__/triggers.test.ts -t "named trigger definitions"`.** Expected: the new name, validation, and listing assertions fail against the old slots, not from test-runner configuration.
- [ ] **Step 3: Implement definitions and listing in `index.ts`.** Use `Map<string, Trigger>` and validate the entire replacement before mutation. Preserve existing result fields. Apply the spec's guard order and cross-action policy, including interval-field slash-smuggling protection. Keep the schedule validation diagnostic `spider schedule needs delaySeconds or at, and a prompt, unless stop is true; delaySeconds must be finite`. Keep the `Wakeup scheduled` result prefix. Consume the injected calculations and retain captured zone spelling.
- [ ] **Step 4: Repeat the focused command.** Expected: all named-definition tests pass without part A's calculations in the fixture. Also run `npm test -- packages/host/src/loop packages/host/src/__tests__/loop-schedule-wiring.test.ts`. Only the pending B1c and B3 legacy rows in the intermediate-test table may be red. Keep delivery tests for B1b and security migrations for B1c.
- [ ] **Step 5: Commit the owned paths for this task.** This commit changes the registration signature. Wait for part A to be merged into B's branch and include B3 step 3's real adapter and production registration wiring in this same commit. Every later B commit follows that merge. Run `npm run typecheck`, stage the six files above plus `packages/host/src/extension.ts` and `packages/host/src/loop/time-math.ts`, and run `git commit -m "feat: define named session triggers"`.

### Task B1b: Reconcile due work and gate dispatch

**Files:** Modify `packages/host/src/loop/index.ts`, `packages/host/src/loop/__tests__/harness.ts`, and `packages/host/src/loop/__tests__/triggers.test.ts`.

**Interfaces:** Consume B1a's trigger map and fake calculations. Reconciliation uses the latest `session_start` context, or the most recent tool or command context before any start event. The dispatch gate records a send time and whether `agent_start` has arrived. It shares the scheduler's one timeout rather than allocating a second timer.

- [ ] **Step 1: Write failing tests in `describe("ticker reconciliation")`.** Add `uses one wall-clock ticker and preserves due work`: jump with `vi.setSystemTime` without running callbacks, then run only the next 30-second callback. Assert one missed delivery, not one per missed interval. While busy, assert no delivery and unchanged overdue `nextAt`. Settle and assert one delivery. For an interval anchored at 12:00 with a one-minute period, deliver a busy occurrence at 12:10:10 and assert next time 12:11:00. Jump backward and assert no repeat. Verify at most one scheduler timeout and no timer when no due or future work needs a check.

Add `orders simultaneous due triggers without duplicate pending fires`: make `b` due before `a`, then make both overdue. Observe `b` then `a`. Repeat with equal due times and assert name order. Leave `isIdle()` true after the first send. Run more callbacks and assert no second send before explicit `agent_start` and `agent_settled`. Neither `agent_end` nor five seconds after an observed start opens the gate. In a separate case, emit no start, assert the gate stays closed at 4,999 milliseconds, and opens at 5,000 milliseconds only when idle. Test a busy fallback deadline, followed by the one-second idle retry. Assert that the retry both opens the gate and delivers the next due trigger in that same callback, without another timer advance. Test a slash command handled without starting a run.

Add `an immediate first prompt waits behind a closed gate`. Send one delivery, then create a self-paced loop while idle. Assert no inline delivery. Emit `agent_start` and `agent_settled`, flush the requested check, and assert the first prompt is delivered. Also preserve inline delivery before a create returns when the gate is open.

Add `consumes an occurrence whose delivery check fails and notifies once`. Parameterize once, self-paced, interval, and cron. Change the latest context to print or child mode after arming. Assert no send, once removal, self-paced null, and normal advancement of repeaters whose next time can be computed. Configure a thrown `nextCronAt` during advancement and assert cron removal. Simulate an interval advancement failure and assert interval removal. Advance ten more seconds and assert exactly one error notification and no retry of the occurrence. B2 adds the snapshot assertions.

Add `delivers the current occurrence when only advancement fails`. Keep the persistent-session guard valid, make cron or interval advancement throw, and assert one delivery, removal, and one notification. Advance ten more seconds and assert no repeat. B2 adds snapshot-before-send assertions.

Add `uses the latest activation context for fire-time checks` and verify the most recent pre-start tool context is used until `session_start` supplies a replacement. B2 adds the snapshot-write failure test alongside persistence.

- [ ] **Step 2: Run `npm test -- packages/host/src/loop/__tests__/triggers.test.ts -t "ticker reconciliation"`.** Expected: ticker, dispatch gate, and failure-consumption assertions fail before their implementation.
- [ ] **Step 3: Implement reconciliation in `index.ts`.** Use one unref'd timeout, a run flag, and the dispatch gate. A create that leaves an interval or self-paced occurrence due runs one reconciliation pass inline before returning. Use the ticker's same eligibility and dispatch gate. Retain the first due occurrence while busy or behind a closed gate. Cron starts at the injected future occurrence. Select one due trigger by `nextAt` then name. Consume or advance it before sending. B2 inserts the required snapshot before the send. Close the gate at occurrence selection, before consumption, snapshot append, and `sendUserMessage`. If preparation fails without sending, release it after consuming the failed occurrence. After a send, require start then settled, or the five-second no-start idle fallback. A started run never times out through the gate. A check that opens the gate selects and delivers one due trigger in that same callback. A preflight longer than five seconds can let the next delivery start first or merge into the delayed run. No occurrence is lost or repeated because of this fallback, but ordering is best effort. Defer settled-event checks through the timeout because that event is notification-only.

On a fire-time guard error, consume without sending and notify once. Advance repeaters if possible. If only advancement fails, remove the trigger, deliver its current occurrence once, and notify once. B2 must save the removal before that send. Never leave the same consumed occurrence due. B2 adds failure snapshots and their write-error handling. Clear timers, state, and the gate on shutdown. Timers armed before shutdown must never deliver, but later calls on the same object act fresh.

- [ ] **Step 4: Repeat the focused command.** Expected: ticker and gate tests pass. Also rerun B1a's named-definition tests and `npm test -- packages/host/src/loop packages/host/src/__tests__/loop-schedule-wiring.test.ts`. Only the pending B1c and B3 legacy rows in the intermediate-test table may be red.
- [ ] **Step 5: Run `npm run typecheck`, stage the three files, and commit.** Run `git commit -m "feat: reconcile wall-clock triggers with ordered dispatch"`.

### Task B1c: Preserve named re-arms, seals, and prompt security

**Files:** Modify `packages/host/src/loop/index.ts`, `packages/host/src/loop/__tests__/harness.ts`, `packages/host/src/loop/__tests__/triggers.test.ts`, `packages/host/src/loop/__tests__/loop.test.ts`, `packages/host/src/loop/__tests__/schedule.test.ts`, and `packages/host/src/loop/__tests__/security-sdk.test.ts`.

**Interfaces:** Consume B1b's delivery gate. Use `Set<string>` seals and exact name-and-prompt matching for re-arms. The SDK fixture injects B1a's fake calculations. Add `"Date"` to its `toFake` list and call `vi.setSystemTime(new Date("2026-10-20T12:00:00Z"))` after `bindExtensions`. This setup change requires no existing security-test body changes.

- [ ] **Step 1: Write failing re-arm, seal, late-note, and SDK tests.** Apply only the named legacy-test updates in the migration contract. `keeps named one-shots separate from loop re-arms` creates one-shots `build` at 60 seconds and `deploy` at 120 seconds, plus self-paced `watch`. After observing and settling its first prompt, re-arm `watch` by scheduling `{name:"watch",delaySeconds:180,prompt:"/loop watch check"}`. Advance through all due times, completing each delivery's lifecycle. Assert each one-shot fires once and `watch` twice, with instructions naming `watch`. No one-shot named `watch` ever exists. An ordinary same-name schedule replaces that trigger only when it is not an exact re-arm.

Add `seals only the stopped or replaced name until settled`: create `a` and `b`, enter a run, stop `a`, reject writes under `a`, permit a re-arm under `b`, and permit one-shot `c`. `agent_end` does not clear seals; `agent_settled` does. Repeat with absent `a`, replacement waiting for idle, and manual compaction without a run. Assert sealed schedule writes win over slash-prompt errors, including a reworded re-arm under a sealed name.

Add `adds a late note only beyond two minutes`: compare 120,000 and 120,001 milliseconds late. Pin the original due time in UTC and the stored zone, and the spec's cause text. Assert prompt, self-paced instructions, then late note. Preserve `${prompt}\n\n[/loop, self-paced]`. User slash prompts have no late note. Never deliver the internal re-arm string or dispatch it through the slash parser.

In `security-sdk.test.ts`, add `delivers two simultaneously due triggers as separate ordered runs`. Create two named one-shots with the same due instant through the SDK tool and filter creation requests out of `users()`. Delay the first firing in an asynchronous input handler so `isIdle` stays true during preflight. Advance callbacks for 4,999 milliseconds and prove the second send is held while `isIdle()` is still true. Release preflight before the five-second fallback, let the faux provider settle the first run, then observe the second. Assert `users()` has exactly the two firing prompts in name order and the event trace has start, settled, start, settled, with one firing per run. Use no synchronous busy flip and no direct scheduler delivery call. Retain a provider response for each run.

- [ ] **Step 2: Run `npm test -- packages/host/src/loop/__tests__/triggers.test.ts packages/host/src/loop/__tests__/loop.test.ts packages/host/src/loop/__tests__/schedule.test.ts packages/host/src/loop/__tests__/security-sdk.test.ts`.** Expected: missing named re-arms, seals, late-note order, and the SDK race regression fail before their implementation.
- [ ] **Step 3: Implement re-arms, seals, and prompt composition in `index.ts`.** A re-arm updates only the matching self-paced trigger's next time and keeps its origin. Refuse schedule writes to a sealed name before the model-prompt guard, including reworded slash prompts. Other names remain independent. Keep origin-dependent template expansion and the existing slash-smuggling checks. Compose the original prompt, self-paced instructions, then the optional late note.
- [ ] **Step 4: Repeat the engine and real-SDK command.** Expected: all focused engine and SDK tests pass without A's calculations in the fixtures. Also run `npm test -- packages/host/src/loop packages/host/src/__tests__/loop-schedule-wiring.test.ts`. Only the B3 parser and host-wiring rows in the intermediate-test table may remain red. Check that the faux provider and SDK session still settle with faked `Date`, including all delay-based security cases and the two-due-trigger regression. Preserve existing rejection diagnostics and unrelated assertions.
- [ ] **Step 5: Run `npm run typecheck`, stage the six files, and commit.** Run `git commit -m "feat: preserve named re-arms and prompt security"`.

### Task B2: Persist definitions and consumed occurrences

**Files:** Modify `packages/host/src/loop/index.ts` and `packages/host/src/loop/__tests__/harness.ts`. Create `packages/host/src/loop/__tests__/persistence.test.ts`.

**Interfaces:** Use `TriggerSnapshot` and pi's actual `appendEntry<T>(customType: string, data?: T): void`. Restore from `ctx.sessionManager.getEntries(): SessionEntry[]` with current `getSessionId(): string`. Register `session_start` and use its `reason: "startup" | "reload" | "new" | "resume" | "fork"`.

- [ ] **Step 1: Write failing persistence tests.** Add harness methods `snapshots(): TriggerSnapshot[]`, returning defensive copies, and `restart(reason: SessionStartEvent["reason"], start?: { mode?: ExtensionContext["mode"]; child?: boolean }): Promise<Harness>`. `restart` emits shutdown, creates a fresh activation over the append-ordered saved entries and separate leaf, and emits the requested start event before returning it. Allow a mode and child-environment override before that start event so restricted-mode starts are testable. Never restore by sharing the previous activation's trigger map.

Use `expect(h.snapshots()).toHaveLength(n)` before and after each operation. Assert the full `{version:1, sessionId, triggers}` payload. Hold the fixture busy when testing definition writes so an immediate self-paced fire does not count as part of the create operation. Cover these deltas:

| Operation | Snapshot delta |
| --- | --- |
| Create, replace, successful stop, successful cancellation | 1 each |
| Self-paced re-arm | 1 |
| Once, cron, or self-paced fire | 1 each |
| Successful interval fire, listing, invalid request, no-op stop | 0 |
| Consumed fire-time check or advance failure, including an interval failure | 1 |
| Any `session_shutdown` | 0 |

Parameterize restoration over startup, reload, resume, new, and fork. Assert saved names return for the first three only, and only when the session ID matches. Include an older matching snapshot followed by a foreign-session snapshot, and an empty matching snapshot after a cancellation. Do not revive the cancelled trigger. Select by file order even when timestamps disagree.

Add `restores the newest snapshot after tree navigation`. Save a fixture entry before any trigger snapshots. Create and fire a cron trigger, then use harness `branch(id)` to move the leaf to that earlier entry, before both the creation and consumption snapshots. This models `/tree` without a `session_start`. Create a once trigger on the new branch, move the leaf back to the saved earlier entry once more, and restart with `reload`. The latest snapshot must be outside the active branch at restart, so using a branch-only read makes this test fail. Assert both triggers are present, the cron retains its advanced next time rather than becoming overdue, and no consumed cron occurrence repeats. The new snapshot must contain both names despite their different branches. Repeat tree navigation after cancelling a trigger and after consuming a once, then reload and assert neither returns. Use an append-ordered list plus a separate leaf, not a branch-only fixture.

Add `does not restore or consume in print, json or child starts`. Parameterize print, JSON, and `PI_SUBAGENT_CHILD=1`, including a child with RPC transport. Start with an overdue saved once and cron snapshot. Assert empty runtime state, zero timers, no sends, and no writes after advancing time and emitting settled. Start the same saved session in top-level `tui` afterward and assert each overdue occurrence fires once. The restricted start must leave the saved snapshot untouched.

Add `fires restored missed once and cron triggers once with the original due time`: save future definitions, shut down, advance the wall clock more than two minutes beyond them, restore into a new activation, then settle. Assert exactly one delivery each, both late-time renderings, once removal, and cron advancement strictly after now. Restore again and assert no repeat. Add a less-than-two-minute restore case without a late note.

Add `resumes intervals from their anchor without catching up`: restore well past several periods, assert no immediate interval message, and assert its next anchored instant strictly after now. Add `keeps user origin across restore` and assert the actual send options retain template expansion for user origin only.

The regression `drops a consumed self-paced re-arm after reload` must perform the complete sequence:

```typescript
await h.runtime.loop({ name: "watch", prompt: "watch check" }, h.ctx);
await h.runtime.schedule({ name: "watch", delaySeconds: 60, prompt: "/loop watch check" }, h.ctx);
await vi.advanceTimersByTimeAsync(60_000);
expect(h.snapshots().at(-1)!.triggers).toEqual([
	expect.objectContaining({ name: "watch", kind: "self-paced", nextAt: null }),
]);
const restored = await h.restart("reload");
expect((await restored.runtime.loop({}, restored.ctx)).details).toEqual({ triggers: [] });
await vi.advanceTimersByTimeAsync(3_600_000);
expect(restored.prompts()).toEqual([]);
```

Also restore before the re-arm fires and assert the pending iteration still fires once. Add `rejects the latest malformed snapshot without falling back`: unknown version, invalid fields, invalid name, more than 20 names, duplicate names, invalid zone, cron syntax or field-bound errors, and a model-origin slash prompt including leading whitespace all notify and restore nothing. Validate cron with `parseCron` only. Do not consult `nextCronAt` during snapshot validation or reapply the future-only `at` creation check to a legitimate overdue once trigger.

Add `restores other triggers alongside a cron with no future occurrence`. Restore `0 0 29 2 *` with its stored 2096-02-29 `nextAt` after `2096-03-01T00:00:00Z`, alongside a valid once trigger. Make fake `nextCronAt` throw for the cron's next search. Assert both restore, the cron keeps its stored due time, and validation never calls `nextCronAt`. On reconciliation, assert one cron delivery, cron removal, and one notification. The other trigger remains eligible and delivers once after the gate opens. Restore accepts the syntax-valid `0 0 30 2 *` too, without asking the fake `nextCronAt` to validate it. Its later advance follows the same failure rule.

Extend B1b's fire-time failure test to assert one resulting snapshot, then advance ten more seconds and assert no extra notifications or writes. Add `does not retry a failed fire snapshot`: make `appendEntry` throw after once, cron, or self-paced consumption. Assert no send, the consumed in-memory state, one combined error notification, and no repeat append for ten seconds. Also test a persistent-session guard failure followed by a write failure. There must still be only one notification. Document that restart can see the older durable snapshot.

Add `keeps definition changes in memory when snapshot writes fail`. Parameterize create, replace, stop, cancel, and self-paced re-arm. Hold the fixture busy to separate definition writes from fires. Make `appendEntry` throw and assert the new in-memory state, a result with its normal observable fields and a warning, and one notification. Advance ten seconds and assert no retry of that append or extra notification. Then permit a write, change another definition, and assert that the successful full snapshot includes the retained state. Verify that an advance-only failure saves the trigger's removal before delivering its final current occurrence. If that snapshot fails, assert no send and one combined notification.

Add `drops an interval first prompt still waiting at reload`: create while busy, reload before delivery, and assert only a future anchored tick remains. Add `allows fresh calls after shutdown without reviving old timers`: cancel the old timeout, call schedule on the same object, and prove only the new timer can deliver. Keep the existing shutdown reuse test intact.

- [ ] **Step 2: Run `npm test -- packages/host/src/loop/__tests__/persistence.test.ts`.** Expected: missing snapshots and restoration fail, including the consumed-self-paced case.
- [ ] **Step 3: Implement snapshot validation, write points, and restore in `index.ts`.** Select the latest matching custom entry in `getEntries()` file order before validating it. Keep persisted origins, but reject model-origin slash prompts. Short-circuit print, JSON, and child starts before reading or writing snapshots or arming a timer. Validate restored cron syntax and bounds with the injected `parseCron` only, retaining stored `nextAt` without a feasibility search. Write after all non-interval fires, including self-paced consumption to null, and after consumed check or advance failures. Append the snapshot before `sendUserMessage`, so the next run cannot re-arm before consumption is saved. If append fails, skip the send and retain consumed state in memory without retrying that append or occurrence. Combine a check or advance error with the write error into one notification. If only advancement fails, remove the trigger and save that removal before delivering the current occurrence once. Notify once with the advance error. If a definition-change append throws, retain the new in-memory state, return the normal result with a warning, and notify once. Do not retry that append on every callback. The next successful full snapshot supersedes it. On restore, recompute interval times from anchors, retain overdue once and cron times, and drop null self-paced loops. Ignore all restore data on new and fork. Never append in shutdown or directly in the settled notification callback.
- [ ] **Step 4: Run `npm test -- packages/host/src/loop/__tests__/persistence.test.ts packages/host/src/loop/__tests__/triggers.test.ts packages/host/src/loop/__tests__/loop.test.ts packages/host/src/loop/__tests__/schedule.test.ts packages/host/src/loop/__tests__/security-sdk.test.ts`.** Expected: all focused persistence, engine, and SDK tests pass. Also run `npm test -- packages/host/src/loop packages/host/src/__tests__/loop-schedule-wiring.test.ts`. Only the B3 parser and host-wiring rows in the intermediate-test table may remain red, including the scheduler-backed wiring rows now missing persistence fixture APIs. Assert no timer armed before shutdown delivers. A later call on that same object is allowed to act as a fresh activation. Inspect snapshot-before-send call order and assert no write from shutdown or a restricted-mode start.
- [ ] **Step 5: Commit.** Run `git add packages/host/src/loop/index.ts packages/host/src/loop/__tests__/harness.ts packages/host/src/loop/__tests__/persistence.test.ts` and `git commit -m "feat: restore session triggers across reloads"`.

### Task B3: Update slash commands, host wiring, and documentation

**Files:** Modify `packages/host/src/loop/parser.ts`, `packages/host/src/loop/__tests__/parser.test.ts`, `packages/host/src/loop/index.ts`, `packages/host/src/extension.ts`, `packages/host/src/__tests__/loop-schedule-wiring.test.ts`, `packages/superpowers/src/agentsmd-content.ts`, `README.md`, `docs/guide/loop-and-schedule.md`, `docs/guide/subagents.md`, `docs/guide/using-spider.md`, `docs/architecture/README.md`, and `packages/host/README.md`. Create `packages/host/src/loop/time-math.ts`.

**Interfaces:** Extend `LoopCommand` to the exact union below. `command` consumes it and preserves origin semantics. Produce `createTimeMath(): SchedulerTimeMath` and update production registration to inject it.

```typescript
export type LoopCommand =
	| { kind: "list" }
	| { kind: "stop"; target: "defaults" }
	| { kind: "stop"; target: "all" }
	| { kind: "stop"; target: "name"; name: string }
	| { kind: "usage"; reason?: string }
	| { kind: "fixed"; seconds: number; prompt: string }
	| { kind: "dynamic"; prompt: string };
```

- [ ] **Step 1: Write failing parser and host tests.** Pin `parseLoop("")` and whitespace to `{kind:"list"}`, `stop` to the defaults target, `stop all` to all, and `stop build` to the name target. Reject an invalid name or excess stop tokens with usage. Keep all valid interval and dynamic-prompt grammar assertions other than the specifically replaced stop grammar. `/loop` lists before usage without changing definitions. Test default stop, stop by name for each kind, and stop all. Tool loop stop must leave the default wakeup intact.

Prepare `loop-schedule-wiring.test.ts` with a mock of `../loop/time-math` using the injected fake calculations. Run those adapter-dependent tests after the A merge and creation of the real adapter file. The fixture uses no real calculations, but it must not conceal an absent production module. Assert schema fields `at`, `cron`, and `tz` are optional strings, `name` describes trigger naming, and descriptions explain independent names, persistence, cron zones, and the re-arm exception. Route a named cron and a named `at` through the actual registered tool. Assert scheduler routing still opens no project database. Add `appendEntry` and session-manager methods to the host fixture instead of making persistence optional in production.

- [ ] **Step 2: Run the failing parser and schema checks.** Before the A merge, run `npm test -- packages/host/src/loop/__tests__/parser.test.ts` and `npm test -- packages/host/src/__tests__/loop-schedule-wiring.test.ts -t "exposes both actions and their optional parameters"` without an adapter mock that imports an absent file. Expected: new stop grammar and schema assertions fail against the old behavior. Once A and the real adapter exist, run the entire host-wiring file before completing argument forwarding. Its new routing assertions must fail for the missing behavior, not a missing module.
- [ ] **Step 3: Implement parser and production wiring.** Parser and schema edits need not wait for A. Before creating `time-math.ts` or changing production registration to `registerLoopSchedule(pi, createTimeMath())`, merge part A into part B's branch and verify both real modules exist. Complete the adapter and production registration wiring in B1a's commit, after the mandatory A merge. B3 reuses that wiring. Do not use mocks to hide a missing production import. Keep no-argument slash listing separate from invalid-input usage. Add the typed stop targets. Default slash stop removes only `loop` and `wakeup`. Named slash stop removes one trigger of any kind. Stop all removes every trigger and seals removed loop names during a run. `all` remains usable as a tool name even though slash stop reserves it. Update `extension.ts` parameter definitions near the current loop fields, the global `name` description, registration, and the tool description. Keep direct routing before database resolution. Implement the real adapter with static imports from A, not substitute math.
- [ ] **Step 4: Update all seven instruction and documentation locations.** In the guide, include daily Kolkata cron, offset-bearing `at`, name replacement, named re-arm examples with `name:"loop"`, numeric-only cron, Vixie matching, DST behavior, late notes, listing, and stop forms. Replace dropped-busy-tick prose with one due firing after idle. State that tool loop stop no longer cancels the independent `wakeup`, `/loop stop <words>` is a stop request or usage error rather than a self-paced prompt, and cron has no immediate first prompt. Say exactly what survives reload and same-session resume, what starts empty, and what happens during sleep or closure. Include interval-first-prompt loss on reload, duplicate firing if two processes open the same session, and one full saved snapshot per non-interval fire. Update the README action table and slash summary, the subagent lifetime distinction, the using-spider summary, architecture ownership and session-entry storage, host modules, and the managed block. Do not edit a machine's generated AGENTS.md. Keep the no-subagent-polling warning.
- [ ] **Step 5: Run parser, mocked host-wiring, and engine tests.** Run `npm test -- packages/host/src/loop/__tests__/parser.test.ts packages/host/src/__tests__/loop-schedule-wiring.test.ts packages/host/src/loop/__tests__/triggers.test.ts packages/host/src/loop/__tests__/persistence.test.ts packages/host/src/loop/__tests__/loop.test.ts packages/host/src/loop/__tests__/schedule.test.ts packages/host/src/loop/__tests__/security-sdk.test.ts`. Also run `npm test -- packages/host/src/loop packages/host/src/__tests__/loop-schedule-wiring.test.ts`, then run `npm test -- packages/host` and `npm run typecheck`. Expected: every command passes with A merged and the real production adapter wired. Do not defer the full host suite or typecheck to I1.
- [ ] **Step 6: Commit explicit paths.** Run:

```sh
git add packages/host/src/loop/parser.ts packages/host/src/loop/__tests__/parser.test.ts packages/host/src/loop/index.ts packages/host/src/loop/time-math.ts packages/host/src/extension.ts packages/host/src/__tests__/loop-schedule-wiring.test.ts packages/superpowers/src/agentsmd-content.ts README.md docs/guide/loop-and-schedule.md docs/guide/subagents.md docs/guide/using-spider.md docs/architecture/README.md packages/host/README.md
git commit -m "feat: expose wall-clock triggers and document their lifetime"
```

## Existing-test migration contract

This is the complete expected migration list. Keep every assertion that does not encode a replaced behavior exactly as it is. Adding fixture methods, injecting math, faking `Date` with timers, emitting a completed delivery's start and settled lifecycle, or adding the explicit re-arm `name:"loop"` is a setup change, not permission to weaken security or delivery assertions. New coverage belongs in new tests. If another old assertion needs a semantic change, identify the old and new behavior before changing it.

### `packages/host/src/loop/__tests__/loop.test.ts`

| Existing test name | Today | Approved replacement and assertion change |
| --- | --- | --- |
| `drops ticks while busy rather than queueing a backlog` | Busy ticks disappear and delivery waits a whole later period. | Deliver once immediately after settled reconciliation. Replace the post-settlement no-delivery assertions with `expect(h.prompts()).toEqual(["tick", expect.stringContaining("tick\n")])`, pin the late note to the original 12:01 due time, then assert the timely 12:11 anchored tick. Keep the pre-settlement assertion. |
| `a self-paced loop can re-arm and a replacement cancels the old wakeup` | Re-arm borrows the unnamed wakeup. | Add `name:"loop"` to both re-arms. The same prompt-count and delivery assertions stay unchanged. |
| `stop during a run refuses every re-arm including %s` | The global seal rejects all schedule calls. | Give these attempted writes `name:"loop"`; they still reject. Add a separate other-name success test. Keep warning and no-delivery assertions for the sealed attempts. |
| `stop seals even with no live loop, until agent_settled (not agent_end)` | Even unnamed `wakeup` writes are sealed. | Target `name:"loop"` for the rejected and later permitted writes. Keep the agent-end rejection, settled success, and message assertions. |
| `replacement during a run protects its first prompt from the old run's re-arm and cancel` | The shared wakeup is sealed against any schedule or cancel. | Target the old write and the re-arm at `name:"loop"`; target the cancellation at that name too. It returns `cancelled:false` because a loop is not a one-shot. Keep both replacement delivery assertions and the later re-arm delivery assertion. |
| `manual compaction does not seal a self-paced start or a stop against the next run` | Re-arm matches prompt only. | Add `name:"loop"` to the re-arm. Keep all assertions unchanged. |
| `replacing fixed with dynamic and dynamic with fixed removes the old timers` | Dynamic re-arm occupies wakeup. | Add `name:"loop"` to the re-arm. After each of the three slash creations, emit `agent_start` then `agent_settled` and flush the requested check, which is an allowed lifecycle setup change. Keep the exact final prompt array. |
| `loop stop cancels a pending wakeup even without an active loop` | Tool loop stop cancels the shared wakeup. | Rename to `tool loop stop leaves an independent wakeup intact`. Change the final prompt array from `[]` to `["cancel me"]`. Add separate slash-default-stop coverage. |
| `shutdown reason %s ends both timers` | Shutdown clears memory and all state is reported through two slots. | Shutdown still clears timers and activation state. Change only the empty listing assertion to `{triggers:[]}`. New restore tests prove durability in a fresh activation. |
| `shutdown clears a self-paced iteration and its seal` | Shutdown clears local state, seals, and the two-slot listing. | Keep clear-state and refusal assertions. Change only the empty details to `{triggers:[]}`. |
| `reports loop interval, next cadence time, prompt and a separate pending wakeup` | Status has `loop` and `wakeup`; interval advances its next tick while busy. | Assert two trigger rows, names `loop` and `wakeup`, `nextAt` numeric plus ISO renderings, captured zones and origins. While busy, interval stays due at 12:05, not 12:10. The once trigger disappears after idle delivery. |
| `reports a self-paced loop even while it has no re-arm timer` | Status has a self-paced slot and null wakeup. | Change details to one self-paced row with name `loop`, `nextAt:null`, and `state:"waiting-for-rearm"`. Keep the text assertions for self-paced and prompt. |
| `slash grammar shares scheduler state and stop with tool actions` | The tool listing uses two slots. | Change only details assertions to the interval trigger row and `{triggers:[]}`. Keep the prompt array. |
| `usage and invalid slash intervals leave the current loop unchanged` | Empty slash input displays only usage. | Keep all existing assertions, including `Usage` and exact deliveries. Add an assertion that the empty-input notification lists `current` before usage. Invalid-interval behavior remains unchanged. |

### `packages/host/src/loop/__tests__/schedule.test.ts`

| Existing test name | Today | Approved replacement and assertion change |
| --- | --- | --- |
| `reports an internal re-arm rejection through the UI instead of leaving it unhandled` | Re-arm borrows wakeup and re-enters `command`. | Add `name:"loop"`. Reconciliation still checks the persistent-session guard before delivery, consumes the rejected occurrence to `nextAt:null`, writes its snapshot, and reports the rejection through the UI once. Keep the exact notification and prompt-count assertions. A new test advances ten more seconds to exclude repeated notifications. Do not require re-entry through the slash parser. |
| `explains that a sealed replacement wakeup was not cancelled and still delivers it` | A default schedule cancellation sees the replacement in the shared slot. | Target `name:"loop"`; it is not a one-shot. Keep `cancelled:false` and final replacement delivery. Change the explanation to say no named one-shot was pending, and change `details.wakeup` to the loop trigger row with a due first prompt. |

All other schedule assertions, including rounding, noop delivery, manual-compaction waiting, cancellation, invalid input, child guards, and persistent RPC, stay unchanged.

### `packages/host/src/loop/__tests__/security-sdk.test.ts`

| Existing test name | Today | Approved replacement and assertion change |
| --- | --- | --- |
| `re-arms a %s self-paced loop internally and preserves its origin` | Matching prompt alone recognizes a re-arm. | Add `name:"loop"` to the schedule call. Keep the exact user messages, dispatch list, and origin assertions. |
| `keeps the model prompt %j self-paced across re-arms` | Re-arm uses the shared slot; status has two slots. | Add the name to the shared re-arm arguments. Replace only the status details assertion with one self-paced trigger row. Keep three iterations, exact prefix, embedded re-arm prompt, no user-only dispatch, and no slash-parser dispatch. |
| `resets a user loop's origin when a model replaces it with the same prompt` | Re-arm uses the unnamed slot. | Add `name:"loop"` to every schedule re-arm. Keep the exact expanded and unexpanded user-message sequence. |
| `returns a native tool error when a loop ended during the same run` | Stopping loop globally blocks an unnamed schedule. | Target the subsequent schedule at `name:"loop"`. Keep the native error, diagnostic, and no-message assertions. |

The SDK fixture adds `name`, `at`, `cron`, and `tz` to its scheduler tool schema and injects math. Add `"Date"` to `toFake` and call `vi.setSystemTime(new Date("2026-10-20T12:00:00Z"))` after `bindExtensions`. No existing test body changes are needed for that clock correction. Verify the faux provider still settles with faked `Date` in B1c step 4.

Keep the existing bodies and assertions of `refuses model-supplied /user-only through spider %s without dispatch` and `disables template expansion on every model-originated spider %s firing`. They intentionally pass both `interval` and `delaySeconds`. Keep `refuses leading whitespace before a model slash prompt through spider %s` unchanged as well. Its loop case passes `delaySeconds` without an interval, which remains an ignored field rather than a new validation error. The ignored legacy fields preserve those tests. Keep host tests `refuses %s in children before any project DB work` and `refuses both actions in %s runs` unchanged too. Their persistent-session guard runs before field validation. Do not change other security assertions, especially interval-field slash smuggling, leading whitespace, template expansion, and trust borrowing.

### Parser and host-wiring tests

| File and existing test name | Today | Approved replacement and assertion change |
| --- | --- | --- |
| `parser.test.ts`: `parses %j`, rows for empty, whitespace, stop, and `stop now` | Empty means usage, bare stop is unqualified, `stop now` is dynamic text. | Empty rows become `{kind:"list"}`; bare-stop rows become `{kind:"stop",target:"defaults"}`; `stop now` becomes `{kind:"stop",target:"name",name:"now"}`. All other existing table rows and unsafe-interval assertions stay unchanged. |
| `loop-schedule-wiring.test.ts`: `exposes both actions and their optional parameters on the single spider tool` | Schema exposes relative and interval options only. | Add the three string-field assertions and naming/lifetime descriptions. Keep action, parameter identity, and external-work assertions. |
| Same file: `shares one scheduler between tool actions and /loop` | Details use two slots. | Replace only the listing shapes with trigger rows and an empty array. Keep prompt deliveries and command/tool sharing assertions. |
| Same file: `threads agent events to sealing for tool-started loops` | The global seal rejects an unnamed schedule. | Target the rejected write at `name:"loop"`; keep the post-settled unnamed new timer and its success assertion. |
| Same file: `separate host activations never borrow each other's scheduler` | Tool loop stop cancels activation A's wakeup. | Use `action:"schedule",stop:true` to cancel A's one-shot. Keep the exact A-empty and B-delivered assertions. Isolation, not loop-stop scope, is the test's claim. |

## Integration after both parts

### Task I1: Verify real wiring and daily wall-clock behavior

**Files:** Create `packages/host/src/loop/__tests__/wallclock.integration.test.ts`. Modify only part B's adapter, host wiring, or tests if the combined interfaces reveal a mismatch. A's writer fixes any time-module defect in A-owned files.

**Interfaces:** Import real `createTimeMath` and `registerLoopSchedule`; also drive the actual registered host tool in an unmocked integration fixture. No fake cron or zone calculation is allowed in this file.

- [ ] **Step 1: Combine both parts and write failing acceptance tests.** Freeze the interface definitions above. Verify the adapter satisfies `SchedulerTimeMath` without casts. In the daily acceptance test, set time to `2026-10-26T02:29:00Z`, create `morning` with `0 8 * * *` and `Asia/Kolkata`, and assert no immediate prompt. Advance one minute and assert one prompt plus next time `2026-10-27T02:30:00.000Z`. Repeat over two more days with long idle periods. Check each observed delivery satisfies `0 <= deliveredAt - scheduledAt && deliveredAt - scheduledAt < 60_000` and that the next local display is 08:00 every day.

Add `detects sleep through wall-clock changes rather than timer advancement`: after arming, call `vi.setSystemTime` to jump to the next day's 02:35 UTC without any callback in between, then run only the next ticker callback. Assert one late prompt, the original scheduled time, and next day 02:30 UTC. Assert it does not wait for the old long delay.

Add `waits when busy at the Kolkata due time`: hold both the run flag and idle flag busy across 08:00, assert the listing says due, then settle and flush the immediate check. Assert one firing and the next correct day. Repeat manual compaction without a run event to prove the one-second retry works.

Add `delivers the final valid cron occurrence when the next five-year search throws`. Create `0 0 29 2 *` before its 2096 occurrence, fire it after a clock jump to `2096-03-01T00:00:00Z`, and assert exactly one delivery, removal, one notification, and a snapshot with no such cron saved before the send. Its next leap day is in 2104, outside the five-year bound. Advance ten seconds and assert no repeated error or delivery. Repeat through restore with another valid trigger in the snapshot. Assert syntax-only validation retains both triggers, the cron's final occurrence delivers once, and the other trigger is not discarded.

Add real-math New York gap and overlap and Lord Howe gap and overlap cases using A2's independent UTC expectations. Repeat `nextCronAt` after the first overlap fire and prove no second copy fires. Add a default-zone-change case with a stored explicit zone. Drive named once triggers, per-name seals, stop forms, listing, reload and resume, new and fork, and consumed-self-paced restoration through the real adapter, not just fake calculations.

- [ ] **Step 2: Run `npm test -- packages/host/src/loop/__tests__/wallclock.integration.test.ts packages/host/src/__tests__/loop-schedule-wiring.test.ts`.** Missing or wrong real wiring must fail. Existing fake-math unit tests passing is not evidence for this task.
- [ ] **Step 3: Complete and verify production wiring.** Ensure `extension.ts` imports `createTimeMath`, which imports A's real functions, while `index.ts` stays dependency-injected. Check schema argument forwarding for `name`, `at`, `cron`, and `tz` on the registered tool. Correct integration defects within ownership boundaries. Do not relax an independent expected instant to match the implementation.
- [ ] **Step 4: Run the combined gate.** Run `npm test -- packages/host/src/loop packages/host/src/__tests__/loop-schedule-wiring.test.ts`, `npm run typecheck`, `npm test`, and `npm run build`. Expected: every command exits zero. Inspect the final diff against the test migration contract and verify unrelated assertions did not change. Confirm no lockfile or dependency change.
- [ ] **Step 5: Commit only integration changes.** At minimum run `git add packages/host/src/loop/__tests__/wallclock.integration.test.ts`. Explicitly add any corrected owned files, then run `git commit -m "test: verify wall-clock triggers with real time calculations"`.

### Task I2: Check a real persistent pi process

**Files:** Create an uncommitted `${CHECK_DIR}/live-wallclock.mjs` and retain its logs under the same git-ignored check directory. No live-check script, session file, credential, or log is committed. Use an absolute `CHECK_DIR` supplied by the operator. Keep the real home directory and use an isolated project directory and `SPIDER_GLOBAL_ROOT` inside `CHECK_DIR`.

**Interfaces:** Use installed pi 1.2 RPC, not an invented execute-tool command. Read `docs/rpc.md`, `docs/rpc-commands.md`, `docs/json.md`, and `docs/cli.md` from the installed pi package. Recheck `pi --help` before spawning. RPC supports `prompt`, `get_state`, `get_entries`, and `switch_session`; it has no built-in reload command. This check uses orderly restart and `--session <saved-file>`. Reload itself is already covered by B2 and I1.

- [ ] **Step 1: Write a fail-closed JSONL observer.** The script launches the built extension in a real RPC process with only the spider tool, no discovered extensions or context files, and a low-cost configured model. Select provider and model through `CHECK_PROVIDER` and `CHECK_MODEL`, with low thinking. Set `PI_SUBAGENT_CHILD=0` only for this test-owned persistent process. Set `TZ=America/New_York` for both initial and resumed processes, so the default zone differs from the trigger's zone. Isolate spider state through `SPIDER_GLOBAL_ROOT`.

Before either launch, write and read back `${SPIDER_GLOBAL_ROOT}/config.json` with `"organism.enabled":false` and `"organism.passes.learning":false`. Check those keys against `packages/organism/src/config.ts` and the worker's enabled gate. This disables organism and learner model calls and background writes. Do not alter the user's configuration. Use existing authenticated pi credentials without logging secrets. Fail on an unexpected background model call. Do not substitute a fake provider or invoke scheduler methods directly.

Spawn arguments include `--mode rpc --no-extensions --extension <absolute-built-extension> --no-skills --no-prompt-templates --no-context-files --no-themes --no-mcp --tools spider --provider <provider> --model <model> --thinking low --session-dir <test-session-directory>`. Do not pass `--no-session` or `--print`.

Read stdout continuously and split only on LF. Correlate command responses by IDs and observe `tool_execution_start`, `tool_execution_end`, `message_start`, `message_end`, `entry_appended`, and `agent_settled`. Write protocol data and stderr to separate logs. Install listeners before sending prompts. A successful `prompt` response means acceptance, not model completion. Fail on extension errors, tool errors, absent tool calls, unexpected process exit, or a deadline.

- [ ] **Step 2: Ask the model to create the real trigger.** After startup, compute the Kolkata local minute about two minutes ahead using an independent `Intl` formatter in the observer. Choose hour `H` and minute `M` so `M`, `M+1`, and `M+2` are in that same hour. If the candidate minute exceeds 57, use minute 00 of the next Kolkata hour. Record the three exact local dates and UTC instants before creation, including any date rollover. Do not use the production adapter for these expectations.

Ask the model through RPC `prompt` to call spider exactly once with `{action:"loop",name:"minute-check",cron:"M,M+1,M+2 H * * *",tz:"Asia/Kolkata",prompt:"WALLCLOCK_CHECK: reply OK without tools and do not change triggers"}`, substituting the actual numeric minutes and hour, then stop. Verify the actual tool arguments and successful result. The snapshot's first next time must equal the first selected Kolkata minute, not the corresponding New York wall time. Obtain `sessionFile` and `sessionId` with `get_state`. Reject a run whose creation misses the first selected minute.
- [ ] **Step 3: Observe two timer-generated user messages before restart.** Do not send prompts to cause the firings. For each user message whose full text equals the stored `WALLCLOCK_CHECK` prompt, compare both its persisted timestamp and observer receipt time with its precomputed scheduled instant. Count each `message_end` user event once, not both start and end events. Correlate it with its persisted entry ID through `get_entries` for the saved-session evidence. Do not count the creation request, tool results, or assistant replies. Each delivery must be no earlier than its selected minute and less than 60 seconds late. Assert the first two selected minutes, no duplicates, and snapshots advancing to the second and third selected instants. Assistant completion time is not the firing metric. Missing credentials or provider failure makes the check inconclusive, not passing.
- [ ] **Step 4: Restart, observe the third firing, and inspect tomorrow's listing.** After the second firing settles, close stdin and wait for exit. Restart before the third selected minute, with `TZ=America/New_York`, the same arguments and configuration, and `--session <sessionFile>`. Send no create prompt. Assert `get_state` has the same session ID. The third automatic firing must match the third precomputed instant and satisfy the same less-than-60-second delivery bound. If restart misses that bound, the check does not pass.

After the third run settles, ask the model to call `spider loop` with no definition fields and stop. Verify the actual successful tool result lists `minute-check`, preserves `Asia/Kolkata` rather than `Asia/Calcutta`, and shows the next fire at tomorrow's `H:M` in Kolkata. Check its exact UTC instant and local text against an independent observer calculation. For example, an 08:00 Kolkata first selected minute means next-day 02:30 UTC. This proves the zone was honored and advancement did not become an every-minute schedule.
- [ ] **Step 5: Stop and report.** Ask the model to call loop stop for `minute-check`, verify the real tool result, close stdin, and wait for disposal. On timeout, terminate only the test-owned process. Report scheduled UTC, local scheduled time, observed delivery time, next listed time, and same-session restoration for each observation. The total check deadline is eight minutes.

Run the script after it exists:

```sh
: "${CHECK_DIR:?Set an absolute git-ignored check directory}"
: "${CHECK_PROVIDER:?Select a configured low-cost provider}"
: "${CHECK_MODEL:?Select its model}"
git check-ignore "$CHECK_DIR/live-wallclock.mjs"
node "$CHECK_DIR/live-wallclock.mjs"
git status --short
```

Expected: script exits zero only after two timely cron fires before restart, the third timely fire after same-session restart, and the correct listing for tomorrow's first selected Kolkata minute. The source tree has no live-check artifacts. Keep a concise result with evidence locations outside committed documentation. Do not call a simulated timer test a live check.

## Final review and completion

- [ ] Re-read every spec section and map it to A1, A2, B1a, B1b, B1c, B2, B3, I1, or I2. Resolve any uncovered behavior before completion.
- [ ] Check exact signatures, numeric units, `nextAt` nullability, zone strings, and trigger field names across modules and tests.
- [ ] Compare changed existing assertions against the migration contract. Restore every unrelated assertion exactly.
- [ ] Run one review of the complete combined change alongside the final gate. Fix findings together. Do not add per-task review steps.
- [ ] Confirm the gate and real-process check results. Report an unavailable live environment as an explicit limitation, not a successful acceptance check.
- [ ] Confirm only intended source, test, instruction, and documentation paths are staged. Do not commit machine-local state or check artifacts.

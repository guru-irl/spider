# Roaming Session Stop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans
> to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for
> tracking.

**Goal:** Stop a managed session on its current machine, confirm that it stays
stopped, and restart the same session only on explicit request.

**Architecture:** The Mac hub saves the home and its request record together.
The home machine enforces the replicated row and reports exit separately from
publication. The CLI and pane service use the same cached status and submit
mutations to the same hub socket.

**Tech Stack:** TypeScript, Node.js, SQLite, v0 roaming sync and control, Unix
sockets, Vitest, and packaged Linux Herdr stories.

**Spec:** [Stop and start roaming sessions](../specs/2026-11-28-roam-session-stop-design.md).
Read it with this plan. File references use `606073e4f`.

## Global Constraints

- The Mac is the only writer of `session_homes`. Use the existing `running`,
  `moving`, and `stopped` states and the existing compare-and-swap that advances
  one epoch. Only an exact `running` home on the named machine permits pi to run.
- Home replication does not change. No replicated mode, start note, new run
  lease, offline home writer, or launch-attempt record for Stop.
- Use the ID-lock identity throughout Stop: PID, process birth identity, and
  boot ID. Do not use the Herdr feed generation for Stop fencing.
- Stop keeps the session ID, transcript, and checkout. It does not move files
  or promise to copy the final transcript to the Mac. Hide, Send back, and
  `/quit` do not save Stop. Keep ordinary local Kill unchanged.
- Graceful Stop asks pi first for up to 5 seconds and then waits 5 seconds
  after `SIGTERM`. Kill now skips both waits. Bound an attempt and the caller
  wait by `readyMs` (60 seconds by default). Keep `controlMs` at its existing
  default of 60 seconds. Never signal an unchecked PID or a process group.
- Do not signal detached jobs in Core. A missing terminal, a signal reply, a
  cancelled run row, and a sync receipt never prove exit.
- Use the 10-second supervisor cadence and **Stopping** window, the 10-second
  pending observation poll, and the 30, 60, and 120-second peer retry schedule.
  Healthy sync defaults to 120 seconds. These are not outage bounds.
- Keep existing socket ownership and size checks, v0 request version `1`, and
  `sessionStopVersion: 1`. Never contact revoked peers or fall back to a legacy
  agent. Boxes have no outbound roaming peers. No Herdr-to-roam dependency.
- Keep the Node `>=22.19.0` floor, CI's Node `26.x`, and the headless core pin
  `0.1.16`. Keep `packages/roam/src/relocate/types.ts` unchanged. Use synthetic
  machines in tests. No test may start an installed service.
- Read `ctl-run.sh` before using it. Set `CTL_RUN` to the supplied runner and
  confirm that it selects this checkout and one worker. Run one file at a time.
  Do not run `packages/roam/src/__tests__/move.test.ts`, stories, the native app,
  or mounted fixtures locally. Give socket fixtures an explicit owned
  `HC_SOCKET` and non-default `HC_SESSION`. Do not add retries or extend timeouts.
- At each task, record the named red assertion and the green file run. Use the
  source importer sweep and the supplied repo guard suite for file inventory
  changes. Kill the three named mutants in an independent short-root copy,
  never in an active checkout. Run one typecheck and one build at handoff,
  without overlapping them with tests. Use `npm run typecheck:herdr:e2e` for a
  story-only task. Stage only owned paths; commit with `git commit -F`.

## Checkpoint focus

1. A force already queued ahead of Stop replaces the move result. Do not follow
   that unrelated row. Task 2: `does not follow a force after the pinned move`.
2. A pi socket accepts a connection but never replies. Do not give the socket
   the whole attempt budget. Task 5: `a wedged shutdown socket costs at most five seconds`.
3. A detached job's terminal is gone and its receipt belongs to a different
   nonce. Keep the job pending. Task 4: `a foreign receipt does not clear an owned job`.
4. A late observation predates newer negative evidence for the same home.
   Do not restore **Stopped**. Task 7: `older proof cannot erase a blocker`.
5. A pane request provides a presentation ID without a revision. Do not treat
   it as a row action. Task 15: `rejects half of a presentation binding`.

---

## File structure

| Responsibility | Files |
| --- | --- |
| Hub request record and cached projection | `packages/roam/src/relocate/session-stop-types.ts`, `session-stop-store.ts`, and `home.ts`. The record lives in unreplicated local state in the same DB as the CAS. |
| Operation order and reconciliation | `packages/roam/src/relocate/session-operations.ts`, `session-stop.ts`, `session-reconcile.ts`, `session-start.ts`, and `runtime.ts`. The hub queue owns mutation order. The reconciler does not own homes. |
| Local exit evidence | `packages/roam/src/relocate/local-stop.ts`, `local-stop-work.ts`, `local.ts`, `supervisor.ts`, and `packages/subagents/src/reaper.ts`. Pi receives the exact epoch and owner on its private socket. |
| Machine boundaries | `packages/roam/src/relocate/adapters.ts`, `remote.ts`, and `service.ts`. Reuse the v0 peer transport and `roam/relocate.sock`. Keep legacy control isolated. |
| Placement and CLI | `packages/roam/src/relocate/relocate.ts`, `transfer.ts`, `set-home.ts`, `cli.ts`, and `packages/roam/src/cli.ts`. Stopped placements have no terminal result. |
| Pane seam | `packages/herdr/src/panes/{types,codec,service,snapshot}.ts` own the request protocol and presentation binding. `packages/host/src/herdr/pane-runtime.ts` implements the two ports and host code guards the old endpoint. No menu or status visuals here. |
| Packaged proof | `packages/herdr/e2e/fixtures/roam-session-stop.ts` owns the fixture. The `roam-session-stop` and `roam-pane-stop` scenarios exercise Core and the pane seam separately. |

## Phases and delivery

Work in dependency order. Use one worker session per task, with one commit per
verified task. At each checkpoint inspect the frozen phase head once in
parallel with its checks. Apply one fix round. Repeat the inspection only for
critical findings. No intermediate phase enables an incomplete public command.

| Increment and phase | Tasks | Checkpoint |
| --- | --- | --- |
| 1A. Authority | 1-2 | CAS and record roll back together. The FIFO pins a Stop to its original home or one active move. |
| 1B. Exit evidence | 3-6 | A durable stopped replica alone stops the owner. Job, launch, boot, and identity fixtures prove what can confirm exit. |
| 1C. Reconnect and placement | 7-10 | Reconnect completes saved Stop. Start, relocate, undo, rollback, and force preserve the exact home rules. |
| 1D. Public Core | 11-13 | The public cut and the packed CLI story R20 pass. No legacy fallback. |
| 2A. Pane contract | 14-16 | Bounded cached list, wire shape, presentation checks, and host socket mapping pass without a box feed. |
| 2B. Managed Close | 17-18 | Old Close records cannot mutate a home. Packed pane story R21 proves the same result as CLI. |

Ship one PR for Core. Stack one PR for the Herdr seam on Core or open it after
Core lands. Do not merge the seam first. The UI owner can build against the
contract below before the seam lands. Run the separate live check after Core
merges and before rollout to other sessions.

On each integrated candidate's exact head, dispatch the full CI workflow.
The normal PR check alone does not run the full suite. Require the aggregate
`typecheck · test · build`, Herdr utility and package checks, and the explicit
Linux headless stories below. The new stories are opt-in and required for these
PRs, like R19. Leave the default matrix (`R18`, `R10`, `R11`) unchanged.

```sh
gh workflow run ci.yml --ref <branch> -f force_full=true
# Core:
gh workflow run herdr-stories.yml --ref <branch> -f stories=R04,R10,R11,R12,R18,R19,R20
# Herdr seam:
gh workflow run herdr-stories.yml --ref <branch> -f stories=R04,R10,R11,R12,R18,R19,R20,R21
```

Keep R04 hosting recovery, R10 admission, R18 round-trip relocation, and the
retained runnable roam set green. Keep R12 opt-in and use exact-base evidence
for any known pre-existing failure. R13 and R14 are already disabled in
`packages/herdr/e2e/scenarios/runner-stories.test.ts`; leave them disabled.
Leave R14local to its separate fixture run. Do not revive retired stories or
count a skipped story as proof. Check each selected ID's result and cleanup.

### Coordinate shared files before editing

- Old-path 3A owns R02 retirement and its runner files. It waits on its own
  prerequisites; do not move that work here or edit the old `move.test.ts`.
  Use new story and selector test files. Apply the runner and e2e README edits
  in Tasks 13 and 18 after 3A, or serialize those edits with 3A.
  Keep R06-R08 retirement out of this plan too.
- Integrate the public command cut after 3D's parser, CLI, and repair edits, or
  serialize Task 12 with 3D. Do not restore `recover`, `cancel`, or `claim`.
  Steps 3D and 3E retain public `stop` and `resume` until this cut. Preserve
  private legacy controls until 4C removes their last callers.
- Prefer new files for pane tests. Reserve the existing test edits named in
  Task 12 with the Herdr test owner before editing. Leave other Herdr and host
  Herdr tests to that owner; run them as regressions. Keep v0 `session-shutdown`
  through 4A. Land Core and managed Close before 4B. Keep early admission, the
  ID lock, file lease, and refusal for missing, cloned, foreign, or frozen stores.

## Increment 1. Core

### Phase 1A. Record authority and order

#### Task 1: Commit the home and request together

**Depends on:** The pinned spec. A stop record never exists on a box replica.

**Files:** Create `packages/roam/src/relocate/session-stop-types.ts` and
`packages/roam/src/relocate/session-stop-store.ts`. Modify
`packages/roam/src/relocate/home.ts:11-13,40-53,83-162`. Test
`packages/roam/src/__tests__/session-stop-store.test.ts` (new).

**Interfaces:** Consume `RelocateHome`, `StoppedHome`, `RunningHome`, and
`SessionId` from `relocate/types.ts`, and `MachineId` and `Db` from db-core.
Define the shared Core types in `session-stop-types.ts`:

```ts
type StopMode = "graceful" | "hard";
type OwnerGeneration = { pid: number; startIdentity: string; bootId: string };
type StartRequest = { operationId: string; sessionId: SessionId; machineId: MachineId; homeEpoch: number };
type StopRequest = StartRequest & { mode: StopMode };
type StopBlocker = { kind: "job"; id: string; cancelFromOwner: boolean } | { kind: "check"; reason: string };
type StopObservation = { sessionId: SessionId; machineId: MachineId; home: RelocateHome | null;
	bootId: string | null; observedAt: number | null; evidence:
		| { kind: "checking" }
		| { kind: "pending"; reason: string; blockers: readonly StopBlocker[] }
		| { kind: "confirmed"; owner: OwnerGeneration | null } };
type CoreStatus = "running" | "stopping" | "stopped" | "stop-pending" | "starting" | "moving";
type SessionStatus = { sessionId: SessionId; machineId: MachineId | null; homeEpoch: number | null;
	homeState: RelocateHome["state"] | null; status: CoreStatus | null; reason: string | null; observedAt: number | null };
type SessionOutcome = SessionStatus & { operationId: string; outcome: "complete" | "pending" | "refused" };
```

Produce `createSessionStopStore(db: Db): SessionStopStore` with synchronous
`current(id: SessionId): SessionTransition | null`, `list(): readonly SessionTransition[]`,
`operation(id: string): OperationBinding | null`, and
`write(record: SessionTransition, binding?: OperationBinding): undefined`.
A transition has `operationId`, `expected: RelocateHome`, and `committed`.
For `action: "stop" | "relocate" | "force"`, `committed` is `StoppedHome`; store
`mode`, `displaced: readonly MachineId[]`, `observations: readonly StopObservation[]`,
and `contactReason: string | null`. Keep displaced observer IDs for this epoch
and derive which remain unverified from matching per-observer proof. For
`action: "start"`, `committed` is
`RunningHome`; store `observedAt: number | null` and nullable `contactReason`.
The projections treat a nullable Start timestamp as pending. `OperationBinding`
contains the original action and request and its committed home. Placement
records do not create external bindings. Export the now-synchronous
`projectSessionStatus(home: RelocateHome | null, record: SessionTransition | null, id: SessionId, now: number): SessionStatus`.
Expose `readManagedHome(db: Db, id: SessionId): RelocateHome | null` in
`home.ts`, using the same decoded row as CAS. Distinguish an absent or legacy
row from invalid data, and support a pre-v0 schema without a managed column.

- [ ] **Write the failing tests.** Use two connections to one fixture global
  store with valid hub identity. In `writes the request only with the home CAS`,
  fail the hook after inserting its record. Reopen the DB. In a separate case
  race a stale CAS, then compare the conflict with an accepted CAS. In
  `uses the check time instead of the read time`, record checking at `1_000`,
  confirm at `11_000`, then query twice without a new observation.

```ts
expect(reopenedHome).toMatchObject({ state: "running", epoch: 7 });
expect(reopenedRecord).toBeNull();
expect(conflict).toMatchObject({ kind: "conflict" });
expect(bindingAfterConflict).toBeNull();
expect(appliedHome).toMatchObject({ state: "stopped", epoch: 8, moveId });
expect(appliedRecord?.committed).toEqual(appliedHome);
expect(at10_999).toMatchObject({ status: "stopping", observedAt: 1_000 });
expect(at11_000).toMatchObject({ status: "stop-pending", observedAt: 1_000 });
expect(confirmedAt200_000).toMatchObject({ status: "stopped", observedAt: 11_000 });
expect(blockedInsideWindow.status).toBe("stop-pending");
expect(unobservedRunning.status).toBeNull();
```

- [ ] **See red.** Run `bash "$CTL_RUN" packages/roam/src/__tests__/session-stop-store.test.ts`.
  Expect a missing store export first, then the named rollback and age
  assertions until the behavior exists.
- [ ] **Implement the CAS and record.** Export `HubHomeStore` and extend
  `compareAndSwap(expected, next, checkMacSource?, onApplied?: (home: RelocateHome) => undefined)`.
  Invoke the synchronous hook only after an update inside the immediate global
  DB transaction. Not on conflict or `already-applied`. Preserve the existing
  running fence and Mac source check. Use db-core `readLocal` and `writeLocal`
  with private namespaces `session-transition` (session key) and
  `session-transition-operation` (operation ID key). Validate records on read.
  Keep admitted IDs bound in Core even after their session advances. Later
  compaction must keep the original binding. For changes without a CAS, write
  both records in one immediate transaction under the session operation lock.
- [ ] **Implement the cached projection.** Reuse the home decoder; add no
  schema or second authority. A home with no matching record
  cannot be confirmed. Moving wins on a `moving` row. For `stopped`, blockers
  win over checking; checking is **Stopping** for ages `[0, 10_000)` only.
  Include each known job ID and only its eligible owning-session cancel hint.
  Use stable reasons for check failures instead of raw peer or process errors.
  Matching confirmation with no unverified displacement stays valid without
  a new read. No matching observation after a stopped CAS means **Stop pending**.
  A pending Start is **Starting**, a verified Start is **Running**, and a
  bare running home has `status: null`. Use the observation's own timestamp,
  never the contact time. No cached process or path evidence in the projection.
- [ ] **See green.** Run the same command. Expect all assertions to pass on
  reopened state. Mutants: invoke the hook post-commit, invoke it on conflict,
  and set `observedAt` to `now`. The two named tests must reject all three.
- [ ] **Commit** the listed files as `feat(roam): store session transitions with home changes`.

#### Task 2: Accept Stop in order and bind it to one home

**Depends on:** Task 1. The public socket is not exposed yet.

**Files:** Create `packages/roam/src/relocate/session-operations.ts` and
`packages/roam/src/relocate/session-stop.ts`. Modify
`packages/roam/src/relocate/runtime.ts:83-99,128-169`. Test
`packages/roam/src/__tests__/session-stop-order.test.ts` (new).

**Interfaces:** Produce `createSessionOperations(): SessionOperations` with
`enqueue<T>(id: SessionId, run: () => Promise<T>): Promise<T>`,
`relocate<T>(id: SessionId, run: (mark: (home: RelocateHome) => void) => Promise<T>, read: () => Promise<RelocateHome | null>): Promise<T>`,
and `activeMove(id: SessionId): MoveTurn | null`. A `MoveTurn` exposes
`source: RelocateHome | null`, `moving: MovingHome | null`, and
`result: Promise<RelocateHome | null>`. Resolve `result` with the exact row
left by the move before the queue advances, including an unsettled row. Produce `createStopCommand(ports: StopCommandPorts): (request: StopRequest) => Promise<SessionOutcome>`.
`StopCommandPorts` supplies `operations`, `store`, `homes: HubHomeStore`,
`withSession<T>(id: SessionId, run: () => Promise<T>): Promise<T>`, `clock`,
`readyMs`, and `reconcile(home: StoppedHome): Promise<void>` (Task 7).

- [ ] **Write the failing tests.** Hold a relocation after its first CAS.
  Submit Stop against the source in one case and the `moving` row in another.
  Test commit to the destination and undo to the source. In `does not follow a
  force after the pinned move`, enqueue force before Stop while that move is
  active. In `replays the original stop without rewriting the epoch`, lose
  replies before commit and after commit, restart from the committed DB, and
  replay the original ID. Try the same ID with different inputs, then a later
  graceful request on the current stopped epoch after hard mode was saved.
  Repeat Kill now after exit proof and check that it sends no new request.

```ts
expect(waiting).toMatchObject({ outcome: "pending", reason: "waiting-for-move" });
expect(homeWhileWaiting.state).toBe("moving");
expect(afterMoveStop).toMatchObject({ machineId: movedTo, state: "stopped", epoch: 10, moveId });
expect(afterUndoStop).toMatchObject({ machineId: source, state: "stopped", epoch: 10, moveId });
expect(behindForce).toMatchObject({ outcome: "refused", reason: "home-changed" });
expect(afterForce).toEqual(forcedHome);
expect(unsettled.reason).toBe("Finish or undo the move with `spider roam relocate`, then stop.");
expect(afterUnsettled).toEqual(movingHome);
expect(upgrade).toMatchObject({ mode: "hard", committed: { epoch: 8 } });
expect(modeAfterGracefulRetry).toBe("hard");
expect(confirmedKillNowEffects).toEqual([]);
expect(reused.reason).toBe("operation-reused");
expect(afterHistoricReplay).toEqual(laterRunningHome);
expect(unrelatedEffects).toEqual([]);
```

- [ ] **See red.** Run `bash "$CTL_RUN" packages/roam/src/__tests__/session-stop-order.test.ts`.
  Expect no accepted move-bound Stop or replay at baseline.
- [ ] **Implement admission and order.** Take FIFO position synchronously at
  hub entry, before an asynchronous lookup. Wrap the existing relocate and
  force calls at that entry, not by reacquiring their process lock. Preserve
  `withSession` in all mutation bodies. Record the source read and successful
  moving CAS of only the active relocation through its home-store port. A
  waiter pins that move at admission. Under lock, it may follow the move only
  if the original expectation names its source or moving row and the current
  row is exactly that move's result. Otherwise apply the normal exact machine
  and epoch check. No exception for a move that was merely queued on arrival.
- [ ] **Implement Stop and replay.** While queued behind a move, return
  `waiting-for-move` without claiming it is saved. An accepted operation
  continues after disconnect or reply deadline. Reserve the operation ID
  across all sessions at intake. An exact duplicate reads the same flight;
  different inputs refuse even before commit. A restart before commit loses
  the wait. Under lock, check the live enabled flag, current row, and durable
  binding before mutating. CAS to the same machine
  and next `stopped` epoch with `moveId` intact. On the exact stopped epoch,
  reuse confirmation or update pending mode to hard and reschedule; do not
  increment. Create a pending record for a stopped epoch without one. Never
  downgrade hard or resend a confirmed Stop solely for Kill now. Persist the
  original input's binding even if it followed a move. A historical replay
  returns its pinned outcome or `home-superseded`; it cannot follow another move.
- [ ] **Separate commit from contact.** Release both locks before invoking
  `reconcile`. Return the last committed status within `readyMs`. Replaying an
  outstanding ID can read or advance reconciliation, not enqueue new home work.
  If the row remains `moving`, return the exact refusal above. Forward Task 1's
  hook through the runtime store wrapper without bypassing revocation.
- [ ] **See green.** Run the same file. Expect exact epoch and no-effects
  assertions to pass, including caller loss and a force ahead of Stop. Mutants:
  follow any later home, increment on hard upgrade, and accept a reused ID
  with different inputs. The named tests must fail.
- [ ] **Commit** as `feat(roam): serialize and bind Stop requests`.

### Phase 1B. Enforce the stopped row

#### Task 3: Bind pi shutdown and launch admission to the epoch

**Depends on:** Task 1.

**Files:** Modify `packages/roam/src/session-socket.ts:14-55`,
`packages/roam/src/relocate/launch-environment.ts`,
`packages/roam/src/relocate/local.ts:185-190`, and
`packages/host/src/roam/{admission,relocate-control}.ts`. Test
`packages/host/src/__tests__/roam-session-stop-admission.test.ts` (new).

**Interfaces:** Export `parseV0OwnerControl(operation: Operation): V0OwnerControl | null`
from `session-socket.ts`. The result is `{ kind: "stopped-shutdown" | "running-inspect";
sessionId: SessionId; machineId: MachineId; homeMachineId: MachineId;
epoch: number; owner: OwnerGeneration }`. The existing operation envelope
supplies target `machineId` and `expectedEpoch`. The shutdown kind is
`session-shutdown` with args `{ v0: true, homeState: "stopped", sessionId,
homeMachineId, owner }`. For Start, `session-inspect` with `homeState: "running"`
is read-only and requires the exact running epoch. Extend `serveRelocateShutdown`
with `admittedOwner?: () => Promise<OwnerGeneration | null>`. Supply it from
`registerAdmission` through `AdmissionPorts.v0Ready`. Read the held ID lock,
file lease, and live gate, not the socket's existence, to build the identity.
Add optional `launch?: ManagedLaunch` to `piLaunchArgv`, where `ManagedLaunch`
is `{ sessionId: SessionId; machineId: MachineId; homeEpoch: number }`. Encode
only this validated tuple as `SPIDER_ROAM_V0_LAUNCH` in argv, and pass the
parsed launch to the initial `AdmissionPorts.expectedEpoch` check.

- [ ] **Write the failing tests.** In `acknowledges shutdown only for the admitted owner and stopped epoch`,
  send actual requests to the fixture socket. Table-test changed birth,
  changed boot ID, changed PID, wrong home machine, wrong epoch, and a
  delayed shutdown after Start. Verify that the current moving request still
  works. Send the read-only request before and after admission. In
  `late managed launches exit before admission`, take the marker from argv.
  Open the same transcript after Stop, then after Start at a newer epoch.
  Include a missing row, malformed marker, and a stopped import while the
  admission socket is opening.

```ts
expect(wrongRequests.map(x => x.code)).toEqual([3, 3, 3, 3, 3, 3]);
expect(shutdownsAfterWrongRequests).toBe(0);
expect(validReply).toMatchObject({ code: 0, epoch: 8 });
expect(shutdownsAfterReplay).toBe(1);
expect(movingReply.code).toBe(0);
expect(beforeAdmission.code).not.toBe(0);
expect(afterAdmission.code).toBe(0);
expect(staleLaunch.admitted).toBe(false);
expect(staleLaunch.shutdowns).toBe(1);
expect(staleLaunch.idLockHeld).toBe(false);
expect(stoppedDuringReady.admitted).toBe(false);
expect(exactLaunch.admitted).toBe(true);
```

- [ ] **See red.** Run `bash "$CTL_RUN" packages/host/src/__tests__/roam-session-stop-admission.test.ts`.
  Expect the valid stopped request to be refused and the later running epoch
  to be accepted without the launch binding.
- [ ] **Implement the two fences.** Parse the exact v0 variants on pi's private
  socket; do not make those variants eligible for legacy control. Match local
  target ID and machine, exact home state, epoch and home machine, then compare
  the requested owner to the current admission and ID lock. The stopped home
  machine may be foreign for a displaced owner. Reread the row and admission
  before calling `context.shutdown()`. Reply on intake and collapse duplicates.
  Answer inspection only for the exact admitted owner with the file lease.
  Preserve the moving request, `moveId` guard, and reply. Consume the marker
  once for the owning launch before spawning children. Bind it even on a
  lookup that says unmanaged. Reread the exact home after socket startup,
  before admitting work. A marked launch with a missing or changed row or a
  bad marker releases partial claims and exits. Unmarked launches are unchanged.
- [ ] **See green.** Run the same file. Expect exact matches and no shutdown or
  admission on mismatches. Mutants: omit boot comparison, accept a running
  row for shutdown, and replace the managed launch epoch with null.
- [ ] **Commit** as `feat(roam): fence managed pi shutdown and launch`.

#### Task 4: Check owned runs and detached jobs

**Depends on:** Task 1. This task reads evidence; Task 5 owns signalling.

**Files:** Create `packages/roam/src/relocate/local-stop-work.ts`. Modify
`packages/subagents/src/reaper.ts:25-66` and
`packages/herdr/src/jobs/handoff.ts:78-95`. Test
`packages/roam/src/__tests__/local-stop-work.test.ts` (new).

**Interfaces:** Export `reapStoppedSessionRuns(deps: { db: Db; globalDb?: Db;
sessionId: string; proveAbsent(row: Readonly<RunRow>): Promise<boolean> }):
Promise<{ reaped: readonly string[]; blockers: readonly string[] }>` from
`reaper.ts`. Export `createStopWork(options: RelocateAdapterOptions): StopWorkPorts`
with `inspect(id: SessionId): Promise<{ blockers: readonly StopBlocker[];
excludedRoots: readonly number[]; complete: boolean }>` and
`settleRuns(id: SessionId, proveAbsent: (row: Readonly<RunRow>) => Promise<boolean>): Promise<readonly StopBlocker[]>`.
A PID in `excludedRoots` can prevent a signal, never authorize one.

- [ ] **Write the failing tests.** In `settles only proven absent local runs of this session`,
  create a real local project store and replica with a same-checkout session,
  a foreign-origin row, and an owned run whose `host_pid` was recycled.
  Give one live child no birth evidence and make a second probe unreadable.
  In `a foreign receipt does not clear an owned job`, supply an absent terminal
  and a receipt with the wrong nonce. Include this session's local manifest,
  a child Herdr journal, and a job from another session. Change the owned
  receipt to matching exit evidence in a second call.

```ts
expect(statusAfter).toMatchObject({ ownGone: "cancelled", ownUnknown: "running",
	otherSession: "running", foreignOrigin: "running" });
expect(runBlockers).toContain(unknownRunId);
expect(jobBlockers).toEqual(expect.arrayContaining([
	{ kind: "job", id: "manifest-job", cancelFromOwner: false },
	{ kind: "job", id: "child-herdr-job", cancelFromOwner: true },
]));
expect(jobBlockers.map(x => x.id)).not.toContain("other-session-job");
expect(afterMatchingExit.map(x => x.id)).not.toContain("child-herdr-job");
expect(unreadable.complete).toBe(false);
```

- [ ] **See red.** Run `bash "$CTL_RUN" packages/roam/src/__tests__/local-stop-work.test.ts`.
  Expect no scoped settlement or owned-job evidence adapter.
- [ ] **Implement scoped settlement.** Share the reaper's local-origin
  predicate and `RunStore.cancel()` event behavior. Bind `r.session_id = ?`
  in SQL. Leave the startup reaper's unscoped behavior unchanged. In Stop,
  cancel active rows only after `proveAbsent`, not after a signal attempt.
  Reread the row's owner and child identity in the settlement transaction;
  changed or unknown work stays pending. Pass the exact row to Task 5,
  not a bare `host_pid`. Retain evidence
  for survivors even if their run row is already terminal. Use the existing
  leaf imports, not the subagent runner or a new runtime dependency.
- [ ] **Implement the read-only job check.** Use recorded session membership
  and checkout metadata to locate its stores and local manifests. Do not
  treat a failed store or directory read as empty. Reuse manifest and receipt
  liveness checks from `local-writers.ts`, not its checkout-wide blockers.
  Read the session's Herdr journal and child journals by session ID. Narrow
  `readChildJobJournals`' owner input to `Pick<Owner, "sessionId">` and add a
  strict read option for Stop. For Herdr exit, require non-conflicting verified
  payload exit evidence, including matching job ID, nonce, and digest via
  `parseRuntimeReceipt` when a receipt has not been collected. Use only the
  owned job's existing read transport. Do not collect logs, cancel, or write a
  job marker. Keep ambiguous evidence pending by ID. Only eligible Herdr jobs
  get `spider kill id:"<job-id>"` guidance from the owning session.
- [ ] **See green.** Run the same file. Mutants: remove the session predicate,
  cancel on receipt of a signal, and accept a mismatched job nonce. The
  settlement and foreign-receipt tests must reject them.
- [ ] **Commit** as `feat(roam): check and settle only the stopped session's work`.

#### Task 5: Enforce exact stopped-home shutdown and absence

**Depends on:** Tasks 3 and 4.

**Files:** Create `packages/roam/src/relocate/local-stop.ts`. Modify
`packages/roam/src/relocate/local.ts:42-54,95-138,263-274,427-436,527-585`.
Test `packages/roam/src/__tests__/local-session-stop.test.ts` (new). Leave
relocation's existing writer check and tests intact.

**Interfaces:** Augment `LocalRuntime` with `enforceStopped(home: StoppedHome): Promise<StopObservation>`
and `observeStopped(home: StoppedHome): Promise<StopObservation>`.
`LocalIO.signal(pid: number, signal: "SIGTERM" | "SIGKILL"): Promise<void>`
and `LocalIO.shutdown(operation: Operation, timeoutMs?: number): Promise<boolean>`
are the effects. Use `StopWorkPorts` from Task 4. In `local-stop.ts` export
`queueStopMode(db: Db, home: StoppedHome, mode: StopMode): void`; store the
mode separately from boot-bound evidence so a progress write cannot overwrite it.

- [ ] **Write the failing tests.** Drive `createLocalRuntime` using a real
  fixture home store, controllable clock, and recording I/O. Use
  `a wedged shutdown socket costs at most five seconds` with a socket that
  never acknowledges. In `hard stop verifies absence, not signal delivery`,
  leave a live subagent until its recorded birth identity disappears, leave
  a second session in the checkout, and include a live detached job. Upgrade
  an in-progress graceful check while its socket wait is open. In
  `late terminals invalidate the cheap confirmation`, lose a launch reply
  both with and without a delayed labelled terminal. Reboot with a recycled
  PID and repeat the check. For `an old shutdown cannot touch a new owner`,
  release a delayed request after the row has become running at a newer epoch.

```ts
expect(effectsBeforeStoppedReplica).toEqual([]);
expect(gracefulEffects).toEqual([[0, "shutdown"], [5_000, "SIGTERM"], [10_000, "SIGKILL"]]);
expect(hardOwnerOnlyEffects).toEqual([[0, "SIGKILL"]]);
expect(upgradeEffects.map(e => e[1])).toEqual(["shutdown", "SIGKILL"]);
expect(signalledPids).not.toContain(otherSessionPid);
expect(signalledPids).not.toContain(detachedJobPid);
expect(whileChildSurvives.evidence.kind).toBe("pending");
expect(whileJobSurvives.evidence).toMatchObject({ kind: "pending", blockers: [{ kind: "job", id: jobId }] });
expect(afterExit.evidence.kind).toBe("confirmed");
expect(frozenMembership).toMatchObject({ state: "frozen", epoch: 8 });
expect(afterLostReplyNoTerminal.evidence.kind).toBe("confirmed");
expect(fullCheckCountAfterNoChange).toBe(fullCheckCountAtConfirmation);
expect(shortReadAfterLateTerminal.evidence.kind).toBe("pending");
expect(afterLateExit.evidence.kind).toBe("confirmed");
expect(afterReboot.signals).not.toContain(recycledPid);
expect(laterOwnerSignals).toEqual([]);
```

- [ ] **See red.** Run `bash "$CTL_RUN" packages/roam/src/__tests__/local-session-stop.test.ts`.
  Expect the stopped-home entry point to be missing. The existing relocation
  shutdown order and checkout check cannot satisfy these assertions.
- [ ] **Implement the stopped-only path.** Under `withSessionState`, require
  the exact stopped row before acting, including a foreign stopped row for a
  known displaced local session. Check the ID lock, file lease, and exact
  terminal labels where applicable, plus PID, birth, and boot. An old launch
  label need not match the Stop epoch; a future or contradictory label is
  never signal authority. Begin without requiring a live view or checkout. Capture the verified process tree
  before shutdown. Persist survivor identities by exact home and boot before
  the first effect. Save `checking` when a real check begins or advances, and
  `pending` when it finds a blocker. Use no launch-attempt record. Exclude
  detached job trees and leave unclassified children unsignalled. Recheck home
  and identity before each effect and after each wait. If the owner exits,
  require no replacement and reverify each remaining captured target.
- [ ] **Apply the mode and verify absence.** In graceful mode allow 5 seconds
  total for the socket request and owner exit. Use the existing
  `requestSessionControl` timeout and an outer deadline, so neither an
  acknowledgement nor a stalled reply extends the wait. Send `SIGTERM` to
  verified survivors and allow 5 more seconds before escalation. Hard mode
  skips both waits and uses `SIGKILL`. Reread mode during waits and before
  every effect; an upgrade skips remaining grace time. Once the owner has
  exited, settle this session's runs with Task 4. Use captured/current-boot
  evidence to authorize a signal, never a row's birth alone across a reboot.
  Independent absence or verified identity replacement may clear a row;
  unknown live identity or unreadable records stay pending. Recheck job
  journals after the owner and child checks, before freezing membership at
  the stopped epoch and confirming absence. Do not reactivate to freeze. Bound I/O by the remaining readiness budget and never
  permit a timed-out effect to bypass the next exact-home check.
- [ ] **Keep the short check.** Save confirmation only with the still-matching
  home and boot. On later passes check the ID lock and labelled terminals
  only. Invalidate and repeat the full check on new evidence or uncertainty.
  `observeStopped` does not write or renew cached times. If its short or boot
  check contradicts cached proof, return a pending observation timestamped
  at that check. Report missing or different rows explicitly. Keep moving-home
  relocation's child-first order and explicit `SIGTERM` calls.
- [ ] **See green.** Run the same file. Mutants: remove the exact stopped-row
  check, compare only PID after reboot, and infer absence from the socket
  acknowledgement. The named no-signal and survivor tests must reject them.
- [ ] **Commit** as `feat(roam): enforce and confirm the stopped home locally`.

#### Task 6: Publish the box Stop protocol and route the supervisor

**Depends on:** Task 5.

**Files:** Modify `packages/roam/src/relocate/{remote,adapters,local,supervisor,runtime}.ts`.
Test `packages/roam/src/__tests__/session-stop-agent.test.ts` (new). Edit
`packages/roam/src/__tests__/relocate-supervisor.test.ts` and
`packages/roam/src/__tests__/relocate-runtime.test.ts` where they compose
supervisor ports or expect generic Stop on a stopped row.

**Interfaces:** Add the following v0 agent cases in `remote.ts`:

```ts
{ version: 1, kind: "ensure-stopped", sourceMachine: MachineId, home: StoppedHome, mode: StopMode }
{ version: 1, kind: "session-observation", sourceMachine: MachineId, sessionId: SessionId, home: StoppedHome }
```

Return v0 successes with `{ version: 1, pending: true }` or
`{ version: 1, observation: StopObservation }`, respectively. Add
`sessionStopVersion: 1` to `hello`. From `createRelocateAdapters`, expose
`stop: StopMachinePorts` with:

```ts
stopCapability(machineId: MachineId): Promise<V0Result<"supported" | "old-agent">>;
ensureStopped(home: StoppedHome, mode: StopMode): Promise<V0Result<void>>;
observe(machineId: MachineId, home: StoppedHome): Promise<V0Result<StopObservation>>;
publishStopped(home: StoppedHome, observer: MachineId): Promise<V0Result<void>>;
enforceLocal(home: StoppedHome): Promise<StopObservation>;
```

In `supervisor.ts` consume `StopSupervisorPorts = HomeSupervisorPorts & {
stopStopped(home: StoppedHome): Promise<StopObservation> }`. Expose the
extended supervisor and Stop ports through the return type of the adapter.
Do not change the frozen `HomeSupervisorPorts` or `RelocateAdapters` types.

- [ ] **Write the failing tests.** In `queues hard mode without taking the local lock`,
  hold the local state lock, import exact epoch `8` through v0 sync, and send
  `ensure-stopped` to the actual handler. Test disabled, wrong sender, foreign
  ensure target, wrong home, and a request that names a PID. In
  `enforces the replica even if the hub vanishes after publication`, tick an
  actual supervisor after importing a stopped row with no queued call. Repeat
  with hard queued before the check, a previously local now-foreign stopped
  row, and a reboot with the stopped row intact. Read observations via the
  agent while placement lookup fails. Check missing and changed replicas.

```ts
expect(hello.value).toMatchObject({ sessionStopVersion: 1 });
expect(beforeUnlock.value).toEqual({ version: 1, pending: true });
expect(signalsBeforeUnlock).toEqual([]);
expect(refusals.map(r => r.ok)).toEqual([false, false, false, false, false]);
expect(onlyPublished.effects[0]).toBe("shutdown");
expect(hardQueued.effects).toEqual(["SIGKILL"]);
expect(displaced.observation).toMatchObject({ machineId: displacedId, home: newerForeignStopped });
expect(afterReboot.launches).toBe(0);
expect(missingReplica.home).toBeNull();
expect(wrongReplica.home).toEqual(olderRunningHome);
```

- [ ] **See red.** Run `bash "$CTL_RUN" packages/roam/src/__tests__/session-stop-agent.test.ts`.
  Expect `ensure-stopped` to be rejected and no stopped observation.
- [ ] **Wire the protocol.** Validate exact fields and enrollment in the
  existing v0 trust boundary. Require the exact durable stopped row and its
  named local machine for `ensure-stopped`. Queue or upgrade mode in a short
  transaction without taking the session state lock. Ignore queued modes for
  superseded homes. The read-only request returns the observed row and boot,
  even on mismatch, with no confirming evidence for that mismatch. Report
  disabled replication separately. Check decoded reply identity and bounds at
  the adapter. Use the existing revoked-peer guard and no legacy agent.
- [ ] **Wire the supervisor.** In `entries`, skip placement lookup for local
  and previously managed foreign `stopped` rows. Include retained local
  placement or membership for a displaced copy, even if its checkout cannot
  be opened. Route these entries through `enforceStopped`, never `start`.
  Unknown local provenance cannot supply exit proof. Keep the existing path
  for other non-running entries. Use the same local check on the Mac without
  a supervisor. For Stop, `publishStopped` requests one targeted sync, then
  reads back the exact row even on a separate store failure. Do not change
  relocation's all-store sync check.
- [ ] **See green.** Run the same file. Mutants: take the lock before replying,
  accept ensure for a different epoch, and skip foreign stopped rows. The
  held-lock, epoch, and displaced cases must catch them. Run the two edited
  supervisor regressions separately.
- [ ] **Commit** as `feat(roam): enforce stopped replicas through v0 controls`.

### Phase 1C. Reconcile requests and preserve stopped placements

#### Task 7: Complete saved Stop after contact or hub restart

**Depends on:** Tasks 2 and 6.

**Files:** Create `packages/roam/src/relocate/session-reconcile.ts`. Modify
`packages/roam/src/relocate/{runtime,session-stop,session-stop-store}.ts`.
Test `packages/roam/src/__tests__/session-stop-reconnect.test.ts` (new).

**Interfaces:** Export `createSessionReconciler(ports: SessionReconcilePorts): SessionReconciler`.
Use Task 2's operation queue and lock, Task 1's store and `projectSessionStatus`,
Task 6's `StopMachinePorts`, `Clock`, and the local machine ID. Add
`reconcile(home: StoppedHome): Promise<void>`, `afterPeerSync(peer: MachineId): void`,
`resume(): void`, and `close(): Promise<void>`. Bind the resulting Stop command
as internal `V0Runtime.stopSession(request: StopRequest): Promise<SessionOutcome>`.
`afterPeerSync` schedules work without waiting for it. `reconcile` starts one
contact round and returns without waiting for an offline box to return. The caller waits on the
outcome, separately bounded by `readyMs`.

- [ ] **Write the failing tests.** In `resumes a saved hard stop after reconnect`,
  save Stop with no route, upgrade it with Kill now, and reopen the hub on
  the same fixture DB. Drive real v0 sync with a controlled transport. Restore
  the route with an unrelated store refusal after global import. Deliver hard
  mode before the supervisor tick; verify shutdown skips both grace periods.
  In `older proof cannot erase a blocker`, deliver a same-epoch later blocker,
  an older success, and a success for a superseded epoch. Test an old agent,
  offline agent, disabled replica, capable agent without evidence, and revoked
  peer. Test a current stopped replica that is missing on renewed contact.

```ts
expect(initial.reason).toBe("Stop pending: the box is unreachable and may still be running");
expect(afterUpgrade.epoch).toBe(8);
expect(retryOffsetsMs).toEqual([30_000, 60_000, 120_000]);
expect(sentMode).toBe("hard");
expect(effects).toEqual(["SIGKILL"]);
expect(reconnected).toMatchObject({ status: "stopped", observedAt: exitCheckAt });
expect(stalePositive.status).toBe("stop-pending");
expect(newerEpoch).toEqual(newerHome);
expect(oldAgent.reason).toBe("Stop pending: update roaming on the box. It may still be running.");
expect(disabled.reason).toContain("disabled");
expect(capableNoObservation.reason).not.toContain("update roaming");
expect(revokedTraffic).toEqual([]);
expect(afterReplicaLoss.status).toBe("stop-pending");
```

- [ ] **See red.** Run `bash "$CTL_RUN" packages/roam/src/__tests__/session-stop-reconnect.test.ts`.
  Expect no replay of the saved mode or recording of exit on reconnect.
- [ ] **Compose reconciliation.** Initial contact uses targeted publication
  and exact read-back, then sends the saved mode to the named home and reads
  evidence from that home and each recorded displaced observer. On reconnect
  use `createSync({ onPeerSync })`; schedule separate work after sync and do
  not await or start sync from its completion callback. Bind only on the
  live hub, not in every short-lived agent invocation. Read back the home
  even on partial sync failure. On a reached peer, poll observations every
  10 seconds while pending. Unreachable peers use the existing sync retries.
  If the replica is missing, publish again through the next targeted round.
  Use `hello` only to distinguish a reachable old agent. Old agents still get
  the compatible home row. Read disabled and reachable-with-no-evidence as
  separate reasons. Coalesce each peer, session, and epoch, including triggers
  during an in-flight call. A new hard upgrade needs a new send, not a new epoch.
- [ ] **Save evidence under lock.** Match exact home and expected observer,
  never just session ID or epoch. Keep the latest observation per observer;
  reject older replies without updating the check time. Sequence contacts
  across boot changes so a late reply from the previous boot loses. A newer
  contradiction, including a reported missing replica, invalidates the proof.
  A network failure by itself does not erase a saved matching confirmation.
  For a displaced local Mac use `enforceLocal`. Resume committed requests at
  hub startup and on enable. Drain accepted work and stop timers before
  closing its stores. For `session-status`, use the cached projection only.
- [ ] **See green.** Run the same file. Assert one in-flight round and no
  recursive sync in the fixture. Mutants: skip all contact on a partial sync
  failure, save a receipt as confirmation, and let an older observation
  overwrite a newer blocker.
- [ ] **Commit** as `feat(roam): reconcile saved stops after peer sync`.

#### Task 8: Start the exact stopped session explicitly

**Depends on:** Task 7. Move the stopped same-home branch in this task.

**Files:** Create `packages/roam/src/relocate/session-start.ts`. Modify
`packages/roam/src/relocate/{runtime,session-reconcile,local,remote,adapters,relocate,service,cli}.ts`
and `packages/roam/src/cli.ts` (relocate result typing only for now).
Test `packages/roam/src/__tests__/session-start.test.ts` (new). Edit the
same-home stopped cases in `packages/roam/src/__tests__/relocate.test.ts:195-215,326-334`.
Keep the running cases unchanged.

**Interfaces:** Export `createStartCommand(ports: StartCommandPorts): (request: StartRequest) => Promise<SessionOutcome>`.
Bind it as internal `V0Runtime.startSession(request: StartRequest): Promise<SessionOutcome>`.
Consume Task 2's queue and lock, Task 1's `HubHomeStore` and transition store,
Task 6's observation port, and the adapters' `locate`, `publishHome`,
`activate`, and `start`. Bind the Start port
`confirm(home: RunningHome, placement: SessionPlacement, exact: true):
Promise<V0Result<{ terminal: string }>>` to the same exact check with a
read-only admission proof required. Add adapter
`checkStart(home: SettledHome): Promise<V0Result<SessionPlacement>>`.
In `relocate.ts` export `SettledRelocateOutcome = RelocateOutcome | { ok: true;
value: { home: StoppedHome; moveId: RelocateId | null; disposition:
"already-home" | "relocated" | "undone"; stop: SessionStatus } }`. The
stopped value has no terminal. Pass `stoppedStatus?: (home: StoppedHome) =>
SessionStatus` to `relocate`; use a pending projection when absent. In
`service.ts` define `V0PlacementControlServices = Omit<V0ControlServices,
"relocate"> & { relocate(request: RelocateRequest): Promise<SettledRelocateOutcome> }`.
Use this in `V0HubControlServices` and in CLI consumers instead of changing
`V0ControlServices` in the frozen file.

- [ ] **Write the failing tests.** In `keeps moveId and publishes before activation`,
  start from box `stopped` epoch `8` with matching proof. Observe the actual
  replica and membership at each effect. Hold pi after ID lock and file lease
  but before admission. Only the exact admitted owner completes.
  In `a delayed Start cannot spawn after the next Stop`, hold publication or
  launch until Stop commits. Also lose the Start reply after CAS and replay
  its original ID, once with an owner already present. Refuse an unavailable
  preflight, pending Stop, different epoch, missing capability, and an
  unverified displaced machine. In `does not grant an away epoch without a move ID`,
  use an already adopted box home with `moveId: null`. Verify no CAS,
  activation, or new fence. Prove the usual away-fence guard still runs for a
  valid `moveId`. Move the old lost-CAS-resume assertion here and replace
  the same-home relocate expectations with stopped-state assertions.

```ts
expect(issuedHome).toMatchObject({ state: "running", epoch: 9, moveId });
expect(atActivate).toMatchObject({ home: issuedHome, verifiedReplica: issuedHome });
expect(atLaunch.membership).toMatchObject({ state: "active", epoch: 9 });
expect(awaitingExactOwner.status).toBe("starting");
expect(confirmed).toMatchObject({ status: "running", outcome: "complete", observedAt: ownerCheckedAt });
expect(afterRetry.epoch).toBe(9);
expect(ownersAfterRetry).toHaveLength(1);
expect(afterDelayedStart).toMatchObject({ state: "stopped", epoch: 10 });
expect(staleLaunches).toEqual([]);
expect(refusedHomes).toEqual(originalHomes);
expect(noMoveId).toMatchObject({ outcome: "refused", reason: expect.stringContaining("relocate") });
expect(noMoveIdEffects).toEqual([]);
expect(awayFence).toMatchObject({ epoch: 9, moveId });
```

- [ ] **See red.** Run `bash "$CTL_RUN" packages/roam/src/__tests__/session-start.test.ts`.
  Expect no explicit Start. Same-home relocation currently activates under
  `stopped` before granting the running row.
- [ ] **Move and reorder the authorization.** Check the request ID, exact
  expectation, placement, control support, and fresh no-owner evidence under
  the shared operation lock. For a stopped box use `hello`, the verified
  placement, and a fresh exact stopped observation with the short owner check.
  Do not accept the saved Mac proof alone. Check the local Mac the same way
  without RPC. Never skip Stop or displaced proof. CAS and save Start
  together. Keep `moveId` and the existing running CAS fence behavior.
  `initialize` can leave an adopted away home with no `moveId`; an away Start
  CAS cannot preserve that null and grant running. Refuse before mutation.
  Guide the operator to relocate the confirmed stopped copy to the Mac and
  then use Start. Do not repair by synthesizing an ID or weakening the fence.
  Drop `local.ts:512`'s stopped-successor clause in the same commit, not the
  moving successor. A same-home stopped relocate returns the cached Stop
  status without launch, even without a verified checkout.
- [ ] **Complete outside the operation lock.** Publish and read back the
  exact running row, then activate, start, and `confirm(home, placement, true)`.
  Recheck before every local effect. Verify the exact file and check its
  lease before spawning under the session state lock. Pi still acquires its
  own ID lock and file lease at admission. A labelled process holding a lock
  can still be awaiting admission. Bind Start's confirmation through
  `confirm(home, placement, true, true)` in the local and remote adapters.
  The fourth flag requests Task 3's exact-owner inspection; send `exact: true,
  admitted: true` and require both back on success. A pre-admission reply
  cannot complete Start. Leave relocation's confirmation unchanged.
  Save the verified result only under lock and only for that home. Existing
  running homes use the same epoch. Check for an existing owner first. An
  existing owner that cannot answer the exact inspection is not permission
  to launch another. A failed or delayed confirmation stays **Starting**.
  A box can finish via
  its supervisor; reconcile its pending Start on contact. On the Mac continue
  only the explicit pending operation, never restart an already completed one
  automatically. Retry the original operation after a lost reply without a
  new epoch or owner. Validate the new result variant in the client before
  formatting it. Keep the existing running result shape intact.
- [ ] **See green.** Run the same file and the edited `relocate.test.ts`
  separately. Mutants: activate before publication, omit the exact-owner flag,
  and let a stale request advance the epoch. The ordered effects and races
  must catch all three.
- [ ] **Commit** as `feat(roam): authorize explicit Start at the next epoch`.

#### Task 9: Relocate a stopped copy without making it runnable

**Depends on:** Tasks 7 and 8.

**Files:** Modify `packages/roam/src/relocate/{relocate,adapters,remote,transfer,local,runtime}.ts`.
Test `packages/roam/src/__tests__/relocate-stopped.test.ts` (new). Edit the
stopped-source cases in `packages/roam/src/__tests__/relocate.test.ts:195-207`
and the stopped seed case in `packages/roam/src/__tests__/relocate-adapters.test.ts:194-200`.

**Interfaces:** In `relocate.ts` add `Partial<{ stoppedPlacements:
StoppedPlacementPorts }>` to the function's injected ports, not to the
frozen interface. This port has
`verifyStoppedSource(home: StoppedHome): Promise<V0Result<void>>`,
`installDestination(plan: RelocatePlan, captured: CapturedSession, home: StoppedHome): Promise<V0Result<InstalledSession>>`,
and `commitStopped(expected: RelocateHome, home: StoppedHome): Promise<HomeCasResult>`.
The real hub supplies this port. Refuse a stopped move when it is absent in
an embedder. Use the same install implementation and the Task 1 CAS hook.
In `local.ts` add `freezeStoppedPlacement(home: StoppedHome, placement: SessionPlacement, moving?: MovingHome): Promise<V0Result<void>>`
to `LocalRuntime`. Widen `installLocalSession` and the existing v0 `install`
request to `SettledHome`. Use Task 8's `SettledRelocateOutcome`.

- [ ] **Write the failing tests.** In `keeps stopped through install, undo, and rollback`,
  drive fixture stores through a move, an undo of a started move, and failure
  publishing the moving row. Include a lost reply after commit and repeat
  same-home relocate. In `requires source proof before copying a stopped home`,
  offer only a receipt, stale proof, and a confirmed destination with a
  still-unverified displaced machine. Assert no copy in all three cases.
  Verify the destination installed transcript and frozen membership separately.

```ts
expect(committed).toMatchObject({ machineId: destination, epoch: 10, state: "stopped" });
expect(undone).toMatchObject({ machineId: source, epoch: 10, state: "stopped" });
expect(rolledBack).toMatchObject({ machineId: source, epoch: 10, state: "stopped" });
expect(installedMembership).toEqual({ epoch: 10, state: "frozen" });
expect(activationOrLaunchEffects).toEqual([]);
expect(reply.value).not.toHaveProperty("terminal");
expect(repeat.homeEpoch).toBe(10);
expect(copiesWithoutProof).toHaveLength(0);
```

- [ ] **See red.** Run `bash "$CTL_RUN" packages/roam/src/__tests__/relocate-stopped.test.ts`.
  Expect the stopped move or restore to yield a running home today.
- [ ] **Keep the plan's prior state.** Before moving a stopped home, require
  a confirmed Mac status, no unverified displaced machine, and fresh exact
  source absence. This prevents a second placement from forgetting the first
  unverified source. Keep frozen membership at the source epoch. Skip the
  active-only seed and ordinary-source capture for stopped sources. The old
  stopped `seed` request now refuses without changing membership. Keep the
  checkout writer and final capture checks. Derive destination,
  undo, and rollback state from `plan.source.state`. For a stopped destination
  install the existing files, then write frozen membership at the committed
  epoch under the local state lock and exact moving or stopped check. Register
  local placement without calling `activate`. On undo or rollback publish the
  stopped source row and let the Stop routine freeze it at its new epoch.
- [ ] **Record and reconcile.** A stopped placement CAS creates a pending
  graceful record for its own epoch, not a copy of the source proof. Publish
  and reconcile after the operation lock releases. A terminal-free outcome uses the cached
  status until exact absence is confirmed. Keep the stopped move journal's
  existing checkpoint prefix through commit; keep exit outcome in the
  transition store. Do not write a running-only journal `result` or fake
  `start-destination`. A retry after commit reads the authoritative stopped
  row and reconciles it rather than reinstalling or starting. Keep the
  running move, its undo path, and running checkpoint parser unchanged.
- [ ] **See green.** Run the same file and both edited tests separately.
  Mutants: force the rollback to running, seed a frozen source by reactivation,
  and report destination confirmation without observed exit.
- [ ] **Commit** as `feat(roam): preserve stopped homes through relocation`.

#### Task 10: Keep force stopped and retain displaced exit obligations

**Depends on:** Task 9.

**Files:** Modify `packages/roam/src/relocate/{home,set-home,runtime,session-stop-store,session-reconcile,service,cli}.ts`.
Test `packages/roam/src/__tests__/set-home-stopped.test.ts` (new). Run the
existing `relocate-set-home` and away-home admission tests as regressions.

**Interfaces:** Have `setHome(request: SetHomeRequest, ports: ForceHomePorts,
replication?: Pick<RoamConfig, "enabled" | "machineId">): Promise<V0Result<SettledHome>>`.
`ForceHomePorts = SetHomePorts & { commitStopped?(expected: RelocateHome,
home: StoppedHome): Promise<HomeCasResult> }`. Both hub and disabled Mac
recovery supply it. Refuse a stopped placement if the port is absent.
Use the same widened result in `V0PlacementControlServices.setHome` and
`recoverMacHomeWithoutHub`; omit and replace the old `setHome` signature in
`service.ts`. A stopped-force record
retains each earlier unverified displaced machine and adds the old source if
it differs from the destination and lacks proof for its old stopped epoch.

- [ ] **Write the failing tests.** In `B confirming does not clear an unreachable A`,
  stop while A is offline, force to B, and confirm B. Try Start. Feed a sync
  receipt for A, an observation of A's old row, and an exact new row with an
  unverified owner. Then supply A's confirmed absence for the exact new row.
  In a separate case, force B to C before either A or B confirms. Also force
  a `moving` home to the Mac with the hub disabled. Verify refusal when the Mac source-writer
  check fails and prove stopped force leaves an existing away fence intact.

```ts
expect(atB).toMatchObject({ status: "stop-pending", reason: `Stopped on ${bId}. ${aId} may still be running.` });
expect(startBeforeA.outcome).toBe("refused");
expect(statusAfterReceipt.status).toBe("stop-pending");
expect(statusAfterOldRow.status).toBe("stop-pending");
expect(statusWithAUnknown.status).toBe("stop-pending");
expect(statusAfterA.status).toBe("stopped");
expect(statusAfterSecondForce.reason).toContain(aId);
expect(statusAfterSecondForce.reason).toContain(bId);
expect(disabledMacHome).toMatchObject({ state: "stopped", machineId: macId, epoch: 9 });
expect(disabledMacMembership).toMatchObject({ state: "frozen", epoch: 9 });
expect(awayFenceAfter).toEqual(awayFenceBefore);
expect(homeWithWriters).toEqual(macSourceHome);
```

- [ ] **See red.** Run `bash "$CTL_RUN" packages/roam/src/__tests__/set-home-stopped.test.ts`.
  Expect force to write `running` or lose the displaced source.
- [ ] **Commit the stopped placement.** Retain exact typed confirmation, the
  warning about the old copy and unsynced work, and verified destination copy.
  Map `stopped` and `moving` to `stopped`. Save displaced obligations on
  the new pending graceful record in the CAS transaction. Keep the Mac
  source reservation and writer check on
  force to an away machine, independently of fence publication. No new fence
  and no fence clear for a stopped placement. Leave `running` force unchanged.
- [ ] **Enforce and report.** Release the operation lock after the stopped CAS.
  Publish the row, keep membership frozen, and reconcile via Task 7. For
  disabled reassignment to the Mac, use the local routine and durable record
  in the one-shot recovery runtime. Never
  activate or launch. On source contact require fresh exact absence from it,
  not a receipt or destination proof. List all still-unverified machines and
  refuse Start while any remain. A stopped assignment reply says the home
  was assigned, not that exit is confirmed. Point to cached status for proof
  and `spider roam start` after confirmation. Keep the running reply intact.
- [ ] **See green.** Run the same file. Mutants: drop prior displacement, clear
  a source on receipt, and publish an away fence for stopped force. The force,
  reconnect, and fence assertions must catch them.
- [ ] **Commit** as `feat(roam): preserve stopped state and exit debt on force`.

### Phase 1D. Ship the Core commands

#### Task 11: Serve Stop, Start, and cached status over the hub socket

**Depends on:** Tasks 7-10.

**Files:** Modify `packages/roam/src/relocate/{service,runtime,session-stop-store}.ts`.
Test `packages/roam/src/__tests__/session-stop-socket.test.ts` (new).

**Interfaces:** Export `V0SessionControlServices` with
`stop(request: StopRequest): Promise<SessionOutcome>`,
`start(request: StartRequest): Promise<SessionOutcome>`, and
`sessionStatus(request: { sessionId: SessionId }): Promise<SessionStatus>`.
Return `V0HubControlServices & V0SessionControlServices` from
`requestV0Services`. Extend `serveV0Control`'s service argument with
`Partial<V0SessionControlServices>`, requiring all handlers in the real hub.
Bind Tasks 7 and 8's `stopSession` and `startSession`. A server with no
handler refuses the new kind rather than using a legacy API. Add the version `1` wire kinds `stop`,
`start`, and `session-status` with the existing `{ version, kind, request }`
envelope and `{ version, kind, result }` reply. Export the shared, synchronous
`readCachedSessionStatus(db: Db, sessionId: SessionId, now: number): SessionStatus`
from the transition store for the hub and CLI. Use `reason: "unmanaged-session"`
only for a verified non-managed ID. A missing row with a transition or
managed placement marker, damaged data, or unavailable storage is not
proof of non-management.
Export `V0SessionCallError` from `service.ts` with `submission: "not-sent" |
"unknown"` for mutation transport failures. Before attempting the write,
no hub is a refusal; once a write was attempted, a lost or invalid reply
is unknown.

- [ ] **Write the failing tests.** In `rejects invalid Stop frames before dispatch`,
  send raw socket frames with extra fields, invalid IDs, invalid mode or
  epoch, wrong version, and out-of-budget size. Test a valid direct request
  against a disabled hub. In `the saved request outlives a lost reply`, close
  the socket while queued and immediately after CAS. Read single-session
  status from a separate connection. Include an unsafe socket inode and a
  fake server with a mismatched reply ID or oversized result.

```ts
expect(invalid.error).toBe("invalid-arguments");
expect(mutationsAfterInvalidOrDisabled).toBe(0);
expect(disabledReply.outcome).toBe("refused");
expect(laterStatus).toMatchObject({ homeState: "stopped", homeEpoch: 8 });
expect(statusPeerCalls).toEqual([]);
await expect(badReplyCall).rejects.toThrow();
expect(acceptedOnUnsafeSocket).toBe(0);
```

- [ ] **See red.** Run `bash "$CTL_RUN" packages/roam/src/__tests__/session-stop-socket.test.ts`.
  Expect a valid Stop kind to be rejected.
- [ ] **Implement the boundary.** Validate exact keys, positive safe epoch,
  machine UUID, session ID and operation ID, and the two modes. Preserve
  `0700` directory, `0600` socket, single newline framing, 32 KiB requests,
  and 1 MiB replies. Validate reply kind, home and outcome consistency,
  session ID, and operation ID before reporting success. Distinguish socket
  unavailable before submitting from a lost reply after attempting the write. Do not retry a
  mutation at the client. Check the Mac role and live enabled flag in the
  hub just before acceptance and under the mutation lock. Closed clients do
  not own the accepted work. `session-status` reads once from cached data.
- [ ] **See green.** Run the same file. Mutants: dispatch after failed parse,
  trust an uncorrelated result, and cancel accepted work on client close.
- [ ] **Commit** as `feat(roam): expose session actions on the v0 hub socket`.

#### Task 12: Cut the public verbs and update cached status and repairs

**Depends on:** Task 11. Coordinate this cut with old-path 3D and 3E.

**Files:** Modify `packages/roam/src/{cli,commands,diagnostics,hosting-warning,local-diagnostics,production-controls,participant-runtime}.ts`,
`packages/roam/src/relocate/{cli,session-catalog}.ts`, and
`packages/host/src/roam/admission.ts:75-81,196-225`. Update current command
copy in `docs/architecture/roaming.md` and `packages/roam/README.md`. Keep
historical repair instructions in `docs/guide/roaming-upgrade.md`.
Test `packages/roam/src/__tests__/session-stop-cli.test.ts` (new). Edit existing
`packages/roam/src/__tests__/{cli-controls,commands,pending-launch-controls,pending-launch-repair,handoff-doctor,status-cli,supervisor}.test.ts`
and `packages/host/src/__tests__/{roam-admission,herdr-roam-hosting}.test.ts` only
where they assert retired behavior or repairs. Extend the installed help
cases in `packages/host/src/__tests__/roam-cli-installed.test.ts` for
Stop, `--now`, Start, and the missing Resume. Run that file on CI only.

**Interfaces:** `parsePublicControl` recognizes `stop <session> [--now]` and
`start <session>` (both accept the existing final `--json`) and rejects
`resume`. Accept one name with spaces without accepting controls or a flag
as a target. Leave other commands' name parsing unchanged. In `relocate/cli.ts` add `runSessionAction(control: { kind: "stop";
session: string; mode: StopMode } | { kind: "start"; session: string }, config:
RoamConfig, db: Db, services: V0SessionControlServices, io: V0CommandIO,
json: boolean): Promise<number>`. Resolve with `resolveControlSession`,
supplying only managed home IDs, including unnamed sessions without a
location row. A name is optional metadata, not proof of management. Reuse
`readCachedSessionStatus` in `runLocalStatus` and add `sessions: readonly
SessionStatus[]` to the cached result without removing legacy status fields.
Use Task 1's home decoder for pre-v0 stores.
Keep the existing exit convention for a cached status read.

- [ ] **Write the failing tests.** In `public stop and start never reach a legacy socket`,
  run the real CLI with a listening legacy decoy, a recording legacy agent
  transport, and a v0 fixture. Resolve full ID, unique prefix, and exact
  name, including a name with spaces.
  Table-test bad flags, ambiguous name, legacy-only ID, disabled hub, box
  caller, and lost mutation reply. In `status reads cached proof and its age`,
  close the hub socket, then read text and JSON for running, stopped, moving,
  and stop-pending homes. Test the original guidance boundaries against both
  kinds of session.

```ts
expect(exitCodes).toEqual({ confirmed: 0, pending: 3, lost: 3, refused: 1, invalid: 2 });
expect(sentStop).toMatchObject({ sessionId, machineId: boxId, homeEpoch: 7, mode: "hard" });
expect(sentStart).toMatchObject({ sessionId, machineId: boxId, homeEpoch: 8 });
expect(lostText).toMatch(/unknown.*status/is);
expect(lostText).not.toMatch(/saved/i);
expect(legacyCalls).toEqual([]);
expect(rawAgentCalls).toEqual([]);
expect(resumeExit).toBe(2);
expect(cachedJson.sessions).toContainEqual(expect.objectContaining({ sessionId, machineId: boxId,
	homeState: "stopped", homeEpoch: 8, status: "stopped", observedAt: exitCheckAt }));
expect(cachedText).toContain("Stopped");
expect(cachedText).toContain("12 seconds ago");
expect(legacyRepair).toContain("roaming-upgrade.md#settle-old-work-only-after-approval");
expect(stoppedV0Repair).toContain("spider roam start");
```

- [ ] **See red.** Run `bash "$CTL_RUN" packages/roam/src/__tests__/session-stop-cli.test.ts`.
  Expect public Stop to use the old path, Start to be unrecognized, and the
  cached projection and new repairs to be absent.
- [ ] **Cut and report.** Resolve one managed session on the Mac; do not adopt
  a copy. Send the observed home and fresh operation ID once. Map `--now` to
  hard. Print home machine, state, epoch, observed status and reason, and
  last observation time in both formats. Show age for Running and Stopped.
  Return exit `3` for a lost reply without a saved claim and tell the caller
  to read status. Keep status local and read-only with the hub down. Replace
  `stop|resume` in help and remove public legacy intent dispatch for these
  verbs. Keep private raw-agent controls for their remaining callers.
- [ ] **Rewrite repairs in the same cut.** For legacy intent, pending launch,
  and hosting-warning paths, point to the legacy upgrade guide rather than
  emitting an executable Stop or Resume repair. Where existing issue types
  require a current command, use `spider roam doctor` with the guide in the
  detail. Do not change the legacy evidence or private controls. Stopped v0
  admission and stopped force point to `spider roam start`; do not suggest it
  for a foreign, unknown, moving, or unconfirmed home as a bypass. Rebase
  parser and CLI assertions after 3D; do not restore its removed verbs.
- [ ] **See green.** Run the same file, then the edited unit files one at a
  time. Use the installed help test on CI; keep its existing bundle resource
  entry. Mutants: restore public
  legacy dispatch, label a lost reply saved, and give a legacy intent the new
  `start` repair. The CLI and repair assertions must catch them.
- [ ] **Commit** as `feat(roam): cut public Stop and Start over to v0`.

#### Amendment: Task 12A

Hosted subagents run outside the owner's OS tree. Kill now binds the local run
row and its event to private supervisor state and a live same-core terminal.
In the current boot, signal the verified supervisor before its child.
Graceful Stop keeps its signal scope and still checks hosted work for exit.

#### Task 13: Prove Core on packaged Linux (R20)

**Depends on:** Task 12.

**Files:** Create `packages/herdr/e2e/fixtures/roam-session-stop.ts`,
`packages/herdr/e2e/scenarios/roam-session-stop.test.ts`, and
`packages/herdr/e2e/controls/roam-session-stop-ci.test.ts`. Modify
`packages/herdr/e2e/fixtures/{roam-relocate.ts,roam-hc-fault.mjs}` only for
an opt-in fixture route switch. Modify `scripts/herdr-e2e.mjs` and
`packages/herdr/e2e/README.md` after the shared-file check above.

**Interfaces:** Export `sessionStopFixture(suite: Suite): Promise<SessionStopFixture>`.
Reuse `relocateFixture` and the owned process ledger; add its optional
`{ hubCoreWrapper?: string }` input. Expose the managed session's `sessionId`,
`hub` and `box` fixture sides, `cli(...args: string[]): Promise<CliResult>`,
`partition(down: boolean): Promise<void>`, `proof(): Promise<StopFixtureProof>`,
and `close(): Promise<void>`. `CliResult` is `{ exitCode: number | null;
stdout: string; stderr: string }`. `StopFixtureProof` includes `sessionId`,
`file`, `cwd`, `transcriptPrefixHash`, `liveOwnerCount: number`,
`liveOwned: readonly OwnerGeneration[]`, `owner: OwnerGeneration | null`,
`runs: readonly { id: string; status: string }[]`, `jobs: readonly { id:
string; exitVerified: boolean }[]`, and `hub` and `box` with actual `home`
rows. `liveOwned` covers pi and owned child and detached processes. Read ID
locks, file lease, labels, birth and boot, run rows, and job exit evidence
independently of command output. Use the same fixture in Task 18.

- [ ] **Write the failing selector and story.** In `selects R20 as a one-worker opt-in`,
  call `ci-matrix.mjs` as in `ci-contract.test.ts` and use `parseOptions` and
  `storyWorkers` from the runner. Export a named `scenarios` array with
  `id: storyId("R20")` and `tiers: ["headless"]`; use `registerScenarios` as
  in R18. In `packaged CLI stops, starts, and
  reconciles after reconnect`, exercise CLI mutations on a relocated
  fixture session. Record transcript ID and a content hash and record
  checkout identity. First prove graceful Stop sticks across two 10-second
  supervisor passes. Start, run a live subagent and a fixture-owned detached
  job, and Kill now. The job must remain pending until independent exit.
  Start again, cut only the fixture peer route, Stop, restore the route, and
  wait for confirmation without a second mutation. Check the old running
  replica and owner during the cut. Use the real packed CLI and agent; do not
  simulate confirmation by writing a row from the test.

```ts
expect(matrixFor("R20")).toEqual([{ story: "R20", timeout: 5 }]);
expect(defaultIds).toEqual(["R18", "R10", "R11"]);
expect(profileIds.headless).not.toContain("R20");
expect(roamTaskIds).not.toContain("R20");
expect(storyWorkers(explicitR20)).toBe(1);
expect(proofsAcrossTwoPasses).toHaveLength(2);
for (const proof of proofsAcrossTwoPasses) {
	expect(proof).toMatchObject({ hub: { home: stoppedHome }, box: { home: stoppedHome }, liveOwned: [] });
}
expect(startedProof).toMatchObject({ sessionId, file: originalFile, cwd: originalCwd, liveOwnerCount: 1, transcriptPrefixHash });
expect(startedProof.owner).not.toEqual(originalOwner);
expect(killWithJob).toMatchObject({ status: "stop-pending", reason: expect.stringContaining(jobId) });
expect(beforeJobRelease).toMatchObject({ liveOwnerCount: 0, liveOwned: [jobIdentity], runs: [{ id: childRunId, status: "cancelled" }] });
expect(afterJobRelease.jobs).toContainEqual({ id: jobId, exitVerified: true });
expect(disconnectedProof).toMatchObject({ hub: { home: { state: "stopped" } }, box: { home: { state: "running" } }, liveOwnerCount: 1 });
expect(reconnectedProof).toMatchObject({ liveOwnerCount: 0, liveOwned: [] });
expect(reconnectedStatus.status).toBe("stopped");
```

- [ ] **See red.** Run `bash "$CTL_RUN" packages/herdr/e2e/controls/roam-session-stop-ci.test.ts --config packages/herdr/e2e/vitest.config.ts`.
  Expect unknown story `R20` before registration. Run the new story only
  in Linux CI; require reached process and row assertions, not a selector pass.
- [ ] **Register and wire.** Keep R20 out of the default profile and
  `--task roam`, but in the explicit story IDs and one-worker set. Keep the
  existing deadline. Use synthetic peer identity, distinct owned roots,
  scripted provider to start a real subagent and held detached job, and the
  fixture transport switch. Restore the route in teardown. After local
  confirmation, select two subsequent labelled-terminal scans in the core
  recording log by supervisor PID and namespace, not scans from `proof()`.
  Retain process, row, and transcript evidence and cleanup in the story report.
- [ ] **See green.** Run the selector file as above. Run packed R20 and the
  Core checkpoint stories in Linux CI on the exact candidate. Mutants:
  exclude R20 from explicit selection, add it to the default profile, and
  allow multiple story workers for R20. The selector file must reject them.
- [ ] **Commit** as `test(roam): prove session Stop and Start in the Linux pack`.

## Increment 2. Herdr seam

### Phase 2A. Expose bounded status and actions

#### Task 14: List managed sessions without a live pane

**Depends on:** Core, including Task 11's cached status.

**Files:** Modify `packages/roam/src/relocate/{service,runtime,session-stop-store,session-catalog}.ts`.
Test `packages/roam/src/__tests__/session-status-list.test.ts` (new).

**Interfaces:** Extend the `session-status` request with the exact alternative
`{ limit: number }`. Keep `{ sessionId: SessionId }` unchanged. Export
`sessionStatuses(request: { limit: number }): Promise<SessionStatusList>` on
`V0SessionControlServices`, where `SessionStatusList` is `{ rows: readonly
SessionStatusRow[]; truncated: boolean }` and `SessionStatusRow` is a managed,
non-null home in `SessionStatus` plus `name: string | null`. Export
`MAX_SESSION_STATUS_ROWS = 128` and
`readCachedSessionStatuses(db: Db, limit: number, now: number): SessionStatusList`.

- [ ] **Write the failing tests.** In `caps cached rows and keeps a stopped session without a pane`,
  seed 130 managed homes including one stopped home with no name or owner
  feed. Add a legacy row. Request the list over the socket with `limit: 1`,
  `130`, `0`, a fraction, and both fields. In a separate case add escaped
  multibyte names and large reasons to exercise the encoded cap.

```ts
expect(single.rows).toHaveLength(1);
expect(capped.rows).toHaveLength(128);
expect(capped.truncated).toBe(true);
expect(capped.rows).toContainEqual(expect.objectContaining({ sessionId: stoppedId, name: null, status: "stopped" }));
expect(capped.rows.some(row => row.sessionId === legacyId)).toBe(false);
expect(invalidReplies.every(x => x.error === "invalid-arguments")).toBe(true);
expect(Buffer.byteLength(wireReply)).toBeLessThanOrEqual(1_048_576);
expect(networkCalls).toEqual([]);
```

- [ ] **See red.** Run `bash "$CTL_RUN" packages/roam/src/__tests__/session-status-list.test.ts`.
  Expect the list request to be rejected.
- [ ] **Implement the bounded read.** Validate a positive safe integer and
  cap it at 128. Select in stable session-ID order, reading at most one extra
  home to detect truncation. Use Task 11's cached projection. Look up names
  only for selected IDs in locally recorded stores, with null for missing or
  unreadable metadata. Include stopped homes without a presentation. Apply
  the reply budget to the encoded envelope plus newline and trim whole rows,
  not individual reasons. Set `truncated` on either limit. Never add process
  evidence or file paths to rows and never contact peers.
- [ ] **See green.** Run the same file. Mutants: remove the server cap,
  filter on live ownership, and ignore encoded byte length.
- [ ] **Commit** as `feat(roam): list bounded cached session statuses`.

#### Task 15: Add pane requests, binding checks, and snapshot rows

**Depends on:** Task 14. This task keeps the pane package independent of roaming.

**Files:** Modify `packages/herdr/src/panes/{types,codec,service,snapshot}.ts`.
Test `packages/herdr/src/__tests__/pane-roam-session.test.ts` (new). Do not
edit existing pane tests or menu assets.

**Interfaces:** Add the `PaneRoamRequest`, `PaneRoamOutcome`, and
`PaneRoamSessionRow` types described in the [UI handoff](#ui-handoff).
Add `roamSessionAction(request: PaneRoamRequest): Promise<PaneRoamOutcome>`
and `roamSessions(limit: number): Promise<{ rows: readonly PaneRoamSessionRow[]; truncated: boolean }>`
to `PaneServicePorts`. Keep them optional only for non-roaming embedders.
The host always supplies them and emits `roamSessions`. Keep the key
optional in `PaneServiceSnapshot` and accept older replies unchanged.
Readers use an empty display list for a missing key, not absence proof.
Exclude these ops from `PaneMutation` and `open-existing` owner lookup. Do
not send them to the old dispatcher.

- [ ] **Write the failing tests.** In `rejects half of a presentation binding`,
  send each half alone plus a complete pair. In `binds an action without a
  new feed`, use the stored presentation with no source feed. Reject wrong
  session and stale revision, then send a row action and a status read. Hold
  a slow reply past the pane deadline. Check that snapshot preserves row
  limits and round trips through the real request and reply codecs.

```ts
expect(parseHalfId).toThrow();
expect(parseHalfRevision).toThrow();
expect(stale.outcome).toBe("refused");
expect(boundForwarded).toMatchObject({ operationId, sessionId, machineId: boxId, homeEpoch: 7 });
expect(movingReply).toMatchObject({ kind: "roam-session-outcome", outcome: "pending", reason: "waiting-for-move" });
expect(slow).toMatchObject({ kind: "roam-session-outcome", outcome: "pending", operationId });
expect(readReply.outcome).toBe("complete");
expect(snapshot.roamSessions).toContainEqual(stoppedRow);
expect(overBudgetSnapshot.complete).toBe(false);
```

- [ ] **See red.** Run `bash "$CTL_RUN" packages/herdr/src/__tests__/pane-roam-session.test.ts`.
  Expect the codec to reject the new valid action and the snapshot to lack
  the stopped row.
- [ ] **Implement the seam.** Validate both binding fields or neither, then
  check stored presentation revision and `target.sessionId`. Row requests
  carry the observed home to the hub. No fresh box feed or terminal is
  needed. Validate action and reply tags, positive epochs, and safe timestamp
  milliseconds. Keep the existing replay cap and identity. New-operation
  refusals (including a reused ID) use `roam-session-outcome`, not the old
  mutation result. At the 4-second response deadline return typed pending,
  with no saved claim, before the 5-second socket deadline. Do not cancel
  accepted work or hold the pane mutation queue across the hub wait. Bound
  list reads separately so an unavailable hub cannot hide ordinary rows.
  Include up to 128 cached rows in the existing snapshot byte budget. Mark
  incomplete when truncated or unavailable. No terminal effect here.
- [ ] **See green.** Run the same file. Mutants: permit a partial binding,
  ignore revision, and map a slow action to complete.
- [ ] **Commit** as `feat(herdr): add roaming session pane requests and rows`.

#### Task 16: Implement the host ports on the v0 socket

**Depends on:** Tasks 14 and 15.

**Files:** Create `packages/host/src/herdr/pane-roam-session.ts`. Modify
`packages/host/src/herdr/pane-runtime.ts:307-315`. Test
`packages/host/src/__tests__/herdr-pane-roam-session.test.ts` (new).

**Interfaces:** Export `createPaneRoamSessionPorts(root: string):
Required<Pick<PaneServicePorts, "roamSessionAction" | "roamSessions">>`.
Consume `requestV0Services(root)` and the cached status contracts from
Tasks 11 and 14. Only this package converts Herdr types to roaming types.

- [ ] **Write the failing tests.** In `maps pane actions to the exact hub request`,
  serve a real fixture v0 socket with an ordinary legacy decoy. Send `stop`,
  `kill-now`, `start`, a status read, and a bounded list. Drop a reply after
  write and remove the v0 socket in separate cases. Ensure the projected
  outcome includes only the named fields and never old process evidence.

```ts
expect(hubRequests).toEqual([gracefulRequest, hardRequest, startRequest, statusRequest, listRequest]);
expect(status).toMatchObject({ version: 1, kind: "roam-session-outcome", outcome: "complete", operationId, observedAt: exitCheckAt });
expect(uncertain.outcome).toBe("pending");
expect(noHub).toMatchObject({ outcome: "refused", reason: "hub-unavailable" });
expect(roamSessions.rows).toContainEqual(stoppedRow);
expect(legacyCalls).toEqual([]);
```

- [ ] **See red.** Run `bash "$CTL_RUN" packages/host/src/__tests__/herdr-pane-roam-session.test.ts`.
  Expect the real pane runtime not to issue the v0 requests.
- [ ] **Implement the adapter.** Use the host config's global root. Forward
  the original ID, session, machine, and epoch, not latest-feed values. Map
  `kill-now` to hard and `stop` to graceful. Status success is a successful
  read; it can show `stop-pending`. Keep `waiting-for-move` exactly. Map
  missing hub to refusal and uncertain submitted mutation to pending using
  Task 11's `V0SessionCallError`. Map an unavailable list to empty and
  incomplete, not to an empty authoritative set. No legacy endpoint fallback and no terminal call.
- [ ] **See green.** Run the same file. Mutants: use graceful for Kill now,
  mint a different operation ID, and upgrade a lost reply to complete.
- [ ] **Commit** as `feat(host): connect pane session actions to the v0 hub`.

### Phase 2B. Route confirmed Close and prove the packed seam

#### Task 17: Route only new managed Close requests to Stop

**Depends on:** Task 16. Keep the legacy private caller until 4B.

**Files:** Modify `packages/herdr/src/panes/{service,lifecycle}.ts` and
`packages/host/src/herdr/{pane-roam-session,pane-source,pane-stop}.ts`.
Test `packages/host/src/__tests__/herdr-pane-managed-close.test.ts` (new).
Run the existing pane lifecycle, endpoint, and stop tests without editing them.

**Interfaces:** Reuse `roamSessionAction` for managed Close. Export
`classifyPaneHome(root: string, sessionId: string): Promise<"managed" | "unmanaged" | "unknown">`
from the host adapter. Read the owned DB, managed marker and away-home fence
without modifying them. Do not call `loadRelocateAdmission`, which can clear
an away-home fence. On a failed status socket read the adapter can return
`unmanaged-session` only from verified local evidence. Use the same rule to
guard legacy `close-session`; enforce it again in the intent transaction.
The existing `close-confirmed` reply stays `kind: "outcome"` with the
corresponding status and reason. Explicit actions use `roam-session-outcome`.

- [ ] **Write the failing tests.** In `new managed close stops even if the terminal is gone`,
  send a new confirmed Close with the originally seen home and no feed. Hold
  it pending until hub proof, then repeat against a newer cached epoch; the
  earlier expectation stays bound. Replay a stored old `closing` row and
  repeat with the hub unavailable. Call the legacy source endpoint
  directly on a managed home. Use a valid-generation ordinary local Kill and
  then a stale-generation Kill as positive and negative controls.

```ts
expect(forwarded).toMatchObject({ action: "stop", operationId, sessionId, homeEpoch: 7 });
expect(withoutTerminal.outcome.status).toBe("pending");
expect(changedHome.outcome.status).toBe("refused");
expect(afterChangedHome.epoch).toBe(9);
expect(replayedOldClose.mutations).toEqual([]);
expect(noHub.outcome).toMatchObject({ status: "refused", reason: "hub-unavailable" });
expect(legacyManagedClose).toBe("managed-session-use-stop");
expect(managedIpcKills).toEqual([]);
expect(ordinaryKills).toEqual([validGeneration]);
```

- [ ] **See red.** Run `bash "$CTL_RUN" packages/host/src/__tests__/herdr-pane-managed-close.test.ts`.
  Expect the existing Close path to require a terminal or use `close-session`,
  not the hub. The legacy endpoint does not distinguish a v0 home today.
- [ ] **Implement the routing.** For new `close-confirmed`, check revision
  and `samePaneTarget` against the stored presentation before any live-core
  or feed lookup. Only `target.kind === "session"` is eligible, not a view
  owned by that session. Use `roamSessionAction` with a cached status read to
  identify a managed home, then send graceful Stop for the stored target's
  `machineId` and `homeEpoch`. `PaneTarget` already has those fields. Require
  both; never substitute the newly read epoch or the request's machine ID.
  Release the pane queue for the hub wait. Do not write a legacy close record
  for the managed route. Never turn persisted `closing` records into Stop or
  infer Stop from terminal absence. Ordinary Close and local Kill retain the
  original path. If status cannot prove non-management, do not fall back.
- [ ] **Guard the old boundary.** Refuse a managed row at the legacy source
  endpoint before IPC or intent mutation. Check the same rule in the intent
  transaction for a race with home change. Keep the old generation and epoch
  checks for eligible legacy requests. Do not remove private callers here.
- [ ] **See green.** Run the same file. Mutants: replay a saved Close as Stop,
  use terminal disappearance as completion, and allow the old endpoint to
  close a managed home.
- [ ] **Commit** as `feat(herdr): route new managed Close to Stop`.

#### Task 18: Prove the packaged pane seam (R21)

**Depends on:** Tasks 13 and 17. No UI assets or native app in this story.

**Files:** Create `packages/herdr/e2e/scenarios/roam-pane-stop.test.ts` and
`packages/herdr/e2e/controls/roam-pane-stop-ci.test.ts`. Modify
`packages/herdr/e2e/fixtures/roam-session-stop.ts`,
`packages/herdr/e2e/README.md`, and `scripts/herdr-e2e.mjs`.

**Interfaces:** Extend `SessionStopFixture` with
`pane(request: PaneServiceRequest): Promise<PaneServiceReply>`. In the fixture
start the packed `panes serve` under the hub's owned core and `core-only`
config. Pass `panes request --json <request>` to the packed Herdr CLI and
parse the reply. Use the same `proof` and `partition` as R20.

- [ ] **Write the failing selector and story.** In `selects R21 without changing defaults`,
  prove explicit selection and one worker as in Task 13. Register
  `storyId("R21")` with `tiers: ["headless"]`. In `packaged pane actions stop and start without a live pane`,
  drive graceful Stop by presentation, verify the stopped row and absence of
  pi, subagents, and detached jobs across two supervisor passes. Use the list
  to Start by ID without a presentation. Check the same transcript and one
  new owner. Exercise Kill now, then Start and partition with the owner live.
  Request Stop with the route down, restore it, and query until confirmation
  without another Stop. Use one new managed Close and reject replay of an
  old record without a home write. Compare status to the CLI cache.

```ts
expect(matrixFor("R21")).toEqual([{ story: "R21", timeout: 5 }]);
expect(storyWorkers(explicitR21)).toBe(1);
expect(defaultIds).toEqual(["R18", "R10", "R11"]);
expect(stoppedWithoutPane).toMatchObject({ sessionId, status: "stopped" });
expect(twoStoppedPasses).toHaveLength(2);
for (const proof of twoStoppedPasses) {
	expect(proof).toMatchObject({ hub: { home: stoppedHome }, box: { home: stoppedHome }, liveOwned: [] });
}
expect(startedProof).toMatchObject({ sessionId, file: originalFile, liveOwnerCount: 1, transcriptPrefixHash });
expect(startedProof.owner).not.toEqual(originalOwner);
expect(afterKill).toMatchObject({ box: { home: { state: "stopped" } }, liveOwned: [] });
expect(whileCut.outcome).toBe("pending");
expect(restoredStatus).toMatchObject({ outcome: "complete", status: "stopped", observedAt: exitCheckAt });
expect(stopMutationsDuringReconnect).toBe(1);
```

- [ ] **See red.** Run `bash "$CTL_RUN" packages/herdr/e2e/controls/roam-pane-stop-ci.test.ts --config packages/herdr/e2e/vitest.config.ts`.
  Expect unknown story `R21` before registration. The packaged assertions
  run only in Linux CI.
- [ ] **Register and wire.** Add only the opt-in ID and one-worker selection.
  Seed only a fixture `PanePresentation` using the observed owner, actual
  revision and home binding; use the existing placement store. The old
  `closing` case seeds that same store, not home or proof rows. Drive all
  actions through the packed socket. Use ledger-owned cleanup. Do not start
  a native app or change the installed app recipe.
- [ ] **See green.** Run the selector file as above. Require packed R21 and
  retained R20 plus the full seam checkpoint on the exact candidate. Mutants:
  remove explicit R21 selection, add it to the default profile, and remove
  its one-worker limit.
- [ ] **Commit** as `test(herdr): prove roaming Stop through the packed pane service`.

## UI handoff

The host supplies `roamSessionAction(request)` and `roamSessions(limit)` on
`PaneServicePorts`. Both use `roam/relocate.sock`. The UI uses
`panes request --json` and the cached `roamSessions` snapshot list. The seam
owns the following shapes. The UI owner owns menu placement, confirmation,
and status visuals.

```ts
type PaneRoamRequest =
	| ({ version: 1; op: "roam-session-action"; operationId: string; sessionId: string;
			action: "stop" | "kill-now" | "start"; machineId: string; homeEpoch: number } &
		({ presentationId: string; expectedRevision: number } |
			{ presentationId?: never; expectedRevision?: never }))
	| { version: 1; op: "roam-session-status"; operationId: string; sessionId: string };
type PaneRoamStatus = "running" | "stopping" | "stopped" | "stop-pending" |
	"starting" | "crash-loop" | "moving" | "owner-unverified";
type PaneRoamOutcome = { version: 1; kind: "roam-session-outcome"; operationId: string;
	sessionId: string; machineId: string | null; homeEpoch: number | null;
	homeState: "running" | "moving" | "stopped" | null;
	outcome: "complete" | "pending" | "refused";
	status: PaneRoamStatus | null; reason: string | null; observedAt: number | null };
type PaneRoamSessionRow = Pick<PaneRoamOutcome, "sessionId" | "status" | "reason" | "observedAt"> &
	{ name: string | null; machineId: string; homeEpoch: number;
		homeState: NonNullable<PaneRoamOutcome["homeState"]> };
```

- A presentation action uses both binding fields. The target session and
  revision must match. A row action uses the observed home and needs no
  presentation or fresh feed. Keep a stopped session reachable by ID even
  when its terminal and presentation are gone.
- `observedAt` is milliseconds since the Unix epoch, not the last contact time.
  Display age for Running and Stopped. `complete` on a status response means
  the cached read succeeded, not that Stop succeeded. A `running` home alone
  is not Running. Only the crash guard emits Crash loop or Owner unverified.
- On a pane homed on another machine, **Stop session** replaces **Close**.
  **Kill now** is a distinct action. Use this confirmation:

  > Stops pi and its subagents and prevents restart. Detached jobs are listed if
  > they are still running.

- While Stop is pending, offer Kill now as an escalation, not Start. Offer
  **Start session** once absence is confirmed and no displaced machine is
  unverified. In Increment 3 also offer it for verified Crash loop. Do not
  offer both Close and Stop session. Do not change ordinary local Kill,
  Hide, or Send back.
- Show the same state and reason as `roam status`, including blockers by ID,
  offline, old-agent, disabled, and displaced-machine reasons. Display
  `waiting-for-move` as waiting, not saved. After a slow action, read status
  instead of sending a new mutation. Ignore late replies for a superseded
  home. Treat null fields as unknown. Do not use a partial snapshot to infer
  that a missing row or owner is gone.
- The UI tests must exercise the single menu item for each effect and exact
  copy, a pending/offline Stop with no Start, a blocker or unverified
  displacement, a successful status read that is still pending, and Start
  from a retained row with no pane. Cover both kind/revision mismatch and
  an older reply arriving after a newer home. Assert that hiding or closing
  the view never marks Stop complete and that ordinary local Kill still uses
  its generation check. R21 proves the protocol, not the visuals.

## Live check after Core merges

Run this only in a separately approved window, on an enrolled test box and
its Mac hub, with a disposable managed session and no unrelated work on the
route. Install matching Core agent, supervisor, and hub builds from the
verified Core release. Capture the initial home and membership, transcript
ID and prefix hash, checkout, ID and file leases, owner generation, and
owned subagent and job identities. Keep the approved way to restore the route.

1. Run `spider roam stop <session>` on the Mac. Compare both durable rows for
   the next stopped epoch on the same machine and the same `moveId`. Require
   explicit confirmation, check independent absence, and observe two more
   supervisor checks with no owner or owned work. Restart the box supervisor
   with the stopped row intact. It must not launch pi.
2. Run `spider roam start <session>`. Require one new admitted generation at
   the next running epoch, the same transcript ID and prefix, and the same
   files and checkout. Check `spider roam status --json` for actual evidence
   time as well as home state.
3. Try `spider roam stop <session> --now` with a known subagent and a
   fixture-owned detached job that can exit independently. Verify pi and
   subagent exit and run settlement without the two grace waits. Verify the
   job survives and is named as pending. Do not cancel it from an unrelated
   session. Wait for its verified exit, then check Stopped and no restart.
4. Start once more, then cut only the approved test route while pi stays
   live. Request Stop. Verify exit `3`, saved Mac row, pending reason, and
   the still-running old replica. Restore the route even if the check fails.
   Do not send another mutation. Wait for the box to apply the row and for
   the Mac to save exit proof. Verify no remaining owner, child, or job.
5. Save exact epochs, proof times, process and job results, and cleanup.
   If there are two owners, no proof of absence, or an unexplained restart,
   stop rollout and keep the evidence. Do not downgrade the Mac writer to a
   version whose relocate or force can silently make a stopped home running.

## Increment 3. Crash guard (outline)

- Add box-local restart history keyed by running epoch. Count a launch once
  if the owner did not stay live for 60 seconds. Back off at least 10, 20, 40,
  and 80 seconds; suppress the fifth retry. Five minutes with the same
  verified owner resets the count before suppression. Persist across
  supervisor restart and reboot without classifying the exit.
- Check the guard at launch and admission. Expose running observations and
  Crash loop or Owner unverified. Report support only for a supervisor marker
  verified against its live PID, birth, and boot identity. Core Stop does not
  require the marker.
- Explicit Start from suppressed running uses the Core Start ordering and
  grants a newer running epoch. Relocation, undo, or force can also supply a
  newer running epoch. Same-home relocate does not clear suppression. Check
  the delays, reset, reboot, marker, and lack of a new epoch with a fake clock.

## Increment 4. Later (outline)

- Define proof for settling a failed moving home. Compare retained verified
  copies with the final capture and account for pending away-home fences.
  Until then refuse Stop on an unsettled moving row.
- Record birth and boot identity in local detached-job manifests before
  allowing Stop to end those jobs. Keep old ambiguous manifests pending.
- Block new owned work during shutdown. Test intake and shutdown races before
  making stronger guarantees about work accepted just before Stop.

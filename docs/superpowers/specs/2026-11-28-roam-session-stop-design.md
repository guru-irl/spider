# Stop and start roaming sessions

Design, 2026-11-28.

Closing pi on a box does not stop a roaming session. If the box still sees a
local `running` home, its supervisor can start pi again. Stop changes the home
so the session stays down on its current machine. The Mac saves the decision.
The home machine enforces it and confirms what actually stopped.

## Goals

- Stop a managed session without moving it. Kill now skips graceful shutdown
  and also prevents restart.
- Save Stop even when an enrolled box is unreachable. Distinguish a saved
  request from a confirmed stop.
- Start a stopped session only on explicit request. Preserve its session ID,
  transcript, and checkout. Stop retrying when pi is in a crash loop.

Not in scope: changing Kill for a local non-roaming session, making `/quit` a
persistent stop, changing how panes look, or adding a run lease or an offline
home writer. Hide and Send back change the view, not the home. Stop does not
move files or promise to copy the final transcript to the Mac.

## Authority and observed state

The Mac is the only writer of `session_homes`. Use the existing `running`,
`moving`, and `stopped` states and the existing compare-and-swap that advances
one epoch. Only an exact `running` home on the named machine permits pi to run.
A box acts on its durable replica. It can keep running under an older replica
while it cannot reach the Mac. The session ID lock still prevents two local
owners. See `packages/roam/src/relocate/home.ts:121-135` and
`packages/db-core/src/roam/apply.ts:139-154`.

A home identifies the session, machine, and epoch. The owner generation
identifies one pi process. Use the ID-lock identity throughout Stop: PID,
process birth identity, and boot ID. Do not use the Herdr feed generation
for Stop fencing. See `packages/herdr/src/sessions/id-lock.ts:238`.

The Mac stores a private request record with the operation ID, expected home,
committed home, action, Stop mode, and pending or confirmed result. The record
also tracks any displaced machine whose exit is unverified. Add a callback to
`compareAndSwap` so the hub writes the request record inside the transaction
that updates the home. A conflict writes neither the row nor the record. See
`packages/roam/src/relocate/home.ts:121-135` and
`packages/db-core/src/roam/local-state.ts:37-45`.

A `stopped` home created by relocation or recovery also needs confirmation
for its own epoch. Store exit evidence in local roaming state. The crash guard,
when installed, keeps its own local restart history. Home replication does not
change. A pane journal is never proof of a stop.

| Status | Authoritative home and Mac request | What the home machine has shown |
| --- | --- | --- |
| Running | `running` at the reported epoch. | An observation verified a live, admitted owner for that epoch. Show the age of the observation. |
| Stopping | `stopped` at the requested epoch. Confirmation is pending. | An observation within the last 10 seconds shows shutdown or exit checks in progress. |
| Stopped | `stopped` at the reported epoch. The Mac saved the matching confirmation. No displaced machine is unverified. | The stopped row is durable. Pi, its subagents, and its detached jobs are gone. Show the age of the last observation. |
| Stop pending | `stopped` at the requested epoch, but exit is not fully confirmed. | A check found a blocker, the observation is stale or missing, or the home machine is unreachable or cannot enforce the protocol. Show the reason, including job IDs or any unverified displaced machine. |
| Starting | `running` at the requested epoch, with no confirmed owner yet. A Start record, if any, is pending. | The home machine is waiting for launch or admission. A reachable box may also be waiting to retry after an exit. |
| Crash loop | `running` at the reported epoch. No Mac home change. | The box has suppressed retries and reports the failure and attempt count. |

A `moving` row shows **Moving**, including a failed move that has not settled.
A Stop waiting for the operation lock has not saved a stop yet. A known
blocker takes precedence over **Stopping**. The 10-second window distinguishes
active shutdown from a pending request. It does not expire saved confirmation.

The crash guard adds **Crash loop** and **Owner unverified**. For a `running`
home, a matching crash-loop observation takes precedence over **Starting**.
Without current owner evidence or a known start in progress, show **Owner
unverified** and the last known state and time. Before that increment, report
the `running` home state and any verified Start result separately. The home
row alone never proves liveness. A closed pane or a sent signal never proves
exit.

## Stop and Kill now

1. The Mac hub queues the request on the same per-session operation lock as
   `relocate`, `set-home --force`, and Start. Keep accepted requests in order
   for that session. Stop waits for a move that is already in progress, then
   reads the home again. A Stop accepted against the source or `moving` row of
   that move applies to its result, including an undo. It does not follow an
   unrelated home change. See the failed-move rule below if the result is
   still `moving`.
2. For a settled home, write `stopped` at the next epoch on the same machine.
   Keep the home's `moveId`. Save the request before contacting the box. A
   repeat on the current stopped epoch reuses its result or continues
   confirmation. Kill now upgrades a pending graceful Stop by setting hard
   mode in the Mac record and resending `ensure-stopped`. It does not write
   another epoch. A matching graceful exit confirmation still counts. Kill
   now does nothing to a confirmed stop, and a later graceful request never
   replaces an outstanding hard request.
3. Ask the existing sync service to publish to the named box immediately. The
   box does not need a separate shutdown request to begin enforcing the row.
   The private `ensure-stopped` call queues the mode for the next local check.
   Both paths use the same local Stop routine. The existing remote publish
   path syncs and reads back the exact row
   (`packages/roam/src/relocate/adapters.ts:118-121`). If the home is on the
   Mac, the hub runs Stop locally. Only the box runs the restart loop
   (`packages/roam/src/relocate/runtime.ts:236-265`).
4. Return **Stopped** only when the Mac records matching exit confirmation
   and has no unverified displaced machine. If the box cannot be reached,
   leave the saved row in place and show:

   > Stop pending: the box is unreachable and may still be running

Keep network waits outside the Mac operation lock once the home is committed.
The hub checks the epoch again under the lock before saving a result. The
caller waits up to the readiness budget and gets the last known reason if it
runs out of time. A caller leaving does not cancel an accepted request or roll
back a commit. While a request waits for a move, the hub reports
`waiting-for-move`, not a durable Stop. If the hub exits before commit, the
waiting request is lost. Check status and issue a new request if needed.

A replay of an admitted operation ID can only report or reconcile the original
operation. It never applies that action to a later epoch. Reject reuse with
different inputs. Even after an old result is removed, an old home expectation
cannot authorize a new operation.

### The Mac sends the Stop mode

Stop and Kill now never signal before the home machine durably applies the
stopped row. The mode survives a partition or Mac restart in the private
request record. After contact for a pending stop, the hub sends `ensure-stopped`
with the exact home and saved mode. Boxes have no outbound peers
(`packages/roam/src/config.ts:169-172`).

The supervisor uses graceful mode if it sees the stopped row before the
control call arrives. This can happen if the hub exits after publication.
Restart stays disarmed. If hard mode is already queued, the box skips both
grace periods. If graceful shutdown has begun, the next effect or attempt
uses hard mode for verified survivors. Neither a late graceful request nor
an old observation can downgrade hard mode. The Mac confirms exit, not
which signal ended the owner.

### The box confirms exit, not signal delivery

The supervisor reads the home before launch. The existing supervisor already
stops non-running homes instead of starting them
(`packages/roam/src/relocate/supervisor.ts:45-52`). Route a local `stopped` home
through the Stop routine on its next pass, without waiting for the Mac. Do not
require a live Herdr view or a valid checkout to begin checking for a stop.

- Serialize shutdown, launch, and membership changes with the local session
  state lock. Before each shutdown effect, recheck the exact stopped home and
  the target identity. Check the ID lock, file lease, and terminal identity
  where applicable. Capture the verified process tree before asking pi to
  exit, and keep the identities for work that can outlive pi across attempts.
  Once the owner has exited, require no replacement owner and recheck each
  surviving target. A PID without matching birth and boot identity or a
  process group number alone does not authorize a signal.
- Stop asks pi first. Give it up to 5 seconds to shut down through
  `session-shutdown`. The socket accepts only `moving` today
  (`packages/host/src/roam/relocate-control.ts:17-26`). Add a separate
  stopped-home request with the stop epoch and target owner generation.
  Pi checks both against the local row and its own admission before calling
  `context.shutdown()`. The reply acknowledges the request, not exit.
  Keep the moving-home check and use the signal fallback if pi is too old.
- Then send `SIGTERM` to the verified owner and verified survivors in its
  process tree, excluding detached jobs. Give them 5 seconds before sending
  `SIGKILL` to verified survivors. Kill now goes straight to `SIGKILL`.
  Recheck after each wait and before each signal. Extend `LocalIO.signal`
  to take the signal. Relocation keeps its current order and `SIGTERM`
  behavior (`packages/roam/src/relocate/local.ts:136,263-274`).

Use a separate absence check for Stop, not relocation's checkout writer
check. Relocation also checks for other pi processes in the checkout and
counts active run rows without a liveness check
(`packages/roam/src/relocate/local.ts:128,306`,
`packages/roam/src/relocate/local-writers.ts:14-23`). Stop checks this session's
ID lock, live labelled pi terminals, and the process tree captured before
shutdown. It does not wait on another session's pi or run rows. If the box
cannot read its records for this session, it can still stop a verified owner,
but it cannot confirm the stop.

After the owner exits, settle this session's run rows using the orphan reaper
logic. Add an exact `session_id` filter to its local-origin run query. The
reaper skips a live `host_pid`, checks the child's PID and birth identity
when `pid_start_time` is present, and cancels the orphaned run
(`packages/subagents/src/reaper.ts:25-66`,
`packages/subagents/src/process-identity.ts:31-39`). For Stop, use the verified
session owner instead of a bare `host_pid`. A recycled host PID does not
make another pi the owner. Use the stricter signal checks above, not the
reaper's default group signal or legacy command-only match. Prove the child
is gone independently of the row update. Unknown identities, surviving
children, and failed checks stay pending.

Do not record a separate launch attempt for Stop. Launch holds the same
session state lock through `io.launch`, including the exact home reread just
before spawn (`packages/roam/src/relocate/local.ts:434-436,478-489`). Even when
the launch reply is lost, the launch command supplies the session, machine,
and epoch labels (`packages/roam/src/relocate/local.ts:185-190`,
`packages/roam/src/launcher.ts:136-141`). The stop routine already lists by
`spider.session` and checks those labels
(`packages/roam/src/relocate/local.ts:165-183,227-232`). Admission refuses the
stopped row and rereads the home before admitting work
(`packages/host/src/roam/admission.ts:217-236`). A missing reply alone never
blocks Stop. If a late terminal appears, check and clear it on the next pass.
Bind admission of a managed launch to its launch epoch, using the existing
expected-epoch check. The production default is currently null
(`packages/host/src/roam/admission.ts:223-225,630`). A launch from an older
epoch must exit without admission if it arrives after Start.

Observe detached jobs for this session, but do not signal them in the core
increment. Check local manifests and the session's Herdr job journals,
including jobs owned through its subagents. The local manifest has PIDs but
no birth or boot identity (`packages/context/src/background-job.ts:59-76`).
The existing relocation check uses manifest and receipt PIDs to detect
possible survivors (`packages/roam/src/relocate/local-writers.ts:49-65`). For
Herdr jobs, use the session and child journals used by the existing cancel
path (`packages/host/src/herdr/kill-job.ts:48-54`). Check job exit evidence
without cancelling. A closed terminal, a cancelled run row, or a request to
cancel a job is not proof that the job is gone.

List each running or unverified detached job by ID as a pending blocker. For
an owned Herdr job, show the existing cancel command `spider kill id:"<job-id>"`
and say that it runs from the owning session. The command consults the Herdr
job journal and cannot cancel jobs known only through local manifests
([background jobs and timeouts](../../guide/herdr.md#background-jobs-and-timeouts),
`docs/guide/herdr.md:387`, `packages/host/src/herdr/kill-job.ts:17-54`). For
manifest-only jobs, list the ID without a cancel command. If the owning
session cannot issue the command, do not imply that another session can.
Never show plain **Stopped** while a job is running or exit is unverified.

Once absence is proved and the stopped row still matches, leave local
membership frozen at the stopped epoch and save exit confirmation. Bound an
attempt by the readiness budget (60 seconds by default,
`packages/roam/src/contracts.ts:51`) and retry on later passes. After local
confirmation for the current home and boot, check only the ID lock and labelled
terminals on each pass. Today's supervisor calls the full stop check on every
pass for non-running homes (`packages/roam/src/relocate/supervisor.ts:45-52`,
`packages/roam/src/relocate/local.ts:306,527-537`). If either short check finds
new evidence or cannot prove absence, invalidate the local confirmation and
repeat the full check. Do not reopen admission.

## Start and crash loops

Start names the machine and epoch that the caller saw. Under the Mac operation
lock, refuse a changed home even if it is now stopped. If Stop is still
pending, refuse Start and ask the caller to retry after Stop is confirmed.
Do not skip an undelivered shutdown. Before writing a running epoch, verify
the placement, control support, and that no prior owner can run. If that
check is unavailable, leave the home unchanged. Start on an already authorized
running home checks the existing owner or continues startup for that epoch
without a new grant, unless the crash guard reports suppression.

Move the stopped same-home resume branch out of
`packages/roam/src/relocate/relocate.ts:199-219` into Start. Use this order:

1. Compare-and-swap to the next `running` epoch on the same machine and save
   the pending Start. Keep `moveId`. The running home CAS requires it away
   from the Mac, and fence matching compares it
   (`packages/roam/src/relocate/home.ts:66-68,136-162`).
2. Publish the exact running row and verify it on the home machine.
3. Activate membership. In the same change, delete the stopped-successor
   clause in `packages/roam/src/relocate/local.ts:512`.
4. Start pi under the local ID lock and file-lease checks for the exact
   transcript, checkout, and epoch.
5. Confirm with `confirm(home, placement, true)`. The exact check verifies
   the live ID-lock owner and launch against that home and placement
   (`packages/roam/src/relocate/local.ts:459-475`).

The box supervisor can finish a pending Start without the original caller.
For a Mac home, the hub uses the existing local launch path for the explicit
request, not an automatic restart service. If confirmation is late, report
**Starting**. A retry checks the same epoch and never starts a second owner.
An older Start or shutdown cannot authorize work under a newer home.

### Crash guard

The box keeps a private crash record with the running epoch, last launch
identity, consecutive failure count, next attempt time, and suppression flag.
Count a launch once if its owner did not stay live for 60 seconds. Do not
classify the exit as clean, abnormal, or due to reboot. The terminal reader
discards exit details today (`packages/roam/src/relocate/local.ts:35-40`).
With no verified owner, wait at least 10, 20, 40, and 80 seconds after the
first four failures. On the fifth, stop retrying and report **Crash loop** with
the last reason. Five minutes with the same verified owner clears the failure
count before suppression. The guard survives supervisor restart and reboot.

Check the guard before launch and admission. Start from a verified crash loop
uses the same sequence as Start from `stopped`. Clear suppression when the
box sees a newer `running` epoch. A Start supplies that epoch. Relocation,
undo, and force can also write a newer epoch for a session that was already
running. Same-home relocation does not write a running epoch. A stopped move
never launches at the destination.

## Relocation and forced recovery

A healthy move still stops the source, copies the transcript and checkout, and
then commits the destination home. If the source was stopped, verify that stop
before copying. Preserve the plan's prior state at destination commit, undo,
and rollback. These paths currently write `running`
(`packages/roam/src/relocate/relocate.ts:20-35,280-285`). For a stopped
destination, install with frozen membership at the new epoch, publish
`stopped`, and confirm absence. Do not launch or return a terminal as proof of
completion. Same-home `relocate` of a stopped session only reports or
reconciles the stop. Accept frozen membership at the stopped epoch in source
checks. Remove the seed reactivation of a frozen stopped source
(`packages/roam/src/relocate/remote.ts:116-125`).

If a failed move leaves `moving`, Stop refuses without changing the home or
signalling: "Finish or undo the move with `spider roam relocate`, then stop."
Neither machine may run from that row, but a source that missed it may still
run from an older replica. A Stop queued behind a move that is still in
progress follows that move's result. If the result is still `moving`, use
the same refusal.

`set-home --force` keeps a stopped home stopped. Force from an unresolved
`moving` home also settles as stopped. Change the `running` write and
activation in `packages/roam/src/relocate/set-home.ts:37-54` for both the hub and recovery
without the hub (`packages/roam/src/relocate/runtime.ts:164-166,209-218`).
Retain the destination copy check, typed confirmation, and warning about the
old source and unsynced work. A forced stopped placement uses frozen membership
and never activates or starts pi. A stopped placement does not publish a new
away-home fence or clear an existing one. The running CAS for Start runs the
existing fence checks and publishes the fence for an away home
(`packages/roam/src/relocate/home.ts:136-162`). Keep the existing Mac source
writer check (`packages/roam/src/relocate/runtime.ts:128-132`) separate from
fence publication. To run a stopped copy again, help points to Start, not
same-home `relocate`.

Force does not prove exit on a displaced machine. If force moves a home from
A to B without a matching Stop confirmation from A, save A in the Mac
request record in the same transaction as the force CAS. Keep any earlier
unverified displacement. Once B confirms exit, show "Stopped on B. A may
still be running." List every unverified machine if there is more than one.
Keep the outcome pending until a `session-observation` from A reports the
newer row and confirms that the old owner and its work are gone. A sync
receipt from A is not that observation. Start remains unavailable while any
displaced machine is unverified. The operator is still responsible for
keeping the displaced copy down.

## Confirmation and reconnect

Use `roam agent --v0` for `ensure-stopped` and read-only
`session-observation`. `ensure-stopped` identifies the enrolled hub and
requires the exact stopped home on the named machine. Queue or upgrade a
box-local request for that home and mode, then return pending at once. Do not
wait for the session state lock or a shutdown attempt before replying. The
supervisor takes the lock and rereads the home before acting. Discard a queued
request for a superseded home. `callV0` uses `controlMs`, which defaults to the
same 60 seconds as `readyMs` (`packages/roam/src/relocate/remote.ts:27-28`,
`packages/roam/src/contracts.ts:45-51`).

The Mac reads the result with `session-observation`, naming the session and
expected home. Neither request carries a PID chosen by the Mac. In core,
read Stop observations from the home and any displaced machine. A displaced
machine's supervisor runs the same Stop check against the exact foreign
`stopped` row once it applies that row. The row permits it to stop a verified
old local owner, never to launch. It records the absence of that owner and
its work on the displaced machine, not on the new home. If the Mac was the
displaced machine, the hub runs that check locally. The crash guard increment
adds observations for running homes.

Observations report the observed home and boot ID, and give an exit
confirmation, verified owner, crash record, or pending reason, as applicable.
A stop confirmation identifies the session, observing machine, epoch, check
time, and owner generation if there was one. Report a different or missing
replica explicitly. The Mac saves proof only for the current home and its
expected observers. Discard results for a superseded epoch. A sync receipt
is not exit confirmation. Recheck saved stop observations on contact. If a
newer matching observation contradicts confirmation, show the new pending
reason. Show observation age, not time since the last contact.

On hub startup, resume checking committed requests. Use the same local Stop
routine for pending Mac stops. After an immediate targeted sync, use the
existing peer retry schedule. Failed contacts retry after 30, 60, and then
120 seconds. Healthy sync defaults to 120 seconds
(`packages/roam/src/sync.ts:450`, `packages/roam/src/config.ts:186`).
After peer sync, send the saved mode to a pending home and check the
observation even if an unrelated store did not sync. Read the observation
again every 10 seconds while a reached box has pending confirmation. Coalesce
in-flight work. Do not retry sync from inside its own completion callback.
The box supervisor checks at startup and on each pass. Its 10-second cadence
is not an outage bound (`packages/roam/src/relocate/supervisor.ts:3,35-45,73-93`).

A reboot does not erase the stopped row or the crash guard. Discard PID
observations from a prior boot. Check the current lock, terminal, and owned
work before issuing a new confirmation. If the box reboots before it receives
Stop, its old running replica can still restart pi. The Mac keeps Stop pending
until the box catches up. A saved confirmation stays valid for the matching
stopped home unless new evidence contradicts it. A box that no longer has the
row needs publication and verification again.

Extend the v0 `hello` reply (`packages/roam/src/relocate/remote.ts:100`)
with `sessionStopVersion: 1` for an agent that supports Stop controls and
observations. Older v0 boxes refuse to launch from a stopped row and can
try the old generic stop. They cannot confirm through the new protocol
(`packages/roam/src/relocate/supervisor.ts:45-52`,
`packages/roam/src/relocate/local.ts:263-274,527-537`). Publish the compatible
row anyway. For a reachable older agent, show **Stop pending: update roaming
on the box. It may still be running.** A failed connection is unreachable,
not a version diagnosis. If a capable agent has no matching supervisor
observation, keep the request pending without inferring an old supervisor.
If replication is disabled on the box, show that reason and keep the request
pending. Never send a control request to a revoked peer or fall back to a
legacy agent.

The crash guard adds a supervisor protocol marker. Verify it against the
running supervisor's PID, birth, and boot identity before reporting guard
support. The agent version alone does not prove that the guard is active.
Do not require the marker for core Stop confirmation.

## CLI and Herdr

- `spider roam stop <session> [--now]` and `spider roam start <session>` run
  on the Mac through the running, enabled v0 hub. Resolve one existing managed
  session by the usual ID or name rules. Do not adopt an ordinary or legacy
  session. Extend `roam/relocate.sock` with `stop`, `start`, and `session-status`.
  Mutations send `{ operationId, sessionId, machineId, homeEpoch }` in the
  existing request envelope. `stop` also has `mode: graceful | hard`. The hub
  checks the observed machine and epoch under the operation lock, with the
  in-progress move exception above. Keep the existing socket ownership and
  size checks (`packages/roam/src/relocate/service.ts:98,119-132,157-171`).
  `session-status` reads the current home and saved results by session ID.
  The Herdr increment adds a bounded list request with `limit`. Validate the
  limit, cap it at a server maximum, and enforce the socket reply size.
  Include stopped sessions in the list even without an active terminal.
- `spider roam status` remains a cached read (`packages/roam/src/cli.ts:661-671`).
  Text and `--json` show the home machine, home state, epoch, observed status
  and reason, and last observation time. Text includes the observation age
  for **Running** and **Stopped**. Action replies also give the operation ID.
  Exit 0 means the requested stop or running owner is confirmed. Exit 3
  means waiting, pending, or unknown after a lost reply. Exit 1 means refused,
  and 2 means invalid arguments.
  A lost reply does not earn a "saved" message. Check status before retrying.
- Public `stop` replaces the legacy intent command, including in help. Remove
  public `resume`. Do not route either command to the legacy service. At the
  same cut, change the repair text in
  `packages/roam/src/participant-runtime.ts:123,126`,
  `packages/roam/src/production-controls.ts:125`,
  `packages/roam/src/local-diagnostics.ts:500`, and
  `packages/host/src/roam/admission.ts:78-81`. Point stopped v0 sessions to
  `spider roam start` and legacy sessions to the
  [legacy upgrade procedure](../../guide/roaming-upgrade.md#settle-old-work-only-after-approval).
  Update `packages/roam/src/__tests__/pending-launch-controls.test.ts:132-176`,
  `packages/roam/src/__tests__/pending-launch-repair.test.ts:750-791`, and
  `packages/host/src/__tests__/roam-admission.test.ts:746-751` at the cut.
  Keep private legacy operations only until their remaining callers are migrated.

For a session homed on another machine, **Stop session** replaces **Close**
in the pane menu. **Kill now** is a separate action. Use this confirmation:

> Stops pi and its subagents and prevents restart. Detached jobs are listed if
> they are still running.

While Stop is pending, offer Kill now as an escalation, not Start. Offer
**Start session** after confirmation and, in the crash guard increment, when
the box reports a crash loop. Show the same state and reason as `roam status`.
Keep the session addressable by ID after its terminal disappears so Start
needs no live pane or owner feed.

The UI owner builds the menu, confirmation, and status visuals. Add
`roamSessionAction(request)` and `roamSessions(limit)` to `PaneServicePorts`
(`packages/herdr/src/panes/service.ts:21`). Implement both in host
(`packages/host/src/herdr/pane-runtime.ts:307-315`) over `roam/relocate.sock`
(`packages/roam/src/relocate/service.ts:39-44`). The first port forwards Stop
and Start and reads one cached status. The second uses the bounded list form
of `session-status`. Add these cases to `PaneServiceRequest` and
`PaneServiceReply` (`packages/herdr/src/panes/types.ts:65-83`) for
`panes request` (`packages/herdr/src/setup/cli.ts:44`):

- An action sends `{ version: 1, op: "roam-session-action", operationId,
  sessionId, action, machineId, homeEpoch }`. `action` is `stop`, `kill-now`,
  or `start`. An action from a presentation also sends `presentationId` and
  `expectedRevision`. The pane service requires the presentation's
  `target.sessionId` to equal `sessionId` and its revision to equal
  `expectedRevision`. It forwards the corresponding v0 hub request, never a
  terminal kill. From a session row, bind to the observed home instead. A
  fresh box feed is not required to record Stop.
- A status read sends `{ version: 1, op: "roam-session-status", operationId,
  sessionId }` and queries the Mac's cached session status. Both replies use
  `{ version: 1, kind: "roam-session-outcome", operationId, sessionId,
  machineId, homeEpoch, homeState, outcome, status, reason, observedAt }`.
  `outcome` is `complete`, `pending`, or `refused`. `status` is `running`,
  `stopping`, `stopped`, `stop-pending`, `starting`, `crash-loop`, `moving`,
  or `owner-unverified`. Only the crash guard emits `crash-loop` or
  `owner-unverified`. `observedAt` is milliseconds since the Unix epoch.
  Home and observation fields may be null if unknown. A `running` home
  without a verified observation is not `status: "running"`. A status read
  uses `complete` for a successful read, not a stop. Waiting for the move returns
  `outcome: "pending"` and `reason: "waiting-for-move"`. A slow action also
  returns pending. Read status instead of sending a new mutation. Ignore
  late replies that refer to a superseded home.
- The pane snapshot adds a bounded `roamSessions` list. Each entry has
  `sessionId`, `name`, `machineId`, `homeEpoch`, `homeState`, `status`,
  `reason`, and `observedAt` from the same cached view. Include stopped
  sessions without a live presentation. Do not expose process evidence or
  file paths to the menu.

Route a new confirmed Close request on a managed session to graceful Stop
through the same port. The pane menu does not offer both actions. Do not
replay old pane-close records as new Stop requests. A missing terminal
cannot complete a managed Stop. If the v0 hub is unavailable, explain the
refusal instead of calling `close-session`. The legacy close endpoint refuses
a managed home. Leave ordinary local Kill and its generation check unchanged.

## Testing

### Core

- Unit: check the 10-second **Stopping** window, observation age on **Stopped**,
  exact epochs and owner identities, and duplicate requests. A CAS conflict or
  a failed request write leaves neither change. Polling does not renew a
  stale observation. Replies from an old epoch cannot confirm Stop or
  authorize Start.
- Integration: use fixture stores and the v0 control and sync paths. Lose
  replies before and after commit. Race a delayed shutdown against Start and
  a delayed Start against a later Stop. No signal precedes the durable stopped
  row. Unknown identities stay pending. On reconnect, deliver hard mode before
  the next check and verify that it skips both grace periods. If the hub dies
  after publishing the row, the box still shuts down in graceful mode. Kill now
  on a pending Stop updates the mode and completes without a second epoch.
- Kill now with a live subagent confirms after both processes exit and the run
  row settles. Stop with a second session in the same checkout confirms and
  leaves that session and its run rows alone.
- With a live detached job, Stop and Kill now leave it running and report its
  ID as pending. The existing cancel command appears only for eligible jobs.
  Verify confirmation after job exit. Include a manifest-only job and another
  session's job to test ownership and cancellation guidance.
- Lose a launch reply. Stop does not wait on the reply. A late labelled
  terminal cannot admit under the stopped row or the next Start's epoch.
  Stop clears a late terminal that appears while the home remains stopped and
  confirms once absence is verified. Also cover a lost reply with no terminal.
  After confirmation, later passes use the short check. A late live terminal
  invalidates the saved result and triggers another full check.
- Queue Stop behind a move that completes and one that undoes. Each stops the
  settled home. A failed move left `moving` refuses with the repair text. Check
  that stopped moves, undo, rollback, and same-home `relocate` never launch.
  Force from `moving` settles as stopped. Stop and Start keep `moveId`. Start
  publishes before activating, confirms the exact owner, and applies the
  running home's fence rules. A stopped force does not publish an away fence.
- Request Stop on unreachable `a.invalid`, then force the stopped home to
  `b.invalid`. After B confirms, the outcome must still be pending and name A
  as possibly running. A sync receipt, an observation of A's old row, and a
  newer row with an unverified owner do not clear A. The exact newer row and
  confirmed absence on A clear the warning. Start is refused while A is
  unverified. Also cover force to the Mac when the hub is disabled.
- Reboot the box with the stopped row in place and verify that it does not
  launch. Distinguish an older agent from an offline box. After the public
  command cut, check that legacy repairs direct users to the upgrade procedure
  and v0 repairs to Start. Neither public verb reaches the legacy socket.

### Herdr

- Check presentation revision and session binding, the bounded status list
  (including stopped sessions without a pane), and pending replies including
  `waiting-for-move`. A new managed Close records Stop, and replaying an old
  Close does not. Ordinary local Kill keeps its generation check.
- Add a packaged Linux headless story with a fixture such as `box.invalid`.
  Drive the pane service. Verify the stopped row and absence of pi, subagents,
  and detached jobs across at least two supervisor passes. Start the same
  transcript with one new owner, exercise Kill now, and check that it stays
  down. Start again, cut the route to a live owner, and request Stop. See
  pending while cut off. Restore the route and observe confirmation without
  another Stop. Keep R04 hosting recovery, R10 admission, and R18 relocation
  checks.

### Crash guard and live check

- With a fake clock, count short launches, apply the four delays, and suppress
  the fifth retry. Verify that suppression survives supervisor restart and
  reboot, clears on a newer running epoch, and is not reset by same-home
  `relocate`. Check the five-minute healthy reset and the running-home statuses.
  An agent version without a matching live supervisor marker cannot report
  guard support.
- After the automated checks, repeat Stop, Kill now, Start, and reconnect on
  real machines with a test session. Check processes and owned work, not just
  panes. Restart the box supervisor with the stopped row in place and verify
  that only explicit Start brings the session back.

## Increments and rollout

1. **Core.** Ship CLI `stop`, `stop --now`, `start`, and `status`, the hub socket
   kinds, and the private request record with the CAS hook. Add
   `ensure-stopped`, Stop-scoped absence checks and observations, stopped-home
   shutdown on pi's socket, and `SIGKILL` escalation. Move same-home resume
   into Start. Relocate, force, and same-home relocate keep stopped homes
   stopped. Report detached jobs without signalling them. Replace public
   `stop`, remove public `resume`, and rewrite the repair text and tests at
   the same cut. Upgrade the box agent and supervisor code for enforcement.
   Do not downgrade the Mac writer to a release whose relocate or force can
   change a stopped home to running.
2. **Herdr.** Add the two host ports, the bounded list, managed Close routing,
   and the pane actions. The UI owner builds the menu and status visuals
   against those contracts. Land this increment before old-path step 4B.
3. **Crash guard.** Add the box-local guard, `session-observation` for running
   homes, **Crash loop** and **Owner unverified**, and the supervisor protocol
   marker. Core Stop does not depend on the marker.
4. **Later.** Define evidence rules to settle a failed `moving` home. Compare
   verified retained copies with the final capture and account for any
   pending away-home fence. Record process birth and boot identity in local
   detached-job manifests so a later Stop can verify and end those jobs.
   Defer blocking new owned work during shutdown to this increment as well.

Old-path steps 3D and 3E leave pane stop behavior alone and retain legacy
`stop` and `resume` until the core cut. Keep the v0 shutdown socket and home
checks through transfer cleanup in step 4A. Step 4B waits for core Stop and the
managed pane route. It removes the legacy pane stop caller after the other
host-admission migrations. Keep early v0 admission, shutdown, generation, and
file-lease checks, plus refusal for old foreign or frozen homes and missing
or cloned stores. Step 4C removes private legacy stop and resume with their
last callers.

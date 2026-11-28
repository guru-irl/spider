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
owners. See `packages/roam/src/relocate/home.ts` and
`packages/db-core/src/roam/apply.ts`.

A home identifies the session, machine, and epoch. An owner generation
identifies one admission of pi, not a home. Use the existing Herdr generation
when available. For an owner without a feed, bind the shutdown socket to the
admitted ID-lock identity: PID, process birth identity, and boot ID. Check those
identities even when the owner has a Herdr generation.

The Mac stores a private request record with the operation ID, expected home,
committed home, action, and pending or confirmed result. Write the intent and
home change in one transaction using `packages/db-core/src/roam/local-state.ts`.
A `stopped` home created by relocation or recovery also needs confirmation
for its own epoch. The box stores shutdown progress, exit evidence, and
restart history in its own local roaming state. No new home column or
replicated table is needed. A pane journal is never proof of a stop.

| Status | Authoritative home and Mac request | What the home machine has shown |
| --- | --- | --- |
| Running | `running` at the reported epoch. A Start record, if present, is confirmed. | A live, admitted owner for that epoch. Show the age of the last observation. |
| Stopping | `stopped` at the requested epoch. Confirmation is pending. | The home machine has the exact row and is shutting down or checking for surviving work. |
| Stopped | `stopped` at the reported epoch. The Mac saved the matching confirmation. | The stopped row is durable, no launch remains in flight, and pi and its owned work are gone. |
| Stop pending | `stopped` at the requested epoch, with no matching confirmation. | The home machine is unreachable, has not applied the row, cannot enforce the protocol, or cannot prove exit. Show the reason. |
| Starting | `running` at the requested epoch, with no confirmed owner yet. A Start record, if any, is pending. | The home machine is waiting for launch or admission. A reachable box may also be waiting to retry after an exit. |
| Crash loop | `running` at the reported epoch. No Mac home change. | The box has suppressed retries and reports the failure and attempt count. |

A `moving` row shows **Moving**, including a failed move that has not settled.
A Stop waiting for the operation lock has not saved a stop yet. For a `running`
home, a matching crash-loop observation takes precedence over **Starting**.
Without current owner evidence or a known start in progress, show **Owner
unverified** and the last known state and time. The home row alone never
proves liveness. A closed pane or a sent signal never proves exit.

## Stop and Kill now

1. The Mac hub queues the request on the same per-session operation lock as
   `relocate`, `set-home --force`, and Start. Keep accepted requests in order
   for that session. Stop waits for a move that is already in progress, then
   reads the home again. A Stop accepted against the source or `moving` row of
   that move applies to its result, including an undo. It does not follow an
   unrelated home change. See the failed-move rule below if the result is
   still `moving`.
2. For a settled home, write `stopped` at the next epoch on the same machine.
   Save the request before contacting the box. A repeat on the current stopped
   epoch reuses its result or continues confirmation. Kill now upgrades an
   unconfirmed graceful Stop by writing a newer stopped epoch with hard mode.
   It does nothing to a confirmed stopped session. A later graceful request
   never replaces an outstanding hard request.
3. Ask the existing sync service to publish to the named box immediately. The
   box does not need a separate shutdown request to begin enforcing the row.
   A private `ensure-stopped` call can prompt it to check before its next pass.
   Both paths use the same local stop routine. If the home is on the Mac, the
   hub calls that routine locally. The Mac does not run the box restart loop.
4. Return **Stopped** only when the Mac records a matching exit confirmation.
   If the box cannot be reached, leave the saved row in place and show:

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

### Hard mode arrives with the stopped home

Stop and Kill now never signal before the home machine durably applies the
stopped row. Hard mode survives a partition or a Mac restart after commit. The
Mac carries a small control note for that exact home in the existing v0 global
store import. The box commits the note and the home in the same transaction.
A detached note cannot authorize a signal. A capable box must not receive the
row from a hard request without the note, whether sync runs on demand, on
schedule, or after a restart. Validate the note against the hub sender, named
box, and home in the batch. Batch replay must agree on the note too.

A `hard-stop` note selects hard mode. A stopped row without one uses graceful
mode. The same mechanism carries an `explicit-start` note for a Start. Neither
note grants run permission. Receivers without note support get the unchanged
home row. On upgrade, if the stopped row is already present, `ensure-stopped`
can supply its exact note without another home write. The Mac does not claim
that an old release honored hard mode.

### The box confirms exit, not signal delivery

The supervisor reads `stopped` before any restart. Once the box applies the
row, admission and launch refuse it. On its next pass the supervisor actively
stops a remaining owner, without waiting for the Mac. Prevent new owned work
once the host observes Stop, but let graceful shutdown finish its writes. Do
not require a live Herdr view or a valid checkout to begin checking for a stop.

- Serialize shutdown, launch, and membership changes with the local session
  state lock. Require the exact stopped home and a verified owner generation
  before each effect. Recheck PID, birth, and boot, and the session ID lock,
  file lease, and terminal identity where applicable. A replacement owner,
  stale epoch, or unknown identity cannot receive a signal intended for the
  previous owner. Retain the identity of work that can outlive pi before
  teardown, so a failed attempt can account for it on retry.
- For Stop, give pi up to 5 seconds to shut down through `session-shutdown`.
  The existing socket in `packages/host/src/roam/relocate-control.ts` accepts
  only `moving`. Add a separate stopped-home request shape with the stop epoch
  and target owner generation. Pi checks both against the local row and its
  own admission before calling `context.shutdown()`. Keep the moving-home
  check for relocation. The reply acknowledges the request, not the exit.
  If an older pi does not accept the request, use the same signal fallback.
- If work remains, send `SIGTERM` to the verified owner and verified surviving
  work. Give them 5 seconds, then use `SIGKILL` for verified survivors. Kill
  now goes straight to `SIGKILL` if matching work is still alive. A retry does
  not renew either grace period. Recheck after each wait and before each
  signal. Do not signal an unchecked PID or a process group by number alone.
- Prove absence using the ID lock, file lease, terminal and process inventory,
  and the session's subagent and job records. An empty lock is not enough.
  Account for in-flight launches, including one with a lost reply. Record the
  launch identity before sending it to the core. A timeout does not clear a
  launch whose outcome is unknown. Use durable subagent and job records to
  check work that can survive its parent. A finished terminal or stale run
  record alone cannot clear detached work.
  Use existing owned-job controls for work running elsewhere. If its exit
  cannot be proved, keep Stop pending. Do not kill unrelated checkout writers.
- Once absence is proved and the stopped row still matches, leave the local
  membership frozen at the stopped epoch and save the exit confirmation.
  Report unknown identities, surviving jobs, and failed checks as pending.
  A stop attempt is bounded by the existing readiness budget, normally 60
  seconds. Retry on later supervisor passes without reopening admission.

Reuse the checks in `packages/roam/src/relocate/local.ts` and its process and
writer checks. Relocation still checks for other checkout writers before it
copies files. Stop checks and signals only the session and its owned work.

## Start and crash loops

Start names the machine and epoch that the caller saw. Under the Mac operation
lock, refuse a changed home even if it is now stopped. If Stop is still
pending, refuse Start and ask the caller to retry after Stop is confirmed.
Do not skip an undelivered shutdown. Starting from a confirmed `stopped` home
or a verified crash loop writes a new `running` epoch on the same machine and
saves a pending Start. First verify the placement, control support, and that
no prior owner or pending launch can run. If that check is unavailable, leave
the home unchanged. Start on an already authorized running home checks the
existing owner or continues startup for that epoch without a new grant.

Publish the running row before activating membership and launching. Reject
activation based on a proposed successor of a stopped row. Use the local ID
lock and file lease, exact transcript and checkout, and the current epoch on
the launch and admission paths. Confirm only a live owner admitted for the new
epoch. The box supervisor can finish a pending Start without the original
caller. For a Mac home, the hub uses the existing local launch path for the
explicit request, not an automatic restart service. If confirmation is late,
report **Starting**. A retry checks the same epoch and never starts a second
owner. An older Start or shutdown cannot authorize work under a newer home.

The box keeps a private crash record with the running epoch, last launch
identity, consecutive failure count, next attempt time, and suppression flag.
Count a definitive launch failure or a verified abnormal owner exit within
60 seconds of launch once per attempt. Do not count an unknown owner, a lost
reply, a known clean exit, a planned shutdown, or a reboot as a crash. With
no verified owner, wait at least 10, 20, 40, and 80 seconds after the first
four failures. On the fifth, stop retrying and report **Crash loop** with the
last reason. Five minutes with the same verified owner clears the failure
count before suppression. The guard survives supervisor restart and reboot.

The box checks the guard in both launch and admission. Only a newer running
epoch with a matching `explicit-start` note clears suppression on that box.
The box keeps the suppression for the session across other epochs. Retrying
same-home relocation, undoing a move, or forcing a new epoch does not clear
it. A move of a `running` home to a different box uses that box's own guard.
A stopped move never launches there.

## Relocation and forced recovery

A healthy move still stops the source, copies the transcript and checkout, and
then commits the destination home. If the source was stopped, verify that
stop before copying. Preserve the plan's prior state at destination commit,
undo, and rollback. For a stopped destination, install with frozen membership
at the new epoch, publish `stopped`, and confirm absence. Do not launch or
return a terminal as proof of completion. Same-home `relocate` of a stopped
session only reports or reconciles the stop. Accept the frozen membership at
the stopped epoch in source checks. Do not make it active to seed transfer.
Use `packages/roam/src/relocate/relocate.ts` and
`packages/roam/src/relocate/transfer.ts` for this path.

If a failed move leaves `moving`, neither machine may run from that row. A
source that missed the row may still run from an older replica. Under the
operation lock, match the home to the exact move checkpoint, then use these
rules:

1. Prefer the source if the move never granted run permission to the
   destination and a fresh check verifies the retained source transcript and
   checkout. The source is where the last owner could write. If there is a
   final capture, check the source against it rather than assuming a copy at
   the right path is current. Stop writes `stopped` before it signals an owner.
2. Use the destination only if the checkpoint records that the source applied
   the moving row and stopped before the final capture. Verify that no later
   home let the source resume and that the current install matches the capture,
   including transcript history and Git trees. If both copies match, prefer
   the source unless the pending away-home fence binds the commit to that
   verified destination. A transfer artifact or newer file time does not
   prove which copy is current.
3. If the evidence is missing, conflicts with the away-home fence, or cannot
   identify a verified latest copy, refuse without changing the home or
   signaling. Name the missing evidence. The operator can finish or undo the
   move with `relocate`, or use `set-home --force` with a verified copy and
   independent assurance that the old source will not run.

When a copy qualifies, settle `moving` directly to a newer `stopped` epoch on
that machine. Do not pass through `running` or discard either copy. Publish
the Mac's away-home fence before assigning a box home, even a stopped one.
A same-home Stop keeps the existing fence. A pending fence for a move must
match the chosen placement and epoch. A stopped return to the Mac does not
clear the fence or admit pi. A later Start must pass the existing fence checks.

`set-home --force` keeps a stopped home stopped. Recovery from an unresolved
`moving` home also settles as stopped, so force cannot turn an unfinished
stopped move into a launch. Retain the verified destination copy check, typed
confirmation, and warning about the old source and unsynced work. Force does
not prove exit on a displaced box. A stop confirmation after force describes
only the new home. The operator is still responsible for keeping the old
source down. Keep the existing Mac source checks. A forced stopped placement
uses frozen membership and never activates or starts pi. Help tells the
operator to use Start, not same-home `relocate`, to run that copy again.

## Confirmation and reconnect

Use `roam agent --v0` in `packages/roam/src/relocate/remote.ts` for
`ensure-stopped` and read-only `session-observation` requests. The latter
names the session and expected home. Mutations require the exact local
stopped home and identify the enrolled hub. Neither request carries a PID
chosen by the Mac. Replies report the observed home and boot ID, and give
an exit confirmation, verified owner, crash record, or pending reason. A stop
confirmation identifies the session, machine, epoch, check time, and owner
generation if there was one. Report a different or missing replica explicitly.
The Mac validates and saves proof only for the current home. It discards late
results after an epoch change. A sync receipt is not exit confirmation.

On hub startup, resume checking committed requests. Use the same local stop
routine for pending Mac stops. After an immediate targeted sync, use the
existing peer retry schedule. Failed contacts retry after 30, 60, and then
120 seconds. Healthy sync defaults to 120 seconds. After peer sync, check the
observed home even if an unrelated store did not sync. For a reached box with
pending confirmation, check again every 10 seconds. Coalesce in-flight work.
Do not retry sync from inside its own completion callback. The box supervisor
checks at startup and on each pass. Its 10-second cadence is not an outage
bound.

A reboot does not erase the stopped row or the crash guard. Discard PID
observations from a prior boot. Check the current lock, terminal, and owned
work before issuing a new confirmation. If the box reboots before it receives
Stop, its old running replica can still restart pi. The Mac keeps Stop pending
until the box catches up. A saved confirmation stays valid for the matching
stopped home unless new evidence contradicts it. A box that no longer has the
row needs publication and verification again.

Extend the existing v0 `hello` reply with `sessionStopVersion: 1` for an
agent that supports notes and observations. A ready indication also needs
proof from the running supervisor. Verify its protocol marker against its
live PID, birth, and boot identity. The installed CLI version alone is not
enough. Older v0 boxes already refuse to launch from a stopped row. Some can
try a generic `SIGTERM`, but they cannot carry out or confirm the new stop
protocol. Publish the compatible row anyway. For a reachable older box, show
**Stop pending: update roaming on the box. It may still be running.** If the
agent supports the protocol but cannot verify the running supervisor, show
that reason and retry when the supervisor is ready. A failed connection is
unreachable, not a version diagnosis. If replication is disabled on the box,
show that reason and keep the request pending. Never send a control request
to a revoked peer or fall back to a legacy agent.

## CLI and Herdr

- `spider roam stop <session> [--now]` and `spider roam start <session>` run
  on the Mac through the running, enabled v0 hub. Resolve one existing managed
  session by the usual ID or name rules. Do not adopt an ordinary or legacy
  session. Extend `roam/relocate.sock` with `stop`, `start`, and `session-status`.
  Mutations send `{ operationId, sessionId, machineId, homeEpoch }` in the
  existing request envelope. `stop` also has `mode: graceful | hard`. The hub
  checks the observed machine and epoch under the operation lock, with the
  in-progress move exception above. Keep the existing socket ownership and
  size checks. Status reads the current home and saved results.
- `spider roam status` remains a cached read. Text and `--json` show the home
  machine, home state, epoch, observed status and reason, and last observation
  time. Action replies also give the operation ID. Exit 0 means the requested
  stop or running owner is confirmed. Exit 3 means waiting, pending, or unknown
  after a lost reply. Exit 1 means refused, and 2 means invalid arguments.
  A lost reply does not earn a "saved" message. Check status before retrying.
- Public `stop` replaces the legacy intent command, including in help. Remove
  public `resume`. Its replacement for a v0 home is `start`, not an alias or a
  fallback. Old sessions use the documented upgrade procedure. Keep private
  legacy operations only until their remaining callers are migrated.

For a session homed elsewhere, Herdr offers **Stop session**, **Kill now**, and
**Start session**. Kill now requires confirmation that it ends owned work and
prevents restart. While Stop is pending, offer Kill now as an escalation, not
Start. Offer Start after confirmation or when the box reports a crash loop.
Show the same state and reason as `roam status`. Keep the session addressable
by ID after its terminal disappears so Start needs no live pane or owner feed.

The UI task owns the menu, confirmation, and status display. The typed seam is
`PaneServiceRequest` and `PaneServiceReply` in
`packages/herdr/src/panes/types.ts`, through `panes request`:

- An action sends `{ version: 1, op: "roam-session-action", operationId,
  sessionId, action, machineId, homeEpoch }`. `action` is `stop`, `kill-now`,
  or `start`. An action from a presentation also sends `presentationId` and
  `expectedRevision`. The pane service checks that binding and forwards the
  corresponding v0 hub request, never a terminal kill. From a session row,
  bind to the observed home instead. A fresh box feed is not required to
  record Stop.
- A status read sends `{ version: 1, op: "roam-session-status", operationId,
  sessionId }` and queries the Mac's cached session status. Both replies use
  `{ version: 1, kind: "roam-session-outcome", operationId, sessionId,
  machineId, homeEpoch, homeState, outcome, status, reason, observedAt }`.
  `outcome` is `complete`, `pending`, or `refused`. `status` is `running`,
  `stopping`, `stopped`, `stop-pending`, `starting`, `crash-loop`, `moving`,
  or `owner-unverified`. Home and observation fields may be null if unknown.
  A status read uses `complete` for a successful read, not a stop. A slow
  action returns pending. Read status to settle it instead of sending a new
  mutation. Ignore late replies that refer to a superseded home.
- The pane snapshot adds a bounded `roamSessions` list. Each entry has
  `sessionId`, `name`, `machineId`, `homeEpoch`, `homeState`, `status`,
  `reason`, and `observedAt` from the same cached view. Include stopped
  sessions without a live presentation. Do not expose process evidence or
  file paths to the menu.

Route a new confirmed Close on a managed session to graceful Stop. Do not
replay old pane-close records as new Stop requests. A missing terminal cannot
complete a managed Stop. If the v0 hub is unavailable, explain the refusal
instead of calling `close-session`. The legacy close endpoint refuses a
managed home. Leave ordinary local Kill and its generation check unchanged.

## Testing

- Unit: cover the status table, exact epochs and owner generations, hard-note
  validation and atomic import, duplicate actions, and crash accounting with
  a fake clock. Test that old replies cannot confirm Stop or authorize Start.
- Integration: use real fixture stores and the v0 control and sync paths. Lose
  replies before and after commit, race a delayed shutdown against Start, and
  race a delayed Start against a later Stop. Check no signal precedes the
  durable stopped row and no unrelated process is signaled. Check that Kill
  now on reconnect skips both grace phases. Cover unknown owners, detached
  jobs, a lost launch reply, reboot, an older box, and the crash guard across
  supervisor restart. Test Stop on both sides of relocation commit, failed
  move proof and refusal, stopped moves and undo, same-home `relocate`,
  `set-home --force`, and the away-home fence.
- Add a packaged Linux headless Herdr story with a fixture such as
  `box.invalid`. Drive the pane service and verify the stopped row and absence
  of pi, subagents, and detached jobs across at least two actual supervisor
  passes. Start the same transcript with one new owner, exercise Kill now, and
  check that it stays down. Start again, cut the route to a live owner, and
  request Stop. See pending while cut off. Restore the route and observe
  shutdown and confirmation without another Stop. Keep ordinary Kill, R04
  hosting recovery, R10 admission, and R18 relocation checks.
- After those checks pass, repeat on real machines with a test session. Check
  the process and owned work, not the pane alone. Restart the box supervisor
  with the stopped row in place, reconnect after a partition, and verify that
  only an explicit Start brings the session back.

## Rollout order

1. Steps 3D and 3E of the old move removal leave pane stop behavior alone and
   retain legacy `stop` and `resume` until v0 takes over. Keep the v0 session
   socket and home checks through transfer cleanup in step 4A.
2. Ship the v0 hub controls, box enforcement, and pi socket support. Switch
   public `stop` to v0 and retire public `resume` at that cut. Upgrade box
   agents and running supervisors before relying on confirmation. Do not
   downgrade the Mac writer to a release whose relocate or force action would
   change a stopped home to running.
3. Route managed pane actions to the v0 hub and prove the managed and local
   paths. Step 4B waits until Stop and this route have landed. Then remove the
   legacy pane stop caller after the other host-admission migrations for 4B.
   Keep early v0 admission, shutdown, generation, and file-lease checks, plus
   refusal for old foreign or frozen homes and missing or cloned stores.
   Step 4C removes private legacy stop and resume with their last callers.

# @spider/roam

Roaming coordinates session placement, participant intent, exact launches,
hub synchronization, machine intercom and session moves. See
[Roaming architecture](../../docs/architecture/roaming.md) for configuration,
operator commands and ownership contracts.

## Enable and broker readiness

`production-controls.ts` completes read-only peer preflight before starting
services. The private box startup command runs doctor checks and resolves
settings before `spawnBrokerIfNeeded`, then validates broker health and returns
its doctor report. Enable validates the machine identity and report and uses
that observation without a second doctor call.

This ordering keeps slow settings resolution outside the sessionless broker's
idle lifetime. Startup still uses the existing deadlines. An unavailable broker,
invalid readiness evidence, or a startup error leaves enable pending before
capture and participation flags change. The response includes an allowlisted
`causeCode` without broker stderr, exception text, or private paths. A broker
that answers health but lacks federation support remains blocked.

## Packaged hub service

`package-layout.ts` resolves the installed `dist/roam/cli.mjs` dispatcher for
hub enablement. The service runs that executable with `roam hub`, not the
imported `cli-main.mjs` library. Enable checks the local role before resolving
that entry. A box returns `mac-hub-required`; a hub with an unavailable
installed entry returns `enable-unavailable` without changing configuration.

`hub-service-diagnostics.ts` reads service metadata and uses the read-only
status probe in `hub-readiness.ts`, shared with enable. Doctor gives service
metadata and readiness probes a combined two-second deadline. If service state
is unknown and the socket is absent, it reports immediately instead of retrying.
A running service can become ready in the remaining time. A stale socket is not
readiness. Control requests use elapsed-time deadlines, even during partial replies.
It blocks with `hub-startup-pending` only when the service is stopped, or when
a running service still fails the probe after that bound. Unknown service
metadata produces a `hub-startup-unverified` warning. The diagnostic names
the last exit code and error log path, without reading log contents, and asks
to check the service and that log rather than repeatedly reinstalling it.

After upgrading a hub enabled on an earlier release, run `spider roam enable`
again to reinstall its service with the correct entry. The packaged
`supervisor.mjs` entry also runs through file or directory symlinks to a
release, including with preserved main symlinks. `scripts/check-roam-bundle.mjs`
rejects remote runtime and pane endpoint main bodies in the built roam entries.

## Hub service selection

Enable captures the resolved `hc` socket and session before peer preflight.
Non-default selections are pinned in the hub service; the unconfigured default
keeps the existing environment. The service runs from the scoped global root.
Doctor compares the installed selection with the current environment. To repair
a mismatch, run `spider roam enable` again from the intended environment.
The startup diagnostic identifies the selection class without logging the path.

## Provisioning private agent modes

The settings preview checks the requested destination agent tree without
changing files. After consent, provisioning tightens same-uid regular files
and directories to private modes. Sign-in-created `0664` files become `0600`,
and `0775` directories become `0700`. Owner-executable files retain `0700`.
`--no-settings` omits the settings copy but still checks and repairs existing
files. Permission repair does not change their contents.

The JSON result lists each repair in `value.privateModeRepairs`, with its path,
uid, and numeric `before` and `after` modes. The destination stores a private
receipt so retries return the same repair evidence. Installer-tree changes
remain in the separate `value.permissionTightenings` count.

The walk never follows symlinks or repairs foreign-owned entries. Hard links,
special files, and incompatible owner permissions also refuse. Refusals name
the path, mode, uid, and repair advice. Shared parents outside the agent tree
retain their existing explicit repair requirement.

## Provisioning protected install paths

A same-uid directory with mode exactly `0700` at or below the install prefix
protects its descendants. Provisioning accepts a `0775` bin or executable
behind that directory without chmod. Every parent before protection starts
must remain same-uid, real, and not writable by group or others. A later private
directory does not excuse an earlier writable parent. Private directories
outside the prefix do not relax this rule.

The pi package and release trees use the same rule. Foreign owners, hard links,
unsafe types, special mode bits, and escaping symlinks still refuse. Internal
npm links keep their existing checked-target allowance. Install refusals name
the path, mode, uid, and exact repair advice. An unprotected writable path
reports `chmod go-w` for that path; owner and link failures require replacement.

Protected install entries add no JSON repairs because their modes do not
change. Agent repairs and receipt-backed installer tightening remain unchanged.
The inventory probe recognizes the same protection, so doctor's reprovision
advice can reach an installed runtime instead of another bin-mode refusal.

## Stop and pending launches

`supervisor.ts` reserves a launch before authorization. It changes the
reservation from `reserved` to `invoking` through a compare-and-swap before
calling the exact-launch adapter.

`participant-runtime.ts` persists a stopped intent independently of the roaming
enable switch. Stop clears a `reserved` reservation with no ID lock to idle,
without a launch outcome or restart proof. The same compare-and-swap prevents a
concurrent launch from invoking the cleared reservation.

An `invoking` reservation without an ID lock remains blocked unless a released
adoption record proves which owner adopted that launch. Stop requires the same
boot and an absent recorded PID. PID reuse, an unavailable probe, or a changed
boot refuses this proof. The exact file must match the durable intent authority,
and its lease must be absent or name an absent process on the same boot.

`settleReleasedAdoptedOwner` runs the proof and journal writes under the
session-ID mutex used by adoption. Participants claim that ID lock before the
file lease. The proof rechecks ownership, boot and lease state and refuses if
readiness appears during inspection. It retains the released adoption record
and existing history, records `exact-adopted-owner-ended` and
`exact-launch-settled`, and completes the launch with `launch-ended`. Stop then
sets supervision idle while the durable intent stays stopped. Stop completes
interrupted launch journal writes before clearing the reservation. A failed
idle compare-and-swap can retry without duplicating settlement records. No
launch runs on this path.

A pending ID lock must match the participant's launch operation before stop can
settle it. Stop never settles a different operation, such as a move launch.

`launcher.ts` settles ownership only after proving launcher exit and proving
that the terminal cannot adopt. Reconciliation has a 60-second deadline.
Timeout or missing evidence preserves ownership. A terminal missing from the
pinned core's listing is not, by itself, exit proof.

Stop also accepts `started-launch-ended` evidence when the launcher's boot is
unchanged and its PID start identity has exited, no lease owner adopted the
session, and no `ready-durable` record exists. Every recorded and sampled core
identity must match the pending core. Two complete finished-inclusive samples,
250 milliseconds apart, must show no live terminal carrying the operation,
latest attempt, or session label. Each sample combines three separately filtered
local listings, since native compact rows omit labels and combined CLI filters
use AND rather than OR. Finished history for other terminals does not block it.

The reconciler rechecks ownership, boot identity, and journal stability after
sampling. It keeps the existing proof for a recorded finished terminal.
Settlement records `exact-started-launch-ended` with proof metadata and completes
the operation with `launch-ended`. It does not call that launch never-started.
Ordinary launch reconciliation cannot use this new proof to retry, and stop
cannot relaunch the session.

After settlement, stop reads the latest intent version before clearing the
reservation. If the intent write still loses a race, the refusal includes a
stop repair command. Invoked launches retain their restart proof so resume can
use a new operation ID.

`local-diagnostics.ts` distinguishes unchecked, unavailable, and changed core
identities. Pending launches remain blocking in all three cases. For a released
adoption, doctor distinguishes a live owner, unavailable owner status and a
live file-lease holder. It directs the operator to supported session shutdown
or restored process and boot identity inspection before stopping again. Once
the released owner has positively exited, doctor offers stop. A reservation
without adoption evidence checks the actual pin and core before reporting a
core problem. These repairs do not send the operator back to doctor. Doctor
offers stop for an unstarted reservation, but inspection for an invoking
reservation without a handoff. Stop repair diagnostics name the Mac hub as
where to run the command, including when doctor runs locally on a box.

## Machine reachability

The production hub parses native machine states at the inventory boundary.
`disconnected`, plain `unreachable`, and `stopped` mean transport is unavailable.
Native `unreachable` with the exact reason `a different core answers there
("<core-id>")` is a replaced remote core, not a transport outage. The hub and
machine UI share this classification. It remains unknown, as does a local
core identity change during inventory. Generic unknown observations do not
start or clear an outage, schedule recovery, or cancel an existing alert timer.
A replaced remote core cancels pending hosting notifications. A replaced remote core also discards the old peer's pending
reconnect trigger, so its next connected observation is not a reconnect.
Existing delivered alerts remain. A later plain unreachable
observation resumes the retained outage. Other identity refusals keep their
sync diagnostics; this parser does not infer identity changes from arbitrary
reason text.
Literal `connected` clears the hosting outage alert even if sync refuses
content. Such refusals keep their separate sync diagnostics and backoff.
Hosting checks, placement and suspension warnings need only native `connected`
and a reply from the enrolled peer. Ungathered or refused stores and mid-round
peer command exits do not suppress them. A code-3 connectivity failure makes
the reply uncertain and suppresses hosting checks for that round.
Move recovery requires `connected` and an answer from the enrolled peer with
no connectivity failure in the current round. Ungathered and refused stores
do not block this proof. The move's own journal proofs still control recovery.
Hosting alerts retain the ten-minute delay.

## Sync retries

Transport failures, whether code `1` or code `3`, retry after 30, 60, and
then 120 seconds. A short configured `syncMs` cannot bypass this schedule.
An answered round without a connectivity failure resets the backoff even when
a store is ungathered or refused. Those stores keep their own diagnostics.
An identity mismatch cannot prove the enrolled peer answered. A session mirror
export or copy that loses connectivity also retains the backoff and cannot
verify the round. An answered mirror refusal keeps its own diagnostic.

If an unreadable worktree or replica prevents an initial home, `sync.ts`
records the responsible machine ID and store kind in local metadata. A move
keeps the `move-source-home-mismatch` refusal and adds
`move-first-home-withheld` with that evidence. The safety gate is unchanged.
A new inventory clears stale evidence, and diagnostic failures do not affect
home assignment.

## Move executable and setup failures

Remote agent exec and run commands export the enrolled peer's absolute Pi as
`SPIDER_ROAM_PI`. Move composition does not need Pi on the remote core's `PATH`.
Validated adapter failures return code `1` with an allowlisted cause. Missing
Pi returns `participant-pi-unavailable`, which the move refusal retains with
an install or configuration repair.

`readiness.ts` names preparation failures for an unfinished freeze, missing
cwd, invalid or mismatched header, store mapping, store access, and seeding.
Unknown failures remain `setup-unavailable`. Doctor includes the latest local
setup stage, cause, safe session ID, and first and last occurrence times. The
snapshot contains no exception text, paths, or prompts. It is machine-local
metadata and does not replicate. A successful setup clears its own session's
failure.

## Move recovery

The hub tracks unreachable peers even when they have no hosted homes yet.
After startup recovery, peers with pending moves also wait for their first
verified sync. This covers a peer reconnecting before the first observation.
A later verified successful sync schedules a peer-scoped full recovery pass
outside the sync callback, so recovery can request sync barriers without
waiting on itself. Full recovery and cleanup share a single writer. Requests
for the same peer while a pass runs coalesce into one follow-up pass, so new
pending moves are not missed. The pass
uses the existing forward-only journal proofs and never retries failed moves
in a loop. Successful-sync cleanup uses one coalesced timer and one flight.
Disable and shutdown cancel scheduled work and drain active recovery and cleanup
before closing stores. A peer pass skips an occupied session move lock without
recording a warning. Journal I/O, lock inspection, and power assertion failures
keep their own warning and recovery command. A quiet skip arms one later pass
on the peer's next verified sync round while that skipped move remains pending.
There is no timer retry loop, and completed moves do not trigger a later pass.
Terminal recovery, including a terminal refusal, clears that move's saved
recovery diagnostic. Unfinished moves keep their warning and recovery command.

## Partial disable

When local disable succeeds but box flags are unconfirmed, the command returns
`roaming-disabled-partial` with code `3`. Its issues name each box and the exact
`spider roam disable` retry command. Retrying reuses the latest matching pending
peer operation ID without appending another consent record. A newer enable
operation prevents reuse of an older pending disable. Code `0` means all flags
are confirmed. Captures and homes are retained in either case. Both outcomes
tell open pi sessions to use `/reload` to pick up the local change.

## Intercom pair ID reuse

`intercom-registry.ts` permits a different endpoint identity pair to reuse a
completed revoked pair ID. Both endpoint fences must be null. Enrollment uses a
new operation, a new epoch, and fresh consent without inheriting the retired
fence or resources. The completed record has a revocation epoch and no cleanup
obligation. Resource metadata remains as a cleanup receipt.

`intercom-production.ts` reports `intercom-pair-revocation-incomplete` when the
completion epoch is missing, and `intercom-pair-fence-conflict` for conflicting
fences. Pending revocation keeps `revocation-pending`. Same-endpoint restores
still need consent to the recorded fence. `intercom-enrollment.ts` refreshes
refused observations on retry while retaining successful pairs' fence consent.

## Intercom initialization

Failed machine-intercom setup retries after 1, 2, 5, 10, and then 30 seconds.
Readiness stays pending until setup succeeds. Success resets the initialization
backoff. Stop cancels the pending retry and drains setup before closing resources.

## Pair publication

After transport verification, `intercom-production.ts` publishes configuration
on both sides and enrolls both live helpers. A failure keeps the original
pending or precise refusal. Enrollment output and hub doctor name the step,
source or target side, and any allowlisted inner cause. Unknown errors keep the
`unexpected-publish-pair` fallback without exception text.

The local operation journal retains the latest failure for a pending pair.
Identical retries do not add duplicate diagnostic records. A successful
publication or a later failure at another step clears the evidence. Writes are
best effort and cannot change enrollment or its retry.

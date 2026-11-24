# Roaming runtime

This package owns hub synchronization, machine intercom, and session moves.
See [Roaming replication](../../docs/architecture/roaming.md) for command and
ownership contracts.

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
recording a warning. A later pass can retry it if the move is still pending.
Terminal recovery clears that move's saved recovery diagnostic.

## Partial disable

When local disable succeeds but box flags are unconfirmed, the command returns
`roaming-disabled-partial` with code `3`. Its issues name each box and the exact
`spider roam disable` retry command. Retrying reuses the latest matching pending
peer operation ID without appending another consent record. A newer enable
operation prevents reuse of an older pending disable. Code `0` means all flags
are confirmed. Captures and homes are retained in either case. Both outcomes
tell open pi sessions to use `/reload` to pick up the local change.

## Intercom initialization

Failed machine-intercom setup retries after 1, 2, 5, 10, and then 30 seconds.
Readiness stays pending until setup succeeds. Success resets the initialization
backoff. Stop cancels the pending retry and drains setup before closing resources.

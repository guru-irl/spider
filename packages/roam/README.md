# Roaming runtime

This package owns hub synchronization, machine intercom, and session moves.
See [Roaming replication](../../docs/architecture/roaming.md) for command and
ownership contracts.

## Machine reachability

The production hub parses native machine states at the inventory boundary.
`disconnected`, `unreachable`, and `stopped` mean transport is unavailable.
Login or identity uncertainty remains unknown and cannot clear an outage.
Literal `connected` clears the hosting outage alert even if sync refuses
content. Such refusals keep their separate sync diagnostics and backoff.
Move recovery requires `connected` plus a successful current sync round that
proves peer connectivity and a complete store pull. An incomplete pull cannot
trigger move recovery even when there are no apply results. Hosting alerts
retain the ten-minute delay.

## Sync retries

Transport failures, whether code `1` or code `3`, retry after 30, 60, and
then 120 seconds. A short configured `syncMs` cannot bypass this schedule.
A successful complete round resets the backoff. Answered identity or content
refusals do not start an outage backoff or reset an existing one.

## Move recovery

The hub tracks unreachable peers even when they have no hosted homes yet.
A later verified successful sync schedules a peer-scoped full recovery pass
outside the sync callback, so recovery can request sync barriers without
waiting on itself. Full recovery and cleanup share a single writer. The pass
uses the existing forward-only journal proofs and never retries failed moves
in a loop. Successful-sync cleanup uses one coalesced timer and one flight.
Disable and shutdown cancel scheduled work and drain active recovery and cleanup
before closing stores.

## Partial disable

When local disable succeeds but box flags are unconfirmed, the command returns
`roaming-disabled-partial` with code `3`. Its issues name each box and the exact
`spider roam disable` retry command. Retrying reuses the latest matching pending
peer operation ID without appending another consent record. A newer enable
operation prevents reuse of an older pending disable. Code `0` means all flags
are confirmed. Captures and homes are retained in either case.

## Intercom initialization

Failed machine-intercom setup retries after 1, 2, 5, 10, and then 30 seconds.
Readiness stays pending until setup succeeds. Success resets the initialization
backoff. Stop cancels the pending retry and drains setup before closing resources.

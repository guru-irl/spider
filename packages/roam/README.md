# Roaming runtime

This package owns hub synchronization, machine intercom, and session moves.
See [Roaming replication](../../docs/architecture/roaming.md) for command and
ownership contracts.

## Machine reachability

The production hub parses native machine states at the inventory boundary.
`disconnected`, `unreachable`, and `stopped` mean transport is unavailable.
Login or identity uncertainty remains unknown and cannot clear an outage.
Literal `connected` verifies recovery only after a successful current sync
round also proves peer connectivity. Hosting alerts retain the ten-minute delay.

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
in a loop. Shutdown cancels scheduled full passes and drains an active pass.

## Intercom initialization

Failed machine-intercom setup retries after 1, 2, 5, 10, and then 30 seconds.
Readiness stays pending until setup succeeds. Success resets the initialization
backoff. Stop cancels the pending retry and drains setup before closing resources.

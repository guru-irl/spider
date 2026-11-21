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

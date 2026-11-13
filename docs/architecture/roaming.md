# Roaming replication

Roaming is disabled by default. Phase 2 packages the hub and sync transport for
isolated testing; remote hosting is not yet available. Production replication
and hosting stay disabled until phase 4 acceptance succeeds.

## Portable and local state

The global, repository, and worktree databases use schema 14 for portable
memory, sessions, todos, runs, run history, and session homes. Each replica has a
machine and stream identity. Capture uses SQLite triggers in the writer's
transaction, and import commits rows, versions, cursors, receipts, and derived
search state together. Imported run history is inert. Process identities are
not transferred, and consumers check run origin before operating or charging.

Usage databases, registries, bindings, routes, leases, ownership, broker state,
skills, indexed content, native indexes, journals, and backups remain local.
Transcript text is not replicated. A session replica can match metadata, but
transcript text stays on its origin unless independently imported locally.

A first foreign import creates retired membership. Ordinary writes to a frozen
or retired participant fail, including writes through function-free SQLite
connections. Admission blocks ordinary work on known non-owner or uncertain
copies. Pi may still append its own metadata to the local session file. A
source-file change after freeze aborts a move before home commit, and appends to
a retired source are discarded after commit. Third-party extensions are
outside these fences and can bypass them or override cache warming.

## Compatibility and rollout

Every writer, including the SQLite CLI, needs SQLite 3.42 or newer. Even with
capture disabled, the sqlite3 command line must be 3.38 or newer to write a
migrated store. Compatible consumers use core schema 14. A newer core schema is refused before application
queries. Migration backs up each existing core database before changing it and
refuses migration if the backup fails.

Deploy schema and guard-compatible consumers with roaming disabled. Before
replication is enabled, reload every consumer, including detached usage workers.
The enable check refuses older or unmarked live top-level builds. Keep hosting
disabled until the full phase 4 acceptance gate passes. Interrupted
rollout must retain the admission and origin guards.

## Shell command

The installed `spider roam` command provides status, doctor, sync, enable,
disable, repository mapping, and memory tagging. For a machine alias starting
with a dash, use `spider roam sync -- <alias>` or
`spider roam sync --machine <alias>`; doctor supports the same forms. On a box,
only local status, doctor, and repository mapping run locally. Other public
controls direct the user to the Mac. Future hosting and move commands remain
unavailable.

Enable refuses while a usage worker is starting or being replaced; retry after
it settles. If the hub socket is unavailable, disable requires the hub lock and
a journal proving no home change is pending. A missing journal is unknown.

Exit code `0` means complete, `1` means refused, `2` means invalid arguments,
and `3` means durable pending work or reconciliation is needed.

## Diagnosed duplicate todos

Migration detects duplicate `(session_id, seq)` values and records the
conflicting row IDs. The worktree remains usable for ordinary work but is not
roamable until the duplicates are deliberately resolved. Do not silently
renumber tracked todos or delete accepted rows to enable replication. After an
operator resolves the conflict, the next seed attempt checks the rows, creates
the unique index, and clears the duplicate diagnostic. Trigger-shape drift is
a separate diagnostic and disables capture without preventing the database
from opening.

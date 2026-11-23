# @spider/roam

Roaming coordinates session placement, participant intent, exact launches, and
replication. See [Roaming architecture](../../docs/architecture/roaming.md) for
configuration and operator commands.

## Stop and pending launches

`supervisor.ts` reserves a launch before authorization. It changes the
reservation from `reserved` to `invoking` through a compare-and-swap before
calling the exact-launch adapter.

`participant-runtime.ts` persists a stopped intent independently of the roaming
enable switch. Stop clears a `reserved` reservation with no ID lock to idle,
without a launch outcome or restart proof. The same compare-and-swap prevents a
concurrent launch from invoking the cleared reservation.

An `invoking` reservation without an ID lock remains blocked. A pending ID lock
must match the participant's launch operation before stop can settle it. Stop
never settles a different operation, such as a move launch.

`launcher.ts` settles ownership only after proving launcher exit and proving
that the terminal cannot adopt. Reconciliation has a 60-second deadline.
Timeout or missing evidence preserves ownership. A terminal missing from the
pinned core's listing is not, by itself, exit proof.

After settlement, stop reads the latest intent version before clearing the
reservation. If the intent write still loses a race, the refusal includes a
stop repair command. Invoked launches retain their restart proof so resume can
use a new operation ID.

`local-diagnostics.ts` distinguishes unchecked, unavailable, and changed core
identities. Pending launches remain blocking in all three cases. Doctor offers
stop for an unstarted reservation, but inspection for an invoking reservation
without a handoff.

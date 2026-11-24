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
identities. Pending launches remain blocking in all three cases. Doctor offers
stop for an unstarted reservation, but inspection for an invoking reservation
without a handoff.

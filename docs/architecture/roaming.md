# Roaming replication

Roaming is disabled by default. The package includes the hub, box supervisor,
sync transport, and intercom bridges for isolated testing. Production replication,
hosting, and remote intercom stay disabled until phase 4 acceptance succeeds.

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
disable, repository mapping, memory tagging, provisioning, and session stop and
resume. For a machine alias starting with a dash, use
`spider roam sync -- <alias>` or `spider roam sync --machine <alias>`; doctor
supports the same forms. On a box, only local status, doctor, and repository
mapping run locally. Other public controls direct the user to the hub. Move
commands remain unavailable.

Enable refuses while a usage worker is starting or being replaced; retry after
it settles. If the hub socket is unavailable, disable requires the hub lock and
a journal proving no home change is pending. A missing journal is unknown.

Exit code `0` means complete, `1` means refused, `2` means invalid arguments,
and `3` means durable pending work or reconciliation is needed.

## Box hosting and recovery

Production hosting stays disabled until phase 4 acceptance succeeds. Provisioning
installs only the supervisor service and leaves the existing core service and its
terminals unchanged. The hub's enable switch controls hub scheduling; it is not
a box hosting switch.

Authentication is never copied by default. Copying selected Pi credentials
requires explicit consent for each target and provider. A missing Pi sign-in
blocks hosting but does not prevent installation. Missing tool authentication is
a warning; sign in to the affected tool separately if it is needed.

Use `spider roam stop <session>` on the hub to persist a stopped intent. A
session quit also stops it. `spider roam resume <session>` runs doctor first and
refuses if blocking diagnostics remain. Doctor reports resource repairs, such as
file limits and inotify settings, for an administrator to apply; provisioning
does not make those repairs or restart the core. A core restart kills its
terminals. The supervisor restores an eligible running session from its exact
file, while a deliberate stop remains stopped. Repeated crashes suspend the
session until a successful doctor and resume.

After a Windows restart, the tunnel and WSL logon tasks do not run until desktop
sign-in. Hosted agents remain stopped until then. Supervisor recovery cannot
power on a machine or sign in its host. Remote upgrade and uninstall
orchestration are deferred; do not assume provisioning performs either.

The headless acceptance stories use a packaged extension and supervisor on
owned cores, with fixture service, boot, process and limit ports. R03 checks a
core-only session and child status without app configuration. R04 restarts the
core and checks one exact-file owner and one restored trigger delivery. R05
checks crash suspension and a durable stop. They do not prove actual systemd or
real-box behavior; phase 4 owns those checks.

## Intercom across machines

Spider owns its intercom fork and keeps the local broker and offline mailbox.
The settings switchover removes the legacy extension entry, not its package
files. A second intercom extension is a conflict, not a second relay. Sessions
use scope and machine-qualified names to disambiguate recipients.

A durable acceptance means the bridge stored a message. It does not mean Pi
injected the message. The sender retains the payload until a receipt identifies
a physical entry in the recipient's own session or a matching reply waiter.
An uncertain delivery stays `unknown` across reload. A same-ID retry requires
an own-session entry scan and proof that the old generation cannot inject.
Later messages can advance while an earlier outcome remains unknown.

A link outage preserves peer names and queued mail. The first transient failure
keeps active asks waiting. If its retry fails, the bridge reports `link-down`
and emits one diagnostic for the outage. An ask to a known-down edge fails
immediately. A late reply remains a message after the original waiter ends.
Undelivered payloads expire after at most 24 hours.

Hub-only routing depends on the hub and cannot deliver between boxes while the
hub is off. Approved peer enrollment adds a dedicated connector, key, and route
for one box pair. Revocation fences that pair and removes its owned resources.
If a peer is unreachable, revocation remains pending rather than claiming the
remote resources were removed. Enrollment does not enable unrelated pairs.

### Explicit hub-only to peers transition

Pair enrollment stages the approved direct edges without changing a box's mode.
Activating peer mode requires the hub, the recorded enrollment consent, and the
same machine identities and access graph. Retries derive the same transition ID
from that approval. They do not append to a completed enrollment operation.

The private queue database records a transition with `draining`, `switching`,
and `complete` states and a pending or switched status for each box.

1. The hub durably fences new relay custody. It returns retryable
   `intercom-topology-changing` before accepting a new relay frame. Hub-origin
   traffic and direct box-to-hub traffic continue.
2. The hub drains existing relay custody under hub-only rules, including the
   receipt back to its origin. Normal expiry and failure receipts also settle
   custody. Every receiver stays hub-only during this drain.
3. The hub sends a switch control to each box. In one local transaction, the box
   changes to peers mode and rebinds source-held relay copies to enrolled direct
   edges. Only never-transmitted copies or copies durably refused before hub
   custody qualify. Each change writes a `topology-transition` audit row with
   the transition ID, old and new next hops, and timestamp. Message IDs,
   endpoints, authored content, and `originMachineId` do not change.
4. After every box acknowledges, the hub changes to peers mode and marks the
   transition complete. Hub presence stops advertising relayed sessions when
   switching begins. Completed hub edges advertise only the hub's own sessions.

The source rebind is separate from endpoint-move reconciliation. Hub custody
refuses with `intercom-topology-hub-custody`. An uncertain transmission refuses
with `intercom-topology-outcome-unknown`. Neither refusal changes the mode,
routes, or audit. Missing enrolled routes leave mail queued and report
`intercom-route-missing <peer>` rather than relaying in peers mode.

An unreachable box remains pending with `intercom-transition-pending <box>`.
A hub restart resumes the durable transition. A box restart restores its mode
and audit from the queue, and replaying the same switch adds no route changes
or audit rows. Already-switched boxes continue directly while the hub is down.
Unswitched boxes keep source mail queued behind the hub's intake fence.
The reverse transition refuses with `intercom-transition-unsupported`.

### Edge initiation and responder queues

Each pair has one bidirectional edge. The hub initiates its box edges; the
lower persistent machine UUID initiates a box-to-box edge. Only the initiator
has an enrolled outbound route and opens exchanges, including long polls and
short batches.
The responder never opens a reverse call. Its sends, asks, replies, receipts,
and controls wake the held poll, or join the initiator's immediately reopened
poll if work arrives between calls. They do not wait for a 25-second poll timer.

A missing reverse route is normal, not a recovering link. If the initiator
stops polling, the responder's 35-second last-success lease expires. It keeps
ordinary mail queued, exposes one outage diagnostic, and issues no reverse
probes. Pending asks keep their original deadlines and fail with `link-down`
when those deadlines expire. A valid incoming exchange restores live health.

### First-home adoption and retained mail

First sync can assign the first home to an already-running local-origin
session. The original process refreshes its advertisement through admission
and ownership readiness, without a reload, a new activation, or another lock.
Foreign homes, epoch bumps, freezes, and unsafe capture do not qualify.

Before advertising the first epoch, the owner persists a machine-local
adoption record with the session ID, activation, machine, null previous epoch,
new epoch, and adoption time. It uses the global database's existing local
metadata, not replicated home rows or a second home authority. Replaying the
same adoption preserves its original timestamp. A failed write leaves the
registration unchanged and can be retried.

Delivery matches pre-adoption mail only when that record and the current
registration identify the same session, scope, machine, activation, and
recorded new epoch. It dispatches the retained copy without rebinding its
endpoint. The broker still checks the exact live registration before socket
delivery. Normal injection evidence settles the original receipt owner and
routes the receipt to the persisted origin, even if the sender has left.

A bridge restart reads the durable record and current registration again.
A missing or mismatched record, another machine or activation, a later epoch,
or a non-null previous epoch is not equivalent. Ending the activation ends
this match. These cases keep the existing absent-endpoint and exclusion rules.
Adoption is not a general endpoint alias or move permission.

For subsequent sends and asks, the recipient rebuilds a first-home attestation
from that durable record: `{ activation: A, fromEpoch: null, toEpoch: N }`.
Presence accepts it only in this exact form, bound to the advertised activation
and epoch, from an edge authorized for the recipient machine. Malformed
attestations fail with `invalid-presence`; dispatch arguments cannot supply
this authority.

When a pair's previous recipient endpoint is null-epoch on the same machine
and activation, the source can accept the attested epoch-N endpoint. It writes
a local pair-resume record with reason `first-home-adoption`, the prior endpoint,
and the attestation in the same transaction as the new message. A quota refusal
writes neither. Sequence numbers continue without a gap, and old retained
copies keep their original endpoints and receipt owners. This local record is
not sent as an exclusion proof and cannot authorize a cursor jump elsewhere.
Every other endpoint change still requires the existing authoritative rebind
proof; `stale-home-epoch` and strict inbound exclusion checks remain intact.

## Isolated intercom acceptance

The headless stories use the packaged extension, broker, helper, hub, supervisor,
and bridges with separate roots and real isolated Herdr cores. They use a
scripted model provider, an intercom clock, and per-edge transport faults.
The box service manager, process-start ports, SSH command, and pair connector
are fixture-owned OS boundaries. They do not prove systemd, SSH, or real-box
behavior.

| Story | Evidence and limit |
| --- | --- |
| R11 | Three-machine actions, collisions, local mailbox replay, unknown delivery, ordered progress, and same-ID retry after process exclusion. A separate local RPC case keeps Pi's queued message across an abort and reload. The rolling-adoption fixture is fork-derived, not the installed upstream package. |
| R12 | A ten-minute simulated link outage, a separate box-supervisor restart, queued and cancelled mail, an expired undelivered ask, same-ID reconciliation after a lost reply, sender return, and a late answer after reload. |
| R13 | Operator-approved pair enrollment, hub-custody drain before switching, and source-held mail rebound with its original ID, origin, receipt, audit, and exactly one injection. Original sessions adopt their first home without reload and consume pre-adoption mail. Original and fresh sessions send and ask in both directions with the hub stopped. Each ask/reply finishes within five seconds, responder health stays live, and its reverse exchange count is zero. Returning hub edges are live in both directions without relay presence. |
| R14 | An RPC child receives owner steering across the fork switchover, while peer steering follows the child's admission rules. The separate installed-upstream rolling-reload case is optional and is not evidence from R14 alone. |

The reload case aborts the active turn before reload. Pi refuses reload during
streaming, so that unreachable sequence is not counted as passed. Queue and
first-home units also verify restart and replay, original receipt ownership,
missing records, changed machines, activations and epochs, attested outbound
pair continuity, malformed presence, and unauthorized edges.

Task 4.7 still owns actual SSH, systemd, connector connectivity, and Mac-off
receipts on real machines. Peer mode stays disabled until that gate passes.

## Diagnosed duplicate todos

Migration detects duplicate `(session_id, seq)` values and records the
conflicting row IDs. The worktree remains usable for ordinary work but is not
roamable until the duplicates are deliberately resolved. Do not silently
renumber tracked todos or delete accepted rows to enable replication. After an
operator resolves the conflict, the next seed attempt checks the rows, creates
the unique index, and clears the duplicate diagnostic. Trigger-shape drift is
a separate diagnostic and disables capture without preventing the database
from opening.

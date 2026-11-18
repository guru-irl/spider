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
disable, provisioning, repository mapping, memory tagging, and session controls.
The hub also provides `spider move`, `roam recover`, `roam cancel`, `roam claim`,
and `roam forget`. Add `--json` at the end for machine-readable output. For a
machine alias starting with a dash, use `spider roam sync -- <alias>` or
`spider roam sync --machine <alias>`. Doctor supports the same forms. On a box,
only local status, doctor, and repository mapping run locally. Repository mapping
also requires the box participation flag. Other controls direct the user to the hub.

While roaming is disabled, status, doctor, enable, disable, provision, and
`stop <session>` and confirmed `forget <box>` remain available. Stop addresses a
session, not a box. Disabled forget takes the hub single-instance lock and runs
recovery without enabling roaming or starting the hub. It refuses if the hub is
running or roaming becomes enabled. Ownership recovery can finish while pane
presentation remains pending. A disabled provision does not enable the box, start
its broker, or start hosting. Enable starts
Spider's broker when needed before it checks broker health. The enable preflight
refuses if the broker cannot start or its health check fails. Reload open Pi
sessions with `/reload` to update `/move`. A command left over from an enabled
session still refuses after roaming is disabled.

For an already-signed-in destination, use the no-copy path:

```sh
spider roam provision box-1.invalid --use-destination-auth --yes --no-settings
```

This path never opens, previews, hashes, or transfers the hub's auth file. It
checks the destination's own `auth.json` presence, readability, and private mode
through the transport. `destination-auth-missing` requires signing in on the
destination before retrying. `destination-auth-unsafe` requires fixing that
file's ownership and permissions. Doctor repeats the private-file check after
installation; complete and verify the sign-in on the destination itself. Credential-bearing selected files require the separate auth-copy
path and its explicit provider consent.

Set the peer's optional `agentDir` to its absolute destination agent directory
when it differs from the default. The npm prefix comes from the configured
`<prefix>/bin/pi`; it need not be named `.local`. An explicit `agentDir` uses the
destination's observed home for safety checks and the supervisor environment.
Without `agentDir`, only the default `.local/bin/pi` layout is inferred. Other
layouts refuse with `provision-agent-directory-required` rather than guessing.
Use `--no-settings` to preserve the destination's existing settings.

Anyone with the user's shell access can run provisioning. Before `roam forget`,
confirm that the machine is destroyed. A live forgotten machine can run a second
copy until reconnection. Conversation after the last mirror and unsent workspace
edits will be lost.

Enable refuses while a usage worker is starting or being replaced; retry after
it settles. If the hub socket is unavailable, disable requires the hub lock and
a journal proving no home change is pending. A missing journal is unknown.

Exit code `0` means complete, `1` means refused, `2` means invalid arguments,
and `3` means durable pending work or reconciliation is needed.

## Cancel an unbound pending enrollment

If enrollment returns `core-changed`, do not replace the saved pins or reuse
its approval with a different operation. On the hub, run:

```sh
spider roam intercom cancel pair-1
spider roam intercom enroll --graph "$GRAPH_FILE" --operation enrollment-2
```

Approve the fresh graph at the prompt. Cancellation records that the old
operation cannot restart, then removes only its pending, unbound pair record.
It does not contact either destination or require the old core to be running.
Binding is durable before enrollment creates pair units, keys, routes, or live
fences, so an unbound operation has none of those resources to remove.
Predecessor fences remain untouched. Existing keys and other enrollments also
remain untouched.

A bound pair requires `spider roam intercom revoke pair-1` instead.
`intercom-pending-resources-present` means the unbound record contains unexpected
resource ownership metadata. Cancellation refuses rather than guessing which
resources to delete. Do not remove its metadata by hand.

Retries with saved `unavailable` fence observations probe again and request
fresh approval before setup. A real fence change still requires fresh consent;
an unavailable observation never authorizes clearing a fence.

## Box hosting and recovery

Production hosting stays disabled until phase 4 acceptance succeeds. Provisioning
installs only the supervisor service and leaves the existing core service and its
terminals unchanged. The supervisor unit uses `Requires=` and `PartOf=` for the
core. Starting the enabled supervisor at login starts the core; stopping the core
stops the supervisor. The hub's enable switch controls hub scheduling, not box
hosting.

Authentication is never copied by default. Copying selected Pi credentials
requires explicit consent for each target and provider. A missing Pi sign-in
blocks hosting but does not prevent installation. Missing tool authentication is
a warning; sign in to the affected tool separately if it is needed. Provisioning
installs the pinned runtime at the configured pi path, replacing an existing installation there.
Use `--no-settings` to omit the local `settings.json` from the copy.

Use `spider roam stop <session>` on the hub to persist a stopped intent. A
session quit also stops it. `spider roam resume <session>` runs doctor first and
refuses if blocking diagnostics remain. Doctor reports resource repairs, such as
file limits and inotify settings, for an administrator to apply; provisioning
does not make those repairs or restart the core. A core restart kills its
terminals. The supervisor restores an eligible running session from its exact
file, while a deliberate stop remains stopped. Repeated crashes suspend the
session until a successful doctor and resume.

Windows updates can silently restart WSL. After a WSL restart, the supervisor
relaunches eligible running sessions. Once it proves an owner is gone, it counts
that loss once toward crash suspension. After a Windows restart, agents stay stopped
until someone signs in to that machine's desktop. The tunnel and WSL logon tasks
also wait for that sign-in. Supervisor recovery cannot power on a machine or
sign in its host. Remote upgrade and uninstall orchestration are deferred; do not
assume provisioning performs either.

The headless acceptance stories use a packaged extension and supervisor on
owned cores, with fixture service, boot, process and limit ports. R03 checks a
core-only session, child status, and a supervisor unit installation against a
live core without app configuration. R04 restarts the
core and checks one exact-file owner and one restored trigger delivery. R05
checks crash suspension and a durable stop. They do not prove actual systemd or
real-box behavior; phase 4 owns those checks.

## Idle moves

On the Mac, `/move box-1.invalid` moves the current persistent top-level
session. `spider move <session> box-1.invalid` also accepts an unambiguous
session name or ID prefix. Use `mac` as the destination to return home.
Box-side commands direct you to the Mac without creating a move request.
Children, transient sessions, and busy sessions cannot move.

The destination needs its own Pi sign-in and a mapped equivalent Git checkout.
The move preserves the session ID, selected conversation branch, triggers,
HEAD, staged changes, working changes, and nonignored untracked files. It maps
the session's working directory to the destination checkout. Historical usage
stays on its execution machine, and each machine charges only its local segment.
Missing tool sign-ins produce warnings rather than permission to copy credentials.
The result includes the new machine-qualified intercom address and actual route
warnings. If source cleanup is pending, the destination line and warnings still
appear first, followed by the cleanup reason and `spider roam status`.

The hub freezes the source before it changes the home. A timeout does not
unfreeze the source or prove that the destination never started. Use
`spider roam recover <operation-id>` to reconcile a pending move. Cancellation
cannot return ownership after destination readiness. Rollback requires proved
launch failure and retirement, then a higher home epoch. Opening a copied
participating transcript never grants ordinary work to a nonowner.

A local agent stays native. Outward moves convert its remembered Mac space and
tab to a remote presentation, and return moves convert that tab back to native.
An unfocused pane waits for safe conversion instead of moving focus. A remote
retarget retains its proxy identity. Machine text is `This computer` locally
and the destination alias remotely. An unavailable app delays presentation,
not the ownership change.

Confirmed destroyed-machine recovery restores only the last validated mirrored
prefix at a higher epoch. It keeps the remembered Mac slot and visible or parked
intent. A reused routing alias cannot claim the restored presentation or turn a
stale close into permission to stop its new owner. Revocation remains permanent.
Conversation and workspace changes absent from the mirror are not recovered.

Version 1 does not transfer running tools or in-flight work, copy authentication
implicitly, enqueue box-side move requests, synchronize skills continuously,
or orchestrate remote upgrades and uninstallations. Moves and sync require an
awake Mac. An already active box home can continue offline.

### Isolated move acceptance

The Linux headless stories use the packaged CLI, extension, supervisor, and real
Pi on owned cores. An injected host adapter supplies fake power, service, and
limit effects. A synthetic app document observes the real presentation service
and terminal identities. Presentation-only proxy terminals do not certify
attach rendering or native window behavior.

| Story | Required observations |
| --- | --- |
| R06 | Outward identity, mapped cwd, one active owner, equal Git trees, source index bytes, local usage, deferred same-tab conversion, and remote machine text. |
| R07 | Return to the original checkout and file, higher epoch, retained history, native same-tab conversion, and local machine text. |
| R08 | Busy-source exclusion, dropped readiness replies without unsafe rollback, same-operation recovery, and rollback only after proved launch failure. |
| R09 | Sync mirrors peer history, and revoked reconnect durably stops the participant. |
| R10 | A copied participating file refuses prompts and tool work without acquiring ownership. |
| R15 | Revoked-home recovery restores the mirrored prefix, retains visible intent, and refuses a reused alias and stale close. |
| R16 | Revoked-home recovery restores the mirrored prefix, retains parked intent, and refuses a reused alias and stale close. |

Native window appearance and real-box survival remain separate observations.
A blocked observation is not a pass and does not authorize enablement.

## Move launch and cleanup

Move participants launch one exact session with `wake({ sessionId, operationId })`.
The returned `launchId` is participant-local and differs from the hub operation
ID. Retrying the request returns the same launch. Readiness is a separate,
guarded query for `{ sessionId, launchId, epoch }`. Pending readiness never
starts a second launch. The Mac resolves `SPIDER_ROAM_PI` or an executable `pi`
on `PATH`, then pins its absolute path in the hub service environment. A missing
executable reports `participant-pi-unavailable`.

The source broker owns intake inspection, generation checks, and readiness.
Its saved session endpoint and closure survive a bridge restart. A broker
restart cannot bypass the persisted fence for a session without a home epoch.

Destination presentation precedes source view removal. An absent app does not
prevent ownership from completing. A separate durable `move-presentation` task
retains the source view and retries presentation and terminal cleanup later.
A box source reads presentation proof from the hub, not its local journal.
Source cleanup verifies its own exact ID-lock claim, including the process
start identity and the unexposed lock token.

Destination cleanup does not take the live session lock. It removes only
verified move-scoped staging and exact snapshot refs. Ref deletion uses a
creation-time expected OID and bounded retries on Git lock contention. The
snapshot creator or verified bundle importer records each OID before publishing
the ref. Refs without that proof remain untouched. Changed refs
are retained. Named cleanup warnings do not turn a completed move into a
failure. Cleanup never rewrites the destination transcript, checkout, index,
configuration, leases, or session state.

## Intercom across machines

Spider owns its intercom fork and keeps the local broker and offline mailbox.
The settings switchover removes the legacy extension entry, not its package
files. A second intercom extension is a conflict, not a second relay. The
`settings-unique` check covers global settings only; project-local settings are
not checked. It identifies `pi-intercom` and its scoped variants. Doctor lists
other enabled extensions without classifying them. Broker health is
protocol-validated within the private agent directory, not authenticated.
Sessions use scope and machine-qualified names to disambiguate recipients.

A durable acceptance means the bridge stored a message. It does not mean Pi
injected the message. The sender retains the payload until a receipt identifies
a physical entry in the recipient's own session or a matching reply waiter,
or until the payload expires. An uncertain delivery stays `unknown` across
reload. After a socket handoff, a same-ID retry requires an own-session entry scan
and proof that the old generation cannot inject. A copy with no dispatch
attempt can bind to the next local activation without that impossible scan. Later messages can advance while an earlier
outcome remains unknown, up to the original-stream window limit.

The delivery and reconciliation code is in `packages/roam/src/intercom-store.ts`,
`packages/roam/src/intercom-delivery.ts`, and
`packages/intercom/src/delivery-observation.ts`.

A link outage preserves peer names and queued mail. The first transient failure
keeps active asks waiting. If its retry fails, the bridge reports `link-down`
and emits one diagnostic for the outage. An ask to a known-down edge fails
immediately. A late reply remains a message after the original waiter ends.
The payload lifetime is capped at 24 hours. The store removes expired payloads
when it processes expiry. A backward clock step preserves ordinary mail and
expires only undelivered asks without elapsed-time proof. Already injected
asks keep their consumption evidence.

The queue limits each recipient to 256 retained payloads and 64 MiB. It also
limits each origin to 4,096 message records and 256 MiB of payload, and the
machine to 16,384 message records and 1 GiB. Message counts include terminal
history and tombstones. A full queue refuses before custody with `queue-full`.
Terminal history is eligible for pruning 24 hours after its original payload
deadline, once required receipts, tombstones, and local notices are acknowledged.
Unacknowledged evidence remains retained and counts against the limits. The
store keeps pair cursors after pruning so an old replay cannot become new mail.
Receipts carry the original message's `originMachineId` and `sequence` in the
authenticated pair envelope. Relays preserve both fields. They do not name the
receipt's sender or the session's birthplace. A retained message record with
different stream fields causes `receipt-stream-mismatch`.

A durable settled watermark is keyed by authenticated peer, original message
origin, sender address, and recipient address. Covered receipt slots are
acknowledged without applying their claimed outcomes. Old digests need no
retained hash below that watermark. Live messages still receive full validation.
Above the watermark, a pruned settled slot requires a matching message ID,
digest, and recipient owner hash. One hash per sparse slot is retained until
the watermark passes it. An unknown earlier slot stops that advance. The
outbound original-stream window uses the configured queue-message limit, 256
by default, and returns `queue-full` before sparse hashes can grow past it.

Expiry notices are durable and do not repeat after a bridge restart. Exited,
unreferenced generation and adoption records reduce to compact ownership
records. Live process evidence and queue references prevent that pruning.

Hub-only routing depends on the hub and cannot deliver between boxes while the
hub is off. Approved peer enrollment adds a dedicated connector, key, and route
for one box pair. Enrollment does not enable unrelated pairs. The bridge and
transport are implemented in `packages/roam/src/intercom-bridge.ts` and
`packages/roam/src/intercom-exchange.ts`.

Each machine's operator supplies a connector recipe with `check`, `host`, and
`connect` argument arrays and `localPort`. The optional `pairPorts` map overrides
`localPort` for individual pairs. Unit arguments can use `{pairId}`, `{tunnelId}`,
`{remotePort}`, and `{localPort}`. The host command must forward to IPv4
`127.0.0.1` at the pair's approved `remotePort`, not `localhost`. The hub
requests a scan on that port through the trusted machine channel. The target
pins a presented key only if it matches a root-owned system host public key in
`/etc/ssh`. Both the directory and key file must be root-owned and not writable
by other users. The key file must be a regular file, not a symlink. A scan alone does not prove
that the listener holds the corresponding private key. The later peer SSH
connection checks the server's signature against the pin. A listener that only
replays the public key cannot complete the key exchange. Machines that share a
host key cannot be distinguished by that key, so operators must give each
machine its own host key. A doctor run scans one port and pinned key type, then
reports any pairs it could not check as
`intercom-ssh-check-deferred`.

### Protocol versions

Replication batches use protocol 1. Intercom exchanges use federation
protocol 4, which requires original-stream fields on receipts and retains
`peer-revoked` refusals and revocation receipts.
The local broker feature `federation-v1` and the helper envelope version 1
are separate from the intercom exchange version. They do not make an older
exchange compatible with protocol 4. Protocol 4 predates cross-machine intercom
deployment, so old-format receipts have no compatibility path. Missing receipt
stream fields cause `receipt-stream-missing`. Store schema 7 migrates queued
receipts from retained original identities.

An exchange with a different safe integer protocol version is refused with
`peer-version-mismatch`. The bridge performs a version handshake before it
sends message frames on a new edge. The version and validation are defined in
`packages/roam/src/intercom-contracts.ts`, `packages/roam/src/intercom-codec.ts`,
`packages/roam/src/intercom-helper.ts`, and `packages/roam/src/intercom-bridge.ts`.
Replication batch validation is in `packages/db-core/src/roam/codec.ts`.
Proved `machine-mismatch` and `peer-revoked` errors stop retries for the current
edge epoch. `machine-not-enrolled`, helper startup, authorization, protocol-version,
and reply errors keep queued mail and retry with backoff,
including after a restart. Fresh durable pair approval clears transient
backoff. Replaying the same approval does not.

### Origin authentication

`originMachineId` identifies the machine that first accepted a message. The
store retains it when forwarding the message or replacing it with a tombstone,
and rejects a conflicting origin for the same message ID. The transport
checks the enrolled peer. The receiving bridge also checks that the origin is
allowed on that edge. A direct edge accepts its peer as origin. In hub-only
mode, a box can also accept a configured relay origin through the hub. A
missing origin is refused with `missing-origin`, and an unauthorized origin
fails with `machine-not-enrolled`. This check trusts the authorized edge and
route configuration; it is not an end-to-end signature.

The checks are in `packages/roam/src/intercom-runtime.ts`,
`packages/roam/src/intercom-bridge.ts`, `packages/roam/src/intercom-codec.ts`,
and `packages/roam/src/intercom-store.ts`.

### Pair revocation

Revocation first writes a durable pair fence and failure receipts in one local
transaction. The bridge rejects the fenced edge with `peer-revoked`, aborts its
active exchanges, and waits for them to close before resource cleanup. Queued
and uncertain copies for that peer are marked cancelled, and open asks fail
with `peer-revoked`. An uncertain copy can already have been transmitted, so
cancellation does not prove that the recipient did not inject it. The bridge
retains local failure notices until the addressed session confirms them and
routes relay receipts back toward the origin.

The revocation process fences the other endpoint when reachable and checks
pair-owned access and connection cleanup. If the pair host is unreachable or
required closure evidence is missing, cleanup remains unconfirmed. The pair
host can remove its key even when the connecting box is unreachable, but other
cleanup can remain pending. Missing key-removal evidence returns exit code 3
and `intercom-revocation-unconfirmed`; recovery retries the same cleanup.
Shared jobs can also leave cleanup pending.

Enrollment grants command access as the peer user, including access through
that peer's enrolled pairs. SSH ignores user configuration with `-F /dev/null`.
Each key has a forced command that verifies its pair, edge epoch, and current
registration before executing the approved user's command. This is not a
physical tunnel boundary. A key can reach the same loopback SSH service through
another open tunnel, and deleting a key does not close an existing connection.
Consent states this remaining reach. Pair revocation stops its owned host and
removes its key rather than claiming closure from key deletion alone.
Re-enrollment needs fresh consent for the recorded fence and a new edge epoch.
The implementation is in `packages/roam/src/intercom-store.ts`,
`packages/roam/src/intercom-bridge.ts`, and
`packages/roam/src/intercom-enrollment.ts`.

### Fork parity and declared divergences

Spider checks its intercom fork against the recorded upstream baseline to keep
unintended runtime changes and lost upstream test assertions visible. The check
uses `packages/intercom/upstream-assertions.json` and the provenance hashes in
`packages/intercom/ORIGIN.md`. Run `node scripts/check-intercom-parity.mjs --manifest`
to compare the fork with those records.

For an intentional runtime difference, add an entry to
`packages/intercom/DIVERGENCE.json` with the path relative to
`packages/intercom/src`, a task identifier such as `3.6a`, a nonempty one-line
reason, and the upstream SHA-256. Use `null` for a new file without an upstream
baseline. The fork's `local.ts` uses the upstream hash for `index.ts`, while the
fork's new `index.ts` uses `null`. The check rejects missing, duplicate, stale,
and incorrectly hashed entries, as well as unlisted new runtime files. A
declaration does not waive the upstream test case and assertion checks. The
rules are implemented in `scripts/check-intercom-parity.mjs`.

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
`intercom-route-missing <peer>` rather than relaying in peers mode. Later
enrollment retries those source rebinds under the original transition ID and
writes one audit row per copy. Stranded relay copies do not wake the old hub
route. Receipts fenced by a revoked pair do not block the topology drain.

An unreachable box remains pending with `intercom-transition-pending <box>`.
A hub restart resumes the durable transition. A box restart restores its mode
and audit from the queue, and replaying the same switch adds no route changes
or audit rows. Already-switched boxes continue directly while the hub is down.
Unswitched boxes keep source mail queued behind the hub's intake fence.
The reverse transition refuses with `intercom-transition-unsupported`.

The transition is implemented in `packages/roam/src/intercom-topology.ts`,
`packages/roam/src/intercom-bridge.ts`, and
`packages/roam/src/intercom-runtime.ts`.

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
The edge selection and lease are implemented in
`packages/roam/src/intercom-runtime.ts` and `packages/roam/src/intercom-bridge.ts`.

### First-home adoption and retained mail

First sync can assign the first home to an already-running local-origin
session. The original process refreshes its advertisement through admission
and ownership readiness, without a reload, a new activation, or another lock.
Foreign homes, epoch bumps, freezes, and unsafe capture do not qualify.

A home-less remote presence claim requires a synced session origin record
that names the claiming machine. Without that record, or when it names another
machine, the receiver refuses with `presence-origin-unknown` and doctor reports
`intercom-presence-origin-unknown`. The claim is retried after the next sync.
This applies in hub-only and peers modes, including when the hub link is down.
A box-native session therefore stays unreachable from other machines until
its origin record syncs, but its local work continues.

A matching origin does not override other ownership evidence. No other current
claim may exist, including hub-local sessions. No durable home, session origin,
first-home adoption, or past-presence record may name another machine. This
includes offline local sessions. The first accepted machine and activation
persist across restarts. A later different-machine claim makes the address
ambiguous, even after the first machine goes offline. Ambiguous addresses
refuse sends with `presence-ambiguous`, and doctor reports
`intercom-presence-ambiguous`. A known home requires an exact machine and epoch
match. Cached rosters undergo these checks again before publication after a
restart. Display fields have per-field length limits, and the codec removes
ANSI and C0/C1 escapes before broker publication.

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
this match. Never-dispatched mail can rebind to the next activation on the same
machine, including a null-to-first-home epoch change. A prior socket handoff
still requires complete old-generation exclusion and absence evidence.
Consumption evidence from the replacement activation settles the same message
at its original source. Bounded endpoint aliases acknowledge lost-link-ack
replays without changing the new endpoint or dispatching twice. Adoption is
not a general move permission.

Concurrent readiness calls share one in-flight drain per address. New inbound
mail or a later readiness transition requests another serialized pass. Only a
client connection preflight failure, before any socket write, restores the
matching endpoint and dispatch attempt to queued state for a later readiness
event. Write errors, disconnects after a write and timeouts remain unknown;
they never authorize a retry without physical exclusion evidence.

For subsequent sends and asks, the recipient rebuilds a first-home attestation
from that durable record: `{ activation: A, fromEpoch: null, toEpoch: N }`.
Presence accepts it only in this exact form, bound to the advertised activation
and epoch, from an edge authorized for the recipient machine. The persisted attestation
remains usable while that edge is down. Malformed
attestations fail with `invalid-presence`; dispatch arguments cannot supply
this authority.

When a pair's previous recipient endpoint is null-epoch on the same machine
and activation, the source can accept the attested epoch-N endpoint. It writes
a local pair-resume record with reason `first-home-adoption`, the prior endpoint,
and the attestation in the same transaction as the new message. A quota refusal
writes neither. Sequence numbers continue without a gap, and old retained
copies keep their original endpoints and receipt owners. This local record is
not sent as an exclusion proof and cannot authorize a cursor jump elsewhere.
Other endpoint changes require authoritative rebind proof, except the
never-dispatched local activation change described above. `stale-home-epoch`
and strict post-handoff exclusion checks remain intact.
The adoption and delivery checks are in `packages/roam/src/intercom-first-home.ts`,
`packages/roam/src/intercom-store.ts`, and `packages/roam/src/intercom-delivery.ts`.

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
receipts on real machines. Keep peer mode disabled until phase 4 acceptance succeeds. The stories are in
`packages/herdr/e2e/scenarios/roam-intercom.test.ts` and
`packages/herdr/e2e/scenarios/intercom-fork.test.ts`.

## Diagnosed duplicate todos

Migration detects duplicate `(session_id, seq)` values and records the
conflicting row IDs. The worktree remains usable for ordinary work but is not
roamable until the duplicates are deliberately resolved. Do not silently
renumber tracked todos or delete accepted rows to enable replication. After an
operator resolves the conflict, the next seed attempt checks the rows, creates
the unique index, and clears the duplicate diagnostic. Trigger-shape drift is
a separate diagnostic and disables capture without preventing the database
from opening.

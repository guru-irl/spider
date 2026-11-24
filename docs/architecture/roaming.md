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

The Herdr sidebar uses the owner feed for run activity. See the [Herdr guide](../guide/herdr.md#the-left-sidebar) for status and retention behavior.

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
only local status, doctor, store pruning, and repository mapping run locally. Repository mapping
also requires the box participation flag. Other controls direct the user to the hub.

While roaming is disabled, status, doctor, enable, disable, provision, and
`stores prune`, `stop <session>`, and confirmed `forget <box>` remain available. Stop addresses a
session, not a box. Disabled forget takes the hub single-instance lock and runs
recovery without enabling roaming or starting the hub. It refuses if the hub is
running or roaming becomes enabled. Ownership recovery can finish while pane
presentation remains pending. A disabled provision does not enable the box, start
its broker, or start hosting. Enable completes read-only preflight on every
box before starting services. The box startup command resolves settings and
completes the other doctor checks before starting Spider's broker when needed.
It then waits for a protocol-valid health reply with federation support and
returns the final doctor report. Enable consumes that report without another
doctor pass, which could outlive a sessionless broker's idle shutdown.

Startup uses the existing control deadline and adds no retry loop. A startup
failure or blocking readiness report leaves enable pending before capture or
participation flags change. Text and JSON retain a bounded cause, such as
`broker-start-timeout`, `unsupported-broker`, or `intercom-broker-unavailable`.
Malformed replies or mismatched machine identities report `invalid-reply`.
Reload open Pi
sessions with `/reload` to update `/move`. A command left over from an enabled
session still refuses after roaming is disabled.

On macOS, the default global root keeps the `com.spider.roam.hub` LaunchAgent
label. Other roots use that label with a suffix derived from the canonical root,
so separate roots do not share a plist or service. Disable removes a plist only
after its definition proves it belongs to the selected root. A missing service
is safe to remove; after a failed bootout, a service-specific `launchctl print`
can confirm absence. An unrelated error does not prove absence.

If the Mac is disabled but box participation flags cannot be confirmed,
`spider roam disable` returns `roaming-disabled-partial` with exit code `3`.
The result names the unconfirmed boxes and the exact retry command,
`spider roam disable`. Captures and homes remain intact. A retry reuses each
box's latest matching pending disable operation ID and its consent record.
A newer enable decision prevents replay of an older pending disable operation.
Code `0` means both local disable and every box flag are confirmed. Both
outcomes tell open pi sessions to use `/reload` to pick up the local change.

Enable checks the local role before resolving `dist/roam/cli.mjs` from the
installed package and using it for `roam hub`. A box returns `mac-hub-required`.
An unavailable installed entry on a hub returns `enable-unavailable` without
changing configuration. The imported `cli-main.mjs` module is not an executable
service entry. Runtime and pane endpoint libraries never execute their CLI on import.
Their dedicated entries retain the packaged remote runtime and pane commands.
Hubs enabled on an earlier release must run `spider roam enable` again after
upgrading, to reinstall the service with the correct entry.

An enabled flag does not prove that the hub started. Doctor uses the same
read-only status probe as enable, with a two-second bound. A starting service
can become ready during that window; a socket file alone does not prove readiness.
Doctor reports `hub-startup-pending` when the service is not running, or when a
running service still does not answer a ready status probe after the bound.
Unknown service metadata produces a `hub-startup-unverified` warning, not a block.
The diagnostic includes the service's last exit code, or `unknown`, and its
error log path without reading the log. Check the hub service and that error
log on the Mac hub before retrying. Doctor never changes the enabled flag,
starts a service, or prescribes a restart for a slow startup.

When enable or disable needs reconciliation, text and JSON include a bounded
`causeCode`. Sync agent refusals and intercom enrollment pending results also
report bounded causes, using `unexpected-<step>` when the error has no known
code. Sync failures identify the operation kind and ID; answered recovery
refusals such as `roaming-disabled` stay distinct from transport failures.
Cause and operation-kind fields never copy exception text or paths. Resolve the
cause and retry the same operation rather than relying on a doctor result with
no finding.

Pair enrollment retries a native `unreachable` route-add failure with bounded
backoff, at most eight attempts within a 40-second add deadline. A new attempt
starts only when at least five seconds remain. If the budget is too short, the
result retains the `unreachable` cause. Each attempt rechecks the existing route
and pinned peer identity. Other native failures are not retried, and the reported
cause contains no command stderr.

Store inventory never treats an unreadable store as deleted. The agent's
`stores` reply includes readable keys and an `ungathered` list. Each ungathered
entry names its path, scope, known store key, and a code such as `missing`,
`unreadable`, `corrupt`, or `unsafe`. A registered store whose identity cannot be
read has a null key. A mapped key takes precedence when both entries name the
same path. Discovery remains successful for the other stores, including global.

Sync connectivity failures with code `1` or code `3` back off after 30, 60,
and then 120 seconds, even when `syncMs` is shorter. A round resets that
backoff when the enrolled peer answers and no result reports a connectivity
failure. Ungathered and refused stores keep their own diagnostics but do not
block the reset. An identity mismatch cannot prove the enrolled peer answered.

Sync gathers every enrolled box's inventory before transferring store batches.
An ungathered mapped key cannot receive imports, exports, or an initial session
home on any box. Other keys keep syncing. When a registered project store has no
readable identity, initial worktree homes wait conservatively until its identity
can be established. Existing homes do not become unassigned. Placement retains
unconfirmed session slots while any registered or mapped store is ungathered.

Enable succeeds with warnings that name each ungathered scope and path. Doctor
reports `store-missing:<scope>:enoent` or
`store-uninspectable:<scope>:<check>` as a warning with the path. Cached status
remains incomplete until every store is gathered. Restore or mount a missing
path, or repair its permissions or database. WAL diagnostics retain their
writer-open and recovery guidance. One broken project store does not block the
box's other stores. An unreadable global catalog still prevents discovery.

A mapped worktree can exist before capture creates its project database.
`mapWorkspace` accepts this state when no replica needs merging. Inventory does
not create a database to inspect it. Planned stores remain ungathered until
created. Pruning keeps an existing empty mapped directory, so its warning does
not mean that prune can remove it. Sync checks capture on readable memory stores
and enables it when a previously unavailable store returns. An unassigned mapped
store must first pass read-only layout inspection. Worktree capture
remains session-scoped and uses the existing admission and seeding rules.

Run `spider roam stores prune` on the affected machine to inspect candidates.
The default is a dry run. Add `--confirm` only after confirming deletion. The
command works while roaming is disabled. A candidate must have a missing leaf
and an existing, readable, canonical parent directory. Missing parents and
symlinked paths are `unavailable`, with mount-or-restore advice, not candidates.
Permission errors abort the transaction and report a bounded path and check.

Confirmed pruning deletes missing project registrations, clears missing
repository references on retained projects, and removes missing mapping
directories with their redirects. A workspace needed by a live session home or
an unfinished home action stays registered. Pruning never deletes store files,
replica data, or session locations. The registry edits and a `store-prune` audit
entry commit in one transaction. Repeating a completed prune changes nothing.

The audit is local, not replicated. In the affected machine's global database,
`roam_cursors` rows with `peer_machine = ''` and a `peer_stream` beginning with
`spider-local:store-prune:` retain the full original rows and redirect targets.
These include project paths, repository fingerprints and commands, and workspace
snapshots. The audit supports manual restoration after a mistaken prune.

Remote doctor reports `roaming-config-unavailable` if it cannot read the local
roaming configuration, and `machine-not-enrolled` if the requested machine is
not in that configuration. These checks run before any peer connection. The
text output names the reason code and says remote doctor is unavailable. JSON
returns the same code in `reason`.

Enable and remote doctor distinguish a proven remote transport failure from a
local transport failure or an answered agent refusal. Known remote connection
failures return `box-unreachable:<box>` with the existing forget advice. Local
`missing-hc`, `spawn-error`, `spawn_failed`, and `core-unavailable` failures return
`preflight-failed:<box>:local-herdr-unavailable`. Start Herdr or check `hc` on this
machine, then run `spider roam doctor`. Never forget a box to repair local Herdr.

A timeout or generic process exit does not prove that the box is unreachable.
These return `preflight-failed:<box>:peer-command-timeout` or
`peer-command-failed`, with doctor as the repair. A legacy incomplete-inventory
refusal retains `store-inventory-incomplete`. Malformed replies return
`peer-response-invalid`. Legacy agent refusal text maps to `agent-operation-failed`
or `capture-unsafe`. Arbitrary exception text is not copied into these codes.

Sync retains allowlisted agent codes in its per-peer outcomes. Unknown agent
refusals use `peer-<operation>-refused` rather than free text that the public
boundary would replace with `control-failed`. A move that fails before its
check completes retains a typed cause in its refusal blockers. Unknown
exceptions use `preflight-check-unavailable`; they never expose exception text.

For an already-signed-in destination, use the no-copy path:

```sh
spider roam provision box-1.invalid --use-destination-auth --yes --release "$RELEASE_FILE"
```

Set `RELEASE_FILE` to the release archive, or omit `--release` to use the bundled
release. This mode never inspects or transfers hub agent files. The destination
keeps its own auth, models, settings, keybindings, themes, instructions, and
skills. Copy-selection flags do not opt files into this mode.

Provisioning checks the destination's own `auth.json` presence, readability,
ownership, and exact mode `0600` through the transport without reading its contents.
`destination-auth-missing` requires signing in on the destination before retrying.
`destination-auth-unsafe` requires fixing the file or its parent directories.
The post-install check uses the same mode requirement. Complete and verify
sign-in on the destination itself.

On the hub, edit the existing peer entry in `<hub-global-root>/roam/config.json`
to set `agentDir`. Keep the peer's other fields. For example:

```json
{
	"alias": "box-1.invalid",
	"pi": "/home/example/prefix/bin/pi",
	"agentDir": "/home/example/agent",
	"coreUnit": "hc-serve-0a1b2c3d.service"
}
```

The top-level `coreUnit` belongs to the machine whose roaming config contains
it. A hub's value never selects a destination's unit. Each hub peer can set its
own optional `coreUnit`, as shown for `box-1.invalid` above. A peer's unit must
name a concrete service, not a template such as `hc@.service`. The first
provision records the destination unit in the box's top-level `coreUnit`.
This name is diagnostic only. The supervisor has no dependency on the core's
systemd unit. Reprovisioning an enrolled box doesn't rewrite the recorded name,
and a transient unit's name can change after the core stops and starts.

When a peer omits `coreUnit`, the destination discovers existing `herdr`,
`herdr-core`, `hc`, or `hc-core` services, including their instance names, and
`hc-serve-<hex>.service` units. A candidate must have the same systemd main PID
as the peer's configured `core` reports. The reported core identity must also
match the transport's identity. Discovery includes persistent user unit files
and transient units. A transient unit must report `Transient=yes`, and its
`FragmentPath` must be exactly `/run/user/<uid>/systemd/transient/<name>`.
That file must be regular, owned by the user, and not a symlink. Its systemd
`MainPID` must match the core's reported PID. Explicit transient `coreUnit`
values pass the same checks. Malformed or conflicting systemd properties fail
closed. Doctor reports the observed unit and whether it is transient.

Discovery requires exactly one match and keeps the unit-name and safe-directory
checks. No match returns `peer-core-unit-required`. Several matches return
`peer-core-unit-ambiguous`. Set that peer's `coreUnit` before retrying either
refusal. A missing recorded unit does not block provisioning when the core's
socket is owned by the user.

The npm prefix comes from `<prefix>/bin/pi` and need not be named `.local`.
Provisioning runs npm lifecycle scripts but skips optional CUDA downloads.
The box-side process sets umask `022` before creating files or starting any
child, including version and verification probes. It handles one request and
exits, so it does not restore the login mask. Provisioning creates missing
staging, prefix, release, and agent directories, including missing ancestors,
with mode `0700`.

Before installing or reusing a tree, provisioning removes group and other write
bits from entries it owns in installer-created prefixes, release roots, and
staging. Private creation receipts bind each root to its path, device, inode,
and owner. A pre-existing tree without that proof remains user-owned.
The walk never follows symlinks. It permits internal npm links but refuses
outside links, foreign owners, and unsafe file types without chmodding them.
The private `permission-tightening.json` receipt records only a changed-entry
count, capped at 1,000,000, rather than changed paths. Successful provisioning
also reports the count in text and as `value.permissionTightenings` in JSON.
Zero means no entries were tightened. A count of 1,000,000 means at least that
many. If the count cannot be read, provisioning succeeds with a `null` count.
A completed operation saved before this count was reported also returns `null`
on replay. The public count never includes paths.

`destination-permissions-unsafe` identifies a user-owned path with group or
other write access. For an unmarked pi package or release tree, the reported
`chmod -R go-w '<root>'` repairs the entire tree in one command. Recursive repair
is accepted only for those exact package roots, never their shared parents or
children. Other paths keep a single-path `chmod go-w` repair. These include the
agent directory chain, `extensions`, selected-file parents, and prefix parents
such as `~/.local/bin`. The read-only preview checks the agent chain,
`extensions`, and selected-file parents before consent, including a configured
`PI_CODING_AGENT_DIR` chain. The installer checks them again before writing.

Run the reported shell-quoted command on the box and retry with the same
options. Several writable user-owned parent directories can require separate
repairs. Paths with control or bidi characters never produce a repair command.
A later `pi update` under umask `0002` can reintroduce writable entries.
Installer-created trees are tightened on reuse. Unmarked user-owned package
trees need the recursive repair again.

Release evidence relies on the core's server-side label filters. Herdr 0.1.16
omits labels from terminal rows, so when a row has no labels, provisioning also
checks that the same machine filter with a random operation label returns no
rows. A nonempty result refuses the evidence with `release-evidence-unfiltered`.

`npm-not-found` means npm is missing next to the configured Node executable.
The error names the expected path. Install npm there or update the peer's Node
path to an installation with an adjacent npm executable.

`npm-install-failed` means an npm command could not start, failed, or timed out.
The CLI names the destination's private release receipt. Its `diagnostic` records
only the install step (`pi` or `release`), exit code or signal, an allowlisted
npm code such as `E404` or `1`, and a validated package name from a reported
`node_modules` path. A timeout also records `timedOut: true`, which is absent
for other failures. Unavailable fields are `null`. The receipt is mode `0600`;
it does not store npm output or URLs.
After fixing either error, retry without `--operation-id` or use a new operation
ID. The same operation ID does not retry a failed release installation.

The configured agent directory must already exist under the destination's home.
Set the box's core environment to export `PI_CODING_AGENT_DIR` with that
directory. The box's `agentDirectory` setting must agree too. Spider's units
and hosted-session launcher set the directory explicitly, so the systemd user
manager does not need an override. If the manager has a non-empty override,
it must resolve to the configured directory. Provisioning refuses a mismatch
with `agent-directory-mismatch` before installation. It does not change or restart
the core. Changing the core environment can require a restart that kills its
terminals, so arrange that separately before provisioning.

Remote agent operations, broker startup, doctor, and the supervisor all receive
the configured directory. Local box commands use the box environment.
Box doctor resolves the pi SDK from the active release's npm prefix.
Without `agentDir`, only the default `.local/bin/pi` layout is inferred. Other
layouts refuse with `provision-agent-directory-required` rather than guessing.

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
its approval with a different operation. For an unbound pair, run on the hub:

```sh
spider roam intercom cancel pair-1
spider roam intercom enroll --graph "$GRAPH_FILE" --operation enrollment-2
```

For a partially completed graph, cancel only its unbound pending pairs.
Unchanged siblings can resume with the original graph and operation.
Include only cancelled pairs in the fresh graph, with fresh epochs when a
predecessor was revoked. Keep active pairs in place.

Approve the fresh graph at the prompt. Cancellation prevents only that pair
from restarting under the old operation and leaves a durable cancellation
receipt. Repeating cancel exits `0` without further effects. An already-absent
record also exits `0` with `intercom-pair-absent`. Cancellation does
not contact either destination or require the old core to be running.
Binding is durable before enrollment creates pair units, keys, routes, or live
fences, so an unbound operation has none of those resources to remove.
The receipt retains any inherited predecessor fence until live enrollment
clears it. After fresh consent is approved, the pair key can run commands before
the route is added and the transport is verified. Messaging stays fenced until
live enrollment succeeds.
Existing keys and other enrollments remain untouched.

A bound pair requires `spider roam intercom revoke pair-1` instead.
`intercom-pending-resources-present` means the unbound record contains unexpected
resource ownership metadata. Cancellation refuses rather than guessing which
resources to delete. `intercom-predecessor-cleanup-pending` means an earlier
revocation still needs cleanup. Run `spider roam doctor` to inspect it.
Do not remove the metadata by hand.

Retries with saved `unavailable` fence observations probe again and request
fresh approval before setup. A real fence change still requires fresh consent;
an unavailable observation never authorizes clearing a fence.

## Box hosting and recovery

The hub treats native `disconnected`, plain `unreachable`, and `stopped`
machine states as unreachable. The exception is native `unreachable` with
the exact reason `a different core answers there ("<core-id>")`. That means
a remote core was replaced, not that transport was lost. The hub and machine
UI use one shared classifier for this case. A local core identity change
during inventory also remains unknown. Generic unknown observations retain an
already scheduled outage alert, existing outage state and delivered alerts.
A replaced remote core cancels the pending alert timer. Neither observation
schedules move recovery. A replaced remote core discards the old
peer's pending reconnect trigger. Its next connected observation is not a
reconnect. A later plain unreachable observation
resumes the retained outage. A machine with hosted sessions gets one hosting alert
after ten minutes. `needs_login`, `needs-login`, and other uncertain states
neither start an outage nor clear one. Literal `connected` clears the hosting
outage alert even when the peer refuses sync content. Sync refusals retain
their own diagnostics. An answered round without a connectivity failure resets
an established sync backoff.
Hosting checks, placement and suspension warnings still run when the native
state is `connected` and the enrolled peer answered, even with ungathered or
refused stores. A mid-round peer command exit does not remove an answered
peer from hosting checks. A code-3 connectivity failure makes the reply
uncertain and suppresses those checks for that round.
Live move recovery requires a separate proof: literal `connected` plus an
answer from the enrolled peer without a connectivity failure in the current
round. Session mirror export and copy failures also count as connectivity
failures when the transport stops answering. An answered mirror refusal does
not block connectivity proof. Ungathered or refused stores do not block this proof. Recovery still
checks the move's own journal and ownership evidence before making progress.

Machine-intercom initialization retries failed setup after 1, 2, 5, 10, and
then 30 seconds. Its status stays pending during the outage. Successful setup
resets that backoff and becomes ready without restarting the hub. Shutdown
cancels pending setup retries and waits for the current attempt to drain.


Production hosting stays disabled until phase 4 acceptance succeeds. Provisioning
installs only the supervisor service and leaves the running core and its terminals
unchanged. It enables the service under `default.target` only when the box passes
hosting readiness checks; otherwise it disables autostart, including an existing
enablement. Provisioning never starts or stops the service. Readiness controls
autostart even when the hub is disabled; the hub switch separately controls box
participation. After peer preflight passes, `spider roam enable` attempts to
restore supervisor autostart on each box with an installed unit, without starting
the supervisor. A missing unit or a failed systemd command does not prevent
participation. Doctor warns when an enabled box has disabled or runtime-only
autostart and suggests `spider roam enable` on the hub. If the unit is missing
or its autostart state cannot be verified, doctor warns to check the unit and
systemd user service. The unit has `Restart=on-failure`, `RestartSec=10s`,
`StartLimitIntervalSec=0`, and a private umask. Persistent startup failures
therefore retry without a start-rate lockout.
The unit has no `After=`, `Requires=`, or
`PartOf=` dependency on the core unit.

Enrollment saves the peer's absolute `core` executable, core identity, socket,
session namespace, and state and config directories in private `roam/core.json`.
At startup, the supervisor uses that pin to run `hc server start --json`.
This attaches to a running core or starts a stopped one, including at login.
The supervisor never selects an `hc` from `PATH`. It refuses `core-pin-changed`
if the core identity differs from enrollment. A missing pin refuses
`core-pin-required`. Reprovision an existing box to add its missing pin.
Enrollment verifies the executable, socket, namespace, and XDG directories with
`server status --json` before saving the pin. The core identity and PID must
match the enrolled core. Terminal-specific hc variables are removed for this check.

To replace a stale identity or change the pinned executable or socket:

1. Move every session assigned to the box back to the hub with
   `spider move <session> mac`.
2. Run `spider roam disable` on the hub.
3. Run `systemctl --user stop spider-roam-supervisor.service` on the box.
4. Run `spider roam provision <machine> --replace-core-pin` on the hub with the
   same authentication options you normally use for provisioning.
5. After doctor reports no blocks, start the supervisor on the box with
   `systemctl --user start spider-roam-supervisor.service` and run
   `spider roam enable` on the hub.

Replacement refuses with `core-pin-in-use` while the box hosts sessions, while
roaming remains enabled, or while the supervisor is active. The hub checks its
authoritative session homes. The box also checks its local homes and service
state. Replacement journals the previous and replacement pins before the atomic
write. The hub journal retains both core identities, but CLI output shows only
their SHA-256 hashes. Repeat the same operation ID and options after a lost reply.
Ordinary provisioning never replaces a conflicting pin. A changed identity is
`core-pin-changed`; changed pin settings are `core-pin-conflict`.

After `server start`, the supervisor takes its baseline PID from the first
`server status` reply. Both commands use the pin's environment without inherited
`HC_TERMINAL_*`, `HC_SCOPE`, or other per-terminal hc settings.

While running, the supervisor checks core availability and process identity
every ten seconds. Three consecutive unavailable checks stop hosting and exit
with a diagnostic so systemd can restart the supervisor and ensure the core
again. A successful check clears the failure count. A confirmed PID or core
identity change stops hosting immediately.

The supervisor restarts a stopped pinned core, so `hc server stop` does not stay
stopped while hosting runs. First run
`systemctl --user stop spider-roam-supervisor.service` on the box to stop
hosting, then stop the core. The hub's enable switch controls hub scheduling,
not the systemd supervisor's restart policy.

Doctor blocks hosting for a missing, unsafe, unreadable, or changed pin. A
missing pin requires reprovisioning. A changed identity requires the explicit
replacement procedure above. An unreachable pinned core is a warning because
the supervisor starts it. Doctor reports the core unit as information, not as a
hosting prerequisite.

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

A pending exact launch blocks doctor and enable even when roaming is disabled.
Doctor names the launch operation. For a reservation that has not reached the
`invoking` phase and has no ID lock, doctor offers `spider roam stop <session>`
on the hub. Stop clears that reservation to idle without a restart proof,
because the launch never began. An invoking reservation with no ID lock is not
proof that its adopted owner exited.

If a released adoption record names the session and launch operation, stop can
settle that reservation after positive exit proof. The recorded boot must match
the current boot, and the recorded PID must be absent. PID reuse, a different
boot, or an unavailable process probe refuses this settlement. The file lease
must be absent or its holder must also be absent on the same boot. Stop checks
that file against the durable intent authority. It never infers exit from an
hc-client exit, an empty handoff directory, or a matching core ID.

The released-owner proof and journal settlement run under the same session-ID
mutex as adoption. A child claims the ID lock before the file lease. With no
pending ID lock, a late child cannot reuse the consumed handoff. Stop retains
the released adoption record and launch history. It records
`exact-adopted-owner-ended` and `exact-launch-settled`, completes the launch with
`launch-ended`, and then sets supervision idle. The desired state remains
stopped. Stop finishes an interrupted journal completion before clearing the
reservation. A failed intent compare-and-swap can retry without duplicating the
settlement. Repeated stop does not relaunch the session.

Doctor distinguishes a live adopted owner from unavailable owner status. For a
live owner, close that session through its supported shutdown path, then stop
again. For unavailable status, restore local process and boot identity
inspection before retrying. If adoption evidence is missing, doctor checks the
actual pin and core and names the missing evidence. It prescribes core startup
or pin repair when needed, not another doctor command.

For a pending handoff, doctor offers `spider roam stop <session>` on the hub,
not provision. Box doctor explicitly names the Mac hub as where to run that
repair command. Stop preserves the stopped intent and never relaunches the
session. Stop refuses to settle a handoff whose operation differs from the
session's launch reservation, including a move's launch. It releases the pending
ID lock, launch handoff, and file lease only when both checks succeed:

- The recorded launcher has exited, using its boot ID and PID probe. PID reuse
  must have a different process start identity.
- The exact-launch reconciler proves that no terminal started, that the
  operation's terminal exited without adopting the session ID lock, or that a
  recorded start has since ended without adoption.

The pending record belongs to the launcher, usually the supervisor, before
adoption. Its exit alone does not prove that the Pi child exited. A live launcher,
a live terminal, missing boot evidence, or an uncertain terminal keeps the launch
blocking. Stop returns `launch-reconciliation-required` and points to doctor.
On the destination, inspect the recorded launcher PID, boot ID, ID lock, file
lease, and the terminal labelled `spider.roam.operation=<operation>`, using the
pinned core. The pinned core must be running to inspect its terminal evidence.
An absent terminal row alone is not exit proof. Stop can settle a recorded start
whose terminal history disappeared after a restart of the same pinned core.
This `started-launch-ended` proof requires all of these facts:

- The launcher's boot ID is unchanged, and its PID is absent or has a different
  process start identity.
- The file lease is absent or still names that exited launcher. A child-owned
  lease or a `ready-durable` journal record prevents settlement.
- Every recorded `exact-core` and every current core observation matches the
  handoff's `pendingCoreId`. The core is reachable throughout the listings.
- Two complete finished-inclusive listing samples, at least 250 milliseconds
  apart, show no live terminal with the operation, latest attempt, or session
  label. Each sample combines three `hc ls --all --json --label` queries because
  multiple labels in one query select their intersection, not their union.

Finished history for other terminals does not block settlement. If the recorded
terminal appears finished, its existing terminal-exit proof applies instead.
Failed or incomplete listings, a changed core or boot, or uncertain process
ownership preserve the pending handoff. The journal records
`exact-started-launch-ended` with identities and sample times, without session
contents or launch environment values. Its outcome is `launch-ended`, not
`launch-not-started`. Ordinary launch reconciliation does not use this proof to
retry a launch. Stop retains the stopped intent and applies the existing ended
launch cleanup without starting another session.

When disabled doctor has not probed the core, it reports an unchecked identity
rather than an unavailable identity. A probe still distinguishes an unavailable core from a changed core.
Do not delete ownership files or launch another copy to repair it.
Reconciliation waits at most 60 seconds while holding the session ID lock.
Timeout preserves pending ownership and returns a doctor repair command.
After stop settles the handoff, retry doctor and enable, then resume the session.
A repeated stop also finishes a cleanup interrupted after the lease or handoff
was released. The launch journal retains the failed outcome. Stop records the
existing restart proof before clearing an invoked reservation, so a later resume
uses a new launch operation rather than reusing the completed one.
Stop re-reads the intent version after settlement. If another intent update
still races with that write, stop returns `intent-reconciliation-required` with
`spider roam stop <session>` as the repair command.

A stopped box-local origin remains stopped even if a replacement native process
has a different PID or core. A local home does not grant that replacement launch
authority. If the origin has no assigned home yet, first run
`spider roam sync <machine>` on the hub to assign its initial home.
Close the blocked copy, then run `spider roam resume <session>` on the hub.
Resume verifies the exact file and doctor checks before it creates running
intent and wakes the supervisor. It does not change the home or bypass a live or
uncertain owner.

Move setup failures retain a safe stage and cause in admission and doctor.
The stages are `preparation`, `ownership`, `move-bindings`, `live-freeze`, and
`socket-publication`. Doctor reads one latest machine-local failure snapshot.
A successful setup clears that snapshot only for the session that recorded it.
The diagnostic includes a repair but excludes exception text, paths, and prompts.
A never-homed ordinary session can keep working after setup fails. A known
participant or exact handoff still requires verified ownership and readiness.

Initial admission failures name the stage, such as
`admission-readiness-failed`, and an allowlisted participant reason when available.
`participant-stopped` and `participant-hub-intent-required` name the resume
command. A refused resume includes the blocking doctor diagnostics in text and
JSON, plus `spider roam doctor <machine>` as the next command. Fix those
prerequisites and retry resume. Restarting services does not clear a deliberate
stop. This follows the stopped-intent and doctor requirements in the
[supervisor design](../superpowers/specs/2026-11-11-roaming-agents-design.md#supervisor-and-availability).

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

`/move` keeps one footer status while it waits, rather than posting periodic
progress notices. The start and result notices remain. A lost control reply
returns code `3`, preserves the known operation ID, and prints the exact
`spider roam recover <operation-id>` command. The outcome stays unknown until
recovery checks the journal. The pending text covers both a request that never
reached the hub and a reply that was lost. The progress status clears when the
request ends.

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
launch failure and retirement, then a higher home epoch.

After startup reconciliation, peers still involved in pending moves wait for
their first verified sync. This catches a peer reconnecting before the first
sync observation. When an unreachable peer becomes connected and completes a
verified sync round, the running hub schedules one full recovery pass for pending moves involving
that peer. Ungathered and refused stores do not prevent connectivity proof,
even when the round returned no apply results. The pass runs after sync, not
inside its callback. A peer pass skips `move-lock-pending` without recording
a warning only for a real lock wait. Journal I/O, lock inspection, and power
assertion failures keep their own warning and recovery command.
A quiet skip arms one pass on the peer's next verified sync round if the
skipped move remains pending. No timer retries the occupied lock, and a move
that finishes before that round does not trigger a pass. Terminal
recovery clears the move's saved recovery diagnostic, including a terminal
refusal. An unfinished move keeps its warning and exact recovery command.
Full recovery and
cleanup share one writer. Requests for the same peer during a running pass
coalesce into one follow-up pass with a new snapshot. Successful-sync cleanup
is deferred with one coalesced
timer and one flight. Disable and shutdown cancel queued cleanup and drain the
active flight before closing stores. Sync callbacks never wait on recovery,
because recovery can request a sync barrier. Repeated reachable observations
do not start more full passes unless a prior pass quietly skipped a still-pending
move lock. Each pass uses finite snapshots of retained journal work and does
not retry failed moves in a loop. Unknown login or identity state cannot trigger recovery.
An unknown launch outcome stays pending until the existing ownership and
readiness proofs permit progress. Recovery never grants a second launch or
retirement from connectivity alone.

Opening a copied
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

Remote agent commands carry the enrolled peer's absolute Pi path as
`SPIDER_ROAM_PI`. Exact terminal commands export the absolute Pi they execute
inside the child command. Neither boundary depends on the core's ambient
`PATH` or on environment variables supplied only to the hc client.
A validated move request whose adapter cannot start returns code `1` and a
bounded cause, not malformed-input code `2`. Workspace preflight preserves
that cause in its move refusal and gives the repair command. For
`participant-pi-unavailable`, install Pi or set `SPIDER_ROAM_PI` to its
executable, then run `spider roam doctor` and retry the move.

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
Any live terminal on the target's core leaves route cleanup pending with
`intercom-revocation-shared-jobs`, because terminal rows do not identify their
owner. Revocation does not stop or delete those terminals. They must all finish
before route cleanup can complete, even if they are unrelated to the pair.
Doctor names the target box and explains this requirement.

Finished rows retained in `ls --all --json` do not block cleanup. The terminal
check accepts label-free rows with a non-empty `reason` string. Each of
`exit_code` and `signal` can be absent, null, or an integer. This includes killed
terminals with a signal but no exit code, and terminals whose holder was lost.
Only the target core's own terminals decide whether it is idle. Rows routed
from other cores still need valid, unique addresses, but their state does not
block cleanup. The fallback listing through the source checks state only for
rows prefixed with the pair's route. Terminal IDs use lowercase base-36 in both
paths. Unknown states or malformed metadata on relevant rows, invalid or
duplicate addresses, and incomplete listings still leave cleanup pending.
Revocation does not delete terminal history.

With both boxes reachable and no live terminals, a plain revoke from the hub
stops and disables both pair units, removes the target key and source route,
and closes all three pair records. Repeated revokes have no further effects.
Pending results and doctor diagnostics provide
`spider roam intercom revoke pair-1` as the retry command. Run it from the hub
once live terminals finish or the unavailable box returns. The hub uses its
management routes, since stopping a pair host closes the pair's own route.
The CLI and doctor on a box tell you to run the repair command on the hub.
An unmatched fence has no repair command until its pair record is restored.
Keep both boxes reachable during recovery.
Unconfirmed cleanup means closure evidence is missing, not that the target
is necessarily offline. A completed revoke permits fresh enrollment with a
new epoch and fresh consent.

Enrollment grants command access as the peer user, including access through
that peer's enrolled pairs. SSH ignores user configuration with `-F /dev/null`.
Each key has a forced command that verifies its pair, edge epoch, and current
registration before executing the approved user's command. This is not a
physical tunnel boundary. A key can reach the same loopback SSH service through
another open tunnel, and deleting a key does not close an existing connection.
Consent states this remaining reach. Pair revocation stops its owned host and
removes its key rather than claiming closure from key deletion alone.
Re-enrollment needs fresh consent for the recorded fence and a new edge epoch.
After fresh consent is approved, the pair key can run commands before the route
is added and the transport is verified, even if the restore remains pending.
Adding the route connects through the pair key, so approval comes first.
Messaging stays fenced until live enrollment succeeds.

To close a pending restore after approval, run
`spider roam intercom revoke pair-1`. Plain revocation uses the inherited fence's
epoch when its identity matches the recorded fence. For explicit historical
recovery on the hub, use
`spider roam intercom revoke pair-1 --fence-epoch edge-1` with the epoch reported
by doctor. A retry command preserves an explicit `--fence-epoch`, even if the
first attempt fails before recording revocation. Both paths close fresh-epoch
command access and leave messaging fenced.

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

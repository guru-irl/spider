# @spider/roam

Roaming coordinates session placement, participant intent, exact launches,
hub synchronization, machine intercom and session moves. See
[Roaming architecture](../../docs/architecture/roaming.md) for configuration,
operator commands and ownership contracts.

## Roaming v0 service controls

Run `spider roam enable` on the Mac to enable its local v0 hub service. Run it
locally on each destination to enable that box's v0 supervisor. Read the
[legacy upgrade procedure](../../docs/guide/roaming-upgrade.md) before replacing
an old service. Enable refuses unfinished or unverified legacy work.
`spider roam disable` removes the local v0 service. It refuses if this machine
is the source or destination of a moving v0 home it knows about.

Run `spider roam provision <machine>` from the hub to install and verify the
release. Provisioning does not write, reload, or toggle a roaming service.
`installed`, `hostingReady`, and the `enabled` participation flag do not report
service status. To start hosting, run `spider roam enable` locally on the box
when it is ready.

To replace a core pin, finish or undo moves and move homes off the box first.
Disable roaming on the hub and locally on the box. If an owned legacy supervisor
is still active, follow the approved stop procedure before retrying
`spider roam provision <machine> --replace-core-pin` on the hub with the same
authentication options. See [Replace an enrolled core pin](../../docs/architecture/roaming.md#replace-an-enrolled-core-pin).
Re-enable v0 locally on the box when ready.

If a box disables roaming before it receives the Mac's moving home, relocate
fails at the destination step and leaves the home `moving`. Re-enable the box
and rerun `spider roam relocate <session> <destination>` to finish, or rerun it
with the source to undo. If neither works and you have a verified backup, use
`spider roam set-home <session> <machine> --force` to recover. The move does not
start a second copy of the session.

## Roaming v0 intercom

V0 intercom sends text between live sessions with running homes. Both
machines need up-to-date home records for the sender and recipient. If the Mac
is asleep and a box has not received a home change, intercom can refuse with
`changed` until the Mac wakes and syncs.

Intercom looks up names at the receiving broker. A successful send means the
broker accepted the socket write, not that the recipient read the message.
There is no remote mailbox or automatic retry. If delivery is unknown, check
the recipient before sending again.

Enable roaming and disable legacy intercom federation in the existing roaming
configuration. On each participating machine, put `intercom-v0.json` in the
`roam` directory under its global root. It must be a regular file owned by the
current user, with mode `0600`, one link, and a size of at most 64 KiB. Do not
use a symlink. Each list accepts at most eight entries. Each `sendTo` entry
needs an absolute `agentDir` that matches the target's configured Herdr agent
directory.

With legacy federation disabled, the presence of this file turns off the
legacy intercom adapter, even if the file is invalid. An invalid file refuses
remote requests but leaves live local messaging available. A missing or
invalid file does not change move or sync behavior.

The lists grant intercom permission. They do not install a Herdr route or
create credentials. Each `acceptFrom` entry trusts the listed machine's claims
about who is sending. The receiving machine checks replicated home records;
it does not independently authenticate the sending session.

For a Mac-initiated ask to one box, configure the Mac with the already
provisioned box peer:

```json
{
  "version": 1,
  "sendTo": [{
    "machineId": "22222222-2222-4222-8222-222222222222",
    "alias": "box-a",
    "node": "/path/to/node",
    "pi": "/path/to/pi",
    "cli": "/path/to/spider/dist/roam/cli.mjs",
    "core": "/path/to/hc",
    "globalRoot": "/path/to/box-global-root",
    "agentDir": "/path/to/box-agent-directory"
  }],
  "acceptFrom": []
}
```

On that box, accept the Mac's machine ID without an outbound Mac route:

```json
{
  "version": 1,
  "sendTo": [],
  "acceptFrom": [{
    "machineId": "11111111-1111-4111-8111-111111111111",
    "alias": "mac"
  }]
}
```

Replace the example IDs and paths with the provisioned values. The Mac can ask
`box-a/name`, and the recipient can use the normal intercom reply. The reply
travels on the same Mac-initiated call. A box cannot initiate a send or ask to
the Mac. Remote asks wait for their own timeout, capped at nine minutes. A
reply after the call closes is refused. Messages and replies are text only.
Text is limited to 248 KiB after JSON encoding. Each encoded request and
result, including metadata, is limited to 256 KiB.

For a separately approved A-to-B route, add B's provisioned peer to A's
`sendTo` and add A's `{ "machineId": "...", "alias": "box-a" }` to B's
`acceptFrom`. B does not need an outbound A entry. This directed route does not
use the Mac as a relay. Do not configure the Mac in a box's `sendTo`.

With a version 1 file, a bare remote name checks configured peers with running
homes. A single verified match is enough even if another peer is unavailable.
With no verified match and an unavailable peer, lookup returns `incomplete`.
With a version 2 file, a bare remote name needs a complete direct lookup before
it can select a match. If more than one session matches, use a
machine-qualified name or a full persistent session ID. A live local alias
takes precedence over a remote name, while a full persistent ID takes
precedence over an alias.

## Run an intercom relay

Upgrade the relay and linked machines together. Enable roaming and leave legacy
intercom federation disabled. Keep `roam/intercom-v0.json` private as described
above, set `version` to `2`, and put the same ordered list of relay machine IDs
in `relays` on every machine. For example, use the machine ID of
`relay-1.invalid`, not its alias.

On the relay, list the IDs of its linked machines in `linkTo`. Each must also
have a provisioned `sendTo` entry and an existing Herdr route from the relay.
The relay advertises its own ID and the `sendTo` entries with connected routes.
The recipient must list the relay in `relays` and the sender in `acceptFrom`.
The linked machine does not need a reverse Herdr route. A machine without an
inbound route can receive through a relay only if it runs that relay itself.
Restart the relay after you change `intercom-v0.json`.

A live local or direct route takes precedence. If neither exists, a send can
use a relay for a full session ID or a machine-qualified name such as
`target.invalid/recipient`. A bare remote name needs a complete direct lookup.
A relayed ask is not supported. Refused messages are not queued. If the result
is unknown, check the recipient before sending again.

Install the relay separately from `spider roam enable`. Do not change the hub
or supervisor service. Run it as the user who owns the roaming files. In the
examples, replace the paths with canonical absolute paths to the installed
release, its Node executable, the roaming root, and the intended Herdr core.
Use the socket and session of the same core. Do not copy a terminal's
`HC_TERMINAL_ID` or a remote target into the service environment.

### Linux: Install the systemd user unit

Save this as `~/.config/systemd/user/spider-roam-relay-v0.service`, with mode
`0600`. Use an existing user-owned unit directory that other users cannot
write to.

```ini
[Unit]
Description=Spider roaming intercom relay
StartLimitIntervalSec=0

[Service]
Type=simple
ExecStart="/path/to/node" "/path/to/spider/dist/roam/cli.mjs" roam agent --v0 relay
Environment="SPIDER_GLOBAL_ROOT=/path/to/roaming-root"
Environment="SPIDER_ROAM_HC=/path/to/hc"
Environment="HC_SESSION=relay"
Environment="HC_SOCKET=/path/to/relay.sock"
Restart=on-failure
RestartSec=10s
UMask=0077

[Install]
WantedBy=default.target
```

Run `systemctl --user daemon-reload`, then
`systemctl --user enable --now spider-roam-relay-v0.service`.

### macOS: Install the launchd user agent

Save this as `~/Library/LaunchAgents/com.spider.roam.relay-v0.plist`, with mode
`0600`. Create the log directory under the same roaming root with mode `0700`.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.spider.roam.relay-v0</string>
  <key>ProgramArguments</key><array>
    <string>/path/to/node</string>
    <string>/path/to/spider/dist/roam/cli.mjs</string>
    <string>roam</string><string>agent</string><string>--v0</string><string>relay</string>
  </array>
  <key>EnvironmentVariables</key><dict>
    <key>SPIDER_GLOBAL_ROOT</key><string>/path/to/roaming-root</string>
    <key>SPIDER_ROAM_HC</key><string>/path/to/hc</string>
    <key>HC_SESSION</key><string>relay</string>
    <key>HC_SOCKET</key><string>/path/to/relay.sock</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>WorkingDirectory</key><string>/path/to/roaming-root</string>
  <key>StandardOutPath</key><string>/path/to/roaming-root/roam/logs/relay-v0.out.log</string>
  <key>StandardErrorPath</key><string>/path/to/roaming-root/roam/logs/relay-v0.err.log</string>
  <key>Umask</key><integer>63</integer>
</dict></plist>
```

Run `launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.spider.roam.relay-v0.plist"`.

### Check the link

Run `spider roam doctor` on the relay and linked machine. Look for an
`intercom-link` row with state `up`. A `route-missing` row means the selected
Herdr core has no configured route for that peer. A `version-mismatch` row
names both versions. Doctor does not start the relay or the broker.

Find the local link snapshots and logs in `roam/relay/in` and `roam/relay/out`
under the roaming root. Each link keeps its current log and one previous log,
with at most 64 KiB each. They do not contain messages.

## Run a relay soak

The opt-in `dist/roam/relay-soak.mjs` measures the held-poll carrier. It sends
only synthetic `relay-soak` messages and records a sink receipt instead of
writing to a session. The tool does not install services, change routes, claim
machines, or inject faults. Building it or checking synthetic evidence does
not prove that a live soak passed.

### Stage the run

1. Assign one laptop-to-box link and two box-to-box links. Install the same
   build and provision the required Herdr routes and keys. Use version 2
   `roam/intercom-v0.json` files. Each relay needs the peer in `sendTo` and
   `linkTo`; each peer needs the relay in `relays`. Keep legacy intercom
   federation disabled.
2. Start a dedicated, admitted origin session on each submitting peer. Keep
   each origin live for the run. The tool submits through the existing private
   broker and refuses a stale origin pin.
3. Choose a future `startMs`, in Unix milliseconds, shared by all three links.
   Set `endMs` to `startMs + 28800000`. Synchronize the clocks and choose a
   memory growth allowance in bytes before starting. Use the same start and
   allowance in every run file.
4. On every machine, take a complete census of the existing test helpers before
   the run. Record each PID, process birth identity, and boot identity. Keep
   the observations in a private run directory.

On each peer, obtain the exact origin pin from its live broker. Use `-` for a
null scope. `ENTRY` is the absolute path to the packaged executable and `ROOT`
is the local global root.

```sh
node --input-type=module - "$ENTRY" "$ROOT" "$SESSION_ID" "$SCOPE_ID" <<'NODE'
import { pathToFileURL } from "node:url";
const [, , entry, root, sessionId, scope] = process.argv;
const { lookupRelaySoakOrigin } = await import(pathToFileURL(entry).href);
console.log(JSON.stringify(await lookupRelaySoakOrigin(root, sessionId, scope === "-" ? null : scope)));
NODE
```

Create a run file on each side of each link. The following is a synthetic
example of the required shape, not an admitted pin. Replace the IDs, pins,
start time, allowance, and local `root` with the staged values. Use the same
link fields on both sides; only `root` differs. Do not add fields to the file.

```json
{
  "root": "/absolute/path/to/global-root",
  "startMs": 1700000000000,
  "rssAllowanceBytes": 10000000,
  "links": [{
    "id": "laptop-box",
    "topology": "laptop-to-box",
    "relayId": "11111111-1111-4111-8111-111111111111",
    "peerId": "22222222-2222-4222-8222-222222222222",
    "from": {
      "machineId": "22222222-2222-4222-8222-222222222222",
      "address": { "sessionId": "soak-origin", "scopeId": "soak-scope" },
      "name": "soak-origin",
      "homeEpoch": 1,
      "endpointEpoch": "fixture-epoch"
    },
    "target": {
      "machineId": "11111111-1111-4111-8111-111111111111",
      "selector": { "by": "id", "value": "soak-target" },
      "homeEpoch": 1
    }
  }]
}
```

For the other links, use distinct link IDs and `"topology": "box-to-box"`.
The target is a synthetic pin for the receipt sink, not a live recipient.

### Sample clocks

For each link, measure the relay clock minus the peer clock over the existing
route. Take samples before the start, throughout the run at least every five
minutes, and after the end. Each sample has relay `sentMs` and `receivedMs`
and peer `remoteMs`, all in Unix milliseconds. The following command records
one sample from the relay. Set `HC_BIN`, `PEER_ALIAS`, and `PEER_NODE` to the
pinned route and executable.

```sh
node --input-type=module <<'NODE'
import { execFileSync } from "node:child_process";
const sentMs = Date.now();
const reply = execFileSync(process.env.HC_BIN, ["exec", "--on", process.env.PEER_ALIAS,
  "--timeout", "25", "--", process.env.PEER_NODE, "-p", "Date.now()"], { encoding: "utf8" });
const receivedMs = Date.now();
const remoteMs = Number(reply.trim());
if (!Number.isSafeInteger(remoteMs)) throw new Error("Invalid peer clock sample");
console.log(JSON.stringify({ sentMs, remoteMs, receivedMs }));
NODE
```

Choose a justified `maxDriftMs` for the whole run. Set `minOffsetMs` to the
minimum of `sentMs - remoteMs - maxDriftMs`, and `maxOffsetMs` to the maximum
of `receivedMs - remoteMs + maxDriftMs`. The manifest's `clock.fromMs` must
cover the start and `clock.toMs` must reach at least `endMs + 20000`. Keep all
samples; the checker rejects gaps over ten minutes and charges uncertainty
against the timing limits. Do not invent a bound when the clocks or samples are
unavailable.

### Start and mark the run

Start the dial on the relay before `startMs`, early enough to capture an RSS
sample before the start after accounting for the clock bound. Start the submit
process on the peer before `startMs`. Use private files and retain every
NDJSON record. `RUN` is the local run-file path and `LINK` is its link ID.
Give each link its own receipt file. Start a fresh file for a new run, and
reuse the same file when restarting the dial within that run. The dial
appends and syncs each receipt before reporting delivery.

```sh
# On the relay
node "$ENTRY" dial "$RUN" "$LINK" "$RECORDS/receipts.ndjson" >> "$RECORDS/dial.ndjson" 2>> "$RECORDS/dial.err" &

# On the peer
node "$ENTRY" submit "$RUN" "$LINK" >> "$RECORDS/submit.ndjson" 2>> "$RECORDS/submit.err" &
```

Repeat for all three links. The submit process records one attempt every five
seconds for eight hours, including refusals. Once during the run, on one peer,
start exactly one extra burst and retain its separate records.

```sh
node "$ENTRY" submit "$RUN" "$LINK" --burst >> "$RECORDS/burst.ndjson" 2>> "$RECORDS/burst.err"
```

After the affected link is up, inject and record each fault. Record the
fault's `kind`, affected `linkIds`, `clock` (`relay` or `peer`), `startMs`,
and `clearMs` on that clock. Each fault must affect links that share that
clock's machine.

- Keep `route-cut` active for at least 60 seconds.
- For `relay-kill`, `herdr-restart-relay`, `herdr-restart-peer`, and
  `laptop-sleep`, wait at least 40 seconds before clearing the fault. Confirm
  that either side recorded a state other than `up` on each affected link.
  A held call plus its grace period can take 30 seconds to expire, and the
  next peer sample can arrive later.
- For `endpoint-kill`, kill the matched held endpoint once. Don't delay the
  next endpoint. The dial can log a transition even if the outage ends
  before the next peer sample.

Keep both `state` and `relay-state` records. The checker uses their
`sinceMs` transition times, not when the tool observed them. If a transition
and the fault share a clock, their difference needs no offset adjustment.

The 60-second RSS gap limit excludes time from a fault on the relay clock
until the first resumed RSS sample. For `relay-kill`, that sample must be
from a replacement dial birth. A dial that survives sleep can resume with
its original birth. The baseline still covers the whole run. The RSS check
adds no restart limit, but each link must recover within 60 seconds after
the fault clears.

For a relay kill or a Herdr restart, add `process` with the affected
`machineId`, `pid`, `birthId`, `bootId`, and `observedMs`. Observe that process
on its own machine within five seconds before the fault. For an endpoint kill,
add the same fields as `endpoint` plus the `pollId` from a still-open held
`poll-start` record. Identify the actual peer endpoint and its birth identity
before killing it. If more than one endpoint could match, do not guess.

On Linux, `birthId` is `linux:` followed by field 22 of `/proc/<pid>/stat`,
and `bootId` is `/proc/sys/kernel/random/boot_id`. On macOS, `birthId` is
`posix:` followed by `LC_ALL=C TZ=UTC ps -p <pid> -o lstart=` with surrounding
whitespace removed, and `bootId` is `sysctl -n kern.bootsessionuuid`. Record
birth identities while the processes are live, not after PID reuse.

### Stop and check

Wait for the submit processes and their pending outcomes to finish. Keep each
dial running until its RSS records cover `endMs` plus the maximum relay clock
offset. Then stop the dial processes, wait for their held calls and helper
processes to exit, and take a complete after census on every machine. Take
both censuses far enough outside the run to account for the clock bounds.

Collect the NDJSON files and build a manifest. List stdout logs in
`recordFiles` and the separate sink in `receiptFile`. Both paths are relative
to the manifest. The checker rejects receipts in stdout logs and other
records in the receipt file. The template shows one link. Include the other
two, all faults and clock samples, and one census per participating machine.

```json
{
  "startMs": 1700000000000,
  "endMs": 1700028800000,
  "rssAllowanceBytes": 10000000,
  "links": [{
    "id": "laptop-box",
    "topology": "laptop-to-box",
    "relayId": "11111111-1111-4111-8111-111111111111",
    "peerId": "22222222-2222-4222-8222-222222222222",
    "clock": {
      "fromMs": 1700000000000,
      "toMs": 1700028820000,
      "minOffsetMs": -100,
      "maxOffsetMs": 100,
      "maxDriftMs": 0,
      "samples": []
    },
    "recordFiles": ["laptop-box-dial.ndjson", "laptop-box-submit.ndjson"],
    "receiptFile": "laptop-box-receipts.ndjson"
  }],
  "faults": [],
  "processes": []
}
```

Each census is `{ "machineId": "...", "before": { "atMs": 0,
"complete": true, "identities": [] }, "after": { "atMs": 0,
"complete": true, "identities": [] } }`. Replace the timestamps and list
all observed `{ "pid": 1, "birthId": "...", "bootId": "..." }` identities.
Mark a census complete only when it covers all test-owned helpers. Add the
burst file and every restarted dial's records to the relevant link.

```sh
node "$ENTRY" check "$RECORDS/manifest.json"
```

Exit 0 and `{"ok":true,"violations":[]}` mean the evidence met the soak
criteria. Exit 1 reports violations or incomplete evidence. A failed soak blocks
rollout. Fix the carrier and run the live gate again.

If an outcome records `clientDeadlineMs` on the peer clock, the checker uses
it as the deadline. The default driver logs the submission time and nominal
20-second deadline instead. In that case, the checker allows up to 25 ms to
observe completion after the deadline. The client timeout stays at 20 seconds.

## Legacy enable and broker readiness

`production-controls.ts` completes read-only peer preflight before starting
services. The private box startup command runs doctor checks and resolves
settings before `spawnBrokerIfNeeded`, then validates broker health and returns
its doctor report. Enable validates the machine identity and report and uses
that observation without a second doctor call.

This ordering keeps slow settings resolution outside the sessionless broker's
idle lifetime. Startup still uses the existing deadlines. An unavailable broker,
invalid readiness evidence, or a startup error leaves enable pending before
capture and participation flags change. The response includes an allowlisted
`causeCode` without broker stderr, exception text, or private paths. A broker
that answers health but lacks federation support remains blocked.

If enable reports `intercom-pair-unit-unavailable`, reprovision each affected
box with `spider roam provision <machine>` and retry enable. After consent and
identity checks, provisioning reconciles stopped, recorded active pair units.
It refuses mismatched or fenced units, skips revoked pairs, and leaves foreign
units alone. Use a new provisioning operation after a later stop; replaying a
completed operation returns its saved result. Doctor stays read-only. With
roaming disabled, pair connectors may restart, but provisioning does not enable
the box or start its broker, supervisor, or hosted sessions.

## Packaged hub service

`package-layout.ts` resolves the installed `dist/roam/cli.mjs` dispatcher for
hub enablement. The service runs that executable with `roam hub`, not the
imported `cli-main.mjs` library. Enable checks the local role before resolving
that entry. A box returns `mac-hub-required`; a hub with an unavailable
installed entry returns `enable-unavailable` without changing configuration.

`hub-service-diagnostics.ts` reads service metadata and uses the read-only
status probe in `hub-readiness.ts`, shared with enable. Doctor gives service
metadata and readiness probes a combined two-second deadline. If service state
is unknown and the socket is absent, it reports immediately instead of retrying.
A running service can become ready in the remaining time. A stale socket is not
readiness. Control requests use elapsed-time deadlines, even during partial replies.
It blocks with `hub-startup-pending` only when the service is stopped, or when
a running service still fails the probe after that bound. Unknown service
metadata produces a `hub-startup-unverified` warning. The diagnostic names
the last exit code and error log path without reading log contents. Check the
service and that log. The startup repair is `spider roam enable`, which starts
the supported hub service. An unavailable move-control connection names the
same command.

After upgrading a hub enabled on an earlier release, run `spider roam enable`
again to reinstall its service with the correct entry. The packaged
`supervisor.mjs` entry also runs through file or directory symlinks to a
release, including with preserved main symlinks. `scripts/check-roam-bundle.mjs`
rejects remote runtime and pane endpoint main bodies in the built roam entries.

## Hub service selection

Enable captures the resolved `hc` socket and session before peer preflight.
Non-default selections are pinned in the hub service; the unconfigured default
keeps the existing environment. The service runs from the scoped global root.
Doctor compares the installed selection with the current environment. To repair
a mismatch, run `spider roam enable` again from the intended environment.
The startup diagnostic identifies the selection class without logging the path.

## Provisioning private agent modes

The settings preview checks the requested destination agent tree without
changing files. After consent, provisioning tightens same-uid regular files
and directories to private modes. Sign-in-created `0664` files become `0600`,
and `0775` directories become `0700`. Owner-executable files retain `0700`.
`--no-settings` omits the settings copy but still checks and repairs existing
files. Permission repair does not change their contents.

The JSON result lists each repair in `value.privateModeRepairs`, with its path,
uid, and numeric `before` and `after` modes. The destination stores a private
receipt so retries return the same repair evidence. Installer-tree changes
remain in the separate `value.permissionTightenings` count.

The walk never follows symlinks or repairs foreign-owned entries. It preserves
only the exact `intercom/broker.sock` socket when the socket is same-uid and
`0600` and its canonical parent is same-uid and `0700`. It does not open,
chmod, replace, unlink, or report a repair for that socket. Other special
files, hard links, and incompatible owner permissions refuse. Refusals name the
path, mode, uid, and repair advice. Shared parents outside the agent tree retain
their existing explicit repair requirement.

## Provisioning protected install paths

A same-uid directory with mode exactly `0700` at or below the install prefix
protects its descendants. Provisioning accepts a `0775` bin or executable
behind that directory without chmod. Every parent before protection starts
must remain same-uid, real, and not writable by group or others. A later private
directory does not excuse an earlier writable parent. Private directories
outside the prefix do not relax this rule.

The pi package and release trees use the same rule. Foreign owners, hard links,
unsafe types, special mode bits, and escaping symlinks still refuse. Internal
npm links keep their existing checked-target allowance. Install refusals name
the path, mode, uid, and exact repair advice. An unprotected writable path
reports `chmod go-w` for that path; owner and link failures require replacement.

Protected install entries add no JSON repairs because their modes do not
change. Agent repairs and receipt-backed installer tightening remain unchanged.
The inventory probe recognizes the same protection, so doctor's reprovision
advice can reach an installed runtime instead of another bin-mode refusal.

## Stop and pending launches

`supervisor.ts` reserves a launch before authorization. Production prerequisites
and exact handoff preparation run while the reservation remains `reserved`.
After the handoff is durable, the launcher calls the supervisor's `beforeSpawn`
admission callback. Spawn requires a successful compare-and-swap to `invoking`.
Canceled authorization releases the launcher's own uninvoked preparation.

`participant-runtime.ts` persists a stopped intent independently of the roaming
enable switch. Stop clears a `reserved` reservation with no ID lock to idle,
without a launch outcome or restart proof. The same compare-and-swap prevents a
concurrent launch from invoking the cleared reservation.

A launch warning retains an allowlisted exception code, or `launch-unavailable`
when the code is unknown. A confirmed adopted owner that exits before readiness
reports `participant-exited-before-readiness`. When the recorded terminal matches
the launch attempt and pinned core, the warning can include its exit code or
signal. Doctor and cached status show these details without exception text or
terminal output. The warning survives backoff and supervisor restarts, then
clears after a successful launch or a deliberate stop. The hosting observation
sends warnings with fewer than three failures in an optional `earlyWarnings`
field. Older hubs ignore that field without losing readiness; current hubs
validate it and combine it with the existing warning list.

Inspection failures also retain an allowlisted cause in the first supervisor
log entry and the persistent hosting warning. Unknown causes use
`inspection-unavailable`. A failed capture prerequisite reports
`participant-capture-uninitialized`. Doctor and cached status show the cause
without exception text or file contents. Doctor offers
`spider roam stop <session>` on the hub to cancel hosting, not to retry a launch.

Move activation enables capture in the session's exact worktree stores before
publishing running intent. It checks store identity and the existing trigger
layout and seeds through the bounded session-seeding path. Unrelated workspace
maps do not participate. Recovery of an older activated move with capture still
disabled rechecks the home, intent, file, workspace and absent owner under both
session locks, initializes capture, and reuses the recorded launch reservation.
The supervisor still requires exact admission before spawn.

An `invoking` reservation without an ID lock remains blocked unless a released
adoption record proves which owner adopted that launch. Stop requires the same
boot and an absent recorded PID. PID reuse, an unavailable probe, or a changed
boot refuses this proof. The exact file must match the durable intent authority,
and its lease must be absent or name an absent process on the same boot.

`settleReleasedAdoptedOwner` runs the proof and journal writes under the
session-ID mutex used by adoption. Participants claim that ID lock before the
file lease. The proof rechecks ownership, boot and lease state and refuses if
readiness appears during inspection. It retains the released adoption record
and existing history, records `exact-adopted-owner-ended` and
`exact-launch-settled`, and completes the launch with `launch-ended`. Stop then
sets supervision idle while the durable intent stays stopped. Stop completes
interrupted launch journal writes before clearing the reservation. A failed
idle compare-and-swap can retry without duplicating settlement records. No
launch runs on this path.

A pending ID lock must match the participant's launch operation before stop can
settle it. Stop never settles a different operation, such as a move launch.

`launcher.ts` records `exact-launch-prepared` before ownership handoff writes.
After both handoffs are durable, successful admission permits
`exact-invocation-admitted` and then spawn. A restart between those steps retains
the same operation for reconciliation, without another spawn. A prepared record
with matching session, file, launcher, boot, and core and no admission or spawn
attempt proves `prepared-not-invoked`.

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
identities. Pending launches remain blocking in all three cases. For a released
adoption, doctor distinguishes a live owner, unavailable owner status and a
live file-lease holder. It directs the operator to supported session shutdown
or restored process and boot identity inspection before stopping again. Once
the released owner has positively exited, doctor offers stop. A reservation
without adoption evidence checks the actual pin and core before reporting a
core problem. These repairs do not send the operator back to doctor. Doctor
offers stop for an unstarted reservation, but inspection for an invoking
reservation without a handoff. Stop repair diagnostics name the Mac hub as
where to run the command, including when doctor runs locally on a box.

## Store inventory

Doctor reports `store-machine-mismatch` when a registered or mapped store
belongs to another machine identity. The store remains ungathered, and first
homes stay withheld where its contents could matter. Use a matching machine
catalog or a fresh isolated catalog. Existing foreign stores have no supported
in-place adoption or prune command.

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

If an unreadable worktree or replica prevents an initial home, `sync.ts`
records the responsible machine ID and store kind in local metadata. A move
keeps the `move-source-home-mismatch` refusal and adds
`move-first-home-withheld` with that evidence. The safety gate is unchanged.
A new inventory clears stale evidence, and diagnostic failures do not affect
home assignment.

## Move executable and setup failures

Remote agent exec and run commands export the enrolled peer's absolute Pi as
`SPIDER_ROAM_PI`. Move composition does not need Pi on the remote core's `PATH`.
Validated adapter failures return code `1` with an allowlisted cause. Missing
Pi returns `participant-pi-unavailable`, which the move refusal retains with
an install or configuration repair.

`readiness.ts` names preparation failures for an unfinished freeze, missing
cwd, invalid or mismatched header, store mapping, store access, and seeding.
Unknown failures remain `setup-unavailable`. Doctor includes the latest local
setup stage, cause, safe session ID, and first and last occurrence times. The
snapshot contains no exception text, paths, or prompts. It is machine-local
metadata and does not replicate. A successful setup clears its own session's
failure.

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
recording a warning. Journal I/O, lock inspection, and power assertion failures
keep their own warning and recovery command. A quiet skip arms one later pass
on the peer's next verified sync round while that skipped move remains pending.
There is no timer retry loop, and completed moves do not trigger a later pass.
Terminal recovery, including a terminal refusal, clears that move's saved
recovery diagnostic. Unfinished moves retain their diagnostic and the repair
allowed by its cause.

## Cancel before a completed freeze

A move whose freeze never completed can finish cancellation after its session
exits, including after a hub or machine restart. Cancellation still verifies
the source home, abort authority, session ID lock, and canonical file lease.
A completed freeze retains its abort authorization and intake-fence checks.

The ownership probe reads identity-matched session registrations from the local
runtime and the normal runtime. Unrelated registered Pi sessions do not block
absence. A changed boot or process start identity proves only the recorded
owner gone. An unidentified replacement, unreadable process identity, or a live
owner still blocks cancellation. Foreign runtime registrations remain read-only.

ID-lock and cutover file-lease mutexes reclaim a stale, uniquely named ticket
only when its recorded process is absent or has a different observed start
identity. Matching or unreadable ticket owners still block, and their tickets
remain unchanged. Reclaiming a ticket does not release the session's ownership
or bypass freeze authorization.

An ownership refusal returns code `3` with `move-ownership-unavailable` and its
specific cause. The response and doctor give the repair steps instead of
sending cancellation back to recovery. Quit unregistered Pi sessions normally,
or restore the reported process, boot, or ownership-record inspection before
retrying cancellation. Do not delete ownership files to bypass the checks.

A known pending move refuses disable with code `1` before service inspection or
any disable changes. The hub and CLI name the move and its cancel repair.
Doctor reports the move as blocking and also returns code `1`, even when
roaming is disabled. Code `3` remains for partial disable or unverified safety.

## Partial disable

When local disable succeeds but box flags are unconfirmed, the command returns
`roaming-disabled-partial` with code `3`. Its issues name each box and the exact
`spider roam disable` retry command. Retrying reuses the latest matching pending
peer operation ID without appending another consent record. A newer enable
operation prevents reuse of an older pending disable. Code `0` means all flags
are confirmed. Captures and homes are retained in either case. Both outcomes
tell open pi sessions to use `/reload` to pick up the local change.

## Intercom pair ID reuse

`intercom-registry.ts` permits a different endpoint identity pair to reuse a
completed revoked pair ID. Both endpoint fences must be null. Enrollment uses a
new operation, a new epoch, and fresh consent without inheriting the retired
fence or resources. The completed record has a revocation epoch and no cleanup
obligation. Resource metadata remains as a cleanup receipt.

`intercom-production.ts` reports `intercom-pair-revocation-incomplete` when the
completion epoch is missing, and `intercom-pair-fence-conflict` for conflicting
fences. Pending revocation keeps `revocation-pending`. Same-endpoint restores
still need consent to the recorded fence. `intercom-enrollment.ts` refreshes
refused observations on retry while retaining successful pairs' fence consent.

## Pair-unit readiness and repair

A missing recorded host or connect unit file reports
`intercom-pair-unit-missing`. The pair stays unready, but the machine helper and
bridge still publish on an existing hub route. Inspection does not recreate
resources or remove pair state. Unsafe files, symlinks, wrong ownership or
mode, mismatched contents, and other filesystem errors retain their refusals.

Doctor names the pair side and provides a command to run on the hub. For a
pending enrollment, set `GRAPH_FILE` to the original approved graph and rerun
the same enrollment operation. Connector setup republishes its missing unit.
A completed enrollment operation does not repeat setup. For an active pair,
complete fenced revoke before enrolling again with fresh consent.

Fenced cleanup treats an already-absent unit as removed only when systemd
reports it not found and inactive with no PID, control group, fragment,
drop-ins, or pending reload. The retained main process identity must have
exited, and its recorded control group must be empty. Missing files alone,
unknown process evidence, or a cached live unit cannot prove closure. Cleanup
keeps all fence checks and never recreates a unit. See
[Pair revocation](../../docs/architecture/roaming.md#pair-revocation).

## Intercom initialization

Failed machine-intercom setup retries after 1, 2, 5, 10, and then 30 seconds.
Readiness stays pending until setup succeeds. Success resets the initialization
backoff. Stop cancels the pending retry and drains setup before closing resources.

## Pair publication

A box in `hub-only` mode can start with only its direct hub edge. After the
exact pair consent and identity checks, `persistIntercomPairRoute` adds a
missing relay route to the approved peer through that hub edge. Publication
preserves the box's mode, unrelated routes, and the registry's approved direct
edge. A missing hub edge or an incompatible existing route remains a refusal.
The existing locked configuration write validates and durably stores the route
with private permissions. The live helper can then enroll the staged direct
edge. Only the hub's drain and switch control activate direct routing.

Endpoint enrollment checks the queue's fence through its identity-bound live
helper, including registration under the peer lifecycle lock. Unrelated queue
WAL publication cannot block an approved setup effect. A missing or mismatched
helper still refuses setup when a queue exists. Initial setup without a queue
creates no queue files. Diagnostic reads retain private snapshots and still
refuse unpublished WAL commits. Existing fences and unfinished revocation
cleanup continue to block enrollment.

After transport verification, `intercom-production.ts` publishes configuration
on both sides and enrolls both live helpers. A failure keeps the original
pending or precise refusal. Enrollment output and hub doctor name the step,
source or target side, and any allowlisted inner cause. Unknown errors keep the
`unexpected-publish-pair` fallback without exception text.

The local operation journal retains the latest failure for a pending pair.
Identical retries do not add duplicate diagnostic records. A successful
publication or a later failure at another step clears the evidence. Writes are
best effort and cannot change enrollment or its retry.

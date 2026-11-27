# Intercom relays for roaming v0

Status: draft, 2026-11-27.

Builds on the v0 cross-machine intercom: a sender with a route to the target's machine runs one
`hc exec --on <target>` call per message, and the target's private `roam agent --v0 intercom`
delivers it to the live broker. This design adds relays so that machines without a route can still
send. It changes nothing for machines that have one.

## Goal

- A session on a machine with no route to the target's machine can send to it, including between
  two boxes while the laptop is off.
- Every message still ends with one explained outcome: delivered, refused, or unknown.
- Link failures are detected quickly, shown in `roam doctor`, and never turn into silent loss.

Not in scope: replicating data between boxes, queues or mailboxes, relays forwarding to other relays,
running subagents on another machine, and short-lived machines such as cloud workspaces.

## Terms

- **Relay**: an always-on machine that accepts messages over a link and delivers them locally or
  by direct call. Relays are listed in one order, the same on every machine.
- **Link**: a sequence of one-shot `hc exec` calls from a relay to another machine. Only the relay
  opens the calls. The linked machine never dials out to use the link.
- **Direct call**: today's one `hc exec` call per message from the sender to the target's machine.
- **Hub**: unchanged. It still means the machine that writes session homes and runs replication.
  A relay is a separate role.

## Routing

For each send or reply, the sender's machine decides in this order:

1. The target's home is on this machine: deliver locally, as today.
2. This machine has a direct route to the target's machine: direct call, as today.
3. Otherwise, take the available links in relay order. Use the first relay that reports it can
   reach the target's machine. Hand the message over in a poll and wait for the outcome.
4. No link is up: refuse with "No relay is reachable. Nothing was queued." Links are up but none
   reaches the target: refuse with "`<machine>` is not reachable through any relay right now.
   Nothing was queued."

A relay's reach list always includes itself and includes only those other machines in `sendTo`
with an available Herdr route. The relay uses the session homes it already receives through sync.
It delivers to its own sessions locally and uses direct calls for any other target. It never hands
an accepted submission to another relay. The target checks the home and the live session, as today.

A machine that nobody can dial can receive a relayed message only while it runs a relay. Its relay
receives the submission on its own call and delivers it locally. If the machine is not a relay,
there is no way to relay a message to it. The refusal identifies the unreachable machine.

Existing rules apply unchanged: refuse instead of queuing, never resend a confirmed or `unknown`
outcome, the `reply-only` rule, text only, 256 KiB per message, and the 9-minute limit on asks. A
reply is an ordinary send back to the asker's home, so it may use a different relay than the ask did.

## Links

A relay service, `roam agent --v0 relay`, runs on each relay machine as a user service. It calls
`hc exec --on <machine> --stdin` for each machine in `linkTo`. The remote command is
`<spider> roam agent --v0 link --hold-ms <ms>`. Standard input carries the current reach list and
any results for earlier submissions. The endpoint passes them to its local broker. A held poll
returns as soon as it takes submissions, or returns none at its 20-second deadline. The relay
starts the next held poll at once without waiting for deliveries.

When a delivery settles, the relay sends the result in a separate call with a hold of 0, never in
a held poll. If a hold-0 call is already in flight, the relay sends the waiting results as soon as
that call ends, without waiting for the held poll. A hold-0 call returns any waiting submissions at
once. A link has at most one held call and one hold-0 call in flight. Only one call can take a given
submission.

Each one-shot call exchanges newline-delimited JSON frames in bounded batches. The relay and
endpoint correlate each batch by link and poll ID. Neither side reads a reply before the call ends.

| Frame | Direction | Purpose |
| --- | --- | --- |
| `hello` | relay to machine | Protocol version and the relay, link, poll, and target machine IDs |
| `ready` | machine to relay | Protocol version and machine ID, or a refusal with a reason |
| `submit` | machine to relay | Message ID, origin session, target, kind (send, ask or reply), text |
| `result` | relay to machine | Message ID, outcome, reason, and whether delivery was attempted |
| `reach` | relay to machine | Current list of reachable machines |

Rules:

- The endpoint accepts `hello` only from a machine in its `relays` list, with the same protocol
  version. A mismatch refuses the call and shows a doctor row that names both versions. Relays and
  machines are upgraded together. There is no version negotiation.
- A sender waits at most 2 seconds for a poll to take its submission. If no call takes it,
  the broker removes the submission and may try the next relay. Nothing waits beyond this window
  for a hand-off. At most 16 messages can wait on one link before or after hand-off. At capacity,
  the sender gets "Relay busy. Nothing was queued."
- A relay that refuses before attempting delivery (no route, busy, shutting down) marks the result
  `attempted: false`. After hand-off, only this result allows the sender to try the next relay.
  After an attempted delivery the outcome is final.
- The linked machine considers the relay up while a valid call is in progress and for 10 seconds
  after the last call ends normally. If any call ends without its normal reply, such as when the
  relay cancels or dies, the linked machine marks the link down at once. On the relay, a failed
  call marks the link down. The relay reconnects with backoff: 1, 2, 4 and up to 30 seconds between
  attempts.

## Failures

| Failure | How it is detected | What the sender sees |
| --- | --- | --- |
| Link drops (exec fails, Herdr restarts, route lost) | Failed call on the relay. The linked machine marks the link down at once if a call ends without a normal reply, or when no call is in progress and 10 seconds have passed since the last normal call ended. | Messages already handed over without a result: `unknown` with the message ID ("check the recipient before resending"). Submissions not handed over may use the next relay. |
| Relay machine stops or sleeps | Same as a dropped link | Same as a dropped link |
| Relay cannot reach the target | Relay's reach list, or the direct call's own failure | `attempted: false`: next relay. Otherwise the direct call's outcome, unchanged. |
| No poll takes the submission | The sender's 2-second hand-off wait ends | `attempted: false`: next relay or refused, nothing queued. |
| A relay dies while an ask waits for its reply | The ask's link drops | The ask keeps waiting. The reply comes back through any relay that is up. The ask is never resent, and the 9-minute limit applies. |
| No relay up, or none reaches the target | No link is up, or none reports the target | Refused, nothing queued (see Routing) |
| Stale home or moved session | Target machine's check | Refused, as today |
| Protocol mismatch | `hello` check | Link refused; doctor row on both sides |

## Visibility

- `roam doctor` shows one row per relay link on each machine: state (up, connecting, down), time in
  that state, age of the last valid call, last error, and messages carried. On a relay it shows one
  row per linked machine.
- Every send result names the path it took (local, direct, or relay `<alias>`). A refusal says why
  each relay was skipped: down, cannot reach the target, or busy.
- Each machine keeps a small rotating link log under its roam root: connects, disconnects, call
  timeouts, and errors, never message text.

## Configuration and trust

`roam/intercom-v0.json` gains version 2 with two optional fields. A version 1 file keeps working and
has no relays.

- `relays`: ordered machine IDs, the same list on every machine. A machine runs the relay service when
  its own ID is in the list.
- `linkTo` (relays only): the machines this relay opens links to.

A target accepts a relayed message only if the carrying relay is in its `relays` list and the origin
machine is in its `acceptFrom` list. Links add no listening port and no new route: they ride the
relay's existing machine route. Relays keep no message text after the outcome is returned.

`hello.relay` is self-asserted. The endpoint checks that the claimed ID is in `relays`, but does
not bind the claim to a separate identity. Under the v0 trust model, permission to run `exec` on
a machine already grants access to that account.

Routes, keys and service installation stay operator prerequisites, as in the v0 intercom design.
Spider checks the configuration and refuses with a doctor row when something is missing.

## Reliability gate

The pinned `hc exec` reads all stdin before starting the remote command. It returns stdout only
when the command ends. Step 1 must prove that a held poll returns early when it takes a submission
and returns empty at the 20-second deadline. It must also prove that a hold-0 call can return a
result to the sender before a concurrent held poll returns.

Both kinds of poll use a 25-second remote timeout and a 30-second call timeout. The call budget
includes the existing 2-second reserve for the post-check. The v0 send budget stays at 20 seconds.
No other timeout changes.

Soak for 8 hours on real machines: a laptop-to-box link and two box-to-box links, with one message
every 5 seconds on each. During the soak, kill the relay process, restart Herdr on each side, cut the
route for 60 seconds, sleep and wake the laptop, kill the link endpoint, and send a burst of 100
messages.

Pass criteria:

- Every message ends with exactly one outcome within its time budget. No message is lost without an
  outcome, and none is delivered twice.
- `unknown` appears only for messages in flight when a fault was injected.
- A link recovers within 60 seconds after each fault clears. A stalled link is detected within
  30 seconds.
- On a healthy link, 99% of hand-offs take under 2 seconds.
- After 8 hours, no extra helper processes remain on either side, and relay memory is stable.

If the gate fails, stop rollout. Fix the held poll or its lifecycle and run the gate again.

## Testing

- Unit tests: frame parsing and size limits, the routing decision, relay choice with reach lists, the
  `attempted` rule, hold and liveness timing with a fake clock, and reconnect backoff.
- Integration tests with in-process polls in place of `hc exec`, plus real brokers in temporary
  roots. Inject a failed call during a hand-off, a stall, an oversized frame, and a duplicate result.
  Cover an ask whose relay dies before the reply.
- End-to-end scenarios on CI with fixture machines: a send between two machines through a relay, a
  switch to the second relay when the first stops, and a refusal when no relay reaches the target.
- The live soak above, then a live check after each build step on assigned machines.

## Build order

1. The held poll link and its soak. Prove the carrier on CI before building on it. The soak can run
   while the one-relay work proceeds, but the live gate must pass before rollout.
2. One relay: the relay service, routing step 3, and doctor rows.
3. Several relays in order, with failover and reach lists.
4. Asks that survive the loss of a relay.

Each step ships on its own and leaves direct calls unchanged.

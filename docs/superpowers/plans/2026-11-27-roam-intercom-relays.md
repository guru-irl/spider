# Intercom Relays Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a roaming v0 intercom message through a relay when the sender cannot reach the target
directly.

**Architecture:** A relay makes held, buffered exec calls to the machines in `linkTo`. Their brokers
hand submissions to those calls and correlate the results. The relay uses replicated homes to deliver
locally or by the existing direct transport. The asker's broker owns the wait for a routed reply,
independently of the relay that carried the question.

**Tech Stack:** TypeScript, Node.js, Herdr core 0.1.16, private Unix broker sockets, newline-delimited
JSON, Vitest, GitHub Actions, systemd user services, and launchd agents.

**Spec:** [Intercom relays for roaming v0](../specs/2026-11-27-roam-intercom-relays-design.md)

## Global Constraints

- Route in this order: local, direct, relay. Relays are listed in one order, the same on every machine.
  A relay's reach list always includes itself.
- `roam/intercom-v0.json` gains version 2 with two optional fields. A version 1 file keeps working and
  has no relays.
- A target accepts a relayed message only if the carrying relay is in its `relays` list and the origin
  machine is in its `acceptFrom` list.
- Links add no listening port and no new route. Routes, keys and service installation stay operator
  prerequisites.
- Keep the `reply-only` rule, text only, 256 KiB per message, and the 9-minute limit on asks. Refuse
  instead of queuing. Never resend a confirmed or `unknown` outcome.
- The relay starts the next call at once. The endpoint returns at its 1-second hold deadline if there
  are no submissions. A sender waits at most 2 seconds for hand-off.
- At most 16 messages can wait on one link before or after hand-off. After hand-off, only
  `attempted: false` permits failover. After an attempted delivery the outcome is final.
- The linked machine considers the link down after 30 seconds without a valid call. Reconnect backoff is
  1, 2, 4 and up to 60 seconds between attempts.
- Upgrade relays and machines together. There is no version negotiation. Relays keep no message text
  after the outcome is returned. Link logs never contain message text.
- Use strict TDD. Record red and green evidence. Test one file at a time with `--maxWorkers=1`. Assert
  behavior a user or a peer can observe.
- Never run stories, the app, mounted fixtures, or `move.test.ts` locally. Use CI dispatch. Do not raise
  timeouts or add test retries.
- For every task, kill three mutants in an isolated copy. Keep the failing assertions. Sweep importers
  of changed modules and run affected test files one at a time. Record CI-only exclusions.
- Run one typecheck and one build per task. Use `npm run -s typecheck` or
  `npm run -s typecheck:herdr:e2e` for an e2e-only task, and `npm run -s build`. Do not overlap them
  with tests. Use the previous task's built broker for a packed-broker red and the new build for green.
  Unset the inherited session variables as in `CONTRIBUTING.md`.
- Give each task to one worker, sequentially on the same branch. Workers stage only the task files and
  commit with `git commit -F` using a message file. Workers do not push. Use synthetic machine names
  ending in `.invalid`.
- Keep the existing Node.js floor and the pinned Herdr core. Do not add a dependency or change the home
  writer.

## Review Focus

1. A poll that arrives just after the sender's wait expires must never take that message. Task 2: `does not hand off an expired submission`.
2. A late or duplicate result from a replaced link must not settle a second send. Task 2: `ignores duplicate and old-generation results`.
3. If a target moves after lookup but before the relay delivers, the new or old session must not receive the message. Task 4: `refuses a stale pinned target`.
4. If the first relay may have delivered but its result is lost, the second relay must not receive the same submission. Task 6: `does not switch after a lost result`.
5. A late reply or a reply from the wrong scope must not complete an ask or become a new inbound message. Task 7: `refuses late and mismatched replies`.

---

## File structure

Paths and line references below name the starting tree. Create the files marked **Create** in their
owning tasks.

| Area | Files and responsibility |
| --- | --- |
| Linux stories | `packages/herdr/e2e/fixtures/roam-relays.ts` owns the directed fixture network. `packages/herdr/e2e/scenarios/roam-relays.test.ts` owns opt-in stories. `scripts/herdr-e2e.mjs` and the existing runner and matrix contracts control selection. |
| Poll contract and link state | `packages/intercom/src/relay-protocol.ts` validates bounded batches. `packages/intercom/src/broker/relay-links.ts` owns held calls, link recency, and pending outcomes. `packages/intercom/src/broker/roam-relay-client.ts` speaks to the existing private broker. |
| Carrier and service | `packages/roam/src/relocate/relay-poll.ts` adapts `Transport.resolve` and `Transport.exec`. `packages/roam/src/relocate/intercom-routes.ts` owns the shared config reader. `packages/roam/src/relocate/relay-service.ts` runs per-peer polls. `packages/roam/src/cli.ts` binds the two private commands. |
| Delivery and routing | `packages/roam/src/relocate/intercom.ts` keeps home and endpoint checks in the v0 adapter. `packages/roam/src/relocate/intercom-relay-route.ts` selects a relay and explains the result. `packages/intercom/src/roam-v0.ts` and `packages/intercom/src/local.ts` carry that result to the tool. |
| Visibility and verification | `packages/intercom/src/broker/relay-observations.ts` stores link status and bounded logs. `packages/roam/src/local-diagnostics.ts` adds doctor rows. `packages/roam/src/relocate/relay-soak.ts` drives the same poll loop and verifies the live evidence. |

## Wave gates

Use one read-only review of the exact wave head, in parallel with its gate. Apply one fix round.
Dispatch both workflows at the revised head if the fix changes it. Do not review per task. The gate
owner publishes the exact task or wave commit to the feature ref for these dispatches. Do not put an
intentional red story on `main` or add it to the default set.

```sh
ref=$(git branch --show-current)
gh workflow run herdr-stories.yml --ref "$ref" -f stories=R19,H-relay-poll
gh workflow run ci.yml --ref "$ref" -f force_full=true
```

| Wave | Gate on the exact commit |
| --- | --- |
| 1. Held link | `H-relay-poll` green with cleanup proved. `R19` red only at the first relayed send. Full CI green, including the default story set without either ID. The live soak tool is ready to run. |
| 2. One relay | `H-relay-poll`, the single-relay `R19`, and full CI green. The live soak can run while this wave proceeds because it exercises the same poll carrier. A failed soak blocks rollout, not development of the delivery code. Fix the held poll, keep the frame and outcome rules, and rerun the live gate. |
| 3. Ordered relays and asks | `H-relay-poll`, extended `R19`, and full CI green. `R19` proves failover and a reply through a different relay. Complete the soak and a live check for each spec build step on assigned machines before shipping those steps. |

## Wave 1. Prove the held link

### Task 1: Write the red relay story

**Files:**
- Create: `packages/herdr/e2e/fixtures/roam-relays.ts`,
  `packages/herdr/e2e/scenarios/roam-relays.test.ts`.
- Modify: `scripts/herdr-e2e.mjs:8-24,168-173`, `packages/herdr/e2e/README.md:15-33`,
  `packages/herdr/e2e/controls/ci-contract.test.ts:101-127`,
  `packages/herdr/e2e/scenarios/runner-contract.test.ts`.
- Test: those two contract files and `R19` on `herdr-stories.yml`.

**Interfaces:**
- Consumes: `Suite`, `stageRoamDestination(input): Promise<{ agent: string; cli: string }>`,
  `spawnOwned(ledger, options): OwnedProcess`, and the `ScenarioDefinition` export contract.
- Produces: `relayFixture(suite: Suite, options?: { secondRelay?: boolean }): Promise<RelayFixture>`.
  `RelayFixture` exposes `sender` and `target` with `id: string`, `alias: string`, `pi: RpcDriver`, and
  `root: string`. It has `startRelay(index: 0 | 1): Promise<void>`,
  `stopRelay(index: 0 | 1): Promise<void>`, and `close(): Promise<void>`. `index` follows config order.
  Add the second relay in Task 6.

- [ ] **Step 1: Write the story and selection assertions.** Export one headless scenario with
  `storyId('R19')`. Use scripted tool calls through the owned Pi RPC driver. Read physical
  `intercom_message` entries by message ID, not terminal output. Give each send distinct text. In the
  matrix contract, `matrixFor(input)` calls the existing `select(input)` subprocess helper, checks exit
  0, and returns the parsed `include` array. Use the runner contract for the two default-profile
  assertions.

```ts
expect(matrixFor('R19')).toEqual([{ story: 'R19', timeout: 5 }]);
expect(matrixFor('')).not.toContainEqual(expect.objectContaining({ story: 'R19' }));
expect(profileIds.headless).not.toContain('R19');
expect(parseOptions(['--task', 'roam'], {}).ids).not.toContain('R19');
// R19, after route and live endpoint controls pass:
expect(sent.details).toMatchObject({ delivered: true, path: 'relay relay-1.invalid' });
expect(sent.content[0].text).toContain('relay-1.invalid');
expect(receivedWithId(sent.details.messageId)).toHaveLength(1);
expect(stopped.content[0].text.split('\n')[0]).toBe('No relay is reachable. Nothing was queued.');
expect(receivedWithText(stoppedText)).toHaveLength(0);
```

- [ ] **Step 2: Run the selector red.** `node packages/herdr/e2e/controls/ci-matrix.mjs R19` fails with
  `unknown story: R19`. Run the two utility files separately. The matrix assertion rejects `R19` before
  registration. The default exclusions still pass.

```sh
npm test -- --config packages/herdr/e2e/vitest.config.ts --maxWorkers=1 packages/herdr/e2e/controls/ci-contract.test.ts
npm test -- --config packages/herdr/e2e/vitest.config.ts --maxWorkers=1 packages/herdr/e2e/scenarios/runner-contract.test.ts
```
- [ ] **Step 3: Wire the fixture and opt-in ID.** Register `R19` in `roamStoryIds` but exclude it from
  `profileIds.headless` and therefore `--task roam`. Include it in `storyWorkers` for one worker. Leave
  `controls/ci-stories.json` and `.github/workflows/herdr-stories.yml` unchanged. The matrix defaults to
  five minutes for an unmeasured story, per the e2e README. The workflow reserves 20 seconds for cleanup
  and upload. `runner-stories.test.ts:21-24` discovers the exported `scenarios` array; it needs no new
  branch or skip.
- [ ] **Step 4: Prove the fixture before the send.** Use the two fenced cores from
  `harness/hc.ts:83-151` and the extra-core pattern in `fixtures/roam-intercom.ts:202-244`. Use aliases
  `relay-1.invalid`, `dest.invalid` and `target.invalid`. Keep the foundation's relay-to-`dest.invalid`
  edge. Add only relay-to-`target.invalid` with the owned `via.mjs` fixture. Do not build a mesh: omit
  the sender-to-target edge and assert its absence in the sender's `hc machine ls --json`. Use one-shot
  identity reads to prove the relay's two routes. Set both session machines' `sendTo` to empty and give
  them each other's origin ID and alias in `acceptFrom`. Stage private roots and packed CLI config as in
  `fixtures/roam-relocate.ts:58-87` and `fixtures/roam-destination.ts:8-32`. Seed running homes and
  fixture-owned placements as in `scenarios/roam-admission.test.ts:55-83`. Prove both live v0
  registrations in the same scope with private broker lookups before calling `send` by full ID. Save
  those checks, the route observations, and the actual tool result to the story evidence before the
  delivery assertion. Do not start the old federation. Set the relay's `roam/config.json` `intercom` to
  `{ enabled: false, machineAlias: 'relay-1.invalid' }`. Use version 2 files and `spawnOwned` to start
  the packed relay. Wait for a row in the sender's `roam doctor --json` `value.diagnostics` whose reason
  starts with `intercom-link: relay-1.invalid up;`. On the base, accept only the explicit
  private-command `invalid-arguments` response and exit 2 instead of that row. In either case run the
  same send assertion. Do not accept a missing route, broker, home, or tool invocation as red evidence.
  Register cores, routes, processes, and agent directories in the ledger. For the stop case, wait for
  the lease to go down, then send again. Observe within 40 seconds to allow the 30-second recency rule
  and the doctor read. Restart the relay and deliver a fresh marker; the refused marker must still be
  absent.
- [ ] **Step 5: Verify the contracts and commit.** Rerun the same two utility files, one at a time. Kill
  mutants that omit explicit `R19`, add it to the matrix defaults, or add it to the runner defaults.
  Commit as `test(roam): specify relay delivery on linux` after the e2e typecheck and build.
- [ ] **Step 6: Dispatch the red.** Run
  `gh workflow run herdr-stories.yml --ref "$(git branch --show-current)" -f stories=R19`. Save the
  exact run, story failure, and cleanup record. Expect the first delivery assertion to show `delivered`
  missing or false and a tool refusal (`invalid-config` at the base, which only reads version 1). Do not
  end this task on a setup or deadline failure. Do not make the story pass in this task.

### Task 2: Implement held polls and prove the pinned carrier

**Files:**
- Create: `packages/intercom/src/relay-protocol.ts`, `packages/intercom/src/broker/relay-links.ts`,
  `packages/intercom/src/broker/roam-relay-client.ts`, `packages/roam/src/relocate/intercom-routes.ts`,
  `packages/roam/src/relocate/relay-poll.ts`.
- Modify: `packages/roam/src/relocate/intercom.ts:28-90`, `packages/roam/src/cli.ts:122-176`,
  `packages/intercom/src/broker/broker.ts:367-408,744-837`,
  `packages/intercom/src/broker/roam-v0-client.ts:13-48`,
  `packages/herdr/e2e/scenarios/roam-relays.test.ts`, `scripts/herdr-e2e.mjs:168-173`.
- Test: `packages/intercom/src/broker/relay-links.test.ts`,
  `packages/roam/src/__tests__/relay-poll.test.ts`, and `H-relay-poll` on CI.

**Interfaces:**
- Consumes: `Transport.resolve(peer: Peer, options?): Promise<Peer>` and
  `Transport.exec(peer: Peer, argv: readonly string[], options: CallOptions): Promise<Buffer>`;
  `V0AgentRequest['from']`, `V0Selector`, `V0Text`, and `V0Delivery` from
  `packages/intercom/src/roam-v0.ts`.
- Produces: `readV0Routes(root: string, config: RoamConfig): V0Routes`. `V0Routes` has `version: 1 | 2`,
  `agentDir: string`, `sendTo: readonly Peer[]`, `acceptFrom: readonly RelayPeer[]`,
  `relays: readonly string[]`, and `linkTo: readonly string[]`. `RelayPeer` is
  `{ machineId: string; alias: string }`. `RelayTarget` is
  `{ machineId: string; selector: V0Selector; homeEpoch?: number }`.
- Produces: `RelaySubmit` is
  `{ type: 'submit'; from: V0AgentRequest['from']; target: RelayTarget; message: V0Text }` plus
  `{ kind: 'send' }`, `{ kind: 'ask'; timeoutMs: number }`, or `{ kind: 'reply'; replyTo: string }`.
  `RelayResult` is `{ type: 'result'; messageId: string }` plus
  `{ attempted: true; outcome: Extract<V0Delivery, { kind: 'socket_delivered' | 'refused' | 'unknown' }> }`
  or
  `{ attempted: false; outcome: V0Refused | { kind: 'refused'; code: 'relay-busy' | 'relay-stopping' } }`.
- Produces: `RelayPoll = { hello: RelayHello; reach: RelayReach; results: readonly RelayResult[] }`.
  `RelayHello` is
  `{ type: 'hello'; version: number; relay: RelayPeer; toMachineId: string; linkId: string; pollId: string }`.
  `RelayReach` is `{ type: 'reach'; peers: readonly RelayPeer[] }`. `RelayPollReply` is
  `{ ready: RelayReady; submissions: readonly RelaySubmit[] }`. `RelayReady` is
  `{ type: 'ready'; version: number; machineId: string; linkId: string; pollId: string }` plus
  `{ ok: true }` or
  `{ ok: false; code: 'version-mismatch' | 'invalid-config' | 'unauthorized' | 'unreachable' | 'relay-busy' }`.
  A refused batch contains no submissions.
- Produces: `encodeRelayPoll(poll: RelayPoll): Buffer`, `decodeRelayPoll(input: Buffer): RelayPoll`,
  `encodeRelayPollReply(reply: RelayPollReply): Buffer`, and
  `decodeRelayPollReply(input: Buffer): RelayPollReply`. The decoders throw a fixed protocol error on
  invalid input.
- Produces:
  `pollV0RelayBroker(agentDir: string, poll: RelayPoll, signal?: AbortSignal): Promise<RelayPollReply>`,
  `listV0RelayLinks(agentDir: string, signal?: AbortSignal): Promise<readonly RelayLinkView[]>`, and
  `submitV0Relay(agentDir: string, relayId: string, submit: RelaySubmit, signal?: AbortSignal): Promise<RelayResult>`.
  `RelayLinkView` has `relay`, `reach`, `linkId`, `state: 'up' | 'connecting' | 'down'`, `sinceMs`,
  `lastCallMs: number | null`, `lastError: string | null`, and `messagesCarried: number`.
- Produces: `createRelayLinks(clock: RelayClock, observe?: (view: RelayLinkView) => void): RelayLinks`
  in `relay-links.ts`. `RelayClock` has `now(): number` and
  `later(ms: number, fn: () => void): () => void`, matching the roam `Clock`. `RelayLinks` exposes
  `poll(poll: RelayPoll, signal?: AbortSignal): Promise<RelayPollReply>`,
  `submit(relayId: string, submit: RelaySubmit, signal?: AbortSignal): Promise<RelayResult>`,
  `list(): readonly RelayLinkView[]`, and `close(): void`.
- Produces: `runV0LinkOnce(root: string, input: Buffer, signal?: AbortSignal): Promise<Buffer>` and
  `runRelayPollLoop(options: RelayPollLoopOptions): Promise<void>` in `relay-poll.ts`. Options:
  `relay: RelayPeer`, `peer: Peer`, `transport: Pick<Transport, 'resolve' | 'exec'>`, `clock: Clock`,
  `signal: AbortSignal`, `reach(): readonly RelayPeer[]`,
  `forward(submit: RelaySubmit, signal: AbortSignal): Promise<RelayResult>`, and
  `observe(view: RelayLinkView): void`. This is one loop per `linkTo` peer, not the service or router.

- [ ] **Step 1: Write the carrier story and behavioral reds.** Add a second explicit headless
  definition, `H-relay-poll`, in the relay scenario file. Drive the packed endpoint with
  `hc exec --on dest.invalid --stdin` and the real private broker. For the story red, send literal
  synthetic `hello` and `reach` lines. Assert that the first reply is a successful `ready` with no
  submissions. Do not import unimplemented modules in this scenario commit, even by deferred import.
  Use fake time in the unit tests to prove hold versus early return without timing a cold CLI boot.
  Real-broker tests use `startTestBroker` as in
  `packages/intercom/src/broker/roam-v0.test.ts:229`.

```ts
// holds an empty poll and wakes early for a live submission
expect(settledAt999Ms).toBe(false);
expect(emptyAtMs1000.submissions).toEqual([]);
expect(earlyPoll.submissions.map(s => s.message.id)).toEqual(['early']);
// refuses overflow
expect(seventeenth).toMatchObject({ attempted: false, outcome: { code: 'relay-busy' } });
// does not hand off an expired submission
expect(expired).toMatchObject({ attempted: false, outcome: { kind: 'refused' } });
expect(nextPoll.submissions).not.toContainEqual(expiredSubmission);
// drops a stalled link at the recency deadline
expect(stateAt29999).toBe('up');
expect(stateAt30000).toBe('down');
// ignores duplicate and old-generation results
expect(outcomesAfterLateAndDuplicateResults).toEqual([{ kind: 'unknown', id: 'lost' }]);
expect(currentSubmissionSettledByOldResult).toBe(false);
expect(reconnectIntervalsMs.slice(0, 7)).toEqual([1000, 2000, 4000, 8000, 16000, 32000, 60000]);
expect(() => decodeRelayPollReply(oversizeLine)).toThrow();
expect(() => decodeRelayPollReply(invalidUtf8Line)).toThrow();
expect(decodeRelayPollReply(fullBatch).submissions).toHaveLength(16);
expect(wrongPollIdAccepted).toBe(false);
expect(outcomeForForgedOrigin).toMatchObject({ attempted: false, outcome: { code: 'unauthorized' } });
expect(versionRefusal).toMatchObject({ ready: { ok: false, version: 1, code: 'version-mismatch' }, submissions: [] });
// v1 config stays exact; a v2 link needs an enrolled peer
expect(v1Routes).toMatchObject({ version: 1, relays: [], linkTo: [] });
expect(() => readV0Routes(v1WithRelayFields, config)).toThrow();
expect(() => readV0Routes(v2LinkWithoutSendTo, config)).toThrow();
```

- [ ] **Step 2: Run the reds.** Run
  `npm test -- --maxWorkers=1 packages/intercom/src/broker/relay-links.test.ts` and, separately,
  `npm test -- --maxWorkers=1 packages/roam/src/__tests__/relay-poll.test.ts`. Expect missing link
  interfaces or an unsupported broker request, not socket setup failure. Commit and hand off the carrier
  story red before adding the endpoint. Dispatch it alone with the Task 1 command and
  `stories=H-relay-poll`. The `H-` ID is already accepted by `parseOptions` and absent from defaults.
  Record the `ready` assertion and the old CLI's `invalid-arguments` response, not an import or setup
  failure.
- [ ] **Step 3: Parse config and batches.** Keep the version 1 exact-key, mode-0600, owner, no-symlink,
  and v0-only checks in the extracted reader. In version 2 default `relays` and `linkTo` to empty.
  Require unique machine IDs, preserve order, and require `linkTo` only when the local machine is a
  relay and each ID has a pinned `sendTo` peer. Do not treat either list as a route or an extension of
  `acceptFrom`. Parse strict UTF-8 NDJSON with `hello, reach, result*` inbound and `ready, submit*`
  outbound. Require exactly one header and at most 16 result or submission frames. Count the LF in the
  262144-byte frame cap, and keep the existing encoded text limit. Reject invalid UTF-8, unknown fields,
  oversized frames, and incomplete batches before dispatch. Validate origin, target, ID, and outcome
  shape with the v0 validators. Read differing protocol versions so `ready` can report both versions.
  Use version `1` for the link protocol, independent of the file version.
- [ ] **Step 4: Add the private broker exchange.** Reuse the owner, inode, socket mode, and health
  checks from `requestV0Broker`, with a separate relay capability and ops. Do not relax `roam_v0`'s
  one-request rule or start a broker from an exec. Send one poll request with bounded metadata. Return
  `ready` with the submission count followed by separate length-prefixed submission records, not one
  aggregate over the broker's 1 MiB frame limit. Clean up the hold timer on socket close. Keep the v0
  broker health check, but do not use its 2-second request timer as the wait for a result. The send's
  20-second budget includes health, hand-off, and the result. Correlate by relay, link, poll, and
  message ID. Accept one held call per link. Apply results before taking new submissions. Atomically
  take or expire each submission: at 2 seconds without hand-off, return `attempted: false`; after it
  could have left the broker, failure or expiry returns `unknown`. A replaced generation cannot take a
  later submit or settle it with an old result. A closed local client releases its waiter, not a
  replayable entry.
- [ ] **Step 5: Implement the carrier.** Bind `link` before the generic `--v0` command. Use the CLI's
  bounded stdin reader for the whole batch. Validate the target identity and membership of the relay in
  `relays` before entering the broker. A version refusal uses the correlated `ready` frame with the
  endpoint's version. Never hold an incompatible poll. The public pin is buffered:
  [the CLI](https://github.com/herdrdev/herdr-core/blob/v0.1.16/crates/herdr-core/src/cli.rs#L488-L502)
  reads all input, and
  [the remote exec](https://github.com/herdrdev/herdr-core/blob/v0.1.16/crates/herdr-core/src/exec.rs#L189-L223)
  returns captured output after exit. Do not add a streaming mode. Resolve the peer at link start and
  reconnect. Call `Transport.exec` with `['roam', 'agent', '--v0', 'link']`, `timeoutMs: 20000`,
  `postReserveMs: 2000`, `remoteTimeoutMs: 5000`, and `maxBytes: RELAY_POLL_MAX_BYTES`, defined as
  `18 * V0_INTERCOM_BYTES`. `transport.ts:248-254` already pins both core identities, and
  `argv-client.ts:43-54` reserves the post-check and rounds the remote timeout to seconds. A 1-second
  hold leaves room for the broker and CLI within the 5-second remote cap and the existing 20-second v0
  call budget. Validate the entire reply and correlate its IDs before dispatch. Bind each submission's
  origin machine to the opened peer. A mismatch gets `attempted: false` and `unauthorized`. Start the
  next call on success without waiting for deliveries. Bound active submissions and result metadata to
  the same 16 slots. Never replay a failed poll's submissions or results. Mark a failed exec down and
  start a fresh link ID after the capped backoff. Abort held calls on stop and drain owned work.
- [ ] **Step 6: Complete the carrier story.** After the first empty poll, start a second call. Wait for
  `listV0RelayLinks` to show that `lastCallMs` advanced. Submit from the live origin. The held call
  returns that submission and its matching poll ID. Send its result in the next call and check the
  origin's outcome.
- [ ] **Step 7: Verify and commit.** After one typecheck and build, the two files pass. Kill mutants
  that accept a changed poll ID, accept a 17th submission, or offer an expired submission to the next
  poll. Commit as `feat(roam): add held intercom relay polls`.
- [ ] **Step 8: Dispatch the carrier green.** Dispatch `H-relay-poll` on the implementation commit.
  Require an empty reply at the hold, a real submission in a held reply, a result in the next call, and
  clean teardown. The wave does not build on the carrier until this passes.

### Task 3: Build the live soak tool

**Files:**
- Create: `packages/roam/src/relocate/relay-soak.ts`, `packages/roam/src/__tests__/relay-soak.test.ts`.
- Modify: `vite.roam.config.mjs:4-9`, `scripts/build-roam.mjs:6-11`, `packages/roam/README.md`.
- Test: `packages/roam/src/__tests__/relay-soak.test.ts`.

**Interfaces:**
- Consumes: `runRelayPollLoop(options: RelayPollLoopOptions): Promise<void>`, `listV0RelayLinks` and
  `submitV0Relay` from Task 2. Reuse the real endpoint and a broker with admitted fixture origins.
- Produces:
  `checkRelaySoak(evidence: RelaySoakEvidence): { ok: boolean; violations: readonly string[] }`.
  `RelaySoakEvidence` has `startMs: number`, `endMs: number`, `links: readonly RelaySoakLinkEvidence[]`,
  and `faults: readonly RelaySoakFault[]`. Each link records its ID, timestamped submit, hand-off,
  outcome, and sink receipt records keyed by message ID, link transitions, and clocks' offset bounds.
  Each submit has `deadlineMs` and a `cadence` or `burst` marker. Each fault records its kind, affected
  link IDs, `startMs` and `clearMs`. Include before and after inventories of owned process birth
  identities and timestamped relay RSS samples with a growth allowance fixed in the run file.
- Produces: opt-in `dist/roam/relay-soak.mjs` with `dial <run-file> <link-id>`,
  `submit <run-file> <link-id> [--burst]`, and `check <evidence-file>`. `dial` and `submit` emit NDJSON
  evidence to stdout. The run file supplies the local `root`, the link's `relayId` and `peerId`,
  synthetic `from` and `target` pins in `RelaySubmit` form, the shared start time, and the RSS
  allowance. Assemble the evidence file from these records and the operator's fault and process
  observations. `check` exits 0 only for a complete passing run.

- [ ] **Step 1: Write the soak checks.** Generate a complete synthetic 8-hour timeline with three links.
  Mutate the evidence one class at a time. Include the fault windows, exact clocks, 100-message burst,
  and independent sink observations.

```ts
expect(checkRelaySoak(complete).ok).toBe(true);
expect(checkRelaySoak(duplicateReceipt).violations).toContain('duplicate-receipt');
expect(checkRelaySoak(outcomeMissingOrLate).violations).toContain('outcome');
expect(checkRelaySoak(unknownOutsideFault).violations).toContain('unknown-outside-fault');
expect(checkRelaySoak(stallAt30001Ms).violations).toContain('stall-detection');
expect(checkRelaySoak(recoveryAt60001Ms).violations).toContain('recovery');
expect(checkRelaySoak(healthyUnder2sBelow99Percent).violations).toContain('handoff');
expect(checkRelaySoak(survivingHelperOrUnstableRss).ok).toBe(false);
```

- [ ] **Step 2: Run the red.**
  `npm test -- --maxWorkers=1 packages/roam/src/__tests__/relay-soak.test.ts`. Expect missing soak entry
  points or failing criteria comparisons, not missing live machines.
- [ ] **Step 3: Build the operator tool.** `dial` reads the pinned `sendTo` peer from the local root and
  drives the production poll loop against the staged endpoint. Substitute an independent
  receipt-recording sink for final session delivery. `submit` uses the real private broker and a live,
  admitted fixture origin. Schedule one synthetic submission every 5 seconds on each of a laptop-to-box
  link and two box-to-box links for 8 hours. Use `--burst` once for 100 concurrent extra submissions
  with distinct IDs. Count all submissions, even the ones the broker refuses. The operator marks a relay
  kill, Herdr restart on each side, 60-second cut, laptop sleep and wake, and a kill of an active link
  endpoint. The tool does not kill processes, change routes, claim machines, or install services. Record
  the identity of the actual endpoint when it is killed during a held call. Retain timestamps and
  process birth identities, not text. Measure hand-off from submission start to receipt by the relay.
  Verify a clock-offset bound for cross-machine timestamps and count that uncertainty against the
  2-second limit. Fail closed if there are gaps in the timeline, process census, or RSS samples. Check
  one final outcome within budget, one receipt for each delivered ID, and no duplicates or receipts for
  refused IDs. `unknown` is valid only for a message in flight at a fault. Require recovery within 60
  seconds, stall detection within 30 seconds, and at least 99% of healthy hand-offs strictly under 2
  seconds. Require no surviving test helpers after the 8 hours and stable RSS against the predeclared
  allowance. Document how to stage, start, mark, stop, and check a run. Keep the tool opt-in, with no
  public tool action or probe mode in the endpoint.
- [ ] **Step 4: Verify and commit.** After the typecheck and build, the same file passes. Kill mutants
  that accept a duplicate receipt, omit the fault-window check for `unknown`, or accept missing cleanup
  evidence. Commit as `test(roam): add held poll soak driver`. Hand the tool to the operator; building
  it is not evidence that the soak passed.

## Wave 2. Deliver through one relay

### Task 4: Authorize and deliver a forwarded submission

**Files:**
- Modify: `packages/roam/src/relocate/intercom.ts:92-107,177-238,396-459`,
  `packages/roam/src/cli.ts:156-169`, `packages/intercom/src/roam-v0.ts:33-49,194-216`.
- Test: `packages/roam/src/__tests__/relocate-intercom-relay-forward.test.ts`,
  `packages/roam/src/__tests__/relocate-intercom.test.ts`.

**Interfaces:**
- Consumes: `RelaySubmit`, `RelayResult`, and `readV0Routes` from Task 2. Reuse `createHomeStore`, live
  broker `lookup` and `deliver`, and the pinned direct call.
- Produces:
  `createV0RelayForwarder(root: string, deps?: V0IntercomDeps): (submit: RelaySubmit, signal?: AbortSignal) => Promise<RelayResult>`.
  `V0RelayAgentRequest` is
  `{ version: 2; relayId: string; request: Extract<V0AgentRequest, { kind: 'lookup' | 'deliver' }> }`.
  `parseV0RelayAgentRequest(raw: unknown): V0RelayAgentRequest | null` parses only the new envelope. The
  reply is the existing correlated `V0AgentReply`. Keep the v1 request parser and normal callers
  unchanged.

- [ ] **Step 1: Write the forwarder reds.** Use v0 home replicas with a fake transport to the receiving
  adapter and real private broker coverage for live pins. The origin, relay, and target are distinct.
  Include a second case where a box relay owns the target and has no inbound route.

```ts
expect(delivered).toMatchObject({ attempted: true, outcome: { kind: 'socket_delivered', id: 'forwarded' } });
expect(targetReceipts).toEqual([{ id: 'forwarded', origin: originMachineId }]);
expect(localRelayReceipts).toEqual([{ id: 'local-relay', origin: originMachineId }]);
expect(localRelayRemoteCalls).toEqual([]);
expect(unlistedRelayOrOrigin).toMatchObject({ kind: 'refused', code: 'unauthorized' });
// refuses a stale pinned target
expect(stalePinnedTarget).toMatchObject({ kind: 'refused', code: 'changed' });
expect(staleTargetReceipts).toEqual([]);
expect(unknownAfterDirectWrite).toMatchObject({ attempted: true, outcome: { kind: 'unknown', id: 'lost' } });
```

- [ ] **Step 2: Run the red.**
  `npm test -- --maxWorkers=1 packages/roam/src/__tests__/relocate-intercom-relay-forward.test.ts`.
  Expect missing forwarder or refused relay envelope. Prove the direct control in the same fixture.
- [ ] **Step 3: Forward only once.** Consume submissions after Task 2 binds `submit.from.machineId` to
  the linked peer. Accept only `kind: 'send'` until Task 7. Read source and target homes with the
  existing read-only identity check. Resolve the target in its scope. Refuse ambiguous, moving, or
  stopped targets. Pin the target's session ID, home epoch, and endpoint epoch before delivery. When the
  target is local, reuse private broker lookup and delivery. Otherwise use the existing `Transport`
  direct call to a pinned `sendTo` peer. Never call the sender-side relay selector from this path. At
  the target, require version 2, relay membership, origin `acceptFrom`, correct destination identity,
  and current home and live endpoint. Preserve the hub's unsolicited `reply-only` refusal, including
  local relay delivery on the hub. Retain the origin as the sender visible to the recipient. Reuse the
  existing `stdinForTimeout` hand-off marker for `attempted`; a failed lookup or pre-handoff check
  cannot mark an attempted delivery. Preserve `unknown` for a lost delivery acknowledgement. Treat a
  validated target refusal as final when it followed an attempted delivery.
- [ ] **Step 4: Verify and commit.** Run the new file and
  `npm test -- --maxWorkers=1 packages/roam/src/__tests__/relocate-intercom.test.ts` separately. Kill
  mutants that omit relay membership, omit origin authorization, or bypass the target epoch check.
  Commit as `feat(roam): validate and deliver relay submissions`.

### Task 5: Route a send through a running relay and show its status

**Files:**
- Create: `packages/roam/src/relocate/relay-service.ts`,
  `packages/roam/src/relocate/intercom-relay-route.ts`,
  `packages/intercom/src/broker/relay-observations.ts`.
- Modify: `packages/roam/src/relocate/intercom.ts:240-394`, `packages/roam/src/cli.ts:142-183`,
  `packages/roam/src/local-diagnostics.ts:513-543,686-714`, `packages/roam/src/relocate/relay-poll.ts`,
  `packages/intercom/src/broker/relay-links.ts`, `packages/intercom/src/roam-v0.ts:50-67`,
  `packages/intercom/src/local.ts:47-60,2733-2806`, `packages/roam/README.md`.
- Test: `packages/roam/src/__tests__/relocate-intercom-relay-route.test.ts`,
  `packages/roam/src/__tests__/relay-doctor.test.ts`, and `R19`.

**Interfaces:**
- Consumes: Task 2's `runRelayPollLoop`, broker list and submit helpers, and Task 4's
  `createV0RelayForwarder`.
- Produces: `startV0Relay(root: string): Promise<{ stop(): Promise<void> }>`,
  `routeV0Relay(routes: V0Routes, targetLabel: string, submit: RelaySubmit, signal?: AbortSignal): Promise<V0RouteResult>`,
  and `localRelayDiagnostics(root: string, config: RoamConfig, nowMs?: number): Diagnostic[]`.
- Produces: `V0RouteResult` extends the tool-side union with refusal codes `no-relay`,
  `relay-unreachable`, and `relay-busy`. It carries optional
  `` path: 'local' | 'direct' | `relay ${string}` ``, `targetMachine: string`, and
  `relaySkips: readonly { relay: string; reason: 'down' | 'cannot reach the target' | 'busy' }[]`. Use
  it for `V0SendPlan` remote `send` and `ask`; do not extend the v1 wire schemas with tool details.

- [ ] **Step 1: Write the routing and status reds.** Use a pinned local session, a healthy direct route
  with an available relay, and a target with no direct route. On both ends query doctor for a version
  mismatch and a missing prerequisite. Test expiry from private status, and use sentinel text to prove
  log rotation and omission of the body.

```ts
expect(local.details.path).toBe('local');
expect(direct.details.path).toBe('direct');
expect(pollSubmissionsForDirectSend).toEqual([]);
expect(directLostResult).toMatchObject({ kind: 'unknown', id: 'direct-lost', path: 'direct' });
expect(pollSubmissionsAfterDirectLoss).toEqual([]);
expect(reachWithoutInboundRoute.map(peer => peer.alias)).toEqual(['relay-1.invalid', 'target.invalid']);
expect(relayed.details).toMatchObject({ delivered: true, path: 'relay relay-1.invalid' });
expect(noRelay.content[0].text.split('\n')[0]).toBe('No relay is reachable. Nothing was queued.');
expect(unreachable.content[0].text.split('\n')[0]).toBe('target.invalid is not reachable through any relay right now. Nothing was queued.');
expect(busy.content[0].text.split('\n')[0]).toBe('Relay busy. Nothing was queued.');
expect(linkRows).toHaveLength(1);
expect(linkRows[0].reason).toMatch(/relay-1\.invalid.*down.*age.*last error.*messages carried/);
expect(versionRowOnBothMachines).toMatch(/local 1.*peer 2|local 2.*peer 1/);
expect(missingRouteRow.reason).toContain('route-missing');
expect(activeAndRotatedLogs).not.toContain(sentinelText);
```

- [ ] **Step 2: Run the reds.** Run `npm test -- --maxWorkers=1 <file>` for each of the two new files.
  Expect missing relay routing and doctor rows. `R19` is still red from Task 1.
- [ ] **Step 3: Start the service and route sends.** Bind `relay` with `runV0Service` and require that
  the local machine be in `relays`. Reuse `localHerdrConnection` to pin the core and a distinct
  root-scoped process lock, following `relocate/runtime.ts:172-222`. Start one poll loop per `linkTo`
  peer. Advertise self and connected `sendTo` peers from an owned `hc machine ls --json` observation.
  Actual delivery still pins destination identity. Use the configured local alias or the selected core's
  display name for `hello.relay.alias`; prefer a local configured alias for a known peer. Preserve the
  v0 local and direct paths. Enter the relay path only for a version 2 session with a valid local home
  and live source and no usable direct route before hand-off. Use the absence of an enrolled peer or a
  positive observation that its Herdr route is unavailable. A failed pin, scope check, or trust check
  does not count as an absent route. Use the exact home for an ID. Resolve a qualifier against
  configured peers and advertised reach without accepting alias conflicts. Use a known configured alias
  in the refusal, or show the target's machine ID if no alias is known. A bare name without complete
  live lookup evidence uses the existing `incomplete` refusal, not a guessed target. Start with the
  first eligible relay. Surface the outcome, path, and skip reasons in tool text and details. Keep the
  spec's refusal summary as the first line. A relayed ask returns `unsupported` until Task 7. Normal
  direct asks and replies stay unchanged.
- [ ] **Step 4: Add status and operator setup.** Own one status row per inbound relay and per outbound
  `linkTo` machine. Write redacted, atomic snapshots to `roam/relay/in/<machine-id>.json` and
  `roam/relay/out/<machine-id>.json` by direction. Keep one log and one previous 64 KiB log per link
  under the same directory. Use the broker's launch root for inbound observations, never a path from a
  poll. Let the broker record authorized version refusals without opening a hold. When the broker is
  unavailable, the endpoint records mismatch metadata separately; doctor reports only the newest row for
  that direction and peer. Count a `socket_delivered` result once on either side. Use
  `intercom-link: <alias> <state>; state age <ms>; last call age <ms or never>; last error <code or none>; messages carried <n>`
  as a `Diagnostic.reason` row. On mismatch use `version-mismatch (local <version>, peer <version>)` for
  last error. Doctor reads only. Report stale state as down and name a missing config, service, broker,
  or route without touching it. Use `route-missing` for an absent configured route. `R19` reads
  `value.diagnostics` from doctor JSON; pre-existing diagnostics may make the command exit nonzero.
  Document the operator-installed `spider-roam-relay-v0.service` systemd user unit and
  `com.spider.roam.relay-v0` launchd agent. Use the packaged CLI, canonical roots, explicit core
  selection, and user-only files. Follow `systemd.ts:18-45`, `relocate/service-install.ts:82-98`, and
  `launchd.ts:103-117,161-197`. Do not attach installation to `roam enable` or change the hub or
  supervisor unit.
- [ ] **Step 5: Verify and commit.** The new files pass after one typecheck and build. Kill mutants that
  skip the direct route, mark stale observations up, or log submission bodies. Commit as
  `feat(roam): route intercom through a relay`.
- [ ] **Step 6: Dispatch the one-relay green.** Dispatch `R19` with the Task 1 command. Require the
  exact delivery path, one physical receipt, the refusal with the relay stopped, and proved cleanup.

## Wave 3. Switch relays and keep asks alive

### Task 6: Select ordered relays and fail over only before delivery

**Files:**
- Modify: `packages/roam/src/relocate/intercom-relay-route.ts`,
  `packages/roam/src/relocate/relay-service.ts`, `packages/herdr/e2e/fixtures/roam-relays.ts`,
  `packages/herdr/e2e/scenarios/roam-relays.test.ts`.
- Test: `packages/roam/src/__tests__/relocate-intercom-relay-route.test.ts` and extended `R19`.

**Interfaces:**
- Consumes: `RelayLinkView`, `RelayResult`, `submitV0Relay`, `V0Routes.relays`, and `routeV0Relay` from
  Tasks 2 and 5.
- Produces: same `routeV0Relay` signature with ordered failover;
  `relayFixture(suite, { secondRelay: true })` with index `1` bound to `relay-2.invalid`.

- [ ] **Step 1: Write the failover reds.** Return link views in reverse order. Then withdraw reach while
  both links continue polling. Cover a refusal before hand-off, a target refusal after attempted
  delivery, and a dropped result after hand-off. Extend the fixture with an owned fourth core and
  directed routes from `relay-2.invalid` to both session machines. Set its disabled `intercom` block's
  `machineAlias` to `relay-2.invalid`. Keep `R19`'s initial single-relay legs, with relay 2 stopped.
  Start the backup once the primary is up again. Add legs for first choice, stop and switch, and open
  but unable to reach `target.invalid`. Remove the remaining relay-to-target edge on the owned core with
  `hc machine rm`; wait for its next reach to omit the target while its sender link stays up. Restore
  the edge for Task 7.

```ts
expect(firstSelected.path).toBe('relay relay-1.invalid');
expect(secondAfterSafeRefusal.path).toBe('relay relay-2.invalid');
expect(nextAfterPrimaryRecovers.path).toBe('relay relay-1.invalid');
expect(skipReasons).toEqual(['down', 'cannot reach the target', 'busy']);
// does not switch after a lost result
expect(lost).toMatchObject({ kind: 'unknown', id: 'lost' });
expect(offersToSecondAfterLostOrAttemptedRefusal).toEqual([]);
expect(noReach.content[0].text.split('\n')[0]).toBe('target.invalid is not reachable through any relay right now. Nothing was queued.');
```

- [ ] **Step 2: Run the red.**
  `npm test -- --maxWorkers=1 packages/roam/src/__tests__/relocate-intercom-relay-route.test.ts`. Expect
  no switch after a known pre-delivery refusal, not a missing peer fixture. Use the unit red as evidence
  before changing the selector.
- [ ] **Step 3: Walk the configured order.** Take a fresh view for each send or reply. Skip down,
  unreachable, and busy links with reasons. Use one overall v0 deadline across choices. After hand-off,
  move on only after an explicit `attempted: false` for an availability refusal. Trust or stale-home
  refusals remain final. A lost result returns `unknown` with the same ID and no second offer. Reach
  changes apply on the next poll. When a preferred relay recovers, new messages use it again. Keep the
  one-relay cases in `R19` before adding the backup.
- [ ] **Step 4: Verify and commit.** Run the route file again after one typecheck and build. Kill
  mutants that use arrival order, fail over after `attempted: true`, or offer a message again after an
  `unknown`. Commit as `feat(roam): fail over between ordered relays`.
- [ ] **Step 5: Dispatch the failover green.** Dispatch `R19` on the implementation commit. Require both
  relay aliases in order, single physical receipts, and no receipt for the open-link refusal.

### Task 7: Deliver a reply after the original relay stops

**Files:**
- Modify: `packages/intercom/src/roam-v0.ts`, `packages/intercom/src/broker/broker.ts:444-501,754-821`,
  `packages/intercom/src/broker/roam-relay-client.ts`, `packages/intercom/src/broker/protocol.ts`,
  `packages/intercom/src/types.ts:84-103`,
  `packages/intercom/src/local.ts:1377-1428,2980-3018,3134-3210`,
  `packages/roam/src/relocate/intercom.ts`, `packages/roam/src/relocate/intercom-routes.ts`,
  `packages/host/src/extension.ts:953-965`, `packages/herdr/e2e/scenarios/roam-relays.test.ts`.
- Test: `packages/intercom/src/broker/roam-relay-ask.test.ts`,
  `packages/roam/src/__tests__/relocate-intercom-relay-route.test.ts`,
  `packages/intercom/src/broker/roam-v0.test.ts`, and extended `R19`.

**Interfaces:**
- Consumes: `RelaySubmit` ask and reply variants, Task 6's `routeV0Relay`, and the v0 home and live
  endpoint checks from Task 4.
- Produces:
  `beginV0RelayAsk(agentDir: string, input: { from: V0AgentRequest['from']; target: RelayTarget; askId: string; timeoutMs: number }, signal?: AbortSignal): Promise<{ result: Promise<V0Delivery>; close(): void }>`.
  `authorizeV0RelayReply(agentDir: string, from: V0Endpoint, askId: string, signal?: AbortSignal): Promise<{ asker: V0AgentRequest['from']; remainingMs: number } | V0Refused>`.
- Produces: optional `V0ToolOptions.prepareReply: V0PrepareReply`, wired by `createV0Intercom` in the
  host. `V0PrepareReply` is
  `(input: { from: LocalSessionInfo; askId: string; message: V0Text; signal?: AbortSignal }) => Promise<V0RouteResult>`.
  Mark only the routed inbound ask with `Message.v0RelayAsk?: true`. Extend `V0RelayAgentRequest` with a
  deliver request plus `thread: { kind: 'ask'; timeoutMs: number }` or
  `{ kind: 'reply'; replyTo: string }`. Permit `relayId: null` only for a routed reply with a direct
  route. Ordinary v1 ask, send, and reply stay on the original protocol.

- [ ] **Step 1: Write the ask reds.** Install a real broker on each end. The recipient observes one
  question. The origin receives a delivery result, then the original relay dies. The recipient replies
  through the second relay, back to the original live asker. Repeat without a reply under fake time and
  test the 9-minute cap. Test wrong scope, changed endpoint, late reply, and duplicate reply by
  observing broker results and inboxes. Cover a reply on an available direct route and a relay-local
  reply to a hub with no inbound route. Prove an unsolicited send to the same hub still refuses. Extend
  `R19` after both routes are restored and relay 1 is back up. Start the ask without waiting for the
  tool to settle. Observe the recipient transcript and the delivery count on the first link. Stop relay
  1, verify the ask has not settled, and trigger a scripted reply through relay 2.

```ts
expect(askSettledBeforeReply).toBe(false);
expect(replyLeg.details.path).toBe('relay relay-2.invalid');
expect(askResult).toMatchObject({ kind: 'replied', id: 'ask-1', text: 'answer' });
expect(physicalQuestionsWithId).toHaveLength(1);
expect(offersAfterLostAskAck).toHaveLength(1);
expect(askTimedOutAfterLostAck).toMatchObject({ kind: 'unknown', id: 'ask-lost' });
expect(directReply.path).toBe('direct');
expect(replyToUndialableHub.kind).toBe('replied');
expect(unsolicitedToHub.kind).toBe('refused');
expect(waiterAt540000Ms).toEqual({ kind: 'no_reply', id: 'ask-1' });
// refuses late and mismatched replies
expect(lateWrongScopeOrDuplicateReply).toMatchObject({ kind: 'refused' });
expect(newInboundMessagesFromRejectedReplies).toEqual([]);
```

- [ ] **Step 2: Run the reds.**
  `npm test -- --maxWorkers=1 packages/intercom/src/broker/roam-relay-ask.test.ts`, then the route file
  separately. Expect missing ask/reply routing or loss of the waiter when the first relay dies. Do not
  substitute a polling timeout for the 9-minute cap check.
- [ ] **Step 3: Separate delivery from reply waiting.** Register the local ask waiter before submitting.
  Bind it to the live asker, its address and epochs, ask ID, target selector and machine, and one
  deadline no later than 540000 ms. Deliver the question once. Return `socket_delivered` after the
  recipient broker accepts it, freeing the poll slot. If delivery is proved refused, close the waiter.
  If the acknowledgement is lost after hand-off, do not resend; allow a matching reply until the
  original deadline, otherwise keep the `unknown` outcome. On confirmed delivery without a reply, return
  `no_reply` at the deadline. Close the waiter on abort or disconnection of the local asker, not on poll
  failure.
- [ ] **Step 4: Route a reply like a send.** Store only reply authorization metadata at the recipient
  broker, fenced to the receiving connection and expiry. `prepareReply` reads that authorization, checks
  the current homes, and runs local, direct, or ordered-relay delivery. Use it for explicit replies and
  for the existing busy reply path when the incoming ask is routed. On receipt, require the original
  live waiter and the pinned asker, scope, and home. Match the replier to the expected machine and exact
  ID or unique named target, using the recipient broker's reply authorization tied to the original
  receiving endpoint. Settle once. Do not inject a stale or unmatched reply as a normal message. On a
  relay's own machine, use local broker delivery. For a hub on version 2, allow a configured
  `acceptFrom` entry only to validate replies to a live ask; never permit unsolicited sends or restore a
  direct route to the hub. Keep the v1 config prohibition and the old socket-bound `handleV0Reply` path
  unchanged.
- [ ] **Step 5: Verify and commit.** The new file, existing v0 broker file, and route file pass
  individually after one typecheck and build. Kill mutants that close the waiter on relay loss, accept a
  mismatched reply, or resend the question after losing its acknowledgement. Commit as
  `feat(roam): keep relayed asks alive after link loss`.
- [ ] **Step 6: Dispatch the ask green.** Dispatch extended `R19`. Require one physical question, a
  reply via the backup, one completed ask, and proved cleanup.

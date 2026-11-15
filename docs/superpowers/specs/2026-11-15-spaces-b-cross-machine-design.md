# Cross-machine panes

## Goal and scope

A space belongs to the person using the Mac, not to a machine. Any terminal in a Mac space can run locally or on an enrolled remote machine. The person chooses the execution machine when creating a terminal, without changing spaces.

Project B adds the machine picker, local presentation proxies, remote-agent placement, machine pills, and remote auxiliary views. Project A supplies the flat Spaces list, machine grouping, Go to integration, and the park shortcut. A ships first. B extends those entry points rather than creating another sidebar or another Go to picker.

The required move invariant is the same Mac space and tab, with the agent visible throughout the presentation handoff. The pane ID need not stay the same. Position and neighbouring pane sizes are best effort. Local agents remain ordinary native panes. Only terminals running on another machine use Mac `hc attach` proxies. Moving a local agent to a box converts its pane once in the same tab: acknowledge the remote proxy beside the old view, then park the old native view without stopping its target. Returning to the Mac acknowledges a native replacement before removing the proxy. Never keep a local agent behind an attach proxy.

### Non-goals

- No remote Herdr spaces, remote tabs, or machine-specific space configuration appear in spider's UI. Existing remote layout documents are neither deleted nor rewritten.
- No machine enrollment, credentials, workspace transfer, home election, or changes to roaming's ownership rules.
- No custom terminal emulator, new SSH transport, or replay of input into pi.
- No automatic pane for background jobs. Their execution, receipts, and lifetime remain independent of their viewers.
- No exact pixel geometry guarantee during native-to-proxy conversion.
- No production app launch, focus, quit, or restart. No default-core stop or restart.
- No widening of the production look-patch version gate in B. The separate final compatibility task owns that change.

## Requirements and design elements

| Decision | Design element |
| --- | --- |
| Spaces and tabs exist only on the Mac. | All destination IDs are local. Presentation terminals belong to the Mac core. Machine identity belongs to the execution target, not the space. |
| A terminal may run on any connected machine. | A native local terminal presents a local target; a Mac attach proxy presents a remote target. Remote targets are ordinary background hc terminals on their own cores. |
| Remote spaces disappear from the UI. | The shared agent projection uses remote terminal facts without exposing remote layout IDs. A's Spaces and Go to filters remain in effect. |
| B1: every new-terminal action asks for a machine. | Cmd-T, the tab plus, both split shortcuts and buttons, and Terminal and agent menu entries enter one machine-selection flow. |
| B1: default to the focused pane's machine. | Resolve the focused presentation to its execution target when the picker opens. An unmanaged local pane defaults to "This computer". |
| B1: keyboard and mouse, unavailable rows disabled. | One filtered row list supplies arrow, Enter, Escape, click, and hover behaviour. Connection state is rechecked before launch. |
| B2: current folder, matching checkout, then home. | A destination-folder port implements that exact order. It reads the target's foreground cwd, not the proxy's local cwd. |
| B3: interactive remote terminal and history. | Run the resolved hc executable with `attach --history 100 <address>`, without `--observe`, for shells and agent panes. Herdr remains responsible for clipboard and local history interaction. |
| B4: confirmed close ends the target. | Spider confirms every remote proxy close through the existing confirm overlay, then records close intent for that exact target before any stop. Native local panes retain today's `pane.close` behaviour and pi confirmation. |
| B4: Send back leaves the target running. | Record parked intent before removing and ending the proxy. Never kill its shell or agent target. A's shortcut and the menu use the same action. |
| B4: sleep, quit, and outages retain remote programs. | A lost attach stream reconnects. An unexplained proxy-process exit counts as Send back and remains reopenable. App or core absence alone changes no visibility intent. No unconfirmed exit ends a remote program. |
| B5: every agent-related header has a machine pill. | A neutral pill immediately follows the session or run-name pill. Local text is always "This computer". Viewer and console pills name where their view process runs. |
| B6: remote viewers and consoles stay with their owner. | Launch remote view processes on the box, present them with Mac proxies, and reserve capacity relative to the owner's Mac presentation. |
| B6: existing priority, size, and lifetime rules. | Keep the 60-column by 8-row minimum, viewer priority, owner-relative placement, explicit-open fallback, and lazy viewers. Console views remain read-only. |
| B7: place hand-started box agents by configured name. | Match the latest verified session name against the Mac spaces configuration, with an optional exact session ID to resolve duplicates. |
| B7: otherwise leave unplaced until the person chooses. | Show a machine-labelled sidebar row. Mac tab selection or dragging writes a session-ID placement preference that survives target and process changes. |
| B8: a moved session stays in its space and tab. | Preserve the presentation and update its target only after valid destination readiness. Seed the remembered Mac slot before a move. |
| Version ruling: support 0.1.13 and 0.1.16. | Test B's API use and patch fragments against both source fixtures. Full production source manifests and version admission remain a separate final task. |
| Rollout ruling: B's live rollout is a maintainer sync. | Commit product assets and setup support, then have the maintainer back up and compare-write the live clones and bindings. |

## Checked starting point

Task 0 blocks runtime work on Tracks 2, 3, and 5 until isolated 0.1.13 and 0.1.16 receipts establish remote-proxy native facts, core-ID-addressed attach, input discard/reset, detach classification, and focus-safe conversion. Unknown means unsupported, not a guessed capability. Record the lowest hc version actually proved and check that floor in doctor. The currently inspected CLI is 0.1.18, not proof that 0.1.16 on a box suffices.

`packages/herdr/src/roam-placement.ts` already starts Mac terminals running interactive `hc attach`. It remembers space and tab in `<globalRoot>/roam/placement/roam-placement.json`. Its current claim is per remote core and terminal ID. Closing that proxy currently detaches without killing the remote program. A new remote terminal ID can create another proxy. B replaces those lifecycle rules where the decisions above supersede them.

`placePaneWithoutFocus` in `packages/herdr/src/jobs/placement.ts` sets `herdr.space` and `herdr.tab` labels, then waits for observed app placement. It does not place a terminal into an exact anchor pane. Explicit auxiliary opens already use `terminal.keep`, owner-relative splits, capacity accounting, and an adjacent-tab fallback.

`packages/herdr/src/spaces/move.ts` and `assets/agents/move-menu.js` reject native moves between machines. B moves the local presentation, not the remote terminal, through those existing Mac-tab operations.

`createViewerLauncher` in `packages/herdr/src/viewers/register.ts` launches next to the owning session and uses its local feed and IPC descriptor. `ensureAgentConsole` in `remote/console.ts` already creates one remote console per agent and machine. `runRemoteConsole` in `remote/runtime.ts` reads retained output without running or signalling payloads.

Roaming Phase 3 is not yet part of this baseline. Its core-only branch keeps session registration and feeds, but rejects `openRun`, `openJob`, and layout moves through `needAppConfig()`. B needs separate launch-only view operations there. Removing that guard from a placement operation would be wrong: a box still has no app.

The current production look manifest admits 0.1.12 source provenance. Live spider clones still carry that provenance even though the app is 0.1.13. The current clone schema covers agents, spaces, pane, tabs, and workspace-chrome, not picker, new-menu, or menu. A owns the 0.1.13 and 0.1.16 fixtures and the full ordered recipe: surviving retained patches, then A's fragments. B anchors only in that recipe's output and replays retained, A, then B records in tests. The separate final compatibility task extends clone staging for picker, new-menu, and menu, extracts `applyModPatches` if needed, and upgrades verified source manifests and admission. Neither A nor B silently relabels old bytes.

The native acceptance adapter in `packages/herdr/e2e/native/capabilities.ts` currently refuses rendered-UI and owned-window input operations. A render-host pass is not evidence of native Cmd-key translation. Native stories remain blocked until a verified isolated adapter or a maintainer's isolated interaction receipt exists.

## Presentation and execution identity

A `PanePresentation` has a stable logical ID, native or proxy mode, a display role, a wanted visibility state, a Mac slot, and an observed execution target. Native mode is required for local agents. Proxy mode is required for remote terminals. Display role distinguishes an agent still registering from an ordinary shell. It grants no routing or stop authority. Native mode uses the target's existing Mac pane; a null proxy address is not permission to convert it automatically. Conversion changes mode only after acknowledgement of the replacement native pane or remote proxy. A `PaneTarget` identifies a core and terminal ID, terminal `created_ms`, and verified operation or ownership labels. Its alias is display and enrollment metadata, never the attach address. Attach addresses are core-ID-qualified terminal IDs. Verify the enrolled machine's core identity and the terminal incarnation before each attach; a reused alias must never redirect input. Session targets also carry session ID and the observed home epoch when roaming applies. A proxy address is never the agent's execution address.

### Module ownership and data flow

| Flow | Owning modules |
| --- | --- |
| Capture a creation or pane action | B's `assets/machines/` and `assets/pane/` helpers, called by the patched pane, tabs, new-menu, and menu callbacks. They capture explicit Mac targets and send bounded typed requests. |
| Validate and apply a request | `src/panes/codec.ts`, `hc.ts`, `capabilities.ts`, `service.ts`, `open.ts`, and `lifecycle.ts`. The service is the only presentation actor. |
| Store intent and publish a binding | `src/panes/store.ts`. The proxy reads its revisioned projection; it does not invent targets. |
| Present a target | `src/panes/proxy.ts`, using hc's existing terminal stream. Herdr owns the displayed terminal grid and clipboard. |
| Discover and choose a slot | `src/panes/inventory.ts`, `src/spaces/remote-placement.ts`, and host's `pane-endpoint.ts` and `pane-folders.ts`. The source returns actual owner and target identities, not IPC capabilities. |
| Reserve and open an auxiliary view | `src/panes/auxiliary.ts` and the existing `jobs/placement.ts` use Mac presentation addresses. Host's `pane-views.ts` and existing viewer and console runtimes retain execution ownership on the box. |
| Render and navigate | `assets/shared/presentations.js` supplies A's sidebar and Go to; `assets/pane/machine.js` supplies headers. Rendering uses display fields, not source socket or file paths. |
| Follow a move | The roaming adapter seeds the old slot and forwards validated readiness to the generic presentation service. Home election and source retirement remain in roaming. |

The main access paths are:

1. Find a presentation by its local proxy terminal.
2. Find the current presentation for a session ID or an owner and run ID.
3. Resolve a target's stable core and terminal identity to a connected core, retaining the enrolled alias only for display.
4. Find a remembered Mac space and tab independently of the target's machine.

Keep execution ownership separate from presentation ownership. `Owner.terminal` continues to identify the real session terminal. Auxiliary placement receives the owner's Mac presentation address as an explicit argument. Do not replace `Owner.terminal` with the proxy or infer execution from the Mac address.

Use branded core, terminal, session, and pane IDs from `contracts.ts`. Parse CLI requests, state files, remote endpoint replies, and hc snapshots at their boundaries. Rendering receives a validated projection. Display labels grant no authority to attach, kill, or move.

### State and labels

| Location or label | Owner and purpose |
| --- | --- |
| `<globalRoot>/roam/placement/roam-placement.json` | The generic placement store, upgraded to version 2 in place. Preserve version-1 slots, attempts, close suppression, and uncertain-launch evidence. Add presentations, target-launch claims, explicit visibility intent, and separately identified manual session choices. A target-launch claim may have no terminal ID; a complete presentation never uses an invented placeholder ID. Slots retain space and tab even when a pane ID is unknown. |
| `<globalRoot>/herdr/panes/bindings/<presentation-id>.json` | An atomic, revisioned projection of one presentation for its proxy process. Rebuild from the placement store after interrupted publication. It is not another placement authority. |
| `<globalRoot>/herdr/panes/service.json` and its private lock | One Mac presentation service claim per selected core. Record a launch attempt before starting the helper. A lost launch reply is uncertain, not permission to start a duplicate. |
| `<globalRoot>/herdr/panes/view-leases/<lease-id>.json` on the view's machine | Source-owned display lease, bound to session generation, run or console ID, view terminal, and expiry. No authority over the child or payload. |
| `<globalRoot>/herdr/panes/remote-agents.json` | A bounded, derived remote-agent inventory. Cache timestamps and completeness explicitly. Source-owned `Owner` facts contain foreign cwd and session-file paths; keep the cache 0600 and exclude those fields from doctor output and public fixtures. No conversation, credentials, private IPC capability descriptor, or transcript body. |
| `<globalRoot>/herdr/spaces/spaces.json` | Existing setup journal. Continue recording observed local-session moves there. Do not use it to assign a remote execution home. |
| `herdr.space`, `herdr.tab` | Only on Mac presentation terminals, with local destination IDs. Never put Mac placement labels on a box target. |
| `spider.kind = pane-proxy` | A generic presentation terminal. Adopt existing `roam-proxy` terminals by verified labels without creating another presentation. |
| `spider.pane-operation` | Correlate a target launch with its recorded operation before its terminal ID is known. Resolve lost replies by verified core and operation labels, never by a guessed address. |
| `spider.pane-id`, `spider.target-core`, `spider.target-terminal` | Discovery and diagnostics for a local proxy. Compare against the private presentation record before any effect. |
| `spider.session`, `spider.run`, `spider.owner-core`, `spider.owner-terminal` | Existing session and child ownership. Retain the real owner's identity on auxiliary proxies. |
| `spider.machine`, `spider.display-name`, `spider.parent-name` | Display facts. The machine label is "This computer" locally and the resolved alias remotely. |
| `spider.kind = pane-service` | The local background presentation helper. It has no pane, agent status, or sidebar row. |

Files and sockets use mode 0600. Directories use 0700. Writes use same-directory atomic replacement under the existing process-lock utilities. Reject symlinks, foreign ownership, future schemas, and malformed records before mutation. Keep the version-1 backup private and retain it through rollout. An uncertain old claim stays uncertain. An old closed claim becomes parked, never authorization to stop a remote program.

One service owns presentation mutations. UI commands and the roaming adapter request changes through its private, same-user socket. The compatibility `rememberRoamSlot` writer uses the same store and process lock; it cannot launch or close a presentation. Installed header and sidebar views reconnect to the service when the app resumes. They may start a proved missing helper only after the selected Mac core is already alive, so a fresh pi session is not needed for recovery. Read-only doctor operations do not start it. Service startup and proxy startup first require a live, identity-matched Mac core. Preserve the existing documented hc check-then-call auto-start race, but make no hc call after the liveness check reports absence.

## Machine picker and creation flow

### What the person sees

The overlay title is "Choose machine". "This computer" is the local row. Other rows use their enrolled aliases, such as `box-1.invalid`. Loading, Connected, and Unreachable are words, not colour-only states. Unreachable rows remain visible, use dim text, and cannot be chosen by any input method.

The overlay uses neutral black glass, a 12-pixel panel radius, medium-weight headings, Google Sans Flex labels, and JetBrains Mono machine names and paths. Selected and hovered rows use white fills. There are no coloured identity tiles, new borders, outlines, or shadows. Amber marks a connection warning and red marks a confirmed operation error. Existing session-name pills retain their current styling. Machine pills never use `identityPill`'s name-dependent colours. A proxy with missing target metadata shows "Machine unavailable", not a false "This computer" label. Retain a last verified machine name during an outage.

Filtering preserves the highlighted machine if it remains selectable. Otherwise choose the first selectable filtered row. Arrow keys skip disabled rows. Enter acts once, Escape closes without a launch, and hover updates the same selection used by click. With no selectable matches, Enter does nothing and the overlay says "No available machines match".

The picker captures the focused target and destination at open time. Later focus changes cannot redirect a split. New-tab actions work from mod panes and layout terminal blocks. Split actions require an actual model pane. A terminal window or layout block is not an implicit split anchor.

### Entry points

Cmd-T opens the picker and then creates a shell tab. The tab plus opens the picker first, then the existing new-menu for the chosen machine. A Terminal or agent choice in that menu consumes the same selection ticket, rather than asking twice. A separately opened new-menu has no ticket, so choosing Terminal or an agent opens the picker before creation. Each independent creation consumes exactly one fresh machine selection.

Cmd-D, Cmd-Shift-D, both header split buttons, and both terminal-menu split actions open the picker with an explicit right or down anchor. A's layout-scoped Cmd-Shift-E remains `spider-pane.park`. A ships global Cmd-Shift-W as `pane.close`; B later owns and rebinds it to `spider-pane.close`, using Herdr's `<mod>.<command>` syntax. For a native local pane this dispatches exactly today's pane-close path, including the existing pi confirmation. For a proxy it confirms through spider, records intent, then ends the remote program. B also owns Cmd-T, Cmd-D, and Cmd-Shift-D through A's section-aware managed-keys mechanism, extending A's owned set and updating A's key tests in B's integration commit.

Cmd-N and the Spaces `+` remain A's local `space.new` actions, including the native initial terminal. B1's creation list does not include them, so they do not open the machine picker. A's Go to new-tab row does open it; its new-space row stays local.

Picker shortcut entry mods have fixed tab, right, and down defaults and load their generated private configuration from their own mod directory. They do not depend on a hidden layout mod receiving commands. Mouse entry points open the same picker with explicit props.

After selection, recheck the connection, target identity, destination tab, and selected agent's installation on that machine. `knownAgents({on})` supplies that machine's actual argv. Never reuse local agent argv for a remote install. A failed probe says "Could not check installed agents" and creates nothing.

### Folder choice and launch

Choose the starting folder in this order:

1. If the focused execution target runs on the chosen machine and reports a foreground cwd, use that cwd.
2. Otherwise ask the source machine's `locate-folder {cwd}` endpoint for `repoKey`, `workspaceId`, and `relativeCwd`. Ask the destination's `resolve-folder {repoKey, workspaceId, relativeCwd}` endpoint for its existing mapped checkout and directory-existence result. Both reuse roaming's mapping code and that machine's global DB. Use the contained relative cwd.
3. Without a matching checkout, omit cwd so that hc starts in that machine's home.

`Terminal.foreground.cwd` is the current OS-resolved directory in hc's schema. `Terminal.cwd` is not an adequate replacement. The current `parseTerminal` drops foreground facts, so B adds a dedicated validated pane-facts read. Never resolve a box path against the Mac filesystem. Missing or ambiguous maps mean no matching checkout. A mapped directory that has disappeared is a visible launch refusal, not a silent local fallback or a new checkout.

Local shells and agents use native terminal creation. For a local split on 0.1.13, revalidate the explicitly chosen anchor, run `pane.focus {pane: anchor}`, then `terminal.open {folder, place}`. `pane.split` has no folder argument there. This focus follows an explicit user creation, not an unattended move. Remote shells and agents start as background, no-notify targets on the box and get Mac proxies. Their lifetime is independent of the proxy's parent. hc's empty argv starts that machine's own shell.

For a remote new tab, allocate a mod placeholder in the captured Mac space, then adopt the proxy and remove only that placeholder after acknowledgement. For an explicit remote split, allocate a mod placeholder beside the captured pane and place the proxy there using observable keep and capability-checked swap operations. Unattended conversion has stricter focus rules below. Record the creation intent and target-launch claim before launch, then the observed target and placement claim before creating its proxy. A lost target-launch reply stays uncertain until operation-label discovery proves the terminal; it never authorizes another launch. For conversion and handoff, acknowledge both layout presence and a non-empty target screen in the proxy using bounded `terminal.read` snapshots. Compare complete, same-size screen reads with `lines: 0` and without storing their text. Incomplete or changing snapshots keep the old view until a matching read or a reported timeout. Native acceptance separately checks the actual rendered frame. On failure after target launch, retain it as an unplaced target and report how to open it. Do not launch it again because pane placement failed.

## Close, park, and reconnect

The Mac presentation service runs as one background, no-notify local-core helper. It is independent of pi and the roaming hub, so B works when roaming is disabled. It consumes hc events, accepts bounded UI requests, and reconciles recorded presentations. It never restarts a shell, agent, child, or command payload merely to restore a pane. Subagent and console views are disposable and may restart on reopen.

| Event or request | Presentation state and effect |
| --- | --- |
| Creation or explicit open acknowledged | `visible`. Local agents use native panes; remote targets reuse a verified proxy or claim and create one. |
| Send back | Persist `parked`, request `terminal.park`, prove layout absence, then end only the proxy. Retain the shell or agent target and its remembered slot. |
| Spider-confirmed proxy close | Persist `closing` with confirmed operation ID, presentation revision, target incarnation, generation, and home epoch before stopping the target. Record `ended` only after proof. A proxy `killed` event alone has no stop authority. |
| Cancelled close confirmation | No visibility or target change, for shells or agents. |
| `server_stop`, `host_shutdown`, `holder_lost`, or missing local core | Retain wanted visibility. Never infer target closure or send a remote kill. |
| Attach subprocess stream ends, target still reachable and live | Park only if Task 0 proves a reliable interactive-detach signal on the pinned hc. Any ambiguous end is connection loss and enters `reconnecting`, never park. |
| Machine disconnected or app absent | Keep the target running. Do not interpret an incomplete snapshot as removal or create another target. |
| Same target reachable again | Reattach a wanted proxy. Retain scrollback and clipboard behaviour through Herdr and hc. |
| Unexplained proxy-process exit, including tab close, space close, or crash | Treat as Send back, retain the remote program and remembered slot, and show a reopenable row saying "Pane closed; still running on box-1.invalid". This applies to shells as well as agents. |
| Verified shell or agent target finished | Show its finished state, retire only owned finished presentation resources, and do not relaunch its program. |
| Subagent or console view finished after lease loss | On reopen of a wanted visible presentation, relaunch only the view through its source-owned endpoint. Never restart the child or payload. |
| New readiness for a moved or restarted session | Update a visible presentation to the new verified target. Parked intent stays parked across terminal-ID changes. A `closing` presentation is never presented or rebound; retain "Session changed. Close again." and refuse the stale close. |

The `killed` reason is documented in hc's terminal schema, but it does not prove user confirmation. Stock tab and space closes have no spider-confirmed intent; their proxy exits park, not kill. Do not add a new tab or space cascade confirmation in B. A's park and B's handoff record intent before deliberate proxy removal. A kill racing an unproved park still has no remote-stop authority. Test proxy-process exit separately from attach-stream loss and app absence.

For a supervised roaming session, close first persists stopped hosting intent for the current epoch, then ends the owning session terminal. Use a generation-bound pane-close endpoint and follow the existing local session-shutdown policy. Existing `killSession` includes session teardown; B must not silently add a promise that closing an agent leaves its children alive. The endpoint persists supervised stopped intent before that normal shutdown. The source hosting observer classifies a verified native `killed` outcome for its current execution terminal as explicit stop before scheduling any restart. A killed Mac proxy is not an execution-terminal outcome and cannot stop hosting. Core-loss reasons retain running intent. Handoff kills at an old epoch cannot stop the new home. Closing a viewer or a console ends its view process, not the child or command payload. Explicit Kill subagent and Kill command keep their existing owner-mediated semantics.

A lost stop reply leaves `closing`, not success. Reconcile the same operation ID and exact target. If the home epoch changed or an alias now names a different core, refuse stale closure and show "Session changed. Close again." A failed remote close remains a pending sidebar diagnostic. No signal handler in an attach proxy sends a remote kill.

The proxy runs the resolved absolute hc executable with terminal output and a gated TTY input path. While disconnected or retargeting, it owns stdin in raw mode and reads and discards input. Flush queued terminal input with `tcflush(TCIFLUSH)` or a proved equivalent immediately before each attach. Task 0 must prove the packaged TTY path; unguarded inherited stdin is not sufficient. Before every attach, every status text, and exit (including a retarget that writes no status line), leave the alternate screen, disable mouse tracking, bracketed paste, and kitty keyboard modes, and show the cursor.

It reattaches after connection failures with delays of 1, 2, 5, and then 10 seconds, capped at 10 seconds. A newer binding resets backoff. Watch binding revisions while attached. Verify core identity, `created_ms`, and ownership labels before attaching to `<core-id>/<terminal-id>`. Verify the attach's selected core again before releasing input; refuse mismatches without forwarding a keystroke. Never attach by machine alias alone. A newer binding cancels and reaps only the owned hc attach subprocess before attaching to the new target. Do not wait for source shutdown to notice a retarget, and do not classify this cancellation as park. Do not retry a proved finished shell or agent target. Expired subagent and console views go through the service's restart-on-reopen path. An unexplained proxy-process exit parks the presentation until explicit reopen. A stream interruption can reconnect the still-wanted proxy after ownership and layout checks. A missing app prevents layout work and cannot change visible intent.

A local-to-remote conversion keeps the native source view until a proxy to the ready remote target is acknowledged in the same tab. Remove the old view with `terminal.park`, not `pane.close`; roaming owns source shutdown. On 0.1.13, if conversion would change focus and the old pane is not focused, defer conversion until the user focuses that pane or tab. After committed readiness, the old view shows a non-interactive placeholder, "moved to <machine>; focus to reconnect". Do not forward input to the retired source. If the old pane is focused, focus may follow its replacement. On 0.1.16, use a capability-checked no-focus path only if Task 0 proves one exists. Unattended conversion must never select an unrelated anchor or use directional swap. Return-to-Mac conversion follows the same focus rule and replaces the remote proxy with a native pane.

The initial attach requests 100 history lines, matching the existing roaming implementation. Herdr stores subsequent output locally. Reattachment redraws the remote screen. No exactly-once history cursor or unlimited pre-attach history is promised by `hc attach`.

## Remote discovery and remembered placement

Remote session discovery combines enrolled-machine terminal snapshots with a bounded, source-owned agent endpoint. The endpoint joins live process presence, terminal registration, and session feeds on the box. It returns session ID, generation, name, current cwd, status, child or console summaries, and an optional attachable target identity. A live session outside hc has no target: show it with its machine pill and a disabled "Move to tab" action whose reason is "Not in an hc terminal". Never fabricate a terminal ID. It does not export raw feed capabilities or use a two-minute replica as proof of liveness.

Call the host-owned `dist/herdr/pane-endpoint.mjs` through the existing remote runtime bootstrap: configured Node, a content-addressed digest-verified bundle, and a version handshake for the pane protocol and build. Invocation is `[configuredNode, verifiedEndpointPath, '--json', encodedRequest]`. Setup installs support; UI refresh never uploads code, assumes the Mac CLI is installed on a box, or introduces a Herdr-to-host import. Drive refreshes from relevant core events and actions, with a five-second poll while the UI is present as fallback. Permit one in-flight refresh per machine, bound deadlines below mod exec's 30 seconds, and back off unreachable machines rather than stacking timeouts. Batch viewer lease renewals per machine. Keep at most 256 session rows per machine in a response bounded to 1 MiB. Page larger inventories. Retain cached unreachable rows with their age and no destructive actions. A timeout does not mean a session ended.

Placement priority is:

1. A previously acknowledged manual choice for that session ID.
2. Its verified remembered Mac slot from an existing presentation or roaming move.
3. A unique configured name selector, constrained by its optional session ID.
4. No placement.

Configured-name placement adds the presentation to that configured space's existing managed tab. For passive placement, check the selected app's `tab.new` capability, not its version string. Read `herdr-app commands` JSON or the mod's `commands()` list through the app port. Check `tab.new`'s structured argument names, not d.ts comment text. Cache by command-list digest and treat missing or unknown metadata as unsupported. Isolated stories verify that the flag preserves shown space, selected tab, and keyboard focus.

When background-tab creation is supported, create one local tab for a tabs-layout session with `focus: false`. Otherwise reuse an existing tab in the configured space through `placePaneWithoutFocus`. Prefer an existing managed tab, then the first existing tab in layout order. If the space has no tab, keep the configured-space assignment pending until an explicit open creates one. This is the approved 0.1.13 fallback; 0.1.16 supplies the checked capability. A later app exposing the same capability needs no B version-string branch. Never create and reselect a tab to hide a focus change. Placement never starts a second pi process. A renamed session keeps an acknowledged manual choice. Duplicate names without a disambiguating session ID remain unplaced with "Name matches more than one session".

An unplaced agent still appears in A's agent list and Go to, with its machine pill. Move to tab, Move to new tab, or dragging selects a Mac destination and records it only after observed placement. A deleted destination invalidates that destination, not the session preference itself. The row offers a fresh choice rather than creating a replacement space automatically.

A remote shell created by B also remains reopenable after Send back. List its tracked parked target as "Terminal" in the existing pending-terminal part of Agents and in Go to, with its machine pill. Opening it reuses the same target. Do not list every unrelated box shell or background job.

Task 0 is an early blocking proof on isolated cores with both app versions. Record a remote proxy's native title, app, status, cwd, `agents()` membership, tab and space status, and close confirmation using a synthetic OSC 7501 program. Do not assume Herdr's `agents()` sees remote pi behind `hc attach`. Headers resolve verified `spider.target-core` and `spider.target-terminal` labels to source `terminals()` facts for name, working, blocked, error, and done status, and `foreground.cwd`. That lookup is display-only. Spider supplies the name and status header, machine pill, its own Agents projection, and confirmed close when native facts are missing. Native tab/space dots and `agent.next/prev` are promised only if the spike proves propagation; otherwise document that limit and route spider navigation through the projection.

The shared projection folds the actual target and its local proxy into one agent row. A's sidebar takes remote agents from spider's projection, including remote agents still in box layouts, and never depends on a remote entry in Herdr's `agents()`. Deduplicate those native box rows. B removes A's interim remote-pane-focus path; open, park, Move to tab, Move to new tab, and drag act on the Mac presentation through the service. Child and console rows keep their real execution identities and gain their local presentation addresses for focus. A's space and machine grouping, ordering, and Go to use that same projection. No new sorting preference is introduced in B.

## Remote viewers and consoles

Resolve the owner to a Mac presentation before reserving any auxiliary pane. `createAuxiliaryPanes` uses that presentation for app lookups and size checks while retaining the real `Owner` for run authentication and remote lifecycle operations.

A remote viewer runs on its owner's machine beside the child's transcript, feed, and live IPC pipe. Add a launch-only endpoint that calls the existing viewer launcher without invoking box-side pane placement. Preserve saved-run opens, existing steering admission, protocol 2, and generation checks. Console output stays read-only and uses `hc attach --observe`; that mode does not type or resize the remote console. Do not represent it as an interactive agent terminal.

Reserve and acknowledge the Mac auxiliary placeholder before starting a viewer. The proxy initially says "Opening viewer". Start the source-owned viewer only while that placeholder is displayed. Renew private display leases in one batch per machine every five seconds after observed pane presence. A remote view exits after 20 seconds without renewal, or immediately on a proved hide or close. Sleep and app closure can expire the lease, never the child. On reconnect or reopen of a wanted visible pane, relaunch an expired subagent or console view through its launch-only endpoint, not the child or payload. A 30-second sleep must recover the view. Shell and agent programs are never relaunched by this path. Ordinary remote shell and agent targets have no such display lease.

Keep existing auxiliary priority: viewers outrank job observers and consoles, and no agent or payload pane is a capacity victim. A viewer opens below its owner when every resulting pane can retain at least 60 columns and 8 rows. Otherwise use the existing explicit-open adjacent-tab fallback within the same Mac space. A console follows the same owner-relative preference and capacity accounting. Automatic viewer opens remain opt-in and do not launch a view when no slot is available.

Console identity remains one per agent and execution machine, including child-owned consoles. Reuse the console runtime already retaining that agent's output. Closing or parking its presentation never cancels the payload jobs beneath it. Console views are disposable: park, lease expiry, and reopen may stop and restart the read-only view while retaining output and the one-per-agent-per-machine key. A missing remote runtime, incompatible build, or stale owner produces an unavailable view, not a local substitute.

## Herdr 0.1.13 and 0.1.16

The required matrix is 0.1.13 live and 0.1.16 staged. The staged update was replaced while this plan was written. The following comparison uses a refreshed source capture whose app metadata reports 0.1.16, including the complete generated mod API. Do not wait for an older update's fixtures. If staging changes again before release, the separate final compatibility task captures and checks whatever version is staged then before admitting it.

The inspected app bundle has no separate shipped hc executable. Both app versions use the selected external hc. The inspected attach CLI accepts machine-qualified addresses, `--history`, and `--observe`; `--observe` explicitly disables input and resize.

| Checked 0.1.13 to 0.1.16 difference | Consequence for B and final compatibility integration |
| --- | --- |
| 0.1.16 adds `exec(..., {timeout})`, capped at 600000 ms. 0.1.13 has the fixed 30000-ms bound. | Keep mod requests below 30000 ms on both. Long reconnect work belongs to the background helper, not a mod exec call. |
| 0.1.16 documents failed `knownAgents` checks as uncached. Its new-menu retains installed choices and shows failed-probe text. | Recheck on the chosen machine and preserve visible probe failure. Do not translate failure into "not installed". |
| 0.1.16 adds `pane.swap {pane?, target}` alongside directional swap. | Directional swap on 0.1.13 is allowed only for explicit creation or an already focused conversion. Defer unattended conversion if it would steal focus. Use explicit-target swap on 0.1.16 only after command and no-focus capability verification. Neither version supplies permanent terminal replacement. |
| 0.1.16 documents machine-qualified parent addresses and terminal-window focus. | Normalize parent links by core and terminal identity on both. Require a model pane for splits rather than trusting implicit focus. |
| 0.1.16's pane mod adds `layout` and `paneFrame` and can draw a bottom header divider. | Its import and frame anchors differ. Preserve bottom-header behaviour and remove only the intended chrome divider. |
| 0.1.16's tabs mod adds `ScrollHandle`, selected-tab visibility updates, and live agent-title labels. | Preserve scrolling and explicit tab names when changing the plus and menu callbacks. |
| 0.1.16's picker adds keyboard selection for earlier rows and changes filter selection. | A owns Go to restyling. B adds presentation-aware focus without discarding that navigation. |
| 0.1.16's menu checks whether the clicked target belongs to a tab. | Do not offer split, zoom, or close for layout terminal blocks. Apply the same guard to 0.1.13's B menu callbacks. |
| 0.1.16's agents mod changes title handling, done grouping, and child focus. Its spaces mod adds `ScrollHandle`, bounded Git concurrency, ref-only reads, and compact rail cells. | A owns the sidebar patches. B consumes A's projection and preserves the update's navigation and bounded reads. |
| 0.1.16 adds `checking()`, which is true during native mod checking, where `init` and its effects run. | Guard B's service startup and writes. On 0.1.13, use an explicit check-mode configuration in isolated validation, defaulting to no mutation. Never require a missing named export. |
| 0.1.16 adds `focus: false` to space and tab creation; 0.1.13 does not document it. | Gate background tab creation on command capability. Otherwise reuse an existing configured-space tab through `placePaneWithoutFocus`, or stay pending until explicit open. Never steal focus. |
| 0.1.16 adds terminal selection commands, `TerminalSelectionState`, and `PaneScroll`. | Preserve Herdr's copy, selection, history, and alternate-screen behaviour. The picker must not discard those focused-terminal fields. |
| 0.1.16 adds window-title and badge setters plus terminal sizing and scroll-speed settings. | Leave title, badge, and terminal appearance to existing owners. B never changes OS window identity or terminal settings. |
| 0.1.16's `watchFolder` returns cancellable `FolderWatch` and caps outstanding watched folders at 64. | Cancel view-owned watches when hidden. B's bounded inventory timer is not a recursive workspace watcher. |

Sequential application of the current 0.1.12 patch set to shipped 0.1.13 sources stops at `agent-row-name` and `rail-pending-filter`. Its pane and tabs anchors still match there. On 0.1.16 it stops at `child-action`, the spaces import `rail-scrollbar-import`, and the pane's `style-1`. Tabs anchors match, but import and scroll behaviour still need checking. Matching one anchor does not certify a whole source version.

A's Track 4 recipe tasks own verified canonical 0.1.13 and 0.1.16 fixtures with Herdr's NOTICE and all imported bundle files. B consumes them, adding only missing manifest digests and API or structured-command snapshots. B tests replay the full retained-plus-A-plus-B recipe and verify final bytes on repeat, not B records on stock sources. The separate final compatibility task owns clone-kind extensions, any `applyModPatches` extraction, production manifests, admission, and full setup idempotence tests. B supplies tested patch fragments and API constraints. Never change a source version string or accept an unknown digest to bypass the gate. Drop 0.1.14 from this feature's support and test matrix.

## Roaming integration

### Replace Task 4.5b

Delete the remote-only pill task and its "local sessions have no pill" assertion. Project B's header task is its replacement. Require one neutral machine pill on every top-level agent, subagent viewer, and agent console, including "This computer" locally. Shell-detected proxies still use validated target metadata. Keep long-name, narrow-header, restart, and missing-metadata tests.

Replace Task 4.5b's detach-only close acceptance with B's distinction: confirmed close ends the actual session target, Send back retains it, and connection or app loss never ends it. A parked session stays parked after a new terminal ID. B also owns remote discovery, remembered manual placement, and local presentation addresses for sidebar and Go to.

### Amend Task 4.5

Keep destroyed-machine confirmation, durable revocation, mirror validation, home epochs, and conflicting-home refusal exactly as specified. Add presentation reconciliation after a verified restored Mac readiness receipt, not during the assertion or home CAS.

Retain the old Mac slot and visibility intent. A visible presentation converts to the restored native local terminal and says "This computer", subject to the same focus/defer rule. A parked presentation stays unplaced. A missing mirror or invalid workspace cannot create a proxy or launch a session. Reusing a revoked alias does not retarget an existing presentation to the new machine. Stale close requests remain bound to the revoked target and cannot kill its restored successor.

Add these cases to `forget.test.ts` and the recovery story: `restored home retains Mac slot and visible intent`, `parked revoked home remains parked`, and `reused alias cannot capture a presentation or close its restored target`.

### Amend move composition and Task 4.6c

Before the first freeze or source shutdown, roaming Task 4.6a's `packages/roam/src/move-ports.ts` binds the injected generic `prepareHandoff` port to capture the source's Mac space, tab, visibility, and focused state using `rememberRoamSlot` with `<globalRoot>/roam/placement`. It does not create a proxy to a local target. Roam never imports Herdr. After verified remote readiness, `presentReadyTarget` acknowledges the remote proxy beside the native view, then parks the old native view. Apply the focus/defer rule above, including the non-interactive moved placeholder. A failed presentation remains pending without changing committed home ownership. A return to the Mac creates a native replacement, not a local attach proxy.

After valid destination readiness, retarget an existing proxy only for a remote-to-remote move. For a change between local and remote, convert once in the same tab. Await a presented destination screen before removing the source view when the app is available and conversion is focus-safe. A `closing` presentation cannot be rebound or presented; keep the "Session changed. Close again." diagnostic. Keep the source control-only view until that screen is observed. With the app absent, preserve the wanted presentation as pending and complete only the normal, evidence-based source retirement. Source shutdown and helper cleanup are handoff operations, not user close. App absence leaves placement pending without launching the app or rolling back a committed move. This updates Task 4.6a's placement port binding, but not its ownership transition rules.

Roaming Task 4.6a owns binding `prepareHandoff` and `presentReadyTarget` in `move-ports.ts` using injected generic ports. It declares those ports before B 6.2a supplies the service operations. Task 4.5 calls the same injected `presentReadyTarget` port after restored readiness. B 6.2a depends on 4.6a, not 4.6c. Task 4.5 tests an injected presentation port without waiting for B's concrete implementation, so 4.6a can finish first. B 6.3 owns only B01 through B08 and does not wait for roaming's story gate. Roaming 4.6c runs afterward, owns the R06, R07, and R09 extensions using B helpers, and depends on B 6.1a through 6.1e, 6.2a, 6.2b, 6.3, A, and the separate final compatibility task. It no longer depends on standalone 4.5b. This order has no acceptance dependency loop. Preserve R06 through R10 and the existing move, Git, usage, intercom, and admission assertions.

Extend R06 and R07 to observe the same Mac space and tab, continuous view or the approved deferred placeholder during native conversion, native panes for local agents, proxy retargeting between remote homes, and correct machine text in both directions. Extend R09 with Task 4.5's visibility and alias cases. Add B's close, park, outage, remote-viewer, and manual-placement stories to the packaged acceptance set. Report native input prerequisites as blocked, not passed by render-host tests.

Update roaming A18 to cover local, remote, viewer, and console pills and the close versus park distinction. Replace the remote-only pill sentence in the roaming spec's supervisor and acceptance sections. Update its deferred-list entry so remote sidebar placement and view opening are attributed to B, while usage views and unrelated move controls remain deferred.

## Verification and rollout

### Verification

- Unit tests cover folder ordering, target identity, visibility transitions, legacy claims, manual preference priority, and generation-bound endpoints. Use fake clocks for retry and lease expiry.
- Look-patch tests render the actual patched pane, tabs, new-menu, menu, and A-owned picker and agent projection against both source versions. Check callbacks, disabled rows, pill text and order, narrow layouts, and repeated application. Source-string matches alone do not prove an action.
- Fake-hc tests record target and proxy argv, reject unqualified remote fallback, inject lost replies and changed aliases, and distinguish killed from core-stop events. No test attaches to a real terminal.
- Headless Herdr stories use packed product entries, real owned hc cores, synthetic agents, independent roots, and guarded cleanup. Inspect real target liveness, Mac layout, selected cwd, and process counts.
- App stories use an isolated app home and a fenced owned window on each version. Prove keyboard, mouse, paste, copy, resize, history, confirmation, and best-effort conversion geometry. Until native interaction is available, retain a blocked automated result and require a maintainer's isolated interaction receipt. Never operate on the person's existing window.

Keep unit and non-process integration tests within 5000 ms. Run core and app stories serially with the existing acceptance deadlines. Inject service installation, display, and power operations. Fingerprint unrelated state before and after the batch.

### Rollout

1. Every B track branches from A's integrated commit, recorded by SHA in its brief. A Track 4 Tasks 4.1.1 through 4.1.5 provide the fixtures and ordered recipe. Complete B Task 0 before freezing Tracks 2, 3, or 5. Integrate the merged Phase 3 core-only contracts before remote endpoint wiring.
2. Integrate B's tested patches and assets. Complete the separate final compatibility task before certifying stock-source setup or the update path. Do not claim B has widened the gate.
3. Setup stages B's owned mods, helper configuration, global bindings, labels, and shared projection through the existing backup and compare-write machinery. No setup probe creates a real remote agent. Doctor checks installation and reports readiness without starting services.
4. The maintainer backs up the live app clones, layout, keys, and placement state, then syncs the approved B changes. Preserve unrelated settings and open native sessions. Do not quit, focus, launch, or restart Herdr. A one-time native conversion occurs only when that session needs it.
5. Doctor checks both source versions, owned patch markers, shortcut routing, selected core identity, service claim, private modes, target identity, proxy uniqueness, pending closes, viewer leases, runtime compatibility, and remote-feed freshness. Unreachable targets are unavailable, not removed.
6. Validate the isolated acceptance receipts before enablement. The person installs the app update themselves. Keep a compare-write rollback of B's UI changes and stop only B-owned helpers with proof. Rollback parks presentations and retains remote programs and placement evidence. An older binary must refuse the version-2 state rather than overwrite it. Doctor excludes cached source `Owner.cwd` and `Owner.sessionFile` from output. Record idle CPU and process-count observations in B04 and B06, including unreachable-machine backoff and batched lease renewal.

## Resolved choices and known limitations

"This computer" is the local machine text everywhere. Remote viewers run next to their children. Consoles reuse their existing box runtime. Manual placement outranks later name matching. Local-to-remote and remote-to-local conversion preserves space and tab, not a pane ID. On unfocused 0.1.13 panes, the approved moved placeholder preserves the slot until focus allows conversion.

Herdr can rebalance neighbouring splits while the old and new panes coexist. B restores position and sizes as closely as its keep and swap commands allow, but cannot promise identical geometry. Both versions lack a documented permanent replace-terminal command. Native input automation is currently unavailable in the acceptance adapter. These are explicit limits, not reasons to weaken the space, tab, or target-lifetime requirements.

The maintainer rulings settle the product choices. Task 0 still must establish the runtime capabilities. The capability-gated no-focus fallback is approved: reuse an existing configured-space tab when background tab creation is unavailable, or remain pending until an explicit open if the space has no tab. The maintainer must supply isolated native-interaction evidence if the owned-window adapter is still unavailable. Keep that release check required rather than infer it from headless results.

## Coverage check

The requirement table covers the common model, B1 through B8, and both later rulings. The design separates execution, presentation, view leases, and home ownership. Close suppression, parked restarts, and legacy uncertain launches are consistent across creation, discovery, and roaming recovery. Every failure state has either no effect, a recorded pending operation, or a proved terminal outcome. Task 0 explicitly blocks dispatch on unproved remote-proxy facts, core-ID addressing, and input safety. Deferred conversion has a specified non-interactive placeholder rather than an implicit focus change. Both source versions were checked read-only. Native interaction remains an explicit acceptance prerequisite. Passive placement has an approved, capability-gated no-focus fallback. The implementation plan assigns these elements to six tracks and reserves shared patch integration for one writer.

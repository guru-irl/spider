# Spaces sidebar, Go to, and Send back

## Goal

Make spaces a short list of the work on this computer. Put machine grouping in Agents, make Go to find individual spider sessions and their children, and give Send back its own key. Keep console rows folded until requested. Keep agent alerts silent unless an agent intentionally asks for attention in the spider panel.

Project A ships before Project B's cross-machine panes. This document describes the interim behaviour as well as the final direction. Herdr app 0.1.13 and 0.1.16 are the required targets. Other releases are not certified by A.

## Non-goals

A does not create remote terminals, generalise `hc attach` proxies, change close semantics, move viewers to another machine, discover sessions on another machine, or change roaming placement. It does not widen the patch engine's supported-version gate. A separate final compatibility task owns that change.

Spaces and tabs remain defined on this computer. Background jobs continue without panes. A does not delete remote spaces or terminals to remove their sidebar rows.

## Decisions and their design elements

| Decision | Design element |
| --- | --- |
| Flat Spaces list, with shapes and names | `spider-spaces` lists only `space.machine === null`, in Herdr's stored order. Every row is at the same depth. |
| Keep the Spaces header's `+` | The button creates a local space with `space.new { machine: "" }`, even while a remote space is selected. |
| Remove machine rows, their folds, and New space there | Remove the Spaces machine renderer, polling, and fold-state reads. Move connection refresh, Reconnect, and copyable login guidance to Agents machine headings. Do not hide the old group with CSS. |
| Add Grouped by machine after the existing sort choices | Extend the existing `SORTS` menu with `{ id: "machine", label: "Grouped by machine", icon: "server" }`. Keep Priority and Grouped by space unchanged. |
| Machine headings have the same tree, caret, and folded pills as space headings | Use the existing group-header and thread-line renderer with a machine group descriptor. |
| Move the connection dot to machine headings | Headings show a six-pixel green dot for a connected machine, and a dim dot otherwise. This specific connection indicator is the exception to red and amber state accents. |
| Persist the sort choice | Keep `shared("agents.sort")`, with values `priority`, `grouped`, and `machine`. An unknown value still selects Priority. |
| Restyle the existing Cmd-P picker | Install a derived `spider-picker` mod. Bind Cmd-P to `mod.open:spider-picker`. Do not create a second navigation window or palette. |
| Spaces, tabs, and named agents in Go to | Local spaces contain selectable space and tab rows, followed by individual named session rows and their children. An Agents without a local tab section contains the remaining agents. |
| Include subagents and consoles under their owner | Reuse `projectAgentChildren` before sidebar fold filtering. A console of a subagent stays under that subagent. Finished runs stay within existing retention limits. |
| Focus or open using the existing priority | Focus an existing pane first. Open a missing child through `openRun` or `openJob`, which already uses the free auxiliary slot and new-tab fallback. Explicitly reopen a parked primary terminal without treating it as an auxiliary viewer. |
| Cmd-Shift-E runs Send back | Add `keys["layout:spider-glass"]["cmd-shift-e"] = "spider-pane.park"`. The header's `nextCommand` handler reads the focused terminal and passes its explicit address to `terminal.park`. |
| Cmd-Shift-W stays pane close | Require `global["cmd-shift-w"] = "pane.close"`. Do not reroute it to parking or change the existing close hook in A. |
| Setup and doctor own the keys | Add section-aware managed key merging and checking. Preserve the five terminal key sequences and Ctrl-V image paste. |
| Live edits require a backup and a maintainer | A's live rollout is a maintainer sync of checked mods and key fields, with backups and compare-writes. No setup cutover, app restart, or focus change is part of that sync. |
| Agent consoles are folded by default, with a caret and consoles count pill | Add a Consoles group under each agent or subagent that owns consoles. Its independent caret reveals the console rows, not the subagent rows. |
| No automatic agent notifications or sound | Disable native automatic sounds on both releases, filter native finished and needs-you toasts only on 0.1.16, and stop deriving notification cards from session status or pending memories. Existing status, Problems, and memory-review views remain available. |
| Agents intentionally notify through spider | Add `spider notify { message, urgency }` for a parent or subagent. Persist the request and show it in the existing panel list, with dismissal, identity-checked focus, and default-on sound controlled by `herdr.notifications.sound`. |
| Both installed and staged app releases work | Record exact 0.1.13 and 0.1.16 source anchors and variants. Test transforms against both releases independently of the unchanged engine version gate. |

### Interim access to box-owned spaces

A hides box-owned spaces from the Spaces list and Go to's space and tab rows. It still lists their agents. Selecting an agent whose only pane is in a box-owned space uses today's native `pane.focus`, which shows that space while it is selected. The Spaces list remains local-only and does not invent a selected local row.

This agent selection is the interim way to reach box-owned spaces. It is not an error or an unavailable state. B removes this exception by focusing a local proxy instead. Existing local panes and roaming proxies remain selectable throughout. A must test that a remote agent selection still reaches its existing pane.

## Current implementation and choice

The installed spider clones derive from Herdr 0.1.12. The current `look/patches.json` and `applyLookPatches` also recognise only that version. The unmodified live shipped mods are 0.1.13 sources. The staged bundle identifies itself as 0.1.16, and its mods differ from 0.1.13. Do not relabel a clone's provenance to make it pass the engine gate.

Three approaches were considered:

1. Patch the existing Spaces and Agents clones, and derive the picker from its shipped mod. This keeps the current sort popup, tree lines, overlay, and placement backend. This is the selected approach.
2. Replace the entire sidebar and navigation with a new mod. This duplicates native agent behaviour, pins, elapsed times, and pane ownership. Reject it.
3. Put machine selection into Spaces or open another picker. This preserves the clutter or creates competing navigation. Reject it.

The selected design keeps small pure projections outside the upstream source. Exact patches connect those projections to the existing Views. Ship one derived picker file, with release-aware API adapters and the upstream digests as provenance. Do not also store its class body in a patch replacement.

## Ownership and data flow

### Mod and module boundaries

| Owner | Responsibility |
| --- | --- |
| `assets/agents/console-groups.js` | Console-group projection and live console counts. It never hides sibling subagents or changes placement. |
| `assets/mods/spider/data.js`, `main.js`, and `sound.js` | Explicit notification cards, urgency, persisted occurrence dismissal, current-target activation, and intentional-only arrival sound. |
| host `notifications/store.ts` and `action.ts` | Validated intentional-notification events in the owning session history DB. Registered in parent and child hosts independently of Herdr activation. |
| host `herdr/data-source.ts` and feed parsers | Project stored requests into `SessionFeed.notifications`. Preserve intentional notices through the existing bounded feed publication and reading. |
| `assets/toast/filter.js`, setup, and doctor | Reject native automatic agent alerts on 0.1.16 only and install its derived toast file. Manage `sounds.enabled` in the existing settings-file projection alongside theme and layout. |
| `assets/agents/grouping.js` | Machine identity, ordering, known-machine headings, and live folded counts. No I/O or placement. `assets/agents/connections.js` owns refresh and explicit recovery, including copyable login guidance. |
| `assets/shared/navigation.js` | Name resolution, stable target identities, and generation-bound navigation actions from public terminals and feeds. |
| `assets/picker/model.js` | Space, tab, agent, run, and console rows, filtering, selection, and disabled-state projection. |
| `assets/picker/main.js` | Derived Picker View, input, scroll, hover, click, and asynchronous activation. |
| `spider-agents` patches | Existing sort popup and header renderer, machine dots, group folds, and unchanged child-row actions. |
| `spider-spaces` patches | Local-only ordered rows, shapes, header `+`, narrow sidebar, and local empty state. |
| `assets/pane/park.js` and `spider-pane` | Focused-terminal Send back. No action without focus, and quiet refusal of mod panes or payload terminals. |
| `src/spaces/open.ts` | Explicit reopening of an owned parked primary session. No new pi process. |
| `src/feed/ipc-server.ts` and host `herdr/mount.ts` | Authenticate an `openSession` request and call the primary-session opener. Existing child opens keep their owners. |
| host `herdr/ports.ts` and setup modules | Install picker config and helper files, merge keys, and inspect installed results. |
| `assets/look/patches.json` | Release-specific exact transformations and source digests, owned by the integration track. |
| `src/jobs/placement.ts`, `src/viewers/`, and `src/remote/console.ts` | Existing child-view placement and lifecycle. A does not replace them. |

### Read, project, activate

1. Read `spaces()`, `agents()`, `panes()`, and `terminals()` once per render. Read `machines()` for layout availability. Cache the read-only `hc machine ls --json` connection list outside render, initially and every 15 seconds. Obtain the local core identity through the existing read-only core-status parser, not a stored app-version field. If core identity cannot be read, native navigation still works but identity-dependent feed actions stay disabled.
2. Read session feeds through `createFeedReader`. Preserve its bounds, heartbeat handling, generation checks, and five-second refresh. Watch only the session feed directory. Close the reader when the overlay closes. On 0.1.16, retain each `FolderWatch` and call `watch.cancel?.()` before re-arm and on close, including the retained Agents feed lifecycle. Never allocate the next watch after close. Guard timers, feed reads, sound baselines, connection commands, and picker config reads with the release-aware `checking?.()` adapter before any side effect. Do not import missing 0.1.16-only exports on 0.1.13.
3. Resolve a session's name from a matching feed owner, then `spider.display-name`, then the native title fallback. Match owner identity and generation, never a name alone. Use the native fallback for non-spider agents.
4. Resolve machine identity from `spider.machine` for a recognised proxy, otherwise from the terminal's qualified address. For `spider.kind = roam-proxy`, use its qualified `spider.owner-terminal` when no machine label exists. The proxy is local but the agent it represents is remote. Ordinary local agents are This computer.
5. Build machine groups with a Map seeded with This computer and every known configured or discovered machine, including idle, temporary, and disconnected machines. Union in machine identities from agents, not just machines with agents. Interleaved agents from several spaces must produce one heading per machine. Order This computer first, then machine names lexically. Preserve existing pin order inside each machine rather than creating a second copy of pinned agents.
6. Build Go to rows independently of sidebar folds. Deduplicate by session identity, run identity within its session, and console identity within its owner. Hide proxy and viewer duplicates, not the real named session.
7. Keep the selected row by its stable ID when feeds change. When filtering removes it, select the first enabled match. When no enabled match exists, selection is null. Headers do not take selection. Arrows wrap only through enabled selectable rows.
8. Re-read the selected target before activation. Existing panes receive `pane.focus` with their explicit pane ID. Missing children use their existing authenticated `openRun` or `openJob` action. A lost reply does not trigger a second launch.

An unqualified feed owner is local only when its core identity matches the local terminal. A proxy's owner-core and owner-terminal labels are evidence of the remote owner, not a new session ID. Unmatched labels do not create a second agent row.

### Explicitly reopening a primary session

Parking a primary terminal removes it from native `agents()`, but its live feed and core terminal can still identify it. Include it in Go to and in the Agents sidebar until its terminal or session is proved closed. Draw one named parked-primary row, with a neutral Parked label, its machine pill, and its retained child tree. Its click and Enter resolve `session:<sessionId>` and call authenticated `openSession`. It is not an auxiliary viewer and must not duplicate a displayed native agent. Add `openSession` to the existing session IPC contract. The request carries the current generation and a destination snapshot `{ space, tab }` or null. It carries no supplied terminal address. The endpoint selects only its own verified terminal.

The opener first checks whether that terminal has a pane and focuses it. Otherwise it uses a free slot in the requested tab only when the tab exists on the terminal's machine and the resulting geometry meets the existing 60-column, eight-row rule. Count viewers, consoles, and observers against `limits.auxiliaryPanes`, two by default. Keep the reopened primary protected as a primary, not registered as an auxiliary reservation.

If no eligible slot exists, create a new tab in the last valid local space, or the active local space. For a native remote terminal in A, use that machine's existing native placement rules and focus the resulting remote pane. Do not create a proxy. If a native remote terminal has no eligible tab, first select a verified space on that terminal's own machine, then use `terminal.keep { terminal, place: "tab" }`. Never keep a remote terminal into the currently focused local tab. If no own-machine space exists, refuse explicitly. Fake-hc and native tests cover a local space initially focused. Revalidate the destination and terminal under the existing app focus and tab-placement locks, then acknowledge the observed pane. Never restart pi or replay its task.

Native primary reopening is not yet proved reliable on either release. The guide currently warns that Herdr cannot reliably give parked main sessions a pane again. Both binaries describe `terminal.park` as disabling core keep and expose `terminal.keep`, but command documentation is not evidence of reliable re-paning. Keep that warning until the blocking park-and-reopen acceptance story passes on both releases, with the same terminal address and pi PID before park and after sidebar click. A cannot ship parking on the strength of fake-hc alone.

Primary reopening is explicit and does not weaken `agent-pane-protected` in the auxiliary actor. Run and console activation still delegates to the current actor, including saved-view behaviour and owner-relative viewer placement.

## What appears on screen

### Spaces and Agents

Spaces has one header and a flat list of neutral outline shapes and names. There is no This computer heading, machine count, machine caret, remote-space placeholder, or New space there row. Remove worktree nesting from this list. Preserve manually stored local order, local drag reorder, rename, and the existing useful repository suffix. Do not run automatic `space.move` just to regroup worktrees. `localSpaceRows().index` is the native one-based global `SpaceInfo.index`, never the filtered array offset. Drag uses the source row's ID and the target row's global index for `space.move`. Test remote spaces interleaved with local ones. Own Cmd-N as `{"command":"space.new","args":{"machine":""}}` globally so interim remote focus cannot create a hidden space. Ctrl-1 through Ctrl-9 and `space.next` or `space.prev` still use all native spaces, including hidden remote spaces. This documented interim caveat is not local-only navigation.

The narrow sidebar keeps the shape buttons, expand button, settings button, and its existing restoration of intentionally hidden blocks. It also filters out remote spaces. An empty list says No spaces yet and keeps `+` usable.

Agents keeps its existing sort button. Its popup contains Priority, Grouped by space, and Grouped by machine in that order. Machine headings use a server glyph for remote machines, a monitor glyph for This computer, the existing fold caret, and the moved connection dot. Every known machine has a heading, even with no agents. The heading's tooltip names connected, disconnected, needs login, or unknown state. Its dot or small menu offers Reconnect and copyable login guidance. Reuse the shipped `refreshMachines`, `rebuilt`, and `reconnect` logic in the Agents connection manager, including guarded reconnect-state reads, busy and error states, and preserved machine target, via, session, and temporary fields. Reconnect runs only on an explicit click, never on refresh or render. The This computer heading does not offer remote remove-and-add. Preserve 0.1.16 login-copy behaviour and provide the same copyable guidance on 0.1.13 when hc supplies it. A failed refresh must dim the dot rather than keep an old green success indicator.

Machine groups include top-level agents on that machine. Children stay with their owner even when a console runs elsewhere. Such children retain their own neutral machine pill. A remote command does not duplicate its parent into another machine group. Folded agent, subagent, and console pills use the same live-only counting rules as space headings. Unreachable and retained finished children do not inflate live pills. Group keys use `machine:<identity>` and cannot collide with `sp-<space>` or agent fold keys.

### Folded agent consoles

Under every agent that owns consoles, show a Consoles row with the existing thread lines, a right-pointing caret, and a neutral consoles count pill. Subagents stay visible beside this group. A subagent with its own consoles gets its own Consoles group. A console never moves to its parent's group merely because it runs on the same machine.

The group starts folded each time the Agents View opens. Clicking its caret, label, or pill expands just that owner's console rows and turns the caret down. Clicking again folds them. The group control supports Enter and Space and exposes its expanded state. Clicking the control does not focus or launch a terminal. Selecting a revealed console retains the existing focus-first and open rules.

Keep two distinct controls. `expandedConsoleGroups` reveals console rows under an owner. The existing `expandedConsoles` reveals command rows under one console. Group expansion does not expand command history. Existing agent and subagent folds still work independently. Priority, Grouped by space, and Grouped by machine all use this same child projection.

The group key includes the qualified owner identity and immediate parent key, never its display name or machine. The count includes only live, reachable console rows, not their commands, subagents, or retained rows. If only unavailable or retained consoles remain, keep the group with a zero pill so they can still be inspected within the existing retention rules. A group with no console rows is absent. Refresh counts from the unfiltered children on every render. Go to uses the unfiltered projection, so a folded console remains searchable and selectable.

### Intentional notifications in the spider panel

Spider does not derive a notification card or toast from session status, a completed run or job, a budget update, or a pending memory. Native automatic toasts remain a documented 0.1.13 limitation. Remove the current `projectNotifications` synthesis of waiting, failed, and memory cards. Status remains in Agents and Sessions, failures remain in Problems, and approvals remain in Memories. Normal run-result delivery to the owning conversation is not a Herdr alert and stays unchanged.

The public tool request is:

```json
{ "action": "notify", "message": "Choose which failing check to fix first.", "urgency": "attention" }
```

`message` is required plain text, trimmed and secret-scrubbed at the host boundary, with 1 to 500 Unicode code points after scrubbing. Reject an empty or oversized result. `urgency` is `attention` by default, `urgent`, or `low`; reject other values. Attention uses a small amber mark, urgent a small red mark, and low a neutral mark. The action never posts a Herdr or OS toast, steals focus, or opens a panel. The active spider panel may sound a newly received intentional notice under the setting below. Agents use the verb only when a person must act, not to announce completion. Accept only the notify action, message, and urgency fields. Reject caller-supplied `cwd`, `scope`, `on`, `to`, `id`, owner, destination, address, or action command before resolving storage. Render the message as text, never executable markup.

Register the action in both parent and subagent hosts, outside Herdr's enabled or app-availability gate. A parent writes against its canonical session-history DB. A child uses the existing inherited `PI_SPIDER_DB_PATH`, `PI_SPIDER_SESSION_ID`, and `PI_SUBAGENT_RUN_ID`, verifying the run's ownership before writing. Its notification belongs to that owning session and records the run ID as its source. Reject missing or mismatched ownership instead of silently creating a child-only inbox. These are existing private host inputs, not tool parameters.

Use the existing `events` table, not a new inbox database. Append one `after` event with `tool = 'notify'` and a version-1 `agent-notification` payload containing `{ id, message, urgency, runId }`. The host chooses the timestamp and a stable ID from the owning session and tool-call ID. Repeated handling of that call returns the same occurrence without adding an event. A new tool call creates a new occurrence even when its text matches. Generic tool-history events do not qualify as notifications. Emit the existing after-commit bus event so a running feed publisher refreshes promptly. Across processes, the current data-source refresh reads the committed event even if no bus listener was present.

`herdr/data-source.ts` reads only the latest 64 qualifying occurrences within seven days, newest first with ID as the tie-breaker. Project them into the `SessionFeed.notifications` array the panel already reads. Add a discriminated `PanelNotification` variant `kind: 'intentional'` with `urgency`, nullable `runId`, and a focus-owner or open-run action. Owner addresses and capabilities come from the current feed owner, not the stored event. Retain the existing 64-notice, 64-KiB, and whole-feed bounds. Extend both the publisher's and reader's current job-result-only filters and the shared JSON parser to accept this variant, without reviving legacy automatic notices. No transcript or job journal is read by the panel.

On 0.1.16, the panel calls `setBadge(String(count))` for the undismissed attention and urgent count across its feeds, even when hidden, and `setBadge(null)` at zero. Low notices do not count. Refresh on arrival, dismissal, retention expiry, and feed return without stealing focus. Badge updates are separate from visibility-gated sound and share one app-wide count across panel instances. The 0.1.13 adapter does not import or call this absent API.

The panel's existing bell count reflects undismissed explicit occurrences across the feeds it reads, regardless of selected space. Sessions stay space-scoped, but the intentional inbox is global to this app so requests from another space are not missed. Its existing list shows the source session name, the subagent name when applicable, the supplied message, and the urgency mark. Resolve a child name from the current run summary; if retention removed it, use Run plus the short run ID rather than inventing a name. Order urgent, attention, then low, and newest first within each urgency. No coloured card background, new border, outline, or shadow is added. An empty list has no waiting, failed, or memory fallback card.

Reuse the separate dismiss control and Herdr shared key `spider.dismissed/<modId>`. Dismiss only the immutable occurrence token `intentional:<sessionId>:<id>`. Persist it across View reloads and status changes. Keep tokens until the occurrence leaves retention, not merely until a temporarily missing feed returns. The existing 512-token cap applies. Dismiss never focuses a pane or deletes the audit event. Clicking a card does not dismiss it; the person clears it with Dismiss.

Resolve the target afresh on every card click or Enter. Parent notices use the same `session:<sessionId>` target as Go to. Child notices use `run:<sessionId>:<runId>`. Delegate focus, parked-primary reopening, and run-view opening to the shared navigation and authenticated IPC rules. Recheck identity, machine availability, generation, and capability immediately before dispatch. Show Owner unavailable if the target is gone, and Run /reload to enable session reopening for an old owner endpoint. Keep the card dismissible. Never follow a reused terminal address or run a command from the message. Do not retry a dispatch with an uncertain reply.

Without Herdr, `notify` still commits to the session-history DB and returns `{ ok: true, id, presentation: 'stored' }`. With an active feed publisher it returns `presentation: 'panel-feed'`, meaning publication is queued, not that a person saw it. A DB failure returns an error and no success claim. A missing app never triggers an app launch, sound, OS alert, or automatic replacement toast. If the app or integration returns within retention, the next feed snapshot includes the stored occurrences. Closed or disconnected owners can leave readable, dismissible cards; activation remains disabled until a valid target is available.

### Intentional-only sound

Recorded design choice: intentional notifications have sound on by default, unlike native automatic alerts. Add the spider setting `herdr.notifications.sound: boolean`, default `true`, with an explicit false to turn it off. Validate it in `parseHerdrConfig` and copy it into installed panel props as `notifications: { sound: true }` when absent. This setting is independent of Herdr's native `sounds.enabled` and applies to all intentional urgencies. After changing the setting, refresh installed panel props through setup or the maintainer sync. Mod hot reload applies the preference without replaying already observed notices.

On a newly received intentional occurrence, the active panel calls Herdr's explicit mod API `playSound("blocked")` for attention or urgent, or `playSound("done")` for low urgency. Use the configured native sound files if present. Do not temporarily enable `sounds.enabled`. The shipped Alerts View calls `playSound` directly for its Play buttons even when automatic sounds are disabled; the isolated-app sound check must verify this same path with `sounds.enabled: false`.

Share observed occurrence tokens in `spider.notifications.sounded` within the app home so duplicate panel instances and refreshes cannot sound the same arrival twice. Claim a token synchronously before calling `playSound`, with no await between shared read, write, and playback. Only a panel shown in the current layout plays sound; hidden nodes and inactive stack children do not observe arrivals. Window focus is not required. Its initial read establishes a baseline and never plays a backlog. Later reads sound only new occurrences created after that baseline, once per occurrence in notification order. Keep observed tokens until the occurrence's seven-day retention expires. Prune by expiry, not by a temporarily missing feed, so a returning feed cannot sound the same notice again. The per-mount baseline prevents historical notices replaying after View reload or app restart.

While sound is disabled, record arrivals as observed without calling `playSound`, so re-enabling sound does not replay them. Missing app, hidden panels, malformed feeds, automatic statuses, legacy notices, and initial stored history cause no sound. Requests stored while the app is absent appear silently on its initial read, not as an audible backlog. A playback failure leaves the notification card intact, reports a panel Problem, and does not retry the sound on the next refresh. Card dismissal and focus never play sound. Verify both sound names through the mod API with automatic sounds disabled, and verify the default-on and explicit-off spider settings.

### Native automatic alerts and sound

The shipped Settings > Alerts View in both releases says, "A note shows in the corner either way." `settings.json` has `sounds.enabled`, but no evidenced setting that disables native automatic agent toasts. Set only `sounds.enabled` to `false`, preserving custom `done` and `blocked` paths and all unrelated settings. Keep spider's existing `hc run --no-notify` launches and doctor checks. That launch flag does not cover agents started by hand.

On 0.1.13, turn off only automatic sound. Leave the stock toast mod untouched. Native automatic agent toasts remain visible for manually started agents. There is no stock-mod edit or restart reapply step.

On 0.1.16, install one derived `assets/toast/main.js` as `spider-toast` and set the cloned layout root's `toast` field to `spider-toast`. `automaticAgentAlert(p)` requires both `p.action?.name === 'agent.focus'` and a title ending in ` finished` or ` needs you`. In both `init` and `render`, close that overlay without running its action and render no content. Preserve unrelated failures, connection and login guidance, and the release's login-copy control. Unknown mod names fall back to shipped toast, so doctor verifies the selector and installed digest, not just the directory. Filtered notices do not become panel cards.

### Go to

The title is Go to. The placeholder is Go to a space, tab, or agent. All local spaces and tabs are visible without an earlier fold. A space row selects that space and its current tab. A tab row selects the tab. Session rows use spider's session name and status, never a concatenation such as Pi · Pi · Pi. Children are indented under the owner with outline kind icons.

A session's remote machine is a neutral pill. A console row reads `<owner name> console`, with its machine pill, even though its sidebar row currently uses the machine as its name. Searches match names, owner names, space and tab names, paths, statuses, and machine names case-insensitively. When a child alone matches, show its owner ancestors for context. A matched owner shows its children. Display every identity once.

Use JetBrains Mono for paths, agent names, and machine names. Use Google Sans Flex for labels and medium-weight headings. The panel has a 12-pixel radius and neutral `#161618` glass at 94 percent opacity. Use existing white hover and selected fills at seven and eight percent. The input has the existing neutral input fill. No coloured letter badges, new border, outline, or shadow. Space glyphs come from `assignSpaceIdentities` and the existing outline SVGs. Colour marks blocked and error states in amber and red. Working and done remain neutral.

Herdr 0.1.13 has no evidenced desktop backdrop-blur option. A uses the existing alpha treatment over the window ground. The staged 0.1.16 bundle documents root `window_blur: true`, with transparent `background` and `canvas` plus translucent chrome. The separate final 0.1.16 task may use it for sidebar and panel glass after checking readability. Keep neutral black surfaces and the pinned alpha where text sits; do not copy the upstream example's tinted colour. Unsupported systems retain the alpha-only look. `DESIGN.md` and `PRODUCT.md` describe the usage web page, including different fonts and brown backgrounds. Their readability and concise-copy rules apply, but the Herdr decisions and [Herdr look](../../guide/herdr.md#the-look) determine this picker.

Arrows, Enter, Escape, typing, mouse hover, and click work in the same overlay. Hover changes the selected enabled row. Enter and click use the same activation function. Keep the list at a maximum of 320 pixels, with selection-following scroll. Escape and closing the overlay dispose resources. Keep Ctrl-D tab close for the selected existing tab, as today. Keep local New tab and New space rows with explicit `machine: ""`, even after remote-agent focus. New tab uses a verified local space. Remove only remote space-creation rows and earlier folding. Test Ctrl-D, both local creation rows, and disabled or non-tab selection.

## Labels and state

Keep `spider.session`, `spider.owner-core`, `spider.owner-terminal`, `spider.kind`, `spider.run`, `spider.machine`, `spider.display-name`, `herdr.space`, and `herdr.tab`. A adds no terminal label schema and no placement database. Keep the last observed space in the open View's memory for explicit parked-session fallback, not in a new durable state file. Read `roam-proxy` labels, but do not rewrite them or `roam-placement.json`.

The durable sort choice remains in Herdr's shared storage as `agents.sort`. Machine and console-group folds are View-local, like current agent and space-group folds. `expandedConsoleGroups` starts empty and never replaces the per-console command fold set. Intentional notification history stays in the owning session DB's existing `events` table. Notification dismissal stays in Herdr shared storage. Do not migrate Spaces machine folds into Agents. Preserve the shipped reconnect recovery journal for the moved connection manager, with guarded parsing. Do not delete unrelated stored values. Neither value is read by the new Spaces renderer.

Write a versioned, private `mods/spider-picker/config.json` under the configured app home. It contains the validated `InstalledModProps`, fonts, configured machines, and retention limits. The picker needs this file because `mod.open` from a key does not inherit layout props. Read it with `appHome()` and `readTextFile`, not a fixed home path. A layout-provided picker can use validated props instead. Missing or invalid config must not suppress native spaces and tabs.

Cmd-Shift-E uses the documented `<mod>.<command>` key form, `spider-pane.park`, which delivers `park` through `nextCommand`. Extend the existing header command loop, retaining its `close` handling. Only the focused header handles the park command, so visible header copies cannot park the terminal more than once. Read `focused()` and the current terminal labels at dispatch. With no focused terminal, do nothing. A focused mod pane or a terminal with `spider.kind` equal to `exec`, `exec-file`, or `batch` is refused quietly, without a toast, IPC, kill, or park call. Otherwise call `run("terminal.park", { terminal: focusedTerminalAddress })` once. If the target cannot be classified from the current snapshot, leave it alone.

Extend key ownership with section-aware `keys` beside the existing `terminalKeys` journal field. Backward-read existing journals. Own Cmd-P and object-valued Cmd-N in `global`, and Cmd-Shift-E only in `layout:spider-glass`. Other layouts without `spider-pane` must not receive this binding. Inspect Cmd-Shift-W without taking ownership. Stock `mod.open:picker` is an allowed Cmd-P migration baseline. Refuse other conflicting bindings without `--overwrite-unowned-keys`. An existing conflicting pane-close key requires repair rather than silent overwrite. Rollback restores only the owned fields when they still match.

## Release-specific patches

### Complete ordered recipes without widening the engine gate

Keep the existing `upstreamVersion`, base five-mod `mods`, and 0.1.12 hashes unchanged. Add `spacesA['0.1.13']` and `spacesA['0.1.16']` as complete installation recipes, not A-only deltas. Each contains source hashes, retained per-version overrides, superseded IDs, an ordered mod-to-patches map, and derived-file provenance and artifact digests. A patch includes its target `file`. The production gate remains unchanged.

Build each recipe in this order:

1. Start from that release's verified, unmodified shipped files. Copy the base retained list in its existing per-mod order and select the release variants below.
2. Remove the superseded retained patches by ID before execution. Reject an unknown removal ID. Do not apply them and silently overwrite their behaviour later.
3. Execute the surviving retained patches, then A's patches in the table order within each mod. A anchors refer to the bytes at that position, including earlier markers. Do not mix shipped anchors with a 0.1.12 clone or with a different retained output.
4. Copy the single derived picker artifact on both releases, and the single derived toast artifact only on 0.1.16. Keep upstream hashes as provenance, not duplicate full-class replacements. Picker's manifest preserves popup top, width 640, and height 0.8, with frame `none`.

The retained variants are owned by A, not the separate final compatibility task:

| Mod and retained ID | 0.1.13 repair | 0.1.16 repair |
| --- | --- | --- |
| Agents `agent-row-name` | Anchor the current `const label = (a) => labels.get(a.address);`, retaining the surrounding labels map. A names then replaces the complete post-retained naming block. | Same line anchor, preserving this release's `tabCounts`, tabs Map, and native title logic. |
| Agents `child-action` | Retain current variant. | Anchor the focus-first listed-child handler, not direct `peek`. Keep native focus-first and authenticated spider opens. |
| Agents `feed-lifecycle`, `feed-and-actions` | Keep an owned watch reference, test closed state before re-arm, and optionally cancel before re-arm and on close. | Same lifecycle, with `FolderWatch.cancel()` actually available. |
| Spaces `rail-pending-filter` | Anchor `return out.filter(r => this.shown.has(r.w.id));` after `rail-include-pending`. | Same current line. |
| Spaces `rail-scrollbar-import` | Retain current variant. | Preserve `ScrollHandle` in the import. |
| Spaces `mono-space-name` | Retain current variant. | Preserve `flex_initial()` and `min_w(SIDE_MIN)` while adding the mono font. |
| Pane `style-1`, `style-4` | Retain current variants. | Anchor the conditional top and bottom borders and the import including `layout`. Remove borders without losing bottom-header placement. |
| Workspace chrome `footer-settings-only` | Retain current variant. | Anchor the updated ready-dot and Add machine tail. Preserve Settings. |

Remove these retained IDs on both releases. A replaces their regions and must explicitly preserve useful behaviour in its View tests:

| Mod | Superseded retained IDs | Replacement responsibility |
| --- | --- | --- |
| Agents | `space-heading-icon`, `group-folded-pills`, `group-heading-padding`, `group-heading-counts` | `a-agents-heading` keeps the existing space glyph, folded live pills, padding, counts, and tree lines, adding machine headings and recovery. |
| Spaces | `rail-space-button`, `workspace-empty-state`, `spaces-scrollbar`, `space-badge`, `space-identity`, `mono-machine-name`, `machine-space-thread-row`, `machine-space-thread`, `machine-fold-caret`, `machine-space-count`, `empty-machine-group-begin`, `empty-machine-group-end`, `thread-machine-heading`, `thread-new-space-row`, `thread-loading-row` | A's compact, render, row, and flat-list replacements own shapes, empty state, scrolling, and local-only rows. Remove machine UI, but move recovery into Agents. |

Keep `rail-render` and its narrow-sidebar restoration, `filter-replay`, `combined-tree`, the move menu, close confirmation, and `copy-sort-popup`. A whole-body replacement must carry forward their relevant code. Never replace the entire Agents `render()` body and discard its retained patches.

Fresh-source replay checks each retained and A anchor exactly once. Repeated replay first verifies the recorded final per-file digest, marker inventory, and exact final A replacement regions, then returns those bytes unchanged. Do not rerun consumed retained anchors against final output. A whole-body patch can extend a retained producer region, so its intermediate replacement is not the repeat baseline. Any edited output or unexpected marker fails final-artifact validation. The separate recipe helper implements this check without changing the current production gate.

### A anchors in their ordered recipe positions

The source column identifies the actual anchor input. Counts are 0.1.13 and 0.1.16 respectively. Complete body anchors include preceding retained edits within that body.

| Patch ID | Source | Exact region at application | Release difference | Counts |
| --- | --- | --- | --- | --- |
| `a-agents-imports` | Post-retained | Complete contiguous import block | Preserve retained helpers and release-aware APIs. | 1 / 1 |
| `a-agents-sorts` | Shipped | Complete `SORTS` declaration | Identical. Append machine after grouped. | 1 / 1 |
| `a-agents-init` | Post-retained | Complete `init(_props, cx)` body | Preserve move-menu and feed lifecycle, add checking guard, cancel owned watches, connection manager, and sort commands. | 1 / 1 |
| `a-agents-list` | Post-retained | `let list = filterTopLevelAgents(agents(), terminals(), spiderProps().labelContract);` | Keep the native list typed and project parked-primary targets separately, merging them into sidebar groups without replay duplicates. | 1 / 1 |
| `a-agents-names` | Post-retained | From `const leads = leadPanes(panes());` through the labels and repaired label block, before `const detail` | Two complete naming variants preserve native title fixes. | 1 / 1 |
| `a-agents-groups` | Post-retained | Complete groups block before `const header` | Seed every known machine, retain pin uniqueness and existing sorts. | 1 / 1 |
| `a-agents-heading` | Post-retained | Complete header block before `const rows` | Rebuild superseded space-heading behaviour and machine recovery controls. | 1 / 1 |
| `a-agents-child-open` | Post-retained | Complete retained `child-action` replacement | Preserve 0.1.16 native focus-first. | 1 / 1 |
| `a-agents-console-groups-tree` | Post-retained | Complete retained `tree()` body | Preserve retention and finished toggles. Apply console-group filtering only in sidebar. | 1 / 1 |
| `a-agents-console-groups-rows` | Post-retained | Complete `return [r, ...subs.map(...), ...this.finishedToggle(t, a.address, groupLine)];` | Add Consoles controls and retain the group line. | 1 / 1 |
| `a-spaces-imports` | Post-retained | Complete contiguous import block | 0.1.16 preserves `ScrollHandle`; retain shape and scrollbar helpers. | 1 / 1 |
| `a-spaces-init` | Shipped | Complete `init(_props, cx)` body | Two variants preserve local watch and scroll ownership, removing machine state and timer. | 1 / 1 |
| `a-spaces-due` | Shipped | Complete `due(now, sp, ps)` body | Two variants retain local cache and watch cleanup. | 1 / 1 |
| `a-spaces-reconnect` | Shipped | Complete `refreshMachines`, `rebuilt`, and `reconnect` block | Remove from Spaces after moving to Agents, not from the product. | 1 / 1 |
| `a-spaces-order` | Post-retained | Complete `ordered(includePending = false)` body with repaired return | Stored local rows and global native indices, no automatic writes. | 1 / 1 |
| `a-spaces-flat` | Shipped | Complete `grouped(t, collapsed)` body | Two body variants replace machine renderer with the local list and empty state. | 1 / 1 |
| `a-spaces-row-identity` | Shipped | Contiguous `colors`, `color`, and `fill` declarations in `row()` | Identical after removing `space-identity`. | 1 / 1 |
| `a-spaces-avatar` | Shipped | Complete branch and letter-avatar expression, ending before the retained mono-name marker | 0.1.16 branch SVG adds `flex_none()`. Two anchors. | 1 / 1 |
| `a-spaces-compact` | Shipped | Complete `compact()` body | Two variants preserve 0.1.16 rail cells and status placement. | 1 / 1 |
| `a-spaces-render` | Post-retained | Complete `render()` body including `rail-render` | Two variants keep restoration and active local-space scrolling. Own header local `+` and global-index drag. | 1 / 1 |
| `a-pane-imports` | Post-retained | Complete contiguous import block | Keep close helper and 0.1.16 `layout`, add park helper. | 1 / 1 |
| `a-pane-park` | Post-retained | Complete retained line beginning `if (command === "close" && p?.focused)` | Extend that command loop with focused-only park, keeping close confirmation. | 1 / 1 |

The fix-round script freshly extracted both binaries and replayed the current 118 retained patches before selecting the complete proposed ordering. It found two zero-match IDs on 0.1.13 and 17 on 0.1.16. After the variants and 19 removals, 99 retained patches and all 22 A anchor probes matched once on each release. Picker provenance matched once on both, toast provenance once on 0.1.16. Removed and duplicate anchor controls failed. These are structural anchor-probe counts, not final View implementation or native certification. Task 4.1 must replace probes with actual fragment payloads, replay the complete lists from clean fixtures, and prove retained behaviour and byte-identical repeat application.

All 0.1.13 retained repairs and all 0.1.16 failures belong to A's Task 4.1 split. The separate final task only selects these already complete recipes in production and widens the gate. A's 0.1.13 maintainer sync does not depend on that final task.

### Bundle recheck for 0.1.16

The installed bundle identifies as 0.1.13 and the staged bundle as 0.1.16. Complete parsed method and import anchors were compared against both bundles, not a previously staged release. Spaces imports, `init`, `due`, `grouped`, `compact`, and `render` need variants. Shipped Agents `SORTS`, pane `init`, Spaces `ordered`, and picker imports match exactly. The recipe anchors for pane and Spaces order are nevertheless post-retained, not those shipped bodies. The 0.1.16 Agents View also guards stored state and improves title cleanup. Its Tabs View gains live-title labels. These fixes must survive recipe composition.

The extracted shipped `main.js` SHA-256 values are:

| Mod | 0.1.13 | 0.1.16 |
| --- | --- | --- |
| agents | `27d9dd06fea9562f62f0924922aafcadd64623391cb1ada4d47d754e91b0f44b` | `3ef714bbf187f81c4fbb91949f4fa2b92f0dceda2c52c9bc01eabec5f3d7e0c4` |
| spaces | `1e949e399644aeb0e88c73a0dbefe651f3a80dc092cd2d99b3244c2d8b036db0` | `8f7111eb3a7c055bb04bd81b88f90b581e4d4a85f512eb87d3f5d15f1073f8bd` |
| picker | `6dfde109b9321e8bc7f0e081db964960195748915eb7ff73e75688dd853b6dc3` | `d016a63eb7263ad4478152caa6521b218501bcc3539b7c42e13cfca1806b05c2` |
| pane | `30df4c9b774414ca184b16f76c97c84f3cebd2ee411bea45c5c25b9d0ac65899` | `9bb9028df04281ad886165ec0eb9fc0a8ac6efadf39abc4d6aa0afd1370879c7` |
| toast | `7871cd62c333ed18fd99a3a3af21c09f3d83e4cb0d7538a80d1257bee8c9e5c9` | `6722e17c44e9e1af7f50f2862c4ed71660ff1c0c340a5eebb475dd66c70291dd` |

Track 4 supplies full asset hashes; a changed-anchor negative control was rejected. This is source evidence, not native certification.

### Other shipped differences and A-owned repairs

| Mod or API | Observed 0.1.16 difference from 0.1.13 | Treatment |
| --- | --- | --- |
| Agents | Path-aware titles, bracket and quote preservation, blinking status-mark cleanup, guarded stored changed-state and pin parsing, removal of held-Done ranking, nested-agent deduplication, and per-agent shared-tab titles | Preserve upstream fixes. The old `agent-row-name` patch anchor matches neither release and needs two replacement variants. |
| Spaces | Ref-only git reads, bounded six-place refresh with `Promise.allSettled`, watch ownership and cache cleanup, login guidance, active-space scrolling, rail layout, and minimum name widths | Preserve local ref-only reads, bounded refresh, watch cleanup, name readability, and active-space scrolling in 0.1.16. Remove only machine UI and worktree nesting. Existing `rail-pending-filter` matches neither release. Old rail, empty-state, and machine-thread anchors need replacement or deletion. |
| Pane | Header can be at the bottom of its frame | A only extends the header command loop and imports for park. Preserve the bottom-header fix. The old pane-look `style-1` and `style-4` anchors need 0.1.16 variants in A's Task 4.1.4. |
| Tabs | `ScrollHandle`, active-tab scrolling, live agent-title labels that preserve manual names, title cleanup, and tab-container changes | Preserve them. Existing ordered tab patches matched both in the source replay. A only keeps the existing new-menu and tab behaviour. |
| Menu | Split, zoom, and close are omitted for terminals outside a model tab | Preserve this guard. Send back still calls native `terminal.park`. A does not replace menu items. |
| New menu | Failed installed-agent checks show an explicit error row and suppress misleading not-installed choices | Preserve it. Machine picking in this mod belongs to B. |
| Toast | Login guidance and a copy control; root layout `toast` selector is documented only in 0.1.16 | Preserve allowed-notice rendering. Leave stock toast untouched on 0.1.13. Use the single derived `spider-toast` file on 0.1.16. Sound is independently disabled. |
| Workspace chrome | Footer no longer uses the old settings-only anchor | The existing `footer-settings-only` patch needs a 0.1.16 variant in A's Task 4.1.4. |
| `watchFolder` | Returns a cancellable `FolderWatch`. At most 64 distinct folders await changes at once. Idle watches can be reclaimed. | Keep the handle, cancel before re-arm and on close, and never re-arm after close. Test repeated picker opens and retained Agents feed lifecycle leave no pending watches. |
| `checking()` | Exists only on 0.1.16; `herdr-app check` runs `init()` for real. | Guard new init side effects through a release-aware optional adapter. No timers, hc, feed or config reads, badge updates, or sound baselines during checks. |
| `terminals().parent` | Uses machine-qualified names for mapped remote parents and bare IDs for local parents. Unmapped parents retain the core value. | Test 0.1.16 remote subagent ancestry against `children.js`, local ancestry, and unmapped parents without guessing machine identity. |
| `setBadge` and default keys | Adds `setBadge(string or null)`, terminal Cmd-A select all, and global Cmd-M minimize. Cmd-F search is present on both releases. | Badge counts undismissed attention and urgent occurrences while hidden. The final production key merge offers the three defaults without replacing user edits. |

The comparison is source-only. It does not certify a native window or the unchanged production version gate. Fixtures must include the unmodified shipped files and Herdr's NOTICE, following `fixtures/herdr-0.1.12/`. Never publish installed private clone props, configuration, or session content.

## Errors and unavailable states

| Condition | Visible result and action |
| --- | --- |
| Remote machine disconnected, unreachable, or needs login | Dim heading dot and tooltip. Keep agent and child rows searchable. Disable opening targets whose machine cannot be reached. Only explicit heading Reconnect may run the preserved recovery sequence. No automatic recovery or local placement fallback. |
| Connection snapshot failed | Keep names but show unknown connection state with a dim dot. Native local navigation still works. |
| Feed absent, malformed, stale, or over bounds | Native spaces, tabs, and agents still work. Show Session details unavailable. Do not fabricate session names, statuses, children, or capabilities. |
| Picker config absent | Native-only navigation and Run setup and doctor guidance. Do not run a CLI from an unvalidated path. |
| Endpoint changed during filtering or activation | Refresh rows and show Owning session unavailable. Do not retry a request with its old capability or start a duplicate viewer. |
| Owner serves the old IPC contract | Existing focus and child opens keep working. `openSession` reports Run /reload to enable session reopening. Do not restart pi or fall back to a duplicate launch. |
| Child has no pane | Use its current open action. A finished run can open its saved read-only viewer if the existing owner permits it. |
| App absent or integration disabled during `notify` | Commit the occurrence and return stored presentation. Do not launch Herdr or use sound or a replacement toast. Later feed snapshots read stored occurrences within retention. |
| Notification source closed, disconnected, or generation changed | Keep the explicit card readable and dismissible. Disable stale activation or resolve a fresh target, never a reused address. |
| 0.1.13 native automatic agent toast | Expected release limitation. Sound is off, but stock toast is untouched. Doctor reports sound-only suppression, not a full quiet-policy pass. |
| App absent | Backend placement reports `missing-app` or `app-disconnected`. Jobs keep running. A never launches the app to repair navigation. |
| Core stops | Clear enabled stale targets and keep native error reporting. Host integration follows its current inactive and reload guidance. A does not promise automatic core recovery. |
| Same core returns | Refresh connection and terminal snapshots. Rebind feed actions only after the owner publishes the current generation. |
| Different core replaces an owner | Invalidate terminal identity and endpoint. Follow existing retired-pane guidance. Never select a reused address by name alone. |
| Park command pending or fails | Do not claim the pane is parked on `{ pending: true }`. Observe pane removal and a still-live core terminal. On failure retain the pane and native error. |
| Unknown patch source or modified clone | Refuse a compare-write. Keep the installed mod and show the mismatched source or artifact in doctor. |

## Testing and rollout

### Automated evidence

Unit tests cover owner-specific default-folded console groups with unaffected subagents and Go to search, explicit parent and child notification persistence, no automatic cards, immutable dismissal through missing-feed refreshes, fresh-target activation, absent-app storage, urgency and message validation, 0.1.16 native toast filtering, 0.1.13 stock-toast immutability, badge count updates while hidden, and combined settings ownership. They also cover flat local projection, nonadjacent machine grouping including idle machines and explicit Reconnect and login-copy actions, proxy machine identity, pin uniqueness, folded live counts, session naming, child context on search, retained runs, empty filtering, selection stability, and action deduplication. Use the existing strict mod API and render host for the actual patched Views.

Look-patch tests replay every A recipe against unmodified 0.1.13 and 0.1.16 fixtures, count each anchor exactly once, verify markers and imports, repeat byte-identically, and reject edited sources. Run the existing 0.1.12 tests unchanged. This proves transformations without widening the engine gate.

Fake-hc tests exercise `openRun`, console `openJob`, explicit parked-primary reopening, generation refusal, focus-first priority, full auxiliary slots, the 60-by-eight geometry boundary, remote reopen after selecting its own-machine space, pending park, core loss, and no duplicate process launch. Park-handler tests cover ordinary focus, absent focus, a focused mod pane, and every payload kind, with quiet refusal and no duplicate dispatch. Include the remote native focus exception and existing roaming-proxy focus.

Isolated-app stories use the app command interface, not synthetic input. Open the picker with `mod.open`, set the sort through `spider-agents.sort-machine`, and dispatch `herdr-app do spider-pane.park` for an explicitly owned focused fixture terminal, then click its parked-primary sidebar row through the production activation command and reopen through `openSession`. Inspect `ls` and `status`, then capture only the isolated app window with the existing `shot` facility. Check the actual screenshots against the sidebar and picker requirements, folded and expanded Consoles controls, and an intentional-notification card. On 0.1.16, confirm native finished and needs-you alerts have no visible toast while unrelated failures and login guidance still render. On 0.1.13, expect the stock automatic toast and verify sound is off and stock bytes unchanged. Check `sounds.enabled` in the isolated settings and prove automatic alerts make no sound call in the render host. A new intentional attention or urgent notice calls `playSound("blocked")` once, a low-urgency notice calls `playSound("done")`, and the spider sound setting disables both. Verify explicit native playback in the isolated app while `sounds.enabled` remains false. A headless render is not native proof.

For both versions, parse the isolated `keys.json` and compare the command portion of each managed binding with the native `commands()` list. `mod.open:spider-picker` must resolve to `mod.open` plus the installed mod. For `spider-pane.park`, exercise the actual dotted mod-command dispatch in the isolated app, not just command existence or a fake header loop. After writing keys, require `status().errors` to be empty. The binding exists only in `layout:spider-glass`. Both `terminal.park` and `pane.close` must exist. The command lists on both releases require an explicit terminal argument for `terminal.park`. Mod-private commands are verified through their installed command loops because `commands()` does not list them.

Real hover, click, and physical Cmd-key translation remain a maintainer check after live sync. No native input adapter is assumed. Command-driven screenshot evidence can prove the look tonight without one.

### Delivery

1. Integrate the four tracks by explicit commit cherry-pick. One writer owns `patches.json` and fixture inventories. Run the complete focused tests and existing gate on the integrated branch.
2. Build and inspect the actual packed assets. APFS-clone each app bundle to a ledger-owned temporary path and run only that copy, never the staged original. Set `HERDR_RELEASES_URL` to an unreachable loopback URL, `HERDR_TELEMETRY=0`, and a distinct `HERDR_APP_ID`. Pin isolated settings `core` to a copied core binary and use a non-default core namespace. Launch with `open -g -n --env ...`, passing the isolated environment explicitly through Launch Services. Record frontmost app identity before and after and require it to be unchanged. Never touch the live launcher or pending update. Use synthetic sessions and machines such as `box-1.invalid` and `box-2.invalid`.
3. Run the command-driven native stories on each release. Capture window-only screenshots and retain separate pass or failure evidence for 0.1.13 and 0.1.16.
4. The maintainer backs up the affected live clone files, picker and 0.1.16 spider-toast directories, manifests, `keys.json`, and `settings.json`, then compare-writes only verified assets, owned key fields, and `sounds.enabled`. Keep current spaces, pi processes, core, and app running. Do not run setup's initial cutover or select another space during the sync.
5. Doctor checks installed picker helpers and config, keys and bound native commands, toast-filter bytes and selector where supported, `sounds.enabled === false`, marker and digest consistency, and feed readability without changing anything. Report the existing engine version refusal separately. It is not proof that A's synced files are wrong or a reason to widen the gate inside A.
6. After deploying the host change, ask people to run `/reload` in sessions that need the new parked-primary opener. Never send the command into their terminals. The maintainer checks hover, click, filtering, independent console-group folds, parent and subagent intentional cards, dismissal, the version-specific native alert policy, remote native focus, and Send back in the live app. Keep the parked-main-session warning until both releases pass the native park-and-reopen gate. On 0.1.13, report the visible stock-toast limitation. B then removes the remote-native-space selection exception. The separate final compatibility task must pass before installing the 0.1.16 update.

## Coverage check

All six A decisions have design sections, owners, and TDD coverage. Console-group folds do not hide subagents or picker input. Only explicit requests populate the panel list; automatic statuses and memory approvals remain in their existing views. Notification storage, child ownership, retention, dismissal, current-target activation, absent-app behaviour, and default-on intentional-only sound are defined. The 0.1.13 sound-only limitation is explicit. Native park-and-reopen remains a blocking acceptance gate until evidence supports changing the guide. Anchors and blur evidence were rechecked against 0.1.16. B still owns new proxies and cross-machine lifecycle. The production gate remains a separate final task, and no A step assumes synthetic OS input or edits live state during development.

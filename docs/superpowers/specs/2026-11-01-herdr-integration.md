# Herdr integration

## Purpose and scope

Herdr gives each pi session a tab in its configured space. Remote commands and subagent views appear under the session that owns them. The window shows spider's work without changing a draft in the pi editor.

All twelve capabilities ship together. The integration adds status contributions, job notices, agent guidance, reboot resume, spaces setup, role templates, visible remote execution, subagent views, two panels, a shared look, and shortcuts. It does not make subagents interactive terminals or run subagents on remote machines. It does not add helper sessions or change another extension's project-pane behavior.

The supported baseline is Node.js 22.19.0, pi 1.2.0, hc 0.1.16, and herdr-app 0.1.11. The package engine remains >=22.19.0. CI runs both Node 22.19.0 and 26.x. Each destination also needs Node >=22.19.0. Its machine configuration can supply an absolute nodePath, with node from the destination PATH as the fallback. The first acceptance platforms are macOS and Linux, including a Linux destination reached from macOS. A native Windows environment must pass its environment and transport checks before enforcement is enabled there. An unsupported platform produces a doctor failure, not an invisible remote fallback.

No npm dependency is added. The code uses Node built-ins and existing repository packages. All names of sessions, machines, aliases, folders, and machine locks come from a user-owned configuration file outside the repository. Public artifacts contain no private inventories or proprietary material.

## Package and process boundaries

`packages/herdr` owns the generic integration. Its source contains the hc and app clients, status adapter, feed protocol, IPC server and client, remote runtime, job monitor, viewer program, session map, spaces setup, template generator, installer, and doctor. Its assets contain spider's mods, exact-match patches for cloned Herdr mods, layout edits, themes, a keys fragment, and fonts.

`packages/host` supplies pi lifecycle and database adapters. It resolves the exact owning run database with `openSessionRunDb`, including session bindings. `packages/context` retains language preparation and model-facing output shaping. `packages/subagents` retains process ownership, run events, transcript capture, and message delivery. These packages do not import the host from below.

The extension bundle contains registration functions, not panel renderers. A panel runs in Herdr's gpui-kit process. A viewer runs as a separate Node program in a local hc terminal. A remote runtime runs on the destination machine. The job monitor runs in the owning pi process. Every session_start, including startup, resume, and reload, reconciles its journal, remote receipts, and finished events before delivering missed notices once. With pi closed, destination logs continue to grow, but local collection and notices wait for the next activation. Setup runs independently from a plain shell.

The published package includes dist/herdr/cli.mjs, viewer.mjs, and remote-runtime.mjs. These are explicit build entries, not accidental extension chunks. The remote runtime is built-in-only and never imports pi, SQLite, or the context package. Packaging checks account for these files while retaining one dist/extension.js. There is no external monitor or metrics runtime entry.

Original integration code carries `SPDX-License-Identifier: MIT` and the same copyright as the root MIT licence. `packages/herdr/LICENSE` contains MIT and the font licence references. The new package metadata uses `MIT AND OFL-1.1`. The root package expression becomes `MIT AND Elastic-2.0 AND OFL-1.1`. The two bundled fonts retain their OFL 1.1 notices and trademark file. `NOTICE.md`, the root licence description, and package metadata distinguish MIT code, OFL fonts, and the existing ELv2 context code. Language-preparation changes stay in `packages/context` under ELv2. The installer clones Herdr's current built-ins and preserves their metadata and notices. The package never redistributes frozen copies of those built-ins.

## Core types and ownership

The canonical types, every label key, and every spider.kind value live in packages/herdr/src/contracts.ts. Setup serializes the exported label contract into consuming mods' validated props. JS mods use those values instead of defining another set of labels. External JSON, CLI replies, environment values, and IPC frames are untyped until the boundary parsers validate them. Internal code consumes the resulting types without repeated validation.

```typescript
type Id<K extends string> = string & { readonly __kind: K };
export type CoreId = Id<"core">;
export type TerminalId = Id<"terminal">;
export type TerminalAddress = Id<"terminal-address">;
export type SessionId = Id<"session">;
export type MachineName = Id<"machine">;
export type JobId = Id<"job">;
export type RunId = Id<"run">;
export type Generation = Id<"generation">;
export type SpaceId = Id<"space">;
export type TabId = Id<"tab">;
export type PaneId = Id<"pane">;
export interface TerminalIdentity {
	coreId: CoreId;
	terminalId: TerminalId;
	address: TerminalAddress;
	socket: string;
	sessionNamespace: string;
}
export interface ProcessPresence {
	pid: number;
	startIdentity: string;
	sessionFile: string | null;
	sessionName: string | null;
	kind: "top-level" | "child";
	hcAddress: TerminalAddress | null;
}
export interface Owner {
	sessionId: SessionId;
	generation: Generation;
	terminal: TerminalIdentity;
	cwd: string;
	sessionFile: string | null;
	name: string | null;
}
export type JobPhase =
	| { kind: "preparing" }
	| { kind: "waiting-for-pane"; address: TerminalAddress }
	| { kind: "running"; address: TerminalAddress; releasedAt: number }
	| { kind: "disconnected"; address: TerminalAddress; lastSeq: number }
	| { kind: "finished"; address: TerminalAddress; result: TerminalFinish }
	| { kind: "launch-failed"; error: string };
export interface TerminalFinish {
	exitCode: number | null;
	reason: string;
	signal: number | null;
	finishedAt: number;
}
export interface JobRecord {
	version: 1;
	id: JobId;
	owner: Owner;
	machine: MachineName;
	kind: "exec" | "exec-file" | "batch";
	phase: JobPhase;
	viewer: TerminalAddress | null;
	remoteDirectory: string;
	localDirectory: string;
	detached: boolean;
	noticeMode: "tool" | "async";
	notice: "pending" | "submitted" | "observed";
}
```

A terminal's identity is its core ID and terminal ID. Its returned address routes requests through the local core. `HC_SCOPE` is not a machine identity. Caller discovery checks both `HC_TERMINAL_ID` and `HC_TERMINAL_SOCKET` against the selected core. Tests preserve `HC_SESSION` rather than borrowing the default namespace.

A headless child's inherited HC variables do not grant terminal ownership. An on request from a child fails before launch with child-remote-unsupported. There is no remote-job delegation protocol. Children never overwrite the parent's session map, status, or feed. They still publish their own process presence, so setup can account for every pi process.

Independent producers have independent files. A session publisher owns its session feed. Its in-process monitor owns that session's job journal. A registry writer owns one terminal mapping, and each pi process owns one presence record. Readers combine those files. No process rewrites a global combined status file.

A session-file lease is a separate invariant. The launcher acquires it before starting pi. It records the canonical path, PID, process start identity, and an unguessable token. A heartbeat alone never proves that a session is closed. A stale lease is reclaimed only after the process identity is proved absent. PID reuse cannot authorize a second writer.

## Status and session lifecycle

Pi remains the only program-status reporter. Spider contributes only the state of this session's queued, running, or paused subagent runs.

`registerHerdrStatusContribution` captures the public TUI terminal through an empty `ctx.ui.setWidget` factory. It wraps that terminal's public `setProgramStatus` method. Before wrapping, it validates and reads pi 1.2.0's `programStatus` cache to seed the latest native value. That cache field is not a public contribution API, so its shape is part of the installed-module contract and feature detection. This preserves a blocked dialog or error that an earlier extension produced before the widget factory ran. If no native value exists yet, the adapter writes no contribution until the native setter supplies one. It never guesses idle. It retains subsequent native status and calls the original setter with a contributed value. It never writes an independent OSC overlay.

When pending children exist, native `idle` and `done` become `working`. The message includes only nonzero counts, such as `2 subagents running` or `1 queued, 1 paused`. Native `working`, `blocked`, and `error` pass through unchanged. Normal completion of the final child restores native `done`. If the parent was cancelled, the retained native `idle` remains idle after its children finish. Errors and permission dialogs never become working merely because children exist.

The original setter performs protocol support detection and `formatProgramStatus` formatting. The formatter sanitizes controls, limits the decoded message to 2,048 UTF-8 bytes, base64-encodes `msg`, and emits one complete OSC terminated by ST. No writes occur from a component's `render` method. `PI_PROGRAM_STATUS=0` remains effective.

The exact enable predicate is `ctx.mode === "tui" && process.env.PI_SUBAGENT_CHILD !== "1" && Boolean(process.env.HC_TERMINAL_ID)`. `hasUI` is insufficient because RPC has UI methods. Headless children can inherit the parent's HC variables but never own its status.

Counts come from `RunStore.listActive(owner.sessionId)` on the database returned by `openSessionRunDb`. That query includes queued, running, and paused rows. The cache-warming child count and the UI's retained completed rows are not completion sources. Committed run events request count refreshes. A two-second reconciliation covers events written by another process.

The adapter checks the live terminal method, validated cache, synchronous widget-factory capture, and formatter before installation. An unknown shape or an existing foreign wrapper disables the contribution with one diagnostic. It does not guess, disable native pi reporting, or replace the reporter. The contract test loads the repository's pi devDependency modules. The deployed pi executable can run a patched bundle, so doctor checks the actual terminal instance, not a dist file on disk. The standalone CLI reads that instance's detected capability through authenticated session ping. With no live instance, it reports status-instance-unavailable instead of substituting a file check.

A nonpersistent pi session has `owner.sessionFile:null`. It can still publish live status, jobs, and viewer IPC under its actual session ID, but it has no resume offer or file lease. A new persistent session can have an allocated path before pi writes its first conversation. Register that canonical intended path without opening or creating the session file; offer resume only after a valid header exists. Never manufacture a file merely to make an empty role template resumable.

`session_start` replaces activation-specific state for startup, reload, new, resume, and fork. Shutdown cancels subscriptions and restores the original method only if the installed method is still this adapter's wrapper. Old-generation callbacks cannot publish or restore another activation's method. Reload reopens the same session feed and job journal without duplicating viewers. New and fork use a fresh owner and do not inherit another session's jobs or triggers.

The installed-module contract test drives the real `ProgramStatusReporter` and `ProcessTerminal`. It proves that native duplicate-done suppression, terminal-cache replay, title refresh, and dialog closure cannot restore stale done while pending children exist. It also proves the negative control: a raw working overlay loses to native cached done. An isolated TUI acceptance case verifies the contributed state in real `hc get` output.

## Status feed and local IPC

The directory is `<global spider directory>/herdr`. It follows `SPIDER_GLOBAL_ROOT`. Session feeds live in `sessions/<session-id>/session.json`. Job records live in the same directory's `jobs.json`. Terminal associations live in `terminals/<identity-hash>.json`. Process presence lives in `processes/<pid>-<start-identity-hash>.json`. Machine measurements are panel-local snapshots from bounded file reads, not a separate published runtime feed.

Every feed uses version 1, epoch milliseconds, a monotonically increasing revision within a generation, and an update timestamp. Writers create a same-directory temporary file, flush it, and rename it. Directories are user-only and files are mode 0600 on POSIX systems. Readers reject symlinks, oversized files, invalid shapes, and unknown versions. Each feed is at most 1 MiB. Lists carry total counts and a `truncated` flag when the published rows do not fit.

`session.json` has these fields:

```typescript
export type ProgramState = "idle" | "working" | "blocked" | "done" | "error";
export interface SessionPlacement {
	spaceId: SpaceId;
	spaceName: string | null;
	spaceOrder: number | null;
	tabId: TabId | null;
}
export interface SessionFeed {
	version: 1;
	sessionId: SessionId;
	generation: Generation;
	revision: number;
	updatedAt: number;
	owner: Owner;
	placement: SessionPlacement | null;
	lifecycle: "live" | "closed";
	status: { native: ProgramState | null; effective: ProgramState | null; message: string | null };
	runs: { rows: RunSummary[]; total: number; truncated: boolean };
	todos: { rows: TodoSummary[]; total: number; truncated: boolean };
	triggers: TriggerSummary[];
	pace: PaceSummary;
	approvals: ApprovalSummary[];
	notifications: PanelNotification[];
	ipc: { address: string; capabilityFile: string } | null;
	errors: { source: string; message: string }[];
}
```

The host data source obtains placement from the local owner's current core labels and a validated read-only app-layout snapshot. Space names and visual order are null when not observed; no configured or guessed name substitutes for a different live space. The panel groups by observed space ID, follows observed order, and uses stable IDs for unknown-order ties. Null placement appears in an explicit unplaced group. Placement refreshes independently of a session's immutable terminal identity.

`RunSummary` contains `id`, `ownerSessionId`, `name`, `status`, `childMode`, `canSteer`, `startedAt`, `finishedAt`, `viewer`, and a scrubbed result summary. `TodoSummary` contains `seq`, `sessionId`, `text`, and `done`. `TriggerSummary` contains `name`, `kind`, `nextAt`, `tz`, `state`, and an 80-character single-line prompt preview. `PaceSummary` contains `scope`, `used`, `budget`, `projected`, `remaining`, `periodStart`, `periodEnd`, `updatedAt`, and `unavailableReason`. Missing numeric values are null, never zero estimates.

`ApprovalSummary` contains `uuid`, `scope`, `repoKey`, `ownerSessionId`, `category`, and a scrubbed preview. Global approvals have `ownerSessionId:null` and shared scope. Repository approvals with no reliable owner also remain shared within that repository. The panel deduplicates shared rows by scope, repository key, and UUID.

`PanelNotification` contains id, kind, createdAt, scope, sessionId, ownerAddress, title, body, and action. Kinds are subagent-result, escalation, budget, and job-result. Session-scoped notices have the owning session ID and address, with a focus-owner action. Budget notices have shared scope, null sessionId and ownerAddress, and an open-usage action. Their stable ID is budget:<periodStart>:<threshold>, where threshold is 80, 100, or projected. A mod stores seen IDs in its own persisted state, so opening the panel does not replay historical notices.

The owning session serves a short hashed Unix-socket path under `herdr/ipc`. Preflight checks the full path's UTF-8 length against the platform limit, including the 103-byte macOS limit, before starting the endpoint. It fails with a shorter-root repair instruction rather than using a shared temporary directory. A platform transport can use a named pipe only after its access checks pass. A generation-specific 256-bit capability is in a separate user-only file, not in terminal labels or transcripts. The endpoint has no TCP listener. Mods invoke the packaged IPC client through Herdr's local `exec` API for bounded actions. Viewers hold a streaming connection.

The protocol is LF-delimited JSON with version, requestId, sessionId, generation, and capability in each request. The session capability allows subscribeRun, steerRun, openView, and ping. subscribeRun takes a full run ID and an event cursor. steerRun takes a full run ID and nonblank text of at most 16 KiB. Unknown operations and wrong capabilities fail. The endpoint exposes neither arbitrary shell execution nor generic tool dispatch. Job completion reaches pi through the in-process monitor, not an IPC operation. The host transcript adapter pages committed run events and child transcript files by cursor, using the exact owner-bound database. View and steer ports call existing handler instances.

A stream frame contains `cursor`, `runId`, `kind`, and data. Kinds are `snapshot`, `event`, `gap`, and `end`. Frames are at most 256 KiB. Transcript pages are at most 64 KiB. A client that exceeds a 1 MiB pending-output budget receives a gap and a fresh cursor rather than stalling pi. A generation change ends the connection. Authentication, session ownership, run ownership, and current steering capability are checked at the endpoint.

Setup supplies each panel's validated feedRoot, packaged CLI path, Node path, user-config path, and canonical label contract through mod props. It does not rely on the app inheriting pi's `SPIDER_GLOBAL_ROOT`. Setup copies the single shared feed-parser asset into each consuming mod's own `shared/feed.js`, and copies the agents projection into the cloned agents folder as `spider-children.js`. All imports stay relative to that mod. These installed copies have one source and one installer owner. Declaration-only files do not install.

Readers watch only the feed directory through `watchFolder`. They load a snapshot before watching and reload after registering the watch, so a startup change is not lost. A two-second timestamp check detects a crashed publisher. A live feed older than ten seconds is labelled disconnected. A stale row is never treated as a newly completed job. Raw transcripts and command output stay out of the status feed and travel only through bounded IPC or private log files.

## Visible remote execution and completion notices

`spider exec`, `exec_file`, and `batch` gain an optional top-level `on` machine name. With no on, current local payload and output semantics remain unchanged apart from the managed-SSH routing policy and the explicit foreground-timeout error classification below. With `on`, routing validates that exact configured hc machine and selects remote execution before creating a local language runtime. A batch inherits one `on` for every entry. A per-entry `on` is rejected. exec_file runs the caller's code with FILE_CONTENT and file_path bound by the same per-language wrapper used locally. Its source is { kind: "file"; language: Language; path: string; code: string }. The wrapper reads the path on the destination at payload execution time. The destination file is not itself executed, read locally, or copied as analysis code. A configured machine cwd controls payload execution. Without one, code and absolute-file execution use hc's destination-home default by omitting `--cwd`; the local agent's cwd is never substituted. A relative remote file path requires a configured remote cwd and otherwise fails before launch. The private upload directory is a separate absolute path supplied by the machine runtime configuration.

Each entry creates its own remote terminal, even for a short command. The launch is `hc run --bg --no-notify --outlive-parent --on <machine>`, with the agent's actual `HC_TERMINAL_ID`, `HC_TERMINAL_SOCKET`, and `HC_SESSION`. It omits `--parent`. The monitor explicitly cancels foreground jobs on ordinary owner shutdown; native parent cleanup must not kill a job that detached later. The equivalent local-core RPC uses `terminal.run` with `on` and `caller`, without `parent`. The native cross-core parent then places the command under its agent. `hc exec --on` is never used for payload execution.

Job labels are `spider.session`, `spider.owner-core`, `spider.owner-terminal`, `spider.kind`, and `spider.job`. Labels contain IDs, not commands or credentials. Remote jobs never receive the local agent's `herdr.space` or `herdr.tab` labels.

The job monitor establishes one long-lived `hc events --json` subscription before any launch. It consumes the initial snapshot, ordered `seq` values, the 15-second heartbeat, and `missed` with its replacement snapshot. It reconnects with bounded backoff and reconciles known job labels before accepting another launch. A failed launch reply is uncertain until reconciliation proves whether its preassigned job ID exists. The monitor never retries a payload because the reply was lost.

The monitor is an in-process actor with no separate executable, socket protocol, lease, or delegated run client. Closing pi cancels foreground jobs but leaves detached destination jobs running. Local logs stop growing until the next activation collects the missing chunks. On every session_start, the actor subscribes and reconciles the durable journal, remote receipts, and original-terminal finished events without rerunning payloads. It checks already persisted spider.job_done messages before delivering missed notices.

Only the original job's finished event or a valid runtime receipt determines completion. Its exit_code, reason, and signal remain distinct. Lost, restarted, an idle status, and an observer's exit code are not completion. A replacement snapshot can recover a missed finish for a tracked job. Finished records can expire after 24 hours or beyond 500 terminals. A digest-validated receipt bound to the job nonce alone settles the payload when that record has expired. Conflicting evidence produces an unknown outcome. Missing terminal evidence and no valid receipt retain receipt locations without fabricating exit zero. Recovery never reruns the task.

### The remote runtime and full output

The installer writes the built-in-only runtime once per version to each configured machine with hc file write --on. A recorded SHA-256 digest identifies that install. Setup and doctor verify the installed digest, and jobs reuse it rather than uploading it again. Each job has a private random remote directory containing its request and source files. The runtime verifies request and source digests before starting the payload. It starts from the destination PATH and strips inherited bypasses. A remote-side SSH shim, per-job alias-cache uploads, and remote alias refresh are future work, not requirements of this implementation.

The request contains an argv array, uploaded source digests, cwd, an allowlisted environment, the job nonce, and a releaseDeadlineAt. It never embeds the destination exec_file contents. Context's language preparer creates the argv and files using destination runtime commands. Shell code is a script, not a command assembled by concatenating user text. Interpreter and compiler commands are discovered by the visible runtime or supplied in machine configuration. An unavailable language fails on the destination. It never chooses a local interpreter instead.

The runtime starts in waiting-for-pane. It emits a nonce marker outside payload logs, then waits for a nonce-bearing release.json file. The monitor creates a local observer terminal and checks that hc read of that LOCAL terminal contains the marker. HcClient.read(address, {lines}) supplies this screen evidence without piping attach off its TTY. The app document must also acknowledge the pane in the owner's tab. Pane presence without the marker never releases the payload. Only after both checks does the monitor write the release file through hc's file API. Cancellation or a ten-second acknowledgement deadline removes the waiting job without executing its argv. The runtime enforces its own ten-second release deadline on the destination, even if pi dies. An expired deadline exits with release-timeout and never runs the payload.

The runtime does not read or consume stdin before release. The payload receives stdin from /dev/null, matching local exec. A payload that reads stdin gets EOF and exits. The release check never consumes payload stdin. Its stdout and stderr remain separate pipes, as in local spider execution. This preserves non-TTY capture semantics rather than promising an interactive full-screen payload. The mirrored terminal keeps the destination core's configured headless dimensions, with a tested default of 200 columns by 120 rows. Observe never resizes it. Narrow panes can clip that screen; complete saved logs remain available in a reflowing read-only view. The runtime records their raw bytes in separate files and mirrors them to the job terminal. It forwards HUP, INT, and TERM to the payload process group and records its result. `hc kill` supplies cancellation and its own escalation. The wrapper preserves ordinary exit codes and, after persisting a signal result, terminates by that signal. The monitor verifies the runtime receipt and cross-checks the original terminal's finished event when it remains available. An expired finished record does not invalidate a valid receipt. A wrapper crash with no valid receipt is unknown, even if its terminal exited with a number.

For transport, the runtime writes immutable chunks containing stream name, byte offset, and base64 data. A chunk contains at most 48 KiB of raw data. An atomically replaced index publishes only complete chunks. The client downloads those chunks with hc file reads, verifies offsets and digests, and reconstructs separate local stdout and stderr logs. This avoids hc's file-read size limit and its terminal-history tail limit. A missing chunk delays collection or reports incomplete output. It does not silently join a truncated tail.

Foreground model capture retains the existing combined 100 MiB hard cap, UTF-8 decoding, cumulative partials at most every 100 ms, and 10,000-byte model-facing output cap. Final and partial output use the host's existing secret scrubbing. Only payload stdout and stderr enter the tool's text result. Wrapper markers, pane operations, and uploaded source are not appended to model context. Large output points to private durable logs for further bounded analysis.

`timeout` remains milliseconds spent waiting for the call. Without `background`, an expired timeout cancels the remote job. With `background:true`, capture is durable from launch, and an expired timeout detaches with `exitCode:null`. Without a timeout, background capture still waits for the real exit. Aborting a batch stops the current job and prevents later entries from starting. A detached job outlives the tool call and retains its agents-list row and view action. Its pane is released immediately after the tool call returns, so long-running background work cannot occupy all slots. Foreground jobs are cancelled on an ordinary session shutdown. Reload hands tracked jobs to the new activation. Detached jobs retain their parent label and journals after the parent closes.

The normal outcome uses context's existing `ExecResult` and `isExecError` semantics. Foreground timeout sets `timedOut:true` and keeps the observed signal or numeric exit. A command that traps HUP and exits zero still counts as a timed-out call, not success. Context's shared error classifier gains that explicit foreground-timeout case for local and remote calls without turning detached or unknown results into hard errors. This deliberately changes a local foreground payload that traps HUP and exits zero from isError:false to isError:true. Existing actions-exec.test.ts:83-95 assertions remain unchanged, and a new local regression pins the changed timeout behavior. Structured remote details add the job ID, machine, address, and receipt locations. No second output shaper is introduced.

### Pane arrangement and retention

The default arrangement uses one agent tab with an auxiliary strip to its right. Herdr 0.1.11 adopts labelled local terminals by splitting the rightmost pane horizontally and preserving focus. The integration uses that tested behavior instead of pretending adoption creates a vertical stack.

A remote observer is a local terminal running `hc attach --observe --history 100 <machine>/<terminal>` inside the packaged viewer wrapper. Its local launch explicitly uses `hc run --bg --no-notify --no-parent` with the owner tab labels. It is parentless and labelled with the agent's local `herdr.space` and `herdr.tab` IDs. Its `spider.kind` is `remote-observer`. The cloned agents mod filters observers from both top-level agent rows and child rows, including OSC status replay. The original remote job is the single child row.

The default limit is two auxiliary panes per tab, configurable from one through six. Remote jobs acquire a slot before launch. Waiting jobs use FIFO order with a separate 30-second slot-wait deadline. Expiry fails with pane-slot-timeout and launches nothing. A parked subagent view can release a slot for a remote job. Running foreground observers are not evicted. Detached observers release their pane after the tool call returns and remain available through their row's view action. Every payload has a live pane before it starts. Closing that pane cancels its still-running foreground job. If the app is unavailable or the owner tab cannot be resolved, the payload fails before release.

Subagent views always have terminals and child rows. When the strip is full, their terminals remain parked and can be peeked without delaying subagent execution. A row's view action reuses its existing viewer. Placement uses returned space, tab, and pane IDs, never selected-tab assumptions or a focus-changing placement command.

After completion, the observer holds final output for two seconds. The placement actor then parks that owned terminal and acknowledges pane removal before the wrapper exits. Normal native removal is also reconciled, so a kept recovery shell cannot occupy the strip indefinitely. The agents mod retains a finished row under the owner for 24 hours, with a default maximum of 50 completed rows per owner. It merges native live terminals with retained feed records by job or run ID. Clicking a finished row opens the packaged log viewer, because attaching to a finished terminal is not reliable. The row states output completeness and the actual job outcome.

Job terminals are not launched with `--rm`. After full output is collected and a notice is recorded, cleanup can remove only spider-owned finished terminals. Completed foreground logs and journals retain seven days by default. Any directory returned as `backgroundJob` remains caller-owned and is never deleted automatically. Its handle keeps the existing `id`, `dir`, `manifest`, `receipt`, and `logs` shape. The destination runtime continues growing its logs after pi closes. The next activation collects missing chunks and writes the local receipt after verification. Incomplete, disconnected, or unsubmitted results are not deleted by age alone. Recovery shells created from kept viewer terminals are identified by labels and replaced or closed. They are never mistaken for the original task.

When the same session resumes in a new terminal, a still-running remote job keeps its original native parent. The cloned agents mod can place that tracked journal row under the session's new verified owner by session ID. It shows the original address in the details. It never guesses a new owner from cwd or a repeated tab name, and never resolves a local parent flag on the remote core.

### Notices

The monitor persists the outcome and output locations before posting spider.job_done with pi.sendMessage in the owning process. It verifies the tracked journal itself. Normal completion uses {triggerTurn:true, deliverAs:"steer"}, so a busy agent gets the notice when its current step ends. During shutdown it records pending delivery without starting another turn. Notices never use hc send, a bracketed paste, or terminal keys.

The notice includes a stable job ID, machine, terminal address, outcome, a bounded scrubbed output summary, and receipt paths. A job starts in `noticeMode:"tool"`; the monitor records a finish but withholds asynchronous submission while that tool waiter exists. Synchronous completion acknowledges consumption before returning its result. A background timeout explicitly switches to async mode before returning the detached handle. The tool_execution_end callback then calls toolReturned(jobId), which releases the detached pane. detach alone changes notice eligibility, not pane readiness. If a waiter disappears with its owner, recovery exposes the pending result to the next verified owner rather than assuming consumption. This ordering prevents a fast finish from posting a follow-up before the synchronous result can consume it. Detached or independently finished jobs receive the asynchronous notice.

On every session_start, the monitor checks existing `spider.job_done` entries and its durable journal before resubmitting. A submitted notice becomes observed when its matching custom message reaches the transcript. A process crash between submission and durable observation can make delivery uncertain. The same job ID makes that uncertainty visible and allows deduplication. The design does not promise exactly-once delivery across a disk failure.

## Raw SSH routing policy

The integration refuses raw SSH to configured Herdr machines and points to `spider exec` with `on:<machine>`. This is a routing policy for cooperative agents, not a security sandbox. A direct absolute-path SSH call inside another program still bypasses a PATH shim. The parsed tool guard rejects explicit absolute-path SSH in tool input, but arbitrary programs can bypass that parser.

Both enforcement mechanisms are required. A parsed tool-call guard runs before the bash opt-out and before context execution routing. It covers shell `exec`, shell `exec_file`, every shell batch entry, and built-in bash. A PATH shim covers ordinary SSH subprocesses from every language and nested program. A rejected batch performs no earlier entries.

The parser understands SSH options and their operands, `--`, compound shell commands, pipelines, username prefixes, URI ports, bracketed IPv6, `-o HostName`, jump destinations, and explicit SSH inside ProxyCommand. Dynamic or unsupported destinations fail closed when the command can route to a managed machine. It never executes `ssh -G` or SSH configuration commands to classify a destination.

A machine-cache owner calls `hc machine ls --json` at startup, on explicit refresh, and every 30 seconds while enforcement is active. Its snapshot is keyed by core ID, session namespace, and socket. It contains schema version, fetch time, machine IDs, and normalized names, hosts, targets, and configured aliases. Its maximum validity is 120 seconds. Registration through spider updates this cache before publishing the machine for agent use. An external registration can remain unknown until refresh, which doctor reports.

A valid cache lets other hosts pass through to the real SSH binary with the original argv, streams, signals, and exit code. The real binary is resolved before prepending the shim, and self-resolution is rejected. A failed refresh can use a still-valid snapshot and reports the failure. With enforcement enabled in Herdr and no valid snapshot, all raw SSH is refused, including unmatched hosts. Known previously denied destinations remain denied through an outage. Outside Herdr with integration disabled, the shim is absent.

Every execution builds an immutable environment. The shim directory is prepended after context's PATH normalization and Windows path fixes. The generated shell script receives that same final PATH, not `process.env.PATH`. Durable supervisors and their payloads inherit it. A public pi bash definition uses `spawnHook` after pi's shell environment is built, independent of `enforcement.bash`. `user_bash` uses public local bash operations with the same environment. RPC and print children receive the shim in the final merged spawn environment. No tool changes the parent process's global PATH.

The policy also preflights explicit managed-host transfers and transports in scp, SFTP, rsync SSH options, and Git SSH overrides. An SSH-only shim is not claimed to intercept scp's absolute helper or rsync daemon traffic. Known managed destinations in those explicit paths require a visible job or the admin route. Ordinary HTTPS Git and local file copies are unaffected. Shell functions, startup-file PATH resets, copied binaries, and explicitly replaced environments remain documented bypasses.

The admin escape is a per-operation CLI route with a configured allowlisted wrapper, a required reason, and a destination. It is not a model-authorized boolean on the spider tool. A user-owned policy approves wrapper identities. The route records session, wrapper identity, reason, and destination in local audit data. It grants `SPIDER_HERDR_SSH_BYPASS=1` only to the authorized transport subprocess. Both safe execution environments and child spawns strip inherited bypass variables. The transport clears the bypass before executing a job payload or another agent. There are no exceptions based only on names such as hc, Git, or a script basename. An invalid `on` or failed hc transport never falls back to local execution.

## Subagent views and steering

`registerHerdrViewers` subscribes to committed owned run events. It creates one local viewer terminal for each run ID, including queued or print-mode runs. The viewer's local parent is the owning agent terminal. Every spider-issued hc run, including viewers, setup probes, role launches, observers, and resumed launches, passes --no-notify. One test checks the shared fake's recorded argv across all launch paths. Doctor verifies this launch invariant as well as notes = false. Its labels identify its session and run. The cloned agents mod filters its top-level status replay but retains the one child row.

The viewer reads bounded transcript and event pages through the owning session's IPC endpoint. It displays text, tool activity, escalation lines, and the final result. It strips unsafe terminal control sequences and never replays transcript OSC commands. Cursor-based replay handles split records, reconnection, and a replaced snapshot without repeating text. The original child process and its stdin remain invisible to the viewer.

The transcript is read-only. The viewer has a separate composer. Enter submits that composer as `steerRun`, not as raw child-terminal input. The endpoint invokes the owning session's existing message action with the full run ID. That action reaches the live RPC child. The viewer displays its actual acknowledgement, including accepted but unconfirmed, queued, delivered, refused, or delivery unknown. It does not resend an uncertain steer.

Only an owned running RPC child with a live pipe can steer. Queued, paused, finished, cancelled, failed, and print-mode runs show a specific explanation and disable submission. Slash-prefixed text is refused as in the existing message action. A completion racing with Enter produces the real refusal. A closed owning session allows saved-log viewing but no steering.

The viewer holds final output for two seconds, releases its displayed reservation through the placement actor, then exits. Its retained child row opens a saved read-only view. It never launches a second subagent or converts print-mode children to RPC. Subagent execution mode and the organism's child-process prohibition remain unchanged.

## Spider panel

The spider mod shows sessions in space order, with running and pending runs, open todos, upcoming triggers, monthly credit pace, and pending approvals. A session row focuses its agent with `pane.focus {terminal}`. A run row opens its existing viewer or a saved view. Todo, memory, usage, and trigger actions reach their shared pi handlers through the owning endpoint. The panel never types a slash command.

The host sources are `RunStore`, the todo store filtered by session ID, a new read-only scheduler listing and subscription, the existing usage ledger and `computePace`, and `listPending` for repository and global scope. Pending counts use `listActive` only. A separate retained-completion query supplies finished run rows for the child tree and saved views. The persisted `child_mode` and `getChild(owner.sessionId, runId)?.steer` determine the displayed steering capability; a running database row alone is insufficient. Budget totals are account-wide shared data. A per-session usage figure is labelled separately and is not called that session's monthly allowance. Missing counter data shows unavailable rather than a zero-credit month.

The publisher refreshes run and todo changes from committed events, trigger changes from the scheduler subscription, and approvals after staging or review events. It reconciles those sources every two seconds. Usage refreshes at most once every 30 seconds and retains the ledger's timestamp. The panel watches local feed files rather than opening live spider databases itself.

B3's host data source produces notifications from committed run escalation and completion events, persisted job-journal outcomes, and account pace thresholds. Budget warnings occur once per billing period at 80 percent used and at 100 percent used. An over-budget projection produces one separate projected-over-budget warning. Null budget or projection values produce no budget notification. Shared budget notices deduplicate across session feeds and open usage through any verified live endpoint, never pane focus. Session result and escalation notices focus their recorded owner. With no live endpoint, open usage is unavailable. Shared approval counts do not invent a session owner. A closed owner never redirects focus to another selected tab.

The mod uses plain JavaScript. `data.js` exports importable pure projections and notification selection. `main.js` imports gpui-kit only for presentation and calls the Herdr file, command, and notification APIs. Native animation handles spinners. Timers do not animate the whole window.

## Machines panel

The machines mod shows configured non-temporary machines, connection state, load, running jobs grouped by owner and kind, lock ownership, and an **Open shell** action. Job labels and the live hc terminal snapshot are authoritative for job ownership. Unknown owners remain unknown.

The panel reads the configured lock file, /proc/loadavg, and /proc/meminfo with readTextFile(path, {on}). These bounded file reads run off the UI thread. There is no remote metrics runtime, metrics terminal, or sampling lease. Non-Linux destinations show null load and unsupported memory values. A pure collector.js inside the machines mod parses the returned text. main.js imports it relatively and supplies Herdr's readTextFile function.

A lock adapter is data: an absolute path, text or json format, and an optional JSON owner-field path. Empty or missing locks mean unheld. An unreadable or malformed lock means unknown, not unheld. The panel does not acquire, delete, or override another system's lock.

The panel refreshes measurements every five seconds. Each successful collection is timestamped by the local clock. Failed reads retain the prior sample without refreshing its timestamp. A sample older than 15 seconds is stale. A disconnected machine retains its last sample and disables unavailable actions. The shell action uses space.new {machine, folder, argv} or an existing machine space's tab.new, then focuses the returned terminal. It never uses mod exec to start a hidden shell.

Herdr maintains and redials every configured machine connection. A connect command that can wake a stopped provider belongs only in an in-use machine profile. Spider does not implement provider-specific wake or pause policy. Reading measurements never adds a machine or starts a stopped provider.

## Panel placement and states

The personal layout keeps the current sidebar and work area. Its existing right-hand `panel-body` stack retains files and changes and adds children named spider and machines. The panel remains hidden by default so two auxiliary panes do not shrink further on a narrow window. Two compact buttons in the cloned spaces header open Spider or Machines with `layout.show {id:"panel"}` and `layout.select {stack:"panel-body", child:<name>}`. No terminal is focused or selected merely to open that panel. Its header offers the same two tabs and a close button that calls `layout.hide`.

The dock keeps the current 368-pixel default width and its 280-to-900-pixel bounds. It scrolls vertically rather than expanding with the session count. A session summary shows its name and state first, then the nonzero run and todo counts. Expanding it reveals the feed's facts and view actions. The shared approvals section sits outside the session rows. Machine rows lead with connection and load, then owner/kind jobs and the lock state. Open shell is a labelled action, not an unexplained icon.

A missing feed says no live sessions and offers doctor. A stale feed says disconnected with its timestamp. An unavailable budget says unavailable. A machine's unreadable lock says unknown. Actions that need a live endpoint are disabled with that reason. Long paths and prompts truncate on screen with full text available on demand. Native keyboard navigation and selected-fill focus remain visible. Working spinners use the existing native animation; there is no added entry animation or polling-driven animation.

## Reboot resume, spaces, and cutover

The terminal map records the owner's exact absolute session file, session ID, latest name, cwd, core identity, recordedAt, coreStartedAt, and required non-secret launch environment. It records only supported environment values such as the agent directory and explicit extension paths. It never stores authentication variables or a hard-coded model override.

Each mapping is one atomic file keyed by core and terminal identity. New, resume, and fork replace only that terminal's mapping. Normal pi exit closes its lease but retains the last resumable association. A proven removed terminal permits mapping cleanup. A missing file, changed session ID, foreign core, or ambiguous live owner produces no automatic resume.

Core notes are disabled before any fresh launch. In hc 0.1.16, deliver_notes captures enablement once. Writing notes = false does not cancel a task already waiting. Cutover therefore allocates fresh hc terminal IDs and records the retired identities in its setup journal. After a core restart, the core start identity is later than the mapping and no cached note task survives. Reboot resume then uses the restored shell itself rather than creating another terminal. An unproved restart cannot authorize same-address resume.

The installed shell hook is a marked block in the configured bash or zsh rc file. It does nothing outside an interactive HC shell. A restored shell prints the saved name and offers a named function to resume. After a proved core restart, the function invokes the packaged leased launcher in that shell with exact pi --session <exact-file> in the saved cwd. The launcher acquires the lease before opening the file. It does not auto-type or auto-run pi. One reboot leaves one terminal and one mapping per session. Declining leaves a normal shell. The separate fresh-terminal path is used only at cutover. Resume never uses --continue, changes the session name, or forces a template model.

Spaces are declared in the external user file as ordered names and ordered session selectors. A selector is an exact session file or a latest `session_info` name with an optional exact session ID. Duplicate names require an exact ID. Discovery reads metadata without invoking `SessionManager.open`. It preserves a proven live cwd when available and otherwise uses the session header cwd. Several sessions can share the same repository and cwd.

Every pi process that loads spider records its own presence on session_start, including reload, regardless of HC identity, top-level or child mode, or integration enablement. The record contains PID, process start identity, canonical session file or null, session name or null, top-level or child kind, and hc address or null. Clean shutdown removes only that process's record. Setup lists live recorded sessions BY NAME and includes their PIDs. It never opens a session file held by a live recorded PID, even for metadata discovery. An unrecorded same-user pi process remains blocking, with the message /reload or close these PIDs. After reload records identify it, only processes holding files that setup opens must exit. Setup neither kills other sessions nor asks a peer to approve closure. Cutover waits until every session file it opens is free. Broker disconnection, absent file descriptors, and old heartbeats do not prove closure.

The setup process holds a global setup lock. Each new launch also holds its canonical session-file lease. It rechecks liveness immediately before launch. Independent external pi launches that ignore these leases are unsupported. A detected concurrent writer aborts cutover rather than opening another copy. The integration's own launchers structurally exclude duplicate writers.

The cutover command runs from a plain shell, never from a pi process. Its order for roughly ten open sessions is fixed:

1. Reload existing pi sessions so each records its presence, including child processes. From a plain shell, run the documented setup command. /herdr-setup only prints that exact command and these cutover steps.
2. Setup validates configuration and binaries, inventories process presence, and displays session names and PIDs without opening live files. It blocks on every unaccounted pi process and asks for /reload or closure.
3. Setup prepares backups and assets. It lists the sessions whose files it needs. Existing work must settle or be cancelled deliberately before the user closes those sessions. A session that printed /herdr-setup is not exempt if its file is selected.
4. Setup waits on process and lease changes, with a 30-minute deadline. It reads target metadata only after every file it opens is free. Recorded unrelated sessions may remain live. It rechecks liveness immediately before each launch.
5. Setup creates or reuses configured spaces and tabs using returned IDs. Each tab starts a fresh-terminal leased launcher with the exact file and cwd. Previously closed named sessions follow the same path.
6. Each new session publishes its owner mapping and feed. Setup checks the same session ID and cwd in the returned terminal, records the tab ID, and focuses the configured first space only at the end.

A failed launch leaves its exact session unopened elsewhere and records the failure in the setup journal. A retry reuses the journal's space and tab IDs. Existing tabs are reused only when their recorded owner identity matches. An unrelated tab with the same name is a conflict, not permission to overwrite it.

## Templates and shortcuts

The generator merges global and selected-project modelDefaultLayers per role, then calls resolveRoleDefaults over the registry catalog. ROLE_POLICY in packages/models/src/pick.ts defines watcher as { tier: "light", thinking: thinking.low }. Worker and reviewer already have high thinking. A configured worker and reviewer without suffixes and no watcher therefore produce three valid templates. Thinking comes from the :level suffix or ROLE_POLICY[role].thinking. Provider qualification uses the matched catalog entry, and availability uses getAvailable() membership. A configured model that is unavailable fails with role-unresolved before any template write. Missing optional role configuration uses the shipped policy instead of failing. An empty eligible catalog produces catalog-unavailable, not a missing-role error. Every generated command includes provider-qualified --model and explicit --thinking. Shipped recipes contain no model IDs.

Generated roles start visible top-level interactive pi sessions through hc run --bg --no-notify. Their installed names default to spider-reviewer, spider-worker, and spider-watcher. Their Markdown bodies are empty. A separate role-instructions file reaches pi through `--append-system-prompt <absolute-file>` in the template command. Any managed or licence marker remains a `key: value` frontmatter field, never a nonempty body.

This differs from hc's usual template flow because hc 0.1.16 combines the body and extra task arguments into `first_message` and then pastes that message into the new terminal. Empty bodies and no extra task arguments produce no first message. The generated launch instructions therefore use `hc run --bg --no-notify spider-worker` without a task argument. Work can be assigned through the existing peer message/intercom path once the session is ready, or by the person at its editor. The integration never asks hc to deliver a task through terminal input.

Role instructions require a bounded scope, no nested subagents unless explicitly assigned, and intercom for agent-to-agent reports. They never suggest `hc send` to a pi terminal. These role templates do not change spider's existing headless subagent mode.

The managed HC section adds at most 1,000 characters, and the complete SPIDER_BLOCK_BODY stays within its existing 8,500-character test cap. Raising that cap is forbidden. The managed global AGENTS block always uses stable conditional wording: when `HC_TERMINAL_ID` is set, use visible remote execution, inspect owned jobs, and communicate through spider messages or intercom. It explicitly overrides any hc manual advice to send text into pi. A non-Herdr session cannot remove the HC section for another terminal by rewriting that shared global file.

The Herdr terminal section installs five CSI-u bindings. Pi registers the matching shortcuts through pi.registerShortcut, sharing the actual command handler instances. Host composition injects the existing todos, memory, and loop handlers into views.ts. No handler is copied or replaced merely to add a shortcut:

| Herdr key | Pi shortcut | Handler | Bytes |
| --- | --- | --- | --- |
| Cmd-Shift-A | `ctrl+shift+a` | Open agents. | `ESC [97;6u` |
| Cmd-Shift-O | `ctrl+shift+o` | Open todos. | `ESC [111;6u` |
| Cmd-Shift-U | `ctrl+shift+u` | Open usage. | `ESC [117;6u` |
| Cmd-Shift-M | `ctrl+shift+m` | Open pending approvals. | `ESC [109;6u` |
| Cmd-Shift-K | `ctrl+shift+k` | List upcoming triggers. | `ESC [107;6u` |

These are key events, not typed slash commands or Enter. No integration path writes text into a pi terminal's input or calls editor mutation APIs. The existing Herdr Ctrl-V image-paste binding stays unchanged. `ctrl+shift+f` stays reserved for pi's fullscreen search. Unsupported built-in slash commands have no shortcut promise. A supported named pi action can be configured separately. Doctor reports registered-key collisions, including ctrl+shift+o with app.tree.filter.cycleBackward in pi's tree view. That conflict applies only inside the tree view.

## Black glass and Dracula+

Setup clones the current `main` layout and current `agents`, `spaces`, and `pane` mods through `layout.clone` and `mod.clone`. It applies token edits and exact-match patches to those clones. Each patch must find exactly one original anchor or exactly one already-patched marker. Missing or repeated anchors fail before the installed clone is replaced. The same cloned agents mod handles style, remote-job retention, observer filtering, and subagent rows. There is no second agents fork.

The layout is named `spider-glass`. The pi theme is `dracula-plus-glass`. The background is neutral `#161618`. Chrome is transparent, text panes and menus use `#161618f0`, and hover, selected, and active fills use white at 0.07, 0.08, and 0.11. Panes use a 12-pixel radius and an 8-pixel gap. Borders, focus outlines, and shadows are absent. Focus uses a selected header fill. The window ground is Firefox Liquid Fox's 176-degree window tint composited over its inactive fill `rgb(24, 24, 26)`: `#18181a` to `#22201e`. Herdr 0.1.11 paints its window opaque (a transparent root shows the theme background) and exposes neither backdrop blur nor a fade-mask API, so the integration does not claim system vibrancy. `checkGlassContrast` composites every surface and fill over both gradient ends and requires text surfaces at 0.9 alpha or more.

The terminal opacity is zero over the pane background. Pi uses opaque neutral greys for its text-heavy boxes because its theme schema has no alpha. The pi background set is `#161618`, `#202022`, `#242426`, `#262628`, `#29292a`, and `#303031`. Pi's drawn borders remain neutral greys. Text contrast is at least 4.5:1 across those backgrounds. Nondecorative indicators have at least 3:1 on the base. `borderMuted` and `scrollbarTrack` are decorative exceptions.

The ANSI palette remains exact Dracula+:

```text
0 #21222c   1 #ff5555   2 #50fa7b   3 #ffcb6b
4 #82aaff   5 #c792ea   6 #8be9fd   7 #f8f8f2
8 #545454   9 #ff6e6e  10 #69ff94  11 #ffcb6b
12 #d6acff  13 #ff92df 14 #a4ffff  15 #f8f8f2
```

The foreground is `#f8f8f2` and the cursor is `#eceff4`. ANSI colour 0 has 1.14:1 contrast on the base. A palette sample alone does not justify silently changing the requested palette. The acceptance test includes real command diagnostics and preserves ANSI 0 unless a demonstrated readability failure is reviewed. Herdr's existing minimum-contrast preference is retained, not raised without a decision.

Google Sans Flex is bundled for body text. Glass Label Bold is bundled for upright uppercase 16-pixel headings, with weight 700, width 50, ROND 0, and zero letter spacing baked into the font. GPUI exposes family and weight but not the width axis. The modified font is renamed to Glass Label and keeps the original OFL notice and provenance. No Python font tools are needed at setup. Fonts install under the app home's `fonts/` before layout selection. Herdr 0.1.11's `apply_look` calls `load_home_fonts` and loads newly installed paths into its text system, so first setup needs neither an app nor a core restart. Real acceptance starts the app before installing the fonts to prove this activation order.

Paths use Herdr's bundled JetBrains Mono by default. A configured path font and licence path can be copied at setup. The terminal font remains the user's existing choice. This smaller bundled set supplies the requested body and condensed-heading fonts without adding another monospace font. The default path font is already available in Herdr. All optional font data stays outside the repository.

Tests validate the pi theme with pi's actual schema and run the contrast calculation. Mod checks load every installed clone and spider mod with `herdr-app check`. Deferred rows and async states also receive an isolated real-window render test. Screenshots cover narrow and wide layouts, busy and error states, both pi TUI modes, and the ANSI diagnostics.

## Idempotent setup and doctor

The shell entry is node <installed-package>/dist/herdr/cli.mjs setup --config <absolute-user-file>. The package's node CLI owns this command. /herdr-setup <absolute-user-file> only prints that exact shell command and the cutover steps. It never launches a detached installer or calls ctx.shutdown(). The file declares app and core locations, spaces, machine aliases, per-machine nodePath and runtime paths, optional font paths, the shell rc path, and limits. Host configuration exposes herdr.enabled and herdr.config in both the config schema and UI. The repository ships only a placeholder example. Deployment supplies the actual grouping and configured font paths outside the package.

Every file replacement has a verified byte-for-byte backup before the first write. New paths get an absent marker in the backup journal. Setup holds one exclusive lock, records content digests, rejects symlink destinations and unowned name collisions, and uses same-directory atomic writes. A second run with unchanged binaries, configuration, assets, and installed content performs no writes, creates no backup, changes no focus, and launches no duplicate session or viewer.

Setup preflights all assets, model policy, and destination Node versions before changing the shown layout. Initial setup and changed machine configurations get a visible hc run --no-notify version probe using configured nodePath or destination PATH. The journal stores the observed version, node path, and core start identity. An unchanged second setup reuses that verification and launches no probe. A changed node path or restarted core invalidates it. Standalone doctor always repeats the visible probe. Missing or old Node fails with remote-node-unavailable, naming the machine and repair path. Setup first checks for a supported read-only layout export. If none exists, layout.clone switches immediately, so cloning runs in a fenced staging app home with a proved isolated core. If that fallback needs a second app window, setup says a second window will open before opening it. It patches and checks there, then backs up and installs the clones in the target home. It never runs a staging clone command against the live window. A supported app update requires an explicit rebase from current built-ins. Unexpected local edits are conflicts, not content to discard automatically.

The ordered installation covers the following results:

1. Spider's two mods and shared protocol helpers are installed. Current built-in clones receive all style and child-row patches.
2. The layout and Herdr theme are installed and selected only after checks pass. Setup uses `layout.switch {name:"spider-glass"}` and `app.theme {name:"spider-glass"}` so a prior theme-picker override cannot defeat the layout. It backs up the app settings before those commands and preserves unrelated font and zoom settings.
3. The five keys are merged into the existing terminal section. Other sections and Ctrl-V remain unchanged. An owned prior value can be updated. An unowned conflict fails with key-binding-conflict before any write. Only explicit --overwrite-unowned-keys permits replacement after backup. Doctor reports the conflict and the tree-view collision without changing keys.
4. The pi theme is installed, and only the `theme` field changes in the selected agent directory's settings file. Unrelated settings and concurrent edits survive through compare-before-write checks.
5. Role templates are generated from effective user model policy and installed.
6. `notes = false` is set in the selected core's config.toml before fresh pi launches. The installer edits only the root notes key, preserves unrelated TOML, and fails on an ambiguous duplicate. It records old terminal identities and never reuses them during cutover. Reboot resume reuses a restored shell only after a proved core restart. It never restarts the core.
7. The marked resume hook and its launcher are installed in the configured rc file. Repeated setup leaves one block.
8. Versioned runtime assets and local SSH-policy files are installed. Setup verifies their digests and visibly probes each destination's Node version. Configured machines are validated, not added or restarted. Machine measurements use file reads only.
9. The session cutover creates or reuses spaces and leased tabs, then checks their owner feeds.

The setup journal records assets, backups, installed hashes, returned app IDs, and cutover results. A crash resumes at the first incomplete operation. If a target changed after preflight, setup stops rather than overwriting a concurrent edit. Rollback restores only files and structures still matching setup's installed identities. It never closes an unrelated terminal. A failed cutover does not automatically restore old session writers while new ones are live.

Doctor repeats each visible per-machine Node version probe and reports remote-node-unavailable for an unsuitable destination. It checks the version floor and selected core identity, hc JSON parsing, native status contract, feed permissions and freshness, IPC authentication, job reconciliation, observer ownership, runtime digest, cache validity, and bypass stripping. It also checks both spider mods and all three clones, their patch markers and upstream version, layout and theme selection, font availability, pi schema and contrast, keys and collisions, generated role models, notes = false and --no-notify on every launch, one resume block, process presence, session mappings and leases, spaces and tabs, measurement age, and lock-adapter configuration. Every failure names the item and its repair command. Doctor never restarts a core, changes a layout, sends input, or mutates a user database.

## Acceptance and failure coverage

Every capability has an acceptance scenario in the shared suite. The default suite runs the real integration against a fake hc executable, fake app document, test-owned session files, and a fake remote machine. With `SPIDER_HERDR_E2E=1`, the same scenarios drive the real hc binary in isolated local and remote cores. With `SPIDER_HERDR_APP_E2E=1`, they also drive a fenced real app window. The app flag requires the core flag. A requested real mode with missing binaries or unproved isolation fails rather than skips.

vitest.setup.ts deletes every HC_* and HERDR_* variable and prepends test-owned hc and herdr-app stubs that exit nonzero with "real hc is disabled in tests". When SPIDER_TEST_FIXTURE_CHECKOUT is set, createHcClient refuses sockets outside the test root unless the proved harness authorizes them. A guard test exercises the production default path. The harness proves socket and core identities before mutation. It sets isolated HC, XDG, app, pi-agent, and global spider directories. Fixtures use the repository's test utilities. It never opens real user databases. Tests of parent-only behavior explicitly stub `PI_SUBAGENT_CHILD`. The harness closes only its own windows, kills and removes its terminals, removes its fake machine, stops its isolated cores, and proves empty lists and unchanged default-core identity afterward.

The foundation includes the complete isolated harness and one shared data-driven fake. Each test writes scenario JSON containing queued events, replies, delays, file stores, parented terminals, and screen reads. The fake records every argv. Only the foundation owns its executables and testutil.ts. Scrubbed generic real-hc recordings in packages/herdr/src/__tests__/recordings/ cover event NDJSON, get, machine ls, file.read errors, and run replies. A conformance test checks the fake shapes and real parsers against those recordings. Real-mode acceptance refreshes them whenever the hc version changes. Ubuntu CI without hc runs all fake scenarios, conformance checks, and unit tests. Real hc tests are opt-in, not a requirement for an ordinary CI worker to install Herdr. Local release acceptance runs the real modes on the supported baseline before deployment.

| Capability | Required observable result |
| --- | --- |
| Status | Native settle and cache replay remain working with two owned children. Foreign children do not count. Native blocked and error pass through. |
| Job notices | A detached exit-23 job produces one identified notice after reload and leaves the editor draft unchanged. |
| Guidance | Both HC and non-HC sessions receive the same stable managed file. Its effective HC instructions forbid pi-terminal sends. |
| Reboot resume | After a core restart, the restored shell offers the exact saved session. Lease acquisition leaves one terminal and one mapping, with no automatic pi launch. |
| Spaces | Duplicate names refuse ambiguous selection. A live or uncertain writer blocks launch. Closed named sessions reopen in their original cwds, with no duplicate tabs on retry. |
| Templates | Synthetic configured roles start with their resolved provider-qualified model and thinking. No shipped recipe supplies a model ID. |
| Remote execution | The pane exists before a one-line job runs. Separate logs contain all 20,000 output lines and stderr, and the result is the original exit code. Abort, timeout, stdin, quoting, loss, and batch stop retain their semantics. |
| SSH policy | Managed destinations refuse before connection. Other hosts preserve argv and exit status with a valid cache. Cache outage, inherited bypass, nested SSH, and script PATH restoration cannot silently permit a managed route. |
| Subagent views | A real RPC child receives the viewer's steer through its owner's message action. A completed or print-mode child refuses. Transcript controls cannot mutate the parent editor or terminal state. |
| Spider panel | Feed updates change rows and counts. Shared approvals remain shared. One budget threshold produces one shared notice with an open-usage action and no pane focus. |
| Machines panel | Failed reads become stale. An unreadable lock is unknown. Bounded file reads supply Linux load and memory, and non-Linux load is null. Open shell uses returned IDs. |
| Look | Current clones contain the combined patches, every mod checks, both themes load, contrast passes, and a changed patch anchor fails without replacing live assets. |
| Shortcuts | All five CSI-u keys invoke their shared handlers while an exact multibyte draft and cursor position remain unchanged. Ctrl-V and fullscreen search still work. |
| Setup | One command installs every result. A second run has zero writes or launches. Crash recovery, concurrent edits, and failure rollback never create a second session writer. |

## Evidence and remaining question

The design follows the installed contracts and isolated probes, not assumptions about a generic terminal multiplexer. The relevant references are:

- Pi's `dist/modes/interactive/program-status-reporter.js:11-108`, `dist/core/agent-session.js:684-691`, and pi-tui's `dist/terminal.js:195-211,398-403,459-477` establish native ordering and cache replay. The native-setter probe passed 13 assertions against installed pi 1.2.0.
- Pi's `docs/extensions.md`, `docs/tui.md`, `docs/terminal-setup.md`, and `dist/core/extensions/types.d.ts` define widget capture, modes, lifecycle, and shortcut handlers. `examples/extensions/bash-spawn-hook.ts` defines the supported shell-environment hook.
- hc 0.1.16's cross-machine launch probes establish implicit caller parenting, read-only `attach --observe`, bounded finished history, and `finished` versus `lost` events. Its `events.subscribe` contract defines snapshots, missed events, and heartbeat handling. Its [template source](https://github.com/herdrdev/herdr-core/blob/e07c2a1bedd62cf4787ee026ee23ee79c7d95491/crates/herdr-core/src/templates.rs#L178-L180) and `src/api/run.rs:7-33` show why role bodies and native task arguments must stay empty. `src/notes.rs:230-256` reads notes configuration when a delivery task starts but retains that initial value while waiting; cutover terminal identities must therefore be fresh. A proved core restart clears cached tasks before same-address reboot resume.
- Herdr 0.1.11's `herdr.d.ts:13-27,202-222,367-403` defines bounded mod execution, file reads, commands, notification actions, and folder watching. Its app source `src/window.rs:1985-2056` establishes horizontal adoption without changing focus. `src/window.rs:811-816` and `src/settings.rs:758-785` establish new-font loading during look application.
- Spider's `packages/subagents/src/run-store.ts:166-172`, `packages/host/src/session-run-db.ts:10-20`, `packages/subagents/src/actions/message.ts:54-77`, and `packages/context/src/actions/exec.ts:127-157,233-321` define ownership, steering, and output semantics.

A supported pi API for program-status contributions would remove the version-specific method adapter. Is an upstream proposal worth filing after this integration passes acceptance? Filing needs the user's approval. The adapter remains the shipping design until such an API exists.

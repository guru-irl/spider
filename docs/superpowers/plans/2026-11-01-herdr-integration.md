# Herdr integration implementation plan

> For agentic workers: REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking. Each part has one writer in a separate worktree. Review the combined change once, not each task.

Goal: Make every configured pi session, remote command, and subagent view visible in Herdr after one safe setup command.

Architecture: A generic Herdr package owns the clients, external runtimes, status contribution, feeds, viewers, and installer. Host adapters supply pi handlers and session-owned database facts. Context retains language preparation and output shaping, while versioned files and local authenticated IPC connect the processes.

Tech stack: TypeScript, plain JavaScript gpui-kit mods, Node.js built-ins, existing SQLite stores, Vitest, pi 1.2 APIs, hc 0.1.16, and herdr-app 0.1.11. No dependency install.

Spec: [Herdr integration](../specs/2026-11-01-herdr-integration.md). Read both documents before implementation.

## Global constraints

- The supported baseline is Node.js 22.19.0, pi 1.2.0, hc 0.1.16, and herdr-app 0.1.11. Keep package engines >=22.19.0 and test CI on both 22.19.0 and 26.x. Destinations need Node >=22.19.0 through configured absolute nodePath or their PATH.
- No npm dependency is added. Use existing packages and Node built-ins. Never run npm install or npm ci.
- Public artifacts contain only generic configuration and fixtures. User inventories, machine policies, and session paths stay outside the repository.
- Pi remains the only program-status reporter. The adapter contributes owned pending-child state through the native terminal setter.
- The exact status enable predicate is `ctx.mode === "tui" && process.env.PI_SUBAGENT_CHILD !== "1" && Boolean(process.env.HC_TERMINAL_ID)`.
- No integration path writes text into a pi terminal's input or calls editor mutation APIs. Shortcuts send only the five specified CSI-u key events.
- Every spider-issued hc run passes --no-notify. Remote payloads use hc run, never hc exec. Preserve caller HC variables and omit remote --parent. On never falls back to local execution.
- Remote payloads wait for their observer's readiness marker and acknowledged owner-tab pane before release. Read the nonce from the LOCAL observer with hc read, never infer readiness from pane presence. The acknowledgement and destination release deadlines are ten seconds.
- The default limit is two auxiliary panes per tab, configurable from one through six. Remote jobs wait FIFO with a 30-second slot-wait deadline and pane-slot-timeout on expiry. Detached observers release their pane after the tool call returns. Subagent views can be parked without delaying their run.
- Completion comes from the original terminal's finished event and validated runtime receipt. A valid receipt alone settles a job after the finished record expires. Lost, restarted, status, and observer exit are not completion.
- Capture stdout and stderr separately from launch. Transport chunks contain at most 48 KiB of raw data. Foreground capture is capped at 100 MiB and model-facing text at 10,000 bytes.
- Timeout remains milliseconds spent waiting. Background capture without a timeout still waits for the true exit. Detached results have exitCode:null.
- Feed version is 1. A feed is at most 1 MiB. IPC frames are at most 256 KiB, transcript pages at most 64 KiB, and steer text at most 16 KiB.
- A live session feed older than ten seconds is disconnected. Machine samples older than 15 seconds are stale.
- The machine cache refreshes every 30 seconds and is valid for 120 seconds. Enforcement without a valid cache refuses all raw SSH.
- Both the parsed guard and PATH shim are required. Strip inherited administration and lease capabilities before ordinary tools or children run.
- Setup never opens a writer-capable session manager or starts pi --session while the session may have a live writer. Cutover waits until every session file it opens is free. Every pi process records presence, including children and non-HC sessions. Unaccounted same-user pi processes remain blocking.
- Every replacement has a verified backup before writing. Unchanged setup has zero writes, backups, focus changes, or duplicate launches.
- Clone the current main layout and current agents, spaces, and pane mods. One agents clone owns both child kinds and their style. Do not ship frozen built-in copies.
- Ship Google Sans Flex and renamed Glass Label under OFL. Support a configured path font and notice, with bundled JetBrains Mono as the generic fallback.
- HC role templates have empty bodies and no native task arguments. Their commands pass separate absolute instruction paths through pi's --append-system-prompt. Default template names are spider-reviewer, spider-worker, and spider-watcher. No licence comment may become a nonempty template body.
- Keep the exact Dracula+ ANSI palette and neutral pi backgrounds. Text contrast is at least 4.5:1. Nondecorative indicators have at least 3:1.
- Fixtures use @spider/db-core/testutil, repository-managed test directories, and a test-owned SPIDER_GLOBAL_ROOT. No real user DB is opened. Parent-only tests stub PI_SUBAGENT_CHILD explicitly.
- SPIDER_HERDR_E2E=1 selects real isolated hc. SPIDER_HERDR_APP_E2E=1 also selects the fenced app and requires the hc flag. Explicit real mode fails if a binary or isolation proof is missing.

## Review focus

Each condition has a named owning test below.

1. A second writer, an uncertain old pi process, or PID reuse must block cutover before a session opens. G1 and G3.
2. A lost launch reply or a fast finished event must not start the payload twice or turn an observer's exit into command success. D1 and D2.
3. A reset PATH, stale machine cache, or inherited bypass must not quietly route a managed destination through raw SSH. E1 through E3 and C1.
4. A Herdr update, concurrent settings edit, or interrupted setup must preserve the previous usable artifacts and avoid overwriting an unowned file. K1 and L1.
5. A stale IPC generation or a child completing during composer submission must refuse steering without changing the parent draft. B2 and F2.

## Ownership and order

Part A's complete A1 through A3 output is the foundation, including the isolated harness, data-driven shared fakes, production-default test guards, and real-output conformance recordings. Incorporate that verified foundation plus this revised spec and plan before B through L start. No test depends on an unfinished foundation module.

B through K develop against injected ports, not another part's unfinished internals. L develops setup against the same ports in parallel. L's real composition and complete acceptance follow the verified outputs from all parts. A producer's acceptance function stays in its own test-support file under `src/__tests__/acceptance/<part>.ts`. Imports of that file never register a Vitest test. L owns only the assembled scenario wrappers.

| Part | Exclusive responsibility | Dependencies for real acceptance |
| --- | --- | --- |
| A | The Herdr package manifest, licence, contracts, clients, shared feed parser, and common test environment. | None. |
| B | Status, feed, IPC, the host data source, and the scheduler's read-only listing and subscription. | A. |
| C | Context execution preparation and environment injection, remote runtime, transfer, and remote result adapter. | A and D. |
| D | Job journal, event monitor, notice registration, observer program, and shared auxiliary placement actor. | A and C. C and D consume fixed ports and compose together. |
| E | SSH parser, cache, local shim, admin policy, hooks, routing, and final subagent spawn environments. | A. Its owned script-generator test is independent of C. L2 tests C's executor composition. |
| F | The external viewer, composer, and pure host run-transcript adapter with cursor paging. | A, B, and D for composition. The host adapter uses test-owned DBs and files independently. |
| G | Process presence, terminal registry, leases, launcher, shell offer, metadata discovery, and spaces cutover. | A. |
| H | Watcher role policy, templates, shortcuts, injected shared view handlers, and stable managed HC instructions. | A and B's scheduler listing for composition. |
| I | The spider mod and its pure notification/data functions. | A, B, and H. |
| J | Pure machine-file collector and machines mod, using readTextFile(path, {on}). | A. No metrics runtime or C dependency. |
| K | Look patches, one combined agents projection, themes, fonts, and contrast. | A. D and F provide data fixtures for their final scenes. |
| L | Installer, CLI, doctor, host composition, visible config UI, packaging, workflows, docs, and full acceptance. | All parts for final composition. L1, L2, L3, and L4 are separate bounded executions. |

Shared files have one owner. B alone changes `packages/host/src/loop/index.ts`. C alone changes context's executor and exec actions. E alone changes hooks, routing, and child environment construction. H alone changes packages/models/src/pick.ts, the managed AGENTS source, and existing view openers. L alone changes extension.ts, dispatch.ts, control.ts, render-result.ts, root package.json, package-lock.json, host/context package manifests, workflows, build checks, licence notices, and docs indexes. A alone changes vitest.setup.ts, the shared fake executables and testutil.ts, the recordings, the new Herdr package manifest, and its index. Other modules export through subpaths rather than editing that index.

L1 has 90 minutes for installer and doctor work with injected ports. L2 has 90 minutes for real host composition. L3 has 60 minutes for packaging. L4 has 90 minutes for acceptance wrappers and docs. These are separate executions by the same exclusive writer, not a single overloaded 90-minute step. Other producers reserve 30 minutes of their total budgets for composed acceptance after L3. No writer waits for another process to finish within a task.

Each task's file list is the exact write set for that increment. An existing file in that list is modified, and a missing file is created. Later tasks within the same part may deepen an earlier owned file. No other writer may edit it.

## Fixed contracts

### Foundation exports

`packages/herdr/package.json` exports its foundation through `.` and feature modules through `./*`. Its source index exports only A's contracts, parsers, and clients. Add the worktree-local `@spider/herdr` workspace link in that worktree's own node_modules if necessary. Do not link the entire node_modules directory to another worktree.

Language is a type-only import from @spider/context, the authoritative existing language union. A owns the complete types from the spec and these additional contracts in `src/contracts.ts`. ExtensionContext is a type-only import from pi. No foundation runtime imports pi, SQLite, or context:

```typescript
export interface Disposable { dispose(): void | Promise<void> }
export type AcceptanceMode = "fake" | "hc" | "app";
export interface PendingCounts { queued: number; running: number; paused: number }
export interface TestIsolationProof {
	checkout: string;
	sessionNamespace: string;
	coreIds: readonly CoreId[];
	sockets: readonly string[];
}
export interface HcClientOptions {
	isolationProof?: TestIsolationProof;
	binary: string;
	env: Readonly<NodeJS.ProcessEnv>;
	maxReplyBytes?: number;
}
export interface CoreIdentity { coreId: CoreId; socket: string; sessionNamespace: string }
export interface HcClient {
	identity(): Promise<CoreIdentity>;
	caller(env: Readonly<NodeJS.ProcessEnv>): Promise<TerminalIdentity>;
	machines(): Promise<MachineSummary[]>;
	run(request: HcRunRequest): Promise<TerminalHandle>;
	get(address: TerminalAddress): Promise<TerminalSummary>;
	read(address: TerminalAddress, options: { lines: number }): Promise<string>;
	kill(address: TerminalAddress): Promise<void>;
	rm(address: TerminalAddress): Promise<void>;
	fileRead(on: MachineName, path: string): Promise<Buffer>;
	fileWrite(on: MachineName, path: string, bytes: Buffer): Promise<void>;
	events(): HcEventStream;
}
export interface AppClient {
	ownerPlacement(address: TerminalAddress): Promise<OwnerPlacement>;
	awaitPane(viewer: TerminalAddress, owner: OwnerPlacement,
		options: { signal?: AbortSignal; timeoutMs: number }): Promise<PaneId>;
	command(name: string, args: Readonly<Record<string, unknown>>): Promise<AppReply>;
}
export interface OwnerPlacement { space: SpaceId; tab: TabId; pane: PaneId }
export interface UploadedFile { path: string; bytes: Buffer; sha256: string }
export interface PreparedProgram {
	argv: readonly string[];
	cwd: string | null;
	files: readonly UploadedFile[];
	env: Readonly<NodeJS.ProcessEnv>;
}
export type RemoteSource =
	| { kind: "code"; language: Language; code: string }
	| { kind: "file"; language: Language; path: string; code: string };
export interface RuntimeTarget {
	on: MachineName;
	cwd: string | null;
	directory: string;
	commands: Readonly<Record<string, readonly string[]>>;
	environment: Readonly<NodeJS.ProcessEnv>;
	nodePath: string;
	runtimePath: string;
	runtimeSha256: string;
}
export interface RemoteExecuteRequest {
	source: RemoteSource;
	on: MachineName;
	owner: Owner;
	timeout?: number;
	background?: boolean;
	signal?: AbortSignal;
	onData?: (chunk: string) => void;
}
export interface RemoteExecutionPort {
	execute(request: RemoteExecuteRequest): Promise<RemoteResult>;
}
export interface RemoteResult {
	stdout: string;
	stderr: string;
	exitCode: number | null;
	outcome: "exited" | "signal" | "spawn-error" | "aborted" | "timeout" | "unknown";
	signal?: string;
	timedOut: boolean;
	backgrounded?: boolean;
	backgroundJob?: {
		id: string; dir: string; manifest: string; receipt: string;
		logs: { stdout: string; stderr: string };
	};
	backgroundLogs?: { stdout: string; stderr: string };
	aborted?: boolean;
	retained?: boolean;
	retainedReason?: string;
	remote: { jobId: JobId; machine: MachineName; address: TerminalAddress | null };
}
export type ExecutionEnvironmentPolicy =
	(env: Readonly<NodeJS.ProcessEnv>) => Readonly<NodeJS.ProcessEnv>;
export interface JobPort extends Disposable {
	start(program: PreparedProgram, owner: Owner, on: MachineName,
		options: { background?: boolean; signal?: AbortSignal }): Promise<JobHandle>;
	detach(jobId: JobId): Promise<void>;
	toolReturned(jobId: JobId): Promise<void>;
	consumeNotice(jobId: JobId): Promise<void>;
}
export interface JobHandle {
	id: JobId;
	address: TerminalAddress;
	remoteDirectory: string;
	localDirectory: string;
	finished: Promise<TerminalFinish>;
	cancel(reason: "abort" | "timeout" | "viewer-closed" | "shutdown"): Promise<void>;
}
export interface AuxiliaryPanes extends Disposable {
	acquire(kind: "remote" | "subagent", id: JobId | RunId,
		owner: Owner, options: { signal?: AbortSignal; timeoutMs: number }): Promise<PaneReservation | null>;
	release(reservation: PaneReservation): Promise<void>;
	park(runId: RunId): Promise<void>;
}
export interface SessionDataSource extends Disposable {
	snapshot(owner: Owner): Promise<SessionFeed>;
	subscribe(listener: () => void): () => void;
}
export type ViewName = "agents" | "todos" | "usage" | "memory" | "triggers";
export type HerdrViews = Readonly<Record<ViewName,
	(ctx: ExtensionContext) => Promise<void>>>;
```

`HcRunRequest` has argv, cwd, optional on, labels, optional local parent, outliveParent, background, and noNotify:true. The client always emits --no-notify. A remote request has no explicit parent. A null PreparedProgram.cwd omits --cwd and preserves hc's destination-home default. RuntimeTarget.directory is always an absolute private upload path from configuration. A relative remote file requires nonnull configured cwd and otherwise fails before launch. The local owner cwd is never a remote default. `TerminalHandle` has address and coreId. `MachineSummary` has id, name, normalized aliases, state, sessionNamespace, and runtime command configuration. `TerminalSummary` has address, parent, labels, state, status, exitCode, reason, signal, and finishedAt. `HcEventStream` has ready, lookup(address), subscribe(listener), and dispose. Its event union distinguishes snapshots, created, status, finished, lost, restarted, removed, heartbeat, and missed.

`AppClientOptions` has binary and immutable env. `AppReply` carries returned space, tab, pane, terminal, or a typed error. `PaneReservation` carries id, owner, kind, viewer, and acknowledged pane. A subagent reservation can be null when parked. A remote reservation cannot permit launch until it has a pane.

The result structurally matches context's existing ExecResult, including BackgroundJobRef. An abort returns outcome="aborted", exitCode=137, timedOut=false, and aborted=true after confirmed cancellation. A background timeout returns outcome="timeout", exitCode=null, timedOut=true, and backgrounded=true. Signal and spawn-error are known outcomes with null exit codes. Unknown preserves the durable handle without claiming that a receipt will necessarily appear. Foreground timeout cancellation returns timedOut=true and the observed exit or signal outcome. A signal death has outcome="signal", exitCode=null, and its actual signal name. If a payload traps the cancellation signal and exits numerically, retain that actual exit code but still treat timedOut=true as failure. C adds that case to the shared isExecError predicate without classifying detached timeout or unknown as a hard failure. C pins that mapping with parity tests. Never invent SIGKILL when hc observed HUP. It never weakens ExecResult or adds an any cast.

A returned background directory is never deleted automatically. The monitor runs in-process. After pi exits, destination logs grow but local logs and receipt collection wait for the next session_start. There is no external monitor entry, monitor socket, monitor lease, jobFinished IPC operation, or run delegation. Headless child on requests fail with child-remote-unsupported before launch.

New jobs use noticeMode="tool". A finish remains withheld while the waiter exists. consumeNotice acknowledges the tool result before return, and detach makes a background timeout eligible for asynchronous delivery. detach changes notice eligibility only. The registered tool_execution_end handler calls toolReturned(jobId) after the detached tool call returns, releasing its pane while retaining its row and view action. Every startup, resume, and reload reconciles the journal, remote receipts, finished events, and observed spider.job_done messages before delivering missed notices once. A valid nonce-bound digest-checked receipt settles an expired finished record; missing or conflicting evidence remains unknown.

Feed row and notification types have the exact fields specified in the spec. `MachineFeed` has version, coreId, name, revision, updatedAt, connected, load1, load5, load15, cpuPercent, memoryUsedBytes, memoryTotalBytes, and lock. The lock union is unheld, held with owner, or unknown with reason. This is a panel-local model, not a destination feed. revision advances only after successful local collection. Numeric measurements are nullable, and cpuPercent is null because this version reads loadavg and meminfo, not CPU counters. `ChildRow.key` is the job ID or run ID, never a viewer address.

### Registration and producer ports

Every feature registration accepts pi plus injected ports and returns Disposable. It starts long-lived resources only in session_start and releases them in session_shutdown. Options and narrower port types belong to the producing module. Define them there using the following fixed members, not imports from unfinished implementations:

- StatusPorts supplies currentOwner(ctx), listPending(owner), subscribeRuns(owner, listener), and reportDisabled(reason). StatusTerminal is the detected public setProgramStatus terminal. StatusAdapter supplies update(counts) and dispose.
- SessionEndpointPorts supplies currentOwner(), liveCapabilities(), subscribeRun(runId, cursor, emit), steerRun(runId, text), and openView(view). Authenticated ping returns detected capabilities from this activation's actual terminal instance. F3 owns the real cursor-paged transcript source. L2 injects the existing makeMessageHandler and shared view handler instances, bound to current pi context. A caller cannot supply an ExtensionContext. The in-process monitor verifies journal outcomes directly before pi.sendMessage.
- HostDataSourceOptions supplies the exact owner-bound DB resolver, run-event source, readJobJournal(owner), scheduler, usage reader, config reader, and clock. B3 owns notification production from those sources. Its production adapter uses existing stores, not synthetic feeds.
- RemoteExecutionPorts supplies hc, jobs, prepare(source, target), target(on, owner), environmentPolicy, logSink, and clock. JobMonitorOptions supplies hc, app, panes, outputCollector, journalRoot, observedJobMessages, notifier, and clock. The notifier calls the owning pi process directly. Circular C/D implementation imports are unnecessary.
- ObserverPorts supplies hc, app, panes, viewerExecutable, releaseFileWriter, and clock. Readiness requires hc.read of the LOCAL observer address to contain the nonce marker. Both this screen evidence and pane acknowledgement precede release. Releasing a displayed reservation parks the owned terminal and acknowledges pane removal before the viewer exits.
- RoutingPorts supplies policy, environmentPolicy, currentOwner, and local pi bash factories. EnvironmentPolicyOptions supplies local shimDirectory, realSshBinary, cache descriptor, and authorized transport capability handling. Never export the local host's PATH into a remote shell. The remote runtime inherits the destination PATH and strips bypasses. Remote-side SSH shims and per-job alias uploads and refreshes are future work. AdminPolicy supplies allowlisted wrapper identities and an audit sink. The child spawn environment contains no job delegation capability.
- ViewerRegistrationPorts supplies owner(), ownedRunEvents, ipcDescriptor(), panes, hc, and viewerExecutable. ViewerOptions supplies runId, descriptor, and stdout/stdin streams belonging to that external viewer. SteerReply preserves the existing message action's accepted, delivered, queued, delivery, error, and transformed fields.
- SessionRegistrationPorts supplies currentSession(ctx): ProcessPresence, owner(): Owner | null, registry, presence, leases, processIdentity, and launchEnvironment. Presence uses currentSession rather than requiring an HC Owner. Presence records every pi process on session_start, even with no HC or in child mode, and removes its own record on clean shutdown. SessionLaunchPorts supplies leases, processInventory, spawnPi, and mapping publication. Discovery and cutover ports use the same inventory and leased launcher, not another pi opener.
- TemplatePorts supplies effectiveRolePolicy, modelRegistry, templateDirectory, and verified file writer. Resolve effective roles through resolveRoleDefaults; derive thinking from a :level suffix or ROLE_POLICY. A configured unavailable model produces role-unresolved, while omitted roles use the shipped policy. RolePolicy contains resolved role references and effective thinking. RoleTemplateOptions contains piExecutable and per-role absolute instruction paths. RoleTemplates contains the three generated frontmatter-only files and separate per-role instruction-file content. ModelRegistryPort exposes getAll(), getAvailable(), and find(); availability comes from getAvailable() membership. Doctor checks role model/thinking and empty native bodies. FontPorts reads configured font and licence paths and validates the selected font families.
- MachineCollectorOptions supplies configured in-use machines, readTextFile(path, {on}), and clock. The collector is a pure JS asset inside the machines mod. main.js imports it relatively and supplies Herdr's actual readTextFile function. It parses bounded lock and Linux proc-file reads off the UI thread and starts no runtime or terminal.
- SetupParts supplies typed preflight, stageLook, installFiles, generateTemplates, installResume, probeMachineNode, ensureRuntime, cutover, verify, and rollback operations. DoctorParts supplies the corresponding read-only inspectors. L supplies the real functions in final composition.

HerdrConfig contains enabled="auto" or boolean, app/core/agent/global locations, spaces, per-machine aliases and runtime paths, optional fonts, shell rc, limits, retention, and admin policy. Auto activates only for a validated HC caller with installed assets. The user file owns all personal values. Host config keys are herdr.enabled and herdr.config. L2 owns their schema and visible entries in packages/ui/src/screens/config-schema.ts and packages/host/src/ui-thinking.ts. Other defaults come from the typed user-file parser in A's config.ts.

The cloned layout keeps panel-body's existing files and changes children and adds spider and machines. Its dock remains hidden by default at the existing 368-pixel width and 280-to-900-pixel bounds. K patches the cloned spaces header with two buttons that call layout.show for panel and layout.select for the desired panel-body child. I and J provide matching panel tabs and a layout.hide close action. Missing node IDs or repeated anchors fail before replacement. Setup selects both layout.switch and app.theme so a prior picker override cannot defeat the requested theme.

### TDD and acceptance fixtures

In the snippets, h is the local test fixture built over the common HerdrHarness. Arrange each snippet in the owning test file. Feature-specific accessors and fixtures belong to that file, not to production classes or A's common environment. They read actual files, subprocess argv, emitted messages, terminal snapshots, or app documents. They must not synthesize the expected result or declare a feature passed.

A1 creates the initial test-only fake and file fixture before exercising client code. A3 completes the harness before any other part starts. vitest.setup.ts deletes every HC_* and HERDR_* variable and prepends test-owned hc and herdr-app stubs that exit nonzero with "real hc is disabled in tests". createHcClient rejects sockets outside the test root when SPIDER_TEST_FIXTURE_CHECKOUT is set, unless the harness passes its isolation proof. Tests never inherit a live core. Each feature writes its own scenario JSON with queued events, replies, delays, file stores, parented terminals, and screen reads. The fake records every argv. No other part edits fake-hc.mjs, fake-app.mjs, or testutil.ts. The common HerdrHarness supplies clients, owned directories, environment, start(), close(), and resource inventory. It contains no feature logic.

AcceptanceScenario is `(h: HerdrHarness) => Promise<void>`. Each producer exports its tested scenario as `acceptance<Part>(h: HerdrHarness): Promise<void>` from its owned `src/__tests__/acceptance/<part>.ts` support file. Its normal .test.ts file calls the same function. A1 owns the first test-only common fixture. The harness never supplies feature logic. L composes these functions into ten wrapper files with one it() per feature, plus a complete-setup case that checks only shared setup facts. Every named scenario has signature (h: HerdrHarness) => Promise<void>. In acceptance/h.ts, H exports acceptanceGuidance, acceptanceRoles, and acceptanceShortcuts as well as acceptanceH. In acceptance/g.ts, G exports acceptanceResume and acceptanceSpaces as well as acceptanceG. The other producer exports remain acceptanceB through acceptanceK. L's wrapper files only call those producer functions: scenarioStatus calls B; scenarioJobs calls D; scenarioGuidance, scenarioRoles, and scenarioShortcuts call H's corresponding exports; scenarioResume and scenarioSpaces call G's exports; scenarioRemote calls C and D; scenarioSsh calls E; scenarioViewers calls F; scenarioSpiderPanel calls I; scenarioMachinesPanel calls J; scenarioLook calls K. No wrapper swallows a rejected assertion. Default mode is fake. Every scenario runs against the real hc mode when requested. App mode verifies actual rendering and action delivery where an app is required.

Before each production change, write the named failing test and observe its assertion fail for the missing behavior. Test-only arrangement code may be written first. A missing dependency from another part must be incorporated before counting an import failure as red. Implement the smallest change, rerun the file, then deepen the next test. A task's additional cases each receive the same red/green cycle. Never replace an independent expected exit, timestamp, argv, or row owner with the implementation's output.

## Part A: Client and acceptance foundations

### Task A1: Validate hc identity and JSON boundaries

#### Files

- Create or modify `packages/herdr/package.json`.
- Create or modify `packages/herdr/LICENSE`.
- Create or modify `packages/herdr/src/contracts.ts`.
- Create or modify `packages/herdr/src/config.ts`.
- Create or modify `packages/herdr/src/client/hc.ts`.
- Create or modify `packages/herdr/src/client/parse.ts`.
- Create or modify `packages/herdr/src/index.ts`.
- Create or modify `packages/herdr/src/__tests__/testutil.ts`.
- Create or modify `packages/herdr/src/__tests__/fake-hc.mjs`.
- Create or modify `packages/herdr/src/__tests__/fake-app.mjs`.
- Create or modify `vitest.setup.ts`.
- Test `packages/herdr/src/__tests__/client.test.ts`.

#### Interfaces

This task uses Node spawn and the documented hc JSON interface.

It exports `createHcClient(options: HcClientOptions): HcClient`, `parseHerdrConfig(value: unknown): HerdrConfig`, and all fixed contracts.

- [ ] Step 1. Write the failing test `preserves the isolated caller and rejects a foreign socket`. Use the assertions below.

```typescript
	const client = createHcClient({ binary: h.hcBinary, env: h.localEnv });
	expect(await client.identity()).toMatchObject({ sessionNamespace: h.namespace, socket: h.localSocket });
	await expect(client.caller({ ...h.localEnv, HC_TERMINAL_SOCKET: h.foreignSocket })).rejects.toMatchObject({ code: "caller-mismatch" });
```

Add the guard test `production defaults cannot reach an inherited live core`. With SPIDER_TEST_FIXTURE_CHECKOUT set and a foreign socket supplied, expect code test-socket-outside-root and no spawned hc. Spawn production defaults without HC values and expect nonzero exit with "real hc is disabled in tests" from the test-owned stub. Verify all inherited HC_* and HERDR_* names are absent. A proved harness socket remains usable. TestIsolationProof records checkout, namespace, core IDs, and sockets. A3 produces it after isolation checks, and createHcClient validates it before any non-root socket is used. It is not a boolean supplied by user configuration. All label keys and spider.kind values live in contracts.ts, including job, remote-observer, subagent-viewer, and setup-probe kinds. Export a HerdrLabelContract value for setup to serialize into validated mod props. JS projections receive that contract as an argument rather than duplicating labels or importing another part's source.

Add cases for split UTF-8 JSON, nonzero CLI exits, oversized replies, missing hc, relative config roots, and two independent core namespaces. The new package uses subpath exports so later files need no shared-barrel edit. Accept nullable sessionFile and nullable closed ProgramState values; reject arbitrary status strings. SessionPlacement is validated observed metadata, not inferred from a name.

- [ ] Step 2. Run `npm test -- packages/herdr/src/__tests__/client.test.ts`. Expect FAIL on the named behavior before implementation. Fix fixture or import-configuration errors first.

- [ ] Step 3. Implement the produced signatures in the owned files. Spawn argv without a shell. Preserve HC_SESSION and caller variables. Parse stdout and structured stderr separately. Validate lengths, versions, and selected-core identity. Reject missing on machines and a malformed reply. Resolve the workspace link in this worktree only, without installing packages.

- [ ] Step 4. Repeat `npm test -- packages/herdr/src/__tests__/client.test.ts`. Expect PASS for every case in that file. Run the part's acceptance export after its real dependencies are available. Run `npm run typecheck` before committing.

- [ ] Step 5. Check `git status --porcelain` and the required author identity. Stage only the task's owned files and commit the passing change.

```sh
git add packages/herdr/package.json packages/herdr/LICENSE packages/herdr/src/contracts.ts packages/herdr/src/config.ts packages/herdr/src/client/hc.ts packages/herdr/src/client/parse.ts packages/herdr/src/index.ts packages/herdr/src/__tests__/testutil.ts packages/herdr/src/__tests__/fake-hc.mjs packages/herdr/src/__tests__/fake-app.mjs vitest.setup.ts packages/herdr/src/__tests__/client.test.ts
git commit -m "feat: validate hc identity and json boundaries"
```

### Task A2: Consume events and target app IDs

#### Files

- Create or modify `packages/herdr/src/client/events.ts`.
- Create or modify `packages/herdr/src/client/app.ts`.
- Create or modify `packages/herdr/assets/shared/feed.js`.
- Create or modify `packages/herdr/assets/shared/feed.d.ts`.
- Test `packages/herdr/src/__tests__/events.test.ts`.

#### Interfaces

This task uses A1 contracts and client.

It exports `createAppClient(options: AppClientOptions): AppClient`, `HcEventStream`, and pure `parseFeed(text: string): SessionFeed | null` in the shared JS asset.

- [ ] Step 1. Write the failing test `recovers a missed finish without launching again`. Use the assertions below.

```typescript
	const stream = client.events();
	await stream.ready;
	await h.emitCore({ type: "missed", seq: 9, terminals: [h.finishedTerminal("remote/t2", 23)] });
	expect(await stream.lookup(h.address("remote/t2"))).toMatchObject({ state: "finished", exitCode: 23 });
	expect(h.remoteLaunches()).toHaveLength(0);
```

Test duplicate seq, partial records, stale generations, heartbeat timeout, disconnected layout, and an unrelated selected tab. Do not infer completion from status or viewer exit.

- [ ] Step 2. Run `npm test -- packages/herdr/src/__tests__/events.test.ts`. Expect FAIL on the named behavior before implementation. Fix fixture or import-configuration errors first.

- [ ] Step 3. Implement the produced signatures in the owned files. Keep one subscriber, buffer records on LF, reconcile snapshots and sequence numbers, detect the 15-second heartbeat, and resubscribe with bounded backoff. Resolve owner placement from the app document by terminal address and return IDs.

- [ ] Step 4. Repeat `npm test -- packages/herdr/src/__tests__/events.test.ts`. Expect PASS for every case in that file. Run the part's acceptance export after its real dependencies are available. Run `npm run typecheck` before committing.

- [ ] Step 5. Check `git status --porcelain` and the required author identity. Stage only the task's owned files and commit the passing change.

```sh
git add packages/herdr/src/client/events.ts packages/herdr/src/client/app.ts packages/herdr/assets/shared/feed.js packages/herdr/assets/shared/feed.d.ts packages/herdr/src/__tests__/events.test.ts
git commit -m "feat: consume events and target app ids"
```

### Task A3: Provide the dual acceptance environment

#### Files

- Create or modify `packages/herdr/src/__tests__/testutil.ts`.
- Create or modify `packages/herdr/src/__tests__/fake-hc.mjs`.
- Create or modify `packages/herdr/src/__tests__/fake-app.mjs`.
- Create or modify `packages/herdr/src/__tests__/fake-via.mjs`.
- Create or modify `packages/herdr/src/__tests__/isolated.ts`.
- Create or modify `packages/herdr/src/__tests__/scenarios.ts`.
- Create or modify `packages/herdr/src/__tests__/recordings/events.ndjson`.
- Create or modify `packages/herdr/src/__tests__/recordings/get.json`.
- Create or modify `packages/herdr/src/__tests__/recordings/machine-ls.json`.
- Create or modify `packages/herdr/src/__tests__/recordings/file-read-error.json`.
- Create or modify `packages/herdr/src/__tests__/recordings/run.json`.
- Create or modify `packages/herdr/src/__tests__/recordings/version.json`.
- Create or modify `packages/herdr/src/__tests__/conformance.test.ts`.
- Test `packages/herdr/src/__tests__/harness.test.ts`.

#### Interfaces

This task uses A1 and A2 real clients.

It exports `createHerdrHarness(mode: AcceptanceMode): Promise<HerdrHarness>` and `runAcceptance(name: string, scenario: AcceptanceScenario): Promise<void>`.

- [ ] Step 1. Write the failing test `refuses mutation until both cores are proved isolated`. Use the assertions below.

```typescript
	await expect(h.withUnprovedSocket().start()).rejects.toMatchObject({ code: "isolation-unproved" });
	expect(h.mutations()).toEqual([]);
	await h.start();
	expect(h.localCoreId).not.toBe(h.remoteCoreId);
	await h.close();
	expect(await h.remainingOwnedResources()).toEqual([]);
```

The fake is a transport substitute, not the expected-result generator. Its scenario JSON hook supplies queued events, replies, delays, file stores, parented terminals, and screen reads. It supports B's split events, C's destination files and chunk reads, D's finish-before-reply and held adoption, E's machine inventory, F's parented terminals and screen reads, G's restored shells, and J's lock/proc-file stores. Scenario writes belong to each test file. No B through L writer edits the shared fakes or testutil.ts. Every fake invocation records its argv. Add `fake shapes conform to scrubbed real hc recordings` in conformance.test.ts. Check the event, get, machine ls, file.read error, and run shapes and feed them through A's parsers. Corrupt one recorded shape and require an assertion failure. Refresh generic recordings in real mode when the hc version changes; remove private values before committing. Run `npm test -- packages/herdr/src/__tests__/conformance.test.ts` and expect FAIL before parser/fake conformance work, then PASS. A1, A2, and A3 all belong in the verified foundation. Missing binaries with an explicit real-mode flag must fail. Choose short test-owned roots, measure full UTF-8 socket paths, and reject paths above the 103-byte macOS limit before starting a core or IPC endpoint. Cleanup proves both empty cores, no fake machine, no surviving process, and unchanged default-core identity. Disable the organism in test-owned configuration.

- [ ] Step 2. Run `npm test -- packages/herdr/src/__tests__/harness.test.ts`. Expect FAIL on the named behavior before implementation. Fix fixture or import-configuration errors first.

- [ ] Step 3. Implement the produced signatures in the owned files. Use test-owned directories and actual child processes. The fake hc implements the observed JSON, lifecycle, file-transfer, parent, and observer contracts. Real mode starts two isolated cores with a local fake transport and proves socket paths before mutation. Fence app connections before opening a window.

- [ ] Step 4. Repeat `npm test -- packages/herdr/src/__tests__/harness.test.ts`. Expect PASS for every case in that file. Run the part's acceptance export after its real dependencies are available. Run `npm run typecheck` before committing.

- [ ] Step 5. Check `git status --porcelain` and the required author identity. Stage only the task's owned files and commit the passing change.

```sh
git add packages/herdr/src/__tests__/testutil.ts packages/herdr/src/__tests__/fake-hc.mjs packages/herdr/src/__tests__/fake-app.mjs packages/herdr/src/__tests__/fake-via.mjs packages/herdr/src/__tests__/isolated.ts packages/herdr/src/__tests__/scenarios.ts packages/herdr/src/__tests__/recordings/events.ndjson packages/herdr/src/__tests__/recordings/get.json packages/herdr/src/__tests__/recordings/machine-ls.json packages/herdr/src/__tests__/recordings/file-read-error.json packages/herdr/src/__tests__/recordings/run.json packages/herdr/src/__tests__/recordings/version.json packages/herdr/src/__tests__/conformance.test.ts packages/herdr/src/__tests__/harness.test.ts
git commit -m "feat: provide the dual acceptance environment"
```

## Part B: Native status, feeds, and IPC

### Task B1: Contribute native status without a second writer

#### Files

- Create or modify `packages/herdr/src/status/adapter.ts`.
- Create or modify `packages/herdr/src/status/register.ts`.
- Test `packages/herdr/src/__tests__/status.test.ts`.

#### Interfaces

This task uses A1 contracts, exact-owned pending counts, and installed pi-tui.

It exports `installStatusAdapter(terminal: StatusTerminal, counts: PendingCounts): StatusAdapter | DisabledCapability` and `registerHerdrStatusContribution(pi: ExtensionAPI, ports: StatusPorts): Disposable`.

- [ ] Step 1. Write the failing test `native cache replay cannot restore done while owned children run`. Use the assertions below.

```typescript
	const native = await h.installedPiStatus();
	native.reporter.reset();
	const adapter = installStatusAdapter(native.terminal, { running: 2, queued: 0, paused: 0 });
	native.reporter.handleEvent({ type: "agent_settled", aborted: false });
	native.terminal.writeProgramStatus();
	expect(native.lastStatus()).toMatchObject({ state: "working", message: "2 subagents running" });
	adapter.update({ running: 0, queued: 0, paused: 0 });
	expect(native.lastStatus().state).toBe("done");
```

The module contract uses the repository's pi devDependency modules, not an assumed live bundle path. Doctor separately detects the actual live terminal instance because deployed pi may run patched chunks. The installed-module contract must load ProgramStatusReporter, ProcessTerminal, formatProgramStatus, and InteractiveMode's widget/rebind methods. Prove synchronous factory capture and reset ordering. Seed blocked and error before installing, then verify count refresh preserves them; test no cached value without an idle guess. Test the raw-overlay negative control, native dedupe, cached replay, rename, blocked open/close, error, cancellation, queued and paused runs, foreign DB bindings, PI_PROGRAM_STATUS=0, and all five start reasons. A foreign wrapper or unknown installed shape disables cleanly. Snapshot the original own-property descriptor. Restore that descriptor, or delete the installed own wrapper to reveal the original prototype method, only while it is still owned. Test a second install after disposal; do not misclassify a restored native method as a foreign wrapper.

- [ ] Step 2. Run `npm test -- packages/herdr/src/__tests__/status.test.ts`. Expect FAIL on the named behavior before implementation. Fix fixture or import-configuration errors first.

- [ ] Step 3. Implement the produced signatures in the owned files. Capture the terminal synchronously with an empty widget factory. Validate the installed programStatus cache through a boundary adapter and seed the latest native status before wrapping. If no native value exists, wait for the setter rather than guessing idle. Delegate only contributed idle/done values to the original setter. Use the original formatter and cache. Install only with the exact TUI, top-level, HC predicate.

- [ ] Step 4. Repeat `npm test -- packages/herdr/src/__tests__/status.test.ts`. Expect PASS for every case in that file. Run the part's acceptance export after its real dependencies are available. Run `npm run typecheck` before committing.

- [ ] Step 5. Check `git status --porcelain` and the required author identity. Stage only the task's owned files and commit the passing change.

```sh
git add packages/herdr/src/status/adapter.ts packages/herdr/src/status/register.ts packages/herdr/src/__tests__/status.test.ts
git commit -m "feat: contribute native status without a second writer"
```

### Task B2: Publish bounded feeds and authenticate session IPC

#### Files

- Create or modify `packages/herdr/src/feed/publisher.ts`.
- Create or modify `packages/herdr/src/feed/ipc-server.ts`.
- Create or modify `packages/herdr/src/feed/ipc-client.ts`.
- Test `packages/herdr/src/__tests__/feed-ipc.test.ts`.

#### Interfaces

This task uses A1 validated types and A2 shared reader.

It exports `publishSessionFeed(root: string, feed: SessionFeed): Promise<void>`, `startSessionEndpoint(owner: Owner, ports: SessionEndpointPorts): Promise<SessionEndpoint>`, and `createSessionIpcClient(descriptor: IpcDescriptor): SessionIpcClient`.

- [ ] Step 1. Write the failing test `rejects a foreign generation without steering or partial JSON`. Use the assertions below.

```typescript
	const endpoint = await startSessionEndpoint(owner, ports);
	const reply = await h.ipc(endpoint, { op: "steerRun", runId: h.runId, text: "Use the smaller case", generation: h.foreignGeneration });
	expect(reply).toMatchObject({ ok: false, code: "wrong-generation" });
	expect(h.observedSteers()).toEqual([]);
	await publishSessionFeed(root, h.feed(owner));
	expect(await h.readSessionFeed(owner)).toMatchObject({ version: 1, sessionId: owner.sessionId });
```

Pin 1 MiB feeds, 256 KiB frames, 64 KiB transcript pages, 16 KiB steer text, and a 1 MiB pending-output budget. Test symlinks, wrong capabilities, unknown versions, partial writes, disappearing files, gap replay, disconnected clients, and endpoint disposal. No TCP or editor mutation. Test authenticated ping exposing the actual live status-instance result, and no live instance returning status-instance-unavailable rather than inspecting a dist file. Test an owner with no persistent file, a space move without a terminal-ID change, unknown placement, and native visual ordering.

- [ ] Step 2. Run `npm test -- packages/herdr/src/__tests__/feed-ipc.test.ts`. Expect FAIL on the named behavior before implementation. Fix fixture or import-configuration errors first.

- [ ] Step 3. Implement the produced signatures in the owned files. Use per-session atomic writes and user-only permissions. Separate capability files from feeds and labels. Limit operations to run subscription, steering, view opening, and ping. Enforce ownership, frame bounds, cursors, and backpressure before calling an action. Obtain current placement from owner core labels and validated read-only app-layout facts; publish null for unknown names/order. Keep live status and IPC working for nonpersistent sessions.

- [ ] Step 4. Repeat `npm test -- packages/herdr/src/__tests__/feed-ipc.test.ts`. Expect PASS for every case in that file. Run the part's acceptance export after its real dependencies are available. Run `npm run typecheck` before committing.

- [ ] Step 5. Check `git status --porcelain` and the required author identity. Stage only the task's owned files and commit the passing change.

```sh
git add packages/herdr/src/feed/publisher.ts packages/herdr/src/feed/ipc-server.ts packages/herdr/src/feed/ipc-client.ts packages/herdr/src/__tests__/feed-ipc.test.ts
git commit -m "feat: publish bounded feeds and authenticate session ipc"
```

### Task B3: Read owned spider state and expose scheduler changes

#### Files

- Create or modify `packages/host/src/herdr/data-source.ts`.
- Create or modify `packages/host/src/loop/index.ts`.
- Create or modify `packages/herdr/src/__tests__/acceptance/b.ts`.
- Test `packages/herdr/src/__tests__/data-source.test.ts`.

#### Interfaces

This task uses openSessionRunDb, RunStore, todo store, listPending, existing usage queries and computePace.

It exports `createHerdrDataSource(options: HostDataSourceOptions): SessionDataSource`, `SessionScheduler.listTriggers(): TriggerListing[]`, and `SessionScheduler.subscribe(listener: () => void): () => void`.

- [ ] Step 1. Write the failing test `does not attribute global approvals or account budget to a session`. Use the assertions below.

```typescript
	const feed = await source.snapshot(owner);
	expect(feed.approvals.find(a => a.uuid === h.globalApprovalId)).toMatchObject({ scope: "global", ownerSessionId: null });
	expect(feed.pace.scope).toBe("shared");
	expect(feed.runs.rows.map(r => r.id)).toEqual([h.ownedRunId]);
	expect(feed.triggers[0]).toMatchObject({ name: "morning", nextAt: h.nextAt, tz: "UTC" });
```

Add `produces owned run and job notices and shared period thresholds`. Write actual test-owned run escalation and completion events and an atomic finished job journal, then read the source snapshot. Assert escalation and subagent-result notices carry the owning run IDs, and job-result carries the journal job ID. Set periodStart=1000 and usage=80 of budget=100. Assert the budget record is { id: "budget:1000:80", kind: "budget", scope: "shared", sessionId: null, ownerAddress: null, action: { kind: "open-usage" } }. A second session sees the same ID. Duplicate events and repeated snapshots do not create new IDs. Also test the 100 and projected thresholds, a new period, and null budget/projection.

Run and todo reconciliation is two seconds. Usage is at most once per 30 seconds. Feed staleness is ten seconds. Test a bound run DB, a missing usage counter, a null budget, shared approval deduplication, and trigger replacement. Acceptance scenario B covers status, feed freshness, and IPC generation lifecycle.

- [ ] Step 2. Run `npm test -- packages/herdr/src/__tests__/data-source.test.ts`. Expect FAIL on the named behavior before implementation. Fix fixture or import-configuration errors first.

- [ ] Step 3. Implement the produced signatures in the owned files. Build one host adapter over real test-owned DBs. Filter session-owned rows exactly. Use listActive for pending counts and a separate retained-completion query for finished child rows. Derive canSteer from child_mode plus getChild(owner.sessionId, runId)?.steer. Keep shared scope truthful. Produce stable run-event and job-journal notification IDs and shared period-plus-threshold budget IDs; never invent a budget owner. Publish after committed changes and use bounded reconciliation. Expose read-only scheduler state without changing delivery or persistence.

- [ ] Step 4. Repeat `npm test -- packages/herdr/src/__tests__/data-source.test.ts`. Expect PASS for every case in that file. Run the part's acceptance export after its real dependencies are available. Run `npm run typecheck` before committing.

- [ ] Step 5. Check `git status --porcelain` and the required author identity. Stage only the task's owned files and commit the passing change.

```sh
git add packages/host/src/herdr/data-source.ts packages/host/src/loop/index.ts packages/herdr/src/__tests__/acceptance/b.ts packages/herdr/src/__tests__/data-source.test.ts
git commit -m "feat: read owned spider state and expose scheduler changes"
```

## Part C: Remote execution and exact output

### Task C1: Prepare remote language programs before local runtime selection

#### Files

- Create or modify `packages/context/src/remote-plan.ts`.
- Create or modify `packages/context/src/executor.ts`.
- Create or modify `packages/context/src/actions/exec.ts`.
- Test `packages/context/src/__tests__/remote-plan.test.ts`.

#### Interfaces

This task uses A1 contracts. D supplies JobPort at composition time. E supplies the environment function.

It exports `wrapWithFileContent(path: string, language: Language, code: string): string`, `prepareRemoteProgram(input: RemoteSource, target: RuntimeTarget): Promise<PreparedProgram>`, and context constructor options `remote?: RemoteExecutionPort` and `environmentPolicy?: ExecutionEnvironmentPolicy`.

- [ ] Step 1. Write the failing test `reads exec_file only on its destination and never falls back locally`. Use the assertions below.

```typescript
	await h.writeDestinationFile("/work/input.txt", "destination-only value");
	const result = await runExecFile({ path: "/work/input.txt", language: "python", code: "print(FILE_CONTENT.upper())", on: "remote" }, h.execCtx);
	expect(result.content[0].text).toContain("DESTINATION-ONLY VALUE");
	expect(result.details.stdout.trim()).toBe("DESTINATION-ONLY VALUE");
	expect(result.details.remote.machine).toBe("remote");
	expect(h.localPayloadStarts()).toEqual([]);
	await expect(runExec({ language: "shell", code: "echo wrong", on: "missing" }, h.execCtx)).rejects.toMatchObject({ code: "machine-not-found" });
```

Add top-level on?: string to ExecuteOptions. Put the destination file under the fake machine's configured remote cwd, which must differ from the local project root, and pass it to exec_file as a RELATIVE path. Then assert that no recorded hc argv and no file upload contains the file's text, so a planner that reads the file locally and embeds it fails the test. Reuse the same per-language wrapWithFileContent function in local executeFile and prepareRemoteProgram. The wrapper reads the destination path at payload run time; neither route executes the input file itself. Add `local and remote exec_file analysis print the same derived value`, with identical file text and caller code on test-owned local and destination files. Assert exact stdout in both routes. Include file_path and each supported language's existing content binding, with no private wrapper copy. The remote planner never reads the destination file to prepare its analysis code. Shell preparation receives the final shimmed PATH rather than process.env.PATH. All local language and background paths also apply the immutable environment function. Test null remote cwd preserving destination home, an absolute remote file with no configured cwd, and a relative file refusing before launch. Do not weaken unrelated outcome, streaming, or sleep-guard tests.

- [ ] Step 2. Run `npm test -- packages/context/src/__tests__/remote-plan.test.ts`. Expect FAIL on the named behavior before implementation. Fix fixture or import-configuration errors first.

- [ ] Step 3. Implement the produced signatures in the owned files. Select the remote route before local runtime discovery or temporary command creation. Keep language preparation under context licensing. Pass on into exec, exec_file, and every batch entry. Reject per-entry on and preflight the whole batch. Preserve existing output shaping.

- [ ] Step 4. Repeat `npm test -- packages/context/src/__tests__/remote-plan.test.ts`. Expect PASS for every case in that file. Run the part's acceptance export after its real dependencies are available. Run `npm run typecheck` before committing.

- [ ] Step 5. Check `git status --porcelain` and the required author identity. Stage only the task's owned files and commit the passing change.

```sh
git add packages/context/src/remote-plan.ts packages/context/src/executor.ts packages/context/src/actions/exec.ts packages/context/src/__tests__/remote-plan.test.ts
git commit -m "feat: prepare remote language programs before local runtime selection"
```

### Task C2: Execute released argv with exact separate logs

#### Files

- Create or modify `packages/herdr/src/remote/runtime.ts`.
- Create or modify `packages/herdr/src/remote/transfer.ts`.
- Test `packages/herdr/src/__tests__/remote-runtime.test.ts`.

#### Interfaces

This task uses A1 HcClient and PreparedProgram.

It exports `runRemoteRuntime(requestFile: string): Promise<number>` and `collectRemoteChunks(client: HcClient, location: RemoteLogLocation, sink: LogSink): Promise<CollectedLogs>`.

- [ ] Step 1. Write the failing test `a payload that reads stdin gets EOF and exits with exact separate logs`. Use the assertions below.

```typescript
	const job = await h.startRuntime({ argv: [h.nodeBinary, h.echoProgram, "a 'quoted' value"] });
	expect(await job.payloadStarted()).toBe(false);
	await job.release();
	const output = await job.collect();
	expect(output.stdout).toBe("a 'quoted' value\nEOF\n");
	expect(output.stderr).toBe("diagnostic\n");
	expect(output.exitCode).toBe(23);
```

The echoProgram reads stdin to EOF before printing EOF. Add `an owner crash before release expires without starting the payload`: let the destination release deadline pass with no release file, expect release-timeout, and assert no payload output or process. The runtime enforces its own ten-second deadline. Test cancellation before release, signal after release, source digest mismatch, invalid cwd, missing interpreter, UTF-8 split across chunks, binary bytes, a missing chunk, 20,000 lines, and more than 8 MiB of transport data. A 48 KiB raw chunk fits hc file-read bounds. Wrapper readiness text never appears in payload logs.

- [ ] Step 2. Run `npm test -- packages/herdr/src/__tests__/remote-runtime.test.ts`. Expect FAIL on the named behavior before implementation. Fix fixture or import-configuration errors first.

- [ ] Step 3. Implement the produced signatures in the owned files. Wait for the nonce release file without reading stdin. Build a destination-local environment, strip bypasses, and never import the local host PATH. Reuse the versioned digest-checked runtime install. Spawn exact argv with stdin from /dev/null, pipe and mirror stdout/stderr, write durable raw logs and immutable base64 chunks, and publish only complete chunk indexes. Forward signals to the payload group, persist the receipt, then re-raise a terminating signal in the wrapper.

- [ ] Step 4. Repeat `npm test -- packages/herdr/src/__tests__/remote-runtime.test.ts`. Expect PASS for every case in that file. Run the part's acceptance export after its real dependencies are available. Run `npm run typecheck` before committing.

- [ ] Step 5. Check `git status --porcelain` and the required author identity. Stage only the task's owned files and commit the passing change.

```sh
git add packages/herdr/src/remote/runtime.ts packages/herdr/src/remote/transfer.ts packages/herdr/src/__tests__/remote-runtime.test.ts
git commit -m "feat: execute released argv with exact separate logs"
```

### Task C3: Retain context output and waiting semantics remotely

#### Files

- Create or modify `packages/herdr/src/remote/execute.ts`.
- Create or modify `packages/herdr/src/__tests__/acceptance/c.ts`.
- Create or modify `packages/context/src/__tests__/actions-exec.test.ts`.
- Test `packages/herdr/src/__tests__/remote-execute.test.ts`.

#### Interfaces

This task uses C1 preparation, C2 transfer, and D JobPort.

It exports `executeRemote(request: RemoteExecuteRequest, ports: RemoteExecutionPorts): Promise<RemoteResult>` and `createRemoteExecutor(ports: RemoteExecutionPorts): RemoteExecutionPort`.

- [ ] Step 1. Write the failing test `detaches only at a supplied timeout and keeps the true exit unknown`. Use the assertions below.

```typescript
	const detached = await executeRemote(h.remoteRequest({ timeout: 25, background: true }), ports);
	expect(detached).toMatchObject({ exitCode: null, outcome: "timeout", backgrounded: true });
	expect(await h.jobStillRunning(detached.remote.jobId)).toBe(true);
	const waited = await executeRemote(h.remoteRequest({ background: true }), ports);
	expect(waited).toMatchObject({ exitCode: 23, outcome: "exited" });
```

Acceptance scenario C drives on through real registered exec, exec_file, and batch. Test no timeout, foreground timeout cancellation with timedOut=true and the observed signal/exit, a HUP-trapping exit-zero timeout that still reports isError=true, a local foreground HUP-trapping exit-zero timeout with isError=true in actions-exec.test.ts, a neutral detached/unknown result, abort outcome=aborted with exitCode137, Escape mid-batch, 100 ms previews, secret scrubbing, foreground output-cap cancellation, background streaming-cap without cancellation, transport loss, and no local launch after on fails. Keep the existing actions-exec.test.ts:83-95 assertions unchanged. Run `npm test -- packages/context/src/__tests__/actions-exec.test.ts` for the new local regression, observe its expected failure before the shared classifier change, then require PASS. Join D before the real-hc scenario, without adding a placeholder production JobPort.

- [ ] Step 2. Run `npm test -- packages/herdr/src/__tests__/remote-execute.test.ts`. Expect FAIL on the named behavior before implementation. Fix fixture or import-configuration errors first.

- [ ] Step 3. Implement the produced signatures in the owned files. Keep local receipt paths and exact result discriminators. Read only payload streams into context previews. Apply current 100 MiB capture and 10,000-byte text limits at the existing output boundary. Call jobs.detach before returning a background timeout and jobs.consumeNotice before returning a synchronous outcome. Keep detached journals recoverable.

- [ ] Step 4. Repeat `npm test -- packages/herdr/src/__tests__/remote-execute.test.ts`. Expect PASS for every case in that file. Run the part's acceptance export after its real dependencies are available. Run `npm run typecheck` before committing.

- [ ] Step 5. Check `git status --porcelain` and the required author identity. Stage only the task's owned files and commit the passing change.

```sh
git add packages/herdr/src/remote/execute.ts packages/herdr/src/__tests__/acceptance/c.ts packages/context/src/__tests__/actions-exec.test.ts packages/herdr/src/__tests__/remote-execute.test.ts
git commit -m "feat: retain context output and waiting semantics remotely"
```

## Part D: Job lifecycle and pane visibility

### Task D1: Persist job lifecycle and reload-safe notices

#### Files

- Create or modify `packages/herdr/src/jobs/store.ts`.
- Create or modify `packages/herdr/src/jobs/monitor.ts`.
- Create or modify `packages/herdr/src/jobs/register.ts`.
- Test `packages/herdr/src/__tests__/jobs.test.ts`.

#### Interfaces

This task uses A event subscription and C output collection through the fixed callbacks.

It exports `createJobMonitor(options: JobMonitorOptions): JobPort` and `registerHerdrJobs(pi: ExtensionAPI, ports: JobRegistrationPorts): Disposable`.

- [ ] Step 1. Write the failing test `a finish before the launch reply produces one identified detached notice`. Use the assertions below.

```typescript
	const handle = await jobs.start(h.program, owner, h.machine, { background: true });
	await h.finishBeforeLaunchReply(handle.id, 23);
	await jobs.detach(handle.id);
	await h.reloadOwner();
	expect(h.messages("spider.job_done").map(m => m.details.jobId)).toEqual([handle.id]);
	expect(h.messages("spider.job_done")[0].details.exitCode).toBe(23);
	expect(h.editorDraft()).toBe("unfinished draft");
```

Test lost/restarted, missed snapshots, duplicate finish, viewer exit zero with remote exit23, wrapper crash without receipt, shutdown pending notice, disk-write failure, uncertain submission, foreign owner, normal shutdown versus reload, destination logs growing while pi is closed and local logs catching up on the next session_start, receipt-only completion after finished-record expiry, caller-owned background retention, no follow-up before synchronous consumption, explicit async detach, and seven-day foreground cleanup exclusions. Never launch with --rm. Launch with outlive-parent and explicitly cancel foreground work on ordinary shutdown.

- [ ] Step 2. Run `npm test -- packages/herdr/src/__tests__/jobs.test.ts`. Expect FAIL on the named behavior before implementation. Fix fixture or import-configuration errors first.

- [ ] Step 3. Implement the produced signatures in the owned files. Start one in-process monitor on every session_start, including startup, resume, and reload. Remove all external-monitor process, socket, lease, and run-delegation designs. Reconcile the journal, remote receipts, original finished events, and observed transcript notices before delivering missed outcomes. Allocate job IDs before launch, subscribe before spawning, journal phases and notice state atomically, and reconcile labels after uncertain replies. Verify the runtime receipt and cross-check retained original finished events. A valid receipt alone settles an expired record. Notify directly through the owning pi process. Start with noticeMode=tool, withhold a finish while its waiter exists, and consume the notice before a synchronous return. Switch to async only after explicit detach or proved waiter loss.

- [ ] Step 4. Repeat `npm test -- packages/herdr/src/__tests__/jobs.test.ts`. Expect PASS for every case in that file. Run the part's acceptance export after its real dependencies are available. Run `npm run typecheck` before committing.

- [ ] Step 5. Check `git status --porcelain` and the required author identity. Stage only the task's owned files and commit the passing change.

```sh
git add packages/herdr/src/jobs/store.ts packages/herdr/src/jobs/monitor.ts packages/herdr/src/jobs/register.ts packages/herdr/src/__tests__/jobs.test.ts
git commit -m "feat: persist job lifecycle and reload-safe notices"
```

### Task D2: Acknowledge local observer panes before releasing commands

#### Files

- Create or modify `packages/herdr/src/jobs/placement.ts`.
- Create or modify `packages/herdr/src/jobs/observer.ts`.
- Create or modify `packages/herdr/src/__tests__/acceptance/d.ts`.
- Test `packages/herdr/src/__tests__/placement.test.ts`.

#### Interfaces

This task uses A AppClient, real local owner IDs, and C nonce release path.

It exports `createAuxiliaryPanes(options: AuxiliaryPaneOptions): AuxiliaryPanes` and `openRemoteObserver(job: JobRecord, ports: ObserverPorts): Promise<ObserverHandle>`.

- [ ] Step 1. Write the failing test `a one-line job cannot run before its own pane is acknowledged`. Use the assertions below.

```typescript
	const pending = jobs.start(h.oneLineProgram, owner, h.machine, {});
	await h.holdAdoption();
	expect(h.payloadOutput()).toBe("");
	await h.acknowledgeOwnerPane();
	expect(h.releaseWrites()).toEqual([]);
	await h.setLocalObserverScreenToNonce();
	const handle = await pending;
	expect(await h.parentOf(handle.address)).toBe(owner.terminal.address);
	expect(await h.viewerParent(handle.id)).toBeNull();
	expect(h.firstPayloadTime(handle.id)).toBeGreaterThanOrEqual(h.paneAckTime(handle.id));
```

Test app unavailable, fast failure, two-pane capacity, FIFO third job, two detached jobs whose tool_execution_end callbacks release their panes followed by a third short job that runs, 30-second slot-wait expiry returning pane-slot-timeout without launch, parked subagent eviction, owner-tab change, closed observer cancellation, 100-line initial history, simultaneous read-only observers, clipping at the configured headless dimensions, the default 200x120 with an 80x40 observer, no observer resize, and a recovery shell. Keep final output for two seconds, then park the owned terminal, acknowledge pane removal, and let its wrapper exit. Acceptance scenario D verifies original exit and a live pane for a short job.

- [ ] Step 2. Run `npm test -- packages/herdr/src/__tests__/placement.test.ts`. Expect FAIL on the named behavior before implementation. Fix fixture or import-configuration errors first.

- [ ] Step 3. Implement the produced signatures in the owned files. Create a parentless local observe terminal with explicit --no-parent and the owner tab labels. Read the LOCAL observer with hc.read(address, {lines: 100}) and require its nonce marker plus actual app-document membership. A pane with no marker must produce no release write. Pass --no-notify on the observer launch. Release a detached pane after the tool call returns and retain its row and view action. Use native horizontal adoption, no selected-tab assumptions, and a ten-second acknowledgement deadline.

- [ ] Step 4. Repeat `npm test -- packages/herdr/src/__tests__/placement.test.ts`. Expect PASS for every case in that file. Run the part's acceptance export after its real dependencies are available. Run `npm run typecheck` before committing.

- [ ] Step 5. Check `git status --porcelain` and the required author identity. Stage only the task's owned files and commit the passing change.

```sh
git add packages/herdr/src/jobs/placement.ts packages/herdr/src/jobs/observer.ts packages/herdr/src/__tests__/acceptance/d.ts packages/herdr/src/__tests__/placement.test.ts
git commit -m "feat: acknowledge local observer panes before releasing commands"
```

## Part E: SSH routing policy

### Task E1: Classify managed SSH routes with an expiring cache

#### Files

- Create or modify `packages/herdr/src/ssh/parse.ts`.
- Create or modify `packages/herdr/src/ssh/cache.ts`.
- Create or modify `packages/herdr/src/ssh/policy.ts`.
- Test `packages/herdr/src/__tests__/ssh-policy.test.ts`.

#### Interfaces

This task uses A1 hc machine parsing and user aliases.

It exports `parseSshDestinations(argv: readonly string[]): SshDestination[]`, `createMachineCache(options: MachineCacheOptions): MachineCache`, and `createSshPolicy(cache: MachineCache): SshPolicy`.

- [ ] Step 1. Write the failing test `refuses a managed destination before connecting but preserves another host`. Use the assertions below.

```typescript
	const known = await policy.checkArgv(["-p", "2222", "user@remote", "echo", "hidden"]);
	expect(known).toMatchObject({ kind: "refuse", machine: "remote" });
	const other = await h.invokeShim(["user@elsewhere", "echo", "ok"]);
	expect(other).toMatchObject({ exitCode: 17, stdout: "ok\n" });
	expect(h.realSshArgv()).toEqual(["user@elsewhere", "echo", "ok"]);
```

Test a 30-second refresh and 120-second validity window, failed refresh with valid cache, complete outage denying unmatched SSH, previously denied hosts after expiry, a newly registered machine, another core, compound commands, pipelines, ambiguous dynamic hosts, and top-level absolute ssh. Do not use ssh -G.

- [ ] Step 2. Run `npm test -- packages/herdr/src/__tests__/ssh-policy.test.ts`. Expect FAIL on the named behavior before implementation. Fix fixture or import-configuration errors first.

- [ ] Step 3. Implement the produced signatures in the owned files. Parse operands without executing SSH config. Normalize user, URI, port, IPv6, HostName, jump and explicit proxy targets. Key atomic caches by exact core namespace. Preserve argv for non-managed hosts.

- [ ] Step 4. Repeat `npm test -- packages/herdr/src/__tests__/ssh-policy.test.ts`. Expect PASS for every case in that file. Run the part's acceptance export after its real dependencies are available. Run `npm run typecheck` before committing.

- [ ] Step 5. Check `git status --porcelain` and the required author identity. Stage only the task's owned files and commit the passing change.

```sh
git add packages/herdr/src/ssh/parse.ts packages/herdr/src/ssh/cache.ts packages/herdr/src/ssh/policy.ts packages/herdr/src/__tests__/ssh-policy.test.ts
git commit -m "feat: classify managed ssh routes with an expiring cache"
```

### Task E2: Apply one immutable environment to every execution path

#### Files

- Create or modify `packages/herdr/src/ssh/shim.ts`.
- Create or modify `packages/herdr/src/ssh/register.ts`.
- Create or modify `packages/host/src/hooks.ts`.
- Create or modify `packages/host/src/routing/index.ts`.
- Create or modify `packages/subagents/src/pi-args.ts`.
- Create or modify `packages/subagents/src/spawn-default.ts`.
- Test `packages/herdr/src/__tests__/ssh-environment.test.ts`.

#### Interfaces

This task uses E1 policy and an owned test-local script generator receiving the final immutable environment. The real context executor composition belongs to L2, not this test.

It exports `createExecutionEnvironmentPolicy(options: EnvironmentPolicyOptions): ExecutionEnvironmentPolicy` and `registerHerdrRouting(pi: ExtensionAPI, ports: RoutingPorts): Disposable`.

- [ ] Step 1. Write the failing test `a generated shell cannot restore the unshimmed PATH`. Use the assertions below.

```typescript
	const result = await h.runGeneratedShell("ssh remote echo hidden");
	expect(result.exitCode).not.toBe(0);
	expect(h.sshConnections()).toEqual([]);
	expect(result.stderr).toContain("spider exec");
	expect(h.parentPathAfterExecution()).toBe(h.parentPathBeforeExecution());
	expect(h.childEnvironment().SPIDER_HERDR_SSH_BYPASS).toBeUndefined();
```

Use a local script generator defined in ssh-environment.test.ts for the named test. Test the environment function at its public boundary and final spawn argv/environment for allowed bash with enforcement off, user ! commands, subagent spawns, child on refusal without a delegation capability, parallel tools, PATHEXT and Windows path normalization. No job-client descriptor or run delegation is spawned. Strip inherited bypass and lease capabilities from ordinary children and payloads. Failing platform checks disable enforcement with a doctor failure. A parser failure blocks, not passes through.

- [ ] Step 2. Run `npm test -- packages/herdr/src/__tests__/ssh-environment.test.ts`. Expect FAIL on the named behavior before implementation. Fix fixture or import-configuration errors first.

- [ ] Step 3. Implement the produced signatures in the owned files. Prepend after PATH normalization and pass the final immutable environment to the caller's script generator. L2 separately proves the real executor uses that environment after C is composed. Install the tool guard before the bash opt-out and context route. Replace bash through its public spawnHook definition and handle user_bash through public local operations. Apply the final child merge to RPC and print.

- [ ] Step 4. Repeat `npm test -- packages/herdr/src/__tests__/ssh-environment.test.ts`. Expect PASS for every case in that file. Run the part's acceptance export after its real dependencies are available. Run `npm run typecheck` before committing.

- [ ] Step 5. Check `git status --porcelain` and the required author identity. Stage only the task's owned files and commit the passing change.

```sh
git add packages/herdr/src/ssh/shim.ts packages/herdr/src/ssh/register.ts packages/host/src/hooks.ts packages/host/src/routing/index.ts packages/subagents/src/pi-args.ts packages/subagents/src/spawn-default.ts packages/herdr/src/__tests__/ssh-environment.test.ts
git commit -m "feat: apply one immutable environment to every execution path"
```

### Task E3: Authorize only explicit audited administration

#### Files

- Create or modify `packages/herdr/src/ssh/admin.ts`.
- Create or modify `packages/herdr/src/__tests__/acceptance/e.ts`.
- Test `packages/herdr/src/__tests__/ssh-admin.test.ts`.

#### Interfaces

This task uses E1 classification and E2 stripping.

It exports `runHerdrAdmin(request: AdminRequest, policy: AdminPolicy): Promise<AdminResult>`.

- [ ] Step 1. Write the failing test `ordinary jobs cannot inherit an administrative transport bypass`. Use the assertions below.

```typescript
	await h.runAdmin({ wrapper: h.approvedWrapper, reason: "Synchronize runtime", destination: "remote" });
	expect(h.auditRows()).toMatchObject([{ destination: "remote", reason: "Synchronize runtime" }]);
	expect(h.adminTransportEnv().SPIDER_HERDR_SSH_BYPASS).toBe("1");
	expect(h.payloadEnv().SPIDER_HERDR_SSH_BYPASS).toBeUndefined();
	await expect(h.runAdmin({ wrapper: h.otherWrapper, reason: "", destination: "remote" })).rejects.toMatchObject({ code: "admin-not-authorized" });
```

Preflight managed scp/SFTP endpoints, rsync -e/RSYNC_RSH, and explicit Git SSH transports. Never exempt a basename. Preserve HTTPS Git and local copy behavior. Acceptance scenario E proves guards and nested PATH SSH, and explicitly records the nested absolute-path bypass as a policy limitation.

- [ ] Step 2. Run `npm test -- packages/herdr/src/__tests__/ssh-admin.test.ts`. Expect FAIL on the named behavior before implementation. Fix fixture or import-configuration errors first.

- [ ] Step 3. Implement the produced signatures in the owned files. Resolve the trusted wrapper identity before granting the per-operation environment. Audit only owner, wrapper, reason, and destination. Clear capability and bypass values before ordinary payloads and agents.

- [ ] Step 4. Repeat `npm test -- packages/herdr/src/__tests__/ssh-admin.test.ts`. Expect PASS for every case in that file. Run the part's acceptance export after its real dependencies are available. Run `npm run typecheck` before committing.

- [ ] Step 5. Check `git status --porcelain` and the required author identity. Stage only the task's owned files and commit the passing change.

```sh
git add packages/herdr/src/ssh/admin.ts packages/herdr/src/__tests__/acceptance/e.ts packages/herdr/src/__tests__/ssh-admin.test.ts
git commit -m "feat: authorize only explicit audited administration"
```

## Part F: Subagent viewers

### Task F1: Stream a read-only run viewer outside pi

#### Files

- Create or modify `packages/herdr/src/viewers/program.ts`.
- Create or modify `packages/herdr/src/viewers/transcript.ts`.
- Create or modify `packages/herdr/src/viewers/register.ts`.
- Test `packages/herdr/src/__tests__/viewers.test.ts`.

#### Interfaces

This task uses B IPC streams and D AuxiliaryPanes.

It exports `runViewer(options: ViewerOptions): Promise<void>`, `projectTranscript(events: readonly RunViewEvent[]): TranscriptPage`, and `registerHerdrViewers(pi: ExtensionAPI, ports: ViewerRegistrationPorts): Disposable`.

- [ ] Step 1. Write the failing test `reconnects by cursor without replaying transcript terminal controls`. Use the assertions below.

```typescript
	await viewer.connect(h.runId);
	await h.appendRunText("first\n\u001b]7501;state=done\u0007second\n");
	await viewer.reconnect();
	expect(viewer.visibleText()).toBe("first\nsecond\n");
	expect(viewer.rawOutput()).not.toContain("\u001b]7501");
	expect(await h.viewerCount(h.runId)).toBe(1);
```

Test queued, paused, print, error, finished, reconnect gap, multibyte split, child result retention, old owner generation, and two-second exit hold. The viewer program may use pi-tui externally but cannot mount a second renderer inside pi. Acceptance scenario F also verifies a parked run remains visible as a child row.

- [ ] Step 2. Run `npm test -- packages/herdr/src/__tests__/viewers.test.ts`. Expect FAIL on the named behavior before implementation. Fix fixture or import-configuration errors first.

- [ ] Step 3. Implement the produced signatures in the owned files. Create one local parented viewer per full run ID with --no-notify. Read bounded transcript/event pages and sanitize control sequences. Keep the transcript read-only and its composer separate. Reuse terminals for peek actions and park when the strip is full.

- [ ] Step 4. Repeat `npm test -- packages/herdr/src/__tests__/viewers.test.ts`. Expect PASS for every case in that file. Run the part's acceptance export after its real dependencies are available. Run `npm run typecheck` before committing.

- [ ] Step 5. Check `git status --porcelain` and the required author identity. Stage only the task's owned files and commit the passing change.

```sh
git add packages/herdr/src/viewers/program.ts packages/herdr/src/viewers/transcript.ts packages/herdr/src/viewers/register.ts packages/herdr/src/__tests__/viewers.test.ts
git commit -m "feat: stream a read-only run viewer outside pi"
```

### Task F2: Steer only through the current owning message action

#### Files

- Create or modify `packages/herdr/src/viewers/steering.ts`.
- Create or modify `packages/herdr/src/__tests__/acceptance/f.ts`.
- Test `packages/herdr/src/__tests__/viewer-steering.test.ts`.

#### Interfaces

This task uses B endpoint invocation of the real makeMessageHandler and the current RPC-child registry.

It exports `submitViewerSteer(client: SessionIpcClient, runId: RunId, text: string): Promise<SteerReply>`.

- [ ] Step 1. Write the failing test `a completed RPC child refuses a raced composer submission`. Use the assertions below.

```typescript
	await h.completeRpcChild(h.runId);
	const reply = await submitViewerSteer(client, h.runId, "Use case B");
	expect(reply).toMatchObject({ delivery: "refused", accepted: false });
	expect(h.parentEditorText()).toBe("half-written prompt");
	expect(h.childObservedMessages()).toEqual([]);
```

Add a real local RPC child with a test-owned deterministic provider. Assert its persisted conversation contains a successful steer exactly once. Test queued and paused refusals, print-mode refusal, slash-prefixed refusal, wrong owner, dead pipe, broker acceptance versus observed delivery, and draft preservation. No production message-handler rewrite is needed.

- [ ] Step 2. Run `npm test -- packages/herdr/src/__tests__/viewer-steering.test.ts`. Expect FAIL on the named behavior before implementation. Fix fixture or import-configuration errors first.

- [ ] Step 3. Implement the produced signatures in the owned files. Check current capability at submission, call the owning message action, and render its real acknowledgement. Do not write to the child terminal or silently resend uncertainty.

- [ ] Step 4. Repeat `npm test -- packages/herdr/src/__tests__/viewer-steering.test.ts`. Expect PASS for every case in that file. Run the part's acceptance export after its real dependencies are available. Run `npm run typecheck` before committing.

- [ ] Step 5. Check `git status --porcelain` and the required author identity. Stage only the task's owned files and commit the passing change.

```sh
git add packages/herdr/src/viewers/steering.ts packages/herdr/src/__tests__/acceptance/f.ts packages/herdr/src/__tests__/viewer-steering.test.ts
git commit -m "feat: steer only through the current owning message action"
```

### Task F3: Page owned run events and child transcripts from host stores

#### Files

- Create or modify `packages/host/src/herdr/run-transcript.ts`.
- Test `packages/herdr/src/__tests__/run-transcript.test.ts`.

#### Interfaces

This task uses openSessionRunDb, RunStore, committed run events, and child transcript files under test-owned roots.

It exports `createRunTranscriptSource(options: RunTranscriptSourceOptions): RunTranscriptSource`. Its subscribe(runId: RunId, cursor: RunCursor | null, emit: (frame: RunViewFrame) => void): () => void supplies SessionEndpointPorts.subscribeRun.

- [ ] Step 1. Write the failing test `cursor reconnect reads real owned records without replay or foreign data`. Use the assertions below.

```typescript
	await h.writeChildTranscript(h.ownedRunId, "first\nsecond 漢字\n");
	await h.appendCommittedRunEvent(h.ownedRunId, { kind: "completion" });
	const first = await h.readRunPages(source, h.ownedRunId, null, 6);
	const next = await h.readRunPages(source, h.ownedRunId, first.cursor);
	expect(first.text + next.text).toBe("first\nsecond 漢字\n");
	expect(next.events.map(e => e.runId)).toEqual([h.ownedRunId]);
	await expect(h.readRunPages(source, h.foreignRunId, null)).rejects.toMatchObject({ code: "run-not-owned" });
```

Build the source over actual test-owned SQLite records and transcript files, not synthetic feeds. Pin 64 KiB pages, split multibyte records, ordered event cursors, end-of-file append, missing or rotated transcripts producing gap, wrong DB binding, foreign full run IDs, cancelled subscription, and old owner generations. The adapter has no pi UI dependency. F1 and F2 use this source in composed acceptance, while their owned transport tests stay independent.

- [ ] Step 2. Run `npm test -- packages/herdr/src/__tests__/run-transcript.test.ts`. Expect FAIL on the named behavior before implementation. Fix fixture or import-configuration errors first.

- [ ] Step 3. Implement the produced signatures in the owned files. Resolve the exact session-bound DB, validate run ownership, and page committed events plus complete child transcript records. Keep an opaque cursor with event position and transcript byte offset. Preserve partial UTF-8 records across reads and send gap for invalidated cursors. L2 only binds this adapter to the endpoint; it does not implement another transcript source.

- [ ] Step 4. Repeat `npm test -- packages/herdr/src/__tests__/run-transcript.test.ts`. Expect PASS for every case in that file. Run `npm run typecheck` and `git diff --check` before committing.

- [ ] Step 5. Check `git status --porcelain` and the required author identity. Stage only the task's owned files and commit the passing change.

```sh
git add packages/host/src/herdr/run-transcript.ts packages/herdr/src/__tests__/run-transcript.test.ts
git commit -m "feat: page owned run events and child transcripts from host stores"
```

## Part G: Session resume and spaces

### Task G1: Record terminal sessions and acquire leases before pi opens

#### Files

- Create or modify `packages/herdr/src/sessions/registry.ts`.
- Create or modify `packages/herdr/src/sessions/lease.ts`.
- Create or modify `packages/herdr/src/sessions/launcher.ts`.
- Create or modify `packages/herdr/src/sessions/register.ts`.
- Create or modify `packages/herdr/src/sessions/presence.ts`.
- Test `packages/herdr/src/__tests__/sessions.test.ts`.

#### Interfaces

This task uses A identity and config. Existing process-start identity helpers.

It exports `createProcessPresence(root: string): ProcessPresence`, `createTerminalRegistry(root: string): TerminalRegistry`, `createSessionLeases(root: string): SessionLeases`, `assessSessionLiveness(file: string, ports: ProcessInventoryPorts): Promise<SessionLiveness>`, `launchSession(request: SessionLaunchRequest, ports: SessionLaunchPorts): Promise<SessionLaunchResult>`, and `registerHerdrSessions(pi: ExtensionAPI, ports: SessionRegistrationPorts): Disposable`.

- [ ] Step 1. Write the failing test `PID reuse cannot make an occupied session resumable`. Use the assertions below.

```typescript
	await registry.record(owner);
	await h.reusePidWithDifferentStartIdentity(owner.sessionFile);
	expect(await assessSessionLiveness(owner.sessionFile, ports)).toMatchObject({ kind: "uncertain" });
	await expect(launchSession(h.launchRequest(owner), ports)).rejects.toMatchObject({ code: "session-may-be-live" });
	expect(h.openedSessionWriters()).toEqual([]);
```

Test symlink aliases, another core with the same t1, normal exit retention, new/resume/fork mapping replacement, nondefault agent directory, foreign extension path, missing files, identity mismatch, and inherited lease-token stripping. No secrets or model flags enter a mapping. Add `every spider-loading pi process records named presence`: top-level HC, top-level non-HC, disabled integration, and child processes each write PID, start identity, session file/name, mode, and optional hc address on session_start, including reload. Read the actual records and verify clean shutdown removes only that process's entry. Presence is unconditional even where status/feed/map registration is disabled. Test an allocated but unflushed session path without creating its file, and a nonpersistent session with no lease or resume target.

- [ ] Step 2. Run `npm test -- packages/herdr/src/__tests__/sessions.test.ts`. Expect FAIL on the named behavior before implementation. Fix fixture or import-configuration errors first.

- [ ] Step 3. Implement the produced signatures in the owned files. Record one process-presence file before any HC enable predicate, using currentSession even when owner() is null, and remove it on clean shutdown. Write one association per terminal with recordedAt and coreStartedAt, and one lease per canonical file. Claim before launching pi, transfer the token to its process, and verify PID plus start identity before reclaiming. Session change hooks protect supported switches before another writer opens.

- [ ] Step 4. Repeat `npm test -- packages/herdr/src/__tests__/sessions.test.ts`. Expect PASS for every case in that file. Run the part's acceptance export after its real dependencies are available. Run `npm run typecheck` before committing.

- [ ] Step 5. Check `git status --porcelain` and the required author identity. Stage only the task's owned files and commit the passing change.

```sh
git add packages/herdr/src/sessions/registry.ts packages/herdr/src/sessions/lease.ts packages/herdr/src/sessions/launcher.ts packages/herdr/src/sessions/register.ts packages/herdr/src/sessions/presence.ts packages/herdr/src/__tests__/sessions.test.ts
git commit -m "feat: record terminal sessions and acquire leases before pi opens"
```

### Task G2: Install an offered resume function without terminal input

#### Files

- Create or modify `packages/herdr/src/sessions/resume.ts`.
- Create or modify `packages/herdr/assets/shell/resume.sh`.
- Test `packages/herdr/src/__tests__/resume.test.ts`.

#### Interfaces

This task uses G1 registry and launcher.

It exports `buildResumeBlock(options: ResumeHookOptions): string` and `offerResume(identity: TerminalIdentity, ports: ResumePorts): Promise<ResumeOffer | null>`.

- [ ] Step 1. Write the failing test `a restored shell offers the exact session without auto-running it`. Use the assertions below.

```typescript
	await h.runResumeHook(owner.terminal);
	expect(h.shellOutput()).toContain("spider_resume");
	expect(h.piLaunches()).toEqual([]);
	await h.invokeResumeFunction();
	expect(h.piLaunches()[0]).toMatchObject({ cwd: owner.cwd, argv: ["pi", "--session", owner.sessionFile] });
```

Test interactive versus noninteractive shells, absent HC, already-running pi, missing session, names and paths with quotes, a declined offer, and two hook installs. Acceptance scenario G forces loss of a test-owned kept terminal and verifies its same address before invoking the offer. Force a core restart whose start identity is later than the mapping. Assert the resumed owner has the SAME terminal ID and the same session file/name/cwd, with exactly one terminal and one mapping for that session after one reboot. An unproved restart refuses same-address launch. The cached-note regression belongs to cutover's fresh-terminal path in G3, not reboot resume.

- [ ] Step 2. Run `npm test -- packages/herdr/src/__tests__/resume.test.ts`. Expect FAIL on the named behavior before implementation. Fix fixture or import-configuration errors first.

- [ ] Step 3. Implement the produced signatures in the owned files. Use one marked bash/zsh block and an interactive-HC predicate. Print an offer and define the function. The function calls the leased launcher with absolute file and cwd, preserving safe launch environment. After a proved core restart, invoke the leased launcher in the restored shell itself. No extra terminal is created. Reserve the fresh hc run --bg --no-notify --no-parent --outlive-parent path for cutover only.

- [ ] Step 4. Repeat `npm test -- packages/herdr/src/__tests__/resume.test.ts`. Expect PASS for every case in that file. Run the part's acceptance export after its real dependencies are available. Run `npm run typecheck` before committing.

- [ ] Step 5. Check `git status --porcelain` and the required author identity. Stage only the task's owned files and commit the passing change.

```sh
git add packages/herdr/src/sessions/resume.ts packages/herdr/assets/shell/resume.sh packages/herdr/src/__tests__/resume.test.ts
git commit -m "feat: install an offered resume function without terminal input"
```

### Task G3: Create configured spaces only after every old writer exits

#### Files

- Create or modify `packages/herdr/src/spaces/discovery.ts`.
- Create or modify `packages/herdr/src/spaces/setup.ts`.
- Create or modify `packages/herdr/src/spaces/cutover.ts`.
- Create or modify `packages/herdr/assets/config.example.json`.
- Create or modify `packages/herdr/src/__tests__/acceptance/g.ts`.
- Test `packages/herdr/src/__tests__/spaces.test.ts`.

#### Interfaces

This task uses G1 liveness and leases, A app commands and returned IDs.

It exports `discoverSessions(config: HerdrConfig, ports: SessionDiscoveryPorts): Promise<SessionManifest>`, `startCutover(manifest: SessionManifest, ports: CutoverPorts): Promise<CutoverResult>`, and `setupSpaces(config: HerdrConfig, ports: SpaceSetupPorts): Promise<SpaceSetupResult>`.

- [ ] Step 1. Write the failing test `cutover lists names and blocks an unrecorded process before opening files`. Use the assertions below.

```typescript
	const cutover = startCutover(h.tenSessionManifest, ports);
	expect(h.listedLiveSessions()).toContainEqual({ name: "named session", pid: h.recordedPid });
	await h.closeSelectedRecordedSessions();
	expect(h.openedSessionFiles()).toEqual([]);
	expect(h.blockingMessage()).toContain("/reload or close these PIDs");
	await h.recordOrCloseUnknownPi();
	await cutover;
	expect(h.newSessionWriters().map(s => s.sessionId)).toEqual(h.expectedSessionIds);
	await setupSpaces(h.spaceConfig, ports);
	expect(h.tabCount()).toBe(h.expectedSessionIds.length);
```

Test one unrecorded pi process that stays blocking after all selected recorded sessions close. Live recorded unrelated sessions may remain if none of their files is opened. Discovery must use presence for live names and never open a file held by a recorded PID. The pi session that printed /herdr-setup follows the same selected-file rule. Add the cached-native-note regression: cutover uses fresh terminal IDs after notes=false and no queued note reaches the new pi draft. Test closed named sessions, duplicate names resolved by exact ID, shared cwds, unclassified pi, an absent open fd with a live writer, a 30-minute deadline, setup crash after tab creation, wrong-owner name collision, and a failed launch. The example contains placeholders only. Actual grouping remains deployment data outside the repo.

- [ ] Step 2. Run `npm test -- packages/herdr/src/__tests__/spaces.test.ts`. Expect FAIL on the named behavior before implementation. Fix fixture or import-configuration errors first.

- [ ] Step 3. Implement the produced signatures in the owned files. Read latest metadata names without writer-capable SessionManager.open. Refuse ambiguous names and any uncertain pi process. Run from the plain-shell CLI. /herdr-setup only prints the exact command and cutover steps. Wait until every opened file is free, using all process presence and blocking unaccounted PIDs, then create leased tabs in each original cwd and journal IDs.

- [ ] Step 4. Repeat `npm test -- packages/herdr/src/__tests__/spaces.test.ts`. Expect PASS for every case in that file. Run the part's acceptance export after its real dependencies are available. Run `npm run typecheck` before committing.

- [ ] Step 5. Check `git status --porcelain` and the required author identity. Stage only the task's owned files and commit the passing change.

```sh
git add packages/herdr/src/spaces/discovery.ts packages/herdr/src/spaces/setup.ts packages/herdr/src/spaces/cutover.ts packages/herdr/assets/config.example.json packages/herdr/src/__tests__/acceptance/g.ts packages/herdr/src/__tests__/spaces.test.ts
git commit -m "feat: create configured spaces only after every old writer exits"
```

## Part H: Role templates and shortcuts

### Task H1: Generate role templates from effective model policy

#### Files

- Create or modify `packages/herdr/src/templates/generate.ts`.
- Create or modify `packages/herdr/src/templates/register.ts`.
- Create or modify `packages/herdr/assets/templates/role.md`.
- Create or modify `packages/herdr/assets/templates/role-instructions.md`.
- Create or modify `packages/models/src/pick.ts`.
- Modify `packages/ui/src/screens/models-model.ts`: add `"watcher"` to `MODEL_ROLES`, so `control models set watcher <model>` is accepted.
- Modify `packages/host/src/__tests__/model-policy.test.ts` and `packages/host/src/__tests__/models-catalog.test.ts`: add the watcher entry to the exact-match expectations for resolved defaults and sources, and nothing else. Every other assertion stays as it is. Add one case in `model-policy.test.ts` showing that `control models set watcher <model>` is accepted and reported.
- Test `packages/herdr/src/__tests__/templates.test.ts`.

#### Interfaces

This task uses modelDefaultLayers, resolveRoleDefaults, ROLE_POLICY, provider qualification, and registry availability.

It exports `generateRoleTemplates(policy: RolePolicy, registry: ModelRegistryPort, options: RoleTemplateOptions): RoleTemplates` and `registerHerdrTemplates(pi: ExtensionAPI, ports: TemplatePorts): Disposable`.

- [ ] Step 1. Write the failing test `a local role override changes the generated launch without a shipped model`. Use the assertions below.

```typescript
	const templates = generateRoleTemplates(h.effectiveRoles, h.modelRegistry, h.roleTemplateOptions);
	expect(h.parseTemplateCommand(templates.worker).slice(0, 5)).toEqual(["pi", "--model", "test-provider/local-worker", "--thinking", "high"]);
	expect(h.parseTemplateCommand(templates.worker).slice(5)).toEqual(["--append-system-prompt", h.roleInstructionsPath("worker")]);
	expect(h.parseTemplateBody(templates.worker)).toBe("");
	expect(h.parseTemplateCommand(templates.reviewer).slice(0, 5)).toEqual(["pi", "--model", "test-provider/global-reviewer", "--thinking", "high"]);
	const realShape = { models: { defaults: { worker: "test-provider/local-worker", reviewer: "test-provider/global-reviewer" } } };
	const defaults = h.generateWithConfig(realShape);
	expect(h.roleLaunchPairs(defaults)).toEqual([
		["test-provider/local-worker", "high"], ["test-provider/global-reviewer", "high"], ["test-provider/light-watcher", "low"],
	]);
	await expect(h.generateWithUnavailableConfiguredModel()).rejects.toMatchObject({ code: "role-unresolved" });
```

The config fixture has worker and reviewer without thinking suffixes and no watcher. Its catalog supplies three generic eligible models in standard, heavy, and light tiers. Add watcher: { tier: "light", thinking: thinking.low } to ROLE_POLICY in packages/models/src/pick.ts, owned by H. Resolve through resolveRoleDefaults, then take thinking from :level or ROLE_POLICY[role].thinking. Match unqualified configured references through the catalog to qualify them. Reserve role-unresolved for a configured unavailable model. An eligible-catalog failure is catalog-unavailable. Test thinking suffixes, unavailable configured models, quoted executable paths, global/local role merge, nondefault agent directory, and unchanged template output on retry. Acceptance scenario H launches a generated role without extra task arguments in hc with a deterministic test-owned pi provider, checks startup argv, and proves first_message is absent or null and no terminal text was sent. A nonempty-body negative control must demonstrate the forbidden native first-message path without touching any real pi session.

- [ ] Step 2. Run `npm test -- packages/herdr/src/__tests__/templates.test.ts`. Expect FAIL on the named behavior before implementation. Fix fixture or import-configuration errors first.

- [ ] Step 3. Implement the produced signatures in the owned files. Merge the selected project's role map per role and call resolveRoleDefaults over the registry catalog. Add the watcher light/low policy. Check configured pins for availability before automatic fallback can hide an unavailable configured model. Generate command frontmatter with safe argv quoting, provider-qualified model, and explicit thinking. Use a recipe with no model IDs and an empty native template body. Put role instructions in a separate file passed through --append-system-prompt. Use default names spider-reviewer/worker/watcher. Keep managed and licence markers inside frontmatter. Reject unresolved policy before writing.

- [ ] Step 4. Repeat `npm test -- packages/herdr/src/__tests__/templates.test.ts`. Expect PASS for every case in that file. Also run `npm test -- packages/host/src/__tests__/model-policy.test.ts packages/host/src/__tests__/models-catalog.test.ts` and expect PASS, since adding a role to ROLE_POLICY must not leave the combined suite red. Run the part's acceptance export after its real dependencies are available. Run `npm run typecheck` before committing.

- [ ] Step 5. Check `git status --porcelain` and the required author identity. Stage only the task's owned files and commit the passing change.

```sh
git add packages/herdr/src/templates/generate.ts packages/herdr/src/templates/register.ts packages/herdr/assets/templates/role.md packages/herdr/assets/templates/role-instructions.md packages/models/src/pick.ts packages/ui/src/screens/models-model.ts packages/host/src/__tests__/model-policy.test.ts packages/host/src/__tests__/models-catalog.test.ts packages/herdr/src/__tests__/templates.test.ts
git commit -m "feat: generate role templates from effective model policy"
```

### Task H2: Share command openers and stable HC guidance

#### Files

- Create or modify `packages/herdr/src/shortcuts/register.ts`.
- Create or modify `packages/herdr/assets/keys.json`.
- Create or modify `packages/host/src/herdr/views.ts`.
- Create or modify `packages/host/src/agents/agents-ui.ts`.
- Create or modify `packages/host/src/usage/dashboard-command.ts`.
- Create or modify `packages/superpowers/src/agentsmd-content.ts`.
- Create or modify `packages/herdr/src/__tests__/acceptance/h.ts`.
- Test `packages/herdr/src/__tests__/shortcuts.test.ts`.

#### Interfaces

This task uses existing agents and usage openers plus todos, memory, and loop handler instances injected by L2. HostViewOptions receives those instances. Source files owned by B and L remain untouched, and no handler copy is introduced.

It exports `registerHerdrShortcuts(pi: ExtensionAPI, views: HerdrViews): Disposable` and `createHerdrViews(options: HostViewOptions): HerdrViews`.

- [ ] Step 1. Write the failing test `all five CSI-u shortcuts preserve a multibyte draft and cursor`. Use the assertions below.

```typescript
	await h.setEditorDraft("draft 漢字", 6);
	for (const bytes of ["\u001b[97;6u", "\u001b[111;6u", "\u001b[117;6u", "\u001b[109;6u", "\u001b[107;6u"]) await h.pressShortcut(bytes);
	expect(h.openedViews()).toEqual(["agents", "todos", "usage", "memory", "triggers"]);
	expect(h.editorState()).toEqual({ text: "draft 漢字", cursor: 6 });
```

Run installed key-parser and real-TUI draft checks. Preserve Ctrl-V and ctrl+shift+f. Test busy and idle sessions, handler errors, a missing owning session, shortcut collision reporting including ctrl+shift+o versus app.tree.filter.cycleBackward only in pi's tree view, and HC/non-HC managed-block equality. The HC addition is at most 1,000 characters and the whole SPIDER_BLOCK_BODY must remain <=8500. Never raise the existing cap in agentsmd-content.test.ts. Run `npm test -- packages/superpowers/src/__tests__/agentsmd-content.test.ts` and require the unchanged cap assertion to pass. Acceptance scenario H includes all five keys and no editor mutation API.

- [ ] Step 2. Run `npm test -- packages/herdr/src/__tests__/shortcuts.test.ts`. Expect FAIL on the named behavior before implementation. Fix fixture or import-configuration errors first.

- [ ] Step 3. Implement the produced signatures in the owned files. Receive shared todos, memory, and loop handlers by injection from L2; extract only the owned agents and usage openers. Never synthesize slash text or copy an existing handler. Register ctrl+shift+a/o/u/m/k and emit only their CSI-u events in Herdr. Add stable conditional HC guidance to the managed block, not a terminal-dependent file toggle.

- [ ] Step 4. Repeat `npm test -- packages/herdr/src/__tests__/shortcuts.test.ts`. Expect PASS for every case in that file. Run the part's acceptance export after its real dependencies are available. Run `npm run typecheck` before committing.

- [ ] Step 5. Check `git status --porcelain` and the required author identity. Stage only the task's owned files and commit the passing change.

```sh
git add packages/herdr/src/shortcuts/register.ts packages/herdr/assets/keys.json packages/host/src/herdr/views.ts packages/host/src/agents/agents-ui.ts packages/host/src/usage/dashboard-command.ts packages/superpowers/src/agentsmd-content.ts packages/herdr/src/__tests__/acceptance/h.ts packages/herdr/src/__tests__/shortcuts.test.ts
git commit -m "feat: share command openers and stable hc guidance"
```

## Part I: Spider panel

### Task I1: Render session facts and truthful shared approvals

#### Files

- Create or modify `packages/herdr/assets/mods/spider/main.js`.
- Create or modify `packages/herdr/assets/mods/spider/data.js`.
- Create or modify `packages/herdr/assets/mods/spider/data.d.ts`.
- Create or modify `packages/herdr/assets/mods/spider/mod.json`.
- Test `packages/herdr/src/__tests__/spider-panel.test.ts`.

#### Interfaces

This task uses A shared parser, B feed schema, and H view actions via IPC.

It exports the pure function `projectSpiderPanel(feeds: readonly SessionFeed[]): SpiderPanelModel` in data.js.

- [ ] Step 1. Write the failing test `deduplicates shared approvals without inventing an owner`. Use the assertions below.

```typescript
	const rows = projectSpiderPanel([h.feedWithSharedApproval("s1"), h.feedWithSharedApproval("s2")]);
	expect(rows.sharedApprovals).toMatchObject([{ uuid: h.globalApprovalId, ownerSessionId: null }]);
	expect(rows.sharedApprovals).toHaveLength(1);
	expect(rows.sessions.map(s => s.id)).toEqual(["s1", "s2"]);
```

Test malformed/unknown versions, startup watch race, truncated rows with totals, stale versus closed sessions, null credit values, ordered spaces, view action failures, and label-free shared scope. Test an app environment without SPIDER_GLOBAL_ROOT and use validated layout props for feedRoot/CLI/Node/config paths. Install the common decoder inside this mod for relative imports. Acceptance scenario I changes a real feed and checks the rendered row/action in the fenced app.

- [ ] Step 2. Run `npm test -- packages/herdr/src/__tests__/spider-panel.test.ts`. Expect FAIL on the named behavior before implementation. Fix fixture or import-configuration errors first.

- [ ] Step 3. Implement the produced signatures in the owned files. Keep data.js free of gpui-kit imports and give it a declaration partner for typed Node tests. main.js loads and watches only the feed directory, displays timestamped unavailable sources, and routes clicks through the packaged IPC client or explicit pane focus. Use the specified right dock, native scroll, shared panel tabs, close action, and disabled stale actions.

- [ ] Step 4. Repeat `npm test -- packages/herdr/src/__tests__/spider-panel.test.ts`. Expect PASS for every case in that file. Run the part's acceptance export after its real dependencies are available. Run `npm run typecheck` before committing.

- [ ] Step 5. Check `git status --porcelain` and the required author identity. Stage only the task's owned files and commit the passing change.

```sh
git add packages/herdr/assets/mods/spider/main.js packages/herdr/assets/mods/spider/data.js packages/herdr/assets/mods/spider/data.d.ts packages/herdr/assets/mods/spider/mod.json packages/herdr/src/__tests__/spider-panel.test.ts
git commit -m "feat: render session facts and truthful shared approvals"
```

### Task I2: Notify once with truthful session or shared actions

#### Files

- Create or modify `packages/herdr/assets/mods/spider/notifications.js`.
- Create or modify `packages/herdr/assets/mods/spider/notifications.d.ts`.
- Create or modify `packages/herdr/src/__tests__/acceptance/i.ts`.
- Test `packages/herdr/src/__tests__/panel-notifications.test.ts`.

#### Interfaces

This task uses B stable notifications and I1 panel state.

It exports the pure function `selectPanelNotifications(feeds: readonly SessionFeed[], seen: ReadonlySet<string>, now: number): HerdrNotification[]`.

- [ ] Step 1. Write the failing test `a repeated shared budget crossing opens usage without pane focus`. Use the assertions below.

```typescript
	const selected = selectPanelNotifications(h.crossingFeeds, h.emptySeen, h.now);
	expect(selected.map(n => n.id)).toEqual([h.budget80Id]);
	expect(selectPanelNotifications(h.crossingFeeds, new Set([h.budget80Id]), h.now)).toEqual([]);
	expect(selected[0].action).toEqual({ kind: "open-usage", scope: "shared" });
	expect(selected[0].ownerAddress).toBeNull();
```

Test 80 percent, 100 percent, projected-over-budget, a new billing period, null budget, duplicate run events, startup history, reload, and a closed owner. Never refresh animation through timers.

- [ ] Step 2. Run `npm test -- packages/herdr/src/__tests__/panel-notifications.test.ts`. Expect FAIL on the named behavior before implementation. Fix fixture or import-configuration errors first.

- [ ] Step 3. Implement the produced signatures in the owned files. Persist seen IDs per mod copy, seed historical IDs on first load, and notify new result, escalation and budget crossings. Use focus-owner only for session notices. Translate shared open-usage into the existing usage view through a verified live endpoint, never pane focus or invented ownership. Disable the action if no live endpoint exists.

- [ ] Step 4. Repeat `npm test -- packages/herdr/src/__tests__/panel-notifications.test.ts`. Expect PASS for every case in that file. Run the part's acceptance export after its real dependencies are available. Run `npm run typecheck` before committing.

- [ ] Step 5. Check `git status --porcelain` and the required author identity. Stage only the task's owned files and commit the passing change.

```sh
git add packages/herdr/assets/mods/spider/notifications.js packages/herdr/assets/mods/spider/notifications.d.ts packages/herdr/src/__tests__/acceptance/i.ts packages/herdr/src/__tests__/panel-notifications.test.ts
git commit -m "feat: notify once and focus the recorded session"
```

## Part J: Machines panel

### Task J1: Collect machine load and lock facts with bounded file reads

#### Files

- Create or modify `packages/herdr/assets/mods/machines/collector.js`.
- Create or modify `packages/herdr/assets/mods/machines/collector.d.ts`.
- Test `packages/herdr/src/__tests__/machine-metrics.test.ts`.

#### Interfaces

This task uses A contracts and readTextFile(path, {on}) supplied by the Herdr mod boundary.

It exports the pure function `createMachineCollector(options: MachineCollectorOptions): MachineCollector` in collector.js, with its declaration partner for typed tests.

- [ ] Step 1. Write the failing test `an unreadable lock is unknown and measurements start no terminal`. Use the assertions below.

```typescript
	await h.makeLockUnreadable();
	const sample = await collector.sample(h.machine);
	expect(sample.lock).toMatchObject({ state: "unknown" });
	expect(h.remoteReadPaths()).toEqual([h.lockPath, "/proc/loadavg", "/proc/meminfo"]);
	expect(h.remoteReadMachines()).toEqual([h.machine, h.machine, h.machine]);
	expect(h.metricsTerminals()).toEqual([]);
	expect(h.hiddenRemotePayloads()).toEqual([]);
```

Read real test-owned text files through a fake readTextFile transport, and use the shared scenario file stores for composed mode. Test missing lock, malformed JSON owner, disconnected machine, five-second refresh, 15-second stale threshold, failed reads retaining the previous local timestamp, malformed proc values, non-Linux null load, temporary filtering, and stopped-provider profiles. Successful reads are timestamped locally, so no destination clock or runtime revision is needed. Never add or wake machines.

- [ ] Step 2. Run `npm test -- packages/herdr/src/__tests__/machine-metrics.test.ts`. Expect FAIL on the named behavior before implementation. Fix fixture or import-configuration errors first.

- [ ] Step 3. Implement the produced signatures in the owned files. Parse bounded lock, /proc/loadavg, and /proc/meminfo reads in pure functions. The panel supplies readTextFile(path, {on}) off the UI thread. Keep snapshots local to the panel. Delete the metrics-runtime and terminal plan, with no sampler lease or per-machine published runtime file.

- [ ] Step 4. Repeat `npm test -- packages/herdr/src/__tests__/machine-metrics.test.ts`. Expect PASS for every case in that file. Run `npm run typecheck` and `git diff --check` before committing.

- [ ] Step 5. Check `git status --porcelain` and the required author identity. Stage only the task's owned files and commit the passing change.

```sh
git add packages/herdr/assets/mods/machines/collector.js packages/herdr/assets/mods/machines/collector.d.ts packages/herdr/src/__tests__/machine-metrics.test.ts
git commit -m "feat: collect machine load and lock facts with bounded file reads"
```


### Task J2: Show machine ownership and open a real shell

#### Files

- Create or modify `packages/herdr/assets/mods/machines/main.js`.
- Create or modify `packages/herdr/assets/mods/machines/data.js`.
- Create or modify `packages/herdr/assets/mods/machines/data.d.ts`.
- Create or modify `packages/herdr/assets/mods/machines/mod.json`.
- Create or modify `packages/herdr/src/__tests__/acceptance/j.ts`.
- Test `packages/herdr/src/__tests__/machines-panel.test.ts`.

#### Interfaces

This task uses J1 file-read measurements, native machines/terminals, and A app commands.

It exports the pure function `projectMachinesPanel(feeds: readonly MachineFeed[], terminals: readonly TerminalSummary[]): MachinePanelModel[]` in data.js.

- [ ] Step 1. Write the failing test `open shell targets the selected machine using returned IDs`. Use the assertions below.

```typescript
	const model = projectMachinesPanel(h.machineFeeds, h.terminals);
	expect(model[0].jobs[0]).toMatchObject({ owner: h.ownerAddress, kind: "exec" });
	await h.clickMachineShell(model[0]);
	expect(h.openedShell()).toMatchObject({ machine: "remote", space: h.returnedSpace, terminal: h.returnedTerminal });
	expect(h.hiddenShellStarts()).toEqual([]);
```

Test unavailable layouts, local machine name null, closed shell, user-configured cwd with quotes, jobs by system/unknown owner, and no duplicate shell from a repeated pending click. Run herdr-app check and a real-window async render.

- [ ] Step 2. Run `npm test -- packages/herdr/src/__tests__/machines-panel.test.ts`. Expect FAIL on the named behavior before implementation. Fix fixture or import-configuration errors first.

- [ ] Step 3. Implement the produced signatures in the owned files. Use gpui-kit only in main.js. Import ./collector.js there and pass Herdr's readTextFile(path, {on}) directly. Show timestamps for stale data, unknown owners, and locks honestly, and use space.new or tab.new for a visible shell. Focus only the returned IDs.

- [ ] Step 4. Repeat `npm test -- packages/herdr/src/__tests__/machines-panel.test.ts`. Expect PASS for every case in that file. Run the part's acceptance export after its real dependencies are available. Run `npm run typecheck` before committing.

- [ ] Step 5. Check `git status --porcelain` and the required author identity. Stage only the task's owned files and commit the passing change.

```sh
git add packages/herdr/assets/mods/machines/main.js packages/herdr/assets/mods/machines/data.js packages/herdr/assets/mods/machines/data.d.ts packages/herdr/assets/mods/machines/mod.json packages/herdr/src/__tests__/acceptance/j.ts packages/herdr/src/__tests__/machines-panel.test.ts
git commit -m "feat: show machine ownership and open a real shell"
```

## Part K: Look and current-clone patches

### Task K1: Patch one current agents clone for style and both child kinds

#### Files

- Create or modify `packages/herdr/src/look/patches.ts`.
- Create or modify `packages/herdr/src/look/layout.ts`.
- Create or modify `packages/herdr/assets/agents/children.js`.
- Create or modify `packages/herdr/assets/agents/children.d.ts`.
- Create or modify `packages/herdr/assets/look/patches.json`.
- Create or modify `packages/herdr/assets/look/layout-edits.json`.
- Test `packages/herdr/src/__tests__/look-patches.test.ts`.

#### Interfaces

This task uses A shared protocol, all label keys and spider.kind values from contracts.ts, and typed job/run feed fixtures. It does not read another part's implementation to discover label strings.

It exports `applyLookPatches(clones: HerdrClones, patches: LookPatchSet): PatchedClones`, `buildGlassLayout(currentMain: unknown, names: CloneNames): GlassLayout`, and pure `projectAgentChildren(terminals, feeds, ownerAddress, labelContract: HerdrLabelContract): ChildRow[]`.

- [ ] Step 1. Write the failing test `a moved upstream anchor fails without replacing the installed clone`. Use the assertions below.

```typescript
	const before = await h.installedCloneBytes();
	await expect(applyLookPatches(h.cloneWithMovedAnchor, h.patchSet)).rejects.toMatchObject({ code: "patch-anchor-mismatch" });
	expect(await h.installedCloneBytes()).toEqual(before);
	const rows = projectAgentChildren(h.liveTerminals, h.feeds, h.ownerAddress, h.labelContract);
	expect(rows.map(r => r.key)).toEqual([h.remoteJobId, h.subagentRunId]);
```

Test duplicate anchors, already-patched markers, modified user clone, an app update, finished terminal removed, status replay, moved session with original parent, row deduplication, 24-hour/50-row retention, and error folded to blocked in the app API. Do not copy frozen built-in mods into the package.

- [ ] Step 2. Run `npm test -- packages/herdr/src/__tests__/look-patches.test.ts`. Expect FAIL on the named behavior before implementation. Fix fixture or import-configuration errors first.

- [ ] Step 3. Implement the produced signatures in the owned files. Clone current built-ins at setup, then apply exact-match idempotent patches. Keep panel-body files/changes and add spider/machines. Patch the spaces header with the two dock buttons, using layout.show/select. One agents clone filters remote observers and top-level subagent-viewer duplicates, preserves native live children, and merges retained job/run rows. Patch its existing tree once.

- [ ] Step 4. Repeat `npm test -- packages/herdr/src/__tests__/look-patches.test.ts`. Expect PASS for every case in that file. Run the part's acceptance export after its real dependencies are available. Run `npm run typecheck` before committing.

- [ ] Step 5. Check `git status --porcelain` and the required author identity. Stage only the task's owned files and commit the passing change.

```sh
git add packages/herdr/src/look/patches.ts packages/herdr/src/look/layout.ts packages/herdr/assets/agents/children.js packages/herdr/assets/agents/children.d.ts packages/herdr/assets/look/patches.json packages/herdr/assets/look/layout-edits.json packages/herdr/src/__tests__/look-patches.test.ts
git commit -m "feat: patch one current agents clone for style and both child kinds"
```

### Task K2: Ship validated neutral themes and the smaller font set

#### Files

- Create or modify `packages/herdr/assets/themes/spider-glass.json`.
- Create or modify `packages/herdr/assets/themes/dracula-plus-glass.json`.
- Create or modify `packages/herdr/assets/fonts/GoogleSansFlex.ttf`.
- Create or modify `packages/herdr/assets/fonts/GlassLabel-Bold.ttf`.
- Create or modify `packages/herdr/assets/fonts/GoogleSansFlex-OFL.txt`.
- Create or modify `packages/herdr/assets/fonts/GoogleSansFlex-TRADEMARKS.md`.
- Create or modify `packages/herdr/src/look/contrast.ts`.
- Create or modify `packages/herdr/src/look/fonts.ts`.
- Create or modify `packages/herdr/src/__tests__/acceptance/k.ts`.
- Test `packages/herdr/src/__tests__/look-theme.test.ts`.

#### Interfaces

This task uses Finished look generators as reference input, pi installed schema, and OFL originals.

It exports `checkThemeContrast(theme: PiThemeData): ContrastReport` and `prepareFonts(config: FontConfig, ports: FontPorts): Promise<FontAssets>`.

- [ ] Step 1. Write the failing test `both themes preserve neutral backgrounds and readable pi roles`. Use the assertions below.

```typescript
	const theme = await h.loadPiThemeWithInstalledValidator("dracula-plus-glass");
	expect(checkThemeContrast(theme)).toMatchObject({ failures: [] });
	expect(h.herdrTheme().background).toBe("#161618");
	expect(h.herdrTheme().ansi[0]).toBe("#21222c");
	expect(await h.fontFamilies()).toEqual(expect.arrayContaining(["Google Sans Flex", "Glass Label"]));
```

Pin all sixteen Dracula+ colours and the spec's neutral boxes, text ratio4.5 and nondecorative ratio3. Validate theme schema and variable references. Test an unreadable optional font, font name-table provenance, no generator/tool install at setup, and the actual ANSI diagnostic. Acceptance scenario K checks all five mods, deferred rows, both pi TUI modes, and fenced screenshots. Start the app before copying fonts; selecting the look must load them through native load_home_fonts with no restart.

- [ ] Step 2. Run `npm test -- packages/herdr/src/__tests__/look-theme.test.ts`. Expect FAIL on the named behavior before implementation. Fix fixture or import-configuration errors first.

- [ ] Step 3. Implement the produced signatures in the owned files. Copy only the generic generated themes and the two approved OFL fonts. Preserve licence/trademark metadata and renamed Glass Label names. Default code paths to bundled JetBrains Mono, keep terminal font unchanged, and allow optional user-provided monospace/font-notice paths.

- [ ] Step 4. Repeat `npm test -- packages/herdr/src/__tests__/look-theme.test.ts`. Expect PASS for every case in that file. Run the part's acceptance export after its real dependencies are available. Run `npm run typecheck` before committing.

- [ ] Step 5. Check `git status --porcelain` and the required author identity. Stage only the task's owned files and commit the passing change.

```sh
git add packages/herdr/assets/themes/spider-glass.json packages/herdr/assets/themes/dracula-plus-glass.json packages/herdr/assets/fonts/GoogleSansFlex.ttf packages/herdr/assets/fonts/GlassLabel-Bold.ttf packages/herdr/assets/fonts/GoogleSansFlex-OFL.txt packages/herdr/assets/fonts/GoogleSansFlex-TRADEMARKS.md packages/herdr/src/look/contrast.ts packages/herdr/src/look/fonts.ts packages/herdr/src/__tests__/acceptance/k.ts packages/herdr/src/__tests__/look-theme.test.ts
git commit -m "feat: ship validated neutral themes and the smaller font set"
```

## Part L: Setup, host composition, packaging, and acceptance

### Task L1: Install every artifact transactionally and report doctor checks

#### Files

- Create or modify `packages/herdr/src/setup/installer.ts`.
- Create or modify `packages/herdr/src/setup/backup.ts`.
- Create or modify `packages/herdr/src/setup/doctor.ts`.
- Create or modify `packages/herdr/src/setup/cli.ts`.
- Test `packages/herdr/src/__tests__/setup.test.ts`.

#### Interfaces

This task uses A fixed setup ports and B through K registration/artifact outputs at composition time.

It exports `setupHerdr(request: SetupRequest, parts: SetupParts): Promise<SetupResult>`, `doctorHerdr(request: DoctorRequest, parts: DoctorParts): Promise<DoctorReport>`, and `runHerdrCli(argv: readonly string[]): Promise<number>`.

- [ ] Step 1. Write the failing test `a second setup writes nothing and preserves unrelated settings`. Use the assertions below.

```typescript
	await setupHerdr(h.setupRequest, parts);
	const baseline = await h.installedHashes();
	await setupHerdr(h.setupRequest, parts);
	expect(await h.installedHashes()).toEqual(baseline);
	expect(h.secondRunWrites()).toEqual([]);
	expect(h.secondRunLaunches()).toEqual([]);
	expect(h.piSettings().unrelated).toBe("keep");
	expect((await doctorHerdr(h.doctorRequest, parts)).failures).toEqual([]);
```

Test crash before/after each write, a concurrent settings edit, duplicate TOML notes key, destination symlink, unowned key conflict refusing before writes unless --overwrite-unowned-keys is explicit, unowned clone collision, read-only layout export preference, staging clone isolation with a second-window warning before opening, plain-shell cutover, rollback matching only installed identities, and an unavailable role. Supply validated mod props, including the canonical label contract from A's contracts.ts, and copy the one shared decoder into every consuming mod, plus spider-children.js into the agents clone. Copy fonts before layout.switch/app.theme. Doctor checks every spec item without mutations except its explicit visible per-machine Node version probes. Probe each configured nodePath or node from destination PATH against >=22.19.0; missing or old Node reports remote-node-unavailable with machine and repair. Persist the initial Node version, node path, and core start identity. An unchanged second setup reuses that observation and launches no probe. A changed path or restarted core invalidates it. Standalone doctor repeats the visible probe. Verify one versioned runtime install by digest and no reupload per job. Check --no-notify on every launch and notes = false independently, with launch-notify-enabled and native-notes-enabled failures. Report the contextual tree-view collision separately from unowned keys that block installation. Doctor reads the live status-terminal capability through authenticated session ping, never a dist file. An absent live instance reports status-instance-unavailable. Fixture parts use real files and fake external clients, never silent no-op implementations. Write notes=false before fresh owners, record existing terminal identities in the private journal, and prove no fresh launch reuses them; a pending native note task is not cancelled merely by the config write.

- [ ] Step 2. Run `npm test -- packages/herdr/src/__tests__/setup.test.ts`. Expect FAIL on the named behavior before implementation. Fix fixture or import-configuration errors first.

- [ ] Step 3. Implement the produced signatures in the owned files. Use exclusive setup ownership, verified prewrite backups, atomic compare-before-write updates, a restart journal, and read-only layout export when supported. Otherwise warn before a second app window and use staged isolated cloning. The /herdr-setup pi handler only prints node <installed-package>/dist/herdr/cli.mjs setup --config <absolute-user-file> and cutover steps, with no detached launch or shutdown call. Install mods, layout/theme, keys, pi theme selection, generated roles, notes=false, rc hook, versioned runtime and local cache, file-read measurement configuration, and leased spaces in the spec order.

- [ ] Step 4. Repeat `npm test -- packages/herdr/src/__tests__/setup.test.ts`. Expect PASS for every case in that file. Run the part's acceptance export after its real dependencies are available. Run `npm run typecheck` before committing.

- [ ] Step 5. Check `git status --porcelain` and the required author identity. Stage only the task's owned files and commit the passing change.

```sh
git add packages/herdr/src/setup/installer.ts packages/herdr/src/setup/backup.ts packages/herdr/src/setup/doctor.ts packages/herdr/src/setup/cli.ts packages/herdr/src/__tests__/setup.test.ts
git commit -m "feat: install every artifact transactionally and report doctor checks"
```

### Task L2: Compose host registrations and existing handlers

#### Files

- Create or modify `packages/host/src/herdr/mount.ts`.
- Create or modify `packages/host/src/herdr/ports.ts`.
- Create or modify `packages/host/src/extension.ts`.
- Create or modify `packages/host/src/dispatch.ts`.
- Create or modify `packages/host/src/control.ts`.
- Create or modify `packages/host/src/render-result.ts`.
- Create or modify `packages/host/src/ui-thinking.ts`.
- Create or modify `packages/ui/src/screens/config-schema.ts`.
- Test `packages/host/src/__tests__/herdr-wiring.test.ts`.

#### Interfaces

This task uses all verified registration exports, F3 run-transcript source, existing makeMessageHandler, command instances, config precedence, and rendering contracts.

It exports `mountHerdr(pi: ExtensionAPI, options: HostHerdrOptions): HerdrMount` and `createHostHerdrPorts(options: HostPortOptions): HostHerdrPorts`.

- [ ] Step 1. Write the failing test `composed host calls real transcript and command ports without editor input`. Use the assertions below.

```typescript
	await h.startRegisteredOwner();
	await h.appendOwnedChildTranscript("observed text\n");
	expect(await h.subscribeRunThroughEndpoint()).toContain("observed text");
	await h.openEveryViewThroughEndpoint();
	expect(h.observedCommandHandlers()).toEqual(["agents", "todos", "usage", "memory", "triggers"]);
	await h.completeOwnedRpcChild();
	expect(await h.steerThroughEndpoint("next case")).toMatchObject({ delivery: "refused" });
	expect(h.editorDraft()).toBe("unfinished draft");
```

This execution has a separate 90-minute budget after the producers are composed. Test startup, reload, new, resume, fork, no HC, top-level modes, child-disabled status/feed/map, unconditional child and non-HC presence, child on refusal, and registration disposal. Verify in-process journal outcomes before pi.sendMessage with no jobFinished socket. Inject the actual todos, memory, and loop handlers into H's views.ts. Test config UI entries herdr.enabled and herdr.config. Add `the real executor cannot restore unshimmed PATH`, running C's real generated shell with E's environment policy and asserting refusal plus no SSH connection. Add `every composed spider hc run disables native notes`: exercise every launch family, require a nonempty argv log, filter recorded hc run invocations, and assert every one includes --no-notify. A scenario omitting the flag must fail that assertion.

- [ ] Step 2. Run `npm test -- packages/host/src/__tests__/herdr-wiring.test.ts`. Expect FAIL on the named behavior before implementation. Fix fixture or import-configuration errors first.

- [ ] Step 3. Implement the produced signatures in the owned files. Wire one activation, in-process monitor, and auxiliary placement actor. Bind F3 subscribeRun, the existing makeMessageHandler, and shared openView instances to current context. Wire remote execution, environment policy, schema forwarding, and job rendering. Register doctor and the print-only setup hint. Expose herdr.enabled=auto and herdr.config through schema and config UI. Make no packaging edits in this execution.

- [ ] Step 4. Repeat `npm test -- packages/host/src/__tests__/herdr-wiring.test.ts`. Expect PASS for every case in that file. Run `npm run typecheck` and `git diff --check` before committing.

- [ ] Step 5. Check `git status --porcelain` and the required author identity. Stage only the task's owned files and commit the passing change.

```sh
git add packages/host/src/herdr/mount.ts packages/host/src/herdr/ports.ts packages/host/src/extension.ts packages/host/src/dispatch.ts packages/host/src/control.ts packages/host/src/render-result.ts packages/host/src/ui-thinking.ts packages/ui/src/screens/config-schema.ts packages/host/src/__tests__/herdr-wiring.test.ts
git commit -m "feat: compose host registrations and existing handlers"
```

### Task L3: Package explicit runtime entries and baseline CI

#### Files

- Create or modify `packages/host/package.json`.
- Create or modify `packages/context/package.json`.
- Create or modify `package.json`.
- Create or modify `package-lock.json`.
- Create or modify `vite.herdr.config.mjs`.
- Create or modify `scripts/build-herdr.mjs`.
- Create or modify `scripts/assert-bundle.mjs`.
- Create or modify `.github/workflows/ci.yml`.
- Create or modify `.github/workflows/release.yml`.
- Create or modify `NOTICE.md`.
- Create or modify `LICENSE`.
- Test `packages/herdr/src/__tests__/packaging.test.ts`.

#### Interfaces

This task uses the verified host composition, A package manifest, installed asset contracts, and existing packaging checks.

It exports `buildHerdrEntries(): Promise<void>` in scripts/build-herdr.mjs and the updated package allowlists and workflow checks.

- [ ] Step 1. Write the failing test `the packed package contains three runtimes and assets without frozen mods`. Use the assertions below.

```typescript
	const packed = await h.buildAndInspectPackage();
	expect(packed.files).toEqual(expect.arrayContaining(["dist/herdr/cli.mjs", "dist/herdr/viewer.mjs", "dist/herdr/remote-runtime.mjs", "packages/herdr/assets/themes/dracula-plus-glass.json"]));
	expect(packed.files).not.toContain("dist/herdr/metrics-runtime.mjs");
	expect(packed.frozenBuiltinMods).toEqual([]);
	expect(packed.remoteNonBuiltinImports).toEqual([]);
```

This execution has a separate 60-minute budget. Keep engines >=22.19.0 and make CI test Node 22.19.0 and 26.x with the same fake conformance and acceptance scenarios. Both workflows inspect the same explicit tarball contents. Exclude test files, recordings, declaration-only assets, user configuration, and frozen built-in mods. Herdr setup is explicit, never postinstall. Update workspace lock metadata without npm install, npm ci, new external dependencies, or changed registry URLs.

- [ ] Step 2. Run `npm test -- packages/herdr/src/__tests__/packaging.test.ts`. Expect FAIL on the named behavior before implementation. Fix fixture or import-configuration errors first.

- [ ] Step 3. Implement the produced signatures in the owned files. Build exactly cli.mjs, viewer.mjs, and built-in-only remote-runtime.mjs plus the existing single extension bundle. Include generic assets and licence notices. Keep native/pi peers external. There is no external monitor entry or metrics runtime. Do not edit host composition in this packaging execution.

- [ ] Step 4. Repeat `npm test -- packages/herdr/src/__tests__/packaging.test.ts`. Expect PASS for every case in that file. Run `npm run typecheck` and `git diff --check` before committing.

- [ ] Step 5. Check `git status --porcelain` and the required author identity. Stage only the task's owned files and commit the passing change.

```sh
git add packages/host/package.json packages/context/package.json package.json package-lock.json vite.herdr.config.mjs scripts/build-herdr.mjs scripts/assert-bundle.mjs .github/workflows/ci.yml .github/workflows/release.yml NOTICE.md LICENSE packages/herdr/src/__tests__/packaging.test.ts
git commit -m "feat: package explicit runtime entries and baseline ci"
```


### Task L4: Prove the complete setup through fake and real acceptance

#### Files

- Test `packages/herdr/src/__tests__/acceptance.test.ts`.
- Create or modify `packages/herdr/src/__tests__/scenario-status.ts`.
- Create or modify `packages/herdr/src/__tests__/scenario-jobs.ts`.
- Create or modify `packages/herdr/src/__tests__/scenario-remote.ts`.
- Create or modify `packages/herdr/src/__tests__/scenario-ssh.ts`.
- Create or modify `packages/herdr/src/__tests__/scenario-viewers.ts`.
- Create or modify `packages/herdr/src/__tests__/scenario-sessions.ts`.
- Create or modify `packages/herdr/src/__tests__/scenario-templates.ts`.
- Create or modify `packages/herdr/src/__tests__/scenario-panels.ts`.
- Create or modify `packages/herdr/src/__tests__/scenario-look.ts`.
- Create or modify `packages/herdr/src/__tests__/scenario-setup.ts`.
- Create or modify `README.md`.
- Create or modify `docs/guide/herdr.md`.
- Create or modify `docs/guide/using-spider.md`.
- Create or modify `docs/guide/subagents.md`.
- Create or modify `docs/architecture/README.md`.
- Create or modify `packages/host/README.md`.
- Create or modify `packages/herdr/README.md`.

#### Interfaces

This task uses A harness, complete host composition from L2, packaging from L3, and the producers' verified follow-up scenario exports.

It exports `runCompleteSetupAcceptance(h: HerdrHarness): Promise<SetupFacts>` and exported scenario functions with `AcceptanceScenario` signatures.

- [ ] Step 1. Write the failing test `complete setup has zero second-run writes and no duplicate writer or resources`. Use the assertions below.

```typescript
	it("status", () => runAcceptance("status", scenarioStatus));
	it("job notices", () => runAcceptance("jobs", scenarioJobs));
	it("guidance", () => runAcceptance("guidance", scenarioGuidance));
	it("reboot resume", () => runAcceptance("resume", scenarioResume));
	it("spaces", () => runAcceptance("spaces", scenarioSpaces));
	it("role templates", () => runAcceptance("roles", scenarioRoles));
	it("remote execution and SSH routing", () => runAcceptance("remote", async h => {
		await scenarioRemote(h);
		await scenarioSsh(h);
	}));
	it("subagent viewers", () => runAcceptance("viewers", scenarioViewers));
	it("spider panel", () => runAcceptance("spider-panel", scenarioSpiderPanel));
	it("machines panel", () => runAcceptance("machines-panel", scenarioMachinesPanel));
	it("look", () => runAcceptance("look", scenarioLook));
	it("shortcuts", () => runAcceptance("shortcuts", scenarioShortcuts));
	it("complete setup has zero second-run writes and no duplicate writer or resources", async () => {
		const result = await runCompleteSetupAcceptance(h);
		expect(result.secondSetup).toMatchObject({ writes: 0, launches: 0 });
		expect(result.piTerminalTextWrites).toEqual([]);
		expect(result.duplicateSessionWriters).toEqual([]);
		expect(result.remainingOwnedResources).toEqual([]);
	});
```

This execution has a separate 90-minute budget after a reserved 30-minute producer follow-up round. Every feature it() calls its producer's scenario assertions directly and lets exceptions fail the test. There is no self-reported feature-number list. Add a negative control whose producer scenario throws an assertion error, and require the wrapper to reject rather than report success. The aggregate case checks only whole-setup facts observed from actual files and process/resource inventories.

Each B through K producer contributes its scenario body in its own branch report/test file, not by editing L-owned scenario files. L assembles those exported tested functions into the stable scenario wrappers. No fake helper may declare features passed without observing the artifact. Explain unknown outcomes, raw SSH limits, shared approvals, and exact resume behavior. Run one combined review after the full artifact is frozen, not one review per task.

- [ ] Step 2. Run `npm test -- packages/herdr/src/__tests__/acceptance.test.ts`. Expect FAIL on the named behavior before implementation. Fix fixture or import-configuration errors first.

- [ ] Step 3. Implement the produced signatures in the owned files. Import the real modules and assembled artifacts. Run all feature scenarios against fake hc by default and the real isolated hc under the flag. The real-window mode also checks actual deferred mod rendering and key delivery. Add the setup, policy limitations, cutover, and repair guide to the docs indexes.

- [ ] Step 4. Repeat `npm test -- packages/herdr/src/__tests__/acceptance.test.ts`. Expect PASS for every case in that file. Run the part's acceptance export after its real dependencies are available. Run `npm run typecheck` before committing.

- [ ] Step 5. Check `git status --porcelain` and the required author identity. Stage only the task's owned files and commit the passing change.

```sh
git add packages/herdr/src/__tests__/acceptance.test.ts packages/herdr/src/__tests__/scenario-status.ts packages/herdr/src/__tests__/scenario-jobs.ts packages/herdr/src/__tests__/scenario-remote.ts packages/herdr/src/__tests__/scenario-ssh.ts packages/herdr/src/__tests__/scenario-viewers.ts packages/herdr/src/__tests__/scenario-sessions.ts packages/herdr/src/__tests__/scenario-templates.ts packages/herdr/src/__tests__/scenario-panels.ts packages/herdr/src/__tests__/scenario-look.ts packages/herdr/src/__tests__/scenario-setup.ts README.md docs/guide/herdr.md docs/guide/using-spider.md docs/guide/subagents.md docs/architecture/README.md packages/host/README.md packages/herdr/README.md
git commit -m "test: prove the complete setup through fake and real acceptance"
```

## Combined verification

Run these commands on the assembled change, not a mixture of unfinished worktrees:

```sh
npm run typecheck
npm test
npm run build
npm run check:lockfile
npm pack --dry-run --ignore-scripts --json
```

Every command must exit zero. `assert-bundle` must report the single-file extension, existing dashboard, three explicit Herdr entries, external peers/natives, and valid assets. The dry-run package must contain the mods, patch assets, layout edits, two themes, fonts and notices, template recipe, keys fragment, and shell hook. It must contain no user configuration, copied built-in mods, tests, or unplanned runtime chunk. Compare the package manifest's dependency keys and lockfile registry hosts to the planning base. Only internal workspace metadata may change.

Run the complete shared scenarios in fake mode:

```sh
npm test -- packages/herdr/src/__tests__/acceptance.test.ts
```

Run real isolated cores and a fake remote before deployment on macOS and Linux:

```sh
SPIDER_HERDR_E2E=1 npm test -- packages/herdr/src/__tests__/acceptance.test.ts
```

For app, shortcuts, and the actual look, run the fenced real-window mode on a supported desktop:

```sh
SPIDER_HERDR_E2E=1 SPIDER_HERDR_APP_E2E=1 npm test -- packages/herdr/src/__tests__/acceptance.test.ts
```

The harness passes isolated environment values to every process, proves both core IDs and sockets, and closes only its own window and resources. It invokes `herdr-app check <installed-test-mod-folder>` for spider, machines, and the three personal clones. The check must exit zero for each mod. Requested real mode cannot silently skip. Default Ubuntu CI uses the fake scenarios without downloading hc.

A fake run proves the integration's decisions at the transport boundary. A real core run proves hc parenting, events, file transfer, loss, and output. A real app run proves pane membership, deferred GPUI rendering, keyboard delivery, and the shown layout. None substitutes for the others.

Inspect the diff and the exact installed artifacts. Freeze the complete change before one combined review. Fix that review's findings in one round, rerun affected tests and combined verification, and repeat review only for Critical findings. Do not push an upstream proposal or deploy without the user's approval. After an approved spider deploy, existing sessions use /reload. From a plain shell, setup waits for the selected files to be free before reopening those sessions. Unaccounted pi PIDs remain blocking.

## Coverage checklist

| Feature | Implementing tasks | Acceptance wrapper and required assertion |
| --- | --- | --- |
| 1. Status | B1 and B3. | scenario-status.ts proves native settle/cache replay stays working until owned pending children finish. |
| 2. Job notices | D1 and B2. | scenario-jobs.ts proves original exit23, reload deduplication, durable pending delivery, and unchanged editor input. |
| 3. Guidance | H2. | scenario-templates.ts compares HC and non-HC managed blocks and checks the no-send/intercom instructions. |
| 4. Reboot resume | G1 and G2. | scenario-sessions.ts proves same terminal address, exact file/cwd, and an offered rather than automatic resume. |
| 5. Spaces | G3 and L1. | scenario-sessions.ts blocks every possibly live writer, including any selected pi session that printed the setup hint, then opens closed named sessions exactly once. |
| 6. Role templates | H1. | scenario-templates.ts proves provider-qualified configured models and thinking in actual launch argv. |
| 7. Visible remote commands | C1 through C3, D2, and E1 through E3. | scenario-remote.ts and scenario-ssh.ts prove pane acknowledgement before payload output, exact separate streams/exit, cancellation, routing policy, and no local fallback. |
| 8. Subagent viewers | F1, F2, and K1. | scenario-viewers.ts proves one live child view, actual RPC conversation delivery, and finished/print refusal without input mutation. |
| 9. Spider panel | B2, B3, I1, and I2. | scenario-panels.ts proves fresh rendered facts, shared approvals, one shared budget notice opening usage without pane focus, and recorded-owner focus for session notices. |
| 10. Machines panel | J1 and J2. | scenario-panels.ts proves file-read measurements with no metrics terminal, stale/unknown lock facts, owner/kind jobs, and a returned-ID machine shell. |
| 11. Look | K1 and K2. | scenario-look.ts proves all mods load, neutral themes/contrast, exact ANSI palette, renamed fonts, and anchor-failure rollback. |
| 12. Shortcuts | H2. | scenario-templates.ts proves all five CSI-u shortcuts preserve exact text/cursor and leave Ctrl-V and fullscreen search intact. |
| Complete setup | L1 through L4. | scenario-setup.ts proves one command installs all capabilities, a second run makes zero changes, and cleanup leaves no owned resources. |

## Completion criteria

All task checkboxes are complete, every default test passes, the actual packed artifacts contain the intended files, and the real modes pass on the supported baseline. Doctor reports every installed item and no unexplained failure. User-owned spaces and machine data remain outside the public package. No task claims feature completion from compilation, a screenshot alone, or an expected-value helper.

The only open design question is whether to propose a supported pi program-status contribution API after acceptance. That proposal needs the user's approval. The native-setter adapter remains the implementation in this plan.

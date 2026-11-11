# Roaming agents Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Each track has one writer in its own worktree. Review each combined phase once, not each task.

**Goal:** Keep a top-level pi session working on its enrolled Linux home while the Mac is off, with convergent portable rows and safe idle-session moves.

**Architecture:** Database descriptors generate function-free SQL capture and portable export codecs. A new pi-independent roaming package owns durable hub, transfer, provisioning, supervision, and move operations through injected ports. Host admission and local locks prevent ordinary work outside the current home, while Herdr supplies generic execution, transfer, and placement.

**Tech Stack:** TypeScript, Node.js built-ins, better-sqlite3, SQLite JSON and FTS5, Git, Vitest, pi 1.2.0, intercom 0.13.0, launchd, systemd user services, and authenticated hc transport.

**Spec:** [Roaming agents](../specs/2026-11-11-roaming-agents-design.md). The spec is authoritative. Phase 0 is complete. This plan implements phases 1 through 4.

## Global Constraints

- Read the authoritative `docs/superpowers/specs/2026-11-11-roaming-agents-design.md` before your task. Its requirements apply even when only this section and your task are supplied.
- Public move entry points are `/move <machine>` and `spider move <session> <machine>`.
- Keep roaming disabled by default through all four phase deployments. Enable production replication and hosting only after phase 4 acceptance.
- Deliver one PR per phase. Merge, deploy with roaming disabled, and verify that main is green before starting the next phase.
- Use existing dependencies and Node built-ins. Do not run dependency installation in worker worktrees. Give each worktree independent workspace links and native modules.
- Require Node >=22.19.0, pi 1.2.0, intercom 0.13.0, core schema 14, protocol 1, and SQLite >=3.42 for every writer, including sqlite3 CLI.
- Pin release tarball hashes and the tested Node range. A newer core schema fails before application queries. There is no downgrade projection or local fallback after a failed remote command.
- The Mac is the hub. Boxes have no outbound peers. Sync and moves require an awake Mac. Active homes continue offline without a timed lease expiry or automatic takeover.
- Machine UUIDs are private, persistent identities. Aliases are routing names only. A changed or cloned identity requires enrollment reconciliation before hosting.
- Only the hub command path changes homes. Every change, including rollback, increments the epoch. Freeze never expires. Readiness is durable before ordinary consumers.
- Children stay with their parent. Moves refuse all unsettled work instead of cancelling it. Resume restores conversation and triggers, not execution or a continuation prompt.
- Common replication tables belong only to canonical core DBs. Usage DBs, routes, bindings, leases, ownership, broker state, skills, indexed content, native indexes, job journals, and backups never replicate.
- Retain logs, seen change IDs, and tombstones indefinitely. Never trim oversized rows, renumber tracked todos, rerun memory review, or delete accepted rows to meet a memory cap.
- Use private directories and executables with mode 0700, and files and sockets with mode 0600. Refuse symlinks and foreign ownership at destination boundaries.
- Never print credentials, transcript bodies, uncommitted contents, or credential-bearing origin URLs. Public examples and fixtures are synthetic.
- No model-callable operation provisions credentials or changes homes directly. Auth copying requires human confirmation for the target and provider list. Never execute secret commands to collect their output.
- Use exact, nonempty session files. Launch `pi --session <file>` with mapped cwd and no cwd override, prefix, `--continue`, `--fork`, or initial prompt.
- Capture checks state in the writing transaction. Frozen and retired writes raise `session is frozen`. Imported envelopes never publish operational run events or bill usage.
- Rollout must reload every consumer, including detached usage workers. Enable refuses any live top-level older or unmarked build using Herdr session-registry process presence, not a manual reminder. Preserve function-free connection tests and replay exact baseline writer SQL.
- Every worker task follows red, green, then commit. Do not commit missing imports or temporary production stubs. Test doubles implement the specified ports.
- Run every new unit and integration test with a 5000 ms ceiling and `--maxWorkers=2`. Set `5000` explicitly on each new test rather than inheriting the repository's 30-second default. Use fake time for minute-scale policies. Core- or pi-starting R-stories are exempt: run serially in the Herdr acceptance tiers below, with existing harness per-wait and runner deadlines. Record story duration. Never shorten a story to evade its acceptance requirement.
- Use `@spider/db-core/testutil` fixture paths, independent machine roots, real migrations, and generated triggers. Clear inherited child and DB variables as described in `CONTRIBUTING.md`. Parent-only organism tests explicitly stub `PI_SUBAGENT_CHILD` to `0`.
- Every launchd, systemd, power-assertion, boot-ID, and file-limit call uses an injectable port. Tests use fakes, never the live machine. Raise soft nofile only in the shell launcher with `ulimit -Sn`, never Node.
- Admission gates and session-ID locks apply only to membership or home-row participants. Unknown participation on read failure admits with one warning. Known participants block with a plain message.
- Before each existing core DB's first migration, synchronously `VACUUM INTO` a private global backup and refuse migration if backup fails. Trigger-shape drift disables capture and reports doctor diagnostics, never refusing open.
- Usage v7 never backfills or rewrites old facts. NULL means local before roaming. Only segment-aware participating ingest sets a nullable unique key. Existing duplicates stay untouched.
- Fake hc records argv and refuses local fallback. Real-core checks use the existing isolated acceptance resource ledger. Never use a default core or unrelated terminals.
- Commands below run from the worktree root. Test commands inherit fixture-only global and agent roots. Full gates unset `PI_SUBAGENT_CHILD`, `PI_SUBAGENT_RUN_ID`, `PI_SPIDER_DB_PATH`, and `PI_SPIDER_SESSION_ID`.

### Shared types and ownership

Task 1.1 creates `packages/db-core/src/roam/types.ts` and exports these contracts through `@spider/db-core/roam/types`. Other database roaming modules have matching explicit subpath exports. `Db` is the existing `@spider/db-core` connection wrapper. Numeric clocks, sequences, and epochs are checked safe integers. Types do not imply that wire data has been validated.

```typescript
export type Scope = "global" | "repo" | "worktree";
export type MachineId = string;
export type StoreKey = "global" | `repo:${string}` | `worktree:${string}:${string}`;
export type Entity = "global_memory" | "memory" | "sessions" | "todos"
	| "runs" | "run_events" | "session_homes";
export interface Descriptor { scope: Scope; table: string; key: string;
	columns: readonly string[]; sessionColumn: string | null; immutable: readonly string[] }
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };
export interface Hlc { ms: number; count: number; machine: MachineId; stream: string }
export interface Home { sessionId: string; machineId: MachineId; epoch: number;
	moveId: string | null; updatedAt: number }
export interface Change { changeId: string; entity: Entity; rowKey: string;
	op: "put" | "delete"; clock: Hlc; writerSession: string | null;
	writerEpoch: number | null; schema: 14; body: JsonObject | null }
export interface RecordChange extends Change { seq: number }
export interface BatchHeader { protocol: 1; schema: 14; batchId: string;
	senderMachine: MachineId; senderStream: string; storeKey: StoreKey;
	after: number; through: number; count: number }
export interface BatchArtifact { file: string; byteLength: number; sha256: string;
	header: BatchHeader }
declare const validatedBatchBrand: unique symbol;
export type ValidatedBatch = BatchArtifact & {readonly [validatedBatchBrand]: true};
export interface ApplyReceipt { batchId: string; stream: string; through: number;
	sha256: string; applyMs: number }
export interface StoreBarrier { storeKey: StoreKey; stream: string; through: number }
export type LocalState = "active" | "frozen" | "retired";
export interface SessionState { sessionId: string; epoch: number; state: LocalState;
	moveId: string | null; freezeSeq: number | null }
export interface Locator { machineId: MachineId; repoKey: string;
	workspaceId: string; relativePath: string }
export interface HistoryRef { machineId: MachineId; reference: string }
export interface Segment { version: 1; moveId: string; epoch: number;
	previousMachine: MachineId; nextMachine: MachineId; historyMachine: MachineId;
	parentRef: HistoryRef | null }
export interface Blocker { kind: string; id: string; detail: string }
export interface Readiness { operationId: string; sessionId: string; epoch: number;
	cwd: string; file: string; core: string; terminal: string }
export interface ExportPolicy {
	encode(entity: Entity, body: JsonObject, origin: MachineId): JsonObject;
}
export interface ReplicaEffects {
	winning(db: Db, before: {rowid: number; body: JsonObject} | null,
		after: {rowid: number} | null, change: Change): void;
	committed(storeKey: StoreKey): void;
}
export interface ProcessIdentity { bootId: string; pid: number; startTime: string }
export type Probe = { kind: "absent" } | { kind: "uncertain" }
	| { kind: "live"; identity: ProcessIdentity };
```

Bodies use descriptor-defined columns. Wire records never contain local registry or DB paths. `BatchArtifact.file` is a private local handle, not a wire field. `clock.machine` and `clock.stream` carry original envelope origin. Forwarding adds only a local sequence.

Task 1.2 exports from `@spider/db-core/testutil` the fixture in `packages/db-core/src/__tests__/roam-fixture.ts` with `createReplica(scope: Scope, machineId: MachineId): ReplicaFixture`. `ReplicaFixture` has `{root: string; db: Db; storeKey: StoreKey; machineId: MachineId; close(): void}`. The factory uses actual migration, distinct roots, deterministic store keys, and no global production state. Every fixture that enables capture first fills `store_key`. Each task owns its other fixtures alongside its named tests.

### Fixed transfer limits

Task 2.1 exports `DEFAULT_LIMITS` and a validated `Limits` type from `@spider/roam/contracts`. These values are defaults, not automatic fallback permissions.

| Setting | Default |
| --- | --- |
| Raw chunk and single reply | 384 KiB and 1 MiB |
| Manifest page | 512 KiB, with digest-linked pages |
| Export byte target and apply-time target | 4 MiB and 250 ms, including lexical work |
| Hard batch and single-row wire limit | 16 MiB including header and newlines |
| Workspace bundles per move | 256 MiB total, including final delta |
| Session artifact | 1 GiB |
| Release or agent-file artifact | 256 MiB each |
| Per-peer staging quota | 4 GiB, including chunks and reconstruction |
| File and control call deadlines | 30 seconds and 60 seconds |
| Export and import command deadlines | 120 seconds and 600 seconds |
| Direct execution maximum | 600 seconds |
| Background launch and destination readiness deadlines | 60 seconds each |
| Artifact transfer deadline | 30 minutes, then durable pending |
| Concurrent peer transfers | 2, unmeasured, never two for one peer |
| Chunk retries | 3 retries after 1, 2, and 4 seconds |
| Unreferenced incomplete staging retention | Seven days |
| Hub sync period and disconnected retry | Two minutes per peer, then 30, 60, and 120 seconds |
| Supervisor reconciliation and crash restart | Ten seconds, then 5, 15, 60, and 300 seconds |
| Crash suspension and reset | Five failures in ten minutes, reset after ten stable minutes |
| Unreachable-home alert | Ten minutes, one notice until recovery |

Limits may be lowered locally. Raising them requires an explicit configuration change. Apply duration is a sizing target, not a transaction timeout.

### Shared service and host contracts

Task 2.1 declares the following configuration, operation, service, and move types in `@spider/roam/contracts`. Database types are imported type-only from db-core. Task 1.9b declares the host types below in `@spider/host` source submodules, not in the roaming package.

```typescript
export interface Peer { machineId: MachineId; alias: string; node: string; pi: string;
	cli: string; core: string; globalRoot: string }
export interface Limits { chunkBytes: number; replyBytes: number; manifestBytes: number;
	targetBatchBytes: number; hardBatchBytes: number; applyTargetMs: number;
	workspaceBytes: number; sessionBytes: number; agentBytes: number; stagingBytes: number;
	fileMs: number; controlMs: number; exportMs: number; importMs: number;
	directMs: number; launchMs: number; readyMs: number; transferMs: number;
	peerConcurrency: number; retryDelaysMs: readonly number[]; retentionMs: number }
export interface RoamConfig { enabled: boolean; role: "hub" | "box";
	machineId: MachineId; hubMachineId: MachineId; peers: readonly Peer[];
	discoveryRoots: readonly string[]; coreUnit: string; syncMs: number; limits: Limits }
export interface Operation { id: string; machineId: MachineId; expectedEpoch: number | null;
	kind: string; args: JsonObject }
export interface Outcome<T> { code: 0 | 1 | 2 | 3; reason: string; operationId: string;
	home: Home | null; epoch: number | null; repairCommand: string | null; value: T | null }
export interface CallOptions { timeoutMs: number; maxBytes: number; stdin?: Buffer }
export interface Transport {
	resolve(peer: Peer): Promise<Peer>;
	exec(peer: Peer, argv: readonly string[], options: CallOptions): Promise<Buffer>;
	run(peer: Peer, argv: readonly string[], operationId: string): Promise<{terminal: string}>;
	read(peer: Peer, path: string, options: CallOptions): Promise<Buffer>;
	write(peer: Peer, path: string, bytes: Buffer, timeoutMs: number): Promise<void>;
}
export interface Clock { now(): number; later(ms: number, fn: () => void): () => void }
export interface Journal {
	begin(operation: Operation): {kind: "new" | "pending" | "done"; result: JsonObject | null};
	record(id: string, action: string, result: JsonObject): void;
	read(id: string): readonly {action: string; result: JsonObject}[];
}
```

```typescript
export interface ArtifactManifest { id: string;
	kind: "batch" | "session" | "workspace" | "release" | "agent" | "auth";
	byteLength: number; sha256: string;
	chunks: readonly {index: number; rawLength: number; sha256: string}[] }
export interface AgentPorts { config: RoamConfig; journal: Journal; root: string;
	openStore(key: StoreKey): {db: Db; effects: ReplicaEffects; policy: ExportPolicy} }
export interface StorePort {
	list(peer: MachineId): readonly StoreKey[];
	cursor(key: StoreKey, machine: MachineId, stream: string): number;
	accept(key: StoreKey, artifact: BatchArtifact): Promise<ApplyReceipt>;
	export(key: StoreKey, after: number, targetBytes: number, batchId: string): Promise<BatchArtifact>;
}
export interface SyncService { start(): void; stop(): void;
	sync(peer?: MachineId): Promise<readonly Outcome<ApplyReceipt>[]>;
	barriers(peer: MachineId, required: readonly StoreBarrier[]): Promise<boolean> }
export interface PlacementPort {
	reconcile(rows: readonly Readiness[]): Promise<{pending: readonly string[]}>;
}
export interface HubPorts { config: RoamConfig; sync: SyncService; journal: Journal;
	clock: Clock; placement: PlacementPort }
export interface Diagnostic { reason: string; severity: "warning" | "block";
	repairCommand: string | null; writerEpoch?: number }
export interface HostIntent { sessionId: string; epoch: number;
	desired: "running" | "stopped"; suspended: string | null;
	file: string; cwd: string; moveId: string | null }
```

Host-only declarations, using public pi types at registration boundaries:

```typescript
export interface Admission { kind: "ordinary" | "control-only" | "blocked";
	home: Home | null; blockers: readonly Blocker[] }
export interface AdmissionGate { inspect(): Admission; close(): Promise<void>;
	freeze(moveId: string, epoch: number): Promise<void>;
	unfreeze(moveId: string, epoch: number): Promise<void> }
export interface AdmissionPorts { expectedEpoch: number | null;
	localMachine(): Promise<MachineId>;
	knownParticipant(sessionId: string): boolean;
	warnOnce(sessionId: string, reason: string): void;
	load(sessionId: string): Promise<{home: Home | null; states: readonly SessionState[];
		origin: MachineId | null; participating: boolean; captureSafe: boolean; unfinishedFreeze: boolean; initialConflict: boolean}>;
	lock(sessionId: string, file: string): Promise<() => Promise<void>>;
}
```

Phase 1 load reads global `session_homes`, affected worktree `roam_sessions`, and the fixed `<globalRoot>/roam/journal.db` path. Missing freeze journal means no unfinished freeze until 4.3b. A home row with empty `machine_id` is the replicated initial-conflict marker, not an assigned Home. The known-participant cache survives transient read errors and is populated by prior membership or home observations, never by file existence.

Participation state exists in each affected worktree DB. Global and repo stores have replication barriers, not session-state rows. Separate binding worktrees join the affected-store roster before seeding, admission, or freeze.

### Shared move contracts

Task 2.1 also declares `GitPorts` as specified in 4.1a and 4.1b, plus these pure data and port types in `@spider/roam/contracts`. Declaring them enables independent phase 4 tracks without placeholder implementations. They are part of Global Constraints supplied to every worker. Local paths in these types are participant handles, not replicated row fields.

```typescript
export interface WorkspaceSnapshot { root: string; repoKey: string; workspaceId: string;
	moveId: string; stage: "pre" | "final"; head: string; branch: string | null;
	objectFormat: "sha1" | "sha256"; indexTree: string; workingTree: string;
	relativeCwd: string; sparsePatterns: string | null; worktreeConfig: string | null;
	refs: readonly string[]; prerequisites: readonly string[];
	bundle: {kind: "unbundled"} | {kind: "ready"; artifactId: string; byteLength: number} }
export interface PreparedWorkspace { root: string; snapshot: WorkspaceSnapshot;
	previous: WorkspaceSnapshot | null; moveId: string }
export interface SessionManifest { file: string; sessionId: string; cwd: string;
	leaf: string; size: number; sha256: string; historySha256: string; artifactId: string }
export interface FreezeAck { operationId: string; sessionId: string; epoch: number;
	owner: ProcessIdentity | null; file: string; cwd: string; leaf: string;
	size: number; sha256: string; barriers: readonly StoreBarrier[] }
export interface MoveRequest { operation: Operation; sessionId: string;
	destinationMachine: MachineId }
export interface MoveResult { home: Home; terminal: string | null;
	lostPeers: readonly string[]; warnings: readonly string[] }
export interface MoveCheck { source: Home; destinationMachine: MachineId;
	repoKey: string; workspaceId: string; sourceRoot: string; sourceFile: string;
	sourceCwd: string; destinationRoot: string; destinationCwd: string;
	storeKeys: readonly StoreKey[]; lostPeers: readonly string[]; warnings: readonly string[] }
export interface PreparedMove { workspace: PreparedWorkspace; session: SessionManifest }
export interface DestinationObservation { home: Home; owner: Probe;
	readiness: Readiness | null; launchFailure: string | null; retired: boolean }
export interface MovePorts { config: RoamConfig; globalDb: Db; journal: Journal; clock: Clock;
	check(request: MoveRequest): Promise<MoveCheck>;
	power(): Promise<() => Promise<void>>;
	seed(check: MoveCheck): Promise<readonly StoreBarrier[]>;
	prepare(check: MoveCheck, operation: Operation): Promise<PreparedMove>;
	freeze(home: Home, operation: Operation): Promise<FreezeAck>;
	transfer(check: MoveCheck, ack: FreezeAck, operation: Operation): Promise<PreparedMove>;
	verifySource(ack: FreezeAck, workspace: WorkspaceSnapshot): Promise<void>;
	barriers(machine: MachineId, required: readonly StoreBarrier[]): Promise<boolean>;
	replicateHome(home: Home): Promise<void>;
	start(home: Home, prepared: PreparedMove, operation: Operation): Promise<Outcome<Readiness>>;
	inspect(home: Home, operation: Operation): Promise<DestinationObservation>;
	retire(home: Home, operation: Operation): Promise<Probe>;
	unfreeze(home: Home, operation: Operation): Promise<void>;
	cleanup(check: MoveCheck, operation: Operation): Promise<void>;
	recovery: RecoveryPort;
}
export interface RecoveryPort { revocationDb: Db;
	homes(machine: MachineId): readonly Home[];
	mirror(sessionId: string, epoch: number): Promise<SessionManifest | null>;
	restore(home: Home, mirror: SessionManifest, operation: Operation): Promise<Outcome<Readiness>>;
	conflicts(sessionId: string): Promise<readonly {machineId: MachineId; owner: Probe}[]>;
}
```

All external port replies are validated at their boundary. `retire` returns absent only after stopped ownership and durable retirement, not after a disconnected probe. `start` persists readiness before returning. `seed` and `barriers` cover every store in `MoveCheck.storeKeys`, including a separately bound workspace. `MoveCheck.source` may be the synthetic origin home at epoch 1 before first membership. Seed and sync must establish that exact owner and epoch before freeze. A power handle survives all recovery in that process; hub restart reacquires it before reconciling incomplete moves.

## Review Focus

Each additional case has a named owning test below.

1. A configuration or origin change must not silently rekey a store, expose credentials, or write a different checkout. Tasks 1.1, 1.8, 4.1a, and 4.1b.
2. A malformed batch near a size, integer, or clock boundary must leave every row, cursor, and receipt unchanged. Tasks 1.4a, 1.4b, 2.3a, and 2.3b.
3. Disk exhaustion, symlink replacement, or a stale staging reference must not install a partial artifact or delete referenced recovery evidence. Tasks 2.3b and 4.2.
4. A recycled PID, changed boot ID, or lost readiness reply must never authorize another owner. Tasks 1.9a, 1.9b, 3.3a, 3.3b, 4.4a, and 4.4b.
5. A selected older branch, unknown extension entry, or parser reset must preserve history without charging a foreign segment. Tasks 1.7 and 4.2.
6. Existing duplicate-path usage facts must survive migration untouched. Only new participating ingest receives a unique key. Test child transcript identity separately from parent accounting identity. Task 1.7.
7. A failed backup leaves a core DB unmigrated. Trigger drift disables capture without blocking ordinary nonparticipants. Tasks 1.2 and 1.3a.
8. Enable must refuse older live top-level builds, and nonparticipants must survive admission read errors without ID locks. Tasks 1.9b and 2.6.
9. No test may invoke real launchd, systemd, power, boot-ID, or limit operations. Unit ceilings must not invalidate serial real-core stories. Tasks 2.5b, 3.2a, 3.3a, 4.4a, and 4.6c.

---

## File boundaries and delivery order

A track owns its listed files for that phase, including tests. Tracks run concurrently only after their explicit prerequisites are integrated. Within a track, tasks run in numeric order. A later phase may change earlier files after the earlier phase is merged and deployed. Shared-file edits belong to one integration track, not to parallel workers. In phase 2 Service supplies foundation task 2.1 first, then resumes after Hub and Placement merge.

| Phase and track | Tasks | Exclusive file responsibility | Starts after | Merge order |
| --- | --- | --- | --- | --- |
| 1 Data | 1.1, 1.2, 1.3a, 1.3b | db-core types, identity, migration, generator, membership, seed, todo store, root scripts, CI SQLite | Start | Integrate 1.1 and 1.2 first, then 1.3a and 1.3b |
| 1 Locks | 1.9a | Herdr session-ID lock and tests | 1.1 integrated | After foundation, parallel with Data |
| 1 Merge | 1.4a, 1.4b | db-core HLC, codec, export, apply | 1.3b | After Data |
| 1 Derived | 1.5 | replica effects, event policy, memory embedding guards | 1.3b | After Merge |
| 1 Runs | 1.6 | subagents origin guards and blocker inventory | 1.5 | After Derived |
| 1 Usage | 1.7 | host usage store, parser, discovery, accounting | 1.2 integrated alone | After Data or earlier if ready |
| 1 Reads | 1.8 | catalog, registry resolution, todo and context reads, memory tags/injection | 1.4b and 1.5 | After Merge and Derived |
| 1 Host | 1.9b, 1.10 | admission/startup gates, build presence integration, composition tests, docs | 1.6, 1.7, 1.8, and 1.9a | Last |
| 2 Service | 2.1, 2.5b, 2.5c, 2.6 | package/contracts/journal, hub, launchd, control socket, CLI, diagnostics, manifests, acceptance registration | Phase 1 deployed; 2.5b waits for 2.4 and 2.5a | 2.1 first, 2.5b then 2.5c then 2.6 last |
| 2 Transport | 2.2 | generic Herdr byte execution, transfer adapter, fake hc | 2.1 | After foundation |
| 2 Artifacts | 2.3a, 2.3b | chunks, staging, quotas, agent dispatch and receipts | 2.1 | After foundation, 2.3a then 2.3b |
| 2 Hub | 2.4 | store adapters, homes, sync, peer state, barriers | 2.2 and 2.3b | After transport and artifacts |
| 2 Placement | 2.5a | Herdr placement and tests only | 2.1 | Parallel with Hub, before 2.5b |
| 3 Core | 3.1 | Herdr configuration and host mount | Phase 2 deployed | First |
| 3 Install | 3.2a, 3.2b | inventory, resource doctor, systemd, provision contracts, selected files and auth | Phase 2 deployed | 3.2a then 3.2b |
| 3 Launch | 3.3a | Herdr exact launcher, lease, shell limit plan | 3.1 and 3.2b | After Core and Install |
| 3 Hosting | 3.3b | roam intent, supervisor, launcher adapter | 3.3a | After Launch |
| 3 Host | 3.4, 3.5 | readiness, roaming participant ports, host admission and CLI wiring, hosting stories | 3.3b | Last |
| 4 Git source | 4.1a | source workspace snapshot and refusal tests | Phase 3 deployed | Either Git task first, both before Moves |
| 4 Git destination | 4.1b | Git bundles, destination restore, reuse and branch handling | Phase 3 deployed | Parallel with Git source |
| 4 Files | 4.2 | session artifacts and mirrors | Phase 3 deployed | Before Moves |
| 4 Control | 4.3a, 4.3b | blocker inventory, host socket/freeze adapters, roaming live/dormant control | Phase 3 deployed | 4.3a then 4.3b before Moves |
| 4 Moves | 4.4a, 4.4b, 4.5 | forward transitions and power, cancel/recovery, claim/revocation | 4.1a, 4.1b, 4.2, and 4.3b | 4.4a then 4.4b then 4.5 |
| 4 Product | 4.6a, 4.6b, 4.6c | port composition, CLI/slash wiring, stories and docs | 4.5 | 4.6a then 4.6b then 4.6c last |
| 4 Acceptance | 4.7 | Private real-machine evidence and enablement decision | 4.6c and full phase gate | Maintainer step, no worker |

Integrate 1.2 independently before Data continues with 1.3a. Usage then starts in parallel, not after the whole Data track. Integrate 1.9a any time after 1.1 and before Host. Within each phase, all prerequisites above must be integrated before a task starts. Merge order is a partial order, not a requirement to idle completed independent tracks.

Merge and Derived share port declarations, never unfinished implementations. `applyBatch` alone writes base rows and allocates rowids. Derived owns FTS, vectors, and queues. Reads alone edits registry/read actions. Host alone edits startup gates outside Usage. Phase 2 Placement edits only Herdr files and runs with Hub. Phase 3 Launch integrates before Hosting. Phase 4 Git source and destination consume the fixed shared contracts independently. No task adds per-task review stages.

### Acceptance story tiers

| Herdr acceptance tier | Story IDs | Execution budget |
| --- | --- | --- |
| `headless` | R01, R03, R04, R05, R06, R07, R08, R09, R10 | Serial, existing harness per-wait and runner deadlines, duration in result matrix |
| `app` | R02 | Serial, same existing harness deadlines, owned acceptance resources only |
| `ci` | None of R01 through R10 | Mark not exercised, never passed by omission |

Unit and integration tests keep 5000 ms and `--maxWorkers=2`. Starting cores or packed pi exempts only those acceptance stories, not broad test matrices. Add each story to its tier list, discovery and selection checks, and runner-contract tests in its phase.

### Common phase gate

Run this gate on the integrated phase branch, not separately in each parallel track:

```bash
npm run check:lockfile
npm run typecheck
npm run typecheck:herdr:e2e
env -u PI_SUBAGENT_CHILD -u PI_SUBAGENT_RUN_ID -u PI_SPIDER_DB_PATH -u PI_SPIDER_SESSION_ID npm test -- --maxWorkers=2
npm run build
npm pack --dry-run --json --ignore-scripts | node scripts/check-package-files.cjs
npm run test:herdr:e2e:ci -- --built
npm run test:herdr:e2e -- --built --tier headless
```

Run applicable R-stories serially using the table, including the app-tier R02 when phase 2 is integrated. Expected: all selected checks pass, no skipped required acceptance, fixture cleanup is proved, and unrelated roots and terminals are unchanged. Add packaged roaming CLI checks beginning in phase 2. Real-machine receipts remain private. Review the frozen combined phase in parallel with this gate, fix findings once, and rerun affected checks. Only critical findings require another review. Merge and deploy disabled before proceeding.

## Phase 1: Local replication

### Task 1.1: Define portable identities and descriptors

**Track:** Data. No prerequisite.

**Files:**
- Create: `packages/db-core/src/roam/types.ts`.
- Create: `packages/db-core/src/roam/identity.ts`.
- Create: `packages/db-core/src/roam/descriptors.ts`.
- Create: `packages/db-core/src/roam/machine.ts`.
- Create: `packages/db-core/src/__tests__/roam-identity.test.ts`.
- Modify: `packages/db-core/package.json`.

**Interfaces:** Produces the shared types above; `loadMachineIdentity(globalRoot: string): MachineId`; `canonicalOrigin(value: string): string | null`; `repoIdentity(input: {origin: string | null; roots: readonly string[]; explicitKey?: string}): string`; and `DESCRIPTORS: Readonly<Record<Entity, Descriptor>>`. `Descriptor` is `{scope: Scope; table: string; key: string; columns: readonly string[]; sessionColumn: string | null; immutable: readonly string[]}`. Add package export `"./roam/*": "./src/roam/*.ts"`. No runtime import from a feature package.

- [ ] **Step 1: Write the failing tests.** In `roam-identity.test.ts`, name cases `equates HTTPS SSH and scp origins without credentials`, `canonicalizes all three service URL shapes`, `preserves path case and nondefault ports`, `decodes only unreserved escapes`, `requires an explicit key for unborn repositories`, `creates one private machine identity`, and `projects only portable columns`. Assert:

```typescript
expect(urls.map(canonicalOrigin)).toEqual(Array(3).fill("code.example/org/team/repo"));
expect(canonicalOrigin("https://user:secret@HOST.invalid:443/A.git?q=secret#x"))
	.toBe("host.invalid/A");
for (const column of ["pid", "host_pid", "pid_start_time", "intercom_session"]) {
	expect(DESCRIPTORS.runs.columns).not.toContain(column);
}
expect(DESCRIPTORS.sessions.columns).not.toContain("imported_from");
expect(secondMachineId).toBe(firstMachineId);
```

Use the spec's legacy HTTPS, modern HTTPS, and `git@ssh.code.example:v3/org/team/repo` fixture. Include invalid URLs, local paths, encoded slash, and IPv6 authorities. Unknown hosts do not acquire guessed aliases.

- [ ] **Step 2: Run red.** `npm test -- --maxWorkers=2 packages/db-core/src/__tests__/roam-identity.test.ts`. Expected: missing roaming modules or assertions fail for the specified identities.
- [ ] **Step 3: Implement the exports.** Normalize default HTTPS and SSH ports to one host and path. Hash UTF-8 normalized identity with SHA-256 and prefix `origin:`. Hash sorted root commits as `root:`. Keep acquisition and caching of Git facts out of the pure canonicalizer. Define every projection from the spec's portable-row table, including nullable memory `machine_id` and immutable session and run origins. Create `roam/machine.json` once with exclusive creation, fsync, and mode checks. No top-level IO.
- [ ] **Step 4: Run green.** Repeat the red command and `npm run typecheck`. Expected: pass, no secret URL in an error or persisted identity.
- [ ] **Step 5: Commit.** Stage only this task's files. `git commit -m "feat(db): define portable roaming identities"`.

### Task 1.2: Add schema 14 without rewriting shipped migrations

**Track:** Data. Depends on 1.1.

**Files:**
- Create: `packages/db-core/src/roam/schema.ts`.
- Create: `packages/db-core/src/roam/layout.ts`.
- Create: `packages/db-core/src/__tests__/roam-fixture.ts`.
- Create: `packages/db-core/src/__tests__/roam-migration.test.ts`.
- Modify: `packages/db-core/src/schema.ts`.
- Modify: `packages/db-core/src/migrate.ts`.
- Modify: `packages/db-core/src/db.ts`.
- Modify: `packages/db-core/src/index.ts`.
- Modify: `packages/db-core/src/testutil.ts`.
- Modify: `packages/db-core/src/__tests__/schema-migration-parity.test.ts`.
- Modify: `scripts/postinstall.mjs`.

**Interfaces:** Consumes `loadMachineIdentity(globalRoot: string): MachineId`, `DESCRIPTORS`, and shared `Scope`. Produces `migrate(db: Db, scope: Scope | "project", options?: {machineId: MachineId; globalRoot: string}): void`, with the existing two-argument API retained; `validateRoamLayout(db: Db, scope: Scope): {captureSafe: boolean; diagnostic: string | null}`; `backupBeforeMigration(db: Db, scope: Scope, globalRoot: string): string` (synchronous); `snapshotCoreDb(db: Db, destination: string): Promise<void>`; `repairTodoSequenceIndex(db: Db): void` for an explicit enable attempt after deliberate repair; and `createReplica` from Global Constraints. `DESCRIPTORS` has type `Readonly<Record<Entity, Descriptor>>` from the shared types.

- [ ] **Step 1: Write the failing tests.** `roam-migration.test.ts` has `fresh and v13 layouts match in every scope`, `backfill preserves integer IDs and FTS rowids`, `duplicate sequences disable only roaming`, `future schema refuses before application queries`, `concurrent writable opens reread version under IMMEDIATE`, `trigger drift disables capture but open succeeds`, `missing data column refuses open`, `backup failure refuses migration before mutation`, `migration rollback preserves original and backup`, and `VACUUM backup includes committed WAL data`. Assert:

```typescript
expect(db.pragma("user_version")).toBe(14);
expect(afterIds).toEqual(beforeIds);
expect(afterFtsRowids).toEqual(beforeFtsRowids);
expect(meta).toMatchObject({ roamable: 0 });
expect(problem).toContain(conflictingRowId);
expect(() => openFuture()).toThrow(/future/);
expect(futureDigestAfter).toBe(futureDigestBefore);
```

Assert `expect(openAfterTriggerDrift()).not.toThrow()`, `expect(meta.capture_enabled).toBe(0)`, and `expect(doctorProblem).toContain("trigger")`. A failed backup leaves version and all source rows unchanged. Inject a migration failure after backup and reopen both the intact pre-migration store and backup. Check UUIDs against `/^[0-9a-f]{32}$/`, origin backfill against the fixture machine, and ordinary todo writes after a diagnosed duplicate. After manual duplicate repair, explicit index repair succeeds. Doctor never calls repair. A missing index without the diagnosed conflict is layout corruption.

- [ ] **Step 2: Run red.** `npm test -- --maxWorkers=2 packages/db-core/src/__tests__/roam-migration.test.ts packages/db-core/src/__tests__/schema-migration-parity.test.ts`. Expected: schema version or missing-column failures.
- [ ] **Step 3: Implement migration and validation.** Read `user_version` inside `db.raw.transaction(...).immediate()`. Reject versions above 14 before queries against application tables. For each existing non-fresh DB at version 13 or below, before its first migration transaction, synchronously `VACUUM INTO <globalRoot>/roam/backups/<scope>-<canonical-path-hash>-v<old-version>.db`. Use a private 0700 directory and mode-0600 file, check free space for main DB plus WAL bytes plus 16 MiB, and refuse migration on any backup or permission failure. Keep one verified pre-migration backup per store indefinitely, including after failure. Reuse an existing backup only after validating its store identity and original version. Recheck source `user_version` inside IMMEDIATE after backup. Fresh DBs need no backup. `snapshotCoreDb` remains the async snapshot API for export, not this synchronous migration hook.

Use exact additive statements in the proper scopes: global `ALTER TABLE global_memory ADD COLUMN machine_id TEXT;`, repo `ALTER TABLE memory ADD COLUMN machine_id TEXT;`, and worktree `ALTER TABLE sessions ADD COLUMN origin_machine TEXT NOT NULL DEFAULT '';`, `ALTER TABLE runs ADD COLUMN origin_machine TEXT NOT NULL DEFAULT '';`, `ALTER TABLE todos ADD COLUMN uuid TEXT;`, and `ALTER TABLE run_events ADD COLUMN uuid TEXT;`. Fill existing todo and event UUIDs, and create `idx_todos_uuid`, `idx_run_events_uuid`, and conditional unique `idx_todos_session_seq ON todos(session_id, seq)`. Backfill origins from the local machine. Fresh DDL matches migrated DDL. Keep all shipped v13 and earlier migration strings unchanged. Initialize metadata with capture disabled, one machine UUID, and a fresh stream UUID. Use the SQLite backup API or `VACUUM INTO` for backups, never a live file copy.

Use this exact common DDL in all three scopes:

```sql
CREATE TABLE roam_meta (
	id INTEGER PRIMARY KEY CHECK (id = 1),
	machine_id TEXT NOT NULL,
	stream_id TEXT NOT NULL UNIQUE,
	store_key TEXT,
	hlc_ms INTEGER NOT NULL DEFAULT 0,
	hlc_count INTEGER NOT NULL DEFAULT 0,
	capture_enabled INTEGER NOT NULL DEFAULT 0,
	importing INTEGER NOT NULL DEFAULT 0,
	roamable INTEGER NOT NULL DEFAULT 1,
	problem TEXT
);
CREATE TABLE roam_changes (
	seq INTEGER PRIMARY KEY AUTOINCREMENT,
	change_id TEXT NOT NULL UNIQUE,
	entity TEXT NOT NULL,
	row_key TEXT NOT NULL,
	op TEXT NOT NULL CHECK (op IN ('put', 'delete')),
	hlc_ms INTEGER NOT NULL,
	hlc_count INTEGER NOT NULL,
	origin_machine TEXT NOT NULL,
	origin_stream TEXT NOT NULL,
	writer_session TEXT,
	writer_epoch INTEGER,
	schema_version INTEGER NOT NULL,
	body_json TEXT,
	wire_json TEXT,
	CHECK ((op = 'delete') = (body_json IS NULL))
);
CREATE TABLE roam_versions (
	entity TEXT NOT NULL,
	row_key TEXT NOT NULL,
	change_id TEXT NOT NULL,
	hlc_ms INTEGER NOT NULL,
	hlc_count INTEGER NOT NULL,
	origin_machine TEXT NOT NULL,
	origin_stream TEXT NOT NULL,
	deleted INTEGER NOT NULL,
	PRIMARY KEY (entity, row_key)
);
CREATE TABLE roam_cursors (
	peer_machine TEXT NOT NULL,
	peer_stream TEXT NOT NULL,
	last_seq INTEGER NOT NULL,
	PRIMARY KEY (peer_machine, peer_stream)
);
CREATE TABLE roam_receipts (
	peer_machine TEXT NOT NULL,
	batch_id TEXT NOT NULL,
	peer_stream TEXT NOT NULL,
	after_seq INTEGER NOT NULL,
	through_seq INTEGER NOT NULL,
	sha256 TEXT NOT NULL,
	applied_at INTEGER NOT NULL,
	PRIMARY KEY (peer_machine, batch_id)
);
```

Observed migration cost was about two seconds of write lock on a 200 MiB store with 340k events. Re-measure backup, write-lock duration, and file growth privately in 4.7. Export `createReplica` through existing `testutil.ts` for all packages.

Also add global `session_homes(session_id TEXT PRIMARY KEY, machine_id TEXT NOT NULL, epoch INTEGER NOT NULL CHECK(epoch > 0), move_id TEXT, updated_at INTEGER NOT NULL)` and worktree `roam_sessions(session_id TEXT PRIMARY KEY, epoch INTEGER NOT NULL CHECK(epoch > 0), state TEXT NOT NULL CHECK(state IN ('active','frozen','retired')), move_id TEXT, freeze_seq INTEGER)`. Task 1.3a installs generated triggers and pins their SQL digest to schema 14. Later generator changes require schema 15. On open, a trigger-shape mismatch sets `capture_enabled=0`, records the problem, and never refuses the open. Missing data columns still refuse. Known participants block when the store is capture-unsafe. Nonparticipants remain usable. Do not repair triggers silently. Add these local-only tables to fresh and v14 migration DDL now, so later phases need no same-version schema edits: global `roam_repo_maps(repo_key TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, origin_fingerprint TEXT, root_fingerprint TEXT, worktree_command_json TEXT)`, `roam_workspace_maps(repo_key TEXT NOT NULL, workspace_id TEXT NOT NULL, path TEXT NOT NULL UNIQUE, snapshot_json TEXT, PRIMARY KEY(repo_key, workspace_id))`, `roam_locations(session_id TEXT PRIMARY KEY, stores_json TEXT NOT NULL, home_json TEXT, file TEXT, cwd TEXT)`, and `roam_home_actions(move_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, expected_epoch INTEGER NOT NULL, args_digest TEXT NOT NULL, cancelled INTEGER NOT NULL DEFAULT 0, committed_home_json TEXT)`. Add worktree `roam_seed_progress(session_id TEXT NOT NULL, entity TEXT NOT NULL, last_key TEXT, complete INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(session_id, entity))`. Reserve `session_homes.machine_id=''` at epoch 1 with null move ID for a replicated, hub-origin initial-conflict marker. It is not an assigned Home. Admission reads it as `initialConflict`. Claim consumes it at a higher epoch after stopped-copy proofs. These local-only tables are excluded from descriptors. Other operation journals remain separate private DBs.

- [ ] **Step 4: Run green.** Repeat the red command and `npm test -- --maxWorkers=2 packages/db-core/src/__tests__/postinstall-global-root.test.ts packages/db-core/src/__tests__/postinstall-fresh-install-repair.test.ts`. Expected: all pass and backups reopen with committed WAL rows.
- [ ] **Step 5: Commit.** `git commit -m "feat(db): migrate canonical stores to roaming schema 14"` after staging the listed files.

### Task 1.3a: Generate atomic capture and SQL freeze fences

**Track:** Data. Depends on 1.2.

**Files:**
- Create: `packages/db-core/src/roam/generate.ts`.
- Create: `packages/db-core/src/roam/generated.ts`.
- Create: `packages/db-core/src/__tests__/roam-capture.test.ts`.
- Create: `scripts/generate-roam-sql.mjs`.
- Modify: `packages/db-core/src/roam/layout.ts`.
- Modify: `packages/db-core/src/migrate.ts`.
- Modify: `package.json`.
- Create: `packages/db-core/src/__tests__/roam-baseline-writers.ts`.
- Modify: `.github/workflows/ci.yml`.

**Interfaces:** Consumes `DESCRIPTORS`, `Scope`, and `Db` from 1.1. Produces `captureSql(scope: Scope): string` and generated literal SQL. Layout validation returns capture safety without refusing an open on trigger drift. The baseline fixture stores exact SQL statements from `e732fa07`, not new helper approximations.

- [ ] **Step 1: Write the failing tests.** In `roam-capture.test.ts`, parameterize `function-free writers capture one normalized change` over wrapper, raw better-sqlite3 with no functions, and sqlite3 CLI, recursion 0 and 1. Cover seven entities, immutable IDs and origins, disabled capture, import rollback, source-log rollback, insert/update/delete frozen and retired fences, PID-only updates, and unrelated sessions. Assert `expect(changesForInsert).toHaveLength(1)`, `expect(change.body.uuid).toBe(persistedUuid)`, `expect(() => frozenWrite()).toThrow("session is frozen")`, and `expect(logAfterRollback).toEqual(logBefore)`. Add `baseline SQL replay preserves actual v13 writers`: replay exact session upserts, todo add/toggle/remove/clear, run inserts/status updates, and run-event appends against migrated stores with and without membership. Active members capture once per portable change, nonmembers capture nothing, frozen members raise. Explicitly race old todo sequence allocation: one duplicate insert now fails its unique constraint instead of writing duplicate data. Add `generated SQL digest is pinned to schema fourteen` and assert the committed hash, not a hash computed from the same generator at runtime.
- [ ] **Step 2: Run red.** `npm test -- --maxWorkers=2 packages/db-core/src/__tests__/roam-capture.test.ts`. Expected: the named missing behavior or export fails.
- [ ] **Step 3: Implement the exports.** Generate literal SQL at build time from descriptors. Keep the spec's todo trigger text below unchanged. Generate corresponding update and delete triggers, identity and origin fills, and before-update and before-delete fences for every participating entity. Compare old and new projected JSON with `IS NOT`. No application-defined SQL functions, trigger-order dependency, or reentrant queries. Add metadata guards that reject negative clocks or values above 9007199254740991, including SQL capture overflow.

```sql
CREATE TRIGGER roam_todos_uuid_fill AFTER INSERT ON todos
WHEN NEW.uuid IS NULL OR NEW.uuid = ''
BEGIN
	UPDATE todos SET uuid = lower(hex(randomblob(16))) WHERE id = NEW.id;
END;
CREATE TRIGGER roam_todos_uuid_fixed BEFORE UPDATE ON todos
WHEN OLD.uuid IS NOT NULL AND OLD.uuid != '' AND NEW.uuid IS NOT OLD.uuid
BEGIN
	SELECT RAISE(ABORT, 'roaming UUID cannot change');
END;
CREATE TRIGGER roam_todos_frozen_bi BEFORE INSERT ON todos
WHEN (SELECT importing FROM roam_meta WHERE id = 1) = 0
BEGIN
	SELECT RAISE(ABORT, 'session is frozen')
	WHERE (SELECT state FROM roam_sessions WHERE session_id = NEW.session_id)
		IN ('frozen', 'retired');
END;
CREATE TRIGGER roam_todos_capture_ai AFTER INSERT ON todos
WHEN NEW.uuid IS NOT NULL AND NEW.uuid != ''
	AND (SELECT capture_enabled = 1 AND importing = 0 FROM roam_meta WHERE id = 1)
	AND EXISTS (SELECT 1 FROM roam_sessions WHERE session_id = NEW.session_id)
BEGIN
	UPDATE roam_meta SET (hlc_ms, hlc_count) = (
		WITH sample(ms) AS (
			SELECT CAST(unixepoch('subsec') * 1000 AS INTEGER)
		)
		SELECT max(roam_meta.hlc_ms, sample.ms),
			CASE WHEN sample.ms > roam_meta.hlc_ms THEN 0 ELSE roam_meta.hlc_count + 1 END
		FROM sample
	) WHERE id = 1;
	INSERT INTO roam_changes (
		change_id, entity, row_key, op, hlc_ms, hlc_count,
		origin_machine, origin_stream, writer_session, writer_epoch,
		schema_version, body_json
	)
	SELECT lower(hex(randomblob(16))), 'todos', NEW.uuid, 'put', hlc_ms, hlc_count,
		machine_id, stream_id, NEW.session_id,
		(SELECT epoch FROM roam_sessions WHERE session_id = NEW.session_id), 14,
		json_object('uuid', NEW.uuid, 'session_id', NEW.session_id, 'seq', NEW.seq,
			'text', NEW.text, 'done', NEW.done, 'created_at', NEW.created_at,
			'updated_at', NEW.updated_at)
	FROM roam_meta WHERE id = 1;
	INSERT INTO roam_versions
	SELECT entity, row_key, change_id, hlc_ms, hlc_count,
		origin_machine, origin_stream, 0
	FROM roam_changes WHERE seq = last_insert_rowid()
	ON CONFLICT(entity, row_key) DO UPDATE SET
		change_id = excluded.change_id, hlc_ms = excluded.hlc_ms,
		hlc_count = excluded.hlc_count, origin_machine = excluded.origin_machine,
		origin_stream = excluded.origin_stream, deleted = excluded.deleted;
END;
```



Fences use `OLD.id` for sessions, otherwise `OLD.session_id`, and check the new session identity on updates. They bypass only importing, even if capture is disabled. Raw older inserts fill origins before one captured insertion. Install sqlite3 >=3.42 in CI and fail loudly if either bundled SQLite or CLI is too old, never skip these cases. Pin generated SQL to schema 14 and disable store capture on drift.
- [ ] **Step 4: Run green.** Repeat the red command. Run `node scripts/generate-roam-sql.mjs --check` and migration parity tests with `--maxWorkers=2`. Expected: exact generated text, function-free compatibility, and SQL-replay coverage pass.
- [ ] **Step 5: Commit.** `git commit -m "feat(db): generate roaming capture and SQL fences"`.

### Task 1.3b: Seed participation and enforce todo home admission

**Track:** Data. Depends on 1.3a.

**Files:**
- Create: `packages/db-core/src/roam/state.ts`.
- Create: `packages/db-core/src/roam/seed.ts`.
- Create: `packages/db-core/src/__tests__/roam-seed.test.ts`.
- Create: `packages/todo/src/__tests__/roam-writes.test.ts`.
- Modify: `packages/todo/src/store.ts`.

**Interfaces:** Consumes `Db`, `Home`, `SessionState`, and `StoreKey`. Produces `readSessionState(db: Db, sessionId: string): SessionState | null`; `assertTodoHome(db: Db, sessionId: string, localMachine: MachineId, home: Home | null): void`; `seedSession(db: Db, sessionId: string, epoch: number, key: StoreKey, limit: number): {complete: boolean; through: number}`; and `enableMemoryCapture(db: Db, key: StoreKey): void`. Existing todo public signatures stay intact.

- [ ] **Step 1: Write the failing tests.** `roam-seed.test.ts` names `first seed chunk installs store key and capture`, `seed resumes while normal capture continues`, `abort retains membership`, and `memory enable seeds atomically once`. Assert `expect(meta).toMatchObject({store_key: key, capture_enabled: 1})` and no duplicate version for a concurrently updated or deleted key. `roam-writes.test.ts` names `cross-session mutation checks target home`, `allocation serializes sequences`, and `edits address resolved UUID`. Assert `expect(() => editForeign()).toThrow(/home/)` while reads remain allowed.
- [ ] **Step 2: Run red.** `npm test -- --maxWorkers=2 packages/db-core/src/__tests__/roam-seed.test.ts packages/todo/src/__tests__/roam-writes.test.ts`. Expected: the named missing behavior or export fails.
- [ ] **Step 3: Implement the exports.** Membership is durable and has no expiry. In the first chunk transaction set `store_key`, verify it never changes identity, set `capture_enabled=1`, and insert active membership. Seed only unversioned rows in bounded keyset transactions, persist progress locally, and leave normal capture active. Abort retains membership. Memory seed and capture enablement share one transaction. Seed and enable require capture-safe layout and never override a drift diagnostic. Explicit enable checks diagnosed todo duplicates and creates the missing index only after deliberate repair before clearing `roamable=0`. Todo mutations check the target session home and active state inside IMMEDIATE, allocate sequence there, and resolve updates and deletes to UUID.
- [ ] **Step 4: Run green.** Repeat the red command. Expected: resumable seed, atomic memory enable, and cross-session write refusal pass.
- [ ] **Step 5: Commit.** `git commit -m "feat(db): seed participants and admit todo mutations"`.

### Task 1.4a: Validate clocks and export immutable snapshot batches

**Track:** Merge. Depends on 1.3b. Can run with Derived and Usage.

**Files:**
- Create: `packages/db-core/src/roam/hlc.ts`.
- Create: `packages/db-core/src/roam/codec.ts`.
- Create: `packages/db-core/src/roam/export.ts`.
- Create: `packages/db-core/src/__tests__/roam-hlc.test.ts`.
- Create: `packages/db-core/src/__tests__/roam-codec.test.ts`.

**Interfaces:** Consumes shared HLC, `Change`, `RecordChange`, `BatchHeader`, `BatchArtifact`, `ValidatedBatch`, and `ExportPolicy`. Produces `compareHlc(a: Hlc, b: Hlc): -1 | 0 | 1`; `observeHlc(local: Hlc, remote: Hlc, now: number): Hlc`; `exportBatch(db: Db, request: {after: number; targetBytes: number; batchId: string}, policy: ExportPolicy): Promise<BatchArtifact>`; and `validateBatch(artifact: BatchArtifact, expected: {storeKey: StoreKey; senderMachine: MachineId; senderStream: string; now: number}): Promise<ValidatedBatch>`. Validation is pure with respect to the destination DB.

- [ ] **Step 1: Write the failing tests.** `roam-hlc.test.ts` covers backward time, every receive max-clock case, overflow, and skew above five minutes. `roam-codec.test.ts` names `snapshot export releases writer before transport`, `locator wire content is cached once`, `zero count has no import or receipt`, `complete validation refuses malformed last record`, and `wire bytes obey exact and just-over limits`. Cover invalid UTF-8, envelopes, keys, non-safe integers, schema, contiguous sequences, digest and length. Assert `expect(observeHlc(local, remote, now).count).toBe(expectedCount)`, `expect(header.through).toBe(header.after)` for count zero, and `expect(destinationDigestAfter).toBe(destinationDigestBefore)` for invalid artifacts.
- [ ] **Step 2: Run red.** `npm test -- --maxWorkers=2 packages/db-core/src/__tests__/roam-hlc.test.ts packages/db-core/src/__tests__/roam-codec.test.ts`. Expected: the named missing behavior or export fails.
- [ ] **Step 3: Implement the exports.** Export from a SQLite snapshot without a writer transaction across transport. Cache locator-converted bodies once in `wire_json`, leaving it NULL when identical. Forward and dedupe with `coalesce(wire_json, body_json)`. Validate immutable UTF-8 NDJSON, exact bytes and digest, every envelope, bounds, and the complete artifact before branding its private handle. No destination mutation during validation. Count-zero export has `through=after` and creates no import or receipt.
- [ ] **Step 4: Run green.** Repeat the red command. Expected: HLC boundary matrix and exact immutable export/validation pass.
- [ ] **Step 5: Commit.** `git commit -m "feat(db): export and validate portable roaming batches"`.

### Task 1.4b: Apply winning rows and digest-bound receipts atomically

**Track:** Merge. Depends on 1.4a.

**Files:**
- Create: `packages/db-core/src/roam/apply.ts`.
- Create: `packages/db-core/src/__tests__/roam-merge.test.ts`.
- Create: `packages/db-core/src/__tests__/roam-replay.test.ts`.

**Interfaces:** Consumes `ValidatedBatch` from 1.4a and shared `Db`, `Home`, `Change`, `ApplyReceipt`, and `ReplicaEffects`. Produces `applyBatch(db: Db, batch: ValidatedBatch, options: {hubMachine: MachineId; effects: ReplicaEffects; now: number}): ApplyReceipt`. `applyBatch` alone inserts, updates, and deletes base rows, letting SQLite allocate integer IDs. It calls `effects.winning(db, before, after, change)` after the write in the same transaction. `before` contains `{rowid: number; body: JsonObject}` or NULL, and `after` contains `{rowid: number}` or NULL for deletion. Effects own no base-row writes.

- [ ] **Step 1: Write the failing tests.** `roam-merge.test.ts` has `three roots converge in every peer order`, `old puts cannot revive tombstones`, `idle forwarding stops log growth`, `foreign first row creates retired membership atomically`, and `home updates require hub origin and monotone epoch`. Assert:

```typescript
expect(replicas.map(portableState)).toEqual([expected, expected, expected]);
expect(logSizesAfterIdle).toEqual(logSizesBeforeIdle);
expect(observeHlc(local, remote, now).count).toBe(expectedCount);
expect(() => applyForeignThenCliWrite()).toThrow("session is frozen");
expect(stateAfterImportRollback).toBeNull();
```

`roam-replay.test.ts` has `lost acknowledgement replays the digest receipt`, `duplicate change ID requires identical canonical envelope`, `losing versions still append once`, `cursor skip overlap and log gap refuse`, `invalid last record leaves all state unchanged`, and `todo conflict replaces only unlogged non-home rows`. Assert unchanged cursor and receipts on each malformed input, equal-clock divergent IDs or content, exactly-at and just-over size limits, non-safe integers, wrong schema, and future skew. A tracked todo collision reports both UUIDs and preserves its tombstone. Parameterize order tests so each stays below five seconds. Add `apply owns base rows and passes deleted rowid to effects` and assert `expect(effectBefore.rowid).toBe(deletedRowid)` and `expect(effectAfter).toBeNull()`.
- [ ] **Step 2: Run red.** `npm test -- --maxWorkers=2 packages/db-core/src/__tests__/roam-merge.test.ts packages/db-core/src/__tests__/roam-replay.test.ts`. Expected: the named missing behavior or export fails.
- [ ] **Step 3: Implement the exports.** Apply in one IMMEDIATE transaction: check cursor or exact receipt, set importing, insert missing retired foreign membership without changing existing state, append every unseen original envelope, write base rows for only winning versions, pass captured before and resulting rowids to derived effects, maintain tombstones and required effects, observe HLC, commit cursor and digest receipt, and clear importing. Dedupe before log insertion, never with `INSERT OR IGNORE`. Equal clocks with different IDs or content are corruption. Preserve per-run event order. New applied run rows have null process and intercom columns even on an origin-store rebuild. Apply homes only from the enrolled hub, reject lower epochs, and require equal-epoch owner and move ID equality. Accept the reserved empty-machine conflict marker only at epoch 1 with null move ID. It is not a launchable Home. A losing memory edit is not field-merged. Cap overflow is a diagnostic, not deletion. Call only `effects.committed` after commit, once for actual changes, never an operational event bus.
- [ ] **Step 4: Run green.** Repeat the red command. Expected: permutations converge, deletes maintain FTS through old rowids, replay leaves rowids, notices, and log counts unchanged.
- [ ] **Step 5: Commit.** `git commit -m "feat(db): apply portable rows and roaming receipts"`.

### Task 1.5: Maintain derived data and inert event history

**Track:** Derived. Depends on 1.3b. Integrates after 1.4b.

**Files:**
- Create: `packages/db-core/src/roam/effects.ts`.
- Create: `packages/db-core/src/roam/event-policy.ts`.
- Create: `packages/db-core/src/__tests__/roam-derived.test.ts`.
- Create: `packages/db-core/src/__tests__/roam-event-policy.test.ts`.
- Create: `packages/memory/src/__tests__/roam-embedding.test.ts`.
- Modify: `packages/memory/src/embeddings/vectors.ts`.

**Interfaces:** Consumes `Db`, shared `Change`, `Entity`, `JsonObject`, and shared `ExportPolicy` and `ReplicaEffects` from `@spider/db-core/roam/types`. Produces structural implementations: `createReplicaEffects(notify: (key: StoreKey) => void): ReplicaEffects`; `createExportPolicy(resolve: (path: string, origin: MachineId) => Locator | HistoryRef): ExportPolicy`; `EVENT_POLICIES: Readonly<Record<string, "inert" | "supervisor" | "transcript" | "chain">>`. Reuse the existing embed queue `(id, text, enqueued_at)` completion guard. Add no `changeId` queue column. `applyBatch` owns base rows and supplies before rowid/body and after rowid to `ReplicaEffects.winning`; effects maintain only derived state.

- [ ] **Step 1: Write the failing tests.** `roam-derived.test.ts` has `winning changes update lexical state transactionally`, `session summaries do not replace imported excerpts`, `unrelated imported FTS rows survive`, and `rollback restores derived state`. Assert:

```typescript
expect(searchOldText()).toEqual([]);
expect(searchWinningText()).toContainEqual(expect.objectContaining({ uuid }));
expect(importedContentAfter).toEqual(importedContentBefore);
expect(notificationTypes).toEqual(["replica-invalidated"]);
```

`roam-event-policy.test.ts` has `known directory payloads become history references`, `chain steps never remain executable`, `unknown types and versions remain inert unchanged`, and `wire content is cached once`. Assert no supervisor directory, transcript directory, endpoint, or token in known sanitized payloads, and `expect(chainBody).toMatchObject({count: 2})`. `roam-embedding.test.ts` has `replica replacement survives stale embedding completion` and asserts the replica path enqueues the newest text and keeps it queued after an older completion. Drive replacement through real `applyBatch`, not queue helpers alone. The new red failure must be missing replica enqueue or invalidation, not an already-existing queue guarantee.

- [ ] **Step 2: Run red.** `npm test -- --maxWorkers=2 packages/db-core/src/__tests__/roam-derived.test.ts packages/db-core/src/__tests__/roam-event-policy.test.ts packages/memory/src/__tests__/roam-embedding.test.ts`. Expected: missing replica enqueue or invalidation, not the existing completion guard.
- [ ] **Step 3: Implement effects and policy.** Use the supplied before and after rowids to maintain external-content todo FTS and active repo memory FTS in the apply transaction, and update sessions FTS name and summary without importing excerpts. Remove stale vectors and enqueue current text transactionally. Retain the existing completion guard, including replica replacements. Keep lexical reads independent of providers. Sanitize `child_supervisor`, `child_transcript`, and `chain_steps` at export, using origin-qualified references. Unknown event types and versions pass through unchanged as history. Add policies for the existing named helpers and dynamic producer types checked in 1.6. No imported event calls `appendRunEvent`.
- [ ] **Step 4: Run green.** Repeat the red command. Expected: pass and failure injection rolls back derived rows with the main row.
- [ ] **Step 5: Commit.** `git commit -m "feat(db): maintain replica search and inert event history"`.

### Task 1.6: Fence operational run consumers and expose blockers

**Track:** Runs. Depends on 1.5 so producer-policy tests import a completed module. Does not edit host files.

**Files:**
- Create: `packages/subagents/src/roam-origin.ts`.
- Create: `packages/subagents/src/blockers.ts`.
- Create: `packages/subagents/src/__tests__/roam-origin.test.ts`.
- Create: `packages/subagents/src/__tests__/roam-producers.test.ts`.
- Modify: `packages/subagents/src/reaper.ts`.
- Modify: `packages/subagents/src/durable-adoption.ts`.
- Modify: `packages/subagents/src/kill.ts`.
- Modify: `packages/subagents/src/run-store.ts`.
- Modify: `packages/subagents/src/runner.ts`.
- Modify: `packages/subagents/src/event-tailer.ts`.
- Modify: `packages/subagents/src/child-registry.ts`.
- Modify: `packages/subagents/src/usage.ts`.
- Modify: `packages/subagents/src/actions/run.ts`.
- Modify: `packages/subagents/src/actions/message.ts`.
- Modify: `packages/subagents/src/run-events.ts`.
- Modify: `packages/subagents/src/child-reporter.ts`.
- Modify: `packages/subagents/src/schemas.ts`.
- Modify: `packages/subagents/src/index.ts`.

**Interfaces:** Consumes `Db`, `MachineId`, and `Blocker`. Produces `isLocalRun(db: Db, runId: string): boolean`, which compares stored run origin to `roam_meta.machine_id`; `listSessionBlockers(db: Db, sessionId: string): readonly Blocker[]`; and `KNOWN_RUN_EVENT_TYPES: readonly string[]`, including every finite dynamic child event variant. Preserve existing public consumer signatures. The inventory reads owning run state and delivery facts only and has no cancellation effect.

- [ ] **Step 1: Write the failing tests.** `roam-origin.test.ts` has `foreign PID and directory collisions cause no operational action`, `origin rebuild cannot adopt sanitized history`, `foreign completion and usage sentinels are history only`, `local completion still delivers once`, and `blocker inventory includes pending pipelines and detached children`. Assert:

```typescript
expect(processSignals).toEqual([]);
expect(adoptedForeign).toEqual([]);
expect(deliveries.map(d => d.runId)).toEqual([localRunId]);
expect(blockers.map(b => b.id)).toEqual(expect.arrayContaining([pausedId, detachedId, pipelineId, unobservedId]));
```

Seed foreign rows whose PID, supervisor directory, and intercom name exactly match unrelated live local fixtures. `roam-producers.test.ts` has `every known producer has an explicit export policy` and `new literal or dynamic producer without policy fails the check`. Assert set equality between producer variants and policy coverage, not just a hard-coded count. Unknown production history still exports.

- [ ] **Step 2: Run red.** `npm test -- --maxWorkers=2 packages/subagents/src/__tests__/roam-origin.test.ts packages/subagents/src/__tests__/roam-producers.test.ts`. Expected: foreign fixture triggers an observable operational call or missing local-origin guards.
- [ ] **Step 3: Implement origin filters at each operational entry.** Guard selection and direct-ID paths for reaping, adoption, kill, status mutation, completion delivery, messaging, usage reporting, and event tailing. A foreign event never revives continuation data. Include pending coordinator stages and undelivered durable completion in the read-only blocker inventory. Centralize dynamic child event variants in the existing schemas and compare the actual producer catalog against db-core's export policy in tests. No runtime db-core import of subagents.
- [ ] **Step 4: Run green.** Repeat the red command and `npm test -- --maxWorkers=2 packages/subagents/src/__tests__`. Expected: native lifecycle remains unchanged and one local completion still reports once.
- [ ] **Step 5: Commit.** `git commit -m "feat(subagents): restrict operational consumers to local run origins"`.

### Task 1.7: Keep usage facts local across segment changes

**Track:** Usage. Depends on 1.2.

**Files:**
- Create: `packages/host/src/usage/schema-v7.ts`.
- Create: `packages/host/src/usage/segments.ts`.
- Create: `packages/host/src/usage/__tests__/roam-migration.test.ts`.
- Create: `packages/host/src/usage/__tests__/roam-segments.test.ts`.
- Create: `packages/host/src/usage/__tests__/roam-discovery.test.ts`.
- Create: `packages/host/src/__tests__/roam-usage-accounting.test.ts`.
- Modify: `packages/host/src/usage/schema.ts`.
- Modify: `packages/host/src/usage/migrate.ts`.
- Modify: `packages/host/src/usage/parse.ts`.
- Modify: `packages/host/src/usage/jsonl-projection.ts`.
- Modify: `packages/host/src/usage/ingest.ts`.
- Modify: `packages/host/src/usage/ledger.ts`.
- Modify: `packages/host/src/usage/discovery.ts`.
- Modify: `packages/host/src/usage-accounting.ts`.

**Interfaces:** Consumes shared `Segment` and `MachineId`, existing `UsageLedger`, `ImportState`, and `UsageAccounting`. Produces `segmentMachine(entry: unknown, previous: MachineId | null): MachineId | null` in `segments.ts`, validating only recognized segment metadata. Extend existing `SourceContext` with `segmentState: {executionMachine: string | null; historyMachine: string | null} | null`, persisted in a versioned wrapper inside the existing `source_context.header` JSON. Decode older unwrapped headers without changing historical facts or shipped SQL, and `CallRow` with `executionMachine: string | null` and `managedEntryKey: string | null`, mapped to `execution_machine` and `managed_entry_key`. Keep path-based call IDs and public parser signatures. Keep `migrateUsageLedger(db: Db): void` identity-free. Inject local identity only at participating ingest. Never backfill, rewrite, or delete existing calls. Both new columns stay NULL on every old row, including duplicate-path facts. Only segment-aware participating ingest sets the managed key. Native DB discovery and `UsageAccounting.unreportedRuns` require the local run origin, including startup restore.

- [ ] **Step 1: Write the failing tests.** Name `migration seven preserves call IDs prices and proof`, `round trip bills each local entry once`, `physical segments ignore selected branch navigation`, `reset caches do not reset managed facts`, `unknown entries preserve parser progress`, and `startup restore ignores foreign runs` across the named files. Assert:

```typescript
expect(after.map(c => [c.id, c.price, c.sourceKind, c.originKey])).toEqual(before.map(c => [c.id, c.price, c.sourceKind, c.originKey]));
expect(localEntryIds.sort()).toEqual(["a1", "a2", "warm-a", "compact-a"].sort());
expect(new Set(localEntryIds).size).toBe(localEntryIds.length);
expect(foreignCharges).toEqual([]);
```

Ingest A, then B, then A physical segments, include compaction and cache-warming calls, change header and path, reset parser caches, and reingest. Add `first marker beyond a slice cannot charge foreign history` and assert zero charges before metadata attribution completes. A malformed recognized marker refuses managed ingest rather than attributing foreign rows locally. Unmanaged historical ingestion retains its existing behavior and leaves the new key NULL. Add `same transcript at two paths preserves old duplicates and reingests once`, `migration seven succeeds on a ledger with duplicate session entry pairs`, `child transcripts sharing parent accounting session do not collide`, `failed v7 leaves version six and reopen never rewrites calls`, and `old usage opener refuses v7 without writes then new ingest catches up`. Snapshot every historical row byte-for-byte before migration and assert equality after migration and reingest. A new managed duplicate path keeps the first fact and emits one diagnostic. Child files use their own header session IDs, not the parent's accounting ID. Assert `expect(oldRowsAfter).toEqual(oldRowsBefore)`, `expect(newManagedCharges).toHaveLength(1)`, and `expect(oldOpenerDigestAfter).toBe(oldOpenerDigestBefore)`. Inject failure after DDL, then reopen and trace SQL to prove no table-wide UPDATE or DELETE runs.

- [ ] **Step 2: Run red.** `npm test -- --maxWorkers=2 packages/host/src/usage/__tests__/roam-migration.test.ts packages/host/src/usage/__tests__/roam-segments.test.ts packages/host/src/usage/__tests__/roam-discovery.test.ts packages/host/src/__tests__/roam-usage-accounting.test.ts`. Expected: missing execution attribution or duplicate-charge assertion fails.
- [ ] **Step 3: Implement migration and segment-aware ingestion.** Append migration 7, update fresh creation and full expected-layout validation, with no data backfill. Do not edit migrations 1 through 6 or rekey calls. Existing duplicates remain valid because only new managed rows get a key.

```sql
ALTER TABLE calls ADD COLUMN execution_machine TEXT;
ALTER TABLE calls ADD COLUMN managed_entry_key TEXT;
CREATE UNIQUE INDEX idx_calls_managed_entry
	ON calls(managed_entry_key) WHERE managed_entry_key IS NOT NULL;
```

Retain the full marker through JSONL projection and compact parsing. The first marker attributes all prior physical entries to `historyMachine`. Later segments use `nextMachine`. Before charging a newly managed or relocated file, perform a bounded metadata-only scan to establish its first marker and history machine. Persist that scan and segment state across slices and process restart. No managed facts are added until initial attribution is known. Then skip foreign segments and already-counted local entries, treating `execution_machine IS NULL` and the local machine equally. Set `managed_entry_key` only for segment-aware participating ingest, as canonical JSON `[localMachine, transcriptSessionId, entryId]`. Resolve transcript identity from its header, including historical source-header context for child rows. Never use a child's parent accounting session ID as its transcript identity. A same-transcript second local path keeps the first fact and logs a diagnostic. Check existing historical rows without updating them. Unmanaged and nonparticipating ingest keep keys NULL and existing path behavior. Historical totals never change. The partial index is a backstop against concurrent managed ingest, not a replacement for the already-counted check. Discover exact local files, never foreign roots. Filter native run discovery, usage events, reported sentinels, and restore paths before accounting. Usage databases and counters stay local.
- [ ] **Step 4: Run green.** Repeat the red command and `npm test -- --maxWorkers=2 packages/host/src/usage/__tests__`. Expected: all pass with unchanged historical call IDs and local-only new charges.
- [ ] **Step 5: Commit.** `git commit -m "feat(usage): attribute roaming transcript segments locally"`.

### Task 1.8: Resolve portable stores and read replicas without checkouts

**Track:** Reads. Depends on 1.4b and 1.5.

**Files:**
- Create: `packages/db-core/src/roam/catalog.ts`.
- Create: `packages/db-core/src/roam/repo-map.ts`.
- Create: `packages/db-core/src/roam/reads.ts`.
- Create: `packages/db-core/src/__tests__/roam-catalog.test.ts`.
- Create: `packages/db-core/src/__tests__/roam-mapping.test.ts`.
- Create: `packages/todo/src/__tests__/roam-reads.test.ts`.
- Create: `packages/memory/src/__tests__/roam-machine-tags.test.ts`.
- Modify: `packages/db-core/src/registry.ts`.
- Modify: `packages/todo/src/actions.ts`.
- Modify: `packages/context/src/search.ts`.
- Modify: `packages/context/src/actions/search.ts`.
- Modify: `packages/memory/src/snapshot.ts`.
- Modify: `packages/host/src/injection-snapshot.ts`.
- Modify: `packages/memory/src/store.ts`.

**Interfaces:** Consumes shared `StoreKey`, `Home`, `Locator`, `HistoryRef`, `Db`, `canonicalOrigin(value: string): string | null`, and `repoIdentity(input: {origin: string | null; roots: readonly string[]; explicitKey?: string}): string`. Produces `resolveSessionReplica(globalDb: Db, sessionId: string): {storeKey: StoreKey; db: Db; home: Home | null} | null`, always read-only; `mapRepository(globalDb: Db, input: {repoKey: string; path: string; worktreeCommand?: readonly string[]}): void`; `mapWorkspace(globalDb: Db, input: {repoKey: string; workspaceId: string; path: string}): void`; `resolveWorkspace(globalDb: Db, repoKey: string, workspaceId: string): string | null`; and `tagMemory(db: Db, uuid: string, machineId: MachineId | null): void`. Also produce `catalogReplica(globalDb: Db, key: StoreKey, replicaDb: Db): void` and `recordLocation(globalDb: Db, input: {sessionId: string; stores: readonly StoreKey[]; home: Home | null; file?: string; cwd?: string}): void`. Catalog registration is idempotent and recomputed after committed imports or interrupted registration. Consumes the already-migrated local `roam_repo_maps`, `roam_workspace_maps`, and `roam_locations` tables and their 1.2 column names. They never enter descriptors or wire records.

- [ ] **Step 1: Write the failing tests.** Name `hub reads box-created session without a checkout`, `default search retains current worktree scope`, `mapping merges versions tombstones and retains redirect`, `fallback roots cache until explicit refresh`, `origin change requires explicit map`, `ambiguous discovery refuses transfer`, and `machine tags filter injection without editing prose`. Assert:

```typescript
expect(viewedTodos).toEqual(remoteTodos);
expect(replicaDb.raw.readonly).toBe(true);
expect(defaultSearchStoreKeys).toEqual([currentStoreKey]);
expect(mappedVersions).toEqual(unmappedVersions);
expect(rootWalkCallsAfterRepeatedLookup).toBe(1);
expect(injectedUuids).toEqual([allMachinesUuid, thisMachineUuid]);
```

Unavailable historical locators display their origin even if a matching local path exists. Verify explicit fallback refresh and repository replacement require a mapping decision. A linked worktree gets a distinct workspace UUID and shares repo memory.

- [ ] **Step 2: Run red.** `npm test -- --maxWorkers=2 packages/db-core/src/__tests__/roam-catalog.test.ts packages/db-core/src/__tests__/roam-mapping.test.ts packages/todo/src/__tests__/roam-reads.test.ts packages/memory/src/__tests__/roam-machine-tags.test.ts`. Expected: missing catalog resolution or foreign injection failure.
- [ ] **Step 3: Implement catalog and adapters.** Only the hub stores unmapped replicas at `<globalRoot>/roam/stores/<store-key-hash>.db`. Resolve placement from local maps, never foreign `projects` rows or wire paths. The catalog records portable stores, latest home, and optional local exact file and cwd. Resolve authoritative homes from `session_homes`, not a stale cached location. Never turn a replica read into a registration write. Session-addressed todo views, session search, and run history use read-only replicas. Later mapping merges envelopes and verifies versions and tombstones before retaining a read-only redirect. Cache sorted-root fallback per common repository. Discovery stays within configured roots, and one workspace maps to one checkout per machine. Non-Git data requires an explicit store key and cannot use automatic workspace transfer. Memory NULL tags apply everywhere. Tag changes only the tag. Doctor's likely-machine-specific report is read-only.
- [ ] **Step 4: Run green.** Repeat the red command. Expected: remote reads work without creating a checkout, and default local search does not broaden.
- [ ] **Step 5: Commit.** `git commit -m "feat(db): resolve read-only portable replicas and local maps"`.

### Task 1.9a: Claim participant session-ID locks with liveness proof

**Track:** Locks. Depends only on 1.1. Runs in parallel with Data.

**Files:**
- Create: `packages/herdr/src/sessions/id-lock.ts`.
- Create: `packages/herdr/src/__tests__/id-lock.test.ts`.

**Interfaces:** Uses existing Herdr `ProcessIdentity` and `ProcessProbe`, not the roaming versions. Produces `claimIdLock(root: string, sessionId: string, identity: ProcessIdentity, probe: (pid: number) => Promise<ProcessProbe>): Promise<{release(): Promise<void>; transfer(next: ProcessIdentity): Promise<void>}>`. Host and later launchers share it. The caller only invokes it for participating sessions.

- [ ] **Step 1: Write the failing tests.** `id-lock.test.ts` names `same ID different file still has one owner`, `stale ID lock from a killed process is reclaimed`, `PID reuse or unknown ownership refuses`, and `handoff retains one owner`. Assert `await expect(secondIdLockClaim).rejects.toThrow(/owner/)`, `expect(reclaimed.identity).toEqual(nextIdentity)`, and `expect(unknownOwnerWrites).toBe(0)`. Inject identity probes for boot changes and start-time reuse, with no real boot-ID reads.
- [ ] **Step 2: Run red.** `npm test -- --maxWorkers=2 packages/herdr/src/__tests__/id-lock.test.ts`. Expected: the named missing behavior or export fails.
- [ ] **Step 3: Implement the exports.** Serialize liveness checks under a short process lock. Reclaim only proved absent identities, never PID mismatch or uncertainty alone. Persist and transfer the private ID lock using existing ownership conventions; preserve canonical-file leases as the separate file-level guard.
- [ ] **Step 4: Run green.** Repeat the red command. Expected: stale killed-process ownership is reclaimed and reused or uncertain PIDs cannot authorize a second owner.
- [ ] **Step 5: Commit.** `git commit -m "feat(herdr): lock participating session identities"`.

### Task 1.9b: Admit participants before ordinary startup and record build capability

**Track:** Host. Depends on 1.6, 1.7, 1.8, and 1.9a.

**Files:**
- Create: `packages/host/src/roam/activation.ts`.
- Create: `packages/host/src/roam/admission.ts`.
- Create: `packages/host/src/__tests__/roam-admission.test.ts`.
- Create: `packages/host/src/__tests__/roam-startup-order.test.ts`.
- Create: `packages/host/src/__tests__/roam-pi-contract.test.ts`.
- Modify: `packages/host/src/extension.ts`.
- Modify: `packages/host/src/hooks.ts`.
- Modify: `packages/host/src/loop/index.ts`.
- Modify: `packages/host/src/organism-runtime.ts`.
- Modify: `packages/host/src/embedding-runtime.ts`.
- Modify: `packages/host/src/agents/mount.ts`.
- Modify: `packages/host/src/herdr/mount.ts`.
- Modify: `packages/host/src/usage/mount.ts`.
- Modify: `packages/host/src/routing/index.ts`.
- Modify: `packages/organism/src/index.ts`.
- Modify: `packages/herdr/src/sessions/presence.ts`.
- Modify: `packages/herdr/src/sessions/register.ts`.
- Modify: `packages/host/src/herdr/ports.ts`.
- Create: `packages/host/src/roam/build-presence.ts`.
- Create: `packages/host/src/__tests__/roam-build-presence.test.ts`.

**Interfaces:** Consumes shared `AdmissionPorts`, `AdmissionGate`, `Home`, `SessionState`, blockers, and the completed Herdr ID lock. Produces `registerAdmission(pi: ExtensionAPI, ports: AdmissionPorts): AdmissionGate`; `ordinaryWorkAllowed(): boolean`; and generic process-presence build metadata through the existing Herdr session registry. Admission uses `localMachine(): Promise<MachineId>`, `knownParticipant(sessionId): boolean`, `warnOnce(sessionId, reason): void`, `load(sessionId)` with explicit `participating`, and `lock(sessionId, file)`. Host records its actual `LOADED_BUILD` and roaming schema capability on every top-level `createProcessPresence` record, including non-HC sessions and reloads. Preserve older presence decoding: absent capability means older, never compatible by default. Export a pi-independent reader in 2.5c, not a host import into roam. Append optional fifth `admitted?: () => boolean` to `registerOrganism`, preserving its first four arguments. Organism never imports host.

- [ ] **Step 1: Write the failing tests.** `roam-startup-order.test.ts` names `admission finishes before first session upsert`, `blocked startup calls no reaper usage trigger feed or organism`, and `nonparticipating sessions keep existing startup without ID lock`. `roam-admission.test.ts` parameterizes nonowner refusal across input, agent start, turn start, tools, shell, scheduler, messages, notices, and warming. Add `all stores must be active`, `unfinished freeze blocks despite active rows`, `reload cannot clear frozen state`, `admission read failure on a nonparticipating session admits and logs`, and `known participant read or lock failure blocks plainly`. Assert `expect(startupCalls).toEqual(["admission"])`, `expect(providerRequests).toBe(0)`, `expect(dbWritesAfterBlock).toBe(0)`, `expect(nonparticipantIdLockCalls).toBe(0)`, and `expect(warnings).toHaveLength(1)` across repeated failures. Read failure includes missing `machine.json` and exhausted busy retries. `roam-pi-contract.test.ts` follows `packages/host/src/loop/__tests__/security-sdk.test.ts`: real pinned SDK and synthetic provider, abort before provider request, public pending-message and leaf APIs, no mocked event runner. `roam-build-presence.test.ts` proves actual loaded build recording for non-HC top-level sessions and legacy missing-field decoding. A copied nonparticipating Mac file on a fresh box remains the documented exception.
- [ ] **Step 2: Run red.** `npm test -- --maxWorkers=2 packages/host/src/__tests__/roam-admission.test.ts packages/host/src/__tests__/roam-startup-order.test.ts packages/host/src/__tests__/roam-pi-contract.test.ts packages/host/src/__tests__/roam-build-presence.test.ts`. Expected: the named missing behavior or export fails.
- [ ] **Step 3: Implement the exports.** Register admission first, before scheduler registration. Load with `withRetry` from affected worktree `roam_sessions`, global `session_homes`, and fixed `<globalRoot>/roam/journal.db`. The freeze journal is absent and empty until 4.3b; read-only absence is not an error. Empty home-machine markers mean `initialConflict`, not an assigned Home. Participation means any membership or home row. On a successful no-row read, take no ID lock and install no session admission gate. On read failure with no known participation, continue ordinary work and warn once. Defer machine identity resolution until participation is known. A known participant blocks on read, identity, or lock failure with `Cannot verify this session's home. Retry or run spider roam doctor.` Never turn uncertainty for a known participant into nonparticipation.

Publish one module-local activation flag, not an async coordinator. Later startup consumers check it before work. Participants require both locks, active state in every store, compatible epoch and local home or matching initial origin, no freeze, no conflict, and safe store capture. Preserve offline active homes, never clear frozen or retired state from cached home. Frozen source stays control-only. Handle blocked input with a home message, abort agent starts, and return native tool and shell blocks. Suppress frozen shutdown consolidation. No refusal falls through to ordinary work. Presence registration is diagnostic bookkeeping independent of ordinary startup, so even blocked older processes remain visible to the enable check.
- [ ] **Step 4: Run green.** Repeat the red command. Run touched startup, loop, usage, organism, and Herdr presence suites with `--maxWorkers=2`. Expected: zero nonparticipant ID locks, safe error policy, and build-capability records before enable checks.
- [ ] **Step 5: Commit.** `git commit -m "feat(host): admit participants and publish loaded build capability"`.

### Task 1.10: Compose and gate local replication

**Track:** Host. Depends on all phase 1 tasks.

**Files:**
- Create: `packages/host/src/__tests__/roam-local-acceptance.test.ts`.
- Create: `docs/architecture/roaming.md`.
- Modify: `docs/architecture/README.md`.

**Interfaces:** Consumes `exportBatch(db: Db, request: {after: number; targetBytes: number; batchId: string}, policy: ExportPolicy): Promise<BatchArtifact>`, `validateBatch(artifact: BatchArtifact, expected: {storeKey: StoreKey; senderMachine: MachineId; senderStream: string; now: number}): Promise<ValidatedBatch>`, `applyBatch(db: Db, batch: ValidatedBatch, options: {hubMachine: MachineId; effects: ReplicaEffects; now: number}): ApplyReceipt`, `createReplicaEffects(notify: (key: StoreKey) => void): ReplicaEffects`, and `createExportPolicy(resolve: (path: string, origin: MachineId) => Locator | HistoryRef): ExportPolicy`. The test composes these real db-core exports directly. Add no unused host wrapper or extension registration; production roam consumes db-core directly.

- [ ] **Step 1: Write the failing test.** `roam-local-acceptance.test.ts` has `A2 through A7 compose across independent roots`, with short parameterized scenarios using real migrations and effects. Assert `expect(replicaState).toEqual(expectedState)`, `expect(foreignOperationalCalls).toEqual([])`, and `expect(foreignCharges).toEqual([])`. Include a foreign first import followed by function-free CLI insert, update, and delete attempts. Also replay the exact baseline writer fixture from 1.3a so CLI and raw-connection proxies do not replace actual writer compatibility. Fail loudly if sqlite3 <3.42; CI installs it in 1.3a.
- [ ] **Step 2: Run red.** `npm test -- --maxWorkers=2 packages/host/src/__tests__/roam-local-acceptance.test.ts`. Expected: real cross-package composition assertions fail before all dependencies are integrated.
- [ ] **Step 3: Bind the real ports and document the boundary.** Record nonreplicated state, rollout order, schema floor, diagnosed duplicate repair, and disabled defaults. No remote scheduling or hosting starts in phase 1.
- [ ] **Step 4: Run green and the common phase gate.** Expected: A2 through A7 evidence from actual fixtures, no unguarded foreign run consumer, and no new service. Deploy schema and guard-compatible consumers with roaming disabled.
- [ ] **Step 5: Commit.** `git commit -m "feat(roam): gate local replication with guarded consumers"`.

## Phase 2: Transport and hub

### Task 2.1: Add the roaming package, durable operations, and CLI entry

**Track:** Service. Starts only after phase 1 is deployed disabled. Integrate 2.1 before the other tracks start; the same writer returns for 2.5b, 2.5c, and 2.6.

**Files:**
- Create: `packages/roam/package.json`.
- Create: `scripts/build-roam.mjs`.
- Create: `vite.roam.config.mjs`.
- Create: `packages/roam/src/contracts.ts`.
- Create: `packages/roam/src/index.ts`.
- Create: `packages/roam/src/config.ts`.
- Create: `packages/roam/src/journal.ts`.
- Create: `packages/roam/src/cli.ts`.
- Create: `packages/roam/src/supervisor-main.ts`.
- Create: `packages/roam/src/__tests__/journal.test.ts`.
- Create: `packages/roam/src/__tests__/cli-package.test.ts`.
- Modify: `package.json`.
- Modify: `package-lock.json`.
- Modify: `packages/host/package.json`.
- Modify: `scripts/check-package-files.cjs`.

**Interfaces:** Consumes shared database types through explicit db-core subpaths. The package depends only on db-core, generic Herdr, and existing libraries, never host or pi. Produces these exports from `@spider/roam/contracts`:

The complete produced types are in Global Constraints. Implement that one authoritative declaration set.

Also produce `DEFAULT_LIMITS: Readonly<Limits>`, `loadConfig(file: string): RoamConfig`, `openJournal(file: string): Journal`, and `main(argv: readonly string[], io: {out(text: string): void; err(text: string): void}): Promise<number>`. `Journal` stores canonical argument digests and durable action results in a private local SQLite journal, never a portable DB table. CLI parsing is lazy and does not import host or pi.

- [ ] **Step 1: Write the failing tests.** `journal.test.ts` has `same operation returns its durable result`, `changed arguments under one ID refuse before effect`, and `restart preserves pending actions`. `cli-package.test.ts` has `help opens no DB and makes no hc call`, `box rejects outbound peers`, `invalid arguments exit two`, and `packed entries have no pi imports`. Assert:

```typescript
expect(second.begin(operation)).toMatchObject({kind: "done", result});
expect(() => journal.begin(changed)).toThrow(/arguments/);
expect(helpExit).toBe(0);
expect(openedDbs).toBe(0);
expect(hcCalls).toEqual([]);
```

Cover aliases containing shell punctuation, missing absolute executable paths, invalid limits, and secret-bearing config diagnostics. Limits exceeding defaults require an explicit configured value, not adaptation.

- [ ] **Step 2: Run red.** `npm test -- --maxWorkers=2 packages/roam/src/__tests__/journal.test.ts packages/roam/src/__tests__/cli-package.test.ts`. Expected: package entries are missing.
- [ ] **Step 3: Implement package and journal.** Match workspace package conventions with `./*` exports and a side-effect-free index, add only local workspace lock entries, and build executable `dist/roam/cli.mjs` and `dist/roam/supervisor.mjs`. Add `bin.spider` pointing to the CLI and the build to root scripts. Create the worktree-local `node_modules/@spider/roam` workspace link if absent, pointing to `../../packages/roam`; never link the entire node_modules directory. Until phase 3, the supervisor entry supports side-effect-free help and explicitly refuses hosting rather than importing a missing implementation. The CLI initially exposes implemented status, mapping, memory-tag, and internal artifact commands only. Future command names may be described in help but refuse as unavailable, never execute a stub. A box config has no peers. Preserve strict argument validation and stable outcome codes. Journal before effects and reconcile a pending operation instead of inventing a replacement ID. Bundle native SQLite as external, and prohibit pi imports in the roaming package.
- [ ] **Step 4: Run green.** Repeat the red command, then `npm run build`, `node dist/roam/cli.mjs --help`, and `npm pack --dry-run --json --ignore-scripts | node scripts/check-package-files.cjs`. Expected: exit 0, both entries packaged, executable CLI, no DB or hc activity on help.
- [ ] **Step 5: Commit.** `git commit -m "feat(roam): add standalone CLI and durable operation journals"`.

### Task 2.2: Add generic byte-exact Herdr transport

**Track:** Transport. Depends on 2.1. Can run with Artifacts.

**Files:**
- Create: `packages/herdr/src/client/bytes.ts`.
- Create: `packages/herdr/src/client/argv-client.ts`.
- Create: `packages/roam/src/transport.ts`.
- Create: `packages/herdr/src/__tests__/roam-transport.test.ts`.
- Create: `packages/herdr/src/__tests__/roam-deadlines.test.ts`.
- Modify: `packages/herdr/src/client/cli-transport.ts`.
- Modify: `packages/herdr/src/contracts.ts`.
- Modify: `packages/herdr/src/__tests__/fake-hc.mjs`.
- Modify: `packages/herdr/src/__tests__/testutil.ts`.

**Interfaces:** The roaming adapter consumes `Transport`, `Peer`, and `CallOptions` from 2.1. Generic Herdr produces `invokeBytes(binary: string, argv: readonly string[], env: Readonly<NodeJS.ProcessEnv>, options: {timeoutMs: number; maxBytes: number; stdin?: Buffer}): Promise<Buffer>` and `createArgvClient(options: HcClientOptions): {exec(on: string, argv: readonly string[], options: {timeoutMs: number; maxBytes: number; stdin?: Buffer}): Promise<Buffer>; run(on: string, argv: readonly string[], labels: Readonly<Record<string, string>>): Promise<{terminal: string}>}`. Herdr imports no roaming types or runtime. Roaming `createTransport(options: {binary: string; env: Readonly<NodeJS.ProcessEnv>; enrolled: readonly Peer[]}): Transport` composes that generic client. `resolve` verifies alias, enrolled UUID, and core once; all calls during that transfer use the returned immutable peer handle without re-resolution. Keep existing JSON invocation unchanged. Add fixture support for raw stdin and binary stdout without changing ordinary fake behavior.

- [ ] **Step 1: Write the failing tests.** Name `binary read never passes through JSON or UTF8`, `remote argv cannot fall back locally`, `resolves one machine identity per transfer`, `background launch receipt is not completion`, and `each command uses its own explicit deadline`. Assert:

```typescript
expect(received).toEqual(Buffer.from([0, 255, 10, 128]));
expect(execArgv).toEqual(["exec", "--on", peer.alias, "--", peer.node, peer.cli, ...remoteArgs]);
expect(runArgv).toEqual(expect.arrayContaining(["--bg", "--no-notify", "--outlive-parent", "--no-parent"]));
expect(deadlines).toEqual([30_000, 60_000, 120_000, 600_000]);
expect(localPayloadExecutions).toBe(0);
```

Use fake time for timeout tests and verify a changed core invalidates an observation without changing enrollment. Unknown or revoked machine aliases refuse before payload launch.

- [ ] **Step 2: Run red.** `npm test -- --maxWorkers=2 packages/herdr/src/__tests__/roam-transport.test.ts packages/herdr/src/__tests__/roam-deadlines.test.ts`. Expected: raw byte API absent.
- [ ] **Step 3: Implement byte transport.** Invoke the pinned remote CLI by argv through `hc exec --on`. Raw reads use `cat` through the byte path and raw writes use stdin to `hc file write`. Keep 1 MiB reply checks and the explicit file, control, export, import, and launch deadlines. Resolve the enrolled identity once at transfer start and retain that peer handle. Operations above the 600-second direct maximum use labelled background runs and operation receipts. The terminal returned by `hc run` never means operation completion. Do not add a listener, shell interpolation, SSH path, or JSON binary conversion.
- [ ] **Step 4: Run green.** Repeat the red command and existing cli-transport tests. Expected: byte-for-byte equality and zero local execution after all injected remote failures.
- [ ] **Step 5: Commit.** `git commit -m "feat(herdr): support byte-exact roaming transport"`.

### Task 2.3a: Transfer immutable chunks with private staging quotas

**Track:** Artifacts. Depends on 2.1. Can run with Transport.

**Files:**
- Create: `packages/roam/src/artifacts.ts`.
- Create: `packages/roam/src/staging.ts`.
- Create: `packages/roam/src/__tests__/artifacts.test.ts`.
- Create: `packages/roam/src/__tests__/staging.test.ts`.

**Interfaces:** Consumes shared `ArtifactManifest`, `Transport`, `Peer`, `Limits`, `Journal`, and `Outcome`. Produces `stageArtifact(file: string, kind: ArtifactManifest["kind"], limits: Limits): Promise<ArtifactManifest>` and `transferArtifact(peer: Peer, manifest: ArtifactManifest, ports: {transport: Transport; journal: Journal; limits: Limits; root: string}): Promise<Outcome<{file: string}>>`. Assembly uses private artifact IDs, never batch-supplied paths.

- [ ] **Step 1: Write the failing tests.** Name `streams a binary and session artifact above 64 MiB`, `resume reuses verified immutable chunks`, `missing truncated misindexed or corrupt chunks cannot install`, `manifest pages obey byte and digest bounds`, `quota and disk-full retain referenced evidence`, `symlink replacement cannot escape private staging`, and `restart resumes private reconstruction`. Assert:

```typescript
expect(installedDigest).toBe(sourceDigest);
expect(largestChunk).toBeLessThanOrEqual(384 * 1024);
expect(largestReply).toBeLessThanOrEqual(1024 * 1024);
expect(resentChunkIndexes).not.toContain(alreadyVerifiedIndex);
expect(cursorAfterCorruption).toBe(cursorBefore);
expect(referencedStagingStillExists).toBe(true);
```

Use deterministic streaming bytes rather than a 65 MiB context string. Separate cases for each corruption and boundary keep tests below five seconds. Include ENOSPC, foreign-owned targets, path traversal, conflicting artifact IDs, transfer expiry, and restart during reconstruction.
- [ ] **Step 2: Run red.** `npm test -- --maxWorkers=2 packages/roam/src/__tests__/artifacts.test.ts packages/roam/src/__tests__/staging.test.ts`. Expected: the named missing behavior or export fails.
- [ ] **Step 3: Implement the exports.** Hash raw 384 KiB chunks and digest-linked manifest pages. Enforce per-kind limits and 4 GiB total staging including reconstruction. Receive by exclusive create into private staging, verify all lengths and hashes, fsync, then atomic rename. Journal arguments before effects and cache results by operation ID. Retry only the same immutable chunk after 1, 2, and 4 seconds. A 30-minute transfer expiry is pending, not failure or fresh import. Keep referenced incomplete staging across restart. Expire only seven-day-old unreferenced staging, and remove committed artifacts only after receipt verification. Quota errors name their directory, never delete workspaces or DB history. Import and export return only committed evidence.
- [ ] **Step 4: Run green.** Repeat the red command. Expected: streamed digest equality, retained referenced evidence, and resumed transfer of only missing chunks.
- [ ] **Step 5: Commit.** `git commit -m "feat(roam): stage and transfer bounded immutable artifacts"`.

### Task 2.3b: Dispatch agent operations with durable receipts

**Track:** Artifacts. Depends on 2.3a.

**Files:**
- Create: `packages/roam/src/agent.ts`.
- Create: `packages/roam/src/__tests__/agent.test.ts`.

**Interfaces:** Consumes shared `Operation`, `Outcome`, `AgentPorts`, db-core export/validate/apply APIs, and 2.3a artifacts. Produces `handleAgentOperation(operation: Operation, ports: AgentPorts): Promise<Outcome<JsonObject>>`. Inventory, export, import, cursors, receipts, split, assemble, and `enable-capture` dispatch here. No root CLI or Herdr edits.

- [ ] **Step 1: Write the failing tests.** `agent.test.ts` names `lost import result reconciles exact receipt`, `same operation returns committed evidence`, `changed arguments refuse before effects`, and `agent accepts private artifact IDs not wire paths`. Assert `expect(replayedReceipt).toEqual(firstReceipt)`, `expect(cursorAfterRetry).toBe(committedThrough)`, `expect(applyCalls).toBe(1)`, and `expect(openedPaths).not.toContain(wirePath)`. Malformed commands, wrong machine, wrong epoch, and uncommitted results leave journal receipts and store cursors unchanged.
- [ ] **Step 2: Run red.** `npm test -- --maxWorkers=2 packages/roam/src/__tests__/agent.test.ts`. Expected: the named missing behavior or export fails.
- [ ] **Step 3: Implement the exports.** Validate boundaries and journal arguments before effects. Reconcile pending work from exact receipts. Lost results never invent import IDs or advance unapplied cursors. `enable-capture` calls `enableMemoryCapture` only for validated StoreKeys and capture-safe layouts. Preserve deadlines and outcome codes.
- [ ] **Step 4: Run green.** Repeat the red command. Expected: idempotent dispatch, exact receipt replay, and zero path escape.
- [ ] **Step 5: Commit.** `git commit -m "feat(roam): dispatch agent operations with durable evidence"`.

### Task 2.4: Synchronize peers through the hub

**Track:** Hub. Depends on 2.2 and 2.3b.

**Files:**
- Create: `packages/roam/src/sync.ts`.
- Create: `packages/roam/src/homes.ts`.
- Create: `packages/roam/src/__tests__/homes.test.ts`.
- Create: `packages/roam/src/stores.ts`.
- Create: `packages/roam/src/__tests__/stores.test.ts packages/roam/src/__tests__/homes.test.ts`.
- Create: `packages/roam/src/peer-state.ts`.
- Create: `packages/roam/src/barriers.ts`.
- Create: `packages/roam/src/__tests__/sync.test.ts`.
- Create: `packages/roam/src/__tests__/barriers.test.ts`.

**Interfaces:** Produces `assignInitialHome(db: Db, sessionId: string, originMachine: MachineId, hubMachine: MachineId): Home | "conflict"`; `markInitialConflict(db: Db, sessionId: string, hubMachine: MachineId): void`; and `casHome(db: Db, expected: Home, nextMachine: MachineId, moveId: string, hubMachine: MachineId): Home`. Initial insert-if-absent assigns epoch 1 only after sync has gathered all observed origins. Conflicting unassigned origins insert the reserved empty-machine home marker. `casHome` and its `roam_home_actions` receipt share one global transaction and reject cancelled actions. Assigned homes never become unassigned or get claimed. Consumes `Transport`, `RoamConfig`, `Peer`, `Clock`, `Journal`, shared `StoreKey`, `StoreBarrier`, `ApplyReceipt`, and the artifact agent operation interface. Produces `createStorePort(config: RoamConfig, globalDb: Db): StorePort`, consuming `catalogReplica(globalDb: Db, key: StoreKey, replicaDb: Db): void`, the shared database ports, and local mapping tables. Also produces `createSync(ports: {config: RoamConfig; globalDb: Db; transport: Transport; journal: Journal; clock: Clock; stores: StorePort}): SyncService`. `StorePort` has `list(peer: MachineId): readonly StoreKey[]`, `cursor(key: StoreKey, machine: MachineId, stream: string): number`, `accept(key: StoreKey, artifact: BatchArtifact): Promise<ApplyReceipt>`, and `export(key: StoreKey, after: number, targetBytes: number, batchId: string): Promise<BatchArtifact>`. `SyncService` has `start(): void`, `stop(): void`, `sync(peer?: MachineId): Promise<readonly Outcome<ApplyReceipt>[]>`, and `barriers(peer: MachineId, required: readonly StoreBarrier[]): Promise<boolean>`.

- [ ] **Step 1: Write the failing tests.** Name `startup pulls before pushing merged changes`, `one unavailable peer does not stall another`, `one transfer per peer and at most two peers`, `handshake mismatch mutates nothing`, `empty exports allocate no receipt`, `adaptive bytes include lexical apply duration`, and `move barriers wait for every store`. In `stores.test.ts`, name `store adapter catalogs only committed sessions and ignores wire paths` and assert `expect(catalogKeys).toEqual(expectedPortableKeys)` and `expect(openedPaths).not.toContain(foreignPath)`. Assert:

```typescript
expect(order).toEqual(["pull", "apply", "push"]);
expect(maxConcurrentByPeer).toBe(1);
expect(maxConcurrentPeers).toBe(2);
expect(retryDelays).toEqual([30_000, 60_000, 120_000, 120_000]);
expect(await sync.barriers(peerId, required)).toBe(false);
```

Include a core restart during a lost response, same enrolled machine with a changed core, count-zero batch, byte-singleton rows, and a quarantined store alongside a healthy store. `homes.test.ts` names `initial assignment is insert-if-absent at epoch one`, `conflicting unassigned origins replicate a blocking marker`, `CAS increments every forward and rollback epoch`, `equal epoch cannot change owner or move ID`, and `cancelled action cannot commit later`. Assert `expect(firstHome.epoch).toBe(1)`, `expect(conflictMarker.machine_id).toBe("")`, and `expect(nextHome.epoch).toBe(firstHome.epoch + 1)`. A later copied foreign origin cannot rewrite an assigned home. Record export and import durations on small actual SQLite fixtures for A1, without treating failed calls as timing samples.

- [ ] **Step 2: Run red.** `npm test -- --maxWorkers=2 packages/roam/src/__tests__/sync.test.ts packages/roam/src/__tests__/barriers.test.ts packages/roam/src/__tests__/stores.test.ts packages/roam/src/__tests__/homes.test.ts`. Expected: sync exports missing.
- [ ] **Step 3: Implement sync and barrier reconciliation.** Bind StorePort to real db-core codecs, apply effects, local map resolution, and idempotent catalog registration. Register after committed apply and reconcile registration after restart; never acknowledge an uncommitted cursor. Handshake protocol 1, schema 14, enrolled machine, and current core before mutation. The hub pulls then pushes, retaining original envelopes. Boxes receive global memory, mapped repo memory, and worktree stores they host or prepare to host. Hub keeps all participating stores, including unmapped stores. Collect observed origins before initial assignment. Agreeing origins use `assignInitialHome` at epoch 1. Conflicting unassigned origins use `markInitialConflict`, a hub-origin empty-machine marker in global `session_homes`; replicate it to boxes and read it locally in admission. Existing assigned homes are never reset by conflicting copies. Global hub capture must be enabled in 2.6 so both assignments and conflict markers replicate. Schedule first sync at startup, then every two minutes per peer. Retry disconnected peers independently. Adjust the 4 MiB target using committed apply duration including lexical work, never a record cap or transaction deadline. Singleton large rows must fit the 16 MiB whole-batch limit. Reconcile receipts after uncertain commands, and never replace them with a new operation.
- [ ] **Step 4: Run green.** Repeat the red command. Expected: independent progress, committed cursor barriers, bounded concurrency, and idle log sizes unchanged.
- [ ] **Step 5: Commit.** `git commit -m "feat(roam): synchronize enrolled peers through the hub"`.

### Task 2.5a: Reconcile terminal placement through generic Herdr

**Track:** Placement. Depends on 2.1. Can run in parallel with 2.4.

**Files:**
- Create: `packages/herdr/src/roam-placement.ts`.
- Create: `packages/herdr/src/__tests__/roam-placement.test.ts`.

**Interfaces:** Consumes shared structural `PlacementPort` and `Readiness`, using existing Herdr types only. Produces `createRoamPlacement(options: {app: AppClient | null; hc: HcClient; registry: TerminalRegistry}): PlacementPort`. Herdr imports neither pi nor roam.

- [ ] **Step 1: Write the failing tests.** `roam-placement.test.ts` names `closed app and core never auto-start`, `placement reconciles each new terminal once`, and `pending placement survives app closure`. Assert `expect(startAppOrCoreCalls).toEqual([])`, `expect(placements).toEqual([newTerminal])`, and `expect(pending).toEqual([unplacedTerminal])`. Reconnect observes a changed terminal ID without launching another pi.
- [ ] **Step 2: Run red.** `npm test -- --maxWorkers=2 packages/herdr/src/__tests__/roam-placement.test.ts`. Expected: the named missing behavior or export fails.
- [ ] **Step 3: Implement the exports.** Reconcile reported live terminals into their machine space, including new IDs after restart. App absence defers placement, core absence reports unavailable transport, and neither starts automatically. Return durable pending IDs for the hub to retain. Never launch pi for placement.
- [ ] **Step 4: Run green.** Repeat the red command. Expected: one placement per terminal and no application, core, or pi launch.
- [ ] **Step 5: Commit.** `git commit -m "feat(herdr): reconcile roaming terminal placement"`.

### Task 2.5b: Run the locked standalone hub and injected launchd service

**Track:** Service. Depends on 2.4 and 2.5a.

**Files:**
- Create: `packages/roam/src/hub.ts`.
- Create: `packages/roam/src/launchd.ts`.
- Create: `packages/roam/src/control-socket.ts`.
- Create: `packages/roam/src/__tests__/hub.test.ts`.
- Create: `packages/roam/src/__tests__/launchd.test.ts`.

**Interfaces:** Consumes shared `HubPorts`, `SyncService`, `PlacementPort`, `Clock`, `Journal`, and config. Produces `runHub(ports: HubPorts): Promise<{stop(): Promise<void>}>` and `installHubService(input: {node: string; cli: string; globalRoot: string}, ports: {plistDir: string; launchctl(argv: readonly string[]): Promise<void>}): Promise<void>`. All plist paths, service execution, and process probes are injected.

- [ ] **Step 1: Write the failing tests.** `hub.test.ts` names `second hub refuses the process lock`, `unreachable home notifies once and clears on recovery`, and `disable refuses an in-progress home change`. Assert `await expect(secondHub).rejects.toThrow(/lock/)` and `expect(noticesAfterTenMinutes).toHaveLength(1)`. `launchd.test.ts` names `enable writes resolved absolute executable paths` and `enable repairs changed supported Node path`. Assert `expect(plist).toMatchObject({RunAtLoad: true, KeepAlive: true})` and `expect(writtenPlistDir).toBe(fixtureDir)`. Fake time for notices and sync; fake launchctl, plist directory, and ownership probes. Tests never write to real LaunchAgents or invoke launchctl.
- [ ] **Step 2: Run red.** `npm test -- --maxWorkers=2 packages/roam/src/__tests__/hub.test.ts packages/roam/src/__tests__/launchd.test.ts`. Expected: the named missing behavior or export fails.
- [ ] **Step 3: Implement the exports.** Install a launchd user plist through the injected directory and launchctl port, resolved absolute Node/CLI paths, private logs, process lock, RunAtLoad, and KeepAlive. Never rely on a version manager. Sync runs without pi or an app and never starts the Mac core. Reconcile placement after sync and retain pending placement and one unreachable/suspension notice across restarts. Clear warning on recovery. Use the private socket for local hub controls.
- [ ] **Step 4: Run green.** Repeat the red command. Expected: one hub, private fixture-only service writes, durable pending state, and zero real service calls.
- [ ] **Step 5: Commit.** `git commit -m "feat(roam): run a locked hub through injected service ports"`.

### Task 2.5c: Report read-only status and enforce build and SQLite floors

**Track:** Service. Depends on 2.5b.

**Files:**
- Create: `packages/roam/src/diagnostics.ts`.
- Create: `packages/roam/src/__tests__/diagnostics.test.ts`.
- Modify: `packages/roam/src/cli.ts`.

**Interfaces:** Consumes shared `Diagnostic`, config, home state, and generic Herdr process-presence APIs. Produces `doctorLocal(config: RoamConfig, ports: DiagnosticPorts): Promise<readonly Diagnostic[]>` and `assertCompatibleConsumers(config: RoamConfig, ports: DiagnosticPorts): Promise<void>`. `DiagnosticPorts` injects presence listing and process probes, bundled SQLite and CLI version probes, filesystem executable checks, and usage-worker observation. The named enable mechanism is the existing Herdr session-registry `createProcessPresence(...).list()` with PID/start-identity liveness and the loaded-build capability recorded by 1.9b. No host import into roam.

- [ ] **Step 1: Write the failing tests.** `diagnostics.test.ts` names `enable refuses an older live top-level build`, `legacy missing build capability refuses until reload`, `non-HC top-level sessions are included`, `dead presence does not block`, `uncertain owner cannot authorize enable`, `old usage worker requires reload`, `doctor checks bundled and CLI SQLite floors`, `trigger drift reports disabled capture without repair`, and `late local writer reports epoch without memory repair`. Assert `expect(enableServiceCalls).toBe(0)` after incompatibility, `expect(diagnostic.writerEpoch).toBe(lateEpoch)`, and `expect(memoryAfterDoctor).toEqual(memoryBeforeDoctor)`. Reloaded compatible presence then permits enable. Probe CLI >=3.42 as well as `SELECT sqlite_version()` through fakes.
- [ ] **Step 2: Run red.** `npm test -- --maxWorkers=2 packages/roam/src/__tests__/diagnostics.test.ts`. Expected: the named missing behavior or export fails.
- [ ] **Step 3: Implement the exports.** Status reports homes, cursors, backlog, log sizes, suspensions, warnings, incomplete operations, and observation age. Doctor is read-only and names repair commands. Before enable effects, inspect every live top-level presence in each enrolled machine registry, not only participating or HC sessions. Missing capability is pre-roaming. Require the enable target release build and roaming schema capability, and expose actual loaded build identity, not current on-disk bundle identity. Unknown liveness or unreadable inventory refuses enable with reload/doctor guidance. Check detached usage-worker versions through the existing usage server-lock `serverBuild` and process identity. Legacy missing build records require reload too. Probe bundled and CLI SQLite >=3.42. Report trigger-shape drift, late local writer epoch, and likely machine-specific memory without changing rows.
- [ ] **Step 4: Run green.** Repeat the red command. Expected: older live processes mechanically refuse enable, SQLite floors are enforced, and diagnostics write no repairs.
- [ ] **Step 5: Commit.** `git commit -m "feat(roam): diagnose stores and refuse incompatible consumers"`.

### Task 2.6: Package the shell command and gate isolated transport

**Track:** Service. Depends on all phase 2 tasks.

**Files:**
- Create: `packages/herdr/e2e/scenarios/roam-sync.test.ts`.
- Create: `packages/host/src/__tests__/roam-cli-installed.test.ts`.
- Create: `packages/roam/src/__tests__/transport-acceptance.test.ts`.
- Modify: `packages/roam/src/cli.ts`.
- Modify: `scripts/link.mjs`.
- Modify: `scripts/dev-link.mjs`.
- Modify: `scripts/check-package-files.cjs`.
- Modify: `README.md`.
- Modify: `docs/architecture/roaming.md`.
- Modify: `packages/herdr/e2e/harness/scenario.ts`.
- Modify: `scripts/herdr-e2e.mjs`.
- Modify: `packages/herdr/e2e/README.md`.
- Modify: `packages/herdr/e2e/scenarios/runner-contract.test.ts`.

**Interfaces:** Consumes `main(argv: readonly string[], io: {out(text: string): void; err(text: string): void}): Promise<number>`, `handleAgentOperation(operation: Operation, ports: AgentPorts): Promise<Outcome<JsonObject>>`, `runHub(ports: HubPorts): Promise<{stop(): Promise<void>}>`, `createStorePort(config: RoamConfig, globalDb: Db): StorePort`, `doctorLocal(config: RoamConfig, ports: DiagnosticPorts): Promise<readonly Diagnostic[]>`, and existing acceptance `ScenarioDefinition`, `storyId(value: string)`, and `Suite`. Produces named `scenarios` arrays with IDs `R01` for independent-core sync and `R02` for closed-app placement. Register R01 in the `headless` tier and R02 in the `app` tier, with serial execution, discovery, selection, duration, and result matrices. CI marks both as not exercised rather than passed. Preserve existing harness deadlines, including core and pi startup waits. CI reports active-core stories as not exercised rather than passed.

- [ ] **Step 1: Write the failing tests.** Name `installed spider help is side-effect free`, `Mac link installs the actual shell executable`, `A8 chunk transport composes with durable apply`, and `A9 hub survives without pi`. Assert `expect(cliExit).toBe(0)`, `expect(shellResolvedEntry).toBe(packedCliEntry)`, `expect(receivedDigest).toBe(sentDigest)`, and `expect(cursorAfterRestart).toBe(committedThrough)`. These core- or pi-starting stories are exempt from the five-second ceiling. Run one story at a time with the existing harness timeouts. Unit and integration tests keep 5000 ms. Large real transport timing is deferred to 4.7.
- [ ] **Step 2: Run red.** `npm test -- --maxWorkers=2 packages/host/src/__tests__/roam-cli-installed.test.ts packages/roam/src/__tests__/transport-acceptance.test.ts`. Expected: shell installation or assembled path is absent.
- [ ] **Step 3: Wire only implemented commands.** Install the shell command as part of the Mac link path, not just through `npm run build`. Construct SyncService with the real StorePort and transport. Enable first calls `assertCompatibleConsumers`, then `enableMemoryCapture` for global and mapped repo stores on hub and peers through internal `enable-capture`. Recheck diagnosed duplicates before clearing `roamable=0`. Enable hub global capture before scheduling so homes and conflicts replicate. R01 asserts `expect(boxHome).toEqual(hubHome)` and `expect(peerMeta.capture_enabled).toBe(1)`. Then wire enable, disable, sync, status, doctor, repo map, and memory tag through the hub socket or allowed local path. Box-only disallowed controls point to the Mac. Document code 0 completion, 1 refusal, 2 invalid args, and 3 durable pending. Add internal agent dispatch and receipt inspection. Do not expose home mutation through the spider model tool.
- [ ] **Step 4: Run green and the common phase gate.** Also run `node dist/roam/cli.mjs roam status --json` under a fixture root and `npm run test:herdr:e2e -- --built --tier headless --story R01` and `npm run test:herdr:e2e -- --built --tier app --story R02`. Expected: packaged CLI works with pi closed, A8 and A9 pass through fake hc and owned isolated cores, and cleanup proofs are complete. Deploy disabled.
- [ ] **Step 5: Commit.** `git commit -m "feat(roam): install and verify the standalone hub CLI"`.

## Phase 3: Box hosting

### Task 3.1: Support Herdr core-only mode

**Track:** Core. Starts after phase 2 is deployed disabled. Can run with Install.

**Files:**
- Create: `packages/host/src/__tests__/herdr-core-only.test.ts`.
- Create: `packages/herdr/src/__tests__/core-only.test.ts`.
- Modify: `packages/herdr/src/config.ts`.
- Modify: `packages/host/src/herdr/mount.ts`.
- Modify: `packages/herdr/src/__tests__/config.test.ts`.

**Interfaces:** Extend the existing Herdr configuration with `mode: "full" | "core-only"`, default `"full"`. Existing `mountHerdr(pi, options)` and config loader signatures stay intact. The optional AppClient exists only in full mode. Core-only still supplies existing ownership, presence, status, child, and job interfaces. App-dependent action results use the exact message `This view is available on the Mac.`

- [ ] **Step 1: Write the failing tests.** Name `core-only loads without app configuration`, `core-only never constructs AppClient`, `children jobs ownership and status still work`, `app actions explain Mac placement`, `full remains the default`, and `unconfigured remote destination never executes locally`. Assert:

```typescript
expect(appClientConstructions).toBe(0);
expect(absentAppWarnings).toEqual([]);
expect(viewResult.text).toBe("This view is available on the Mac.");
expect(localFallbackCalls).toBe(0);
expect(coreStatus.children).toBe(1);
```

Include missing app executable, malformed full-mode app config, and a core-only session reload. Do not mask an invalid full configuration as core-only.

- [ ] **Step 2: Run red.** `npm test -- --maxWorkers=2 packages/host/src/__tests__/herdr-core-only.test.ts packages/herdr/src/__tests__/core-only.test.ts packages/herdr/src/__tests__/config.test.ts`. Expected: existing full config requires app data.
- [ ] **Step 3: Implement explicit mode branching.** Full mode preserves existing setup and app behavior. Core-only omits app construction, app mods, layout, and absent-app warnings, not core monitoring. Keep remote destination validation before execution. No roaming runtime import in Herdr.
- [ ] **Step 4: Run green.** Repeat the red command and existing Herdr mount tests. Expected: core-only starts with no app configuration and full-mode regressions remain green.
- [ ] **Step 5: Commit.** `git commit -m "feat(herdr): support explicit core-only hosting"`.

### Task 3.2a: Inventory box resources and render the supervisor unit

**Track:** Install. Starts after phase 2 is deployed disabled.

**Files:**
- Create: `packages/roam/src/resource-doctor.ts`.
- Create: `packages/roam/src/systemd.ts`.
- Create: `packages/roam/src/__tests__/resource-doctor.test.ts`.
- Create: `packages/roam/src/__tests__/systemd.test.ts`.
- Create: `packages/roam/src/inventory.ts`.
- Create: `packages/roam/src/provision-contracts.ts`.

**Interfaces:** Consumes shared `Diagnostic`, `Peer`, `Transport`, `Limits`, `Journal`, `Operation`, and `Outcome`. Never redefine `Diagnostic`. Produces `inventory(peer: Peer, transport: Transport): Promise<Inventory>` and `doctorPeer(peer: Peer, ports: ProvisionPorts): Promise<readonly Diagnostic[]>`. `Inventory` includes platform, nodeVersion, gitVersion, systemdUser, core, `pi: string | null` for the existing absolute executable or absence, softNofile, hardNofile, inotifyInstances, and inotifyWatches. `provision-contracts.ts` declares `ProvisionRequest = {operation: Operation; peer: Peer; selected: readonly string[]; includeAuth: boolean; confirmedProviders: readonly string[]}` and `ProvisionPorts` with transport, journal, limits, `confirm(target: string, providers: readonly string[]): Promise<boolean>`, injected `systemd: {unitDir: string; systemctl(argv: readonly string[]): Promise<void>}`, `resources(): Promise<Pick<Inventory, "softNofile" | "hardNofile" | "inotifyInstances" | "inotifyWatches">>`, `bootId(): Promise<string>`, and `release: {pi: "1.2.0"; intercom: "0.13.0"; spiderSha256: string; nodeRange: "22.23.4 || 26.4.0"}`. `renderSupervisorUnit(input: {node: string; supervisor: string; coreUnit: string; globalRoot: string}): string` is pure.

- [ ] **Step 1: Write the failing tests.** `resource-doctor.test.ts` names `inventory refuses missing prerequisites without sudo`, `doctor reports low resources and missing CLI auth`, and `absolute pi path is recorded for minimal PATH`. Assert `expect(adminRepairCalls).toEqual([])`, `expect(lowHardLimit.severity).toBe("warning")`, and `expect(inventory.pi.startsWith("/")).toBe(true)`. `systemd.test.ts` asserts exact dependencies, default.target, private umask, and `expect(coreUnitAfter).toBe(coreUnitBefore)`. All systemd, limit, boot-ID, and resource calls use fake ports and fixture unit directories, never host probes or real systemctl.
- [ ] **Step 2: Run red.** `npm test -- --maxWorkers=2 packages/roam/src/__tests__/resource-doctor.test.ts packages/roam/src/__tests__/systemd.test.ts`. Expected: the named missing behavior or export fails.
- [ ] **Step 3: Implement the exports.** Require Linux, Git, systemd user services, an existing hc core, Node >=22.19.0 and in the pinned tested range. Warn at inotify floors 1024 instances/524288 watches and nofile 65536. Report administrative lingering, hard-limit, or inotify repairs without applying them. Warn a core restart kills terminals. Probe native modules, core ownership, configured CLIs and auth through injected transport. Render only the supervisor unit: After/Requires/PartOf existing core, Restart=on-failure, private umask, default.target. Never change the core or add reverse dependencies.
- [ ] **Step 4: Run green.** Repeat the red command. Expected: complete inventory, shared diagnostic typing, unit dependencies, and zero live machine effects.
- [ ] **Step 5: Commit.** `git commit -m "feat(roam): inventory resources and render supervisor services"`.

### Task 3.2b: Install selected files with explicit auth consent

**Track:** Install. Depends on 3.2a.

**Files:**
- Create: `packages/roam/src/provision.ts`.
- Create: `packages/roam/src/selected-files.ts`.
- Create: `packages/roam/src/auth.ts`.
- Create: `packages/roam/src/__tests__/provision.test.ts`.
- Create: `packages/roam/src/__tests__/selected-files.test.ts`.

**Interfaces:** Consumes 3.2a `Inventory`, `ProvisionRequest`, `ProvisionPorts`, and shared `Diagnostic`. Produces `provision(input: ProvisionRequest, ports: ProvisionPorts): Promise<Outcome<{hostingReady: boolean}>>`. Selected paths come from an allowlist, never arbitrary archive entries. Destination absolute pi path is persisted into peer configuration for the launcher.

- [ ] **Step 1: Write the failing tests.** `provision.test.ts` names `without auth install succeeds but hosting remains disabled`, `secret commands are never executed`, `reprovision backs up once and creates one unit`, and `core unit bytes and terminals remain unchanged`. `selected-files.test.ts` covers rewritten box settings, explicit extension/prompt/MCP selection, supporting skill files, mode/ownership failures, Mac-path refusal, interrupted retries, and target/provider consent. Assert `expect(secretCollectionCalls).toEqual([])`, `expect(hostingReadyWithoutSignin).toBe(false)`, `expect(authArtifactMode).toBe(0o600)`, `expect(secretStagingAfterInstall).toBe(false)`, and `expect(installedUnitCount).toBe(1)`. Rejected consent transfers zero auth bytes; no secret enters argv, labels, or logs. Fake all service calls.
- [ ] **Step 2: Run red.** `npm test -- --maxWorkers=2 packages/roam/src/__tests__/provision.test.ts packages/roam/src/__tests__/selected-files.test.ts`. Expected: the named missing behavior or export fails.
- [ ] **Step 3: Implement the exports.** Show inventory and chosen destinations first. Require Linux, Git, systemd user services, an existing hc core, Node >=22.19.0, and a Node version in the pinned tested range. Install the pinned releases under a home npm prefix with Linux-native SQLite modules. Set `SPIDER_GLOBAL_ROOT` for installation as well as pi. Use destination credentials for Git and CLIs. Copy selected allowlisted settings, models, keys, themes, AGENTS.md, and skill support files. Require explicit selection for extensions, prompts, MCP, and system-prompt files. Exclude trust, sessions, broker state, and caches. Back up overwritten selected files once and replace only those files on rerun. Warn that hand-edited selected files may need re-editing.

Auth is separate private artifact data and requires explicit confirmation per target and provider. Never collect secret-command output. Delete secret staging after installation. Use 3.2a inventory, resource doctor, pure unit renderer, and injected systemd port. Doctor probes native modules, extension load, exact-session launch, modes, core ownership, configured CLIs, and authentication. Missing pi auth blocks hosting. Missing tool auth warns. Through fixture-tested systemd ports, install only the supervisor unit under `default.target`, with `After=`, `Requires=`, and `PartOf=` pointing to the existing core, `Restart=on-failure`, and private umask. Never edit or restart the core or add reverse dependencies. Report administrative lingering, hard-limit, or inotify repairs without applying them. Warn that a required core restart kills terminals.
- [ ] **Step 4: Run green.** Repeat the red command. Expected: selected-file idempotency, explicit auth consent, private staging cleanup, and unchanged core.
- [ ] **Step 5: Commit.** `git commit -m "feat(roam): provision selected files with auth consent"`.

### Task 3.3a: Launch an exact session through both local ownership locks

**Track:** Launch. Depends on 3.1 and 3.2b.

**Files:**
- Create: `packages/herdr/src/__tests__/roam-exact-launch.test.ts`.
- Modify: `packages/herdr/src/sessions/lease.ts`.
- Modify: `packages/herdr/src/sessions/launcher.ts`.
- Create: `packages/herdr/src/sessions/launch-limits.ts`.

**Interfaces:** Consumes completed ID lock and existing Herdr lease/process types. Produces `launchExactSession(request: {sessionId: string; file: string; cwd: string; sha256: string; epoch: number; moveId: string | null; pi: string}, ports: SessionLaunchPorts & {bootId(): Promise<string>; limits(): Promise<{soft: number; hard: number}>; shell: string}): Promise<SessionLaunchResult>`. Existing `spawnPi` and process-inventory probes are the injected execution boundary. Never confuse roaming ProcessIdentity with Herdr pid/startIdentity. Provisioned `pi` is absolute.

- [ ] **Step 1: Write the failing tests.** `roam-exact-launch.test.ts` names `empty missing or replaced exact file never launches`, `both locks prevent duplicate local ID`, `boot ID or start time defeats PID reuse`, `destination HC environment is isolated`, and `shell raises soft limit before exact exec`. Assert `expect(execTail).toEqual([absolutePi, "--session", exactFile])`, `expect(shellScript).toContain("ulimit -Sn")`, and `expect(limitTarget).toBe(Math.min(hard, Math.max(soft, 65_536)))`. Test a higher soft limit and hard-limit ceiling separately, infinity handling, lost spawn replies, and stale leases. Fake boot-ID/limit probes and shell process creation; no real machine limit changes.
- [ ] **Step 2: Run red.** `npm test -- --maxWorkers=2 packages/herdr/src/__tests__/roam-exact-launch.test.ts`. Expected: the named missing behavior or export fails.
- [ ] **Step 3: Implement the exports.** Verify nonempty regular file and manifest immediately before invoking exact pi. Reuse file leases and session-ID locks, never bookkeeping bypass. Launch fresh local-core terminal with background lifetime, no notification, no parent dependency, and only destination-core HC values. Label session/machine/epoch/move. Build shell argv `[shell, "-c", 'ulimit -Sn "$1" && shift && exec "$@"', shell, String(target), absolutePi, "--session", file]`. Compute target from injected soft/hard limits without lowering or exceeding hard. Never set rlimits in Node. Assert on the exec tail, not wrapper argv equality. Boot-ID adapter reads Linux `/proc/sys/kernel/random/boot_id` only in production; tests inject it. Unknown ownership never authorizes launch.
- [ ] **Step 4: Run green.** Repeat the red command. Run existing lease and launcher tests with `--maxWorkers=2`. Expected: one exact owner and correct shell exec tail under minimal PATH.
- [ ] **Step 5: Commit.** `git commit -m "feat(herdr): launch exact participants through leased shell limits"`.

### Task 3.3b: Supervise durable running intent and crash recovery

**Track:** Hosting. Depends on 3.3a.

**Files:**
- Create: `packages/roam/src/supervisor.ts`.
- Create: `packages/roam/src/intent.ts`.
- Create: `packages/roam/src/launcher.ts`.
- Create: `packages/roam/src/__tests__/supervisor.test.ts`.
- Create: `packages/roam/src/__tests__/launcher.test.ts`.
- Modify: `packages/roam/src/supervisor-main.ts`.

**Interfaces:** Consumes shared home/state/process/readiness/clock/journal/diagnostic contracts, HostIntent, and Herdr exact launcher. Produces `SupervisorPorts = {clock: Clock; journal: Journal; inspect(sessionId: string): Promise<{home: Home | null; origin: MachineId; localMachine: MachineId; states: readonly SessionState[]; unfinishedFreeze: boolean; intent: HostIntent; owner: Probe; diagnostics: readonly Diagnostic[]}>; launch(intent: HostIntent): Promise<Outcome<Readiness>>; stop(sessionId: string): Promise<Probe>; notify(sessionId: string, reason: string): Promise<void>}` and `createSupervisor(ports: SupervisorPorts): {reconcile(): Promise<void>; start(): void; stop(): Promise<void>}`. NULL home permits only matching local origin before first sync, never conflict markers or uncertain home reads.

- [ ] **Step 1: Write the failing tests.** `supervisor.test.ts` names `launch requires local home and active state in every store`, `new box origin restarts before first sync with hub offline`, `unfinished freeze and uncertain owner suspend`, `crash backoff suspends at five in ten minutes`, `ten stable minutes clear failures`, `deliberate stop survives restart`, and `reload preserves one terminal`. `launcher.test.ts` composes Herdr launch through fake process/limit/boot ports. Assert `expect(launches).toHaveLength(1)`, `expect(restartDelays).toEqual([5_000, 15_000, 60_000, 300_000])`, and `expect(intentAfterFifthFailure.suspended).not.toBeNull()`. Fake clocks for all intervals.
- [ ] **Step 2: Run red.** `npm test -- --maxWorkers=2 packages/roam/src/__tests__/supervisor.test.ts packages/roam/src/__tests__/launcher.test.ts`. Expected: the named missing behavior or export fails.
- [ ] **Step 3: Implement the exports.** Reconcile at startup, core/home events, and every ten seconds. Require active state in every affected store, no unfinished freeze/conflict, current local home/epoch or matching pre-sync origin, running intent, exact file, mapped cwd, auth, release, and locks. Ownership absence requires injected boot-ID, PID, and start-time proof. Missing auth, invalid file, or uncertainty suspends immediately. Five failures in ten minutes suspend/notify; ten stable minutes clear counts. Stop and user quit persist stopped intent. Resume requires doctor. Adapt roaming identities to Herdr types. Readiness is an admission receipt, not heartbeat. Lost launch replies reconcile ownership, never spawn twice.
- [ ] **Step 4: Run green.** Repeat the red command. Expected: one owner, offline pre-sync origin restart, durable stopped/suspended intent, and no restart on reload.
- [ ] **Step 5: Commit.** `git commit -m "feat(roam): supervise participant intent and crash recovery"`.

### Task 3.4: Persist readiness and admit new box sessions

**Track:** Host. Depends on 3.3b.

**Files:**
- Create: `packages/host/src/roam/readiness.ts`.
- Create: `packages/roam/src/session-control.ts`.
- Create: `packages/roam/src/__tests__/session-control.test.ts`.
- Create: `packages/host/src/roam/__tests__/roam-readiness.test.ts`.
- Create: `packages/host/src/__tests__/herdr-roam-hosting.test.ts packages/roam/src/__tests__/session-control.test.ts`.
- Modify: `packages/host/src/extension.ts`.
- Modify: `packages/host/src/roam/admission.ts`.
- Modify: `packages/host/src/roam/activation.ts`.
- Modify: `packages/roam/src/agent.ts`.
- Modify: `packages/roam/src/cli.ts`.

**Interfaces:** Consumes `registerAdmission(pi: ExtensionAPI, ports: AdmissionPorts): AdmissionGate`, with the complete shared host declarations, `HostIntent`, `Journal`, `Readiness`, `Home`, and `seedSession(db: Db, sessionId: string, epoch: number, key: StoreKey, limit: number): {complete: boolean; through: number}`. Produces `persistReadiness(journal: Journal, ready: Readiness): void` and `startParticipant(operation: Operation, home: Home, intent: HostIntent, ports: ParticipantPorts): Promise<Outcome<Readiness>>` in roaming `session-control.ts`. `ParticipantPorts` has `journal: Journal`, `activate(home: Home, intent: HostIntent): Promise<void>`, `wake(): Promise<void>`, and `readiness(operationId: string): Promise<Readiness | null>`. Host implements the activation/readiness ports for in-process admission. The standalone CLI composes equivalent direct-store ports in roaming, never imports host, and can start with no pi process. Both use `openJournal(<globalRoot>/roam/journal.db)` from `@spider/roam/journal`. `startParticipant` verifies the hub caller and expected epoch, records active state and running intent before supervision, then reconciles durable readiness. New-session admission initializes origin, membership, and resumable seed before ordinary consumers. Home epoch 1 is assigned by 2.4 at first hub sync; matching initial origin permits the original new box process before that sync.

- [ ] **Step 1: Write the failing tests.** Name `readiness commits before ordinary consumers`, `lost readiness reply returns the persisted owner`, `new box admission seeds before startup work`, `core restart recreates one exact-file owner`, `trigger fires once with hub absent`, and `reconnect reports new terminal for placement`. Assert:

```typescript
expect(order.indexOf("ready-durable")).toBeLessThan(order.indexOf("ordinary-consumer"));
expect(replayedReadiness).toEqual(firstReadiness);
expect(homeAfterFirstSync).toMatchObject({epoch: 1, machineId: boxId});
expect(triggerDeliveries).toHaveLength(1);
expect(activeOwners).toHaveLength(1);
```

In `session-control.test.ts`, assert `expect(hostImports).toEqual([])` and `expect(startOrder).toEqual(["active-durable", "intent-durable", "wake", "readiness"])`, including start before any pi process exists. Use independent roots and fake clocks for scheduler recovery. Conflicting initial origins block admission until an explicit claim. No hub availability is required to continue an already active home.

- [ ] **Step 2: Run red.** `npm test -- --maxWorkers=2 packages/host/src/roam/__tests__/roam-readiness.test.ts packages/host/src/__tests__/herdr-roam-hosting.test.ts packages/roam/src/__tests__/session-control.test.ts`. Expected: missing durable admission receipt.
- [ ] **Step 3: Wire participants, supervision, and box controls.** Persist readiness with operation ID, actual session ID, epoch, cwd, file, core, and terminal after admission checks and before setting ordinary activation. Persist new box origin and membership first. Call 1.3b `seedSession` with the resolved StoreKey so the first chunk sets `store_key` and `capture_enabled=1` before ordinary work. The roaming start implementation records active state and running intent through ports, then wakes supervision and reads the shared readiness journal. Host keeps only `persistReadiness` and its adapter implementations. Internal `session start` is a hub-issued expected-epoch operation, not a general model action. Wire provision, doctor, stop, and resume through their implemented ports. Stop changes desired state without changing home. Failed doctor prevents resume. Core-only pi registration remains guarded and works without app config.
- [ ] **Step 4: Run green.** Repeat the red command and startup-order tests. Expected: readiness survives a lost reply and restored triggers fire once without the hub.
- [ ] **Step 5: Commit.** `git commit -m "feat(host): persist roaming readiness before activation"`.

### Task 3.5: Gate core-only hosting on isolated cores

**Track:** Host. Depends on all phase 3 tasks.

**Files:**
- Create: `packages/herdr/e2e/scenarios/roam-hosting.test.ts`.
- Create: `packages/roam/src/__tests__/hosting-acceptance.test.ts`.
- Modify: `docs/architecture/roaming.md`.
- Modify: `README.md`.
- Modify: `scripts/herdr-e2e.mjs`.

**Interfaces:** Consumes the actual packaged CLI, supervisor entry, core-only mount, provisioning operations, existing `ScenarioDefinition`, `storyId`, and `Suite`. Produces `R03` core-only in-terminal load, `R04` restart and trigger restore, and `R05` stopped and suspended hosting stories. Export exactly one named `scenarios` array per story file. Register IDs and explicit tier applicability in the existing matrix.

- [ ] **Step 1: Write the failing tests.** `hosting-acceptance.test.ts` has `A10 provision never changes existing core`, `A11 deliberate stop is durable`, and `missing sign-in blocks hosting not installation`. Stories load the packed extension inside an owned core-spawned pi terminal with no app config. Assert `expect(extensionLoaded).toBe(true)`, `expect(coreUnitDigestAfter).toBe(coreUnitDigestBefore)`, and `expect(ownersAfterRestart).toHaveLength(1)`. List R03, R04, and R05 in the `headless` Herdr acceptance tier. These real core/pi startup and restart stories run one at a time with existing harness deadlines, not the unit/integration five-second ceiling. Record durations. Real installation and long no-client survival are maintainer steps in 4.7, not sleeping tests.
- [ ] **Step 2: Run red.** `npm test -- --maxWorkers=2 packages/roam/src/__tests__/hosting-acceptance.test.ts`. Expected: assembled hosting acceptance fails before wiring is complete.
- [ ] **Step 3: Add composed stories and operator instructions.** Explain auth consent, missing tool warnings, stop and doctor-before-resume, resource repairs, and deferred upgrade and uninstall orchestration. Document that a Windows reboot requires desktop sign-in before the existing WSL task can run. Supervisor recovery cannot power on a machine or sign in its host.
- [ ] **Step 4: Run green and the common phase gate.** Also run `npm run test:herdr:e2e -- --built --tier headless --story R03,R04,R05`. Expected: A10 and A11 pass under isolated roots, and A1's core-only extension load is observed inside a real core-spawned terminal. Deploy disabled. Synthetic opt-in hosting may be used for phase 4 acceptance only.
- [ ] **Step 5: Commit.** `git commit -m "test(roam): gate core-only hosting and restart recovery"`.

## Phase 4: Moves and real-box acceptance

### Task 4.1a: Snapshot source Git trees and refuse unsupported states

**Track:** Git source. Starts after phase 3 is deployed disabled. Can run with Git destination, Files, and Control.

**Files:**
- Create: `packages/roam/src/workspace.ts`.
- Create: `packages/roam/src/__tests__/workspace.test.ts`.

**Interfaces:** Produces `snapshotWorkspace(input: {root: string; cwd: string; repoKey: string; workspaceId: string; moveId: string; stage: "pre" | "final"; writers: readonly Blocker[]}, ports: GitPorts): Promise<WorkspaceSnapshot>`. `GitPorts` has `run(cwd: string, argv: readonly string[], options?: {env?: Readonly<NodeJS.ProcessEnv>; stdin?: Buffer}): Promise<Buffer>`, `journal: Journal`, `limits: Limits`, `scratch: string`, and `worktreeCommand: readonly string[] | null`. Both tracks consume the fixed shared `WorkspaceSnapshot` and `PreparedWorkspace` contracts from 2.1, with no imports of each other's implementation.

- [ ] **Step 1: Write the failing tests.** `workspace.test.ts` names `snapshot preserves real index bytes and untracked bytes`, `captures staged-only binary deletion rename and mode changes`, and `refuses unsupported states without changing source`. Assert `expect(sourceIndexBytesAfter).toEqual(sourceIndexBytesBefore)` and `expect(sourceIndexTreeAfter).toBe(sourceIndexTreeBefore)`. Use disposable bare origins/common repos with unpushed commit, different staged/working binary bytes, staged-only reverted working content, deletion, rename, exec bit, untracked and ignored files. Parameterize merge/rebase, unresolved index, submodules, escaping symlinks, case-fold collisions, unsupported types, LFS pointer-only/missing object, non-round-tripping filters, known writers, and tracked local state. On case-insensitive macOS build collision fixtures using `git update-index --cacheinfo`, not impossible filesystem names.
- [ ] **Step 2: Run red.** `npm test -- --maxWorkers=2 packages/roam/src/__tests__/workspace.test.ts`. Expected: the named missing behavior or export fails.
- [ ] **Step 3: Implement the exports.** Obtain the actual index path with `git rev-parse --git-path index`. Copy the real index privately before any `write-tree`. Run `git write-tree` on that private `GIT_INDEX_FILE`, then copy it again for `git add -A`, explicitly excluding `.spider` and `.pi-subagents`. Refuse tracked local state. Create index and working commits parented on HEAD and index respectively. Use immutable refs `refs/spider-roam/<move-id>/<stage>/index` and `/working`, never force-update or push them. Use fixed private metadata `Spider roaming snapshot <roam@example.invalid>` and `2000-01-01T00:00:00Z`, not user Git configuration.

Record HEAD, branch, object format, both trees, relative cwd, sparse patterns, and per-worktree config.  Snapshot returns the shared discriminated `bundle: {kind: "unbundled"}` state. Task 4.1b creates and validates `bundle: {kind: "ready", artifactId, byteLength}` before transfer. Unbundled snapshots cannot transfer and are not production stubs. Source snapshot creation never imports the unfinished destination module.
- [ ] **Step 4: Run green.** Repeat the red command. Expected: source index bytes and staged content remain unchanged, exact trees captured, all unsupported states refuse.
- [ ] **Step 5: Commit.** `git commit -m "feat(roam): snapshot source workspaces without index mutation"`.

### Task 4.1b: Bundle verified prerequisites and restore destination trees

**Track:** Git destination. Starts after phase 3 is deployed disabled. Runs in parallel with 4.1a using shared contracts.

**Files:**
- Create: `packages/roam/src/workspace-import.ts`.
- Create: `packages/roam/src/git-bundle.ts`.
- Create: `packages/roam/src/__tests__/workspace-import.test.ts`.
- Create: `packages/roam/src/__tests__/git-bundle.test.ts`.

**Interfaces:** Produces `bundleWorkspace(snapshot: WorkspaceSnapshot, verifiedPrerequisites: readonly string[], ports: GitPorts): Promise<WorkspaceSnapshot>` and `prepareWorkspace(snapshot: WorkspaceSnapshot, destination: string, ports: GitPorts): Promise<PreparedWorkspace>`, `verifyWorkspace(prepared: PreparedWorkspace, ports: GitPorts): Promise<void>`, and `abortWorkspace(prepared: PreparedWorkspace, ports: GitPorts): Promise<void>`. `GitPorts` has `run(cwd: string, argv: readonly string[], options?: {env?: Readonly<NodeJS.ProcessEnv>; stdin?: Buffer}): Promise<Buffer>`, `journal: Journal`, `limits: Limits`, `scratch: string`, and `worktreeCommand: readonly string[] | null`. Both tracks consume the fixed shared `WorkspaceSnapshot` and `PreparedWorkspace` contracts from 2.1, with no imports of each other's implementation.

- [ ] **Step 1: Write the failing tests.** `workspace-import.test.ts` names `round trip reuses the mapped checkout`, `diverged mapped checkout refuses with a diff summary`, `sparse cone and alternate-backed creation installs config before checkout`, `custom worktree command preserves no-checkout order`, and `branch conflict remains detached`. `git-bundle.test.ts` covers verified shared prerequisites, pre-stage plus final delta cap, missing prerequisites without full-history fallback, and unchanged prepared-tree abort. Use shared snapshot-shaped fixtures without source-module imports. Assert `expect(destinationHead).toBe(snapshot.head)`, `expect(destinationIndexTree).toBe(snapshot.indexTree)`, `expect(destinationWorkingTree).toBe(snapshot.workingTree)`, `expect(returnedRoot).toBe(previousMappedRoot)`, `expect(unrelatedRootDigestAfter).toBe(unrelatedRootDigestBefore)`, and `expect(fullHistoryFallbackCalls).toBe(0)`.
- [ ] **Step 2: Run red.** `npm test -- --maxWorkers=2 packages/roam/src/__tests__/workspace-import.test.ts packages/roam/src/__tests__/git-bundle.test.ts`. Expected: the named missing behavior or export fails.
- [ ] **Step 3: Implement the exports.** `bundleWorkspace` returns the ready bundle state. `prepareWorkspace` refuses an unbundled snapshot. Destination fetches origin with its own credentials and advertises verified commits. Bundle only snapshot refs excluding a verified shared merge base and pre-stage prerequisites. Missing prerequisites or combined bundles above 256 MiB refuse with setup instructions, never full history. A mapped checkout must equal its last exported HEAD, index, and working trees. Journal prepared trees so retries recognize their own modifications.

For reuse, initialize a private index from the last working tree, refresh its stat cache, and use `git read-tree -m -u` to apply the incoming working tree. For creation use `git worktree add --detach --no-checkout`, enable `extensions.worktreeConfig`, explicitly recording that this changes shared repository config, copy sparse patterns and config, then checkout during pre-stage. A configured argv tool replaces creation, not the no-checkout checks. Set the real index with `git read-tree <index-tree>` without updating working files. Run one `git update-index --refresh` to restore stat cache. Accept exit 1 only for verified `needs update` paths, never other errors. Restore HEAD without checkout or reset. Restore the symbolic branch only if its ref matches or can be created without changing another worktree. Otherwise report the saved branch and remain detached. Compare destination trees and source final trees before home commit. Retain source files and mark their checkout not home. Never build a full byte manifest of the workspace.
- [ ] **Step 4: Run green.** Repeat the red command. Expected: exact HEAD/index/working trees, retained partial staging, safe sparse creation/reuse, and unchanged unrelated roots.
- [ ] **Step 5: Commit.** `git commit -m "feat(roam): bundle and restore destination workspaces"`.

### Task 4.2: Install leaf-preserving session files and append-only mirrors

**Track:** Files. Starts after phase 3 is deployed disabled.

**Files:**
- Create: `packages/roam/src/session-file.ts`.
- Create: `packages/roam/src/mirrors.ts`.
- Create: `packages/roam/src/__tests__/session-file.test.ts`.
- Create: `packages/roam/src/__tests__/session-sdk.test.ts`.
- Create: `packages/roam/src/__tests__/mirrors.test.ts`.

**Interfaces:** Consumes shared `Segment`, `HistoryRef`, `SessionManifest`, `Journal`, `Limits`, `Outcome`, and artifact `ArtifactManifest`. Produces `inspectSession(file: string, expectedId: string, liveLeaf?: string): Promise<SessionManifest>`; `stageSession(input: {source: SessionManifest; destinationCwd: string; destinationParent: string | null; segment: Segment}, root: string): Promise<SessionManifest>`; `installSession(manifest: SessionManifest, target: string, ports: {journal: Journal; ownership: () => Promise<Probe>}): Promise<void>`; `verifyFrozenSession(manifest: SessionManifest): Promise<void>`; and `appendMirror(input: {sessionId: string; epoch: number; source: SessionManifest; root: string}, journal: Journal): Promise<SessionManifest>`. A manifest refers to the artifact by ID and records source and unchanged-history digests; its local file field never travels in row batches.

- [ ] **Step 1: Write the failing tests.** Name `older selected leaf survives physical later branch`, `rewrite changes only header and appends non-context marker`, `unknown entries and compaction bytes remain unchanged`, `empty missing partial or invalid graph refuses`, `prior same-ID file requires dormancy prefix and backup`, `source prefix or metadata append invalidates frozen manifest`, `atomic install refuses symlink or disk-full`, and `mirrors append complete verified lines per epoch`. Assert:

```typescript
expect(opened.getSessionId()).toBe(originalId);
expect(opened.getCwd()).toBe(mappedCwd);
expect(opened.getBranch().map(e => e.id)).toEqual(["root", "selected", markerId]);
expect(installedHistoryDigest).toBe(sourceHistoryDigest);
expect(contextText).not.toContain("spider-roam-segment");
expect(marker.data.historyMachine).toBe(initialHistoryMachine);
expect(priorTargetAfterRefusal).toEqual(priorTargetBefore);
```

`session-sdk.test.ts` uses public `SessionManager` from pinned pi with a sentinel file at old cwd, not a copied loader. Cover missing parentSession mapping, a known destination parent, duplicate IDs, bad parent links, invalid compaction boundary, invalid header, non-newline tail, and an opaque unknown extension entry. A dormant file selects the last physical entry. A live file selects supplied `getLeafId()`. Mirror truncation or changed prefix refuses without overwriting earlier bytes.

- [ ] **Step 2: Run red.** `npm test -- --maxWorkers=2 packages/roam/src/__tests__/session-file.test.ts packages/roam/src/__tests__/session-sdk.test.ts packages/roam/src/__tests__/mirrors.test.ts`. Expected: missing validated file transformation.
- [ ] **Step 3: Implement streaming validation and installation.** Require complete newline-terminated v3 JSONL, expected ID, unique entry IDs, valid parent links, and compaction boundaries. Source upgrades old formats normally before freezing. Pre-stage immutable complete prefix chunks, then reuse their hashes in the final artifact and send only the remainder. Any changed source prefix aborts before home commit. Verify assembled source digest. Preserve every post-header byte. Rewrite only `header.cwd` and mapped `parentSession`; otherwise remove the stale parent locator and put its origin reference in marker data. Append a fresh custom `spider-roam-segment` entry parented on the captured leaf with exact shared `Segment` data and null parentRef when absent. First marker retains previous machine as history machine, later markers retain that initial value. Never rewrite historical message paths.

Validate destination digest, unchanged history, header, marker, and cwd. Install by same-directory atomic rename after file and directory fsync. A prior same-ID target needs proved dormant ownership, compatible history prefix, and a private backup. Verify frozen source size and digest again immediately before commit. Discard retired-source appends after commit. Mirrors are read-only append-only files keyed by session and home epoch, start from that epoch's installed file, and accept only a matching prefix and complete lines. They make remote conversation readable without moving its home.
- [ ] **Step 4: Run green.** Repeat the red command. Expected: actual pi opens the intended branch and mapped cwd, history bytes match, and bad targets remain untouched.
- [ ] **Step 5: Commit.** `git commit -m "feat(roam): preserve session leaves and mirror home history"`.

### Task 4.3a: Inventory every idle-move blocker without cancelling work

**Track:** Control. Starts after phase 3 is deployed disabled.

**Files:**
- Create: `packages/host/src/roam/blockers.ts`.
- Create: `packages/host/src/roam/__tests__/roam-blockers.test.ts`.

**Interfaces:** Consumes shared `Blocker`, `Db`, public pi `ExtensionContext`, subagents `listSessionBlockers`, local routes, and top-level/child job-journal read adapters. Produces `inspectBlockers(ctx: ExtensionContext, stores: readonly Db[]): Promise<readonly Blocker[]>`.

- [ ] **Step 1: Write the failing tests.** `roam-blockers.test.ts` names `returns exact blockers without stopping work`. Parameterize request, retry, compaction, queued prompt, editor draft, direct shell, pending ask, queued/paused/detached child, pipeline, local jobs, unsettled remote receipts, and unobserved completions. Assert `expect(blockerIds).toEqual(expectedIds)` and `expect(cancelledWork).toEqual([])`. Inspect every affected binding store and owning journal, never a foreign replica as operational work.
- [ ] **Step 2: Run red.** `npm test -- --maxWorkers=2 packages/host/src/roam/__tests__/roam-blockers.test.ts`. Expected: the named missing behavior or export fails.
- [ ] **Step 3: Implement the exports.** Read actual owning run state and delivery facts, local routes, both job journals, and public pending-message state. Return stable exact IDs and reasons. Inventory has no cancellation, mutation, or provider effect.
- [ ] **Step 4: Run green.** Repeat the red command. Expected: complete exact blocker inventory with zero stopped work.
- [ ] **Step 5: Commit.** `git commit -m "feat(host): inventory all idle move blockers"`.

### Task 4.3b: Freeze live and dormant participants through guarded control

**Track:** Control. Depends on 4.3a.

**Files:**
- Create: `packages/host/src/roam/control.ts`.
- Create: `packages/host/src/roam/freeze.ts`.
- Create: `packages/host/src/roam/__tests__/roam-control.test.ts`.
- Create: `packages/host/src/roam/__tests__/roam-freeze.test.ts`.
- Modify: `packages/host/src/roam/admission.ts`.
- Modify: `packages/host/src/roam/activation.ts`.
- Modify: `packages/host/src/roam/readiness.ts`.
- Modify: `packages/host/src/loop/index.ts`.
- Modify: `packages/host/src/organism-runtime.ts`.
- Modify: `packages/roam/src/session-control.ts`.
- Modify: `packages/roam/src/__tests__/session-control.test.ts`.

**Interfaces:** Consumes shared `FreezeAck`, `ProcessIdentity`, `Probe`, `Blocker`, `Home`, `SessionState`, `Readiness`, `Journal`, and `Operation`. Consumes `listSessionBlockers(db: Db, sessionId: string): readonly Blocker[]` and `AdmissionGate` with `inspect`, `close`, `freeze`, and `unfreeze` signatures from 1.9b. Consumes 4.3a `inspectBlockers(ctx: ExtensionContext, stores: readonly Db[]): Promise<readonly Blocker[]>`. Extends 3.4 `session-control.ts` and preserves `startParticipant` behind ports and the shared `<globalRoot>/roam/journal.db`. Produces `serveSessionControl(input: {sessionId: string; runtimeRoot: string; ports: FreezePorts}): Promise<{close(): Promise<void>}>`; `freezeParticipant(operation: Operation, ports: FreezePorts): Promise<FreezeAck>`; and `controlSession(operation: Operation, ports: SessionControlPorts): Promise<Outcome<JsonObject>>`. `FreezePorts` has `gate: AdmissionGate`, `journal: Journal`, `stores: readonly Db[]`, `drain(): Promise<void>`, `inspect(): Promise<{blockers: readonly Blocker[]; file: string; cwd: string; leaf: string; owner: ProcessIdentity | null}>`, and `ingestThrough(file: string, size: number): Promise<void>`. `SessionControlPorts` has `journal: Journal`, `probe(sessionId: string): Promise<Probe>`, `withBothLocks<T>(sessionId: string, fn: () => Promise<T>): Promise<T>`, `live(operation: Operation): Promise<Outcome<JsonObject>>`, and `dormant(operation: Operation): Promise<Outcome<JsonObject>>`.

- [ ] **Step 1: Write the failing tests.** Name `freeze stops all producers before durable acknowledgement`, `partial multi-store freeze reconciles before unfreeze`, `control accepts only four verbs and matching operation epoch`, `live retire waits for proved process exit`, `dormant freeze holds both locks and uses physical leaf`, `uncertain ownership blocks dormant control`, and `cancelled move can never reactivate later`. Assert:

```typescript
expect(blockerIds).toEqual(expectedIds);
expect(cancelledWork).toEqual([]);
expect(order).toEqual(["close-gates", "drain", "recheck", "freeze-all", "ack"]);
expect(ack.barriers).toHaveLength(affectedStores.length);
expect(ordinaryWritesAfterAck).toBe(0);
expect(retiredBeforeExitProof).toBe(false);
```

Parameterize requests, retry, compaction, queued prompts, editor draft, direct shell, pending asks, queued or paused child, detached durable child, pipeline, local jobs, unsettled remote receipts, and unobserved completions. Inspect the owning run DB, local routes, and both top-level and child job journals. Check timer delivery, notices, cache warming, organism reports, and shutdown consolidation remain suppressed across reload. Invalid control requests mutate nothing.
- [ ] **Step 2: Run red.** `npm test -- --maxWorkers=2 packages/host/src/roam/__tests__/roam-control.test.ts packages/host/src/roam/__tests__/roam-freeze.test.ts packages/roam/src/__tests__/session-control.test.ts`. Expected: the named missing behavior or export fails.
- [ ] **Step 3: Implement the exports.** Export the socket service and participant handlers without editing host registration or agent dispatch. Product owns that wiring in 4.6b. Admission owns a mode-0600 socket in a 0700 runtime directory keyed by session-ID hash. Bound and validate frames before dispatch. Use a short private runtime root and the first 32 hex characters of SHA-256(session ID) as the directory key; reject a socket path beyond the platform limit before bind rather than falling back to TCP. The socket accepts only inspect, freeze, unfreeze, and shutdown with expected epoch and move ID. Session CLI routes to the live lease owner. Live retirement shuts down first and persists retirement only after proved exit. Proved dormancy acquires both ID and canonical-file locks, journals before changing state, and performs direct freeze, unfreeze, inspection, or retirement. Unknown ownership blocks.

Close all admission gates, stop spider-owned transcript producers, drain writers, recheck idle blockers, and persist frozen state in every affected store. Use the fixed `<globalRoot>/roam/journal.db` so admission and CLI share readiness and unfinished-freeze state. Journal cross-store progress and acknowledge only when all stores are frozen. Record owner identity or proved dormancy, runtime cwd, live leaf or physical dormant leaf, transcript size and digest, and high sequence per store. Ingest usage through that source end. A partial failure remains frozen or control-only until its journal reconciles. Abort records cancellation before active state and gates reopen; stale move IDs cannot overwrite later state. Freeze never expires.
- [ ] **Step 4: Run green.** Repeat the red command. Run admission and scheduler suites with `--maxWorkers=2`. Expected: durable full-store freeze, exact blockers, no forced cancellation, and safe dormant proof.
- [ ] **Step 5: Commit.** `git commit -m "feat(host): freeze live and dormant participants durably"`.

### Task 4.4a: Move homes through the seven forward states

**Track:** Moves. Depends on 4.1a, 4.1b, 4.2, and 4.3b.

**Files:**
- Create: `packages/roam/src/move.ts`.
- Create: `packages/roam/src/power.ts`.
- Create: `packages/roam/src/__tests__/move.test.ts`.

**Interfaces:** Consumes shared `MoveRequest`, `MoveResult`, `MovePorts`, all artifacts and readiness contracts, and 2.4 `assignInitialHome`/`casHome`. Produces `moveSession(request: MoveRequest, ports: MovePorts): Promise<Outcome<MoveResult>>`. CAS and durable home-action receipt remain in 2.4 homes.ts, not reimplemented here. `power.ts` adapts injected `spawn(argv)` and process-exit handles to `MovePorts.power(): Promise<() => Promise<void>>`, using `caffeinate -i -w <pid>` only in production. Tests fake it.

- [ ] **Step 1: Write the failing tests.** `move.test.ts` names `same-home request is a verified no-op`, `second destination conflicts per session`, `seeds and prestages before freeze`, `first move verifies synthetic source home after seed sync`, `power assertion spans recovery`, `requires every store barrier`, and `source cleanup uses proved terminal removal`. Assert `expect(states).toEqual(["checked", "frozen", "transferred", "home-committed", "destination-ready", "source-stopped", "done"])`, `expect(homeAfterMove.epoch).toBe(sourceHome.epoch + 1)`, `expect(ownersAtEveryObservation.every(n => n <= 1)).toBe(true)`, and `expect(registryRemovals).toEqual([{id: sourceTerminal, provedRemoved: true}])`. Fake all power/process operations and assert acquire/release ordering without caffeinate or live power assertions.
- [ ] **Step 2: Run red.** `npm test -- --maxWorkers=2 packages/roam/src/__tests__/move.test.ts`. Expected: the named missing behavior or export fails.
- [ ] **Step 3: Implement the exports.** Serialize per session and reconcile repeated operation IDs. Preflight reachable compatible machines, source build or dormancy, destination installation, pi auth, workspace and binding maps, and exact blockers. Hold a Mac power assertion through preparation and all recovery until done, abort, or rollback. Print `Keep the Mac awake until the move finishes.` For a first move with no home, use synthetic expected source `{origin, epoch: 1}` during check. Call 1.3b `seedSession` with each resolved StoreKey; its first chunk enables capture. Sync through 2.4 initial assignment and require exactly that owner/epoch before freeze, otherwise abort. Retain membership after abort. Pre-stage workspace checkout and transcript while the source stays active.

Freeze records barriers and immutable source observation. Transfer only final Git and transcript deltas, revalidate source trees and transcript size and digest, and reach all global, repo, and worktree barriers. Prepare local maps, exact file, binding, and retired destination state. Commit home from source epoch e to destination e+1 in the same hub DB transaction as its action receipt. Replicate home, then issue expected-epoch `session start` to activate destination and running intent. Persist readiness before consumers. Stop source with reason move, prove its process identity absent, retire it, and remove only its recorded terminal. Call existing `registry.remove(id, provedRemoved)` only after removal proof. Verify one admitted destination owner and reconcile placement. At done delete private move refs on both machines and unreferenced staging. Cleanup and app failures remain pending cleanup, never rollback.

 Recovery/cancel entry points are added in 4.4b before any CLI consumer or phase gate. An interrupted forward action stays durable pending with the source frozen; never approximate recovery with timeout rollback.
- [ ] **Step 4: Run green.** Repeat the red command. Expected: forward states, barriers, capture enablement, source exclusion, and injected power lifetime pass.
- [ ] **Step 5: Commit.** `git commit -m "feat(roam): move homes through durable forward states"`.

### Task 4.4b: Cancel and recover moves with the full fault matrix

**Track:** Moves. Depends on 4.4a.

**Files:**
- Create: `packages/roam/src/move-recovery.ts`.
- Create: `packages/roam/src/__tests__/move-faults.test.ts`.
- Modify: `packages/roam/src/move.ts`.

**Interfaces:** Consumes 4.4a `moveSession`, shared `MovePorts`, and 2.4 `casHome`. Produces `recoverMove(moveId: string, ports: MovePorts): Promise<Outcome<MoveResult>>` and `cancelMove(moveId: string, ports: MovePorts): Promise<Outcome<MoveResult>>`. Reuses durable home-action receipts and the injected power handle; hub restart reacquires it before reconciliation.

- [ ] **Step 1: Write the failing tests.** `move-faults.test.ts` parameterizes `restart after action and before reply at <state>` across every transition, each store freeze and barrier, file install, home commit, start, readiness, shutdown, retirement, and cleanup. Name `lost readiness reply never allows rollback`, `disconnection is not launch failure`, `precommit abort needs no destination`, `post-readiness crash belongs to supervisor`, `source metadata append invalidates commit`, and `rollback reuses untouched original file`. Assert no segment appended to rollback source, source remains frozen on uncertainty, and pending placement never rolls back a successful move. Each fault is a separate short test. Assert `expect(homeAfterRollback.epoch).toBe(sourceHome.epoch + 2)` and `expect(ownersAtEveryObservation.every(n => n <= 1)).toBe(true)`. Power, process, and boot-ID operations remain faked throughout the fault matrix.
- [ ] **Step 2: Run red.** `npm test -- --maxWorkers=2 packages/roam/src/__tests__/move-faults.test.ts packages/roam/src/__tests__/move.test.ts`. Expected: the named missing behavior or export fails.
- [ ] **Step 3: Implement the exports.** Before commit, abort proves source home e still current and durably cancels that commit action before unfreeze, even with destination unreachable. After commit a timeout is unknown. Reconcile home, destination journal, readiness, and process identity. Rollback requires proved launch failure, no readiness receipt, and destination acknowledgement of stopped ownership plus durable retirement. Only then CAS source back at e+2, replicate, atomically advance source membership to e+2 under that verified home, and readmit its original process or exact original file without a new marker. Once readiness exists, stay at destination and use supervisor recovery. Hub startup reconciles incomplete moves before another move for that session. Never restore an old home by timeout.
- [ ] **Step 4: Run green.** Repeat the red command. Expected: each injected fault gives proved recovery, higher-epoch rollback, or explicit pending with source frozen.
- [ ] **Step 5: Commit.** `git commit -m "feat(roam): recover and cancel moves without unsafe rollback"`.

### Task 4.5: Recover destroyed machines and conflicting initial homes

**Track:** Moves. Depends on 4.4b.

**Files:**
- Create: `packages/roam/src/forget.ts`.
- Create: `packages/roam/src/claim.ts`.
- Create: `packages/roam/src/revocation.ts`.
- Create: `packages/roam/src/__tests__/forget.test.ts`.
- Create: `packages/roam/src/__tests__/claim.test.ts`.
- Modify: `packages/roam/src/sync.ts`.
- Modify: `packages/roam/src/supervisor.ts`.
- Modify: `packages/roam/src/move-recovery.ts`.
- Modify: `packages/roam/src/hub.ts`.

**Interfaces:** Consumes `MovePorts`, `Outcome`, `Home`, `Journal`, `Readiness`, `SessionManifest`, `casHome(db, expected, nextMachine, moveId, hubMachine): Home`, and `appendMirror({sessionId, epoch, source, root}, journal): Promise<SessionManifest>`. Produces `forgetMachine(input: {machineId: MachineId; confirmation: string}, ports: MovePorts): Promise<Outcome<readonly Home[]>>`; `claimInitialHome(input: {sessionId: string; machineId: MachineId; stoppedCopies: readonly MachineId[]}, ports: MovePorts): Promise<Outcome<Home>>`; and `isRevoked(db: Db, machineId: MachineId): boolean`. Permanent local hub revocation state lives in its private journal DB, outside portable descriptors. A reconnect response carries retire-only, never an accepted sync cursor.

- [ ] **Step 1: Write the failing tests.** Name `forget requires typed destroyed-machine confirmation`, `revocation survives hub restart and refuses sync forever`, `reconnecting revoked supervisor stops before sync`, `restore uses last mirrored prefix at higher epoch`, `missing mirror or invalid workspace prevents hosting`, `forget reconciles interrupted moves against new homes`, and `claim accepts only unassigned origins with every competing copy stopped`. Assert:

```typescript
expect(restoredHome.epoch).toBe(oldHome.epoch + 1);
expect(handshakeAfterRestart.reason).toBe("machine-revoked");
expect(actionsAfterRevokedReply).toEqual(["stop-sessions"]);
expect(restoredHistoryDigest).toBe(lastMirrorDigest);
expect(existingAssignedHomeAfterClaimRefusal).toEqual(existingAssignedHomeBefore);
```

A reachable but uncertain competing process blocks claim. Claim cannot replace an assigned home. Test revocation persistence failure before home changes and a revoked machine whose alias is later reused for a different enrolled UUID.

- [ ] **Step 2: Run red.** `npm test -- --maxWorkers=2 packages/roam/src/__tests__/forget.test.ts packages/roam/src/__tests__/claim.test.ts`. Expected: no explicit revocation or recovery path.
- [ ] **Step 3: Implement assertion-based recovery.** Every sync mirrors peer-homed appended JSONL through verified complete lines. Before forget, display possible two-copy execution if the assertion is wrong and loss of post-mirror conversation and unsent workspace edits. Require typed confirmation that this exact UUID is destroyed, then durably revoke before any restore. Move affected homes to the Mac at next epoch, validate and mark the mirror using normal file rules, and wait for valid local workspace and auth before `session start`. No mirror means explicit recovery refusal. Retire-only on reconnection stops sessions before any sync. Reconcile incomplete moves against new homes. Claim uses 2.4 `assignInitialHome` for an absent row or resolves its reserved initial-conflict marker with `casHome` at the next epoch. Neither case rewrites an assigned home. Claim is only for an unassigned initial home, with all conflicting machines reachable and all competing copies stopped. No offline takeover or assigned-home rewrite.
- [ ] **Step 4: Run green.** Repeat the red command and move fault tests. Expected: permanent revocation, higher-epoch mirror restore, and no claim that bypasses normal moves.
- [ ] **Step 5: Commit.** `git commit -m "feat(roam): revoke destroyed machines and recover mirrored homes"`.

### Task 4.6a: Compose every move effect from real adapters

**Track:** Product. Depends on 4.5.

**Files:**
- Create: `packages/roam/src/move-ports.ts`.
- Create: `packages/roam/src/__tests__/move-ports.test.ts`.

**Interfaces:** Consumes the complete shared `MovePorts`, `MoveRequest`, `MoveResult`, config, transport, journal, session-control, Git, artifacts, supervisor, sync, and recovery APIs. Produces `createMovePorts(config: RoamConfig, transport: Transport, journal: Journal): MovePorts`. No host implementation is imported into roam.

- [ ] **Step 1: Write the failing tests.** `move-ports.test.ts` names `real adapters preserve expected epoch and exact file`, `start before pi uses roaming participant ports not socket`, `live freeze uses session socket`, and `all MovePorts effects have real composition`. Assert `expect(remoteOperation.expectedEpoch).toBe(home.epoch)`, `expect(installedFile).toBe(manifest.file)`, `expect(hostImports).toEqual([])`, and `expect(composedEffectNames.sort()).toEqual(requiredEffectNames.sort())`. Use real fixture DB/Git/session adapters, fake hc/process/OS ports, and exact file manifests.
- [ ] **Step 2: Run red.** `npm test -- --maxWorkers=2 packages/roam/src/__tests__/move-ports.test.ts`. Expected: the named missing behavior or export fails.
- [ ] **Step 3: Implement the exports.** Bind every MovePorts effect to implemented Git, file, control, sync, supervisor, homes, and recovery APIs. Start calls the roaming `startParticipant` with direct-store ports and shared journal, then wakes supervisor. Live inspect/freeze/unfreeze/shutdown use the host socket; dormant control holds both locks. Provisioning absolute executables and injected launchd/systemd/boot/power/limit ports stay explicit. Wire no command yet.
- [ ] **Step 4: Run green.** Repeat the red command. Expected: complete composition, no host runtime imports, and preserved epochs and exact files.
- [ ] **Step 5: Commit.** `git commit -m "feat(roam): compose real move participant adapters"`.

### Task 4.6b: Expose guarded CLI controls and the move slash command

**Track:** Product. Depends on 4.6a.

**Files:**
- Create: `packages/roam/src/__tests__/commands.test.ts`.
- Create: `packages/host/src/roam/move-command.ts`.
- Create: `packages/host/src/roam/__tests__/roam-move-command.test.ts`.
- Modify: `packages/host/src/extension.ts`.
- Modify: `packages/roam/src/cli.ts`.
- Modify: `packages/roam/src/agent.ts`.

**Interfaces:** Consumes 4.6a `createMovePorts`, shared move/recovery outcomes, and public pi command API. Produces `registerMoveCommand(pi: ExtensionAPI, request: (input: MoveRequest) => Promise<Outcome<MoveResult>>): void`. CLI resolves exact ID, unambiguous prefix/name from hub catalog, and `mac` to enrolled Mac. Model tool schema gains no credential or home mutation.

- [ ] **Step 1: Write the failing tests.** Name `Mac slash move targets only persistent top-level current session`, `box slash move points to Mac without request rows`, `ambiguous name refuses with candidates`, `pending outcome explains paused source`, `success repeats lost peers and tool warnings`, and `model tool cannot provision or mutate home`. Assert:

```typescript
expect(pending.text).toContain("The source is paused to avoid running two copies.");
expect(success.text).toContain(destinationTerminal);
expect(success.lostPeers).toEqual(preflightLostPeers);
expect(toolWarningBlocksMove).toBe(false);
expect(boxRequestRows).toHaveLength(0);
expect(exitCodes).toEqual([0, 1, 2, 3]);
```

Parameterize CLI coverage for status, sync, enable, disable, provision, doctor, recover, cancel, forget, stop, resume, repo map, claim, and memory tag. JSON includes stable reason, operation ID, current home, epoch, and repair command. Invalid arguments perform no effects. Capture output and assert no secret, conversation body, or uncommitted content appears. Add `/move with roaming disabled refuses with a clear reason`, asserting `expect(result.reason).toBe("roaming-disabled")` and `expect(moveEffects).toEqual([])`.
- [ ] **Step 2: Run red.** `npm test -- --maxWorkers=2 packages/host/src/roam/__tests__/roam-move-command.test.ts packages/roam/src/__tests__/commands.test.ts`. Expected: the named missing behavior or export fails.
- [ ] **Step 3: Implement the exports.** Product alone wires the 4.3b socket factory into first admission before ordinary startup and session inspect/freeze/start/retire/unfreeze dispatch into agent.ts. Start uses roaming participant ports, not a nonexistent live socket. `/move` is primary and refuses clearly while disabled. Mac controls use a private same-user socket and bounded progress. On boxes only doctor, local status, and repo mapping execute locally; other controls direct callers to Mac. Disallow child, print, transient, and nonpersistent slash moves. Warn missing tool auth without blocking, block missing pi auth, list lost intercom peers before and after, and never promise relay. Recover reports the safe next action or missing evidence, not a new attempt. Disable refuses an in-progress move and never stops box homes or erases them. Wire all fourteen CLI controls to real implementations, preserving exit codes and secret-safe JSON.
- [ ] **Step 4: Run green.** Repeat the red command. Expected: disabled safety, complete CLI behavior, no box request rows, and no model home mutation.
- [ ] **Step 5: Commit.** `git commit -m "feat(roam): expose guarded move and recovery commands"`.

### Task 4.6c: Gate packaged moves and document the complete feature

**Track:** Product. Depends on 4.6b.

**Files:**
- Create: `packages/herdr/e2e/scenarios/roam-move.test.ts`.
- Create: `packages/herdr/e2e/scenarios/roam-recovery.test.ts`.
- Modify: `docs/architecture/roaming.md`.
- Modify: `README.md`.
- Modify: `scripts/herdr-e2e.mjs`.
- Modify: `packages/herdr/e2e/README.md`.

**Interfaces:** Consumes all packaged CLI commands and real move composition. Produces serial `headless` tier scenarios R06 outward move, R07 return move, R08 exclusion/rollback, R09 revoked-home restore, and R10 packaged nonowner admission. Named scenario arrays, explicit tier lists, discovery, selection, duration, and matrix reporting use existing acceptance contracts.

- [ ] **Step 1: Write the failing tests.** Name stories `outward move preserves state`, `return move reuses checkout`, `lost readiness prevents unsafe rollback`, `revoked home restores mirrored prefix`, and `copied participating file refuses ordinary work`. Stories use packed real pi and owned isolated cores, not fake acceptance summaries. Assert `expect(actualSessionId).toBe(originalSessionId)`, `expect(actualCwd).toBe(mappedCwd)`, `expect(owners).toHaveLength(1)`, `expect(actualTrees).toEqual(expectedTrees)`, and `expect(foreignCharges).toEqual([])`. Both-direction, rollback, revocation, copied-file refusal, lost peers, and tool-auth warnings must be observed. Core/pi stories are exempt from the five-second ceiling and run one at a time with existing harness startup/per-wait/runner deadlines. Unit/integration tests remain at 5000 ms.
- [ ] **Step 2: Run red.** `npm run test:herdr:e2e -- --built --tier headless --story R06,R07,R08,R09,R10`. Expected: the named missing behavior or export fails.
- [ ] **Step 3: Implement the exports.** Add the composed synthetic stories and operator docs. Register R06 through R10 explicitly in `headless`, R01 remains headless, R02 remains app, R03 through R05 remain headless. Preserve serial story workers and record each duration. Document v1 exclusions without implementing them. Keep all service/limit/power/boot effects fake even when story cores and pi processes are real; the harness owns every real core/terminal.
- [ ] **Step 4: Run green.** Repeat the red command. Run the common phase gate and `npm run test:herdr:e2e -- --built --tier headless --story R01,R03,R04,R05,R06,R07,R08,R09,R10`, then `npm run test:herdr:e2e -- --built --tier app --story R02`. Expected: A12 through A16 plus prior acceptance, actual IDs/cwd/homes/leases/trees/ledgers/placement, unchanged unrelated roots, and proved cleanup. Deploy disabled before 4.7.
- [ ] **Step 5: Commit.** `git commit -m "test(roam): gate packaged moves and recovery stories"`.

### Task 4.7: Run private real-box acceptance before enablement

**Track:** Acceptance. **Maintainer step, not a worker task or a long-running Vitest test.** Depends on 4.6c, the full gate, and a disabled deployment.

**Files:** No public product edits. Keep receipts, machine inventory, actual URL equivalence checks, authentication observations, and real checkout-tool findings in private evidence storage. Use a disposable repository and synthetic session. Never use a production conversation.

**Interfaces:** Consumes packaged `spider`, the configured enrolled peer, the release hashes, and acceptance scenarios A1 and A8 through A16. Produces private receipts plus a pass, blocked, or failed decision for each selected scenario. Nothing is enabled merely because a command timed out or an observation was unavailable.

- [ ] **Step 1: Verify real prerequisites and installation.** On private copies of existing core and usage ledgers, record backup time, migration write-lock time, growth, and usage v7 migration time. Verify historical duplicate-path rows remain untouched and no full-table rewrite occurs. Record native Linux SQLite load, pinned pi and intercom versions, release hashes, Node range, exact core identity, inherited hard and soft nofile limits, inotify values, and core-only extension load inside a core-spawned terminal. Verify both pinned Node versions with native-module and extension-load probes on disposable Linux roots. Verify existing core units and unrelated terminals are unchanged. Sign in at destination rather than silently copying auth.
- [ ] **Step 2: Measure transport and actual apply.** Record successful raw 384 KiB chunk timings and throughput, export and import durations including lexical work, and binary and session artifacts above 64 MiB. Exercise resumable corruption and lost-result reconciliation within configured limits. Verify two-peer concurrency if two disposable peers are available; otherwise report that optional measurement as blocked rather than claiming a measured default.
- [ ] **Step 3: Prove two-hour no-client hosting.** Start one exact synthetic session and trigger, then disconnect or power off the Mac client for two hours. Reconnect and verify the same terminal survived and the trigger fired once. Keep the waiting observation outside Vitest. Separately exercise supervisor and core restart recovery and deliberate stop using an isolated acceptance core and supervisor unit. Never restart a shared core for this check. Record that host reboot remains unavailable until desktop sign-in, not automatic power-on recovery.
- [ ] **Step 4: Move out and back with real checkout constraints.** Privately verify the actual equivalent-origin pair and whether default no-checkout or configured worktree creation works for the real sparse or virtualized checkout. Use synthetic content for the real test. Record the one-time `update-index --refresh` cost on the real sparse or virtualized checkout. Exercise A12 staged and working changes, A13 older selected leaf and usage round trip, A14 blockers and warnings, and A15 through A16 lost replies, dormant source, multi-store freeze, rollback exclusion, copied-file refusal, offline active continuation, and mirror-based forget on disposable identities. Inspect real values, not just success summaries.
- [ ] **Step 5: Decide enablement.** Require A1's terminal survival and all applicable A8 through A16 receipts, unchanged unrelated roots, and no unresolved required observation. Confirm detached usage workers are schema- and origin-compatible and reloaded. Attempt enable with a disposable older live top-level process to observe mechanical refusal through Herdr process-presence build capability, then reload it and retry. Never bypass that guard. Only then explicitly enable replication and hosting. Keep disabled if any required real acceptance is blocked or failed. No public commit contains these receipts.

## Acceptance coverage

| Scenario | Tasks that implement and prove it | Required final evidence |
| --- | --- | --- |
| A1 | 2.4 export/apply timing, 3.2a inventory and 3.2b native install, 3.5 in-terminal load, 4.7 measurements/two-hour survival | Private real-box receipt, not reported host uptime |
| A2 | 1.1 identity, 1.2 backup/migration/drift, 1.8 maps and cached fallback, 1.10 composition | Fresh/v13 equality, backup failure refusal, and nonblocking trigger drift |
| A3 | 1.3a function-free capture and exact baseline SQL, 1.3b todo admission, 1.4b retired membership, 1.10 composition | Actual baseline, new, and CLI writers, recursion on/off and frozen refusal |
| A4 | 1.4a HLC/export, 1.4b permutations/tombstones/idle logs, 2.4 sync | Three independent roots converge without idle growth |
| A5 | 1.4b receipts/conflicts, 1.5 invalidation, 1.7 accounting, 2.3b lost results | Digest replay creates no duplicate rows, notices, or charges |
| A6 | 1.5 derived data/event policies, 1.6 producers, 1.8 catalog/tags | Read-only hub reads without checkout and correct lexical text |
| A7 | 1.6 operational guards, 1.7 discovery/restore, 1.10 composition | Foreign PID/directory collisions cause zero actions |
| A8 | 2.2 bytes/deadlines, 2.3a chunks/staging and 2.3b receipts, 2.6 serial acceptance, 4.7 real transfer | Above-64-MiB byte equality and corruption refusal |
| A9 | 2.5a placement, 2.5b locked service, 2.5c build/SQLite doctor, 2.6 enable capture and serial stories | No app/core auto-start, one placement, old live build refusal, hub homes replicate |
| A10 | 3.1 core-only, 3.2a resources/systemd and 3.2b consent/install, 3.5 serial stories, 4.7 real install | No auth transfer without consent, unchanged core, one service, fake OS calls in tests |
| A11 | 3.3a exact launcher and 3.3b supervisor, 3.4 readiness/ports, 3.5 serial recovery, 4.7 no-client observation | One exact-file owner including pre-sync origin, durable stopped/suspended intent |
| A12 | 4.1a source and 4.1b destination Git fixtures, 4.6a real adapters, 4.6c both directions, 4.7 real checkout | Equal HEAD/index/working trees, unchanged source index bytes and unrelated roots |
| A13 | 1.7 local segment accounting, 4.2 actual pi file tests, 4.6c round trip, 4.7 real move | Same session/selected branch/cwd, unchanged historical facts, local-only charges |
| A14 | 1.6 run blockers, 4.3a full inventory, 4.4a pre-stage/power, 4.6b warnings, 4.6c stories | Exact blockers, lost peers, nonblocking tool-auth warnings, injected power |
| A15 | 2.4 homes/CAS, 4.3b live/dormant freeze, 4.4b fault recovery, 4.5 forget, 4.6c stories, 4.7 real recovery | No unsafe rollback, durable revoked identity, higher epochs |
| A16 | 1.3a fences and 1.3b seed, 1.9a ID lock and 1.9b scoped admission, 3.4 box origin, 4.3b reload, 4.5 claim, 4.6b disabled refusal and 4.6c copied files | Nonowners make no requests/writes, nonparticipants bypass gates, offline active homes continue |

## Completion checks

- [ ] Each spec requirement has a task and each A1 through A16 has the evidence above. Deferred follow-ups remain deferred.
- [ ] Every worker task has exact file ownership, complete interface inputs, a named failing test, a red command, implementation decisions, a green command, and a commit.
- [ ] Generated SQL matches descriptors and contains no application-defined functions. Fresh and migrated layouts match.
- [ ] All four phase gates include typecheck, tests, build, packaged CLI where available, isolated Herdr acceptance, and disabled deployment before the next phase.
- [ ] Required private real acceptance is complete before enablement. No credentials, real-machine paths, private results, or private inventories enter public artifacts.

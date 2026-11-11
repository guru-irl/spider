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
- Rollout must reload every consumer, including detached usage workers, before replication is enabled. Function-free SQL protects old writes, not old consumers of foreign history.
- Every worker task follows red, green, then commit. Do not commit missing imports or temporary production stubs. Test doubles implement the specified ports.
- Run every new Vitest test and new isolated story with a 5000 ms ceiling, including the runner budget for R-prefixed stories. Use fake time for minute-scale policies. Split broad matrices into parameterized cases, not one long test.
- Use `@spider/db-core/testutil` fixture paths, independent machine roots, real migrations, and generated triggers. Clear inherited child and DB variables as described in `CONTRIBUTING.md`. Parent-only organism tests explicitly stub `PI_SUBAGENT_CHILD` to `0`.
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
	winning(db: Db, before: JsonObject | null, change: Change): void;
	committed(storeKey: StoreKey): void;
}
export interface ProcessIdentity { bootId: string; pid: number; startTime: string }
export type Probe = { kind: "absent" } | { kind: "uncertain" }
	| { kind: "live"; identity: ProcessIdentity };
```

Bodies use descriptor-defined columns. Wire records never contain local registry or DB paths. `BatchArtifact.file` is a private local handle, not a wire field. `clock.machine` and `clock.stream` carry original envelope origin. Forwarding adds only a local sequence.

Task 1.2 creates `packages/db-core/src/__tests__/roam-fixture.ts` with `createReplica(scope: Scope, machineId: MachineId): ReplicaFixture`. `ReplicaFixture` has `{root: string; db: Db; storeKey: StoreKey; machineId: MachineId; close(): void}`. The factory uses actual migration, distinct roots, deterministic store keys, and no global production state. Every fixture that enables capture first fills `store_key`. Each task owns its other fixtures alongside its named tests.

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

Task 2.1 declares the following configuration, operation, service, and move types in `@spider/roam/contracts`. Database types are imported type-only from db-core. Task 1.9 declares the host types below in `@spider/host` source submodules, not in the roaming package.

```typescript
export interface Peer { machineId: MachineId; alias: string; node: string;
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
export interface AdmissionPorts { localMachine: MachineId; expectedEpoch: number | null;
	load(sessionId: string): Promise<{home: Home | null; states: readonly SessionState[];
		origin: MachineId; unfinishedFreeze: boolean; initialConflict: boolean}>;
	lock(sessionId: string, file: string): Promise<() => Promise<void>>;
}
```

Participation state exists in each affected worktree DB. Global and repo stores have replication barriers, not session-state rows. Separate binding worktrees join the affected-store roster before seeding, admission, or freeze.

### Shared move contracts

Task 2.1 also declares these pure data and port types in `@spider/roam/contracts`. Declaring them enables independent phase 4 tracks without placeholder implementations. They are part of Global Constraints supplied to every worker. Local paths in these types are participant handles, not replicated row fields.

```typescript
export interface WorkspaceSnapshot { root: string; repoKey: string; workspaceId: string;
	moveId: string; stage: "pre" | "final"; head: string; branch: string | null;
	objectFormat: "sha1" | "sha256"; indexTree: string; workingTree: string;
	relativeCwd: string; sparsePatterns: string | null; worktreeConfig: string | null;
	refs: readonly string[]; prerequisites: readonly string[];
	bundleArtifactId: string; bundleBytes: number }
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

All external port replies are validated at their boundary. `retire` returns absent only after stopped ownership and durable retirement, not after a disconnected probe. `start` persists readiness before returning. `seed` and `barriers` cover every store in `MoveCheck.storeKeys`, including a separately bound workspace. A power handle survives all recovery in that process; hub restart reacquires it before reconciling incomplete moves.

## Review Focus

Each additional case has a named owning test below.

1. A configuration or origin change must not silently rekey a store, expose credentials, or write a different checkout. Tasks 1.1, 1.8, and 4.1.
2. A malformed batch near a size, integer, or clock boundary must leave every row, cursor, and receipt unchanged. Tasks 1.4 and 2.3.
3. Disk exhaustion, symlink replacement, or a stale staging reference must not install a partial artifact or delete referenced recovery evidence. Tasks 2.3 and 4.2.
4. A recycled PID, changed boot ID, or lost readiness reply must never authorize another owner. Tasks 1.9, 3.3, and 4.4.
5. A selected older branch, unknown extension entry, or parser reset must preserve history without charging a foreign segment. Tasks 1.7 and 4.2.

---

## File boundaries and delivery order

A track owns its listed files for that phase, including tests. Tracks run concurrently only after their explicit prerequisites are integrated. Within a track, tasks run in numeric order. A later phase may change earlier files after the earlier phase is merged and deployed. Shared-file edits belong to one integration track, not to parallel workers. In phase 2 that track supplies foundation task 2.1 first, then resumes after the other tracks merge.

| Phase and track | Tasks | Exclusive file responsibility | Starts after | Merge order |
| --- | --- | --- | --- | --- |
| 1 Data | 1.1, 1.2, 1.3 | db-core types, identity, descriptors, migration, SQL generation, state, seed, todo store | Start | First |
| 1 Merge | 1.4 | db-core HLC, codec, export, apply | 1.3 | Second |
| 1 Derived | 1.5 | db-core replica effects and event export policy, memory embedding version checks | 1.3 | Third |
| 1 Runs | 1.6 | subagents operational origin checks and blocker inventory | 1.5 | Fourth |
| 1 Usage | 1.7 | host usage store, parser, discovery, accounting | 1.2 | Fifth |
| 1 Reads | 1.8 | db-core catalog and registry resolution, todo actions, context search, memory injection and tagging | 1.4 and 1.5 | Sixth |
| 1 Host | 1.9, 1.10 | host activation and gates, composition, phase gate | 1.6, 1.7, and 1.8 | Last |
| 2 Transport | 2.2 | Herdr generic byte execution, transfer adapter, fake hc | 2.1 | Second |
| 2 Artifacts | 2.3 | roam staging, artifact agent commands | 2.1 | Third |
| 2 Hub | 2.4 | roam sync, peer state, barriers | 2.2 and 2.3 | Fourth |
| 2 Service | 2.1, 2.5, 2.6 | roam package and contracts, journals, launchd, hub entry, CLI, diagnostics, placement, all manifests and packaging | Phase 1 deployed; 2.5 waits for 2.4 | 2.1 first; 2.5 and 2.6 last |
| 3 Core | 3.1 | Herdr configuration and host Herdr mount | Phase 2 deployed | First |
| 3 Install | 3.2 | roam provisioning, selected-file installer, resource and auth doctor | Phase 2 deployed | Second |
| 3 Hosting | 3.3 | roam supervisor and Herdr leased launcher | 3.1 and 3.2 | Third |
| 3 Host | 3.4, 3.5 | host readiness and admission composition, CLI wiring, hosting acceptance | 3.3 | Last |
| 4 Git | 4.1 | roam workspace snapshot, bundle, checkout restore | Phase 3 deployed | First |
| 4 Files | 4.2 | roam session artifacts and mirrors | Phase 3 deployed | Second |
| 4 Control | 4.3 | host control socket and freeze adapters, roam participant control | Phase 3 deployed | Third |
| 4 Moves | 4.4, 4.5 | roam move state machine, recovery, claim, revocation | 4.1, 4.2, and 4.3 | Fourth |
| 4 Product | 4.6 | host `/move`, CLI composition, acceptance stories, docs | 4.5 | Last |
| 4 Acceptance | 4.7 | Private real-machine evidence and enablement decision | 4.6 and full phase gate | Maintainer step, no worker |

The Merge and Derived tracks do not edit each other's modules. Merge accepts a required `ReplicaEffects` port from the shared types. Derived supplies it. Task 1.10 composes both. Reads alone changes the existing registry and read action files. Host alone changes `extension.ts` and the startup gate call sites outside Usage. No task adds per-task review stages.

### Common phase gate

Run this gate on the integrated phase branch, not separately in each parallel track:

```bash
npm run check:lockfile
npm run typecheck
npm run typecheck:herdr:e2e
env -u PI_SUBAGENT_CHILD -u PI_SUBAGENT_RUN_ID -u PI_SPIDER_DB_PATH -u PI_SPIDER_SESSION_ID npm test
npm run build
npm pack --dry-run --json --ignore-scripts | node scripts/check-package-files.cjs
npm run test:herdr:e2e:ci -- --built
npm run test:herdr:e2e -- --built
```

Expected: all selected checks pass, no skipped required acceptance, fixture cleanup is proved, and unrelated roots and terminals are unchanged. Add packaged roaming CLI checks beginning in phase 2. Real-machine receipts remain private. Review the frozen combined phase in parallel with this gate, fix findings once, and rerun affected checks. Only critical findings require another review. Merge and deploy disabled before proceeding.

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
expect(DESCRIPTORS.runs.columns).not.toEqual(expect.arrayContaining(["pid", "host_pid", "pid_start_time", "intercom_session"]));
expect(DESCRIPTORS.sessions.columns).not.toContain("imported_from");
expect(secondMachineId).toBe(firstMachineId);
```

Use the spec's legacy HTTPS, modern HTTPS, and `git@ssh.code.example:v3/org/team/repo` fixture. Include invalid URLs, local paths, encoded slash, and IPv6 authorities. Unknown hosts do not acquire guessed aliases.

- [ ] **Step 2: Run red.** `npm test -- packages/db-core/src/__tests__/roam-identity.test.ts`. Expected: missing roaming modules or assertions fail for the specified identities.
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
- Modify: `packages/db-core/src/__tests__/schema-migration-parity.test.ts`.
- Modify: `scripts/postinstall.mjs`.

**Interfaces:** Consumes `loadMachineIdentity(globalRoot: string): MachineId`, `DESCRIPTORS`, and shared `Scope`. Produces `migrate(db: Db, scope: Scope | "project", options?: {machineId: MachineId}): void`, with the existing two-argument API retained; `validateRoamLayout(db: Db, scope: Scope): void`; `snapshotCoreDb(db: Db, destination: string): Promise<void>`; `repairTodoSequenceIndex(db: Db): void` for an explicit enable attempt after deliberate repair; and `createReplica` from Global Constraints. `DESCRIPTORS` has type `Readonly<Record<Entity, Descriptor>>` from the shared types.

- [ ] **Step 1: Write the failing tests.** `roam-migration.test.ts` has `fresh and v13 layouts match in every scope`, `backfill preserves integer IDs and FTS rowids`, `duplicate sequences disable only roaming`, `future schema refuses before application queries`, `concurrent writable opens reread version under IMMEDIATE`, `owned trigger or column drift refuses writable open`, and `backup API includes committed WAL data`. Assert:

```typescript
expect(db.pragma("user_version")).toBe(14);
expect(afterIds).toEqual(beforeIds);
expect(afterFtsRowids).toEqual(beforeFtsRowids);
expect(meta).toMatchObject({ roamable: 0 });
expect(problem).toContain(conflictingRowId);
expect(() => openFuture()).toThrow(/future/);
expect(futureDigestAfter).toBe(futureDigestBefore);
```

Check UUIDs against `/^[0-9a-f]{32}$/`, origin backfill against the fixture machine, and ordinary todo writes after a diagnosed duplicate. After manual duplicate repair, explicit index repair succeeds. Doctor never calls repair. A missing index without the diagnosed conflict is layout corruption.

- [ ] **Step 2: Run red.** `npm test -- packages/db-core/src/__tests__/roam-migration.test.ts packages/db-core/src/__tests__/schema-migration-parity.test.ts`. Expected: schema version or missing-column failures.
- [ ] **Step 3: Implement migration and validation.** Read `user_version` inside `db.raw.transaction(...).immediate()`. Reject versions above 14 before queries against application tables. Add columns, fill existing todo and event UUIDs, and create `idx_todos_uuid`, `idx_run_events_uuid`, and conditional unique `idx_todos_session_seq ON todos(session_id, seq)`. Backfill origins from the local machine. Fresh DDL matches migrated DDL. Keep all shipped v13 and earlier migration strings unchanged. Initialize metadata with capture disabled, one machine UUID, and a fresh stream UUID. Use the SQLite backup API or `VACUUM INTO` for backups, never a live file copy.

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

Also add global `session_homes(session_id TEXT PRIMARY KEY, machine_id TEXT NOT NULL, epoch INTEGER NOT NULL CHECK(epoch > 0), move_id TEXT, updated_at INTEGER NOT NULL)` and worktree `roam_sessions(session_id TEXT PRIMARY KEY, epoch INTEGER NOT NULL CHECK(epoch > 0), state TEXT NOT NULL CHECK(state IN ('active','frozen','retired')), move_id TEXT, freeze_seq INTEGER)`. Install generated trigger text from 1.3 in that task, then require it in owned-layout validation. Add these local-only tables to fresh and v14 migration DDL now, so later phases need no same-version schema edits: global `roam_repo_maps(repo_key TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, origin_fingerprint TEXT, root_fingerprint TEXT, worktree_command_json TEXT)`, `roam_workspace_maps(repo_key TEXT NOT NULL, workspace_id TEXT NOT NULL, path TEXT NOT NULL UNIQUE, snapshot_json TEXT, PRIMARY KEY(repo_key, workspace_id))`, `roam_locations(session_id TEXT PRIMARY KEY, stores_json TEXT NOT NULL, home_json TEXT, file TEXT, cwd TEXT)`, and `roam_home_actions(move_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, expected_epoch INTEGER NOT NULL, args_digest TEXT NOT NULL, cancelled INTEGER NOT NULL DEFAULT 0, committed_home_json TEXT)`. Add worktree `roam_seed_progress(session_id TEXT NOT NULL, entity TEXT NOT NULL, last_key TEXT, complete INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(session_id, entity))`. These tables are excluded from descriptors. Other operation journals remain separate private DBs.

- [ ] **Step 4: Run green.** Repeat the red command and `npm test -- packages/db-core/src/__tests__/postinstall-global-root.test.ts packages/db-core/src/__tests__/postinstall-fresh-install-repair.test.ts`. Expected: all pass and backups reopen with committed WAL rows.
- [ ] **Step 5: Commit.** `git commit -m "feat(db): migrate canonical stores to roaming schema 14"` after staging the listed files.

### Task 1.3: Generate atomic capture, membership, and freeze fences

**Track:** Data. Depends on 1.2.

**Files:**
- Create: `packages/db-core/src/roam/generate.ts`.
- Create: `packages/db-core/src/roam/generated.ts`.
- Create: `packages/db-core/src/roam/state.ts`.
- Create: `packages/db-core/src/roam/seed.ts`.
- Create: `packages/db-core/src/__tests__/roam-capture.test.ts`.
- Create: `packages/db-core/src/__tests__/roam-seed.test.ts`.
- Create: `scripts/generate-roam-sql.mjs`.
- Create: `packages/todo/src/__tests__/roam-writes.test.ts`.
- Modify: `packages/db-core/src/roam/layout.ts`.
- Modify: `packages/db-core/src/migrate.ts`.
- Modify: `package.json`.
- Modify: `packages/todo/src/store.ts`.

**Interfaces:** Consumes `DESCRIPTORS: Readonly<Record<Entity, Descriptor>>`, `Db`, `Home`, `SessionState`, and `StoreKey`. Produces `captureSql(scope: Scope): string`; `readSessionState(db: Db, sessionId: string): SessionState | null`; `assertTodoHome(db: Db, sessionId: string, localMachine: MachineId, home: Home | null): void`; `seedSession(db: Db, sessionId: string, epoch: number, limit: number): {complete: boolean; through: number}`; and `enableMemoryCapture(db: Db, key: StoreKey): void`. Existing `addTodo`, `toggleTodo`, `removeTodo`, and `clearTodos` signatures stay intact. The store performs the shared admission check and resolves updates to UUID inside an IMMEDIATE transaction.

- [ ] **Step 1: Write the failing tests.** In `roam-capture.test.ts`, parameterize `function-free writers capture one normalized change` over new wrapper, raw better-sqlite3 with no functions, and sqlite3 CLI, with recursion 0 and 1. Name additional tests `capture disabled still fills identities`, `import rollback restores flag and rows`, `trigger failure rolls back source and log`, `frozen and retired fences cover insert update delete`, `PID-only updates emit nothing`, and `unrelated sessions remain writable`. Assert:

```typescript
expect(changesForInsert).toHaveLength(1);
expect(change.body.uuid).toBe(persistedUuid);
expect(() => frozenWrite()).toThrow("session is frozen");
expect(logAfterRollback).toEqual(logBefore);
expect(metaAfterRollback.importing).toBe(0);
expect(changesAfterPidOnly).toEqual(changesBeforePidOnly);
```

Cover all seven entities and immutable IDs and origins, not only todos. In `roam-seed.test.ts`, name `seed resumes while normal capture continues`, `abort retains membership`, and `memory enable seeds atomically once`. Assert no duplicate version for a concurrently updated or deleted key. In `roam-writes.test.ts`, name `cross-session mutation checks target home`, `allocation serializes sequences`, and `edits address resolved UUID`. A read remains allowed for a foreign session, but mutation refuses.

- [ ] **Step 2: Run red.** `npm test -- packages/db-core/src/__tests__/roam-capture.test.ts packages/db-core/src/__tests__/roam-seed.test.ts packages/todo/src/__tests__/roam-writes.test.ts`. Expected: missing capture or foreign-write refusal assertions fail.
- [ ] **Step 3: Implement generated SQL and state helpers.** Generate literal SQL at build time from descriptors. Keep the spec's todo trigger text below unchanged. Generate corresponding update and delete triggers, identity and origin fills, and before-update and before-delete fences for every participating entity. Compare old and new projected JSON with `IS NOT`. No application-defined SQL functions, trigger-order dependency, or reentrant queries. Add metadata guards that reject negative clocks or values above 9007199254740991, including SQL capture overflow.

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

Fences use `OLD.id` for sessions, otherwise `OLD.session_id`, and check the new session identity on updates. They bypass only importing, even if capture is disabled. Membership is durable and has no expiry. First-move seeding uses bounded keyset transactions, selects only unversioned rows, and leaves capture active. Persist its progress locally. Memory seeding and capture enablement share one transaction. Raw older inserts fill origins before one captured insertion. Explicit enable checks the diagnosed sequence index before clearing `roamable=0`.

- [ ] **Step 4: Run green.** Repeat the red command. Run `node scripts/generate-roam-sql.mjs --check` and the migration parity tests. Expected: pass, generated output matches, and CLI connections require no function registration.
- [ ] **Step 5: Commit.** `git commit -m "feat(db): capture roaming changes with durable SQL fences"`.

### Task 1.4: Implement snapshot export and convergent apply

**Track:** Merge. Depends on 1.3. Can run with Derived and Usage. Runs starts after Derived is complete.

**Files:**
- Create: `packages/db-core/src/roam/hlc.ts`.
- Create: `packages/db-core/src/roam/codec.ts`.
- Create: `packages/db-core/src/roam/export.ts`.
- Create: `packages/db-core/src/roam/apply.ts`.
- Create: `packages/db-core/src/__tests__/roam-hlc.test.ts`.
- Create: `packages/db-core/src/__tests__/roam-merge.test.ts`.
- Create: `packages/db-core/src/__tests__/roam-replay.test.ts`.

**Interfaces:** Consumes shared `Change`, `RecordChange`, `BatchHeader`, `BatchArtifact`, `ApplyReceipt`, `Home`, and `Db`. Produces `compareHlc(a: Hlc, b: Hlc): -1 | 0 | 1`; `observeHlc(local: Hlc, remote: Hlc, now: number): Hlc`; `exportBatch(db: Db, request: {after: number; targetBytes: number; batchId: string}, policy: ExportPolicy): Promise<BatchArtifact>`; `validateBatch(artifact: BatchArtifact, expected: {storeKey: StoreKey; senderMachine: MachineId; senderStream: string; now: number}): Promise<ValidatedBatch>`; and `applyBatch(db: Db, batch: ValidatedBatch, options: {hubMachine: MachineId; effects: ReplicaEffects; now: number}): ApplyReceipt`. `ValidatedBatch` is an opaque validated file handle exposing readonly `header`, `sha256`, and `byteLength`, created only by `validateBatch`. Consumes the shared required ports: `ExportPolicy.encode(entity: Entity, body: JsonObject, origin: MachineId): JsonObject`; `ReplicaEffects.winning(db: Db, before: JsonObject | null, change: Change): void` and `ReplicaEffects.committed(storeKey: StoreKey): void`. These two ports are declared in the shared types by 1.1. Task 1.5 implements them.

- [ ] **Step 1: Write the failing tests.** `roam-hlc.test.ts` has `backward time advances the logical count`, `receive implements all max-clock cases`, `rejects overflow`, and `rejects skew above five minutes`. `roam-merge.test.ts` has `three roots converge in every peer order`, `old puts cannot revive tombstones`, `idle forwarding stops log growth`, `foreign first row creates retired membership atomically`, and `home updates require hub origin and monotone epoch`. Assert:

```typescript
expect(replicas.map(portableState)).toEqual([expected, expected, expected]);
expect(logSizesAfterIdle).toEqual(logSizesBeforeIdle);
expect(observeHlc(local, remote, now).count).toBe(expectedCount);
expect(() => applyForeignThenCliWrite()).toThrow("session is frozen");
expect(stateAfterImportRollback).toBeNull();
```

`roam-replay.test.ts` has `lost acknowledgement replays the digest receipt`, `duplicate change ID requires identical canonical envelope`, `losing versions still append once`, `cursor skip overlap and log gap refuse`, `invalid last record leaves all state unchanged`, and `todo conflict replaces only unlogged non-home rows`. Assert unchanged cursor and receipts on each malformed input, equal-clock divergent IDs or content, exactly-at and just-over size limits, non-safe integers, wrong schema, and future skew. A tracked todo collision reports both UUIDs and preserves its tombstone. Parameterize order tests so each stays below five seconds.

- [ ] **Step 2: Run red.** `npm test -- packages/db-core/src/__tests__/roam-hlc.test.ts packages/db-core/src/__tests__/roam-merge.test.ts packages/db-core/src/__tests__/roam-replay.test.ts`. Expected: missing HLC or apply exports.
- [ ] **Step 3: Implement the exports.** Export from a SQLite snapshot without holding a writer transaction across transport. Cache locator-converted bodies once in `wire_json`, leaving it NULL when identical. Forward and dedupe with `coalesce(wire_json, body_json)`. Validate immutable UTF-8 NDJSON, exact bytes and digest, envelope shapes, keys, contiguous sequences, bounds, and the complete artifact before apply. Count-zero export has `through=after` and creates neither import nor receipt.

Apply in one IMMEDIATE transaction: check cursor or exact receipt, set importing, insert missing retired foreign membership without changing existing state, append every unseen original envelope, mutate only winning versions, maintain tombstones and required effects, observe HLC, commit cursor and digest receipt, and clear importing. Dedupe before log insertion, never with `INSERT OR IGNORE`. Equal clocks with different IDs or content are corruption. Preserve per-run event order. New applied run rows have null process and intercom columns even on an origin-store rebuild. Apply homes only from the enrolled hub, reject lower epochs, and require equal-epoch owner and move ID equality. A losing memory edit is not field-merged. Cap overflow is a diagnostic, not deletion. Call only `effects.committed` after commit, once for actual changes, never an operational event bus.

- [ ] **Step 4: Run green.** Repeat the red command. Expected: all peer permutations converge and replay leaves rowids, notices, and log counts unchanged.
- [ ] **Step 5: Commit.** `git commit -m "feat(db): export and merge portable roaming batches"`.

### Task 1.5: Maintain derived data and inert event history

**Track:** Derived. Depends on 1.3. Integrates after 1.4.

**Files:**
- Create: `packages/db-core/src/roam/effects.ts`.
- Create: `packages/db-core/src/roam/event-policy.ts`.
- Create: `packages/db-core/src/__tests__/roam-derived.test.ts`.
- Create: `packages/db-core/src/__tests__/roam-event-policy.test.ts`.
- Create: `packages/memory/src/__tests__/roam-embedding.test.ts`.
- Modify: `packages/memory/src/embeddings/queue.ts`.
- Modify: `packages/memory/src/embeddings/worker.ts`.
- Modify: `packages/memory/src/embeddings/vectors.ts`.

**Interfaces:** Consumes `Db`, shared `Change`, `Entity`, `JsonObject`, and shared `ExportPolicy` and `ReplicaEffects` from `@spider/db-core/roam/types`. Produces structural implementations: `createReplicaEffects(notify: (key: StoreKey) => void): ReplicaEffects`; `createExportPolicy(resolve: (path: string, origin: MachineId) => Locator | HistoryRef): ExportPolicy`; `EVENT_POLICIES: Readonly<Record<string, "inert" | "supervisor" | "transcript" | "chain">>`. Embedding work carries the queued winning `changeId`, and completion checks that ID before clearing work.

- [ ] **Step 1: Write the failing tests.** `roam-derived.test.ts` has `winning changes update lexical state transactionally`, `session summaries do not replace imported excerpts`, `unrelated imported FTS rows survive`, and `rollback restores derived state`. Assert:

```typescript
expect(searchOldText()).toEqual([]);
expect(searchWinningText()).toContainEqual(expect.objectContaining({ uuid }));
expect(importedContentAfter).toEqual(importedContentBefore);
expect(notificationTypes).toEqual(["replica-invalidated"]);
```

`roam-event-policy.test.ts` has `known directory payloads become history references`, `chain steps never remain executable`, `unknown types and versions remain inert unchanged`, and `wire content is cached once`. Assert no supervisor directory, transcript directory, endpoint, or token in known sanitized payloads, and `expect(chainBody).toMatchObject({count: 2})`. `roam-embedding.test.ts` has `old completion cannot clear replacement work` and asserts the newest text remains queued after a stale completion.

- [ ] **Step 2: Run red.** `npm test -- packages/db-core/src/__tests__/roam-derived.test.ts packages/db-core/src/__tests__/roam-event-policy.test.ts packages/memory/src/__tests__/roam-embedding.test.ts`. Expected: missing replica effects or stale-work protection.
- [ ] **Step 3: Implement effects and policy.** Allocate local rowids, maintain external-content todo FTS and active repo memory FTS in the apply transaction, and update sessions FTS name and summary without importing excerpts. Remove stale vectors and enqueue current text transactionally. Version-check embedding completion. Keep lexical reads independent of providers. Sanitize `child_supervisor`, `child_transcript`, and `chain_steps` at export, using origin-qualified references. Unknown event types and versions pass through unchanged as history. Add policies for the existing named helpers and dynamic producer types checked in 1.6. No imported event calls `appendRunEvent`.
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

- [ ] **Step 2: Run red.** `npm test -- packages/subagents/src/__tests__/roam-origin.test.ts packages/subagents/src/__tests__/roam-producers.test.ts`. Expected: foreign fixture triggers an observable operational call or missing local-origin guards.
- [ ] **Step 3: Implement origin filters at each operational entry.** Guard selection and direct-ID paths for reaping, adoption, kill, status mutation, completion delivery, messaging, usage reporting, and event tailing. A foreign event never revives continuation data. Include pending coordinator stages and undelivered durable completion in the read-only blocker inventory. Centralize dynamic child event variants in the existing schemas and compare the actual producer catalog against db-core's export policy in tests. No runtime db-core import of subagents.
- [ ] **Step 4: Run green.** Repeat the red command and `npm test -- packages/subagents/src/__tests__`. Expected: native lifecycle remains unchanged and one local completion still reports once.
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

**Interfaces:** Consumes shared `Segment` and `MachineId`, existing `UsageLedger`, `ImportState`, and `UsageAccounting`. Produces `segmentMachine(entry: unknown, previous: MachineId | null): MachineId | null` in `segments.ts`, validating only recognized segment metadata. Extend existing `SourceContext` with `segmentState: {executionMachine: string | null; historyMachine: string | null} | null`, persisted in a versioned wrapper inside the existing `source_context.header` JSON. Decode older unwrapped headers without changing historical facts or shipped SQL, and `CallRow` with `executionMachine: string | null`, mapped to SQL `execution_machine`. Keep path-based call IDs and public parser signatures. Extend `migrateUsageLedger(db: Db, options?: {machineId: MachineId}): void`; default identity resolution is lazy and fixture-overridable. Backfill data in its transaction after v7 DDL, not in the reference-layout builder. Native DB discovery and `UsageAccounting.unreportedRuns` require the local run origin, including startup restore.

- [ ] **Step 1: Write the failing tests.** Name `migration seven preserves call IDs prices and proof`, `round trip bills each local entry once`, `physical segments ignore selected branch navigation`, `reset caches do not reset managed facts`, `unknown entries preserve parser progress`, and `startup restore ignores foreign runs` across the named files. Assert:

```typescript
expect(after.map(c => [c.id, c.price, c.sourceKind, c.originKey])).toEqual(before.map(c => [c.id, c.price, c.sourceKind, c.originKey]));
expect(localEntryIds.sort()).toEqual(["a1", "a2", "warm-a", "compact-a"].sort());
expect(new Set(localEntryIds).size).toBe(localEntryIds.length);
expect(foreignCharges).toEqual([]);
```

Ingest A, then B, then A physical segments, include compaction and cache-warming calls, change header and path, reset parser caches, and reingest. Add `first marker beyond a slice cannot charge foreign history` and assert zero charges before metadata attribution completes. A malformed recognized marker refuses managed ingest rather than attributing foreign rows locally. Unmanaged historical ingestion retains its existing behavior.

- [ ] **Step 2: Run red.** `npm test -- packages/host/src/usage/__tests__/roam-migration.test.ts packages/host/src/usage/__tests__/roam-segments.test.ts packages/host/src/usage/__tests__/roam-discovery.test.ts packages/host/src/__tests__/roam-usage-accounting.test.ts`. Expected: missing execution attribution or duplicate-charge assertion fails.
- [ ] **Step 3: Implement migration and segment-aware ingestion.** Append migration 7, update fresh creation and full expected-layout validation, and backfill execution machine by UPDATE. Do not edit migrations 1 through 6 or rekey calls.

```sql
ALTER TABLE calls ADD COLUMN execution_machine TEXT;
CREATE UNIQUE INDEX idx_calls_execution_entry
	ON calls(execution_machine, session_id, entry_id)
	WHERE execution_machine IS NOT NULL AND source_kind = 'transcript';
```

Retain the full marker through JSONL projection and compact parsing. The first marker attributes all prior physical entries to `historyMachine`. Later segments use `nextMachine`. Before charging a newly managed or relocated file, perform a bounded metadata-only scan to establish its first marker and history machine. Persist that scan and segment state across slices and process restart. No managed facts are added until initial attribution is known. Then skip foreign segments and existing local session-entry pairs. Discover exact local files, never foreign roots. Filter native run discovery, usage events, reported sentinels, and restore paths before accounting. Usage databases and counters stay local.
- [ ] **Step 4: Run green.** Repeat the red command and `npm test -- packages/host/src/usage/__tests__`. Expected: all pass with unchanged historical call IDs and local-only new charges.
- [ ] **Step 5: Commit.** `git commit -m "feat(usage): attribute roaming transcript segments locally"`.

### Task 1.8: Resolve portable stores and read replicas without checkouts

**Track:** Reads. Depends on 1.4 and 1.5.

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

- [ ] **Step 2: Run red.** `npm test -- packages/db-core/src/__tests__/roam-catalog.test.ts packages/db-core/src/__tests__/roam-mapping.test.ts packages/todo/src/__tests__/roam-reads.test.ts packages/memory/src/__tests__/roam-machine-tags.test.ts`. Expected: missing catalog resolution or foreign injection failure.
- [ ] **Step 3: Implement catalog and adapters.** Only the hub stores unmapped replicas at `<globalRoot>/roam/stores/<store-key-hash>.db`. Resolve placement from local maps, never foreign `projects` rows or wire paths. The catalog records portable stores, latest home, and optional local exact file and cwd. Resolve authoritative homes from `session_homes`, not a stale cached location. Never turn a replica read into a registration write. Session-addressed todo views, session search, and run history use read-only replicas. Later mapping merges envelopes and verifies versions and tombstones before retaining a read-only redirect. Cache sorted-root fallback per common repository. Discovery stays within configured roots, and one workspace maps to one checkout per machine. Non-Git data requires an explicit store key and cannot use automatic workspace transfer. Memory NULL tags apply everywhere. Tag changes only the tag. Doctor's likely-machine-specific report is read-only.
- [ ] **Step 4: Run green.** Repeat the red command. Expected: remote reads work without creating a checkout, and default local search does not broaden.
- [ ] **Step 5: Commit.** `git commit -m "feat(db): resolve read-only portable replicas and local maps"`.

### Task 1.9: Register admission before every ordinary consumer

**Track:** Host. Depends on 1.6, 1.7, and 1.8.

**Files:**
- Create: `packages/host/src/roam/activation.ts`.
- Create: `packages/host/src/roam/admission.ts`.
- Create: `packages/host/src/__tests__/roam-admission.test.ts`.
- Create: `packages/host/src/__tests__/roam-startup-order.test.ts`.
- Create: `packages/host/src/__tests__/roam-pi-contract.test.ts`.
- Create: `packages/herdr/src/sessions/id-lock.ts`.
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

**Interfaces:** Consumes `Home`, `SessionState`, `Probe`, `Blocker`, `Db`, `readSessionState(db: Db, sessionId: string): SessionState | null`, and `listSessionBlockers(db: Db, sessionId: string): readonly Blocker[]`. Produces `registerAdmission(pi: ExtensionAPI, ports: AdmissionPorts): AdmissionGate`; `ordinaryWorkAllowed(): boolean` from module-local activation; and `AdmissionGate` with `inspect(): Admission`, `close(): Promise<void>`, `freeze(moveId: string, epoch: number): Promise<void>`, and `unfreeze(moveId: string, epoch: number): Promise<void>`. `Admission = {kind: "ordinary" | "control-only" | "blocked"; home: Home | null; blockers: readonly Blocker[]}`. `AdmissionPorts` has `load(sessionId: string): Promise<{home: Home | null; states: readonly SessionState[]; origin: MachineId; unfinishedFreeze: boolean; initialConflict: boolean}>`, `lock(sessionId: string, file: string): Promise<() => Promise<void>>`, and `localMachine: MachineId` and `expectedEpoch: number | null`. Also produce generic Herdr `claimIdLock(root: string, sessionId: string, identity: ProcessIdentity, probe: (pid: number) => Promise<ProcessProbe>): Promise<{release(): Promise<void>; transfer(next: ProcessIdentity): Promise<void>}>` in `sessions/id-lock.ts`. Here ProcessIdentity and ProcessProbe are the existing Herdr lease types, not the shared roaming types. Its short process lock serializes liveness checks. Host and later launchers share this ID lock. Append a fifth optional `admitted?: () => boolean` argument to existing `registerOrganism`, preserving its first four arguments. Host always supplies `ordinaryWorkAllowed`; organism never imports host. Pi types come only from its public package root.

- [ ] **Step 1: Write the failing tests.** `roam-startup-order.test.ts` has `admission finishes before first session upsert`, `blocked startup calls no reaper usage trigger feed or organism`, and `nonparticipating Mac sessions keep existing startup`. `roam-admission.test.ts` parameterizes `nonowner blocks each ordinary entry` over input, before-agent-start, turn-start, tools, direct shell, scheduler, messages, notices, and cache warming. Name `all stores must be active`, `unfinished freeze blocks despite active rows`, `same ID different file still has one owner`, `PID reuse or unknown ownership refuses`, and `reload cannot clear frozen state`. Assert:

```typescript
expect(startupCalls).toEqual(["admission"]);
expect(providerRequests).toBe(0);
expect(dbWritesAfterBlock).toBe(0);
expect(abort).toHaveBeenCalledOnce();
expect(secondIdLockClaim).rejects.toThrow(/owner/);
```

`roam-pi-contract.test.ts` exercises the installed pinned pi public SDK with a synthetic provider: admission's abort before a provider request, and the public pending-message and leaf APIs. Do not mock the event runner for that contract test. A nonparticipating copied Mac file on a fresh box remains the documented exception until participation is established.

- [ ] **Step 2: Run red.** `npm test -- packages/host/src/__tests__/roam-admission.test.ts packages/host/src/__tests__/roam-startup-order.test.ts packages/host/src/__tests__/roam-pi-contract.test.ts`. Expected: current scheduler registration precedes admission or a nonowner consumer runs.
- [ ] **Step 3: Implement registration-first admission.** Move admission registration to the first line of extension activation, before scheduler registration. Publish one module-local activation flag, not an async coordination framework. Every later startup consumer checks it before writes or work. Acquire a session-ID lock as well as the existing canonical-file lease, with liveness checked under a process lock. Preserve an active offline home, but never reactivate frozen or retired state from a cached home. Frozen source stays control-only. Use handled input with a home message, `ctx.abort()` for agent starts, and native block results for tools and shell. Suppress shutdown consolidation while frozen. A conflicting initial origin is blocked even without an assigned home. No consumer catches an admission refusal and continues as ordinary work.
- [ ] **Step 4: Run green.** Repeat the red command and existing loop, startup, usage, and organism suites touched by registration changes. Expected: no provider request or ordinary write before admission, and local nonparticipating behavior stays green.
- [ ] **Step 5: Commit.** `git commit -m "feat(host): admit roaming sessions before ordinary work"`.

### Task 1.10: Compose and gate local replication

**Track:** Host. Depends on all phase 1 tasks.

**Files:**
- Create: `packages/host/src/roam/replication.ts`.
- Create: `packages/host/src/__tests__/roam-local-acceptance.test.ts`.
- Create: `docs/architecture/roaming.md`.
- Modify: `packages/host/src/extension.ts`.
- Modify: `docs/architecture/README.md`.

**Interfaces:** Consumes `exportBatch(db: Db, request: {after: number; targetBytes: number; batchId: string}, policy: ExportPolicy): Promise<BatchArtifact>`, `validateBatch(artifact: BatchArtifact, expected: {storeKey: StoreKey; senderMachine: MachineId; senderStream: string; now: number}): Promise<ValidatedBatch>`, `applyBatch(db: Db, batch: ValidatedBatch, options: {hubMachine: MachineId; effects: ReplicaEffects; now: number}): ApplyReceipt`, `createReplicaEffects(notify: (key: StoreKey) => void): ReplicaEffects`, and `createExportPolicy(resolve: (path: string, origin: MachineId) => Locator | HistoryRef): ExportPolicy`. Produces `createLocalReplication(options: {notify: (key: StoreKey) => void; resolve: (path: string, origin: MachineId) => Locator | HistoryRef}): {export: (db: Db, request: {after: number; targetBytes: number; batchId: string}) => Promise<BatchArtifact>; apply: (db: Db, batch: ValidatedBatch, input: {hubMachine: MachineId; now: number}) => ApplyReceipt}` with real effects and export policy bound internally. The standalone roaming package consumes db-core directly, never this host wrapper. Do not expose this as a model-callable home mutation.

- [ ] **Step 1: Write the failing test.** `roam-local-acceptance.test.ts` has `A2 through A7 compose across independent roots`, with short parameterized scenarios using real migrations and effects. Assert `expect(replicaState).toEqual(expectedState)`, `expect(foreignOperationalCalls).toEqual([])`, and `expect(foreignCharges).toEqual([])`. Include a foreign first import followed by function-free CLI insert, update, and delete attempts.
- [ ] **Step 2: Run red.** `npm test -- packages/host/src/__tests__/roam-local-acceptance.test.ts`. Expected: composition is absent.
- [ ] **Step 3: Bind the real ports and document the boundary.** Record nonreplicated state, rollout order, schema floor, diagnosed duplicate repair, and disabled defaults. No remote scheduling or hosting starts in phase 1.
- [ ] **Step 4: Run green and the common phase gate.** Expected: A2 through A7 evidence from actual fixtures, no unguarded foreign run consumer, and no new service. Deploy schema and guard-compatible consumers with roaming disabled.
- [ ] **Step 5: Commit.** `git commit -m "feat(roam): gate local replication with guarded consumers"`.

## Phase 2: Transport and hub

### Task 2.1: Add the roaming package, durable operations, and CLI entry

**Track:** Service. Starts only after phase 1 is deployed disabled. Integrate 2.1 before the other tracks start; the same writer returns for 2.5 and 2.6.

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

- [ ] **Step 2: Run red.** `npm test -- packages/roam/src/__tests__/journal.test.ts packages/roam/src/__tests__/cli-package.test.ts`. Expected: package entries are missing.
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

- [ ] **Step 2: Run red.** `npm test -- packages/herdr/src/__tests__/roam-transport.test.ts packages/herdr/src/__tests__/roam-deadlines.test.ts`. Expected: raw byte API absent.
- [ ] **Step 3: Implement byte transport.** Invoke the pinned remote CLI by argv through `hc exec --on`. Raw reads use `cat` through the byte path and raw writes use stdin to `hc file write`. Keep 1 MiB reply checks and the explicit file, control, export, import, and launch deadlines. Resolve the enrolled identity once at transfer start and retain that peer handle. Operations above the 600-second direct maximum use labelled background runs and operation receipts. The terminal returned by `hc run` never means operation completion. Do not add a listener, shell interpolation, SSH path, or JSON binary conversion.
- [ ] **Step 4: Run green.** Repeat the red command and existing cli-transport tests. Expected: byte-for-byte equality and zero local execution after all injected remote failures.
- [ ] **Step 5: Commit.** `git commit -m "feat(herdr): support byte-exact roaming transport"`.

### Task 2.3: Transfer resumable artifacts within hard limits

**Track:** Artifacts. Depends on 2.1. No edits to Herdr or the root CLI file.

**Files:**
- Create: `packages/roam/src/artifacts.ts`.
- Create: `packages/roam/src/staging.ts`.
- Create: `packages/roam/src/agent.ts`.
- Create: `packages/roam/src/__tests__/artifacts.test.ts`.
- Create: `packages/roam/src/__tests__/staging.test.ts`.
- Create: `packages/roam/src/__tests__/agent.test.ts`.

**Interfaces:** Consumes the complete shared `BatchArtifact`, `ApplyReceipt`, `Operation`, `Outcome`, `Transport`, `Peer`, `Limits`, `Journal`, `ArtifactManifest`, and `AgentPorts` contracts. Database calls are `exportBatch(db: Db, request: {after: number; targetBytes: number; batchId: string}, policy: ExportPolicy): Promise<BatchArtifact>`, `validateBatch(artifact: BatchArtifact, expected: {storeKey: StoreKey; senderMachine: MachineId; senderStream: string; now: number}): Promise<ValidatedBatch>`, and `applyBatch(db: Db, batch: ValidatedBatch, options: {hubMachine: MachineId; effects: ReplicaEffects; now: number}): ApplyReceipt`. Produces `stageArtifact(file: string, kind: ArtifactManifest["kind"], limits: Limits): Promise<ArtifactManifest>`; `transferArtifact(peer: Peer, manifest: ArtifactManifest, ports: {transport: Transport; journal: Journal; limits: Limits; root: string}): Promise<Outcome<{file: string}>>`; and `handleAgentOperation(operation: Operation, ports: AgentPorts): Promise<Outcome<JsonObject>>`. Inventory, export, import, cursors, receipts, split, and assemble are dispatched here. Assembly selects only private artifact IDs, never paths supplied by batch records.

- [ ] **Step 1: Write the failing tests.** Name `streams a binary and session artifact above 64 MiB`, `resume reuses verified immutable chunks`, `missing truncated misindexed or corrupt chunks cannot install`, `manifest pages obey byte and digest bounds`, `quota and disk-full retain referenced evidence`, `symlink replacement cannot escape private staging`, and `lost import result reconciles exact receipt`. Assert:

```typescript
expect(installedDigest).toBe(sourceDigest);
expect(largestChunk).toBeLessThanOrEqual(384 * 1024);
expect(largestReply).toBeLessThanOrEqual(1024 * 1024);
expect(resentChunkIndexes).not.toContain(alreadyVerifiedIndex);
expect(cursorAfterCorruption).toBe(cursorBefore);
expect(referencedStagingStillExists).toBe(true);
```

Use deterministic streaming bytes rather than a 65 MiB context string. Separate cases for each corruption and boundary keep tests below five seconds. Include ENOSPC, foreign-owned targets, path traversal, conflicting artifact IDs, transfer expiry, and restart during reconstruction.

- [ ] **Step 2: Run red.** `npm test -- packages/roam/src/__tests__/artifacts.test.ts packages/roam/src/__tests__/staging.test.ts packages/roam/src/__tests__/agent.test.ts`. Expected: no chunk or receipt implementation.
- [ ] **Step 3: Implement immutable chunks and agent operations.** Hash raw 384 KiB chunks and digest-linked manifest pages. Enforce per-kind limits and 4 GiB total staging including reconstruction. Receive by exclusive create into private staging, verify all lengths and hashes, fsync, then atomic rename. Journal arguments before effects and cache results by operation ID. Retry only the same immutable chunk after 1, 2, and 4 seconds. A 30-minute transfer expiry is pending, not failure or fresh import. Keep referenced incomplete staging across restart. Expire only seven-day-old unreferenced staging, and remove committed artifacts only after receipt verification. Quota errors name their directory, never delete workspaces or DB history. Import and export return only committed evidence.
- [ ] **Step 4: Run green.** Repeat the red command. Expected: large streamed artifacts match, all corruption leaves cursors and installed targets unchanged, and resumed calls transfer only missing chunks.
- [ ] **Step 5: Commit.** `git commit -m "feat(roam): transfer resumable digest-bound artifacts"`.

### Task 2.4: Synchronize peers through the hub

**Track:** Hub. Depends on 2.2 and 2.3.

**Files:**
- Create: `packages/roam/src/sync.ts`.
- Create: `packages/roam/src/stores.ts`.
- Create: `packages/roam/src/__tests__/stores.test.ts`.
- Create: `packages/roam/src/peer-state.ts`.
- Create: `packages/roam/src/barriers.ts`.
- Create: `packages/roam/src/__tests__/sync.test.ts`.
- Create: `packages/roam/src/__tests__/barriers.test.ts`.

**Interfaces:** Consumes `Transport`, `RoamConfig`, `Peer`, `Clock`, `Journal`, shared `StoreKey`, `StoreBarrier`, `ApplyReceipt`, and the artifact agent operation interface. Produces `createStorePort(config: RoamConfig, globalDb: Db): StorePort`, consuming `catalogReplica(globalDb: Db, key: StoreKey, replicaDb: Db): void`, the shared database ports, and local mapping tables. Also produces `createSync(ports: {config: RoamConfig; globalDb: Db; transport: Transport; journal: Journal; clock: Clock; stores: StorePort}): SyncService`. `StorePort` has `list(peer: MachineId): readonly StoreKey[]`, `cursor(key: StoreKey, machine: MachineId, stream: string): number`, `accept(key: StoreKey, artifact: BatchArtifact): Promise<ApplyReceipt>`, and `export(key: StoreKey, after: number, targetBytes: number, batchId: string): Promise<BatchArtifact>`. `SyncService` has `start(): void`, `stop(): void`, `sync(peer?: MachineId): Promise<readonly Outcome<ApplyReceipt>[]>`, and `barriers(peer: MachineId, required: readonly StoreBarrier[]): Promise<boolean>`.

- [ ] **Step 1: Write the failing tests.** Name `startup pulls before pushing merged changes`, `one unavailable peer does not stall another`, `one transfer per peer and at most two peers`, `handshake mismatch mutates nothing`, `empty exports allocate no receipt`, `adaptive bytes include lexical apply duration`, and `move barriers wait for every store`. In `stores.test.ts`, name `store adapter catalogs only committed sessions and ignores wire paths` and assert `expect(catalogKeys).toEqual(expectedPortableKeys)` and `expect(openedPaths).not.toContain(foreignPath)`. Assert:

```typescript
expect(order).toEqual(["pull", "apply", "push"]);
expect(maxConcurrentByPeer).toBe(1);
expect(maxConcurrentPeers).toBe(2);
expect(retryDelays).toEqual([30_000, 60_000, 120_000, 120_000]);
expect(await sync.barriers(peerId, required)).toBe(false);
```

Include a core restart during a lost response, same enrolled machine with a changed core, count-zero batch, byte-singleton rows, and a quarantined store alongside a healthy store. Record export and import durations on small actual SQLite fixtures for A1, without treating failed calls as timing samples.

- [ ] **Step 2: Run red.** `npm test -- packages/roam/src/__tests__/sync.test.ts packages/roam/src/__tests__/barriers.test.ts packages/roam/src/__tests__/stores.test.ts`. Expected: sync exports missing.
- [ ] **Step 3: Implement sync and barrier reconciliation.** Bind StorePort to real db-core codecs, apply effects, local map resolution, and idempotent catalog registration. Register after committed apply and reconcile registration after restart; never acknowledge an uncommitted cursor. Handshake protocol 1, schema 14, enrolled machine, and current core before mutation. The hub pulls then pushes, retaining original envelopes. Boxes receive global memory, mapped repo memory, and worktree stores they host or prepare to host. Hub keeps all participating stores, including unmapped stores. On first sync assign an unassigned session home at epoch 1 only when all observed origins agree; conflicting origins block admission and report claim. Schedule first sync at startup, then every two minutes per peer. Retry disconnected peers independently. Adjust the 4 MiB target using committed apply duration including lexical work, never a record cap or transaction deadline. Singleton large rows must fit the 16 MiB whole-batch limit. Reconcile receipts after uncertain commands, and never replace them with a new operation.
- [ ] **Step 4: Run green.** Repeat the red command. Expected: independent progress, committed cursor barriers, bounded concurrency, and idle log sizes unchanged.
- [ ] **Step 5: Commit.** `git commit -m "feat(roam): synchronize enrolled peers through the hub"`.

### Task 2.5: Run the hub independently of pi and reconcile placement

**Track:** Service. Depends on 2.4.

**Files:**
- Create: `packages/roam/src/hub.ts`.
- Create: `packages/roam/src/launchd.ts`.
- Create: `packages/roam/src/control-socket.ts`.
- Create: `packages/roam/src/diagnostics.ts`.
- Create: `packages/roam/src/__tests__/hub.test.ts`.
- Create: `packages/roam/src/__tests__/launchd.test.ts`.
- Create: `packages/roam/src/__tests__/diagnostics.test.ts`.
- Create: `packages/herdr/src/roam-placement.ts`.
- Create: `packages/herdr/src/__tests__/roam-placement.test.ts`.
- Modify: `packages/roam/src/cli.ts`.

**Interfaces:** Consumes shared `SyncService` and `HubPorts`, `RoamConfig`, `Clock`, `Home`, `Readiness`, `Journal`, and `Outcome`. Produces `runHub(ports: HubPorts): Promise<{stop(): Promise<void>}>`; `installHubService(input: {node: string; cli: string; globalRoot: string}): Promise<void>`; `doctorLocal(config: RoamConfig): Promise<readonly Diagnostic[]>`; and `PlacementPort.reconcile(rows: readonly Readiness[]): Promise<{pending: readonly string[]}>`. Generic Herdr `createRoamPlacement(options: {app: AppClient | null; hc: HcClient; registry: TerminalRegistry}): PlacementPort` implements the structural port using existing Herdr types. It imports neither pi nor the roaming package. Local hub controls use the private socket. CLI outcome shape remains the shared `Outcome`.

- [ ] **Step 1: Write the failing tests.** Name `second hub refuses the process lock`, `enable writes resolved absolute executable paths`, `broken Node path is diagnosed and enable repairs plist`, `closed app and core never auto-start`, `placement reconciles each new terminal once`, `unreachable home notifies once and clears on recovery`, and `disable refuses an in-progress home change`. Add `doctor reports late local writer epoch and never repairs memory` with `expect(diagnostic.writerEpoch).toBe(lateEpoch)` and `expect(memoryAfterDoctor).toEqual(memoryBeforeDoctor)`. Assert:

```typescript
expect(secondHub).rejects.toThrow(/lock/);
expect(plist).toMatchObject({RunAtLoad: true, KeepAlive: true});
expect(startAppOrCoreCalls).toEqual([]);
expect(placements).toEqual([newTerminal]);
expect(noticesAfterTenMinutes).toHaveLength(1);
expect(statusAfterRecovery.warning).toBeNull();
```

Fake time for ten-minute notices and two-minute sync. Pending notices survive hub restart and app closure. Status distinguishes cached state from current observations.

- [ ] **Step 2: Run red.** `npm test -- packages/roam/src/__tests__/hub.test.ts packages/roam/src/__tests__/launchd.test.ts packages/roam/src/__tests__/diagnostics.test.ts packages/herdr/src/__tests__/roam-placement.test.ts`. Expected: absent service or unwanted app call.
- [ ] **Step 3: Implement hub service and diagnostics.** Install a launchd user plist with resolved Node and CLI paths, private logs, process lock, RunAtLoad, and KeepAlive. Do not rely on a shell version manager. Enable rewrites paths after a supported Node upgrade. Sync never opens pi or starts an app or core. Closed Mac core prevents box transport. Closed app only defers placement. Reconcile reported live terminals after each sync, including IDs after restart, without launching pi for placement. Persist one unreachable-home or suspension status and clear it on recovery. Status includes homes, cursors, backlog, log sizes, suspensions, warnings, incomplete operations, and observation age. Doctor is read-only and names repair commands. Report a locally originated session write after its freeze barrier with `writer_epoch`, without apply-time authorization. Enable lists likely machine-specific memory without rewriting or retagging it.
- [ ] **Step 4: Run green.** Repeat the red command. Expected: one hub, no app or core auto-start, and durable pending placement resolves once.
- [ ] **Step 5: Commit.** `git commit -m "feat(roam): run a locked standalone Mac hub"`.

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

**Interfaces:** Consumes `main(argv: readonly string[], io: {out(text: string): void; err(text: string): void}): Promise<number>`, `handleAgentOperation(operation: Operation, ports: AgentPorts): Promise<Outcome<JsonObject>>`, `runHub(ports: HubPorts): Promise<{stop(): Promise<void>}>`, `createStorePort(config: RoamConfig, globalDb: Db): StorePort`, `doctorLocal(config: RoamConfig): Promise<readonly Diagnostic[]>`, and existing acceptance `ScenarioDefinition`, `storyId(value: string)`, and `Suite`. Produces named `scenarios` arrays with IDs `R01` for independent-core sync and `R02` for closed-app placement. Register those IDs in discovery, selection, and result matrices. CI reports active-core stories as not exercised rather than passed.

- [ ] **Step 1: Write the failing tests.** Name `installed spider help is side-effect free`, `Mac link installs the actual shell executable`, `A8 chunk transport composes with durable apply`, and `A9 hub survives without pi`. Assert `expect(cliExit).toBe(0)`, `expect(shellResolvedEntry).toBe(packedCliEntry)`, `expect(receivedDigest).toBe(sentDigest)`, and `expect(cursorAfterRestart).toBe(committedThrough)`. Each new isolated story has one short observable operation and a five-second test ceiling. Large real transport timing is deferred to 4.7.
- [ ] **Step 2: Run red.** `npm test -- packages/host/src/__tests__/roam-cli-installed.test.ts packages/roam/src/__tests__/transport-acceptance.test.ts`. Expected: shell installation or assembled path is absent.
- [ ] **Step 3: Wire only implemented commands.** Install the shell command as part of the Mac link path, not just through `npm run build`. Construct SyncService with the real StorePort and transport, then wire enable, disable, sync, status, doctor, repo map, and memory tag through the hub socket or allowed local path. Box-only disallowed controls point to the Mac. Document code 0 completion, 1 refusal, 2 invalid args, and 3 durable pending. Add internal agent dispatch and receipt inspection. Do not expose home mutation through the spider model tool.
- [ ] **Step 4: Run green and the common phase gate.** Also run `node dist/roam/cli.mjs roam status --json` under a fixture root and `npm run test:herdr:e2e -- --built --story R01,R02`. Expected: packaged CLI works with pi closed, A8 and A9 pass through fake hc and owned isolated cores, and cleanup proofs are complete. Deploy disabled.
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

- [ ] **Step 2: Run red.** `npm test -- packages/host/src/__tests__/herdr-core-only.test.ts packages/herdr/src/__tests__/core-only.test.ts packages/herdr/src/__tests__/config.test.ts`. Expected: existing full config requires app data.
- [ ] **Step 3: Implement explicit mode branching.** Full mode preserves existing setup and app behavior. Core-only omits app construction, app mods, layout, and absent-app warnings, not core monitoring. Keep remote destination validation before execution. No roaming runtime import in Herdr.
- [ ] **Step 4: Run green.** Repeat the red command and existing Herdr mount tests. Expected: core-only starts with no app configuration and full-mode regressions remain green.
- [ ] **Step 5: Commit.** `git commit -m "feat(herdr): support explicit core-only hosting"`.

### Task 3.2: Provision selected files with explicit auth consent

**Track:** Install. Starts after phase 2 is deployed disabled.

**Files:**
- Create: `packages/roam/src/provision.ts`.
- Create: `packages/roam/src/selected-files.ts`.
- Create: `packages/roam/src/resource-doctor.ts`.
- Create: `packages/roam/src/auth.ts`.
- Create: `packages/roam/src/systemd.ts`.
- Create: `packages/roam/src/__tests__/provision.test.ts`.
- Create: `packages/roam/src/__tests__/selected-files.test.ts`.
- Create: `packages/roam/src/__tests__/resource-doctor.test.ts`.
- Create: `packages/roam/src/__tests__/systemd.test.ts`.

**Interfaces:** Consumes `Peer`, `Transport`, `Limits`, `Journal`, `Operation`, and `Outcome`. Produces `inventory(peer: Peer, transport: Transport): Promise<Inventory>`; `provision(input: ProvisionRequest, ports: ProvisionPorts): Promise<Outcome<{hostingReady: boolean}>>`; and `doctorPeer(peer: Peer, ports: ProvisionPorts): Promise<readonly Diagnostic[]>`. Define `Inventory = {platform: string; nodeVersion: string; gitVersion: string; systemdUser: boolean; core: string; softNofile: number; hardNofile: number; inotifyInstances: number; inotifyWatches: number}`; `Diagnostic = {reason: string; severity: "warning" | "block"; repairCommand: string | null}`; `ProvisionRequest = {operation: Operation; peer: Peer; selected: readonly string[]; includeAuth: boolean; confirmedProviders: readonly string[]}`. `ProvisionPorts` has `transport: Transport`, `journal: Journal`, `limits: Limits`, `confirm(target: string, providers: readonly string[]): Promise<boolean>`, and `release: {pi: "1.2.0"; intercom: "0.13.0"; spiderSha256: string; nodeRange: "22.23.4 || 26.4.0"}`. Test both allowed versions at release acceptance, rejecting other versions until the tested range is deliberately updated. Selected paths are resolved from an allowlist, not arbitrary archive entries.

- [ ] **Step 1: Write the failing tests.** Name `inventory refuses missing prerequisites without sudo`, `selected settings are rewritten for box paths`, `credential-bearing settings require target consent`, `without auth install succeeds but hosting remains disabled`, `secret commands are never executed`, `reprovision backs up once and creates one unit`, `core unit bytes and terminals remain unchanged`, and `doctor reports low resources and missing CLI auth`. Assert:

```typescript
expect(secretCollectionCalls).toEqual([]);
expect(hostingReadyWithoutSignin).toBe(false);
expect(authArtifactMode).toBe(0o600);
expect(secretStagingAfterInstall).toBe(false);
expect(coreUnitAfter).toBe(coreUnitBefore);
expect(installedUnitCount).toBe(1);
```

Check mode and ownership failures, extension and prompt explicit selection, supporting skill files, unsupported credential commands, Mac-absolute path refusal with affected filenames, and interrupted install retry. An auth rejection transfers zero auth bytes and secrets never appear in argv, labels, or logs. Test inotify floors 1024 and 524288, file-limit floor 65536, and `gh auth status` plus Git identity warnings.

- [ ] **Step 2: Run red.** `npm test -- packages/roam/src/__tests__/provision.test.ts packages/roam/src/__tests__/selected-files.test.ts packages/roam/src/__tests__/resource-doctor.test.ts packages/roam/src/__tests__/systemd.test.ts`. Expected: installer absent.
- [ ] **Step 3: Implement provisioning and read-only doctor.** Show inventory and chosen destinations first. Require Linux, Git, systemd user services, an existing hc core, Node >=22.19.0, and a Node version in the pinned tested range. Install the pinned releases under a home npm prefix with Linux-native SQLite modules. Set `SPIDER_GLOBAL_ROOT` for installation as well as pi. Use destination credentials for Git and CLIs. Copy selected allowlisted settings, models, keys, themes, AGENTS.md, and skill support files. Require explicit selection for extensions, prompts, MCP, and system-prompt files. Exclude trust, sessions, broker state, and caches. Back up overwritten selected files once and replace only those files on rerun. Warn that hand-edited selected files may need re-editing.

Auth is separate private artifact data and requires explicit confirmation per target and provider. Never collect secret-command output. Delete secret staging after installation. Doctor probes native modules, extension load, exact-session launch, modes, core ownership, configured CLIs, and authentication. Missing pi auth blocks hosting. Missing tool auth warns. Install only the supervisor unit under `default.target`, with `After=`, `Requires=`, and `PartOf=` pointing to the existing core, `Restart=on-failure`, and private umask. Never edit or restart the core or add reverse dependencies. Report administrative lingering, hard-limit, or inotify repairs without applying them. Warn that a required core restart kills terminals.
- [ ] **Step 4: Run green.** Repeat the red command. Expected: idempotent selected-file install, no duplicated agent or service, no core change, and no hosting without authentication.
- [ ] **Step 5: Commit.** `git commit -m "feat(roam): provision pinned box hosting with auth consent"`.

### Task 3.3: Supervise one exact-file owner through restarts

**Track:** Hosting. Depends on 3.1 and 3.2.

**Files:**
- Create: `packages/roam/src/supervisor.ts`.
- Create: `packages/roam/src/intent.ts`.
- Create: `packages/roam/src/launcher.ts`.
- Create: `packages/roam/src/__tests__/supervisor.test.ts`.
- Create: `packages/roam/src/__tests__/launcher.test.ts`.
- Create: `packages/herdr/src/__tests__/roam-exact-launch.test.ts`.
- Modify: `packages/roam/src/supervisor-main.ts`.
- Modify: `packages/herdr/src/sessions/lease.ts`.
- Modify: `packages/herdr/src/sessions/launcher.ts`.
- Modify: `packages/herdr/src/sessions/presence.ts`.

**Interfaces:** Consumes shared `Home`, `SessionState`, `ProcessIdentity`, `Probe`, `Readiness`, `Clock`, `Journal`, and `Diagnostic`. Consumes shared `HostIntent`. Produces `SupervisorPorts = {clock: Clock; journal: Journal; inspect(sessionId: string): Promise<{home: Home; states: readonly SessionState[]; unfinishedFreeze: boolean; intent: HostIntent; owner: Probe; diagnostics: readonly Diagnostic[]}>; launch(intent: HostIntent): Promise<Outcome<Readiness>>; stop(sessionId: string): Promise<Probe>; notify(sessionId: string, reason: string): Promise<void>}`; and `createSupervisor(ports: SupervisorPorts): {reconcile(): Promise<void>; start(): void; stop(): Promise<void>}`. Add generic Herdr `launchExactSession(request: {sessionId: string; file: string; cwd: string; sha256: string; epoch: number; moveId: string | null}, ports: SessionLaunchPorts): Promise<SessionLaunchResult>` alongside the existing launcher, using its public lease interfaces. Adapt roaming `bootId`, `pid`, and `startTime` to Herdr's existing `pid` and `startIdentity`, rather than confusing the two ProcessIdentity types.

- [ ] **Step 1: Write the failing tests.** Name `launch requires local home and active state in every store`, `unfinished freeze and uncertain owner suspend`, `boot ID or start time defeats PID reuse`, `crash backoff suspends at five in ten minutes`, `ten stable minutes clear failures`, `deliberate stop survives restart`, `reload preserves one terminal`, and `empty missing or replaced exact file never launches`. Assert:

```typescript
expect(launches).toHaveLength(1);
expect(restartDelays).toEqual([5_000, 15_000, 60_000, 300_000]);
expect(intentAfterFifthFailure.suspended).not.toBeNull();
expect(piArgv).toEqual(["pi", "--session", exactFile]);
expect(softLimitAfter).toBe(Math.max(softLimitBefore, 65_536));
```

Parameterize hard-limit bounds separately: never lower a higher soft limit and never exceed the inherited hard limit. Exercise lost spawn replies, stale leases, private runtime permissions, and source HC values that must not enter the destination environment. Fake time for all restart intervals.

- [ ] **Step 2: Run red.** `npm test -- packages/roam/src/__tests__/supervisor.test.ts packages/roam/src/__tests__/launcher.test.ts packages/herdr/src/__tests__/roam-exact-launch.test.ts`. Expected: no durable supervision or full manifest validation.
- [ ] **Step 3: Implement supervision and leased launch.** Reconcile at startup, on core and home events, and every ten seconds. Require active state in every affected store, no unfinished freeze, current local home and epoch, running intent, valid file, mapped cwd, auth, release, and both local locks. Ownership absence requires Linux boot ID, PID, and start-time proof. Missing auth, invalid file, or uncertainty suspends immediately. Five failures in ten minutes suspend and notify; ten stable minutes clear counts. Stop and user quit persist stopped intent. Resume requires doctor.

Launch a fresh local-core terminal with background lifetime, no notification, and no parent dependency. Raise soft nofile toward at least 65536 without lowering or exceeding hard limit. Inherit only destination-core HC values. Labels contain session, machine, epoch, and move ID. Verify a nonempty regular file and manifest immediately before invoking exact `pi --session`. Reuse existing file leases and session-ID locks, never bypass them with bookkeeping mode. Readiness is an admission receipt, not a shell or heartbeat. A lost launch response stays pending and reconciles ownership rather than spawning twice.
- [ ] **Step 4: Run green.** Repeat the red command and existing lease and launcher tests. Expected: exactly one owner, durable stopped and suspended states, and no restart on reload.
- [ ] **Step 5: Commit.** `git commit -m "feat(roam): supervise exact-session owners with durable intent"`.

### Task 3.4: Persist readiness and admit new box sessions

**Track:** Host. Depends on 3.3.

**Files:**
- Create: `packages/host/src/roam/readiness.ts`.
- Create: `packages/host/src/roam/participants.ts`.
- Create: `packages/host/src/roam/__tests__/roam-readiness.test.ts`.
- Create: `packages/host/src/__tests__/herdr-roam-hosting.test.ts`.
- Modify: `packages/host/src/extension.ts`.
- Modify: `packages/host/src/roam/admission.ts`.
- Modify: `packages/host/src/roam/activation.ts`.
- Modify: `packages/roam/src/agent.ts`.
- Modify: `packages/roam/src/cli.ts`.

**Interfaces:** Consumes `registerAdmission(pi: ExtensionAPI, ports: AdmissionPorts): AdmissionGate`, with the complete shared host declarations, `HostIntent`, `Journal`, `Readiness`, `Home`, and `seedSession(db: Db, sessionId: string, epoch: number, limit: number): {complete: boolean; through: number}`. Produces `persistReadiness(journal: Journal, ready: Readiness): void` and `startParticipant(operation: Operation, home: Home, intent: HostIntent): Promise<Outcome<Readiness>>`. `startParticipant` verifies the hub caller and expected epoch, records active state and running intent before supervision, then reconciles durable readiness. New-session admission initializes origin, membership, and resumable seed before ordinary consumers. Home epoch 1 is assigned at first hub sync; matching initial origin permits the original new box process before that sync.

- [ ] **Step 1: Write the failing tests.** Name `readiness commits before ordinary consumers`, `lost readiness reply returns the persisted owner`, `new box admission seeds before startup work`, `core restart recreates one exact-file owner`, `trigger fires once with hub absent`, and `reconnect reports new terminal for placement`. Assert:

```typescript
expect(order.indexOf("ready-durable")).toBeLessThan(order.indexOf("ordinary-consumer"));
expect(replayedReadiness).toEqual(firstReadiness);
expect(homeAfterFirstSync).toMatchObject({epoch: 1, machineId: boxId});
expect(triggerDeliveries).toHaveLength(1);
expect(activeOwners).toHaveLength(1);
```

Use independent roots and fake clocks for scheduler recovery. Conflicting initial origins block admission until an explicit claim. No hub availability is required to continue an already active home.

- [ ] **Step 2: Run red.** `npm test -- packages/host/src/roam/__tests__/roam-readiness.test.ts packages/host/src/__tests__/herdr-roam-hosting.test.ts`. Expected: missing durable admission receipt.
- [ ] **Step 3: Wire participants, supervision, and box controls.** Persist readiness with operation ID, actual session ID, epoch, cwd, file, core, and terminal after admission checks and before setting ordinary activation. Persist new box origin and membership first. Internal `session start` is a hub-issued expected-epoch operation, not a general model action. Wire provision, doctor, stop, and resume through their implemented ports. Stop changes desired state without changing home. Failed doctor prevents resume. Core-only pi registration remains guarded and works without app config.
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

- [ ] **Step 1: Write the failing tests.** `hosting-acceptance.test.ts` has `A10 provision never changes existing core`, `A11 deliberate stop is durable`, and `missing sign-in blocks hosting not installation`. Stories load the packed extension inside an owned core-spawned pi terminal with no app config. Assert `expect(extensionLoaded).toBe(true)`, `expect(coreUnitDigestAfter).toBe(coreUnitDigestBefore)`, and `expect(ownersAfterRestart).toHaveLength(1)`. Keep each new story to one bounded operation under five seconds. Real installation and long no-client survival are maintainer steps in 4.7, not sleeping tests.
- [ ] **Step 2: Run red.** `npm test -- packages/roam/src/__tests__/hosting-acceptance.test.ts`. Expected: assembled hosting acceptance fails before wiring is complete.
- [ ] **Step 3: Add composed stories and operator instructions.** Explain auth consent, missing tool warnings, stop and doctor-before-resume, resource repairs, and deferred upgrade and uninstall orchestration. Document that a Windows reboot requires desktop sign-in before the existing WSL task can run. Supervisor recovery cannot power on a machine or sign in its host.
- [ ] **Step 4: Run green and the common phase gate.** Also run `npm run test:herdr:e2e -- --built --story R03,R04,R05`. Expected: A10 and A11 pass under isolated roots, and A1's core-only extension load is observed inside a real core-spawned terminal. Deploy disabled. Synthetic opt-in hosting may be used for phase 4 acceptance only.
- [ ] **Step 5: Commit.** `git commit -m "test(roam): gate core-only hosting and restart recovery"`.

## Phase 4: Moves and real-box acceptance

### Task 4.1: Snapshot and restore Git workspaces without changing staging

**Track:** Git. Starts after phase 3 is deployed disabled. Can run with Files and Control.

**Files:**
- Create: `packages/roam/src/workspace.ts`.
- Create: `packages/roam/src/workspace-import.ts`.
- Create: `packages/roam/src/git-bundle.ts`.
- Create: `packages/roam/src/__tests__/workspace.test.ts`.
- Create: `packages/roam/src/__tests__/workspace-import.test.ts`.
- Create: `packages/roam/src/__tests__/git-bundle.test.ts`.

**Interfaces:** Consumes `WorkspaceSnapshot`, `PreparedWorkspace`, `Journal`, `Limits`, `Blocker`, and `Outcome` from shared contracts. Produces `snapshotWorkspace(input: {root: string; cwd: string; repoKey: string; workspaceId: string; moveId: string; stage: "pre" | "final"; writers: readonly Blocker[]}, ports: GitPorts): Promise<WorkspaceSnapshot>`; `prepareWorkspace(snapshot: WorkspaceSnapshot, destination: string, ports: GitPorts): Promise<PreparedWorkspace>`; `verifyWorkspace(prepared: PreparedWorkspace, ports: GitPorts): Promise<void>`; and `abortWorkspace(prepared: PreparedWorkspace, ports: GitPorts): Promise<void>`. `GitPorts` has `run(cwd: string, argv: readonly string[], options?: {env?: Readonly<NodeJS.ProcessEnv>; stdin?: Buffer}): Promise<Buffer>`, `journal: Journal`, `limits: Limits`, `scratch: string`, and `worktreeCommand: readonly string[] | null`. Creation tools receive the same validated no-checkout arguments and cannot bypass verification.

- [ ] **Step 1: Write the failing tests.** `workspace.test.ts` has `snapshot preserves real index content and untracked bytes`, `captures staged-only binary deletion rename and mode changes`, and `refuses unsupported states without changing source`. `workspace-import.test.ts` has `round trip reuses the mapped checkout`, `diverged mapped checkout refuses with a diff summary`, `sparse cone and alternate-backed creation installs config before checkout`, `custom worktree command preserves no-checkout order`, and `branch conflict remains detached`. `git-bundle.test.ts` has `bundle requires verified shared prerequisites`, `prestage plus final delta enforce total cap`, and `abort restores only its unchanged prepared trees`. Assert:

```typescript
expect(destinationHead).toBe(snapshot.head);
expect(destinationIndexTree).toBe(snapshot.indexTree);
expect(destinationWorkingTree).toBe(snapshot.workingTree);
expect(sourceIndexTreeAfter).toBe(sourceIndexTreeBefore);
expect(returnedRoot).toBe(previousMappedRoot);
expect(unrelatedRootDigestAfter).toBe(unrelatedRootDigestBefore);
expect(fullHistoryFallbackCalls).toBe(0);
```

Use a disposable bare origin and two independent common repositories. Reuse the proven synthetic sequence: an unpushed commit, different staged and working binary bytes, a staged-only change reverted in working files, deletion, rename, exec bit, untracked file, and ignored output. Include merge and rebase, unresolved index, submodules, escaping symlinks, case-fold collisions, unsupported file types, LFS pointer-only content, missing LFS object, non-round-tripping filter, known workspace writer, and tracked local state. Separate short fixture cases rather than one oversized matrix.

- [ ] **Step 2: Run red.** `npm test -- packages/roam/src/__tests__/workspace.test.ts packages/roam/src/__tests__/workspace-import.test.ts packages/roam/src/__tests__/git-bundle.test.ts`. Expected: snapshot interfaces missing.
- [ ] **Step 3: Implement Git-native snapshots and import.** Obtain the actual index path with `git rev-parse --git-path index`. Record `git write-tree`, copy the index privately, and run `git add -A` under `GIT_INDEX_FILE`, explicitly excluding `.spider` and `.pi-subagents`. Refuse tracked local state. Create index and working commits parented on HEAD and index respectively. Use immutable refs `refs/spider-roam/<move-id>/<stage>/index` and `/working`, never force-update or push them. Use fixed private metadata `Spider roaming snapshot <roam@example.invalid>` and `2000-01-01T00:00:00Z`, not user Git configuration.

Record HEAD, branch, object format, both trees, relative cwd, sparse patterns, and per-worktree config. Destination fetches origin with its own credentials and advertises verified commits. Bundle only snapshot refs excluding a verified shared merge base and pre-stage prerequisites. Missing prerequisites or combined bundles above 256 MiB refuse with setup instructions, never full history. A mapped checkout must equal its last exported HEAD, index, and working trees. Journal prepared trees so retries recognize their own modifications.

For reuse, initialize a private index from the last working tree, refresh its stat cache, and use `git read-tree -m -u` to apply the incoming working tree. For creation use `git worktree add --detach --no-checkout`, enable per-worktree config, copy sparse patterns and config, then checkout during pre-stage. A configured argv tool replaces creation, not the no-checkout checks. Set the real index with `git read-tree <index-tree>` without updating working files. Restore HEAD without checkout or reset. Restore the symbolic branch only if its ref matches or can be created without changing another worktree. Otherwise report the saved branch and remain detached. Compare destination trees and source final trees before home commit. Retain source files and mark their checkout not home. Never build a full byte manifest of the workspace.
- [ ] **Step 4: Run green.** Repeat the red command. Expected: exact HEAD and tree equality, retained partial staging, safe reuse and sparse creation, and unchanged unrelated roots.
- [ ] **Step 5: Commit.** `git commit -m "feat(roam): transfer Git workspace snapshots and final deltas"`.

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

- [ ] **Step 2: Run red.** `npm test -- packages/roam/src/__tests__/session-file.test.ts packages/roam/src/__tests__/session-sdk.test.ts packages/roam/src/__tests__/mirrors.test.ts`. Expected: missing validated file transformation.
- [ ] **Step 3: Implement streaming validation and installation.** Require complete newline-terminated v3 JSONL, expected ID, unique entry IDs, valid parent links, and compaction boundaries. Source upgrades old formats normally before freezing. Pre-stage immutable complete prefix chunks, then reuse their hashes in the final artifact and send only the remainder. Any changed source prefix aborts before home commit. Verify assembled source digest. Preserve every post-header byte. Rewrite only `header.cwd` and mapped `parentSession`; otherwise remove the stale parent locator and put its origin reference in marker data. Append a fresh custom `spider-roam-segment` entry parented on the captured leaf with exact shared `Segment` data and null parentRef when absent. First marker retains previous machine as history machine, later markers retain that initial value. Never rewrite historical message paths.

Validate destination digest, unchanged history, header, marker, and cwd. Install by same-directory atomic rename after file and directory fsync. A prior same-ID target needs proved dormant ownership, compatible history prefix, and a private backup. Verify frozen source size and digest again immediately before commit. Discard retired-source appends after commit. Mirrors are read-only append-only files keyed by session and home epoch, start from that epoch's installed file, and accept only a matching prefix and complete lines. They make remote conversation readable without moving its home.
- [ ] **Step 4: Run green.** Repeat the red command. Expected: actual pi opens the intended branch and mapped cwd, history bytes match, and bad targets remain untouched.
- [ ] **Step 5: Commit.** `git commit -m "feat(roam): preserve session leaves and mirror home history"`.

### Task 4.3: Freeze live or dormant participants through guarded control

**Track:** Control. Starts after phase 3 is deployed disabled.

**Files:**
- Create: `packages/host/src/roam/control.ts`.
- Create: `packages/host/src/roam/freeze.ts`.
- Create: `packages/host/src/roam/blockers.ts`.
- Create: `packages/host/src/roam/__tests__/roam-control.test.ts`.
- Create: `packages/host/src/roam/__tests__/roam-freeze.test.ts`.
- Create: `packages/host/src/roam/__tests__/roam-blockers.test.ts`.
- Create: `packages/roam/src/session-control.ts`.
- Create: `packages/roam/src/__tests__/session-control.test.ts`.
- Modify: `packages/host/src/roam/admission.ts`.
- Modify: `packages/host/src/roam/activation.ts`.
- Modify: `packages/host/src/roam/readiness.ts`.
- Modify: `packages/host/src/loop/index.ts`.
- Modify: `packages/host/src/organism-runtime.ts`.

**Interfaces:** Consumes shared `FreezeAck`, `ProcessIdentity`, `Probe`, `Blocker`, `Home`, `SessionState`, `Readiness`, `Journal`, and `Operation`. Consumes `listSessionBlockers(db: Db, sessionId: string): readonly Blocker[]` and `AdmissionGate` with `inspect`, `close`, `freeze`, and `unfreeze` signatures from 1.9. Produces `serveSessionControl(input: {sessionId: string; runtimeRoot: string; ports: FreezePorts}): Promise<{close(): Promise<void>}>`; `inspectBlockers(ctx: ExtensionContext, stores: readonly Db[]): Promise<readonly Blocker[]>`; `freezeParticipant(operation: Operation, ports: FreezePorts): Promise<FreezeAck>`; and `controlSession(operation: Operation, ports: SessionControlPorts): Promise<Outcome<JsonObject>>`. `FreezePorts` has `gate: AdmissionGate`, `journal: Journal`, `stores: readonly Db[]`, `drain(): Promise<void>`, `inspect(): Promise<{blockers: readonly Blocker[]; file: string; cwd: string; leaf: string; owner: ProcessIdentity | null}>`, and `ingestThrough(file: string, size: number): Promise<void>`. `SessionControlPorts` has `journal: Journal`, `probe(sessionId: string): Promise<Probe>`, `withBothLocks<T>(sessionId: string, fn: () => Promise<T>): Promise<T>`, `live(operation: Operation): Promise<Outcome<JsonObject>>`, and `dormant(operation: Operation): Promise<Outcome<JsonObject>>`.

- [ ] **Step 1: Write the failing tests.** Name `returns exact blockers without stopping work`, `freeze stops all producers before durable acknowledgement`, `partial multi-store freeze reconciles before unfreeze`, `control accepts only four verbs and matching operation epoch`, `live retire waits for proved process exit`, `dormant freeze holds both locks and uses physical leaf`, `uncertain ownership blocks dormant control`, and `cancelled move can never reactivate later`. Assert:

```typescript
expect(blockerIds).toEqual(expectedIds);
expect(cancelledWork).toEqual([]);
expect(order).toEqual(["close-gates", "drain", "recheck", "freeze-all", "ack"]);
expect(ack.barriers).toHaveLength(affectedStores.length);
expect(ordinaryWritesAfterAck).toBe(0);
expect(retiredBeforeExitProof).toBe(false);
```

Parameterize requests, retry, compaction, queued prompts, editor draft, direct shell, pending asks, queued or paused child, detached durable child, pipeline, local jobs, unsettled remote receipts, and unobserved completions. Inspect the owning run DB, local routes, and both top-level and child job journals. Check timer delivery, notices, cache warming, organism reports, and shutdown consolidation remain suppressed across reload. Invalid control requests mutate nothing.

- [ ] **Step 2: Run red.** `npm test -- packages/host/src/roam/__tests__/roam-control.test.ts packages/host/src/roam/__tests__/roam-freeze.test.ts packages/host/src/roam/__tests__/roam-blockers.test.ts packages/roam/src/__tests__/session-control.test.ts`. Expected: no durable freeze or dormant path.
- [ ] **Step 3: Implement guarded control and freeze.** Export the socket service and participant handlers without editing host registration or agent dispatch. Product owns that wiring in 4.6. Admission owns a mode-0600 socket in a 0700 runtime directory keyed by session-ID hash. Bound and validate frames before dispatch. Use a short private runtime root and the first 32 hex characters of SHA-256(session ID) as the directory key; reject a socket path beyond the platform limit before bind rather than falling back to TCP. The socket accepts only inspect, freeze, unfreeze, and shutdown with expected epoch and move ID. Session CLI routes to the live lease owner. Live retirement shuts down first and persists retirement only after proved exit. Proved dormancy acquires both ID and canonical-file locks, journals before changing state, and performs direct freeze, unfreeze, inspection, or retirement. Unknown ownership blocks.

Close all admission gates, stop spider-owned transcript producers, drain writers, recheck idle blockers, and persist frozen state in every affected store. Journal cross-store progress and acknowledge only when all stores are frozen. Record owner identity or proved dormancy, runtime cwd, live leaf or physical dormant leaf, transcript size and digest, and high sequence per store. Ingest usage through that source end. A partial failure remains frozen or control-only until its journal reconciles. Abort records cancellation before active state and gates reopen; stale move IDs cannot overwrite later state. Freeze never expires.
- [ ] **Step 4: Run green.** Repeat the red command and admission and scheduler suites. Expected: exact blockers, no forced cancellation, and durable multi-store freeze across restart.
- [ ] **Step 5: Commit.** `git commit -m "feat(host): control and freeze live or dormant roaming sessions"`.

### Task 4.4: Move homes with durable barriers and safe rollback

**Track:** Moves. Depends on 4.1, 4.2, and 4.3.

**Files:**
- Create: `packages/roam/src/move.ts`.
- Create: `packages/roam/src/homes.ts`.
- Create: `packages/roam/src/move-recovery.ts`.
- Create: `packages/roam/src/power.ts`.
- Create: `packages/roam/src/__tests__/move.test.ts`.
- Create: `packages/roam/src/__tests__/move-faults.test.ts`.
- Create: `packages/roam/src/__tests__/homes.test.ts`.

**Interfaces:** Consumes shared `MoveRequest`, `MoveResult`, `MovePorts`, `FreezeAck`, `WorkspaceSnapshot`, `PreparedWorkspace`, `SessionManifest`, `Home`, `Readiness`, `StoreBarrier`, `Outcome`, and `Journal`. Produces `moveSession(request: MoveRequest, ports: MovePorts): Promise<Outcome<MoveResult>>`; `recoverMove(moveId: string, ports: MovePorts): Promise<Outcome<MoveResult>>`; `cancelMove(moveId: string, ports: MovePorts): Promise<Outcome<MoveResult>>`; and `casHome(db: Db, expected: Home, nextMachine: MachineId, moveId: string, hubMachine: MachineId): Home`. `casHome` and its local action receipt share one global DB transaction. It rejects a cancelled commit action. Each transition records its durable result before a caller sees success.

- [ ] **Step 1: Write the failing tests.** `homes.test.ts` has `CAS increments every forward and rollback epoch`, `equal epoch cannot change owner or move ID`, and `cancelled action cannot commit later`. `move.test.ts` has `same-home request is a verified no-op`, `second destination conflicts per session`, `seeds and prestages before freeze`, `power assertion spans recovery`, `requires every store barrier`, and `source cleanup uses proved terminal removal`. Assert:

```typescript
expect(states).toEqual(["checked", "frozen", "transferred", "home-committed", "destination-ready", "source-stopped", "done"]);
expect(homeAfterMove.epoch).toBe(sourceHome.epoch + 1);
expect(homeAfterRollback.epoch).toBe(sourceHome.epoch + 2);
expect(ownersAtEveryObservation.every(n => n <= 1)).toBe(true);
expect(registryRemovals).toEqual([{id: sourceTerminal, provedRemoved: true}]);
```

`move-faults.test.ts` parameterizes `restart after action and before reply at <state>` across every transition, each store freeze and barrier, file install, home commit, start, readiness, shutdown, retirement, and cleanup. Name `lost readiness reply never allows rollback`, `disconnection is not launch failure`, `precommit abort needs no destination`, `post-readiness crash belongs to supervisor`, `source metadata append invalidates commit`, and `rollback reuses untouched original file`. Assert no segment appended to rollback source, source remains frozen on uncertainty, and pending placement never rolls back a successful move. Each fault is a separate short test.

- [ ] **Step 2: Run red.** `npm test -- packages/roam/src/__tests__/move.test.ts packages/roam/src/__tests__/move-faults.test.ts packages/roam/src/__tests__/homes.test.ts`. Expected: no orchestrated home transition.
- [ ] **Step 3: Implement the seven completed-work states.** Serialize per session and reconcile repeated operation IDs. Preflight reachable compatible machines, source build or dormancy, destination installation, pi auth, workspace and binding maps, and exact blockers. Hold a Mac power assertion through preparation and all recovery until done, abort, or rollback. Print `Keep the Mac awake until the move finishes.` Seed active membership in resumable chunks and sync it before freeze. Pre-stage workspace checkout and transcript while the source stays active.

Freeze records barriers and immutable source observation. Transfer only final Git and transcript deltas, revalidate source trees and transcript size and digest, and reach all global, repo, and worktree barriers. Prepare local maps, exact file, binding, and retired destination state. Commit home from source epoch e to destination e+1 in the same hub DB transaction as its action receipt. Replicate home, then issue expected-epoch `session start` to activate destination and running intent. Persist readiness before consumers. Stop source with reason move, prove its process identity absent, retire it, and remove only its recorded terminal. Call existing `registry.remove(id, provedRemoved)` only after removal proof. Verify one admitted destination owner and reconcile placement. At done delete private move refs on both machines and unreferenced staging. Cleanup and app failures remain pending cleanup, never rollback.

Before commit, abort proves source home e still current and durably cancels that commit action before unfreeze, even with destination unreachable. After commit a timeout is unknown. Reconcile home, destination journal, readiness, and process identity. Rollback requires proved launch failure, no readiness receipt, and destination acknowledgement of stopped ownership plus durable retirement. Only then CAS source back at e+2, replicate, atomically advance source membership to e+2 under that verified home, and readmit its original process or exact original file without a new marker. Once readiness exists, stay at destination and use supervisor recovery. Hub startup reconciles incomplete moves before another move for that session. Never restore an old home by timeout.
- [ ] **Step 4: Run green.** Repeat the red command. Expected: every injected failure yields verified recovery, higher-epoch rollback, or explicit pending with the source frozen. Ordinary moves never produce two admitted owners.
- [ ] **Step 5: Commit.** `git commit -m "feat(roam): move session homes with durable exclusion"`.

### Task 4.5: Recover destroyed machines and conflicting initial homes

**Track:** Moves. Depends on 4.4.

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

- [ ] **Step 2: Run red.** `npm test -- packages/roam/src/__tests__/forget.test.ts packages/roam/src/__tests__/claim.test.ts`. Expected: no explicit revocation or recovery path.
- [ ] **Step 3: Implement assertion-based recovery.** Every sync mirrors peer-homed appended JSONL through verified complete lines. Before forget, display possible two-copy execution if the assertion is wrong and loss of post-mirror conversation and unsent workspace edits. Require typed confirmation that this exact UUID is destroyed, then durably revoke before any restore. Move affected homes to the Mac at next epoch, validate and mark the mirror using normal file rules, and wait for valid local workspace and auth before `session start`. No mirror means explicit recovery refusal. Retire-only on reconnection stops sessions before any sync. Reconcile incomplete moves against new homes. Claim is only for an unassigned initial home, with all conflicting machines reachable and all competing copies stopped. No offline takeover or assigned-home rewrite.
- [ ] **Step 4: Run green.** Repeat the red command and move fault tests. Expected: permanent revocation, higher-epoch mirror restore, and no claim that bypasses normal moves.
- [ ] **Step 5: Commit.** `git commit -m "feat(roam): revoke destroyed machines and recover mirrored homes"`.

### Task 4.6: Expose moves and gate full synthetic acceptance

**Track:** Product. Depends on 4.5.

**Files:**
- Create: `packages/roam/src/move-ports.ts`.
- Create: `packages/roam/src/__tests__/move-ports.test.ts`.
- Create: `packages/roam/src/__tests__/commands.test.ts`.
- Create: `packages/host/src/roam/move-command.ts`.
- Create: `packages/host/src/roam/__tests__/roam-move-command.test.ts`.
- Create: `packages/herdr/e2e/scenarios/roam-move.test.ts`.
- Create: `packages/herdr/e2e/scenarios/roam-recovery.test.ts`.
- Modify: `packages/host/src/extension.ts`.
- Modify: `packages/roam/src/cli.ts`.
- Modify: `packages/roam/src/agent.ts`.
- Modify: `docs/architecture/roaming.md`.
- Modify: `README.md`.
- Modify: `scripts/herdr-e2e.mjs`.

**Interfaces:** Consumes shared `MoveRequest`, `MoveResult`, `MovePorts`, `Outcome`, `moveSession(request: MoveRequest, ports: MovePorts): Promise<Outcome<MoveResult>>`, `recoverMove(moveId: string, ports: MovePorts): Promise<Outcome<MoveResult>>`, `cancelMove(moveId: string, ports: MovePorts): Promise<Outcome<MoveResult>>`, `forgetMachine(input: {machineId: MachineId; confirmation: string}, ports: MovePorts): Promise<Outcome<readonly Home[]>>`, `claimInitialHome(input: {sessionId: string; machineId: MachineId; stoppedCopies: readonly MachineId[]}, ports: MovePorts): Promise<Outcome<Home>>`, and the existing public pi command API. All cross-process assembly uses the complete shared Operation, MovePorts, artifact, readiness, and session manifests. No host implementation is imported into roaming. Produces `createMovePorts(config: RoamConfig, transport: Transport, journal: Journal): MovePorts` in `move-ports.ts` and `registerMoveCommand(pi: ExtensionAPI, request: (input: MoveRequest) => Promise<Outcome<MoveResult>>): void`. Existing spider model-tool schema gains no credential or home mutation action. CLI resolves exact session ID, unambiguous prefix, or unambiguous name from the hub catalog; machine `mac` resolves to the enrolled Mac. Acceptance IDs are `R06` outward move, `R07` return move, `R08` exclusion and rollback, `R09` revoked-home restore, and `R10` packaged nonowner admission.

- [ ] **Step 1: Write the failing tests.** Name `Mac slash move targets only persistent top-level current session`, `box slash move points to Mac without request rows`, `ambiguous name refuses with candidates`, `pending outcome explains paused source`, `success repeats lost peers and tool warnings`, and `model tool cannot provision or mutate home`. Assert:

```typescript
expect(pending.text).toContain("The source is paused to avoid running two copies.");
expect(success.text).toContain(destinationTerminal);
expect(success.lostPeers).toEqual(preflightLostPeers);
expect(toolWarningBlocksMove).toBe(false);
expect(boxRequestRows).toHaveLength(0);
expect(exitCodes).toEqual([0, 1, 2, 3]);
```

Parameterize CLI coverage for status, sync, enable, disable, provision, doctor, recover, cancel, forget, stop, resume, repo map, claim, and memory tag. JSON includes stable reason, operation ID, current home, epoch, and repair command. Invalid arguments perform no effects. Capture output and assert no secret, conversation body, or uncommitted content appears.

- [ ] **Step 2: Run red.** `npm test -- packages/host/src/roam/__tests__/roam-move-command.test.ts packages/roam/src/__tests__/commands.test.ts`. Expected: no user move command.
- [ ] **Step 3: Wire commands and acceptance stories.** Compose every MovePorts effect from the implemented Git, session-file, control, sync, supervisor, and recovery APIs in `move-ports.ts`; `move-ports.test.ts` names `real adapters preserve expected epoch and exact file` and asserts `expect(remoteOperation.expectedEpoch).toBe(home.epoch)` and `expect(installedFile).toBe(manifest.file)`. The roaming package never imports host: participant operations reach host only through the session socket. Product alone wires the 4.3 socket factory into the first admission handler before ordinary startup and adds session inspect, freeze, start, retire, and unfreeze dispatch to `agent.ts`. `/move` is primary. Mac controls use a mode-0600 same-user socket and stream bounded progress. On boxes only doctor, local status, and repo mapping execute locally; other controls direct callers to the Mac. Disallow child, print, transient, and nonpersistent slash moves. Warn about missing tool auth without blocking, block missing pi auth, list lost intercom peers before and after the move, and do not promise a relay. Wire recover to the exact safe next action or missing evidence, not a fresh attempt. Disable refuses an in-progress home change and never stops box homes or erases them. Add short isolated stories for both directions, rollback, revocation, and copied-file admission, using packed real pi and owned cores. Each new story stays under five seconds; long real scenarios belong to 4.7.
- [ ] **Step 4: Run green and the common phase gate.** Also run `npm run test:herdr:e2e -- --built --story R01,R02,R03,R04,R05,R06,R07,R08,R09,R10`. Expected: A12 through A16 on synthetic roots, plus prior phase acceptance, all packaged CLI commands, and proved cleanup. Read actual IDs, cwd, homes, leases, tree hashes, ledgers, terminal placement, and unchanged unrelated roots. Deploy disabled before 4.7. Document all v1 exclusions without adding their functionality.
- [ ] **Step 5: Commit.** `git commit -m "feat(roam): expose safe moves and complete synthetic acceptance"`.

### Task 4.7: Run private real-box acceptance before enablement

**Track:** Acceptance. **Maintainer step, not a worker task or a long-running Vitest test.** Depends on 4.6, the full gate, and a disabled deployment.

**Files:** No public product edits. Keep receipts, machine inventory, actual URL equivalence checks, authentication observations, and real checkout-tool findings in private evidence storage. Use a disposable repository and synthetic session. Never use a production conversation.

**Interfaces:** Consumes packaged `spider`, the configured enrolled peer, the release hashes, and acceptance scenarios A1 and A8 through A16. Produces private receipts plus a pass, blocked, or failed decision for each selected scenario. Nothing is enabled merely because a command timed out or an observation was unavailable.

- [ ] **Step 1: Verify real prerequisites and installation.** Record native Linux SQLite load, pinned pi and intercom versions, release hashes, Node range, exact core identity, inherited hard and soft nofile limits, inotify values, and core-only extension load inside a core-spawned terminal. Verify both pinned Node versions with native-module and extension-load probes on disposable Linux roots. Verify existing core units and unrelated terminals are unchanged. Sign in at destination rather than silently copying auth.
- [ ] **Step 2: Measure transport and actual apply.** Record successful raw 384 KiB chunk timings and throughput, export and import durations including lexical work, and binary and session artifacts above 64 MiB. Exercise resumable corruption and lost-result reconciliation within configured limits. Verify two-peer concurrency if two disposable peers are available; otherwise report that optional measurement as blocked rather than claiming a measured default.
- [ ] **Step 3: Prove two-hour no-client hosting.** Start one exact synthetic session and trigger, then disconnect or power off the Mac client for two hours. Reconnect and verify the same terminal survived and the trigger fired once. Keep the waiting observation outside Vitest. Separately exercise supervisor and core restart recovery and deliberate stop using an isolated acceptance core and supervisor unit. Never restart a shared core for this check. Record that host reboot remains unavailable until desktop sign-in, not automatic power-on recovery.
- [ ] **Step 4: Move out and back with real checkout constraints.** Privately verify the actual equivalent-origin pair and whether default no-checkout or configured worktree creation works for the real sparse or virtualized checkout. Use synthetic content for the real test. Exercise A12 staged and working changes, A13 older selected leaf and usage round trip, A14 blockers and warnings, and A15 through A16 lost replies, dormant source, multi-store freeze, rollback exclusion, copied-file refusal, offline active continuation, and mirror-based forget on disposable identities. Inspect real values, not just success summaries.
- [ ] **Step 5: Decide enablement.** Require A1's terminal survival and all applicable A8 through A16 receipts, unchanged unrelated roots, and no unresolved required observation. Confirm all consumers, including detached usage workers, are schema- and origin-compatible and reloaded. Only then explicitly enable replication and hosting. Keep disabled if any required real acceptance is blocked or failed. No public commit contains these receipts.

## Acceptance coverage

| Scenario | Tasks that implement and prove it | Required final evidence |
| --- | --- | --- |
| A1 | 2.4 export and apply timing, 3.2 native install probes, 3.5 in-terminal core-only activation, 4.7 measurements and two-hour survival | Private real-box receipt, not reported host uptime |
| A2 | 1.1 identity, 1.2 migration, 1.8 explicit maps and cached fallback, 1.10 composition | Fresh and v13 fixture equality in all scopes |
| A3 | 1.3 function-free capture and fences, 1.4 retired membership, 1.10 CLI-after-import composition | New, raw old-build, and CLI writers, recursion on and off |
| A4 | 1.4 peer permutations, tombstones, HLC and idle logs, 2.4 transport composition | Three independent roots converge without idle growth |
| A5 | 1.4 receipts and conflicts, 1.5 invalidation, 1.7 accounting, 2.3 lost results | Digest replay creates no duplicate rows, notices, or charges |
| A6 | 1.5 derived data and event policies, 1.6 producer coverage, 1.8 catalog and tags | Read-only hub reads with no checkout and correct lexical text |
| A7 | 1.6 operational origin guards, 1.7 discovery and restore, 1.10 composed fixtures | Foreign PID and directory collisions cause zero actions |
| A8 | 2.2 bytes and deadlines, 2.3 artifacts, 2.6 isolated acceptance, 4.7 real transfer | Above-64-MiB byte equality and corruption refusal |
| A9 | 2.5 service lock and availability, 2.6 packaged CLI and isolated cores | No automatic app or core start, one placement on recovery |
| A10 | 3.1 core-only, 3.2 consent and services, 3.5 installed acceptance, 4.7 real install | No auth transfer without consent, unchanged core, one service |
| A11 | 3.3 supervision, 3.4 readiness and triggers, 3.5 isolated recovery, 4.7 no-client observation | One exact-file owner, durable stopped and suspended state |
| A12 | 4.1 Git fixtures, 4.6 both-direction stories, 4.7 real checkout path | Equal HEAD, index, and working trees and unchanged unrelated roots |
| A13 | 1.7 segment accounting, 4.2 actual pi file tests, 4.6 round trip, 4.7 real move | Same session and selected branch, mapped cwd, local-only charges |
| A14 | 1.6 run blockers, 4.3 full inventory, 4.4 pre-stage and power, 4.6 warnings | Exact blockers, lost peers, nonblocking tool-auth warnings |
| A15 | 4.3 live and dormant freeze, 4.4 fault matrix and CAS, 4.5 forget, 4.6 isolated faults, 4.7 real recovery | No unsafe rollback, durable revoked identity, higher epochs |
| A16 | 1.3 seed and fences, 1.9 admission, 3.4 box initial origin, 4.3 reload guards, 4.5 claim, 4.6 copied-file stories | Nonowners make no requests or writes, offline active homes continue |

## Completion checks

- [ ] Each spec requirement has a task and each A1 through A16 has the evidence above. Deferred follow-ups remain deferred.
- [ ] Every worker task has exact file ownership, complete interface inputs, a named failing test, a red command, implementation decisions, a green command, and a commit.
- [ ] Generated SQL matches descriptors and contains no application-defined functions. Fresh and migrated layouts match.
- [ ] All four phase gates include typecheck, tests, build, packaged CLI where available, isolated Herdr acceptance, and disabled deployment before the next phase.
- [ ] Required private real acceptance is complete before enablement. No credentials, real-machine paths, private results, or private inventories enter public artifacts.

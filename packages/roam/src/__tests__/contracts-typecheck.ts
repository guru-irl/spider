import type { Db } from "@spider/db-core";
import type { SessionAddress, SessionEndpoint } from "@spider/intercom/protocol";
import type { ApplyReceipt, BatchArtifact, ExportPolicy, Home, JsonObject, MachineId, Probe, ProcessIdentity, HubOperationReadiness, Readiness, ReplicaEffects, StoreBarrier, StoreKey } from "@spider/db-core/roam/types";
import type {
  AgentPorts, ArtifactManifest, BootstrapPeer, CallOptions, Clock, DestinationObservation, Diagnostic, FreezeAck, GitPorts,
  HostIntent, HubPorts, IntercomConfig, IntercomMovePorts, Journal, Limits, MoveCheck, MovePorts, MoveRequest, MoveResult, MoveRefusal, MoveRefusalCode, MoveOutcome, MoveSessionOutcome, ValidatedBlockerId, Operation, Outcome,
  PaneTarget, PaneActionOutcome, WorkspaceRestore, Peer, PlacementPort, PreparedMove, PreparedWorkspace, RecoveryPort, RoamConfig, SessionManifest,
  StorePort, SyncService, Transport, WorkspaceSnapshot,
} from "@spider/roam/contracts";
import type { BootstrapOptions, Inventory } from "@spider/roam/provision-contracts";
import type { HostingWarning } from "../hosting-warning";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;

type _Peer = Assert<Equal<Peer, { machineId: MachineId; alias: string; node: string; pi: string; cli: string; core: string; globalRoot: string; agentDir?: string; coreUnit?: string }>>;
type _Limits = Assert<Equal<Limits, {
  chunkBytes: number; replyBytes: number; manifestBytes: number; targetBatchBytes: number; hardBatchBytes: number;
  applyTargetMs: number; workspaceBytes: number; sessionBytes: number; agentBytes: number; stagingBytes: number;
  fileMs: number; controlMs: number; exportMs: number; importMs: number; directMs: number; launchMs: number;
  readyMs: number; transferMs: number; peerConcurrency: number; retryDelaysMs: readonly number[]; retentionMs: number;
}>>;
type _RoamConfig = Assert<Equal<RoamConfig, {
  enabled: boolean; role: "hub" | "box"; machineId: MachineId; hubMachineId: MachineId; peers: readonly Peer[];
  discoveryRoots: readonly string[]; coreUnit: string; syncMs: number; limits: Limits; intercom: IntercomConfig;
}>>;
type _Operation = Assert<Equal<Operation, { id: string; machineId: MachineId; expectedEpoch: number | null; kind: string; args: JsonObject }>>;
type _Outcome = Assert<Equal<Outcome<{ ok: boolean }>, {
  code: 0 | 1 | 2 | 3; reason: string; operationId: string; home: Home | null; epoch: number | null;
  repairCommand: string | null; value: { ok: boolean } | null; causeCode?: string; operationKind?: import("../cause-codes").AgentOperationKind;
}>>;
type _CallOptions = Assert<Equal<CallOptions, { timeoutMs: number; maxBytes: number; stdin?: Buffer; remoteTimeoutMs?: number;
  postReserveMs?: number; signal?: AbortSignal; stdinForTimeout?: (remoteTimeoutMs: number) => Buffer; onConnected?: (connected: boolean) => void }>>;
type _Transport = Assert<Equal<Transport, {
  resolve(peer: Peer, options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<Peer>;
  bootstrapProbe(peer: BootstrapPeer, kind: "inventory", options?: BootstrapOptions): Promise<Inventory>;
  exec(peer: Peer, argv: readonly string[], options: CallOptions): Promise<Buffer>;
  run(peer: Peer, argv: readonly string[], operationId: string): Promise<{ terminal: string }>;
  read(peer: Peer, path: string, options: CallOptions): Promise<Buffer>;
  write(peer: Peer, path: string, bytes: Buffer, timeoutMs: number): Promise<void>;
}>>;
type _Clock = Assert<Equal<Clock, { now(): number; later(ms: number, fn: () => void): () => void }>>;
type _Journal = Assert<Equal<Journal, {
  begin(operation: Operation): { kind: "new" | "pending" | "done"; result: JsonObject | null };
  lookupOperation?(id: string): { machineId: MachineId; state: "pending" | "done" } | null;
  record(id: string, action: string, result: JsonObject): void;
  read(id: string): readonly { action: string; result: JsonObject }[];
}>>;
type _ArtifactManifest = Assert<Equal<ArtifactManifest, {
  id: string; kind: "batch" | "session" | "workspace" | "release" | "agent" | "auth"; byteLength: number; sha256: string;
  chunks: readonly { index: number; rawLength: number; sha256: string }[];
}>>;
type _AgentPorts = Assert<Equal<AgentPorts, {
  config: RoamConfig; journal: Journal; root: string;
  openStore(key: StoreKey): { db: Db; effects: ReplicaEffects; policy: ExportPolicy };
  move?(operation: Operation): Promise<Outcome<JsonObject>>;
}>>;
type _StorePort = Assert<Equal<StorePort, {
  list(peer: MachineId): readonly StoreKey[]; cursor(key: StoreKey, machine: MachineId, stream: string): number;
  accept(key: StoreKey, artifact: BatchArtifact): Promise<ApplyReceipt>;
  export(key: StoreKey, after: number, targetBytes: number, batchId: string): Promise<BatchArtifact>;
}>>;
type _SyncService = Assert<Equal<SyncService, {
  start(): void; stop(): void; sync(peer?: MachineId): Promise<readonly Outcome<ApplyReceipt>[]>;
  barriers(peer: MachineId, required: readonly StoreBarrier[]): Promise<boolean>;
}>>;
type _PlacementPort = Assert<Equal<PlacementPort, { reconcile(rows: readonly Readiness[]): Promise<{ pending: readonly string[] }> }>>;
type _HubPorts = Assert<Equal<HubPorts, { config: RoamConfig; sync: SyncService; journal: Journal; clock: Clock; placement: PlacementPort }>>;
type _HostingWarning = Assert<Equal<HostingWarning, { code: "supervisor-hosting-error";
  check: "running-intent" | "intent-view" | "inspection" | "restart" | "launch"; since: number; count: number;
  causeCode?: string; exitCode?: number; signal?: number }>>;
type _Diagnostic = Assert<Equal<Diagnostic, { code?: HostingWarning["code"]; reason: string; severity: "info" | "warning" | "block"; repairCommand: string | null; writerEpoch?: number }>>;
type _HostIntent = Assert<Equal<HostIntent, {
  sessionId: string; epoch: number; desired: "running" | "stopped"; suspended: string | null; file: string; cwd: string; moveId: string | null;
}>>;
type _GitPorts = Assert<Equal<GitPorts, {
  run(cwd: string, argv: readonly string[], options?: { env?: Readonly<NodeJS.ProcessEnv>; stdin?: Buffer }): Promise<Buffer>;
  journal: Journal; limits: Limits; scratch: string; worktreeCommand: readonly string[] | null;
}>>;
type _WorkspaceSnapshot = Assert<Equal<WorkspaceSnapshot, {
  root: string; repoKey: string; workspaceId: string; moveId: string; stage: "pre" | "final"; head: string;
  branch: string | null; objectFormat: "sha1" | "sha256"; indexTree: string; workingTree: string;
  relativeCwd: string; sparsePatterns: string | null; worktreeConfig: string | null; droppedConfigKeys: readonly string[];
  normalization: { autocrlf: string | null; eol: string | null }; sparse: { enabled: boolean; cone: boolean | null }; refs: readonly string[];
  prerequisites: readonly string[]; bundle: { kind: "unbundled" } | { kind: "ready"; artifactId: string; byteLength: number };
}>>;
type _PreparedWorkspace = Assert<Equal<PreparedWorkspace, { root: string; snapshot: WorkspaceSnapshot; previous: WorkspaceSnapshot | null; moveId: string; adjustments: readonly ("sparse-cone-defaulted-to-false")[] }>>;
type _SessionManifest = Assert<Equal<SessionManifest, { file: string; sessionId: string; cwd: string; leaf: string; size: number; sha256: string; historySha256: string; artifactId: string }>>;
type _FreezeAck = Assert<Equal<FreezeAck, {
  operationId: string; sessionId: string; epoch: number; owner: ProcessIdentity | null; file: string; cwd: string;
  leaf: string; size: number; sha256: string; barriers: readonly StoreBarrier[]; intercomGeneration: string;
}>>;
type _MoveRequest = Assert<Equal<MoveRequest, { operation: Operation; sessionId: string; destinationMachine: MachineId }>>;
type _MoveResult = Assert<Equal<MoveResult, { home: Home; terminal: string | null; intercomAddress: string; warnings: readonly string[]; sourceCleanup: import("../contracts").SourceCleanup; destinationRoot?: string }>>;
type _MoveRefusalCode = Assert<Equal<MoveRefusalCode, keyof typeof import("../contracts").MOVE_REFUSAL_MESSAGES>>;
type _MoveRefusal = Assert<Equal<MoveRefusal, { code: MoveRefusalCode; blockers: readonly ValidatedBlockerId[]; message: string; hostingWarning?: HostingWarning;
  firstHomeWithheld?: { machineId: string; storeKind: "worktree" | "replica" } }>>;
type _MoveOutcome = Assert<Equal<MoveOutcome, { ok: true; value: MoveResult } | { ok: false; refusal: MoveRefusal }>>;
type _MoveSessionOutcome = Assert<Equal<MoveSessionOutcome, Outcome<MoveResult> & (
  ({ code: 0 } & Extract<MoveOutcome, { ok: true }>) |
  ({ code: 1 | 2 | 3; value: null } & Extract<MoveOutcome, { ok: false }>)
)>>;
type _MoveSuccessCode = Assert<Equal<Extract<MoveSessionOutcome, { ok: true }>["code"], 0>>;
type _MoveFailureCode = Assert<Equal<Extract<MoveSessionOutcome, { ok: false }>["code"], 1 | 2 | 3>>;
type _MoveFailureValue = Assert<Equal<Extract<MoveSessionOutcome, { ok: false }>["value"], null>>;
type _BlockerIsBranded = Assert<Equal<string extends ValidatedBlockerId ? true : false, false>>;
type _MoveFunction = Assert<Equal<ReturnType<typeof import("../move").moveSession>, Promise<MoveSessionOutcome>>>;
type _RecoverFunction = Assert<Equal<Parameters<typeof import("../move-recovery").recoverMove>, [string, MovePorts]>>;
type _CancelFunction = Assert<Equal<Parameters<typeof import("../move-recovery").cancelMove>, [string, MovePorts]>>;
type _RecoverEnvelope = Assert<Equal<ReturnType<typeof import("../move-recovery").recoverMove> extends Promise<Outcome<MoveResult>> ? true : false, true>>;
type _CancelEnvelope = Assert<Equal<ReturnType<typeof import("../move-recovery").cancelMove> extends Promise<Outcome<MoveResult>> ? true : false, true>>;
type _AbortProof = Assert<Equal<ReturnType<typeof import("../move-recovery").authorizeMoveAbort>, Promise<{ home: Home; cancelledMoveId: string } | null>>>;
type _MoveCheck = Assert<Equal<MoveCheck, {
  source: Home; destinationMachine: MachineId; repoKey: string; workspaceId: string; sourceRoot: string; sourceFile: string;
  sourceCwd: string; destinationRoot: string; destinationCwd: string; storeKeys: readonly StoreKey[];
  warnings: readonly string[];
}>>;
type _PreparedMove = Assert<Equal<PreparedMove, { workspace: PreparedWorkspace; session: SessionManifest }>>;
type _DestinationObservation = Assert<Equal<DestinationObservation, {
  home: Home; owner: Probe; readiness: HubOperationReadiness | null; launchFailure: string | null; retired: boolean; activationCancelled?: boolean; hostingWarning?: HostingWarning;
}>>;
type _MovePorts = Assert<Equal<MovePorts, {
  config: RoamConfig; globalDb: Db; journal: Journal; clock: Clock;
  intercom: { address: SessionAddress; ports: IntercomMovePorts; destinationEndpoint(home: Home): Promise<SessionEndpoint> };
  check(request: MoveRequest): Promise<MoveCheck>; power(): Promise<() => Promise<void>>;
  seed(check: MoveCheck): Promise<readonly StoreBarrier[]>; prepare(check: MoveCheck, operation: Operation): Promise<PreparedMove>;
  freeze(home: Home, operation: Operation): Promise<FreezeAck>;
  transfer(check: MoveCheck, ack: FreezeAck, operation: Operation): Promise<PreparedMove>;
  verifySource(ack: FreezeAck, workspace: WorkspaceSnapshot): Promise<void>;
  barriers(machine: MachineId, required: readonly StoreBarrier[]): Promise<boolean>; replicateHome(home: Home): Promise<void>;
  start(home: Home, prepared: PreparedMove, operation: Operation): Promise<Outcome<HubOperationReadiness>>;
  inspect(home: Home, operation: Operation): Promise<DestinationObservation>; retire(home: Home, operation: Operation): Promise<Probe>;
  readmitSource(source: Home, restoredHome: Home, operation: Operation): Promise<MoveSessionOutcome>;
  abortWorkspace?(check: MoveCheck, operation: Operation): Promise<void>;
  unfreeze(home: Home, operation: Operation): Promise<void>; cleanup(check: MoveCheck, operation: Operation): Promise<void>; recovery: RecoveryPort;
}>>;
type _RecoveryPort = Assert<Equal<RecoveryPort, {
  blockers(): readonly string[];
  revocationDb: Db; workspaceRestores?(): Promise<readonly WorkspaceRestore[]>;
  presentReadyTarget(target: PaneTarget): Promise<PaneActionOutcome>; homes(machine: MachineId): readonly Home[]; mirror(sessionId: string, epoch: number): Promise<SessionManifest | null>;
  restore(home: Home, mirror: SessionManifest, operation: Operation): Promise<Outcome<HubOperationReadiness>>;
  conflicts(sessionId: string): Promise<readonly { machineId: MachineId; owner: Probe }[]>;
}>>;

// Local provenance cannot satisfy a launch or receipt contract.
type _LocalIsNotLaunchReadiness = Assert<Equal<Extract<Readiness, { origin: "box-local" }> extends HubOperationReadiness ? true : false, false>>;
type _ReceiptRequiresHubReadiness = Assert<Equal<Parameters<typeof import("../session-control").recordReadiness>[1], HubOperationReadiness>>;

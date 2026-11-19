import type { Db } from "@spider/db-core";
import type { Blocker } from "@spider/db-core/roam/types";
import type { IntercomIntakeFence, SessionAddress, SessionEndpoint } from "@spider/intercom/protocol";
export type { IntercomIntakeFence } from "@spider/intercom/protocol";
export interface IntercomMoveInspection { blockers: readonly Blocker[]; cancelledWork: readonly never[]; warnings: readonly string[] }
export interface IntercomMovePorts {
  close(address: SessionAddress, moveId: string, expectedEpoch: number, generation?: string): Promise<IntercomIntakeFence>;
  drain(fence: IntercomIntakeFence): Promise<void>;
  inspect(fence: IntercomIntakeFence): Promise<IntercomMoveInspection>;
  checkGeneration(fence: IntercomIntakeFence): Promise<void>;
  /** The freeze adapter separately proves durable move cancellation before calling abort. */
  abort(fence: IntercomIntakeFence): Promise<void>;
  ready(fence: IntercomIntakeFence, endpoint: SessionEndpoint): Promise<{ intercomAddress: string; warnings: readonly string[] }>;
}
import type {
  ApplyReceipt, BatchArtifact, ExportPolicy, Home, JsonObject, MachineId, Probe, ProcessIdentity,
  HubOperationReadiness, Readiness, ReplicaEffects, StoreBarrier, StoreKey,
} from "@spider/db-core/roam/types";
import type { BootstrapOptions, Inventory } from "./provision-contracts";
import { INTERCOM_QUEUE_BYTES, INTERCOM_QUEUE_MESSAGES } from "./intercom-contracts";

export interface Peer {
  machineId: MachineId; alias: string; node: string; pi: string; cli: string; core: string; globalRoot: string; agentDir?: string; coreUnit?: string;
}
export type BootstrapPeer = Pick<Peer, "alias" | "node" | "pi" | "cli" | "core" | "globalRoot" | "agentDir">;
export interface Limits {
  chunkBytes: number; replyBytes: number; manifestBytes: number; targetBatchBytes: number; hardBatchBytes: number;
  applyTargetMs: number; workspaceBytes: number; sessionBytes: number; agentBytes: number; stagingBytes: number;
  fileMs: number; controlMs: number; exportMs: number; importMs: number; directMs: number; launchMs: number;
  readyMs: number; transferMs: number; peerConcurrency: number; retryDelaysMs: readonly number[]; retentionMs: number;
}

export const DEFAULT_LIMITS: Readonly<Limits> = Object.freeze({
  chunkBytes: 384 * 1024,
  replyBytes: 1024 * 1024,
  manifestBytes: 512 * 1024,
  targetBatchBytes: 4 * 1024 * 1024,
  hardBatchBytes: 16 * 1024 * 1024,
  applyTargetMs: 250,
  workspaceBytes: 256 * 1024 * 1024,
  sessionBytes: 1024 * 1024 * 1024,
  agentBytes: 256 * 1024 * 1024,
  stagingBytes: 4 * 1024 * 1024 * 1024,
  fileMs: 30_000,
  controlMs: 60_000,
  exportMs: 120_000,
  importMs: 600_000,
  directMs: 600_000,
  launchMs: 60_000,
  readyMs: 60_000,
  transferMs: 30 * 60_000,
  peerConcurrency: 2,
  retryDelaysMs: Object.freeze([1_000, 2_000, 4_000]),
  retentionMs: 7 * 24 * 60 * 60_000,
});

export interface IntercomLimits { queueMessages: number; queueBytes: number }
export const DEFAULT_INTERCOM_LIMITS: Readonly<IntercomLimits> = Object.freeze({
  queueMessages: INTERCOM_QUEUE_MESSAGES, queueBytes: INTERCOM_QUEUE_BYTES,
});
export type IntercomRoute =
  | { kind: "direct"; peer: Peer; edgeEpoch: string }
  | { kind: "relay"; peer: Peer; via: MachineId };
export interface IntercomConnectorRecipe { check: readonly string[]; host: readonly string[]; connect: readonly string[]; localPort: number; pairPorts?: Readonly<Record<string, number>> }
interface IntercomSettings {
  mode: "hub-only" | "peers"; protocolFeature: "federation-v1";
  routes: readonly IntercomRoute[]; limits: IntercomLimits; connector?: IntercomConnectorRecipe;
}
export type IntercomConfig = IntercomSettings & (
  | { enabled: false; machineAlias: string | null }
  | { enabled: true; machineAlias: string }
);
export function disabledIntercom(): IntercomConfig {
  return { enabled: false, mode: "hub-only", machineAlias: null, protocolFeature: "federation-v1",
    routes: [], limits: { ...DEFAULT_INTERCOM_LIMITS } };
}
export interface RoamConfig {
  enabled: boolean; role: "hub" | "box"; machineId: MachineId; hubMachineId: MachineId;
  peers: readonly Peer[]; discoveryRoots: readonly string[]; coreUnit: string; syncMs: number; limits: Limits;
  intercom: IntercomConfig;
}
export interface Operation { id: string; machineId: MachineId; expectedEpoch: number | null; kind: string; args: JsonObject }
export interface Outcome<T> {
  code: 0 | 1 | 2 | 3; reason: string; operationId: string; home: Home | null;
  epoch: number | null; repairCommand: string | null; value: T | null; causeCode?: string;
}
export interface CallOptions {
  timeoutMs: number; maxBytes: number; stdin?: Buffer;
  remoteTimeoutMs?: number; postReserveMs?: number; signal?: AbortSignal;
  stdinForTimeout?: (remoteTimeoutMs: number) => Buffer;
  onConnected?: (connected: boolean) => void;
}
export interface Transport {
  resolve(peer: Peer, options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<Peer>;
  bootstrapProbe(peer: BootstrapPeer, kind: "inventory", options?: BootstrapOptions): Promise<Inventory>;
  exec(peer: Peer, argv: readonly string[], options: CallOptions): Promise<Buffer>;
  run(peer: Peer, argv: readonly string[], operationId: string): Promise<{ terminal: string }>;
  read(peer: Peer, path: string, options: CallOptions): Promise<Buffer>;
  write(peer: Peer, path: string, bytes: Buffer, timeoutMs: number): Promise<void>;
}
export interface Clock { now(): number; later(ms: number, fn: () => void): () => void }
export interface JournalOperationState { machineId: MachineId; state: "pending" | "done" }
export interface Journal {
  begin(operation: Operation): { kind: "new" | "pending" | "done"; result: JsonObject | null };
  /** Mirror operations require this lookup and refuse journals that cannot provide it. */
  lookupOperation?(id: string): JournalOperationState | null;
  /** Record an action result. The reserved action `done` commits the operation result. */
  record(id: string, action: string, result: JsonObject): void;
  read(id: string): readonly { action: string; result: JsonObject }[];
}
export interface ArtifactManifest {
  id: string; kind: "batch" | "session" | "workspace" | "release" | "agent" | "auth"; byteLength: number; sha256: string;
  chunks: readonly { index: number; rawLength: number; sha256: string }[];
}
export interface AgentPorts {
  config: RoamConfig; journal: Journal; root: string;
  openStore(key: StoreKey): { db: Db; effects: ReplicaEffects; policy: ExportPolicy };
  move?(operation: Operation): Promise<Outcome<JsonObject>>;
}
export interface StorePort {
  list(peer: MachineId): readonly StoreKey[];
  cursor(key: StoreKey, machine: MachineId, stream: string): number;
  accept(key: StoreKey, artifact: BatchArtifact): Promise<ApplyReceipt>;
  export(key: StoreKey, after: number, targetBytes: number, batchId: string): Promise<BatchArtifact>;
}
export interface SyncService {
  start(): void; stop(): void;
  sync(peer?: MachineId): Promise<readonly Outcome<ApplyReceipt>[]>;
  barriers(peer: MachineId, required: readonly StoreBarrier[]): Promise<boolean>;
}
export interface PlacementPort { reconcile(rows: readonly Readiness[]): Promise<{ pending: readonly string[] }> }
export type PlacementFactory = (input: { root: string; globalDb: Db; config: RoamConfig }) => PlacementPort & { dispose(): Promise<void> };
export interface HubPorts { config: RoamConfig; sync: SyncService; journal: Journal; clock: Clock; placement: PlacementPort }
export interface IntercomDiagnostic { peer: MachineId; status: string; since: number; reason: string }
export interface IntercomLifecycle {
  start(): Promise<void>;
  stop(): Promise<void>;
  diagnostics(): readonly IntercomDiagnostic[];
  readiness?(): { state: "disabled" | "pending" | "ready"; reason: string | null };
}
export interface Diagnostic { code?: import("./hosting-warning").HostingWarning["code"]; reason: string; severity: "info" | "warning" | "block"; repairCommand: string | null; writerEpoch?: number }
export type NativeHostingOutcome = "live" | "killed" | "core-loss" | "unexpected-exit" | "unknown";
export interface HostIntent {
  sessionId: string; epoch: number; desired: "running" | "stopped"; suspended: string | null;
  file: string; cwd: string; moveId: string | null;
}

export interface GitRunFailure extends Error { status: number; stdout: Buffer; stderr: Buffer }
export interface GitPorts {
  /** Nonzero commands reject with GitRunFailure; consumers fail closed if details are missing. */
  run(cwd: string, argv: readonly string[], options?: { env?: Readonly<NodeJS.ProcessEnv>; stdin?: Buffer }): Promise<Buffer>;
  journal: Journal; limits: Limits; scratch: string; worktreeCommand: readonly string[] | null;
}
export interface WorkspaceSnapshot {
  root: string; repoKey: string; workspaceId: string; moveId: string; stage: "pre" | "final"; head: string;
  /** Full symbolic ref, such as refs/heads/main, or null for a detached HEAD. */
  branch: string | null; objectFormat: "sha1" | "sha256"; indexTree: string; workingTree: string;
  relativeCwd: string; sparsePatterns: string | null; worktreeConfig: string | null;
  /** Names of unsafe worktree settings omitted from worktreeConfig, without their values. */
  droppedConfigKeys: readonly string[];
  /** Effective source Git values for checkout line-ending normalization, or null when unset. */
  normalization: { autocrlf: string | null; eol: string | null };
  /** Effective sparse-checkout enablement and cone-mode setting, or null when cone mode is unset. */
  sparse: { enabled: boolean; cone: boolean | null };
  refs: readonly string[]; prerequisites: readonly string[];
  bundle: { kind: "unbundled" } | { kind: "ready"; artifactId: string; byteLength: number };
}
export interface WorkspaceImportPorts extends GitPorts {
  /** Resolve the local repository mapping, not a path supplied by a remote snapshot. */
  resolveCommonRepository(mapping: { repoKey: string; workspaceId: string; destination: string }): Promise<string | null>;
  /** Load this checkout's last exported snapshot, including exports from earlier moves. */
  lastExportedSnapshot(checkout: { repoKey: string; workspaceId: string; root: string }): Promise<WorkspaceSnapshot | null>;
  /** Resolve an artifact only after the local transfer store has verified it. */
  verifiedArtifactPath(artifactId: string): Promise<string | null>;
}
/** Portable changes made while restoring source settings on this destination. */
export type RestoreAdjustment = "sparse-cone-defaulted-to-false";
export interface PreparedWorkspace {
  root: string; snapshot: WorkspaceSnapshot; previous: WorkspaceSnapshot | null; moveId: string;
  adjustments: readonly RestoreAdjustment[];
}
export interface SessionManifest { file: string; sessionId: string; cwd: string; leaf: string; size: number; sha256: string; historySha256: string; artifactId: string }
export interface FreezeAck {
  operationId: string; sessionId: string; epoch: number; owner: ProcessIdentity | null;
  file: string; cwd: string; leaf: string; size: number; sha256: string; barriers: readonly StoreBarrier[];
  intercomGeneration: string;
}
export interface MoveRequest { operation: Operation; sessionId: string; destinationMachine: MachineId }
export type SourceCleanup = { status: "done" } | { status: "pending"; reason: MoveRefusalCode; blockers: readonly ValidatedBlockerId[] };
export interface MoveResult { home: Home; terminal: string | null; intercomAddress: string; warnings: readonly string[]; sourceCleanup: SourceCleanup }
/** Validated at the blocker boundary, never inferred from a message body. */
declare const validatedBlockerId: unique symbol;
export type ValidatedBlockerId = string & { readonly [validatedBlockerId]: true };
export const MOVE_REFUSAL_MESSAGES = {
  "roaming-disabled": "Roaming is disabled.",
  "move-requires-hub": "Run this move on the hub.",
  "move-request-invalid": "The move request is invalid.",
  "move-operation-conflict": "This operation ID has different move arguments.",
  "move-session-conflict": "Another move already reserves this session.",
  "move-lock-pending": "The session move lock could not be acquired.",
  "move-journal-invalid": "The move journal contains invalid evidence.",
  "move-journal-unavailable": "The move journal could not be read or written.",
  "move-preflight-refused": "Move preflight could not be verified.",
  "move-preflight-blocked": "Unsettled work blocks this move.",
  "move-home-invalid": "The home observation is invalid.",
  "initial-home-conflict": "The initial origin is conflicting. Run spider roam claim after stopping every competing copy.",
  "move-owner-invalid": "The process ownership observation is invalid.",
  "move-warnings-invalid": "Move warnings could not be verified.",
  "move-check-invalid": "Move preflight returned inconsistent evidence.",
  "move-source-home-mismatch": "Seed and sync did not confirm the expected source home.",
  "move-source-owner-uncertain": "The source owner could not be verified.",
  "move-barrier-invalid": "A store barrier is invalid.",
  "move-barrier-missing": "A required store barrier is missing.",
  "move-barriers-pending": "A destination or source cursor has not reached every required barrier.",
  "move-freeze-invalid": "The source freeze acknowledgement is invalid.",
  "move-prepared-invalid": "The prepared workspace or session is invalid.",
  "move-readiness-invalid": "Destination readiness does not match the move.",
  "move-observation-invalid": "The destination observation does not match the move.",
  "move-intercom-blocked": "Unsettled intercom work blocks this move.",
  "move-blockers-invalid": "Blocker identities could not be verified.",
  "intercom-fence-unsupported": "The required intercom move ports are unavailable.",
  "intercom-endpoint-not-ready": "The admitted destination intercom endpoint is not ready.",
  "move-destination-pending": "The source is paused to avoid running two copies. Destination readiness needs reconciliation.",
  "move-cleanup-pending": "The source has stopped; its remaining local cleanup has not finished.",
  "move-source-stop-pending": "The source process has not been proved stopped and retired.",
  "move-home-changed": "The committed home changed before move completion.",
  "move-pending": "This move is pending to avoid running two copies. Reconcile it before retrying.",
  "move-rollback-proof-missing": "Rollback readmission proof is missing.",
  "move-abort-pending": "Waiting for the hub to confirm the cancelled move.",
} as const;
export type MoveRefusalCode = keyof typeof MOVE_REFUSAL_MESSAGES;
export interface MoveRefusal { code: MoveRefusalCode; blockers: readonly ValidatedBlockerId[]; message: string; hostingWarning?: import("./hosting-warning").HostingWarning }
export type MoveOutcome = { ok: true; value: MoveResult } | { ok: false; refusal: MoveRefusal };
/** The existing command envelope is retained; consumers never parse reason to recover refusal structure. */
export type MoveSessionOutcome = Outcome<MoveResult> & (
  ({ code: 0 } & Extract<MoveOutcome, { ok: true }>) |
  ({ code: 1 | 2 | 3; value: null } & Extract<MoveOutcome, { ok: false }>)
);
export interface MoveCheck {
  source: Home; destinationMachine: MachineId; repoKey: string; workspaceId: string; sourceRoot: string;
  sourceFile: string; sourceCwd: string; destinationRoot: string; destinationCwd: string;
  storeKeys: readonly StoreKey[]; warnings: readonly string[];
}
export interface PreparedMove { workspace: PreparedWorkspace; session: SessionManifest }
export interface DestinationObservation {
  hostingWarning?: import("./hosting-warning").HostingWarning;
  home: Home; owner: Probe; readiness: HubOperationReadiness | null; launchFailure: string | null; retired: boolean;
  /** True only after durable retirement permanently cancels further activation at this epoch. */
  activationCancelled?: boolean;
}
export interface MovePorts {
  config: RoamConfig; globalDb: Db; journal: Journal; clock: Clock;
  intercom: {
    address: SessionAddress;
    ports: IntercomMovePorts;
    /** Read the admitted destination endpoint; missing readiness refuses with a named reason. */
    destinationEndpoint(home: Home): Promise<SessionEndpoint>;
  };
  check(request: MoveRequest): Promise<MoveCheck>;
  power(): Promise<() => Promise<void>>;
  seed(check: MoveCheck): Promise<readonly StoreBarrier[]>;
  prepare(check: MoveCheck, operation: Operation): Promise<PreparedMove>;
  freeze(home: Home, operation: Operation): Promise<FreezeAck>;
  transfer(check: MoveCheck, ack: FreezeAck, operation: Operation): Promise<PreparedMove>;
  verifySource(ack: FreezeAck, workspace: WorkspaceSnapshot): Promise<void>;
  barriers(machine: MachineId, required: readonly StoreBarrier[]): Promise<boolean>;
  replicateHome(home: Home): Promise<void>;
  start(home: Home, prepared: PreparedMove, operation: Operation): Promise<Outcome<HubOperationReadiness>>;
  inspect(home: Home, operation: Operation): Promise<DestinationObservation>;
  retire(home: Home, operation: Operation): Promise<Probe>;
  /** Routes session-unfreeze through authorizeAbort and the participant's intercom abort fence release. */
  unfreeze(home: Home, operation: Operation): Promise<void>;
  /**
   * Participant adapter verifies the current authoritative source home at exactly source.epoch + 2,
   * its separate committed rollback receipt, and destination stopped ownership, durable retirement
   * and permanent cancellation of activation at e+1. Missing proof returns a typed refusal without effects.
   * Atomically advances each affected membership e to e+2 before readmission under that home.
   * Reuses the original process or exact original file, never appends a segment. Unknown ownership stays closed.
   * Order is verify evidence, advance membership, readmit, then reopen intercom. Release only this move's
   * original fence generation under the freshly verified source home e+2 and its committed rollback receipt.
   * Any generation, home or receipt mismatch leaves the fence closed, without partial reopening.
   * The higher-epoch release is guarded separately; ordinary intercom abort/ready cannot bypass these proofs.
   * Same operation retries return the same durable result, including after partial membership advancement.
   */
  readmitSource(source: Home, restoredHome: Home, operation: Operation): Promise<MoveSessionOutcome>;
  cleanup(check: MoveCheck, operation: Operation): Promise<void>;
  /** Best-effort cleanup after a committed cancellation or rollback, retried from its durable queue. */
  abortWorkspace?(check: MoveCheck, operation: Operation): Promise<void>;
  recovery: RecoveryPort;
}
/** A verified local target locator. Presentation composition enriches its own terminal identity. */
export interface PaneTarget {
  machineId: MachineId; alias: null; sessionId: string; homeEpoch: number;
  coreId: string; terminalId: string;
}
export interface PaneActionOutcome {
  status: "complete" | "pending" | "refused"; reason: string; presentation: unknown | null;
}
export interface WorkspaceRestore {
  snapshot: WorkspaceSnapshot; destination: string; repository: string; ports: WorkspaceImportPorts;
  /** Hold participant session ownership locks before the entry point acquires its checkout lock. */
  withBothLocks<T>(effect: () => Promise<T>): Promise<T>;
}
export interface RecoveryPort {
  blockers(): readonly string[];
  /** The private hub journal DB, never a portable global store. */
  revocationDb: Db;
  workspaceRestores?(): Promise<readonly WorkspaceRestore[]>;
  presentReadyTarget(target: PaneTarget): Promise<PaneActionOutcome>;
  homes(machine: MachineId): readonly Home[];
  mirror(sessionId: string, epoch: number): Promise<SessionManifest | null>;
  /** Idempotent session start after validated mirror installation, mapped workspace and local auth.
   * Unknown starts reconcile the same operation rather than launch a second owner. */
  restore(home: Home, mirror: SessionManifest, operation: Operation): Promise<Outcome<HubOperationReadiness>>;
  /** Complete reachable origin inventory. Absent proves a stopped copy, never an offline machine. */
  conflicts(sessionId: string): Promise<readonly { machineId: MachineId; owner: Probe }[]>;
}

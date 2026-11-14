import type { Db } from "@spider/db-core";
import type {
  ApplyReceipt, BatchArtifact, ExportPolicy, Home, JsonObject, MachineId, Probe, ProcessIdentity,
  HubOperationReadiness, Readiness, ReplicaEffects, StoreBarrier, StoreKey,
} from "@spider/db-core/roam/types";
import type { BootstrapOptions, Inventory } from "./provision-contracts";

export interface Peer {
  machineId: MachineId; alias: string; node: string; pi: string; cli: string; core: string; globalRoot: string;
}
export type BootstrapPeer = Pick<Peer, "alias" | "node" | "pi" | "cli" | "globalRoot">;
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

export interface RoamConfig {
  enabled: boolean; role: "hub" | "box"; machineId: MachineId; hubMachineId: MachineId;
  peers: readonly Peer[]; discoveryRoots: readonly string[]; coreUnit: string; syncMs: number; limits: Limits;
}
export interface Operation { id: string; machineId: MachineId; expectedEpoch: number | null; kind: string; args: JsonObject }
export interface Outcome<T> {
  code: 0 | 1 | 2 | 3; reason: string; operationId: string; home: Home | null;
  epoch: number | null; repairCommand: string | null; value: T | null;
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
export interface Journal {
  begin(operation: Operation): { kind: "new" | "pending" | "done"; result: JsonObject | null };
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
export interface HubPorts { config: RoamConfig; sync: SyncService; journal: Journal; clock: Clock; placement: PlacementPort }
export interface Diagnostic { reason: string; severity: "warning" | "block"; repairCommand: string | null; writerEpoch?: number }
export interface HostIntent {
  sessionId: string; epoch: number; desired: "running" | "stopped"; suspended: string | null;
  file: string; cwd: string; moveId: string | null;
}

export interface GitPorts {
  run(cwd: string, argv: readonly string[], options?: { env?: Readonly<NodeJS.ProcessEnv>; stdin?: Buffer }): Promise<Buffer>;
  journal: Journal; limits: Limits; scratch: string; worktreeCommand: readonly string[] | null;
}
export interface WorkspaceSnapshot {
  root: string; repoKey: string; workspaceId: string; moveId: string; stage: "pre" | "final"; head: string;
  branch: string | null; objectFormat: "sha1" | "sha256"; indexTree: string; workingTree: string;
  relativeCwd: string; sparsePatterns: string | null; worktreeConfig: string | null;
  refs: readonly string[]; prerequisites: readonly string[];
  bundle: { kind: "unbundled" } | { kind: "ready"; artifactId: string; byteLength: number };
}
export interface PreparedWorkspace { root: string; snapshot: WorkspaceSnapshot; previous: WorkspaceSnapshot | null; moveId: string }
export interface SessionManifest { file: string; sessionId: string; cwd: string; leaf: string; size: number; sha256: string; historySha256: string; artifactId: string }
export interface FreezeAck {
  operationId: string; sessionId: string; epoch: number; owner: ProcessIdentity | null;
  file: string; cwd: string; leaf: string; size: number; sha256: string; barriers: readonly StoreBarrier[];
}
export interface MoveRequest { operation: Operation; sessionId: string; destinationMachine: MachineId }
export interface MoveResult { home: Home; terminal: string | null; lostPeers: readonly string[]; warnings: readonly string[] }
export interface MoveCheck {
  source: Home; destinationMachine: MachineId; repoKey: string; workspaceId: string; sourceRoot: string;
  sourceFile: string; sourceCwd: string; destinationRoot: string; destinationCwd: string;
  storeKeys: readonly StoreKey[]; lostPeers: readonly string[]; warnings: readonly string[];
}
export interface PreparedMove { workspace: PreparedWorkspace; session: SessionManifest }
export interface DestinationObservation { home: Home; owner: Probe; readiness: HubOperationReadiness | null; launchFailure: string | null; retired: boolean }
export interface MovePorts {
  config: RoamConfig; globalDb: Db; journal: Journal; clock: Clock;
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
  unfreeze(home: Home, operation: Operation): Promise<void>;
  cleanup(check: MoveCheck, operation: Operation): Promise<void>;
  recovery: RecoveryPort;
}
export interface RecoveryPort {
  revocationDb: Db;
  homes(machine: MachineId): readonly Home[];
  mirror(sessionId: string, epoch: number): Promise<SessionManifest | null>;
  restore(home: Home, mirror: SessionManifest, operation: Operation): Promise<Outcome<HubOperationReadiness>>;
  conflicts(sessionId: string): Promise<readonly { machineId: MachineId; owner: Probe }[]>;
}

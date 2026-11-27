import type { Db } from "@spider/db-core";
import type { Home, MachineId, StoreKey } from "@spider/db-core/roam/types";
import type {
  ArtifactManifest, Clock, GitPorts, Journal, Limits, RoamConfig,
  SessionManifest, SyncService, Transport, WorkspaceImportPorts,
  WorkspaceSnapshot,
} from "../contracts";

export type SessionId = string & { readonly __sessionId: unique symbol };
export type RelocateId = string & { readonly __relocateId: unique symbol };

export type HomeIdentity = Omit<Home, "sessionId" | "moveId"> & {
  sessionId: SessionId;
  moveId: RelocateId | null;
};
export type RunningHome = HomeIdentity & { state: "running"; destination: null };
export type StoppedHome = HomeIdentity & { state: "stopped"; destination: null };
export type MovingHome = Omit<HomeIdentity, "moveId"> & {
  state: "moving";
  moveId: RelocateId;
  destination: MachineId;
};
export type SettledHome = RunningHome | StoppedHome;
export type RelocateHome = SettledHome | MovingHome;
export type HomeAdmission =
  | { kind: "unmanaged" }
  | { kind: "managed"; home: RelocateHome | null }
  | { kind: "unavailable" };

export type RelocateStep =
  | "check" | "mark-moving" | "stop-source" | "pull-source"
  | "push-destination" | "install-destination" | "commit-home"
  | "start-destination" | "confirm";

export type V0RefusalCode =
  | "invalid-arguments" | "mac-required" | "replication-disabled"
  | "session-not-found" | "ambiguous-session" | "machine-not-found"
  | "home-unavailable" | "home-conflict" | "move-in-progress"
  | "source-unreachable" | "destination-unreachable"
  | "destination-not-provisioned" | "repo-unmapped"
  | "unsupported-workspace" | "destination-dirty"
  | "confirmation-required" | "destination-copy-missing"
  | "stop-timeout" | "sync-failed" | "transfer-failed"
  | "install-failed" | "start-pending" | "journal-unavailable"
  // lane 1: adapters-C1
  | "session-busy";

export interface V0Refusal {
  code: V0RefusalCode;
  message: string;
  nextStep: string;
}
export type V0Result<T> = { ok: true; value: T } | { ok: false; refusal: V0Refusal };

export type HomeCasResult =
  | { kind: "applied" | "already-applied"; home: RelocateHome }
  | { kind: "conflict"; home: RelocateHome | null };
export interface HomeStore {
  read(sessionId: SessionId): Promise<RelocateHome | null>;
  initialize(sessionId: SessionId, sourceMachine: MachineId): Promise<RunningHome>;
  compareAndSwap(expected: RelocateHome, next: RelocateHome): Promise<HomeCasResult>;
  list(): Promise<readonly RelocateHome[]>;
}
export interface HomeStoreOptions { db: Db; hubMachineId: MachineId; localMachineId: MachineId }

export interface SessionPlacement {
  sessionId: SessionId;
  machineId: MachineId;
  repoKey: string;
  workspaceId: string;
  repository: string;
  cwd: string;
  file: string;
  stores: readonly StoreKey[];
  historyMachine: MachineId;
}
export interface RelocateRequest { sessionId: SessionId; destinationMachine: MachineId }
export interface RelocatePlan {
  moveId: RelocateId;
  source: SettledHome;
  sourcePlacement: SessionPlacement;
  destinationPlacement: SessionPlacement;
  destinationPrerequisites: readonly string[];
  startedAt: number;
}
export interface CapturedSession {
  session: SessionManifest;
  workspace: WorkspaceSnapshot & { bundle: { kind: "ready"; artifactId: string; byteLength: number } };
  transcriptArtifact: ArtifactManifest;
  bundleArtifact: ArtifactManifest;
}
export interface InstalledSession { placement: SessionPlacement; session: SessionManifest }
export interface RelocateSuccess {
  moveId: RelocateId | null;
  home: RunningHome;
  placement: SessionPlacement;
  terminal: string;
  disposition: "relocated" | "already-home" | "undone";
}
export type RelocateOutcome =
  | { ok: true; value: RelocateSuccess }
  | { ok: false; refusal: V0Refusal; step: RelocateStep; home: RelocateHome | null; moveId: RelocateId | null };

export interface RelocateCheckpoint {
  plan: RelocatePlan;
  completed: readonly RelocateStep[];
  captured: CapturedSession | null;
  installed: InstalledSession | null;
  terminal: string | null;
  result: RelocateSuccess | null;
}
export interface RelocateJournal {
  load(moveId: RelocateId): Promise<RelocateCheckpoint | null>;
  save(checkpoint: RelocateCheckpoint): Promise<void>;
}

export interface SessionMachinePorts {
  locate(machineId: MachineId, sessionId: SessionId): Promise<V0Result<SessionPlacement>>;
  publishHome(home: RelocateHome, machineId: MachineId): Promise<V0Result<void>>;
  activate(home: RunningHome, placement: SessionPlacement): Promise<V0Result<void>>;
  start(home: RunningHome, placement: SessionPlacement): Promise<V0Result<{ terminal: string }>>;
  confirm(home: RunningHome, placement: SessionPlacement): Promise<V0Result<{ terminal: string }>>;
}
export interface RelocatePorts extends SessionMachinePorts {
  homes: HomeStore;
  journal: RelocateJournal;
  newMoveId(): RelocateId;
  withSession<T>(sessionId: SessionId, run: () => Promise<T>): Promise<T>;
  initialSource(sessionId: SessionId): Promise<V0Result<MachineId>>;
  check(request: RelocateRequest, source: SettledHome, moveId: RelocateId): Promise<V0Result<RelocatePlan>>;
  stopSource(plan: RelocatePlan, moving: MovingHome): Promise<V0Result<void>>;
  pullSource(plan: RelocatePlan): Promise<V0Result<CapturedSession>>;
  pushDestination(plan: RelocatePlan, captured: CapturedSession): Promise<V0Result<void>>;
  installDestination(plan: RelocatePlan, captured: CapturedSession, home: RunningHome): Promise<V0Result<InstalledSession>>;
}

export interface SetHomeRequest {
  sessionId: SessionId;
  destinationMachine: MachineId;
  force: boolean;
  confirmation: string;
}
export interface SetHomePorts extends SessionMachinePorts {
  homes: HomeStore;
  newMoveId(): RelocateId;
  withSession<T>(sessionId: SessionId, run: () => Promise<T>): Promise<T>;
}
export interface SupervisorEntry { sessionId: SessionId; home: RelocateHome | null; placement: SessionPlacement | null }
export type SessionOwner = { kind: "free" } | { kind: "live"; pid: number; terminal: string | null } | { kind: "unknown" };
export interface HomeSupervisorPorts {
  machineId: MachineId;
  clock: Clock;
  entries(): Promise<readonly SupervisorEntry[]>;
  owner(sessionId: SessionId): Promise<SessionOwner>;
  stop(sessionId: SessionId): Promise<V0Result<void>>;
  activate: SessionMachinePorts["activate"];
  start: SessionMachinePorts["start"];
  report(sessionId: SessionId | null, refusal: V0Refusal): void;
}
export interface HomeSupervisor { tick(): Promise<void>; start(): void; stop(): Promise<void> }

export interface RelocateAdapterOptions {
  root: string;
  config: RoamConfig;
  globalDb: Db;
  homes: HomeStore;
  journal: Journal;
  sync: SyncService;
  transport: Transport;
  clock: Clock;
  git: GitPorts;
  workspaceImport: WorkspaceImportPorts;
  limits: Limits;
}
export interface RelocateAdapters {
  ports: RelocatePorts;
  supervisor: HomeSupervisorPorts;
  setHome: SetHomePorts;
  dispose(): Promise<void>;
}

export type V0PublicControl =
  | { kind: "relocate"; session: string; machine: string }
  | { kind: "set-home"; session: string; machine: string; force: true; confirmation: string | null };
export interface V0ControlServices {
  relocate(request: RelocateRequest): Promise<RelocateOutcome>;
  setHome(request: SetHomeRequest): Promise<V0Result<RunningHome>>;
}
export interface V0CommandIO {
  out(text: string): void;
  err(text: string): void;
  confirmation(prompt: string): Promise<string | null>;
}

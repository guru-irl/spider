import type { Diagnostic, Journal, Limits, Operation, Peer, Transport } from "./contracts";
import type { AuthPorts } from "./auth";
import type { SelectedFile, SelectedFileMetadata, SettingsDestinationPreview, SettingsKeyDigest, AgentPrivateModeRepair } from "./selected-files";
import type { IntercomReadiness } from "./intercom-readiness";
import type { RevocationGate } from "./cause-codes";

export const MISSING_NODE_TYPE_STRIPPING_MESSAGE = "Node's stripTypeScriptTypes feature is unavailable; provisioning needs a Node version that provides it.";

export type FileLimit = number | "unlimited" | null;
export interface FileStatus { present: boolean; readable: boolean; modeSafe: boolean }
export interface ExecutableStatus extends FileStatus { executable: boolean }
export interface ConfiguredCli { name: string; executable: string; authFile: string | null }
export interface CoreFence { local: string; remote: string }
export interface AgentDirectoryProbe { status: "default" | "custom" | "unknown"; core: CoreFence }
export interface BootstrapOptions { timeoutMs: number; maxBytes: number; configuredClis?: readonly ConfiguredCli[]; coreUnit?: string; expectedCore?: CoreFence }
export type RoamingInventory =
  | { rootExists: null; rootSafe: false; identityExists: null; machineId: null }
  | { rootExists: false; rootSafe: true; identityExists: false; machineId: null }
  | { rootExists: true; rootSafe: false; identityExists: true | null; machineId: null }
  | { rootExists: true; rootSafe: true; identityExists: false; machineId: null }
  | { rootExists: true; rootSafe: true; identityExists: true; machineId: Peer["machineId"] | null };
export interface Inventory {
  platform: string; kernel: string; nodeVersion: string; nodeAbi: string; gitVersion: string | null;
  /** rootSafe covers existing path components and modes; null existence means inspection was unsafe. */
  roaming: RoamingInventory;
  systemdUser: boolean; linger: boolean | null;
  core: { unit: string | null; unitExists: boolean; unitOwned: boolean; transient: boolean | null; socketExists: boolean; socketOwned: boolean };
  pi: string | null; piVersion: string | null;
  softNofile: FileLimit; hardNofile: FileLimit; inotifyInstances: number | null; inotifyWatches: number | null;
  diskFreeBytes: number | null;
  spider: { installed: boolean; version: string | null; nativeModuleReady: boolean };
  cli: { gh: boolean; gitIdentity: boolean; configured: readonly { executable: ExecutableStatus | null; auth: FileStatus | null }[] };
  auth: { pi: FileStatus; gh: FileStatus; ghSignedIn: boolean | null };
}

/** Null means an older completed operation did not record the count. */
export interface ProvisionResult { hostingReady: boolean; permissionTightenings: number | null; privateModeRepairs?: readonly AgentPrivateModeRepair[] }
export type ProvisionRequest = {
  operation: Operation; peer: Peer; selected: readonly string[]; includeAuth: boolean; requireDestinationAuth?: boolean; confirmedProviders: readonly string[];
  expectedAuthBytes?: number; expectedFiles?: readonly SelectedFileMetadata[]; expectedSelectionDigest?: string; replaceCorePin?: boolean;
};
export interface ProvisionVerification extends IntercomReadiness {
  corePin: import("./enrollment").CorePinStatus;
  piSignedIn: boolean; nativeSqlite: boolean; extensionLoaded: boolean; exactSession: boolean; privateModes: boolean;
  bundledIntercom: boolean;
}
export interface IntercomDoctorState {
  connector: "ready" | "missing" | "unknown"; login: "ready" | "required" | "unknown";
  tunnel: "hosted" | "unhosted" | "unknown"; peerPort: "reachable" | "unreachable" | "unknown"; hostKey: "match" | "changed" | "unknown";
  key: "ready" | "missing" | "unsafe" | "unknown"; route: "ready" | "missing" | "unknown";
  extension: "ready" | "missing" | "duplicate" | "unknown"; broker: "ready" | "legacy" | "unknown";
  feature: "ready" | "missing" | "unknown"; link: "live" | "down" | "unknown";
  pendingRevocations: readonly { pairId: string; reason: IntercomRevocationCleanupReason; revocationGates?: readonly RevocationGate[] }[];
}
export interface DoctorPorts {
  transport: Transport; journal: Journal; limits: Limits; configuredClis?: readonly ConfiguredCli[]; coreUnit?: string;
  /** Inspect only; never install, sign in, start, or repair. */
  inspectIntercom?(): Promise<IntercomDoctorState>;
  confirm(target: string, providers: readonly string[]): Promise<boolean>;
  systemd: { unitDir: string; systemctl(argv: readonly string[]): Promise<void> };
  resources(): Promise<Pick<Inventory, "softNofile" | "hardNofile" | "inotifyInstances" | "inotifyWatches">>;
  bootId(): Promise<string>;
  release: { pi: "1.2.0"; intercom: "spider-owned"; spiderSha256: string; nodeRange: "22.23.4 || 26.4.0" };
  verifyPeer?(): Promise<ProvisionVerification>;
}
export interface ProvisionPreview {
  target: string; machineId: string; inventory: Inventory;
  destinations: ProvisionDestination & { globalRoot: string; pi: string };
  selectedFiles: readonly SelectedFileMetadata[]; settingsKeys: readonly string[]; settingsFingerprint: string | null;
  providers: readonly string[]; warnings: readonly string[];
}
export interface ProvisionDestination { home: string; agentDir: string; npmPrefix: string; supervisor: string }

export interface IntercomEnrollmentPlan {
  pairId: string; source: Peer; target: Peer; edgeEpoch: string;
  connector: { tunnelId: string; remotePort: number; session: string };
}
export interface IntercomSshHostKey { type: string; base64: string }
export interface IntercomEnrollmentPair extends IntercomEnrollmentPlan {
  sshUser: string; hostKey: IntercomSshHostKey; hostKeyAlias: string;
}
export interface IntercomEnrollmentRequest { operation: Operation; pairs: readonly IntercomEnrollmentPlan[] }
export interface IntercomEnrollmentPreview {
  consent: string;
  pairs: readonly { pairId: string; source: Pick<Peer, "machineId" | "alias">; target: Pick<Peer, "machineId" | "alias">;
    edgeEpoch: string; connector: IntercomEnrollmentPair["connector"] }[];
}
export interface IntercomMachinePin { machineId: string; coreId: string }
export interface IntercomPairPins { source: IntercomMachinePin; target: IntercomMachinePin }
export interface IntercomEnrollmentPorts {
  journal: Journal; actor: string; now(): number;
  withLock<T>(work: () => Promise<T>): Promise<T>;
  present(preview: IntercomEnrollmentPreview): Promise<void>;
  approve(): Promise<boolean>;
  /** Read authoritative pair fences without running connector or credential setup. */
  readPairFences(pairs: readonly IntercomEnrollmentPlan[]): Promise<Record<string, string | null>>;
  /** Clear only the exact fence seen before this independently recorded human approval. */
  approvePair(pair: IntercomEnrollmentPair, consent: { operationId: string; graphDigest: string; expectedFenceId: string | null }, pins: IntercomPairPins): Promise<void>;
  notify(peers: readonly Peer[]): Promise<void>;
  pinMachine(machine: Peer): Promise<IntercomMachinePin>;
  warn(machineId: string, reason: "link-down"): Promise<void>;
  /** Each ensure operation reconciles its own effect after a lost reply. */
  registerPair(pair: IntercomEnrollmentPlan): Promise<void>;
  checkConnector(machine: Peer, pin: IntercomMachinePin): Promise<"ready" | "missing" | "not-signed-in" | "offline" | "invalid">;
  /** Inspect a presented system host key and the destination account through the pinned peer. */
  inspectSshHost(pair: IntercomEnrollmentPlan, pins: IntercomPairPins): Promise<{ targetMachineId: string; sshUser: string; hostKeys: IntercomSshHostKey[] }>;
  bindPair(pair: IntercomEnrollmentPair, pins: IntercomPairPins): Promise<void>;
  hostConnector(pair: IntercomEnrollmentPair, pins: IntercomPairPins): Promise<"ready" | "unhosted" | "offline" | "not-pair-scoped">;
  connect(pair: IntercomEnrollmentPair, pins: IntercomPairPins): Promise<"ready" | "offline" | "peer-port-unreachable">;
  writeKnownHost(pair: IntercomEnrollmentPair, pins: IntercomPairPins): Promise<void>;
  ensureKey(pair: IntercomEnrollmentPair, pins: IntercomPairPins): Promise<{ publicKey: string; privateMode: number; privateOwned: boolean }>;
  authorize(pair: IntercomEnrollmentPair, line: string, pins: IntercomPairPins): Promise<void>;
  addMachine(pair: IntercomEnrollmentPair, argv: readonly string[], pins: IntercomPairPins): Promise<void>;
  verifyTransport(pair: IntercomEnrollmentPair, pins: IntercomPairPins): Promise<{ sourceMachineId: string; targetMachineId: string;
    connector: boolean; key: boolean; route: boolean }>;
  publishPair(pair: IntercomEnrollmentPair, pins: IntercomPairPins): Promise<void>;
  verifyPair(pair: IntercomEnrollmentPair, pins: IntercomPairPins): Promise<{ sourceMachineId: string; targetMachineId: string;
    connector: boolean; key: boolean; route: boolean; federation: boolean }>;
}

export type IntercomRevocationCleanupReason = "intercom-revocation-unconfirmed" | "intercom-revocation-peer-unreachable" | "intercom-revocation-identity-mismatch" |
  "intercom-revocation-shared-jobs" | "intercom-revocation-access-open" | "intercom-revocation-verification-pending" |
  "intercom-revocation-remote-fence-pending" | "intercom-revocation-cleanup-pending";
export interface IntercomClosureEvidence { sourceMachineId: string; targetMachineId: string; localMachineId: string;
  edgeEpoch: string; fenceId: string; fenceDurable: boolean; exchanges: "closed" | "active" | "unknown"; inFlight: number }
export interface IntercomHostStopEvidence { machineId: string; unit: string; activeState: "inactive" | "failed" | "active" | "unknown";
  mainPid: number; mainStartIdentity: string; mainProcess: "exited" | "live" | "unknown"; controlGroup: "empty" | "nonempty" | "unknown"; killMode: "control-group" }
export interface IntercomRevocationPins { source: IntercomMachinePin | null; target: IntercomMachinePin }
export interface IntercomRevocationPorts {
  /** Explicit recovery targets an existing historical fence, never a replacement fence. */
  fenceEpoch?: string;
  withLock<T>(work: () => Promise<T>): Promise<T>;
  getPair(pairId: string): Promise<{ pair: IntercomEnrollmentPair; state: "pending" | "active" | "revoking" | "revoked";
    cleanupReason?: IntercomRevocationCleanupReason | null; revocationEpoch?: string; fenceId?: string | null } | null>;
  /** Persist the local fence before refusing and joining both live exchange directions. */
  fenceAndClose(pair: IntercomEnrollmentPair): Promise<IntercomClosureEvidence>;
  fenceRemote(pair: IntercomEnrollmentPair, pins: IntercomRevocationPins, fenceId: string): Promise<IntercomClosureEvidence>;
  /** Missing or incomplete host/cgroup evidence must never authorize key or route removal. */
  stopPairHost?(pair: IntercomEnrollmentPair, pins: IntercomRevocationPins, fenceId: string): Promise<IntercomHostStopEvidence | null>;
  stopPairConnect?(pair: IntercomEnrollmentPair, pins: IntercomRevocationPins, fenceId: string): Promise<boolean>;
  beginRevocation(pair: IntercomEnrollmentPair, fenceId: string): Promise<void>;
  notify(peers: readonly Peer[]): Promise<void>;
  pinMachine(machine: Peer): Promise<IntercomMachinePin | null>;
  removeAuthorizedKey(pair: IntercomEnrollmentPair, pins: IntercomRevocationPins): Promise<void>;
  /** Remove a route only when its shared users are atomically known to be idle. */
  removeMachineIfIdle(pair: IntercomEnrollmentPair, pins: IntercomRevocationPins): Promise<"removed" | "shared-jobs" | "route-mismatch" | "unknown">;
  verifyRevocation(pair: IntercomEnrollmentPair, pins: IntercomRevocationPins): Promise<{ sourceMachineId: string; targetMachineId: string;
    edgeEpoch: string; keyAbsent: boolean; routeAbsent: boolean; exchanges: "closed" | "active" | "unknown";
    authenticatedConnections: "closed" | "active" | "unknown" }>;
  /** Persist completion and any still-required remote cleanup for read-only doctor. */
  finishRevocation(pair: IntercomEnrollmentPair, cleanupReason: IntercomRevocationCleanupReason | null, revocationGates?: readonly RevocationGate[]): Promise<void>;
}

export interface ProvisionPorts extends DoctorPorts {
  hubMachineId: string;
  assertCorePinReplaceIdle(peer: Peer): Promise<void>;
  source: { agentRoot: string; releaseFile: string; piProviders: readonly string[] };
  destination: ProvisionDestination;
  withPeerLock<T>(machineId: Peer["machineId"], work: () => Promise<T>): Promise<T>;
  present(preview: ProvisionPreview): Promise<void>;
  report(diagnostics: readonly Diagnostic[]): Promise<void>;
  verifyPeer(): Promise<ProvisionVerification>;
  persistPeer(peer: Peer): Promise<void>;
  /** A bounded count from this operation's private installer receipt; no paths. */
  permissionTightening(peer: Peer): Promise<number>;
  /** Under the hub configuration lock, set the box flag only when both hub and readiness permit it.
   * A null readiness is a completed retry: clear a disabled hub's flag, but never enable from stale evidence. */
  setParticipation(peer: Peer, ready: boolean | null): Promise<void>;
  bootstrap: {
    probeAgentDirectory(peer: Peer, home: string): Promise<AgentDirectoryProbe>;
    previewSettings(peer: Peer, home: string, entries: readonly SettingsKeyDigest[], maximum: number, core: CoreFence, selectedPaths?: readonly string[]): Promise<SettingsDestinationPreview>;
    claimIdentity(peer: Peer, operationId: string, core: CoreFence): Promise<{ machineId: string; coreId: string }>;
  };
  systemd: DoctorPorts["systemd"] & { writeUnit(name: string, contents: string): Promise<void> };
  transfer: {
    repairAgentDirectory(peer: Peer): Promise<readonly AgentPrivateModeRepair[]>;
    reconcilePairUnits(peer: Peer): Promise<void>;
    enroll(peer: Peer, hubMachineId: string, coreUnit: string, replaceCorePin?: boolean): Promise<import("./enrollment").CorePinReplacement | void>;
    setEnabled(peer: Peer, hubMachineId: string, enabled: boolean): Promise<void>;
    cleanupSecrets(peer: Peer): Promise<void>;
    installRelease(peer: Peer, input: { bytes: Buffer; sha256: string; npmPrefix: string; globalRoot: string; pi: "1.2.0"; intercom: "spider-owned" }):
      Promise<{ pi: string; cli: string; supervisor: string }>;
    installFiles(peer: Peer, files: readonly SelectedFile[], expectedSettingsFingerprint?: string): Promise<void>;
    /** Credential file staging is removed on success and failure. */
    installCredentialFiles(peer: Peer, files: readonly SelectedFile[], providers: readonly string[], expectedSettingsFingerprint?: string): Promise<void>;
    auth(peer: Peer, operationId: string): AuthPorts;
    switchover(peer: Peer, operationId: string): Promise<{ status: string }>;
  };
}

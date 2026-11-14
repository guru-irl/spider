import type { Diagnostic, Journal, Limits, Operation, Peer, Transport } from "./contracts";
import type { AuthPorts } from "./auth";
import type { SelectedFile, SelectedFileMetadata, SettingsDestinationPreview, SettingsKeyDigest } from "./selected-files";

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
  core: { unit: string | null; unitExists: boolean; unitOwned: boolean; socketExists: boolean; socketOwned: boolean };
  pi: string | null; piVersion: string | null;
  softNofile: FileLimit; hardNofile: FileLimit; inotifyInstances: number | null; inotifyWatches: number | null;
  diskFreeBytes: number | null;
  spider: { installed: boolean; version: string | null; nativeModuleReady: boolean };
  cli: { gh: boolean; gitIdentity: boolean; configured: readonly { executable: ExecutableStatus | null; auth: FileStatus | null }[] };
  auth: { pi: FileStatus; gh: FileStatus; ghSignedIn: boolean | null };
}

export type ProvisionRequest = {
  operation: Operation; peer: Peer; selected: readonly string[]; includeAuth: boolean; confirmedProviders: readonly string[];
  expectedAuthBytes?: number; expectedFiles?: readonly SelectedFileMetadata[]; expectedSelectionDigest?: string;
};
export interface ProvisionVerification {
  piSignedIn: boolean; nativeSqlite: boolean; extensionLoaded: boolean; exactSession: boolean; privateModes: boolean;
  bundledIntercom: boolean; intercomUnique: boolean; legacyDrained: boolean; federation: boolean;
}
export interface DoctorPorts {
  transport: Transport; journal: Journal; limits: Limits; configuredClis?: readonly ConfiguredCli[]; coreUnit?: string;
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
export interface ProvisionPorts extends DoctorPorts {
  hubMachineId: string;
  source: { agentRoot: string; releaseFile: string; piProviders: readonly string[] };
  destination: ProvisionDestination;
  withPeerLock<T>(machineId: Peer["machineId"], work: () => Promise<T>): Promise<T>;
  present(preview: ProvisionPreview): Promise<void>;
  report(diagnostics: readonly Diagnostic[]): Promise<void>;
  verifyPeer(): Promise<ProvisionVerification>;
  persistPeer(peer: Peer): Promise<void>;
  bootstrap: {
    probeAgentDirectory(peer: Peer, home: string): Promise<AgentDirectoryProbe>;
    previewSettings(peer: Peer, home: string, entries: readonly SettingsKeyDigest[], maximum: number, core: CoreFence): Promise<SettingsDestinationPreview>;
    claimIdentity(peer: Peer, operationId: string, core: CoreFence): Promise<{ machineId: string; coreId: string }>;
  };
  systemd: DoctorPorts["systemd"] & { writeUnit(name: string, contents: string): Promise<void> };
  transfer: {
    enroll(peer: Peer, hubMachineId: string): Promise<void>;
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

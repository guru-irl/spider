import type { Journal, Limits, Operation, Peer, Transport } from "./contracts";

export type FileLimit = number | "unlimited" | null;
export interface FileStatus { present: boolean; readable: boolean; modeSafe: boolean }
export interface ExecutableStatus extends FileStatus { executable: boolean }
export interface ConfiguredCli { name: string; executable: string; authFile: string | null }
export interface BootstrapOptions { timeoutMs: number; maxBytes: number; configuredClis?: readonly ConfiguredCli[]; coreUnit?: string }
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
};
export interface ProvisionPorts {
  transport: Transport; journal: Journal; limits: Limits; configuredClis?: readonly ConfiguredCli[]; coreUnit?: string;
  confirm(target: string, providers: readonly string[]): Promise<boolean>;
  systemd: { unitDir: string; systemctl(argv: readonly string[]): Promise<void> };
  resources(): Promise<Pick<Inventory, "softNofile" | "hardNofile" | "inotifyInstances" | "inotifyWatches">>;
  bootId(): Promise<string>;
  release: { pi: "1.2.0"; intercom: "spider-owned"; spiderSha256: string; nodeRange: "22.23.4 || 26.4.0" };
}

export interface SwitchoverInput {
  operationId: string; settingsFiles: string[]; legacyRoots: string[]; release: string; journalFile: string;
}
export interface SwitchoverResult {
  status: 'migration-pending'; reason: 'legacy-broker-quiescence-unproved'; release: string; settingsFiles: string[]; retainedLegacyRoots: string[];
}
export interface SwitchoverPorts {
  read(file: string): Promise<string | null>;
  writeAtomic(file: string, text: string): Promise<void>;
  compareAndSwap(file: string, expected: string, next: string): Promise<boolean>;
  backup(file: string, text: string): Promise<void>;
  validateRelease(release: string): Promise<void>;
  activeRelease(): Promise<string | null>;
  activate(release: string | null): Promise<void>;
}
export function migrateIntercomSettings(text: string, legacyRoots: string[], directory?: string): string;
export function applyIntercomSwitchover(input: SwitchoverInput, ports: SwitchoverPorts): Promise<SwitchoverResult>;
export function filesystemSwitchoverPorts(activeFile: string): SwitchoverPorts;

// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import type { ConsoleId, CoreId, CoreIdentity, Generation, Owner, OwnerPlacement, PaneId, RunId, SessionId, SpaceId, TerminalAddress, TerminalId, TerminalSummary } from '../contracts.js';
export type PanePlace = 'tab' | 'right' | 'down';
export interface MachineChoice {
  key: string; alias: string | null; label: string;
  coreId: CoreId | null; machineId: string | null; state: 'connected' | 'disconnected';
}
export interface PaneTarget {
  coreId: CoreId; terminalId: TerminalId; address: TerminalAddress;
  createdMs: number; identityLabels: Readonly<Record<string, string>>;
  alias: string | null; machineId: string | null;
  kind: 'terminal' | 'session' | 'subagent' | 'console';
  sessionId: SessionId | null; generation: Generation | null;
  homeEpoch: number | null; runId: RunId | null; consoleId: ConsoleId | null;
  name: string | null; cwd: string | null;
}
export interface PaneTerminalFacts {
  terminal: TerminalSummary; currentCwd: string | null; createdMs: number;
  title: string; app: string | null; status: string | null;
  identityLabels: Readonly<Record<string, string>>;
}
export interface PaneOpenIntent {
  operationId: string; space: SpaceId; place: PanePlace; anchor: OwnerPlacement | null;
  program: { kind: 'shell' } | { kind: 'agent'; key: string };
}
export interface FolderChoice { cwd: string | null; reason: 'focused' | 'mapped' | 'home' }
export type PaneSlot = Pick<OwnerPlacement, 'space' | 'tab'> & { pane: PaneId | null };
export interface PanePresentation {
  id: string; revision: number; mode: 'native' | 'proxy';
  role: 'shell' | 'agent' | 'subagent' | 'console'; target: PaneTarget;
  proxy: TerminalAddress | null; slot: PaneSlot | null;
  visibility: 'visible' | 'parked' | 'closing' | 'ended';
  launch: 'none' | 'claimed' | 'acknowledged' | 'uncertain'; closeOperationId: string | null;
  proxyLaunchAttempts?: number;
  proxyOperationId?: string;
  conversion: ({ source: OwnerPlacement; sourceFocused: boolean } & (
    { state: 'waiting-readiness'; destination: null } |
    { state: 'waiting-focus'; destination: PaneTarget }
  )) | null;
}
export interface PaneActionOutcome {
  status: 'complete' | 'pending' | 'refused'; reason: string; presentation: PanePresentation | null;
}
export interface FolderMapPort {
  matchingCheckout(source: PaneTarget, machine: MachineChoice): Promise<{ root: string; relativeCwd: string } | null>;
}
export interface AppPaneCapabilities {
  backgroundTabCreation: boolean; explicitTargetSwap: boolean; noFocusConversion: boolean; commandDigest: string;
}
export interface PaneConsoleRow { consoleId: ConsoleId; machineKey: string; name: string | null; target: PaneTarget | null }
interface PaneAgentRowBase {
  sessionId: SessionId; name: string | null; status: string; updatedAt: number; machineKey: string;
}
export type PaneAgentRow = PaneAgentRowBase & (
  | { generation: Generation; owner: Owner; target: PaneTarget; unavailableReason: null;
      children: readonly { runId: RunId; name: string | null; status: string }[]; consoles: readonly PaneConsoleRow[] }
  | { generation: Generation | null; owner: null; target: null; unavailableReason: 'not-in-hc';
      children: readonly []; consoles: readonly [] }
);
export interface PaneInventoryPage { version: 1; rows: readonly PaneAgentRow[]; next: string | null; complete: boolean }
interface RequestBase { version: 1; operationId: string }
interface PresentationRequest extends RequestBase { presentationId: string; expectedRevision: number }
/** Target-bearing handoff and close requests still require source-owned validation before effects. */
export type PaneServiceRequest =
  | (RequestBase & { op: 'snapshot' })
  | (RequestBase & { op: 'ready-outcome'; presentationId: string })
  | (RequestBase & { op: 'open'; intent: PaneOpenIntent; machineKey: string; coreId: CoreId; machineId: string | null })
  | (PresentationRequest & { op: 'open-existing'; targetIncarnation: Pick<PaneTarget, 'coreId' | 'terminalId' | 'createdMs'> })
  | (RequestBase & { op: 'open-existing'; sessionId: SessionId; generation: Generation; slot: PaneSlot | null })
  | (RequestBase & { op: 'open-auxiliary'; sessionId: SessionId; generation: Generation; mode?: 'automatic' | 'explicit'; view: { kind: 'subagent'; runId: RunId } | { kind: 'console'; machineKey: string; consoleId: ConsoleId } })
  | (PresentationRequest & { op: 'move'; slot: PaneSlot })
  | (PresentationRequest & { op: 'park' })
  | (PresentationRequest & { op: 'close-confirmed'; target: PaneTarget })
  | (PresentationRequest & { op: 'prepare-handoff'; sessionId: SessionId; generation: Generation; homeEpoch: number })
  | (PresentationRequest & { op: 'present-ready'; target: PaneTarget });
/** A private, bounded snapshot. Render adapters must project away source Owner fields. */
export interface PaneServiceSnapshot {
  version: 1; kind: 'snapshot'; complete: boolean; omittedRows: number; revision: number; machines: readonly MachineChoice[];
  presentations: readonly PanePresentation[]; rows: readonly PaneAgentRow[];
  targetFacts: Readonly<Record<string, PaneTerminalFacts>>;
}
export type PaneServiceReply = PaneServiceSnapshot | { version: 1; kind: 'outcome'; outcome: PaneActionOutcome };
export interface LegacySlot { session: string; space: string; tab: string }
export interface LegacyLaunchFailure { attempts: number; retryable: boolean }
export interface LegacyAttempt {
  session: string; remote: string; core: string; proxy: string | null;
  closed: boolean; localOwners: string[]; failure?: LegacyLaunchFailure;
}
export interface LegacyPlacementState { version: 1; slots: LegacySlot[]; attempts: LegacyAttempt[] }
export interface ManualPaneChoice { session: SessionId; space: SpaceId; tab: import('../contracts.js').TabId; revision: number }
export interface PaneTargetLaunch {
  operationId: string; coreId: CoreId; machineKey: string; intent: PaneOpenIntent; folder: FolderChoice;
  state: 'claimed' | 'not-started' | 'uncertain' | 'observed'; target: PaneTarget | null; failure: string | null;
}
export interface PlacementState {
  version: 2; revision: number; slots: LegacySlot[]; attempts: LegacyAttempt[];
  presentations: PanePresentation[]; choices: ManualPaneChoice[]; launches: PaneTargetLaunch[];
}
export interface PanePlacementStore {
  read(): Promise<PlacementState>;
  update(change: (state: PlacementState) => PlacementState): Promise<PlacementState>;
}
export interface PaneServiceConnectOptions {
  root: string; identity: CoreIdentity; startIfMissing: boolean;
  launchHelper(operationId: string): Promise<TerminalAddress>;
  probeHelper(address: TerminalAddress): Promise<TerminalSummary>;
}
export interface PortablePaneFolder { repoKey: string; workspaceId: string; relativeCwd: string }
export type ResolvedPaneFolder =
  | { status: 'no-mapping' | 'unavailable'; cwd: null; exists: null }
  | { status: 'missing'; cwd: string; exists: false }
  | { status: 'mapped'; cwd: string; exists: true };
export type RemotePaneRequest =
  | { version: 1; op: 'handshake'; protocol: number; buildDigest: string }
  | { version: 1; op: 'list'; cursor: string | null }
  | { version: 1; op: 'locate-folder'; cwd: string }
  | { version: 1; op: 'resolve-folder'; repoKey: string; workspaceId: string; relativeCwd: string }
  | { version: 1; op: 'launch-viewer'; sessionId: SessionId; generation: Generation; runId: RunId; leaseId: string }
  | { version: 1; op: 'renew-viewers'; leases: { leaseId: string; generation: Generation }[] }
  | { version: 1; op: 'stop-viewer'; leaseId: string }
  | { version: 1; op: 'open-console'; sessionId: SessionId; generation: Generation; machineKey: string; consoleId: ConsoleId; leaseId: string }
  | { version: 1; op: 'close-session'; sessionId: SessionId; generation: Generation; homeEpoch: number; operationId: string };
export type RemotePaneReply =
  | { version: 1; op: 'handshake'; protocol: number; buildDigest: string }
  | { version: 1; op: 'list'; page: PaneInventoryPage }
  | { version: 1; op: 'locate-folder'; folder: PortablePaneFolder | null; unavailable: boolean }
  | { version: 1; op: 'resolve-folder'; result: ResolvedPaneFolder }
  | { version: 1; op: 'launch-viewer' | 'open-console'; target: PaneTarget | null }
  | { version: 1; op: 'renew-viewers' | 'stop-viewer' | 'close-session'; outcome: PaneActionOutcome };

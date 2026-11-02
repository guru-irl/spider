// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import type { Language } from '@spider/context';
export type { Language } from '@spider/context';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
type Id<K extends string> = string & { readonly __kind: K };
export type CoreId = Id<'core'>;
export type TerminalId = Id<'terminal'>;
export type TerminalAddress = Id<'terminal-address'>;
export type SessionId = Id<'session'>;
export type MachineName = Id<'machine'>;
export type JobId = Id<'job'>;
export type RunId = Id<'run'>;
export type Generation = Id<'generation'>;
export type SpaceId = Id<'space'>;
export type TabId = Id<'tab'>;
export type PaneId = Id<'pane'>;
export interface Disposable { dispose(): void | Promise<void> }
export type AcceptanceMode = "fake" | "hc" | "app";
export interface PendingCounts { queued: number; running: number; paused: number }
export interface CoreIdentity { coreId: CoreId; socket: string; sessionNamespace: string }
export interface TerminalIdentity extends CoreIdentity { terminalId: TerminalId; address: TerminalAddress }
export interface Owner { sessionId: SessionId; generation: Generation; terminal: TerminalIdentity; cwd: string; sessionFile: string | null; name: string | null }
export type ProgramState = 'idle' | 'working' | 'blocked' | 'done' | 'error';
export interface ProgramStatus { state: ProgramState; msg?: string; [key: string]: unknown }
export interface TerminalSummary {
  address: TerminalAddress; parent: TerminalAddress | null; labels: Readonly<Record<string, string>>;
  state: 'live' | 'finished'; status: ProgramStatus | null; exitCode: number | null;
  reason: string | null; signal: number | null; finishedAt: number | null;
}
export interface TerminalHandle { address: TerminalAddress; coreId: CoreId }
export interface HcRunRequest {
  name?: string;
  argv: readonly string[]; cwd: string | null; on?: MachineName; labels: Readonly<Record<string, string>>;
  parent?: TerminalAddress | null; outliveParent: boolean; background: boolean; noNotify: true;
}
export interface MachineRuntime {
  cwd: string | null; directory: string; commands: Readonly<Record<string, readonly string[]>>;
}
export interface MachineSummary {
  id: CoreId; name: MachineName; aliases: readonly string[]; state: 'connected' | 'disconnected';
  sessionNamespace: string; runtime: MachineRuntime | null;
}
export type HcEvent =
  | { type: 'snapshot' | 'missed'; seq: number; terminals: readonly TerminalSummary[]; generation?: string }
  | { type: 'created' | 'restarted'; seq: number; terminal: TerminalAddress; data: TerminalSummary; generation?: string }
  | { type: 'status'; seq: number; terminal: TerminalAddress; data: { status: ProgramStatus | null }; generation?: string }
  | { type: 'finished'; seq: number; terminal: TerminalAddress; data: TerminalFinish; generation?: string }
  | { type: 'lost'; seq: number; terminal: TerminalAddress; data: Omit<TerminalFinish, 'finishedAt'> & { finishedAt: number | null }; generation?: string }
  | { type: 'removed'; seq: number; terminal: TerminalAddress; generation?: string }
  | { type: 'heartbeat'; seq: number; generation?: string };
/**
 * A per-call view of one client-owned, lazily started `hc events --json` process.
 * Once initialized, each subscription receives the current materialized snapshot
 * on the next microtask, then ordered live events. Before initialization it
 * receives the real snapshot. Missed lists and resubscription snapshots replace
 * the materialized state. Disposing a view removes only its own listeners;
 * disposing the client returned by createHcClient stops the shared process.
 */
export interface HcEventStream extends Disposable {
  ready: Promise<void>; lookup(address: TerminalAddress): Promise<TerminalSummary | null>;
  subscribe(listener: (event: HcEvent) => void): () => void;
}
export interface HcClientOptions {
	isolationProof?: TestIsolationProof;
	binary: string;
	env: Readonly<NodeJS.ProcessEnv>;
	maxReplyBytes?: number;
}
export interface HcClient {
	identity(): Promise<CoreIdentity>;
	caller(env: Readonly<NodeJS.ProcessEnv>): Promise<TerminalIdentity>;
	machines(): Promise<MachineSummary[]>;
	run(request: HcRunRequest): Promise<TerminalHandle>;
	get(address: TerminalAddress): Promise<TerminalSummary>;
	read(address: TerminalAddress, options: { lines: number }): Promise<string>;
	kill(address: TerminalAddress): Promise<void>;
	rm(address: TerminalAddress): Promise<void>;
	setLabels(address: TerminalAddress, labels: Readonly<Record<string, string | null>>): Promise<void>;
	fileRead(on: MachineName, path: string): Promise<Buffer>;
	fileWrite(on: MachineName, path: string, bytes: Buffer): Promise<void>;
	events(): HcEventStream;
}
export interface AppClientOptions { binary: string; env: Readonly<NodeJS.ProcessEnv> }
export type AppReply = { space?: SpaceId; tab?: TabId; pane?: PaneId; terminal?: TerminalAddress; pending?: boolean; error?: never }
  | { error: { code: string; message: string }; space?: never; tab?: never; pane?: never; terminal?: never };
export interface OwnerPlacement { space: SpaceId; tab: TabId; pane: PaneId }
export interface AppClient {
	ownerPlacement(address: TerminalAddress): Promise<OwnerPlacement>;
	awaitPane(viewer: TerminalAddress, owner: OwnerPlacement,
		options: { signal?: AbortSignal; timeoutMs: number }): Promise<PaneId>;
	command(name: string, args: Readonly<Record<string, unknown>>): Promise<AppReply>;
}
export interface UploadedFile { path: string; bytes: Buffer; sha256: string }
export interface PreparedProgram {
  /** Secret-scrubbed, single-line original command preview, at most 180 characters. */
  commandPreview?: string;
	/** Present only when this launch has an agent console retaining its remote output. */
	consoleDirectory?: string;
	/** Absolute destination private directory: `${RuntimeTarget.directory}/<128-bit random hex>`. */
	directory: string;
	argv: readonly string[];
	cwd: string | null;
	files: readonly UploadedFile[];
	env: Readonly<NodeJS.ProcessEnv>;
}
export type RemoteSource =
	| { kind: "code"; language: Language; code: string }
	| { kind: "file"; language: Language; path: string; code: string };
export interface RuntimeTarget {
	on: MachineName;
	cwd: string | null;
	directory: string;
	commands: Readonly<Record<string, readonly string[]>>;
	environment: Readonly<NodeJS.ProcessEnv>;
	nodePath: string;
	runtimePath: string;
	runtimeSha256: string;
}
export interface RemoteExecuteRequest {
	source: RemoteSource;
	kind?: JobRecord['kind'];
	on: MachineName;
	owner: Owner;
	timeout?: number;
	background?: boolean;
	signal?: AbortSignal;
	onData?: (chunk: string) => void;
}
export interface RemoteExecutionPort {
	execute(request: RemoteExecuteRequest): Promise<RemoteResult>;
}
export interface RemoteResult {
	evidenceConflict?: boolean;
	exitEvidence?: JobExitEvidence;
	stdout: string;
	stderr: string;
	exitCode: number | null;
	outcome: "exited" | "signal" | "spawn-error" | "aborted" | "timeout" | "unknown";
	signal?: string;
	timedOut: boolean;
	backgrounded?: boolean;
	backgroundJob?: {
		id: string; dir: string; manifest: string; receipt: string;
		logs: { stdout: string; stderr: string };
	};
	backgroundLogs?: { stdout: string; stderr: string };
	aborted?: boolean;
	retained?: boolean;
	retainedReason?: string;
	remote: { jobId: JobId; machine: MachineName; address: TerminalAddress | null };
}
export type ExecutionEnvironmentPolicy =
	(env: Readonly<NodeJS.ProcessEnv>) => Readonly<NodeJS.ProcessEnv>;
export interface TerminalFinish { exitCode: number | null; reason: string; signal: number | null; finishedAt: number }
export interface JobExitEvidence { native: TerminalFinish; receipt: TerminalFinish }
export interface JobFinish extends TerminalFinish { evidenceConflict?: boolean; exitEvidence?: JobExitEvidence }
export type JobPhase = { kind: 'preparing' } | { kind: 'waiting-for-pane'; address: TerminalAddress }
  | { kind: 'running'; address: TerminalAddress; releasedAt: number } | { kind: 'disconnected'; address: TerminalAddress; lastSeq: number }
  | { kind: 'finished'; address: TerminalAddress; result: TerminalFinish } | { kind: 'launch-failed'; error: string };
export interface JobRecord {
  exitEvidence?: JobExitEvidence;
  version: 1; id: JobId; owner: Owner; machine: MachineName; kind: 'exec' | 'exec-file' | 'batch'; phase: JobPhase;
  runId?: RunId;
  commandPreview?: string;
  viewer: TerminalAddress | null; remoteDirectory: string; localDirectory: string; detached: boolean;
  noticeMode: 'tool' | 'async'; notice: 'pending' | 'submitted' | 'observed';
}
export interface JobPort extends Disposable {
	start(program: PreparedProgram, owner: Owner, on: MachineName,
		options: { background?: boolean; signal?: AbortSignal; kind?: JobRecord['kind'] }): Promise<JobHandle>;
	detach(jobId: JobId): Promise<void>;
	toolReturned(jobId: JobId): Promise<void>;
	consumeNotice(jobId: JobId): Promise<void>;
}
export interface JobHandle {
	id: JobId;
	address: TerminalAddress;
	remoteDirectory: string;
	localDirectory: string;
	finished: Promise<JobFinish>;
	cancel(reason: "abort" | "timeout" | "viewer-closed" | "shutdown"): Promise<void>;
}
export interface PaneReservation { id: JobId | RunId; owner: Owner; kind: 'remote' | 'subagent'; viewer: TerminalAddress; pane: PaneId }
export interface AuxiliaryPanes extends Disposable {
	acquire(kind: "remote" | "subagent", id: JobId | RunId,
		owner: Owner, options: { signal?: AbortSignal; timeoutMs: number }): Promise<PaneReservation | null>;
	release(reservation: PaneReservation): Promise<void>;
	park(runId: RunId): Promise<void>;
}
export interface SessionPlacement { spaceId: SpaceId; spaceName: string | null; spaceOrder: number | null; tabId: TabId | null }
export interface RunSummary { id: RunId; ownerSessionId: SessionId; name: string | null; status: 'queued' | 'running' | 'paused' | 'done' | 'failed' | 'cancelled'; childMode: 'rpc' | 'print'; canSteer: boolean; startedAt: number | null; finishedAt: number | null; viewer: TerminalAddress | null; result: string | null }
export interface TodoSummary { seq: number; sessionId: SessionId; text: string; done: boolean }
export interface TriggerSummary { name: string; kind: 'loop' | 'schedule'; nextAt: number | null; tz: string | null; state: string; prompt: string }
export interface PaceSummary { scope: 'shared' | 'session'; used: number | null; budget: number | null; projected: number | null; remaining: number | null; periodStart: number | null; periodEnd: number | null; updatedAt: number | null; unavailableReason: string | null;
  /** The usage dashboard's own formatting of the same values (the panel runtime has no Intl). */
  labels?: PaceLabels }
/** Strings made by the dashboard's formatters: compact for the track, exact for the popover. */
export interface PaceLabels { month: string | null; usedCompact: string; used: string; projected: string; budget: string; remaining: string; updatedAt: string | null }
/** One session's credits since the billing month began, as the dashboard's session table shows them. */
export interface SessionMonthCost { credits: number | null; label: string }
export interface ApprovalSummary { uuid: string; scope: 'global' | 'repo'; repoKey: string | null; ownerSessionId: SessionId | null; category: string; preview: string }
export interface JobResultSummary {
  outcome?: RemoteResult['outcome']; evidenceConflict?: boolean; exitEvidence?: JobExitEvidence;
  id: JobId; runId: RunId | null; commandPreview: string; machine: MachineName;
  exitCode: number | null; signal: number | null; finishedAt: number; address: TerminalAddress;
}
export type PanelNotification =
  | { id: string; createdAt: number; title: string; body: string;
      kind: 'subagent-result' | 'escalation' | 'job-result'; scope: 'session';
      sessionId: SessionId; ownerAddress: TerminalAddress;
      /** Absent in feeds written before structured job results existed. */
      job?: JobResultSummary;
      action: { kind: 'focus-owner'; sessionId: SessionId; address: TerminalAddress } }
  | { id: string; createdAt: number; title: string; body: string;
      kind: 'budget'; scope: 'shared'; sessionId: null; ownerAddress: null;
      action: { kind: 'open-usage'; scope: 'shared' } };
export type HerdrNotification = PanelNotification;
export interface IpcDescriptor { version: 1; sessionId: SessionId; generation: Generation; address: string; capabilityFile: string }
export interface SessionFeed {
  version: 1; sessionId: SessionId; generation: Generation; revision: number; updatedAt: number; owner: Owner;
  placement: SessionPlacement | null; lifecycle: 'live' | 'closed'; status: { native: ProgramState | null; effective: ProgramState | null; message: string | null };
  runs: { rows: RunSummary[]; total: number; truncated: boolean }; todos: { rows: TodoSummary[]; total: number; truncated: boolean };
  triggers: TriggerSummary[]; pace: PaceSummary; approvals: ApprovalSummary[]; notifications: PanelNotification[];
  ipc: { address: string; capabilityFile: string } | null; errors: { source: string; message: string }[];
  /** Absent in feeds written before month costs existed. */
  monthCost?: SessionMonthCost;
}
export interface SessionDataSource extends Disposable {
	snapshot(owner: Owner): Promise<SessionFeed>;
	subscribe(listener: () => void): () => void;
}
export type ViewName = "agents" | "todos" | "usage" | "memory" | "triggers";
export type HerdrViews = Readonly<Record<ViewName,
	(ctx: ExtensionContext) => Promise<void>>>;
export interface HerdrConfig {
  enabled: 'auto' | boolean; app: { binary: string; home: string }; core: { binary: string; config: string };
  agentDirectory: string; globalRoot: string; shellRc: string;
  spaces: { name: string; sessions: ({ file: string } | { name: string; sessionId?: string })[] }[];
  machines: { name: MachineName; aliases: string[]; runtime: MachineRuntime; nodePath?: string }[];
  fonts?: { body?: { path: string; license: string }; label?: { path: string; license: string }; paths?: { path: string; license: string } };
  limits: { auxiliaryPanes: number; completedRows: number; completedHours: number };
  retention: { foregroundDays: number }; admin: { wrappers: { path: string; sha256: string }[] };
}

export const HERDR_LABELS = {
  session: 'spider.session', ownerCore: 'spider.owner-core', ownerTerminal: 'spider.owner-terminal',
  kind: 'spider.kind', job: 'spider.job', run: 'spider.run', space: 'herdr.space', tab: 'herdr.tab', machine: 'spider.machine',
  parentName: 'spider.parent-name', steer: 'spider.steer', displayName: 'spider.display-name', viewerLifetime: 'spider.viewer-lifetime',
} as const;
export const HERDR_KINDS = {
  exec: 'exec', execFile: 'exec-file', batch: 'batch', remoteObserver: 'remote-observer',
  subagentViewer: 'subagent-viewer', setupProbe: 'setup-probe', session: 'session', remoteConsole: 'remote-console',
} as const;
export type HerdrKind = typeof HERDR_KINDS[keyof typeof HERDR_KINDS];

export interface TestIsolationProof {
	checkout: string;
	sessionNamespace: string;
	coreIds: readonly CoreId[];
	sockets: readonly string[];
}

export interface ProcessPresence {
  pid: number; startIdentity: string; sessionFile: string | null; sessionName: string | null;
  kind: 'top-level' | 'child'; hcAddress: TerminalAddress | null;
}
export interface HerdrLabelContract { version: 1; labels: typeof HERDR_LABELS; kinds: typeof HERDR_KINDS }
export const HerdrLabelContract: HerdrLabelContract = { version: 1, labels: HERDR_LABELS, kinds: HERDR_KINDS };
export type ViewerIntent = 'automatic' | 'explicit';
export type ViewerLauncher = (runId: RunId, owner: Owner, signal?: AbortSignal, intent?: ViewerIntent) => Promise<TerminalAddress>;

/** Opaque source-owned event position and transcript byte offset, at most 1024 UTF-8 bytes. */
export type RunCursor = string & { readonly __kind: 'run-cursor' };
export interface RunViewEvent {
  runId: RunId;
  id: number;
  type: string;
  text?: string;
  summary?: string;
  tool?: string;
  /** Stable identity of a completed assistant message, including across replay. */
  messageId?: string;
  /** This cursor's transcript has already supplied this message's prose. */
  streamed?: boolean;
}
/** A serialized transcript page is at most 64 KiB. */
export interface TranscriptPage {
  text: string;
  events: RunViewEvent[];
}
/** Stream frames are at most 256 KiB; overflow ends a subscription for cursor-based reconnect. */
export type RunViewFrame =
  | { runId: RunId; cursor: RunCursor; kind: 'snapshot'; data: { run: RunSummary } }
  | { runId: RunId; cursor: RunCursor; kind: 'event'; data: TranscriptPage }
  | { runId: RunId; cursor: RunCursor; kind: 'gap'; data: { reason: string } }
  | { runId: RunId; cursor: RunCursor; kind: 'end'; data: {
      reason: 'finished' | 'disposed' | 'wrong-generation' | 'overflow' | 'run-not-owned';
    } };
interface SteerReplyDetails {
  queued: boolean;
  transformed?: boolean;
  error?: string;
}
/** Preserve the message action's acknowledgement without treating uncertain input as delivered. */
export type SteerReply = SteerReplyDetails & (
  | { delivery: 'delivered'; accepted: true; delivered: true }
  | { delivery: 'accepted but not confirmed' | 'broker-accepted'; accepted: true; delivered: false }
  | { delivery: 'consumed by an extension, not delivered'; accepted: true; delivered: false }
  | { delivery: 'no reply yet, delivery unknown'; accepted: false; delivered: false }
  | { delivery: 'refused'; accepted: false; delivered: false }
);
/** Every IPC request is generation-bound, and steer text is at most 16 KiB of UTF-8. */
export type SessionIpcRequest =
  | { op: 'ping'; generation: Generation }
  | { op: 'openView'; view: ViewName; generation: Generation }
  | { op: 'openRun'; runId: RunId; generation: Generation }
  /** The owning session acquires the job's local observer with AuxiliaryPanes.acquire('remote', jobId, owner, options). */
  | { op: 'openJob'; jobId: JobId; generation: Generation }
  | { op: 'steerRun'; runId: RunId; text: string; generation: Generation }
  | { op: 'subscribeRun'; runId: RunId; cursor: RunCursor | null; generation: Generation };
/** The first Unix-socket JSON line carries a 64-hex-character capability and is at most 256 KiB. */
export interface SessionIpcEnvelope { v: 1; capability: string; request: SessionIpcRequest }
/** Stable IPC failures let callers distinguish authentication, lifecycle, bounds, and action refusal. */
export type IpcErrorCode = 'wrong-generation' | 'unauthorized' | 'unknown-op' | 'too-large'
  | 'not-found' | 'unavailable' | 'status-instance-unavailable' | 'refused';
/** A steer refusal preserves the reason the existing message action cannot deliver. */
export type SteerRefusal = 'queued' | 'paused' | 'print-mode' | 'slash-prefixed' | 'wrong-owner' | 'dead-pipe';
/** A CLI reply is one JSON line; refusal reasons are valid only for a refused action. */
export type SessionIpcReply =
  | { ok: true; op: 'ping'; status: { native: ProgramState | null; effective: ProgramState | null } }
  | { ok: true; op: 'openView' }
  | { ok: true; op: 'openRun'; viewer: TerminalAddress }
  | { ok: true; op: 'openJob'; viewer: TerminalAddress }
  | { ok: true; op: 'steerRun'; acknowledgement: SteerReply }
  | { ok: false; code: Exclude<IpcErrorCode, 'refused'>; message: string; reason?: never }
  | { ok: false; code: 'refused'; message: string; reason?: SteerRefusal };

export { panelIpcArgv, parsePanelIpcArgv, parseSessionIpcRequest, parseSessionIpcEnvelope,
  parseSessionIpcReply, parseRunViewFrame } from '../assets/shared/feed.js';

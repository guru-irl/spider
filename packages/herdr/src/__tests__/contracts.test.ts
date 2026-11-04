// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { test } from 'vitest';
import type { Language } from '@spider/context';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import type * as Actual from '../contracts.js';
import type * as Public from '../index.js';
import type {
  CoreId, TerminalIdentity, MachineSummary, HcRunRequest, TerminalHandle,
  TerminalAddress, TerminalSummary, MachineName, HcEventStream, SpaceId, TabId,
  PaneId, Owner, JobId, RunId, TerminalFinish, PaneReservation, SessionFeed, AppReply, SessionId, Generation, ProgramState,
} from '../contracts.js';

declare namespace Fixed {
  export interface Disposable { dispose(): void | Promise<void> }
  export type AcceptanceMode = "fake" | "hc" | "app";
  export interface PendingCounts { queued: number; running: number; paused: number }
  export interface TestIsolationProof {
    checkout: string;
    sessionNamespace: string;
    coreIds: readonly CoreId[];
    sockets: readonly string[];
  }
  export interface HcClientOptions {
    isolationProof?: TestIsolationProof;
    binary: string;
    env: Readonly<NodeJS.ProcessEnv>;
    maxReplyBytes?: number;
  }
  export interface CoreIdentity { coreId: CoreId; socket: string; sessionNamespace: string }
  export interface HcCallOptions { signal?: AbortSignal; timeoutMs?: number }
  export interface HcClient {
    identity(): Promise<CoreIdentity>;
    caller(env: Readonly<NodeJS.ProcessEnv>): Promise<TerminalIdentity>;
    machines(options?: HcCallOptions): Promise<MachineSummary[]>;
    run(request: HcRunRequest): Promise<TerminalHandle>;
    get(address: TerminalAddress, options?: HcCallOptions): Promise<TerminalSummary>;
    read(address: TerminalAddress, options: { lines: number }): Promise<string>;
    kill(address: TerminalAddress): Promise<void>;
    rm(address: TerminalAddress, options?: HcCallOptions): Promise<void>;
    setLabels(address: TerminalAddress, labels: Readonly<Record<string, string | null>>): Promise<void>;
    fileRead(on: MachineName, path: string): Promise<Buffer>;
    fileWrite(on: MachineName, path: string, bytes: Buffer, options?: HcCallOptions): Promise<void>;
    events(): HcEventStream;
  }
  export interface AppClient {
    ownerPlacement(address: TerminalAddress): Promise<OwnerPlacement>;
    tabSpace?(tab: TabId): Promise<SpaceId | null>;
    awaitPane(viewer: TerminalAddress, owner: OwnerPlacement,
      options: { signal?: AbortSignal; timeoutMs: number }): Promise<PaneId>;
    command(name: string, args: Readonly<Record<string, unknown>>): Promise<AppReply>;
  }
  export interface OwnerPlacement { space: SpaceId; tab: TabId; pane: PaneId }
  export interface UploadedFile { path: string; bytes: Buffer; sha256: string }
  export interface PreparedProgram {
    commandPreview?: string;
    consoleDirectory?: string;
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
    kind?: 'exec' | 'exec-file' | 'batch';
    on: MachineName;
    owner: Owner;
    timeout?: number;
    background?: boolean;
    signal?: AbortSignal;
    onData?: (chunk: string) => void;
  }
  export interface RemoteCopyRequest {
    on: MachineName; owner: Owner; direction: 'to' | 'from'; local: string; remote: string; signal?: AbortSignal;
  }
  export interface RemoteCopyResult {
    direction: 'to' | 'from'; machine: MachineName; source: string; destination: string; bytes: number; mode: number; sha256: string;
  }
  export interface RemoteExecutionPort {
    execute(request: RemoteExecuteRequest): Promise<RemoteResult>;
    copy?(request: RemoteCopyRequest): Promise<RemoteCopyResult>;
  }
  export interface JobExitEvidence { native: TerminalFinish; receipt: TerminalFinish }
  export interface JobFinish extends TerminalFinish { evidenceConflict?: boolean; exitEvidence?: JobExitEvidence }
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
    remoteAbortInfo?: string;
    retained?: boolean;
    retainedReason?: string;
    remote: { jobId: JobId; machine: MachineName; address: TerminalAddress | null };
  }
  export type ExecutionEnvironmentPolicy =
    (env: Readonly<NodeJS.ProcessEnv>) => Readonly<NodeJS.ProcessEnv>;
  export interface JobPort extends Disposable {
    start(program: PreparedProgram, owner: Owner, on: MachineName,
      options: { background?: boolean; signal?: AbortSignal; kind?: 'exec' | 'exec-file' | 'batch' }): Promise<JobHandle>;
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
  export interface AuxiliaryPanes extends Disposable {
    acquire(kind: "remote" | "subagent", id: JobId | RunId,
      owner: Owner, options: { signal?: AbortSignal; timeoutMs: number }): Promise<PaneReservation | null>;
    release(reservation: PaneReservation): Promise<void>;
    park(runId: RunId): Promise<void>;
  }
  export interface SessionDataSource extends Disposable {
    snapshot(owner: Owner): Promise<SessionFeed>;
    subscribe(listener: () => void): () => void;
  }
  export type ViewName = "agents" | "todos" | "usage" | "memory" | "triggers";
  export type HerdrViews = Readonly<Record<ViewName,
    (ctx: ExtensionContext) => Promise<void>>>;
}

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;
// The fixed foundation contract is a caller-visible API, including exact method parameters.
export type FixedContractChecks = [
  Assert<Equal<Actual.Disposable, Fixed.Disposable>>,
  Assert<Equal<Actual.AcceptanceMode, Fixed.AcceptanceMode>>,
  Assert<Equal<Actual.PendingCounts, Fixed.PendingCounts>>,
  Assert<Equal<Actual.TestIsolationProof, Fixed.TestIsolationProof>>,
  Assert<Equal<Actual.HcClientOptions, Fixed.HcClientOptions>>,
  Assert<Equal<Actual.CoreIdentity, Fixed.CoreIdentity>>,
  Assert<Equal<Actual.HcCallOptions, Fixed.HcCallOptions>>,
  Assert<Equal<Actual.HcClient, Fixed.HcClient>>,
  Assert<Equal<Omit<Actual.AppClient, 'tabTerminals'>, Fixed.AppClient>>,
  Assert<Equal<Actual.AppClient['tabTerminals'], (placement: Pick<Actual.OwnerPlacement, 'space' | 'tab'>) => Promise<readonly Actual.TerminalAddress[]>>>,
  Assert<Equal<Actual.OwnerPlacement, Fixed.OwnerPlacement>>,
  Assert<Equal<Actual.UploadedFile, Fixed.UploadedFile>>,
  Assert<Equal<Actual.PreparedProgram, Fixed.PreparedProgram>>,
  Assert<Equal<Actual.RemoteSource, Fixed.RemoteSource>>,
  Assert<Equal<Actual.RuntimeTarget, Fixed.RuntimeTarget>>,
  Assert<Equal<Actual.RemoteExecuteRequest, Fixed.RemoteExecuteRequest>>,
  Assert<Equal<Actual.RemoteCopyRequest, Fixed.RemoteCopyRequest>>,
  Assert<Equal<Actual.RemoteCopyResult, Fixed.RemoteCopyResult>>,
  Assert<Equal<Actual.RemoteExecutionPort, Fixed.RemoteExecutionPort>>,
  Assert<Equal<Actual.RemoteResult, Fixed.RemoteResult>>,
  Assert<Equal<Actual.ExecutionEnvironmentPolicy, Fixed.ExecutionEnvironmentPolicy>>,
  Assert<Equal<Actual.JobPort, Fixed.JobPort>>,
  Assert<Equal<Actual.JobHandle, Fixed.JobHandle>>,
  Assert<Equal<Actual.AuxiliaryPanes, Fixed.AuxiliaryPanes>>,
  Assert<Equal<Actual.SessionDataSource, Fixed.SessionDataSource>>,
  Assert<Equal<Actual.ViewName, Fixed.ViewName>>,
  Assert<Equal<Actual.HerdrViews, Fixed.HerdrViews>>,
  Assert<Equal<Actual.HcRunRequest['noNotify'], true>>,
  Assert<Equal<keyof Actual.JobRecord, 'version' | 'id' | 'owner' | 'machine' | 'kind' | 'phase' | 'viewer' | 'remoteDirectory' | 'localDirectory' | 'detached' | 'noticeMode' | 'notice' | 'runId' | 'commandPreview' | 'exitEvidence'>>,
];

// @ts-expect-error The delegation protocol was retired, not renamed.
export type RetiredJobClientDescriptor = Actual.JobClientDescriptor;
// @ts-expect-error Only the multi-core test isolation contract is public.
export type RetiredHcIsolationProof = Actual.HcIsolationProof;

test('fixed foundation contracts compile for their callers', () => {});

declare namespace Wire {
  export type RunCursor = string & { readonly __kind: 'run-cursor' };
  export interface RunViewEvent { runId: RunId; id: number; type: string; text?: string; summary?: string; tool?: string; messageId?: string; streamed?: boolean }
  export interface TranscriptPage { text: string; events: RunViewEvent[] }
  export type RunViewFrame = { runId: RunId; cursor: RunCursor; kind: 'snapshot'; data: { run: Actual.RunSummary; view?: { protocol: number; sessionFile?: string | null; model?: string | null; thinking?: string | null; contextWindow?: number | null } } }
    | { runId: RunId; cursor: RunCursor; kind: 'event'; data: TranscriptPage }
    | { runId: RunId; cursor: RunCursor; kind: 'live'; data: { event: { type: string } & Record<string, unknown> } }
    | { runId: RunId; cursor: RunCursor; kind: 'gap'; data: { reason: string } }
    | { runId: RunId; cursor: RunCursor; kind: 'end'; data: { reason: 'finished' | 'disposed' | 'wrong-generation' | 'overflow' | 'run-not-owned' } };
  export type SteerReply = { queued: boolean; transformed?: boolean; error?: string } & (
    | { delivery: 'delivered'; accepted: true; delivered: true }
    | { delivery: 'accepted but not confirmed' | 'broker-accepted'; accepted: true; delivered: false }
    | { delivery: 'consumed by an extension, not delivered'; accepted: true; delivered: false }
    | { delivery: 'no reply yet, delivery unknown'; accepted: false; delivered: false }
    | { delivery: 'refused'; accepted: false; delivered: false }
  );
  export type SessionIpcRequest = { op: 'ping'; generation: Generation }
    | { op: 'openView'; view: Fixed.ViewName; generation: Generation }
    | { op: 'openRun'; runId: RunId; generation: Generation }
    | { op: 'killRun'; runId: RunId; generation: Generation }
    | { op: 'killSession'; generation: Generation }
    | { op: 'moveRun'; runId: RunId; destination: { kind: 'new' } | { kind: 'hide' } | { kind: 'tab'; tab: TabId }; generation: Generation }
    | { op: 'moveSession'; destination: { kind: 'new' } | { kind: 'tab'; tab: TabId }; generation: Generation }
    | { op: 'openJob'; jobId: JobId; generation: Generation }
    | { op: 'killJob'; jobId: JobId; generation: Generation }
    | { op: 'moveJob'; jobId: JobId; viewer: TerminalAddress; destination: { kind: 'new' } | { kind: 'tab'; tab: TabId }; generation: Generation }
    | { op: 'steerRun'; runId: RunId; text: string; generation: Generation }
    | { op: 'subscribeRun'; runId: RunId; cursor: RunCursor | null; generation: Generation; view?: number };
  export interface SessionIpcEnvelope { v: 1; capability: string; request: SessionIpcRequest }
  export type IpcErrorCode = 'wrong-generation' | 'unauthorized' | 'unknown-op' | 'too-large' | 'not-found' | 'unavailable' | 'status-instance-unavailable' | 'refused';
  export type SteerRefusal = 'queued' | 'paused' | 'print-mode' | 'slash-prefixed' | 'wrong-owner' | 'dead-pipe';
  export type SessionIpcReply = { ok: true; op: 'ping'; status: { native: ProgramState | null; effective: ProgramState | null } }
    | { ok: true; op: 'openView' }
    | { ok: true; op: 'killRun' }
    | { ok: true; op: 'killSession' }
    | { ok: true; op: 'moveSession' }
    | { ok: true; op: 'moveRun'; viewer: TerminalAddress | null }
    | { ok: true; op: 'moveJob'; viewer: TerminalAddress | null }
    | { ok: true; op: 'openRun'; viewer: TerminalAddress }
    | { ok: true; op: 'openJob'; viewer: TerminalAddress }
    | { ok: true; op: 'killJob'; jobId: JobId }
    | { ok: true; op: 'steerRun'; acknowledgement: SteerReply }
    | { ok: false; code: Exclude<IpcErrorCode, 'refused'>; message: string; reason?: never }
    | { ok: false; code: 'refused'; message: string; reason?: SteerRefusal };
  export type PanelNotification =
    | { id: string; createdAt: number; title: string; body: string; kind: 'subagent-result' | 'escalation' | 'job-result'; scope: 'session'; sessionId: SessionId; ownerAddress: TerminalAddress; job?: { outcome?: Fixed.RemoteResult['outcome']; evidenceConflict?: boolean; exitEvidence?: Fixed.JobExitEvidence; id: JobId; runId: RunId | null; commandPreview: string; machine: MachineName; exitCode: number | null; signal: number | null; finishedAt: number; address: TerminalAddress }; action: { kind: 'focus-owner'; sessionId: SessionId; address: TerminalAddress } }
    | { id: string; createdAt: number; title: string; body: string; kind: 'budget'; scope: 'shared'; sessionId: null; ownerAddress: null; action: { kind: 'open-usage'; scope: 'shared' } };
  export interface ProcessPresence { pid: number; startIdentity: string; sessionFile: string | null; sessionName: string | null; kind: 'top-level' | 'child'; hcAddress: TerminalAddress | null }
}
export type SharedContractChecks = [
  Assert<Equal<typeof Public.panelIpcArgv, typeof Actual.panelIpcArgv>>,
  Assert<Equal<typeof Public.parsePanelIpcArgv, typeof Actual.parsePanelIpcArgv>>,
  Assert<Equal<typeof Public.parseSessionIpcRequest, typeof Actual.parseSessionIpcRequest>>,
  Assert<Equal<typeof Public.parseSessionIpcEnvelope, typeof Actual.parseSessionIpcEnvelope>>,
  Assert<Equal<typeof Public.parseSessionIpcReply, typeof Actual.parseSessionIpcReply>>,
  Assert<Equal<typeof Public.parseRunViewFrame, typeof Actual.parseRunViewFrame>>,
  Assert<Equal<Actual.RunCursor, Wire.RunCursor>>,
  Assert<Equal<Actual.RunViewEvent, Wire.RunViewEvent>>,
  Assert<Equal<Actual.TranscriptPage, Wire.TranscriptPage>>,
  Assert<Equal<Actual.RunViewFrame, Wire.RunViewFrame>>,
  Assert<Equal<Actual.SessionIpcRequest, Wire.SessionIpcRequest>>,
  Assert<Equal<Actual.SessionIpcEnvelope, Wire.SessionIpcEnvelope>>,
  Assert<Equal<Actual.SessionIpcReply, Wire.SessionIpcReply>>,
  Assert<Equal<Actual.IpcErrorCode, Wire.IpcErrorCode>>,
  Assert<Equal<Actual.SteerRefusal, Wire.SteerRefusal>>,
  Assert<Equal<Actual.SteerReply, Wire.SteerReply>>,
  Assert<Equal<Actual.PanelNotification, Wire.PanelNotification>>,
  Assert<Equal<Actual.HerdrNotification, Wire.PanelNotification>>,
  Assert<Equal<Actual.ProcessPresence, Wire.ProcessPresence>>,
  Assert<Equal<Actual.ViewerLauncher, (runId: RunId, owner: Owner, signal?: AbortSignal, intent?: 'automatic' | 'explicit') => Promise<TerminalAddress>>>,
  Assert<Equal<Actual.HerdrLabelContract, { version: 1; labels: Omit<typeof Actual.HERDR_LABELS, 'runtime'>; kinds: typeof Actual.HERDR_KINDS }>>,
  Assert<Equal<typeof Actual.panelIpcArgv, (nodePath: string, cliPath: string, descriptor: Actual.IpcDescriptor, request: Actual.SessionIpcRequest) => string[]>>,
];

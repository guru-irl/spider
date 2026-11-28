import { planPaneEndpointInstallation, stagePaneEndpointInstallation, probeLocalPaneEndpoint } from './pane-installation.js';
import { assertSetupNotUndoing } from '../../../herdr/src/setup/checkpoint.js';
import { inspectPaneInstallation } from './pane-doctor.js';
import { createPaneRemoteRequest } from './pane-transport.js';
import { createArgvClient } from '../../../herdr/src/client/argv-client.js';
import { PANE_ENTRY_MODS, planPaneModFiles } from '../../../herdr/src/setup/pane-assets.js';
import { createPaneRuntime, type PaneRuntime } from './pane-runtime.js';
import { createProductionPaneEndpointPorts } from './bin/pane-endpoint.js';
import { handleRemotePaneRequest } from './pane-endpoint.js';
import { spawn } from 'node:child_process';
import { constants as fileFlags, readlinkSync } from 'node:fs';
import { isDeepStrictEqual, stripVTControlCharacters } from 'node:util';
import { realpath, stat, appendFile, open } from 'node:fs/promises';
import { scrubSecrets } from '@spider/memory';
import { ModelRuntime, ModelRegistry, getAgentDir, type CreateModelRuntimeOptions } from '@earendil-works/pi-coding-agent';
import { createHcClient, invokeCli } from '@spider/herdr/client/hc';
import { invokeCli as invokeAppCli } from '@spider/herdr/client/cli-transport';
import { createAppClient } from '@spider/herdr/client/app';
import { parseHerdrConfig } from '@spider/herdr/config';
import { runSshShim, ordinaryExecutionEnvironment, SSH_DESCRIPTOR_ENV } from '@spider/herdr/ssh/shim';
import { runRemoteObserver, observerMarker } from '@spider/herdr/jobs/observer';
import { createJobStore, jobJournalRoot, type JournalJob } from '@spider/herdr/jobs/store';
import { preflightSpaces, setupSpaces, readCutoverRecovery, reconcileSpaceJournal, planSpaceCutover, tabTerminals, forgetCutoverTabs, type SpaceSetupPorts, type LayoutSnapshot } from '@spider/herdr/spaces/setup';
import { inspectPanePlacement } from '@spider/herdr/panes/store';
import { createRoamPresentationPorts, type RoamPresentationPorts } from './roam-presentations.js';
import { offerResume, resumeOfferShell, resumeWatchShell, buildResumeBlock, shellQuote } from '@spider/herdr/sessions/resume';
import { discoverSessions, selectedProcessInventory } from '@spider/herdr/spaces/discovery';
import { launchSession } from '@spider/herdr/sessions/launcher';
import { resolveLaunchSource, launchFlagTakesValue } from '@spider/herdr/sessions/launch-environment';
import { applyLookPatches, selectLookPatches, applyModPatches, hasNativeLookFeatures, isSpacesALookVersion, lookCloneKinds, type AdditionalLookPatches, type LookModKind, type LookPatch, type HerdrClones, type LookPatchSet } from '@spider/herdr/look/patches';
import { notificationAgentPatches } from '@spider/herdr/look/notification-patches';
import { applyCrossMachinePatches, crossMachineKinds, selectCrossMachinePatches, type CrossMachineLookRecipe } from '@spider/herdr/look/cross-machine';
import { buildGlassLayout } from '@spider/herdr/look/layout';
import { prepareFonts } from '@spider/herdr/look/fonts';
import { checkThemeContrast, type PiThemeData } from '@spider/herdr/look/contrast';
import { readGlobalHerdrTemplateFiles } from '@spider/herdr/templates/register';
import { inspectHerdrShortcutCollisions } from '@spider/herdr/shortcuts/register';
import { HerdrLabelContract, HERDR_KINDS, HERDR_LABELS } from '@spider/herdr';
import { readLayer, configValues } from '../control.js';
import { paths } from '@spider/db-core';
import { doctorHerdr, checkNodeVersion, paneCoreVersionSupported, inspectPaneCommands, inspectPaneServiceState, checkManagedKeyBindings, probeLaunch, type DoctorParts, type DoctorItem, type DoctorFailure, type DoctorInformation } from '@spider/herdr/setup/doctor';
import { feedWriterLiveness } from '@spider/herdr/feed/writer';
import { sessionFeedIsFresh } from '@spider/herdr/feed/freshness';
import { snapshot, digest, managedProjection, rootNotesValue, readJournal, saveJournal, withSetupLock, validateFiles, prepareBackups, applyFiles, missingKeyMapMessage, type KeyBinding, type KeyFields, type KeySections } from '@spider/herdr/setup/backup';
import { CoreOnlySetupError, runtimeInstallPath, standardHerdrConfigPath, type SetupRequest, type SetupParts, type SetupContext, type InstallFile, type RuntimeRootObservation } from '@spider/herdr/setup/installer';
import { planToastFiles } from '@spider/herdr/setup/toast';
import type { HerdrCliPorts } from '@spider/herdr/setup/cli';
import type { CoreId, CoreIdentity, TerminalHandle, TerminalIdentity, TerminalAddress, MachineName, HcRunRequest } from '@spider/herdr';
import type { PaneService } from '../../../herdr/src/panes/service.js';
import type { AuxiliaryPaneActor } from '../../../herdr/src/jobs/placement.js';
import { parseFeed } from '../../../herdr/assets/shared/feed.js';
import { createSessionIpcClient } from '@spider/herdr/feed/ipc-client';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { join, resolve, isAbsolute, dirname, relative, sep } from 'node:path';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { createMemoryReviewDbs, decideMemoryReview, listMemoryReview } from './memory-review.js';
import { createProcessPresence } from '@spider/herdr/sessions/presence';
import { createSessionLeases, assessSessionLiveness, type ProcessIdentity, type ProcessInventoryPorts, type ProcessProbe } from '@spider/herdr/sessions/lease';
import { claimIdLock } from '@spider/herdr/sessions/id-lock';
import { readLaunchHandoff, removeLaunchHandoff } from '@spider/herdr/sessions/launch-handoff';
import { canonicalSessionFile, createTerminalRegistry, readPrivateJson, recordedExtensionArguments, withProcessLock } from '@spider/herdr/sessions/registry';
import { processStartTime } from '../../../subagents/src/process-identity.js';
import { fixtureProcessDomain } from './fixture-process-domain.js';
import { collectRemoteChunks, createFileLogSink, type LogSink, type RemoteLogLocation, type CollectedLogs } from '@spider/herdr/remote/transfer';
import { sha256, type RuntimeRequest } from '@spider/herdr/remote/runtime';
import { checkRemoteNodeVersion, isRuntimeRootProbe } from '@spider/herdr/remote/node-version';
import type { JobMonitorOptions } from '@spider/herdr/jobs/monitor';
import { readChildJobJournals } from '@spider/herdr/jobs/handoff';
import type { HcClient, HerdrConfig, JobRecord, JobId, Owner, RunId, SessionId } from '@spider/herdr';
import type { HostViewOptions } from './views.js';
import type { HostDataSourceOptions } from './data-source.js';
import { HerdrError, object } from '@spider/herdr/client/parse';
import { resolveMachine } from './machine.js';
import { HERDR_NOTICES, duplicateSessionNotice, installedModMismatchNotice, rollbackForeignPanesNotice, switchedSessionNotice } from '@spider/herdr/notices';

export function disabledHerdrEnvironment(env: Readonly<NodeJS.ProcessEnv>): Readonly<NodeJS.ProcessEnv> {
  const next = { ...env };
  try { const descriptor = JSON.parse(next[SSH_DESCRIPTOR_ENV] ?? 'null'); if (typeof descriptor?.shimDirectory === 'string') { const separator = process.platform === 'win32' ? ';' : ':'; next.PATH = next.PATH?.split(separator).filter(path => path !== descriptor.shimDirectory).join(separator); } } catch { /* Disabled means an inherited malformed policy is ignored, not activated. */ }
  delete next[SSH_DESCRIPTOR_ENV];
  return ordinaryExecutionEnvironment(next);
}

export { createViewerPorts } from '../../../herdr/src/viewers/ports.js';

import { createProcessInventory } from "./process-inventory";
export { createProcessInventory, isPiProcessRow } from "./process-inventory";

export { lockParticipant, type ParticipantLockOptions } from "./participant-lock";

export function explicitExtensionArguments(argv: readonly string[]): readonly string[] {
  const args: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--') break;
    if (argv[i] === '--extension' || argv[i] === '-e') {
      if (!argv[i + 1]) throw new HerdrError('launch-environment-invalid', 'Missing explicit extension path');
      const path = argv[++i]; args.push('--extension', resolveLaunchSource(path, process.cwd()));
    } else if (launchFlagTakesValue(argv[i])) i++;
  }
  return recordedExtensionArguments(args);
}

function missingTransportFile(error: unknown): boolean {
  const e = error as { code?: string; kind?: string; message?: string; details?: { stderr?: string; stdout?: string } };
  if (['ENOENT', 'not_found', 'file-not-found'].includes(e.code ?? e.kind ?? '')) return true;
  if ((e.code ?? e.kind) === 'invalid_params' && e.message?.includes('ENOENT')) return true;
  if (e.code === 'cli-exit') for (const raw of [e.details?.stderr, e.details?.stdout]) {
    try { const parsed = JSON.parse(raw ?? 'null'); if (parsed?.error && missingTransportFile(parsed.error)) return true; } catch { /* Non-JSON CLI failure is a real transport failure. */ }
  }
  return false;
}

async function noticeLogTail(path: string): Promise<string> {
  const file = await open(path, fileFlags.O_RDONLY | (fileFlags.O_NOFOLLOW ?? 0));
  try {
    const info = await file.stat();
    if (!info.isFile()) throw new HerdrError('local-log-invalid', 'Job log is not a regular file');
    const length = Math.min(info.size, 16 * 1024), bytes = Buffer.alloc(length);
    const { bytesRead } = await file.read(bytes, 0, length, info.size - length);
    let text = bytes.subarray(0, bytesRead).toString('utf8');
    if (info.size > length) {
      const firstNewline = text.indexOf('\n');
      text = firstNewline < 0 ? '[long output line omitted]' : text.slice(firstNewline + 1);
    }
    text = scrubSecrets(stripVTControlCharacters(text).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '')).text;
    const lines = text.replace(/\n+$/, '').split('\n').slice(-5).join('\n');
    // Leave room for both streams in the monitor's 2 KiB summary budget.
    const encoded = Buffer.from(lines);
    return encoded.length <= 700 ? lines : `…${encoded.subarray(encoded.length - 697).toString('utf8').replace(/^\ufffd/, '')}`;
  } finally { await file.close(); }
}

async function noticeSummary(directory: string, complete: boolean): Promise<string> {
  try {
    const stdout = await noticeLogTail(join(directory, 'stdout.log'));
    const stderr = await noticeLogTail(join(directory, 'stderr.log'));
    return [complete ? '' : 'Remote output is incomplete.', stdout ? `stdout:\n${stdout}` : '', stderr ? `stderr:\n${stderr}` : ''].filter(Boolean).join('\n') || 'No output.';
  } catch {
    return complete ? 'Output summary unavailable. See the job logs.' : 'Remote output is incomplete. See the job logs.';
  }
}

async function legacyCancellation(job: JobRecord): Promise<'pending' | 'sent' | null> {
  try {
    const file = await open(join(job.localDirectory, '.spider-kill.json'), fileFlags.O_RDONLY | (fileFlags.O_NOFOLLOW ?? 0));
    try {
      const info = await file.stat(); if (!info.isFile() || info.size > 4096) return null;
      const marker: unknown = JSON.parse(await file.readFile('utf8'));
      if (!marker || typeof marker !== 'object' || !('version' in marker) || marker.version !== 1 || !('jobId' in marker) || marker.jobId !== job.id || !('nonce' in marker) || !('nonce' in job) || marker.nonce !== job.nonce || !('state' in marker) || !('expiresAt' in marker) || typeof marker.expiresAt !== 'number') return null;
      if (marker.state === 'sent') return 'sent';
      if (marker.state === 'pending' && Date.now() < marker.expiresAt) return 'pending';
      return null;
    } finally { await file.close(); }
  } catch { return null; }
}

export interface HostPortOptions {
  config: HerdrConfig; hc: HcClient; runtimeBytes: Buffer; runtimePath(on: string): string;
}
export interface HostHerdrPorts {
  outputCollector: JobMonitorOptions['outputCollector'];
  logReader(jobId: JobId, options?: { onData?: (text: string) => void }): { collect(): Promise<CollectedLogs>; dispose(): void };
  dispose(): void;
}
/** C and D read through one serialized collector and one log sink per durable job. */
export function createHostHerdrPorts(options: HostPortOptions): HostHerdrPorts {
  const collectors = new Map<JobId, { sink: LogSink; location: RemoteLogLocation; queue: Promise<void>; indexSeen: boolean }>();
  const get = async (job: JobRecord) => {
    const found = collectors.get(job.id); if (found) return found;
    const bytes = await options.hc.fileRead(job.machine, join(job.remoteDirectory, 'request.json'));
    const request = JSON.parse(bytes.toString()) as RuntimeRequest;
    if (request.version !== 1 || request.jobId !== job.id || ('nonce' in job && job.nonce && request.nonce !== job.nonce)) throw new HerdrError('runtime-request-invalid', 'Journal and runtime identity differ');
    const sink = await createFileLogSink(job.localDirectory);
    const collector = { sink, location: { on: job.machine, directory: job.remoteDirectory, jobId: job.id, nonce: request.nonce, requestSha256: sha256(bytes) }, queue: Promise.resolve() as Promise<void>, indexSeen: false };
    collectors.set(job.id, collector); return collector;
  };
  const collect = async (id: JobId, capture = true): Promise<CollectedLogs> => {
    const c = collectors.get(id); if (!c) throw new HerdrError('job-not-owned', 'No collector for this job');
    const transport = new Proxy(options.hc, { get(target, key) {
      if (key !== 'fileRead') { const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value; }
      return async (on: MachineName, path: string) => {
        try { const bytes = await target.fileRead(on, path); if (path === join(c.location.directory, 'index.json')) c.indexSeen = true; return bytes; }
        catch (error) {
          if (!missingTransportFile(error)) throw error;
          if (path === join(c.location.directory, 'index.json') && c.indexSeen) throw new HerdrError('remote-index-disappeared', 'A published remote index disappeared');
          throw new HerdrError('ENOENT', 'Remote output metadata has not been published yet');
        }
      };
    } });
    const operation = c.queue.then(() => collectRemoteChunks(transport, c.location, c.sink, { capture }));
    // The queue owns ordering, not the previous captured output.
    c.queue = operation.then(() => {}, () => {}); return operation;
  };
  return {
    outputCollector: {
      async prepare(program, job) {
        await mkdir(job.localDirectory, { recursive: true });
        for (const file of program.files) await options.hc.fileWrite(job.machine, file.path, file.bytes);
        const nonce = randomBytes(16).toString('hex');
        const request: RuntimeRequest = { version: 1, jobId: job.id, nonce, programNonce: program.files.find(f => f.path.endsWith('/.spider-program'))?.bytes.toString() ?? '', argv: program.argv, cwd: program.cwd, env: program.env, files: program.files.map(f => ({ path: f.path, sha256: f.sha256 })), releaseWindowMs: 10_000, ...(program.consoleDirectory ? { consoleDirectory: program.consoleDirectory } : {}) };
        const bytes = Buffer.from(JSON.stringify(request)), requestPath = join(job.remoteDirectory, 'request.json');
        await options.hc.fileWrite(job.machine, requestPath, bytes);
        await options.hc.fileWrite(job.machine, requestPath + '.sha256', Buffer.from(sha256(bytes)));
        await get(job);
        const { machine } = await resolveMachine(options.hc, options.config.machines, job.machine);
        return { nonce, program: { ...program, argv: [machine.nodePath ?? 'node', options.runtimePath(job.machine), requestPath] } };
      },
      async collect(job) {
        await get(job); const result = await collect(job.id, false);
        const receipt = result.receipt;
        const summary = await noticeSummary(job.localDirectory, result.complete);
        const annotated = receipt?.signalHint ? `Exit ${receipt.exitCode} (${receipt.signalHint} convention).\n${summary}` : summary;
        const legacy = receipt ? await legacyCancellation(job) : null;
        if (legacy === 'pending') return { complete: false, summary: annotated, receipt: null };
        return { complete: result.complete, summary: annotated, receipt: receipt ? { jobId: job.id, nonce: receipt.nonce, finish: { exitCode: receipt.exitCode, reason: legacy === 'sent' ? 'cancelled' : receipt.outcome, signal: receipt.signal ? (await import('node:os')).constants.signals[receipt.signal as NodeJS.Signals] : null, finishedAt: receipt.finishedAt } } : null };
      },
    },
    logReader(id, readerOptions) {
      let stdoutLength = 0, stderrLength = 0, disposed = false;
      return { async collect() {
        const result = await collect(id);
        const stdout = result.stdout.slice(stdoutLength), stderr = result.stderr.slice(stderrLength);
        stdoutLength = result.stdout.length; stderrLength = result.stderr.length;
        if (!disposed && stdout) readerOptions?.onData?.(stdout);
        if (!disposed && stderr) readerOptions?.onData?.(stderr);
        return result;
      }, dispose() { disposed = true; } };
    },
    dispose() { for (const c of collectors.values()) c.sink.finish(); collectors.clear(); },
  };
}

export async function openRunView(input: {
  owner: Owner; id: RunId; automatic: boolean; automaticEnabled: boolean; signal: AbortSignal; localCore: CoreId;
  route: { kind: 'local'; panes: Pick<AuxiliaryPaneActor, 'acquire' | 'release'>; identity(): Promise<CoreIdentity> }
    | { kind: 'presented'; connect(): Promise<Pick<PaneService, 'request' | 'stop'>> };
  isCurrent(): boolean;
}): Promise<TerminalHandle | null> {
  const active = () => !input.signal.aborted && input.isCurrent();
  if (!active() || input.automatic && !input.automaticEnabled) return null;
  if (input.route.kind === 'local') {
    if (input.owner.terminal.coreId !== input.localCore) return null;
    const identity = await input.route.identity();
    if (!active()) return null;
    if (identity.coreId !== input.owner.terminal.coreId || identity.socket !== input.owner.terminal.socket || identity.sessionNamespace !== input.owner.terminal.sessionNamespace)
      throw new HerdrError('core-mismatch', 'Presentation core identity changed');
    const reservation = await input.route.panes.acquire('subagent', input.id, input.owner, { signal: input.signal, timeoutMs: input.automatic ? 10000 : 30000,
      automatic: input.automatic, ownerRelative: !input.automatic });
    if (!active()) { if (reservation) await input.route.panes.release(reservation); return null; }
    return reservation ? { address: reservation.viewer, coreId: input.localCore } : null;
  }
  const service = await input.route.connect();
  try {
    if (!active()) return null;
    const reply = await service.request({ version: 1, op: 'open-auxiliary', operationId: randomUUID(), sessionId: input.owner.sessionId,
      generation: input.owner.generation, mode: input.automatic ? 'automatic' : 'explicit', view: { kind: 'subagent', runId: input.id } });
    const p = reply.kind === 'outcome' && reply.outcome.status === 'complete' ? reply.outcome.presentation : null;
    if (!active() || !p || p.mode !== 'proxy' || p.role !== 'subagent' || p.visibility !== 'visible' || p.launch !== 'acknowledged'
      || !p.proxy || p.proxy.includes('/') && !p.proxy.startsWith(`${input.localCore}/`)
      || p.target.kind !== 'subagent' || p.target.coreId !== input.owner.terminal.coreId || p.target.sessionId !== input.owner.sessionId
      || p.target.generation !== input.owner.generation || p.target.runId !== input.id) return null;
    return { address: p.proxy, coreId: input.localCore };
  } finally { await service.stop(); }
}

export interface HostHerdrOptions {
  packageRoot: string;
  views: HostViewOptions;
  actionContext(ctx: ExtensionContext): unknown;
  killAction?(ctx: ExtensionContext, id: string): Promise<unknown>;
  readConfig?(ctx: ExtensionContext): Promise<HerdrConfig | null>;
  dataSource?: Pick<HostDataSourceOptions, 'resolveRunDb' | 'openApprovalDbs' | 'readUsage' | 'scheduler'>;
  reportError?(error: unknown, notice?: string): void;
  admitted?(): boolean;
}

export async function readJobJournal(root: string, owner: Owner): Promise<readonly JournalJob[]> {
  const file = join(root, 'sessions', owner.sessionId, 'jobs.json');
  let jobs: JournalJob[] = [];
  try { const journal = JSON.parse(await readFile(file, 'utf8')) as { version: number; jobs: JournalJob[] }; if (journal.version !== 1 || !Array.isArray(journal.jobs)) throw new HerdrError('invalid-job-journal', 'Invalid job journal'); jobs = journal.jobs.filter(job => job.owner.sessionId === owner.sessionId); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  return [...jobs, ...(await readChildJobJournals(root, owner)).flatMap(journal => journal.jobs)];
}


export async function readAppLayout(binary: string, env: Readonly<NodeJS.ProcessEnv>): Promise<LayoutSnapshot> {
  const raw = await invokeAppCli(binary, ['ls'], env) as { spaces?: unknown };
  if (!Array.isArray(raw.spaces)) throw new HerdrError('app-disconnected', 'No read-only app space document');
  const spaces: LayoutSnapshot['spaces'] = raw.spaces.map((value: unknown) => {
    const space = value as { id?: unknown; name?: unknown; tabs?: unknown };
    if (typeof space.id !== 'string' || typeof space.name !== 'string' || !Array.isArray(space.tabs)) throw new HerdrError('invalid-reply', 'Malformed app space');
    return { id: space.id as LayoutSnapshot['spaces'][number]['id'], name: space.name, tabs: space.tabs.map((value: unknown) => {
      const tab = value as { id?: unknown; name?: unknown; terminals?: unknown };
      if (typeof tab.id !== 'string' || typeof tab.name !== 'string' || !Array.isArray(tab.terminals)) throw new HerdrError('invalid-reply', 'Malformed app tab');
      const terminals = tab.terminals.map(value => {
        const row = value as { terminal?: unknown };
        if (typeof row?.terminal !== 'string') throw new HerdrError('invalid-reply', 'Malformed app terminal');
        return { terminal: row.terminal as TerminalAddress };
      });
      return { id: tab.id as LayoutSnapshot['spaces'][number]['tabs'][number]['id'], name: tab.name, ownerSessionId: null, terminal: terminals[0]?.terminal ?? null, terminals };
    }) };
  });
  return { spaces };
}

export async function verifiedHerdrFile(journalRoot: string, file: InstallFile): Promise<void> {
  await withSetupLock(journalRoot, async () => {
    await assertSetupNotUndoing(journalRoot);
    const journal = await readJournal(journalRoot);
    await validateFiles([file], journal, false);
    await prepareBackups(journalRoot, [file], journal);
    await applyFiles(journalRoot, [file], journal); await saveJournal(journalRoot, journal);
  });
}
export async function coreStartedAt(binary: string, env: Readonly<NodeJS.ProcessEnv>): Promise<number> {
  const status = await invokeCli(binary, ['server', 'status', '--json'], env) as { pid?: unknown };
  if (!Number.isSafeInteger(status.pid)) throw new HerdrError('core-epoch-unavailable', 'Core status has no verifiable process identity');
  const start = processStartTime(status.pid as number);
  if (!start) throw new HerdrError('core-epoch-unavailable', 'Core start identity cannot be read');
  if (start.startsWith('posix:')) {
    const epoch = Date.parse(start.slice(6) + ' UTC'); if (Number.isFinite(epoch)) return epoch;
  }
  // Linux boot time plus start ticks is the kernel's process epoch, not a guessed timestamp.
  if (start.startsWith('linux:')) {
    const boot = /^btime (\d+)$/m.exec(await readFile('/proc/stat', 'utf8'));
    const hz = Number(execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }).trim());
    if (boot && hz > 0) return Number(boot[1]) * 1000 + Number(start.slice(6)) * 1000 / hz;
  }
  throw new HerdrError('core-epoch-unavailable', 'Unsupported core start identity');
}
async function assetFiles(root: string): Promise<{ relative: string; bytes: Buffer }[]> {
  const result: { relative: string; bytes: Buffer }[] = [];
  const walk = async (directory: string, prefix: string) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new HerdrError('asset-symlink', 'Installation sources must not be symlinks');
      if (entry.isDirectory()) await walk(join(directory, entry.name), prefix + entry.name + '/');
      else if (entry.isFile() && !entry.name.endsWith('.d.ts') && entry.name !== 'jsconfig.json') result.push({ relative: prefix + entry.name, bytes: await readFile(join(directory, entry.name)) });
    }
  };
  await walk(root, ''); return result;
}
import { relativeImports, rewriteImportPrefix } from './imports.js';
export { rewriteImportPrefix } from './imports.js';

type StagedFile = Pick<InstallFile, 'path' | 'bytes' | 'mode' | 'terminalKeys' | 'keys' | 'observedTargetHash'>;

const nativeKeyCandidates: Readonly<Record<string, KeySections>> = {
  '0.1.13': { terminal: { 'cmd-f': 'terminal.search' }, global: { 'cmd-m': 'window.minimize' } },
  '0.1.16': { terminal: { 'cmd-f': 'terminal.search', 'cmd-a': 'terminal.select_all' }, global: { 'cmd-m': 'window.minimize' } },
};
function pendingNativeKeys(release: string, bytes: Buffer | null): KeySections {
  let current: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(bytes?.toString('utf8') ?? '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid key map');
    current = parsed as Record<string, unknown>;
  } catch { throw new HerdrError('key-binding-conflict', 'The keys file is malformed'); }
  const sections = Object.values(current).filter((value): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value));
  return Object.fromEntries(Object.entries(nativeKeyCandidates[hasNativeLookFeatures(release) ? '0.1.16' : release] ?? {}).flatMap(([section, bindings]) => {
    const missing = Object.fromEntries(Object.entries(bindings).filter(([key]) => !sections.some(value => Object.hasOwn(value, key))));
    return Object.keys(missing).length ? [[section, missing]] : [];
  }));
}

export function createProductionHerdrCliPorts(packageRoot: string, env: Readonly<NodeJS.ProcessEnv> = process.env, additionalPatches: AdditionalLookPatches = {}): HerdrCliPorts & { spacePorts(request: SetupRequest): SpaceSetupPorts; roamPresentations(): Promise<RoamPresentationPorts>; dispose(): Promise<void> } {
  const globalRoot = env.SPIDER_GLOBAL_ROOT ?? paths.globalRoot;
  let panes: Promise<PaneRuntime> | undefined;
  const paneRuntime = () => panes ??= (async () => {
    const request = await readRequest();
    const endpointBytes = await readFile(join(packageRoot, 'dist/herdr/pane-endpoint.mjs'));
    return createPaneRuntime({ config: request.config, hc: client(request), packageRoot, env, endpointBytes });
  })();
  const warnedConfig = new Set<string>();
  const clients = new Map<string, ReturnType<typeof createHcClient>>();
  const client = (request: SetupRequest<HerdrConfig>) => {
    const key = request.config.core.binary;
    let hc = clients.get(key); if (!hc) { hc = createHcClient({ binary: key, env }); clients.set(key, hc); } return hc;
  };
  const appEnv = (request: SetupRequest) => ({ ...env, HERDR_APP_HOME: request.config.app.home });
  const toastAvailable = async (release: string | undefined, appHome: string) => release ? (await planToastFiles(release, appHome, join(packageRoot, 'packages/herdr/assets/toast'))).length > 0 : false;
  const additionalFor = (release: string | undefined) => isSpacesALookVersion(release) ? additionalPatches[release] ?? {} : {};
  const auxiliaryModIds = (selected: (LookPatchSet & { crossMachine?: CrossMachineLookRecipe }) | undefined) => [
    ...PANE_ENTRY_MODS.filter(name => selected?.crossMachine || name === 'spider-pane-waiting'),
    ...(selected?.mods.menu ? ['spider-menu'] : []),
    ...(selected?.crossMachine || additionalFor(selected?.upstreamVersion)['new-menu'] ? ['spider-new-menu'] : []),
  ];
  const modNames = (selected: (LookPatchSet & { crossMachine?: CrossMachineLookRecipe }) | undefined, hasToast: boolean) => [
    'agents', 'spaces', 'pane', 'tabs', 'panel', 'chrome', 'picker',
    ...auxiliaryModIds(selected).map(name => name.slice('spider-'.length)),
    ...(hasToast ? ['toast'] : []),
  ];
  const filesFor = async (files: readonly StagedFile[], context: SetupContext): Promise<InstallFile[]> => Promise.all(files.map(async file => ({ ...file, expected: file.terminalKeys || file.keys ? (await snapshot(file.path)).hash : context.installed[file.path] ?? null, collision: file.terminalKeys || file.keys ? 'key' as const : 'clone' as const })));
  const panelFiles = async (release?: string, paneEnabled = false) => {
    const assets = join(packageRoot, 'packages/herdr/assets');
    const files = await assetFiles(join(assets, 'mods/spider'));
    const main = files.find(file => file.relative === 'main.js');
    if (!main) throw new HerdrError('picker-assets-missing', 'The packaged panel is incomplete');
    // The native records patch Spider-owned sources, not built-in mod copies.
    for (const patch of [...(hasNativeLookFeatures(release) ? ['native-panel-0.1.16.json'] : []), ...(paneEnabled ? ['pane-panel-b.json'] : [])]) {
      const patches = JSON.parse(await readFile(join(assets, 'look', patch), 'utf8')) as LookPatch[];
      main.bytes = Buffer.from(applyModPatches({ 'main.js': main.bytes.toString('utf8') }, patches, 'panel')['main.js']);
    }
    return files;
  };
  const pickerFiles = async (request: SetupRequest, context: SetupContext, fonts: Awaited<ReturnType<typeof prepareFonts>>['families'], modIds: readonly string[], inspection = false, release?: string): Promise<{ path: string; bytes: Buffer; mode?: number }[]> => {
    const assets = join(packageRoot, 'packages/herdr/assets'), mods = join(request.config.app.home, 'mods');
    const picker = context.modProps.find(copy => copy.props.modId === 'spider-picker');
    if (!picker || resolve(picker.directory) !== resolve(mods, 'spider-picker')) throw new HerdrError('missing-mod-id', 'Picker needs validated installed mod props');
    for (const name of ['feedRoot', 'cliPath', 'nodePath', 'appBinary', 'configPath'] as const) {
      const value = picker.props[name];
      if (typeof value !== 'string' || !isAbsolute(value) || value.includes('\0')) throw new HerdrError('invalid-mod-path', `Picker ${name} must be an absolute path`);
    }
    const configPath = join(picker.directory, 'config.json'), current = await snapshot(configPath);
    if (!inspection && current.bytes !== null && current.mode !== 0o600) throw new HerdrError('picker-config-insecure', 'Set mode 0600 on the picker config, then rerun setup');
    let sources: Awaited<ReturnType<typeof assetFiles>>;
    try { sources = await assetFiles(join(assets, 'picker')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new HerdrError('picker-assets-missing', 'The packaged picker is incomplete'); throw error; }
    if (['main.js', 'model.js', 'mod.json'].some(name => !sources.some(file => file.relative === name))) throw new HerdrError('picker-assets-missing', 'The packaged picker is incomplete');
    if (sources.some(file => file.relative === 'config.json')) throw new HerdrError('picker-assets-invalid', 'Picker config must be generated during setup');
    const references: { path: string; root: string; specifier: string }[] = [];
    const paneEnabled = modIds.includes('spider-machine-picker');
    const pickerPatches = hasNativeLookFeatures(release) ? JSON.parse(await readFile(join(assets, 'look/native-picker-0.1.16.json'), 'utf8')) as LookPatch[] : [];
    if (paneEnabled) {
      const nativeOnly = pickerPatches.findIndex(patch => patch.id === 'picker-native-no-service');
      if (nativeOnly >= 0) pickerPatches.splice(nativeOnly, 1);
      pickerPatches.push(...JSON.parse(await readFile(join(assets, 'look/pane-picker-b.json'), 'utf8')) as LookPatch[]);
    }
    const files: { path: string; bytes: Buffer; mode?: number }[] = sources.map(file => {
      const path = join(picker.directory, file.relative), source = file.bytes.toString('utf8');
      const rewritten = file.relative.endsWith('.js') ? rewriteImportPrefix(source, '../shared/', './shared/', path) : { source, references: [] };
      for (const specifier of rewritten.references) references.push({ path, root: picker.directory, specifier });
      const output = file.relative === 'main.js' ? applyModPatches({ 'main.js': rewritten.source }, pickerPatches, 'native picker')['main.js'] : rewritten.source;
      return { path, bytes: file.relative.endsWith('.js') ? Buffer.from(output) : file.bytes };
    });
    const shared = await assetFiles(join(assets, 'shared')), agents = await assetFiles(join(assets, 'agents'));
    const navSource = shared.find(file => file.relative === 'navigation.js'), children = agents.find(file => file.relative === 'children.js')?.bytes;
    if (!navSource || !children) throw new HerdrError('picker-assets-missing', 'The packaged picker dependencies are incomplete');
    const navigation = rewriteImportPrefix(navSource.bytes.toString('utf8'), '../agents/children.js', '../spider-children.js', join(assets, 'shared/navigation.js'));
    if (navigation.references.length !== 1) throw new HerdrError('picker-assets-invalid', 'Navigation needs one declared children import');
    let navigationSource = hasNativeLookFeatures(release)
      ? applyModPatches({ 'navigation.js': navigation.source }, JSON.parse(await readFile(join(assets, 'look/native-navigation-0.1.16.json'), 'utf8')) as LookPatch[], 'native navigation')['navigation.js']
      : navigation.source;
    if (modIds.includes('spider-machine-picker')) navigationSource = applyModPatches({ 'navigation.js': navigationSource }, JSON.parse(await readFile(join(assets, 'look/pane-navigation-b.json'), 'utf8')) as LookPatch[], 'pane navigation')['navigation.js'];
    for (const name of ['spider-agents', 'spider-panel', 'spider-picker']) {
      const directory = join(mods, name);
      if (!context.modProps.some(copy => copy.props.modId === name && resolve(copy.directory) === resolve(directory))) throw new HerdrError('missing-mod-id', `Missing validated mod props: ${name}`);
      const navPath = join(directory, 'shared/navigation.js');
      files.push({ path: join(directory, 'spider-children.js'), bytes: children }, { path: navPath, bytes: Buffer.from(navigationSource) });
      references.push({ path: navPath, root: directory, specifier: navigation.references[0] });
    }
    for (const name of ['diamond', 'heptagon', 'hexagon', 'octagon', 'pentagon', 'star', 'triangle']) files.push({ path: join(picker.directory, `space-${name}.svg`), bytes: await readFile(join(assets, 'agents', `space-${name}.svg`)) });
    const config = { ...picker.props, version: 1, fonts, machines: request.config.machines, ...(paneEnabled ? { paneServiceConfigured: true } : {}), retention: { completedRows: request.config.limits.completedRows, completedHours: request.config.limits.completedHours } };
    files.push({ path: configPath, mode: 0o600, bytes: Buffer.from(JSON.stringify(config, null, 2) + '\n') });
    files.push(...await planPaneModFiles({ assetsRoot: assets, appHome: request.config.app.home, nodePath: picker.props.nodePath, cliPath: picker.props.cliPath, fonts, modIds }));
    const available = new Set([...files.map(file => resolve(file.path)), ...['feed.js', 'look.js', 'open-failure.js', 'presentations.js', ...(paneEnabled ? ['pane-service-state.js'] : [])].map(name => resolve(picker.directory, 'shared', name))]);
    for (const reference of references) {
      const target = resolve(dirname(reference.path), reference.specifier), root = resolve(reference.root);
      if (!target.startsWith(root + sep) || !available.has(target)) throw new HerdrError('picker-import-unresolved', `Unresolved installed import: ${reference.specifier}`);
    }
    return files;
  };
  const unreachableRuntimeMachines = async (request: SetupRequest): Promise<MachineName[]> => {
    if (!request.config.machines.length) return [];
    const inventory = await client(request).machines();
    const connected = new Set(inventory.filter(machine => machine.state === 'connected').flatMap(machine => [machine.name, machine.id] as string[]));
    return request.config.machines.filter(machine => !connected.has(machine.name)).map(machine => machine.name);
  };
  const targets = async (request: SetupRequest) => {
    const identity = await client(request).identity(); const epoch = await coreStartedAt(request.config.core.binary, env);
    return request.config.machines.map(machine => ({ machine: machine.name, nodePath: machine.nodePath ?? 'node', coreStartedAt: `${identity.coreId}:${epoch}` }));
  };
  const probe = async (request: SetupRequest, launch: HcRunRequest): Promise<string> => {
    const hc = client(request), stream = hc.events(); await stream.ready;
    let address: TerminalAddress | null = null;
    try {
      const terminal = await hc.run(launch); address = terminal.address;
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const row = await stream.lookup(address); if (row?.state === 'finished') { if (row.exitCode !== 0) throw new HerdrError('probe-failed', 'Destination probe failed'); return (await hc.read(address, { lines: 100 })).trim(); }
        await new Promise<void>(resolve => setTimeout(resolve, 25));
      }
      throw new HerdrError('probe-timeout', 'Destination Node probe did not finish');
    } finally { if (address) { await hc.kill(address).catch(() => {}); await hc.rm(address).catch(() => {}); } await stream.dispose(); }
  };
  const spacePorts = (request: SetupRequest): SpaceSetupPorts => {
    const root = join(request.config.globalRoot, 'herdr'), inventory = createProcessInventory(root, request.dryRun), registry = createTerminalRegistry(root);
    const hc = client(request), app = createAppClient({ binary: request.config.app.binary, env: appEnv(request) });
    return { journalRoot: join(root, 'spaces'), app, registry, processInventory: inventory,
      coreIdentity: () => hc.identity(),
      listSessionFiles: async () => {
        const directory = join(request.config.agentDirectory, 'sessions');
        const files: string[] = [];
        const walk = async (root: string): Promise<void> => {
          let entries; try { entries = await readdir(root, { withFileTypes: true }); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
          for (const entry of entries) { if (entry.isDirectory()) await walk(join(root, entry.name)); else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(join(root, entry.name)); }
        };
        await walk(directory); return files;
      },
      layoutSnapshot: () => readAppLayout(request.config.app.binary, appEnv(request)),
      launcher: { nodePath: process.execPath, cliPath: join(packageRoot, 'dist/herdr/cli.mjs'), configPath: request.configPath }, clock: Date.now,
      waitForChange: (deadline, signal) => new Promise<void>(resolve => { let timer: ReturnType<typeof setTimeout>; const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); }; timer = setTimeout(done, Math.max(0, Math.min(250, deadline - Date.now()))); signal.addEventListener('abort', done, { once: true }); if (signal.aborted) done(); }),
      reportLive: records => { for (const record of records) process.stderr.write(`Close session ${record.sessionName ?? record.sessionId ?? '(unnamed)'} (PID ${record.pid}) before cutover.\n`); },
      reportBlocked: message => process.stderr.write(message + '\n'),
      reportSkipped: count => process.stderr.write(`Skipped ${count} unreadable or invalid session files.\n`),
      notesDisabled: async () => rootNotesValue((await snapshot(request.config.core.config)).bytes) === false,
      terminalState: async placement => { try { return (await hc.get(placement.terminal)).state; } catch (error) { if (missingTransportFile(error)) return 'absent'; throw error; } },
      terminalLabels: async address => (await hc.get(address)).labels,
      observedPresentation: async (target, execution, snapshot) => {
        const state = await inspectPanePlacement(join(request.config.globalRoot, 'roam', 'placement'));
        const candidates = state.presentations.filter(p => p.mode === 'proxy' && p.role === 'agent' && p.visibility === 'visible' && p.launch === 'acknowledged' && p.conversion === null && p.proxy && p.slot && p.target.kind === 'session' && p.target.generation && p.target.sessionId === target.sessionId && p.target.address === execution.terminal);
        if (candidates.length !== 1) return null;
        const presentation = candidates[0], local = await hc.identity();
        if (presentation.target.coreId === local.coreId) return null;
        const address = presentation.proxy!, parts = address.split('/');
        if (parts.length === 2 && parts[0] !== local.coreId) return null;
        const localAddress = (parts.length === 2 ? parts[1] : address) as TerminalAddress;
        const observed = snapshot.spaces.flatMap(space => space.tabs.flatMap(tab => tabTerminals(tab).filter(row => {
          const parts = row.terminal.split('/');
          return (parts.length === 1 ? parts[0] : parts.length === 2 && parts[0] === local.coreId ? parts[1] : null) === localAddress;
        }).map(row => ({ space: space.id, tab: tab.id, address: row.terminal, ownerSessionId: row.ownerSessionId }))));
        if (observed.length !== 1 || observed[0].space !== presentation.slot!.space || observed[0].tab !== presentation.slot!.tab || (observed[0].ownerSessionId && observed[0].ownerSessionId !== target.sessionId)) return null;
        let terminal: Awaited<ReturnType<typeof hc.get>>;
        try { terminal = await hc.get(localAddress); }
        catch (error) { if (error instanceof HerdrError && error.code === 'not_found') return null; throw error; }
        if (terminal.state !== 'live' || terminal.labels[HERDR_LABELS.kind] !== HERDR_KINDS.paneProxy || terminal.labels[HERDR_LABELS.paneId] !== presentation.id || terminal.labels[HERDR_LABELS.targetCore] !== presentation.target.coreId || terminal.labels[HERDR_LABELS.targetTerminal] !== presentation.target.terminalId) return null;
        return observed[0].address;
      },
      reportLayout: message => process.stderr.write(message + '\n'),
      liveSessionFeed: async target => {
        if (!target.sessionId || /[/\\\0]/.test(target.sessionId) || target.sessionId === '.' || target.sessionId === '..') return null;
        try {
          const value = await readPrivateJson(join(root, 'sessions', target.sessionId, 'session.json'));
          const feed = value === null ? null : parseFeed(JSON.stringify(value));
          if (!feed || feed.sessionId !== target.sessionId || !await sessionFeedIsFresh(root, feed, Date.now())) return null;
          const core = await hc.identity();
          return feed.owner.terminal.coreId === core.coreId && feed.owner.terminal.socket === core.socket && feed.owner.terminal.sessionNamespace === core.sessionNamespace ? feed : null;
        } catch { return null; }
      },
      verifyOwner: async (target, placement, signal) => {
        const deadline = Date.now() + 30_000;
        const controller = new AbortController();
        const abort = () => controller.abort(); signal?.addEventListener('abort', abort, { once: true });
        try { for (;;) {
        if (signal?.aborted) throw new HerdrError('aborted', 'Owner activation wait aborted');
        try {
        const identity = await hc.identity();
        const terminal = await hc.get(placement.terminal);
        if (terminal.state !== 'live') throw new HerdrError('owner-terminal-finished', 'New owner terminal finished before activation');
        // After /new or /resume the same process can own a different session.
        const tabProcess = (await inventory.presence.list()).find(p => p.kind === 'top-level' && p.hcAddress === placement.terminal && p.sessionId !== null && p.sessionId !== target.sessionId);
        const tabProbe = tabProcess ? await inventory.probe(tabProcess.pid) : null;
        if (tabProcess && tabProbe?.kind === 'live' && tabProbe.startIdentity === tabProcess.startIdentity) throw new HerdrError('owner-session-switched', switchedSessionNotice());
        const mapping = (await registry.list()).find(mapping => mapping.owner.sessionId === target.sessionId && mapping.owner.sessionFile === target.file && mapping.owner.cwd === target.cwd && mapping.owner.terminal.coreId === identity.coreId && mapping.owner.terminal.socket === identity.socket && mapping.owner.terminal.sessionNamespace === identity.sessionNamespace && mapping.owner.terminal.address === placement.terminal);
        if (!mapping) throw new HerdrError('owner-activation-unconfirmed', 'New owner has no validated live mapping');
        const feed = parseFeed(await readFile(join(root, 'sessions', target.sessionId, 'session.json'), 'utf8'));
        if (!feed || feed.generation !== mapping.owner.generation || feed.owner.terminal.address !== placement.terminal || !await sessionFeedIsFresh(root, feed, Date.now())) throw new HerdrError('owner-activation-unconfirmed', 'New owner has no fresh generation-bound feed');
        const process = (await inventory.presence.list()).find(p => p.sessionId === target.sessionId && p.sessionFile === target.file && p.kind === 'top-level' && p.hcAddress === placement.terminal);
        if (!process || (await inventory.probe(process.pid)).kind !== 'live' || processStartTime(process.pid) !== process.startIdentity) throw new HerdrError('owner-activation-unconfirmed', 'New owner has no matching live process identity');
        return { pid: process.pid, startIdentity: process.startIdentity, sessionFile: target.file, sessionId: target.sessionId, cwd: target.cwd };
        } catch (error) {
          if (!missingTransportFile(error) && (!(error instanceof HerdrError) || error.code !== 'owner-activation-unconfirmed')) throw error;
          if (Date.now() >= deadline) throw new HerdrError('owner-activation-unconfirmed', 'New owner did not activate within 30 seconds');
          await new Promise<void>(resolve => { const done = () => { clearTimeout(timer); controller.signal.removeEventListener('abort', done); resolve(); }; const timer = setTimeout(done, Math.min(250, Math.max(0, deadline - Date.now()))); controller.signal.addEventListener('abort', done, { once: true }); if (controller.signal.aborted) done(); });
        }
        } } finally { signal?.removeEventListener('abort', abort); controller.abort(); }
      },
    };
  };
  const releaseLook = async (request: SetupRequest, stagedVersion?: string): Promise<LookPatchSet & { crossMachine?: CrossMachineLookRecipe }> => {
    let appVersion: string;
    try {
      const output = execFileSync(request.config.app.binary, ['--version'], { env: appEnv(request), encoding: 'utf8', timeout: 5000, maxBuffer: 4096, stdio: ['ignore', 'pipe', 'pipe'] });
      const match = /^herdr-app\s+(\S+)\s*$/.exec(output);
      if (!match) throw new Error('Unrecognized version output');
      appVersion = match[1];
    } catch { throw new HerdrError('upstream-version-unavailable', 'Cannot determine the installed Herdr app version'); }
    if (stagedVersion && appVersion !== stagedVersion) throw new HerdrError('upstream-version-mismatch', 'The Herdr version changed during setup; rerun setup');
    const selected = selectLookPatches(JSON.parse(await readFile(join(packageRoot, 'packages/herdr/assets/look/patches.json'), 'utf8')) as LookPatchSet, appVersion);
    if (!isSpacesALookVersion(appVersion)) return selected;
    let records: unknown;
    try { records = JSON.parse(await readFile(join(packageRoot, 'packages/herdr/assets/look/cross-machine-patches.json'), 'utf8')); }
    catch { throw new HerdrError('cross-machine-recipe-missing', 'The packaged cross-machine records are missing or unreadable'); }
    return { ...selected, crossMachine: selectCrossMachinePatches(records, appVersion) };
  };
  const optionalPickerLook = async (request: SetupRequest, stagedVersion?: string) => {
    try { return await releaseLook(request, stagedVersion); }
    catch (error) {
      if (error instanceof HerdrError && error.code === 'upstream-version-unavailable') return undefined;
      throw error;
    }
  };
  const pickerVersionMessage = 'Cross-machine picker was not installed or updated because the app version could not be determined. Existing picker files and bindings are left in place.';
  const desiredKeys = async (selected: (LookPatchSet & { crossMachine?: CrossMachineLookRecipe }) | undefined) => {
    const keys = JSON.parse(await readFile(join(packageRoot, 'packages/herdr/assets/keys.json'), 'utf8')) as Record<string, Record<string, KeyBinding>>;
    if (!selected?.crossMachine) {
      for (const key of ['cmd-t', 'cmd-d', 'cmd-shift-d']) delete keys.global?.[key];
      delete keys['layout:spider-glass']?.['cmd-shift-w'];
    }
    return keys;
  };
  const pickerBinding = (value: unknown): boolean => {
    if (typeof value === 'string') return value.startsWith('mod.open:spider-machine-picker') || value === 'spider-pane.close';
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const binding = value as { command?: unknown; args?: { name?: unknown } };
    return typeof binding.command === 'string' && (binding.command.startsWith('mod.open:spider-machine-picker') || binding.command === 'spider-pane.close' || binding.command === 'mod.open' && typeof binding.args?.name === 'string' && binding.args.name.startsWith('spider-machine-picker'));
  };
  const unknownPickerKeys = (bytes: Buffer | null, prior: KeySections | undefined): { ignored: KeyFields; retained: KeySections } => {
    const ignored = new Map<string, Set<string>>();
    const add = (section: string, key: string) => { const fields = ignored.get(section) ?? new Set<string>(); fields.add(key); ignored.set(section, fields); };
    add('layout:spider-glass', 'cmd-shift-w');
    for (const [section, bindings] of Object.entries(prior ?? {})) for (const [key, value] of Object.entries(bindings)) if (pickerBinding(value)) add(section, key);
    try {
      const current: unknown = JSON.parse(bytes?.toString('utf8') ?? '{}');
      if (current && typeof current === 'object' && !Array.isArray(current)) for (const [section, bindings] of Object.entries(current))
        if (bindings && typeof bindings === 'object' && !Array.isArray(bindings)) for (const [key, value] of Object.entries(bindings)) if (pickerBinding(value)) add(section, key);
    } catch { /* Key validation reports malformed input. */ }
    const retained: Record<string, Record<string, KeyBinding>> = {};
    for (const [section, fields] of ignored) for (const key of fields) {
      const binding = prior?.[section]?.[key];
      if (binding !== undefined) (retained[section] ??= {})[key] = binding;
    }
    return { ignored: Object.fromEntries([...ignored].map(([section, fields]) => [section, [...fields]])), retained };
  };
  const legacyPickerIssue = (request: SetupRequest, selected: LookPatchSet & { crossMachine?: CrossMachineLookRecipe }, journal: Awaited<ReturnType<typeof readJournal>>, bytes: Buffer | null) => {
    if (selected.crossMachine) return undefined;
    const bindings = [
      ['global', 'cmd-t', 'mod.open:spider-machine-picker'],
      ['global', 'cmd-d', 'mod.open:spider-machine-picker-right'],
      ['global', 'cmd-shift-d', 'mod.open:spider-machine-picker-down'],
      ['layout:spider-glass', 'cmd-shift-w', 'spider-pane.close'],
    ] as const;
    let current: Record<string, Record<string, unknown>> = {};
    try { current = JSON.parse(bytes?.toString('utf8') ?? '{}'); } catch { /* key validation reports malformed input */ }
    const owned = journal.entries.find(entry => entry.path === join(request.config.app.home, 'keys.json'))?.keys;
    const pickerNames: ReadonlySet<string> = new Set(PANE_ENTRY_MODS.filter(name => name !== 'spider-pane-waiting'));
    const pickerBinding = (value: unknown): boolean => {
      if (typeof value === 'string') return [...pickerNames].some(name => value === `mod.open:${name}`);
      if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
      const binding = value as { command?: unknown; args?: { name?: unknown } };
      return typeof binding.command === 'string' && ([...pickerNames].some(name => binding.command === `mod.open:${name}`) || binding.command === 'mod.open' && typeof binding.args?.name === 'string' && pickerNames.has(binding.args.name));
    };
    const relocated = current && typeof current === 'object' ? Object.entries(current).flatMap(([section, values]) => values && typeof values === 'object' && !Array.isArray(values) ? Object.entries(values).filter(([, value]) => pickerBinding(value)).map(([key]) => [section, key] as const) : [])[0] : undefined;
    const stale = bindings.find(([section, key, value]) => current?.[section]?.[key] === value || owned?.[section]?.[key] === value) ?? relocated;
    const modRoots = PANE_ENTRY_MODS.filter(name => name !== 'spider-pane-waiting').map(name => resolve(request.config.app.home, 'mods', name) + sep);
    const oldFile = journal.entries.find(entry => modRoots.some(root => resolve(entry.path).startsWith(root)));
    if (!stale && !oldFile) return undefined;
    const command = [process.execPath, join(packageRoot, 'dist/herdr/cli.mjs'), 'rollback', '--config', request.configPath].map(shellQuote).join(' ');
    return { message: `Unsupported picker state on ${selected.upstreamVersion}: ${stale ? `${stale[0]}.${stale[1]}` : oldFile!.path}`, repair: `Run ${command}, then restore stock bindings or remove any remaining custom picker shortcuts before setup.` };
  };
  const stagedLook = async (request: SetupRequest, context: SetupContext, selection?: Awaited<ReturnType<typeof releaseLook>>, inspection = false): Promise<InstallFile[]> => {
    const assets = join(packageRoot, 'packages/herdr/assets');
    const patches = selection ?? await releaseLook(request), appVersion = patches.upstreamVersion;
    if (patches.crossMachine && (!patches.recipe || !patches.mods.menu)) throw new HerdrError('cross-machine-recipe-mismatch', 'Cross-machine setup needs the verified A recipe and menu clone');
    const additional = additionalFor(appVersion);
    const kinds: readonly (keyof HerdrClones)[] = [...lookCloneKinds, ...(patches.mods.menu ? ['menu' as const] : []), ...(patches.crossMachine || additional['new-menu'] ? ['new-menu' as const] : [])];
    const stock: Record<string, Record<string, string>> = {};
    const stockKinds = patches.recipe ? [...new Set(Object.keys(patches.recipe.sourceHashes).filter(name => name.startsWith('mods/')).map(name => name.split('/')[1]!))] : kinds;
    for (const kind of stockKinds) {
      let sources: Awaited<ReturnType<typeof assetFiles>>;
      try { sources = await assetFiles(join(request.config.app.home, 'mods', kind)); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new HerdrError('upstream-source-unknown', `Unverified ${appVersion} built-in: ${kind}`);
        throw error;
      }
      const files = Object.fromEntries(sources.map(file => [file.relative, file.bytes.toString()]));
      if (patches.recipe) {
        const known = Object.fromEntries(Object.entries(patches.recipe.sourceHashes).filter(([name]) => name.startsWith(`mods/${kind}/`)).map(([name, hash]) => [name.slice(`mods/${kind}/`.length), hash]));
        if (Object.keys(files).length !== Object.keys(known).length || Object.entries(files).some(([name, bytes]) => digest(Buffer.from(bytes)) !== known[name])) throw new HerdrError('upstream-source-unknown', `Unverified ${appVersion} built-in: ${kind}`);
      }
      stock[kind] = files;
    }
    const clones = {} as HerdrClones;
    for (const kind of kinds) clones[kind] = { name: kind === 'workspace-chrome' ? 'spider-chrome' : `spider-${kind}`, clonedFrom: { name: kind, version: appVersion }, files: stock[kind]! };
    let patched = await applyLookPatches(clones, patches.crossMachine || additional['new-menu'] ? { ...patches, mods: { ...patches.mods, 'new-menu': [] } } : patches, { requireCompleteSources: true });
    for (const derived of patches.recipe?.derivedFiles ?? []) {
      const bytes = await readFile(join(assets, derived.asset));
      if (digest(Buffer.from(stock[derived.sourceMod]?.[derived.sourceFile] ?? '')) !== derived.sourceHash || digest(bytes) !== derived.outputHash) throw new HerdrError('derived-source-mismatch', `Unverified derived asset: ${derived.mod}/${derived.file}`);
      const clone = patched[derived.mod as keyof HerdrClones];
      if (clone) {
        clone.files = { ...clone.files, [derived.file]: bytes.toString('utf8') };
        clone.patchState = { version: 1, files: Object.fromEntries(Object.entries(clone.files).map(([file, source]) => [file, digest(Buffer.from(source))])) };
      }
    }
    if (patches.recipe) {
      for (const kind of kinds) for (const [file, bytes] of Object.entries(patched[kind]!.files)) if (digest(Buffer.from(bytes)) !== patches.recipe.outputHashes[`${kind}/${file}`]) throw new HerdrError('look-output-mismatch', `Recipe output differs: ${kind}/${file}`);
      if (patches.crossMachine) {
        const output = applyCrossMachinePatches(Object.fromEntries(crossMachineKinds.map(kind => [kind, patched[kind]!.files])), patches.crossMachine);
        for (const kind of crossMachineKinds) patched[kind] = { ...patched[kind]!, files: output[kind], patchState: { version: 1, files: Object.fromEntries(Object.entries(output[kind]).map(([file, source]) => [file, digest(Buffer.from(source))])) } };
      }
      patched = await applyLookPatches(patched, { version: 1, upstreamVersion: appVersion, mods: { agents: notificationAgentPatches, spaces: [], pane: [], tabs: [] } });
    }
    const fonts = await prepareFonts(request.config.fonts ?? {}, { bundledRoot: join(assets, 'fonts'), readFile });
    const files: StagedFile[] = [];
    for (const kind of kinds) for (const [name, source] of Object.entries(patched[kind]!.files)) files.push({ path: join(request.config.app.home, 'mods', patched[kind]!.name, name), bytes: Buffer.from(name === 'mod.json' ? JSON.stringify({ ...JSON.parse(source), clonedFrom: patched[kind]!.clonedFrom, patchState: patched[kind]!.patchState }) : source) });
    for (const file of await assetFiles(join(assets, 'agents'))) if (file.relative !== 'children.js') files.push({ path: join(request.config.app.home, 'mods/spider-agents', file.relative), bytes: file.bytes });
    files.push({ path: join(request.config.app.home, 'mods/spider-agents/sound.js'), bytes: await readFile(join(assets, 'mods/spider/sound.js')) });
    for (const file of await assetFiles(join(assets, 'spaces'))) files.push({ path: join(request.config.app.home, 'mods/spider-spaces', file.relative), bytes: file.bytes });
    files.push(...await pickerFiles(request, context, fonts.families, [...kinds.map(kind => patched[kind]!.name), ...auxiliaryModIds(patches)], inspection, appVersion));
    const toast = await planToastFiles(appVersion, request.config.app.home, join(assets, 'toast'));
    if (toast.length && !context.modProps.some(copy => copy.props.modId === 'spider-toast' && resolve(copy.directory) === resolve(request.config.app.home, 'mods/spider-toast'))) throw new HerdrError('missing-mod-id', 'Toast needs validated installed mod props');
    files.push(...toast);
    for (const file of await assetFiles(join(assets, 'pane'))) files.push({ path: join(request.config.app.home, 'mods/spider-pane', file.relative), bytes: file.bytes });
    for (const file of await assetFiles(join(assets, 'tabs'))) files.push({ path: join(request.config.app.home, 'mods/spider-tabs', file.relative), bytes: file.bytes });
    const props = Object.fromEntries(context.modProps.map(copy => {
      const kind = copy.props.modId.replace(/^spider-/, '');
      return [kind, { ...copy.props, fonts: fonts.families, machines: request.config.machines,
        ...(patches.crossMachine && ['agents', 'panel'].includes(kind) ? { paneServiceConfigured: true } : {}),
        ...(['agents', 'spaces'].includes(kind) ? { labelFont: fonts.families.label } : {}),
        ...(kind === 'pane' ? { pathFont: fonts.families.paths } : {}),
        ...(['panel', 'agents'].includes(kind) ? { notifications: { sound: request.config.notifications?.sound !== false }, retention: { completedRows: request.config.limits.completedRows, completedHours: request.config.limits.completedHours } } : {}),
      }];
    }));
    const current = JSON.parse(await readFile(join(request.config.app.home, 'layouts/main.json'), 'utf8'));
    const layoutPath = join(request.config.app.home, 'layouts/spider-glass.json');
    const installedLayout = await snapshot(layoutPath);
    let previous: unknown;
    if (installedLayout.bytes) {
      try { previous = JSON.parse(installedLayout.bytes.toString('utf8')); }
      catch (error) {
        // A malformed layout has no value to carry forward. The replace guard still applies.
        if (!(error instanceof SyntaxError)) throw error;
      }
    }
    const layout = buildGlassLayout(current, { release: appVersion, menu: patched.menu?.name, windowBlur: request.config.look?.windowBlur, agents: 'spider-agents', spaces: 'spider-spaces', pane: 'spider-pane', tabs: 'spider-tabs', spider: 'spider-panel', chrome: 'spider-chrome', toast: toast.length ? 'spider-toast' : undefined, bodyFont: fonts.families.body, autoHideTabs: request.config.look?.autoHideTabs, props: { ...props, spider: props.panel } }, previous);
    files.push({ path: layoutPath, bytes: Buffer.from(JSON.stringify(layout, null, 2)), observedTargetHash: installedLayout.hash });
    for (const font of fonts.files) files.push({ path: join(request.config.app.home, 'fonts', font.fileName), bytes: font.bytes });
    for (const copy of context.modProps.filter(copy => copy.props.modId !== 'spider-toast')) for (const name of ['feed.js', 'look.js', 'open-failure.js', 'presentations.js', ...(patches.crossMachine && ['spider-agents', 'spider-panel', 'spider-picker'].includes(copy.props.modId) ? ['pane-service-state.js'] : [])]) files.push({ path: join(copy.directory, 'shared', name), bytes: await readFile(join(assets, 'shared', name)) });
    const mods = join(request.config.app.home, 'mods');
    const panel = (await panelFiles(appVersion, Boolean(patches.crossMachine))).map(file => ({ path: join(mods, 'spider-panel', file.relative), bytes: file.bytes }));
    for (const [kind, records] of Object.entries(additional) as [LookModKind, readonly LookPatch[]][]) {
      if (![...lookCloneKinds, 'menu', 'new-menu', 'picker'].includes(kind)) throw new HerdrError('invalid-look-patches', `Unknown additional mod: ${kind}`);
      const directory = join(mods, kind === 'workspace-chrome' ? 'spider-chrome' : `spider-${kind}`), prefix = directory + sep;
      const entries = files.filter(file => file.path.startsWith(prefix));
      const patchedFiles = applyModPatches(Object.fromEntries(entries.map(file => [file.path.slice(prefix.length), file.bytes.toString('utf8')])), records, kind);
      for (const file of entries) file.bytes = Buffer.from(patchedFiles[file.path.slice(prefix.length)]!);
      const manifest = entries.find(file => file.path === join(directory, 'mod.json'));
      if (!manifest) throw new HerdrError('invalid-look-patches', `Additional mod has no manifest: ${kind}`);
      manifest.bytes = Buffer.from(JSON.stringify({ ...JSON.parse(manifest.bytes.toString('utf8')), clonedFrom: { name: kind, version: appVersion }, patchState: { version: 1, files: Object.fromEntries(entries.filter(file => file !== manifest).map(file => [file.path.slice(prefix.length), digest(file.bytes)])) } }));
    }
    const staged = [...files, ...panel], available = new Set(staged.map(file => resolve(file.path)));
    if (patches.crossMachine) {
      const pickerMods = ['spider-machine-picker', 'spider-machine-picker-right', 'spider-machine-picker-down'];
      const helperCopies = {
        'pane/actions.js': ['spider-pane/actions.js', 'spider-menu/actions.js'],
        'pane/machine.js': ['spider-pane/machine.js', 'spider-menu/machine.js'],
        'machines/actions.js': [...['spider-pane', 'spider-tabs', 'spider-menu', 'spider-new-menu'].map(name => `${name}/machines/actions.js`), ...pickerMods.map(name => `${name}/actions.js`)],
        'machines/picker.js': pickerMods.map(name => `${name}/picker.js`),
      } as const;
      for (const [helper, copies] of Object.entries(helperCopies) as [keyof typeof helperCopies, readonly string[]][]) for (const copy of copies) {
        const path = join(mods, copy), matches = staged.filter(file => file.path === path);
        if (matches.length !== 1 || digest(matches[0]!.bytes) !== patches.crossMachine.helperHashes[helper]) throw new HerdrError('cross-machine-helper-mismatch', `Unverified cross-machine helper: ${helper} (${copy})`);
      }
    }
    for (const file of staged) {
      const name = relative(mods, file.path).split(sep)[0];
      if (!name.startsWith('spider-') || !file.path.endsWith('.js')) continue;
      const root = resolve(mods, name);
      for (const specifier of relativeImports(file.bytes.toString('utf8'), file.path)) {
        const target = resolve(dirname(file.path), specifier);
        if (!target.startsWith(root + sep) || !available.has(target)) throw new HerdrError('picker-import-unresolved', `Unresolved import in ${file.path}: ${specifier}`);
      }
    }
    return filesFor(files, context);
  };
  const templates = async (request: SetupRequest, context: SetupContext): Promise<InstallFile[]> => {
    const options: CreateModelRuntimeOptions = { authPath: join(request.config.agentDirectory, 'auth.json'), modelsPath: join(request.config.agentDirectory, 'models.json'), modelsStorePath: join(request.config.agentDirectory, 'models-cache.json'), allowModelNetwork: false };
    if (request.dryRun) {
      const base = import.meta.resolve('@earendil-works/pi-coding-agent');
      const { ReadOnlyAuthStorage } = await import(new URL('./core/auth-storage.js', base).href) as { ReadOnlyAuthStorage: new (path: string) => NonNullable<CreateModelRuntimeOptions['credentials']> };
      const { InMemoryCodingAgentModelsStore } = await import(new URL('./core/models-store.js', base).href) as { InMemoryCodingAgentModelsStore: new () => NonNullable<CreateModelRuntimeOptions['modelsStore']> };
      options.credentials = new ReadOnlyAuthStorage(options.authPath!);
      options.modelsStore = new InMemoryCodingAgentModelsStore();
      const cache = JSON.parse((await snapshot(options.modelsStorePath!)).bytes?.toString('utf8') ?? '{}') as Record<string, Parameters<NonNullable<CreateModelRuntimeOptions['modelsStore']>['write']>[1]>;
      for (const [provider, entry] of Object.entries(cache)) await options.modelsStore.write(provider, entry);
    }
    const runtime = await ModelRuntime.create(options);
    const registry = new ModelRegistry(runtime);
    const layer = readLayer(join(request.config.globalRoot, 'config.json'));
    if (layer.error) throw new HerdrError('global-config-invalid', layer.error);
    const rawDefaults = layer.config['models.defaults'];
    const defaults = rawDefaults && typeof rawDefaults === 'object' && !Array.isArray(rawDefaults) ? Object.fromEntries(Object.entries(rawDefaults).filter((entry): entry is [string, string] => typeof entry[1] === 'string')) : {};
    const instructions = join(request.config.globalRoot, 'herdr/instructions');
    const instructionPaths = { worker: join(instructions, 'worker.md'), reviewer: join(instructions, 'reviewer.md'), watcher: join(instructions, 'watcher.md') };
    const files = await readGlobalHerdrTemplateFiles({ globalModelDefaultLayers: () => ({ global: defaults }), modelRegistry: registry, templateDirectory: join(dirname(request.config.core.config), 'templates'), roleTemplateOptions: { piExecutable: 'pi', instructionPaths }, reportWarning: message => process.stderr.write(message + '\n') }, { strict: true });
    return filesFor(files.map(file => ({ path: file.path, bytes: Buffer.from(file.content) })), context);
  };
  type FallbackLook = { selection: Awaited<ReturnType<typeof releaseLook>>; files: readonly InstallFile[]; skipped: ReadonlySet<string> };
  const doctorParts = async (request: SetupRequest, fallback?: FallbackLook): Promise<DoctorParts> => ({ globalRoot, targets: () => targets(request), unreachableRuntimeMachines,
    placementRepairInspection: async () => {
      const hc = client(request), identity = await hc.identity();
      const app = createAppClient({ binary: request.config.app.binary, env: appEnv(request) });
      return { app: request.config.app.home, coreId: identity.coreId, placement: async viewer => {
        try { await hc.get(viewer); return await app.ownerPlacement(viewer); }
        catch (error) { if (error instanceof HerdrError && (error.code === 'not_found' || error.code === 'owner-unplaced')) return null; throw error; }
      } };
    }, launchHistory: async () => {
    const hc = createHcClient({ binary: request.config.core.binary, env });
    const stream = hc.events();
    try {
      const terminals = await new Promise<readonly import('@spider/herdr').TerminalSummary[]>((resolve, reject) => {
        let settled = false;
        const finish = (error?: Error, rows?: readonly import('@spider/herdr').TerminalSummary[]) => {
          if (settled) return; settled = true; clearTimeout(timer); unsubscribe();
          if (error) reject(error); else resolve(rows!);
        };
        const timer = setTimeout(() => finish(new HerdrError('events-timeout', 'Herdr did not send its terminal list')), 10_000);
        const unsubscribe = stream.subscribe(event => { if (event.type === 'snapshot' || event.type === 'missed') finish(undefined, event.terminals); });
        void stream.ready.catch(error => finish(error instanceof Error ? error : new Error(String(error))));
      });
      const launches: { argv: string[] }[] = []; let unavailable = false;
      for (const terminal of terminals.filter(t => t.labels[HERDR_LABELS.kind] || t.labels[HERDR_LABELS.space])) {
        if (typeof terminal.notify !== 'boolean') { unavailable = true; continue; }
        launches.push({ argv: terminal.notify ? ['run'] : ['run', '--no-notify'] });
      }
      if (launches.some(launch => !launch.argv.includes('--no-notify'))) return launches;
      return unavailable || !launches.length ? null : launches;
    } finally { stream.dispose(); await hc.dispose(); }
  }, probeMachineNode: (_target, launch) => probe(request, launch),
    probeRuntimeRoot: (_target, launch) => probe(request, launch),
    inspect: async (item, _request, runtimeAvailability) => {
      const failure = (code: string, message: string, repair = 'Run setup from a plain shell with the selected configuration.') => ({ failures: [{ item, code, message, repair }] });
      if (item === 'pane-core') {
        const status = object(await invokeCli(request.config.core.binary, ['server', 'status', '--json'], env));
        if (typeof status.version !== 'string' || !paneCoreVersionSupported(status.version)) return failure('pane-core-version', 'Pane support requires the proved hc floor 0.1.16 or newer.', 'Deploy a compatible hc and rerun doctor.');
        const inventory = object(await invokeCli(request.config.core.binary, ['machine', 'ls', '--json'], env));
        if (!Array.isArray(inventory.machines)) return { failures: [], warnings: [{ item, code: 'inspection-unavailable', message: 'Execution core versions could not be inspected.', repair: 'Reconnect the configured execution cores and rerun doctor.' }] };
        let unknown = false;
        for (const configured of request.config.machines) {
          const matches = inventory.machines.map(value => object(value)).filter(machine => machine.state === 'connected' && [configured.name, ...configured.aliases].includes(String(machine.name)));
          if (matches.length !== 1 || typeof matches[0].version !== 'string') { unknown = true; continue; }
          if (!paneCoreVersionSupported(matches[0].version)) return failure('pane-core-version', 'A configured execution core is below the proved hc floor.', 'Deploy a compatible hc and rerun doctor.');
        }
        return { failures: [], ...(unknown ? { warnings: [{ item, code: 'inspection-unavailable', message: 'Some configured core versions are unknown.', repair: 'Reconnect the configured execution cores and rerun doctor.' }] } : {}) };
      }
      if (item === 'pane-capabilities') {
        try { return inspectPaneCommands(await invokeAppCli(request.config.app.binary, ['commands'], appEnv(request), undefined, undefined, { timeoutMs: 5000 })); }
        catch { return inspectPaneCommands(null); }
      }
      if (item === 'pane-helper') return inspectPaneServiceState(join(request.config.globalRoot, 'herdr/panes'), async claim => {
        const hc = client(request), identity = await hc.identity();
        if (claim.coreId !== identity.coreId || claim.socket !== identity.socket || claim.sessionNamespace !== identity.sessionNamespace || claim.address.includes('/') && !claim.address.startsWith(identity.coreId + '/')) return false;
        const terminal = await hc.get(claim.address);
        return terminal.state === 'live' && terminal.labels['spider.kind'] === 'pane-service' && terminal.labels['spider.pane-operation'] === claim.operationId;
      });
      if (item === 'pane-installation') {
        const local = await inspectPaneInstallation('local', () => probeLocalPaneEndpoint(request.config.globalRoot, packageRoot));
        const bytes = await readFile(join(packageRoot, 'dist/herdr/pane-endpoint.mjs')).catch(() => null);
        if (!bytes) return local;
        const buildDigest = sha256(bytes), hc = client(request), transport = createArgvClient({ binary: request.config.core.binary, env });
        const inspectRemote = createPaneRemoteRequest({ buildDigest, exec: transport.exec, resolveMachine: async destination => {
          const configured = request.config.machines.find(machine => machine.name === destination.alias);
          const matches = (await hc.machines()).filter(machine => machine.id === destination.coreId && machine.state === 'connected' && configured && (machine.name === configured.name || machine.aliases.includes(configured.name) || configured.aliases.includes(machine.name)));
          if (matches.length !== 1 || !configured?.nodePath) throw new HerdrError('machine-changed', 'Endpoint diagnostic route is unavailable');
          return { on: matches[0].id!, coreId: matches[0].id!, nodePath: configured.nodePath };
        } });
        const failures = [...local.failures], warnings = [...local.warnings ?? []];
        for (const configured of request.config.machines) {
          if (runtimeAvailability?.shouldSkip(configured.name)) continue;
          const result = await inspectPaneInstallation(configured.name, async () => {
            const matches = (await hc.machines()).filter(machine => machine.state === 'connected' && (machine.name === configured.name || machine.aliases.includes(configured.name) || configured.aliases.includes(machine.name)));
            if (matches.length !== 1 || !matches[0].id) throw new HerdrError('machine-changed', 'Endpoint diagnostic route is unavailable');
            await inspectRemote({ coreId: matches[0].id, alias: configured.name, machineId: null }, { version: 1, op: 'handshake', protocol: 1, buildDigest });
          });
          failures.push(...result.failures); warnings.push(...result.warnings ?? []);
        }
        return { failures, warnings };
      }
      if (item === 'baseline') return checkNodeVersion(process.version) ? { failures: [] } : failure('node-baseline', 'Host Node is too old');
      if (item === 'core-identity' || item === 'hc-json') { await client(request).identity(); return { failures: [] }; }
      if (item === 'pi-schema-contrast') {
        const themePath = join(request.config.agentDirectory, 'themes/dracula-plus-glass.json');
        const data: unknown = JSON.parse(await readFile(themePath, 'utf8'));
        const url = new URL('./modes/interactive/theme/theme-schema.js', import.meta.resolve('@earendil-works/pi-coding-agent')).href;
        const { validateThemeJson } = await import(url) as { validateThemeJson(label: string, json: unknown): PiThemeData };
        let theme: PiThemeData;
        try { theme = validateThemeJson(themePath, data); } catch (error) { return failure('pi-theme-schema', error instanceof Error ? error.message : String(error)); }
        if (theme.name !== 'dracula-plus-glass' || JSON.parse((await snapshot(join(request.config.agentDirectory, 'settings.json'))).bytes?.toString() ?? '{}').theme !== 'dracula-plus-glass') return failure('pi-theme-selection', 'Pi does not select the installed dracula-plus-glass theme');
        const report = checkThemeContrast(theme);
        return report.failures.length ? failure('theme-contrast', 'Pi theme contrast check failed') : { failures: [] };
      }
      if (item === 'fonts') { const fonts = await prepareFonts(request.config.fonts ?? {}, { bundledRoot: join(packageRoot, 'packages/herdr/assets/fonts'), readFile }); for (const file of fonts.files) if (!(await snapshot(join(request.config.app.home, 'fonts', file.fileName))).bytes?.equals(file.bytes)) return failure('installed-font-mismatch', `Installed font or notice differs: ${file.fileName}`); return { failures: [] }; }
      if (item === 'spaces-tabs') { await preflightSpaces(request.config, spacePorts(request), { adoptExistingSpaces: request.adoptExistingSpaces }); return { failures: [] }; }
      const journal = await readJournal(request.journalRoot);
      const selected = item === 'keys' ? fallback ? undefined : await optionalPickerLook(request) : ['mods', 'clones', 'patch-version', 'layout-theme'].includes(item) ? fallback?.selection ?? await releaseLook(request) : undefined;
      const release = selected?.upstreamVersion;
      const hasToast = await toastAvailable(release, request.config.app.home);
      const context: SetupContext = { labelContract: HerdrLabelContract, installed: Object.fromEntries(journal.entries.map(entry => [entry.path, entry.after])), retiredTerminals: [], priorCutover: journal.cutover, recordCutover: async () => { throw new HerdrError('doctor-read-only', 'Doctor cannot record a cutover'); }, modProps: modNames(selected, hasToast).map(name => ({ directory: join(request.config.app.home, 'mods', `spider-${name}`), props: { modId: `spider-${name}`, feedRoot: join(request.config.globalRoot, 'herdr'), cliPath: join(packageRoot, 'dist/herdr/cli.mjs'), nodePath: process.execPath, appBinary: request.config.app.binary, configPath: request.configPath, labelContract: HerdrLabelContract } })) };
      const compareFiles = async (files: readonly InstallFile[]) => {
        for (const file of files) if (!(await snapshot(file.path)).bytes?.equals(file.bytes)) {
          if (item === 'mods' || item === 'clones') { const notice = installedModMismatchNotice(file.path); return failure('installed-artifact-changed', notice.message, notice.repair); }
          return failure('installed-artifact-changed', `Installed ${item} content differs: ${file.path}`);
        }
        return { failures: [] };
      };
      const loadingUnavailable = (names: readonly string[]) => ({ failures: [], warnings: names.map(name => ({ item, code: 'inspection-unavailable', message: `${name} source content matches; mod loading is not verified`, repair: `HERDR_APP_HOME=${shellQuote(join(request.journalRoot, 'headless-app-check'))} ${shellQuote(request.config.app.binary)} check ${shellQuote(join(request.config.app.home, 'mods', name))}` })) });
      if (item === 'mods') {
        const files: InstallFile[] = [];
        const configPath = join(request.config.app.home, 'mods/spider-picker/config.json'), config = await snapshot(configPath);
        if (config.bytes !== null && config.mode !== 0o600) return failure('picker-config-insecure', 'Picker config must have mode 0600', `Set mode 0600 on ${configPath}, then rerun doctor.`);
        for (const file of await panelFiles(release, Boolean(selected?.crossMachine))) files.push({ path: join(request.config.app.home, 'mods/spider-panel', file.relative), bytes: file.bytes, expected: null });
        for (const mod of context.modProps.filter(copy => copy.props.modId !== 'spider-toast')) for (const name of ['feed.js', 'look.js', 'open-failure.js', 'presentations.js', ...(selected?.crossMachine && ['spider-agents', 'spider-panel', 'spider-picker'].includes(mod.props.modId) ? ['pane-service-state.js'] : [])]) files.push({ path: join(mod.directory, 'shared', name), bytes: await readFile(join(packageRoot, 'packages/herdr/assets/shared', name)), expected: null });
        const toast = await planToastFiles(release!, request.config.app.home, join(packageRoot, 'packages/herdr/assets/toast'));
        files.push(...toast.map(file => ({ ...file, expected: null })));
        const fonts = await prepareFonts(request.config.fonts ?? {}, { bundledRoot: join(packageRoot, 'packages/herdr/assets/fonts'), readFile });
        try { for (const file of await pickerFiles(request, context, fonts.families, auxiliaryModIds(selected), false, release)) files.push({ ...file, expected: null }); }
        catch (error) { if (error instanceof HerdrError) return failure(error.code, error.message); throw error; }
        const staged = fallback ? new Map(fallback.files.map(file => [file.path, file])) : selected?.crossMachine || Object.keys(additionalFor(release)).length ? new Map((await stagedLook(request, context, undefined, true)).map(file => [file.path, file])) : new Map<string, InstallFile>();
        const effectiveFiles = files.filter(file => !fallback?.skipped.has(file.path)).map(file => staged.get(file.path) ?? file);
        const result = await compareFiles(effectiveFiles);
        if (result.failures.length) return result;
        const managedRoots = ['spider-picker', ...auxiliaryModIds(selected), ...(toast.length ? ['spider-toast'] : [])].map(name => resolve(request.config.app.home, 'mods', name) + sep);
        for (const file of files) if (!fallback?.skipped.has(file.path) && managedRoots.some(root => resolve(file.path).startsWith(root)) && (await snapshot(file.path)).hash !== context.installed[file.path]) {
          const notice = installedModMismatchNotice(file.path); return failure('installed-artifact-changed', notice.message, notice.repair);
        }
        return loadingUnavailable(['spider-panel', 'spider-picker', ...auxiliaryModIds(selected), ...(toast.length ? ['spider-toast'] : [])]);
      }
      if (item === 'clones') {
        const files = (fallback?.files ?? await stagedLook(request, context, undefined, true)).filter(file => /\/mods\/spider-(?:agents|spaces|pane|tabs|chrome|menu|new-menu|picker)\//.test(file.path));
        const result = await compareFiles(files);
        const names = [...new Set(files.map(file => relative(join(request.config.app.home, 'mods'), file.path).split(sep)[0]!))];
        return result.failures.length ? result : loadingUnavailable(names);
      }
      if (item === 'patch-version') {
        const patches = selected!;
        const expected = fallback?.files ?? await stagedLook(request, context, undefined, true);
        const kinds: readonly LookModKind[] = [...new Set<LookModKind>([...lookCloneKinds, ...(patches.mods.menu ? ['menu' as const] : []), ...(patches.crossMachine ? crossMachineKinds : []), ...Object.keys(additionalFor(release)) as LookModKind[]])];
        for (const kind of kinds) {
          const directory = join(request.config.app.home, 'mods', kind === 'workspace-chrome' ? 'spider-chrome' : `spider-${kind}`);
          if (fallback && fallback.skipped.has(join(directory, 'main.js'))) continue;
          const manifest = JSON.parse(await readFile(join(directory, 'mod.json'), 'utf8'));
          if (manifest.clonedFrom?.name !== kind || manifest.clonedFrom?.version !== patches.upstreamVersion || manifest.patchState?.version !== 1) return failure('upstream-version-mismatch', `Installed ${kind} clone has an unsupported patch or upstream version`);
          const path = join(directory, 'main.js'), source = await readFile(path, 'utf8');
          const staged = expected.find(file => file.path === path);
          if (!staged || !staged.bytes.equals(Buffer.from(source))) return failure('patch-marker-mismatch', `Installed ${kind} patches differ`);
        }
        return { failures: [] };
      }
      if (item === 'layout-theme') {
        const path = join(request.config.app.home, 'layouts/spider-glass.json'), layout = JSON.parse(await readFile(path, 'utf8'));
        if (layout.theme !== 'spider-glass') return failure('layout-theme-mismatch', 'Installed layout does not use spider-glass');
        const blur = hasNativeLookFeatures(release) && request.config.look?.windowBlur !== false;
        if (blur ? layout.window_blur !== true : Object.hasOwn(layout, 'window_blur')) return failure('window-blur-mismatch', 'Installed window blur differs from the verified release and configured preference');
        if (selected?.mods.menu && layout.terminal_menu !== 'spider-menu') return failure('menu-selector-mismatch', 'The layout does not select spider-menu');
        if (hasToast && layout.toast !== 'spider-toast') return failure('toast-selector-mismatch', 'The layout does not select spider-toast', 'Install the verified layout for this Herdr release and rerun doctor.');
        type LayoutContent = { mod?: string; props?: unknown; pane?: { header?: { content?: LayoutContent } } };
        const contents = (root: unknown) => {
          const found = new Map<string, unknown[]>();
          const content = (value: LayoutContent | undefined) => { if (value?.mod) found.set(value.mod, [...found.get(value.mod) ?? [], value.props]); if (value?.pane?.header?.content) content(value.pane.header.content); };
          const walk = (node: { content?: LayoutContent; children?: unknown[] }) => { content(node.content); for (const child of node.children ?? []) walk(child as typeof node); };
          walk(root as Parameters<typeof walk>[0]); return found;
        };
        const installed = contents(layout);
        for (const name of ['agents', 'spaces', 'pane', 'tabs', 'panel', 'chrome']) if (!installed.has(`spider-${name}`)) return failure('layout-mod-mismatch', `Installed layout omits spider-${name}`);
        const expectedFile = (fallback?.files ?? await stagedLook(request, context, undefined, true)).find(file => file.path === path);
        if (!expectedFile) return failure('layout-props-mismatch', 'Cannot determine expected layout props');
        const expected = contents(JSON.parse(expectedFile.bytes.toString('utf8')));
        for (const name of ['agents', 'spaces', 'pane', 'tabs', 'panel', 'chrome']) if (!isDeepStrictEqual(installed.get(`spider-${name}`), expected.get(`spider-${name}`))) return failure('layout-props-mismatch', `Installed spider-${name} props differ from the current configuration`);
        if (!(await snapshot(join(request.config.app.home, 'themes/spider-glass.json'))).bytes?.equals(await readFile(join(packageRoot, 'packages/herdr/assets/themes/spider-glass.json')))) return failure('app-theme-mismatch', 'Installed Herdr theme differs');
        const settings = JSON.parse((await snapshot(join(request.config.app.home, 'settings.json'))).bytes?.toString() ?? '{}');
        if (settings.theme !== undefined && settings.theme !== 'spider-glass' || settings.layout !== undefined && settings.layout !== 'spider-glass') return failure('app-selection-mismatch', 'App selection differs from spider-glass');
        const information: DoctorInformation[] = [
          { item, code: 'native-sound-policy', message: settings.sounds?.enabled === true ? 'Native automatic sounds are enabled by the user.' : settings.sounds?.enabled === false ? (hasToast ? 'Native automatic sounds are disabled and the derived toast is selected.' : 'Native automatic sounds are disabled; stock automatic toasts can still appear.') : 'Native automatic sound setting is not available.' },
          { item, code: 'intentional-sound-policy', message: `Intentional notification sounds are ${request.config.notifications?.sound === false ? 'disabled' : 'enabled'}.` },
        ];
        if (settings.theme === undefined || settings.layout === undefined) return { failures: [], information, warnings: [{ item, code: 'inspection-unavailable', message: 'Installed layout and theme are valid; active app selection is not exposed in settings', repair: 'Check the app layout and theme selection, then rerun doctor.' }] };
        return { failures: [], information };
      }
      if (item === 'keys') {
        const keyBytes = (await snapshot(join(request.config.app.home, 'keys.json'))).bytes;
        const issue = selected && legacyPickerIssue(request, selected, journal, keyBytes);
        if (issue) return failure('legacy-picker-binding', issue.message, issue.repair);
        const desired = await desiredKeys(selected);
        const pickerWarnings: DoctorFailure[] = selected ? [] : [{ item, code: 'picker-version-unavailable', message: pickerVersionMessage, repair: 'Make the app version available, then rerun setup and doctor.' }];
        const ignoredKeys = selected ? undefined : unknownPickerKeys(keyBytes, journal.entries.find(entry => entry.path === join(request.config.app.home, 'keys.json'))?.keys).ignored;
        const keyReport = checkManagedKeyBindings(keyBytes, desired, { ignoredKeys });
        if (keyReport.failures.length) return { ...keyReport, warnings: [...keyReport.warnings, ...pickerWarnings] };
        const nativeFailures: DoctorFailure[] = [], nativeWarnings: DoctorFailure[] = [];
        try {
          const reply = await invokeAppCli(request.config.app.binary, ['commands'], appEnv(request), undefined, undefined, { timeoutMs: 5000 }) as { commands?: unknown };
          if (!Array.isArray(reply?.commands) || reply.commands.some(row => !row || typeof row !== 'object' || typeof row.name !== 'string')) throw new Error('Native command list is unavailable');
          for (const name of ['mod.open', 'terminal.park', 'pane.close']) {
            const matches = reply.commands.filter(row => row.name === name);
            if (!matches.length) nativeFailures.push({ item, code: 'native-command-missing', message: `Native command is missing: ${name}`, repair: 'Use a supported Herdr release, then rerun doctor.' });
            else if (matches.length !== 1) throw new Error('Native command list is ambiguous');
            else if (name !== 'pane.close') {
              const args = matches[0].args;
              if (!Array.isArray(args)) throw new Error('Native command arguments are unavailable');
              const argument = name === 'mod.open' ? 'name' : 'terminal';
              if (!args.some(arg => arg && typeof arg === 'object' && arg.name === argument && arg.required === true)) nativeFailures.push({ item, code: 'native-command-mismatch', message: `${name} does not require ${argument}`, repair: 'Use a supported Herdr release, then rerun doctor.' });
            }
          }
        } catch { nativeWarnings.push({ item, code: 'inspection-unavailable', message: 'Managed keys match; native commands could not be inspected', repair: 'Open Herdr and rerun doctor to inspect its command list.' }); }
        nativeWarnings.push({ item, code: 'inspection-unavailable', message: 'The pane mod command dispatch is not verified', repair: 'Run the isolated Send back acceptance check before deploying it.' });
        const url = new URL('./core/keybindings.js', import.meta.resolve('@earendil-works/pi-coding-agent')).href;
        const { KeybindingsManager } = await import(url) as { KeybindingsManager: { create(directory: string): { getResolvedBindings(): Record<string, string | string[] | undefined> } } };
        const normalize = (key: string) => { const parts = key.toLowerCase().split('+'); const base = parts.pop()!; return [...['ctrl', 'shift', 'alt', 'super'].filter(mod => parts.includes(mod)), base].join('+'); };
        const resolved = KeybindingsManager.create(request.config.agentDirectory).getResolvedBindings();
        const bindings = Object.fromEntries(Object.entries(resolved).filter((entry): entry is [string, string | string[]] => entry[1] !== undefined).map(([action, keys]) => [action, typeof keys === 'string' ? normalize(keys) : keys.map(normalize)]));
        const collisions = inspectHerdrShortcutCollisions(bindings);
        return { failures: [...nativeFailures, ...collisions.filter(c => c.scope === 'editor').map(c => ({ item, code: 'pi-shortcut-collision', message: `${c.key} also binds ${c.action}`, repair: 'Choose another pi keybinding and reload the owner.' }))], warnings: [...keyReport.warnings, ...pickerWarnings, ...nativeWarnings, ...collisions.filter(c => c.scope === 'tree').map(c => ({ item, code: 'tree-view-key-collision', message: `${c.key} also binds ${c.action} in tree view`, repair: 'Leave tree view before using the spider shortcut, or change that pi binding.' }))] };
      }
      if (item === 'roles') {
        try { return await compareFiles(await templates(request, context)); }
        catch (error) {
          if (!(error instanceof HerdrError) || !['role-unresolved', 'catalog-unavailable'].includes(error.code)) throw error;
          return failure(error.code, error.message, error.code === 'role-unresolved' ? 'Choose an available configured model in global models.defaults, then rerun setup.' : 'Make an eligible catalog model available, then rerun setup.');
        }
      }
      if (item === 'resume') {
        const hookPath = join(request.config.globalRoot, 'herdr/resume.sh');
        const expected = Buffer.from(buildResumeBlock({ nodePath: process.execPath, cliPath: join(packageRoot, 'dist/herdr/cli.mjs'), configPath: request.configPath, hookPath }));
        if (managedProjection((await snapshot(request.config.shellRc)).bytes, { kind: 'resume' }) !== managedProjection(expected, { kind: 'resume' })) return failure('resume-block-mismatch', 'The marked resume block is missing or changed');
        if (!(await snapshot(hookPath)).bytes?.equals(await readFile(join(packageRoot, 'packages/herdr/assets/shell/resume.sh')))) return failure('resume-hook-mismatch', 'Installed resume hook differs');
        return { failures: [] };
      }
      if (item === 'runtime-digest') {
        const bytes = await readFile(join(packageRoot, 'dist/herdr/remote-runtime.mjs')), hash = digest(bytes);
        const failures: DoctorFailure[] = [];
        for (const machine of request.config.machines) {
          if (runtimeAvailability?.shouldSkip(machine.name)) continue;
          const path = runtimeInstallPath(machine.runtime.directory, bytes), recorded = journal.runtimes.find(runtime => runtime.machine === machine.name && runtime.path === path);
          try {
            if (recorded?.after !== hash || !(await client(request).fileRead(machine.name, path)).equals(bytes)) failures.push(...failure('runtime-digest-mismatch', `Installed runtime on ${machine.name} does not match this package`).failures);
          } catch (error) {
            if (!runtimeAvailability?.deferOnConnectivityFailure(machine.name, error)) throw error;
          }
        }
        return { failures };
      }
      if (item === 'jobs') {
        const root = jobJournalRoot(request.config.globalRoot), information: DoctorInformation[] = [];
        const directories = async (path: string) => {
          try { return (await readdir(path, { withFileTypes: true })).filter(entry => entry.isDirectory() && /^[a-zA-Z0-9_-]{1,160}$/.test(entry.name)); }
          catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
        };
        const machines = new Map<string, { count: number; code: string; firstAt: number; lastAt: number }>();
        for (const session of await directories(join(root, 'sessions'))) {
          const sessionId = session.name as SessionId;
          const stores = [createJobStore(root, sessionId), ...(await directories(join(root, 'sessions', session.name, 'runs'))).map(run => createJobStore(root, sessionId, run.name as RunId))];
          for (const store of stores) {
            let journal;
            try { journal = await store.read({ readOnly: true }); }
            catch { information.push({ item, code: 'job-journal-unreadable', message: `Could not read job journal ${store.path}.` }); continue; }
            for (const job of journal.jobs) {
              if (!job.cleanupFailure || job.terminalReleased) continue;
              const failure = job.cleanupFailure, previous = machines.get(job.machine);
              machines.set(job.machine, { count: (previous?.count ?? 0) + 1, code: previous && previous.lastAt > failure.lastAt ? previous.code : failure.code, firstAt: Math.min(previous?.firstAt ?? failure.firstAt, failure.firstAt), lastAt: Math.max(previous?.lastAt ?? failure.lastAt, failure.lastAt) });
            }
          }
        }
        const clean = (text: string) => text.replace(/[^a-zA-Z0-9_.-]/g, '?').slice(0, 160);
        for (const [machine, failure] of machines) information.push({ item, code: 'cleanup-retrying', message: `${failure.count} terminal${failure.count === 1 ? '' : 's'} on ${clean(machine)} ${failure.count === 1 ? 'is' : 'are'} waiting for cleanup. Last failure ${clean(failure.code)}. Oldest failure at ${failure.firstAt} ms since epoch. Retries run while each owning session is open.` });
        return { failures: [], information };
      }
      if (item === 'status-instance') return { failures: [], warnings: [{ item, code: 'inspection-unavailable', message: 'The native status instance cannot be inspected from a standalone shell', repair: 'Inspect an active interactive owner and rerun doctor.' }] };
      if (['feed-permissions', 'feed-freshness', 'ipc-authentication'].includes(item)) {
        const mappings = await createTerminalRegistry(join(request.config.globalRoot, 'herdr')).list();
        if (!mappings.length) return { failures: [], warnings: [{ item, code: 'live-owner-unavailable', message: 'No fresh live owner is available for this check', repair: 'Start an installed interactive owner and rerun doctor.' }] };
        const failures: DoctorFailure[] = [], information: DoctorInformation[] = [];
        for (const mapping of mappings) {
          const writer = await feedWriterLiveness(join(request.config.globalRoot, 'herdr'), mapping.owner.sessionId);
          if (writer.kind === 'dead') {
            if (item === 'feed-freshness') information.push({ item, code: 'feed-owner-ended', message: `Feed for ${mapping.owner.sessionId} was left by a session that ended without quitting; retained as information.` });
            continue;
          }
          const path = join(request.config.globalRoot, 'herdr/sessions', mapping.owner.sessionId, 'session.json');
          const missing = () => failures.push(...failure('feed-stale', `Owner feed for ${mapping.owner.sessionId} is missing`).failures);
          let contents: string;
          try { contents = await readFile(path, 'utf8'); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; missing(); continue; }
          const feed = parseFeed(contents);
          if (!feed || feed.generation !== mapping.owner.generation || feed.owner.terminal.address !== mapping.owner.terminal.address || !await sessionFeedIsFresh(join(request.config.globalRoot, 'herdr'), feed, Date.now())) {
            failures.push(...failure('feed-stale', `Owner feed for ${mapping.owner.sessionId} is stale or has a different generation`).failures); continue;
          }
          if (item === 'feed-freshness') continue;
          if (item === 'feed-permissions') {
            try { for (const file of [path, dirname(path)]) if ((await stat(file)).mode & 0o077) failures.push(...failure('feed-permissions', 'Owner feed permissions allow other users').failures); }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; missing(); }
            continue;
          }
          if (!feed.ipc) { failures.push(...failure('ipc-unavailable', 'The owner has no authenticated IPC descriptor').failures); continue; }
          const ipc = createSessionIpcClient({ version: 1, sessionId: feed.sessionId, generation: feed.generation, ...feed.ipc });
          try { const ping = await ipc.ping(); if (!ping.ok) failures.push(...failure(ping.code, ping.message).failures); } finally { ipc.dispose(); }
        }
        return { failures, ...(information.length ? { information } : {}) };
      }
      return { failures: [], warnings: [{ item, code: 'inspection-unavailable', message: `No live ${item} evidence is available`, repair: 'Start a configured owner and rerun doctor.' }] };
    },
  });
  const readRequest = async (configPath?: string): Promise<SetupRequest<HerdrConfig>> => {
    const settings = configValues(process.cwd(), undefined, globalRoot);
    for (const warning of settings.warnings.filter(message => /^herdr\.(config|enabled) /.test(message))) {
      if (!warnedConfig.has(warning)) { warnedConfig.add(warning); process.stderr.write((warning.startsWith('herdr.config ') ? HERDR_NOTICES.repoConfig.text : HERDR_NOTICES.repoEnabled.text) + '\n'); }
    }
    let path = configPath;
    if (!path) {
      const layer = readLayer(join(globalRoot, 'config.json'));
      if (layer.error) throw new HerdrError('invalid-config', layer.error);
      const configured = settings.config['herdr.config'];
      if (configured !== undefined && typeof configured !== 'string') throw new HerdrError('invalid-config', 'Global herdr.config must be a path string');
      path = configured ? resolve(globalRoot, configured) : standardHerdrConfigPath(globalRoot);
    }
    const config = parseHerdrConfig({ ...JSON.parse(await readFile(path, 'utf8')), enabled: settings.config['herdr.enabled'] } as unknown);
    return { config, configPath: resolve(path), packageRoot, journalRoot: join(config.globalRoot, 'herdr/setup') };
  };
  return {
    spacePorts,
    async roamPresentations() {
      const selected = await readRequest();
      return createRoamPresentationPorts({ config: selected.config, env, client: () => client(selected), runtime: paneRuntime });
    },
    panes: async request => { const runtime = await paneRuntime(); const connection = await runtime.connect(); try { return await connection.request(request); } finally { await connection.stop(); } },
    servePanes: async () => (await paneRuntime()).serve(),
    proxyPane: async input => (await paneRuntime()).proxy(input),
    remotePane: async request => { const bytes = await readFile(join(packageRoot, 'dist/herdr/pane-endpoint.mjs')); const source = createProductionPaneEndpointPorts(sha256(bytes), env, packageRoot); try { return await handleRemotePaneRequest(request, source); } finally { await source.dispose?.(); } },
    assertAgentDirectory: async request => {
      const sameEnvironment = ['PI_CODING_AGENT_DIR', 'PI_PACKAGE_DIR', 'HOME', 'USERPROFILE'].every(key => env[key] === process.env[key]);
      // A caller can supply a distinct shell environment. Ask pi in that environment
      // rather than mutating process.env or duplicating pi's path normalization.
      const agentDir = sameEnvironment ? getAgentDir() : execFileSync(process.execPath, ['--input-type=module', '-e', `import { getAgentDir } from ${JSON.stringify(import.meta.resolve('@earendil-works/pi-coding-agent'))}; process.stdout.write(getAgentDir());`], { env: { ...env }, encoding: 'utf8', timeout: 10_000 });
      const configured = resolve(request.config.agentDirectory), effective = resolve(agentDir);
      const canonical = (path: string) => realpath(path).catch(() => path);
      if (await canonical(configured) !== await canonical(effective))
        throw new HerdrError('agent-directory-mismatch', `Configured agentDirectory ${configured} differs from pi's effective agent directory ${effective}. Change agentDirectory in ${request.configPath} to ${effective}, or set PI_CODING_AGENT_DIR to ${configured}.`);
    },
    request: async configPath => {
      const request = await readRequest(configPath);
      if (request.config.mode === 'core-only') throw new CoreOnlySetupError({ ...request, config: request.config });
      return { ...request, config: request.config };
    },
    async setupParts(request) {
      let preparedSpaces: SpaceSetupPorts | undefined;
      const getSpaces = () => preparedSpaces ??= spacePorts(request);
      const stagedVersions = new WeakMap<SetupContext, Awaited<ReturnType<typeof releaseLook>>>();
      let fallbackContext: SetupContext | undefined, fallbackLook: FallbackLook | undefined;
      // Root probes made during this setup run. Verification reuses them instead of launching another per machine.
      const rootProbes = new Map<string, string>(), rootKey = (launch: HcRunRequest) => JSON.stringify([launch.on, launch.argv]);
      const probeRoot = async (launch: HcRunRequest) => { const output = await probe(request, launch); rootProbes.set(rootKey(launch), output); return output; };
      const selectApp = async () => {
        for (const [name, args] of [['layout.switch', { name: 'spider-glass' }], ['app.theme', { name: 'spider-glass' }]] as const) { const reply = await getSpaces().app.command(name, args); if (reply.error) throw new HerdrError(reply.error.code, reply.error.message); }
      };
      const runSpaces = async (request: SetupRequest, context: SetupContext, selectLook: boolean) => {
        const spaces = getSpaces();
        const aborter = new AbortController(), abort = () => aborter.abort();
        process.once('SIGINT', abort); process.once('SIGTERM', abort);
        let result;
        try { result = await setupSpaces(request.config, spaces, { adoptExistingSpaces: request.adoptExistingSpaces, signal: aborter.signal }); }
        finally { process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort); }
        const recovery = result.conflicts?.length ? await readCutoverRecovery(spaces.journalRoot) : null;
        const owners = recovery ? recovery.entries.flatMap(entry => entry.result ? [entry.result] : []) : result.launched;
        const cutover = { terminals: result.tabs.map(tab => tab.terminal), identities: Object.fromEntries(owners.map(owner => [owner.sessionId, owner.startIdentity])) };
        if (selectLook && !result.conflicts?.length) await selectApp();
        await context.recordCutover(cutover);
        if (result.conflicts?.length) throw new HerdrError('duplicate-live-session', result.conflicts.map(conflict => duplicateSessionNotice(conflict.sessionId, conflict.terminals)).join('\n'));
        return cutover;
      };
      return { globalRoot, get hc() { return client(request); },
        validateSelections: async () => {
          if ((await snapshot(join(request.config.app.home, 'keys.json'))).bytes === null) throw new HerdrError('keys-defaults-missing', missingKeyMapMessage);
          await discoverSessions(request.config, getSpaces());
        },
        pendingNativeKeys: async request => {
          const bytes = (await snapshot(join(request.config.app.home, 'keys.json'))).bytes;
          return bytes === null ? {} : pendingNativeKeys((await releaseLook(request)).upstreamVersion, bytes);
        },
        preflight: async () => {
          const spaces = getSpaces(), hc = client(request);
          rootProbes.clear();
          // This exported G check is before any backup or asset/config staging.
          await preflightSpaces(request.config, spaces, { adoptExistingSpaces: request.adoptExistingSpaces });
          const identity = await hc.identity(), layoutSnapshot = await spaces.layoutSnapshot(), recovery = await readCutoverRecovery(spaces.journalRoot, layoutSnapshot, request.config, spaces), saved = await readJournal(request.journalRoot);
          let recoveredCutover: import('@spider/herdr/setup/installer').CutoverResult | undefined, cutoverProvedAbsent = false;
          if (saved.cutoverPending) {
            const verified: import('@spider/herdr/spaces/cutover').LaunchedSession[] = [];
            for (const entry of recovery.entries) {
              if (recovery.conflicts?.some(conflict => conflict.sessionId === entry.target.sessionId) || recovery.unplacedSessions?.includes(entry.target.sessionId)) continue;
              const state = await spaces.terminalState!(entry.placement);
              if (state === 'live') { verified.push(entry.confirmedLive && entry.result ? entry.result : await spaces.verifyOwner(entry.target, entry.placement)); continue; }
              const live = await assessSessionLiveness(entry.target.file, selectedProcessInventory(request.config, spaces.processInventory));
              const process = entry.result ? await spaces.processInventory.probe(entry.result.pid) : null;
              if (live.kind !== 'free' || process?.kind === 'unknown' || process?.kind === 'live' && process.startIdentity === entry.result!.startIdentity) throw new HerdrError('cutover-reconciliation-required', 'A recorded tab still has a possible session owner');
            }
            for (const intent of recovery.pendingIntents ?? []) if ((await assessSessionLiveness(intent.target.file, selectedProcessInventory(request.config, spaces.processInventory))).kind !== 'free') throw new HerdrError('cutover-reconciliation-required', 'An unresolved allocation still has a possible writer');
            cutoverProvedAbsent = verified.length === 0 && !recovery.conflicts?.length && !recovery.unplacedSessions?.length;
            recoveredCutover = { terminals: recovery.createdTabs.map(tab => tab.terminal), identities: Object.fromEntries(recovery.entries.flatMap(entry => { const result = verified.find(r => r.sessionId === entry.target.sessionId) ?? entry.result; return result ? [[result.sessionId, result.startIdentity]] : []; })) };
          } else if (recovery.recoveredCutover) recoveredCutover = { terminals: recovery.createdTabs.map(tab => tab.terminal), identities: Object.fromEntries(recovery.recoveredCutover.launched.map(owner => [owner.sessionId, owner.startIdentity])) };
          const patchBytes = await readFile(join(packageRoot, 'packages/herdr/assets/look/patches.json'));
          const selected = await releaseLook(request), release = selected.upstreamVersion;
          const issue = legacyPickerIssue(request, selected, saved, (await snapshot(join(request.config.app.home, 'keys.json'))).bytes);
          if (issue) throw new HerdrError('legacy-picker-binding', `${issue.message}. ${issue.repair}`);
          const hasToast = await toastAvailable(release, request.config.app.home);
          const patchInputs = [patchBytes];
          if (selected.crossMachine) patchInputs.push(Buffer.from(JSON.stringify(selected.crossMachine)));
          if (Object.keys(additionalFor(release)).length) patchInputs.push(Buffer.from(JSON.stringify(additionalFor(release))));
          return { recoveredCutover, cutoverProvedAbsent, cutoverNeedsRecheck: recovery.layoutAdoptionNeeded, cutoverActions: await planSpaceCutover(request.config, spaces, { snapshot: layoutSnapshot, recovery }), fingerprint: digest(Buffer.concat(patchInputs)), coreIdentity: identity, mods: modNames(selected, hasToast).map(name => ({ directory: join(request.config.app.home, 'mods', `spider-${name}`) })), targets: await targets(request), retiredTerminals: saved.cutoverPending ? saved.retiredTerminals : (await spaces.registry.list()).filter(mapping => mapping.owner.terminal.coreId === identity.coreId && mapping.owner.terminal.socket === identity.socket && !recovery.createdTabs.some(tab => tab.terminal === mapping.owner.terminal.address)).map(mapping => mapping.owner.terminal.address), layoutExport: true };
        },
        stageLook: async (request, context) => {
          stagedVersions.delete(context); fallbackContext = undefined; fallbackLook = undefined;
          const selected = await releaseLook(request);
          const files = await stagedLook(request, context, selected);
          stagedVersions.set(context, selected);
          return files;
        },
        finalizeLook: async (request, context, staged) => {
          if (fallbackContext !== context) return staged;
          const original = stagedVersions.get(context)!;
          const selection = { ...original, crossMachine: undefined };
          const pickerNames: ReadonlySet<string> = new Set(PANE_ENTRY_MODS.filter(name => name !== 'spider-pane-waiting'));
          const aContext = { ...context, modProps: context.modProps.filter(copy => !pickerNames.has(copy.props.modId) && (copy.props.modId !== 'spider-new-menu' || !!additionalFor(selection.upstreamVersion)['new-menu'])) };
          const files = await stagedLook(request, aContext, selection), mods = join(request.config.app.home, 'mods');
          const preservedRoots: string[] = [], preservedFiles = new Set<string>();
          if (original.crossMachine) for (const kind of crossMachineKinds) {
            const root = join(mods, `spider-${kind}`);
            let preserveRoot = false;
            for (const name of ['main.js', 'mod.json']) {
              const path = join(root, name), current = (await snapshot(path)).bytes, expected = files.find(file => file.path === path);
              if (current && expected && !current.equals(expected.bytes)) preserveRoot = true;
              else if (current && !expected) preservedFiles.add(resolve(path));
            }
            if (preserveRoot) preservedRoots.push(resolve(root) + sep);
            else for (const name of ['actions.js', 'machine.js', 'machines/actions.js']) if ((await snapshot(join(root, name))).bytes !== null) preservedFiles.add(resolve(root, name));
          }
          const skipped = new Set(files.filter(file => {
            const path = resolve(file.path), relativePath = relative(mods, path).split(sep).join('/');
            return preservedRoots.some(root => path.startsWith(root)) || preservedFiles.has(path) || /^spider-(?:pane|tabs|menu|new-menu)\/machines\/actions\.js$/.test(relativePath) || /^spider-menu\/(?:actions|machine)\.js$/.test(relativePath);
          }).map(file => file.path));
          fallbackLook = { selection, files: files.filter(file => !skipped.has(file.path)), skipped };
          return fallbackLook.files;
        },
        installFiles: async (request, context) => {
          const assets = join(packageRoot, 'packages/herdr/assets'), files: { path: string; bytes: Buffer; terminalKeys?: Readonly<Record<string, string>>; keys?: KeySections }[] = [];
          const stagedVersion = stagedVersions.get(context);
          const selected = request.nativeKeys === 'accept' && !stagedVersion ? await releaseLook(request) : await optionalPickerLook(request, stagedVersion?.upstreamVersion);
          for (const file of await panelFiles(stagedVersion?.upstreamVersion ?? selected?.upstreamVersion, Boolean(selected?.crossMachine))) files.push({ path: join(request.config.app.home, 'mods/spider-panel', file.relative), bytes: file.bytes });
          files.push({ path: join(request.config.agentDirectory, 'themes/dracula-plus-glass.json'), bytes: await readFile(join(assets, 'themes/dracula-plus-glass.json')) }, { path: join(request.config.app.home, 'themes/spider-glass.json'), bytes: await readFile(join(assets, 'themes/spider-glass.json')) });
          if (!selected) { if (stagedVersion) fallbackContext = context; process.stderr.write(pickerVersionMessage + '\n'); }
          const keys = await desiredKeys(selected);
          const keyPath = join(request.config.app.home, 'keys.json'), currentKeys = await snapshot(keyPath);
          if (request.nativeKeys === 'accept' && selected) {
            const offered = pendingNativeKeys(selected.upstreamVersion, currentKeys.bytes);
            for (const [section, bindings] of Object.entries(offered)) Object.assign(keys[section] ??= {}, bindings);
          }
          const preserved = selected ? undefined : unknownPickerKeys(currentKeys.bytes, (await readJournal(request.journalRoot)).entries.find(entry => entry.path === keyPath)?.keys);
          for (const [section, fields] of Object.entries(preserved?.ignored ?? {})) for (const key of fields) delete keys[section]?.[key];
          const settingsPath = join(request.config.app.home, 'settings.json'), settings = await snapshot(settingsPath);
          let parsed: unknown;
          try { parsed = JSON.parse(settings.bytes?.toString('utf8') ?? '{}'); } catch { throw new HerdrError('invalid-app-settings', 'App settings must be a JSON object'); }
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new HerdrError('invalid-app-settings', 'App settings must be a JSON object');
          const appSettings = parsed as Record<string, unknown>, rawSounds = appSettings.sounds;
          if (rawSounds !== undefined && (!rawSounds || typeof rawSounds !== 'object' || Array.isArray(rawSounds))) throw new HerdrError('invalid-app-settings', 'App settings sounds must be an object');
          const sounds = (rawSounds ?? {}) as Record<string, unknown>;
          if (sounds.enabled !== undefined && typeof sounds.enabled !== 'boolean') throw new HerdrError('invalid-app-settings', 'App settings sounds.enabled must be boolean');
          const bytes = Buffer.from(JSON.stringify({ ...appSettings, sounds: { ...sounds, enabled: false } }, null, 2) + '\n');
          return [...await filesFor(files, context), { path: keyPath, expected: currentKeys.hash, bytes: Buffer.alloc(0), keys, retainedKeys: preserved?.retained, ignoredKeys: preserved?.ignored, collision: 'key' as const }, { path: settingsPath, expected: settings.hash, bytes, updateAfterCutover: true, managed: { kind: 'json-paths' as const, paths: ['theme', 'layout', 'sounds.enabled'] } }];
        }, generateTemplates: (request, context) => templates(request, context),
        installResume: async (request, context) => {
          const hookPath = join(request.config.globalRoot, 'herdr/resume.sh'), current = await snapshot(request.config.shellRc);
          let block: string;
          try { block = buildResumeBlock({ nodePath: process.execPath, cliPath: join(packageRoot, 'dist/herdr/cli.mjs'), configPath: request.configPath, hookPath, existingRc: current.bytes?.toString() }); }
          catch (error) {
            if (error instanceof HerdrError && error.code === 'resume-hook-conflict' && context.installed[request.config.shellRc]) throw new HerdrError('managed-artifact-changed', `Restore the single recorded spider resume block in ${request.config.shellRc}, then rerun setup. Unrelated shell edits are preserved.`);
            throw error;
          }
          return [...await filesFor([{ path: hookPath, bytes: await readFile(join(packageRoot, 'packages/herdr/assets/shell/resume.sh')) }], context), { path: request.config.shellRc, expected: current.hash, managed: { kind: 'resume' as const }, bytes: Buffer.from(block) }];
        },
        probeMachineNode: (_target, launch) => probe(request, launch),
        paneEndpointPlan: request => planPaneEndpointInstallation(request.config.globalRoot, packageRoot),
        stagePaneEndpoint: request => stagePaneEndpointInstallation(request.config.globalRoot, packageRoot),
        unreachableRuntimeMachines,
        ensureRuntime: async request => {
          const bytes = await readFile(join(packageRoot, 'dist/herdr/remote-runtime.mjs')), hash = sha256(bytes);
          return request.config.machines.map(machine => ({ machine: machine.name, path: runtimeInstallPath(machine.runtime.directory, bytes), bytes, sha256: hash }));
        },
        runtimeRootsHealthy: async (request, runtimes) => {
          for (const runtime of runtimes) {
            const machine = request.config.machines.find(machine => machine.name === runtime.machine);
            if (!machine) return false;
            const target = { machine: runtime.machine, nodePath: machine.nodePath ?? 'node', coreStartedAt: '' };
            const launch = { ...probeLaunch(target), argv: [target.nodePath, runtime.path, '--probe', machine.runtime.directory] };
            let output: string;
            try { output = await probeRoot(launch); }
            catch (error) {
              // A missing root makes the runtime probe exit nonzero. Transport
              // failures must reach setup so it can defer or fail the machine.
              if (error instanceof HerdrError && error.code === 'probe-failed') return false;
              throw error;
            }
            try { if (!isRuntimeRootProbe(JSON.parse(output), machine.runtime.directory)) return false; }
            catch { return false; }
          }
          return true;
        },
        runtimeRootProbes: (request, runtimes) => runtimes.flatMap((runtime): RuntimeRootObservation[] => {
          const machine = request.config.machines.find(machine => machine.name === runtime.machine);
          if (!machine) return [];
          const nodePath = machine.nodePath ?? 'node';
          const output = rootProbes.get(rootKey({ ...probeLaunch({ machine: runtime.machine, nodePath, coreStartedAt: '' }), argv: [nodePath, runtime.path, '--probe', machine.runtime.directory] }));
          try {
            const result: unknown = JSON.parse(output ?? 'null');
            return isRuntimeRootProbe(result, machine.runtime.directory) ? [{ machine: runtime.machine, nodePath, runtimeHash: runtime.sha256, root: machine.runtime.directory,
              result: { directory: result.directory, uid: result.uid, mode: result.mode, nodeVersion: result.nodeVersion, nodePath: result.nodePath } }] : [];
          } catch { return []; }
        }),
        bootstrapRuntime: async (request, _context, runtimes) => {
          for (const runtime of runtimes) {
            const machine = request.config.machines.find(machine => machine.name === runtime.machine);
            if (!machine) throw new HerdrError('machine-unconfigured', 'Runtime destination is not configured');
            for (const operation of ['--install', '--probe']) {
              const launch = { ...probeLaunch({ machine: runtime.machine, nodePath: machine.nodePath ?? 'node', coreStartedAt: '' }), argv: [machine.nodePath ?? 'node', runtime.path, operation, machine.runtime.directory] };
              const result = JSON.parse(operation === '--probe' ? await probeRoot(launch) : await probe(request, launch)) as { directory?: string; mode?: number; uid?: number; nodeVersion?: string; nodePath?: string };
              if (result.directory !== machine.runtime.directory || result.mode !== 0o700 || !Number.isSafeInteger(result.uid) || typeof result.nodePath !== 'string' || !checkRemoteNodeVersion(result.nodeVersion ?? '')) throw new HerdrError('runtime-bootstrap-failed', 'Destination runtime directory probe failed');
            }
          }
        },
        selectApp,
        cutover: (request, context) => runSpaces(request, context, true),
        reconcileCutover: (request, context) => runSpaces(request, context, false),
        persistCutover: async request => {
          const result = await reconcileSpaceJournal(request.config, getSpaces());
          if (!result) throw new HerdrError('cutover-reconciliation-required', 'No confirmed session owners remain');
          return { terminals: result.tabs.map(tab => tab.terminal), identities: Object.fromEntries(result.launched.map(owner => [owner.sessionId, owner.startIdentity])) };
        },
        verify: async (request, deferredRuntimes) => doctorHerdr(request, { ...await doctorParts(request, fallbackLook), probeRuntimeRoot: async (_target, launch) => rootProbes.get(rootKey(launch)) ?? probe(request, launch), cachedNodeObservations: async () => (await readJournal(request.journalRoot)).probes }, deferredRuntimes),
        rollback: async (result, options) => {
          const spaces = getSpaces();
          const recovery = await readCutoverRecovery(spaces.journalRoot, await spaces.layoutSnapshot());
          if (result.terminals.length !== recovery.createdTabs.length || result.terminals.some(address => !recovery.createdTabs.some(tab => tab.terminal === address)) || recovery.entries.some(entry => entry.result && result.identities[entry.target.sessionId] !== entry.result.startIdentity)) throw new HerdrError('cutover-owner-conflict', 'Rollback does not match G-created tab identities');
          const entries = recovery.entries.filter(entry => !options?.preserve || !options.preserve.terminals.includes(entry.placement.terminal) && !(entry.result && options.preserve.identities[entry.target.sessionId] === entry.result.startIdentity));
          const selected = entries.map(entry => entry.placement);
          if (selected.some(tab => tab.terminal.includes('/'))) {
            const localCore = (await spaces.coreIdentity()).coreId;
            if (selected.some(tab => tab.terminal.includes('/') && tab.terminal.split('/')[0] !== localCore)) throw new HerdrError('cutover-owner-live', 'Cannot prove that the remote session owner has stopped');
          }
          const snapshot = await spaces.layoutSnapshot();
          const close: typeof recovery.createdTabs = [], panes: import('@spider/herdr/contracts').PaneId[] = [];
          for (const entry of entries) {
            const live = await assessSessionLiveness(entry.target.file, selectedProcessInventory(request.config, spaces.processInventory)), process = entry.result ? await spaces.processInventory.probe(entry.result.pid) : null;
            if (live.kind !== 'free' || process?.kind === 'unknown' || process?.kind === 'live' && process.startIdentity === entry.result!.startIdentity) throw new HerdrError('cutover-owner-live', 'Close the created session owner before rolling back its tab');
            // A session can switch files while remaining in the same terminal.
            for (const record of (await spaces.processInventory.presence.list()).filter(p => p.kind === 'top-level' && p.hcAddress === entry.placement.terminal)) {
              const current = await spaces.processInventory.probe(record.pid);
              if (current.kind === 'unknown' || current.kind === 'live' && current.startIdentity === record.startIdentity) throw new HerdrError('cutover-owner-live', `Close the pi in the recorded terminal (PID ${record.pid}) before rollback`);
            }
            if (entry.manuallyMoved && !options?.preserve) {
              if (snapshot.spaces.some(s => s.tabs.some(t => tabTerminals(t).some(row => row.terminal === entry.placement.terminal)))) throw new HerdrError('cutover-owner-conflict', 'Close the moved session before rollback');
              continue;
            }
            const space = snapshot.spaces.find(space => space.id === entry.placement.space), tab = space?.tabs.find(tab => tab.id === entry.placement.tab);
            if (!tab) {
              if (snapshot.spaces.some(s => s.tabs.some(t => tabTerminals(t).some(row => row.terminal === entry.placement.terminal)))) throw new HerdrError('cutover-owner-conflict', 'A recorded terminal moved to an unowned tab');
              continue;
            }
            const owned = new Set(recovery.entries.filter(e => e.placement.space === space!.id && e.placement.tab === tab.id).map(e => e.placement.terminal));
            const foreign = tabTerminals(tab).filter(row => !owned.has(row.terminal)).map(row => row.terminal);
            if (options?.preserve && tabTerminals(tab).some(row => !selected.some(placement => placement.terminal === row.terminal))) {
              const placement = await spaces.app.ownerPlacement(entry.placement.terminal);
              if (!panes.includes(placement.pane)) panes.push(placement.pane);
              continue;
            }
            if (foreign.length) throw new HerdrError('cutover-owner-conflict', rollbackForeignPanesNotice(space!.name, tab.name, foreign));
            if (tab.name !== (entry.tabName ?? entry.target.name ?? entry.target.sessionId) && tab.name !== entry.label || !tabTerminals(tab).some(row => row.terminal === entry.placement.terminal)) throw new HerdrError('cutover-owner-conflict', 'A created tab no longer has its recorded identity');
            if (!close.some(p => p.space === entry.placement.space && p.tab === entry.placement.tab)) close.push(entry.placement);
          }
          if (close.length || panes.length) await options?.beforeClose?.();
          for (const pane of panes) { const reply = await spaces.app.command('pane.close', { pane }); if (reply.error) throw new HerdrError(reply.error.code, reply.error.message); }
          for (const tab of close) { const reply = await spaces.app.command('tab.close', { id: tab.tab, confirmed: true }); if (reply.error) throw new HerdrError(reply.error.code, reply.error.message); }
          await forgetCutoverTabs(spaces.journalRoot, selected, await spaces.layoutSnapshot(), !!options?.preserve);
        },
        warn: message => process.stderr.write(message + '\n'),
      };
    }, doctorParts,
    memoryReview: {
      list: repoKeys => listMemoryReview(createMemoryReviewDbs(), repoKeys),
      decide: (op, target) => decideMemoryReview(createMemoryReviewDbs(), op, target.scope === 'global' ? { scope: 'global', repoKey: null, uuid: target.uuid } : { scope: 'repo', repoKey: target.repoKey!, uuid: target.uuid }),
    },
    ipc: async (descriptor, request) => { const ipc = createSessionIpcClient(descriptor); try { if (request.op === 'subscribeRun') throw new HerdrError('ipc-stream-unavailable', 'Use the external viewer for transcript subscriptions'); return await ipc.request(request); } finally { ipc.dispose(); } },
    sshShim: argv => runSshShim(argv, env),
    remoteObserver: async argv => {
      const values = new Map<string, string>(); for (let i = 0; i < argv.length; i += 2) { if (!['--observe', '--hc', '--nonce', '--exit-file'].includes(argv[i]) || values.has(argv[i]) || !argv[i + 1]) throw new HerdrError('observer-usage', 'Invalid observer argv'); values.set(argv[i], argv[i + 1]); }
      if (values.size !== 4 || !isAbsolute(values.get('--hc')!) || !isAbsolute(values.get('--exit-file')!)) throw new HerdrError('observer-usage', 'Observer paths must be absolute');
      const controller = new AbortController(), stop = () => controller.abort();
      for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.once(signal, stop);
      const nonce = values.get('--nonce')!, deadline = Date.now() + 10_000;
      const marker = async () => {
        const accepted = await snapshot(values.get('--exit-file')! + '.ready');
        if (accepted.bytes && accepted.bytes.length <= 4096 && JSON.parse(accepted.bytes.toString()).nonce === nonce || Date.now() >= deadline) { clearInterval(ready); return; }
        process.stdout.write(observerMarker(nonce) + '\n');
      };
      // hc attach replays the original screen and can erase an earlier local marker.
      // Keep presenting it until the owner's pane/screen check has acknowledged it.
      const ready = setInterval(() => { void marker().catch(() => controller.abort()); }, 25); ready.unref();
      try { return await runRemoteObserver({ hcBinary: values.get('--hc')!, address: values.get('--observe')! as TerminalAddress, nonce: values.get('--nonce')!, exitFile: values.get('--exit-file')!, env, signal: controller.signal, holdOpen: true }) ?? 1; }
      finally { clearInterval(ready); for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.removeListener(signal, stop); }
    },
    resumeOffer: async request => {
      const identity = await client(request).caller(env), root = join(request.config.globalRoot, 'herdr');
      const mode = request.config.resume ?? 'offer', watch = resumeWatchShell(root, identity);
      try {
        const offer = await offerResume(identity, { registry: createTerminalRegistry(root), refusalRoot: root, processInventory: createProcessInventory(root), coreStartedAt: () => coreStartedAt(request.config.core.binary, env), ...(mode === 'auto' ? { autoResumeRoot: root } : {}) });
        return watch + (offer ? resumeOfferShell(offer, { nodePath: process.execPath, cliPath: join(packageRoot, 'dist/herdr/cli.mjs'), configPath: request.configPath, hookPath: join(root, 'resume.sh') }, mode) : '');
      } catch (error) {
        const code = error instanceof HerdrError ? error.code : 'setup-failed';
        process.stderr.write(`${code}: ${error instanceof Error ? error.message : String(error)}\n`);
        return watch;
      }
    },
    resume: async (request, selection) => {
      const root = join(request.config.globalRoot, 'herdr'), rawInventory = createProcessInventory(root);
      const inventory = selection.cutover ? selectedProcessInventory({ ...request.config, spaces: [{ name: selection.sessionId, sessions: [{ file: selection.file }] }] }, rawInventory, [{ file: selection.file, sessionId: selection.sessionId as SessionId }]) : rawInventory;
      const identity = { pid: process.pid, startIdentity: processStartTime(process.pid) ?? '' }; if (!identity.startIdentity) throw new HerdrError('process-identity-unavailable', 'Cannot claim a launch lease');
      let childExit: Promise<{ code: number | null; signal?: NodeJS.Signals | null; error?: Error }> | undefined;
      const file = await canonicalSessionFile(selection.file);
      const resume = !selection.cutover && env.HC_TERMINAL_ID && env.HC_TERMINAL_SOCKET ? { registry: createTerminalRegistry(root), terminal: await client(request).caller(env) } : undefined;
      await withProcessLock(root, `resume-launch:${file}`, () => launchSession({ sessionFile: file, sessionId: selection.sessionId as SessionId, cwd: selection.cwd, environment: { agentDirectory: request.config.agentDirectory, extensionArguments: [] } }, { leases: inventory.leases, processInventory: inventory, processIdentity: identity, env, resume, leasePolicy: selection.cutover ? { mode: 'cutover' } : { mode: 'switch', sessionId: selection.sessionId as SessionId },
        spawnPi: async spawnRequest => {
          const child = spawn(spawnRequest.argv[0], spawnRequest.argv.slice(1), { cwd: spawnRequest.cwd, env: { ...spawnRequest.env }, stdio: 'inherit' });
          // Subscribe before any await: startup failure can precede lease transfer or owner activation.
          childExit = new Promise(resolve => { child.once('exit', (code, signal) => resolve({ code, signal })); child.once('error', error => resolve({ code: null, error })); });
          await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
          const startIdentity = processStartTime(child.pid!); if (!startIdentity) throw new HerdrError('process-identity-unavailable', 'Cannot prove launched pi identity');
          return { pid: child.pid!, startIdentity };
        },
        // pi activation owns the generation-bound terminal mapping; the lease launcher never publishes one.
      }), { reclaimReusedOwner: true }).catch(error => {
        if (error instanceof HerdrError && error.code === 'lock-occupied') throw new HerdrError('resume-launch-busy', 'Another resume launch is still in progress. Try again.');
        throw error;
      });
      if (childExit) {
        const result = await childExit;
        if (result.error) throw new HerdrError('resume-exited', `Resumed pi failed: ${result.error.message}`);
        if (result.code !== 0 && result.code !== 130 && !result.signal) throw new HerdrError('resume-exited', `Resumed pi exited with code ${result.code}`);
      }
    },
    stdout: text => process.stdout.write(text), stderr: text => process.stderr.write(text),
    async dispose() { if (panes) await (await panes).dispose(); for (const hc of clients.values()) await hc.dispose(); clients.clear(); },
  };
}

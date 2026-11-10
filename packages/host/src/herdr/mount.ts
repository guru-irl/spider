import { existsSync, constants } from 'node:fs';
import { readFile, access, writeFile, realpath, stat, open, readdir } from 'node:fs/promises';
import { join, dirname, resolve, basename, isAbsolute } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { resolvePiPackageRoot } from '../../../subagents/src/pi-spawn.js';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { createBashTool, createLocalBashOperations, getAgentDir } from '@earendil-works/pi-coding-agent';
import { bus, openGlobal, openGlobalReadOnly, openRepo, resolveProject, paths } from '@spider/db-core';
import { RunStore, makeKillHandler, makeMessageHandler, teardownSessionAsync } from '@spider/subagents';
import { processStartTime } from '../../../subagents/src/process-identity.js';
import { createRemoteFileResolver } from './remote-file.js';
import { resolveMachine } from './machine.js';
import { withRemoteCopy } from './copy.js';
import { killOwnedJob, findOwnedKillJobs, type KillJobResult } from './kill-job.js';
import { createHcClient } from '@spider/herdr/client/hc';
import { isCoreAvailable } from '@spider/herdr/client/liveness';
import { createAppClient } from '@spider/herdr/client/app';
import { parseHerdrConfig } from '@spider/herdr/config';
import { registerHerdrStatusContribution } from '@spider/herdr/status/register';
import { publishSessionFeed, publishSessionHeartbeat, sessionFeedWritePending, coalesceFeedWrites } from '@spider/herdr/feed/publisher';
import { FEED_DISCONNECT_MS } from '../../../herdr/assets/shared/feed.js';
import { startSessionEndpoint, type SessionEndpoint } from '@spider/herdr/feed/ipc-server';
import { createAuxiliaryPanes, type AuxiliaryPaneActor } from '@spider/herdr/jobs/placement';
import { openRemoteObserver, type ObserverHandle } from '@spider/herdr/jobs/observer';
import { HERDR_KINDS, HERDR_LABELS } from '@spider/herdr';
import { registerHerdrJobs, type JobRegistrationPorts } from '@spider/herdr/jobs/register';
import type { JobMonitor } from '@spider/herdr/jobs/monitor';
import { foregroundJobsStopped, processStartIdentity } from '@spider/herdr/jobs/handoff';
import { createJobStore } from '@spider/herdr/jobs/store';
import { createRemoteExecutor } from '@spider/herdr/remote/execute';
import { registerAgentConsoleLifecycle } from '@spider/herdr/remote/console';
import { createViewerLauncher, registerHerdrViewers } from '@spider/herdr/viewers/register';
import { hasLiveMappedAncestor, registerHerdrSessions } from '@spider/herdr/sessions/register';
import { runtimeInstallPath, standardHerdrConfigPath as installedHerdrConfigPath } from '@spider/herdr/setup/installer';
import { createTerminalRegistry } from '@spider/herdr/sessions/registry';
import { moveOwnedSession } from '@spider/herdr/spaces/move';
import { createMachineCache, type MachineCache } from '@spider/herdr/ssh/cache';
import { createTransportPolicy } from '@spider/herdr/ssh/admin';
import { createSshPolicy, type SshPolicy } from '@spider/herdr/ssh/policy';
import { createExecutionEnvironmentPolicy, installSshShim, sshShimDirectory } from '@spider/herdr/ssh/shim';
import { registerHerdrRouting, guardHerdrToolCall, type RoutingPorts } from '@spider/herdr/ssh/register';
import { registerHerdrShortcuts } from '@spider/herdr/shortcuts/register';
import { regenerateGlobalHerdrTemplates, type TemplatePorts } from '@spider/herdr/templates/register';
import { snapshot } from '@spider/herdr/setup/backup';
import { HerdrError } from '@spider/herdr/client/parse';
import { trackAvailability } from '@spider/herdr/client/availability';
import { HERDR_NOTICES, herdrErrorNotice, herdrErrorNoticeKey, remoteUnavailableNotice, inactiveHerdrNotice, type InactiveReason } from '@spider/herdr/notices';
import type { HcClient, HerdrConfig, Owner, Disposable, AuxiliaryPanes, RunId, JobId, JobRecord, MachineName, TerminalAddress, RemoteExecutionPort, ExecutionEnvironmentPolicy, SessionFeed, SteerReply, TerminalIdentity, CoreIdentity } from '@spider/herdr';
import { createHerdrDataSource } from './data-source.js';
import { createRunTranscriptSource } from './run-transcript.js';
import { createHerdrViews } from './views.js';
import { openSessionRunDb } from '../session-run-db.js';
import { controlConfig, configValues, modelDefaultLayers } from '../control.js';
import { mountChildHerdr } from './child.js';
import { coreStartedAt, disabledHerdrEnvironment, verifiedHerdrFile, readAppLayout, createHostHerdrPorts, createProcessInventory, explicitExtensionArguments, readJobJournal, type HostHerdrOptions, type HostHerdrPorts } from './ports.js';
export type { HostHerdrOptions } from './ports.js';

const INACTIVE_NOTICE = Symbol.for('spider.herdr.inactive-notices.v1');
interface InactiveNotice { sessions: Set<string>; displayed: boolean; configWarnings?: Set<string>; terminal?: TerminalIdentity; ownershipNotices?: Set<string>; recoveryNotices?: Set<string>; errorNoticeTimes?: Map<string, Map<string, number>>; outages?: Map<string, Set<string>>; registryWarnings?: Set<string> }
const hostGlobal = globalThis as typeof globalThis & { [INACTIVE_NOTICE]?: WeakMap<object, InactiveNotice> };
const inactiveNotices = hostGlobal[INACTIVE_NOTICE] ??= new WeakMap<object, InactiveNotice>();
function availabilityReporter(ctx: ExtensionContext): (key: string) => void {
  const manager = ctx.sessionManager ?? ctx, session = ctx.sessionManager?.getSessionId?.() ?? '(session)';
  return key => { inactiveNotices.get(manager)?.outages?.get(session)?.delete(key); };
}
function inactiveNotice(ctx: ExtensionContext, mode: unknown, reason: InactiveReason, expected = true, error?: unknown): void {
  const manager = ctx.sessionManager ?? ctx, session = ctx.sessionManager?.getSessionId?.() ?? '(session)';
  let notice = inactiveNotices.get(manager);
  // Clear a footer left by an earlier extension version across /reload.
  if (notice?.displayed) { ctx.ui?.setStatus?.('spider-herdr', undefined); notice.displayed = false; }
  if (mode === false || mode !== true && !expected || notice?.sessions.has(session)) return;
  notice ??= { sessions: new Set(), displayed: false }; inactiveNotices.set(manager, notice); notice.sessions.add(session);
  const message = error instanceof HerdrError ? herdrErrorNotice(error) : inactiveHerdrNotice(reason);
  if (ctx.hasUI && ctx.ui?.notify) ctx.ui.notify(message, mode === true ? 'error' : 'warning');
  else process.stderr.write(message + '\n');
}

const RETIRED_TERMINAL_NOTICE = HERDR_NOTICES.retired.text;
function coreNotice(ctx: ExtensionContext, kind: 'ownershipNotices' | 'recoveryNotices', code: 'retired' | 'coreBack', level: 'warning' | 'error' = 'warning'): void {
  const message = HERDR_NOTICES[code].text;
  const manager = ctx.sessionManager ?? ctx, session = ctx.sessionManager?.getSessionId?.() ?? '(session)';
  const notice = inactiveNotices.get(manager) ?? { sessions: new Set<string>(), displayed: false };
  inactiveNotices.set(manager, notice);
  const sessions = notice[kind] ??= new Set<string>();
  if (sessions.has(session)) return;
  sessions.add(session);
  if (ctx.hasUI && ctx.ui?.notify) ctx.ui.notify(message, level);
  else process.stderr.write(message + '\n');
}

export function standardHerdrConfigPath(): string { return installedHerdrConfigPath(process.env.SPIDER_GLOBAL_ROOT ?? paths.globalRoot); }
export function effectiveHerdrConfigPath(cwd: string, ctx?: ExtensionContext): string | null {
  const settings = configValues(cwd);
  const manager = ctx?.sessionManager ?? ctx ?? process, session = ctx?.sessionManager?.getSessionId?.() ?? '(process)';
  const notice = inactiveNotices.get(manager) ?? { sessions: new Set<string>(), displayed: false };
  inactiveNotices.set(manager, notice);
  const warnings = notice.configWarnings ??= new Set<string>();
  for (const message of settings.warnings.filter(message => /^herdr\.(config|enabled) /.test(message))) {
    const key = `${session}:${message.split(' ')[0]}`;
    if (warnings.has(key)) continue;
    warnings.add(key);
    const plain = message.startsWith('herdr.config ') ? HERDR_NOTICES.repoConfig.text : HERDR_NOTICES.repoEnabled.text;
    if (ctx?.hasUI && ctx.ui?.notify) ctx.ui.notify(plain, 'warning');
    else process.stderr.write(plain + '\n');
  }
  const configured = settings.config['herdr.config'];
  if (typeof configured === 'string' && configured) return resolve(paths.globalRoot, configured);
  const standard = standardHerdrConfigPath();
  return existsSync(standard) ? standard : null;
}

export async function resolveRealSshBinary(env: Readonly<NodeJS.ProcessEnv>, shimDirectory: string): Promise<string> {
  const excluded = [shimDirectory];
  try { const inherited = JSON.parse(env.SPIDER_HERDR_SSH_DESCRIPTOR ?? 'null'); if (typeof inherited?.shimDirectory === 'string') excluded.push(inherited.shimDirectory); } catch { /* Ignore a stale inherited descriptor during resolution. */ }
  const directories = await Promise.all(excluded.map(async path => realpath(path).catch(() => resolve(path))));
  const names = process.platform === 'win32' ? ['ssh.exe', 'ssh.cmd', 'ssh.bat', 'ssh'] : ['ssh'];
  for (const directory of (env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':')) {
    const canonical = await realpath(directory || '.').catch(() => resolve(directory || '.'));
    if (directories.includes(canonical)) continue;
    for (const name of names) {
      const candidate = resolve(directory || '.', name);
      try {
        const target = await realpath(candidate);
        if (directories.includes(dirname(target)) || !(await stat(target)).isFile()) continue;
        await access(candidate, constants.X_OK); return candidate;
      } catch { /* Continue PATH lookup for absent or non-executable candidates. */ }
    }
  }
  throw new HerdrError('ssh-unavailable', 'No SSH executable is available outside the Herdr shim directory');
}

export interface HerdrMount extends Disposable {
  owner(): Owner | null;
  enabled(): boolean;
  /** Top-level owners end their streams before replacement cancels their children. */
  prepareSessionReplacement?(): Promise<void>;
  /** End owner streams before quit cancels children; publish the final feed afterward. */
  prepareSessionQuit?(): Promise<void>;
  execution(): { owner?: Owner; remote?: RemoteExecutionPort; remoteUnavailableReason?: string; environmentPolicy: ExecutionEnvironmentPolicy; supervisorHcBinary?: string };
  findKillJobs(id: string): Promise<Array<{ id: string }>>;
  killJob(id: string): Promise<KillJobResult>;
  guard: RoutingPorts extends never ? never : (event: { toolName: string; input: Record<string, unknown> }) => Promise<{ block: true; reason: string } | undefined>;
}

/** Cosmetic launch metadata reads only the exact run's bounded session header. */
async function viewerRunCwd(directory: string | undefined, runId: RunId): Promise<string | undefined> {
  try {
    if (!directory || !isAbsolute(directory) || resolve(directory) !== directory || basename(directory) !== runId
      || basename(dirname(directory)) !== 'subagent-sessions' || await realpath(directory) !== directory) return;
    const names = (await readdir(directory)).filter(name => name.endsWith('.jsonl')); if (names.length !== 1) return;
    const file = await open(join(directory, names[0]), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const metadata = await file.stat(); if (!metadata.isFile() || metadata.nlink !== 1) return;
      const buffer = Buffer.alloc(16384), { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      const newline = buffer.subarray(0, bytesRead).indexOf(10); if (newline < 0) return;
      const header: unknown = JSON.parse(buffer.subarray(0, newline).toString('utf8'));
      if (header && typeof header === 'object' && 'type' in header && header.type === 'session'
        && 'cwd' in header && typeof header.cwd === 'string' && isAbsolute(header.cwd) && !header.cwd.includes('\0')) return header.cwd;
    } finally { await file.close(); }
  } catch { /* Missing, malformed, ambiguous or unsafe metadata is never a launch failure. */ }
}

export function mountHerdr(pi: ExtensionAPI, options: HostHerdrOptions): HerdrMount {
  if (process.env.PI_SUBAGENT_CHILD === '1') return mountChildHerdr(pi, options, jobIdsForToolResult);
  let context: ExtensionContext | null = null, owner: Owner | null = null, config: HerdrConfig | null = null;
  let client: ReturnType<typeof createHcClient> | null = null, app: ReturnType<typeof createAppClient> | null = null;
  let panes: AuxiliaryPaneActor | null = null, monitor: JobMonitor | null = null, endpoint: SessionEndpoint | null = null;
  let remote: RemoteExecutionPort | undefined, output: HostHerdrPorts | null = null, cache: MachineCache | null = null;
  let remoteUnavailableReason: string | undefined;
  let remoteFiles: ReturnType<typeof createRemoteFileResolver> | null = null;
  const runtimePaths = new Map<string, string>();
  let policy: SshPolicy | null = null, environment: ExecutionEnvironmentPolicy = disabledHerdrEnvironment, epoch = 0;
  let source: ReturnType<typeof createHerdrDataSource> | null = null, transcript: ReturnType<typeof createRunTranscriptSource> | null = null;
  let unsubscribe: (() => void) | undefined;
  let routing: Disposable | undefined, shortcuts: Disposable | undefined;
  let stopped = false, coreLost = false, disposed = false, lifecycle = 0, publishing: Promise<void> = Promise.resolve();
  let feedBusySince: number | undefined, feedBusyNotified = false;
  let coreWatch: ReturnType<typeof setInterval> | undefined, coreProbe: Promise<void> | undefined;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined, heartbeatPending: Promise<void> = Promise.resolve();
  let activationEnv: Readonly<NodeJS.ProcessEnv> | null = null;
  let recovery: object | null = null;
  let stopStatus = () => {};
  let observerAbort = new AbortController();
  const observerViews = new Map<JobId, Promise<{ handle: ObserverHandle; hc: HcClient }>>();
  const pendingRunOpens = new Set<Promise<TerminalAddress | null>>();
  const notifyError = (ctx: ExtensionContext, error: unknown) => {
    const manager = ctx.sessionManager ?? ctx, session = ctx.sessionManager?.getSessionId?.() ?? '(session)';
    const notice = inactiveNotices.get(manager) ?? { sessions: new Set<string>(), displayed: false };
    inactiveNotices.set(manager, notice);
    const messagesBySession = notice.errorNoticeTimes ??= new Map<string, Map<string, number>>();
    const messages = messagesBySession.get(session) ?? new Map<string, number>();
    messagesBySession.set(session, messages);
    const key = herdrErrorNoticeKey(error), now = Date.now(), last = messages.get(key);
    if (error instanceof HerdrError && error.code === 'unavailable') {
      const outages = notice.outages ??= new Map<string, Set<string>>();
      const active = outages.get(session) ?? new Set<string>(); outages.set(session, active);
      const scope = error.availability?.key ?? 'unavailable';
      if (active.has(scope)) return;
      active.add(scope);
    } else {
      if (last !== undefined && now >= last && now - last < 60_000) return;
      messages.set(key, now);
    }
    const plain = herdrErrorNotice(error);
    if (ctx.hasUI && ctx.ui?.notify) ctx.ui.notify(plain, 'warning');
    else process.stderr.write(plain + '\n');
  };
  const report = (error: unknown) => {
    options.reportError?.(error);
    const ctx = context;
    if (!ctx) return;
    if (error instanceof HerdrError) {
      if (['pane-removal-timeout', 'agent-pane-protected', 'run-finished'].includes(error.code)) return;
      // The socket watch owns the core-loss transition and its one notice.
      if (error.code === 'core-unavailable') return;
      if (error.code === 'herdr-unavailable' && coreLost) return;
      if (error.code === 'events-disconnected') {
        if (coreLost) return;
        const env = activationEnv;
        if (env) {
          void isCoreAvailable(env).then(live => { if (live && !coreLost && context === ctx) notifyError(ctx, error); }).catch(report);
          return;
        }
      }
    }
    notifyError(ctx, error);
  };
  const feedResult = (work: Promise<void>): Promise<void> => trackAvailability({ key: 'feed' }, () => work, context ? availabilityReporter(context) : undefined).then(() => {
    feedBusySince = undefined; feedBusyNotified = false;
  }, error => {
    if (!(error instanceof HerdrError) || error.code !== 'lock-occupied') throw error;
    const now = Date.now(); feedBusySince ??= now;
    if (!feedBusyNotified && now - feedBusySince >= FEED_DISCONNECT_MS) {
      feedBusyNotified = true;
      report(new HerdrError('feed-write-stalled', 'Session feed updates are blocked by a busy operation lock.'));
    }
  });
  // Optional embedding APIs and bookkeeping errors are handled at the pi boundary.
  const registrationPi = new Proxy(pi, { get(target, key) {
    if (key === 'on') return (name: string, handler: Function) => (pi.on as Function)(name, (event: unknown, ...args: unknown[]) => {
      if (!['session_start', 'session_shutdown', 'session_info_changed'].includes(name)) return handler(event ?? {}, ...args);
      return Promise.resolve().then(() => handler(event ?? {}, ...args)).catch(report);
    }) ?? (() => {});
    return Reflect.get(target, key);
  } });
  const need = <T>(value: T | null): T => { if (!value) throw new HerdrError('herdr-unavailable', 'No active validated Herdr owner'); return value; };
  const hc: HcClient = new Proxy({} as HcClient, { get(_target, key) { const c = need(client); const value = Reflect.get(c, key); return typeof value === 'function' ? value.bind(c) : value; } });
  const panePort: AuxiliaryPanes & Pick<AuxiliaryPaneActor, 'reconcile'> = { reconcile: (...args) => need(panes).reconcile(...args), acquire: (...args) => need(panes).acquire(...args), release: r => need(panes).release(r), park: id => need(panes).park(id), dispose: () => panes?.dispose() };
  const views = createHerdrViews(options.views);
  const viewerExecutable = join(options.packageRoot, 'dist/herdr/viewer.mjs');
  const launcher = createViewerLauncher({ hc, owner: () => owner, ipcDescriptor: () => endpoint?.descriptor ?? null, viewerExecutable, piPackageRoot: resolvePiPackageRoot(),
    runInfo: async (id, o) => {
      const { db, dbPath } = bindDb(o);
      try {
        const store = new RunStore(db), run = store.get(id), parent = run?.parent_run_id ? store.get(run.parent_run_id) : undefined;
        const activeName = owner?.sessionId === o.sessionId && owner.generation === o.generation ? owner.name : o.name;
        const parentName = parent?.session_id === o.sessionId ? parent.name || parent.id : activeName || 'Agent';
        const recorded = db.prepare("SELECT payload FROM run_events WHERE run_id=? AND session_id=? AND type='child_transcript' ORDER BY id DESC LIMIT 1").get(id, o.sessionId) as { payload: string | null } | undefined;
        let directory: string | undefined;
        if (!recorded) directory = join(paths.scratch('project', o.cwd), 'subagent-sessions', id);
        else {
          try { const location: unknown = JSON.parse(recorded.payload ?? 'null'); if (location && typeof location === 'object' && 'version' in location && location.version === 1 && 'directory' in location && typeof location.directory === 'string') directory = location.directory; } catch { /* Invalid recorded locations do not read a different transcript. */ }
        }
        return { status: run?.status, name: run?.name || id, parentName, steer: run?.child_mode === 'rpc' ? 'rpc' as const : 'headless' as const, cwd: await viewerRunCwd(directory, id), dbPath };
      } finally { db.close(); }
    }, get feedRoot() { return join(need(config).globalRoot, 'herdr'); } });
  const root = join(process.env.SPIDER_GLOBAL_ROOT ?? paths.globalRoot, 'herdr');
  const inventory = createProcessInventory(root), registry = createTerminalRegistry(root);
  const processIdentity = { pid: process.pid, startIdentity: processStartTime(process.pid) ?? '' };

  const bindDb = (o: Owner) => options.dataSource?.resolveRunDb(o) ?? openSessionRunDb(o.cwd, o.sessionId);
  const withStore = <T>(o: Owner, read: (store: RunStore) => T): T => { const { db } = bindDb(o); try { return read(new RunStore(db)); } finally { db.close(); } };
  const journalRoot = () => join(need(config).globalRoot, 'herdr', 'jobs');
  const templatePorts: TemplatePorts = {
    globalModelDefaultLayers: () => ({ global: modelDefaultLayers(need(context).cwd).global }),
    modelRegistry: { getAll: () => need(context).modelRegistry.getAll(), getAvailable: () => need(context).modelRegistry.getAvailable(), find: (provider, id) => need(context).modelRegistry.find(provider, id) },
    get templateDirectory() { return join(dirname(need(config).core.config), 'templates'); },
    roleTemplateOptions: { piExecutable: 'pi', get instructionPaths() { const root = join(need(config).globalRoot, 'herdr/instructions'); return { worker: join(root, 'worker.md'), reviewer: join(root, 'reviewer.md'), watcher: join(root, 'watcher.md') }; } },
    writeVerifiedFile: async (path, content) => verifiedHerdrFile(join(need(config).globalRoot, 'herdr/setup'), { path, bytes: Buffer.from(content), expected: (await snapshot(path)).hash, collision: 'clone' }),
    reportWarning: message => {
      const role = /^(?:Configured (worker|reviewer|watcher) model is unavailable|No available catalog model for (worker|reviewer|watcher))$/.exec(message);
      const key = role?.[1] ?? role?.[2];
      const plain = key === 'worker' ? HERDR_NOTICES.templateWorker.text : key === 'reviewer' ? HERDR_NOTICES.templateReviewer.text : key === 'watcher' ? HERDR_NOTICES.templateWatcher.text : HERDR_NOTICES.generic.text;
      if (context?.hasUI && context.ui?.notify) context.ui.notify(plain, 'warning');
      else process.stderr.write(plain + '\n');
    },
  };
  const writeFeed = coalesceFeedWrites(async () => {
    const current = owner, currentSource = source;
    if (!current || !currentSource || stopped) return;
    // Keep the published text and its content hash on the same owner name during a rename.
    const feed = await currentSource.snapshot({ ...current });
    if (owner === current && !stopped) await publishSessionFeed(join(need(config).globalRoot, 'herdr'), feed);
  });
  const publish = () => { publishing = feedResult(writeFeed()); return publishing; };
  const closeFeed = async (final = false, handoff: 'disposed' | 'wrong-generation' = 'disposed') => {
    const current = owner, currentSource = source, currentConfig = config, generation = lifecycle;
    const currentTranscript = transcript, currentEndpoint = endpoint;
    stopped = true; unsubscribe?.(); unsubscribe = undefined;
    clearInterval(heartbeatTimer); heartbeatTimer = undefined;
    await publishing.catch(report); await heartbeatPending.catch(report);
    if (final && currentSource && current && currentConfig) {
      try {
        const feed = await currentSource.snapshot(current, 'closed');
        let backoff = 50;
        while (lifecycle === generation && owner === current && source === currentSource) {
          try {
            await publishSessionFeed(join(currentConfig.globalRoot, 'herdr'), feed);
            feedBusySince = undefined; feedBusyNotified = false;
            break;
          } catch (error) {
            if (!(error instanceof HerdrError) || error.code !== 'lock-occupied') throw error;
            await feedResult(Promise.reject(error));
            await delay(backoff); backoff = Math.min(backoff * 2, 1000);
          }
        }
      } catch (error) { report(error); }
    }
    currentSource?.dispose(); if (source === currentSource) source = null;
    currentTranscript?.dispose(); if (transcript === currentTranscript) transcript = null;
    await currentEndpoint?.dispose(handoff); if (endpoint === currentEndpoint) endpoint = null;
  };
  const closeResources = async () => {
    // Canceled opens still need the live client to remove a late launch.
    await Promise.allSettled([...pendingRunOpens]);
    const attempt = async (operation: () => unknown | Promise<unknown>) => {
      try { await operation(); }
      catch (error) { if (!(error instanceof HerdrError && ['core-unavailable', 'disposed'].includes(error.code))) report(error); }
    };
    clearInterval(coreWatch); coreWatch = undefined; activationEnv = null; recovery = null;
    environment = disabledHerdrEnvironment; policy = null; remote = undefined; remoteFiles = null; await attempt(stopStatus);
    observerAbort.abort();
    for (const pending of observerViews.values()) {
      try {
        const view = await pending; await view.handle.release();
        await view.hc.kill(view.handle.viewer).catch(error => { if (!(error instanceof HerdrError) || error.code !== 'not_found') throw error; });
        await view.hc.rm(view.handle.viewer).catch(error => { if (!(error instanceof HerdrError) || error.code !== 'not_found') throw error; });
      } catch (error) { if (!(error instanceof HerdrError) || !['aborted', 'not_found', 'core-unavailable', 'disposed'].includes(error.code)) report(error); }
    }
    observerViews.clear();
    const previousMonitor = monitor; monitor = null;
    await attempt(() => previousMonitor?.dispose());
    const previousPanes = panes; panes = null;
    await attempt(() => previousPanes?.dispose());
    const previousOutput = output; output = null;
    await attempt(() => previousOutput?.dispose()); runtimePaths.clear();
    const previousCache = cache; cache = null;
    await attempt(() => previousCache?.dispose());
    const previousClient = client; client = null; app = null; owner = null;
    await attempt(() => previousClient?.dispose());
  };
  const reportRegistryFailure = (file: string, error: unknown) => {
    const manager = context?.sessionManager ?? context ?? pi;
    const notice = inactiveNotices.get(manager) ?? { sessions: new Set<string>(), displayed: false };
    inactiveNotices.set(manager, notice);
    const warnings = notice.registryWarnings ??= new Set<string>();
    const key = `${context?.sessionManager?.getSessionId?.() ?? '(session)'}:${file}`;
    if (warnings.has(key)) return;
    warnings.add(key);
    try { report(new HerdrError('terminal-registry-bookkeeping', `Skipping terminal registry entry ${file}: ${error instanceof Error ? error.message : String(error)}`)); }
    catch { /* Diagnostics must not turn optional bookkeeping into an activation failure. */ }
  };
  const pruneOldCoreMappings = async (core: CoreIdentity) => {
    try {
      for (const mapping of await registry.list(reportRegistryFailure)) {
        const terminal = mapping.owner.terminal;
        // Only this socket and namespace are proved replaced. Other cores remain independent.
        if (terminal.socket === core.socket && terminal.sessionNamespace === core.sessionNamespace && terminal.coreId !== core.coreId) {
          try { await registry.remove(terminal, true); }
          catch (error) { reportRegistryFailure(terminal.address, error); }
        }
      }
    } catch (error) { reportRegistryFailure(join(root, 'terminals'), error); }
  };
  const watchForCore = (current: Owner, env: Readonly<NodeJS.ProcessEnv>, ctx: ExtensionContext, generation: number) => {
    const token = {}; recovery = token;
    let checking = false;
    const valid = () => !disposed && lifecycle === generation && context === ctx && recovery === token;
    const check = async () => {
      if (checking || !valid()) return;
      checking = true;
      let probe: ReturnType<typeof createHcClient> | undefined;
      try {
        // Never spawn hc while the socket is absent; the holder or app owns recovery.
        if (!await isCoreAvailable(env) || !valid()) return;
        probe = createHcClient({ binary: need(config).core.binary, env });
        const core = await probe.identity();
        if (!valid()) return;
        if (core.coreId !== current.terminal.coreId) {
          await pruneOldCoreMappings(core);
          if (!valid()) return;
          coreNotice(ctx, 'ownershipNotices', 'retired');
        } else coreNotice(ctx, 'recoveryNotices', 'coreBack');
        clearInterval(coreWatch); coreWatch = undefined; recovery = null;
      } catch { /* A check-then-connect race remains inactive and retries at the bounded interval. */ }
      finally { await probe?.dispose(); checking = false; }
    };
    coreWatch = setInterval(() => { void check(); }, 2000); coreWatch.unref?.();
  };
  const probeCore = (current: Owner): Promise<void> => {
    if (coreProbe) return coreProbe;
    const env = activationEnv, ctx = context, generation = lifecycle;
    if (!env || !ctx || disposed || stopped || owner !== current) return Promise.resolve();
    const pending = (async () => {
      const live = await isCoreAvailable(env);
      let replacement: CoreIdentity | undefined;
      if (live) {
        try { await need(client).identity(); }
        catch (error) {
          if (!(error instanceof HerdrError) || error.code !== 'core-mismatch') return;
          replacement = error.details as CoreIdentity;
        }
        if (!replacement) return;
      }
      if (disposed || stopped || owner !== current) return;
      stopped = true; coreLost = true; remoteUnavailableReason = HERDR_NOTICES[replacement ? 'retired' : 'coreDown'].text; environment = disabledHerdrEnvironment; policy = null; remote = undefined;
      if (replacement) { coreNotice(ctx, 'ownershipNotices', 'retired'); await pruneOldCoreMappings(replacement); }
      else inactiveNotice(ctx, 'auto', 'core-down');
      await closeFeed();
      await Promise.resolve(viewers.dispose()).catch(report);
      await closeResources();
      if (!replacement && !disposed && lifecycle === generation && context === ctx) watchForCore(current, env, ctx, generation);
    })().finally(() => { if (coreProbe === pending) coreProbe = undefined; });
    coreProbe = pending; return pending;
  };
  const offs: (() => void)[] = [];
  offs.push(registrationPi.on('session_info_changed', async (_event, ctx) => {
    const current = owner;
    if (!current || ctx.sessionManager.getSessionId() !== current.sessionId) return;
    const name = pi.getSessionName?.() ?? null;
    if (current.name === name) return;
    current.name = name;
    if (source && !stopped) await publish();
  }));
  offs.push(registrationPi.on('session_start', async (_event, ctx) => {
    if (disposed) return;
    ++lifecycle;
    // Core loss may already be tearing down these same resources. Invalidate its
    // recovery watcher, then join it before installing another activation.
    await coreProbe?.catch(report);
    await closeFeed(); await closeResources(); context = ctx; config = null; coreLost = false; remoteUnavailableReason = undefined;
    let activationMode: unknown = 'auto', expected = Boolean(process.env.HC_TERMINAL_ID);
    const disabled = (reason: InactiveReason, error?: unknown) => {
      if (error !== undefined) remoteUnavailableReason = remoteUnavailableNotice(reason === 'config-problem' ? new HerdrError('invalid-config', '') : error, 'session', 'activation');
      inactiveNotice(ctx, activationMode, reason, expected, error);
    };
    try {
      if (options.readConfig) { config = await options.readConfig(ctx); activationMode = config?.enabled ?? 'auto'; expected ||= Boolean(config); }
      else {
        const enabled = controlConfig('get', ctx.cwd, 'herdr.enabled');
        activationMode = enabled;
        const file = effectiveHerdrConfigPath(ctx.cwd, ctx);
        expected ||= Boolean(file && existsSync(file));
        if (enabled !== false && file && (expected || enabled === true)) config = parseHerdrConfig(JSON.parse(await readFile(file, 'utf8')));
        if (config && (enabled === true || enabled === 'auto')) config = { ...config, enabled };
      }
    } catch (error) { disabled('config-problem', error); return; }
    if (!config || config.enabled === false) { disabled('no-config'); return; }
    if (!process.env.HC_TERMINAL_ID) { disabled('outside'); return; }
    if (ctx.mode !== 'tui' && ctx.mode !== 'rpc') return;
    const env = Object.freeze({ ...process.env });
    if (config.enabled === 'auto' && !await isCoreAvailable(env)) {
      disabled('core-down');
      return;
    }
    const available = availabilityReporter(ctx);
    client = createHcClient({ binary: config.core.binary, env }, available);
    try {
      const core = await client.identity();
      const inheritedTerminal = { ...core, terminalId: env.HC_TERMINAL_ID as TerminalIdentity['terminalId'], address: env.HC_TERMINAL_ID as TerminalAddress };
      if (await hasLiveMappedAncestor(inheritedTerminal, { ...inventory, registry, processIdentity, env })) {
        await closeResources();
        inactiveNotice(ctx, 'auto', 'nested');
        return;
      }
      await pruneOldCoreMappings(core);
      const manager = ctx.sessionManager ?? ctx;
      const notice = inactiveNotices.get(manager) ?? { sessions: new Set<string>(), displayed: false };
      inactiveNotices.set(manager, notice);
      const previous = notice.terminal;
      if (previous && previous.socket === core.socket && previous.sessionNamespace === core.sessionNamespace && previous.terminalId === env.HC_TERMINAL_ID && previous.coreId !== core.coreId)
        throw new HerdrError('terminal-core-mismatch', RETIRED_TERMINAL_NOTICE);
      const terminal = await client.caller(env);
      notice.terminal = terminal;
      epoch = await coreStartedAt(config.core.binary, env);
      owner = { terminal, sessionId: ctx.sessionManager.getSessionId() as Owner['sessionId'], generation: randomBytes(16).toString('hex') as Owner['generation'], cwd: ctx.cwd, sessionFile: (ctx as Partial<ExtensionContext> | undefined)?.sessionManager?.getSessionFile?.() ?? null, name: pi.getSessionName?.() ?? null };
      const appOptions = { binary: config.app.binary, env };
      app = createAppClient(appOptions, undefined, available);
      observerAbort = new AbortController();
      panes = createAuxiliaryPanes({ hc, app, automaticSubagentPanes: config.automaticSubagentPanes, placementRoot: join(config.globalRoot, 'herdr/panes'), appIdentity: config.app.home, appForSignal: signal => createAppClient(appOptions, signal, available), subagentViewer: launcher, discardSubagentViewer: launcher.discard, remoteObserver: openJobObserver, limit: config.limits.auxiliaryPanes, clock: Date.now, reportError: report });
      const aliases = Object.fromEntries(config.machines.map(m => [m.name, m.aliases]));
      cache = createMachineCache({ hc, identity: terminal, directory: join(config.globalRoot, 'herdr/ssh'), aliases, reportFailure: report }); await cache.ready;
      policy = createTransportPolicy(createSshPolicy(cache), () => env);
      const shimDirectory = sshShimDirectory(cache.descriptor);
      const shimOptions = { shimDirectory, realSshBinary: await resolveRealSshBinary(env, shimDirectory), cacheDescriptor: cache.descriptor, shimProgram: join(options.packageRoot, 'dist/herdr/cli.mjs'), reportDisabled: report };
      await installSshShim(shimOptions); environment = createExecutionEnvironmentPolicy(shimOptions);
      remoteFiles = createRemoteFileResolver(hc, config.machines, { manager: ctx.sessionManager ?? ctx, id: owner.sessionId });
      output = createHostHerdrPorts({ hc, config, runtimeBytes: Buffer.alloc(0), runtimePath: on => runtimePath(on) });
      transcript = createRunTranscriptSource({ owner: () => owner, resolveDb: bindDb, openBindingDb: openGlobalReadOnly, transcriptRoots: o => [paths.scratch('project', o.cwd)].filter(root => existsSync(root)),
        modelContextWindow: model => { const slash = model.indexOf('/'); return slash < 0 ? undefined : ctx.modelRegistry?.find(model.slice(0, slash), model.slice(slash + 1))?.contextWindow; } });
      inactiveNotice(ctx, false, 'activation-problem');
      stopped = false; activationEnv = env;
      const activeOwner = owner;
      coreWatch = setInterval(() => { void probeCore(activeOwner).catch(report); }, 2000); coreWatch.unref?.();
      if (ctx.modelRegistry) await regenerateGlobalHerdrTemplates(templatePorts, () => disposed || stopped).catch(report);
      routing ??= registerHerdrRouting(registrationPi, routingPorts);
      if (ctx.hasUI) shortcuts ??= registerHerdrShortcuts(registrationPi, views);
      notice.sessions.delete(owner.sessionId);
      notice.recoveryNotices?.delete(owner.sessionId);
      notice.ownershipNotices?.delete(owner.sessionId);
    } catch (error) {
      remoteUnavailableReason = remoteUnavailableNotice(error, 'session', 'activation');
      await closeResources();
      if (error instanceof HerdrError && ['terminal-core-mismatch', 'core-mismatch'].includes(error.code)) coreNotice(ctx, 'ownershipNotices', 'retired', activationMode === true ? 'error' : 'warning');
      else disabled('activation-problem', error);
    }
  }));
  // Read-only projection: a parent must not write an active child's job journal to open a view.
  const observerJob = async (id: JobId, current: Owner): Promise<JobRecord | null> => {
    const on = async (name: string | undefined): Promise<MachineName | null> => {
      if (!name) return null;
      try { const selected = await resolveMachine(hc, need(config).machines, name); return selected.on === name ? selected.on : null; }
      catch { return null; }
    };
    if (id.startsWith('console:')) {
      const address = id.slice('console:'.length) as TerminalAddress;
      let terminal;
      try { terminal = await hc.get(address); } catch (error) { if (error instanceof HerdrError && error.code === 'not_found') return null; throw error; }
      const labels = terminal.labels, machine = await on(labels[HERDR_LABELS.machine]), runId = labels[HERDR_LABELS.run] as RunId | undefined;
      if (terminal.address !== address || terminal.state !== 'live' || !machine || labels[HERDR_LABELS.kind] !== HERDR_KINDS.remoteConsole
        || labels[HERDR_LABELS.session] !== current.sessionId || labels[HERDR_LABELS.ownerCore] !== current.terminal.coreId
        || !runId && labels[HERDR_LABELS.ownerTerminal] !== current.terminal.terminalId
        || runId && !withStore(current, store => store.get(runId)?.session_id === current.sessionId)) return null;
      return { version: 1, id, owner: current, machine, kind: 'exec', ...(runId ? { runId } : {}), phase: { kind: 'running', address, releasedAt: 0 }, viewer: null,
        localDirectory: join(need(config).globalRoot, 'herdr/observer-views', createHash('sha256').update(id).digest('hex')), remoteDirectory: '', detached: false, noticeMode: 'tool', notice: 'observed' };
    }
    const job = (await readJobJournal(journalRoot(), current)).find(job => job.id === id);
    const runId = job?.runId;
    if (!job || !('address' in job.phase) || !await on(job.machine)
      || runId && !withStore(current, store => store.get(runId)?.session_id === current.sessionId)) return null;
    let terminal;
    try { terminal = await hc.get(job.phase.address); }
    catch (error) {
      if (!(error instanceof HerdrError) || error.code !== 'not_found') throw error;
      return job.terminalReleased && job.phase.kind === 'finished' && job.notice === 'observed' && job.output?.complete
        && job.owner.sessionId === current.sessionId && job.owner.terminal.coreId === current.terminal.coreId ? { ...job, owner: current } : null;
    }
    const labels = terminal.labels;
    if (terminal.address !== job.phase.address || labels[HERDR_LABELS.job] !== id || labels[HERDR_LABELS.kind] !== job.kind
      || labels[HERDR_LABELS.session] !== current.sessionId || labels[HERDR_LABELS.ownerCore] !== job.owner.terminal.coreId
      || labels[HERDR_LABELS.ownerTerminal] !== job.owner.terminal.terminalId || (labels[HERDR_LABELS.run] ?? undefined) !== job.runId) return null;
    return { ...job, owner: current };
  };
  const cancelJob = async (id: string, suppliedOwner: Owner): Promise<KillJobResult> => {
    if (owner !== suppliedOwner || stopped) throw new HerdrError('herdr-unavailable', 'No active session owns remote jobs');
    return killOwnedJob(id, suppliedOwner, hc, need(config).machines, journalRoot(), remote);
  };
  const openJobObserver = async (id: JobId, suppliedOwner: Owner, signal?: AbortSignal): Promise<TerminalAddress> => {
    if (owner !== suppliedOwner || stopped) throw new HerdrError('herdr-unavailable', 'Observer owner is no longer active');
    const existing = observerViews.get(id);
    if (existing) {
      const view = await existing;
      try { if ((await view.hc.get(view.handle.viewer)).state === 'live') return view.handle.viewer; }
      catch (error) { if (!(error instanceof HerdrError) || error.code !== 'not_found') throw error; }
      await view.handle.release(); observerViews.delete(id);
    }
    const promise = (async () => {
      const job = await observerJob(id, suppliedOwner);
      if (!job) throw new HerdrError('not_found', 'No labelled job or console belongs to this session');
      if (owner !== suppliedOwner || stopped) throw new HerdrError('aborted', 'Observer owner stopped during lookup');
      const ownedClient = need(client);
      const handle = await openRemoteObserver(job, { hc: ownedClient, app: need(app), panes: need(panes),
        viewerExecutable: [process.execPath, join(options.packageRoot, 'dist/herdr/cli.mjs'), '--remote-observer'], hcBinary: need(config).core.binary,
        nonce: randomBytes(16).toString('hex'), deadlineAt: Date.now() + 10000, clock: Date.now,
        signal: AbortSignal.any([observerAbort.signal, ...(signal ? [signal] : [])]) });
      return { handle, hc: ownedClient };
    })();
    observerViews.set(id, promise);
    try { return (await promise).handle.viewer; }
    catch (error) { if (observerViews.get(id) === promise) observerViews.delete(id); throw error; }
  };
  const runtimePath = (on: string) => { const path = runtimePaths.get(on); if (!path) throw new HerdrError('runtime-target-unavailable', 'Destination runtime has not been resolved'); return path; };
  const sessions = registerHerdrSessions(registrationPi, { ...inventory, registry, processIdentity,
    currentSession: ctx => ({ ...processIdentity, sessionFile: (ctx as Partial<ExtensionContext> | undefined)?.sessionManager?.getSessionFile?.() ?? null, sessionName: pi.getSessionName?.() ?? null, kind: 'top-level', hcAddress: owner?.terminal.address ?? null }), owner: () => owner,
    coreStartedAt: () => epoch,
    launchEnvironment: { agentDirectory: resolve(getAgentDir()), extensionArguments: explicitExtensionArguments(process.argv) }, env: process.env,
    warn: message => {
      if (context?.hasUI && context.ui?.notify) context.ui.notify(message, 'warning');
      else process.stderr.write(message + '\n');
    },
  });
  const statusPi = new Proxy(registrationPi, { get(target, key) { if (key === 'on') return (name: string, handler: Function) => {
    if (name === 'session_shutdown') stopStatus = () => handler({}, context);
    return registrationPi.on(name as 'session_start', ((event: unknown, ctx: ExtensionContext) => name !== 'session_start' || ctx?.hasUI && owner ? handler(event, ctx) : undefined) as never);
  }; return Reflect.get(target, key); } });
  const status = registerHerdrStatusContribution(statusPi, { currentOwner: () => owner,
    listPending: o => withStore(o, store => { const counts = { queued: 0, running: 0, paused: 0 }; for (const row of store.listActive(o.sessionId)) if (row.status in counts) counts[row.status as keyof typeof counts]++; return counts; }),
    subscribeRuns: (o, listener) => bus.on(event => { if (event.sessionId === o.sessionId) listener(); }), reportDisabled: report,
  });
  const jobPorts: JobRegistrationPorts = { currentOwner: () => owner,
    activationFailed: error => { remoteUnavailableReason = remoteUnavailableNotice(error, 'session', 'monitor'); }, bind: m => {
    monitor = m;
    if (m) remoteUnavailableReason = undefined;
    remote = m ? withRemoteCopy(createRemoteExecutor({ hc, jobs: m, prepare: (source, target) => need(remoteFiles).prepare(source, target), target: async on => {
      const resolved = await resolveMachine(hc, need(config).machines, on), machine = resolved.machine;
      const bytes = await readFile(join(options.packageRoot, 'dist/herdr/remote-runtime.mjs'));
      runtimePaths.set(resolved.on, runtimeInstallPath(machine.runtime.directory, bytes));
      return { on: resolved.on, ...machine.runtime, nodePath: machine.nodePath ?? 'node', environment: {}, runtimePath: runtimePath(resolved.on), runtimeSha256: (await import('@spider/herdr/remote/runtime')).sha256(bytes) };
    }, environmentPolicy: env => environment(env), logSink: async (job, readerOptions) => need(output).logReader(job.id, readerOptions), clock: Date.now }), hc, () => need(config).machines, () => join(need(config).globalRoot, 'herdr/copy-cleanup')) : undefined;
  }, jobIdsForToolResult,
    monitorOptions: () => ({ hc, app: need(app), clock: Date.now, journalRoot: journalRoot(), outputCollector: need(output).outputCollector, reportError: report, recordCleanupError: error => options.reportError?.(error),
      reportConsoleError: error => { if (options.reportError) options.reportError(error); else process.stderr.write(herdrErrorNotice(error) + '\n'); },
      panes: { reserve: (...args) => need(panes).reserveRemote(...args), abandon: slot => need(panes).abandon(slot), observe: async job => { throw new HerdrError('explicit-observer-only', `Job ${job.id} must be opened through openJob`); } },
    }),
  };
  const jobs = registerHerdrJobs(registrationPi, jobPorts);
  offs.push(registrationPi.on('session_start', async () => {
    if (!owner || !context || stopped) return;
    const current = owner;
    const killViaOwner = async (id: string) => {
      const ctx = need(context);
      const result = options.killAction ? await options.killAction(ctx, id) : await makeKillHandler()({ id }, options.actionContext(ctx));
      if (result && typeof result === 'object' && ('isError' in result && result.isError || 'error' in result && result.error))
        throw new HerdrError('unavailable', 'The owning session could not stop the target');
    };
    endpoint = await startSessionEndpoint(current, {
      reportError: report, available: availabilityReporter(context),
      currentOwner: () => owner, liveCapabilities: () => status.currentStatus(current),
      ownsRun: id => withStore(current, store => store.get(id)?.session_id === current.sessionId),
      subscribeRun: (id, cursor, emit, options) => ({ dispose: need(transcript).subscribe(id, cursor, emit, options) }),
      steerRun: async (id, text) => {
        const result = await makeMessageHandler()({ to: id, message: text }, options.actionContext(need(context)));
        return result.details as SteerReply;
      }, openView: view => views[view](need(context)),
      openRun: async (id, signal) => {
        const opening = need(panes).acquire('subagent', id, current, { timeoutMs: 30_000, signal, ownerRelative: true }).then(reservation => reservation?.viewer ?? null);
        pendingRunOpens.add(opening);
        try { return await opening; }
        finally { pendingRunOpens.delete(opening); }
      },
      moveRun: async (id, destination) => (await need(panes).moveRun(id, current, destination, { timeoutMs: 20_000 }))?.viewer ?? null,
      moveSession: destination => moveOwnedSession({ sessionId: current.sessionId, terminal: current.terminal.address, coreId: current.terminal.coreId }, destination, {
        app: need(app), appIdentity: need(config).app.home, hc: need(client), journalRoot: join(need(config).globalRoot, 'herdr/spaces'), placementRoot: join(need(config).globalRoot, 'herdr/panes'),
        layoutSnapshot: () => readAppLayout(need(config).app.binary, { ...process.env, HERDR_APP_HOME: need(config).app.home }), clock: Date.now,
      }),
      prepareSessionStop: async () => {
        await teardownSessionAsync(current.sessionId, { reason: 'Session explicitly killed from the pane menu.' });
      },
      killSessionTerminal: async () => {
        if (stopped || owner?.sessionId !== current.sessionId || owner.generation !== current.generation) return;
        const ctx = need(context);
        try { await need(client).kill(current.terminal.address); }
        catch (error) {
          if (ctx.hasUI) ctx.ui.notify(HERDR_NOTICES.sessionKillFailed.text, 'error');
          throw error;
        }
      },
      killRun: killViaOwner,
      ownsJob: async id => await observerJob(id, current) !== null,
      moveJob: async (id, viewer, destination) => (await need(panes).moveJob(id, current, viewer, destination, { timeoutMs: 20_000 }))?.viewer ?? null,
      openJob: async (id, signal) => (await need(panes).acquire('remote', id, current, { timeoutMs: 30_000, signal }))?.viewer ?? null,
      killJob: async id => { await cancelJob(id, current); },
    }, join(need(config).globalRoot, 'herdr'), need(config).limits.completedHours);
    source = createHerdrDataSource({ resolveRunDb: bindDb,
      openApprovalDbs: options.dataSource?.openApprovalDbs ?? (o => { const project = resolveProject(o.cwd); return { global: openGlobal(), repo: project.repoKey ? { db: openRepo(project.repoKey), repoKey: project.repoKey } : null }; }),
      runEvents: bus,
      scheduler: options.dataSource?.scheduler ?? { listTriggers: () => [], subscribe: () => () => {} },
      readUsage: options.dataSource?.readUsage ?? (async () => ({ snapshots: [], budget: undefined, correctedMonth: null, correctedWindow: null, updatedAt: null })),
      readConfig: () => need(config), clock: Date.now,
      readOwnerFacts: async o => {
        let placement: SessionFeed['placement'] = null;
        try { const p = await need(app).ownerPlacement(o.terminal.address); placement = { spaceId: p.space, spaceName: null, spaceOrder: null, tabId: p.tab }; } catch { /* Unknown placement stays unknown. */ }
        return { placement, status: status.currentStatus(o) ?? { native: null, effective: null, message: null }, ipc: endpoint?.descriptor ?? null };
      },
    });
    const startingSource = source, feedRoot = join(need(config).globalRoot, 'herdr');
    heartbeatTimer = setInterval(() => {
      if (stopped || owner !== current || source !== startingSource || sessionFeedWritePending(feedRoot, current)) return;
      heartbeatPending = feedResult(publishSessionHeartbeat(feedRoot, current, Date.now()));
      void heartbeatPending.catch(report);
    }, 2000);
    heartbeatTimer.unref?.();
    // Startup needs one published snapshot, not a drained stream of refreshes.
    // Subscribe afterward even on failure, so later observations can retry.
    try { await publish(); }
    finally {
      if (source === startingSource && !stopped) unsubscribe = startingSource.subscribe(() => { void publish().catch(report); });
    }
  }));
  const viewers = registerHerdrViewers(registrationPi, { owner: () => owner, hc, panes: panePort, viewerLauncher: launcher, viewerExecutable, get feedRoot() { return config ? join(config.globalRoot, 'herdr') : root; }, ipcDescriptor: () => endpoint?.descriptor ?? null,
    ownedRunEvents: { list: async o => withStore(o, store => store.listActive(o.sessionId).map(row => row.id as RunId)), subscribe: (o, listener) => bus.on(event => { if (event.sessionId === o.sessionId) listener(event.runId as RunId); }) }, reportError: report });

  const routingPorts: RoutingPorts = { policy: { checkArgv: argv => policy ? policy.checkArgv(argv) : Promise.resolve({ kind: 'refuse', reason: 'Managed-machine cache unavailable' }), checkShell: code => policy ? policy.checkShell(code) : Promise.resolve({ kind: 'refuse', reason: 'Managed-machine cache unavailable' }) }, environmentPolicy: env => environment(env), currentOwner: () => owner,
    createBashTool, createLocalBashOperations, enabled: () => Boolean(owner && !stopped),
    readShellFile: async (file, on) => on ? need(remoteFiles).read(file, on as MachineName) : readFile(resolve(context?.cwd ?? process.cwd(), file), 'utf8'),
  };

  const agentConsoles = registerAgentConsoleLifecycle(registrationPi, { hc, currentOwner: () => owner, reportError: report,
    beforeReap: async console => {
      const labels = console.labels, runId = labels[HERDR_LABELS.run], sessionId = labels[HERDR_LABELS.session];
      if (!runId || !sessionId) return true;
      const store = createJobStore(journalRoot(), sessionId as Owner['sessionId'], runId as RunId);
      const journal = await store.read(), child = journal.child;
      if (!child || child.ended || child.settled || processStartIdentity(child.pid) === child.startIdentity) return true;
      // Run status and console events can arrive while handoff is still cancelling a crashed writer.
      if (owner?.sessionId === sessionId) await monitor?.reconcile();
      return foregroundJobsStopped(await store.read(), hc);
    },
    runIsLive: async console => {
      const current = owner, labels = console.labels, runId = labels[HERDR_LABELS.run];
      if (!current || !runId || labels[HERDR_LABELS.session] !== current.sessionId
        || labels[HERDR_LABELS.ownerCore] !== current.terminal.coreId) return null;
      const run = withStore(current, store => store.get(runId));
      if (!run || run.session_id !== current.sessionId) return null;
      return !['done', 'failed', 'cancelled'].includes(run.status);
    },
    subscribeRunEnds: (current, listener) => bus.on(event => {
      const payload = event.payload as { status?: unknown } | undefined;
      if (event.sessionId === current.sessionId && event.runId && event.type === 'status'
        && ['done', 'failed', 'cancelled'].includes(String(payload?.status))) listener(event.runId as RunId);
    }),
    ownerIsLive: async console => {
      const labels = console.labels, terminalId = labels[HERDR_LABELS.ownerTerminal], sessionId = labels[HERDR_LABELS.session];
      if (!owner || labels[HERDR_LABELS.ownerCore] !== owner.terminal.coreId || !terminalId || !sessionId) return null;
      const records = (await inventory.presence.list()).filter(record => record.sessionId === sessionId && record.hcAddress === terminalId && record.kind === 'top-level');
      let unknown = false;
      for (const record of records) {
        const state = await inventory.probe(record.pid);
        if (state.kind === 'live' && state.startIdentity === record.startIdentity) return true;
        if (state.kind === 'unknown') unknown = true;
      }
      if (records.length) return unknown ? null : false;
      try { return (await hc.get(terminalId as TerminalAddress)).state === 'live' ? null : false; }
      catch (error) { if (error instanceof HerdrError && error.code === 'not_found') return false; throw error; }
    },
  });
  offs.push(registrationPi.on('session_shutdown', async event => {
    ++lifecycle; await coreProbe?.catch(report);
    // Reload hands a completed visible open to the next activation.
    if (event.reason === 'reload') await Promise.allSettled([...pendingRunOpens]);
    await closeFeed(event.reason === 'quit'); await closeResources(); context = null;
  }));
  const guard: HerdrMount['guard'] = async event => {
    if (owner && !stopped) await probeCore(owner);
    if (coreLost && event.input.on !== undefined) return { block: true, reason: remoteUnavailableReason ?? HERDR_NOTICES.guardCore.text };
    if (!coreLost && !remote && remoteUnavailableReason && event.input.on !== undefined) return { block: true, reason: remoteUnavailableReason };
    if (!owner || stopped || config?.enabled === false || !config) return event.input.on !== undefined ? { block: true, reason: HERDR_NOTICES.remoteDisabled.text } : undefined;
    return guardHerdrToolCall(event, routingPorts);
  };
  return { owner: () => owner, enabled: () => Boolean(owner && !stopped), findKillJobs: id => findOwnedKillJobs(id, need(owner), journalRoot()), killJob: id => cancelJob(id, need(owner)), prepareSessionReplacement: () => closeFeed(false, 'wrong-generation'),
    prepareSessionQuit: async () => { try { await endpoint?.dispose(); } catch (error) { report(error); } finally { endpoint = null; } }, execution: () => ({ ...(owner ? { owner } : {}), ...(remote ? { remote } : {}), ...(!remote ? { remoteUnavailableReason: remoteUnavailableReason ?? HERDR_NOTICES.remoteDisabled.text } : {}), environmentPolicy: env => environment(env), ...(owner && config ? { supervisorHcBinary: config.core.binary } : {}) }), guard,
    async dispose() { if (disposed) return; disposed = true; ++lifecycle; for (const off of offs) off(); await coreProbe?.catch(report); agentConsoles.dispose(); await closeFeed(); await viewers.dispose(); await jobs.dispose(); status.dispose(); shortcuts?.dispose(); await routing?.dispose(); await sessions.dispose(); await closeResources(); },
  };
}

export function jobIdsForToolResult(result: unknown): readonly JobId[] {
  const ids = new Set<JobId>();
  const visit = (value: unknown) => { if (!value || typeof value !== 'object') return; if (Array.isArray(value)) { for (const row of value) visit(row); return; } const r = value as Record<string, unknown>; const remote = r.remote as Record<string, unknown> | undefined; if (remote && typeof remote.jobId === 'string') ids.add(remote.jobId as JobId); if (r.details) visit(r.details); if (r.results) visit(r.results); };
  visit(result); return [...ids];
}

import { existsSync, constants } from 'node:fs';
import { readFile, access, writeFile, realpath, stat, open, readdir } from 'node:fs/promises';
import { join, dirname, resolve, basename, isAbsolute } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { createBashTool, createLocalBashOperations, getAgentDir } from '@earendil-works/pi-coding-agent';
import { bus, openGlobal, openGlobalReadOnly, openRepo, resolveProject, paths } from '@spider/db-core';
import { RunStore, makeMessageHandler } from '@spider/subagents';
import { processStartTime } from '../../../subagents/src/process-identity.js';
import { createRemoteFileResolver } from './remote-file.js';
import { createHcClient } from '@spider/herdr/client/hc';
import { isCoreAvailable } from '@spider/herdr/client/liveness';
import { createAppClient } from '@spider/herdr/client/app';
import { parseHerdrConfig } from '@spider/herdr/config';
import { registerHerdrStatusContribution } from '@spider/herdr/status/register';
import { publishSessionFeed, coalesceFeedWrites } from '@spider/herdr/feed/publisher';
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
import { createMachineCache, type MachineCache } from '@spider/herdr/ssh/cache';
import { createTransportPolicy } from '@spider/herdr/ssh/admin';
import { createSshPolicy, type SshPolicy } from '@spider/herdr/ssh/policy';
import { createExecutionEnvironmentPolicy, installSshShim, sshShimDirectory } from '@spider/herdr/ssh/shim';
import { registerHerdrRouting, guardHerdrToolCall, type RoutingPorts } from '@spider/herdr/ssh/register';
import { registerHerdrShortcuts } from '@spider/herdr/shortcuts/register';
import { regenerateGlobalHerdrTemplates, type TemplatePorts } from '@spider/herdr/templates/register';
import { snapshot } from '@spider/herdr/setup/backup';
import { HerdrError } from '@spider/herdr/client/parse';
import type { HcClient, HerdrConfig, Owner, Disposable, AuxiliaryPanes, RunId, JobId, JobRecord, MachineName, TerminalAddress, RemoteExecutionPort, ExecutionEnvironmentPolicy, SessionFeed, SteerReply, TerminalIdentity, CoreIdentity } from '@spider/herdr';
import { createHerdrDataSource } from './data-source.js';
import { createRunTranscriptSource } from './run-transcript.js';
import { createHerdrViews } from './views.js';
import { openSessionRunDb } from '../session-run-db.js';
import { controlConfig, configValues, modelDefaultLayers } from '../control.js';
import { mountChildHerdr } from './child.js';
import { coreStartedAt, disabledHerdrEnvironment, verifiedHerdrFile, createHostHerdrPorts, createProcessInventory, explicitExtensionArguments, readJobJournal, type HostHerdrOptions, type HostHerdrPorts } from './ports.js';
export type { HostHerdrOptions } from './ports.js';

const INACTIVE_NOTICE = Symbol.for('spider.herdr.inactive-notices.v1');
interface InactiveNotice { sessions: Set<string>; displayed: boolean; configWarnings?: Set<string>; terminal?: TerminalIdentity; ownershipNotices?: Set<string>; recoveryNotices?: Set<string>; errorNotices?: Map<string, Set<string>>; registryWarnings?: Set<string> }
const hostGlobal = globalThis as typeof globalThis & { [INACTIVE_NOTICE]?: WeakMap<object, InactiveNotice> };
const inactiveNotices = hostGlobal[INACTIVE_NOTICE] ??= new WeakMap<object, InactiveNotice>();
function inactiveNotice(ctx: ExtensionContext, mode: unknown, reason: string, expected = true): void {
  const manager = ctx.sessionManager ?? ctx, session = ctx.sessionManager?.getSessionId?.() ?? '(session)';
  let notice = inactiveNotices.get(manager);
  // Clear a footer left by an earlier extension version across /reload.
  if (notice?.displayed) { ctx.ui?.setStatus?.('spider-herdr', undefined); notice.displayed = false; }
  if (mode === false || mode !== true && !expected || notice?.sessions.has(session)) return;
  notice ??= { sessions: new Set(), displayed: false }; inactiveNotices.set(manager, notice); notice.sessions.add(session);
  const message = `Herdr ${mode === true ? 'activation failed' : 'unavailable'}: ${reason}. Regular spider remains available.`;
  if (ctx.hasUI && ctx.ui?.notify) ctx.ui.notify(message, mode === true ? 'error' : 'warning');
  else process.stderr.write(message + '\n');
}

const RETIRED_TERMINAL_NOTICE = "this session's Herdr terminal belongs to a core that is no longer running; start a new session in Herdr";
function coreNotice(ctx: ExtensionContext, kind: 'ownershipNotices' | 'recoveryNotices', message: string, level: 'warning' | 'error' = 'warning'): void {
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
    if (ctx?.hasUI && ctx.ui?.notify) ctx.ui.notify(message, 'warning');
    else process.stderr.write(message + '\n');
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
  execution(): { owner?: Owner; remote?: RemoteExecutionPort; environmentPolicy: ExecutionEnvironmentPolicy };
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
  let remoteFiles: ReturnType<typeof createRemoteFileResolver> | null = null;
  const runtimePaths = new Map<string, string>();
  let policy: SshPolicy | null = null, environment: ExecutionEnvironmentPolicy = disabledHerdrEnvironment, epoch = 0;
  let source: ReturnType<typeof createHerdrDataSource> | null = null, transcript: ReturnType<typeof createRunTranscriptSource> | null = null;
  let unsubscribe: (() => void) | undefined;
  let routing: Disposable | undefined, shortcuts: Disposable | undefined;
  let stopped = false, coreLost = false, disposed = false, lifecycle = 0, publishing: Promise<void> = Promise.resolve();
  let coreWatch: ReturnType<typeof setInterval> | undefined, coreProbe: Promise<void> | undefined;
  let activationEnv: Readonly<NodeJS.ProcessEnv> | null = null;
  let recovery: object | null = null;
  let stopStatus = () => {};
  let observerAbort = new AbortController();
  const observerViews = new Map<JobId, Promise<{ handle: ObserverHandle; hc: HcClient }>>();
  const notifyError = (ctx: ExtensionContext, error: unknown) => {
    const manager = ctx.sessionManager ?? ctx, session = ctx.sessionManager?.getSessionId?.() ?? '(session)';
    const notice = inactiveNotices.get(manager) ?? { sessions: new Set<string>(), displayed: false };
    inactiveNotices.set(manager, notice);
    const messagesBySession = notice.errorNotices ??= new Map<string, Set<string>>();
    const messages = messagesBySession.get(session) ?? new Set<string>();
    messagesBySession.set(session, messages);
    const message = error instanceof Error ? error.message : String(error);
    if (messages.has(message)) return;
    messages.add(message);
    ctx.ui?.notify?.(`Herdr: ${message}`, 'warning');
  };
  const report = (error: unknown) => {
    options.reportError?.(error);
    const ctx = context;
    if (!ctx) return;
    if (error instanceof HerdrError) {
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
  const panePort: AuxiliaryPanes = { acquire: (...args) => need(panes).acquire(...args), release: r => need(panes).release(r), park: id => need(panes).park(id), dispose: () => panes?.dispose() };
  const views = createHerdrViews(options.views);
  const viewerExecutable = join(options.packageRoot, 'dist/herdr/viewer.mjs');
  const launcher = createViewerLauncher({ hc, owner: () => owner, ipcDescriptor: () => endpoint?.descriptor ?? null, viewerExecutable,
    runInfo: async (id, o) => {
      const { db } = bindDb(o);
      try {
        const store = new RunStore(db), run = store.get(id), parent = run?.parent_run_id ? store.get(run.parent_run_id) : undefined;
        const parentName = parent?.session_id === o.sessionId ? parent.name || parent.id : o.name || 'Agent';
        const recorded = db.prepare("SELECT payload FROM run_events WHERE run_id=? AND session_id=? AND type='child_transcript' ORDER BY id DESC LIMIT 1").get(id, o.sessionId) as { payload: string | null } | undefined;
        let directory: string | undefined;
        if (!recorded) directory = join(paths.scratch('project', o.cwd), 'subagent-sessions', id);
        else {
          try { const location: unknown = JSON.parse(recorded.payload ?? 'null'); if (location && typeof location === 'object' && 'version' in location && location.version === 1 && 'directory' in location && typeof location.directory === 'string') directory = location.directory; } catch { /* Invalid recorded locations do not read a different transcript. */ }
        }
        return { status: run?.status, name: run?.name || id, parentName, steer: run?.child_mode === 'rpc' ? 'rpc' as const : 'headless' as const, cwd: await viewerRunCwd(directory, id) };
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
    reportWarning: message => context?.ui?.notify?.(message, 'warning'),
  };
  const writeFeed = coalesceFeedWrites(async () => {
    const current = owner, currentSource = source;
    if (!current || !currentSource || stopped) return;
    const feed = await currentSource.snapshot(current);
    if (owner === current && !stopped) await publishSessionFeed(join(need(config).globalRoot, 'herdr'), feed);
  });
  const publish = () => { publishing = writeFeed(); return publishing; };
  const closeFeed = async (final = false, handoff: 'disposed' | 'wrong-generation' = 'disposed') => {
    stopped = true; unsubscribe?.(); unsubscribe = undefined;
    await publishing.catch(report);
    if (final && source && owner && config) {
      try { await publishSessionFeed(join(config.globalRoot, 'herdr'), await source.snapshot(owner, 'closed')); }
      catch (error) { report(error); }
    }
    source?.dispose(); source = null; transcript?.dispose(); transcript = null;
    await endpoint?.dispose(handoff); endpoint = null;
  };
  const closeResources = async () => {
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
          coreNotice(ctx, 'ownershipNotices', RETIRED_TERMINAL_NOTICE);
        } else coreNotice(ctx, 'recoveryNotices', 'Herdr core is back. /reload to reconnect.');
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
      stopped = true; coreLost = true; environment = disabledHerdrEnvironment; policy = null; remote = undefined;
      if (replacement) { coreNotice(ctx, 'ownershipNotices', RETIRED_TERMINAL_NOTICE); await pruneOldCoreMappings(replacement); }
      else inactiveNotice(ctx, 'auto', 'Herdr core unavailable; use /reload to recover');
      await closeFeed();
      await Promise.resolve(viewers.dispose()).catch(report);
      await closeResources();
      if (!replacement && !disposed && lifecycle === generation && context === ctx) watchForCore(current, env, ctx, generation);
    })().finally(() => { if (coreProbe === pending) coreProbe = undefined; });
    coreProbe = pending; return pending;
  };
  const offs: (() => void)[] = [];
  offs.push(registrationPi.on('session_start', async (_event, ctx) => {
    if (disposed) return;
    ++lifecycle;
    // Core loss may already be tearing down these same resources. Invalidate its
    // recovery watcher, then join it before installing another activation.
    await coreProbe?.catch(report);
    await closeFeed(); await closeResources(); context = ctx; config = null; coreLost = false;
    let activationMode: unknown = 'auto', expected = Boolean(process.env.HC_TERMINAL_ID);
    const disabled = (reason: string) => inactiveNotice(ctx, activationMode, reason, expected);
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
    } catch (error) { disabled(error instanceof Error ? error.message : String(error)); return; }
    if (!config || config.enabled === false) { disabled(config ? 'herdr.enabled is false' : 'no Herdr configuration'); return; }
    if (!process.env.HC_TERMINAL_ID) { disabled('not inside Herdr'); return; }
    if (ctx.mode !== 'tui' && ctx.mode !== 'rpc') return;
    const env = Object.freeze({ ...process.env });
    if (config.enabled === 'auto' && !await isCoreAvailable(env)) {
      disabled('Herdr core is not running');
      return;
    }
    client = createHcClient({ binary: config.core.binary, env });
    try {
      const core = await client.identity();
      const inheritedTerminal = { ...core, terminalId: env.HC_TERMINAL_ID as TerminalIdentity['terminalId'], address: env.HC_TERMINAL_ID as TerminalAddress };
      if (await hasLiveMappedAncestor(inheritedTerminal, { ...inventory, registry, processIdentity, env })) {
        await closeResources();
        inactiveNotice(ctx, 'auto', 'this terminal is already owned by a live ancestor session');
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
      app = createAppClient(appOptions);
      observerAbort = new AbortController();
      panes = createAuxiliaryPanes({ hc, app, appForSignal: signal => createAppClient(appOptions, signal), subagentViewer: launcher, discardSubagentViewer: launcher.discard, remoteObserver: openJobObserver, limit: config.limits.auxiliaryPanes, clock: Date.now, reportError: report });
      const aliases = Object.fromEntries(config.machines.map(m => [m.name, m.aliases]));
      cache = createMachineCache({ hc, identity: terminal, directory: join(config.globalRoot, 'herdr/ssh'), aliases, reportFailure: report }); await cache.ready;
      policy = createTransportPolicy(createSshPolicy(cache), () => env);
      const shimDirectory = sshShimDirectory(cache.descriptor);
      const shimOptions = { shimDirectory, realSshBinary: await resolveRealSshBinary(env, shimDirectory), cacheDescriptor: cache.descriptor, shimProgram: join(options.packageRoot, 'dist/herdr/cli.mjs'), reportDisabled: report };
      await installSshShim(shimOptions); environment = createExecutionEnvironmentPolicy(shimOptions);
      remoteFiles = createRemoteFileResolver(hc, config.machines, { manager: ctx.sessionManager ?? ctx, id: owner.sessionId });
      output = createHostHerdrPorts({ hc, config, runtimeBytes: Buffer.alloc(0), runtimePath: on => runtimePath(on) });
      transcript = createRunTranscriptSource({ owner: () => owner, resolveDb: bindDb, openBindingDb: openGlobalReadOnly, transcriptRoots: o => [paths.scratch('project', o.cwd)].filter(root => existsSync(root)) });
      inactiveNotice(ctx, false, '');
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
      await closeResources();
      if (error instanceof HerdrError && ['terminal-core-mismatch', 'core-mismatch'].includes(error.code)) coreNotice(ctx, 'ownershipNotices', error.message, activationMode === true ? 'error' : 'warning');
      else disabled(error instanceof Error ? error.message : String(error));
    }
  }));
  // Read-only projection: a parent must not write an active child's job journal to open a view.
  const observerJob = async (id: JobId, current: Owner): Promise<JobRecord | null> => {
    const on = (name: string | undefined): MachineName | null => name && need(config).machines.some(m => m.name === name) ? name as MachineName : null;
    if (id.startsWith('console:')) {
      const address = id.slice('console:'.length) as TerminalAddress;
      let terminal;
      try { terminal = await hc.get(address); } catch (error) { if (error instanceof HerdrError && error.code === 'not_found') return null; throw error; }
      const labels = terminal.labels, machine = on(labels[HERDR_LABELS.machine]), runId = labels[HERDR_LABELS.run] as RunId | undefined;
      if (terminal.address !== address || terminal.state !== 'live' || !machine || labels[HERDR_LABELS.kind] !== HERDR_KINDS.remoteConsole
        || labels[HERDR_LABELS.session] !== current.sessionId || labels[HERDR_LABELS.ownerCore] !== current.terminal.coreId
        || labels[HERDR_LABELS.ownerTerminal] !== current.terminal.terminalId
        || runId && !withStore(current, store => store.get(runId)?.session_id === current.sessionId)) return null;
      return { version: 1, id, owner: current, machine, kind: 'exec', ...(runId ? { runId } : {}), phase: { kind: 'running', address, releasedAt: 0 }, viewer: null,
        localDirectory: join(need(config).globalRoot, 'herdr/observer-views', createHash('sha256').update(id).digest('hex')), remoteDirectory: '', detached: false, noticeMode: 'tool', notice: 'observed' };
    }
    const job = (await readJobJournal(journalRoot(), current)).find(job => job.id === id);
    const runId = job?.runId;
    if (!job || !('address' in job.phase) || !on(job.machine)
      || runId && !withStore(current, store => store.get(runId)?.session_id === current.sessionId)) return null;
    let terminal;
    try { terminal = await hc.get(job.phase.address); } catch (error) { if (error instanceof HerdrError && error.code === 'not_found') return null; throw error; }
    const labels = terminal.labels;
    if (terminal.address !== job.phase.address || labels[HERDR_LABELS.job] !== id || labels[HERDR_LABELS.kind] !== job.kind
      || labels[HERDR_LABELS.session] !== current.sessionId || labels[HERDR_LABELS.ownerCore] !== job.owner.terminal.coreId
      || labels[HERDR_LABELS.ownerTerminal] !== job.owner.terminal.terminalId || (labels[HERDR_LABELS.run] ?? undefined) !== job.runId) return null;
    return { ...job, owner: current };
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
  });
  const statusPi = new Proxy(registrationPi, { get(target, key) { if (key === 'on') return (name: string, handler: Function) => {
    if (name === 'session_shutdown') stopStatus = () => handler({}, context);
    return registrationPi.on(name as 'session_start', ((event: unknown, ctx: ExtensionContext) => name !== 'session_start' || ctx?.hasUI && owner ? handler(event, ctx) : undefined) as never);
  }; return Reflect.get(target, key); } });
  const status = registerHerdrStatusContribution(statusPi, { currentOwner: () => owner,
    listPending: o => withStore(o, store => { const counts = { queued: 0, running: 0, paused: 0 }; for (const row of store.listActive(o.sessionId)) if (row.status in counts) counts[row.status as keyof typeof counts]++; return counts; }),
    subscribeRuns: (o, listener) => bus.on(event => { if (event.sessionId === o.sessionId) listener(); }), reportDisabled: report,
  });
  const jobPorts: JobRegistrationPorts = { currentOwner: () => owner, bind: m => {
    monitor = m;
    remote = m ? createRemoteExecutor({ hc, jobs: m, prepare: (source, target) => need(remoteFiles).prepare(source, target), target: async on => {
      const machine = need(config).machines.find(m => m.name === on); if (!machine) throw new HerdrError('machine-unconfigured', 'Destination is not configured');
      const bytes = await readFile(join(options.packageRoot, 'dist/herdr/remote-runtime.mjs'));
      runtimePaths.set(on, runtimeInstallPath(machine.runtime.directory, bytes));
      return { on, ...machine.runtime, nodePath: machine.nodePath ?? 'node', environment: {}, runtimePath: runtimePath(on), runtimeSha256: (await import('@spider/herdr/remote/runtime')).sha256(bytes) };
    }, environmentPolicy: env => environment(env), logSink: async job => need(output).logReader(job.id), clock: Date.now }) : undefined;
  }, jobIdsForToolResult,
    monitorOptions: () => ({ hc, app: need(app), clock: Date.now, journalRoot: journalRoot(), outputCollector: need(output).outputCollector, reportError: report,
      panes: { reserve: (...args) => need(panes).reserveRemote(...args), abandon: slot => need(panes).abandon(slot), observe: async job => { throw new HerdrError('explicit-observer-only', `Job ${job.id} must be opened through openJob`); } },
    }),
  };
  const jobs = registerHerdrJobs(registrationPi, jobPorts);
  offs.push(registrationPi.on('session_start', async () => {
    if (!owner || !context || stopped) return;
    const current = owner;
    endpoint = await startSessionEndpoint(current, {
      reportError: report,
      currentOwner: () => owner, liveCapabilities: () => status.currentStatus(current),
      ownsRun: id => withStore(current, store => store.get(id)?.session_id === current.sessionId),
      subscribeRun: (id, cursor, emit) => ({ dispose: need(transcript).subscribe(id, cursor, emit) }),
      steerRun: async (id, text) => {
        const result = await makeMessageHandler()({ to: id, message: text }, options.actionContext(need(context)));
        return result.details as SteerReply;
      }, openView: view => views[view](need(context)),
      openRun: async id => (await need(panes).acquire('subagent', id, current, { timeoutMs: 30_000 }))?.viewer ?? null,
      ownsJob: async id => await observerJob(id, current) !== null,
      openJob: async id => (await need(panes).acquire('remote', id, current, { timeoutMs: 30_000 }))?.viewer ?? null,
    }, join(need(config).globalRoot, 'herdr'), need(config).limits.completedHours);
    source = createHerdrDataSource({ resolveRunDb: bindDb,
      openApprovalDbs: options.dataSource?.openApprovalDbs ?? (o => { const project = resolveProject(o.cwd); return { global: openGlobal(), repo: project.repoKey ? { db: openRepo(project.repoKey), repoKey: project.repoKey } : null }; }),
      runEvents: bus, readJobJournal: o => readJobJournal(journalRoot(), o),
      scheduler: options.dataSource?.scheduler ?? { listTriggers: () => [], subscribe: () => () => {} },
      readUsage: options.dataSource?.readUsage ?? (async () => ({ snapshots: [], budget: undefined, correctedMonth: null, correctedWindow: null, updatedAt: null })),
      readConfig: () => need(config), clock: Date.now,
      readOwnerFacts: async o => {
        let placement: SessionFeed['placement'] = null;
        try { const p = await need(app).ownerPlacement(o.terminal.address); placement = { spaceId: p.space, spaceName: null, spaceOrder: null, tabId: p.tab }; } catch { /* Unknown placement stays unknown. */ }
        return { placement, status: status.currentStatus(o) ?? { native: null, effective: null, message: null }, ipc: endpoint?.descriptor ?? null };
      },
    });
    const startingSource = source;
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
        || labels[HERDR_LABELS.ownerCore] !== current.terminal.coreId || labels[HERDR_LABELS.ownerTerminal] !== current.terminal.terminalId) return null;
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
  offs.push(registrationPi.on('session_shutdown', async event => { ++lifecycle; await coreProbe?.catch(report); await closeFeed(event.reason === 'quit'); await closeResources(); context = null; }));
  const guard: HerdrMount['guard'] = async event => {
    if (owner && !stopped) await probeCore(owner);
    if (!owner || stopped || config?.enabled === false || !config) return event.input.on !== undefined ? { block: true, reason: 'herdr-disabled: on requires an enabled live Herdr owner' } : undefined;
    return guardHerdrToolCall(event, routingPorts);
  };
  return { owner: () => owner, enabled: () => Boolean(owner && !stopped), prepareSessionReplacement: () => closeFeed(false, 'wrong-generation'),
    prepareSessionQuit: async () => { try { await endpoint?.dispose(); } catch (error) { report(error); } finally { endpoint = null; } }, execution: () => ({ ...(owner ? { owner } : {}), ...(remote ? { remote } : {}), environmentPolicy: env => environment(env) }), guard,
    async dispose() { if (disposed) return; disposed = true; ++lifecycle; for (const off of offs) off(); await coreProbe?.catch(report); agentConsoles.dispose(); await closeFeed(); await viewers.dispose(); await jobs.dispose(); status.dispose(); shortcuts?.dispose(); await routing?.dispose(); await sessions.dispose(); await closeResources(); },
  };
}

export function jobIdsForToolResult(result: unknown): readonly JobId[] {
  const ids = new Set<JobId>();
  const visit = (value: unknown) => { if (!value || typeof value !== 'object') return; if (Array.isArray(value)) { for (const row of value) visit(row); return; } const r = value as Record<string, unknown>; const remote = r.remote as Record<string, unknown> | undefined; if (remote && typeof remote.jobId === 'string') ids.add(remote.jobId as JobId); if (r.details) visit(r.details); if (r.results) visit(r.results); };
  visit(result); return [...ids];
}

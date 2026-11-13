import { spawn } from 'node:child_process';
import { constants as fileFlags, readlinkSync } from 'node:fs';
import { stripVTControlCharacters } from 'node:util';
import { realpath, stat, appendFile, open } from 'node:fs/promises';
import { scrubSecrets } from '@spider/memory';
import { ModelRuntime, ModelRegistry, getAgentDir, type CreateModelRuntimeOptions } from '@earendil-works/pi-coding-agent';
import { createHcClient, invokeCli } from '@spider/herdr/client/hc';
import { invokeCli as invokeAppCli } from '@spider/herdr/client/cli-transport';
import { createAppClient } from '@spider/herdr/client/app';
import { parseHerdrConfig } from '@spider/herdr/config';
import { runSshShim, ordinaryExecutionEnvironment, SSH_DESCRIPTOR_ENV } from '@spider/herdr/ssh/shim';
import { runRemoteObserver, observerMarker } from '@spider/herdr/jobs/observer';
import { createJobStore, type JournalJob } from '@spider/herdr/jobs/store';
import { preflightSpaces, setupSpaces, readCutoverRecovery, reconcileSpaceJournal, planSpaceCutover, tabTerminals, forgetCutoverTabs, type SpaceSetupPorts, type LayoutSnapshot } from '@spider/herdr/spaces/setup';
import { offerResume, resumeOfferShell, buildResumeBlock, shellQuote } from '@spider/herdr/sessions/resume';
import { discoverSessions, selectedProcessInventory } from '@spider/herdr/spaces/discovery';
import { launchSession } from '@spider/herdr/sessions/launcher';
import { applyLookPatches, type HerdrClones, type LookPatchSet } from '@spider/herdr/look/patches';
import { buildGlassLayout } from '@spider/herdr/look/layout';
import { prepareFonts } from '@spider/herdr/look/fonts';
import { checkThemeContrast, type PiThemeData } from '@spider/herdr/look/contrast';
import { readGlobalHerdrTemplateFiles } from '@spider/herdr/templates/register';
import { inspectHerdrShortcutCollisions } from '@spider/herdr/shortcuts/register';
import { HerdrLabelContract, HERDR_LABELS } from '@spider/herdr';
import { readLayer, configValues } from '../control.js';
import { paths } from '@spider/db-core';
import { doctorHerdr, checkNodeVersion, probeLaunch, type DoctorParts, type DoctorItem, type DoctorFailure, type DoctorInformation } from '@spider/herdr/setup/doctor';
import { feedWriterLiveness } from '@spider/herdr/feed/writer';
import { sessionFeedIsFresh } from '@spider/herdr/feed/freshness';
import { snapshot, digest, managedProjection, rootNotesValue, readJournal, saveJournal, withSetupLock, validateFiles, prepareBackups, applyFiles } from '@spider/herdr/setup/backup';
import { CoreOnlySetupError, runtimeInstallPath, standardHerdrConfigPath, type SetupRequest, type SetupParts, type SetupContext, type InstallFile, type RuntimeFile, type RuntimeRootObservation } from '@spider/herdr/setup/installer';
import type { HerdrCliPorts } from '@spider/herdr/setup/cli';
import type { CoreIdentity, TerminalIdentity, TerminalAddress, MachineName, HcRunRequest } from '@spider/herdr';
import { parseFeed } from '../../../herdr/assets/shared/feed.js';
import { createSessionIpcClient } from '@spider/herdr/feed/ipc-client';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { join, resolve, isAbsolute, dirname } from 'node:path';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { createMemoryReviewDbs, decideMemoryReview, listMemoryReview } from './memory-review.js';
import { createProcessPresence } from '@spider/herdr/sessions/presence';
import { createSessionLeases, assessSessionLiveness, type ProcessIdentity, type ProcessInventoryPorts, type ProcessProbe } from '@spider/herdr/sessions/lease';
import { claimIdLock } from '@spider/herdr/sessions/id-lock';
import { createTerminalRegistry, readPrivateJson, recordedExtensionArguments } from '@spider/herdr/sessions/registry';
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
import { HerdrError } from '@spider/herdr/client/parse';
import { resolveMachine } from './machine.js';
import { HERDR_NOTICES, duplicateSessionNotice, installedModMismatchNotice, rollbackForeignPanesNotice, switchedSessionNotice } from '@spider/herdr/notices';

export function disabledHerdrEnvironment(env: Readonly<NodeJS.ProcessEnv>): Readonly<NodeJS.ProcessEnv> {
  const next = { ...env };
  try { const descriptor = JSON.parse(next[SSH_DESCRIPTOR_ENV] ?? 'null'); if (typeof descriptor?.shimDirectory === 'string') { const separator = process.platform === 'win32' ? ';' : ':'; next.PATH = next.PATH?.split(separator).filter(path => path !== descriptor.shimDirectory).join(separator); } } catch { /* Disabled means an inherited malformed policy is ignored, not activated. */ }
  delete next[SSH_DESCRIPTOR_ENV];
  return ordinaryExecutionEnvironment(next);
}

export { createViewerPorts } from '../../../herdr/src/viewers/ports.js';

export function isPiProcessRow(platform: NodeJS.Platform, row: { title: string; executable: string; args: string }): boolean {
  const title = row.title.split(/[/\\]/).pop()!;
  const executable = (platform === 'linux' ? row.executable || row.args.trim().split(/\s+/, 1)[0] : row.executable).split(/[/\\]/).pop()!;
  const pi = /^(?:pi|pi-coding-agent)(?:\.exe)?$/.test(title);
  const nodeEntry = /^(?:node|nodejs)(?:\.exe)?$/.test(executable) && /^\S+\s+\S*[/\\]pi-coding-agent[/\\]dist[/\\](?:bundle[/\\])?cli\.m?js(?:\s|$)/.test(row.args);
  return pi || nodeEntry;
}

export function createProcessInventory(root: string, readOnly = false): ProcessInventoryPorts {
  const storedPresence = createProcessPresence(root);
  const presence = readOnly ? { ...storedPresence, remove: async () => {} } : storedPresence;
  const leases = createSessionLeases(root), domain = fixtureProcessDomain(root);
  const probe: ProcessInventoryPorts['probe'] = async pid => {
    try { process.kill(pid, 0); } catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH' ? { kind: 'absent' } : { kind: 'unknown' }; }
    const startIdentity = processStartTime(pid);
    return startIdentity ? { kind: 'live', startIdentity } : { kind: 'unknown' };
  };
  return { presence, leases, probe, async processes() {
    if (domain) return domain.processes();
    // Same-user inventory remains read-only. An unreadable process is blocking, not absent.
    // Keep the mutable process title and the untruncated executable name on macOS.
    const rows = execFileSync('ps', ['-U', String(process.getuid?.() ?? 0), '-o', process.platform === 'darwin' ? 'pid=,comm=,ucomm=,args=' : 'pid=,comm=,comm=,args='], { encoding: 'utf8' }).split('\n');
    return rows.flatMap(line => {
      const match = /^\s*(\d+)\s+(\S+)\s+(\S+)(?:\s+(.*))?$/.exec(line); if (!match) return [];
      const pid = Number(match[1]);
      let executable = match[3];
      if (process.platform === 'linux') {
        try { executable = readlinkSync(`/proc/${pid}/exe`); } catch { executable = ''; }
      }
      if (!isPiProcessRow(process.platform, { title: match[2], executable, args: match[4] ?? '' })) return [];
      return [{ pid, startIdentity: processStartTime(pid), classification: 'pi' as const }];
    });
  } };
}

export interface ParticipantLockOptions {
  identity?: ProcessIdentity;
  probe?: (pid: number) => Promise<ProcessProbe>;
  bootId?: () => Promise<string>;
}

/** Hold both local ownership records until the caller releases them. */
export async function lockParticipant(root: string, sessionId: string, file: string, options: ParticipantLockOptions = {}): Promise<() => Promise<void>> {
  const inventory = createProcessInventory(root);
  const identity = options.identity ?? { pid: process.pid, startIdentity: processStartTime(process.pid) ?? '' };
  const probe = options.probe ?? inventory.probe;
  const id = await claimIdLock(root, sessionId, identity, probe, options.bootId ? { bootId: options.bootId } : {});
  const isSelf = (value: { pid: number; startIdentity: string | null }) => value.pid === identity.pid && value.startIdentity === identity.startIdentity;
  const others: ProcessInventoryPorts = {
    ...inventory, probe,
    processes: async () => (await inventory.processes()).filter(value => !isSelf(value)),
    presence: { ...inventory.presence, list: async () => (await inventory.presence.list()).filter(value => !isSelf(value)) },
    leases: { ...inventory.leases, get: async path => { const lease = await inventory.leases.get(path); return lease && isSelf(lease) ? null : lease; } },
  };
  try {
    const existing = await inventory.leases.get(file);
    const lease = existing && isSelf(existing) ? existing : await inventory.leases.claim(file, identity, others, { mode: 'switch', sessionId: sessionId as SessionId });
    return async () => {
      try { await inventory.leases.release(file, lease.token, { mode: 'switch' }); }
      finally { await id.release(); }
    };
  } catch (error) {
    await id.release();
    throw error;
  }
}

export function explicitExtensionArguments(argv: readonly string[]): readonly string[] {
  const args: string[] = [];
  for (let i = 0; i < argv.length; i++) if (argv[i] === '--extension' || argv[i] === '-e') { if (!argv[i + 1]) throw new HerdrError('launch-environment-invalid', 'Missing explicit extension path'); args.push('--extension', resolve(argv[++i])); }
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
    const journal = await readJournal(journalRoot);
    await validateFiles([file], journal, false);
    await prepareBackups(journalRoot, [file], journal);
    await applyFiles([file], journal); await saveJournal(journalRoot, journal);
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

export function createProductionHerdrCliPorts(packageRoot: string, env: Readonly<NodeJS.ProcessEnv> = process.env): HerdrCliPorts & { spacePorts(request: SetupRequest): SpaceSetupPorts; dispose(): Promise<void> } {
  const globalRoot = env.SPIDER_GLOBAL_ROOT ?? paths.globalRoot;
  const warnedConfig = new Set<string>();
  const clients = new Map<string, ReturnType<typeof createHcClient>>();
  const client = (request: SetupRequest<HerdrConfig>) => {
    const key = request.config.core.binary;
    let hc = clients.get(key); if (!hc) { hc = createHcClient({ binary: key, env }); clients.set(key, hc); } return hc;
  };
  const appEnv = (request: SetupRequest) => ({ ...env, HERDR_APP_HOME: request.config.app.home });
  const filesFor = async (files: readonly { path: string; bytes: Buffer; terminalKeys?: Readonly<Record<string, string>> }[], context: SetupContext): Promise<InstallFile[]> => Promise.all(files.map(async file => ({ ...file, expected: file.terminalKeys ? (await snapshot(file.path)).hash : context.installed[file.path] ?? null, collision: file.terminalKeys ? 'key' as const : 'clone' as const })));
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
  const stagedLook = async (request: SetupRequest, context: SetupContext): Promise<InstallFile[]> => {
    const assets = join(packageRoot, 'packages/herdr/assets');
    const patches = JSON.parse(await readFile(join(assets, 'look/patches.json'), 'utf8')) as LookPatchSet;
    let appVersion: string;
    try {
      const output = execFileSync(request.config.app.binary, ['--version'], { env: appEnv(request), encoding: 'utf8', timeout: 5000, maxBuffer: 4096 });
      const match = /^herdr-app\s+(\S+)\s*$/.exec(output);
      if (!match) throw new Error('Unrecognized version output');
      appVersion = match[1];
    } catch { throw new HerdrError('upstream-version-unavailable', 'Cannot determine the installed Herdr app version'); }
    const clones = {} as HerdrClones;
    for (const kind of ['agents', 'spaces', 'pane', 'tabs', 'workspace-chrome'] as const) clones[kind] = { name: kind === 'workspace-chrome' ? 'spider-chrome' : `spider-${kind}`, clonedFrom: { name: kind, version: appVersion }, files: Object.fromEntries((await assetFiles(join(request.config.app.home, 'mods', kind))).map(file => [file.relative, file.bytes.toString()])) };
    const patched = await applyLookPatches(clones, patches, { requireCompleteSources: true });
    const fonts = await prepareFonts(request.config.fonts ?? {}, { bundledRoot: join(assets, 'fonts'), readFile });
    const files: { path: string; bytes: Buffer }[] = [];
    for (const kind of ['agents', 'spaces', 'pane', 'tabs', 'workspace-chrome'] as const) for (const [name, source] of Object.entries(patched[kind].files)) files.push({ path: join(request.config.app.home, 'mods', patched[kind].name, name), bytes: Buffer.from(name === 'mod.json' ? JSON.stringify({ ...JSON.parse(source), clonedFrom: patched[kind].clonedFrom, patchState: patched[kind].patchState }) : source) });
    for (const file of await assetFiles(join(assets, 'agents'))) files.push({ path: join(request.config.app.home, 'mods/spider-agents', file.relative === 'children.js' ? 'spider-children.js' : file.relative), bytes: file.bytes });
    for (const file of await assetFiles(join(assets, 'tabs'))) files.push({ path: join(request.config.app.home, 'mods/spider-tabs', file.relative), bytes: file.bytes });
    const props = Object.fromEntries(context.modProps.map(copy => {
      const kind = copy.props.modId.replace(/^spider-/, '');
      return [kind, { ...copy.props, fonts: fonts.families, machines: request.config.machines,
        ...(['agents', 'spaces'].includes(kind) ? { labelFont: fonts.families.label } : {}),
        ...(kind === 'pane' ? { pathFont: fonts.families.paths } : {}),
        ...(kind === 'agents' ? { retention: { completedRows: request.config.limits.completedRows, completedHours: request.config.limits.completedHours } } : {}),
      }];
    }));
    const current = JSON.parse(await readFile(join(request.config.app.home, 'layouts/main.json'), 'utf8'));
    files.push({ path: join(request.config.app.home, 'layouts/spider-glass.json'), bytes: Buffer.from(JSON.stringify(buildGlassLayout(current, { agents: 'spider-agents', spaces: 'spider-spaces', pane: 'spider-pane', tabs: 'spider-tabs', spider: 'spider-panel', chrome: 'spider-chrome', bodyFont: fonts.families.body, autoHideTabs: request.config.look?.autoHideTabs, props: { ...props, spider: props.panel } }), null, 2)) });
    for (const font of fonts.files) files.push({ path: join(request.config.app.home, 'fonts', font.fileName), bytes: font.bytes });
    for (const copy of context.modProps) for (const name of ['feed.js', 'look.js']) files.push({ path: join(copy.directory, 'shared', name), bytes: await readFile(join(assets, 'shared', name)) });
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
  const doctorParts = async (request: SetupRequest): Promise<DoctorParts> => ({ globalRoot, targets: () => targets(request),
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
    inspect: async item => {
      const failure = (code: string, message: string, repair = 'Run setup from a plain shell with the selected configuration.') => ({ failures: [{ item, code, message, repair }] });
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
      const context: SetupContext = { labelContract: HerdrLabelContract, installed: Object.fromEntries(journal.entries.map(entry => [entry.path, entry.after])), retiredTerminals: [], priorCutover: journal.cutover, recordCutover: async () => { throw new HerdrError('doctor-read-only', 'Doctor cannot record a cutover'); }, modProps: ['agents', 'spaces', 'pane', 'tabs', 'panel', 'chrome'].map(name => ({ directory: join(request.config.app.home, 'mods', `spider-${name}`), props: { modId: `spider-${name}`, feedRoot: join(request.config.globalRoot, 'herdr'), cliPath: join(packageRoot, 'dist/herdr/cli.mjs'), nodePath: process.execPath, appBinary: request.config.app.binary, configPath: request.configPath, labelContract: HerdrLabelContract } })) };
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
        for (const file of await assetFiles(join(packageRoot, 'packages/herdr/assets/mods/spider'))) files.push({ path: join(request.config.app.home, 'mods/spider-panel', file.relative), bytes: file.bytes, expected: null });
        for (const mod of context.modProps) for (const name of ['feed.js', 'look.js']) files.push({ path: join(mod.directory, 'shared', name), bytes: await readFile(join(packageRoot, 'packages/herdr/assets/shared', name)), expected: null });
        const result = await compareFiles(files); return result.failures.length ? result : loadingUnavailable(['spider-panel']);
      }
      if (item === 'clones') { const result = await compareFiles((await stagedLook(request, context)).filter(file => /\/mods\/spider-(?:agents|spaces|pane|tabs|chrome)\//.test(file.path))); return result.failures.length ? result : loadingUnavailable(['spider-agents', 'spider-spaces', 'spider-pane', 'spider-tabs', 'spider-chrome']); }
      if (item === 'patch-version') {
        const patches = JSON.parse(await readFile(join(packageRoot, 'packages/herdr/assets/look/patches.json'), 'utf8')) as LookPatchSet;
        for (const kind of ['agents', 'spaces', 'pane', 'tabs', 'workspace-chrome'] as const) {
          const directory = join(request.config.app.home, 'mods', kind === 'workspace-chrome' ? 'spider-chrome' : `spider-${kind}`), manifest = JSON.parse(await readFile(join(directory, 'mod.json'), 'utf8'));
          if (manifest.clonedFrom?.name !== kind || manifest.clonedFrom?.version !== patches.upstreamVersion || manifest.patchState?.version !== 1) return failure('upstream-version-mismatch', `Installed ${kind} clone has an unsupported patch or upstream version`);
          const source = await readFile(join(directory, 'main.js'), 'utf8');
          for (const patch of patches.mods[kind] ?? []) if (source.split(`/* spider-look:${patch.id} */`).length !== 2 || !source.includes(`/* spider-look:${patch.id} */` + patch.replacement)) return failure('patch-marker-mismatch', `Installed ${kind} patch ${patch.id} differs`);
        }
        return { failures: [] };
      }
      if (item === 'layout-theme') {
        const path = join(request.config.app.home, 'layouts/spider-glass.json'), layout = JSON.parse(await readFile(path, 'utf8'));
        if (layout.theme !== 'spider-glass') return failure('layout-theme-mismatch', 'Installed layout does not use spider-glass');
        type LayoutContent = { mod?: string; props?: unknown; pane?: { header?: { content?: LayoutContent } } };
        const contents = (root: unknown) => {
          const found = new Map<string, unknown[]>();
          const content = (value: LayoutContent | undefined) => { if (value?.mod) found.set(value.mod, [...found.get(value.mod) ?? [], value.props]); if (value?.pane?.header?.content) content(value.pane.header.content); };
          const walk = (node: { content?: LayoutContent; children?: unknown[] }) => { content(node.content); for (const child of node.children ?? []) walk(child as typeof node); };
          walk(root as Parameters<typeof walk>[0]); return found;
        };
        const installed = contents(layout);
        for (const name of ['agents', 'spaces', 'pane', 'tabs', 'panel', 'chrome']) if (!installed.has(`spider-${name}`)) return failure('layout-mod-mismatch', `Installed layout omits spider-${name}`);
        const expectedFile = (await stagedLook(request, context)).find(file => file.path === path);
        if (!expectedFile) return failure('layout-props-mismatch', 'Cannot determine expected layout props');
        const expected = contents(JSON.parse(expectedFile.bytes.toString('utf8')));
        const { isDeepStrictEqual } = await import('node:util');
        for (const name of ['agents', 'spaces', 'pane', 'tabs', 'panel', 'chrome']) if (!isDeepStrictEqual(installed.get(`spider-${name}`), expected.get(`spider-${name}`))) return failure('layout-props-mismatch', `Installed spider-${name} props differ from the current configuration`);
        if (!(await snapshot(join(request.config.app.home, 'themes/spider-glass.json'))).bytes?.equals(await readFile(join(packageRoot, 'packages/herdr/assets/themes/spider-glass.json')))) return failure('app-theme-mismatch', 'Installed Herdr theme differs');
        const settings = JSON.parse((await snapshot(join(request.config.app.home, 'settings.json'))).bytes?.toString() ?? '{}');
        if (settings.theme !== undefined && settings.theme !== 'spider-glass' || settings.layout !== undefined && settings.layout !== 'spider-glass') return failure('app-selection-mismatch', 'App selection differs from spider-glass');
        if (settings.theme === undefined || settings.layout === undefined) return { failures: [], warnings: [{ item, code: 'inspection-unavailable', message: 'Installed layout and theme are valid; active app selection is not exposed in settings', repair: 'Check the app layout and theme selection, then rerun doctor.' }] };
        return { failures: [] };
      }
      if (item === 'keys') {
        const keys = JSON.parse(await readFile(join(request.config.app.home, 'keys.json'), 'utf8')), desired = JSON.parse(await readFile(join(packageRoot, 'packages/herdr/assets/keys.json'), 'utf8')).terminal;
        for (const [key, value] of Object.entries(desired)) if (keys.terminal?.[key] !== value) return failure('key-binding-conflict', `Managed terminal key differs: ${key}`);
        const url = new URL('./core/keybindings.js', import.meta.resolve('@earendil-works/pi-coding-agent')).href;
        const { KeybindingsManager } = await import(url) as { KeybindingsManager: { create(directory: string): { getResolvedBindings(): Record<string, string | string[] | undefined> } } };
        const normalize = (key: string) => { const parts = key.toLowerCase().split('+'); const base = parts.pop()!; return [...['ctrl', 'shift', 'alt', 'super'].filter(mod => parts.includes(mod)), base].join('+'); };
        const resolved = KeybindingsManager.create(request.config.agentDirectory).getResolvedBindings();
        const bindings = Object.fromEntries(Object.entries(resolved).filter((entry): entry is [string, string | string[]] => entry[1] !== undefined).map(([action, keys]) => [action, typeof keys === 'string' ? normalize(keys) : keys.map(normalize)]));
        const collisions = inspectHerdrShortcutCollisions(bindings);
        return { failures: collisions.filter(c => c.scope === 'editor').map(c => ({ item, code: 'pi-shortcut-collision', message: `${c.key} also binds ${c.action}`, repair: 'Choose another pi keybinding and reload the owner.' })), warnings: collisions.filter(c => c.scope === 'tree').map(c => ({ item, code: 'tree-view-key-collision', message: `${c.key} also binds ${c.action} in tree view`, repair: 'Leave tree view before using the spider shortcut, or change that pi binding.' })) };
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
        for (const machine of request.config.machines) {
          const path = runtimeInstallPath(machine.runtime.directory, bytes), recorded = journal.runtimes.find(runtime => runtime.machine === machine.name && runtime.path === path);
          if (recorded?.after !== hash || !(await client(request).fileRead(machine.name, path)).equals(bytes)) return failure('runtime-digest-mismatch', `Installed runtime on ${machine.name} does not match this package`);
        }
        return { failures: [] };
      }
      if (item === 'jobs') {
        const root = join(request.config.globalRoot, 'herdr/jobs'), information: DoctorInformation[] = [];
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
          const feed = parseFeed(await readFile(path, 'utf8'));
          if (!feed || feed.generation !== mapping.owner.generation || feed.owner.terminal.address !== mapping.owner.terminal.address || !await sessionFeedIsFresh(join(request.config.globalRoot, 'herdr'), feed, Date.now())) {
            failures.push(...failure('feed-stale', 'Owner feed is stale or has a different generation').failures); continue;
          }
          if (item === 'feed-freshness') continue;
          if (item === 'feed-permissions') {
            for (const file of [path, dirname(path)]) if ((await stat(file)).mode & 0o077) failures.push(...failure('feed-permissions', 'Owner feed permissions allow other users').failures);
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
      let runtimes: readonly RuntimeFile[] = [];
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
        validateSelections: async () => { await discoverSessions(request.config, getSpaces()); },
        preflight: async () => {
          const spaces = getSpaces(), hc = client(request);
          rootProbes.clear();
          // This exported G check is before any backup or asset/config staging.
          await preflightSpaces(request.config, spaces, { adoptExistingSpaces: request.adoptExistingSpaces });
          const identity = await hc.identity(), snapshot = await spaces.layoutSnapshot(), recovery = await readCutoverRecovery(spaces.journalRoot, snapshot, request.config, spaces), saved = await readJournal(request.journalRoot);
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
          return { recoveredCutover, cutoverProvedAbsent, cutoverNeedsRecheck: recovery.layoutAdoptionNeeded, cutoverActions: await planSpaceCutover(request.config, spaces, { snapshot, recovery }), fingerprint: digest(await readFile(join(packageRoot, 'packages/herdr/assets/look/patches.json'))), coreIdentity: identity, mods: ['agents', 'spaces', 'pane', 'tabs', 'panel', 'chrome'].map(name => ({ directory: join(request.config.app.home, 'mods', `spider-${name}`) })), targets: await targets(request), retiredTerminals: saved.cutoverPending ? saved.retiredTerminals : (await spaces.registry.list()).filter(mapping => mapping.owner.terminal.coreId === identity.coreId && mapping.owner.terminal.socket === identity.socket && !recovery.createdTabs.some(tab => tab.terminal === mapping.owner.terminal.address)).map(mapping => mapping.owner.terminal.address), layoutExport: true };
        },
        stageLook: (request, context) => stagedLook(request, context),
        installFiles: async (request, context) => {
          const assets = join(packageRoot, 'packages/herdr/assets'), files: { path: string; bytes: Buffer; terminalKeys?: Readonly<Record<string, string>> }[] = [];
          for (const file of await assetFiles(join(assets, 'mods/spider'))) files.push({ path: join(request.config.app.home, 'mods/spider-panel', file.relative), bytes: file.bytes });
          files.push({ path: join(request.config.agentDirectory, 'themes/dracula-plus-glass.json'), bytes: await readFile(join(assets, 'themes/dracula-plus-glass.json')) }, { path: join(request.config.app.home, 'themes/spider-glass.json'), bytes: await readFile(join(assets, 'themes/spider-glass.json')) });
          const keys = JSON.parse(await readFile(join(assets, 'keys.json'), 'utf8')) as { terminal: Record<string, string> };
          files.push({ path: join(request.config.app.home, 'keys.json'), bytes: Buffer.alloc(0), terminalKeys: keys.terminal });
          const settingsPath = join(request.config.app.home, 'settings.json'), settings = await snapshot(settingsPath);
          // A fresh app home has no settings.json: expected null records it as absent; snapshot-only bytes are never written or parsed.
          return [...await filesFor(files, context), { path: settingsPath, expected: settings.hash, bytes: settings.bytes ?? Buffer.alloc(0), snapshotOnly: true, managed: { kind: 'json' as const, fields: ['theme', 'layout'] } }];
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
        ensureRuntime: async request => { const bytes = await readFile(join(packageRoot, 'dist/herdr/remote-runtime.mjs')); runtimes = request.config.machines.map(machine => ({ machine: machine.name, path: runtimeInstallPath(machine.runtime.directory, bytes), bytes, sha256: sha256(bytes) })); return runtimes; },
        runtimeRootsHealthy: async (request, runtimes) => {
          for (const runtime of runtimes) {
            const machine = request.config.machines.find(machine => machine.name === runtime.machine);
            if (!machine) return false;
            const target = { machine: runtime.machine, nodePath: machine.nodePath ?? 'node', coreStartedAt: '' };
            const launch = { ...probeLaunch(target), argv: [target.nodePath, runtime.path, '--probe', machine.runtime.directory] };
            try {
              const value: unknown = JSON.parse(await probeRoot(launch));
              if (!isRuntimeRootProbe(value, machine.runtime.directory)) return false;
            } catch { return false; }
          }
          return true;
        },
        runtimeRootProbes: request => runtimes.flatMap((runtime): RuntimeRootObservation[] => {
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
        bootstrapRuntime: async (request: SetupRequest, _context: SetupContext) => {
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
        verify: async request => doctorHerdr(request, { ...await doctorParts(request), probeRuntimeRoot: async (_target, launch) => rootProbes.get(rootKey(launch)) ?? probe(request, launch), cachedNodeObservations: async () => (await readJournal(request.journalRoot)).probes }),
        rollback: async result => {
          const spaces = getSpaces();
          const recovery = await readCutoverRecovery(spaces.journalRoot, await spaces.layoutSnapshot());
          if (result.terminals.length !== recovery.createdTabs.length || result.terminals.some(address => !recovery.createdTabs.some(tab => tab.terminal === address)) || recovery.entries.some(entry => entry.result && result.identities[entry.target.sessionId] !== entry.result.startIdentity)) throw new HerdrError('cutover-owner-conflict', 'Rollback does not match G-created tab identities');
          const snapshot = await spaces.layoutSnapshot();
          const close: typeof recovery.createdTabs = [];
          for (const entry of recovery.entries) {
            const live = await assessSessionLiveness(entry.target.file, selectedProcessInventory(request.config, spaces.processInventory)), process = entry.result ? await spaces.processInventory.probe(entry.result.pid) : null;
            if (live.kind !== 'free' || process?.kind === 'unknown' || process?.kind === 'live' && process.startIdentity === entry.result!.startIdentity) throw new HerdrError('cutover-owner-live', 'Close the created session owner before rolling back its tab');
            // A session can switch files while remaining in the same terminal.
            for (const record of (await spaces.processInventory.presence.list()).filter(p => p.kind === 'top-level' && p.hcAddress === entry.placement.terminal)) {
              const current = await spaces.processInventory.probe(record.pid);
              if (current.kind === 'unknown' || current.kind === 'live' && current.startIdentity === record.startIdentity) throw new HerdrError('cutover-owner-live', `Close the pi in the recorded terminal (PID ${record.pid}) before rollback`);
            }
            if (entry.manuallyMoved) {
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
            if (foreign.length) throw new HerdrError('cutover-owner-conflict', rollbackForeignPanesNotice(space!.name, tab.name, foreign));
            if (tab.name !== (entry.tabName ?? entry.target.name ?? entry.target.sessionId) && tab.name !== entry.label || !tabTerminals(tab).some(row => row.terminal === entry.placement.terminal)) throw new HerdrError('cutover-owner-conflict', 'A created tab no longer has its recorded identity');
            if (!close.some(p => p.space === entry.placement.space && p.tab === entry.placement.tab)) close.push(entry.placement);
          }
          for (const tab of close) { const reply = await spaces.app.command('tab.close', { id: tab.tab, confirmed: true }); if (reply.error) throw new HerdrError(reply.error.code, reply.error.message); }
          await forgetCutoverTabs(spaces.journalRoot, recovery.createdTabs, await spaces.layoutSnapshot());
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
      const offer = await offerResume(identity, { registry: createTerminalRegistry(root), processInventory: createProcessInventory(root), coreStartedAt: () => coreStartedAt(request.config.core.binary, env) });
      return offer ? resumeOfferShell(offer, { nodePath: process.execPath, cliPath: join(packageRoot, 'dist/herdr/cli.mjs'), configPath: request.configPath, hookPath: join(root, 'resume.sh') }) : '';
    },
    resume: async (request, selection) => {
      const root = join(request.config.globalRoot, 'herdr'), rawInventory = createProcessInventory(root);
      const inventory = selection.cutover ? selectedProcessInventory({ ...request.config, spaces: [{ name: selection.sessionId, sessions: [{ file: selection.file }] }] }, rawInventory, [{ file: selection.file, sessionId: selection.sessionId as SessionId }]) : rawInventory;
      const identity = { pid: process.pid, startIdentity: processStartTime(process.pid) ?? '' }; if (!identity.startIdentity) throw new HerdrError('process-identity-unavailable', 'Cannot claim a launch lease');
      let childExit: Promise<{ code: number | null; error?: Error }> | undefined;
      await launchSession({ sessionFile: selection.file, sessionId: selection.sessionId as SessionId, cwd: selection.cwd, environment: { agentDirectory: request.config.agentDirectory, extensionArguments: [] } }, { leases: inventory.leases, processInventory: inventory, processIdentity: identity, env, leasePolicy: selection.cutover ? { mode: 'cutover' } : request.config.enabled === false ? { mode: 'bookkeeping' } : { mode: 'switch', sessionId: selection.sessionId as SessionId },
        spawnPi: async spawnRequest => {
          const child = spawn(spawnRequest.argv[0], spawnRequest.argv.slice(1), { cwd: spawnRequest.cwd, env: { ...spawnRequest.env }, stdio: 'inherit' });
          // Subscribe before any await: startup failure can precede lease transfer or owner activation.
          childExit = new Promise(resolve => { child.once('exit', code => resolve({ code })); child.once('error', error => resolve({ code: null, error })); });
          await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
          const startIdentity = processStartTime(child.pid!); if (!startIdentity) throw new HerdrError('process-identity-unavailable', 'Cannot prove launched pi identity');
          return { pid: child.pid!, startIdentity };
        },
        // pi activation owns the generation-bound terminal mapping; the lease launcher never publishes one.
      });
      if (childExit) { const result = await childExit; if (result.error || result.code !== 0) throw new HerdrError('resume-exited', 'Resumed pi exited unsuccessfully'); }
    },
    stdout: text => process.stdout.write(text), stderr: text => process.stderr.write(text),
    async dispose() { for (const hc of clients.values()) await hc.dispose(); clients.clear(); },
  };
}

// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import type { HcClient, HcRunRequest, HerdrConfig, MachineName, TerminalAddress, CoreIdentity } from '../contracts.js';
import { basename, dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { HerdrLabelContract } from '../contracts.js';
import { HerdrError } from '../client/parse.js';
import { digest, snapshot, readJournal, saveJournal, withSetupLock, validateFiles, prepareBackups, applyFiles, rejectSymlinks, mergeTheme, mergeTerminalKeys, disableRootNotes, rollbackFiles, managedProjection, assertGlobalRoot, type ManagedPart } from './backup.js';
import { probeLaunch, type DoctorReport } from './doctor.js';
import { checkRemoteNodeVersion, REMOTE_NODE_MINIMUM } from '../remote/node-version.js';
import { shellQuote } from '../sessions/resume.js';
import { chmod, lstat, mkdir } from 'node:fs/promises';
import type { RuntimeDirectoryProbe } from '../remote/runtime.js';

async function ensureSessionFeedDirectory(globalRoot: string): Promise<void> {
  await rejectSymlinks(globalRoot);
  const uid = process.getuid?.();
  const checkOwner = async (path: string) => {
    const stat = await lstat(path);
    if (!stat.isDirectory() || (uid !== undefined && stat.uid !== uid)) throw new HerdrError('feed-directory-owner-mismatch', 'Session feed directory must be owned by the current user');
    return stat;
  };
  await checkOwner(globalRoot);
  for (const directory of [join(globalRoot, 'herdr'), join(globalRoot, 'herdr/sessions')]) {
    await rejectSymlinks(directory);
    try { await mkdir(directory, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    await rejectSymlinks(directory);
    if (((await checkOwner(directory)).mode & 0o777) !== 0o700) await chmod(directory, 0o700);
  }
}
export function standardHerdrConfigPath(globalRoot: string): string {
  return join(globalRoot, 'herdr/config.json');
}
export function runtimeInstallPath(runtimeDirectory: string, runtimeBytes: Buffer): string {
  return join(dirname(runtimeDirectory), `spider-remote-runtime-${digest(runtimeBytes).slice(0, 16)}.mjs`);
}
export interface SetupRequest {
  config: HerdrConfig;
  configPath: string;
  packageRoot: string;
  journalRoot: string;
  overwriteUnownedKeys?: boolean;
  allowStagingApp?: boolean;
  adoptExistingSpaces?: readonly string[];
}
function plannedAppSettings(request: SetupRequest) {
  return { path: join(request.config.app.home, 'settings.json'), planned: { theme: 'spider-glass', layout: 'spider-glass' } };
}
export interface InstallFile {
  path: string;
  bytes: Buffer;
  expected: string | null;
  collision?: 'clone' | 'key';
  mode?: number;
  terminalKeys?: Readonly<Record<string, string>>;
  managed?: ManagedPart;
  snapshotOnly?: boolean;
}
export interface ProbeTarget {
  machine: MachineName;
  nodePath: string;
  coreStartedAt: string;
}
export interface NodeObservation extends ProbeTarget {
  version: string;
}
export interface RuntimeRootObservation {
  machine: MachineName;
  nodePath: string;
  runtimeHash: string;
  root: string;
  result: RuntimeDirectoryProbe;
}
export interface RuntimeFile {
  machine: MachineName;
  path: string;
  bytes: Buffer;
  sha256: string;
}
export interface ModCopy {
  directory: string;
  props?: Readonly<Record<string, unknown>>;
}
export interface InstalledModProps extends Readonly<Record<string, unknown>> {
  modId: string;
  feedRoot: string;
  cliPath: string;
  nodePath: string;
  appBinary: string;
  configPath: string;
  labelContract: HerdrLabelContract;
}
export interface InstalledModCopy {
  directory: string;
  props: InstalledModProps;
}
export interface SetupPreflight {
  /** Existing terminals moved into a shared tab and need a journal-only recheck. */
  cutoverNeedsRecheck?: boolean;
  fingerprint: string;
  coreIdentity: CoreIdentity;
  mods: readonly ModCopy[];
  targets: readonly ProbeTarget[];
  retiredTerminals: readonly TerminalAddress[];
  layoutExport: boolean;
  recoveredCutover?: CutoverResult;
  cutoverProvedAbsent?: boolean;
  stagingProof?: {
    appHome: string;
    coreSocket: string;
    coreId: string;
  };
}
export interface SetupContext {
  labelContract: HerdrLabelContract;
  modProps: readonly InstalledModCopy[];
  installed: Readonly<Record<string, string>>;
  retiredTerminals: readonly TerminalAddress[];
  priorCutover: CutoverResult | null;
  recordCutover(result: CutoverResult): Promise<void>;
}
export interface CutoverResult {
  terminals: readonly TerminalAddress[];
  identities: Readonly<Record<string, string>>;
}
export interface SetupParts {
  globalRoot?: string;
  /** Read-only selection validation; rollback does not need to rediscover configured sessions. */
  validateSelections?(request: SetupRequest): Promise<void>;
  preflight(request: SetupRequest): Promise<SetupPreflight>;
  stageLook(request: SetupRequest, context: SetupContext, mode: 'export' | 'isolated-clone'): Promise<readonly InstallFile[]>;
  installFiles(request: SetupRequest, context: SetupContext): Promise<readonly InstallFile[]>;
  generateTemplates(request: SetupRequest, context: SetupContext): Promise<readonly InstallFile[]>;
  installResume(request: SetupRequest, context: SetupContext): Promise<readonly InstallFile[]>;
  probeMachineNode(target: ProbeTarget, launch: HcRunRequest): Promise<string>;
  ensureRuntime(request: SetupRequest, context: SetupContext): Promise<readonly RuntimeFile[]>;
  bootstrapRuntime(request: SetupRequest, context: SetupContext): Promise<void>;
  runtimeRootsHealthy?(request: SetupRequest, runtimes: readonly RuntimeFile[]): Promise<boolean>;
  runtimeRootProbes?(request: SetupRequest): readonly RuntimeRootObservation[];
  hc: Pick<HcClient, 'fileRead' | 'fileWrite'>;
  cutover(request: SetupRequest, context: SetupContext): Promise<CutoverResult>;
  /** Recheck existing owners without repeating initial app selection. */
  reconcileCutover?(request: SetupRequest, context: SetupContext): Promise<CutoverResult>;
  verify(request: SetupRequest): Promise<DoctorReport>;
  rollback(result: CutoverResult): Promise<void>;
  warn(message: string): void;
}
export interface SetupResult {
  writes: readonly string[];
  probes: readonly NodeObservation[];
  cutover: CutoverResult | null;
  doctor: DoctorReport;
}
export function assertPlainShell(): void {
  if (process.title === 'pi' || process.env.PI_SUBAGENT_CHILD === '1' || process.env.PI_SPIDER_SESSION_ID || process.env.PI_SESSION_ID)
    throw new HerdrError('setup-requires-plain-shell', 'Close selected sessions and run setup from a plain shell');
}
function fenceRequest(request: SetupRequest): void {
  const checkout = process.env.SPIDER_TEST_FIXTURE_CHECKOUT;
  if (!checkout)
    return;
  const root = resolve(checkout, '.spider/scratch');
  for (const path of [request.config.app.home, request.config.core.config, request.config.agentDirectory, request.config.globalRoot, request.config.shellRc, request.configPath, request.packageRoot, request.journalRoot]) {
    const suffix = relative(root, path);
    if (!suffix || suffix === '..' || suffix.startsWith('../') || isAbsolute(suffix))
      throw new HerdrError('setup-fixture-outside-root', 'Setup tests must use fenced fixture paths');
  }
}
async function installedModProps(request: SetupRequest, copies: readonly ModCopy[]): Promise<InstalledModCopy[]> {
  const seen = new Set<string>();
  const result: InstalledModCopy[] = [];
  for (const copy of copies) {
    const directory = resolve(copy.directory), modId = basename(directory);
    if (seen.has(modId))
      throw new HerdrError('duplicate-mod-id', `Duplicate installed mod name: ${modId}`);
    seen.add(modId);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(modId) || directory !== join(resolve(request.config.app.home), 'mods', modId) || copy.props?.modId !== undefined && copy.props.modId !== modId)
      throw new HerdrError('invalid-mod-id', 'Every installed modId must equal its direct mod-directory name');
    await rejectSymlinks(directory);
    result.push({ directory, props: { ...copy.props, modId, feedRoot: join(request.config.globalRoot, 'herdr'),
        cliPath: join(request.packageRoot, 'dist/herdr/cli.mjs'), nodePath: process.execPath, appBinary: request.config.app.binary, configPath: request.configPath, labelContract: HerdrLabelContract } });
  }
  return result;
}
async function readRuntime(parts: SetupParts, runtime: RuntimeFile): Promise<Buffer | null> {
  try {
    return await parts.hc.fileRead(runtime.machine, runtime.path);
  }
  catch (e) {
    const error = e as {
      code?: string;
      message?: string;
    };
    if (error.code === 'not_found' || error.code === 'file-not-found' || error.code === 'invalid_params' && error.message?.includes('ENOENT'))
      return null;
    throw e;
  }
}
export async function setupHerdr(request: SetupRequest, parts: SetupParts): Promise<SetupResult> {
  assertPlainShell();
  fenceRequest(request);
  await assertGlobalRoot(request.config.globalRoot, parts.globalRoot);
  await parts.validateSelections?.(request);
  return withSetupLock(request.journalRoot, async () => {
    const journal = await readJournal(request.journalRoot);
    const recordRuntimeRootProbes = (): boolean => {
      const observations = parts.runtimeRootProbes?.(request);
      if (!observations || JSON.stringify(observations) === JSON.stringify(journal.runtimeRootProbes)) return false;
      journal.runtimeRootProbes = [...observations];
      return true;
    };
    const reconcilingCutover = journal.cutoverPending;
    const needsAppSelection = !journal.verified;
    const preflight = await parts.preflight(request);
    const modProps = await installedModProps(request, preflight.mods);
    if (journal.cutoverPending) {
      if (!preflight.recoveredCutover && !preflight.cutoverProvedAbsent)
        throw new HerdrError('cutover-reconciliation-required', 'Inspect the leased launcher journal and live owner identities before retrying; setup will not reopen an uncertain session');
      journal.cutover = preflight.recoveredCutover ?? null;
      journal.cutoverPending = false;
      // Do not persist reconciliation until the owned-file validation below has passed.
    }
    const fingerprint = digest(Buffer.from(JSON.stringify({ assets: preflight.fingerprint, config: request.config, targets: preflight.targets, modProps })));
    const retiredTerminals = !journal.verified && journal.fingerprint === fingerprint ? journal.retiredTerminals : [...preflight.retiredTerminals];
    const cutoverFingerprint = digest(Buffer.from(JSON.stringify({ layout: request.config.layout ?? 'panes', spaces: request.config.spaces, core: preflight.coreIdentity, appHome: request.config.app.home, agentDirectory: request.config.agentDirectory, globalRoot: request.config.globalRoot, configPath: request.configPath, cliPath: join(request.packageRoot, 'dist/herdr/cli.mjs'), nodePath: process.execPath })));
    const cutoverNeeded = preflight.cutoverNeedsRecheck || reconcilingCutover || !journal.verified || journal.cutover === null || (journal.cutoverFingerprint === undefined ? !journal.verified || journal.fingerprint !== fingerprint : journal.cutoverFingerprint !== cutoverFingerprint);
    const context: SetupContext = { labelContract: HerdrLabelContract, modProps,
      installed: Object.fromEntries(journal.entries.map(e => [e.path, e.after])), retiredTerminals, priorCutover: journal.cutover,
      recordCutover: async (result) => {
        if (result.terminals.some(t => retiredTerminals.includes(t)))
          throw new HerdrError('retired-terminal-reused', 'Fresh owners must not reuse retired terminal IDs');
        journal.cutover = result;
        journal.cutoverFingerprint = cutoverFingerprint;
        journal.launcherNodePath = process.execPath;
        journal.cutoverPending = false;
        await saveJournal(request.journalRoot, journal);
      } };
    const settingsPath = join(request.config.agentDirectory, 'settings.json');
    const settings = await snapshot(settingsPath);
    const notes = await snapshot(request.config.core.config);
    const settingsFile: InstallFile = { path: settingsPath, expected: settings.hash, bytes: mergeTheme(settings.bytes), managed: { kind: 'json', fields: ['theme'] } };
    const notesFile: InstallFile = { path: request.config.core.config, expected: notes.hash, bytes: disableRootNotes(notes.bytes), managed: { kind: 'notes' } };
    if (!preflight.layoutExport) {
      parts.warn('A second app window will open for isolated staging; it can change focus.');
      const proof = preflight.stagingProof;
      if (!request.allowStagingApp || !proof)
        throw new HerdrError('staging-app-not-authorized', 'Use read-only layout export, or explicitly authorize a proved isolated staging window');
      const home = resolve(proof.appHome), targetHome = resolve(request.config.app.home);
      if (!isAbsolute(proof.appHome) || !isAbsolute(proof.coreSocket) || home === targetHome || home.startsWith(targetHome + '/') || targetHome.startsWith(home + '/') || !proof.coreId || proof.coreId === preflight.coreIdentity.coreId || proof.coreSocket === preflight.coreIdentity.socket || proof.coreSocket.includes('/default/default.sock'))
        throw new HerdrError('staging-isolation-unproved', 'Staging must have a separate app home and a proved distinct core and socket');
      await rejectSymlinks(proof.appHome);
      await rejectSymlinks(proof.coreSocket);
    }
    const globalConfigPath = join(request.config.globalRoot, 'config.json');
    const globalConfig = await snapshot(globalConfigPath);
    const recordConfigPath = resolve(request.configPath) !== resolve(standardHerdrConfigPath(request.config.globalRoot));
    const globalJson = JSON.parse(globalConfig.bytes?.toString('utf8') ?? '{}') as Record<string, unknown>;
    const previouslyManagedConfig = journal.entries.find(entry => entry.path === globalConfigPath)?.managed;
    if (recordConfigPath) globalJson['herdr.config'] = resolve(request.configPath);
    else if (previouslyManagedConfig) delete globalJson['herdr.config'];
    const globalConfigFiles: InstallFile[] = recordConfigPath || previouslyManagedConfig ? [{ path: globalConfigPath, expected: globalConfig.hash, bytes: Buffer.from(JSON.stringify(globalJson, null, 2) + '\n'), managed: { kind: 'json', fields: ['herdr.config'] } }] : [];
    const plans = [
      ...globalConfigFiles,
      ...await parts.stageLook(request, context, preflight.layoutExport ? 'export' : 'isolated-clone'),
      ...await parts.installFiles(request, context), settingsFile,
      ...await parts.generateTemplates(request, context), notesFile,
      ...await parts.installResume(request, context),
    ];
    const files: InstallFile[] = [];
    for (const plan of plans) {
      if (!plan.terminalKeys) {
        files.push(plan);
        continue;
      }
      const current = await snapshot(plan.path);
      if (current.hash !== plan.expected)
        throw new HerdrError('concurrent-settings-edit', `Changed keys after preflight: ${plan.path}`);
      const prior = journal.entries.find(e => e.path === plan.path);
      const owned = prior?.terminalKeys ?? {};
      const managed: ManagedPart = { kind: 'json', section: 'terminal', fields: Object.keys(plan.terminalKeys) };
      if (prior?.managedAfter !== undefined && managedProjection(current.bytes, prior.managed ?? managed) !== prior.managedAfter && journal.verified)
        throw new HerdrError('managed-artifact-changed', `Managed terminal keys changed in ${plan.path}. Restore the recorded managed values ${prior.managedAfter}, then rerun setup.`);
      files.push({ ...plan, managed, bytes: mergeTerminalKeys(current.bytes, plan.terminalKeys, owned, request.overwriteUnownedKeys === true) });
    }
    for (const file of files) {
      if (!file.managed || file.snapshotOnly) continue;
      const current = await snapshot(file.path);
      if (current.bytes && managedProjection(current.bytes, file.managed) === managedProjection(file.bytes, file.managed)) file.bytes = current.bytes;
    }
    if (process.env.SPIDER_TEST_FIXTURE_CHECKOUT)
      for (const file of files) {
        const root = resolve(process.env.SPIDER_TEST_FIXTURE_CHECKOUT, '.spider/scratch') + '/';
        if (!resolve(file.path).startsWith(root))
          throw new HerdrError('setup-fixture-outside-root', 'Install target is not fenced');
      }
    const modsRoot = join(resolve(request.config.app.home), 'mods') + '/';
    for (const file of files)
      if (resolve(file.path).startsWith(modsRoot)) {
        const modId = relative(modsRoot, resolve(file.path)).split('/')[0];
        if (!modProps.some(copy => copy.props.modId === modId))
          throw new HerdrError('missing-mod-id', `No validated mod props for installed copy: ${modId}`);
      }
    await validateFiles(files, journal, request.overwriteUnownedKeys, plannedAppSettings(request));
    const runtimes = await parts.ensureRuntime(request, context);
    const priorRuntimes = [...journal.runtimes];
    const runtimePlans: {
      runtime: RuntimeFile;
      before: string | null;
    }[] = [];
    for (const runtime of runtimes) {
      if (!isAbsolute(runtime.path) || digest(runtime.bytes) !== runtime.sha256)
        throw new HerdrError('runtime-digest-mismatch', 'Runtime source digest or absolute path differs');
      const target = preflight.targets.find(t => t.machine === runtime.machine);
      const cached = target && journal.probes.find(p => p.machine === target.machine && p.nodePath === target.nodePath && p.coreStartedAt === target.coreStartedAt && checkRemoteNodeVersion(p.version));
      const verifiedRuntime = journal.verified && cached && priorRuntimes.some(r => r.machine === runtime.machine && r.path === runtime.path && r.after === runtime.sha256);
      const bytes = verifiedRuntime ? runtime.bytes : await readRuntime(parts, runtime);
      const before = bytes === null ? null : digest(bytes);
      if (before !== null && before !== runtime.sha256)
        throw new HerdrError('runtime-digest-mismatch', `Existing versioned runtime differs on ${runtime.machine}; inspect it instead of overwriting it`);
      runtimePlans.push({ runtime, before });
      journal.runtimes = [...journal.runtimes.filter(r => r.machine !== runtime.machine || r.path !== runtime.path), { machine: runtime.machine, path: runtime.path, before, after: runtime.sha256 }];
    }
    const probes: NodeObservation[] = [];
    for (const target of preflight.targets) {
      const cached = journal.probes.find(p => p.machine === target.machine && p.nodePath === target.nodePath && p.coreStartedAt === target.coreStartedAt);
      const runtimeUnchanged = runtimes.filter(r => r.machine === target.machine).every(r => priorRuntimes.some(prior => prior.machine === r.machine && prior.path === r.path && prior.after === r.sha256));
      if (cached && checkRemoteNodeVersion(cached.version) && runtimeUnchanged)
        continue;
      let version: string;
      try {
        version = await parts.probeMachineNode(target, probeLaunch(target));
      }
      catch (e) {
        throw new HerdrError('remote-node-unavailable', `Machine ${target.machine} needs Node >=${REMOTE_NODE_MINIMUM}; configure nodePath or repair destination PATH: ${e instanceof Error ? e.message : String(e)}`);
      }
      if (!checkRemoteNodeVersion(version))
        throw new HerdrError('remote-node-unavailable', `Machine ${target.machine} needs Node >=${REMOTE_NODE_MINIMUM}; configure nodePath or repair destination PATH`);
      const observation = { ...target, version: version.trim() };
      probes.push(observation);
      journal.probes = [...journal.probes.filter(p => p.machine !== target.machine), observation];
    }
    const bootstrapNeeded = !journal.verified || probes.length > 0 || runtimes.some(runtime => !priorRuntimes.some(prior => prior.machine === runtime.machine && prior.path === runtime.path && prior.after === runtime.sha256)) || (parts.runtimeRootsHealthy ? !await parts.runtimeRootsHealthy(request, runtimes) : false);
    const bootstrap = async () => {
      try {
        if (bootstrapNeeded) await parts.bootstrapRuntime(request, context);
      } catch (error) {
        throw new HerdrError('runtime-bootstrap-failed', `Destination runtime bootstrap failed; repair its directory permissions or Node configuration and rerun setup: ${error instanceof Error ? error.message : String(error)}`);
      }
    };
    const unchanged = journal.verified && !cutoverNeeded && fingerprint === journal.fingerprint && probes.length === 0 && runtimePlans.every(p => p.before === p.runtime.sha256) && (await Promise.all(files.map(async file => file.snapshotOnly || (await snapshot(file.path)).hash === digest(file.bytes)))).every(Boolean);
    await ensureSessionFeedDirectory(request.config.globalRoot);
    if (unchanged) {
      await bootstrap(); // Repair root loss without repeating cutover or unrelated setup writes.
      const doctor = await parts.verify(request);
      if (doctor.failures.length) throw new HerdrError('setup-verification-failed', 'Installed setup failed verification', { failures: doctor.failures });
      if (recordRuntimeRootProbes()) await saveJournal(request.journalRoot, journal);
      return { writes: [], probes: [], cutover: journal.cutover, doctor };
    }
    journal.fingerprint = fingerprint;
    journal.verified = false;
    journal.retiredTerminals = retiredTerminals;
    await prepareBackups(request.journalRoot, files, journal);
    const writes = await applyFiles(files, journal);
    for (const { runtime, before } of runtimePlans) {
      const installed = await readRuntime(parts, runtime);
      const current = installed === null ? null : digest(installed);
      if (current === runtime.sha256)
        continue;
      if (current !== before)
        throw new HerdrError('runtime-digest-mismatch', `Runtime changed after preflight on ${runtime.machine}`);
      await parts.hc.fileWrite(runtime.machine, runtime.path, runtime.bytes);
      if (digest(await parts.hc.fileRead(runtime.machine, runtime.path)) !== runtime.sha256)
        throw new HerdrError('runtime-digest-mismatch', `Runtime verification failed on ${runtime.machine}`);
    }
    await bootstrap();
    let cutover = journal.cutover;
    try {
      if (cutoverNeeded) {
        journal.cutoverPending = true;
        await saveJournal(request.journalRoot, journal);
        try { cutover = await (context.priorCutover && !needsAppSelection && parts.reconcileCutover ? parts.reconcileCutover(request, context) : parts.cutover(request, context)); }
        finally {
          for (const file of files.filter(file => file.snapshotOnly)) {
            const current = await snapshot(file.path);
            const entry = journal.entries.find(entry => entry.path === file.path)!;
            entry.after = current.hash ?? digest(Buffer.alloc(0));
            if (file.managed) entry.managedAfter = managedProjection(current.bytes, file.managed);
          }
          await saveJournal(request.journalRoot, journal);
        }
      }
      if (!cutover) throw new HerdrError('cutover-reconciliation-required', 'No completed cutover was recorded');
      journal.cutoverFingerprint = cutoverFingerprint;
      journal.launcherNodePath = process.execPath;
      if (cutover.terminals.some(t => retiredTerminals.includes(t)))
        throw new HerdrError('retired-terminal-reused', 'Fresh owners must not reuse identities with pending native notes');
      journal.cutover = cutover;
      journal.cutoverPending = false;
      await saveJournal(request.journalRoot, journal);
      const doctor = await parts.verify(request);
      if (doctor.failures.length)
        throw new HerdrError('setup-verification-failed', 'Setup failed verification; retain the journal and inspect live owners before rollback', { failures: doctor.failures });
      recordRuntimeRootProbes();
      journal.verified = true;
      await saveJournal(request.journalRoot, journal);
      return { writes, probes, cutover, doctor };
    } catch (error) {
      const command = [process.execPath, join(request.packageRoot, 'dist/herdr/cli.mjs'), 'rollback', '--config', request.configPath].map(shellQuote).join(' ');
      const message = error instanceof Error ? error.message : String(error);
      throw new HerdrError(error instanceof HerdrError ? error.code : 'setup-failed', `${message}\nRollback: ${command}`, error instanceof HerdrError ? error.details : undefined);
    }
  });
}
export async function rollbackHerdr(request: SetupRequest, parts: SetupParts): Promise<readonly string[]> {
  assertPlainShell();
  fenceRequest(request);
  await assertGlobalRoot(request.config.globalRoot, parts.globalRoot);
  return withSetupLock(request.journalRoot, async () => {
    const journal = await readJournal(request.journalRoot);
    const appSettings = journal.verified ? undefined : plannedAppSettings(request);
    if (journal.cutoverPending) {
      const preflight = await parts.preflight(request);
      if (!preflight.recoveredCutover && !preflight.cutoverProvedAbsent) throw new HerdrError('cutover-reconciliation-required', 'An uncertain live owner must be reconciled before rollback');
      journal.cutover = preflight.recoveredCutover ?? null; journal.cutoverPending = false;
      await saveJournal(request.journalRoot, journal);
    }
    if (journal.cutover) {
      await parts.rollback(journal.cutover);
      // The created tabs are closed and forgotten. Record it now, so a file-phase failure can be retried.
      journal.cutover = null; journal.verified = false;
      await saveJournal(request.journalRoot, journal);
    }
    const appArtifacts = journal.entries.filter(entry => !entry.managed && resolve(entry.path).startsWith(resolve(request.config.app.home) + '/')).map(entry => entry.path);
    const dependencies = {
      [request.config.shellRc]: [join(request.config.globalRoot, 'herdr/resume.sh')],
      [join(request.config.agentDirectory, 'settings.json')]: [join(request.config.agentDirectory, 'themes/dracula-plus-glass.json')],
      [join(request.config.app.home, 'settings.json')]: appArtifacts,
      [join(request.config.app.home, 'keys.json')]: appArtifacts,
    };
    const restored = await rollbackFiles(request.journalRoot, journal, { dependencies, appSettings, warn: message => parts.warn(message) });
    journal.verified = false;
    journal.cutover = null;
    await saveJournal(request.journalRoot, journal);
    return restored;
  });
}

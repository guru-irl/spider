// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import type { HcClient, HcRunRequest, CoreOnlyHerdrConfig, FullHerdrConfig, HerdrConfig, MachineName, TerminalAddress, CoreIdentity } from '../contracts.js';
import { basename, dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { HerdrLabelContract } from '../contracts.js';
import { HerdrError } from '../client/parse.js';
import { isHerdrConnectivityFailure } from '../client/availability.js';
import { VIEW_ON_MAC_MESSAGE } from '../notices.js';
import { digest, snapshot, atomicWrite, readJournal, saveJournal, withSetupLock, validateFiles, prepareBackups, prepareModDirectories, rollbackModDirectories, discardModStages, unpublishNewMods, applyFiles, rejectSymlinks, mergeTheme, mergeKeys, mergeTerminalKeys, disableRootNotes, rollbackFiles, managedProjection, assertGlobalRoot, missingKeyMapMessage, type KeyBinding, type KeyFields, type KeySections, type ManagedPart, type FileAction, type SetupJournal } from './backup.js';
import { probeLaunch, type DoctorReport, type RuntimeInventory } from './doctor.js';
import { checkRemoteNodeVersion, REMOTE_NODE_MINIMUM } from '../remote/node-version.js';
import { shellQuote } from '../sessions/resume.js';
import { chmod, lstat, mkdir } from 'node:fs/promises';
import type { RuntimeDirectoryProbe } from '../remote/runtime.js';
import { planModStorage } from './mod-storage.js';
import { collectCheckpointBlobs, assertSetupNotUndoing, beginRunCheckpoint, finishRunCheckpoint, readCheckpoint, pendingCheckpointBaselines, recordRemoteWrite, recordCheckpointIntents, recordCheckpointEffects, recordCheckpointWrites, undoUpgrade, includeRegistryCheckpoint, completeDanglingCheckpoint, supersedeCheckpoint, checkpointBaseline, checkpointBytes, type UpgradeCheckpoint, type UpgradeUndoResult } from './checkpoint.js';

import { globalHerdrTemplatePaths } from '../templates/paths.js';

function runtimeTemplatePaths(request: SetupRequest): string[] {
  const instructions = join(request.config.globalRoot, 'herdr/instructions');
  return globalHerdrTemplatePaths({
    templateDirectory: join(dirname(request.config.core.config), 'templates'),
    roleTemplateOptions: { instructionPaths: { worker: join(instructions, 'worker.md'), reviewer: join(instructions, 'reviewer.md'), watcher: join(instructions, 'watcher.md') } },
  });
}

async function ensureSessionFeedDirectory(globalRoot: string, repair = true): Promise<void> {
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
    if (!repair) {
      try { await checkOwner(directory); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      continue;
    }
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
export class CoreOnlySetupError extends HerdrError {
  #request: SetupRequest<CoreOnlyHerdrConfig>;
  constructor(request: SetupRequest<CoreOnlyHerdrConfig>) { super('view-on-mac', VIEW_ON_MAC_MESSAGE); this.#request = request; }
  get request(): SetupRequest<CoreOnlyHerdrConfig> { return this.#request; }
}
export interface SetupRequest<T extends HerdrConfig = FullHerdrConfig> {
  config: T;
  configPath: string;
  packageRoot: string;
  journalRoot: string;
  overwriteUnownedKeys?: boolean;
  nativeKeys?: 'accept' | 'decline';
  replaceChanged?: boolean;
  dryRun?: boolean;
  allowStagingApp?: boolean;
  adoptExistingSpaces?: readonly string[];
}
function plannedAppSettings(request: SetupRequest) {
  return { path: join(request.config.app.home, 'settings.json'), planned: { theme: 'spider-glass', layout: 'spider-glass', sounds: { enabled: false as const } } };
}
export interface InstallFile {
  path: string;
  bytes: Buffer;
  expected: string | null;
  /** Target bytes used to derive this write. Unlike expected, this is not an ownership claim. */
  observedTargetHash?: string | null;
  collision?: 'clone' | 'key';
  mode?: number;
  terminalKeys?: Readonly<Record<string, string>>;
  keys?: KeySections;
  retainedKeys?: KeySections;
  ignoredKeys?: KeyFields;
  managed?: ManagedPart;
  snapshotOnly?: boolean;
  updateAfterCutover?: boolean;
  deferredSoundApplied?: boolean;
  copyFrom?: string;
  replaceBaseline?: boolean;
  refusal?: { code: string; message: string };
  refusalRequired?: boolean;
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
  cutoverActions?: readonly string[];
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
  pendingNativeKeys?(request: SetupRequest): Promise<KeySections>;
  preflight(request: SetupRequest): Promise<SetupPreflight>;
  stageLook(request: SetupRequest, context: SetupContext, mode: 'export' | 'isolated-clone'): Promise<readonly InstallFile[]>;
  installFiles(request: SetupRequest, context: SetupContext): Promise<readonly InstallFile[]>;
  finalizeLook?(request: SetupRequest, context: SetupContext, staged: readonly InstallFile[]): Promise<readonly InstallFile[]>;
  generateTemplates(request: SetupRequest, context: SetupContext): Promise<readonly InstallFile[]>;
  installResume(request: SetupRequest, context: SetupContext): Promise<readonly InstallFile[]>;
  probeMachineNode(target: ProbeTarget, launch: HcRunRequest): Promise<string>;
  /** Read-only paths and change detection for endpoint publication. */
  paneEndpointPlan?(request: SetupRequest): Promise<{ paths: readonly string[]; changed: boolean; files?: readonly InstallFile[] }>;
  /** Explicit setup may stage only this machine’s owned installed endpoint. */
  stagePaneEndpoint?(request: SetupRequest): Promise<readonly string[]>;
  runtimeInventory?(request: SetupRequest): Promise<RuntimeInventory>;
  ensureRuntime(request: SetupRequest, context: SetupContext): Promise<readonly RuntimeFile[]>;
  bootstrapRuntime(request: SetupRequest, context: SetupContext, runtimes: readonly RuntimeFile[]): Promise<void>;
  runtimeRootsHealthy?(request: SetupRequest, runtimes: readonly RuntimeFile[]): Promise<boolean>;
  runtimeRootProbes?(request: SetupRequest, runtimes: readonly RuntimeFile[]): readonly RuntimeRootObservation[];
  hc: Pick<HcClient, 'fileRead' | 'fileWrite'>;
  cutover(request: SetupRequest, context: SetupContext): Promise<CutoverResult>;
  /** Recheck existing owners without repeating initial app selection. */
  reconcileCutover?(request: SetupRequest, context: SetupContext): Promise<CutoverResult>;
  persistCutover?(request: SetupRequest): Promise<CutoverResult>;
  selectApp?(request: SetupRequest): Promise<void>;
  verify(request: SetupRequest, deferredRuntimes: ReadonlySet<MachineName>): Promise<DoctorReport>;
  rollback(result: CutoverResult, options?: { preserve?: CutoverResult; beforeClose?: () => Promise<void> }): Promise<void>;
  warn(message: string): void;
}
export interface SetupResult {
  journalChanged?: boolean;
  plan?: { files: readonly FileAction[]; cutover: readonly string[] };
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
  const work = async (): Promise<SetupResult> => {
    if (!request.dryRun) await collectCheckpointBlobs(request.journalRoot);
    await assertSetupNotUndoing(request.journalRoot);
    const journal = await readJournal(request.journalRoot);
    let checkpoint: UpgradeCheckpoint | undefined, completed = false, setupError: unknown;
    const recordWrites = async (paths: readonly string[]) => { if (checkpoint) await recordCheckpointWrites(request.journalRoot, checkpoint, paths); };
    const saveSetupJournal = async () => { await saveJournal(request.journalRoot, journal); await recordWrites([join(request.journalRoot, 'journal.json')]); };
    const recordSelectionIntent = async () => {
      if (!checkpoint) return;
      const { path, planned } = plannedAppSettings(request), current = await snapshot(path);
      const settings = JSON.parse(current.bytes?.toString('utf8') ?? '{}') as Record<string, unknown>;
      const bytes = Buffer.from(JSON.stringify({ ...settings, layout: planned.layout, theme: planned.theme }));
      await recordCheckpointIntents(request.journalRoot, checkpoint, [{ path, bytes, expected: current.hash, mode: current.mode }], journal);
    };
    const observeWrites = async <T>(paths: readonly string[], work: () => Promise<T>): Promise<T> => {
      const before = await Promise.all(paths.map(path => snapshot(path)));
      if (checkpoint) await recordCheckpointEffects(request.journalRoot, checkpoint, paths);
      try { return await work(); }
      finally {
        const changed: string[] = [];
        for (let i = 0; i < paths.length; i++) {
          const after = await snapshot(paths[i]!);
          if (before[i]!.hash !== after.hash || before[i]!.mode !== after.mode) changed.push(paths[i]!);
        }
        await recordWrites(changed);
      }
    };
    const reconcilingCutover = journal.cutoverPending;
    let needsAppSelection = !journal.verified;
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
    const runningInPlace = journal.verified && !reconcilingCutover && preflight.recoveredCutover && preflight.cutoverActions?.length === 0;
    const cutoverNeeded = !runningInPlace && (preflight.cutoverNeedsRecheck || reconcilingCutover || !journal.verified || journal.cutover === null || (journal.cutoverFingerprint === undefined ? !journal.verified || journal.fingerprint !== fingerprint : journal.cutoverFingerprint !== cutoverFingerprint));
    const previousCutover = JSON.stringify([journal.cutover, journal.cutoverFingerprint]);
    if (runningInPlace) { journal.cutover = preflight.recoveredCutover!; journal.cutoverFingerprint = cutoverFingerprint; }
    let cutoverMetadataChanged = previousCutover !== JSON.stringify([journal.cutover, journal.cutoverFingerprint]);
    const context: SetupContext = { labelContract: HerdrLabelContract, modProps,
      installed: Object.fromEntries(journal.entries.map(e => [e.path, e.after])), retiredTerminals, priorCutover: journal.cutover,
      recordCutover: async (result) => {
        if (result.terminals.some(t => retiredTerminals.includes(t)))
          throw new HerdrError('retired-terminal-reused', 'Fresh owners must not reuse retired terminal IDs');
        journal.cutover = result;
        journal.cutoverFingerprint = cutoverFingerprint;
        journal.launcherNodePath = process.execPath;
        journal.cutoverPending = false;
        await saveSetupJournal();
      } };
    const settingsPath = join(request.config.agentDirectory, 'settings.json');
    const settings = await snapshot(settingsPath);
    const notes = await snapshot(request.config.core.config);
    const settingsFile: InstallFile = { path: settingsPath, expected: settings.hash, bytes: mergeTheme(settings.bytes), managed: { kind: 'json', fields: ['theme'] } };
    const notesFile: InstallFile = { path: request.config.core.config, expected: notes.hash, bytes: disableRootNotes(notes.bytes), managed: { kind: 'notes' } };
    if (!preflight.layoutExport) {
      if (request.dryRun) throw new HerdrError('setup-plan-unavailable', 'Plan mode needs read-only layout export and cannot open a staging app');
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
    const stagedLook = await parts.stageLook(request, context, preflight.layoutExport ? 'export' : 'isolated-clone');
    const installedFiles = await parts.installFiles(request, context);
    const finalLook = parts.finalizeLook ? await parts.finalizeLook(request, context, stagedLook) : stagedLook;
    const plans = [
      ...globalConfigFiles,
      ...finalLook,
      ...installedFiles, settingsFile,
      ...await parts.generateTemplates(request, context), notesFile,
      ...await parts.installResume(request, context),
    ];
    const releasedSounds: string[] = [];
    for (const plan of plans) {
      if (!plan.updateAfterCutover || plan.managed?.kind !== 'json-paths') continue;
      const prior = journal.entries.find(entry => entry.path === plan.path);
      if (prior?.managed?.kind !== 'json-paths' || !journal.verified && prior.managed.paths.includes('sounds.enabled')) continue;
      const rows = JSON.parse(prior.managedAfter ?? '[]') as unknown[];
      const sound = rows.find(row => Array.isArray(row) && row[0] === 'sounds.enabled');
      const current = await snapshot(plan.path);
      const userEnabled = Array.isArray(sound) && sound[1] === true && sound[2] === false
        && managedProjection(current.bytes, { kind: 'json-paths', paths: ['sounds.enabled'] }) === JSON.stringify([['sounds.enabled', true, true]]);
      if (!userEnabled && prior.managed.paths.includes('sounds.enabled')) continue;
      if (current.hash !== plan.expected || current.bytes === null) throw new HerdrError('concurrent-settings-edit', `Changed after preflight: ${plan.path}`);
      plan.bytes = current.bytes;
      plan.managed = { kind: 'json-paths', paths: plan.managed.paths.filter(path => path !== 'sounds.enabled') };
      if (userEnabled) {
        prior.managed = { kind: 'json-paths', paths: prior.managed.paths.filter(path => path !== 'sounds.enabled') };
        prior.managedAfter = JSON.stringify(rows.filter(row => !Array.isArray(row) || row[0] !== 'sounds.enabled'));
        if (prior.pathsBefore) prior.pathsBefore = Object.fromEntries(Object.entries(prior.pathsBefore).filter(([path]) => path !== 'sounds.enabled'));
        releasedSounds.push(plan.path);
      }
    }
    const files: InstallFile[] = [];
    for (const plan of plans) {
      if (!plan.terminalKeys && !plan.keys) {
        files.push(plan);
        continue;
      }
      const current = await snapshot(plan.path);
      if (current.hash !== plan.expected)
        throw new HerdrError('concurrent-settings-edit', `Changed keys after preflight: ${plan.path}`);
      if (current.bytes === null) throw new HerdrError('keys-defaults-missing', missingKeyMapMessage);
      const prior = journal.entries.find(e => e.path === plan.path);
      let refusal: InstallFile['refusal'];
      if (plan.keys) {
        const desired: Record<string, Readonly<Record<string, KeyBinding>>> = { ...plan.keys };
        if (plan.terminalKeys) {
          for (const [key, value] of Object.entries(plan.terminalKeys))
            if (desired.terminal?.[key] !== undefined && desired.terminal[key] !== value)
              throw new HerdrError('key-binding-conflict', `Inconsistent terminal key: ${key}`);
          desired.terminal = { ...plan.terminalKeys, ...desired.terminal };
        }
        const owned: KeySections = { ...prior?.keys, ...(prior?.terminalKeys || prior?.keys?.terminal ? { terminal: { ...prior?.terminalKeys, ...prior?.keys?.terminal } } : {}) };
        const recorded: Record<string, Readonly<Record<string, KeyBinding>>> = { ...desired };
        for (const [section, bindings] of Object.entries(plan.retainedKeys ?? {})) {
          const active = { ...desired[section] };
          for (const key of Object.keys(bindings)) delete active[key];
          if (Object.keys(active).length) desired[section] = active;
          else delete desired[section];
          recorded[section] = { ...active, ...bindings };
        }
        const managed: ManagedPart = { kind: 'keys', sections: Object.fromEntries(Object.entries(recorded).map(([section, bindings]) => [section, Object.keys(bindings)])) };
        try { mergeKeys(current.bytes, desired, owned, false, { ignoredKeys: plan.ignoredKeys }); }
        catch (error) {
          if (!(error instanceof HerdrError) || error.code !== 'key-binding-conflict') throw error;
          refusal = { code: error.code, message: error.message };
        }
        let bytes: Buffer, refusalRequired = false;
        try { bytes = mergeKeys(current.bytes, desired, owned, true, { ignoredKeys: plan.ignoredKeys }); }
        catch (error) {
          if (!(error instanceof HerdrError) || error.code !== 'key-binding-conflict') throw error;
          refusal = { code: error.code, message: `${plan.path}: ${error.message}` };
          refusalRequired = true;
          bytes = current.bytes;
        }
        files.push({ ...plan, keys: recorded, managed, refusal, refusalRequired, bytes });
      } else {
        const owned = prior?.terminalKeys ?? {};
        const managed: ManagedPart = { kind: 'json', section: 'terminal', fields: Object.keys(plan.terminalKeys!) };
        try { mergeTerminalKeys(current.bytes, plan.terminalKeys!, owned, false); }
        catch (error) {
          if (!(error instanceof HerdrError) || error.code !== 'key-binding-conflict') throw error;
          refusal = { code: error.code, message: error.message };
        }
        files.push({ ...plan, managed, refusal, bytes: mergeTerminalKeys(current.bytes, plan.terminalKeys!, owned, true) });
      }
    }
    const layoutPath = join(request.config.app.home, 'layouts/spider-glass.json');
    const layoutPlan = files.find(file => file.path === layoutPath);
    if (layoutPlan) files.splice(files.indexOf(layoutPlan), 0, ...await planModStorage(request.config.app.home, (await snapshot(layoutPath)).bytes, layoutPlan.bytes));
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
    const fileActions = await validateFiles(files, journal, request.overwriteUnownedKeys, plannedAppSettings(request), { replaceChanged: request.replaceChanged, planOnly: request.dryRun, pendingBaselines: await pendingCheckpointBaselines(request.journalRoot) });
    const selectionReplacement = fileActions.some(action => action.action === 'replace' && action.path === plannedAppSettings(request).path && files.some(file => file.path === action.path && (file.snapshotOnly || file.updateAfterCutover)));
    needsAppSelection ||= selectionReplacement;
    if (selectionReplacement) {
      const file = files.find(file => file.path === plannedAppSettings(request).path)!;
      if (file.snapshotOnly) file.bytes = Buffer.from(JSON.stringify(plannedAppSettings(request).planned));
    }
    if (request.dryRun) {
      const cutover = [...(cutoverNeeded ? preflight.cutoverActions ?? ['Recheck recorded sessions and open only closed selections'] : []), ...(needsAppSelection ? ['Select the installed layout and theme'] : [])];
      return { plan: { files: fileActions, cutover }, writes: [], probes: [], cutover: journal.cutover, doctor: { failures: [], warnings: [], probes: [] } };
    }
    const inventory = await parts.runtimeInventory?.(request);
    if (inventory?.missing.length)
      throw new HerdrError('machine-not-found', `No unique entry in the local core inventory for: ${inventory.missing.join(', ')}`);
    const deferred = new Set(inventory?.unreachable);
    const priorPending = new Set(journal.pendingRuntimes);
    const onMachine = async (machine: MachineName, work: () => Promise<void>, explain?: (error: unknown) => HerdrError) => {
      if (deferred.has(machine)) return;
      try { await work(); }
      catch (error) {
        if (!isHerdrConnectivityFailure(error)) throw explain ? explain(error) : error;
        deferred.add(machine);
      }
    };
    const runtimes = await parts.ensureRuntime(request, context);
    const priorRuntimes = journal.runtimes, priorProbes = journal.probes, priorRootProbes = journal.runtimeRootProbes;
    const runtimeKey = (entry: Pick<RuntimeFile, 'machine' | 'path'>) => JSON.stringify([entry.machine, entry.path]);
    const recordedRuntimes = new Map(priorRuntimes.map(entry => [runtimeKey(entry), entry]));
    const recordedRuntime = (runtime: RuntimeFile) => recordedRuntimes.get(runtimeKey(runtime))?.after === runtime.sha256;
    const runtimePlans: { runtime: RuntimeFile; before: string | null }[] = [];
    for (const runtime of runtimes) {
      if (!isAbsolute(runtime.path) || digest(runtime.bytes) !== runtime.sha256)
        throw new HerdrError('runtime-digest-mismatch', 'Runtime source digest or absolute path differs');
      await onMachine(runtime.machine, async () => {
        const target = preflight.targets.find(t => t.machine === runtime.machine);
        const cached = target && priorProbes.find(p => p.machine === target.machine && p.nodePath === target.nodePath && p.coreStartedAt === target.coreStartedAt && checkRemoteNodeVersion(p.version));
        const verifiedRuntime = journal.verified && !priorPending.has(runtime.machine) && cached && recordedRuntime(runtime);
        const bytes = verifiedRuntime ? runtime.bytes : await readRuntime(parts, runtime);
        const before = bytes === null ? null : digest(bytes);
        if (before !== null && before !== runtime.sha256)
          throw new HerdrError('runtime-digest-mismatch', `Existing versioned runtime differs on ${runtime.machine}; inspect it instead of overwriting it`);
        runtimePlans.push({ runtime, before });
      });
    }
    const probes = new Map<MachineName, NodeObservation>();
    for (const target of preflight.targets) {
      const cached = priorProbes.find(p => p.machine === target.machine && p.nodePath === target.nodePath && p.coreStartedAt === target.coreStartedAt);
      if (!priorPending.has(target.machine) && cached && checkRemoteNodeVersion(cached.version) && runtimes.filter(r => r.machine === target.machine).every(recordedRuntime)) continue;
      const requirement = `Machine ${target.machine} needs Node >=${REMOTE_NODE_MINIMUM}; configure nodePath or repair destination PATH`;
      await onMachine(target.machine, async () => {
        const version = await parts.probeMachineNode(target, probeLaunch(target));
        if (!checkRemoteNodeVersion(version)) throw new Error('Unsupported or missing Node version');
        probes.set(target.machine, { ...target, version: version.trim() });
      }, error => new HerdrError('remote-node-unavailable', `${requirement}: ${error instanceof Error ? error.message : String(error)}`));
    }
    const bootstrapError = (error: unknown) => new HerdrError('runtime-bootstrap-failed', `Destination runtime bootstrap failed; repair its directory permissions or Node configuration and rerun setup: ${error instanceof Error ? error.message : String(error)}`);
    const bootstraps: RuntimeFile[] = [];
    for (const { runtime, before } of runtimePlans) await onMachine(runtime.machine, async () => {
      if (!journal.verified || priorPending.has(runtime.machine) || probes.has(runtime.machine) || !recordedRuntime(runtime) || before !== runtime.sha256 ||
          parts.runtimeRootsHealthy && !await parts.runtimeRootsHealthy(request, [runtime])) bootstraps.push(runtime);
    }, bootstrapError);
    const bootstrap = async () => {
      for (const runtime of bootstraps) await onMachine(runtime.machine, () => parts.bootstrapRuntime(request, context, [runtime]), bootstrapError);
    };
    const activeProbes = () => [...probes.values()].filter(probe => !deferred.has(probe.machine));
    const runtimeJournalState = () => JSON.stringify([journal.runtimes, journal.probes, journal.runtimeRootProbes, journal.pendingRuntimes]);
    const recordRuntimes = (): boolean => {
      const previous = runtimeJournalState();
      const active = runtimePlans.filter(({ runtime }) => !deferred.has(runtime.machine));
      const entries = new Map(recordedRuntimes), observations = new Map(priorProbes.map(probe => [probe.machine, probe]));
      for (const { runtime, before } of active) if (!recordedRuntime(runtime))
        entries.set(runtimeKey(runtime), { machine: runtime.machine, path: runtime.path, before, after: runtime.sha256 });
      for (const probe of activeProbes()) observations.set(probe.machine, probe);
      journal.runtimes = [...entries.values()];
      journal.probes = [...observations.values()];
      if (parts.runtimeRootProbes) {
        const roots = new Map(priorRootProbes?.filter(probe => deferred.has(probe.machine)).map(probe => [probe.machine, probe]));
        for (const probe of parts.runtimeRootProbes(request, active.map(({ runtime }) => runtime))) roots.set(probe.machine, probe);
        journal.runtimeRootProbes = [...roots.values()];
      }
      journal.pendingRuntimes = deferred.size ? [...deferred].sort() : undefined;
      return previous !== runtimeJournalState();
    };
    const verify = async () => {
      const doctor = await parts.verify(request, deferred);
      for (const machine of doctor.deferredRuntimes ?? []) deferred.add(machine);
      return doctor;
    };
    const warnDeferred = () => {
      if (deferred.size) parts.warn(`Skipped runtime setup on ${[...deferred].sort().join(', ')}. Setup will install the runtime the next time setup runs while each machine is reachable.`);
    };
    const unchanged = releasedSounds.length === 0 && fileActions.every(action => action.action === 'unchanged') && journal.verified && !cutoverNeeded && fingerprint === journal.fingerprint && activeProbes().length === 0 && runtimePlans.every(p => deferred.has(p.runtime.machine) || p.before === p.runtime.sha256) && (await Promise.all(files.map(async file => file.snapshotOnly || (await snapshot(file.path)).hash === digest(file.bytes)))).every(Boolean);
    await ensureSessionFeedDirectory(request.config.globalRoot, false);
    const endpointPlan = await parts.paneEndpointPlan?.(request);
    const checkpointPaths = [...files.map(file => file.path), layoutPath, join(request.config.app.home, 'keys.json'),
      plannedAppSettings(request).path, join(request.config.globalRoot, 'herdr/spaces/spaces.json'),
      join(request.config.globalRoot, 'herdr/installation.json'), join(request.journalRoot, 'journal.json'), ...(endpointPlan?.paths ?? [])];
    const runtimeTemplates = new Set(runtimeTemplatePaths(request));
    const runtimeRewritten = (file: InstallFile) => file.path === layoutPath || file.copyFrom || runtimeTemplates.has(file.path);
    const substantive = fileActions.some(action => action.action !== 'unchanged' && files.some(file => file.path === action.path && !file.snapshotOnly && !runtimeRewritten(file) && digest(file.bytes) !== file.expected)) || !!endpointPlan?.changed;
    if (!unchanged || endpointPlan?.changed || !endpointPlan && parts.stagePaneEndpoint || cutoverMetadataChanged || runningInPlace && preflight.cutoverNeedsRecheck && parts.persistCutover)
      checkpoint = await beginRunCheckpoint(request.journalRoot, checkpointPaths, substantive);
    try {
      if (checkpoint && endpointPlan?.files) await recordCheckpointIntents(request.journalRoot, checkpoint, endpointPlan.files, journal);
      if (runningInPlace && preflight.cutoverNeedsRecheck && parts.persistCutover) {
        journal.cutover = await observeWrites([join(request.config.globalRoot, 'herdr/spaces/spaces.json')], () => parts.persistCutover!(request));
        context.priorCutover = journal.cutover;
        cutoverMetadataChanged = previousCutover !== JSON.stringify([journal.cutover, journal.cutoverFingerprint]);
      }
      await ensureSessionFeedDirectory(request.config.globalRoot);
      const endpointWrites = await observeWrites([join(request.config.globalRoot, 'herdr/installation.json'), ...(endpointPlan?.paths ?? [])], async () => await parts.stagePaneEndpoint?.(request) ?? []);
      if (unchanged) {
        await bootstrap(); // Repair root loss without repeating cutover or unrelated setup writes.
        const doctor = await verify();
        if (doctor.failures.length) throw new HerdrError('setup-verification-failed', 'Installed setup failed verification', { failures: doctor.failures });
        if (recordRuntimes() || cutoverMetadataChanged) {
          checkpoint ??= await beginRunCheckpoint(request.journalRoot, checkpointPaths, substantive);
          await saveSetupJournal();
        }
        warnDeferred();
        completed = true;
        return { writes: [...endpointWrites], probes: [], cutover: journal.cutover, doctor };
      }
      const appFiles = files.filter(file => file.updateAfterCutover);
      const ownedSounds = new Set<string>();
      for (const file of appFiles) {
        const prior = journal.entries.find(entry => entry.path === file.path);
        if (prior?.managed?.kind !== 'json-paths' || !prior.managed.paths.includes('sounds.enabled')) continue;
        const current = await snapshot(file.path);
        if (!journal.verified && prior.soundApplied !== true && (current.hash === null || current.hash !== prior.soundIntent)) continue;
        const rows = JSON.parse(prior.managedAfter ?? '[]') as unknown[];
        const sound = rows.find(row => Array.isArray(row) && row[0] === 'sounds.enabled');
        if (Array.isArray(sound) && managedProjection(current.bytes, { kind: 'json-paths', paths: ['sounds.enabled'] }) === JSON.stringify([sound])) ownedSounds.add(file.path);
      }
      for (const file of appFiles)
        if (file.managed?.kind === 'json-paths' && file.managed.paths.includes('sounds.enabled')) file.deferredSoundApplied = ownedSounds.has(file.path);
      journal.fingerprint = fingerprint;
      journal.verified = false;
      journal.retiredTerminals = retiredTerminals;
      await prepareBackups(request.journalRoot, files, journal);
      if (checkpoint) await recordCheckpointIntents(request.journalRoot, checkpoint, files, journal);
      for (const { runtime, before } of runtimePlans) await onMachine(runtime.machine, async () => {
        const installed = await readRuntime(parts, runtime);
        const current = installed === null ? null : digest(installed);
        if (current === runtime.sha256) return;
        if (current !== before)
          throw new HerdrError('runtime-digest-mismatch', `Runtime changed after preflight on ${runtime.machine}`);
        if (checkpoint) await recordRemoteWrite(request.journalRoot, checkpoint, runtime.machine, runtime.path);
        await parts.hc.fileWrite(runtime.machine, runtime.path, runtime.bytes);
        if (digest(await parts.hc.fileRead(runtime.machine, runtime.path)) !== runtime.sha256)
          throw new HerdrError('runtime-digest-mismatch', `Runtime verification failed on ${runtime.machine}`);
      });
      await bootstrap();
      // Persist completed runtime work before local publication so recovery can reuse its probes.
      if (recordRuntimes()) await saveSetupJournal();
      await prepareModDirectories(request.journalRoot, request.config.app.home, files, journal, recordWrites);
      const writes = [...endpointWrites, ...await applyFiles(request.journalRoot, files.filter(file => !file.updateAfterCutover), journal, recordWrites)];
      for (const file of appFiles)
        if ((await snapshot(file.path)).hash !== file.expected) throw new HerdrError('concurrent-settings-edit', `Changed before app selection: ${file.path}`);
      for (const path of releasedSounds) parts.warn(`${path}: sounds.enabled was changed by the user and released.`);
      let cutover = journal.cutover;
      try {
        if (cutoverNeeded || selectionReplacement) {
          if (cutoverNeeded) { journal.cutoverPending = true; await saveSetupJournal(); }
          let selectionError: unknown;
          try {
            await recordSelectionIntent();
            if (cutoverNeeded) cutover = await observeWrites([layoutPath, plannedAppSettings(request).path, join(request.config.globalRoot, 'herdr/spaces/spaces.json')], () => context.priorCutover && !needsAppSelection && parts.reconcileCutover ? parts.reconcileCutover(request, context) : parts.cutover(request, context));
            else {
              if (!parts.selectApp) throw new HerdrError('app-selection-unavailable', 'App selection is unavailable; run setup again');
              await observeWrites([plannedAppSettings(request).path], () => parts.selectApp!(request));
            }
          } catch (error) { selectionError = error; }
          try {
            for (const file of files.filter(file => file.snapshotOnly || file.updateAfterCutover)) {
              const current = await snapshot(file.path);
              const entry = journal.entries.find(entry => entry.path === file.path)!;
              entry.after = current.hash ?? digest(Buffer.alloc(0));
              if (file.managed) entry.managedAfter = managedProjection(current.bytes, file.managed);
            }
            await saveSetupJournal();
          } catch (error) { if (selectionError === undefined) selectionError = error; }
          if (selectionError !== undefined) throw selectionError;
        }
        for (const file of appFiles) {
          if (file.managed?.kind !== 'json-paths' || !file.managed.paths.includes('sounds.enabled')) continue;
          const sound: ManagedPart = { kind: 'json-paths', paths: ['sounds.enabled'] };
          let soundError: unknown;
          try {
            for (let attempt = 0; attempt < 2; attempt++) {
              const current = await snapshot(file.path);
              if (managedProjection(current.bytes, sound) === managedProjection(file.bytes, sound)) break;
              const settings = JSON.parse(current.bytes?.toString('utf8') ?? '{}') as Record<string, unknown>;
              const sounds = (settings.sounds ?? {}) as Record<string, unknown>;
              const bytes = Buffer.from(JSON.stringify({ ...settings, sounds: { ...sounds, enabled: false } }, null, 2) + '\n');
              journal.entries.find(entry => entry.path === file.path)!.soundIntent = digest(bytes);
              await saveSetupJournal();
              await atomicWrite(file.path, bytes, current.mode, current.hash);
              await recordWrites([file.path]);
              if (!writes.includes(file.path)) writes.push(file.path);
            }
            const current = await snapshot(file.path);
            if (managedProjection(current.bytes, sound) !== managedProjection(file.bytes, sound)) throw new HerdrError('concurrent-settings-edit', `Sound changed after app selection: ${file.path}`);
            journal.entries.find(entry => entry.path === file.path)!.soundApplied = true;
          } catch (error) { soundError = error; }
          try {
            const current = await snapshot(file.path), entry = journal.entries.find(entry => entry.path === file.path)!;
            entry.after = current.hash ?? digest(Buffer.alloc(0));
            entry.managedAfter = managedProjection(current.bytes, file.managed);
            await saveSetupJournal();
          } catch (error) { if (soundError === undefined) soundError = error; }
          if (soundError !== undefined) throw soundError;
        }
        if (!cutover) throw new HerdrError('cutover-reconciliation-required', 'No completed cutover was recorded');
        journal.cutoverFingerprint = cutoverFingerprint;
        journal.launcherNodePath = process.execPath;
        if (cutover.terminals.some(t => retiredTerminals.includes(t)))
          throw new HerdrError('retired-terminal-reused', 'Fresh owners must not reuse identities with pending native notes');
        journal.cutover = cutover;
        journal.cutoverPending = false;
        await saveSetupJournal();
        const doctor = await verify();
        if (doctor.failures.length)
          throw new HerdrError('setup-verification-failed', 'Setup failed verification; retain the journal and inspect live owners before rollback', { failures: doctor.failures });
        recordRuntimes();
        journal.verified = true;
        await saveSetupJournal();
        warnDeferred();
        completed = true;
        return { writes, probes: activeProbes(), cutover, doctor };
      } catch (error) { throw error; }
    } catch (error) { setupError = error; throw error; }
    finally {
      try {
        if (checkpoint) {
          await recordWrites([join(request.journalRoot, 'journal.json')]);
          await finishRunCheckpoint(request.journalRoot, checkpoint, completed);
        } else if (completed) await completeDanglingCheckpoint(request.journalRoot);
      } catch (error) {
        if (setupError === undefined) throw error;
        parts.warn(`Setup checkpoint could not be finalized: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  };
  const recordedWork = async () => {
    const before = await snapshot(join(request.journalRoot, 'journal.json'));
    const previousCheckpoint = await snapshot(join(request.journalRoot, 'checkpoint.json'));
    try {
      const result = await work();
      result.journalChanged = before.hash !== (await snapshot(join(request.journalRoot, 'journal.json'))).hash;
      return result;
    } catch (error) {
      let upgrade = false, recorded = false;
      try {
        recorded = before.hash !== (await snapshot(join(request.journalRoot, 'journal.json'))).hash;
        recorded ||= previousCheckpoint.hash !== (await snapshot(join(request.journalRoot, 'checkpoint.json'))).hash;
        const checkpoint = await readCheckpoint(request.journalRoot);
        upgrade = !!checkpoint && !['undone', 'superseded'].includes(checkpoint.state);
      } catch { /* Recovery metadata must not hide the original setup failure. */ }
      if (!recorded) throw error;
      const command = [process.execPath, join(request.packageRoot, 'dist/herdr/cli.mjs'), 'rollback', ...(upgrade ? ['--undo-upgrade'] : []), '--config', request.configPath].map(shellQuote).join(' ');
      const code = error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : 'setup-failed';
      throw new HerdrError(code, `${error instanceof Error ? error.message : String(error)}\nRollback: ${command}`, error instanceof HerdrError ? error.details : undefined);
    }
  };
  return request.dryRun ? work() : withSetupLock(request.journalRoot, recordedWork);
}
async function releaseRollbackOwners(request: SetupRequest, parts: SetupParts, journal: SetupJournal, options?: { preserve?: CutoverResult; beforeClose?: () => Promise<void> }): Promise<void> {
    if (journal.cutoverPending) {
      const preflight = await parts.preflight(request);
      if (!preflight.recoveredCutover && !preflight.cutoverProvedAbsent) throw new HerdrError('cutover-reconciliation-required', 'An uncertain live owner must be reconciled before rollback');
      journal.cutover = preflight.recoveredCutover ?? null; journal.cutoverPending = false;
      await saveJournal(request.journalRoot, journal);
    }
    if (journal.cutover) {
      const preserve = options?.preserve;
      if (preserve && journal.cutover.terminals.every(terminal => preserve.terminals.includes(terminal)) && Object.entries(journal.cutover.identities).every(([session, identity]) => preserve.identities[session] === identity)) return;
      await parts.rollback(journal.cutover, options);
      // The created tabs are closed and forgotten. Record it now, so a file-phase failure can be retried.
      journal.cutover = options?.preserve ?? null; journal.verified = false;
      await saveJournal(request.journalRoot, journal);
    }
}
export async function undoHerdrUpgrade(request: SetupRequest, parts: SetupParts): Promise<UpgradeUndoResult> {
  assertPlainShell();
  fenceRequest(request);
  await assertGlobalRoot(request.config.globalRoot, parts.globalRoot);
  return withSetupLock(request.journalRoot, async () => {
    await collectCheckpointBlobs(request.journalRoot);
    const journal = await readJournal(request.journalRoot);
    const checkpoint = await readCheckpoint(request.journalRoot);
    const dataRoot = join(request.config.app.home, 'data') + '/';
    try { return await undoUpgrade(request.journalRoot, {
      replaceChanged: request.replaceChanged,
      ownerPaths: [join(request.config.globalRoot, 'herdr/spaces/spaces.json'), join(request.journalRoot, 'journal.json'), join(request.config.app.home, 'layouts/spider-glass.json'), plannedAppSettings(request).path],
      managed: new Map(journal.entries.flatMap(entry => entry.managed ? [[entry.path, entry.managed] as const] : [])),
      runtimePaths: [join(request.config.globalRoot, 'herdr/spaces/spaces.json')],
      layoutPath: join(request.config.app.home, 'layouts/spider-glass.json'),
      removedMods: checkpoint ? checkpointBaseline(checkpoint).filter(file => file.hash === null && dirname(dirname(file.path)) === join(request.config.app.home, 'mods') && basename(file.path) === 'mod.json').map(file => basename(dirname(file.path))) : [],
      runtimeStorePaths: checkpoint?.runs.flatMap(run => run.before.map(file => file.path)).filter(path => path.startsWith(dataRoot) && /^spider-[a-zA-Z0-9_-]+\/store(?:-[a-f0-9]+)?\.json$/.test(path.slice(dataRoot.length))) ?? [],
      runtimeRewrittenPaths: runtimeTemplatePaths(request),
      warn: message => parts.warn(message),
      releaseOwners: async (baseline, beforeClose) => {
        const saved = baseline.find(file => file.path === join(request.journalRoot, 'journal.json'));
        const bytes = saved ? await checkpointBytes(request.journalRoot, saved) : null;
        const preserve = bytes ? (JSON.parse(bytes.toString('utf8')) as SetupJournal).cutover ?? undefined : undefined;
        await releaseRollbackOwners(request, parts, journal, { preserve, beforeClose });
      },
      unpublish: async (baseline, expected, didWrite) => {
        const removable = new Map(baseline.filter(file => file.hash === null).map(file => [file.path, expected.find(state => state.path === file.path)?.hash ?? null]));
        return unpublishNewMods(request.journalRoot, journal, removable, didWrite);
      },
      cleanup: async baseline => {
        await discardModStages(journal);
        const existing = new Set(baseline.filter(file => file.hash !== null).map(file => file.path));
        await rollbackModDirectories(request.config.app.home, { ...journal, entries: journal.entries.filter(entry => existing.has(entry.path)) }, message => parts.warn(message));
      },
    }); } finally { await collectCheckpointBlobs(request.journalRoot); }
  });
}
export async function rollbackHerdr(request: SetupRequest, parts: SetupParts): Promise<readonly string[]> {
  assertPlainShell();
  fenceRequest(request);
  await assertGlobalRoot(request.config.globalRoot, parts.globalRoot);
  return withSetupLock(request.journalRoot, async () => {
    await collectCheckpointBlobs(request.journalRoot);
    const journal = await readJournal(request.journalRoot);
    const appSettings = journal.verified ? undefined : plannedAppSettings(request);
    await assertSetupNotUndoing(request.journalRoot);
    await releaseRollbackOwners(request, parts, journal);
    await includeRegistryCheckpoint(request.journalRoot, journal, join(request.config.globalRoot, 'herdr/installation.json'));
    await saveJournal(request.journalRoot, journal);
    const appArtifacts = journal.entries.filter(entry => !entry.managed && resolve(entry.path).startsWith(resolve(request.config.app.home) + '/')).map(entry => entry.path);
    const dependencies = {
      [request.config.shellRc]: [join(request.config.globalRoot, 'herdr/resume.sh')],
      [join(request.config.agentDirectory, 'settings.json')]: [join(request.config.agentDirectory, 'themes/dracula-plus-glass.json')],
      [join(request.config.app.home, 'settings.json')]: appArtifacts,
      [join(request.config.app.home, 'keys.json')]: appArtifacts,
    };
    const restored = await rollbackFiles(request.journalRoot, journal, { dependencies, appSettings, warn: message => parts.warn(message) });
    await rollbackModDirectories(request.config.app.home, journal, message => parts.warn(message));
    journal.verified = false;
    journal.cutover = null;
    await saveJournal(request.journalRoot, journal);
    await supersedeCheckpoint(request.journalRoot);
    return restored;
  });
}

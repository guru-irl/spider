// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { activePlacementRepairs, placementRepairPath, readPlacementRepairs, type PlacementRepairInspection } from '../jobs/placement-repairs.js';
import { HERDR_LABELS, HERDR_KINDS, type HcRunRequest, type MachineName } from '../contracts.js';
import { isHerdrConnectivityFailure } from '../client/availability.js';
import { readAppPaneCapabilities } from '../panes/capabilities.js';
import { paneAddress, paneId, paneText } from '../panes/codec.js';
import { readPrivateJson } from '../sessions/registry.js';
import { runtimeInstallPath, type ProbeTarget, type NodeObservation, type SetupRequest } from './installer.js';
import { snapshot, rootNotesValue, readJournal, managedProjection, assertGlobalRoot, missingKeyMapMessage, type KeyFields, type KeySections } from './backup.js';
import { isDeepStrictEqual } from 'node:util';
import { access, lstat, opendir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isAbsolute, join } from 'node:path';
import { checkRemoteNodeVersion, REMOTE_NODE_MINIMUM, isRuntimeRootProbe } from '../remote/node-version.js';
import { LEGACY_SPIDER_LAYOUT, SPIDER_LAYOUT, SPIDER_LAYOUT_KEYS, layoutSelectionPath, legacySpiderLayoutPath, spiderLayoutPath } from '../look/names.js';
import { hasLegacyLayout, readLayoutSelection } from './layout-rename.js';
export const DOCTOR_ITEMS = ['baseline', 'core-identity', 'hc-json', 'status-instance', 'feed-permissions', 'feed-freshness', 'ipc-authentication', 'jobs', 'observers', 'runtime-digest', 'ssh-cache', 'bypass-stripping', 'mods', 'clones', 'patch-version', 'layout-theme', 'fonts', 'pi-schema-contrast', 'keys', 'roles', 'resume', 'presence', 'mappings-leases', 'spaces-tabs', 'measurements', 'lock-adapters', 'pane-core', 'pane-capabilities', 'pane-helper', 'pane-installation'] as const;
export type DoctorItem = typeof DOCTOR_ITEMS[number];
export interface DoctorFailure {
  item: string;
  code: string;
  message: string;
  repair: string;
}
export type DoctorInformation = Pick<DoctorFailure, 'item' | 'code' | 'message'>;
export interface DoctorReport {
  information?: readonly DoctorInformation[];
  failures: readonly DoctorFailure[];
  warnings: readonly DoctorFailure[];
  probes: readonly NodeObservation[];
  passed?: number;
  deferredRuntimes?: readonly MachineName[];
}
export function checkManagedKeyBindings(bytes: Buffer | null, desired: KeySections, options: { ignoredKeys?: KeyFields } = {}): { failures: DoctorFailure[]; warnings: DoctorFailure[] } {
  if (bytes === null) return { failures: [{ item: 'keys', code: 'keys-defaults-missing', message: missingKeyMapMessage, repair: missingKeyMapMessage }], warnings: [] };
  const failures: DoctorFailure[] = [], warnings: DoctorFailure[] = [];
  const issue = (message: string): DoctorFailure => ({ item: 'keys', code: 'key-binding-conflict', message, repair: 'Repair the conflicting key and rerun setup and doctor.' });
  try {
    const parsed: unknown = JSON.parse(bytes?.toString('utf8') ?? '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Keys must be an object');
    const keys = parsed as Record<string, unknown>;
    const section = (name: string): Record<string, unknown> => {
      const value = keys[name];
      if (value === undefined) return {};
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid key section ${name}`);
      return value as Record<string, unknown>;
    };
    for (const [name, bindings] of Object.entries(desired)) {
      const actual = section(name);
      for (const [key, value] of Object.entries(bindings))
        if (!options.ignoredKeys?.[name]?.includes(key) && !isDeepStrictEqual(actual[key], value)) failures.push(issue(`Managed key differs: ${name}.${key}`));
    }
    if (desired[SPIDER_LAYOUT_KEYS]?.['cmd-shift-e'] !== undefined) {
      const global = section('global'), terminal = section('terminal'), layout = section(SPIDER_LAYOUT_KEYS);
      for (const [name, values] of [['global', global], ['terminal', terminal]] as const)
        if (!options.ignoredKeys?.[name]?.includes('cmd-shift-e') && values['cmd-shift-e'] !== undefined) failures.push(issue(`Competing key: ${name}.cmd-shift-e`));
      for (const [name, values] of [['global', global], ['terminal', terminal], [SPIDER_LAYOUT_KEYS, layout]] as const)
        if (!options.ignoredKeys?.[name]?.includes('cmd-shift-w') && values['cmd-shift-w'] !== undefined && values['cmd-shift-w'] !== 'pane.close' && !(name === SPIDER_LAYOUT_KEYS && desired[name]?.['cmd-shift-w'] === 'spider-pane.close' && values['cmd-shift-w'] === 'spider-pane.close')) failures.push(issue(`Pane close differs: ${name}.cmd-shift-w`));
      if (global['cmd-shift-w'] === undefined) warnings.push({ item: 'keys', code: 'inspection-unavailable', message: 'The effective global.cmd-shift-w default is not recorded in keys.json', repair: 'Check the active app key binding before relying on pane close.' });
    }
  } catch (error) {
    failures.push(issue(error instanceof Error ? error.message : 'Keys could not be inspected'));
  }
  return { failures, warnings };
}
export function paneCoreVersionSupported(version: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) return false;
  const [major, minor, patch] = match.slice(1).map(Number); return major > 0 || minor > 1 || minor === 1 && patch >= 16;
}
export function inspectPaneCommands(value: unknown): { failures: DoctorFailure[]; warnings?: DoctorFailure[]; information?: DoctorInformation[] } {
  const commands = Array.isArray(value) ? value : value && typeof value === 'object' ? (value as { commands?: unknown }).commands : null;
  const warning = (code: string, message: string) => ({ failures: [], warnings: [{ item: 'pane-capabilities', code, message, repair: 'Use a supported app and rerun doctor.' }] });
  if (!Array.isArray(commands) || commands.length > 4096 || commands.some(row => !row || typeof row.name !== 'string' || !Array.isArray(row.args) || row.args.some((arg: unknown) => !arg || typeof arg !== 'object' || typeof (arg as { name?: unknown }).name !== 'string' || typeof (arg as { required?: unknown }).required !== 'boolean'))) return warning('pane-capabilities-unknown', 'Pane command capabilities are unavailable; optional capabilities remain unsupported.');
  for (const name of ['tab.new', 'terminal.open', 'terminal.keep', 'pane.split', 'pane.close']) if (commands.filter(row => row.name === name).length !== 1) return warning('pane-command-unavailable', `Required pane command is unavailable: ${name}`);
  const capabilities = readAppPaneCapabilities(value);
  return { failures: [], information: [{ item: 'pane-capabilities', code: 'pane-capabilities', message: `Background tabs: ${capabilities.backgroundTabCreation ? 'available' : 'unsupported'}; explicit swap: ${capabilities.explicitTargetSwap ? 'available' : 'unsupported'}; no-focus conversion: unsupported.` }] };
}
export interface PaneServiceClaimInspection { coreId: string; socket: string; sessionNamespace: string; operationId: string; address: import('../contracts.js').TerminalAddress }
export async function inspectPaneServiceState(root: string, probe: (claim: PaneServiceClaimInspection) => Promise<boolean>): Promise<{ failures: DoctorFailure[]; warnings?: DoctorFailure[] }> {
  const unavailable = (code: string, message: string) => ({ failures: [], warnings: [{ item: 'pane-helper', code, message, repair: 'Open the machine picker to request a presentation explicitly.' }] });
  const unsafe = () => ({ failures: [{ item: 'pane-helper', code: 'pane-cache-unsafe', message: 'Presentation cache must contain private, owned regular files and directories.', repair: 'Repair the private presentation cache permissions and rerun doctor.' }] });
  const privatePath = async (path: string, directory: boolean) => { const stat = await lstat(path); return !stat.isSymbolicLink() && (directory ? stat.isDirectory() : stat.isFile() && stat.nlink === 1 && stat.size <= 1024 * 1024) && (process.platform === 'win32' || stat.uid === process.getuid?.() && (stat.mode & 0o077) === 0); };
  try { if (!await privatePath(root, true)) return unsafe(); }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' ? unavailable('pane-helper-missing', 'Presentation helper has not been started.') : unsafe(); }
  try {
    try {
      const bindings = join(root, 'bindings'); if (!await privatePath(bindings, true)) return unsafe();
      let count = 0;
      for await (const entry of await opendir(bindings)) { if (++count > 256) return unavailable('pane-cache-limit', 'Presentation cache inspection reached its bound.'); if (!await privatePath(join(bindings, entry.name), false)) return unsafe(); }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return unsafe(); }
    const path = join(root, 'service.json');
    try { if (!await privatePath(path, false)) return unsafe(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return unavailable('pane-helper-missing', 'Presentation helper has not been started.'); return unsafe(); }
    const raw = await readPrivateJson(path) as Record<string, unknown> | null;
    if (!raw || raw.version !== 1 || raw.state !== 'acknowledged' || raw.address === null) return unavailable('pane-helper-uncertain', 'Presentation helper claim is unresolved; doctor did not start or repair it.');
    const claim = { coreId: paneId(raw.coreId), socket: paneText(raw.socket), sessionNamespace: paneText(raw.sessionNamespace), operationId: paneId(raw.operationId), address: paneAddress(raw.address) };
    return await probe(claim) ? { failures: [] } : unavailable('pane-helper-missing', 'Presentation helper is not proved live; doctor did not restart it.');
  } catch { return unavailable('pane-helper-unavailable', 'Presentation helper could not be inspected; no repair was attempted.'); }
}
export type DoctorRequest = SetupRequest;
export interface DoctorRuntimeAvailability {
  shouldSkip(machine: MachineName): boolean;
  deferOnConnectivityFailure(machine: MachineName, error: unknown): boolean;
}
export interface RuntimeInventory {
  unreachable: readonly MachineName[];
  missing: readonly MachineName[];
}
export interface DoctorParts {
  globalRoot?: string;
  placementRepairInspection?(): Promise<PlacementRepairInspection>;
  targets(request: DoctorRequest): Promise<readonly ProbeTarget[]>;
  runtimeInventory?(request: DoctorRequest): Promise<RuntimeInventory>;
  inspect(item: DoctorItem, request: DoctorRequest, runtimeAvailability?: DoctorRuntimeAvailability): Promise<{
    failures: readonly DoctorFailure[];
    warnings?: readonly DoctorFailure[];
    information?: readonly DoctorInformation[];
  }>;
  launchHistory(request: DoctorRequest): Promise<readonly {
    argv: readonly string[];
  }[] | null>;
  probeMachineNode(target: ProbeTarget, launch: HcRunRequest): Promise<string>;
  /** Production runs this even when the Node version observation is cached. */
  probeRuntimeRoot?(target: ProbeTarget, launch: HcRunRequest): Promise<string>;
  cachedNodeObservations?(request: DoctorRequest): Promise<readonly NodeObservation[]>;
}
export function probeLaunch(target: ProbeTarget): HcRunRequest {
  return { argv: [target.nodePath, '--version'], cwd: null, on: target.machine,
    labels: { [HERDR_LABELS.kind]: HERDR_KINDS.setupProbe },
    background: true, outliveParent: true, noNotify: true };
}
export function checkNodeVersion(version: string): boolean {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  if (!match)
    return false;
  const [major, minor, patch] = match.slice(1).map(Number);
  return major > 22 || major === 22 && (minor > 19 || minor === 19 && patch >= 0);
}
function shellWords(line: string): string[] {
  const words: string[] = []; let word = '', quoted = false, started = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === "'") { quoted = !quoted; started = true; }
    else if (char === '\\' && !quoted) { word += line[++i] ?? ''; started = true; }
    else if (/\s/.test(char) && !quoted) { if (started) words.push(word); word = ''; started = false; }
    else { word += char; started = true; }
  }
  if (started) words.push(word);
  return words;
}
async function pinnedNodePaths(request: DoctorRequest): Promise<Map<string, string[]>> {
  const paths = new Map<string, string[]>();
  const add = (path: string, source: string) => paths.set(path, [...paths.get(path) ?? [], source]);
  const journal = await readJournal(request.journalRoot);
  if (journal.launcherNodePath) add(journal.launcherNodePath, 'cutover launcher');
  const rc = managedProjection((await snapshot(request.config.shellRc)).bytes, { kind: 'resume' });
  const source = /^\s*\.\s+(.+)$/m.exec(rc);
  if (source) { const args = shellWords(source[1]); if (args[1]) add(args[1], 'shell resume block'); }
  const layout = (await snapshot(spiderLayoutPath(request.config.app.home))).bytes;
  if (layout) {
    const walk = (value: unknown): void => {
      if (!value || typeof value !== 'object') return;
      if (Array.isArray(value)) { for (const child of value) walk(child); return; }
      const props = value as Record<string, unknown>;
      // Machine props also contain nodePath, but only launchers pin a local Node.
      if (typeof props.nodePath === 'string' && typeof props.cliPath === 'string' && typeof props.configPath === 'string')
        add(props.nodePath, 'installed mod props');
      for (const child of Object.values(props)) walk(child);
    };
    walk(JSON.parse(layout.toString('utf8')));
  }
  return paths;
}
export async function doctorHerdr(request: DoctorRequest, parts: DoctorParts, setupDeferredRuntimes?: ReadonlySet<MachineName>): Promise<DoctorReport> {
  try { await assertGlobalRoot(request.config.globalRoot, parts.globalRoot); }
  catch (error) { return { failures: [{ item: 'global-root', code: 'global-root-mismatch', message: error instanceof Error ? error.message : String(error), repair: `Set globalRoot to ${parts.globalRoot} in ${request.configPath}, then rerun setup or doctor.` }], warnings: [], probes: [], passed: 0 }; }
  const failures: DoctorFailure[] = [];
  const warnings: DoctorFailure[] = [];
  const information: DoctorInformation[] = [{ item: 'resume', code: 'resume-mode', message: request.config.resume ?? 'offer' }];
  const probes: NodeObservation[] = [];
  let passed = 0;
  const fail = (item: string, code: string, message: string, repair: string) => failures.push({ item, code, message, repair });
  const deferredRuntimes = new Set(setupDeferredRuntimes);
  const missingRuntimes = new Set<MachineName>();
  if (!setupDeferredRuntimes && request.config.machines.length) {
    try {
      const inventory = await parts.runtimeInventory?.(request);
      for (const machine of inventory?.missing ?? []) {
        missingRuntimes.add(machine);
        fail('runtime-availability', 'machine-not-found', `Machine ${machine} has no unique entry in the local core inventory.`, 'Correct the machine name in the setup configuration or the local Herdr core, then rerun doctor.');
      }
      for (const machine of inventory?.unreachable ?? []) deferredRuntimes.add(machine);
      const pending = new Set((await readJournal(request.journalRoot)).pendingRuntimes);
      for (const machine of request.config.machines) if (pending.has(machine.name) && !missingRuntimes.has(machine.name)) deferredRuntimes.add(machine.name);
    } catch (error) {
      fail('runtime-availability', 'doctor-inspection-failed', error instanceof Error ? error.message : String(error), 'Check the setup journal and the local Herdr core, then rerun doctor.');
    }
  }
  const runtimeAvailability: DoctorRuntimeAvailability = {
    shouldSkip: machine => deferredRuntimes.has(machine) || missingRuntimes.has(machine),
    deferOnConnectivityFailure: (machine, error) => {
      if (!isHerdrConnectivityFailure(error)) return false;
      deferredRuntimes.add(machine);
      return true;
    },
  };
  const repairRoot = join(request.config.globalRoot, 'herdr/panes');
  let repairFiles: string[] = [];
  try {
    const root = repairRoot;
    const records = await readPlacementRepairs(root);
    repairFiles = records.map(repair => placementRepairPath(root, repair));
    const inspection = records.length ? await parts.placementRepairInspection?.() : undefined;
    for (const repair of inspection ? await activePlacementRepairs(root, inspection) : records) {
      fail('pane-repairs', 'pane-repair-pending', `Viewer ${repair.viewer} could not be parked in pane ${repair.placed?.pane ?? repair.anchor.pane} of tab ${repair.placed?.tab ?? repair.anchor.tab}. The intended anchor was ${repair.anchor.pane}.`,
        `Park only viewer ${repair.viewer} or close its pane, then rerun doctor to clear ${placementRepairPath(root, repair)} once that pane is gone.`);
    }
  } catch (error) { fail('pane-repairs', 'pane-repair-inspection-failed', String(error), `Inspect the pane repair records at ${repairFiles.length ? repairFiles.join(', ') : repairRoot} and rerun doctor.`); }
  for (const item of DOCTOR_ITEMS) {
    try {
      const result = await parts.inspect(item, request, runtimeAvailability);
      if (!result.failures.length && !result.warnings?.length) passed++;
      failures.push(...result.failures);
      warnings.push(...result.warnings ?? []);
      information.push(...result.information ?? []);
    }
    catch (e) {
      fail(item, 'doctor-inspection-failed', e instanceof Error ? e.message : String(e), `Repair ${item} and rerun doctor --config ${request.configPath}`);
    }
  }
  const legacy = legacySpiderLayoutPath(request.config.app.home), shared = layoutSelectionPath(request.config.app.home);
  try {
    if (await hasLegacyLayout(request.config.app.home))
      fail('layout-theme', 'legacy-layout-present', `The old layout file is still present: ${legacy}`, 'Run setup to migrate it. If both layouts are present after an interrupted upgrade, use rollback --undo-upgrade first.');
  } catch (error) { fail('layout-theme', 'legacy-layout-inspection-failed', String(error), `Inspect ${legacy}.`); }
  try {
    if ((await readLayoutSelection(shared)).layout === LEGACY_SPIDER_LAYOUT)
      fail('layout-theme', 'legacy-layout-selected', `Herdr still has ${LEGACY_SPIDER_LAYOUT} selected in ${shared}`, `Run setup to migrate the layout, or select ${SPIDER_LAYOUT} in Herdr if it is already installed.`);
  } catch (error) { fail('layout-theme', 'layout-selection-inspection-failed', String(error), `Inspect ${shared}.`); }
  try {
    for (const [path, sources] of await pinnedNodePaths(request)) {
      try {
        if (!isAbsolute(path)) throw new Error('Node pin is not absolute');
        await access(path, constants.X_OK);
        const { stdout } = await promisify(execFile)(path, ['--version'], { timeout: 5000, maxBuffer: 16384 });
        if (!checkNodeVersion(stdout.trim())) throw new Error('Pinned Node does not meet the supported baseline');
        passed++;
      } catch (error) {
        fail('local-node', 'pinned-node-unavailable', `${[...new Set(sources)].join(', ')} pins ${path}: ${error instanceof Error ? error.message : String(error)}`, `Restore a supported Node at ${path}, or run setup --config ${request.configPath} from a plain shell using a supported Node to refresh the pins.`);
      }
    }
  } catch (error) {
    fail('local-node', 'pinned-node-inspection-failed', error instanceof Error ? error.message : String(error), 'Repair the installed Node pins and rerun doctor.');
  }
  try {
    const bytes = (await snapshot(request.config.core.config)).bytes;
    if (rootNotesValue(bytes) !== false)
      fail('notes', 'native-notes-enabled', 'The root notes key must be unambiguously false; existing pending tasks require fresh terminal IDs', 'Repair the root notes key, then run setup from a plain shell');
    else passed++;
  }
  catch (e) {
    fail('notes', 'native-notes-enabled', e instanceof Error ? e.message : String(e), 'Repair the selected core config without restarting the core');
  }
  try {
    const launches = await parts.launchHistory(request);
    if (launches === null) warnings.push({ item: 'launches', code: 'inspection-unavailable', message: 'Doctor could not inspect the native notification policy for all spider launches', repair: 'Run setup, start a spider pane or remote command, then rerun doctor.' });
    for (const launch of launches ?? [])
      if (launch.argv[0] === 'run' && !launch.argv.includes('--no-notify'))
        fail('launches', 'launch-notify-enabled', 'A spider launch permits native notifications', 'Update spider, then rerun setup and doctor.');
    if (launches !== null && !launches.some(launch => launch.argv[0] === 'run' && !launch.argv.includes('--no-notify'))) passed++;
  }
  catch (e) {
    fail('launches', 'launch-history-unavailable', e instanceof Error ? e.message : String(e), 'Check that Herdr is running, then rerun doctor.');
  }
  try {
    const cached = await parts.cachedNodeObservations?.(request) ?? [];
    for (const target of await parts.targets(request)) {
      if (runtimeAvailability.shouldSkip(target.machine)) continue;
      try {
        const observation = cached.find(p => p.machine === target.machine && p.nodePath === target.nodePath && p.coreStartedAt === target.coreStartedAt);
        const version = (observation?.version ?? await parts.probeMachineNode(target, probeLaunch(target))).trim();
        if (!checkRemoteNodeVersion(version))
          throw new Error(`Unsuitable Node version: ${version || 'missing'}`);
        if (!observation) probes.push({ ...target, version });
        passed++;
      }
      catch (e) {
        if (runtimeAvailability.deferOnConnectivityFailure(target.machine, e)) continue;
        fail('remote-node', 'remote-node-unavailable', `Machine ${target.machine}: ${e instanceof Error ? e.message : String(e)}`, `Configure an absolute nodePath for ${target.machine}, or install Node >=${REMOTE_NODE_MINIMUM} on its PATH`);
      }
    }
  }
  catch (e) {
    fail('remote-node', 'remote-node-unavailable', e instanceof Error ? e.message : String(e), 'Repair the machine configuration and rerun doctor');
  }
  if (parts.probeRuntimeRoot) for (const machine of request.config.machines) {
    if (runtimeAvailability.shouldSkip(machine.name)) continue;
    try {
      const bytes = (await snapshot(join(request.packageRoot, 'dist/herdr/remote-runtime.mjs'))).bytes;
      if (!bytes) throw new Error('The packaged remote runtime is missing');
      const target = { machine: machine.name, nodePath: machine.nodePath ?? 'node', coreStartedAt: '' };
      const value: unknown = JSON.parse(await parts.probeRuntimeRoot(target, { ...probeLaunch(target), argv: [target.nodePath, runtimeInstallPath(machine.runtime.directory, bytes), '--probe', machine.runtime.directory] }));
      if (!isRuntimeRootProbe(value, machine.runtime.directory)) throw new Error('Runtime root ownership, mode or Node version is invalid');
      passed++;
    } catch (error) {
      if (runtimeAvailability.deferOnConnectivityFailure(machine.name, error)) continue;
      fail('runtime-root', 'runtime-root-invalid', `Machine ${machine.name}: ${error instanceof Error ? error.message : String(error)}`, 'Repair the runtime directory ownership and mode, then rerun spider herdr setup');
    }
  }
  for (const machine of deferredRuntimes) warnings.push({ item: 'runtime', code: 'runtime-unavailable',
    message: `Runtime on ${machine} could not be verified because the machine is unreachable or its setup is pending.`,
    repair: `Run setup while ${machine} is reachable.` });
  return { failures, warnings, probes, passed, ...(information.length ? { information } : {}), ...(deferredRuntimes.size ? { deferredRuntimes: [...deferredRuntimes] } : {}) };
}

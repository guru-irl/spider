// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { HERDR_LABELS, HERDR_KINDS, type HcRunRequest } from '../contracts.js';
import { runtimeInstallPath, type ProbeTarget, type NodeObservation, type SetupRequest } from './installer.js';
import { snapshot, rootNotesValue, readJournal, managedProjection, assertGlobalRoot } from './backup.js';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isAbsolute, join } from 'node:path';
import { checkRemoteNodeVersion, REMOTE_NODE_MINIMUM, isRuntimeRootProbe } from '../remote/node-version.js';
export const DOCTOR_ITEMS = ['baseline', 'core-identity', 'hc-json', 'status-instance', 'feed-permissions', 'feed-freshness', 'ipc-authentication', 'jobs', 'observers', 'runtime-digest', 'ssh-cache', 'bypass-stripping', 'mods', 'clones', 'patch-version', 'layout-theme', 'fonts', 'pi-schema-contrast', 'keys', 'roles', 'resume', 'presence', 'mappings-leases', 'spaces-tabs', 'measurements', 'lock-adapters'] as const;
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
}
export type DoctorRequest = SetupRequest;
export interface DoctorParts {
  globalRoot?: string;
  targets(request: DoctorRequest): Promise<readonly ProbeTarget[]>;
  inspect(item: DoctorItem, request: DoctorRequest): Promise<{
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
  const layout = (await snapshot(join(request.config.app.home, 'layouts/spider-glass.json'))).bytes;
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
export async function doctorHerdr(request: DoctorRequest, parts: DoctorParts): Promise<DoctorReport> {
  try { await assertGlobalRoot(request.config.globalRoot, parts.globalRoot); }
  catch (error) { return { failures: [{ item: 'global-root', code: 'global-root-mismatch', message: error instanceof Error ? error.message : String(error), repair: `Set globalRoot to ${parts.globalRoot} in ${request.configPath}, then rerun setup or doctor.` }], warnings: [], probes: [], passed: 0 }; }
  const failures: DoctorFailure[] = [];
  const warnings: DoctorFailure[] = [];
  const information: DoctorInformation[] = [];
  const probes: NodeObservation[] = [];
  let passed = 0;
  const fail = (item: string, code: string, message: string, repair: string) => failures.push({ item, code, message, repair });
  for (const item of DOCTOR_ITEMS) {
    try {
      const result = await parts.inspect(item, request);
      if (!result.failures.length && !result.warnings?.length) passed++;
      failures.push(...result.failures);
      warnings.push(...result.warnings ?? []);
      information.push(...result.information ?? []);
    }
    catch (e) {
      fail(item, 'doctor-inspection-failed', e instanceof Error ? e.message : String(e), `Repair ${item} and rerun doctor --config ${request.configPath}`);
    }
  }
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
    if (launches === null) warnings.push({ item: 'launches', code: 'inspection-unavailable', message: 'The core has no inspectable native notification policy for spider launches', repair: 'Use a core version that exposes terminal notify policy and rerun doctor.' });
    for (const launch of launches ?? [])
      if (launch.argv[0] === 'run' && !launch.argv.includes('--no-notify'))
        fail('launches', 'launch-notify-enabled', 'A spider launch permits native notifications', 'Set noNotify:true on every spider hc run');
    if (launches !== null && !launches.some(launch => launch.argv[0] === 'run' && !launch.argv.includes('--no-notify'))) passed++;
  }
  catch (e) {
    fail('launches', 'launch-history-unavailable', e instanceof Error ? e.message : String(e), 'Repair the launch audit and rerun doctor');
  }
  try {
    const cached = await parts.cachedNodeObservations?.(request) ?? [];
    for (const target of await parts.targets(request)) {
      try {
        const observation = cached.find(p => p.machine === target.machine && p.nodePath === target.nodePath && p.coreStartedAt === target.coreStartedAt);
        const version = (observation?.version ?? await parts.probeMachineNode(target, probeLaunch(target))).trim();
        if (!checkRemoteNodeVersion(version))
          throw new Error(`Unsuitable Node version: ${version || 'missing'}`);
        if (!observation) probes.push({ ...target, version });
        passed++;
      }
      catch (e) {
        fail('remote-node', 'remote-node-unavailable', `Machine ${target.machine}: ${e instanceof Error ? e.message : String(e)}`, `Configure an absolute nodePath for ${target.machine}, or install Node >=${REMOTE_NODE_MINIMUM} on its PATH`);
      }
    }
  }
  catch (e) {
    fail('remote-node', 'remote-node-unavailable', e instanceof Error ? e.message : String(e), 'Repair the machine configuration and rerun doctor');
  }
  if (parts.probeRuntimeRoot) for (const machine of request.config.machines) {
    try {
      const bytes = (await snapshot(join(request.packageRoot, 'dist/herdr/remote-runtime.mjs'))).bytes;
      if (!bytes) throw new Error('The packaged remote runtime is missing');
      const target = { machine: machine.name, nodePath: machine.nodePath ?? 'node', coreStartedAt: '' };
      const value: unknown = JSON.parse(await parts.probeRuntimeRoot(target, { ...probeLaunch(target), argv: [target.nodePath, runtimeInstallPath(machine.runtime.directory, bytes), '--probe', machine.runtime.directory] }));
      if (!isRuntimeRootProbe(value, machine.runtime.directory)) throw new Error('Runtime root ownership, mode or Node version is invalid');
      passed++;
    } catch (error) {
      fail('runtime-root', 'runtime-root-invalid', `Machine ${machine.name}: ${error instanceof Error ? error.message : String(error)}`, 'Repair the runtime directory ownership and mode, then rerun spider herdr setup');
    }
  }
  return { failures, warnings, probes, passed, ...(information.length ? { information } : {}) };
}

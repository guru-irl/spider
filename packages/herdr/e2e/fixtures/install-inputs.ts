// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { cp, mkdir, readFile, writeFile, rm, lstat, readdir, readlink } from 'node:fs/promises';
import { appendFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { HarnessError } from '../harness/environment.js';
import { runSetup, readInstalled, type Installed, type SetupResult } from '../harness/setup.js';
import { deadline } from '../harness/wait.js';
import { spawnOwned, type OwnedProcess } from '../harness/processes.js';
import { identityAlive, processStart } from '../harness/resources.js';
import { writeScript } from '../harness/pi.js';
import type { Suite, AppDriver } from '../harness/suite.js';
import type { PackedBuild } from '../harness/pack.js';
import type { HerdrConfig } from '../../src/contracts.js';
import { parseHerdrConfig } from '../../src/config.js';
import { remoteInstallOptions, validateRemoteInstallInputs } from './remote-install-inputs.js';
import type { ScriptFile } from './scripted-provider.js';

export const fixtureRoles = { worker: 'e2e-fixture/scripted:high', reviewer: 'e2e-fixture/scripted:high', watcher: 'e2e-fixture/scripted:low' } as const;
export interface InstallOptions {
  /** Read only the known base mods and main layout. Never read settings, keys, credentials or themes. */
  baseAppHome?: string;
  spaces?: HerdrConfig['spaces'];
  machines?: HerdrConfig['machines'];
  roles?: Readonly<Record<string, string>>;
}
export interface InstallInputs { suite: Suite; config: HerdrConfig & Record<string, unknown>; app: AppDriver }
export interface FreshInstallation extends InstallInputs { result: SetupResult; installed: Installed }
export function installationConfig(suite: Suite, appBinary: string): HerdrConfig & Record<string, unknown> {
  if (!suite.cores) throw new HarnessError('missing-prerequisite', 'installation needs real isolated cores');
  return { ...parseHerdrConfig({
    enabled: true, app: { binary: appBinary, home: suite.directories.HERDR_APP_HOME },
    core: { binary: suite.cores.wrapper, config: join(suite.directories.XDG_CONFIG_HOME, 'herdr-core/config.toml') },
    agentDirectory: suite.directories.PI_CODING_AGENT_DIR, globalRoot: suite.directories.SPIDER_GLOBAL_ROOT,
    shellRc: join(suite.root, 'rc'), spaces: [],
    machines: [{ name: suite.cores.machine, aliases: ['route.invalid'], inUse: true, nodePath: process.execPath,
      runtime: { directory: join(suite.root, 'r'), cwd: join(suite.root, 'dwork'), commands: { shell: ['/bin/sh'], javascript: [process.execPath] } } }],
    limits: { auxiliaryPanes: 2, completedRows: 50, completedHours: 24 }, retention: { foregroundDays: 7 }, admin: { wrappers: [] },
  }) };
}
async function copyBaseAssets(suite: Suite, source: string): Promise<void> {
  const app = suite.directories.HERDR_APP_HOME;
  for (const name of ['agents', 'spaces', 'pane', 'tabs', 'workspace-chrome']) {
    const from = join(source, 'mods', name), to = suite.ownPath(join(app, 'mods', name));
    try { await lstat(join(from, 'mod.json')); } catch { throw new HarnessError('missing-prerequisite', `known shipped base mod ${name} is unavailable`); }
    await mkdir(to, { recursive: true });
    // Copy only upstream code, metadata and icons. Declaration files are not runtime assets.
    await cp(from, to, { recursive: true, filter: path => !path.endsWith('.d.ts') && !path.endsWith('jsconfig.json') });
  }
  await mkdir(join(app, 'layouts'), { recursive: true });
  await cp(join(source, 'layouts/main.json'), suite.ownPath(join(app, 'layouts/main.json')));
}
/** Supplies external input, not setup output. Installed mods, runtime and feeds remain absent. */
export async function prepareInstallInputs(original: Suite, options: InstallOptions = {}): Promise<InstallInputs> {
  if (!original.cores) throw new HarnessError('missing-prerequisite', 'installation needs real isolated cores');
  if (original.options.tier === 'remote' && !options.machines) throw new HarnessError('P3-remote-install-inputs', 'Tier 2 requires operator-supplied owned remote machine inputs; the default dest.invalid fixture is local');
  if (original.options.tier === 'remote') await validateRemoteInstallInputs(original, options.machines!);
  if (original.options.tier === 'app') throw new HarnessError('P2-native-install-slot', 'native first installation must run in the opt-in app window batch');
  const root = original.root;
  await copyBaseAssets(original, options.baseAppHome ?? join(userInfo().homedir, '.config/herdr-app'));
  await mkdir(join(root, 'dwork'), { recursive: true });
  const app = await original.app();
  if (!original.appConnection) throw new HarnessError('missing-adapter', 'suite app has no CLI connection');
  const env = { ...original.env, ...original.appConnection.env };
  Object.assign(original.cores.local.env, env); Object.assign(original.pi.env, env);
  const suite = { ...original, env };
  const config = installationConfig(suite, original.appConnection.binary);
  if (options.spaces) config.spaces = options.spaces;
  if (options.machines) config.machines = options.machines;
  const globalConfig = join(config.globalRoot, 'config.json');
  const previous = JSON.parse(await readFile(globalConfig, 'utf8'));
  await writeFile(globalConfig, JSON.stringify({ ...previous, 'models.defaults': options.roles ?? fixtureRoles, 'herdr.enabled': true, 'herdr.config': join(config.globalRoot, 'herdr/config.json') }), { mode: 0o600 });
  return { suite, config, app };
}
export async function installFresh(suite: Suite, options: InstallOptions = {}): Promise<FreshInstallation> {
  const inputs = await prepareInstallInputs(suite, { ...await remoteInstallOptions(suite), ...options });
  const absent = ['agents', 'spaces', 'pane', 'tabs', 'panel', 'machines'].map(name => join(inputs.config.app.home, 'mods', `spider-${name}`));
  absent.push(join(inputs.config.app.home, 'layouts/spider-glass.json'), join(suite.root, 'r'));
  for (const path of absent) {
    const info = await lstat(path).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (info) throw new HarnessError('installation-not-fresh', path);
  }
  await suite.evidence('fresh-paths.json', { absent });
  const result = await runSetup(inputs.suite, inputs.config); await suite.evidence('setup.json', result);
  if (result.exitCode !== 0) {
    if (result.stderr.includes('setup-verification-failed')) {
      const doctor = await inputs.suite.invoke(process.execPath, [suite.packed.cli, 'doctor', '--config', result.configPath], inputs.suite.env);
      await suite.evidence('failed-setup-doctor.json', doctor);
    }
    throw new HarnessError('fresh-setup-failed', result.stderr || result.stdout, result);
  }
  return { ...inputs, result, installed: await readInstalled(inputs.suite) };
}
/** Break only a disposable copy, never the worker's build or a shared packed root. */
export async function brokenPackedCopy(suite: Suite, kind: 'runtime' | 'helper'): Promise<PackedBuild> {
  const root = suite.ownPath(join(suite.root, `bad-${kind}`));
  await cp(suite.packed.root, root, { recursive: true, verbatimSymlinks: true });
  const missing = join(root, kind === 'runtime' ? 'dist/herdr/remote-runtime.mjs' : 'packages/herdr/assets/shared/feed.js');
  await rm(missing);
  return { ...suite.packed, root, extension: join(root, 'dist/extension.js') as PackedBuild['extension'], cli: join(root, 'dist/herdr/cli.mjs') as PackedBuild['cli'], viewer: join(root, 'dist/herdr/viewer.mjs') as PackedBuild['viewer'], remoteRuntime: join(root, 'dist/herdr/remote-runtime.mjs') as PackedBuild['remoteRuntime'] };
}
export interface RunningSetup { process: OwnedProcess; configPath: string; stdout: string; stderr: string }
export async function startPlainSetup(suite: Suite, config: HerdrConfig): Promise<RunningSetup> {
  const configPath = suite.ownPath(join(config.globalRoot, 'herdr/config.json'));
  await mkdir(join(config.globalRoot, 'herdr'), { recursive: true, mode: 0o700 });
  await writeFile(configPath, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  const stdout = suite.ownPath(join(suite.root, 'setup.out')), stderr = suite.ownPath(join(suite.root, 'setup.err'));
  await writeFile(stdout, '', { mode: 0o600 }); await writeFile(stderr, '', { mode: 0o600 });
  const process = spawnOwned(suite.ledger, { label: 'interruptible-setup', command: globalThis.process.execPath, args: [suite.packed.cli, 'setup', '--config', configPath], env: { ...suite.env }, cwd: suite.root, stdio: 'pipe', stderrLog: stderr });
  process.child.stdout!.on('data', bytes => appendFileSync(stdout, bytes)); process.child.stdin!.end();
  return { process, configPath, stdout, stderr };
}
export async function readPresence(suite: Suite): Promise<Record<string, unknown>[]> {
  const directory = suite.ownPath(join(suite.directories.SPIDER_GLOBAL_ROOT, 'herdr/processes'));
  const files = await readdir(directory).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
  const result: Record<string, unknown>[] = [];
  for (const file of files.filter(f => f.endsWith('.json'))) {
    // A process removes its presence file when it exits, which can happen between the listing and this read.
    const text = await readFile(suite.ownPath(join(directory, file)), 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (text !== null) result.push(JSON.parse(text));
  }
  return result;
}
export async function stopCreatedOwners(suite: Suite, sessionIds: readonly string[]): Promise<void> {
  for (const presence of await readPresence(suite)) {
    if (!sessionIds.includes(String(presence.sessionId)) || typeof presence.pid !== 'number') continue;
    const start = processStart(presence.pid); if (start === null) continue;
    const registered = await readFile(suite.ownPath(join(suite.root, 'procs', `${presence.pid}.json`)), 'utf8').then(JSON.parse).catch(() => null);
    if (!registered || registered.version !== 1 || registered.pid !== presence.pid) throw new HarnessError('owner-identity-unproved', 'presence has no actual fixture-domain registration');
    let token = `posix:${start}`;
    if (process.platform === 'linux') {
      const stat = await readFile(`/proc/${presence.pid}/stat`, 'utf8'), ticks = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
      if (!ticks || !/^\d+$/.test(ticks)) throw new HarnessError('owner-identity-unproved', 'current Linux start identity is unavailable');
      token = `linux:${ticks}`;
    }
    if (presence.startIdentity !== token || registered.start !== token) throw new HarnessError('owner-identity-unproved', 'presence or fixture registration differs from the actual PID start');
    const identity = { pid: presence.pid, start };
    suite.ledger.update(ledger => { ledger.processes.push({ ...identity, label: 'cutover-owner', group: false }); });
    if (identityAlive(identity)) globalThis.process.kill(identity.pid, 'SIGTERM');
  }
}
export interface FileFingerprint { path: string; sha256: string | null; mtimeMs: number | null; symlink?: string }
export async function fingerprintInstallation(suite: Suite, config: HerdrConfig): Promise<FileFingerprint[]> {
  const result: FileFingerprint[] = [];
  const roots = [join(config.app.home, 'mods'), join(config.app.home, 'layouts'), join(config.app.home, 'themes'), join(config.app.home, 'fonts'), join(config.app.home, 'settings.json'), join(config.app.home, 'keys.json'), join(config.agentDirectory, 'themes'), join(config.agentDirectory, 'settings.json'), join(config.globalRoot, 'herdr/setup'), join(config.globalRoot, 'herdr/instructions'), join(config.globalRoot, 'herdr/resume.sh'), join(config.globalRoot, 'herdr/spaces'), join(config.globalRoot, 'config.json'), join(config.globalRoot, 'herdr/config.json'), join(config.globalRoot, 'herdr/spaces'), config.shellRc, config.core.config, join(config.core.config, '../templates')];
  const directoryRoots = new Set<string>([join(config.app.home, 'mods'), join(config.app.home, 'layouts'), join(config.app.home, 'themes'), join(config.app.home, 'fonts'), join(config.agentDirectory, 'themes'), join(config.globalRoot, 'herdr/setup'), join(config.globalRoot, 'herdr/instructions'), join(config.globalRoot, 'herdr/spaces'), join(config.core.config, '../templates')].map(path => suite.ownPath(path)));
  const visited = new Set<string>();
  const walk = async (path: string): Promise<void> => {
    path = suite.ownPath(path); if (visited.has(path)) return; visited.add(path);
    const info = await lstat(path).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (!info) { if (!directoryRoots.has(path)) result.push({ path, sha256: null, mtimeMs: null }); return; }
    if (info.isSymbolicLink()) { result.push({ path, sha256: null, mtimeMs: info.mtimeMs, symlink: await readlink(path) }); return; }
    if (info.isDirectory()) { for (const name of (await readdir(path)).sort()) await walk(join(path, name)); return; }
    result.push({ path, sha256: createHash('sha256').update(await readFile(path)).digest('hex'), mtimeMs: info.mtimeMs });
  };
  for (const root of roots) await walk(root);
  return result.sort((a, b) => a.path.localeCompare(b.path));
}
export interface NamedSession { name: string; sessionId: string; file: string; cwd: string; marker: string }
export async function createNamedSession(suite: Suite, name: string, cwd: string, marker: string): Promise<NamedSession> {
  const script = JSON.parse(await readFile(suite.pi.scriptPath, 'utf8')) as ScriptFile;
  script.scripts[marker] = [{ steps: [{ text: `Saved conversation ${marker}.` }] }];
  await writeScript(suite.pi.scriptPath, script);
  const pi = await suite.launchPi({ mode: 'rpc', cwd, label: `seed-${marker}`, extraEnv: { PI_CODING_AGENT_SESSION_DIR: join(suite.directories.PI_CODING_AGENT_DIR, 'sessions') } });
  if (pi.mode !== 'rpc') throw new Error('session creation requires RPC');
  const start = await pi.waitEvent('session_start', () => true, deadline(30_000));
  await pi.prompt(`[[e2e:${marker}]] Original conversation ${marker}.`);
  await pi.rpc({ type: 'set_session_name', name });
  const state = await pi.rpc({ type: 'get_state' });
  await suite.evidence(`session-${marker}.json`, { start, state });
  await pi.close();
  if (typeof start.sessionFile !== 'string' || typeof start.sessionId !== 'string') throw new HarnessError('session-not-persisted', 'real pi did not allocate a session file');
  const file = suite.ownPath(start.sessionFile);
  const saved = await readFile(file, 'utf8');
  if (!saved.includes(marker)) throw new HarnessError('session-content-missing', 'real prompt was not saved');
  return { name, sessionId: start.sessionId, file, cwd, marker };
}
export async function installInPiSetupCommand(suite: Suite, configPath: string): Promise<string> {
  const path = suite.ownPath(join(suite.root, 'inside-pi-setup.mjs'));
  await writeFile(path, `export default function(pi) {\npi.registerCommand('fixture-in-pi-setup', {description:'Owned plain-shell guard proof', handler:async()=> {\nprocess.argv=[process.execPath,${JSON.stringify(suite.packed.cli)},'setup','--config',${JSON.stringify(suite.ownPath(configPath))}];\nawait import(${JSON.stringify(suite.packed.cli)});\n}});\n}\n`, { mode: 0o600 });
  const settingsPath = join(suite.directories.PI_CODING_AGENT_DIR, 'settings.json');
  const settings = JSON.parse(await readFile(settingsPath, 'utf8'));
  await writeFile(settingsPath, JSON.stringify({ ...settings, packages: [...settings.packages, path] }), { mode: 0o600 });
  return path;
}
export async function installPromptObserver(suite: Suite): Promise<string> {
  const path = suite.ownPath(join(suite.root, 'install-observer.mjs'));
  const log = suite.ownPath(join(suite.root, 'install-events.jsonl'));
  const source = `import { appendFileSync } from 'node:fs';\nexport default function(pi) {\n const record = (value) => appendFileSync(${JSON.stringify(log)}, JSON.stringify({at:Date.now(), pid:process.pid, ...value})+'\\n', {mode:0o600});\n pi.on('session_start', (_event, ctx) => { record({type:'role-start', mode:ctx.mode, model:ctx.model ? ctx.model.provider+'/'+ctx.model.id : null, thinking:pi.getThinkingLevel(), sessionId:ctx.sessionManager.getSessionId()}); });\n pi.on('before_agent_start', (event) => { record({type:'effective-prompt', systemPrompt:event.systemPrompt, prompt:event.prompt}); });\n}\n`;
  await writeFile(path, source, { mode: 0o600 });
  const settingsPath = join(suite.directories.PI_CODING_AGENT_DIR, 'settings.json');
  const settings = JSON.parse(await readFile(settingsPath, 'utf8'));
  await writeFile(settingsPath, JSON.stringify({ ...settings, packages: [...settings.packages, path] }), { mode: 0o600 });
  return log;
}
export const firstRemoteScripts: Omit<ScriptFile, 'story'> = { scripts: {
  'first-parent': [
    { steps: [{ tool: { id: 'first-parent-exec', name: 'spider', arguments: { action: 'exec', language: 'shell', on: 'dest.invalid', code: "printf 'first-parent-out\\n'; printf 'first-parent-err\\n' >&2; exit 23" } } }] },
    { steps: [{ tool: { id: 'first-child-run', name: 'spider', arguments: { action: 'run', agent: 'worker', name: 'first-child', task: '[[e2e:first-child]] Work inline, no subagents.', model: 'e2e-fixture/scripted', thinking: 'low' } } }] },
    { steps: [{ text: 'Parent fixture turn settled.' }] },
    { steps: [{ text: 'Parent observed child completion.' }] },
  ],
  'first-child': [
    { steps: [{ tool: { id: 'first-child-exec', name: 'spider', arguments: { action: 'exec', language: 'shell', on: 'dest.invalid', code: "printf 'first-child-out\\n'; printf 'first-child-err\\n' >&2; exit 29" } } }] },
    { steps: [{ text: 'Child fixture completed remote command.' }] },
  ],
} };

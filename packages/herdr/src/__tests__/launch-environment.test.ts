// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { existsSync, readdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import type { Generation, Owner, SessionId, TerminalIdentity } from '../contracts.js';
import { createTerminalRegistry, terminalIdentityKey, readRecordedLaunch } from '../sessions/registry.js';
import { createProcessPresence } from '../sessions/presence.js';
import { createSessionLeases, type ProcessInventoryPorts } from '../sessions/lease.js';
import { launchSession, type PiSpawnRequest, type SessionLaunchPorts } from '../sessions/launcher.js';
import { offerResume, resumeOfferShell } from '../sessions/resume.js';
import { registerHerdrSessions } from '../sessions/register.js';
import type { RecordedLaunch } from '../sessions/launch-environment.js';

const disk = vi.hoisted(() => ({ fail: '', events: [] as string[] }));
vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>();
  return { ...actual,
    rename: async (from: string, to: string) => {
      if (disk.fail && to.includes(disk.fail)) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
      await actual.rename(from, to); disk.events.push('rename:' + to);
    },
    open: async (...args: Parameters<typeof actual.open>) => {
      if (disk.fail && args[1] === 'wx' && String(args[0]).includes(disk.fail)) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
      const handle = await actual.open(...args), sync = handle.sync.bind(handle);
      handle.sync = async () => { await sync(); disk.events.push('sync:' + String(args[0])); };
      return handle;
    },
  };
});

let root: string, file: string, agent: string, owner: Owner, terminal: TerminalIdentity;
let inventory: ProcessInventoryPorts, ports: SessionLaunchPorts, launches: PiSpawnRequest[];
const activityId = '0123456789abcdef0123456789abcdef';
// Never put credential values in assertion diagnostics, even for these synthetic fixtures.
const credential = () => 'ghp' + '_' + 'synthetic'.padEnd(39, '0');
function launch(argv = ['--tools', 'read,spider', '--name', 'original', '--model', 'provider/old', '--thinking', 'medium']) {
  return { program: process.execPath, argv, cwd: root, variables: { SERVICE_ROUTER: '1', PI_INTERCOM_STABLE_ID: 'stable-router', API_TOKEN: credential(), HC_TERMINAL_ID: 'stale-terminal', TERM: 'stale-term', TMPDIR: '/stale-tmp', SPIDER_HERDR_LEASE_TOKEN: 'stale-lease' } };
}
function keyLaunch(argv: string[]) { return { ...launch(argv), model: { provider: 'provider', modelId: 'old' } }; }
function mapping() { return { owner, recordedAt: 10, coreStartedAt: 1, environment: { agentDirectory: agent, extensionArguments: [] as string[] }, activityId }; }
function request() { return { sessionFile: file, sessionId: owner.sessionId, cwd: root, environment: { agentDirectory: join(root, 'fallback-agent'), extensionArguments: [] } }; }
function secretDirectory() { return join(agent, 'spider', 'herdr', 'launch-environments'); }
function secretPath() { return join(secretDirectory(), (existsSync(secretDirectory()) ? readdirSync(secretDirectory()) : []).find(name => name.endsWith('.json')) ?? terminalIdentityKey(terminal) + '.json'); }
async function record(snapshot: RecordedLaunch = launch()) {
  await createTerminalRegistry(root).record({ ...mapping(), ...{ launch: snapshot } }, { pid: 2147483647, startIdentity: 'old' });
}
function offerPorts(auto: boolean) { return { registry: createTerminalRegistry(root), processInventory: inventory, coreStartedAt: async () => 20, ...(auto ? { autoResumeRoot: root } : {}) }; }
function resumePorts() { return { ...ports, ...{ resume: { registry: createTerminalRegistry(root), terminal } } }; }
beforeEach(async () => {
  disk.fail = ''; disk.events = [];
  root = await mkdtemp(join(await realpath(tmpdir()), 'lenv-')); file = join(root, 'session.jsonl'); agent = join(root, 'agent');
  terminal = { coreId: 'core', terminalId: 'terminal', address: 'terminal', socket: join(root, 'core.sock'), sessionNamespace: 'fixture' } as TerminalIdentity;
  owner = { sessionId: 'saved' as SessionId, generation: 'generation' as Generation, terminal, sessionFile: file, cwd: root, name: 'current name' };
  await writeFile(file, [
    { type: 'session', version: 3, id: 'saved', cwd: root },
    { type: 'model_change', id: 'model', parentId: null, provider: 'provider', modelId: 'current' },
    { type: 'thinking_level_change', id: 'thinking', parentId: 'model', thinkingLevel: 'high' },
    { type: 'session_info', id: 'info', parentId: 'thinking', name: 'current name' },
  ].map(value => JSON.stringify(value)).join('\n') + '\n');
  inventory = { presence: createProcessPresence(root), leases: createSessionLeases(root), processes: async () => [], probe: async () => ({ kind: 'absent' }) };
  launches = [];
  ports = { leases: inventory.leases, processInventory: inventory, processIdentity: { pid: 101, startIdentity: 'launcher' }, env: { HC_TERMINAL_ID: 'current-terminal', TERM: 'current-term', TMPDIR: '/current-tmp', CURRENT_ONLY: 'keep', API_TOKEN: 'current-token' }, spawnPi: async value => { launches.push(value); return { pid: 102, startIdentity: 'resumed' }; } };
});
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });

it.each([false, true])('%s resume restores launch variables and tools without resetting session state', async auto => {
  await record();
  const offer = await offerResume(terminal, offerPorts(auto));
  expect(offer?.argv).toEqual([process.execPath, '--tools', 'read,spider', '--session', file]);
  await launchSession(request(), resumePorts());
  const resumed = launches[0];
  expect(resumed.argv).toEqual([process.execPath, '--tools', 'read,spider', '--session', file]);
  expect(resumed.env.API_TOKEN === credential()).toBe(true);
  const expectedVariables = { SERVICE_ROUTER: '1', PI_INTERCOM_STABLE_ID: 'stable-router', HC_TERMINAL_ID: 'current-terminal', TERM: 'current-term', TMPDIR: '/current-tmp', CURRENT_ONLY: 'keep', PI_CODING_AGENT_DIR: agent };
  expect(Object.entries(expectedVariables).filter(([name, value]) => resumed.env[name] !== value).map(([name]) => name)).toEqual([]);
  expect(resumed.env.SPIDER_HERDR_LEASE_TOKEN === 'stale-lease').toBe(false);
  expect((await readFile(file, 'utf8')).includes('"modelId":"current"')).toBe(true);
});

const terminalVariables = ['HC_SESSION', 'HC_SOCKET', 'HC_TERMINAL_SOCKET', 'HERDR_APP_HOME', 'TERM_SESSION_ID', 'SHLVL', 'PWD', 'OLDPWD', '_', 'SSH_AUTH_SOCK', 'TMPDIR', 'XPC_SERVICE_NAME', '__CF_USER_TEXT_ENCODING', 'SECURITYSESSIONID', 'LaunchInstanceID', 'TERM', 'COLORTERM', 'TERM_PROGRAM', 'TERM_PROGRAM_VERSION', 'PI_SESSION_ID', 'PI_SESSION_FILE', 'PI_PROVIDER', 'PI_MODEL', 'PI_REASONING_LEVEL', 'PI_SPIDER_SESSION_ID', 'PI_SPIDER_DB_PATH', 'PI_SPIDER_TOP_SESSION_ID', 'PI_SUBAGENT_CHILD', 'PI_INTERCOM_SESSION_ID', 'SPIDER_HERDR_SSH_DESCRIPTOR', 'TERMINFO', 'TERMINFO_DIRS', 'SSH_AGENT_PID', 'SSH_CONNECTION', 'SSH_CLIENT', 'SSH_TTY', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS', 'DISPLAY', 'WAYLAND_DISPLAY', 'TMUX', 'TMUX_PANE', 'STY', 'WINDOW', 'WINDOWID', 'ITERM_SESSION_ID', 'WT_SESSION', 'WEZTERM_PANE', 'SPIDER_TOOL_NAME', 'SPIDER_PARAMETERS', 'SPIDER_VIEWER_PI_ROOT'];
it('keeps current terminal, boot, login and per-process variables instead of stale launch values', async () => {
  const variables = Object.fromEntries(terminalVariables.map(name => [name, 'stale']));
  await record({ ...launch([]), variables });
  const current = Object.fromEntries(terminalVariables.map(name => [name, 'current']));
  await launchSession(request(), { ...resumePorts(), env: current });
  expect(terminalVariables.filter(name => launches[0].env[name] !== 'current')).toEqual([]);
});

it('does not resurrect a denylisted variable absent in the resume shell', async () => {
  await record({ ...launch([]), variables: { HC_OBSOLETE: 'stale', XPC_OBSOLETE: 'stale', __CF_OBSOLETE: 'stale', PI_SUBAGENT_RUN_ID: 'stale' } });
  await launchSession(request(), resumePorts());
  expect(['HC_OBSOLETE', 'XPC_OBSOLETE', '__CF_OBSOLETE', 'PI_SUBAGENT_RUN_ID'].filter(name => launches[0].env[name] !== undefined)).toEqual([]);
});

it('preserves every valid environment name and empty or multiline launch values', async () => {
  const variables = Object.fromEntries([['__proto__', 'synthetic-prototype-name'], ['CUSTOM.KEY', 'first line\nsecond line'], ['EMPTY_SETTING', '']]);
  await record({ ...launch([]), variables });
  await launchSession(request(), resumePorts());
  expect(Object.hasOwn(launches[0].env, '__proto__')).toBe(true);
  expect(Object.entries(variables).every(([name, value]) => launches[0].env[name] === value)).toBe(true);
});

it('preserves an explicitly recorded agent-directory variable rather than its canonical spelling', async () => {
  const original = agent + '/.';
  await record({ ...launch([]), variables: { PI_CODING_AGENT_DIR: original } });
  await launchSession(request(), resumePorts());
  expect(launches[0].env.PI_CODING_AGENT_DIR === original).toBe(true);
});

it('never replays positional prompts, attachments, or anything after the option delimiter', async () => {
  await record(launch(['initial message', '@secret.txt', '--tools', 'read', '--', '--tools', 'bash', 'another message', '@other.txt']));
  await launchSession(request(), resumePorts());
  expect(launches[0].argv).toEqual([process.execPath, '--tools', 'read', '--session', file]);
});

it('keeps extension flag equals values from becoming prompts or options', async () => {
  await record(launch(['--extension-setting=@not-an-attachment', '--extension-option=--not-an-option', '--tools', 'read', 'initial message']));
  await launchSession(request(), resumePorts());
  expect(launches[0].argv).toEqual([process.execPath, '--extension-setting=@not-an-attachment', '--extension-option=--not-an-option', '--tools', 'read', '--session', file]);
});

it('drops every session selector and persisted state flag, including aliases and equals forms', async () => {
  await record(launch(['-c', '--continue', '-r', '--resume', '--session', 'old.jsonl', '--session-id', 'old-id', '--fork', 'old-fork', '--no-session', '-n', 'old name', '--name=old', '--provider', 'old-provider', '--model=old-model', '--thinking', 'low', '--tools', 'read']));
  await launchSession(request(), resumePorts());
  expect(launches[0].argv).toEqual([process.execPath, '--tools', 'read', '--session', file]);
});

it('replays process-only tools, resource, prompt, trust and extension-defined flags', async () => {
  const argv = ['-t', '+spider,-bash', '-xt', 'write', '-nbt', '--models', 'provider/*', '--session-dir', 'sessions', '--system-prompt', 'instructions', '--append-system-prompt', 'extra instructions', '--skill', 'skill.md', '-ns', '--prompt-template', 'prompt.md', '-np', '--theme', 'theme.json', '--use-theme', 'night', '--no-themes', '-nc', '--tui-mode', 'regular', '--verbose', '-a', '--offline', '--no-mcp', '--extension-option', 'configured value', '--extension-switch'];
  await record(launch(argv));
  await launchSession(request(), resumePorts());
  const expected = [...argv];
  for (const flag of ['--session-dir', '--skill', '--prompt-template', '--theme']) expected[expected.indexOf(flag) + 1] = join(root, expected[expected.indexOf(flag) + 1]);
  expect(launches[0].argv).toEqual([process.execPath, ...expected, '--session', file]);
});

it.each([['-p'], ['--print'], ['--mode', 'rpc'], ['--mode', 'json'], ['--export', 'session.jsonl'], ['--help'], ['--version'], ['--list-models']].map(argv => ({ argv })))('never launches a noninteractive recorded invocation: $argv', async ({ argv }) => {
  await record(launch(argv));
  await expect(launchSession(request(), resumePorts())).rejects.toMatchObject({ code: 'session-not-interactive' });
  expect(launches).toHaveLength(0);
});

it('pairs an API key only with the session current provider-qualified model', async () => {
  await record(keyLaunch(['--model', 'provider/old', '--api-key', credential(), '--tools', 'read']));
  await launchSession(request(), resumePorts());
  const argv = launches[0].argv.map(value => value === credential() ? '<redacted>' : value);
  expect(argv).toEqual([process.execPath, '--api-key', '<redacted>', '--tools', 'read', '--model', 'provider/current', '--session', file]);
});

it('refuses a changed API-key provider with an exact manual command and no credential value', async () => {
  await record(keyLaunch(['--model', 'provider/old', '--api-key', credential(), '--tools', 'read']));
  await writeFile(file, (await readFile(file, 'utf8')).replace('"provider":"provider"', '"provider":"other"'));
  for (const action of [() => offerResume(terminal, offerPorts(true)), () => launchSession(request(), resumePorts())]) {
    let failure: unknown;
    try { await action(); } catch (error) { failure = error; }
    expect(failure).toMatchObject({ code: 'session-key-provider-changed' });
    const notice = String(failure);
    expect(notice.includes(credential())).toBe(false);
    expect(notice).toContain('provider');
    expect(notice).toContain('other');
    expect(notice).toContain(`cd -- '${root}' && '${process.execPath}' '--session' '${file}' '--model' 'other/current' '--api-key' '<API_KEY>'`);
  }
  expect(launches).toHaveLength(0);
  expect(await inventory.leases.get(file)).toBeNull();
});

it('does not echo unrelated private launch flags in an API-key provider refusal', async () => {
  const privateValue = 'synthetic-private-option';
  await record({ ...keyLaunch(['--model', 'provider/old', '--api-key', credential(), '--service-token', privateValue]), variables: { SERVICE_TOKEN: privateValue } });
  await writeFile(file, (await readFile(file, 'utf8')).replace('"provider":"provider"', '"provider":"other"'));
  let notice = '';
  try { await launchSession(request(), resumePorts()); } catch (error) { notice = String(error); }
  expect(launches).toHaveLength(0);
  expect(notice.includes('API_KEY')).toBe(true);
  expect(notice.includes(privateValue)).toBe(false);
});

it('uses the original launch model with an API key when the session has no model', async () => {
  await writeFile(file, JSON.stringify({ type: 'session', version: 3, id: 'saved', cwd: root }) + '\n');
  await record(keyLaunch(['--model', 'provider/old:high', '--api-key', credential()]));
  await launchSession(request(), resumePorts());
  const argv = launches[0].argv.map(value => value === credential() ? '<redacted>' : value);
  expect(argv).toEqual([process.execPath, '--api-key', '<redacted>', '--model', 'provider/old', '--session', file]);
});

it('uses the recorded default model provider to check an API key without an original model flag', async () => {
  await record({ ...launch(['--api-key', credential()]), ...{ model: { provider: 'default-provider', modelId: 'default-model' } } });
  await expect(launchSession(request(), resumePorts())).rejects.toMatchObject({ code: 'session-key-provider-changed' });
  expect(launches).toHaveLength(0);
});

it('uses the active session branch rather than an abandoned model change for key pairing', async () => {
  await record(keyLaunch(['--model', 'provider/old', '--api-key', credential()]));
  const entries = [
    { type: 'model_change', id: 'abandoned', parentId: 'info', provider: 'other', modelId: 'abandoned' },
    { type: 'custom', id: 'leaf', parentId: 'info', customType: 'fixture', data: null },
  ];
  await writeFile(file, await readFile(file, 'utf8') + entries.map(value => JSON.stringify(value)).join('\n') + '\n');
  await launchSession(request(), resumePorts());
  expect(launches[0].argv.includes('provider/current')).toBe(true);
  expect(launches[0].argv.includes('other/abandoned')).toBe(false);
});

it('keeps the selected model when an assistant response names a routed physical model', async () => {
  await record(keyLaunch(['--model', 'provider/old', '--api-key', credential()]));
  const response = { type: 'message', id: 'response', parentId: 'info', message: { role: 'assistant', provider: 'physical-provider', model: 'physical-model', content: [] } };
  await writeFile(file, await readFile(file, 'utf8') + JSON.stringify(response) + '\n');
  await launchSession(request(), resumePorts());
  expect(launches[0].argv.includes('provider/current')).toBe(true);
  expect(launches[0].argv.some(value => value.includes('physical-provider'))).toBe(false);
});

it('does not treat a routed physical response as evidence that the selected key provider stayed the same', async () => {
  await record(keyLaunch(['--model', 'provider/old', '--api-key', credential()]));
  const response = { type: 'message', id: 'response', parentId: 'info', message: { role: 'assistant', provider: 'provider', model: 'physical-model', content: [] } };
  await writeFile(file, (await readFile(file, 'utf8')).replace('"provider":"provider"', '"provider":"other"') + JSON.stringify(response) + '\n');
  let failure: unknown;
  try { await launchSession(request(), resumePorts()); } catch (error) { failure = error; }
  expect(failure).toMatchObject({ code: 'session-key-provider-changed' });
  expect(launches).toHaveLength(0);
});

it.each(['offer', 'launch'])('%s checks live ownership before opening a session to read its API-key model', async mode => {
  await record(keyLaunch(['--model', 'provider/old', '--api-key', credential()]));
  await inventory.presence.record({ pid: 900, startIdentity: 'live-owner', sessionId: owner.sessionId, sessionFile: file, sessionName: owner.name, kind: 'top-level', hcAddress: terminal.address });
  inventory.probe = async pid => pid === 900 ? { kind: 'live', startIdentity: 'live-owner' } : { kind: 'absent' };
  await rm(file); await symlink(join(root, 'missing-target'), file);
  if (mode === 'offer') expect(await offerResume(terminal, offerPorts(false))).toBeNull();
  else await expect(launchSession(request(), { ...resumePorts(), processInventory: inventory })).rejects.toMatchObject({ code: 'session-may-be-live' });
  expect(launches).toHaveLength(0);
});

it('uses pi on PATH when the recorded program no longer exists', async () => {
  await record({ ...launch([]), program: join(root, 'missing-pi') });
  await launchSession(request(), resumePorts());
  expect(launches[0].argv).toEqual(['pi', '--session', file]);
});

it('replays existing explicit extensions relative to the original launch folder', async () => {
  const original = join(root, 'original'); await mkdir(original);
  await writeFile(join(original, 'extension.ts'), 'export default () => {};\n');
  await record({ ...launch(['-ne', '-e', './extension.ts', '--extension', 'builtin:mcp']), cwd: original });
  await launchSession(request(), resumePorts());
  expect(launches[0].argv).toEqual([process.execPath, '-ne', '-e', join(original, 'extension.ts'), '--extension', 'builtin:mcp', '--session', file]);
});

it('identifies missing extension flags without exposing values or retaining a lease', async () => {
  const missing = [join(root, 'gone-one.ts'), join(root, 'gone-two.ts')];
  await record(launch(['-e', missing[0], '--extension', missing[1]]));
  await expect(launchSession(request(), resumePorts())).rejects.toMatchObject({ code: 'session-extensions-missing', message: expect.stringContaining('-e at argument 1') });
  await expect(offerResume(terminal, offerPorts(false))).rejects.toMatchObject({ code: 'session-extensions-missing', message: expect.stringContaining('--extension at argument 3') });
  expect(await inventory.leases.get(file)).toBeNull();
  expect(launches).toHaveLength(0);
});

it('old records retain the plain pi launch and explicit-extension refusal', async () => {
  const registry = createTerminalRegistry(root);
  await registry.record(mapping());
  await launchSession(request(), resumePorts());
  expect(launches[0].argv).toEqual(['pi', '--session', file]);
  expect(launches[0].env.SERVICE_ROUTER).toBeUndefined();
  await registry.record({ ...mapping(), environment: { agentDirectory: agent, extensionArguments: ['-e', join(root, 'extension.ts')] } });
  await expect(offerResume(terminal, offerPorts(false))).rejects.toMatchObject({ code: 'session-explicit-extensions' });
});

it('stores full launch data in a separate 0600 file inside a 0700 directory, never in the terminal map', async () => {
  const registry = createTerminalRegistry(root); await record();
  expect((await stat(secretPath())).mode & 0o777).toBe(0o600);
  expect((await stat(secretDirectory())).mode & 0o777).toBe(0o700);
  expect((await readFile(secretPath(), 'utf8')).includes(credential())).toBe(true);
  const visible = JSON.stringify(await registry.list());
  expect(visible.includes(credential())).toBe(false);
  expect(visible.includes('API_TOKEN')).toBe(false);
  expect(visible.includes('provider/old')).toBe(false);
});

it('replaces tokens on reload, and terminal removal deletes the private launch record', async () => {
  await record();
  const registry = createTerminalRegistry(root);
  await record({ ...launch(), variables: { API_TOKEN: 'rotated-token' } });
  const bytes = await readFile(secretPath(), 'utf8');
  expect(bytes.includes(credential())).toBe(false);
  expect(bytes.includes('rotated-token')).toBe(true);
  expect(await readdir(secretDirectory())).toHaveLength(1);
  await registry.remove(terminal, true);
  await expect(stat(secretPath())).rejects.toMatchObject({ code: 'ENOENT' });
});

it('stores environments above the terminal-map cap without truncating them', async () => {
  const large = 'x'.repeat(1024 * 1024 + 128);
  await record({ ...launch([]), variables: { LARGE_CONFIGURATION: large } });
  await launchSession(request(), resumePorts());
  expect(launches[0].env.LARGE_CONFIGURATION === large).toBe(true);
});

it('dropping a launch record during legacy replacement removes the old secret file', async () => {
  await record();
  await createTerminalRegistry(root).record(mapping());
  await expect(stat(secretPath())).rejects.toMatchObject({ code: 'ENOENT' });
  await launchSession(request(), resumePorts());
  expect(launches[0].env.SERVICE_ROUTER).toBeUndefined();
});

it('cutover and other terminals cannot borrow a private launch environment', async () => {
  await record();
  await launchSession(request(), ports);
  expect(launches[0].env.SERVICE_ROUTER).toBeUndefined();
  await expect(launchSession(request(), { ...ports, resume: { registry: createTerminalRegistry(root), terminal: { ...terminal, terminalId: 'other' as TerminalIdentity['terminalId'] } } })).rejects.toMatchObject({ code: 'resume-offer-stale' });
  expect(launches).toHaveLength(1);
});

it('removes the previous private record if the agent directory changes', async () => {
  await record(); const old = secretPath(); agent = join(root, 'other-agent');
  await record();
  await expect(stat(old)).rejects.toMatchObject({ code: 'ENOENT' });
  expect((await stat(secretPath())).mode & 0o777).toBe(0o600);
});

it.each(['symlink file', 'nonregular file', 'symlink directory', 'public directory', 'public file'])('refuses unsafe launch storage: %s', async kind => {
  await record();
  if (kind === 'public file') await chmod(secretPath(), 0o644);
  if (kind === 'public directory') await chmod(secretDirectory(), 0o755);
  if (kind === 'symlink file' || kind === 'nonregular file') {
    await rm(secretPath());
    if (kind === 'symlink file') await symlink(file, secretPath()); else await mkdir(secretPath());
  }
  if (kind === 'symlink directory') {
    await rm(secretDirectory(), { recursive: true }); await symlink(root, secretDirectory());
  }
  await expect(launchSession(request(), resumePorts())).rejects.toMatchObject({ code: 'launch-record-invalid' });
  expect(launches).toHaveLength(0);
});

it('refuses missing or mismatched private records instead of silently resuming without launch settings', async () => {
  await record(); await rm(secretPath());
  await expect(launchSession(request(), resumePorts())).rejects.toMatchObject({ code: 'launch-record-invalid' });
  await record();
  const bytes = JSON.parse(await readFile(secretPath(), 'utf8')); bytes.sessionId = 'foreign';
  await writeFile(secretPath(), JSON.stringify(bytes), { mode: 0o600 });
  await expect(offerResume(terminal, offerPorts(false))).rejects.toMatchObject({ code: 'launch-record-invalid' });
});

it('refuses private data from a different mapping publication for the same session', async () => {
  await record();
  const data = JSON.parse(await readFile(secretPath(), 'utf8'));
  data.recordedAt = 9;
  await writeFile(secretPath(), JSON.stringify(data), { mode: 0o600 });
  await expect(launchSession(request(), resumePorts())).rejects.toMatchObject({ code: 'launch-record-invalid' });
  expect(launches).toHaveLength(0);
});

it('never exposes recorded variable values through shell offers, diagnostics, or parse errors', async () => {
  const output: string[] = [];
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) vi.spyOn(console, method).mockImplementation((...args) => { output.push(args.map(String).join(' ')); });
  for (const stream of [process.stdout, process.stderr]) vi.spyOn(stream, 'write').mockImplementation((chunk: unknown) => { output.push(String(chunk)); return true; });
  await record({ ...launch(['--tools', 'read']), variables: { API_TOKEN: credential() } });
  const offer = await offerResume(terminal, offerPorts(false));
  if (!offer) throw new Error('Expected a resume offer');
  for (const mode of ['auto', 'offer'] as const) output.push(resumeOfferShell(offer, { nodePath: process.execPath, cliPath: join(root, 'cli.mjs'), configPath: join(root, 'config.json'), hookPath: join(root, 'hook.sh') }, mode));
  await launchSession(request(), resumePorts());
  await writeFile(secretPath(), '{"API_TOKEN":"' + credential() + '" malformed', { mode: 0o600 });
  try { await launchSession(request(), resumePorts()); } catch (error) { output.push(String(error)); }
  expect(output.join('\n').includes(credential())).toBe(false);
});

it('keeps the original default-model provider across reload while replacing environment tokens', async () => {
  const identity = { pid: 2147483646, startIdentity: 'original-model-fixture' };
  async function activate(provider: string, value: string, reason: 'startup' | 'reload') {
    const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<unknown>>();
    const pi = { on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<unknown>) => { handlers.set(name, handler); return () => handlers.delete(name); } } as unknown as ExtensionAPI;
    const registration = registerHerdrSessions(pi, { ...inventory, registry: createTerminalRegistry(root), processIdentity: identity, launchEnvironment: mapping().environment, coreStartedAt: () => 1, owner: () => owner, currentSession: () => ({ ...identity, sessionFile: file, sessionName: owner.name, kind: 'top-level', hcAddress: terminal.address }), ...{ captureLaunch: () => ({ ...launch(['--api-key', credential()]), variables: { API_TOKEN: value } }) } });
    const ctx = { mode: 'tui', model: { provider, id: 'default' }, sessionManager: { getSessionFile: () => file, getSessionId: () => owner.sessionId } } as unknown as ExtensionContext;
    try {
      await handlers.get('session_start')!({ reason }, ctx);
      await handlers.get('session_shutdown')!({ reason: 'reload' }, ctx);
    } finally { await registration.dispose(); }
  }
  await activate('provider', credential(), 'startup');
  await activate('other', 'rotated-token', 'reload');
  const bytes = await readFile(secretPath(), 'utf8');
  const snapshot = JSON.parse(bytes);
  expect(snapshot.launch.model).toEqual({ provider: 'provider', modelId: 'default' });
  expect(bytes.includes(credential())).toBe(true); // The original argv key is still present.
  expect(snapshot.launch.variables.API_TOKEN === 'rotated-token').toBe(true);
});

it.each(['unknown default', 'ambiguous model', 'explicit provider'].flatMap(label => ['offer', 'launch'].map(mode => ({ label, mode }))))('first capture at reload handles $label key provenance in $mode', async ({ label, mode }) => {
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<unknown>>();
  const pi = { on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<unknown>) => { handlers.set(name, handler); return () => handlers.delete(name); } } as unknown as ExtensionAPI;
  const identity = { pid: 2147483645, startIdentity: root };
  const argv = [...(label === 'explicit provider' ? ['--provider', 'provider'] : []), ...(label !== 'unknown default' ? ['--model', 'namespace/model'] : []), '--api-key', credential()];
  const registration = registerHerdrSessions(pi, { ...inventory, registry: createTerminalRegistry(root), processIdentity: identity, launchEnvironment: mapping().environment, coreStartedAt: () => 1, owner: () => owner, currentSession: () => ({ ...identity, sessionFile: file, sessionName: owner.name, kind: 'top-level', hcAddress: terminal.address }), captureLaunch: () => launch(argv) });
  const ctx = { mode: 'tui', model: { provider: 'other', id: 'current' }, sessionManager: { getSessionFile: () => file, getSessionId: () => owner.sessionId } } as unknown as ExtensionContext;
  try { await handlers.get('session_start')!({ reason: 'reload' }, ctx); }
  finally { await registration.dispose(); }
  await writeFile(file, (await readFile(file, 'utf8')).replace('"provider":"provider"', '"provider":"other"'));
  let failure: unknown;
  try { await (mode === 'offer' ? offerResume(terminal, { ...offerPorts(false), coreStartedAt: async () => Date.now() + 1000 }) : launchSession(request(), resumePorts())); } catch (error) { failure = error; }
  expect(failure).toMatchObject({ code: label === 'explicit provider' ? 'session-key-provider-changed' : 'session-key-provider-unknown' });
  const notice = String(failure);
  expect(notice.includes(credential())).toBe(false);
  expect(notice).toContain(`cd -- '${root}' && '${process.execPath}' '--session' '${file}' '--model' 'other/current' '--api-key' '<API_KEY>'`);
  expect(launches).toHaveLength(0);
});

it.each(['tui', 'rpc', 'print', 'json', 'child'] as const)('only interactive top-level registration captures new private launch data: %s', async mode => {
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<unknown>>();
  const pi = { on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<unknown>) => { handlers.set(name, handler); return () => handlers.delete(name); } } as unknown as ExtensionAPI;
  let captures = 0;
  const identity = { pid: 2147483647, startIdentity: 'old' };
  const registration = registerHerdrSessions(pi, { ...inventory, registry: createTerminalRegistry(root), processIdentity: identity, launchEnvironment: mapping().environment, coreStartedAt: () => 1, owner: () => owner, currentSession: () => ({ ...identity, sessionFile: file, sessionName: owner.name, kind: mode === 'child' ? 'child' : 'top-level', hcAddress: terminal.address }), ...{ captureLaunch: () => { captures++; return { ...launch(), variables: { API_TOKEN: captures === 1 ? credential() : 'rotated-token' } }; } } });
  const ctx = { mode: mode === 'child' ? 'tui' : mode, sessionManager: { getSessionFile: () => file, getSessionId: () => owner.sessionId } } as unknown as ExtensionContext;
  try {
    await handlers.get('session_start')!({ reason: 'startup' }, ctx);
    await handlers.get('session_start')!({ reason: 'reload' }, ctx);
    expect(captures).toBe(mode === 'tui' ? 2 : 0);
    if (mode === 'tui') {
      const bytes = await readFile(secretPath(), 'utf8');
      expect(bytes.includes(credential())).toBe(false);
      expect(bytes.includes('rotated-token')).toBe(true);
    } else {
      await expect(stat(secretPath())).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await createTerminalRegistry(root).get(terminal)).toBeNull();
    }
  } finally { await registration.dispose(); }
});

it.each(['missing mapping', 'different session', 'different file'])('refuses a stale resume offer: %s', async cause => {
  const registry = createTerminalRegistry(root);
  if (cause !== 'missing mapping') await registry.record({ ...mapping(), owner: { ...owner, ...(cause === 'different session' ? { sessionId: 'newer' as SessionId } : { sessionFile: join(root, 'newer.jsonl') }) }, launch: launch() });
  await expect(launchSession(request(), resumePorts())).rejects.toMatchObject({ code: 'resume-offer-stale', message: expect.stringContaining('saved') });
  expect(launches).toHaveLength(0);
});

it('legacy launch refusal reads explicit extensions from the terminal mapping', async () => {
  await createTerminalRegistry(root).record({ ...mapping(), environment: { agentDirectory: agent, extensionArguments: ['-e', 'npm:example'] } });
  await expect(launchSession(request(), resumePorts())).rejects.toMatchObject({ code: 'session-explicit-extensions' });
  expect(launches).toHaveLength(0);
});

it.each(['npm:@example/tools', 'git:example.invalid/tools@v1', 'github:example/tools', 'https://example.invalid/tools?private=value', 'http://example.invalid/tools', 'ssh://example.invalid/tools', 'builtin:future'])('replays a supported extension source unchanged: %s', async source => {
  await record(launch(['-e', source]));
  await launchSession(request(), resumePorts());
  expect(launches[0].argv).toEqual([process.execPath, '-e', source, '--session', file]);
});

it('replays file URL extensions verbatim after checking the local file', async () => {
  const local = join(root, 'extension.ts'); await writeFile(local, 'export default () => {};');
  const source = pathToFileURL(local).href;
  await record(launch(['-e', source])); await launchSession(request(), resumePorts());
  expect(launches[0].argv).toEqual([process.execPath, '-e', source, '--session', file]);
});

it('never exposes extension values in local-path or legacy refusals', async () => {
  const source = 'https://user:' + credential() + '@example.invalid/tools?key=' + credential();
  await createTerminalRegistry(root).record({ ...mapping(), environment: { agentDirectory: agent, extensionArguments: ['-e', source] } });
  let notice = '';
  try { await launchSession(request(), resumePorts()); } catch (e) { notice = String(e); }
  expect(notice.includes(credential())).toBe(false);
  expect(notice).toContain('explicit extensions');
  await record(launch(['-e', './' + credential()]));
  try { await launchSession(request(), resumePorts()); } catch (e) { notice = String(e); }
  expect(notice.includes(credential())).toBe(false);
  expect(notice).toContain('-e at argument 1');
});

it('resolves resource paths and relative agent directory against launch cwd', async () => {
  const original = join(root, 'original'); await mkdir(original);
  await record({ ...launch(['--skill', './skills', '--prompt-template', '~/prompt.md', '--theme', './theme.json', '--session-dir', './sessions']), cwd: original, variables: { HOME: root, PI_CODING_AGENT_DIR: './agent' } });
  await launchSession(request(), resumePorts());
  expect(launches[0].argv).toEqual([process.execPath, '--skill', join(original, 'skills'), '--prompt-template', join(root, 'prompt.md'), '--theme', join(original, 'theme.json'), '--session-dir', join(original, 'sessions'), '--session', file]);
  expect(launches[0].env.PI_CODING_AGENT_DIR).toBe(join(original, 'agent'));
});

const loginVariables = ['GPG_TTY', 'VSCODE_IPC_HOOK_CLI', 'VSCODE_GIT_IPC_HANDLE', 'VSCODE_GIT_ASKPASS_NODE', 'VSCODE_GIT_ASKPASS_MAIN', 'VSCODE_GIT_ASKPASS_EXTRA_ARGS', 'GIT_ASKPASS', 'SSH_ASKPASS', 'KITTY_LISTEN_ON', 'KITTY_WINDOW_ID', 'KITTY_PID', 'ALACRITTY_SOCKET', 'ALACRITTY_WINDOW_ID', 'WEZTERM_UNIX_SOCKET', 'WEZTERM_EXECUTABLE', 'NVIM', 'NVIM_LISTEN_ADDRESS', 'ZELLIJ', 'ZELLIJ_SESSION_NAME', 'ZELLIJ_PANE_ID', 'XAUTHORITY', 'KRB5CCNAME', 'SESSION_MANAGER', 'XDG_SESSION_ID', 'XDG_SESSION_TYPE', 'XDG_SEAT', 'XDG_VTNR', 'INVOCATION_ID', 'JOURNAL_STREAM', 'MANAGERPID', 'SYSTEMD_EXEC_PID', 'NOTIFY_SOCKET', 'LISTEN_PID', 'LISTEN_FDS', 'LISTEN_FDNAMES', 'GNOME_KEYRING_CONTROL', 'GPG_AGENT_INFO', 'LC_TERMINAL', 'LC_TERMINAL_VERSION', 'TERM_FEATURES', 'TERMINAL_EMULATOR', 'ITERM_PROFILE', 'KONSOLE_DBUS_SERVICE', 'KONSOLE_DBUS_SESSION', 'KONSOLE_DBUS_WINDOW', 'GNOME_TERMINAL_SCREEN', 'GNOME_TERMINAL_SERVICE', 'VTE_VERSION', 'VTE_SHELL_PID', 'PI_INTERCOM_SCOPE_ID'];
it.each([true, false])('keeps fresh login and terminal endpoints including their absence: %s', async present => {
  await record({ ...launch([]), variables: Object.fromEntries(loginVariables.map(name => [name, 'stale'])) });
  await launchSession(request(), { ...resumePorts(), env: present ? Object.fromEntries(loginVariables.map(name => [name, 'current'])) : {} });
  expect(loginVariables.filter(name => launches[0].env[name] !== (present ? 'current' : undefined))).toEqual([]);
});

it('does not replay a custom variable pointing at the old tty', async () => {
  await record({ ...launch([]), variables: { CUSTOM_TTY: '/dev/ttys003', OTHER_TTY: '/dev/pts/2', KEEP_PATH: '/dev/null' } });
  await launchSession(request(), { ...resumePorts(), env: { CUSTOM_TTY: '/dev/ttys004' } });
  expect(launches[0].env.CUSTOM_TTY).toBe('/dev/ttys004');
  expect(launches[0].env.OTHER_TTY).toBeUndefined();
  expect(launches[0].env.KEEP_PATH).toBe('/dev/null');
});

it.each(['missing', 'wrong session', 'wrong publication', 'permission drift'])('invalid private record gives an actionable session refusal: %s', async cause => {
  await record();
  if (cause === 'missing') await rm(secretPath());
  else if (cause === 'permission drift') await chmod(secretDirectory(), 0o755);
  else {
    const data = JSON.parse(await readFile(secretPath(), 'utf8'));
    if (cause === 'wrong session') data.sessionId = 'foreign'; else data.recordedAt = 9;
    await writeFile(secretPath(), JSON.stringify(data));
  }
  let notice = '';
  try { await launchSession(request(), resumePorts()); } catch (e) { notice = String(e); }
  expect(notice).toContain('saved');
  expect(notice).toContain(`cd -- '${root}' && 'pi' '--session' '${file}'`);
  expect(notice).toContain('<API_KEY>');
  expect(notice.includes(credential())).toBe(false);
});

it.each(['terminals/', 'live-'])('failed publication preserves the previous matching launch record: %s', async failure => {
  await record(); const registry = createTerminalRegistry(root), previous = await registry.get(terminal);
  disk.fail = failure;
  await expect(registry.record({ ...mapping(), recordedAt: 11, launch: { ...launch(), variables: { REPLACEMENT: 'new' } } }, { pid: 2147483647, startIdentity: 'old' })).rejects.toThrow();
  disk.fail = '';
  const retained = await registry.get(terminal);
  expect(retained).toEqual(previous);
  const saved = await readRecordedLaunch(retained!);
  expect(saved?.variables.API_TOKEN === credential()).toBe(true);
});

it('syncs the containing directory after publishing the launch record and terminal mapping', async () => {
  await record();
  const mappingPath = join(root, 'terminals', terminalIdentityKey(terminal) + '.json');
  for (const path of [secretPath(), mappingPath]) {
    const published = disk.events.indexOf('rename:' + path);
    expect(published).toBeGreaterThanOrEqual(0);
    expect(disk.events.slice(published + 1)).toContain('sync:' + dirname(path));
  }
});

it.each([false, true])('reports a private-record refusal only once per terminal publication in auto=%s', async auto => {
  await record(); await rm(secretPath());
  const resume = { ...offerPorts(auto), refusalRoot: root };
  await expect(offerResume(terminal, resume)).rejects.toMatchObject({ code: 'launch-record-invalid' });
  expect(await offerResume(terminal, resume)).toBeNull();
  await createTerminalRegistry(root).record({ ...mapping(), recordedAt: 11, launch: launch() }, { pid: 2147483647, startIdentity: 'old' });
  await rm(secretPath());
  await expect(offerResume(terminal, resume)).rejects.toMatchObject({ code: 'launch-record-invalid' });
});

it('removes leftover credential temp files on the next launch record write', async () => {
  await record(); const stale = join(secretDirectory(), 'old.0123456789abcdef.new');
  await writeFile(stale, credential(), { mode: 0o600 });
  await record();
  expect((await readdir(secretDirectory())).filter(name => name.endsWith('.new'))).toEqual([]);
});

it('an unreadable API-key session model names the session and manual command', async () => {
  await record(keyLaunch(['--api-key', credential()]));
  await writeFile(file, JSON.stringify({ type: 'session', version: 3, id: 'saved', cwd: root }) + '\n' + JSON.stringify({ type: 'model_change', id: 'bad', parentId: null, provider: '', modelId: '' }) + '\n');
  let notice = '';
  try { await launchSession(request(), resumePorts()); } catch (e) { notice = String(e); }
  expect(notice).toContain('saved');
  expect(notice).toContain(`'--session' '${file}'`);
  expect(notice).toContain('<API_KEY>');
});

import { withPiEvents, hostUnitPorts } from './fixtures/pi-events';
import { afterEach, expect, it, vi } from 'vitest';
import spiderExtension from '../extension.js';
import { renderCommandOutput } from '../render-result.js';
import { clearActions, getAction, type SpiderArgs } from '../dispatch.js';
import { paths, SCHEMA_VERSION } from '@spider/db-core';
import { LOADED_BUILD } from '../build-id.js';
import { globalConfigForTest } from '../../../db-core/src/__tests__/global-config.testutil.js';
import { runHerdrCli } from '../../../herdr/src/setup/cli.js';
import { parseHerdrConfig } from '../../../herdr/src/config.js';
import { configFixtureCwd } from './herdr-config-fixture.js';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { mountedFixture } from './herdr-wiring-fixture.js';

afterEach(() => { clearActions(); vi.unstubAllEnvs(); vi.restoreAllMocks(); vi.resetModules(); });

it.each(['argument', 'effective', 'default'] as const)('prints a shell-safe setup hint for the %s config without launching a session', async selection => {
  vi.stubEnv('PI_SUBAGENT_CHILD', '1');
  const commands = new Map<string, { handler(args: string, ctx: unknown): Promise<void> }>();
  const messages: unknown[] = [];
  const pi = { registerTool() {}, registerCommand(name: string, command: unknown) { commands.set(name, command as never); }, on() {}, sendMessage(message: unknown) { messages.push(message); } };
  spiderExtension(withPiEvents(pi), hostUnitPorts);
  expect(commands.has('herdr-setup')).toBe(true);
  const { mkdir, mkdtemp, writeFile, rm } = await import('node:fs/promises'); const { join } = await import('node:path');
  const { execFileSync } = await import('node:child_process');
  const cwd = await mkdtemp(resolve('.spider/scratch/setup-hint-')); execFileSync('git', ['init', '-q', cwd]);
  const file = join(cwd, 'config\'s $HERDR_TEST_CONFIG `printf altered` \\"quoted\\".json');
  vi.stubEnv('SPIDER_GLOBAL_ROOT', join(cwd, 'global')); await mkdir(join(cwd, '.spider'));
  const globalConfig = globalConfigForTest(paths.globalRoot);
  if (selection === 'effective') globalConfig.set('herdr.config', file);
  try {
    await commands.get('herdr-setup')!.handler(selection === 'argument' ? file : '', { cwd, ui: { notify() {} } });
    expect(messages).toEqual([expect.objectContaining({ customType: 'spider.command', content: expect.stringContaining('plain shell') })]);
    const text = (messages[0] as { content: string }).content;
    expect(messages[0]).toMatchObject({ display: true, details: { args: { command: 'herdr-setup' }, result: { text } } });
    const card = renderCommandOutput(messages[0], { expanded: true }, {}).render(120).join('\n');
    expect(card).toContain('◆ herdr-setup');
    expect(card).not.toContain('spider · herdr-setup');
    expect(card).toContain('From a plain shell:');
    expect(card).toContain('This command only prints instructions; it never launches or writes.');
    expect(card).not.toContain('{}');
    for (const action of ['setup', 'doctor']) {
      const command = text.split('\n').find(line => line.includes(` ${action} --config `))!.split('Run: ')[1];
      const argv = execFileSync('/bin/sh', ['-c', `set -- ${command}; printf '%s\\0' "$@"`], { encoding: 'utf8' }).split('\0').slice(0, -1);
      expect(argv[0]).toBe(process.execPath);
      expect(argv.slice(-3)).toEqual([action, '--config', selection === 'default' ? join(cwd, 'global/herdr/config.json') : file]);
      expect(text).not.toContain('<absolute-user-file>');
    }
  } finally { globalConfig.restore(); await rm(cwd, { recursive: true, force: true }); }
});

it.each(['exec', 'exec_file', 'batch'])('unavailable child %s uses the disabled-owner diagnostic before execution', async action => {
  vi.stubEnv('PI_SUBAGENT_CHILD', '1');
  spiderExtension(withPiEvents({ registerTool() {}, registerCommand() {}, on() {}, sendMessage() {} } as never), hostUnitPorts);
  const handler = getAction(action); expect(handler).toBeDefined();
  await expect(Promise.resolve().then(() => handler!({ action, on: 'remote.invalid', language: 'shell', code: 'printf forbidden' } as SpiderArgs, {} as never))).rejects.toThrow("Spider couldn't run this command on another machine because Herdr is off in this session. Local commands still work. Check that Herdr is running and enabled, then run /reload or open a new session in Herdr.");
});

it('forwards repeated explicit space adoption before the setup preflight', async () => {
  let request: unknown;
  const root = join(tmpdir(), 'adoption-fixture');
  const config = parseHerdrConfig({ app: { binary: join(root, 'app'), home: join(root, 'app-home') }, core: { binary: join(root, 'hc'), config: join(root, 'core.toml') },
    agentDirectory: join(root, 'agent'), globalRoot: root, shellRc: join(root, 'rc'), spaces: [], machines: [] });
  const code = await runHerdrCli(['setup', '--config', resolve('config.json'), '--adopt-existing-space', 'work', '--adopt-existing-space', 'review'], {
    request: async () => ({ config, configPath: join(root, 'config.json'), packageRoot: root, journalRoot: join(root, 'journal') }),
    setupParts: async value => { request = value; throw new Error('Stop before writes'); },
    doctorParts: async () => { throw new Error('Not doctor'); }, stdout() {}, stderr() {},
  });
  expect(code).toBe(1);
  expect(request).toMatchObject({ adoptExistingSpaces: ['work', 'review'] });
});

it.each(['explicit', 'standard'] as const)('starts the production session feed from %s setup output', async location => {
  const { createHostHerdrHarness } = await import('./herdr-fixture-inventory.testutil.js');
  const { writeFile, mkdir, readFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { existsSync } = await import('node:fs');
  const h = await createHostHerdrHarness('fake');
  const { installFastCoreTransport } = await import('./herdr-setup-fast-core.js');
  installFastCoreTransport(h); await h.start();
  const { execFileSync } = await import('node:child_process');
  execFileSync('git', ['init', '-q', h.directories.local]);
  const hooks = new Map<string, Function[]>();
  vi.stubEnv('PI_SUBAGENT_CHILD', '0');
  for (const [name, value] of Object.entries(h.localEnv)) if (value !== undefined && (name.startsWith('HC_') || name.startsWith('XDG_') || name.startsWith('HERDR_'))) vi.stubEnv(name, value);
  const versionedApp = join(h.root, 'versioned-app');
  await writeFile(versionedApp, `#!/bin/sh\nif [ "$1" = '--version' ]; then echo 'herdr-app 0.1.12'; else exec '${h.appBinary}' "$@"; fi\n`, { mode: 0o700 });
  const look = join(h.root, 'packages/herdr/assets/look'); await mkdir(look, { recursive: true });
  await writeFile(join(look, 'patches.json'), await readFile(resolve('packages/herdr/assets/look/patches.json')));
  const config = { enabled: true, app: { binary: versionedApp, home: h.directories.app }, core: { binary: h.hcBinary, config: join(h.root, 'core.toml') }, agentDirectory: h.directories.agent, globalRoot: h.directories.global, shellRc: join(h.root, 'shellrc'), spaces: [], machines: [], limits: { auxiliaryPanes: 2, completedRows: 50, completedHours: 24 }, retention: { foregroundDays: 7 }, admin: { wrappers: [] } };
  vi.stubEnv('SPIDER_GLOBAL_ROOT', h.directories.global);
  const file = location === 'standard' ? join(h.directories.global, 'herdr/config.json') : join(h.root, 'herdr.json');
  await mkdir(join(h.directories.global, 'herdr'), { recursive: true });
  await writeFile(file, JSON.stringify(config));
  await mkdir(join(h.directories.local, '.spider'), { recursive: true });
  await writeFile(join(h.directories.local, '.spider/config.json'), '{}');
  vi.stubEnv('PI_CODING_AGENT_DIR', h.directories.agent);
  vi.resetModules();
  const { default: mountedExtension } = await import('../extension.js');
  const { createProductionHerdrCliPorts } = await import('../herdr/ports.js');
  const setupPorts = configFixtureCwd(createProductionHerdrCliPorts(h.root, Object.freeze({ ...process.env })), h.directories.local);
  let setupOutput = '';
  try {
    expect(await runHerdrCli(['setup', '--config', file], { ...setupPorts,
      setupParts: async request => ({ ...await setupPorts.setupParts(request),
        preflight: async () => ({ fingerprint: 'fixture', coreIdentity: h.owner!.terminal, mods: [], targets: [], retiredTerminals: [], layoutExport: true }),
        stageLook: async () => [], installFiles: async () => [], generateTemplates: async () => [], installResume: async () => [],
        ensureRuntime: async () => [], bootstrapRuntime: async () => {}, paneEndpointPlan: async () => ({ paths: [], changed: false }), stagePaneEndpoint: async () => [],
        cutover: async () => ({ terminals: [], identities: {} }), verify: async () => ({ failures: [], warnings: [], probes: [] }),
      }), stdout: text => { setupOutput += text; }, stderr: text => { throw new Error(text); },
    })).toBe(0);
    expect(setupOutput).toContain('Setup verified:');
    if (location === 'explicit') expect(JSON.parse(await readFile(join(h.directories.global, 'config.json'), 'utf8'))).toMatchObject({ 'herdr.config': file });
    else expect(JSON.parse(await readFile(join(h.directories.global, 'config.json'), 'utf8'))).not.toHaveProperty('herdr.config');
  } finally { await setupPorts.dispose(); }
  const shortcuts = new Map<string, { handler(ctx: unknown): Promise<void> }>();
  const notifications: string[] = [], sendMessage = vi.fn(), steer = vi.fn(), followUp = vi.fn();
  const pi = { getSessionName: () => undefined, registerTool() {}, registerCommand() {}, registerShortcut(key: string, command: { handler(ctx: unknown): Promise<void> }) { shortcuts.set(key, command); }, on(name: string, callback: Function) { hooks.set(name, [...hooks.get(name) ?? [], callback]); return () => {}; }, sendMessage, steer, followUp };
  const ctx = { cwd: h.directories.local, mode: 'tui', hasUI: true, getContextUsage: () => undefined, isIdle: () => true, ui: { notify(_message: string) {}, setWidget() {}, setFooter() {}, setStatus() {} }, sessionManager: { getSessionId: () => h.owner!.sessionId, getEntries: () => [], getBranch: () => [], getSessionFile: () => undefined, getSessionName: () => undefined } };
  try {
    mountedExtension(withPiEvents(pi), hostUnitPorts);
    for (const callback of hooks.get('session_start') ?? []) await callback({ reason: 'startup' }, ctx);
    const feedPath = join(config.globalRoot, 'herdr/sessions', h.owner!.sessionId, 'session.json');
    expect(existsSync(feedPath)).toBe(true);
    expect(JSON.parse(await readFile(feedPath, 'utf8'))).toMatchObject({ sessionId: h.owner!.sessionId, version: 1, ipc: { version: 1, sessionId: h.owner!.sessionId } });
    ctx.ui.notify = (message: string) => { notifications.push(message); };
    for (const idle of [false, true]) {
      ctx.isIdle = () => idle;
      expect(shortcuts.has('ctrl+shift+m')).toBe(true);
      await shortcuts.get('ctrl+shift+m')!.handler(ctx);
    }
    expect(notifications).toHaveLength(2);
    expect(notifications.map(text => JSON.parse(text))).toEqual([[], []]);
    expect(sendMessage).not.toHaveBeenCalled(); expect(steer).not.toHaveBeenCalled(); expect(followUp).not.toHaveBeenCalled();
  } finally {
    for (const callback of hooks.get('session_shutdown') ?? []) await callback({ reason: 'quit' }, ctx);
    await h.close();
  }
});

it('exposes auto enablement and an absolute user config in the visible schema', async () => {
  const { UI_CONFIG_SCHEMA } = await import('../ui-thinking.js');
  const { coerce } = await import('../../../ui/src/screens/config-schema.js');
  const fields = UI_CONFIG_SCHEMA.flatMap(group => group.fields);
  const enabled = fields.find(field => field.key === 'herdr.enabled');
  expect(enabled).toMatchObject({ default: 'auto' });
  expect(coerce(enabled!, 'false')).toEqual({ ok: true, value: false });
  expect(coerce(enabled!, 'true')).toEqual({ ok: true, value: true });
  expect(coerce(enabled!, 'auto')).toEqual({ ok: true, value: 'auto' });
  expect(fields.find(field => field.key === 'herdr.config')).toMatchObject({ type: 'string', default: '' });
});

it('routes resume-offer and resume without treating a shell offer as setup', async () => {
  const calls: unknown[] = [];
  const ports = { request: async () => ({}) as never, setupParts: async () => { throw new Error('Not setup'); }, doctorParts: async () => { throw new Error('Not doctor'); }, stdout() {}, stderr() {},
    resumeOffer: async () => { calls.push('offer'); return ''; }, resume: async (_request: unknown, selection: unknown) => { calls.push(selection); },
  };
  expect(await runHerdrCli(['resume-offer', '--config', resolve('config.json')], ports)).toBe(0);
  expect(await runHerdrCli(['resume', '--config', resolve('config.json'), '--file', resolve('.spider/scratch/session.jsonl'), '--session-id', 'saved', '--cwd', resolve('.spider/scratch/work')], ports)).toBe(0);
  expect(calls).toEqual(['offer', { file: resolve('.spider/scratch/session.jsonl'), sessionId: 'saved', cwd: resolve('.spider/scratch/work') }]);
});

it.each(['--help', '-h'])('prints CLI help without opening config or producer ports: %s', async flag => {
  let output = '';
  expect(await runHerdrCli([flag], { request: async () => { throw new Error('Must not read config'); }, setupParts: async () => { throw new Error('Must not create ports'); }, doctorParts: async () => { throw new Error('Must not create ports'); }, stdout: text => { output += text; }, stderr() {} })).toBe(0);
  for (const word of ['setup', '--config', '--adopt-existing-space', 'doctor', 'rollback', 'resume-offer', 'resume', '--file', '--session-id', '--cwd']) expect(output).toContain(word);
});

it.each(['--help', '-h'])('prints viewer help before constructing IPC or TTY consumers: %s', async flag => {
  const { createViewerPorts } = await import('../herdr/ports.js'); const { PassThrough } = await import('node:stream');
  const output = new PassThrough(); let text = ''; output.on('data', chunk => { text += chunk.toString(); });
  expect(createViewerPorts([flag], { stdin: new PassThrough(), stdout: output })).toBeNull();
  for (const word of ['--feed-root', '--session', '--run']) expect(text).toContain(word);
});

it.each([
  ['tui', true, false, true, true], ['tui', false, false, true, false], ['rpc', false, false, true, false], ['tui', true, true, true, false], ['tui', true, false, false, false],
])('starts native status only with top-level interactive Herdr UI: %s/%s/%s/%s', async (mode, ui, child, hc, captures) => {
  const f = await mountedFixture('fake', mode as string, ui as boolean, child as boolean, hc as boolean);
  try {
    expect(f.captured.length > 0).toBe(captures);
    const { processStartTime } = await import('../../../subagents/src/process-identity.js');
    expect(await f.presence.list()).toEqual([{ version: 1, pid: process.pid, startIdentity: processStartTime(process.pid),
      sessionId: f.h.owner!.sessionId, sessionFile: null, sessionName: null, kind: child ? 'child' : 'top-level', mode,
      extensionArguments: [], hcAddress: f.owner?.terminal.address ?? null,
      ...(child ? {} : { build: LOADED_BUILD, capabilities: { roamSchema: SCHEMA_VERSION } }),
    }]);
    if (child) expect(await f.calls()).toEqual([]);
  }
  finally { await f.close(); }
}, 30_000);

it('older session contexts without getSessionFile keep optional bookkeeping working', async () => {
  const f = await mountedFixture();
  try {
    Reflect.deleteProperty(f.ctx.sessionManager, 'getSessionFile');
    await expect(f.emit('session_start')).resolves.toBeUndefined();
    expect(f.mount.enabled()).toBe(true); expect((await f.presence.list())[0].sessionFile).toBeNull();
    for (const event of [undefined, { reason: 'reload' }]) {
      for (const handler of [...f.hooks.get('session_shutdown') ?? []]) await expect(Promise.resolve(handler(event, f.ctx))).resolves.toBeUndefined();
    }
    expect(f.errors).toEqual([]);
  } finally { await f.close(); }
}, 30000);

it('failed Herdr bookkeeping reports its error and does not break later lifecycle handlers', async () => {
  const f = await mountedFixture(); let later = 0;
  try {
    Reflect.set(f.ctx.sessionManager, 'getSessionFile', () => { throw new Error('bookkeeping-unavailable'); });
    f.hooks.get('session_start')!.add(() => { later++; });
    await expect(f.emit('session_start')).resolves.toBeUndefined();
    expect(later).toBe(1); expect(f.errors.map(String)).toContain('Error: bookkeeping-unavailable');
  } finally { Reflect.set(f.ctx.sessionManager, 'getSessionFile', () => undefined); await f.close(); }
}, 30000);

it('composed host calls real transcript and command ports without editor input', async () => {
  const f = await mountedFixture();
  const { mkdir, writeFile } = await import('node:fs/promises'); const { join } = await import('node:path');
  const { paths } = await import('@spider/db-core');
  const { emitStatus } = await import('../../../subagents/src/run-events.js');
  const frames: unknown[] = [];
  try {
    expect(f.errors).toEqual([]);
    const run = f.store.create({ sessionId: f.owner!.sessionId, agent: 'worker' }); f.store.start(run.id); f.store.setLaunch(run.id, { childMode: 'rpc' });
    const dir = join(paths.scratch('project', f.ctx.cwd), 'subagent-sessions', run.id); await mkdir(dir, { recursive: true });
    await writeFile(join(dir, run.id + '.jsonl'), JSON.stringify({ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'observed text\n' }] } }) + '\n');
    const subscription = await f.ipc!.subscribeRun(run.id as never, null, frame => frames.push(frame));
    await vi.waitFor(() => expect(JSON.stringify(frames)).toContain('observed text'), { timeout: 3000 });
    for (const view of ['agents', 'todos', 'usage', 'memory', 'triggers'] as const) expect(await f.ipc!.openView(view)).toMatchObject({ ok: true, op: 'openView' });
    expect(f.opened).toEqual(['agents', 'todos', 'usage', 'memory', 'triggers']);
    // Observe the real terminal's status writes so the ping follows the refresh.
    let terminalStatus = f.terminal.programStatus;
    let onStatus: ((status: { state: string }) => void) | undefined;
    Object.defineProperty(f.terminal, 'programStatus', {
      configurable: true,
      get: () => terminalStatus,
      set: status => { terminalStatus = status; onStatus?.(status); },
    });
    const statusChanged = (state: string) => new Promise<void>(resolve => {
      onStatus = status => { if (status?.state === state) { onStatus = undefined; resolve(); } };
    });
    const working = statusChanged('working');
    emitStatus(f.db, { runId: run.id, sessionId: f.owner!.sessionId, status: 'running' });
    await working;
    const done = statusChanged('done');
    f.store.finish(run.id, { status: 'done', result: 'observed result' });
    emitStatus(f.db, { runId: run.id, sessionId: f.owner!.sessionId, status: 'done' });
    await done;
    expect(await f.ipc!.steerRun(run.id as never, 'next case')).toMatchObject({ ok: true, acknowledgement: { delivery: 'refused' } });
    expect(await f.ipc!.ping()).toMatchObject({ ok: true, status: { effective: 'done' } });
    await subscription.dispose();
    const address = f.feed.ipc.address;
    await f.emit('session_shutdown', { reason: 'quit' });
    const { existsSync } = await import('node:fs'); expect(existsSync(address)).toBe(false); expect(await f.presence.list()).toEqual([]);
  } finally { await f.close(); }
}, 30_000);

it.each([[false, true], ['auto', false]] as const)('optional %s mode with HC owner %s makes no hc calls', async (requested, hcOwner) => {
  const f = await mountedFixture('fake', 'tui', true, false, hcOwner, false, requested, false, false, true, undefined, { fastInactive: true });
  try {
    expect(f.owner).toBeNull(); expect(await f.calls()).toEqual([]);
    expect(f.captured).toEqual([]); expect(f.feed).toBeNull();
    const records = await f.presence.list();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ pid: process.pid, sessionId: f.h.owner!.sessionId, hcAddress: null, kind: 'top-level' });
    const { readdir } = await import('node:fs/promises'); const { join } = await import('node:path');
    const files = (await readdir(join(f.config.globalRoot, 'herdr'), { recursive: true, withFileTypes: true })).filter(entry => entry.isFile());
    expect(files).toHaveLength(1);
    expect(files[0].name).toMatch(/\.json$/);
    expect(files[0].parentPath).toBe(join(f.config.globalRoot, 'herdr/processes'));
    await f.emit('session_shutdown', { reason: 'reload' });
    await f.emit('session_start', { reason: 'startup' });
    expect(await f.presence.list()).toHaveLength(1);
    expect(await f.calls()).toEqual([]);
    expect(await f.mount.guard({ toolName: 'spider', input: { action: 'exec', on: 'remote.invalid', code: 'echo no', language: 'shell' } })).toMatchObject({ block: true, reason: expect.stringContaining('Herdr is off in this session') });
    expect(await f.mount.guard({ toolName: 'bash', input: { command: 'ssh managed.example.invalid' } })).toBeUndefined();
  } finally { await f.close(); }
});

it('auto with a dead socket disables once without launching hc', async () => {
  const f = await mountedFixture('fake', 'tui', true, false, true, false, 'auto', true);
  try {
    expect(f.owner).toBeNull(); expect(f.mount.enabled()).toBe(false);
    expect(await f.calls()).toEqual([]); expect(f.captured).toEqual([]);
    await f.emit('session_start', { reason: 'resume' });
    expect(await f.calls()).toEqual([]);
    expect(f.notices).toHaveLength(1); expect(f.notices[0]).toContain('Herdr stopped responding');
  } finally { await f.close(); }
}, 30000);

it('an active owner installs the bash and shortcut adapters', async () => {
  const f = await mountedFixture();
  try { expect(f.registrations.tools).toContain('bash'); expect(f.registrations.shortcuts).toHaveLength(5); }
  finally { await f.close(); }
});

it.each([[false, true], ['auto', false]] as const)('inactive %s mode registers neither bash override nor shortcut handlers', async (requested, hcOwner) => {
  const f = await mountedFixture('fake', 'tui', true, false, hcOwner, false, requested, false, true, true, undefined, { fastInactive: true });
  try {
    expect(f.registrations.tools).toEqual([]);
    expect(f.registrations.shortcuts).toEqual([]);
    Reflect.set(f.ctx, 'ui', undefined); Reflect.set(f.ctx, 'hasUI', false);
    await expect(f.emit('session_start', { reason: 'resume' })).resolves.toBeUndefined();
    expect(f.registrations.tools).toEqual([]); expect(f.registrations.shortcuts).toEqual([]);
    expect(f.errors).toEqual([]); expect(await f.calls()).toEqual([]);
  } finally { await f.close(); }
});

it.each([
  [false, true, true, true], [false, true, true, false],
  ['auto', false, true, true], ['auto', false, true, false],
  ['auto', true, false, true], ['auto', true, false, false],
] as const)('inactive notice is visible once, never twice: %s/%s/%s/UI=%s', async (requested, hcOwner, coreAvailable, hasUI) => {
  const writes = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  let f: Awaited<ReturnType<typeof mountedFixture>> | undefined;
  try {
    f = await mountedFixture('fake', 'tui', hasUI, false, hcOwner, false, requested, false, true, coreAvailable, undefined, { fastInactive: requested === false || !hcOwner });
    const visible = () => f!.notices.length + writes.mock.calls.filter(([text]) => /^(?:Herdr stopped responding|Herdr couldn't respond to spider|This session isn't running inside Herdr)/.test(String(text))).length;
    expect(visible(), JSON.stringify(writes.mock.calls)).toBe(requested === false ? 0 : 1);
    await f.emit('session_start', { reason: 'resume' });
    await f.emit('session_shutdown', { reason: 'reload' });
    await f.emit('session_start', { reason: 'startup' });
    expect(visible()).toBe(requested === false ? 0 : 1);
    expect(f.registrations.tools).toEqual([]); expect(f.registrations.shortcuts).toEqual([]);
    f.config.enabled = false; await f.emit('session_start', { reason: 'resume' });
    expect(f.statusValues.get('spider-herdr')).toBeUndefined();
    expect(visible()).toBe(requested === false ? 0 : 1);
  } finally { await f?.close(); writes.mockRestore(); }
});

import { afterEach, expect, it, vi } from 'vitest';
import spiderExtension from '../extension.js';
import { clearActions, getAction, type SpiderArgs } from '../dispatch.js';
import { paths } from '@spider/db-core';
import { globalConfigForTest } from '../../../db-core/src/__tests__/global-config.testutil.js';
import { runHerdrCli } from '../../../herdr/src/setup/cli.js';
import { configFixtureCwd } from './herdr-config-fixture.js';
import { resolve, join } from 'node:path';
import { mountedFixture, heldObserverScenario, assertNoNativeNotes, launchScenario, installFixtureRuntime, closePaneScenario } from './herdr-wiring-fixture.js';

afterEach(() => { clearActions(); vi.unstubAllEnvs(); vi.resetModules(); });

it.each(['argument', 'effective', 'default'] as const)('prints a shell-safe setup hint for the %s config without launching a session', async selection => {
  vi.stubEnv('PI_SUBAGENT_CHILD', '1');
  const commands = new Map<string, { handler(args: string, ctx: unknown): Promise<void> }>();
  const messages: unknown[] = [];
  const pi = { registerTool() {}, registerCommand(name: string, command: unknown) { commands.set(name, command as never); }, on() {}, sendMessage(message: unknown) { messages.push(message); } };
  spiderExtension(pi);
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
  spiderExtension({ registerTool() {}, registerCommand() {}, on() {}, sendMessage() {} } as never);
  const handler = getAction(action); expect(handler).toBeDefined();
  await expect(Promise.resolve().then(() => handler!({ action, on: 'remote.invalid', language: 'shell', code: 'printf forbidden' } as SpiderArgs, {} as never))).rejects.toThrow("Spider couldn't run this command on another machine because Herdr is off in this session. Local commands still work. Check that Herdr is running and enabled, then run /reload or open a new session in Herdr.");
});

it('forwards repeated explicit space adoption before the setup preflight', async () => {
  let request: unknown;
  const code = await runHerdrCli(['setup', '--config', resolve('config.json'), '--adopt-existing-space', 'work', '--adopt-existing-space', 'review'], {
    request: async () => ({}) as never,
    setupParts: async value => { request = value; throw new Error('Stop before writes'); },
    doctorParts: async () => { throw new Error('Not doctor'); }, stdout() {}, stderr() {},
  });
  expect(code).toBe(1);
  expect(request).toMatchObject({ adoptExistingSpaces: ['work', 'review'] });
});

it.each(['explicit', 'standard'] as const)('starts the production session feed from %s setup output', async location => {
  const { createHerdrHarness } = await import('../../../herdr/src/__tests__/testutil.js');
  const { writeFile, mkdir, readFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { existsSync } = await import('node:fs');
  const h = await createHerdrHarness('fake'); await h.start();
  const { execFileSync } = await import('node:child_process');
  execFileSync('git', ['init', '-q', h.directories.local]);
  const hooks = new Map<string, Function[]>();
  vi.stubEnv('PI_SUBAGENT_CHILD', '0');
  for (const [name, value] of Object.entries(h.localEnv)) if (value !== undefined && (name.startsWith('HC_') || name.startsWith('XDG_') || name.startsWith('HERDR_'))) vi.stubEnv(name, value);
  const config = { enabled: true, app: { binary: h.appBinary, home: h.directories.app }, core: { binary: h.hcBinary, config: join(h.root, 'core.toml') }, agentDirectory: h.directories.agent, globalRoot: h.directories.global, shellRc: join(h.root, 'shellrc'), spaces: [], machines: [], limits: { auxiliaryPanes: 2, completedRows: 50, completedHours: 24 }, retention: { foregroundDays: 7 }, admin: { wrappers: [] } };
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
        ensureRuntime: async () => [], bootstrapRuntime: async () => {},
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
    mountedExtension(pi);
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
    f.store.finish(run.id, { status: 'done', result: 'observed result' });
    expect(await f.ipc!.steerRun(run.id as never, 'next case')).toMatchObject({ ok: true, acknowledgement: { delivery: 'refused' } });
    expect(await f.ipc!.ping()).toMatchObject({ ok: true, status: { effective: 'done' } });
    await subscription.dispose();
    const address = f.feed.ipc.address;
    await f.emit('session_shutdown', { reason: 'quit' });
    const { existsSync } = await import('node:fs'); expect(existsSync(address)).toBe(false); expect(await f.presence.list()).toEqual([]);
  } finally { await f.close(); }
}, 30_000);

it.each([[false, true], ['auto', false]] as const)('optional %s mode with HC owner %s makes no hc calls', async (requested, hcOwner) => {
  const f = await mountedFixture('fake', 'tui', true, false, hcOwner, false, requested);
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
  const f = await mountedFixture('fake', 'tui', true, false, hcOwner, false, requested, false, true);
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
    f = await mountedFixture('fake', 'tui', hasUI, false, hcOwner, false, requested, false, true, coreAvailable);
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

it('composed routing guards explicit file transports before launch', async () => {
  const f = await mountedFixture();
  try { expect(await f.mount.guard({ toolName: 'bash', input: { command: 'scp local.txt managed.example.invalid:/data' } })).toMatchObject({ block: true, reason: expect.stringContaining('spider exec') }); }
  finally { await f.close(); }
});

it('the composed extension checks SSH once per tool call and still refuses a managed destination', async () => {
  const f = await mountedFixture(); const module = await import('../herdr/mount.js');
  f.config.machines[0].aliases.push('managed.invalid');
  await f.emit('session_shutdown', { reason: 'reload' }); await f.emit('session_start', { reason: 'reload' });
  const originalHooks = new Map([...f.hooks].map(([name, handlers]) => [name, new Set(handlers)]));
  const guard = vi.spyOn(f.mount, 'guard'); const mount = vi.spyOn(module, 'mountHerdr').mockReturnValue(f.mount);
  Reflect.set(f.pi, 'registerCommand', () => {});
  try {
    const { default: extension } = await import('../extension.js'); extension(f.pi as never);
    const path = join(f.h.directories.remote, 'guard-script.sh');
    for (const [code, blocked] of [['printf harmless', false], ['ssh managed.invalid', true]] as const) {
      await f.h.hc.fileWrite('remote.invalid' as never, path, Buffer.from(code));
      const before = (await f.calls()).filter(call => call.argv[0] === 'file' && call.argv[1] === 'read').length;
      guard.mockClear();
      const result = await f.emit('tool_call', { toolName: 'spider', toolCallId: 'guard-' + blocked, input: { action: 'exec_file', language: 'shell', on: 'remote.invalid', path } });
      const reads = (await f.calls()).filter(call => call.argv[0] === 'file' && call.argv[1] === 'read').length - before;
      expect(reads).toBe(1);
      expect(guard).toHaveBeenCalledTimes(1);
      if (blocked) expect(result).toMatchObject({ block: true, reason: expect.stringContaining('spider exec') });
      else expect(result).toBeUndefined();
    }
  } finally {
    mount.mockRestore(); guard.mockRestore(); f.hooks.clear(); for (const [name, handlers] of originalHooks) f.hooks.set(name, handlers);
    await f.close();
  }
}, 30000);

it('unmanaged SSH uses the executable on PATH behind the inherited shim', async () => {
  const f = await mountedFixture('fake', 'tui', true, false, true, true);
  const { mkdir, writeFile, chmod } = await import('node:fs/promises');
  const { PolyglotExecutor } = await import('../../../context/src/executor.js');
  try {
    const bin = join(f.h.root, 'user-bin'); await mkdir(bin);
    const binary = join(bin, 'ssh'); await writeFile(binary, '#!/bin/sh\nprintf "custom-ssh:%s\\n" "$*"\nexit 23\n'); await chmod(binary, 0o700);
    const inherited = f.mount.execution().environmentPolicy(process.env);
    vi.stubEnv('PATH', f.shimDirectory + ':' + bin + ':' + process.env.PATH);
    vi.stubEnv('SPIDER_HERDR_SSH_DESCRIPTOR', inherited.SPIDER_HERDR_SSH_DESCRIPTOR!);
    await f.emit('session_shutdown', { reason: 'reload' }); await f.emit('session_start', { reason: 'reload' });
    const environment = f.mount.execution().environmentPolicy(process.env);
    expect(JSON.parse(environment.SPIDER_HERDR_SSH_DESCRIPTOR!).realSshBinary).toBe(binary);
    const result = await new PolyglotExecutor({ projectRoot: f.ctx.cwd, ...f.mount.execution() }).execute({ language: 'shell', code: 'ssh unmanaged.invalid echo safe', timeout: 10000 });
    expect(result).toMatchObject({ exitCode: 23, stdout: 'custom-ssh:unmanaged.invalid echo safe\n', stderr: '' });
  } finally { await f.close(); }
}, 30000);

it('turning Herdr off removes an inherited shim and descriptor from local execution', async () => {
  const f = await mountedFixture(); const { PolyglotExecutor } = await import('../../../context/src/executor.js');
  try {
    const inherited = f.mount.execution().environmentPolicy(process.env);
    vi.stubEnv('PATH', inherited.PATH!); vi.stubEnv('SPIDER_HERDR_SSH_DESCRIPTOR', inherited.SPIDER_HERDR_SSH_DESCRIPTOR!);
    f.config.enabled = false; await f.emit('session_start', { reason: 'resume' });
    const result = await new PolyglotExecutor({ projectRoot: f.ctx.cwd, ...f.mount.execution() }).execute({ language: 'shell', code: 'command -v ssh; printf "%s" "${SPIDER_HERDR_SSH_DESCRIPTOR-unset}"', timeout: 10000 });
    expect(result.exitCode).toBe(0); expect(result.stdout.split('\n')[0]).not.toBe(join(f.shimDirectory!, 'ssh'));
    expect(result.stdout.split('\n')[1]).toBe('unset');
    expect(f.mount.execution().environmentPolicy(inherited).PATH?.split(':')).not.toContain(f.shimDirectory);
    await f.emit('session_shutdown', { reason: 'quit' }); expect(f.errors).toEqual([]);
  } finally { await f.close(); }
}, 30000);

it.each(['0', '1'] as const)('inactive bash strips inherited shims only in parent mode, child=%s', async child => {
  const f = await mountedFixture(); const { createBashTool, createLocalBashOperations } = await import('@earendil-works/pi-coding-agent');
  const { registerHerdrRouting } = await import('../../../herdr/src/ssh/register.js'); const { disabledHerdrEnvironment } = await import('../herdr/ports.js');
  let tool: ReturnType<typeof createBashTool> | undefined;
  const registrationPi = { registerTool(value: ReturnType<typeof createBashTool>) { tool = value; }, on() { return () => {}; } };
  const inherited = f.mount.execution().environmentPolicy(process.env);
  vi.stubEnv('PATH', inherited.PATH!); vi.stubEnv('SPIDER_HERDR_SSH_DESCRIPTOR', inherited.SPIDER_HERDR_SSH_DESCRIPTOR!); vi.stubEnv('PI_SUBAGENT_CHILD', child);
  const routing = registerHerdrRouting(registrationPi as never, { enabled: () => false, currentOwner: () => null, environmentPolicy: disabledHerdrEnvironment,
    createBashTool, createLocalBashOperations, readShellFile: async () => '', policy: { checkShell: async () => ({ kind: 'allow' }), checkArgv: async () => ({ kind: 'allow' }) } });
  try {
    const registered = tool as unknown as import('@earendil-works/pi-coding-agent').ToolDefinition;
    const result = await registered.execute('environment', { command: 'command -v ssh; printf "%s" "${SPIDER_HERDR_SSH_DESCRIPTOR-unset}"' }, undefined, undefined, f.ctx as never);
    const text = result.content.filter(part => part.type === 'text').map(part => part.text).join('');
    if (child === '1') { expect(text.split('\n')[0]).toBe(join(f.shimDirectory!, 'ssh')); expect(text).toContain('cacheDescriptor'); }
    else { expect(text.split('\n')[0]).not.toBe(join(f.shimDirectory!, 'ssh')); expect(text.trim().endsWith('unset')).toBe(true); }
  } finally { await routing.dispose(); vi.stubEnv('PI_SUBAGENT_CHILD', '0'); await f.close(); }
}, 30000);

it('core loss disables routing and local shims once and reload recovers', async () => {
  const { crashFakeCore } = await import('../../../herdr/src/__tests__/fake-core-crash.js');
  const f = await mountedFixture(); const { isCoreAvailable } = await import('../../../herdr/src/client/liveness.js');
  const { PolyglotExecutor } = await import('../../../context/src/executor.js');
  const rows = await f.h.cli(['ls', '--all', '--json']) as { terminals: { address: string; pid?: number }[] };
  const ownerPid = rows.terminals.find(row => row.address === f.owner!.terminal.address)?.pid;
  try {
    expect(f.h.localSocket).toContain(f.h.root); expect(f.h.localSocket).not.toContain('/default/default.sock');
    const inherited = f.mount.execution().environmentPolicy(process.env);
    await crashFakeCore(f.h);
    await vi.waitFor(async () => expect(await isCoreAvailable(f.h.localEnv)).toBe(false));
    await vi.waitFor(() => expect(f.mount.enabled()).toBe(false), { timeout: 5000 });
    const calls = (await f.calls()).length;
    for (let attempt = 0; attempt < 2; attempt++) expect(await f.mount.guard({ toolName: 'spider', input: { action: 'exec', language: 'shell', code: 'ssh managed.invalid' } })).toBeUndefined();
    expect(await f.mount.guard({ toolName: 'spider', input: { action: 'exec', language: 'shell', on: 'remote.invalid', code: 'printf no' } })).toMatchObject({ block: true, reason: expect.stringContaining('Herdr is off in this session') });
    const environment = f.mount.execution().environmentPolicy(inherited);
    expect(environment.SPIDER_HERDR_SSH_DESCRIPTOR).toBeUndefined(); expect(environment.PATH?.split(':')).not.toContain(f.shimDirectory);
    expect(f.mount.execution().remote).toBeUndefined(); expect(f.notices).toHaveLength(1); expect(String(f.notices[0])).toContain('/reload');
    const { mkdir, writeFile, chmod } = await import('node:fs/promises');
    const bin = join(f.h.root, 'inactive-bin'); await mkdir(bin); await writeFile(join(bin, 'ssh'), '#!/bin/sh\nprintf "ordinary-ssh:%s\\n" "$*"\n'); await chmod(join(bin, 'ssh'), 0o700);
    vi.stubEnv('PATH', bin + ':' + process.env.PATH);
    const result = await new PolyglotExecutor({ projectRoot: f.ctx.cwd, ...f.mount.execution() }).execute({ language: 'shell', code: 'command -v ssh; ssh unmanaged.invalid', timeout: 10000 });
    expect(result.exitCode).toBe(0); expect(result.stdout).toBe(join(bin, 'ssh') + '\nordinary-ssh:unmanaged.invalid\n');
    expect((await f.calls()).length).toBe(calls);
    await f.h.cli(['server', 'start', '--json']);
    await f.emit('session_shutdown', { reason: 'reload' }); await f.emit('session_start', { reason: 'reload' });
    expect(f.mount.enabled()).toBe(true); expect(f.mount.owner()!.generation).not.toBe(f.owner!.generation);
    expect(f.mount.execution().environmentPolicy(process.env).SPIDER_HERDR_SSH_DESCRIPTOR).toBeDefined();
    expect(f.statusValues.get('spider-herdr')).toBeUndefined();
  } finally {
    if (!await isCoreAvailable(f.h.localEnv)) await f.h.cli(['server', 'start', '--json']);
    // The fake daemon cannot signal a payload from a previous daemon generation.
    if (ownerPid) { try { process.kill(-ownerPid, 'SIGTERM'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; } }
    await f.close();
  }
}, 30000);

it.each([true, false])('a real executor child resolves ssh with Herdr active=%s', async active => {
  const { delimiter } = await import('node:path');
  let inheritedShim: string | undefined;
  try { const descriptor = JSON.parse(process.env.SPIDER_HERDR_SSH_DESCRIPTOR ?? 'null'); if (typeof descriptor?.shimDirectory === 'string') inheritedShim = descriptor.shimDirectory; } catch { /* No usable inherited shim descriptor. */ }
  vi.stubEnv('PATH', (process.env.PATH ?? '').split(delimiter).filter(value => value !== inheritedShim).join(delimiter));
  vi.stubEnv('SPIDER_HERDR_SSH_DESCRIPTOR', '');
  const f = await mountedFixture('fake', 'tui', true, false, true, false, active);
  const { PolyglotExecutor } = await import('../../../context/src/executor.js'); const { join } = await import('node:path');
  try {
    const request = { language: 'shell' as const, code: 'command -v ssh; printf "%s\\n" "$PATH"', timeout: 10000 };
    const ordinary = await new PolyglotExecutor({ projectRoot: f.ctx.cwd }).execute(request);
    const result = await new PolyglotExecutor({ projectRoot: f.ctx.cwd, ...f.mount.execution() }).execute(request);
    expect(ordinary.exitCode).toBe(0); expect(result.exitCode).toBe(0); expect(result.stderr).toBe('');
    const shim = f.shimDirectory!;
    if (active) {
      expect(result.stdout.split('\n')[0]).toBe(join(shim, 'ssh'));
      expect(result.stdout.split('\n')[1].split(':')[0]).toBe(shim);
      expect(ordinary.stdout.split('\n')[0]).not.toBe(join(shim, 'ssh'));
    } else expect(result.stdout).toBe(ordinary.stdout);
    expect(f.errors).toEqual([]);
  } finally { await f.close(); }
}, 30000);

it.each(['new', 'resume', 'fork'] as const)('mounted consoles close the previous agent at %s but survive reload', async reason => {
  const f = await mountedFixture();
  try {
    const console = await f.h.hc.run({ argv: [f.h.nodeBinary, '-e', 'setInterval(()=>{},1000)'], cwd: null, on: 'remote.invalid' as never,
      labels: { 'spider.kind': 'remote-console', 'spider.session': f.h.owner!.sessionId, 'spider.machine': 'remote.invalid', 'spider.owner-core': f.owner!.terminal.coreId, 'spider.owner-terminal': f.owner!.terminal.terminalId }, noNotify: true, background: true, outliveParent: true });
    await f.emit('session_shutdown', { reason: 'reload' }); expect((await f.h.hc.get(console.address)).state).toBe('live');
    await f.emit('session_start', { reason: 'reload' }); expect((await f.h.hc.get(console.address)).state).toBe('live');
    await f.emit('session_shutdown', { reason });
    Reflect.set(f.ctx.sessionManager, 'getSessionId', () => 'replaced-' + reason);
    await f.emit('session_start', { reason });
    await expect(f.h.hc.get(console.address)).rejects.toMatchObject({ code: 'not_found' });
    expect(f.errors).toEqual([]);
  } finally { await f.close(); }
}, 30000);

it('startup reaps consoles of a crashed recorded process even when its terminal stays live', async () => {
  const f = await mountedFixture();
  try {
    const parent = await f.h.hc.run({ argv: [f.h.nodeBinary, '-e', 'setInterval(()=>{},1000)'], cwd: null, labels: { 'spider.kind': 'session' }, noNotify: true, background: true, outliveParent: true });
    const labels = { 'spider.kind': 'remote-console', 'spider.session': 'abandoned-session', 'spider.machine': 'remote.invalid', 'spider.owner-core': f.owner!.terminal.coreId, 'spider.owner-terminal': parent.address };
    const console = await f.h.hc.run({ argv: [f.h.nodeBinary, '-e', 'setInterval(()=>{},1000)'], cwd: null, on: 'remote.invalid' as never, labels, noNotify: true, background: true, outliveParent: true });
    const unrecorded = await f.h.hc.run({ argv: [f.h.nodeBinary, '-e', 'setInterval(()=>{},1000)'], cwd: null, on: 'remote.invalid' as never,
      labels: { ...labels, 'spider.session': 'unrecorded-live-session' }, noNotify: true, background: true, outliveParent: true });
    await f.presence.record({ pid: 2147483647, startIdentity: 'crashed-process', sessionId: 'abandoned-session' as never, sessionFile: null, sessionName: null, hcAddress: parent.address, kind: 'top-level' });
    await f.emit('session_shutdown', { reason: 'reload' }); await f.emit('session_start', { reason: 'reload' });
    expect((await f.h.hc.get(console.address)).state).toBe('live');
    await f.emit('session_start', { reason: 'startup' });
    await expect(f.h.hc.get(console.address)).rejects.toMatchObject({ code: 'not_found' });
    expect((await f.h.hc.get(parent.address)).state).toBe('live');
    expect((await f.h.hc.get(unrecorded.address)).state).toBe('live');
    expect(f.errors).toEqual([]);
  } finally { await f.close(); }
}, 30000);

it.each([false, true])('mounted console cleanup is quit-only and top-level-only, child=%s', async child => {
  const f = await mountedFixture('fake', 'tui', true, child);
  try {
    const handle = await f.h.hc.run({ argv: [f.h.nodeBinary, '-e', 'setInterval(()=>{},1000)'], cwd: null, on: 'remote.invalid' as never,
      labels: { 'spider.kind': 'remote-console', 'spider.session': f.h.owner!.sessionId, 'spider.machine': 'remote.invalid' }, noNotify: true, background: true, outliveParent: true });
    await f.emit('session_shutdown', { reason: 'reload' }); expect((await f.h.hc.get(handle.address)).state).toBe('live');
    await f.emit('session_start', { reason: 'reload' });
    await f.emit('session_shutdown', { reason: 'quit' });
    if (child) expect((await f.h.hc.get(handle.address)).state).toBe('live');
    else await expect(f.h.hc.get(handle.address)).rejects.toMatchObject({ code: 'not_found' });
  } finally { await f.close(); }
}, 30000);

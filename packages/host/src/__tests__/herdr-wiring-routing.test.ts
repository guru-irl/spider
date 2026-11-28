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

afterEach(() => { clearActions(); vi.unstubAllEnvs(); vi.resetModules(); });

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
    const { default: extension } = await import('../extension.js'); extension(withPiEvents(f.pi as never), hostUnitPorts);
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
    expect(await f.mount.guard({ toolName: 'spider', input: { action: 'exec', language: 'shell', on: 'remote.invalid', code: 'printf no' } })).toMatchObject({ block: true, reason: expect.stringContaining('Herdr stopped responding') });
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

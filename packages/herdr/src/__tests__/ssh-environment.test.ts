// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { describe, it, expect } from 'vitest';
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { rolldown } from 'rolldown';
import { createBashTool, createLocalBashOperations, type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { createHerdrHarness, type HerdrHarness } from './testutil.js';
import { createMachineCache, type MachineCache } from '../ssh/cache.js';
import { createSshPolicy } from '../ssh/policy.js';
import { installSshShim, createExecutionEnvironmentPolicy, finalChildEnvironment, type EnvironmentPolicyOptions } from '../ssh/shim.js';
import { registerHerdrRouting, guardHerdrToolCall, type RoutingPorts } from '../ssh/register.js';
import { buildChildSpawnSpec } from '../../../subagents/src/pi-args.js';
import { defaultSpawner } from '../../../subagents/src/spawn-default.js';
import { registerHooks } from '../../../host/src/hooks.js';

async function execute(binary: string, argv: string[], env: Readonly<NodeJS.ProcessEnv>) {
  return new Promise<{ exitCode: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(binary, argv, { env, stdio: ['ignore', 'pipe', 'pipe'] }); let stdout = '', stderr = '';
    child.stdout.on('data', b => { stdout += b; }); child.stderr.on('data', b => { stderr += b; }); child.on('error', reject);
    child.on('close', exitCode => resolve({ exitCode, stdout, stderr }));
  });
}
// This generator consumes its argument, never process.env.PATH. The real executor composition is L2's assertion.
function generatedShell(code: string, env: Readonly<NodeJS.ProcessEnv>): string { return `export PATH='${env.PATH!.replace(/'/g, "'\\''")}'\n${code}\n`; }
async function fixture(test: (h: HerdrHarness, options: EnvironmentPolicyOptions, ports: RoutingPorts) => Promise<void>) {
  const h = await createHerdrHarness('fake'); let cache: MachineCache | undefined;
  try {
    await h.start(); await h.scenario({ ssh: { stdout: 'ok\n', exitCode: 17 } });
    cache = createMachineCache({ hc: h.hc, identity: await h.hc.identity(), directory: join(h.root, 'cache') }); await cache.ready;
    const entry = join(h.root, 'entry.ts'), shimProgram = join(h.root, 'shim.mjs');
    await writeFile(entry, `import {runSshShim} from ${JSON.stringify(resolve('packages/herdr/src/ssh/shim.ts'))}; process.exitCode = await runSshShim(process.argv.slice(3));`);
    const bundle = await rolldown({ input: entry, platform: 'node' }); try { await bundle.write({ file: shimProgram, format: 'esm' }); } finally { await bundle.close(); }
    const options: EnvironmentPolicyOptions = { shimDirectory: join(h.root, 'shim'), realSshBinary: h.sshBinary, cacheDescriptor: cache.descriptor, shimProgram };
    await installSshShim(options);
    const ports: RoutingPorts = { policy: createSshPolicy(cache), environmentPolicy: createExecutionEnvironmentPolicy(options), currentOwner: () => h.owner,
      createBashTool, createLocalBashOperations, readShellFile: path => readFile(path, 'utf8'), enabled: () => true };
    await test(h, options, ports);
  } finally { await cache?.dispose(); await h.close(); expect(await h.remainingOwnedResources()).toEqual([]); }
}
async function sshConnections(h: HerdrHarness): Promise<string[][]> { return (await readFile(join(h.root, 'ssh-calls.jsonl'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(l => JSON.parse(l)); }
const context = (h: HerdrHarness) => ({ cwd: h.root, mode: 'tui' }) as ExtensionContext;
function piFixture() {
  const handlers = new Map<string, Function[]>(), tools: any[] = [];
  const pi = { on: (name: string, fn: Function) => { handlers.set(name, [...(handlers.get(name) ?? []), fn]); return () => { handlers.set(name, (handlers.get(name) ?? []).filter(f => f !== fn)); }; }, registerTool: (tool: any) => tools.push(tool) };
  return { pi: pi as unknown as ExtensionAPI, tools, async emit(name: string, event: any, ctx: ExtensionContext) { let result: any; for (const fn of handlers.get(name) ?? []) { result = await fn(event, ctx); if (result) break; } return result; } };
}
describe('immutable SSH execution environment', () => {
  it('a generated shell cannot restore the unshimmed PATH', async () => fixture(async (h, options, ports) => {
    const parentBefore = process.env.PATH;
    const env = ports.environmentPolicy({ ...h.localEnv, SPIDER_HERDR_SSH_BYPASS: '1', SPIDER_HERDR_LEASE_TOKEN: 'private', SPIDER_HERDR_JOB_CAPABILITY: 'private' });
    const script = join(h.root, 'program.sh'); await writeFile(script, generatedShell('ssh remote.invalid echo hidden', env));
    const result = await execute('/bin/bash', [script], env);
    expect(result.exitCode).not.toBe(0); expect(await sshConnections(h)).toEqual([]); expect(result.stderr).toContain('spider exec');
    expect(process.env.PATH).toBe(parentBefore); expect(Object.isFrozen(env)).toBe(true); expect(env.PATH?.split(':')[0]).toBe(options.shimDirectory);
    expect(env.SPIDER_HERDR_SSH_BYPASS).toBeUndefined(); expect(env.SPIDER_HERDR_LEASE_TOKEN).toBeUndefined(); expect(env.SPIDER_HERDR_JOB_CAPABILITY).toBeUndefined();
    expect(await execute('/bin/bash', ['-c', 'ssh elsewhere.invalid echo ok'], env)).toMatchObject({ exitCode: 17, stdout: 'ok\n' });
    expect(await sshConnections(h)).toEqual([['elsewhere.invalid', 'echo', 'ok']]);
  }));
  it('guards every shell batch entry before any entry can execute and reads exec_file at its destination', async () => fixture(async (h, _o, ports) => {
    expect(await guardHerdrToolCall({ toolName: 'spider', input: { action: 'batch', commands: [{ language: 'shell', code: 'echo first' }, { language: 'shell', code: '/usr/bin/ssh remote.invalid' }] } }, ports)).toMatchObject({ block: true, reason: expect.stringContaining('spider exec') });
    const path = join(h.root, 'job.sh'); await writeFile(path, 'ssh remote.invalid');
    expect(await guardHerdrToolCall({ toolName: 'spider', input: { action: 'exec_file', language: 'shell', path } }, ports)).toMatchObject({ block: true });
    expect(await guardHerdrToolCall({ toolName: 'bash', input: { command: 'ssh "unterminated' } }, ports)).toMatchObject({ block: true });
    expect(await sshConnections(h)).toEqual([]);
  }));
  it('replaces public bash with a spawnHook even when the bash opt-out permits execution', async () => fixture(async (h, _o, ports) => {
    execFileSync('git', ['init', '-q', h.root]); await mkdir(join(h.root, '.spider'));
    await writeFile(join(h.root, '.spider/config.json'), JSON.stringify({ 'exec.enforce': false }));
    const f = piFixture(); registerHooks(f.pi as never, event => guardHerdrToolCall(event, ports));
    const registered = registerHerdrRouting(f.pi, ports); await f.emit('session_start', { type: 'session_start' }, context(h));
    try {
      expect(await f.emit('tool_call', { toolName: 'bash', cwd: h.root, input: { command: 'printf harmless' } }, context(h))).toBeUndefined();
      expect(await f.emit('tool_call', { toolName: 'bash', cwd: h.root, input: { command: 'ssh remote.invalid' } }, context(h))).toMatchObject({ block: true });
      const tool = f.tools.find(t => t.name === 'bash'); expect(tool).toBeDefined();
      // A nested language program hides raw SSH from the parsed guard. The spawnHook PATH still covers it.
      const code = `${JSON.stringify(h.nodeBinary)} -e 'require("child_process").spawnSync("ssh",["remote.invalid"],{stdio:"inherit"})'`;
      const result = await tool.execute('id', { command: code }, undefined, undefined, context(h));
      expect(JSON.stringify(result.content)).toContain('spider exec'); expect(await sshConnections(h)).toEqual([]);
      const user = await f.emit('user_bash', { command: 'ssh elsewhere.invalid', cwd: h.root }, context(h));
      const output: Buffer[] = []; const resultUser = await user.operations.exec('ssh elsewhere.invalid', h.root, { env: h.localEnv, onData: (b: Buffer) => output.push(b) });
      expect(resultUser.exitCode).toBe(17); expect(Buffer.concat(output).toString()).toBe('ok\n');
      const refused = await f.emit('user_bash', { command: 'ssh remote.invalid', cwd: h.root }, context(h));
      expect(refused).toHaveProperty('result'); expect(await sshConnections(h)).toEqual([['elsewhere.invalid']]);
    } finally { await f.emit('session_shutdown', {}, context(h)); await registered.dispose(); }
  }));
  it('strips ordinary children after the final merge in RPC and print without any delegation capability', async () => fixture(async (h, _o, ports) => {
    for (const childMode of ['rpc', 'print'] as const) {
      const spec = buildChildSpawnSpec({ runId: `fixture-${childMode}`, sessionId: 'owner', agent: 'worker', childMode, task: 'test', context: 'fresh', parentSessionId: 'parent', childIndex: 0, dbPath: join(h.root, 'unused.db'), scratchRoot: h.root, childExtensionPath: join(h.root, 'extension.js'), cwd: h.root });
      const merged = finalChildEnvironment({ ...h.localEnv, SPIDER_HERDR_SSH_BYPASS: '1', SPIDER_SESSION_LEASE_TOKEN: 'token' }, { ...spec.env, SPIDER_HERDR_TRANSPORT_CAPABILITY: 'token' }, ports.environmentPolicy);
      expect(merged.SPIDER_HERDR_SSH_BYPASS).toBeUndefined(); expect(merged.SPIDER_SESSION_LEASE_TOKEN).toBeUndefined(); expect(merged.SPIDER_HERDR_TRANSPORT_CAPABILITY).toBeUndefined();
      const events: any[] = [];
      const handle = defaultSpawner({ ...spec, argv: [h.nodeBinary, '-e', 'console.log(JSON.stringify({type:"environment",env:process.env,argv:process.argv}))'], env: { ...merged, SPIDER_HERDR_SSH_BYPASS: '1' }, childMode: 'print', onRpcEvent: event => events.push(event) });
      expect((await handle.wait()).exitCode).toBe(0);
      const event = events.find(e => e.type === 'environment'); expect(event?.env.SPIDER_HERDR_SSH_BYPASS).toBeUndefined(); expect(event?.env.PATH).toBe(merged.PATH);
      expect(Object.keys(event.env).filter(k => /HERDR.*(?:JOB|DELEGAT)/.test(k))).toEqual([]);
    }
    const childEnv = { ...h.localEnv, PI_SUBAGENT_CHILD: '1' }; const previous = process.env.PI_SUBAGENT_CHILD;
    process.env.PI_SUBAGENT_CHILD = childEnv.PI_SUBAGENT_CHILD;
    try {
      expect(await guardHerdrToolCall({ toolName: 'spider', input: { action: 'exec', language: 'shell', code: 'echo ok', on: 'remote.invalid' } }, ports)).toBeUndefined();
      expect(await guardHerdrToolCall({ toolName: 'bash', input: { command: 'ssh remote.invalid' } }, ports)).toMatchObject({ block: true, reason: expect.stringContaining('on:remote.invalid') });
      expect(await guardHerdrToolCall({ toolName: 'bash', input: { command: 'ssh remote.invalid' } }, { ...ports, enabled: () => false })).toBeUndefined();
    }
    finally { if (previous === undefined) delete process.env.PI_SUBAGENT_CHILD; else process.env.PI_SUBAGENT_CHILD = previous; }
  }));
  it('leaves parent PATH untouched for parallel tools and strips bypass with integration disabled', async () => fixture(async (h, _o, ports) => {
    const before = process.env.PATH; const results = await Promise.all(Array.from({ length: 4 }, () => execute('/bin/bash', ['-c', 'ssh remote.invalid'], ports.environmentPolicy(h.localEnv))));
    expect(results.every(r => r.stderr.includes('spider exec'))).toBe(true); expect(process.env.PATH).toBe(before); expect(await sshConnections(h)).toEqual([]);
    const final = finalChildEnvironment({ PATH: 'original', SPIDER_HERDR_SSH_BYPASS: '1' }, {}); expect(final.PATH).toBe('original'); expect(final.SPIDER_HERDR_SSH_BYPASS).toBeUndefined();
    const f = piFixture(), registration = registerHerdrRouting(f.pi, { ...ports, enabled: () => false });
    try { expect(await f.emit('tool_call', { toolName: 'bash', input: { command: 'ssh remote.invalid' } }, context(h))).toBeUndefined(); } finally { await registration.dispose(); }
  }));
  it('normalizes Windows Path and PATHEXT before prepending and reports failed platform checks', async () => fixture(async (_h, options) => {
    const windows = createExecutionEnvironmentPolicy({ ...options, platform: 'win32', shimDirectory: 'C:\\policy\\bin', realSshBinary: 'C:\\Windows\\System32\\ssh.exe', shimProgram: 'C:\\policy\\cli.mjs', platformCheck: () => ({ ok: true }) });
    const env = windows({ Path: 'C:\\tools;C:\\Windows', PATHEXT: '.EXE;.BAT' }); expect(env.PATH).toBe('C:\\policy\\bin;C:\\tools;C:\\Windows'); expect(env.Path).toBeUndefined(); expect(env.PATHEXT?.split(';')[0]).toBe('.CMD');
    const failures: string[] = []; const disabled = createExecutionEnvironmentPolicy({ ...options, platform: 'win32', platformCheck: () => ({ ok: false, reason: 'transport check failed' }), reportDisabled: reason => failures.push(reason) });
    expect(disabled({ PATH: 'original' }).PATH).toBe('original'); expect(failures).toEqual(['transport check failed']);
  }));
});

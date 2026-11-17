// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { afterEach, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { build } from 'vite';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { Generation, Owner, SessionId, TerminalIdentity } from '../../../herdr/src/contracts.js';
import { parseHerdrConfig } from '../../../herdr/src/config.js';
import { createTerminalRegistry, withProcessLock } from '../../../herdr/src/sessions/registry.js';
import { offerResume, resumeOfferShell } from '../../../herdr/src/sessions/resume.js';
import { registerHerdrSessions } from '../../../herdr/src/sessions/register.js';
import { createProcessPresence } from '../../../herdr/src/sessions/presence.js';
import { createSessionLeases } from '../../../herdr/src/sessions/lease.js';
import { createProductionHerdrCliPorts } from '../herdr/ports.js';

const core = vi.hoisted(() => ({ terminal: null as TerminalIdentity | null }));
vi.mock('@spider/herdr/client/hc', async original => {
  const actual = await original<typeof import('@spider/herdr/client/hc')>();
  return { ...actual, createHcClient: () => ({ caller: async () => core.terminal, dispose: async () => {} }), invokeCli: async () => ({ pid: process.pid }) };
});
let root = '';
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); core.terminal = null; });

it.each(['/bin/bash', '/bin/zsh'])('a returning %s prompt ends pi, while a reboot without a prompt resumes', async binary => {
  root = await mkdtemp(join(await realpath(tmpdir()), 'auto-prompt-'));
  const state = join(root, 'herdr'), agent = join(root, 'agent'), bin = join(root, 'bin'); await mkdir(agent); await mkdir(bin);
  const file = join(root, 's1.jsonl'), calls = join(root, 'external-calls');
  await writeFile(file, JSON.stringify({ type: 'session', id: 's1', cwd: root }) + '\n');
  for (const command of ['mv', 'node', 'cat', 'stat', 'dirname', 'basename', 'date']) await writeFile(join(bin, command), `#!/bin/sh\nprintf '%s\\n' ${command} >> '${calls}'\n${command === 'mv' ? 'exec /bin/mv "$@"' : 'exit 89'}\n`, { mode: 0o700 });
  const terminal = { coreId: 'core', terminalId: 't1', address: 't1', socket: join(root, 'socket'), sessionNamespace: 'test' } as TerminalIdentity;
  core.terminal = terminal;
  const owner: Owner = { terminal, sessionId: 's1' as SessionId, generation: 'g1' as Generation, sessionFile: file, cwd: root, name: 'Saved' };
  const config = parseHerdrConfig({ app: { binary: '/app', home: root }, core: { binary: '/hc', config: join(root, 'core') }, agentDirectory: agent, globalRoot: root, shellRc: join(root, 'rc'), spaces: [], machines: [] });
  const ports = createProductionHerdrCliPorts(root, { ...process.env, SPIDER_GLOBAL_ROOT: root });
  const registry = createTerminalRegistry(state), presence = createProcessPresence(state), leases = createSessionLeases(state);
  const processInventory = { presence, leases, processes: async () => [], probe: async () => ({ kind: 'absent' as const }) };
  const hooks = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<unknown>>();
  const pi = { on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<unknown>) => { hooks.set(name, handler); return () => hooks.delete(name); } } as unknown as ExtensionAPI;
  const ctx = { mode: 'tui', sessionManager: { getSessionFile: () => file, getSessionId: () => 's1', getSessionName: () => 'Saved' } } as unknown as ExtensionContext;
  const registration = registerHerdrSessions(pi, { ...processInventory, registry, processIdentity: { pid: 12345, startIdentity: 'test' }, currentSession: () => ({ pid: 12345, startIdentity: 'test', sessionFile: file, sessionName: 'Saved', kind: 'top-level', hcAddress: terminal.address }), owner: () => owner, coreStartedAt: () => 1, launchEnvironment: { agentDirectory: agent, extensionArguments: [] } });
  const fire = (name: string, reason: string) => hooks.get(name)!({ type: name, reason }, ctx);
  const restart = { registry, processInventory, coreStartedAt: async () => Number.MAX_SAFE_INTEGER };
  const request = { config, configPath: join(root, 'config.json'), packageRoot: root, journalRoot: join(root, 'journal') };
  const rc = join(root, binary.endsWith('zsh') ? '.zshrc' : 'bashrc');
  await build({ configFile: false, logLevel: 'silent', resolve: { alias: { '@spider/db-core': fileURLToPath(new URL('../../../db-core/src/command-env.ts', import.meta.url)) } }, build: { ssr: fileURLToPath(new URL('../../../herdr/src/__tests__/fixtures/resume-shutdown-process.ts', import.meta.url)), outDir: root, emptyOutDir: false, rollupOptions: { output: { entryFileNames: 'background-pi.mjs' } } } });
  let child: ReturnType<typeof spawn> | undefined, backgroundPid: number | undefined;
  try {
    const source = await ports.resumeOffer!(request);
    await writeFile(rc, (binary.endsWith('bash') ? 'set +H\n' : '') + source + "\nkill() { return 1; }\nPS1=''\nprintf 'rc-ready\\n'\n");
    const env = { ...process.env, HOME: root, ZDOTDIR: root, PATH: bin, HC_TERMINAL_ID: 't1', HC_TERMINAL_SOCKET: terminal.socket };
    child = spawn(binary, binary.endsWith('zsh') ? ['-i'] : ['--noprofile', '--rcfile', rc, '-i'], { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', errors = '';
    child.stdout!.on('data', chunk => { output += chunk; }); child.stderr!.on('data', chunk => { errors += chunk; });
    const until = async (text: string) => { for (let i = 0; i < 200 && !output.includes(text); i++) await delay(10); expect(output, errors).toContain(text); };
    await until('rc-ready');
    child.stdin!.write("printf 'empty-one\\n'\nprintf 'empty-two\\n'\n"); await until('empty-two');
    await expect(readFile(calls, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    child.stdin!.write(`TEST_ROOT='${root}' TEST_STAY_LIVE=1 PATH=/usr/bin:/bin '${process.execPath}' '${join(root, 'background-pi.mjs')}' resume & _bgpid=$!; printf 'background-pid:%s\\n' "$_bgpid"\n`);
    await until('background-pid:');
    backgroundPid = Number(/background-pid:(\d+)/.exec(output)?.[1]); expect(backgroundPid).toBeGreaterThan(0);
    await until('background-pi-ready');
    child.stdin!.write("printf 'background-one\\n'\nprintf 'background-two\\n'\n"); await until('background-two');
    expect(await offerResume(terminal, restart), 'a still-running pi stays live at the prompt').not.toBeNull();
    const live = await registry.get(terminal); expect(live?.activityId).toBeTruthy();
    const markerDir = join(state, 'resume-starts', (await readdir(join(state, 'resume-starts')))[0]);
    const [liveMarker] = (await readdir(markerDir)).filter(name => name.startsWith('live-'));
    expect(liveMarker).toContain(live!.activityId!);
    expect(JSON.parse(await readFile(join(markerDir, liveMarker), 'utf8'))).toMatchObject({ version: 1, pid: backgroundPid, startIdentity: expect.any(String) });
    expect((await stat(join(markerDir, liveMarker))).mode & 0o777).toBe(0o600);
    child.stdin!.write("builtin kill -TERM \"$_bgpid\"; wait \"$_bgpid\" 2>/dev/null; printf 'background-stopped\\n'\nprintf 'background-next\\n'\n"); await until('background-next'); backgroundPid = undefined;
    expect(await offerResume(terminal, restart), 'a stopped background pi ends on the next prompt').toBeNull();
    await fire('session_start', 'startup');
    await fire('session_shutdown', 'quit');
    expect(await offerResume(terminal, restart), 'before the shell prompt returns').not.toBeNull();
    child.stdin!.write("printf 'returned\\n'\nprintf 'next-prompt\\n'\n"); await until('next-prompt');
    expect(await offerResume(terminal, restart), 'offer after quit and prompt').toBeNull();
    expect(await offerResume(terminal, { ...restart, autoResumeRoot: state }), 'auto after quit and prompt').toBeNull();
    await fire('session_start', 'startup');
    await fire('session_shutdown', 'reload');
    expect(await offerResume(terminal, restart), 'reboot without another prompt').not.toBeNull();
    expect(await offerResume(terminal, { ...restart, autoResumeRoot: state }), 'auto after reboot without a prompt').not.toBeNull();
  } finally {
    if (backgroundPid) { try { process.kill(backgroundPid, 'SIGKILL'); } catch { /* Already gone. */ } }
    child?.stdin?.end('exit\n');
    if (child && child.exitCode === null && child.signalCode === null) { const exited = new Promise<void>(resolveExit => child!.once('exit', () => resolveExit())); child.kill('SIGKILL'); await exited; }
    await registration.dispose(); await ports.dispose();
  }
}, 15000);

it.each(['/bin/bash', '/bin/zsh'])('an auto-resumed pi is marked ended before the first %s prompt returns', async binary => {
  root = await mkdtemp(join(await realpath(tmpdir()), 'auto-first-'));
  const state = join(root, 'herdr'), agent = join(root, 'agent'); await mkdir(agent);
  const file = join(root, 's1.jsonl'); await writeFile(file, JSON.stringify({ type: 'session', id: 's1', cwd: root }) + '\n');
  const terminal = { coreId: 'core', terminalId: 't1', address: 't1', socket: join(root, 'socket'), sessionNamespace: 'test' } as TerminalIdentity;
  core.terminal = terminal;
  const owner: Owner = { terminal, sessionId: 's1' as SessionId, generation: 'g1' as Generation, sessionFile: file, cwd: root, name: 'Saved' };
  const registry = createTerminalRegistry(state), processInventory = { presence: createProcessPresence(state), leases: createSessionLeases(state), processes: async () => [], probe: async () => ({ kind: 'absent' as const }) };
  await registry.record({ owner, recordedAt: 1, coreStartedAt: 1, environment: { agentDirectory: agent, extensionArguments: [] }, activityId: '0123456789abcdef0123456789abcdef' }, { pid: 12345, startIdentity: 'old' });
  await build({ configFile: false, logLevel: 'silent', resolve: { alias: { '@spider/db-core': fileURLToPath(new URL('../../../db-core/src/command-env.ts', import.meta.url)) } }, build: { ssr: fileURLToPath(new URL('../../../herdr/src/__tests__/fixtures/resume-shutdown-process.ts', import.meta.url)), outDir: join(root, 'dist/herdr'), emptyOutDir: false, rollupOptions: { output: { entryFileNames: 'cli.mjs' } } } });
  const config = parseHerdrConfig({ app: { binary: '/app', home: root }, core: { binary: '/hc', config: join(root, 'core') }, agentDirectory: agent, globalRoot: root, shellRc: join(root, 'rc'), spaces: [], machines: [], resume: 'auto' });
  const ports = createProductionHerdrCliPorts(root, { ...process.env, SPIDER_GLOBAL_ROOT: root });
  const rc = join(root, binary.endsWith('zsh') ? '.zshrc' : 'bashrc');
  let child: ReturnType<typeof spawn> | undefined;
  try {
    const source = await ports.resumeOffer!({ config, configPath: join(root, 'config.json'), packageRoot: root, journalRoot: join(root, 'journal') });
    await writeFile(rc, source + "\nPS1=''\n");
    child = spawn(binary, binary.endsWith('zsh') ? ['-i'] : ['--noprofile', '--rcfile', rc, '-i'], { cwd: root, env: { ...process.env, HOME: root, ZDOTDIR: root, TEST_ROOT: root, SPIDER_GLOBAL_ROOT: root }, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', errors = '';
    child.stdout!.on('data', chunk => { output += chunk; }); child.stderr!.on('data', chunk => { errors += chunk; });
    child.stdin!.write("printf 'command-started\\n'; read _hold\n");
    for (let i = 0; i < 1000 && !output.includes('command-started'); i++) await delay(10);
    expect(output, errors).toContain('Resuming Saved…'); expect(output, errors).toContain('command-started');
    expect(await offerResume(terminal, { registry, processInventory, coreStartedAt: async () => Number.MAX_SAFE_INTEGER })).toBeNull();
  } finally {
    child?.stdin?.end('continue\nexit\n');
    if (child && child.exitCode === null && child.signalCode === null) { const exited = new Promise<void>(resolveExit => child!.once('exit', () => resolveExit())); child.kill('SIGKILL'); await exited; }
    await ports.dispose();
  }
}, 20000);

it('the configured auto policy produces one automatic snippet per proved restart', async () => {
  root = await mkdtemp(join(await realpath(tmpdir()), 'auto-host-'));
  const terminal = { coreId: 'core', terminalId: 't1', address: 't1', socket: join(root, 'socket'), sessionNamespace: 'test' } as TerminalIdentity;
  core.terminal = terminal;
  const file = join(root, 'session.jsonl');
  await writeFile(file, JSON.stringify({ type: 'session', id: 's1', cwd: root }) + '\n');
  const owner: Owner = { terminal, sessionId: 's1' as SessionId, generation: 'g1' as Generation, sessionFile: file, cwd: root, name: 'Saved' };
  await createTerminalRegistry(join(root, 'herdr')).record({ owner, recordedAt: 1, coreStartedAt: 1, environment: { agentDirectory: join(root, 'agent'), extensionArguments: [] } });
  const config = parseHerdrConfig({ app: { binary: '/app', home: root }, core: { binary: '/hc', config: join(root, 'core') }, agentDirectory: join(root, 'agent'), globalRoot: root, shellRc: join(root, 'rc'), spaces: [], machines: [], resume: 'auto' });
  const ports = createProductionHerdrCliPorts(root, { ...process.env, SPIDER_GLOBAL_ROOT: root });
  try {
    const request = { config, configPath: join(root, 'config.json'), packageRoot: root, journalRoot: join(root, 'journal') };
    const offerRequest = { ...request, config: { ...config, resume: 'offer' as const } };
    expect(await ports.resumeOffer!(offerRequest)).toContain('run spider_resume');
    expect(await ports.resumeOffer!(offerRequest)).toContain('run spider_resume');
    const first = await ports.resumeOffer!(request);
    expect(first).toContain('Resuming Saved…');
    expect(first).not.toContain('run spider_resume');
    expect(await ports.resumeOffer!(request)).not.toContain('Resuming Saved…');
  } finally { await ports.dispose(); }
});

it('reports a busy resume launch rather than an internal lock timeout', async () => {
  root = await mkdtemp(join(await realpath(tmpdir()), 'auto-busy-'));
  const file = join(root, 'session.jsonl'), agent = join(root, 'agent'); await mkdir(agent);
  await writeFile(file, JSON.stringify({ type: 'session', id: 's1', cwd: root }) + '\n');
  const config = parseHerdrConfig({ app: { binary: '/app', home: root }, core: { binary: '/hc', config: join(root, 'core') }, agentDirectory: agent, globalRoot: root, shellRc: join(root, 'rc'), spaces: [], machines: [] });
  const ports = createProductionHerdrCliPorts(root, { ...process.env, SPIDER_GLOBAL_ROOT: root });
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const holding = withProcessLock(join(root, 'herdr'), `resume-launch:${file}`, async () => { entered(); await gate; });
  await ready;
  try {
    const request = { config, configPath: join(root, 'config.json'), packageRoot: root, journalRoot: join(root, 'journal') };
    await expect(ports.resume!(request, { file, sessionId: 's1', cwd: root })).rejects.toMatchObject({ code: 'resume-launch-busy', message: expect.stringContaining('resume') });
  } finally { release(); await holding; await ports.dispose(); }
}, 15000);

it.each([['exit 130', true], ['kill -TERM $$', true], ['exit 9', false]] as const)('reports resumed pi exit %s appropriately', async (exit, normal) => {
  root = await mkdtemp(join(await realpath(tmpdir()), 'auto-exit-'));
  const bin = join(root, 'bin'), agent = join(root, 'agent'); await mkdir(bin); await mkdir(agent);
  const file = join(root, 'session.jsonl');
  await writeFile(file, JSON.stringify({ type: 'session', id: 's1', cwd: root }) + '\n');
  await writeFile(join(bin, 'pi'), `#!/bin/sh\nsleep 0.3\n${exit}\n`, { mode: 0o700 });
  const config = parseHerdrConfig({ app: { binary: '/app', home: root }, core: { binary: '/hc', config: join(root, 'core') }, agentDirectory: agent, globalRoot: root, shellRc: join(root, 'rc'), spaces: [], machines: [] });
  const ports = createProductionHerdrCliPorts(root, { ...process.env, PATH: `${bin}:/usr/bin:/bin`, SPIDER_GLOBAL_ROOT: root });
  try {
    const request = { config, configPath: join(root, 'config.json'), packageRoot: root, journalRoot: join(root, 'journal') };
    const launch = ports.resume!(request, { file, sessionId: 's1', cwd: root });
    if (normal) await expect(launch).resolves.toBeUndefined();
    else await expect(launch).rejects.toMatchObject({ code: 'resume-exited', message: expect.stringContaining('9') });
  } finally { await ports.dispose(); }
});

it.each([true, false])('two restored shells racing for one session launch only one pi with enabled=%s', async enabled => {
  root = await mkdtemp(join(await realpath(tmpdir()), 'auto-race-'));
  await symlink(resolve('node_modules'), join(root, 'node_modules'), 'dir');
  const bin = join(root, 'bin'), agent = join(root, 'agent'); await mkdir(bin); await mkdir(agent);
  const file = join(root, 'session.jsonl'), configPath = join(root, 'config.json'), receipt = join(root, 'launches');
  await writeFile(file, JSON.stringify({ type: 'session', id: 's1', cwd: root }) + '\n');
  await writeFile(configPath, JSON.stringify({ enabled, app: { binary: '/app', home: root }, core: { binary: '/hc', config: join(root, 'core') }, agentDirectory: agent, globalRoot: root, shellRc: join(root, 'rc'), spaces: [], machines: [] }));
  const fakePi = join(root, 'fake-pi.mjs');
  await writeFile(fakePi, `import {appendFileSync} from 'node:fs'; appendFileSync(${JSON.stringify(receipt)}, JSON.stringify({argv:process.argv.slice(2), cwd:process.cwd(), agent:process.env.PI_CODING_AGENT_DIR})+'\\n'); setTimeout(() => {}, 4000);`);
  await writeFile(join(bin, 'pi'), `#!/bin/sh\nexec '${process.execPath}' '${fakePi}' "$@"\n`, { mode: 0o700 });
  await build({ configFile: false, logLevel: 'silent', define: { 'import.meta.spiderHerdrRuntimeEntry': 'false', 'import.meta.spiderPaneEndpointEntry': 'false' }, ssr: { noExternal: [/^@spider\//] }, build: { ssr: fileURLToPath(new URL('./fixtures/auto-resume-runner.ts', import.meta.url)), outDir: root, emptyOutDir: false, rollupOptions: { output: { entryFileNames: 'runner.mjs' } } } });
  const terminal = { coreId: 'core', terminalId: 't1', address: 't1', socket: join(root, 'socket'), sessionNamespace: 'test' } as TerminalIdentity;
  const offer = { terminal, sessionFile: file, sessionId: 's1' as SessionId, cwd: root, name: 'Saved', argv: ['pi', '--session', file], environment: { agentDirectory: agent, extensionArguments: [] } };
  const source = resumeOfferShell(offer, { nodePath: process.execPath, cliPath: join(root, 'runner.mjs'), configPath, hookPath: join(root, 'unused') }, 'auto');
  const env = { ...process.env, HOME: root, SPIDER_GLOBAL_ROOT: root, PI_CODING_AGENT_DIR: agent, PATH: `${bin}:/usr/bin:/bin` };
  const shells = [1, 2].map(() => {
    const child = spawn('/bin/bash', ['--noprofile', '--norc', '-i', '-c', source + '\neval "$PROMPT_COMMAND"\nprintf "shell returned\\n"'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = ''; child.stdout.on('data', chunk => out += chunk); child.stderr.on('data', chunk => err += chunk);
    const result = new Promise<{ out: string; err: string; code: number | null }>((resolveRun, reject) => { child.on('error', reject); child.on('close', code => resolveRun({ out, err, code })); });
    return { child, result };
  });
  try {
    let ready = false;
    for (let i = 0; i < 1000; i++) { if ((await readdir(root)).filter(name => name.startsWith('ready-')).length === 2) { ready = true; break; } await delay(10); }
    expect(ready).toBe(true);
    await writeFile(join(root, 'go'), '');
    const results = await Promise.all(shells.map(shell => shell.result));
    expect(results.map(result => result.out)).toEqual([expect.stringContaining('shell returned'), expect.stringContaining('shell returned')]);
    expect(results.filter(result => result.err.includes('Session is held by PID'))).toHaveLength(1);
    const launches = (await readFile(receipt, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(launches).toEqual([{ argv: ['--session', file], cwd: root, agent }]);
  } finally { for (const shell of shells) if (shell.child.exitCode === null) shell.child.kill(); }
}, 30000);

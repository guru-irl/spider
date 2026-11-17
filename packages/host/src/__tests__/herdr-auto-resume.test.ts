// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { afterEach, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { build } from 'vite';
import type { Generation, Owner, SessionId, TerminalIdentity } from '../../../herdr/src/contracts.js';
import { parseHerdrConfig } from '../../../herdr/src/config.js';
import { createTerminalRegistry } from '../../../herdr/src/sessions/registry.js';
import { resumeOfferShell } from '../../../herdr/src/sessions/resume.js';
import { createProductionHerdrCliPorts } from '../herdr/ports.js';

const core = vi.hoisted(() => ({ terminal: null as TerminalIdentity | null }));
vi.mock('@spider/herdr/client/hc', async original => {
  const actual = await original<typeof import('@spider/herdr/client/hc')>();
  return { ...actual, createHcClient: () => ({ caller: async () => core.terminal, dispose: async () => {} }), invokeCli: async () => ({ pid: process.pid }) };
});
let root = '';
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); core.terminal = null; });

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
    expect(await ports.resumeOffer!(request)).toBe('');
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
    const child = spawn('/bin/bash', ['--noprofile', '--norc', '-i', '-c', source + '\nprintf "shell returned\\n"'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
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
